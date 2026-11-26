// Changes in (web/changes.ts, web/qcow2.ts `readChanges`): a changes file written by Save disk goes
// back into an overlay over its base (the disk comes out as it was saved), replacing what the
// overlay held; a different base, a size mismatch and a qcow2 from another tool are refused before
// the overlay is touched; and a changes file from qemu-img (64 KiB clusters, zero clusters) reads
// block by block, compressed ones too. In Node the overlay lives in memory. The qemu-img parts skip without it.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { splitmix64 } from '../tools/corpus/corpus.ts';
import { changesInto, hashSource, loadChanges } from '../web/changes.ts';
import type { Source } from '../web/disk-sources.ts';
import { msgOf } from '../web/msg.ts';
import { memFile, openOverlay, overlay } from '../web/overlay.ts';
import { openDisk, readChanges } from '../web/qcow2.ts';
import { changedClusters, writeQcow2, type Sink } from '../web/qcow2-write.ts';
import { loggedFiles } from './logged-files.ts';

const have = spawnSync('qemu-img', ['--version']).status === 0 && spawnSync('qemu-io', ['--version']).status === 0;

let dir: string;
before(() => { dir = mkdtempSync(join(tmpdir(), 'waarm64-changes-')); });
after(() => { if (dir) rmSync(dir, { recursive: true }); });

const source = (b: Uint8Array): Source => ({ size: b.length, read: (off, len) => (off + len <= b.length ? b.slice(off, off + len) : undefined) });
const SIZE = 300 * 4096 + 1000; // a last block that isn't whole

function randomBase(seed: bigint, size = SIZE) {
  const g = splitmix64(seed);
  return Uint8Array.from({ length: size }, () => Number(g.next().value as bigint & 255n));
}

/** What Save disk makes: the changes of `writes` (offset, bytes) over `base`, named `base.img`. */
async function changesFile(base: Uint8Array, writes: [number, Uint8Array][], compress = false) {
  const rw = overlay(openDisk((o, l) => base.slice(o, o + l), base.length), memFile(), memFile());
  for (const [off, bytes] of writes) assert.ok(await rw.write(off, bytes));
  const parts: Uint8Array[] = [];
  const sink: Sink = (chunk, at) => { if (at === undefined) parts.push(chunk); else parts[0] = chunk; };
  await writeQcow2({ size: base.length, clusters: changedClusters(rw), backing: { name: 'base.img', format: 'raw', hash: await hashSource(source(base), () => {}) }, compress, sink });
  return Buffer.concat(parts);
}

const ident = (n: string) => `identity-${n}`;
async function mergedOf(name: string, base: Uint8Array) {
  const files = await openOverlay(name, ident(name));
  try {
    return await overlay(openDisk((o, l) => base.slice(o, o + l), base.length), files.data, files.map).read(0, base.length);
  } finally {
    files.close();
  }
}
const load = (name: string, changes: Uint8Array, base: Uint8Array) =>
  loadChanges({ changes: source(changes), base: source(base), label: 'the page disk', overlay: name, identity: ident(name) });

test('loading a changes file gives the overlay the saved disk, and replaces what it held', async () => {
  const base = randomBase(1n);
  const marks: [number, Uint8Array][] = [[5000, Uint8Array.of(1, 2, 3)], [SIZE - 700, new Uint8Array(700).fill(9)], [4096 * 40, new Uint8Array(4096)]];
  const merged = base.slice();
  for (const [off, b] of marks) merged.set(b, off);
  const file = await changesFile(base, marks);
  // The overlay already holds a block the changes don't: it must go.
  const old = await openOverlay('page', ident('page'));
  assert.ok(await overlay(openDisk((o, l) => base.slice(o, o + l), base.length), old.data, old.map).write(4096 * 7, Uint8Array.of(0xee)));
  old.close();
  const r = await load('page', file, base);
  assert.equal(r.blocks, 3);
  assert.deepEqual(await mergedOf('page', base), merged);
});

