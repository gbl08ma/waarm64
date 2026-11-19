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
//! - Else, card by card, the DHCP clients that run without a manager (Alpine's, through ifupdown: decision 14 of
//!   DEMO-KICKOFF.md), found among the processes (`/proc/<pid>/cmdline`):
//!   - **udhcpc** (busybox's) for the card (its `-i`, else `eth0`, its default): SIGUSR1, busybox's "renew": a request
//!     for its lease to the server it had, a NAK (or no answer, after three) and it asks afresh. The same for a
//!     **udhcpc6** of the card (IPv6's: the one the agent starts on a card nothing else manages, src/card.rs).
//!   - **dhcpcd** where it manages the card (`dhcpcd_manages`: a dhcpcd of the card's own, `dhcpcd <link>`, its title
//!     naming it; or the manager, `[manager]`/`[master]`, for every card its configuration doesn't leave out by
//!     `denyinterfaces`/`allowinterfaces`): `dhcpcd -n <link>`, its rebind (the configuration read again and the lease
//!     asked for as at a reboot, an INIT-REBOOT's request, else a discover): unlike `-N` (renew) it also leaves an
//!     IPv4LL fallback, a template's made with no network. Never for a card no dhcpcd runs for (`-n` would start one
//!     there: a statically configured card would get a lease and a route its user didn't ask for).
//!
//! The links are the network cards (`/sys/class/net/<name>` with a `device`: not `lo`, bridges, tunnels). The tool
//! runs (and the signal is sent) in a forked child whose end the root process's loop hears on its pidfd; LEASED
//! answers (`status`).

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
    pub dhcpcd: Vec<String>,
    /// dhcpcd's configuration (its `denyinterfaces`, `allowinterfaces`).
    pub dhcpcd_conf: String,
    pub net: String,
    /// Where the processes are (udhcpc's and dhcpcd's are found there).
    pub proc: String,
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
            dhcpcd: bins("dhcpcd"),
            dhcpcd_conf: "/etc/dhcpcd.conf".into(),
            net: "/sys/class/net".into(),
            proc: "/proc".into(),
        }
    }
}

/// The tool's run: its child and the pidfd its end is heard on.
pub struct Job {
    pub pid: Pid,
    pub pidfd: OwnedFd,
}

/// The network cards: `/sys/class/net`'s links with a device, sorted; of those, the ones whose MAC is in `macs` (none
/// given: all of them).
pub fn cards(net: &str, macs: &[[u8; 6]]) -> Vec<String> {
    let Ok(mut names) = crate::rt::dir_names(net) else {
        return Vec::new();
    };
    crate::rt::sort(&mut names);
    names
        .into_iter()
        .filter(|n| n != "lo" && rustix::fs::stat(format!("{net}/{n}/device").as_str()).is_ok())
        .filter(|n| {
            macs.is_empty()
                || crate::rt::read_text(format!("{net}/{n}/address"))
                    .ok()
                    .and_then(|a| parse_mac(a.trim()))
                    .is_some_and(|m| macs.contains(&m))
        })
        .collect()
}

/// A MAC as sysfs writes it (`52:54:00:12:34:56`).
fn parse_mac(s: &str) -> Option<[u8; 6]> {
    let mut out = [0u8; 6];
    let mut parts = s.split(':');
    for b in &mut out {
        *b = u8::from_str_radix(parts.next()?, 16).ok()?;
    }
    parts.next().is_none().then_some(out)
}

/// LEASE's payload: a u8 count, then that many MACs (6 bytes each), the cards the page has connected; empty (a page
/// before it said them): every card. None: not one.
pub fn decode(p: &[u8]) -> Option<Vec<[u8; 6]>> {
    let Some((&n, rest)) = p.split_first() else {
        return Some(Vec::new());
    };
    let rest = rest.get(..6 * n as usize)?;
    Some(rest.as_chunks::<6>().0.to_vec())
}

