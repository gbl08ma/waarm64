// The Vulkan driver's test program (vk/driver/wg_test.c) on this page's WebGPU device, in the renderer module
// (tests/venus-driver.test.ts): its scene's pixels, its compute pass's output and a filled buffer, read back once the
// submit's fence signalled.
import { memoryBackend, ShaderCache, type CacheBackend } from '../../web/venus-cache.ts';
import { deviceRequest } from '../../web/venus-gpu.ts';
import { VenusRenderer, type VenusPoll } from '../../web/venus-host.ts';
import { VenusImport } from '../../web/venus-import.ts';

type Test = {
  wgt_run(vs: number, vn: number, fs: number, fn: number, cs: number, cn: number): number;
  wgt_done(): number; wgt_pixels(): number; wgt_storage(): number; wgt_filled(): number; wgt_error(): number;
  venus_alloc(n: number): number;
  wgt_import(res: number): number; wgt_imported(): number;
  wgt_draw(fs: number, fn: number, variant: number): number; wgt_draw_done(): number;
  wgt_two_init(window: number, size: number): number; wgt_two_map(d: number): number; wgt_two_read(d: number): number;
  wgt_two_submit(d: number): number; wgt_two_done(d: number): number;
};

/** Two runs of the program, each on a renderer of its own (a machine started again), sharing a shader store: the
 * second translates nothing the first did (web/venus-cache.ts). */
export async function runTwice(spirv: { vert: string; frag: string; comp: string }) {
  const backend = memoryBackend();
  const first = await run(spirv, backend);
  const storedFirst = backend.entries.size;
  const second = await run(spirv, backend);
  return { first, second, storedFirst, stored: backend.entries.size };
}

export async function run(spirv: { vert: string; frag: string; comp: string }, backend?: CacheBackend) {
  const adapter = await navigator.gpu?.requestAdapter();
  if (!adapter) return { skipped: 'no WebGPU adapter' };
  const device = await adapter.requestDevice(deviceRequest(adapter));
  const errors: string[] = [];
  device.addEventListener('uncapturederror', (e) => errors.push((e as GPUUncapturedErrorEvent).error.message));
  const memory = new WebAssembly.Memory({ initial: 65536, maximum: 65536, shared: true });
  const module = await WebAssembly.compileStreaming(fetch('/target/vk/venus.wasm'));
  let store: ShaderCache | undefined;
  const v = await VenusRenderer.create(module, memory, { at: 0x1000_0000, bytes: 1 << 20, watch: 0 }, device, device, 'pump',
    backend ? { cache: async (id) => (store = await ShaderCache.open(id, { backend })) } : {});
  const ex = v.raw as unknown as Test;
  const words = async (url: string) => new Uint8Array(await (await fetch(url)).arrayBuffer());
  const put = (b: Uint8Array) => { const p = ex.venus_alloc(b.length) >>> 0; new Uint8Array(memory.buffer, p, b.length).set(b); return [p, b.length / 4]; };
  const [vs, vn] = put(await words(spirv.vert)), [fs, fn] = put(await words(spirv.frag)), [cs, cn] = put(await words(spirv.comp));
  const text = (p: number) => { const u8 = new Uint8Array(memory.buffer); let e = p; while (u8[e]) e++; return new TextDecoder().decode(u8.slice(p, e)); };
  const t0 = performance.now();
  if (ex.wgt_run(vs, vn, fs, fn, cs, cn)) return { error: text(ex.wgt_error() >>> 0), errors };
  const recorded = performance.now() - t0;
  for (let k = 0; k < 500 && !ex.wgt_done(); k++) await new Promise((r) => setTimeout(r, 10));
  if (!ex.wgt_done()) return { error: 'the fence never signalled', errors, stats: v.gpu.stats };
  const px = (x: number, y: number) => [...new Uint8Array(memory.buffer, (ex.wgt_pixels() >>> 0) + (y * 64 + x) * 4, 4)];
  const u32 = (p: number, n: number) => [...new Uint32Array(memory.buffer.slice(p >>> 0, (p >>> 0) + n * 4))];
  return {
    pixels: { topLeft: px(16, 8), bottomLeft: px(16, 56), topRight: px(48, 8), bottomRight: px(48, 56) },
    storage: u32(ex.wgt_storage(), 256),
    filled: u32(ex.wgt_filled(), 16),
    errors,
    stats: v.gpu.stats,
    ms: { recorded, total: performance.now() - t0 },
    flushed: await store?.flush(),
  };
}

/**
 * A dma-buf import (web/venus-import.ts): the test program's R8G8 image bound to memory imported from virgl resource 7
 * (here a fake renderer's: 4×2 texels of RG8 read back), copied to a buffer; then a picture's plane written into the
 * resource and the image copied again. The bytes each copy read, and how the importer wrote them.
 */
