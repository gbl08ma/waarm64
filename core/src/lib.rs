//! waarm64 core: AArch64 CPU, MMU, JIT and platform devices.
//!
//! The crate builds natively (for tests) and for wasm32 with shared imported
//! memory and atomics.

#![cfg_attr(target_arch = "wasm32", feature(stdarch_wasm_atomic_wait))]
// `diag`'s message for an allocation that failed.
#![feature(alloc_error_hook)]

pub mod boot;
pub mod codec;
pub mod cpu;
pub mod crypto;
pub mod decode;
pub mod diag;
pub mod fdt;
pub mod flash;
pub mod fp;
pub mod fw_cfg;
pub mod gicv3;
pub mod interp;
pub mod jit;
pub mod mem;
pub mod mmu;
pub mod pl011;
pub mod pl031;
pub mod rng;
pub mod smbios;
pub mod snapshot;
pub mod virtio;
pub mod vm;
pub mod xhci;

use core::sync::atomic::{AtomicU32, AtomicUsize, Ordering};

/// Bumped when the host/core ABI changes.
pub const ABI_VERSION: u32 = 70;

#[unsafe(no_mangle)]
pub extern "C" fn abi_version() -> u32 {
    ABI_VERSION
}

/// The core's allocator, counting what it holds (ABI 45, [`heap_stats`]): the
/// system allocator (dlmalloc on wasm32, its state in the shared memory, so
/// every instance on it counts in the same words) with the bytes live and
/// their high-water mark beside it. The allocator keeps what it frees, so the
/// mark is about what the heap has made resident (docs/jit.md "The page's
/// memory signal").
struct Counting;

static HEAP_LIVE: AtomicUsize = AtomicUsize::new(0);
static HEAP_PEAK: AtomicUsize = AtomicUsize::new(0);

// SAFETY: every call goes to the system allocator as is; the counts are only counts.
unsafe impl std::alloc::GlobalAlloc for Counting {
    unsafe fn alloc(&self, l: std::alloc::Layout) -> *mut u8 {
        // SAFETY: the caller's contract, passed on.
        let p = unsafe { std::alloc::System.alloc(l) };
        if !p.is_null() {
            counted(l.size() as isize);
        }
        p
    }
    unsafe fn alloc_zeroed(&self, l: std::alloc::Layout) -> *mut u8 {
        // SAFETY: the caller's contract, passed on.
        let p = unsafe { std::alloc::System.alloc_zeroed(l) };
        if !p.is_null() {
            counted(l.size() as isize);
        }
        p
    }
    unsafe fn dealloc(&self, p: *mut u8, l: std::alloc::Layout) {
        // SAFETY: the caller's contract, passed on.
        unsafe { std::alloc::System.dealloc(p, l) };
        counted(-(l.size() as isize));
    }
    unsafe fn realloc(&self, p: *mut u8, l: std::alloc::Layout, size: usize) -> *mut u8 {
        // SAFETY: the caller's contract, passed on.
        let q = unsafe { std::alloc::System.realloc(p, l, size) };
        if !q.is_null() {
            counted(size as isize - l.size() as isize);
        }
        q
    }
}

fn counted(d: isize) {
    if d >= 0 {
        let live = HEAP_LIVE.fetch_add(d as usize, Ordering::Relaxed) + d as usize;
        if live > HEAP_PEAK.load(Ordering::Relaxed) {
            HEAP_PEAK.fetch_max(live, Ordering::Relaxed);
        }
    } else {
        HEAP_LIVE.fetch_sub(d.unsigned_abs(), Ordering::Relaxed);
    }
}

#[global_allocator]
static ALLOC: Counting = Counting;

/// The heap's live bytes and their high-water mark ([`heap_stats`]).
pub(crate) fn heap() -> (usize, usize) {
    (
        HEAP_LIVE.load(Ordering::Relaxed),
        HEAP_PEAK.load(Ordering::Relaxed),
    )
}

/// The core's heap (ABI 45): writes the bytes its allocations hold now and
/// their high-water mark since [`heap_reserve`] (or the start) to `out[0..2]`.
///
/// # Safety
/// `out` points at two writable u64s.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn heap_stats(out: *mut u64) {
    // SAFETY: guaranteed by the caller.
    let out = unsafe { core::slice::from_raw_parts_mut(out, 2) };
    out[0] = HEAP_LIVE.load(Ordering::Relaxed) as u64;
    out[1] = HEAP_PEAK.load(Ordering::Relaxed) as u64;
}

