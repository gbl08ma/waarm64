// The remote disk's blocks kept in OPFS (web/diskcache.ts), over memory files: blocks come back as kept, across a
// reopening; a full store reuses its slots in the order they were filled; a crash at any write leaves no block
// mapped to another block's bytes.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { blockStore } from '../web/diskcache.ts';
import { memFile, type SyncFile } from '../web/overlay.ts';

const BLOCK = 4096;
const SIZE = 20 * BLOCK + 100; // a short last block
const blockOf = (b: number) => Uint8Array.from({ length: Math.min(BLOCK, SIZE - b * BLOCK) }, (_, i) => (b * 31 + i * 7) & 0xff);
const sameBlock = (got: Uint8Array | undefined, b: number) => assert.ok(got && Buffer.compare(got, blockOf(b)) === 0, `block ${b}`);

test('blocks come back as kept, after a reopening too', () => {
  const [data, map] = [memFile(), memFile()];
  const s = blockStore(data, map, SIZE, BLOCK, 64);
  for (const b of [3, 0, 20, 7]) s.put(b, blockOf(b));
  for (const b of [3, 0, 20, 7]) sameBlock(s.get(b), b);
  assert.equal(s.get(5), undefined);
  s.put(5, new Uint8Array(10)); // a wrong length: not kept
  assert.equal(s.get(5), undefined);
  s.close();
  const again = blockStore(data, map, SIZE, BLOCK, 64);
  for (const b of [3, 0, 20, 7]) sameBlock(again.get(b), b);
  assert.equal(again.stats().held, 4);
});

test('a full store reuses its slots, oldest first, and a smaller budget drops what lies past it', () => {
  const [data, map] = [memFile(), memFile()];
  const s = blockStore(data, map, SIZE, BLOCK, 4);
  for (let b = 0; b < 6; b++) s.put(b, blockOf(b));
  assert.deepEqual([0, 1, 2, 3, 4, 5].map((b) => s.get(b) !== undefined), [false, false, true, true, true, true]);
  for (let b = 2; b < 6; b++) sameBlock(s.get(b), b);
  // Reopened with room for two: the blocks in slots 2 and 3 are dropped.
  const small = blockStore(data, map, SIZE, BLOCK, 2);
  assert.equal(small.stats().held, 2);
  for (let b = 0; b < 6; b++) { const got = small.get(b); if (got) sameBlock(got, b); }
});

test('a crash after any write leaves every mapped block with its own bytes', () => {
  // Every write and flush logged; a crash keeps what was flushed, plus any prefix of the unflushed writes.
  type Op = { file: 'data' | 'map'; at: number; bytes: Uint8Array } | { file: 'data' | 'map'; flush: true };
  const ops: Op[] = [];
  const logged = (name: 'data' | 'map', f: SyncFile): SyncFile => ({
    ...f,
    read: f.read.bind(f), getSize: f.getSize.bind(f), truncate: f.truncate.bind(f),
    write: (buf, o) => (ops.push({ file: name, at: o.at, bytes: buf.slice() }), f.write(buf, o)),
    flush: () => (ops.push({ file: name, flush: true }), f.flush()),
  });
  const s = blockStore(logged('data', memFile()), logged('map', memFile()), SIZE, BLOCK, 3);
  for (const b of [1, 4, 9, 4, 12, 15, 2, 1]) s.put(b, blockOf(b));
  for (let k = 0; k <= ops.length; k++) {
    // The state after the first k operations, every write landed (the worst case: a map entry with its data or not).
    const [data, map] = [memFile(), memFile()];
    for (const op of ops.slice(0, k)) if ('at' in op) (op.file === 'data' ? data : map).write(op.bytes, { at: op.at });
    const r = blockStore(data, map, SIZE, BLOCK, 3);
    for (let b = 0; b <= 20; b++) { const got = r.get(b); if (got) sameBlock(got, b); }
  }
});

