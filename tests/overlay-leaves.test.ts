// The overlay's two-level map (web/overlay.ts, docs/devices.md "blk"): leaves of 1,024 entries made at the first
// write into their 4 MiB range, so the map file and memory grow with what's written; a flat map from before leaves
// read as it is and converted at the first change (an interrupted conversion still reads it); refused writes at a
// leaf's making; compaction, exports and the walk a snapshot makes across leaves.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chromium } from 'playwright-core';
import { startServer } from '../tools/serve.ts';
import { memFile, overlay, readMap, type SyncFile } from '../web/overlay.ts';
import { openDisk, readChanges } from '../web/qcow2.ts';
import { changedClusters, nonZeroClusters, writeQcow2, type Sink } from '../web/qcow2-write.ts';
import { blockSource, zeroDisk } from '../web/stored.ts';
import { splitmix64 } from '../tools/corpus/corpus.ts';

const BLOCK = 4096;
const LEAF = 1024; // a leaf's blocks
const RANGE = LEAF * BLOCK; // 4 MiB
const REC_BYTES = (LEAF + 2) * 4;
const HEAD = 16;
const same = (a: Uint8Array | undefined, b: Uint8Array) => !!a && Buffer.compare(a, b) === 0;

test('writes, zeroings, discards and reads across leaf boundaries match a model, across reopens', async () => {
  const g = splitmix64(23n);
  const rand = (n: number) => Number(g.next().value as bigint % BigInt(n));
  const size = 3 * RANGE + 3 * BLOCK + 512; // three leaves and part of a fourth, a partial last block
  const baseBytes = Uint8Array.from({ length: size }, (_, k) => 1 + ((k * 2654435761) >>> 24) % 255);
  const base = openDisk((off, len) => baseBytes.slice(off, off + len), size);
  const [data, map] = [memFile(), memFile()];
  let d = overlay(base, data, map);
  const model = baseBytes.slice();
  for (let i = 0; i < 600; i++) {
    // Near a boundary between ranges (or the disk's end), up to 64 KiB either side.
    const edge = [RANGE, 2 * RANGE, 3 * RANGE, size][rand(4)];
    const off = Math.max(0, Math.min(size - 512, edge - 65536 + rand(131072 / 512) * 512));
    const len = Math.min(size - off, (rand(rand(3) ? 24 : 300) + 1) * 512);
    const op = rand(6);
    if (op < 2) {
      const bytes = Uint8Array.from({ length: len }, () => rand(256));
      assert.ok(await d.write(off, bytes));
      model.set(bytes, off);
    } else if (op === 2) {
      assert.ok(await d.zero(off, len));
      model.fill(0, off, off + len);
    } else if (op === 3) {
      assert.ok(d.discard(off, len));
      const end = off + len === size ? Math.ceil(size / BLOCK) : Math.floor((off + len) / BLOCK);
      for (let b = Math.ceil(off / BLOCK); b < end; b++) if (d.zeroed(b)) model.fill(0, b * BLOCK, Math.min(size, (b + 1) * BLOCK));
    } else {
      assert.ok(same(await d.read(off, len), model.subarray(off, off + len)), `read ${off}+${len} at step ${i}`);
    }
    if (i % 150 === 149) d = overlay(base, data, map);
  }
  assert.ok(same(await d.read(0, size), model));
  assert.ok(same(await overlay(base, data, map).read(0, size), model), 'reopened');
  // The blocks written, in order, are the leaves' (and only those).
  const w = [...d.written()];
  assert.ok(w.every((b, k) => k === 0 || b > w[k - 1]), 'ascending');
  assert.equal(readMap(map, Math.ceil(size / BLOCK)).n, 4, 'a leaf per range written');
});

