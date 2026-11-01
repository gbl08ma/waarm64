# VK4's out-of-context review (2026-11-01)

**The review of R1 to R4 itself** (a fresh agent, static, on the local branch `review/vk4-r1-r4`, 16 findings): fixed C1 (a crop of
a 3D image's slices), C2 narrowed (entries come back only from a full, stalled queue, one at a time; what's left is in the
backlog), D1 (attachments have the copies a crop needs), D2 (each dummy binding its own range), D3, D4 (a fan's room apart from its
range), D5, D6, D7, D8, W1, W3, M1 (its comment) and M2. D1, D2, D3, D8 and W3 with a test seen failing; C1, D4 to D7, W1 and M2's
context half without one of their own. W2 and M3 are in the backlog ("Usage scopes' leftovers").

Five fresh agents, each given only the repo, an area and its entry points, and docs/testing.md's neutral brief ("a
careful static review for real defects: ..."), with no theories and no handover. The area was what VK4 changed after
T1 (`9730e991..174b870`: T2–T12, T18, T19). It was static only: no reviewer built or ran anything. The findings below
are the reviewers' own, lightly edited, each with an id (area letter and number). The kickoff's tasks R1–R5 cite
these ids (VK4-KICKOFF.md "Tier 2b"). A finding moves to docs/backlog.md or a fix's commit as it is handled, and this
file goes when the last one does.

**Fixed in the review's own commits** (each with its test, failing first): H2 (`Mem::ram_pa`), H3 (splits checked
with Vulkan's reserve: definitions and the worker), O4 (`maxPushDescriptors`).
**Fixed by VK4's tier 2b** (its row in VK4-KICKOFF.md): H1 (R1); R1, R4 (R2); R2, R3, R5 to R10, O7, O10 (R3; R9 and R10 without a test of their own, R10 warned rather than
drawn); X1, X3 to X8 (R4; X6 and X7 without a test of their own, X6's clamp to the image's texels left in the backlog). C1 to C7 (R5; C7's `wg_compute_based` left in the backlog, "Samplers' leftovers"; the shader store's bounds without a corrupt store's test, only the check itself). O1 to O3, O8's pad, O11, O12, O14 to O17, H4 (R6; O15 and O17 without a test of their own, and O2's placeholder path, past what a test can drive of vkr, through `wgt_memory` on the driver alone). X2 didn't
reproduce (a drawn resolve into an sRGB view passes without the fix, its test kept); the worker now views both ends in the views' formats.

| Id | Area |
|---|---|
| R | Passes, dispatches and usage scopes (vk/driver/wg_cmd.c) |
| X | Transfers, clears, queries, indirect fans (vk/driver/wg_cmd.c, web/venus-gpu.ts) |
| O | Objects, memory and capabilities (wg_device.c, wg_descriptor.c, wg_format.c, wg_caps.c, vkr-wasm.patch) |
| C | The translator and pipelines (vk/compiler/, wg_shader.c) |
| H | The host side and memory 1's layout (web/, core/src/mem.rs) |

## R: Passes, dispatches and usage scopes (vk/driver/wg_cmd.c)

Static review of `vk/driver/wg_cmd.c` at HEAD (the commits `9730e991..HEAD` touching it), with `wg_private.h`, the parts of
`wg_device.c` it calls (`wg_view_att`, `wg_view_twin`, `image_track`, `image_alias`, `wg_image_words`), and the worker's
side it relies on (`web/venus-gpu.ts`: `gpu_render_pass`, `gpu_copy_tt`, `copyPacked`, `endPass`, `runXfb`). Nothing was
built or run. Line numbers are wg_cmd.c's unless a file is named.

Ranked by severity: dropped work (an invalid WebGPU command loses the whole submit) first, then wrong pixels, then minor.

---

### R1. Dropped work: a written shadow and a read shadow share the one shadow GPUBuffer, which WebGPU's usage scope refuses

**Where:** `shadow_place` 3145-3167 (every shadow of a submit goes into `dev->shadow`, one GPUBuffer); `conflicts`
3091-3098 (the address-buffer branch gives writable descriptors a shadow); `scope_shadows` 3209-3215 (`written` =
`u->writable`); `bind_group` 3350-3358, `apply` 3629-3644 (vertex/index buffers bound from the shadow).

**Defect:** The shadow buffer was designed to be read-only ("Nothing is copied back: shadows are only read", the comment at
2765). T7 added *written* shadows for the pointers' case: when `r->address_use` is set, a writable storage descriptor of
address memory goes to a shadow bound as writable storage and copied back at `scope_end`. Read shadows from the same scope
(a uniform, read-only storage, vertex, index or indirect use that conflicts) go to the same `dev->shadow`. Usage scopes
are per GPUBuffer, not per range: `dev->shadow` is then bound as writable `storage` and as `uniform`/`vertex`/`index`/
`indirect`/read-only storage in one dispatch or render pass, which is exactly the error T3 exists to avoid. The pass or
dispatch is invalid and the submit is lost.

**Trigger:** One scope where the pointers' binding is written (`address_use == 2`) and both
- a `WGSL_STORAGE` descriptor of address memory (gets a written shadow, `conflicts` returns `u->writable`), and
- any conflicting read: a UBO/read-only SSBO/texel buffer of address memory (`address_use == 2` makes every read of the
  address buffer conflict), or a vertex/index/indirect buffer there, or a read of any other memory the scope writes.

Programs that allocate all memory with `VK_MEMORY_ALLOCATE_DEVICE_ADDRESS_BIT` (vkd3d-proton, VMA with BDA on) put every
buffer in the address buffer, so a shader that stores through a pointer and also has an SSBO descriptor plus any UBO or
vertex buffer meets it.

**Fix direction:** put written shadows in a second buffer (or keep read and written shadows in different GPUBuffers).

**Test:** tests/venus-driver.test.ts (Chromium): a compute pipeline whose shader stores through a `buffer_reference`, with a
writable SSBO descriptor and a UBO descriptor, all three buffers in memory allocated with the device-address flag; expect
no WebGPU validation error and the SSBO and pointer writes visible. A cheaper native check in wg_test.c: after
`scope_shadows` for such a use list, assert no written shadow has the same `to` as a read shadow.

---

### R2. Dropped work: attachments of different sizes make an invalid WebGPU pass

**Where:** `begin_rendering` 665-673 (the pass's `width`/`height` are the *first* attachment's), 689 (`partial` against
that one only), 727-809 (every attachment's view put in the pass as is).

**Defect:** Vulkan lets a pass's attachments be larger than the render area and differ from each other in size (a legacy
framebuffer smaller than its attachments, dynamic rendering with views of different extents or levels: only the render
area has to fit all of them). WebGPU requires every attachment of a render pass to have the same size. Nothing here
crops, checks or reports it, so the `beginRenderPass` is invalid and the submit is dropped. `partial` compares the area
with the first attachment only, so a larger second attachment is also cleared/discarded outside the area (moot while the
pass is invalid, but it matters for any fix that renders such a pass).

**Trigger:** a framebuffer of 1920x1080 over a 2048x2048 shared depth buffer; a colour view of mip 0 with a depth view of
another image of a different size; any Mesa render-pass emulation of a framebuffer smaller than its views with
attachments of unequal sizes.

**Test:** tests/venus-driver.test.ts: dynamic rendering with a 64x64 colour view and a 128x128 depth view, render area
64x64, one draw; expect the submit valid (no validation error) and the colour drawn, and the depth outside 64x64 kept.

---

### R3. Dropped work / wrong pixels: a feedback copy of a packed-format attachment (R5G6B5, A1R5G5B5, B4G4R4A4)

**Where:** `feedback_copies` 3503-3509 copies the attachment's texture into the view's twin with `gpu_copy_tt`;
`wg_view_twin` (wg_device.c 1638-1656) makes the twin as `view->fmt->name` (rgba8unorm) *without* the `"packed"` key that
`wg_texture_create` (wg_device.c 1137-1145) gives a packed image's texture; the worker (web/venus-gpu.ts 489-490) sees a
packed source and an unpacked destination and takes `copyPacked(ps, S, …, undefined, D, …)` (2160-2169).

**Defect:** `copyPacked` packs the source into 2-byte texels with `bpr = ceil(w*2/256)*256`, then `copyBufferToTexture`s
that into the rgba8unorm twin with the same `bytesPerRow`. For widths over 64 texels `bpr < 4*w`, which WebGPU refuses
(and the temporary buffer is too small): the submit is lost. At 64 or fewer texels the copy is valid but writes packed
16-bit words into an 8-bit-a-channel texture: the input attachment reads garbage.

**Trigger:** any self-dependency on a packed-format colour attachment that the image's usage allows as an input attachment
(`OP_PASS_ATTS` includes it), with a draw reading it. vk/README.md "Packed 16-bit formats" puts 4 `self_dep` cases of
`r5g6b5` out of the list for rounding; they may be this.

**Fix direction:** give the twin the image's `"packed"` description (or make the twin's copy a plain same-format copy:
both are rgba8unorm underneath).

**Test:** tests/venus-driver.test.ts: a 128x128 R5G6B5 attachment with INPUT_ATTACHMENT usage, a draw writing it, a barrier,
a draw reading it as an input attachment; expect a valid submit and the read colour. dEQP-VK: re-run the four `self_dep`
r5g6b5 cases README names.

---

### R4. Dropped work: two read-only storage buffers promoted to writable can alias each other

**Where:** `program_for` 1251-1265 and the variant's kind change (wg_shader.c 535-537:
`WGSL_STORAGE_READ` becomes `WGSL_STORAGE`).

**Defect:** A dispatch's read-only SSBO is promoted to writable storage when its memory has a writable SSBO and the two
ranges don't overlap. The check compares each read-only one only with the *originally* writable ones, never with the other
promoted ones. Two read-only bindings over overlapping ranges of one memory (the same VkBuffer range bound to two readonly
bindings, or overlapping sub-ranges) beside a writable binding elsewhere in that memory are both promoted, and WebGPU
refuses two writable storage bindings of overlapping ranges ("writable storage buffer binding aliasing", the rule the
comment at 1088-1090 cites). The dispatch is invalid and the submit lost. Without the promotion they would have gone to
shadows (`scope_dispatch`) and worked.

**Trigger:** compute shader with SSBO W (writable) at [0,256) of memory M and readonly SSBOs R1, R2 both at [1024,2048) of M.

**Fix direction:** promote a read-only binding only if it overlaps neither a writable one nor one already promoted (else
leave it read-only: the scope's shadow serves it).

**Test:** tests/venus-driver.test.ts misc: that dispatch; expect no validation error and W's writes. In wg_test.c the
variant's mask for it can be asserted to promote at most one of R1/R2.

---

### R5. Dropped work: a feedback cut splits transform feedback's jobs, and the draws after the cut capture nothing

**Where:** `feedback_copies` 3496-3515 ends the WebGPU pass mid-Vulkan-pass (`gpu_pass_end`, then `begin_pass(r, 2)`);
the worker's `endPass` (web/venus-gpu.ts 1681-1688) runs the pass's `xfbJobs` at each WebGPU pass end, and
`gpu_render_pass` (526-555) resets them; `runXfb` (1700-1737) needs a `begin` in the same job list (`if (session)`).

**Defect:** With transform feedback active across a cut, the first part's job list is `[begin, draw…]` (finished without
its counters), the second's `[draw…, end]`: the draws after the cut find no session and are dropped silently, and the
`end` writes no counters. The capture loses vertices with no warning.

