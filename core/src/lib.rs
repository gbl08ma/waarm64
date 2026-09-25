//! webpc core: AArch64 CPU, MMU, JIT and platform devices.
//!
//! The crate builds natively (for tests) and for wasm32 with shared imported
//! memory and atomics.

pub mod cpu;
pub mod decode;
pub mod fp;
pub mod interp;
pub mod mem;
pub mod mmu;

use core::sync::atomic::{AtomicU32, Ordering};

/// Bumped when the host/core ABI changes.
pub const ABI_VERSION: u32 = 4;

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
/// returned pointer (`cpu::Cpu` is `repr(C)`: X0–X30 and SP at 0, PC at 256, NZCV at 264, V0–V31 at 304, FPCR at 816, FPSR at 824).
/// It starts as a Linux user process at EL0 (`Cpu::default`).
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

/// Like [`interp_run`], and also writes why it stopped to `exit` as two u64s:
/// kind (0 ran all `n`, 1 UNDEFINED, 2 unimplemented, 3 other fault, 4 alignment
/// fault, 5 SVC, 6 BRK, 7 trap to EL1, 8 HVC) and a value (the `Op` index, fault
/// address, immediate, or for a trap the ESR_EL1 EC and ISS). Faults include
/// instruction fetches; a misaligned PC is an alignment fault at the PC.
///
/// # Safety
/// As for [`interp_run`]; `exit` points at 16 writable, 8-byte-aligned bytes.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn interp_run_exit(
    cpu: *mut cpu::Cpu,
    mem: *const mem::Mem,
    n: u64,
    exit: *mut [u64; 2],
) -> u64 {
    use interp::Exit;
    // SAFETY: guaranteed by the caller.
    let (cpu, mem, exit) = unsafe { (&mut *cpu, &*mem, &mut *exit) };
    let (done, r) = interp::run(cpu, mem, n);
    *exit = match r {
        Ok(()) => [0, 0],
        Err(Exit::Undefined) => [1, 0],
        Err(Exit::Unimplemented(op)) => [2, op as u64],
        Err(Exit::Fault(f) | Exit::Fetch(f)) => match f.kind {
            mem::FaultKind::Align => [4, f.addr],
            _ => [3, f.addr],
        },
        Err(Exit::Svc(imm)) => [5, imm as u64],
        Err(Exit::Brk(imm)) => [6, imm as u64],
        Err(Exit::Trap(esr)) => [7, esr as u64],
        Err(Exit::Hvc(imm)) => [8, imm as u64],
        Err(Exit::Resync) => unreachable!("run handles Resync"),
    };
    done
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
