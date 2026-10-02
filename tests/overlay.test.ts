// The copy-on-write overlay (web/overlay.ts) against a plain byte array, over
// in-memory files shaped like OPFS sync access handles.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { memFile, overlay } from '../web/overlay.ts';
import { openDisk } from '../web/qcow2.ts';
import { splitmix64 } from '../tools/corpus/corpus.ts';

test('overlay reads what was written and the base elsewhere, and reopens', async () => {
  const g = splitmix64(7n);
  const rand = (n: number) => Number(g.next().value as bigint % BigInt(n));
  const size = 10 * 4096 + 512 * 3; // a partial last block
  const baseBytes = Uint8Array.from({ length: size }, () => rand(256));
  const base = openDisk((off, len) => (off + len <= size ? baseBytes.slice(off, off + len) : undefined), size);
  const [data, map] = [memFile(), memFile()];
  const model = baseBytes.slice();
  let d = overlay(base, data, map);
  for (let i = 0; i < 300; i++) {
    const off = rand(size / 512) * 512;
    const len = Math.min(size - off, (rand(24) + 1) * 512);
    if (rand(2)) {
      const bytes = Uint8Array.from({ length: len }, () => rand(256));
      assert.ok(await d.write(off, bytes));
      model.set(bytes, off);
    } else {
      assert.deepEqual(await d.read(off, len), model.slice(off, off + len), `read ${off}+${len}`);
    }
    if (i === 150) d = overlay(base, data, map); // what a later boot sees
  }
  assert.deepEqual(await d.read(0, size), model);
  assert.equal(await d.write(size - 512, new Uint8Array(1024)), false);
  assert.equal(data.getSize() % 4096, 0);
  assert.ok(data.getSize() <= 11 * 4096, 'each block has one slot');
});

test('discarded and zeroed blocks read as zeros, give their slots back, and stay so when reopened', async () => {
  const g = splitmix64(11n);
  const rand = (n: number) => Number(g.next().value as bigint % BigInt(n));
  const size = 40 * 4096 + 512 * 5; // a partial last block
  const baseBytes = Uint8Array.from({ length: size }, () => 1 + rand(255)); // no zeros: a block that reads as zeros is the overlay's doing
  const base = openDisk((off, len) => (off + len <= size ? baseBytes.slice(off, off + len) : undefined), size);
  const [data, map] = [memFile(), memFile()];
  const model = baseBytes.slice();
  const held = new Set<number>(); // blocks the overlay holds, as the model has them
  const whole = (off: number, len: number) => [Math.ceil(off / 4096), off + len === size ? 41 : Math.floor((off + len) / 4096)];
  const touch = (off: number, len: number) => { for (let b = Math.floor(off / 4096); b * 4096 < off + len; b++) held.add(b); };
  let d = overlay(base, data, map);
  for (let i = 0; i < 1500; i++) {
    const off = rand(size / 512) * 512;
    const len = Math.min(size - off, (rand(40) + 1) * 512);
    const op = rand(5);
    if (op === 0) {
      const bytes = Uint8Array.from({ length: len }, () => 1 + rand(255));
      assert.ok(await d.write(off, bytes));
      model.set(bytes, off);
      touch(off, len);
    } else if (op === 1) {
      // A discard: only whole blocks the overlay holds change (to zeros); the base never comes back.
      assert.ok(d.discard(off, len));
      const [first, end] = whole(off, len);
      for (let b = first; b < end; b++) if (held.has(b)) model.fill(0, b * 4096, Math.min(size, (b + 1) * 4096));
    } else if (op === 2) {
      assert.ok(await d.zero(off, len));
      model.fill(0, off, off + len);
      touch(off, len);
    } else {
      const got = await d.read(off, len);
      assert.ok(got && Buffer.compare(got, model.subarray(off, off + len)) === 0, `read ${off}+${len} at step ${i}`);
    }
    if (i % 400 === 399) d = overlay(base, data, map); // what a later boot sees: the free slots are found again
  }
  const all = await d.read(0, size);
  assert.ok(all && Buffer.compare(all, model) === 0);
  assert.deepEqual(d.written(), [...held].sort((a, b) => a - b));
  // Every slot belongs to one block: zeroed blocks have none, and none is left over at the end of the file.
  const slotted = d.written().filter((b) => !d.zeroed(b));
  assert.ok(data.getSize() <= 41 * 4096, `${data.getSize() / 4096} slots for 41 blocks`);
  for (const b of d.written()) if (d.zeroed(b)) assert.ok(d.block(b)!.every((x) => x === 0));
  // Everything discarded: the data file is empty, and the disk reads as zeros where it was written.
  assert.ok(d.discard(0, size));
  assert.equal(data.getSize(), 0);
  assert.ok(slotted.length > 0 && slotted.every((b) => d.zeroed(b)));
  assert.equal(d.discard(size - 512, 1024), false);
  assert.equal(await d.zero(size - 512, 1024), false);
});

