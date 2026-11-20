// The remote disk's block cache (web/blockcache.ts): the bytes of any read match the source's, and the requests are
// what the cache promises (one per run of missing blocks, none for blocks held).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cachedSource } from '../web/blockcache.ts';
import type { Source } from '../web/disk-sources.ts';

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

test("prefetch: the list fetched ahead in the background, within its window, the guest's reads first", async () => {
  const BIG = 64 * 4096;
  const bytes = Uint8Array.from({ length: BIG }, (_, i) => (i * 13 + 5) & 0xff);
  const fetches: { off: number; len: number; at: number }[] = [];
  let inFlight = 0, most = 0;
  const src = { size: BIG, read: (off: number, len: number) => bytes.slice(off, off + len), readAsync: async (off: number, len: number) => {
    fetches.push({ off, len, at: inFlight });
    most = Math.max(most, ++inFlight);
    await new Promise((r) => setTimeout(r, 2));
    inFlight--;
    return bytes.slice(off, off + len);
  } };
  const c = cachedSource(src, { block: 4096, bytes: 16 * 4096 }); // no store: a window of 8 blocks
  const list = [0, 1, 2, 3, 10, 11, 12, 40, 41, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 50, 51, 52, 53];
  const running = c.prefetch(list);
  await new Promise((r) => setTimeout(r, 30));
  // The guest has read nothing: the prefetch stops a window (8 entries) and a run past the start.
  const early = fetches.reduce((n, f) => n + f.len / 4096, 0);
  assert.ok(early >= 8 && early <= 16, `${early} blocks before the guest read`);
  // The guest reads the list in order: each read's bytes right, most found already fetched.
  for (const b of list) {
    const got = await c.readAsync!(b * 4096 + 100, 200);
    assert.ok(got && Buffer.compare(got, bytes.subarray(b * 4096 + 100, b * 4096 + 300)) === 0, `block ${b}`);
  }
  await running;
  const p = c.stats.prefetch!;
  assert.equal(p.done, true);
  assert.ok(p.used >= list.length / 2, `${p.used} of ${list.length} prefetched blocks used`);
  assert.ok(most <= 8, `${most} fetches at once`);
  c.close?.();
});

test('prefetch: over a large store it runs a window ahead, not the whole list; it widens only when it held the guest back', async () => {
  const { AHEAD_START, AHEAD_STEP, AHEAD_MAX } = await import('../web/blockcache.ts');
  const { blockStore } = await import('../web/diskcache.ts');
  const { memFile } = await import('../web/overlay.ts');
  const N = 1024, B = 4096;
  const bytes = Uint8Array.from({ length: N * B }, (_, i) => (i * 7 + 3) & 0xff);
  const make = (ms: number) => {
    let blocks = 0;
    const src = { size: N * B, read: (off: number, len: number) => bytes.slice(off, off + len), readAsync: async (off: number, len: number) => {
      blocks += len / B;
      await new Promise((r) => setTimeout(r, ms));
      return bytes.slice(off, off + len);
    } };
    const c = cachedSource(src, { block: B, bytes: 16 * B }, blockStore(memFile(), memFile(), N * B, B, N));
    return { c, fetched: () => blocks };
  };
  const list = Array.from({ length: N }, (_, i) => i);
  const settle = () => new Promise((r) => setTimeout(r, 60));
  // The guest reads nothing (a boot menu): a window and a run past it, of 1024 the store could hold.
  {
    const { c, fetched } = make(1);
    void c.prefetch(list);
    await settle();
    assert.ok(fetched() >= AHEAD_START && fetched() <= AHEAD_START + 8, `${fetched()} blocks fetched with the guest idle`);
    assert.deepEqual([c.stats.prefetch!.window, c.stats.prefetch!.widened], [AHEAD_START, 0]);
    c.close?.();
  }
  // The guest's first read comes at once: late, but the prefetch never sat on its window, so it doesn't widen.
  {
    const { c } = make(5);
    void c.prefetch(list);
    await c.readAsync!(0, 100);
    assert.ok(c.stats.prefetch!.late >= 1);
    assert.equal(c.stats.prefetch!.widened, 0);
    c.close?.();
  }
  // The prefetch idles on its window, then the guest reads faster than it fetches: it widens, step by step, to the
  // ceiling at most; every read's bytes right.
  {
    const { c, fetched } = make(3);
    void c.prefetch(list);
    await settle();
    for (let b = 0; b < 400; b++) {
      const got = await c.readAsync!(b * B + 10, 20);
      assert.ok(got && Buffer.compare(got, bytes.subarray(b * B + 10, b * B + 30)) === 0, `block ${b}`);
    }
    const p = c.stats.prefetch!;
    assert.ok(p.widened > 0, 'widened');
    assert.equal(p.window, Math.min(AHEAD_MAX, AHEAD_START + p.widened * AHEAD_STEP));
    assert.ok(p.window <= AHEAD_MAX);
    await settle();
    assert.ok(fetched() <= 400 + p.window + 8, `${fetched()} blocks fetched, the guest at 400, a window of ${p.window}`);
    c.close?.();
  }
});

