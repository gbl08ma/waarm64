//! The panic message for the host (ABI 27). The core is built `panic = "abort"`,
//! and wasm32-unknown-unknown's default hook prints nothing, so a panic used to
//! reach the host as a bare `RuntimeError: unreachable`. The hook installed by
//! [`install_panic_hook`] keeps the first panic's message in a static buffer that
//! `panic_message` exports; a host that caught the trap reads it and puts it in
//! its error (web/vm.ts `panicMessage`).

use core::sync::atomic::{AtomicU8, AtomicU32, Ordering};

/// Bytes of a message kept (longer ones are cut).
pub const CAP: usize = 4096;

/// `len` (a little-endian u32, 0 = no panic yet), then that many bytes of UTF-8.
#[repr(C)]
pub struct Message {
    len: AtomicU32,
    bytes: [AtomicU8; CAP],
}

static MESSAGE: Message = Message {
    len: AtomicU32::new(0),
    bytes: [const { AtomicU8::new(0) }; CAP],
};

/// Keeps the first panic's message (thread, location, text). Later panics (a
/// vCPU thread's abort brings the others down with follow-ups) don't replace it.
pub fn record(msg: &str) {
    // Claims the buffer: len goes 0 -> u32::MAX while it's written.
    if MESSAGE
        .len
        .compare_exchange(0, u32::MAX, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return;
    }
    let mut n = msg.len().min(CAP);
    while !msg.is_char_boundary(n) {
        n -= 1;
    }
    for (slot, b) in MESSAGE.bytes.iter().zip(msg.as_bytes()[..n].iter()) {
        slot.store(*b, Ordering::Relaxed);
    }
    MESSAGE.len.store(n as u32, Ordering::SeqCst);
}

/// The recorded message, if any (tests).
pub fn recorded() -> Option<String> {
    let n = MESSAGE.len.load(Ordering::SeqCst);
    if n == 0 || n == u32::MAX {
        return None;
    }
    let b: Vec<u8> = MESSAGE.bytes[..n as usize]
        .iter()
        .map(|b| b.load(Ordering::Relaxed))
        .collect();
    Some(String::from_utf8_lossy(&b).into_owned())
}

/// A message built without the heap (an allocation failure's).
pub struct Line {
    bytes: [u8; 192],
    len: usize,
}

impl Default for Line {
    fn default() -> Line {
        Line {
            bytes: [0; 192],
            len: 0,
        }
    }
}

impl Line {
    pub fn as_str(&self) -> &str {
        core::str::from_utf8(&self.bytes[..self.len]).unwrap_or("")
    }
}

impl core::fmt::Write for Line {
    fn write_str(&mut self, s: &str) -> core::fmt::Result {
        let n = s.len().min(self.bytes.len() - self.len);
        self.bytes[self.len..self.len + n].copy_from_slice(&s.as_bytes()[..n]);
        self.len += n;
        Ok(())
    }
}

/// What an allocation of `size` bytes that failed records, with the heap's
/// live bytes and high-water mark (`heap_stats`).
pub fn alloc_message(size: usize, live: usize, peak: usize) -> Line {
    use core::fmt::Write;
    let mut l = Line::default();
    let _ = write!(
        l,
        "out of memory: an allocation of {size} bytes failed (the core's heap: {} MiB live, {} MiB at most)",
        live >> 20,
        peak >> 20
    );
    l
}

/// The allocation error hook: `handle_alloc_error` (an infallible
/// allocation that failed: the heap is full) aborts without the panic hook,
/// so a trap from it reached the host with no message (2026-10-21's
/// `rust_oom` in `jit::Jit::miss`). Records one, without allocating.
fn alloc_failed(l: std::alloc::Layout) {
    let (live, peak) = crate::heap();
    let m = alloc_message(l.size(), live, peak);
    record(m.as_str());
    #[cfg(not(target_arch = "wasm32"))]
    eprintln!("waarm64: {}", m.as_str());
}

/// Installs the hook once (`vm_new` does; the state is in the shared memory,
/// so every instance's threads see it), and the allocation error hook
/// (`alloc_failed`). Natively the previous panic hook still runs.
pub fn install_panic_hook() {
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| {
        std::alloc::set_alloc_error_hook(alloc_failed);
        let prev = std::panic::take_hook();
        std::panic::set_hook(Box::new(move |info| {
            record(&info.to_string());
            #[cfg(not(target_arch = "wasm32"))]
            prev(info);
            #[cfg(target_arch = "wasm32")]
            let _ = &prev;
        }));
    });
}

/// Address of the [`Message`] (ABI 27): read it after a trap, `len` at +0, the
/// bytes at +4. Also installs the hook, so a host can call it before any VM.
#[unsafe(no_mangle)]
pub extern "C" fn panic_message() -> *const Message {
    install_panic_hook();
    &MESSAGE
}
