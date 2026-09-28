//! Parallel SMP (`VmConfig.smp` = 1, realtime): every vCPU runs on its own
//! thread through [`Vm::run_cpu`], with its own code cache (docs/abi.md "M7
//! (SMP)", docs/platform.md "Parallel SMP").
//!
//! - What vCPUs share (the GIC, the PL011, the virtio transports, PSCI power
//!   states and CPU_ON requests) is behind `Vm::plat`'s lock. Each vCPU's IRQ
//!   line is an atomic that the platform code updates under the lock
//!   ([`Vm::refresh`]), so the path between chunks takes no lock unless a
//!   timer line changed or a signal came.
//! - **Wake-ups:** a vCPU with nothing to run returns `IDLE` with its wake word
//!   as read *before* it looked for work; whoever makes work for it (an
//!   interrupt, CPU_ON, a DSB waiting on it, a host signal) changes the state
//!   first, then bumps the word and notifies it, so the host's
//!   `Atomics.wait(word, wake)` can't miss one.
//! - **Broadcast maintenance:** TLBI IS and IC go into every other vCPU's
//!   queue; each drains its queue at chunk boundaries (DSB, ISB and ERET end
//!   the chunk under `cpu::FEATURE_PARALLEL`). A vCPU's DSB after TLBI IS
//!   waits until every other vCPU has applied it, or isn't running guest code
//!   (off, idle or back in the host: it drains before it runs again).

use super::*;

/// `CpuPar::state`: off (PSCI), running guest code in `run_cpu`, or out of it
/// (idle, or anywhere in the host).
const OFF: u32 = 0;
const RUN: u32 = 1;
const OUT: u32 = 2;

/// Queued TLB operations, and code pages, before a queue collapses them into
/// one flush. An idle vCPU collects the pages of every exec page fault
/// elsewhere until it wakes: 64 pages collapsed often enough to triple the
/// blocks compiled in an Alpine boot on 2 vCPUs.
const QUEUE: usize = 64;
const QUEUE_IC: usize = 1024;

/// The DSB wait gives up (a deadlock: a bug) after this long.
const DSB_LIMIT_NS: u64 = 10_000_000_000;

/// A vCPU's parallel-mode words that other vCPUs read or write.
pub(super) struct CpuPar {
    state: AtomicU32,
    /// Its GIC IRQ line, as the last platform update left it.
    irq: AtomicBool,
    /// Maintenance other vCPUs queued for it.
    queue: Mutex<Queue>,
    /// `queue` isn't empty (checked at every chunk boundary).
    pending: AtomicBool,
    /// `Queue::queued` as of its last drain.
    applied: AtomicU64,
    /// It's in a DSB wait: whoever drains a queue wakes it.
    waiting: AtomicBool,
}

impl Default for CpuPar {
    fn default() -> CpuPar {
        CpuPar {
            state: AtomicU32::new(OFF),
            irq: AtomicBool::new(false),
            queue: Mutex::default(),
            pending: AtomicBool::new(false),
            applied: AtomicU64::new(0),
            waiting: AtomicBool::new(false),
        }
    }
}

impl CpuShared {
    /// vCPU 0 is on at boot, the others off.
    pub(super) fn new(on: bool) -> CpuShared {
        let s = CpuShared::default();
        if on {
            s.par.state.store(OUT, Ordering::Relaxed);
        }
        s
    }
}

/// Broadcast maintenance for one vCPU.
#[derive(Default)]
struct Queue {
    /// TLBI IS operations as (op2, VA): op2 0 is VMALLE1IS, 2 ASIDE1IS, the
    /// rest by VA (as round-robin's `Exit::TlbiIs`).
    tlb: Vec<(u32, u64)>,
    tlb_all: bool,
    /// The physical pages of IC IVAUs, each once: the code cache drops
    /// blocks by page, and Linux cleans a page with an IC IVAU per line (64
    /// of them), which overflowed a queue of addresses into whole-cache
    /// flushes (6× the blocks compiled in an Alpine boot on 2 vCPUs).
    ic: Vec<u64>,
    ic_all: bool,
    /// Operations ever queued (its `applied` catches up at each drain).
    queued: u64,
}

