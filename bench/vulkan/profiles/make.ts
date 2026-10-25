// VK0's question A (docs/plans/graphics.md §5 "A"; bench/vulkan/REPORT.md): the Vulkan a WebGPU adapter backs, as
// Khronos Vulkan Profiles JSON for the Profiles layer (tools/vulkan-tools/build-profiles.sh), made from the adapters'
// features and limits in bench/gpu/results/ (the G0 suite's JSON: the Mac's Metal adapter and the dev VM's
// SwiftShader). Each file holds the direct profile (§4's "Direct" and "adapter's features" rows) and one profile per
// emulated row added to it (`_gs`, `_tess`, `_xfb`, `_largepoints`, `_vpstores`, `_mdi`, `_rgb`, `_all`).
//   node bench/vulkan/profiles/make.ts        writes webgpu-mac.json and webgpu-swiftshader.json beside this file
//                                             and prints where the direct profiles fall below Vulkan 1.3's minimums
// Run a program through one:
//   VK_LAYER_PATH=target/vulkan-tools/profiles/share/vulkan/explicit_layer.d VK_INSTANCE_LAYERS=VK_LAYER_KHRONOS_profiles
//   VK_KHRONOS_PROFILES_PROFILE_FILE=bench/vulkan/profiles/webgpu-mac.json VK_KHRONOS_PROFILES_PROFILE_NAME=VP_WEBPC_webgpu_mac
//   VK_KHRONOS_PROFILES_SIMULATE_CAPABILITIES=SIMULATE_API_VERSION_BIT,SIMULATE_FEATURES_BIT,SIMULATE_PROPERTIES_BIT,SIMULATE_EXTENSIONS_BIT,SIMULATE_FORMATS_BIT
//   VK_KHRONOS_PROFILES_DEFAULT_FEATURE_VALUES=DEFAULT_FEATURE_VALUES_FALSE <program>
// (bench/vulkan/profiles/run.sh does that, with the layer that bench/vulkan/profiles/build-layer.sh builds.) The layer
// reports what the profile says, features and formats included, even where the driver (lavapipe) lacks them; run.sh
// turns off the two features lavapipe 26.2 lacks (ETC2 and ASTC LDR) for runs.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

type Json = Record<string, unknown>;
type Adapter = { name: string; label: string; features: Set<string>; limits: Record<string, number>; identity: Json };

const HERE = fileURLToPath(new URL('.', import.meta.url));
const ROOT = fileURLToPath(new URL('../../..', import.meta.url));

function adapter(file: string, name: string, label: string, identity: Json): Adapter {
  const d = JSON.parse(readFileSync(ROOT + file, 'utf8')) as { results: { params: { features: string[]; limits: Record<string, number> } }[] };
  const p = d.results[0].params;
  return { name, label, features: new Set(p.features), limits: p.limits, identity };
}

// What the guest would see through Venus: "Virtio-GPU Venus (<host device>)" and the host's IDs. The stock layer
// can't change a device's identity; target/vk0a/profiles is the layer with vendorID, deviceID, deviceType and
// deviceName made modifiable (run.sh uses it). Both report a GPU: lavapipe's CPU type makes GTK4 refuse Vulkan by
// itself, and the translator chooses what it reports (SwiftShader's adapter is a fallback adapter in WebGPU).
const mac = adapter('bench/gpu/results/2026-10-01-mac-m4-metal.json', 'mac', "the Mac's Metal adapter (Apple M4, Chromium)", {
  deviceName: 'Virtio-GPU Venus (WebGPU Apple metal-3)', deviceType: 1 /* INTEGRATED_GPU */, vendorID: 0x106b, deviceID: 0x1a0,
});
const swiftshader = adapter('bench/gpu/results/2026-10-01-vm-swiftshader.json', 'swiftshader', "the dev VM's SwiftShader adapter (Chromium)", {
  deviceName: 'Virtio-GPU Venus (WebGPU SwiftShader)', deviceType: 1 /* INTEGRATED_GPU */, vendorID: 0x1ae0, deviceID: 0xc0de,
});

