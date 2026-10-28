# Venus review: VK3 L6b to L7.3 (static)

**Range reviewed:** `a82e482d..71e850cc`, i.e. 721cd99e (L6b texel buffers) through 71e850cc (L7.3). All files read as of
71e850cc.

**Scope:** `vk/compiler` (wgsl_nir.c, wgsl_print.c, wgsl.h), `vk/driver` (wg_caps.c, wg_cmd.c, wg_descriptor.c,
wg_device.c, wg_format.c, wg_shader.c, wg_private.h), `vk/patches/vkr-wasm.patch`, `web/venus-gpu.ts`,
`web/venus-host.ts`, `web/gpu-worker.ts`, and the test changes. I skipped bench JSON, screenshots and dEQP case lists.
For behaviour, I compared against Mesa's runtime (`vk_nir_convert_ycbcr.c`, `vk_ycbcr_conversion.c`, `spirv_to_nir.c`
under `target/vk/mesa`).

**Bottom line:** I found no crash, memory-corruption or ordering bug in the new paths. These parts held up when I traced
them by hand: texel-buffer decode and encode, slot layout for YCbCr planes, query spare slots and their GPU add, the
stencil reference and mask choice, the read-only storage variants, the depth and stencil copy shaders, and the ring-fence
submit. What I did find are four places where the device promises more than the code delivers. Each one breaks a valid
Vulkan program, or the WebGPU submit it lands in:

1. `sampleRateShading` brings in SPIR-V's InterpolationFunction capability, which the translator refuses.
2. Texel buffers use WebGPU buffer bindings that the advertised descriptor limits don't count.
3. Multi-planar images refuse plane-format lists, and plane views in another compatible format come out invalid.
4. Multi-planar images ignore imported and shared memory.

The remaining finding (5) is a set of stale comments.

---

## 1. `sampleRateShading` is advertised, but `interpolateAtSample` and `interpolateAtOffset` fail to compile (Medium)

- **Where:** `vk/driver/wg_caps.c:155` (`.sampleRateShading = true`) and `wg_caps.c:262-265` (interpolation-offset
  limits); `vk/compiler/wgsl_print.c:505-508` (`failf(c, "interpolation at an offset or sample")`).
- **Defect:** In Vulkan's SPIR-V environment, the `InterpolationFunction` capability (`InterpolateAtCentroid`,
  `InterpolateAtSample`, `InterpolateAtOffset`) is enabled by `VkPhysicalDeviceFeatures::sampleRateShading`. These
  commits turn the feature on (L7.1, for Dawn) and publish the interpolation-offset limits. The translator, however,
  still fails any `load_barycentric_at_sample` or `load_barycentric_at_offset`. As a result, a conformant program that
  checks the feature and then uses `interpolateAtSample` or `interpolateAtOffset` gets a pipeline-creation failure.
  - The code comment and docs/backlog.md acknowledge the gap. Even so, the feature as advertised claims support that
    isn't there.
  - The dEQP-VK pass list explicitly leaves out `multisample_interpolation`'s `interpolate_at_*` cases.
- **When:** Any fragment shader that uses `interpolateAtSample` or `interpolateAtOffset`. Video and MSAA renderers use
  them, and so do Dawn's own tests.
- **Fixes, any of:**
  - Lower `at_sample(s)` with a dynamic `s` to the input interpolated at its sample when `s == sample_index` (and
    approximate otherwise).
  - Lower `at_offset` to `center + offset·(dFdx, dFdy)`. This is the classic lowering; `nir_lower_interpolation` does it.
  - Stop advertising the feature until one of the above exists.
- **Test that confirms it:** Run `dEQP-VK.pipeline.monolithic.multisample_interpolation.offset_interpolate_at_pixel_center.samples_4`
  and `...sample_interpolate_at_single_sample.*`. Both fail today with the "interpolation at an offset or sample" error.
  A cheaper check is a GLSL `interpolateAtOffset(v, vec2(0))` fragment shader through `tests/wgsl.test.ts`, which expects
  a translation.

## 2. Texel buffers take WebGPU storage and uniform bindings that the advertised limits don't count (Medium)

- **Where:** `vk/compiler/wgsl_print.c:387-397` (`texel_buffer`: one `var<storage>` plus one 32-byte `var<uniform>` per
  texel-buffer descriptor); `vk/driver/wg_caps.c:225-238` (descriptor limits, unchanged).
