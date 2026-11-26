// The vCPU worker's waits (web/idle-wait.ts): an idle vCPU's sleep to its deadline, on a clock whose timed waits come
// back late by a share of their timeout (macOS's timer leeway), ends within a spin's grain of the deadline, and a
// wake-up ends it; the worker's returns to its event loop (an `Atomics.waitAsync`, whose timeout is a delayed task that
// comes back late by a fixed time in Chromium on the Mac) don't make a vCPU see its timer late, are counted only when
// they reached the event loop, and end on a wake-up.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { idle, SHARE, sleepUntil, TAIL_MS, turns, txFull, yieldTurn, type Host } from '../web/idle-wait.ts';

/** The tail's spin stays under this (each idle exit spins it: PERF loop 58's host CPU). Not `TAIL_MS`, so raising it fails. */
const SPIN_BOUND = 0.045;

/**
 * A fake host: a clock that moves 0.5 µs a read; timed waits that come back `leeway` of their timeout late; event-loop
 * waits that come back `late` ms past their timeout (a delayed task's lateness: PERF loop 53's 0.6 ms mean, 1.9 ms p99
 * in Chrome on the Mac); a wake-up of `wake` at `wakeAt` (bumps it and ends a wait on it then).
 */
function host(leeway: number, o: { wakeAt?: number; late?: number } = {}) {
  const wake = new Int32Array(new SharedArrayBuffer(4));
  const h = { t: 0, waits: [] as number[], asyncs: [] as number[], waitEnd: 0, wake, reads: 0 };
  const wakeAt = o.wakeAt ?? Infinity;
  const late = o.late ?? 0.6;
  // Up to `until`, or the wake-up if it lands first (on this word).
  const to = (word: Int32Array, until: number) => {
    if (word === wake && h.t < wakeAt && until >= wakeAt) {
      h.t = wakeAt;
      Atomics.add(wake, 0, 1);
      return 'ok';
    }
    h.t = until;
    return 'timed-out';
  };
  const hst: Host = {
    now: () => {
      h.reads++;
      if (h.t < wakeAt && h.t + 0.0005 >= wakeAt) Atomics.add(wake, 0, 1); // the store a poll or spin sees
      return (h.t += 0.0005);
    },
    wait: (word, _i, value, ms) => {
      if (Atomics.load(word, 0) !== value) return 'not-equal';
      h.waits.push(ms);
      const r = to(word, h.t + ms * (1 + leeway));
      h.waitEnd = h.t;
      return r;
    },
    waitAsync: (word, _i, value, ms) => {
      if (Atomics.load(word, 0) !== value) return { async: false, value: 'not-equal' };
      if (!(ms > 0)) return { async: false, value: 'timed-out' }; // the spec's DoWait: t = 0 returns at once
      h.asyncs.push(ms);
      const r = to(word, h.t + ms + late);
      h.waitEnd = h.t;
      return { async: true, value: Promise.resolve(r) };
    },
  };
  return { h, hst, wake };
}

// Up to 1/SHARE − 1 (50%): past it a wait can overshoot the deadline (web/idle-wait.ts `SHARE`).
for (const leeway of [0, 0.15, 0.4, 1 / SHARE - 1]) {
  for (const ms of [0.03, 0.5, 4, 20, 1000]) {
    test(`a ${ms} ms sleep with waits ${Math.round(leeway * 100)}% late ends within 5 µs of its deadline`, () => {
      const { h, hst, wake } = host(leeway);
      const n = sleepUntil(wake, 0, ms, hst.now, hst.wait);
      const late = h.t - ms;
      assert.ok(late >= 0 && late < 0.005, `${(late * 1000).toFixed(1)} µs late after ${n} waits`);
      assert.equal(n, h.waits.length);
      assert.ok(n <= Math.ceil(Math.log2(Math.max(1, ms / TAIL_MS))) + 2, `${n} waits`);
      assert.ok(h.waits.every((w) => w >= TAIL_MS * SHARE), 'no wait shorter than its share of the tail');
      const spun = h.t - h.waitEnd;
      assert.ok(spun <= SPIN_BOUND, `spun ${(spun * 1000).toFixed(1)} µs`);
    });
  }
}

