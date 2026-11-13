//! A whole VM: N vCPUs, RAM at `RAM_BASE`, the GICv3, the generic timer and the
//! PL011 (and in realtime mode the PL031 RTC) at QEMU `virt`'s addresses, and the run loop that delivers IRQs, waits
//! in WFI and answers PSCI. lib.rs exports it (docs/abi.md). The vCPUs run
//! round-robin on one thread (here), or in parallel, one thread each
//! (`parallel.rs`).
//!
//! **Time** is deterministic by default: the counter is `steps × ticks_per_insn`
//! plus the ticks WFI skipped, where steps are instructions retired and
//! exceptions taken. The loop runs the interpreter in chunks of at most `CHUNK`
//! steps, cut short at the next timer deadline, so a timer fires exactly on
//! time. Between chunks it checks the signal word, updates the interrupt lines
//! and takes a pending IRQ. Timer registers and `ISR_EL1` exit the interpreter
//! ([`Exit::Platform`]), so they see the exact count.
//!
//! In **realtime** mode the counter follows the host clock ([`Clock`]), read at
//! each chunk boundary and timer-register access, so timers fire within a chunk
//! of their deadline. A WFI with nothing to wake it returns [`exit::IDLE`] with
//! the time to the next deadline, and the host sleeps on the signal word.
//!
//! **Device MMIO** stays out of the interpreter's fast copies: an access to a
//! physical address that isn't RAM faults there, and the loop runs that one
//! instruction again through [`Io`], a third `Bus` that sends non-RAM accesses to
//! the devices. Handlers do all their reads before writing registers, so the
//! first, faulted attempt left nothing behind that matters.
//!
//! **virtio-mmio** transports (`virtio.rs`) sit in slots of QEMU `virt`'s
//! window; their backends are the host's. A register write that has news for
//! the host (a queue notify that posted requests, a status or config write)
//! ends the run with [`exit::DEVICE`]; completions come back through
//! `SIGNAL_DEVICE` and are drained at the next chunk boundary.

use core::cell::UnsafeCell;
use core::ops::{Deref, DerefMut};
use core::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};

use crate::cpu::{Cpu, PSTATE_I, sctlr};
use crate::flash::{FLASH, Flash};
use crate::fw_cfg::{FW_CFG, FwCfg};
use crate::gicv3::{self, Gicv3};
use crate::interp::debug::{self, Kind};
use crate::interp::{self, Exit, platform, sys, take_exception, take_irq};
use crate::jit;
use crate::mem::{Access, Fault, FaultKind, Mem};
use crate::mmu::{Bus, Mmu, Vcpu, walk};
use crate::pl011::{Pl011, Rings};
use crate::pl031::Pl031;
use crate::virtio::{self, DevShared, DeviceEntry, Transport};
use crate::xhci::{self, Xhci, XhciShared};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError, TryLockError};

mod parallel;
mod state;
pub use parallel::{notify, wait};

pub const RAM_BASE: u64 = 0x4000_0000;
pub const GICD: u64 = 0x0800_0000;
/// The GICv3 redistributors (QEMU `virt`'s), `gicv3::GICR_STRIDE` apart.
pub const GICR: u64 = 0x080a_0000;
/// The most vCPUs a VM may have: the GICv3 redistributor window (0x080a_0000
/// to 0x0900_0000 on `virt`) holds 123; GICv2 allows 8.
pub const MAX_CPUS: u64 = 123;
pub const UART: u64 = 0x0900_0000;
/// The PL031 RTC (realtime mode with `VmConfig.rtc`).
pub const RTC: u64 = 0x0901_0000;
/// INTIDs: the `arm,armv8-timer` PPIs on `virt` (virtual, physical) and SPI 1.
pub const IRQ_VTIMER: usize = 27;
pub const IRQ_PTIMER: usize = 30;
pub const IRQ_UART: usize = 33;
pub const IRQ_RTC: usize = 34;
/// Steps between signal checks. Deterministic guests can't tell chunk
/// boundaries apart (anything that makes an IRQ takeable ends a chunk: MSR or
/// ERET unmasking, but for an MSR the JIT keeps inline as no IRQ is pending
/// (`jit::Unmask`), MMIO, timer deadlines), so the size only trades realtime
/// latency against how long JIT loops run between returns (M6: 1024 → 32768,
/// Alpine −14% in Node; identical steps at 1024–131072).
const CHUNK: u64 = 32768;

/// A counter or a clock past this isn't one a VM reaches (centuries): a
/// restore refuses one, and deterministic time doesn't jump to a deadline
/// past it, which keeps the counter's arithmetic from overflowing.
const TIME_MAX: u64 = 1 << 62;

/// `repr(C)`, all u64 so the host can fill it with a `BigUint64Array`; new fields go at the end.
#[repr(C)]
#[derive(Clone, Copy, Debug)]
pub struct VmConfig {
    pub ram_size: u64,
    /// Non-zero: virtual time from the instruction count; 0: realtime (the host clock).
    pub deterministic: u64,
    /// CNTFRQ_EL0 in Hz; 0 means 62.5 MHz (QEMU's).
    pub cntfrq: u64,
    /// Counter ticks per step; 0 means 1.
    pub ticks_per_insn: u64,
    /// Address of `ndevices` `virtio::DeviceEntry`s, one per transport slot (ABI 6).
    pub devices: u64,
    pub ndevices: u64,
    /// A `simple-framebuffer` of this many pixels (x8r8g8b8), or none if 0
    /// (ABI 8); `boot::framebuffer` places it.
    pub fb_width: u64,
    pub fb_height: u64,
    /// 0 interpreter only; 1 JIT; 2 JIT-stress (`jit::Config::STRESS`) (ABI 10);
    /// 3 JIT-check (`jit::Config::CHECK`) (ABI 24); 4 the JIT's dispatcher
    /// without compiling, so the block interpreter (`jit::Config::INTERP`, ABI 33).
    pub jit: u64,
    /// Optional CPU features (`cpu::FEATURE_*`; ABI 19); 0, the default, is none.
    pub features: u64,
    /// vCPUs; 0 or 1 is one (ABI 21).
    pub ncpus: u64,
    /// The interrupt controller: 0 or 3, the GICv3 (the only one since ABI
    /// 23; ABI 21 also had 2, a GICv2).
    pub gic: u64,
    /// 0: the vCPUs take turns on the thread that calls `vm_run`; 1: parallel,
    /// one thread each through `vm_run_cpu` (realtime only; ABI 25).
    pub smp: u64,
    /// Unix time in ms at `vm_new`: a PL031 RTC counts from it (ABI 28); 0,
    /// or deterministic mode outside the firmware configuration, has none.
    pub rtc: u64,
    /// 1: the firmware configuration (ABI 29, docs/abi.md "M8 phase B"): a
    /// variable flash bank, fw_cfg, the PL031 always, `/memory` short of the
    /// framebuffer. 0: direct kernel boot.
    pub firmware: u64,
    /// The flash bank's bytes (firmware only; `flash::Flash::valid_size`).
    pub flash_size: u64,
    /// Address and length of the host's fw_cfg files (`fw_cfg::FwCfg::parse`), firmware only.
    pub fw_cfg: u64,
    pub fw_cfg_len: u64,
    /// The wasm memory's size in 64 KiB pages when the host has made it fixed
    /// (grown to its maximum, the core's heap reserved: ABI 32); JIT modules
    /// then import it with exact limits. 0: growable.
    pub mem_pages: u64,
    /// FEAT_RNG's key (`cpu::FEATURE_RNG`, ABI 35): 256 bits from the host's
    /// CSPRNG in realtime mode; deterministic mode ignores it and uses zeros
    /// (`rng`), so a run repeats exactly.
    pub rng_seed: [u64; 4],
    /// An xHCI (ABI 38, docs/usb.md): its USB 2 ports | USB 3 ports << 8,
    /// `xhci::CONFIG` (4 and 4) or 0, none.
    pub xhci: u64,
    /// The spill memories' sizes in bytes, memory 1 first (ABI 39,
    /// docs/spill-memories.md): RAM past memory 0, each in its own
    /// memory and a CPU-less NUMA node to the guest; the first 0 ends the
    /// list. Each a multiple of 64 KiB, at most 4 GiB; placed by [`VmConfig::spill_layout`].
    pub spill: [u64; crate::mem::MAX_SPILL],
    /// The JIT's code cache budget in wasm bytes (ABI 44, docs/jit.md
    /// "Memory"): the most its live modules may hold before a flush, for the
    /// default JIT (`jit` 1) and the block interpreter; 0 is
    /// `jit::MAX_BYTES`. A per-machine setting: V8 spends several times
    /// these bytes on their code and metadata.
    pub jit_bytes: u64,
    /// The host-visible window's bytes (ABI 53, docs/devices.md "virtio-gpu"): guest-physical memory right
    /// after RAM, outside the DT's `/memory`, that a transport whose entry has `shm` reports as its shared memory
    /// region 1 (Venus's blobs are mapped there). Its bytes are in memory 1 at `window_at`. A multiple of 2 MiB, at
    /// most `MAX_WINDOW`; 0: none.
    pub window: u64,
    /// Where the window's bytes start in memory 1 (ABI 55): past the bytes before it there (Venus's renderer:
    /// docs/devices.md "The host-visible window"); node 1's RAM, if any, follows the window there. A multiple of
    /// 64 KiB.
    pub window_at: u64,
    /// Non-zero: the host's relaxed-SIMD `madd` fuses in every tier (ABI 58, probed by `web/fma.ts`), and the JIT's FMA
    /// forms use it (docs/jit.md "Floating point"). 0: their emulation. Results, flags and steps are the same.
    pub fma: u64,
}

/// The largest host-visible window: Venus's (web/ram.ts `VENUS_WINDOW`, 1,280 MiB since GD G8) holds its device's
/// whole host-visible heap, since Linux places every mappable blob there while it lives.
pub const MAX_WINDOW: u64 = 2 << 30;

impl VmConfig {
    /// The host-visible window as (guest PA, size), if there is one: right after RAM (its bytes in memory 1).
    pub fn window_layout(&self) -> Option<(u64, u64)> {
        (self.window != 0).then(|| (RAM_BASE + self.ram_size, self.window))
    }

