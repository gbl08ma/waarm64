# Static review: the M4's green VA-API chroma under Venus (`?gpu=vkformats=all`)

A read-only review of main at `2f229f0`. No code was changed, and nothing was built or run: the cloud container can't
run the Mac or this GPU path. It follows a decoded picture end to end:

1. the guest's VA driver (images/arch/webpc-va/);
2. the virgl video path (web/virgl-video.ts, web/virgl-renderer.ts `writePicture`) and the call queue
   (web/virgl-host.ts);
3. the import into Venus (web/gpu.ts `CTX_ATTACH_RESOURCE`, web/venus-host.ts, vkr's patch, web/venus-import.ts);
4. the driver: vk/driver/, and web/venus-gpu.ts, its WebGPU side, including held submits, uploads of host-visible
   memory, completions, descriptors and pipelines;
5. the host-visible window's write-watch (core/src/mem.rs, core/src/mmu.rs, web/window.ts), since the uploads depend
   on it.

libplacebo's own sources (videolan master, read for reference only) were used to confirm which Vulkan operations its
advanced path issues.

**Bottom line.**
- **No smoking gun.** No defect found here certainly produces chroma = 0 that persists through a re-render while the
  import's bytes are right (the facts L4 measured).
- **What fits.** The symptom fits a chroma-only object that is made once from host-visible memory and never written
  again. Under the advanced path that is libplacebo's chroma-scaler LUT: `sh_lut` → `pl_tex_create(.initial_data)` →
  `pl_tex_upload_pbo` → a `host_writable` buffer, a `memcpy` into mapped memory, then `vkCmdCopyBufferToImage`
  (libplacebo `src/shaders/lut.c` ~505, `src/gpu/utils.c` `pl_tex_upload_pbo`, `src/vulkan/gpu_buf.c`
  `vk_buf_write`). It also fits a pass whose output stays at the zero a DONT_CARE load leaves.
- **What the review found.** Two real defects can lose the LUT's bytes silently and timing-dependently (findings 1 and
  2). One real defect makes a pass silently draw nothing (finding 4). A set of real ordering bugs sits on the import
  path (finding 3), but those heal at the next picture.
- **Other defects.** Each finding below says how well it fits. "Other real defects" lists what is real but unrelated
  to this symptom.

Ranked by how likely each is to cause the symptom.

---

## 1. The window's dirty pages are global, but each Venus device uploads only its own memories (and completions are matched by a per-device serial)

**Where**
- vk/driver/wg_cmd.c:1813-1856 `upload()`
- web/venus-gpu.ts:677 `dirtyInto` → web/venus-host.ts:202 `dirty()` → web/window.ts:34 `take()`
- vk/driver/wg_cmd.c:1891 `s->serial = ++dev->serial` and 1991 `if (s->serial != serial)` in `wg_complete`

**Defect**
- There is one write-watch for the whole window, shared by every Venus context and device. `take()` clears it
  (`Atomics.exchange`).
- `upload(dev)` takes the pages and applies them only to `dev->host_memories`. The pages of every other device's
  memories are dropped. If the device has no in-window memory, line 1854 takes the whole set and throws it away.
- Separately, submit serials are counted per device, but `wg_complete(serial)` completes the first pending submit with
  that serial on *any* device. With two devices it applies one device's completion writes and readbacks (the latter
  with the other device's readback slot) and signals its fences early.