// Past it, the first wait overshoots by its excess and nothing more: the sleep ends there.
for (const leeway of [0.8, 1]) {
  for (const ms of [0.5, 4, 1000]) {
    test(`a ${ms} ms sleep with waits ${Math.round(leeway * 100)}% late overshoots by the first wait's excess only`, () => {
      const { h, hst, wake } = host(leeway);
      const n = sleepUntil(wake, 0, ms, hst.now, hst.wait);
      const late = h.t - ms;
      const excess = ms * (SHARE * (1 + leeway) - 1);
      assert.equal(n, 1);
      assert.ok(late >= 0 && late <= excess + 0.005, `${(late * 1000).toFixed(1)} µs late, excess ${(excess * 1000).toFixed(1)}`);
    });
  }
}

test('a wake-up during a wait ends the sleep there', () => {
  const { h, hst, wake } = host(0.15, { wakeAt: 3 });
  sleepUntil(wake, 0, 10, hst.now, hst.wait);
  assert.equal(h.t, 3);
});

test('a word already moved ends the sleep without spinning to the deadline', () => {
  const { h, hst, wake } = host(0.15);
  wake[0] = 1;
  sleepUntil(wake, 0, 0.03, hst.now, hst.wait); // in the tail: the spin sees it
  assert.ok(h.t < 0.002, `${h.t} ms`);
  sleepUntil(wake, 0, 10, hst.now, hst.wait); // before the tail: the wait sees it
  assert.ok(h.t < 0.004, `${h.t} ms`);
});

test('a deadline already past returns at once', () => {
  const { h, hst, wake } = host(0);
  h.t = 5;
  assert.equal(sleepUntil(wake, 0, 1, hst.now, hst.wait), 0);
  assert.ok(h.t < 5.002);
});

test('the real clock and Atomics.wait: a 3 ms sleep ends at its deadline, not before', () => {
  const word = new Int32Array(new SharedArrayBuffer(4));
  const t0 = performance.now();
  sleepUntil(word, 0, t0 + 3);
  assert.ok(performance.now() - t0 >= 3);
});

// The worker's IDLE exit (web/vcpu-worker.ts): `idle`.

/** An idle exit at the fake clock's now, with the event loop's turn due (100 ms since the last) or not. */
async function idleAt(h: ReturnType<typeof host>['h'], hst: Host, wake: Int32Array, ms: number | undefined, due: boolean) {
  const t = turns(100, hst);
  if (due) h.t += 100;
  const t0 = hst.now();
  const p = idle(wake, Atomics.load(wake, 0), ms, t0, t, undefined, hst);
  if (p) await p;
  return { t, t0, yielded: p !== undefined };
}

for (const late of [0.6, 2]) {
  for (const ms of [0.2, 1, 2, 3, 4, 20, 1000]) {
    test(`a ${ms} ms idle with the event loop's turn due and its waits ${late} ms late ends within 5 µs of its deadline`, async () => {
      const { h, hst, wake } = host(0.15, { late });
      const { t0, yielded } = await idleAt(h, hst, wake, ms, true);
      const over = h.t - (t0 + ms);
      assert.ok(over >= 0 && over < 0.005, `${(over * 1000).toFixed(1)} µs late`);
      // Taken where it fits (with room for a delayed task's lateness), else left due for a later exit.
      if (ms >= 4) assert.ok(yielded, 'the turn was taken');
    });
  }
}

test('an idle without the turn due never waits in the event loop, and spins only its poll and tail', async () => {
  for (const ms of [0.03, 1, 20]) {
    const { h, hst, wake } = host(0.15);
    const { yielded, t0 } = await idleAt(h, hst, wake, ms, false);
    assert.equal(yielded, false);
    assert.equal(h.asyncs.length, 0);
    const spun = h.waits.length ? h.t - h.waitEnd : h.t - t0;
    assert.ok(spun <= Math.max(SPIN_BOUND, Math.min(ms, 0.05)) + 0.001, `${ms} ms: spun ${(spun * 1000).toFixed(1)} µs`);
  }
});

