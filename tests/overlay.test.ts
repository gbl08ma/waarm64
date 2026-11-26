// The copy-on-write overlay (web/overlay.ts) against a plain byte array, over
// in-memory files shaped like OPFS sync access handles.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dropCutFill, encodeMeta, endFill, grown, lockOverlay, overlayLock, memFile, openOverlay, overlay, overlayMeta, readMeta, withRoom, writeMeta, writeOwnSize, writeWhole } from '../web/overlay.ts';
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
  assert.deepEqual([...d.written()], [...held].sort((a, b) => a - b));
  // Every slot belongs to one block: zeroed blocks have none, and none is left over at the end of the file.
  const slotted = [...d.written()].filter((b) => !d.zeroed(b));
  assert.ok(data.getSize() <= 41 * 4096, `${data.getSize() / 4096} slots for 41 blocks`);
  for (const b of [...d.written()]) if (d.zeroed(b)) assert.ok(d.block(b)!.every((x) => x === 0));
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

test("a compaction asked for moves the blocks down however few slots are free, and the file ends at the last one's", async () => {
  const size = 400 * 4096;
  const base = openDisk((off, len) => new Uint8Array(len).fill(7), size);
  const [data, map] = [memFile(), memFile()];
  const d = overlay(base, data, map);
  for (let b = 0; b < 200; b++) assert.ok(await d.write(b * 4096, new Uint8Array(4096).fill((b % 251) + 1)));
  // A tenth of them trimmed, spread out: below the change's threshold, so the file keeps its size.
  for (let b = 3; b < 200; b += 10) assert.ok(d.discard(b * 4096, 2 * 4096));
  assert.equal(data.getSize(), 200 * 4096, 'a change compacts only past half free');
  assert.equal(d.bytes?.(), data.getSize() + map.getSize());
  assert.ok(d.compact?.());
  assert.equal(data.getSize(), 160 * 4096, 'the 160 blocks left, in 160 slots');
  for (const disk of [d, overlay(base, data, map)])
    for (let b = 0; b < 220; b++) {
      const want = b >= 200 ? 7 : b % 10 === 3 || b % 10 === 4 ? 0 : (b % 251) + 1;
      const got = (await disk.read(b * 4096, 4096))!;
      assert.ok(got.every((x) => x === want), `block ${b} reads ${got[0]}, not ${want}`);
    }
  assert.ok(d.compact?.(), 'again: nothing to move');
  assert.equal(data.getSize(), 160 * 4096);
});

test('a write the storage refuses (short, or a thrown QuotaExceededError) fails alone: its slots go back, and a compaction after it moves only real blocks', async () => {
  for (const how of ['short', 'throws'] as const) {
    const size = 300 * 4096;
    const base = openDisk((off, len) => new Uint8Array(len).fill(7), size);
    const [file, map] = [memFile(), memFile()];
    let refuse = false;
    const data = Object.assign(memFile(), {
      read: file.read.bind(file), getSize: file.getSize.bind(file), truncate: file.truncate.bind(file), flush: file.flush.bind(file),
      write: (buf: Uint8Array, o: { at: number }) => {
        if (!refuse) return file.write(buf, o);
        if (how === 'short') return 0;
        throw new DOMException('No space available for this operation', 'QuotaExceededError');
      },
    });
    const d = overlay(base, data, map);
    for (let b = 0; b < 100; b++) assert.ok(await d.write(b * 4096, new Uint8Array(4096).fill(b + 1)));
    refuse = true;
    assert.equal(await d.write(200 * 4096, new Uint8Array(10 * 4096).fill(200)), false, `${how}: a run of fresh blocks`);
    assert.equal(await d.write(220 * 4096 + 512, new Uint8Array(512).fill(220)), false, `${how}: part of a fresh block`);
    refuse = false;
    assert.ok(await d.write(250 * 4096, new Uint8Array(4096).fill(250)), `${how}: a write after room was made`);
    // Most blocks trimmed: the data file is compacted (the blocks left move into the free slots below).
    assert.ok(d.discard(4096, 99 * 4096));
    for (const disk of [d, overlay(base, data, map)]) {
      const got = (await disk.read(0, size))!;
      for (let b = 0; b < 300; b++) {
        const want = b === 0 ? 1 : b < 100 ? 0 : b === 250 ? 250 : 7;
        assert.ok(got.subarray(b * 4096, (b + 1) * 4096).every((x) => x === want), `${how}: block ${b} reads ${got[b * 4096]}, not ${want}`);
      }
    }
    assert.ok(file.getSize() <= 4 * 4096, `${how}: ${file.getSize() / 4096} slots for 2 blocks`);
  }
});

/** An in-memory file that logs every write (a copy of what was written) and counts the calls. */
function logged(name: string, log: { file: string; at: number; bytes: Uint8Array }[], calls: Record<string, number>, failAt = Infinity) {
  const f = memFile();
  const n = (k: string) => { calls[`${name}.${k}`] = (calls[`${name}.${k}`] ?? 0) + 1; return calls[`${name}.${k}`]; };
  return Object.assign(f, {
    read: ((read) => (buf: Uint8Array, o: { at: number }) => { n('read'); return read(buf, o); })(f.read),
    write: ((write) => (buf: Uint8Array, o: { at: number }) => {
      if (n('write') >= failAt) return 0; // a failed write (e.g. over quota)
      log.push({ file: name, at: o.at, bytes: buf.slice() });
      return write(buf, o);
    })(f.write),
  });
}