    /// Where node 1's RAM starts in memory 1: after the window, if there is one.
    pub fn spill_at(&self) -> u64 {
        if self.window != 0 {
            self.window_at + self.window
        } else {
            0
        }
    }

    /// The sizes of memories 1 and up in bytes (0: none): node 1's RAM after what memory 1 holds before it
    /// ([`VmConfig::spill_at`]), the other spill memories their RAM alone.
    pub fn memory_sizes(&self) -> [u64; crate::mem::MAX_SPILL] {
        let mut m = self.spill;
        if self.window != 0 {
            m[0] += self.spill_at();
        }
        m
    }

    /// No window, or one of whole 2 MiB units up to `MAX_WINDOW` after RAM of whole 64 KiB pages, at a whole
    /// 64 KiB page of memory 1 that holds it and node 1's RAM.
    pub fn valid_window(&self) -> bool {
        self.window == 0
            || (self.window.is_multiple_of(1 << 21)
                && self.window <= MAX_WINDOW
                && self.ram_size.is_multiple_of(1 << 16)
                && self.window_at.is_multiple_of(1 << 16)
                && self.window_at <= 1 << 32
                && self.spill_at() + self.spill[0] <= 1 << 32)
    }

    /// The spill memories as (guest PA, size): each starts at the 1 GiB
    /// boundary past the RAM before it, a hole between them, so no guest
    /// buffer is ever contiguous across two memories.
    pub fn spill_layout(&self) -> Vec<(u64, u64)> {
        let mut end = RAM_BASE + self.ram_size + self.window;
        self.spill
            .iter()
            .take_while(|&&n| n != 0)
            .map(|&n| {
                let pa = ((end >> 30) + 1) << 30;
                end = pa + n;
                (pa, n)
            })
            .collect()
    }

    /// Spill sizes in 64 KiB pages of at most 4 GiB, none after the first 0,
    /// and all of RAM within the PA size.
    pub fn valid_spill(&self) -> bool {
        let n = self.spill.iter().take_while(|&&n| n != 0).count();
        self.spill[n..].iter().all(|&s| s == 0)
            && self.spill[..n]
                .iter()
                .all(|&s| s.is_multiple_of(1 << 16) && s <= 1 << 32)
            && self
                .spill_layout()
                .last()
                .is_none_or(|&(pa, n)| pa + n <= 1 << crate::mmu::PA_BITS)
    }

    /// Whether the VM has the PL031 RTC: in realtime mode when the host
    /// passed its clock, and always in the firmware configuration.
    pub fn has_rtc(&self) -> bool {
        self.rtc != 0 && (self.deterministic == 0 || self.firmware())
    }

    /// Whether this is the firmware configuration (`firmware` = 1).
    pub fn firmware(&self) -> bool {
        self.firmware == 1
    }

    /// Whether `vm_new` accepts the firmware fields: the configuration with a
    /// valid flash and the RTC, or none of them.
    pub fn valid_firmware(&self) -> bool {
        match self.firmware {
            0 => self.flash_size == 0 && self.fw_cfg_len == 0,
            1 => crate::flash::Flash::valid_size(self.flash_size) && self.rtc != 0,
            _ => false,
        }
    }

    /// Whether `vm_new` accepts `xhci`: none, or the 4 + 4 ports built.
    pub fn valid_xhci(&self) -> bool {
        self.xhci == 0 || self.xhci == xhci::CONFIG
    }

    /// Whether `vm_new` accepts the GIC and CPU fields.
    pub fn valid_smp(&self) -> bool {
        matches!(self.gic, 0 | 3)
            && self.ncpus <= MAX_CPUS
            && (self.smp == 0 || self.smp == 1 && self.deterministic == 0)
    }
}

impl Default for VmConfig {
    fn default() -> Self {
        VmConfig {
            ram_size: 0,
            deterministic: 1,
            cntfrq: 62_500_000,
            ticks_per_insn: 1,
            devices: 0,
            ndevices: 0,
            fb_width: 0,
            fb_height: 0,
            jit: 0,
            features: 0,
            ncpus: 0,
            gic: 0,
            smp: 0,
            rtc: 0,
            firmware: 0,
            flash_size: 0,
            fw_cfg: 0,
            fw_cfg_len: 0,
            mem_pages: 0,
            rng_seed: [0; 4],
            xhci: 0,
            spill: [0; crate::mem::MAX_SPILL],
            jit_bytes: 0,
            window: 0,
            window_at: 0,
            fma: 0,
        }
    }
}

/// Exit kinds `Vm::run` returns.
pub mod exit {
    pub const BUDGET: u32 = 0;
    /// PSCI SYSTEM_OFF or SYSTEM_RESET, PC past the HVC; `ExitInfo.x` has x0–x3.
    pub const PSCI: u32 = 1;
    /// WFI with nothing that could wake it; the PC is on the WFI. `value` is
    /// the nanoseconds until the next timer deadline in realtime mode, or
    /// u64::MAX with none (always, in deterministic mode, which skips to deadlines).
    pub const IDLE: u32 = 2;
    /// A PL011 write found the TX ring full; the PC is on that store.
    pub const TX_FULL: u32 = 3;
    /// `value` is the `Op` index; the PC is on the instruction.
    pub const UNIMPLEMENTED: u32 = 4;
    pub const STOP: u32 = 5;
    /// A virtio transport has news for the host (`value` = slot | `virtio::EV_*` << 8;
    /// every device's pending events are in its `DevShared::events`). The PC is past the access.
    pub const DEVICE: u32 = 6;
}

/// Why `Vm::run` returned. `repr(C)`: kind, steps this run, value, x0–x3,
/// the vCPU that exited (ABI 22), its wake word as read before an `IDLE`
/// (parallel mode; ABI 25).
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct ExitInfo {
    pub kind: u64,
    pub retired: u64,
    pub value: u64,
    pub x: [u64; 4],
    pub cpu: u64,
    pub wake: u64,
}

/// Signal word bits.
pub const SIGNAL_STOP: u32 = 1;
pub const SIGNAL_RX: u32 = 2;
/// A backend posted completions.
pub const SIGNAL_DEVICE: u32 = 4;
// The signal word's bits are in its low byte (little-endian: the byte at its
// address), which an inline unmask reads (`jit::Unmask`).
const _: () = assert!((SIGNAL_STOP | SIGNAL_RX | SIGNAL_DEVICE) & !0xff == 0);

/// Written by the vCPU with relaxed stores, read by the host at any time.
/// `repr(C)`: steps, exceptions by EC, IRQs, the TLB counters (step 8), PC.
#[repr(C)]
pub struct Counters {
    pub retired: AtomicU64,
    pub exceptions: [AtomicU64; 64],
    pub irqs: AtomicU64,
    pub tlb_hits: AtomicU64,
    pub tlb_misses: AtomicU64,
    pub tlb_walks: AtomicU64,
    pub tlb_flushes: AtomicU64,
    pub pc: AtomicU64,
    /// `jit::Stats` (ABI 10): blocks compiled, modules, wasm bytes, compile ns,
    /// steps in JIT code, block calls, invalidations, cache flushes; ABI 12:
    /// instructions compiled inline and as helper calls, inline instructions run;
    /// ABI 13: lazy flag setters stored and elided, conditions direct, computed
    /// and from memory; ABI 15: blocks in the compiled regions; ABI 16:
    /// back-edges; ABI 17: tier-ups; ABI 25: stale blocks tolerated.
    pub jit: [AtomicU64; 20],
    /// Parallel SMP (ABI 26, `PAR_*`): DSBs that waited for TLBI IS and the
    /// ns they waited, TLBI IS broadcast and IC operations issued, queue drains that
    /// applied something, IDLE exits, platform-lock acquisitions that found
    /// it held and the ns they waited, WFEs (each ends the chunk), ns spent
    /// out of `vm_run_cpu` between runs (idle, or in the host).
    pub par: [AtomicU64; 10],
    /// The block interpreter (ABI 33, `jit::Stats`): instructions it ran,
    /// blocks it decoded, times its cache started over.
    pub dec: [AtomicU64; 3],
    /// The compile worker (ABI 36, `jit::Stats`): modules a table installed
    /// once the worker had compiled them, and ones it compiled itself after
    /// waiting [`jit::OVERDUE_NS`] for the worker; then (ABI 37) the times
    /// the host didn't have the worker's compiled module yet, and the runs
    /// that ended early for it to arrive.
    pub cw: [AtomicU64; 4],
    /// The JIT cache's lock (ABI 46, `jit::Stats`): acquisitions, contended
    /// ones, ns waited; ns emitting modules, of those under the lock, ns
    /// forming batches into regions; then (ABI 47) the block map's prunes,
    /// flushes for a heap without room for a map to grow, and flushes for a
    /// table that lacked modules whose bytes were dropped; the heap bytes the
    /// table's decoded blocks and its known blocks take.
    /// Then (ABI 48) the misses that found the lock held and didn't wait;
    /// (ABI 50) the ns the block map's prunes took.
    pub jx: [AtomicU64; 13],
}

/// Indexes into [`Counters::par`].
pub const PAR_DSB_WAITS: usize = 0;
pub const PAR_DSB_WAIT_NS: usize = 1;
pub const PAR_TLBI_IS: usize = 2;
pub const PAR_IC: usize = 3;
pub const PAR_DRAINS: usize = 4;
pub const PAR_IDLES: usize = 5;
pub const PAR_LOCK_CONTENDED: usize = 6;
pub const PAR_LOCK_WAIT_NS: usize = 7;
pub const PAR_WFES: usize = 8;
pub const PAR_OUT_NS: usize = 9;

impl Default for Counters {
    fn default() -> Self {
        let z = || AtomicU64::new(0);
        Counters {
            retired: z(),
            exceptions: [const { AtomicU64::new(0) }; 64],
            irqs: z(),
            tlb_hits: z(),
            tlb_misses: z(),
            tlb_walks: z(),
            tlb_flushes: z(),
            pc: z(),
            jit: [const { AtomicU64::new(0) }; 20],
            par: [const { AtomicU64::new(0) }; 10],
            dec: [const { AtomicU64::new(0) }; 3],
            cw: [const { AtomicU64::new(0) }; 4],
            jx: [const { AtomicU64::new(0) }; 13],
        }
    }
}

