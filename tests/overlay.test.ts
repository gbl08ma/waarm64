// The copy-on-write overlay (web/overlay.ts) against a plain byte array, over
// in-memory files shaped like OPFS sync access handles.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { overlay, type SyncFile } from '../web/overlay.ts';
import { openDisk } from '../web/qcow2.ts';
import { splitmix64 } from '../tools/corpus/corpus.ts';

function memFile(): SyncFile & { bytes: () => Uint8Array } {
  let b = new Uint8Array(0);
  return {
    read: (buf, { at }) => { const n = Math.max(0, Math.min(buf.length, b.length - at)); buf.set(b.subarray(at, at + n)); return n; },
    write: (buf, { at }) => {
      if (at + buf.length > b.length) { const g = new Uint8Array(at + buf.length); g.set(b); b = g; }
      b.set(buf, at);
      return buf.length;
    },
    getSize: () => b.length,
    flush: () => {},
    bytes: () => b,
  };
}

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
