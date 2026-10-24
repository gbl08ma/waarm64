// The ramdisk (web/ramdisk.ts, docs/plans/machines.md §4.3) against a plain byte array: reads,
// writes, zeroes and discards across chunk edges, and the chunks given back.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RAM_CHUNK, ramDisk } from '../web/ramdisk.ts';
import { splitmix64 } from '../tools/corpus/corpus.ts';

test('the ramdisk reads what was written and zeros elsewhere, and gives whole chunks back when they are discarded or zeroed', async () => {
  const g = splitmix64(5n);
  const rand = (n: number) => Number(g.next().value as bigint % BigInt(n));
  const size = 5 * RAM_CHUNK + 512 * 7; // a partial last chunk
  const d = ramDisk(size);
  assert.equal(d.chunks(), 0, 'empty costs nothing');
  const all0 = await d.read(0, size);
  assert.ok(all0!.every((x) => x === 0));
  const model = new Uint8Array(size);
  for (let i = 0; i < 400; i++) {
    const off = rand(size / 512) * 512;
    const len = Math.min(size - off, (rand(600) + 1) * 512);
    const op = rand(4);
    if (op === 0) {
      const bytes = Uint8Array.from({ length: len }, () => 1 + rand(255));
      assert.ok(await d.write(off, bytes));
      model.set(bytes, off);
    } else if (op === 1) {
      assert.ok(d.discard(off, len));
      model.fill(0, off, off + len);
    } else if (op === 2) {
      assert.ok(await d.zero(off, len));
      model.fill(0, off, off + len);
    } else {
      const got = await d.read(off, len);
      assert.ok(got && Buffer.compare(got, model.subarray(off, off + len)) === 0, `read ${off}+${len} at step ${i}`);
    }
  }
  const got = await d.read(0, size);
  assert.ok(got && Buffer.compare(got, model) === 0);
  // The blocks a snapshot carries: exactly the non-zero ones, with their bytes.
  const nonzero = [];
  for (let b = 0; b * 4096 < size; b++) if (model.subarray(b * 4096, (b + 1) * 4096).some((x) => x !== 0)) nonzero.push(b);
  assert.deepEqual(d.written(), nonzero);
  for (const b of nonzero.slice(0, 20)) {
    const want = new Uint8Array(4096);
    want.set(model.subarray(b * 4096, Math.min(size, (b + 1) * 4096)));
    assert.equal(Buffer.compare(d.block(b)!, want), 0);
  }
  assert.ok(d.chunks() > 0);
  // fstrim: everything discarded, nothing held.
  assert.ok(d.discard(0, size));
  assert.equal(d.chunks(), 0);
  assert.deepEqual(d.written(), []);
  // Out of range.
  assert.equal(await d.write(size - 512, new Uint8Array(1024)), false);
  assert.equal(await d.read(size, 1), undefined);
  assert.equal(d.discard(-512, 512), false);
});

test('past its budget of SharedArrayBuffers the ramdisk takes slots in wasm memories, reuses what is dropped, and a write it has no memory for fails', async () => {
  const size = 12 * RAM_CHUNK + 4096; // a partial last chunk
  let fulls = 0;
  const d = ramDisk(size, [], { sabBudget: 4 * RAM_CHUNK, onFull: () => fulls++ });
  const model = new Uint8Array(size);
  const g = splitmix64(9n);
  const fill = (n: number) => Uint8Array.from({ length: n }, () => 1 + Number(g.next().value as bigint % 255n));
  // Every chunk written: 4 of its own, 9 slots (the last one partial).
  for (let c = 0; c * RAM_CHUNK < size; c++) {
    const off = c * RAM_CHUNK + 512;
    const bytes = fill(Math.min(8192, size - off));
    assert.ok(await d.write(off, bytes));
    model.set(bytes, off);
  }
  assert.equal(d.chunks(), 13);
  assert.equal(d.arenaBytes(), 9 * RAM_CHUNK);
  let got = await d.read(0, size);
  assert.ok(got && Buffer.compare(got, model) === 0, 'reads back across both kinds');
  // A slot dropped and taken again reads as zeros but for what the new write put there; the memory doesn't grow.
  assert.ok(d.discard(10 * RAM_CHUNK, RAM_CHUNK));
  model.fill(0, 10 * RAM_CHUNK, 11 * RAM_CHUNK);
  assert.ok(d.discard(0, RAM_CHUNK)); // a SharedArrayBuffer's: the budget has room for one again
  model.fill(0, 0, RAM_CHUNK);
  assert.ok(await d.write(10 * RAM_CHUNK + 4096, Uint8Array.of(7)));
  model[10 * RAM_CHUNK + 4096] = 7;
  assert.ok(await d.write(5, Uint8Array.of(9)));
  model[5] = 9;
  assert.equal(d.arenaBytes(), 9 * RAM_CHUNK);
  got = await d.read(0, size);
  assert.ok(got && Buffer.compare(got, model) === 0, 'a reused slot is zeroed');
  assert.deepEqual(d.written().slice(0, 3), [0, 256, 257]);
  // Handed over (a restore), the chunks read the same in the ramdisk that takes them.
  const next = ramDisk(size, d.chunkList(), { sabBudget: 4 * RAM_CHUNK });
  assert.equal(d.chunks(), 0);
  got = await next.read(0, size);
  assert.ok(got && Buffer.compare(got, model) === 0, 'handed over');
  assert.equal(fulls, 0);
  // No memory to be had (no budget, no slots: WebAssembly.Memory refused): the write fails, and onFull is told once.
  const Memory = WebAssembly.Memory;
  try {
    (WebAssembly as { Memory: unknown }).Memory = function () { throw new RangeError('could not allocate memory'); };
    const e = ramDisk(size, [], { sabBudget: 0, onFull: () => fulls++ });
    assert.equal(await e.write(0, Uint8Array.of(1)), false);
    assert.equal(await e.write(RAM_CHUNK, Uint8Array.of(1)), false);
    assert.equal(fulls, 1);
    assert.equal(e.chunks(), 0);
  } finally {
    WebAssembly.Memory = Memory;
  }
});
