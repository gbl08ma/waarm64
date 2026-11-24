// Parallel SMP's coordinator (docs/abi.md "M7 (SMP)"): the vCPU workers (web/vcpu-worker.ts) and the JIT's
// compile worker, their start, the run's end, pausing and resuming.
import { newLiveness, readLiveness, type VcpuLiveness } from './liveness.ts';
import type { VcpuClock, VcpuEnd, VcpuJob } from './vcpu-worker.ts';
import type { CompileInit } from './jit-compile-worker.ts';
import { CompileStat, compileStats } from './counters.ts';
import { Exit, panicNote, STOP, threadAlloc, unsigned, type Stall } from './core.ts';
import { newWorker, type WarmWorkers } from './warm-workers.ts';

/** The vCPU and compile workers' files for Node's worker_threads (a lookup, so the page's bundler doesn't copy them as assets). */
const NODE_WORKERS = { vcpu: './vcpu-worker.ts', compile: './jit-compile-worker.ts' };

/**
 * Parallel mode's vCPU workers (web/vcpu-worker.ts), started at the first
 * `wait`: a core instance each on `memory`, with a stack and TLS block from
 * `instance`. The first exit a worker reports that isn't STOP (or its error)
 * ends the run: the others are stopped (STOP stays set; it isn't cleared,
 * docs/abi.md).
 */
