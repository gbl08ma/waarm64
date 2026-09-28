//! A whole VM: one vCPU, RAM at `RAM_BASE`, the GICv2, the generic timer and the
//! PL011 at QEMU `virt`'s addresses, and the run loop that delivers IRQs, waits
//! in WFI and answers PSCI. lib.rs exports it (docs/abi.md).
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

use core::sync::atomic::{AtomicU32, AtomicU64, Ordering};

use crate::cpu::{Cpu, PSTATE_I, sctlr};
use crate::gic::Gic;
use crate::gicv3::{self, Gicv3};
use crate::interp::{self, Exit, platform, sys, take_exception, take_irq};
use crate::jit;
use crate::mem::{Access, Fault, FaultKind, Mem};
use crate::mmu::{Bus, Mmu, Vcpu, walk};
use crate::pl011::{Pl011, Rings};
use crate::virtio::{self, DevShared, DeviceEntry, Transport};
use std::sync::Arc;

pub const RAM_BASE: u64 = 0x4000_0000;
pub const GICD: u64 = 0x0800_0000;
pub const GICC: u64 = 0x0801_0000;
/// The GICv3 redistributors (QEMU `virt`'s), `gicv3::GICR_STRIDE` apart.
pub const GICR: u64 = 0x080a_0000;
/// The most vCPUs a VM may have: the GICv3 redistributor window (0x080a_0000
/// to 0x0900_0000 on `virt`) holds 123; GICv2 allows 8.
pub const MAX_CPUS: u64 = 123;
pub const UART: u64 = 0x0900_0000;
/// INTIDs: the `arm,armv8-timer` PPIs on `virt` (virtual, physical) and SPI 1.
pub const IRQ_VTIMER: usize = 27;
pub const IRQ_PTIMER: usize = 30;
pub const IRQ_UART: usize = 33;
/// Steps between signal checks. Deterministic guests can't tell chunk
/// boundaries apart (anything that makes an IRQ takeable ends a chunk: MSR or
/// ERET unmasking, MMIO, timer deadlines), so the size only trades realtime
/// latency against how long JIT loops run between returns (M6: 1024 → 32768,
/// Alpine −14% in Node; identical steps at 1024–131072).
const CHUNK: u64 = 32768;

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
    /// 0 interpreter only; 1 JIT; 2 JIT-stress (`jit::Config::STRESS`) (ABI 10).
    pub jit: u64,
    /// Optional CPU features (`cpu::FEATURE_*`; ABI 19); 0, the default, is none.
    pub features: u64,
    /// vCPUs; 0 or 1 is one (ABI 21).
    pub ncpus: u64,
    /// The interrupt controller: 2 GICv2, 3 GICv3, 0 the default ([`GIC_DEFAULT`]) (ABI 21).
    pub gic: u64,
}

/// The GIC a VM gets with `VmConfig.gic` = 0.
pub const GIC_DEFAULT: u64 = 3;

impl VmConfig {
    /// The GIC version, 2 or 3.
    pub fn gic_version(&self) -> u64 {
        if self.gic == 0 { GIC_DEFAULT } else { self.gic }
    }

    /// Whether `vm_new` accepts the GIC and CPU fields: up to `MAX_CPUS` on
    /// a GICv3; the GICv2 model is one CPU's until it's made per-CPU.
    pub fn valid_smp(&self) -> bool {
        match self.gic_version() {
            3 => self.ncpus <= MAX_CPUS,
            2 => self.ncpus <= 1,
            _ => false,
        }
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
/// the vCPU that exited (ABI 22).
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct ExitInfo {
    pub kind: u64,
    pub retired: u64,
    pub value: u64,
    pub x: [u64; 4],
    pub cpu: u64,
}

/// Signal word bits.
pub const SIGNAL_STOP: u32 = 1;
pub const SIGNAL_RX: u32 = 2;
/// A backend posted completions.
pub const SIGNAL_DEVICE: u32 = 4;

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
    /// and from memory; ABI 15: blocks in the compiled regions; ABI 16: back-edges.
    pub jit: [AtomicU64; 19],
}

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
            jit: [const { AtomicU64::new(0) }; 19],
        }
    }
}

fn bump(a: &AtomicU64) {
    a.store(a.load(Ordering::Relaxed) + 1, Ordering::Relaxed);
}

/// What other threads touch while the vCPU runs. Behind a shared reference
/// (not inside the `&mut Vm`), so concurrent access through it is sound.
#[derive(Default)]
pub struct Shared {
    pub console: Rings,
    pub signal: AtomicU32,
    pub counters: Counters,
    /// One per virtio transport.
    pub devices: Vec<DevShared>,
}

