// The multi-instance check (M7 loop 1), shared by Node (tests/threads.test.ts)
// and Chromium (tests/browser/threads.html): instance 0 allocates a stack and a
// TLS block per worker; three workers (tests/threads-worker.ts) each
// instantiate the core on the memory and run their own copy of the integer
// guest concurrently (the interpreter, and the JIT in two instances with their
// own tables). Each must end exactly where instance 0's interpreter ends alone:
// registers and RAM. Also checks each worker's TLS block is its own.
import { coreImports, threadAlloc } from '../web/vm.ts';
import type { Job, Result } from './threads-worker.ts';

const RAM = 16 << 20, LOAD = 0x10000, CPU_BYTES = 1152;
/** jit_new's arguments: the JIT's default policy (bench/interp/suite.ts `JIT_DEFAULT`). */
const JIT: number[] = [50, 32, 16384, 0, 1000];

/** A worker that runs one {@link Job}. */
export type Spawn = () => { run(job: Job): Promise<Result>; close(): void };
export type Check = { what: string; done: number; ms: number; tls: number; registers: boolean; ram: boolean };

export async function threadsRun(wasm: BufferSource, guest: Uint8Array, spawn: Spawn, n = 30_000_000): Promise<{ reference: number; checks: Check[] }> {
  const module = new WebAssembly.Module(wasm);
  const memory = new WebAssembly.Memory({ initial: 32, maximum: 65536, shared: true });
  const imports = coreImports(memory);
  const inst = new WebAssembly.Instance(module, imports);
  imports.jit.bind(inst);
  const ex = inst.exports as unknown as Record<string, (...a: (number | bigint)[]) => number | bigint>;
  if (ex.tls_probe() !== 1) throw new Error('instance 0: TLS probe');
  const place = () => {
    const base = memory.grow(RAM / 65536) * 65536;
    new Uint8Array(memory.buffer, base + LOAD, guest.length).set(guest);
    return base;
  };
  const refBase = place();
  const refCpu = ex.vcpu_new() as number;
  new BigUint64Array(memory.buffer, refCpu + 256, 1)[0] = BigInt(LOAD);
  const reference = Number(ex.interp_run(refCpu, ex.mem_new(refBase, BigInt(RAM)), BigInt(n)));

  const go = new SharedArrayBuffer(8);
  const jobs = [null, JIT, JIT].map((jit): Job => ({ module, memory, block: threadAlloc(inst.exports), jit, base: place(), ram: RAM, pc: LOAD, n, go }));
  const workers = jobs.map(() => spawn());
  try {
    const results = jobs.map((j, i) => workers[i].run(j));
    // Release them together once all are instantiated (polling: this may be a page's main thread).
    const g = new Int32Array(go);
    for (let t = 0; Atomics.load(g, 1) < jobs.length; t++) {
      if (t > 30_000) throw new Error('workers not ready after 30 s');
      await new Promise((r) => setTimeout(r, 1));
    }
    Atomics.store(g, 0, 1);
    Atomics.notify(g, 0);
    const done = await Promise.all(results);
    const same = (a: number, b: number, len: number) => {
      const x = new Uint32Array(memory.buffer, a, len / 4), y = new Uint32Array(memory.buffer, b, len / 4);
      for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
      return true;
    };
    return {
      reference,
      checks: done.map((r, i) => ({
        what: jobs[i].jit ? `JIT worker ${i}` : 'interpreter worker', done: r.done, ms: r.ms, tls: r.tls,
        registers: same(r.cpu, refCpu, CPU_BYTES), ram: same(jobs[i].base, refBase, RAM),
      })),
    };
  } finally {
    workers.forEach((w) => w.close());
  }
}
