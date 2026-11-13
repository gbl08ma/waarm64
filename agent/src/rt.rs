//! What `std` would give the agent, on `rustix` and the C library it links (musl, static): the binary is `#![no_std]`
//! (docs/plans/clipboard.md §3.3: `std` was ~320 KiB of a 449 KiB binary, every byte of which the guest reads over
//! fw_cfg at each boot). The entry point is the C library's `main`, so musl's startup, `fork`, `malloc` and `exit`
//! stay the ones the agent ran with before, and SIGPIPE is ignored as `std`'s startup does. The allocator is musl's
//! `malloc`; a panic writes its location and message to stderr and aborts (the unit restarts the agent). The tests build with `std` (their harness, threads and
//! temporary directories) but run these same functions.

use crate::prelude::*;
use core::ops::Add;
use core::time::Duration;
use rustix::fd::OwnedFd;
use rustix::fs::{Dir, Mode, OFlags, open};
use rustix::io::{Errno, read};
use rustix::time::{ClockId, clock_gettime};

unsafe extern "C" {
    /// The C library's: `atexit` handlers (none) and its stdio (unused) before `_exit`.
    #[link_name = "exit"]
    fn c_exit(code: i32) -> !;
}

/// Ends the process with `code`.
pub fn exit(code: i32) -> ! {
    // SAFETY: `exit` takes any status and doesn't return.
    unsafe { c_exit(code) }
}

/// Closes every file descriptor past stderr: a forked helper's first step, so that it holds none of the agent's
/// (the page's connection above all: a copy kept open would outlive the agent's own close of it). `close_range`
/// (Linux 5.9; the agent's guests have systemd 256, so 6.x): one call, nothing to list.
pub fn close_inherited() {
    unsafe extern "C" {
        fn syscall(n: core::ffi::c_long, ...) -> core::ffi::c_long;
    }
    /// `__NR_close_range`: the same number on every architecture (asm-generic's, and x86's).
    const CLOSE_RANGE: core::ffi::c_long = 436;
    // SAFETY: close_range takes two descriptor numbers and flags, and closes only the child's own copies; nothing in
    // the child uses them after this.
    unsafe { syscall(CLOSE_RANGE, 3u32, u32::MAX, 0u32) };
}

/// Writes all of `bytes` to stderr (the journal's), as far as it takes them.
pub fn stderr(mut bytes: &[u8]) {
    while !bytes.is_empty() {
        // SAFETY: descriptor 2 is the process's stderr for its whole life (nothing here closes it).
        let fd = unsafe { rustix::fd::BorrowedFd::borrow_raw(2) };
        match rustix::io::write(fd, bytes) {
            Ok(0) => return,
            Ok(n) => bytes = &bytes[n..],
            Err(Errno::INTR) => {}
            Err(_) => return,
        }
    }
}

/// `n` in decimal, written at the end of `buf`.
pub fn decimal(mut n: u32, buf: &mut [u8; 10]) -> &[u8] {
    let mut k = buf.len();
    loop {
        k -= 1;
        buf[k] = b'0' + (n % 10) as u8;
        n /= 10;
        if n == 0 {
            return &buf[k..];
        }
    }
}

/// Sorts `v` (an insertion sort: the agent sorts a directory's few names, and `core`'s sorts are ~3 KiB a type).
pub fn sort<T: Ord>(v: &mut [T]) {
    for i in 1..v.len() {
        let mut j = i;
        while j > 0 && v[j - 1] > v[j] {
            v.swap(j - 1, j);
            j -= 1;
        }
    }
}

/// A point on the monotonic clock (`std::time::Instant`'s clock on Linux).
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct Instant(Duration);

impl Instant {
    pub fn now() -> Instant {
        let t = clock_gettime(ClockId::Monotonic);
        Instant(Duration::new(t.tv_sec as u64, t.tv_nsec as u32))
    }

    /// How long ago `self` was.
    pub fn elapsed(&self) -> Duration {
        Instant::now().saturating_duration_since(*self)
    }

    /// `self - earlier`, or zero if `earlier` is later.
    pub fn saturating_duration_since(&self, earlier: Instant) -> Duration {
        self.0.saturating_sub(earlier.0)
    }
}

impl Add<Duration> for Instant {
    type Output = Instant;
    fn add(self, d: Duration) -> Instant {
        Instant(self.0 + d)
    }
}

fn open_ro(path: &str, flags: OFlags) -> Result<OwnedFd, Errno> {
    open(
        path,
        OFlags::RDONLY | OFlags::CLOEXEC | flags,
        Mode::empty(),
    )
}

/// The whole of the file at `path`.
pub fn read_file(path: impl AsRef<str>) -> Result<Vec<u8>, Errno> {
    let fd = open_ro(path.as_ref(), OFlags::empty())?;
    let mut out = Vec::new();
    loop {
        out.reserve(4096);
        let len = out.len();
        match read(&fd, out.spare_capacity_mut()) {
            Ok((done, _)) if !done.is_empty() => {
                let n = done.len();
                // SAFETY: `read` initialised the first `n` bytes of the spare capacity.
                unsafe { out.set_len(len + n) }
            }
            Ok(_) => return Ok(out),
            Err(Errno::INTR) => {}
            Err(e) => return Err(e),
        }
    }
}

/// The file at `path` as text (`ILSEQ` when it isn't UTF-8).
pub fn read_text(path: impl AsRef<str>) -> Result<String, Errno> {
    String::from_utf8(read_file(path)?).map_err(|_| Errno::ILSEQ)
}