**Trigger:** a pass with an input-attachment feedback loop (ANGLE's framebuffer fetch through input attachments, for
example) while `vkCmdBeginTransformFeedbackEXT` is active, with captured draws after the first feedback draw (or after a
barrier/clear that forces a second copy).

**Test:** tests/venus-driver.test.ts: xfb begun, a captured draw, a draw reading an input attachment of the pass, another
captured draw, xfb end; expect both draws' vertices in the buffer and the counter at their sum.

---

### R6. Wrong pixels: LOAD_OP_NONE is treated as "discard" by the alias tracking

**Where:** `begin_rendering` 702 (`record_attachment_use(cmd, v, a->loadOp != VK_ATTACHMENT_LOAD_OP_LOAD && !partial &&
!resumed)`); `image_use` 2901, 2925-2926.

**Defect:** `VK_ATTACHMENT_LOAD_OP_NONE` keeps the image's contents (`load_op` maps it to "load" at 543), and with
`STORE_OP_NONE` (mapped to "store" by `store_op`) the pass must leave the image as it was. The use is recorded with
`discard = true`, so `image_use` skips bringing the view's texture up to date and then marks it the only holder
(`*v = bit`). For a mutable image whose latest bytes are in another of its textures, the pass loads the stale alias
texture, stores it, and the next use elsewhere copies those stale bytes over the right ones. `KHR/EXT_load_store_op_none`
are advertised (wg_caps.c 94-95).

**Trigger:** a MUTABLE_FORMAT image written through its own texture (a copy, a clear, a pass in its own format), then a
pass with a view of another format (an alias) as colour attachment with loadOp NONE (storeOp NONE or STORE with nothing
drawn there), then a read in the image's own format.

**Fix:** `discard` only for CLEAR and DONT_CARE.

**Test:** wg_test.c / tests/venus-driver.test.ts: image R8G8B8A8_UNORM, MUTABLE, an R32_UINT view; clear the image to a
colour, a pass on the R32_UINT view with NONE/NONE and no draws, copy the image to a buffer; expect the clear colour.

---

### R7. Wrong pixels: a pass's layers past 32 are silently ignored, while 256 are advertised

**Where:** `WG_MAX_LAYERS` 32 (wg_private.h 372); `wg_CmdBeginRendering` 872-873 (`MIN2(info->layerCount, WG_MAX_LAYERS)`);
wg_caps.c 345 (`maxFramebufferLayers = MIN2(max_texture_array_layers, 256)`).

**Defect:** A layered pass of more than 32 layers replays only its first 32: layers 32 and up get no load-op clear, no
`vkCmdClearAttachments`, no resolve (end_rendering's `layer_mask`), and no warning. Either advertise
`maxFramebufferLayers = WG_MAX_LAYERS` or replay them.

**Test:** a framebuffer of 40 layers over a 40-layer colour view, loadOp CLEAR, no draws, read back layer 35; expect the
clear colour. dEQP-VK cases with framebuffers of many layers (e.g. `dEQP-VK.api.image_clearing.*` clear-attachment cases
over many layers) would show it if their layer count passes 32.

Related, minor: 831 evaluates `mask >> (view + 1)` before `view == 31`, a shift by 32 (undefined behaviour in C) when
`layerCount == 32`; 835 has the order right. Swap the operands at 831.

---

### R8. Wrong pixels (rare): a feedback copy takes the attachment's layer, not the layer the input attachment reads

**Where:** `feedback_att` 2749-2751 (overlap of the two views' whole layer ranges); `feedback_copies` 3505
(`layer = att->vk.base_array_layer + view`).

**Defect:** In a layered pass each WebGPU pass attaches one layer (`wg_view_att(v, view)`), and draws go to the first only.
An input attachment view of another layer of the same image, inside the attachment view's range, matches `feedback_att`
(ranges overlap) and is bound to the twin, which is copied from the attachment's base layer. The shader reads layer
`att.base` where it asked for `v.base`; WebGPU would have let it sample that other subresource directly. The same holds in
a multiview pass when the input view's base layer differs from the attachment view's (view k reads `v.base + k`, the twin
holds `a.base + k`).

**Trigger:** layered pass over layers [0,4) of image I, an input attachment view of layer 2 of I, a draw reading it.

**Fix:** match the layer actually attached in this WebGPU pass (`a.base + (layered ? 0 : view)`) against the layer the
input reads (`v.base + (multiview ? view : 0)`), and copy the latter.

**Test:** wg_test.c recording + tests/venus-driver.test.ts: the case above, layer 2 cleared to a known colour beforehand;
expect that colour from the input attachment.

---

### R9. Minor: `suspending` is set only for passes with a depth/stencil attachment

**Where:** `begin_rendering` 768 (`cmd->pass.suspending = suspending;` inside `if (ds && ds->att)`); `end_rendering`
896-912.

**Defect:** A colour-only pass that suspends runs its drawn colour resolves (integer formats, partial areas, 3D slices) at
the end of each suspended part, not only at the instance's last part as the comment at 895 says. The last part resolves
again, so the result ends right; the earlier parts' resolves are wasted draws over the render area (each layer's).

**Test:** a suspended/resumed pair of passes with an R32_UINT multisampled colour attachment and a resolve; count OP_META
resolves in the recorded list (wg_test.c): expect one per layer, not two.

### R10. Minor: a non-indexed triangle fan of more than 65,536 vertices is dropped silently

**Where:** `draw` 1630 (`if (vertices < 3 || vertices > WG_FAN_VERTICES) return;`), after `record_draw` has emitted its
state. No warning, unlike the other refusals in this file. (Indirect fans are the other reviewer's.)

**Test:** wg_test.c: a 70,000-vertex fan records an OP_DRAW_INDEXED (or a warning) rather than nothing.

---

### R: What I checked and found fine

- **Multiview / layered replay** (`OP_VIEWS`, `OP_PASS`, `OP_PASS_END` jumping back to `pass_op`): each view's JSON found by
  `view_order`, the dummy pass's single JSON standing for all, `OP_PASS_ATTS` and `OP_IMAGE_USE` emitted before
  `OP_VIEWS` so the jump doesn't repeat them, `r->atts`/`view_mask`/`layered` cleared only at the last view's end.
  Per-view pipelines keyed by the view's bit index both at record (1471-1476) and replay (3885-3889). Queries one a view
  (`first + view_order`). Push-buffer places counted per view in `emit` and taken per view in replay; indirect draw
  parameters re-copied per view by `prepasses`; tickets restart per view. Later layers of a layered pass skip draws,
  queries and xfb, run no `scope_pass`/`prepasses`, and bind groups there are never set (no `apply`), so their uses never
  reach WebGPU's scope. `OP_CLEAR_LAYERS` layer ranges are relative to the views' base layers on both sides. Resolves cover
  `layer_mask`'s layers with the right source/destination layer (3D destination by slice).
- **Usage scopes:** the keys `find_shadow` matches on (buffer, offset with dynamic offset, size) are computed the same way
  by `bind_uses`/`scan_pass` and by `bind_group`/`apply` for uniform, storage, texel, vertex, index, draw-indirect (count
  and stride) and dispatch-indirect (12 bytes) uses; spans keep 256-byte alignment so shadowed dynamic offsets stay valid;
  stale vertex buffers in `vb_mask` are both scanned and set (consistent); the scan follows secondaries; `scope_end` copies
  written shadows back after the pass and rebinds without shadows with readbacks suppressed; places are in order within a
  submit and the queue orders a later submit's reuse after an earlier one's reads; the old shadow buffer is released only
  after the submit is encoded, and the worker resolves ids eagerly (`self.get` at call time), so released ids are safe.
- **Aliases (T4):** `image_use` picks the lowest valid holder, copies bytes for bytes with the holder's block size, handles
  3D (layer 0, all slices) and arrays per layer, and words at `words_at[m] + row*rows*layer` matching `view_words` and
  `wg_image_words`' layout; `scope_images` does all reads before writes; transfers, clears, blits and resolves record their
  uses; the depth attachment records none, which is right while depth images have no aliases. Shared images' words go back
  to the texture at each submit's end.
- **Feedback loops:** the twin's mark is fresh per pass instance (and per view), per barrier and per clear; groups reading a
  twin or a multiview input layer are never taken from or put in a set's cache; the cut stores every attachment (keep 1,
  then 2) and carries an occlusion query on in a spare slot; depth/stencil read-only aspects are excluded from `written`.
- **Re-recording and resubmission:** `wg_cmd_buffer_reset` clears the op list, draws count, push sets, dummies, bound
  state and the dedup state (`forget`); replay never writes into a command buffer's ops (only `dummy_samples` patches at
  record), so a command buffer replays the same each time and a secondary can be executed more than once. Replay state
  carried across command buffers in a submit is always re-established because each command buffer starts with `forget`d
  recording state and `ExecuteCommands` forgets after a secondary.
- **Dummy attachments** are referenced by every command buffer that names them, so the device's replacement of one can't
  release an id a recorded pass holds.

## X: Transfers, clears, queries, indirect fans (vk/driver/wg_cmd.c, web/venus-gpu.ts)

Scope: `git log 9730e991..HEAD -- vk/driver/wg_cmd.c` (VK4 T2 to T12), the transfer, clear, query and indirect paths,
read end to end into the worker (`web/venus-gpu.ts`), where most of the emulation lives. Static only: nothing was built
or run. Ranked by severity: lost submit, then dropped work, then wrong pixels, then minor.


### X1. Lost submit: a buffer/image copy of one block row with `bufferImageHeight` taller than the region gets an unaligned `bytesPerRow`

- **Where:** `vk/driver/wg_cmd.c:3748` (`copy_bt_replay`) and `web/venus-gpu.ts:879-883` (`layout`).
- **Defect:** `copy_bt_replay` takes the single-copy path when `block_rows <= 1 && c->d == 1`. Here `block_rows` comes
  from the region's height. It then passes `c->rows` as rowsPerImage, and `c->rows` comes from `bufferImageHeight`.
  `layout()` leaves out `bytesPerRow` only when `rows <= 1`. With `rows > 1` it sets `bytesPerRow: bpr`, and that value
  is not a multiple of 256. WebGPU refuses an unaligned bytesPerRow on `copyBufferToTexture` and
  `copyTextureToBuffer`. The encoder becomes invalid, so the whole submit is dropped, not just the copy.
- **Trigger:** `vkCmdCopyBufferToImage2` or `vkCmdCopyImageToBuffer2` on a colour (or compressed) image, under all
  of these conditions:
  - `imageExtent.height` is at most the format's block height;
  - `imageExtent.depth == 1`;
  - `bufferImageHeight` is greater than the height (in blocks);
  - `DIV_ROUND_UP(bufferRowLength or width, bw) * bytes` is not a multiple of 256.

  Example: R8G8B8A8, extent 10x1, `bufferImageHeight = 4`. Packed formats aren't affected (`unpack`/`pack` do their own
  layout), and neither is depth or stencil (`depthStencilCopy` realigns).
- **Fix direction:** in `layout`, decide on "one row" from the copy's block rows (`h`/block height), not from
  `rowsPerImage`. Or pass `rowsPerImage` only when `depth > 1`.
- **Test:** a `wgt_misc` scenario in `vk/driver/wg_test.c` (and a `misc:` row in `tests/venus-driver.test.ts`):
  1. upload a 10x1 region of an RGBA8 image from a buffer with `bufferImageHeight = 4`;
  2. copy the region back to a buffer with the same layout;
  3. compare the bytes, and assert `r.errors` is empty (today WebGPU reports the bytesPerRow error and the fence's
     readback is the 0xee fill).

### X2. Lost submit: a drawn colour resolve into an sRGB-twin view uses a pipeline whose target format isn't the attachment's

