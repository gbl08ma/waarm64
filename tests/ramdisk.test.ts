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
