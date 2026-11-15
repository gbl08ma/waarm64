//! TRIM (docs/devices.md "Disk space handed back"): the page asks the guest to tell its disks which blocks its
//! filesystems no longer use (before a disk's export, when the browser's storage is full, from the Machine menu), so
//! that the disks' overlays give them back. The agent does what `fstrim -a` does, itself (no guest tool): the kernel's
//! FITRIM ioctl on one mount point of each filesystem on a block device (`/proc/self/mountinfo`'s sources under
//! `/dev/`, one per source, never one mounted read-only), after a `sync` so that what was deleted and not yet written
//! out is free on disk too. It runs in a forked child whose end the root process's loop hears on its pidfd: a trim of
//! a large filesystem takes seconds (the device's compaction holds the guest's I/O meanwhile). TRIMMED answers
//! (`status`). The unit's sandbox lets it be: FITRIM needs CAP_SYS_ADMIN, which the unit keeps, on a read-only bind
//! of the mount (ProtectSystem=strict) as much as on the mount itself.

use crate::lease::Job;
use crate::prelude::*;
use rustix::fs::{Mode, OFlags};
use rustix::io::Errno;
use rustix::process::{Signal, WaitOptions, pidfd_open, waitpid};

/// TRIMMED's statuses.
pub mod status {
    /// At least one filesystem trimmed, and none failed.
    pub const TRIMMED: u8 = 0;
    /// No filesystem takes a trim (none on a block device, or their disks don't discard).
    pub const NONE: u8 = 1;
    /// A filesystem's trim failed (others may have been trimmed).
    pub const FAILED: u8 = 2;
}

/// Where the mount table is (the tests' is a file of their own).
#[derive(Clone)]
pub struct Paths {
    pub mountinfo: String,
}

impl Default for Paths {
    fn default() -> Paths {
        Paths {
            mountinfo: "/proc/self/mountinfo".into(),
        }
    }
}

/// Trims the filesystem mounted at a path (`fitrim`; the tests' records it).
pub type Fitrim = fn(&str) -> Result<(), Errno>;

