// The Vulkan driver's "hardware" (vk/driver/wg_gpu.h; vk/README.md "The driver"): the renderer module's `wg` imports,
// implemented on the GPU worker's WebGPU device. The driver names every object by an id it assigns, describes the
// rarely made ones as JSON (ids for the objects they refer to) and replays each submit's commands as calls with plain
// numbers into one command encoder. What it can't express as a WebGPU command — blits, resolves, image clears and
// clears of a pass's attachments — is drawn here (`meta`, `clearRects`). A submit completes once its work is done and
// the staging buffers of its readbacks are mapped: then `complete(serial)` calls back into the module, in submit order.
// Without a device (Node's tests) objects are only counted and every submit completes at once.

import type { ShaderCache } from './venus-cache.ts';

/** GPUBufferUsage's and GPUMapMode's values (the worker may lack the globals in Node). */
const COPY_SRC = 4, COPY_DST = 8, TEXTURE_BINDING = 4, UNIFORM = 64, STORAGE = 128, RENDER_ATTACHMENT = 16, MAP_READ = 1, MAP_MODE_READ = 1;

export type VenusGpuStats = {
  submits: number; uploads: number; uploadBytes: number; readbacks: number; readbackBytes: number; pipelines: number; pipelineMs: number; bindGroups: number; errors: number; dirtyPages: number;
  /** Of a submit's way back (VK3 L2): submits done, the ms from `queue.submit` until WebGPU said done (its work and its
   * readbacks' maps), the longest, and the ms from then until it completed in submit order; empty submits sent to
   * make the browser look at the GPU sooner (`nudge`). */
  done: number; doneMs: number; doneMaxMs: number; orderMs: number; nudges: number;
  /** Of pipelines made asynchronously (VK3 L3): those made, the ms until each was ready (summed), submits that waited
   * for one (`deferred`) and the ms they waited, pipelines a submit had to make at once instead (`syncPipelines`: never
   * expected), and the ms the translator took (`translations`: vkCreate*Pipelines in the module, `translateMs`). */
  pipelinesReady: number; pipelineReadyMs: number; deferred: number; deferredMs: number; syncPipelines: number; translations: number; translateMs: number;
  /** The shader cache across runs (web/venus-cache.ts): lookups found and not, entries stored. */
  cacheHits: number; cacheMisses: number; cacheStores: number;
  /** A submit's parts in the worker (VK3 L2b): the ms from its encoder to its submit (the module's replay into WebGPU's
   * calls), the ms `queue.submit` itself took, its render and compute passes and draws; with `?gpu=vkgputime` the GPU's
   * own ms in its passes (timestamp queries: `gpuTimed` submits measured, `gpuMs` summed over their passes). */
  encodeMs: number; submitCallMs: number; passes: number; draws: number; gpuTimed: number; gpuMs: number;
  /** Of the submits with a pass (a frame's, not a fence's or an upload's alone): those done and their ms to done. */
  workDone: number; workDoneMs: number;
};

/**
 * A pipeline being made asynchronously (createRenderPipelineAsync): `value` once ready (the pipeline, or an invalid
 * one if WebGPU refused it), `ready` resolving then; `sync()` makes it at once when a command needs it before then.
 */
class Later {
  value: GPURenderPipeline | GPUComputePipeline | undefined;
  ready: Promise<void>;
  private readonly fallback: () => GPURenderPipeline | GPUComputePipeline;
  constructor(ready: Promise<GPURenderPipeline | GPUComputePipeline>, fallback: () => GPURenderPipeline | GPUComputePipeline) {
    this.fallback = fallback;
    this.ready = ready.then((p) => { this.value ??= p; }, () => { this.value ??= this.fallback(); });
  }
  sync() { return (this.value ??= this.fallback()); }
}

/** A run of queue work held until the pipelines its draws use are ready (`VenusGpu.later`). */
type Batch = { waits: Promise<void>[]; ops: (() => void)[]; at: number };

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
type View = { view: GPUTextureView; format: GPUTextureFormat; samples: number; tex: GPUTexture };
type Obj = GPUBuffer | GPUTexture | View | GPUSampler | GPUBindGroupLayout | GPUPipelineLayout | GPURenderPipeline | GPUComputePipeline | GPUBindGroup | GPUShaderModule | GPUQuerySet | Later;

/** What the driver advertises follows (vk/driver/wg_caps.c): a device's features and limits, or a stand-in's in tests. */
export type GpuCaps = { readonly features: ReadonlySet<string>; readonly limits: object; readonly adapterInfo?: { readonly vendor: string } };

/**
 * The adapter's maker (`GPUAdapterInfo.vendor`) as a PCI vendor ID, which the device reports as its own. Not NVIDIA's
 * (0x10de): Venus's guest driver (Mesa 26's vn_wsi.c) takes a device of that ID for Venus on NVIDIA's own driver,
 * which can't render to linear images, and makes its WSI copy every frame into a buffer it exports instead of the image
 * (the prime blit): the buffer isn't a texture web/venus-share.ts can share, so every Vulkan window was black on the
 * user's NVIDIA desktop (bench/vulkan/REPORT.md "VK3 L1"). An NVIDIA adapter is reported as an unknown maker (0).
 */
export const VENDORS: Record<string, number> = { apple: 0x106b, nvidia: 0, amd: 0x1002, ati: 0x1002, intel: 0x8086, google: 0x1ae0, arm: 0x13b5, qualcomm: 0x5143, 'img-tec': 0x1010, imagination: 0x1010, microsoft: 0x1414, samsung: 0x144d };

/**
 * The adapter's features `?gpu=vkformats=held` keeps from the device (VK3 L4–L4e; vk/README.md "The driver"): with them
 * libplacebo has its FBOs, and with those its advanced rendering (scalers, debanding). Held by default until VK3 L4e
 * (bench/vulkan/REPORT.md "VK3 L4", "VK3 L4d", "VK3 L4e"); the switch is kept for A/B.
 */
export const HELD_FEATURES = ['float32-blendable', 'tier1-storage'];

/**
 * The device's optional features the driver uses (vk/driver/wg_private.h `wg_feature`), and whether there is a device.
 * Bit 14 is storage for texture-formats-tier1's formats, a part of that feature the driver can take apart (`tier1-storage`).
 * `hold` names features the driver doesn't take, as if the adapter lacked them (`HELD_FEATURES` with `?gpu=vkformats=held`; `?gpu=vkhold=<name>`).
 */
const FEATURES = ['texture-compression-bc', 'texture-compression-etc2', 'texture-compression-astc', 'depth32float-stencil8', 'float32-filterable',
  'depth-clip-control', 'dual-source-blending', 'clip-distances', 'indirect-first-instance', 'texture-formats-tier1', 'texture-formats-tier2',
  'rg11b10ufloat-renderable', 'float32-blendable', 'bgra8unorm-storage'];
export function gpuFeatures(caps: GpuCaps | undefined, device: boolean, hold: readonly string[] = []) {
  let flags = device ? 1 << 31 : 0;
  const has = (f: string) => !!caps?.features.has(f) && !hold.includes(f);
  FEATURES.forEach((f, i) => { if (has(f)) flags |= 1 << i; });
  if (has('texture-formats-tier1') && !hold.includes('tier1-storage')) flags |= 1 << FEATURES.length;
  return flags;
}

/**
 * The limits the driver reports from (vk/driver/wg_private.h `struct wg_limits`, in its order), each with WebGPU's
 * default (what a device has unless asked for more; what the driver sees without one).
 */
export const LIMITS: [string, number][] = [
  ['maxTextureDimension1D', 8192], ['maxTextureDimension2D', 8192], ['maxTextureDimension3D', 2048], ['maxTextureArrayLayers', 256],
  ['maxBindGroups', 4], ['maxDynamicUniformBuffersPerPipelineLayout', 8], ['maxDynamicStorageBuffersPerPipelineLayout', 4],
  ['maxSampledTexturesPerShaderStage', 16], ['maxSamplersPerShaderStage', 16], ['maxStorageBuffersPerShaderStage', 8],
  ['maxStorageTexturesPerShaderStage', 4], ['maxUniformBuffersPerShaderStage', 12], ['maxUniformBufferBindingSize', 65536],
  ['maxStorageBufferBindingSize', 134217728], ['minUniformBufferOffsetAlignment', 256], ['minStorageBufferOffsetAlignment', 256],
  ['maxVertexBuffers', 8], ['maxBufferSize', 268435456], ['maxVertexAttributes', 16], ['maxVertexBufferArrayStride', 2048],
  ['maxInterStageShaderVariables', 16], ['maxColorAttachments', 8], ['maxComputeWorkgroupStorageSize', 16384],
  ['maxComputeInvocationsPerWorkgroup', 256], ['maxComputeWorkgroupSizeX', 256], ['maxComputeWorkgroupSizeY', 256],
  ['maxComputeWorkgroupSizeZ', 64], ['maxComputeWorkgroupsPerDimension', 65535], ['maxImmediateSize', 0],
  ['maxStorageBuffersInFragmentStage', 8], ['maxStorageTexturesInFragmentStage', 4],
  // Not a limit: the maker's PCI vendor ID (`VENDORS`), 0 for one this list doesn't know.
  ['vendorID', 0],
];

