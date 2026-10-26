// Presentation of Vulkan through Venus (vk/README.md "Presentation"; docs/devices.md "Venus"): a Vulkan program's WSI
// image is a blob of Venus's renderer, which the guest's compositor (sway on GLES) imports as a dma-buf into virgl and
// samples. The virgl renderer (WebGL2) makes it a texture of its own at the import (PIPE_RESOURCE_SET_TYPE:
// web/virgl-renderer.ts `ExternalResource`), and this copies the image's WebGPU texture into it whenever the driver
// has written it since, before the compositor's submit that may sample it. Both renderers are in the GPU worker; the
// two APIs share nothing directly, so the bytes go one of two ways (bench/vulkan/REPORT.md "VK2 L4"):
//   bitmap    a draw of the image into a WebGPU canvas context's texture (bgra8unorm, an OffscreenCanvas of the image's
//             size), its colours the virgl texture's stored channels (virgl keeps B8G8R8A8 as its bytes in an RGBA8
//             texture; a float image is clamped to 8 bits, as the compositor's output is), then `transferToImageBitmap`
//             and texSubImage2D from the bitmap: on the GPU, at the compositor's submit.
//   readback  copyTextureToBuffer, mapAsync, texSubImage2D from the bytes: through the CPU, and asynchronous, so the
//             compositor's submit is held (as for a video picture: `VirglRenderer.externalWait`) until they arrive.
// The bitmap way needs a browser whose WebGPU canvases work beside WebGL2 (SwiftShader's in headless Chromium has none:
// its swap chain's shared image can't be made, and the GPU channel is lost), so it is the way unless the page renders
// in software (`shareMode`).
import { FORMATS } from './virgl-formats.ts';
import { softwareRenderer } from './virgl-screen.ts';
import type { ExternalResource, VirglRenderer } from './virgl-renderer.ts';

export type ShareMode = 'bitmap' | 'readback';

/** What a Venus texture is: the WebGPU texture and the submit that last wrote it (web/venus-gpu.ts `texture`). */
export type SharedTexture = { texture: GPUTexture; written: number };

export type ShareStats = { refreshes: number; bitmaps: number; readbacks: number; readbackBytes: number; skipped: number; ms: number };

/** GPUTextureUsage's and GPUBufferUsage's values (the globals may be missing where this module is only imported). */
const RENDER_ATTACHMENT = 16, COPY_DST = 8, MAP_READ = 1, MAP_MODE_READ = 1;

/**
 * What a shared texture format is to the virgl texture: the swizzle of its sampled colour that gives the texture's
 * stored channels (virgl keeps B8G8R8A8 as its bytes: R is B), and its bytes a texel; undefined for a format not
 * shared (WebGPU's formats a WSI image can have: Mesa's offers every renderable format, and vkcube picks
 * R16G16B16A16_SFLOAT when it's there).
 */
function shared(format: GPUTextureFormat): { swizzle: string; bytes: number } | undefined {
  switch (format) {
    case 'bgra8unorm': case 'bgra8unorm-srgb': return { swizzle: 'bgra', bytes: 4 };
    case 'rgba8unorm': case 'rgba8unorm-srgb': case 'rgb10a2unorm': return { swizzle: 'rgba', bytes: 4 };
    case 'rgba16float': return { swizzle: 'rgba', bytes: 8 };
    default: return undefined;
  }
}

export class VenusShare {
  readonly stats: ShareStats = { refreshes: 0, bitmaps: 0, readbacks: 0, readbackBytes: 0, skipped: 0, ms: 0 };
  /** The submit each external resource's bytes were copied from (by resource id). */
  private readonly copied = new Map<number, number>();
  private readonly canvases = new Map<string, { canvas: OffscreenCanvas; ctx: GPUCanvasContext }>();
  private readonly pipelines = new Map<string, GPURenderPipeline>();
  private readonly views = new WeakMap<GPUTexture, GPUTextureView>();
  /** Readbacks in flight, by resource id (a newer write waits for the one in flight, then goes). */
  private readonly inFlight = new Set<number>();
  private readonly warned = new Set<string>();

  /**
   * `source(id)`: the Venus texture of blob `id`, if it is an image's (web/venus-host.ts `shared`); `renderer`: the
   * virgl renderer whose external resources these are.
   */
  private readonly device: GPUDevice;
  readonly mode: ShareMode;
  private readonly renderer: VirglRenderer;
  private readonly source: (id: number) => SharedTexture | undefined;
  constructor(device: GPUDevice, mode: ShareMode, renderer: VirglRenderer, source: (id: number) => SharedTexture | undefined) {
    [this.device, this.mode, this.renderer, this.source] = [device, mode, renderer, source];
  }

  private warn(m: string) {
    if (this.warned.has(m)) return;
    this.warned.add(m);
    console.warn(`venus-share: ${m}`);
  }

  /** Before a submit of the compositor's context runs (`VirglRenderer.external.refresh`): the bitmap way copies now. */
  refresh(r: ExternalResource) {
    if (this.mode !== 'bitmap') return;
    const src = this.source(r.id);
    if (!src || src.written === (this.copied.get(r.id) ?? -1)) return;
    const t0 = performance.now();
    if (this.bitmap(r, src)) this.copied.set(r.id, src.written);
    this.stats.ms += performance.now() - t0;
  }