// ---- Formats: WebGPU's texture formats and their capabilities (the spec's table), as Vulkan formats and features.
// caps: F filterable float, U unfilterable float (filterable with float32-filterable), I integer, R render
// attachment, B blendable (float32-blendable for 32-bit floats), M multisample, V resolve, S storage (core),
// S1/S2 storage with texture-formats-tier1/tier2, T1 render+blend+multisample+resolve with tier1, D depth, X stencil,
// C copyable (depth24plus isn't; depth32float is copy-source only, written by a draw instead).
type Fmt = { vk: string; caps: string; feature?: string };
const COLOR: Fmt[] = [
  { vk: 'R8_UNORM', caps: 'F R B M V S1 C' }, { vk: 'R8_SNORM', caps: 'F T1 S1 C' },
  { vk: 'R8_UINT', caps: 'I R M S1 C' }, { vk: 'R8_SINT', caps: 'I R M S1 C' },
  { vk: 'R16_UINT', caps: 'I R M S1 C' }, { vk: 'R16_SINT', caps: 'I R M S1 C' }, { vk: 'R16_SFLOAT', caps: 'F R B M V S1 C' },
  { vk: 'R16_UNORM', caps: 'F T1 S1 C', feature: 'texture-formats-tier1' }, { vk: 'R16_SNORM', caps: 'F T1 S1 C', feature: 'texture-formats-tier1' },
  { vk: 'R8G8_UNORM', caps: 'F R B M V S1 C' }, { vk: 'R8G8_SNORM', caps: 'F T1 S1 C' },
  { vk: 'R8G8_UINT', caps: 'I R M S1 C' }, { vk: 'R8G8_SINT', caps: 'I R M S1 C' },
  { vk: 'R32_UINT', caps: 'I R M S C' }, { vk: 'R32_SINT', caps: 'I R M S C' }, { vk: 'R32_SFLOAT', caps: 'U R B M S C' },
  { vk: 'R16G16_UINT', caps: 'I R M S1 C' }, { vk: 'R16G16_SINT', caps: 'I R M S1 C' }, { vk: 'R16G16_SFLOAT', caps: 'F R B M V S1 C' },
  { vk: 'R16G16_UNORM', caps: 'F T1 S1 C', feature: 'texture-formats-tier1' }, { vk: 'R16G16_SNORM', caps: 'F T1 S1 C', feature: 'texture-formats-tier1' },
  { vk: 'R8G8B8A8_UNORM', caps: 'F R B M V S C' }, { vk: 'R8G8B8A8_SRGB', caps: 'F R B M V C' }, { vk: 'R8G8B8A8_SNORM', caps: 'F T1 S C' },
  { vk: 'R8G8B8A8_UINT', caps: 'I R M S C' }, { vk: 'R8G8B8A8_SINT', caps: 'I R M S C' },
  { vk: 'B8G8R8A8_UNORM', caps: 'F R B M V C' }, { vk: 'B8G8R8A8_SRGB', caps: 'F R B M V C' },
  { vk: 'E5B9G9R9_UFLOAT_PACK32', caps: 'F C' },
  { vk: 'A2B10G10R10_UINT_PACK32', caps: 'I R M S1 C' }, { vk: 'A2B10G10R10_UNORM_PACK32', caps: 'F R B M V S1 C' },
  { vk: 'B10G11R11_UFLOAT_PACK32', caps: 'F S1 C' },
  { vk: 'R32G32_UINT', caps: 'I R S C' }, { vk: 'R32G32_SINT', caps: 'I R S C' }, { vk: 'R32G32_SFLOAT', caps: 'U R B S C' },
  { vk: 'R16G16B16A16_UINT', caps: 'I R M S C' }, { vk: 'R16G16B16A16_SINT', caps: 'I R M S C' }, { vk: 'R16G16B16A16_SFLOAT', caps: 'F R B M V S C' },
  { vk: 'R16G16B16A16_UNORM', caps: 'F T1 S1 C', feature: 'texture-formats-tier1' }, { vk: 'R16G16B16A16_SNORM', caps: 'F T1 S1 C', feature: 'texture-formats-tier1' },
  { vk: 'R32G32B32A32_UINT', caps: 'I R S C' }, { vk: 'R32G32B32A32_SINT', caps: 'I R S C' }, { vk: 'R32G32B32A32_SFLOAT', caps: 'U R B S C' },
];
// Read-write storage (tier2's list, and core's r32 formats): what an image both read and written in a shader needs.
const DEPTH: Fmt[] = [
  { vk: 'S8_UINT', caps: 'X M C' }, { vk: 'D16_UNORM', caps: 'D M C' }, { vk: 'X8_D24_UNORM_PACK32', caps: 'D M' },
  { vk: 'D24_UNORM_S8_UINT', caps: 'D X M' }, { vk: 'D32_SFLOAT', caps: 'D M Csrc' },
  { vk: 'D32_SFLOAT_S8_UINT', caps: 'D X M Csrc', feature: 'depth32float-stencil8' },
];
const BC = ['BC1_RGBA_UNORM_BLOCK', 'BC1_RGBA_SRGB_BLOCK', 'BC2_UNORM_BLOCK', 'BC2_SRGB_BLOCK', 'BC3_UNORM_BLOCK', 'BC3_SRGB_BLOCK',
  'BC4_UNORM_BLOCK', 'BC4_SNORM_BLOCK', 'BC5_UNORM_BLOCK', 'BC5_SNORM_BLOCK', 'BC6H_UFLOAT_BLOCK', 'BC6H_SFLOAT_BLOCK', 'BC7_UNORM_BLOCK', 'BC7_SRGB_BLOCK'];
const ETC2 = ['ETC2_R8G8B8_UNORM_BLOCK', 'ETC2_R8G8B8_SRGB_BLOCK', 'ETC2_R8G8B8A1_UNORM_BLOCK', 'ETC2_R8G8B8A1_SRGB_BLOCK',
  'ETC2_R8G8B8A8_UNORM_BLOCK', 'ETC2_R8G8B8A8_SRGB_BLOCK', 'EAC_R11_UNORM_BLOCK', 'EAC_R11_SNORM_BLOCK', 'EAC_R11G11_UNORM_BLOCK', 'EAC_R11G11_SNORM_BLOCK'];
const ASTC = ['4x4', '5x4', '5x5', '6x5', '6x6', '8x5', '8x6', '8x8', '10x5', '10x6', '10x8', '10x10', '12x10', '12x12']
  .flatMap((b) => [`ASTC_${b}_UNORM_BLOCK`, `ASTC_${b}_SRGB_BLOCK`]);
