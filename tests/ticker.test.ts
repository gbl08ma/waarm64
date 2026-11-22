// Parallel SMP's ticker (web/ticker-worker.ts; docs/abi.md "PERF: parallel SMP's code without `acc`"), its worker run in
// a Node worker thread on a memory laid out as the core's words are (`vm_ticker`, `vm_cpu_tick`, `vm_cpu_stop`): idle
// while the code counts its steps; the periodic tick in every vCPU's bits and stop word; a vCPU's timer deadline in its
// own alone, at the deadline and not before (the deadline taken), again when published again; the xHCI's due time in
// one vCPU's stop word at a time. PERF loop 56: deadlines that pass together fire apart, one fired early and published
// again converges in a few fires, and a held VM clock (a snapshot's save) spins nothing. The core's side (the run
// loop's swap of the bits, its deadlines) is the spin tests'.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Worker } from 'node:worker_threads';
import { STAGGER_MS, TICK_PERIODIC, TICK_TIMER, type TickerClock, type TickerJob } from '../web/ticker-worker.ts';

const NONE = 0xffff_ffff_ffff_ffffn;
/** The words' byte addresses: the ticker's, the VM clock's start and base, the xHCI's due time, two vCPUs' tick words and stop words. */
const TICKER = 0, T0 = 64, BASE = 72, XHCI = 80, TICKS = [128, 144], STOPS = [256, 260];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** The creator's clock, as the core's `now_ms` reads it (web/core.ts `clockOffset`). */
const nowMs = () => performance.timeOrigin + performance.now();

/** `skewMs`: the ticker's clock that far ahead of ours (the clock queries' answers). */
function setup(skewMs = 0) {
  const memory = new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true });
  const buf = memory.buffer;
  const i32 = new Int32Array(buf);
  const u64 = new BigUint64Array(buf);
  const u32 = new Uint32Array(buf);
  u32[TICKER / 4 + 1] = 1; // counting
  u64[TICKER / 8 + 1] = 1_000_000n; // 1 ms
  [u32[TICKER / 4 + 4], u32[TICKER / 4 + 5], u32[TICKER / 4 + 6]] = [T0, BASE, XHCI];
  // The VM clock started now at 0 ns.
  const f = new Float64Array(1);
  f[0] = nowMs();
  u64[T0 / 8] = new BigUint64Array(f.buffer)[0];
  u64[BASE / 8] = 0n;
  u64[XHCI / 8] = NONE;
  for (const t of TICKS) u64[t / 8] = NONE;
  for (const s of STOPS) i32[s / 4] = 1;
  const vmNs = () => (nowMs() - f[0]) * 1e6;
  const ring = () => {
    Atomics.add(i32, TICKER / 4, 1);
    Atomics.notify(i32, TICKER / 4);
  };
  const w = new Worker(new URL('../web/ticker-worker.ts', import.meta.url));
  let asked = 0;
  w.on('message', () => {
    asked++;
    w.postMessage({ type: 'clock', t: nowMs() + skewMs } satisfies TickerClock);
  });
  w.postMessage({ memory, ticker: TICKER, ticks: TICKS, stops: STOPS } satisfies TickerJob);
  const stop = (i: number) => Atomics.load(i32, STOPS[i] / 4);
  const bits = (i: number) => Atomics.exchange(i32, TICKS[i] / 4 + 2, 0);
  const rearm = () => STOPS.forEach((s) => Atomics.store(i32, s / 4, 1));
  const uncounted = (periodNs: bigint) => {
    Atomics.store(u64, TICKER / 8 + 1, periodNs);
    Atomics.store(i32, TICKER / 4 + 1, 0);
    ring();
  };
  /** Once the worker has its clock (web/core.ts `clockOffset`'s 16 queries answered) and runs its loop. */
  const ready = async () => {
    assert.ok((await until(() => asked >= 16, 5000)) !== undefined, 'the clock queries');
    await sleep(10);
  };
  return { i32, u64, u32, vmNs, ring, w, stop, bits, rearm, uncounted, ready };
}

/** Spins (this thread: no event loop) until `f()` holds, at most `ms`; performance.now() then, or undefined. */
function spinUntil(f: () => boolean, ms: number) {
  const t0 = performance.now();
  for (;;) {
    const t = performance.now();
    if (f()) return t;
    if (t - t0 > ms) return undefined;
  }
}