test('a write at the end of a 1 TiB overlay (and its start) leaves a map file of two leaves and little memory; its export and the walk a snapshot makes have just those blocks', async () => {
  const size = 2 ** 40;
  const blocks = size / BLOCK;
  const before = process.memoryUsage().arrayBuffers;
  const [data, map] = [memFile(), memFile()];
  const d = overlay(zeroDisk(64 << 20), data, map, undefined, size); // a 64 MiB disk grown to 1 TiB
  assert.equal(d.size, size);
  // GPT's primary header at the start, its backup at the end.
  assert.ok(await d.write(512, new Uint8Array(512).fill(0x11)));
  assert.ok(await d.write(size - 33 * 512, new Uint8Array(33 * 512).fill(0x22)));
  assert.ok(await d.zero(size - 64 * BLOCK, 4 * BLOCK));
  assert.ok(d.discard(size - 64 * BLOCK, BLOCK));
  const grew = process.memoryUsage().arrayBuffers - before;
  assert.ok(grew < 16 << 20, `${(grew / 2 ** 20).toFixed(1)} MiB of buffers (a flat map would be 1 GiB)`);
  assert.equal(map.getSize(), HEAD + 2 * REC_BYTES, 'the header and two leaves');
  const m = readMap(map, blocks);
  assert.equal(m.top.byteLength, (blocks / LEAF) * 4, 'the top table: 4 bytes per 4 MiB (1 MiB per TiB)');
  assert.ok(m.recs.byteLength <= 2 * REC_BYTES, 'two leaves in memory');
  const tail = [-64, -63, -62, -61, -5, -4, -3, -2, -1].map((k) => blocks + k);
  assert.deepEqual([...d.written()], [0, ...tail]);
  assert.deepEqual(tail.map((b) => d.zeroed(b)), [true, true, true, true, false, false, false, false, false]);
  const r = overlay(zeroDisk(64 << 20), data, map, undefined, size); // reopened
  assert.ok(same(await r.read(0, 1024), Uint8Array.from({ length: 1024 }, (_, k) => (k >= 512 ? 0x11 : 0))));
  assert.ok(same(await r.read(size - 33 * 512 - 512, 34 * 512), Uint8Array.from({ length: 34 * 512 }, (_, k) => (k >= 512 ? 0x22 : 0))));
  assert.deepEqual([...r.written()], [...d.written()]);
  // A changes-only qcow2 of it: those blocks, the zeroed ones as zero clusters, at the grown size.
  const parts: Uint8Array[] = [];
  const sink: Sink = (chunk, at) => { if (at === undefined) parts.push(chunk.slice()); else parts[0] = chunk.slice(); };
  await writeQcow2({ size, clusters: changedClusters(r), backing: { name: 'base.img', format: 'raw', hash: '00'.repeat(32) }, sink });
  const file = new Uint8Array(Buffer.concat(parts));
  const c = readChanges((off, len) => file.slice(off, off + len), file.length)!;
  assert.equal(c.size, size);
  const got: number[] = [];
  for await (const { block, data: bytes } of c.blocks()) {
    got.push(block);
    assert.ok(same(bytes, (await r.read(block * BLOCK, BLOCK))!), `block ${block} as the overlay reads it`);
  }
  assert.deepEqual(got, [...d.written()]);
  // A snapshot's walk (the device's `written` and `blocks`) into a fresh overlay, as a restore writes it: the same disk.
  const [data2, map2] = [memFile(), memFile()];
  const back = overlay({ size, format: 'raw', read: async () => undefined }, data2, map2);
  for (const b of [...r.written()]) assert.ok(r.zeroed(b) ? await back.zero(b * BLOCK, BLOCK) : await back.write(b * BLOCK, r.block(b)!));
  assert.deepEqual([...back.written()], [...r.written()]);
  for (const b of [...r.written()]) assert.ok(same(await back.read(b * BLOCK, BLOCK), (await r.read(b * BLOCK, BLOCK))!));
  assert.equal(map2.getSize(), HEAD + 2 * REC_BYTES);
});

test('a whole disk zeroed (a restore with the whole disk) makes its leaves in a few writes, every block zeros without a slot', async () => {
  const size = 600 * RANGE + 8 * BLOCK; // past 256 ranges (one write's), and part of one more
  const writes: number[] = [];
  const map = memFile();
  const counted = Object.assign(memFile(), { ...map, write: (b: Uint8Array, o: { at: number }) => { writes.push(b.length); return map.write(b, o); } });
  const d = overlay({ size, format: 'raw', read: async () => undefined }, memFile(), counted);
  assert.ok(await d.zero(0, size));
  assert.ok(writes.length <= 5, `${writes.length} map writes`);
  assert.equal([...d.written()].length, size / BLOCK);
  assert.ok([...d.written()].every((b) => d.zeroed(b)));
  assert.ok((await d.read(size - 3 * RANGE, 3 * RANGE))!.every((x) => x === 0));
});

