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
  wgt_fl_init(window: number): number; wgt_fl_map(which: number): number; wgt_fl_submit(i: number): number;
  wgt_fl_done(i: number): number;
  wgt_link(): number; wgt_variant(scenario: number): number; wgt_pass(scenario: number): number; wgt_pass_pixels(): number; wgt_pass_done(): number;
  wgt_misc(scenario: number, cs: number, cn: number): number; wgt_misc_map(): number; wgt_misc_done(): number;
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
    videoPending: { res: () => false },
  }, (f) => v.gpu.later(f));
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

/** GPU writes to host-visible memory in flight against the guest's writes to the same page (VK3 L4c-B; the review's
 * finding 2; vk/driver/wg_test.c `wgt_fl_*`). `upload`: a page uploaded while an earlier submit's copy into it is in
 * flight keeps that copy's bytes on the GPU. `since`: a completion keeps the bytes the guest wrote since its submit
 * inside the range it reads back (a texture-to-buffer copy's row gap), alone and with a submit between; and two of
 * the driver's writes to one range in one submit land in order. */
export async function runInFlight(scenario: 'upload' | 'since') {
  const adapter = await navigator.gpu?.requestAdapter();
  if (!adapter) return { skipped: 'no WebGPU adapter' };
  const device = await adapter.requestDevice(deviceRequest(adapter));
  const errors: string[] = [];
  device.addEventListener('uncapturederror', (e) => errors.push((e as GPUUncapturedErrorEvent).error.message));
  const memory = new WebAssembly.Memory({ initial: 65536, maximum: 65536, shared: true });
  const module = await WebAssembly.compileStreaming(fetch('/target/vk/venus.wasm'));
  const at = 0x1000_0000, bytes = 1 << 20, watchAt = 0x2000_0000;
  const head = new Int32Array(memory.buffer, watchAt, 4 + 256 + bytes / 4096 / 32);
  head[2] = bytes / 4096 / 32;
  head[3] = bytes / 4096;
  const mark = (p: number, n: number) => {
    for (let page = Math.floor((p - at) / 4096); page <= Math.floor((p + n - 1 - at) / 4096); page++) Atomics.or(head, 4 + 256 + (page >> 5), 1 << (page & 31));
  };
  const v = await VenusRenderer.create(module, memory, { at, bytes, watch: watchAt }, device);
  const ex = v.raw as unknown as Test;
  const text = (p: number) => { const u8 = new Uint8Array(memory.buffer); let e = p; while (u8[e]) e++; return new TextDecoder().decode(u8.slice(p, e)); };
  if (ex.wgt_fl_init(at)) return { error: text(ex.wgt_error() >>> 0), errors };
  const view = (which: number) => new Uint8Array(memory.buffer, ex.wgt_fl_map(which) >>> 0, 8192);
  const M = view(0), aux = view(1), rd = view(2);
  const pattern = (n: number, seed: number) => Uint8Array.from({ length: n }, (_, i) => (i * 13 + seed) & 255);
  const wait = async (i: number) => {
    for (let k = 0; k < 500 && !ex.wgt_fl_done(i); k++) await new Promise((r) => setTimeout(r, 10));
    if (!ex.wgt_fl_done(i)) throw new Error(`submit ${i}'s fence never signalled`);
  };
  // Where `got` first differs from `want` (-1: none).
  const differs = (got: Uint8Array, want: Uint8Array) => { for (let i = 0; i < want.length; i++) if (got[i] !== want[i]) return i; return -1; };
  const checks: Record<string, number> = {};
  try {
    // Fresh memories go up whole at the first submit: M's bytes, then aux's (P).
    const P = pattern(8192, 5);
    aux.set(P);
    M.set(pattern(8192, 1));
    ex.wgt_fl_submit(1); await wait(1);
    checks.start = differs(rd, M.slice());
    if (scenario === 'upload') {
      // Submit 0 copies P into M[0, 2048) on the GPU; before it completes the guest writes M[2048, 4096) and submit 1
      // copies M: the page's upload must not put M's old [0, 2048) back over the copy.
      ex.wgt_fl_submit(0);
      const W = pattern(2048, 77);
      M.set(W, 2048);
      mark(at + 2048, 2048);
      ex.wgt_fl_submit(1);
      await wait(0); await wait(1);
      checks.copied = differs(rd.subarray(0, 2048), P.subarray(0, 2048));
      checks.written = differs(rd.subarray(2048, 4096), W);
      checks.cpuCopied = differs(M.subarray(0, 2048), P.subarray(0, 2048));
      checks.cpuWritten = differs(M.subarray(2048, 4096), W);
    } else {
      // Submit 2 writes M[4096, 4100) and M[4352, 4356) through an image and reads back [4096, 4356); the guest writes
      // M[4200, 4204) before it completes, which the completion must keep.
      const rows = [P.subarray(4096, 4100), P.subarray(4100, 4104)];
      const X = Uint8Array.of(0xa1, 0xa2, 0xa3, 0xa4), Y = Uint8Array.of(0xb1, 0xb2, 0xb3, 0xb4);
      ex.wgt_fl_submit(2);
      M.set(X, 4200);
      mark(at + 4200, 4);
      await wait(2);
      checks.kept = differs(M.subarray(4200, 4204), X);
      checks.row0 = differs(M.subarray(4096, 4100), rows[0]);
      checks.row1 = differs(M.subarray(4352, 4356), rows[1]);
      // Again with a submit between: submit 1 must see both the image's rows and Y, and the completions keep Y.
      M.fill(0, 4096, 4100);
      M.fill(0, 4352, 4356);
      mark(at + 4096, 4);
      ex.wgt_fl_submit(1); await wait(1);
      ex.wgt_fl_submit(2);
      M.set(Y, 4200);
      mark(at + 4200, 4);
      ex.wgt_fl_submit(1);
      await wait(2); await wait(1);
      checks.keptBetween = differs(M.subarray(4200, 4204), Y);
      checks.gpuY = differs(rd.subarray(4200, 4204), Y);
      checks.gpuRow0 = differs(rd.subarray(4096, 4100), rows[0]);
      checks.gpuRow1 = differs(rd.subarray(4352, 4356), rows[1]);
      // Two of the driver's writes to one range in one submit (a fill, then an update): the last one's bytes.
      ex.wgt_fl_submit(3); await wait(3);
      checks.ordered = differs(M.subarray(6144, 6160), Uint8Array.from({ length: 16 }, (_, i) => 16 + i));
    }
  } catch (e) {
    return { error: String(e), checks, errors, warnings: v.gpu.stats.errors };
  }
  device.destroy();
  return { checks, errors, warnings: v.gpu.stats.errors };
}