test('prefetch: concurrent reads out of the list\'s order all complete while it runs (no read waits on a fetch that never starts)', async () => {
  const BIG = 256 * 4096;
  const bytes = Uint8Array.from({ length: BIG }, (_, i) => (i * 7 + 1) & 0xff);
  let seed = 21;
  const rnd = (n: number) => ((seed = (seed * 1103515245 + 12345) >>> 0) % n);
  const src = { size: BIG, read: (off: number, len: number) => bytes.slice(off, off + len), readAsync: async (off: number, len: number) => {
    await new Promise((r) => setTimeout(r, rnd(3)));
    return bytes.slice(off, off + len);
  } };
  for (let round = 0; round < 5; round++) {
    const c = cachedSource(src, { block: 4096, bytes: 16 * 4096 });
    const list = Array.from({ length: 200 }, () => rnd(256));
    void c.prefetch(list);
    const reads = Array.from({ length: 120 }, async (_, i) => {
      await new Promise((r) => setTimeout(r, rnd(20)));
      const b = list[Math.min(list.length - 1, i + rnd(30))];
      const got = await c.readAsync!(b * 4096, Math.min(BIG - b * 4096, 4096 * (1 + rnd(3))));
      assert.ok(got && Buffer.compare(got, bytes.subarray(b * 4096, b * 4096 + got.length)) === 0, `block ${b}`);
    });
    const deadline = new Promise((_, no) => setTimeout(() => no(new Error(`round ${round}: reads still waiting after 5 s`)), 5000));
    await Promise.race([Promise.all(reads), deadline]);
    c.close?.();
  }
});

test('a synchronous read of a block the prefetch is fetching fetches it itself (the image\'s opening can\'t wait)', async () => {
  const BIG = 32 * 4096;
  const bytes = Uint8Array.from({ length: BIG }, (_, i) => (i * 3) & 0xff);
  const src = { size: BIG, read: (off: number, len: number) => bytes.slice(off, off + len), readAsync: async (off: number, len: number) => {
    await new Promise((r) => setTimeout(r, 20));
    return bytes.slice(off, off + len);
  } };
  const c = cachedSource(src, { block: 4096, bytes: 16 * 4096 });
  void c.prefetch([0, 1, 2, 3]);
  const got = c.read(4096 + 10, 100); // block 1: the prefetch's, still in flight
  assert.ok(got && Buffer.compare(got, bytes.subarray(4096 + 10, 4096 + 110)) === 0);
  c.close?.();
});

test("a block kept from a run doesn't keep the run's buffer: what the cache holds is its budget", async () => {
  // A run of 8 blocks fetched in one read, then 7 of them pushed out while the first stays: the run's buffer must go.
  const { setFlagsFromString } = await import('node:v8');
  const { runInNewContext } = await import('node:vm');
  setFlagsFromString('--expose-gc');
  const gc = runInNewContext('gc') as () => void;
  const image = new Uint8Array(32 * 4096).map((_, i) => i >> 12);
  let run: WeakRef<ArrayBuffer> | undefined;
  const src: Source = {
    size: image.length,
    read: (off, len) => {
      const b = image.slice(off, off + len);
      if (len === 8 * 4096) run = new WeakRef(b.buffer);
      return b;
    },
  };
  const c = cachedSource(src, { block: 4096, bytes: 8 * 4096 });
  assert.equal(c.read(0, 8 * 4096)?.[5 * 4096], 5, 'the run');
  assert.equal(c.read(0, 10)?.[0], 0, 'its first block, held');
  for (let b = 8; b < 15; b++) assert.equal(c.read(b * 4096, 10)?.[0], b, `block ${b}, one at a time`);
  await new Promise((r) => setImmediate(r));
  gc();
  assert.ok(run, 'one read of the run');
  assert.equal(run.deref(), undefined, "the run's buffer is gone");
  assert.equal(c.read(0, 10)?.[0], 0, 'block 0 still held');
});
