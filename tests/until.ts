// Waiting on a condition instead of a fixed time (docs/testing.md "Waiting in tests"): a fixed settle before an assert
// fails whenever the machine stalls the test past it (CI's load: the timer fires first when the process resumes,
// before the message it waited for is taken), however long it is. These poll with a generous deadline instead.
import assert from 'node:assert/strict';

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Waits until `cond` holds, polled every few ms; past `ms` (10 s by default) fails with `what`. */
export async function until(cond: () => unknown, what: string, ms = 10_000): Promise<void> {
  const end = performance.now() + ms;
  while (!(await cond())) {
    if (performance.now() > end) assert.fail(`timed out (${ms} ms) waiting for ${what}`);
    await tick(2);
  }
}

/**
 * Retries `check` (its assertions) until it passes; past `ms` (10 s by default) throws its last failure. For the
 * checks that something did happen: one that something didn't still needs its settle first (it would pass at once).
 */
export async function eventually(check: () => unknown, ms = 10_000): Promise<void> {
  const end = performance.now() + ms;
  for (;;) {
    try {
      await check();
      return;
    } catch (e) {
      if (performance.now() > end) throw e;
    }
    await tick(2);
  }
}