pub fn found(list: &[String]) -> Option<&String> {
    list.iter()
        .find(|p| rustix::fs::access(p.as_str(), rustix::fs::Access::EXEC_OK).is_ok())
}

/// One thing the child does: a program run (its argv, the first its path), or a signal sent.
#[derive(Debug, PartialEq, Eq)]
pub enum Step {
    Run(Vec<String>),
    Signal(Pid, Signal),
    /// Bytes written to a file that exists (a sysctl's, under `/proc/sys`).
    Write(String, Vec<u8>),
}

/// A process's argv (`/proc/<pid>/cmdline`: NUL-separated), its program's name first (the path's last part); a
/// busybox applet run as `busybox <applet>` is named by its applet.
fn argv_of(proc: &str, pid: &str) -> Option<Vec<String>> {
    let raw = crate::rt::read_file(format!("{proc}/{pid}/cmdline")).ok()?;
    let mut args: Vec<String> = raw
        .split(|&b| b == 0)
        .map(|a| String::from_utf8_lossy(a).into_owned())
        .collect();
    if raw.last() == Some(&0) {
        args.pop();
    }
    let name = |a: &str| a.rsplit('/').next().unwrap_or("").to_owned();
    let first = name(args.first()?);
    if first == "busybox" && args.len() > 1 {
        args.remove(0);
    }
    args[0] = name(&args[0]);
    Some(args)
}

/// The processes: each one's pid, its name (`comm`: the program's, which a rewritten argv keeps) and argv (`argv_of`).
pub fn processes(proc: &str) -> Vec<(Pid, String, Vec<String>)> {
    let Ok(pids) = crate::rt::dir_names(proc) else {
        return Vec::new();
    };
    pids.iter()
        .filter(|p| !p.is_empty() && p.bytes().all(|c| c.is_ascii_digit()))
        .filter_map(|p| {
            let comm = crate::rt::read_text(format!("{proc}/{p}/comm")).unwrap_or_default();
            Some((
                Pid::from_raw(p.parse().ok()?)?,
                comm.trim_end().to_owned(),
                argv_of(proc, p)?,
            ))
        })
        .collect()
}

/// The options of busybox's udhcpc that take a value (its getopt string), the interface's (`i`) among them (udhcpc6's
/// are a subset).
const UDHCPC_VALUED: &[u8] = b"VHhFipsrTtAOxB";

/// Whether argv `a` (`argv_of`'s) is a busybox DHCP client (udhcpc, or udhcpc6 for IPv6) of `card`.
pub fn udhcpc_of(a: &[String], card: &str) -> bool {
    (a[0] == "udhcpc" || a[0] == "udhcpc6") && udhcpc_interface(&a[1..]) == card
}

/// The interface a udhcpc's (or udhcpc6's) arguments (past its name) give it: `-i <if>`, `-i<if>` (also at a cluster's
/// end, `-bRi <if>`), `--interface <if>`, `--interface=<if>`; else busybox's default, `eth0`.
pub fn udhcpc_interface(args: &[String]) -> String {
    let mut it = args.iter();
    while let Some(a) = it.next() {
        if a == "--" {
            break;
        }
        if let Some(long) = a.strip_prefix("--") {
            match long.split_once('=') {
                Some(("interface", v)) => return v.to_owned(),
                None if long == "interface" => return it.next().cloned().unwrap_or_default(),
                _ => {}
            }
            continue;
        }
        let Some(cluster) = a.strip_prefix('-') else {
            continue;
        };
        for (k, c) in cluster.bytes().enumerate() {
            if !UDHCPC_VALUED.contains(&c) {
                continue;
            }
            let rest = &cluster[k + 1..];
            let value = if rest.is_empty() {
                it.next().cloned().unwrap_or_default()
            } else {
                rest.to_owned()
            };
            if c == b'i' {
                return value;
            }
            break;
        }
    }
    "eth0".into()
}