fn bump(a: &AtomicU64) {
    add(a, 1);
}

/// Adds to a counter only its own thread writes (a load and a store, no RMW).
fn add(a: &AtomicU64, n: u64) {
    a.store(a.load(Ordering::Relaxed) + n, Ordering::Relaxed);
}

/// What other threads touch while the vCPUs run. Behind a shared reference
/// (not inside the `&mut Vm`), so concurrent access through it is sound.
#[derive(Default)]
pub struct Shared {
    pub console: Rings,
    pub signal: AtomicU32,
    /// Parallel mode's chunk while profiling (`vm_set_chunk`): steps between two publications of a vCPU's PC; 0 is
    /// `CHUNK`. Round-robin keeps `CHUNK` (its chunks place interrupts, so its step counts would move).
    pub chunk: AtomicU64,
    /// One per vCPU.
    pub cpus: Vec<CpuShared>,
    /// One per virtio transport.
    pub devices: Vec<DevShared>,
    /// The xHCI's (`VmConfig.xhci`).
    pub xhci: Option<XhciShared>,
    /// When (ns) the xHCI next has completions to give (`Xhci::due`; u64::MAX: none), for the
    /// vCPUs' run loops to look at without the platform lock.
    pub xhci_due: AtomicU64,
    /// The guest is in PSCI SYSTEM_SUSPEND (`Platform::suspended`), for the host to read at any time.
    pub suspended: AtomicBool,
}

/// A vCPU's words other threads read or write.
#[derive(Default)]
pub struct CpuShared {
    /// Its wake word (parallel mode): a counter its thread sleeps on after
    /// `IDLE`, bumped and notified by whoever makes something it waits for
    /// true (docs/abi.md).
    pub wake: AtomicU32,
    /// Its counters; round-robin publishes all of them in vCPU 0's.
    pub counters: Counters,
    par: parallel::CpuPar,
}

/// A lock whose owner can also reach the data without locking (`&mut`).
/// Round-robin does that; parallel vCPUs lock.
pub struct Lock<T>(Mutex<T>);

impl<T> Lock<T> {
    pub fn new(t: T) -> Lock<T> {
        Lock(Mutex::new(t))
    }

    pub fn get_mut(&mut self) -> &mut T {
        self.0.get_mut().unwrap_or_else(PoisonError::into_inner)
    }

    pub fn lock(&self) -> MutexGuard<'_, T> {
        self.0.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// The lock if it's free.
    pub fn try_lock(&self) -> Option<MutexGuard<'_, T>> {
        match self.0.try_lock() {
            Ok(g) => Some(g),
            Err(TryLockError::Poisoned(e)) => Some(e.into_inner()),
            Err(TryLockError::WouldBlock) => None,
        }
    }
}

/// The devices every vCPU reaches (behind `Vm::plat`).
pub struct Platform {
    pub gic: Box<Gicv3>,
    pub uart: Pl011,
    pub virtio: Vec<Transport>,
    pub rtc: Option<Pl031>,
    /// The firmware configuration's variable store and fw_cfg.
    pub flash: Option<Flash>,
    pub fw_cfg: Option<FwCfg>,
    /// The xHCI (`VmConfig.xhci`).
    pub xhci: Option<Xhci>,
    /// Parallel mode: PSCI CPU_ON requests (entry, context) that their
    /// target's thread carries out.
    start: Vec<Option<(u64, u64)>>,
    /// PSCI SYSTEM_SUSPEND: the vCPU that called it (every other one is off),
    /// and where it resumes (entry, context) when the host wakes it.
    suspended: Option<(usize, u64, u64)>,
}

/// A vCPU. Round-robin reaches it through `&mut Vm`; in parallel mode only
/// the thread that runs it does ([`Vm::run_cpu`]), along with that thread's
/// own run state.
pub struct Slot {
    vcpu: UnsafeCell<Box<Vcpu>>,
    own: UnsafeCell<parallel::Own>,
}

// SAFETY: a vCPU is used by one thread at a time: the one with `&mut Vm`
// (round-robin, the host between runs), or in parallel mode the one thread
// that runs it (`Vm::run_cpu`'s contract); `Deref` is for the times when
// nothing runs it (docs/abi.md: `vm_cpu` between runs).
unsafe impl Sync for Slot {}
// SAFETY: as for `Sync`; the raw pointers in `Vcpu` (its `jit.mem`, its
// `tlb.published`) point at the VM's `Mem` and at an atomic in its `Shared`,
// which are `Send` and `Sync`.
unsafe impl Send for Slot {}

impl Slot {
    fn new(v: Box<Vcpu>) -> Slot {
        Slot {
            vcpu: UnsafeCell::new(v),
            own: UnsafeCell::new(parallel::Own::default()),
        }
    }

    /// The vCPU and its run state, for the thread that runs it.
    ///
    /// # Safety
    /// Only the one thread that runs this vCPU calls it, and doesn't hold
    /// another result of it.
    #[allow(clippy::mut_from_ref)]
    unsafe fn parts(&self) -> (&mut Vcpu, &mut parallel::Own) {
        // SAFETY: guaranteed by the caller.
        unsafe { (&mut *self.vcpu.get(), &mut *self.own.get()) }
    }
}

impl Deref for Slot {
    type Target = Vcpu;
    fn deref(&self) -> &Vcpu {
        // SAFETY: see `Sync` above: no thread runs the vCPU meanwhile.
        unsafe { &*self.vcpu.get() }
    }
}

impl DerefMut for Slot {
    fn deref_mut(&mut self) -> &mut Vcpu {
        self.vcpu.get_mut()
    }
}

/// A GIC register read at `pa` (the distributor or a redistributor): `None`
/// if no register is there or the size isn't allowed (an external abort).
fn gic_read(g: &Gicv3, pa: u64, size: u32) -> Option<u64> {
    match pa {
        GICD..0x0801_0000 => g.dist_read(pa - GICD, size),
        GICR..0x0900_0000 => g.redist_read(pa - GICR, size),
        _ => None,
    }
}

fn gic_write(g: &mut Gicv3, pa: u64, size: u32, v: u64) -> Option<()> {
    match pa {
        GICD..0x0801_0000 => g.dist_write(pa - GICD, size, v),
        GICR..0x0900_0000 => g.redist_write(pa - GICR, size, v),
        _ => None,
    }
}

/// Whether a vCPU is on (PSCI CPU_ON/CPU_OFF; only CPU 0 is on at boot).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Power {
    Off,
    On,
}

/// What an on vCPU is waiting for.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Wait {
    No,
    /// In WFI (the PC on it) until an interrupt is signaled to it.
    Wfi,
    /// Its WFI completes when it next runs: virtual time jumped to its deadline.
    Woken,
}

/// A vCPU's place in the run loop.
#[derive(Clone, Copy, Debug)]
struct Sched {
    power: Power,
    wait: Wait,
    /// The event register (SEV, SEVL; consumed by WFE).
    event: bool,
}

pub struct Vm {
    /// CPU *i* is `vcpus[i]` (MPIDR `gicv3::mpidr(i)`). Round-robin: the
    /// JIT (its table) lives in vCPU 0's `jit.cache` and moves to another
    /// vCPU while it runs a chunk (one table for every vCPU of the thread:
    /// block code takes the `Vcpu` pointer). Parallel: each has its own
    /// table, on the cache they share.
    pub vcpus: Vec<Slot>,
    /// Round-robin's scheduling state (parallel mode keeps its own in `Shared`).
    sched: Vec<Sched>,
    /// The vCPU running (or last run), and the steps left in its quantum
    /// (u64::MAX with one vCPU).
    cur: usize,
    quantum: u64,
    pub mem: Mem,
    pub plat: Lock<Platform>,
    pub shared: Arc<Shared>,
    /// Round-robin's last exit (parallel mode: each vCPU's own, `exit_of`).
    pub exit: ExitInfo,
    pub(crate) cfg: VmConfig,
    /// Steps of every vCPU (virtual time counts them all).
    steps: u64,
    /// Ticks WFI jumped over.
    skipped: u64,
    clock: Clock,
    /// Parallel mode: the latest counter value any vCPU read (it never goes back).
    last: AtomicU64,
    /// Parallel mode: how long a DSB waits for TLBI IS before it panics (a test lowers it).
    dsb_limit_ns: u64,
    /// The longest pass of a DSB wait that counts as waiting (a test lowers it).
    dsb_pass_max_ns: u64,
}

/// The host clock for realtime mode: `performance.now()` through the core's
/// `env.now_ms` import on wasm, `Instant` natively. A restored VM's clock
/// stands at its saved reading until a vCPU first runs (`start`), and so does a
/// saved VM's from the moment its state is taken (`hold`) until it runs on: the
/// host's work meanwhile (writing the file, spawning a restored VM's vCPU
/// workers) isn't the guest's time, and a guest that was waiting with a short
/// timeout would otherwise find it expired before it ran (ALSA's 100 ms wait for
/// a sound period: docs/audio.md "Linux driver behavior"). Both machines go on from the same instant.
struct Clock {
    /// When it started counting from `base`: `now_ms` as f64 bits on wasm,
    /// ns since `anchor` natively; `UNSTARTED` until then.
    t0: AtomicU64,
    #[cfg(not(target_arch = "wasm32"))]
    anchor: std::time::Instant,
    /// What it read when it last started: 0, a restored VM's saved time, or
    /// the reading it was held at (the counter continues from there).
    base: AtomicU64,
}

#[cfg(target_arch = "wasm32")]
#[link(wasm_import_module = "env")]
unsafe extern "C" {
    /// Milliseconds on a monotonic clock (the host passes `performance.now`).
    pub(crate) fn now_ms() -> f64;
}

impl Clock {
    const UNSTARTED: u64 = u64::MAX;

    /// A new VM's clock: 0, counting from now.
    fn new() -> Clock {
        let c = Clock::from(0);
        c.start();
        c
    }

    /// A restored VM's clock: it reads `base` ns until `start`.
    fn from(base: u64) -> Clock {
        Clock {
            t0: AtomicU64::new(Clock::UNSTARTED),
            #[cfg(not(target_arch = "wasm32"))]
            anchor: std::time::Instant::now(),
            base: AtomicU64::new(base),
        }
    }