/** `LIMITS`' values of `caps` as venus_init takes them (32 bits each; the defaults where it has none). */
export function gpuLimits(caps: GpuCaps | undefined) {
  const l = (caps?.limits ?? {}) as Record<string, number | undefined>;
  // Immediates only where the browser has `setImmediates`, and at most the 128 bytes of Vulkan's push constants.
  const immediates = typeof GPURenderPassEncoder !== 'undefined' && typeof (GPURenderPassEncoder.prototype as unknown as { setImmediates?: unknown }).setImmediates === 'function';
  // A stage's storage in the fragment stage: the per-stage limit where the browser predates the split.
  const fallback: Record<string, string> = { maxStorageBuffersInFragmentStage: 'maxStorageBuffersPerShaderStage', maxStorageTexturesInFragmentStage: 'maxStorageTexturesPerShaderStage' };
  return new Uint32Array(LIMITS.map(([k, d]) => {
    const v = k === 'maxImmediateSize' ? (immediates ? Math.min(128, l[k] ?? 0) : 0)
      : k === 'vendorID' ? VENDORS[caps?.adapterInfo?.vendor.toLowerCase() ?? ''] ?? 0
        : l[k] ?? (fallback[k] ? l[fallback[k]] : undefined) ?? d;
    return Math.min(v, 0xffff_ffff);
  }));
}

/** The features and limits to ask an adapter's device for: every one the driver uses, as far as the adapter goes. */
export function deviceRequest(adapter: GPUAdapter, options: { gpuTime?: boolean } = {}): GPUDeviceDescriptor {
  const limits = adapter.limits as unknown as Record<string, number>;
  const requiredLimits: Record<string, number> = {};
  for (const [k] of LIMITS) if (typeof limits[k] === 'number') requiredLimits[k] = limits[k];
  // Vulkan has no limit on a pass's attachments' bytes a sample: ask for the most.
  if (typeof limits.maxColorAttachmentBytesPerSample === 'number') requiredLimits.maxColorAttachmentBytesPerSample = limits.maxColorAttachmentBytesPerSample;
  const features = FEATURES.filter((f) => adapter.features.has(f)) as GPUFeatureName[];
  // `?gpu=vkgputime`: timestamp queries for the worker's own measurement (VK3 L2b), not the driver's.
  if (options.gpuTime && adapter.features.has('timestamp-query')) features.push('timestamp-query');
  return { requiredFeatures: features, requiredLimits };
}

/**
 * A submit's passes timed on the GPU (`?gpu=vkgputime`, VK3 L2b): the first `PASSES` passes write their begin and end
 * into a query set, resolved and copied into a buffer read once the submit is done. Reused across submits.
 */
class Timing {
  static readonly PASSES = 8;
  readonly set: GPUQuerySet;
  private readonly resolved: GPUBuffer;
  private readonly staging: GPUBuffer;
  /** Passes timed in the open submit. */
  n = 0;
  constructor(d: GPUDevice) {
    this.set = d.createQuerySet({ type: 'timestamp', count: 2 * Timing.PASSES });
    this.resolved = d.createBuffer({ size: 16 * Timing.PASSES, usage: 0x200 | COPY_SRC }); // QUERY_RESOLVE
    this.staging = d.createBuffer({ size: 16 * Timing.PASSES, usage: MAP_READ | COPY_DST });
  }
  resolve(enc: GPUCommandEncoder) {
    enc.resolveQuerySet(this.set, 0, 2 * this.n, this.resolved, 0);
    enc.copyBufferToBuffer(this.resolved, 0, this.staging, 0, 16 * this.n);
  }
  /** The ms summed over the timed passes; the timing is empty again. */
  async read() {
    const n = this.n;
    this.n = 0;
    await this.staging.mapAsync(MAP_MODE_READ, 0, 16 * n);
    const t = new BigUint64Array(this.staging.getMappedRange(0, 16 * n).slice(0));
    this.staging.unmap();
    let ns = 0;
    for (let i = 0; i < n; i++) if (t[2 * i + 1] > t[2 * i]) ns += Number(t[2 * i + 1] - t[2 * i]);
    return ns / 1e6;
  }
}

export class VenusGpu {
  readonly stats: VenusGpuStats = { submits: 0, uploads: 0, uploadBytes: 0, readbacks: 0, readbackBytes: 0, pipelines: 0, pipelineMs: 0, bindGroups: 0, errors: 0, dirtyPages: 0, done: 0, doneMs: 0, doneMaxMs: 0, orderMs: 0, nudges: 0, pipelinesReady: 0, pipelineReadyMs: 0, deferred: 0, deferredMs: 0, syncPipelines: 0, translations: 0, translateMs: 0, cacheHits: 0, cacheMisses: 0, cacheStores: 0, encodeMs: 0, submitCallMs: 0, passes: 0, draws: 0, gpuTimed: 0, gpuMs: 0, workDone: 0, workDoneMs: 0 };
  /** Submits not yet completed. */
  inFlight = 0;
  /** Called after each submit (the host's poller then runs until it completes: web/venus-host.ts). */
  onSubmit: (() => void) | undefined;
  private readonly objs: (Obj | undefined)[] = [];
  private enc: GPUCommandEncoder | undefined;
  private pass: GPURenderPassEncoder | GPUComputePassEncoder | undefined;
  /** The current render pass's attachments (for clears inside it). */
  private passAtts: { colors: (GPUTextureFormat | null)[]; depth?: GPUTextureFormat; samples: number; width: number; height: number } | undefined;
  /** Buffers to destroy once the encoder is submitted, and the readbacks' staging buffers by slot. */
  private temps: GPUBuffer[] = [];
  private readonly slots = new Map<number, { buffer: GPUBuffer; size: number }>();
  private submitSlots: number[] = [];
  private nextSlot = 1;
  private chain: Promise<void> = Promise.resolve();
  private readonly metaPipelines = new Map<string, GPURenderPipeline>();
  private readonly metaComputes = new Map<string, GPUComputePipeline>();
  /** A bind group layout's bindings of storage textures a shader may write, and the textures a bind group binds
   * there: a pass that sets the group writes them (`touched`, for presentation). */
  private readonly writableBindings = new WeakMap<GPUBindGroupLayout, Set<number>>();
  private readonly groupWrites: (GPUTexture[] | undefined)[] = []; // by the bind group's id
  private readonly views = new WeakMap<GPUTexture, Map<string, GPUTextureView>>();
  /** Pipelines being made asynchronously (`Later`), unless `syncPipelines` (`?gpu=vkpipelines=sync`). */
  private making = 0;
  private readonly syncPipelines: boolean;
  /** `?gpu=vkpipedelay=<ms>`: each pipeline made asynchronously is ready this much later than WebGPU says (VK3 L4e: a cold
   * compile of the host's GPU, as Metal's first one, on any host). */
  private readonly pipelineDelayMs: number;
  /** The open submit's commands while it is recorded to be held, the pipelines it waits for, its temporary buffers. */
  private rec: (() => void)[] | undefined;
  private recWaits: Later[] = [];
  private recTemps: GPUBuffer[] = [];
  /** Submits (and the queue work after them) held until their pipelines are ready, in order (`drain`). */
  private readonly held: Batch[] = [];
  private draining = false;
  private readonly idleWaiters: (() => void)[] = [];
  private readonly seen = new Set<string>();
  private readonly mem: () => ArrayBuffer;
  /** The submit (its count in `stats.submits`) that last wrote each texture, and those the open encoder writes. */
  private readonly written = new WeakMap<GPUTexture, number>();
  private touched = new Set<GPUTexture>();
  /** A texture's bytes are another renderer's resource's from now on (`res`; 0: no longer): web/venus-import.ts, called at the bind (it
   * writes the texture in the queue's order itself). */
  onImport: ((texture: GPUTexture, res: number) => void) | undefined;
  /** The shaders across runs (web/venus-cache.ts), once loaded: until then every lookup misses. */
  cache: ShaderCache | undefined;
  private cacheFound: { key: string; bytes: Uint8Array } | undefined;
  /** `?gpu=vkgputime` (VK3 L2b): each submit's first passes timed on the GPU (`Timing`, reused), the open encoder's. */
  private readonly gpuTime: boolean;
  private readonly timings: Timing[] = [];
  private timing: Timing | undefined;
  /** When the open encoder was asked for (`stats.encodeMs`), and its passes begun. */
  private encodeAt = 0;
  private encPasses = 0;

  /**
   * `memory`: memory 0. `complete(serial)`: the module's export. `dirty()`: the window's written pages since the last
   * call (undefined: unknown, every page counts).
   */
  private readonly device: GPUDevice | undefined;
  private readonly complete: (serial: number) => void;
  private readonly dirty: () => number[] | undefined;

  constructor(device: GPUDevice | undefined, memory: WebAssembly.Memory, complete: (serial: number) => void, dirty: () => number[] | undefined, options: { syncPipelines?: boolean; pipelineDelayMs?: number; gpuTime?: boolean } = {}) {
    [this.device, this.complete, this.dirty] = [device, complete, dirty];
    this.syncPipelines = !!options.syncPipelines;
    this.pipelineDelayMs = options.pipelineDelayMs ?? 0;
    this.gpuTime = !!options.gpuTime && !!device?.features.has('timestamp-query');
    this.mem = () => memory.buffer as ArrayBuffer;
    device?.addEventListener('uncapturederror', (e) => this.warn(`WebGPU: ${(e as GPUUncapturedErrorEvent).error.message}`));
  }

  private warn(m: string) {
    this.stats.errors++;
    const key = m.slice(0, 200);
    if (this.seen.has(key) || this.seen.size > 200) return;
    this.seen.add(key);
    console.warn(`venus-gpu: ${m}`);
  }

  private text(ptr: number, len: number) {
    return new TextDecoder().decode(new Uint8Array(this.mem(), ptr >>> 0, len).slice());
  }