- **Where:** `vk/driver/wg_cmd.c:900-911` (`end_rendering`: the `"format"` is `dst->fmt->name`, the textures are
  `view_texture()`), `web/venus-gpu.ts:1535` (pipeline target `fmt`) and `:1539` (`this.attachment(D, ...)` →
  `viewOf` with no format, so a view in the texture's own format).
- **Defect:** A view whose format is its image's sRGB twin, or the other way round, keeps `alias == 0`. WebGPU views
  the image's own texture in that format through `viewFormats`, so `view_texture(dst)` is the UNORM texture while
  `dst->fmt` is the sRGB format.
  - `resolveByDraw` builds its pipeline for `targets: [{format: j.format}]` (sRGB), but draws into a view of the
    texture's format (UNORM).
  - WebGPU refuses the attachment-state mismatch, which drops the submit.
  - When the resolve isn't drawn (WebGPU's own resolve, `meta` `j.op === 'resolve'`, both views without a format), it
    averages in the texture's encoding rather than the view's (minor).
- **Trigger:** dynamic rendering with a multisampled colour attachment and a `resolveImageView` that is an sRGB view of
  a MUTABLE UNORM image (or a UNORM view of an sRGB image), where the resolve is drawn: a partial render area
  (`partial`), a 3D slice, or a non-blendable/FLOAT32 format. A swapchain made with
  `VK_SWAPCHAIN_CREATE_MUTABLE_FORMAT_BIT_KHR` and MSAA over a sub-rectangle is the realistic case.
  `vkCmdResolveImage2` is not affected, because it passes the image's format.
- **Fix direction:** pass the view's format to `viewOf`/`attachment` in `resolveByDraw` (and in the whole-level resolve),
  or have the driver send the view's format beside the texture.
- **Test:** a driver test: a 4-sample B8G8R8A8_SRGB view of a mutable B8G8R8A8_UNORM image, cleared, resolved at
  pass end into an sRGB view of another mutable UNORM image, with a render area short of the image; read it back and
  expect no WebGPU error. dEQP-VK: `renderpasses.dynamic_rendering.*` partial-render-area resolves on mutable sRGB
  images, if any are in the supported set.

### X3. Lost submit or a huge allocation: an indirect indexed fan sizes its index list by the whole bound index-buffer range

- **Where:** `web/venus-gpu.ts:2110-2116` (`fanIndirect`), from `vk/driver/wg_cmd.c:1836-1840` (`op.ib_size = cmd->ib_size`,
  which is `vk_buffer_range(..., VK_WHOLE_SIZE)` from `wg_CmdBindIndexBuffer2`).
- **Defect:** The draw's count is on the GPU, so the worker reserves the worst case:
  `listBytes = (most - 2) * 12`, where `most` is every index from the bind offset to the end of the bound range,
  capped at `maxStorageBufferBindingSize`.
  - It does this for every draw of every indirect fan, from the `STORAGE|INDEX` scratch buffer, which doubles as it
    grows.
  - Once `listBytes` passes `maxStorageBufferBindingSize`, the bind group at binding 2 is invalid. That happens for an
    index range of more than about 11M indices: 22 MiB of 16-bit indices or 44 MiB of 32-bit ones, at the 128 MiB
    default.
  - The scratch can also pass `maxBufferSize` (2 × need). Either way the submit is lost.
  - Below that, each draw still allocates up to six times the index buffer's size, every submit.
- **Trigger:** `vkCmdDrawIndexedIndirect` with `TRIANGLE_FAN` and a large index buffer bound with `VK_WHOLE_SIZE`
  (one big shared VkBuffer, as allocators make), or many indirect fan draws in one submit.
- **Fix direction:** bound the list differently, for example by a per-draw cap that is warned about, by WG_FAN_VERTICES
  as the non-indexed path does, or by a second compute step sized from the arguments. At least clamp `listBytes` to
  `maxStorageBufferBindingSize` and warn.
- **Test:** a driver test that binds a 48 MiB index buffer of 32-bit indices (only the first 6 indices meaningful) and
  issues one indirect indexed fan with `indexCount = 6`. Expect no WebGPU error and the 4 triangles drawn.

### X4. Dropped work: a multisampled `vkCmdCopyImage` of several layers copies only the first

- **Where:** `web/venus-gpu.ts:491` (`gpu_copy_tt` calls `copyMultisampled` without `depth`) and `:1154-1235`
  (`copyMultisampled` copies one layer: `depthOrArrayLayers: 1`, and one `srcView`/`dstView` at `sz`/`dz`).
  `wg_CmdCopyImage2` (`vk/driver/wg_cmd.c:2024-2049`) emits one `OP_COPY_TT` with `.d = layerCount`.
- **Defect:** Since T12 multisampled arrays exist (`MsLayers`). A copy of `layerCount > 1` between them copies only
  layer `baseArrayLayer`, both on WebGPU's whole-subresource path and on the per-sample draw. The other layers keep
  their old contents, and there is no warning.
- **Trigger:** `vkCmdCopyImage2` between 4-sample 2D-array images with `layerCount >= 2`. dEQP-VK's
  `copy_and_blit.*.resolve_image.*copy_before_resolving*` on array images would meet it. It may also be behind the
  backlog's "Multisampled image clears ... `multiple_layers`, `remaining_array_layers` read 0" if those cases copy
  before reading back. Check before assuming.
- **Fix:** loop the layers in `gpu_copy_tt` (or in `copyMultisampled`), `sz + l` and `dz + l`.
- **Test:** extend `msCopyWithin` (`wgt_misc`, `t10_misc`) with a 2-layer 4-sample image: clear layer 0 to A and
  layer 1 to B, copy both layers to a second image, resolve each layer and compare. Today layer 1 reads the destination's
  old contents.

### X5. Wrong pixels: a multisampled copy between sRGB and UNORM twins converts the values instead of copying bits

- **Where:** `web/venus-gpu.ts:1157-1164` (formats allowed to differ by `-srgb`; the whole path needs an exact match)
  and `:1193-1203` (`srcView`/`dstView` in the textures' own formats; the draw writes `textureLoad`'s value).
- **Defect:** Vulkan's copy is bit for bit. Here `textureLoad` on an sRGB source decodes to linear, and writing into a
  UNORM target stores the linear value: 0x80 becomes 0x37. In the other direction, UNORM into an sRGB target encodes.
  The comment says "Formats must match but for sRGB (bit patterns can't cross a draw)", but this is exactly the case
  where they don't cross.
- **Trigger:** `vkCmdCopyImage2` between a 4-sample `*_SRGB` image and a 4-sample image of its UNORM twin, or a part
  of either. The backlog's "3 sRGB-twin resolves not understood"
  (`image.mutable.*.b8g8r8a8_srgb_b8g8r8a8_unorm_draw_copy_resolve_mutable_color_att`: green and blue off by about
  0.26, no WebGPU error) fits this. A mid-grey channel of 0.5 decoded is 0.214, about 0.29 off, while channels at 0
  or 1 don't change.
- **Fix:** view the source in the destination's format, or the destination in the source's (the twin is in
  `viewFormats` for mutable images; otherwise add it), so the draw moves raw values.
- **Test:** a driver test: a 4-sample B8G8R8A8_SRGB image cleared to raw bytes (0x80, 0x40, 0xc0, 0xff) through a UNORM
  view (or a draw), copied to a 4-sample B8G8R8A8_UNORM image, resolved, read back. Expect the same bytes. Also run the
  three `image.mutable` cases named above.

### X6. Wrong pixels: a linear blit from a padded compressed image normalizes by the image's size, not the texture's

- **Where:** `vk/driver/wg_cmd.c:2070,2080` (`srcSize` is `vk_image_mip_level_extent(src)`) and `web/venus-gpu.ts:1491`
  (`uv = sx / sw`), `:2552` (the hand filter multiplies `uv` by `textureDimensions(t)`).
- **Defect:** Since T18, a compressed image that isn't whole blocks is a corner of a larger texture whose levels are
  out of proportion. For example, 13x13 ASTC 8x5 sits in 16x20, and level 1 is 6x6 inside 8x10.
  - The linear path samples at `uv` computed against the image's size, but the sampler (and the hand filter's
    `textureDimensions`) scales it by the texture's.
  - The region read is therefore scaled by about 16/13 (8/6 at level 1), and filtering at the image's edge reads the
    padding.
  - The nearest path works in texels and is right.
- **Trigger:** `vkCmdBlitImage2` with `VK_FILTER_LINEAR` from a BC/ETC2/ASTC image whose width or height isn't a
  multiple of the block. BLIT_SRC and FILTER_LINEAR are advertised for those formats (`wg_format.c:318-320`).
- **Fix:** send the texture's level size (or the ratio) in the JSON and normalize by it; clamp to the image's texels in
  the hand filter.
- **Test:** a driver test: a 13x13 BC1 (or ETC2) image of known blocks, blitted LINEAR 1:1 to a 13x13 RGBA8 image.
  Compare against the same blit NEAREST, which should be identical at a 1:1 scale with texel centres.

### X7. Minor: query readbacks overwrite `values[]` of queries the submit didn't end

- **Where:** `vk/driver/wg_cmd.c:2623-2639` (`query_ended` widens `[lo, hi)`), `:4512-4513` and `:4744-4746`.
- **Defect:** The readback covers every query between the lowest and highest index this submit ended. At completion it
  copies the pool buffer's values over `pool->values[]` for all of them. A query in between that was reset (on the
  host, or by this submit) and not ended gets the buffer's stale value from its previous use. `ended == 0` keeps it
  unavailable, but `vkGetQueryPoolResults` with `PARTIAL_BIT` then returns the old result rather than a value in
  [0, final]. Harmless otherwise.
- **Test:** a `wg_test.c` scenario: end queries 0 and 2 in one submit with query 1 holding an old nonzero result from an
  earlier submit and reset on the host in between; `GetQueryPoolResults(1, PARTIAL)` should be 0.

### X8. Minor: a multisampled copy between packed layouts (R5G6B5 into B5G6R5) moves unpacked channels, not bits

- **Where:** `web/venus-gpu.ts:490` (`copyPacked` only for `S.sampleCount === 1`), then `copyMultisampled` with both
  textures `rgba8unorm`.
- **Defect:** R stays R, where Vulkan's bit copy would put the source's R bits into the destination's B. Packed formats
  are renderable (RB) and so multisampled.
- **Test:** a 4-sample R5G6B5 image cleared to pure red, copied to a 4-sample B5G6R5 image, resolved and read back:
  Vulkan gives pure blue.

### X: Checked and found fine

- **Buffer↔image region arithmetic** (`copy_bt`):
  - Per-layer offsets use `bpr * rows` in blocks, from `bufferRowLength` and `bufferImageHeight`.
  - The 3D extent is one copy.
  - Compressed extents are rounded to blocks.
  - Multi-planar planes use the plane's format.
  - Depth bytes are 4 for D24S8/D32S8 and 2 for D16; stencil is 1.
  - Packed formats are 2 bytes in the buffer.
  - The image-to-host-visible readback size is right per layer and slice.
  - `copy_bt_replay`'s per-row split for unaligned pitches is right, 3D included.
- **`depthStencilCopy` / `depthByShader` / `partThroughBuffer` / `stencilByDraws`:**
  - Row realignment is correct, as are D16 byte addressing and binding offsets aligned to 256.
  - Usages hold: TRANSFER_SRC adds TEXTURE_BINDING, and TRANSFER_DST on depth/stencil adds RENDER_ATTACHMENT
    (`wg_texture_create`).
  - Depth24plus's copies go only through shaders.
