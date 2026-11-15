// The disk surface's data (web/surface.ts, docs/plans/surface.md): a map's counts per cell after writes, zeroings and
// discards; layers of different sizes; cells of several sizes and a short last one; a range's blocks and runs; the
// ramdisk's chunks; blk's `inspect` with its activity wrapper, which comes with a query and goes once none asks
// (the request put back as it was); the incremental counts against a whole walk; `Devices.inspect`; the job worker's
// answers from files (web/app/surface-job.ts); the time of a whole walk over 25,600 leaves; and live, end to end: a
// disk under a grown overlay (the disk's own size), a stored disk written in place, the realtime wrappers under the
// activity wrapper.
import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { blk, Devices, zeroSource, type Ctx, type DeviceSpec } from '../web/devices.ts';
import { blkSpec } from '../web/app/worker-devices.ts';
import { lockOverlay, memFile, openOverlay, overlay, readMeta, writeMeta, writeOwnSize } from '../web/overlay.ts';
import { openDisk } from '../web/qcow2.ts';
import { ramDisk } from '../web/ramdisk.ts';
import { blockSource, zeroDisk } from '../web/stored.ts';
import { surfaceJob } from '../web/app/surface-job.ts';
import { asInPlace } from '../web/app/surface-source.ts';
import { IoStats } from '../web/iostats.ts';
import { cellBytesFor, cellCount, countRange, diskInspector, opaqueLayer, ramLayer, rangeCounts, rangeDetail, summarize, surfaceOf, type InspectAnswer, type Leaves, type Surface } from '../web/surface.ts';
import { splitmix64 } from '../tools/corpus/corpus.ts';

const BLOCK = 4096;
const LEAF = 1024;
const RANGE = LEAF * BLOCK;
const MiB = 1 << 20;

const surfaceOfAnswer = (a: InspectAnswer): Surface => {
  assert.equal(a.kind, 'disk-surface');
  return (a as Extract<InspectAnswer, { kind: 'disk-surface' }>).surface;
};
const layer = (s: Surface, id: string) => s.layers.find((l) => l.id === id)!;

test('cell sizes: 4 MiB times the smallest power of two that fits, capped', () => {
  assert.equal(cellBytesFor(10 * RANGE, 100), RANGE);
  assert.equal(cellBytesFor(10 * RANGE, 10), RANGE);
  assert.equal(cellBytesFor(10 * RANGE, 9), 2 * RANGE);
  assert.equal(cellBytesFor(10 * RANGE, 3), 4 * RANGE);
  assert.equal(cellBytesFor(10 * RANGE + 1, 10), 2 * RANGE, 'a byte past ten ranges is an eleventh');
  assert.equal(cellBytesFor(1, 0), RANGE, 'at least one cell');
  assert.equal(cellBytesFor(2 ** 41, 1e9), 8 * RANGE, '2 TiB in at most 65,536 cells');
  assert.equal(cellCount(5 * RANGE + MiB, 2 * RANGE), 3);
});

test('counts after writes, zeroings and discards, per cell at several sizes, the last cell short', async () => {
  const size = 5 * RANGE + MiB; // five ranges and a quarter of a sixth
  const base = openDisk((off, len) => new Uint8Array(len).fill(7), size);
  const [data, map] = [memFile(), memFile()];
  const o = overlay(base, data, map);
  assert.ok(await o.write(0, new Uint8Array(4 * BLOCK).fill(1))); // range 0: blocks 0-3
  assert.ok(await o.write(RANGE + 100 * BLOCK, new Uint8Array(BLOCK + 512).fill(2))); // range 1: blocks 100, 101 (part)
  assert.ok(await o.zero(2 * RANGE, RANGE)); // range 2: all zeros, no slots
  assert.ok(o.discard(BLOCK, 2 * BLOCK)); // range 0: blocks 1, 2 discarded
  assert.ok(await o.write(5 * RANGE, new Uint8Array(BLOCK).fill(3))); // the short range
  const at = (cellBytes: number) => summarize(o.leaves!(), 'overlay', size, cellBytes);
  const one = at(RANGE);
  assert.deepEqual([...one.held], [2, 2, 0, 0, 0, 1]);
  assert.deepEqual([...one.zero], [2, 0, LEAF, 0, 0, 0]);
  const two = at(2 * RANGE);
  assert.deepEqual([...two.held], [4, 0, 1]);
  assert.deepEqual([...two.zero], [2, LEAF, 0]);
  const all = at(8 * RANGE);
  assert.deepEqual([...all.held, ...all.zero], [5, LEAF + 2]);
  // The same from the map file (a stored disk's reader), and an image's opaque layer's last cell is short.
  const stored = blockSource(data, map, size);
  assert.deepEqual([...summarize(stored.leaves!(), 'disk', size, 2 * RANGE).held], [4, 0, 1]);
  assert.deepEqual([...opaqueLayer('disk', size, 2 * RANGE).held], [2 * LEAF, 2 * LEAF, LEAF + MiB / BLOCK]);
});

