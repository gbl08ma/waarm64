// The tailcat server's nearest DERP region (web/tailcat.ts `nearestRegion`): a DERP map fetch that never answers (a
// captive portal, a stalled connection) gives up at the probes' deadline, so the start goes on with region 0.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { nearestRegion } from '../web/tailcat.ts';

test("a DERP map that doesn't come gives up at the deadline", async () => {
  const fetch0 = globalThis.fetch;
  // A fetch that hangs until its signal aborts.
  globalThis.fetch = ((_url: string, init?: RequestInit) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason as Error));
    })) as typeof fetch;
  try {
    const t0 = performance.now();
    const region = await Promise.race([
      nearestRegion('https://derp.invalid/derpmap.json', 50).catch(() => 0),
      new Promise((r) => setTimeout(() => r('hung'), 2000)),
    ]);
    assert.equal(region, 0);
    assert.ok(performance.now() - t0 < 1000);
  } finally {
    globalThis.fetch = fetch0;
  }
});