/// The names in the directory at `path` but `.` and `..`, in the directory's order; names that aren't UTF-8 are left
/// out (nothing the agent looks for has one).
pub fn dir_names(path: &str) -> Result<Vec<String>, Errno> {
    let fd = open_ro(path, OFlags::DIRECTORY)?;
    let mut out = Vec::new();
    for e in Dir::read_from(&fd)? {
        let e = e?;
        let Ok(n) = e.file_name().to_str() else {
            continue;
        };
        if n != "." && n != ".." {
            out.push(n.to_owned());
        }
    }
    Ok(out)
}

/// The shipped build's runtime: the allocator and the panic handler (the tests have `std`'s).
#[cfg(not(test))]
pub mod bare {
    use core::alloc::{GlobalAlloc, Layout};
    use core::ffi::c_void;

    // The C library, static (the target's own musl: .cargo/config.toml), as the `libc` crate links it for `std`.
    #[link(name = "c", kind = "static", modifiers = "-bundle")]
    unsafe extern "C" {
        fn malloc(size: usize) -> *mut c_void;
        fn calloc(n: usize, size: usize) -> *mut c_void;
        fn realloc(p: *mut c_void, size: usize) -> *mut c_void;
        fn free(p: *mut c_void);
        fn aligned_alloc(align: usize, size: usize) -> *mut c_void;
        fn abort() -> !;
    }

    /// What musl's `malloc` aligns every block to on aarch64.
    const MIN_ALIGN: usize = 16;

    /// musl's `malloc`, as `std`'s `System` uses it.
    struct Malloc;

    // SAFETY: each method keeps `GlobalAlloc`'s contract by the C library's: a block of at least `size` bytes,
    // aligned to `MIN_ALIGN` (`malloc`, `calloc`, `realloc`) or to `align` (`aligned_alloc`), or null.
    unsafe impl GlobalAlloc for Malloc {
        unsafe fn alloc(&self, l: Layout) -> *mut u8 {
            if l.align() <= MIN_ALIGN && l.align() <= l.size() {
                // SAFETY: as above.
                unsafe { malloc(l.size()) as *mut u8 }
            } else {
                // SAFETY: `align` is a power of two; C11 lets `size` be any multiple, so round it up.
                unsafe { aligned_alloc(l.align(), l.size().next_multiple_of(l.align())) as *mut u8 }
            }
        }

        unsafe fn alloc_zeroed(&self, l: Layout) -> *mut u8 {
            if l.align() <= MIN_ALIGN && l.align() <= l.size() {
                // SAFETY: as above.
                unsafe { calloc(1, l.size()) as *mut u8 }
            } else {
                // SAFETY: `alloc`'s; the block is `l.size()` bytes at least.
                let p = unsafe { self.alloc(l) };
                if !p.is_null() {
                    // SAFETY: `p` is a fresh block of `l.size()` bytes.
                    unsafe { core::ptr::write_bytes(p, 0, l.size()) };
                }
                p
            }
        }

        unsafe fn dealloc(&self, p: *mut u8, _: Layout) {
            // SAFETY: `p` came from `malloc`, `calloc`, `realloc` or `aligned_alloc`, all of which `free` takes.
            unsafe { free(p as *mut c_void) }
        }

        unsafe fn realloc(&self, p: *mut u8, l: Layout, size: usize) -> *mut u8 {
            if l.align() <= MIN_ALIGN && l.align() <= size {
                // SAFETY: `p` is a live block of this allocator; `realloc` keeps `MIN_ALIGN`.
                unsafe { realloc(p as *mut c_void, size) as *mut u8 }
            } else {
                // SAFETY: a new block of the same alignment, the old one's bytes copied and the old one freed.
                unsafe {
                    let new = self.alloc(Layout::from_size_align_unchecked(size, l.align()));
                    if !new.is_null() {
                        core::ptr::copy_nonoverlapping(p, new, l.size().min(size));
                        self.dealloc(p, l);
                    }
                    new
                }
            }
        }
    }

    // The precompiled `core` and `alloc` are built to unwind, so their landing pads name these two; the agent's
    // panics abort (`panic = "abort"`), so no landing pad is ever entered and neither is called. Stubs, not musl's
    // libunwind (tens of KiB).
    #[unsafe(no_mangle)]
    extern "C" fn rust_eh_personality() -> ! {
        // SAFETY: `abort` takes nothing and doesn't return.
        unsafe { abort() }
    }

    #[unsafe(no_mangle)]
    extern "C" fn _Unwind_Resume() -> ! {
        // SAFETY: `abort` takes nothing and doesn't return.
        unsafe { abort() }
    }

    unsafe extern "C" {
        fn signal(sig: i32, handler: usize) -> usize;
    }

    /// What `std`'s startup does before `main`: SIGPIPE ignored, so a write to a pipe whose reader left (a program
    /// that pasted and quit) fails with `EPIPE` instead of killing the agent. Its sockets send with `MSG_NOSIGNAL`
    /// anyway; the clipboard's pipes are plain writes.
    pub fn start() {
        const SIGPIPE: i32 = 13;
        const SIG_IGN: usize = 1;
        // SAFETY: SIG_IGN installs no handler of ours; the agent is one thread at this point.
        unsafe { signal(SIGPIPE, SIG_IGN) };
    }

    #[global_allocator]
    static ALLOC: Malloc = Malloc;

    #[panic_handler]
    fn panic(info: &core::panic::PanicInfo) -> ! {
        // `std`'s line (where, and the message), straight to stderr: no allocation, which may be what failed.
        struct Stderr;
        impl core::fmt::Write for Stderr {
            fn write_str(&mut self, s: &str) -> core::fmt::Result {
                super::stderr(s.as_bytes());
                Ok(())
            }
        }
        let _ = core::fmt::write(&mut Stderr, format_args!("waarm64-agent: {info}\n"));
        // SAFETY: `abort` takes nothing and doesn't return.
        unsafe { abort() }
    }
}