/**
 * VK3 L4c-D (the static review's findings 4 and 6, and its suspended passes), after the test program's scene
 * (vk/driver/wg_test.c `wgt_link`, `wgt_pass`). `link`: a draw whose vertex and fragment shaders came with different
 * programs (a pipeline cache's entries disagreeing on their link), its quad drawn into the scene's image. `none`,
 * `partial`, `resume`, `resumePartial`: load ops NONE, DONT_CARE over part of the attachment, and a pass suspended
 * and resumed (over the whole, then part), on an image cleared blue first. `strip`, `vertexOnly`, `lineBias`
 * (`wgt_variant`, the out-of-context review of the driver): the scene's pipeline as an unrestarted strip, without a
 * fragment shader, as lines with depth bias. Named pixels of the image, and WebGPU's errors.
 */
export async function runPass(spirv: { vert: string; frag: string; comp: string }, scenario: 'link' | 'none' | 'partial' | 'resume' | 'resumePartial' | 'strip' | 'vertexOnly' | 'lineBias' | 'readOnlyDepth') {
  const adapter = await navigator.gpu?.requestAdapter();
  if (!adapter) return { skipped: 'no WebGPU adapter' };
  const device = await adapter.requestDevice(deviceRequest(adapter));
  const errors: string[] = [];
  device.addEventListener('uncapturederror', (e) => errors.push((e as GPUUncapturedErrorEvent).error.message));
  const memory = new WebAssembly.Memory({ initial: 65536, maximum: 65536, shared: true });
  const module = await WebAssembly.compileStreaming(fetch('/target/vk/venus.wasm'));
  const v = await VenusRenderer.create(module, memory, { at: 0x1000_0000, bytes: 1 << 20, watch: 0 }, device);
  const ex = v.raw as unknown as Test;
  const words = async (url: string) => new Uint8Array(await (await fetch(url)).arrayBuffer());
  const put = (b: Uint8Array) => { const p = ex.venus_alloc(b.length) >>> 0; new Uint8Array(memory.buffer, p, b.length).set(b); return [p, b.length / 4]; };
  const [vs, vn] = put(await words(spirv.vert)), [fs, fn] = put(await words(spirv.frag)), [cs, cn] = put(await words(spirv.comp));
  const text = (p: number) => { const u8 = new Uint8Array(memory.buffer); let e = p; while (u8[e]) e++; return new TextDecoder().decode(u8.slice(p, e)); };
  const wait = async (done: () => number, what: string) => {
    for (let k = 0; k < 500 && !done(); k++) await new Promise((r) => setTimeout(r, 10));
    if (!done()) throw new Error(`${what}'s fence never signalled`);
  };
  try {
    if (ex.wgt_run(vs, vn, fs, fn, cs, cn)) return { error: text(ex.wgt_error() >>> 0), errors };
    await wait(() => ex.wgt_done(), 'the scene');
    const index = { none: 0, partial: 1, resume: 2, resumePartial: 3, readOnlyDepth: 4 } as const;
    const variant = { strip: 0, vertexOnly: 1, lineBias: 2 } as const;
    let at: number;
    if (scenario === 'link' || scenario === 'strip' || scenario === 'vertexOnly' || scenario === 'lineBias') {
      new Uint8Array(memory.buffer, ex.wgt_pixels() >>> 0, 64 * 64 * 4).fill(0);
      if (scenario === 'link' ? ex.wgt_link() : ex.wgt_variant(variant[scenario])) return { error: text(ex.wgt_error() >>> 0), errors };
      await wait(() => ex.wgt_draw_done(), 'the draw');
      at = ex.wgt_pixels() >>> 0;
    } else {
      if (ex.wgt_pass(index[scenario])) return { error: text(ex.wgt_error() >>> 0), errors };
      await wait(() => ex.wgt_pass_done(), 'the passes');
      at = ex.wgt_pass_pixels() >>> 0;
    }
    const px = (x: number, y: number) => [...new Uint8Array(memory.buffer, at + (y * 64 + x) * 4, 4)];
    const pixels = { topLeft: px(16, 8), bottomLeft: px(16, 56), topRight: px(48, 8), bottomRight: px(48, 56) };
    device.destroy();
    return { pixels, errors };
  } catch (e) {
    return { error: String(e), errors };
  }
}