/// One broadcast operation.
#[derive(Clone, Copy, Debug)]
enum Op {
    Tlb(u32, u64),
    Ic(u64),
}

/// A vCPU's run state, which only its own thread touches.
#[derive(Default)]
pub(super) struct Own {
    exit: ExitInfo,
    /// Its steps so far.
    steps: u64,
    /// The TLBI IS operations its next DSB waits for: (vCPU, that vCPU's
    /// `Queue::queued` after them).
    waits: Vec<(usize, u64)>,
    /// Its timer lines as last driven into the GIC (virtual, physical).
    ppi: (bool, bool),
    /// In WFI (the PC on it).
    wfi: bool,
}

/// Waits while `word` holds `expected`, at most `ns` nanoseconds (or until a
/// [`notify`]): `memory.atomic.wait32` on wasm (never on a page's main
/// thread), a short sleep natively.
pub fn wait(word: &AtomicU32, expected: u32, ns: u64) {
    #[cfg(target_arch = "wasm32")]
    // SAFETY: `word` is a valid, aligned u32 in the shared memory.
    unsafe {
        core::arch::wasm32::memory_atomic_wait32(
            word.as_ptr() as *mut i32,
            expected as i32,
            ns.min(i64::MAX as u64) as i64,
        );
    }
    #[cfg(not(target_arch = "wasm32"))]
    if word.load(Ordering::SeqCst) == expected {
        std::thread::sleep(std::time::Duration::from_nanos(ns.min(50_000)));
    }
}

/// Wakes every thread in [`wait`] (or `Atomics.wait`) on `word`.
pub fn notify(word: &AtomicU32) {
    #[cfg(target_arch = "wasm32")]
    // SAFETY: as in `wait`.
    unsafe {
        core::arch::wasm32::memory_atomic_notify(word.as_ptr() as *mut i32, u32::MAX);
    }
    #[cfg(not(target_arch = "wasm32"))]
    let _ = word;
}

impl Vm {
    /// Parallel mode: runs vCPU `c` on this thread until an exit or `budget`
    /// of its steps; returns the exit kind, with details in [`Vm::exit_of`].
    ///
    /// # Safety
    /// One thread at a time runs vCPU `c`, always on the same core instance
    /// (its code cache holds that instance's table indexes), and nothing
    /// else uses the vCPU meanwhile (`vm_cpu`'s registers are for between runs).
    pub unsafe fn run_cpu(&self, c: usize, budget: u64) -> u32 {
        assert!(self.parallel(), "vm_run_cpu in round-robin mode: vm_run");
        // SAFETY: guaranteed by the caller.
        let (v, own) = unsafe { self.vcpus[c].parts() };
        let p = &self.shared.cpus[c].par;
        own.exit = ExitInfo::default();
        let start = own.steps;
        // Before anything uses its TLB: then a DSB elsewhere either saw it
        // out (and it drains below) or waits for it.
        if p.state.load(Ordering::SeqCst) != OFF {
            p.state.store(RUN, Ordering::SeqCst);
        }
        let kind = self.run_loop(c, v, own, budget);
        let _ = p
            .state
            .compare_exchange(RUN, OUT, Ordering::SeqCst, Ordering::SeqCst);
        self.publish_cpu(c, v, own);
        own.exit.kind = kind as u64;
        own.exit.retired = own.steps - start;
        own.exit.cpu = c as u64;
        kind
    }

    /// Sets `bits` in the signal word, then bumps and notifies every vCPU's
    /// wake word (a host's `signal()`, docs/abi.md).
    pub fn signal(&self, bits: u32) {
        self.shared.signal.fetch_or(bits, Ordering::AcqRel);
        notify(&self.shared.signal);
        (0..self.vcpus.len()).for_each(|i| self.wake(i));
    }

