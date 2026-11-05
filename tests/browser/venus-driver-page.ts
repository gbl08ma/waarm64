// The Vulkan driver's test program (vk/driver/wg_test.c) on this page's WebGPU device, in the renderer module
// (tests/venus-driver.test.ts): its scene's pixels, its compute pass's output and a filled buffer, read back once the
// submit's fence signalled.
import { memoryBackend, ShaderCache, type CacheBackend } from '../../web/venus-cache.ts';
import { deviceRequest } from '../../web/venus-gpu.ts';
import { VenusRenderer, type VenusPoll } from '../../web/venus-host.ts';
import { VenusImport } from '../../web/venus-import.ts';
import { VENUS_ARENA } from '../../web/ram.ts';

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
  wgt_link(): number; wgt_variant(scenario: number): number; wgt_flat(scenario: number, vs: number, vn: number, fs: number, fn: number): number; wgt_draw_params(vs: number, vn: number, fs: number, fn: number, firstInstance: number): number; wgt_angle_ubo(vs: number, vn: number, fs: number, fn: number): number; wgt_pull(scenario: number, vs: number, vn: number, fs: number, fn: number, fs2: number, fn2: number): number; wgt_scope(mask: number, vs: number, vn: number, fs: number, fn: number, cs: number, cn: number): number; wgt_scope_map(which: number): number; wgt_xfb(scenario: number, vs: number, vn: number): number; wgt_xfb_map(): number; wgt_xfb_done(): number; wgt_pass(scenario: number): number; wgt_pass_pixels(): number; wgt_pass_done(): number; wgt_pass_query(): number;
  wgt_misc(scenario: number, cs: number, cn: number): number; wgt_misc_map(): number; wgt_misc_done(): number; wgt_misc_signal(): number; wgt_misc_pool_refs(): number;
  wgt_fits(scenario: number, vs: number, vn: number, fs: number, fn: number): number;
  wgt_samples(vs: number, vn: number, fs: number, fn: number): number;
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
  const v = await VenusRenderer.create(module, memory, { at: VENUS_ARENA, bytes: 1 << 20, watch: 0 }, device, device, 'pump',
    { premake: true, ...(backend ? { cache: async (id: string) => (store = await ShaderCache.open(id, { backend })) } : {}) });
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
  const v = await VenusRenderer.create(module, memory, { at: VENUS_ARENA, bytes: 1 << 20, watch: 0 }, device);
  const ex = v.raw as unknown as Test;
  const RG8 = 65;
  const first = Uint8Array.from({ length: 16 }, (_, i) => 10 + i);
  const importer = new VenusImport(device, {
    resourceInfo: (id) => (id === 7 ? { format: RG8, width: 4, height: 2 } : undefined),
    readResource: (id) => (id === 7 ? first.slice() : null),
    videoPending: { res: () => false },
  }, (f) => v.gpu.later(f));
  const binds: number[] = [];
  // The resource's own texture takes the image's place (VK4 T16).
  v.gpu.onImport = (t, res, desc) => { binds.push(res); return importer.bind(t, res, desc); };
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
 * fence, the nudges counted (web/venus-gpu.ts `nudge`), the empty submits that reached the queue, and the polls over
 * 100 ms after the last (none: the poller stops while idle), and whether a turn scheduled under a direct poll that
 * found nothing to run is still pending 50 ms later (`stuck`), or found its ticker stopped (`stoppedUnderTurn`); the
 * ticker's ticks over the run and while idle, and the poll it ended with (`tickerUrl`: another ticker module, which may
 * fail to load).
 */