- **`vkCmdCopyImage2`:**
  - 2D↔3D layer/depth mapping is correct.
  - The block-for-block `cols/rows/dst_w/dst_h` for compressed↔uncompressed is right, and so is `copyBetweenFormats`'s
    temporary layout (256-aligned rows, rowsPerImage in blocks).
  - A copy within one subresource goes through a temporary texture.
  - Packed formats use `copyPacked` (pack/unpack rounding are mutual inverses; atomics on shared 16-bit words).
- **Blits:**
  - Flips in x, y and z are handled.
  - The nearest texel comes from the fragment position, clamped high and never negative for valid regions.
  - 3D slices map at their centres.
  - Integer clamps are right (`integerRange`, including rgb10a2uint's alpha).
  - A blit within one subresource samples a copy.
  - The pipeline cache keys cover format, kind, filter and 3D.
- **`vkCmdResolveImage2`:** a JSON per layer, the 3D destination slice is right, WebGPU's own resolve only for a whole
  level of a resolvable format, otherwise a draw (integer: sample 0); MsLayers views map per layer.
- **Clears:**
  - `clear_image` handles REMAINING levels and layers; a 3D level clears every slice in the worker.
  - UINT, SINT and float values are kept apart; OPAQUE alpha is forced to 1.
  - Depth is clamped, and a stencil-only clear loads the depth.
  - Formats that can't be rendered to clear by copy.
  - rgb10a2uint is cleared by a draw both in `meta` and at the pass's load (`wide_clear`).
  - `vkCmdClearAttachments`: layer ranges are grouped, `OP_CLEAR_LAYERS` per layered view, multiview clears every
    view, secondaries take their formats from inheritance.
  - `clearRects`: rects clamped to the attachment, targets not cleared have writeMask 0, `RD_ALL` after it restores the
    pass's state, and a clear cuts an active query into a spare.
- **Queries:**
  - Spare slots: `n + qspares < n + spares <= 4096`; buffer size `(n + spares) * 8`.
  - The mux pass's slots are resolved one at a time through the scratch buffer in encoder order.
  - Spare adds come after all resolves.
  - A query begun outside a pass counts its first pass in its own slot, later ones in spares, and 0 with none.
  - A passing write followed by spare adds stays nonzero.
  - Multiview queries are consecutive per view; layered later views skip queries.
  - `copy_queries`: 32/64-bit, WITH_AVAILABILITY, PARTIAL, values not written when unavailable, timestamps from the CPU,
    and the host-visible readback range is right.
  - `gpu_update` and `gpu_fill` are encoder copies, so they are ordered.
  - `GetQueryPoolResults` decides availability by the completed serial.
- **Indirect:**
  - Tickets for fans and provoking draws are numbered the same way in `prepasses` and the replay (faces, secondaries,
    multiview reruns of prepasses, layered skips in both).
  - Draw parameters are copied from the right argument offsets.
  - The fan compute's argument binding window holds 5 words, and its triangle order is Vulkan's.
  - The scratch places reset per encoder and the uniforms written by `queue.writeBuffer` are ordered against earlier
    submits' reads, held submits included (`later` keeps order; `staging` picks `recTemps` vs `temps` correctly).
  - The old scratch buffer is destroyed only after the submit.
- **Lifetimes:**
  - Temporaries are destroyed after their submit's `queue.submit`, and held batches run synchronously before their
    `start`.
  - Ids are resolved to objects at call time (`gpu_blit`, `gpu_copy_*`, `gpu_fan_indirect`, `gpu_xfb`).
  - The `viewOf` cache is keyed per texture object, mip, layer and format.

## O: Objects, memory and capabilities (wg_device.c, wg_descriptor.c, wg_format.c, wg_caps.c, vkr-wasm.patch)

Scope: vk/driver/wg_device.c, wg_descriptor.c, wg_format.c, wg_caps.c, wg_gpu.h, wg_private.h, vk/patches/vkr-wasm.patch,
vk/glue.c, vk/wasi/arena.c, plus the parts of wg_cmd.c they hand off to (submit, held submits, syncs, completion,
uploads, bind-group caching). Read-only; nothing built or run.

Ranked by severity: crash/lost device > dropped work > wrong pixels > minor. Each finding gives the code, the defect,
what triggers it, and a test that would confirm it.

---

### O1. (dropped work / memory corruption) An aliased import ignores `VK_MEMORY_ALLOCATE_DEVICE_ADDRESS_BIT`

**Where:** wg_device.c:739-749 (the opaque-fd alias path returns `src` before line 757 reads `VkMemoryAllocateFlagsInfo`),
then wg_device.c:993 (`buffer->offset = mem->gpu_at + memoryOffset`) and :970 (`wg_GetBufferDeviceAddress` returns it).

**Defect:** if the guest imports its own export again and asks for device addresses on the import, the driver returns the
original memory unchanged. If the original was allocated without the flag, it is not in the device's address buffer
(`gpu_at == 0`, `mem->address == false`, `mem->gpu` is its own GPUBuffer). Two things follow:
- A buffer bound at offset 0 gets device address **0**, which the code says never happens (wg_device.c:673, "never 0").
- At offset ≥ 4096 the address is a byte of the address buffer that belongs to **another** memory, or to a hole.

Shader loads and stores through that pointer read and write another allocation's bytes. The memory's real bytes (its own
GPUBuffer) never see them. The application did nothing wrong: it allocated the import with the flag.

**Trigger:** export memory without the flag, then import it with `VkMemoryAllocateFlagsInfo{DEVICE_ADDRESS}`. VMA does
this whenever its allocator has `BUFFER_DEVICE_ADDRESS` (it chains the flag onto every allocation, imports included).
vkd3d-proton and DXVK shared resources do the same. The reverse case is also unhandled (the import lacks the flag, the
source has it), but it is harmless.

**Test (wg_test.c, next to `wgt_heaps`):** allocate type-0 memory with no flags. Import it by `fd = (int)(uintptr_t)mem`
with `MEMORY_ALLOCATE_FLAGS_INFO{DEVICE_ADDRESS}`. Bind a `SHADER_DEVICE_ADDRESS` buffer at offset 0 and check that
`vkGetBufferDeviceAddress` is not 0. It is 0 today. **Fix options:** refuse the alias (and make a memory of its own) when
the flags differ, or place the source in the address buffer.

### O2. (dropped work) Once the original vkr memory is freed, a surviving alias is no longer moved by map and unmap

**Where:** the patch's `vkr_device_memory_release` hunk (`mem->wasi_res->storage = …; mem->wasi_res->memory = NULL`),
together with `vkr_renderer_map_resource` and `vkr_renderer_unmap_resource`, which only call `vkr_wasi_memory_moved` when
`res->memory` is set. Driver side: wg_device.c:813-816 keeps the driver memory alive while `aliases > 0`.

**Defect:** memory A is exported as resource R and imported again as B, so the driver has one `wg_device_memory` with
`aliases = 1`. Freeing A's vkr object hands A's storage to R and clears `R->memory`. The driver memory lives on as B, with
`data` still pointing at that storage (or at the window).
- **First mapping after the free:** a map of R (Venus maps the shared bo lazily, at the first `vkMapMemory` of B) copies
  the storage into the window but does not rebind the driver memory. The guest then writes the window, while the driver
  uploads from the old storage and lands its readbacks there. Guest writes never reach the GPU, and GPU results never
  reach the guest. The unmap copies the window back into the storage without marking it dirty, so even those writes are
  never uploaded.
- **Mapped while A was freed, then unmapped:** the driver memory stays pointed into a window range that the device
  (web/gpu.ts RESOURCE_MAP_BLOB) will hand to the next blob. Uploads and readbacks then read and write another
  mapping's bytes.

**Trigger:** export host-visible memory, import it again, free the exported handle, then map the import. dEQP's
external-memory cases that free the exporter before using the import, and programs that share memory with themselves,
do this.

**Test:** tests/venus-renderer.test.ts (it drives vkr and the window). Make a host-visible memory, export it as a blob,
import it, free the original, map the blob, write a word, then copy it on the GPU into a buffer read back through
another memory. The word arrives as 0. **Fix direction:** keep a list of the vkr memories that alias a resource, or have
the release hand `res->memory` to a surviving alias instead of clearing it.

### O3. (crash, renderer-wide) A large binding number overflows the set layout's 32-bit size

**Where:** wg_descriptor.c:61 (`bindings = MAX2(bindings, binding + 1)`) and :67-69 (`size` computed in a 32-bit
`size_t`), then :91-92 and :105-110, which write `first`, `count`, `type`, `stages` and `inline_bytes` per binding
number.

**Defect:** the per-binding tables are sized by the highest binding number + 1. Vulkan puts no ceiling on binding numbers.
Two cases:
- **binding ≥ ~2^28:** `bindings * 20` wraps in wasm32, so the allocation is tiny and the loop at :91 writes billions of
  entries. That corrupts memory 1 (the arena, the window, other contexts' data) or traps the module.
- **binding = 0xFFFFFFFF:** `binding + 1` wraps to 0, and `l->first[0xFFFFFFFF]` writes 4 bytes before the table.

Any guest process can lose every context's Vulkan this way: the renderer is one module.

**Test (wg_test.c):** `vkCreateDescriptorSetLayout` with a single binding numbered `0x40000001`, expecting
`VK_ERROR_OUT_OF_HOST_MEMORY` or success with the module intact. Today it traps or corrupts. **Fix:** compute the sizes in
`uint64_t` and refuse past a bound, or map sparse binding numbers through a sorted table.

### O4. (advertised, not backed) `VK_KHR_push_descriptor` with `maxPushDescriptors = 0`

**Where:** wg_caps.c:113 advertises the extension. `wg_caps_properties` never sets `p->maxPushDescriptors`, so the
generated `vk_physical_device_properties.c` reports 0.

**Defect:** Vulkan requires `maxPushDescriptors ≥ 32` when the extension is supported. The push path (wg_cmd.c `push_set`)
has no limit of its own. A program that sizes its push layouts by this limit either sees none or refuses the device:
vkd3d-proton and DXVK read it to decide how many root or push descriptors to use.

**Test:** `dEQP-VK.api.info.vulkan1p2_limits_validation.khr_push_descriptor` (`validateLimitsKhrPushDescriptor` checks
`maxPushDescriptors ≥ 32`). Alternatively, add a `wgt_caps` row reading `VkPhysicalDevicePushDescriptorPropertiesKHR`.
**Fix:** set it, for example to 32, within `maxPerSetDescriptors`.

### O5. (advertised, not backed; can lose the context) `textureCompressionBC` without BC1_RGB

**Where:** wg_caps.c:163 (`textureCompressionBC = HAS(BC)`). wg_format.c:83-96 has `BC1_RGBA_*` but no
`VK_FORMAT_BC1_RGB_UNORM_BLOCK` or `VK_FORMAT_BC1_RGB_SRGB_BLOCK`.

**Defect:** the feature requires SAMPLED, BLIT_SRC and FILTER_LINEAR on all BC formats, BC1_RGB included. Those two
formats have no features. `wg_CreateImage` refuses them with `VK_ERROR_FORMAT_NOT_SUPPORTED` (wg_device.c:1197-1200),
which `vkCreateImage` may not return. Venus creates images asynchronously, so the guest keeps a handle vkr never made,
and its next use is the "failed to look up object" fatal error that ends the context (the same mechanism as
wg_device.c:555-559's note on semaphores).

**Trigger:** any program that trusts the feature bit, for example a GL-on-Vulkan layer mapping
`GL_COMPRESSED_RGB_S3TC_DXT1`.

**Test:** `dEQP-VK.api.info.format_properties.bc1_rgb_unorm_block` and `.bc1_rgb_srgb_block` (required-feature checks).
**Fix:** back them with `bc1-rgba-unorm(-srgb)` plus alpha forced to 1 (the `WG_FMT_OPAQUE` mechanism), or stop
advertising the feature.

### O6. (advertised, not backed) `shaderStorageImageExtendedFormats` on adapters without texture-formats-tier1

**Where:**
- wg_caps.c:170 sets `shaderStorageImageExtendedFormats = HAS(TIER1_STORAGE)`.
- web/venus-gpu.ts:90 sets `TIER1_STORAGE` on every adapter unless held.
- wg_format.c:54-59: the 16-bit normalized formats are `WG_FMT_TIER1`, and `wg_texture_format` returns NULL for them
  without tier1 (wg_format.c:164).

**Defect:** without texture-formats-tier1 (SwiftShader, older browsers) the feature is advertised, but
`R16_UNORM`, `R16G16_UNORM`, `R16G16B16A16_UNORM` and their `_SNORM` forms, all in the feature's required list, have no
format at all, let alone STORAGE. The words path that backs the other tier1 storage formats cannot help formats that
don't exist.

**Test:** on SwiftShader, `dEQP-VK.api.info.format_properties.r16_unorm` (and the other five). A `wgt_caps` row with
`venus_init` flags = TIER1_STORAGE without TIER1, checking `vkGetPhysicalDeviceFormatProperties(R16_UNORM)` has
STORAGE_IMAGE, also catches it. **Fix:** advertise the feature only with tier1, or offer these formats as storage by
their words alone.

### O7. (wrong pixels) `maxFramebufferLayers` is 256, but a layered pass reaches only 32 layers

**Where:** wg_caps.c:345 (`MIN2(max_texture_array_layers, 256)`) against wg_cmd.c:872
(`layers = MIN2(info->layerCount, WG_MAX_LAYERS)`, which is 32, wg_private.h:372) and wg_device.c:1623.

**Defect:** a framebuffer or dynamic-rendering pass of 33 to 256 layers is replayed for the first 32 only. Layers past 32
miss their load op (clear), their store and their `vkCmdClearAttachments`, with no error. The 256 advertised is
Vulkan's minimum, so this can't be fixed by lowering the limit; the replay has to handle more layers.

**Test:** wg_test.c `wgt_pass`, a new scenario: a 2D-array image of 40 layers, a pass with `layerCount = 40` and
CLEAR load op, then read back layer 39. It stays uncleared.

### O8. (minor, adapter-dependent) The memory pad scales without bound with `maxUniformBufferBindingSize`

**Where:** wg_private.h:93 (`WG_MEMORY_PAD` = the adapter's `maxUniformBufferBindingSize`), wg_device.c:798 (every
memory's GPUBuffer is `size + WG_MEMORY_PAD`), wg_caps.c:243 (`max_buffer = max_buffer_size - WG_MEMORY_PAD`, unsigned).
The address memories' fixed pad is at wg_device.c:675 and wg_private.h:244.

**Defect:** the worker requests the adapter's own limit (web/venus-gpu.ts:206). On an adapter whose uniform binding
limit is large (some report hundreds of MiB, up to the 32-bit clamp), every allocation's GPUBuffer is that much larger,
and creation fails past `maxBufferSize`. If the pad exceeds `max_buffer_size`, `max_buffer` wraps, and `MIN2` then
advertises a 4 GiB `maxMemoryAllocationSize`.

Separately, address memories use a fixed 64 KiB pad while `buffer_binding` (wg_cmd.c:2873) widens a block up to
`res->size`, which can be larger.

**Test:** a `wgt_caps` row with `maxUniformBufferBindingSize = 1 GiB` and `maxBufferSize = 256 MiB`, checking that
`maxMemoryAllocationSize ≤ maxBufferSize`. **Fix:** bound the pad (for example, at 64 KiB) and use the same pad in both
places.

### O9. (minor, adapter-dependent) Vulkan 1.3's 1 GiB minimums for `maxMemoryAllocationSize` and `maxBufferSize`

**Where:** wg_caps.c:243, :388-389. With WebGPU's default `maxBufferSize` (256 MiB, what a device without more reports)
both are 256 MiB − 64 KiB, under maintenance3's and 1.3's 2^30. The device claims 1.3 (wg_device.c:171).

**Test:** `dEQP-VK.api.info.vulkan1p3_limits_validation` or `dEQP-VK.api.info.vulkan1p2_limits_validation.general` on an
adapter at the default.

### O10. (minor, dropped draw) Feedback copies of packed opaque formats always ask for a swizzle

**Where:** wg_device.c:1650-1651 (`wg_view_twin`) adds `"swizzle":"rgb1","usage":4` for `WG_FMT_OPAQUE` with no
`WG_FEATURE_SWIZZLE` check, while `wg_CreateImageView` (:1559-1566) does check.

**Defect:** on a browser that knows `swizzle` but whose adapter lacks texture-component-swizzle, the twin view is a
validation error. Its scope's bind group is then invalid, and the draw that reads the input attachment, along with its
submit, is dropped.

**Trigger:** an `R5G6B5` or `B5G6R5` input attachment read in its own pass.

**Test:** wg_test.c `wgt_pass`, a feedback scenario on `R5G6B5`, run with the swizzle feature off.

### O11. (minor, silent failure) Device-local allocations past the heap or the adapter fail later, silently

**Where:** wg_AllocateMemory (wg_device.c:752-787) checks neither the heap (`heap_used` against `WG_HEAP_SIZE`) nor the
adapter. The GPUBuffer is made lazily at the first bind (wg_memory_buffer, :791-804).

**Defect:** allocating past the 2 GiB device-local heap is valid Vulkan and should return
`VK_ERROR_OUT_OF_DEVICE_MEMORY`. Here it succeeds, and the later `createBuffer` out-of-memory error makes the GPUBuffer an
error object, so every submit using it is dropped.

**Test:** wg_test.c, allocate type 0 in 512 MiB pieces past 2 GiB and expect an error by the fifth.

### O12. (minor) An inline uniform block's binding size can pass its set's buffer

**Where:** wg_cmd.c:2846 (`size = align16(MAX3(range, 16, res->size))`, not clamped) against wg_descriptor.c:113 and :242
(the buffer is the blocks' 256-aligned sizes).

**Defect:** for the set's last block, a shader-declared block larger than its 256-aligned slot (for example, std140 arrays
over a 4 KiB block) binds past the buffer's end. The bind group is invalid and the draw is dropped, whereas a plain
uniform buffer is clamped to its memory plus pad (:2873).

**Test:** wg_test.c, a 4,096-byte block read as `float a[1024]` under std140 (16 KiB declared).

### O13. (minor, spec) An infinite CPU wait returns `VK_TIMEOUT`

**Where:** wg_cmd.c:4841-4855. With `MESA_VK_MAX_TIMEOUT` unset, Mesa's `vk_sync_wait` does not turn this into device
loss (vk_sync.c:350-360), so `vkQueueWaitIdle`, `vkDeviceWaitIdle` and `vkWaitForFences(UINT64_MAX)` can return
`VK_TIMEOUT`, which isn't a valid result for an infinite timeout. vkr's own idle wait is patched out, and Venus's guest
waits on its own side. This is by design (wg_cmd.c:4769-4772), noted so it isn't mistaken for a new bug.

### O14. (minor, misbehaving guest only) A mapped blob unreffed without an unmap

**Where:** web/gpu.ts:326-340 (RESOURCE_UNREF sends `blob-unref` without `blob-unmap`) and the patch's
`vkr_context_free_resource` (no copy back, no rebind).

**Defect:** a memory whose resource dies while mapped keeps `data` in a window range that the next MAP_BLOB may reuse.
Linux's virtio-gpu always unmaps first (`virtio_gpu_vram_free`), so only a broken or hostile guest kernel gets here, but
it reaches across contexts. **Test:** tests/venus-renderer.test.ts, unref a mapped blob, map another at the same offset,
and check the first memory's upload.

### O15. (lower confidence, to check against upstream vkr) Mapping a blob of an imported memory copies from address 0

**Where:** the patch's `vkr_renderer_map_resource`. `vkr_resource_storage()` is `memory->wasi_storage`, which is NULL for
an imported memory (no storage of its own) and for device-local memory. Its `res->u.data` is NULL too, so the guard
passes and `memcpy(where, NULL, size)` copies the module's memory from 0 into the guest window. It then rebinds the
shared driver memory (an alias of another) to the window.

This is reachable only if upstream's `vkr_device_memory_export_blob` lets a memory with `valid_fd_types == 0` (an import),
or a second export, be exported as a mappable blob. I couldn't read upstream here. If it does, that's an information leak
of other contexts' data into a guest process.

**Fix:** refuse to map when the storage is NULL.

### O16. (minor, robustness) Immutable samplers are kept by pointer

**Where:** wg_descriptor.c:118 and :256 copy `wg_sampler *` into the layout and into each set. wg_cmd.c `bind_group`
dereferences `d->sampler->id` when a group is made. A sampler destroyed after the layout is created, while sets and
layouts live on (lavapipe and RADV copy the state, so programs do this), leaves a dangling pointer: a freed or recycled
sampler id at the next bind-group build. Whether Vulkan allows this ordering is debatable; noted for the review's
triage.

### O17. (trivial) A leak in `wg_CreateDevice`

When `vk_queue_init` fails (wg_device.c:626-629), `mem_cache` (made at :615) is not destroyed. The
`wg_device_register` failure path does destroy it.

---

### O: Checked and found fine

- **Device creation and destruction:** register, then drain (pending and held submits freed without touching their
  command buffers), then `vk_queue_finish` (syncs finished after the drain are no longer searched, and none remain).
  Each device's own state is zeroed (`address_heap_made`, `pages`, `push_gen`). The 16-device limit fails cleanly with
  `TOO_MANY_OBJECTS`.
- **A context destroyed with live objects (vkr's creation order):**
  - Memory freed before its buffers or images: `wg_FreeMemory` takes linear images off the device's list and shared
    memories off theirs, and `wg_DestroyImage` doesn't touch `image->mem`.
  - Views outliving images: `wg_DestroyImageView` doesn't touch the image.
  - Set layouts destroyed before pools: sets hold a layout reference.
  - Fences and semaphores destroyed while named by pending or held submits: `wg_sync_finish` nulls them in both lists.
  - No `flush_held` can run inside the synchronous teardown, so a held submit isn't replayed with freed command buffers.
  - Both vkr objects of an alias free the driver memory once (`aliases`). `heap_used` counts an alias once.
- **The resource and memory storage handoff:** in either destruction order (resource first or memory first) the
  storage is freed exactly once.
- **The opaque-fd alias check itself:** `res->memory` is non-NULL only while that vkr memory lives, so the handle the
  driver dereferences is live. The device and size checks hold, and a mismatch falls back to a memory of its own.
- **Host-visible memory:**
  - vkr's storage is imported as a host pointer. The rebind to the window and back sets `dirty`.
  - `upload()` and `take_pages()` distribute the window's pages to every registered device.
  - `land()` writes only into the window or the arena (`writable`).
  - `aligned_alloc` sizes can't wrap within the advertised `maxMemoryAllocationSize`.
- **The arena:** `sbrk` refuses negative increments and growth past `VENUS_ARENA_END`, and starts at `__heap_end`.
- **Device addresses:**
  - Heap init and grow: the size is never above `address_most()`, and `at + size + pad ≤ most`.
  - Free goes through `util_vma_heap_free`, not the id release. Pending readbacks of a freed memory are forgotten.
  - Bind groups that name the address buffer are re-keyed by `address_gen` (wg_cmd.c:3258).
  - Texel buffer views and uploads use `gpu_at`, and readback offsets include it.
- **Images:**
  - `valid` is sized as plane × level × layer (3D: 1 per level).
  - Aliases are capped at 7, and words are made lazily, the shared ones listed and unlisted symmetrically.
  - A second shared image bound to the same memory is handled.
  - Multi-planar disjoint bind and requirements are consistent with `wg_image_planes`. The linear layout matches what
    `linear_images` copies.
- **Descriptors:**
  - Slot rollover into the next binding, YCbCr plane slots and template writes.
  - Inline blocks: writes, copies and template entries go through `inline_run` and `gpu_write` in queue order.
  - Immutable samplers are preserved on writes and copies.
  - Push sets are owned by the command buffer, freed only at reset or destroy. Bind groups are cached by
    (bgl uid, set version, plus uid, push gen and address gen hashes).
  - Pool reset and destroy free their sets. The `AllocateDescriptorSets` failure path is clean.
- **Syncs and submits:**
  - Held submits copy their command buffers, signals and timeline waits. Every later submit is held behind one, in
    order, and `pending` gives a replayed signal to later waits.
  - The host signal flushes held submits; a completion flushes at its end (`completing`).
  - Nested flushes leave the list consistent. Completions go in serial order across devices, and a drained device's
    late completions are ignored.
- **Query pools:** set and buffer sizes against the spares, the 4,096 cap (handled by `WG_QUERY_SET_MAX` in the replay),
  availability by global serial, and the pool forgotten by pending submits at destroy.
- **Formats:**
  - ETC2 and ASTC LDR: every format the features require is present.
  - Packed formats are excluded from aliasing and linear tiling. Atomic bits are only on R32.
  - Format list checks, EXTENDED_USAGE features, sample counts against `format_multisamples`, and multi-planar
    restrictions (2D, optimal, no external memory).
- **Caps:** the Vulkan 1.2 and 1.3 required features are all set. The descriptor-limit shortfalls under Vulkan's
  minimums are known and documented (docs/backlog.md:965). Address memory capped at `maxStorageBufferBindingSize` is
  documented (vk/README.md "Device addresses").
- **glue.c:** the exports pass sizes and ids through. `venus_resource_texture` handles a freed memory (VK_NULL_HANDLE).

## C: The translator and pipelines (vk/compiler/, wg_shader.c)

Scope: `git log 9730e991..HEAD -- vk/compiler vk/driver/wg_shader.c`, i.e. wgsl_sampler.c, wgsl_print.c, wgsl_nir.c,
wgsl.h and wg_shader.c, plus the parts of wg_cmd.c / wg_device.c those depend on (`pair_key`, `program_keys`,
`program_for`, `sampler_border`, `wg_CreateSampler`, the bind group's sampler and view choice). Static only: nothing
was built or run. Line numbers are HEAD's.

Ranked: crash, corruption or refused pipeline > wrong pixels > minor.

---

### C1. A variant inherits its base's depth-less fragment module: the same WebGPU id is released twice, and the variant draws with the unkeyed module (corruption / invalid pipeline)

- `vk/driver/wg_shader.c:509` `wg_program_variant` does `memcpy(v, p, sizeof(*v))` and then resets the fields it owns
  (pipelines, pulls, push_group, compute, based, keys, vs/fs_module, ...). It does **not** reset `fs_no_depth` or
  `fs_no_depth_of`.
- `wg_shader.c:1511-1529` `fragment_without_depth(p, fs)` returns `p->fs_no_depth` when `p->fs_no_depth_of == fs`, and
  otherwise `wg_id_release(p->fs_no_depth)` before it makes a new one.
- `wg_shader.c:154` `program_free` releases `p->fs_no_depth`. `program_free_all` frees each variant, then the base.

What goes wrong, once the base has made its depth-less module before a variant exists:
- The variant's first draw that drops depth gets the base's module (`fs_no_depth_of == fs` holds). That module was
  printed without the variant's keys or twin-sampler rewrite. With a mask or split variant it doesn't match the
  variant's layout (a twin sampler's binding, `read_write` storage, a cube bound as its faces with
  `viewDimension: "2d-array"`), so the render pipeline is invalid. With a key variant the sampling isn't emulated, so
  borders, integer address modes and LOD come out wrong.
- When the program dies, id X is released twice (once by the variant, once by the base). `wg_id_release` pushes it on
  `free_ids` twice (`wg_device.c:49`), so the next two `wg_id()` calls both return X. Two live objects then share one
  worker id: one object is silently replaced by the other.
- If the variant's depth-less draw has a different `fs`, it releases the base's live module instead.

Trigger: one pipeline with a fragment stage that writes `gl_FragDepth`, drawn in a pass whose depth/stencil format has
no depth aspect (stencil-only, or none: T10's case). First draw it with a plain binding. Then draw it once where it
needs a variant: a depth or `r32float` view on a texture declared float (the mask), or a border, mirror-once,
LOD-bias or unnormalized sampler (a key). Then destroy the pipeline.

Fix: set `v->fs_no_depth = 0; v->fs_no_depth_of = NULL;` in `wg_program_variant`.

Confirming test (tests/venus-driver.test.ts): the pipeline above, in a colour-only pass. Draw with an rgba8 view, then
with an r32float view (or a clamp-to-border sampler). Assert that the second render pipeline's fragment module differs
from the first's. After `vkDestroyPipeline`, assert that two fresh objects get distinct ids. A debug assertion in
`wg_id_release` against an id already on `free_ids` would catch the whole class.

### C2. One depth texture sampled both with and without comparison in a stage: invalid WGSL or a refused pipeline

- `wgsl_print.c:753-754` (`gather_tex`): any `is_shadow` op makes the binding `texture_depth_*`, and the type sticks.
  Every other op on that binding is then printed against a depth texture.
- `emit_tex` prints `textureSampleBias` (`wgsl_print.c:2445`) and `textureSampleGrad` (`:2460`) without checking
  `depth`. WGSL has neither for `texture_depth_*`, so the module fails to compile.
- wgsl_sampler.c makes such ops by itself:
  - `add_bias` (`:719-722`) turns an implicit `texture()` into `txb` whenever the sampler's `mipLodBias != 0`. DXVK's
    and vkd3d's LOD-bias options set it on every sampler.
  - `to_grad` (`:788`) turns a mirror-once sample into `txd`. It skips only when *this* op is shadow, not when the
    binding is depth.
- Even where the WGSL is valid (`textureSample` and `textureSampleLevel` on depth), the non-comparison sampler stays a
  `"filtering"` layout entry. `nonfiltering` is set only for integer gathers (`:768`), and `program_for`'s mask only
  covers textures declared FLOAT. WebGPU's texture-sampler pair validation (Dawn: a filtering sampler with a non-float
  texture) then rejects the pipeline. This last part is from memory of the spec and Dawn; the WGSL part is certain.

Trigger: GLSL with separate samplers, `texture2D t; sampler s; samplerShadow sc;`:
`texture(sampler2DShadow(t, sc), p)` together with `textureLod(sampler2D(t, s), uv, 0)`, `texture(sampler2D(t, s), uv,
bias)` or `textureGrad`. This is the soft-shadow (PCSS) pattern: a blocker search with a plain sampler beside PCF on
the same shadow map. Godot 4's forward shaders do it with `SAMPLER_LINEAR_CLAMP`; HLSL's
`SampleCmp` + `SampleLevel`/`SampleBias` on one SRV through DXVK/vkd3d does too.

Fix direction: a non-comparison sampler used with a depth-declared binding gets `nonfiltering` (as integer gathers
do). `txb` and `txd` on such a binding become an explicit level, or go through `fetched_sample`.

Confirming tests:
- tests/wgsl.test.ts: compile, through the `compile()` helper, a fragment stage with
  `texture(sampler2DShadow(t, sc), vec3(uv, .5)) + texture(sampler2D(t, s), uv, 1.0).r`. Expect no errors; today
  `textureSampleBias` on `texture_depth_2d` fails.
- The same stage with no bias, printed under a key of `bias: 1`.
- tests/venus-driver.test.ts: a pipeline with `textureLod(sampler2D(t, s), ...)` + `texture(sampler2DShadow(t, sc),
  ...)` on a D32 view must be created and draw.

### C3. A sampler shared by an integer gather and a float sample filters the float texture nearest (wrong pixels)

- `wgsl_print.c:766-768`: a gather of an integer texture sets `nonfiltering` on its *sampler* binding.
  `resource_merge` (`wg_shader.c` `resource_merge`) also ORs it across stages.
- `wg_cmd.c:3368` binds `d->sampler->nearest` for every non-filtering sampler binding. So every float texture that the
  stage, or any stage seeing that binding, samples with the same sampler loses linear filtering and anisotropy.
- `wg_program_variant`'s split (`wg_shader.c:546-594`) gives the twin only to *masked* (unfilterable float) textures.
  Integer gathers never get one.

Trigger: HLSL's shared samplers. One `SamplerState` used for `GatherRed` on a `Texture2D<uint>` (stencil or ID
buffers) and for `Sample` on a float texture in one shader. Through vkd3d-proton or DXVK that is one Vulkan sampler
binding.

Confirming test (tests/wgsl.test.ts, `runSampled`): `utexture2D ti; texture2D tf; sampler s;`. Sum
`textureGather(usampler2D(ti, s), uv).x` (scaled to 0) and `texture(sampler2D(tf, s), uv)` on a 2×2 float image (1, 0
columns) at the texel boundary u = 0.5 with a linear sampler. Expected 0.5; with the twin bound, 1 or 0. Static check:
the info's sampler resource has `nonfiltering = true`. Fix: split as for masked textures (twin at the free even
binding for the integer texture's pairs), or treat the integer gather through fetches.

### C4. Border emulation across levels (mip LINEAR) is skewed by the WebGPU sampler's lodMinClamp/lodMaxClamp (wrong pixels, whole image)

- `wgsl_sampler.c:849-860` (`float_sample`, `multi && mip_linear`): the shader blends two explicit levels, `l0 =
  floor(clamped)` and `l1`, each through `sample_level` (`textureSampleLevel` at a whole level), weighted by `f`.
- The WebGPU sampler is still the one `wg_CreateSampler` made (`wg_device.c:1742`), with `lodMinClamp = minLod` and
  `lodMaxClamp = maxLod`, and mipmapFilter linear. WebGPU clamps each explicit level. With `minLod = 0.5` and λ'' =
  0.5, `l0 = 0` is sampled at 0.5, a blend of levels 0 and 1. The result is 0.25·L0 + 0.75·L1 instead of
  0.5·L0 + 0.5·L1.
- `maxLod` that isn't a whole number does the same to `l1`.
- This isn't only near the edge: with a border key every sample of the pair goes this way.

Related, same path and the nearest-mip path (`:842-847`): `textureSampleLevel(..., 0.0)` filters level 0 with WebGPU's
*mag* filter. Vulkan uses minFilter whenever λ > 0, and `inside()` weights by λ, so with mag ≠ min the sample and its
border weight disagree.

Trigger: `VK_SAMPLER_ADDRESS_MODE_CLAMP_TO_BORDER` (any axis), mipmapMode LINEAR, a view of ≥ 2 levels, and a
fractional minLod or maxLod.

Fix: for this path, bind the pair's sampler with clamps 0..32 (the shader already clamps), or fetch through
`fetched_sample`.

Confirming test (tests/wgsl.test.ts, the "blends towards the border" harness): key `{u: border, flags: 16|1|2|4,
levels: 2, min: 0.5}`, a 2-level image (L0 red 1, L1 red 0), `textureLod(uv_centre, 0)`. `runSampled`'s WebGPU sampler
must carry `lodMinClamp: 0.5`, as the driver's does. Expect 0.5; today 0.25. dEQP-VK's border cases are one level, so
none covers this.

### C5. A cube bound as its faces for one pair leaks into other pairs and stages (wrong pixels / invalid pipeline)

- `wgsl_sampler.c:1046-1047`: an op on a cube texture with no key of its own takes `faces_key()`, which is **another
  pair's** key (`:41-48`, matched on the texture alone). It then samples through that sampler's filters, bias,
  min/max LOD, compare op and border. In the driver, `faces` comes from a comparison sampler on a cube view of
  several levels (`wg_cmd.c:1184`). A second sampler on the same cube with no key of its own (not emulated, implicit
  LOD) is then filtered as the first.
- `wg_shader.c:400-413` `keyed_text`: a stage is re-printed only when it has the key's exact pair, or (padded keys only)
  the texture among its resources. `wg_program_variant` (`:599-602`) turns the texture's layout entry into
  `2d-array` for the whole program. A stage that reaches that cube only through `textureSize`/`textureQueryLevels`, or
  through a different sampler, keeps its own module with `texture_depth_cube`. The layout says `2d-array`, so the
  pipeline is invalid.
- Trigger: a shadow cube of several levels, sampled in the FS by `textureLod(samplerCubeShadow(t, sc1), d, lod)` with a
  non-constant lod (forced key, faces), and also by `texture(samplerCubeShadow(t, sc2), d)`, or sized in the VS.
- Tests:
  - tests/venus-driver.test.ts: the VS sizes the cube and the FS samples it at a dynamic LOD, on a 3-level D32 cube
    view; the pipeline must be valid.
  - tests/wgsl.test.ts: needs `wgsl_test_sampler` to key only one pair. It keys all of them today, so a harness flag
    "key pair 0 only" is needed. Then check that sc2's op compares with sc2's op, not sc1's.

### C6. A keyed print that fails falls back silently to the unkeyed module (invalid pipeline instead of a refusal)

`wg_shader.c:424-433`: when `wgsl_print` fails for a variant, `keyed_text` writes to stderr and returns NULL.
`variant_module` then uses the stage's own module (or 0: the base's). The documented refusals are reachable only in
keyed prints:
- `padded_cube_gather` (wgsl_sampler.c:1016): a gather on a padded compressed cube.
- `cube_gathered` from a faces key: a gather on a shadow cube of several levels that is also sampled at a LOD.

Both leave the base module declaring `texture_cube` while the variant's layout says `2d-array`. So the draw meets a
WebGPU validation error rather than a refused pipeline, and other failures (more than 128 pairs, more than 128
resources) give unemulated sampling. Test: tests/venus-driver.test.ts, a padded ASTC cube view (e.g. 13×13 of 8×5)
gathered in the FS. Expect the documented refusal message and no invalid pipeline.

### C7. Minor

- **`fragment_without_depth` always uses `@location(7)`** (`wg_shader.c:1520`). A stage that also writes colour
  location 7 then has two outputs at location 7, and the module fails. The comment says "a location past the stage's
  own". Use `util_last_bit(outputs)` and refuse at 8. Test: an FS writing 8 colour outputs and `gl_FragDepth`, drawn
  without a depth aspect.
- **gl_ClipDistance read by a fragment stage can pass WebGPU's 16 inter-stage variables.**
  - `declare_io`'s `ffs(~mask) - 1` can give location 16+ (`wgsl_print.c:1205-1214`).
  - The VS's `clip_distances` also counts against the limit. Yet `wg_caps.c:300-301` advertises the full
    `4 * maxInterStageShaderVariables` for both stages.
  - A shader within Vulkan's advertised limits can therefore fail pipeline creation.
- **`wg_deserialize` trusts blob counts** (`wg_shader.c:1259-1263`). It checks `pair_count`/`int_pair_count` but not
  `key_pair_count`, and not the `s->info` it `blob_copy_bytes`'d whole. `keyed_text` and `program_create` then loop over
  `info->resource_count`, `pair_count`, `int_pair_count` and `key_pair_count` into fixed 128-entry arrays: an OOB read
  on a corrupt store entry. The UUID covers the build and caps, not corruption.
- **Rounding of 16-bit and packed floats in storage words** (`wgsl_print.c:1072-1086`). `wg_f32_to_f16` rounds half
  away from zero, not to even. `wg_f32_to_ufloat` rounds twice (f32→f16→uf11/10), so a value just under a tie can
  round up. Values past uf11's largest finite (65024) go to infinity. dEQP-VK's image store thresholds probably hide
  it; a wgsl.test.ts row storing 0x3f801000 (an exact f16 tie) to an rg16f word image would show it.
- **The border path with one level drops the sampler's `mipLodBias` from the WebGPU sample** (`float_sample` returns
  before `add_bias` when `border`; `:813-866`), while `inside()`'s mag/min choice uses λ+bias. When mag ≠ min, the
  sample's filter and the border's weight then disagree near the edge.
- **`biased_lod` doesn't clamp `sampler bias + shader bias` to ±maxSamplerLodBias** (Vulkan's λ' formula;
  `wgsl_sampler.c:209-219`). This only matters for shader biases past 15.
- **`wg_compute_based` makes a compute pipeline per distinct base, never evicted** (`wg_shader.c:744-760`), each
  compiled asynchronously with submits held for it. A tiling dispatcher with per-tile bases makes hundreds of them:
  cost, not correctness.

---

### C: Checked and found fine

- **Cube face selection and (s, t)**: `cube_place` matches Vulkan's major-axis table for all six faces.
  - Its derivative of the place on the face, 0.5·(dsc − sc/ma·dma)/ma, is right.
  - `fetched_texel`'s inverse (face, sc, tc) → direction is right for each face, so a texel one past an edge lands
    on the right neighbour texel.
  - Cube arrays' layer·6 + face, and `layers / 6` for size queries.
- **Address modes in `wrap`**:
  - Repeat is floored modulo: NIR's `imod`, printed with the sign fix.
  - Mirror-repeat is `(2n−1) − t` past n.
  - Mirror-once is `−1 − i`, then clamp.
  - Border records outside, then clamps.
  - Offsets are added after the floor and before the wrap.
  - Mirror-once through WebGPU's mirror-repeat, the coordinate clamped to [−1, 1], gives Vulkan's texels at ±1 and
    beyond, for nearest and linear.
- **Texel-centre conventions**: nearest uses floor(u·w); linear and gather use floor(u·w − 0.5) with weights
  frac(u·w − 0.5); the cube texel centre is (i + 0.5)·2/w − 1.
- **Gather order**: (i0 j1), (i1 j1), (i1 j0), (i0 j0), as OpImageGather. Depth gathers compare each texel; the border
  is substituted before the compare.
- **Compare ops**: `compare_of` is Dref OP texel for all eight VkCompareOps. `clamp_dref` applies to unorm depth only.
- **LOD**:
  - λ = ½·log2(max(|dx|², |dy|²)) is Vulkan's ρmax.
  - Order: bias (sampler and shader), clamp to [minLod, maxLod], then the mag/min choice on the clamped λ.
  - The nearest level is ceil(d + ½) − 1 within the view's levels; linear mip is floor, floor + 1, frac.
  - The explicit-LOD and txd paths are right; the sampler bias on txd scales the gradients by 2^bias.
  - `textureQueryLod`: x clamped and level-selected, y biased and unclamped.
  - Keys' infinities are clamped to ±1000.
- **Border colour** (`sampler_border`): missing format components get 0 or 1 first, then the view's mapping is
  applied; depth/stencil is (R, 0, 0, 1); integer textures take integer bits. Custom borders use the view's format
  (`customBorderColorWithoutFormat`).
- **Border blending**: the per-axis footprint `clamp(u + ½)·clamp(w − u + ½)` reproduces Vulkan's linear border at
  both edges and in corners (product form).
- **Integer textures, no key**: the driver's "no key" condition matches `plain_key` (all edge, the LOD range covering
  the view, bias and unnormalized marked emulated).
