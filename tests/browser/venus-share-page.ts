// web/venus-share.ts on this page's WebGPU and WebGL2 (tests/venus-share.test.ts): a WebGPU texture (a Venus WSI
// image) imported by a virgl context (PIPE_RESOURCE_SET_TYPE) reaches the virgl renderer's texture byte for byte at
// the context's next submit, again only once the image is written again, and an X format's colour survives alpha 0;
// and the check of a GPU way's first copies (`fallback`): a way whose copies come out black (`broken`, as the bitmap way
// was feared to on NVIDIA) is dropped for the next, down to the readback way, before the frame shows. A prime blit's
// buffer (X11's WSI in our guest) reaches it the same, its rows as far apart as the import says (Mesa's 256-byte
// aligned, or not: a row at a time), and again only once the buffer is written again.
import { shareMode, VenusShare, type ShareMode, type ShareOptions, type SharedBuffer, type SharedTexture } from '../../web/venus-share.ts';
import { VirglRenderer } from '../../web/virgl-renderer.ts';

// Rows of 240 bytes: the readback's are 256 apart.
const W = 60, H = 32;

/** A pattern in memory order: alpha 255, 128 and 0 (colour 0 then: premultiplied), or with colour for an X format. */
function pattern(seed: number, x: boolean) {
  const b = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++) for (let i = 0; i < W; i++) {
    const k = (y * W + i) * 4, a = x ? 0 : [255, 128, 0][i % 3];
    const c = (v: number) => (a === 0 && !x ? 0 : a === 128 ? v & 127 : v);
    b.set([c((i * 4 + seed) & 255), c((y * 8 + seed) & 255), c((i ^ y) * 3 & 255), a], k);
  }
  return b;
}

/** A half float's bits, and back (values in [0, 1]). */
function half(v: number) {
  if (v === 0) return 0;
  const e = Math.floor(Math.log2(v));
  return ((e + 15) << 10) | Math.round((v / 2 ** e - 1) * 1024);
}
const unhalf = (h: number) => (h >> 10 ? 2 ** ((h >> 10) - 15) * (1 + (h & 1023) / 1024) : 0);

/** R16G16B16X16_FLOAT texels: colours k/255, alpha 0 (an X format's). */
function floats() {
  const b = new Uint16Array(W * H * 4);
  for (let k = 0; k < W * H; k++) b.set([half(((k * 5) & 255) / 255), half(((k * 3 + 7) & 255) / 255), half((k & 127) / 255), 0], k * 4);
  return b;
}

/** Whether R16G16B16X16_FLOAT texels match colour for colour, within `tol` (the bitmap way goes through 8 bits). */
function sameFloats(got: Uint8Array, want: Uint16Array, tol: number) {
  const g = new Uint16Array(got.buffer, got.byteOffset, got.byteLength / 2);
  for (let k = 0; k < want.length; k++) {
    if (k % 4 === 3) continue;
    if (Math.abs(unhalf(g[k]) - unhalf(want[k])) > tol) return `channel ${k}: ${unhalf(g[k])} for ${unhalf(want[k])}`;
  }
  return 'same';
}