export async function runImport() {
  const adapter = await navigator.gpu?.requestAdapter();
  if (!adapter) return { skipped: 'no WebGPU adapter' };
  const device = await adapter.requestDevice(deviceRequest(adapter));
  const errors: string[] = [];
  device.addEventListener('uncapturederror', (e) => errors.push((e as GPUUncapturedErrorEvent).error.message));
  const memory = new WebAssembly.Memory({ initial: 65536, maximum: 65536, shared: true });
  const module = await WebAssembly.compileStreaming(fetch('/target/vk/venus.wasm'));
  const v = await VenusRenderer.create(module, memory, { at: 0x1000_0000, bytes: 1 << 20, watch: 0 }, device);
  const ex = v.raw as unknown as Test;
  const RG8 = 65;
  const first = Uint8Array.from({ length: 16 }, (_, i) => 10 + i);
  const importer = new VenusImport(device, {
    resourceInfo: (id) => (id === 7 ? { format: RG8, width: 4, height: 2 } : undefined),
    readResource: (id) => (id === 7 ? first.slice() : null),
  });
  const binds: number[] = [];
  v.gpu.onImport = (t, res) => { binds.push(res); importer.bind(t, res); };
  const text = (p: number) => { const u8 = new Uint8Array(memory.buffer); let e = p; while (u8[e]) e++; return new TextDecoder().decode(u8.slice(p, e)); };
  const copy = async () => {
    if (ex.wgt_import(7)) return { error: text(ex.wgt_error() >>> 0) };
    for (let k = 0; k < 500 && !ex.wgt_done(); k++) await new Promise((r) => setTimeout(r, 10));
    if (!ex.wgt_done()) return { error: 'the fence never signalled' };
    return { bytes: [...new Uint8Array(memory.buffer, ex.wgt_imported() >>> 0, 16)] };
  };
  const a = await copy();
  // A picture's plane (rows of 4 texels of 2 bytes, 2 rows) written into resource 7.
  importer.plane(7, Uint8Array.from({ length: 16 }, (_, i) => 200 + i), 4, 2, 2);
  const b = await copy();
  return { first: a, second: b, binds, stats: importer.stats, errors };
}

/**
 * A submit's way back (VK3 L2): `n` submits of one draw (the test program's `wgt_draw`, its pipeline made before) with
 * the rings polled by `poll`, each awaited on a MessageChannel's turns (unclamped). The median ms from the submit to its
 * fence, the nudges counted (web/venus-gpu.ts `nudge`) and the empty submits that reached the queue.
 */
export async function runFences(spirv: { vert: string; frag: string; comp: string; costs: string }, poll: VenusPoll, n: number) {
  const adapter = await navigator.gpu?.requestAdapter();
  if (!adapter) return { skipped: 'no WebGPU adapter' };
  const device = await adapter.requestDevice(deviceRequest(adapter));
  const memory = new WebAssembly.Memory({ initial: 65536, maximum: 65536, shared: true });
  const module = await WebAssembly.compileStreaming(fetch('/target/vk/venus.wasm'));
  // The empty submits that reach the queue (the nudges as WebGPU sees them).
  let empty = 0;
  const submit = device.queue.submit.bind(device.queue);
  device.queue.submit = (buffers: Iterable<GPUCommandBuffer>) => { if (![...buffers].length) empty++; submit(buffers); };
  const v = await VenusRenderer.create(module, memory, { at: 0x1000_0000, bytes: 1 << 20, watch: 0 }, device, device, poll);
  const ex = v.raw as unknown as Test;
  const words = async (url: string) => new Uint8Array(await (await fetch(url)).arrayBuffer());
  const put = (b: Uint8Array) => { const p = ex.venus_alloc(b.length) >>> 0; new Uint8Array(memory.buffer, p, b.length).set(b); return [p, b.length / 4]; };
  const [vs, vn] = put(await words(spirv.vert)), [fs, fn] = put(await words(spirv.frag)), [cs, cn] = put(await words(spirv.comp)), [ks, kn] = put(await words(spirv.costs));
  const tick = () => new Promise<void>((r) => { const c = new MessageChannel(); c.port1.onmessage = () => r(); c.port2.postMessage(0); });
  const wait = async (done: () => number) => { const t = performance.now(); while (!done()) { if (performance.now() - t > 20_000) throw new Error('a fence never signalled'); await tick(); } };
  if (ex.wgt_run(vs, vn, fs, fn, cs, cn)) return { error: 'wgt_run failed' };
  await wait(() => ex.wgt_done());
  const ms: number[] = [];
  for (let i = 0; i < n + 3; i++) {
    const t0 = performance.now();
    if (ex.wgt_draw(ks, kn, 0)) return { error: 'wgt_draw failed' };
    await wait(() => ex.wgt_draw_done());
    if (i >= 3) ms.push(performance.now() - t0);
  }
  ms.sort((a, b) => a - b);
  device.destroy();
  return { median: ms[ms.length >> 1], nudges: v.gpu.stats.nudges, empty, adapter: adapter.info.architecture };
}