    /// The host's time now, in `t0`'s form.
    fn host(&self) -> u64 {
        #[cfg(target_arch = "wasm32")]
        // SAFETY: a host function with no preconditions.
        return unsafe { now_ms() }.to_bits();
        #[cfg(not(target_arch = "wasm32"))]
        (self.anchor.elapsed().as_nanos() as u64)
    }

    /// Starts counting, if it hasn't yet (the first vCPU to run; the others find it started).
    fn start(&self) {
        if self.t0.load(Ordering::Relaxed) == Clock::UNSTARTED {
            let _ = self.t0.compare_exchange(
                Clock::UNSTARTED,
                self.host(),
                Ordering::AcqRel,
                Ordering::Acquire,
            );
        }
    }

    /// Stops it at its reading now, which it returns, until the next `start`.
    /// No vCPU runs meanwhile (a snapshot is taken with every vCPU out of the core).
    fn hold(&self) -> u64 {
        let ns = self.ns();
        self.base.store(ns, Ordering::Relaxed);
        self.t0.store(Clock::UNSTARTED, Ordering::Release);
        ns
    }

    /// Nanoseconds the VM has run for: since it started, on top of what
    /// it had already.
    fn ns(&self) -> u64 {
        let t0 = self.t0.load(Ordering::Acquire);
        let base = self.base.load(Ordering::Relaxed);
        if t0 == Clock::UNSTARTED {
            return base;
        }
        #[cfg(target_arch = "wasm32")]
        return base + ((f64::from_bits(self.host()) - f64::from_bits(t0)) * 1e6) as u64;
        #[cfg(not(target_arch = "wasm32"))]
        (base + (self.host() - t0))
    }
}

// PSCI 1.0 function IDs (SMC32 unless noted).
const PSCI_VERSION: u32 = 0x8400_0000;
const PSCI_CPU_OFF: u32 = 0x8400_0002;
const PSCI_CPU_ON: u32 = 0x8400_0003;
const PSCI_CPU_ON_64: u32 = 0xc400_0003;
const PSCI_AFFINITY_INFO: u32 = 0x8400_0004;
const PSCI_AFFINITY_INFO_64: u32 = 0xc400_0004;
const PSCI_MIGRATE_INFO_TYPE: u32 = 0x8400_0006;
const PSCI_SYSTEM_OFF: u32 = 0x8400_0008;
const PSCI_SYSTEM_RESET: u32 = 0x8400_0009;
const PSCI_FEATURES: u32 = 0x8400_000a;
const PSCI_SYSTEM_SUSPEND: u32 = 0x8400_000e;
const PSCI_SYSTEM_SUSPEND_64: u32 = 0xc400_000e;
// SMCCC 1.1 (same conduit): the version and the vulnerability workarounds.
const SMCCC_VERSION: u32 = 0x8000_0000;
const SMCCC_ARCH_FEATURES: u32 = 0x8000_0001;
const SMCCC_ARCH_WORKAROUND_1: u32 = 0x8000_8000;
const SMCCC_ARCH_WORKAROUND_2: u32 = 0x8000_7fff;
const SMCCC_ARCH_WORKAROUND_3: u32 = 0x8000_3fff;
/// SMCCC_RET_NOT_REQUIRED: the workaround isn't needed on this machine.
const SMCCC_NOT_REQUIRED: i64 = -2;
// PSCI return codes.
const PSCI_SUCCESS: i64 = 0;
const PSCI_NOT_SUPPORTED: i64 = -1;
const PSCI_INVALID_PARAMETERS: i64 = -2;
const PSCI_DENIED: i64 = -3;
const PSCI_ALREADY_ON: i64 = -4;

/// Steps each vCPU runs before the next one's turn (deterministic round-robin).
const QUANTUM: u64 = CHUNK;

impl Vm {
    /// A VM over `mem` (placed at `RAM_BASE`), with vCPU 0 in its reset state at
    /// the start of RAM and the others off. Zeroes in `cfg` pick the defaults.
    pub fn new(mem: Mem, cfg: VmConfig) -> Vm {
        Vm::with_devices(mem, cfg, &[])
    }

    /// As [`Vm::new`], with a virtio-mmio transport per entry (valid ones, `DeviceEntry::valid`).
    pub fn with_devices(mem: Mem, cfg: VmConfig, devices: &[DeviceEntry]) -> Vm {
        assert!(devices.len() <= virtio::MAX_DEVICES && devices.iter().all(DeviceEntry::valid));
        let d = VmConfig::default();
        let pick = |v, d| if v == 0 { d } else { v };
        let n = cfg.ncpus.max(1) as usize;
        let parallel = cfg.smp == 1;
        let features = cfg.features
            | crate::cpu::FEATURE_GICV3
            | if n > 1 { crate::cpu::FEATURE_SMP } else { 0 }
            | if parallel {
                crate::cpu::FEATURE_PARALLEL
            } else {
                0
            };
        let jit = match cfg.jit {
            0 => None,
            1 => Some(jit::Config::DEFAULT),
            3 => Some(jit::Config::CHECK),
            4 => Some(jit::Config::INTERP),
            _ => Some(jit::Config::STRESS),
        }
        .map(|c| jit::Config {
            // The machine's budget, for the modes with the default's (JIT-stress
            // and JIT-check keep theirs: they compile everything, unbounded).
            max_bytes: if cfg.jit_bytes != 0 && c.max_bytes == jit::MAX_BYTES {
                cfg.jit_bytes
            } else {
                c.max_bytes
            },
            pages: cfg.mem_pages as u32,
            spill: cfg.memory_sizes().map(|n| (n >> 16) as u32),
            // A table per vCPU in parallel SMP, one in round-robin.
            decoded: crate::interp::block::budget(if parallel { n } else { 1 }) as u32,
            fma: cfg.fma != 0,
            ..c
        });
        let mut vcpus: Vec<_> = (0..n)
            .map(|i| {
                let mut v = Vcpu::new(Cpu {
                    pc: RAM_BASE,
                    features,
                    mpidr: gicv3::mpidr(i),
                    ..Cpu::reset()
                });
                let seed = if cfg.deterministic != 0 {
                    [0; 4]
                } else {
                    cfg.rng_seed
                };
                v.rng = crate::rng::Rng::new(seed, i as u32);
                // One cache: round-robin's table lives in vCPU 0 (`Vm::chunk`).
                if i == 0 {
                    v.jit.cache = jit.map(|c| {
                        let mut cache = jit::Cache::new(c);
                        cache.features = features;
                        cache.tolerant = parallel;
                        Box::new(jit::Jit::new(cache))
                    });
                }
                Slot::new(v)
            })
            .collect();
        // Parallel: a table per vCPU (its worker's) on the same cache.
        if parallel {
            for i in 1..n {
                vcpus[i].jit.cache = vcpus[0].jit.cache.as_ref().map(|j| Box::new(j.join()));
            }
        }
        let off = Sched {
            power: Power::Off,
            wait: Wait::No,
            event: false,
        };
        let mut sched = vec![off; n];
        sched[0].power = Power::On;
        let shared = Arc::new(Shared {
            cpus: (0..n).map(|i| CpuShared::new(i == 0)).collect(),
            devices: devices.iter().map(|_| DevShared::default()).collect(),
            xhci: (cfg.xhci != 0).then(XhciShared::default),
            xhci_due: AtomicU64::new(u64::MAX),
            ..Shared::default()
        });
        if parallel {
            for (v, s) in vcpus.iter_mut().zip(&shared.cpus) {
                v.tlb.published = s.par.asid_word();
            }
        }
        Vm {
            vcpus,
            sched,
            cur: 0,
            quantum: if n > 1 { QUANTUM } else { u64::MAX },
            mem: {
                let mem = mem.at(RAM_BASE);
                assert!(
                    cfg.window_layout()
                        == mem
                            .window()
                            .map(|w| (w.phys, w.size))
                            .filter(|_| { mem.window().is_some_and(|w| w.off == cfg.window_at) }),
                    "the window doesn't match the configuration"
                );
                let mem = match cfg.window_layout() {
                    Some((pa, len)) if mem.watch().is_none() => mem.with_watch(pa, len, n),
                    _ => mem,
                };
                let want = cfg.spill_layout();
                assert!(
                    mem.spill().len() == want.len()
                        && mem
                            .spill()
                            .iter()
                            .zip(&want)
                            .zip(core::iter::once(cfg.spill_at()).chain(core::iter::repeat(0)))
                            .all(|((s, w), off)| (s.phys, s.size, s.off) == (w.0, w.1, off)),
                    "the spill memories don't match the configuration"
                );
                mem
            },
            plat: Lock::new(Platform {
                gic: Box::new(Gicv3::new(n)),
                uart: Pl011::default(),
                virtio: devices
                    .iter()
                    .map(|&e| Transport::new(e).with_window(cfg.window_layout()))
                    .collect(),
                rtc: cfg.has_rtc().then(|| Pl031::new(cfg.rtc)),
                flash: cfg.firmware().then(|| Flash::new(cfg.flash_size)),
                fw_cfg: cfg
                    .firmware()
                    .then(|| FwCfg::new(crate::smbios::with(&cfg, vec![])).unwrap()),
                // Realtime: a backend on its own thread may still write a cancelled TD's buffer.
                xhci: (cfg.xhci != 0).then(|| {
                    let mut x = Xhci::new();
                    x.fence = cfg.deterministic == 0;
                    x
                }),
                start: vec![None; n],
                suspended: None,
            }),
            shared,
            exit: ExitInfo::default(),
            cfg: VmConfig {
                cntfrq: pick(cfg.cntfrq, d.cntfrq),
                ticks_per_insn: pick(cfg.ticks_per_insn, d.ticks_per_insn),
                ..cfg
            },
            steps: 0,
            skipped: 0,
            clock: Clock::new(),
            last: AtomicU64::new(0),
            dsb_limit_ns: parallel::DSB_LIMIT_NS,
            dsb_pass_max_ns: parallel::DSB_PASS_MAX_NS,
        }
    }

    fn realtime(&self) -> bool {
        self.cfg.deterministic == 0
    }

    /// Whether the vCPUs run in parallel (`VmConfig.smp`).
    pub fn parallel(&self) -> bool {
        self.cfg.smp == 1
    }