/** Waits until `f()` holds (a poll every 0.1 ms or so), at most `ms`; the ms it took, or undefined. */
async function until(f: () => boolean, ms: number) {
  const t0 = performance.now();
  for (;;) {
    if (f()) return performance.now() - t0;
    if (performance.now() - t0 > ms) return undefined;
    await new Promise((r) => setImmediate(r));
  }
}

test('ticker: idle while counted; the periodic tick, a vCPU\'s deadline and the xHCI\'s due time without', async () => {
  const k = setup();
  try {
    await k.ready();
    // Counting: nothing, whatever the deadlines say.
    k.u64[TICKS[0] / 8] = BigInt(Math.round(k.vmNs()));
    k.ring();
    await sleep(20);
    assert.deepEqual([k.stop(0), k.stop(1), k.bits(0), k.bits(1)], [1, 1, 0, 0], 'idle while the code counts');
    k.u64[TICKS[0] / 8] = NONE;

    // Uncounted, 1 ms ticks: every vCPU's bits and stop word.
    Atomics.store(k.i32, TICKER / 4 + 1, 0);
    k.ring();
    for (let r = 0; r < 5; r++) {
      assert.ok((await until(() => k.stop(0) === 0 && k.stop(1) === 0, 50)) !== undefined, `periodic tick ${r}`);
      assert.equal(k.bits(0) & TICK_PERIODIC, TICK_PERIODIC);
      assert.equal(k.bits(1) & TICK_PERIODIC, TICK_PERIODIC);
      k.rearm();
    }

    // A long period: a vCPU's deadline alone, at it.
    k.u64[TICKER / 8 + 1] = 10_000_000_000n;
    k.ring();
    await sleep(5);
    k.rearm();
    k.bits(0);
    k.bits(1);
    const late: number[] = [];
    for (let r = 0; r < 8; r++) {
      const due = k.vmNs() + 3e6;
      k.u64[TICKS[0] / 8] = BigInt(Math.round(due));
      k.ring();
      assert.ok((await until(() => k.stop(0) === 0, 50)) !== undefined, `deadline ${r}`);
      const at = k.vmNs();
      // Not before it (the clocks agree to the worker's round trip, ~0.1 ms), and taken.
      assert.ok(at >= due - 200e3, `deadline ${r}: ${((due - at) / 1e3).toFixed(0)} µs early`);
      late.push((at - due) / 1e3);
      assert.equal(k.bits(0), TICK_TIMER);
      assert.equal(k.u64[TICKS[0] / 8], NONE, 'the deadline taken');
      assert.deepEqual([k.stop(1), k.bits(1)], [1, 0], "the other vCPU's untouched");
      k.rearm();
    }
    late.sort((a, b) => a - b);
    assert.ok(late[4] < 2000, `deadlines late: ${late.map((x) => x.toFixed(0)).join(' ')} µs`);

    // A deadline published again (one taken early, the run loop's TIMER look found it not due) comes again.
    k.u64[TICKS[1] / 8] = BigInt(Math.round(k.vmNs() - 1e3));
    k.ring();
    assert.ok((await until(() => k.stop(1) === 0, 50)) !== undefined, 'a passed deadline at once');
    k.rearm();
    k.bits(1);
    k.u64[TICKS[1] / 8] = BigInt(Math.round(k.vmNs() + 1e6));
    k.ring();
    assert.ok((await until(() => k.stop(1) === 0, 50)) !== undefined, 'published again');
    assert.equal(k.bits(1), TICK_TIMER);
    k.rearm();

    // The xHCI's due time: one stop word, then (the due time staying) the other's, no bits.
    const xdue = k.vmNs() + 2e6;
    k.u64[XHCI / 8] = BigInt(Math.round(xdue));
    k.ring();
    // The gap between the two stores, the best of a few rounds (a round this thread was preempted in sees none).
    let best = 0;
    for (let r = 0; r < 5 && best < 0.04; r++) {
      if (r > 0) {
        k.rearm();
        k.u64[XHCI / 8] = BigInt(Math.round(k.vmNs() + 2e6));
        k.ring();
      }
      const at: number[] = [];
      assert.ok(
        spinUntil(() => {
          for (let i = 0; i < 2; i++) if (at[i] === undefined && k.stop(i) === 0) at[i] = performance.now();
          return at[0] !== undefined && at[1] !== undefined;
        }, 50) !== undefined,
        `the xHCI's due time ${r}`,
      );
      best = Math.max(best, Math.abs(at[1] - at[0]));
    }
    assert.ok(best >= 0.04, `one vCPU's stop word at a time, the other's XHCI_AGAIN_MS later: ${(best * 1e3).toFixed(1)} µs`);
    assert.ok(k.vmNs() >= xdue - 200e3);
    assert.deepEqual([k.bits(0), k.bits(1)], [0, 0]);
    k.u64[XHCI / 8] = NONE;
    k.ring();

    // Counting again: idle.
    Atomics.store(k.i32, TICKER / 4 + 1, 1);
    k.ring();
    await sleep(5);
    k.rearm();
    k.u64[TICKS[0] / 8] = BigInt(Math.round(k.vmNs()));
    await sleep(20);
    assert.deepEqual([k.stop(0), k.stop(1)], [1, 1], 'idle again');
  } finally {
    await k.w.terminate();
  }
});