export async function run(modes: ShareMode[]) {
  const adapter = await navigator.gpu?.requestAdapter();
  if (!adapter) return { skipped: 'no WebGPU adapter' };
  const device = await adapter.requestDevice();
  const errors: string[] = [];
  device.addEventListener('uncapturederror', (e) => errors.push((e as GPUUncapturedErrorEvent).error.message));
  const gl0 = new OffscreenCanvas(1, 1).getContext('webgl2')!;
  const dbg = gl0.getExtension('WEBGL_debug_renderer_info');
  const bitmap = shareMode(adapter, String(gl0.getParameter(dbg ? dbg.UNMASKED_RENDERER_WEBGL : gl0.RENDERER))) === 'bitmap';
  const out: Record<string, unknown> = { bitmap, errors };
  for (const mode of modes) {
    if (mode !== 'readback' && !bitmap) { out[mode] = 'skipped: the page renders in software'; continue; }
    const gl = new OffscreenCanvas(16, 16).getContext('webgl2')!;
    const log: string[] = [];
    const r = new VirglRenderer(gl, { ram: () => [], log: (m) => log.push(m) });
    const tex = (format: GPUTextureFormat) => device.createTexture({ size: [W, H], format, usage: 1 | 2 | 4 | 16, viewFormats: [format.replace('-srgb', '') as GPUTextureFormat] });
    const sources = new Map<number, SharedTexture | SharedBuffer>([[7, { texture: tex('bgra8unorm-srgb'), written: 1 }], [8, { texture: tex('bgra8unorm'), written: 1 }], [9, { texture: tex('rgba8unorm'), written: 1 }], [10, { texture: tex('rgba16float'), written: 1 }]]);
    // Prime blits' buffers: B8G8R8A8 rows 256 bytes apart (Mesa's), R8G8B8A8 rows 240 bytes apart (tight).
    const BLIT = 256;
    sources.set(11, { buffer: device.createBuffer({ size: BLIT * H, usage: 4 | 8 }), written: 1 });
    sources.set(12, { buffer: device.createBuffer({ size: W * 4 * H, usage: 4 | 8 }), written: 1 });
    const putBuffer = (id: number, bytes: Uint8Array, stride: number) => {
      const b = new Uint8Array(stride * H);
      for (let y = 0; y < H; y++) b.set(bytes.subarray(y * W * 4, (y + 1) * W * 4), y * stride);
      device.queue.writeBuffer((sources.get(id) as SharedBuffer).buffer, 0, b);
    };
    const share = new VenusShare(device, mode, r, (id) => sources.get(id));
    r.external = { has: (id) => sources.has(id), refresh: (x) => share.refresh(x) };
    let settled: () => void = () => {};
    r.onVideoSettled = () => settled();
    r.createContext(1);
    // A submit as the GPU worker runs one: prepared at its arrival, held while readbacks are on their way.
    const submit = async (words: number[]) => {
      share.prepare(1);
      while (r.videoPending.ctx(1)) await new Promise<void>((res) => { settled = res; });
      r.submit(1, new Uint32Array(words));
    };
    const put = (id: number, bytes: Uint8Array | Uint16Array) => device.queue.writeTexture({ texture: (sources.get(id) as SharedTexture).texture }, bytes, { bytesPerRow: W * bytes.BYTES_PER_ELEMENT * 4 }, [W, H]);
    // SET_TYPE: handle, format, bind, width, height, usage, modifier lo/hi, stride, offset.
    const setType = (id: number, format: number, stride = W * 4) => [49 | (10 << 16), id, format, 2, W, H, 0, 0, 0, stride, 0];
    const p1 = pattern(1, false), p2 = pattern(77, false), px = pattern(5, true);
    put(7, p1);
    put(8, px);
    // R8G8B8A8_UNORM from an rgba8unorm texture: the same bytes.
    put(9, p2);
    // R16G16B16X16_FLOAT from an rgba16float texture (vkcube's choice): exact the readback way, 8 bits the GPU ways.
    const pf = floats();
    put(10, pf);
    putBuffer(11, p2, BLIT);
    putBuffer(12, p1, W * 4);
    await submit([...setType(7, 1), ...setType(8, 2), ...setType(9, 67), ...setType(10, 236), ...setType(11, 1, BLIT), ...setType(12, 67)]);
    await submit([0]);
    const read = (id: number) => r.readResource(id)!;
    const same = (a: Uint8Array, b: Uint8Array, rgbOnly = false) => {
      for (let k = 0; k < a.length; k++) if ((!rgbOnly || k % 4 !== 3) && a[k] !== b[k]) return `byte ${k}: ${a[k]} for ${b[k]} (${[...a.subarray(k & ~3, (k & ~3) + 4)]} for ${[...b.subarray(k & ~3, (k & ~3) + 4)]})`;
      return 'same';
    };
    const res: Record<string, string> = { first: same(read(7), p1), x: same(read(8), px, true), rgba: same(read(9), p2), float: sameFloats(read(10), pf, mode === 'readback' ? 0 : 0.6 / 255), blit: same(read(11), p2), blitRows: same(read(12), p1) };
    // A buffer written but not said to be: not copied again; then said, copied.
    putBuffer(11, p1, BLIT);
    await submit([0]);
    res.blitUnwritten = same(read(11), p2);
    sources.get(11)!.written = 2;
    await submit([0]);
    res.blitWritten = same(read(11), p1);
    // Written on the GPU but not said to be (no submit of Venus's wrote it): not copied again; then said, copied.
    put(7, p2);
    await submit([0]);
    res.unwritten = same(read(7), p1);
    sources.get(7)!.written = 2;
    await submit([0]);
    res.written = same(read(7), p2);
    res.log = log.join(' | ') || 'none';
    res.stats = JSON.stringify(share.stats);
    // A GPU way's check: never wrong here, and the way kept.
    res.check = share.check.dropped.length || share.stats.checksWrong ? `dropped: ${JSON.stringify(share.check)}` : share.mode === mode ? 'kept' : `now ${share.mode}`;
    out[mode] = res;
  }
  return out;
}

