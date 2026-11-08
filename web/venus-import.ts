// Virgl's resources into Vulkan through Venus (vk/README.md "Imports"; docs/devices.md "Venus"): the reverse of
// web/venus-share.ts. A guest program imports a virgl resource into Vulkan as a dma-buf (mpv on Vulkan maps each VA-API
// surface's planes, an R8 luma and an RG8 chroma, into libplacebo's textures): the kernel attaches the resource to the
// Venus context, the renderer makes it a dma-buf whose "fd" is its id (web/venus-host.ts, vk/glue.c
// `venus_resource_import`), and the driver binds images to memory imported from it (`gpu_texture_import`).
// Each resource has a WebGPU texture of its own (one per texture description: an image of another format or size made
// on it gets another), made at its first import and kept until the resource ends; an image bound to the resource's
// memory takes that texture in place of its own (web/venus-gpu.ts `onImport`), so a surface imported again at every
// frame it shows is a bind that writes nothing (VK4 T16), and what Vulkan draws into it stays there. The texture gets
// the resource's bytes here, with `queue.writeTexture`, so in the queue's order before the submits that sample it:
//   when it's made  the bytes of the last picture written into the resource (kept for resources imported before), or
//                   the virgl texture read back (a resource's first import, or one that isn't a video plane);
//   at a picture    each video picture written into a plane (web/virgl-renderer.ts `onPlane`, the host's own bytes,
//                   decoded by WebCodecs) also goes to the resource's textures.
// `?gpu=vkimport=rewrite` (A/B) leaves each image its own texture, written at every bind, as before T16.
// Nothing makes the guest wait for a picture before it imports or samples its surface: Mesa's virgl VA driver makes no
// fence for a decode, so mpv's `vaSyncSurface` returns at once (docs/plans/video.md), and Venus's ring passes the GPU
// worker's call queue. A texture made while the resource's picture is still decoding reads nothing back (the virgl
// texture doesn't have it yet) and is left to the picture, written when it lands; a draw already queued samples the
// texture's earlier bytes (a reused surface's last picture, or zeros), and the next draw the new picture.
// Writes, pictures and resources' ends all go through the GPU worker's queue order (`later`: web/venus-gpu.ts, after
// the submits held for their pipelines), so a held write never outlives its resource's end; a write held past its
// resource's end (and its id's reuse) is dropped, by the count of ends at its call. Which textures a resource has is
// known at once (the driver's binds name them at once), and a resource's end takes them out at once, destroying them in
// the queue's order.
import { FORMATS } from './virgl-formats.ts';
import type { VirglRenderer } from './virgl-renderer.ts';

/** Binds, of them those that made a texture (`made`), pictures taken, readbacks, bytes written, and the thread's ms for them. */
export type ImportStats = { binds: number; made: number; pictures: number; readbacks: number; bytes: number; ms: number };

/** A plane's bytes as written: rows of `w` texels of `bpp` bytes, `h` of them. */
type Plane = { data: Uint8Array; w: number; h: number; bpp: number };

/** Bytes a texel of the formats an imported texture may have (WebGPU's 8-bit ones: VA-API's planes are R8 and RG8). */
const BYTES: Partial<Record<GPUTextureFormat, number>> = { r8unorm: 1, rg8unorm: 2, rgba8unorm: 4, 'rgba8unorm-srgb': 4, bgra8unorm: 4, 'bgra8unorm-srgb': 4 };

/** What the import needs of the virgl renderer: resources' formats, sizes and bytes, and whether a picture is pending. */
export type ImportSource = Pick<VirglRenderer, 'resourceInfo' | 'readResource'> & { videoPending: Pick<VirglRenderer['videoPending'], 'res'> };

export class VenusImport {
  readonly stats: ImportStats = { binds: 0, made: 0, pictures: 0, readbacks: 0, bytes: 0, ms: 0 };
  /** Each resource's own textures, by their description (`descKey`). */
  private readonly own = new Map<number, Map<string, GPUTexture>>();
  /** Images that keep their own texture (`rewrite`, or one whose description is unknown): those imported from each resource, and each one's resource. */
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
  private readonly rewrite: boolean;

  /**
   * `renderer`: the virgl renderer whose resources these are. `later`: the queue order the textures' writes take
   * (`VenusGpu.later`; at once by default). `rewrite` (`?gpu=vkimport=rewrite`): no texture of the resource's own.
   */
  constructor(device: GPUDevice, renderer: ImportSource, later: (f: () => void) => void = (f) => f(), options: { rewrite?: boolean } = {}) {
    [this.device, this.renderer, this.later] = [device, renderer, later];
    this.rewrite = !!options.rewrite;
  }

