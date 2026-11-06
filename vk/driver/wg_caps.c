/*
 * What the device advertises, from the browser's WebGPU device (docs/plans/graphics.md §2: the caps follow the
 * adapter): its optional features (`wg_features`) and limits (`wg_limits`), both venus_init's, from the GPU worker
 * (web/venus-gpu.ts `gpuFeatures`, `gpuLimits`). The mapping is VK0 A's (bench/vulkan/profiles/make.ts `direct`): the
 * direct rows of docs/graphics.md "What maps, what's emulated, what isn't offered" only, less what the translator can't do yet, plus what Venus's WSI shares through. The
 * formats' features are wg_format.c's, from the same flags.
 */
#include <stdio.h>
#include <string.h>

#include "wg_private.h"

struct wg_limits wg_limits;

/* The storage buffers a stage gives uniform buffers past WebGPU's (wg_caps_properties). */
#define WG_FOLDED_UBOS 2

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

/* WGSL's subgroups have the adapter's size, which a shader can't choose: real subgroups only where the adapter has one
 * size (SwiftShader's 4, Apple's and NVIDIA's 32), that a ballot's 128 bits hold. Elsewhere (sizes that vary, as on
 * Intel's and AMD's) subgroups of one invocation, as before WGSL had subgroups (VK3 L5). */
