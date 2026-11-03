**Approved by the user (2026-10-29).** Drafted by the session that closed VK3. Covers **VK4** of the Vulkan plan
([docs/plans/graphics.md](docs/plans/graphics.md) §3), M8's graphics track; how Vulkan works now is
[docs/graphics.md](docs/graphics.md) "Vulkan through Venus".
**Updated with the user's OK (2026-11-01)**: tiers 1 and 2 done and summarized; the out-of-context review's
findings and the leftovers that drop work as tier 2b (R1–R7, before tier 3); T20 and the leftovers after tier 3.
**Updated at the user's ask (2026-11-02)**: tier 2b done and summarized in the done table.

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

### Done: tiers 1, 2 and 2b (2026-10-29 to 2026-11-01)

Each row's outcome in full is its section of bench/vulkan/REPORT.md ("VK4 T<n>") and its commit; what each left is in
docs/backlog.md "The Vulkan driver's gaps" (the entry named) and, where it is a defect or drops work, in the tasks
below. dEQP-VK's pass list went 4,725 → 26,002 over tiers 1 and 2, every new case passing on SwiftShader and the M4.
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

### Tier 3: performance on real workloads

- **T13. What a guest's synchronous call waits for** (done 2026-11-02 with T14: GSK's ~80 synchronous `vkAllocateDescriptorSets` a frame each waited a poll turn, 1.33 ms on the Mac; the pump's turns timed by a ticker worker, 0.08 ms there; iconscroll 6.5 → 33 frames/s on the M4, past GL's 28–32; VK0's scene no worse. Left: backlog "GTK4 on Vulkan: the bar met on the M4, the default not taken") (M): GSK on Vulkan runs iconscroll at 9 frames a second against
  GL's 28 with the guest 11% busy, waking ~1,800 times a second: a frame waits on ring round trips or fences, which
  any program with synchronous Venus calls pays. Find which calls (a ring trace, `VN_DEBUG`) and shorten them. This
  decides GTK4 on Vulkan and so the default. *Done:* iconscroll at GTK4's bar (REPORT.md G) or the cause measured
  and filed. *Start:* backlog "GSK's Vulkan renderer on Venus misses GTK4's bar", REPORT.md "VK3 L7.3".
- **T14. The guest's submit path** (done 2026-11-02 with T13: of 9 execbuffers a frame, 6 are 3 fenced submits' two each, Mesa 26's fences being DRM syncobjs with no feedback path, 1 a ring notify, the rest sway's; the guest's CPU a frame in GTK4's frames 2.01–2.08 → 1.91–1.96 ms, GL's; rings kept active no gain) (M): 9 execbuffers a frame against virgl's 4 (GTK4's frames +11%), a fenced
  `SUBMIT_3D` every two frames through the virtqueue since VK2's external fences. Which Vulkan calls make them, and
  whether the feedback path can serve. *Done:* the guest's CPU a frame measured before and after (bench/run.ts
  rules). *Start:* backlog "Venus's submit path costs the guest", "The guest fences each frame".
- **T15. Venus's submits ~2 ms later on NVIDIA** (M, needs the user's runs): a bundle carrying the page at several
  of the 34 commits between 4fdc69fb and c8087cb0, run as alternated arms in one session, or Dawn's trace categories
  at both. *Start:* backlog entry of that name, REPORT.md "VK3 L9a".
- **T16. Imports without rewrites** (done 2026-11-03: each virgl resource a texture of its own, an import writes nothing; mpv imports a surface once a picture anyway, so 600 KB a frame stay, the import's GPU-worker time a frame 0.22 → 0.18 ms on the M4. Left: backlog "Imports' gaps") (S–M): every video frame's planes are written again (~0.2 ms and 0.6 MB a frame
  at 480p, ~3 MB at 1080p); a Venus texture per resource written only when its picture changes. *Done:* mpv's GPU
  worker time a frame before and after. *Start:* backlog "Imports' gaps".
- **T17. Pipelines' loose ends** (done 2026-11-03: render pipelines made at creation lose, cold vkQuake 269 → 26 frames/s on the M4 (100 made, 8 drawn), so off by default behind `?gpu=vkpremake=on`; the shader store deflated (vkQuake's 7.4×), on the Machines page's storage line with a clear, its budget a Preference of 8–64 MiB. Left: backlog "Pipelines' loose ends") (S each): pipelines made at `vkCreateGraphicsPipelines` (a first frame's stalls),
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