test('ticker: deadlines that pass together fire STAGGER_MS apart', async () => {
  const k = setup();
  try {
    await k.ready();
    k.uncounted(10_000_000_000n);
    await sleep(5);
    k.rearm();
    k.bits(0);
    k.bits(1);
    const gaps: number[] = [];
    for (let r = 0; r < 5; r++) {
      const due = BigInt(Math.round(k.vmNs() + 2e6));
      [k.u64[TICKS[0] / 8], k.u64[TICKS[1] / 8]] = [due, due];
      k.ring();
      const at: number[] = [];
      assert.ok(
        spinUntil(() => {
          for (let i = 0; i < 2; i++) if (at[i] === undefined && k.stop(i) === 0) at[i] = performance.now();
          return at[0] !== undefined && at[1] !== undefined;
        }, 50) !== undefined,
        `round ${r}: both fired`,
      );
      gaps.push(Math.abs(at[1] - at[0]));
      assert.deepEqual([k.bits(0), k.bits(1)], [TICK_TIMER, TICK_TIMER]);
      k.rearm();
    }
    // The best round's (one this thread was preempted in, or its first, unoptimized laps, may see both at once).
    const best = Math.max(...gaps);
    assert.ok(best >= STAGGER_MS * 0.8, `fired ${gaps.map((g) => (g * 1e3).toFixed(1)).join(', ')} µs apart`);
  } finally {
    await k.w.terminate();
  }
});

test('ticker: a deadline its clock sees early, published again, fires a few more times, not once per round trip', async () => {
  // The ticker's clock 1 ms ahead of the vCPU's: it takes each deadline 1 ms early (its clock's estimate, under load,
  // off by its round trips at most). Without the doubling gap that was hundreds of fires; with it, about 7.
  const k = setup(1);
  try {
    await k.ready();
    k.uncounted(10_000_000_000n);
    await sleep(5);
    k.rearm();
    k.bits(0);
    let total = 0;
    for (let r = 0; r < 3; r++) {
      const due = Math.round(k.vmNs() + 4e6);
      k.u64[TICKS[0] / 8] = BigInt(due);
      k.ring();
      let early = 0;
      // The run loop's side: a TIMER found not due yet publishes the same deadline again (core/src/vm/parallel.rs).
      spinUntil(() => {
        if (k.stop(0) === 0) {
          k.rearm();
          assert.equal(k.bits(0), TICK_TIMER);
          if (k.vmNs() < due) {
            early++;
            k.u64[TICKS[0] / 8] = BigInt(due);
            k.ring();
          } else return true;
        }
        return false;
      }, 50);
      assert.ok(early <= 12, `round ${r}: ${early} early fires`);
      total += early;
    }
    assert.ok(total >= 3, `the clocks' skew shows: ${total} early fires`);
  } finally {
    await k.w.terminate();
  }
});

test('ticker: while the VM clock is held, a deadline spins nothing', async () => {
  const k = setup();
  try {
    await k.ready();
    k.uncounted(1_000_000n);
    // Held at 1 s (`Clock::hold`: t0 u64::MAX), a deadline 10 µs past it.
    k.u64[BASE / 8] = 1_000_000_000n;
    k.u64[T0 / 8] = NONE;
    k.u64[TICKS[0] / 8] = 1_000_010_000n;
    k.ring();
    await sleep(20);
    const c0 = process.cpuUsage();
    const t0 = performance.now();
    await sleep(200);
    const c = process.cpuUsage(c0);
    const share = (c.user + c.system) / 1e3 / (performance.now() - t0);
    assert.ok(share < 0.3, `the ticker's CPU while held: ${(share * 100).toFixed(0)}%`);
    assert.equal(k.u64[TICKS[0] / 8], 1_000_010_000n, 'not taken');
  } finally {
    await k.w.terminate();
  }
});
