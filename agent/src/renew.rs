//! RENEW (docs/devices.md "The guest's agent", "A template's identity"): the guest made its own after a restore of a
//! snapshot flagged as a template, which every visitor restores the same: the kernel's random generator, the machine's
//! id, systemd's random seed and the SSH host keys would otherwise be the same in every copy. The page sends random
//! bytes of the host's; the root process, as root:
//! - **The kernel's entropy:** the bytes added to the input pool and credited (`RNDADDENTROPY` on `/dev/random`), then a
//!   reseed of the CRNG forced (`RNDRESEEDCRNG`: added entropy reaches it otherwise only at the next periodic reseed),
//!   so `getrandom` differs in each copy from then on.
//! - **`/etc/machine-id`:** a new random id (version 4, as systemd makes one), written in place (the file may be a bind
//!   mount; its mode kept: it is read-only, 0444, so made writable for the write and back). What has read the old one
//!   (journald's file names, D-Bus) keeps it until it restarts.
//! - **systemd's random seed** (`/var/lib/systemd/random-seed`, if there is one): new bytes of its length.
//! - **The SSH host keys** (`/etc/ssh/ssh_host_<type>_key`, if there are any and `ssh-keygen` is there: the agent runs a
//!   guest program only where it exists): each made again by `ssh-keygen` into `<key>.new`, then renamed over the old
//!   key and its `.pub`, so sshd never finds one missing. In a helper process (forked; it runs `ssh-keygen` one key at a
//!   time), whose end the root process's loop hears on its pidfd: an RSA key takes seconds of a vCPU.
//! - **Not the hostname** (the user's choice: it takes effect properly only after a restart).
//!
//! RENEWED answers: a u8 of what was renewed and a u8 of what was tried and failed (`what`); what isn't there is in
//! neither.

use crate::log;
use crate::prelude::*;
use rustix::fd::{AsFd, OwnedFd};
use rustix::fs::{Mode, OFlags, open};
use rustix::io::{Errno, write};
use rustix::process::{Pid, PidfdFlags, Signal, WaitOptions, pidfd_open, waitpid};

/// RENEWED's bits.
pub mod what {
    pub const ENTROPY: u8 = 1 << 0;
    pub const MACHINE_ID: u8 = 1 << 1;
    pub const SEED: u8 = 1 << 2;
    pub const SSH: u8 = 1 << 3;
}

/// The most of the page's bytes used (and credited).
pub const MAX_ENTROPY: usize = 512;

/// Where the renewed things are (the tests' are directories of their own).
#[derive(Clone)]
pub struct Paths {
    pub random: String,
    pub machine_id: String,
    pub seed: String,
    pub ssh: String,
    /// Where `ssh-keygen` may be, first found first.
    pub keygen: Vec<String>,
    /// Where the processes are (sshd's listeners are found there).
    pub proc: String,
}

impl Default for Paths {
    fn default() -> Paths {
        Paths {
            random: "/dev/random".into(),
            machine_id: "/etc/machine-id".into(),
            seed: "/var/lib/systemd/random-seed".into(),
            ssh: "/etc/ssh".into(),
            keygen: [
                "/usr/bin/ssh-keygen",
                "/bin/ssh-keygen",
                "/usr/local/bin/ssh-keygen",
            ]
            .map(String::from)
            .to_vec(),
            proc: "/proc".into(),
        }
    }
}

/// The keys' helper, running.
pub struct Keygen {
    pub pid: Pid,
    pub pidfd: OwnedFd,
    /// What was renewed and failed before it.
    pub done: u8,
    pub failed: u8,
}

/// The renewal so far: what it did, what failed, and the keys' helper if it runs.
pub struct Renewed {
    pub done: u8,
    pub failed: u8,
    pub keygen: Option<Keygen>,
}

/// RNDADDENTROPY (linux/random.h: `_IOW('R', 0x03, int[2])`) and RNDRESEEDCRNG (`_IO('R', 0x07)`).
const RNDADDENTROPY: rustix::ioctl::Opcode = 0x4008_5203;
const RNDRESEEDCRNG: rustix::ioctl::Opcode = 0x5207;

/// `struct rand_pool_info` with room for `MAX_ENTROPY` bytes.
#[repr(C)]
struct Pool {
    entropy_count: i32,
    buf_size: i32,
    buf: [u8; MAX_ENTROPY],
}

