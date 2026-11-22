// Parallel SMP's ticker (ABI 73; docs/abi.md "PERF: parallel SMP's code without `acc`", docs/platform.md "Parallel
// SMP"): one per machine, started by the coordinator with the vCPU workers. While the polled code runs without `acc`
// (the ticker's `count` word 0, `vm_set_count`), no step count ends a looping vCPU's chunk, so this does: at each
// vCPU's timer deadline (its `due`, the VM clock's ns) it takes the `due` (u64::MAX in its place, unless the run loop
// published another meanwhile), ORs TIMER into the vCPU's tick bits and stores 0 in its stop word; at the xHCI's due
// time it stores 0 in one vCPU's stop word (the next one's each time); every period (1 ms, `vm_set_chunk`'s ns while
// the PC sampler or a test sets one) it ORs PERIODIC into every vCPU's bits and stores 0 in every stop word. The run
// loop swaps the bits to 0 after its store of the stop word and acts on them (the timers, the publications, the
// budget). Deadlines that pass together fire `STAGGER_MS` apart, so the vCPUs don't all take the platform's lock at
// once; one this clock saw early (the workers' clocks agree only to their round trips) the run loop publishes again,
// and it fires again after a gap that doubles each time (PERF loop 56). While the VM clock is held (a snapshot's
// save) no deadline comes nearer: only the periodic tick runs. For a deadline its wait takes half the time left,
// again, until under SPIN_MS remain, then spins to it: macOS's timed waits come back late by a share of the timeout,
// and halving converges in one or two more waits (bench/boot/REPORT.md "PERF loop 53": 4-9 µs late on average on the
// Mac, p99 under 45 µs). The bell (rung by the core when a `due` or the xHCI's due time moves earlier, or `count` or
// the period changes) ends a wait early; one that moves later needs none (the wait ends at the old one, at worst).
// While the code counts its steps it waits on the bell alone. Runs in a browser worker or a Node worker thread; the
// clock is the creator's, as the vCPU workers' is (web/core.ts `clockOffset`).
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
/** The xHCI's due time passed and stayed: a vCPU's stop word again this often (ms; one that came early comes again). */
const XHCI_AGAIN_MS = 0.05;
/**
 * Timer deadlines fire at least this far apart (ms): Linux's per-vCPU ticks fall due together, and each fire takes
 * the platform's lock (the timer's line) and the GIC's (the IRQ's IAR and EOIR) at once (PERF loop 56).
 */
export const STAGGER_MS = 0.01;
/**
 * A deadline published again after its fire (this clock saw it early: the workers' clocks agree to their round trips)
 * fires again no sooner than this after the last (ms), the gap doubling each time up to `AGAIN_MAX_MS`: the two
 * clocks' difference is met in a few fires, not one per round trip.
 */
const TIMER_AGAIN_MS = 0.02;
const AGAIN_MAX_MS = 1;
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
  /**
   * The VM clock's ns at host time `host` (core/src/vm.rs `Clock::ns`), NaN while it's held (`Clock::hold`, a
   * snapshot's save: no vCPU runs, and no deadline comes nearer). `hold` stores `base` then `t0`, `start` `t0`
   * alone: `base` read on both sides of `t0` and equal is the `base` that `t0` goes with.
   */
  const vmNs = (host: number) => {
    for (;;) {
      const b = Atomics.load(base, 0);
      const t = Atomics.load(t0, 0);
      if (Atomics.load(base, 0) !== b) continue;
      if (t === NONE) return NaN;
      f64.setBigUint64(0, t, true);
      return Number(b) + (host - f64.getFloat64(0, true)) * 1e6;
    }
  };
  // Each vCPU's deadline last fired (VM ns; -1: none), when (host ms), and the gap before it fires again if published
  // again (ms).
  const firedDue = new Float64Array(n).fill(-1);
  const firedAt = new Float64Array(n);
  const again = new Float64Array(n);
  // The last timer fire (host ms), and the vCPU whose stop word the xHCI's due time takes next.
  let fired = -Infinity;
  let xhciNext = 0;
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
      for (const s of stops) Atomics.store(s, 0, 0);
      next = next + periodMs > host ? next + periodMs : host + periodMs;
    }
    const vm = vmNs(host);
    const held = Number.isNaN(vm);
    // The earliest deadline (host ms) and whether it's a timer's or the xHCI's, which the wait meets by halves: the
    // periodic tick needs no such precision, and its plain wait spins nothing. None while the clock is held.
    let earliest = Infinity;
    for (let i = 0; i < n && !held; i++) {
      const raw = Atomics.load(dues[i], 0);
      if (raw === NONE) continue;
      const d = Number(raw);
      if (d > vm) {
        earliest = Math.min(earliest, host + (d - vm) / 1e6);
        continue;
      }
      // Passed: no sooner than `STAGGER_MS` after the last fire, nor, if it fired already, `again` after that.
      const at = Math.max(fired + STAGGER_MS, d === firedDue[i] ? firedAt[i] + again[i] : -Infinity);
      if (host < at) earliest = Math.min(earliest, at);
      else if (Atomics.compareExchange(dues[i], 0, raw, NONE) === raw) {
        Atomics.or(bits[i], 0, TICK_TIMER);
        Atomics.store(stops[i], 0, 0);
        again[i] = d === firedDue[i] ? Math.min(again[i] * 2, AGAIN_MAX_MS) : TIMER_AGAIN_MS;
        [firedDue[i], firedAt[i], fired] = [d, host, host];
      }
    }
    const raw = Atomics.load(xhci, 0);
    if (raw !== NONE && !held) {
      // One vCPU's stop word, the next one's each time: its run loop does the xHCI's work for all (taking the due
      // time first), and the next comes `XHCI_AGAIN_MS` later while the due time stays (one that waits in WFI wakes
      // for it by itself).
      const d = Number(raw);
      if (d > vm) earliest = Math.min(earliest, host + (d - vm) / 1e6);
      else if (d !== xhciDue || host - xhciAt >= XHCI_AGAIN_MS) {
        Atomics.store(stops[xhciNext], 0, 0);
        xhciNext = xhciNext + 1 < n ? xhciNext + 1 : 0;
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
