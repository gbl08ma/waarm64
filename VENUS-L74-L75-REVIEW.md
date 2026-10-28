# Venus VK3 L7.4–L7.5: static review

**Range:** `71e850cc..221d16c8` minus `7a32ec84` (the kickoff edit): 2f128120 (uniform buffers past WebGPU's), 595995c5
(provoking vertex, indexed fans), 9f3fd87e (transform feedback, attachment-less passes), b21e44d9 (draw parameters),
plus the docs/report commits. Everything was read at 221d16c8 (`git show`). bench JSON and the dEQP lists were skipped.

**Scope:** `vk/driver/wg_cmd.c`, `wg_shader.c`, `wg_caps.c`, `wg_descriptor.c`, `wg_private.h`, `wg_gpu.h`;
`vk/compiler/wgsl_nir.c`, `wgsl_print.c`, `wgsl.h`; `web/venus-gpu.ts` (`provoke`, `runXfb`, `xfbDraw`,
`xfbPipeline`, `vertexDecode`, `scratch`); the new tests. I checked Mesa's `nir_io_xfb` and `nir_opt_varyings` in
`target/vk/mesa` against the printer's use of them.

**Bottom line:** I found 9 defects. One breaks geometry outright: a 16-bit index range is rounded *down* to a word,
so an indexed fan, or a last-vertex flat draw, loses its last index whenever the index buffer ends on a half-word.
Two are holes in transform feedback: indirect draws are never captured, and the capture's compute dispatch can go
past WebGPU's limits, which drops the whole submit. Two more are an id use-after-release and new limit overruns
driven by draw parameters. The rest are low. I could not tie the reported 205-for-156 symptom to any defect here:
`fold_uniforms` and `lower_ubo_storage` are consistent for ANGLE's layout as I understand it (§ "The symptom").

---

## 1. High: a provoked draw's 16-bit index range is rounded down, so its last index is lost

- **Where:** `web/venus-gpu.ts`, `provoke()`, the source binding:
  `const end = Math.min(src.size, offset + Math.max(size, (first + count) * el)) & ~3;` then
  `source = { …, size: Math.max(4, end - from) }`.
- **Defect:** with 16-bit indices, `offset + size` can end at 2 mod 4. Rounding it down drops the last index's
  half-word from the binding. In that case `size` is `cmd->ib_size`, which is `vk_buffer_range(ib, offset,
  VK_WHOLE_SIZE)` (wg_cmd.c:429), i.e. the VkBuffer's own end. `s[k >> 1]` for that index then reads past the binding.
  WebGPU's robust access clamps or zeroes the read, so the index comes back as 0 or another in-range index, and the
  last primitive comes out degenerate or wrong.
- **When:** any OP_PROVOKE draw with `VK_INDEX_TYPE_UINT16` whose bound range holds an odd number of indices and is
  used up to its end. Two kinds of draw qualify. Indexed fans go through this path *always* (`WG_PROVOKE_FAN_FIRST`,
  whatever the fragment shader reads), e.g. a 5-index fan in a 10-byte buffer. So do last-vertex draws whose
  fragment shader reads a flat input, e.g. one triangle's 3 indices in a 6-byte buffer. It doesn't trigger when the
  VkBuffer is a suballocation in a larger buffer (ANGLE), so the ES3 page doesn't see it.
- **Fix direction:** round `end` *up* to 4, then clamp to `src.size` (the way `xfbDraw`'s `bind()` already does).
- **Test:** a `passes:` case with an indexed fan of 5 uint16 indices in a dedicated 10-byte VkBuffer (default
  provoking vertex). The third triangle should be drawn; today its pixel stays the clear colour. Do the same with a
  3-index uint16 triangle list in a 6-byte buffer under `flatLast`.

## 2. Medium: indirect draws are never captured by transform feedback

- **Where:** `vk/driver/wg_cmd.c`, `draw_indirect()` (around lines 1355–1385). Only `wg_CmdDraw` (line 1376) and
  `wg_CmdDrawIndexed` (line 1397) call `xfb_draw`.
- **Defect:** in Vulkan, every draw made while transform feedback is active is captured, `vkCmdDrawIndirect` and
  `vkCmdDrawIndexedIndirect` included. Only `vkCmdDrawIndirectByteCountEXT` (`transformFeedbackDraw`) is optional.
  Here an indirect draw inside a capture writes nothing, the counters don't advance, and nothing warns. The
  rasterizer-discard case is worse: `record_draw` returns false (no `xfb_record`), so the draw vanishes completely.
- **When:** any indirect draw between `vkCmdBegin/EndTransformFeedbackEXT`: vkd3d stream output with ExecuteIndirect,
  GL `glDrawArraysIndirect` under ANGLE with transform feedback. dEQP's skipped "indirect" cases are the byte-count
  draws, so this has no coverage.
- **Fix direction:** capture it the way prepasses already reads indirect arguments: copy the args into the job, or
  read them in `wgx_p` from the indirect buffer. At the very least, warn.
- **Test:** begin capture, `vkCmdDrawIndirect` of 3 vertices into a 96-byte buffer with stride 32, end with a counter.
  The want is 3 records and a counter of 96; today the buffer is unchanged and the counter reads 0.

## 3. Medium: the capture's compute dispatch can exceed WebGPU's limits, and that invalidates the whole submit

- **Where:** `web/venus-gpu.ts`, `xfbPipeline()` (the layout's entries) and `xfbDraw()` (`bind()`, `createBindGroup`).
- **Defect:** the compute stage sees all of these as storage buffers:
  - the vertex stage's own storage buffers (its folded UBOs included, since `program_create` gives them COMPUTE
    visibility);
  - one `wgx_s`, one `wgx_ix` (always bound, even for non-indexed draws);
  - one per captured buffer;
  - **one per vertex-buffer slot** (up to 8).

  Nothing checks the total against `maxStorageBuffersPerShaderStage`. Example: a VS with 6 separate attribute buffers
  and 1 captured buffer needs 9, and adding ANGLE's 2 folded uniform blocks makes 11. Each vertex buffer is also bound
  over its whole Vulkan range (`v.size`: `VK_WHOLE_SIZE` resolves to the buffer's size), unchecked against
  `maxStorageBufferBindingSize`.

  The `try/catch` around the pipeline creation doesn't help: WebGPU reports these validation errors asynchronously.
  `createBindGroupLayout`, `createPipelineLayout`, `createComputePipeline` and `createBindGroup` return invalid
  objects, the dispatch invalidates the encoder, and the submit's whole command buffer is lost, rendering included.
  That contradicts the design's "graceful" warn-and-skip.
- **When:** transform feedback with many vertex buffers (GL apps often keep one VBO per attribute) on an adapter with
  8–10 storage buffers per stage (SwiftShader, the Mac). Also any captured draw whose vertex buffer range is larger than
  `maxStorageBufferBindingSize`.
- **Fix direction:** count the storage buffers the layout will need and refuse up front with the warning. Bind only
  the bytes the draw can reach (`(first + count) * stride`, or the instance range). Drop `wgx_ix` for non-indexed draws.
- **Test:** an xfb vertex shader with 8 vertex input bindings (one attribute each) on SwiftShader. The want is the
  capture's records and `errors == []`; today WebGPU reports an error and the frame's submit is lost. A second case:
  a vertex buffer bound `VK_WHOLE_SIZE` of a 200 MiB VkBuffer under the 128 MiB default.

## 4. Medium-low: the dummy attachments' eviction releases ids that recorded command buffers still use

- **Where:** `vk/driver/wg_cmd.c`, `dummy_attachment()` (around lines 489–508):
  `const uint32_t i = free ? free - 1 : 15; wg_id_release(dev->dummies[i].view); wg_id_release(dev->dummies[i].texture);`
- **Defect:** the view id is written into the OP_PASS JSON at *record* time. When all 16 slots are taken, slot 15
  is released and remade at once, while any command buffer recorded earlier (or earlier in this same command buffer)
  still names the old id. Ids are reused, so that pass's replay either names a dead object (an invalid pass and a lost
  submit) or **another object** (the "stale id" class from VK3 L6b). Even without eviction, `wg_DestroyDevice` frees
  them; that path is fine.
- **When:** more than 16 distinct render-area sizes of attachment-less passes in a device's lifetime, with a command
  buffer still referring to the evicted one. Reusable command buffers (`SIMULTANEOUS_USE`, re-submitted ones) make
  this likely; a single command buffer with 17 sizes triggers it in one submit.
- **Fix direction:** release evicted dummies only after the submits that might name them complete (the
  `released_groups` pattern), or key the dummy per command buffer.
- **Test:** one command buffer with 17 attachment-less passes of different render areas, each with a transform
  feedback draw. The want is all 17 captures and no WebGPU errors.

## 5. Medium-low: draw parameters put the push buffer into layouts it can't fit

- **Where:** `vk/compiler/wgsl_print.c:2303` (`|| c.uses_draw_params` forces the push buffer);
  `vk/driver/wg_caps.c` (`maxDescriptorSetUniformBuffersDynamic = L->max_dynamic_uniform_buffers`); `wg_shader.c`
  `program_create` (the push binding is `WG_DYNAMIC_PUSH`, i.e. `hasDynamicOffset: true`).
- **Defect:** before L7.5 the push buffer (a *dynamic* uniform binding in group 3) appeared only when push constants
  exceeded the immediates. Now every vertex stage that reads `BaseVertex`/`BaseInstance`/`DrawIndex` gets it, even
  with no push constants at all. Two things follow:
  - **Dynamic offsets.** The device still advertises all of WebGPU's `maxDynamicUniformBuffersPerPipelineLayout` (8)
    to the app. A layout with 8 `UNIFORM_BUFFER_DYNAMIC` plus a draw-parameters vertex shader therefore needs 9 →
    `createPipelineLayout` fails (an invalid pipeline, the submit lost). The same was latent for push > immediates;
    L7.5 makes it hit whenever such a shader is used. vkd3d binds root CBVs as dynamic uniform buffers, so it is the
    likely victim.
  - **Groups.** The program always has 4 groups (group 3 for the push binding), so `xfbDraw` refuses it ("four bind
    groups"). Draw parameters and transform feedback never work together. This is documented as a limitation but not
    advertised (`transformFeedback` and `shaderDrawParameters` are both on).
- **Test:** a pipeline layout with 8 dynamic uniform buffers and `draw-params.vert` drawn once. The want is the draw
  with `errors == []`; today `createPipelineLayout` errors. A second case: `xfb.vert` plus `gl_BaseVertex`.

## 6. Low: 8 color attachments that are all null overflow `pass.colors`

- **Where:** `vk/driver/wg_cmd.c`, `wg_CmdBeginRendering`'s dummy block (around lines 580–588):
  `cmd->pass.colors[cmd->pass.color_count] = VK_FORMAT_R8_UNORM; cmd->pass.dummy = cmd->pass.color_count++;`
- **Defect:** `color_count` is `MIN2(colorAttachmentCount, 8)`. With 8 entries whose `imageView` are all
  `VK_NULL_HANDLE` (valid Vulkan), `colors[8]` is written past the `VkFormat colors[8]` array into `pass.depth`. That
  pipeline then gets depth format R8, the JSON gets a 9th color attachment (WebGPU's maximum is 8), and the pass is
  invalid.
- **Test:** `vkCmdBeginRendering` with 8 null color attachments and a rasterizer-discard capture draw. The want is no
  WebGPU error.

## 7. Low: a strip or fan with restart is walked by one invocation

- **Where:** `web/venus-gpu.ts`, the `provoke` shader (`if (p.restart != 0u) { if (id.x != 0u) { return; } … for (var i
  = 0u; i < p.count …`).
- **Defect:** for an indexed strip or fan with `primitiveRestartEnable` and a last-vertex flat input (or any indexed
  fan with restart), every index is walked serially by one GPU thread. Millions of indices (terrain or particle strips)
  make one dispatch long enough to hit the browser's GPU watchdog, which loses the device. A
  scan/compaction would avoid it.
- **Test:** a 4M-index uint32 restart strip with a flat last vertex. Time the submit, and watch for device loss.

## 8. Low: a folded uniform buffer is bound at the uniform alignment, not the storage one

- **Where:** `vk/driver/wg_cmd.c:2252–2264` (`bind_group`, the buffer case) together with `wg_caps.c:299–300`.
- **Defect:** the app aligns a uniform-buffer descriptor's offset to `minUniformBufferOffsetAlignment`. Once it is
  folded to `read-only-storage`, WebGPU validates the offset against `minStorageBufferOffsetAlignment` instead. On an
  adapter whose storage alignment is the larger of the two, the bind group is invalid and the submit is lost. Rare:
  most adapters report storage ≤ uniform. The fix is to report `minUniformBufferOffsetAlignment` as the max of both.
- **Test:** none cheap. A unit check could assert `minUniformBufferOffsetAlignment >= minStorageBufferOffsetAlignment`.

## 9. Low: the new tests miss the configurations the features were built for

- `misc: manyUniforms` (`tests/venus/many-ubo.comp`) folds **one arrayed binding in the compute stage**. None of this
  is exercised:
  - two stages with stage-specific flags (ANGLE's layout: 12 VS-only blocks and 12 FS-only blocks, each its own
    binding, plus a per-stage dynamic default block);
  - room taken by dynamic uniform buffers or texel-buffer parameters;
  - a binding that both stages see.

  So the passing test says nothing about the reported ANGLE failure.
- `flat*` and `xfb*` use 32-bit indices or non-indexed draws only (no 16-bit odd-length index buffer: finding 1), no
  indirect draws (finding 2) and at most two vertex buffers (finding 3).
- `drawParams` checks DrawIndex only as 0, which is right while multi-draw is off.

---

## The symptom (24 blocks summed: 205 for 156 with `--enable-features=Vulkan`)

I found no defect in these commits that explains it. Here is what I checked so it isn't re-checked:

- **Folding is consistent.** `fold_uniforms` (wg_shader.c:533) and `lower_ubo_storage` (wgsl_nir.c:805) agree on the
  slot (`base + first + e`; `(index & 0xffff) / 2`) and the group.
- **Folding covers both stages.** The folded bits are OR'd across stages, so every stage that sees a binding reads it
  the same way. With VS-only and FS-only bindings each stage folds its last 1–2 blocks, which is valid and correct.
- **The folded storage binding is right.** It binds the descriptor's offset and range (bind_group, wg_cmd.c:2252–2264),
  is non-dynamic, and isn't read back.
- **The stage-flag hash is in the set layout's hash.** `WG_SHADER_FORMAT` was bumped, and the worker's cache keys
  include the device's caps.
- **`nir_opt_varyings` doesn't move the UBO sum across stages.** It isn't propagated as a uniform expression: after
  lowering, the loads are `load_ubo`, which `is_uniform_expression` rejects.
- **`nir_io_xfb` has `out[4]`** in this Mesa, so the printer's `x.out[k]`, `k < 4` is in bounds.

The only stated difference in the failing case is that a second Vulkan client (Chromium's own device) shares the
renderer. The places to look are therefore driver state shared across devices (`programs`, `bgl_uid`'s `uids`,
`wg_limits`, `p->push_group` with its per-device `push_gen`), or a different descriptor layout that ANGLE picks in
that mode. A driver test with ANGLE's exact layout (finding 9) would settle whether folding is involved.
