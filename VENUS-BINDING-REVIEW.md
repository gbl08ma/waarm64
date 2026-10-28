# Venus resource-binding model: static review

- **Commit:** `221d16c8` (all file:line references are at that commit, read with `git show 221d16c8:<path>`).
- **Scope:** how a Vulkan pipeline layout, descriptor sets, push constants and dynamic offsets become WebGPU bind group
  layouts, bind groups, WGSL bindings and buffer usages: `vk/driver/wg_descriptor.c`, `wg_shader.c`, `wg_cmd.c`,
  `wg_device.c`, `wg_caps.c`, `wg_private.h`, `vk/compiler/wgsl_print.c`, `wgsl_nir.c`, `wgsl.h`, `web/venus-gpu.ts`.
  Static reading only: nothing was built or run.

**Bottom line.** The slot and binding numbering (`2·(base+slot)`, `+1` for samplers and texel parameters, planes after
the set's slots, push buffer at 998), the dynamic-offset ordering and the per-set bind-group cache are consistent with
each other. I found no stale bind group from a missing version bump. The defects sit where a hidden binding or a program
*variant* was added on its own. The worst one is transform feedback's compute pass: it adds up to 14 storage buffers to
the vertex stage's, nothing checks that count, and its `try/catch` can't catch WebGPU validation errors, so the whole
submit is lost. Next come two results of how program variants work. A shared sampler's nearest twin silently unfilters
other textures. A widened variant shares a bind-group-layout identity with a writing program, and that suppresses a
host readback. Below those: some fixed caps of 64 and some limits that aren't counted. Several issues I found are already in
`docs/backlog.md`; they're listed at the end and not ranked.

---

## 1. Transform feedback's compute pass can exceed the storage-buffer limit, and the failure invalidates the whole submit (high)

**Where:** `web/venus-gpu.ts:1551-1557` (the capture's bind group layout), `:1558-1574` (`try/catch`), `:1478-1481`
(`setBindGroup`/`setPipeline`); limits it can reach: `vk/driver/wg_caps.c:263` (`maxVertexInputBindings` = 8),
`:363` (`maxTransformFeedbackBuffers` = 4); visibility `vk/driver/wg_shader.c:372` (a captured vertex stage's
resources are also COMPUTE-visible).

**Defect:** `xfbPipeline` builds a group of its own with these entries:
- binding 12 (`storage`, the state buffer);
- binding 14 (`read-only-storage`, the index buffer);
- one `storage` per captured buffer (up to 4);
- one `read-only-storage` per vertex-buffer slot that has attributes (up to 8; `wg_vertex_slots` can add slots for
  attributes past their stride).

That is up to 14 storage buffers in the compute stage. The program's own groups are added on top: every resource of
the vertex stage is COMPUTE-visible, including its SSBOs, the UBOs that `fold_uniforms` turned into storage, and its
texel buffers. Nothing compares the total with `maxStorageBuffersPerShaderStage` (8 by default, 10 on SwiftShader).

When the total is over, `createBindGroupLayout`/`createPipelineLayout` don't throw. They return invalid objects and
raise a validation error. So the `catch` at :1571 never runs, `x.pipelines` is set to invalid pipelines, and
`pass.setPipeline(p.main)` invalidates the command encoder. The whole queue submit is dropped, not only the capture.

**When:** a valid draw under the advertised limits. For example, a captured draw with 4 transform-feedback buffers
and 3 or more vertex bindings (2 + 4 + 3 = 9 > 8), or 2 buffers and 5 bindings. GL_SEPARATE_ATTRIBS particle systems
through ANGLE hit this. Any SSBO or texel buffer the vertex stage reads makes it more likely.

**Test:** a `tests/venus-driver.test.ts` (or dEQP-VK–style) case. The vertex shader captures `xfb_buffer` 0–3, each
with one output, and reads 4 vertex bindings. Draw once inside begin/end transform feedback, wrapped in a
`pushErrorScope('validation')` on the worker. Expect no error and the four buffers written; at 221d16c8 the scope
reports a storage-buffer-count error and the frame's other draws are missing too. Fix direction: count the capture's
bindings against the limit before making the layout and refuse (warn) the capture, or read vertex buffers packed into
fewer bindings; and check `device.popErrorScope()` instead of `try/catch`.

## 2. A sampler flagged non-filtering for one unfilterable texture gives every texture it samples its nearest twin (medium)

**Where:** `vk/driver/wg_shader.c:296-306` (`wg_program_variant` marks every sampler paired with a masked texture as
`nonfiltering`), `vk/driver/wg_cmd.c:2272-2273` (`bind_group` binds `d->sampler->nearest` for such a sampler binding),
`vk/driver/wg_cmd.c:830-836` (`program_for` masks a float-declared texture bound to a depth or unfilterable view).

**Defect:** the non-filtering flag belongs to the sampler *binding*, not to the (texture, sampler) pair. When one
sampler (a separate `VK_DESCRIPTOR_TYPE_SAMPLER`) samples both an unfilterable texture and a filterable one, the
variant binds the sampler's nearest twin for both. The filterable texture silently loses linear and mipmap filtering.
WebGPU accepts a non-filtering sampler with a filterable texture, so nothing reports it.

**When:** shaders that use separate samplers (HLSL-style code through DXVK/vkd3d, Godot 4's shared material samplers)
and read a depth view, or an `r32float` view without `float32-filterable`, through `texture()` (soft particles, SSAO,
water) with the same sampler as their colour textures. Every texture in that draw that shares the sampler is drawn
nearest.

**Test:** a fragment shader with `texture2D depthTex, colorTex; sampler s;` that outputs `texture(sampler2D(colorTex, s), uv)`
and also reads `depthTex` through `s`. Bind a D32 view to `depthTex`, a 2×2 RGBA8 checker to `colorTex` and a LINEAR
sampler, then draw a quad at a texel-centre offset. The colour should be interpolated; at 221d16c8 it is the nearest
texel. Fix direction: when a sampler also serves a filterable texture, split it in the variant (WGSL: a second sampler
binding for the unfilterable texture's pairs) instead of downgrading it.

## 3. A widened compute variant shares a bind-group-layout identity with a writing program, so the writer's OP_BIND is skipped and its host-visible writes aren't read back (medium)

**Where:** `vk/driver/wg_shader.c:291-295` (a widened binding becomes `WGSL_STORAGE` with `written` still false),
`:191-210` (`bgl_uid` keys on the layout JSON, which says only `"storage"`), `vk/driver/wg_cmd.c:757-759`
(`record_sets` skips OP_BIND when sets, `bgl_uid` and offsets match), `:2311-2328` (readback is registered only in
`bind_group`, and only for `kind == WGSL_STORAGE && written`).

**Defect:** readback of host-visible storage that a shader writes is registered when an OP_BIND is replayed, from that
bind's `b->program`. Take compute program B, which reads X and writes Y, with X and Y in one memory. B gets a variant
where X is `storage` but not `written`. Its group has the same JSON, and so the same `bgl_uid`, as program A, which
writes both X and Y. Dispatch B and then A on the same sets: A's group is skipped as unchanged. Replay registers
readback only for B's written bindings (Y), so A's writes to X never reach the guest's mapping.

**When:** two compute pipelines with the same group layout on the same set, the first one widened (it reads a buffer
that shares a memory with one it writes), and the memory host-visible: compute results the guest maps afterwards.

**Test:** two compute shaders on one set with SSBOs X and Y, suballocated from one HOST_VISIBLE|HOST_COHERENT memory.
B: `Y[i] = X[i]`. A: `X[i] = 7; Y[i] = 9`. Record one command buffer: dispatch B, dispatch A. Wait on the fence and map
X: expect 7s; at 221d16c8 X keeps its old bytes. Fix direction: put `written` in the `bgl_uid` key, or register
readback per dispatch or draw from its program instead of per OP_BIND.

## 4. Variants only look at the first 64 resources, and texture-sampler pairs are silently capped at 64 (low-medium)

**Where:** `vk/driver/wg_cmd.c:817` (`n = MIN2(p->resource_count, 64)` in `program_for`), `vk/driver/wg_shader.c:287`
and `:314` (the variant mask is 64 bits), `vk/compiler/wgsl_print.c:674-677` and `vk/driver/wg_shader.c:381`,
`:550` (pairs past `WGSL_MAX_PAIRS` = 64 are dropped without an error).

**Defect:** a program can have up to 128 resources (`WGSL_MAX_RESOURCES`). Resources are sorted by group and binding,
and those at index 64 or later are never checked:
- A float-declared texture there that is bound to a depth or unfilterable view keeps `"sampleType":"float"`. The bind
  group is then invalid.
- A read-only storage buffer there that shares a memory with a written one in a dispatch isn't widened. That is a
  usage-scope error.

Separately, an if-tree over separately indexed texture and sampler arrays emits one pair per combination (8 textures
× 9 samplers = 72). Pairs past 64 are dropped, so an unfilterable texture's sampler in a dropped pair stays
`filtering`. `createRenderPipeline` then refuses the unfilterable-float/filtering combination. Either way the
submit is lost.

**When:** large layouts: two stages with about 30 combined image samplers each and the depth texture in a later set.
Also `texture2D t[8]; sampler s[9]` indexed separately, with one element bound to a depth view.

**Test:** a pipeline whose vertex and fragment stages together declare more than 64 bindings, with a float-sampled
texture in set 2 bound to a D32 view. Expect a valid submit (error scope empty). Plus a translator test with 72 pairs
that checks `info.pair_count` or a failure, not a silent truncation.

## 5. A uniform block declared past `maxUniformBufferBindingSize`, or past its memory's end, makes an invalid binding (low-medium)

**Where:** `vk/compiler/wgsl_print.c:406-416` (a UBO's declared size is the furthest byte NIR's range reaches, 65536
when unknown, never clamped), `:727-728` (`var<uniform> array<vec4<u32>, size/16>`), `vk/driver/wg_cmd.c:2259-2260`
(the binding is widened to `res->size` and clamped only to the memory's end).

**Defect:** in Vulkan, the descriptor's range is what's limited by `maxUniformBufferRange`, not the block a shader
declares. A dynamically indexed `uniform B { vec4 a[8192]; }` (128 KiB) bound with a 64 KiB range is valid. Here
the binding is widened to 128 KiB. If the memory is that large, the bind group exceeds `maxUniformBufferBindingSize`
and is invalid. If the memory is smaller, the binding is clamped below the module's declared size, and the draw fails
WebGPU's minimum-binding-size check. Either way the submit is lost.

The second case also hits blocks under 64 KiB whose dedicated memory is smaller than the block, such as a 1 KiB buffer
bound to a `mat4[256]` block. The backlog's "UBOs at a memory's end" note covers the dynamic-offset form of this. The
non-dynamic clamp below the declared size, and the over-limit case, aren't described there.

**Test:** the 8192-vec4 block with a 64 KiB bound range in a large memory, and a `mat4[256]` block over a 1 KiB buffer in
its own 1 KiB memory, reading only element 0. Expect correct output and no validation error. Fix direction: clamp the
declared size to `maxUniformBufferBindingSize`, and fold a binding whose memory can't hold the block into read-only
storage.

## 6. Input attachments are advertised apart from sampled images but bound as WebGPU sampled textures (low)

**Where:** `vk/driver/wg_caps.c:246-248` (`maxPerStageDescriptorSampledImages` = WebGPU's whole sampled-texture
limit, `maxPerStageDescriptorInputAttachments` = 4 on top), `:258-260` (the same for the set limits),
`vk/compiler/wgsl_print.c:275-277` and `vk/compiler/wgsl_nir.c:94-101` (subpass inputs become 2D textures).

**Defect:** Vulkan counts input attachments separately from sampled images; WebGPU counts them as sampled textures. A
fragment stage with 16 sampled images and 1 input attachment is within the advertised limits but needs 17 textures
(> 16). The bind group layout or pipeline layout is invalid.

**Test:** a fragment shader with `sampler2D t[16]` and one `subpassInput`. Expect a valid pipeline. Fix: advertise
`sampled - 4` sampled images, or 0 input attachments past what's left.

## 7. A descriptor write replaces a binding's immutable sampler (low)

**Where:** `vk/driver/wg_descriptor.c:323-326` (`COMBINED_IMAGE_SAMPLER`: `if (image->sampler) d->sampler = …`), also
through `wg_descriptor_write_template` (:388) and push descriptors.

**Defect:** Vulkan says `pImageInfo->sampler` is ignored for a binding with immutable samplers, and applications may
pass any value there. The driver binds whatever handle they pass. A YCbCr binding is then sampled through a sampler
whose conversion is not the one compiled into the shader. A stale or garbage handle is dereferenced. Mesa's Venus
guest driver probably clears the handle before it reaches the renderer, which would hide this in practice. The driver
itself doesn't guard against it.

**Test:** a binding with an immutable LINEAR sampler, written with `pImageInfo->sampler` set to a different NEAREST
sampler, then drawn. Expect linear filtering. In a driver unit test, assert that `slots[k].sampler` equals the
layout's immutable sampler after the write.

## 8. Hardening: nothing ties the advertised descriptor counts to WebGPU's binding numbers (low, not reachable at default limits)

**Where:** `vk/driver/wg_descriptor.c:159` (`GetDescriptorSetLayoutSupport`: up to 1024 slots), `vk/driver/wg_caps.c:349`
(`maxPerSetDescriptors` = 1024), `vk/compiler/wgsl.h:28` (`WGSL_PUSH_BINDING` 998), `wgsl_nir.c:186`
(binding = 2·(base + slot)).

A slot at or past 499 (planes included, and the sets of group 3 added together) maps to binding 998 or more. Binding
998 collides with the push buffer's binding in group 3, and anything past it exceeds `maxBindingsPerBindGroup`
(1000, never requested). The per-layout limits keep this out of reach with WebGPU's default limits (about 100 slots
at most). The advertised limits come from the adapter, though, and nothing guards an adapter with large
sampled-texture limits. Add an assertion or a clamp in `wg_caps_properties`, and a refusal in `program_create`.

A related small one: a UBO that `fold_uniforms` moves into storage keeps the guest's offset, which only has to meet
`minUniformBufferOffsetAlignment`. A device whose `minStorageBufferOffsetAlignment` is larger would then reject the
binding (`wg_caps.c:299-300`; `wg_cmd.c:2256`).

---

## Known gaps I confirmed (already in `docs/backlog.md`, not ranked)

- The push buffer is a dynamic uniform buffer in group 3. A layout with `maxDescriptorSetUniformBuffersDynamic` (8)
  dynamic UBOs and push constants past the immediates (any push constants where `setImmediates` is missing, and every
  vertex stage that reads draw parameters) has 9 dynamic UBOs > 8 (`wg_caps.c:255`, `wg_shader.c:410-412`).
- Texel buffers are storage buffers plus a uniform buffer, while Vulkan counts them with images
  (`wgsl_print.c:388-398`). They also take uniform room, which pushes more than `WG_FOLDED_UBOS` UBOs into storage
  (`wg_shader.c:624-626`).
- Folding is decided per layout, not per stage. A fragment stage that sees the UBOs a vertex stage overflowed on, plus
  its own overflow, can fold more than 2 (`wg_shader.c:631-637`). This is the same family as the item above.
- Usage scopes: one GPUBuffer per memory. A dispatch's UBO or indirect arguments beside written storage, or a render
  pass with fragment-written storage beside any read use, is invalid.
- Transform feedback with a program of 4 groups (the push buffer's group 3) is refused.