// Vertex formats WebGPU has (no 3-component 8- or 16-bit ones, no scaled ones).
const VERTEX = [
  ...['R8', 'R8G8', 'R8G8B8A8', 'R16', 'R16G16', 'R16G16B16A16'].flatMap((c) => ['UINT', 'SINT', 'UNORM', 'SNORM'].map((t) => `${c}_${t}`)),
  'R16_SFLOAT', 'R16G16_SFLOAT', 'R16G16B16A16_SFLOAT',
  ...['R32', 'R32G32', 'R32G32B32', 'R32G32B32A32'].flatMap((c) => ['UINT', 'SINT', 'SFLOAT'].map((t) => `${c}_${t}`)),
  'A2B10G10R10_UNORM_PACK32', 'B8G8R8A8_UNORM',
];
// The emulated row "formats WebGPU lacks": 3-component 8- and 16-bit formats as vertex input (the shader fetches) and
// as images (converted to 4 components when written), R32G32B32 as an image.
const RGB_IMAGES = ['R8G8B8_UNORM', 'R8G8B8_SRGB', 'B8G8R8_UNORM', 'B8G8R8_SRGB', 'R8G8B8_UINT', 'R8G8B8_SINT', 'R8G8B8_SNORM',
  'R16G16B16_UNORM', 'R16G16B16_SNORM', 'R16G16B16_UINT', 'R16G16B16_SINT', 'R16G16B16_SFLOAT', 'R32G32B32_UINT', 'R32G32B32_SINT', 'R32G32B32_SFLOAT'];
const RGB_VERTEX = ['R8G8B8_UNORM', 'R8G8B8_SNORM', 'R8G8B8_UINT', 'R8G8B8_SINT', 'B8G8R8_UNORM',
  'R16G16B16_UNORM', 'R16G16B16_SNORM', 'R16G16B16_UINT', 'R16G16B16_SINT', 'R16G16B16_SFLOAT'];

const F = (s: string) => `VK_FORMAT_FEATURE_${s}`;
type FormatProps = { linearTilingFeatures?: string[]; optimalTilingFeatures?: string[]; bufferFeatures?: string[] };

function formats(a: Adapter, emulated: boolean): Record<string, Json> {
  const out: Record<string, FormatProps> = {};
  const has = (f?: string) => !f || a.features.has(f);
  const tier1 = a.features.has('texture-formats-tier1');
  const add = (vk: string, k: keyof FormatProps, flags: string[]) => {
    const e = (out['VK_FORMAT_' + vk] ??= {});
    e[k] = [...new Set([...(e[k] ?? []), ...flags.map(F)])];
  };
  for (const f of COLOR) {
    if (!has(f.feature)) continue;
    const c = new Set(f.caps.split(' '));
    const filter = c.has('F') || (c.has('U') && a.features.has('float32-filterable'));
    const t1 = c.has('T1') && tier1;
    const render = c.has('R') || t1 || (f.vk === 'B10G11R11_UFLOAT_PACK32' && a.features.has('rg11b10ufloat-renderable'));
    const blend = (c.has('B') && (!c.has('U') || a.features.has('float32-blendable'))) || t1
      || (f.vk === 'B10G11R11_UFLOAT_PACK32' && a.features.has('rg11b10ufloat-renderable'));
    const storage = c.has('S') || (c.has('S1') && tier1) || (f.vk === 'B8G8R8A8_UNORM' && a.features.has('bgra8unorm-storage'));
    const opt = ['SAMPLED_IMAGE_BIT', 'BLIT_SRC_BIT', 'TRANSFER_SRC_BIT', 'TRANSFER_DST_BIT'];
    if (filter) opt.push('SAMPLED_IMAGE_FILTER_LINEAR_BIT');
    if (render) opt.push('COLOR_ATTACHMENT_BIT', 'BLIT_DST_BIT');
    if (render && blend) opt.push('COLOR_ATTACHMENT_BLEND_BIT');
    if (storage) opt.push('STORAGE_IMAGE_BIT');
    add(f.vk, 'optimalTilingFeatures', opt);
    // Linear images are the host-visible ones: sampled and copied, not attachments.
    add(f.vk, 'linearTilingFeatures', opt.filter((x) => !x.startsWith('COLOR_ATTACHMENT') && x !== 'BLIT_DST_BIT' && x !== 'STORAGE_IMAGE_BIT'));
    // Texel buffers have no WebGPU counterpart: a storage buffer the shader decodes (a rewrite §4 doesn't list).
    add(f.vk, 'bufferFeatures', storage ? ['UNIFORM_TEXEL_BUFFER_BIT', 'STORAGE_TEXEL_BUFFER_BIT'] : ['UNIFORM_TEXEL_BUFFER_BIT']);
  }
  for (const f of DEPTH) {
    if (!has(f.feature)) continue;
    const c = new Set(f.caps.split(' '));
    const opt = ['SAMPLED_IMAGE_BIT', 'DEPTH_STENCIL_ATTACHMENT_BIT', 'BLIT_SRC_BIT'];
    if (c.has('D')) opt.push('SAMPLED_IMAGE_FILTER_LINEAR_BIT');
    if (c.has('C')) opt.push('TRANSFER_SRC_BIT', 'TRANSFER_DST_BIT');
    if (c.has('Csrc')) opt.push('TRANSFER_SRC_BIT');
    add(f.vk, 'optimalTilingFeatures', opt);
  }
  const compressed = [
    ...(a.features.has('texture-compression-bc') ? BC : []),
    ...(a.features.has('texture-compression-etc2') ? ETC2 : []),
    ...(a.features.has('texture-compression-astc') ? ASTC : []),
  ];
  for (const vk of compressed) add(vk, 'optimalTilingFeatures', ['SAMPLED_IMAGE_BIT', 'SAMPLED_IMAGE_FILTER_LINEAR_BIT', 'BLIT_SRC_BIT', 'TRANSFER_SRC_BIT', 'TRANSFER_DST_BIT']);
  for (const vk of VERTEX) add(vk, 'bufferFeatures', ['VERTEX_BUFFER_BIT']);
  if (emulated) {
    for (const vk of RGB_VERTEX) add(vk, 'bufferFeatures', ['VERTEX_BUFFER_BIT']);
    for (const vk of RGB_IMAGES) {
      const flt = !/INT$/.test(vk);
      const opt = ['SAMPLED_IMAGE_BIT', 'BLIT_SRC_BIT', 'TRANSFER_SRC_BIT', 'TRANSFER_DST_BIT', ...(flt ? ['SAMPLED_IMAGE_FILTER_LINEAR_BIT'] : [])];
      add(vk, 'optimalTilingFeatures', opt);
      add(vk, 'linearTilingFeatures', opt);
    }
  }
  const res: Record<string, Json> = {};
  for (const [k, v] of Object.entries(out)) res[k] = { VkFormatProperties: { linearTilingFeatures: [], optimalTilingFeatures: [], bufferFeatures: [], ...v } };
  return res;
}

