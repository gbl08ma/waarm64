/*
 * What the device advertises, from the browser's WebGPU device (docs/plans/graphics.md §2: the caps follow the
 * adapter): its optional features (`wg_features`) and limits (`wg_limits`), both venus_init's, from the GPU worker
 * (web/venus-gpu.ts `gpuFeatures`, `gpuLimits`). The mapping is VK0 A's (bench/vulkan/profiles/make.ts `direct`): the
 * direct rows of plan §4 only, less what the translator can't do yet, plus what Venus's WSI shares through. The
 * formats' features are wg_format.c's, from the same flags.
 */
#include <stdio.h>
#include <string.h>

#include "wg_private.h"

struct wg_limits wg_limits;

/* venus_init's: the device's features and limits (`count` words, as struct wg_limits): 0 if the count is another's. */
int
wg_caps_init(uint32_t features, const uint32_t *limits, uint32_t count)
{
   if (count * sizeof(uint32_t) != sizeof(wg_limits)) {
      fprintf(stderr, "venus: %u limits, not %zu\n", count, sizeof(wg_limits) / sizeof(uint32_t));
      return 0;
   }
   memcpy(&wg_limits, limits, sizeof(wg_limits));
   wg_features = features;
   wg_max_immediates = wg_limits.max_immediate_size;
   wg_format_init(features);
   return 1;
}

#define HAS(f) (!!(wg_features & WG_FEATURE_##f))

void
wg_caps_extensions(struct vk_device_extension_table *e)
{
   *e = (struct vk_device_extension_table){
      /* Venus's WSI (Mesa's common WSI in the guest, over dma-bufs) and what it shares through: dma-buf memory with
       * the LINEAR modifier, foreign queue transfers, sync-file semaphores (docs/devices.md "Venus"). */
      .KHR_swapchain = true,
      .KHR_swapchain_mutable_format = true,
      .KHR_incremental_present = true,
      .EXT_external_memory_dma_buf = true,
      .EXT_image_drm_format_modifier = true,
      .EXT_queue_family_foreign = true,
      .KHR_external_memory = true,
      .KHR_external_memory_fd = true,
      .KHR_external_semaphore = true,
      .KHR_external_semaphore_fd = true,
      .KHR_external_fence = true,
      .KHR_external_fence_fd = true,
      /* Promoted to 1.1-1.3 and backed (host-side bookkeeping, or what WebGPU has). */
      .KHR_bind_memory2 = true,
      .KHR_dedicated_allocation = true,
      .KHR_descriptor_update_template = true,
      .KHR_device_group = true,
      .KHR_get_memory_requirements2 = true,
      .KHR_maintenance1 = true,
      .KHR_maintenance2 = true,
      .KHR_maintenance3 = true,
      .KHR_maintenance4 = true,
      .KHR_relaxed_block_layout = true,
      .KHR_storage_buffer_storage_class = true,
      .KHR_create_renderpass2 = true,
      .KHR_depth_stencil_resolve = true,
      .KHR_driver_properties = true,
      .KHR_image_format_list = true,
      .KHR_imageless_framebuffer = true,
      .KHR_separate_depth_stencil_layouts = true,
      .KHR_shader_float_controls = true,
      .KHR_shader_subgroup_extended_types = true,
      .KHR_spirv_1_4 = true,
      .KHR_timeline_semaphore = true,
      .KHR_uniform_buffer_standard_layout = true,
      .KHR_vulkan_memory_model = true,
      .EXT_host_query_reset = true,
      .EXT_separate_stencil_usage = true,
      .KHR_copy_commands2 = true,
      .KHR_dynamic_rendering = true,
      /* NONE load and store ops: WebGPU's load and store (wg_cmd.c `load_op`). */
      .KHR_load_store_op_none = true,
      .EXT_load_store_op_none = true,
      .KHR_shader_integer_dot_product = true,
      .KHR_shader_non_semantic_info = true,
      .KHR_shader_terminate_invocation = true,
      .KHR_synchronization2 = true,
      .KHR_zero_initialize_workgroup_memory = true,
      .EXT_extended_dynamic_state = true,
      .EXT_extended_dynamic_state2 = true,
      .EXT_image_robustness = true,
      .EXT_pipeline_creation_cache_control = true,
      .EXT_pipeline_creation_feedback = true,
      .EXT_private_data = true,
      .EXT_shader_demote_to_helper_invocation = true,
      .EXT_tooling_info = true,
      /* Subgroups of one invocation (the translator has no subgroup operations yet): sized, so 1.3's control. */
      .EXT_subgroup_size_control = true,
      .EXT_depth_clip_enable = HAS(DEPTH_CLIP),
      /* Host-side only. */
      .KHR_push_descriptor = true,
      .EXT_memory_budget = true,
      .GOOGLE_decorate_string = true,
      .GOOGLE_hlsl_functionality1 = true,
      .GOOGLE_user_type = true,
      .KHR_shader_relaxed_extended_instruction = true,
      /* Not translated: 16-bit types (KHR_shader_float16_int8), inline uniform blocks (a bind group holds buffers, not
       * bytes), texel buffers (EXT_texel_buffer_alignment), YCbCr conversions (KHR_sampler_ycbcr_conversion). */
   };
}