/** A virgl renderer with one context importing blob 7, a bgra8unorm image, and the submits as the GPU worker runs them. */
async function rig(device: GPUDevice, mode: ShareMode, options: ShareOptions) {
  const gl = new OffscreenCanvas(16, 16).getContext('webgl2')!;
  const log: string[] = [];
  const r = new VirglRenderer(gl, { ram: () => [], log: (m) => log.push(m) });
  const src: SharedTexture = { texture: device.createTexture({ size: [W, H], format: 'bgra8unorm', usage: 1 | 2 | 4 | 16 }), written: 1 };
  const share = new VenusShare(device, mode, r, (id) => (id === 7 ? src : undefined), options);
  r.external = { has: (id) => id === 7, refresh: (x) => share.refresh(x) };
  let settled: () => void = () => {};
  r.onVideoSettled = () => settled();
  r.createContext(1);
  const submit = async (words: number[]) => {
    share.prepare(1);
    while (r.videoPending.ctx(1)) await new Promise<void>((res) => { settled = res; });
    r.submit(1, new Uint32Array(words));
  };
  const put = (bytes: Uint8Array) => {
    device.queue.writeTexture({ texture: src.texture }, bytes, { bytesPerRow: W * 4 }, [W, H]);
    src.written++;
  };
  await submit([49 | (10 << 16), 7, 1, 2, W, H, 0, 0, 0, W * 4, 0]);
  return { share, submit, put, read: () => r.readResource(7)!, log };
}

/**
 * The check of a GPU way and its fallback: the bitmap and canvas ways broken (black), so the first lit frame is
 * dropped by both and shown by the readback way, before the submit that samples it runs; a dark frame before it decides
 * nothing; a forced way that copies wrong is kept (and said to). The broken ways make no WebGPU canvas, so this runs on
 * SwiftShader too.
 */
export async function fallback() {
  const adapter = await navigator.gpu?.requestAdapter();
  if (!adapter) return { skipped: 'no WebGPU adapter' };
  const device = await adapter.requestDevice();
  const errors: string[] = [];
  device.addEventListener('uncapturederror', (e) => errors.push((e as GPUUncapturedErrorEvent).error.message));
  const same = (a: Uint8Array, b: Uint8Array, rgbOnly = false) => {
    for (let k = 0; k < a.length; k++) if ((!rgbOnly || k % 4 !== 3) && a[k] !== b[k]) return `byte ${k}: ${a[k]} for ${b[k]}`;
    return 'same';
  };
  const out: Record<string, unknown> = { errors };
  const lit = pattern(1, false), lit2 = pattern(77, false), dark = new Uint8Array(W * H * 4);
  for (let k = 3; k < dark.length; k += 4) dark[k] = 255;

  const a = await rig(device, 'bitmap', { broken: new Set(['bitmap', 'canvas']) });
  a.put(dark);
  await a.submit([0]);
  out.dark = { way: a.share.mode, unclear: a.share.stats.checksUnclear, wrong: a.share.stats.checksWrong, shown: same(a.read(), dark, true) };
  a.put(lit);
  await a.submit([0]);
  out.lit = { way: a.share.mode, state: a.share.check.state, dropped: a.share.check.dropped.map((d) => d.way), wrong: a.share.stats.checksWrong, shown: same(a.read(), lit) };
  a.put(lit2);
  await a.submit([0]);
  out.next = { way: a.share.mode, readbacks: a.share.stats.readbacks, shown: same(a.read(), lit2) };
  out.log = a.log.join(' | ') || 'none';

  const f = await rig(device, 'bitmap', { forced: true, broken: new Set(['bitmap']) });
  f.put(lit);
  await f.submit([0]);
  out.forced = { way: f.share.mode, wrong: f.share.stats.checksWrong, dropped: f.share.check.dropped.length };
  return out;
}