  private get<T extends Obj>(id: number) { return this.objs[id] as T; }

  /** A texture by its id, with the submit that last wrote it (0: none yet): web/venus-share.ts reads WSI images. */
  texture(id: number): { texture: GPUTexture; written: number } | undefined {
    const t = this.objs[id];
    return t instanceof GPUTexture ? { texture: t, written: this.written.get(t) ?? 0 } : undefined;
  }

  /** The module's `wg` imports. */
  imports(): Record<string, (...a: number[]) => number | void> {
    const d = this.device;
    const self = this;
    const rp = () => this.pass as GPURenderPassEncoder;
    const cp = () => this.pass as GPUComputePassEncoder;
    const buf = (id: number) => this.get<GPUBuffer>(id);
    const nothing = () => {};
    if (!d) {
      // No device: objects aren't made; a submit completes in a later task.
      const noop: Record<string, (...a: number[]) => number | void> = {};
      for (const n of IMPORTS) noop[n] = nothing;
      noop.gpu_readback = () => 0;
      noop.gpu_dirty = (ptr: number, max: number) => this.dirtyInto(ptr, max);
      noop.gpu_submit = (serial: number) => { this.stats.submits++; this.chain = this.chain.then(() => this.complete(serial)); };
      Object.assign(noop, this.cacheImports());
      return noop;
    }
    // An exception out of an import would unwind the module's call midway (its state half updated: the renderer then
    // misbehaves for good); what WebGPU's API throws (an argument it rejects) is warned and the command dropped.
    const guarded: Record<string, (...a: number[]) => number | void> = {};
    for (const [name, f] of Object.entries({ ...this.calls(d, self, rp, cp, buf), ...this.cacheImports() })) {
      guarded[name] = (...a: number[]) => {
        try {
          return f(...a);
        } catch (e) {
          self.warn(`${name} threw: ${String(e).slice(0, 300)}`);
          return 0;
        }
      };
    }
    return guarded;
  }

  private calls(d: GPUDevice, self: this, rp: () => GPURenderPassEncoder, cp: () => GPUComputePassEncoder, buf: (id: number) => GPUBuffer): Record<string, (...a: number[]) => number | void> {
    // Every command resolves its ids and copies what it reads of memory 0 now (ids are reused, memory rewritten), and
    // goes to the queue through `later`: at once, or after the pipelines a held submit waits for (VK3 L3).
    const later = (f: () => void) => self.later(f);
    return {
      gpu_create(kind: number, id: number, ptr: number, len: number) { self.create(kind, id, parseJson(self.text(ptr, len))); },
      gpu_shader(id: number, ptr: number, len: number) {
        const code = self.text(ptr, len);
        const m = d.createShaderModule({ code });
        self.objs[id] = m;
        void m.getCompilationInfo().then((info) => {
          const errors = info.messages.filter((x) => x.type === 'error');
          if (errors.length) self.warn(`a shader didn't compile: ${errors.map((x) => `${x.lineNum}:${x.linePos} ${x.message}`).join('; ')}\n${code.split('\n').slice(0, 400).join('\n')}`);
        });
      },
      gpu_destroy(id: number) {
        const o = self.objs[id];
        self.objs[id] = undefined;
        if (o instanceof GPUBuffer || o instanceof GPUTexture || o instanceof GPUQuerySet) later(() => o.destroy());
      },
      gpu_write(id: number, offset: number, ptr: number, size: number) {
        if (!size) return;
        const b = buf(id);
        if (self.holding) {
          const bytes = new Uint8Array(self.mem(), ptr >>> 0, size).slice();
          later(() => d.queue.writeBuffer(b, offset, bytes));
        } else {
          d.queue.writeBuffer(b, offset, self.mem(), ptr >>> 0, size);
        }
        self.stats.uploads++;
        self.stats.uploadBytes += size;
      },
      gpu_dirty: (ptr: number, max: number) => this.dirtyInto(ptr, max),
      gpu_texture_import(tex: number, res: number) {
        const t = self.get<GPUTexture>(tex);
        // web/venus-import.ts writes the texture in the queue's order (`later`).
        if (t instanceof GPUTexture) self.onImport?.(t, res);
      },
      gpu_encoder() {
        self.encodeAt = performance.now();
        if (self.making || self.held.length) {
          self.rec = [];
          self.recWaits = [];
          self.recTemps = [];
        }
        later(() => {
          self.enc = d.createCommandEncoder();
          if (self.gpuTime) self.timing = self.timings.pop() ?? new Timing(d);
        });
      },
      gpu_copy_bb(src: number, so: number, dst: number, dO: number, size: number) {
        if (!size) return;
        const a = buf(src), b = buf(dst);
        // WebGPU copies 4-aligned offsets and sizes; Vulkan any (VK3 L4c-F): the others by a compute pass.
        if ((so | dO | size) & 3) later(() => self.copyUnaligned(a, so, b, dO, size));
        else later(() => self.enc!.copyBufferToBuffer(a, so, b, dO, size));
      },
      gpu_copy_bt(b: number, offset: number, bpr: number, rows: number, tex: number, mip: number, x: number, y: number, z: number, w: number, h: number, depth: number, aspect: number) {
        const B = buf(b), T = self.get<GPUTexture>(tex);
        later(() => {
          self.touched.add(T);
          if (aspect) return self.depthStencilCopy(true, B, offset, bpr, rows, T, mip, x, y, z, w, h, depth, aspect);
          self.enc!.copyBufferToTexture(self.layout(B, offset, bpr, rows, h, depth), self.texCopy(T, mip, x, y, z, aspect), { width: w, height: h, depthOrArrayLayers: depth });
        });
      },
      gpu_copy_tb(b: number, offset: number, bpr: number, rows: number, tex: number, mip: number, x: number, y: number, z: number, w: number, h: number, depth: number, aspect: number) {
        const B = buf(b), T = self.get<GPUTexture>(tex);
        later(() => {
          if (aspect) return self.depthStencilCopy(false, B, offset, bpr, rows, T, mip, x, y, z, w, h, depth, aspect);
          self.enc!.copyTextureToBuffer(self.texCopy(T, mip, x, y, z, aspect), self.layout(B, offset, bpr, rows, h, depth), { width: w, height: h, depthOrArrayLayers: depth });
        });
      },
      gpu_copy_tt(src: number, sm: number, sx: number, sy: number, sz: number, dst: number, dm: number, dx: number, dy: number, dz: number, w: number, h: number, depth: number, aspect: number) {
        const S = self.get<GPUTexture>(src), D = self.get<GPUTexture>(dst);
        later(() => {
          self.enc!.copyTextureToTexture(self.texCopy(S, sm, sx, sy, sz, aspect), self.texCopy(D, dm, dx, dy, dz, aspect), { width: w, height: h, depthOrArrayLayers: depth });
          self.touched.add(D);
        });
      },
      gpu_fill(b: number, offset: number, size: number, value: number) {
        if (!size) return;
        const B = buf(b);
        if (value === 0) return later(() => self.enc!.clearBuffer(B, offset, size));
        const t = self.staging(size, (m) => new Uint32Array(m).fill(value >>> 0));
        later(() => self.enc!.copyBufferToBuffer(t, 0, B, offset, size));
      },
      gpu_update(b: number, offset: number, ptr: number, size: number) {
        if (!size || !b) return;
        const padded = (size + 3) & ~3;
        const bytes = new Uint8Array(self.mem(), ptr >>> 0, size);
        const t = self.staging(padded, (m) => new Uint8Array(m).set(bytes));
        const B = buf(b);
        later(() => self.enc!.copyBufferToBuffer(t, 0, B, offset, padded));
      },
      gpu_blit(ptr: number, len: number) {
        const j = parseJson(self.text(ptr, len));
        j.dst = self.get<GPUTexture>(j.dst);
        if (j.src !== undefined) j.src = self.get<GPUTexture>(j.src);
        later(() => self.meta(j));
      },
      gpu_render_pass(ptr: number, len: number) {
        const j = parseJson(self.text(ptr, len));
        const colors: (GPUTextureFormat | null)[] = [];
        const textures: GPUTexture[] = [];
        let samples = 1;
        const desc: GPURenderPassDescriptor = {
          colorAttachments: (j.colorAttachments as (Json | null)[]).map((a) => {
            if (!a) { colors.push(null); return null; }
            const v = self.get<View>(a.view);
            colors.push(v.format);
            samples = v.samples;
            textures.push(v.tex);
            if (a.resolveTarget) textures.push(self.get<View>(a.resolveTarget).tex);
            return { ...a, view: v.view, resolveTarget: a.resolveTarget ? self.get<View>(a.resolveTarget).view : undefined } as GPURenderPassColorAttachment;
          }),
        };
        let depth: GPUTextureFormat | undefined;
        if (j.depthStencilAttachment) {
          const v = self.get<View>(j.depthStencilAttachment.view);
          depth = v.format;
          samples = v.samples;
          desc.depthStencilAttachment = { ...j.depthStencilAttachment, view: v.view };
        }
        const atts = { colors, depth, samples, width: j.width as number, height: j.height as number };
        self.stats.passes++;
        later(() => {
          for (const t of textures) self.touched.add(t);
          self.passAtts = atts;
          self.pass = self.enc!.beginRenderPass(self.timed(desc));
          self.encPasses++;
        });
      },
      gpu_compute_pass() {
        self.stats.passes++;
        later(() => { self.pass = self.enc!.beginComputePass(self.timed({})); self.encPasses++; });
      },
      gpu_pass_end() { later(() => { self.pass?.end(); self.pass = undefined; self.passAtts = undefined; }); },
      gpu_set_pipeline(id: number) {
        const o = self.objs[id];
        if (o instanceof Later && !o.value) {
          if (self.rec) {
            // Held: the submit goes once the pipeline is ready (`gpu_submit`).
            self.recWaits.push(o);
            return void self.rec.push(() => (self.pass as GPURenderPassEncoder).setPipeline(o.value as GPURenderPipeline));
          }
          // Not held (it was made after this submit's encoder: the driver makes them before): made at once.
          self.stats.syncPipelines++;
          o.sync();
        }
        const p = (o instanceof Later ? o.value : o) as GPURenderPipeline;
        later(() => (self.pass as GPURenderPassEncoder).setPipeline(p));
      },
      gpu_set_bind_group(index: number, id: number, ptr: number, n: number) {
        const offsets = n ? Array.from(new Uint32Array(self.mem(), ptr >>> 0, n)) : [];
        const g = self.get<GPUBindGroup>(id);
        const writes = self.groupWrites[id];
        later(() => {
          if (writes) for (const t of writes) self.touched.add(t);
          self.pass!.setBindGroup(index, g, offsets);
        });
      },
      gpu_set_vertex_buffer(slot: number, b: number, offset: number, size: number) { const B = buf(b); later(() => rp().setVertexBuffer(slot, B, offset, size)); },
      gpu_set_index_buffer(b: number, wide: number, offset: number, size: number) { const B = buf(b); later(() => rp().setIndexBuffer(B, wide ? 'uint32' : 'uint16', offset, size)); },
      gpu_set_viewport(x: number, y: number, w: number, h: number, min: number, max: number) { later(() => rp().setViewport(x, y, w, h, min, max)); },
      gpu_set_scissor(x: number, y: number, w: number, h: number) { later(() => rp().setScissorRect(x, y, w, h)); },
      gpu_set_blend_constant(r: number, g: number, b: number, a: number) { later(() => rp().setBlendConstant([r, g, b, a])); },
      gpu_set_stencil_reference(ref: number) { later(() => rp().setStencilReference(ref)); },
      gpu_set_immediates(offset: number, ptr: number, size: number) {
        const bytes = new Uint8Array(self.mem(), ptr >>> 0, size).slice();
        later(() => (self.pass as unknown as { setImmediates(o: number, d: Uint8Array): void }).setImmediates(offset, bytes));
      },
      gpu_draw(n: number, inst: number, first: number, firstInst: number) { self.stats.draws++; later(() => rp().draw(n, inst, first, firstInst)); },
      gpu_draw_indexed(n: number, inst: number, first: number, base: number, firstInst: number) { self.stats.draws++; later(() => rp().drawIndexed(n, inst, first, base, firstInst)); },
      gpu_draw_indirect(b: number, offset: number, indexed: number) {
        self.stats.draws++;
        const B = buf(b);
        later(() => {
          if (indexed) rp().drawIndexedIndirect(B, offset);
          else rp().drawIndirect(B, offset);
        });
      },
      gpu_dispatch(x: number, y: number, z: number) { later(() => cp().dispatchWorkgroups(x, y, z)); },
      gpu_dispatch_indirect(b: number, offset: number) { const B = buf(b); later(() => cp().dispatchWorkgroupsIndirect(B, offset)); },
      gpu_clear_rects(ptr: number, len: number) { const j = parseJson(self.text(ptr, len)); later(() => self.clearRects(j)); },
      gpu_begin_occlusion(i: number) { later(() => rp().beginOcclusionQuery(i)); },
      gpu_end_occlusion() { later(() => rp().endOcclusionQuery()); },
      gpu_resolve_queries(set: number, first: number, count: number, b: number, offset: number) {
        const Q = self.get<GPUQuerySet>(set), B = buf(b);
        later(() => self.enc!.resolveQuerySet(Q, first, count, B, offset));
      },
      gpu_readback(b: number, offset: number, size: number) {
        const staging = d.createBuffer({ size, usage: MAP_READ | COPY_DST });
        const B = buf(b);
        later(() => self.enc!.copyBufferToBuffer(B, offset, staging, 0, size));
        const slot = self.nextSlot++;
        self.slots.set(slot, { buffer: staging, size });
        self.submitSlots.push(slot);
        self.stats.readbacks++;
        self.stats.readbackBytes += size;
        return slot;
      },
      gpu_submit(serial: number) {
        const slots = self.submitSlots;
        self.submitSlots = [];
        self.inFlight++;
        if (self.encodeAt) self.stats.encodeMs += performance.now() - self.encodeAt;
        self.encodeAt = 0;
        let done: Promise<number>;
        if (!self.rec) {
          done = self.submitNow(slots, []);
        } else {
          const ops = self.rec, temps = self.recTemps;
          const waits = self.recWaits.filter((l) => !l.value).map((l) => l.ready);
          self.rec = undefined;
          let start!: () => void;
          done = new Promise<number>((resolve) => {
            start = () => {
              try {
                resolve(self.submitNow(slots, temps));
              } catch (err) {
                self.warn(`a held submit failed: ${String(err).slice(0, 300)}`);
                resolve(performance.now());
              }
            };
          });
          ops.push(() => start());
          if (!waits.length && !self.held.length) {
            for (const op of ops) self.runOp(op);
          } else {
            self.held.push({ waits, ops, at: performance.now() });
            self.stats.deferred++;
            self.drain();
          }
        }
        // In submit order: a later submit's work can't be done before an earlier one's, but its maps may resolve first.
        const finish = (doneAt: number) => {
          self.inFlight--;
          self.stats.orderMs += performance.now() - doneAt;
          self.complete(serial);
        };
        self.chain = self.chain.then(() => done).then(finish, (err) => {
          self.warn(`a submit's readbacks failed: ${err}`);
          finish(performance.now());
        }).finally(() => {
          for (const s of slots) { self.slots.get(s)!.buffer.destroy(); self.slots.delete(s); }
        });
        self.onSubmit?.();
      },
      gpu_readback_copy(slot: number, dst: number, size: number) {
        const s = self.slots.get(slot);
        if (!s) return;
        const n = Math.min(size, s.size) & ~3;
        new Uint8Array(self.mem(), dst >>> 0, n).set(new Uint8Array(s.buffer.getMappedRange(0, n)));
      },
    };
  }

