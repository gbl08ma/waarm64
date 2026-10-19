// The JIT's compile worker (docs/jit.md "Sharing"; parallel SMP): compiles each module a vCPU emits, off the vCPU
// threads, so that V8's process-wide module cache (keyed by the bytes) holds it when the vCPUs install it. A vCPU
// worker posts {seq, epoch, ready, bytes} through its own port (web/vm.ts `jitHost`, the core's `env.jit_compile`);
// once every module up to `seq` is compiled, this stores `seq` into the u32 at byte `ready` of the core's memory,
// and each vCPU's table installs the modules up to there (a cache hit), interpreting their blocks meanwhile. A
// module is kept until its epoch ends (the code cache flushed) or for KEEP_MS: V8's cache keeps one only while
// something holds it, and a table that comes later (a vCPU that slept) compiles it itself.
// With the JIT's replay it also emits the replay's modules after a flush (ABI 42, docs/jit.md "Replay after a flush"),
// on a core instance of its own on the same memory, and compiles them as it does a vCPU's.
// Runs in a browser worker or a Node worker thread.
import { coreImports, THREAD_STACK, unsigned, withPanic, type ThreadBlock } from './vm.ts';

/** The emitter's core instance: the module, its stack and TLS, the VM, the spill memories. */
export type EmitInit = { module: WebAssembly.Module; block: ThreadBlock; vm: number; spill: WebAssembly.Memory[] };
/** What the coordinator sends: the core's memory, a port per vCPU worker, and the emitter's instance if the VM replays. */
export type CompileInit = { memory: WebAssembly.Memory; ports: MessagePort[]; emit?: EmitInit };
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
  /** Module `j` compiled (none: it failed) at `t0`: kept, posted to every vCPU, and `ready` moved past what's done. */
  const finish = (j: CompileJob, module: WebAssembly.Module | undefined, t0: number) => {
    ms += performance.now() - t0;
    compiled++;
    if (!module) failed++; // the table compiles it too and reports the error there
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
  };
  return {
    job(j: CompileJob) {
      const t0 = performance.now();
      let module: WebAssembly.Module | undefined;
      try {
        module = new WebAssembly.Module(j.bytes);
      } catch {}
      finish(j, module, t0);
    },
    /** {@link job} off this thread (V8's compile threads): the replay's large modules, while the vCPUs' go on. */
    jobAsync(j: CompileJob) {
      const t0 = performance.now();
      WebAssembly.compile(j.bytes).then((m) => finish(j, m, t0), () => finish(j, undefined, t0));
    },
    stats: () => ({ compiled, failed, ms, kept: kept.length }),
  };
}

/** How long the emitter waits on the replay's word before it looks again (the core notifies it at a flush). */
const EMIT_WAIT_MS = 1000;

/**
 * The replay's emitter: the core's `vm_jit_emit` takes the replay's next module, emits it off the vCPUs and hands it
 * to its `env.jit_compile`, served here by `c.jobAsync` (V8 compiles it on its own threads, and this one goes on with
 * the vCPUs' modules); the core makes one only once every module handed over so far is compiled, its own included,
 * and between calls the event loop runs. Waits on the word that's 1 while the replay has regions.
 */
export function emitter(c: ReturnType<typeof compiler>, memory: WebAssembly.Memory, e: EmitInit) {
  const imports = coreImports(memory, undefined, [], undefined, e.spill);
  imports.env.jit_compile = (ptr: number, len: number, seq: number, epoch: number, ready: number) => {
    const bytes = new Uint8Array(len);
    bytes.set(new Uint8Array(memory.buffer, ptr >>> 0, len));
    c.jobAsync({ seq: seq >>> 0, epoch: epoch >>> 0, ready: ready >>> 0, bytes: bytes.buffer });
    return 1;
  };
  const instance = new WebAssembly.Instance(e.module, imports);
  (instance.exports.__stack_pointer as WebAssembly.Global).value = e.block.stack + THREAD_STACK;
  (instance.exports.__wasm_init_tls as (tls: number) => void)(e.block.tls);
  const ex = unsigned(instance.exports);
  const emit = ex.vm_jit_emit as (vm: number) => number;
  const word = new Int32Array(memory.buffer, (ex.vm_jit_active as (vm: number) => number)(e.vm), 1);
  // The first call binds it: from then on the vCPUs leave the replay to it.
  emit(e.vm);
  const loop = async () => {
    for (;;) {
      if (Atomics.load(word, 0) === 0) {
        const w = Atomics.waitAsync(word, 0, 0, EMIT_WAIT_MS);
        if (w.async) await w.value;
        continue;
      }
      let more: number;
      try {
        more = emit(e.vm);
      } catch (err) {
        throw withPanic(err, instance.exports, memory);
      }
      if (!more) await new Promise((r) => setTimeout(r, 4)); // (the word not cleared yet)
      await new Promise((r) => setTimeout(r, 0));
    }
  };
  void loop().catch((err) => console.error('jit emitter:', err));
}

if ('WorkerGlobalScope' in globalThis) {
  const self = globalThis as unknown as { onmessage: ((e: MessageEvent<CompileInit>) => void) | null };
  self.onmessage = (e) => {
    const c = compiler(e.data.memory, e.data.ports);
    for (const p of e.data.ports) p.onmessage = (m: MessageEvent<CompileJob>) => c.job(m.data);
    if (e.data.emit) emitter(c, e.data.memory, e.data.emit);
  };
} else {
  const { parentPort } = await import('node:worker_threads');
  // (No parent port: imported by a test on Node's main thread.)
  parentPort?.once('message', (init: CompileInit) => {
    const c = compiler(init.memory, init.ports as never);
    for (const p of init.ports) (p as unknown as import('node:worker_threads').MessagePort).on('message', (m: CompileJob) => c.job(m));
    if (init.emit) emitter(c, init.memory, init.emit);
  });
}
