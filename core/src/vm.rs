//! A whole VM: one vCPU, RAM at `RAM_BASE`, the GICv2, the generic timer and the
//! PL011 at QEMU `virt`'s addresses, and the run loop that delivers IRQs, waits
//! in WFI and answers PSCI. lib.rs exports it (PLAN.md §2 "Host ABI for a whole VM").
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
use crate::interp::{self, Exit, platform, take_exception, take_irq};
use crate::jit;
use crate::mem::{Access, Fault, FaultKind, Mem};
use crate::mmu::{Bus, Mmu, Vcpu, walk};
use crate::pl011::{Pl011, Rings};
use crate::virtio::{self, DevShared, DeviceEntry, Transport};
use std::sync::Arc;

pub const RAM_BASE: u64 = 0x4000_0000;
pub const GICD: u64 = 0x0800_0000;
pub const GICC: u64 = 0x0801_0000;
pub const UART: u64 = 0x0900_0000;
/// INTIDs: the `arm,armv8-timer` PPIs on `virt` (virtual, physical) and SPI 1.
pub const IRQ_VTIMER: usize = 27;
pub const IRQ_PTIMER: usize = 30;
pub const IRQ_UART: usize = 33;
/// Steps between signal checks.
const CHUNK: u64 = 1024;

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