- **1D textures widened to 2D**: the row's centre 0.5 behaves under every address mode, under unnormalized
  coordinates and in the integer fetch. `widen_1d` handles a LOD query's layerless coordinate.
- **Keys**:
  - `wgsl_sampler_key` has no padding, so memcmp is sound. Keys are zero-filled: the sampler key is memset, padded
    keys are memset.
  - `keys[3·128 + 128]` covers the maximum n.
  - The key carries everything the printed code reads: modes, filters, unnormalized, compare, levels, bias,
    clamps, border, padded size, faces, clamp_dref. Unfilterable views zero the linear flags, matching the nearest
    twin bound.
- **Serialized NIR**: kept before `wgsl_print` mutates it, deserialized fresh per keyed print.
  - `wgsl_print` memsets `info`.
  - The base and variant prints of integer cubes agree on the 2D-array binding.
  - Padded size and level queries answer the image's size, also for texture-only (`WGSL_NO_SAMPLER`) keys.
- **The printer's ALU semantics**:
  - Integer conversions saturate; `imod` is floored, `irem` truncated.
  - Shifts mask the count; extractBits clamps as SPIR-V's undefined cases allow.
  - The unordered float compares, `fcsel`, `fisfinite` and `quantizeToF16` are right; `round` is RNE.
  - Every op without a case fails loudly (`failf`).