    /// vCPU `c`'s last exit (parallel mode).
    pub fn exit_of(&self, c: usize) -> *const ExitInfo {
        // Only a pointer: its thread may be writing it.
        // SAFETY: `own` is valid for the VM's life; nothing is dereferenced.
        unsafe { &raw const (*self.vcpus[c].own.get()).exit }
    }

    fn run_loop(&self, c: usize, v: &mut Vcpu, own: &mut Own, budget: u64) -> u32 {
        let sh = &self.shared.cpus[c];
        let p = &sh.par;
        let start = own.steps;
        loop {
            // Read before looking for work (see the module docs).
            let wake = sh.wake.load(Ordering::SeqCst);
            let sig = self.shared.signal.load(Ordering::Acquire);
            if sig & SIGNAL_STOP != 0 {
                // Not cleared: every vCPU must see it; the host clears it.
                return exit::STOP;
            }
            if sig & SIGNAL_RX != 0
                && self.shared.signal.fetch_and(!SIGNAL_RX, Ordering::AcqRel) & SIGNAL_RX != 0
            {
                self.refresh(&mut self.plat.lock());
            }
            if sig & SIGNAL_DEVICE != 0
                && self
                    .shared
                    .signal
                    .fetch_and(!SIGNAL_DEVICE, Ordering::AcqRel)
                    & SIGNAL_DEVICE
                    != 0
            {
                let mut pl = self.plat.lock();
                let r = complete(&mut pl.virtio, &self.mem, &self.shared);
                self.refresh(&mut pl);
                drop(pl);
                if let Some(value) = r {
                    own.exit.value = value;
                    return exit::DEVICE;
                }
            }
            if p.state.load(Ordering::SeqCst) == OFF {
                let mut pl = self.plat.lock();
                let Some((entry, context)) = pl.start[c].take() else {
                    own.exit.value = u64::MAX;
                    own.exit.wake = wake as u64;
                    return exit::IDLE;
                };
                // Under the lock, with the request taken: another CPU_ON
                // must see it on (found by `smp`'s check 4).
                p.state.store(RUN, Ordering::SeqCst);
                drop(pl);
                cpu_on(v, entry, context);
                *own = Own {
                    steps: own.steps,
                    ..Own::default()
                };
            }
            self.drain(c, v);
            if own.steps - start >= budget {
                return exit::BUDGET;
            }
            let now = self.now();
            let ppi = timers(&v.cpu, now);
            if ppi != own.ppi {
                let mut pl = self.plat.lock();
                pl.gic.set_level(c, IRQ_VTIMER, ppi.0);
                pl.gic.set_level(c, IRQ_PTIMER, ppi.1);
                self.refresh(&mut pl);
                own.ppi = ppi;
            }
            let irq = p.irq.load(Ordering::SeqCst);
            if own.wfi {
                // WFI completes when an interrupt is signaled, masked or not.
                if irq {
                    own.wfi = false;
                    v.cpu.pc = v.cpu.pc.wrapping_add(4);
                    own.steps += 1;
                    continue;
                }
                let frq = self.cfg.cntfrq as u128;
                own.exit.value = deadline(&v.cpu, now).map_or(u64::MAX, |t| {
                    ((t - now) as u128 * 1_000_000_000).div_ceil(frq) as u64
                });
                own.exit.wake = wake as u64;
                return exit::IDLE;
            }
            if irq && v.cpu.pstate & PSTATE_I == 0 {
                take_irq(&mut v.cpu);
                own.steps += 1;
                bump(&sh.counters.irqs);
                continue;
            }
            let n = CHUNK.min(budget - (own.steps - start));
            let (k, e) = if v.jit.cache.is_some() {
                // SAFETY: `v` is this thread's vCPU, not otherwise referenced during the call.
                unsafe { jit::steps(v, &self.mem, n) }
            } else {
                interp::steps(&mut v.cpu, &self.mem, Some(&mut v.tlb), n)
            };
            own.steps += k;
            self.publish_cpu(c, v, own);
            if let Some(e) = e
                && let Some(kind) = self.handle_par(c, v, own, e)
            {
                return kind;
            }
        }
    }