/** A flat map (from before leaves) with its data: block `b` -> its slot's fill, or 'zero', for `blocks` blocks. */
function flatOverlay(blocks: number, mapped: Map<number, number | 'zero'>, slots: number, slotOf?: Map<number, number>) {
  const entries = new Uint32Array(Math.max(...mapped.keys()) + 1);
  const data = memFile();
  data.truncate(slots * BLOCK);
  let slot = 0;
  const free = new Set(Array.from({ length: slots }, (_, k) => k));
  for (const [b, v] of mapped) {
    if (v === 'zero') { entries[b] = 0xffffffff; continue; }
    if (slotOf?.has(b)) {
      const s = slotOf.get(b)!;
      free.delete(s);
      data.write(new Uint8Array(BLOCK).fill(v), { at: s * BLOCK });
      entries[b] = s + 1;
      continue;
    }
    while (!free.has(slot)) slot++;
    free.delete(slot);
    data.write(new Uint8Array(BLOCK).fill(v), { at: slot * BLOCK });
    entries[b] = slot + 1;
    slot += 2; // a free slot between each two
  }
  const map = memFile();
  map.write(new Uint8Array(entries.buffer), { at: 0 });
  return { data, map, blocks };
}

/** What a disk of `blocks` blocks over a base of 0x5a reads as with `mapped` (fills, or 'zero'). */
function modelOf(blocks: number, mapped: Map<number, number | 'zero'>) {
  const m = new Uint8Array(blocks * BLOCK).fill(0x5a);
  for (const [b, v] of mapped) m.fill(v === 'zero' ? 0 : v, b * BLOCK, (b + 1) * BLOCK);
  return m;
}

const fileBytes = (f: SyncFile) => { const b = new Uint8Array(f.getSize()); f.read(b, { at: 0 }); return b; };

test('a flat map from before leaves reads as it is without being changed, and the first change converts it: its leaves copied down, its free slots kept', async () => {
  const blocks = 10 * LEAF;
  const mapped = new Map<number, number | 'zero'>([[1, 0x11], [2, 'zero'], [5000, 0x22], [9000, 0x33]]);
  const { data, map } = flatOverlay(blocks, mapped, 6);
  const flat = fileBytes(map);
  const base = openDisk((off, len) => new Uint8Array(len).fill(0x5a), blocks * BLOCK);
  const model = modelOf(blocks, mapped);
  // Read only: the overlay and a stored disk's reader both read it, and the file is as it was.
  assert.ok(same(await overlay(base, data, map).read(0, blocks * BLOCK), model));
  const src = blockSource(data, map, blocks * BLOCK);
  assert.ok(same(src.read(5000 * BLOCK, BLOCK) as Uint8Array, model.subarray(5000 * BLOCK, 5001 * BLOCK)));
  assert.ok(same(fileBytes(map), flat), 'reading converts nothing');
  // A change: the header first, the three leaves copied down into the flat map's room, then a new leaf.
  const d = overlay(base, data, map);
  assert.ok(await d.write(7000 * BLOCK, new Uint8Array(BLOCK).fill(0x44)));
  model.fill(0x44, 7000 * BLOCK, 7001 * BLOCK);
  assert.equal(new DataView(fileBytes(map).buffer).getUint32(0, true), 0xfffffffe, 'a two-level map');
  assert.equal(map.getSize(), HEAD + 4 * REC_BYTES, 'three leaves converted, moved down, and one new');
  assert.equal(data.getSize(), 6 * BLOCK, 'the new block took a free slot');
  for (const disk of [d, overlay(base, data, map)]) assert.ok(same(await disk.read(0, blocks * BLOCK), model));
  assert.deepEqual([...d.written()], [1, 2, 5000, 7000, 9000]);
  assert.ok(same(blockSource(data, map, blocks * BLOCK).read(0, blocks * BLOCK) as Uint8Array, model.map((x) => (x === 0x5a ? 0 : x))), "a stored disk's reader reads the new format (over zeros)");
  // A dense flat map (its leaves don't fit in its room: three, the third with 5 entries): converted in place after it,
  // read the same.
  const dense = new Map<number, number | 'zero'>(Array.from({ length: 2 * LEAF + 5 }, (_, b) => [b, 1 + (b % 200)]));
  const f = flatOverlay(3 * LEAF, dense, (2 * LEAF + 5) * 2);
  const e = overlay(openDisk((off, len) => new Uint8Array(len).fill(0x5a), 3 * RANGE), f.data, f.map);
  assert.ok(await e.write(0, new Uint8Array(BLOCK).fill(9)));
  dense.set(0, 9);
  const flatBytes = (2 * LEAF + 5) * 4;
  assert.equal(f.map.getSize(), HEAD + Math.ceil((flatBytes - HEAD) / REC_BYTES) * REC_BYTES + 3 * REC_BYTES, 'the records after the flat map (a whole number of records past the header)');
  assert.ok(same(await overlay(openDisk((off, len) => new Uint8Array(len).fill(0x5a), 3 * RANGE), f.data, f.map).read(0, 3 * RANGE), modelOf(3 * LEAF, dense)));
});