    /// The machine's time in ns: the clock in realtime mode, the counter's in deterministic mode.
    pub(crate) fn ns(&self) -> u64 {
        if self.realtime() {
            return self.clock.ns();
        }
        (self.now() as u128 * 1_000_000_000 / self.cfg.cntfrq as u128) as u64
    }

    /// Gives the xHCI's completed TDs their events once their latency passed (or, `force`, at
    /// once); the `DEVICE` exit's value if that posted records. Reads the clock only when a TD
    /// waits (the round-robin loop calls it every iteration).
    fn xhci_tick(&mut self, force: bool) -> Option<u64> {
        let due = match (&self.plat.get_mut().xhci, &self.shared.xhci) {
            (Some(x), Some(_)) => x.due(),
            _ => return None,
        };
        if due == u64::MAX {
            return None;
        }
        let ns = self.ns();
        if !force && due > ns {
            return None;
        }
        let (Some(x), Some(sh)) = (&mut self.plat.get_mut().xhci, &self.shared.xhci) else {
            return None;
        };
        let ev = x.tick(ns, force, &self.mem, sh);
        (ev != 0).then_some(xhci::EXIT_SLOT | (ev as u64) << 8)
    }

    /// Whether vCPU `c` is on (PSCI).
    pub fn power(&self, c: usize) -> Power {
        if self.parallel() {
            return self.power_par(c, None);
        }
        self.sched[c].power
    }

    /// Records vCPU `c`'s PSCI SYSTEM_SUSPEND (it's off already, as is every other vCPU).
    fn suspend(&self, c: usize, (entry, context): (u64, u64)) {
        let mut p = self.plat.lock();
        p.suspended = Some((c, entry, context));
        p.virtio.iter_mut().for_each(Transport::suspending);
        self.shared.suspended.store(true, Ordering::Release);
    }

    /// Whether the guest is in PSCI SYSTEM_SUSPEND. From any thread.
    pub fn suspended(&self) -> bool {
        self.shared.suspended.load(Ordering::Acquire)
    }

    /// Wakes a guest in PSCI SYSTEM_SUSPEND: the vCPU that suspended it
    /// resumes at its entry point, as from CPU_ON. False if it isn't
    /// suspended. Parallel mode: from any thread; round-robin: no vCPU runs.
    pub fn wake_suspended(&self) -> bool {
        let mut p = self.plat.lock();
        let Some((c, entry, context)) = p.suspended.take() else {
            return false;
        };
        self.shared.suspended.store(false, Ordering::Release);
        p.start[c] = Some((entry, context));
        drop(p);
        if self.parallel() {
            self.wake(c);
        }
        // Round-robin takes it at its next `run`.
        true
    }

    /// The counter value (CNTPCT = CNTVCT), the same for every vCPU.
    pub fn now(&self) -> u64 {
        if self.realtime() {
            #[cfg(target_arch = "wasm32")]
            let t = match self.counter() {
                k if k.last == 0 => k.base,
                // SAFETY: a host function with no preconditions.
                k => k.base + ((unsafe { now_ms() } - k.t0) * k.scale) as u64,
            };
            #[cfg(not(target_arch = "wasm32"))]
            let t = (self.clock.ns() as u128 * self.cfg.cntfrq as u128 / 1_000_000_000) as u64;
            if self.parallel() {
                // Threads read the clock at different times: never let one
                // see it go back from what another saw.
                return self.last.fetch_max(t, Ordering::Relaxed).max(t);
            }
            return t;
        }
        self.steps * self.cfg.ticks_per_insn + self.skipped
    }

    /// The realtime counter's parameters, as compiled code reads it
    /// (`jit::Counter`; `last` 0 while the clock isn't counting).
    #[cfg(target_arch = "wasm32")]
    pub(crate) fn counter(&self) -> crate::jit::Counter {
        let frq = self.cfg.cntfrq;
        let t0 = self.clock.t0.load(Ordering::Acquire);
        let base = self.clock.base.load(Ordering::Relaxed);
        let base = (base as u128 * frq as u128 / 1_000_000_000) as u64;
        if t0 == Clock::UNSTARTED {
            return crate::jit::Counter {
                base,
                ..Default::default()
            };
        }
        crate::jit::Counter {
            t0: f64::from_bits(t0),
            scale: frq as f64 / 1e3,
            base,
            last: self.last.as_ptr() as usize as u32,
        }
    }

    /// Runs at most `budget` steps of all vCPUs; returns the exit kind, with
    /// details in `self.exit`. The vCPUs take turns on this thread, a quantum
    /// each in index order (deterministic round-robin); an off or waiting one
    /// is skipped.
    pub fn run(&mut self, budget: u64) -> u32 {
        assert!(!self.parallel(), "vm_run in parallel mode: vm_run_cpu");
        // A woken SYSTEM_SUSPEND (`wake_suspended`).
        for c in 0..self.vcpus.len() {
            if let Some((entry, context)) = self.plat.get_mut().start[c].take() {
                self.cpu_on(c, entry, context);
            }
        }
        self.clock.start();
        let start = self.steps;
        self.exit = ExitInfo::default();
        if let Some(w) = self.mem.watch() {
            (0..self.vcpus.len()).for_each(|c| w.set_running(c, true));
        }
        let kind = loop {
            let sig = self.shared.signal.load(Ordering::Acquire);
            if sig & SIGNAL_STOP != 0 {
                self.shared.signal.fetch_and(!SIGNAL_STOP, Ordering::AcqRel);
                break exit::STOP;
            }
            if sig & SIGNAL_RX != 0 {
                // A wake-up only: the PL011 reads the ring directly.
                self.shared.signal.fetch_and(!SIGNAL_RX, Ordering::AcqRel);
            }
            if sig & SIGNAL_DEVICE != 0 {
                self.shared
                    .signal
                    .fetch_and(!SIGNAL_DEVICE, Ordering::AcqRel);
                if self.complete() {
                    break exit::DEVICE;
                }
            }
            if let Some(v) = self.xhci_tick(false) {
                self.exit.value = v;
                break exit::DEVICE;
            }
            let left = budget.saturating_sub(self.steps - start);
            if left == 0 {
                break exit::BUDGET;
            }
            self.lines();
            let Some(c) = self.pick() else {
                match self.idle() {
                    Some(kind) => break kind,
                    None => continue,
                }
            };
            if self.sched[c].wait != Wait::No {
                // Its WFI completes: an interrupt is signaled, or time reached its deadline.
                self.sched[c].wait = Wait::No;
                let cpu = &mut self.vcpus[c].cpu;
                cpu.pc = cpu.pc.wrapping_add(4);
                self.retire(1);
                continue;
            }
            if self.plat.get_mut().gic.irq(c) && self.vcpus[c].cpu.pstate & PSTATE_I == 0 {
                take_irq(&mut self.vcpus[c].cpu);
                self.retire(1);
                bump(&self.shared.cpus[0].counters.irqs);
                continue;
            }
            let n = CHUNK.min(left).min(self.until_deadline()).min(self.quantum);
            self.vcpus[c].tlb.catch_up(&self.mem, c);
            // No IRQ for it now, and none comes within the chunk but at an exit: an
            // unmasking MSR's `Exit::Resync` would find none (`jit::Unmask`). Not
            // while the xHCI has an event due: it fires at the next chunk boundary
            // (`xhci_tick`), which the exit would bring forward. Not in realtime
            // mode, where chunks don't end at deadlines and devices signal at any
            // time: the exit is what takes a timer or a completion's IRQ at once.
            // And not once a host signal arrives (a completion, console input, a
            // stop: the host sets the word at any time): the inline arm reads the
            // signal word's low byte, which holds its bits, as `irq`.
            let realtime = self.realtime();
            let pl = self.plat.get_mut();
            let quiet = pl.xhci.as_ref().is_none_or(|x| x.due() == u64::MAX);
            let ok = (!realtime && quiet && !pl.gic.irq(c)) as u32;
            self.vcpus[c].jit.unmask = jit::Unmask {
                ok,
                irq: &self.shared.signal as *const AtomicU32 as usize as u32,
                ..Default::default()
            };
            let (k, e) = self.chunk(c, n);
            self.vcpus[c].jit.unmask = jit::Unmask::default();
            self.retire(k);
            self.publish();
            if let Some(e) = e
                && let Some(kind) = self.handle(e)
            {
                break kind;
            }
        };
        self.publish();
        if let Some(w) = self.mem.watch() {
            for (c, v) in self.vcpus.iter_mut().enumerate() {
                v.tlb.leave(&self.mem, c);
                w.set_running(c, false);
            }
        }
        self.exit.kind = kind as u64;
        self.exit.retired = self.steps - start;
        self.exit.cpu = self.cur as u64;
        kind
    }

    /// Counts `k` steps of the current vCPU (against its quantum too).
    fn retire(&mut self, k: u64) {
        self.steps += k;
        self.quantum = self.quantum.saturating_sub(k);
    }

    /// The vCPU to run: the current one while its quantum lasts, else the next
    /// one in index order that can, with a new quantum; `None` if every vCPU is
    /// off or waiting in WFI.
    fn pick(&mut self) -> Option<usize> {
        let n = self.vcpus.len();
        let from = if self.quantum > 0 { 0 } else { 1 };
        for k in from..=n {
            let c = (self.cur + k) % n;
            if self.ready(c) {
                if k > 0 {
                    self.cur = c;
                    self.quantum = if n > 1 { QUANTUM } else { u64::MAX };
                }
                return Some(c);
            }
        }
        None
    }

    fn ready(&mut self, c: usize) -> bool {
        let s = &self.sched[c];
        s.power == Power::On
            && match s.wait {
                Wait::No | Wait::Woken => true,
                // WFI completes when an interrupt is signaled, masked or not.
                Wait::Wfi => self.plat.get_mut().gic.irq(c),
            }
    }

