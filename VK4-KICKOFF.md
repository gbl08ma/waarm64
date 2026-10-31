**Approved by the user (2026-10-29).** Drafted by the session that closed VK3. Covers **VK4** of the Vulkan plan
([docs/plans/graphics.md](docs/plans/graphics.md) §3), M8's graphics track; how Vulkan works now is
[docs/graphics.md](docs/graphics.md) "Vulkan through Venus".

## How VK4 runs: tasks the user starts

No supervisor and no loops. VK4 is a list of **tasks** (below, in the order proposed). Each is one well-defined goal
with its scope, what counts as done and where to start; the user starts each in a session of its own ("do VK4
task T3"), in any order, several at once where they don't touch the same files. A task:
- reads this file, CLAUDE.md, and the docs its "Start" names; nothing else carries context between tasks.
- starts with its confirming test, failing first (a dEQP-VK case, a unit test, or a measurement for a performance
  task), and ends with **one commit or a few**, rebased onto origin/main and pushed: the fix, its tests, its dEQP-VK
  cases added to `tests/deqp/vk.txt`, the docs it changes, and its row below marked done with a line of outcome
  (numbers, what's left). What it leaves goes to docs/backlog.md, not here.
- runs `scripts/ci.sh` and `scripts/ci-deqp-vk.sh` (and the CI scripts its area names in CLAUDE.md) before it's done.
- that outgrows one session leaves a short `VK4-HANDOVER.md` section under its id (state, next step), deleted when
  it's done.
- that needs NVIDIA adds a step to `bench/vulkan/nvidia.sh` (`VK2_STEPS=<task>`); the user's runs are batched as
  before (a bundle built from a clean checkout; a fix aimed at NVIDIA ships with a check at run time and a fallback).

Out-of-context reviews (CLAUDE.md) stay: the user starts one after every ~3 tasks that add code, and at the end.

## Decisions (binding)

Plan §1 (the bar) and §2 bind: route (b), one renderer module on memory 0, vkr on one thread, the caps from the
adapter, Vulkan a per-machine setting off by default, API 1.3 advertised, correct before fast and never a black
screen, YCbCr's GTK4 rule. **What the device advertises must work**: a feature or format VK4 can't back is taken off
the advertised set (guest-visible, pre-approved) rather than left failing.

## How the tasks are ranked

By **what the guest's programs meet**, weighted by the consequence: a crash or a lost device first, then a draw or
submit dropped (WebGPU refuses it: nothing drawn), then wrong pixels, then a missing feature that isn't advertised.
An advertised feature that doesn't work counts as non-compliance whatever its use. Performance tasks are ranked by
the long, real workloads (CLAUDE.md "Performance"). The counts behind the backlog's dEQP-VK causes are VK2 L5's
samples (~20,000 cases), from before VK3's ~3,300 new passes, so **T1 measures them again first** and may reorder
T2–T14; the rest of the order is judgement, said with each.

## The tasks

### Tier 1: measure, then what crashes or drops work

- **T1. A census of dEQP-VK** (S). The whole mustpass list sampled (a stride over `vk-main.txt`, ~10–20 k cases, on
  SwiftShader; the same sample on the M4 through `bench/gpu/sway-mac.sh`), every not-passed case classed by cause
  against the backlog's "The Vulkan driver's gaps" (dEQP's messages through `DETAIL`, WebGPU's warnings), committed
  as a ranked table in bench/vulkan/REPORT.md. *Done:* counts per cause, cases that now pass added to the list,
  this list re-ranked. *Start:* docs/testing.md "dEQP", `bench/gpu/deqp-run.ts`. **Done 2026-10-29** (REPORT.md "VK4
  T1"): every 100th case (16,489) on SwiftShader and the M4; 17.0% and 16.5% of the supported cases don't pass, 499
  and 542 of 500 and 545 classed (`bench/vulkan/census.ts`); the list 4,725 → 7,126. The samplers' causes are two
  fifths of the failures (T8, with component swizzles added), compressed images padded to whole blocks a fifth (new:
  T18), copies between formats the most dropped work (T10). It can't count T3, T4, T6 and T7 (their groups aren't in
  `vk-main.txt`): they keep their programs' ranks. **The order after T1**: T2, T3, T10, T5, T4, T6; T8, T18, T7, T9,
  T11, T12; then tier 3 as it stands. Of the features not advertised, a compute-only queue family is what dEQP-VK
  asks most (18% of the not-supported cases; backlog "Not advertised, by what dEQP-VK asks").
- **T2. The renderer's robustness** (M): what takes Vulkan down for the guest. `memory.allocation.random.*` and
  `memory.mapping.suballocation.random.*` crash deqp-vk after enough earlier cases (something the renderer keeps:
  the arena's high-water mark is now measured, `heapUse`); vkr's `vkFreeMemory resulted in CS error`;
  `compute.pipeline.zero_initialize_workgroup_memory.max_workgroup_memory.*`; NVIDIA's one-off trap in
  `wg_complete`; **Venus's contexts outliving a virtio reset** (a guest reboot meets the old rings); T1's two crashes
  (`api.info.image_format_properties2.2d.optimal.r12x4_unorm_pack16`,
  `api.external.memory.opaque_fd.dedicated.device_only.dup2`, on both hosts). *Done:* each
  reproduced and fixed, or bounded with a test; the crashing groups in the list. *Start:* backlog "Memory",
  "Compute", "A trap in the module's completion", "Venus's contexts outlive a virtio reset". **Done 2026-10-30** (REPORT.md "VK4 T2", "VK4 T19"): a dead context's objects are destroyed in the driver (they
  leaked: a 17th device failed, the cause of the "crashes after earlier cases"); the guest's export imported again
  aliases its memory (every supported `api.external.memory` case passes; was fatal); a sync freed while a submit names
  it is dropped (likely NVIDIA's `wg_complete` trap: confirm in the next NVIDIA run); a virtio reset ends Venus's
  contexts; the memory budget filled; `max_workgroup_memory` was SwiftShader's 17 s compile of Vulkan's zero-init
  (dEQP-VK's runs use Tint's); `r12x4` is 34 s of synchronous queries past dEQP's watchdog (T13). Once T19 gave the
  arena room, host-visible memory got a 1 GiB heap of its own, which the arena backs, and `memory.*.random` (300, 242
  MiB at their peak) joined the list: 7,126 → 7,509. Left (backlog "Memory"): an allocation past the arena still loses
  the context rather than failing.
- **T3. Usage scopes** (L): the driver binds a `VkDeviceMemory` as one GPUBuffer, so a pass or dispatch that reads
  and writes storage of one memory through different bindings fails WebGPU's validation and is dropped. Every
  sub-allocating program meets it (VMA: most engines, DXVK, vkd3d) once its shaders write storage. The fix: a
  GPUBuffer per binding (or per `VkBuffer`) over the same bytes, with copies where they alias. *Done:* a test of
  each conflicting shape (the backlog lists them), dEQP-VK's failing cases of that cause, a real sub-allocating
  program's frame (a VMA sample in the guest, or vkd3d's tests), the copies' cost measured on the scene. *Start:*
  backlog "Usage scopes", graphics.md "Known limits". **Done 2026-10-30** (REPORT.md "VK4 T3"): the replay scans each scope (a render
  pass to its end, a dispatch) and copies its reads of a GPUBuffer it binds writable (uniform, read-only storage, texel,
  vertex, index, indirect) into a shadow buffer, each buffer's ranges merged; a dispatch's disjoint read-only storage
  still bound writable, an overlapping one copied. Every shape a test (10, failing first with WebGPU's errors). No
  dEQP-VK case of the direct set meets it (32,607 cases of its likeliest groups: none logged a usage-scope error), nor
  vkd3d's 175 tests (dedicated memory per resource); both the same after. VK0's scene, which writes no storage, the
  same (three alternated rounds overlapping). Left (backlog "Usage scopes' leftovers"): two writable bindings of one
  range; a draw reading what an earlier draw of its pass wrote; a program that meets it, to measure the copies on.
- **T4. Views in another format** (M–L): a mutable image viewed in a format other than its sRGB twin gets an invalid
  view and its submit is dropped (ffmpeg's and libplacebo's filters, DXVK alias formats this way), and YCbCr's plane
  views of another format of their class (66 cases) have the same root. A texture per view format with copies
  between them, or aliasing through a storage buffer. *Done:* `image.mutable.*` and the plane views in the lists.
  *Start:* backlog "Rendering" (the mutable images), "YCbCr's gaps". **Done 2026-10-30** (REPORT.md "VK4 T4"): a texture per
  view format, the replay copying each subresource where it is used in a texture that doesn't hold it; `EXTENDED_USAGE`
  and sampled images' sample counts in the image-format query. `image.mutable` 3,198 pass, on SwiftShader and the M4
  (the 66 plane views among them), the lists 9,602 → 12,733 and 773 → 839; the 445 failures left are multisampled (380
  arrays, 62 formats WebGPU can't multisample, 3 twin resolves not understood). Left: backlog "Views in another
  format's leftovers"; the copies' cost unmeasured.
- **T5. Vertex strides and offsets that aren't multiples of 4** (M): WebGPU refuses them, which invalidates the
  pipeline and drops its submit (vkd3d's test_instance_id; Direct3D content through vkd3d and DXVK uses such
  layouts). Vertex pulling from a storage buffer for the attributes WebGPU can't take. *Done:* the dEQP-VK cases,
  test_instance_id's stride rows. *Start:* backlog "Formats", "vkd3d on Venus". **Done 2026-10-30** (REPORT.md "VK4 T5"): such a binding is read by the vertex
  stage from a read-only storage binding, in a free bind group; the 1,002 `vertex_input` cases that failed pass on
  SwiftShader and the M4, the list 8,600 → 9,602; test_instance_id 84 → 24 of 372 (those seen divisors). Left (backlog
  "Pulled vertices' leftovers"): a program with no group free stays refused; the cost unmeasured.
- **T6. Synchronization's failures** (S–M): `synchronization*.timeline_semaphore.device_host.*` fails 41 of 110
  ("Memory contents don't match"): a host thread copying between iterations through a timeline semaphore, likely
  a real ordering bug. *Done:* the cause, a test, the group in the list. *Start:* backlog "Synchronization". **Done 2026-10-30** (REPORT.md "VK4 T6"): a
  timeline semaphore in the guest is signalled by the ring fence sent after its batch, and those fences went ahead of
  held submits, so a value read as reached before its batch ran (the group's other cases pass with their data all
  zeros). Fences now hold with the rest, and the device answers them out of line, which is what the old hang needed.
  `device_host`'s 202 failures to 0, 576 cases of the group and its neighbours, the list 12,733 → 13,217. Left (backlog
  "Synchronization"): 16 held submits from the thread that signals them fill the control queue.

- **T19. The renderer out of memory 0** (L; added 2026-10-29 by the user, next): Vulkan takes 511 MiB of memory 0
  (the 256 MiB window and the renderer's 255 MiB arena), so a machine with Vulkan has 2,560 MiB of fast RAM against
  3,071 without, and the arena is too small to back a host-visible heap programs accept (~1 GiB: T2). The goal: Vulkan
  costs memory 0 no RAM, and host-visible memory has an arena that backs a heap of ~1 GiB or more. The renderer is C
  for wasm32 (Mesa, vkr: one linear memory) and reads Venus's rings and command streams in the window in place, so
  the window and the arena go together; the guest writes every Vulkan command into the window, so where the window
  lives decides what its writes cost. **Measure first, then choose**, by the guest's cost on Venus's frame workloads
  (vkcube, mpv on Vulkan, GTK4 on Vulkan: bench/run.ts rules) and memory 0's RAM:
  (a) the window and the arena in the renderer's own wasm32 memory, reached by the guest through a JIT arm as spill
  memory 1 is (every Vulkan machine's commands then take that path, not only NUMA machines'); (b) as (a), with all
  spill RAM in one memory64 behind a generic arm (none through the interpreter); (c) memory 0 as memory64 (a wasm64
  core, an i64 ABI; the renderer off memory 0 anyway); others the measurements suggest. With M0.5's kernels re-run for
  memory64 on the current Chromium (backlog "Re-measure memory64 against the alternatives"). *Done:* memory 0's RAM
  with Vulkan as without, a host-visible heap the arena backs (then T2's random groups in the list), the chosen
  layout's cost on the workloads measured against today's. *Start:* docs/devices.md "The host-visible window",
  docs/spill-memories.md, docs/architecture.md "Guest memory: layout A", bench/spike/memory/REPORT.md, vk/README.md
  "The build", web/ram.ts, web/vm.ts `bootVm`. **Done 2026-10-30** (bench/spike/memory/REPORT.md §6, REPORT.md "VK4 T19"): memory64 measured first: V8 checks
  each memory64 access, ~+15–20% on the userspace benchmark on macOS (`--wasm-enforce-bounds-checks` as the stand-in),
  and the user set (b) and (c) aside. Built (a′): memory 1 is the renderer's own, an arena of 1,280 MiB, then the window
  (`VmConfig.window_at`, ABI 55), then node 1's RAM, reached through the existing memory-1 arm; memory 0 holds 3,071
  MiB with Vulkan as without (was 2,560), node 1 at most 2,560. On the Mac against the old layout: vkcube the same, mpv
  decoding in software +7.5% of its CPU, fishbowl within its spread. Host-visible memory's 1 GiB heap is the arena's
  (T2 closed with it).

### Tier 2: what's advertised and missing (API 1.3), and wrong pixels programs meet

- **T7. API 1.3's required features** (each S–M; L for addresses), one task each, in this order: **image and texel
  buffer atomics on R32** (compute programs and libplacebo use them; the translator refuses them today: storage
  images or texel buffers as storage buffers of words, atomics on those), **inline uniform blocks** (data in the
  set: a uniform buffer the driver writes), **multiview** (a pass per view, or layered rendering), **buffer device
  addresses** (pointers into GPUBuffers: one big storage buffer and offsets, or per-buffer bindings by address; the
  hardest, and DXVK and vkd3d need it). *Done:* each feature's dEQP-VK groups in the list. *Start:* backlog "API
  1.3's required features". **Done 2026-10-31** (REPORT.md "VK4 T7"): atomics on R32 through the image's words in a buffer, tracked
  with T4's textures (705 of 705); inline uniform blocks as a uniform buffer of the set's; multiview as a pass per view (547
  pass, the 48 failures multisampled arrays, T12's); device addresses as bytes of one GPUBuffer that grows in place, a
  pointer two 32-bit words, a writable descriptor beside pointers in a shadow copied back; `scalarBlockLayout` with them (1,811
  pass, 0 fail). All 1,735 new cases pass on the M4; the list 17,208 → 18,943. Left: backlog "Device addresses' leftovers"
  (`shaderInt64`, memory past one storage binding, the copies' cost on a program).
- **T8. Samplers** (M; T1: 203 of SwiftShader's 500 failures): border colours (shadow maps), mirror-once,
  unnormalized coordinates, the sampler's LOD bias and min/max LOD, integer textures' address modes and their min/max
  LOD (fetched today: clamp-to-edge whatever the sampler says), integer cube textures (the stage refused: 31),
  **component swizzles** (ignored today; Vulkan requires them: 55). In the shader where WebGPU's sampler can't. *Done:* `texture.*` and `glsl.texture_functions.*`
  cases of those causes in the list. *Start:* backlog "Samplers". **Done 2026-10-31** (REPORT.md "VK4 T8"): a stage that
  samples keeps its NIR (+12.5% over the programs' WGSL) and prints again against the bound samplers as a variant, plain
  samplers' modules unchanged; integer textures fetched by the sampler's address modes and LOD, their cubes from a 2D
  array, borders, mirror-once, unnormalized coordinates and the bias in the shader, swizzles through WebGPU's views.
  203 failures of T1's to 0 of those causes but on SwiftShader's own bug, on both hosts; mirror-once, custom border
  colours and their swizzles advertised, the list 13,217 → 16,711. Left (backlog "Samplers' leftovers"): shadow samples'
  bias (T9's), a border's anisotropy on several levels, SwiftShader's `textureLoad` on views from a base level.
- **T9. The translator's wrong results** (M): shadow sampling with a bias, an explicit LOD or gradients (a mipmapped
  shadow map sampled at level 0, silently), non-constant texture offsets (print constants as literals: cheap),
  `textureQueryLod`, `gl_HelperInvocation`, a fragment shader writing depth without a depth aspect (a variant
  without the output), `vkCmdDispatchBase`'s base. *Done:* each cause's cases in the list. *Start:* backlog "Shaders",
  "Rendering". **Done 2026-10-31** (REPORT.md "VK4 T9"): shadow samples past level 0 from fetches, each texel compared, keyed by
  the sampler (one-level views and a constant LOD of 0 stay WGSL's, no variant); offsets were constants the printer couldn't
  see through a vec; `textureQueryLod` in the shader; helpers as an empty `sample_mask`; a dispatch's base as overrides, a pipeline
  per base; `gl_ClipDistance` read by a fragment stage and mirror-once offsets besides; the depth output was T10's. 417 failures of
  1,911 to 0 of 3,270, the list 18,943 → 21,198, 0 failures on the M4 (8 not supported). Left: backlog "Samplers' leftovers"
  (anisotropy on what's fetched), `_pcoffset`'s `maintenance8`, the fetches' cost on a program.
- **T10. Copies and resolves WebGPU refuses** (M): size-compatible copies between formats (compressed ↔
  uncompressed: texture tools, DXVK), multisampled copies, integer resolves, Stencil8's resolves, depth16's offsets,
  a resolve into a 3D image; whole depth and stencil copies through WebGPU's own path (taken never today: slower).
  *Done:* `copy_and_blit`'s and `depth_stencil_resolve`'s cases of those causes. *Start:* backlog "Copies WebGPU
  refuses", "Stencil8's resolves", "Transfers". **Done 2026-10-30** (REPORT.md "VK4 T10"): copies between formats as bytes
  through a temporary buffer; multisampled copies and the resolves WebGPU refuses (integer formats, parts of an image,
  3D images, formats it doesn't resolve) as draws; depth16's parts and offsets; whole depth and stencil copies through
  WebGPU's path; `vkCmdResolveImage`'s regions, which it had dropped; Stencil8's resolves were a pipeline refused for a
  depth output (fixed for every such stage: T9's item); 32-bit float and 16-bit norm linear blits, integer blits clamped.
  A sample's 189 failures left 13, none of these causes; the wide sample's 84 are T12's (multisampled arrays, feedback
  loops). The list 7,509 → 8,600; on the M4 37 of the new cases fail and stayed out (backlog "The M4's own failures").
- **T11. Storage images WebGPU gives one way** (M–L): load and store of a format WebGPU allows only one way (most
  formats without tier2) fails the stage. A storage buffer of the texels with the format's encode and decode in the
  shader. *Done:* the cases, libplacebo's compute paths on such formats. *Start:* backlog "Storage images WebGPU
  gives one way".
- **T12. The smaller rendering gaps** (S each, one task): queries (clears counted inside an occlusion query, two
  pools in one pass), depth clamping without clipping, 3D images through 2D views, feedback loops through an input
  attachment, indirect fans, the M4's 7 Metal-only failures, vkQuake's 1.7%; T1's smaller causes (clears of image
  layers, 16-bit packed colour formats beside depth refused at creation, `int16_t` in storage buffers, push
  descriptors pushed twice, the M4's `descriptorset_random.sets4`). *Start:* backlog "Queries",
  "Rendering", "Formats", "The M4's own failures", "vkQuake's frames".

- **T18. Compressed images whose size isn't whole blocks** (M; found by T1: 102 failures on each host): the
  texture is padded to whole blocks (WebGPU's rule for level 0), so sampling reads a larger texture than the image
  and cube views of it are refused; ASTC's 5-, 6-, 10- and 12-texel blocks meet it at most sizes. Coordinates scaled
  to the image in the shader and a cube's faces apart, or such images decoded to an uncompressed texture. *Done:* the
  `pipeline.*.image`, `image_view`, `sampler` and `texture.compressed` cases of that cause in the list. *Start:*
  backlog "Compressed images whose size isn't whole blocks". **Done 2026-10-31** (REPORT.md "VK4 T18"): such an image is
  sampled in the shader through T8's keys, by its own size and levels from texel fetches, its cubes bound as faces with a
  filter across their edges (`texture-compression-unaligned` is behind Chromium's unsafe flag; scaled coordinates can't
  work). 648 failures to 146 on SwiftShader, all its own `textureLoad` bug, 0 on the M4 (5 cases left the list for that bug;
  `nvidia.sh VK2_STEPS=t18` asks NVIDIA). The list 16,711 → 17,208. Left: backlog "Compressed images that aren't whole
  blocks' leftovers".

### Tier 3: performance on real workloads

- **T13. What a guest's synchronous call waits for** (M): GSK on Vulkan runs iconscroll at 9 frames a second against
  GL's 28 with the guest 11% busy, waking ~1,800 times a second: a frame waits on ring round trips or fences, which
  any program with synchronous Venus calls pays. Find which calls (a ring trace, `VN_DEBUG`) and shorten them. This
  decides GTK4 on Vulkan and so the default. *Done:* iconscroll at GTK4's bar (REPORT.md G) or the cause measured
  and filed. *Start:* backlog "GSK's Vulkan renderer on Venus misses GTK4's bar", REPORT.md "VK3 L7.3".
- **T14. The guest's submit path** (M): 9 execbuffers a frame against virgl's 4 (GTK4's frames +11%), a fenced
  `SUBMIT_3D` every two frames through the virtqueue since VK2's external fences. Which Vulkan calls make them, and
  whether the feedback path can serve. *Done:* the guest's CPU a frame measured before and after (bench/run.ts
  rules). *Start:* backlog "Venus's submit path costs the guest", "The guest fences each frame".
- **T15. Venus's submits ~2 ms later on NVIDIA** (M, needs the user's runs): a bundle carrying the page at several
  of the 34 commits between 4fdc69fb and c8087cb0, run as alternated arms in one session, or Dawn's trace categories
  at both. *Start:* backlog entry of that name, REPORT.md "VK3 L9a".
- **T16. Imports without rewrites** (S–M): every video frame's planes are written again (~0.2 ms and 0.6 MB a frame
  at 480p, ~3 MB at 1080p); a Venus texture per resource written only when its picture changes. *Done:* mpv's GPU
  worker time a frame before and after. *Start:* backlog "Imports' gaps".
- **T17. Pipelines' loose ends** (S each): pipelines made at `vkCreateGraphicsPipelines` (a first frame's stalls),
  the shader store compressed, shown on the Machines page and its budget configurable (the user's ask, 2026-10-26).
  *Start:* backlog "Pipelines' loose ends after VK3 L3".

### Tier 4: breadth (each its own task when a program asks for it)

vkd3d's 11_1 and 12_0 gaps (256 bytes of push constants, multi-draw indirect, vertex attribute divisors, storage
images without a format, min/max reduction, multiple viewports), then geometry and tessellation as compute
pre-passes; transform feedback's leftovers; YCbCr's 10-bit formats; snapshots while Vulkan is in use; Dawn in the
guest's Chromium (a guest Mesa patch for opaque-fd semaphores); a prebuilt renderer module for `npm start`; and **on
by default**, per program that meets its bar (the track's end).

## The gate (the track's end)

- dEQP-VK's pass list grown by every task, passing on SwiftShader in CI, on the M4, and on NVIDIA in one user run.
- T1's census again at the end: the not-passed share of supported cases, by cause, against T1's.
- Every advertised feature backed (or no longer advertised).
- The programs' replays within their tolerances; mpv and VK0's scene no worse than VK3's numbers on each host.
