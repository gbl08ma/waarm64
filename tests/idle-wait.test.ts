// An idle vCPU's sleep to its deadline (web/idle-wait.ts): on a clock whose timed waits come back late by a share of
// their timeout (macOS's timer leeway), it still ends within a spin's grain of the deadline, and a wake-up ends it.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SHARE, sleepUntil, TAIL_MS, type Wait } from '../web/idle-wait.ts';

/** A fake clock that moves 0.5 µs a read, and timed waits that come back `leeway` of their timeout late. */
function host(leeway: number, wakeAt = Infinity) {
  const h = { t: 0, waits: [] as number[] };
  const now = () => (h.t += 0.0005);
  const wait: Wait = (word, _i, value, ms) => {
    if (Atomics.load(word, 0) !== value) return 'not-equal';
    h.waits.push(ms);
    const until = h.t + ms * (1 + leeway);
    if (until >= wakeAt) {
      h.t = wakeAt;
      Atomics.add(word, 0, 1);
      return 'ok';
    }
    h.t = until;
    return 'timed-out';
  };
  return { h, now, wait };
}

// Up to 1/SHARE − 1 (50%): past it a wait can overshoot the deadline (web/idle-wait.ts `SHARE`).
for (const leeway of [0, 0.15, 0.4, 1 / SHARE - 1]) {
  for (const ms of [0.03, 0.5, 4, 20, 1000]) {
    test(`a ${ms} ms sleep with waits ${Math.round(leeway * 100)}% late ends within 5 µs of its deadline`, () => {
      const { h, now, wait } = host(leeway);
      const word = new Int32Array(new SharedArrayBuffer(4));
      const n = sleepUntil(word, 0, ms, now, wait);
      const late = h.t - ms;
      assert.ok(late >= 0 && late < 0.005, `${(late * 1000).toFixed(1)} µs late after ${n} waits`);
      assert.equal(n, h.waits.length);
      assert.ok(n <= Math.ceil(Math.log2(Math.max(1, ms / TAIL_MS))) + 2, `${n} waits`);
      assert.ok(h.waits.every((w) => w >= TAIL_MS * SHARE), 'no wait shorter than its share of the tail');
    });
  }
}

test('a wake-up during a wait ends the sleep there', () => {
  const { h, now, wait } = host(0.15, 3);
  const word = new Int32Array(new SharedArrayBuffer(4));
  sleepUntil(word, 0, 10, now, wait);
  assert.equal(h.t, 3);
});

test('a word already moved ends the sleep without spinning to the deadline', () => {
  const { h, now, wait } = host(0.15);
  const word = new Int32Array(new SharedArrayBuffer(4));
  word[0] = 1;
  sleepUntil(word, 0, 0.03, now, wait); // in the tail: the spin sees it
  assert.ok(h.t < 0.002, `${h.t} ms`);
  sleepUntil(word, 0, 10, now, wait); // before the tail: the wait sees it
  assert.ok(h.t < 0.004, `${h.t} ms`);
});

test('a deadline already past returns at once', () => {
  const { h, now, wait } = host(0);
  const word = new Int32Array(new SharedArrayBuffer(4));
  h.t = 5;
  assert.equal(sleepUntil(word, 0, 1, now, wait), 0);
  assert.ok(h.t < 5.002);
});

test('the real clock and Atomics.wait: a 3 ms sleep ends at its deadline, not before', () => {
  const word = new Int32Array(new SharedArrayBuffer(4));
  const t0 = performance.now();
  sleepUntil(word, 0, t0 + 3);
  assert.ok(performance.now() - t0 >= 3);
});
