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
// Nothing makes the guest wait for a picture before it imports or samples its surface: Mesa's virgl VA driver makes no
// fence for a decode, so mpv's `vaSyncSurface` returns at once (docs/plans/video.md), and Venus's ring passes the GPU
// worker's call queue. A bind while the resource's picture is still decoding reads nothing back (the virgl texture
// doesn't have it yet) and leaves the texture to the picture, written when it lands; a draw already queued samples the
// texture's earlier bytes (a reused surface's last picture, or zeros), and the next draw the new picture.
// Binds, pictures and resources' ends all go through the GPU worker's queue order (`later`: web/venus-gpu.ts, after
// the submits held for their pipelines), so a held bind or picture never outlives its resource's end; a bind held past
// its resource's end (and its id's reuse) is dropped, by the count of ends at its call.
import { FORMATS } from './virgl-formats.ts';
import type { VirglRenderer } from './virgl-renderer.ts';

export type ImportStats = { binds: number; pictures: number; readbacks: number; bytes: number; ms: number };

/** A plane's bytes as written: rows of `w` texels of `bpp` bytes, `h` of them. */
type Plane = { data: Uint8Array; w: number; h: number; bpp: number };

/** Bytes a texel of the formats an imported texture may have (WebGPU's 8-bit ones: VA-API's planes are R8 and RG8). */
const BYTES: Partial<Record<GPUTextureFormat, number>> = { r8unorm: 1, rg8unorm: 2, rgba8unorm: 4, 'rgba8unorm-srgb': 4, bgra8unorm: 4, 'bgra8unorm-srgb': 4 };

/** What the import needs of the virgl renderer: resources' formats, sizes and bytes, and whether a picture is pending. */
export type ImportSource = Pick<VirglRenderer, 'resourceInfo' | 'readResource'> & { videoPending: Pick<VirglRenderer['videoPending'], 'res'> };

export class VenusImport {
  readonly stats: ImportStats = { binds: 0, pictures: 0, readbacks: 0, bytes: 0, ms: 0 };
  /** The textures imported from each resource, and each texture's resource. */
  private readonly textures = new Map<number, Set<GPUTexture>>();
  private readonly resourceOf = new Map<GPUTexture, number>();
  /** The last plane written into each resource ever imported (a surface is imported again at every frame it shows). */
  private readonly last = new Map<number, Plane>();
  /** Resources' ends so far, at once (`unref`): each id's, and resets (each ends them all). */
  private readonly ends = new Map<number, number>();
  private resets = 0;
  private readonly warned = new Set<string>();
  private readonly device: GPUDevice;
  private readonly renderer: ImportSource;
  private readonly later: (f: () => void) => void;

  /**
   * `renderer`: the virgl renderer whose resources these are. `later`: the queue order the textures' writes take
   * (`VenusGpu.later`; at once by default).
   */
  constructor(device: GPUDevice, renderer: ImportSource, later: (f: () => void) => void = (f) => f()) {
    [this.device, this.renderer, this.later] = [device, renderer, later];
  }

  private warn(m: string) {
    if (this.warned.has(m)) return;
    this.warned.add(m);
    console.warn(`venus-import: ${m}`);
  }

  /** The driver bound `texture`'s image to memory imported from virgl resource `res` (0: the image is destroyed). */
  bind(texture: GPUTexture, res: number) {
    const resets = this.resets, ends = this.ends.get(res) ?? 0;
    this.later(() => {
      this.untrack(texture);
      // Gone since the call (its id perhaps another resource's now): nothing of it to take.
      if (!res || resets !== this.resets || ends !== (this.ends.get(res) ?? 0)) return;
      const t0 = performance.now();
      let set = this.textures.get(res);
      if (!set) this.textures.set(res, (set = new Set()));
      set.add(texture);
      this.resourceOf.set(texture, res);
      this.stats.binds++;
      let plane = this.last.get(res);
      // A picture still decoding isn't in the virgl texture yet: it's written to this one when it lands (`plane`).
      if (!plane && !this.renderer.videoPending.res(res)) {
        plane = this.read(res);
        if (plane) this.last.set(res, plane);
      }
      if (plane) this.write(texture, plane);
      this.stats.ms += performance.now() - t0;
    });
  }

  /** A picture's plane written into virgl resource `res` (web/virgl-renderer.ts `onPlane`). */
  plane(res: number, data: Uint8Array, w: number, h: number, bpp: number) {
    this.later(() => {
      if (!this.last.has(res) && !this.textures.has(res)) return;
      const t0 = performance.now();
      const p = { data, w, h, bpp };
      this.last.set(res, p);
      this.stats.pictures++;
      for (const t of this.textures.get(res) ?? []) this.write(t, p);
      this.stats.ms += performance.now() - t0;
    });
  }

  /** Virgl resource `res` destroyed: its bytes go, and its textures take no more pictures (an id is reused). */
  unref(res: number) {
    this.ends.set(res, (this.ends.get(res) ?? 0) + 1);
    this.later(() => {
      this.last.delete(res);
      for (const t of this.textures.get(res) ?? []) this.resourceOf.delete(t);
      this.textures.delete(res);
    });
  }

  /** A virtio reset, or a snapshot's 3D state loaded in its place: every resource is gone. */
  reset() {
    this.resets++;
    this.ends.clear();
    this.later(() => {
      this.last.clear();
      this.textures.clear();
      this.resourceOf.clear();
    });
  }

  private untrack(texture: GPUTexture) {
    const old = this.resourceOf.get(texture);
    if (old === undefined) return;
    this.textures.get(old)?.delete(texture);
    if (!this.textures.get(old)?.size) this.textures.delete(old);
    this.resourceOf.delete(texture);
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
