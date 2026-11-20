// A qcow2's allocation in Node: a large, mostly unallocated image read across (fsck, `dd`, an LVM scan) keeps no L2
// table for an unallocated L1 entry (web/qcow2.ts `openDisk`), and a stored disk's estimate counts the clusters with
// data (web/stored.ts `storedEstimate`).
import assert from 'node:assert/strict';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { test } from 'node:test';
import { openDisk } from '../web/qcow2.ts';
import { qcow2 } from './qcow2-make.ts';
import { storedEstimate } from '../web/stored.ts';
import type { Source } from '../web/devices.ts';

test('reading across a 1 TiB qcow2 with one cluster allocated keeps no table per unallocated L1 entry', async () => {
  setFlagsFromString('--expose-gc');
  const gc = runInNewContext('gc') as () => void;
  const { bytes, cs } = qcow2(2 ** 40, 16, new Map([[0, 'data']]));
  const d = openDisk((off, len) => (off + len <= bytes.length ? bytes.subarray(off, off + len) : undefined), bytes.length);
  const span = (cs / 8) * cs; // one L2 table's bytes of the disk: 512 MiB
  gc();
  const before = process.memoryUsage().arrayBuffers;
  for (let t = 1; t < 2 ** 40 / span; t++) {
    const b = await d.read(t * span + 4096, 512);
    assert.ok(b?.every((x) => x === 0), `table ${t} reads as zeros`);
  }
  gc();
  const grew = process.memoryUsage().arrayBuffers - before;
  assert.ok(grew < 16 << 20, `${(grew / 2 ** 20).toFixed(1)} MiB kept for 2047 unallocated tables`);
  assert.equal((await d.read(0, 4))?.[0], 1, 'the allocated cluster still reads');
});

test("a stored disk's estimate counts the clusters with data, whatever buffer the source's reads are views of", () => {
  const { bytes, cs } = qcow2(1 << 30, 16, new Map<number, 'data' | 'zero' | 'compressed'>([[0, 'data'], [1, 'zero'], [2, 'compressed'], [9000, 'data']]));
  // The image at an offset in a larger buffer: each read a view into it (a cache's block, a subarray).
  const backing = new Uint8Array(bytes.length + 8192).fill(0xee);
  backing.set(bytes, 4096);
  const src: Source = { size: bytes.length, read: (off, len) => (off + len <= bytes.length ? backing.subarray(4096 + off, 4096 + off + len) : undefined) };
  const est = storedEstimate(src);
  assert.deepEqual([est.format, est.size], ['qcow2', 1 << 30]);
  assert.equal(est.estimate, 3 * cs, 'data, compressed and data: the zero cluster takes nothing');
});