test('layers of different sizes: the surface spans the largest, zeros past a layer\'s end', async () => {
  // An overlay grown past its base (docs/machines.md §4.5): it writes past the base's end.
  const baseSize = 3 * RANGE;
  const big = 7 * RANGE + 8 * BLOCK;
  const o = overlay(zeroDisk(baseSize), memFile(), memFile(), undefined, big);
  assert.equal(o.size, big);
  assert.ok(await o.write(6 * RANGE, new Uint8Array(2 * BLOCK).fill(1)));
  assert.ok(await o.write(7 * RANGE, new Uint8Array(BLOCK).fill(1)));
  const cellBytes = cellBytesFor(big, 4); // 8 ranges in 4 cells: two a cell, the last one short
  const s = surfaceOf(cellBytes, [opaqueLayer('disk', baseSize, cellBytes), summarize(o.leaves!(), 'overlay', big, cellBytes)]);
  assert.equal(s.size, big);
  assert.equal(s.unitBytes, BLOCK);
  assert.deepEqual([...layer(s, 'disk').held], [2 * LEAF, LEAF, 0, 0], 'the disk ends inside the second cell');
  assert.equal(layer(s, 'disk').size, baseSize);
  assert.deepEqual([...layer(s, 'overlay').held], [0, 0, 0, 3]);
  // An overlay smaller than the disk (a disk that grew, read offline): its arrays are widened with zeros.
  const small = summarize(o.leaves!(), 'overlay', 2 * RANGE, RANGE);
  const t = surfaceOf(RANGE, [opaqueLayer('disk', 5 * RANGE, RANGE), small]);
  assert.deepEqual([t.size, layer(t, 'overlay').held.length, layer(t, 'overlay').zero.length], [5 * RANGE, 5, 5]);
  assert.deepEqual([...layer(t, 'overlay').held], [0, 0, 0, 0, 0]);
});

test('a range block by block: whose each block is, and the runs of slots', async () => {
  const size = 2 * RANGE + 10 * BLOCK; // range 2 ends after 10 blocks
  // The disk: a stored block store with blocks 0-9 and 500 of range 0.
  const [sd, sm] = [memFile(), memFile()];
  const store = overlay(zeroDisk(size), sd, sm);
  assert.ok(await store.write(0, new Uint8Array(10 * BLOCK).fill(5)));
  assert.ok(await store.write(500 * BLOCK, new Uint8Array(BLOCK).fill(5)));
  const disk = blockSource(sd, sm, size);
  // The overlay: blocks 2-3 (one run), 600 then 599 (slots in the other order: two runs), 700 zeroed.
  const o = overlay(zeroDisk(size), memFile(), memFile());
  assert.ok(await o.write(2 * BLOCK, new Uint8Array(2 * BLOCK).fill(1)));
  assert.ok(await o.write(600 * BLOCK, new Uint8Array(BLOCK).fill(1)));
  assert.ok(await o.write(599 * BLOCK, new Uint8Array(BLOCK).fill(1)));
  assert.ok(await o.zero(700 * BLOCK, BLOCK));
  const d = rangeDetail(0, size, { kind: 'map', id: 'disk', size, leaves: disk.leaves!() }, { kind: 'map', id: 'overlay', size, leaves: o.leaves!() });
  const states = (bs: number[]) => bs.map((b) => d.blocks[b]);
  assert.deepEqual(states([0, 1, 2, 3, 4, 9, 10, 500, 599, 600, 700, 701]), [1, 1, 2, 2, 1, 1, 0, 1, 2, 2, 3, 0]);
  assert.deepEqual(d.runs, { disk: 2, overlay: 3 });
  const end = rangeDetail(2, size, { kind: 'blank', id: 'disk', size });
  assert.deepEqual([end.blocks[9], end.blocks[10], end.blocks[1023]], [0, 4, 4], 'past the end');
  assert.deepEqual(end.runs, {});
  const img = rangeDetail(1, size, { kind: 'opaque', id: 'disk', size: RANGE + 3 * BLOCK });
  assert.deepEqual([img.blocks[0], img.blocks[2], img.blocks[3]], [5, 5, 0], 'an image\'s blocks are the disk\'s, not examined, up to its end');
});

