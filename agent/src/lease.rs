//! LEASE (docs/devices.md "The network after a restore"): the page restored the machine (a snapshot, a suspended copy)
//! and its connections are up, so the guest is to ask for a lease for the network it is on now rather than keep the
//! snapshot's until its renewal. The guest's own network manager is told, through its own tool, where both are there
//! (the agent runs a guest program only where it exists):
//! - **systemd-networkd** (running: `/run/systemd/netif/links`; `busctl`, systemd's): its D-Bus method
//!   `org.freedesktop.network1.Manager.RenewLink` for each link by its index, what `networkctl renew` calls (networkctl
//!   itself resolves the link over netlink, which the unit's sandbox refuses). A renewal
//!   keeps the address where the gateway's lease is the same (open connections live on), and the gateway's NAK of an
//!   address it doesn't hold sends the client to ask afresh at once.
//! - **NetworkManager** (running: `/run/NetworkManager`; `nmcli`): `nmcli device connect <link>` for each.
//!
//! The links are the network cards (`/sys/class/net/<name>` with a `device`: not `lo`, bridges, tunnels). The tool
//! runs in a forked child whose end the root process's loop hears on its pidfd; LEASED answers (`status`).

use crate::prelude::*;
use rustix::fd::OwnedFd;
use rustix::io::Errno;
use rustix::process::{Pid, PidfdFlags, Signal, WaitOptions, pidfd_open, waitpid};

/// LEASED's statuses.
pub mod status {
    /// The network manager was told.
    pub const RENEWED: u8 = 0;
    /// None the agent knows runs, or its tool isn't there (the page flaps the link instead).
    pub const NO_CLIENT: u8 = 1;
    /// Its tool failed.
    pub const FAILED: u8 = 2;
}

/// Where the network managers and the cards are (the tests' are directories of their own).
#[derive(Clone)]
pub struct Paths {
    pub networkd: String,
    pub busctl: Vec<String>,
    pub nm: String,
    pub nmcli: Vec<String>,
    pub net: String,
}

impl Default for Paths {
    fn default() -> Paths {
        let bins = |n: &str| {
            ["/usr/bin", "/bin", "/usr/sbin", "/sbin"]
                .map(|d| format!("{d}/{n}"))
                .to_vec()
        };
        Paths {
            networkd: "/run/systemd/netif/links".into(),
            busctl: bins("busctl"),
            nm: "/run/NetworkManager".into(),
            nmcli: bins("nmcli"),
            net: "/sys/class/net".into(),
        }
    }
}

/// The tool's run: its child and the pidfd its end is heard on.
pub struct Job {
    pub pid: Pid,
    pub pidfd: OwnedFd,
}

/// The network cards: `/sys/class/net`'s links with a device, sorted.
pub fn cards(net: &str) -> Vec<String> {
    let Ok(mut names) = crate::rt::dir_names(net) else {
        return Vec::new();
    };
    crate::rt::sort(&mut names);
    names
        .into_iter()
        .filter(|n| n != "lo" && rustix::fs::stat(format!("{net}/{n}/device").as_str()).is_ok())
        .collect()
}

fn found(list: &[String]) -> Option<&String> {
    list.iter()
        .find(|p| rustix::fs::access(p.as_str(), rustix::fs::Access::EXEC_OK).is_ok())
}