/// Allocates `size` bytes aligned to `align` (a power of two) from the core's
/// shared heap, for a new core instance's stack and TLS block (ABI 20, docs/abi.md
/// "Many core instances on one memory"); null if that fails. Never freed.
#[unsafe(no_mangle)]
pub extern "C" fn thread_alloc(size: usize, align: usize) -> *mut u8 {
    match std::alloc::Layout::from_size_align(size.max(1), align) {
        // SAFETY: the layout has a non-zero size.
        Ok(l) => unsafe { std::alloc::alloc_zeroed(l) },
        Err(_) => core::ptr::null_mut(),
    }
}

/// Makes the core's heap hold the rest of a memory of `pages` 64 KiB pages
/// (ABI 32, docs/abi.md "A fixed-size memory"): allocates one block that grows
/// the memory to within a page or two of `pages`, and frees it. The allocator
/// keeps freed memory (it can't shrink a wasm memory), so later allocations
/// come from it and never grow the memory again; the block's pages stay
/// untouched until used. Returns the memory's pages after, or 0 if `pages`
/// leaves no room or the allocation fails.
#[unsafe(no_mangle)]
pub extern "C" fn heap_reserve(pages: u32) -> u32 {
    #[cfg(target_arch = "wasm32")]
    {
        let have = core::arch::wasm32::memory_size(0) as u32;
        // Two pages short: the allocator rounds its request up to a page with its own overhead.
        let Some(n) = pages.checked_sub(have + 2).filter(|&n| n > 0) else {
            return 0;
        };
        let Ok(l) = std::alloc::Layout::from_size_align(n as usize * 65536, 16) else {
            return 0;
        };
        // SAFETY: the layout has a non-zero size; the block is freed with it at once.
        unsafe {
            // Opaque, or LLVM drops an allocation nothing uses.
            let p = core::hint::black_box(std::alloc::alloc(l));
            if p.is_null() {
                return 0;
            }
            std::alloc::dealloc(p, l);
        }
        // The reserve's block isn't the heap's use: the mark starts after it.
        HEAP_PEAK.store(HEAP_LIVE.load(Ordering::Relaxed), Ordering::Relaxed);
        core::arch::wasm32::memory_size(0) as u32
    }
    #[cfg(not(target_arch = "wasm32"))]
    {
        let _ = pages;
        0
    }
}

/// Allocates `size` bytes infallibly and frees them (ABI 50; tests/heap.test.ts): a size the heap can't hold
/// reaches the allocation error hook, which records its message and traps, as a full heap does.
#[unsafe(no_mangle)]
pub extern "C" fn heap_probe(size: usize) {
    // Opaque, or LLVM drops an allocation nothing uses.
    core::hint::black_box(Vec::<u8>::with_capacity(size));
}

/// Counts calls in a thread-local: each instance's first call returns 1 when
/// its TLS block is its own (the multi-instance test's check of `__wasm_init_tls`).
#[unsafe(no_mangle)]
pub extern "C" fn tls_probe() -> u32 {
    thread_local!(static CALLS: core::cell::Cell<u32> = const { core::cell::Cell::new(0) });
    CALLS.with(|c| {
        c.set(c.get() + 1);
        c.get()
    })
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
    interp::debug::arm(cpu); // as `rearm`
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
    interp::debug::arm(cpu); // as `rearm`
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
        Err(
            e @ (Exit::Resync
            | Exit::Invalidate(_)
            | Exit::Wfi
            | Exit::Wfe
            | Exit::Sev(_)
            | Exit::TlbiIs(..)),
        ) => {
            unreachable!("run handles {e:?}")
        }
    }
}

// User-mode JIT twins of the exports above (M5 step 2, docs/jit.md).

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
    v.jit.cache = Some(Box::new(jit::Jit::new(jit::Cache::new(jit::Config {
        threshold,
        threshold_max: threshold,
        batch,
        capacity,
        max_bytes: u64::MAX,
        check: check != 0,
        region_after,
        pages: 0,
        spill: [0; crate::mem::MAX_SPILL],
        decoded: interp::block::MAX_BUDGET as u32,
        warm: 0,
        fma: false,
    }))));
    Box::into_raw(v)
}

