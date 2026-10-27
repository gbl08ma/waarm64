# Static review: Venus's driver (descriptors, pipelines, queries, recording and replay)

> **Triage (the reviews' session, 2026-10-27; VK3-HANDOVER.md "L4f").** Fixed, each with its test failing first
> (tests/venus-driver.test.ts on SwiftShader in a cloud session): **1** (strips), **3** (the grown push buffer), **4**
> (freed memory under a linear image), **5** (dynamic storage offsets), **6** (no fragment shader), **11** (depth bias on
> lines: WebGPU does refuse it), and 12's odd-sized storage bindings. Left for **VK3 L4f**: 2, 7, 8, 9, 10 and the rest
> of 12 (inverted depth ranges, `CONSTANT_ALPHA`, `vkCmdDispatchBase`, uniform bindings widened past a dynamic
> offset, fans). Nothing here is checked on dEQP-VK yet (L4f's first step). This file goes with L4f's end, its
> findings into docs/backlog.md as they're fixed or filed.

**Commit reviewed:** `d5a8f14`

**Scope:** `vk/driver/wg_descriptor.c`, `wg_shader.c` (programs, variants, merges, render/compute pipelines, the
shader-cache (de)serialization), `wg_cmd.c` (recording, replay, push buffer, readbacks/uploads, submits, syncs),
`wg_device.c` (ids, memory/buffer/image/view/sampler lifetimes, queries, events), `wg_private.h`, `wg_gpu.h`,
`wg_caps.c` where it decides behaviour, and `web/venus-gpu.ts` (the worker side: held submits, `Later`, meta draws,
clears, copies). I did not review the translator (`vk/compiler/`) or the dma-buf import path. Everything here was read
statically; nothing was built or run.

**Bottom line:** recording, replay ordering, completions and the host-visible coherence scheme are carefully built
and mostly right. The serious defects are cases where a valid Vulkan command stream becomes an **invalid WebGPU
command buffer**, and WebGPU then drops the **whole submit**:
- an indexed strip draw without primitive restart (#1);
- a depth attachment sampled while it is read-only (#2);
- the first submit after the push buffer grows (#3);
- a vertex-only pipeline in a pass that has colour attachments (#6).

There are also two lifetime bugs: freed memory still reached through a linear image (#4), and a stale shader-module id
used by compute variants (#7). Two semantics are lost: dynamic offsets of host-visible storage buffers are not read back
(#5), and semaphore waits are never honoured (#8).

---

## Findings, by severity

### 1. Indexed strip draws without primitive restart make the submit invalid
- **Where:** `vk/driver/wg_cmd.c:700-702` (`k.strip_index` is set only when `primitive_restart_enable`);
  `vk/driver/wg_shader.c:908-909`.
- **The defect:** WebGPU requires `primitive.stripIndexFormat` on any strip-topology pipeline used with
  `drawIndexed`/`drawIndexedIndirect`, and it must match the index buffer's format. Dawn rejects the draw: "has a strip
  primitive topology … but a strip index format of Undefined, which prevents it for being used for indexed draw calls".
  Vulkan's default is `primitiveRestartEnable = VK_FALSE`, so an ordinary indexed `TRIANGLE_STRIP`/`LINE_STRIP` draw
  gets a pipeline without `stripIndexFormat`. One invalid draw invalidates the whole command buffer, so the frame or
  upload in that submit is lost.
- **When it triggers:** any `vkCmdDrawIndexed*` with a strip topology and restart disabled. That covers terrain grids,
  degenerate-strip meshes and many older engines. This is very likely the cause of the backlog's "indexed indirect
  strips (`draw.renderpass.indirect_draw.indexed*triangle_strip`, not looked into)", and the direct-draw cases fail the
  same way.
- **Fix direction:** set `strip_index` from `ib_type` for every indexed strip draw. WebGPU always restarts strips at
  0xFFFF/0xFFFFFFFF, which differs from Vulkan only when restart is off and a maximal index value appears.
- **A test that would confirm it:**
  - Chromium, `tests/venus-driver.test.ts` through a new `wgt_pass` scenario in `vk/driver/wg_test.c`: an indexed
    triangle strip (uint16, restart disabled). Assert the fence signals, the pixels show the strip, and the worker's
    `stats.errors === 0`.
  - dEQP-VK `draw.renderpass.indexed_draw.*triangle_strip*` and `draw.renderpass.indirect_draw.indexed*triangle_strip`
    should pass after the fix.

### 2. A depth or stencil attachment that is also sampled in the pass makes the submit invalid
- **Where:** `vk/driver/wg_cmd.c:506-538` (`wg_CmdBeginRendering`: `VkRenderingAttachmentInfo.imageLayout` is never
  read, and there is no `depthReadOnly`/`stencilReadOnly`); `web/venus-gpu.ts:416-421`.
- **The defect:** Vulkan allows a depth image to be the pass's depth attachment in a read-only layout
  (`DEPTH_READ_ONLY_OPTIMAL`, `DEPTH_STENCIL_READ_ONLY_OPTIMAL`, `DEPTH_READ_ONLY_STENCIL_ATTACHMENT_OPTIMAL`, …) and,
  in the same pass, a sampled image or input attachment. In WebGPU that is a usage-scope conflict ("attachment" plus
  "constant") unless the attachment is `depthReadOnly`/`stencilReadOnly`. Without those flags the pass, and with it the
  whole submit, is invalid.
- **When it triggers:**
  - deferred lighting that depth-tests against the G-buffer depth while sampling it for position reconstruction;
  - soft particles;
  - DXVK/D3D11 read-only DSVs bound together with SRVs of the same depth texture;
  - legacy subpasses that read depth as an input attachment while keeping it attached read-only.
- **Fix direction:** for an attachment whose layout is read-only for an aspect, emit `depthReadOnly`/`stencilReadOnly`
  and omit that aspect's load and store ops, as WebGPU requires.
- **A test that would confirm it:**
  - `wg_test.c` scenario: clear a D32 image and draw into it; then a second rendering with the same depth view in
    `DEPTH_STENCIL_READ_ONLY_OPTIMAL`, depth test on and write off, and a fragment shader sampling the depth view
    through a descriptor. Assert `stats.errors === 0` and the expected pixels.
  - dEQP-VK: the read-only depth/stencil input-attachment cases (`renderpass*.formats.*.input.*` with
    `DEPTH_STENCIL_READ_ONLY_OPTIMAL` layouts) should fail before the fix with a usage-scope validation warning.

### 3. The first submit after the push buffer grows binds groups of the destroyed buffer
- **Where:**
  - `vk/driver/wg_cmd.c:1409-1426` (`push_reserve` releases `dev->push_buffer` but does not bump `push_gen`);
  - `wg_cmd.c:1391-1402` (`push_gen` is bumped only when `push_buffer()` re-creates the buffer);
  - `wg_cmd.c:1463-1471` (cached groups are matched by `push_gen`);
  - `wg_cmd.c:2106` (`push_reserve` runs before the replay).
- **The defect:** `push_reserve` destroys the old push buffer and frees its id. `push_gen` keeps the old value until
  the first `apply()` calls `push_buffer()`. The submit's first `OP_BIND`s of group 3 run before that `apply()`, so they
  match the old generation and reuse bind groups whose buffer was just destroyed: either `p->push_group`
  (`p->push_group_gen == push_gen`) or a holder's group hashed with the old `push_gen`. Those groups stay in
  `r->groups[*][3]` and are re-set on every later draw until another `OP_BIND`. In the worker, `gpu_destroy` ran
  `buffer.destroy()` (immediately, or in order through `later`), so `queue.submit` fails with a destroyed buffer and the
  whole submit is dropped. The new buffer takes the same id from the LIFO free list, which hides the problem when
  reading ids.
- **When it triggers:** a submit with more than 4,096 draws/dispatches (more than 1 MiB / 256 B), after earlier submits
  cached group-3 bind groups for a program whose push constants go past the immediates. That is every program with push
  constants where `setImmediates` is missing, and any program with more than 128 bytes. It happens once at each
  doubling, up to 256 MiB. A large frame is lost, and if that submit renders persistent content (a texture or an atlas),
  the content stays wrong.
- **Fix direction:** bump `push_gen` (or clear `p->push_group`) in `push_reserve` when the buffer is released.
- **A test that would confirm it:** `wg_test.c` `wgt_misc` scenario.
  1. Submit 1: a pipeline with push constants larger than `wg_max_immediates` (in the test's browser, the 128-byte
     compute case already exists) and 1 dispatch.
  2. Submit 2: 5,000 dispatches with the same pipeline and set, each writing `push.x` into a host-visible SSBO slot.
  3. Assert the fence of submit 2 signals, the SSBO holds all 5,000 values, and `stats.errors === 0`.

  Planting the bug back (removing the bump) must make it fail.

### 4. Use after free: a linear image whose memory is freed stays on `linear_images`
- **Where:**
  - `vk/driver/wg_device.c:585-600` (`wg_FreeMemory` leaves images bound to it on `dev->linear_images`);
  - `wg_device.c:940-945` (where an image goes on the list);
  - `vk/driver/wg_cmd.c:2098-2101`, `2057-2079` (every submit calls `wg_memory_buffer(image->mem)`, then copies from
    `image->mem->gpu` and reads back into `image->mem`).
- **The defect:** Vulkan allows `vkFreeMemory` before `vkDestroyImage`; the image then may only be destroyed. Until it
  is, every submit on the device dereferences the freed `wg_device_memory`.
  - `wg_memory_buffer` may write a new id into the freed struct.
  - The readback registered on it lands at `wg_complete` through `b->mem->data`. `wg_submits_forget` ran before this
    readback existed, so it does not catch it.
  - The result is heap corruption in the renderer module.
- **When it triggers:** a `TILING_LINEAR` image bound to host-visible memory (dEQP readbacks, Mesa WSI's CPU path,
  CPU-written textures), with the memory freed before the image is destroyed and a submit in between. Deferred-deletion
  queues do this. This may relate to the backlog's unexplained `memory.binding` crashes and vkr's "vkFreeMemory resulted
  in CS error".
- **Fix direction:** in `wg_FreeMemory`, unlink the images on `linear_images` whose `mem` is this memory, or keep a
  back-list on the memory.
- **A test that would confirm it:** a native or Node `wg_test.c` scenario (no device needed). Create a linear
  host-visible image and bind it; free the memory; allocate a new memory of the same size, which is likely the same
  heap block; submit an empty command buffer; then destroy the image. Under ASan/a debug allocator, or by checking that
  the new memory's `gpu` id is not overwritten, it must fail before the fix.

### 5. Host-visible storage buffers bound with a dynamic offset: the GPU's writes are never read back
- **Where:** `vk/driver/wg_cmd.c:1548-1557` (`bind_group`'s readback loop). It uses `d->buffer->offset + d->offset` and
  the descriptor's range, but not the group's dynamic offsets (`b->offsets`).
- **The defect:** for `STORAGE_BUFFER_DYNAMIC`, the GPU writes at `offset + dynamicOffset`, so the readback covers the
  wrong range. The CPU's copy of the written range is never updated, so the guest maps stale bytes. A later upload of
  those pages can then overwrite the GPU's results with the stale CPU bytes, because no in-flight range shields them.
- **When it triggers:** a compute or fragment shader writing a host-visible SSBO bound as `STORAGE_BUFFER_DYNAMIC`
  with a nonzero dynamic offset; per-object result slots in one buffer are the typical case.
- **A test that would confirm it:** `wg_test.c` `wgt_misc` scenario. A compute shader writes 4 words to a
  `STORAGE_BUFFER_DYNAMIC` binding in host-visible memory, dispatched with dynamic offset 256. After the fence, assert
  the 4 words at byte 256 of the mapped memory.

### 6. A pipeline without a fragment shader, in a pass with colour attachments, makes the submit invalid
- **Where:** `vk/driver/wg_cmd.c:698` (`k.fs = NULL` when there is no fragment shader);
  `vk/driver/wg_shader.c:936-959` (no `fragment` state at all).
- **The defect:** a WebGPU render pipeline without a fragment stage has an empty colour-target list. Its attachment
  state then doesn't match a pass with colour attachments, which is a validation error that invalidates the submit.
  Vulkan allows such a pipeline in any pass; colour attachments are simply not written.
- **When it triggers:** a depth pre-pass, or a stencil-only mask draw, recorded in the same rendering as the colour
  draws. This is common with dynamic rendering.
- **Fix direction:** give such pipelines a trivial fragment module, with targets matching the pass and `writeMask: 0`.
- **A test that would confirm it:** `wg_test.c` `wgt_pass` scenario. One rendering with colour and depth attachments,
  draw 1 with a vertex-only pipeline writing depth, draw 2 with a normal pipeline tested against it. Assert
  `stats.errors === 0` and that draw 2 is occluded where expected.

### 7. A compute program's variant is made from a freed (possibly reused) shader-module id
- **Where:**
  - `vk/driver/wg_shader.c:409-421` (`program_objects` stores the first stage's module as `compute_module`);
  - `wg_shader.c:631-635`, `703-707` (later shaders with the same link share the program);
  - `wg_shader.c:502-506` (`shader_destroy` releases its own module);
  - `wg_shader.c:257-262` (`wg_program_variant` builds a compute pipeline from `p->compute_module`).
- **The defect:** `p->compute_module` belongs to whichever shader created the program, while the program lives as long
  as any sharer. Suppose that shader is destroyed and a remaining sharer then needs a variant: a texture declared
  filterable, bound to a depth or `r32float` view, as in Hi-Z or SSAO compute that reads depth. The variant's
  `createComputePipeline*` then names a released id.
  - If the id is unused, `objs[id]` is `undefined`: the import throws, it is warned, the pipeline is never made, and
    the dispatch's `setPipeline(undefined)` is dropped. The submit is invalid.
  - With the LIFO free list, the id is often reused by the next object. If that object is another shader module, the
    wrong compute shader runs silently.
- **When it triggers:** two compute pipelines with the same SPIR-V and layout, e.g. created again, or loaded from the
  shader cache through `wg_deserialize` while an older one still holds the program. The first is destroyed, and the
  second is then used with a depth view in a filterable-declared slot.
- **Fix direction:** keep a reference to the module in the program; it must not be released while the program lives.
- **A test that would confirm it:** `wg_test.c` `wgt_misc` scenario.
  1. Create compute pipeline A and identical pipeline B (no cache).
  2. Destroy A. Create an unrelated shader module, which takes A's id.
  3. Dispatch B with a depth view bound where the shader samples a float texture, writing the sampled value to host
     memory.
  4. Assert the value and `stats.errors === 0`.

### 8. Semaphore waits are never honoured (wait-before-signal runs at once)
- **Where:** `vk/driver/wg_cmd.c:2359-2372` (`wg_sync_wait_many` counts every wait as met under
  `VK_SYNC_WAIT_PENDING`, submitted or not); `wg_cmd.c:2081-2129` (`wg_queue_submit` ignores `submit->waits`).
- **The defect:** the sync type advertises timelines without `WAIT_BEFORE_SIGNAL`, so Mesa runs the queue in
  assisted/threaded-on-demand mode. That mode asks whether each wait is pending, in order to defer the submit (on its
  thread) until it is. Answering "pending" for a timeline value that nothing has signalled, and nothing has submitted to
  signal, makes the runtime pass the submit straight to the driver. The driver replays it immediately.
- **When it triggers:** a `vkQueueSubmit` waiting on a timeline value that the host signals later
  (`vkSignalSemaphore`), or a value a later submit signals. Producer and consumer threads in frameworks do this. Single
  queue plus in-order binary semaphores are unaffected.
- **A test that would confirm it:** dEQP-VK `synchronization.timeline_semaphore.wait_before_signal.*` and
  `synchronization2.timeline_semaphore.wait_before_signal.*`. Also a `wg_test.c` scenario: submit a copy waiting on
  timeline value 1, then CPU-write the source and `vkSignalSemaphore(1)`; assert the copy saw the new bytes.

### 9. Depth and stencil resolves of dynamic rendering are silently dropped
- **Where:** `vk/driver/wg_cmd.c:506-538` (the depth/stencil attachment's `resolveImageView`/`resolveMode` are never
  read; only colour resolves at `494-497` are handled); `vk/driver/wg_caps.c:283` advertises
  `supportedDepthResolveModes = SAMPLE_ZERO` (with `KHR_depth_stencil_resolve`).
- **The defect:** the resolve target keeps stale contents and nothing warns. `vkCmdResolveImage` warns when it can't
  resolve; the render-pass path doesn't.
- **When it triggers:** MSAA depth resolved for later sampling, e.g. SSAO or post effects behind MSAA.
- **A test that would confirm it:** dEQP-VK `renderpass2.depth_stencil_resolve.*` and
  `dynamic_rendering.*depth_stencil_resolve*`, which are absent from `tests/deqp/vk.txt`. Expect failures that the fix
  turns into passes, or else take the extension and the modes off the advertised list.

### 10. Queries report "available" whatever their state, and result copies overwrite the gaps between them
- **Where:** `vk/driver/wg_device.c:1169-1190` (`wg_GetQueryPoolResults`: availability is always 1, `VK_SUCCESS`
  always, `dataSize` ignored); `vk/driver/wg_cmd.c:1622-1638`, `1848-1863` (`OP_COPY_QUERY`).
- **The defect:**
  - A query that was reset but never ended, or not yet submitted, reads back as available with value 0. Without
    `WAIT_BIT`, the spec requires `VK_NOT_READY`, availability 0, and no value written for unavailable queries unless
    `PARTIAL_BIT` is set.
  - `vkCmdCopyQueryPoolResults` builds `(count-1)*stride+each` bytes from a zeroed buffer and writes them whole, both
    through `gpu_update` and the CPU write. When `stride` is larger than one result, this zeroes the destination bytes
    between results; it also writes values for unavailable queries.
- **When it triggers:** apps that poll availability, e.g. occlusion-culling engines that take "available 0" as "keep
  previous visibility", or that interleave results with other data. Venus's own feedback is unaffected, since its
  copies use a packed stride.
- **A test that would confirm it:** dEQP-VK `query_pool.occlusion_query.*`, `query_pool.timestamp_query.*` (the
  availability cases), and `query_pool.*copy_results*_stride*`. Also a `wg_test.c` check: reset, never end, then
  `vkGetQueryPoolResults(WITH_AVAILABILITY)` must return `VK_NOT_READY` and availability 0.

### 11. Depth bias left enabled for line or point topologies gives an invalid pipeline
- **Where:** `vk/driver/wg_cmd.c:721-726`; `vk/driver/wg_shader.c:929-931`.
- **The defect:** WebGPU's pipeline validation requires depth bias to be disabled (`depthBias`, `depthBiasSlopeScale`
  and `depthBiasClamp` all 0) for line and point topologies. Vulkan applies bias only to polygons, so an enabled bias on
  a line draw is valid and harmless there. Here it is baked into the key regardless of topology, so the pipeline is
  invalid and its draw invalidates the submit.
- **When it triggers:** with extended dynamic state 2, `depthBiasEnable` left on (e.g. after shadow draws) and then
  debug lines or points drawn.
- **Caveat:** check the exact WebGPU rule against the spec and Dawn before fixing.
- **A test that would confirm it:** `wg_test.c` scenario drawing `LINE_LIST` with `vkCmdSetDepthBiasEnable(VK_TRUE)`;
  assert `stats.errors === 0`.

### 12. Smaller spec gaps (each silent)
- **Inverted depth range:** `wg_cmd.c:1571-1572` swaps `minDepth > maxDepth` into min/max, so a viewport with
  `minDepth=1, maxDepth=0` (allowed, used for reverse-Z) loses its inversion. Depth tests then pass and fail the wrong
  way. Confirm with dEQP-VK `draw.*inverted_depth_ranges*`, or a `wg_test.c` draw at z=0.25 with that viewport against a
  `LESS` test.
- **`CONSTANT_ALPHA` / `ONE_MINUS_CONSTANT_ALPHA`:** `wg_shader.c:805-808` maps them to WebGPU's `constant`, which is
  per channel. As a colour factor, Vulkan uses `constant.aaa`, but this gives `constant.rgb`. Confirm with dEQP-VK
  `pipeline.*.blend.*constant_alpha*`.
- **`vkCmdDispatchBase`:** `wg_cmd.c:915-923` drops `bx, by, bz` (core 1.1), so `gl_WorkGroupID` is off by the base.
  Confirm with dEQP-VK `compute.*.device_group.dispatch_base` or a `wg_test.c` dispatch base (2,0,0) writing
  `WorkGroupID.x`.
- **Uniform bindings widened to the shader's block size:** `wg_cmd.c:1505-1507` takes `res->size` but ignores the
  dynamic offset. Near the end of a memory, `offset + dynamicOffset + size` can then exceed the buffer, and
  `setBindGroup` is invalid.
- **Storage bindings not a multiple of 4:** `wg_cmd.c:1504` lets a `WHOLE_SIZE` storage binding of an odd-sized buffer
  through, and WebGPU requires a multiple of 4. The bind group is invalid, and so is the submit.
- **Fans:** indirect fans (`wg_cmd.c:868-880`) draw as triangle lists without the fan-index conversion. Fans of more
  than 65,536 vertices return without a warning (`845-846`).

---

## Checked and found fine
- **Replay state across passes:** `RD_ALL` on every new render or compute pass, after `OP_CLEAR_RECTS`, after
  `OP_EXEC` and between command buffers. Pipeline, bind groups, immediates, vertex and index buffers, viewport, scissor,
  blend constant and stencil reference are all re-set. `forget()` at begin and end of rendering, after
  `ClearAttachments` and after `ExecuteCommands` makes the next draw re-record its state.
- **Push constants:** shared between bind points as Vulkan's are. The push buffer places are fresh for each
  draw/dispatch, the group-3 offset is patched in `apply()`, and the buffer is written with `queue.writeBuffer` before
  the submit and after earlier submits. Its size is reserved from `draws` (secondaries counted at `ExecuteCommands`).
- **Dynamic offsets:** ordered by set, then binding, then element (sorted bindings in `layout_create`), and mapped per
  resource in `record_sets`.
- **Bind-group cache:**
  - kept on the holder set by (bgl uid, version, or a hash of uids and versions for group 3), so freed or reused ids
    don't alias;
  - an evicted group is released after `gpu_submit`;
  - empty groups are transient;
  - partial writes, copies and template writes bump `version`;
  - immutable samplers are pre-filled and kept when a write carries a null sampler;
  - consecutive-binding overflow is handled in `slot()`;
  - push descriptor sets are per command buffer, copied from the previous push, and freed at reset or destroy.
- **Programs:**
  - link hashing field by field;
  - sharing by link with refcounts;
  - variants and merges are freed with their base;
  - `bgl_uid`s are never reused;
  - render pipelines are made at record time and found by key at replay;
  - the pipeline key is zeroed whole before hashing.
- **Render passes:** load ops (CLEAR/DONT_CARE become a clear; LOAD/NONE load; a partial area loads and clears with a
  draw; a resumed pass loads), store ops (a suspending pass stores), 3D attachment slices, colour resolves, clear value
  encoding (uint/sint/float, NaN and inf sanitized in `parseJson`), and partial-area clears through `clearRects`. The
  pipeline's colour, depth and sample attachment state matches the pass (except #6).
- **Transfers:**
  - unaligned buffer copies use the worker's compute copy, in encoder order;
  - buffer↔image rows are split when they aren't 256-aligned, and layered copies stride `bpr*rows`;
  - depth and stencil copies are realigned or skipped with a warning;
  - fills and updates of host-visible memory are mirrored to the CPU at completion;
  - `UpdateBuffer`/`CopyQueryPoolResults` padding is harmless (sizes and offsets are 4-aligned by Vulkan's rules);
  - blits within one texture across mips are allowed (different subresources).
- **Host-visible coherence:** the snapshot is taken before the write-watch look, and uploads leave out in-flight GPU
  words. Completions land only the bytes the guest hasn't changed and carry the bases of later ranges. Readbacks are
  copied after all commands, and `wg_submits_forget` runs on free (for buffers).
- **Completion:** submits are numbered across devices; the worker's promise chain completes them in order, and the
  readback staging buffers are destroyed after the copy.
- **Held submits (`web/venus-gpu.ts`):**
  - ids are resolved and memory copied at the call;
  - `gpu_write`, `gpu_destroy` (`buffer`/`texture.destroy`), import writes and later submits queue behind held
    batches in order;
  - temporary buffers are destroyed with their own encoder;
  - an unready pipeline outside a recording falls back to a synchronous make;
  - a rejected async pipeline falls back to a synchronous make that reports the error.
- **Ids:** `wg_id_release` destroys and recycles at once. That is safe for already-submitted WebGPU work, which
  WebGPU keeps alive, and for held work, which captured objects. The exceptions are #3 and #7, where the driver itself
  keeps a stale id.
- **Events:** `vkCmdSetEvent` takes effect at replay (submit), not at GPU completion, and `vkCmdWaitEvents` is a no-op.
  This is acceptable under Venus, whose guest reads event, fence and query state from feedback slots that land at
  `wg_complete`. It is not right for a host reading `vkGetEventStatus` directly, but that path isn't Venus's.
- **Secondary command buffers:** they inherit attachment formats and samples from
  `VkCommandBufferInheritanceRenderingInfo`, replay inline, and re-record all their state from their first draw.