/** A memory file that logs its writes and truncations (in order), to replay any prefix of them. */
function logging(f = memFile()) {
  const ops: ({ at: number; bytes: Uint8Array } | { truncate: number })[] = [];
  return Object.assign(f, {
    ops,
    write: ((w) => (buf: Uint8Array, o: { at: number }) => { ops.push({ at: o.at, bytes: buf.slice() }); return w(buf, o); })(f.write),
    truncate: ((t) => (size: number) => { ops.push({ truncate: size }); t(size); })(f.truncate),
  });
}
const replay = (start: Uint8Array, ops: ReturnType<typeof logging>['ops']) => {
  const f = memFile();
  f.write(start, { at: 0 });
  for (const op of ops) 'truncate' in op ? f.truncate(op.truncate) : f.write(op.bytes, { at: op.at });
  return f;
};

// Its last case: three leaves (ranges 0, 3, 4), moved down to 16. Until the last cut, a reading from 16 takes the file
// past them as records too; the fourth's range word is the flat map's entry 4106 (slot 7 + 1: range 7, which has no
// leaf), and its entries include block 3500's (slot 3), which range 7's block 7586 would read.
test('a conversion interrupted after any of its writes still reads the flat map, and the next change converts it; the blocks then trim and compact', async () => {
  for (const [what, mapped, slotOf] of [
    ['sparse (moved down)', new Map<number, number | 'zero'>([[1, 0x11], [2, 'zero'], [5000, 0x22], [9000, 0x33]]), undefined],
    ['dense (left after)', new Map<number, number | 'zero'>(Array.from({ length: 2 * LEAF + 5 }, (_, b) => [b, 1 + (b % 200)])), undefined],
    ['a few blocks (shorter than the header)', new Map<number, number | 'zero'>([[0, 0x11], [2, 0x12]]), undefined],
    ['moved down, a slot number where a record past them would have its range', new Map<number, number | 'zero'>([[1, 0x11], [3500, 0x22], [4106, 0x33]]), new Map([[1, 0], [3500, 3], [4106, 7]])],
  ] as const) {
    const blocks = 10 * LEAF;
    const { data, map } = flatOverlay(blocks, mapped, Math.max(2 * mapped.size + 2, 8), slotOf);
    const flat = fileBytes(map);
    const dataBytes = fileBytes(data);
    const base = openDisk((off, len) => new Uint8Array(len).fill(0x5a), blocks * BLOCK);
    const model = modelOf(blocks, mapped);
    const log = logging(replay(flat, []));
    assert.ok(await overlay(base, data, log).write(7000 * BLOCK, new Uint8Array(BLOCK).fill(0x44)));
    // The conversion's writes: all but the last (the new block's leaf, after its data).
    for (let k = 0; k < log.ops.length; k++) {
      // The map as a crash after k of its writes left it, the data as it was (the block's write comes after).
      const m = replay(flat, log.ops.slice(0, k));
      const dk = memFile();
      dk.write(dataBytes, { at: 0 });
      const all = (await overlay(base, dk, m).read(0, blocks * BLOCK))!;
      assert.ok(same(all, model), `${what}: after ${k} of ${log.ops.length} map writes, the disk reads otherwise`);
      const d = overlay(base, dk, m);
      assert.ok(await d.write(8000 * BLOCK, new Uint8Array(BLOCK).fill(0x55)), `${what}: a change after ${k}`);
      const want = model.slice().fill(0x55, 8000 * BLOCK, 8001 * BLOCK);
      assert.ok(same(await overlay(base, dk, m).read(0, blocks * BLOCK), want), `${what}: converted after ${k} of ${log.ops.length}`);
      assert.equal(new DataView(fileBytes(m).buffer).getUint32(0, true), 0xfffffffe, `${what}: two-level after ${k}`);
      // All but the last block it had trimmed, and the rest compacted: each block's entry moves with it.
      const keep = [...mapped.keys()].at(-1)!;
      for (const b of mapped.keys()) if (b !== keep) { assert.ok(d.discard(b * BLOCK, BLOCK)); want.fill(0, b * BLOCK, (b + 1) * BLOCK); }
      assert.ok(d.compact!(), `${what}: compacted after ${k}`);
      for (const disk of [d, overlay(base, dk, m)]) assert.ok(same(await disk.read(0, blocks * BLOCK), want), `${what}: trimmed and compacted after ${k} of ${log.ops.length}`);
    }
  }
});