/// A [`jit_new`] vCPU's `VmConfig.fma` (ABI 58): what it compiles from now on uses the host's fused `madd`, or the
/// emulation. Set before its first run.
///
/// # Safety
/// `v` comes from [`jit_new`]; nothing else uses it meanwhile.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn jit_fma(v: *mut mmu::Vcpu, on: u32) {
    // SAFETY: the caller's contract: `v` is a live vCPU no one else is using.
    let v = unsafe { &mut *v };
    if let Some(j) = v.jit.cache.as_mut() {
        j.set_fma(on != 0);
    }
}

/// Compiles a user-mode vCPU's blocks as parallel SMP's (`cpu::FEATURE_PARALLEL`
/// in the cache's features; the host sets it in `Cpu.features` too), before
/// its first run. For the differential test (ABI 64).
///
/// # Safety
/// As for [`jit_fma`].
#[unsafe(no_mangle)]
pub unsafe extern "C" fn jit_parallel(v: *mut mmu::Vcpu, on: u32) {
    // SAFETY: the caller's contract: `v` is a live vCPU no one else is using.
    if let Some(j) = unsafe { &mut *v }.jit.cache.as_mut() {
        j.set_parallel(on != 0);
    }
}

/// Sets a user-mode vCPU's [`jit::State::unmask`] (as a run loop does before
/// a chunk): with `ok` nonzero, an MSR that unmasks IRQs stays inline while
/// the bytes at `irq` (every block's: round-robin's signal word, parallel
/// SMP's IRQ line) and `pending` (parallel SMP's blocks') are zero (wasm
/// addresses). For the differential test (docs/abi.md, ABI 64).
///
/// # Safety
/// As for [`jit_fma`]; `irq` and `pending` are addresses of live bytes while it's set.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn jit_unmask(v: *mut mmu::Vcpu, ok: u32, irq: u32, pending: u32) {
    // SAFETY: the caller's contract: `v` is a live vCPU no one else is using.
    unsafe { &mut *v }.jit.unmask = jit::Unmask { ok, irq, pending };
}

/// [`interp_run`] through the JIT.
///
/// # Safety
/// `v` comes from [`jit_new`], `mem` from [`mem_new`]; nothing else uses `v` meanwhile.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn jit_run(v: *mut mmu::Vcpu, mem: *const mem::Mem, n: u64) -> u64 {
    // SAFETY: guaranteed by the caller.
    unsafe { rearm(v) };
    // SAFETY: guaranteed by the caller.
    unsafe { jit::run(v, &*mem, n) }.0
}

/// The dispatcher's state derived again (`interp::debug::arm`): the host
/// writes `Cpu` fields such as SCTLR_EL1 and PSTATE directly between runs
/// (`interp_run` and `interp_run_exit` too, so the differential tests'
/// `Cpu`s agree).
///
/// # Safety
/// As for [`jit_run`].
unsafe fn rearm(v: *mut mmu::Vcpu) {
    // SAFETY: guaranteed by the caller.
    interp::debug::arm(unsafe { &mut (*v).cpu });
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
    unsafe { rearm(v) };
    // SAFETY: guaranteed by the caller.
    let (done, r) = unsafe { jit::run(v, &*mem, n) };
    // SAFETY: guaranteed by the caller.
    unsafe { *exit = exit_code(r) };
    done
}

/// Drops every compiled and decoded block, for hosts that rewrite guest code
/// between runs.
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
/// and from memory; blocks in regions, back-edges, tier-ups, stale blocks
/// tolerated; steps in the block interpreter, blocks it decoded, times its
/// cache started over: ABI 33).
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
        .map_or(core::ptr::null(), |j| &j.table.stats)
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
        .map_or(core::ptr::null(), |j| j.table.helper_report())
}

// The whole-VM ABI (docs/abi.md). Every `vm` argument
// comes from `vm_new` and isn't used by two calls at once; the pointers the
// getters return stay valid until `vm_free`.