- **Storage images as words**:
  - Texel addresses: bytes for texels under a word, words otherwise; the out-of-range sentinel.
  - Under-word stores are atomicAnd + atomicOr. The signed-atomic arrays bitcast; under-word texels are never
    signed (atomics are R32 only).
  - unorm/snorm decode and encode (clamp, round to nearest, snorm's −1 floor), f16 decode (denormals, inf/NaN), the
    11/10-bit float shifts into f16, and pure integers' sign extension.
  - Image atomics on non-R32 and storage images without a format are refused, not silent.
  - Stages that disagree on words or texture are refused.
- **Texel buffers' helpers**: they decode by the type, width and shift parameters; stores write whole words; atomic
  arrays load through atomicLoad.
- **Device addresses**: 2×32 pointers, the low word a byte of binding 996 in group 3. Loads, stores, atomics and swaps
  map to that SSBO; atomics make the array atomic everywhere in the stage.
- **CAS**: compare-exchange loops on spurious failure.
- **Dispatch base**: `gid + base·workgroup_size` and `wid + base`; `num_workgroups` is unchanged; only stages reading
  those ids get overrides, matching the JSON constants.
- **Helper invocations**: `wg_helper || smask == 0` with the mask input declared; `discard` sets `wg_helper`.
- **gl_ClipDistance read in the FS**: the VS writes the FS's moved location (it is printed with the FS's
  varyings, `clip[]` included); components land at `first + i` of the right slot.
