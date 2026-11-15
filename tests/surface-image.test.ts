// A disk surface's images (web/surface.ts, docs/frontend.md "A disk's surface"): a qcow2's clusters counted from its L2
// tables (web/qcow2.ts `allocation`, `readAllocation`) at 64 KiB and 512-byte clusters, a range block by block; the
// tables read once from a local image, from a remote one only where the block cache keeps them (nothing fetched),
// and not past `ALLOCATION_MAX`; what's under a table not read yet not examined, counted as its table comes (each
// table once); a remote image's blocks kept in this browser as ticks (a raw one's, a qcow2's data and compressed
// clusters' host bytes) and the time of counting them on a 20 GiB image; blk's `inspect` over each; the job worker's
// answer from a file (web/app/surface-job.ts) and the page's handle check, which never asks (surface-source.ts
// `jobOf`). The qcow2s are made by tests/qcow2-make.ts.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cachedSource } from '../web/blockcache.ts';
import { blk, type Ctx, type Source } from '../web/devices.ts';
import { blockStore } from '../web/diskcache.ts';
import { memFile } from '../web/overlay.ts';
import { ALLOCATION_MAX, openDisk, readAllocation, type Allocation } from '../web/qcow2.ts';
import { allocationCounts, imageLayer, keptCounts, keptIndex, keptUnits, rangeDetail, type InspectAnswer, type Surface } from '../web/surface.ts';
import { surfaceJob } from '../web/app/surface-job.ts';
import { jobOf } from '../web/app/surface-source.ts';
import { cellWords, detailLook, detailWords, legendOf, lookOf, opaqueWords, viewOf, wholeWords } from '../web/app/surface-look.ts';
import { RIM, TICK } from '../web/app/ui/block-grid.ts';
import { qcow2, type Kind } from './qcow2-make.ts';

const UNIT = 4096;
const RANGE = 1024 * UNIT;
const MiB = 1 << 20;

const readerOf = (b: Uint8Array) => (off: number, len: number) => (off >= 0 && off + len <= b.length ? b.slice(off, off + len) : undefined);

/** The 64 KiB image the tests share: 12 MiB and a cluster, its clusters in ranges 0, 1 and 2, a zero one. */
const SIZE = 12 * MiB + 64 * 1024;
const CLUSTERS = new Map<number, Kind>([[0, 'data'], [1, 'data'], [2, 'zero'], [64, 'data'], [130, 'compressed'], [192, 'data']]);

test('a qcow2 at 64 KiB clusters: its clusters with data counted per range, a range block by block', async () => {
  const { bytes } = qcow2(SIZE, 16, CLUSTERS);
  const d = openDisk(readerOf(bytes), bytes.length);
  const a = d.allocation!(readerOf(bytes))!;
  assert.deepEqual([a.clusterBytes, a.size], [64 * 1024, SIZE]);
  assert.deepEqual([0, 1, 2, 3, 64, 130, 192].map((c) => a.allocated(c)), [true, true, false, false, true, true, true], 'a zero cluster has no data');
  const counts = allocationCounts(a, SIZE);
  assert.deepEqual([...counts.held], [32, 16, 16, 16], 'a cluster is 16 blocks; the short range has its one');
  assert.deepEqual([...counts.unknown], [0, 0, 0, 0], 'every table read');
  const layer = imageLayer({ kind: 'clusters', id: 'disk', size: SIZE, allocation: a }, 2 * RANGE);
  assert.deepEqual([layer.known, ...layer.held], ['counted', 48, 32]);
  assert.equal(layer.unknown, undefined, 'nothing not examined: no array');
  const r = rangeDetail(0, SIZE, { kind: 'clusters', id: 'disk', size: SIZE, allocation: a });
  assert.deepEqual([r.blocks[0], r.blocks[31], r.blocks[32], r.blocks[47], r.blocks[48]], [1, 1, 0, 0, 0]);
  assert.deepEqual(r.runs, {}, 'no store: no runs');
  const last = rangeDetail(3, SIZE, { kind: 'clusters', id: 'disk', size: SIZE, allocation: a });
  assert.deepEqual([last.blocks[15], last.blocks[16]], [1, 4], 'past the end');
  // The same from the file, read whole without blocking (the job worker's).
  const whole = await readAllocation(async (off, len) => readerOf(bytes)(off, len), bytes.length);
  assert.deepEqual([...allocationCounts(whole!, SIZE).held], [...counts.held]);
  assert.equal(await readAllocation(async (off, len) => new Uint8Array(len), 1 << 20), undefined, 'a raw image');
});

