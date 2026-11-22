// Parallel SMP's ticker (ABI 73; docs/abi.md "PERF: parallel SMP's code without `acc`", docs/platform.md "Parallel
// SMP"): one per machine, started by the coordinator with the vCPU workers. While the polled code runs without `acc`
// (the ticker's `count` word 0, `vm_set_count`), no step count ends a looping vCPU's chunk, so this does: at each
// vCPU's timer deadline (its `due`, the VM clock's ns) it takes the `due` (u64::MAX in its place, unless the run loop
// published another meanwhile), ORs TIMER into the vCPU's tick bits and stores 0 in its stop word (the run loop
// publishes its deadline again after a TIMER: one this clock saw a little early, the workers' clocks agreeing only to
// their round trips, comes again); at the xHCI's due time it stores 0 in every stop word; every period (1 ms, `vm_set_chunk`'s ns while the PC
// sampler or a test sets one) it ORs PERIODIC into every vCPU's bits and stores 0 in every stop word. The run loop
// swaps the bits to 0 after its store of the stop word and acts on them (the timers, the publications, the budget).
// For a deadline its wait takes half the time left, again, until under SPIN_MS remain, then spins to it: macOS's timed
// waits come back late by a share of the timeout, and halving converges in one or two more waits (bench/boot/REPORT.md
// "PERF loop 53": 4-9 µs late on average on the Mac, p99 under 45 µs). The bell (bumped by the core when a `due`, the
// xHCI's due time, `count` or the period changes) ends a wait early. While the code counts its steps it waits on the
// bell alone. Runs in a browser worker or a Node worker thread; the clock is the creator's, as the vCPU workers' is
// (web/core.ts `clockOffset`).
import { clockOffset } from './core.ts';

/** What the coordinator sends: the core's memory, the ticker's words (`vm_ticker`), each vCPU's tick words
 * (`vm_cpu_tick`) and stop word (`vm_cpu_stop`), as byte addresses. */
export type TickerJob = { memory: WebAssembly.Memory; ticker: number; ticks: number[]; stops: number[] };
/** A clock query to the coordinator (web/core.ts `clockOffset`) and its answer, `t` its clock. */
export type TickerClock = { type: 'clock'; t?: number };

/** The tick bits (core/src/vm/parallel.rs `TICK_TIMER`, `TICK_PERIODIC`). */
export const TICK_TIMER = 1;
export const TICK_PERIODIC = 2;
/** Under this much time left (ms), the wait spins. */
const SPIN_MS = 0.04;
/** The longest wait (ms): what changes without the bell (the VM clock's start) is seen within it. */
const MAX_WAIT_MS = 100;
/** The xHCI's due time passed and stayed: its stores of 0 again this often (ms; one that came early comes again). */
const XHCI_AGAIN_MS = 0.05;
const NONE = 0xffff_ffff_ffff_ffffn;

/**
 * The ticker's loop on `j`'s words, `now` the creator's clock in ms (the core's `now_ms`); never returns (the worker
 * is terminated with its machine).
 */
