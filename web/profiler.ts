// Starts the guest PC sampler (sampler-worker.ts) or the vCPU timeline (timeline-worker.ts) on a VM's shared memory.
import { Counter } from './counters.ts';

/** `counters`: a vCPU's counters block, or several (each sample reads every one). Returns stop(), which resolves to [pc hex, samples] pairs. */
export async function startSampler(memory: WebAssembly.Memory, counters: number | number[], periodUs = 20) {
  const worker = new Worker(new URL('./sampler-worker.ts', import.meta.url), { type: 'module' });
  const ctl = new SharedArrayBuffer(8);
  const flag = new Int32Array(ctl);
  worker.postMessage({ memory, pcAddrs: [counters].flat().map((c) => c + 8 * Counter.PC), ctl, periodUs });
  while (Atomics.load(flag, 1) === 0) await new Promise((r) => setTimeout(r, 1));
  return () =>
    new Promise<[string, number][]>((resolve) => {
      worker.onmessage = (e) => {
        worker.terminate();
        resolve(e.data);
      };
      Atomics.store(flag, 0, 1);
    });
}

/** Per vCPU in each timeline row, after the row's time (epoch ms): counters (web/counters.ts `Counter`) and liveness. */
export const TIMELINE_FIELDS = [
  'steps',
  'compileNs',
  'syscalls',
  'irqs',
  'outNs',
  'dsbWaitNs',
  'lockWaitNs',
  'invalidations',
  'enteredAt',
  'chunks',
  'jitSteps',
  'flushes',
] as const;
/**
 * The timeline's rows, flat: each is the time (epoch ms), then TIMELINE_FIELDS for each vCPU (`enteredAt`: when the
 * vCPU entered the `vm_run_cpu` call it's in, epoch ms, 0 when outside one; `chunks`: calls returned; `jitSteps`: steps
 * in compiled code; `flushes`: the cache's flushes this vCPU's table did).
 */
export type Timeline = { ncpus: number; periodMs: number; fields: string[]; rows: number[] };

/** The vCPU timeline every `periodMs` (up to `maxRows` rows); stop() resolves to it. */
export async function startTimeline(
  memory: WebAssembly.Memory,
  counters: number[],
  live: Float64Array | undefined,
  periodMs = 10,
  maxRows = 60_000,
) {
  const worker = new Worker(new URL('./timeline-worker.ts', import.meta.url), { type: 'module' });
  const ctl = new SharedArrayBuffer(8);
  const flag = new Int32Array(ctl);
  worker.postMessage({ memory, counters, live, ctl, periodMs, maxRows });
  while (Atomics.load(flag, 1) === 0) await new Promise((r) => setTimeout(r, 1));
  return () =>
    new Promise<Timeline>((resolve) => {
      worker.onmessage = (e) => {
        worker.terminate();
        resolve(e.data);
      };
      Atomics.store(flag, 0, 1);
      Atomics.notify(flag, 0);
    });
}

const pctl = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : 0;
};
/**
 * A vCPU timeline (web/profiler.ts) summed up per vCPU: millions of guest instructions a second (mean, and the 10 ms
 * bins' p10/p50/p90 while inside `vm_run_cpu`), ms a second outside it (idle or the host's) and compiling, and the
 * host's **stalls**: bins inside one call that retired nothing (a compile, V8's GC, a lock or a wait on the host:
 * the guest's clock runs on meanwhile), their ms a second and the longest run of them with the compile time in it;
 * and the calls longer than 50 ms (their start, ms from the timeline's start, ms, steps, compile ms).
 */
export function summarizeTimeline(t: Timeline) {
  const w = 1 + t.ncpus * t.fields.length,
    nrows = t.rows.length / w,
    f = (k: string) => t.fields.indexOf(k);
  const [S, C, OUT, IN, SYS] = [f('steps'), f('compileNs'), f('outNs'), f('enteredAt'), f('syscalls')];
  const at = (r: number, c: number, k: number) => t.rows[r * w + 1 + c * t.fields.length + k];
  const time = (r: number) => t.rows[r * w];
  const secs = nrows > 1 ? (time(nrows - 1) - time(0)) / 1000 : 0;
  const cpus = Array.from({ length: t.ncpus }, (_, c) => {
    const bins: number[] = [];
    let stallMs = 0,
      run = 0,
      runCompile = 0,
      worst = { ms: 0, compileMs: 0, at: 0 };
    const calls: { atMs: number; ms: number; Msteps: number; compileMs: number }[] = [];
    let call = { entered: 0, r: 0 };
    for (let r = 1; r < nrows; r++) {
      const dt = time(r) - time(r - 1),
        ds = at(r, c, S) - at(r - 1, c, S),
        dc = (at(r, c, C) - at(r - 1, c, C)) / 1e6;
      const same = at(r, c, IN) !== 0 && at(r, c, IN) === at(r - 1, c, IN);
      if (same) bins.push(ds / dt / 1e3);
      if (same && ds === 0) {
        stallMs += dt;
        run += dt;
        runCompile += dc;
        if (run > worst.ms) worst = { ms: run, compileMs: runCompile, at: time(r) - run - time(0) };
      } else {
        run = 0;
        runCompile = 0;
      }
      // A call ends when its entry time changes (or the vCPU left it): calls seen whole, over 50 ms.
      if (at(r, c, IN) !== call.entered) {
        if (call.entered && at(r - 1, c, IN) === call.entered && call.r > 0) {
          const ms = time(r) - call.entered;
          if (ms > 50)
            calls.push({
              atMs: Math.round(call.entered - time(0)),
              ms: Math.round(ms),
              Msteps: +((at(r, c, S) - at(call.r - 1, c, S)) / 1e6).toFixed(1),
              compileMs: +((at(r, c, C) - at(call.r - 1, c, C)) / 1e6).toFixed(1),
            });
        }
        call = { entered: at(r, c, IN), r };
      }
    }
    const d = (k: number) => at(nrows - 1, c, k) - at(0, c, k);
    return {
      cpu: c,
      mips: +(d(S) / secs / 1e6).toFixed(1),
      binMips: { p10: +pctl(bins, 0.1).toFixed(1), p50: +pctl(bins, 0.5).toFixed(1), p90: +pctl(bins, 0.9).toFixed(1) },
      outMs: +(d(OUT) / 1e6 / secs).toFixed(1),
      compileMs: +(d(C) / 1e6 / secs).toFixed(1),
      syscalls: Math.round(d(SYS) / secs),
      stallMs: +(stallMs / secs).toFixed(1),
      worstStall: { ms: Math.round(worst.ms), compileMs: +worst.compileMs.toFixed(1), atMs: Math.round(worst.at) },
      longCalls: calls.slice(0, 20),
    };
  });
  return { seconds: +secs.toFixed(1), rows: nrows, cpus };
}