  /** vk/wasi/disk_cache.c's imports: the shader cache's lookups and stores (`key` is `size` bytes of memory 0). */
  private cacheImports(): Record<string, (...a: number[]) => number | void> {
    const hex = (ptr: number, size: number) => {
      let k = '';
      for (const b of new Uint8Array(this.mem(), ptr >>> 0, size)) k += b.toString(16).padStart(2, '0');
      return k;
    };
    return {
      gpu_cache_get: (key: number, size: number) => {
        const k = hex(key, size);
        const bytes = this.cache?.get(k);
        if (bytes) this.stats.cacheHits++;
        else this.stats.cacheMisses++;
        this.cacheFound = bytes && { key: k, bytes };
        return bytes?.length ?? 0;
      },
      gpu_cache_read: (key: number, size: number, data: number, n: number) => {
        const f = this.cacheFound;
        this.cacheFound = undefined;
        if (!f || f.key !== hex(key, size)) return;
        new Uint8Array(this.mem(), data >>> 0, Math.min(n, f.bytes.length)).set(f.bytes.subarray(0, n));
      },
      gpu_cache_put: (key: number, size: number, data: number, n: number) => {
        if (!this.cache) return;
        this.cache.put(hex(key, size), new Uint8Array(this.mem(), data >>> 0, n));
        this.stats.cacheStores++;
      },
      gpu_translated: (ms: number) => {
        this.stats.translations++;
        this.stats.translateMs += ms;
      },
    };
  }

  /** The open encoder submitted (its temporary buffers destroyed); resolves when its work is done and its readbacks
   * mapped, with the time then. */
  private submitNow(slots: number[], temps: GPUBuffer[]): Promise<number> {
    const d = this.device!;
    if (this.pass) { this.pass.end(); this.pass = undefined; }
    const timing = this.timing, passes = this.encPasses;
    this.timing = undefined;
    this.encPasses = 0;
    if (timing?.n) timing.resolve(this.enc!);
    const s0 = performance.now();
    d.queue.submit([this.enc!.finish()]);
    this.stats.submitCallMs += performance.now() - s0;
    this.enc = undefined;
    this.stats.submits++;
    for (const t of this.touched) this.written.set(t, this.stats.submits);
    this.touched.clear();
    for (const t of this.temps) t.destroy();
    for (const t of temps) t.destroy();
    this.temps = [];
    const t0 = performance.now();
    const record = () => {
      const doneAt = performance.now(), ms = doneAt - t0;
      this.stats.done++;
      this.stats.doneMs += ms;
      this.stats.doneMaxMs = Math.max(this.stats.doneMaxMs, ms);
      if (passes) { this.stats.workDone++; this.stats.workDoneMs += ms; }
      return doneAt;
    };
    const done = Promise.all([d.queue.onSubmittedWorkDone(), ...slots.map((s) => this.slots.get(s)!.buffer.mapAsync(MAP_MODE_READ))]).then(record, (err) => { record(); throw err; });
    // The GPU's times read after the submit is done (not part of its way back), then the timing reused.
    if (timing) {
      if (!timing.n) this.timings.push(timing);
      else void done.then(() => timing.read()).then((ms) => { this.stats.gpuTimed++; this.stats.gpuMs += ms; }, () => {}).finally(() => this.timings.push(timing));
    }
    return done;
  }

