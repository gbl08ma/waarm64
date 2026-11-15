//! GROW (docs/devices.md "A disk grown"): the page grew a disk while its machines were off (docs/machines.md §4.5)
//! and asks, at the agent's HELLO, for the guest's side of it: the partition that ends last grown into the new space
//! and its filesystem grown online, if mounted (only mounted filesystems: the user's choice). By syscalls and ioctls
//! only, no guest tool: the disk by its serial (`/sys/block/*/serial`, the page's `waarm64-<attachment id>`, which the
//! device cuts at 20 bytes); its partition table (src/table.rs: GPT or MBR, both checked first, the backup written
//! before the primary); `BLKPG_RESIZE_PARTITION` so the kernel sees the partition's new size (online, mounted or not);
//! then the filesystem: ext2/3/4 `EXT4_IOC_RESIZE_FS`, btrfs `BTRFS_IOC_RESIZE` "<devid>:max", xfs
//! `XFS_IOC_FSGROWFSDATA`. A partition that holds another block device (LVM, LUKS, md: its `holders`) is grown, its
//! filesystem left alone; so is one not mounted. Grow only, never past the device's end; a second GROW after one that
//! grew finds nothing to grow. It runs in a forked child (a large ext4's resize takes seconds), one disk at a time,
//! whose GROWN payload comes back through a pipe.
//!
//! The unit's sandbox: the resize ioctls need a writable mount (`mnt_want_write_file`), which `ProtectSystem=strict`'s
//! read-only binds aren't: the filesystem is reached through a clone of its mount made writable (`open_tree`'s
//! `OPEN_TREE_CLONE`, `mount_setattr` clearing `MOUNT_ATTR_RDONLY`), detached and the agent's alone, gone when closed.
//! CAP_SYS_ADMIN covers BLKPG, open_tree, btrfs's and xfs's ioctls; ext4's resize also takes CAP_SYS_RESOURCE.

use crate::lease::Job;
use crate::prelude::*;
use crate::table;
use rustix::fd::{AsFd, AsRawFd, BorrowedFd, FromRawFd, OwnedFd};
use rustix::fs::{FlockOperation, Mode, OFlags, SeekFrom};
use rustix::io::Errno;
use rustix::process::{Signal, WaitOptions, pidfd_open, waitpid};

/// GROWN's partition statuses: what became of the partition (or the whole disk's table).
pub mod part {
    /// The partition that ends last grew (its table written, the kernel told).
    pub const GROWN: u8 = 0;
    /// It already reaches the disk's end (to the last whole MiB).
    pub const NOTHING: u8 = 1;
    /// No disk has the serial.
    pub const NOT_FOUND: u8 = 2;
    /// The disk is smaller than the page expects (not the grown disk yet).
    pub const NOT_YET: u8 = 3;
    /// No partition table: the filesystem is the whole disk's.
    pub const NO_TABLE: u8 = 4;
    /// The new space doesn't follow a partition this grows (MBR's extended partition ends last, or there is none).
    pub const NOT_LAST: u8 = 5;
    /// The table doesn't add up (a CRC, a header, a partition outside the disk): left alone.
    pub const BAD_TABLE: u8 = 6;
    /// A step failed (GROWN's errno says how).
    pub const FAILED: u8 = 7;
    /// The GROW didn't read (a payload too short, its serial what of it reads): nothing done.
    pub const BAD_REQUEST: u8 = 8;
}

/// GROWN's filesystem statuses.
pub mod fs {
    /// Grown to the partition's (or disk's) size.
    pub const GROWN: u8 = 0;
    /// It already has it.
    pub const NOTHING: u8 = 1;
    /// Not mounted: left alone.
    pub const NOT_MOUNTED: u8 = 2;
    /// A filesystem this doesn't grow (not ext2/3/4, btrfs or xfs).
    pub const UNSUPPORTED: u8 = 3;
    /// The partition holds another block device (LVM, LUKS, md): left alone.
    pub const STACKED: u8 = 4;
    /// The grow failed (GROWN's errno says how).
    pub const FAILED: u8 = 5;
    /// Not tried: the partition's step didn't get there.
    pub const SKIPPED: u8 = 6;
}

