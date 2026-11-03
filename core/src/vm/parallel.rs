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
use core::sync::atomic::fence;

/// `CpuPar::state`: off (PSCI), running guest code in `run_cpu`, or out of it
/// (idle, or anywhere in the host).
const OFF: u32 = 0;
const RUN: u32 = 1;
const OUT: u32 = 2;

/// Queued TLB operations before a queue collapses them into one flush.
const QUEUE: usize = 64;

/// The DSB wait gives up (a deadlock: a bug) after this long *waiting*: see [`DsbBudget`].
pub(super) const DSB_LIMIT_NS: u64 = 10_000_000_000;
/// A pass of the DSB wait loop (a drain, a look at the others, a 1 ms wait) that took
/// longer than this is a stall of the waiting vCPU's own thread, not a wait.
pub(super) const DSB_PASS_MAX_NS: u64 = 100_000_000;
/// A DSB wait gives up after this many limits of wall time whatever the passes were.
const DSB_WALL_LIMITS: u64 = 10;

/// What a DSB wait counts against its limit. The wait is a deadlock detector, so
/// it counts the time it actually spent waiting: a pass that took much longer
/// than a pass does (the waiter's own worker was descheduled, paused by the
/// browser, or in a GC) says nothing about the vCPUs it waits for, and after it
/// the loop looks at their state again anyway. Those passes are kept apart
/// (`stalled`, `longest`) for the report, and a wall-time backstop of
/// [`DSB_WALL_LIMITS`] limits keeps a waiter that is always stalled from
/// hanging. A vCPU frozen in RUN (BUG1's deadlock) still ends the wait after
/// `limit` of ordinary passes.
#[derive(Debug, Default)]
pub(super) struct DsbBudget {
    limit: u64,
    pass_max: u64,
    /// Ns of ordinary passes.
    counted: u64,
    /// Ns of passes over `pass_max`, and the longest pass.
    stalled: u64,
    longest: u64,
    /// Ns of all passes.
    wall: u64,
}

impl DsbBudget {
    pub(super) fn new(limit: u64, pass_max: u64) -> DsbBudget {
        DsbBudget {
            limit,
            pass_max,
            ..DsbBudget::default()
        }
    }

    /// Accounts a pass of `ns`; whether the wait has run out.
    pub(super) fn pass(&mut self, ns: u64) -> bool {
        self.wall += ns;
        self.longest = self.longest.max(ns);
        if ns > self.pass_max {
            self.stalled += ns;
        } else {
            self.counted += ns;
        }
        self.counted >= self.limit || self.wall >= self.limit.saturating_mul(DSB_WALL_LIMITS)
    }

    /// The report's line about the waiting vCPU's own timing.
    pub(super) fn line(&self) -> String {
        let ms = |ns: u64| ns / 1_000_000;
        format!(
            "\n  waiter: {} ms waiting of {} ms wall; passes over {} ms (its own thread stalled): {} ms, longest pass {} ms",
            ms(self.counted),
            ms(self.wall),
            ms(self.pass_max),
            ms(self.stalled),
            ms(self.longest)
        )
    }
}

/// A vCPU's parallel-mode words that other vCPUs read or write.
pub(super) struct CpuPar {
    pub(super) state: AtomicU32,
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
    /// The ASID its TLB holds nG entries of, published before each chunk;
    /// `ANY` with the MMU off or before it runs. A TTBR write changing it
    /// mid-chunk needs an ISB before the new ASID is promised to translate,
    /// and the ISB ends the chunk (and drains the queue).
    asid: AtomicU64,
}

/// [`jit::Fast::f`] for a [`Vm`] in parallel mode ([`Vm::fast`]).
///
/// # Safety
/// `ctx` is the `Vm` whose run loop set the hook, running vCPU `c` as `v`.
unsafe fn fast_exit(ctx: *const (), c: usize, v: &mut Vcpu, insn: u32, e: Exit) -> bool {
    // SAFETY: guaranteed by the caller.
    let vm = unsafe { &*ctx.cast::<Vm>() };
    vm.fast(c, v, insn, e)
}