test("an idle polls its wake word for its spin (`spinMs`) before it waits, and none at 0", () => {
  for (const spin of [0, 0.02, 0.1]) {
    const { h, hst, wake } = host(0.15);
    const t0 = hst.now();
    idle(wake, 0, 20, t0, turns(100, hst), spin, hst);
    // The first wait's start: its timeout is SHARE of what was left then.
    const first = t0 + 20 - h.waits[0] / SHARE;
    assert.ok(first - t0 >= spin && first - t0 <= spin + 0.005, `spin ${spin * 1000} µs: waited after ${((first - t0) * 1000).toFixed(1)} µs`);
  }
  // A wake-up within the poll ends the idle without a wait.
  const { h, hst, wake } = host(0.15, { wakeAt: 0.01 });
  idle(wake, 0, 20, hst.now(), turns(100, hst), 0.02, hst);
  assert.equal(h.waits.length, 0);
});

test("a wake-up within the idle's poll leaves the event loop's turn due", async () => {
  const { h, hst, wake } = host(0.15, { wakeAt: 100.02 });
  const { t } = await idleAt(h, hst, wake, 20, true);
  assert.ok(h.t < 100.03, `${h.t}`);
  assert.equal(t.due(), true, 'a waitAsync that returned at once was counted as a turn');
});

test("an idle shorter than its poll leaves the event loop's turn due", async () => {
  const { h, hst, wake } = host(0.15);
  const { t, t0 } = await idleAt(h, hst, wake, 0.03, true);
  assert.ok(h.t - (t0 + 0.03) < 0.005);
  assert.equal(t.due(), true);
});

test("an off vCPU woken within its poll leaves the turn due; one that sleeps takes it", async () => {
  {
    const { hst, wake, h } = host(0, { wakeAt: 100.02 });
    const { t } = await idleAt(h, hst, wake, undefined, true);
    assert.equal(t.due(), true);
  }
  {
    const { hst, wake, h } = host(0, { wakeAt: 400 });
    const { t, yielded } = await idleAt(h, hst, wake, undefined, true);
    assert.equal(yielded, true);
    assert.ok(h.t < 400.01, `${h.t}`); // the wake-up ended it
    assert.equal(t.due(), false);
  }
});

test('short idles alone still take the turn, once it is overdue', async () => {
  const { h, hst, wake } = host(0.15);
  const t = turns(100, hst);
  let taken = -1;
  while (h.t < 1000 && taken < 0) {
    const p = idle(wake, 0, 1, hst.now(), t, undefined, hst);
    if (p) await p;
    if (p && !t.due()) taken = h.t;
    h.t += 0.1; // the vCPU runs a little between idles
  }
  assert.ok(taken >= 100 && taken < 250, `taken at ${taken.toFixed(1)} ms`);
});

test('an idle counts from the exit: a host delay after it is not added to the deadline', async () => {
  const { h, hst, wake } = host(0.15);
  const t = turns(100, hst);
  const t0 = hst.now();
  h.t += 3; // the worker held up between the exit and its wait
  assert.equal(idle(wake, 0, 2, t0, t, undefined, hst), undefined);
  assert.ok(h.t - t0 < 3.01, `${h.t - t0}`);
  assert.equal(h.waits.length, 0);
});

// The yield of a BUDGET or DEVICE exit: `yieldTurn`.

test('a BUDGET or DEVICE yield ends on a wake-up, not at its timer', async () => {
  const { h, hst, wake } = host(0, { wakeAt: 0.05, late: 0.6 });
  const t = turns(100, hst);
  await yieldTurn(t, wake);
  assert.ok(h.t <= 0.051, `ended at ${(h.t * 1000).toFixed(0)} µs`);
  assert.equal(t.due(), false);
});

test('a BUDGET or DEVICE yield that returned at once is not counted', async () => {
  const { h, hst, wake } = host(0);
  // The word moves between the worker's read and the wait: the wait returns 'not-equal' without a task.
  const racing: Host = { ...hst, waitAsync: (w, i, v, ms) => (Atomics.add(w, 0, 1), hst.waitAsync(w, i, v, ms)) };
  const t = turns(100, racing);
  h.t += 100;
  await yieldTurn(t, wake);
  assert.equal(t.due(), true);
});

// TX_FULL.

test("TX_FULL's wait for the drain is not counted as host work", () => {
  const { h, hst, wake } = host(0);
  const ctl = new Int32Array(new SharedArrayBuffer(4));
  let at = NaN;
  txFull(ctl, wake, { handled: () => (at = h.t) }, hst);
  assert.equal(ctl[0], 1);
  assert.ok(h.t >= 1, 'it waited');
  assert.ok(at < 0.01, `handled at ${at} ms`);
});