test('a qcow2 at 512-byte clusters: a block holds data if any of its eight clusters does', () => {
  const size = 64 * UNIT;
  const { bytes } = qcow2(size, 9, new Map<number, Kind>([[0, 'data'], [7, 'data'], [9, 'data'], [16, 'zero'], [100, 'compressed']]));
  const a = openDisk(readerOf(bytes), bytes.length).allocation!(readerOf(bytes))!;
  const counts = allocationCounts(a, size);
  assert.deepEqual([...counts.held], [3], 'blocks 0, 1 and 12');
  const r = rangeDetail(0, size, { kind: 'clusters', id: 'disk', size, allocation: a });
  assert.deepEqual([...r.blocks.subarray(0, 13)], [1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]);
});

test('the tables: read once from a local image, from a remote one only where kept, never past ALLOCATION_MAX', async () => {
  const { bytes, l2At, cs } = qcow2(SIZE, 16, CLUSTERS);
  // Without `load`, only the tables a request read: none yet, then the one a read of the disk brought.
  const reads: number[] = [];
  const d = openDisk((off, len) => (reads.push(off), readerOf(bytes)(off, len)), bytes.length);
  const a = d.allocation!();
  assert.deepEqual([a.missing(), a.known(0)], [1, false], 'no table read yet');
  assert.ok(await d.read(0, 4096));
  assert.deepEqual([a.missing(), a.known(0), a.allocated(0)], [0, true, true], 'the one table, read by the request');
  const n = reads.length;
  assert.equal(d.allocation!(readerOf(bytes)), a, 'one object: it follows the tables as they come');
  assert.equal(reads.length, n, 'none read again');
  // A remote image through the block cache: its table is read for the map only once the cache holds its block.
  const fetched: [number, number][] = [];
  const src: Source = { size: bytes.length, read: (off, len) => (fetched.push([off, len]), readerOf(bytes)(off, len)) };
  const c = cachedSource(src, { block: cs, bytes: 64 * cs });
  const ctx = { ram: () => [new Uint8Array(MiB)] } as unknown as Ctx;
  const b = blk(ctx, c);
  const before = fetched.length; // the header and L1 at the opening
  const surface = async () => ((await b.inspect!({ kind: 'disk-surface', disk: 0, cells: 8 })) as Extract<InspectAnswer, { kind: 'disk-surface' }>).surface;
  const unread = (await surface()).layers[0];
  assert.deepEqual([unread.known, unread.why, ...unread.held, ...unread.unknown!], ['counted', 'tables', 0, 0, 0, 0, 1024, 1024, 1024, 16]);
  assert.equal(fetched.length, before, 'nothing fetched for the map');
  assert.equal(c.kept.has(l2At.get(0)! / cs), false);
  c.read(l2At.get(0)!, 8); // the guest's read brings the table's block
  const counted = (await surface()).layers[0];
  assert.deepEqual([counted.known, ...counted.held], ['counted', 32, 16, 16, 16]);
  assert.equal(counted.unknown, undefined, 'all known');
  // L1 entries that all name one table: more than ALLOCATION_MAX bytes of tables, so none are read for the map, and
  // those a request read are counted (the rest not examined).
  const huge = qcow2((ALLOCATION_MAX / (64 * 1024) + 1) * 512 * MiB, 16, new Map([[0, 'data']]), true);
  const hd = openDisk(readerOf(huge.bytes), huge.bytes.length);
  let loads = 0;
  const ha = hd.allocation!((off, len) => (loads++, readerOf(huge.bytes)(off, len)));
  const tables = ALLOCATION_MAX / (64 * 1024) + 1;
  assert.deepEqual([loads, ha.missing()], [0, tables]);
  assert.ok(await hd.read(0, 4096));
  const hc = allocationCounts(ha, hd.size);
  assert.deepEqual([ha.missing(), hc.held[0], hc.unknown[0], hc.unknown[128]], [tables - 1, 16, 0, 1024], 'the table read counted, the rest not examined');
});

