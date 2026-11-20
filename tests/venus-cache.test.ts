// The shader store across runs (web/venus-cache.ts, VK3 L3): a run finds what an earlier one stored, a renderer build
// finds nothing of another's (and drops it), the budget keeps the most recently used. On a memory backend; IndexedDB's
// is the page's (tests/page-venus.test.ts), and the renderer's use of it tests/venus-driver.test.ts's.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { memoryBackend, ShaderCache } from '../web/venus-cache.ts';

const bytes = (n: number, v = 1) => new Uint8Array(n).fill(v);
/** Bytes that don't deflate: stored as they are (VK4 T17). */
const random = (n: number) => crypto.getRandomValues(new Uint8Array(n));

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
  // Bytes that don't deflate: stored as they are, so what's stored is what's held.
  const backend = memoryBackend();
  const a = await ShaderCache.open('b', { backend, budget: 1000 });
  a.put('k1', random(200));
  a.put('k2', random(200));
  a.put('k3', random(200));
  a.get('k1');                       // k2 is now the least recently used
  a.put('k4', random(200));
  a.put('k5', random(200));           // 1,000 bytes: all fit
  a.put('k6', random(200));           // over: k2 goes
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
  b.put('big', random(200));
  assert.equal(b.get('big'), undefined);
});

test('a backend that fails to load leaves an empty store, not an error', async () => {
  const c = await ShaderCache.open('b', { backend: { load: () => Promise.reject(new Error('no IndexedDB')), save: () => Promise.resolve() } });
  assert.equal(c.get('k'), undefined);
  c.put('k', bytes(4));
  assert.ok(c.get('k'));
});

test('entries are stored deflated and come back whole; the budget counts what is stored (VK4 T17)', async () => {
  const backend = memoryBackend();
  const a = await ShaderCache.open('b', { backend, budget: 10_000 });
  // Text-like entries (a stage's WGSL) shrink; random ones are stored as they are.
  const text = new TextEncoder().encode('fn main() { let x = textureSample(t, s, uv); }\n'.repeat(40));
  a.put('text', text);
  a.put('noise', random(500));
  assert.equal(a.stats.bytes, text.length + 500, 'before the flush: what is held');
  await a.flush();
  const stored = backend.entries.get('text')!;
  assert.ok(stored.packed && stored.bytes.length < text.length / 4, `deflated to ${stored.bytes.length} of ${text.length}`);
  assert.equal(backend.entries.get('noise')!.packed, false);
  assert.equal(backend.entries.get('noise')!.bytes.length, 500);
  assert.equal(a.stats.bytes, stored.bytes.length + 500, 'after it: what is stored');
  assert.equal(a.stats.held, stored.bytes.length + 500, 'and what is held (T49 follow-up)');
  assert.equal(Buffer.compare(a.get('text')!, text), 0, 'inflated at the lookup in this run');
  // A later run holds them as stored; the budget at its load counts the stored bytes (the text alone is larger than it).
  const b = await ShaderCache.open('b', { backend, budget: 1000 });
  assert.equal(b.stats.held, stored.bytes.length + 500);
  assert.equal(Buffer.compare(b.get('text')!, text), 0, 'the text came back otherwise');
  assert.equal(Buffer.compare(b.get('text')!, text), 0, 'and again (a lookup inflates a copy)');
  assert.equal(b.get('noise')!.length, 500);
  assert.equal(b.stats.dropped, 0);
});

test('the store round-trips held deflated: many entries, each inflated whole at each lookup, across runs (VK4 T49 follow-up)', async () => {
  const backend = memoryBackend();
  const a = await ShaderCache.open('b', { backend });
  // WGSL-like entries of sizes from a few bytes to ~200 KB, some of which don't deflate.
  const entries = new Map<string, Uint8Array>();
  for (let i = 0; i < 40; i++) {
    const line = `let t${i} = bitcast<f32>(u.m[${i}].x) * ${i}.5; // ${'x'.repeat(i)}\n`;
    const text = new TextEncoder().encode(line.repeat(1 + i * i * 4));
    entries.set(`k${i}`, i % 7 === 3 ? random(100 + i * 50) : text);
  }
  for (const [k, v] of entries) a.put(k, v);
  await a.flush();
  const raw = [...entries.values()].reduce((n, v) => n + v.length, 0);
  assert.ok(a.stats.held < raw / 4, `held ${a.stats.held} of ${raw}`);
  assert.equal(a.stats.held, a.stats.bytes);
  for (const [k, v] of entries) assert.equal(Buffer.compare(a.get(k)!, v), 0, `${k} in this run`);
  // A later run: the same; an entry stored without its size (before T49's follow-up) inflates too.
  delete backend.entries.get('k20')!.size;
  const b = await ShaderCache.open('b', { backend });
  assert.equal(b.stats.held, a.stats.held);
  for (const [k, v] of entries) assert.equal(Buffer.compare(b.get(k)!, v), 0, `${k} in the next run`);
  assert.equal(Buffer.compare(b.get('k20')!, entries.get('k20')!), 0, 'k20 again, its size learned');
  assert.ok(b.stats.inflateMs > 0);
  assert.deepEqual([b.stats.hits, b.stats.misses, b.stats.dropped], [41, 0, 0]);
});

test('a stored entry that fails to inflate is dropped at its lookup, not an error', async () => {
  const backend = memoryBackend();
  backend.entries.set('bad', { key: 'bad', version: 'b', bytes: new Uint8Array([0xff, 0xff, 0xff]), used: 1, packed: true });
  const c = await ShaderCache.open('b', { backend });
  assert.equal(c.get('bad'), undefined);
  assert.equal(c.stats.dropped, 1);
  assert.equal(c.stats.held, 0);
  assert.equal(c.get('bad'), undefined, 'and gone');
  await c.flush();
  assert.equal(backend.entries.size, 0, 'from storage too');
});

test("a hit on an entry already written back in this run isn't written again (its bytes would go with its use time)", async () => {
  const backend = memoryBackend();
  let puts = 0;
  const counting = { load: backend.load, save: (put: Parameters<typeof backend.save>[0], remove: string[]) => ((puts += put.length), backend.save(put, remove)) };
  const a = await ShaderCache.open('b', { backend: counting });
  a.put('k1', bytes(100));
  await a.flush();
  assert.equal(puts, 1);
  for (let k = 0; k < 5; k++) assert.ok(a.get('k1'));
  await a.flush();
  assert.equal(puts, 1, 'no write for the hits');
  // A later run's first hit is written back (its use time), once.
  const b = await ShaderCache.open('b', { backend: counting });
  assert.ok(b.get('k1') && b.get('k1'));
  await b.flush();
  b.get('k1');
  await b.flush();
  assert.equal(puts, 2);
});