test('a request is a few OPFS calls: consecutive blocks are one read or write, map entries one write', async () => {
  const size = 8 << 20;
  const baseBytes = Uint8Array.from({ length: size }, (_, i) => (i * 7 + 1) & 255);
  const base = openDisk((off, len) => baseBytes.slice(off, off + len), size);
  const [log, calls]: [{ file: string; at: number; bytes: Uint8Array }[], Record<string, number>] = [[], {}];
  const d = overlay(base, logged('data', log, calls), logged('map', log, calls));
  const mib = Uint8Array.from({ length: 1 << 20 }, (_, i) => (i * 13 + 5) & 255);
  assert.ok(await d.write(1 << 20, mib));
  assert.deepEqual([calls['data.write'], calls['map.write']], [1, 2], "a fresh 1 MiB write: the map's header, then its leaf with the entries");
  assert.ok(await d.write(1 << 20, mib));
  assert.deepEqual([calls['data.write'], calls['map.write']], [2, 2], 'overwriting it: no map write');
  assert.equal(Buffer.compare(await d.read(1 << 20, 1 << 20) as Uint8Array, mib), 0);
  assert.equal(calls['data.read'], 1, 'held blocks in consecutive slots: one read');
  // Unaligned: partial first and last blocks are read-modify-write, the whole ones between one run.
  const odd = mib.slice(0, 5 * 4096 + 1000);
  assert.ok(await d.write(3 * (1 << 20) + 512, odd));
  assert.equal(calls['data.write'], 2 + 3, 'two edge blocks and one run');
  const got = (await d.read(3 * (1 << 20) + 512, odd.length)) as Uint8Array;
  assert.equal(Buffer.compare(got, odd), 0);
  assert.equal(Buffer.compare((await d.read(3 * (1 << 20), 512)) as Uint8Array, baseBytes.subarray(3 << 20, (3 << 20) + 512)), 0, 'the bytes before the write are the base');
  const [dw, mw] = [calls['data.write'], calls['map.write']];
  assert.ok(await d.write(2 << 20, new Uint8Array(4096).fill(1)));
  assert.ok(await d.write(5 << 20, new Uint8Array(4096).fill(2)));
  assert.deepEqual([calls['data.write'] - dw, calls['map.write'] - mw], [2, 2], "a fresh block in a leaf there is (its entry), and one in a new leaf (its making, with the entry): one map write each");
});

test("blocks() reads a list of held blocks as block() does, those in consecutive slots in one read", async () => {
  const size = 8 << 20;
  const base = openDisk((off, len) => new Uint8Array(len).fill(0xee), size);
  const [log, calls]: [{ file: string; at: number; bytes: Uint8Array }[], Record<string, number>] = [[], {}];
  const data = logged('data', log, calls);
  const d = overlay(base, data, logged('map', log, calls));
  const fill = (b: number) => new Uint8Array(4096).fill((b * 37 + 11) & 255);
  // Slots in another order than the blocks: 10-13 in one write (slots 0-3), then 4 and 5 (slots 4, 5), 14 (slot 6),
  // 2000 and 3 across leaves (slots 7, 8); 20-22 zeroed (no slot).
  for (const [b, n] of [[10, 4], [4, 1], [5, 1], [14, 1], [2000, 1], [3, 1]] as const) {
    assert.ok(await d.write(b * 4096, new Uint8Array(Buffer.concat(Array.from({ length: n }, (_, k) => fill(b + k))))));
  }
  assert.ok(await d.zero(20 * 4096, 3 * 4096));
  const list = [...d.written()];
  assert.deepEqual(list, [3, 4, 5, 10, 11, 12, 13, 14, 20, 21, 22, 2000]);
  const each = Buffer.concat(list.map((b) => d.block(b)!));
  const reads = calls['data.read'] ?? 0;
  const got = d.blocks!(list);
  assert.ok(got && Buffer.compare(got, each) === 0, 'the blocks as block() reads them');
  // Their slots in the list's order: 8 | 4 5 | 0 1 2 3 | 6 | (zeros) | 7 (14's slot is 6, not 4: a read of its own).
  assert.equal(calls['data.read'] - reads, 5, 'one read per run of consecutive slots');
  // Any order, a list in another order than the slots', a single block.
  const shuffled = [2000, 13, 12, 21, 4, 5];
  const some = d.blocks!(shuffled);
  assert.ok(some && Buffer.compare(some, Buffer.concat(shuffled.map((b) => d.block(b)!))) === 0, 'a list in another order');
  const one = d.blocks!([11]);
  assert.ok(one && Buffer.compare(one, fill(11)) === 0, 'a single block');
  assert.equal(d.blocks!([3, 7])?.length, undefined, 'a block the overlay doesn\'t hold');
  const reading = data.read;
  data.read = () => 0;
  assert.equal(d.blocks!([10, 11]), undefined, 'a failed read');
  data.read = reading;
});