/** An allocation that counts its calls (each table's clusters are asked once). */
function counting(a: Allocation) {
  const n = { allocated: 0, host: 0 };
  return { n, a: { ...a, allocated: (c: number) => (n.allocated++, a.allocated(c)), host: (c: number) => (n.host++, a.host(c)), known: (t: number) => a.known(t), missing: () => a.missing() } as Allocation };
}

// 16 MiB at 4 KiB clusters: an L2 table covers 2 MiB, two a range. Data in tables 0 and 1, a compressed and a zero
// cluster in table 2, data in table 7 (the last); tables 3 to 6 have none (their L1 entries are empty: known at once).
const SMALL = 16 * MiB;
const SMALL_CLUSTERS = new Map<number, Kind>([[0, 'data'], [1, 'data'], [600, 'data'], [1100, 'compressed'], [1500, 'zero'], [3800, 'data']]);

/** `SMALL_CLUSTERS`' image, its compressed cluster's packed bytes moved to the last sector of its slot (one sector: they end in the slot's block). */
function smallImage() {
  const made = qcow2(SMALL, 12, SMALL_CLUSTERS);
  const v = new DataView(made.bytes.buffer);
  const at = made.l2At.get(2)! + (1100 % 512) * 8;
  v.setBigUint64(at, (1n << 62n) | ((v.getBigUint64(at) & 0x00ff_ffff_ffff_fe00n) + 3584n));
  return made;
}