// ---- Features, properties, extensions.
const S = (n: number[]) => n.map((x) => `VK_SAMPLE_COUNT_${x}_BIT`);

function direct(a: Adapter): Json {
  const L = a.limits;
  const has = (f: string) => a.features.has(f);
  const sampled = L.maxSampledTexturesPerShaderStage, storageTex = L.maxStorageTexturesPerShaderStage;
  const ubo = L.maxUniformBuffersPerShaderStage, ssbo = L.maxStorageBuffersPerShaderStage;
  const subgroups = has('subgroups');
  const subgroupSize = a.name === 'mac' ? 32 : 4; // Metal's SIMD width; SwiftShader's 4-wide lanes
  const extensions = [
    // WSI: Mesa's common WSI in the guest's Venus driver, over dma-bufs.
    'VK_KHR_swapchain', 'VK_KHR_swapchain_mutable_format', 'VK_KHR_incremental_present',
    'VK_EXT_external_memory_dma_buf', 'VK_EXT_image_drm_format_modifier', 'VK_EXT_queue_family_foreign',
    'VK_KHR_external_memory', 'VK_KHR_external_memory_fd', 'VK_KHR_external_semaphore', 'VK_KHR_external_semaphore_fd',
    'VK_KHR_external_fence', 'VK_KHR_external_fence_fd',
    // Promoted to 1.1-1.3 and backed (host-side bookkeeping, or what WebGPU has).
    'VK_KHR_bind_memory2', 'VK_KHR_dedicated_allocation', 'VK_KHR_descriptor_update_template', 'VK_KHR_device_group',
    'VK_KHR_get_memory_requirements2', 'VK_KHR_maintenance1', 'VK_KHR_maintenance2', 'VK_KHR_maintenance3', 'VK_KHR_maintenance4',
    'VK_KHR_relaxed_block_layout', 'VK_KHR_storage_buffer_storage_class',
    'VK_KHR_create_renderpass2', 'VK_KHR_depth_stencil_resolve', 'VK_KHR_driver_properties', 'VK_KHR_image_format_list',
    'VK_KHR_imageless_framebuffer', 'VK_KHR_separate_depth_stencil_layouts', 'VK_KHR_shader_float_controls',
    'VK_KHR_shader_subgroup_extended_types', 'VK_KHR_spirv_1_4', 'VK_KHR_timeline_semaphore', 'VK_KHR_uniform_buffer_standard_layout',
    'VK_KHR_vulkan_memory_model', 'VK_EXT_host_query_reset', 'VK_EXT_separate_stencil_usage',
    'VK_KHR_copy_commands2', 'VK_KHR_dynamic_rendering', 'VK_KHR_shader_integer_dot_product', 'VK_KHR_shader_non_semantic_info',
    'VK_KHR_shader_terminate_invocation', 'VK_KHR_synchronization2', 'VK_KHR_zero_initialize_workgroup_memory',
    'VK_EXT_extended_dynamic_state', 'VK_EXT_extended_dynamic_state2', 'VK_EXT_image_robustness', 'VK_EXT_inline_uniform_block',
    'VK_EXT_pipeline_creation_cache_control', 'VK_EXT_pipeline_creation_feedback', 'VK_EXT_private_data',
    'VK_EXT_shader_demote_to_helper_invocation', 'VK_EXT_texel_buffer_alignment', 'VK_EXT_tooling_info',
    ...(subgroups ? ['VK_EXT_subgroup_size_control'] : []),
    ...(has('shader-f16') ? ['VK_KHR_shader_float16_int8'] : []),
    ...(has('depth-clip-control') ? ['VK_EXT_depth_clip_enable'] : []),
    // Host-side only.
    'VK_KHR_push_descriptor', 'VK_EXT_memory_budget', 'VK_GOOGLE_decorate_string', 'VK_GOOGLE_hlsl_functionality1',
    'VK_GOOGLE_user_type', 'VK_KHR_shader_relaxed_extended_instruction',
  ];
  return {
    extensions: Object.fromEntries(extensions.map((e) => [e, 1])),
    features: {
      VkPhysicalDeviceFeatures: {
        robustBufferAccess: true, fullDrawIndexUint32: true, imageCubeArray: true, independentBlend: true,
        dualSrcBlend: has('dual-source-blending'), drawIndirectFirstInstance: has('indirect-first-instance'),
        depthClamp: has('depth-clip-control'), depthBiasClamp: true, samplerAnisotropy: true,
        textureCompressionETC2: has('texture-compression-etc2'), textureCompressionASTC_LDR: has('texture-compression-astc'),
        textureCompressionBC: has('texture-compression-bc'), occlusionQueryPrecise: false, fragmentStoresAndAtomics: true,
        shaderStorageImageExtendedFormats: has('texture-formats-tier1'), shaderClipDistance: has('clip-distances'),
      },
      VkPhysicalDeviceVulkan11Features: { shaderDrawParameters: false, multiview: false },
      VkPhysicalDeviceVulkan12Features: {
        shaderFloat16: has('shader-f16'), imagelessFramebuffer: true, uniformBufferStandardLayout: true,
        shaderSubgroupExtendedTypes: subgroups, separateDepthStencilLayouts: true, hostQueryReset: true, timelineSemaphore: true,
        vulkanMemoryModel: true, vulkanMemoryModelDeviceScope: true, subgroupBroadcastDynamicId: subgroups,
      },
      VkPhysicalDeviceVulkan13Features: {
        robustImageAccess: true, inlineUniformBlock: true, pipelineCreationCacheControl: true, privateData: true,
        shaderDemoteToHelperInvocation: true, shaderTerminateInvocation: true, subgroupSizeControl: subgroups && has('subgroup-size-control'),
        computeFullSubgroups: subgroups && has('subgroup-size-control'), synchronization2: true, shaderZeroInitializeWorkgroupMemory: true,
        dynamicRendering: true, shaderIntegerDotProduct: true, maintenance4: true,
      },
      VkPhysicalDeviceExtendedDynamicStateFeaturesEXT: { extendedDynamicState: true },
      VkPhysicalDeviceExtendedDynamicState2FeaturesEXT: { extendedDynamicState2: true },
      ...(has('depth-clip-control') ? { VkPhysicalDeviceDepthClipEnableFeaturesEXT: { depthClipEnable: true } } : {}),
    },
    properties: {
      VkPhysicalDeviceProperties: {
        ...a.identity,
        limits: {
          maxImageDimension1D: L.maxTextureDimension1D, maxImageDimension2D: L.maxTextureDimension2D,
          maxImageDimension3D: L.maxTextureDimension3D, maxImageDimensionCube: L.maxTextureDimension2D,
          maxImageArrayLayers: L.maxTextureArrayLayers, maxTexelBufferElements: Math.min(L.maxStorageBufferBindingSize / 16, 1 << 27),
          maxUniformBufferRange: L.maxUniformBufferBindingSize, maxStorageBufferRange: L.maxStorageBufferBindingSize,
          maxPushConstantsSize: 128, maxMemoryAllocationCount: 4096, maxSamplerAllocationCount: 4000,
          bufferImageGranularity: 64, sparseAddressSpaceSize: 0, maxBoundDescriptorSets: L.maxBindGroups,
          maxPerStageDescriptorSamplers: L.maxSamplersPerShaderStage, maxPerStageDescriptorUniformBuffers: ubo,
          maxPerStageDescriptorStorageBuffers: ssbo, maxPerStageDescriptorSampledImages: sampled,
          maxPerStageDescriptorStorageImages: storageTex, maxPerStageDescriptorInputAttachments: 4,
          // Samplers aren't counted; a fragment shader's color attachments are.
          maxPerStageResources: sampled + storageTex + ubo + ssbo + L.maxColorAttachments,
          // WebGPU counts per stage, Vulkan per layout: a layout whose bindings are visible to every stage gets one stage's.
          maxDescriptorSetSamplers: L.maxSamplersPerShaderStage, maxDescriptorSetUniformBuffers: ubo,
          maxDescriptorSetUniformBuffersDynamic: L.maxDynamicUniformBuffersPerPipelineLayout, maxDescriptorSetStorageBuffers: ssbo,
          maxDescriptorSetStorageBuffersDynamic: L.maxDynamicStorageBuffersPerPipelineLayout, maxDescriptorSetSampledImages: sampled,
          maxDescriptorSetStorageImages: storageTex, maxDescriptorSetInputAttachments: 4,
          maxVertexInputAttributes: L.maxVertexAttributes, maxVertexInputBindings: L.maxVertexBuffers,
          maxVertexInputAttributeOffset: L.maxVertexBufferArrayStride - 1, maxVertexInputBindingStride: L.maxVertexBufferArrayStride,
          maxVertexOutputComponents: 4 * L.maxInterStageShaderVariables,
          maxTessellationGenerationLevel: 0, maxTessellationPatchSize: 0, maxTessellationControlPerVertexInputComponents: 0,
          maxTessellationControlPerVertexOutputComponents: 0, maxTessellationControlPerPatchOutputComponents: 0,
          maxTessellationControlTotalOutputComponents: 0, maxTessellationEvaluationInputComponents: 0,
          maxTessellationEvaluationOutputComponents: 0, maxGeometryShaderInvocations: 0, maxGeometryInputComponents: 0,
          maxGeometryOutputComponents: 0, maxGeometryOutputVertices: 0, maxGeometryTotalOutputComponents: 0,
          maxFragmentInputComponents: 4 * L.maxInterStageShaderVariables, maxFragmentOutputAttachments: L.maxColorAttachments,
          maxFragmentDualSrcAttachments: has('dual-source-blending') ? 1 : 0,
          maxFragmentCombinedOutputResources: L.maxColorAttachments + L.maxStorageBuffersInFragmentStage + L.maxStorageTexturesInFragmentStage,
          maxComputeSharedMemorySize: L.maxComputeWorkgroupStorageSize,
          maxComputeWorkGroupCount: [L.maxComputeWorkgroupsPerDimension, L.maxComputeWorkgroupsPerDimension, L.maxComputeWorkgroupsPerDimension],
          maxComputeWorkGroupInvocations: L.maxComputeInvocationsPerWorkgroup,
          maxComputeWorkGroupSize: [L.maxComputeWorkgroupSizeX, L.maxComputeWorkgroupSizeY, L.maxComputeWorkgroupSizeZ],
          subPixelPrecisionBits: 4, subTexelPrecisionBits: 4, mipmapPrecisionBits: 4,
          maxDrawIndexedIndexValue: 4294967295, maxDrawIndirectCount: 1,
          maxSamplerLodBias: 2, // WebGPU samplers have no bias: the shader adds it (textureSampleBias)
          maxSamplerAnisotropy: 16, maxViewports: 1,
          maxViewportDimensions: [L.maxTextureDimension2D, L.maxTextureDimension2D],
          viewportBoundsRange: [-2 * L.maxTextureDimension2D, 2 * L.maxTextureDimension2D - 1], viewportSubPixelBits: 0,
          minMemoryMapAlignment: 64, minTexelBufferOffsetAlignment: L.minStorageBufferOffsetAlignment,
          minUniformBufferOffsetAlignment: L.minUniformBufferOffsetAlignment, minStorageBufferOffsetAlignment: L.minStorageBufferOffsetAlignment,
          minTexelOffset: -8, maxTexelOffset: 7, minTexelGatherOffset: -8, maxTexelGatherOffset: 7,
          minInterpolationOffset: 0, maxInterpolationOffset: 0, subPixelInterpolationOffsetBits: 0,
          maxFramebufferWidth: L.maxTextureDimension2D, maxFramebufferHeight: L.maxTextureDimension2D,
          maxFramebufferLayers: Math.min(L.maxTextureArrayLayers, 256),
          framebufferColorSampleCounts: S([1, 4]), framebufferDepthSampleCounts: S([1, 4]), framebufferStencilSampleCounts: S([1, 4]),
          framebufferNoAttachmentsSampleCounts: S([1, 4]), maxColorAttachments: L.maxColorAttachments,
          sampledImageColorSampleCounts: S([1, 4]), sampledImageIntegerSampleCounts: S([1, 4]), sampledImageDepthSampleCounts: S([1, 4]),
          sampledImageStencilSampleCounts: S([1, 4]), storageImageSampleCounts: S([1]), maxSampleMaskWords: 1,
          timestampComputeAndGraphics: has('timestamp-query'), timestampPeriod: 1,
          maxClipDistances: has('clip-distances') ? 8 : 0, maxCullDistances: 0, maxCombinedClipAndCullDistances: has('clip-distances') ? 8 : 0,
          discreteQueuePriorities: 2, pointSizeRange: [1, 1], lineWidthRange: [1, 1], pointSizeGranularity: 0, lineWidthGranularity: 0,
          strictLines: false, standardSampleLocations: true, optimalBufferCopyOffsetAlignment: 256,
          optimalBufferCopyRowPitchAlignment: 256, nonCoherentAtomSize: 64,
        },
      },
      VkPhysicalDeviceVulkan11Properties: {
        subgroupSize: subgroups ? subgroupSize : 1,
        subgroupSupportedStages: subgroups ? ['VK_SHADER_STAGE_COMPUTE_BIT', 'VK_SHADER_STAGE_FRAGMENT_BIT'] : ['VK_SHADER_STAGE_COMPUTE_BIT'],
        subgroupSupportedOperations: subgroups
          ? ['BASIC', 'VOTE', 'ARITHMETIC', 'BALLOT', 'SHUFFLE', 'SHUFFLE_RELATIVE', 'QUAD'].map((o) => `VK_SUBGROUP_FEATURE_${o}_BIT`)
          : ['VK_SUBGROUP_FEATURE_BASIC_BIT'],
        subgroupQuadOperationsInAllStages: false, maxMultiviewViewCount: 0, maxMultiviewInstanceIndex: 0,
        maxPerSetDescriptors: 1024, maxMemoryAllocationSize: Math.min(L.maxBufferSize, 0xffffffff),
      },
      VkPhysicalDeviceVulkan12Properties: {
        supportedDepthResolveModes: ['VK_RESOLVE_MODE_SAMPLE_ZERO_BIT'], supportedStencilResolveModes: ['VK_RESOLVE_MODE_SAMPLE_ZERO_BIT'],
        independentResolveNone: false, independentResolve: false, filterMinmaxSingleComponentFormats: false,
        filterMinmaxImageComponentMapping: false, framebufferIntegerColorSampleCounts: S([1]),
        maxTimelineSemaphoreValueDifference: 2147483647,
      },
      VkPhysicalDeviceVulkan13Properties: {
        minSubgroupSize: subgroups ? subgroupSize : 1, maxSubgroupSize: subgroups ? (a.name === 'mac' ? 32 : 4) : 1,
        maxComputeWorkgroupSubgroups: subgroups ? L.maxComputeInvocationsPerWorkgroup / subgroupSize : 0,
        requiredSubgroupSizeStages: subgroups ? ['VK_SHADER_STAGE_COMPUTE_BIT'] : [],
        maxInlineUniformBlockSize: 256, maxPerStageDescriptorInlineUniformBlocks: 4, maxPerStageDescriptorUpdateAfterBindInlineUniformBlocks: 0,
        maxDescriptorSetInlineUniformBlocks: 4, maxDescriptorSetUpdateAfterBindInlineUniformBlocks: 0, maxInlineUniformTotalSize: 1024,
        storageTexelBufferOffsetAlignmentBytes: L.minStorageBufferOffsetAlignment, storageTexelBufferOffsetSingleTexelAlignment: false,
        uniformTexelBufferOffsetAlignmentBytes: L.minStorageBufferOffsetAlignment, uniformTexelBufferOffsetSingleTexelAlignment: false,
        maxBufferSize: L.maxBufferSize,
      },
    },
    formats: formats(a, false),
  };
}

