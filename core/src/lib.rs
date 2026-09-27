//! webpc core: AArch64 CPU, MMU, JIT and platform devices.
//!
//! The crate builds natively (for tests) and for wasm32 with shared imported
//! memory and atomics.

pub mod boot;
pub mod cpu;
pub mod crypto;
pub mod decode;
pub mod fdt;
pub mod fp;
pub mod gic;
pub mod interp;
pub mod jit;
pub mod mem;
pub mod mmu;
pub mod pl011;
pub mod virtio;
pub mod vm;

use core::sync::atomic::{AtomicU32, Ordering};

/// Bumped when the host/core ABI changes.
pub const ABI_VERSION: u32 = 18;

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
    // SAFETY: guaranteed by the caller.
    let (cpu, mem, exit) = unsafe { (&mut *cpu, &*mem, &mut *exit) };
    let (done, r) = interp::run(cpu, mem, n);
    *exit = exit_code(r);
    done
}

/// `interp_run_exit`'s (kind, value) for a run's result.
fn exit_code(r: Result<(), interp::Exit>) -> [u64; 2] {
    use interp::Exit;
    match r {
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
        Err(e @ (Exit::Resync | Exit::Invalidate(_) | Exit::Wfi)) => {
            unreachable!("run handles {e:?}")
        }
    }
}

// User-mode JIT twins of the exports above (M5 step 2, PLAN.md §2 "JIT ABI").

/// Allocates a vCPU with a JIT (`mmu::Vcpu`: the `cpu::Cpu` at 0, with the
/// offsets of [`vcpu_new`], and the same user-process state) that compiles a
/// block after `threshold` dispatches, `batch` blocks per module, into a code
/// cache of `capacity` blocks (`capacity` ≥ `batch` ≥ 1), with the stale-code
/// checker if `check` ≠ 0 (ABI 11), and a loop head's region after
/// `region_after` entries of the head compiled alone (0: at once; ABI 17).
#[unsafe(no_mangle)]
pub extern "C" fn jit_new(
    threshold: u32,
    batch: u32,
    capacity: u32,
    check: u32,
    region_after: u32,
) -> *mut mmu::Vcpu {
    let mut v = mmu::Vcpu::new(cpu::Cpu::default());
    v.jit.cache = Some(Box::new(jit::Cache::new(jit::Config {
        threshold,
        batch,
        capacity,
        check: check != 0,
        region_after,
    })));
    Box::into_raw(v)
}

/// [`interp_run`] through the JIT.
///
/// # Safety
/// `v` comes from [`jit_new`], `mem` from [`mem_new`]; nothing else uses `v` meanwhile.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn jit_run(v: *mut mmu::Vcpu, mem: *const mem::Mem, n: u64) -> u64 {
    // SAFETY: guaranteed by the caller.
    unsafe { jit::run(v, &*mem, n) }.0
}

/// [`interp_run_exit`] through the JIT.
///
/// # Safety
/// As for [`jit_run`]; `exit` as for [`interp_run_exit`].
#[unsafe(no_mangle)]
pub unsafe extern "C" fn jit_run_exit(
    v: *mut mmu::Vcpu,
    mem: *const mem::Mem,
    n: u64,
    exit: *mut [u64; 2],
) -> u64 {
    // SAFETY: guaranteed by the caller.
    let (done, r) = unsafe { jit::run(v, &*mem, n) };
    // SAFETY: guaranteed by the caller.
    unsafe { *exit = exit_code(r) };
    done
}

/// Drops every compiled block, for hosts that rewrite guest code between runs.
///
/// # Safety
/// As for [`jit_run`].
#[unsafe(no_mangle)]
pub unsafe extern "C" fn jit_flush(v: *mut mmu::Vcpu) {
    // SAFETY: guaranteed by the caller.
    if let Some(c) = unsafe { &mut *v }.jit.cache.as_deref_mut() {
        c.flush();
    }
}

/// The JIT's counts (`jit::Stats`, u64s: blocks, modules, bytes, compile ns,
/// steps in JIT code, dispatches, invalidations, flushes, instructions
/// compiled inline and as helper calls, inline instructions run, then the
/// static flag counts: setters stored and elided, conditions direct, computed
/// and from memory).
///
/// # Safety
/// As for [`jit_run`].
#[unsafe(no_mangle)]
pub unsafe extern "C" fn jit_stats(v: *const mmu::Vcpu) -> *const jit::Stats {
    // SAFETY: guaranteed by the caller.
    unsafe { &*v }
        .jit
        .cache
        .as_deref()
        .map_or(core::ptr::null(), |c| &c.stats)
}

/// The JIT's helper calls so far by instruction class (ABI 18, M5 step 10):
/// a NUL-terminated `<Op> <calls>` line each, most frequent first, valid until
/// the next call; null without a JIT. `v` is a [`jit_new`] vCPU or a VM's
/// ([`vm_cpu`]: the `Cpu` is at the vCPU's start).
///
/// # Safety
/// As for [`jit_run`], or `v` from [`vm_cpu`] while the VM isn't running.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn jit_helper_report(v: *mut mmu::Vcpu) -> *const u8 {
    // SAFETY: guaranteed by the caller.
    unsafe { &mut *v }
        .jit
        .cache
        .as_deref_mut()
        .map_or(core::ptr::null(), |c| c.helper_report())
}

// The whole-VM ABI (PLAN.md §2 "Host ABI for a whole VM"). Every `vm` argument
// comes from `vm_new` and isn't used by two calls at once; the pointers the
// getters return stay valid until `vm_free`.