test('random writes, discards and reads of every shape match a model, across reopens', async () => {
  const g = splitmix64(11n);
  const rand = (n: number) => Number(g.next().value as bigint % BigInt(n));
  const size = 300 * 4096 + 1024;
  const baseBytes = Uint8Array.from({ length: size }, () => rand(256));
  const base = openDisk((off, len) => baseBytes.slice(off, off + len), size);
  const [data, map] = [memFile(), memFile()];
  let d = overlay(base, data, map);
  const model = baseBytes.slice();
  for (let i = 0; i < 400; i++) {
    const off = rand(size / 512) * 512;
    const len = Math.min(size - off, (rand(rand(3) ? 20 : 400) + 1) * 512);
    const op = rand(8);
    if (op < 4) {
      const bytes = Uint8Array.from({ length: len }, () => rand(256));
      assert.ok(await d.write(off, bytes));
      model.set(bytes, off);
    } else if (op === 4) {
      assert.ok(d.discard(off, len));
      for (let b = Math.ceil(off / 4096); b < (off + len === size ? Math.ceil(size / 4096) : Math.floor((off + len) / 4096)); b++) if (d.zeroed(b)) model.fill(0, b * 4096, (b + 1) * 4096);
    } else {
      assert.equal(Buffer.compare((await d.read(off, len)) as Uint8Array, model.subarray(off, off + len)), 0, `read ${off}+${len} at step ${i}`);
    }
    if (i % 90 === 89) d = overlay(base, data, map);
  }
  assert.equal(Buffer.compare((await d.read(0, size)) as Uint8Array, model), 0);
});

test('a crash after any single OPFS write leaves every block as the base or something the guest wrote', async () => {
  const size = 64 * 4096;
  const baseBytes = new Uint8Array(size).fill(0xee);
  const base = openDisk((off, len) => baseBytes.slice(off, off + len), size);
  const [log, calls]: [{ file: string; at: number; bytes: Uint8Array }[], Record<string, number>] = [[], {}];
  const d = overlay(base, logged('data', log, calls), logged('map', log, calls));
  // Writes of one tag each (1..), over ranges that hit fresh and held blocks, runs and singles.
  const ranges: [number, number][] = [[0, 8], [4, 8], [20, 1], [30, 16], [10, 3], [2, 40], [50, 6], [21, 2]];
  for (const [i, [b, n]] of ranges.entries()) assert.ok(await d.write(b * 4096, new Uint8Array(n * 4096).fill(i + 1)));
  const tags = new Set([0xee, ...ranges.map((_, i) => i + 1)]);
  for (let k = 0; k <= log.length; k++) {
    const [data, map] = [memFile(), memFile()];
    for (const w of log.slice(0, k)) (w.file === 'data' ? data : map).write(w.bytes, { at: w.at });
    const r = overlay(base, data, map);
    const all = (await r.read(0, size)) as Uint8Array;
    for (let b = 0; b < 64; b++) {
      const blk = all.subarray(b * 4096, (b + 1) * 4096);
      assert.ok(tags.has(blk[0]) && blk.every((x) => x === blk[0]), `after ${k} of ${log.length} writes, block ${b} is neither the base nor a written block`);
    }
  }
});

test('a compaction that fails part way keeps the slots its moves freed: the next writes take them before the file grows', async () => {
  const size = 400 * 4096;
  const base = openDisk((off, len) => new Uint8Array(len).fill(7), size);
  const [data, inner] = [memFile(), memFile()];
  let refuseIn = Infinity; // the map write that is refused, counted down
  const map = { ...inner, write: (b: Uint8Array, o: { at: number }) => (--refuseIn === 0 ? 0 : inner.write(b, o)) };
  const d = overlay(base, data, map);
  for (let b = 0; b < 100; b++) assert.ok(await d.write(b * 4096, new Uint8Array(4096).fill(b + 1)));
  assert.ok(d.discard(0, 50 * 4096)); // 50 free slots: below what a change compacts for
  assert.equal(data.getSize(), 100 * 4096);
  refuseIn = 3; // the third move's entry (its write back after it lands)
  assert.equal(d.compact!(), false, 'refused');
  refuseIn = Infinity;
  for (let b = 0; b < 100; b++) {
    const want = b < 50 ? 0 : b + 1;
    for (const disk of [d, overlay(base, data, map)]) assert.equal((await disk.read(b * 4096, 1))![0], want, `block ${b}`);
  }
  // 98 blocks are held in 100 slots: 50 fresh writes fill the free ones and two more.
  for (let b = 200; b < 250; b++) assert.ok(await d.write(b * 4096, new Uint8Array(4096).fill(b - 100)));
  assert.equal(data.getSize(), 100 * 4096, `${data.getSize() / 4096} slots for 100 blocks`);
  for (let b = 200; b < 250; b++) assert.equal((await overlay(base, data, map).read(b * 4096, 1))![0], b - 100);
});

/**
 * The overlay's files under a crash where the OS wrote back only some of what wasn't flushed: each file's operations
 * (writes, truncations, flushes) logged in the order made across both, to replay what a crash after any of them leaves
 * with one file as written and the other as of its last flush (the two orders the OS may have written them in).
 */