    /// Completes an exit of vCPU `c`; `Some` ends the run with that kind.
    fn handle_par(&self, c: usize, v: &mut Vcpu, own: &mut Own, e: Exit) -> Option<u32> {
        match e {
            // DSB, ISB, ERET (context synchronization), and MSR unmasking IRQs.
            Exit::Resync => {
                own.steps += 1;
                self.sync(c, v, own);
            }
            Exit::Invalidate(pa) => {
                own.steps += 1;
                if let Some(j) = &mut v.jit.cache {
                    j.invalidate(pa);
                }
                self.broadcast(c, own, Op::Ic(pa));
            }
            // A yield (decision 5 of M7's kickoff): the chunk ended.
            Exit::Wfe | Exit::Sev(_) => own.steps += 1,
            Exit::TlbiIs(i, va) => {
                own.steps += 1;
                self.broadcast(c, own, Op::Tlb(i >> 5 & 7, va << 12));
            }
            Exit::Hvc(_) => {
                v.cpu.pc = v.cpu.pc.wrapping_add(4);
                own.steps += 1;
                return self.psci_par(c, v, own);
            }
            Exit::Unimplemented(op) => {
                own.exit.value = op as u64;
                return Some(exit::UNIMPLEMENTED);
            }
            Exit::Platform(i) => {
                let cpu = &mut v.cpu;
                if let Some(r) = sys::icc(cpu.features, i >> 5 & 0xffff) {
                    let (rt, read) = (i & 31, i & 1 << 21 != 0);
                    let mut pl = self.plat.lock();
                    let val = pl.gic.icc(c, r, (!read).then(|| cpu.reg(rt)));
                    self.refresh(&mut pl);
                    drop(pl);
                    if read {
                        cpu.set_reg(rt, val);
                    }
                } else {
                    let irq = self.shared.cpus[c].par.irq.load(Ordering::SeqCst);
                    platform(cpu, i, self.now(), self.cfg.cntfrq, irq);
                }
                v.cpu.pc = v.cpu.pc.wrapping_add(4);
                own.steps += 1;
            }
            // The loop completes it when an interrupt is signaled, or idles.
            Exit::Wfi => own.wfi = true,
            Exit::Fault(Fault {
                kind: FaultKind::Bus,
                ..
            }) => {
                let mut pl = self.plat.lock();
                let (r, tx_full, device) = io(v, &self.mem, &mut pl, &self.shared);
                self.refresh(&mut pl);
                drop(pl);
                match r {
                    Ok(()) => {
                        own.steps += 1;
                        if let Some(value) = device {
                            own.exit.value = value;
                            return Some(exit::DEVICE);
                        }
                    }
                    Err(_) if tx_full => return Some(exit::TX_FULL),
                    Err(e @ Exit::Fault(_)) => self.exception_par(c, v, own, e),
                    Err(e) => return self.handle_par(c, v, own, e),
                }
            }
            e => self.exception_par(c, v, own, e),
        }
        None
    }

    fn exception_par(&self, c: usize, v: &mut Vcpu, own: &mut Own, e: Exit) {
        take_exception(&mut v.cpu, e);
        let ec = (v.cpu.esr_el1 >> 26) as usize & 63;
        own.steps += 1;
        bump(&self.shared.cpus[c].counters.exceptions[ec]);
    }

    /// After a change to the platform (under its lock): drives the device
    /// lines and publishes every vCPU's IRQ line, waking those it raised.
    fn refresh(&self, pl: &mut Platform) {
        spis(pl, &self.shared);
        for (i, s) in self.shared.cpus.iter().enumerate() {
            let on = pl.gic.irq(i);
            if s.par.irq.swap(on, Ordering::SeqCst) != on && on {
                self.wake(i);
            }
        }
    }

