// A vCPU worker (M7, parallel SMP; docs/abi.md "M7 (SMP)"): one per vCPU,
// each with its own core instance on the VM's memory, so its own function
// table and JIT code. It runs `vm_run_cpu` for its vCPU until the VM stops:
// it sleeps on the vCPU's wake word while the vCPU is idle or off, rings the
// device doorbell on DEVICE exits (and waits for config writes), lets the
// coordinator drain the console on TX_FULL, and reports the exit that ends
// its run (PSCI, UNIMPLEMENTED, STOP) or its error to the coordinator
// (web/vm.ts `bootVm`). Runs in a browser worker or a Node worker thread.
import { EV_CONFIG, ring } from './virtio.ts';
import { livenessWriter } from './liveness.ts';
import { idle, pollRule, turns, txFull, yieldTurn } from './idle-wait.ts';
import {
  clockOffset,
  Exit,
  instantiateThread,
  stallHook,
  unsigned,
  withPanic,
  type Stall,
  type ThreadBlock,
} from './core.ts';

export type VcpuJob = {
  module: WebAssembly.Module;
  memory: WebAssembly.Memory;
  /** The spill memories (docs/spill-memories.md), memory 1 first. */
  spill: WebAssembly.Memory[];
  block: ThreadBlock;
  vm: number;
  cpu: number;
  /** Byte addresses in `memory`: the device doorbell (two i32 words) and the coordinator's word (bumped on TX_FULL). */
  bell: number;
  ctl: number;
  /** The pause word and the base of the workers' parked words (web/vm.ts `S_PAUSE`, `S_PARKED`). */
  pause: number;
  parked: number;
  /** The start word (web/vm.ts `S_START`): each worker bumps it once instantiated and waits until all `ncpus` have. */
  start: number;
  ncpus: number;
  /** Test only: stalls this worker (web/core.ts `Stall`). */
  stall?: Stall[];
  /** The vCPUs' liveness block (web/liveness.ts): this worker writes its slot. */
  live?: Float64Array;
  /** Its port to the JIT's compile worker (web/jit-compile-worker.ts), if the VM has one. */
  compile?: MessagePort;
  /**
   * Returns to the worker's event loop at the first exit this many ms after the last return (0: never). V8 and
   * Blink post work to it (Oilpan's sweeping in 5 ms slices): on a thread that never returns, it waits for V8's next
   * major GC, which then does it all at once on the vCPU (hundreds of ms; bench/boot/REPORT.md "M8: V8's GC on
   * the vCPU threads").
   */
  yieldMs?: number;
  /** How long an idle vCPU polls its wake word before it sleeps, in ms (default `SPIN_MS`: web/idle-wait.ts `idle`). */
  spinMs?: number;
  /** Idles in a row without a wake-up a poll would catch before the vCPU stops polling (default `POLL_MISSES`; 0: never). */
  pollMisses?: number;
};
export type VcpuEnd =
  | { type: 'exit'; cpu: number; kind: number; value: bigint; x: bigint[] }
  | { type: 'error'; cpu: number; message: string };
/** A clock query to the coordinator (web/core.ts `clockOffset`) and its answer, `t` its clock. */
export type VcpuClock = { type: 'clock'; t?: number };

type Ex = {
  vm_run_cpu(vm: number, cpu: number, budget: bigint): number;
  vm_exit_cpu(vm: number, cpu: number): number;
  vm_cpu_signal(vm: number, i: number): number;
};

/** Steps per `vm_run_cpu` call: it returns early on anything the worker handles. */
const BUDGET = 100_000_000n;
const NONE = 0xffff_ffff_ffff_ffffn;

async function run(j: VcpuJob, clock: number): Promise<VcpuEnd> {
  const exports = instantiateThread(j.module, j.memory, j.block, clock, j.stall, j.compile, j.spill).exports;
  // The vCPUs start together: one that ran (and started a restored VM's clock, and took device completions) while
  // another was still instantiating would find a guest whose CPU 0 hadn't run for that long (on a loaded host, over
  // ALSA's 100 ms wait for a sound period: docs/audio.md "Linux driver behavior").
  const ready = new Int32Array(j.memory.buffer, j.start, 1);
  Atomics.add(ready, 0, 1);
  Atomics.notify(ready, 0);
  for (let v; (v = Atomics.load(ready, 0)) < j.ncpus;) Atomics.wait(ready, 0, v, 1000);
  try {
    return await runCpu(j, exports);
  } catch (err) {
    // A panic in the core: its message is in the memory (ABI 27).
    throw withPanic(err, exports, j.memory);
  }
}