/// The bytes added to the kernel's pool, credited, and the CRNG reseeded: the agent's `add_entropy`.
pub fn add_entropy(random: &str, bytes: &[u8]) -> Result<(), Errno> {
    let fd = open(random, OFlags::WRONLY | OFlags::CLOEXEC, Mode::empty())?;
    let n = bytes.len().min(MAX_ENTROPY);
    let mut pool = Pool {
        entropy_count: (8 * n) as i32,
        buf_size: n as i32,
        buf: [0; MAX_ENTROPY],
    };
    pool.buf[..n].copy_from_slice(&bytes[..n]);
    // SAFETY: RNDADDENTROPY reads a `struct rand_pool_info` whose `buf_size` bytes follow it; `Pool` is one with
    // `MAX_ENTROPY` bytes of room and `buf_size` at most that.
    unsafe {
        rustix::ioctl::ioctl(&fd, rustix::ioctl::Setter::<RNDADDENTROPY, Pool>::new(pool))?;
    }
    // SAFETY: RNDRESEEDCRNG takes no argument.
    unsafe { rustix::ioctl::ioctl(&fd, rustix::ioctl::NoArg::<RNDRESEEDCRNG>::new()) }
}

/// Random bytes from the kernel (reseeded from the page's), mixed with the page's own (should the reseed have failed).
fn random(n: usize, page: &[u8], salt: usize) -> Vec<u8> {
    let mut b = vec![0u8; n];
    let mut at = 0;
    while at < n {
        match rustix::rand::getrandom(&mut b[at..], rustix::rand::GetRandomFlags::empty()) {
            Ok(k) => at += k,
            Err(Errno::INTR) => {}
            Err(_) => break,
        }
    }
    if !page.is_empty() {
        for (i, x) in b.iter_mut().enumerate() {
            *x ^= page[(i + salt) % page.len()];
        }
    }
    b
}

/// A machine id: 16 random bytes as version 4 (systemd's `id128_make_v4_uuid`), in 32 lowercase hex digits and a newline.
pub fn machine_id(bytes: &[u8; 16]) -> String {
    let mut b = *bytes;
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    let mut s: String = b.iter().map(|x| format!("{x:02x}")).collect();
    s.push('\n');
    s
}

/// `bytes` written over the file at `path` (it must exist), in place; a read-only mode made writable for it and back.
fn overwrite(path: &str, bytes: &[u8]) -> Result<(), Errno> {
    let st = rustix::fs::stat(path)?;
    let mode = Mode::from_raw_mode(st.st_mode) & Mode::from_raw_mode(0o7777);
    let fd = match open(
        path,
        OFlags::WRONLY | OFlags::TRUNC | OFlags::CLOEXEC,
        Mode::empty(),
    ) {
        Ok(fd) => fd,
        Err(Errno::ACCESS) => {
            // Its owner (root) may change its mode without CAP_DAC_OVERRIDE, which the agent hasn't.
            rustix::fs::chmod(path, mode | Mode::WUSR)?;
            let fd = open(
                path,
                OFlags::WRONLY | OFlags::TRUNC | OFlags::CLOEXEC,
                Mode::empty(),
            );
            let _ = rustix::fs::chmod(path, mode);
            fd?
        }
        Err(e) => return Err(e),
    };
    let mut at = 0;
    while at < bytes.len() {
        match write(&fd, &bytes[at..]) {
            Ok(n) => at += n,
            Err(Errno::INTR) => {}
            Err(e) => return Err(e),
        }
    }
    rustix::fs::fsync(&fd)
}

/// The host keys in `dir`: each key's path and type (`ssh_host_<type>_key`).
pub fn host_keys(dir: &str) -> Vec<(String, String)> {
    let Ok(mut names) = crate::rt::dir_names(dir) else {
        return Vec::new();
    };
    crate::rt::sort(&mut names);
    names
        .into_iter()
        .filter_map(|n| {
            let ty = n.strip_prefix("ssh_host_")?.strip_suffix("_key")?;
            (!ty.is_empty() && ty.bytes().all(|c| c.is_ascii_alphanumeric()))
                .then(|| (format!("{dir}/{n}"), ty.to_owned()))
        })
        .collect()
}