test('a slot freed by a discard is the next write\'s, and free slots at the end of the file are cut off', async () => {
  const size = 16 * 4096;
  const base = openDisk((off, len) => new Uint8Array(len).fill(7), size);
  const [data, map] = [memFile(), memFile()];
  const d = overlay(base, data, map);
  for (let b = 0; b < 8; b++) assert.ok(await d.write(b * 4096, new Uint8Array(4096).fill(b + 1)));
  assert.equal(data.getSize(), 8 * 4096);
  assert.ok(d.discard(2 * 4096, 4096)); // a hole: the file keeps its size
  assert.equal(data.getSize(), 8 * 4096);
  assert.ok(await d.write(12 * 4096, new Uint8Array(4096).fill(99))); // takes the hole
  assert.equal(data.getSize(), 8 * 4096);
  assert.ok(d.discard(6 * 4096 + 512, 2 * 4096)); // covers block 7 only
  assert.equal(data.getSize(), 7 * 4096);
  assert.deepEqual([d.zeroed(2), d.zeroed(6), d.zeroed(7), d.zeroed(9)], [true, false, true, false]);
  assert.ok(d.discard(9 * 4096, 4096)); // not the overlay's: still the base's
  assert.deepEqual([...(await d.read(9 * 4096, 2))!], [7, 7]);
  assert.ok(await d.zero(9 * 4096, 4096)); // write zeroes: zeros, without a slot
  assert.deepEqual([...(await d.read(9 * 4096, 2))!], [0, 0]);
  assert.equal(data.getSize(), 7 * 4096);
  // A partial write over a zeroed block starts from zeros, not from the base.
  assert.ok(await d.write(2 * 4096 + 100, Uint8Array.of(5)));
  assert.deepEqual([...(await d.read(2 * 4096 + 99, 3))!], [0, 5, 0]);
  // Reopened: the same disk, and a leaked slot (written, never mapped) is reused rather than kept.
  data.write(new Uint8Array(4096).fill(0xee), { at: data.getSize() });
  const again = overlay(base, data, map);
  assert.deepEqual([...(await again.read(12 * 4096, 2))!, ...(await again.read(7 * 4096, 2))!], [99, 99, 0, 0]);
  const before = data.getSize();
  assert.ok(await again.write(14 * 4096, new Uint8Array(4096).fill(3)));
  assert.equal(data.getSize(), before);
});

test('once half the data file is free slots, the blocks left move down and the file shrinks; nothing is lost, reopened too', async () => {
  const size = 400 * 4096;
  const base = openDisk((off, len) => new Uint8Array(len).fill(7), size);
  const [data, map] = [memFile(), memFile()];
  const d = overlay(base, data, map);
  const g = splitmix64(13n);
  const order = Array.from({ length: 300 }, (_, i) => i).sort(() => Number(g.next().value as bigint % 3n) - 1); // slots in no particular order
  for (const b of order) assert.ok(await d.write(b * 4096, new Uint8Array(4096).fill(b % 251 + 1)));
  assert.equal(data.getSize(), 300 * 4096);
  // Every block but each fifth goes, a few at a time: 60 are left.
  for (let b = 0; b < 300; b += 5) assert.ok(d.discard((b + 1) * 4096, 4 * 4096));
  assert.ok(data.getSize() <= 120 * 4096, `${data.getSize() / 4096} slots for 60 blocks`);
  for (const disk of [d, overlay(base, data, map)]) {
    for (let b = 0; b < 400; b++) {
      const want = b >= 300 ? 7 : b % 5 === 0 ? b % 251 + 1 : 0;
      const got = (await disk.read(b * 4096, 4096))!;
      assert.ok(got.every((x) => x === want), `block ${b} reads ${got[0]}, not ${want}`);
    }
  }
  // The free slots left are taken before the file grows.
  const before = data.getSize();
  const again = overlay(base, data, map);
  for (let b = 300; b < 300 + (before / 4096 - 60); b++) assert.ok(await again.write(b * 4096, new Uint8Array(4096).fill(1)));
  assert.equal(data.getSize(), before);
});