/// The commands that renew the cards' leases with the network manager that runs here; None if none the agent knows.
pub fn commands(p: &Paths) -> Option<Vec<Vec<String>>> {
    let cards = cards(&p.net);
    if cards.is_empty() {
        return None;
    }
    if rustix::fs::stat(p.networkd.as_str()).is_ok()
        && let Some(tool) = found(&p.busctl)
    {
        // networkd's own method, by the link's index (`/sys/class/net/<name>/ifindex`): networkctl resolves a link over
        // netlink, even an index, which the unit's RestrictAddressFamilies refuses ("Address family not supported by
        // protocol", seen on Debian 13); busctl only speaks D-Bus.
        return Some(
            cards
                .iter()
                .filter_map(|n| {
                    let idx = crate::rt::read_text(format!("{}/{n}/ifindex", p.net)).ok()?;
                    let idx = idx.trim();
                    (!idx.is_empty() && idx.bytes().all(|b| b.is_ascii_digit())).then(|| {
                        [
                            tool.as_str(),
                            "call",
                            "org.freedesktop.network1",
                            "/org/freedesktop/network1",
                            "org.freedesktop.network1.Manager",
                            "RenewLink",
                            "i",
                            idx,
                        ]
                        .map(String::from)
                        .to_vec()
                    })
                })
                .collect(),
        );
    }
    if rustix::fs::stat(p.nm.as_str()).is_ok()
        && let Some(tool) = found(&p.nmcli)
    {
        return Some(
            cards
                .into_iter()
                .map(|c| vec![tool.clone(), "device".into(), "connect".into(), c])
                .collect(),
        );
    }
    None
}

unsafe extern "C" {
    /// The C library's (musl's): a raw clone would leave its idea of the thread's id stale.
    fn fork() -> i32;
    fn execv(path: *const core::ffi::c_char, argv: *const *const core::ffi::c_char) -> i32;
}

fn cstr(s: &str) -> Vec<u8> {
    let mut v = s.as_bytes().to_vec();
    v.push(0);
    v
}

/// Runs `cmds` one after the other in a forked child (each in a child of its own), which exits with 0 if all did.
pub fn spawn(cmds: &[Vec<String>]) -> Result<Job, Errno> {
    // Everything the child needs, made before the fork.
    let argvs: Vec<Vec<Vec<u8>>> = cmds
        .iter()
        .map(|c| c.iter().map(|a| cstr(a)).collect())
        .collect();
    // SAFETY: the agent is one thread, so the child has the whole process's state in order; it never returns to the
    // parent's frames (it exits).
    let pid = unsafe { fork() };
    if pid < 0 {
        return Err(Errno::AGAIN);
    }
    if pid == 0 {
        let _ = rustix::process::set_parent_process_death_signal(Some(Signal::KILL));
        let ok = argvs.iter().all(|a| run(a));
        crate::rt::exit(if ok { 0 } else { 1 });
    }
    let pid = Pid::from_raw(pid).ok_or(Errno::INVAL)?;
    let pidfd = pidfd_open(pid, PidfdFlags::empty()).inspect_err(|_| {
        let _ = waitpid(Some(pid), WaitOptions::empty());
    })?;
    Ok(Job { pid, pidfd })
}

/// One command (its argv, NUL-terminated strings, the first the program's path) in a child; whether it exited with 0.
fn run(argv: &[Vec<u8>]) -> bool {
    let mut ptrs: Vec<*const core::ffi::c_char> = argv.iter().map(|a| a.as_ptr().cast()).collect();
    ptrs.push(core::ptr::null());
    // SAFETY: as in `spawn`: one thread.
    let pid = unsafe { fork() };
    if pid < 0 {
        return false;
    }
    if pid == 0 {
        // SAFETY: NUL-terminated strings, and a null-terminated array of them, that outlive the call.
        unsafe { execv(ptrs[0], ptrs.as_ptr()) };
        crate::rt::exit(127);
    }
    reaped(Pid::from_raw(pid))
}

fn reaped(pid: Option<Pid>) -> bool {
    let Some(pid) = pid else { return false };
    loop {
        match waitpid(Some(pid), WaitOptions::empty()) {
            Ok(Some((_, st))) => return st.exit_status() == Some(0),
            Err(Errno::INTR) => {}
            _ => return false,
        }
    }
}

/// The tool's child ended (its pidfd readable): reaped; LEASED's status.
pub fn done(j: Job) -> u8 {
    if reaped(Some(j.pid)) {
        crate::log("lease: the network manager told to renew", None);
        status::RENEWED
    } else {
        crate::log("lease: the network manager's tool failed", None);
        status::FAILED
    }
}