// The emulated rows of §4, each a capability block added to the direct one.
const ROWS: Record<string, { label: string; cap: (a: Adapter) => Json }> = {
  gs: {
    label: 'geometry shaders (a compute pre-pass)',
    cap: () => ({
      features: { VkPhysicalDeviceFeatures: { geometryShader: true } },
      properties: { VkPhysicalDeviceProperties: { limits: {
        maxGeometryShaderInvocations: 32, maxGeometryInputComponents: 64, maxGeometryOutputComponents: 64,
        maxGeometryOutputVertices: 256, maxGeometryTotalOutputComponents: 1024 } } },
    }),
  },
  tess: {
    label: 'tessellation (a compute pre-pass)',
    cap: () => ({
      features: { VkPhysicalDeviceFeatures: { tessellationShader: true } },
      properties: { VkPhysicalDeviceProperties: { limits: {
        maxTessellationGenerationLevel: 64, maxTessellationPatchSize: 32, maxTessellationControlPerVertexInputComponents: 64,
        maxTessellationControlPerVertexOutputComponents: 64, maxTessellationControlPerPatchOutputComponents: 120,
        maxTessellationControlTotalOutputComponents: 2048, maxTessellationEvaluationInputComponents: 64,
        maxTessellationEvaluationOutputComponents: 64 } } },
    }),
  },
  xfb: {
    label: 'transform feedback (the vertex shader run as compute)',
    cap: () => ({
      extensions: { VK_EXT_transform_feedback: 1 },
      features: { VkPhysicalDeviceTransformFeedbackFeaturesEXT: { transformFeedback: true, geometryStreams: false } },
      properties: { VkPhysicalDeviceTransformFeedbackPropertiesEXT: {
        maxTransformFeedbackStreams: 1, maxTransformFeedbackBuffers: 4, maxTransformFeedbackBufferSize: 4294967295,
        maxTransformFeedbackStreamDataSize: 512, maxTransformFeedbackBufferDataSize: 512, maxTransformFeedbackBufferDataStride: 2048,
        transformFeedbackQueries: true, transformFeedbackStreamsLinesTriangles: false,
        transformFeedbackRasterizationStreamSelect: false, transformFeedbackDraw: true } },
    }),
  },
  largepoints: {
    label: 'large points (a quad per point)',
    cap: () => ({
      features: { VkPhysicalDeviceFeatures: { largePoints: true } },
      properties: { VkPhysicalDeviceProperties: { limits: { pointSizeRange: [1, 256], pointSizeGranularity: 0.125 } } },
    }),
  },
  vpstores: {
    label: 'vertexPipelineStoresAndAtomics (the vertex shader as compute)',
    cap: () => ({ features: { VkPhysicalDeviceFeatures: { vertexPipelineStoresAndAtomics: true } } }),
  },
  mdi: {
    label: 'multiDrawIndirect and drawIndirectCount (a pass writes the indirect buffer)',
    cap: () => ({
      extensions: { VK_KHR_draw_indirect_count: 1 },
      features: { VkPhysicalDeviceFeatures: { multiDrawIndirect: true }, VkPhysicalDeviceVulkan12Features: { drawIndirectCount: true } },
      properties: { VkPhysicalDeviceProperties: { limits: { maxDrawIndirectCount: 4294967295 } } },
    }),
  },
  ycbcr: {
    label: 'samplerYcbcrConversion (planes sampled and converted in the shader; GTK4 asserts it with dma-bufs)',
    cap: () => {
      const opt = ['SAMPLED_IMAGE_BIT', 'SAMPLED_IMAGE_FILTER_LINEAR_BIT', 'TRANSFER_SRC_BIT', 'TRANSFER_DST_BIT', 'MIDPOINT_CHROMA_SAMPLES_BIT',
        'COSITED_CHROMA_SAMPLES_BIT', 'SAMPLED_IMAGE_YCBCR_CONVERSION_LINEAR_FILTER_BIT', 'DISJOINT_BIT'].map(F);
      const fmts = ['G8_B8R8_2PLANE_420_UNORM', 'G8_B8_R8_3PLANE_420_UNORM', 'G10X6_B10X6R10X6_2PLANE_420_UNORM_3PACK16',
        'G16_B16R16_2PLANE_420_UNORM', 'G8B8G8R8_422_UNORM', 'B8G8R8G8_422_UNORM'];
      return {
        extensions: { VK_KHR_sampler_ycbcr_conversion: 14 },
        features: { VkPhysicalDeviceVulkan11Features: { samplerYcbcrConversion: true } },
        formats: Object.fromEntries(fmts.map((f) => ['VK_FORMAT_' + f, { VkFormatProperties: { linearTilingFeatures: opt, optimalTilingFeatures: opt, bufferFeatures: [] } }])),
      };
    },
  },
  // Rows found in step 2 (what a program fell back over that §4 doesn't list).
  provoking: {
    label: 'last-vertex provoking (VK_EXT_provoking_vertex: indices rotated, or the flat value fetched in the shader)',
    cap: () => ({
      extensions: { VK_EXT_provoking_vertex: 1 },
      features: { VkPhysicalDeviceProvokingVertexFeaturesEXT: { provokingVertexLast: true, transformFeedbackPreservesProvokingVertex: false } },
      properties: { VkPhysicalDeviceProvokingVertexPropertiesEXT: { provokingVertexModePerPipeline: true, transformFeedbackPreservesTriangleFanProvokingVertex: false } },
    }),
  },
  ubo: {
    label: 'uniform buffers past WebGPU\'s 12 a stage (the rest as read-only storage buffers)',
    cap: () => ({ properties: { VkPhysicalDeviceProperties: { limits: { maxPerStageDescriptorUniformBuffers: 15, maxDescriptorSetUniformBuffers: 72 } } } }),
  },
  arrays: {
    label: 'dynamically indexed descriptor arrays (a switch over separate bindings)',
    cap: () => ({ features: { VkPhysicalDeviceFeatures: { shaderUniformBufferArrayDynamicIndexing: true, shaderSampledImageArrayDynamicIndexing: true,
      shaderStorageBufferArrayDynamicIndexing: true, shaderStorageImageArrayDynamicIndexing: true } } }),
  },
  samplerate: {
    label: 'sampleRateShading (WGSL per-sample interpolation; interpolateAt* from derivatives)',
    cap: () => ({
      features: { VkPhysicalDeviceFeatures: { sampleRateShading: true } },
      properties: { VkPhysicalDeviceProperties: { limits: { minInterpolationOffset: -0.5, maxInterpolationOffset: 0.4375, subPixelInterpolationOffsetBits: 4 } } },
    }),
  },
  drawparams: {
    label: 'shaderDrawParameters (base vertex, base instance, draw index from immediates; indirect draws patched by a pass)',
    cap: () => ({ extensions: { VK_KHR_shader_draw_parameters: 1 }, features: { VkPhysicalDeviceVulkan11Features: { shaderDrawParameters: true } } }),
  },
  rgb: { label: '3-component formats (converted when written, fetched by the shader)', cap: (a) => ({ formats: formats(a, true) }) },
};