test('a compressed changes file loads the same disk, from a smaller file', async () => {
  const base = randomBase(4n);
  const g = splitmix64(5n);
  const noise = Uint8Array.from({ length: 4096 }, () => Number(g.next().value as bigint & 255n)); // stored as it is, among compressed ones
  const marks: [number, Uint8Array][] = [[0, new Uint8Array(3 * 4096).fill(0x61)], [4096 * 3, noise], [4096 * 4, new Uint8Array(8192)], [4096 * 90 + 17, Uint8Array.of(1, 2, 3)], [SIZE - 700, new Uint8Array(700).fill(9)]];
  const merged = base.slice();
  for (const [off, b] of marks) merged.set(b, off);
  const plain = await changesFile(base, marks);
  const file = await changesFile(base, marks, true);
  assert.ok(file.length < plain.length, `compressed ${file.length} bytes, not compressed ${plain.length}`);
  const r = await load('packed', file, base);
  assert.equal(r.blocks, 8);
  const got = await mergedOf('packed', base);
  assert.ok(got && Buffer.compare(got, merged) === 0, 'the overlay holds another disk');
});

test('blocks the guest discarded or zeroed come back as zeros without slots', async () => {
  const base = randomBase(6n);
  const rw = overlay(openDisk((o, l) => base.slice(o, o + l), base.length), memFile(), memFile());
  const merged = base.slice();
  for (const b of [10, 11, 12]) { assert.ok(await rw.write(b * 4096, new Uint8Array(4096).fill(b))); merged.fill(b, b * 4096, (b + 1) * 4096); }
  assert.ok(rw.discard(11 * 4096, 4096));
  merged.fill(0, 11 * 4096, 12 * 4096);
  assert.ok(await rw.zero(299 * 4096, SIZE - 299 * 4096)); // to the end: the last block isn't whole
  merged.fill(0, 299 * 4096);
  for (const compress of [false, true]) {
    const parts: Uint8Array[] = [];
    const sink: Sink = (chunk, at) => { if (at === undefined) parts.push(chunk); else parts[0] = chunk; };
    await writeQcow2({ size: base.length, clusters: changedClusters(rw), backing: { name: 'base.img', format: 'raw', hash: await hashSource(source(base), () => {}) }, compress, sink });
    const name = `zeros-${compress}`;
    assert.equal((await load(name, Buffer.concat(parts), base)).blocks, 5);
    const got = await mergedOf(name, base);
    assert.ok(got && Buffer.compare(got, merged) === 0, 'the overlay holds another disk');
    const files = await openOverlay(name, ident(name));
    try {
      const d = overlay(openDisk((o, l) => base.slice(o, o + l), base.length), files.data, files.map);
      assert.deepEqual([...d.written()].map((b) => [b, d.zeroed(b)]), [[10, false], [11, true], [12, false], [299, true], [300, true]]);
      assert.equal(files.data.getSize(), 2 * 4096);
    } finally {
      files.close();
    }
  }
});

test('a different base, a different size and a qcow2 without our checksum are refused, the overlay untouched', async () => {
  const base = randomBase(2n);
  const file = await changesFile(base, [[100, Uint8Array.of(7)]]);
  const first = await load('guarded', file, base);
  assert.equal(first.blocks, 1);
  const before = await mergedOf('guarded', base);

  const other = base.slice();
  other[SIZE - 1] ^= 1;
  const said = (key: string, params?: Record<string, unknown>) => (e: unknown) => msgOf(e)?.key === key && Object.entries(params ?? {}).every(([k, v]) => (v instanceof RegExp ? v.test(String(msgOf(e)?.params?.[k])) : msgOf(e)?.params?.[k] === v));
  await assert.rejects(load('guarded', file, other), said('disks:changes.otherBase', { backing: 'base.img', hash: /^[0-9a-f]{12}$/, label: 'the page disk', baseHash: /^[0-9a-f]{12}$/ }));
  // A base smaller than the changes may be a grown overlay's (docs/machines.md §4.5): its hash tells it isn't this one's.
  await assert.rejects(load('guarded', file, base.subarray(0, SIZE - 4096)), said('disks:changes.otherBase', { backing: 'base.img', label: 'the page disk' }));
  const larger = new Uint8Array(SIZE + 4096);
  larger.set(base);
  await assert.rejects(load('guarded', file, larger), said('disks:changes.otherSize', { size: SIZE, label: 'the page disk', baseSize: SIZE + 4096 }));
  await assert.rejects(load('guarded', base, base), said('disks:changes.notChanges'));
  // A changes file from before the hash was of slices ("WAM1": the whole file's SHA-256) has no hash we check.
  const old = Buffer.from(file);
  const at = old.subarray(0, 4096).indexOf('WAM2');
  assert.ok(at > 0);
  old.write('WAM1', at);
  await assert.rejects(load('guarded', old, base), said('disks:changes.notOurs'));
  assert.deepEqual(await mergedOf('guarded', base), before);
});

