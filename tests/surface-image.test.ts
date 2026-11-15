// A disk surface's images (web/surface.ts, docs/frontend.md "A disk's surface"): a qcow2's clusters counted from its L2
// tables (web/qcow2.ts `allocation`, `readAllocation`) at 64 KiB and 512-byte clusters, a range block by block; the
// tables read once from a local image, from a remote one only where the block cache keeps them (nothing fetched),
// and not past `ALLOCATION_MAX`; a remote raw image's blocks kept in this browser; blk's `inspect` over each; the
// job worker's answer from a file (web/app/surface-job.ts) and the page's handle check, which never asks
// (surface-source.ts `jobOf`). The qcow2s are made by tests/qcow2-make.ts.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cachedSource } from '../web/blockcache.ts';
import { blk, type Ctx, type Source } from '../web/devices.ts';
import { blockStore } from '../web/diskcache.ts';
import { memFile } from '../web/overlay.ts';
import { ALLOCATION_MAX, openDisk, readAllocation } from '../web/qcow2.ts';
import { allocationCounts, imageLayer, keptUnits, rangeDetail, type InspectAnswer, type Surface } from '../web/surface.ts';
import { surfaceJob } from '../web/app/surface-job.ts';
import { jobOf } from '../web/app/surface-source.ts';
import { detailLook, legendOf, lookOf, opaqueWords } from '../web/app/surface-look.ts';
import { RIM, STEPS } from '../web/app/ui/block-grid.ts';
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
  const layer = imageLayer({ kind: 'clusters', id: 'disk', size: SIZE, allocation: a }, 2 * RANGE);
  assert.deepEqual([layer.known, ...layer.held], ['counted', 48, 32]);
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
  assert.equal(d.allocation!(), undefined, 'no table read yet');
  assert.ok(await d.read(0, 4096));
  const a = d.allocation!();
  assert.ok(a, 'the one table, read by the request');
  const n = reads.length;
  assert.equal(d.allocation!(readerOf(bytes)), a, 'made once: the image never changes while open');
  assert.equal(reads.length, n);
  // A remote image through the block cache: its table is read for the map only once the cache holds its block.
  const fetched: [number, number][] = [];
  const src: Source = { size: bytes.length, read: (off, len) => (fetched.push([off, len]), readerOf(bytes)(off, len)) };
  const c = cachedSource(src, { block: cs, bytes: 64 * cs });
  const ctx = { ram: () => [new Uint8Array(MiB)] } as unknown as Ctx;
  const b = blk(ctx, c);
  const before = fetched.length; // the header and L1 at the opening
  const surface = async () => ((await b.inspect!({ kind: 'disk-surface', disk: 0, cells: 8 })) as Extract<InspectAnswer, { kind: 'disk-surface' }>).surface;
  const opaque = (await surface()).layers[0];
  assert.deepEqual([opaque.known, opaque.why], ['opaque', 'tables']);
  assert.equal(fetched.length, before, 'nothing fetched for the map');
  assert.equal(c.kept.has(l2At.get(0)! / cs), false);
  c.read(l2At.get(0)!, 8); // the guest's read brings the table's block
  const counted = (await surface()).layers[0];
  assert.deepEqual([counted.known, ...counted.held], ['counted', 32, 16, 16, 16]);
  // L1 entries that all name one table: more than ALLOCATION_MAX bytes of tables, so none are read.
  const huge = qcow2((ALLOCATION_MAX / (64 * 1024) + 1) * 512 * MiB, 16, new Map([[0, 'data']]), true);
  const hd = openDisk(readerOf(huge.bytes), huge.bytes.length);
  let loads = 0;
  assert.equal(hd.allocation!((off, len) => (loads++, readerOf(huge.bytes)(off, len))), undefined);
  assert.equal(loads, 0);
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
  assert.deepEqual([r.detail.blocks[0], r.detail.blocks[255], r.detail.blocks[256], r.detail.blocks[511], r.detail.blocks[512]], [1, 1, 5, 5, 1]);
  assert.deepEqual(r.detail.content, { read: 0, zeros: 0 }, 'a raw image\'s blocks are not read');
  assert.equal(fetched.length, n, 'nothing fetched for the map');
  // As the page draws it: kept squares in steps over the hatch, the legend says so, a range's kept blocks full.
  const look = lookOf(s);
  assert.deepEqual([...look.rim], [RIM.step(1), RIM.step(1)]);
  assert.deepEqual(legendOf({ disk: 'opaque', overlay: false, grown: false, live: true, kept: true }).map((e) => e.key.split('.').pop()), ['opaque', 'keptSome', 'kept', 'read', 'written']);
  assert.deepEqual(opaqueWords(d, true).map((m) => m.key), ['disks:surface-look.why.raw', 'disks:surface-look.keptAll', 'disks:surface-look.overOpaque']);
  const dl = detailLook(r.detail, true);
  assert.deepEqual([dl.rim[0], dl.rim[256]], [RIM.opaque, RIM.step(STEPS)]);
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
