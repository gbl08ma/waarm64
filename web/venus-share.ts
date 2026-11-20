// Presentation of Vulkan through Venus (vk/README.md "Presentation"; docs/devices.md "Venus"): a Vulkan program's WSI
// image is a blob of Venus's renderer, which the guest's compositor (sway on GLES) imports as a dma-buf into virgl and
// samples. The virgl renderer (WebGL2) makes it a texture of its own at the import (PIPE_RESOURCE_SET_TYPE:
// web/virgl-renderer.ts `ExternalResource`), and this copies the image's WebGPU texture into it whenever the driver
// has written it since, before the compositor's submit that may sample it. Both renderers are in the GPU worker; the
// two APIs share nothing directly, so the bytes go one of three ways (bench/vulkan/REPORT.md "VK2 L4", "VK3 L1"):
//   bitmap    a draw of the image into a WebGPU canvas context's texture (bgra8unorm, an OffscreenCanvas of the image's
//             size), its colours the virgl texture's stored channels (virgl keeps B8G8R8A8 as its bytes in an RGBA8
//             texture; a float image is clamped to 8 bits, as the compositor's output is), then `transferToImageBitmap`
//             and texSubImage2D from the bitmap: on the GPU, at the compositor's submit.
//   canvas    the same draw, then texSubImage2D from the canvas itself.
//   readback  copyTextureToBuffer, mapAsync, texSubImage2D from the bytes: through the CPU, and asynchronous, so the
//             compositor's submit is held (as for a video picture: `VirglRenderer.externalWait`) until they arrive.
// The GPU ways need a browser whose WebGPU canvases work beside WebGL2 (SwiftShader's in headless Chromium has none:
// its swap chain's shared image can't be made, and the GPU channel is lost), so they are tried unless the page renders
// in software (`shareWays`), and they are checked when they start: the first copies of a GPU way are held while a few
// rows of the image are read back (`CHECK_ROWS`) and compared with what the virgl texture got; a way that copies
// wrong is dropped for the next (bitmap, canvas, readback), and that frame gets the next way's copy before it shows.
// The readback way is the reference and always works.
// A frame Mesa's prime blit copied into a buffer it exported (X11's WSI in our guest: its same-GPU check knows PCI
// devices only, and our virtio-gpu is on virtio-mmio) is copied from that buffer into a texture of the resource's
// first (`fromBuffer`), which then goes any of the three ways.
import { FORMATS } from './virgl-formats.ts';
import { softwareRenderer } from './virgl-screen.ts';
import type { ExternalResource, VirglRenderer } from './virgl-renderer.ts';

export type ShareMode = 'bitmap' | 'canvas' | 'readback';
/** The ways in the order they are tried. */
export const SHARE_WAYS: readonly ShareMode[] = ['bitmap', 'canvas', 'readback'];

/** What a Venus texture is: the WebGPU texture and the submit that last wrote it (web/venus-gpu.ts `texture`); `bytes`:
 * its texels are the virgl texture's stored bytes already (a prime blit's, `fromBuffer`), not an image's colours. */
export type SharedTexture = { texture: GPUTexture; written: number; bytes?: boolean };
/** A buffer Venus's driver wrote a frame into (Mesa's prime blit), and the submit that last wrote it (web/venus-gpu.ts `buffer`). */
export type SharedBuffer = { buffer: GPUBuffer; written: number };

export type ShareStats = {
  refreshes: number;
  bitmaps: number;
  canvases: number;
  readbacks: number;
  readbackBytes: number;
  skipped: number;
  ms: number;
  checks: number;
  checksWrong: number;
  checksUnclear: number;
  unshared: number;
  fromBuffers: number;
};

/** Where the check stands (web/gpu-worker.ts's render stats; bench/vulkan/present.ts records it). */
export type ShareCheck = {
  way: ShareMode;
  state: 'checking' | 'right' | 'reference';
  dropped: { way: ShareMode; why: string }[];
};

/** GPUTextureUsage's and GPUBufferUsage's values (the globals may be missing where this module is only imported). */
const RENDER_ATTACHMENT = 16,
  COPY_DST = 8,
  MAP_READ = 1,
  MAP_MODE_READ = 1,
  TEX_COPY_SRC = 1,
  TEX_COPY_DST = 2,
  TEXTURE_BINDING = 4;
/** Rows of the image a check reads back, spread over its height, and the conclusive checks a GPU way must pass. */
const CHECK_ROWS = 8,
  CHECKS = 3;
