// The Vulkan driver's "hardware" (vk/driver/wg_gpu.h; vk/README.md "The driver"): the renderer module's `wg` imports,
// implemented on the GPU worker's WebGPU device. The driver names every object by an id it assigns, describes the
// rarely made ones as JSON (ids for the objects they refer to) and replays each submit's commands as calls with plain
// numbers into one command encoder. What it can't express as a WebGPU command — blits, resolves, image clears and
// clears of a pass's attachments — is drawn here (`meta`, `clearRects`). A submit completes once its work is done and
// the staging buffers of its readbacks are mapped: then `complete(serial)` calls back into the module, in submit order.
// Without a device (Node's tests) objects are only counted and every submit completes at once.

import type { ShaderCache } from './venus-cache.ts';

/** GPUBufferUsage's and GPUMapMode's values (the worker may lack the globals in Node). */
const INDEX = 16, INDIRECT = 256, COPY_SRC = 4, COPY_DST = 8, TEX_COPY_SRC = 1, TEX_COPY_DST = 2, TEXTURE_BINDING = 4, UNIFORM = 64, STORAGE = 128, RENDER_ATTACHMENT = 16, MAP_READ = 1, MAP_MODE_READ = 1;

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
  /** Render pipelines the driver made at vkCreateGraphicsPipelines (VK4 T17: `premade` in their JSON), and those of them a draw set. */
  premade: number; premadeUsed: number;
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
export type GpuCaps = { readonly features: ReadonlySet<string>; readonly limits: object; readonly adapterInfo?: { readonly vendor: string; readonly subgroupMinSize?: number; readonly subgroupMaxSize?: number } };

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
 * Bit 14 is storage for texture-formats-tier1's formats, on every adapter (without the feature they go by their words:
 * vk/README.md "Storage images as words") unless held (`tier1-storage`);
 * `MORE_FEATURES` follow it from bit 15 (the translator's: VK3 L5).
 * `hold` names features the driver doesn't take, as if the adapter lacked them (`HELD_FEATURES` with `?gpu=vkformats=held`; `?gpu=vkhold=<name>`).
 */
const FEATURES = ['texture-compression-bc', 'texture-compression-etc2', 'texture-compression-astc', 'depth32float-stencil8', 'float32-filterable',
  'depth-clip-control', 'dual-source-blending', 'clip-distances', 'indirect-first-instance', 'texture-formats-tier1', 'texture-formats-tier2',
  'rg11b10ufloat-renderable', 'float32-blendable', 'bgra8unorm-storage'];
const MORE_FEATURES = ['subgroups', 'shader-f16', 'texture-component-swizzle'];
export function gpuFeatures(caps: GpuCaps | undefined, device: boolean, hold: readonly string[] = []) {
  let flags = device ? 1 << 31 : 0;
  const has = (f: string) => !!caps?.features.has(f) && !hold.includes(f);
  FEATURES.forEach((f, i) => { if (has(f)) flags |= 1 << i; });
  if (caps && !hold.includes('tier1-storage')) flags |= 1 << FEATURES.length;
  MORE_FEATURES.forEach((f, i) => { if (has(f)) flags |= 1 << (FEATURES.length + 1 + i); });
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
  ['maxStorageBuffersInVertexStage', 8], ['maxStorageTexturesInVertexStage', 4], ['maxBindingsPerBindGroup', 1000],
  // Not a limit: the maker's PCI vendor ID (`VENDORS`), 0 for one this list doesn't know.
  ['vendorID', 0],
  // Not limits: the adapter's subgroup sizes (`GPUAdapterInfo`; 0 without `subgroups`).
  ['subgroupMinSize', 0], ['subgroupMaxSize', 0],
];

/** `LIMITS`' values of `caps` as venus_init takes them (32 bits each; the defaults where it has none). */
export function gpuLimits(caps: GpuCaps | undefined) {
  const l = (caps?.limits ?? {}) as Record<string, number | undefined>;
  // Immediates only where the browser has `setImmediates`, and at most the 128 bytes of Vulkan's push constants.
  const immediates = typeof GPURenderPassEncoder !== 'undefined' && typeof (GPURenderPassEncoder.prototype as unknown as { setImmediates?: unknown }).setImmediates === 'function';
  // A stage's storage in the fragment and vertex stages: the per-stage limit where the browser predates the split.
  const fallback: Record<string, string> = { maxStorageBuffersInFragmentStage: 'maxStorageBuffersPerShaderStage', maxStorageTexturesInFragmentStage: 'maxStorageTexturesPerShaderStage', maxStorageBuffersInVertexStage: 'maxStorageBuffersPerShaderStage', maxStorageTexturesInVertexStage: 'maxStorageTexturesPerShaderStage' };
  return new Uint32Array(LIMITS.map(([k, d]) => {
    const v = k === 'maxImmediateSize' ? (immediates ? Math.min(128, l[k] ?? 0) : 0)
      : k === 'vendorID' ? VENDORS[caps?.adapterInfo?.vendor.toLowerCase() ?? ''] ?? 0
        : k === 'subgroupMinSize' || k === 'subgroupMaxSize' ? (caps?.features.has('subgroups') ? caps.adapterInfo?.[k] ?? 0 : 0)
        : l[k] ?? (fallback[k] ? l[fallback[k]] : undefined) ?? d;
    return Math.min(v, 0xffff_ffff);
  }));
}

/**
 * Whether the device's subgroup operations are right in divergent control flow, as Vulkan's must be (VK3 L5): a
 * ballot and an add in an `if` that only odd invocations take must see those alone. Chromium on the M4's Metal (153)
 * computes a ballot that is the `if`'s only subgroup operation with every invocation (hoisted out of the `if`), which
 * broke most of dEQP-VK's subgroup cases there (bench/vulkan/REPORT.md "VK3 L5"). Where this fails, the device advertises
 * subgroups of one invocation (`hold`). Run once at Venus's start; a device without `subgroups` passes untested.
 */
export async function subgroupsRight(device: GPUDevice): Promise<boolean> {
  if (!device.features.has('subgroups')) return true;
  const code = `enable subgroups;
diagnostic(off, subgroup_uniformity);
@group(0) @binding(0) var<storage, read_write> o: array<u32>;
@compute @workgroup_size(128) fn main(@builtin(subgroup_invocation_id) inv: u32, @builtin(local_invocation_index) l: u32) {
  var t: bool = true;
  var m = subgroupBallot(t);
  var n = subgroupAdd(1u);
  var b = vec4<u32>(0u);
  if ((inv & 1u) == 1u) { b = subgroupBallot(t); }
  if ((inv & 1u) == 1u) { n = subgroupAdd(1u); }
  o[l * 2u] = b.x; o[l * 2u + 1u] = n;
}`;
  try {
    const module = device.createShaderModule({ code });
    const pipeline = await device.createComputePipelineAsync({ layout: 'auto', compute: { module, entryPoint: 'main' } });
    const buf = device.createBuffer({ size: 128 * 8, usage: 0x80 | 0x4 /* STORAGE | COPY_SRC */ });
    const read = device.createBuffer({ size: 128 * 8, usage: 0x1 | 0x8 /* MAP_READ | COPY_DST */ });
    const enc = device.createCommandEncoder();
    const pass = enc.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: buf } }] }));
    pass.dispatchWorkgroups(1);
    pass.end();
    enc.copyBufferToBuffer(buf, 0, read, 0, 128 * 8);
    device.queue.submit([enc.finish()]);
    await read.mapAsync(1 /* GPUMapMode.READ */);
    const o = new Uint32Array(read.getMappedRange().slice(0));
    read.destroy();
    buf.destroy();
    for (let l = 0; l < 128; l++) {
      const m = o[2 * l], n = o[2 * l + 1];
      // An odd invocation's ballot has odd invocations only (the first 32 of its subgroup), and its add counts them.
      if (l & 1 && (m === 0 || (m & 0x55555555) !== 0 || n === 0 || n > 64)) return false;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * VK3 L9a's suspects for Venus's submits done ~2 ms later on NVIDIA at c8087cb0 than at 4fdc69fb (bench/vulkan/REPORT.md
 * "VK3 L9a"), each switchable back to 4fdc69fb's behaviour by `?gpu=vkl9=<suspect>` (repeatable; `all` for every one) for
 * the NVIDIA run's arms (bench/vulkan/nvidia.sh `l9`); none by default. `features`: the device without `MORE_FEATURES`
 * (no subgroups, no shader-f16, so no subgroups check); `limits`: without `L9_LIMITS`; `bindgroups`: each pipeline's
 * bind group layouts their own uids again (VK3 L6b shared them by content); `pad`: memories' GPUBuffers without
 * WG_MEMORY_PAD (VK3 L7a). Diagnostic only: `limits` and `pad` can refuse or lose what L7a made fit.
 */
export const L9_SUSPECTS = ['features', 'limits', 'bindgroups', 'pad'] as const;
export type L9Suspect = (typeof L9_SUSPECTS)[number];
/** The limits asked for since 4fdc69fb (VK3 L7a). */
export const L9_LIMITS = ['maxStorageBuffersInVertexStage', 'maxStorageTexturesInVertexStage', 'maxBindingsPerBindGroup'];
/** `?gpu=vkl9=…`'s values as suspects (`all` is every one; unknown names dropped). */
export function l9Suspects(values: readonly string[]): L9Suspect[] {
  return L9_SUSPECTS.filter((s) => values.includes(s) || values.includes('all'));
}

/** The features and limits to ask an adapter's device for: every one the driver uses, as far as the adapter goes. */
export function deviceRequest(adapter: GPUAdapter, options: { gpuTime?: boolean; l9?: readonly L9Suspect[] } = {}): GPUDeviceDescriptor {
  const limits = adapter.limits as unknown as Record<string, number>;
  const requiredLimits: Record<string, number> = {};
  // The adapter's maker and subgroup sizes aren't limits (a browser that still lists subgroup sizes among its limits
  // refuses them asked for).
  const notLimits = ['vendorID', 'subgroupMinSize', 'subgroupMaxSize', ...(options.l9?.includes('limits') ? L9_LIMITS : [])];
  for (const [k] of LIMITS) if (!notLimits.includes(k) && typeof limits[k] === 'number') requiredLimits[k] = limits[k];
  // Vulkan has no limit on a pass's attachments' bytes a sample: ask for the most.
  if (typeof limits.maxColorAttachmentBytesPerSample === 'number') requiredLimits.maxColorAttachmentBytesPerSample = limits.maxColorAttachmentBytesPerSample;
  const features = [...FEATURES, ...(options.l9?.includes('features') ? [] : MORE_FEATURES)].filter((f) => adapter.features.has(f)) as GPUFeatureName[];
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
  readonly stats: VenusGpuStats = { submits: 0, uploads: 0, uploadBytes: 0, readbacks: 0, readbackBytes: 0, pipelines: 0, pipelineMs: 0, bindGroups: 0, errors: 0, dirtyPages: 0, done: 0, doneMs: 0, doneMaxMs: 0, orderMs: 0, nudges: 0, pipelinesReady: 0, pipelineReadyMs: 0, deferred: 0, deferredMs: 0, syncPipelines: 0, premade: 0, premadeUsed: 0, translations: 0, translateMs: 0, cacheHits: 0, cacheMisses: 0, cacheStores: 0, encodeMs: 0, submitCallMs: 0, passes: 0, draws: 0, gpuTimed: 0, gpuMs: 0, workDone: 0, workDoneMs: 0 };
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
  private temps: (GPUBuffer | GPUTexture)[] = [];
  private readonly slots = new Map<number, { buffer: GPUBuffer; size: number }>();
  private submitSlots: number[] = [];
  private nextSlot = 1;
  private chain: Promise<void> = Promise.resolve();
  private readonly metaPipelines = new Map<string, GPURenderPipeline>();
  private readonly metaComputes = new Map<string, GPUComputePipeline>();
  /** The render pass's draws through indices of their own (`gpu_provoke`), by ticket; and the scratch buffers they and
   * their parameters take places in, from the start at each encoder (the queue's order keeps an earlier submit's reads
   * of a place before a later one's writes). */
  private readonly tickets: ({ buffer: GPUBuffer; offset: number; size: number; args?: GPUBuffer; argsAt?: number } | undefined)[] = [];
  private readonly scratches = new Map<number, { buffer: GPUBuffer; at: number }>();
  private dummyStorage: GPUBuffer | undefined;
  private dummyWrite: GPUBuffer | undefined;
  /** Textures of packed formats (wg_format.c `WG_FMT_PACKED`): each of R, G, B, A's shift and bits. */
  private readonly packed = new WeakMap<GPUTexture, number[]>();
  /** Transform feedback (VK3 L7.4): a vertex module's WGSL where it captures (`wg_xo`), each render pipeline's capture
   * (its JSON's `xfb`, by id), what the render pass last set (a captured draw runs on it), and the pass's captures,
   * run as compute once it ends (`runXfb`). */
  private readonly vertexCode = new WeakMap<GPUShaderModule, string>();
  /** Modules of a vertex stage with bindings pulled (`pulledCode`), by the stage and its buffers. */
  private readonly pulledModules = new WeakMap<GPUShaderModule, Map<string, GPUShaderModule>>();
  private readonly xfbByPipeline: (Xfb | undefined)[] = [];
  private cur: { xfb?: Xfb; groups: ({ g: GPUBindGroup; offsets: number[] } | undefined)[]; vb: ({ b: GPUBuffer; offset: number; size: number } | undefined)[]; imm?: Uint8Array } = { groups: [], vb: [] };
  private xfbJobs: Json[] = [];
  private readonly metaModules = new Map<string, GPUShaderModule>();
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
  private recTemps: (GPUBuffer | GPUTexture)[] = [];
  /** Submits (and the queue work after them) held until their pipelines are ready, in order (`drain`). */
  private readonly held: Batch[] = [];
  private draining = false;
  private readonly idleWaiters: (() => void)[] = [];
  private readonly seen = new Set<string>();
  private readonly mem: () => ArrayBuffer;
  /** The submit (its count in `stats.submits`) that last wrote each texture, and those the open encoder writes; also
   * buffers written by a transfer (copies, fills, updates: Mesa's prime blit copies each frame into one it exports,
   * web/venus-share.ts), not by a shader's storage writes. */
  private readonly written = new WeakMap<GPUTexture | GPUBuffer, number>();
  private touched = new Set<GPUTexture | GPUBuffer>();
  /** A texture's bytes are another renderer's resource's from now on (`res`; 0: no longer): web/venus-import.ts, called at the bind (it
   * writes textures in the queue's order itself). `desc` is what the texture was made with; what it returns, the resource's own texture
   * (kept while the resource lives), takes the image's place under its id (VK4 T16). */
  onImport: ((texture: GPUTexture, res: number, desc: GPUTextureDescriptor | undefined) => GPUTexture | undefined) | undefined;
  /** Render pipelines made at vkCreateGraphicsPipelines that no draw has set yet (`stats.premade`). */
  private readonly unusedPremade = new WeakSet<object>();
  /** Each texture that may be imported into (single-sampled, `COPY_DST`): what it was made with. */
  private readonly descs = new WeakMap<GPUTexture, GPUTextureDescriptor>();
  /** Resources' textures put in images' places by `onImport`: web/venus-import.ts destroys them, not an image's end. */
  private readonly borrowed = new WeakSet<GPUTexture>();
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

  /** A buffer by its id, with the submit whose transfer last wrote it (0: none yet): web/venus-share.ts reads a prime blit's. */
  buffer(id: number): { buffer: GPUBuffer; written: number } | undefined {
    const b = this.objs[id];
    return b instanceof GPUBuffer ? { buffer: b, written: this.written.get(b) ?? 0 } : undefined;
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
        if (code.includes('var<private> wg_xo') || code.includes(PULLED_ENTRY)) self.vertexCode.set(m, code);
        void m.getCompilationInfo().then((info) => {
          const errors = info.messages.filter((x) => x.type === 'error');
          if (errors.length) self.warn(`a shader didn't compile: ${errors.map((x) => `${x.lineNum}:${x.linePos} ${x.message}`).join('; ')}\n${code.split('\n').slice(0, 400).join('\n')}`);
        });
      },
      gpu_destroy(id: number) {
        const o = self.objs[id];
        self.objs[id] = undefined;
        if (o instanceof GPUTexture && self.borrowed.has(o)) return;
        if (o instanceof GPUBuffer || o instanceof GPUTexture || o instanceof GPUQuerySet || o instanceof MsLayers) later(() => o.destroy());
      },
      gpu_grow(id: number, size: number) {
        const old = buf(id);
        const b = d.createBuffer({ size, usage: old.usage });
        self.objs[id] = b;
        later(() => {
          const e = d.createCommandEncoder();
          e.copyBufferToBuffer(old, 0, b, 0, old.size);
          d.queue.submit([e.finish()]);
          old.destroy();
        });
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
        if (!(t instanceof GPUTexture)) return;
        // web/venus-import.ts writes textures in the queue's order (`later`). The resource's own texture, if it gives one,
        // is the image's from now on (no command can have named the image's before its memory was bound).
        const own = self.onImport?.(t, res, self.descs.get(t));
        if (own && own !== t) {
          self.objs[tex] = own;
          self.borrowed.add(own);
          later(() => t.destroy());
        }
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
          for (const s of self.scratches.values()) s.at = 0;
          if (self.gpuTime) self.timing = self.timings.pop() ?? new Timing(d);
        });
      },
      gpu_copy_bb(src: number, so: number, dst: number, dO: number, size: number) {
        if (!size) return;
        const a = buf(src), b = buf(dst);
        // WebGPU copies 4-aligned offsets and sizes; Vulkan any (VK3 L4c-F): the others by a compute pass.
        later(() => self.touched.add(b));
        if ((so | dO | size) & 3) later(() => self.copyUnaligned(a, so, b, dO, size));
        else if (a === b) later(() => self.copyWithin(a, so, dO, size));
        else later(() => self.enc!.copyBufferToBuffer(a, so, b, dO, size));
      },
      gpu_copy_bt(b: number, offset: number, bpr: number, rows: number, tex: number, mip: number, x: number, y: number, z: number, w: number, h: number, depth: number, aspect: number) {
        const B = buf(b), T = self.get<GPUTexture>(tex);
        later(() => {
          self.touched.add(T);
          if (aspect) return self.depthStencilCopy(true, B, offset, bpr, rows, T, mip, x, y, z, w, h, depth, aspect);
          const p = self.packed.get(T);
          if (p) return self.unpack(p, B, offset, bpr, rows || h, T, mip, x, y, z, w, h, depth);
          self.enc!.copyBufferToTexture(self.layout(B, offset, bpr, rows, h, depth), self.texCopy(T, mip, x, y, z, aspect), { width: w, height: h, depthOrArrayLayers: depth });
        });
      },
      gpu_copy_tb(b: number, offset: number, bpr: number, rows: number, tex: number, mip: number, x: number, y: number, z: number, w: number, h: number, depth: number, aspect: number) {
        const B = buf(b), T = self.get<GPUTexture>(tex);
        later(() => {
          self.touched.add(B);
          if (aspect) return self.depthStencilCopy(false, B, offset, bpr, rows, T, mip, x, y, z, w, h, depth, aspect);
          const p = self.packed.get(T);
          if (p) return self.pack(p, B, offset, bpr, rows || h, T, mip, x, y, z, w, h, depth);
          self.enc!.copyTextureToBuffer(self.texCopy(T, mip, x, y, z, aspect), self.layout(B, offset, bpr, rows, h, depth), { width: w, height: h, depthOrArrayLayers: depth });
        });
      },
      gpu_copy_tt(src: number, sm: number, sx: number, sy: number, sz: number, dst: number, dm: number, dx: number, dy: number, dz: number, w: number, h: number, depth: number, aspect: number, dw: number, dh: number, cols: number, rows: number, bytes: number) {
        const S = self.get<GPUTexture>(src), D = self.get<GPUTexture>(dst);
        later(() => {
          self.touched.add(D);
          const ps = self.packed.get(S), pd = self.packed.get(D);
          if ((ps || pd) && ps?.join() !== pd?.join() && S.sampleCount === 1) return self.copyPacked(ps, S, sm, sx, sy, sz, pd, D, dm, dx, dy, dz, w, h, depth);
          if (S.sampleCount > 1) {
            for (let l = 0; l < depth; l++) self.copyMultisampled(S, sm, sx, sy, sz + l, D, dm, dx, dy, dz + l, w, h, aspect);
            return;
          }
          if (/^depth|^stencil/.test(S.format) && !self.depthStencilTT(S, sm, sx, sy, sz, D, dm, dx, dy, dz, w, h, depth, aspect)) return;
          if (S.format.replace('-srgb', '') !== D.format.replace('-srgb', '')) return self.copyBetweenFormats(S, sm, sx, sy, sz, D, dm, dx, dy, dz, w, h, depth, dw, dh, cols, rows, bytes);
          if (S === D && sm === dm && (S.dimension === '3d' || (sz < dz + depth && dz < sz + depth))) return self.copyTextureWithin(S, sm, sx, sy, sz, dx, dy, dz, w, h, depth, aspect);
          self.enc!.copyTextureToTexture(self.texCopy(S, sm, sx, sy, sz, aspect), self.texCopy(D, dm, dx, dy, dz, aspect), { width: w, height: h, depthOrArrayLayers: depth });
        });
      },
      gpu_fill(b: number, offset: number, size: number, value: number) {
        if (!size) return;
        const B = buf(b);
        later(() => self.touched.add(B));
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
        // A pass in parts (wg_cmd.c `begin_pass`): each part stores, the later ones load.
        const keepOps = j.keep ? { storeOp: 'store', ...(j.keep === 2 ? { loadOp: 'load' } : {}) } : {};
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
            return { ...a, ...keepOps, view: v.view, resolveTarget: a.resolveTarget ? self.get<View>(a.resolveTarget).view : undefined } as GPURenderPassColorAttachment;
          }),
        };
        let depth: GPUTextureFormat | undefined;
        if (j.depthStencilAttachment) {
          const v = self.get<View>(j.depthStencilAttachment.view);
          depth = v.format;
          samples = v.samples;
          const ds = { ...j.depthStencilAttachment, view: v.view };
          if (j.keep) for (const k of ['depth', 'stencil']) if (ds[`${k}StoreOp`]) {
            ds[`${k}StoreOp`] = 'store';
            if (j.keep === 2) ds[`${k}LoadOp`] = 'load';
          }
          desc.depthStencilAttachment = ds;
        }
        if (j.occlusionQuerySet) desc.occlusionQuerySet = self.get<GPUQuerySet>(j.occlusionQuerySet);
        const atts = { colors, depth, samples, width: j.width as number, height: j.height as number };
        self.stats.passes++;
        later(() => {
          for (const t of textures) self.touched.add(t);
          self.passAtts = atts;
          self.cur = { groups: [], vb: [] };
          // A later part of a Vulkan pass goes on with its capture.
          if (j.keep !== 2) self.flushXfb();
          self.pass = self.enc!.beginRenderPass(self.timed(desc));
          self.encPasses++;
        });
      },
      gpu_compute_pass() {
        self.stats.passes++;
        later(() => { self.pass = self.enc!.beginComputePass(self.timed({})); self.encPasses++; });
      },
      gpu_pass_end() { later(() => self.endPass()); },
      gpu_set_pipeline(id: number) {
        const o = self.objs[id];
        if (o && self.unusedPremade.delete(o)) self.stats.premadeUsed++;
        if (o instanceof Later && !o.value) {
          if (self.rec) {
            // Held: the submit goes once the pipeline is ready (`gpu_submit`).
            self.recWaits.push(o);
            const xfb = self.xfbByPipeline[id];
            return void self.rec.push(() => { (self.pass as GPURenderPassEncoder).setPipeline(o.value as GPURenderPipeline); self.cur.xfb = xfb; });
          }
          // Not held (it was made after this submit's encoder: the driver makes them before): made at once.
          self.stats.syncPipelines++;
          o.sync();
        }
        const p = (o instanceof Later ? o.value : o) as GPURenderPipeline;
        const xfb = self.xfbByPipeline[id];
        later(() => { (self.pass as GPURenderPassEncoder).setPipeline(p); self.cur.xfb = xfb; });
      },
      gpu_set_bind_group(index: number, id: number, ptr: number, n: number) {
        const offsets = n ? Array.from(new Uint32Array(self.mem(), ptr >>> 0, n)) : [];
        const g = self.get<GPUBindGroup>(id);
        const writes = self.groupWrites[id];
        later(() => {
          if (writes) for (const t of writes) self.touched.add(t);
          self.pass!.setBindGroup(index, g, offsets);
          self.cur.groups[index] = { g, offsets };
        });
      },
      gpu_set_vertex_buffer(slot: number, b: number, offset: number, size: number) { const B = buf(b); later(() => { rp().setVertexBuffer(slot, B, offset, size); self.cur.vb[slot] = { b: B, offset, size }; }); },
      gpu_pull_buffer(slot: number, b: number, offset: number, size: number) { const B = buf(b); later(() => { self.cur.vb[slot] = { b: B, offset, size }; }); },
      gpu_pull_bind(group: number, bgl: number, slots: number) { const layout = self.get<GPUBindGroupLayout>(bgl); later(() => self.pullBind(group, layout, slots)); },
      gpu_set_index_buffer(b: number, wide: number, offset: number, size: number) { const B = buf(b); later(() => rp().setIndexBuffer(B, wide ? 'uint32' : 'uint16', offset, size)); },
      gpu_set_viewport(x: number, y: number, w: number, h: number, min: number, max: number) { later(() => rp().setViewport(x, y, w, h, min, max)); },
      gpu_set_scissor(x: number, y: number, w: number, h: number) { later(() => rp().setScissorRect(x, y, w, h)); },
      gpu_set_blend_constant(r: number, g: number, b: number, a: number) { later(() => rp().setBlendConstant([r, g, b, a])); },
      gpu_set_stencil_reference(ref: number) { later(() => rp().setStencilReference(ref)); },
      gpu_set_immediates(offset: number, ptr: number, size: number) {
        const bytes = new Uint8Array(self.mem(), ptr >>> 0, size).slice();
        later(() => { (self.pass as unknown as { setImmediates(o: number, d: Uint8Array): void }).setImmediates(offset, bytes); self.cur.imm = bytes; });
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
      gpu_provoke(ticket: number, b: number, offset: number, size: number, wide: number, mode: number, restart: number, first: number, count: number, prims: number) {
        const B = b ? buf(b) : undefined;
        later(() => self.provoke(ticket, B, offset, size, wide, mode, restart, first, count, prims));
      },
      gpu_xfb(ptr: number, len: number) {
        const j = parseJson(self.text(ptr, len));
        // Its buffers now (ids are reused).
        if (j.ib) j.ib = buf(j.ib);
        if (j.indirect) j.indirect = [buf((j.indirect as number[])[0]), (j.indirect as number[])[1]];
        for (const k of ['buffers', 'counters']) if (j[k]) j[k] = (j[k] as (number[] | null)[]).map((e) => e && [buf(e[0]), ...e.slice(1)]);
        later(() => self.xfbJobs.push(j.op === 'draw' ? { ...j, xfb: self.cur.xfb, groups: [...self.cur.groups], vb: [...self.cur.vb], imm: self.cur.imm } : j));
      },
      gpu_fan_indirect(ticket: number, b: number, offset: number, ib: number, ibOffset: number, ibSize: number, wide: number, restart: number) {
        const B = buf(b), I = buf(ib);
        later(() => self.fanIndirect(ticket, B, offset, I, ibOffset, ibSize, wide, restart));
      },
      gpu_draw_ticket_indirect(ticket: number) {
        self.stats.draws++;
        later(() => {
          const t = self.tickets[ticket];
          if (!t?.args) return;
          rp().setIndexBuffer(t.buffer, 'uint32', t.offset, t.size);
          rp().drawIndexedIndirect(t.args, t.argsAt!);
        });
      },
      gpu_draw_ticket(ticket: number, inst: number, base: number, firstInst: number) {
        self.stats.draws++;
        later(() => {
          const t = self.tickets[ticket];
          if (!t) return;
          rp().setIndexBuffer(t.buffer, 'uint32', t.offset, t.size);
          rp().drawIndexed(t.size / 4, inst, 0, base, firstInst);
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
      gpu_query_add(b: number, dst: number, src: number) { const B = buf(b); later(() => self.queryAdd(B, dst, src)); },
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
        // A failure stays this submit's: an earlier one's rejected link once completed the next submits at once, their
        // readbacks not mapped and destroyed under the map (VK3 L9b: a trap in the module's complete on NVIDIA).
        const finish = (doneAt: number) => {
          self.inFlight--;
          self.stats.orderMs += performance.now() - doneAt;
          try {
            self.complete(serial);
          } catch (err) {
            self.warn(`a submit's completion failed: ${err}`);
          }
        };
        self.chain = self.chain.then(() => done.then(finish, (err) => {
          self.warn(`a submit's readbacks failed: ${err}`);
          finish(performance.now());
        })).finally(() => {
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
  private submitNow(slots: number[], temps: (GPUBuffer | GPUTexture)[]): Promise<number> {
    const d = this.device!;
    if (this.pass) this.endPass();
    this.flushXfb();
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
   * WebGPU allows only of whole subresources, with rows 256 bytes apart, not of depth24plus's depth at all, not into
   * depth32float's depth (nor of multisampled textures): rows realigned through a temporary buffer, and what WebGPU can't do
   * skipped with a warning (one bad copy would invalidate the submit's whole command buffer). */
  private depthStencilCopy(toTexture: boolean, b: GPUBuffer, offset: number, bpr: number, rows: number, t: GPUTexture, mip: number, x: number, y: number, z: number, w: number, h: number, depth: number, aspect: number) {
    const f = t.format;
    const stencil = aspect === 2 || f === 'stencil8', d16 = f === 'depth16unorm';
    const bytes = stencil ? 1 : d16 ? 2 : 4;
    const whole = x === 0 && y === 0 && w === Math.max(1, t.width >> mip) && h === Math.max(1, t.height >> mip);
    const allowed = stencil || f === 'depth16unorm' || (!toTexture && f.startsWith('depth32float'));
    const row = w * bytes;
    const realign = bpr % 256 !== 0 && (rows > 1 || depth > 1);
    // What WebGPU won't copy of depth, by a draw or a compute pass (VK3 L6b); of stencil, part of a subresource read
    // through a whole one's copy.
    const native = whole && allowed && t.sampleCount === 1 && offset % 4 === 0 && !(realign && (row % 4 || bpr % 4));
    if (!native && t.sampleCount === 1) {
      if (!stencil && (toTexture || !d16) && this.depthByShader(toTexture, b, offset, bpr, rows, t, mip, x, y, z, w, h, depth)) return;
      if ((stencil || d16) && !toTexture && this.partThroughBuffer(b, offset, bpr, rows, t, mip, x, y, z, w, h, depth, stencil)) return;
      if (stencil && toTexture && this.stencilByDraws(b, offset, bpr, rows, t, mip, x, y, z, w, h, depth)) return;
    }
    if (!native) {
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
  /** A uniform buffer of these words, for one of the worker's passes (destroyed after the submit). */
  private params(words: number[]) {
    const u = this.device!.createBuffer({ size: Math.max(16, Math.ceil(words.length / 4) * 16), usage: UNIFORM, mappedAtCreation: true });
    new Uint32Array(u.getMappedRange()).set(words);
    u.unmap();
    this.temps.push(u);
    return u;
  }

  /**
   * Depth WebGPU won't copy between a buffer and a texture (VK3 L6b): into depth32float's or depth24plus's depth, out of
   * depth24plus's, part of a subresource. Into the texture a draw over the region writes `frag_depth` from the buffer's
   * words (the other aspect loaded and stored); out of it a compute pass loads the depth into them. A D24 texel is a
   * word's low 24 bits as unorm (Vulkan's X8_D24 layout; the X8 bits written 0), a D32 one the float's bits, a D16 one
   * a half word as unorm (into the texture only: `partThroughBuffer` reads it). False (the caller warns) where the
   * texels aren't aligned or the texture lacks the usage.
   */
  private depthByShader(toTexture: boolean, b: GPUBuffer, offset: number, bpr: number, rows: number, t: GPUTexture, mip: number, x: number, y: number, z: number, w: number, h: number, layers: number): boolean {
    const d = this.device!, enc = this.enc!;
    const f = t.format, d16 = f === 'depth16unorm', d24 = f.startsWith('depth24plus') ? 1 : 0, bytes = d16 ? 2 : 4;
    if ((d16 && !toTexture) || offset % bytes || bpr % bytes || !(t.usage & (toTexture ? RENDER_ATTACHMENT : TEXTURE_BINDING))) return false;
    const rowsPer = Math.max(rows, h);
    const from = offset & ~255, end = offset + ((layers - 1) * rowsPer + h - 1) * bpr + w * bytes;
    if (end - from > d.limits.maxStorageBufferBindingSize || end > b.size) return false;
    const key = toTexture ? `depth-up:${f}` : 'depth-down';
    const P = 'struct P { base: u32, pitch: u32, x: u32, y: u32, d24: u32, w: u32, h: u32, pad: u32 }';
    if (toTexture) {
      let pipeline = this.metaPipelines.get(key);
      if (!pipeline) {
        const m = d.createShaderModule({ code: `${P}
@group(0) @binding(0) var<storage, read> s: array<u32>;
@group(0) @binding(1) var<uniform> p: P;
@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4<f32> {
  return vec4<f32>(f32((i << 1u) & 2u) * 2.0 - 1.0, f32(i & 2u) * 2.0 - 1.0, 0.0, 1.0);
}
@fragment fn fs(@builtin(position) pos: vec4<f32>) -> @builtin(frag_depth) f32 {
  let c = vec2<u32>(pos.xy) - vec2<u32>(p.x, p.y);
  if (p.d24 == 2u) {
    let a = p.base + c.y * p.pitch + c.x * 2u;
    return f32((s[a >> 2u] >> ((a & 2u) * 8u)) & 0xffffu) / 65535.0;
  }
  let v = s[p.base + c.y * p.pitch + c.x];
  if (p.d24 != 0u) { return f32(v & 0xffffffu) / 16777215.0; }
  return bitcast<f32>(v);
}` });
        pipeline = d.createRenderPipeline({ layout: 'auto', vertex: { module: m, entryPoint: 'vs' }, fragment: { module: m, entryPoint: 'fs', targets: [] },
          primitive: { topology: 'triangle-list' }, depthStencil: { format: f, depthWriteEnabled: true, depthCompare: 'always' } });
        this.metaPipelines.set(key, pipeline);
      }
      const stencil = f.includes('stencil8');
      for (let l = 0; l < layers; l++) {
        // A D16 texel's place in bytes (it needn't start a word), the others' in words.
        const unit = d16 ? 1 : 4;
        const u = this.params([(offset - from + l * rowsPer * bpr) / unit, bpr / unit, x, y, d16 ? 2 : d24, w, h, 0]);
        const view = t.createView({ dimension: '2d', baseMipLevel: mip, mipLevelCount: 1, baseArrayLayer: z + l, arrayLayerCount: 1 });
        const pass = enc.beginRenderPass({ colorAttachments: [], depthStencilAttachment: { view, depthLoadOp: 'load', depthStoreOp: 'store', ...(stencil ? { stencilLoadOp: 'load', stencilStoreOp: 'store' } : {}) } });
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, d.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: b, offset: from, size: (end - from + 3) & ~3 } }, { binding: 1, resource: { buffer: u } }] }));
        pass.setViewport(x, y, w, h, 0, 1);
        pass.setScissorRect(x, y, w, h);
        pass.draw(3);
        pass.end();
      }
      return true;
    }
    let pipeline = this.metaComputes.get(key);
    if (!pipeline) {
      const m = d.createShaderModule({ code: `${P}
@group(0) @binding(0) var t: texture_depth_2d;
@group(0) @binding(1) var<storage, read_write> o: array<u32>;
@group(0) @binding(2) var<uniform> p: P;
@compute @workgroup_size(8, 8) fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= p.w || id.y >= p.h) { return; }
  let v = textureLoad(t, vec2<i32>(id.xy + vec2<u32>(p.x, p.y)), 0);
  var n = bitcast<u32>(v);
  if (p.d24 != 0u) {
    // The word whose upload (above) gives this depth: a division may be a unit off once rounded (SwiftShader's).
    n = u32(round(clamp(v, 0.0, 1.0) * 16777215.0));
    if (f32(n) / 16777215.0 != v) {
      if (n > 0u && f32(n - 1u) / 16777215.0 == v) { n = n - 1u; } else if (f32(n + 1u) / 16777215.0 == v) { n = n + 1u; }
    }
  }
  o[p.base + id.y * p.pitch + id.x] = n;
}` });
      pipeline = d.createComputePipeline({ layout: 'auto', compute: { module: m, entryPoint: 'main' } });
      this.metaComputes.set(key, pipeline);
    }
    for (let l = 0; l < layers; l++) {
      const u = this.params([(offset - from) / 4 + l * rowsPer * bpr / 4, bpr / 4, x, y, d24, w, h, 0]);
      const view = t.createView({ dimension: '2d', aspect: 'depth-only', baseMipLevel: mip, mipLevelCount: 1, baseArrayLayer: z + l, arrayLayerCount: 1 });
      const pass = enc.beginComputePass();
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, d.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: view }, { binding: 1, resource: { buffer: b, offset: from, size: (end - from + 3) & ~3 } }, { binding: 2, resource: { buffer: u } }] }));
      pass.dispatchWorkgroups(Math.ceil(w / 8), Math.ceil(h / 8));
      pass.end();
    }
    return true;
  }

  /** A copy between depth or stencil textures, which WebGPU makes only of whole subresources (VK3 L6b): true for the
   * caller to make it (`aspect` 0, the texture's every aspect: WebGPU's rule); part of a depth one (or any of depth24plus) goes through a temporary buffer by the worker's passes (`depthByShader`),
   * part of a stencil one the same way (`partThroughBuffer`, `stencilByDraws`). */
  private depthStencilTT(S: GPUTexture, sm: number, sx: number, sy: number, sz: number, D: GPUTexture, dm: number, dx: number, dy: number, dz: number, w: number, h: number, layers: number, aspect: number): boolean {
    const whole = (t: GPUTexture, m: number, x: number, y: number) => x === 0 && y === 0 && w === Math.max(1, t.width >> m) && h === Math.max(1, t.height >> m);
    // depth24plus's textures can't be copied at all (the driver makes them without the copy usages).
    if (!aspect && whole(S, sm, sx, sy) && whole(D, dm, dx, dy) && S.usage & TEX_COPY_SRC && D.usage & TEX_COPY_DST) return true;
    const f = S.format, depthAspect = !f.startsWith('stencil') && aspect !== 2, stencilAspect = f.includes('stencil') && aspect !== 1;
    let ok = S.sampleCount === 1 && D.sampleCount === 1;
    if (ok && depthAspect) {
      const d16 = f === 'depth16unorm', pitch = Math.ceil(w * (d16 ? 2 : 4) / 256) * 256;
      const temp = this.device!.createBuffer({ size: pitch * h * layers, usage: COPY_SRC | COPY_DST | STORAGE });
      this.temps.push(temp);
      ok = (d16 ? this.partThroughBuffer(temp, 0, pitch, h, S, sm, sx, sy, sz, w, h, layers, false) : this.depthByShader(false, temp, 0, pitch, h, S, sm, sx, sy, sz, w, h, layers)) && this.depthByShader(true, temp, 0, pitch, h, D, dm, dx, dy, dz, w, h, layers);
    }
    if (ok && stencilAspect) {
      const pitch = Math.ceil(w / 256) * 256;
      const temp = this.device!.createBuffer({ size: pitch * h * layers, usage: COPY_SRC | COPY_DST | STORAGE });
      this.temps.push(temp);
      ok = this.partThroughBuffer(temp, 0, pitch, h, S, sm, sx, sy, sz, w, h, layers, true) && this.stencilByDraws(temp, 0, pitch, h, D, dm, dx, dy, dz, w, h, layers);
    }
    if (!ok) this.warn(`a copy of part of a ${f} texture WebGPU can't make (${w}x${h} at ${sx},${sy} into ${dx},${dy}): skipped`);
    return false;
  }

  /**
   * Bytes into part of a stencil subresource (VK3 L6b), which no shader can write: over the region a draw zeroes the
   * stencil, then eight draws, one a bit, each discarding the texels whose byte lacks it and replacing that bit (its
   * write mask) with 1. The depth aspect is loaded and kept. False where the texture can't be rendered to.
   */
  private stencilByDraws(b: GPUBuffer, offset: number, bpr: number, rows: number, t: GPUTexture, mip: number, x: number, y: number, z: number, w: number, h: number, layers: number): boolean {
    const d = this.device!, enc = this.enc!, f = t.format;
    if (!(t.usage & RENDER_ATTACHMENT)) return false;
    const rowsPer = Math.max(rows, h);
    const from = offset & ~255, end = offset + ((layers - 1) * rowsPer + h - 1) * bpr + w;
    if (end - from > d.limits.maxStorageBufferBindingSize || end > b.size) return false;
    const pipelines: GPURenderPipeline[] = [];
    for (let bit = 0; bit <= 8; bit++) {
      const key = `stencil-up:${f}:${bit}`;
      let pipeline = this.metaPipelines.get(key);
      if (!pipeline) {
        let m = this.metaModules.get('stencil-up');
        if (!m) {
          m = d.createShaderModule({ code: `struct P { base: u32, pitch: u32, x: u32, y: u32 }
override bit: u32 = 8u;
@group(0) @binding(0) var<storage, read> s: array<u32>;
@group(0) @binding(1) var<uniform> p: P;
@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4<f32> {
  return vec4<f32>(f32((i << 1u) & 2u) * 2.0 - 1.0, f32(i & 2u) * 2.0 - 1.0, 0.0, 1.0);
}
@fragment fn fs(@builtin(position) pos: vec4<f32>) {
  let c = vec2<u32>(pos.xy) - vec2<u32>(p.x, p.y);
  let a = p.base + c.y * p.pitch + c.x;
  if (bit < 8u && ((s[a >> 2u] >> ((a & 3u) * 8u + bit)) & 1u) == 0u) { discard; }
}` });
          this.metaModules.set('stencil-up', m);
        }
        const face: GPUStencilFaceState = { compare: 'always', passOp: bit < 8 ? 'replace' : 'zero' };
        const hasDepth = f !== 'stencil8';
        pipeline = d.createRenderPipeline({ layout: 'auto', vertex: { module: m, entryPoint: 'vs' }, fragment: { module: m, entryPoint: 'fs', targets: [], constants: { bit } },
          primitive: { topology: 'triangle-list' }, depthStencil: { format: f, ...(hasDepth ? { depthWriteEnabled: false, depthCompare: 'always' } : {}), stencilFront: face, stencilBack: face, stencilWriteMask: bit < 8 ? 1 << bit : 0xff } });
        this.metaPipelines.set(key, pipeline);
      }
      pipelines.push(pipeline);
    }
    const depth = f !== 'stencil8';
    for (let l = 0; l < layers; l++) {
      const u = this.params([offset - from + l * rowsPer * bpr, bpr, x, y]);
      const view = t.createView({ dimension: '2d', baseMipLevel: mip, mipLevelCount: 1, baseArrayLayer: z + l, arrayLayerCount: 1 });
      const pass = enc.beginRenderPass({ colorAttachments: [], depthStencilAttachment: { view, stencilLoadOp: 'load', stencilStoreOp: 'store', ...(depth ? { depthLoadOp: 'load', depthStoreOp: 'store' } : {}) } });
      const group = d.createBindGroup({ layout: pipelines[8].getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: b, offset: from, size: (end - from + 3) & ~3 } }, { binding: 1, resource: { buffer: u } }] });
      pass.setViewport(x, y, w, h, 0, 1);
      pass.setScissorRect(x, y, w, h);
      pass.setStencilReference(0xff);
      for (const bit of [8, 0, 1, 2, 3, 4, 5, 6, 7]) {
        pass.setPipeline(pipelines[bit]);
        pass.setBindGroup(0, bit === 8 ? group : d.createBindGroup({ layout: pipelines[bit].getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: b, offset: from, size: (end - from + 3) & ~3 } }, { binding: 1, resource: { buffer: u } }] }));
        pass.draw(3);
      }
      pass.end();
    }
    return true;
  }

  /** Part of a stencil subresource, or of a depth16unorm one, into a buffer (VK3 L6b): the whole subresource copied to a
   * temporary buffer, then the region's rows out of it (unaligned rows by the worker's compute copy). */
  private partThroughBuffer(b: GPUBuffer, offset: number, bpr: number, rows: number, t: GPUTexture, mip: number, x: number, y: number, z: number, w: number, h: number, layers: number, stencil: boolean): boolean {
    const mw = Math.max(1, t.width >> mip), mh = Math.max(1, t.height >> mip);
    const bytes = stencil ? 1 : 2, pitch = Math.ceil(mw * bytes / 256) * 256, rowsPer = Math.max(rows, h);
    const temp = this.device!.createBuffer({ size: pitch * mh * layers, usage: COPY_SRC | COPY_DST | STORAGE });
    this.temps.push(temp);
    this.enc!.copyTextureToBuffer({ texture: t, mipLevel: mip, origin: { x: 0, y: 0, z }, aspect: stencil ? 'stencil-only' : 'depth-only' }, { buffer: temp, offset: 0, bytesPerRow: pitch, rowsPerImage: mh }, { width: mw, height: mh, depthOrArrayLayers: layers });
    const row = w * bytes;
    for (let l = 0; l < layers; l++)
      for (let r = 0; r < h; r++) {
        const so = (l * mh + y + r) * pitch + x * bytes, dO = offset + (l * rowsPer + r) * bpr;
        if ((so | dO | row) & 3) this.copyUnaligned(temp, so, b, dO, row);
        else this.enc!.copyBufferToBuffer(temp, so, b, dO, row);
      }
    return true;
  }

  /** Vulkan's copy between size-compatible formats, which WebGPU's texture copies refuse: the blocks' bytes through a
   * temporary buffer, one source block to one destination block or texel (`dw`×`dh` texels there). */
  private copyBetweenFormats(S: GPUTexture, sm: number, sx: number, sy: number, sz: number, D: GPUTexture, dm: number, dx: number, dy: number, dz: number, w: number, h: number, depth: number, dw: number, dh: number, cols: number, rows: number, bytes: number) {
    if (!(S.usage & TEX_COPY_SRC && D.usage & TEX_COPY_DST)) {
      this.warn(`a copy of ${S.format} into ${D.format} without the textures' copy usages: skipped`);
      return;
    }
    const bytesPerRow = Math.ceil(cols * bytes / 256) * 256;
    const buffer = this.device!.createBuffer({ size: bytesPerRow * rows * depth, usage: COPY_SRC | COPY_DST });
    this.temps.push(buffer);
    const layout = { buffer, bytesPerRow, rowsPerImage: rows };
    this.enc!.copyTextureToBuffer(this.texCopy(S, sm, sx, sy, sz, 0), layout, { width: w, height: h, depthOrArrayLayers: depth });
    this.enc!.copyBufferToTexture(layout, this.texCopy(D, dm, dx, dy, dz, 0), { width: dw, height: dh, depthOrArrayLayers: depth });
  }

  /**
   * A copy between multisampled textures: WebGPU's own for a whole subresource, else a draw per aspect, shaded per
   * sample (`sample_index`) so each sample takes the source's same sample; stencil, which a shader can't write, by a
   * draw zeroing it and a draw a bit, as `stencilByDraws`. Within one texture through a temporary one. Formats must
   * match but for sRGB (bit patterns can't cross a draw): what doesn't is skipped with a warning.
   */
  private copyMultisampled(S: GPUTexture, sm: number, sx: number, sy: number, sz: number, D: GPUTexture, dm: number, dx: number, dy: number, dz: number, w: number, h: number, aspect: number) {
    const d = this.device!, f = D.format;
    const whole = (t: GPUTexture, m: number, x: number, y: number) => x === 0 && y === 0 && w === Math.max(1, t.width >> m) && h === Math.max(1, t.height >> m);
    const samePacking = this.packed.get(S)?.join() === this.packed.get(D)?.join();
    if (S !== D && S.format === f && samePacking && !aspect && whole(S, sm, sx, sy) && whole(D, dm, dx, dy) && S.usage & TEX_COPY_SRC && D.usage & TEX_COPY_DST) {
      this.enc!.copyTextureToTexture(this.texCopy(S, sm, sx, sy, sz, 0), this.texCopy(D, dm, dx, dy, dz, 0), { width: w, height: h, depthOrArrayLayers: 1 });
      return;
    }
    // Bits, not values: twins through their linear views, packed layouts' channels by where their bits are, other
    // formats of a block's size through a shader that carries the bits (`bitsBetween`).
    const base = f.replace('-srgb', '') as GPUTextureFormat, sBase = S.format.replace('-srgb', '') as GPUTextureFormat;
    const swizzle = this.packed.get(S) || this.packed.get(D) ? packedSwizzle(this.packed.get(S), this.packed.get(D)) : 'rgba';
    const bits = sBase === base ? '' : bitsBetween(sBase, base);
    if (swizzle === undefined || bits === undefined || D.sampleCount !== S.sampleCount || !(S.usage & TEXTURE_BINDING && D.usage & RENDER_ATTACHMENT)) {
      this.warn(`a multisampled copy of ${S.format} into ${f} that WebGPU can't make: skipped`);
      return;
    }
    if (S === D) {
      const temp = d.createTexture({ size: { width: w, height: h }, format: base, sampleCount: S.sampleCount, usage: TEXTURE_BINDING | RENDER_ATTACHMENT });
      this.temps.push(temp);
      const packing = this.packed.get(S);
      if (packing) this.packed.set(temp, packing);
      this.copyMultisampled(S, sm, sx, sy, sz, temp, 0, 0, 0, 0, w, h, aspect);
      this.copyMultisampled(temp, 0, 0, 0, 0, D, dm, dx, dy, dz, w, h, aspect);
      return;
    }
    const depthy = /depth|stencil/.test(f), hasDepth = /depth/.test(f), hasStencil = /stencil/.test(f);
    const P = `struct P { at: vec2<i32> }
@group(0) @binding(0) var<uniform> p: P;
@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4<f32> {
  return vec4<f32>(f32((i << 1u) & 2u) * 2.0 - 1.0, f32(i & 2u) * 2.0 - 1.0, 0.0, 1.0);
}`;
    const u = this.params([(sx - dx) >>> 0, (sy - dy) >>> 0]);
    const pipelineFor = (key: string, code: string, depthStencil: GPUDepthStencilState | undefined, targets: GPUColorTargetState[]) => {
      let pipeline = this.metaPipelines.get(key);
      if (!pipeline) {
        const m = d.createShaderModule({ code });
        pipeline = d.createRenderPipeline({ layout: 'auto', vertex: { module: m, entryPoint: 'vs' }, fragment: { module: m, entryPoint: 'fs', targets }, primitive: { topology: 'triangle-list' }, multisample: { count: S.sampleCount }, ...(depthStencil ? { depthStencil } : {}) });
        this.metaPipelines.set(key, pipeline);
      }
      return pipeline;
    };
    const draw = (pass: GPURenderPassEncoder, pipeline: GPURenderPipeline, view: GPUTextureView) => {
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, d.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: u } }, { binding: 1, resource: view }] }));
      pass.draw(3);
    };
    const twins = S.format !== sBase || f !== base;
    const srcView = (a: GPUTextureAspect) => S.createView({ dimension: '2d', aspect: a, baseMipLevel: sm, mipLevelCount: 1, baseArrayLayer: sz, arrayLayerCount: 1, ...(twins ? { format: sBase } : {}) });
    const dstView = D.createView({ dimension: '2d', baseMipLevel: dm, mipLevelCount: 1, baseArrayLayer: dz, arrayLayerCount: 1, ...(twins ? { format: base } : {}) });
    if (!depthy) {
      const kind = sampleKind(base), from = sampleKind(sBase);
      const pipeline = pipelineFor(`mscopy:${sBase}:${base}:${swizzle}`, `${P}
@group(0) @binding(1) var t: texture_multisampled_2d<${from}>;
@fragment fn fs(@builtin(position) q: vec4<f32>, @builtin(sample_index) i: u32) -> @location(0) vec4<${kind}> {
  let v = textureLoad(t, vec2<i32>(q.xy) + p.at, i32(i));
  ${bits || `return v.${swizzle};`}
}`, undefined, [{ format: base }]);
      const pass = this.enc!.beginRenderPass({ colorAttachments: [{ view: dstView, loadOp: 'load', storeOp: 'store' }] });
      pass.setScissorRect(dx, dy, w, h);
      draw(pass, pipeline, srcView('all'));
      pass.end();
      return;
    }
    const ds: GPURenderPassDepthStencilAttachment = { view: dstView };
    if (hasDepth) Object.assign(ds, { depthLoadOp: 'load', depthStoreOp: 'store' });
    if (hasStencil) Object.assign(ds, { stencilLoadOp: 'load', stencilStoreOp: 'store' });
    const pass = this.enc!.beginRenderPass({ colorAttachments: [], depthStencilAttachment: ds });
    pass.setScissorRect(dx, dy, w, h);
    if (hasDepth && aspect !== 2) {
      const keep: GPUStencilFaceState = { compare: 'always', passOp: 'keep' };
      const pipeline = pipelineFor(`mscopy-depth:${f}`, `${P}
@group(0) @binding(1) var t: texture_depth_multisampled_2d;
@fragment fn fs(@builtin(position) q: vec4<f32>, @builtin(sample_index) i: u32) -> @builtin(frag_depth) f32 { return textureLoad(t, vec2<i32>(q.xy) + p.at, i32(i)); }`,
      { format: f, depthWriteEnabled: true, depthCompare: 'always', ...(hasStencil ? { stencilFront: keep, stencilBack: keep, stencilWriteMask: 0 } : {}) }, []);
      draw(pass, pipeline, srcView('depth-only'));
    }
    if (hasStencil && aspect !== 1) {
      const code = (test: string) => `${P}
@group(0) @binding(1) var t: texture_multisampled_2d<u32>;
@fragment fn fs(@builtin(position) q: vec4<f32>, @builtin(sample_index) i: u32) { ${test} }`;
      const view = srcView('stencil-only');
      for (const bit of [8, 0, 1, 2, 3, 4, 5, 6, 7]) {
        const face: GPUStencilFaceState = { compare: 'always', passOp: bit < 8 ? 'replace' : 'zero' };
        const test = bit < 8 ? `if ((textureLoad(t, vec2<i32>(q.xy) + p.at, i32(i)).x & ${1 << bit}u) == 0u) { discard; }` : '_ = textureLoad(t, vec2<i32>(q.xy) + p.at, i32(i));';
        const pipeline = pipelineFor(`mscopy-stencil:${f}:${bit}`, code(test), { format: f, ...(hasDepth ? { depthWriteEnabled: false, depthCompare: 'always' } : {}), stencilFront: face, stencilBack: face, stencilWriteMask: bit < 8 ? 1 << bit : 0xff }, []);
        pass.setStencilReference(0xff);
        draw(pass, pipeline, view);
      }
    }
    pass.end();
  }

  private texCopy(tex: GPUTexture, mip: number, x: number, y: number, z: number, aspect: number): GPUTexelCopyTextureInfo {
    const texture = tex instanceof MsLayers ? tex.layers[z] : tex;
    return { texture, mipLevel: mip, origin: { x, y, z: tex instanceof MsLayers ? 0 : z }, aspect: aspect === 1 ? 'depth-only' : aspect === 2 ? 'stencil-only' : 'all' };
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
      case 1: {
        const tex = (j.sampleCount ?? 1) > 1 && (j.size as number[])[2] > 1 ? new MsLayers(d, j as GPUTextureDescriptor) as unknown as GPUTexture : d.createTexture(j as GPUTextureDescriptor);
        this.objs[id] = tex;
        if (j.packed) this.packed.set(tex, j.packed);
        else if ((j.sampleCount ?? 1) === 1 && (j.usage & TEX_COPY_DST)) this.descs.set(tex, j as GPUTextureDescriptor);
        return;
      }
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
        const premade = !!j.premade;
        delete j.premade;
        const text = JSON.stringify(j).slice(0, 2000);
        j.layout = this.objs[j.layout];
        if (kind === 6) {
          j.vertex.module = this.objs[j.vertex.module];
          const x = j.xfb as Json | undefined;
          delete j.xfb;
          this.xfbByPipeline[id] = x && { stride: x.stride, base: x.base, words: x.words, bgls: ids(x.bgls) as GPUBindGroupLayout[], immediateSize: x.immediateSize,
            code: this.vertexCode.get(j.vertex.module), buffers: JSON.parse(JSON.stringify(j.vertex.buffers ?? [])) };
          if (j.vertex.pullGroup !== undefined) {
            j.vertex.module = this.pulledModule(j.vertex.module, j.vertex.buffers, j.vertex.pullGroup);
            j.vertex.buffers = j.vertex.buffers.map((b: Json | null) => (b?.pull ? null : b));
            // Bindings past WebGPU's vertex buffers are all pulled: nulls don't count, but do past the limit.
            while (j.vertex.buffers.length && !j.vertex.buffers[j.vertex.buffers.length - 1]) j.vertex.buffers.pop();
            delete j.vertex.pullGroup;
          }
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
        if (premade) {
          this.stats.premade++;
          this.unusedPremade.add(this.objs[id]!);
        }
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
  private attachment(t: GPUTexture, mip: number, layer: number, format?: string) {
    const view = this.viewOf(t, mip, t.dimension === '3d' ? 0 : layer, format);
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
        for (let z = 0; z < slices; z++) {
          const att = this.attachment(j.dst, j.dstMip, tex.dimension === '3d' ? z : j.dstLayer);
          if (fmt === 'rgb10a2uint') {
            // Dawn cuts a clear value of this format to 8 bits a channel: a draw (the driver's `wide_clear`).
            const pass = enc.beginRenderPass({ colorAttachments: [{ ...att, loadOp: 'load', storeOp: 'store' }] });
            const w = Math.max(1, tex.width >> j.dstMip), h = Math.max(1, tex.height >> j.dstMip);
            this.pass = pass;
            this.passAtts = { colors: [fmt], depth: undefined, samples: tex.sampleCount, width: w, height: h };
            this.clearRects({ rects: [[0, 0, w, h]], colors: [[0, ...((j.color ?? [0, 0, 0, 0]) as number[])]] });
            pass.end();
            this.pass = undefined;
            continue;
          }
          enc.beginRenderPass({ colorAttachments: [{ ...att, loadOp: 'clear', storeOp: 'store', clearValue: j.color ?? [0, 0, 0, 0] }] }).end();
        }
      }
      return;
    }
    if (j.op === 'resolveDepth') {
      this.resolveDepth(j);
      return;
    }
    if (j.op === 'resolve') {
      const S = j.src as GPUTexture;
      const [sx, sy] = j.from as number[], [dx, dy] = j.to as number[], [w, h] = j.size as number[];
      const sw = Math.max(1, S.width >> j.srcMip), sh = Math.max(1, S.height >> j.srcMip);
      const dw = Math.max(1, tex.width >> j.dstMip), dh = Math.max(1, tex.height >> j.dstMip);
      // WebGPU's own resolve is of a whole level of one size, into a 2D texture, of what isn't an integer format.
      if (!/int$|^r(g|gba)?32float$/.test(fmt) && tex.dimension !== '3d' && !sx && !sy && !dx && !dy && w === sw && h === sh && w === dw && h === dh && tex.usage & RENDER_ATTACHMENT)
        enc.beginRenderPass({ colorAttachments: [{ view: this.viewOf(j.src, j.srcMip, j.srcLayer, ownFormat(S, j.srcFormat)), resolveTarget: this.viewOf(j.dst, j.dstMip, j.dstLayer, ownFormat(tex, fmt)), loadOp: 'load', storeOp: 'store' }] }).end();
      else this.resolveByDraw(j, sx, sy, dx, dy, w, h);
      return;
    }
    // A blit: the source's region drawn into the destination's.
    const kind = sampleKind(fmt);
    const srcKind = sampleKind(j.srcFormat);
    // WebGPU doesn't filter these: weighed in the shader. An integer is clamped into the destination's range (Vulkan's).
    const byHand = j.filter === 'linear' && srcKind === 'f32' && /32float|16[us]norm/.test(j.srcFormat);
    const linear = j.filter === 'linear' && srcKind === 'f32' && !byHand;
    // A 3D source is sampled as one (its view is 3D) at the slice each destination slice maps to (VK3 L4c-F).
    const src3d = (j.src as GPUTexture).dimension === '3d';
    const key = `blit:${fmt}:${srcKind}:${linear}:${byHand}:${src3d}`;
    let pipeline = this.metaPipelines.get(key);
    if (!pipeline) {
      const out = kind === 'f32' ? 'vec4<f32>' : kind === 'u32' ? 'vec4<u32>' : 'vec4<i32>';
      const tex = `texture_${src3d ? '3d' : '2d'}<${srcKind}>`;
      const read = src3d
        ? (linear ? 'textureSampleLevel(t, s, vec3<f32>(uv, u.z.x), 0.0)' : 'textureLoad(t, min(vec3<i32>(vec2<i32>(floor(texel)), i32(floor(u.z.x * f32(textureDimensions(t).z)))), vec3<i32>(textureDimensions(t)) - 1), 0)')
        : (linear ? 'textureSampleLevel(t, s, uv, 0.0)' : 'textureLoad(t, min(vec2<i32>(floor(texel)), vec2<i32>(textureDimensions(t)) - 1), 0)');
      const range = integerRange(fmt);
      const conv = range ? `clamp(v, ${out}(${range[0]}), ${out}(${range[1]}))` : kind === srcKind ? 'v' : kind === 'f32' ? 'vec4<f32>(v)' : `${out}(v)`;
      // Nearest texels by Vulkan's sum, from the fragment's own position: x0 + (i + 0.5) * (source / destination). The
      // interpolated uv comes a hair short of whole texels on Metal, and an image halved reads the wrong one of two
      // (VK4 T12: generate_mipmaps.from_previous_level).
      const code = `struct U { r: vec4<f32>, flip: vec4<f32>, z: vec4<f32>, d: vec4<f32>, s: vec4<f32> }
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var t: ${tex};
${linear ? '@group(0) @binding(2) var s: sampler;' : ''}
${byHand ? (src3d ? BLIT_FILTER_3D : BLIT_FILTER_2D) : ''}
struct V { @builtin(position) p: vec4<f32>, @location(0) q: vec2<f32> }
@vertex fn vs(@builtin(vertex_index) i: u32) -> V {
  let q = vec2<f32>(f32((i << 1u) & 2u), f32(i & 2u));
  return V(vec4<f32>(q.x * 2.0 - 1.0, 1.0 - q.y * 2.0, 0.0, 1.0), q);
}
@fragment fn fs(v_in: V) -> @location(0) ${out} {
  let t01 = select(v_in.q, 1.0 - v_in.q, u.flip.xy > vec2<f32>(0.5));
  let uv = u.r.xy + t01 * u.r.zw;
  let at_dst = v_in.p.xy - u.d.xy;
  let texel = u.s.xy + select(at_dst, u.d.zw - at_dst, u.flip.xy > vec2<f32>(0.5)) * u.s.zw;
  let v = ${byHand ? (src3d ? 'blit(uv, u.z.x)' : 'blit(uv)') : read};
  return ${conv};
}`;
      const m = this.device!.createShaderModule({ code });
      pipeline = this.device!.createRenderPipeline({ layout: 'auto', vertex: { module: m, entryPoint: 'vs' }, fragment: { module: m, entryPoint: 'fs', targets: [{ format: fmt }] }, primitive: { topology: 'triangle-list' } });
      this.metaPipelines.set(key, pipeline);
    }
    const [sx0, sy0, sx1, sy1] = j.from as number[], [dx0, dy0, dx1, dy1] = j.to as number[];
    // A sample's coordinates are of the texture's level, which a padded compressed image's isn't in proportion to (VK4 T18).
    const sw = Math.max(1, (j.src as GPUTexture).width >> j.srcMip), sh = Math.max(1, (j.src as GPUTexture).height >> j.srcMip);
    if (dx0 === dx1 || dy0 === dy1) return;
    // Slices: a 3D destination's each, else the one layer; each samples the source's slice at its centre.
    const [sz0, sz1] = (j.srcZ ?? [0, 1]) as number[], [dz0, dz1] = (j.dstZ ?? [0, 1]) as number[];
    const sd = (j.srcDepth ?? 1) as number;
    const dst3d = tex.dimension === '3d';
    // A blit within one subresource (Vulkan's regions apart) samples a copy of it: WebGPU won't sample a subresource it
    // renders to (VK3 L8a, the track-end review's finding 1).
    // BC1's RGB formats: alpha 1, as a sampled view's swizzle says (wg_format.c).
    let srcView = j.srcOpaque ? (j.src as GPUTexture).createView({ dimension: '2d', baseMipLevel: j.srcMip, mipLevelCount: 1, baseArrayLayer: j.srcLayer, arrayLayerCount: 1, swizzle: 'rgb1', usage: 4 } as GPUTextureViewDescriptor) : this.viewOf(j.src, j.srcMip, j.srcLayer);
    if (j.src === j.dst && j.srcMip === j.dstMip && (src3d || j.srcLayer === j.dstLayer)) {
      const S = j.src as GPUTexture, mip = j.srcMip as number;
      const size = { width: Math.max(1, S.width >> mip), height: Math.max(1, S.height >> mip), depthOrArrayLayers: src3d ? Math.max(1, S.depthOrArrayLayers >> mip) : 1 };
      const temp = this.device!.createTexture({ size, format: S.format, dimension: S.dimension, usage: TEXTURE_BINDING | TEX_COPY_DST });
      this.temps.push(temp);
      enc.copyTextureToTexture({ texture: S, mipLevel: mip, origin: { x: 0, y: 0, z: src3d ? 0 : j.srcLayer } }, { texture: temp }, size);
      srcView = temp.createView({ dimension: src3d ? '3d' : '2d' });
    }
    const slices = dst3d ? [...Array(Math.abs(dz1 - dz0)).keys()].map((i) => Math.min(dz0, dz1) + i) : [j.dstLayer as number];
    for (const slice of slices) {
      const at = dst3d ? slice : dz0;
      const w = (sz0 + ((at + 0.5 - dz0) / ((dz1 - dz0) || 1)) * (sz1 - sz0)) / sd;
      const dw = Math.abs(dx1 - dx0), dh = Math.abs(dy1 - dy0), x0 = Math.min(dx0, dx1), y0 = Math.min(dy0, dy1);
      const u = this.staging(80, (m) => new Float32Array(m).set([sx0 / sw, sy0 / sh, (sx1 - sx0) / sw, (sy1 - sy0) / sh, dx0 > dx1 ? 1 : 0, dy0 > dy1 ? 1 : 0, 0, 0, w, 0, 0, 0,
        x0, y0, dw, dh, sx0, sy0, (sx1 - sx0) / dw, (sy1 - sy0) / dh]));
      const uniform = this.device!.createBuffer({ size: 80, usage: UNIFORM | COPY_DST });
      enc.copyBufferToBuffer(u, 0, uniform, 0, 80);
      this.temps.push(uniform);
      const entries: GPUBindGroupEntry[] = [{ binding: 0, resource: { buffer: uniform } }, { binding: 1, resource: srcView }];
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
   * A colour resolve WebGPU can't make: a draw over the region reading the source's samples, their average, or sample 0
   * of an integer format (Vulkan's "a single sample's value").
   */
  private resolveByDraw(j: Json, sx: number, sy: number, dx: number, dy: number, w: number, h: number) {
    const d = this.device!, S = j.src as GPUTexture, D = j.dst as GPUTexture, fmt = j.format as GPUTextureFormat;
    if (!(S.usage & TEXTURE_BINDING && D.usage & RENDER_ATTACHMENT)) {
      this.warn(`a resolve of ${fmt} that can't be read or drawn into: skipped`);
      return;
    }
    const kind = sampleKind(fmt), key = `resolve:${fmt}`;
    let pipeline = this.metaPipelines.get(key);
    if (!pipeline) {
      const read = kind === 'f32'
        ? 'var v = vec4<f32>(0.0);\n  for (var i = 0; i < i32(textureNumSamples(t)); i++) { v += textureLoad(t, c, i); }\n  return v / f32(textureNumSamples(t));'
        : 'return textureLoad(t, c, 0);';
      const m = d.createShaderModule({ code: `struct P { at: vec2<i32> }
@group(0) @binding(0) var<uniform> p: P;
@group(0) @binding(1) var t: texture_multisampled_2d<${kind}>;
@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4<f32> {
  return vec4<f32>(f32((i << 1u) & 2u) * 2.0 - 1.0, f32(i & 2u) * 2.0 - 1.0, 0.0, 1.0);
}
@fragment fn fs(@builtin(position) q: vec4<f32>) -> @location(0) vec4<${kind}> {
  let c = vec2<i32>(q.xy) + p.at;
  ${read}
}` });
      pipeline = d.createRenderPipeline({ layout: 'auto', vertex: { module: m, entryPoint: 'vs' }, fragment: { module: m, entryPoint: 'fs', targets: [{ format: fmt }] }, primitive: { topology: 'triangle-list' } });
      this.metaPipelines.set(key, pipeline);
    }
    const u = this.params([(sx - dx) >>> 0, (sy - dy) >>> 0]);
    // In the views' formats, which may be their textures' sRGB twins.
    const pass = this.enc!.beginRenderPass({ colorAttachments: [{ ...this.attachment(D, j.dstMip, j.dstLayer, ownFormat(D, fmt)), loadOp: 'load', storeOp: 'store' }] });
    pass.setScissorRect(dx, dy, w, h);
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, d.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: u } }, { binding: 1, resource: this.viewOf(S, j.srcMip, j.srcLayer, ownFormat(S, j.srcFormat)) }] }));
    pass.draw(3);
    pass.end();
  }

  /**
   * A multisampled depth or stencil attachment's SAMPLE_ZERO resolve (WebGPU resolves colour only) within the render
   * area (`area`, a scissor): a draw that writes each pixel's sample 0 as its depth (`frag_depth`), or, for stencil,
   * which a shader can't write, the value zeroed by a draw (a reference of 0 replacing every bit) and then each bit set
   * by a draw of its own (the bit's write mask, a reference of all ones) that keeps only the pixels whose sample 0 has it.
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
    if (/stencil/.test(fmt)) Object.assign(ds, { stencilLoadOp: 'load', stencilStoreOp: 'store' });
    // The render area within the destination's level.
    const w = Math.max(1, dst.width >> (j.dstMip as number)), h = Math.max(1, dst.height >> (j.dstMip as number));
    const [ax, ay, aw, ah] = (j.area ?? [0, 0, w, h]) as number[];
    const x0 = Math.min(Math.max(ax, 0), w), y0 = Math.min(Math.max(ay, 0), h);
    const x1 = Math.min(Math.max(ax + aw, x0), w), y1 = Math.min(Math.max(ay + ah, y0), h);
    if (x0 === x1 || y0 === y1) return;
    const pass = this.enc!.beginRenderPass({ colorAttachments: [], depthStencilAttachment: ds });
    pass.setScissorRect(x0, y0, x1 - x0, y1 - y0);
    const draws = stencil ? [-2, 0, 1, 2, 3, 4, 5, 6, 7] : [-1];
    for (const bit of draws) {
      const pipeline = bit === -1
        ? layout(`@group(0) @binding(0) var t: texture_depth_multisampled_2d;
${vs}
@fragment fn fs(@builtin(position) p: vec4<f32>) -> @builtin(frag_depth) f32 { return textureLoad(t, vec2<i32>(p.xy), 0); }`, 0)
        : bit === -2
          ? layout(`@group(0) @binding(0) var t: texture_multisampled_2d<u32>;
${vs}
@fragment fn fs(@builtin(position) p: vec4<f32>) { _ = textureLoad(t, vec2<i32>(p.xy), 0); }`, 0xff, bit)
          : layout(`@group(0) @binding(0) var t: texture_multisampled_2d<u32>;
${vs}
@fragment fn fs(@builtin(position) p: vec4<f32>) { if ((textureLoad(t, vec2<i32>(p.xy), 0).x & ${1 << bit}u) == 0u) { discard; } }`, 1 << bit, bit);
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, this.device!.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: view }] }));
      if (stencil) pass.setStencilReference(bit === -2 ? 0 : 0xff);
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
  /** A vertex stage's module with its pulled bindings' fetch (wg_shader.c `wg_vertex_pull`, VK4 T5). */
  private pulledModule(m: GPUShaderModule, buffers: (PulledBuffer | null)[], group: number): GPUShaderModule {
    const code = this.vertexCode.get(m), key = `${group} ${JSON.stringify(buffers)}`;
    if (!code) {
      this.warn('vertices pulled for a stage without inputs');
      return m;
    }
    let made = this.pulledModules.get(m);
    if (!made) this.pulledModules.set(m, (made = new Map()));
    let module = made.get(key);
    if (!module) {
      const text = pulledCode(code, buffers, group);
      module = this.device!.createShaderModule({ code: text });
      made.set(key, module);
      void module.getCompilationInfo().then((info) => {
        const errors = info.messages.filter((x) => x.type === 'error');
        if (errors.length) this.warn(`a pulled vertex stage didn't compile: ${errors.map((x) => `${x.lineNum}:${x.linePos} ${x.message}`).join('; ')}`);
      });
    }
    return module;
  }

  /** The pipeline's pulled bindings' group (wg_pull's, its bindings the slots' and `PULL_SLOTS` the bytes each slot's range starts
   * past a storage offset WebGPU takes), from the ranges the driver last gave: to the end of each buffer's range, a
   * whole number of words, as much of it as WebGPU's storage binding reaches. */
  private pullBind(group: number, layout: GPUBindGroupLayout, slots: number) {
    const d = this.device!, align = d.limits.minStorageBufferOffsetAlignment, into = new Uint32Array(PULL_SLOTS);
    const entries: GPUBindGroupEntry[] = [];
    for (let slot = 0; slot < PULL_SLOTS; slot++) {
      if (!((slots >>> slot) & 1)) continue;
      const v = this.cur.vb[slot];
      if (!v) { this.warn('vertices pulled from a binding without a buffer'); return; }
      const from = Math.floor(v.offset / align) * align;
      into[slot] = v.offset - from;
      const size = Math.min(Math.ceil((v.offset - from + v.size) / 4) * 4, v.b.size - from, d.limits.maxStorageBufferBindingSize);
      entries.push({ binding: slot, resource: { buffer: v.b, offset: from, size } });
    }
    const [u, at] = this.scratch(UNIFORM | COPY_DST, into.byteLength);
    d.queue.writeBuffer(u, at, into);
    entries.push({ binding: PULL_SLOTS, resource: { buffer: u, offset: at, size: into.byteLength } });
    (this.pass as GPURenderPassEncoder).setBindGroup(group, d.createBindGroup({ layout, entries }));
  }

  /** The open pass ended, and a render pass's transform feedback run after it (`runXfb`). */
  private endPass() {
    this.pass?.end();
    this.pass = undefined;
    this.passAtts = undefined;
    // A capture still open is one a cut of the Vulkan pass divides (wg_cmd.c `begin_pass`): it goes on in the next part.
    if (!xfbOpen(this.xfbJobs)) this.flushXfb();
  }

  /** The transform feedback of the render pass that ended. */
  private flushXfb() {
    const jobs = this.xfbJobs;
    this.xfbJobs = [];
    if (jobs.length) this.runXfb(jobs);
  }

  /**
   * A render pass's transform feedback (wg_gpu.h `gpu_xfb`, VK3 L7.4), after it: each begin copies its buffers' bound
   * ranges and its counters (the bytes written so far, a word a buffer) into one buffer of the worker's, the counters
   * first (a captured draw writes it, so that no dispatch binds a guest memory writable beside its other uses); each
   * draw runs its vertex stage as compute on what the pass bound for it (`xfbDraw`); each end copies the ranges back and
   * the counters out. The capture's own bindings are three whatever its buffers (VK3 L7a, the binding review's finding
   * 1: a storage buffer a captured buffer and a vertex binding went past WebGPU's storage buffers a stage, and the
   * invalid pass lost the submit): that one (`wgx_o`), the draw's inputs (`wgx_in`) and its parameters; the driver
   * counts them with the stage's (wg_caps.c `wg_bindings_fit`).
   */
  private runXfb(jobs: Json[]) {
    const d = this.device!, enc = this.enc!;
    type Bound = { guest: GPUBuffer; at: number; size: number; word: number } | null;
    let session: XfbSession | undefined;
    const finish = (counters?: ([GPUBuffer, number] | null)[]) => {
      if (!session) return;
      for (const b of session.bufs) if (b) enc.copyBufferToBuffer(session.out, 4 * b.word, b.guest, b.at, b.size);
      const out = session.out;
      counters?.forEach((c, i) => { if (c) enc.copyBufferToBuffer(out, 4 * i, c[0], c[1], 4); });
      session = undefined;
    };
    for (const job of jobs) {
      if (job.op === 'begin') {
        finish();
        let words = 4;
        const bufs = (job.buffers as ([GPUBuffer, number, number] | null)[]).map((b): Bound => {
          if (!b) return null;
          const size = Math.min(b[2], b[0].size - b[1]) & ~3;
          if (size <= 0) return null;
          const word = words;
          words += size / 4;
          return { guest: b[0], at: b[1], size, word };
        });
        if (4 * words > d.limits.maxStorageBufferBindingSize) {
          this.warn(`transform feedback into ${4 * words} bytes, past WebGPU's storage binding`);
          continue;
        }
        const out = d.createBuffer({ size: 4 * words, usage: STORAGE | COPY_SRC | COPY_DST });
        this.temps.push(out);
        enc.clearBuffer(out, 0, 16);
        for (const b of bufs) if (b) enc.copyBufferToBuffer(b.guest, b.at, out, 4 * b.word, b.size);
        (job.counters as ([GPUBuffer, number] | null)[]).forEach((c, i) => { if (c && bufs[i]) enc.copyBufferToBuffer(c[0], c[1], out, 4 * i, 4); });
        session = { bufs, out };
      } else if (job.op === 'draw') {
        if (session) this.xfbDraw(session, job);
      } else {
        finish(job.counters);
      }
    }
    finish();
  }

  /** A captured draw: its vertex stage (`wg_vs`) run as compute for its primitives' vertices, in Vulkan's order, as many
   * whole primitives as every buffer has room for; then the counters advanced by them. Its index range and each vertex
   * binding's reachable range are copied into one buffer first (`wgx_in`). An indirect draw's (`job.indirect`: VK3 L7b,
   * the review of L7.4-L7.5's finding 2) arguments are copied over its parameters on the GPU, its index buffer and
   * vertex bindings taken whole, its primitives counted by the shader (`wgx_prims`). */
  private xfbDraw(session: XfbSession, job: Json) {
    const x = job.xfb as Xfb | undefined;
    const vpp = [1, 2, 2, 3, 3, 3][job.topology as number];
    if (!x?.code || vpp === undefined || x.bgls.length >= 4) {
      this.warn(!x?.code ? 'transform feedback of a vertex stage that captures nothing' : vpp === undefined ? `transform feedback of topology ${job.topology}` : 'transform feedback with four bind groups');
      return;
    }
    const d = this.device!, enc = this.enc!;
    const p = this.xfbPipeline(x);
    if (!p) return;
    const count = job.count as number, instances = job.instances as number, wide = job.wide as number;
    const indirect = job.indirect as [GPUBuffer, number] | undefined;
    const prims = [count, count >> 1, Math.max(count - 1, 0), Math.floor(count / 3), Math.max(count - 2, 0), Math.max(count - 2, 0)][job.topology as number];
    if (!prims && !indirect) return;
    const params = new Uint32Array(28);
    // The copies into `wgx_in`: from 4-aligned offsets, whole words, each at a word of its own.
    const copies: { b: GPUBuffer; from: number; size: number; at: number }[] = [];
    let bytes = 0;
    const take = (b: GPUBuffer, offset: number, size: number) => {
      const from = offset & ~3, n = Math.min((Math.max(offset + size - from, 4) + 3) & ~3, b.size - from);
      const at = bytes;
      if (n > 0) copies.push({ b, from, size: n, at });
      bytes += Math.max(n, 0);
      return at + (offset - from);
    };
    // The index of the bound range's start in `wgx_in` (the shader adds the first index: a u32 that wraps).
    let ibFirst = 0;
    if (wide !== 2 && job.ib) {
      const el = wide ? 4 : 2, first = indirect ? 0 : (job.first as number), start = (job.offset as number) + first * el;
      // A direct draw's indices only (VK3 L8a, the track-end review's finding 2: the bound range's rest went past
      // maxStorageBufferBindingSize, and the capture was skipped); an indirect one's whole, its count on the GPU.
      ibFirst = (take(job.ib as GPUBuffer, start, indirect ? (job.size as number) : count * el) / el - first) >>> 0;
    }
    for (const slot of p.slots) {
      const v = (job.vb as ({ b: GPUBuffer; offset: number; size: number } | undefined)[])[slot];
      if (!v) { this.warn('transform feedback without its vertex buffer'); return; }
      // What the draw can reach of it: past its last vertex or instance (non-indexed), or all of it.
      const b = x.buffers[slot] as Json;
      const end = Math.max(0, ...(b.attributes as Json[]).map((a) => (a.offset as number) + 16));
      const last = indirect ? Infinity : b.stepMode === 'instance' ? (job.firstInstance as number) + instances : wide === 2 ? (job.first as number) + count : Infinity;
      params[16 + slot] = take(v.b, v.offset, Math.min(v.size, last * (b.arrayStride as number) + end));
    }
    if (bytes > d.limits.maxStorageBufferBindingSize) {
      this.warn(`transform feedback of a draw reaching ${bytes} bytes of vertices and indices, past WebGPU's storage binding`);
      return;
    }
    const inb = d.createBuffer({ size: Math.max(bytes, 4), usage: STORAGE | COPY_DST });
    this.temps.push(inb);
    for (const c of copies) enc.copyBufferToBuffer(c.b, c.from, inb, c.at, c.size);
    for (const b of p.captured) {
      const s = session.bufs[b];
      if (!s) { this.warn('transform feedback into a buffer not bound'); return; }
      params[10 + b] = s.size;
      params[24 + b] = s.word;
    }
    params.set([job.topology, count, instances, job.first, (job.base as number) >>> 0, job.firstInstance, wide, ibFirst, prims, vpp]);
    const [u, uat] = this.scratch(UNIFORM | COPY_DST, params.byteLength);
    d.queue.writeBuffer(u, uat, params);
    if (indirect) {
      // VkDrawIndexedIndirectCommand's five words are the parameters' count to firstInstance; VkDrawIndirectCommand's
      // the count, instances and first, then firstInstance (its base vertex 0).
      enc.copyBufferToBuffer(indirect[0], indirect[1], u, uat + 4, wide === 2 ? 12 : 20);
      if (wide === 2) enc.copyBufferToBuffer(indirect[0], indirect[1] + 12, u, uat + 20, 4);
    }
    const entries: GPUBindGroupEntry[] = [
      { binding: 12, resource: { buffer: session.out } },
      { binding: 13, resource: { buffer: u, offset: uat, size: params.byteLength } },
      { binding: 14, resource: { buffer: inb } },
    ];
    const group = d.createBindGroup({ layout: p.layout, entries });
    const groups = job.groups as ({ g: GPUBindGroup; offsets: number[] } | undefined)[];
    for (let g = 0; g < x.bgls.length; g++) if (!groups[g]) { this.warn('transform feedback without its bind groups'); return; }
    const pass = enc.beginComputePass();
    for (let g = 0; g < x.bgls.length; g++) pass.setBindGroup(g, groups[g]!.g, groups[g]!.offsets);
    pass.setBindGroup(x.bgls.length, group);
    if (x.immediateSize && job.imm) (pass as unknown as { setImmediates(o: number, d: Uint8Array): void }).setImmediates(0, job.imm as Uint8Array);
    pass.setPipeline(p.main);
    // An indirect draw's count is on the GPU: as many workgroups as a large draw's (each invocation loops).
    pass.dispatchWorkgroups(indirect ? 1024 : Math.min(65535, Math.ceil((prims * instances * vpp) / 64)));
    pass.setPipeline(p.advance);
    pass.dispatchWorkgroups(1);
    pass.end();
  }

  /** A captured vertex stage's compute pipelines (`wgx_main`, `wgx_advance`): its WGSL with the vertex fetch its render
   * pipeline's buffers describe (`wgx_fetch`) and the capture's loop, on the program's bind group layouts and one of
   * its own after them (three bindings: `runXfb`). */
  private xfbPipeline(x: Xfb): NonNullable<Xfb['pipelines']> | undefined {
    if (x.pipelines !== undefined) return x.pipelines ?? undefined;
    const d = this.device!, G = x.bgls.length, code = x.code!;
    const base: Record<number, string> = {};
    for (const m of code.matchAll(/@location\((\d+)\) a\d+: vec4<(f32|i32|u32)>/g)) base[Number(m[1])] = m[2];
    const inputs = /fn wg_vs\(vid: u32, iid: u32, i: In\)/.test(code);
    const slots: number[] = [], captured = [0, 1, 2, 3].filter((b) => x.stride[b]);
    const lines: string[] = [];
    const L = (l: string) => lines.push(l);
    L(`struct WgxP { topo: u32, count: u32, instances: u32, first: u32, base: u32, firstInstance: u32, wide: u32, ibFirst: u32, prims: u32, vpp: u32, xs0: u32, xs1: u32, xs2: u32, xs3: u32, pad0: u32, pad1: u32, ${[0, 1, 2, 3, 4, 5, 6, 7].map((s) => `vbd${s}: u32`).join(', ')}, xo0: u32, xo1: u32, xo2: u32, xo3: u32 }`);
    L(`@group(${G}) @binding(13) var<uniform> wgx_p: WgxP;`);
    L(`@group(${G}) @binding(12) var<storage, read_write> wgx_o: array<u32>;`);
    L(`@group(${G}) @binding(14) var<storage, read> wgx_in: array<u32>;`);
    L('fn wgx_ld(b: u32) -> u32 { let w = b >> 2u; let s = (b & 3u) * 8u; if (s == 0u) { return wgx_in[w]; } return (wgx_in[w] >> s) | (wgx_in[w + 1u] << (32u - s)); }');
    let fetch = 'fn wgx_fetch(vid: u32, iid: u32) -> In {\n  var i: In;\n';
    x.buffers.forEach((b, slot) => {
      if (!b || !b.attributes?.length) return;
      slots.push(slot);
      for (const a of b.attributes as Json[]) {
        const at = `(wgx_p.vbd${slot} + ${b.stepMode === 'instance' ? 'iid' : 'vid'} * ${b.arrayStride}u + ${a.offset}u)`;
        const T = base[a.shaderLocation];
        const v = T && vertexDecode(a.format as string, (k: number) => `wgx_ld(${at} + ${k}u)`, T);
        if (v) fetch += `  i.a${a.shaderLocation} = ${v};\n`;
      }
    });
    fetch += '  return i;\n}';
    if (inputs) L(fetch);
    const room = captured.map((b) => `fit = min(fit, (wgx_p.xs${b} - min(wgx_p.xs${b}, wgx_o[${b}])) / (${x.stride[b]}u * wgx_p.vpp));`).join(' ');
    L('fn wgx_prims() -> u32 { let c = wgx_p.count; switch wgx_p.topo { case 0u: { return c; } case 1u: { return c >> 1u; } case 2u: { return max(c, 1u) - 1u; } case 3u: { return c / 3u; } default: { return max(c, 2u) - 2u; } } }');
    L(`fn wgx_fit() -> u32 { var fit = wgx_prims() * wgx_p.instances; ${room} return fit; }`);
    L('fn wgx_vertex(j: u32) -> u32 {');
    L('  if (wgx_p.wide == 2u) { return wgx_p.first + j; }');
    L('  let k = wgx_p.ibFirst + wgx_p.first + j;');
    L('  var v = wgx_in[k];');
    L('  if (wgx_p.wide == 0u) { v = extractBits(wgx_in[k >> 1u], (k & 1u) * 16u, 16u); }');
    L('  return v + wgx_p.base;');
    L('}');
    L('@compute @workgroup_size(64) fn wgx_main(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(num_workgroups) nwg: vec3<u32>) {');
    L('  let n = wgx_fit() * wgx_p.vpp; let prims = wgx_prims();');
    L('  for (var t = gid.x; t < n; t += nwg.x * 64u) {');
    L('    let g = t / wgx_p.vpp; let k = t % wgx_p.vpp; let inst = g / prims; let p = g % prims;');
    L('    var j = p;');
    L('    switch wgx_p.topo {');
    L('      case 1u: { j = 2u * p + k; }');
    L('      case 2u: { j = p + k; }');
    L('      case 3u: { j = 3u * p + k; }');
    L('      case 4u: { j = p + select(select(2u - (p & 1u), 1u + (p & 1u), k == 1u), 0u, k == 0u); }');
    L('      case 5u: { j = select(p + 1u + k, 0u, k == 2u); }');
    L('      default: {}');
    L('    }');
    L('    let vid = wgx_vertex(j); let iid = wgx_p.firstInstance + inst;');
    L(`    wg_vs(vid, iid${inputs ? ', wgx_fetch(vid, iid)' : ''});`);
    for (const b of captured) {
      L(`    let at${b} = wgx_p.xo${b} + wgx_o[${b}] / 4u + t * ${x.stride[b] >> 2}u;`);
      for (let w = 0; w < 128; w++) if ((x.words[b][w >> 5] >>> (w & 31)) & 1) L(`    wgx_o[at${b} + ${w}u] = wg_xo[${x.base[b] + w}u];`);
    }
    L('  }');
    L('}');
    L(`@compute @workgroup_size(1) fn wgx_advance() { let fit = wgx_fit(); ${captured.map((b) => `wgx_o[${b}] = wgx_o[${b}] + fit * wgx_p.vpp * ${x.stride[b]}u;`).join(' ')} }`);
    const entries: GPUBindGroupLayoutEntry[] = [
      { binding: 12, visibility: 4, buffer: { type: 'storage' } },
      { binding: 13, visibility: 4, buffer: { type: 'uniform' } },
      { binding: 14, visibility: 4, buffer: { type: 'read-only-storage' } },
    ];
    // The driver made the capture only where its bindings fit (wg_bindings_fit); a WebGPU error here is still said.
    d.pushErrorScope('validation');
    const layout = d.createBindGroupLayout({ entries });
    const desc: Json = { bindGroupLayouts: [...x.bgls, layout] };
    if (x.immediateSize) desc.immediateSize = x.immediateSize;
    const pl = d.createPipelineLayout(desc as GPUPipelineLayoutDescriptor);
    const module = d.createShaderModule({ code: `${code}\n${lines.join('\n')}\n` });
    void module.getCompilationInfo().then((info) => {
      const errors = info.messages.filter((m) => m.type === 'error');
      if (errors.length) this.warn(`transform feedback's shader didn't compile: ${errors.map((m) => `${m.lineNum}:${m.linePos} ${m.message}`).join('; ')}`);
    });
    const main = d.createComputePipeline({ layout: pl, compute: { module, entryPoint: 'wgx_main' } });
    const advance = d.createComputePipeline({ layout: pl, compute: { module, entryPoint: 'wgx_advance' } });
    void d.popErrorScope().then((e) => { if (e) this.warn(`transform feedback's pipelines: ${e.message.slice(0, 300)}`); });
    x.pipelines = { main, advance, layout, slots, captured };
    return x.pipelines;
  }

  /** `bytes` at a 256-aligned place of the scratch buffer of `usage`, grown (the old one destroyed after the submit). */
  private scratch(usage: number, bytes: number): [GPUBuffer, number] {
    const need = (bytes + 255) & ~255;
    let s = this.scratches.get(usage);
    if (!s || s.at + need > s.buffer.size) {
      if (s) this.temps.push(s.buffer);
      s = { buffer: this.device!.createBuffer({ size: Math.max(1 << 16, 2 * need, s ? 2 * s.buffer.size : 0), usage }), at: 0 };
      this.scratches.set(usage, s);
    }
    const at = s.at;
    s.at += need;
    return [s.buffer, at];
  }

  /**
   * A draw's primitives as a list of 32-bit indices, each one's vertices rotated so that Vulkan's provoking vertex comes
   * first (WebGPU's flat interpolation takes the first), in a compute pass before the render pass (wg_gpu.h
   * `gpu_provoke`, VK3 L7.4): `mode` WG_PROVOKE_* (triangle list, strip, fan's last, fan's first, line list, strip).
   * With `restart`, 256 invocations walk the strip or fan in parts (`restart`: VK3 L7b, the review of L7.4-L7.5's finding
   * 7: one walked it all), a degenerate primitive where a restart leaves none.
   */
  private provoke(ticket: number, src: GPUBuffer | undefined, offset: number, size: number, wide: number, mode: number, restart: number, first: number, count: number, prims: number) {
    const d = this.device!, enc = this.enc!;
    let pipeline = this.metaComputes.get('provoke');
    if (!pipeline) {
      const code = `struct P { mode: u32, wide: u32, first: u32, prims: u32, restart: u32, count: u32, pad0: u32, pad1: u32 }
@group(0) @binding(0) var<storage, read> s: array<u32>;
@group(0) @binding(1) var<storage, read_write> o: array<u32>;
@group(0) @binding(2) var<uniform> p: P;
fn ix(i: u32) -> u32 {
  if (p.wide == 2u) { return i; }
  let k = p.first + i;
  if (p.wide == 1u) { return s[k]; }
  return (s[k >> 1u] >> ((k & 1u) * 16u)) & 0xffffu;
}
fn tri(g: u32, a: u32, b: u32, c: u32) { o[3u * g] = a; o[3u * g + 1u] = b; o[3u * g + 2u] = c; }
fn line(g: u32, a: u32, b: u32) { o[2u * g] = a; o[2u * g + 1u] = b; }
// Triangle j of a strip (its vertices a, b, x) or a fan (c, b, x), its provoking vertex first, the winding kept.
fn joined(g: u32, j: u32, c: u32, a: u32, b: u32, x: u32) {
  if (p.mode == 1u) { if ((j & 1u) == 0u) { tri(g, x, a, b); } else { tri(g, x, b, a); } }
  else if (p.mode == 2u) { tri(g, x, c, b); }
  else { tri(g, b, x, c); }
}
// With restart: the indices in 256 parts, an invocation each; each finds its part's last restart, then walks its part
// from the run the parts before it left: position i's primitive (the one it completes) at i less the vertices before
// it, a degenerate one where none.
var<workgroup> wl: array<u32, 256>;
@compute @workgroup_size(256) fn restart(@builtin(local_invocation_index) t: u32) {
  let r = select(0xffffu, 0xffffffffu, p.wide == 1u);
  let before = select(2u, 1u, p.mode == 5u);
  let per = (p.count + 255u) / 256u;
  let lo = min(t * per, p.count);
  let hi = min(lo + per, p.count);
  var last = 0u;
  for (var i = lo; i < hi; i++) { if (ix(i) == r) { last = i + 1u; } }
  wl[t] = last;
  workgroupBarrier();
  var s = 0u;
  for (var k = 0u; k < t; k++) { s = max(s, wl[k]); }
  for (var i = lo; i < hi; i++) {
    let x = ix(i);
    if (x == r) { s = i + 1u; }
    if (i < before) { continue; }
    let g = i - before;
    if (x == r || i - s < before) {
      if (p.mode == 5u) { line(g, 0u, 0u); } else { tri(g, 0u, 0u, 0u); }
    } else if (p.mode == 5u) {
      line(g, x, ix(i - 1u));
    } else {
      joined(g, i - s - 2u, ix(s), ix(i - 2u), ix(i - 1u), x);
    }
  }
}
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id: vec3<u32>, @builtin(num_workgroups) n: vec3<u32>) {
  for (var g = id.x; g < p.prims; g += n.x * 64u) {
    switch p.mode {
      case 0u: { tri(g, ix(3u * g + 2u), ix(3u * g), ix(3u * g + 1u)); }
      case 4u: { line(g, ix(2u * g + 1u), ix(2u * g)); }
      case 5u: { line(g, ix(g + 1u), ix(g)); }
      default: { joined(g, g, ix(0u), ix(g), ix(g + 1u), ix(g + 2u)); }
    }
  }
}`;
      const m = d.createShaderModule({ code });
      // One layout for both entry points (a pipeline's 'auto' one is its own).
      const layout = d.createPipelineLayout({ bindGroupLayouts: [d.createBindGroupLayout({ entries: [
        { binding: 0, visibility: 4, buffer: { type: 'read-only-storage' } },
        { binding: 1, visibility: 4, buffer: { type: 'storage' } },
        { binding: 2, visibility: 4, buffer: { type: 'uniform' } },
      ] })] });
      pipeline = d.createComputePipeline({ layout, compute: { module: m, entryPoint: 'main' } });
      this.metaComputes.set('provoke', pipeline);
      this.metaComputes.set('provokeRestart', d.createComputePipeline({ layout, compute: { module: m, entryPoint: 'restart' } }));
    }
    const per = mode >= 4 ? 2 : 3, bytes = prims * per * 4;
    const [out, at] = this.scratch(STORAGE | INDEX, bytes);
    // The source's binding from a 256-aligned offset (minStorageBufferOffsetAlignment is at most 256) to the draw's
    // last index, in words: its end rounded up (a 16-bit range may end on a half-word: VK3 L7b, the review of
    // L7.4-L7.5's finding 1), within the memory's buffer (4-aligned, wg_memory_buffer). Not the bound range's end
    // (`size`): a big buffer's went past maxStorageBufferBindingSize (VK3 L8a, the track-end review's finding 2).
    let source: GPUBufferBinding, el0 = first;
    if (src && wide !== 2) {
      const el = wide ? 4 : 2, start = offset + first * el, from = start - (start % 256);
      const end = Math.min(src.size, Math.ceil((start + count * el) / 4) * 4);
      source = { buffer: src, offset: from, size: Math.max(4, end - from) };
      el0 = (start - from) / el;
    } else {
      this.dummyStorage ??= d.createBuffer({ size: 16, usage: STORAGE });
      source = { buffer: this.dummyStorage };
    }
    const [u, uat] = this.scratch(UNIFORM | COPY_DST, 32);
    d.queue.writeBuffer(u, uat, new Uint32Array([mode, wide, el0, prims, restart, count, 0, 0]));
    const group = d.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [
      { binding: 0, resource: source },
      { binding: 1, resource: { buffer: out, offset: at, size: bytes } },
      { binding: 2, resource: { buffer: u, offset: uat, size: 32 } },
    ] });
    const pass = enc.beginComputePass();
    pass.setPipeline(restart ? this.metaComputes.get('provokeRestart')! : pipeline);
    pass.setBindGroup(0, group);
    pass.dispatchWorkgroups(restart ? 1 : Math.min(65535, Math.ceil(prims / 64)));
    pass.end();
    this.tickets[ticket] = { buffer: out, offset: at, size: bytes };
  }

  /**
   * An indirect fan's draw, in a compute pass before the render pass (wg_gpu.h `gpu_fan_indirect`): its arguments are the
   * GPU's, so what they draw is worked out there. Arguments of an indexed draw for a list of triangles (Vulkan's
   * order, its provoking vertex first; restarts end a fan) of 32-bit indices, or, without an index buffer, for the
   * device's fan indices. One invocation walks it: nothing a program does every frame.
   */
  private fanIndirect(ticket: number, a: GPUBuffer, offset: number, ib: GPUBuffer, ibOffset: number, ibSize: number, wide: number, restart: number) {
    const d = this.device!, enc = this.enc!;
    let pipeline = this.metaComputes.get('fan');
    if (!pipeline) {
      const code = `struct P { arg: u32, el0: u32, wide: u32, restart: u32, most: u32, room: u32, pad1: u32, pad2: u32 }
@group(0) @binding(0) var<storage, read> a: array<u32>;
@group(0) @binding(1) var<storage, read> s: array<u32>;
@group(0) @binding(2) var<storage, read_write> o: array<u32>;
@group(0) @binding(3) var<storage, read_write> out: array<u32, 5>;
@group(0) @binding(4) var<uniform> p: P;
fn ix(k: u32) -> u32 {
  if (p.wide == 1u) { return s[k]; }
  return (s[k >> 1u] >> ((k & 1u) * 16u)) & 0xffffu;
}
@compute @workgroup_size(1) fn main() {
  if (p.wide == 2u) {
    let n = min(a[p.arg], p.most);
    out[0] = select(0u, (n - 2u) * 3u, n >= 3u);
    out[1] = a[p.arg + 1u];
    out[2] = 0u;
    out[3] = a[p.arg + 2u];
    out[4] = a[p.arg + 3u];
    return;
  }
  let count = min(min(a[p.arg], p.most - min(a[p.arg + 2u], p.most)), p.room);
  let first = p.el0 + a[p.arg + 2u];
  let r = select(0xffffu, 0xffffffffu, p.wide == 1u);
  var w = 0u;
  var run = 0u;
  var c = 0u;
  var b = 0u;
  for (var i = 0u; i < count; i++) {
    let x = ix(first + i);
    if (p.restart != 0u && x == r) { run = 0u; continue; }
    if (run == 0u) { c = x; }
    else if (run >= 2u) {
      o[w] = b; o[w + 1u] = x; o[w + 2u] = c;
      w += 3u;
    }
    b = x;
    run++;
  }
  out[0] = w;
  out[1] = a[p.arg + 1u];
  out[2] = 0u;
  out[3] = a[p.arg + 3u];
  out[4] = a[p.arg + 4u];
}`;
      const m = d.createShaderModule({ code });
      pipeline = d.createComputePipeline({ layout: 'auto', compute: { module: m, entryPoint: 'main' } });
      this.metaComputes.set('fan', pipeline);
    }
    const argFrom = offset - (offset % 256);
    const [out, at] = this.scratch(STORAGE | INDIRECT, 20);
    let source: GPUBufferBinding, el0 = 0, most: number, room = 0, list: GPUBuffer, listAt: number, listBytes: number;
    if (wide === 2) {
      this.dummyStorage ??= d.createBuffer({ size: 16, usage: STORAGE });
      source = { buffer: this.dummyStorage };
      most = ibSize / 12 + 2;
      list = ib;
      listAt = 0;
      listBytes = ibSize;
    } else {
      const el = wide ? 4 : 2, from = ibOffset - (ibOffset % 256);
      const end = Math.min(ib.size, from + this.device!.limits.maxStorageBufferBindingSize, Math.ceil((ibOffset + ibSize) / 4) * 4);
      source = { buffer: ib, offset: from, size: Math.max(4, end - from) };
      el0 = (ibOffset - from) / el;
      most = Math.floor((end - ibOffset) / el);
      room = fanMost(end - ibOffset, el);
      listBytes = Math.max(12, Math.max(0, room - 2) * 12);
      [list, listAt] = this.scratch(STORAGE | INDEX, listBytes);
    }
    const [u, uat] = this.scratch(UNIFORM | COPY_DST, 32);
    d.queue.writeBuffer(u, uat, new Uint32Array([(offset - argFrom) / 4, el0, wide, restart, most, room, 0, 0]));
    const dummy = (this.dummyWrite ??= d.createBuffer({ size: 16, usage: STORAGE }));
    const group = d.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [
      { binding: 0, resource: { buffer: a, offset: argFrom, size: Math.min(a.size - argFrom, 256 + 20) } },
      { binding: 1, resource: source },
      { binding: 2, resource: wide === 2 ? { buffer: dummy } : { buffer: list, offset: listAt, size: listBytes } },
      { binding: 3, resource: { buffer: out, offset: at, size: 20 } },
      { binding: 4, resource: { buffer: u, offset: uat, size: 32 } },
    ] });
    const pass = enc.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, group);
    pass.dispatchWorkgroups(1);
    pass.end();
    this.tickets[ticket] = { buffer: list, offset: listAt, size: listBytes, args: out, argsAt: at };
  }

  /**
   * A buffer's 16-bit packed texels into a packed format's rgba8unorm texture (wg_format.c `WG_FMT_PACKED`): `bpr` and
   * `rows` the buffer's, a compute pass unpacking them into a temporary buffer in the encoder's order, which is copied in.
   */
  private unpack(p: number[], b: GPUBuffer, offset: number, bpr: number, rows: number, t: GPUTexture, mip: number, x: number, y: number, z: number, w: number, h: number, depth: number) {
    const d = this.device!;
    const tb = Math.ceil((w * 4) / 256) * 256;
    const temp = d.createBuffer({ size: tb * h * depth, usage: STORAGE | COPY_SRC });
    this.temps.push(temp);
    this.packPass('unpack', p, b, offset, bpr, rows, temp, 0, tb, h, w, h, depth);
    this.enc!.copyBufferToTexture({ buffer: temp, bytesPerRow: tb, rowsPerImage: h }, this.texCopy(t, mip, x, y, z, 0), { width: w, height: h, depthOrArrayLayers: depth });
  }

  /** The other way: the texture's texels into a temporary buffer, packed from there into the buffer's. */
  private pack(p: number[], b: GPUBuffer, offset: number, bpr: number, rows: number, t: GPUTexture, mip: number, x: number, y: number, z: number, w: number, h: number, depth: number) {
    const d = this.device!;
    const tb = Math.ceil((w * 4) / 256) * 256;
    const temp = d.createBuffer({ size: tb * h * depth, usage: STORAGE | COPY_DST });
    this.temps.push(temp);
    this.enc!.copyTextureToBuffer(this.texCopy(t, mip, x, y, z, 0), { buffer: temp, bytesPerRow: tb, rowsPerImage: h }, { width: w, height: h, depthOrArrayLayers: depth });
    this.packPass('pack', p, temp, 0, tb, h, b, offset, bpr, rows, w, h, depth);
  }

  /** A copy between images of size-compatible formats, a packed one among them: the bits through a temporary buffer. */
  private copyPacked(ps: number[] | undefined, S: GPUTexture, sm: number, sx: number, sy: number, sz: number, pd: number[] | undefined, D: GPUTexture, dm: number, dx: number, dy: number, dz: number, w: number, h: number, depth: number) {
    const bpr = Math.ceil((w * 2) / 256) * 256;
    const temp = this.device!.createBuffer({ size: bpr * h * depth, usage: STORAGE | COPY_SRC | COPY_DST });
    this.temps.push(temp);
    const size = { width: w, height: h, depthOrArrayLayers: depth };
    if (ps) this.pack(ps, temp, 0, bpr, h, S, sm, sx, sy, sz, w, h, depth);
    else this.enc!.copyTextureToBuffer(this.texCopy(S, sm, sx, sy, sz, 0), { buffer: temp, bytesPerRow: bpr, rowsPerImage: h }, size);
    if (pd) this.unpack(pd, temp, 0, bpr, h, D, dm, dx, dy, dz, w, h, depth);
    else this.enc!.copyBufferToTexture({ buffer: temp, bytesPerRow: bpr, rowsPerImage: h }, this.texCopy(D, dm, dx, dy, dz, 0), size);
  }

  /** `unpack` or `pack`'s compute pass: an invocation a row, `w` texels each, each buffer's rows and images its own; 16-bit
   * words shared with neighbours written by atomics. */
  private packPass(way: 'pack' | 'unpack', p: number[], src: GPUBuffer, srcAt: number, srcBpr: number, srcRows: number, dst: GPUBuffer, dstAt: number, dstBpr: number, dstRows: number, w: number, h: number, depth: number) {
    const d = this.device!, enc = this.enc!;
    let pipeline = this.metaComputes.get(way);
    if (!pipeline) {
      const unpack = way === 'unpack';
      const code = `struct P { w: u32, src_at: u32, src_bpr: u32, src_rows: u32, dst_at: u32, dst_bpr: u32, dst_rows: u32, pad: u32, shift: vec4<u32>, bits: vec4<u32> }
@group(0) @binding(0) var<storage, read> s: array<u32>;
@group(0) @binding(1) var<storage, read_write> o: array<${unpack ? 'u32' : 'atomic<u32>'}>;
@group(0) @binding(2) var<uniform> p: P;
@compute @workgroup_size(1) fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let sa = p.src_at + (id.z * p.src_rows + id.y) * p.src_bpr;
  let da = p.dst_at + (id.z * p.dst_rows + id.y) * p.dst_bpr;
  for (var x = 0u; x < p.w; x++) {
${unpack ? `    let at = sa + x * 2u;
    let v = (s[at >> 2u] >> ((at & 2u) * 8u)) & 0xffffu;
    var out = 0u;
    for (var c = 0u; c < 4u; c++) {
      let m = (1u << p.bits[c]) - 1u;
      let k = select(255u, (((v >> p.shift[c]) & m) * 510u + m) / (2u * m), p.bits[c] != 0u);
      out |= k << (c * 8u);
    }
    o[(da + x * 4u) >> 2u] = out;` : `    let t = s[(sa + x * 4u) >> 2u];
    var v = 0u;
    for (var c = 0u; c < 4u; c++) {
      let m = (1u << p.bits[c]) - 1u;
      if (p.bits[c] != 0u) { v |= ((((t >> (c * 8u)) & 255u) * m * 2u + 255u) / 510u) << p.shift[c]; }
    }
    let at = da + x * 2u;
    let sh = (at & 2u) * 8u;
    atomicAnd(&o[at >> 2u], ~(0xffffu << sh));
    atomicOr(&o[at >> 2u], v << sh);`}
  }
}`;
      pipeline = d.createComputePipeline({ layout: 'auto', compute: { module: d.createShaderModule({ code }), entryPoint: 'main' } });
      this.metaComputes.set(way, pipeline);
    }
    const srcTexel = way === 'unpack' ? 2 : 4, dstTexel = way === 'unpack' ? 4 : 2;
    const range = (b: GPUBuffer, at: number, bpr: number, rows: number, texel: number) => {
      const from = at - (at % 256);
      const end = Math.min(b.size, Math.ceil((at + ((depth - 1) * rows + h - 1) * bpr + w * texel) / 4) * 4);
      return { from, binding: { buffer: b, offset: from, size: Math.min(end - from, d.limits.maxStorageBufferBindingSize) } };
    };
    const a = range(src, srcAt, srcBpr, srcRows, srcTexel), c = range(dst, dstAt, dstBpr, dstRows, dstTexel);
    const [u, uat] = this.scratch(UNIFORM | COPY_DST, 64);
    d.queue.writeBuffer(u, uat, new Uint32Array([w, srcAt - a.from, srcBpr, srcRows, dstAt - c.from, dstBpr, dstRows, 0, p[0], p[2], p[4], p[6], p[1], p[3], p[5], p[7]]));
    const group = d.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [
      { binding: 0, resource: a.binding }, { binding: 1, resource: c.binding }, { binding: 2, resource: { buffer: u, offset: uat, size: 64 } },
    ] });
    const pass = enc.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, group);
    pass.dispatchWorkgroups(1, h, depth);
    pass.end();
  }

  /** A copy between two ranges of one GPUBuffer (two VkBuffers of one VkDeviceMemory, or one's disjoint ranges), which
   * WebGPU refuses (VK3 L8a, the track-end review's finding 1: the submit was lost): through a temporary buffer. */
  private copyWithin(b: GPUBuffer, so: number, dO: number, size: number) {
    const temp = this.device!.createBuffer({ size, usage: COPY_SRC | COPY_DST });
    this.temps.push(temp);
    this.enc!.copyBufferToBuffer(b, so, temp, 0, size);
    this.enc!.copyBufferToBuffer(temp, 0, b, dO, size);
  }

  /** A copy within one subresource of a texture (Vulkan's regions apart; WebGPU refuses overlapping subresources: VK3
   * L8a, the track-end review's finding 1): through a temporary texture of the region's size. */
  private copyTextureWithin(t: GPUTexture, mip: number, sx: number, sy: number, sz: number, dx: number, dy: number, dz: number, w: number, h: number, depth: number, aspect: number) {
    const temp = this.device!.createTexture({ size: { width: w, height: h, depthOrArrayLayers: depth }, format: t.format, dimension: t.dimension, usage: TEX_COPY_SRC | TEX_COPY_DST });
    this.temps.push(temp);
    const size = { width: w, height: h, depthOrArrayLayers: depth };
    this.enc!.copyTextureToTexture(this.texCopy(t, mip, sx, sy, sz, aspect), this.texCopy(temp, 0, 0, 0, 0, aspect), size);
    this.enc!.copyTextureToTexture(this.texCopy(temp, 0, 0, 0, 0, aspect), this.texCopy(t, mip, dx, dy, dz, aspect), size);
  }

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

  /**
   * An occlusion query's 64-bit value at `src` of a buffer added to the one at `dst` (bytes, 8-aligned): what a clear
   * cut a query into, carried on in a spare slot (vk/driver/wg_cmd.c `OP_CLEAR_RECTS`). A compute pass of one
   * invocation, in the encoder's order.
   */
  private queryAdd(b: GPUBuffer, dst: number, src: number) {
    const d = this.device!, enc = this.enc!;
    let pipeline = this.metaComputes.get('queryAdd');
    if (!pipeline) {
      const code = `struct P { dst: u32, src: u32, pad0: u32, pad1: u32 }
@group(0) @binding(0) var<storage, read_write> q: array<u32>;
@group(0) @binding(1) var<uniform> p: P;
@compute @workgroup_size(1) fn main() {
  let a = q[p.dst];
  let lo = a + q[p.src];
  q[p.dst + 1u] = q[p.dst + 1u] + q[p.src + 1u] + select(0u, 1u, lo < a);
  q[p.dst] = lo;
}`;
      const m = d.createShaderModule({ code });
      pipeline = d.createComputePipeline({ layout: 'auto', compute: { module: m, entryPoint: 'main' } });
      this.metaComputes.set('queryAdd', pipeline);
    }
    const u = d.createBuffer({ size: 16, usage: UNIFORM, mappedAtCreation: true });
    new Uint32Array(u.getMappedRange()).set([dst / 4, src / 4, 0, 0]);
    u.unmap();
    this.temps.push(u);
    const group = d.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [
      { binding: 0, resource: { buffer: b } },
      { binding: 1, resource: { buffer: u } },
    ] });
    const pass = enc.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, group);
    pass.dispatchWorkgroups(1);
    pass.end();
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

