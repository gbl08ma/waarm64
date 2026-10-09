// Starts the guest PC sampler (sampler-worker.ts) on a VM's shared memory.
import { Counter } from './vm.ts';

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