  /**
   * When a submit of `ctx` reaches the GPU worker, before it may run (web/gpu-worker.ts): the readback way starts the
   * copies of its context's external resources written since, and holds the submit until they arrive.
   */
  prepare(ctx: number) {
    if (this.mode !== 'readback') return;
    for (const r of this.renderer.externalsOf(ctx)) {
      const src = this.source(r.id);
      if (!src || src.written === (this.copied.get(r.id) ?? -1) || this.inFlight.has(r.id)) continue;
      this.readback(r, src);
    }
  }

  forget(id: number) {
    this.copied.delete(id);
  }

  private bitmap(r: ExternalResource, src: SharedTexture): boolean {
    const kind = shared(src.texture.format);
    if (!kind) {
      this.warn(`a ${src.texture.format} image isn't shared`);
      return false;
    }
    const order = kind.swizzle;
    const w = Math.min(r.width, src.texture.width), h = Math.min(r.height, src.texture.height);
    const key = `${w}x${h}`;
    let c = this.canvases.get(key);
    if (!c) {
      const canvas = new OffscreenCanvas(w, h);
      const ctx = canvas.getContext('webgpu') as GPUCanvasContext | null;
      if (!ctx) {
        this.warn('no WebGPU canvas context');
        return false;
      }
      ctx.configure({ device: this.device, format: 'bgra8unorm', alphaMode: 'premultiplied', usage: RENDER_ATTACHMENT });
      c = { canvas, ctx };
      if (this.canvases.size > 8) this.canvases.clear();
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
      const module = this.device.createShaderModule({ code: `
@group(0) @binding(0) var src: texture_2d<f32>;
@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  return vec4f(f32(i & 1u) * 4.0 - 1.0, f32(i >> 1u) * 4.0 - 1.0, 0.0, 1.0);
}
@fragment fn fs(@builtin(position) p: vec4f) -> @location(0) vec4f {
  let c = textureLoad(src, vec2u(p.xy), 0).${order};
  return ${x ? 'vec4f(c.rgb, 1.0)' : 'c'};
}` });
      pipeline = this.device.createRenderPipeline({ layout: 'auto', vertex: { module, entryPoint: 'vs' }, fragment: { module, entryPoint: 'fs', targets: [{ format: 'bgra8unorm' }] }, primitive: { topology: 'triangle-list' } });
      this.pipelines.set(order + x, pipeline);
    }
    const enc = this.device.createCommandEncoder();
    const pass = enc.beginRenderPass({ colorAttachments: [{ view: c.ctx.getCurrentTexture().createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 0] }] });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, this.device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: view }] }));
    pass.draw(3);
    pass.end();
    this.device.queue.submit([enc.finish()]);
    const bitmap = c.canvas.transferToImageBitmap();
    this.renderer.writeExternal(r.id, bitmap);
    bitmap.close();
    this.stats.refreshes++;
    this.stats.bitmaps++;
    return true;
  }

  private readback(r: ExternalResource, src: SharedTexture) {
    const kind = shared(src.texture.format);
    if (!kind || kind.bytes !== (FORMATS.get(r.format)?.bpp ?? 0)) {
      this.warn(`a ${src.texture.format} image isn't shared as virgl's format ${FORMATS.get(r.format)?.name ?? r.format}`);
      this.copied.set(r.id, src.written);
      return;
    }
    const w = Math.min(r.width, src.texture.width), h = Math.min(r.height, src.texture.height);
    const bpr = Math.ceil(w * kind.bytes / 256) * 256;
    const buffer = this.device.createBuffer({ size: bpr * h, usage: MAP_READ | COPY_DST });
    const enc = this.device.createCommandEncoder();
    enc.copyTextureToBuffer({ texture: src.texture }, { buffer, bytesPerRow: bpr }, [w, h]);
    this.device.queue.submit([enc.finish()]);
    const written = src.written;
    this.inFlight.add(r.id);
    this.renderer.externalWait(r.id, true);
    this.stats.readbacks++;
    this.stats.readbackBytes += bpr * h;
    buffer.mapAsync(MAP_MODE_READ).then(() => {
      const t0 = performance.now();
      if (!r.dead) {
        this.renderer.writeExternal(r.id, { bytes: new Uint8Array(buffer.getMappedRange()), stride: bpr, width: w, height: h });
        this.copied.set(r.id, written);
        this.stats.refreshes++;
      }
      this.stats.ms += performance.now() - t0;
    }, (err) => this.warn(`a readback failed: ${err}`)).finally(() => {
      buffer.destroy();
      this.inFlight.delete(r.id);
      this.renderer.externalWait(r.id, false);
    });
  }
}

/**
 * The way this browser can take: the bitmap way unless WebGL2 or the WebGPU adapter is a CPU rasterizer (SwiftShader,
 * llvmpipe: the page is composited in software, and a WebGPU canvas's swap chain can't be made there). Not a trial:
 * a WebGPU canvas that fails loses the GPU channel, and with it every WebGPU device and WebGL context of the page
 * (tried in a worker of its own, it took the page's down too).
 */
export function shareMode(adapter: GPUAdapter, glRenderer: string): ShareMode {
  const info = adapter.info as GPUAdapterInfo & { isFallbackAdapter?: boolean };
  return info.isFallbackAdapter || /swiftshader|llvmpipe/i.test(`${info.vendor} ${info.architecture} ${info.description}`) || softwareRenderer(glRenderer) ? 'readback' : 'bitmap';
}