- **Defect:** Vulkan counts a uniform texel buffer against `maxPerStageDescriptorSampledImages` and a storage texel
  buffer against `maxPerStageDescriptorStorageImages`. Here each one actually uses a WebGPU storage buffer and a
  uniform buffer. The limits still advertise:
  - `maxPerStageDescriptorStorageBuffers = maxStorageBuffersPerShaderStage` (8 by default),
  - `maxPerStageDescriptorUniformBuffers = maxUniformBuffersPerShaderStage` (12),
  - `maxPerStageDescriptorSampledImages = 16`.

  So a stage that stays within every Vulkan limit can still go past WebGPU's. When that happens, the pipeline layout
  or shader module is invalid. A dispatch or draw that uses such a pipeline then invalidates its whole submit.
- **When:** Any of these, in one stage:
  - 8 SSBOs plus 1 texel buffer.
  - 9 or more uniform texel buffers (legal under Vulkan's 16 sampled images).
  - 12 UBOs plus 1 texel buffer.
- **Fix:** Lower the buffer limits to leave room. For example, a combined budget:
  `storage buffers + uniform texel + storage texel ≤ WebGPU storage`, and
  `UBO + texel buffers ≤ WebGPU uniform`. Alternatively, pack all texel-buffer parameters into one uniform buffer per
  stage.
- **Test that confirms it:** A compute shader with 8 `buffer` blocks and one `textureBuffer`. It is within the
  advertised limits, and `wg_test.c`'s misc harness gets a WebGPU validation error ("too many storage buffers") on
  `createPipelineLayout` or `createComputePipeline`.

## 3. Multi-planar images: plane-format lists are refused, and plane views in another compatible format are invalid (Medium-Low)

- **Where:**
  - `vk/driver/wg_device.c:393-401`: the `VkImageFormatListCreateInfo` check through `view_format_ok`, at 357-365.
  - `wg_device.c:1172`: the warning is skipped for `plane_count >= 2`.
  - `wg_device.c:1202-1221`: the planar branch of `wg_CreateImageView`.
- **Defect (a), format lists refused:** `GetPhysicalDeviceImageFormatProperties2` refuses any MUTABLE image whose
  format list names a format that isn't the image's format or its sRGB twin. For a multi-planar format (for example
  `G8_B8R8_2PLANE_420_UNORM`), the only possible twin is `UNDEFINED`. That means a list of the plane formats
  (`R8_UNORM`, `R8G8_UNORM`) is refused, even though the plane views it describes are exactly what the planar
  `CreateImageView` branch builds correctly.
  - Video stacks query the device like this: ffmpeg's hwcontext_vulkan, GStreamer, and Chromium's own Vulkan device,
    which is the device L7.1b and L7.2 aimed at. They pass `MUTABLE_FORMAT` (often with `EXTENDED_USAGE`) plus a list
    of the plane formats, so they all see NV12 as unsupported.
- **Defect (b), invalid plane views:** The other way round, a plane view whose format is compatible with the plane but
  not identical goes straight to WebGPU with that format. Examples are `R8_UINT` on the luma plane and `R16_UNORM` or
  `R8G8_UINT` on the chroma plane; Vulkan allows these with `MUTABLE_FORMAT`.
  - Each plane's texture is created with `viewFormats` holding only the plane format's sRGB twin, which doesn't exist
    for these formats.
  - `createView` is therefore a validation error, and any bind group that uses the view invalidates its submit.
  - The "views differ only in sRGB-ness" warning is explicitly suppressed for planar images, so the failure doesn't
    show up in the logs either.
- **When:**
  - (a) Any MUTABLE multi-planar image query that carries a format list.
  - (b) Any plane view whose format isn't the plane's own.
- **Fixes:**
  - (a) For a multi-planar format, accept list entries that equal one of its plane formats or that format's twin.
  - (b) Refuse a plane view whose format isn't the plane's own, or add the compatible formats WebGPU can view to the
    plane texture's `viewFormats`. Also keep the warning.
- **Tests that confirm it:**
  - (a) In `tests/venus-driver.test.ts`, call `vkGetPhysicalDeviceImageFormatProperties2` for NV12 with
    `MUTABLE_FORMAT` and a `VkImageFormatListCreateInfo {R8_UNORM, R8G8_UNORM}`. It should succeed; today it returns
    `VK_ERROR_FORMAT_NOT_SUPPORTED`.
  - (b) Create a `MUTABLE` NV12 image and a `PLANE_0` view in `R8_UINT`, then bind it as a storage-less sampled
    `utexture2D`. The page logs a "venus-gpu: WebGPU:" view-format error.

## 4. Multi-planar images ignore imported and shared memory (Low-Medium)

- **Where:**
  - `vk/driver/wg_device.c:1075-1088`: the planar branch of `wg_BindImageMemory2`, which `continue`s before the
    `mem->import_res` and `image->shared` handling at 1098-1106.
  - `wg_device.c:439-447`: `EXTERNAL_IMAGE_FORMAT_PROPERTIES` reports dma-buf and opaque-fd import and export for every
    format, NV12 included.
- **Defect:**
  - **Import:** When a multi-planar image is bound to memory imported from another renderer's resource, it never
    calls `gpu_texture_import` for its planes. Every plane texture stays a blank texture of the driver's own, so the
    imported frame never appears. Nothing warns.
  - **Export:** An exported, shared NV12 image is never registered in `dev->shared_memories`.
  - Meanwhile, `GetPhysicalDeviceImageFormatProperties2` with `VkPhysicalDeviceExternalImageFormatInfo` tells the guest
    that both are supported.

  DRM-modifier tiling is refused for these formats, so this bites only `OPTIMAL` plus external memory. That is the path
  a decoder takes when it imports frames as opaque fds or dma-bufs without modifiers.
- **Fix:** Report `externalMemoryFeatures = 0` for `wg_ycbcr_format` formats until planes can be imported (or import
  each plane's region).
- **Test that confirms it:** Query `vkGetPhysicalDeviceImageFormatProperties2` for NV12 with an external dma-buf
  handle type. Today it claims IMPORTABLE and EXPORTABLE; the expected result is not supported.

## 5. Stale comments and docs about the YCbCr default (Low, documentation)

- **Where:** `vk/driver/wg_caps.c:120` and `wg_caps.c:183-187` ("only with `?gpu=vkycbcr`: by default GTK4's Vulkan
  renderer stays off"), and `vk/driver/wg_private.h:61-62` ("off by default until GTK4's row").
- **Defect:** Since 33d3b0b5, YCbCr is on by default (`web/venus-host.ts`: `options.ycbcr ?? true`; the off switch is
  `?gpu=vkycbcr=off`). The comments still describe the L7.2 default and the knob as it was. This misleads the next
  session about what the device advertises by default.
- **Fix:** Rewrite the three comments to match. No test is needed.

---

### Traced and found sound (no finding)

- **Texel buffers:**
  - Decode is exact for unorm, snorm, the sint and uint widths, uscaled and sscaled, f16 and f32, and ufloat 11/10,
    including denormals and Inf/NaN.
  - Store packing, the swizzle and the stored-component table are correct.
  - The word and bit addressing for 3- and 6-byte texels is correct.
  - The 256-byte storage alignment matches `minTexelBufferOffsetAlignment`, so whole-word stores stay aligned.
  - The parity rule (words at the even binding, params at the odd one) is consistent with `bound_descriptor`.
- **YCbCr slots:**
  - Plane slots `planes[b] + 2e + p - 1` match `lower_descriptors_instr`'s index arithmetic and `sync_planes`.
  - Layout allocation sizes and the blake3 coverage of conversions are right.
  - Mesa's `txs` for cosited offsets resolves to plane 0.
- **Occlusion spares:**
  - Spare slots stay inside the set, and spare entries are never marked passing.
  - Resolves happen before adds, outside any pass.
  - `queryAdd`'s 64-bit carry is correct.
- **`stencil_values` / `draw_faces`:** These match "use only what the face's ops consume". The write mask is applied
  correctly when only one face writes.
- **Read-only storage variant:**
  - The text rewrite matches `declare_resources`' exact declaration.
  - The variant owns its module; base and variant modules are freed correctly.
  - `bgl_uid` keys cover everything `bind_group` takes from the program (types, visibility, uniform sizes, the push
    binding).
- **Depth and stencil copy shaders:**
  - The full-screen triangle, viewport and scissor are right.
  - The D24 round trip with its ±1 correction is right.
  - The stencil bit-plane draws (zero pass, then replace with write mask `1<<bit`) are right.
  - The 256-aligned storage offsets are right.
- **Uniform condition through atomics:** The save, uniform load, restore and barriers are ordered correctly.
- **`wg_ring_fence`:** It is set only around vkr's sync-thread fence submit. Mesa's `submitCount == 0` path reaches
  `wg_queue_submit` with no waits and no command buffers.
- **Sample shading:**
  - `uses_sample_shading` isn't reset by `nir_shader_gather_info`, so the pipeline-state bit survives `wgsl_lower`.
  - Flat inputs stay `@interpolate(flat)`.
  - The 4x positions match Vulkan's standard locations.
