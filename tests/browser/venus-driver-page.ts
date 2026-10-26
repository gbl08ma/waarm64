// The Vulkan driver's test program (vk/driver/wg_test.c) on this page's WebGPU device, in the renderer module
// (tests/venus-driver.test.ts): its scene's pixels, its compute pass's output and a filled buffer, read back once the
// submit's fence signalled.
import { deviceRequest } from '../../web/venus-gpu.ts';
import { VenusRenderer } from '../../web/venus-host.ts';
import { VenusImport } from '../../web/venus-import.ts';

type Test = {
  wgt_run(vs: number, vn: number, fs: number, fn: number, cs: number, cn: number): number;
  wgt_done(): number; wgt_pixels(): number; wgt_storage(): number; wgt_filled(): number; wgt_error(): number;
  venus_alloc(n: number): number;
  wgt_import(res: number): number; wgt_imported(): number;
};

export async function run(spirv: { vert: string; frag: string; comp: string }) {
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