**Trigger (needs two `wg_device`s alive)**
1. Process or device A (mpv's libplacebo) `memcpy`s its LUT into a mapped slab and records the copy.
2. Device B submits anything, and its `upload` takes A's pages.
3. A's `vkQueueSubmit` then takes an empty set. A's GPU buffer keeps zeros for those pages. The LUT texture is copied
   from zeros, made once, and never rewritten, so the chroma scaler outputs 0 for good.

It is timing-dependent: it depends on how two devices' submits interleave with A's writes. It is independent of the
data. It is silent: no WebGPU error, and the worker's calls are the same in kind and number.

**Fit**
- Strong, if a second device exists during the first mpv run.
- This is unverified. Candidates:
  - another Vulkan client on the desktop (a probe, `vulkaninfo`, a portal);
  - a second `VkInstance`/`VkDevice` that mpv or FFmpeg creates while setting up hwdec or the GPU context;
  - the previous mpv's context still tearing down, which explains later runs, not the first.
- Every later look is fine, which fits "later runs are right" if the extra device only exists at the session's
  first Vulkan start.

**Confirm**
- Cheapest: log `venus_context_create`/`vctx` and `wg_device_register(add)` with timestamps (in memory, dumped at the
  grab hook) in green and right sessions. More than one device alive while mpv's first frames are made is the tell.
  The render stats' `venus.contexts` already counts contexts.
- Deterministic test (tests/venus-driver.test.ts style, two devices in `wg_test.c`): A maps host-visible memory and
  writes a pattern without submitting; B submits an empty command buffer; A copies the buffer to a readback buffer
  and checks it. It fails today.
- **Fix:** keep the pages in a renderer-wide pending bitmap that `take()` ORs into, and clear a page only once each
  memory over it has uploaded it (or dispatch each take's pages to every device's memories). Make serials global, or
  pass the device with them.

## 2. A dirty page's upload overwrites GPU-written bytes of an in-flight submit (and completions overwrite whole ranges)

**Where**
- vk/driver/wg_cmd.c:1840-1851 (`upload`'s page runs), 1993-2004 (`wg_complete`'s `cpu_write`s and `readback`s)
- `readback()` at wg_cmd.c:1309 is widened to 4 bytes and merged, and storage bindings are read back whole (1486)
- `linear_images(load)` at 1904 reloads every linear host-visible image from memory before each submit

**Defect**
- An upload is whole pages of the CPU's view.
- Suppose a page holds both a range that an earlier, still-pending submit writes on the GPU (a buffer copied into, a
  storage buffer, a fill or update, Venus's feedback slots) and bytes the guest has just written.
- The next submit's `queue.writeBuffer` then puts the CPU's stale copy of the GPU-written range back onto the GPU
  buffer. The CPU copy is corrected at the earlier submit's completion; the GPU buffer never is, because the host's
  write isn't a guest write.

**Trigger**
1. Submit 1 writes range R of host-visible memory on the GPU.
2. Before it completes, the guest writes elsewhere on R's page and submits 2.
3. Submit 2, or any later one, reads R on the GPU and sees stale bytes.

The reverse also happens: a completion's readback of a whole storage range overwrites CPU writes made since.
Timing-dependent and silent.

**Fit**
- Medium-low. It needs GPU→host-visible→GPU reuse within one page.
- libplacebo slab-allocates many buffers into one memory, so a staging slice and something written by the GPU can
  share a page. On the first frame, when LUTs, uniform buffers and the probe's downloads are all fresh, that is most
  likely.
- L4's "completions put back nothing the CPU wrote" covers the reverse direction, not this one.

**Confirm**
- Count submits where a page `upload` sends overlaps a pending readback or `cpu_write` range of an earlier submit not
  yet completed. In memory, dumped at the grab hook; compare green and right sessions.
- Test: wg_test.c submits a copy into host-visible buffer range R and, before completion, writes the other half of
  R's page and submits a copy of R into another buffer. The second copy reads stale bytes.

## 3. The import path's ordering: `vaSyncSurface` waits for nothing, and `forget` isn't ordered with `bind`/`plane`

**3a. The import can run before its picture is in the plane**
- **Where:** web/venus-import.ts:11-13 and vk/README.md "Imports" (the claim), web/venus-import.ts:62-66 (the
  readback), web/virgl-host.ts:288-291 (`fence`: `go = !waits`).
- **Defect:** The stated guarantee, "mpv syncs a surface (`vaSyncSurface`: a virgl fence, which the call queue answers
  only once its picture is written)", is false. docs/plans/video.md:149 says Mesa's virgl `end_frame` makes no fence,
  so `vaSyncSurface` returns at once. The call queue holds a fence only behind calls that are themselves waiting,
  never behind a pending picture alone. The Venus ring (vkAllocateMemory with the import, vkBindImageMemory →
  `gpu_texture_import`) is polled from shared memory and isn't in the queue at all.
- **Trigger:**
  1. END_FRAME runs and the picture sits in WebCodecs.
  2. mpv exports and imports the surface. If no virgl call of that context waits in between, the attach (`blob-ctx`)
     isn't held either.
  3. The resource's first `bind` reads the virgl texture back before the picture lands: zeros for a fresh surface,
     the previous picture for a reused one.
  4. That goes into `last` and into the texture. The draw already queued samples it. `plane()` writes the picture
     afterwards.
- **Fit:** low for this symptom. It hits whichever plane binds before the picture lands, which is luma rather than
  chroma since libplacebo imports luma first. It heals at a re-render, because `plane()` replaces `last` and the
  texture, and the green doesn't. In the first run every surface is fresh and everything is slow, so it is likelier
  there.
- **Confirm:** in `bind`, count (in memory) binds where `renderer.videoPending.res(res)` is true and where `last` came
  from a readback.
- **Fix:** skip the readback for a pending resource and leave the texture to `plane()`. Correct the comment and the
  README.

**3b. `forget` runs at once while `bind` and `plane` are deferred**
- **Where:**
  - web/gpu-worker.ts:212 `if (c.t === 'unref') imports?.forget(c.id)`, which runs at once;
  - web/gpu-worker.ts:158 and web/venus-gpu.ts:322-324, where `plane` and `bind` go through `VenusGpu.later`, held
    behind submits waiting for async pipelines (the first run: a cold Dawn/Metal cache);
  - web/venus-import.ts:73 and 83-85.
- **Triggers:**
  - (i) A held `bind(T, R)` runs after R was unref'd and its id reused. Linux's virtio-gpu takes the lowest free id,
    and mpv's hwdec probe surfaces are made and destroyed just before the decoder's. `read()` then reads the new
    resource's texture into `last[R]`.
  - (ii) R gets a picture whose `plane` op is deferred, then R is unref'd, so `forget` deletes `last[R]`. The
    deferred `plane()` still passes line 73, because `textures` keeps R until the deferred `bind(T, 0)` runs. It
    re-creates `last[R]` for a dead resource.
  - The next resource with id R binds those stale bytes. If its bpp differs (an R8 luma reusing an RG8 chroma's id,
    or a P010 probe surface's R16), `write` warns and returns (line 100), and that texture stays zero until the next
    picture.
- **Fit:** low. It is per plane and first-run-flavoured, but it heals at the resource's next picture or a re-render.
- **Confirm:** `?gpu=vkpipelines=sync` removes the deferral (lead 3 in the handover). Count bpp-mismatch writes and
  binds whose `resourceInfo(res)` is undefined.
- **Fix:** route `forget` through `later`, and drop R from `textures` there too.

**3c.** The `blob-ctx` attach goes through the call queue's default case, so it can be held behind waiting calls,
while the ring's `vkAllocateMemory` that imports it is polled. If the ring gets there first, vkr has no resource:
the import fails or the context is lost. That gives a failure, not a green picture.
(web/virgl-host.ts:283-286, web/venus-host.ts:309-316.)

## 4. A draw silently loses its fragment stage when its stages' programs differ, and program links hash struct padding

**Where**
- vk/driver/wg_cmd.c:681 `k.fs = fs && fs->program == base ? fs : NULL` → vk/driver/wg_shader.c:815 (no `fragment` in
  the pipeline)
- wg_shader.c:359-375 `program_link` hashes the raw `program_write` blob, which includes `resources[]`
- vk/compiler/wgsl.h:65-77 `struct wgsl_resource` has padding (after `group`, after `access`)
- its copies are built by compound-literal and struct assignment (vk/compiler/wgsl_print.c:204, 573;
  wg_shader.c:286)

**Defect**
- A stage found in a cache carries the link stored at its first compile (wg_shader.c:572-582). Its freshly compiled
  partner gets a link computed now (508-510). They share a program only if the two hashes match byte for byte.
- Indeterminate padding bytes can make equal programs hash differently.
- When the links differ, the draw is recorded with no fragment shader. Nothing is logged, and the pass writes
  nothing. Under libplacebo's DONT_CARE load, which the driver maps to `clear` (finding 6), the FBO is 0. A chroma
  FBO of zeros is exactly this symptom, and it persists because the pipeline is cached.

**Trigger:** a partial cache hit: one stage of a linked pair found in Mesa's `vk_pipeline_cache` or our store, the
other compiled. Mesa's per-stage keys hash the whole partition (Mesa 26.2 runtime/vk_pipeline.c ~1570-1605), so this
takes an eviction (the store's 32 MiB LRU) or a lost entry.

**Fit:** low for green.sh's sessions: guest-session.ts uses a fresh profile, so the store starts empty and a partial
hit is unlikely. It is still a real, silent, persistent defect, and on a user's kept profile it would look exactly
like this.

**Confirm:** warn and count in `record_draw` when `fs && fs->program != vs->program`. A/B with `?gpu=vkcache=off`.

**Fix:** zero the resource structs before filling them (`memset`, or hash the fields one by one). Fail loudly, or
recompile both stages, when the programs differ.

## 5. A page-crossing store can mark its first page before writing it (core)

**Where:** core/src/mmu.rs:862-868 `span`, 273-276 `fill_watched`, 289-299 `unwatch`, 896-910 `write_el`.

**Defect**
- `span` translates both pages before writing either.
- If the second page's translation misses while the vCPU already holds 64 watched records, `fill_watched` first runs
  `unwatch`. That marks every recorded page, including the first page just translated, and drops its entry.
- The first page's bytes are then stored through a pointer with no live record.

**Trigger**
- A host `take()` swaps the bitmap and uploads between that mark and the store. The page is reported with its old
  bytes in look g and not reported in g+1.
- Reachable by an unaligned memcpy tail after touching 64 window pages in a chunk, including the interpreter's STR Q,
  which `ldst_fp.rs:20` splits into two 8-byte writes.

**Fit:** very low. The window is nanoseconds wide, against a ~1/3 rate.

**Confirm:** an mmu unit test that fills 63 window pages, makes a page-crossing write to two new ones, and checks the
first page's mark comes after its write, through a seam between the two `host()` calls.

**Fix:** translate the second page first, or don't flush on overflow inside `span`.

**Coverage gaps the write-watch tests leave** (tests/baremetal/watch.c, tests/window-watch.test.ts):
- one writing vCPU, and every look taken with the guest parked, so the ack/running handshake against JIT code that is
  still running is never exercised in wasm;
- no phase over 64 pages, so the overflow path is untested;
- no STP Q, ST1-ST4, DC ZVA, STTR, CASP/STXP or STLR stores;
- no two devices sharing the watch (finding 1).

The JIT's inline paths, the flushes, the run loops' `catch_up`/`leave` and the memory ordering were traced and found
correct.

## 6. The load-op mapping loses data outside the render area, and with LOAD_OP_NONE

**Where:** vk/driver/wg_cmd.c:412-421, 467-478 (depth and stencil 505-518).

**Defect**
- `load_op` maps everything but LOAD to `"clear"`. That includes `VK_ATTACHMENT_LOAD_OP_NONE`, which must preserve
  contents.
- With a partial render area only CLEAR is redirected to `clearRects`. DONT_CARE still clears the whole attachment,
  where Vulkan preserves what's outside the render area.
- `STORE_OP_DONT_CARE` maps to `"discard"`, which Dawn zeroes lazily. That is legal, but it is another way a
  mis-ordered pass becomes zeros rather than stale data.

**Fit:** indirect. libplacebo uses LOAD or DONT_CARE plus STORE over the full area (libplacebo
`src/vulkan/gpu_pass.c` 551, 957), so this doesn't drop data for it. It is what turns finding 4's silent missing
fragment stage into exact zeros.

**Confirm:** log passes whose loadOp is neither LOAD nor CLEAR with a render area short of the attachment.

**Fix:** NONE → `"load"`; partial DONT_CARE → `"load"`.

---

## Other real defects (not this symptom)

- **The unaligned buffer copy invalidates the submit.** vk/driver/wg_cmd.c:1728-1736 with web/venus-gpu.ts:372-378
  `gpu_update`:
  - a `vkCmdCopyBuffer` with an unaligned offset or size becomes a `copyBufferToBuffer` at the unaligned `dst_offset`;
    WebGPU wants 4, so the whole command buffer is invalid and the submit is dropped;
  - with an aligned destination it still writes the 1-3 padding bytes past the copy;
  - a device-local source is silently skipped;
  - a host-visible source is copied from the CPU's bytes at replay, missing GPU writes from earlier in the same or an
    in-flight submit.
- **Storage access WebGPU refuses.** wg_format.c advertises `STORAGE_IMAGE` for formats that WebGPU allows only
  write-only or read-only: rg16float/r16float (tier1), rg32float, bgra8unorm, and others unless tier2.
  - A shader that loads and stores such an image prints `read_write` (vk/compiler/wgsl_print.c:566), so the module and
    pipeline are invalid and the submit is dropped (logged).
  - `program_create` ORs access across stages (wg_shader.c:291-293) into one layout entry, while each module declares
    its own access.
  - This is reachable only with `vkformats=all`'s tier1 storage, so it is worth a log check in green sessions, though
    L4 saw no errors.
- **Clears and blits assume a renderable format.** `clear_image` (wg_cmd.c ~1091) and the worker's `meta` clear draw
  into the image, but `wg_texture_create` adds `RENDER_ATTACHMENT` only for renderable formats (wg_device.c:797), so
  a `vkCmdClearColorImage` of a non-renderable format invalidates the submit. A blit or resolve from a 3D image binds
  a 3D view to `texture_2d` (web/venus-gpu.ts `viewOf` and `meta`).
- **Push-constant buffer wrap.** wg_cmd.c:1527-1533 resets `push_used` to 0 in mid-submit. The buffer is written once
  at the end, so earlier draws read later draws' push constants. That takes past 4096 changes in one submit and logs
  once to stderr.
- **The bind-group cache key ignores the set's index.** With one set in group 3, the key is (holder, layout uid,
  version), so the same set bound at another index (`set_base`) reuses a group built for the first position
  (wg_cmd.c ~1390-1405).
- **A failed create leaves a stale object.** `gpu_create` that throws keeps the previous object under a reused id
  (web/venus-gpu.ts:744-815; `guarded` swallows the exception), so later commands act on the wrong object. Set
  `objs[id] = undefined` (or an error object) before creating.
- **Storage writes don't count as writes for presentation.** `touched` (web/venus-gpu.ts:346, 362, 412, 844) covers
  attachments, copies and blits but not storage writes from compute or fragment shaders. A WSI image written by a
  compute pass (libplacebo can, when the swapchain is storable) isn't marked written, and venus-share skips the copy.
- **The import maps outlive resets.** `last` and `textures` survive `renderer.reset()`/`load` and the `blob-unref`
  path (web/gpu-worker.ts:172-176), which never call `imports.forget`, and `forget` never prunes `textures`. After a
  reset or restore, a reused id gets stale bytes, and pictures for it are written into dead textures.
- **The last bytes of an odd-sized memory are never uploaded.** `upload` and the full uploads use
  `mem->vk.size & ~3` (wg_cmd.c:1826, 1835, 1850), so a memory whose `allocationSize` isn't a multiple of 4 never
  uploads its last 1-3 bytes.
- **Suspended and resumed passes.** `wg_CmdBeginRendering` ignores `VK_RENDERING_SUSPENDING/RESUMING_BIT`, so a
  resumed pass re-applies its clear.

## Checked and found fine (one line each)

- `later` is FIFO. A held batch's ops, the import's `bind` and `plane`, `gpu_write`'s copies, and the push-buffer
  write keep queue order. Ids and memory are snapshotted at the call. Temporaries are destroyed after their own
  submit, and `drain` keeps submit order.
- `RESOURCE_MAP_BLOB`: the device holds the reply behind a GPU-worker fence (`hold()`), so the guest can't write the
  window before vkr's map copies the storage in.
- `wg_memory_buffer` is made at `vkBindBufferMemory` and sets `dirty`, and `wg_memory_rebind` sets `dirty`, so
  new and moved memories are uploaded whole.
- Push descriptors get a new set per push, and every write, copy and template bumps the set's version.
- `viewOf` caches by `GPUTexture` object, so reused ids can't alias.
- `copy_bt`/`copy_bt_replay` row splitting, 1D as 2D, and block rounding are right.
- Sizes are consistent through `writePicture`/`padPlane`/`VenusImport.write`/`readResource`, the device's
  `blob-ctx` size and webpc-va's exported chroma size.
- The JIT's store paths (every size, pairs, SIMD, DC ZVA, atomics) only write through recorded write entries or the
  helper.

## Suggested order of experiments

All counters are kept in memory and dumped at the grab hook. L4 showed `console.log` in the hot path hides the green.

1. Count Venus devices and contexts alive during the first mpv run, green against right (finding 1). If two, the
   two-device wg_test.c case should reproduce a missed upload deterministically.
2. In a green session, copy the chroma scaler's LUT texture and the chroma FBO back once, after the frame shows,
   outside the hot path. Zero LUT means findings 1 or 2. Right LUT with zero FBO means finding 4 or a pass-level
   problem. Also copy the imported chroma texture back to split finding 3 from the rest.
3. The overlap counter for finding 2, and the `fs->program != vs->program` counter for finding 4: both silent today.
4. `?gpu=vkpipelines=sync` against bare (finding 3b), keeping to the method's 12-session counts.
