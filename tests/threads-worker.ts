// One more core instance on a shared memory, in a worker (M7 loop 1,
// tests/threads.test.ts and tests/browser/threads.html): runs a user-mode guest
// already in RAM for `n` steps on its own vCPU, the interpreter's or the JIT's,
// starting when the main thread releases `go`, and reports the vCPU's address.
import { instantiateThread, type ThreadBlock } from '../web/core.ts';

export type Job = {
  module: WebAssembly.Module; memory: WebAssembly.Memory; block: ThreadBlock;
  /** jit_new's arguments, or null for the interpreter. */
  jit: number[] | null;
  base: number; ram: number; pc: number; n: number;
  /** Int32 words: [0] released when non-zero, [1] workers ready. */
  go: SharedArrayBuffer;
};
export type Result = { cpu: number; done: number; ms: number; tls: number };

type Ex = {
  tls_probe(): number; vcpu_new(): number; jit_new(...a: number[]): number; mem_new(base: number, size: bigint): number;
  interp_run(cpu: number, mem: number, n: bigint): bigint; jit_run(v: number, mem: number, n: bigint): bigint;
};

function run(j: Job): Result {
  const ex = instantiateThread(j.module, j.memory, j.block).exports as unknown as Ex;
  const tls = ex.tls_probe();
  const cpu = j.jit ? ex.jit_new(...j.jit) : ex.vcpu_new();
  const mem = ex.mem_new(j.base, BigInt(j.ram));
  new BigUint64Array(j.memory.buffer, cpu + 256, 1)[0] = BigInt(j.pc);
  const go = new Int32Array(j.go);
  Atomics.add(go, 1, 1);
  Atomics.notify(go, 1);
  Atomics.wait(go, 0, 0);
  const t0 = performance.now();
  let done = 0;
  while (done < j.n) {
    const left = BigInt(j.n - done);
    const k = Number(j.jit ? ex.jit_run(cpu, mem, left) : ex.interp_run(cpu, mem, left));
    if (k === 0) break;
    done += k;
  }
  return { cpu, done, ms: performance.now() - t0, tls };
}

if ('WorkerGlobalScope' in globalThis) {
  const self = globalThis as unknown as { onmessage: (e: MessageEvent<Job>) => void; postMessage(m: unknown): void };
  self.onmessage = (e) => {
    try { self.postMessage(run(e.data)); } catch (err) { self.postMessage({ error: String((err as Error).stack ?? err) }); }
  };
} else {
  const { parentPort } = await import('node:worker_threads');
  parentPort!.on('message', (j: Job) => {
    try { parentPort!.postMessage(run(j)); } catch (err) { parentPort!.postMessage({ error: String((err as Error).stack ?? err) }); }
  });
}