    /// Every vCPU is off or waiting. Deterministic time jumps to the next timer
    /// deadline (the vCPUs it was for complete their WFI); realtime mode, or no
    /// deadline, returns the idle exit. A deadline at or past [`TIME_MAX`] (a
    /// CVAL near 2^64, as a negative TVAL early on makes) is none: a jump there
    /// would overflow the counter a few steps on.
    ///
    /// One reading of the counter decides both whether a timer fires and the
    /// deadline: in realtime mode the clock moves between reads, and a timer
    /// due between two of them was neither pending nor a future deadline, so
    /// the host slept with no deadline for good (found in M6.5 loop 5).
    fn idle(&mut self) -> Option<u32> {
        // Nothing runs: the xHCI's completions needn't wait (`xhci::LATENCY_NS`). Then as any
        // idle machine: their interrupt makes a vCPU ready, or nothing does (an endpoint that
        // walks on without one).
        if let Some(v) = self.xhci_tick(true) {
            self.exit.value = v;
            return Some(exit::DEVICE);
        }
        let now = self.now();
        self.lines_at(now);
        for c in 0..self.vcpus.len() {
            if self.ready(c) {
                return None;
            }
        }
        let deadline = self
            .next_deadline_at(now)
            .filter(|&t| self.realtime() || t < TIME_MAX);
        match deadline {
            Some(t) if !self.realtime() => {
                self.skipped += t - now;
                for c in 0..self.vcpus.len() {
                    if self.sched[c].wait == Wait::Wfi && self.deadline_of(c, now) == Some(t) {
                        self.sched[c].wait = Wait::Woken;
                    }
                }
                None
            }
            t => {
                self.exit.value = ns_to(t, now, self.cfg.cntfrq);
                Some(exit::IDLE)
            }
        }
    }

    /// Runs at most `n` steps of vCPU `c`, through the JIT when it's on.
    fn chunk(&mut self, c: usize, n: u64) -> (u64, Option<Exit>) {
        if c != 0 {
            self.vcpus[c].jit.cache = self.vcpus[0].jit.cache.take();
        }
        let v = &mut *self.vcpus[c];
        let r = if v.jit.cache.is_some() {
            // SAFETY: `v` is this VM's vCPU, not otherwise referenced during the call.
            unsafe { jit::steps(v, &self.mem, n) }
        } else if interp::debug::armed(&v.cpu) {
            interp::debug::steps(&mut v.cpu, &self.mem, Some(&mut v.tlb), n, false)
        } else {
            interp::steps(&mut v.cpu, &self.mem, Some(&mut v.tlb), n)
        };
        if c != 0 {
            self.vcpus[0].jit.cache = self.vcpus[c].jit.cache.take();
        }
        r
    }

    /// Copies the run loop's own counts into the shared counters (once per chunk).
    fn publish(&self) {
        let c = &self.shared.cpus[0].counters;
        c.retired.store(self.steps, Ordering::Relaxed);
        c.pc.store(self.vcpus[self.cur].cpu.pc, Ordering::Relaxed);
        let t = self.vcpus.iter().map(|v| &v.tlb.stats);
        let (misses, walks, flushes) = t.fold((0, 0, 0), |(m, w, f), s| {
            (m + s.misses, w + s.walks, f + s.flushes)
        });
        c.tlb_misses.store(misses, Ordering::Relaxed);
        c.tlb_walks.store(walks, Ordering::Relaxed);
        c.tlb_flushes.store(flushes, Ordering::Relaxed);
        if let Some(j) = &self.vcpus[0].jit.cache {
            publish_jit(c, &j.table.stats());
        }
    }

    /// Drains every backend's completions; true if that posted new requests
    /// (chains that hadn't fit before), with `exit.value` set.
    fn complete(&mut self) -> bool {
        let ns = self.ns();
        let r = complete(self.plat.get_mut(), &self.mem, &self.shared, ns);
        if let Some(v) = r {
            self.exit.value = v;
        }
        r.is_some()
    }

    /// Drives the timers' and devices' interrupt lines into the GIC.
    fn lines(&mut self) {
        self.lines_at(self.now());
    }

    /// [`Vm::lines`] with the counter at `now`.
    fn lines_at(&mut self, now: u64) {
        let p = self.plat.get_mut();
        for (i, v) in self.vcpus.iter_mut().enumerate() {
            let (vt, pt) = timers(&v.cpu, now);
            p.gic.set_level(i, IRQ_VTIMER, vt);
            p.gic.set_level(i, IRQ_PTIMER, pt);
        }
        spis(p, &self.shared);
    }

    /// The earliest compare value of an enabled, unmasked timer of an on vCPU
    /// that hasn't fired yet.
    fn next_deadline(&self) -> Option<u64> {
        self.next_deadline_at(self.now())
    }

    /// [`Vm::next_deadline`] with the counter at `now`: exactly the timers
    /// [`Vm::lines_at`] doesn't fire at the same `now`.
    fn next_deadline_at(&self, now: u64) -> Option<u64> {
        (0..self.vcpus.len())
            .filter(|&c| self.sched[c].power == Power::On)
            .filter_map(|c| self.deadline_of(c, now))
            .min()
    }

    /// vCPU `c`'s next timer deadline after `now`.
    fn deadline_of(&self, c: usize, now: u64) -> Option<u64> {
        deadline(&self.vcpus[c].cpu, now)
    }

    /// Steps until the next deadline (at least 1), or u64::MAX (also in
    /// realtime mode, where steps don't measure time).
    fn until_deadline(&self) -> u64 {
        if self.realtime() {
            return u64::MAX;
        }
        self.next_deadline().map_or(u64::MAX, |t| {
            (t - self.now()).div_ceil(self.cfg.ticks_per_insn)
        })
    }

    /// Completes an exit of the current vCPU; `Some` ends the run with that kind.
    fn handle(&mut self, e: Exit) -> Option<u32> {
        let c = self.cur;
        match e {
            Exit::Resync => self.retire(1),
            Exit::Invalidate(pa) => {
                self.retire(1);
                // The JIT is home in vCPU 0 between chunks.
                if let Some(j) = &mut self.vcpus[0].jit.cache {
                    j.invalidate(pa);
                }
            }
            Exit::Wfe => {
                self.retire(1);
                // No event to consume: the quantum ends (decision 5 of M7's kickoff).
                if !core::mem::take(&mut self.sched[c].event) {
                    self.quantum = 0;
                }
            }
            Exit::Sev(local) => {
                self.retire(1);
                if local {
                    self.sched[c].event = true;
                } else {
                    self.sched.iter_mut().for_each(|s| s.event = true);
                }
            }
            Exit::TlbiIs(i, v) => {
                self.retire(1);
                for (k, other) in self.vcpus.iter_mut().enumerate() {
                    if k != c {
                        match i >> 5 & 7 {
                            0 => other.tlb.flush_all(),
                            2 => other.tlb.flush_ng(),
                            _ => other.tlb.flush_va(v << 12),
                        }
                    }
                }
            }
            Exit::Hvc(_) => {
                let cpu = &mut self.vcpus[c].cpu;
                cpu.pc = cpu.pc.wrapping_add(4);
                self.retire(1);
                return self.psci();
            }
            Exit::Unimplemented(op) => {
                self.exit.value = op as u64;
                return Some(exit::UNIMPLEMENTED);
            }
            Exit::Platform(i) => {
                let cpu = &mut self.vcpus[c].cpu;
                if let Some(r) = sys::icc(cpu.features, i >> 5 & 0xffff) {
                    let (rt, read) = (i & 31, i & 1 << 21 != 0);
                    let v = self
                        .plat
                        .get_mut()
                        .gic
                        .icc(c, r, (!read).then(|| cpu.reg(rt)));
                    if read {
                        cpu.set_reg(rt, v);
                    }
                } else if sys::is_rndr(i) {
                    let v = &mut self.vcpus[c];
                    let r = v.rng.draw();
                    sys::rndr(&mut v.cpu, i, r);
                } else {
                    let (now, irq) = (self.now(), self.plat.get_mut().gic.irq(c));
                    platform(&mut self.vcpus[c].cpu, i, now, self.cfg.cntfrq, irq);
                }
                let cpu = &mut self.vcpus[c].cpu;
                cpu.pc = cpu.pc.wrapping_add(4);
                self.retire(1);
            }
            Exit::Wfi => self.wfi(c),
            Exit::Fault(Fault {
                kind: FaultKind::Bus,
                ..
            }) => return self.io(),
            e => self.exception(e),
        }
        None
    }

    fn exception(&mut self, e: Exit) {
        let cpu = &mut self.vcpus[self.cur].cpu;
        take_exception(cpu, e);
        let ec = (cpu.esr_el1 >> 26) as usize & 63;
        self.retire(1);
        bump(&self.shared.cpus[0].counters.exceptions[ec]);
    }

    /// WFI completes at once when an interrupt is signaled to vCPU `c` (masked
    /// or not); otherwise the vCPU waits with the PC on it ([`Vm::pick`]
    /// passes it over, [`Vm::idle`] moves time on when every vCPU waits).
    fn wfi(&mut self, c: usize) {
        let now = self.now();
        self.lines_at(now);
        if self.plat.get_mut().gic.irq(c) {
            let cpu = &mut self.vcpus[c].cpu;
            cpu.pc = cpu.pc.wrapping_add(4);
            self.retire(1);
        } else {
            self.sched[c].wait = Wait::Wfi;
        }
    }

    /// Runs the instruction at the PC again through [`Io`], after it hit a non-RAM address.
    fn io(&mut self) -> Option<u32> {
        // The PL031 counts virtual time in deterministic mode (the firmware configuration).
        let time = if self.realtime() {
            Time::Clock(&self.clock)
        } else {
            Time::Virtual((self.now() as u128 * 1_000_000_000 / self.cfg.cntfrq as u128) as u64)
        };
        let vcpu = &mut *self.vcpus[self.cur];
        let (r, tx_full, device) = io(vcpu, &self.mem, self.plat.get_mut(), &self.shared, time);
        match r {
            Ok(()) => {
                self.retire(1);
                if let Some(v) = device {
                    self.exit.value = v;
                    return Some(exit::DEVICE);
                }
            }
            Err(_) if tx_full => return Some(exit::TX_FULL),
            Err(e @ Exit::Fault(_)) => self.exception(e), // nothing there: external abort
            Err(e) => return self.handle(e),
        }
        None
    }

    /// The vCPU whose MPIDR affinity fields are `aff` (Aff3 at 39:32, Aff2–Aff0 at 23:0).
    fn cpu_of(&self, aff: u64) -> Option<usize> {
        (0..self.vcpus.len()).find(|&i| gicv3::mpidr(i) & 0xff_00ff_ffff == aff)
    }

