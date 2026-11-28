// An idle vCPU's sleep to its deadline (web/vcpu-worker.ts, `IDLE`; docs/platform.md "Parallel SMP"). A timed
// `Atomics.wait` comes back late by a share of its timeout on macOS (its timer leeway: ~130 µs at the median of a ~1 ms
// wait, ~470 µs of ~4 ms; bench/boot/REPORT.md "PERF loop 53"), so a vCPU in WFI saw its own timer 0.3-1.9 ms late on
// average there. Waits of a share of the time left converge on the deadline (each one's leeway is a share of a shorter
// timeout), and the last `TAIL_MS` is spun (bench/boot/REPORT.md "PERF loop 58").

/** Below this much time left the sleep spins: a wait's wake-up costs about this much on the Mac. */
export const TAIL_MS = 0.04;
/**
 * Each wait's share of the time left. A wait comes back past the deadline when its leeway passes 1/SHARE − 1 of its
 * timeout (50% here: Node's workers on the Mac come near that, Chromium's ~13% at the median, ~50% at the p99): on the
 * Mac, 2/3 was 12-29 µs late on average for an idle guest's host CPU +0.7% of a core, 1/2 6-7 µs for +3%, 3/4 ~95 µs.
 */
export const SHARE = 2 / 3;
/**
 * How long an idle vCPU polls its wake word before sleeping on it (`VcpuJob.spinMs` overrides it). The poll catches a
 * wake-up that comes soon (the atomics stress's pingpong, a futex hand-off a round: ~11 µs a round on the Mac with a
 * poll of 10-100 µs, 2.5× that without; the dev VM needs 20); every other idle pays it whole: in Firefox's pages session
 * 12% of the polls ended in a wake-up. 20 µs against M7 loop 8's 50: the pages session's renderer CPU −2.8%, an idle
 * guest's −12%, the hand-offs as fast; 0 saved twice that and slowed them (bench/boot/REPORT.md "PERF loop 83").
 */
export const SPIN_MS = 0.02;
/**
 * An idle vCPU polls only while its recent idles' wake-ups came within a poll: after this many idles in a row that a
 * poll didn't end, it sleeps at once (but for `POLL_PROBE`'s), until a wake-up comes within a poll again (`pollRule`;
 * 0: every idle polls). Futex hand-offs come in runs (the atomics stress's pingpong: 95% of its idles end in the poll);
 * elsewhere the catches are scattered (Firefox's pages session: 6%; an idle guest: none). 8 keeps the pingpong's
 * hand-offs as fast on the Mac and in the dev VM (1 slowed them 1.8-2.5× in the VM, 4 by 2-6%), and took 1.1 points off
 * an idle 4-vCPU guest's host CPU on the Mac, 1.2% off the pages session's renderer CPU (bench/boot/REPORT.md "PERF
 * loop 98").
 */
export const POLL_MISSES = 8;
/**
 * A vCPU that stopped polling still polls one idle in this many (a probe): what brings the poll back is a poll that
 * caught a wake-up, whatever a wake-up through the wait costs on this host (an unpolled idle can't tell a wake-up that
 * came within the poll from one past it plus the wait's latency: ~16 µs on the Mac, ~36 in the dev VM, more on a busy
 * host; bench/boot/REPORT.md "PERF loop 100").
 */
export const POLL_PROBE = 16;
/** A polled idle that ended within this much of its poll's end was ended by the poll: a wait's wake-up takes longer. */
const POLL_END_MS = 0.008;

/**
 * A vCPU's poll before each idle's sleep (`idle`'s `spinMs`): `spinMs`, or after `misses` idles in a row that a poll
 * didn't end, `spinMs` one idle in `probe` and none in the others. An idle counts as caught when its poll ended it or,
 * unpolled, its wake-up came within the poll's length (one a poll would have caught, whatever the wait's latency).
 */
export function pollRule(spinMs = SPIN_MS, misses = POLL_MISSES, probe = POLL_PROBE) {
  let n = 0;
  let k = 0;
  return {
    /** This idle's poll, in ms (once an idle: it counts the probes). */
    spin: () => {
      if (misses <= 0 || n < misses) return spinMs;
      k = (k + 1) % probe;
      return k === 0 ? spinMs : 0;
    },
    /** The idle (its poll `spun` ms) ended `ms` after its start, by a wake-up (`woken`: its word moved) or not. */
    seen: (spun: number, woken: boolean, ms: number) => {
      const caught = woken && ms < (spun > 0 ? spun + POLL_END_MS : spinMs);
      n = caught ? 0 : Math.min(n + 1, misses);
      if (caught) k = 0;
    },
  };
}
export type PollRule = ReturnType<typeof pollRule>;

export type Clock = () => number;
export type Wait = (word: Int32Array, index: number, value: number, ms: number) => string;
export type WaitAsync = (
  word: Int32Array,
  index: number,
  value: number,
  ms: number,
) => { async: false; value: string } | { async: true; value: Promise<string> };
/** The worker's clock and waits, injected by the tests. */
export type Host = { now: Clock; wait: Wait; waitAsync: WaitAsync };

const NOW: Clock = () => performance.now();
const WAIT: Wait = (word, index, value, ms) => Atomics.wait(word, index, value, ms);
export const HOST: Host = {
  now: NOW,
  wait: WAIT,
  waitAsync: (word, index, value, ms) => Atomics.waitAsync(word, index, value, ms),
};