/// The VM's interrupt controller (`VmConfig.gic`).
pub enum Intc {
    V2(Box<Gic>),
    V3(Box<Gicv3>),
}

impl Intc {
    /// Drives line `irq` (a PPI of CPU `cpu`, or an SPI) high or low.
    pub fn set_level(&mut self, cpu: usize, irq: usize, high: bool) {
        match self {
            Intc::V2(g) => g.set_level(irq, high),
            Intc::V3(g) => g.set_level(cpu, irq, high),
        }
    }

    /// The GICv2 (tests that drive it directly).
    #[cfg(test)]
    pub fn v2(&mut self) -> &mut Gic {
        match self {
            Intc::V2(g) => g,
            Intc::V3(_) => panic!("not a GICv2"),
        }
    }

    /// The IRQ line into CPU `cpu`.
    pub fn irq(&self, cpu: usize) -> bool {
        match self {
            Intc::V2(g) => g.irq(),
            Intc::V3(g) => g.irq(cpu),
        }
    }

    /// A register read at `pa`: `None` if no GIC register is there (or the
    /// size isn't allowed), else the value.
    fn read(&mut self, pa: u64, size: u32) -> Option<u64> {
        match self {
            Intc::V2(g) => match pa {
                GICD..0x0801_0000 => g.dist_read(pa - GICD, size),
                GICC..0x0802_0000 => g.cpu_read(pa - GICC, size),
                _ => None,
            }
            .map(u64::from),
            Intc::V3(g) => match pa {
                GICD..0x0801_0000 => g.dist_read(pa - GICD, size),
                GICR..0x0900_0000 => g.redist_read(pa - GICR, size),
                _ => None,
            },
        }
    }

    fn write(&mut self, pa: u64, size: u32, v: u64) -> Option<()> {
        match self {
            Intc::V2(g) => match pa {
                GICD..0x0801_0000 => g.dist_write(pa - GICD, size, v as u32),
                GICC..0x0802_0000 => g.cpu_write(pa - GICC, size, v as u32),
                _ => None,
            },
            Intc::V3(g) => match pa {
                GICD..0x0801_0000 => g.dist_write(pa - GICD, size, v),
                GICR..0x0900_0000 => g.redist_write(pa - GICR, size, v),
                _ => None,
            },
        }
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
    /// CPU *i* is `vcpus[i]` (MPIDR `gicv3::mpidr(i)`). The JIT's code cache
    /// lives in vCPU 0's `jit.cache` and moves to another vCPU while it runs
    /// a chunk (one cache for every vCPU of the thread: block code takes the
    /// `Vcpu` pointer).
    pub vcpus: Vec<Box<Vcpu>>,
    sched: Vec<Sched>,
    /// The vCPU running (or last run), and the steps left in its quantum
    /// (u64::MAX with one vCPU).
    cur: usize,
    quantum: u64,
    pub mem: Mem,
    pub gic: Intc,
    pub uart: Pl011,
    pub virtio: Vec<Transport>,
    pub shared: Arc<Shared>,
    pub exit: ExitInfo,
    pub(crate) cfg: VmConfig,
    /// Steps of every vCPU (virtual time counts them all).
    steps: u64,
    /// Ticks WFI jumped over.
    skipped: u64,
    clock: Clock,
}

/// The host clock for realtime mode: `performance.now()` through the core's
/// `env.now_ms` import on wasm, `Instant` natively.
struct Clock {
    #[cfg(target_arch = "wasm32")]
    t0: f64,
    #[cfg(not(target_arch = "wasm32"))]
    t0: std::time::Instant,
}

#[cfg(target_arch = "wasm32")]
#[link(wasm_import_module = "env")]
unsafe extern "C" {
    /// Milliseconds on a monotonic clock (the host passes `performance.now`).
    pub(crate) fn now_ms() -> f64;
}

impl Clock {
    fn new() -> Clock {
        #[cfg(target_arch = "wasm32")]
        // SAFETY: a host function with no preconditions.
        return Clock {
            t0: unsafe { now_ms() },
        };
        #[cfg(not(target_arch = "wasm32"))]
        Clock {
            t0: std::time::Instant::now(),
        }
    }

