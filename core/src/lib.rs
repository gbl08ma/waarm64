//! webpc core: AArch64 CPU, MMU, JIT and platform devices.
//!
//! The crate builds natively (for tests) and for wasm32 with shared imported
//! memory and atomics.

pub mod boot;
pub mod cpu;
pub mod decode;
pub mod fdt;
pub mod fp;
pub mod gic;
pub mod interp;
pub mod mem;
pub mod mmu;
pub mod pl011;
pub mod vm;

use core::sync::atomic::{AtomicU32, Ordering};

/// Bumped when the host/core ABI changes.
pub const ABI_VERSION: u32 = 5;

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
        // A timer register or ISR_EL1: only a VM has them.
        Err(Exit::Platform(i)) => [2, decode::decode(i) as u64],
        Err(Exit::Resync | Exit::Wfi) => unreachable!("run handles {r:?}"),
    };
    done
}

// The whole-VM ABI (PLAN.md §2 "Host ABI for a whole VM"). Every `vm` argument
// comes from `vm_new` and isn't used by two calls at once; the pointers the
// getters return stay valid until `vm_free`.

/// Creates a VM with `ram_size` bytes of RAM at `ram` (layout A: after the
/// core's heap), which appears at guest PA 0x4000_0000. The vCPU starts in its
/// EL1 reset state at the start of RAM. Returns null if `cfg` doesn't match
/// `ram_size`, asks for realtime mode (not implemented), or `ram` isn't 16-byte aligned.
///
/// # Safety
/// `cfg` points at a `VmConfig`; `ram..ram + ram_size` is as for [`mem::Mem::new`].
#[unsafe(no_mangle)]
pub unsafe extern "C" fn vm_new(
    ram: *mut u8,
    ram_size: u64,
    cfg: *const vm::VmConfig,
) -> *mut vm::Vm {
    // SAFETY: guaranteed by the caller.
    let cfg = unsafe { *cfg };
    if cfg.ram_size != ram_size || cfg.deterministic == 0 || !(ram as usize).is_multiple_of(16) {
        return core::ptr::null_mut();
    }
    // SAFETY: guaranteed by the caller, alignment checked above.
    let mem = unsafe { mem::Mem::new(ram, ram_size) };
    Box::into_raw(Box::new(vm::Vm::new(mem, cfg)))
}

/// # Safety
/// `vm` comes from [`vm_new`] and is not used again.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn vm_free(vm: *mut vm::Vm) {
    // SAFETY: guaranteed by the caller.
    drop(unsafe { Box::from_raw(vm) });
}

/// The vCPU's registers (the `cpu::Cpu` offsets, as for [`vcpu_new`]); the host
/// may read and write them between [`vm_run`] calls.
///
/// # Safety
/// See the note above [`vm_new`].
#[unsafe(no_mangle)]
pub unsafe extern "C" fn vm_cpu(vm: *mut vm::Vm) -> *mut cpu::Cpu {
    // SAFETY: guaranteed by the caller.
    &mut unsafe { &mut *vm }.vcpu.cpu
}

/// Boots the arm64 `Image` the host copied to guest PA `kernel_pa`, with the
/// initrd at `initrd_pa` (`initrd_len` 0 for none) and the kernel command line
/// at `cmdline_ptr` (UTF-8, `cmdline_len` bytes, in linear memory). The core
/// writes the DTB into the top 2 MiB of RAM, which the host leaves free, and
/// sets x0 and the PC (booting.rst). Returns 0, or 1 if the Image or the
/// layout is invalid.
///
/// # Safety
/// See the note above [`vm_new`]; `cmdline_ptr..+cmdline_len` is readable.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn vm_boot(
    vm: *mut vm::Vm,
    kernel_pa: u64,
    initrd_pa: u64,
    initrd_len: u64,
    cmdline_ptr: *const u8,
    cmdline_len: usize,
) -> u32 {
    // SAFETY: guaranteed by the caller.
    let (vm, cmdline) = unsafe {
        (
            &mut *vm,
            core::slice::from_raw_parts(cmdline_ptr, cmdline_len),
        )
    };
    let Ok(cmdline) = core::str::from_utf8(cmdline) else {
        return 1;
    };
    let initrd = (initrd_len > 0).then_some((initrd_pa, initrd_len));
    vm.boot(kernel_pa, initrd, cmdline).is_err() as u32
}

/// Runs at most `budget` steps and returns the exit kind (`vm::exit`); [`vm_exit`] has the details.
///
/// # Safety
/// See the note above [`vm_new`].
#[unsafe(no_mangle)]
pub unsafe extern "C" fn vm_run(vm: *mut vm::Vm, budget: u64) -> u32 {
    // SAFETY: guaranteed by the caller.
    unsafe { &mut *vm }.run(budget)
}

/// The last run's `vm::ExitInfo`: kind, steps, value, x0–x3 (u64 each).
///
/// # Safety
/// See the note above [`vm_new`].
#[unsafe(no_mangle)]
pub unsafe extern "C" fn vm_exit(vm: *const vm::Vm) -> *const vm::ExitInfo {
    // SAFETY: guaranteed by the caller.
    &unsafe { &*vm }.exit
}

/// The console rings (`pl011::Rings`): TX at 0, RX at 4104, each {head: u32,
/// tail: u32, 4096 bytes}. Usable from any thread.
///
/// # Safety
/// See the note above [`vm_new`].
#[unsafe(no_mangle)]
pub unsafe extern "C" fn vm_console(vm: *const vm::Vm) -> *const pl011::Rings {
    // SAFETY: guaranteed by the caller.
    &unsafe { &*vm }.shared.console
}

/// The signal word (`vm::SIGNAL_STOP`, `vm::SIGNAL_RX`), set from any thread.
///
/// # Safety
/// See the note above [`vm_new`].
#[unsafe(no_mangle)]
pub unsafe extern "C" fn vm_signal(vm: *const vm::Vm) -> *const AtomicU32 {
    // SAFETY: guaranteed by the caller.
    &unsafe { &*vm }.shared.signal
}

/// The counters (`vm::Counters`, u64s), read from any thread with atomic loads.
///
/// # Safety
/// See the note above [`vm_new`].
#[unsafe(no_mangle)]
pub unsafe extern "C" fn vm_counters(vm: *const vm::Vm) -> *const vm::Counters {
    // SAFETY: guaranteed by the caller.
    &unsafe { &*vm }.shared.counters
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