uint32_t
wg_subgroup_size(void)
{
   const uint32_t lo = wg_limits.subgroup_min_size, hi = wg_limits.subgroup_max_size;
   if (!HAS(SUBGROUPS) || lo != hi || lo < 4 || lo > 128 || (lo & (lo - 1)))
      return 1;
   return lo;
}

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
      /* 1.4's: the *2 commands, index buffer ranges, VkBindMemoryStatus, VK_REMAINING_ARRAY_LAYERS in copies, shader
       * modules chained to a stage (Mesa's runtime), the flags2 words (VK4 T24). A8_UNORM and A1B5G5R5 aren't offered
       * (wg_format.c: no WebGPU format; VK4 T30). */
      .KHR_maintenance5 = true,
      .KHR_maintenance6 = true,
      /* Offsets that aren't constants from fetches (wgsl_sampler.c `dynamic_offset`), depth and stencil copied with
       * colour formats of their size through a buffer (web/venus-gpu.ts `colorDepthStencil`), blits between a 3D
       * image's slices and an array's layers, SPIR-V's SRem and SMod (WGSL's `%` and the printer's imod). */
      .KHR_maintenance8 = true,
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
      /* Pipeline state as variants (VK4 T28): every draw's pipeline is keyed by the state it draws with (wg_cmd.c
       * `draw_key`, from Mesa's dynamic state), so the states WebGPU's pipelines hold can be dynamic; of the third
       * set, those the key reads. A depth bias is in the format's units only (WebGPU's integer `depthBias`). */
      .EXT_extended_dynamic_state3 = true,
      .EXT_vertex_input_dynamic_state = true,
      .EXT_depth_bias_control = true,
      /* A cube's linear filter kept to the face from fetches (wgsl_sampler.c, VK4 T28). */
      .EXT_non_seamless_cube_map = true,
      .EXT_image_robustness = true,
      .EXT_pipeline_creation_cache_control = true,
      .EXT_pipeline_creation_feedback = true,
      .EXT_private_data = true,
      .EXT_shader_demote_to_helper_invocation = true,
      .EXT_tooling_info = true,
      /* Subgroups of one size (wg_subgroup_size), so 1.3's control. */
      .EXT_subgroup_size_control = true,
      .EXT_depth_clip_enable = HAS(DEPTH_CLIP),
      /* Host-side only. */
      .KHR_push_descriptor = true,
      .EXT_memory_budget = true,
      .GOOGLE_decorate_string = true,
      .GOOGLE_hlsl_functionality1 = true,
      .GOOGLE_user_type = true,
      .KHR_shader_relaxed_extended_instruction = true,
      /* 16-bit floats with WebGPU's shader-f16; 8-bit integers everywhere, and 16- and 8-bit storage (halves and bytes
       * of words, the arithmetic at 32 bits, conversions to halves integer code: wgsl_nir.c `lower_16bit`; VK4 T29). */
      .KHR_shader_float16_int8 = true,
      .KHR_16bit_storage = true,
      .KHR_8bit_storage = true,
      /* YCbCr conversions and the multi-planar formats (VK3 L7.2; on by default since L7.3, `?gpu=vkycbcr=off`). */
      .KHR_sampler_ycbcr_conversion = HAS(YCBCR),
      .EXT_ycbcr_image_arrays = HAS(YCBCR),
      /* The last vertex provoking: a draw whose fragment shader reads a flat input goes through indices of its own,
       * each primitive's rotated (wg_cmd.c `provoke`; VK3 L7.4, ANGLE's ES3: GL's convention). */
      .EXT_provoking_vertex = true,
      /* Transform feedback: the vertex stage run as compute at its render pass's end, on the draw's bind groups and
       * vertex buffers (web/venus-gpu.ts `runXfb`; VK3 L7.4, ANGLE's ES3). One stream, no queries, no draws by the
       * captured count. */
      .EXT_transform_feedback = true,
      /* Draw parameters: the push buffer's words past the push constants, each draw's written in its place there,
       * an indirect draw's copied from its arguments before its render pass (wg_cmd.c `prepasses`; VK3 L7.5, vkd3d). */
      .KHR_shader_draw_parameters = true,
      .KHR_sampler_mirror_clamp_to_edge = true,
      /* Min/max reductions: the shader's filter from fetches (VK4 T25, wgsl_sampler.c `reduce`; vkd3d's 12_0). */
      .EXT_sampler_filter_minmax = true,
      /* Multi-draw: a draw per element, its draw index in the push buffer's draw parameters (VK4 T26, wg_cmd.c). */
      .EXT_multi_draw = true,
      /* Draw-indirect-count: the records gated by the count in a compute pass before the render pass (VK4 T26,
       * web/venus-gpu.ts `indirectCount`; vkd3d's 11_1). */
      .KHR_draw_indirect_count = true,
      /* The shader's borders take any colour, through the view's mapping (wgsl_sampler.c, wg_cmd.c `sampler_border`). */
      .EXT_custom_border_color = true,
      .EXT_border_color_swizzle = true,
      /* A uniform buffer of the set's, written as the guest updates the blocks (wg_descriptor.c). */
      .EXT_inline_uniform_block = true,
      .KHR_buffer_device_address = true,
      /* Not translated: texel buffers' alignment (EXT_texel_buffer_alignment). */
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
      /* An indirect op's draws one by one in the replay, each with its draw index (VK4 T26). */
      .multiDrawIndirect = true,
      .depthClamp = HAS(DEPTH_CLIP),
      .depthBiasClamp = true,
      .samplerAnisotropy = true,
      .textureCompressionETC2 = HAS(ETC2),
      .textureCompressionASTC_LDR = HAS(ASTC),
      /* BC1's RGB formats need a view's swizzle (wg_format.c). */
      .textureCompressionBC = HAS(BC) && HAS(SWIZZLE),
      .fragmentStoresAndAtomics = true,
      .inlineUniformBlock = true,
      /* A pass per view (wg_cmd.c `begin_rendering`), no geometry or tessellation to multiply. */
      .multiview = true,
      /* Bytes of one GPUBuffer (wgsl_nir.c `lower_global`). */
      .bufferDeviceAddress = true,
      /* Its list has the 16-bit normalized formats, which only tier1 has at all. */
      .shaderStorageImageExtendedFormats = HAS(TIER1_STORAGE) && HAS(TIER1),
      /* A storage image without a format is printed for the bound view's (GD G5: a variant keyed by it, wgsl_print.c
       * `image_format`; one only read is a texture, `texture_images`); a texel buffer decodes its view's format at run
       * time (wgsl_print.c `texel_buffer`). */
      .shaderStorageImageReadWithoutFormat = true,
      .shaderStorageImageWriteWithoutFormat = true,
      .shaderClipDistance = HAS(CLIP_DISTANCES),
      /* A gather whose offset isn't a constant from fetches, ConstOffsets as four gathers (VK4 T24, T29). */
      .shaderImageGatherExtended = true,
      /* 16- and 8-bit integers at 32 bits in a word's low bits, 64-bit ones as pairs of words (wgsl_nir.c
       * `split_64bit_access`, nir_lower_int64; VK4 T29). No 64-bit floats, no 64-bit atomics. */
      .shaderInt16 = true,
      .shaderInt64 = true,
      /* A tree of ifs over the elements (wgsl_nir.c; buffers and storage images since VK3 L7.1: Dawn's Vulkan
       * backend requires all four). */
      .shaderUniformBufferArrayDynamicIndexing = true,
      .shaderSampledImageArrayDynamicIndexing = true,
      .shaderStorageBufferArrayDynamicIndexing = true,
      .shaderStorageImageArrayDynamicIndexing = true,
      /* Fragment shaders per sample (WGSL's inputs at their sample, wgsl_print.c; VK3 L7.1: Dawn's core needs it). */
      .sampleRateShading = true,
      .imagelessFramebuffer = true,
      .uniformBufferStandardLayout = true,
      /* Every access is by words at explicit offsets. */
      .scalarBlockLayout = true,
      .shaderSubgroupExtendedTypes = true,
      .shaderFloat16 = HAS(F16),
      .shaderInt8 = true,
      .storageBuffer16BitAccess = true,
      .uniformAndStorageBuffer16BitAccess = true,
      .storagePushConstant16 = true,
      /* Inputs and outputs widened to 32 bits where they're loaded and stored (wgsl_nir.c `widen_io16`; VK4 T29). */
      .storageInputOutput16 = true,
      .storageBuffer8BitAccess = true,
      .uniformAndStorageBuffer8BitAccess = true,
      .storagePushConstant8 = true,
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
      .maintenance5 = true,
      .maintenance6 = true,
      .maintenance8 = true,
      .extendedDynamicState = true,
      .extendedDynamicState2 = true,
      .extendedDynamicState3DepthClampEnable = HAS(DEPTH_CLIP),
      .extendedDynamicState3DepthClipEnable = HAS(DEPTH_CLIP),
      .extendedDynamicState3SampleMask = true,
      .extendedDynamicState3AlphaToCoverageEnable = true,
      .extendedDynamicState3ColorBlendEnable = true,
      .extendedDynamicState3ColorBlendEquation = true,
      .extendedDynamicState3ColorWriteMask = true,
      .extendedDynamicState3ProvokingVertexMode = true,
      .vertexInputDynamicState = true,
      .depthBiasControl = true,
      .nonSeamlessCubeMap = true,
      .depthClipEnable = HAS(DEPTH_CLIP),
      /* YCbCr conversions (VK3 L7.2: each plane sampled and converted in the WGSL, wgsl_lower_ycbcr), on by default
       * since L7.3 (GTK 4.24 asserts them on a device with dma-buf modifiers; GTK4 still takes GL: its Vulkan renderer
       * misses its bar), held by `?gpu=vkycbcr=off`. Chromium's own Vulkan device refuses a device without them (VK3
       * L7.1b). */
      .samplerMirrorClampToEdge = true,
      .samplerFilterMinmax = true,
      .multiDraw = true,
      .drawIndirectCount = true,
      .customBorderColors = true,
      .customBorderColorWithoutFormat = true,
      .borderColorSwizzle = true,
      .borderColorSwizzleFromImage = true,
      .samplerYcbcrConversion = HAS(YCBCR),
      .ycbcrImageArrays = HAS(YCBCR),
      .provokingVertexLast = true,
      .transformFeedback = true,
      .shaderDrawParameters = true,
   };
}

