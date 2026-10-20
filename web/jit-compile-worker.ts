// The JIT's compile worker (docs/jit.md "Sharing"; parallel SMP): compiles each module a vCPU emits, off the vCPU
// threads, so that V8's process-wide module cache (keyed by the bytes) holds it when the vCPUs install it. A vCPU
// worker posts {seq, epoch, ready, bytes} through its own port (web/vm.ts `jitHost`, the core's `env.jit_compile`);
// once every module up to `seq` is compiled, this stores `seq` into the u32 at byte `ready` of the core's memory,
// and each vCPU's table installs the modules up to there (a cache hit), interpreting their blocks meanwhile. A
// module is kept until its epoch ends (the code cache flushed) or for KEEP_MS: V8's cache keeps one only while
// something holds it, and a table that comes later (a vCPU that slept) compiles it itself.
// Runs in a browser worker or a Node worker thread.

/** What the coordinator sends: the core's memory and a port per vCPU worker. */
export type CompileInit = { memory: WebAssembly.Memory; ports: MessagePort[] };
/** A module from a vCPU (the core's numbers are u32s). */
export type CompileJob = { seq: number; epoch: number; ready: number; bytes: ArrayBuffer };
/** The compiled module, to every vCPU (no module: it didn't compile). */
export type CompiledJob = { seq: number; module?: WebAssembly.Module };

/** How long a compiled module is kept for the tables that haven't installed it yet. */
const KEEP_MS = 30_000;

/** The compile worker's state: in a function so a test can drive it without a worker. */
export function compiler(memory: WebAssembly.Memory, ports: { postMessage(m: CompiledJob): void }[] = []) {
  let next = 1; // the lowest number not compiled yet
  const done = new Set<number>();
  let epoch = 0;
  const kept: { module?: WebAssembly.Module; epoch: number; at: number }[] = [];
  let compiled = 0, failed = 0, ms = 0;
  return {
    job(j: CompileJob) {
      const t0 = performance.now();
      let module: WebAssembly.Module | undefined;
      try {
        module = new WebAssembly.Module(j.bytes);
      } catch {
        failed++; // the table compiles it too and reports the error there
      }
      ms += performance.now() - t0;
      compiled++;
      if (j.epoch !== epoch && (j.epoch - epoch | 0) > 0) {
        // A flush: the old epoch's modules are dead (each table moves on before it installs this epoch's).
        epoch = j.epoch;
        for (let i = kept.length - 1; i >= 0; i--) if (kept[i].epoch !== epoch) kept.splice(i, 1);
      }
      kept.push({ module, epoch: j.epoch, at: t0 });
      // To every vCPU before `ready` says it's compiled: a table installs it once it's there (ABI 37).
      for (const p of ports) p.postMessage({ seq: j.seq, module } satisfies CompiledJob);
      while (kept.length && t0 - kept[0].at > KEEP_MS) kept.shift();
      done.add(j.seq);
      let moved = false;
      while (done.delete(next)) {
        next = (next + 1) >>> 0 || 1;
        moved = true;
      }
      if (moved) Atomics.store(new Uint32Array(memory.buffer, j.ready, 1), 0, (next - 1) >>> 0 || 0xffff_ffff);
    },
    stats: () => ({ compiled, failed, ms, kept: kept.length }),
  };
}

if ('WorkerGlobalScope' in globalThis) {
  const self = globalThis as unknown as { onmessage: ((e: MessageEvent<CompileInit>) => void) | null };
  self.onmessage = (e) => {
    const c = compiler(e.data.memory, e.data.ports);
    for (const p of e.data.ports) p.onmessage = (m: MessageEvent<CompileJob>) => c.job(m.data);
  };
} else {
  const { parentPort } = await import('node:worker_threads');
  // (No parent port: imported by a test on Node's main thread.)
  parentPort?.once('message', (init: CompileInit) => {
    const c = compiler(init.memory, init.ports as never);
    for (const p of init.ports) (p as unknown as import('node:worker_threads').MessagePort).on('message', (m: CompileJob) => c.job(m));
  });
}
