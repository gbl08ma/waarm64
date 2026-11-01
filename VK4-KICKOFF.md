**Approved by the user (2026-10-29).** Drafted by the session that closed VK3. Covers **VK4** of the Vulkan plan
([docs/plans/graphics.md](docs/plans/graphics.md) §3), M8's graphics track; how Vulkan works now is
[docs/graphics.md](docs/graphics.md) "Vulkan through Venus".
**Updated with the user's OK (2026-11-01)**: tiers 1 and 2 done and summarized; the out-of-context review's
findings and the leftovers that drop work as tier 2b (R1–R7, before tier 3); T20 and the leftovers after tier 3.

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

### Done: tiers 1 and 2 (2026-10-29 to 2026-10-31)

Each row's outcome in full is its section of bench/vulkan/REPORT.md ("VK4 T<n>") and its commit; what each left is in
docs/backlog.md "The Vulkan driver's gaps" (the entry named) and, where it is a defect or drops work, in the tasks
below. dEQP-VK's pass list went 4,725 → 26,002 over them, every new case passing on SwiftShader and the M4.

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

### Tier 2b: the review's defects and what still drops work (before tier 3)

The out-of-context review of T2–T19 (2026-11-01, [VENUS-VK4-REVIEW.md](VENUS-VK4-REVIEW.md): five static reviews,
~55 findings, ids by area) found defects in code the tasks wrote, about half of which crash, hang or drop work. They
go **before tier 3**: tier 3 measures programs on this code, and the bar's order (a crash or a lost device first, then
dropped work, then wrong pixels) puts them ahead of performance. Each task below is one session, takes its findings in
the order listed, starts each fix with its confirming test failing first (the review names one per finding: a
`wg_test.c` scenario, a `tests/venus-*.test.ts` row, a dEQP-VK case), and ends by marking the findings it fixed in
VENUS-VK4-REVIEW.md (or moving them to the backlog with a line). The review's own commits fixed H2, H3 and O4.
**Cloud sessions** can do all of tier 2b: the renderer builds there and the driver's and translator's tests run on
SwiftShader, and dEQP-VK runs on the prebuilt disk and guest (docs/cloud.md "Venus (vk/)"); `ci-deqp-vk.sh`'s
programs' replays need the dev VM.