void
wg_caps_properties(struct vk_properties *p)
{
   const struct wg_limits *L = &wg_limits;
   /* By the bindings each takes ("The bindings WebGPU takes", below: every stage's least). */
   const uint32_t sampled = L->max_sampled_textures;
   const uint32_t storage_tex = MIN3(L->max_storage_textures, L->max_storage_textures_in_fragment_stage,
                                     L->max_storage_textures_in_vertex_stage);
   const uint32_t storage = MIN3(L->max_storage_buffers, L->max_storage_buffers_in_fragment_stage,
                                 L->max_storage_buffers_in_vertex_stage);
   /* Uniform buffers past WebGPU's a stage (less the push buffer's binding) are read as storage (wg_shader.c
    * `fold_uniforms`; VK3 L7.4, ANGLE's ES3 wants 13): WG_FOLDED_UBOS of the storage buffers are theirs. */
   const uint32_t folded = storage >= 4 + WG_FOLDED_UBOS ? WG_FOLDED_UBOS : 0;
   const uint32_t ubo = L->max_uniform_buffers - 1 + folded, ssbo = storage - folded;
   const uint32_t samples = VK_SAMPLE_COUNT_1_BIT | VK_SAMPLE_COUNT_4_BIT;
   /* WebGPU's buffers are ranges of one GPUBuffer a memory: an allocation is at most a buffer (and a 32-bit size), which
    * has what room is left past it for a pad (wg_memory_pad). */
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
   p->maxMultiviewViewCount = WG_MAX_VIEWS;
   p->maxMultiviewInstanceIndex = (1u << 27) - 1;
   /* 1.3's minimums of blocks (each a uniform binding, counted by wg_bindings_fit), a page each. */
   p->maxInlineUniformBlockSize = 4096;
   p->maxPerStageDescriptorInlineUniformBlocks = 4;
   p->maxDescriptorSetInlineUniformBlocks = 4;
   p->maxPerStageDescriptorUpdateAfterBindInlineUniformBlocks = 4;
   p->maxDescriptorSetUpdateAfterBindInlineUniformBlocks = 4;
   p->maxInlineUniformTotalSize = 4 * 4096;
   /* Samplers aren't counted; a fragment shader's colour attachments are. */
   p->maxPerStageResources = MAX2(sampled + storage_tex + ubo + ssbo + L->max_color_attachments, 53);
   /* WebGPU counts per stage, Vulkan per layout: six of a stage's, as Vulkan's table of minimums is. A layout may spread
    * them over stages: what a stage of a pipeline binds is held to a stage's (wg_bindings_fit), and the rest of a set
    * isn't bound. */
   p->maxDescriptorSetSamplers = 6 * L->max_samplers;
   p->maxDescriptorSetUniformBuffers = 6 * ubo;
   /* All of WebGPU's: with the push buffer past them, it takes a dynamic storage binding (`push_storage`). */
   p->maxDescriptorSetUniformBuffersDynamic = L->max_dynamic_uniform_buffers;
   p->maxDescriptorSetStorageBuffers = 6 * ssbo;
   p->maxDescriptorSetStorageBuffersDynamic = L->max_dynamic_storage_buffers;
   p->maxDescriptorSetSampledImages = 6 * sampled;
   p->maxDescriptorSetStorageImages = 6 * storage_tex;
   p->maxDescriptorSetInputAttachments = 4;
   /* Attributes past their binding's stride take vertex buffer slots of their own (wg_vertex_slots). */
   p->maxVertexInputAttributes = MIN2(L->max_vertex_attributes, 16);
   /* Vulkan's 16, those past WebGPU's vertex buffers pulled from storage (wg_vertex_pull): a draw that can't be is refused
    * (`wg_pipeline_pull_ok`). */
   p->maxVertexInputBindings = storage >= WG_VERTEX_BINDINGS - 8 ? WG_VERTEX_BINDINGS : MIN2(L->max_vertex_buffers, 8);
   p->maxVertexInputAttributeOffset = L->max_vertex_buffer_array_stride - 1;
   p->maxVertexInputBindingStride = L->max_vertex_buffer_array_stride;
   p->maxVertexOutputComponents = 4 * L->max_inter_stage_shader_variables;
   p->maxFragmentInputComponents = 4 * L->max_inter_stage_shader_variables;
   p->maxFragmentOutputAttachments = L->max_color_attachments;
   p->maxFragmentDualSrcAttachments = HAS(DUAL_SOURCE) ? 1 : 0;
   p->maxFragmentCombinedOutputResources =
      L->max_color_attachments + L->max_storage_buffers_in_fragment_stage + L->max_storage_textures_in_fragment_stage;
   /* Whole: the translator's word for uniform conditions takes shared memory's slack, or room left beside it, or else
    * shared memory's first word for the while (wgsl_print.c). */
   p->maxComputeSharedMemorySize = L->max_compute_workgroup_storage_size;
   for (int i = 0; i < 3; i++)
      p->maxComputeWorkGroupCount[i] = L->max_compute_workgroups_per_dimension;
   p->maxComputeWorkGroupInvocations = L->max_compute_invocations_per_workgroup;
   p->maxComputeWorkGroupSize[0] = L->max_compute_workgroup_size_x;
   p->maxComputeWorkGroupSize[1] = L->max_compute_workgroup_size_y;
   p->maxComputeWorkGroupSize[2] = L->max_compute_workgroup_size_z;
   p->subPixelPrecisionBits = 4;
   /* Vulkan's minimums with sampleRateShading (interpolation at an offset isn't translated: docs/backlog.md). */
   p->minInterpolationOffset = -0.5f;
   p->maxInterpolationOffset = 0.4375f;
   p->subPixelInterpolationOffsetBits = 4;
   p->subTexelPrecisionBits = 4;
   p->mipmapPrecisionBits = 4;
   p->maxDrawIndexedIndexValue = 0xffffffffu;
   /* An indirect op's draws one by one in the replay, each its draw index (VK4 T26): Vulkan's least with
    * multiDrawIndirect, as each may take 256 bytes of the push buffer (its draw parameters). */
   p->maxDrawIndirectCount = 1u << 16;
   p->maxMultiDrawCount = 1u << 16;
   p->maxSamplerLodBias = WGSL_MAX_LOD_BIAS; /* WebGPU's samplers have no bias: the shader's (wgsl_sampler.c), WGSL's within 16 */
   p->maxSamplerAnisotropy = 16;
   p->maxCustomBorderColorSamplers = 4000;
   /* Every format sampled has the min/max bit (fetched, wg_format.c), and the view's mapping is WebGPU's, which the
    * fetches see (VK4 T25). */
   p->filterMinmaxSingleComponentFormats = true;
   p->filterMinmaxImageComponentMapping = HAS(SWIZZLE);
   p->maxViewports = 1;
   p->maxViewportDimensions[0] = p->maxViewportDimensions[1] = L->max_texture_2d;
   p->viewportBoundsRange[0] = -2.0f * L->max_texture_2d;
   p->viewportBoundsRange[1] = 2.0f * L->max_texture_2d - 1;
   p->viewportSubPixelBits = 0;
   p->minMemoryMapAlignment = 64;
   p->minTexelBufferOffsetAlignment = L->min_storage_buffer_offset_alignment;
   /* A uniform buffer read as storage (fold_uniforms) is bound at its offset: the larger of the two (VK3 L7a, the
    * L7.4-L7.5 review's finding 8). */
   p->minUniformBufferOffsetAlignment =
      MAX2(L->min_uniform_buffer_offset_alignment, L->min_storage_buffer_offset_alignment);
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
   p->sampledImageIntegerSampleCounts = VK_SAMPLE_COUNT_1_BIT; /* as framebufferIntegerColorSampleCounts (below) */
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

   /* WGSL's subgroups where the adapter's are of one size, in the stages WGSL has them (compute and fragment), with
    * the operations WGSL has or NIR lowers to them (wgsl_nir.c `lower_subgroups`); else subgroups of one invocation
    * with the basic operations. */
   const uint32_t sg = wg_subgroup_size();
   p->subgroupSize = sg;
   p->subgroupSupportedStages = VK_SHADER_STAGE_COMPUTE_BIT;
   p->subgroupSupportedOperations = VK_SUBGROUP_FEATURE_BASIC_BIT;
   if (sg > 1) {
      p->subgroupSupportedStages |= VK_SHADER_STAGE_FRAGMENT_BIT;
      p->subgroupSupportedOperations |= VK_SUBGROUP_FEATURE_VOTE_BIT | VK_SUBGROUP_FEATURE_ARITHMETIC_BIT |
                                        VK_SUBGROUP_FEATURE_BALLOT_BIT | VK_SUBGROUP_FEATURE_SHUFFLE_BIT |
                                        VK_SUBGROUP_FEATURE_SHUFFLE_RELATIVE_BIT | VK_SUBGROUP_FEATURE_CLUSTERED_BIT |
                                        VK_SUBGROUP_FEATURE_QUAD_BIT;
   }
   p->subgroupQuadOperationsInAllStages = false;
   p->minSubgroupSize = p->maxSubgroupSize = sg;
   p->maxComputeWorkgroupSubgroups = L->max_compute_invocations_per_workgroup;
   p->requiredSubgroupSizeStages = VK_SHADER_STAGE_COMPUTE_BIT;
   p->maxPerSetDescriptors = 1024;
   p->maxPushDescriptors = 32; /* VK_KHR_push_descriptor's (Vulkan's minimum); a set's descriptors as any other's */
   p->maxMemoryAllocationSize = max_buffer;
   p->maxBufferSize = max_buffer;

   /* The worker's draws at the pass's end (web/venus-gpu.ts resolveDepth), each aspect on its own (VK4 T27). */
   p->supportedDepthResolveModes = VK_RESOLVE_MODE_SAMPLE_ZERO_BIT | VK_RESOLVE_MODE_AVERAGE_BIT | VK_RESOLVE_MODE_MIN_BIT |
                                   VK_RESOLVE_MODE_MAX_BIT;
   p->supportedStencilResolveModes = VK_RESOLVE_MODE_SAMPLE_ZERO_BIT | VK_RESOLVE_MODE_MIN_BIT | VK_RESOLVE_MODE_MAX_BIT;
   p->independentResolveNone = true;
   p->independentResolve = true;
   /* Every integer colour attachment's: WebGPU doesn't multisample r32uint, r32sint and the 32-bit ones of two or four
    * channels (wg_device.c's image formats), and Vulkan wants each format's sample counts to hold these. */
   p->framebufferIntegerColorSampleCounts = VK_SAMPLE_COUNT_1_BIT;
   p->maxTimelineSemaphoreValueDifference = 2147483647;
   p->storageTexelBufferOffsetAlignmentBytes = L->min_storage_buffer_offset_alignment;
   p->uniformTexelBufferOffsetAlignmentBytes = L->min_storage_buffer_offset_alignment;
   p->provokingVertexModePerPipeline = true;
   p->maxTransformFeedbackStreams = 1;
   p->maxTransformFeedbackBuffers = 4;
   p->maxTransformFeedbackBufferSize = L->max_storage_buffer_binding_size;
   p->maxTransformFeedbackStreamDataSize = 512;
   p->maxTransformFeedbackBufferDataSize = 512;
   p->maxTransformFeedbackBufferDataStride = 512;

   /* maintenance5 (VK4 T24): no early fragment tests (docs/backlog.md "Rendering"), no points as polygons, lines of
    * one pixel by WebGPU's rule (not a parallelogram); a swizzle of ONE on depth reads 1 (the view's mapping). */
   p->earlyFragmentMultisampleCoverageAfterSampleCounting = false;
   p->earlyFragmentSampleMaskTestBeforeSampleCounting = false;
   p->depthStencilSwizzleOneSupport = true;
   p->polygonModePointSize = false;
   p->nonStrictSinglePixelWideLinesUseParallelogram = false;
   p->nonStrictWideLinesUseParallelogram = false;
   /* maintenance6: a 3-plane YCbCr format's three textures; no block-texel views of several layers. */
   p->blockTexelViewCompatibleMultipleLayers = false;
   p->maxCombinedImageSamplerDescriptorCount = 3;
   p->fragmentShadingRateClampCombinerInputs = false;
}