/// Renews what there is (the module's list) from the page's `bytes`; `add` adds them to the kernel's pool (the tests'
/// records them).
pub fn renew(paths: &Paths, bytes: &[u8], add: fn(&str, &[u8]) -> Result<(), Errno>) -> Renewed {
    let (mut done, mut failed) = (0u8, 0u8);
    let mut mark = |bit: u8, r: Result<(), Errno>, what: &str| match r {
        Ok(()) => done |= bit,
        Err(e) => {
            failed |= bit;
            log(&format!("renew: {what}"), Some(e));
        }
    };
    mark(
        what::ENTROPY,
        add(&paths.random, bytes),
        "the kernel's entropy",
    );
    if rustix::fs::stat(paths.machine_id.as_str()).is_ok() {
        let id: [u8; 16] = random(16, bytes, 0).try_into().unwrap();
        mark(
            what::MACHINE_ID,
            overwrite(&paths.machine_id, machine_id(&id).as_bytes()),
            "the machine id",
        );
    }
    if let Ok(st) = rustix::fs::stat(paths.seed.as_str()) {
        let n = (st.st_size as usize).clamp(32, 4096);
        mark(
            what::SEED,
            overwrite(&paths.seed, &random(n, bytes, 16)),
            "the random seed",
        );
    }
    let keys = host_keys(&paths.ssh);
    let keygen = paths
        .keygen
        .iter()
        .find(|p| rustix::fs::access(p.as_str(), rustix::fs::Access::EXEC_OK).is_ok());
    let mut helper = None;
    match (keys.is_empty(), keygen) {
        (true, _) => {}
        (false, None) => log(
            "renew: SSH host keys but no ssh-keygen: left as they are",
            None,
        ),
        (false, Some(kg)) => match spawn_keygen(kg, &keys) {
            Ok((pid, pidfd)) => {
                helper = Some(Keygen {
                    pid,
                    pidfd,
                    done,
                    failed,
                })
            }
            Err(e) => mark(what::SSH, Err(e), "the SSH host keys"),
        },
    }
    if helper.is_none() {
        log(
            &format!("renew: done (renewed {done:#x}, failed {failed:#x})"),
            None,
        );
    }
    Renewed {
        done,
        failed,
        keygen: helper,
    }
}

unsafe extern "C" {
    /// The C library's (musl's): a raw clone would leave its idea of the thread's id stale.
    fn fork() -> i32;
    fn execv(path: *const core::ffi::c_char, argv: *const *const core::ffi::c_char) -> i32;
    fn umask(mask: u32) -> u32;
}