/// What renews the cards' leases with the network manager that runs here; None if none the agent knows.
pub fn commands(p: &Paths, macs: &[[u8; 6]]) -> Option<Vec<Step>> {
    let cards = cards(&p.net, macs);
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
                        Step::Run(
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
                            .to_vec(),
                        )
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
                .map(|c| Step::Run(vec![tool.clone(), "device".into(), "connect".into(), c]))
                .collect(),
        );
    }
    // The clients without a manager, card by card: the card's udhcpc, else dhcpcd's rebind where dhcpcd manages the
    // card (found by its name: dhcpcd rewrites its argv, "dhcpcd: [manager] [ip4] [ip6]", "dhcpcd: eth0 [ip4]").
    let procs = processes(&p.proc);
    let titles: Vec<String> = procs
        .iter()
        .filter(|(_, comm, _)| comm == "dhcpcd")
        .filter_map(|(pid, _, _)| {
            // Its whole title (argv_of keeps a program's name alone: a title's `10.0.2.15/24` isn't a path).
            let raw = crate::rt::read_file(format!("{}/{}/cmdline", p.proc, pid.as_raw_nonzero()))
                .ok()?;
            Some(String::from_utf8_lossy(&raw).replace('\0', " "))
        })
        .collect();
    let dhcpcd = (!titles.is_empty()).then(|| found(&p.dhcpcd)).flatten();
    let conf = dhcpcd
        .and_then(|_| crate::rt::read_text(&p.dhcpcd_conf).ok())
        .unwrap_or_default();
    let mut steps = Vec::new();
    for card in &cards {
        let udhcpc: Vec<Step> = procs
            .iter()
            .filter(|(_, _, a)| udhcpc_of(a, card))
            .map(|(pid, _, _)| Step::Signal(*pid, Signal::USR1))
            .collect();
        if !udhcpc.is_empty() {
            steps.extend(udhcpc);
        } else if let Some(tool) = dhcpcd
            && dhcpcd_manages(&titles, &conf, card)
        {
            steps.push(Step::Run(vec![tool.clone(), "-n".into(), card.clone()]));
        }
    }
    (!steps.is_empty()).then_some(steps)
}

/// Whether a running dhcpcd manages `card`: one whose title (`titles`: the dhcpcd processes' argv, joined) names it (a
/// dhcpcd for that card alone, `dhcpcd: eth0 [ip4] [ip6]`, or a privilege-separated helper of the manager's for it), or
/// the manager (`[manager]`, `[master]` before dhcpcd 10) where its configuration `conf` doesn't leave the card out.
pub fn dhcpcd_manages(titles: &[String], conf: &str, card: &str) -> bool {
    let words = |t: &str| {
        t.split_whitespace()
            .map(|w| w.trim_end_matches(':'))
            .collect::<Vec<_>>()
            .join(" ")
    };
    if titles
        .iter()
        .any(|t| words(t).split(' ').skip(1).any(|w| w == card))
    {
        return true;
    }
    if !titles
        .iter()
        .any(|t| t.contains("[manager]") || t.contains("[master]"))
    {
        return false;
    }
    let mut allow: Option<bool> = None;
    for line in conf.lines() {
        let line = line.split('#').next().unwrap_or("");
        let mut w = line.split_whitespace();
        let (Some(key), rest) = (w.next(), w) else {
            continue;
        };
        let pats: Vec<&str> = rest
            .flat_map(|x| x.split(','))
            .filter(|x| !x.is_empty())
            .collect();
        match key {
            "denyinterfaces" if pats.iter().any(|p| glob(p, card)) => return false,
            "allowinterfaces" => *allow.get_or_insert(false) |= pats.iter().any(|p| glob(p, card)),
            _ => {}
        }
    }
    allow.unwrap_or(true)
}