test('a changes file from qemu-img: 64 KiB clusters, a zero cluster, data and unallocated space read block by block', { skip: !have && 'SKIPPED: no qemu-img/qemu-io' }, async () => {
  const base = randomBase(3n, 1 << 20);
  writeFileSync(join(dir, 'b.raw'), base);
  const run = (cmd: string, ...args: string[]) => { const r = spawnSync(cmd, args, { encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); };
  run('qemu-img', 'create', '-q', '-f', 'qcow2', '-b', 'b.raw', '-F', 'raw', '-o', 'cluster_size=65536', join(dir, 'c.qcow2'));
  run('qemu-io', '-f', 'qcow2', '-c', 'write -P 0xab 70000 5000', '-c', 'write -z 262144 65536', join(dir, 'c.qcow2'));
  const bytes = readFileSync(join(dir, 'c.qcow2'));
  const c = readChanges((o, l) => (o + l <= bytes.length ? bytes.subarray(o, o + l) : undefined), bytes.length)!;
  assert.equal(c.backingName, 'b.raw');
  assert.equal(c.hash, undefined); // not ours
  assert.equal(c.size, 1 << 20);
  const got = new Map<number, Uint8Array>();
  for await (const { block, data } of c.blocks()) got.set(block, data);
  // qemu-io wrote one cluster of data (the 64 KiB cluster 1, merged with the base around the write) and a zero one.
  assert.equal([...got.keys()].filter((b) => b >= 16 && b < 32).length, 16);
  assert.ok(got.get(70000 >> 12)!.subarray(70000 & 4095).every((x) => x === 0xab));
  assert.ok(got.get(64)!.every((x) => x === 0), 'the zero cluster reads as zeros');
  assert.equal(got.size, 32);
});

test('a compressed changes file from qemu-img (64 KiB clusters) reads block by block', { skip: !have && 'SKIPPED: no qemu-img/qemu-io' }, async () => {
  const base = Uint8Array.from({ length: 1 << 20 }, (_, i) => 97 + (i * 7 + (i >> 9)) % 23); // it shrinks: qemu-img stores it compressed
  const merged = base.slice();
  merged.fill(0x5a, 70000, 75000);
  merged.fill(0, 262144, 262144 + 65536);
  writeFileSync(join(dir, 'pb.raw'), base);
  writeFileSync(join(dir, 'pm.raw'), merged);
  const r = spawnSync('qemu-img', ['convert', '-c', '-O', 'qcow2', '-B', 'pb.raw', '-F', 'raw', 'pm.raw', 'pc.qcow2'], { cwd: dir, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const bytes = readFileSync(join(dir, 'pc.qcow2'));
  const c = readChanges((o, l) => (o + l <= bytes.length ? bytes.subarray(o, o + l) : undefined), bytes.length)!;
  assert.equal(c.backingName, 'pb.raw');
  const got = base.slice();
  let blocks = 0;
  for await (const { block, data } of c.blocks()) { got.set(data, block * 4096); blocks++; }
  assert.ok(bytes.length < 1 << 19, `${bytes.length} bytes: not compressed`); // convert copies the base's clusters too
  assert.equal(blocks, 256);
  assert.ok(Buffer.compare(got, merged) === 0, 'the base plus the blocks is another disk');
});

test('a changes file loads in runs: its consecutive data clusters one read, consecutive blocks of one kind one write or zeroing (up to 1 MiB), unordered, both files flushed at its end', async () => {
  const size = 1100 * 4096 + 1000; // across a leaf (1,024 blocks), the last block not whole
  const base = randomBase(9n, size);
  const marks: [number, Uint8Array][] = [];
  const fill = (b: number, n: number, v: number) => marks.push([b * 4096, new Uint8Array(Math.min(n * 4096, size - b * 4096)).fill(v)]);
  fill(10, 300, 0x31); // longer than a run: 256 + 44
  fill(310, 5, 0); // zeros right after: a zeroing of their own
  fill(315, 2, 0x32); // data again
  fill(400, 1, 0x33); // a lone block after a gap
  fill(1000, 40, 0x34); // across the leaf's end
  fill(1099, 1, 0x35); // the last block, partial
  const merged = base.slice();
  for (const [off, b] of marks) merged.set(b, off);
  const file = await changesFile(base, marks);
  let reads = 0;
  const c = readChanges((o, l) => (reads++, o + l <= file.length ? file.subarray(o, o + l) : undefined), file.length)!;
  const f = loggedFiles();
  const disk = openDisk((o, l) => base.slice(o, o + l), size);
  const r = await changesInto(c.blocks(), disk, f, async (w) => w());
  assert.equal(r.blocks, 300 + 5 + 2 + 1 + 40 + 1);
  assert.equal(r.calls, 2 + 1 + 1 + 1 + 1 + 1, `${r.calls} calls`); // 300 = 256 + 44; 1000..1039 one write over two leaves
  assert.ok(reads <= 12, `${reads} reads of the file: its consecutive data clusters are one read (up to 1 MiB)`); // the header, L1, three L2 tables, five runs
  assert.equal(f.flushes('data'), 1, 'unordered: one data flush, at the end');
  assert.equal(f.unflushed('data'), 0, 'the data flushed after its last write');
  assert.equal(f.unflushed('map'), 0, 'the map flushed after its last write');
  const got = await overlay(disk, f.data, f.map).read(0, size);
  assert.ok(got && Buffer.compare(got, merged) === 0, 'the overlay holds another disk');
  for (let b = 310; b < 315; b++) assert.ok(overlay(disk, f.data, f.map).zeroed!(b), `block ${b} zeros without a slot`);
});

/** The bytes overlay `name` holds at block `b` (its first byte), as a writer's opening reads it, or undefined for none. */
async function heldAt(name: string, base: Uint8Array, b: number) {
  const files = await openOverlay(name, ident(name));
  try {
    const d = overlay(openDisk((o, l) => base.slice(o, o + l), base.length), files.data, files.map);
    return [...d.written()].includes(b) ? (await d.read(b * 4096, 1))![0] : undefined;
  } finally {
    files.close();
  }
}

// Review disk-writes 2: a file whose tables lie past its end passes the header's checks; the overlay (the page's own
// disk: a fixed name) was deleted before the blocks were read, and "The disk is unchanged" wasn't true.
test("a changes file cut short (its tables past its end) is refused before the overlay is touched: the disk's own blocks stay", async () => {
  const base = randomBase(11n);
  const old = await openOverlay('cut-short', ident('cut-short'));
  assert.ok(await overlay(openDisk((o, l) => base.slice(o, o + l), base.length), old.data, old.map).write(9 * 4096, new Uint8Array(4096).fill(0xee)));
  old.close();
  const file = await changesFile(base, [[100 * 4096, new Uint8Array(4096).fill(5)]]);
  const cut = file.subarray(0, 2 * 4096); // the header and the data cluster: the L1 and L2 tables are past its end
  await assert.rejects(load('cut-short', cut, base), (e: unknown) => msgOf(e)?.key === 'disks:qcow2.changesTruncated' && !(e as { cleared?: boolean }).cleared);
  assert.equal(await heldAt('cut-short', base, 9), 0xee, "the overlay's block 9 is as it was");
});

// What fails once the overlay was emptied (the file unreadable part way, the storage full, a cluster that doesn't
// unpack): the error says so (`cleared`), and the half-loaded overlay is marked, so it opens empty.
test('a changes file whose blocks fail to read part way leaves the overlay empty, not half loaded, and says it was cleared', async () => {
  const base = randomBase(12n);
  // Three runs: the first is written once the second is read, and the third's read fails.
  const marks: [number, Uint8Array][] = [[10 * 4096, new Uint8Array(4096).fill(1)], [200 * 4096, new Uint8Array(4096).fill(2)], [250 * 4096, new Uint8Array(4096).fill(3)]];
  const file = await changesFile(base, marks);
  let reads = 0;
  const counted: Source = { size: file.length, read: (o, l) => (reads++, o + l <= file.length ? file.slice(o, o + l) : undefined) };
  await loadChanges({ changes: counted, base: source(base), label: 'x', overlay: 'half', identity: ident('half') });
  const all = reads; // its last read is the third run's data
  const old = await openOverlay('half', ident('half'));
  assert.ok(await overlay(openDisk((o, l) => base.slice(o, o + l), base.length), old.data, old.map).write(9 * 4096, new Uint8Array(4096).fill(0xee)));
  old.close();
  reads = 0;
  const failing: Source = { size: file.length, read: (o, l) => (++reads >= all ? undefined : o + l <= file.length ? file.slice(o, o + l) : undefined) };
  await assert.rejects(
    loadChanges({ changes: failing, base: source(base), label: 'x', overlay: 'half', identity: ident('half') }),
    (e: unknown) => (e as { cleared?: boolean }).cleared === true,
  );
  assert.equal(await heldAt('half', base, 10), undefined, 'the first run, written before the failure, is not read as the disk');
  assert.equal(await heldAt('half', base, 9), undefined, 'what the overlay held was deleted (the error said so)');
});

// Review disk-writes 8: a qcow2 base's file may be larger than its virtual size (its tables, preallocation).
test("a changes file over a qcow2 base whose file is larger than its virtual size loads (the base's virtual size is what it is checked against)", async () => {
  const size = 4 * 4096;
  const raw = randomBase(13n, size);
  const parts: Uint8Array[] = [];
  const sink: Sink = (chunk, at) => { if (at === undefined) parts.push(chunk); else parts[0] = chunk; };
  const all = overlay(openDisk((o, l) => raw.slice(o, o + l), size), memFile(), memFile());
  assert.ok(await all.write(0, raw)); // every block: the qcow2 holds every cluster
  await writeQcow2({ size, clusters: changedClusters(all), sink });
  const q = Buffer.concat(parts);
  assert.ok(q.length > size, `the qcow2's file (${q.length} bytes) is larger than its disk (${size})`);
  const disk = openDisk((o, l) => q.slice(o, o + l), q.length);
  assert.equal(disk.size, size);
  const rw = overlay(disk, memFile(), memFile());
  assert.ok(await rw.write(4096, new Uint8Array(4096).fill(0x42)));
  const out: Uint8Array[] = [];
  const sink2: Sink = (chunk, at) => { if (at === undefined) out.push(chunk); else out[0] = chunk; };
  await writeQcow2({ size, clusters: changedClusters(rw), backing: { name: 'base.qcow2', format: 'qcow2', hash: await hashSource(source(q), () => {}) }, sink: sink2 });
  const r = await loadChanges({ changes: source(Buffer.concat(out)), base: source(q), label: 'x', overlay: 'over-qcow2', identity: ident('over-qcow2') });
  assert.equal(r.blocks, 1);
  assert.equal(await heldAt('over-qcow2', q, 1), 0x42);
});

// Review cut-jobs 3: the worker opened the base outside the chain that posts failures, so a base that couldn't be
// opened (a URL disk offline, a stored disk in use or gone) posted nothing, and the page waited for good.
test("Import changes' worker posts the failure when the disk's base can't be opened, as any other", async () => {
  const posted: { type: string; error?: unknown }[] = [];
  const g = globalThis as Record<string, unknown>;
  const had = g.self;
  g.self = { postMessage: (m: { type: string }) => posted.push(m) } as unknown;
  try {
    await import('../web/app/import-worker.ts');
    const worker = g.self as { onmessage: (e: { data: unknown }) => Promise<void> };
    // A ramdisk has nothing to read outside its machine: `openSource` refuses it, as it would a base that is gone.
    await worker.onmessage({ data: { changes: new Blob([]), disk: { source: { ramdisk: 4096 }, overlay: 'none' }, label: 'x' } });
    assert.deepEqual(posted.map((m) => m.type), ['error']);
  } finally {
    g.self = had;
  }
});

// Review cut-jobs 6: `check` passed an L1 entry past the disk's end whose L2 table lies past the file's end, and the
// load then read that table after the overlay was emptied (it named nothing of the disk).
test("a changes file whose spare L1 entries (past the disk's end) name tables past its end loads: they name nothing of the disk", async () => {
  const base = randomBase(13n);
  const file = Buffer.from(await changesFile(base, [[100 * 4096, new Uint8Array(4096).fill(6)]]));
  const l1Offset = Number(file.readBigUInt64BE(40));
  assert.equal(file.readUInt32BE(36), 1, 'one L1 entry covers the disk');
  assert.equal(file.readBigUInt64BE(l1Offset + 8), 0n, 'the L1 cluster has room for a second');
  file.writeUInt32BE(2, 36);
  file.writeBigUInt64BE(BigInt(file.length + (1 << 20)), l1Offset + 8); // a table past the file's end
  await load('spare-l1', file, base);
  const merged = (await mergedOf('spare-l1', base))!;
  assert.ok(merged.subarray(100 * 4096, 101 * 4096).every((x) => x === 6), 'the change loaded');
});

/** A changes file from qemu-img with compressed clusters, and its compressed clusters' offsets in the file, ascending. */
function qemuCompressed() {
  const base = Uint8Array.from({ length: 1 << 20 }, (_, i) => 97 + (i * 7 + (i >> 9)) % 23);
  const merged = base.slice();
  merged.fill(0x5a, 70000, 75000);
  writeFileSync(join(dir, 'tb.raw'), base);
  writeFileSync(join(dir, 'tm.raw'), merged);
  const r = spawnSync('qemu-img', ['convert', '-c', '-O', 'qcow2', '-B', 'tb.raw', '-F', 'raw', 'tm.raw', 'tc.qcow2'], { cwd: dir, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const bytes = readFileSync(join(dir, 'tc.qcow2'));
  const bits = bytes.readUInt32BE(20);
  const l1 = Number(bytes.readBigUInt64BE(40));
  const x = BigInt(62 - (bits - 8));
  const offsets: number[] = [];
  for (let i = 0; i < bytes.readUInt32BE(36); i++) {
    const l2 = Number(bytes.readBigUInt64BE(l1 + i * 8) & 0x00fffffffffffe00n);
    if (!l2) continue;
    for (let k = 0; k < 2 ** bits / 8; k++) {
      const e = bytes.readBigUInt64BE(l2 + k * 8);
      if (e & (1n << 62n)) offsets.push(Number(e & ((1n << x) - 1n)));
    }
  }
  return { bytes, offsets: offsets.sort((a, b) => a - b) };
}

// Review cut-jobs 6: a file cut through its last compressed cluster passed `check` (only an extent past the end was
// refused), and the load found it only once the overlay was emptied.
test('a changes file cut through a compressed cluster is refused by its check, before the overlay is touched', { skip: !have && 'SKIPPED: no qemu-img/qemu-io' }, async () => {
  const { bytes, offsets } = qemuCompressed();
  assert.ok(offsets.length > 0, 'compressed clusters');
  const whole = readChanges((o, l) => (o + l <= bytes.length ? bytes.subarray(o, o + l) : undefined), bytes.length)!;
  await whole.check(); // the whole file passes
  const last = offsets.at(-1)!;
  assert.ok(last + 64 < bytes.length, 'the last compressed cluster is the end of the file');
  const cut = bytes.subarray(0, last + 32);
  const c = readChanges((o, l) => (o + l <= cut.length ? cut.subarray(o, o + l) : undefined), cut.length)!;
  await assert.rejects(Promise.resolve().then(() => c.check()), (e: unknown) => msgOf(e)?.key === 'disks:qcow2.changesTruncated');
});