/// Creates a VM with `ram_size` bytes of RAM at `ram` (layout A: after the
/// core's heap), which appears at guest PA 0x4000_0000. The vCPU starts in its
/// EL1 reset state at the start of RAM, with a virtio-mmio transport per
/// `cfg.devices` entry. `cfg.deterministic` = 0 selects realtime mode, where the
/// core calls its `env.now_ms` import (`performance.now`). Returns null if `cfg`
/// doesn't match `ram_size`, has more than 32 or invalid device entries
/// (`virtio::DeviceEntry::valid`), an invalid firmware configuration or
/// fw_cfg buffer (ABI 29), or `ram` isn't 16-byte aligned.
///
/// # Safety
/// `cfg` points at a `VmConfig`, `cfg.devices` at `cfg.ndevices` entries and
/// `cfg.fw_cfg` at `cfg.fw_cfg_len` bytes; `ram..ram + ram_size` is as for [`mem::Mem::new`].
#[unsafe(no_mangle)]
pub unsafe extern "C" fn vm_new(
    ram: *mut u8,
    ram_size: u64,
    cfg: *const vm::VmConfig,
) -> *mut vm::Vm {
    diag::install_panic_hook();
    // SAFETY: guaranteed by the caller.
    let cfg = unsafe { *cfg };
    if cfg.ram_size != ram_size
        || !(ram as usize).is_multiple_of(16)
        || cfg.ndevices > virtio::MAX_DEVICES as u64
        || cfg.features & !cpu::FEATURES != 0
        || !cfg.valid_smp()
        || !cfg.valid_firmware()
        || cfg.mem_pages > 65536
        || !cfg.valid_xhci()
        || !cfg.valid_spill()
        || !cfg.valid_window()
        // Natively the spill memories and the window's memory 1 are pointers only a Rust caller has.
        || (cfg!(not(target_arch = "wasm32")) && cfg.memory_sizes()[0] != 0)
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
    let buf = match cfg.fw_cfg_len {
        0 => &[][..],
        // SAFETY: guaranteed by the caller.
        n => unsafe { core::slice::from_raw_parts(cfg.fw_cfg as usize as *const u8, n as usize) },
    };
    let Some(fw_cfg) = fw_cfg::FwCfg::parse(buf)
        .map(|f| smbios::with(&cfg, f))
        .and_then(fw_cfg::FwCfg::new)
    else {
        return core::ptr::null_mut();
    };
    // SAFETY: guaranteed by the caller, alignment checked above.
    let spill: Vec<_> = cfg
        .spill_layout()
        .into_iter()
        .enumerate()
        .map(|(k, (phys, size))| mem::Spill {
            phys,
            size,
            off: if k == 0 { cfg.spill_at() } else { 0 },
            base: core::ptr::null_mut(),
        })
        .collect();
    // SAFETY: the host made memory k + 1 `memory_sizes()[k]` bytes (ABI 39, 55): node 1's RAM and the window in
    // memory 1 at their offsets.
    let mem = unsafe {
        let mem = mem::Mem::new(ram, ram_size)
            .at(vm::RAM_BASE)
            .with_spill(&spill);
        match cfg.window_layout() {
            Some((phys, size)) => mem.with_window(mem::Spill {
                phys,
                size,
                off: cfg.window_at,
                base: core::ptr::null_mut(),
            }),
            None => mem,
        }
    };
    let mut vm = vm::Vm::with_devices(mem, cfg, devices);
    if cfg.firmware() {
        vm.plat.get_mut().fw_cfg = Some(fw_cfg);
    }
    Box::into_raw(Box::new(vm))
}

/// The firmware configuration's flash bank (ABI 29): `VmConfig.flash_size`
/// bytes, erased by `vm_new`, which the host fills with the saved variable
/// store before the first run and reads back to save it (between runs, or
/// once the vCPUs stopped); null without one.
///
/// # Safety
/// See the note above [`vm_new`].
#[unsafe(no_mangle)]
pub unsafe extern "C" fn vm_flash(vm: *mut vm::Vm) -> *mut u8 {
    // SAFETY: guaranteed by the caller.
    let vm = unsafe { &mut *vm };
    vm.plat
        .get_mut()
        .flash
        .as_mut()
        .map_or(core::ptr::null_mut(), |f| f.as_mut_ptr())
}

/// # Safety
/// `vm` comes from [`vm_new`] and is not used again.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn vm_free(vm: *mut vm::Vm) {
    // SAFETY: guaranteed by the caller.
    drop(unsafe { Box::from_raw(vm) });
}

