**Approved by the user (2026-10-29).** Drafted by the session that closed VK3. Covers **VK4** of the Vulkan plan
([docs/plans/graphics.md](docs/plans/graphics.md) §3), M8's graphics track; how Vulkan works now is
[docs/graphics.md](docs/graphics.md) "Vulkan through Venus".
**Updated with the user's OK (2026-11-01)**: tiers 1 and 2 done and summarized; the out-of-context review's
findings and the leftovers that drop work as tier 2b (R1–R7, before tier 3); T20 (T23 since 2026-11-05) and the leftovers after tier 3.
**Updated at the user's ask (2026-11-02)**: tier 2b done and summarized in the done table.
**Updated at the user's ask (2026-11-05)**: the census again (bench/vulkan/REPORT.md "VK4: the census again") and
the tasks it opens, T21–T35 (tier 3's T20 among them, as T23), after tier 3; tier 4's items they take point to them.

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

### Done: tiers 1, 2 and 2b, tier 3 but T15, T21–T24 (2026-10-29 to 2026-11-05)

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

- **T25. Min/max filtering** (S–M; 396: `filterMinmaxImageComponentMapping` 195, formats 150, the extension 51):
  `VK_EXT_sampler_filter_minmax` through T8's sampler keys, T18's filter from fetches taking the texels' min or max
  instead of their weighted sum; vkd3d's 12_0 asks for it. *Done:* advertised, its cases run, a variant's cost on one
  case said. *Start:* vk/README.md "Samplers in the shader".
- **T26. Multi-draw** (S; 196): `VK_EXT_multi_draw` as a draw per element on the host; with it `multiDrawIndirect`
  and `drawIndirectCount` (vkd3d's 11_1) as T12's indirect fans' compute pass writing the draws' arguments, or a loop
  of indirect draws. *Done:* advertised, its cases run. *Start:* vk/README.md "Commands".
- **T27. Depth and stencil resolve modes** (S; 195: depth 130, stencil 46, `independentResolveNone` 19): MIN, MAX and
  AVERAGE as T10's drawn resolves. *Done:* advertised, its cases run. *Start:* backlog "Rendering" (SAMPLE_ZERO only).
- **T28. Pipeline state as variants** (S each; 222): `VK_EXT_vertex_input_dynamic_state` (85), `depth_bias_control`
  (81), what of `extended_dynamic_state3` WebGPU's pipelines can take as variants (23), `primitive_restart_index` (16),
  `non_seamless_cube_map` (17, the cube's filter in the shader). *Done:* each advertised that passes. *Start:*
  vk/README.md "Commands" (extended dynamic state as variants).
- **T29. Shader types** (M; 137 here, more in groups that skip silently): `storageInputOutput16` (89: varyings widened
  to 32 bits), 8-bit storage and `shaderInt8` (17+: words as `lower_16bit` does halves), `shaderImageGatherExtended`
  (31: offsets that aren't constants as fetches), `shaderInt16` (the lowering exists; the advertising and its groups
  don't), `shaderInt64` (`buffer_device_address`'s 504 of the whole list). *Done:* each advertised that passes; the
  translator's tests for each. *Start:* backlog "What the device advertises, left for the translator".
- **T30. Depth16 with stencil and the packed formats left** (M; 353 + those of ~2,450 below): `D16_UNORM_S8_UINT` as a
  depth32float-stencil8 (or depth24plus-stencil8) texture whose copies convert the depth (T10's depth16 parts), its
  precision 16 bits' where a test reads it back; `A4R4G4B4`, `A4B4G4R4`, `A1B5G5R5`, `R4G4` and the `A2R10G10B10`
  orders through T12's packed formats' way (a wider texture, copies packing and unpacking in a compute pass).
  *Done:* their cases run; the formats' features advertised only as far as they pass. *Start:* vk/README.md "Packed
  16-bit formats", backlog "Packed 16-bit formats' leftovers".
- **T31. Formats WebGPU has no texture of** (M–L; of the 1,559 "for sampling", 711 for transfer, 82 for blending, 45
  for vertex input): 3-component formats (RGB8, RGB16, RGB32 of each type), scaled ones, BGRA's integer and snorm
  orders, `R8_SRGB` and `R8G8_SRGB`: a wider texture with copies widening and narrowing, sampled with the shader's
  decoding (scaled: an integer texture read as floats; sRGB of one or two channels: decoded before T18's filter from
  fetches); vertex input's from T5's pulling. Which features each format can honestly have (linear filtering,
  blending, attachment) decides what's advertised. *Done:* their cases run; the cost of the copies said for one.
  *Start:* vk/README.md "Packed 16-bit formats", "Pulled vertices", "Samplers in the shader".
- **T32. What reads the attachment it writes** (M; 463): `VK_KHR_dynamic_rendering_local_read` (97),
  `VK_EXT_attachment_feedback_loop_layout` (48), advanced blends (94), `depthBounds` (113) and logic ops (16) through
  T12's feedback copies in a cut pass (a copy per draw that reads: the cost said), and
  `VK_EXT_multisampled_render_to_single_sampled` (95) as a multisampled texture of the pass's own resolved at its end.
  Each advertised only if its cost on its cases is bearable. *Done:* their cases run. *Start:* vk/README.md "Feedback
  loops" (T12).
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
(T30), `_pcoffset` (T24), MIN/MAX/AVERAGE resolves (T27), `shaderInt64` (T29).

## The gate (the track's end)

- dEQP-VK's pass list grown by every task, passing on SwiftShader in CI, on the M4, and on NVIDIA in one user run.
- T1's census again at the end: the not-passed share of supported cases, by cause, against T1's.
- Every advertised feature backed (or no longer advertised).
- The programs' replays within their tolerances; mpv and VK0's scene no worse than VK3's numbers on each host.
