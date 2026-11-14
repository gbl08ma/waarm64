//! DROP (docs/devices.md "balloon"): the page asks, right before a snapshot or a suspend (Preferences' switch), that the
//! guest's kernel drop its clean caches, so that the memory they held is free and the balloon's free page hints hand it
//! over zeroed: a snapshot leaves zero pages out. A `sync` first (dirty pages aren't dropped), then `3` written to
//! `/proc/sys/vm/drop_caches` (the page cache, dentries and inodes). In a forked child, as TRIM's (src/trim.rs): a sync
//! of a busy disk takes seconds. DROPPED answers (`status`). The unit's `ProtectKernelTunables` keeps `/proc/sys`
//! read-only but for that file (`ReadWritePaths`, web/app/guest-agent.ts).

use crate::lease::Job;
use crate::prelude::*;
use rustix::fs::{Mode, OFlags};
use rustix::io::Errno;
use rustix::process::{Signal, WaitOptions, pidfd_open, waitpid};

/// DROPPED's statuses.
pub mod status {
    /// The caches were dropped.
    pub const DROPPED: u8 = 0;
    /// The kernel's file couldn't be written (a sandbox without it, no procfs).
    pub const FAILED: u8 = 1;
}

/// Where the kernel's switch is (the tests' is a file of their own).
#[derive(Clone)]
pub struct Paths {
    pub drop_caches: String,
}

impl Default for Paths {
    fn default() -> Paths {
        Paths {
            drop_caches: "/proc/sys/vm/drop_caches".into(),
        }
    }
}

/// The sync, then the caches dropped: DROPPED's status.
pub fn drop_all(p: &Paths) -> u8 {
    rustix::fs::sync();
    let written = rustix::fs::open(
        p.drop_caches.as_str(),
        OFlags::WRONLY | OFlags::CLOEXEC,
        Mode::empty(),
    )
    .and_then(|fd| rustix::io::write(&fd, b"3\n"));
    match written {
        Ok(_) => status::DROPPED,
        Err(e) => {
            crate::log("drop: the caches", Some(e));
            status::FAILED
        }
    }
}

unsafe extern "C" {
    /// The C library's (musl's), as in src/lease.rs.
    fn fork() -> i32;
}

/// Runs `drop_all` in a forked child, which exits with its status.
pub fn spawn(p: &Paths) -> Result<Job, Errno> {
    // SAFETY: the agent is one thread, so the child has the whole process's state in order; it never returns to the
    // parent's frames (it exits).
    let pid = unsafe { fork() };
    if pid < 0 {
        return Err(Errno::AGAIN);
    }
    if pid == 0 {
        let _ = rustix::process::set_parent_process_death_signal(Some(Signal::KILL));
        crate::rt::close_inherited();
        crate::rt::exit(drop_all(p) as i32);
    }
    let pid = rustix::process::Pid::from_raw(pid).ok_or(Errno::INVAL)?;
    let pidfd = crate::lease::adopt(pid, pidfd_open)?;
    Ok(Job { pid, pidfd })
}

/// The child ended (its pidfd readable): reaped; DROPPED's status.
pub fn done(j: Job) -> u8 {
    loop {
        match waitpid(Some(j.pid), WaitOptions::empty()) {
            Ok(Some((_, st))) => {
                return match st.exit_status() {
                    Some(s) if s == status::DROPPED as i32 => {
                        crate::log("drop: the caches dropped", None);
                        status::DROPPED
                    }
                    _ => status::FAILED,
                };
            }
            Err(Errno::INTR) => {}
            _ => return status::FAILED,
        }
    }
}