    /// Nanoseconds since the VM was created.
    fn ns(&self) -> u64 {
        #[cfg(target_arch = "wasm32")]
        // SAFETY: as in `new`.
        return ((unsafe { now_ms() } - self.t0) * 1e6) as u64;
        #[cfg(not(target_arch = "wasm32"))]
        (self.t0.elapsed().as_nanos() as u64)
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
// PSCI return codes.
const PSCI_SUCCESS: i64 = 0;
const PSCI_NOT_SUPPORTED: i64 = -1;
const PSCI_INVALID_PARAMETERS: i64 = -2;
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
        let v3 = cfg.gic_version() == 3;
        let features = cfg.features
            | if v3 { crate::cpu::FEATURE_GICV3 } else { 0 }
            | if n > 1 { crate::cpu::FEATURE_SMP } else { 0 };
        let mut vcpus: Vec<_> = (0..n)
            .map(|i| {
                Vcpu::new(Cpu {
                    pc: RAM_BASE,
                    features,
                    mpidr: gicv3::mpidr(i),
                    ..Cpu::reset()
                })
            })
            .collect();
        vcpus[0].jit.cache = match cfg.jit {
            0 => None,
            1 => Some(jit::Config::DEFAULT),
            _ => Some(jit::Config::STRESS),
        }
        .map(|c| {
            let mut cache = jit::Cache::new(c);
            cache.features = features;
            Box::new(cache)
        });
        let off = Sched {
            power: Power::Off,
            wait: Wait::No,
            event: false,
        };
        let mut sched = vec![off; n];
        sched[0].power = Power::On;
        Vm {
            vcpus,
            sched,
            cur: 0,
            quantum: if n > 1 { QUANTUM } else { u64::MAX },
            mem: mem.at(RAM_BASE),
            gic: if v3 {
                Intc::V3(Box::new(Gicv3::new(n)))
            } else {
                Intc::V2(Box::default())
            },
            uart: Pl011::default(),
            virtio: devices.iter().map(|&e| Transport::new(e)).collect(),
            shared: Arc::new(Shared {
                devices: devices.iter().map(|_| DevShared::default()).collect(),
                ..Shared::default()
            }),
            exit: ExitInfo::default(),
            cfg: VmConfig {
                cntfrq: pick(cfg.cntfrq, d.cntfrq),
                ticks_per_insn: pick(cfg.ticks_per_insn, d.ticks_per_insn),
                ..cfg
            },
            steps: 0,
            skipped: 0,
            clock: Clock::new(),
        }
    }

    fn realtime(&self) -> bool {
        self.cfg.deterministic == 0
    }

    /// Whether vCPU `c` is on (PSCI).
    pub fn power(&self, c: usize) -> Power {
        self.sched[c].power
    }

    /// The counter value (CNTPCT = CNTVCT), the same for every vCPU.
    pub fn now(&self) -> u64 {
        if self.realtime() {
            return (self.clock.ns() as u128 * self.cfg.cntfrq as u128 / 1_000_000_000) as u64;
        }
        self.steps * self.cfg.ticks_per_insn + self.skipped
    }

    /// Runs at most `budget` steps of all vCPUs; returns the exit kind, with
    /// details in `self.exit`. The vCPUs take turns on this thread, a quantum
    /// each in index order (deterministic round-robin); an off or waiting one
    /// is skipped.
    pub fn run(&mut self, budget: u64) -> u32 {
        let start = self.steps;
        self.exit = ExitInfo::default();
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
            if self.gic.irq(c) && self.vcpus[c].cpu.pstate & PSTATE_I == 0 {
                take_irq(&mut self.vcpus[c].cpu);
                self.retire(1);
                bump(&self.shared.counters.irqs);
                continue;
            }
            let n = CHUNK.min(left).min(self.until_deadline()).min(self.quantum);
            let (k, e) = self.chunk(c, n);
            self.retire(k);
            self.publish();
            if let Some(e) = e
                && let Some(kind) = self.handle(e)
            {
                break kind;
            }
        };
        self.publish();
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

    fn ready(&self, c: usize) -> bool {
        let s = &self.sched[c];
        s.power == Power::On
            && match s.wait {
                Wait::No | Wait::Woken => true,
                // WFI completes when an interrupt is signaled, masked or not.
                Wait::Wfi => self.gic.irq(c),
            }
    }

