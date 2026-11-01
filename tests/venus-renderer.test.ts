// Venus's renderer module (vk/build.sh: virglrenderer's vkr over our null driver, target/vk/venus.wasm) in Node, on a
// 4 GiB shared memory as the VM's memory 1 is, its arena first (web/venus-host.ts): vkr's capset is the one the device advertises
// (web/venus.ts), a blob's bytes move into the host-visible window at its map and back out at its unmap, and what the
// driver advertises follows the WebGPU device's features and limits. A guest drives it whole in tests/page-venus.test.ts.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import type { GpuCaps, L9Suspect } from '../web/venus-gpu.ts';
import { VenusRenderer } from '../web/venus-host.ts';
import { VENUS_CAPSET_WORDS } from '../web/venus.ts';
import { VENUS_ARENA } from '../web/ram.ts';

const MODULE = new URL('../target/vk/venus.wasm', import.meta.url);
const skip = !existsSync(MODULE) && 'SKIPPED: run vk/build.sh';

async function renderer(caps?: GpuCaps, options: { hold?: string[]; heldFormats?: boolean; ycbcr?: boolean; l9?: L9Suspect[] } = {}) {
  const memory = new WebAssembly.Memory({ initial: 65536, maximum: 65536, shared: true });
  // A window of 1 MiB after the arena, and an empty write-watch (no vCPUs, no pages) past it.
  const window = { at: VENUS_ARENA, bytes: 1 << 20, watch: VENUS_ARENA + 0x1000_0000 };
  const v = await VenusRenderer.create(await WebAssembly.compile(readFileSync(MODULE)), memory, window, undefined, caps, undefined, options);
  return { v, memory, window };
}

test("the renderer's capset is the one the device advertises", { skip }, async () => {
  const { v } = await renderer();
  assert.deepEqual([...new Uint32Array(v.capset.buffer, v.capset.byteOffset, v.capset.length / 4)], VENUS_CAPSET_WORDS);
});

// A module built for memory 0 (its arena at the top, before memory 1) would write its data over the core's heap
// there, and one with another arena would grow its heap into the window: refused, by a missing `venus_arena_end`
// before it is instantiated, or by its value.
test('a renderer module built for another arena is refused', async () => {
  const memory = new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true });
  const old = new WebAssembly.Module(new Uint8Array([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0]));
  await assert.rejects(VenusRenderer.create(old, memory, { at: 0, bytes: 0, watch: 0 }), /isn't built for its arena \(1280 MiB of memory 1\): rebuild it/);
});

