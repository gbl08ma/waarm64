// Venus's renderer module (vk/build.sh: virglrenderer's vkr over our null driver, target/vk/venus.wasm) in Node, on a
// 4 GiB shared memory as the VM's memory 1 is, its arena first (web/venus-host.ts): vkr's capset is the one the device advertises
// (web/venus.ts), a blob's bytes move into the host-visible window at its map and back out at its unmap, and what the
// driver advertises follows the WebGPU device's features and limits. A guest drives it whole in tests/page-venus.test.ts.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import type { GpuCaps, L9Suspect } from '../web/venus-caps.ts';
import { VenusRenderer } from '../web/venus-host.ts';
import { VENUS_CAPSET_WORDS } from '../web/venus.ts';
import { VENUS_ARENA } from '../web/ram.ts';

const MODULE = new URL('../target/vk/venus.wasm', import.meta.url);
const skip = !existsSync(MODULE) && 'SKIPPED: run vk/build.sh';

async function renderer(caps?: GpuCaps, options: { hold?: string[]; heldFormats?: boolean; ycbcr?: boolean; l9?: L9Suspect[]; ringIdleMs?: number; tickMs?: number } = {}) {
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

// VK4 T13's review, F8: one with the arena's export but built before vkr's counts (whose exports the stats call every
// second) is refused too, before it runs.
test('a renderer module older than the counts is refused', async () => {
  const memory = new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true });
  const name = [...new TextEncoder().encode('venus_arena_end')];
  // (func (export "venus_arena_end") (result i32) (i32.const 0))
  const older = new WebAssembly.Module(new Uint8Array([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0, 1, 5, 1, 0x60, 0, 1, 0x7f, 3, 2, 1, 0,
    7, name.length + 4, 1, name.length, ...name, 0, 0, 10, 6, 1, 4, 0, 0x41, 0, 0x0b]));
  await assert.rejects(VenusRenderer.create(older, memory, { at: 0, bytes: 0, watch: 0 }), /older than this page \(no venus_cmd_counts, .*\): rebuild it/);
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

// VK4 T13 (vk/README.md "Calls and rings"): vkr's commands are counted by where they came from and whether the guest
// waits for a reply, the replied ones named (a Venus call the guest makes synchronously) and the virtqueue's all.
test('the commands vkr runs are counted, those asking for a reply and the virtqueue\'s by name', { skip }, async () => {
  const { v } = await renderer();
  v.call({ t: 'vctx', id: 7, create: true, name: 'a' });
  v.call({ t: 'vctx', id: 8, create: true, name: 'b' });
  v.wake = () => {};
  // vkEnumerateInstanceVersion (137) asking for a reply, vkGetDeviceQueue (17) not: their arguments are missing, so each
  // context fails at its command, which is counted first.
  v.call({ t: 'vsubmit', ctx: 7, bytes: new Uint8Array(new Uint32Array([137, 1]).buffer) });
  v.call({ t: 'vsubmit', ctx: 8, bytes: new Uint8Array(new Uint32Array([17, 0]).buffer) });
  const t = v.times();
  assert.deepEqual([t.queueCmds, t.ringCmds, t.nestedCmds, t.replies], [2, 0, 0, 1]);
  assert.deepEqual(v.calls(), { 'vkEnumerateInstanceVersion@queue+reply': 1, 'vkGetDeviceQueue@queue': 1 });
  assert.deepEqual(v.calls(), {}, 'counted since the last look');
});

/** A command's words for `vsubmit`: u32s, and u64s as two (Venus's stream is little-endian, 4-byte aligned). */
function words(...xs: (number | bigint)[]) {
  const out: number[] = [];
  for (const x of xs) {
    if (typeof x === 'bigint') out.push(Number(x & 0xffffffffn), Number(x >> 32n));
    else out.push(x >>> 0);
  }
  return new Uint8Array(new Uint32Array(out).buffer);
}

// VK4 T13's review, F4: a ring that goes idle counts once, not at every poll while it stays idle; a notify wakes it.
test('a ring gone idle is counted once each time it goes idle', { skip }, async () => {
  const { v } = await renderer();
  v.wake = () => {}; // the test polls
  const poll = (v.raw as unknown as { venus_poll(): number }).venus_poll;
  v.call({ t: 'vctx', id: 7, create: true, name: 'a' });
  v.call({ t: 'blob', ctx: 7, res: 3, mem: 2, flags: 1, blobId: 0n, size: 8192 });
  // vkCreateRingMESA (188): ring 1 on resource 3, idle after 1 ms; head, tail, status, a 4 KiB buffer, extra.
  v.call({ t: 'vsubmit', ctx: 7, bytes: words(188, 0, 1n, 1n, 1000384000, 0n, 0, 3, 0n, 8192n, 1_000_000n, 0n, 64n, 128n, 256n, 4096n, 4352n, 64n) });
  const spin = (ms: number) => { const t = performance.now(); while (performance.now() - t < ms); };
  // `times()` gives the counts since its last call.
  let idles = 0, notifies = 0;
  const look = () => { const t = v.times(); idles += t.idles; notifies += t.notifies; };
  look();
  idles = 0;
  spin(3);
  for (let i = 0; i < 10; i++) poll();
  look();
  assert.equal(idles, 1, 'polls of an idle ring each counted');
  // vkNotifyRingMESA (190) wakes it; idle again, it counts once more.
  v.call({ t: 'vsubmit', ctx: 7, bytes: words(190, 0, 1n, 0, 0) });
  poll();
  spin(3);
  for (let i = 0; i < 5; i++) poll();
  look();
  assert.deepEqual([idles, notifies], [2, 1]);
});

// The review's F6: a knob that isn't a number in its range (`?gpu=vkidle=`, `vktick=`) is refused with a warning, so
// an A/B arm is what it says or says it isn't; a long idle floor would wrap into vkr's u32 of µs.
test('the ring-idle and tick knobs outside their ranges are refused with a warning', { skip }, async (t) => {
  const warned: string[] = [];
  t.mock.method(console, 'warn', (m: string) => { warned.push(String(m)); });
  await renderer(undefined, { ringIdleMs: 5e6, tickMs: Number.NaN });
  await renderer(undefined, { ringIdleMs: 20, tickMs: 0.05 });
  assert.deepEqual(warned.filter((m) => /ignored/.test(m)), ['venus: vkidle=5000000 ignored (not a number from 0 to 1000 ms)', 'venus: vktick=NaN ignored (not a number from 0.01 to 10 ms)']);
});

// The review's F5: vkr's counters are u32s that wrap; a second's count stays its own across the wrap.
test('a counter that wraps still gives the second\'s count', { skip }, async () => {
  const { v, memory } = await renderer();
  const types = (v.raw as unknown as { venus_cmd_types(): number }).venus_cmd_types();
  const at = (v.raw as unknown as { venus_cmd_counts(): number }).venus_cmd_counts() >>> 0;
  // [where 1: the virtqueue][no reply][type 17].
  const bucket = new Uint32Array(memory.buffer, at + 4 * (2 * types + 17), 1);
  bucket[0] = 0xfffffff0;
  v.times();
  v.calls();
  bucket[0] = (bucket[0] + 0x20) >>> 0;
  assert.equal(v.times().queueCmds, 0x20);
  assert.deepEqual(v.calls(), { 'vkGetDeviceQueue@queue': 0x20 });
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

/**
 * Venus commands as the guest's driver encodes them (Mesa's venus-protocol, vn_protocol_driver_*.h): a command's type and
 * flags, then its arguments; handles are the guest's u64 ids, a pointer an array size of 1 (or 0 for none), a struct's
 * sType and an empty pNext before its fields, arrays an u64 count before their elements.
 */
class VenusStream {
  private words: number[] = [];
  u32(v: number) { this.words.push(v >>> 0); return this; }
  u64(v: bigint) { return this.u32(Number(v & 0xffff_ffffn)).u32(Number(v >> 32n)); }
  /** A pointer present (1) or none (0), as `vn_encode_simple_pointer`; a NULL pNext, a NULL array. */
  ptr(present: boolean) { return this.u64(present ? 1n : 0n); }
  f32(v: number) { return this.u32(new Uint32Array(new Float32Array([v]).buffer)[0]); }
  /** sType and an empty pNext. */
  struct(sType: number) { return this.u32(sType).ptr(false); }
  bytes() { return new Uint8Array(new Uint32Array(this.words).buffer); }

  createInstance(id: bigint) {
    // VkInstanceCreateInfo: flags, pApplicationInfo (no names, Vulkan 1.3), no layers, no extensions; no allocator.
    this.u32(0).u32(0).ptr(true).struct(1).u32(0).ptr(true).struct(0).ptr(false).u32(0).ptr(false).u32(0).u32((1 << 22) | (3 << 12));
    return this.u32(0).ptr(false).u32(0).ptr(false).ptr(false).ptr(true).u64(id);
  }
  enumeratePhysicalDevices(instance: bigint, id: bigint) {
    return this.u32(2).u32(0).u64(instance).ptr(true).u32(1).u64(1n).u64(id);
  }
  createDevice(physical: bigint, id: bigint) {
    // VkDeviceCreateInfo: one VkDeviceQueueCreateInfo (family 0, one queue at priority 1), no layers, extensions or features.
    this.u32(11).u32(0).u64(physical).ptr(true).struct(3).u32(0).u32(1).u64(1n).struct(2).u32(0).u32(0).u32(1).u64(1n).f32(1);
    return this.u32(0).ptr(false).u32(0).ptr(false).ptr(false).ptr(false).ptr(true).u64(id);
  }
  allocateMemory(device: bigint, id: bigint, size: bigint, type: number) {
    return this.u32(21).u32(0).u64(device).ptr(true).struct(5).u64(size).u32(type).ptr(false).ptr(true).u64(id);
  }
  freeMemory(device: bigint, memory: bigint) {
    return this.u32(22).u32(0).u64(device).u64(memory).ptr(false);
  }
  destroyDevice(device: bigint) { return this.u32(12).u32(0).u64(device).ptr(false); }
  destroyInstance(instance: bigint) { return this.u32(1).u32(0).u64(instance).ptr(false); }
}

// VK1 L8: a device memory freed while its blob is mapped hands the blob its storage, so the unmap copies the window's
// bytes there; it copied them into freed heap, which the next allocation took (vkr's objects were corrupted). The
// guest's own commands, through venus_submit.
test('a memory freed while its blob is mapped leaves the blob its storage, which the unmap fills', { skip }, async (t) => {
  const { v, memory, window } = await renderer();
  const warn = t.mock.method(console, 'warn', () => {});
  const submit = (s: VenusStream) => v.call({ t: 'vsubmit', ctx: 7, bytes: s.bytes() });
  const SIZE = 65536n, HOST_VISIBLE = 1; // wg_device.c's memory types: 1 is host-visible
  v.call({ t: 'vctx', id: 7, create: true, name: 'test' });
  submit(new VenusStream().createInstance(1n).enumeratePhysicalDevices(1n, 2n).createDevice(2n, 3n).allocateMemory(3n, 4n, SIZE, HOST_VISIBLE));
  v.call({ t: 'blob', ctx: 7, res: 3, mem: 2, flags: 1, blobId: 4n, size: Number(SIZE) });
  const storage = v.address(3);
  assert.ok(storage > 0 && storage < VENUS_ARENA, `the memory's storage at ${storage.toString(16)}`);
  v.call({ t: 'blob-map', res: 3, offset: 0x4000, size: Number(SIZE) });
  const u8 = new Uint8Array(memory.buffer);
  u8.set([9, 8, 7, 6], window.at + 0x4000);
  // Freed, and another memory of its size, which the heap would give the freed storage.
  submit(new VenusStream().freeMemory(3n, 4n).allocateMemory(3n, 5n, SIZE, HOST_VISIBLE));
  v.call({ t: 'blob', ctx: 7, res: 4, mem: 2, flags: 1, blobId: 5n, size: Number(SIZE) });
  const other = v.address(4);
  assert.ok(other > 0, 'the second memory\'s blob');
  assert.notEqual(other, storage, 'the blob still holds its storage');
  v.call({ t: 'blob-unmap', res: 3 });
  assert.equal(v.address(3), storage);
  assert.deepEqual([...u8.subarray(storage, storage + 4)], [9, 8, 7, 6], 'the unmap copied into the blob\'s storage');
  assert.deepEqual([...u8.subarray(other, other + 4)], [0, 0, 0, 0], 'and not into the second memory');
  v.call({ t: 'blob-unref', res: 3 });
  v.call({ t: 'blob-unref', res: 4 });
  submit(new VenusStream().freeMemory(3n, 5n).destroyDevice(3n).destroyInstance(1n));
  v.call({ t: 'vctx', id: 7, create: false });
  assert.deepEqual(warn.mock.calls.map((c) => String(c.arguments[0])), [], 'every command and blob made');
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
    const w = new Uint32Array(memory.buffer, at, 36);
    return {
      dim2D: w[0], invocations: w[1], sizeX: w[2], storageImages: w[3], sampledImages: w[4], storageRange: w[5], subgroupSize: w[6],
      subgroupOps: w[7], bc: w[8], extendedFormats: w[9], depthClamp: w[10], r16float: w[11], r16unorm: w[12], rg11b10: w[13], r32float: w[14], vendor: w[15],
      cacheUuid: w[16], rgba32Samples: w[17], rgba8Samples: w[18], r32uintSamples: w[19], integerSamples: w[20], sharedMemory: w[21], dualSource: w[22], integerMissing: w[23], ycbcr: w[24], nv12: w[25], nv12Planes: w[26] | 0, nv12Other: w[27] | 0, nv12External: w[28] | 0, maxPush: w[29], maxAllocation: w[30] + w[31] * 2 ** 32, bc1Rgb: w[32], vertexBindings: w[33], rgb32: w[34], rgb32Input: w[35] | 0,
    };
  };
  const SAMPLED = 0x1, STORAGE = 0x2, COLOR = 0x80, BLEND = 0x100, FILTER = 0x1000;
  // With `?gpu=vkformats=held` (web/venus-caps.ts `HELD_FEATURES`; the default takes them since VK3 L4e: `all` below).
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
  // (web/venus-caps.ts `VENDORS`).
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
  // R32G32B32_SFLOAT (VK4 T31's rgba32float texture) sampled but not a colour attachment: Vulkan wants a colour
  // attachment at framebufferColorSampleCounts, which WebGPU's 32-bit float textures can't multisample (dEQP-VK's
  // api.info.image_format_properties); an input attachment of it refused (VK_ERROR_FORMAT_NOT_SUPPORTED).
  assert.deepEqual([swiftshader.rgb32 & (SAMPLED | COLOR | BLEND), swiftshader.rgb32Input], [SAMPLED, -11]);
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
