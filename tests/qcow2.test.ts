// The qcow2 reader (web/qcow2.ts) against qemu-img's fixtures (tests/qcow2/make.sh).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { openDisk } from '../web/qcow2.ts';

const file = (name: string) => readFileSync(new URL(`./qcow2/${name}`, import.meta.url));
const open = (name: string) => {
  const b = file(name);
  return openDisk((off, len) => (off + len <= b.length ? new Uint8Array(b.buffer, b.byteOffset + off, len) : undefined), b.length);
};
const data = file('data.raw');

for (const [name, format] of [['v2.qcow2', 'qcow2'], ['v3.qcow2', 'qcow2'], ['deflate.qcow2', 'qcow2'], ['data.raw', 'raw']] as const) {
  test(`${name} reads as data.raw`, async () => {
    const d = open(name);
    assert.deepEqual([d.format, d.size], [format, data.length]);
    assert.deepEqual(await d.read(0, data.length), new Uint8Array(data));
    // Unaligned reads across cluster boundaries and through every kind of cluster.
    for (let off = 0; off < data.length; off += 3001) {
      const len = Math.min(9000, data.length - off);
      assert.deepEqual(await d.read(off, len), new Uint8Array(data.subarray(off, off + len)), `at ${off}`);
    }
    assert.equal(await d.read(data.length - 512, 1024), undefined);
  });
}

for (const [name, why] of [
  ['reject-backing.qcow2', /backing files/],
  ['reject-zstd.qcow2', /zstd/],
  ['reject-extl2.qcow2', /extended L2/],
  ['reject-datafile.qcow2', /external data/],
  ['reject-luks.qcow2', /encrypted/],
] as const) {
  test(`${name} is refused at open`, () => assert.throws(() => open(name), why));
}

// A request over many clusters reads the file in a few pieces, not one per cluster (the page's
// disk is read with one HTTP request per piece), and gives the same bytes as cluster by cluster.
for (const name of ['v3.qcow2', 'deflate.qcow2'] as const) {
  test(`${name}: a read over the whole disk merges its host reads, and a failed merged read falls back`, async () => {
    const b = file(name);
    let reads: number[] = [];
    let refuse = Infinity; // reads of this many bytes or more fail
    const d = openDisk((off, len) => {
      reads.push(len);
      return off + len <= b.length && len < refuse ? new Uint8Array(b.buffer, b.byteOffset + off, len) : undefined;
    }, b.length);
    // Sector by sector first: every cluster on its own.
    const each = new Uint8Array(data.length);
    for (let off = 0; off < data.length; off += 512) each.set((await d.read(off, 512))!, off);
    assert.ok(Buffer.compare(each, data) === 0);
    const single = reads.length;
    reads = [];
    const all = await openDisk((off, len) => { reads.push(len); return new Uint8Array(b.buffer, b.byteOffset + off, len); }, b.length).read(0, data.length);
    assert.ok(all && Buffer.compare(all, data) === 0);
    assert.ok(reads.length <= 10 && reads.length < single / 4, `${reads.length} host reads for the whole disk, ${single} sector by sector`);
    // The merged read fails (a server that refuses long ranges): each range is read on its own.
    refuse = Math.max(...reads);
    const again = openDisk((off, len) => (off + len <= b.length && len < refuse ? new Uint8Array(b.buffer, b.byteOffset + off, len) : undefined), b.length);
    const slow = await again.read(0, data.length);
    assert.ok(slow && Buffer.compare(slow, data) === 0);
  });
}
