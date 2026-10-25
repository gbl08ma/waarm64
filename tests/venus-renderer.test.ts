// Venus's renderer module (vk/build.sh: virglrenderer's vkr over our null driver, target/vk/venus.wasm) in Node, on a
// 4 GiB shared memory as the VM's memory 0 is (web/venus-host.ts): vkr's capset is the one the device advertises
// (web/venus.ts), and a blob's bytes move into the host-visible window at its map and back out at its unmap. A guest
// drives it whole in tests/page-venus.test.ts.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { VenusRenderer } from '../web/venus-host.ts';
import { VENUS_CAPSET_WORDS } from '../web/venus.ts';

const MODULE = new URL('../target/vk/venus.wasm', import.meta.url);
const skip = !existsSync(MODULE) && 'SKIPPED: run vk/build.sh';

async function renderer() {
  const memory = new WebAssembly.Memory({ initial: 65536, maximum: 65536, shared: true });
  // A window of 1 MiB at 256 MiB, and an empty write-watch (no vCPUs, no pages) below it.
  const window = { at: 0x1000_0000, bytes: 1 << 20, watch: 0x0100_0000 };
  const v = await VenusRenderer.create(await WebAssembly.compile(readFileSync(MODULE)), memory, window);
  return { v, memory, window };
}

test("the renderer's capset is the one the device advertises", { skip }, async () => {
  const { v } = await renderer();
  assert.deepEqual([...new Uint32Array(v.capset.buffer, v.capset.byteOffset, v.capset.length / 4)], VENUS_CAPSET_WORDS);
});

test("a blob's bytes move into the window at its map and back at its unmap", { skip }, async () => {
  const { v, memory, window } = await renderer();
  v.call({ t: 'vctx', id: 7, create: true, name: 'test' });
  // Shared memory (blob id 0, mappable): vkr's own storage, in the arena at memory 0's top.
  v.call({ t: 'blob', ctx: 7, res: 3, mem: 2, flags: 1, blobId: 0n, size: 8192 });
  const storage = v.address(3);
  assert.ok(storage >= 0xf000_0000, `storage at ${storage.toString(16)}`);
  const u8 = new Uint8Array(memory.buffer);
  u8.set([1, 2, 3, 4], storage);
  v.call({ t: 'blob-map', res: 3, offset: 0x4000 });
  assert.equal(v.address(3), window.at + 0x4000);
  assert.deepEqual([...u8.subarray(window.at + 0x4000, window.at + 0x4004)], [1, 2, 3, 4], 'copied in');
  u8.set([9, 8], window.at + 0x4000 + 8190);
  v.call({ t: 'blob-unmap', res: 3 });
  assert.equal(v.address(3), storage);
  assert.deepEqual([...u8.subarray(storage + 8190, storage + 8192)], [9, 8], 'and back out');
  v.call({ t: 'blob-unref', res: 3 });
  assert.equal(v.address(3), 0);
  assert.equal(v.stats.contexts, 1);
});
