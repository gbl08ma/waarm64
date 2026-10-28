# Venus (VK3) static review: driver, translator, worker

Range reviewed: `3f8aa595..origin/main` (origin/main = dedd54e6), paths `vk/` (driver `wg_*.c`, compiler, wasi
disk cache, patches) and `web/venus-gpu.ts`. Static reading only; nothing built or run. Files were read from
`git show origin/main:<path>`. Line numbers are origin/main's.

Areas read closely: wg_cmd.c (render passes, the dummy attachment, face splits, provoking vertex, transform feedback,
draw parameters and the push buffer, occlusion queries and spares, held submits, upload/readback bases), wg_device.c
(YCbCr planes, texel buffer views, query pools, semaphores), wg_caps.c (limits, `wg_bindings_fit`), wg_shader.c
(variants, splits, merges, program links, (de)serialization, `fold_uniforms`), wg_descriptor.c, wgsl_nir.c (dynamic
indexing, subgroups, 16-bit, UBO-as-storage), the texel-buffer and 16-bit parts of wgsl_print.c, and in the worker
copies, `provoke`, `runXfb`/`xfbDraw`/`xfbPipeline`, `resolveDepth`, the depth/stencil copy paths, blits, clear rects,
`queryAdd`, submit/held ordering.

Ranked by severity. Fewer findings, each checked against the code it depends on.

---

## 1. HIGH: a buffer copy whose source and destination are the same VkDeviceMemory invalidates the submit

- `vk/driver/wg_cmd.c:2722-2727` (replay `OP_COPY_BB`): every `vkCmdCopyBuffer` region now goes to `gpu_copy_bb`,
  "on the GPU whatever the alignment".
- `web/venus-gpu.ts:424-430` (`gpu_copy_bb`): a 4-aligned copy is `enc.copyBufferToBuffer(a, so, b, dO, size)`, with
  `a = buf(src)` and `b = buf(dst)`.
- Each VkDeviceMemory is one GPUBuffer (`wg_memory_buffer`), and `buffer_gpu()` returns the memory's buffer. So any
  copy between two VkBuffers bound to the same VkDeviceMemory, or between two ranges of one VkBuffer, is a
  `copyBufferToBuffer` with source == destination.
- **Trigger:** `vkCmdCopyBuffer(cmd, A, B, …)` where A and B are suballocations of one VkDeviceMemory. This is how VMA,
  ANGLE, DXVK and vkd3d allocate, and the driver advertises only two memory types, so it is very common. Copying within
  one buffer to a region that doesn't overlap does the same. Vulkan allows both.
- **What goes wrong:** WebGPU (Dawn: "Source and destination are the same buffer") rejects the copy with a validation
  error. That invalidates the whole command buffer, so the submit's work is lost, not just the copy.
- **Not affected:** the unaligned path (`copyUnaligned`) goes through a temporary buffer.
- **History:** the aligned path behaved this way before the range too. In the range, L4c-F routed all copies through
  it: unaligned host-visible copies used `gpu_update` before.
- **Fix direction:** when `a === b`, copy through a temporary buffer (as `copyUnaligned` does), or use two copies via
  scratch.
- **Confidence:** high on the WebGPU rule and that this path reaches it; high that real programs hit it.

## 2. MEDIUM-LOW: the provoking-vertex pass binds the index buffer to the end of the VkBuffer, which can go past maxStorageBufferBindingSize

- `vk/driver/wg_cmd.c:671-673` (`provoke`): `o.offset = ib->offset + ib_offset` and `o.size = cmd->ib_size`, the bound
  range. For `vkCmdBindIndexBuffer` that is `VK_WHOLE_SIZE`, i.e. the rest of the VkBuffer (`wg_cmd.c:451`).
- `web/venus-gpu.ts:1706-1709`: the source binding runs from the 256-aligned start of the draw's first index to
  `offset + max(size, (first+count)*el)`. That is the whole remainder of the buffer, whatever the draw's `count`.
- **Trigger:** an indexed draw that takes the provoke path, in an index buffer (or an index+vertex megabuffer) bigger
  than `maxStorageBufferBindingSize` past the draw's start (Dawn's default limit is 128 MiB). The provoke path is taken
  when the provoking vertex is LAST and the fragment shader reads a flat input (ANGLE/GL), or for any indexed fan.
- **What goes wrong:** `createBindGroup` fails, the compute pass is invalid and the submit is lost.
- **Same pattern, milder effect:** in `xfbDraw` (`web/venus-gpu.ts:1467-1468`), the index range taken is
  `max(job.size - first*el, count*el)`. The capture is then skipped with a warning (`bytes > maxStorageBufferBindingSize`,
  line 1479), so a large buffer silently drops the capture.
- **Why it's avoidable:** a non-indexed-indirect draw needs only `(first + count) * el` bytes, rounded up to a word.
  Clamp to that (which also keeps the half-word fix of L7b), and to the device limit.
- **Confidence:** medium. The code path is certain; buffers this large are uncommon.

## 3. LOW: attachment-less render passes always rasterize at 1 sample, though 4 is advertised

- `vk/driver/wg_cmd.c:539-541, 566-574`: a pass with no attachments gets the device's dummy R8 attachment (1 sample),
  and `cmd->pass.samples` stays 1.