function crashLog() {
  const ops: { file: 'data' | 'map'; op: 'write' | 'truncate' | 'flush'; at?: number; bytes?: Uint8Array; size?: number }[] = [];
  const logged = (file: 'data' | 'map') => {
    const f = memFile();
    return Object.assign(f, {
      write: ((w) => (buf: Uint8Array, o: { at: number }) => { ops.push({ file, op: 'write', at: o.at, bytes: buf.slice() }); return w(buf, o); })(f.write),
      truncate: ((t) => (size: number) => { ops.push({ file, op: 'truncate', size }); t(size); })(f.truncate),
      flush: () => { ops.push({ file, op: 'flush' }); },
    });
  };
  /** The files after the first `k` operations, with `lagging`'s writes since its last flush lost. */
  const after = (k: number, lagging: 'data' | 'map') => {
    const files = { data: memFile(), map: memFile() };
    const last = ops.slice(0, k).findLastIndex((o) => o.file === lagging && o.op === 'flush');
    ops.slice(0, k).forEach((o, i) => {
      if (o.file === lagging && i > last) return;
      if (o.op === 'write') files[o.file].write(o.bytes!, { at: o.at! });
      else if (o.op === 'truncate') files[o.file].truncate(o.size!);
    });
    return files;
  };
  return { ops, data: logged('data'), map: logged('map'), after };
}

test('ordered: a crash where the OS wrote back either file before the other (power loss) leaves every block readable, as the base, zeros it was given, or something written to it', async () => {
  const blocks = 96;
  const size = blocks * 4096;
  const base = openDisk((off, len) => new Uint8Array(len).fill(0xee), size);
  /** Block `b`'s `v`-th write: its number and the version in every u32. */
  const tag = (b: number, v: number) => new Uint8Array(new Uint32Array(1024).fill((b << 8) | v).buffer);
  const failures = (ordered: boolean) => {
    const log = crashLog();
    const d = overlay(base, log.data, log.map, undefined, 0, { ordered });
    const may = new Map<number, Set<number>>(); // what each block may read as: u32s
    const allow = (b: number, x: number) => { if (!may.has(b)) may.set(b, new Set([0xeeeeeeee])); may.get(b)!.add(x); };
    let v = 0;
    const run = async () => {
      const put = async (b: number, n: number) => {
        v++;
        const bytes = new Uint8Array(n * 4096);
        for (let k = 0; k < n; k++) { bytes.set(tag(b + k, v), k * 4096); allow(b + k, ((b + k) << 8) | v); }
        assert.ok(await d.write(b * 4096, bytes));
      };
      const trim = (b: number, n: number) => { for (let k = 0; k < n; k++) allow(b + k, 0); assert.ok(d.discard(b * 4096, n * 4096)); };
      await put(0, 16); await put(20, 30); await put(60, 4); // fresh slots
      trim(0, 12); trim(24, 20); // freed slots
      await put(70, 20); await put(5, 3); // the freed slots reused
      d.flush();
      trim(70, 18); // half free: compacted, the end cut off
      await put(50, 4); await put(90, 6);
      assert.ok(d.compact!());
      await put(1, 2);
    };
    return run().then(async () => {
      let bad = 0;
      for (let k = 0; k <= log.ops.length; k++) {
        for (const lagging of ['data', 'map'] as const) {
          const f = log.after(k, lagging);
          const all = await overlay(base, f.data, f.map, undefined, 0, { ordered }).read(0, size);
          if (!all) { bad++; continue; }
          const u = new Uint32Array(all.buffer);
          for (let b = 0; b < blocks; b++) {
            const x = u[b * 1024];
            if (!(may.get(b) ?? new Set([0xeeeeeeee])).has(x) || !u.subarray(b * 1024, (b + 1) * 1024).every((y) => y === x)) { bad++; break; }
          }
        }
      }
      return { bad, ops: log.ops.length, flushes: log.ops.filter((o) => o.op === 'flush').length };
    });
  };
  const on = await failures(true);
  assert.equal(on.bad, 0, `ordered: ${on.bad} of ${2 * (on.ops + 1)} crash points leave a block unreadable or another's (${on.flushes} flushes)`);
  const off = await failures(false);
  assert.ok(off.bad > 0, 'unordered: the test sees the hazard');
});

test("the overlay's generation moves once per opening, before its first change, and not for an opening that only reads", async () => {
  const size = 16 * 4096;
  const base = openDisk((off, len) => new Uint8Array(len), size);
  const [data, map, meta] = [memFile(), memFile(), memFile()];
  let d = overlay(base, data, map, meta);
  assert.equal(d.generation(), 0);
  await d.read(0, 4096);
  assert.equal(readMeta(meta).generation, 0, 'reads change nothing');
  assert.ok(await d.write(0, new Uint8Array(4096).fill(1)));
  assert.equal(readMeta(meta).generation, 1, 'on disk before the write returns');
  assert.ok(await d.write(4096, new Uint8Array(4096).fill(2)));
  assert.ok(d.discard(0, 4096));
  assert.equal(d.generation(), 1, 'once per opening');
  d = overlay(base, data, map, meta); // the next boot
  assert.equal(d.generation(), 1);
  await d.read(0, size);
  d = overlay(base, data, map, meta);
  assert.ok(await d.zero(0, 8192));
  assert.equal(readMeta(meta).generation, 2, 'a zeroing is a change');
  d = overlay(base, data, map, meta);
  assert.ok(d.discard(8192, 4096));
  assert.equal(readMeta(meta).generation, 3, 'a discard is a change');
  // The merging marker shares the file and survives a bump.
  assert.ok(writeMeta(meta, { generation: 3, merging: 'c00000000001', size: 0 }));
  d = overlay(base, data, map, meta);
  assert.ok(await d.write(0, new Uint8Array(512)));
  assert.deepEqual(readMeta(meta), { generation: 4, merging: 'c00000000001', size: 0 });
  assert.deepEqual(readMeta(memFile()), { generation: 0, merging: '', size: 0 });
});