/// A mount table's field with its octal escapes (`\040` a space, `\011` a tab, `\012` a newline, `\134` a backslash)
/// read back.
fn unescape(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'\\'
            && i + 3 < b.len()
            && b[i + 1..i + 4].iter().all(|c| (b'0'..=b'7').contains(c))
        {
            out.push((b[i + 1] - b'0') * 64 + (b[i + 2] - b'0') * 8 + (b[i + 3] - b'0'));
            i += 4;
        } else {
            out.push(b[i]);
            i += 1;
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// A mount in the table: its mount point, filesystem type and source (escapes read back), and whether its
/// superblock is read-only.
pub struct Mount {
    pub point: String,
    pub kind: String,
    pub source: String,
    pub ro: bool,
}

/// The mounts in a mount table (`/proc/self/mountinfo`'s lines), in its order; lines that aren't one are skipped.
pub fn mounts(mountinfo: &str) -> Vec<Mount> {
    let mut out = Vec::new();
    for line in mountinfo.lines() {
        let fields: Vec<&str> = line.split(' ').collect();
        // id, parent, major:minor, root, mount point, options, optional fields…, "-", type, source, superblock options.
        let Some(dash) = fields.iter().position(|f| *f == "-") else {
            continue;
        };
        if dash < 6 || fields.len() < dash + 4 {
            continue;
        }
        out.push(Mount {
            point: unescape(fields[4]),
            kind: unescape(fields[dash + 1]),
            source: unescape(fields[dash + 2]),
            ro: fields[dash + 3].split(',').any(|o| o == "ro"),
        });
    }
    out
}

/// The filesystems to trim in a mount table: each block device's (a source under `/dev/`) whose filesystem isn't
/// read-only (its superblock's options), with its mount points in the table's order (the first that opens is
/// trimmed: the others are the same filesystem's binds); in the order first seen.
pub fn targets(mountinfo: &str) -> Vec<(String, Vec<String>)> {
    let mut out: Vec<(String, Vec<String>)> = Vec::new();
    for m in mounts(mountinfo) {
        if !m.source.starts_with("/dev/") || m.ro {
            continue;
        }
        match out.iter_mut().find(|(s, _)| *s == m.source) {
            Some((_, points)) => points.push(m.point),
            None => out.push((m.source, vec![m.point])),
        }
    }
    out
}

/// FITRIM (linux/fs.h): `_IOWR('X', 121, struct fstrim_range)`.
const FITRIM: rustix::ioctl::Opcode = 0xC018_5879;

/// `struct fstrim_range`: the whole filesystem, every free extent however small.
#[repr(C)]
struct Range {
    start: u64,
    len: u64,
    minlen: u64,
}

/// Trims the filesystem mounted at `point`: FITRIM on its directory.
pub fn fitrim(point: &str) -> Result<(), Errno> {
    let fd = rustix::fs::open(
        point,
        OFlags::RDONLY | OFlags::DIRECTORY | OFlags::CLOEXEC,
        Mode::empty(),
    )?;
    let mut r = Range {
        start: 0,
        len: u64::MAX,
        minlen: 0,
    };
    // SAFETY: FITRIM reads and writes a `struct fstrim_range`, which `Range` is (three u64s, C's layout), alive for the call.
    unsafe { rustix::ioctl::ioctl(&fd, rustix::ioctl::Updater::<FITRIM, Range>::new(&mut r)) }
}

/// Whether an error says the filesystem (or its disk) takes no trim, rather than that a trim failed.
fn unsupported(e: Errno) -> bool {
    e == Errno::OPNOTSUPP || e == Errno::NOTTY || e == Errno::NOSYS
}

/// The trim of every filesystem in the mount table at `p` (each by the first of its mount points that opens):
/// TRIMMED's status.
pub fn trim_all(p: &Paths, fitrim: Fitrim) -> u8 {
    rustix::fs::sync();
    let table = crate::rt::read_text(&p.mountinfo).unwrap_or_default();
    let (mut trimmed, mut failed) = (0, 0);
    for (source, points) in targets(&table) {
        // The first error that isn't the mount point's (one that doesn't open: another of them may).
        let mut result = Err(Errno::NOENT);
        for point in &points {
            result = fitrim(point);
            if !matches!(
                result,
                Err(Errno::NOENT | Errno::ACCESS | Errno::PERM | Errno::NOTDIR)
            ) {
                break;
            }
        }
        match result {
            Ok(()) => trimmed += 1,
            Err(e) if unsupported(e) => {}
            // None of its mount points reachable from the unit (InaccessiblePaths): not the agent's to trim.
            Err(Errno::NOENT | Errno::ACCESS | Errno::PERM | Errno::NOTDIR) => {}
            Err(e) => {
                crate::log(&format!("trim: {source}"), Some(e));
                failed += 1;
            }
        }
    }
    if failed > 0 {
        status::FAILED
    } else if trimmed > 0 {
        status::TRIMMED
    } else {
        status::NONE
    }
}

unsafe extern "C" {
    /// The C library's (musl's), as in src/lease.rs.
    fn fork() -> i32;
}

/// Runs `trim_all` in a forked child, which exits with its status.
pub fn spawn(p: &Paths, fitrim: Fitrim) -> Result<Job, Errno> {
    // SAFETY: the agent is one thread, so the child has the whole process's state in order; it never returns to the
    // parent's frames (it exits).
    let pid = unsafe { fork() };
    if pid < 0 {
        return Err(Errno::AGAIN);
    }
    if pid == 0 {
        let _ = rustix::process::set_parent_process_death_signal(Some(Signal::KILL));
        crate::rt::close_inherited();
        crate::rt::exit(trim_all(p, fitrim) as i32);
    }
    let pid = rustix::process::Pid::from_raw(pid).ok_or(Errno::INVAL)?;
    let pidfd = crate::lease::adopt(pid, pidfd_open)?;
    Ok(Job { pid, pidfd })
}

/// The child ended (its pidfd readable): reaped; TRIMMED's status.
pub fn done(j: Job) -> u8 {
    loop {
        match waitpid(Some(j.pid), WaitOptions::empty()) {
            Ok(Some((_, st))) => {
                return match st.exit_status() {
                    Some(s) if s == status::TRIMMED as i32 || s == status::NONE as i32 => {
                        crate::log(
                            if s == status::TRIMMED as i32 {
                                "trim: the filesystems trimmed"
                            } else {
                                "trim: no filesystem takes a trim"
                            },
                            None,
                        );
                        s as u8
                    }
                    _ => status::FAILED,
                };
            }
            Err(Errno::INTR) => {}
            _ => return status::FAILED,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn trims_each_block_devices_filesystem_once_and_none_read_only() {
        let table = "\
22 1 254:1 / / rw,relatime shared:1 - ext4 /dev/vda2 rw
23 22 0:21 / /proc rw,nosuid shared:12 - proc proc rw
24 22 0:25 / /tmp rw shared:13 - tmpfs tmpfs rw,size=1024k
25 22 254:1 /home /home ro,relatime shared:1 - ext4 /dev/vda2 rw
26 22 254:17 / /boot/my\\040efi rw shared:30 - vfat /dev/vdb1 rw,fmask=0022
27 22 254:33 / /mnt/ro ro shared:31 - ext4 /dev/vdc ro
28 22 0:40 / /srv rw shared:32 master:7 - btrfs /dev/vdd rw,space_cache=v2
";
        assert_eq!(
            targets(table),
            vec![
                (
                    "/dev/vda2".to_owned(),
                    vec!["/".to_owned(), "/home".to_owned()]
                ),
                ("/dev/vdb1".to_owned(), vec!["/boot/my efi".to_owned()]),
                ("/dev/vdd".to_owned(), vec!["/srv".to_owned()]),
            ],
            "binds once, read-only superblocks and pseudo filesystems never, a read-only bind's filesystem still"
        );
        assert_eq!(targets("garbage\n1 2 3\n"), Vec::new());
    }

    #[test]
    fn unescapes_the_tables_octal() {
        assert_eq!(unescape("a\\040b\\134c\\011"), "a b\\c\t");
        assert_eq!(unescape("x\\04"), "x\\04");
    }
}