test("a blob's bytes move into the window at its map and back at its unmap", { skip }, async () => {
  const { v, memory, window } = await renderer();
  v.call({ t: 'vctx', id: 7, create: true, name: 'test' });
  // Shared memory (blob id 0, mappable): vkr's own storage, in the arena, before the window.
  v.call({ t: 'blob', ctx: 7, res: 3, mem: 2, flags: 1, blobId: 0n, size: 8192 });
  const storage = v.address(3);
  assert.ok(storage > 0 && storage < VENUS_ARENA, `storage at ${storage.toString(16)}`);
  const u8 = new Uint8Array(memory.buffer);
  u8.set([1, 2, 3, 4], storage);
  v.call({ t: 'blob-map', res: 3, offset: 0x4000, size: 8192 });
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

// VK4 R1: a fence waits for itself: a queue's work may wait for what the guest does later, and neither another
// context's fences nor one sent after it on its ring may wait for that.
test("a fence is retired by itself, not by others of its ring or context", { skip }, async () => {
  const { v } = await renderer();
  v.call({ t: 'vctx', id: 7, create: true, name: 'a' });
  v.call({ t: 'vctx', id: 8, create: true, name: 'b' });
  v.wake = () => {}; // no poll: the fences stay pending
  assert.equal(v.retired(7, 1, 1n), true, 'not sent');
  // No queue has that ring yet, so vkr refuses the fence: it mustn't hold its lane for ever.
  v.call({ t: 'vsubmit', ctx: 7, bytes: new Uint8Array(0), fence: { flags: 3, ring: 1, id: 2n } });
  assert.equal(v.retired(7, 1, 2n), true, 'a refused fence');
  (v as unknown as { ex: { venus_submit_fence(): number } }).ex.venus_submit_fence = () => 1;
  v.call({ t: 'vsubmit', ctx: 7, bytes: new Uint8Array(0), fence: { flags: 3, ring: 1, id: 1n } });
  assert.equal(v.retired(7, 1, 1n), false);
  assert.equal(v.retired(7, 2, 1n), true, 'another ring of the context');
  assert.equal(v.retired(8, 1, 1n), true, 'the same ring of another context');
  v.call({ t: 'vctx', id: 7, create: false });
  assert.equal(v.retired(7, 1, 1n), true, 'a context destroyed takes its fences');
});

// A virtio reset (a guest reboot) ends every Venus context with its blobs: the new guest makes its contexts again under
// the same ids (vkr refuses an id it has), and a blob of the old one is gone.
test('a virtio reset ends the contexts and their blobs', { skip }, async () => {
  const { v } = await renderer();
  v.call({ t: 'vctx', id: 2, create: true, name: 'before' });
  v.call({ t: 'blob', ctx: 2, res: 5, mem: 2, flags: 1, blobId: 0n, size: 4096 });
  assert.ok(v.address(5));
  v.reset();
  assert.equal(v.stats.contexts, 0);
  assert.equal(v.address(5), 0);
  assert.equal(v.has(5), false);
  v.call({ t: 'vctx', id: 2, create: true, name: 'after' });
  assert.equal(v.stats.contexts, 1, 'the context made again');
});

// The memory budget (VK_EXT_memory_budget, advertised) reports the heap and what's allocated from it: it was left
// unfilled. The guest's export imported again aliases its memory, counted once (VK4 T2). Host-visible memory has a heap
// of its own that the renderer's arena backs (VK4 T19: 1 GiB, the least GFXReconstruct, VMA and DXVK take as general
// memory rather than a discrete GPU's BAR window), counted apart from the device-local heap.
test('the memory budget reports the heap and its use, an import of an export counted once', { skip }, async () => {
  const { v, memory } = await renderer();
  const at = (v.raw.wgt_heaps as () => number)() >>> 0;
  assert.ok(at, 'wgt_heaps failed');
  const [count, heap, sizeMiB, budgetMiB, before, both, importLeft, none, reads, readsAfter] = new Uint32Array(memory.buffer, at, 10);
  assert.deepEqual([count, heap, sizeMiB, budgetMiB], [2, 1, 1024, 1024]);
  assert.ok(sizeMiB * 2 ** 20 < VENUS_ARENA, 'the arena backs the heap');
  assert.deepEqual([both - before, importLeft - before, none - before], [1024, 1024, 0], 'usage (KiB) with the memory and its import, the import alone, neither');
  assert.deepEqual([reads, readsAfter], [1, 1], "the import's bytes are the memory's");
});

// VK4 R6 (the review's O1, O3, O11).
test('memory: an import that wants addresses gets them or is refused, wild binding numbers refused, the heap kept to', { skip }, async () => {
  const { v, memory } = await renderer();
  const at = (v.raw.wgt_memory as () => number)() >>> 0;
  assert.ok(at, 'wgt_memory failed');
  const [address, refused, wide, wrapped, mib, past, unwaited, map, imported, nullAddress] = new Int32Array(memory.buffer, at, 10);
  assert.notEqual(address, 0, 'a device address of the import');
  assert.equal(refused, -1000072003, 'VK_ERROR_INVALID_EXTERNAL_HANDLE with a buffer already on the memory');
  assert.deepEqual([imported, nullAddress], [0, 0], 'a guest that doesn\'t wait: the import made, its pointers null');
  assert.deepEqual([wide, wrapped], [-1, -1], 'VK_ERROR_OUT_OF_HOST_MEMORY');
  assert.ok(mib > 0 && mib <= 2048, `${mib} MiB of a 2 GiB heap`);
  assert.equal(past, -2, 'VK_ERROR_OUT_OF_DEVICE_MEMORY past the heap');
  assert.deepEqual([unwaited, map], [0, -5], 'a guest that doesn\'t wait: an empty memory, VK_ERROR_MEMORY_MAP_FAILED at its map');
});

// VK4 R6 (the review's O2, O14): a blob's memory freed with an import of it left: the import still moves with the blob;
// unreferenced mapped, its bytes leave the window.
test('a surviving import moves with its blob, and a blob unreferenced while mapped leaves the window', { skip }, async () => {
  const { v, memory, window } = await renderer();
  const raw = v.raw as unknown as { wgt_peers_memory(): number; wgt_peers_at(): number; venus_test_peers(ctx: number, res: number, memory: bigint, importFirst: number): number };
  v.call({ t: 'vctx', id: 7, create: true, name: 'test' });
  v.call({ t: 'blob', ctx: 7, res: 3, mem: 2, flags: 1, blobId: 0n, size: 8192 });
  const storage = v.address(3);
  const handle = raw.wgt_peers_memory();
  assert.ok(handle);
  assert.equal(raw.venus_test_peers(7, 3, BigInt(handle), 0), 1, 'the blob is the import\'s');
  v.call({ t: 'blob-map', res: 3, offset: 0x4000, size: 8192 });
  assert.equal(raw.wgt_peers_at() >>> 0, window.at + 0x4000, 'mapped: the driver\'s memory in the window');
  v.call({ t: 'blob-unmap', res: 3 });
  assert.equal(raw.wgt_peers_at() >>> 0, storage, 'unmapped: back in the storage');
  v.call({ t: 'blob-map', res: 3, offset: 0x4000, size: 8192 });
  new Uint8Array(memory.buffer).set([7, 7], window.at + 0x4000);
  v.call({ t: 'blob-unref', res: 3 });
  assert.equal(raw.wgt_peers_at() >>> 0, storage, 'unreferenced mapped: out of the window');
  assert.deepEqual([...new Uint8Array(memory.buffer, storage, 2)], [7, 7]);
});

// The review of R5 to R7: the import freed first takes nothing with it; a map that can't be leaves no other's bytes.
test('an import freed first leaves its memory the storage, and a blob that can\'t be mapped reads zeros', { skip }, async () => {
  const { v, memory, window } = await renderer();
  const raw = v.raw as unknown as { wgt_peers_memory(): number; venus_test_peers(ctx: number, res: number, memory: bigint, importFirst: number): number };
  v.call({ t: 'vctx', id: 7, create: true, name: 'test' });
  v.call({ t: 'blob', ctx: 7, res: 3, mem: 2, flags: 1, blobId: 0n, size: 8192 });
  assert.equal(raw.venus_test_peers(7, 3, BigInt(raw.wgt_peers_memory()), 1), 1, 'the exporter keeps its blob and bytes');
  new Uint8Array(memory.buffer).fill(0x5a, window.at + 0x8000, window.at + 0xa001);
  v.call({ t: 'blob-map', res: 99, offset: 0x8000, size: 8192 });
  assert.deepEqual([...new Uint8Array(memory.buffer, window.at + 0x9fff, 2)], [0, 0x5a]);
});

// A fence destroyed while a submit held for a timeline wait signals it (a context's teardown destroys its objects so; VK4
// T2): the held submit forgets it, so its replay at the host's signal doesn't signal freed memory (NVIDIA's trap in
// wg_complete: an indirect call through the freed sync's type, VK3 L9b).
test('a sync destroyed while a held submit names it is forgotten', { skip }, async () => {
  const { v, memory } = await renderer();
  const at = (v.raw.wgt_sync_freed as () => number)() >>> 0;
  assert.ok(at, 'wgt_sync_freed failed');
  assert.deepEqual([...new Uint32Array(memory.buffer, at, 4)], [2, 1, 0, 0], 'held syncs: fence and wait; the wait; the signal succeeds; none');
});

/** An adapter's features and limits as the G0 suite recorded them (bench/gpu/results/). */
function adapter(file: string, vendor: string): GpuCaps {
  const p = (JSON.parse(readFileSync(new URL(`../bench/gpu/results/${file}`, import.meta.url), 'utf8')) as { results: { params: { features: string[]; limits: Record<string, number> } }[] }).results[0].params;
  return { features: new Set(p.features), limits: p.limits, adapterInfo: { vendor } };
}

test("what the driver advertises follows the WebGPU device's features and limits", { skip }, async () => {
  const caps = async (c?: GpuCaps, options: { hold?: string[]; heldFormats?: boolean; ycbcr?: boolean; l9?: L9Suspect[] } = {}) => {
    const { v, memory } = await renderer(c, options);
    const at = (v.raw.wgt_caps as () => number)() >>> 0;
    assert.ok(at, 'wgt_caps failed');
    const w = new Uint32Array(memory.buffer, at, 34);
    return {
      dim2D: w[0], invocations: w[1], sizeX: w[2], storageImages: w[3], sampledImages: w[4], storageRange: w[5], subgroupSize: w[6],
      subgroupOps: w[7], bc: w[8], extendedFormats: w[9], depthClamp: w[10], r16float: w[11], r16unorm: w[12], rg11b10: w[13], r32float: w[14], vendor: w[15],
      cacheUuid: w[16], rgba32Samples: w[17], rgba8Samples: w[18], r32uintSamples: w[19], integerSamples: w[20], sharedMemory: w[21], dualSource: w[22], integerMissing: w[23], ycbcr: w[24], nv12: w[25], nv12Planes: w[26] | 0, nv12Other: w[27] | 0, nv12External: w[28] | 0, maxPush: w[29], maxAllocation: w[30] + w[31] * 2 ** 32, bc1Rgb: w[32], vertexBindings: w[33],
    };
  };
  const SAMPLED = 0x1, STORAGE = 0x2, COLOR = 0x80, BLEND = 0x100, FILTER = 0x1000;
  // With `?gpu=vkformats=held` (web/venus-gpu.ts `HELD_FEATURES`; the default takes them since VK3 L4e: `all` below).
  const mac = await caps(adapter('2026-10-01-mac-m4-metal.json', 'apple'), { heldFormats: true });
  const swiftshader = await caps(adapter('2026-10-01-vm-swiftshader.json', 'google'), { heldFormats: true });
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
  // A guest's saved pipeline cache holds WGSL made for the caps: one made with others isn't taken (the out-of-context
  // review of the translator, finding 9).
  assert.equal(new Set([mac.cacheUuid, swiftshader.cacheUuid, none.cacheUuid]).size, 3, 'pipelineCacheUUID ignores the caps');
  // The out-of-context review of the translator: multisampling as WebGPU has it (none for the 32-bit integer formats
  // and the float ones of two or four channels; 8- and 16-bit integers as the others), dual-source blending where the
  // adapter has it (the Mac's). The review of L4f (findings 3, 4): framebufferIntegerColorSampleCounts no more than
  // every integer colour attachment's (1: the 32-bit ones have no multisampling), and the adapter's workgroup memory
  // whole (Vulkan's minimum is 16384).
  assert.deepEqual([mac.rgba32Samples, mac.rgba8Samples, mac.r32uintSamples, mac.integerSamples], [1, 5, 1, 1]);
  assert.deepEqual([mac.integerMissing, swiftshader.integerMissing, none.integerMissing], [0, 0, 0]);
  assert.deepEqual([mac.sharedMemory, none.sharedMemory], [32768, 16384]);
  assert.deepEqual([mac.dualSource, swiftshader.dualSource, none.dualSource], [1, 0, 0]);
  // VK_KHR_push_descriptor is advertised: its maxPushDescriptors at least Vulkan's 32 (the out-of-context review of VK4).
  assert.deepEqual([mac.maxPush, none.maxPush], [32, 32]);
  // VK4 R7: BC's RGB formats with the feature, Vulkan's 16 vertex bindings, an allocation as large as a GPUBuffer. BC off
  // without a view's swizzle, which they need; the extended storage formats off without tier1, which has some of them;
  // the pad under a large uniform binding not costing an allocation its room.
  assert.equal(mac.bc1Rgb & (SAMPLED | FILTER), SAMPLED | FILTER);
  assert.deepEqual([mac.vertexBindings, none.vertexBindings], [16, 16]);
  assert.equal(swiftshader.maxAllocation, 2 ** 30);
  const noSwizzle = await caps(adapter('2026-10-01-mac-m4-metal.json', 'apple'), { hold: ['texture-component-swizzle'] });
  assert.deepEqual([noSwizzle.bc, noSwizzle.bc1Rgb], [0, 0]);
  const noTier1 = await caps(adapter('2026-10-01-mac-m4-metal.json', 'apple'), { hold: ['texture-formats-tier1'] });
  assert.equal(noTier1.extendedFormats, 0);
  const large = adapter('2026-10-01-vm-swiftshader.json', 'google');
  const wide = await caps({ ...large, limits: { ...large.limits, maxUniformBufferBindingSize: 2 ** 30, maxBufferSize: 2 ** 28 } });
  assert.equal(wide.maxAllocation, 2 ** 28);
  // Subgroups of one invocation, basic operations only (the translator has none of WebGPU's yet).
  assert.deepEqual([mac.subgroupSize, mac.subgroupOps], [1, 1]);
  // Features: BC and depth clamp where the adapter has them; texture-formats-tier1 (the Mac's) adds the 16-bit normalized
  // formats and makes rg11b10ufloat renderable. Its storage formats and float32-blendable held back
  // (`?gpu=vkformats=held`).
  assert.deepEqual([mac.bc, mac.depthClamp, swiftshader.bc, none.bc, none.depthClamp], [1, 1, 1, 0, 0]);
  assert.deepEqual([mac.extendedFormats, swiftshader.extendedFormats], [0, 0]);
  assert.equal(mac.r16float & (STORAGE | COLOR | BLEND | FILTER), COLOR | BLEND | FILTER);
  assert.equal(mac.r16unorm & (SAMPLED | STORAGE | COLOR | FILTER), SAMPLED | COLOR, 'r16unorm: unfilterable (WebGPU says so)');
  assert.equal(swiftshader.r16unorm, 0);
  assert.equal(mac.rg11b10 & (COLOR | BLEND), COLOR | BLEND);
  // float32-filterable (both adapters'): r32float filtered; not blended (float32-blendable held back).
  assert.equal(swiftshader.r32float & (FILTER | BLEND), FILTER);
  assert.equal(none.r32float & (FILTER | BLEND), 0);
  // By default the held features too (8- and 16-bit storage with tier1, 32-bit floats blended: libplacebo's advanced path).
  const all = await caps(adapter('2026-10-01-mac-m4-metal.json', 'apple'));
  assert.equal(all.r16float & (STORAGE | COLOR | BLEND | FILTER), STORAGE | COLOR | BLEND | FILTER);
  assert.equal(all.r16unorm & (SAMPLED | STORAGE | COLOR | FILTER), SAMPLED | STORAGE | COLOR);
  assert.equal(all.r32float & (FILTER | BLEND), FILTER | BLEND);
  assert.equal(all.extendedFormats, 1);
  // `?gpu=vkhold=<feature>`: one of them held again.
  const one = await caps(adapter('2026-10-01-mac-m4-metal.json', 'apple'), { hold: ['tier1-storage'] });
  assert.equal(one.r16float & STORAGE, 0);
  assert.equal(one.r32float & BLEND, BLEND);
  // YCbCr conversions and the multi-planar formats by default since VK3 L7.3 (GTK 4.24 asserts YCbCr on a device with
  // dma-buf modifiers: without it every GTK4 program died on a machine with Vulkan); `?gpu=vkycbcr=off` holds them.
  assert.deepEqual([mac.ycbcr, all.ycbcr, none.ycbcr], [1, 1, 1]);
  const off = await caps(adapter('2026-10-01-mac-m4-metal.json', 'apple'), { ycbcr: false });
  assert.deepEqual([off.ycbcr, off.nv12], [0, 0]);
  // `?gpu=vkl9=bindgroups,pad` (VK3 L9a's NVIDIA arms) reach the driver: its flags, so its pipeline cache's UUID.
  const l9 = await caps(adapter('2026-10-01-mac-m4-metal.json', 'apple'), { l9: ['bindgroups', 'pad'] });
  assert.notEqual(l9.cacheUuid, all.cacheUuid);
  const on = all;
  const SAMPLED_IMAGE = 0x1, MIDPOINT = 0x20000, DISJOINT = 0x400000;
  assert.equal(on.nv12 & (SAMPLED_IMAGE | MIDPOINT | DISJOINT), SAMPLED_IMAGE | MIDPOINT | DISJOINT);
  // The out-of-context review of L6b-L7.3 (findings 3, 4): a mutable NV12 image whose format list names its planes'
  // formats is supported (video stacks ask so), one naming another format isn't, nor NV12 on external memory (its
  // planes are neither imported nor exported). VK_SUCCESS 0, VK_ERROR_FORMAT_NOT_SUPPORTED -11.
  assert.deepEqual([on.nv12Planes, on.nv12Other, on.nv12External], [0, -11, -11]);
});

test('a semaphore is made whatever handle types its export names', { skip }, async () => {
  // Venus's guest creates semaphores asynchronously: one the driver refused would be a handle vkr never has, and the
  // guest's next submit naming it kills its context ("failed to look up object … of type 5": Chromium's own Vulkan
  // device exports opaque fds, which Venus doesn't offer; VK3 L7.1b). Each: none, sync fd, opaque fd, both, a timeline's opaque fd.
  const { v } = await renderer();
  assert.equal((v.raw.wgt_semaphores as () => number)(), 0b11111);
});