test('writes the storage refuses at random (growing data or map, short or thrown) fail alone: what the overlay reads is what its files say, each block old or new', async () => {
  for (let seed = 1n; seed <= 16n; seed++) await refusedAtRandom(seed);
});

test("the same across leaves (4 MiB each): a leaf's making refused too", async () => {
  for (let seed = 101n; seed <= 104n; seed++) await refusedAtRandom(seed, 2148 * 4096, 120);
});

/** Random writes, zeroings and discards, some refused, each checked against the files reopened and a model. */
async function refusedAtRandom(seed: bigint, size = 500 * 4096, steps = 300) {
  const g = splitmix64(seed);
  const rand = (n: number) => Number(g.next().value as bigint % BigInt(n));
  const baseBytes = Uint8Array.from({ length: size }, (_, k) => (k * 2654435761) >>> 24);
  const base = openDisk((off, len) => baseBytes.slice(off, off + len), size);
  let refusing = 0; // out of 8: how often a write that grows a file is refused
  /** A memory file whose growing writes the "storage" refuses while `refusing`: short (any prefix, or nothing) or thrown. */
  const refusable = () => {
    const f = memFile();
    return Object.assign(f, {
      write: ((write) => (buf: Uint8Array, o: { at: number }) => {
        // Only a write that grows the file needs room (an overwrite inside it lands, as on OPFS past the quota).
        if (o.at + buf.length <= f.getSize() || rand(8) >= refusing) return write(buf, o);
        const how = rand(3);
        if (how === 0) throw new DOMException('No space available for this operation', 'QuotaExceededError');
        if (how === 1) return 4294967288; // off the record (Chromium 153, OPFS in memory): an error code as the count
        const part = rand(buf.length); // a torn map entry too
        return part ? write(buf.subarray(0, part), o) : 0;
      })(f.write),
    });
  };
  const [data, map] = [refusable(), refusable()];
  const d = overlay(base, data, map);
  const model = baseBytes.slice();
  const same = (a: Uint8Array, b: Uint8Array) => Buffer.compare(a, b) === 0;
  for (let i = 0; i < steps; i++) {
    refusing = i % 100 < 40 ? 0 : 3; // stretches with room, and stretches nearly full
    const off = rand(size / 512) * 512;
    const len = Math.min(size - off, (rand(rand(3) ? 16 : 200) + 1) * 512);
    const op = ['write', 'zero', 'discard'][Math.min(rand(4), 2)];
    const fill = rand(1 << 30);
    const want = op === 'write' ? Uint8Array.from({ length: len }, (_, k) => ((k + fill) * 2246822519) >>> 24) : new Uint8Array(len);
    const ok = op === 'write' ? await d.write(off, want) : op === 'zero' ? await d.zero(off, len) : d.discard(off, len);
    refusing = 0;
    const now = (await d.read(0, size))!;
    const what = `seed ${seed}, step ${i} (${op} of ${off}+${len}, ${ok ? 'landed' : 'refused'})`;
    assert.ok(same(now, (await overlay(base, data, map).read(0, size))!), `${what}: the overlay reads otherwise than its files`);
    // Outside the request, nothing moved; inside, each sector is as it was or as asked (a discard's whole blocks: zeros).
    assert.ok(same(now.subarray(0, off), model.subarray(0, off)) && same(now.subarray(off + len), model.subarray(off + len)), `${what}: bytes outside it changed`);
    if (ok && op !== 'discard') assert.ok(same(now.subarray(off, off + len), want), `${what}: not as written`);
    for (let at = off; at < off + len; at += 512) {
      const x = now.subarray(at, at + 512);
      assert.ok(same(x, model.subarray(at, at + 512)) || same(x, want.subarray(at - off, at - off + 512)), `${what}: sector ${at / 512} is neither old nor new`);
    }
    model.set(now);
  }
}