    /// PSCI CPU_ON: vCPU `t` starts at `entry` with x0 = `context`.
    fn cpu_on(&mut self, t: usize, entry: u64, context: u64) {
        cpu_on(&mut self.vcpus[t], entry, context);
        self.sched[t] = Sched {
            power: Power::On,
            wait: Wait::No,
            event: false,
        };
    }

    /// A PSCI call (HVC, PC already past it) of the current vCPU: answered
    /// here, or an exit for the host.
    fn psci(&mut self) -> Option<u32> {
        let c = self.cur;
        let x = self.vcpus[c].cpu.x;
        let f = x[0] as u32;
        let aff = psci_aff;
        let r: i64 = match f {
            PSCI_AFFINITY_INFO | PSCI_AFFINITY_INFO_64 => {
                // Level 0 only (one affinity level per vCPU): ON 0, OFF 1.
                match self.cpu_of(aff(x[1], f == PSCI_AFFINITY_INFO_64)) {
                    Some(t) if x[2] == 0 => (self.sched[t].power == Power::Off) as i64,
                    _ => PSCI_INVALID_PARAMETERS,
                }
            }
            PSCI_CPU_ON | PSCI_CPU_ON_64 => {
                let smc64 = f == PSCI_CPU_ON_64;
                let entry = if smc64 { x[2] } else { x[2] as u32 as u64 };
                let context = if smc64 { x[3] } else { x[3] as u32 as u64 };
                match self.cpu_of(aff(x[1], smc64)) {
                    None => PSCI_INVALID_PARAMETERS,
                    Some(t) if self.sched[t].power == Power::On => PSCI_ALREADY_ON,
                    Some(t) => {
                        self.cpu_on(t, entry, context);
                        PSCI_SUCCESS
                    }
                }
            }
            PSCI_CPU_OFF => {
                // Doesn't return: the vCPU stops until a CPU_ON starts it again.
                self.sched[c].power = Power::Off;
                self.quantum = 0;
                return None;
            }
            // Realtime only: a deterministic guest sees PSCI as before (its step counts don't move).
            PSCI_SYSTEM_SUSPEND | PSCI_SYSTEM_SUSPEND_64 if !self.realtime() => PSCI_NOT_SUPPORTED,
            PSCI_SYSTEM_SUSPEND | PSCI_SYSTEM_SUSPEND_64 => {
                if (0..self.vcpus.len()).any(|t| t != c && self.sched[t].power == Power::On) {
                    PSCI_DENIED
                } else {
                    // Doesn't return: the vCPU stops until the host wakes it.
                    let smc64 = f == PSCI_SYSTEM_SUSPEND_64;
                    self.sched[c].power = Power::Off;
                    self.quantum = 0;
                    self.suspend(c, suspend_args(&x, smc64));
                    return None;
                }
            }
            PSCI_SYSTEM_OFF | PSCI_SYSTEM_RESET => {
                self.exit.x.copy_from_slice(&x[..4]);
                return Some(exit::PSCI);
            }
            PSCI_FEATURES
                if !self.realtime()
                    && matches!(x[1] as u32, PSCI_SYSTEM_SUSPEND | PSCI_SYSTEM_SUSPEND_64) =>
            {
                PSCI_NOT_SUPPORTED
            }
            f => psci_common(f, x[1]),
        };
        self.vcpus[c].cpu.x[0] = r as u64;
        None
    }
}

/// The PSCI calls both modes answer alike (function `f`, argument x1).
fn psci_common(f: u32, x1: u64) -> i64 {
    match f {
        PSCI_VERSION => 1 << 16, // 1.0
        PSCI_FEATURES => match x1 as u32 {
            PSCI_VERSION
            | PSCI_FEATURES
            | PSCI_CPU_ON
            | PSCI_CPU_ON_64
            | PSCI_CPU_OFF
            | PSCI_AFFINITY_INFO
            | PSCI_AFFINITY_INFO_64
            | PSCI_MIGRATE_INFO_TYPE
            | PSCI_SYSTEM_OFF
            | PSCI_SYSTEM_RESET
            | PSCI_SYSTEM_SUSPEND
            | PSCI_SYSTEM_SUSPEND_64
            // Linux takes SMCCC 1.1 only if PSCI_FEATURES lists SMCCC_VERSION.
            | SMCCC_VERSION => PSCI_SUCCESS,
            _ => PSCI_NOT_SUPPORTED,
        },
        PSCI_MIGRATE_INFO_TYPE => 2, // no Trusted OS to migrate
        SMCCC_VERSION => 0x1_0001,   // 1.1
        // Nothing speculates (docs/cpu.md): the three Spectre workarounds are not required.
        SMCCC_ARCH_FEATURES => match x1 as u32 {
            SMCCC_ARCH_FEATURES => PSCI_SUCCESS,
            SMCCC_ARCH_WORKAROUND_1 | SMCCC_ARCH_WORKAROUND_2 | SMCCC_ARCH_WORKAROUND_3 => {
                SMCCC_NOT_REQUIRED
            }
            f => psci_common(PSCI_FEATURES, f as u64),
        },
        _ => PSCI_NOT_SUPPORTED,
    }
}

/// PSCI SYSTEM_SUSPEND's (entry, context): 32-bit for the SMC32 call.
fn suspend_args(x: &[u64], smc64: bool) -> (u64, u64) {
    if smc64 {
        (x[1], x[2])
    } else {
        (x[1] as u32 as u64, x[2] as u32 as u64)
    }
}

/// A PSCI affinity argument: SMC32 calls take 32-bit arguments, so the
/// MPIDR's Aff2–Aff0; SMC64 ones Aff3 too.
fn psci_aff(v: u64, smc64: bool) -> u64 {
    if smc64 {
        v & 0xff_00ff_ffff
    } else {
        v & 0xff_ffff
    }
}

/// PSCI CPU_ON's effect on the vCPU: it starts at `entry` in its reset state
/// (EL1h, DAIF masked, the MMU off) with x0 = `context`.
fn cpu_on(v: &mut Vcpu, entry: u64, context: u64) {
    let (features, mpidr) = (v.cpu.features, v.cpu.mpidr);
    v.cpu = Cpu {
        pc: entry,
        features,
        mpidr,
        ..Cpu::reset()
    };
    v.cpu.x[0] = context;
    v.tlb.flush_all();
}

/// vCPU `cpu`'s timer lines at counter value `now` (virtual, physical).
fn timers(c: &Cpu, now: u64) -> (bool, bool) {
    let fires = |ctl, cval| interp::timer_fires(ctl, cval, now);
    (
        fires(c.cntv_ctl_el0, c.cntv_cval_el0),
        fires(c.cntp_ctl_el0, c.cntp_cval_el0),
    )
}

/// A vCPU's next timer deadline after `now`.
fn deadline(c: &Cpu, now: u64) -> Option<u64> {
    [
        (c.cntv_ctl_el0, c.cntv_cval_el0),
        (c.cntp_ctl_el0, c.cntp_cval_el0),
    ]
    .into_iter()
    .filter(|&(ctl, cval)| ctl & 3 == 1 && cval > now)
    .map(|(_, cval)| cval)
    .min()
}

/// An idle exit's nanoseconds to a vCPU's deadline (`deadline`, after `now`) at `frq` Hz, rounded
/// up: a far deadline is `u64::MAX` (none), never a short wait wrapped around.
fn ns_to(deadline: Option<u64>, now: u64, frq: u64) -> u64 {
    deadline.map_or(u64::MAX, |t| {
        let ns = ((t - now) as u128 * 1_000_000_000).div_ceil(frq as u128);
        u64::try_from(ns).unwrap_or(u64::MAX)
    })
}

/// Drives the devices' lines (SPIs) into the GIC.
fn spis(p: &mut Platform, shared: &Shared) {
    let irq = p.uart.irq(&shared.console.rx);
    p.gic.set_level(0, IRQ_UART, irq);
    for (i, t) in p.virtio.iter().enumerate() {
        p.gic.set_level(0, virtio::IRQ_BASE + i, t.irq());
    }
    if let Some(x) = &p.xhci {
        p.gic.set_level(0, xhci::IRQ, x.irq());
        shared.xhci_due.store(x.due(), Ordering::Relaxed);
    }
}

/// Drains every backend's completions; the `DEVICE` exit's value if that
/// posted new requests (chains that hadn't fit before).
fn complete(p: &mut Platform, mem: &Mem, shared: &Shared, ns: u64) -> Option<u64> {
    let mut first = None;
    for (i, (t, sh)) in p.virtio.iter_mut().zip(&shared.devices).enumerate() {
        let ev = t.complete(mem, sh);
        if ev != 0 {
            sh.events.fetch_or(ev, Ordering::AcqRel);
            first.get_or_insert((i as u64) | (ev as u64) << 8);
        }
    }
    if let (Some(x), Some(sh)) = (&mut p.xhci, &shared.xhci) {
        let ev = x.complete(mem, sh, ns);
        if ev != 0 {
            first.get_or_insert(xhci::EXIT_SLOT | (ev as u64) << 8);
        }
    }
    first
}

/// Copies the JIT's counts into a counters block.
fn publish_jit(c: &Counters, s: &jit::Stats) {
    let v = [
        s.blocks,
        s.modules,
        s.bytes,
        s.compile_ns,
        s.steps,
        s.dispatches,
        s.invalidations,
        s.flushes,
        s.inline,
        s.helpers,
        s.inline_steps,
        s.flags_stored,
        s.flags_elided,
        s.cond_direct,
        s.cond_computed,
        s.cond_memory,
        s.region_blocks,
        s.back_edges,
        s.tier_ups,
        s.stale,
    ];
    for (a, v) in c.jit.iter().zip(v) {
        a.store(v, Ordering::Relaxed);
    }
    for (a, v) in c.dec.iter().zip([s.dec_steps, s.decoded, s.dec_clears]) {
        a.store(v, Ordering::Relaxed);
    }
    for (a, v) in
        c.cw.iter()
            .zip([s.worker_installs, s.overdue, s.parks, s.park_exits])
    {
        a.store(v, Ordering::Relaxed);
    }
    let jx = [
        s.locks,
        s.lock_contended,
        s.lock_wait_ns,
        s.emit_ns,
        s.emit_locked_ns,
        s.plan_ns,
        s.prunes,
        s.rescues,
        s.lag_flushes,
        s.dec_bytes,
        s.known_bytes,
        s.lock_skipped,
        s.prune_ns,
    ];
    for (a, v) in c.jx.iter().zip(jx) {
        a.store(v, Ordering::Relaxed);
    }
}