/*
 * The bindings WebGPU takes for what Vulkan binds (VK3 L7a, the reviews after L7): the one place that counts them, by
 * stage and by pipeline layout, against WebGPU's limits. Besides a descriptor's own binding:
 * - the push buffer (push constants past the immediates, a vertex stage's draw parameters): a uniform buffer every
 *   stage counts (whether a stage reads it isn't known by the layout), dynamic in its layout;
 * - a texel buffer: a storage buffer (its words), where Vulkan counts a sampled or storage image;
 * - a group with texel buffers or storage images as words: a uniform buffer, their parameters' table (VK4 T21: one a
 *   texel buffer passed WebGPU's 12, dEQP-VK's sets4);
 * - uniform buffers past a stage's room: storage buffers (WG_FOLDED_UBOS of them advertised, more refused);
 * - a YCbCr binding's planes past the first: textures (combinedImageSamplerDescriptorCount tells the program);
 * - an input attachment: a texture, where Vulkan counts it apart;
 * - a captured vertex stage's compute pass: the stage's bindings and WG_XFB_STORAGE storage buffers and
 *   WG_XFB_UNIFORMS uniform buffers more (checked where the capture is made: wg_shader.c);
 * - a split sampler's twin (wg_program_variant: a sampler for unfilterable and filterable textures): a sampler.
 * wg_caps_properties advertises what fits whatever the program: the push buffer's uniform buffer out of each stage's and
 * its dynamic one out of the layout's, the folded uniform buffers' storage out of each stage's, every stage's least.
 * The rest (texel buffers and input attachments beside full counts of their own kind, a capture's, folded uniform
 * buffers past WG_FOLDED_UBOS) can't be advertised apart from what Vulkan counts with them: a pipeline whose program
 * doesn't fit is refused at its creation, saying why (wg_bindings_fit), never an invalid submit.
 */
