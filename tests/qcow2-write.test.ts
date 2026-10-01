// The disk-out writers (web/qcow2-write.ts, web/sha256.ts) against QEMU's own tools: the
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
import { memFile, overlay } from '../web/overlay.ts';
import { openDisk, type Disk } from '../web/qcow2.ts';
import { changedClusters, CLUSTER, nonZeroClusters, writeQcow2, type DataCluster, type Sink } from '../web/qcow2-write.ts';
import { Sha256 } from '../web/sha256.ts';

const have = spawnSync('qemu-img', ['--version']).status === 0;
const skip = !have && 'SKIPPED: no qemu-img';

let dir: string;
before(() => { dir = mkdtempSync(join(tmpdir(), 'webpc-qcow2w-')); });
after(() => { if (dir) rmSync(dir, { recursive: true }); });

test('SHA-256 matches node:crypto over odd lengths and split updates', () => {
  const g = splitmix64(3n);
  for (const len of [0, 1, 55, 56, 63, 64, 65, 119, 120, 1000, 100_000]) {
    const bytes = Uint8Array.from({ length: len }, () => Number(g.next().value as bigint & 255n));
    const want = createHash('sha256').update(bytes).digest('hex');
    assert.equal(new Sha256().update(bytes).hex(), want, `${len} bytes`);
    const split = new Sha256();
    for (let i = 0; i < len; i += 37) split.update(bytes.subarray(i, i + 37));
    assert.equal(split.hex(), want, `${len} bytes, in pieces of 37`);
  }
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

for (const [name, size, writes] of [['a small disk', 10 * CLUSTER + 1536, 20], ['a disk over several L2 tables and refcount blocks', 40 * 1024 * 1024 + 512, 2500]] as const) {
  test(`changes over a base (${name}): qemu-img check passes and the base plus the changes is the merged disk`, { skip }, async () => {
    const { base, merged, rw } = await scenario(size, writes, BigInt(size));
    writeFileSync(join(dir, 'base.raw'), base);
    writeFileSync(join(dir, 'merged.raw'), merged);
    const out = memorySink();
    const sha256 = new Sha256().update(base).hex();
    const r = await writeQcow2({ size, clusters: changedClusters(rw), backing: { name: 'base.raw', format: 'raw', sha256 }, sink: out.sink });
    assert.equal(r.clusters, rw.written().length);
    assert.equal(out.bytes().length, r.bytes);
    writeFileSync(join(dir, 'changes.qcow2'), out.bytes());
    qemu('check', join(dir, 'changes.qcow2'));
    assert.match(qemu('info', join(dir, 'changes.qcow2')), /backing file: base\.raw/);
    assert.match(qemu('compare', '-f', 'qcow2', '-F', 'raw', join(dir, 'changes.qcow2'), join(dir, 'merged.raw')), /Images are identical/);
    // Our header extension carries the base's hash, after the format name.
    assert.ok(out.bytes().subarray(0, CLUSTER).toString('latin1').includes(sha256));
  });

  test(`the whole disk (${name}) as qcow2: zero clusters left out, check passes, and qemu-img and our reader see the merged disk`, { skip }, async () => {
    const { merged, rw } = await scenario(size, writes, BigInt(size));
    writeFileSync(join(dir, 'merged.raw'), merged);
    const out = memorySink();
    const r = await writeQcow2({ size, clusters: nonZeroClusters(rw, 64 * 1024), sink: out.sink });
    let nonZero = 0;
    for (let c = 0; c < merged.length; c += CLUSTER) if (merged.subarray(c, c + CLUSTER).some((b) => b)) nonZero++;
    assert.equal(r.clusters, nonZero);
    writeFileSync(join(dir, 'whole.qcow2'), out.bytes());
    qemu('check', join(dir, 'whole.qcow2'));
    assert.match(qemu('compare', '-f', 'qcow2', '-F', 'raw', join(dir, 'whole.qcow2'), join(dir, 'merged.raw')), /Images are identical/);
    const bytes = readFileSync(join(dir, 'whole.qcow2'));
    const d: Disk = openDisk((off, len) => (off + len <= bytes.length ? bytes.subarray(off, off + len) : undefined), bytes.length);
    assert.equal(d.size, size);
    assert.deepEqual(await d.read(0, size), merged);
  });
}

test('the writer refuses clusters out of order or of the wrong size', { skip }, async () => {
  const c = (index: number, len = CLUSTER): DataCluster => ({ index, data: new Uint8Array(len) });
  async function* of(...items: DataCluster[]) { yield* items; }
  await assert.rejects(writeQcow2({ size: 1 << 20, clusters: of(c(5), c(3)), sink: () => {} }), /out of order/);
  await assert.rejects(writeQcow2({ size: 1 << 20, clusters: of(c(1, 100)), sink: () => {} }), /is 100 bytes/);
});
