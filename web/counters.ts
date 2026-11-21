// The core's counters (`vm::Counters`, core/src/vm.rs) and the JIT's helper report, read from the shared memory.

/** u64 word indexes in `vm::Counters` (core/src/vm.rs). */
export const Counter = {
  STEPS: 0,
  EXCEPTIONS: 1,
  IRQS: 65,
  TLB_HITS: 66,
  TLB_MISSES: 67,
  TLB_WALKS: 68,
  TLB_FLUSHES: 69,
  PC: 70,
  // The JIT's (ABI 10, `jit::Stats`).
  JIT_BLOCKS: 71,
  JIT_MODULES: 72,
  JIT_BYTES: 73,
  JIT_COMPILE_NS: 74,
  JIT_STEPS: 75,
  JIT_DISPATCHES: 76,
  JIT_INVALIDATIONS: 77,
  JIT_FLUSHES: 78,
  // ABI 12: instructions compiled inline and as helper calls, inline instructions run.
  JIT_INLINE: 79,
  JIT_HELPERS: 80,
  JIT_INLINE_STEPS: 81,
  // ABI 13 (static): lazy flag setters stored and elided; conditions direct, computed and from memory.
  JIT_FLAGS_STORED: 82,
  JIT_FLAGS_ELIDED: 83,
  JIT_COND_DIRECT: 84,
  JIT_COND_COMPUTED: 85,
  JIT_COND_MEMORY: 86,
  // ABI 15: blocks in the compiled regions (JIT_BLOCKS counts regions).
  JIT_REGION_BLOCKS: 87,
  // ABI 16: edges back to a region's head (static).
  JIT_BACK_EDGES: 88,
  // ABI 17: loop regions compiled for a hot head compiled alone.
  JIT_TIER_UPS: 89,
  // ABI 25: stale blocks a parallel vCPU's checker tolerated.
  JIT_STALE: 90,
  // ABI 26 (parallel SMP): DSBs that waited for TLBI IS and their ns, TLBI IS and IC broadcasts,
  // queue drains, IDLE exits, contended platform-lock acquisitions and their ns, WFEs.
  PAR_DSB_WAITS: 91,
  PAR_DSB_WAIT_NS: 92,
  PAR_TLBI_IS: 93,
  PAR_IC: 94,
  PAR_DRAINS: 95,
  PAR_IDLES: 96,
  PAR_LOCK_CONTENDED: 97,
  PAR_LOCK_WAIT_NS: 98,
  PAR_WFES: 99,
  // ns out of vm_run_cpu between runs (idle, or in the host).
  PAR_OUT_NS: 100,
  // ABI 33: instructions the block interpreter ran, blocks it decoded, times its cache started over.
  DEC_STEPS: 101,
  DEC_BLOCKS: 102,
  DEC_CLEARS: 103,
  // ABI 36: modules installed from the compile worker, and compiled on the vCPU after waiting for it too long.
  JIT_WORKER_INSTALLS: 104,
  JIT_OVERDUE: 105,
  // ABI 37: times the worker's compiled module hadn't reached the vCPU yet, and runs ended early for it to arrive.
  JIT_PARKS: 106,
  JIT_PARK_EXITS: 107,
  // ABI 46: the JIT cache's lock (acquisitions, contended ones, ns waited), ns emitting, of those under the lock, ns
  // forming batches into regions.
  JIT_LOCKS: 108,
  JIT_LOCK_CONTENDED: 109,
  JIT_LOCK_WAIT_NS: 110,
  JIT_EMIT_NS: 111,
  JIT_EMIT_LOCKED_NS: 112,
  JIT_PLAN_NS: 113,
  // ABI 47: the core's heap: the JIT block map's prunes, flushes for a heap with no room for a map to grow, flushes for a
  // table that lacked modules whose bytes were dropped; the heap bytes a table's decoded blocks and its known blocks take.
  JIT_PRUNES: 114,
  JIT_RESCUES: 115,
  JIT_LAG_FLUSHES: 116,
  JIT_DEC_BYTES: 117,
  JIT_KNOWN_BYTES: 118,
  // ABI 48: jump-cache misses that found the lock held and ran their block interpreted instead of waiting.
  JIT_LOCK_SKIPPED: 119,
  // ABI 50: ns the block map's prunes took (under the cache's lock).
  JIT_PRUNE_NS: 120,
  // ABI 72: the block map's rescues alone (of JIT_RESCUES: a flush, its maps freed whole).
  JIT_MAP_RESCUES: 121,
  LEN: 122,
} as const;