/** Within this of each other (of 1), a channel copied is right: a GPU way goes through 8 bits (and a 10-bit or float image). */
const TOLERANCE = 1.5 / 255;
/** A check whose sampled texels are all darker than this says nothing (a black frame looks the same either way). */
const DARK = 8 / 255;

/** How texels decode (`decode`): 8-bit channels, 10-10-10-2 packed, half floats, or 5-6-5 in 16 bits (R high). */
type Kind = 8 | 10 | 16 | 565;

/** The texture formats of WSI images whose samples are the image's colours: a packed format's texture holds them as
 * values (the driver's `WG_FMT_PACKED`: R5G6B5 an `rgba8unorm` texture, A2R10G10B10 an `rgb10a2unorm` one with R in
 * red). The surface formats the desktop guest's WSI offers under sway: these and those two (VK4 T48). */
const SAMPLED = new Set<string>([
  'bgra8unorm',
  'bgra8unorm-srgb',
  'rgba8unorm',
  'rgba8unorm-srgb',
  'rgb10a2unorm',
  'rgba16float',
]);

/**
 * What a shared image is to the virgl texture it is copied into: `swizzle`, of its sampled colour, gives the virgl
 * texture's stored channels (virgl keeps B8G8R8A8 and B10G10R10A2 as their bytes: R is B; from the virgl format's
 * `sample`); `kind` and `bytes`, how those are stored; `target`, a WebGPU format of those bytes (`r16uint` for 5-6-5,
 * packed in the shader); `raw`, whether the image's texture already holds them, so that a copy of it is the virgl
 * texture's bytes. Undefined: not shared.
 */
export function stored(
  texture: GPUTextureFormat,
  virgl: number,
): { swizzle: string; kind: Kind; bytes: number; target: GPUTextureFormat; raw: boolean } | undefined {
  const f = FORMATS.get(virgl);
  if (!SAMPLED.has(texture) || !f || f.block !== 1) return undefined;
  const kind = glKind(f.type, f.bpp);
  if (!kind) return undefined;
  let swizzle = '';
  for (let i = 0; i < 4; i++) {
    const j = f.sample.indexOf(i);
    swizzle += 'rgba'[j < 0 ? 3 : j];
  }
  const target: GPUTextureFormat =
    kind === 8 ? 'rgba8unorm' : kind === 10 ? 'rgb10a2unorm' : kind === 16 ? 'rgba16float' : 'r16uint';
  const linear = texture.replace('-srgb', '');
  const raw =
    (linear === target && swizzle === 'rgba') || (linear === 'bgra8unorm' && kind === 8 && swizzle === 'bgra');
  return { swizzle, kind, bytes: kind === 16 ? 8 : kind === 565 ? 2 : 4, target, raw };
}

/**
 * The texture format whose texels are a virgl format's bytes as stored (virgl keeps B8G8R8A8 as its bytes: its texture's
 * channels are the bytes in memory order, as an `rgba8unorm` texture of them samples), for a prime blit's buffer; and
 * its bytes a texel. Undefined: not shared from a buffer.
 */
export function bufferFormat(virgl: number): { format: GPUTextureFormat; bytes: number } | undefined {
  const f = FORMATS.get(virgl);
  if (!f || f.block !== 1) return undefined;
  const k = glKind(f.type, f.bpp);
  return k === 8
    ? { format: 'rgba8unorm', bytes: 4 }
    : k === 10
      ? { format: 'rgb10a2unorm', bytes: 4 }
      : k === 16
        ? { format: 'rgba16float', bytes: 8 }
        : undefined;
}

/** A half float's value. */
function unhalf(h: number) {
  const e = (h >> 10) & 31,
    m = h & 1023,
    s = h & 0x8000 ? -1 : 1;
  return s * (e === 0 ? (m / 1024) * 2 ** -14 : e === 31 ? (m ? NaN : Infinity) : 2 ** (e - 15) * (1 + m / 1024));
}

/**
 * Texels' channels in memory order (the stored channels both renderers agree on), each in [0, 1] and clamped: 4 a
 * texel. `kind`: 8 for 8-bit channels, 10 for 10-10-10-2 packed, 16 for half floats, 565 for 5-6-5 (alpha 1).
 */
