// The remote disk's block cache (web/blockcache.ts): the bytes of any read match the source's, and the requests are
// what the cache promises (one per run of missing blocks, none for blocks held).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cachedSource } from '../web/blockcache.ts';
import type { Source } from '../web/devices.ts';

const SIZE = 10 * 4096 + 1234; // a partial last block
const bytes = Uint8Array.from({ length: SIZE }, (_, i) => (i * 2654435761) >>> 24);
const source = () => {
  const reads: [number, number][] = [];
  const src: Source = { size: SIZE, read: (off, len) => (reads.push([off, len]), off + len <= SIZE ? bytes.slice(off, off + len) : undefined) };
  return { src, reads };
};
const same = (a: Uint8Array | undefined, off: number, len: number, what: string) =>
  assert.ok(a && Buffer.compare(a, bytes.subarray(off, off + len)) === 0, `${what}: ${off}+${len} differs`);

test('reads match the source, the cache full or not', () => {
  for (const cacheBlocks of [1, 3, 64]) {
    const { src } = source();
    const c = cachedSource(src, { block: 4096, bytes: cacheBlocks * 4096 });
    let seed = 7;
    const rnd = (n: number) => ((seed = (seed * 1103515245 + 12345) >>> 0) % n);
    for (let i = 0; i < 2000; i++) {
      const off = rnd(SIZE);
      const len = Math.min(SIZE - off, rnd(3 * 4096) + 1);
      same(c.read(off, len), off, len, `cache of ${cacheBlocks}`);
    }
    assert.equal(c.read(SIZE - 10, 20), undefined);
    assert.equal(c.read(0, 0)?.length, 0);
  }
});

test('one request per run of missing blocks, none for blocks held', () => {
  const { src, reads } = source();
  const c = cachedSource(src, { block: 4096, bytes: 64 * 4096 });
  same(c.read(100, 10), 100, 10, 'first');
  assert.deepEqual(reads, [[0, 4096]]);
  same(c.read(4096 * 2 + 5, 4096 * 2), 4096 * 2 + 5, 4096 * 2, 'two blocks after a gap');
  assert.deepEqual(reads.at(-1), [8192, 3 * 4096]); // blocks 2..4 in one request
  same(c.read(0, 5 * 4096), 0, 5 * 4096, 'blocks 0..4');
  assert.deepEqual(reads.at(-1), [4096, 4096]); // only block 1 was missing
  const n = reads.length;
  same(c.read(10, 4 * 4096), 10, 4 * 4096, 'held');
  assert.equal(reads.length, n);
  same(c.read(SIZE - 100, 100), SIZE - 100, 100, 'the partial last block');
  assert.deepEqual(reads.at(-1), [10 * 4096, 1234]);
  assert.deepEqual(c.stats.requests, reads.length);
});

test('a read larger than the cache goes past it', () => {
  const { src, reads } = source();
  const c = cachedSource(src, { block: 4096, bytes: 2 * 4096 });
  same(c.read(0, 3 * 4096), 0, 3 * 4096, 'three blocks');
  assert.deepEqual(reads, [[0, 3 * 4096]]);
});

test('over a store (web/diskcache.ts), a second cache reads what the first fetched without a request', async () => {
  const { blockStore } = await import('../web/diskcache.ts');
  const { memFile } = await import('../web/overlay.ts');
  const [data, map] = [memFile(), memFile()];
  const first = source();
  const a = cachedSource(first.src, { block: 4096, bytes: 8 * 4096 }, blockStore(data, map, SIZE, 4096, 64));
  same(a.read(5000, 3 * 4096), 5000, 3 * 4096, 'fetched');
  same(a.read(SIZE - 50, 50), SIZE - 50, 50, 'the last block');
  a.close?.();
  const second = source();
  const b = cachedSource(second.src, { block: 4096, bytes: 8 * 4096 }, blockStore(data, map, SIZE, 4096, 64));
  same(b.read(5000, 3 * 4096), 5000, 3 * 4096, 'kept');
  same(b.read(SIZE - 50, 50), SIZE - 50, 50, 'the last block, kept');
  assert.deepEqual([second.reads.length, b.stats.store?.hits], [0, 5]);
  same(b.read(0, 100), 0, 100, 'not kept');
  assert.deepEqual(second.reads, [[0, 4096]]);
});

test('readAsync: concurrent reads match the source, and a block being fetched is fetched once', async () => {
  const { src, reads } = source();
  let seed = 9;
  const rnd = (n: number) => ((seed = (seed * 1103515245 + 12345) >>> 0) % n);
  let inFlight = 0, most = 0;
  const asyncSrc = { ...src, readAsync: async (off: number, len: number) => {
    inFlight++;
    most = Math.max(most, inFlight);
    await new Promise((r) => setTimeout(r, rnd(4)));
    inFlight--;
    return src.read(off, len);
  } };
  const c = cachedSource(asyncSrc, { block: 4096, bytes: 64 * 4096 });
  await Promise.all(Array.from({ length: 200 }, () => {
    const off = rnd(SIZE);
    const len = Math.min(SIZE - off, rnd(3 * 4096) + 1);
    return c.readAsync!(off, len).then((got) => same(got, off, len, 'async'));
  }));
  // Every block once (the cache holds them all), in requests that overlap none.
  const fetched = reads.flatMap(([off, len]) => Array.from({ length: Math.ceil(len / 4096) }, (_, k) => off / 4096 + k));
  assert.equal(new Set(fetched).size, fetched.length, 'a block fetched twice');
  assert.ok(most > 1 && most <= 8, `${most} at once`);
  // A small cache: blocks evicted while a read waits are fetched again, and the bytes still match.
  const small = cachedSource(asyncSrc, { block: 4096, bytes: 3 * 4096 });
  await Promise.all(Array.from({ length: 100 }, () => {
    const off = rnd(SIZE);
    const len = Math.min(SIZE - off, rnd(2 * 4096) + 1);
    return small.readAsync!(off, len).then((got) => same(got, off, len, 'async, small'));
  }));
});