- **R1. Fences per context** (M; H1, then T6's leftover): every fence the GPU worker answers goes through one
  in-order `FenceGate` whose check covers all of Venus's pending ring fences, so since T6 a submit held for an unmet
  timeline wait (legal: a CPU `vkSignalSemaphore` later; vkd3d's D3D12 fences) holds every later fence of every
  client, sway's virgl frames included: a stall, a deadlock when the signal waits on the compositor. A fence's check
  scoped to its own context and ring, fences of other contexts answered out of order (the device side's in-line queue
  too). With it, T6's leftover: 16 held submits from the signalling thread fill the control queue (backlog
  "Synchronization"). *Done:* a test of each (tests/venus-renderer.test.ts or a GPU-worker-level test), ci-graphics.sh
  for the compositor's fences. *Start:* web/virgl-host.ts `FenceGate`, web/gpu-worker.ts `settled`, web/venus-host.ts,
  docs/devices.md "Venus".
- **R2. Usage scopes and shadows** (M; R1, R4 of the review, then backlog "Usage scopes' leftovers"): a written shadow
  (pointers beside a writable descriptor, T7) and a read shadow share `dev->shadow`, which WebGPU refuses in one scope
  (every program that gives all memory device addresses: vkd3d-proton, VMA with BDA); two read-only storage bindings
  promoted to writable beside a writable one can overlap each other. Then the leftovers: two writable bindings of one
  range; a draw reading what an earlier draw of its pass wrote through storage (split the WebGPU pass there).
  *Done:* each shape a `wg_test.c` scenario (as T3's), dEQP-VK's `buffer_device_address` and `ssbo` groups unchanged.
  *Start:* wg_cmd.c `scope_shadows`, `shadow_place`, `conflicts`, `program_for`; vk/README.md "Usage scopes".
- **R3. Render passes' replay** (M; review R2, R6, R7 with O7, R3 with O10, R8, R5, R9, R10): attachments of
  different sizes (Vulkan allows; WebGPU refuses: crop to the render area's common size); `LOAD_OP_NONE` taken as
  discard by the alias tracking (stale bytes stored over a mutable image's); layers past 32 of a pass ignored while
  `maxFramebufferLayers` is 256 (and a shift by 32 at view 31); a feedback copy of a packed-format attachment (no
  `packed` key on the twin) and its swizzle; a feedback copy of the wrong layer; transform feedback cut by a feedback
  copy's pass end; drawn resolves at every part of a colour-only suspended pass; non-indexed fans past 65,536 vertices
  dropped silently (warn, or draw in pieces). *Done:* a test each; the 4
  `renderpasses.*.r5g6b5_unorm_pack16.input.*self_dep*` (backlog "Packed 16-bit formats' leftovers") rechecked: R3 may
  be their cause. *Start:* wg_cmd.c `begin_rendering`, `feedback_copies`, `image_use`; wg_device.c `wg_view_twin`.
- **R4. Transfers** (M; review X1–X8, then T10's and T12's leftovers): one-row buffer↔image copies with a taller
  `bufferImageHeight` (an unaligned `bytesPerRow`: the submit lost); a drawn resolve into an sRGB-twin view (pipeline
  and view formats differ: lost); indirect indexed fans sized by the whole bound index range (past
  `maxStorageBufferBindingSize`: lost; six times the buffer per draw otherwise); multisampled copies of several layers
  (only the first); multisampled copies between sRGB twins converting values, not bits (likely T4's "3 sRGB-twin
  resolves not understood"); linear blits from padded compressed images; query readbacks overwriting queries the
  submit didn't end; multisampled packed copies. Then backlog "Copies WebGPU refuses" (a multisampled copy between
  formats: the storage round trip) and "Multisampled image clears" (X4 may be their cause). *Done:* a test each, the
  T4 `image.mutable` sRGB-twin cases and the clears in the list if they pass. *Start:* wg_cmd.c `copy_bt_replay`,
  web/venus-gpu.ts `layout`, `resolveByDraw`, `copyMultisampled`, `copyPacked`, the fans' compute pass.
- **R5. The translator's defects** (M; review C1–C7): **C1 first** (S, corruption: a variant copies its base's
  depth-less fragment module, `fs_no_depth`, so it draws with the unkeyed module and its id is released twice, then two
  objects share a worker id; the fix is zeroing `fs_no_depth` and `fs_no_depth_of` in `wg_program_variant`); one depth
  texture sampled with and without comparison in a stage (invalid WGSL: PCSS shadows, DXVK's and vkd3d's
  `mipLodBias`); a sampler shared by an integer gather and a float sample filters nearest; a border across levels
  skewed by the WebGPU sampler's LOD clamps; a cube bound as its faces leaking into other pairs and stages; a keyed
  print's failure falling back to the unkeyed module (an invalid pipeline in place of a refusal); C7's minors
  (location 7 for depth, inter-stage variable counts, `wg_deserialize`'s bounds on a corrupt cache, small floats'
  rounding, the bias's clamp). *Done:* a `tests/wgsl.test.ts` row or a `wg_test.c` scenario each. *Start:*
  wg_shader.c `wg_program_variant`, `keyed_text`, `fragment_without_depth`; wgsl_print.c; wgsl_sampler.c.
- **R6. Memory and objects** (M; review O1–O3, O11, O12, O14–O17, H4, then backlog "Memory" and "External memory's
  leftovers"): an import aliasing an earlier export ignores `DEVICE_ADDRESS_BIT` (address 0, or writes into another
  memory: VMA with BDA); an alias no longer rebound by map and unmap once the original vkr memory is freed (vkr's
  patch); a large binding number overflowing the set layout's 32-bit size (a renderer-wide crash: the guest's input);
  device-local allocations past the heap succeeding then failing silently, and T2's "an allocation past the arena
  loses the context" with them; an inline uniform block past its set's buffer; the minors; a snapshot's blob resources
  that outlive their context and its capsets rebuilt without Venus (H4, with snapshots refused while a Venus context
  exists). *Done:* a test each (wg_test.c, tests/venus-renderer.test.ts); `memory.*` and `api.external.memory.*`
  unchanged. *Start:* wg_device.c `wg_AllocateMemory`, vk/patches/vkr-wasm.patch, wg_descriptor.c `layout_create`.
- **R7. What's advertised** (S–M; review O5, O6, O8, O9, then backlog "Sample counts Vulkan wants but WebGPU lacks"
  and "API 1.3's required features"): the bar's rule, what's advertised must work. `textureCompressionBC` without
  `BC1_RGB_*` (refused at creation, which Venus's asynchronous creation turns into a lost context: an RGBA texture whose
  alpha reads 1, or BC off); `shaderStorageImageExtendedFormats` on adapters without tier1, whose 16-bit normalized
  formats don't exist there (off there, or those formats as words); the memory pad and `maxMemoryAllocationSize`
  wrapping; Vulkan 1.3's 1 GiB minimums on adapters with WebGPU's default buffer size; the sample counts.
  `api.info.vulkan1p2_limits_validation.general` fails on SwiftShader (the review's run in a cloud session): 9 limits
  under Vulkan's minimums, from the adapter's (`maxPerStageResources` 49 of 53, `maxDescriptorSetSamplers` 16 of 48,
  `…UniformBuffers` 26 of 36, `…UniformBuffersDynamic` 7 of 8, `…StorageBuffers` 8 of 12, `…SampledImages` 16 of 48,
  `…StorageImages` 4 of 12, `maxVertexInputBindings` 8 of 16, `maxMemoryAllocationSize` 64 KiB short of 1 GiB); the
  set-wide ones need no more than a stage's ×5 stages, the others an emulation or the adapter's real limits asked for. *Done:*
  dEQP-VK's `api.info.format_properties.*`, `api.info.vulkan1p*_limits_validation.*` and
  `api.info.image_format_properties.*` passing on SwiftShader and the M4, whatever is taken off said in vk/README.md.
  *Start:* wg_caps.c, wg_format.c, web/venus-gpu.ts `gpuFeatures`; tests/venus-renderer.test.ts's caps test.

An out-of-context review again after R1–R4 (the passes' and the worker's areas), over what they change.

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

- **T20. What tier 2's emulations cost a program** (M; T3's to T12's "the cost unmeasured", each task's leftover):
  the shadow copies of usage scopes, the copies between view formats, pulled vertices, the sampler variants' compile
  and their fetches, storage images as words, the drawn resolves and packed copies, all measured only on dEQP-VK or
  not at all. A program that meets each (ffmpeg's and libplacebo's filters for views and words, DXVK or a VMA program
  that writes storage for the shadows, vkd3d's tests for pulling, a replayed capture with border or mirror-once
  samplers), its frame's GPU-worker and guest time measured with the path and with the case forced away, by
  bench/run.ts's rules. *Done:* a table in REPORT.md, the costly ones filed or fixed.

### Tier 4: breadth (each its own task when a program asks for it)

vkd3d's 11_1 and 12_0 gaps (256 bytes of push constants, multi-draw indirect, vertex attribute divisors, storage
images without a format, min/max reduction, multiple viewports), then geometry and tessellation as compute
pre-passes; transform feedback's leftovers; YCbCr's 10-bit formats; snapshots while Vulkan is in use; Dawn in the
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
T2's `wg_complete` trap).

## The gate (the track's end)

- dEQP-VK's pass list grown by every task, passing on SwiftShader in CI, on the M4, and on NVIDIA in one user run.
- T1's census again at the end: the not-passed share of supported cases, by cause, against T1's.
- Every advertised feature backed (or no longer advertised).
- The programs' replays within their tolerances; mpv and VK0's scene no worse than VK3's numbers on each host.