/**
 * VK3 L4c-F (the static review's "other real defects"): transfers and pushes WebGPU has no direct form for
 * (vk/driver/wg_test.c `wgt_misc`). `copy`: buffer copies at offsets and sizes that aren't 4-aligned, from host-visible,
 * device-local and GPU-written memory; `clear`: a clear of a format WebGPU can't render to, and of a 3D image;
 * `blit`: a blit from a 3D image's second slice; `push`: 5,000 dispatches' push constants in one submit; `pushGrown`:
 * the same after a submit of one (the push buffer grown); `freedImage`: a submit after a linear image's memory was
 * freed; `dynamicStorage`: a dynamic storage buffer's writes read back at its offset; `oddStorage`: a storage buffer
 * of an odd size bound whole. Each check: the first byte that differs from what Vulkan says (-1: none).
 */
export async function runMisc(scenario: 'copy' | 'clear' | 'blit' | 'push' | 'pushGrown' | 'freedImage' | 'dynamicStorage' | 'oddStorage' | 'freedModule' | 'depthResolve' | 'depthResolveDiscard' | 'depthResolveArea' | 'storageAliased', push: string) {
  const adapter = await navigator.gpu?.requestAdapter();
  if (!adapter) return { skipped: 'no WebGPU adapter' };
  const device = await adapter.requestDevice(deviceRequest(adapter));
  const errors: string[] = [];
  device.addEventListener('uncapturederror', (e) => errors.push((e as GPUUncapturedErrorEvent).error.message));
  const memory = new WebAssembly.Memory({ initial: 65536, maximum: 65536, shared: true });
  const module = await WebAssembly.compileStreaming(fetch('/target/vk/venus.wasm'));
  const v = await VenusRenderer.create(module, memory, { at: 0x1000_0000, bytes: 1 << 20, watch: 0 }, device);
  const ex = v.raw as unknown as Test;
  const text = (p: number) => { const u8 = new Uint8Array(memory.buffer); let e = p; while (u8[e]) e++; return new TextDecoder().decode(u8.slice(p, e)); };
  const words = new Uint8Array(await (await fetch(push)).arrayBuffer());
  const cs = ex.venus_alloc(words.length) >>> 0;
  new Uint8Array(memory.buffer, cs, words.length).set(words);
  const index = { copy: 0, clear: 1, blit: 2, push: 3, pushGrown: 4, freedImage: 5, dynamicStorage: 6, oddStorage: 7, freedModule: 8, depthResolve: 9, depthResolveDiscard: 10, depthResolveArea: 11, storageAliased: 12 }[scenario];
  if (ex.wgt_misc(index, cs, words.length / 4)) return { error: text(ex.wgt_error() >>> 0), errors };
  for (let k = 0; k < 1000 && !ex.wgt_misc_done(); k++) await new Promise((r) => setTimeout(r, 10));
  if (!ex.wgt_misc_done()) return { error: 'the fence never signalled', errors, warnings: v.gpu.stats.errors };
  const size = scenario === 'push' || scenario === 'pushGrown' ? 20000 : 4096;
  const got = new Uint8Array(memory.buffer, ex.wgt_misc_map() >>> 0, size).slice();
  const want = new Uint8Array(size).fill(0xee);
  const u32 = (b: Uint8Array) => new Uint32Array(b.buffer, b.byteOffset, b.length >> 2);
  const S = Uint8Array.from({ length: 8192 }, (_, i) => (i * 7 + 3) & 255);
  const checks: Record<string, [number, number, Uint8Array]> = {};
  if (scenario === 'copy') {
    S.set([0x0a, 0x0b, 0x0c, 0x0d, 0x0a, 0x0b, 0x0c, 0x0d, 0x0a, 0x0b, 0x0c, 0x0d, 0x0a, 0x0b, 0x0c, 0x0d], 4096);
    const L = new Uint8Array(4096);
    u32(L).fill(0x04030201);
    L.set(Uint8Array.from({ length: 16 }, (_, i) => 0x40 + i), 16);
    want.set(S.subarray(1, 14), 6);
    want.set(L.subarray(17, 27), 101);
    want.set(S.subarray(4097, 4104), 203);
    want.set(S.subarray(8, 72), 300);
    want.set(S.subarray(2, 3003), 1001);
    Object.assign(checks, { hostSource: [0, 100, want], deviceLocal: [100, 200, want], gpuWritten: [200, 300, want], aligned: [300, 1000, want], long: [1000, 4096, want] });
  } else if (scenario === 'clear') {
    u32(want.subarray(0, 64)).fill(0x81010100);
    u32(want.subarray(256, 384)).fill(0xffff0000);
    Object.assign(checks, { unrenderable: [0, 256, want], slices: [256, 4096, want] });
  } else if (scenario === 'blit') {
    u32(want.subarray(0, 64)).fill(0xff00ff00);
    Object.assign(checks, { slice: [0, 4096, want] });
  } else if (scenario === 'dynamicStorage') {
    const w = u32(want.subarray(256, 272));
    for (let k = 0; k < 4; k++) w[k] = k * 3 + 1;
    Object.assign(checks, { dynamic: [0, 4096, want] });
  } else if (scenario === 'oddStorage') {
    const w = u32(want.subarray(0, 16));
    for (let k = 0; k < 4; k++) w[k] = k * 3 + 1;
    Object.assign(checks, { odd: [0, 4096, want] });
  } else if (scenario === 'depthResolveArea') {
    // The render area (0, 0, 2, 2) resolved (0.25, 0x5a), the rest the target's (1.0, 0x33).
    const depth = new Float32Array(want.buffer, 0, 16), stencil = want.subarray(256, 272);
    for (let i = 0; i < 16; i++) {
      const inside = (i & 3) < 2 && i >> 2 < 2;
      depth[i] = inside ? 0.25 : 1.0;
      stencil[i] = inside ? 0x5a : 0x33;
    }
    Object.assign(checks, { depth: [0, 256, want], stencil: [256, 4096, want] });
  } else if (scenario === 'storageAliased') {
    u32(want.subarray(0, 16)).set([3, 5, 7, 9]);
    u32(want.subarray(512, 528)).set([1, 2, 3, 4]);
    Object.assign(checks, { written: [0, 512, want], read: [512, 4096, want] });
  } else if (scenario === 'depthResolve' || scenario === 'depthResolveDiscard') {
    new Float32Array(want.buffer, 0, 16).fill(0.25);
    want.fill(0x5a, 256, 272);
    Object.assign(checks, { depth: [0, 256, want], stencil: [256, 4096, want] });
  } else if (scenario === 'freedModule') {
    new Float32Array(want.buffer, 0, 1)[0] = 0.25;
    Object.assign(checks, { depth: [0, 4096, want] });
  } else if (scenario === 'freedImage') {
    want.fill(0x11);
    Object.assign(checks, { filled: [0, 1024, want] });
  } else {
    const w = u32(want);
    for (let k = 0; k < 5000; k++) w[k] = k * 3 + 1;
    Object.assign(checks, { push: [0, size, want] });
  }
  const differs: Record<string, number> = {};
  for (const [k, [from, to, w]] of Object.entries(checks)) {
    differs[k] = -1;
    for (let i = from; i < to; i++) if (got[i] !== w[i]) { differs[k] = i; break; }
  }
  device.destroy();
  return { checks: differs, errors, warnings: v.gpu.stats.errors, got: [...got.subarray(0, 16)] };
}