  private warn(m: string) {
    if (this.warned.has(m)) return;
    this.warned.add(m);
    console.warn(`venus-import: ${m}`);
  }

  /**
   * The driver bound an image to memory imported from virgl resource `res` (0: the image is destroyed); `image`, its own
   * texture, or what makes it (an image made at its bind has none until one is needed: VK4 T48); `desc`, what that
   * texture is made with. Returns the resource's own texture for that description, which the image takes in place of
   * its own (none made); undefined: it keeps its own, written here.
   */
  bind(image: GPUTexture | (() => GPUTexture), res: number, desc?: GPUTextureDescriptor): GPUTexture | undefined {
    if (res && desc && !this.rewrite && BYTES[desc.format] !== undefined) {
      this.stats.binds++;
      const key = descKey(desc);
      let own = this.own.get(res);
      if (!own) this.own.set(res, (own = new Map()));
      const had = own.get(key);
      if (had) return had;
      const t = this.device.createTexture(desc);
      own.set(key, t);
      this.stats.made++;
      const resets = this.resets, ends = this.ends.get(res) ?? 0;
      this.later(() => {
        if (resets !== this.resets || ends !== (this.ends.get(res) ?? 0)) return;
        this.fill(t, res);
      });
      return t;
    }
    const texture = typeof image === 'function' ? image() : image;
    const resets = this.resets, ends = this.ends.get(res) ?? 0;
    this.later(() => {
      this.untrack(texture);
      // Gone since the call (its id perhaps another resource's now): nothing of it to take.
      if (!res || resets !== this.resets || ends !== (this.ends.get(res) ?? 0)) return;
      let set = this.textures.get(res);
      if (!set) this.textures.set(res, (set = new Set()));
      set.add(texture);
      this.resourceOf.set(texture, res);
      this.stats.binds++;
      this.stats.made++;
      this.fill(texture, res);
    });
    return undefined;
  }

  /** A texture new to resource `res` takes its bytes: its last picture, or virgl's texture read back. */
  private fill(texture: GPUTexture, res: number) {
    const t0 = performance.now();
    let plane = this.last.get(res);
    // A picture still decoding isn't in the virgl texture yet: it's written to this one when it lands (`plane`).
    if (!plane && !this.renderer.videoPending.res(res)) {
      plane = this.read(res);
      if (plane) this.last.set(res, plane);
    }
    if (plane) this.write(texture, plane);
    this.stats.ms += performance.now() - t0;
  }

  /** A picture's plane written into virgl resource `res` (web/virgl-renderer.ts `onPlane`). */
  plane(res: number, data: Uint8Array, w: number, h: number, bpp: number) {
    const own = [...this.own.get(res)?.values() ?? []];
    this.later(() => {
      if (!this.last.has(res) && !this.textures.has(res) && !own.length) return;
      const t0 = performance.now();
      const p = { data, w, h, bpp };
      this.last.set(res, p);
      this.stats.pictures++;
      for (const t of own) this.write(t, p);
      for (const t of this.textures.get(res) ?? []) this.write(t, p);
      this.stats.ms += performance.now() - t0;
    });
  }

  /** Virgl resource `res` destroyed: its bytes and textures go, and images' textures take no more pictures (an id is reused). */
  unref(res: number) {
    this.ends.set(res, (this.ends.get(res) ?? 0) + 1);
    const own = this.own.get(res);
    this.own.delete(res);
    this.later(() => {
      this.last.delete(res);
      for (const t of this.textures.get(res) ?? []) this.resourceOf.delete(t);
      this.textures.delete(res);
      for (const t of own?.values() ?? []) t.destroy();
    });
  }

  /** A virtio reset, or a snapshot's 3D state loaded in its place: every resource is gone. */
  reset() {
    this.resets++;
    this.ends.clear();
    const own = [...this.own.values()];
    this.own.clear();
    this.later(() => {
      this.last.clear();
      this.textures.clear();
      this.resourceOf.clear();
      for (const m of own) for (const t of m.values()) t.destroy();
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

/** What tells two textures of a resource apart: their description, as the driver makes it. */
function descKey(d: GPUTextureDescriptor): string {
  return JSON.stringify([d.size, d.format, d.usage, d.mipLevelCount ?? 1, d.sampleCount ?? 1, d.dimension ?? '2d', d.viewFormats ?? []]);
}