test('a remote qcow2 whose tables come as the guest reads them: not examined under the others, each table counted once, kept per cluster', async () => {
  const { bytes, l2At, cs } = smallImage();
  const fetched: number[] = [];
  const src: Source = { size: bytes.length, read: (off, len) => (fetched.push(off), readerOf(bytes)(off, len)) };
  const c = cachedSource(src, { block: cs, bytes: 256 * cs });
  const { ask } = device(c);
  const before = fetched.length;
  const surface = async (cells = 4) => surfaceOf(await ask({ kind: 'disk-surface', disk: 0, cells }));
  // No table read: what's under the four not examined (counted, unknown), under the empty L1 entries known empty.
  const s0 = await surface();
  const d0 = s0.layers[0];
  assert.deepEqual([d0.known, d0.why, ...d0.held, ...d0.unknown!], ['counted', 'tables', 0, 0, 0, 0, 1024, 512, 0, 512]);
  assert.deepEqual([...lookOf(s0).rim], [RIM.opaque, RIM.opaque, RIM.empty, RIM.opaque], 'known empty with some not examined: not examined');
  assert.deepEqual(wholeWords(s0, false).map((m) => m.key), ['disks:surface-look.why.tablesSome', 'disks:surface-look.keptNone']);
  assert.deepEqual(cellWords(s0, 0).map((m) => m.key), ['disks:surface-look.at', 'disks:surface-look.disk.unknownAll']);
  assert.deepEqual(cellWords(s0, 1).map((m) => [m.key, m.params]).slice(1), [['disks:surface-look.disk.emptyKnown', { count: 512 }], ['disks:surface-look.disk.unknown', { count: 512 }]]);
  const r00 = (await ask<'disk-range'>({ kind: 'disk-range', disk: 0, range: 0 })).detail;
  assert.ok(r00.blocks.every((b) => b === 5));
  assert.deepEqual(detailWords(r00, { disk: 'counted', overlay: false, kept: true }).map((m) => m.key), ['disks:surface-look.range', 'disks:surface-look.range.unknownAll']);
  // Table 0 arrives (the guest's read): range 0's first half counted, its second (table 1) still not examined.
  c.read(l2At.get(0)!, 8);
  const s1 = await surface();
  const d1 = s1.layers[0];
  assert.deepEqual([...d1.held, ...d1.unknown!], [2, 0, 0, 0, 512, 512, 0, 512]);
  assert.deepEqual([...lookOf(s1).rim], [RIM.step(1), RIM.opaque, RIM.empty, RIM.opaque], 'held: its step over the blocks known');
  assert.deepEqual(cellWords(s1, 0).map((m) => [m.key, m.params]), [
    ['disks:surface-look.at', { from: '0 B', to: '4 MiB' }],
    ['disks:surface-look.disk.heldKnown', { held: 2, count: 512 }],
    ['disks:surface-look.disk.unknown', { count: 512 }],
    ['disks:surface-look.disk.keptNone', undefined],
  ]);
  assert.deepEqual(wholeWords(s1, false).map((m) => m.key), ['disks:surface-look.why.tablesSome', 'disks:surface-look.keptNone']);
  assert.ok(viewOf(s1, 'url', false, true).unknown, 'the legend has "not examined"');
  assert.deepEqual(legendOf(viewOf(s1, 'url', false, true)).map((e) => e.key.split('.').pop()), ['empty', 'some', 'full', 'opaque', 'keptSome', 'kept', 'read', 'written']);
  // A range half known: its blocks under table 1 not examined (5), and said so.
  const r0 = (await ask<'disk-range'>({ kind: 'disk-range', disk: 0, range: 0 })).detail;
  assert.deepEqual([r0.blocks[0], r0.blocks[1], r0.blocks[2], r0.blocks[512], r0.blocks[1023]], [1, 1, 0, 5, 5]);
  assert.deepEqual(detailLook(r0).rim[512], RIM.opaque);
  assert.deepEqual(detailWords(r0, { disk: 'counted', overlay: false, kept: true }).map((m) => m.key), ['disks:surface-look.range', 'disks:surface-look.range.disk', 'disks:surface-look.range.unknown', 'disks:surface-look.range.keptData']);
  const r1 = (await ask<'disk-range'>({ kind: 'disk-range', disk: 0, range: 1 })).detail;
  assert.deepEqual([r1.blocks[0], r1.blocks[511], r1.blocks[512]], [5, 5, 0]);
  assert.deepEqual(detailWords(r1, { disk: 'counted', overlay: false }).map((m) => m.key), ['disks:surface-look.range', 'disks:surface-look.range.diskEmptyKnown', 'disks:surface-look.range.unknown']);
  // The rest of the tables, and data clusters' and a compressed cluster's bytes kept: counted, ticked.
  for (const t of [1, 2, 7]) c.read(l2At.get(t)!, 8);
  const host = (k: number) => openDisk(readerOf(bytes), bytes.length).allocation!(readerOf(bytes)).host(k)!;
  c.read(host(0)[0], 8); // data cluster 0's block
  assert.deepEqual(host(1100)[1], 512, "a compressed cluster's packed bytes: one sector");
  c.read(host(1100)[0], 8); // the compressed cluster's packed bytes (the next block, the zero cluster's slot, not read)
  const s2 = await surface();
  const d2 = s2.layers[0];
  assert.equal(d2.unknown, undefined, 'all known');
  assert.deepEqual([...d2.held], [3, 1, 0, 1], 'a zero cluster has no data');
  assert.deepEqual([...d2.kept!], [1, 1, 0, 0], 'units kept: of data clusters whose bytes are all here');
  assert.deepEqual([...lookOf(s2).tick!], [TICK.part, TICK.all, TICK.none, TICK.none], 'all where every unit with data is kept; none where nothing is');
  assert.deepEqual(cellWords(s2, 1).map((m) => m.key).slice(-1), ['disks:surface-look.disk.keptData']);
  const r2 = (await ask<'disk-range'>({ kind: 'disk-range', disk: 0, range: 1 })).detail;
  assert.deepEqual([r2.blocks[1100 - 1024], r2.kept?.[1100 - 1024], r2.blocks[1500 - 1024], r2.kept?.[1500 - 1024]], [1, 1, 0, 0]);
  assert.deepEqual(detailLook(r2).tick?.[1100 - 1024], TICK.all, 'the 32 × 32 map ticks it too');
  assert.equal(fetched.length - before, 6, "only the guest's six reads fetched: nothing for the map");
  // Each table's clusters asked once: counting again with nothing new asks nothing.
  const { n, a } = counting(openDisk(readerOf(bytes), bytes.length).allocation!(readerOf(bytes)));
  const counts = allocationCounts(a, SMALL);
  const ix = keptIndex(a, SMALL, cs);
  const [allocated, hosts] = [n.allocated, n.host];
  assert.ok(allocated > 0 && hosts > 0);
  allocationCounts(a, SMALL, counts);
  keptIndex(a, SMALL, cs, ix);
  assert.deepEqual([n.allocated, n.host], [allocated, hosts], 'known tables not asked again');
  assert.deepEqual([...keptCounts(ix, { block: cs, has: () => true }, RANGE, 4)], [3, 1, 0, 1]);
});

