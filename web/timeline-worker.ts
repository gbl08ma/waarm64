// The vCPU timeline (web/profiler.ts `startTimeline`, for benchmarks): beside the vCPU workers on the same shared
// memory, every `periodMs` it reads each vCPU's counters block (published at every chunk's end, 32768 steps) and its
// liveness slot, until ctl[0] is set; then replies with the rows. Sleeps between reads (no spinning).
import { CHUNKS, ENTERED, SLOTS } from './liveness.ts';
import { Counter } from './vm.ts';
import { TIMELINE_FIELDS, type Timeline } from './profiler.ts';

type Start = {
  memory: WebAssembly.Memory;
  counters: number[];
  live?: Float64Array;
  ctl: SharedArrayBuffer;
  periodMs: number;
  maxRows: number;
};
const WORDS = [
  Counter.STEPS,
  Counter.JIT_COMPILE_NS,
  Counter.EXCEPTIONS + 0x15,
  Counter.IRQS,
  Counter.PAR_OUT_NS,
  Counter.PAR_DSB_WAIT_NS,
  Counter.PAR_LOCK_WAIT_NS,
  Counter.JIT_INVALIDATIONS,
];
/** After the liveness fields: TIMELINE_FIELDS' `jitSteps`, `flushes`. */
const TAIL = [Counter.JIT_STEPS, Counter.JIT_FLUSHES];

self.onmessage = (e: MessageEvent<Start>) => {
  const { memory, counters, live, ctl, periodMs, maxRows } = e.data;
  const flag = new Int32Array(ctl);
  const n = counters.length,
    width = 1 + n * TIMELINE_FIELDS.length;
  const rows = new Float64Array(width * maxRows);
  let views = () => counters.map((c) => new BigUint64Array(memory.buffer, c, Counter.LEN));
  let vs = views();
  let k = 0;
  Atomics.store(flag, 1, 1); // started
  Atomics.notify(flag, 1);
  while (Atomics.load(flag, 0) === 0 && k < maxRows) {
    if (vs[0].buffer.byteLength !== memory.buffer.byteLength) vs = views();
    let at = k * width;
    rows[at++] = performance.timeOrigin + performance.now();
    for (let c = 0; c < n; c++) {
      for (const w of WORDS) rows[at++] = Number(Atomics.load(vs[c], w));
      rows[at++] = live ? live[c * SLOTS + ENTERED] : 0;
      rows[at++] = live ? live[c * SLOTS + CHUNKS] : 0;
      for (const w of TAIL) rows[at++] = Number(Atomics.load(vs[c], w));
    }
    k++;
    Atomics.wait(flag, 0, 0, periodMs);
  }
  const t: Timeline = {
    ncpus: n,
    periodMs,
    fields: [...TIMELINE_FIELDS],
    rows: Array.from(rows.subarray(0, k * width)),
  };
  self.postMessage(t);
};