test('a grown overlay (its own size in its meta): past its base it reads zeros, takes writes, zeroings and discards to its end, and keeps them reopened', async () => {
  const baseSize = 3 * 4096 + 1024; // a last block that isn't whole
  const size = 16 * 4096;
  const baseBytes = Uint8Array.from({ length: baseSize }, (_, k) => 1 + (k % 251));
  const base = openDisk((off, len) => baseBytes.slice(off, off + len), baseSize);
  const [data, map, meta] = [memFile(), memFile(), memFile()];
  assert.ok(writeMeta(meta, { generation: 0, merging: '', size }));
  let d = overlay(base, data, map, meta);
  assert.equal(d.size, size, "its meta's size");
  const whole = (await d.read(0, size))!;
  assert.equal(Buffer.compare(whole.subarray(0, baseSize), baseBytes), 0, 'the base, where it is');
  assert.ok(whole.subarray(baseSize).every((x) => x === 0), 'zeros past it');
  assert.equal(await d.read(size - 512, 1024), undefined, 'nothing past its end');
  // A write across the base's old end, one at the grown end, a zeroing and a discard past the base.
  assert.ok(await d.write(baseSize - 100, new Uint8Array(200).fill(0xaa)));
  assert.ok(await d.write(size - 4096, new Uint8Array(4096).fill(0xbb)));
  assert.ok(await d.write(8 * 4096, new Uint8Array(3 * 4096).fill(0xcc)));
  assert.ok(await d.zero(9 * 4096, 4096));
  assert.ok(d.discard(10 * 4096, 4096));
  assert.ok(map.getSize() >= 16 * 4, 'the map grew to the blocks past the base');
  const want = new Uint8Array(size);
  want.set(baseBytes);
  want.fill(0xaa, baseSize - 100, baseSize + 100);
  want.fill(0xbb, size - 4096);
  want.fill(0xcc, 8 * 4096, 9 * 4096);
  assert.equal(readMeta(meta).size, size, 'a change keeps the size');
  d = overlay(base, data, map, meta); // reopened
  assert.equal(d.size, size);
  assert.equal(Buffer.compare((await d.read(0, size))!, want), 0, 'reopened, it reads what was written');
  assert.deepEqual([...d.written()], [3, 8, 9, 10, 15]);
  // Without a meta, the guest's size given grows it the same way; a size under the base's is the base's.
  assert.equal(overlay(base, data, map, undefined, size).size, size);
  assert.equal(Buffer.compare((await overlay(base, data, map, undefined, size).read(0, size))!, want), 0);
  assert.equal(overlay(base, memFile(), memFile(), undefined, 4096).size, baseSize);
});

test("a meta file of 32 bytes (from before sizes) reads as no size of its own, and a change keeps its generation and merging", async () => {
  const meta = memFile();
  const old = encodeMeta({ generation: 5, merging: 'c00000000001', size: 0 }).subarray(0, 32);
  meta.write(old, { at: 0 });
  assert.equal(meta.getSize(), 32);
  assert.deepEqual(readMeta(meta), { generation: 5, merging: 'c00000000001', size: 0 });
  const base = openDisk((off, len) => new Uint8Array(len), 8192);
  const d = overlay(base, memFile(), memFile(), meta);
  assert.equal(d.size, 8192, "the base's");
  assert.ok(await d.write(0, new Uint8Array(512).fill(1)));
  assert.deepEqual(readMeta(meta), { generation: 6, merging: 'c00000000001', size: 0 });
});

test('writeOwnSize gives an overlay its size (made if it has no files yet), its generation as it was; a disk grown reads zeros past its base', async () => {
  const name = `overlays/grown-${process.pid}`;
  const f = await openOverlay(name, 'grown-base');
  const base = openDisk((off, len) => new Uint8Array(len).fill(7), 8192);
  assert.ok(await overlay(base, f.data, f.map, f.meta).write(0, new Uint8Array(4096).fill(1)));
  f.close();
  const release = await lockOverlay(name);
  await writeOwnSize(name, 65536);
  release();
  assert.deepEqual(await overlayMeta(name), { generation: 1, merging: '', size: 65536 });
  const g = await openOverlay(name, 'grown-base');
  const d = overlay(base, g.data, g.map, g.meta);
  assert.equal(d.size, 65536);
  assert.deepEqual([...(await d.read(4096 - 1, 3))!], [1, 7, 7]);
  assert.ok((await d.read(8192, 65536 - 8192))!.every((x) => x === 0));
  g.close();
  // An overlay without files yet (a record the page made, a machine never opened).
  const fresh = `overlays/grown-fresh-${process.pid}`;
  await writeOwnSize(fresh, 1 << 20);
  assert.equal((await overlayMeta(fresh)).size, 1 << 20);
  const h = await openOverlay(fresh, 'fresh-base');
  assert.equal(overlay(base, h.data, h.map, h.meta).size, 1 << 20);
  h.close();
  const z = grown(base, 3 * 4096);
  assert.deepEqual([...(await z.read(8192 - 2, 4))!], [7, 7, 0, 0]);
  assert.equal(grown(base, 4096), base, 'not smaller');
});

