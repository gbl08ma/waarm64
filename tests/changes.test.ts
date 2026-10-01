// Changes in (web/changes.ts, web/qcow2.ts `readChanges`): a changes file written by Save disk goes
// back into an overlay over its base (the disk comes out as it was saved), replacing what the
// overlay held; a different base, a size mismatch and a qcow2 from another tool are refused before
// the overlay is touched; and a changes file from qemu-img (64 KiB clusters, zero clusters) reads
// block by block. In Node the overlay lives in memory. The qemu-img parts skip without it.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { splitmix64 } from '../tools/corpus/corpus.ts';
import { loadChanges } from '../web/changes.ts';
import type { Source } from '../web/devices.ts';
import { memFile, openOverlay, overlay } from '../web/overlay.ts';
import { openDisk, readChanges } from '../web/qcow2.ts';
import { changedClusters, writeQcow2, type Sink } from '../web/qcow2-write.ts';
import { Sha256 } from '../web/sha256.ts';

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
async function changesFile(base: Uint8Array, writes: [number, Uint8Array][]) {
  const rw = overlay(openDisk((o, l) => base.slice(o, o + l), base.length), memFile(), memFile());
  for (const [off, bytes] of writes) assert.ok(await rw.write(off, bytes));
  const parts: Uint8Array[] = [];
  const sink: Sink = (chunk, at) => { if (at === undefined) parts.push(chunk); else parts[0] = chunk; };
  await writeQcow2({ size: base.length, clusters: changedClusters(rw), backing: { name: 'base.img', format: 'raw', sha256: new Sha256().update(base).hex() }, sink });
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

test('a different base, a different size and a qcow2 without our checksum are refused, the overlay untouched', async () => {
  const base = randomBase(2n);
  const file = await changesFile(base, [[100, Uint8Array.of(7)]]);
  const first = await load('guarded', file, base);
  assert.equal(first.blocks, 1);
  const before = await mergedOf('guarded', base);

  const other = base.slice();
  other[SIZE - 1] ^= 1;
  await assert.rejects(load('guarded', file, other), /made over base\.img \(SHA-256 [0-9a-f]{12}…\), which isn't the page disk \(SHA-256 [0-9a-f]{12}…\)/);
  await assert.rejects(load('guarded', file, base.subarray(0, SIZE - 4096)), /for a disk of \d+ bytes .*the page disk has/);
  await assert.rejects(load('guarded', base, base), /isn't a changes file/);
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
  assert.equal(c.sha256, undefined); // not ours
  assert.equal(c.size, 1 << 20);
  const got = new Map<number, Uint8Array>();
  for await (const { block, data } of c.blocks()) got.set(block, data);
  // qemu-io wrote one cluster of data (the 64 KiB cluster 1, merged with the base around the write) and a zero one.
  assert.equal([...got.keys()].filter((b) => b >= 16 && b < 32).length, 16);
  assert.ok(got.get(70000 >> 12)!.subarray(70000 & 4095).every((x) => x === 0xab));
  assert.ok(got.get(64)!.every((x) => x === 0), 'the zero cluster reads as zeros');
  assert.equal(got.size, 32);
});