/// Creates a VM with `ram_size` bytes of RAM at `ram` (layout A: after the
/// core's heap), which appears at guest PA 0x4000_0000. The vCPU starts in its
/// EL1 reset state at the start of RAM, with a virtio-mmio transport per
/// `cfg.devices` entry. `cfg.deterministic` = 0 selects realtime mode, where the
/// core calls its `env.now_ms` import (`performance.now`). Returns null if `cfg`
/// doesn't match `ram_size`, has more than 32 or invalid device entries
/// (`virtio::DeviceEntry::valid`), or `ram` isn't 16-byte aligned.
///
/// # Safety
/// `cfg` points at a `VmConfig`, and `cfg.devices` at `cfg.ndevices` entries;
/// `ram..ram + ram_size` is as for [`mem::Mem::new`].
#[unsafe(no_mangle)]
pub unsafe extern "C" fn vm_new(
    ram: *mut u8,
    ram_size: u64,
    cfg: *const vm::VmConfig,
) -> *mut vm::Vm {
    // SAFETY: guaranteed by the caller.
    let cfg = unsafe { *cfg };
    if cfg.ram_size != ram_size
        || !(ram as usize).is_multiple_of(16)
        || cfg.ndevices > virtio::MAX_DEVICES as u64
        || (cfg.fb_width | cfg.fb_height != 0 && boot::framebuffer(&cfg).is_none())
    {
        return core::ptr::null_mut();
    }
    let devices = match cfg.ndevices {
        0 => &[][..],
        // SAFETY: guaranteed by the caller.
        n => unsafe { core::slice::from_raw_parts(cfg.devices as usize as *const _, n as usize) },
    };
    if !devices.iter().all(virtio::DeviceEntry::valid) {
        return core::ptr::null_mut();
    }
    // SAFETY: guaranteed by the caller, alignment checked above.
    let mem = unsafe { mem::Mem::new(ram, ram_size) };
    Box::into_raw(Box::new(vm::Vm::with_devices(mem, cfg, devices)))
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

/// Boots the arm64 `Image` (or, without its header, a raw binary entered at
/// its first byte) the host copied to guest PA `kernel_pa`, with the
/// initrd at `initrd_pa` (`initrd_len` 0 for none) and the kernel command line
/// at `cmdline_ptr` (UTF-8, `cmdline_len` bytes, in linear memory). The core
/// writes the DTB into the top 2 MiB of RAM, which the host leaves free, and
/// sets x0 and the PC (booting.rst). Returns 0, or 1 if the Image is
/// misaligned or the layout is invalid.
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

/// The signal word (`vm::SIGNAL_STOP`, `vm::SIGNAL_RX`, `vm::SIGNAL_DEVICE`), set from any thread.
///
/// # Safety
/// See the note above [`vm_new`].
#[unsafe(no_mangle)]
pub unsafe extern "C" fn vm_signal(vm: *const vm::Vm) -> *const AtomicU32 {
    // SAFETY: guaranteed by the caller.
    &unsafe { &*vm }.shared.signal
}

/// Virtio transport `i`'s shared block (`virtio::DevShared`: events, status,
/// features, epoch, config space, request and completion rings), usable from
/// any thread; null if there's no device `i`.
///
/// # Safety
/// See the note above [`vm_new`].
#[unsafe(no_mangle)]
pub unsafe extern "C" fn vm_device(vm: *const vm::Vm, i: u32) -> *const virtio::DevShared {
    // SAFETY: guaranteed by the caller.
    unsafe { &*vm }
        .shared
        .devices
        .get(i as usize)
        .map_or(core::ptr::null(), |d| d)
}

/// The framebuffer's guest PA (`boot::framebuffer`: x8r8g8b8, `fb_width` ×
/// `fb_height` packed rows, in guest RAM), or 0 without one (ABI 8).
///
/// # Safety
/// See the note above [`vm_new`].
#[unsafe(no_mangle)]
pub unsafe extern "C" fn vm_framebuffer(vm: *const vm::Vm) -> u64 {
    // SAFETY: guaranteed by the caller.
    boot::framebuffer(&unsafe { &*vm }.cfg).map_or(0, |f| f.0)
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

// JIT plumbing (M5 step 1), for tests/jit.test.ts and bench/jit.

/// Emits [`jit::add_module`] (X`reg` += `imm`) and installs it at JIT slot
/// `slot`; returns its table index, or -1 without a JIT host.
#[unsafe(no_mangle)]
pub extern "C" fn jit_add_install(reg: u32, imm: i64, slot: u32) -> i32 {
    jit::install(&jit::add_module(reg, imm), slot).map_or(-1, |i| i as i32)
}

/// Makes `n` calls on `cpu` through one call site, cycling over the blocks at
/// table indexes `idx..idx + k`; returns the sum of their results.
///
/// # Safety
/// `cpu` comes from [`vcpu_new`] or [`vm_cpu`]; each index from [`jit_add_install`].
#[unsafe(no_mangle)]
pub unsafe extern "C" fn jit_call(cpu: *mut cpu::Cpu, idx: u32, k: u32, n: u32) -> u32 {
    let (mut s, mut j) = (0u32, 0);
    for _ in 0..n {
        // SAFETY: guaranteed by the caller.
        s = s.wrapping_add(unsafe { jit::block(idx + j)(cpu.cast(), 0, 1) });
        j = if j + 1 == k { 0 } else { j + 1 };
    }
    s
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