void
wg_caps_features(struct vk_features *f)
{
   *f = (struct vk_features){
      .robustBufferAccess = true,
      .fullDrawIndexUint32 = true,
      .imageCubeArray = true,
      .independentBlend = true,
      .dualSrcBlend = HAS(DUAL_SOURCE),
      /* Without WebGPU's, an indirect draw with a first instance draws nothing. */
      .drawIndirectFirstInstance = HAS(INDIRECT_FIRST_INSTANCE),
      .depthClamp = HAS(DEPTH_CLIP),
      .depthBiasClamp = true,
      .samplerAnisotropy = true,
      .textureCompressionETC2 = HAS(ETC2),
      .textureCompressionASTC_LDR = HAS(ASTC),
      .textureCompressionBC = HAS(BC),
      .fragmentStoresAndAtomics = true,
      .shaderStorageImageExtendedFormats = HAS(TIER1_STORAGE),
      .shaderClipDistance = HAS(CLIP_DISTANCES),
      /* A tree of ifs over the elements (wgsl_nir.c); other arrays only with constant indices. */
      .shaderSampledImageArrayDynamicIndexing = true,
      .imagelessFramebuffer = true,
      .uniformBufferStandardLayout = true,
      .shaderSubgroupExtendedTypes = true,
      .separateDepthStencilLayouts = true,
      .hostQueryReset = true,
      .timelineSemaphore = true,
      .vulkanMemoryModel = true,
      .vulkanMemoryModelDeviceScope = true,
      .robustImageAccess = true,
      .pipelineCreationCacheControl = true,
      .privateData = true,
      .shaderDemoteToHelperInvocation = true,
      .shaderTerminateInvocation = true,
      .subgroupSizeControl = true,
      .computeFullSubgroups = true,
      .synchronization2 = true,
      .shaderZeroInitializeWorkgroupMemory = true,
      .dynamicRendering = true,
      .shaderIntegerDotProduct = true,
      .maintenance4 = true,
      .extendedDynamicState = true,
      .extendedDynamicState2 = true,
      .depthClipEnable = HAS(DEPTH_CLIP),
      /* No YCbCr conversions until they're translated (VK3): GTK4's Vulkan renderer then stays off and GTK draws on GL
       * (VK2 L7 measured it on Venus with them advertised and not honoured: black or near-empty frames, more CPU). */
   };
}