/// The keys' helper: forked, it makes each key again (`ssh-keygen`, one at a time) and renames it into place; it exits
/// with 0 if all were made.
fn spawn_keygen(keygen: &str, keys: &[(String, String)]) -> Result<(Pid, OwnedFd), Errno> {
    // Everything the helper needs, made before the fork (it allocates nothing it can't).
    let keygen = cstr(keygen);
    let jobs: Vec<_> = keys
        .iter()
        .map(|(path, ty)| {
            let tmp = format!("{path}.new");
            (path.clone(), cstr(ty), tmp.clone(), cstr(&tmp))
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
        // SAFETY: umask has no preconditions. The public halves are for everyone to read, as ssh-keygen makes them.
        unsafe { umask(0o022) };
        let mut ok = true;
        for (path, ty, tmp, ctmp) in &jobs {
            let _ = rustix::fs::unlink(tmp.as_str());
            let _ = rustix::fs::unlink(format!("{tmp}.pub").as_str());
            let made = run_keygen(&keygen, ty, ctmp)
                && rustix::fs::rename(
                    format!("{tmp}.pub").as_str(),
                    format!("{path}.pub").as_str(),
                )
                .is_ok()
                && rustix::fs::rename(tmp.as_str(), path.as_str()).is_ok();
            ok &= made;
        }
        crate::rt::exit(if ok { 0 } else { 1 });
    }
    let pid = Pid::from_raw(pid).ok_or(Errno::INVAL)?;
    let pidfd = pidfd_open(pid, PidfdFlags::empty()).inspect_err(|_| {
        let _ = waitpid(Some(pid), WaitOptions::empty());
    })?;
    Ok((pid, pidfd))
}

fn cstr(s: &str) -> Vec<u8> {
    let mut v = s.as_bytes().to_vec();
    v.push(0);
    v
}

/// `ssh-keygen -q -N "" -t <ty> -f <out>` in a child of the helper; whether it exited with 0.
fn run_keygen(keygen: &[u8], ty: &[u8], out: &[u8]) -> bool {
    let args: [&[u8]; 8] = [
        b"ssh-keygen\0",
        b"-q\0",
        b"-N\0",
        b"\0",
        b"-t\0",
        ty,
        b"-f\0",
        out,
    ];
    let mut argv: Vec<*const core::ffi::c_char> = args.iter().map(|a| a.as_ptr().cast()).collect();
    argv.push(core::ptr::null());
    // SAFETY: as in `spawn_keygen`: one thread.
    let pid = unsafe { fork() };
    if pid < 0 {
        return false;
    }
    if pid == 0 {
        // SAFETY: NUL-terminated strings, and a null-terminated array of them, that outlive the call (it replaces the
        // process or fails).
        unsafe { execv(keygen.as_ptr().cast(), argv.as_ptr()) };
        crate::rt::exit(127);
    }
    let Some(pid) = Pid::from_raw(pid) else {
        return false;
    };
    loop {
        match waitpid(Some(pid), WaitOptions::empty()) {
            Ok(Some((_, st))) => return st.exit_status() == Some(0),
            Err(Errno::INTR) => {}
            _ => return false,
        }
    }
}

/// The keys' helper ended (its pidfd readable): reaped, and, if the keys were made, sshd's listeners told to load them;
/// what was renewed and failed in all.
pub fn keygen_done(k: Keygen, paths: &Paths) -> (u8, u8) {
    let ok = loop {
        match waitpid(Some(k.pid), WaitOptions::empty()) {
            Ok(Some((_, st))) => break st.exit_status() == Some(0),
            Err(Errno::INTR) => {}
            _ => break false,
        }
    };
    let _ = k.pidfd.as_fd();
    let (done, failed) = if ok {
        let n = reload_sshd(&paths.proc);
        log(
            &format!("renew: the SSH host keys made again; {n} sshd listener(s) told to load them"),
            None,
        );
        (k.done | what::SSH, k.failed)
    } else {
        log("renew: the SSH host keys: ssh-keygen failed", None);
        (k.done, k.failed | what::SSH)
    };
    log(
        &format!("renew: done (renewed {done:#x}, failed {failed:#x})"),
        None,
    );
    (done, failed)
}

/// A process's name and its parent's pid (`/proc/<pid>/stat`: the name between the parentheses, then the state and
/// the parent).
fn stat_of(proc: &str, pid: &str) -> Option<(String, String)> {
    let s = crate::rt::read_text(format!("{proc}/{pid}/stat")).ok()?;
    let (open, close) = (s.find('(')?, s.rfind(')')?);
    let name = s.get(open + 1..close)?.to_owned();
    let ppid = s.get(close + 1..)?.split_whitespace().nth(1)?.to_owned();
    Some((name, ppid))
}

/// SIGHUP to each sshd listener (a process named `sshd` whose parent isn't one: before OpenSSH 9.8 a connection's
/// process is an `sshd` too, its parent the listener), which re-executes itself and loads the host keys again: since
/// 9.8 the listener reads them only at its start and at SIGHUP, and hands them to each connection, so without it a
/// template's copy would go on serving the template's keys. A socket-activated sshd (`sshd -i` per connection) reads
/// them each time and has no listener. How many were told.
pub fn reload_sshd(proc: &str) -> usize {
    let Ok(pids) = crate::rt::dir_names(proc) else {
        return 0;
    };
    let mut n = 0;
    for pid in pids
        .iter()
        .filter(|p| !p.is_empty() && p.bytes().all(|c| c.is_ascii_digit()))
    {
        let Some((name, ppid)) = stat_of(proc, pid) else {
            continue;
        };
        if name != "sshd" || stat_of(proc, &ppid).is_some_and(|(p, _)| p == "sshd") {
            continue;
        }
        let Some(p) = pid.parse().ok().and_then(Pid::from_raw) else {
            continue;
        };
        if rustix::process::kill_process(p, Signal::HUP).is_ok() {
            n += 1;
        }
    }
    n
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_machine_id_is_a_v4_ids_hex() {
        let id = machine_id(&[0xff; 16]);
        assert_eq!(id, "ffffffffffff4fffbfffffffffffffff\n");
        assert_eq!(id.len(), 33);
    }

    #[test]
    fn finds_the_host_keys_not_their_public_halves() {
        let dir = std::env::temp_dir().join(format!("waarm64-agent-keys-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir(&dir).unwrap();
        for n in [
            "ssh_host_rsa_key",
            "ssh_host_rsa_key.pub",
            "ssh_host_ed25519_key",
            "sshd_config",
            "ssh_host__key",
        ] {
            std::fs::write(dir.join(n), "x").unwrap();
        }
        let d = dir.to_str().unwrap();
        let keys: Vec<_> = host_keys(d)
            .into_iter()
            .map(|(p, t)| (p.rsplit('/').next().unwrap().to_owned(), t))
            .collect();
        assert_eq!(
            keys,
            [
                ("ssh_host_ed25519_key".into(), "ed25519".into()),
                ("ssh_host_rsa_key".into(), "rsa".into())
            ]
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}