/// Why `Vm::run` returned. `repr(C)`: kind, steps this run, value, x0–x3.
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct ExitInfo {
    pub kind: u64,
    pub retired: u64,
    pub value: u64,
    pub x: [u64; 4],
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

pub struct Vm {
    pub vcpu: Box<Vcpu>,
    pub mem: Mem,
    pub gic: Gic,
    pub uart: Pl011,
    pub virtio: Vec<Transport>,
    pub shared: Arc<Shared>,
    pub exit: ExitInfo,
    pub(crate) cfg: VmConfig,
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
const PSCI_AFFINITY_INFO: u32 = 0x8400_0004;
const PSCI_AFFINITY_INFO_64: u32 = 0xc400_0004;
const PSCI_MIGRATE_INFO_TYPE: u32 = 0x8400_0006;
const PSCI_SYSTEM_OFF: u32 = 0x8400_0008;
const PSCI_SYSTEM_RESET: u32 = 0x8400_0009;
const PSCI_FEATURES: u32 = 0x8400_000a;

impl Vm {
    /// A VM over `mem` (placed at `RAM_BASE`), with the vCPU in its reset state at
    /// the start of RAM. Zeroes in `cfg` pick the defaults.
    pub fn new(mem: Mem, cfg: VmConfig) -> Vm {
        Vm::with_devices(mem, cfg, &[])
    }

    /// As [`Vm::new`], with a virtio-mmio transport per entry (valid ones, `DeviceEntry::valid`).
    pub fn with_devices(mem: Mem, cfg: VmConfig, devices: &[DeviceEntry]) -> Vm {
        assert!(devices.len() <= virtio::MAX_DEVICES && devices.iter().all(DeviceEntry::valid));
        let d = VmConfig::default();
        let pick = |v, d| if v == 0 { d } else { v };
        let mut vcpu = Vcpu::new(Cpu {
            pc: RAM_BASE,
            ..Cpu::reset()
        });
        vcpu.jit.cache = match cfg.jit {
            0 => None,
            1 => Some(jit::Config::DEFAULT),
            _ => Some(jit::Config::STRESS),
        }
        .map(|c| Box::new(jit::Cache::new(c)));
        Vm {
            vcpu,
            mem: mem.at(RAM_BASE),
            gic: Gic::default(),
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

    /// The counter value (CNTPCT = CNTVCT).
    pub fn now(&self) -> u64 {
        if self.realtime() {
            return (self.clock.ns() as u128 * self.cfg.cntfrq as u128 / 1_000_000_000) as u64;
        }
        self.steps * self.cfg.ticks_per_insn + self.skipped
    }

    /// Runs at most `budget` steps; returns the exit kind, with details in `self.exit`.
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
            if self.gic.irq() && self.vcpu.cpu.pstate & PSTATE_I == 0 {
                take_irq(&mut self.vcpu.cpu);
                self.steps += 1;
                bump(&self.shared.counters.irqs);
                continue;
            }
            let n = CHUNK.min(left).min(self.until_deadline());
            let v = &mut *self.vcpu;
            let (k, e) = if v.jit.cache.is_some() {
                // SAFETY: `v` is this VM's vCPU, not otherwise referenced during the call.
                unsafe { jit::steps(v, &self.mem, n) }
            } else {
                interp::steps(&mut v.cpu, &self.mem, Some(&mut v.tlb), n)
            };
            self.steps += k;
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
        kind
    }

    /// Copies the run loop's own counts into the shared counters (once per chunk).
    fn publish(&self) {
        let (c, t) = (&self.shared.counters, &self.vcpu.tlb.stats);
        c.retired.store(self.steps, Ordering::Relaxed);
        c.pc.store(self.vcpu.cpu.pc, Ordering::Relaxed);
        c.tlb_misses.store(t.misses, Ordering::Relaxed);
        c.tlb_walks.store(t.walks, Ordering::Relaxed);
        c.tlb_flushes.store(t.flushes, Ordering::Relaxed);
        if let Some(j) = &self.vcpu.jit.cache {
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

    /// Drives the device interrupt lines into the GIC.
    fn lines(&mut self) {
        let (c, now) = (&self.vcpu.cpu, self.now());
        let fires = |ctl, cval| interp::timer_fires(ctl, cval, now);
        self.gic
            .set_level(IRQ_VTIMER, fires(c.cntv_ctl_el0, c.cntv_cval_el0));
        self.gic
            .set_level(IRQ_PTIMER, fires(c.cntp_ctl_el0, c.cntp_cval_el0));
        let irq = self.uart.irq(&self.shared.console.rx);
        self.gic.set_level(IRQ_UART, irq);
        for (i, t) in self.virtio.iter().enumerate() {
            self.gic.set_level(virtio::IRQ_BASE + i, t.irq());
        }
    }

    /// The earliest compare value of an enabled, unmasked timer that hasn't fired yet.
    fn next_deadline(&self) -> Option<u64> {
        let (c, now) = (&self.vcpu.cpu, self.now());
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

    /// Completes an interpreter exit; `Some` ends the run with that kind.
    fn handle(&mut self, e: Exit) -> Option<u32> {
        let c = &mut self.vcpu.cpu;
        match e {
            Exit::Resync => self.steps += 1,
            Exit::Invalidate(pa) => {
                self.steps += 1;
                if let Some(j) = &mut self.vcpu.jit.cache {
                    j.invalidate(pa);
                }
            }
            Exit::Hvc(_) => {
                c.pc = c.pc.wrapping_add(4);
                self.steps += 1;
                return self.psci();
            }
            Exit::Unimplemented(op) => {
                self.exit.value = op as u64;
                return Some(exit::UNIMPLEMENTED);
            }
            Exit::Platform(i) => {
                let (now, irq) = (self.now(), self.gic.irq());
                let c = &mut self.vcpu.cpu;
                platform(c, i, now, self.cfg.cntfrq, irq);
                c.pc = c.pc.wrapping_add(4);
                self.steps += 1;
            }
            Exit::Wfi => return self.wfi(),
            Exit::Fault(Fault {
                kind: FaultKind::Bus,
                ..
            }) => return self.io(),
            e => self.exception(e),
        }
        None
    }

    fn exception(&mut self, e: Exit) {
        let c = &mut self.vcpu.cpu;
        take_exception(c, e);
        self.steps += 1;
        bump(&self.shared.counters.exceptions[(c.esr_el1 >> 26) as usize & 63]);
    }

    /// WFI completes when an interrupt is signaled (masked or not). Otherwise
    /// deterministic time jumps to the next timer deadline, and realtime mode
    /// (or no deadline) returns the idle exit with the PC on the WFI.
    fn wfi(&mut self) -> Option<u32> {
        self.lines();
        if !self.gic.irq() {
            let t = self.next_deadline();
            match t {
                Some(t) if !self.realtime() => self.skipped += t - self.now(),
                _ => {
                    let frq = self.cfg.cntfrq as u128;
                    self.exit.value = t.map_or(u64::MAX, |t| {
                        ((t - self.now()) as u128 * 1_000_000_000).div_ceil(frq) as u64
                    });
                    return Some(exit::IDLE);
                }
            }
        }
        let c = &mut self.vcpu.cpu;
        c.pc = c.pc.wrapping_add(4);
        self.steps += 1;
        None
    }

    /// Runs the instruction at the PC again through [`Io`], after it hit a non-RAM address.
    fn io(&mut self) -> Option<u32> {
        let Vm {
            vcpu,
            mem,
            gic,
            uart,
            virtio,
            shared,
            ..
        } = self;
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
                self.steps += 1;
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

    /// A PSCI call (HVC, PC already past it): answered here, or an exit for the host.
    fn psci(&mut self) -> Option<u32> {
        let x = &mut self.vcpu.cpu.x;
        let f = x[0] as u32;
        let r: i64 = match f {
            PSCI_VERSION => 1 << 16, // 1.0
            PSCI_FEATURES => match x[1] as u32 {
                PSCI_VERSION
                | PSCI_FEATURES
                | PSCI_AFFINITY_INFO
                | PSCI_AFFINITY_INFO_64
                | PSCI_MIGRATE_INFO_TYPE
                | PSCI_SYSTEM_OFF
                | PSCI_SYSTEM_RESET => 0,
                _ => -1,
            },
            PSCI_AFFINITY_INFO | PSCI_AFFINITY_INFO_64 => {
                // Only CPU 0 exists, and it's on.
                let aff = if f == PSCI_AFFINITY_INFO {
                    x[1] & 0xff_ffff
                } else {
                    x[1] & 0xff_00ff_ffff
                };
                if aff == 0 { 0 } else { -2 } // ON, INVALID_PARAMETERS
            }
            PSCI_MIGRATE_INFO_TYPE => 2, // no Trusted OS to migrate
            PSCI_SYSTEM_OFF | PSCI_SYSTEM_RESET => {
                self.exit.x.copy_from_slice(&x[..4]);
                return Some(exit::PSCI);
            }
            _ => -1, // NOT_SUPPORTED
        };
        x[0] = r as u64;
        None
    }
}

/// The bus for one instruction that touched a non-RAM physical address: RAM
/// through the MMU as usual, and device registers where the address is one.
struct Io<'a> {
    mmu: Mmu<'a>,
    gic: &'a mut Gic,
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
            GICD..0x0801_0000 => self.gic.dist_read(pa - GICD, size),
            GICC..0x0802_0000 => self.gic.cpu_read(pa - GICC, size),
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
            GICD..0x0801_0000 => self.gic.dist_write(pa - GICD, size, v as u32),
            GICC..0x0802_0000 => self.gic.cpu_write(pa - GICC, size, v as u32),
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
}

#[cfg(test)]
mod tests;