/// `name` matches shell pattern `pat` (`*`, `?`; what dhcpcd's interface lists take, through fnmatch).
fn glob(pat: &str, name: &str) -> bool {
    let (p, n) = (pat.as_bytes(), name.as_bytes());
    let (mut i, mut j, mut star, mut back) = (0, 0, None, 0);
    while j < n.len() {
        if i < p.len() && (p[i] == b'?' || p[i] == n[j]) {
            i += 1;
            j += 1;
        } else if i < p.len() && p[i] == b'*' {
            star = Some(i);
            back = j;
            i += 1;
        } else if let Some(s) = star {
            i = s + 1;
            back += 1;
            j = back;
        } else {
            return false;
        }
    }
    p[i..].iter().all(|&c| c == b'*')
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
    spawn_steps(
        &cmds
            .iter()
            .map(|c| Step::Run(c.clone()))
            .collect::<Vec<_>>(),
    )
}

/// Takes `steps` one after the other in a forked child (each program in a child of its own), which exits with 0 if all
/// did (a signal: if it was sent).
pub fn spawn_steps(steps: &[Step]) -> Result<Job, Errno> {
    // Everything the child needs, made before the fork.
    enum Ready {
        Run(Vec<Vec<u8>>),
        Signal(Pid, Signal),
        Write(String, Vec<u8>),
    }
    let ready: Vec<Ready> = steps
        .iter()
        .map(|s| match s {
            Step::Run(c) => Ready::Run(c.iter().map(|a| cstr(a)).collect()),
            Step::Signal(p, sig) => Ready::Signal(*p, *sig),
            Step::Write(path, bytes) => Ready::Write(path.clone(), bytes.clone()),
        })
        .collect();
    // SAFETY: the agent is one thread, so the child has the whole process's state in order; it never returns to the
    // parent's frames (it exits).
    let pid = unsafe { fork() };
    if pid < 0 {
        return Err(Errno::AGAIN);
    }
    if pid == 0 {
        let _ = rustix::process::set_parent_process_death_signal(Some(Signal::KILL));
        crate::rt::close_inherited();
        // Each of them, whatever became of the ones before (a card the manager doesn't renew fails alone).
        let ok = ready
            .iter()
            .filter(|r| match r {
                Ready::Run(a) => !run(a),
                Ready::Signal(p, sig) => rustix::process::kill_process(*p, *sig).is_err(),
                Ready::Write(path, bytes) => rustix::fs::open(
                    path.as_str(),
                    rustix::fs::OFlags::WRONLY | rustix::fs::OFlags::CLOEXEC,
                    rustix::fs::Mode::empty(),
                )
                .and_then(|fd| rustix::io::write(&fd, bytes))
                .is_err(),
            })
            .count()
            == 0;
        crate::rt::exit(if ok { 0 } else { 1 });
    }
    let pid = Pid::from_raw(pid).ok_or(Errno::INVAL)?;
    let pidfd = adopt(pid, pidfd_open)?;
    Ok(Job { pid, pidfd })
}