function decode(bytes: Uint8Array, texels: number, kind: Kind): Float32Array {
  const out = new Float32Array(texels * 4);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i < texels; i++) {
    for (let c = 0; c < 4; c++) {
      let v: number;
      if (kind === 8) v = bytes[i * 4 + c] / 255;
      else if (kind === 565) {
        const w = dv.getUint16(i * 2, true);
        v = c === 0 ? (w >>> 11) / 31 : c === 1 ? ((w >>> 5) & 63) / 63 : c === 2 ? (w & 31) / 31 : 1;
      } else if (kind === 10) {
        const w = dv.getUint32(i * 4, true);
        v = c < 3 ? ((w >>> (10 * c)) & 1023) / 1023 : (w >>> 30) / 3;
      } else v = unhalf(dv.getUint16(i * 8 + c * 2, true));
      out[i * 4 + c] = Math.min(1, Math.max(0, Number.isNaN(v) ? 0 : v));
    }
  }
  return out;
}

/** How a GL type's texels decode (`decode`'s kind), or undefined. */
const glKind = (type: number, bpp: number): Kind | undefined =>
  type === 0x1401 && bpp === 4
    ? 8
    : type === 0x8368 && bpp === 4
      ? 10
      : type === 0x140b && bpp === 8
        ? 16
        : type === 0x8363 && bpp === 2
          ? 565
          : undefined;

/**
 * The verdict of a check: the image's texels (`want`) against the virgl texture's (`got`), both decoded; `x`: the
 * virgl format ignores alpha. Colour is compared where the image is opaque (a premultiplied canvas may keep a
 * translucent texel's colour otherwise), alpha everywhere it counts.
 */
export function compareTexels(
  want: Float32Array,
  got: Float32Array,
  x: boolean,
): { verdict: 'right' | 'wrong' | 'unclear'; why: string } {
  let lit = false,
    wrong = 0,
    first = '';
  const n = Math.min(want.length, got.length) / 4;
  for (let i = 0; i < n; i++) {
    const a = want.subarray(i * 4, i * 4 + 4),
      b = got.subarray(i * 4, i * 4 + 4);
    const opaque = x || a[3] >= 254 / 255;
    if (opaque && Math.max(a[0], a[1], a[2]) > DARK) lit = true;
    let bad = !x && Math.abs(a[3] - b[3]) > TOLERANCE;
    if (opaque) for (let c = 0; c < 3; c++) if (Math.abs(a[c] - b[c]) > TOLERANCE) bad = true;
    if (bad && !wrong++)
      first = `texel ${i}: ${[...b].map((v) => Math.round(v * 255))} for ${[...a].map((v) => Math.round(v * 255))}`;
  }
  // A dark image says nothing either way: a way that gives black copies it as well as one that works.
  if (!lit) return { verdict: 'unclear', why: 'a dark image' };
  return wrong
    ? { verdict: 'wrong', why: `${wrong} of ${n} texels differ (${first})` }
    : { verdict: 'right', why: `${n} texels` };
}

export type ShareOptions = {
  /** Only this way (`?gpu=vkbitmap|vkcanvas|vkreadback`): checked still, but never dropped. */
  forced?: boolean;
  /** Tests: ways whose copies come out black (`?gpu=vkbreak=<way>`), as the bitmap way's were feared to on NVIDIA; a
   * broken GPU way makes no WebGPU canvas. */
  broken?: ReadonlySet<ShareMode>;
  /** Undefined when Venus's queue holds no submit; else when the held ones (waiting for their pipelines: web/venus-gpu.ts
   * `idle`) have gone to the queue. A frame isn't copied before the submits that draw it. */
  idle?: () => Promise<void> | undefined;
};

