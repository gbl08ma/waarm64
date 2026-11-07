**Approved by the user (2026-10-29).** Drafted by the session that closed VK3. Covers **VK4** of the Vulkan plan
([docs/plans/graphics.md](docs/plans/graphics.md) §3), M8's graphics track; how Vulkan works now is
[docs/graphics.md](docs/graphics.md) "Vulkan through Venus".
**Updated with the user's OK (2026-11-01)**: tiers 1 and 2 done and summarized; the out-of-context review's
findings and the leftovers that drop work as tier 2b (R1–R7, before tier 3); T20 (T23 since 2026-11-05) and the leftovers after tier 3.
**Updated at the user's ask (2026-11-02)**: tier 2b done and summarized in the done table.
**Updated at the user's ask (2026-11-05)**: the census again (bench/vulkan/REPORT.md "VK4: the census again") and
the tasks it opens, T21–T35 (tier 3's T20 among them, as T23), after tier 3; tier 4's items they take point to them.
**Updated at the user's ask (2026-11-07)**: docs/backlog.md's Vulkan entries that WebGPU can back made tasks, T36–T50
(after the census's, grouped by the machinery they share; tier 4's and the leftovers' items they take point to them).

## How VK4 runs: tasks the user starts

No supervisor and no loops. VK4 is a list of **tasks** (below, in the order proposed). Each is one well-defined goal
with its scope, what counts as done and where to start; the user starts each in a session of its own ("do VK4
task T3"), in any order, several at once where they don't touch the same files. A task:
- reads this file, CLAUDE.md, and the docs its "Start" names; nothing else carries context between tasks.
- starts with its confirming test, failing first (a dEQP-VK case, a unit test, or a measurement for a performance
  task), and ends with **one commit or a few**, rebased onto origin/main and pushed: the fix, its tests, its dEQP-VK
  cases added to `tests/deqp/vk.txt`, the docs it changes, and its row below marked done with a line of outcome
  (numbers, what's left). What it leaves goes to docs/backlog.md, not here.
- runs `scripts/ci.sh` and `scripts/ci-deqp-vk.sh` (and the CI scripts its area names in CLAUDE.md) before it's done:
  the latter's seeded sample of the pass list (docs/testing.md "dEQP-VK"), the task's own new cases proven by its own
  runs; a sample's failure is looked into at once or filed and taken out of the list. `--full`, the whole list, runs
  once after all the census's tasks (T21–T35) and at the track's end (the user's OK, 2026-11-06).
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

### Done: tiers 1, 2 and 2b, tier 3 but T15, T21–T32 (2026-10-29 to 2026-11-06)

Each row's outcome in full is its section of bench/vulkan/REPORT.md ("VK4 T<n>") and its commit; what each left is in
docs/backlog.md "The Vulkan driver's gaps" (the entry named) and, where it is a defect or drops work, in the tasks
below. dEQP-VK's pass list went 4,725 → 26,002 over tiers 1 and 2, and 27,714 → 30,040 with T21–T22, every new case
passing on SwiftShader and the M4.
Tier 2b (R1–R7) took the out-of-context review's findings ([VENUS-VK4-REVIEW.md](VENUS-VK4-REVIEW.md), ids by area:
its triage at the top says which each fixed) before tier 3, which measures programs on this code; a second review, of
R1–R4 and then of R5–R7, had its findings fixed or moved to the backlog the same way.

| Task | What it did | Its leftovers (backlog) |
|---|---|---|
| T1. A census of dEQP-VK | every 100th case (16,489) on SwiftShader and the M4, 17.0% and 16.5% of supported cases not passing, classed by cause (`bench/vulkan/census.ts`); re-ranked tiers 1–2; list 4,725 → 7,126 | "Not advertised, by what dEQP-VK asks" (a compute-only queue family: 18%) |
| T2. The renderer's robustness | a dead context's objects destroyed (the 17th device); an export imported again aliases; a sync freed under a held submit dropped from it; a virtio reset ends Venus's contexts; list → 7,509 | "Memory" (an allocation past the arena loses the context), "External memory's leftovers", "A trap in the module's completion on NVIDIA" (confirm in the next run) |
| T19. The renderer out of memory 0 | memory 1 is the renderer's (1,280 MiB arena, the window, node 1); memory 0 holds 3,071 MiB with Vulkan as without; host-visible heap 1 GiB | "Nodes 2 and up in one memory64" |
| T3. Usage scopes | reads of a buffer a scope binds writable copied to a shadow | "Usage scopes' leftovers" |
| T4. Views in another format | a texture per view format, copies where used | "Views in another format's leftovers" (multisampled only); list → 12,733 |
| T5. Vertex strides and offsets | pulled from storage in a free group; list → 9,602 | "Pulled vertices' leftovers" |
| T6. Synchronization | ring fences held with held submits, answered out of line; list → 13,217 | "Synchronization" (16 held submits from the signalling thread hang) |
| T7. API 1.3's required features | R32 image atomics, inline uniform blocks, multiview, device addresses; list → 18,943 | "Device addresses' leftovers" |
| T8. Samplers | sampling lowered in the shader against a key per pair; swizzles; list → 16,711 | "Samplers' leftovers", "SwiftShader's fetch from a view with a base level" |
| T18. Compressed images not whole blocks | sampled by their own size from fetches; list → 17,208 | "Compressed images that aren't whole blocks' leftovers" |
| T9. The translator's wrong results | shadow samples past level 0, offsets, `textureQueryLod`, helpers, dispatch base; list → 21,198 | "Samplers' leftovers", "Shaders" (`_pcoffset`) |
| T10. Copies and resolves WebGPU refuses | copies between formats, drawn resolves, depth16; list → 8,600 | "Copies WebGPU refuses", "The M4's own failures" |
| T11. Storage images WebGPU gives one way | such images as words, any format's encoding; list → 23,083 | "Storage images as words' leftovers" |
| T12. The smaller rendering gaps | layered passes, feedback loops, indirect fans, queries, packed 16-bit formats; list → 26,002 | "Multisampled image clears", "Packed 16-bit formats' leftovers", "Multisampled arrays' leftovers", "The M4's own failures", "Rendering" |
| R1. Fences per context (review H1) | a ring is a lane of the `FenceGate`, a fence waits for itself only (a held submit no longer holds sway's frames); a stalled queue gives ring fences' entries back; synchronization groups unchanged | "Synchronization" |
| R2. Usage scopes and shadows (R1, R4) | read and written shadows apart, overlapping writable bindings one by a variant, passes cut at barriers | "Usage scopes' leftovers" |
| R3. Render passes' replay (R2, R3, R5–R10, O7, O10) | crops for attachments of other sizes, 256 layers, the packed twin (its 4 `self_dep` kinds join the list), R10's long fans warned; list +212 | — |
| R4. Transfers (X1, X3–X8) | unaligned one-row copies, fans sized by their draw, every layer of multisampled copies, copies between formats by a shader; some multisampled clears join the list (X2 didn't reproduce) | "Multisampled image clears" (the RGBA8 family), "Copies WebGPU refuses" (4 `diff_image_size`) |
| R5. The translator's defects (C1–C7) | a variant's own depth-less module; depth textures' plain samples through fetches, a shared sampler split, borders across levels fetched, a variant that can't print refuses its draws; ufloats past range the largest finite | "Samplers' leftovers" |
| R6. Memory and objects (O1–O3, O11, O12, O14–O17, H4) | an allocation past what there is refused (for Venus's guest an empty memory, not a lost context); imports keep device addresses and move with their blob; set layouts' sizes checked; `memory.*` and `api.external.memory.*` unchanged | "Memory", "External memory's leftovers" |
| R7. What's advertised (O5, O6, O8, O9) | A8B8G8R8 and BC1_RGB formats, set-wide limits, all of WebGPU's dynamic uniform buffers, 16 vertex bindings; list +1,370; every `api.info` limit and format query passing on SwiftShader but two `r32g32*_sfloat` sample-count queries (the M4 not run) | "Sample counts Vulkan wants but WebGPU lacks", "What R7's limits leave" |
| T13. What a guest's synchronous call waits for (with T14) | GSK's ~80 synchronous `vkAllocateDescriptorSets` a frame each waited a poll turn (1.33 ms on the Mac); the pump's turns timed by a ticker worker (0.08 ms); iconscroll 6.5 → 33 frames/s on the M4, past GL's 28–32; VK0's scene no worse | "GTK4 on Vulkan: the bar met on the M4, the default not taken" |
| T14. The guest's submit path (with T13) | of 9 execbuffers a frame, 6 are 3 fenced submits' two each (Mesa 26's fences are DRM syncobjs, no feedback path), 1 a ring notify, the rest sway's; the guest's CPU a frame in GTK4's frames 2.01–2.08 → 1.91–1.96 ms, GL's; rings kept active no gain | — |
| T16. Imports without rewrites | each virgl resource a texture of its own, an import writes nothing; mpv imports a surface once a picture anyway (600 KB a frame stay); the import's GPU-worker time a frame 0.22 → 0.18 ms on the M4 | "Imports' gaps" |
| T17. Pipelines' loose ends | render pipelines made at creation lose (cold vkQuake 269 → 26 frames/s on the M4), so off by default (`?gpu=vkpremake=on`); the shader store deflated (7.4×), on the Machines page with a clear, its budget a Preference of 8–64 MiB | "Pipelines' loose ends" |
| T21. The census's failures and its new passes | texel buffers' and word images' parameters one uniform table a group (sets4's uniform buffers past 12), but sets4's 165 failures are all bindings past WebGPU's, filed; the 16-bit normalized formats' resolves drawn (438 multisampled cases pass on the M4); long_shader_bitwise_and's 40 s are SwiftShader compiling 2,356 loads, booleans as `&` 16% off it; list +861 | "Texel buffers", "SwiftShader compiles zero-initialized workgroup memory slowly" |
| T22. A compute-only queue family | three families (graphics; compute; transfer), all the WebGPU queue; held submits hold their own queue's only, a binary wait held with its held signal; of 2,590 sampled cases 1,465 pass on both hosts and join the list (SwiftShader's 166 failures its own, the M4's one filed); mpv the same | "SwiftShader's compressed formats sampled in a compute stage", "The M4's own failures" |
| T23. What the emulations cost a program | the paths counted (`venusEmul`) and skippable in a run (`?gpu=vkskip=`, `bench/vulkan/t23.ts`); Godot's GI demo in SDFGI mode on the M4 and NVIDIA: SDFGI's rgb9e5 views of R32_UINT images copied ~34 MB a frame (2.8 ms of a 17 ms submit on NVIDIA, +12% frames/s left out), the rest small or none, no freeze; such views now decoded in the shader from the image's own texture (about even on the M4) | "Views in another format's leftovers" (the decode's gain on NVIDIA: the next NVIDIA run's `t23`) |
| T24. `maintenance5`, `6` and `8` | the three advertised; 5 and 6 host-side (`vkGetDeviceImageSubresourceLayout`, their properties): 360 of the census's 688 cases pass on both hosts and join the list (30,039 → 30,399), the rest formats WebGPU lacks (A8, A1B5G5R5) and aliased images; 8's offsets that aren't constants from fetches, depth and stencil copied with colour images, blits between layers and slices: 2,246 of its 3,642 cases pass through Mesa 26.3's Venus (`images/deqp/venus-icd.sh`), 0 fail on either host, in `tests/deqp/vk-maintenance8.txt` until the guest's Mesa is 26.3 | "maintenance8's cases wait for the guest's Mesa 26.3", "maintenance5's and 6's leftovers" |
| T25. Min/max filtering | `VK_EXT_sampler_filter_minmax` and `samplerFilterMinmax`: a reducing sampler's pairs keyed, their samples from fetches taking the min or max of the texels with weight (integers and cubes too), every sampled format's MINMAX bit; 182 of the census's 504 pass on SwiftShader (192 on the M4), 1,797 of every 10th of the list's 50,940; 0 fail; 1,908 join the list (→ 32,307); the census's 195 mapping cases are dEQP's own refusal; a reduced sample ~3.5× WebGPU's on the M4 | "Min/max reductions' leftovers" |
| T26. Multi-draw | `VK_EXT_multi_draw` (a draw per element, its draw index), `multiDrawIndirect` (the replay's draw per record, its push places reserved), `drawIndirectCount` (records gated by the count in a compute pass before the render pass); of 2,757 cases (the census's 203, every indirect-draw and draw-parameters case, every 20th multi-draw) 1,495 pass on SwiftShader, 0 fail; the M4 fails the 16 `draw_index` cases (every draw reads index 0), filed; 1,344 join the list (→ 33,651) | "Multi-draw's leftovers", "The M4's own failures" |
| T27. Depth and stencil resolve modes | MIN, MAX and AVERAGE (depth) advertised with `independentResolve` and `independentResolveNone`, the worker's drawn resolves folding the samples by the mode; of the 3,823 samples_4 and misc `depth_stencil_resolve` cases 2,614 pass on SwiftShader, 0 fail (the rest D16S8, T30's, and geometry); the M4 fails its 40 `stencil_samplemask` whatever the mode; 2,503 join the list (→ 36,155) | "Rendering", "The M4's own failures" |
| T28. Pipeline state as variants | `VK_EXT_vertex_input_dynamic_state`, `VK_EXT_depth_bias_control` (the format's representation), the third dynamic state's depth clamp and clip, sample mask, alpha to coverage, blend and provoking vertex (the draw's key had them), alpha to coverage at one sample in the fragment stage, `VK_EXT_non_seamless_cube_map` from the faces' fetches; of 7,956 cases 2,519 pass on SwiftShader, 59 fail that failed before or their seamless twins do; 2,262 join the list (→ 38,417). Not done: `primitive_restart_index` (the guest's Venus doesn't pass it on), `legacy_vertex_attributes` (82 of the census's 85 dynamic vertex input cases) | "Not advertised, by what dEQP-VK asks", "Samplers' leftovers", "Pulled vertices' leftovers", "Rendering" |
| T29. Shader types | `shaderInt8`, `shaderInt16`, `shaderInt64`, 8-bit storage, `storageInputOutput16`, `shaderImageGatherExtended`: bytes of words as halves are, 16-bit inputs and outputs widened, 64-bit integers pairs of words (64-bit subgroup reductions as shuffles); of 5,095 cases 1,877 pass on SwiftShader and 2,019 on the M4, 1,750 join the list (→ 40,166); float-to-integer conversions saturate exactly (WGSL clamps under the bound, Metal takes halves as finite); the 13 left failing are SwiftShader's own | "What the device advertises, left for the translator" |
| T30. Depth16 with stencil and the packed formats left | `D16_UNORM_S8_UINT` a depth24plus-stencil8 texture, its depth 16-bit unorm in buffers (copies drawn in and computed out, the bias ×256); `A4R4G4B4`, `A4B4G4R4` (`VK_EXT_4444_formats`), `A1B5G5R5`, `R4G4` (rg8unorm) and `A2R10G10B10`'s UNORM and UINT (rgb10a2) packed, the worker's pass taking texels of 1, 2 or 4 bytes (vk/README.md "Packed formats", was "Packed 16-bit formats"); `A2R10G10B10_UINT`'s clears drawn past Dawn's 8-bit cut; of 4,197 cases 2,769 pass on SwiftShader and 2,906 on the M4, the rest of the fails filed hosts' own; 2,767 join the list (→ 42,933). Not done: the 10-bit SNORM and SINT orders | "Packed formats' leftovers", "Depth comparison isn't reported" |
| T31. Formats WebGPU has no texture of | three-channel formats (RGB8 and BGR8 of every type, RGB16, RGB32) in four-channel textures with alpha kept 1, BGRA's UINT, SINT and SNORM, `R8_SRGB` and `R8G8_SRGB` in `rgba8unorm-srgb`, the 10-bit SINT orders in `rgba16sint`, the scaled ones in their integer twins' textures for transfers only (dEQP-VK samples and clears them as integers, the spec as floats), all by T30's packed way (`packPass` an invocation a texel, channel kinds converted); vertex formats WebGPU lacks pulled; of 3,155 cases 1,818 pass on SwiftShader and 2,300 on the M4, the failures the hosts' own; 1,733 join the list (→ 44,666); a converting copy ~2× a plain one on the M4 | "Packed formats' leftovers", "Pulled vertices' leftovers", "SwiftShader's compressed formats sampled in a compute stage" |
| T32. What reads the attachment it writes | the depth bounds test, logic ops and advanced blends (every op, overlap and premultiplication) on a copy of the attachment made before each such draw (~0.1 ms a draw on the M4); local read's colour attachment map in the pipeline's key; `VK_EXT_attachment_feedback_loop_layout` and its dynamic state (a sampled view over a copy of the image's texture, renewed at barriers); `VK_EXT_multisampled_render_to_single_sampled` (4-sample images of the pass's own resolved into the attachments, LOAD filled by a draw a sample); 3,375 join the list (→ 48,041); 70 mrtss cases draw R32G32B32A32_UINT at 4 samples past dEQP's own check and fail. Not done: unified image layouts (the guest's Venus), stencil export, sample counts other than 4 | "Reading the attachments' leftovers", "Feedback loops' leftovers", "Multisampled rendering to single-sampled attachments' leftovers" |

### Tier 3: performance on real workloads

- **T15. Venus's submits ~2 ms later on NVIDIA** (M, needs the user's runs): a bundle carrying the page at several
  of the 34 commits between 4fdc69fb and c8087cb0, run as alternated arms in one session, or Dawn's trace categories
  at both. *Start:* backlog entry of that name, REPORT.md "VK3 L9a".

### The census's tasks (T21–T35, drafted 2026-11-05 at the user's ask; T23 was tier 3's T20)

The census again (bench/vulkan/REPORT.md "VK4: the census again"; T1's sample, 16,489 cases): 0.2% of the M4's
supported cases fail and 0.9% of SwiftShader's, but 75% of the sample isn't supported, so dEQP-VK's cases are now
mostly opened by advertising what WebGPU can be made to back. These tasks take the not-supported reasons by count,
each on machinery a done task built, numbered in the order proposed: T21 (its failures are defects) and T22 (a
fifth of what's left, no emulation), then T23 (what the emulations cost, before the tasks that add more of them), then
the host-side and small ones (T24–T29), then those that add copies or pre-passes (T30–T33), T34 and T35 last; a
program that asks for one (vkd3d, Dawn, ANGLE, Godot) moves it up. The reasons out of WebGPU's reach (protected
memory, cooperative matrices, ray tracing, mesh shaders, tile images, fragment density, descriptor buffers, sparse:
~1,600 of the sample) and pipeline statistics queries (188: WebGPU has none) get no task. Each task's counts are
the sample's on the M4 (×100 for the whole list, roughly); each starts by running its reason's cases (`deqp-run.ts`'s
`CASES`, from `census.ts --reasons`' examples or the sample's JSON) to see what they meet once advertised.

- **T33. Writable storage in the vertex stage** (L; 222 here, and `timeline_semaphore.wait_before_signal`): the vertex
  stage run as a compute pre-pass (transform feedback's `runXfb` way) writing its outputs, a pass-through vertex stage
  drawing them; `vertexPipelineStoresAndAtomics`. The same pre-pass is tier 4's way to geometry and tessellation (370
  of the sample), so this task decides it for them. *Done:* advertised, its cases run, the pre-pass's cost on a draw
  said. *Start:* vk/README.md "Transform feedback", backlog "Synchronization".
- **T34. Mutable descriptor types** (M; 143): `VK_EXT_mutable_descriptor_type`, a bind group layout per set of types
  the guest writes (a variant, as overlapping bindings are); vkd3d-proton leans on it. *Done:* advertised, its cases
  run. *Start:* vk/README.md "Descriptors".
- **T35. 3D ASTC** (M; 187): `VK_EXT_texture_compression_astc_3d` decoded to RGBA8 at upload in a compute pass. No
  program asks; last. *Done:* advertised, its cases run.

### The backlog's tasks (T36–T50, drafted 2026-11-07 at the user's ask)

docs/backlog.md's Vulkan entries ("The Vulkan driver's gaps" and the entries around it), grouped so that each task
works in one place of the code (the replay's draws, the bindings' count, a fetch in the translator, the worker's
compute passes), numbered by the kickoff's ranking: a hang first, then work WebGPU drops, wrong pixels, what Vulkan 1.3
requires, then features by what programs (DXVK, vkd3d, Godot, ANGLE) and dEQP-VK meet, performance last. Each task
starts from the backlog entries it names, moves what it leaves back there, and runs its entries' dEQP-VK groups for
the cases that join the list (as the census's tasks do). Out of WebGPU's reach, so no task: images sharing their
memory's bytes (`memory.binding.aliasing`, `plane_view.memory_alias`, images on external memory: an image is a
texture of its own), formats WebGPU can't multisample unless T39 decides an emulation, depths past [0, 1], 16
attachments, stencil export, early fragment tests (WGSL has no attribute), both blend constants, one draw's front and
back primitives in order, `occlusionQueryPrecise`, several viewports, 64-bit floats and atomics, and what VK4's
decisions already leave (protected memory to sparse, pipeline statistics). Waiting on the guest's Mesa, not a task:
maintenance8's list (a guest rebuild once Arch has Mesa 26.3), `VK_KHR_unified_image_layouts`,
`VK_EXT_primitive_restart_index`'s cases.

- **T36. Hangs and lost completions** (S): a guest waiting on a ring fence that gave its queue entry back, while the
  ring's newest waits for what the guest does next, waits for ever (backlog "Synchronization", the review of R1–R4's
  C2): signal such a fence once its own work is done, not with the ring's next; T33's run of
  `timeline_semaphore.wait_before_signal` (now supported) confirms the held submits; Venus's use-after-free fix gets
  its test (a recorded stream through `venus_submit`, backlog "Venus's use-after-free fix has no test"). *Done:* a
  driver test of the C2 shape that hung before, the wait-before-signal cases in the list. *Start:* docs/devices.md
  "Venus", backlog "Synchronization".
- **T37. Commands WebGPU refuses that the driver can avoid** (M): each a submit or draw dropped today, made valid or
  refused where it's made (saying why): a subresource read through a storage image bound as a texture and written in
  one scope (`scope_images`), a 2D array view of one layer bound to a 2D storage image, stages from the cache that
  disagree on an image's kind (`wg_program_merge` without `wg_shader_compile`'s checks), `packPass`'s clamp on a large
  3D alias (backlog "Storage images read as textures' leftovers"); a storage image as words past
  `maxStorageBufferBindingSize` (a binding per part) and `mismatched_formats` (a variant by the view's format;
  "Storage images as words' leftovers", "`mismatched_formats`"); a vertex binding read past its buffer's end (pulled,
  zeros past it: "Pulled vertices' leftovers"); a uniform block past its range at the 64 KiB pad, writable bindings of
  one range one of atomics ("What R7's limits leave", "Usage scopes' leftovers"). *Done:* a driver test of each shape
  with no WebGPU error, the groups' cases (`robustness`, `image.mismatched_formats`, `extended_dynamic_state`'s
  bindings past the end) run. *Start:* vk/README.md "Usage scopes", "Storage images as words".
- **T38. Formats and features a line or a fetch away** (M; Vulkan 1.3's first): R32 texel buffer atomics (required by
  1.3: the texel buffer's words are a storage buffer already, `atomic<u32>` on them), storage texel buffers of formats
  under a word (r8, rg8, r16: an atomic and-or on the word, as 8-bit storage), the depth comparison bit in
  `VkFormatProperties3` (`texture.shadow.*`: ~700 cases a depth format), A8_UNORM (`r8unorm` swizzled; its attachments
  a variant writing alpha to red) and A1B5G5R5 if T30 left it unoffered, the 10-bit SNORM orders in `rgba16snorm`
  (tier1), sRGB and packed 16-bit storage images through words, `VK_EXT_image_2d_view_of_3d` (a slice in the shader).
  *Done:* each advertised and its cases run. *Start:* backlog "Texel buffers", "Depth comparison isn't reported",
  "maintenance5's and 6's leftovers", "Packed formats' leftovers", "Rendering".
- **T39. Multisampling's gaps** (M): the multisampled clears of RGBA8 and its packed twins that read 0 or another
  colour (a read of memory nothing wrote; every such case is out of the list), the 3 sRGB-twin resolves 0.26 off,
  `sampler2DMSArray` sampled whole (a binding per layer, a switch on the layer), images made for sampling only
  reporting 4 samples where the format multisamples (the driver adds the attachment usage), multisampled copies between
  formats the bits shader skips (`rgb10a2`, packed layouts); and the decision on `R32G32_SFLOAT` and
  `R32G32B32A32_SFLOAT` at 4 samples (Vulkan's mandatory attachments: a 4-layer texture resolved by a draw, measured,
  or left). *Done:* the clears' cases back in the list, the rest run. *Start:* backlog "Multisampled image clears",
  "Multisampled arrays' leftovers", "Sample counts Vulkan wants but WebGPU lacks", "Views in another format's leftovers".
- **T40. Bindings past WebGPU's limits** (L; `descriptorset_random.sets4`'s 165 and T33's 2, `descriptor_copy`'s 2):
  texel buffers' words of one memory sharing a storage binding (a variant keyed by the binding pattern, each view's
  offset in the parameter table), uniform texel buffers as `r32uint` textures (counted with sampled images, as Vulkan
  does), a set's inline uniform blocks one binding of its buffer (as the table is), the push buffer on a binding without
  a dynamic offset where none is left (`maxDescriptorSetUniformBuffersDynamic` back to 8), and the four-group programs
  whose extra bindings have no group (a capture's, pulled vertices', an attachment read's) joining a copy of group 3 as
  T33's pre-pass does (`vsGroup3`). *Done:* sets4's refusals measured again (each one passing or filed with its count),
  vkd3d's 14 uniform buffers a stage reconsidered. *Start:* backlog "Texel buffers", "Bindings past WebGPU's", "What
  R7's limits leave", "Pulled vertices' leftovers", ANGLE's "Transform feedback".
- **T41. Device addresses at a program's scale** (L; DXVK puts every allocation there, Godot's VMA grew the buffer to
  512 MiB, which SwiftShader refused): a memory placed in the address buffer at its first bind of a buffer that asks
  (images' memory left out), address memory past one storage binding (several bindings, picked by the address's high
  bits), `OpConvertUToPtr` now that `shaderInt64` is offered (504 of `buffer_device_address`), capture and replay
  (addresses a memory's opaque capture value fixes), loads NIR knows are 16-aligned through a vec4 view
  (SwiftShader's 40 s compile), a descriptor beside the pointers' binding seeing its bytes in a scope (the review's
  W2). *Done:* Godot's GI demo's editor on SwiftShader, the bda groups run, a DXVK-shaped allocation test. *Start:*
  backlog "Device addresses' leftovers", "Godot on Venus, GD's leftovers" (the address buffer).
- **T42. Shaders' and samplers' wrong results** (M): `umulExtended`, signed and unsigned atomic min or max on one
  array (a compare-exchange loop for the other kind), derivatives in non-uniform control flow
  (`glsl.derivate.*dynamic_if`: looked into first), a shadow cube's corner of three faces, a depth texture's linear mip
  blend at an explicit LOD, gathers refused today (a shadow cube or a non-seamless linear cube bound as faces, an
  integer cube both sampled and gathered, a padded compressed cube) and the padded cube's seam corner, an indexed f16
  vector's `if` tree past Tint's 127, flat varyings of mixed types packed into one location. *Done:* each with its
  translator test, its cases run. *Start:* backlog "Shaders", "Samplers' leftovers", "Compressed images that aren't
  whole blocks' leftovers", "What the device advertises, left for the translator".
- **T43. Rendering's rest** (M): `gl_Layer` (a layered pass drawn a layer at a time, the stage discarding other
  layers' primitives), alpha to coverage without a colour target or with the stage's `sample_mask` (the coverage
  through the stage's own mask), alpha to one, depth bias's float representations and `depthBiasExact` (the fragment
  depth moved), polygon modes (`fillModeNonSolid`: lines and points as a list the provoking pass's way writes before the
  pass), `load_store_op_none`'s 9 and the transfers' 3 (a 4-sample `b10g11r11` clear, a 3D `a2b10g10r10_uint` clear,
  `push_constant.graphics_pipeline.overwrite`) looked into. *Done:* each advertised or fixed, its cases run. *Start:*
  backlog "Rendering", "Not advertised, by what dEQP-VK asks" (T28's leftovers), "Transfers".
- **T44. Vertex input's rest** (M): vertex attribute divisors (`VK_KHR_vertex_attribute_divisor`: `iid / rate` in the
  pulled fetch; vkd3d's test_instance_id), `VK_EXT_legacy_vertex_attributes` (bytewise pulls; 4,080 of `vertex_input`),
  16 vertex bindings without a free group (T40's group 3), a pulled range past `maxStorageBufferBindingSize` (several
  bindings). *Done:* advertised, `vertex_input` and the divisor groups run, vkd3d's instance tests. *Start:* backlog
  "Pulled vertices' leftovers", vk/README.md "Pulled vertices".
- **T45. Transform feedback's and indirect draws' rest** (L; the worker's compute passes): transform feedback's queries
  and `vkCmdDrawIndirectByteCountEXT` (`transformFeedbackQueries`, `transformFeedbackDraw`: the advance dispatch knows
  the counts), restarts in a captured draw, `transformFeedbackPreservesProvokingVertex`, 16-bit outputs, records past
  512 bytes, `gl_ClipDistance`'s capture, indexed and indirect captures bounded by their indices' range; indirect draws
  that the replay draws as they are or not at all: the last vertex provoking, a vertex stage that stores (T33's
  pre-pass on the GPU's counts), a draw-indirect-count of a fan or under transform feedback. *Done:* ANGLE's ES3 sample
  page and the groups' cases. *Start:* backlog ANGLE's "Transform feedback", "The provoking vertex", "Multi-draw's
  leftovers".
- **T46. Queries and timestamps** (M): timestamps from the GPU where the adapter has `timestamp-query` (1.3's
  `timestampComputeAndGraphics`, today the CPU's at replay), two occlusion queries active at once across pools and one
  cut by a part of the pass counted rather than reported passing, queries past slot 4,096, `vkCmdCopyQueryPoolResults`
  as one dispatch. *Done:* `query_pool` and `timestamp` groups run, VK0's scene's GPU time against `?gpu=vkgputime`.
  *Start:* backlog "Queries".
- **T47. vkd3d's feature levels** (M; after T40 and T44): 256 bytes of push constants (draw parameters moved past
  them), the viewport limits vkd3d checks, the whole d3d12 suite run for a ranked list (`TESTS=` in vkd3d.ts), what
  vkd3d still lacks rechecked against what VK4 has offered since VK3 L7.5. *Done:* feature level 11_1 or the reason
  left, the suite's ranked failures fixed or filed. *Start:* backlog "vkd3d on Venus", tier 4.
- **T48. Presentation and imports** (S): images written only by compute marked written (a WSI image a compute pass
  draws isn't copied again: wrong pixels), WSI formats past 8-bit RGBA, `rgb10a2unorm` and `rgba16float`, an imported
  image's texture made at its first use (two made and destroyed a frame for mpv), a multi-planar image on external
  memory (each plane's region of the resource). *Done:* a compute-drawn swapchain test, mpv's import measured.
  *Start:* backlog "Presentation's gaps", "Imports' gaps", "YCbCr's gaps".
- **T49. A program's start: pipelines and WGSL** (M, performance: Godot's first frame ~35 s): which pipelines a
  creation can make right (a count per program in the store, VK4 T17's 10 of 18 keys missed), the store held deflated
  (a synchronous inflate), the printer's WGSL smaller for Tint (float vectors, uniform word indexing, single-use values
  inlined), each measured by its gain on Godot's cold and warm start and vkQuake's cold frames. *Start:* backlog
  "Pipelines' loose ends", "The printer's WGSL, what Tint still pays for".
- **T50. The hosts' own failures** (M; the Mac, NVIDIA's batch): the M4's 16 `draw_index` (the difference between the
  driver's calls and the worker's: likely ours), its stencil `samplemask` resolves, its `e5b9g9r9` copies (an
  `r32uint` texture), SwiftShader's compressed samples in compute and its base-level fetch; NVIDIA's
  `buffer_1048577` and T2's trap from the next run. *Done:* each fixed, or shown the host's and reported upstream.
  *Start:* backlog "The M4's own failures", "SwiftShader's …" entries.

### Tier 4: breadth (each its own task when a program asks for it)

vkd3d's 11_1 and 12_0 gaps (256 bytes of push constants, multi-draw indirect (T26), vertex attribute divisors, min/max
reduction (T25), multiple viewports; storage images without a format were GD G5's), then geometry and tessellation as
compute pre-passes (T33 decides the pre-pass); transform feedback's leftovers; YCbCr's 10-bit formats; snapshots while Vulkan is in use; Dawn in the
guest's Chromium (a guest Mesa patch for opaque-fd semaphores); a prebuilt renderer module for `npm start`; and **on
by default**, per program that meets its bar (the track's end).

**After tier 3: the leftovers nothing meets yet** (backlog entries named; each a task when a program or the census
asks): multisampled formats WebGPU can't multisample, multisampled arrays sampled whole and `r32g32b32a32` multiview
("Views in another format's leftovers", "Multisampled arrays' leftovers"); compressed images not whole blocks' variant
per size, padded cubes' gather and their anisotropy; the samplers' anisotropy on what's fetched, the shadow cube's
corner, depth sampled at an explicit LOD ("Samplers' leftovers"); `shaderInt64`, memory past one storage binding and
capture-replay for device addresses ("Device addresses' leftovers"); a pull for a program with four groups, divisors
and the formats WebGPU's vertex buffers lack ("Pulled vertices' leftovers": the divisors with vkd3d above); the packed
1.3 orders and their 16-bit views; `_pcoffset` (`maintenance8`), derivatives in non-uniform flow, `umulExtended`
("Shaders"); `gl_Layer`, early fragment tests, both blend constants, per-face stencil order, MIN/MAX/AVERAGE resolves
("Rendering"); D24's unit and RGB32 attachments ("Formats"); queries' precise counts and GPU timestamps ("Queries");
a compute-only queue family, the commonest not-supported reason (T1); and the hosts' own: the M4's failures,
SwiftShader's fetch from a base level and `buffer_1048577` on NVIDIA (the user's next NVIDIA run decides those and
T2's `wg_complete` trap). The census's tasks take some of these: the compute-only queue family (T22), the packed 1.3 orders
(T30, done), `_pcoffset` (T24), MIN/MAX/AVERAGE resolves (T27, done), `shaderInt64` (T29, done).

## The gate (the track's end)

- dEQP-VK's pass list grown by every task, passing whole (`ci-deqp-vk.sh --full`) on SwiftShader after the census's
  tasks and at the end, on the M4, and on NVIDIA in one user run.
- T1's census again at the end: the not-passed share of supported cases, by cause, against T1's.
- Every advertised feature backed (or no longer advertised).
- The programs' replays within their tolerances; mpv and VK0's scene no worse than VK3's numbers on each host.