test('a short write (the storage full) gives up: nothing kept, its space given back; releaseStores empties the open ones', async () => {
  const { releaseStores } = await import('../web/diskcache.ts');
  // A data file that takes 3 blocks, then answers short, as Chromium's sync handles do at the quota.
  const full = memFile();
  let room = 3 * BLOCK;
  const data: SyncFile = { ...full, read: full.read.bind(full), getSize: full.getSize.bind(full), truncate: full.truncate.bind(full), flush: full.flush.bind(full),
    write: (buf, o) => { if (buf.length > room) return 0xfffffff8; room -= buf.length; return full.write(buf, o); } };
  const map = memFile();
  const s = blockStore(data, map, SIZE, BLOCK, 64);
  for (const b of [0, 1, 2]) s.put(b, blockOf(b));
  sameBlock(s.get(1), 1);
  s.put(3, blockOf(3)); // no room
  assert.deepEqual([s.get(1), s.get(3), s.stats().gaveUp, full.getSize(), map.getSize()], [undefined, undefined, true, 0, 0]);
  s.put(4, blockOf(4)); // a store that gave up keeps nothing more
  assert.equal(s.get(4), undefined);
  s.close();
  // Two open stores: releasing them frees what one holds; again, nothing is left to free.
  const [a, b] = [blockStore(memFile(), memFile(), SIZE, BLOCK, 8), blockStore(memFile(), memFile(), SIZE, BLOCK, 8)];
  a.put(5, blockOf(5));
  assert.equal(releaseStores(), true);
  assert.deepEqual([a.get(5), a.stats().gaveUp, b.stats().gaveUp], [undefined, true, true]);
  assert.equal(releaseStores(), false);
  a.close();
  b.close();
});

// In Chromium, on OPFS (a worker's sync access handles): kept across an opening, one opener at a time, and Clear
// empties an image a machine reads too (it gives its store up).
test('on OPFS: kept across an opening, one opener at a time, Clear empties the open one too', async () => {
  const { chromium } = await import('playwright-core');
  const { startServer } = await import('../tools/serve.ts');
  const server = await startServer();
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium' });
  try {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${(server.address() as { port: number }).port}/tests/browser/core.html`);
    const r = await page.evaluate(async () => {
      const src = `
        import { openBlockStore, clearCaches, cacheBytes, cacheKey } from '${location.origin}/web/diskcache.ts';
        const B = 65536, SIZE = 10 * B;
        const block = (b) => Uint8Array.from({ length: B }, (_, i) => (b + i) & 255);
        const key = await cacheKey('an image'), other = await cacheKey('another');
        const a = await openBlockStore(key, SIZE, B);
        a.put(2, block(2)); a.put(7, block(7));
        const second = await openBlockStore(key, SIZE, B); // held by a: none (after 2 s)
        a.close();
        const b = await openBlockStore(key, SIZE, B);
        const back = [2, 7, 3].map((k) => { const x = b.get(k); return x ? x[5] === ((k + 5) & 255) : null; });
        const o = await openBlockStore(other, SIZE, B);
        o.put(0, block(0)); o.close();
        await new Promise((r) => setTimeout(r, 50));
        const before = await cacheBytes();
        await clearCaches(); // the other image's goes; b, open, gives its space back
        const after = await cacheBytes();
        b.close();
        postMessage({ second: second === undefined, back, before, after, held: b.stats().held, active: b.active() });`;
      const w = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })), { type: 'module' });
      return await new Promise((resolve, reject) => { w.onmessage = (e) => resolve(e.data); w.onerror = (e) => reject(new Error(e.message)); });
    }) as { second: boolean; back: (boolean | null)[]; before: number; after: number; held: number; active: boolean };
    assert.deepEqual([r.second, r.back, r.held, r.active], [true, [true, true, null], 0, false]);
    assert.ok(r.before >= 3 * 65536 && r.after === 0, `${r.before} → ${r.after}`);
  } finally {
    await browser.close();
    server.close();
  }
});