test("a write the storage refuses at a leaf's making (nothing, part of its entries, all but its top entry) fails alone: no leaf, the slot free, the file cut back", async () => {
  for (const landed of [0, 1, 2048, 4095, 4096, 4097, 4100, 4103]) {
    const size = 8 * RANGE;
    const base = openDisk((off, len) => new Uint8Array(len).fill(7), size);
    const [data, inner] = [memFile(), memFile()];
    let refuse = false;
    const map = Object.assign(memFile(), {
      read: inner.read.bind(inner), getSize: inner.getSize.bind(inner), truncate: inner.truncate.bind(inner), flush: inner.flush.bind(inner),
      write: (buf: Uint8Array, o: { at: number }) => {
        if (!refuse || o.at + buf.length <= inner.getSize()) return inner.write(buf, o);
        return landed ? inner.write(buf.subarray(0, landed), o) : 0; // a short write: a prefix landed
      },
    });
    const d = overlay(base, data, map);
    assert.ok(await d.write(0, new Uint8Array(BLOCK).fill(1)));
    refuse = true;
    assert.equal(await d.write(3 * RANGE, new Uint8Array(2 * BLOCK).fill(2)), false, `${landed}: a whole run`);
    assert.equal(await d.write(5 * RANGE + 512, new Uint8Array(512).fill(3)), false, `${landed}: part of a block`);
    assert.equal(await d.zero(6 * RANGE, RANGE), false, `${landed}: a zeroing of a whole range`);
    assert.ok(await d.write(BLOCK, new Uint8Array(BLOCK).fill(4)), `${landed}: a write into the leaf there is lands`);
    assert.equal(inner.getSize(), HEAD + REC_BYTES, `${landed}: the file cut back to its one leaf`);
    for (const disk of [d, overlay(base, data, map)]) {
      const got = (await disk.read(0, size))!;
      for (const [b, want] of [[0, 1], [1, 4], [3 * LEAF, 7], [3 * LEAF + 1, 7], [5 * LEAF, 7], [6 * LEAF, 7]]) {
        assert.ok(got.subarray(b * BLOCK, (b + 1) * BLOCK).every((x) => x === want), `${landed}: block ${b} reads ${got[b * BLOCK]}, not ${want}`);
      }
    }
    refuse = false;
    assert.ok(await d.write(3 * RANGE, new Uint8Array(BLOCK).fill(5)));
    assert.ok(data.getSize() <= 3 * BLOCK, `${landed}: the refused writes' slots were free again (${data.getSize() / BLOCK} slots)`);
    assert.equal((await overlay(base, data, map).read(3 * RANGE, 1))![0], 5);
  }
});