export async function runFences(spirv: { vert: string; frag: string; comp: string; costs: string }, poll: VenusPoll, n: number, tickerUrl?: string) {
  const adapter = await navigator.gpu?.requestAdapter();
  if (!adapter) return { skipped: 'no WebGPU adapter' };
  const device = await adapter.requestDevice(deviceRequest(adapter));
  const memory = new WebAssembly.Memory({ initial: 65536, maximum: 65536, shared: true });
  const module = await WebAssembly.compileStreaming(fetch('/target/vk/venus.wasm'));
  // The empty submits that reach the queue (the nudges as WebGPU sees them).
  let empty = 0;
  const submit = device.queue.submit.bind(device.queue);
  device.queue.submit = (buffers: Iterable<GPUCommandBuffer>) => { if (![...buffers].length) empty++; submit(buffers); };
  const v = await VenusRenderer.create(module, memory, { at: VENUS_ARENA, bytes: 1 << 20, watch: 0 }, device, device, poll, { tickerUrl: tickerUrl ? new URL(tickerUrl, location.href) : undefined });
  const ex = v.raw as unknown as Test;
  // The ticker's ticks (web/venus-ticker.ts) over the run, and after it while idle (`times()` counts since its last call).
  v.times();
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
  const ticks = v.times().ticks;
  // Idle (the rings never started, no submit in flight), the poller stops: no polls over 100 ms, nor ticks.
  await new Promise((r) => setTimeout(r, 20));
  const polls = v.stats.polls;
  v.times();
  await new Promise((r) => setTimeout(r, 100));
  const idlePolls = v.stats.polls - polls, idleTicks = v.times().ticks;
  // A turn scheduled (a submit's: `worked`), then a direct poll (a notify's: `wake`) finding nothing to run before that
  // turn comes: the scheduled turn still comes, and the pump schedules again after it (VK4 T13: the ticker stopped
  // under a pending turn, which never came, and the pump never scheduled again).
  // With the ticker, that poll mustn't stop it while the turn waits on it (word 1 clear: it may have ticked for the last
  // time just before the turn began waiting, and then never ticks again).
  const pump = v as unknown as { worked(): void; queued: boolean; ticks?: Int32Array };
  pump.worked();
  v.wake();
  const stoppedUnderTurn = !!pump.ticks && pump.queued && Atomics.load(pump.ticks, 1) === 0;
  await new Promise((r) => setTimeout(r, 50));
  const stuck = pump.queued;
  device.destroy();
  return { median: ms[ms.length >> 1], nudges: v.gpu.stats.nudges, empty, idlePolls, stuck, stoppedUnderTurn, ticks, idleTicks, ticker: (v as unknown as { poll: string }).poll, adapter: adapter.info.architecture };
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
  const at = VENUS_ARENA, bytes = 1 << 20, watchAt = VENUS_ARENA + 0x1000_0000;
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
  const at = VENUS_ARENA, bytes = 1 << 20, watchAt = VENUS_ARENA + 0x1000_0000;
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
export async function runPass(spirv: { vert: string; frag: string; comp: string }, scenario: 'link' | 'none' | 'partial' | 'resume' | 'resumePartial' | 'strip' | 'vertexOnly' | 'lineBias' | 'readOnlyDepth' | 'clearQuery' | 'facesUnused' | 'facesSplit' | 'flatLast' | 'flatFanLast' | 'flatFanFirst' | 'flatFanOdd' | 'flatListOdd' | 'flatRestart' | 'angleUniforms' | 'drawParams' | 'pullLayouts' | 'pullDrawParams' | 'pullGroups' | 'pullOffsets' | 'xfbList' | 'xfbOverflow' | 'xfbStrip' | 'xfbResume' | 'xfbMany' | 'xfbIndirect' | 'xfbIndexedIndirect' | 'xfbNullColors' | 'xfbPasses' | 'xfbPulled') {
  const adapter = await navigator.gpu?.requestAdapter();
  if (!adapter) return { skipped: 'no WebGPU adapter' };
  const device = await adapter.requestDevice(deviceRequest(adapter));
  const errors: string[] = [];
  device.addEventListener('uncapturederror', (e) => errors.push((e as GPUUncapturedErrorEvent).error.message));
  const memory = new WebAssembly.Memory({ initial: 65536, maximum: 65536, shared: true });
  const module = await WebAssembly.compileStreaming(fetch('/target/vk/venus.wasm'));
  const v = await VenusRenderer.create(module, memory, { at: VENUS_ARENA, bytes: 1 << 20, watch: 0 }, device);
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
    const index = { none: 0, partial: 1, resume: 2, resumePartial: 3, readOnlyDepth: 4, clearQuery: 5, facesUnused: 6, facesSplit: 7 } as const;
    const variant = { strip: 0, vertexOnly: 1, lineBias: 2 } as const;
    const flat = { flatLast: 0, flatFanLast: 1, flatFanFirst: 2, flatFanOdd: 3, flatListOdd: 4, flatRestart: 5 } as const;
    let at: number, draws = 0;
    if (scenario === 'xfbMany') {
      // wgt_xfb's scenario 4: four buffers of 16 bytes a vertex from six vertex bindings (wg_test.c).
      const quad = [[-1.5, -1, 0.5, 0, 0], [-0.5, -1, 0.5, 1, 0], [-0.5, 1, 0.5, 1, 1], [-1.5, 1, 0.5, 0, 1], [-1, -1, 0.75, 0, 0], [1, -1, 0.75, 0, 0]];
      const want = new Uint8Array(4096).fill(0xee);
      quad.forEach(([x, y, z, u, w], k) => {
        new Float32Array(want.buffer, 16 * k, 4).set([x, y, z, 1]);
        new Float32Array(want.buffer, 512 + 16 * k, 4).set([y, z, u, 0]);
        new Float32Array(want.buffer, 1024 + 16 * k, 4).set([w, x, k, 0]);
        new Float32Array(want.buffer, 1536 + 16 * k, 4).set([7, 8, 9, 10]);
      });
      new Uint32Array(want.buffer, 2048, 1)[0] = 96;
      const [xv, xvn] = put(await words('/target/vk/test/xfb-many.vert.spv'));
      if (ex.wgt_xfb(4, xv, xvn)) return { error: text(ex.wgt_error() >>> 0), errors };
      await wait(() => ex.wgt_xfb_done(), 'the capture');
      const got = new Uint8Array(memory.buffer, ex.wgt_xfb_map() >>> 0, 4096).slice();
      let differs = -1;
      for (let i = 0; i < 4096; i++) if (got[i] !== want[i]) { differs = i; break; }
      device.destroy();
      return { differs, got: [...new Float32Array(got.buffer, 0, 48)], counter: new Uint32Array(got.buffer, 2048, 1)[0], errors, warnings: v.gpu.stats.errors };
    }
    if (scenario === 'xfbList' || scenario === 'xfbOverflow' || scenario === 'xfbStrip' || scenario === 'xfbResume' || scenario === 'xfbIndirect' || scenario === 'xfbIndexedIndirect' || scenario === 'xfbPulled' || scenario === 'xfbNullColors' || scenario === 'xfbPasses') {
      // wgt_xfb's records: each vertex's (x, y, z, 1) and (u, v, its index, 7), from the scene's vertices (wg_test.c).
      const quad = [[-1.5, -1, 0.5, 0, 0], [-0.5, -1, 0.5, 1, 0], [-0.5, 1, 0.5, 1, 1], [-1.5, 1, 0.5, 0, 1], [-1, -1, 0.75, 0, 0], [1, -1, 0.75, 0, 0]];
      const order = scenario === 'xfbOverflow' ? [0, 1, 2] : scenario === 'xfbStrip' ? [0, 1, 2, 1, 3, 2]
        : scenario === 'xfbIndexedIndirect' ? [0, 1, 2, 0, 2, 3] : scenario === 'xfbPasses' ? Array.from({ length: 17 }, () => [0, 1, 2]).flat() : [0, 1, 2, 3, 4, 5];
      const want = new Uint8Array(4096).fill(0xee);
      const f = new Float32Array(want.buffer, 0, order.length * 8);
      order.forEach((v, k) => f.set([quad[v][0], quad[v][1], quad[v][2], 1, quad[v][3], quad[v][4], v, 7], 8 * k));
      new Uint32Array(want.buffer, 2048, 1)[0] = scenario === 'xfbPasses' ? 96 : order.length * 32;
      const [xv, xvn] = put(await words('/target/vk/test/xfb.vert.spv'));
      const xi = { xfbList: 0, xfbOverflow: 1, xfbStrip: 2, xfbResume: 3, xfbIndirect: 5, xfbIndexedIndirect: 6, xfbNullColors: 7, xfbPasses: 8, xfbPulled: 9 }[scenario];
      if (ex.wgt_xfb(xi, xv, xvn)) return { error: text(ex.wgt_error() >>> 0), errors };
      await wait(() => ex.wgt_xfb_done(), 'the capture');
      const got = new Uint8Array(memory.buffer, ex.wgt_xfb_map() >>> 0, 4096).slice();
      let differs = -1;
      for (let i = 0; i < 4096; i++) if (got[i] !== want[i]) { differs = i; break; }
      device.destroy();
      return { differs, got: [...new Float32Array(got.buffer, 0, 48)], counter: new Uint32Array(got.buffer, 2048, 1)[0], errors, warnings: v.gpu.stats.errors };
    }
    if (scenario === 'flatLast' || scenario === 'flatFanLast' || scenario === 'flatFanFirst' || scenario === 'flatFanOdd' || scenario === 'flatListOdd' || scenario === 'flatRestart') {
      const [fv, fvn] = put(await words('/target/vk/test/flat.vert.spv')), [ff, ffn] = put(await words('/target/vk/test/flat.frag.spv'));
      new Uint8Array(memory.buffer, ex.wgt_pixels() >>> 0, 64 * 64 * 4).fill(0);
      if (ex.wgt_flat(flat[scenario], fv, fvn, ff, ffn)) return { error: text(ex.wgt_error() >>> 0), errors };
      await wait(() => ex.wgt_draw_done(), 'the draw');
      at = ex.wgt_pixels() >>> 0;
    } else if (scenario === 'angleUniforms') {
      // VK3 L7b: ANGLE's ES3 layout of uniform buffers (wg_test.c's wgt_angle_ubo).
      const [av, avn] = put(await words('/target/vk/test/angle-ubo.vert.spv')), [af, afn] = put(await words('/target/vk/test/angle-ubo.frag.spv'));
      new Uint8Array(memory.buffer, ex.wgt_pixels() >>> 0, 64 * 64 * 4).fill(0);
      if (ex.wgt_angle_ubo(av, avn, af, afn)) return { error: text(ex.wgt_error() >>> 0), errors };
      await wait(() => ex.wgt_draw_done(), 'the draw');
      at = ex.wgt_pixels() >>> 0;
    } else if (scenario === 'drawParams') {
      // VK3 L7.5: four draws' parameters (wg_test.c's wgt_draw_params), first instances in indirect draws where the
      // adapter has them.
      const [dv, dvn] = put(await words('/target/vk/test/draw-params.vert.spv')), [ff, ffn] = put(await words('/target/vk/test/flat.frag.spv'));
      new Uint8Array(memory.buffer, ex.wgt_pixels() >>> 0, 64 * 64 * 4).fill(0);
      if (ex.wgt_draw_params(dv, dvn, ff, ffn, adapter.features.has('indirect-first-instance') ? 1 : 0)) return { error: text(ex.wgt_error() >>> 0), errors };
      await wait(() => ex.wgt_draw_done(), 'the draws');
      at = ex.wgt_pixels() >>> 0;
    } else if (scenario === 'pullLayouts' || scenario === 'pullDrawParams' || scenario === 'pullGroups' || scenario === 'pullOffsets') {
      // VK4 T5: vertex layouts WebGPU's vertex buffers refuse (wg_test.c's wgt_pull).
      const [pv, pvn] = put(await words(`/target/vk/test/vertex-pull${scenario === 'pullGroups' ? '-fixed' : ''}.vert.spv`)), [ff, ffn] = put(await words(`/target/vk/test/${scenario === 'pullGroups' ? 'vertex-pull0' : 'flat'}.frag.spv`)), [pf, pfn] = put(await words('/target/vk/test/vertex-pull.frag.spv'));
      new Uint8Array(memory.buffer, ex.wgt_pixels() >>> 0, 64 * 64 * 4).fill(0);
      if (ex.wgt_pull(['pullLayouts', 'pullDrawParams', 'pullGroups', 'pullOffsets'].indexOf(scenario), pv, pvn, ff, ffn, pf, pfn)) return { error: text(ex.wgt_error() >>> 0), errors };
      await wait(() => ex.wgt_draw_done(), 'the draws');
      at = ex.wgt_pixels() >>> 0;
    } else if (scenario === 'link' || scenario === 'strip' || scenario === 'vertexOnly' || scenario === 'lineBias') {
      new Uint8Array(memory.buffer, ex.wgt_pixels() >>> 0, 64 * 64 * 4).fill(0);
      if (scenario === 'link' ? ex.wgt_link() : ex.wgt_variant(variant[scenario])) return { error: text(ex.wgt_error() >>> 0), errors };
      await wait(() => ex.wgt_draw_done(), 'the draw');
      at = ex.wgt_pixels() >>> 0;
    } else {
      draws = v.gpu.stats.draws;
      if (ex.wgt_pass(index[scenario])) return { error: text(ex.wgt_error() >>> 0), errors };
      await wait(() => ex.wgt_pass_done(), 'the passes');
      draws = v.gpu.stats.draws - draws;
      at = ex.wgt_pass_pixels() >>> 0;
    }
    const px = (x: number, y: number) => [...new Uint8Array(memory.buffer, at + (y * 64 + x) * 4, 4)];
    const pixels = { topLeft: px(16, 8), bottomLeft: px(16, 56), topRight: px(48, 8), bottomRight: px(48, 56) };
    // clearQuery's occlusion values (wgt_pass_query).
    const query = scenario === 'clearQuery' ? [...new BigUint64Array(memory.buffer, ex.wgt_pass_query() >>> 0, 3)].map(Number) : undefined;
    const firstInstance = adapter.features.has('indirect-first-instance');
    device.destroy();
    return { pixels, errors, query, draws, firstInstance };
  } catch (e) {
    return { error: String(e), errors };
  }
}

