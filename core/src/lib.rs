//! webpc core: AArch64 CPU, MMU, JIT and platform devices.
//!
//! The crate builds natively (for tests) and for wasm32 with shared imported
//! memory and atomics.

pub mod cpu;
pub mod decode;
pub mod interp;
pub mod mem;

use core::sync::atomic::{AtomicU32, Ordering};

/// Bumped when the host/core ABI changes.
pub const ABI_VERSION: u32 = 1;

#[unsafe(no_mangle)]
pub extern "C" fn abi_version() -> u32 {
    ABI_VERSION
}

/// Sums `len` little-endian u64 words starting at `ptr` in linear memory.
///
/// # Safety
/// `ptr..ptr + len * 8` must be readable and 8-byte aligned.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn sum_u64(ptr: *const u64, len: usize) -> u64 {
    // SAFETY: guaranteed by the caller.
    let words = unsafe { core::slice::from_raw_parts(ptr, len) };
    words.iter().fold(0u64, |acc, w| acc.wrapping_add(*w))
}

/// Atomically increments the u32 at `ptr` and returns the previous value.
/// Exercises wasm atomics on the shared memory.
///
/// # Safety
/// `ptr` must be valid and 4-byte aligned.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn atomic_inc(ptr: *const AtomicU32) -> u32 {
    // SAFETY: guaranteed by the caller.
    unsafe { &*ptr }.fetch_add(1, Ordering::SeqCst)
}

/// Allocates a zeroed vCPU. The host reads and writes its registers through the
/// returned pointer (`cpu::Cpu` is `repr(C)`: X0–X30 and SP at 0, PC at 256, NZCV at 264).
#[unsafe(no_mangle)]
pub extern "C" fn vcpu_new() -> *mut cpu::Cpu {
    Box::into_raw(Box::default())
}

/// Allocates the guest-memory handle for RAM at `base..base + size` in linear memory.
///
/// # Safety
/// As for [`mem::Mem::new`]: the range stays valid, is only guest RAM and is 16-byte aligned.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn mem_new(base: *mut u8, size: u64) -> *mut mem::Mem {
    // SAFETY: guaranteed by the caller.
    Box::into_raw(Box::new(unsafe { mem::Mem::new(base, size) }))
}

/// Interprets up to `n` instructions and returns how many retired. It stops early
/// at an exit (exception, fault, unimplemented instruction), with the PC on that instruction.
///
/// # Safety
/// `cpu` and `mem` come from [`vcpu_new`] and [`mem_new`]; nothing else uses `cpu` meanwhile.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn interp_run(cpu: *mut cpu::Cpu, mem: *const mem::Mem, n: u64) -> u64 {
    // SAFETY: guaranteed by the caller.
    let (cpu, mem) = unsafe { (&mut *cpu, &*mem) };
    interp::run(cpu, mem, n).0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sum_wraps() {
        let v = [u64::MAX, 2, 3];
        assert_eq!(unsafe { sum_u64(v.as_ptr(), v.len()) }, 4);
    }

    #[test]
    fn atomic_inc_returns_previous() {
        let a = AtomicU32::new(7);
        assert_eq!(unsafe { atomic_inc(&a) }, 7);
        assert_eq!(a.load(Ordering::SeqCst), 8);
    }
}