test('a ramdisk: its chunks in memory', async () => {
  const size = 9 * MiB;
  const r = ramDisk(size);
  assert.ok(await r.write(0, new Uint8Array(512).fill(1)));
  assert.ok(await r.write(5 * MiB + 4096, new Uint8Array(4096).fill(1)));
  assert.ok(await r.write(8 * MiB, new Uint8Array(4096).fill(1)));
  const l = ramLayer('disk', size, r.chunkKeys(), RANGE);
  assert.deepEqual([...l.held], [256, 256, 256], 'a chunk is 256 blocks');
  assert.deepEqual([...ramLayer('disk', size, r.chunkKeys(), 2 * RANGE).held], [512, 256]);
  const d = rangeDetail(1, size, { kind: 'ram', id: 'disk', size, chunks: r.chunkKeys() });
  assert.deepEqual([d.blocks[0], d.blocks[255], d.blocks[256], d.blocks[511], d.blocks[512]], [0, 0, 1, 1, 0]);
  const last = rangeDetail(2, size, { kind: 'ram', id: 'disk', size, chunks: r.chunkKeys() });
  assert.deepEqual([last.blocks[0], last.blocks[255], last.blocks[256]], [1, 1, 4], 'past the end');
});

// ---------------------------------------------------------------------------------------------------------------------
// blk's `inspect`.

const [IN, OUT, DISCARD, ZEROES] = [0, 1, 11, 13];
/** A blk device in Node over guest RAM `ram`, with a request helper (the status byte near its end). */
function blkOf(size: number, overlaid = true) {
  const image = { size, read: (off: number, len: number) => new Uint8Array(len).fill(7) };
  const files = overlaid ? { data: memFile(), map: memFile(), meta: memFile(), close() {} } : undefined;
  return blkWith((ctx) => blk(ctx, image, files, true));
}
/** A request helper over the blk device `make` builds. */
function blkWith(make: (ctx: Ctx) => ReturnType<typeof blk>) {
  const ram = new Uint8Array(6 * MiB);
  const status = ram.length - 8192;
  const ctx = { ram: () => [ram] } as unknown as Ctx;
  const b = make(ctx);
  /** A request submitted (`at`: where in RAM its header, body and status go, for several at once), and its status once it ended. */
  const submit = (type: number, sector: number, body: Uint8Array, room = 0, at = 0) => {
    const st = at ? at + 16 + body.length : status;
    const h = new DataView(ram.buffer, at, 16);
    h.setUint32(0, type, true);
    h.setBigUint64(8, BigInt(sector), true);
    ram.set(body, at + 16);
    const p = b.request({ w0: 0, queue: 0, read: [{ off: at, len: 16, mem: 0 }, { off: at + 16, len: body.length, mem: 0 }].filter((s) => s.len), write: [{ off: st, len: room + 1, mem: 0 }] });
    return Promise.resolve(p).then(() => ram[st + room]);
  };
  const ask = (type: number, sector: number, body: Uint8Array, room = 0) => submit(type, sector, body, room);
  const seg = (sector: number, sectors: number, flags = 0) => {
    const s = new DataView(new ArrayBuffer(16));
    s.setBigUint64(0, BigInt(sector), true);
    s.setUint32(8, sectors, true);
    s.setUint32(12, flags, true);
    return new Uint8Array(s.buffer);
  };
  return { b, ask, seg, submit };
}
const sectorOf = (bytes: number) => bytes / 512;