enum { WG_COUNT_UNIFORM, WG_COUNT_STORAGE, WG_COUNT_TEXTURE, WG_COUNT_SAMPLER, WG_COUNT_STORAGE_TEXTURE, WG_COUNTS };
enum { WG_HIDDEN_PUSH, WG_HIDDEN_TEXEL, WG_HIDDEN_FOLDED, WG_HIDDEN_PLANE, WG_HIDDEN_INPUT, WG_HIDDEN_XFB, WG_HIDDEN_TABLE,
       WG_HIDDENS };

/* What a program's resource is in its pipeline layout: the descriptor type, or WG_HIDDEN_PUSH, WG_HIDDEN_PLANE,
 * WG_HIDDEN_TABLE (-1: not known). */
static int
resource_type(const struct wg_program *p, struct vk_descriptor_set_layout *const *layouts, uint32_t k)
{
   if (p->dynamic[k] == WG_DYNAMIC_PUSH)
      return -2 - WG_HIDDEN_PUSH;
   if (p->resources[k].binding == WGSL_TABLE_BINDING)
      return -2 - WG_HIDDEN_TABLE;
   const int s = p->res_set[k];
   if (s < 0 || !layouts || !layouts[s])
      return -1;
   const struct wg_descriptor_set_layout *l = container_of(layouts[s], struct wg_descriptor_set_layout, vk);
   const uint32_t slot = p->resources[k].binding / 2 - p->set_base[s];
   if (l->owner && slot < l->slot_count && l->owner[slot] >= 0)
      return -2 - WG_HIDDEN_PLANE;
   for (uint32_t b = 0; b < l->binding_count; b++)
      if (l->first[b] >= 0 && slot >= (uint32_t)l->first[b] && slot < l->first[b] + l->count[b])
         return l->type[b];
   return -1;
}