function profileFile(a: Adapter): Json {
  const base = `VP_WEBPC_webgpu_${a.name}`;
  const capabilities: Record<string, Json> = { [`${a.name}_direct`]: direct(a) };
  for (const [k, r] of Object.entries(ROWS)) capabilities[`${a.name}_${k}`] = r.cap(a);
  const mk = (name: string, label: string, caps: string[]) => [name, {
    version: 1, 'api-version': '1.3.296', label, description: `${label}: the Vulkan ${a.label} backs (webpc VK0, question A).`,
    contributors: { webpc: { company: 'webpc', contact: false } }, history: [{ revision: 1, date: '2026-10-25', author: 'webpc', comment: 'VK0 A' }],
    capabilities: caps.map((c) => `${a.name}_${c}`),
  }];
  const profiles = Object.fromEntries([
    mk(base, `WebGPU ${a.name}, direct`, ['direct']),
    ...Object.entries(ROWS).map(([k, r]) => mk(`${base}_${k}`, `WebGPU ${a.name}, direct + ${r.label}`, ['direct', k])),
    // Combinations: run.sh's PROFILE=<adapter>:<row>+<row> makes its own from these capability blocks.
    mk(`${base}_all`, `WebGPU ${a.name}, direct + every emulated row`, ['direct', ...Object.keys(ROWS)]),
  ]);
  return { $schema: 'https://schema.khronos.org/vulkan/profiles-0.8.2-304.json#', capabilities, profiles };
}

