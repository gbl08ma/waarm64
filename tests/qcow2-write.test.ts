// The disk-out writers (web/qcow2-write.ts, and the base's hash, web/changes.ts) against QEMU's own tools: the
// changes over a base image as a qcow2 with the base as its backing file, and the whole disk as
// qcow2 (zero clusters left out), checked by `qemu-img check` and `qemu-img compare` against the
// merged bytes, and read back by our own reader. Skipped without qemu-img.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { splitmix64 } from '../tools/corpus/corpus.ts';
import { HASH_SLICE, hashSource } from '../web/changes.ts';
import { memFile, overlay } from '../web/overlay.ts';
import { openDisk, type Disk } from '../web/qcow2.ts';
import { changedClusters, CLUSTER, nonZeroClusters, writeQcow2, type DataCluster, type Sink } from '../web/qcow2-write.ts';

const have = spawnSync('qemu-img', ['--version']).status === 0;
const skip = !have && 'SKIPPED: no qemu-img';

let dir: string;
before(() => { dir = mkdtempSync(join(tmpdir(), 'webpc-qcow2w-')); });
after(() => { if (dir) rmSync(dir, { recursive: true }); });

/** What `hashSource` is: node:crypto's SHA-256 of the SHA-256 digests of the slices. */
function hashOf(bytes: Uint8Array, slice = HASH_SLICE) {
  const top = createHash('sha256');
  for (let off = 0; off < bytes.length; off += slice) top.update(createHash('sha256').update(bytes.subarray(off, off + slice)).digest());
  return top.digest('hex');
}
const hashed = (bytes: Uint8Array, slice?: number) =>
  hashSource({ size: bytes.length, read: (off, len) => bytes.subarray(off, off + len) }, () => {}, slice);