test("a conversion the storage refuses fails the change, and leaves the flat map as it was", async () => {
  const blocks = 10 * LEAF;
  const mapped = new Map<number, number | 'zero'>([[1, 0x11], [5000, 0x22]]);
  const { data, map: inner } = flatOverlay(blocks, mapped, 4);
  const flat = fileBytes(inner);
  let refuse = true;
  const map = Object.assign(memFile(), {
    read: inner.read.bind(inner), getSize: inner.getSize.bind(inner), truncate: inner.truncate.bind(inner), flush: inner.flush.bind(inner),
    write: (buf: Uint8Array, o: { at: number }) => (refuse && o.at + buf.length > inner.getSize() ? inner.write(buf.subarray(0, 3), o) : inner.write(buf, o)),
  });
  const base = openDisk((off, len) => new Uint8Array(len).fill(0x5a), blocks * BLOCK);
  const d = overlay(base, data, map);
  assert.equal(await d.write(1 * BLOCK, new Uint8Array(BLOCK).fill(9)), false, 'refused');
  assert.ok(same(fileBytes(inner), flat), 'the flat map as it was');
  assert.ok(same(await overlay(base, data, map).read(0, blocks * BLOCK), modelOf(blocks, mapped)));
  refuse = false;
  assert.ok(await d.write(1 * BLOCK, new Uint8Array(BLOCK).fill(9)), 'with room');
  mapped.set(1, 9);
  assert.ok(same(await overlay(base, data, map).read(0, blocks * BLOCK), modelOf(blocks, mapped)));
});

/** `f` with the reads `short` picks coming back one byte short (an I/O error, a read cut off). */
const shortReads = (f: SyncFile, short: (at: number, len: number) => boolean): SyncFile => ({
  ...f,
  read: (buf, o) => (short(o.at, buf.length) ? Math.max(0, f.read(buf.subarray(0, buf.length - 1), o)) : f.read(buf, o)),
});

test("a map that reads back short refuses the opening (an overlay's, a stored disk's reader's), rather than reading as empty", async () => {
  const size = 8 * RANGE;
  const unreadable = (e: unknown) => (e as { msg?: { key: string } }).msg?.key === 'disks:overlay.mapUnreadable';
  // A two-level map: three leaves.
  const [data, map] = [memFile(), memFile()];
  const d = overlay(zeroDisk(size), data, map);
  for (const r of [0, 3, 5]) assert.ok(await d.write(r * RANGE, new Uint8Array(BLOCK).fill(r + 1)));
  // A flat one: entries up to block 5000.
  const flat = flatOverlay(8 * LEAF, new Map<number, number | 'zero'>([[1, 0x11], [5000, 0x22]]), 4);
  for (const [what, m, short] of [
    ['the records', map, (at: number) => at >= HEAD],
    ['the header', map, (at: number) => at === 0],
    ['a flat map', flat.map, () => true],
  ] as const) {
    const f = shortReads(m, short);
    assert.throws(() => overlay(zeroDisk(size), what === 'a flat map' ? flat.data : data, f), unreadable, `${what}: the overlay`);
    assert.throws(() => blockSource(data, f, size), unreadable, `${what}: a stored disk's reader`);
  }
  assert.equal((await overlay(zeroDisk(size), data, map).read(5 * RANGE, 1))![0], 6, 'read whole, the map is as it was');
});

test("the blocks written are walked, not listed; a whole export of a stored disk reads the blocks it holds, not its size", async () => {
  // 16 GiB zeroed: 4 Mi blocks, which a list would hold in 32 MB.
  const size = 16 * 2 ** 30;
  const z = overlay(zeroDisk(size), memFile(), memFile());
  assert.ok(await z.zero(0, size));
  const before = process.memoryUsage().heapUsed;
  const it = z.written()[Symbol.iterator]();
  const first = [it.next().value, it.next().value, it.next().value];
  const grew = process.memoryUsage().heapUsed - before;
  assert.deepEqual(first, [0, 1, 2]);
  assert.ok(grew < 8 << 20, `${(grew / 2 ** 20).toFixed(1)} MiB of heap for the first blocks`);
  // A stored disk of 1 GiB with two blocks (one zeros) and a block zeroed: a qcow2 export of it whole.
  const gib = 2 ** 30;
  const [data, inner] = [memFile(), memFile()];
  const store = overlay(zeroDisk(gib), data, inner);
  assert.ok(await store.write(5 * BLOCK, new Uint8Array(BLOCK).fill(1)));
  assert.ok(await store.write(6 * BLOCK, new Uint8Array(BLOCK)));
  assert.ok(await store.write(gib - BLOCK, new Uint8Array(BLOCK).fill(2)));
  assert.ok(await store.zero(9 * BLOCK, BLOCK));
  const src = blockSource(data, inner, gib);
  let reads = 0;
  const disk = openDisk((off, len) => { reads++; return src.read(off, len); }, gib);
  const opening = reads; // the format's detection
  const got: number[] = [];
  for await (const c of nonZeroClusters(disk, 1 << 20, undefined, src.held?.())) got.push(c.index);
  assert.deepEqual(got, [5, gib / BLOCK - 1]);
  assert.ok(reads - opening <= 2, `${reads - opening} reads of the disk (its held blocks: two runs)`);
});