    /// Every vCPU is off or waiting. Deterministic time jumps to the next timer
    /// deadline (the vCPUs it was for complete their WFI); realtime mode, or no
    /// deadline, returns the idle exit.
    ///
    /// One reading of the counter decides both whether a timer fires and the
    /// deadline: in realtime mode the clock moves between reads, and a timer
    /// due between two of them was neither pending nor a future deadline, so
    /// the host slept with no deadline for good (found in M6.5 loop 5).
    fn idle(&mut self) -> Option<u32> {
        let now = self.now();
        self.lines_at(now);
        if (0..self.vcpus.len()).any(|c| self.ready(c)) {
            return None;
        }
        match self.next_deadline_at(now) {
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
                let frq = self.cfg.cntfrq as u128;
                self.exit.value = t.map_or(u64::MAX, |t| {
                    ((t - now) as u128 * 1_000_000_000).div_ceil(frq) as u64
                });
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
        let c = &self.shared.counters;
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
            let s = j.stats;
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
            ];
            for (a, v) in c.jit.iter().zip(v) {
                a.store(v, Ordering::Relaxed);
            }
        }
    }

    /// Drains every backend's completions; true if that posted new requests
    /// (chains that hadn't fit before), with `exit.value` set.
    fn complete(&mut self) -> bool {
        let mut any = false;
        for (i, (t, sh)) in self.virtio.iter_mut().zip(&self.shared.devices).enumerate() {
            let ev = t.complete(&self.mem, sh);
            if ev != 0 {
                sh.events.fetch_or(ev, Ordering::AcqRel);
                if !any {
                    self.exit.value = (i as u64) | (ev as u64) << 8;
                }
                any = true;
            }
        }
        any
    }

    /// Drives the timers' and devices' interrupt lines into the GIC.
    fn lines(&mut self) {
        self.lines_at(self.now());
    }