export function coordinator(c: {
  module: WebAssembly.Module;
  memory: WebAssembly.Memory;
  spill: WebAssembly.Memory[];
  instance: WebAssembly.Instance;
  vm: number;
  ncpus: number;
  bell: number;
  ctl: number;
  pause: number;
  parked: number;
  start: number;
  raise: (bits: number) => void;
  clearStop: () => void;
  quiesce: () => Promise<void>;
  stall: Stall[];
  compileWorker: boolean;
  yieldMs: number;
  warm?: WarmWorkers;
}) {
  type Handle = { post(m: VcpuJob | VcpuClock | CompileInit, transfer?: Transferable[]): void; terminate(): void };
  let workers: Promise<Handle>[] | undefined;
  let end: { kind: number; value: bigint; x: bigint[] } | undefined;
  let error: Error | undefined;
  let stopped = 0;
  let last = { steps: -1, at: performance.now() };
  const live = newLiveness(c.ncpus);
  const ctl = new Int32Array(c.memory.buffer, c.ctl, 1);
  if (c.ncpus > 128) throw new Error('too many vCPUs for the parked words');
  // Pause (docs/platform.md "Pausing"): `pword` is odd while a pause is requested or held; each worker
  // writes the odd value it parked in to its own `parked` word.
  const pword = new Int32Array(c.memory.buffer, c.pause, 1);
  const parkedWords = new Int32Array(c.memory.buffer, c.parked, c.ncpus);
  let state: 'running' | 'pausing' | 'paused' = 'running';
  let wantResume = false;
  let closed = false;
  let pausing: Promise<boolean> | undefined;
  const bump = () => {
    Atomics.add(ctl, 0, 1);
    Atomics.notify(ctl, 0);
  };
  /** A worker's clock query (`clockOffset`), or its end. */
  const heard = (h: Handle, m: VcpuEnd | VcpuClock) => {
    if (m.type === 'clock') h.post({ type: 'clock', t: performance.timeOrigin + performance.now() });
    else ended(m);
  };
  const ended = (m: VcpuEnd) => {
    stopped++;
    if (m.type === 'error')
      error ??= new Error(`vCPU ${m.cpu}: ${m.message}${panicNote(m.message, c.instance.exports, c.memory)}`);
    else if (m.kind !== Exit.STOP) end ??= { kind: m.kind, value: m.value, x: m.x };
    if (stopped === 1) c.raise(STOP);
    release();
    bump();
  };
  /** Makes the pause word even (the workers leave a pause) and wakes them. */
  const release = () => {
    if (Atomics.load(pword, 0) & 1) Atomics.add(pword, 0, 1);
    Atomics.notify(pword, 0);
  };
  const doPause = async (): Promise<boolean> => {
    workers ??= start();
    await Promise.all(workers);
    const gen = Atomics.add(pword, 0, 1) + 1;
    Atomics.notify(pword, 0);
    c.raise(STOP);
    // Each worker parks and bumps `ctl`; nothing here blocks (the backends may be on this thread).
    for (;;) {
      if (error) throw error;
      if (stopped > 0 || closed) return false;
      const seen = Atomics.load(ctl, 0);
      if (parkedWords.every((_, i) => Atomics.load(parkedWords, i) === gen)) break;
      const w = Atomics.waitAsync(ctl, 0, seen, 100);
      if (w.async) await w.value;
    }
    // Every worker waits on the pause word, so none can miss STOP going away.
    c.clearStop();
    await c.quiesce();
    if (error) throw error;
    if (stopped > 0 || closed) return false;
    state = 'paused';
    if (wantResume) resume();
    return true;
  };
  const resume = () => {
    if (state === 'pausing') {
      wantResume = true;
      return;
    }
    if (state !== 'paused') return;
    state = 'running';
    last = { steps: last.steps, at: performance.now() };
    Atomics.add(pword, 0, 1);
    Atomics.notify(pword, 0);
  };
  // A browser's worker (one started ahead if there is: `BootOptions.warm`); Node's worker_threads get the same files by
  // a URL it leaves alone.
  const spawn = async (which: 'vcpu' | 'compile' = 'vcpu'): Promise<Handle> => {
    if (typeof Worker !== 'undefined') {
      const w = c.warm?.take(which) ?? newWorker(which);
      const h: Handle = { post: (m, t) => w.postMessage(m, t ?? []), terminate: () => w.terminate() };
      w.onmessage = (e: MessageEvent<VcpuEnd | VcpuClock>) => heard(h, e.data);
      w.onerror = (e) => ended({ type: 'error', cpu: -1, message: e.message });
      return h;
    }
    const { Worker: NodeWorker } = await import('node:worker_threads');
    const w = new NodeWorker(new URL(NODE_WORKERS[which], import.meta.url));
    const h: Handle = { post: (m, t) => w.postMessage(m, t as never), terminate: () => void w.terminate() };
    w.on('message', (m: VcpuEnd | VcpuClock) => heard(h, m));
    w.on('error', (e: Error) => ended({ type: 'error', cpu: -1, message: String(e.stack ?? e) }));
    return h;
  };
  // The JIT's compile worker, and a port to it for each vCPU worker.
  let compiler: Promise<Handle> | undefined;
  /** The compile worker's counters (web/jit-compile-worker.ts `CompileStat`), once it is started. */
  let compileBlock: Float64Array | undefined;
  const start = () => {
    const channels = c.compileWorker ? Array.from({ length: c.ncpus }, () => new MessageChannel()) : [];
    if (channels.length) {
      compiler = spawn('compile');
      const ports = channels.map((ch) => ch.port2);
      const stats = new SharedArrayBuffer(CompileStat.LEN * 8);
      compileBlock = new Float64Array(stats);
      void compiler.then((h) => h.post({ memory: c.memory, ports, stats }, ports));
    }
    const made = Array.from({ length: c.ncpus }, async (_, cpu) => {
      const h = await spawn();
      const compile = channels[cpu]?.port1;
      h.post(
        {
          module: c.module,
          memory: c.memory,
          spill: c.spill,
          block: threadAlloc(c.instance.exports),
          vm: c.vm,
          cpu,
          bell: c.bell,
          ctl: c.ctl,
          pause: c.pause,
          parked: c.parked,
          start: c.start,
          ncpus: c.ncpus,
          stall: c.stall.filter((x) => x.cpu === cpu),
          live,
          compile,
          yieldMs: c.yieldMs,
        },
        compile ? [compile] : [],
      );
      return h;
    });
    c.warm?.end(); // every worker is taken (synchronously, in `spawn`): the ones started ahead and not wanted end
    return made;
  };
  return {
    /**
     * Waits up to `ms` for news, or for the u32 at byte `also.at` to differ
     * from `also.value` (a notify on it); the run's end once every worker has
     * stopped.
     */
    async wait(ms: number, also?: { at: number; value: number }) {
      workers ??= start();
      await Promise.all(workers);
      if (!error && !(end && stopped === c.ncpus)) {
        const head = also && { word: new Int32Array(c.memory.buffer, also.at, 1), value: also.value | 0 };
        // Already different: wait 1 ms at most instead, but wait. Returning at once would let a caller
        // looping on runAsync (a flood of console output) run on microtasks alone and starve its
        // event loop (messages, animation frames).
        const moved = head !== undefined && Atomics.load(head.word, 0) !== head.value;
        const r = [Atomics.waitAsync(ctl, 0, Atomics.load(ctl, 0), moved ? 1 : ms)];
        if (head && !moved) r.push(Atomics.waitAsync(head.word, 0, head.value, ms));
        if (r.every((w) => w.async)) await Promise.race(r.map((w) => w.value));
        else await new Promise((resolve) => setTimeout(resolve, 0)); // a word changed just now: yield anyway
      }
      if (error) throw error;
      return end && stopped === c.ncpus ? end : undefined;
    },
    /** Each vCPU worker's timing of its `vm_run_cpu` calls (web/liveness.ts). */
    liveness: (): VcpuLiveness[] => readLiveness(live),
    /** The liveness block itself (bench/gpu/guest-session.ts's timeline reads it from a worker). */
    liveBlock: live,
    /** The compile worker's counters so far; none without one, or before the vCPUs started. */
    compileStats: () => compileBlock && compileStats(compileBlock),
    /** When `steps` (all vCPUs) last changed. */
    progress(steps: number) {
      // Time paused isn't time without progress.
      if (steps !== last.steps || state !== 'running') last = { steps, at: performance.now() };
      return last.at;
    },
    /** See `Vm.pause`. */
    pause(): Promise<boolean> {
      if (error) return Promise.reject(error);
      if (closed || stopped > 0) return Promise.resolve(false);
      wantResume = false;
      if (state === 'paused') return Promise.resolve(true);
      if (state === 'pausing') return pausing!;
      state = 'pausing';
      pausing = doPause().finally(() => {
        if (state === 'pausing') state = 'running'; // it failed or the machine ended
        pausing = undefined;
      });
      return pausing;
    },
    resume,
    held: () => state === 'paused',
    pcs: () =>
      Array.from(
        { length: c.ncpus },
        (_, i) =>
          `0x${new BigUint64Array(c.memory.buffer, (unsigned(c.instance.exports).vm_cpu as (vm: number, i: number) => number)(c.vm, i) + 256, 1)[0].toString(16)}`,
      ),
    close() {
      closed = true;
      c.raise(STOP);
      release();
      bump();
      for (const w of workers ?? []) void w.then((h) => h.terminate());
      void compiler?.then((h) => h.terminate());
    },
  };
}