/// A forked helper's pidfd, which the loop hears its end on (`open`: `pidfd_open`; the tests' fails). Without one
/// (descriptors run out) the helper is killed before it is reaped: waiting for it to end would hold the loop for as
/// long as it runs (a whole trim, a key's making).
pub fn adopt(
    pid: Pid,
    open: fn(Pid, PidfdFlags) -> Result<OwnedFd, Errno>,
) -> Result<OwnedFd, Errno> {
    open(pid, PidfdFlags::empty()).inspect_err(|_| {
        let _ = rustix::process::kill_process(pid, Signal::KILL);
        let _ = waitpid(Some(pid), WaitOptions::empty());
    })
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

/// A job's child ended (its pidfd readable): reaped; whether it exited with 0.
pub fn reap(j: Job) -> bool {
    reaped(Some(j.pid))
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_udhcpcs_interface_in_its_arguments() {
        let i = |a: &[&str]| udhcpc_interface(&a.iter().map(|s| s.to_string()).collect::<Vec<_>>());
        // ifupdown-ng's and busybox ifupdown's.
        assert_eq!(
            i(&["-b", "-R", "-p", "/var/run/udhcpc.eth1.pid", "-i", "eth1"]),
            "eth1"
        );
        assert_eq!(i(&["-i", "eth2", "-x", "hostname:a"]), "eth2");
        assert_eq!(i(&["-ieth3"]), "eth3");
        assert_eq!(i(&["-bRi", "eth4"]), "eth4");
        assert_eq!(i(&["--interface=eth5"]), "eth5");
        assert_eq!(i(&["--interface", "eth6"]), "eth6");
        // A value with an `i` in it isn't the option (`-p/run/...pid`'s), nor is an argument past `--`.
        assert_eq!(
            i(&[
                "-p/var/run/udhcpc.pid",
                "-s",
                "/usr/share/udhcpc/default.script"
            ]),
            "eth0"
        );
        assert_eq!(i(&["-b", "--", "-i", "eth7"]), "eth0");
        assert_eq!(i(&[]), "eth0", "busybox's default");
    }

    /// REVIEW.md (review/demo-page) #6: `dhcpcd -n` only where a dhcpcd manages the card.
    #[test]
    fn dhcpcd_manages_only_its_cards() {
        let t = |a: &[&str]| a.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        // A dhcpcd per card (ifupdown's `dhcpcd eth0`): that card, not another one (a static eth1).
        let own = t(&["dhcpcd: eth0 [ip4] [ip6]"]);
        assert!(dhcpcd_manages(&own, "", "eth0"));
        assert!(
            !dhcpcd_manages(&own, "", "eth1"),
            "a card no dhcpcd runs for"
        );
        assert!(!dhcpcd_manages(&t(&["dhcpcd: eth10 [ip4]"]), "", "eth1"));
        // Not rewritten: its argv.
        assert!(dhcpcd_manages(&t(&["dhcpcd -b eth0"]), "", "eth0"));
        // The manager: every card, but those its configuration leaves out.
        for m in [
            "dhcpcd: [manager] [ip4] [ip6]",
            "dhcpcd: [master] [ip4] [ip6]",
        ] {
            let m = t(&[m]);
            assert!(dhcpcd_manages(&m, "", "eth1"));
            assert!(!dhcpcd_manages(&m, "denyinterfaces eth1 wlan*\n", "eth1"));
            assert!(!dhcpcd_manages(
                &m,
                "# x\ndenyinterfaces wlan0,eth*\n",
                "eth1"
            ));
            assert!(dhcpcd_manages(&m, "#denyinterfaces eth1\n", "eth1"));
            assert!(dhcpcd_manages(&m, "allowinterfaces eth0 eth1\n", "eth1"));
            assert!(!dhcpcd_manages(&m, "allowinterfaces eth0\n", "eth1"));
            assert!(dhcpcd_manages(&m, "allowinterfaces en?0 e*\n", "eth1"));
        }
        // A manager's helpers name the card they serve; nothing else does.
        assert!(dhcpcd_manages(
            &t(&[
                "dhcpcd: [privileged proxy]",
                "dhcpcd: [BPF ARP] eth1 10.0.2.15"
            ]),
            "",
            "eth1"
        ));
        assert!(!dhcpcd_manages(
            &t(&["dhcpcd: [privileged proxy]"]),
            "",
            "eth1"
        ));
        assert!(!dhcpcd_manages(&[], "", "eth0"));
    }

    /// A helper whose pidfd can't be had (descriptors run out): killed and reaped at once, not waited for (review L5).
    #[test]
    #[allow(clippy::zombie_processes)] // `adopt` reaps it
    fn a_helper_without_its_pidfd_is_killed_not_waited_for() {
        let child = std::process::Command::new("sleep")
            .arg("30")
            .spawn()
            .unwrap();
        let pid = Pid::from_raw(child.id() as i32).unwrap();
        let t = std::time::Instant::now();
        let r = adopt(pid, |_, _| Err(Errno::MFILE));
        assert_eq!(r.err(), Some(Errno::MFILE));
        assert!(
            t.elapsed() < std::time::Duration::from_secs(5),
            "waited {:?}",
            t.elapsed()
        );
        assert!(
            rustix::fs::stat(format!("/proc/{}", child.id()).as_str()).is_err(),
            "reaped"
        );
    }
}