async function runCpu(j: VcpuJob, exports: WebAssembly.Exports): Promise<VcpuEnd> {
  const ex = unsigned(exports) as unknown as Ex;
  const mem = j.memory;
  const wake = new Int32Array(mem.buffer, ex.vm_cpu_signal(j.vm, j.cpu), 1);
  const bell = new Int32Array(mem.buffer, j.bell, 2);
  const ctl = new Int32Array(mem.buffer, j.ctl, 1);
  const pause = new Int32Array(mem.buffer, j.pause, 1);
  const parked = new Int32Array(mem.buffer, j.parked + 4 * j.cpu, 1);
  const info = ex.vm_exit_cpu(j.vm, j.cpu);
  const idleStalls = j.stall?.map((s) => stallHook(mem, s)('idle', () => {}));
  const live = j.live && livenessWriter(j.live, j.cpu);
  const turn = turns(j.yieldMs ?? 0);
  const poll = pollRule(j.spinMs, j.pollMisses);
  // The exit's record: kind, steps, value, x0-x3, cpu, wake (a new view once the memory grew: its buffer is new).
  let e = new BigUint64Array(mem.buffer, info, 9);
  for (;;) {
    live?.enter();
    const kind = ex.vm_run_cpu(j.vm, j.cpu, BUDGET);
    // An idle's deadline counts from here: what the worker does next (the liveness block, the record's BigInts, which
    // allocate) isn't added to it (web/idle-wait.ts `idle`).
    const back = performance.now();
    live?.leave();
    if (e.buffer !== mem.buffer) e = new BigUint64Array(mem.buffer, info, 9);
    switch (kind) {
      case Exit.BUDGET:
        live?.handled();
        // Short of the budget: the core wants the event loop now, where a module the JIT's compile worker
        // compiled arrives (ABI 37, `jit::Jit::park_exit`).
        if (turn.due() || e[1] < BUDGET) await yieldTurn(turn, wake);
        continue;
      case Exit.IDLE: {
        idleStalls?.forEach((f) => f()); // test only: a host stall with the vCPU OUT
        // Until its deadline or a wake-up; an off vCPU (no deadline) rechecks every second.
        const ms = e[2] === NONE ? undefined : Number(e[2]) / 1e6;
        const value = Number(e[8]) | 0;
        const spun = poll.spin();
        const asleep = idle(wake, value, ms, back, turn, spun);
        if (asleep) await asleep;
        poll.seen(spun, Atomics.load(wake, 0) !== value, performance.now() - back);
        continue;
      }
      case Exit.TX_FULL:
        txFull(ctl, wake, live);
        continue;
      case Exit.DEVICE:
        // A config-space write waits: the driver reads the answer next (virtio-input's select/subsel).
        ring(bell, (Number(e[2] >> 8n) & EV_CONFIG) !== 0);
        live?.handled();
        if (turn.due()) await yieldTurn(turn, wake);
        continue;
      case Exit.STOP: {
        // A pause (odd pause word): park here, out of the core, keeping the instance and its code. Not
        // `handled`: the time parked isn't host work. A STOP with the word even ends the run.
        const gen = Atomics.load(pause, 0);
        if (!(gen & 1)) return { type: 'exit', cpu: j.cpu, kind, value: e[2], x: [...e.subarray(3, 7)] };
        Atomics.store(parked, 0, gen);
        Atomics.add(ctl, 0, 1);
        Atomics.notify(ctl, 0);
        while (Atomics.load(pause, 0) === gen) Atomics.wait(pause, 0, gen);
        continue;
      }
      default:
        return { type: 'exit', cpu: j.cpu, kind, value: e[2], x: [...e.subarray(3, 7)] };
    }
  }
}

/**
 * The job, then the coordinator's clock (the answers to `clockOffset`'s
 * queries), then the run: it blocks this thread until the VM stops.
 */
function serve(
  post: (m: VcpuEnd | VcpuClock) => void,
  listen: (on: (m: VcpuJob | VcpuClock) => void) => void,
  done = () => {},
) {
  let job: VcpuJob | undefined;
  let answer: ((t: number) => void) | undefined;
  listen((m) => {
    if ('type' in m) return answer?.(m.t!);
    job = m;
    const ask = () =>
      new Promise<number>((resolve) => {
        answer = resolve;
        post({ type: 'clock' });
      });
    void clockOffset(ask).then(async (clock) => {
      try {
        post(await run(job!, clock));
      } catch (err) {
        post({ type: 'error', cpu: job!.cpu, message: errorText(err) });
      }
      done();
    });
  });
}

if ('WorkerGlobalScope' in globalThis) {
  const self = globalThis as unknown as {
    onmessage: (e: MessageEvent<VcpuJob | VcpuClock>) => void;
    postMessage(m: unknown): void;
  };
  serve(
    (m) => self.postMessage(m),
    (on) => {
      self.onmessage = (e) => on(e.data);
    },
  );
} else {
  const { parentPort } = await import('node:worker_threads');
  // Unref'd once the run ends, so the thread can exit.
  serve(
    (m) => parentPort!.postMessage(m),
    (on) => parentPort!.on('message', on),
    () => parentPort!.unref(),
  );
}

/** An error's message and stack: V8's stack starts with the message, Firefox's is only the frames. */
function errorText(err: unknown) {
  const e = err as Error | undefined;
  const text = String(e?.message ?? err);
  return e?.stack ? (e.stack.includes(text) ? e.stack : `${text}\n${e.stack}`) : text;
}