/**
 * VK4 T3: usage scopes in a render pass (wg_test.c's wgt_scope): a draw that writes storage of a memory M and reads,
 * by `mask`'s bits, its vertex buffer, index buffer, uniform, storage or indirect arguments from M too (32: another
 * draw before it reads them all from M and writes N; 64: a dispatch after the pass whose set was bound inside it). M's
 * and N's first words, and 64's dispatch's.
 */
export async function runScope(spirv: { vert: string; frag: string; comp: string }, mask: number) {
  const adapter = await navigator.gpu?.requestAdapter();
  if (!adapter) return { skipped: 'no WebGPU adapter' };
  const device = await adapter.requestDevice(deviceRequest(adapter));
  const errors: string[] = [];
  device.addEventListener('uncapturederror', (e) => errors.push((e as GPUUncapturedErrorEvent).error.message));
  const memory = new WebAssembly.Memory({ initial: 65536, maximum: 65536, shared: true });
  const module = await WebAssembly.compileStreaming(fetch('/target/vk/venus.wasm'));
  const v = await VenusRenderer.create(module, memory, { at: VENUS_ARENA, bytes: 1 << 20, watch: 0 }, device);
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
    const [sv, svn] = put(await words('/target/vk/test/scope.vert.spv')), [sf, sfn] = put(await words('/target/vk/test/scope.frag.spv'));
    const [sc, scn] = put(await words('/target/vk/test/ubo-ssbo.comp.spv'));
    if (ex.wgt_scope(mask, sv, svn, sf, sfn, sc, scn)) return { error: text(ex.wgt_error() >>> 0), errors };
    await wait(() => ex.wgt_draw_done(), 'the draw');
    const word = (which: number, at = 0) => new Uint32Array(memory.buffer, (ex.wgt_scope_map(which) >>> 0) + at, 1)[0];
    const got = { m: word(0), n: word(1), ...(mask & 64 ? { dispatched: word(1, 3072) } : {}) };
    device.destroy();
    return { got, errors };
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
export async function runMisc(scenario: 'copy' | 'rwImage' | 'rwImageWide' | 'mutableViews' | 'resolve3d' | 'msCopyWithin' | 'clear' | 'blit' | 'push' | 'pushGrown' | 'freedImage' | 'dynamicStorage' | 'oddStorage' | 'freedModule' | 'depthResolve' | 'depthResolveDiscard' | 'depthResolveArea' | 'storageAliased' | 'waitBeforeSignal' | 'texelBuffer' | 'bindGroupsShared' | 'depthCopies' | 'uniformBeside' | 'indirectBeside' | 'emptyAfterHeld' | 'queryAfterDispatch' | 'poolFreed' | 'ycbcr' | 'manyUniforms' | 'texelStorage' | 'dynamicUniforms' | 'writtenShared' | 'immutableSampler' | 'bigUniform' | 'sharedSampler' | 'sameMemoryCopy' | 'sameImageCopy' | 'immutableCopied' | 'uniformWritten' | 'indirectWritten' | 'readInPlace' | 'threeSame' | 'oddRange' | 'msLayersSrgb' | 'msLayersPacked' | 'oneRow' | 'resolveTwin' | 'msLayers' | 'msTwins' | 'msPacked' | 'msFormats' | 'attachmentSizes' | 'loadNone' | 'manyLayers' | 'packedFeedback' | 'feedbackLayer' | 'addresses' | 'addressesUniform' | 'twoReads' | 'sameRange' | 'overlappingRanges' | 'inlineBlocks' | 'depthLess' | 'depthAndCompare' | 'intGather' | 'cubeSized' | 'cubeGather' | 'depthEight' | 'inlineLong' | 'immutableFreed' | 'sixteenBindings' | 'sixteenThenOne' | 'cubePlain' | 'vertexCompares' | 'fourSets' | 'bc1Blit' | 'readOnlyImages' | 'g4Views' | 'texturesFull' | 'sizeOnly' | 'formatless' | 'declaredOther' | 'arrayAsFlat' | 'texelUniforms' | 'queuesTimeline' | 'queuesBinary' | 'rgb9e5Words', push: string, skip: string[] = []) {
  const adapter = await navigator.gpu?.requestAdapter();
  if (!adapter) return { skipped: 'no WebGPU adapter' };
  const device = await adapter.requestDevice(deviceRequest(adapter));
  const errors: string[] = [];
  device.addEventListener('uncapturederror', (e) => errors.push((e as GPUUncapturedErrorEvent).error.message));
  const memory = new WebAssembly.Memory({ initial: 65536, maximum: 65536, shared: true });
  const module = await WebAssembly.compileStreaming(fetch('/target/vk/venus.wasm'));
  // `ycbcr`: the device with `?gpu=vkycbcr`'s YCbCr conversions (VK3 L7.2).
  const v = await VenusRenderer.create(module, memory, { at: VENUS_ARENA, bytes: 1 << 20, watch: 0 }, device, undefined, undefined, { ycbcr: scenario === 'ycbcr', skip });
  const ex = v.raw as unknown as Test;
  const text = (p: number) => { const u8 = new Uint8Array(memory.buffer); let e = p; while (u8[e]) e++; return new TextDecoder().decode(u8.slice(p, e)); };
  const words = new Uint8Array(await (await fetch(push)).arrayBuffer());
  const cs = ex.venus_alloc(words.length) >>> 0;
  new Uint8Array(memory.buffer, cs, words.length).set(words);
  const index = { copy: 0, resolve3d: 36, msCopyWithin: 37, mutableViews: 38, rwImage: 41, rwImageWide: 42, clear: 1, blit: 2, push: 3, pushGrown: 4, freedImage: 5, dynamicStorage: 6, oddStorage: 7, freedModule: 8, depthResolve: 9, depthResolveDiscard: 10, depthResolveArea: 11, storageAliased: 12, waitBeforeSignal: 13, texelBuffer: 14, bindGroupsShared: 15, depthCopies: 16, uniformBeside: 17, indirectBeside: 18, emptyAfterHeld: 19, queryAfterDispatch: 20, poolFreed: 21, ycbcr: 22, manyUniforms: 23, texelStorage: 24, dynamicUniforms: 25, writtenShared: 26, immutableSampler: 27, bigUniform: 28, sharedSampler: 29, sameMemoryCopy: 30, sameImageCopy: 31, immutableCopied: 32, uniformWritten: 33, indirectWritten: 34, readInPlace: 35, addresses: 39, inlineBlocks: 40, addressesUniform: 43, twoReads: 44, sameRange: 45, overlappingRanges: 46, threeSame: 60, oddRange: 61, msLayersSrgb: 63, msLayersPacked: 64, oneRow: 52, resolveTwin: 53, msLayers: 55, msTwins: 56, msPacked: 57, msFormats: 59, attachmentSizes: 47, loadNone: 48, manyLayers: 49, packedFeedback: 50, feedbackLayer: 51, depthLess: 70, depthAndCompare: 71, intGather: 72, cubeSized: 73, cubeGather: 74, depthEight: 75, inlineLong: 76, immutableFreed: 77, sixteenBindings: 78, sixteenThenOne: 79, cubePlain: 80, vertexCompares: 81, fourSets: 82, bc1Blit: 83, readOnlyImages: 84, g4Views: 85, texturesFull: 86, sizeOnly: 87, formatless: 88, declaredOther: 89, arrayAsFlat: 90, texelUniforms: 91, queuesTimeline: 92, queuesBinary: 93, rgb9e5Words: 94 }[scenario];
  if (push.endsWith('.frag.spv')) {
    const vert = new Uint8Array(await (await fetch(`/target/vk/test/${scenario === 'cubeSized' ? 'r5/cube-sized' : scenario === 'sixteenBindings' || scenario === 'sixteenThenOne' || scenario === 'fourSets' ? 'r7/sixteen' : scenario === 'vertexCompares' ? 'r7/vs-compare' : 'feedback'}.vert.spv`)).arrayBuffer());
    const vs = ex.venus_alloc(vert.length) >>> 0;
    new Uint8Array(memory.buffer, vs, vert.length).set(vert);
    (ex as unknown as { wgt_misc_vs(p: number, n: number): void }).wgt_misc_vs(vs, vert.length / 4);
  }
  if (ex.wgt_misc(index, cs, words.length / 4)) return { error: text(ex.wgt_error() >>> 0), errors };
  if (scenario === 'emptyAfterHeld') {
    // The fence of the submit behind the held copy: unsignalled while the copy waits for the host.
    for (let k = 0; k < 30; k++) await new Promise((r) => setTimeout(r, 10));
    if (ex.wgt_misc_done()) return { error: 'the fence after a held submit signalled before it ran', errors };
    if (ex.wgt_misc_signal()) return { error: text(ex.wgt_error() >>> 0), errors };
  }
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
  } else if (scenario === 'poolFreed') {
    // The pending submit's references to the destroyed pool, as a byte: none.
    got[0] = ex.wgt_misc_pool_refs();
    want[0] = 0;
    Object.assign(checks, { refs: [0, 1, want] });
  } else if (scenario === 'queryAfterDispatch') {
    const w = u32(want.subarray(0, 16));
    for (let k = 0; k < 4; k++) w[k] = k * 3 + 1;
    u32(want.subarray(1024, 1028))[0] = 0; // no pass inside it: nothing counted
    Object.assign(checks, { dispatched: [0, 1024, want], query: [1024, 4096, want] });
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
  } else if (scenario === 'emptyAfterHeld') {
    want.fill(0x22, 0, 64);
    Object.assign(checks, { copied: [0, 4096, want] });
  } else if (scenario === 'texelStorage') {
    // Refused (untouched) where the adapter's storage buffers are fewer than 11, else each buffer's texel + i.
    const ran = new Uint8Array(4096).fill(0xee);
    for (let i = 0; i < 8; i++) u32(ran.subarray(256 * i, 256 * i + 4))[0] = 100 * ((i % 3) + 1) + i;
    Object.assign(checks, { untouched: [0, 4096, want], ran: [0, 4096, ran] });
  } else if (scenario === 'texelUniforms') {
    u32(want.subarray(0, 52)).set([...Array.from({ length: 9 }, (_, i) => 100 * (i + 1)), 1000, 1001, 1002, 1003]);
    Object.assign(checks, { read: [0, 4096, want] });
  } else if (scenario === 'dynamicUniforms') {
    u32(want.subarray(0, 32)).set(Array.from({ length: 8 }, (_, i) => 105 + i));
    Object.assign(checks, { read: [0, 4096, want] });
  } else if (scenario === 'writtenShared') {
    u32(want.subarray(0, 16)).fill(7);
    u32(want.subarray(512, 528)).fill(9);
    Object.assign(checks, { x: [0, 512, want], y: [512, 4096, want] });
  } else if (scenario === 'sameMemoryCopy') {
    u32(want.subarray(0, 16)).set([1, 2, 3, 4]);
    u32(want.subarray(256, 272)).set([5, 6, 7, 8]);
    u32(want.subarray(1024, 1040)).set([9, 10, 11, 12]);
    u32(want.subarray(2048, 2064)).set([9, 10, 11, 12]);
    Object.assign(checks, { twoBuffers: [0, 256, want], oneBuffer: [256, 1024, want], itself: [1024, 4096, want] });
  } else if (scenario === 'sameImageCopy') {
    // Texel i 0xff000000 | i; its (0, 0) 2×2 copied to (2, 2) and blitted to (2, 0).
    const t = u32(want.subarray(0, 64));
    for (let i = 0; i < 16; i++) t[i] = (0xff000000 | i) >>> 0;
    for (let y = 0; y < 2; y++) for (let x = 0; x < 2; x++) t[(y + 2) * 4 + x + 2] = t[y * 4 + x + 2] = (0xff000000 | (y * 4 + x)) >>> 0;
    Object.assign(checks, { copied: [32, 64, want], blitted: [0, 32, want], rest: [64, 4096, want] });
  } else if (scenario === 'resolve3d' || scenario === 'msCopyWithin') {
    // Red texels (little-endian RGBA), blue where the resolve or the copies put them (wg_test.c 36, 37).
    const RED = 0xff0000ff, BLUE = 0xffff0000;
    const slices = scenario === 'resolve3d' ? 2 : 1, t = u32(want.subarray(0, 64 * slices));
    t.fill(RED);
    const blue = scenario === 'resolve3d' ? [...Array(16).keys()].map((i) => 16 + i) : [0, 1, 4, 5, 10, 11, 14, 15];
    for (const i of blue) t[i] = BLUE;
    Object.assign(checks, { texels: [0, 64 * slices, want] });
  } else if (scenario === 'depthLess' || scenario === 'depthAndCompare' || scenario === 'intGather' || scenario === 'cubeSized' || scenario === 'cubeGather' || scenario === 'depthEight' || scenario === 'sixteenBindings' || scenario === 'sixteenThenOne' || scenario === 'cubePlain' || scenario === 'vertexCompares' || scenario === 'fourSets' || scenario === 'bc1Blit') {
    // VK4 R5 (wg_test.c 70 to 74): texel (1, 1), a filtered byte within 1.
    const texel = { depthLess: [255, 255, 255, 255], depthAndCompare: [255, 64, 64, 128], intGather: [0, 128, 0, 255], cubeSized: [255, 0, 4, 255], cubeGather: [17, 17, 17, 17], depthEight: [255, 0, 0, 255], sixteenBindings: [255, 128, 64, 255], sixteenThenOne: [255, 128, 64, 255], cubePlain: [255, 64, 0, 255], vertexCompares: [255, 64, 0, 255], fourSets: [17, 17, 17, 17], bc1Blit: [0, 0, 0, 255] }[scenario];
    want.set(texel);
    for (let i = 0; i < 4; i++) if (Math.abs(got[i] - want[i]) <= 1) got[i] = want[i];
    if (scenario === 'depthEight') {
      // The shader store's counts, as a byte.
      got[4] = (ex as unknown as { wgt_info_refused(): number }).wgt_info_refused();
      want[4] = 1;
    }
    Object.assign(checks, { texel: [0, 4, want], rest: [4, 4096, want] });
  } else if (scenario === 'inlineLong') {
    u32(want.subarray(0, 16)).set([5001, 5002, 5003, 5004]);
    Object.assign(checks, { read: [0, 4096, want] });
  } else if (scenario === 'immutableSampler' || scenario === 'immutableCopied' || scenario === 'immutableFreed') {
    u32(want.subarray(0, 4))[0] = 50;
    Object.assign(checks, { linear: [0, 4096, want] });
  } else if (scenario === 'bigUniform') {
    u32(want.subarray(0, 8)).set([41, 42]);
    Object.assign(checks, { small: [0, 4, want], big: [4, 4096, want] });
  } else if (scenario === 'sharedSampler') {
    u32(want.subarray(0, 8)).set([50, 25]);
    Object.assign(checks, { color: [0, 4, want], depth: [4, 4096, want] });
  } else if (scenario === 'manyUniforms') {
    u32(want.subarray(0, 52)).set(Array.from({ length: 13 }, (_, i) => 105 + i));
    Object.assign(checks, { read: [0, 4096, want] });
  } else if (scenario === 'uniformBeside' || scenario === 'indirectBeside') {
    u32(want.subarray(0, 16)).set([101, 102, 103, 104]);
    Object.assign(checks, { written: [0, 4096, want] });
  } else if (scenario === 'rgb9e5Words') {
    // VK4 T23 (wg_test.c 94): an R32_UINT image through an E5B9G9R9 view: halfway between its texels, and its second.
    new Float32Array(want.buffer, 0, 8).set([2, 1.25, 0.125, 1, 3, 2, 0, 1]);
    Object.assign(checks, { decoded: [0, 32, want] });
  } else if (scenario === 'mutableViews') {
    // VK4 T4 (wg_test.c 38): level 1 read in the view's format; level 0 green but the texel stored; level 1 red.
    u32(want.subarray(0, 4))[0] = 0xff0000ff;
    u32(want.subarray(256, 320)).fill(0xff00ff00);
    u32(want.subarray(256, 320))[5] = 0x04030201;
    u32(want.subarray(512, 528)).fill(0xff0000ff);
    Object.assign(checks, { read: [0, 4, want], levels: [256, 528, want] });
  } else if (scenario === 'rwImage') {
    // VK4 T11 (wg_test.c 41): the size the shader saw; each dispatch's texels swapped from their clear; level 0 as cleared.
    u32(want.subarray(0, 8)).set([65, 2]);
    want.subarray(256, 264).set([0xcc, 0x33, 0xcc, 0x33, 0xcc, 0x33, 0xcc, 0x33]);
    want.subarray(512, 520).set([0x99, 0x66, 0x99, 0x66, 0x99, 0x66, 0x99, 0x66]);
    for (let i = 0; i < 16; i++) want.set([0xff, 0], 768 + 2 * i);
    Object.assign(checks, { size: [0, 8, want], first: [256, 264, want], second: [512, 520, want], cleared: [768, 800, want] });
  } else if (scenario === 'readOnlyImages') {
    // GD G4 (wg_test.c 84): each view's texel, the array's and cube's sizes, the RGBA8 texel packed, the stored texel.
    u32(want.subarray(0, 60)).set([101, 102, 103, 104, 105, 106, 1, 104, 2, 2, 105, 2, 0xffff00ff, 2, 4]);
    u32(want.subarray(256, 272)).set([7, 1103, 7, 7]);
    Object.assign(checks, { read: [0, 64, want], stored: [256, 4096, want] });
  } else if (scenario === 'formatless') {
    // GD G5 (wg_test.c 88): the width; RGBA8's texel 1 written; RG8's texel 2 (0.2, 0.8 as bytes); R32F's texel 3 2·3+1.
    u32(want.subarray(0, 4))[0] = 2;
    u32(want.subarray(256, 272)).set([0, 0xffff00ff, 0, 0]);
    want.subarray(512, 520).set([0, 0, 0, 0, 51, 204, 0, 0]);
    new Float32Array(want.buffer, want.byteOffset + 768, 4).set([3, 3, 3, 7]);
    Object.assign(checks, { size: [0, 4, want], rgba8: [256, 272, want], rg8: [512, 520, want], r32f: [768, 4096, want] });
  } else if (scenario === 'declaredOther') {
    // GD G7 (wg_test.c 89): as formatless, the second an R8 view of an image the shader declares rgba8: texel 2 is 0.2.
    u32(want.subarray(0, 4))[0] = 2;
    u32(want.subarray(256, 272)).set([0, 0xffff00ff, 0, 0]);
    want.subarray(512, 516).set([0, 0, 51, 0]);
    new Float32Array(want.buffer, want.byteOffset + 768, 4).set([3, 3, 3, 7]);
    Object.assign(checks, { size: [0, 4, want], rgba8: [256, 272, want], r8: [512, 516, want], r32f: [768, 4096, want] });
  } else if (scenario === 'texturesFull' || scenario === 'sizeOnly') {
    // GD G4 (wg_test.c 86, 87): the textures' green summed and the image's texel; the size (GD G5: the view's).
    if (scenario === 'texturesFull') u32(want.subarray(0, 8)).set([16, 42]);
    else u32(want.subarray(0, 4))[0] = 2;
    Object.assign(checks, { written: [0, 4096, want] });
  } else if (scenario === 'g4Views' || scenario === 'arrayAsFlat') {
    // GD G4 (wg_test.c 85): layer 1's green through the 2D view of it; 0x1234's nibbles as R4G4B4A4 (17 a step of 15).
    u32(want.subarray(0, 8)).set([0xff00ff00, 0x44332211]);
    Object.assign(checks, { flat: [0, 4, want], packed: [4, 4096, want] });
  } else if (scenario === 'rwImageWide') {
    // VK4 T11 (wg_test.c 42): as rwImage, of two 32-bit floats a texel.
    u32(want.subarray(0, 8)).set([65, 2]);
    const floats = (at: number, n: number, a: number, b: number) => new Float32Array(want.buffer, want.byteOffset + at, 2 * n).set(Array.from({ length: 2 * n }, (_, i) => (i & 1 ? b : a)));
    floats(256, 4, 0.75, 0.25);
    floats(512, 4, 0.625, 0.375);
    floats(768, 16, 1, 0);
    Object.assign(checks, { size: [0, 8, want], first: [256, 288, want], second: [512, 544, want], cleared: [768, 896, want] });
  } else if (scenario === 'uniformWritten' || scenario === 'indirectWritten' || scenario === 'readInPlace') {
    // VK4 T3: the uniform, the indirect arguments or `a` in the memory the dispatch writes (wg_test.c 33 to 35).
    u32(want.subarray(0, 16)).set([101, 102, 103, 104]);
    if (scenario === 'uniformWritten') u32(want.subarray(256, 260))[0] = 100;
    if (scenario === 'indirectWritten') u32(want.subarray(512, 524)).set([1, 1, 1]);
    Object.assign(checks, { written: [0, 4096, want] });
  } else if (scenario === 'inlineBlocks') {
    // VK4 T7 (wg_test.c 40): each block's four words, both written by one update and copied by one copy.
    u32(want.subarray(0, 16)).set([5001, 6002, 7003, 8004]);
    Object.assign(checks, { blocks: [0, 4096, want] });
  } else if (scenario === 'addresses') {
    // VK4 T7 (wg_test.c 39): what the pointers read, through the descriptor, and what they wrote.
    u32(want.subarray(1024, 1040)).set([40, 41, 42, 43]);
    u32(want.subarray(32, 48)).set([100, 101, 102, 103]);
    Object.assign(checks, { pointers: [0, 512, want], descriptor: [512, 4096, want] });
  } else if (scenario === 'threeSame') {
    u32(want.subarray(256, 304)).set([10, 11, 12, 13, 20, 21, 22, 23, 30, 31, 32, 33]);
    Object.assign(checks, { written: [0, 4096, want] });
  } else if (scenario === 'oddRange') {
    // two-writes.comp's lengths: 15 words of 62 bytes, the binding whole words.
    u32(want.subarray(256, 320)).set([10, 11, 12, 13, 20, 21, 22, 23, 25, 26, 27, 28, 35, 36, 37, 38]);
    Object.assign(checks, { written: [0, 4096, want] });
  } else if (scenario === 'msLayersSrgb') {
    want.set([188, 188, 188, 255], 0);
    Object.assign(checks, { written: [0, 4096, want] });
  } else if (scenario === 'msLayersPacked') {
    want.set([0x00, 0xf8], 0);
    Object.assign(checks, { written: [0, 4096, want] });
  } else if (scenario === 'oneRow') {
    // VK4 R4 (wg_test.c 52): the 10 texels there and back.
    const bytes = Uint8Array.from({ length: 40 }, (_, i) => i + 1);
    want.set(bytes, 0);
    want.set(bytes, 64);
    Object.assign(checks, { written: [0, 4096, want] });
  } else if (scenario === 'msLayers') {
    want.set([128, 128, 128, 255, 64, 128, 191, 255], 0);
    Object.assign(checks, { written: [0, 4096, want] });
  } else if (scenario === 'msTwins' || scenario === 'resolveTwin') {
    want.set(scenario === 'msTwins' ? [188, 188, 188, 255] : [188, 188, 188, 255], 0);
    Object.assign(checks, { written: [0, 4096, want] });
  } else if (scenario === 'msPacked') {
    want.set([0x00, 0xf8], 0);
    Object.assign(checks, { written: [0, 4096, want] });
  } else if (scenario === 'msFormats') {
    want.set([128, 128, 128, 255], 0);
    Object.assign(checks, { written: [0, 4096, want] });
  } else if (scenario === 'attachmentSizes' || scenario === 'loadNone' || scenario === 'manyLayers') {
    // VK4 R3 (wg_test.c 47 to 49): (0.25, 0.5, 0.75, 1) as bytes.
    want.set([64, 128, 191, 255], 0);
    if (scenario === 'manyLayers') want.set([64, 128, 191, 255], 4);
    if (scenario === 'attachmentSizes') new Float32Array(want.buffer, want.byteOffset + 256, 2).set([0.25, 0.75]);
    Object.assign(checks, { written: [0, 4096, want] });
  } else if (scenario === 'packedFeedback' || scenario === 'feedbackLayer') {
    // VK4 R3 (wg_test.c 50, 51): pure red as R5G6B5, pure green (layer 1's) as RGBA8.
    if (scenario === 'packedFeedback') want.set([0x00, 0xf8], 0);
    else want.set([0, 255, 0, 255], 0);
    Object.assign(checks, { written: [0, 4096, want] });
  } else if (scenario === 'addressesUniform') {
    // VK4 R2 (wg_test.c 43): the pointers' reads plus the uniform, through the descriptor, and the pointers' writes.
    u32(want.subarray(1024, 1040)).fill(1040);
    u32(want.subarray(32, 48)).set([100, 101, 102, 103]);
    u32(want.subarray(2048, 2052))[0] = 1000;
    Object.assign(checks, { pointers: [0, 512, want], descriptor: [512, 4096, want] });
  } else if (scenario === 'twoReads') {
    // VK4 R2 (wg_test.c 44): a + 2b, both the same words.
    u32(want.subarray(0, 16)).set([3, 6, 9, 12]);
    u32(want.subarray(1024, 1040)).set([1, 2, 3, 4]);
    Object.assign(checks, { written: [0, 4096, want] });
  } else if (scenario === 'sameRange' || scenario === 'overlappingRanges') {
    // VK4 R2 (wg_test.c 45, 46, two-writes.comp): `b` is `a` on by `d` words; each knows its length.
    const [a, d, la, lb] = scenario === 'sameRange' ? [256, 0, 16, 16] : [256, 64, 128, 128];
    for (let i = 0; i < 4; i++) {
      const words = u32(want.subarray(a, a + 4 * Math.max(la, d + lb)));
      words[i] = 10 + i;
      words[d + i + 4] = 20 + i;
      words[d + i + 8] = 10 + i + lb;
      words[i + 12] = 20 + i + la;
    }
    Object.assign(checks, { written: [0, 4096, want] });
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
  } else if (scenario === 'depthCopies') {
    const f = (at: number, n: number) => new Float32Array(want.buffer, at, n);
    const whole = f(0, 16).fill(1);
    whole.set([0.25, 0.5], 5);
    whole.set([0.75, 0.125], 9);
    f(256, 4).set([0.25, 0.5, 0.75, 0.125]);
    const d24 = new Uint32Array(want.buffer, 512, 16);
    for (let i = 0; i < 16; i++) d24[i] = (i * 0x111111 + 7) & 0xffffff;
    const b = f(1024, 16).fill(0);
    b.set([0.25, 0.5], 0);
    b.set([0.75, 0.125], 4);
    want.fill(0x33, 2048, 2064);
    want.set([0x5a, 0xa5], 2048 + 5);
    want.set([0x01, 0xfe], 2048 + 9);
    Object.assign(checks, { uploadPart: [0, 64, want], downloadPart: [64, 512, want], d24: [512, 1024, want], copyPart: [1024, 2048, want], stencilPart: [2048, 4096, want] });
  } else if (scenario === 'bindGroupsShared') {
    u32(want.subarray(0, 16)).fill(0xeeeeeeee + 63);
    Object.assign(checks, { added: [0, 4096, want] });
  } else if (scenario === 'texelBuffer') {
    // What texel-buffer.comp reads of S through each view, as integers, and writes as half floats.
    const w = new Int32Array(want.buffer, 0, 1024);
    const dv = new DataView(S.buffer);
    const s8 = (b: number) => (b << 24) >> 24;
    for (let i = 0; i < 16; i++) {
      const o = i * 16;
      w.set([S[4 * i + 2], S[4 * i + 1], S[4 * i], S[4 * i + 3]], o);
      w.set([dv.getInt16(256 + 2 * i, true), 0, 0, 1], o + 4);
      const p = dv.getUint32(512 + 4 * i, true);
      w.set([p & 0x3ff, (p >>> 10) & 0x3ff, (p >>> 20) & 0x3ff, p >>> 30], o + 8);
      w.set([0, 1, 2].map((k) => Math.max(s8(S[768 + 3 * i + k]), -127)).concat(127), o + 12);
    }
    w.set([16, 16, 16, 7], 256);
    // Half floats of small integers and halves: exact.
    const half = (x: number) => {
      if (x === 0) return Object.is(x, -0) ? 0x8000 : 0;
      const sign = x < 0 ? 0x8000 : 0, a = Math.abs(x), e = Math.floor(Math.log2(a));
      return sign | ((e + 15) << 10) | Math.round((a / 2 ** e - 1) * 1024);
    };
    const h = new Uint16Array(want.buffer, 2048, 64);
    for (let i = 0; i < 16; i++) h.set([half(i), half(-0.5 * i), half(0.25), half(1 + i)], 4 * i);
    Object.assign(checks, { fetched: [0, 1024, want], sizes: [1024, 1040, want], stored: [2048, 2176, want], rest: [2176, 4096, want] });
  } else if (scenario === 'ycbcr') {
    // What ycbcr.comp samples of the NV12 image (wg_test.c's scenario 22): BT.709, narrow range, chroma at the
    // midpoint (each 2×2 block's), as floats; within 0.02 of the spec's matrices (the bytes then taken as they came).
    const Y = Array.from({ length: 16 }, (_, i) => 16 + i * 13), C = [[60, 200], [128, 128], [200, 60], [90, 170]];
    const f = new Float32Array(got.buffer, got.byteOffset, 64), w = new Float32Array(want.buffer, 0, 64);
    for (let i = 0; i < 16; i++) {
      const x = i & 3, y = i >> 2, c = C[(y >> 1) * 2 + (x >> 1)];
      const yy = (Y[i] - 16) / 219, pb = (c[0] - 128) / 224, pr = (c[1] - 128) / 224;
      const rgb = [yy + 1.5748 * pr, yy - 0.13397432 / 0.7152 * pb - 0.33480248 / 0.7152 * pr, yy + 1.8556 * pb, 1];
      for (let k = 0; k < 4; k++) w[4 * i + k] = Math.abs(f[4 * i + k] - rgb[k]) < 0.02 ? f[4 * i + k] : rgb[k];
    }
    Object.assign(checks, { converted: [0, 256, want], rest: [256, 4096, want] });
  } else if (scenario === 'queuesTimeline' || scenario === 'queuesBinary') {
    want.fill(0x33, 0, 128);
    Object.assign(checks, { copied: [0, 4096, want] });
  } else if (scenario === 'waitBeforeSignal') {
    want.fill(0x22, 0, 64);
    Object.assign(checks, { copied: [0, 4096, want] });
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
  return { checks: differs, errors, warnings: v.gpu.stats.errors, got: [...got.subarray(0, 16)], bindGroups: v.gpu.stats.bindGroups, emul: v.emul() };
}

/**
 * VK3 L7a: a graphics pipeline made and not drawn (vk/driver/wg_test.c `wgt_fits`), its stages' SPIR-V at `vert` and
 * `frag`: WebGPU's errors once its objects are made (a queue's work done), and the driver's own error if it failed.
 */
export async function runFits(scenario: 'inputAttachments', vert: string, frag: string) {
  const adapter = await navigator.gpu?.requestAdapter();
  if (!adapter) return { skipped: 'no WebGPU adapter' };
  const device = await adapter.requestDevice(deviceRequest(adapter));
  const errors: string[] = [];
  device.addEventListener('uncapturederror', (e) => errors.push((e as GPUUncapturedErrorEvent).error.message));
  const memory = new WebAssembly.Memory({ initial: 65536, maximum: 65536, shared: true });
  const module = await WebAssembly.compileStreaming(fetch('/target/vk/venus.wasm'));
  const v = await VenusRenderer.create(module, memory, { at: VENUS_ARENA, bytes: 1 << 20, watch: 0 }, device);
  const ex = v.raw as unknown as Test;
  const text = (p: number) => { const u8 = new Uint8Array(memory.buffer); let e = p; while (u8[e]) e++; return new TextDecoder().decode(u8.slice(p, e)); };
  const put = async (url: string) => {
    const b = new Uint8Array(await (await fetch(url)).arrayBuffer());
    const p = ex.venus_alloc(b.length) >>> 0;
    new Uint8Array(memory.buffer, p, b.length).set(b);
    return [p, b.length / 4];
  };
  const [vs, vn] = await put(vert), [fs, fn] = await put(frag);
  if (ex.wgt_fits({ inputAttachments: 0 }[scenario], vs, vn, fs, fn)) return { error: text(ex.wgt_error() >>> 0), errors };
  await device.queue.onSubmittedWorkDone();
  for (let k = 0; k < 10; k++) await new Promise((r) => setTimeout(r, 10));
  device.destroy();
  return { errors, warnings: v.gpu.stats.errors };
}

/**
 * VK3 L8a (the track-end review's finding 3): passes without attachments drawn at the pipeline's 4 samples, in the pass
 * and by a secondary command buffer (vk/driver/wg_test.c `wgt_samples`): each draw's sample bits and invocations.
 */
export async function runSamples(vert: string, frag: string) {
  const adapter = await navigator.gpu?.requestAdapter();
  if (!adapter) return { skipped: 'no WebGPU adapter' };
  const device = await adapter.requestDevice(deviceRequest(adapter));
  const errors: string[] = [];
  device.addEventListener('uncapturederror', (e) => errors.push((e as GPUUncapturedErrorEvent).error.message));
  const memory = new WebAssembly.Memory({ initial: 65536, maximum: 65536, shared: true });
  const module = await WebAssembly.compileStreaming(fetch('/target/vk/venus.wasm'));
  const v = await VenusRenderer.create(module, memory, { at: VENUS_ARENA, bytes: 1 << 20, watch: 0 }, device);
  const ex = v.raw as unknown as Test;
  const text = (p: number) => { const u8 = new Uint8Array(memory.buffer); let e = p; while (u8[e]) e++; return new TextDecoder().decode(u8.slice(p, e)); };
  const put = async (url: string) => {
    const b = new Uint8Array(await (await fetch(url)).arrayBuffer());
    const p = ex.venus_alloc(b.length) >>> 0;
    new Uint8Array(memory.buffer, p, b.length).set(b);
    return [p, b.length / 4];
  };
  const [vs, vn] = await put(vert), [fs, fn] = await put(frag);
  if (ex.wgt_samples(vs, vn, fs, fn)) return { error: text(ex.wgt_error() >>> 0), errors };
  for (let k = 0; k < 1000 && !ex.wgt_misc_done(); k++) await new Promise((r) => setTimeout(r, 10));
  if (!ex.wgt_misc_done()) return { error: 'the fence never signalled', errors };
  const at = ex.wgt_misc_map() >>> 0;
  const pass = [...new Uint32Array(memory.buffer, at, 2)], secondary = [...new Uint32Array(memory.buffer, at + 256, 2)];
  device.destroy();
  return { errors, warnings: v.gpu.stats.errors, pass, secondary };
}
