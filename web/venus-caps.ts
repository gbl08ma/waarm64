// What the Venus driver's device advertises and asks for (vk/driver/wg_caps.c): the adapter's features and limits as
// the driver takes them, the device request, and the check of the device's subgroups.
/** What the driver advertises follows (vk/driver/wg_caps.c): a device's features and limits, or a stand-in's in tests. */
export type GpuCaps = {
  readonly features: ReadonlySet<string>;
  readonly limits: object;
  readonly adapterInfo?: {
    readonly vendor: string;
    readonly subgroupMinSize?: number;
    readonly subgroupMaxSize?: number;
  };
};

/**
 * The adapter's maker (`GPUAdapterInfo.vendor`) as a PCI vendor ID, which the device reports as its own. Not NVIDIA's
 * (0x10de): Venus's guest driver (Mesa 26's vn_wsi.c) takes a device of that ID for Venus on NVIDIA's own driver,
 * which can't render to linear images, and makes its WSI copy every frame into a buffer it exports instead of the image
 * (the prime blit): the buffer isn't a texture web/venus-share.ts can share, so every Vulkan window was black on the
 * user's NVIDIA desktop (bench/vulkan/REPORT.md "VK3 L1"). An NVIDIA adapter is reported as an unknown maker (0).
 */
export const VENDORS: Record<string, number> = {
  apple: 0x106b,
  nvidia: 0,
  amd: 0x1002,
  ati: 0x1002,
  intel: 0x8086,
  google: 0x1ae0,
  arm: 0x13b5,
  qualcomm: 0x5143,
  'img-tec': 0x1010,
  imagination: 0x1010,
  microsoft: 0x1414,
  samsung: 0x144d,
};

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
const FEATURES = [
  'texture-compression-bc',
  'texture-compression-etc2',
  'texture-compression-astc',
  'depth32float-stencil8',
  'float32-filterable',
  'depth-clip-control',
  'dual-source-blending',
  'clip-distances',
  'indirect-first-instance',
  'texture-formats-tier1',
  'texture-formats-tier2',
  'rg11b10ufloat-renderable',
  'float32-blendable',
  'bgra8unorm-storage',
];

const MORE_FEATURES = ['subgroups', 'shader-f16', 'texture-component-swizzle', 'timestamp-query'];

export function gpuFeatures(caps: GpuCaps | undefined, device: boolean, hold: readonly string[] = []) {
  let flags = device ? 1 << 31 : 0;
  const has = (f: string) => !!caps?.features.has(f) && !hold.includes(f);
  FEATURES.forEach((f, i) => {
    if (has(f)) flags |= 1 << i;
  });
  if (caps && !hold.includes('tier1-storage')) flags |= 1 << FEATURES.length;
  MORE_FEATURES.forEach((f, i) => {
    if (has(f)) flags |= 1 << (FEATURES.length + 1 + i);
  });
  return flags;
}

/**
 * The limits the driver reports from (vk/driver/wg_private.h `struct wg_limits`, in its order), each with WebGPU's
 * default (what a device has unless asked for more; what the driver sees without one).
 */
export const LIMITS: [string, number][] = [
  ['maxTextureDimension1D', 8192],
  ['maxTextureDimension2D', 8192],
  ['maxTextureDimension3D', 2048],
  ['maxTextureArrayLayers', 256],
  ['maxBindGroups', 4],
  ['maxDynamicUniformBuffersPerPipelineLayout', 8],
  ['maxDynamicStorageBuffersPerPipelineLayout', 4],
  ['maxSampledTexturesPerShaderStage', 16],
  ['maxSamplersPerShaderStage', 16],
  ['maxStorageBuffersPerShaderStage', 8],
  ['maxStorageTexturesPerShaderStage', 4],
  ['maxUniformBuffersPerShaderStage', 12],
  ['maxUniformBufferBindingSize', 65536],
  ['maxStorageBufferBindingSize', 134217728],
  ['minUniformBufferOffsetAlignment', 256],
  ['minStorageBufferOffsetAlignment', 256],
  ['maxVertexBuffers', 8],
  ['maxBufferSize', 268435456],
  ['maxVertexAttributes', 16],
  ['maxVertexBufferArrayStride', 2048],
  ['maxInterStageShaderVariables', 16],
  ['maxColorAttachments', 8],
  ['maxComputeWorkgroupStorageSize', 16384],
  ['maxComputeInvocationsPerWorkgroup', 256],
  ['maxComputeWorkgroupSizeX', 256],
  ['maxComputeWorkgroupSizeY', 256],
  ['maxComputeWorkgroupSizeZ', 64],
  ['maxComputeWorkgroupsPerDimension', 65535],
  ['maxImmediateSize', 0],
  ['maxStorageBuffersInFragmentStage', 8],
  ['maxStorageTexturesInFragmentStage', 4],
  ['maxStorageBuffersInVertexStage', 8],
  ['maxStorageTexturesInVertexStage', 4],
  ['maxBindingsPerBindGroup', 1000],
  // Not a limit: the maker's PCI vendor ID (`VENDORS`), 0 for one this list doesn't know.
  ['vendorID', 0],
  // Not limits: the adapter's subgroup sizes (`GPUAdapterInfo`; 0 without `subgroups`).
  ['subgroupMinSize', 0],
  ['subgroupMaxSize', 0],
];