test('a compaction moves blocks across leaves: their entries in each leaf follow, reopened too', async () => {
  const size = 4 * RANGE;
  const base = openDisk((off, len) => new Uint8Array(len), size);
  const [data, map] = [memFile(), memFile()];
  const d = overlay(base, data, map);
  const at = (k: number) => (k % 4) * LEAF + Math.floor(k / 4) * 3; // blocks spread over the four leaves, in turn
  for (let k = 0; k < 300; k++) assert.ok(await d.write(at(k) * BLOCK, new Uint8Array(BLOCK).fill(1 + (k % 250))));
  // The first 250 written trimmed: the 50 left are in the highest slots, and move down into the leaves' freed ones.
  for (let k = 0; k < 250; k++) assert.ok(d.discard(at(k) * BLOCK, BLOCK));
  assert.ok(data.getSize() <= 64 * BLOCK, `${data.getSize() / BLOCK} slots for 50 blocks`);
  for (const disk of [d, overlay(base, data, map)]) {
    for (let k = 0; k < 300; k++) {
      const got = (await disk.read(at(k) * BLOCK, BLOCK))!;
      const want = k < 250 ? 0 : 1 + (k % 250);
      assert.ok(got.every((x) => x === want), `block ${at(k)} reads ${got[0]}, not ${want}`);
    }
  }
});

test('a crash after any single OPFS write, with writes across leaves and leaves made, leaves every block as the base or something the guest wrote', async () => {
  const size = 3 * RANGE;
  const base = openDisk((off, len) => new Uint8Array(len).fill(0xee), size);
  const ops: { file: 'data' | 'map'; op: ReturnType<typeof logging>['ops'][number] }[] = [];
  /** A memory file whose writes and truncations go into `ops`, in the order made across both files. */
  const logged = (file: 'data' | 'map') => {
    const f = memFile();
    return Object.assign(f, {
      write: ((w) => (buf: Uint8Array, o: { at: number }) => { ops.push({ file, op: { at: o.at, bytes: buf.slice() } }); return w(buf, o); })(f.write),
      truncate: ((t) => (size: number) => { ops.push({ file, op: { truncate: size } }); t(size); })(f.truncate),
    });
  };
  const d = overlay(base, logged('data'), logged('map'));
  // Runs of one tag each across the boundaries (a leaf made in the middle of a run), singles, overwrites.
  const ranges: [number, number][] = [[LEAF - 4, 8], [2 * LEAF - 1, 3], [LEAF - 2, 2], [10, 1], [2 * LEAF + 5, 600]];
  for (const [i, [b, len]] of ranges.entries()) assert.ok(await d.write(b * BLOCK, new Uint8Array(len * BLOCK).fill(i + 1)));
  assert.ok(ops.some((o) => o.file === 'map' && 'bytes' in o.op && o.op.bytes.length === REC_BYTES), 'leaves made');
  const tags = new Set([0xee, ...ranges.map((_, i) => i + 1)]);
  for (let k = 0; k <= ops.length; k++) {
    const files = { data: memFile(), map: memFile() };
    for (const { file, op } of ops.slice(0, k)) 'truncate' in op ? files[file].truncate(op.truncate) : files[file].write(op.bytes, { at: op.at });
    const all = (await overlay(base, files.data, files.map).read(0, size))!;
    for (let b = 0; b < size / BLOCK; b++) {
      const x = all.subarray(b * BLOCK, (b + 1) * BLOCK);
      assert.ok(tags.has(x[0]) && x.every((y) => y === x[0]), `after ${k} of ${ops.length} writes, block ${b} is neither the base nor a written block`);
    }
  }
});

