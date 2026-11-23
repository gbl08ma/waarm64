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

export type Clock = () => number;
export type Wait = (word: Int32Array, index: number, value: number, ms: number) => string;

const NOW: Clock = () => performance.now();
const WAIT: Wait = (word, index, value, ms) => Atomics.wait(word, index, value, ms);

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
