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