/// Runs the instruction at `vcpu`'s PC again through [`Io`], after it hit a
/// non-RAM address: its result, whether the console's TX ring was full, and
/// a `DEVICE` exit's value.
fn io(
    vcpu: &mut Vcpu,
    mem: &Mem,
    p: &mut Platform,
    shared: &Shared,
    time: Time,
) -> (Result<(), Exit>, bool, Option<u64>) {
    let mut io = Io {
        mmu: Mmu::new(mem, Some(&mut vcpu.tlb)),
        gic: &mut p.gic,
        uart: &mut p.uart,
        rtc: p.rtc.as_mut(),
        flash: p.flash.as_mut(),
        fw_cfg: p.fw_cfg.as_mut(),
        time,
        console: &shared.console,
        virtio: &mut p.virtio,
        devices: &shared.devices,
        xhci: p.xhci.as_mut().zip(shared.xhci.as_ref()),
        tx_full: false,
        device: None,
    };
    let r = interp::step_bus(&mut vcpu.cpu, &mut io);
    (r, io.tx_full, io.device)
}

/// The PL031's time: the host clock, or (deterministic mode) virtual time in ns.
#[derive(Clone, Copy)]
enum Time<'a> {
    Clock(&'a Clock),
    Virtual(u64),
}

impl Time<'_> {
    fn ns(self) -> u64 {
        match self {
            Time::Clock(c) => c.ns(),
            Time::Virtual(ns) => ns,
        }
    }
}

/// The bus for one instruction that touched a non-RAM physical address: RAM
/// through the MMU as usual, and device registers where the address is one.
struct Io<'a> {
    mmu: Mmu<'a>,
    gic: &'a mut Gicv3,
    uart: &'a mut Pl011,
    rtc: Option<&'a mut Pl031>,
    flash: Option<&'a mut Flash>,
    fw_cfg: Option<&'a mut FwCfg>,
    time: Time<'a>,
    console: &'a Rings,
    virtio: &'a mut [Transport],
    devices: &'a [DevShared],
    xhci: Option<(&'a mut Xhci, &'a XhciShared)>,
    /// A PL011 DR write found the TX ring full.
    tx_full: bool,
    /// A virtio register write with events for the host: the `DEVICE` exit's value.
    device: Option<u64>,
}

impl Io<'_> {
    /// The physical address of `va`, which translated (the access reached the bus).
    fn pa(&self, c: &Cpu, va: u64) -> u64 {
        if c.sctlr_el1 & sctlr::M == 0 {
            return va;
        }
        walk(c, self.mmu.mem, va).map_or(u64::MAX, |w| w.pa)
    }

    fn dev_read(&mut self, pa: u64, size: u32) -> Option<u64> {
        match pa {
            GICD..0x0900_0000 => return gic_read(self.gic, pa, size),
            UART..0x0900_1000 if size <= 4 => {
                let off = pa - UART;
                let w = self.uart.read(off & !3, self.console) >> (8 * (off & 3));
                Some(w & (u64::MAX >> (64 - 8 * size)) as u32)
            }
            // Sub-word reads see the register's bytes (EDK2 reads the IDs with LDRB).
            RTC..0x0901_1000 if size <= 4 => {
                let off = pa - RTC;
                let w = self.rtc.as_ref()?.read(off & !3, self.time.ns())? >> (8 * (off & 3));
                Some(w & (u64::MAX >> (64 - 8 * size)) as u32)
            }
            FLASH..FLASH_END => {
                let f = self.flash.as_ref()?;
                return f.read(pa - FLASH, size);
            }
            FW_CFG..FW_CFG_END => return self.fw_cfg.as_mut()?.read(pa - FW_CFG, size),
            virtio::MMIO_BASE..VIRTIO_END => {
                let (i, off) = virtio_slot(pa);
                return self
                    .virtio
                    .get_mut(i)?
                    .read(off, size, self.devices.get(i)?);
            }
            xhci::BASE..XHCI_END => {
                let ns = self.time.ns();
                return self.xhci.as_mut()?.0.read(pa - xhci::BASE, size, ns);
            }
            _ => None,
        }
        .map(u64::from)
    }

    fn dev_write(&mut self, pa: u64, size: u32, v: u64) -> Option<()> {
        match pa {
            GICD..0x0900_0000 => gic_write(self.gic, pa, size, v),
            // Sub-word writes go to the register at the aligned offset (DR by writeb).
            UART..0x0900_1000 if size <= 4 && pa & 3 == 0 => {
                self.tx_full = !self.uart.write(pa - UART, v as u32, self.console);
                (!self.tx_full).then_some(())
            }
            RTC..0x0901_1000 if size == 4 && pa & 3 == 0 => {
                let ns = self.time.ns();
                self.rtc.as_mut()?.write(pa - RTC, v as u32, ns)
            }
            FLASH..FLASH_END => self.flash.as_mut()?.write(pa - FLASH, size, v),
            FW_CFG..FW_CFG_END => self.fw_cfg.as_mut()?.write(pa - FW_CFG, size, v),
            virtio::MMIO_BASE..VIRTIO_END => {
                let (i, off) = virtio_slot(pa);
                let sh = self.devices.get(i)?;
                let ev = self
                    .virtio
                    .get_mut(i)?
                    .write(off, size, v, self.mmu.mem, sh)?;
                if ev != 0 {
                    sh.events.fetch_or(ev, Ordering::AcqRel);
                    self.device = Some(i as u64 | (ev as u64) << 8);
                }
                Some(())
            }
            xhci::BASE..XHCI_END => {
                let (x, sh) = self.xhci.as_mut()?;
                let ns = self.time.ns();
                let ev = x.write(pa - xhci::BASE, size, v, self.mmu.mem, sh, ns)?;
                if ev != 0 {
                    self.device = Some(xhci::EXIT_SLOT | (ev as u64) << 8);
                }
                Some(())
            }
            _ => None,
        }
    }
}

/// A device access's watchpoint (`debug::hit`): the instruction ran first in
/// the debug interpreter, whose `Watch` checked the accesses up to the first
/// one that reached a device, but not those after it (a pair's second).
#[inline(always)]
fn watch(c: &Cpu, va: u64, size: u32, el: u64, kind: Kind) -> Result<(), Fault> {
    if c.mdscr_el1 & debug::MDSCR_MDE == 0 {
        return Ok(());
    }
    debug::hit(c, va, size as u64, el, kind).map_or(Ok(()), Err)
}

const FLASH_END: u64 = FLASH + crate::flash::MAX_SIZE;
const FW_CFG_END: u64 = FW_CFG + crate::fw_cfg::SIZE;
const XHCI_END: u64 = xhci::BASE + xhci::SIZE;
const VIRTIO_END: u64 = virtio::MMIO_BASE + virtio::MAX_DEVICES as u64 * virtio::MMIO_STRIDE;

/// Transport slot and register offset of a PA in the virtio-mmio window.
fn virtio_slot(pa: u64) -> (usize, u64) {
    let off = pa - virtio::MMIO_BASE;
    (
        (off / virtio::MMIO_STRIDE) as usize,
        off % virtio::MMIO_STRIDE,
    )
}

impl Bus for Io<'_> {
    fn mem(&self) -> &Mem {
        self.mmu.mem
    }

    fn read_el(&mut self, c: &Cpu, va: u64, size: u32, el: u64) -> Result<u64, Fault> {
        match self.mmu.read_el(c, va, size, el) {
            Err(f) if f.kind == FaultKind::Bus => {
                watch(c, va, size, el, Kind::Load)?;
                let pa = self.pa(c, va);
                self.dev_read(pa, size).ok_or(f)
            }
            r => r,
        }
    }

    fn write_el(&mut self, c: &Cpu, va: u64, size: u32, val: u64, el: u64) -> Result<(), Fault> {
        match self.mmu.write_el(c, va, size, val, el) {
            Err(f) if f.kind == FaultKind::Bus => {
                watch(c, va, size, el, Kind::Store)?;
                let pa = self.pa(c, va);
                self.dev_write(pa, size, val).ok_or(f)
            }
            r => r,
        }
    }

    fn fetch(&mut self, c: &Cpu, pc: u64) -> Result<u32, Fault> {
        self.mmu.fetch(c, pc)
    }

    fn maint(&mut self, c: &Cpu, va: u64, write: bool) -> Result<Option<u64>, Fault> {
        self.mmu.maint(c, va, write)
    }

    // LDAR and STLR, which Device memory allows. An LDXR reads here too; its
    // STXR's `cas` doesn't, and aborts.
    fn read_atomic(&mut self, c: &Cpu, va: u64, size: u32) -> Result<u64, Fault> {
        match self.mmu.read_atomic(c, va, size) {
            Err(f) if f.kind == FaultKind::Bus => {
                watch(c, va, size, c.el(), Kind::Load)?;
                let pa = self.pa(c, va);
                self.dev_read(pa, size).ok_or(f)
            }
            r => r,
        }
    }

    fn write_atomic(&mut self, c: &Cpu, va: u64, size: u32, val: u64) -> Result<(), Fault> {
        match self.mmu.write_atomic(c, va, size, val) {
            Err(f) if f.kind == FaultKind::Bus => {
                watch(c, va, size, c.el(), Kind::Store)?;
                let pa = self.pa(c, va);
                self.dev_write(pa, size, val).ok_or(f)
            }
            r => r,
        }
    }

    fn host_aligned(
        &mut self,
        c: &Cpu,
        va: u64,
        len: u64,
        access: Access,
    ) -> Result<crate::mem::Host, Fault> {
        self.mmu.host_aligned(c, va, len, access)
    }

    fn flush_all(&mut self) {
        self.mmu.flush_all();
    }

    fn flush_va(&mut self, va: u64) {
        self.mmu.flush_va(va);
    }

    fn flush_ng(&mut self) {
        self.mmu.flush_ng();
    }
}

#[cfg(test)]
mod tests;
