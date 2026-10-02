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
import { hashSource, loadChanges } from '../web/changes.ts';
import type { Source } from '../web/devices.ts';
import { memFile, openOverlay, overlay } from '../web/overlay.ts';
import { openDisk, readChanges } from '../web/qcow2.ts';
import { changedClusters, writeQcow2, type Sink } from '../web/qcow2-write.ts';

const have = spawnSync('qemu-img', ['--version']).status === 0 && spawnSync('qemu-io', ['--version']).status === 0;

let dir: string;
before(() => { dir = mkdtempSync(join(tmpdir(), 'webpc-changes-')); });
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
      assert.deepEqual(d.written().map((b) => [b, d.zeroed(b)]), [[10, false], [11, true], [12, false], [299, true], [300, true]]);
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
  await assert.rejects(load('guarded', file, other), /made over base\.img \(hash [0-9a-f]{12}…\), which isn't the page disk \(hash [0-9a-f]{12}…\)/);
  await assert.rejects(load('guarded', file, base.subarray(0, SIZE - 4096)), /for a disk of \d+ bytes .*the page disk has/);
  await assert.rejects(load('guarded', base, base), /isn't a changes file/);
  // A changes file from before the hash was of slices ("WPC1": the whole file's SHA-256) has no hash we check.
  const old = Buffer.from(file);
  const at = old.subarray(0, 4096).indexOf('WPC2');
  assert.ok(at > 0);
  old.write('WPC1', at);
  await assert.rejects(load('guarded', old, base), /wasn't made by this page's Save disk/);
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