    /// [`Vm::lines`] with the counter at `now`.
    fn lines_at(&mut self, now: u64) {
        let fires = |ctl, cval| interp::timer_fires(ctl, cval, now);
        for (i, v) in self.vcpus.iter().enumerate() {
            let c = &v.cpu;
            let (vt, pt) = (
                fires(c.cntv_ctl_el0, c.cntv_cval_el0),
                fires(c.cntp_ctl_el0, c.cntp_cval_el0),
            );
            self.gic.set_level(i, IRQ_VTIMER, vt);
            self.gic.set_level(i, IRQ_PTIMER, pt);
        }
        let irq = self.uart.irq(&self.shared.console.rx);
        self.gic.set_level(0, IRQ_UART, irq);
        for (i, t) in self.virtio.iter().enumerate() {
            self.gic.set_level(0, virtio::IRQ_BASE + i, t.irq());
        }
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
        let c = &self.vcpus[c].cpu;
        [
            (c.cntv_ctl_el0, c.cntv_cval_el0),
            (c.cntp_ctl_el0, c.cntp_cval_el0),
        ]
        .into_iter()
        .filter(|&(ctl, cval)| ctl & 3 == 1 && cval > now)
        .map(|(_, cval)| cval)
        .min()
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
                // The code cache is home in vCPU 0 between chunks.
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
                if let (Some(r), Intc::V3(g)) =
                    (sys::icc(cpu.features, i >> 5 & 0xffff), &mut self.gic)
                {
                    let (rt, read) = (i & 31, i & 1 << 21 != 0);
                    let v = g.icc(c, r, (!read).then(|| cpu.reg(rt)));
                    if read {
                        cpu.set_reg(rt, v);
                    }
                } else {
                    let (now, irq) = (self.now(), self.gic.irq(c));
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
        bump(&self.shared.counters.exceptions[ec]);
    }

    /// WFI completes at once when an interrupt is signaled to vCPU `c` (masked
    /// or not); otherwise the vCPU waits with the PC on it ([`Vm::pick`]
    /// passes it over, [`Vm::idle`] moves time on when every vCPU waits).
    fn wfi(&mut self, c: usize) {
        let now = self.now();
        self.lines_at(now);
        if self.gic.irq(c) {
            let cpu = &mut self.vcpus[c].cpu;
            cpu.pc = cpu.pc.wrapping_add(4);
            self.retire(1);
        } else {
            self.sched[c].wait = Wait::Wfi;
        }
    }

    /// Runs the instruction at the PC again through [`Io`], after it hit a non-RAM address.
    fn io(&mut self) -> Option<u32> {
        let Vm {
            vcpus,
            cur,
            mem,
            gic,
            uart,
            virtio,
            shared,
            ..
        } = self;
        let vcpu = &mut *vcpus[*cur];
        let mut io = Io {
            mmu: Mmu::new(mem, Some(&mut vcpu.tlb)),
            gic,
            uart,
            console: &shared.console,
            virtio,
            devices: &shared.devices,
            tx_full: false,
            device: None,
        };
        let r = interp::step_bus(&mut vcpu.cpu, &mut io);
        let (tx_full, device) = (io.tx_full, io.device);
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

    /// PSCI CPU_ON: vCPU `t` starts at `entry` in its reset state (EL1h, DAIF
    /// masked, the MMU off) with x0 = `context`.
    fn cpu_on(&mut self, t: usize, entry: u64, context: u64) {
        let v = &mut self.vcpus[t];
        let (features, mpidr) = (v.cpu.features, v.cpu.mpidr);
        v.cpu = Cpu {
            pc: entry,
            features,
            mpidr,
            ..Cpu::reset()
        };
        v.cpu.x[0] = context;
        v.tlb.flush_all();
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
        // SMC32 calls take 32-bit arguments; for the affinity calls the
        // MPIDR's Aff2–Aff0.
        let aff = |v: u64, smc64: bool| {
            if smc64 {
                v & 0xff_00ff_ffff
            } else {
                v & 0xff_ffff
            }
        };
        let r: i64 = match f {
            PSCI_VERSION => 1 << 16, // 1.0
            PSCI_FEATURES => match x[1] as u32 {
                PSCI_VERSION
                | PSCI_FEATURES
                | PSCI_CPU_ON
                | PSCI_CPU_ON_64
                | PSCI_CPU_OFF
                | PSCI_AFFINITY_INFO
                | PSCI_AFFINITY_INFO_64
                | PSCI_MIGRATE_INFO_TYPE
                | PSCI_SYSTEM_OFF
                | PSCI_SYSTEM_RESET => PSCI_SUCCESS,
                _ => PSCI_NOT_SUPPORTED,
            },
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
            PSCI_MIGRATE_INFO_TYPE => 2, // no Trusted OS to migrate
            PSCI_SYSTEM_OFF | PSCI_SYSTEM_RESET => {
                self.exit.x.copy_from_slice(&x[..4]);
                return Some(exit::PSCI);
            }
            _ => PSCI_NOT_SUPPORTED,
        };
        self.vcpus[c].cpu.x[0] = r as u64;
        None
    }
}

/// The bus for one instruction that touched a non-RAM physical address: RAM
/// through the MMU as usual, and device registers where the address is one.
struct Io<'a> {
    mmu: Mmu<'a>,
    gic: &'a mut Intc,
    uart: &'a mut Pl011,
    console: &'a Rings,
    virtio: &'a mut [Transport],
    devices: &'a [DevShared],
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
            GICD..0x0900_0000 => return self.gic.read(pa, size),
            UART..0x0900_1000 if size <= 4 => {
                let off = pa - UART;
                let w = self.uart.read(off & !3, self.console) >> (8 * (off & 3));
                Some(w & (u64::MAX >> (64 - 8 * size)) as u32)
            }
            virtio::MMIO_BASE..VIRTIO_END => {
                let (i, off) = virtio_slot(pa);
                return self
                    .virtio
                    .get_mut(i)?
                    .read(off, size, self.devices.get(i)?);
            }
            _ => None,
        }
        .map(u64::from)
    }

    fn dev_write(&mut self, pa: u64, size: u32, v: u64) -> Option<()> {
        match pa {
            GICD..0x0900_0000 => self.gic.write(pa, size, v),
            // Sub-word writes go to the register at the aligned offset (DR by writeb).
            UART..0x0900_1000 if size <= 4 && pa & 3 == 0 => {
                self.tx_full = !self.uart.write(pa - UART, v as u32, self.console);
                (!self.tx_full).then_some(())
            }
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
            _ => None,
        }
    }
}

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
                let pa = self.pa(c, va);
                self.dev_read(pa, size).ok_or(f)
            }
            r => r,
        }
    }

    fn write_el(&mut self, c: &Cpu, va: u64, size: u32, val: u64, el: u64) -> Result<(), Fault> {
        match self.mmu.write_el(c, va, size, val, el) {
            Err(f) if f.kind == FaultKind::Bus => {
                let pa = self.pa(c, va);
                self.dev_write(pa, size, val).ok_or(f)
            }
            r => r,
        }
    }

    fn fetch(&mut self, c: &Cpu, pc: u64) -> Result<u32, Fault> {
        self.mmu.fetch(c, pc)
    }

    fn maint(&mut self, c: &Cpu, va: u64, write: bool) -> Result<u64, Fault> {
        self.mmu.maint(c, va, write)
    }

    fn host_aligned(
        &mut self,
        c: &Cpu,
        va: u64,
        len: u64,
        access: Access,
    ) -> Result<*mut u8, Fault> {
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