test("the variable store is rewritten in place: a full storage leaves the old one whole, a first save's short write none", () => {
  // A storage with no room left: a write that would grow the file is refused (thrown, or cut short).
  for (const how of ['short', 'throws'] as const) {
    const file = memFile();
    let full = false;
    const f = Object.assign(memFile(), {
      read: file.read.bind(file), getSize: file.getSize.bind(file), truncate: file.truncate.bind(file), flush: file.flush.bind(file),
      write: (buf: Uint8Array, o: { at: number }) => {
        if (!full || o.at + buf.length <= file.getSize()) return file.write(buf, o);
        if (how === 'short') return file.write(buf.subarray(0, Math.max(0, file.getSize() - o.at)), o);
        throw new DOMException('No space available for this operation', 'QuotaExceededError');
      },
    });
    writeWhole(f, new Uint8Array(8192).fill(1));
    full = true;
    writeWhole(f, new Uint8Array(8192).fill(2)); // the same size: in place, no room needed
    assert.ok(file.bytes().every((x) => x === 2) && file.getSize() === 8192, `${how}: rewritten`);
    assert.throws(() => writeWhole(f, new Uint8Array(12288).fill(3)), /storage is full/, `${how}: a bigger one refused`);
    assert.equal(file.getSize(), 8192, `${how}: the old length kept`);
    assert.ok(file.bytes().every((x) => x === 2), `${how}: the old store whole, not half new`);
    const empty = memFile();
    const g = Object.assign(memFile(), {
      read: empty.read.bind(empty), getSize: empty.getSize.bind(empty), truncate: empty.truncate.bind(empty), flush: empty.flush.bind(empty),
      write: (buf: Uint8Array, o: { at: number }) => empty.write(buf.subarray(0, 100), o),
    });
    assert.throws(() => writeWhole(g, new Uint8Array(8192).fill(4)), /storage is full/);
    assert.equal(empty.getSize(), 0, `${how}: no half store (it would load as one)`);
  }
});

// A bulk fill's mark (docs/devices.md "Crash and refusal"; review disk-writes 1, 2, 4): an overlay a restore or an
// Import changes was cut off in is never read as what it holds part of.
test("an overlay a fill was cut off in (its meta's mark) opens empty: a writer's empties it, its generation moved on; a reader's sees none of it; a fill's own opening empties it first under its lock", async () => {
  const name = `overlays/cut-${process.pid}`;
  const base = openDisk((off, len) => new Uint8Array(len).fill(7), 16 * 4096);
  const f = await openOverlay(name, 'cut-base', undefined, { fresh: { size: 0 } });
  assert.deepEqual(readMeta(f.meta), { generation: 1, merging: '', size: 0, filling: true }, 'marked, one past, by the opening');
  const d = overlay(base, f.data, f.map, undefined, 0, { ordered: false });
  assert.ok(await d.write(3 * 4096, new Uint8Array(4096).fill(0xaa)));
  d.flush();
  f.close(); // cut off: the mark stays
  assert.deepEqual(await overlayMeta(name), { generation: 1, merging: '', size: 0, filling: true });
  const r = await openOverlay(name, undefined, undefined, { readOnly: true });
  assert.deepEqual([...overlay(base, r.data, r.map).written()], [], 'a reader sees none of it');
  r.close();
  const w = await openOverlay(name, 'cut-base');
  const o = overlay(base, w.data, w.map, w.meta);
  assert.deepEqual([...o.written()], [], 'a writer sees none of it');
  assert.ok((await o.read(3 * 4096, 4096))!.every((x) => x === 7), 'block 3 reads as the base');
  w.close();
  assert.deepEqual(await overlayMeta(name), { generation: 2, merging: '', size: 0 }, 'emptied, unmarked, its generation moved on');
  // A fill that ends clears the mark; its blocks stay.
  const g = await openOverlay(name, 'cut-base', undefined, { fresh: { size: 0 } });
  assert.deepEqual(await overlayMeta(name), { generation: 3, merging: '', size: 0, filling: true }, 'a fresh opening marks it one past its generation, then empties it');
  const e = overlay(base, g.data, g.map, undefined, 0, { ordered: false });
  assert.ok(await e.write(5 * 4096, new Uint8Array(4096).fill(0xbb)));
  e.flush();
  assert.ok(endFill(g.meta));
  g.close();
  const h = await openOverlay(name, 'cut-base');
  assert.deepEqual([...overlay(base, h.data, h.map).written()], [5]);
  h.close();
  assert.deepEqual(await overlayMeta(name), { generation: 3, merging: '', size: 0 });
});

test("a meta of 40 bytes (from before the fill mark) reads as no mark and stays 40 bytes; the mark makes it 48, cleared it reads as none", () => {
  const meta = memFile();
  meta.write(encodeMeta({ generation: 4, merging: '', size: 8192 }).subarray(0, 40), { at: 0 });
  assert.deepEqual(readMeta(meta), { generation: 4, merging: '', size: 8192 });
  assert.ok(writeMeta(meta, { generation: 5, merging: '', size: 8192 }));
  assert.equal(meta.getSize(), 40, 'no growth without a mark');
  assert.ok(writeMeta(meta, { generation: 5, merging: '', size: 8192, filling: true }));
  assert.equal(meta.getSize(), 48);
  assert.deepEqual(readMeta(meta), { generation: 5, merging: '', size: 8192, filling: true });
  assert.ok(endFill(meta));
  assert.deepEqual(readMeta(meta), { generation: 5, merging: '', size: 8192 });
});