    /// Bumps and notifies vCPU `i`'s wake word (after the change it's for).
    fn wake(&self, i: usize) {
        let w = &self.shared.cpus[i].wake;
        w.fetch_add(1, Ordering::SeqCst);
        notify(w);
    }

    /// Queues `op` for every other vCPU; a TLB operation is waited for at
    /// this vCPU's next DSB.
    fn broadcast(&self, c: usize, own: &mut Own, op: Op) {
        if self.vcpus.len() == 1 {
            return;
        }
        for (t, s) in self.shared.cpus.iter().enumerate() {
            if t == c {
                continue;
            }
            let mut q = s.par.queue.lock().unwrap_or_else(PoisonError::into_inner);
            match op {
                Op::Tlb(..) if q.tlb_all => {}
                Op::Tlb(..) if q.tlb.len() == QUEUE => {
                    q.tlb.clear();
                    q.tlb_all = true;
                }
                Op::Tlb(kind, va) => q.tlb.push((kind, va)),
                Op::Ic(_) if q.ic_all => {}
                // The same page as the last (an IC IVAU per line), or queued already.
                Op::Ic(pa)
                    if pa != u64::MAX
                        && (q.ic.last() == Some(&(pa & !0xfff))
                            || q.ic.contains(&(pa & !0xfff))) => {}
                Op::Ic(pa) if pa == u64::MAX || q.ic.len() == QUEUE_IC => {
                    q.ic.clear();
                    q.ic_all = true;
                }
                Op::Ic(pa) => q.ic.push(pa & !0xfff),
            }
            q.queued += 1;
            let seq = q.queued;
            s.par.pending.store(true, Ordering::SeqCst);
            drop(q);
            if let Op::Tlb(..) = op {
                match own.waits.iter_mut().find(|w| w.0 == t) {
                    Some(w) => w.1 = seq,
                    None => own.waits.push((t, seq)),
                }
            }
        }
    }

    /// Applies what other vCPUs queued for vCPU `c`.
    fn drain(&self, c: usize, v: &mut Vcpu) {
        let p = &self.shared.cpus[c].par;
        if !p.pending.load(Ordering::SeqCst) {
            return;
        }
        let mut q = p.queue.lock().unwrap_or_else(PoisonError::into_inner);
        p.pending.store(false, Ordering::SeqCst);
        let queued = q.queued;
        let q = core::mem::replace(
            &mut *q,
            Queue {
                queued,
                ..Queue::default()
            },
        );
        if q.tlb_all {
            v.tlb.flush_all();
        } else {
            for &(kind, va) in &q.tlb {
                match kind {
                    0 => v.tlb.flush_all(),
                    2 => v.tlb.flush_ng(),
                    _ => v.tlb.flush_va(va),
                }
            }
        }
        if let Some(j) = &mut v.jit.cache {
            if q.ic_all {
                j.invalidate(u64::MAX);
            } else {
                q.ic.iter().for_each(|&pa| j.invalidate(pa));
            }
        }
        p.applied.store(queued, Ordering::SeqCst);
        for (o, s) in self.shared.cpus.iter().enumerate() {
            if o != c && s.par.waiting.load(Ordering::SeqCst) {
                self.wake(o);
            }
        }
    }