export class VenusShare {
  readonly stats: ShareStats = {
    refreshes: 0,
    bitmaps: 0,
    canvases: 0,
    readbacks: 0,
    readbackBytes: 0,
    skipped: 0,
    ms: 0,
    checks: 0,
    checksWrong: 0,
    checksUnclear: 0,
    unshared: 0,
    fromBuffers: 0,
  };
  /** The submit each external resource's bytes were copied from (by resource id). */
  private readonly copied = new Map<number, number>();
  private readonly canvases = new Map<string, { canvas: OffscreenCanvas; ctx: GPUCanvasContext }>();
  private readonly pipelines = new Map<string, GPURenderPipeline>();
  private readonly views = new WeakMap<GPUTexture, GPUTextureView>();
  /** Readbacks and checks in flight, by resource id (a newer write waits for the one in flight, then goes). */
  private readonly inFlight = new Set<number>();
  /** Holds on each resource's submits (a readback and a check may overlap): `VirglRenderer.externalWait` while any. */
  private readonly holds = new Map<number, number>();
  private readonly warned = new Set<string>();
  /** External resources that aren't an image's (`sourceOf`). */
  private readonly unshared = new Set<number>();
  /** Readback buffers by resource id (`staging`). */
  private readonly buffers = new Map<number, GPUBuffer>();
  /** The texture an image whose texture doesn't hold the virgl texture's bytes is drawn into first, by resource id
   * (`storedOf`: the readback way's and a check's). */
  private readonly converted = new Map<number, GPUTexture>();
  /** The texture a prime blit's buffer is copied into, by resource id, and the buffer's write it holds (`fromBuffer`). */
  private readonly blits = new Map<number, SharedTexture>();
  /** The way in use and where its check stands. */
  readonly check: ShareCheck;
  private passed = 0;

  /**
   * `mode`: the way to start with (`shareWays`); `source(id)`: the Venus texture of blob `id`, if it is an image's
   * (web/venus-host.ts `shared`), and whether `id` is Venus's at all; `renderer`: the virgl renderer whose external
   * resources these are.
   */
  private readonly device: GPUDevice;
  private readonly renderer: VirglRenderer;
  private readonly source: (id: number) => SharedTexture | SharedBuffer | undefined;
  private readonly options: ShareOptions;
  constructor(
    device: GPUDevice,
    mode: ShareMode,
    renderer: VirglRenderer,
    source: (id: number) => SharedTexture | SharedBuffer | undefined,
    options: ShareOptions = {},
  ) {
    [this.device, this.renderer, this.source, this.options] = [device, renderer, source, options];
    this.check = { way: mode, state: mode === 'readback' ? 'reference' : 'checking', dropped: [] };
  }

  /** The way in use. */
  get mode(): ShareMode {
    return this.check.way;
  }

  private warn(m: string) {
    if (this.warned.has(m)) return;
    this.warned.add(m);
    console.warn(`venus-share: ${m}`);
  }

  private hold(id: number) {
    const n = this.holds.get(id) ?? 0;
    this.holds.set(id, n + 1);
    if (!n) this.renderer.externalWait(id, true);
  }

  private unhold(id: number) {
    const n = (this.holds.get(id) ?? 1) - 1;
    if (n > 0) return void this.holds.set(id, n);
    this.holds.delete(id);
    this.renderer.externalWait(id, false);
  }

  /** A hold on `r` ends: none if `r` is gone (`forget` dropped its holds; its id may be another resource's now). */
  private release(r: ExternalResource) {
    if (!r.dead) this.unhold(r.id);
  }

  /** The image behind an external resource, or undefined (warned once: a blob that isn't an image's stays black). */
  private sourceOf(r: ExternalResource): SharedTexture | undefined {
    const got = this.source(r.id);
    const src = got && 'buffer' in got ? this.fromBuffer(r, got) : got;
    if (!src && !this.unshared.has(r.id)) {
      // A swapchain's images may go before the compositor lets go of them (vkcube's first, at 500×500).
      this.unshared.add(r.id);
      this.stats.unshared++;
      this.warn(
        `resource ${r.id} (${r.width}x${r.height}) isn't (or no longer) a Vulkan image's or buffer's memory: not shown`,
      );
    }
    return src;
  }

