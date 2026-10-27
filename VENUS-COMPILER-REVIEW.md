# Static review: Venus's translator (NIR → WGSL) and advertised caps

> **Triage (the reviews' session, 2026-10-27; VK3-HANDOVER.md "L4f").** Fixed, each with its test failing first
> (tests/wgsl.test.ts, tests/venus-renderer.test.ts, tests/venus-driver.test.ts): **1** (half packing; `ldexp` already
> translated: NIR lowers it to bit operations), **6** (a strong compare-exchange), **9** (`pipelineCacheUUID` with the
> caps), **15** (odd-sized storage bindings), and the false comment on `maxSamplerLodBias`. Left for **VK3 L4f**: 2, 3
> (implement `@blend_src` or stop advertising: guest-visible), 4, 5, 7, 8, 10 (the driver review's 9), 11, 12, 13, 14
> (the driver review's 12), 16, 17 (guest-visible), and the lower-confidence notes. Subgroups are L5's. This file goes
> with L4f's end, its findings into docs/backlog.md as they're fixed or filed.

**Commit reviewed:** `f572da2` (HEAD; the reviewed files are byte-identical to `d5a8f14`). The working tree had
uncommitted edits by another session in `wg_cmd.c`, `wg_device.c`, `wg_shader.c` (strip restart, depth bias on
lines/points, an empty fragment stage). Every line number below is HEAD's (`git show HEAD:<file>`). None of those
edits touches a finding here.

**Scope:** `vk/compiler/` (wgsl_nir.c, wgsl_print.c, wgsl.h, wgsl_test.c), `vk/driver/wg_shader.c`. Caps:
`wg_caps.c`, `wg_format.c`, `wg_device.c` (properties, format and image-format queries, samplers, views), the
consuming parts of `wg_cmd.c` / `wg_descriptor.c`, and `web/venus-gpu.ts` (`FEATURES`, `LIMITS`, `deviceRequest`).
I checked behaviour against Mesa 26.2.4's sources (vtn_structured_cfg.c, vtn_variables.c, nir_opt_algebraic.py,
nir_lower_alu_width.c, nir_opt_varyings.c, nir_opt_access.c, nir_lower_explicit_io.c, vk_pipeline.c), which I fetched
for this review, and against the WGSL, WebGPU and Vulkan specs. This was a static read only: nothing was built or run.

**Bottom line:** the ALU translation is careful: signedness, shifts, bit ops, unordered compares, imod and the
conversions are right. The defects sit at the edges:
- Common GLSL built-ins are lowered by NIR into forms the printer refuses: `packHalf2x16`, `unpackHalf2x16`, `ldexp`.
  WGSL has all three natively.
- Some resource-binding combinations produce invalid WebGPU objects without any warning: cube storage views, one
  SSBO accessed differently by two stages, mutable-format views.
- Shared-memory signed atomics are done unsigned.
- Several advertised capabilities are refused or ignored: dual-source blending, depth resolve, sampler LOD bias,
  subgroup basics, `vkCmdDispatchBase`.

Anything that fails translation becomes a pipeline that draws nothing, with one line on stderr. To the guest, these
cases look like silent black output.

---

## Findings (most severe first)

### 1. `packHalf2x16` / `unpackHalf2x16` (and `ldexp`) never translate
- **Where:** `vk/compiler/wgsl_nir.c:44-45` (`.lower_pack_half_2x16 = true`, `.lower_unpack_half_2x16 = true`),
  `:43` (`.lower_pack_split = true`). `vk/compiler/wgsl_print.c:862-864` (the default case: "the ALU op %s"). Nothing
  sets `lower_ldexp` (it isn't in `options`).
- **The defect:** `nir_lower_alu_to_scalar` (nir_lower_alu_width.c:243-272) turns `pack_half_2x16` into
  `pack_half_2x16_split`. `nir_opt_algebraic` then rewrites it, under `lower_pack_split`, to `f2f16` / `u2u32`, which
  are 16-bit values. `gather()` refuses them ("16-bit values (f2f16)"). `unpack_half_2x16` becomes
  `unpack_half_2x16_split_x/_y`. No pass lowers those, and the printer has no case for them. vtn emits `nir_ldexp`
  for `GLSLstd450Ldexp` (vtn_glsl450.c:548), and the printer has no case for that either. WGSL has
  `pack2x16float`, `unpack2x16float` and `ldexp` built in.
- **When it triggers:** any stage using `packHalf2x16` (G-buffer and normal packing, compute compaction),
  `unpackHalf2x16`, or `ldexp`. The whole pipeline then draws or dispatches nothing.
- **A test that would confirm it:** in `tests/wgsl.test.ts`, glslc stages with `uint u = packHalf2x16(v.xy)`,
  `vec2 w = unpackHalf2x16(u)` and `ldexp(x, e)`. Assert rc 0 and that Chromium compiles the module. Today they fail
  at phase 3 with the messages above. Also dEQP-VK `glsl.builtin.function.pack_unpack.packhalf2x16_*`,
  `unpackhalf2x16_*` and `glsl.builtin.function.common.ldexp.*`.

### 2. Storage images on cube or cube-array views: bind group invalid, and `imageSize` of a cube array ×6
- **Where:** `vk/driver/wg_device.c:1009,1025`: a `VK_IMAGE_VIEW_TYPE_CUBE`/`CUBE_ARRAY` view is created with
  `"dimension":"cube"`/`"cube-array"`, and it is the only view kept (`view->view`). `wg_cmd.c` (the bind group's
  default case) binds `d->view->view`. `vk/driver/wg_shader.c:208` gives the layout entry `"viewDimension":"2d-array"`
  for storage textures. `vk/compiler/wgsl_print.c:321-329` declares `texture_storage_2d_array`. `wgsl_print.c:1283-1289`
  is the `imageSize` code.
- **The defect:** WebGPU's `createBindGroup` requires a storage texture view's `dimension` to equal the layout's
  `viewDimension`. A cube view therefore makes the bind group invalid, and with it the encoder and the submit. Separately,
  `imageSize(imageCubeArray)` must return the number of cubes in z. It returns `textureNumLayers`, which is 6× that.
- **When it triggers:** a compute or fragment shader using `imageCube` or `imageCubeArray`, with the descriptor written
  from a cube view. This is the usual IBL/prefilter pattern. It is very likely the "storage images of cube views
  through descriptors (7)" item in docs/backlog.md, which has no cause recorded.
- **A test that would confirm it:** in `vk/driver/wg_test.c`, a compute pipeline with `layout(rgba8) writeonly
  uniform imageCube img;` that stores face-indexed colours through a cube view. Read back all 6 faces and assert the
  colours. In tests/venus-driver.test.ts, also assert there was no WebGPU validation error. Then a second dispatch on a
  cube-array that writes `imageSize(img).z` into an SSBO, asserting N (not 6N). dEQP-VK
  `image.load_store.with_format.cube.*` and `image.image_size.cube_array.*`.

### 3. `dualSrcBlend` is advertised, but every dual-source shader is refused
- **Where:** `vk/driver/wg_caps.c:117` (`.dualSrcBlend = HAS(DUAL_SOURCE)`), `:216`
  (`maxFragmentDualSrcAttachments = 1`). `vk/compiler/wgsl_print.c:445-446` (`failf(c, "dual-source blending")`).
  `wg_shader.c:805-808` maps the `src1` factors.
- **The defect:** the feature and the limit say yes. The translator fails any output with `dual_source_blend_index`,
  so the pipeline silently draws nothing. WGSL has `enable dual_source_blending;` and `@blend_src(0/1)` for this.
- **When it triggers:** on adapters with `dual-source-blending` (the Mac, most desktop GPUs), any guest that checks
  the feature and uses `layout(location=0, index=1)`. Examples: subpixel text, DXVK, some compositors.
- **A test that would confirm it:** in `tests/wgsl.test.ts`, a fragment shader with two outputs at location 0,
  index 0 and 1, translated with the feature. Assert rc 0 and that Tint compiles it. dEQP-VK
  `pipeline.*.blend.dual_source.*`. Until it is implemented, a caps check in `tests/venus-renderer.test.ts` should
  assert `dualSrcBlend == false`.

### 4. One storage buffer read in one stage and written in another makes an invalid pipeline
- **Where:** `vk/driver/wg_shader.c:270-277` (`resource_merge`: `kind = STORAGE` when either stage writes). Only
  storage textures get the per-stage access check (`wg_shader.c:588-601`). `vk/compiler/wgsl_print.c:356-358` (each
  stage declares its own access). `wg_shader.c:178-185` (the layout's buffer type and visibility).
- **The defect:** the vertex stage can't write SSBOs, and `nir_opt_access` (is_vulkan) marks its reads
  NON_WRITEABLE, so it declares `var<storage, read>`. A fragment stage that writes any buffer or image keeps the
  shared, undecorated SSBO `read_write`. The merged layout entry becomes `"storage"` with VERTEX|FRAGMENT visibility.
  That is invalid twice over:
  - WebGPU forbids a `"storage"` buffer entry visible to VERTEX.
  - Dawn requires the shader's buffer type to equal the layout's, so the VS's `read` doesn't match `"storage"`.
  The same thing happens in `wg_program_merge` (`wg_shader.c:448-462`), which doesn't check storage textures either.
- **When it triggers:** a scene or object SSBO (without `readonly`) read by both stages, where the FS also writes a
  storage buffer or image: picking/ID buffers, OIT, debug counters, feedback. This is valid Vulkan without
  `vertexPipelineStoresAndAtomics`.
- **A test that would confirm it:** in `vk/driver/wg_test.c`, a VS that reads `buffer B { vec4 v[]; }` at (0,0),
  and an FS that reads the same binding and `atomicAdd`s into another SSBO. Draw, then assert the pixels and the
  counter, and assert that tests/venus-driver.test.ts saw no WebGPU validation error. Today the pipeline is invalid.

### 5. Shared-memory `atomicMin`/`atomicMax` on signed ints compare unsigned; a mixed SSBO gets one of them wrong
- **Where:** `vk/compiler/wgsl_print.c:367-370` (shared atomics only set `shm_atomic`). `:1212-1220` (passes
  `signed_atomic = false`). `:1668-1669` (`array<atomic<u32>>`). `:927-928` (imin/umin both map to `atomicMin`).
  For SSBOs, `:359-364` and `:570`: one `signed_atomic` per binding.
- **The defect:** `atomicMin(shared int, -5)` runs as an unsigned min on `atomic<u32>`. Negative values compare
  above positive ones, and the result is silently wrong. On an SSBO used with both `imin`/`imax` and `umin`/`umax`,
  the array is `atomic<i32>` and the unsigned ops compare signed.
- **When it triggers:** compute reductions over signed values in `shared` memory, for example bounds, tile min/max
  depth stored as int, or histogram offsets. And any SSBO that mixes signed and unsigned min/max.
- **A test that would confirm it:** in `tests/wgsl.test.ts`, assert that a shader with `shared int s;
  atomicMin(s, x)` prints `atomic<i32>` (or a per-op bitcast scheme). In `wg_test.c`, a dispatch of 64 invocations
  doing `atomicMin(s, int(gl_LocalInvocationIndex) - 32)` and storing `s`, asserting -32. dEQP-VK
  `compute.basic.*atomic*`, `glsl.atomic_operations.min_signed_shared*`.

### 6. `atomicCompSwap` is translated to `atomicCompareExchangeWeak` with no retry
- **Where:** `vk/compiler/wgsl_print.c:978-983`.
- **The defect:** SPIR-V's `OpAtomicCompareExchange` is strong. WGSL's weak form may fail spuriously and return
  `old_value == comparator` with `exchanged == false`. The guest's usual check, `if (atomicCompSwap(x, c, v) == c)`,
  then takes a failed exchange for a successful one: lost updates and broken spinlocks. Tint maps this to MSL's
  `atomic_compare_exchange_weak_explicit`, so how often it bites depends on the backend.
- **When it triggers:** any CAS loop or lock in compute or fragment shaders (allocators, linked-list OIT), on a backend
  whose weak CAS can fail spuriously.
- **A test that would confirm it:** in `tests/wgsl.test.ts`, assert the emitted CAS is a loop: `loop { let r =
  atomicCompareExchangeWeak(...); if (r.exchanged || r.old_value != cmp) { t = r.old_value; break; } }`.
  At runtime, dEQP-VK `glsl.atomic_operations.comp_swap_*` and a `wg_test.c` spin-lock counter (N invocations ×
  increments under a CAS lock, asserting the exact total).

### 7. `VK_IMAGE_CREATE_MUTABLE_FORMAT_BIT` views of anything but the sRGB twin are invalid views
- **Where:** `vk/driver/wg_device.c:837-845` (`viewFormats` holds only the sRGB/linear twin). `:1003` (the view
  takes the Vulkan view format). `:1025` (`createView` with it). `wg_GetPhysicalDeviceImageFormatProperties2`
  (`:352` on) never looks at `MUTABLE_FORMAT` or `VkImageFormatListCreateInfo`.
- **The defect:** WebGPU allows a view format other than the texture's only if it is in `viewFormats`, and
  `viewFormats` may only differ in sRGB-ness. A Vulkan view of `R32_UINT` on an `R8G8B8A8_UNORM` image is legal
  in Vulkan (MUTABLE plus size-compatible). Here the view is invalid, so every bind group using it, and the submit,
  are invalid. The guest gets no error.
- **When it triggers:** compute paths that alias image formats: packing RGBA8 through `r32ui` storage, ffmpeg's and
  libplacebo's Vulkan filters, DXVK typeless resources.
- **A test that would confirm it:** in `wg_test.c`, create an `R8G8B8A8_UNORM` MUTABLE image and an `R32_UINT` view,
  store through it in compute, and read the bytes back. Either assert the bytes, or assert that
  ImageFormatProperties/CreateImageView refuse the combination (`VK_ERROR_FORMAT_NOT_SUPPORTED`) instead of the
  submit being dropped. dEQP-VK `image.mutable.*`.

### 8. Separately indexed texture and sampler arrays share one index in the `if` tree
- **Where:** `vk/compiler/wgsl_nir.c:466-468` (only the first dynamic deref `d` and its length `n`). `:441-452`
  (`emit_element` rewrites every dynamic deref, texture and sampler alike, to element `lo` chosen by `d`'s index).
- **The defect:** take `texture(sampler2D(tex[i], smp[j]), uv)` with `i != j`. The sampler comes from `smp[i]`
  instead of `smp[j]`, silently. If `smp` is shorter than `tex`, the deref goes past its array, and
  `deref_element`/`slot_binding` names another descriptor's slot.
- **When it triggers:** separate `texture2D[]` and `sampler[]` arrays with different dynamically uniform indices
  (material texture × sampler-state tables). The device allows this through `shaderSampledImageArrayDynamicIndexing`.
- **A test that would confirm it:** in `tests/wgsl.test.ts`, a fragment shader with `texture2D t[4]; sampler s[2];`
  indexed by two different push constants. Assert the WGSL's innermost sampler binding varies with the second index
  (or that the stage is refused). In `wg_test.c`, draw with `t[3]` and `s[0]` = nearest vs `s[1]` = linear, and
  assert the filtered texel.

### 9. A guest's saved `VkPipelineCache` is accepted on a device with other caps
- **Where:** `vk/driver/wg_device.c:171` (`pipelineCacheUUID` = hash of `WG_BUILD_ID` only, `build_uuid` at
  `:109-118`). Compare `:186`, where the disk cache's key does include `caps_hash()`.
- **The defect:** the cached WGSL depends on the device. Immediates (`var<immediate>` when
  `max_immediate_size > 0`), `texture-formats-tier2` read_write, tier1 storage formats and `clip_distances` all change
  it. The runtime validates a guest-supplied cache blob only by vendorID, deviceID (always 0) and pipelineCacheUUID.
  So a blob saved under one browser or flag set (for example Chromium with `setImmediates`, or `?gpu=vkformats=`) is
  reused when the caps differ. The modules then fail in WebGPU, and the pipelines are silently invalid.
- **When it triggers:** a program that persists its pipeline cache (many games and engines), run again after a
  Chromium update, on another adapter of the same maker, or with a different `?gpu=` switch.
- **A test that would confirm it:** in `tests/venus-renderer.test.ts` / `venus-driver.test.ts`, init the renderer
  twice with different `gpuLimits` (`maxImmediateSize` 64 vs 0) or features (tier2 on/off). Assert that
  `pipelineCacheUUID` differs. Or, in `wg_test.c`, save `vkGetPipelineCacheData` under one set of caps, load it under
  the other, and assert the draw's pixels.

### 10. Depth/stencil resolve is advertised but silently not done
- **Where:** `vk/driver/wg_caps.c:283-284` (`supportedDepth/StencilResolveModes = SAMPLE_ZERO`; extension
  `KHR_depth_stencil_resolve` at `:63`). `vk/driver/wg_cmd.c:516-536` never looks at
  `pDepthAttachment->resolveImageView`. Only colour gets `resolveTarget` (`:494-496`).
- **The defect:** an MSAA depth attachment's resolve (dynamic rendering, or a renderpass2 `pDepthStencilResolve`)
  never happens. The single-sample image keeps stale contents. WebGPU can't resolve depth, so either do it as a
  draw that writes `frag_depth` from sample 0, or stop advertising it.
- **When it triggers:** MSAA renderers that resolve depth for later passes (SSAO or soft particles after MSAA).
- **A test that would confirm it:** in `wg_test.c`, a 4× depth attachment cleared to 0.25 and resolved
  (SAMPLE_ZERO) into a 1× D32. Copy it to a buffer and assert 0.25. dEQP-VK `renderpass2.depth_stencil_resolve.*`.

### 11. Helper invocations and `terminateInvocation`
- **Where:** `vk/compiler/wgsl_print.c:1172-1175` (`is_helper_invocation` / `load_helper_invocation` → `false`).
  `:1250-1253` (`terminate` → `discard;` and execution continues). Advertised at `wg_caps.c:142-143`.
- **The defect:**
  - `helperInvocationEXT()` must be true after `demote`, and `gl_HelperInvocation` is true for real helpers. Here
    both are always false.
  - `OpTerminateInvocation`, which glslang emits for `discard` when targeting SPIR-V 1.6 / Vulkan 1.3, becomes
    `nir_terminate` with no jump (vtn_structured_cfg.c:1278-1280). Unlike OpKill's demote, vtn adds no loop break, so
    the printed `discard;` keeps the invocation looping as a helper. A loop whose only exit was the terminate can hang
    the device.
- **When it triggers:** shaders branching on `gl_HelperInvocation` / `helperInvocationEXT` (dEQP's demote tests,
  some derivative-safe code), and `discard` inside loops in SPIR-V 1.6 binaries.
- **A test that would confirm it:** in `tests/wgsl.test.ts`, a SPIR-V 1.6 FS with `for(;;){ if (x) discard; }`
  (no other exit). Assert the WGSL leaves the loop (or the function) after the `discard`. And a demote shader writing
  `helperInvocationEXT() ? 1 : 0` to a colour. dEQP-VK `glsl.demote.*`, `glsl.terminate_invocation.*`.

### 12. `workgroupUniformLoad`'s variables can push workgroup memory past the advertised limit
- **Where:** `vk/compiler/wgsl_print.c:1583-1586,1715-1716` (one `var<workgroup> wg_ucN: u32` for each uniform
  condition). `:1667-1669` (`shm`). `vk/driver/wg_caps.c:219` (`maxComputeSharedMemorySize` = WebGPU's whole limit).
- **The defect:** WebGPU counts each workgroup variable rounded up to 16 bytes. A shader whose `shared` arrays fill
  `maxComputeSharedMemorySize` exactly (common: sized from the limit), plus one `if` around a barrier, goes over.
  The compute pipeline is then invalid.
- **When it triggers:** a 16 KiB `shared` array plus any barrier inside an `if` or a breaking loop.
- **A test that would confirm it:** in `tests/wgsl.test.ts`, `shared uint s[4096]` with `if (gl_LocalInvocationIndex
  < n) { barrier(); }` (n uniform). Assert Chromium creates the compute pipeline. Or advertise the limit less
  16 × (the most uniform conditions).

### 13. Multisample counts reported for formats WebGPU can't multisample
- **Where:** `vk/driver/wg_device.c:394-397` (4× for every 2D optimal attachment format). `wg_caps.c:249-255`
  versus `:285` (`framebufferIntegerColorSampleCounts = 1` while ImageFormatProperties offers 4× for integer
  attachments).
- **The defect:** WebGPU has no multisampling for `rg32*`/`rgba32*` (uint, sint and float). A 4× image of those
  passes the query and fails `createTexture`. The integer answers also contradict each other.
- **When it triggers:** MSAA with 32-bit-channel targets (`R32G32B32A32_SFLOAT` HDR MSAA).
- **A test that would confirm it:** in `tests/venus-renderer.test.ts`, query `vkGetPhysicalDeviceImageFormatProperties`
  for `R32G32B32A32_SFLOAT` COLOR_ATTACHMENT and assert sampleCounts == 1. Check that every format's reported
  counts are within WebGPU's table for that format.

### 14. `vkCmdDispatchBase` ignores its base
- **Where:** `vk/driver/wg_cmd.c:916-923` (`bx, by, bz` unused). `wgsl_print.c:1152-1157` (`gid`/`wid` straight
  from WGSL).
- **The defect:** `gl_WorkGroupID` and `gl_GlobalInvocationID` start at 0 instead of the base, and the results are
  silently wrong. It is core since 1.1, and `KHR_device_group` is advertised.
- **When it triggers:** programs that split a dispatch with `vkCmdDispatchBase` (`DISPATCH_BASE_BIT` pipelines).
- **A test that would confirm it:** in `wg_test.c`, `vkCmdDispatchBase(1,0,0, 1,1,1)` writing `gl_WorkGroupID.x`
  into an SSBO; assert 1. dEQP-VK `compute.basic.dispatch_base*`.

### 15. Storage-buffer bindings that aren't 4-byte multiples
- **Where:** `vk/driver/wg_cmd.c:1503-1509` (for storage, the size is `vk_buffer_range` as is).
- **The defect:** WebGPU requires a storage binding's size to be a multiple of 4. A `VK_WHOLE_SIZE` on a 10-byte
  buffer, or `range = 6`, is valid Vulkan but makes the bind group invalid, which drops the submit.
- **When it triggers:** byte-sized SSBOs (text and byte streams) bound whole.
- **A test that would confirm it:** in `wg_test.c`, an SSBO of size 10 bound `VK_WHOLE_SIZE`, read as `uint b[]`.
  Assert the first two words and that no validation error is logged (round down to 4, keeping `arrayLength` right).

### 16. Shadow sampling quietly drops its bias, LOD and gradients
- **Where:** `vk/compiler/wgsl_print.c:1411-1433`.
- **The defect:**
  - `txb` with a comparator → `textureSampleCompare`, without the bias.
  - `txl` and `txd` with a comparator → `textureSampleCompareLevel`, which is level 0 only.
  - `txl` on a non-compare depth texture → `i32(lod)`, which truncates instead of rounding to the nearest mip.

  None of these fails or warns.
- **When it triggers:** mipmapped shadow maps or VSM-like depth mips sampled at an explicit LOD.
- **A test that would confirm it:** in `tests/wgsl.test.ts`, `textureLod(sampler2DShadow, ..., 2.0)` should be
  refused (or emulated) rather than printed as level 0. dEQP-VK `glsl.texture_functions.texturelod.sampler2dshadow*`.

### 17. API version 1.3 without what 1.1 and 1.3 require
- **Where:** `vk/driver/wg_device.c:162` (`apiVersion` 1.3.296). `wg_caps.c:110-156` (no `multiview`,
  `inlineUniformBlock` or `bufferDeviceAddress`). `wg_format.c:195-222` (no `STORAGE_IMAGE_ATOMIC` on
  `R32_UINT`/`R32_SINT`, no texel-buffer features, all of which are mandatory format support).
- **The defect:** spec non-conformance. Programs that rely on 1.3's guarantees without checking (inline uniform
  blocks, BDA) fail at pipeline or descriptor creation. `timestampComputeAndGraphics = true` (`wg_caps.c:260`) with
  CPU-time timestamps (backlog) is in the same class.
- **A test that would confirm it:** a caps test in `tests/venus-renderer.test.ts` asserting the 1.3 required-feature
  list, or that `apiVersion` is lowered to what is backed.

---

## Already known (docs/backlog.md), confirmed in the code
- **Sampler `mipLodBias` and `unnormalizedCoordinates` are ignored.** `wg_device.c` CreateSampler never reads them.
  The comment at `wg_caps.c:231`, "WebGPU's samplers have no bias: the shader adds it", is false: nothing in
  `vk/compiler` adds a bias.
- **Subgroups of one with BASIC advertised for compute.** `load_subgroup_size`, `load_subgroup_invocation`, `elect`,
  `load_num_subgroups` and `load_subgroup_id` reach the printer's default case (`wgsl_print.c:1294-1295`) and fail.
  `nir_lower_subgroups` with `subgroup_size = 1` would fold all of them.
- **Vertex strides and vertex-buffer offsets that aren't multiples of 4** (`wg_shader.c:892`, `wg_cmd.c:809`), even
  though 1- and 2-byte vertex formats are advertised (`wg_format.c:161-172`).
- **The push buffer as an extra uniform buffer and dynamic offset beyond the advertised per-stage and per-layout
  limits** (`wg_caps.c:192,202`).
- **Integer textures sampled with a sampler are fetched clamp-to-edge at LOD 0 for implicit-LOD sampling**
  (`wgsl_nir.c:381-423`). vk/README.md "The shader path" still lists these as failing.
- **Early fragment tests** are not honoured (`wgsl_print.c:1686` prints `""` either way).

## Lower-confidence notes (not ranked)
- **Flat varyings mixing int and float.** `nir_opt_varyings` may pack 32-bit flat ints and floats into one flat
  vec4 (nir_opt_varyings.c:5357-5364). The printer then types the whole location by its last load
  (`wgsl_print.c:410-411`), so an int's bits travel in an `f32` lane. That is bit-exact unless a backend canonicalizes
  NaNs or flushes denormals in varyings. Test: a VS/FS pair with a `flat int` (values 1..8, which are f32 denormals)
  and a `flat float` that get packed together; assert the int arrives exactly.
- **UBOs at a memory's end.** `wg_cmd.c:1507` widens a uniform binding to the shader's declared size only within
  the memory. A UBO placed at a memory's end, with a std140 tail rounded up, or the 65536-byte fallback of
  `wgsl_print.c:345-346`, still fails draw-time size validation.

## Checked and found fine
- **ALU:**
  - All operands are bitcast per the op's NIR input types.
  - `imod` sign fix-up.
  - Shifts masked to 31, with arithmetic `ishr` and logical `ushr`.
  - `ifind_msb`/`ufind_msb`/`find_lsb` map onto `firstLeadingBit`/`firstTrailingBit`, -1 included.
  - Bitfield extract/insert argument order and types.
  - `bitfield_select`, `bcsel`/`fcsel` operand order.
  - The unordered and ordered float compares (`fltu`, `fgeu`, `fequ`, `fneo`).
  - `fisfinite` done by bits.
  - The `b2*` conversions.
  - Integer-dot lowering (stays 32-bit).
  - `frem`/`fmod`, `fquantize2f16` and the `*_sat` ops are lowered before printing.
  - Constants are printed as bit patterns, so no const-eval overflow or NaN.
- **Out of SSA:** register handling, undefs (zero vars), loops with no continue construct, `nir_lower_returns` (no
  early `return o` skips the y flip).
- **Uniformity in compute:** `workgroupUniformLoad` covers ifs around barriers and breaks out of barrier loops,
  recursively. Derivative uniformity is turned off by a directive placed before the declarations.
- **Barriers:** `storageBarrier`, `textureBarrier` and `workgroupBarrier` follow the memory modes in compute;
  subgroup-scope and memory-only barriers are dropped.
- **Memory:** SSBO, shared and scratch word addressing with write masks. A whole SSBO or shared array becomes atomic
  once any atomic touches it (plain accesses then use `atomicLoad`/`atomicStore`). UBO `vec4` indexing.
- **Push constants:** the immediates' struct is copied into an indexable array, and the immediate and push-UBO split
  works per stage (`wg_cmd.c:1592-1618`). The push UBO's dynamic offset is the last one of group 3.
- **Descriptors:** slot and binding arithmetic (`deref_element` for arrays of arrays), sets ≥3 packed into group 3
  (`set_groups`), and `res_set` picking with empty layouts.
- **Textures:**
  - The WGSL built-in argument orders for sample, bias, level, grad, compare, compare-level, gather and gather-compare
    (array index, depth ref and offset placement).
  - Offsets are const literals.
  - Array layers rounded half-to-even; `txf` and `txf_ms` on depth and multisampled textures.
  - `txs` of arrays and cubes.
  - The 1D → 2D lowering for textures, images and size queries.
  - Input attachments as 2D or MS.
  - The depth-view and unfilterable variant, multisampled float as `unfilterable-float`.
- **Entry points:**
  - `vertex_index` and `instance_index` include base vertex and instance, matching `instance_id_includes_base_index`.
  - Integer varyings are flat, and VS outputs are typed and interpolated as the FS reads them.
  - `nir_opt_varyings` fixes up the barycentrics of convergent inputs it moves into another qualifier's slot.
  - The y flip keeps framebuffer winding, so `frontFace` maps directly.
  - Clip distances get `enable clip_distances`.
  - Sample id and mask, front facing, frag depth and sample mask out.
- **Pipelines and caching:**
  - Partitions compile VS and FS together; there is no GPL (vk_pipeline.c:1512-1540).
  - A cached FS with a recompiled VS shares the program by link hash.
  - Serialization hashes program data field by field.
  - Program, variant and merge refcounts and frees.
  - Disk-cache keys include the caps.
  - The storage-texture access check across stages.
- **Caps:**
  - Limits come from the device actually requested (`deviceRequest` asks for every `LIMITS` key).
  - Immediates are capped at 128 bytes and are zero without `setImmediates`.
  - Clip-distance, depth-clip, compression, tier1, tier2, bgra8 and float32 features gate the right formats and
    features. 16-bit norm formats are hidden without tier1 and are unfilterable.
  - Anisotropy is only enabled with all-linear filters (WebGPU's rule).
  - Format, image-format and DRM-modifier feature lists are consistent with each other.
  - Workgroup zero-init (vtn sets `zero_initialize_shared_memory`, and WGSL zero-inits anyway).