    /// A context synchronization event or DSB of vCPU `c`: applies what's
    /// queued for it, then waits until every vCPU its TLBI IS operations
    /// went to has applied them or isn't running guest code.
    fn sync(&self, c: usize, v: &mut Vcpu, own: &mut Own) {
        self.drain(c, v);
        if own.waits.is_empty() {
            return;
        }
        let sh = &self.shared.cpus[c];
        sh.par.waiting.store(true, Ordering::SeqCst);
        let t0 = self.clock.ns();
        loop {
            let wake = sh.wake.load(Ordering::SeqCst);
            // Others may wait for this one meanwhile.
            self.drain(c, v);
            own.waits.retain(|&(t, seq)| {
                let o = &self.shared.cpus[t].par;
                o.state.load(Ordering::SeqCst) == RUN && o.applied.load(Ordering::SeqCst) < seq
            });
            if own.waits.is_empty() {
                break;
            }
            wait(&sh.wake, wake, 1_000_000);
            assert!(
                self.clock.ns() - t0 < DSB_LIMIT_NS,
                "vCPU {c}: DSB waited 10 s for TLBI IS on {:?}",
                own.waits
            );
        }
        sh.par.waiting.store(false, Ordering::SeqCst);
    }

    /// Whether vCPU `c` is on, or starting (parallel mode).
    pub(super) fn power_par(&self, c: usize) -> Power {
        let pl = self.plat.lock();
        if self.shared.cpus[c].par.state.load(Ordering::SeqCst) != OFF || pl.start[c].is_some() {
            Power::On
        } else {
            Power::Off
        }
    }

    /// A PSCI call (HVC, PC already past it) of vCPU `c`: answered here, or
    /// an exit for the host.
    fn psci_par(&self, c: usize, v: &mut Vcpu, own: &mut Own) -> Option<u32> {
        let x = v.cpu.x;
        let f = x[0] as u32;
        let r = match f {
            PSCI_AFFINITY_INFO | PSCI_AFFINITY_INFO_64 => {
                match self.cpu_of(psci_aff(x[1], f == PSCI_AFFINITY_INFO_64)) {
                    Some(t) if x[2] == 0 => (self.power_par(t) == Power::Off) as i64,
                    _ => PSCI_INVALID_PARAMETERS,
                }
            }
            PSCI_CPU_ON | PSCI_CPU_ON_64 => {
                let smc64 = f == PSCI_CPU_ON_64;
                let entry = if smc64 { x[2] } else { x[2] as u32 as u64 };
                let context = if smc64 { x[3] } else { x[3] as u32 as u64 };
                match self.cpu_of(psci_aff(x[1], smc64)) {
                    None => PSCI_INVALID_PARAMETERS,
                    Some(t) => {
                        let mut pl = self.plat.lock();
                        let off = self.shared.cpus[t].par.state.load(Ordering::SeqCst) == OFF;
                        if off && pl.start[t].is_none() {
                            pl.start[t] = Some((entry, context));
                            drop(pl);
                            self.wake(t);
                            PSCI_SUCCESS
                        } else {
                            PSCI_ALREADY_ON
                        }
                    }
                }
            }
            PSCI_CPU_OFF => {
                // Doesn't return: the vCPU stops until a CPU_ON starts it again.
                let _pl = self.plat.lock();
                self.shared.cpus[c].par.state.store(OFF, Ordering::SeqCst);
                return None;
            }
            PSCI_SYSTEM_OFF | PSCI_SYSTEM_RESET => {
                own.exit.x.copy_from_slice(&x[..4]);
                return Some(exit::PSCI);
            }
            f => psci_common(f, x[1]),
        };
        v.cpu.x[0] = r as u64;
        None
    }

    /// Publishes vCPU `c`'s counts in its counters block.
    fn publish_cpu(&self, c: usize, v: &Vcpu, own: &Own) {
        let k = &self.shared.cpus[c].counters;
        k.retired.store(own.steps, Ordering::Relaxed);
        k.pc.store(v.cpu.pc, Ordering::Relaxed);
        let t = &v.tlb.stats;
        k.tlb_misses.store(t.misses, Ordering::Relaxed);
        k.tlb_walks.store(t.walks, Ordering::Relaxed);
        k.tlb_flushes.store(t.flushes, Ordering::Relaxed);
        if let Some(j) = &v.jit.cache {
            publish_jit(k, &j.stats);
        }
    }
}