  /**
   * A prime blit's frame (a buffer, rows `r.stride` bytes apart as the guest's import says, else 256-aligned as Mesa's
   * are) as a texture of the resource's (`bufferFormat`), copied again when the buffer has been written since. In the
   * queue's order, after the submits whose copies wrote it.
   */
  private fromBuffer(r: ExternalResource, src: SharedBuffer): SharedTexture | undefined {
    const f = bufferFormat(r.format);
    if (!f) {
      this.warn(`a prime blit's buffer of virgl's format ${FORMATS.get(r.format)?.name ?? r.format} isn't shared`);
      return undefined;
    }
    let t = this.blits.get(r.id);
    if (t && t.written === src.written) return t;
    const w = r.width,
      h = r.height,
      row = w * f.bytes;
    const stride = r.stride || Math.ceil(row / 256) * 256;
    if (stride < row || stride * (h - 1) + row > src.buffer.size) {
      this.warn(
        `resource ${r.id}: a ${r.width}x${r.height} frame with rows ${stride} bytes apart is past its ${src.buffer.size}-byte buffer`,
      );
      return undefined;
    }
    if (!t || t.texture.width !== w || t.texture.height !== h || t.texture.format !== f.format) {
      t?.texture.destroy();
      t = {
        texture: this.device.createTexture({
          size: [w, h],
          format: f.format,
          usage: TEX_COPY_SRC | TEX_COPY_DST | TEXTURE_BINDING,
        }),
        written: -1,
        bytes: true,
      };
      this.blits.set(r.id, t);
    }
    const enc = this.device.createCommandEncoder();
    // WebGPU's rows are 256 bytes apart at least as far; a stride that isn't (Mesa's always is) goes a row at a time.
    if (stride % 256 === 0)
      enc.copyBufferToTexture({ buffer: src.buffer, bytesPerRow: stride, rowsPerImage: h }, { texture: t.texture }, [
        w,
        h,
      ]);
    else
      for (let y = 0; y < h; y++)
        enc.copyBufferToTexture({ buffer: src.buffer, offset: y * stride }, { texture: t.texture, origin: [0, y] }, [
          w,
          1,
        ]);
    this.device.queue.submit([enc.finish()]);
    t.written = src.written;
    this.stats.fromBuffers++;
    return t;
  }

  /** Before a submit of the compositor's context runs (`VirglRenderer.external.refresh`): a GPU way copies now. */
  refresh(r: ExternalResource) {
    if (this.mode === 'readback') return;
    const src = this.sourceOf(r);
    if (!src || src.written === (this.copied.get(r.id) ?? -1)) return;
    const t0 = performance.now();
    if (this.copyGpu(r, src)) this.copied.set(r.id, src.written);
    this.stats.ms += performance.now() - t0;
  }

  /**
   * When a submit of `ctx` reaches the GPU worker, before it may run (web/gpu-worker.ts): the readback way starts the
   * copies of its context's external resources written since, and holds the submit until they arrive; a GPU way being
   * checked copies now and holds the submit for the check.
   */
  prepare(ctx: number) {
    const externals = this.renderer.externalsOf(ctx);
    if (!externals.length) return; // most submits (a compositor's are the ones with any)
    // Submits held for their pipelines may draw what this one samples: it waits for them first.
    const idle = this.options.idle?.();
    if (idle) {
      const held = externals.filter((r) => this.sourceOf(r));
      if (held.length) {
        for (const r of held) this.hold(r.id);
        void idle.then(() => {
          this.prepare(ctx);
          for (const r of held) this.release(r);
        });
        return;
      }
    }
    if (this.mode !== 'readback' && this.check.state !== 'checking') return;
    for (const r of externals) {
      if (this.inFlight.has(r.id)) continue;
      const src = this.sourceOf(r);
      if (!src || src.written === (this.copied.get(r.id) ?? -1)) continue;
      if (this.mode === 'readback') this.readback(r, src);
      else this.copyChecked(r, src);
    }
  }

  /** Resource `id` is gone (unref'd: `dead`); the guest may reuse its id for another, which starts afresh. */
  forget(id: number) {
    this.copied.delete(id);
    this.holds.delete(id);
    this.unshared.delete(id);
    this.blits.get(id)?.texture.destroy();
    this.blits.delete(id);
    this.converted.get(id)?.destroy();
    this.converted.delete(id);
    if (!this.inFlight.has(id)) this.dropStaging(id);
  }

