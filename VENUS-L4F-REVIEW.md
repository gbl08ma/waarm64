# Venus L4f: static review

**Commit reviewed:** `6ccdcd77` (the diff `301dd138..6ccdcd77`: VK3 L4f's "remaining findings fixed or filed" and "r32
integer formats not multisampled").
**Scope:** `vk/compiler/` (wgsl_print.c, wgsl_nir.c, wgsl.h), `vk/driver/` (wg_cmd.c, wg_device.c, wg_caps.c,
wg_shader.c, wg_private.h, wg_test.c), `web/venus-gpu.ts`, and the tests added with them. I read the code only as of the
commit, against the Vulkan, WebGPU and WGSL specs. Nothing was built or run.

**Bottom line.** Two high-severity defects. The new depth and stencil resolve reads the multisampled attachment *after*
the WebGPU pass has already applied its store op, so the common `storeOp = DONT_CARE` + resolve pattern resolves
cleared (zeroed) data. Making unwritten SSBOs `read-only-storage` creates WebGPU usage-scope conflicts with writable
storage in the same `VkDeviceMemory` (one GPUBuffer per memory), which used to be valid. Two advertised limits now
break Vulkan's rules, and the new tests assert the wrong values: `framebufferIntegerColorSampleCounts` is 1|4 while
R32_UINT and the 32-bit integer formats report 1 sample only, and `maxComputeSharedMemorySize` is 16368 on a
default-limit device, below Vulkan's required 16384. The rest are lower-severity gaps in the resolve and the tests.

---

## 1. [High] Depth/stencil resolve reads the attachment after a DONT_CARE store has discarded it

- **Where:** `vk/driver/wg_cmd.c:516` (depth store op: `store_op(d->storeOp, suspending)`), `:528` (stencil, same),
  `:589-604` (`end_rendering` emits `resolveDepth` after `OP_PASS_END`); `web/venus-gpu.ts:986-1027` (`resolveDepth`
  samples `src` in a new pass).
- **Defect:** Vulkan resolves a depth/stencil attachment at the end of the render pass, *before* its store op. The
  driver does the resolve as a separate worker draw that samples the multisampled source after the WebGPU pass has
  ended. `store_op()` maps `VK_ATTACHMENT_STORE_OP_DONT_CARE` to WebGPU `"discard"` (wg_cmd.c:429), and WebGPU zeroes
  a discarded aspect. The resolve then reads zeros: depth resolves to 0.0 and stencil to 0.
- **When:** whenever a multisampled depth or stencil attachment has `resolveMode != NONE` and `storeOp = DONT_CARE`
  (the usual MSAA pattern: keep only the resolved image; also what Mesa's render-pass emulation produces for
  `VkSubpassDescriptionDepthStencilResolve` with a DONT_CARE store).
- **Fix direction:** when `resolve_src[a]` is set and the pass isn't suspending, force `"store"` for that aspect.
- **Confirming test:** `wgt_misc` scenario 9 with `.storeOp = VK_ATTACHMENT_STORE_OP_DONT_CARE`. Expect depth 0.25 and
  stencil 0x5a in the resolved image; it will read 0 and 0. Scenario 9 as committed uses `STORE` only, so it can't see
  this.

## 2. [High] Unwritten SSBOs now `read-only-storage`: usage-scope conflicts with writable storage in the same memory

- **Where:** `vk/compiler/wgsl_print.c:368-371` (`if (writes) r->r.kind = WGSL_STORAGE;`, so a buffer the stage
  doesn't write stays `WGSL_STORAGE_READ` even without `NonWritable`); `vk/driver/wg_shader.c:184-187` (the BGL entry
  type comes from that kind: `"read-only-storage"`); `vk/driver/wg_cmd.c:1589-1601` (every buffer binding is a range
  of `wg_memory_buffer(d->buffer->mem)`, one GPUBuffer per `VkDeviceMemory`).
- **Defect:** in WebGPU, a buffer is one subresource. A usage scope that holds both `storage` and `storage-read` for the
  same GPUBuffer is not a compatible usage list. Only all-read-only usages, or all-`storage` (the storage exception),
  are allowed. Before this change, a buffer without the GLSL `readonly` qualifier was `read_write`. Two SSBOs
  sub-allocated from one memory, one read and one written, therefore shared the `storage` usage, which was valid. Now
  the read one is `read-only-storage`, and the dispatch, or the whole render pass, fails validation.
- **When:** in a compute dispatch, an input SSBO (no `readonly` qualifier) and an output SSBO in the same
  `VkDeviceMemory`, which is routine for apps that sub-allocate (VMA, DXVK/vkd3d, most engines). In a render pass, the
  usage scope is the whole pass: one draw reads buffer X and another writes a buffer in X's memory, or X itself.
  Shaders that really were declared `readonly` already had this problem; the change widens it to every unwritten SSBO.
- **Fix direction:** decide read-only vs writable per binding at bind-group time across the scope, or keep `read_write`
  for unwritten buffers wherever the stage allows writable storage (compute and fragment). Use `read` only where it is
  needed, in vertex stages.
- **Confirming test:** a `wgt_misc` scenario with a compute shader `buffer In { uint a[]; } i; buffer Out { uint b[];
  } o; void main(){ o.b[0] = i.a[0]; }` and both buffers bound at different offsets of one `VkDeviceMemory`. Expect
  `b[0] = a[0]`. Today it raises a WebGPU validation error ("storage and read-only storage in one scope") and leaves
  `b[0]` unwritten. A render-pass version: two draws in one pass, one reading SSBO X in the fragment stage, the next
  writing SSBO Y from X's memory.

## 3. [Medium] `framebufferIntegerColorSampleCounts = 1|4` contradicts the integer formats' own sample counts

- **Where:** `vk/driver/wg_caps.c:286-287`; `vk/driver/wg_device.c:417-425` (sampleCounts = 1 for `r32uint`,
  `r32sint`, `rg32*`, `rgba32*`); `tests/venus-renderer.test.ts` (new assert `[rgba32Samples, rgba8Samples,
  r32uintSamples, integerSamples] == [1, 5, 1, 5]`).
- **Defect:** Vulkan ("Supported Sample Counts" under `vkGetPhysicalDeviceImageFormatProperties`): if `usage` includes
  `COLOR_ATTACHMENT` and the format is an integer format, `sampleCounts` must be a superset of
  `framebufferIntegerColorSampleCounts`. R32_UINT/SINT and R32G32(_B32_A32)_UINT/SINT are colour-attachment formats
  that report 1 sample only, while the limit says 1|4. The test asserts this inconsistent pair as correct. The comment
  at wg_caps.c:286 ("WebGPU multisamples its … 32-bit single-channel integer formats") also contradicts wg_device.c,
  which excludes `r32uint`/`r32sint`. This commit reverts the commit-message claim it makes.
- **Fix:** `framebufferIntegerColorSampleCounts = VK_SAMPLE_COUNT_1_BIT` (Vulkan's minimum is 1). That is the value it
  had before this change.
- **Same class, lower:** `framebufferColorSampleCounts = 1|4` (wg_caps.c:250) with R32G32B32A32_SFLOAT and
  R32G32_SFLOAT colour attachments at 1 sample is the float half of the same rule. It can't be fixed by lowering the
  limit (Vulkan's minimum is 1|4), so it is at least a known violation to file. Today it is presented as "as WebGPU
  has it". dEQP-VK `api.info.image_format_properties.*` checks these supersets.
- **Confirming test:** in `wgt_caps`, assert for each integer colour-attachment format that `sampleCounts &
  framebufferIntegerColorSampleCounts == framebufferIntegerColorSampleCounts`. It fails for R32_UINT today.

## 4. [Medium] `maxComputeSharedMemorySize` is below Vulkan's required minimum on default-limit devices

- **Where:** `vk/driver/wg_caps.c:219-220` (`L->max_compute_workgroup_storage_size - 16`); `web/venus-gpu.ts:102`
  (WebGPU default 16384); `tests/venus-renderer.test.ts` (asserts `none.sharedMemory == 16384 - 16`).
- **Defect:** Vulkan's required minimum for `maxComputeSharedMemorySize` is 16384. A device on an adapter at WebGPU's
  default (16384: SwiftShader, many mobile and compat adapters) now reports 16368, which is non-conformant. The 16
  bytes are reserved for `wg_uc` in *every* shader, though only compute shaders with a barrier under an `if` emit it
  (wgsl_print.c:1790).
- **Fix direction:** keep the advertised limit, and put the uniform-condition word inside `shm`'s slack (WebGPU rounds
  each workgroup var up to 16 bytes, so `shm` usually has a spare word), or one word past `shared_size` where the
  rounded total still fits. Refuse a shader only when it truly overflows. The backlog's new
  `zero_initialize_workgroup_memory.max_workgroup_memory` crash names this limit as its suspect, which is another
  reason to undo the cut.
- **Confirming test:** in `wgt_caps` on the `none` caps, assert `maxComputeSharedMemorySize >= 16384`. It fails with
  16368.

## 5. [Low-Medium] Depth/stencil resolve ignores the render area and resolves only one layer

- **Where:** `web/venus-gpu.ts:1007-1024` (full-target triangle, no scissor or viewport); `vk/driver/wg_cmd.c:596-604`
  (one `srcLayer`/`dstLayer`).
- **Defect:** Vulkan resolves only within `renderArea`. The worker's draw covers the whole destination level, so it
  overwrites depth/stencil outside the area that Vulkan leaves untouched. With `layerCount > 1` (layered rendering),
  only the view's base layer is resolved.
- **When:** a partial-area pass, for example a tiled or scissored post-process, with a depth resolve; or layered MSAA
  depth.
- **Confirming test:** scenario 9 with `renderArea = {0,0,2,2}` and the resolve target pre-filled with 1.0. Expect
  1.0 outside the 2x2 area; today it gets 0.25.

## 6. [Low] Tests that check less than they claim

- `tests/wgsl.test.ts` (L4f test): the terminate, demote, helper and cube-array checks are text matches plus "Chromium
  compiles it". None runs the shader, so `terminate.frag`'s "the invocation must leave the loop" isn't checked against
  a hang, and helper semantics are not checked. A `wgt_run` draw of `terminate.frag` (completes, pixels with
  `c.x > 0.5` unwritten) and of `demote.frag` would test the behaviour.
- `tests/venus-driver.test.ts` `misc: depthResolve` covers only `STORE`, a full render area and one layer, which is
  exactly the configuration where findings 1 and 5 don't show.
- `tests/venus-renderer.test.ts` asserts the inconsistent limits of findings 3 and 4 as expected values, so it will
  defend the defects against a fix.

---

Checked and found sound (not findings): the `owns_compute_module` hand-off and the id LIFO reuse that the
`freedModule` test depends on; `flip_z` (w − z with the range swapped at replay, wg_cmd.c:1671-1672, gives
`a + (b−a)z` for any inverted range); the `CONSTANT_ALPHA` constant rewrite; the dynamic texture/sampler index loop
(it terminates, and the clamped index is shared only between arrays of equal length); signed shared atomics (bitcasts
on every atomic path); `depthReadOnly`/`stencilReadOnly` emission together with the cleared depth and stencil write in
the pipeline key; the cube storage `2d-array` view and its release.