test('a qcow2 whose tables come one by one: counted per table as they come, the same as all at once', async () => {
  const { bytes } = qcow2(SMALL, 12, SMALL_CLUSTERS);
  const d = openDisk(readerOf(bytes), bytes.length);
  const a = d.allocation!();
  let counts = allocationCounts(a, SMALL);
  assert.deepEqual([...counts.unknown], [1024, 512, 0, 512]);
  for (const at of [3800 * 4096, 0, 600 * 4096, 1100 * 4096]) {
    await d.read(at, 4096);
    counts = allocationCounts(a, SMALL, counts);
  }
  const whole = allocationCounts(openDisk(readerOf(bytes), bytes.length).allocation!(readerOf(bytes)), SMALL);
  assert.deepEqual([[...counts.held], [...counts.unknown]], [[...whole.held], [...whole.unknown]]);
});

test('the time of counting a 20 GiB qcow2 at 64 KiB clusters (327,680 clusters, every one with data): its tables, its kept index, a poll\'s kept count', (t) => {
  const cs = 64 * 1024;
  const size = 20 * 2 ** 30;
  const clusters = size / cs;
  const a: Allocation = { clusterBytes: cs, size, perTable: cs / 8, allocated: () => true, known: () => true, missing: () => 0, host: (c) => [(c + 64) * cs, cs] };
  const median = (f: () => void) => {
    const ts: number[] = [];
    for (let i = 0; i < 7; i++) {
      const s = performance.now();
      f();
      ts.push(performance.now() - s);
    }
    return ts.sort((x, y) => x - y)[3];
  };
  const counts = median(() => allocationCounts(a, size));
  const index = median(() => keptIndex(a, size, MiB));
  const ix = keptIndex(a, size, MiB);
  assert.equal(ix.length, clusters);
  const kept = new Set<number>();
  for (let b = 0; b < size / MiB; b += 3) kept.add(b);
  const cells = 5120;
  const poll = median(() => keptCounts(ix, { block: MiB, has: (b) => kept.has(b) }, size / cells, cells));
  t.diagnostic(`20 GiB at 64 KiB clusters: counted ${counts.toFixed(1)} ms, kept index ${index.toFixed(1)} ms (both once per table), a poll's kept count ${poll.toFixed(2)} ms (medians of 7)`);
  assert.ok(poll < 50, `a poll's kept count: ${poll} ms`);
});