  /** A GPU way's copy, then a check of it (the submit held meanwhile); on a wrong copy the next way's goes. */
  private copyChecked(r: ExternalResource, src: SharedTexture) {
    const way = this.mode;
    if (!this.copyGpu(r, src)) return;
    this.copied.set(r.id, src.written);
    const fmt = FORMATS.get(r.format),
      st = this.storedOf(r, src);
    if (!fmt || !st) return;
    const { kind, bytes } = st;
    const w = Math.min(r.width, src.texture.width),
      h = Math.min(r.height, src.texture.height);
    const ys = [...new Set(Array.from({ length: CHECK_ROWS }, (_, k) => Math.floor(((k + 0.5) * h) / CHECK_ROWS)))];
    const bpr = Math.ceil((w * bytes) / 256) * 256;
    const buffer = this.device.createBuffer({ size: bpr * ys.length, usage: MAP_READ | COPY_DST });
    const enc = this.device.createCommandEncoder();
    ys.forEach((y, i) =>
      enc.copyTextureToBuffer({ texture: st.texture, origin: [0, y] }, { buffer, offset: i * bpr, bytesPerRow: bpr }, [
        w,
        1,
      ]),
    );
    this.device.queue.submit([enc.finish()]);
    this.inFlight.add(r.id);
    this.hold(r.id);
    // Set when this frame goes to the next way, whose copy is in flight then.
    let handed = false;
    buffer
      .mapAsync(MAP_MODE_READ)
      .then(
        () => {
          if (r.dead || this.mode !== way) return;
          const mapped = new Uint8Array(buffer.getMappedRange());
          const got = this.renderer.readExternalRows(r.id, ys, w);
          if (!got) return;
          const want = new Float32Array(ys.length * w * 4),
            have = new Float32Array(ys.length * w * 4);
          ys.forEach((_, i) => {
            want.set(decode(mapped.subarray(i * bpr, i * bpr + w * bytes), w, kind), i * w * 4);
            have.set(decode(got[i], w, kind), i * w * 4);
          });
          const v = compareTexels(want, have, !!fmt.x);
          this.stats.checks++;
          if (v.verdict === 'unclear') {
            this.stats.checksUnclear++;
            return;
          }
          if (v.verdict === 'right') {
            if (++this.passed >= CHECKS) {
              this.check.state = 'right';
              console.log(`venus-share: the ${way} way checked right (${CHECKS} frames)`);
            }
            return;
          }
          this.stats.checksWrong++;
          if (this.options.forced) {
            this.warn(`the ${way} way (forced) copies wrong: ${v.why}`);
            return;
          }
          const next = SHARE_WAYS[SHARE_WAYS.indexOf(way) + 1];
          this.check.dropped.push({ way, why: v.why });
          console.warn(`venus-share: the ${way} way copies wrong (${v.why}): the ${next} way from now on`);
          this.check.way = next;
          this.check.state = next === 'readback' ? 'reference' : 'checking';
          this.passed = 0;
          // This frame by the next way, before the submit goes on (the hold below is let go after the next way's).
          this.copied.delete(r.id);
          this.inFlight.delete(r.id);
          handed = true;
          const now = this.sourceOf(r);
          if (now) {
            if (next === 'readback') this.readback(r, now);
            else this.copyChecked(r, now);
          }
        },
        (err) => this.warn(`a check failed: ${err}`),
      )
      .finally(() => {
        buffer.destroy();
        if (!handed) this.inFlight.delete(r.id);
        this.release(r);
      });
  }