test('in Chromium (OPFS, sync handles in a worker): a flat map read through read-only handles as it is, converted by a writable opening; a write at the end of 1 TiB', async () => {
  const server = await startServer();
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium' });
  try {
    const page = await (await browser.newContext()).newPage();
    await page.goto(`http://127.0.0.1:${(server.address() as { port: number }).port}/tests/browser/core.html`);
    const src = `
      const { openOverlay, overlay } = await import('ORIGIN/web/overlay.ts');
      const BLOCK = 4096, size = 16 << 20;
      const base = { size, format: 'raw', read: async (o, l) => new Uint8Array(l).fill(0x5a) };
      const name = 'overlays/leaves-flat';
      // A flat map as pages before leaves wrote it: block 1 in slot 0, block 3000 in slot 1, block 2 zeros.
      let f = await openOverlay(name, 'flat-base');
      f.data.write(new Uint8Array(BLOCK).fill(0x11), { at: 0 });
      f.data.write(new Uint8Array(BLOCK).fill(0x22), { at: BLOCK });
      const entries = new Uint32Array(3001);
      entries[1] = 1; entries[2] = 0xffffffff; entries[3000] = 2;
      f.map.write(new Uint8Array(entries.buffer), { at: 0 });
      f.data.flush(); f.map.flush();
      f.close();
      const sum = async (d) => { const b = await d.read(0, size); const at = (k) => b[k * BLOCK]; return [at(0), at(1), at(2), at(3000), at(3001)]; };
      const r = await openOverlay(name, undefined, undefined, { readOnly: true });
      const readOnly = await sum(overlay(base, r.data, r.map));
      const flatSize = r.map.getSize();
      r.close();
      f = await openOverlay(name, 'flat-base');
      const d = overlay(base, f.data, f.map, f.meta);
      const ok = await d.write(2000 * BLOCK, new Uint8Array(BLOCK).fill(0x33));
      const head = new Uint32Array(1); f.map.read(new Uint8Array(head.buffer), { at: 0 });
      const converted = { ok, magic: head[0], mapSize: f.map.getSize(), blocks: await sum(overlay(base, f.data, f.map, f.meta)), at2000: (await d.read(2000 * BLOCK, 1))[0] };
      f.close();
      // 1 TiB, GPT's backup header at its end.
      const big = 2 ** 40;
      const g = await openOverlay('overlays/leaves-big', 'big-base');
      const e = overlay({ size: 1 << 20, format: 'raw', read: async (o, l) => new Uint8Array(l) }, g.data, g.map, g.meta, big);
      const okBig = await e.write(big - 33 * 512, new Uint8Array(33 * 512).fill(0x44));
      const bigMap = g.map.getSize();
      const back = (await overlay({ size: 1 << 20, format: 'raw', read: async (o, l) => new Uint8Array(l) }, g.data, g.map, g.meta, big).read(big - 512, 512))[0];
      g.close();
      postMessage({ readOnly, flatSize, converted, okBig, bigMap, back });`;
    const got = await page.evaluate(async (src) => {
      const w = new Worker(URL.createObjectURL(new Blob([src.replaceAll('ORIGIN', location.origin)], { type: 'text/javascript' })), { type: 'module' });
      return await new Promise((resolve, reject) => { w.onmessage = (e) => resolve(e.data); w.onerror = (e) => reject(new Error(e.message)); });
    }, src) as { readOnly: number[]; flatSize: number; converted: { ok: boolean; magic: number; mapSize: number; blocks: number[]; at2000: number }; okBig: boolean; bigMap: number; back: number };
    assert.deepEqual(got.readOnly, [0x5a, 0x11, 0, 0x22, 0x5a], 'read-only: the flat map as it is');
    assert.equal(got.flatSize, 3001 * 4, 'not converted');
    // Two leaves converted (blocks 1-2, 3000) and moved down into the flat map's room, one new (2000).
    assert.deepEqual(got.converted, { ok: true, magic: 0xfffffffe, mapSize: HEAD + 3 * REC_BYTES, blocks: [0x5a, 0x11, 0, 0x22, 0x5a], at2000: 0x33 });
    assert.ok(got.okBig);
    assert.equal(got.bigMap, HEAD + REC_BYTES, "1 TiB's last 4 MiB: a header and one leaf");
    assert.equal(got.back, 0x44);
  } finally {
    await browser.close();
    server.close();
  }
});