/// Where the disks, their nodes and the mount table are (the tests' are their own).
#[derive(Clone)]
pub struct Paths {
    pub sys_block: String,
    pub dev: String,
    pub mountinfo: String,
}

impl Default for Paths {
    fn default() -> Paths {
        Paths {
            sys_block: "/sys/block".into(),
            dev: "/dev".into(),
            mountinfo: "/proc/self/mountinfo".into(),
        }
    }
}

/// The kernel told a partition's new size (`BLKPG_RESIZE_PARTITION` on the disk's descriptor; the partition's sysfs
/// directory for the tests', which plays the kernel): its number, first byte and length in bytes.
pub type ResizePart =
    fn(sys: &str, disk: BorrowedFd<'_>, pno: u32, start: u64, len: u64) -> Result<(), Errno>;
/// A mounted filesystem (its type, its mount's directory open, its device's node) grown to `bytes`: whether it grew.
pub type GrowFs = fn(kind: &str, dir: BorrowedFd<'_>, dev: &str, bytes: u64) -> Result<bool, Errno>;

#[derive(Clone, Copy)]
pub struct Ops {
    pub resize_part: ResizePart,
    pub grow_fs: GrowFs,
}

impl Default for Ops {
    fn default() -> Ops {
        Ops {
            resize_part: blkpg_resize,
            grow_fs,
        }
    }
}

/// GROWN's fields: the statuses, the failed step's errno (0 for none), the partition's (or disk's) size now in bytes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Answer {
    pub part: u8,
    pub fs: u8,
    pub errno: u32,
    pub size: u64,
}

/// The most bytes of a serial the device gives (VIRTIO_BLK_ID_BYTES).
const SERIAL_MAX: usize = 20;

/// The disk (its name under /sys/block) whose serial is `serial` (cut as the device cuts it).
fn find(p: &Paths, serial: &str) -> Option<String> {
    let want = &serial.as_bytes()[..serial.len().min(SERIAL_MAX)];
    crate::rt::dir_names(&p.sys_block)
        .ok()?
        .into_iter()
        .find(|n| {
            crate::rt::read_file(format!("{}/{n}/serial", p.sys_block)).is_ok_and(|s| {
                let end = s
                    .iter()
                    .rposition(|&b| !matches!(b, b'\n' | b' ' | 0))
                    .map_or(0, |i| i + 1);
                s[..end] == *want
            })
        })
}

/// A number in a sysfs file.
fn sys_u64(path: &str) -> Option<u64> {
    crate::rt::read_text(path).ok()?.trim().parse().ok()
}

/// The disk's partition numbered `pno` as the kernel has it: its name, first sector and sectors (of 512 bytes).
fn kernel_part(sys: &str, pno: u32) -> Option<(String, u64, u64)> {
    crate::rt::dir_names(sys).ok()?.into_iter().find_map(|n| {
        let d = format!("{sys}/{n}");
        (sys_u64(&format!("{d}/partition")) == Some(pno as u64))
            .then(|| {
                Some((
                    n,
                    sys_u64(&format!("{d}/start"))?,
                    sys_u64(&format!("{d}/size"))?,
                ))
            })
            .flatten()
    })
}

/// Takes the disk's lock (`LOCK_EX`, as partitioning tools do: udev doesn't probe it meanwhile), waiting up to 5 s
/// for whoever holds it.
fn lock(fd: &OwnedFd) -> Result<(), Errno> {
    for _ in 0..50 {
        match rustix::fs::flock(fd, FlockOperation::NonBlockingLockExclusive) {
            Err(Errno::WOULDBLOCK) | Err(Errno::INTR) => {
                let _ = rustix::thread::nanosleep(&rustix::time::Timespec {
                    tv_sec: 0,
                    tv_nsec: 100_000_000,
                });
            }
            r => return r,
        }
    }
    Err(Errno::WOULDBLOCK)
}

fn failed(e: Errno, size: u64) -> Answer {
    Answer {
        part: part::FAILED,
        fs: fs::SKIPPED,
        errno: e.raw_os_error() as u32,
        size,
    }
}

/// GROW for the disk with `serial`, which the page expects to be `want` bytes.
pub fn grow(p: &Paths, ops: Ops, serial: &str, want: u64) -> Answer {
    let Some(disk) = find(p, serial) else {
        crate::log(&format!("grow: no disk {serial}"), None);
        return Answer {
            part: part::NOT_FOUND,
            fs: fs::SKIPPED,
            errno: 0,
            size: 0,
        };
    };
    grow_disk(p, ops, &disk, want)
}

/// GROW for the disk `disk` (its name under /sys/block).
pub fn grow_disk(p: &Paths, ops: Ops, disk: &str, want: u64) -> Answer {
    let disk = disk.to_owned();
    let sys = format!("{}/{disk}", p.sys_block);
    let node = format!("{}/{disk}", p.dev);
    let fd = match rustix::fs::open(node.as_str(), OFlags::RDWR | OFlags::CLOEXEC, Mode::empty()) {
        Ok(fd) => fd,
        Err(e) => {
            crate::log(&format!("grow: {node}"), Some(e));
            return failed(e, 0);
        }
    };
    let size = match rustix::fs::seek(&fd, SeekFrom::End(0)) {
        Ok(s) => s,
        Err(e) => return failed(e, 0),
    };
    if size < want {
        crate::log(
            &format!("grow: {disk} is {size} bytes, not {want} yet"),
            None,
        );
        return Answer {
            part: part::NOT_YET,
            fs: fs::SKIPPED,
            errno: 0,
            size,
        };
    }
    if let Err(e) = lock(&fd) {
        crate::log(&format!("grow: {disk}'s lock"), Some(e));
        return failed(e, size);
    }
    let lbs = sys_u64(&format!("{sys}/queue/logical_block_size")).unwrap_or(512);
    let (pstatus, name, bytes) = match table::grow(
        &table::Fd {
            fd: fd.as_fd(),
            size,
        },
        size,
        lbs,
    ) {
        table::Outcome::NoTable => (part::NO_TABLE, disk.clone(), size),
        table::Outcome::NotLast => {
            crate::log(
                &format!("grow: {disk}'s space doesn't follow a partition it grows"),
                None,
            );
            return Answer {
                part: part::NOT_LAST,
                fs: fs::SKIPPED,
                errno: 0,
                size,
            };
        }
        table::Outcome::Bad(why) => {
            crate::log(&format!("grow: {disk}'s table left alone: {why}"), None);
            return Answer {
                part: part::BAD_TABLE,
                fs: fs::SKIPPED,
                errno: 0,
                size,
            };
        }
        table::Outcome::Failed(e) => {
            crate::log(&format!("grow: {disk}'s table"), Some(e));
            return failed(e, size);
        }
        table::Outcome::Last {
            pno,
            start,
            len,
            written,
        } => {
            let (start, bytes) = (start * lbs, len * lbs);
            let Some((name, kstart, ksize)) = kernel_part(&sys, pno) else {
                crate::log(
                    &format!("grow: the kernel has no partition {pno} on {disk}"),
                    None,
                );
                return failed(Errno::NXIO, bytes);
            };
            if kstart * 512 != start {
                crate::log(
                    &format!("grow: {name} starts elsewhere in the kernel than in the table"),
                    None,
                );
                return failed(Errno::INVAL, bytes);
            }
            // The kernel's partition smaller than the table's (just grown, or a run that stopped before telling it).
            let told = ksize * 512 < bytes;
            if told
                && let Err(e) =
                    (ops.resize_part)(&format!("{sys}/{name}"), fd.as_fd(), pno, start, bytes)
            {
                crate::log(&format!("grow: {name}'s resize in the kernel"), Some(e));
                return failed(e, ksize * 512);
            }
            if written || told {
                crate::log(&format!("grow: {name} grown to {bytes} bytes"), None);
            }
            (
                if told { part::GROWN } else { part::NOTHING },
                name.clone(),
                bytes,
            )
        }
    };
    drop(fd);
    let dir = if name == disk {
        sys.clone()
    } else {
        format!("{sys}/{name}")
    };
    let (fstatus, errno) = filesystem(p, ops, &dir, &name, bytes);
    Answer {
        part: pstatus,
        fs: fstatus,
        errno,
        size: bytes,
    }
}

/// The filesystem on the block device `name` (its sysfs directory `sys`), grown to `bytes` if mounted.
fn filesystem(p: &Paths, ops: Ops, sys: &str, name: &str, bytes: u64) -> (u8, u32) {
    if crate::rt::dir_names(&format!("{sys}/holders")).is_ok_and(|h| !h.is_empty()) {
        crate::log(
            &format!(
                "grow: {name} holds another device (LVM, LUKS, md): its filesystem left alone"
            ),
            None,
        );
        return (fs::STACKED, 0);
    }
    let node = format!("/dev/{name}");
    let rdev = crate::rt::read_text(format!("{sys}/dev"))
        .ok()
        .and_then(|d| {
            let (a, b) = d.trim().split_once(':')?;
            Some(rustix::fs::makedev(a.parse().ok()?, b.parse().ok()?))
        });
    // Its mounts: by the table's device number (ext2/3/4's and xfs's are the partition's own: a root the kernel
    // mounted shows its source as `/dev/root`), by the source's name, or by a source node with the device's number
    // (btrfs's device number is the filesystem's own, not the partition's).
    let table = crate::rt::read_text(&p.mountinfo).unwrap_or_default();
    let mounts: Vec<_> = crate::trim::mounts(&table)
        .into_iter()
        .filter(|m| {
            m.source == node
                || rdev.is_some_and(|r| {
                    m.dev == r
                        || (m.source.starts_with("/dev/")
                            && rustix::fs::stat(m.source.as_str()).is_ok_and(|s| {
                                rustix::fs::FileType::from_raw_mode(s.st_mode)
                                    == rustix::fs::FileType::BlockDevice
                                    && s.st_rdev == r
                            }))
                })
        })
        .collect();
    let Some(kind) = mounts.first().map(|m| m.kind.clone()) else {
        crate::log(
            &format!("grow: {name} isn't mounted: its filesystem left alone"),
            None,
        );
        return (fs::NOT_MOUNTED, 0);
    };
    if !matches!(kind.as_str(), "ext2" | "ext3" | "ext4" | "btrfs" | "xfs") {
        crate::log(&format!("grow: {name}'s {kind} isn't one it grows"), None);
        return (fs::UNSUPPORTED, 0);
    }
    // The first mount point that opens (others may be hidden from the unit, or another's binds) on this filesystem:
    // another mounted over the point (EXDEV) isn't grown. ext2/3/4's and xfs's directory is on the partition itself;
    // btrfs's filesystem is checked by its id (`btrfs_devid`).
    let mut r = Err(Errno::NOENT);
    for m in &mounts {
        r = writable(&m.point).and_then(|dir| {
            if kind != "btrfs"
                && rdev.is_none_or(|d| rustix::fs::fstat(&dir).map(|s| s.st_dev) != Ok(d))
            {
                return Err(Errno::XDEV);
            }
            (ops.grow_fs)(&kind, dir.as_fd(), &node, bytes)
        });
        if !matches!(
            r,
            Err(Errno::NOENT | Errno::ACCESS | Errno::NOTDIR | Errno::XDEV)
        ) {
            break;
        }
    }
    match r {
        Ok(true) => {
            crate::log(&format!("grow: {name}'s {kind} grown"), None);
            (fs::GROWN, 0)
        }
        Ok(false) => (fs::NOTHING, 0),
        Err(e) => {
            crate::log(&format!("grow: {name}'s {kind}"), Some(e));
            (fs::FAILED, e.raw_os_error() as u32)
        }
    }
}

/// BLKPG (linux/fs.h `_IO(0x12, 105)`) and its `BLKPG_RESIZE_PARTITION`.
const BLKPG: rustix::ioctl::Opcode = 0x1269;
const BLKPG_RESIZE_PARTITION: i32 = 3;

/// `struct blkpg_partition` (linux/blkpg.h): bytes.
#[repr(C)]
struct BlkpgPart {
    start: i64,
    length: i64,
    pno: i32,
    devname: [u8; 64],
    volname: [u8; 64],
}

/// `struct blkpg_ioctl_arg`.
#[repr(C)]
struct BlkpgArg {
    op: i32,
    flags: i32,
    datalen: i32,
    data: *mut BlkpgPart,
}

/// `BLKPG_RESIZE_PARTITION`: the kernel's partition `pno` on `disk` takes its new length (its start unchanged).
pub fn blkpg_resize(
    _sys: &str,
    disk: BorrowedFd<'_>,
    pno: u32,
    start: u64,
    len: u64,
) -> Result<(), Errno> {
    let mut part = BlkpgPart {
        start: start as i64,
        length: len as i64,
        pno: pno as i32,
        devname: [0; 64],
        volname: [0; 64],
    };
    let mut arg = BlkpgArg {
        op: BLKPG_RESIZE_PARTITION,
        flags: 0,
        datalen: core::mem::size_of::<BlkpgPart>() as i32,
        data: &mut part,
    };
    // SAFETY: BLKPG reads a `struct blkpg_ioctl_arg` (BlkpgArg, C's layout) whose `data` points at a `struct
    // blkpg_partition` (BlkpgPart) of `datalen` bytes; both live for the call.
    unsafe {
        rustix::ioctl::ioctl(
            disk,
            rustix::ioctl::Updater::<BLKPG, BlkpgArg>::new(&mut arg),
        )
    }
}

unsafe extern "C" {
    /// The C library's (musl's), as in src/rt.rs: rustix has no `mount_setattr`.
    fn syscall(n: core::ffi::c_long, ...) -> core::ffi::c_long;
}

/// A syscall's argument (each passed as a whole register).
type Long = core::ffi::c_long;

/// `__NR_open_tree` and `__NR_mount_setattr`: asm-generic's numbers, x86's too.
const OPEN_TREE: core::ffi::c_long = 428;
const MOUNT_SETATTR: core::ffi::c_long = 442;

/// `struct mount_attr` (linux/mount.h, its first version).
#[repr(C)]
struct MountAttr {
    attr_set: u64,
    attr_clr: u64,
    propagation: u64,
    userns_fd: u64,
}

/// The mount at `point` as a directory the resize ioctls take: a detached clone of it with the read-only flag
/// cleared (the unit's `ProtectSystem=strict` binds it read-only; the superblock is as the guest mounted it). A
/// kernel without these calls (before 5.12), or a mount that refuses, gives the mount point itself.
fn writable(point: &str) -> Result<OwnedFd, Errno> {
    let dir = || {
        rustix::fs::open(
            point,
            OFlags::RDONLY | OFlags::DIRECTORY | OFlags::CLOEXEC,
            Mode::empty(),
        )
    };
    let Ok(c) = alloc::ffi::CString::new(point) else {
        return Err(Errno::INVAL);
    };
    /// OPEN_TREE_CLONE, OPEN_TREE_CLOEXEC (O_CLOEXEC), AT_FDCWD, AT_EMPTY_PATH, MOUNT_ATTR_RDONLY.
    const CLONE: u32 = 1;
    let cloexec = OFlags::CLOEXEC.bits();
    const AT_FDCWD: i32 = -100;
    const AT_EMPTY_PATH: u32 = 0x1000;
    // SAFETY: open_tree takes a directory descriptor, a NUL-terminated path that outlives the call and flags; it
    // returns a new descriptor (or -1), which only this owns.
    let tree = unsafe {
        syscall(
            OPEN_TREE,
            AT_FDCWD as Long,
            c.as_ptr(),
            (CLONE | cloexec) as Long,
        )
    };
    if tree < 0 {
        return dir();
    }
    // SAFETY: a descriptor open_tree just returned, owned by nothing else.
    let tree = unsafe { OwnedFd::from_raw_fd(tree as i32) };
    let attr = MountAttr {
        attr_set: 0,
        attr_clr: 1,
        propagation: 0,
        userns_fd: 0,
    };
    // SAFETY: mount_setattr reads `size` bytes of a `struct mount_attr` (MountAttr, C's layout) that outlives the
    // call; the path is an empty NUL-terminated string (AT_EMPTY_PATH: the descriptor's own mount).
    let r = unsafe {
        syscall(
            MOUNT_SETATTR,
            tree.as_raw_fd() as Long,
            c"".as_ptr(),
            AT_EMPTY_PATH as Long,
            &attr as *const MountAttr,
            core::mem::size_of::<MountAttr>() as Long,
        )
    };
    if r < 0 {
        return dir();
    }
    rustix::fs::openat(
        &tree,
        ".",
        OFlags::RDONLY | OFlags::DIRECTORY | OFlags::CLOEXEC,
        Mode::empty(),
    )
}

/// EXT4_IOC_RESIZE_FS (linux/ext4.h `_IOW('f', 16, __u64)`): the new block count.
const EXT4_IOC_RESIZE_FS: rustix::ioctl::Opcode = 0x4008_6610;
/// BTRFS_IOC_RESIZE, BTRFS_IOC_FS_INFO, BTRFS_IOC_DEV_INFO (linux/btrfs.h).
const BTRFS_IOC_RESIZE: rustix::ioctl::Opcode = 0x5000_9403;
const BTRFS_IOC_FS_INFO: rustix::ioctl::Opcode = 0x8400_941f;
const BTRFS_IOC_DEV_INFO: rustix::ioctl::Opcode = 0xd000_941e;
/// XFS_IOC_FSGEOMETRY (`_IOR('X', 126, struct xfs_fsop_geom)`, 256 bytes), XFS_IOC_FSGROWFSDATA (`_IOW('X', 110,
/// struct xfs_growfs_data)`).
const XFS_IOC_FSGEOMETRY: rustix::ioctl::Opcode = 0x8100_587e;
const XFS_IOC_FSGROWFSDATA: rustix::ioctl::Opcode = 0x4010_586e;

/// `struct btrfs_ioctl_vol_args`: a descriptor and a NUL-terminated string.
#[repr(C)]
struct VolArgs {
    fd: i64,
    name: [u8; 4088],
}

/// `struct btrfs_ioctl_fs_info_args`'s first fields, padded to its 1 KiB.
#[repr(C)]
struct FsInfo {
    max_id: u64,
    num_devices: u64,
    rest: [u8; 1008],
}

/// `struct btrfs_ioctl_dev_info_args`: the devid, then the rest of its 4 KiB; the device's path at 3072.
#[repr(C)]
struct DevInfo {
    devid: u64,
    rest: [u8; 4088],
}

/// `struct xfs_fsop_geom`'s first fields, padded to its 256 bytes.
#[repr(C)]
struct XfsGeom {
    blocksize: u32,
    rtextsize: u32,
    agblocks: u32,
    agcount: u32,
    logblocks: u32,
    sectsize: u32,
    inodesize: u32,
    imaxpct: u32,
    datablocks: u64,
    rest: [u8; 216],
}

/// `struct xfs_growfs_data`.
#[repr(C)]
struct XfsGrow {
    newblocks: u64,
    imaxpct: u32,
    pad: u32,
}

/// The btrfs devid of the device `dev` (its node) in the filesystem open at `dir`: its superblock's, if the
/// superblock's filesystem id is that filesystem's (else EXDEV: another filesystem is at the mount point).
fn btrfs_devid(dir: BorrowedFd<'_>, dev: &str) -> Result<u64, Errno> {
    let mut info = Box::new(FsInfo {
        max_id: 0,
        num_devices: 0,
        rest: [0; 1008],
    });
    // SAFETY: BTRFS_IOC_FS_INFO writes a `struct btrfs_ioctl_fs_info_args` (1 KiB, which FsInfo is), alive for the call.
    unsafe {
        rustix::ioctl::ioctl(
            dir,
            rustix::ioctl::Updater::<BTRFS_IOC_FS_INFO, FsInfo>::new(&mut info),
        )
    }?;
    // The superblock (64 KiB in): its fsid at 0x20, its magic at 0x40, its dev_item (devid first) at 0xc9.
    let node = rustix::fs::open(dev, OFlags::RDONLY | OFlags::CLOEXEC, Mode::empty())?;
    let mut sb = [0u8; 0xd1];
    let d = table::Fd {
        fd: node.as_fd(),
        size: 0,
    };
    table::Disk::read(&d, 64 << 10, &mut sb)?;
    if &sb[0x40..0x48] != b"_BHRfS_M" || sb[0x20..0x30] != info.rest[..16] {
        return Err(Errno::XDEV);
    }
    let id = u64::from_le_bytes(sb[0xc9..0xd1].try_into().unwrap());
    let mut d = Box::new(DevInfo {
        devid: id,
        rest: [0; 4088],
    });
    // SAFETY: BTRFS_IOC_DEV_INFO reads and writes a `struct btrfs_ioctl_dev_info_args` (4 KiB, which DevInfo is:
    // its devid in, a zero uuid to match by devid only), alive for the call.
    unsafe {
        rustix::ioctl::ioctl(
            dir,
            rustix::ioctl::Updater::<BTRFS_IOC_DEV_INFO, DevInfo>::new(&mut d),
        )
    }?;
    Ok(id)
}

/// Grows the filesystem of type `kind` whose mount `dir` is (on `dev`) to `bytes`: whether its size grew.
pub fn grow_fs(kind: &str, dir: BorrowedFd<'_>, dev: &str, bytes: u64) -> Result<bool, Errno> {
    let before = rustix::fs::fstatfs(dir)?.f_blocks;
    match kind {
        "ext2" | "ext3" | "ext4" => {
            let bsize = rustix::fs::fstatfs(dir)?.f_bsize as u64;
            let mut n = bytes / bsize.max(1024);
            // SAFETY: EXT4_IOC_RESIZE_FS reads a u64, alive for the call.
            unsafe {
                rustix::ioctl::ioctl(
                    dir,
                    rustix::ioctl::Updater::<EXT4_IOC_RESIZE_FS, u64>::new(&mut n),
                )
            }?;
        }
        "btrfs" => {
            let id = btrfs_devid(dir, dev)?;
            let mut a = Box::new(VolArgs {
                fd: 0,
                name: [0; 4088],
            });
            let s = format!("{id}:max");
            a.name[..s.len()].copy_from_slice(s.as_bytes());
            // SAFETY: BTRFS_IOC_RESIZE reads a `struct btrfs_ioctl_vol_args` (VolArgs: its name NUL-terminated),
            // alive for the call.
            unsafe {
                rustix::ioctl::ioctl(
                    dir,
                    rustix::ioctl::Updater::<BTRFS_IOC_RESIZE, VolArgs>::new(&mut a),
                )
            }?;
        }
        "xfs" => {
            let mut g = XfsGeom {
                blocksize: 0,
                rtextsize: 0,
                agblocks: 0,
                agcount: 0,
                logblocks: 0,
                sectsize: 0,
                inodesize: 0,
                imaxpct: 0,
                datablocks: 0,
                rest: [0; 216],
            };
            // SAFETY: XFS_IOC_FSGEOMETRY writes a `struct xfs_fsop_geom` (256 bytes, which XfsGeom is), alive for the call.
            unsafe {
                rustix::ioctl::ioctl(
                    dir,
                    rustix::ioctl::Updater::<XFS_IOC_FSGEOMETRY, XfsGeom>::new(&mut g),
                )
            }?;
            let n = bytes / (g.blocksize as u64).max(512);
            if n <= g.datablocks {
                return Ok(false);
            }
            let mut a = XfsGrow {
                newblocks: n,
                imaxpct: g.imaxpct,
                pad: 0,
            };
            // SAFETY: XFS_IOC_FSGROWFSDATA reads a `struct xfs_growfs_data` (XfsGrow), alive for the call.
            unsafe {
                rustix::ioctl::ioctl(
                    dir,
                    rustix::ioctl::Updater::<XFS_IOC_FSGROWFSDATA, XfsGrow>::new(&mut a),
                )
            }?;
        }
        _ => return Err(Errno::OPNOTSUPP),
    }
    Ok(rustix::fs::fstatfs(dir)?.f_blocks > before)
}

/// GROWN's payload for `serial` (frame.rs `grown`).
pub fn payload(serial: &str, a: Answer) -> Vec<u8> {
    let mut out = Vec::new();
    crate::frame::grown(serial, a, &mut out);
    out
}

/// A GROW running in a forked child: its job, the pipe its payload comes through, its serial.
pub struct Running {
    pub job: Job,
    out: OwnedFd,
    pub serial: String,
}

unsafe extern "C" {
    /// The C library's (musl's), as in src/lease.rs.
    fn fork() -> i32;
}

/// Runs `grow` in a forked child, which writes GROWN's payload to a pipe and exits.
pub fn spawn(p: &Paths, ops: Ops, serial: &str, want: u64) -> Result<Running, Errno> {
    let (r, w) = rustix::pipe::pipe_with(rustix::pipe::PipeFlags::CLOEXEC)?;
    // SAFETY: the agent is one thread, so the child has the whole process's state in order; it never returns to the
    // parent's frames (it exits).
    let pid = unsafe { fork() };
    if pid < 0 {
        return Err(Errno::AGAIN);
    }
    if pid == 0 {
        let _ = rustix::process::set_parent_process_death_signal(Some(Signal::KILL));
        crate::rt::close_inherited_but(w.as_raw_fd());
        let b = payload(serial, grow(p, ops, serial, want));
        let _ = rustix::io::write(&w, &b);
        crate::rt::exit(0);
    }
    drop(w);
    let pid = rustix::process::Pid::from_raw(pid).ok_or(Errno::INVAL)?;
    let pidfd = crate::lease::adopt(pid, pidfd_open)?;
    Ok(Running {
        job: Job { pid, pidfd },
        out: r,
        serial: serial.to_owned(),
    })
}

/// The child ended (its pidfd readable): reaped; GROWN's payload (a failure's if the child said nothing).
pub fn done(g: Running) -> Vec<u8> {
    let mut b = Vec::new();
    let mut buf = [0u8; 512];
    loop {
        match rustix::io::read(&g.out, &mut buf) {
            Ok(0) => break,
            Ok(n) => b.extend_from_slice(&buf[..n]),
            Err(Errno::INTR) => {}
            Err(_) => break,
        }
    }
    while let Err(Errno::INTR) = waitpid(Some(g.job.pid), WaitOptions::empty()) {}
    if b.is_empty() {
        crate::log(
            &format!("grow: {}: the child ended without an answer", g.serial),
            None,
        );
        b = payload(
            &g.serial,
            Answer {
                part: part::FAILED,
                fs: fs::SKIPPED,
                errno: 0,
                size: 0,
            },
        );
    }
    b
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The real ioctls, ad hoc, as root on a loop device with a filesystem mounted (docs/devices.md "A disk grown"):
    /// `WAARM64_GROW_DISK=loop0 <the tests' binary> --ignored a_real_disk --nocapture`. Not in any CI script.
    #[test]
    #[ignore]
    fn a_real_disk() {
        let Ok(disk) = std::env::var("WAARM64_GROW_DISK") else {
            return;
        };
        println!(
            "{:?}",
            grow_disk(&Paths::default(), Ops::default(), &disk, 0)
        );
    }
}
