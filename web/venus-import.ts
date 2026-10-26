// Virgl's resources into Vulkan through Venus (vk/README.md "Imports"; docs/devices.md "Venus"): the reverse of
// web/venus-share.ts. A guest program imports a virgl resource into Vulkan as a dma-buf (mpv on Vulkan maps each VA-API
// surface's planes, an R8 luma and an RG8 chroma, into libplacebo's textures): the kernel attaches the resource to the
// Venus context, the renderer makes it a dma-buf whose "fd" is its id (web/venus-host.ts, vk/glue.c
// `venus_resource_import`), and the driver binds images to memory imported from it (`gpu_texture_import`). Each such
// image's WebGPU texture gets the resource's bytes here, with `queue.writeTexture`, so in the queue's order before the
// submits that sample it:
//   at the bind   the bytes of the last picture written into the resource (kept for resources imported before), or
//                 the virgl texture read back (a resource's first import, or one that isn't a video plane);
//   at a picture  each video picture written into a plane (web/virgl-renderer.ts `onPlane`, the host's own bytes,
//                 decoded by WebCodecs) also goes to the textures imported from it.
// The guest waits for a picture's decode before it maps the surface (mpv's vaSyncSurface: a virgl fence, which the call
// queue answers only once the picture is written), so a bind sees the picture it imports.
import { FORMATS } from './virgl-formats.ts';
import type { VirglRenderer } from './virgl-renderer.ts';

export type ImportStats = { binds: number; pictures: number; readbacks: number; bytes: number; ms: number };

/** A plane's bytes as written: rows of `w` texels of `bpp` bytes, `h` of them. */
type Plane = { data: Uint8Array; w: number; h: number; bpp: number };

/** Bytes a texel of the formats an imported texture may have (WebGPU's 8-bit ones: VA-API's planes are R8 and RG8). */
const BYTES: Partial<Record<GPUTextureFormat, number>> = { r8unorm: 1, rg8unorm: 2, rgba8unorm: 4, 'rgba8unorm-srgb': 4, bgra8unorm: 4, 'bgra8unorm-srgb': 4 };

export class VenusImport {
  readonly stats: ImportStats = { binds: 0, pictures: 0, readbacks: 0, bytes: 0, ms: 0 };
  /** The textures imported from each resource, and each texture's resource. */
  private readonly textures = new Map<number, Set<GPUTexture>>();
  private readonly resourceOf = new Map<GPUTexture, number>();
  /** The last plane written into each resource ever imported (a surface is imported again at every frame it shows). */
  private readonly last = new Map<number, Plane>();
  private readonly warned = new Set<string>();
  private readonly device: GPUDevice;
  private readonly renderer: Pick<VirglRenderer, 'resourceInfo' | 'readResource'>;

  /** `renderer`: the virgl renderer whose resources these are (their formats, sizes and bytes read back). */
  constructor(device: GPUDevice, renderer: Pick<VirglRenderer, 'resourceInfo' | 'readResource'>) {
    [this.device, this.renderer] = [device, renderer];
  }

  private warn(m: string) {
    if (this.warned.has(m)) return;
    this.warned.add(m);
    console.warn(`venus-import: ${m}`);
  }

  /** The driver bound `texture`'s image to memory imported from virgl resource `res` (0: the image is destroyed). */
  bind(texture: GPUTexture, res: number) {
    const old = this.resourceOf.get(texture);
    if (old !== undefined) {
      this.textures.get(old)?.delete(texture);
      if (!this.textures.get(old)?.size) this.textures.delete(old);
      this.resourceOf.delete(texture);
    }
    if (!res) return;
    const t0 = performance.now();
    let set = this.textures.get(res);
    if (!set) this.textures.set(res, (set = new Set()));
    set.add(texture);
    this.resourceOf.set(texture, res);
    this.stats.binds++;
    let plane = this.last.get(res);
    if (!plane) {
      plane = this.read(res);
      if (plane) this.last.set(res, plane);
    }
    if (plane) this.write(texture, plane);
    this.stats.ms += performance.now() - t0;
  }

  /** A picture's plane written into virgl resource `res` (web/virgl-renderer.ts `onPlane`). */
  plane(res: number, data: Uint8Array, w: number, h: number, bpp: number) {
    if (!this.last.has(res) && !this.textures.has(res)) return;
    const t0 = performance.now();
    const p = { data, w, h, bpp };
    this.last.set(res, p);
    this.stats.pictures++;
    for (const t of this.textures.get(res) ?? []) this.write(t, p);
    this.stats.ms += performance.now() - t0;
  }

  /** A resource destroyed: its bytes go. */
  forget(res: number) {
    this.last.delete(res);
  }

  /** The virgl texture's bytes, read back (tightly packed rows). */
  private read(res: number): Plane | undefined {
    const desc = this.renderer.resourceInfo(res);
    const bpp = desc && FORMATS.get(desc.format)?.bpp;
    if (!desc || !bpp) return undefined;
    const data = this.renderer.readResource(res);
    if (!data) return undefined;
    this.stats.readbacks++;
    return { data, w: desc.width, h: desc.height, bpp };
  }

  private write(texture: GPUTexture, p: Plane) {
    const bpp = BYTES[texture.format];
    if (bpp !== p.bpp) {
      this.warn(`a ${texture.format} texture can't take a plane of ${p.bpp} bytes a texel`);
      return;
    }
    const w = Math.min(p.w, texture.width), h = Math.min(p.h, texture.height);
    if (!w || !h) return;
    this.device.queue.writeTexture({ texture }, p.data, { bytesPerRow: p.w * p.bpp, rowsPerImage: p.h }, [w, h]);
    this.stats.bytes += w * h * bpp;
  }
}