void
wg_caps_properties(struct vk_properties *p)
{
   const struct wg_limits *L = &wg_limits;
   const uint32_t sampled = L->max_sampled_textures, storage_tex = L->max_storage_textures;
   const uint32_t ubo = L->max_uniform_buffers, ssbo = L->max_storage_buffers;
   const uint32_t samples = VK_SAMPLE_COUNT_1_BIT | VK_SAMPLE_COUNT_4_BIT;
   /* WebGPU's buffers are ranges of one GPUBuffer a memory: an allocation is at most a buffer (and a 32-bit size). */
   const uint64_t max_buffer = MIN2((uint64_t)L->max_buffer_size, 0xffffffffu);

   p->deviceType = VK_PHYSICAL_DEVICE_TYPE_INTEGRATED_GPU; /* a GPU: libplacebo, GTK4 and wlroots turn CPUs away */
   /* The adapter's maker, as Venus on a native host passes its GPU's on (not Mesa's own ID: programs key quirks of
    * Mesa's software drivers on it). */
   p->vendorID = L->vendor_id;
   p->deviceID = 0;

   p->maxImageDimension1D = L->max_texture_1d;
   p->maxImageDimension2D = L->max_texture_2d;
   p->maxImageDimension3D = L->max_texture_3d;
   p->maxImageDimensionCube = L->max_texture_2d;
   p->maxImageArrayLayers = L->max_texture_array_layers;
   p->maxTexelBufferElements = MIN2(L->max_storage_buffer_binding_size / 16, 1u << 27);
   p->maxUniformBufferRange = L->max_uniform_buffer_binding_size;
   p->maxStorageBufferRange = L->max_storage_buffer_binding_size;
   /* Vulkan's minimum (past WebGPU's immediates they're read from a uniform buffer: wg_cmd.c). */
   p->maxPushConstantsSize = 128;
   p->maxMemoryAllocationCount = 4096;
   p->maxSamplerAllocationCount = 4000;
   p->bufferImageGranularity = 64;
   p->sparseAddressSpaceSize = 0;
   /* Sets 3 and up share bind group 3 (wg_shader.c). */
   p->maxBoundDescriptorSets = WGSL_MAX_SETS;
   p->maxPerStageDescriptorSamplers = L->max_samplers;
   p->maxPerStageDescriptorUniformBuffers = ubo;
   p->maxPerStageDescriptorStorageBuffers = ssbo;
   p->maxPerStageDescriptorSampledImages = sampled;
   p->maxPerStageDescriptorStorageImages = storage_tex;
   p->maxPerStageDescriptorInputAttachments = 4;
   /* Samplers aren't counted; a fragment shader's colour attachments are. */
   p->maxPerStageResources = sampled + storage_tex + ubo + ssbo + L->max_color_attachments;
   /* WebGPU counts per stage, Vulkan per layout: a layout whose bindings every stage sees gets one stage's. */
   p->maxDescriptorSetSamplers = L->max_samplers;
   p->maxDescriptorSetUniformBuffers = ubo;
   p->maxDescriptorSetUniformBuffersDynamic = L->max_dynamic_uniform_buffers;
   p->maxDescriptorSetStorageBuffers = ssbo;
   p->maxDescriptorSetStorageBuffersDynamic = L->max_dynamic_storage_buffers;
   p->maxDescriptorSetSampledImages = sampled;
   p->maxDescriptorSetStorageImages = storage_tex;
   p->maxDescriptorSetInputAttachments = 4;
   /* Attributes past their binding's stride take vertex buffer slots of their own (wg_vertex_slots). */
   p->maxVertexInputAttributes = MIN2(L->max_vertex_attributes, 16);
   p->maxVertexInputBindings = MIN2(L->max_vertex_buffers, 8);
   p->maxVertexInputAttributeOffset = L->max_vertex_buffer_array_stride - 1;
   p->maxVertexInputBindingStride = L->max_vertex_buffer_array_stride;
   p->maxVertexOutputComponents = 4 * L->max_inter_stage_shader_variables;
   p->maxFragmentInputComponents = 4 * L->max_inter_stage_shader_variables;
   p->maxFragmentOutputAttachments = L->max_color_attachments;
   p->maxFragmentDualSrcAttachments = HAS(DUAL_SOURCE) ? 1 : 0;
   p->maxFragmentCombinedOutputResources =
      L->max_color_attachments + L->max_storage_buffers_in_fragment_stage + L->max_storage_textures_in_fragment_stage;
   /* Less the translator's one workgroup var of its own (wgsl_print.c's wg_uc: 16 bytes as WebGPU counts it). */
   p->maxComputeSharedMemorySize = L->max_compute_workgroup_storage_size - 16;
   for (int i = 0; i < 3; i++)
      p->maxComputeWorkGroupCount[i] = L->max_compute_workgroups_per_dimension;
   p->maxComputeWorkGroupInvocations = L->max_compute_invocations_per_workgroup;
   p->maxComputeWorkGroupSize[0] = L->max_compute_workgroup_size_x;
   p->maxComputeWorkGroupSize[1] = L->max_compute_workgroup_size_y;
   p->maxComputeWorkGroupSize[2] = L->max_compute_workgroup_size_z;
   p->subPixelPrecisionBits = 4;
   p->subTexelPrecisionBits = 4;
   p->mipmapPrecisionBits = 4;
   p->maxDrawIndexedIndexValue = 0xffffffffu;
   p->maxDrawIndirectCount = 1;
   p->maxSamplerLodBias = 2; /* WebGPU's samplers have no bias, and nothing adds it yet (docs/backlog.md) */
   p->maxSamplerAnisotropy = 16;
   p->maxViewports = 1;
   p->maxViewportDimensions[0] = p->maxViewportDimensions[1] = L->max_texture_2d;
   p->viewportBoundsRange[0] = -2.0f * L->max_texture_2d;
   p->viewportBoundsRange[1] = 2.0f * L->max_texture_2d - 1;
   p->viewportSubPixelBits = 0;
   p->minMemoryMapAlignment = 64;
   p->minTexelBufferOffsetAlignment = L->min_storage_buffer_offset_alignment;
   p->minUniformBufferOffsetAlignment = L->min_uniform_buffer_offset_alignment;
   p->minStorageBufferOffsetAlignment = L->min_storage_buffer_offset_alignment;
   p->minTexelOffset = -8;
   p->maxTexelOffset = 7;
   p->minTexelGatherOffset = -8;
   p->maxTexelGatherOffset = 7;
   p->maxFramebufferWidth = L->max_texture_2d;
   p->maxFramebufferHeight = L->max_texture_2d;
   p->maxFramebufferLayers = MIN2(L->max_texture_array_layers, 256);
   p->framebufferColorSampleCounts = samples;
   p->framebufferDepthSampleCounts = samples;
   p->framebufferStencilSampleCounts = samples;
   p->framebufferNoAttachmentsSampleCounts = samples;
   p->maxColorAttachments = L->max_color_attachments;
   p->sampledImageColorSampleCounts = samples;
   p->sampledImageIntegerSampleCounts = samples;
   p->sampledImageDepthSampleCounts = samples;
   p->sampledImageStencilSampleCounts = samples;
   p->storageImageSampleCounts = VK_SAMPLE_COUNT_1_BIT;
   p->maxSampleMaskWords = 1;
   p->timestampComputeAndGraphics = true;
   p->timestampPeriod = 1;
   p->maxClipDistances = HAS(CLIP_DISTANCES) ? 8 : 0;
   p->maxCombinedClipAndCullDistances = HAS(CLIP_DISTANCES) ? 8 : 0;
   p->discreteQueuePriorities = 2;
   p->pointSizeRange[0] = p->pointSizeRange[1] = 1;
   p->lineWidthRange[0] = p->lineWidthRange[1] = 1;
   p->standardSampleLocations = true;
   p->optimalBufferCopyOffsetAlignment = 256;
   p->optimalBufferCopyRowPitchAlignment = 256;
   p->nonCoherentAtomSize = 64;

   /* Subgroups of one invocation: the basic operations only, until the translator maps WebGPU's `subgroups`. */
   p->subgroupSize = 1;
   p->subgroupSupportedStages = VK_SHADER_STAGE_COMPUTE_BIT;
   p->subgroupSupportedOperations = VK_SUBGROUP_FEATURE_BASIC_BIT;
   p->minSubgroupSize = p->maxSubgroupSize = 1;
   p->maxComputeWorkgroupSubgroups = L->max_compute_invocations_per_workgroup;
   p->requiredSubgroupSizeStages = VK_SHADER_STAGE_COMPUTE_BIT;
   p->maxPerSetDescriptors = 1024;
   p->maxMemoryAllocationSize = max_buffer;
   p->maxBufferSize = max_buffer;

   p->supportedDepthResolveModes = VK_RESOLVE_MODE_SAMPLE_ZERO_BIT;
   p->supportedStencilResolveModes = VK_RESOLVE_MODE_SAMPLE_ZERO_BIT;
   /* As the image formats' (WebGPU multisamples its 8-, 16- and 32-bit single-channel integer formats). */
   p->framebufferIntegerColorSampleCounts = samples;
   p->maxTimelineSemaphoreValueDifference = 2147483647;
   p->storageTexelBufferOffsetAlignmentBytes = L->min_storage_buffer_offset_alignment;
   p->uniformTexelBufferOffsetAlignmentBytes = L->min_storage_buffer_offset_alignment;
}