/// vCPU `i`'s registers (the `cpu::Cpu` offsets, as for [`vcpu_new`]; ABI 22
/// added `i`), or null past the last vCPU; the host may read and write them
/// between [`vm_run`] calls.
///
/// # Safety
/// See the note above [`vm_new`].
#[unsafe(no_mangle)]
pub unsafe extern "C" fn vm_cpu(vm: *mut vm::Vm, i: u32) -> *mut cpu::Cpu {
    // SAFETY: guaranteed by the caller.
    match unsafe { &mut *vm }.vcpus.get_mut(i as usize) {
        Some(v) => &mut v.cpu,
        None => core::ptr::null_mut(),
    }
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
/// Round-robin mode only (`VmConfig.smp` = 0).
///
/// # Safety
/// See the note above [`vm_new`].
#[unsafe(no_mangle)]
pub unsafe extern "C" fn vm_run(vm: *mut vm::Vm, budget: u64) -> u32 {
    // SAFETY: guaranteed by the caller.
    unsafe { &mut *vm }.run(budget)
}

/// The host-visible window's write-watch (ABI 53, `mem::Watch`: u32 words, docs/devices.md "virtio-gpu"), or null
/// without a window.
///
/// # Safety
/// See the note above [`vm_new`].
#[unsafe(no_mangle)]
pub unsafe extern "C" fn vm_window_watch(vm: *const vm::Vm) -> *const u32 {
    // SAFETY: guaranteed by the caller.
    match unsafe { &*vm }.mem.watch() {
        Some(w) => w.words() as *const u32,
        None => core::ptr::null(),
    }
}

/// Parallel mode (`VmConfig.smp` = 1, ABI 25): runs vCPU `cpu` on the calling
/// thread for at most `budget` of its steps; returns the exit kind, with the
/// details in [`vm_exit_cpu`]. Every vCPU has its own thread, and calls for
/// one vCPU always come from the same core instance (docs/abi.md). Past the
/// last vCPU, `vm::exit::STOP` at once (nothing runs).
///
/// # Safety
/// `vm` comes from [`vm_new`] and isn't freed meanwhile; no other thread runs
/// vCPU `cpu` at the same time, and nothing else (`vm_cpu`) uses it.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn vm_run_cpu(vm: *const vm::Vm, cpu: u32, budget: u64) -> u32 {
    // SAFETY: guaranteed by the caller.
    let vm = unsafe { &*vm };
    if cpu as usize >= vm.vcpus.len() {
        return vm::exit::STOP;
    }
    // SAFETY: guaranteed by the caller; `cpu` is a vCPU's.
    unsafe { vm.run_cpu(cpu as usize, budget) }
}

/// The last run's `vm::ExitInfo`: kind, steps, value, x0–x3, cpu, wake (u64
/// each); in parallel mode, vCPU 0's.
///
/// # Safety
/// See the note above [`vm_new`].
#[unsafe(no_mangle)]
pub unsafe extern "C" fn vm_exit(vm: *const vm::Vm) -> *const vm::ExitInfo {
    // SAFETY: guaranteed by the caller.
    let vm = unsafe { &*vm };
    if vm.parallel() {
        return vm.exit_of(0);
    }
    &vm.exit
}

