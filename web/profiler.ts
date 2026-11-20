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