/**
 * Sleeps until `word[0]` leaves `value` (a wake-up: a notify or a store seen) or the clock reaches `end` (ms, on
 * `now`'s clock): waits of `SHARE` of the time left while more than `TAIL_MS` is left, then a spin to `end`. Returns the
 * number of waits it took.
 */
export function sleepUntil(word: Int32Array, value: number, end: number, now: Clock = NOW, wait: Wait = WAIT): number {
  let waits = 0;
  for (let left = end - now(); left > TAIL_MS; left = end - now()) {
    waits++;
    if (wait(word, 0, value, left * SHARE) !== 'timed-out') return waits;
  }
  while (Atomics.load(word, 0) === value && now() < end);
  return waits;
}

/**
 * An event-loop wait ends at least this long before the deadline. Its timeout is a delayed task on the worker's event
 * loop, late by a time of its own rather than a share of the timeout: in Chrome on the Mac 0.6 ms on average, 1.9 ms at
 * the p99, 2.1 at most at 1 ms gaps (bench/boot/REPORT.md "PERF loop 53"; PERF loop 60 for the vCPU worker's).
 */
export const LEAD_MS = 2.5;
/** A return due this long and still not taken (every idle too short for it) is taken in the next idle anyway. */
export const OVERDUE_MS = 100;

/**
 * The worker's returns to its event loop (`VcpuJob.yieldMs`, 0 never). Only a wait that went to the event loop counts:
 * `Atomics.waitAsync` returns at once, with no task, when the word already moved or the timeout is 0.
 */
export function turns(yieldMs: number, h: Host = HOST) {
  let last = h.now();
  const since = () => h.now() - last;
  return {
    /** A return is due: `yieldMs` passed since the last. */
    due: () => yieldMs > 0 && since() >= yieldMs,
    /** Due for `OVERDUE_MS` more. */
    overdue: () => yieldMs > 0 && since() >= yieldMs + OVERDUE_MS,
    /** A wait in the event loop on `word` while it holds `value`, for at most `ms`; true when it was one. */
    pass: async (word: Int32Array, value: number, ms: number) => {
      const w = h.waitAsync(word, 0, value, ms);
      if (!w.async) return false;
      await w.value;
      last = h.now();
      return true;
    },
  };
}
export type Turns = ReturnType<typeof turns>;

/** The yield of a BUDGET or DEVICE exit: a µs's wait on the wake word, ended by its task or a wake-up. */
export function yieldTurn(t: Turns, wake: Int32Array) {
  return t.pass(wake, Atomics.load(wake, 0), 0.001);
}

/**
 * An `IDLE` exit's wait: until `t0 + ms` (an off vCPU, `ms` undefined: a second) or a wake-up (`wake[0]` leaves
 * `value`). `t0` is the exit's time (`vm_run_cpu`'s return): what the worker did since isn't added. Polls first for `spinMs` (a
 * wake-up through `Atomics.wait` takes ~17 µs in the dev VM), then sleeps by `sleepUntil`. When a return to the event
 * loop is due, the first wait is there if it can end `LEAD_MS` before the deadline (of an off vCPU: always); else the
 * return stays due for a later exit, until it is overdue. Returns a promise when it waits in the event loop, else
 * nothing (it's done).
 */
export function idle(
  wake: Int32Array,
  value: number,
  ms: number | undefined,
  t0: number,
  t: Turns,
  spinMs = SPIN_MS,
  h: Host = HOST,
): Promise<unknown> | undefined {
  const off = ms === undefined;
  const end = t0 + (off ? 1000 : ms);
  const spin = Math.min(end - t0, spinMs);
  while (Atomics.load(wake, 0) === value && h.now() - t0 < spin);
  if (off) {
    if (t.due() && Atomics.load(wake, 0) === value) return t.pass(wake, value, end - h.now());
    h.wait(wake, 0, value, end - h.now());
    return;
  }
  if (t.due() && Atomics.load(wake, 0) === value) {
    const left = end - h.now();
    const ms = left > LEAD_MS ? Math.min(left / 2, left - LEAD_MS) : t.overdue() ? Math.max(left / 2, 0.001) : 0;
    if (ms > 0) return t.pass(wake, value, ms).then(() => void sleepUntil(wake, value, end, h.now, h.wait));
  }
  sleepUntil(wake, value, end, h.now, h.wait);
}

/**
 * A TX_FULL exit: the coordinator drains the console (its word bumped) while the vCPU waits for the drain (the TX
 * ring's tail moving: web/vm.ts `drain` notifies it), a ms at most. `ring` is the ring's head and tail
 * (core/src/pl011.rs `Rings`), `size` its bytes; a ring with room already (drained since the exit) isn't waited for.
 * The liveness block's `handled` before the wait: the wait isn't host work.
 */
export function txFull(
  ctl: Int32Array,
  ring: Int32Array,
  live: { handled(): void } | undefined,
  h: Host = HOST,
  size = 4096,
) {
  Atomics.add(ctl, 0, 1);
  Atomics.notify(ctl, 0);
  live?.handled();
  const tail = Atomics.load(ring, 1);
  if ((Atomics.load(ring, 0) - tail) >>> 0 >= size) h.wait(ring, 1, tail, 1);
}