/// vCPU `cpu`'s last exit in parallel mode (ABI 25), read by its thread
/// after [`vm_run_cpu`]; null past the last vCPU.
///
/// # Safety
/// See the note above [`vm_new`].
#[unsafe(no_mangle)]
pub unsafe extern "C" fn vm_exit_cpu(vm: *const vm::Vm, cpu: u32) -> *const vm::ExitInfo {
    // SAFETY: guaranteed by the caller.
    let vm = unsafe { &*vm };
    if cpu as usize >= vm.vcpus.len() {
        return core::ptr::null();
    }
    vm.exit_of(cpu as usize)
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

/// Parallel mode's steps between two publications of a vCPU's PC (ABI 34): short while the guest PC sampler runs
/// (web/profiler.ts), so a sample is at most that many instructions old; 0 restores the default (32768). Round-robin
/// is unaffected. Any thread.
///
/// # Safety
/// See the note above [`vm_new`].
#[unsafe(no_mangle)]
pub unsafe extern "C" fn vm_set_chunk(vm: *const vm::Vm, steps: u64) {
    // SAFETY: guaranteed by the caller.
    unsafe { &*vm }.shared.chunk.store(steps, Ordering::Relaxed);
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

/// vCPU `i`'s wake word (ABI 25): its thread sleeps on it after an `IDLE`
/// in parallel mode; bump and notify it after setting a signal bit. Null past
/// the last vCPU.
///
/// # Safety
/// See the note above [`vm_new`].
#[unsafe(no_mangle)]
pub unsafe extern "C" fn vm_cpu_signal(vm: *const vm::Vm, i: u32) -> *const AtomicU32 {
    // SAFETY: guaranteed by the caller.
    unsafe { &*vm }
        .shared
        .cpus
        .get(i as usize)
        .map_or(core::ptr::null(), |c| &c.wake)
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

/// The xHCI's shared block (`xhci::XhciShared`: events, request and
/// completion rings; ABI 38), usable from any thread; null without one
/// (`VmConfig.xhci` 0).
///
/// # Safety
/// See the note above [`vm_new`].
#[unsafe(no_mangle)]
pub unsafe extern "C" fn vm_xhci(vm: *const vm::Vm) -> *const xhci::XhciShared {
    // SAFETY: guaranteed by the caller.
    unsafe { &*vm }
        .shared
        .xhci
        .as_ref()
        .map_or(core::ptr::null(), |x| x)
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

/// vCPU `i`'s counters (`vm::Counters`, u64s; ABI 25 added `i`), read from
/// any thread with atomic loads; null past the last vCPU. Round-robin mode
/// counts everything in vCPU 0's; hosts sum the blocks.
///
/// # Safety
/// See the note above [`vm_new`].
#[unsafe(no_mangle)]
pub unsafe extern "C" fn vm_counters(vm: *const vm::Vm, i: u32) -> *const vm::Counters {
    // SAFETY: guaranteed by the caller.
    unsafe { &*vm }
        .shared
        .cpus
        .get(i as usize)
        .map_or(core::ptr::null(), |c| &c.counters)
}

/// The JIT code cache's gauge (ABI 45, `jit::Gauge`): `jit::GAUGE_WORDS` u64s
/// the core updates as it compiles and flushes (the live wasm bytes and
/// modules, the budget, the epochs, the host's limit; ABI 47: the block map's
/// keys and heap bytes, the module bytes held), read with atomic loads; null
/// without a JIT.
/// The words stay where they are for the VM's life.
///
/// # Safety
/// `vm` comes from [`vm_new`]; no vCPU runs (as for `vm_cpu`): the host asks once, before it starts them.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn vm_jit_gauge(vm: *const vm::Vm) -> *const u64 {
    // SAFETY: guaranteed by the caller.
    let vm = unsafe { &*vm };
    vm.vcpus[0]
        .jit
        .cache
        .as_ref()
        .map_or(core::ptr::null(), |j| j.gauge())
}

// Snapshots (ABI 30, docs/abi.md "M8 phase C: snapshots"). Each is called
// with every vCPU out of the core: between `vm_run` calls, or in parallel mode
// with every vCPU's thread out of `vm_run_cpu`.

/// The format version of a VM's saved state (`snapshot::VERSION`).
#[unsafe(no_mangle)]
pub extern "C" fn snapshot_version() -> u32 {
    snapshot::VERSION
}

/// Gets the VM ready to be saved: takes the completions the backends left
/// (clearing `SIGNAL_DEVICE`), as the run loop would at its next boundary.
/// Returns the size of the state in bytes; 0 if a device has something for
/// the host (the host serves the doorbell and calls again); `u64::MAX` if the
/// buffers the backends hold couldn't be posted again by a restore.
///
/// # Safety
/// See the note above [`vm_new`]; no vCPU is in the core.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn vm_snapshot_size(vm: *mut vm::Vm) -> u64 {
    // SAFETY: guaranteed by the caller.
    unsafe { &mut *vm }.snapshot_size()
}

/// Writes the VM's state (everything but guest RAM) at `ptr` and returns its
/// size; 0 if `len` is too small or a device isn't quiet
/// ([`vm_snapshot_size`]). The VM runs on afterwards, unchanged but for its realtime clock, which stands at the saved reading until a vCPU runs again.
///
/// # Safety
/// See the note above [`vm_new`]; no vCPU is in the core; `ptr..ptr + len` is
/// writable and outside guest RAM.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn vm_snapshot_save(vm: *mut vm::Vm, ptr: *mut u8, len: usize) -> u64 {
    // SAFETY: guaranteed by the caller.
    let Some(state) = unsafe { &mut *vm }.snapshot_save() else {
        return 0;
    };
    if state.len() > len {
        return 0;
    }
    // SAFETY: `ptr..ptr + len` is writable (the caller), and the state fits.
    unsafe { core::ptr::copy_nonoverlapping(state.as_ptr(), ptr, state.len()) };
    state.len() as u64
}

/// Restores the state at `ptr..ptr + len` into a VM fresh from [`vm_new`]
/// (not booted, never run) whose RAM the host has filled with the snapshot's.
/// Returns 0, or `snapshot::Error`: 1 not a state of this
/// [`snapshot_version`], 2 taken on another configuration, 3 truncated or
/// inconsistent. After an error the VM is only good for [`vm_free`]. The
/// chains the old backends held are in the request rings again
/// (`EV_REQUEST`): the host serves the doorbell before it runs the VM.
///
/// # Safety
/// See the note above [`vm_new`]; no vCPU is in the core; `ptr..ptr + len` is
/// readable.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn vm_snapshot_restore(vm: *mut vm::Vm, ptr: *const u8, len: usize) -> u32 {
    // SAFETY: guaranteed by the caller.
    let (vm, state) = unsafe { (&mut *vm, core::slice::from_raw_parts(ptr, len)) };
    vm.snapshot_restore(state).map_or_else(|e| e as u32, |()| 0)
}