test('blk inspect: the activity wrapper comes with a query, marks reads and writes, clears on answer, and goes when none asks', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const size = 8 * RANGE;
    const { b, ask, seg } = blkOf(size);
    const original = b.request;
    const q = { kind: 'disk-surface', disk: 0, cells: 8, activity: true } as const;
    // Without activity: nothing wrapped.
    const plain = surfaceOfAnswer(await b.inspect!({ ...q, activity: false }));
    assert.equal(b.request, original);
    assert.equal(plain.activity, undefined);
    assert.equal(layer(plain, 'disk').known, 'opaque');
    // With it: wrapped, and the next answer has the requests' ranges.
    const first = surfaceOfAnswer(await b.inspect!(q));
    assert.notEqual(b.request, original);
    assert.deepEqual([...first.activity!], [0, 0, 0, 0, 0, 0, 0, 0]);
    assert.equal(typeof first.cost, 'number');
    assert.equal(await ask(OUT, sectorOf(RANGE + 8 * BLOCK), new Uint8Array(2 * BLOCK).fill(1)), 0);
    assert.equal(await ask(IN, sectorOf(3 * RANGE - 512), new Uint8Array(0), 1024), 0, 'a read across ranges 2 and 3');
    assert.equal(await ask(DISCARD, 0, seg(sectorOf(5 * RANGE), 8)), 0);
    assert.equal(await ask(ZEROES, 0, seg(sectorOf(6 * RANGE), 16, 1)), 0);
    const second = surfaceOfAnswer(await b.inspect!(q));
    assert.deepEqual([...second.activity!], [0, 2, 1, 1, 0, 2, 2, 0]);
    assert.deepEqual([...layer(second, 'overlay').held], [0, 2, 0, 0, 0, 0, 0, 0]);
    assert.deepEqual([...layer(second, 'overlay').zero], [0, 0, 0, 0, 0, 0, 2, 0]);
    assert.deepEqual([...surfaceOfAnswer(await b.inspect!(q)).activity!], [0, 0, 0, 0, 0, 0, 0, 0], 'cleared by the answer');
    // At a coarser resolution the marks are per cell.
    await ask(IN, 0, new Uint8Array(0), 512);
    await ask(OUT, sectorOf(7 * RANGE), new Uint8Array(BLOCK));
    assert.deepEqual([...surfaceOfAnswer(await b.inspect!({ ...q, cells: 2 })).activity!], [1, 2]);
    // No query for the idle time: the request is the original again.
    mock.timers.tick(2999);
    assert.notEqual(b.request, original);
    await b.inspect!(q); // a query holds it on
    mock.timers.tick(2999);
    assert.notEqual(b.request, original);
    mock.timers.tick(1);
    assert.equal(b.request, original, 'the original request, after the idle time');
    assert.equal(surfaceOfAnswer(await b.inspect!({ ...q, activity: false })).activity, undefined);
    // At close, too.
    await b.inspect!(q);
    assert.notEqual(b.request, original);
    b.close!();
    assert.equal(b.request, original, 'the original request, after close');
  } finally {
    mock.timers.reset();
  }
});

test('blk inspect: counts kept while watching match a whole walk after random changes; ranges and their content', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const size = 12 * RANGE + 5 * BLOCK;
    const { b, ask, seg } = blkOf(size);
    const g = splitmix64(7n);
    const rand = (n: number) => Number((g.next().value as bigint) % BigInt(n));
    const q = { kind: 'disk-surface', disk: 0, cells: 64, activity: true } as const;
    const fresh = { data: memFile(), map: memFile() }; // a model: the same changes, walked whole
    const model = overlay(openDisk((off, len) => new Uint8Array(len).fill(7), size), fresh.data, fresh.map);
    for (let i = 0; i < 300; i++) {
      const block = rand(Math.floor(size / BLOCK) - 40);
      const n = 1 + rand(rand(4) ? 8 : 1200);
      const len = Math.min(n, Math.floor(size / BLOCK) - block);
      const op = rand(3);
      if (op === 0) {
        assert.equal(await ask(OUT, sectorOf(block * BLOCK), new Uint8Array(len * BLOCK).fill(1 + rand(255))), 0);
        assert.ok(await model.write(block * BLOCK, new Uint8Array(len * BLOCK).fill(1)));
      } else if (op === 1) {
        assert.equal(await ask(DISCARD, 0, seg(sectorOf(block * BLOCK), len * 8)), 0);
        assert.ok(model.discard(block * BLOCK, len * BLOCK));
      } else {
        assert.equal(await ask(ZEROES, 0, seg(sectorOf(block * BLOCK), len * 8, 1)), 0);
        assert.ok(await model.zero(block * BLOCK, len * BLOCK));
      }
      if (i % 10 === 0) {
        const s = surfaceOfAnswer(await b.inspect!(q));
        const want = summarize(model.leaves!(), 'overlay', size, s.cellBytes);
        const got = layer(s, 'overlay');
        assert.ok(got.held.every((x, k) => x === want.held[k]) && got.zero.every((x, k) => x === want.zero[k]), `counts at step ${i}`);
      }
    }
    // A range's detail and its content check: written blocks of ones (none all zeros), plus the image's 7s.
    const fill = await blkOf(2 * RANGE);
    assert.equal(await fill.ask(OUT, 0, new Uint8Array(3 * BLOCK).fill(1)), 0);
    assert.equal(await fill.ask(OUT, sectorOf(3 * BLOCK), new Uint8Array(BLOCK)), 0); // a block of zeros, written
    const r = await fill.b.inspect!({ kind: 'disk-range', disk: 0, range: 0, content: true });
    assert.equal(r.kind, 'disk-range');
    const d = (r as Extract<InspectAnswer, { kind: 'disk-range' }>).detail;
    assert.deepEqual([d.blocks[0], d.blocks[3], d.blocks[4]], [2, 2, 5], "the overlay's, and the raw image's not examined");
    assert.deepEqual(d.runs, { overlay: 1 });
    assert.deepEqual(d.content, { read: 4, zeros: 1 }, 'an image\'s blocks are not read');
    assert.equal((await fill.b.inspect!({ kind: 'disk-range', disk: 0, range: 2 })).kind, 'none', 'past the end');
    fill.b.close!();
    b.close!();
  } finally {
    mock.timers.reset();
  }
});