  /** A pass descriptor with timestamp writes into the open encoder's timing, while it has room (`?gpu=vkgputime`). */
  private timed<T extends GPURenderPassDescriptor | GPUComputePassDescriptor>(desc: T): T {
    const t = this.timing;
    if (!t || t.n >= Timing.PASSES) return desc;
    const i = t.n++;
    return { ...desc, timestampWrites: { querySet: t.set, beginningOfPassWriteIndex: 2 * i, endOfPassWriteIndex: 2 * i + 1 } };
  }

  /** Whether queue work is being held (a submit recorded, or submits waiting for their pipelines). */
  private get holding() { return !!this.rec || this.held.length > 0; }

  /**
   * Queue work in the queue's order (`f` makes its WebGPU calls): at once, unless submits wait for pipelines being made
   * (then after them) or a submit is being recorded to wait (then in it). web/venus-import.ts's writes go through here
   * too, so that a held submit doesn't see bytes written after it.
   */
  later(f: () => void) {
    if (this.rec) this.rec.push(f);
    else if (this.held.length) this.held.at(-1)!.ops.push(f);
    else f();
  }

  /** Undefined when no submit is held; else a promise of the moment the last held one has gone to the queue. */
  idle(): Promise<void> | undefined {
    if (!this.held.length) return undefined;
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  private runOp(op: () => void) {
    try {
      op();
    } catch (err) {
      this.warn(`a held command threw: ${String(err).slice(0, 300)}`);
    }
  }

  /** The held submits, in order, each once its pipelines are ready. */
  private drain() {
    if (this.draining) return;
    this.draining = true;
    void (async () => {
      while (this.held.length) {
        const b = this.held[0];
        if (b.waits.length) await Promise.all(b.waits);
        this.held.shift();
        this.stats.deferredMs += performance.now() - b.at;
        for (const op of b.ops) this.runOp(op);
      }
      this.draining = false;
      for (const w of this.idleWaiters.splice(0)) w();
    })();
  }

  /**
   * An empty submit while work is in flight. Chromium's GPU process looks at a Dawn device whose work is pending on a
   * slow timer (on Vulkan: a trivial submit's onSubmittedWorkDone came back after ~3.4 ms on SwiftShader) but at once
   * when commands arrive: an empty submit every 1 ms (web/venus-host.ts's pump) brings a submit's fence back in ~1 ms
   * there, and changes nothing on Metal, whose completions come by callback (bench/vulkan/REPORT.md "VK3 L2"). A flood
   * of them slows Metal down (19.8 ms). Returns whether it sent one.
   */
  nudge() {
    if (!this.device || !this.inFlight) return false;
    this.device.queue.submit([]);
    this.stats.nudges++;
    return true;
  }

  private dirtyInto(ptr: number, max: number) {
    const pages = this.dirty();
    if (!pages) return -1;
    this.stats.dirtyPages += pages.length;
    if (pages.length > max) return -1;
    new Uint32Array(this.mem(), ptr >>> 0, pages.length).set(pages);
    return pages.length;
  }

  private layout(b: GPUBuffer, offset: number, bpr: number, rows: number, h: number, depth: number): GPUTexelCopyBufferInfo {
    // One row of blocks needs no row pitch (WebGPU's must be 256-aligned where given).
    const one = rows <= 1 && depth === 1 && bpr % 256 !== 0;
    return one ? { buffer: b, offset } : { buffer: b, offset, bytesPerRow: bpr, rowsPerImage: Math.max(rows, 1) };
  }

  /** A copy between a buffer and a depth or stencil aspect (aspect 1 or 2: the driver doesn't split their rows), which
   * WebGPU allows only of whole subresources, with rows 256 bytes apart, not of depth24plus's aspects at all, not into
   * depth32float's depth (nor of multisampled textures): rows realigned through a temporary buffer, and what WebGPU can't do
   * skipped with a warning (one bad copy would invalidate the submit's whole command buffer). */
  private depthStencilCopy(toTexture: boolean, b: GPUBuffer, offset: number, bpr: number, rows: number, t: GPUTexture, mip: number, x: number, y: number, z: number, w: number, h: number, depth: number, aspect: number) {
    const f = t.format;
    const stencil = aspect === 2 || f === 'stencil8';
    const bytes = stencil ? 1 : f === 'depth16unorm' ? 2 : 4;
    const whole = x === 0 && y === 0 && w === Math.max(1, t.width >> mip) && h === Math.max(1, t.height >> mip);
    const allowed = (stencil && !f.startsWith('depth24plus')) || f === 'depth16unorm' || (!toTexture && f.startsWith('depth32float'));
    const row = w * bytes;
    const realign = bpr % 256 !== 0 && (rows > 1 || depth > 1);
    if (!whole || !allowed || t.sampleCount > 1 || (realign && (row % 4 || bpr % 4 || offset % 4))) {
      this.warn(`a ${stencil ? 'stencil' : 'depth'} copy WebGPU can't make (${toTexture ? 'into' : 'from'} ${f}, ${w}x${h} at ${x},${y} of mip ${mip}): skipped`);
      return;
    }
    const size = { width: w, height: h, depthOrArrayLayers: depth };
    if (!realign) {
      const layout = this.layout(b, offset, bpr, rows, h, depth);
      if (toTexture) this.enc!.copyBufferToTexture(layout, this.texCopy(t, mip, x, y, z, aspect), size);
      else this.enc!.copyTextureToBuffer(this.texCopy(t, mip, x, y, z, aspect), layout, size);
      return;
    }
    const pitch = Math.ceil(row / 256) * 256;
    const temp = this.device!.createBuffer({ size: pitch * h * depth, usage: COPY_SRC | COPY_DST });
    this.temps.push(temp);
    const src = b, enc = this.enc!;
    const each = (fn: (from: number, to: number) => void) => {
      for (let d = 0; d < depth; d++) for (let r = 0; r < h; r++) fn(offset + (d * rows + r) * bpr, (d * h + r) * pitch);
    };
    const layout = { buffer: temp, offset: 0, bytesPerRow: pitch, rowsPerImage: h };
    if (toTexture) {
      each((from, to) => enc.copyBufferToBuffer(src, from, temp, to, row));
      enc.copyBufferToTexture(layout, this.texCopy(t, mip, x, y, z, aspect), size);
    } else {
      enc.copyTextureToBuffer(this.texCopy(t, mip, x, y, z, aspect), layout, size);
      each((to, from) => enc.copyBufferToBuffer(temp, from, src, to, row));
    }
  }
  private texCopy(tex: GPUTexture, mip: number, x: number, y: number, z: number, aspect: number): GPUTexelCopyTextureInfo {
    return { texture: tex, mipLevel: mip, origin: { x, y, z }, aspect: aspect === 1 ? 'depth-only' : aspect === 2 ? 'stencil-only' : 'all' };
  }

  /** A buffer of `size` bytes written by `fill` on the CPU, for a copy in the encoder (destroyed after its submit). */
  private staging(size: number, fill: (m: ArrayBuffer) => void) {
    const t = this.device!.createBuffer({ size, usage: COPY_SRC, mappedAtCreation: true });
    fill(t.getMappedRange());
    t.unmap();
    (this.rec ? this.recTemps : this.temps).push(t);
    return t;
  }

  private create(kind: number, id: number, j: Json) {
    const d = this.device!;
    const ids = (a: number[]) => a.map((i) => this.objs[i]);
    switch (kind) {
      case 0: this.objs[id] = d.createBuffer({ size: j.size, usage: j.usage }); return;
      case 1: this.objs[id] = d.createTexture(j as GPUTextureDescriptor); return;
      case 2: {
        const tex = this.get<GPUTexture>(j.texture);
        const { texture: _, ...desc } = j;
        this.objs[id] = { view: tex.createView(desc as GPUTextureViewDescriptor), format: j.format ?? tex.format, samples: tex.sampleCount, tex };
        return;
      }
      case 3: this.objs[id] = d.createSampler(j as GPUSamplerDescriptor); return;
      case 4: {
        const layout = d.createBindGroupLayout(j as GPUBindGroupLayoutDescriptor);
        const writable = (j.entries as Json[]).filter((e) => e.storageTexture && e.storageTexture.access !== 'read-only').map((e) => e.binding as number);
        if (writable.length) this.writableBindings.set(layout, new Set(writable));
        this.objs[id] = layout;
        return;
      }
      case 5: {
        const desc: Json = { bindGroupLayouts: ids(j.bindGroupLayouts) };
        if (j.immediateSize) desc.immediateSize = j.immediateSize;
        this.objs[id] = d.createPipelineLayout(desc as GPUPipelineLayoutDescriptor);
        return;
      }
      case 6: case 7: {
        const text = JSON.stringify(j).slice(0, 2000);
        j.layout = this.objs[j.layout];
        if (kind === 6) {
          j.vertex.module = this.objs[j.vertex.module];
          if (j.fragment) j.fragment.module = this.objs[j.fragment.module];
        } else {
          j.compute.module = this.objs[j.compute.module];
        }
        const what = kind === 6 ? 'a render pipeline' : 'a compute pipeline';
        // At once: an invalid pipeline if WebGPU refuses it (a draw with it then invalidates its submit, as before).
        const now = () => {
          d.pushErrorScope('validation');
          const p = kind === 6 ? d.createRenderPipeline(j as GPURenderPipelineDescriptor) : d.createComputePipeline(j as GPUComputePipelineDescriptor);
          void d.popErrorScope().then((e) => { if (e) this.warn(`${what}: ${e.message} (${text})`); });
          return p;
        };
        const t0 = performance.now();
        this.stats.pipelines++;
        if (this.syncPipelines) {
          this.objs[id] = now();
        } else {
          // Made off the GPU process's main thread (Dawn's workers), and Venus's ring goes on meanwhile; a submit
          // drawing with it is held until it's ready (`gpu_set_pipeline`). Refused, it is made at once for its error.
          let made: Promise<GPURenderPipeline | GPUComputePipeline> = kind === 6 ? d.createRenderPipelineAsync(j as GPURenderPipelineDescriptor) : d.createComputePipelineAsync(j as GPUComputePipelineDescriptor);
          const delay = this.pipelineDelayMs;
          if (delay > 0) made = made.then((p) => new Promise((resolve) => setTimeout(() => resolve(p), delay)));
          const later = new Later(made, now);
          this.making++;
          void later.ready.then(() => {
            this.making--;
            this.stats.pipelinesReady++;
            this.stats.pipelineReadyMs += performance.now() - t0;
          });
          this.objs[id] = later;
        }
        this.stats.pipelineMs += performance.now() - t0;
        return;
      }
      case 8: {
        const entries = (j.entries as Json[]).map((e) => ({
          binding: e.binding,
          resource: e.buffer !== undefined ? { buffer: this.get<GPUBuffer>(e.buffer), offset: e.offset, size: e.size }
            : e.view !== undefined ? this.get<View>(e.view).view : this.get<GPUSampler>(e.sampler),
        }));
        const layout = this.get<GPUBindGroupLayout>(j.layout);
        d.pushErrorScope('validation');
        const group = d.createBindGroup({ layout, entries });
        this.objs[id] = group;
        const writable = this.writableBindings.get(layout);
        const writes = writable && (j.entries as Json[]).filter((e) => writable.has(e.binding) && e.view !== undefined).map((e) => this.get<View>(e.view).tex);
        this.groupWrites[id] = writes?.length ? writes : undefined;
        void d.popErrorScope().then((e) => { if (e) this.warn(`a bind group: ${e.message}`); });
        this.stats.bindGroups++;
        return;
      }
      case 9: this.objs[id] = d.createQuerySet({ type: j.type, count: j.count }); return;
    }
  }

  // What the driver can't say as WebGPU commands: drawn here.

  private viewOf(t: GPUTexture, mip: number, layer: number, format?: string) {
    const key = `${mip}:${layer}:${format ?? ''}`;
    let views = this.views.get(t);
    if (!views) this.views.set(t, views = new Map());
    let v = views.get(key);
    if (!v) {
      // A 3D texture's slice is drawn into through its 3D view and the attachment's depthSlice (attachment()).
      v = t.dimension === '3d'
        ? t.createView({ dimension: '3d', baseMipLevel: mip, mipLevelCount: 1, ...(format ? { format: format as GPUTextureFormat } : {}) })
        : t.createView({ dimension: '2d', baseMipLevel: mip, mipLevelCount: 1, baseArrayLayer: layer, arrayLayerCount: 1, ...(format ? { format: format as GPUTextureFormat } : {}) });
      views.set(key, v);
    }
    return v;
  }

  /** A level and layer (a 3D texture's slice) as a colour attachment. */
  private attachment(t: GPUTexture, mip: number, layer: number) {
    const view = this.viewOf(t, mip, t.dimension === '3d' ? 0 : layer);
    return t.dimension === '3d' ? { view, depthSlice: layer } : { view };
  }

  /** `j`'s `src` and `dst` are the textures (`gpu_blit`). */
  private meta(j: Json) {
    const enc = this.enc!;
    const tex = j.dst as GPUTexture;
    this.touched.add(tex);
    const fmt = j.format as GPUTextureFormat;
    const depthy = /depth|stencil/.test(fmt);
    if (j.op === 'clear') {
      const view = this.viewOf(j.dst, j.dstMip, j.dstLayer);
      if (depthy) {
        const ds: GPURenderPassDepthStencilAttachment = { view };
        if (/depth/.test(fmt)) Object.assign(ds, j.depth !== undefined ? { depthLoadOp: 'clear', depthStoreOp: 'store', depthClearValue: j.depth } : { depthLoadOp: 'load', depthStoreOp: 'store' });
        if (/stencil/.test(fmt)) Object.assign(ds, j.stencil !== undefined ? { stencilLoadOp: 'clear', stencilStoreOp: 'store', stencilClearValue: j.stencil } : { stencilLoadOp: 'load', stencilStoreOp: 'store' });
        enc.beginRenderPass({ colorAttachments: [], depthStencilAttachment: ds }).end();
      } else if (!(tex.usage & RENDER_ATTACHMENT)) {
        // A format WebGPU can't render to (VK3 L4c-F): its texels encoded here and copied in.
        this.clearByCopy(tex, j.dstMip, j.dstLayer, fmt, (j.color ?? [0, 0, 0, 0]) as number[]);
      } else {
        // A 3D texture: every slice of the level (Vulkan clears the whole subresource).
        const slices = tex.dimension === '3d' ? Math.max(1, tex.depthOrArrayLayers >> j.dstMip) : 1;
        for (let z = 0; z < slices; z++)
          enc.beginRenderPass({ colorAttachments: [{ ...this.attachment(j.dst, j.dstMip, tex.dimension === '3d' ? z : j.dstLayer), loadOp: 'clear', storeOp: 'store', clearValue: j.color ?? [0, 0, 0, 0] }] }).end();
      }
      return;
    }
    if (j.op === 'resolveDepth') {
      this.resolveDepth(j);
      return;
    }
    if (j.op === 'resolve' && /int$/.test(fmt)) {
      this.warn(`a resolve of ${fmt}, which WebGPU can't resolve: skipped`);
      return;
    }
    if (j.op === 'resolve' && tex.dimension === '3d') {
      this.warn('a resolve into a 3D image, which WebGPU can\'t resolve into: skipped');
      return;
    }
    if (j.op === 'resolve') {
      enc.beginRenderPass({ colorAttachments: [{ view: this.viewOf(j.src, j.srcMip, j.srcLayer), resolveTarget: this.viewOf(j.dst, j.dstMip, j.dstLayer), loadOp: 'load', storeOp: 'store' }] }).end();
      return;
    }
    // A blit: the source's region drawn into the destination's.
    const kind = sampleKind(fmt);
    const srcKind = sampleKind(j.srcFormat);
    const linear = j.filter === 'linear' && srcKind === 'f32' && !/32float/.test(j.srcFormat);
    // A 3D source is sampled as one (its view is 3D) at the slice each destination slice maps to (VK3 L4c-F).
    const src3d = (j.src as GPUTexture).dimension === '3d';
    const key = `blit:${fmt}:${srcKind}:${linear}:${src3d}`;
    let pipeline = this.metaPipelines.get(key);
    if (!pipeline) {
      const out = kind === 'f32' ? 'vec4<f32>' : kind === 'u32' ? 'vec4<u32>' : 'vec4<i32>';
      const tex = `texture_${src3d ? '3d' : '2d'}<${srcKind}>`;
      const read = src3d
        ? (linear ? 'textureSampleLevel(t, s, vec3<f32>(uv, u.z.x), 0.0)' : 'textureLoad(t, vec3<i32>(floor(vec3<f32>(uv, u.z.x) * vec3<f32>(textureDimensions(t)))), 0)')
        : (linear ? 'textureSampleLevel(t, s, uv, 0.0)' : 'textureLoad(t, vec2<i32>(floor(uv * vec2<f32>(textureDimensions(t)))), 0)');
      const conv = kind === srcKind ? 'v' : kind === 'f32' ? 'vec4<f32>(v)' : `${out}(v)`;
      const code = `struct U { r: vec4<f32>, flip: vec4<f32>, z: vec4<f32> }
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var t: ${tex};
${linear ? '@group(0) @binding(2) var s: sampler;' : ''}
struct V { @builtin(position) p: vec4<f32>, @location(0) q: vec2<f32> }
@vertex fn vs(@builtin(vertex_index) i: u32) -> V {
  let q = vec2<f32>(f32((i << 1u) & 2u), f32(i & 2u));
  return V(vec4<f32>(q.x * 2.0 - 1.0, 1.0 - q.y * 2.0, 0.0, 1.0), q);
}
@fragment fn fs(v_in: V) -> @location(0) ${out} {
  let t01 = select(v_in.q, 1.0 - v_in.q, u.flip.xy > vec2<f32>(0.5));
  let uv = u.r.xy + t01 * u.r.zw;
  let v = ${read};
  return ${conv};
}`;
      const m = this.device!.createShaderModule({ code });
      pipeline = this.device!.createRenderPipeline({ layout: 'auto', vertex: { module: m, entryPoint: 'vs' }, fragment: { module: m, entryPoint: 'fs', targets: [{ format: fmt }] }, primitive: { topology: 'triangle-list' } });
      this.metaPipelines.set(key, pipeline);
    }
    const [sx0, sy0, sx1, sy1] = j.from as number[], [dx0, dy0, dx1, dy1] = j.to as number[];
    const [sw, sh] = j.srcSize as number[];
    if (dx0 === dx1 || dy0 === dy1) return;
    // Slices: a 3D destination's each, else the one layer; each samples the source's slice at its centre.
    const [sz0, sz1] = (j.srcZ ?? [0, 1]) as number[], [dz0, dz1] = (j.dstZ ?? [0, 1]) as number[];
    const sd = (j.srcDepth ?? 1) as number;
    const dst3d = tex.dimension === '3d';
    const slices = dst3d ? [...Array(Math.abs(dz1 - dz0)).keys()].map((i) => Math.min(dz0, dz1) + i) : [j.dstLayer as number];
    for (const slice of slices) {
      const at = dst3d ? slice : dz0;
      const w = (sz0 + ((at + 0.5 - dz0) / ((dz1 - dz0) || 1)) * (sz1 - sz0)) / sd;
      const u = this.staging(48, (m) => new Float32Array(m).set([sx0 / sw, sy0 / sh, (sx1 - sx0) / sw, (sy1 - sy0) / sh, dx0 > dx1 ? 1 : 0, dy0 > dy1 ? 1 : 0, 0, 0, w, 0, 0, 0]));
      const uniform = this.device!.createBuffer({ size: 48, usage: UNIFORM | COPY_DST });
      enc.copyBufferToBuffer(u, 0, uniform, 0, 48);
      this.temps.push(uniform);
      const entries: GPUBindGroupEntry[] = [{ binding: 0, resource: { buffer: uniform } }, { binding: 1, resource: this.viewOf(j.src, j.srcMip, j.srcLayer) }];
      if (linear) entries.push({ binding: 2, resource: this.sampler() });
      const group = this.device!.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries });
      const pass = enc.beginRenderPass({ colorAttachments: [{ ...this.attachment(j.dst, j.dstMip, slice), loadOp: 'load', storeOp: 'store' }] });
      const x = Math.min(dx0, dx1), y = Math.min(dy0, dy1);
      pass.setViewport(x, y, Math.abs(dx1 - dx0), Math.abs(dy1 - dy0), 0, 1);
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, group);
      pass.draw(3);
      pass.end();
    }
  }

  /**
   * A multisampled depth or stencil attachment's SAMPLE_ZERO resolve (WebGPU resolves colour only): a draw that writes
   * each pixel's sample 0 as its depth (`frag_depth`), or, for stencil, which a shader can't write, the value cleared
   * to 0 and then each bit set by a draw of its own (the bit's write mask, a reference of all ones) that keeps only the
   * pixels whose sample 0 has it.
   */
  private resolveDepth(j: Json) {
    const src = j.src as GPUTexture, dst = j.dst as GPUTexture;
    const fmt = dst.format, stencil = j.aspect === 'stencil';
    if (!(src.usage & TEXTURE_BINDING) || src.sampleCount < 2) {
      this.warn(`a ${j.aspect} resolve of ${src.format} that can't be read: skipped`);
      return;
    }
    const layout = (code: string, targetMask: number, bit = -1) => {
      const key = `rdepth:${fmt}:${stencil}:${bit}`;
      let pipeline = this.metaPipelines.get(key);
      if (!pipeline) {
        const m = this.device!.createShaderModule({ code });
        const hasStencil = /stencil/.test(fmt), hasDepth = /depth/.test(fmt);
        const face: GPUStencilFaceState = { compare: 'always', passOp: stencil ? 'replace' : 'keep' };
        pipeline = this.device!.createRenderPipeline({
          layout: 'auto', vertex: { module: m, entryPoint: 'vs' }, fragment: { module: m, entryPoint: 'fs', targets: [] },
          primitive: { topology: 'triangle-list' },
          depthStencil: { format: fmt, ...(hasDepth ? { depthWriteEnabled: !stencil, depthCompare: 'always' as GPUCompareFunction } : {}),
            ...(hasStencil ? { stencilFront: face, stencilBack: face, stencilWriteMask: targetMask } : {}) },
        });
        this.metaPipelines.set(key, pipeline);
      }
      return pipeline;
    };
    const vs = `@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4<f32> {
  let q = vec2<f32>(f32((i << 1u) & 2u), f32(i & 2u));
  return vec4<f32>(q.x * 2.0 - 1.0, 1.0 - q.y * 2.0, 0.0, 1.0);
}`;
    const view = src.createView({ dimension: '2d', aspect: stencil ? 'stencil-only' : 'depth-only', baseMipLevel: j.srcMip, mipLevelCount: 1, baseArrayLayer: j.srcLayer, arrayLayerCount: 1 });
    const ds: GPURenderPassDepthStencilAttachment = { view: this.viewOf(dst, j.dstMip, j.dstLayer) };
    if (/depth/.test(fmt)) Object.assign(ds, { depthLoadOp: 'load', depthStoreOp: 'store' });
    if (/stencil/.test(fmt)) Object.assign(ds, stencil ? { stencilLoadOp: 'clear', stencilStoreOp: 'store', stencilClearValue: 0 } : { stencilLoadOp: 'load', stencilStoreOp: 'store' });
    const pass = this.enc!.beginRenderPass({ colorAttachments: [], depthStencilAttachment: ds });
    const draws = stencil ? [0, 1, 2, 3, 4, 5, 6, 7] : [-1];
    for (const bit of draws) {
      const pipeline = bit < 0
        ? layout(`@group(0) @binding(0) var t: texture_depth_multisampled_2d;
${vs}
@fragment fn fs(@builtin(position) p: vec4<f32>) -> @builtin(frag_depth) f32 { return textureLoad(t, vec2<i32>(p.xy), 0); }`, 0)
        : layout(`@group(0) @binding(0) var t: texture_multisampled_2d<u32>;
${vs}
@fragment fn fs(@builtin(position) p: vec4<f32>) { if ((textureLoad(t, vec2<i32>(p.xy), 0).x & ${1 << bit}u) == 0u) { discard; } }`, 1 << bit, bit);
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, this.device!.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: view }] }));
      if (stencil) pass.setStencilReference(0xff);
      pass.draw(3);
    }
    pass.end();
  }

  /** A clear of a colour format WebGPU can't render to: its texel encoded (`encodeTexel`) into rows copied into the
   * level (a 3D texture's every slice). */
  private clearByCopy(tex: GPUTexture, mip: number, layer: number, fmt: string, color: number[]) {
    const texel = encodeTexel(fmt, color);
    if (!texel) {
      this.warn(`a clear of ${fmt}, which WebGPU can't render to: skipped`);
      return;
    }
    const w = Math.max(1, tex.width >> mip), h = Math.max(1, tex.height >> mip);
    const depth = tex.dimension === '3d' ? Math.max(1, tex.depthOrArrayLayers >> mip) : 1;
    const bpr = Math.ceil((w * texel.length) / 256) * 256;
    const t = this.staging(bpr * h * depth, (m) => {
      const b = new Uint8Array(m);
      for (let r = 0; r < h * depth; r++) for (let x = 0; x < w; x++) b.set(texel, r * bpr + x * texel.length);
    });
    this.enc!.copyBufferToTexture({ buffer: t, bytesPerRow: bpr, rowsPerImage: h }, { texture: tex, mipLevel: mip, origin: { x: 0, y: 0, z: tex.dimension === '3d' ? 0 : layer } }, { width: w, height: h, depthOrArrayLayers: depth });
  }

  /**
   * `vkCmdCopyBuffer` at offsets or a size WebGPU can't copy (not 4-aligned): the source's words copied whole into a
   * temporary buffer, then a compute pass that writes each destination word the copy touches, keeping its bytes outside
   * the copy. On the GPU, in the encoder's order: the source's bytes are what earlier commands wrote.
   */
  private copyUnaligned(src: GPUBuffer, so: number, dst: GPUBuffer, dO: number, size: number) {
    const d = this.device!, enc = this.enc!;
    let pipeline = this.metaComputes.get('copy');
    if (!pipeline) {
      const code = `struct P { src: u32, dst: u32, size: u32, pad: u32 }
@group(0) @binding(0) var<storage, read> s: array<u32>;
@group(0) @binding(1) var<storage, read_write> d: array<u32>;
@group(0) @binding(2) var<uniform> p: P;
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id: vec3<u32>, @builtin(num_workgroups) n: vec3<u32>) {
  let last = (p.dst + p.size + 3u) >> 2u;
  for (var w = (p.dst >> 2u) + id.x; w < last; w += n.x * 64u) {
    var v = d[w];
    for (var b = 0u; b < 4u; b++) {
      let a = w * 4u + b;
      if (a >= p.dst && a < p.dst + p.size) {
        let i = a - p.dst + p.src;
        let byte = (s[i >> 2u] >> ((i & 3u) * 8u)) & 0xffu;
        v = (v & ~(0xffu << (b * 8u))) | (byte << (b * 8u));
      }
    }
    d[w] = v;
  }
}`;
      const m = d.createShaderModule({ code });
      pipeline = d.createComputePipeline({ layout: 'auto', compute: { module: m, entryPoint: 'main' } });
      this.metaComputes.set('copy', pipeline);
    }
    // In pieces, so that each binding stays well under the device's limits.
    const PIECE = 1 << 24;
    for (let done = 0; done < size; done += PIECE) {
      const n = Math.min(PIECE, size - done), s0 = so + done, d0 = dO + done;
      const from = s0 & ~3, words = ((s0 + n + 3) & ~3) - from;
      const temp = d.createBuffer({ size: words, usage: STORAGE | COPY_DST });
      this.temps.push(temp);
      enc.copyBufferToBuffer(src, from, temp, 0, words);
      // The destination's binding from a 256-aligned offset (minStorageBufferOffsetAlignment is at most 256).
      const at = d0 & ~255, end = (d0 + n + 3) & ~3;
      const u = d.createBuffer({ size: 16, usage: UNIFORM, mappedAtCreation: true });
      new Uint32Array(u.getMappedRange()).set([s0 & 3, d0 - at, n, 0]);
      u.unmap();
      this.temps.push(u);
      const group = d.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [
        { binding: 0, resource: { buffer: temp } },
        { binding: 1, resource: { buffer: dst, offset: at, size: end - at } },
        { binding: 2, resource: { buffer: u } },
      ] });
      const pass = enc.beginComputePass();
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, group);
      pass.dispatchWorkgroups(Math.min(Math.ceil(((end - (d0 & ~3)) >> 2) / 64), 65535));
      pass.end();
    }
  }

  private linearSampler: GPUSampler | undefined;
  private sampler() {
    return (this.linearSampler ??= this.device!.createSampler({ magFilter: 'linear', minFilter: 'linear' }));
  }

  /** Rectangles of the current render pass's attachments cleared: a draw with the clear values (the pass's state is the driver's to set again). */
  private clearRects(j: Json) {
    const atts = this.passAtts;
    const pass = this.pass as GPURenderPassEncoder | undefined;
    if (!atts || !pass) return;
    const colors = new Map<number, number[]>((j.colors as number[][]).map((c) => [c[0], c.slice(1)]));
    const depth = j.depth as number | undefined, stencil = j.stencil as number | undefined;
    const key = `clear:${atts.colors.join(',')}:${atts.depth}:${atts.samples}:${[...colors.keys()].join(',')}:${depth !== undefined}:${stencil !== undefined}`;
    let pipeline = this.metaPipelines.get(key);
    if (!pipeline) {
      const outs = atts.colors.map((f, i) => f && colors.has(i) ? `@location(${i}) c${i}: vec4<${sampleKind(f)}>` : '').filter(Boolean);
      const sets = atts.colors.map((f, i) => f && colors.has(i) ? `o.c${i} = ${sampleKind(f) === 'f32' ? `bitcast<vec4<f32>>(u.c[${i}])` : sampleKind(f) === 'i32' ? `bitcast<vec4<i32>>(u.c[${i}])` : `u.c[${i}]`};` : '').filter(Boolean);
      const code = `struct U { c: array<vec4<u32>, 8>, d: vec4<f32> }
@group(0) @binding(0) var<uniform> u: U;
@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4<f32> {
  let q = vec2<f32>(f32((i << 1u) & 2u), f32(i & 2u));
  return vec4<f32>(q.x * 2.0 - 1.0, 1.0 - q.y * 2.0, u.d.x, 1.0);
}
${outs.length ? `struct O { ${outs.join(', ')} }
@fragment fn fs() -> O { var o: O; ${sets.join(' ')} return o; }` : '@fragment fn fs() {}'}`;
      const m = this.device!.createShaderModule({ code });
      const hasStencil = !!atts.depth && /stencil/.test(atts.depth), hasDepth = !!atts.depth && /depth/.test(atts.depth);
      const desc: GPURenderPipelineDescriptor = {
        layout: 'auto', vertex: { module: m, entryPoint: 'vs' }, primitive: { topology: 'triangle-list' },
        fragment: { module: m, entryPoint: 'fs', targets: atts.colors.map((f, i) => f ? { format: f, writeMask: colors.has(i) ? 0xf : 0 } : null) },
        multisample: { count: atts.samples },
      };
      if (atts.depth) {
        const face: GPUStencilFaceState = { compare: 'always', passOp: stencil !== undefined ? 'replace' : 'keep' };
        desc.depthStencil = { format: atts.depth, ...(hasDepth ? { depthWriteEnabled: depth !== undefined, depthCompare: 'always' as GPUCompareFunction } : {}),
          ...(hasStencil ? { stencilFront: face, stencilBack: face, stencilWriteMask: stencil !== undefined ? 0xff : 0 } : {}) };
      }
      pipeline = this.device!.createRenderPipeline(desc);
      this.metaPipelines.set(key, pipeline);
    }
    const data = new ArrayBuffer(144);
    const u32 = new Uint32Array(data), f32 = new Float32Array(data), i32 = new Int32Array(data);
    for (const [i, c] of colors) {
      const k = atts.colors[i] ? sampleKind(atts.colors[i]!) : 'f32';
      for (let n = 0; n < 4; n++) {
        if (k === 'f32') f32[i * 4 + n] = c[n];
        else if (k === 'i32') i32[i * 4 + n] = c[n];
        else u32[i * 4 + n] = c[n];
      }
    }
    f32[32] = depth ?? 0;
    const uniform = this.device!.createBuffer({ size: 144, usage: UNIFORM, mappedAtCreation: true });
    new Uint8Array(uniform.getMappedRange()).set(new Uint8Array(data));
    uniform.unmap();
    this.temps.push(uniform);
    const group = this.device!.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: uniform } }] });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, group);
    pass.setViewport(0, 0, atts.width, atts.height, 0, 1);
    if (stencil !== undefined) pass.setStencilReference(stencil);
    for (const [x, y, w, h] of j.rects as number[][]) {
      const x0 = Math.max(0, Math.min(x, atts.width)), y0 = Math.max(0, Math.min(y, atts.height));
      const x1 = Math.max(x0, Math.min(x + w, atts.width)), y1 = Math.max(y0, Math.min(y + h, atts.height));
      if (x1 === x0 || y1 === y0) continue;
      pass.setScissorRect(x0, y0, x1 - x0, y1 - y0);
      pass.draw(3);
    }
  }
}