/**
 * A multisampled image of several layers, which WebGPU hasn't: a multisampled texture a layer, standing in for one
 * texture wherever the worker takes a layer of it (views, `texCopy`). A view of several layers shows the first: a shader
 * can't sample such an image (WGSL has no multisampled arrays), and passes, copies and resolves go a layer at a time.
 */
class MsLayers {
  readonly width: number; readonly height: number; readonly depthOrArrayLayers: number;
  readonly format: GPUTextureFormat; readonly sampleCount: number; readonly usage: number;
  readonly dimension = '2d'; readonly mipLevelCount = 1;
  readonly layers: GPUTexture[] = [];
  constructor(d: GPUDevice, desc: GPUTextureDescriptor) {
    [this.width, this.height, this.depthOrArrayLayers] = desc.size as number[];
    this.format = desc.format; this.sampleCount = desc.sampleCount ?? 1; this.usage = desc.usage;
    for (let i = 0; i < this.depthOrArrayLayers; i++) this.layers.push(d.createTexture({ ...desc, size: [this.width, this.height] }));
  }
  createView(desc?: GPUTextureViewDescriptor) {
    return this.layers[desc?.baseArrayLayer ?? 0].createView({ ...desc, dimension: '2d', baseArrayLayer: 0, arrayLayerCount: 1 });
  }
  destroy() { for (const t of this.layers) t.destroy(); }
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
/** A view's format, where it isn't its texture's (undefined: the texture's own). */
const ownFormat = (t: GPUTexture, format: string | undefined) => (format && format !== t.format ? format : undefined);

/**
 * The indices an indirect indexed fan's list has room for: its count is on the GPU, so the worst case, of the bound
 * range, but no more than a fan may have (the bound range is often a whole shared buffer: VK4 R4, the review's X3); past that the fan is cut.
 */
export const fanMost = (bytes: number, el: number) => Math.min(Math.floor(bytes / el), 65536);

/** The swizzle of a copy between packed layouts (`[shift, bits]` of R, G, B, A; their textures are RGBA8): each channel
 * of the destination takes the source's whose bits are where its are. Undefined: no such channels. */
export function packedSwizzle(from?: number[], to?: number[]) {
  if (!from || !to) return undefined;
  let s = '';
  for (let c = 0; c < 4; c++) {
    if (!to[2 * c + 1]) { s += 'rgba'[c]; continue; }
    const k = [0, 1, 2, 3].find((i) => from[2 * i] === to[2 * c] && from[2 * i + 1] === to[2 * c + 1]);
    if (k === undefined) return undefined;
    s += 'rgba'[k];
  }
  return s;
}

/** A format's channels as raw bits: their number and size, how a texel's value is one, and their order in memory. */
function rawFormat(f: string) {
  const m = /^(bgra|rgba|rg|r)(8|16|32)(unorm|uint|sint|float)$/.exec(f);
  if (!m) return undefined;
  const size = Number(m[2]), order = m[1] === 'bgra' ? [2, 1, 0, 3] : [0, 1, 2, 3].slice(0, m[1].length);
  return { size, kind: m[3], order };
}

/**
 * WGSL taking `v` (a texel of `from`) to the same bits as a texel of `to`, for formats of one block size: channel by
 * channel to bits, to the block's two words, to `to`'s channels. '' for one format; undefined for what it doesn't take
 * apart. Floats go through values, so a NaN or a denormal of a float format may not keep its bits.
 */
export function bitsBetween(from: string, to: string) {
  if (from === to) return '';
  const a = rawFormat(from), b = rawFormat(to);
  if (!a || !b || a.size * a.order.length !== b.size * b.order.length || a.size * a.order.length > 64) return undefined;
  const mask = (n: number) => (n === 32 ? '0xffffffffu' : `${2 ** n - 1}u`);
  const raw = (c: number) => (a.kind === 'unorm' ? `u32(round(v[${c}] * ${2 ** a.size - 1}.0))` : a.kind === 'float' ? (a.size === 32 ? `bitcast<u32>(v[${c}])` : `pack2x16float(vec2<f32>(v[${c}], 0.0))`) : `(u32(v[${c}]) & ${mask(a.size)})`);
  const lines = ['var w = array<u32, 2>(0u, 0u);'];
  a.order.forEach((c, k) => {
    const at = k * a.size;
    lines.push(`w[${at >> 5}] |= ${raw(c)} << ${at & 31}u;`);
  });
  const out: string[] = ['0', '0', '0', '1'];
  const kind = b.kind === 'unorm' || b.kind === 'float' ? 'f32' : b.kind === 'uint' ? 'u32' : 'i32';
  if (kind !== 'f32') out[3] = '1';
  b.order.forEach((c, k) => {
    const at = k * b.size;
    const bits = `((w[${at >> 5}] >> ${at & 31}u) & ${mask(b.size)})`;
    out[c] = b.kind === 'unorm' ? `f32(${bits}) / ${2 ** b.size - 1}.0`
      : b.kind === 'float' ? (b.size === 32 ? `bitcast<f32>(${bits})` : `unpack2x16float(${bits}).x`)
      : b.kind === 'uint' ? bits : `(i32(${bits} << ${32 - b.size}u) >> ${32 - b.size}u)`;
  });
  lines.push(`return vec4<${kind}>(${out.map((x) => (/^[01]$/.test(x) ? (kind === 'f32' ? `${x}.0` : kind === 'u32' ? `${x}u` : x) : x)).join(', ')});`);
  return lines.join('\n  ');
}

/** Whether a render pass's capture jobs end in a capture still open: a cut of the pass divides it (VK4 R3, the review's R5). */
export const xfbOpen = (jobs: { op?: unknown }[]) => jobs.findLast((j) => j.op !== 'draw')?.op === 'begin';

/** A render pass's capture (`runXfb`): its buffers' places in `out` (by word; the counters its first 4). */
type XfbSession = { bufs: ({ guest: GPUBuffer; at: number; size: number; word: number } | null)[]; out: GPUBuffer };

/** A render pipeline's transform feedback (its JSON's `xfb`, wg_shader.c), and its compute pipelines once made (null: refused). */
type Xfb = {
  stride: number[]; base: number[]; words: number[][]; bgls: GPUBindGroupLayout[]; immediateSize: number; code: string | undefined;
  buffers: (Json | null)[];
  pipelines?: { main: GPUComputePipeline; advance: GPUComputePipeline; layout: GPUBindGroupLayout; slots: number[]; captured: number[] } | null;
};

/** A WebGPU vertex format's value as WGSL `vec4<T>` from the words `word(byte)` reads (transform feedback's fetch, VK3
 * L7.4); `undefined` for one it doesn't know. */
/** Vertex bindings a pipeline may pull (wg_private.h `WG_VERTEX_BINDINGS`); past them, the bytes each starts past its offset. */
const PULL_SLOTS = 16;

/** A render pipeline's vertex buffer as its JSON gives it (`pull`: read from a storage binding). */
type PulledBuffer = { pull?: boolean; arrayStride: number; stepMode: string; attributes: { format: string; offset: number; shaderLocation: number }[] };

/** What a vertex stage's entry point starts with where it takes vertex inputs (wgsl_print.c). */
const PULLED_ENTRY = 'iid: u32, i: In) -> Out {\n  wg_vs(vid, iid, i);';

/** A vertex stage's WGSL with the bindings marked `pull` (the render pipeline's JSON, by slot) read from storage
 * bindings of `group` (`pullBind`) instead of vertex buffers: its other attributes come in as before, in a struct of
 * their own (`In` no longer the entry point's, its @location attributes ignored), and `wg_vs` is given both. */
export function pulledCode(code: string, buffers: (PulledBuffer | null)[], group: number): string {
  const declared = [...code.matchAll(/^ {2}@location\((\d+)\) a\d+: vec4<(f32|i32|u32)>,$/gm)];
  const base: Record<number, string> = {};
  for (const m of declared) base[Number(m[1])] = m[2];
  const pulled = new Set<number>();
  const lines = [`@group(${group}) @binding(${PULL_SLOTS}) var<uniform> wgv_at: array<vec4<u32>, ${PULL_SLOTS / 4}>;`];
  let fetch = '';
  buffers.forEach((b, slot) => {
    if (!b?.pull) return;
    lines.push(`@group(${group}) @binding(${slot}) var<storage, read> wgv_b${slot}: array<u32>;`);
    lines.push(`fn wgv_ld${slot}(b: u32) -> u32 { let w = b >> 2u; let s = (b & 3u) * 8u; if (s == 0u) { return wgv_b${slot}[w]; } return (wgv_b${slot}[w] >> s) | (wgv_b${slot}[w + 1u] << (32u - s)); }`);
    for (const a of b.attributes) {
      pulled.add(a.shaderLocation);
      const at = `(wgv_at[${slot >> 2}u][${slot & 3}u] + ${b.stepMode === 'instance' ? 'iid' : 'vid'} * ${b.arrayStride}u + ${a.offset}u)`;
      fetch += `  i.a${a.shaderLocation} = ${vertexDecode(a.format, (k) => `wgv_ld${slot}(${at} + ${k}u)`, base[a.shaderLocation])};\n`;
    }
  });
  const kept = declared.filter((m) => !pulled.has(Number(m[1])));
  for (const m of kept) fetch += `  i.a${m[1]} = v.a${m[1]};\n`;
  if (kept.length) lines.push(`struct WgvIn {\n${kept.map((m) => m[0]).join('\n')}\n}`);
  lines.push(`fn wgv_fetch(vid: u32, iid: u32${kept.length ? ', v: WgvIn' : ''}) -> In {\n  var i: In;\n${fetch}  return i;\n}`);
  const entry = `iid: u32${kept.length ? ', v: WgvIn' : ''}) -> Out {\n  wg_vs(vid, iid, wgv_fetch(vid, iid${kept.length ? ', v' : ''}));`;
  return `${code.replace(PULLED_ENTRY, entry)}\n${lines.join('\n')}\n`;
}

export function vertexDecode(format: string, word: (byte: number) => string, T: string): string | undefined {
  const bgra = format.endsWith('-bgra');
  let comps: string[];
  if (format.startsWith('unorm10-10-10-2')) {
    const w = word(0);
    comps = [0, 10, 20].map((o) => `f32(extractBits(${w}, ${o}u, 10u)) / 1023.0`).concat(`f32(extractBits(${w}, 30u, 2u)) / 3.0`);
  } else {
    const m = /^(uint|sint|unorm|snorm|float)(8|16|32)(?:x([234]))?/.exec(format);
    if (!m) return undefined;
    const kind = m[1], bits = Number(m[2]), n = Number(m[3] ?? 1);
    comps = Array.from({ length: n }, (_, k) => {
      const w = bits === 32 ? word(4 * k) : bits === 16 ? word(4 * (k >> 1)) : word(0);
      const off = bits === 32 ? 0 : bits === 16 ? 16 * (k & 1) : 8 * k;
      const u = bits === 32 ? w : `extractBits(${w}, ${off}u, ${bits}u)`;
      const i = bits === 32 ? `bitcast<i32>(${w})` : `extractBits(bitcast<i32>(${w}), ${off}u, ${bits}u)`;
      switch (kind) {
        case 'uint': return u;
        case 'sint': return i;
        case 'unorm': return `f32(${u}) / ${2 ** bits - 1}.0`;
        case 'snorm': return `max(f32(${i}) / ${2 ** (bits - 1) - 1}.0, -1.0)`;
        default: return bits === 32 ? `bitcast<f32>(${w})` : `unpack2x16float(${u}).x`;
      }
    });
  }
  if (bgra) [comps[0], comps[2]] = [comps[2], comps[0]];
  const one = T === 'f32' ? '1.0' : T === 'i32' ? '1i' : '1u', zero = T === 'f32' ? '0.0' : T === 'i32' ? '0i' : '0u';
  return `vec4<${T}>(${[0, 1, 2, 3].map((k) => (comps[k] ? `${T}(${comps[k]})` : k === 3 ? one : zero)).join(', ')})`;
}

/** Linear filtering of a blit's source (`t`), clamped to its edges, for formats WebGPU doesn't filter. */
const BLIT_FILTER_2D = `fn at(x: i32, y: i32) -> vec4<f32> {
  return textureLoad(t, clamp(vec2<i32>(x, y), vec2<i32>(0), vec2<i32>(textureDimensions(t)) - 1), 0);
}
fn blit(uv: vec2<f32>) -> vec4<f32> {
  let c = uv * vec2<f32>(textureDimensions(t)) - 0.5;
  let b = vec2<i32>(floor(c));
  let f = c - floor(c);
  return mix(mix(at(b.x, b.y), at(b.x + 1, b.y), f.x), mix(at(b.x, b.y + 1), at(b.x + 1, b.y + 1), f.x), f.y);
}`;
const BLIT_FILTER_3D = `fn at(x: i32, y: i32, z: i32) -> vec4<f32> {
  return textureLoad(t, clamp(vec3<i32>(x, y, z), vec3<i32>(0), vec3<i32>(textureDimensions(t)) - 1), 0);
}
fn plane(b: vec3<i32>, f: vec2<f32>, z: i32) -> vec4<f32> {
  return mix(mix(at(b.x, b.y, z), at(b.x + 1, b.y, z), f.x), mix(at(b.x, b.y + 1, z), at(b.x + 1, b.y + 1, z), f.x), f.y);
}
fn blit(uv: vec2<f32>, w: f32) -> vec4<f32> {
  let c = vec3<f32>(uv, w) * vec3<f32>(textureDimensions(t)) - 0.5;
  let b = vec3<i32>(floor(c));
  let f = c - floor(c);
  return mix(plane(b, f.xy, b.z), plane(b, f.xy, b.z + 1), f.z);
}`;

/** A narrower integer format's limits, as WGSL's vector arguments. */
function integerRange(f: string): [string, string] | undefined {
  if (f === 'rgb10a2uint') return ['0', '1023, 1023, 1023, 3'];
  const m = /^r(?:g|gba)?(8|16)(u|s)int$/.exec(f);
  if (!m) return undefined;
  const bits = Number(m[1]);
  return m[2] === 'u' ? ['0', String(2 ** bits - 1)] : [String(-(2 ** (bits - 1))), String(2 ** (bits - 1) - 1)];
}

function sampleKind(f: string): 'f32' | 'u32' | 'i32' {
  return /uint$/.test(f) ? 'u32' : /sint$/.test(f) ? 'i32' : 'f32';
}

/** Every import, for the deviceless stubs. */
const IMPORTS = ['gpu_create', 'gpu_shader', 'gpu_destroy', 'gpu_grow', 'gpu_write', 'gpu_dirty', 'gpu_encoder', 'gpu_copy_bb', 'gpu_copy_bt', 'gpu_copy_tb', 'gpu_copy_tt', 'gpu_fill',
  'gpu_update', 'gpu_blit', 'gpu_render_pass', 'gpu_compute_pass', 'gpu_pass_end', 'gpu_set_pipeline', 'gpu_pull_buffer', 'gpu_pull_bind', 'gpu_set_bind_group', 'gpu_set_vertex_buffer',
  'gpu_set_index_buffer', 'gpu_set_viewport', 'gpu_set_scissor', 'gpu_set_blend_constant', 'gpu_set_stencil_reference', 'gpu_set_immediates', 'gpu_draw',
  'gpu_draw_indexed', 'gpu_draw_indirect', 'gpu_provoke', 'gpu_draw_ticket', 'gpu_fan_indirect', 'gpu_draw_ticket_indirect', 'gpu_xfb', 'gpu_dispatch', 'gpu_dispatch_indirect', 'gpu_clear_rects', 'gpu_begin_occlusion', 'gpu_end_occlusion',
  'gpu_resolve_queries', 'gpu_query_add', 'gpu_readback', 'gpu_submit', 'gpu_readback_copy', 'gpu_texture_import', 'gpu_translated', 'gpu_cache_get', 'gpu_cache_read', 'gpu_cache_put'];