- **Vertex pulling** (`pulledCode`, `vertexDecode`): unaligned word reads; per-component word and shift for 8, 16 and
  32 bits; `-bgra`; unorm10-10-10-2; instance vs vertex index; formats gated by `VERTEX_BUFFER_BIT`.
- **`variant_text`'s string rewrites**: buffer sizes and the whole-word match before `rG_T, rG_S,` are right.
- **`program_keys` and `pair_key`**: integer pairs found among gathered pairs, LOD-query pairs added, padded
  texture-only keys skipped where a key exists.
- **`wg_program_variant`**: the faces dimension, layouts rebuilt, and the compute variant module from
  `compute_pairs`.
- **The pipeline cache**: the UUID hashes the build and caps.

## H: The host side and memory 1's layout (web/, core/src/mem.rs)

Scope: `git log 9730e991..HEAD` for web/venus-gpu.ts, web/venus-host.ts, web/gpu-worker.ts, web/gpu.ts, web/ram.ts,
web/vm.ts, web/devices.ts, web/snapshot.ts, web/virgl-host.ts, web/app/machine.ts, web/app/worker.ts, core/src/mem.rs,
core/src/vm.rs, core/src/lib.rs, core/src/boot.rs (mainly VK4 T2, T6 and T19). This was a static review: nothing was
built or run.