  /** The bitmap way's or the canvas way's copy. */
  private copyGpu(r: ExternalResource, src: SharedTexture): boolean {
    const way = this.mode;
    const kind = stored(src.texture.format, r.format);
    if (!kind) {
      this.warn(
        `a ${src.texture.format} image isn't shared as virgl's format ${FORMATS.get(r.format)?.name ?? r.format}`,
      );
      return false;
    }
    if (this.options.broken?.has(way)) {
      // Black, as a way that fails silently would give (no WebGPU canvas: SwiftShader's would lose the GPU channel).
      const w = Math.min(r.width, src.texture.width),
        h = Math.min(r.height, src.texture.height),
        bpp = FORMATS.get(r.format)?.bpp ?? 4;
      this.renderer.writeExternal(r.id, { bytes: new Uint8Array(w * h * bpp), stride: w * bpp, width: w, height: h });
      this.stats.refreshes++;
      return true;
    }
    const order = src.bytes ? 'rgba' : kind.swizzle;
    const w = Math.min(r.width, src.texture.width),
      h = Math.min(r.height, src.texture.height);
    const key = `${w}x${h}`;
    let c = this.canvases.get(key);
    if (!c) {
      const canvas = new OffscreenCanvas(w, h);
      const ctx = canvas.getContext('webgpu') as GPUCanvasContext | null;
      if (!ctx) {
        this.warn('no WebGPU canvas context');
        return false;
      }
      ctx.configure({
        device: this.device,
        format: 'bgra8unorm',
        alphaMode: 'premultiplied',
        usage: RENDER_ATTACHMENT,
      });
      c = { canvas, ctx };
      // A window resized by dragging has a new size every frame: the oldest canvas goes, its swap chain with it.
      if (this.canvases.size >= 8) {
        const [oldest, old] = this.canvases.entries().next().value!;
        old.ctx.unconfigure();
        this.canvases.delete(oldest);
      }
      this.canvases.set(key, c);
    }
    const linear = src.texture.format.replace('-srgb', '') as GPUTextureFormat;
    let view = this.views.get(src.texture);
    if (!view) {
      view = src.texture.createView({ format: linear });
      this.views.set(src.texture, view);
    }
    // An X format's alpha is the guest's to ignore (virgl samples it as 1), and a premultiplied canvas may drop the
    // colour of a texel whose alpha is 0: written as 1.
    const x = !!FORMATS.get(r.format)?.x;
    let pipeline = this.pipelines.get(order + x);
    if (!pipeline) {
      const module = this.device.createShaderModule({
        code: `
@group(0) @binding(0) var src: texture_2d<f32>;
@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  return vec4f(f32(i & 1u) * 4.0 - 1.0, f32(i >> 1u) * 4.0 - 1.0, 0.0, 1.0);
}
@fragment fn fs(@builtin(position) p: vec4f) -> @location(0) vec4f {
  let c = textureLoad(src, vec2u(p.xy), 0).${order};
  return ${x ? 'vec4f(c.rgb, 1.0)' : 'c'};
}`,
      });
      pipeline = this.device.createRenderPipeline({
        layout: 'auto',
        vertex: { module, entryPoint: 'vs' },
        fragment: { module, entryPoint: 'fs', targets: [{ format: 'bgra8unorm' }] },
        primitive: { topology: 'triangle-list' },
      });
      this.pipelines.set(order + x, pipeline);
    }
    const enc = this.device.createCommandEncoder();
    const pass = enc.beginRenderPass({
      colorAttachments: [
        { view: c.ctx.getCurrentTexture().createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 0] },
      ],
    });
    pass.setPipeline(pipeline);
    pass.setBindGroup(
      0,
      this.device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [{ binding: 0, resource: view }],
      }),
    );
    pass.draw(3);
    pass.end();
    this.device.queue.submit([enc.finish()]);
    if (way === 'canvas') {
      this.renderer.writeExternal(r.id, c.canvas);
      this.stats.canvases++;
    } else {
      const bitmap = c.canvas.transferToImageBitmap();
      this.renderer.writeExternal(r.id, bitmap);
      bitmap.close();
      this.stats.bitmaps++;
    }
    this.stats.refreshes++;
    return true;
  }

  private readback(r: ExternalResource, src: SharedTexture) {
    const kind = this.storedOf(r, src);
    if (!kind) {
      this.warn(
        `a ${src.texture.format} image isn't shared as virgl's format ${FORMATS.get(r.format)?.name ?? r.format}`,
      );
      this.copied.set(r.id, src.written);
      return;
    }
    const w = Math.min(r.width, src.texture.width),
      h = Math.min(r.height, src.texture.height);
    const bpr = Math.ceil((w * kind.bytes) / 256) * 256;
    const buffer = this.staging(r.id, bpr * h);
    const enc = this.device.createCommandEncoder();
    enc.copyTextureToBuffer({ texture: kind.texture }, { buffer, bytesPerRow: bpr }, [w, h]);
    this.device.queue.submit([enc.finish()]);
    const written = src.written;
    this.inFlight.add(r.id);
    this.hold(r.id);
    this.stats.readbacks++;
    this.stats.readbackBytes += bpr * h;
    buffer
      .mapAsync(MAP_MODE_READ)
      .then(
        () => {
          const t0 = performance.now();
          if (!r.dead) {
            this.renderer.writeExternal(r.id, {
              bytes: new Uint8Array(buffer.getMappedRange()),
              stride: bpr,
              width: w,
              height: h,
            });
            this.copied.set(r.id, written);
            this.stats.refreshes++;
          }
          this.stats.ms += performance.now() - t0;
        },
        (err) => this.warn(`a readback failed: ${err}`),
      )
      .finally(() => {
        if (buffer.mapState === 'mapped') buffer.unmap();
        if (r.dead) this.dropStaging(r.id);
        this.inFlight.delete(r.id);
        this.release(r);
      });
  }

  /**
   * The image's texels as the virgl texture stores them (`stored`): its own texture where that holds them, else a
   * texture of the resource's that a draw (in the queue's order, before what reads it) fills with the image's colours
   * swizzled to the stored channels, 5-6-5 packed in 16 bits, an X format's alpha 1.
   */
  private storedOf(r: ExternalResource, src: SharedTexture) {
    const st = stored(src.texture.format, r.format);
    if (!st) return undefined;
    if (st.raw || src.bytes) return { ...st, swizzle: 'rgba', raw: true, texture: src.texture };
    const w = Math.min(r.width, src.texture.width),
      h = Math.min(r.height, src.texture.height);
    let t = this.converted.get(r.id);
    if (!t || t.width !== w || t.height !== h || t.format !== st.target) {
      t?.destroy();
      t = this.device.createTexture({ size: [w, h], format: st.target, usage: RENDER_ATTACHMENT | TEX_COPY_SRC });
      this.converted.set(r.id, t);
    }
    const x = !!FORMATS.get(r.format)?.x;
    const key = `stored:${st.target}:${st.swizzle}${x}`;
    let pipeline = this.pipelines.get(key);
    if (!pipeline) {
      const c = `textureLoad(src, vec2u(p.xy), 0).${st.swizzle}`;
      const ret =
        st.kind === 565
          ? 'vec4u((u32(round(c.r * 31.0)) << 11u) | (u32(round(c.g * 63.0)) << 5u) | u32(round(c.b * 31.0)), 0u, 0u, 0u)'
          : x
            ? 'vec4f(c.rgb, 1.0)'
            : 'c';
      const module = this.device.createShaderModule({
        code: `
@group(0) @binding(0) var src: texture_2d<f32>;
@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  return vec4f(f32(i & 1u) * 4.0 - 1.0, f32(i >> 1u) * 4.0 - 1.0, 0.0, 1.0);
}
@fragment fn fs(@builtin(position) p: vec4f) -> @location(0) ${st.kind === 565 ? 'vec4u' : 'vec4f'} {
  let c = clamp(${c}, vec4f(0.0), vec4f(1.0));
  return ${ret};
}`,
      });
      pipeline = this.device.createRenderPipeline({
        layout: 'auto',
        vertex: { module, entryPoint: 'vs' },
        fragment: { module, entryPoint: 'fs', targets: [{ format: st.target }] },
        primitive: { topology: 'triangle-list' },
      });
      this.pipelines.set(key, pipeline);
    }
    let view = this.views.get(src.texture);
    if (!view) {
      view = src.texture.createView({ format: src.texture.format.replace('-srgb', '') as GPUTextureFormat });
      this.views.set(src.texture, view);
    }
    const enc = this.device.createCommandEncoder();
    const pass = enc.beginRenderPass({
      colorAttachments: [{ view: t.createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 0] }],
    });
    pass.setPipeline(pipeline);
    pass.setBindGroup(
      0,
      this.device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [{ binding: 0, resource: view }],
      }),
    );
    pass.draw(3);
    pass.end();
    this.device.queue.submit([enc.finish()]);
    return { ...st, texture: t };
  }

  /**
   * The readback buffer of a resource, kept from frame to frame (one in flight a resource): a buffer made and destroyed
   * a frame grew Dawn's GPU process by about its size a frame on SwiftShader (6.8 MB at vkcube's 1276×670 rgba16float,
   * 60 a second: out of memory in seconds), the destroyed ones not freed while the queue stayed busy.
   */
  private staging(id: number, size: number): GPUBuffer {
    const b = this.buffers.get(id);
    if (b && b.size === size) return b;
    b?.destroy();
    const n = this.device.createBuffer({ size, usage: MAP_READ | COPY_DST });
    this.buffers.set(id, n);
    return n;
  }

  private dropStaging(id: number) {
    this.buffers.get(id)?.destroy();
    this.buffers.delete(id);
  }
}

/**
 * The way this browser starts with: the bitmap way unless WebGL2 or the WebGPU adapter is a CPU rasterizer
 * (SwiftShader, llvmpipe: the page is composited in software, and a WebGPU canvas's swap chain can't be made there),
 * then the readback way. Not a trial: a WebGPU canvas that fails loses the GPU channel, and with it every WebGPU device
 * and WebGL context of the page (tried in a worker of its own, it took the page's down too). The check of the first
 * copies (`VenusShare`) drops a GPU way that copies wrong.
 */
export function shareMode(adapter: GPUAdapter, glRenderer: string): ShareMode {
  const info = adapter.info as GPUAdapterInfo & { isFallbackAdapter?: boolean };
  return info.isFallbackAdapter ||
    /swiftshader|llvmpipe/i.test(`${info.vendor} ${info.architecture} ${info.description}`) ||
    softwareRenderer(glRenderer)
    ? 'readback'
    : 'bitmap';
}