test('Devices.inspect: a ramdisk and a blank disk end to end; none for other devices', async () => {
  const memory = new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true });
  const specs = [{ type: 'rng' as const }, { type: 'blk' as const, source: 'ram' as const, size: 16 * MiB }, { type: 'blk' as const, source: 'zero' as const, size: 6 * MiB }];
  const d = await Devices.open({ memory, shared: [0, 0, 0], ram: 0, ramSize: 0, signal: 0, specs, deterministic: true }, () => {});
  try {
    assert.equal((await d.inspect(0, { kind: 'disk-surface', disk: 0, cells: 4 })).kind, 'none');
    assert.equal((await d.inspect(9, { kind: 'disk-surface', disk: 0, cells: 4 })).kind, 'none');
    const ram = surfaceOfAnswer(await d.inspect(1, { kind: 'disk-surface', disk: 0, cells: 4 }));
    assert.deepEqual([ram.size, ram.layers.length, ...layer(ram, 'disk').held], [16 * MiB, 1, 0, 0, 0, 0], 'an empty ramdisk');
    const blank = surfaceOfAnswer(await d.inspect(2, { kind: 'disk-surface', disk: 1, cells: 4 }));
    assert.deepEqual([layer(blank, 'disk').known, ...layer(blank, 'disk').held], ['counted', 0, 0]);
  } finally {
    d.close();
  }
  // A blank disk's source is an empty map.
  assert.equal(zeroSource(MiB).leaves!().n, 0);
});

// ---------------------------------------------------------------------------------------------------------------------
// The job worker's answers from files (Node keeps overlays in memory, by name).