### H1. A held Venus submit holds every later fence in the GPU worker, virgl's included (stall; deadlock when the signal depends on another client)

- **Where:** web/gpu-worker.ts:115-119 (`settled`), web/gpu-worker.ts:185-188, web/virgl-host.ts:104-121 (`FenceGate`),
  web/venus-host.ts:285-290 (`VenusRenderer.settled`), web/venus-host.ts:346-355. T6 (157f36fe) made it reachable.
- **The defect:** every fence the device sends to the GPU worker goes through one `FenceGate`, whatever context or
  capset it belongs to: virgl's fenced `SUBMIT_3D`, `RESOURCE_CREATE_3D` and transfers, Venus's fenced submits, and the
  `hold()` of a Venus `CTX_DESTROY` or a blob create or map. Its `settled` closure covers **all** of Venus's
  pending ring-fence keys at that moment (`[...this.pending]`), across contexts and rings, and `release` answers
  fences strictly in order. Since T6, a ring fence that follows a submit held for an unmet timeline wait stays pending
  until the guest signals (vk/README.md "Waits before their signal"). Until then, every later fence of every client
  waits: the compositor's GL fences, other Vulkan programs' fences, and the hold of a `CTX_DESTROY`. On the device side,
  a held virgl fence also holds every reply queued behind it in the in-line `held` queue. Only the ring fence's own reply
  is out of line (`rings`).
- **What triggers it:** program A submits a batch that waits for a timeline value it signals later from the CPU with
  `vkSignalSemaphore` (legal Vulkan; D3D12 fences used through vkd3d do this). The guest's Venus driver sends a ring
  fence after the batch. While A's wait is pending, sway (virgl) renders a frame with a fenced `SUBMIT_3D`. That fence
  sits in `FenceGate` behind A's key, so sway's frame and everything queued after it in the control queue stalls. If A
  signals only after something the compositor produces (a frame callback, a present's release), neither side can make
  progress: the desktop hangs.
- **Before T6:** ring fences retired at the next poll, so a held submit left no key pending.
- **The fix's direction:** a fence's `settled` covers only the pending keys of its own context and ring (a virgl fence
  covers none of Venus's), and `FenceGate` releases fences of different contexts out of order, as the device already
  does for ring fences.
- **Test that would confirm it:** in tests/venus-renderer.test.ts (or a gpu-worker-level test with
  `FenceGate`/`portHost`):
  1. In a Venus context, submit a batch waiting for timeline value 1 with no signal, followed by its ring fence.
  2. Send a virgl context's fenced `SUBMIT_3D`, or a second Venus context's fenced submit.
  3. Assert that the second fence's `fenced` answer arrives before any `vkSignalSemaphore`. Today it arrives only after
     the signal.

### H2. `Mem::ram_pa` gives node 1's first byte the window's end PA (stale JIT code, narrow)

- **Where:** core/src/mem.rs:113-120 (`Spill::holds`), :370-374 (`region`), :446-455 (`ram_pa`), :465-470 (`pa`).
- **The defect:** `region(m, off, 0)` tries the window first, and `holds(off, 0)` accepts `off == window.off +
  window.size` (`end <= size` with `len` 0). For memory 1's offset `spill_at()`, which is node 1's first byte, `ram_pa`
  returns `window.phys + window.size`, the PA right after the window, in the hole before node 1, instead of node 1's
  base. `Mem::pa(h)` uses `ram_pa`, and it has two callers:
  - `Mmu::maint` (core/src/mmu.rs:941-947): `IC IVAU` (interp/sys.rs:284-287) invalidates the page of the wrong PA.
  - The JIT's and block interpreter's block keys (core/src/jit/mod.rs:2110, :2221).
- **What triggers it:** a Vulkan machine with node 1. The kernel or a userspace JIT (Firefox's code pages can be on
  node 1) rewrites code in node 1's first 64 bytes and issues `IC IVAU` on that line alone.
  - Blocks starting at offsets 4–63 of the page are filed under node 1's real page, which isn't dropped: stale
    compiled code runs (guest corruption).
  - A block starting at offset 0 gets a key in the hole: `form` reads no words, so that address never compiles. That
    costs speed, not correctness.
  - Ranges longer than one line also issue `IC IVAU` on line 1 and up, which drops the right page, so they are safe.
- **Fix:** match a region with `off - s.off < s.size` for the zero-length lookup, or try node 1 before the window.
- **Test that would confirm it:** core/src/vm/tests.rs next to line 1323: `assert_eq!(vm.mem.ram_pa(1,
  cfg.spill_at()), node1)` and `assert_eq!(vm.mem.pa(vm.mem.host(node1, 4, Access::Read).unwrap()), node1)`. The
  existing test checks `spill_at() + 0x100`, which misses it.

### H3. Splits checked without Vulkan's reserve fail at boot as "couldn't reserve memory" (machine can't start, misleading message)

- **Where:**
  - web/app/definitions.ts:57: an imported definition's `ramSplit` is checked by `ramSplitError(m.ramSplit)` without
    `m.vulkan`.
  - web/app/main.ts:261: `?split=` is checked without Vulkan.
  - web/app/worker.ts:278: a snapshot header's split is checked by `splitError(ramSize, spill)` with no reserve.
  - web/app/worker.ts:426: a stored record's `ramSplit` is used as it is.
  - The failure: web/vm.ts:774 throws `RangeError("memory 1 holds the window ... past 4 GiB")`, which
    web/app/worker.ts:368 reports as "The browser couldn't reserve N MiB ... Close other tabs, then Retry".
- **What triggers it:** any Vulkan machine whose node 1 is over 2,560 MiB:
  - a definition imported with `vulkan: true` and `ramSplit: [3071, 4096, …]`;
  - a record stored before T19 with Vulkan and its own split (T19 let memory 0 grow and shrank node 1's maximum, so
    such a split is now invalid);
  - `?gpu=vulkan&split=3071,4096`;
  - a snapshot of a non-Vulkan 8 GiB machine (node 1 of 4096) loaded with `?gpu=vulkan`.

  Each time, the machine never starts, and the message sends the user to close tabs.
- **Test that would confirm it:** a unit test that imports such a definition and expects it refused, and that
  `fromHeader` refuses a 4096 MiB node 1 when the slots have Vulkan. The page side could also be checked: with
  `?gpu=vulkan&split=3071,4096`, expect the split refused, not a "memory" failure.

### H4. Snapshot/restore on a Vulkan machine: blob resources and the Venus capset (minor)

- **Where:** web/gpu.ts:966 (`state().resources`), :1004, :1031-1060 (`restore`, `capsets(saved)`).
- **(a) Blob resources:** the snapshot refuses only while a Venus context exists. A blob resource can outlive its
  context: Linux keeps the GEM object while a dma-buf of it lives, for example a WSI image the compositor still holds
  after the program exited. `state()` saves resources without their `blob` field, and the window's bytes aren't saved
  (`spillRam` is node 1 only). After a restore, such a resource is a 0×0 2D resource:
  - `RESOURCE_UNMAP_BLOB` on it answers `ERR_INVALID_RESOURCE_ID`;
  - `blobBytes` restarts at 0;
  - whatever still maps that range of the window reads zeros.
- **(b) The Venus capset:** when the restoring browser's virgl caps differ, `this.capsets = capsets(saved)` rebuilds
  the capsets without `venusCapset()`. A guest that hadn't yet fetched the Venus capset (no Vulkan program ran before
  the snapshot) then can't get it, and Vulkan isn't available after the restore.
- **Test that would confirm it:** tests/devices.test.ts:
  1. Create a Venus context and a mappable blob, map it, then `CTX_DESTROY`.
  2. Snapshot the device (`save`) and `restore` it.
  3. Assert the resource is still a blob (or that the snapshot is refused).

  For (b): restore with different caps and assert that the capset count still includes Venus.

### H: What I checked and found fine

- **The layout:**
  - `VmConfig::spill_at`, `memory_sizes`, `valid_window` and `spill_layout` agree with web/ram.ts `ramLayout`,
    `splitRam` and `splitError`, and with web/vm.ts `memSizes`, `spillAt` and `spillRam`.
  - The arena (0..1,280 MiB) is followed by the window (1,280..1,536 MiB) and then node 1. There is no overlap or gap,
    and `Mem::with_window`'s assertions check it.
  - Memory 1 of exactly 4 GiB (node 1 of 2,560 MiB) is 65,536 pages, which is allowed. No 32-bit overflow on the JS side
    (doubles; `>>> 0` on pointers); virtio and xHCI segment offsets fit u32.
  - The window's guest PA is right after RAM, and node 1 starts at the next 1 GiB boundary after the window, the same
    in TS and Rust.
  - The arena isn't guest-visible: no region maps it, and `locate` covers only RAM.
- **The core:**
  - `host_spill` maps window PAs to memory 1 at `window_at + off`, and node 1 at `spill_at + off`.
  - `acc_ptr` and `region` with `len > 0` are right at the window/node 1 boundary.
  - `with_watch` covers the window in memory 1.
  - Watched write entries for window pages are recorded the same way through spill entries (`Mmu::miss`,
    `fill_watched`).
  - The JIT's `ram1` import limits come from `memory_sizes`, which equals the JS memory's exact size.
  - `boot.rs`'s RAM size no longer subtracts the window, consistent with `Mem::new(ram, ram_size)`.
  - `config_words` doesn't include `window`/`window_at`, but a Vulkan machine differs in its GPU transport's features,
    so cross-restores are refused.
- **Ring fences out of line** (web/gpu.ts:1195-1200):
  - The reply is written at request time.
  - `rings.clear()` on reset, together with `rings.delete(h)`, stops stale completions.
  - Same-ring fences resolve in order, because `FenceGate` answers in order.
  - A ring fence of a destroyed context is released by the `hold()` fence its `CTX_DESTROY` sends (`run` polls on
    each fence).
- **Virtio reset:**
  - The GPU worker drops the backlog and destroys every context: owners, imports and pending keys.
  - Old `FenceGate` entries release at the new guest's first fence, and the device ignores their answers.
  - Each page restart terminates the GPU worker (web/app/main.ts:844-845), so no renderer, memory or WebGPU device
    outlives a machine.
- **Snapshots:**
  - `spillRam` slices node 1 out of memory 1 for writing and restoring.
  - The header's `spill` is node sizes, so `fill` checks like with like.
  - A Venus context refuses the snapshot.
- **`gpu_grow`** (web/venus-gpu.ts:416-426): vkr runs on one thread, so a grow happens between submits. Its copy
  is queued after the held submits' ops, and later submits bind the new buffer.
- **Venus renderer instantiation:** `venus_arena_end` is checked against `VENUS_ARENA`, the module imports
  `--max-memory=4 GiB` with no larger minimum, and the write-watch's words are read from memory 0 (`window.core`).