// PSCI SYSTEM_SUSPEND (ABI 54, docs/abi.md "System suspend").

/// 1 if the guest is in PSCI SYSTEM_SUSPEND (every vCPU off until
/// [`vm_wake`]), else 0. From any thread.
///
/// # Safety
/// See the note above [`vm_new`].
#[unsafe(no_mangle)]
pub unsafe extern "C" fn vm_suspended(vm: *const vm::Vm) -> u32 {
    // SAFETY: guaranteed by the caller.
    unsafe { &*vm }.suspended() as u32
}

/// Wakes a guest in PSCI SYSTEM_SUSPEND: its vCPU resumes at the entry point
/// it gave, as from CPU_ON (parallel mode: its thread is woken; round-robin:
/// at the next [`vm_run`]). 1 if it was suspended, else 0. Parallel mode:
/// from any thread; round-robin: between [`vm_run`] calls.
///
/// # Safety
/// See the note above [`vm_new`].
#[unsafe(no_mangle)]
pub unsafe extern "C" fn vm_wake(vm: *const vm::Vm) -> u32 {
    // SAFETY: guaranteed by the caller.
    unsafe { &*vm }.wake_suspended() as u32
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
        s = s.wrapping_add(unsafe { jit::block(idx + j)(cpu.cast(), 0, 1, 0) });
        j = if j + 1 == k { 0 } else { j + 1 };
    }
    s
}

// The snapshot file's codec 2 (the LZ4 block format, lz4_flex) and its frames' CRC-32 ([`codec`]; docs/abi.md
// "SNAPZ: the snapshot codec and CRC"). No VM, no allocation: any instance on the memory, any bytes in it.

/// The worst-case compressed size of `len` bytes ([`codec::bound`]): `lz_compress` needs this much room.
#[unsafe(no_mangle)]
pub extern "C" fn lz_bound(len: usize) -> usize {
    codec::bound(len)
}

/// Compresses `len` bytes at `src` into `cap` bytes at `dst`; the compressed size, or 0 if `cap` is under
/// `lz_bound(len)`.
///
/// # Safety
/// `src` is readable for `len` bytes and `dst` writable for `cap` bytes, not overlapping, and
/// nothing else accesses them during the call.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn lz_compress(
    src: *const u8,
    len: usize,
    dst: *mut u8,
    cap: usize,
) -> usize {
    // SAFETY: guaranteed by the caller.
    let (s, d) = unsafe {
        (
            core::slice::from_raw_parts(src, len),
            core::slice::from_raw_parts_mut(dst, cap),
        )
    };
    codec::compress(s, d).unwrap_or(0)
}

/// Decompresses `len` bytes at `src` into `cap` bytes at `dst`; the decompressed size, or
/// `usize::MAX` if the input is malformed or doesn't fit.
///
/// # Safety
/// As [`lz_compress`].
#[unsafe(no_mangle)]
pub unsafe extern "C" fn lz_decompress(
    src: *const u8,
    len: usize,
    dst: *mut u8,
    cap: usize,
) -> usize {
    // SAFETY: guaranteed by the caller.
    let (s, d) = unsafe {
        (
            core::slice::from_raw_parts(src, len),
            core::slice::from_raw_parts_mut(dst, cap),
        )
    };
    codec::decompress(s, d).unwrap_or(usize::MAX)
}

