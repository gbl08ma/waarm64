// Parallel SMP's ticker (web/ticker-worker.ts; docs/abi.md "PERF: parallel SMP's code without `acc`"), its worker run in
// a Node worker thread on a memory laid out as the core's words are (`vm_ticker`, `vm_cpu_tick`, `vm_cpu_stop`): idle
// while the code counts its steps; the periodic tick in every vCPU's bits and stop word; a vCPU's timer deadline in its
// own alone, at the deadline and not before (the deadline taken), again when published again; the xHCI's due time in
// every stop word. The core's side (the run loop's swap of the bits, its deadlines) is the spin tests'.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Worker } from 'node:worker_threads';
import { TICK_PERIODIC, TICK_TIMER, type TickerClock, type TickerJob } from '../web/ticker-worker.ts';

const NONE = 0xffff_ffff_ffff_ffffn;
/** The words' byte addresses: the ticker's, the VM clock's start and base, the xHCI's due time, two vCPUs' tick words and stop words. */
const TICKER = 0, T0 = 64, BASE = 72, XHCI = 80, TICKS = [128, 144], STOPS = [256, 260];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** The creator's clock, as the core's `now_ms` reads it (web/core.ts `clockOffset`). */
const nowMs = () => performance.timeOrigin + performance.now();

function setup() {
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
  w.on('message', (m: TickerClock) => w.postMessage({ type: 'clock', t: nowMs() } satisfies TickerClock));
  w.postMessage({ memory, ticker: TICKER, ticks: TICKS, stops: STOPS } satisfies TickerJob);
  const stop = (i: number) => Atomics.load(i32, STOPS[i] / 4);
  const bits = (i: number) => Atomics.exchange(i32, TICKS[i] / 4 + 2, 0);
  const rearm = () => STOPS.forEach((s) => Atomics.store(i32, s / 4, 1));
  return { i32, u64, u32, vmNs, ring, w, stop, bits, rearm };
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
    await sleep(100); // the worker's clock queries
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

    // The xHCI's due time: every stop word, no bits.
    const xdue = k.vmNs() + 2e6;
    k.u64[XHCI / 8] = BigInt(Math.round(xdue));
    k.ring();
    assert.ok((await until(() => k.stop(0) === 0 && k.stop(1) === 0, 50)) !== undefined, "the xHCI's due time");
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