test('surface job: a stored disk and an overlay of another size from their files; in use elsewhere, said', async () => {
  const size = 3 * RANGE;
  // The stored disk: blocks 0-15.
  const st = await openOverlay('disks/surf-a', 'id-a');
  assert.ok(await overlay(zeroDisk(size), st.data, st.map, st.meta).write(0, new Uint8Array(16 * BLOCK).fill(9)));
  st.close();
  // An overlay grown to 5 ranges: a block zeroed in range 0, blocks written in range 4 (one of zeros).
  await writeOwnSize('overlays/surf-a', 5 * RANGE);
  const ov = await openOverlay('overlays/surf-a', 'id-a');
  const o = overlay(zeroDisk(size), ov.data, ov.map, ov.meta);
  assert.equal(o.size, 5 * RANGE);
  assert.ok(await o.zero(0, BLOCK));
  assert.ok(await o.write(4 * RANGE, new Uint8Array(2 * BLOCK).fill(1)));
  assert.ok(await o.write(4 * RANGE + 2 * BLOCK, new Uint8Array(BLOCK)));
  ov.close();
  const job = { stored: 'disks/surf-a', overlay: 'overlays/surf-a', size, baseKind: 'stored' as const };
  const s = surfaceOfAnswer(await surfaceJob({ ...job, query: { kind: 'disk-surface', disk: 0, cells: 8 } }));
  assert.equal(s.size, 5 * RANGE, 'the overlay\'s own size');
  assert.deepEqual([...layer(s, 'disk').held], [16, 0, 0, 0, 0]);
  assert.equal(layer(s, 'disk').size, size);
  assert.deepEqual([...layer(s, 'overlay').held, ...layer(s, 'overlay').zero], [0, 0, 0, 0, 3, 1, 0, 0, 0, 0]);
  // A range: the disk's blocks under the overlay's zeroed one, and the content of what is held.
  const r = await surfaceJob({ ...job, query: { kind: 'disk-range', disk: 0, range: 0, content: true } });
  const d = (r as Extract<InspectAnswer, { kind: 'disk-range' }>).detail;
  assert.deepEqual([d.blocks[0], d.blocks[1], d.blocks[16]], [3, 1, 0]);
  assert.deepEqual(d.content, { read: 15, zeros: 0 });
  const r4 = (await surfaceJob({ ...job, query: { kind: 'disk-range', disk: 0, range: 4, content: true } })) as Extract<InspectAnswer, { kind: 'disk-range' }>;
  assert.deepEqual(r4.detail.content, { read: 3, zeros: 1 });
  assert.deepEqual(r4.detail.runs, { disk: 0, overlay: 1 });
  // An overlay no machine has opened yet (no files): no changes. A blank disk: nothing held.
  const none = surfaceOfAnswer(await surfaceJob({ overlay: 'overlays/surf-none', size, baseKind: 'blank', query: { kind: 'disk-surface', disk: 0, cells: 3 } }));
  assert.deepEqual([...layer(none, 'disk').held, ...layer(none, 'overlay').held], [0, 0, 0, 0, 0, 0]);
  // A machine holds the overlay's lock (exclusive): after the wait, said in words.
  const release = await lockOverlay('overlays/surf-a');
  try {
    const t = performance.now();
    const busy = await surfaceJob({ ...job, query: { kind: 'disk-surface', disk: 0, cells: 8 } }, 100);
    assert.ok(performance.now() - t < 1000);
    assert.deepEqual(busy, { kind: 'none', why: { key: 'disks:surface-job.inUse' } });
  } finally {
    release();
  }
});

test('diskInspector: while watched, a change the marks missed (a request in flight when the wrapper went on) is caught up by the full walk every fullMs', async () => {
  const size = 4 * RANGE;
  const o = overlay(zeroDisk(size), memFile(), memFile());
  let clock = 0;
  let installed = 0;
  const inspector = diskInspector(
    { disk: { kind: 'blank', id: 'disk', size }, overlay: { id: 'overlay', size, leaves: () => o.leaves!(), read: (b) => o.block(b) } },
    { install: () => installed++, uninstall: () => undefined, idleMs: 1e9, fullMs: 10_000, now: () => clock },
  );
  const q = { kind: 'disk-surface', disk: 0, cells: 4, activity: true } as const;
  const held = async () => [...layer(surfaceOfAnswer(await inspector.inspect(q)), 'overlay').held];
  assert.deepEqual(await held(), [0, 0, 0, 0], 'the first walk');
  assert.deepEqual(await held(), [0, 0, 0, 0], 'the second, warm from here');
  assert.equal(installed, 1);
  // Written without a mark (as a request that started before the wrapper and ended after both walks).
  assert.ok(await o.write(2 * RANGE, new Uint8Array(3 * BLOCK).fill(5)));
  clock = 5_000;
  assert.deepEqual(await held(), [0, 0, 0, 0], 'only the marked ranges are counted again');
  clock = 10_000;
  assert.deepEqual(await held(), [0, 0, 3, 0], 'the full walk every fullMs');
  // And the marks say the rest between full walks again.
  assert.ok(await o.write(0, new Uint8Array(BLOCK).fill(5)));
  clock = 12_000;
  assert.deepEqual(await held(), [0, 0, 3, 0], 'unmarked, not seen until the next full walk');
  clock = 20_000;
  assert.deepEqual(await held(), [1, 0, 3, 0]);
  inspector.close();
});

// ---------------------------------------------------------------------------------------------------------------------