- `record_draw` takes `k.samples = cmd->pass.samples`, never the pipeline's `rasterizationSamples`.
- `wg_caps.c` advertises `framebufferNoAttachmentsSampleCounts = 1|4`.
- **Trigger:** an attachment-less pass (new in L7.4; transform-feedback-only passes and some compute-like raster
  tricks) with `rasterizationSamples = 4`.
- **What goes wrong:**
  - Occlusion query counts are per pixel instead of per sample (up to 4× off).
  - `gl_SampleID` and `gl_SampleMaskIn` are wrong, and sample shading runs at 1 sample (`wg_samples` is 1).
  - Sample-mask-dependent fragment side effects (storage writes) differ.
- **Fix direction:** make the dummy at the pipeline's or the dynamic sample count, keyed by samples, or advertise
  `framebufferNoAttachmentsSampleCounts = 1`.
- **Confidence:** medium.

## 4. LOW: descriptor copies overwrite immutable samplers

- `vk/driver/wg_descriptor.c:368-372` (`wg_UpdateDescriptorSets`, copies): `*d = *s` copies the source descriptor
  whole, including `sampler`.
- L7a made writes keep a binding's immutable samplers (`write_one`, the `immutable` check, "the binding review's
  finding 7"). Copies weren't given the same check.
- **Trigger:** a `VkCopyDescriptorSet` into a SAMPLER or COMBINED_IMAGE_SAMPLER binding that has immutable samplers,
  from a binding whose sampler differs. The source can be mutable, or immutable with another sampler. A YCbCr binding
  is the case that matters: its conversion is compiled in with the layout's sampler.
- **What goes wrong:** the bind group then binds the copied sampler instead of the immutable one. Filters, address
  modes, or the YCbCr plane sampler's filtering differ from what the pipeline was compiled against.
- **Fix direction:** keep `d->sampler` when `set->layout->immutable[slot]`.
- **Confidence:** medium on the semantics (Vulkan ignores samplers written or copied into immutable bindings), low on
  frequency.

## 5. LOW: transform feedback across a suspended/resumed render pass drops captures and never writes the counters

- `web/venus-gpu.ts:1373-1432` (`endPass` → `runXfb`): a WebGPU pass's xfb jobs are run, and its session closed, at
  that pass's end.
- A Vulkan render pass instance split by `VK_RENDERING_SUSPENDING_BIT` / `RESUMING_BIT` is several WebGPU passes
  (`wg_cmd.c` `end_rendering`/`OP_PASS_END`).
- **Trigger:** `vkCmdBeginTransformFeedbackEXT` in the suspending part, draws or `vkCmdEndTransformFeedbackEXT` in the
  resuming part.
- **What goes wrong:**
  - The first part's `finish()` copies back without counters.
  - In the resumed part `session` is undefined, so its draws are skipped (`if (session) this.xfbDraw…`).
  - Its `end` job's `finish(counters)` returns early, so the counter buffers are never written.
- **Confidence:** low. I'm not certain Vulkan allows transform feedback to stay active across a suspend; if it does,
  this is a real gap.

---

## Checked and found consistent (not findings)

- **Draw parameters and the push buffer:**
  - The indirect argument offsets (8 / 12) are right.
  - The places copied before the pass are consumed in order (`dp_places`).
  - `cmd->draws` reservation covers every push place used (`maxDrawIndirectCount = 1`).
  - The push buffer is replaced under a new `push_gen`, and the bind group caches check it.
- **Provoking vertex rotations:** the rotations for lists, strips and fans keep the winding and put Vulkan's LAST
  vertex first. The restart walk's prefix of last restarts and its degenerate output also check out.
- **Transform feedback layout:** the `WgxP` uniform layout matches `params` (28 words). The indirect argument copies
  into it are right for both indexed and non-indexed draws. The counter and record offset arithmetic is right.
- **Occlusion queries:**
  - Spare slots, cut queries reported as passing, and resolves through the 256-aligned scratch.
  - `queryAdd` runs after the resolve, and the pool buffer has `STORAGE` usage.
  - Availability goes by serial, and the pool is forgotten on destroy.
- **Held submits:** timeline waits are copied, the ring-fence exception applies, `flush_held` reentrancy is guarded
  by `completing`, and worker-side `later`/`rec` ordering of `queue.writeBuffer` holds against scratch reuse.
- **Upload after replay:** `queue.writeBuffer` still precedes the encoder's commands, and `snapshot` happens before
  `upload`.
- **Texel buffers:**
  - Channel/word arithmetic for 1/2/3/4/6/8/12/16-byte texels.
  - The R11G11B10 decode.
  - Storage only on whole-word formats.
  - The view binding is clamped inside the memory.
- **16-bit lowering:**
  - `view16` sign-extends.
  - `store16` masks.
  - `nir_lower_bit_size` exceptions match the printer's conversions.
- **Variants:** `insert_resource` leaves the twin's `res_set`/`vis` equal to the sampler's (correct by the shift). The
  split twin sits at the even binding of the sampler's slot.
- **Shader cache:** `wgsl_info` has no pointers, so the `blob_copy_bytes` round trip is sound. Caps and the build ID
  are in both the UUIDs and the disk cache identity.
- **Depth-copy and stencil paths in the worker:** binding sizes and alignment, and the realigned temp copies.
- **`resolveDepth`:** aspect handling and write masks.
- **3D blits:** slice mapping, including flipped z.
- **`copyUnaligned`:** goes through a temporary buffer, so same-buffer is fine there.