const [IN] = [0];
/** A blk device in Node over `src`, read-only, and a read request of `len` bytes at `off`. */
function device(src: Source) {
  const ram = new Uint8Array(6 * MiB);
  const ctx = { ram: () => [ram] } as unknown as Ctx;
  const b = blk(ctx, src);
  const read = async (off: number, len: number) => {
    const h = new DataView(ram.buffer, 0, 16);
    h.setUint32(0, IN, true);
    h.setBigUint64(8, BigInt(off / 512), true);
    await b.request({ w0: 0, queue: 0, read: [{ off: 0, len: 16, mem: 0 }], write: [{ off: 4096, len: len + 1, mem: 0 }] });
  };
  const ask = async <K extends InspectAnswer['kind']>(q: Parameters<NonNullable<typeof b.inspect>>[0]) => (await b.inspect!(q)) as Extract<InspectAnswer, { kind: K }>;
  return { b, read, ask };
}
const surfaceOf = (a: InspectAnswer): Surface => (a as Extract<InspectAnswer, { kind: 'disk-surface' }>).surface;

test('blk inspect over a local qcow2: counted from its tables, a range and its content check', async () => {
  const { bytes } = qcow2(SIZE, 16, CLUSTERS);
  const { ask } = device({ size: bytes.length, read: readerOf(bytes) });
  const s = surfaceOf(await ask({ kind: 'disk-surface', disk: 0, cells: 4 }));
  assert.deepEqual([s.layers[0].known, ...s.layers[0].held], ['counted', 32, 16, 16, 16]);
  assert.deepEqual([...surfaceOf(await ask({ kind: 'disk-surface', disk: 0, cells: 2 })).layers[0].held], [48, 32], 'another cell size, the same counts');
  const r = await ask<'disk-range'>({ kind: 'disk-range', disk: 0, range: 0, content: true });
  assert.deepEqual([r.detail.blocks[0], r.detail.blocks[32]], [1, 0]);
  assert.deepEqual(r.detail.content, { read: 32, zeros: 0 }, 'its data clusters read through the image');
});

test('blk inspect over a remote raw image: not examined, with the blocks this browser keeps', async () => {
  const size = 8 * MiB;
  const image = Uint8Array.from({ length: size }, (_, i) => (i % 4096 ? 0 : 1));
  const fetched: number[] = [];
  const src: Source = { size, read: (off, len) => (fetched.push(off), image.slice(off, off + len)) };
  const store = blockStore(memFile(), memFile(), size, MiB, 8);
  store.put(5, image.slice(5 * MiB, 6 * MiB)); // kept from an earlier session
  const c = cachedSource(src, { block: MiB, bytes: 4 * MiB }, store);
  const { ask, read } = device(c);
  await read(0, 4096); // the guest reads block 0: its 1 MiB is in memory
  const n = fetched.length;
  const s = surfaceOf(await ask({ kind: 'disk-surface', disk: 0, cells: 2 }));
  const d = s.layers[0];
  assert.deepEqual([d.known, d.why, ...d.held, ...d.kept!], ['opaque', 'raw', 1024, 1024, 256, 256]);
  const r = await ask<'disk-range'>({ kind: 'disk-range', disk: 0, range: 1, content: true });
  assert.deepEqual([r.detail.blocks[0], r.detail.blocks[256], r.detail.blocks[512]], [5, 5, 5], 'not examined');
  assert.deepEqual([r.detail.kept?.[255], r.detail.kept?.[256], r.detail.kept?.[511], r.detail.kept?.[512]], [0, 1, 1, 0], 'its kept blocks');
  assert.deepEqual(r.detail.content, { read: 0, zeros: 0 }, 'a raw image\'s blocks are not read');
  assert.equal(fetched.length, n, 'nothing fetched for the map');
  // As the page draws it: the hatch, part kept as a half tick, the legend says so, a range's kept blocks ticked.
  const look = lookOf(s);
  assert.deepEqual([...look.rim], [RIM.opaque, RIM.opaque]);
  assert.deepEqual([...look.tick!], [TICK.part, TICK.part]);
  const legend = legendOf(viewOf(s, 'url', false, true));
  assert.deepEqual(legend.map((e) => e.key.split('.').pop()), ['opaque', 'keptSome', 'kept', 'read', 'written']);
  assert.deepEqual(legend.slice(1, 3).map((e) => [e.rim, e.tick]), [[RIM.opaque, TICK.part], [RIM.opaque, TICK.all]], 'ticks over the hatch');
  assert.deepEqual(opaqueWords(d, true).map((m) => m.key), ['disks:surface-look.why.raw', 'disks:surface-look.keptAll', 'disks:surface-look.overOpaque']);
  const dl = detailLook(r.detail);
  assert.deepEqual([dl.rim[0], dl.rim[256], dl.tick?.[0], dl.tick?.[256]], [RIM.opaque, RIM.opaque, TICK.none, TICK.all]);
  // The whole of a cell kept: all.
  const all = lookOf({ ...s, layers: [{ ...d, kept: Uint32Array.from([1024, 0]) }] });
  assert.deepEqual([...all.tick!], [TICK.all, TICK.none]);
  assert.deepEqual([...keptUnits(size, { block: 2 * RANGE, has: (k) => k === 0 }, RANGE)], [1024, 1024], 'a block larger than a cell spreads over its cells');
});