test('the time of a whole walk over 25,600 leaves (100 GiB written), and of recounting a few', (t) => {
  const n = 25_600;
  const REC = LEAF + 2;
  const top = new Uint32Array(n);
  const recs = new Uint32Array(n * REC);
  for (let r = 0; r < n; r++) {
    top[r] = r + 1;
    for (let i = 0; i < LEAF; i++) recs[r * REC + i] = i % 7 === 0 ? 0xffffffff : r * LEAF + i + 1;
  }
  const m: Leaves = { top, recs, n };
  const size = n * RANGE;
  const time = (f: () => void) => {
    for (let k = 0; k < 3; k++) f();
    const ts: number[] = [];
    for (let k = 0; k < 9; k++) {
      const s = performance.now();
      f();
      ts.push(performance.now() - s);
    }
    return ts.sort((a, b) => a - b)[4];
  };
  let counts = rangeCounts(m, size);
  const whole = time(() => { counts = rangeCounts(m, size); });
  const some = time(() => { for (let r = 0; r < 16; r++) countRange(m, r * 1000, n * LEAF, counts); });
  const cells = time(() => summarize(m, 'overlay', size, cellBytesFor(size, 4096)));
  assert.equal(counts.held[5], LEAF - Math.ceil(LEAF / 7));
  t.diagnostic(`whole walk ${whole.toFixed(1)} ms, 16 ranges ${some.toFixed(3)} ms, a summary at 4,096 cells ${cells.toFixed(1)} ms (medians of 9)`);
});

// ---------------------------------------------------------------------------------------------------------------------
// Live, end to end through `Devices.open` with the specs the machine worker makes (web/app/worker-devices.ts `blkSpec`).

const memory1 = () => new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true });
const devicesOf = (specs: DeviceSpec[], deterministic = true) =>
  Devices.open({ memory: memory1(), shared: specs.map(() => 0), ram: 0, ramSize: 0, signal: 0, specs, deterministic }, () => {});

test('live through a grown overlay: the disk keeps its own size (a blank disk, a stored disk), the overlay the grown one', async () => {
  // A stored disk of 4 MiB with blocks 0-7, under an overlay grown to 12 MiB.
  const st = await openOverlay('disks/surf-grown', 'id-g');
  assert.ok(await overlay(zeroDisk(RANGE), st.data, st.map, st.meta).write(0, new Uint8Array(8 * BLOCK).fill(3)));
  st.close();
  await writeOwnSize('overlays/surf-grown-s', 3 * RANGE);
  await writeOwnSize('overlays/surf-grown-b', 3 * RANGE);
  const specs = [
    blkSpec({ name: 's', source: { stored: 'disks/surf-grown', size: RANGE }, overlay: 'overlays/surf-grown-s', identity: 'id-g', size: 3 * RANGE }),
    blkSpec({ name: 'b', source: { blank: RANGE }, overlay: 'overlays/surf-grown-b', identity: 'id-b', size: 3 * RANGE }),
  ];
  const d = await devicesOf(specs);
  try {
    for (const [i, held] of [[0, 8], [1, 0]] as const) {
      const s = surfaceOfAnswer(await d.inspect(i, { kind: 'disk-surface', disk: i, cells: 3 }));
      assert.equal(s.size, 3 * RANGE, `disk ${i}: the view spans the overlay`);
      assert.equal(layer(s, 'disk').size, RANGE, `disk ${i}: the disk's own size, not the guest's`);
      assert.equal(layer(s, 'overlay').size, 3 * RANGE);
      assert.deepEqual([...layer(s, 'disk').held], [held, 0, 0]);
      // The disk's range 0 block by block, its held blocks read for the content check (the stored disk's map and data).
      const r = (await d.inspect(i, { kind: 'disk-range', disk: i, range: 0, content: true })) as Extract<InspectAnswer, { kind: 'disk-range' }>;
      assert.deepEqual([r.detail.blocks[0], r.detail.blocks[7], r.detail.blocks[8]], [held ? 1 : 0, held ? 1 : 0, 0]);
      assert.deepEqual(r.detail.content, { read: held, zeros: 0 });
      assert.deepEqual(r.detail.runs, { disk: held ? 1 : 0, overlay: 0 });
    }
  } finally {
    d.close();
  }
});