/** A snapshot of counters read through `n` (word index → value); exceptions by EC only where non-zero. */
export function stats(n: (i: number) => number) {
  const exceptions: Record<string, number> = {};
  for (let ec = 0; ec < 64; ec++)
    if (n(Counter.EXCEPTIONS + ec)) exceptions[`0x${ec.toString(16)}`] = n(Counter.EXCEPTIONS + ec);
  return {
    steps: n(Counter.STEPS),
    irqs: n(Counter.IRQS),
    exceptions,
    tlbMisses: n(Counter.TLB_MISSES),
    tlbWalks: n(Counter.TLB_WALKS),
    tlbFlushes: n(Counter.TLB_FLUSHES),
    jit: {
      blocks: n(Counter.JIT_BLOCKS),
      modules: n(Counter.JIT_MODULES),
      bytes: n(Counter.JIT_BYTES),
      compileNs: n(Counter.JIT_COMPILE_NS),
      steps: n(Counter.JIT_STEPS),
      dispatches: n(Counter.JIT_DISPATCHES),
      invalidations: n(Counter.JIT_INVALIDATIONS),
      flushes: n(Counter.JIT_FLUSHES),
      inline: n(Counter.JIT_INLINE),
      helpers: n(Counter.JIT_HELPERS),
      inlineSteps: n(Counter.JIT_INLINE_STEPS),
      flagsStored: n(Counter.JIT_FLAGS_STORED),
      flagsElided: n(Counter.JIT_FLAGS_ELIDED),
      condDirect: n(Counter.JIT_COND_DIRECT),
      condComputed: n(Counter.JIT_COND_COMPUTED),
      condMemory: n(Counter.JIT_COND_MEMORY),
      regionBlocks: n(Counter.JIT_REGION_BLOCKS),
      backEdges: n(Counter.JIT_BACK_EDGES),
      tierUps: n(Counter.JIT_TIER_UPS),
      stale: n(Counter.JIT_STALE),
      decSteps: n(Counter.DEC_STEPS),
      decoded: n(Counter.DEC_BLOCKS),
      decClears: n(Counter.DEC_CLEARS),
      workerInstalls: n(Counter.JIT_WORKER_INSTALLS),
      overdue: n(Counter.JIT_OVERDUE),
      parks: n(Counter.JIT_PARKS),
      parkExits: n(Counter.JIT_PARK_EXITS),
      locks: n(Counter.JIT_LOCKS),
      lockContended: n(Counter.JIT_LOCK_CONTENDED),
      lockWaitNs: n(Counter.JIT_LOCK_WAIT_NS),
      emitNs: n(Counter.JIT_EMIT_NS),
      emitLockedNs: n(Counter.JIT_EMIT_LOCKED_NS),
      planNs: n(Counter.JIT_PLAN_NS),
      prunes: n(Counter.JIT_PRUNES),
      rescues: n(Counter.JIT_RESCUES),
      lagFlushes: n(Counter.JIT_LAG_FLUSHES),
      decBytes: n(Counter.JIT_DEC_BYTES),
      knownBytes: n(Counter.JIT_KNOWN_BYTES),
      lockSkipped: n(Counter.JIT_LOCK_SKIPPED),
      pruneNs: n(Counter.JIT_PRUNE_NS),
      mapRescues: n(Counter.JIT_MAP_RESCUES),
    },
    par: {
      dsbWaits: n(Counter.PAR_DSB_WAITS),
      dsbWaitNs: n(Counter.PAR_DSB_WAIT_NS),
      tlbiIs: n(Counter.PAR_TLBI_IS),
      ic: n(Counter.PAR_IC),
      drains: n(Counter.PAR_DRAINS),
      idles: n(Counter.PAR_IDLES),
      lockContended: n(Counter.PAR_LOCK_CONTENDED),
      lockWaitNs: n(Counter.PAR_LOCK_WAIT_NS),
      wfes: n(Counter.PAR_WFES),
      outNs: n(Counter.PAR_OUT_NS),
    },
  };
}

/** `jit_helper_report` of the vCPU at `cpu` (a `jit_new` vCPU, or `vm_cpu`), parsed. */
export function helperReport(
  ex: { jit_helper_report(v: number): number },
  memory: WebAssembly.Memory,
  cpu: number,
): { op: string; calls: number }[] {
  const p = ex.jit_helper_report(cpu);
  if (!p) return [];
  const bytes = new Uint8Array(memory.buffer, p);
  const text = new TextDecoder().decode(bytes.slice(0, bytes.indexOf(0)));
  return text
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const [op, n] = l.split(' ');
      return { op, calls: Number(n) };
    });
}