// Review restore-records 1, 3, 4 (PERF loop 84): a restore's fill leaves its token in the meta; the first change of any
// later opening clears it, so it proves that nothing but the fill wrote the overlay since; the fill's opening writes
// its meta (moved on, marked) before it deletes anything, so a fill cut off at any point never goes back a generation.
test("a fill's token: written with its mark before the overlay is emptied, kept when the mark is cleared, cleared by a writer's first change; a meta from before tokens reads as none", async () => {
  const name = `overlays/token-${process.pid}`;
  const base = openDisk(() => new Uint8Array(4096), 16 * 4096);
  const before = await openOverlay(name, 'tok-base');
  assert.ok(writeMeta(before.meta, { generation: 6, merging: '', size: 0 }));
  before.close();
  await navigator.locks.request(overlayLock(name), async () => {});
  const f = await openOverlay(name, 'tok-base', undefined, { fresh: { size: 0, token: 'aa11bb22cc33' } });
  assert.deepEqual(readMeta(f.meta), { generation: 7, merging: '', size: 0, filling: true, token: 'aa11bb22cc33' });
  assert.equal(f.meta.getSize(), 64);
  assert.ok(endFill(f.meta));
  f.close();
  await navigator.locks.request(overlayLock(name), async () => {});
  assert.deepEqual(await overlayMeta(name), { generation: 7, merging: '', size: 0, token: 'aa11bb22cc33' }, 'the fill done: its token stays');
  const r = await openOverlay(name, 'tok-base'); // an opening that only reads
  assert.ok(await overlay(base, r.data, r.map, r.meta).read(0, 4096));
  r.close();
  await navigator.locks.request(overlayLock(name), async () => {});
  assert.equal((await overlayMeta(name)).token, 'aa11bb22cc33', 'a read leaves it');
  const w = await openOverlay(name, 'tok-base');
  assert.ok(await overlay(base, w.data, w.map, w.meta).write(0, new Uint8Array(4096).fill(1)));
  w.close();
  await navigator.locks.request(overlayLock(name), async () => {});
  assert.deepEqual(await overlayMeta(name), { generation: 8, merging: '', size: 0 }, "a writer's first change clears it");
  const old = memFile();
  old.write(encodeMeta({ generation: 2, merging: '', size: 0, filling: true }).subarray(0, 48), { at: 0 });
  assert.deepEqual(readMeta(old), { generation: 2, merging: '', size: 0, filling: true }, '48 bytes: no token');
});

// Review disk-writes 6: a raw sync handle throws past the quota where a wrapped one comes back short.
test('writeMeta on a file whose write throws QuotaExceededError is a refusal (false), so withRoom makes room and tries again', async () => {
  const meta = memFile();
  let refuse = 1;
  const thrower = { ...meta, write: (b: Uint8Array, o: { at: number }) => { if (refuse-- > 0) throw new DOMException('full', 'QuotaExceededError'); return meta.write(b, o); } };
  let asked = 0;
  const lands = withRoom(async () => { asked++; return true; });
  assert.ok(await lands(() => writeMeta(thrower, { generation: 1, merging: '', size: 0, filling: true })));
  assert.equal(asked, 1, 'room made once');
  assert.deepEqual(readMeta(meta), { generation: 1, merging: '', size: 0, filling: true });
  const other = { ...meta, write: () => { throw new DOMException('gone', 'NotFoundError'); } };
  assert.throws(() => writeMeta(other, { generation: 2, merging: '', size: 0 }), /gone/, 'other errors are thrown');
});

// Review disk-writes 4: what an import or Import changes cut off left (no record, still marked) is removed at the page's
// start; never one a fill holds now, one a record names, or one not marked.
test('dropCutFill removes a store or overlay only when marked, its lock free and no record names it', async () => {
  const mk = async (name: string, filling: boolean) => {
    const f = await openOverlay(name, 'x', undefined, { fresh: { size: 0 } });
    assert.ok(writeMeta(f.meta, { generation: 1, merging: '', size: 0, filling }));
    f.close();
    await navigator.locks.request(overlayLock(name), async () => {}); // its lock let go (a release lands a moment later)
  };
  const p = process.pid;
  await mk(`disks/cut-a-${p}`, true);
  assert.equal(await dropCutFill(`disks/cut-a-${p}`, async () => false), false, 'a record names it');
  assert.equal((await overlayMeta(`disks/cut-a-${p}`)).filling, true);
  assert.equal(await dropCutFill(`disks/cut-a-${p}`, async () => true), true);
  assert.deepEqual(await overlayMeta(`disks/cut-a-${p}`), { generation: 0, merging: '', size: 0 }, 'gone');
  await mk(`disks/cut-b-${p}`, false);
  assert.equal(await dropCutFill(`disks/cut-b-${p}`, async () => true), false, 'not marked: a job done, its record to come');
  await mk(`disks/cut-c-${p}`, true);
  const held = await openOverlay(`disks/cut-c-${p}`, 'x');
  try {
    // A fill holds its lock: opened under it, the mark is the fill's own (here a writer's opening would empty it, so
    // the mark is set again while held).
    assert.ok(writeMeta(held.meta, { generation: 2, merging: '', size: 0, filling: true }));
    assert.equal(await dropCutFill(`disks/cut-c-${p}`, async () => true), false, 'in use: a fill that runs');
  } finally {
    held.close();
  }
});