test("the base's hash is node:crypto's SHA-256 of the slices' SHA-256 digests, over odd lengths and more slices than run at once", async () => {
  const g = splitmix64(3n);
  for (const len of [0, 1, 999, 1000, 1001, 4000, 4001, 12_345]) {
    const bytes = Uint8Array.from({ length: len }, () => Number(g.next().value as bigint & 255n));
    assert.equal(await hashed(bytes, 1000), hashOf(bytes, 1000), `${len} bytes in slices of 1000`);
  }
  const big = new Uint8Array(2 * HASH_SLICE + 5);
  for (let i = 0; i < big.length; i += 4099) big[i] = Number(g.next().value as bigint & 255n);
  assert.equal(await hashed(big), hashOf(big));
  // Every byte counts, and a slice's place: one bit, and two slices swapped.
  const flipped = big.slice();
  flipped[HASH_SLICE + 7] ^= 1;
  assert.notEqual(await hashed(flipped), await hashed(big));
  const swapped = big.slice();
  swapped.copyWithin(0, HASH_SLICE, 2 * HASH_SLICE);
  swapped.set(big.subarray(0, HASH_SLICE), HASH_SLICE);
  assert.notEqual(await hashed(swapped), await hashed(big));
  let told = 0;
  await hashSource({ size: big.length, read: (off, len) => big.subarray(off, off + len) }, (done) => { assert.ok(done > told); told = done; });
  assert.equal(told, big.length);
  await assert.rejects(hashSource({ size: 10, read: () => undefined }, () => {}), /can't be read at 0/);
});

/** A sink into memory: the stream, with the header patched in at the start. */
function memorySink() {
  const parts: Uint8Array[] = [];
  const sink: Sink = (chunk, at) => { if (at === undefined) parts.push(chunk); else parts[0] = chunk; };
  return { sink, bytes: () => Buffer.concat(parts) };
}

/**
 * A raw base of `size` bytes that's mostly zeros with random runs (the shape of a disk), an overlay
 * over it with `writes` random writes, and the merged bytes.
 */
async function scenario(size: number, writes: number, seed: bigint) {
  const g = splitmix64(seed);
  const rand = (n: number) => Number(g.next().value as bigint % BigInt(n));
  const base = new Uint8Array(size);
  for (let r = 0; r < size / 50_000; r++) {
    const at = rand(size - 20_000);
    for (let i = 0; i < 1 + rand(20_000); i++) base[at + i] = 1 + rand(255);
  }
  const disk = openDisk((off, len) => (off + len <= size ? base.slice(off, off + len) : undefined), size);
  const rw = overlay(disk, memFile(), memFile());
  const merged = base.slice();
  for (let i = 0; i < writes; i++) {
    const off = rand(size / 512) * 512;
    const len = Math.min(size - off, (1 + rand(40)) * 512);
    const bytes = rand(5) === 0 ? new Uint8Array(len) : Uint8Array.from({ length: len }, () => rand(256)); // zeros over data too
    assert.ok(await rw.write(off, bytes));
    merged.set(bytes, off);
  }
  return { base, merged, rw };
}

const qemu = (...args: string[]) => execFileSync('qemu-img', args, { encoding: 'utf8' });

/** Clusters of every kind for the compressor: runs of one byte, text-like bytes, and random ones (which don't shrink and are stored as they are). */
async function mixedScenario(size: number, seed: bigint) {
  const g = splitmix64(seed);
  const rand = (n: number) => Number(g.next().value as bigint % BigInt(n));
  const base = new Uint8Array(size);
  const disk = openDisk((off, len) => (off + len <= size ? base.slice(off, off + len) : undefined), size);
  const rw = overlay(disk, memFile(), memFile());
  const merged = base.slice();
  for (let c = 0; c * CLUSTER < size; c++) {
    const kind = rand(8);
    if (kind < 2) continue; // not written
    const len = Math.min(CLUSTER, size - c * CLUSTER);
    const bytes = kind === 2 ? new Uint8Array(len).fill(rand(3)) // zeros too: a changes file holds them
      : kind < 6 ? Uint8Array.from({ length: len }, (_, i) => 97 + (i * (1 + c % 7)) % (2 + rand(12)))
      : Uint8Array.from({ length: len }, () => rand(256));
    assert.ok(await rw.write(c * CLUSTER, bytes));
    merged.set(bytes, c * CLUSTER);
  }
  return { base, merged, rw };
}

for (const compress of [false, true]) {
  const how = compress ? ', compressed' : '';
  for (const [name, size, writes] of [['a small disk', 10 * CLUSTER + 1536, 20], ['a disk over several L2 tables and refcount blocks', 40 * 1024 * 1024 + 512, 2500]] as const) {
    test(`changes over a base (${name}${how}): qemu-img check passes and the base plus the changes is the merged disk`, { skip }, async () => {
      const { base, merged, rw } = await scenario(size, writes, BigInt(size));
      writeFileSync(join(dir, 'base.raw'), base);
      writeFileSync(join(dir, 'merged.raw'), merged);
      const out = memorySink();
      const hash = await hashed(base);
      const r = await writeQcow2({ size, clusters: changedClusters(rw), backing: { name: 'base.raw', format: 'raw', hash }, compress, sink: out.sink });
      assert.equal(r.clusters, rw.written().length);
      assert.equal(out.bytes().length, r.bytes);
      writeFileSync(join(dir, 'changes.qcow2'), out.bytes());
      qemu('check', join(dir, 'changes.qcow2'));
      assert.match(qemu('info', join(dir, 'changes.qcow2')), /backing file: base\.raw/);
      assert.match(qemu('compare', '-f', 'qcow2', '-F', 'raw', join(dir, 'changes.qcow2'), join(dir, 'merged.raw')), /Images are identical/);
      // Our header extension carries the base's hash, after the format name.
      assert.ok(out.bytes().subarray(0, CLUSTER).toString('latin1').includes(`WPC2\0\0\0@${hash}`));
    });

    test(`the whole disk (${name}${how}) as qcow2: zero clusters left out, check passes, and qemu-img and our reader see the merged disk`, { skip }, async () => {
      const { merged, rw } = await scenario(size, writes, BigInt(size));
      writeFileSync(join(dir, 'merged.raw'), merged);
      const out = memorySink();
      const r = await writeQcow2({ size, clusters: nonZeroClusters(rw, 64 * 1024), compress, sink: out.sink });
      let nonZero = 0;
      for (let c = 0; c < merged.length; c += CLUSTER) if (merged.subarray(c, c + CLUSTER).some((b) => b)) nonZero++;
      assert.equal(r.clusters, nonZero);
      writeFileSync(join(dir, 'whole.qcow2'), out.bytes());
      qemu('check', join(dir, 'whole.qcow2'));
      assert.match(qemu('compare', '-f', 'qcow2', '-F', 'raw', join(dir, 'whole.qcow2'), join(dir, 'merged.raw')), /Images are identical/);
      await sameAsOurs(readFileSync(join(dir, 'whole.qcow2')), merged);
    });
  }
}

/** Our reader (web/qcow2.ts) sees `merged` in the qcow2 `bytes`. */
async function sameAsOurs(bytes: Buffer, merged: Uint8Array) {
  const d: Disk = openDisk((off, len) => (off + len <= bytes.length ? bytes.subarray(off, off + len) : undefined), bytes.length);
  assert.equal(d.size, merged.length);
  const got = await d.read(0, merged.length);
  assert.ok(got && Buffer.compare(got, merged) === 0, 'our reader sees another disk');
}

test('compressed clusters among ones that do not shrink: a smaller file, check passes (the refcounts of shared host clusters), and qemu-img and our reader see the disk', { skip }, async () => {
  const size = 9 * 1024 * 1024 + 2048;
  const { base, merged, rw } = await mixedScenario(size, 11n);
  writeFileSync(join(dir, 'base.raw'), base);
  writeFileSync(join(dir, 'merged.raw'), merged);
  const sizes: number[] = [];
  for (const compress of [false, true]) {
    const out = memorySink();
    const r = await writeQcow2({ size, clusters: nonZeroClusters(rw), compress, sink: out.sink });
    assert.equal(out.bytes().length, r.bytes);
    sizes.push(r.bytes);
    writeFileSync(join(dir, 'mixed.qcow2'), out.bytes());
    qemu('check', join(dir, 'mixed.qcow2'));
    assert.match(qemu('compare', '-f', 'qcow2', '-F', 'raw', join(dir, 'mixed.qcow2'), join(dir, 'merged.raw')), /Images are identical/);
    await sameAsOurs(out.bytes(), merged);
  }
  assert.ok(sizes[1] < 0.8 * sizes[0], `compressed ${sizes[1]} bytes, not compressed ${sizes[0]}`);
  // The changes, compressed: zero clusters are data here.
  const out = memorySink();
  await writeQcow2({ size, clusters: changedClusters(rw), backing: { name: 'base.raw', format: 'raw', hash: await hashed(base) }, compress: true, sink: out.sink });
  writeFileSync(join(dir, 'mixed-changes.qcow2'), out.bytes());
  qemu('check', join(dir, 'mixed-changes.qcow2'));
  assert.match(qemu('compare', '-f', 'qcow2', '-F', 'raw', join(dir, 'mixed-changes.qcow2'), join(dir, 'merged.raw')), /Images are identical/);
});

test('the writer refuses clusters out of order or of the wrong size', { skip }, async () => {
  const c = (index: number, len = CLUSTER): DataCluster => ({ index, data: new Uint8Array(len) });
  async function* of(...items: DataCluster[]) { yield* items; }
  await assert.rejects(writeQcow2({ size: 1 << 20, clusters: of(c(5), c(3)), sink: () => {} }), /out of order/);
  await assert.rejects(writeQcow2({ size: 1 << 20, clusters: of(c(1, 100)), sink: () => {} }), /is 100 bytes/);
});

test('blocks the guest discarded or zeroed are zero clusters in a changes file: no data, and qemu-img sees zeros over the base', { skip }, async () => {
  const size = 600 * CLUSTER + 1536; // two L2 tables
  const base = new Uint8Array(size).fill(0x42);
  const rw = overlay(openDisk((off, len) => base.slice(off, off + len), size), memFile(), memFile());
  const merged = base.slice();
  for (const b of [3, 4, 5, 6, 520, 521]) { assert.ok(await rw.write(b * CLUSTER, new Uint8Array(CLUSTER).fill(b))); merged.fill(b, b * CLUSTER, (b + 1) * CLUSTER); }
  assert.ok(rw.discard(4 * CLUSTER, 2 * CLUSTER)); // blocks 4 and 5: written, then trimmed
  merged.fill(0, 4 * CLUSTER, 6 * CLUSTER);
  assert.ok(await rw.zero(590 * CLUSTER, size - 590 * CLUSTER)); // zeroed over the base, to the disk's end
  merged.fill(0, 590 * CLUSTER);
  writeFileSync(join(dir, 'base.raw'), base);
  writeFileSync(join(dir, 'merged.raw'), merged);
  for (const compress of [false, true]) {
    const out = memorySink();
    const r = await writeQcow2({ size, clusters: changedClusters(rw), backing: { name: 'base.raw', format: 'raw', hash: await hashed(base) }, compress, sink: out.sink });
    assert.equal(r.clusters, 6 + 11); // every block the overlay holds has an entry
    if (!compress) assert.equal(r.bytes, (1 + 4 + 2 + 1 + 1 + 1) * CLUSTER, 'the header, four data clusters, two L2 tables, the L1 table, a refcount block and its table');
    writeFileSync(join(dir, 'zeros.qcow2'), out.bytes());
    qemu('check', join(dir, 'zeros.qcow2'));
    assert.match(qemu('compare', '-f', 'qcow2', '-F', 'raw', join(dir, 'zeros.qcow2'), join(dir, 'merged.raw')), /Images are identical/);
  }
});