/** `LIMITS`' values of `caps` as venus_init takes them (32 bits each; the defaults where it has none). */
export function gpuLimits(caps: GpuCaps | undefined) {
  const l = (caps?.limits ?? {}) as Record<string, number | undefined>;
  // Immediates only where the browser has `setImmediates`, and at most the 128 bytes of Vulkan's push constants.
  const immediates =
    typeof GPURenderPassEncoder !== 'undefined' &&
    typeof (GPURenderPassEncoder.prototype as unknown as { setImmediates?: unknown }).setImmediates === 'function';
  // A stage's storage in the fragment and vertex stages: the per-stage limit where the browser predates the split.
  const fallback: Record<string, string> = {
    maxStorageBuffersInFragmentStage: 'maxStorageBuffersPerShaderStage',
    maxStorageTexturesInFragmentStage: 'maxStorageTexturesPerShaderStage',
    maxStorageBuffersInVertexStage: 'maxStorageBuffersPerShaderStage',
    maxStorageTexturesInVertexStage: 'maxStorageTexturesPerShaderStage',
  };
  return new Uint32Array(
    LIMITS.map(([k, d]) => {
      const v =
        k === 'maxImmediateSize'
          ? immediates
            ? Math.min(128, l[k] ?? 0)
            : 0
          : k === 'vendorID'
            ? (VENDORS[caps?.adapterInfo?.vendor.toLowerCase() ?? ''] ?? 0)
            : k === 'subgroupMinSize' || k === 'subgroupMaxSize'
              ? caps?.features.has('subgroups')
                ? (caps.adapterInfo?.[k] ?? 0)
                : 0
              : (l[k] ?? (fallback[k] ? l[fallback[k]] : undefined) ?? d);
      return Math.min(v, 0xffff_ffff);
    }),
  );
}

/**
 * Whether the device's subgroup operations are right in divergent control flow, as Vulkan's must be (VK3 L5): a
 * ballot, an election and a read of the first invocation in an `if` that only odd invocations take must see those
 * alone. Chromium on the M4's Metal (153 to 157 at least) computes those three with every invocation where they are the
 * `if`'s only other subgroup operations and their values are used past it (hoisted out of the `if`), which broke most
 * of dEQP-VK's subgroup cases there (bench/vulkan/REPORT.md "VK3 L5"), but not with an add of the subgroup in their
 * operands (`anchor`: the translator's WGSL_SUBGROUP_ANCHOR, vk/compiler/wgsl_print.c `SG_ANCHOR`; REPORT.md "VK4
 * backlog easy wins"). `right`: the plain kernel is right; `anchor`: only the anchored one; `wrong`: neither, and the
 * device advertises subgroups of one invocation (`hold`). Run once at Venus's start; a device without `subgroups`
 * passes untested.
 */
export async function subgroupsRight(device: GPUDevice): Promise<'right' | 'anchor' | 'wrong'> {
  if (!device.features.has('subgroups')) return 'right';
  if (await subgroupsKernel(device, false)) return 'right';
  return (await subgroupsKernel(device, true)) ? 'anchor' : 'wrong';
}