test('the job worker: a file\'s qcow2 counted from its tables, a raw one and one without permission not examined', async () => {
  const { bytes } = qcow2(SIZE, 16, CLUSTERS);
  const surface = async (job: Parameters<typeof surfaceJob>[0]) => surfaceOf(await surfaceJob(job)).layers[0];
  const q = { kind: 'disk-surface' as const, disk: 0, cells: 4 };
  const counted = await surface({ size: SIZE, baseKind: 'image', file: new Blob([bytes]), query: q });
  assert.deepEqual([counted.known, ...counted.held], ['counted', 32, 16, 16, 16]);
  const raw = await surface({ size: MiB, baseKind: 'image', file: new Blob([new Uint8Array(MiB)]), query: q });
  assert.deepEqual([raw.known, raw.why], ['opaque', 'raw']);
  const none = await surface({ size: MiB, baseKind: 'image', query: q });
  assert.deepEqual([none.known, none.why], ['opaque', 'permission']);
  const url = await surface({ size: MiB, baseKind: 'opaque', why: 'remote', query: q });
  assert.deepEqual([url.known, url.why], ['opaque', 'remote']);
  const r = (await surfaceJob({ size: SIZE, baseKind: 'image', file: new Blob([bytes]), query: { kind: 'disk-range', disk: 0, range: 1 } })) as Extract<InspectAnswer, { kind: 'disk-range' }>;
  assert.deepEqual([r.detail.blocks[0], r.detail.blocks[15], r.detail.blocks[16]], [1, 1, 0]);
  assert.equal(r.detail.kept, undefined, 'a file: nothing kept');
});

test('the page\'s handle check: the file where read is granted, never a permission asked for', async () => {
  const file = new Blob([new Uint8Array(8)]);
  const handle = (state: string) =>
    ({
      queryPermission: () => Promise.resolve(state),
      requestPermission: () => assert.fail('asked for a permission'),
      getFile: () => Promise.resolve(file),
    }) as unknown as FileSystemFileHandle;
  const job = { size: 8, baseKind: 'image' as const };
  assert.equal((await jobOf({ ...job, handle: handle('granted') })).file, file);
  assert.deepEqual(await jobOf({ ...job, handle: handle('prompt') }), { size: 8, baseKind: 'opaque', why: 'permission' });
  assert.deepEqual(await jobOf({ ...job }), { size: 8, baseKind: 'opaque', why: 'permission' });
});
