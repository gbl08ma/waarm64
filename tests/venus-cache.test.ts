// The shader store across runs (web/venus-cache.ts, VK3 L3): a run finds what an earlier one stored, a renderer build
// finds nothing of another's (and drops it), the budget keeps the most recently used. On a memory backend; IndexedDB's
// is the page's (tests/page-venus.test.ts), and the renderer's use of it tests/venus-driver.test.ts's.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { memoryBackend, ShaderCache } from '../web/venus-cache.ts';

const bytes = (n: number, v = 1) => new Uint8Array(n).fill(v);

test('a later run finds what an earlier one stored; a miss is a miss', async () => {
  const backend = memoryBackend();
  const a = await ShaderCache.open('build1', { backend });
  assert.equal(a.get('k1'), undefined);
  a.put('k1', bytes(100, 7));
  assert.equal(a.get('k1')?.[0], 7, 'in this run');
  await a.flush();
  const b = await ShaderCache.open('build1', { backend });
  assert.equal(b.get('k1')?.length, 100);
  assert.equal(b.get('k2'), undefined);
  assert.deepEqual([b.stats.hits, b.stats.misses], [1, 1]);
});

test('the store copies what it is given (the renderer reuses its memory)', async () => {
  const c = await ShaderCache.open('build1', { backend: memoryBackend() });
  const src = bytes(8, 3);
  c.put('k', src);
  src.fill(0);
  assert.equal(c.get('k')?.[0], 3);
});

test("another renderer build finds nothing, and the old build's entries are dropped from storage", async () => {
  const backend = memoryBackend();
  const a = await ShaderCache.open('build1', { backend });
  a.put('k1', bytes(10));
  await a.flush();
  const b = await ShaderCache.open('build2', { backend });
  assert.equal(b.get('k1'), undefined);
  assert.equal(b.stats.dropped, 1);
  await b.flush();
  assert.equal(backend.entries.size, 0);
});

test('the budget keeps the most recently used, across runs too', async () => {
  const backend = memoryBackend();
  const a = await ShaderCache.open('b', { backend, budget: 1000 });
  a.put('k1', bytes(200));
  a.put('k2', bytes(200));
  a.put('k3', bytes(200));
  a.get('k1');                       // k2 is now the least recently used
  a.put('k4', bytes(200));
  a.put('k5', bytes(200));           // 1,000 bytes: all fit
  a.put('k6', bytes(200));           // over: k2 goes
  assert.equal(a.get('k2'), undefined);
  assert.ok(a.get('k1') && a.get('k3'));
  assert.equal(a.stats.bytes, 1000);
  assert.equal(a.stats.evicted, 1);
  await a.flush();
  assert.equal(backend.entries.size, 5);
  // A smaller budget at the next load keeps the newest uses (k3 and k1 were used last, then k6).
  const b = await ShaderCache.open('b', { backend, budget: 600 });
  assert.equal(b.stats.entries, 3);
  assert.ok(b.get('k3') && b.get('k1') && b.get('k6'));
  assert.equal(b.get('k4'), undefined);
  // An entry larger than a quarter of the budget isn't kept.
  b.put('big', bytes(200));
  assert.equal(b.get('big'), undefined);
});

test('a backend that fails to load leaves an empty store, not an error', async () => {
  const c = await ShaderCache.open('b', { backend: { load: () => Promise.reject(new Error('no IndexedDB')), save: () => Promise.resolve() } });
  assert.equal(c.get('k'), undefined);
  c.put('k', bytes(4));
  assert.ok(c.get('k'));
});