export function tick(j: TickerJob, now: () => number): never {
  const buf = j.memory.buffer;
  const bell = new Int32Array(buf, j.ticker, 2); // the bell, `count`
  const period = new BigUint64Array(buf, j.ticker + 8, 1);
  const [t0At, baseAt, xhciWord] = new Uint32Array(buf, j.ticker + 16, 3);
  const t0 = new BigUint64Array(buf, t0At, 1);
  const base = new BigUint64Array(buf, baseAt, 1);
  const xhci = new BigUint64Array(buf, xhciWord, 1);
  const dues = j.ticks.map((a) => new BigUint64Array(buf, a, 1));
  const bits = j.ticks.map((a) => new Int32Array(buf, a + 8, 1));
  const stops = j.stops.map((a) => new Int32Array(buf, a, 1));
  const n = stops.length;
  const f64 = new DataView(new ArrayBuffer(8));
  /** The VM clock's ns at host time `host` (core/src/vm.rs `Clock::ns`). */
  const vmNs = (host: number) => {
    const t = Atomics.load(t0, 0);
    const b = Number(Atomics.load(base, 0));
    if (t === NONE) return b;
    f64.setBigUint64(0, t, true);
    return b + (host - f64.getFloat64(0, true)) * 1e6;
  };
  const stopAll = () => {
    for (const s of stops) Atomics.store(s, 0, 0);
  };
  // The xHCI's due time last acted on, and when (host ms).
  let xhciDue = -1;
  let xhciAt = 0;
  let periodMs = 0;
  let next = 0;
  for (;;) {
    const b = Atomics.load(bell, 0);
    if (Atomics.load(bell, 1) !== 0) {
      // Counting: the steps end the chunks.
      Atomics.wait(bell, 0, b, 1000);
      periodMs = 0;
      continue;
    }
    const host = now();
    const p = Number(Atomics.load(period, 0)) / 1e6;
    if (p !== periodMs) [periodMs, next] = [p, host + p];
    if (host >= next) {
      for (let i = 0; i < n; i++) Atomics.or(bits[i], 0, TICK_PERIODIC);
      stopAll();
      next = next + periodMs > host ? next + periodMs : host + periodMs;
    }
    const vm = vmNs(host);
    // The earliest deadline (host ms) and whether it's a timer's or the xHCI's, which the wait meets by halves: the
    // periodic tick needs no such precision, and its plain wait spins nothing.
    let earliest = Infinity;
    for (let i = 0; i < n; i++) {
      const raw = Atomics.load(dues[i], 0);
      if (raw === NONE) continue;
      const d = Number(raw);
      if (d > vm) earliest = Math.min(earliest, host + (d - vm) / 1e6);
      else if (Atomics.compareExchange(dues[i], 0, raw, NONE) === raw) {
        Atomics.or(bits[i], 0, TICK_TIMER);
        Atomics.store(stops[i], 0, 0);
      }
    }
    const raw = Atomics.load(xhci, 0);
    if (raw !== NONE) {
      const d = Number(raw);
      if (d > vm) earliest = Math.min(earliest, host + (d - vm) / 1e6);
      else if (d !== xhciDue || host - xhciAt >= XHCI_AGAIN_MS) {
        stopAll();
        [xhciDue, xhciAt] = [d, host];
        earliest = Math.min(earliest, host + XHCI_AGAIN_MS);
      } else earliest = Math.min(earliest, xhciAt + XHCI_AGAIN_MS);
    }
    const t = now();
    if (next <= earliest) Atomics.wait(bell, 0, b, Math.min(Math.max(next - t, 0), MAX_WAIT_MS));
    else if (earliest - t > SPIN_MS) Atomics.wait(bell, 0, b, Math.min((earliest - t) / 2, MAX_WAIT_MS));
    else while (now() < earliest && Atomics.load(bell, 0) === b);
  }
}

/** The job, then the coordinator's clock (the answers to `clockOffset`'s queries), then the loop. */
function serve(post: (m: TickerClock) => void, listen: (on: (m: TickerJob | TickerClock) => void) => void) {
  let answer: ((t: number) => void) | undefined;
  listen((m) => {
    if ('type' in m) return answer?.(m.t!);
    const ask = () =>
      new Promise<number>((resolve) => {
        answer = resolve;
        post({ type: 'clock' });
      });
    void clockOffset(ask).then((clock) => tick(m, () => clock + performance.now()));
  });
}

if ('WorkerGlobalScope' in globalThis) {
  const self = globalThis as unknown as {
    onmessage: (e: MessageEvent<TickerJob | TickerClock>) => void;
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
  // (No parent port: imported by a test on Node's main thread.)
  if (parentPort) {
    const port = parentPort;
    port.unref(); // it never ends by itself: the machine's end terminates it
    serve(
      (m) => port.postMessage(m),
      (on) => port.on('message', on),
    );
  }
}