/// The IEEE CRC-32 of `len` bytes at `src`, continued from `seed` (0 to start), as zlib's `crc32` ([`codec::crc32`]).
///
/// # Safety
/// `src` is readable for `len` bytes, which nothing writes during the call.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn crc32(seed: u32, src: *const u8, len: usize) -> u32 {
    // SAFETY: guaranteed by the caller.
    codec::crc32(seed, unsafe { core::slice::from_raw_parts(src, len) })
}

// qcow2's compressed clusters: raw deflate through miniz_oxide ([`codec`]; docs/abi.md "SNAPZ: qcow2's clusters
// through miniz_oxide"). No VM: any instance on the memory, any bytes in it.

/// Inflates the raw deflate stream at `src` (`len` bytes, the stream and anything after its end) into `cap` bytes at
/// `dst`; the bytes produced, or `usize::MAX` if it is malformed, truncated or wants more than `cap`
/// ([`codec::inflate_raw`]).
///
/// # Safety
/// As [`lz_compress`].
#[unsafe(no_mangle)]
pub unsafe extern "C" fn inflate_raw(
    src: *const u8,
    len: usize,
    dst: *mut u8,
    cap: usize,
) -> usize {
    // SAFETY: guaranteed by the caller.
    let (s, d) = unsafe {
        (
            core::slice::from_raw_parts(src, len),
            core::slice::from_raw_parts_mut(dst, cap),
        )
    };
    codec::inflate_raw(s, d).unwrap_or(usize::MAX)
}

/// Deflates `len` bytes at `src` into `cap` bytes at `dst` as one raw stream at miniz's `level` (0-10); the stream's
/// size, or 0 if it doesn't fit in `cap` ([`codec::deflate_raw`]). It allocates the compressor's tables and frees them.
///
/// # Safety
/// As [`lz_compress`].
#[unsafe(no_mangle)]
pub unsafe extern "C" fn deflate_raw(
    src: *const u8,
    len: usize,
    dst: *mut u8,
    cap: usize,
    level: u32,
) -> usize {
    // SAFETY: guaranteed by the caller.
    let (s, d) = unsafe {
        (
            core::slice::from_raw_parts(src, len),
            core::slice::from_raw_parts_mut(dst, cap),
        )
    };
    codec::deflate_raw(s, d, level).unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deflate_exports_are_total() {
        // The exports over garbage, every cap and level: a size within the cap, the failure value, never a panic.
        let mut x = 0x9e37_79b9_7f4a_7c15u64;
        let mut next = move || {
            x ^= x << 13;
            x ^= x >> 7;
            x ^= x << 17;
            x
        };
        let mut dst = vec![0u8; 70_000];
        for i in 0..3000 {
            let len = (next() % 5000) as usize;
            let src: Vec<u8> = (0..len)
                .map(|k| {
                    if i % 2 == 0 {
                        next() as u8
                    } else {
                        (k / 64) as u8
                    }
                })
                .collect();
            let cap = (next() % dst.len() as u64) as usize;
            let level = (next() % 12) as u32;
            // SAFETY: both slices are live, of those lengths, and don't overlap.
            let n = unsafe { deflate_raw(src.as_ptr(), len, dst.as_mut_ptr(), cap, level) };
            assert!(n <= cap);
            let packed = dst[..n].to_vec();
            // SAFETY: as above.
            let m = unsafe { inflate_raw(src.as_ptr(), len, dst.as_mut_ptr(), cap) };
            assert!(m == usize::MAX || m <= cap);
            if n > 0 {
                // SAFETY: as above.
                let back = unsafe { inflate_raw(packed.as_ptr(), n, dst.as_mut_ptr(), len) };
                assert_eq!(back, len, "{len} bytes at level {level}");
                assert!(dst[..len] == src[..]);
                if len > 0 {
                    // SAFETY: as above.
                    let short =
                        unsafe { inflate_raw(packed.as_ptr(), n, dst.as_mut_ptr(), len - 1) };
                    assert_eq!(short, usize::MAX);
                }
            }
        }
    }

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