/// Steps between two publications of a running vCPU's JIT and TLB counters
/// (`publish_cpu`): ~0.1 ms of guest code at the JIT's speed.
const JIT_PUBLISH: u64 = 1 << 16;

/// Steps between two checks of a running vCPU's timers against the clock
/// (`run_loop`, between chunks), unless their registers change: a few µs of guest code.
const TIMER_STEPS: u64 = 4096;

/// `CpuPar::asid` when a TLBI IS must wait for the vCPU whatever its ASID
/// (`mmu::Tlb::miss` stores it too).
const ANY: u64 = u64::MAX;

impl CpuPar {
    /// Its published ASID's word, for its TLB (`Tlb::published`).
    pub(super) fn asid_word(&self) -> *const AtomicU64 {
        &self.asid
    }
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
            asid: AtomicU64::new(ANY),
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
    /// Operations ever queued (its `applied` catches up at each drain).
    queued: u64,
}

/// One broadcast operation: a TLBI IS (op2, VA, and the ASID it's
/// limited to, `ANY` for every ASID). ICs aren't broadcast: the code cache
/// is shared, and every vCPU's table catches up before its next block
/// (docs/jit.md "Sharing").
#[derive(Clone, Copy, Debug)]
enum Op {
    Tlb(u32, u64, u64),
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
    /// When its last run ended (clock ns), if it ran.
    out: Option<u64>,
    /// `steps` when its JIT's counters were last published (`publish_cpu`).
    jit_at: u64,
    /// `steps` when its timers were last checked against the clock, and
    /// their registers then (CNTV_CTL, CNTV_CVAL, CNTP_CTL, CNTP_CVAL; `None`:
    /// not checked yet, as after a restore).
    timer_at: u64,
    timer_regs: Option<[u64; 4]>,
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
        self.clock.start();
        // SAFETY: guaranteed by the caller.
        let (v, own) = unsafe { self.vcpus[c].parts() };
        let p = &self.shared.cpus[c].par;
        own.exit = ExitInfo::default();
        let start = own.steps;
        if let Some(t) = own.out {
            add(
                &self.shared.cpus[c].counters.par[PAR_OUT_NS],
                self.clock.ns() - t,
            );
        }
        // Before anything uses its TLB: then a DSB elsewhere either saw it
        // out (and it drains below) or waits for it.
        if p.state.load(Ordering::SeqCst) != OFF {
            p.state.store(RUN, Ordering::SeqCst);
        }
        // The window's watch: running before the loop's first catch-up, which a host bump after this store waits for.
        if let Some(w) = self.mem.watch() {
            w.set_running(c, true);
        }
        let kind = self.run_loop(c, v, own, budget);
        if let Some(w) = self.mem.watch() {
            v.tlb.leave(&self.mem, c);
            w.set_running(c, false);
        }
        let _ = p
            .state
            .compare_exchange(RUN, OUT, Ordering::SeqCst, Ordering::SeqCst);
        self.publish_cpu(c, v, own, true);
        own.out = Some(self.clock.ns());
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
        if let Some(j) = &mut v.jit.cache {
            j.unpark();
        }
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
                self.refresh(&mut self.plat_of(c));
            }
            if sig & SIGNAL_DEVICE != 0
                && self
                    .shared
                    .signal
                    .fetch_and(!SIGNAL_DEVICE, Ordering::AcqRel)
                    & SIGNAL_DEVICE
                    != 0
            {
                let ns = self.ns();
                let mut pl = self.plat_of(c);
                let r = complete(&mut pl, &self.mem, &self.shared, ns);
                self.refresh(&mut pl);
                drop(pl);
                if let Some(value) = r {
                    own.exit.value = value;
                    return exit::DEVICE;
                }
            }
            if p.state.load(Ordering::SeqCst) == OFF {
                let mut pl = self.plat_of(c);
                let Some((entry, context)) = pl.start[c].take() else {
                    own.exit.value = u64::MAX;
                    own.exit.wake = wake as u64;
                    return exit::IDLE;
                };
                // Under the lock, with the request taken: another CPU_ON
                // must see it on (found by `smp`'s check 4).
                p.state.store(RUN, Ordering::SeqCst);
                // The timer lines as the GIC has them (high if they were at CPU_OFF), so the
                // reset timer's first check drives them low (as `set_sched_par` takes them).
                let ppi = (pl.gic.level(c, IRQ_VTIMER), pl.gic.level(c, IRQ_PTIMER));
                drop(pl);
                cpu_on(v, entry, context);
                *own = Own {
                    steps: own.steps,
                    ppi,
                    ..Own::default()
                };
            }
            self.drain(c, v);
            if own.steps - start >= budget {
                return exit::BUDGET;
            }
            // The timers against the clock (a host call) when TIMER_STEPS steps passed since they last were,
            // their registers changed, or the vCPU waits in WFI. This runs between chunks, so a timer that
            // comes due between is seen less than TIMER_STEPS plus a chunk (up to CHUNK) steps late (and at
            // once by a guest that looks: `Exit::Platform`).
            let regs = [
                v.cpu.cntv_ctl_el0,
                v.cpu.cntv_cval_el0,
                v.cpu.cntp_ctl_el0,
                v.cpu.cntp_cval_el0,
            ];
            let check =
                own.wfi || own.timer_regs != Some(regs) || own.steps - own.timer_at >= TIMER_STEPS;
            let now = if check { self.now() } else { 0 };
            if check {
                self.drive_timers(c, v, own, now);
            }
            // The xHCI's completions once their latency passed. An idle vCPU waits for that too
            // (below): another one may be what keeps the machine busy.
            let due = self.shared.xhci_due.load(Ordering::Relaxed);
            if due != u64::MAX && self.ns() >= due {
                let ns = self.ns();
                let mut pl = self.plat_of(c);
                let (Some(x), Some(xs)) = (&mut pl.xhci, &self.shared.xhci) else {
                    unreachable!("a due time without an xHCI")
                };
                let ev = x.tick(ns, false, &self.mem, xs);
                self.refresh(&mut pl);
                drop(pl);
                if ev != 0 {
                    own.exit.value = xhci::EXIT_SLOT | (ev as u64) << 8;
                    return exit::DEVICE;
                }
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
                // Woken for the xHCI's next completions too.
                let due = self.shared.xhci_due.load(Ordering::Relaxed);
                if due != u64::MAX {
                    own.exit.value = own.exit.value.min(due.saturating_sub(self.ns()));
                }
                own.exit.wake = wake as u64;
                bump(&sh.counters.par[PAR_IDLES]);
                return exit::IDLE;
            }
            if irq && v.cpu.pstate & PSTATE_I == 0 {
                take_irq(&mut v.cpu);
                own.steps += 1;
                bump(&sh.counters.irqs);
                continue;
            }
            // Before the chunk translates anything (`broadcast`).
            if self.vcpus.len() > 1 {
                // `ANY` too while its TLB may hold global TTBR0-half entries (`Tlb::low_global`).
                let asid = if v.cpu.sctlr_el1 & sctlr::M != 0 && !v.tlb.low_global {
                    crate::mmu::asid(&v.cpu)
                } else {
                    ANY
                };
                if p.asid.load(Ordering::Relaxed) != asid {
                    p.asid.store(asid, Ordering::SeqCst);
                }
                fence(Ordering::SeqCst);
            }
            // Shorter while the PC sampler runs (`Shared::chunk`): the PC is published at each chunk's end.
            let chunk = match self.shared.chunk.load(Ordering::Relaxed) {
                0 => CHUNK,
                k => k.min(CHUNK),
            };
            let n = chunk.min(budget - (own.steps - start));
            // The helpers' fast completions (`fast`): realtime only, as the counter they read is the host's clock.
            v.jit.fast = (self.realtime() && own.waits.is_empty()).then_some(jit::Fast {
                f: fast_exit,
                ctx: (self as *const Vm).cast(),
                cpu: c,
            });
            #[cfg(target_arch = "wasm32")]
            if self.realtime() {
                v.jit.counter = self.counter();
            }
            let (k, e) = if v.jit.cache.is_some() {
                // SAFETY: `v` is this thread's vCPU, not otherwise referenced during the call.
                unsafe { jit::steps(v, &self.mem, n) }
            } else if interp::debug::armed(&v.cpu) {
                interp::debug::steps(&mut v.cpu, &self.mem, Some(&mut v.tlb), n, false)
            } else {
                interp::steps(&mut v.cpu, &self.mem, Some(&mut v.tlb), n)
            };
            v.jit.fast = None;
            own.steps += k;
            self.publish_cpu(c, v, own, false);
            if let Some(e) = e
                && let Some(kind) = self.handle_par(c, v, own, e)
            {
                return kind;
            }
            // Early, for the host's event loop to deliver a compiled module
            // (`jit::Jit::park_exit`); the host tells it by the steps.
            if v.jit.cache.as_mut().is_some_and(|j| j.park_exit()) {
                return exit::BUDGET;
            }
        }
    }

    /// Finishes in place, for the JIT's helper, an exit of vCPU `c` that the run
    /// loop would only complete and go on from: a counter read, and the
    /// context synchronization of ISB, DSB, ERET and DAIF writes when this
    /// vCPU has nothing queued to drain, no TLBI IS of its own to wait for (the
    /// hook is set only then), its ASID published, and no IRQ to take; an ISB
    /// also not while its JIT table is behind the cache. A timer
    /// that comes due meanwhile is seen at the chunk's end, as anywhere else
    /// in a chunk. Returns false (nothing changed) otherwise.
    fn fast(&self, c: usize, v: &mut Vcpu, insn: u32, e: Exit) -> bool {
        use crate::decode::{Op, decode};
        match e {
            Exit::Platform(i) if sys::is_counter_read(i) => {
                v.cpu.set_reg(i & 31, self.now());
                v.cpu.pc = v.cpu.pc.wrapping_add(4);
                true
            }
            Exit::Resync => {
                let op = decode(insn);
                let sync = matches!(op, Op::ISB | Op::DSB | Op::ERET)
                    || matches!(op, Op::MSR_imm | Op::MSR_reg) && sys::is_daif_write(insn);
                let p = &self.shared.cpus[c].par;
                if !sync || p.pending.load(Ordering::SeqCst) {
                    return false;
                }
                if v.cpu.pstate & PSTATE_I == 0 && p.irq.load(Ordering::SeqCst) {
                    return false;
                }
                // An ISB that follows another vCPU's IC must fetch the new code: the block
                // would chain on through links and caches the table hasn't synced yet, so
                // it exits to the dispatcher, which catches up (`Jit::fresh`).
                if matches!(op, Op::ISB) && v.jit.cache.as_ref().is_some_and(|j| j.behind()) {
                    return false;
                }
                if self.vcpus.len() > 1 {
                    // As the run loop publishes it before a chunk (`broadcast`).
                    let asid = if v.cpu.sctlr_el1 & sctlr::M != 0 && !v.tlb.low_global {
                        crate::mmu::asid(&v.cpu)
                    } else {
                        ANY
                    };
                    if p.asid.load(Ordering::Relaxed) != asid {
                        return false;
                    }
                }
                fence(Ordering::SeqCst);
                true
            }
            _ => false,
        }
    }

    /// Drives vCPU `c`'s timer lines into the GIC as of counter value `now`
    /// (`run_loop` every [`TIMER_STEPS`] steps or when they may have changed,
    /// and before a platform access that can show them).
    fn drive_timers(&self, c: usize, v: &Vcpu, own: &mut Own, now: u64) {
        own.timer_at = own.steps;
        own.timer_regs = Some([
            v.cpu.cntv_ctl_el0,
            v.cpu.cntv_cval_el0,
            v.cpu.cntp_ctl_el0,
            v.cpu.cntp_cval_el0,
        ]);
        let ppi = timers(&v.cpu, now);
        if ppi != own.ppi {
            let mut pl = self.plat_of(c);
            pl.gic.set_level(c, IRQ_VTIMER, ppi.0);
            pl.gic.set_level(c, IRQ_PTIMER, ppi.1);
            self.refresh(&mut pl);
            own.ppi = ppi;
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
                if self.vcpus.len() > 1 {
                    bump(&self.shared.cpus[c].counters.par[PAR_IC]);
                }
            }
            // A yield (decision 5 of M7's kickoff): the chunk ended.
            Exit::Wfe => {
                own.steps += 1;
                bump(&self.shared.cpus[c].counters.par[PAR_WFES]);
            }
            Exit::Sev(_) => own.steps += 1,
            Exit::TlbiIs(i, xt) => {
                own.steps += 1;
                let op2 = i >> 5 & 7;
                // ASIDE1IS, VAE1IS and VALE1IS are for one ASID (Xt[63:48],
                // 8 bits wide unless TCR_EL1.AS); by VA, only the TTBR0 half's
                // (VA[55] = Xt[43]), where no global entry is cached.
                let wide = v.cpu.tcr_el1 >> 36 & 1 == 1;
                let asid = match op2 {
                    2 => xt >> 48,
                    1 | 5 if xt >> 43 & 1 == 0 => xt >> 48,
                    _ => ANY,
                };
                let asid = if asid == ANY || wide {
                    asid
                } else {
                    asid & 0xff
                };
                self.broadcast(c, own, Op::Tlb(op2, xt << 12, asid));
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
                // A guest reading a timer's ISTATUS, ISR_EL1 or the GIC sees its lines as of now.
                let now = self.now();
                if sys::shows_timers(i) {
                    self.drive_timers(c, v, own, now);
                }
                let cpu = &mut v.cpu;
                if let Some(r) = sys::icc(cpu.features, i >> 5 & 0xffff) {
                    let (rt, read) = (i & 31, i & 1 << 21 != 0);
                    let mut pl = self.plat_of(c);
                    let val = pl.gic.icc(c, r, (!read).then(|| cpu.reg(rt)));
                    self.refresh(&mut pl);
                    drop(pl);
                    if read {
                        cpu.set_reg(rt, val);
                    }
                } else if sys::is_rndr(i) {
                    sys::rndr(cpu, i, v.rng.draw());
                } else {
                    let irq = self.shared.cpus[c].par.irq.load(Ordering::SeqCst);
                    platform(cpu, i, now, self.cfg.cntfrq, irq);
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
                let mut pl = self.plat_of(c);
                let (r, tx_full, device) = io(
                    v,
                    &self.mem,
                    &mut pl,
                    &self.shared,
                    Time::Clock(&self.clock),
                );
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

    /// `Vm::plat`'s lock for vCPU `c`, counting the times it was held
    /// already and how long `c` waited.
    fn plat_of(&self, c: usize) -> MutexGuard<'_, Platform> {
        if let Some(g) = self.plat.try_lock() {
            return g;
        }
        let t0 = self.clock.ns();
        let g = self.plat.lock();
        let k = &self.shared.cpus[c].counters.par;
        bump(&k[PAR_LOCK_CONTENDED]);
        add(&k[PAR_LOCK_WAIT_NS], self.clock.ns() - t0);
        g
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
    pub(super) fn wake(&self, i: usize) {
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
        bump(&self.shared.cpus[c].counters.par[PAR_TLBI_IS]);
        // Orders the guest's page-table stores before the ASID reads below
        // (the target publishes its ASID, then fences, then walks).
        fence(Ordering::SeqCst);
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
                Op::Tlb(kind, va, _) => q.tlb.push((kind, va)),
            }
            q.queued += 1;
            let seq = q.queued;
            s.par.pending.store(true, Ordering::SeqCst);
            drop(q);
            // A vCPU running another ASID holds no entry the operation
            // drops: it applies it at its next chunk boundary, unwaited.
            let Op::Tlb(_, _, asid) = op;
            let theirs = s.par.asid.load(Ordering::SeqCst);
            if asid == ANY || theirs == ANY || theirs == asid {
                match own.waits.iter_mut().find(|w| w.0 == t) {
                    Some(w) => w.1 = seq,
                    None => own.waits.push((t, seq)),
                }
            }
        }
    }

    /// Applies what other vCPUs queued for vCPU `c`.
    fn drain(&self, c: usize, v: &mut Vcpu) {
        v.tlb.catch_up(&self.mem, c);
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
        // The code cache is shared: the vCPU that issued the IC dropped the
        // blocks, and this one's table catches up before its next block runs.
        p.applied.store(queued, Ordering::SeqCst);
        bump(&self.shared.cpus[c].counters.par[PAR_DRAINS]);
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
        let began = self.progress(&own.waits);
        let mut budget = DsbBudget::new(self.dsb_limit_ns, self.dsb_pass_max_ns);
        loop {
            let pass = self.clock.ns();
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
            if budget.pass(self.clock.ns() - pass) {
                panic!("{}", self.dsb_report(c, own, &began, &budget));
            }
        }
        sh.par.waiting.store(false, Ordering::SeqCst);
        bump(&sh.counters.par[PAR_DSB_WAITS]);
        add(&sh.counters.par[PAR_DSB_WAIT_NS], self.clock.ns() - t0);
    }

    /// What the vCPUs in `waits` last published: (retired, PC).
    fn progress(&self, waits: &[(usize, u64)]) -> Vec<(u64, u64)> {
        waits
            .iter()
            .map(|&(t, _)| {
                let k = &self.shared.cpus[t].counters;
                (
                    k.retired.load(Ordering::Relaxed),
                    k.pc.load(Ordering::Relaxed),
                )
            })
            .collect()
    }

    /// The panic message of a DSB wait that timed out: for each vCPU still
    /// waited for, its state, `applied` against the sequence waited for, its
    /// queue, and its retired count and PC at the wait's start and now (a count
    /// that moved: it runs and something loses a queue entry; one that froze:
    /// it's inside one chunk or blocked, the PC says where it last was).
    fn dsb_report(&self, c: usize, own: &Own, began: &[(u64, u64)], budget: &DsbBudget) -> String {
        let now = self.progress(&own.waits);
        let mut s = format!("vCPU {c}: DSB waited 10 s for TLBI IS");
        for (i, &(t, seq)) in own.waits.iter().enumerate() {
            let p = &self.shared.cpus[t].par;
            let (queued, tlb, tlb_all) = match p.queue.try_lock() {
                Ok(q) => (q.queued, q.tlb.len(), q.tlb_all),
                Err(_) => (u64::MAX, 0, false),
            };
            let (b, n) = (began.get(i).copied().unwrap_or_default(), now[i]);
            s += &format!(
                "\n  vCPU {t}: state {} applied {} waited-for {seq} queued {queued} \
                 (queue: {tlb} tlb, all {tlb_all}) pending {} waiting {} \
                 retired {} -> {} pc {:#x} -> {:#x}",
                p.state.load(Ordering::SeqCst),
                p.applied.load(Ordering::SeqCst),
                p.pending.load(Ordering::SeqCst),
                p.waiting.load(Ordering::SeqCst),
                b.0,
                n.0,
                b.1,
                n.1,
            );
        }
        s += &budget.line();
        s += &format!(
            "\n  platform lock {}",
            if self.plat.try_lock().is_some() {
                "free"
            } else {
                "held"
            }
        );
        s
    }

    /// Whether vCPU `c` is on, or starting (parallel mode).
    pub(super) fn power_par(&self, c: usize) -> Power {
        let pl = self.plat_of(c);
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
                        let mut pl = self.plat_of(c);
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
                let _pl = self.plat_of(c);
                self.shared.cpus[c].par.state.store(OFF, Ordering::SeqCst);
                return None;
            }
            PSCI_SYSTEM_SUSPEND | PSCI_SYSTEM_SUSPEND_64 => {
                let mut pl = self.plat_of(c);
                let others = (0..self.vcpus.len()).any(|t| {
                    t != c
                        && (self.shared.cpus[t].par.state.load(Ordering::SeqCst) != OFF
                            || pl.start[t].is_some())
                });
                if others {
                    PSCI_DENIED
                } else {
                    // Doesn't return: the vCPU stops until the host wakes it.
                    self.shared.cpus[c].par.state.store(OFF, Ordering::SeqCst);
                    let (entry, context) = suspend_args(&x, f == PSCI_SYSTEM_SUSPEND_64);
                    pl.suspended = Some((c, entry, context));
                    self.shared.suspended.store(true, Ordering::Release);
                    return None;
                }
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

    /// vCPU `c`'s place in parallel mode, in a snapshot's form: whether it's
    /// on, whether it waits in WFI, and a CPU_ON request it hasn't taken.
    /// Every vCPU's thread is out of [`Vm::run_cpu`].
    pub(super) fn sched_par(&mut self, c: usize) -> (bool, bool, Option<(u64, u64)>) {
        let on = self.shared.cpus[c].par.state.load(Ordering::SeqCst) != OFF;
        let wfi = self.vcpus[c].own.get_mut().wfi;
        (on, on && wfi, self.plat.get_mut().start[c])
    }

    /// Puts vCPU `c` of a new VM where [`Vm::sched_par`] found it. Its timer
    /// lines are the GIC's (restored before this), so its first run drives
    /// only what changed since.
    pub(super) fn set_sched_par(
        &mut self,
        c: usize,
        on: bool,
        wfi: bool,
        start: Option<(u64, u64)>,
    ) {
        let state = if on { OUT } else { OFF };
        self.shared.cpus[c].par.state.store(state, Ordering::SeqCst);
        let p = self.plat.get_mut();
        p.start[c] = start;
        let ppi = (p.gic.level(c, IRQ_VTIMER), p.gic.level(c, IRQ_PTIMER));
        *self.vcpus[c].own.get_mut() = Own {
            ppi,
            wfi,
            ..Own::default()
        };
    }

    /// Publishes every vCPU's IRQ line from the GIC's state (after a restore).
    pub(super) fn refresh_all(&mut self) {
        let mut pl = self.plat.lock();
        self.refresh(&mut pl);
    }

    /// Publishes vCPU `c`'s counts in its counters block.
    /// Publishes vCPU `c`'s counters: the steps and PC at every chunk's end
    /// (the PC sampler's), the rest (the JIT's ~40 words) every
    /// [`JIT_PUBLISH`] steps, or always with `all` (the run's end): an exit
    /// that ends a chunk shouldn't pay for words the host reads a few times a
    /// second.
    fn publish_cpu(&self, c: usize, v: &Vcpu, own: &mut Own, all: bool) {
        let k = &self.shared.cpus[c].counters;
        k.retired.store(own.steps, Ordering::Relaxed);
        k.pc.store(v.cpu.pc, Ordering::Relaxed);
        if !all && own.steps - own.jit_at < JIT_PUBLISH {
            return;
        }
        own.jit_at = own.steps;
        let t = &v.tlb.stats;
        k.tlb_misses.store(t.misses, Ordering::Relaxed);
        k.tlb_walks.store(t.walks, Ordering::Relaxed);
        k.tlb_flushes.store(t.flushes, Ordering::Relaxed);
        if let Some(j) = &v.jit.cache {
            publish_jit(k, &j.table.stats());
        }
    }
}