/** `subgroupsRight`'s kernel, plain or anchored as the translator prints it: whether an odd invocation's results are its odd invocations'. */
async function subgroupsKernel(device: GPUDevice, anchored: boolean): Promise<boolean> {
  const a = anchored ? '(subgroupAdd(1u) != 0u)' : '';
  const ballot = anchored ? `subgroupBallot(t & ${a})` : 'subgroupBallot(t)';
  const elect = anchored ? `${a} & subgroupElect()` : 'subgroupElect()';
  const up = (v: string, d: string) =>
    anchored ? `subgroupShuffle(${v}, inv - ${d})` : `subgroupShuffleUp(${v}, ${d})`;
  const first = (v: string) =>
    anchored ? `subgroupShuffle(${v}, subgroupBroadcastFirst(select(0u, inv, ${a})))` : `subgroupBroadcastFirst(${v})`;
  const code = `enable subgroups;
diagnostic(off, subgroup_uniformity);
@group(0) @binding(0) var<storage, read_write> o: array<u32>;
@compute @workgroup_size(128) fn main(@builtin(subgroup_invocation_id) inv: u32, @builtin(local_invocation_index) l: u32) {
  var t: bool = true;
  var b = vec4<u32>(0u);
  var e = false;
  var f = 0u;
  var n = 0u;
  if ((inv & 1u) == 1u) { b = ${ballot}; }
  if ((inv & 1u) == 1u) { e = ${elect}; }
  if ((inv & 1u) == 1u) { f = ${first('inv * 3u')}; }
  if ((inv & 1u) == 1u) { n = subgroupAdd(1u); }
  // A shuffle up by a delta that varies across the subgroup (Metal's shuffles take it uniform): 0 or 1.
  let s = ${up('inv * 5u + 7u', '((inv >> 2u) & 1u)')};
  o[512u + l] = s - 5u * (inv - ((inv >> 2u) & 1u));
  o[l * 4u] = b.x; o[l * 4u + 1u] = select(0u, 1u, e) | (inv << 1u); o[l * 4u + 2u] = f; o[l * 4u + 3u] = n;
}`;
  try {
    const module = device.createShaderModule({ code });
    const pipeline = await device.createComputePipelineAsync({
      layout: 'auto',
      compute: { module, entryPoint: 'main' },
    });
    const buf = device.createBuffer({ size: 128 * 20, usage: 0x80 | 0x4 /* STORAGE | COPY_SRC */ });
    const read = device.createBuffer({ size: 128 * 20, usage: 0x1 | 0x8 /* MAP_READ | COPY_DST */ });
    const enc = device.createCommandEncoder();
    const pass = enc.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(
      0,
      device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [{ binding: 0, resource: { buffer: buf } }],
      }),
    );
    pass.dispatchWorkgroups(1);
    pass.end();
    enc.copyBufferToBuffer(buf, 0, read, 0, 128 * 20);
    device.queue.submit([enc.finish()]);
    await read.mapAsync(1 /* GPUMapMode.READ */);
    const o = new Uint32Array(read.getMappedRange().slice(0));
    read.destroy();
    buf.destroy();
    for (let l = 0; l < 128; l++) {
      const [m, ei, f, n] = o.subarray(4 * l, 4 * l + 4),
        inv = ei >>> 1;
      // An odd invocation's ballot has odd invocations only (the first 32 of its subgroup), its add counts them, and
      // the first of them (its subgroup's invocation 1) is elected and read.
      // A shuffle up's value: invocation inv - delta's (7 more than 5 times its index).
      if (inv > 0 && o[512 + l] !== 7) return false;
      if (
        inv & 1 &&
        (m === 0 || (m & 0x55555555) !== 0 || n === 0 || n > 64 || (ei & 1) !== (inv === 1 ? 1 : 0) || f !== 3)
      )
        return false;
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
export const L9_LIMITS = [
  'maxStorageBuffersInVertexStage',
  'maxStorageTexturesInVertexStage',
  'maxBindingsPerBindGroup',
];

/** `?gpu=vkl9=…`'s values as suspects (`all` is every one; unknown names dropped). */
export function l9Suspects(values: readonly string[]): L9Suspect[] {
  return L9_SUSPECTS.filter((s) => values.includes(s) || values.includes('all'));
}

/** The features and limits to ask an adapter's device for: every one the driver uses, as far as the adapter goes. */
export function deviceRequest(
  adapter: GPUAdapter,
  options: { gpuTime?: boolean; l9?: readonly L9Suspect[] } = {},
): GPUDeviceDescriptor {
  const limits = adapter.limits as unknown as Record<string, number>;
  const requiredLimits: Record<string, number> = {};
  // The adapter's maker and subgroup sizes aren't limits (a browser that still lists subgroup sizes among its limits
  // refuses them asked for).
  const notLimits = [
    'vendorID',
    'subgroupMinSize',
    'subgroupMaxSize',
    ...(options.l9?.includes('limits') ? L9_LIMITS : []),
  ];
  for (const [k] of LIMITS) if (!notLimits.includes(k) && typeof limits[k] === 'number') requiredLimits[k] = limits[k];
  // Vulkan has no limit on a pass's attachments' bytes a sample: ask for the most.
  if (typeof limits.maxColorAttachmentBytesPerSample === 'number')
    requiredLimits.maxColorAttachmentBytesPerSample = limits.maxColorAttachmentBytesPerSample;
  const features = [...FEATURES, ...(options.l9?.includes('features') ? [] : MORE_FEATURES)].filter((f) =>
    adapter.features.has(f),
  ) as GPUFeatureName[];
  // `?gpu=vkgputime`: timestamp queries for the worker's own measurement (VK3 L2b), not the driver's.
  if (options.gpuTime && adapter.features.has('timestamp-query') && !features.includes('timestamp-query'))
    features.push('timestamp-query');
  return { requiredFeatures: features, requiredLimits };
}