/** The driver's JSON, whose numbers are C's %g: NaN and infinities come as `nan` and `inf` (a clear value may be
 * either), which JSON lacks and WebGPU's colours don't take. */
function parseJson(text: string): Json {
  if (!/nan|inf/i.test(text)) return JSON.parse(text);
  // WebGPU's colours are finite doubles: NaN as 0, infinities as f32's largest.
  return JSON.parse(text.replace(/-?\bnan\b/gi, '0').replace(/(-?)\binf\b/gi, '$13.4028234663852886e38'));
}

/** A clear colour as one texel of a colour format WebGPU can't render to (the snorm8 ones, rgb9e5ufloat,
 * rg11b10ufloat), or undefined for another. */
export function encodeTexel(fmt: string, c: number[]): Uint8Array | undefined {
  const snorm = { r8snorm: 1, rg8snorm: 2, rgba8snorm: 4 }[fmt];
  if (snorm) return Uint8Array.from(c.slice(0, snorm), (v) => Math.round(Math.min(1, Math.max(-1, v || 0)) * 127) & 255);
  const out = new Uint8Array(4), dv = new DataView(out.buffer);
  if (fmt === 'rgb9e5ufloat') {
    // Vulkan's (and GL's) shared-exponent encoding: 9-bit mantissas, a 5-bit exponent biased by 15.
    const max = ((511 / 512) * 2 ** 16);
    const [r, g, b] = c.slice(0, 3).map((v) => Math.min(max, Math.max(0, v || 0)));
    const m = Math.max(r, g, b);
    let e = Math.max(-16, Math.floor(Math.log2(m))) + 16;
    if (Math.floor(m / 2 ** (e - 24) + 0.5) === 512) e++;
    const q = (v: number) => Math.floor(v / 2 ** (e - 24) + 0.5);
    dv.setUint32(0, (q(r) | (q(g) << 9) | (q(b) << 18) | (e << 27)) >>> 0, true);
    return out;
  }
  if (fmt === 'rg11b10ufloat') {
    // Unsigned floats: a 5-bit exponent biased by 15 and `bits` of mantissa, rounded to nearest.
    const uf = (v: number, bits: number) => {
      if (Number.isNaN(v)) return (31 << bits) | 1;
      if (!(v > 0)) return 0;
      let e = Math.max(-14, Math.floor(Math.log2(v)));
      let m = Math.round((v / 2 ** e) * 2 ** bits);
      if (m >= 2 ** (bits + 1)) { e++; m = Math.round((v / 2 ** e) * 2 ** bits); }
      if (e > 15) return (30 << bits) | (2 ** bits - 1);
      return m < 2 ** bits ? m : ((e + 15) << bits) | (m - 2 ** bits);
    };
    dv.setUint32(0, (uf(c[0], 6) | (uf(c[1], 6) << 11) | (uf(c[2], 5) << 22)) >>> 0, true);
    return out;
  }
  return undefined;
}