/**
 * Two devices on one window (vk/driver/wg_test.c `wgt_two_*`; VK3 L4c-A, the review's finding 1), with a write-watch
 * of the test's own (web/window.ts's layout, no vCPUs) whose pages the test marks as the guest's stores would.
 * `scenario`:
 * - 'watch': device 1 writes its window memory without submitting, device 0 submits, then device 1 copies it back: the
 *   bytes it wrote (the window's pages are taken once for every device).
 * - 'serials': both devices' memories filled before their first submits; then device 1 and device 0 submit at once,
 *   each with the same count of submits behind it: each reads back its own bytes (completions are matched to their
 *   device's submit).
 * - 'odd': device 0's window memory is `size` bytes (odd) and goes through an R8 image; its first submit uploads it
 *   whole, its second the page the test marked: every byte arrives both times.
 * Each step's bytes read back, against what was written.
 */
export async function runTwo(scenario: 'watch' | 'serials' | 'odd') {
  const adapter = await navigator.gpu?.requestAdapter();
  if (!adapter) return { skipped: 'no WebGPU adapter' };
  const device = await adapter.requestDevice(deviceRequest(adapter));
  const errors: string[] = [];
  device.addEventListener('uncapturederror', (e) => errors.push((e as GPUUncapturedErrorEvent).error.message));
  const memory = new WebAssembly.Memory({ initial: 65536, maximum: 65536, shared: true });
  const module = await WebAssembly.compileStreaming(fetch('/target/vk/venus.wasm'));
  const at = 0x1000_0000, bytes = 1 << 20, watchAt = 0x2000_0000;
  // web/window.ts: GEN, NCPUS, WORDS, PAGES, ACK[128], RUNNING[128], the bitmap.
  const head = new Int32Array(memory.buffer, watchAt, 4 + 256 + bytes / 4096 / 32);
  head[2] = bytes / 4096 / 32;
  head[3] = bytes / 4096;
  const mark = (p: number, n: number) => {
    for (let page = Math.floor((p - at) / 4096); page <= Math.floor((p + n - 1 - at) / 4096); page++) Atomics.or(head, 4 + 256 + (page >> 5), 1 << (page & 31));
  };
  const v = await VenusRenderer.create(module, memory, { at, bytes, watch: watchAt }, device);
  const ex = v.raw as unknown as Test;
  const text = (p: number) => { const u8 = new Uint8Array(memory.buffer); let e = p; while (u8[e]) e++; return new TextDecoder().decode(u8.slice(p, e)); };
  const size = scenario === 'odd' ? 4099 : 8192;
  if (ex.wgt_two_init(at, size)) return { error: text(ex.wgt_error() >>> 0), errors };
  const wait = async (d: number) => {
    for (let k = 0; k < 500 && !ex.wgt_two_done(d); k++) await new Promise((r) => setTimeout(r, 10));
    if (!ex.wgt_two_done(d)) throw new Error(`device ${d}'s fence never signalled`);
  };
  const write = (d: number, seed: number, watched: boolean) => {
    const p = ex.wgt_two_map(d) >>> 0;
    const b = Uint8Array.from({ length: size }, (_, i) => (i * 7 + seed) & 255);
    new Uint8Array(memory.buffer, p, size).set(b);
    if (watched) mark(p, size);
    return b;
  };
  const read = (d: number) => new Uint8Array(memory.buffer, ex.wgt_two_read(d) >>> 0, size).slice();
  // Where each check's read-back bytes first differ from what was written (-1: none).
  const differs = (a: Uint8Array, b: Uint8Array) => { for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return i; return -1; };
  const checks: Record<string, number> = {};
  try {
    if (scenario === 'odd') {
      const first = write(0, 1, false);
      ex.wgt_two_submit(0); await wait(0);
      checks.whole = differs(read(0), first);
      const second = write(0, 101, true);
      ex.wgt_two_submit(0); await wait(0);
      checks.page = differs(read(0), second);
    } else if (scenario === 'watch') {
      const a0 = write(1, 1, false), b0 = write(0, 2, false);
      ex.wgt_two_submit(1); await wait(1);
      ex.wgt_two_submit(0); await wait(0);
      checks.first1 = differs(read(1), a0);
      checks.first0 = differs(read(0), b0);
      const a1 = write(1, 3, true);
      ex.wgt_two_submit(0); await wait(0);
      ex.wgt_two_submit(1); await wait(1);
      checks.after = differs(read(1), a1);
    } else {
      const a0 = write(1, 1, false), b0 = write(0, 2, false);
      ex.wgt_two_submit(0); await wait(0);
      ex.wgt_two_submit(1); await wait(1);
      for (const d of [0, 1]) new Uint8Array(memory.buffer, ex.wgt_two_read(d) >>> 0, size).fill(0);
      ex.wgt_two_submit(1);
      ex.wgt_two_submit(0);
      await wait(1);
      await wait(0);
      // Both fences signalled: give a stray completion its turn before reading.
      await new Promise((r) => setTimeout(r, 50));
      checks.dev1 = differs(read(1), a0);
      checks.dev0 = differs(read(0), b0);
    }
  } catch (e) {
    return { error: String(e), checks, errors, warnings: v.gpu.stats.errors };
  }
  device.destroy();
  return { checks, errors, warnings: v.gpu.stats.errors };
}
