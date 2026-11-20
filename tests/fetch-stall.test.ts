// A remote disk's reads (web/chunked.ts `fetchBytes`: a chunked image's pieces, a raw image's ranges) are bounded by
// progress: a connection that goes quiet is aborted and tried again, a slow one that keeps bringing bytes is waited for.
// `fetch` is faked here: a server whose body comes in timed parts, or stops.
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { fetchBytes } from '../web/chunked.ts';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** A server answering each fetch with `plan(try)`: its parts after their delays (ms); `stall` stops before the rest. */
function serve(plan: (n: number) => { status?: number; parts: [number, number][]; stall?: boolean }) {
  let n = 0;
  globalThis.fetch = (async (_u: string, init?: RequestInit) => {
    const p = plan(n++);
    const signal = init?.signal ?? undefined;
    const body = new ReadableStream<Uint8Array>({
      async start(c) {
        signal?.addEventListener('abort', () => c.error(signal.reason));
        for (const [ms, byte] of p.parts) {
          await new Promise((r) => setTimeout(r, ms));
          if (signal?.aborted) return;
          c.enqueue(new Uint8Array(4).fill(byte));
        }
        if (!p.stall) c.close();
      },
    });
    return new Response(body, { status: p.status ?? 206 });
  }) as typeof fetch;
  return () => n;
}

test('a connection that goes quiet is aborted and tried again', async () => {
  const tries = serve((n) => (n === 0 ? { parts: [[0, 1]], stall: true } : { parts: [[0, 2], [0, 3]] }));
  const t = performance.now();
  const b = await fetchBytes('http://h/x', 206, undefined, 100);
  assert.deepEqual([...(b ?? [])], [2, 2, 2, 2, 3, 3, 3, 3]);
  assert.equal(tries(), 2);
  assert.ok(performance.now() - t < 1000);
});

test('a slow server that keeps bringing bytes is waited for past the stall time', async () => {
  const tries = serve(() => ({ parts: Array.from({ length: 8 }, (_, i): [number, number] => [40, i]) }));
  const t = performance.now();
  const b = await fetchBytes('http://h/x', 206, undefined, 100);
  assert.equal(b?.length, 32);
  assert.equal(tries(), 1);
  assert.ok(performance.now() - t > 200, 'longer than the stall time in all');
});

test('every try stalled, or another status: no bytes (the guest gets an I/O error)', async () => {
  let tries = serve(() => ({ parts: [], stall: true }));
  assert.equal(await fetchBytes('http://h/x', 206, undefined, 50, 3), undefined);
  assert.equal(tries(), 3);
  tries = serve(() => ({ status: 404, parts: [[0, 1]] }));
  assert.equal(await fetchBytes('http://h/x', 206, undefined, 50), undefined);
  assert.equal(tries(), 1, 'a refusal is not tried again');
});