/** A texture format's WGSL sample type. */
function sampleKind(f: string): 'f32' | 'u32' | 'i32' {
  return /uint$/.test(f) ? 'u32' : /sint$/.test(f) ? 'i32' : 'f32';
}

/** Every import, for the deviceless stubs. */
const IMPORTS = ['gpu_create', 'gpu_shader', 'gpu_destroy', 'gpu_write', 'gpu_dirty', 'gpu_encoder', 'gpu_copy_bb', 'gpu_copy_bt', 'gpu_copy_tb', 'gpu_copy_tt', 'gpu_fill',
  'gpu_update', 'gpu_blit', 'gpu_render_pass', 'gpu_compute_pass', 'gpu_pass_end', 'gpu_set_pipeline', 'gpu_set_bind_group', 'gpu_set_vertex_buffer',
  'gpu_set_index_buffer', 'gpu_set_viewport', 'gpu_set_scissor', 'gpu_set_blend_constant', 'gpu_set_stencil_reference', 'gpu_set_immediates', 'gpu_draw',
  'gpu_draw_indexed', 'gpu_draw_indirect', 'gpu_dispatch', 'gpu_dispatch_indirect', 'gpu_clear_rects', 'gpu_begin_occlusion', 'gpu_end_occlusion',
  'gpu_resolve_queries', 'gpu_readback', 'gpu_submit', 'gpu_readback_copy', 'gpu_texture_import', 'gpu_translated', 'gpu_cache_get', 'gpu_cache_read', 'gpu_cache_put'];
