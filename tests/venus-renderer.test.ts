// Venus's renderer module (vk/build.sh: virglrenderer's vkr over our null driver, target/vk/venus.wasm) in Node, on a
// 4 GiB shared memory as the VM's memory 0 is (web/venus-host.ts): vkr's capset is the one the device advertises
// (web/venus.ts), a blob's bytes move into the host-visible window at its map and back out at its unmap, and what the
// driver advertises follows the WebGPU device's features and limits. A guest drives it whole in tests/page-venus.test.ts.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import type { GpuCaps } from '../web/venus-gpu.ts';
import { VenusRenderer } from '../web/venus-host.ts';
import { VENUS_CAPSET_WORDS } from '../web/venus.ts';

const MODULE = new URL('../target/vk/venus.wasm', import.meta.url);
const skip = !existsSync(MODULE) && 'SKIPPED: run vk/build.sh';

async function renderer(caps?: GpuCaps, options: { hold?: string[]; allFormats?: boolean } = {}) {
  const memory = new WebAssembly.Memory({ initial: 65536, maximum: 65536, shared: true });
  // A window of 1 MiB at 256 MiB, and an empty write-watch (no vCPUs, no pages) below it.
  const window = { at: 0x1000_0000, bytes: 1 << 20, watch: 0x0100_0000 };
  const v = await VenusRenderer.create(await WebAssembly.compile(readFileSync(MODULE)), memory, window, undefined, caps, undefined, options);
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

/** An adapter's features and limits as the G0 suite recorded them (bench/gpu/results/). */
function adapter(file: string, vendor: string): GpuCaps {
  const p = (JSON.parse(readFileSync(new URL(`../bench/gpu/results/${file}`, import.meta.url), 'utf8')) as { results: { params: { features: string[]; limits: Record<string, number> } }[] }).results[0].params;
  return { features: new Set(p.features), limits: p.limits, adapterInfo: { vendor } };
}

test("what the driver advertises follows the WebGPU device's features and limits", { skip }, async () => {
  const caps = async (c?: GpuCaps, options: { hold?: string[]; allFormats?: boolean } = {}) => {
    const { v, memory } = await renderer(c, options);
    const at = (v.raw.wgt_caps as () => number)() >>> 0;
    assert.ok(at, 'wgt_caps failed');
    const w = new Uint32Array(memory.buffer, at, 16);
    return {
      dim2D: w[0], invocations: w[1], sizeX: w[2], storageImages: w[3], sampledImages: w[4], storageRange: w[5], subgroupSize: w[6],
      subgroupOps: w[7], bc: w[8], extendedFormats: w[9], depthClamp: w[10], r16float: w[11], r16unorm: w[12], rg11b10: w[13], r32float: w[14], vendor: w[15],
    };
  };
  const SAMPLED = 0x1, STORAGE = 0x2, COLOR = 0x80, BLEND = 0x100, FILTER = 0x1000;
  const mac = await caps(adapter('2026-10-01-mac-m4-metal.json', 'apple'));
  const swiftshader = await caps(adapter('2026-10-01-vm-swiftshader.json', 'google'));
  const none = await caps();
  const nvidia = await caps(adapter('2026-10-01-vm-swiftshader.json', 'nvidia'));
  // The adapters' own limits (the Mac's Metal: 16384, 1024, 8, 48; SwiftShader's 8192, 256, 4, 16), WebGPU's defaults
  // without a device.
  assert.deepEqual([mac.dim2D, mac.invocations, mac.sizeX, mac.storageImages, mac.sampledImages, mac.storageRange], [16384, 1024, 1024, 8, 48, 4294967292]);
  assert.deepEqual([swiftshader.dim2D, swiftshader.invocations, swiftshader.sizeX, swiftshader.storageImages, swiftshader.sampledImages, swiftshader.storageRange], [8192, 256, 256, 4, 16, 1073741824]);
  assert.deepEqual([none.dim2D, none.invocations, none.storageImages, none.storageRange], [8192, 256, 4, 134217728]);
  // The adapter's maker as the device's vendor (Apple's, Google's; none known: 0), but never NVIDIA's: Venus's guest
  // driver then copies every WSI frame into a buffer, which isn't shared, and Vulkan's windows are black
  // (web/venus-gpu.ts `VENDORS`).
  assert.deepEqual([mac.vendor, swiftshader.vendor, none.vendor, nvidia.vendor], [0x106b, 0x1ae0, 0, 0]);
  // Subgroups of one invocation, basic operations only (the translator has none of WebGPU's yet).
  assert.deepEqual([mac.subgroupSize, mac.subgroupOps], [1, 1]);
  // Features: BC and depth clamp where the adapter has them; texture-formats-tier1 (the Mac's) adds the 16-bit normalized
  // formats and makes rg11b10ufloat renderable. Its storage formats and float32-blendable are held back by default
  // (web/venus-gpu.ts `HELD_FEATURES`: mpv's VA-API chroma on the M4, VK3 L4).
  assert.deepEqual([mac.bc, mac.depthClamp, swiftshader.bc, none.bc, none.depthClamp], [1, 1, 1, 0, 0]);
  assert.deepEqual([mac.extendedFormats, swiftshader.extendedFormats], [0, 0]);
  assert.equal(mac.r16float & (STORAGE | COLOR | BLEND | FILTER), COLOR | BLEND | FILTER);
  assert.equal(mac.r16unorm & (SAMPLED | STORAGE | COLOR | FILTER), SAMPLED | COLOR, 'r16unorm: unfilterable (WebGPU says so)');
  assert.equal(swiftshader.r16unorm, 0);
  assert.equal(mac.rg11b10 & (COLOR | BLEND), COLOR | BLEND);
  // float32-filterable (both adapters'): r32float filtered; not blended (float32-blendable held back).
  assert.equal(swiftshader.r32float & (FILTER | BLEND), FILTER);
  assert.equal(none.r32float & (FILTER | BLEND), 0);
  // `?gpu=vkformats=all`: the held features too (8- and 16-bit storage with tier1, 32-bit floats blended).
  const all = await caps(adapter('2026-10-01-mac-m4-metal.json', 'apple'), { allFormats: true });
  assert.equal(all.r16float & (STORAGE | COLOR | BLEND | FILTER), STORAGE | COLOR | BLEND | FILTER);
  assert.equal(all.r16unorm & (SAMPLED | STORAGE | COLOR | FILTER), SAMPLED | STORAGE | COLOR);
  assert.equal(all.r32float & (FILTER | BLEND), FILTER | BLEND);
  assert.equal(all.extendedFormats, 1);
  // `?gpu=vkhold=<feature>`: one of them held again.
  const one = await caps(adapter('2026-10-01-mac-m4-metal.json', 'apple'), { allFormats: true, hold: ['tier1-storage'] });
  assert.equal(one.r16float & STORAGE, 0);
  assert.equal(one.r32float & BLEND, BLEND);
});