test('live in place: a stored disk written in place (a blank source, the store its overlay) is shown as the disk, writes and all', async () => {
  const size = 2 * RANGE;
  const st = await openOverlay('disks/surf-inplace', 'id-p');
  assert.ok(await overlay(zeroDisk(size), st.data, st.map, st.meta).write(0, new Uint8Array(4 * BLOCK).fill(2)));
  st.close();
  const files = await openOverlay('disks/surf-inplace', 'id-p');
  const { b, ask, seg } = blkWith((ctx) => blk(ctx, zeroSource(size), files, true));
  try {
    assert.equal(await ask(OUT, sectorOf(RANGE), new Uint8Array(3 * BLOCK).fill(1)), 0);
    assert.equal(await ask(ZEROES, 0, seg(sectorOf(BLOCK), 8, 1)), 0); // block 1 zeroed: it reads as nothing now
    const s = surfaceOfAnswer(asInPlace(await b.inspect!({ kind: 'disk-surface', disk: 0, cells: 2 })));
    assert.deepEqual(s.layers.map((l) => [l.id, l.size, [...l.held], [...l.zero]]), [['disk', size, [3, 3], [0, 0]]]);
    const r = asInPlace(await b.inspect!({ kind: 'disk-range', disk: 0, range: 0, content: true })) as Extract<InspectAnswer, { kind: 'disk-range' }>;
    assert.deepEqual([...r.detail.blocks.subarray(0, 5)], [1, 0, 1, 1, 0]);
    assert.deepEqual(r.detail.runs, { disk: 2 });
    assert.deepEqual(r.detail.content, { read: 3, zeros: 0 });
  } finally {
    b.close!();
  }
});

test('blk inspect over the realtime wrappers (concurrent, stats): a write asked about while in flight is counted once it ended', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const size = 4 * RANGE;
    let open!: () => void;
    let gate = new Promise<void>((r) => (open = r));
    const image = {
      size,
      read: (_off: number, len: number) => new Uint8Array(len).fill(7),
      readAsync: async (_off: number, len: number) => {
        await gate;
        return new Uint8Array(len).fill(7);
      },
    };
    const files = { data: memFile(), map: memFile(), meta: memFile(), close() {} };
    const { b, submit } = blkWith((ctx) => blk(ctx, image, files, true, new IoStats(), undefined, true));
    assert.ok(b.concurrent, 'concurrent: the source reads asynchronously');
    const q = { kind: 'disk-surface', disk: 0, cells: 4, activity: true } as const;
    const held = async () => [...layer(surfaceOfAnswer(await b.inspect!(q)), 'overlay').held];
    assert.deepEqual(await held(), [0, 0, 0, 0]);
    assert.deepEqual(await held(), [0, 0, 0, 0], 'warm');
    // A read of the image held at its gate; a write behind it (it waits for every request before it).
    const read = submit(IN, sectorOf(3 * RANGE), new Uint8Array(0), BLOCK, 0x10000);
    const write = submit(OUT, sectorOf(2 * RANGE), new Uint8Array(2 * BLOCK).fill(1), 0, 0x20000);
    const s = surfaceOfAnswer(await b.inspect!(q));
    assert.deepEqual([...layer(s, 'overlay').held], [0, 0, 0, 0], 'the write not landed yet');
    assert.deepEqual([...s.activity!], [0, 0, 2, 1], 'both seen at their submission');
    open();
    assert.deepEqual([await read, await write], [0, 0]);
    gate = Promise.resolve();
    assert.deepEqual(await held(), [0, 0, 2, 0], 'counted again once it ended');
    b.close!();
  } finally {
    mock.timers.reset();
  }
});

test('surface job: a stored disk with a merge interrupted is said so, not drawn half merged', async () => {
  const size = 2 * RANGE;
  const st = await openOverlay('disks/surf-merging', 'id-m');
  assert.ok(await overlay(zeroDisk(size), st.data, st.map, st.meta).write(0, new Uint8Array(4 * BLOCK).fill(9)));
  assert.ok(writeMeta(st.meta, { ...readMeta(st.meta), merging: 'overlays/surf-merged' }));
  st.close();
  for (const query of [{ kind: 'disk-surface', disk: 0, cells: 2 }, { kind: 'disk-range', disk: 0, range: 0, content: true }] as const)
    assert.deepEqual(await surfaceJob({ stored: 'disks/surf-merging', size, baseKind: 'stored', query }), { kind: 'none', why: { key: 'disks:surface-job.merging' } });
});