bool
wg_bindings_fit(const struct wg_program *p, struct vk_descriptor_set_layout *const *layouts, char *error,
                size_t error_size)
{
   const struct wg_limits *L = &wg_limits;
   static const char *const stages[] = { "vertex", "fragment", "compute" };
   static const char *const what[] = { "uniform buffers", "storage buffers", "textures", "samplers",
                                       "storage textures" };
   static const char *const hidden[] = { "the push buffer", "texel buffers'", "uniform buffers read as storage",
                                         "YCbCr planes", "input attachments", "a capture's",
                                         "parameter tables (texel buffers', storage images as words')" };
   uint32_t dynamic_uniform = 0, dynamic_storage = 0;
   for (uint32_t k = 0; k < p->resource_count; k++) {
      const struct wgsl_resource *r = &p->resources[k];
      if (p->dynamic[k] != -1 && r->kind == WGSL_UNIFORM)
         dynamic_uniform++;
      else if (p->dynamic[k] != -1)
         dynamic_storage++;
      /* Binding numbers past WebGPU's, or a set's slot on the driver's bindings (the parameter table's and up; sets 3
       * and up share group 3: the binding review's finding 8; out of reach within the advertised limits). */
      const bool driver = p->dynamic[k] == WG_DYNAMIC_PUSH || (r->binding == WGSL_TABLE_BINDING && r->kind == WGSL_UNIFORM) ||
                          (r->group == WGSL_MAX_GROUPS - 1 && r->binding == WGSL_ADDRESS_BINDING);
      if (r->binding >= L->max_bindings_per_bind_group || (r->binding >= WGSL_TABLE_BINDING && !driver)) {
         snprintf(error, error_size, "binding %u of bind group %u, past WebGPU's %u or on the driver's",
                  r->binding, r->group, MIN2(L->max_bindings_per_bind_group, WGSL_TABLE_BINDING));
         return false;
      }
   }
   if (dynamic_uniform > L->max_dynamic_uniform_buffers || dynamic_storage > L->max_dynamic_storage_buffers) {
      const bool u = dynamic_uniform > L->max_dynamic_uniform_buffers;
      snprintf(error, error_size, "%u dynamic %s buffers in the layout, past WebGPU's %u%s", u ? dynamic_uniform : dynamic_storage,
               u ? "uniform" : "storage", u ? L->max_dynamic_uniform_buffers : L->max_dynamic_storage_buffers,
               u && p->push_ubo_size ? " (one of them the push buffer)" : "");
      return false;
   }
   for (uint32_t st = 0; st < 3; st++) {
      uint32_t n[WG_COUNTS] = { 0 }, h[WG_COUNTS][WG_HIDDENS] = { { 0 } };
      for (uint32_t k = 0; k < p->resource_count; k++) {
         if (!(p->vis[k] & (1u << st)))
            continue;
         const struct wgsl_resource *r = &p->resources[k];
         const uint32_t c = r->kind == WGSL_UNIFORM                                          ? WG_COUNT_UNIFORM
                            : r->kind == WGSL_STORAGE || r->kind == WGSL_STORAGE_READ       ? WG_COUNT_STORAGE
                            : r->kind == WGSL_TEXTURE                                       ? WG_COUNT_TEXTURE
                            : r->kind == WGSL_SAMPLER || r->kind == WGSL_SAMPLER_COMPARE    ? WG_COUNT_SAMPLER
                                                                                            : WG_COUNT_STORAGE_TEXTURE;
         n[c]++;
         const int t = resource_type(p, layouts, k);
         if (t == -2 - WG_HIDDEN_PUSH)
            h[c][WG_HIDDEN_PUSH]++;
         else if (t == -2 - WG_HIDDEN_PLANE)
            h[c][WG_HIDDEN_PLANE]++;
         else if (t == -2 - WG_HIDDEN_TABLE)
            h[c][WG_HIDDEN_TABLE]++;
         else if (t == VK_DESCRIPTOR_TYPE_UNIFORM_TEXEL_BUFFER || t == VK_DESCRIPTOR_TYPE_STORAGE_TEXEL_BUFFER)
            h[c][WG_HIDDEN_TEXEL]++;
         else if ((t == VK_DESCRIPTOR_TYPE_UNIFORM_BUFFER || t == VK_DESCRIPTOR_TYPE_INLINE_UNIFORM_BLOCK) &&
                  c == WG_COUNT_STORAGE)
            h[c][WG_HIDDEN_FOLDED]++;
         else if (t == VK_DESCRIPTOR_TYPE_INPUT_ATTACHMENT)
            h[c][WG_HIDDEN_INPUT]++;
      }
      /* A captured vertex stage's resources are compute-visible too: its compute pass's own on top. */
      bool xfb = false;
      for (uint32_t k = 0; st == 2 && k < p->resource_count; k++)
         xfb |= (p->vis[k] & 5) == 5;
      if (xfb) {
         n[WG_COUNT_STORAGE] += WG_XFB_STORAGE, h[WG_COUNT_STORAGE][WG_HIDDEN_XFB] += WG_XFB_STORAGE;
         n[WG_COUNT_UNIFORM] += WG_XFB_UNIFORMS, h[WG_COUNT_UNIFORM][WG_HIDDEN_XFB] += WG_XFB_UNIFORMS;
      }
      const uint32_t max[WG_COUNTS] = {
         L->max_uniform_buffers,
         st == 0 ? MIN2(L->max_storage_buffers, L->max_storage_buffers_in_vertex_stage)
         : st == 1 ? MIN2(L->max_storage_buffers, L->max_storage_buffers_in_fragment_stage)
                   : L->max_storage_buffers,
         L->max_sampled_textures,
         L->max_samplers,
         st == 0 ? MIN2(L->max_storage_textures, L->max_storage_textures_in_vertex_stage)
         : st == 1 ? MIN2(L->max_storage_textures, L->max_storage_textures_in_fragment_stage)
                   : L->max_storage_textures,
      };
      for (uint32_t c = 0; c < WG_COUNTS; c++) {
         if (n[c] <= max[c])
            continue;
         char why[256] = "";
         size_t at = 0;
         for (uint32_t i = 0; i < WG_HIDDENS; i++)
            if (h[c][i] && at < sizeof(why))
               at += snprintf(why + at, sizeof(why) - at, "%s%u %s%s", at ? ", " : " (of them: ", h[c][i], hidden[i],
                              i != WG_HIDDEN_TEXEL ? "" : " words");
         if (at && at < sizeof(why))
            snprintf(why + at, sizeof(why) - at, ")");
         snprintf(error, error_size, "the %s stage binds %u %s, past WebGPU's %u%s", stages[st], n[c], what[c], max[c],
                  why);
         return false;
      }
   }
   return true;
}