// ---- Where the direct profile falls below Vulkan 1.3's minimums (LunarG's minimum-requirements profile, which the
// Profiles source carries; target/vulkan-tools/profiles-src).
function gaps(a: Adapter) {
  const req = JSON.parse(readFileSync(ROOT + 'target/vulkan-tools/profiles-src/profiles/LunarG/VP_LUNARG_minimum_requirements.json', 'utf8')) as { capabilities: Record<string, Json> };
  const d = direct(a) as { features: Record<string, Record<string, boolean>>; properties: { VkPhysicalDeviceProperties: { limits: Record<string, unknown> } } };
  const out: string[] = [];
  const alias: Record<string, string> = { VkPhysicalDeviceMultiviewFeatures: 'VkPhysicalDeviceVulkan11Features' };
  for (const c of ['vulkan10requirements', 'vulkan11requirements', 'vulkan12requirements', 'vulkan13requirements']) {
    const cap = req.capabilities[c] as { features?: Record<string, Record<string, boolean>>; properties?: Record<string, Record<string, unknown>> };
    for (const [s, fs] of Object.entries(cap.features ?? {}))
      for (const [f, v] of Object.entries(fs)) if (v && !d.features[alias[s] ?? s]?.[f]) out.push(`${c}: feature ${f}`);
    const lim = (cap.properties?.VkPhysicalDeviceProperties as { limits?: Record<string, unknown> } | undefined)?.limits ?? {};
    for (const [k, v] of Object.entries(lim)) {
      const ours = d.properties.VkPhysicalDeviceProperties.limits[k];
      if (typeof v === 'number' && typeof ours === 'number') {
        const lower = /Alignment$|Granularity$|^nonCoherentAtomSize$/.test(k);
        const worse = /^min(Texel|TexelGather|Interpolation)Offset$/.test(k) ? ours > v : lower ? ours > v : ours < v;
        if (worse) out.push(`${c}: limit ${k} ${ours} (Vulkan ${v})`);
      }
    }
  }
  return out;
}

for (const a of [mac, swiftshader]) {
  writeFileSync(`${HERE}webgpu-${a.name}.json`, JSON.stringify(profileFile(a), null, 1) + '\n');
  console.log(`webgpu-${a.name}.json: below Vulkan 1.3's minimums:\n  ${gaps(a).join('\n  ')}`);
}
