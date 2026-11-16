//! The diagnostic build's tallies (the `diag` feature: `scripts/build-wasm.sh --features diag`; docs/benchmarking.md
//! "Preemption's counts"). A normal build has none of this: the words below exist only in the diagnostic core, the
//! JIT emits no counting code without it, and its host side (`bench/boot/preempt-counts.ts`) reads them past the end
//! of each vCPU's counters block (`vm::Counters::diag`), where the run loops publish them.
//!
//! What compiled code takes (counted in `mmu::Vcpu::diag` by the code itself, slots below [`JIT_SLOTS`]), how
//! parallel realtime chunks end (by the budget, or by an exit of each kind: [`END`] counts, [`END_STEPS`] their
//! steps), and two latencies of parallel mode (a timer line seen late, an interrupt line's rise to its IRQ).

/// Words in each table.
pub const N: usize = 64;

/// A region's loop back-edge taken (a `br` to the head's `loop`).
pub const BACK_EDGE: u32 = 0;
/// A region's edge to a later member taken (a static successor, a return predicted to its call's site, a host
/// call's continuation).
pub const FWD_EDGE: u32 = 1;
/// An indirect transfer (BR, BLR, RET) that hit the transfer cache.
pub const XC_HIT: u32 = 2;
/// The transfer cache's miss function entered (a probe's miss, a by-VA link's failed check, a host return that
/// landed elsewhere than its call's continuation).
pub const XC_MISS: u32 = 3;
/// An indirect transfer with the MMU off that hit the jump cache.
pub const JC_HIT: u32 = 4;
/// A static chain to a block compiled before this one (a direct call or tail call), target PA <= source PA.
pub const CHAIN_BACK: u32 = 5;
/// The same, target PA > source PA.
pub const CHAIN_FWD: u32 = 6;
/// A static successor compiled after this block, reached through the jump cache, target PA <= source PA.
pub const JC_BACK: u32 = 7;
/// The same, target PA > source PA.
pub const JC_FWD: u32 = 8;
/// A static successor in another page found by its VA in the transfer cache (nothing compiled at its PA), a hit,
/// the target VA <= the source VA.
pub const BYVA_BACK: u32 = 9;
/// The same, forward.
pub const BYVA_FWD: u32 = 10;
/// A guest call as a host call (`call`, `call_indirect`).
pub const HOST_CALL: u32 = 11;
/// A host call's return (`ret_up`).
pub const HOST_RET: u32 = 12;
/// Slots below this are compiled code's (copied from the vCPU's table at each publication).
pub const JIT_SLOTS: usize = 16;

/// How a parallel realtime chunk ended: `END + kind` counts them, `END_STEPS + kind` sums their steps.
pub const END: usize = 16;
pub const END_STEPS: usize = 32;
/// The kinds: the budget ran out (the steps reached the chunk), the dispatcher returned early with no exit
/// (a block that didn't fit, a parked module), then by the exit.
pub const BUDGET: usize = 0;
pub const EARLY: usize = 1;
pub const RESYNC: usize = 2;
pub const INVALIDATE: usize = 3;
pub const WFI: usize = 4;
pub const WFE: usize = 5;
pub const SEV: usize = 6;
pub const TLBI_IS: usize = 7;
pub const HVC: usize = 8;
pub const COUNTER: usize = 9;
pub const PLATFORM: usize = 10;
pub const DEVICE: usize = 11;
pub const SVC: usize = 12;
pub const EXCEPTION: usize = 13;
pub const OTHER: usize = 14;

/// A timer line of the vCPU's own seen high by the run loop (parallel): count, the counter ticks since its deadline
/// summed, their maximum; while running, then (`+ 3`) when the vCPU was in WFI.
pub const TIMER_LATE: usize = 48;
/// An interrupt line's rise (`Vm::refresh`, any thread) to the IRQ taken (parallel): count, ns summed, maximum;
/// taken while running, then (`+ 3`) a WFI completed by it.
pub const IRQ_LATE: usize = 54;
/// Of the IRQs taken while running: under 10 µs, under 100 µs, under 1 ms (the rest: the count less these).
pub const IRQ_HIST: usize = 60;
/// The ns of the line's rise not yet taken (0: none): not a count.
pub const IRQ_STAMP: usize = 63;

/// The [`END`] kind of a chunk that ended with exit `e` (`None`: no exit; `full`: the chunk's steps all ran).
#[cfg(feature = "diag")]
pub fn end_kind(e: Option<&crate::interp::Exit>, full: bool) -> usize {
    use crate::interp::Exit;
    use crate::mem::FaultKind;
    match e {
        None if full => BUDGET,
        None => EARLY,
        Some(Exit::Resync) => RESYNC,
        Some(Exit::Invalidate(_)) => INVALIDATE,
        Some(Exit::Wfi) => WFI,
        Some(Exit::Wfe) => WFE,
        Some(Exit::Sev(_)) => SEV,
        Some(Exit::TlbiIs(..)) => TLBI_IS,
        Some(Exit::Hvc(_)) => HVC,
        Some(Exit::Platform(i)) if crate::interp::sys::is_counter_read(*i) => COUNTER,
        Some(Exit::Platform(_)) => PLATFORM,
        Some(Exit::Fault(f)) if f.kind == FaultKind::Bus => DEVICE,
        Some(Exit::Svc(_)) => SVC,
        Some(Exit::Fault(_) | Exit::Fetch(_) | Exit::Undefined | Exit::Trap(_) | Exit::Brk(_)) => {
            EXCEPTION
        }
        Some(_) => OTHER,
    }
}

/// Adds `n` to word `i` (one writer, or a count where a lost update doesn't matter).
#[cfg(feature = "diag")]
pub fn add(w: &[core::sync::atomic::AtomicU64; N], i: usize, n: u64) {
    use core::sync::atomic::Ordering::Relaxed;
    w[i].fetch_add(n, Relaxed);
}

/// Records one latency of `v` into the triple at `i` (count, sum, maximum).
#[cfg(feature = "diag")]
pub fn late(w: &[core::sync::atomic::AtomicU64; N], i: usize, v: u64) {
    use core::sync::atomic::Ordering::Relaxed;
    w[i].fetch_add(1, Relaxed);
    w[i + 1].fetch_add(v, Relaxed);
    w[i + 2].fetch_max(v, Relaxed);
}
