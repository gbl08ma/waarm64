# VK3 handover

The notes that carry VK3 ([VK3-KICKOFF.md](VK3-KICKOFF.md)) from one loop to the next. Newest state first. Each loop
adds a "State (<date>, after Ln)" section on top of the states, and marks its bullet in "The plan" done.

## What the next NVIDIA run must answer

Kept by the supervisor. Each loop that needs an NVIDIA number extends `bench/vulkan/nvidia.sh` (one command, one
results tarball) and adds its question here.

The command (on the dev VM, from a **clean** checkout at the commit: `git pull`, the images built, the wasm and
`vk/build.sh` rebuilt, then `bench/vulkan/nvidia-bundle.sh` makes `target/vk2-nvidia-bundle.tar`, ~3.4 GB; copy it
aside, e.g. `target/vk3-nvidia-bundle-<commit>.tar`, before a loop rebuilds; check its BUNDLE.txt names the commit
without "with uncommitted changes"; on the desktop, in a checkout at the same commit):

    bench/vulkan/nvidia.sh page <the bundle> ~/webpc-vk2

(~45 min whole; `VK2_STEPS="…"` runs some steps only, `VK2_STEPS=l2b` L2b's ~16 min; results: `~/webpc-vk2/vk3-nvidia-results.tar.gz`, which the user
puts in the repo's root.)

**Answered by the run of 5b9654ac (2026-10-26; REPORT.md "VK3: the NVIDIA run after L2", `results/vk3/nvidia/`):**
L1's questions all yes: vkcube and mpv right on the page in every way, `auto` settled on bitmap, bitmap and canvas
checked right, no window on the prime blit; the user saw no black screens. mpv at its bar (0 drops, the guest 11–12%).
L2's: the timers as expected (4.07 ms nested, 0.31 ms the pump), but Dawn on NVIDIA's Vulkan says a trivial submit
done in 0.10–0.15 ms, nudged or not; the pump took ~1.1 ms off every size; **Venus at 1 fish 2.5 ms against virgl's
1.5: the bar not met**, with WebGPU's done in the scene 3.4–3.9 ms a submit. Ahead at 1,000 fish and the toolkit.

**Answered by the run of f55eacd7 (2026-10-26; REPORT.md "VK3: the NVIDIA run after L2b", `results/vk3/nvidia-l2b/`):**
L2b's: a lone real pass is noticed done ~2.2 ms after it ends (0.03 ms of GPU; 1.2 ms nudged; at once while submits
keep coming); **the scene's pass costs ~0.9 ms of GPU** (`vkgputime`, per pass; the M4's 0.41); `vknudge=0.25` 2.4 ms a frame at 1 fish, no nudges 3.1, the default 2.5, virgl 1.5: the bar still not met. The
trace (134 MB, `bench/results/local/vk3-nvidia-l2b/`, not committed) wasn't summarized: its summarizer overflowed the
stack. L3's: async pipelines 3.7× sooner, WebGL's longest wait 2 s → 74 ms; vkQuake warm across a restart 0 misses,
25 ms of translation, Chromium's pipelines kept in the profile (74 ms for 17). Also: nvidia.sh doesn't clear
`~/webpc-vk2/results` before a run (the earlier run's `venus-timeout` arms came along).

**Open for the next run:**
- (L4) `mpv-frames-default`: as the page has it, libplacebo complains "Failed creating FBO texture" and VA-API's frame is
  byte for byte the software one (`vkva ~ vkno` 0) — the same as on the M4?
- (L4) `mpv-frames-all`, `mpv-frames-all2` (`?gpu=vkformats=all`: libplacebo's advanced path): no complaint; is VA-API's
  chroma right (`vkva ~ vkno` near 0) or green (~2.28 M bytes off by more than 24, mean ~77) in either session? Which
  FBO family did NVIDIA's adapter give (the log's `venus` line has no format; `texture-formats-tier1` in
  `adapter.json` says `rg16float`)?
- (L4) `mpv-all`: mpv on Vulkan with the advanced path on meets the bar (no drops, the guest no busier than 19–27%)?

## The plan (loops; the supervisor may reorder)

The kickoff's eight steps, one loop each unless a loop says otherwise:

- [x] L1 (done 2026-10-26): presentation on NVIDIA (why the bitmap way is black; a run-time check of the first copy and the readback
  fallback; nvidia.sh's presentation check).
- [x] L2 (done 2026-10-26): the fence's round trip (instrumented on every host; the pollers' `setTimeout(0)` first; the bar: Venus at
  1 fish no slower than virgl on any host). Supervisor's note after L1: VK2's NVIDIA scene numbers ran with the
  guest's WSI on Mesa's prime blit (vendor 0x10de: an extra copy into a linear buffer a frame), so part of the ~4.5 ms
  floor may be that path, not the fence. Split the two first: the scene's frame with `?gpu=vkvendor=nvidia` against
  without, on the M4 and SwiftShader, before blaming the pollers; the next NVIDIA run then shows the floor without it.
- [~] L2b (added by the supervisor after the NVIDIA run of 5b9654ac, runs after L3; **scripted 2026-10-26, waits on the
  user's run**: "What the next NVIDIA run must answer"; then a fix behind the switch the run picks, or the bar
  re-judged): **Venus at 1 fish on NVIDIA:
  2.5 ms a frame against virgl's 1.5.** The poller is no longer it (fence − done ~0.1 ms), nor Dawn's slow look (a
  trivial submit's done there: 0.15 ms); a scene submit's done is 3.4–3.9 ms though the GPU works ~0.3 ms a frame.
  Find what's in the scene's submits that a trivial one hasn't: extend `bench/vulkan/fence.ts` with submits shaped
  like the scene's (a render pass with a draw, the bitmap/share copy, a `mapAsync`, `writeBuffer` uploads of the
  scene's sizes, two queued) to see which one makes done slow, and time each part of a submit in the worker
  (encoding, `queue.submit`, done). Try what the M4 and SwiftShader can't show only through nvidia.sh, behind a
  switch with the current way as the default. Script a Chromium trace of the scene (JSON format, see memory/backlog:
  `--trace-startup-format=json`, categories gpu, dawn, viz) as an nvidia.sh step, and the variants as scene arms.
  The bar: Venus at 1 fish no slower than virgl on NVIDIA; if it needs another user run to settle, script it and
  move on.
- [x] L3 (done 2026-10-26): pipelines made asynchronously, WGSL cached by SPIR-V hash across runs.
- [-] L2c (added after the NVIDIA run of f55eacd7; **stopped 2026-10-26 by the user's decision**): the 1-fish gap on
  NVIDIA (2.4–2.6 ms a frame against virgl's 1.5) is parked: 1 fish isn't representative of real workloads, and the
  user suspects NVIDIA's driver latency or its GPU leaving the low-power state slowly. Venus is well ahead of virgl
  there at 1,000 fish and the toolkit (5.5 against 8.8 ms, 3.2 against 6.4). So the gate's scene clause ("no more a
  frame than virgl at every size") is held at 1,000 fish and the toolkit only, unless the user reopens it. Kept from
  L2c: nvidia.sh clears `results/` before a run (22e10916). Its other findings are in REPORT.md "VK3: the NVIDIA run
  after L2b" and the backlog (bind groups remade each frame).
- [x] L3b (done 2026-10-26): **`scripts/ci-machines.sh` passing again.** The kept-snapshots test's off-the-record
  profile ran out of room; it runs on an on-disk profile now (State after L3b).
- [~] L4 (2026-10-26: **reproduced and narrowed, not found; stopped for the user's call**, "State after L4"):
  libplacebo's advanced path (`float32-blendable`; the M4's green VA-API chroma; tier1's storage formats). The formats
  stay held by default, `?gpu=vkformats=all` takes them; the NVIDIA run's questions above.
- [ ] L4b (the user's decision, 2026-10-26: chase the green, **structured and methodical**): one fresh subagent per
  step, serial, each time-boxed, each reading and extending "The green: investigation log" below, the supervisor
  reviewing and re-ranking between steps. Not parallel: the green is timing-sensitive on the Mac's one GPU (runs side by
  side would change the rate), and each step must know every theory already tried. Steps: L4b-0 the harness, the
  baseline and an independent review of L4's evidence (re-ranking the leads); then one step per lead in the log's
  order. Ends when the cause is found and fixed (the advanced path on by default, if right everywhere), or when the
  ranked leads are spent: then the log says what's left and the supervisor takes it to the user.
- [ ] L4c (the user, 2026-10-27: **fix the static review's findings first, then re-measure**; the experiments resume
  only if the green persists). The review: `git show origin/review/venus-green:VENUS-GREEN-REVIEW.md` (78d08509, a
  fresh agent, read-only, of the picture's path). Serial loops, each starting with tests that fail today:
  - [x] A (done 2026-10-27, "State after L4c-A"): finding 1 (the window's dirty pages taken by one device and lost to
    the others; completion serials per device matched across devices), and "the last bytes of an odd-sized memory
    never uploaded". Then green.sh: **0 green of 20 bare** against the pooled base rate (~8 of 31 so far).
  - [x] B (done 2026-10-27, "State after L4c-B"): finding 2 (a page's upload overwriting GPU-written bytes of an
    in-flight submit; completions overwriting CPU writes made since). Then green.sh: **0 green of 12 bare** (A+B).
  - [x] C (done 2026-10-27, "State after L4c-C"): finding 3 (the import's ordering: the readback before the picture
    lands, `forget` against the deferred `bind`/`plane`, the `blob-ctx` attach against the ring) and "the import maps
    outlive resets".
  - [x] D (done 2026-10-27, "State after L4c-D"): findings 4 and 6 (the lost fragment stage: padding in the link hash,
    a program of both stages' when they differ; load ops NONE and partial DONT_CARE) and "suspended and resumed passes".
    No green.sh: A settled it (0 of 32).
  - [ ] E, F (after the green is settled, before L5): ~~finding 5 (the core's page-crossing store: the JIT's rules)~~
    (E done 2026-10-27, "State after L4c-E"), and the review's other real defects.
- [ ] L5: the translator's missing adapter features (`subgroups`, `shader-f16`, read-write storage with `tier2`).
- [ ] L6: the driver's gaps from dEQP-VK (per-face stencil, occlusion queries, texel buffers, depth/stencil copies,
  dEQP-VK on the Mac's GPU).
- [ ] L7: §4's emulated rows in order (Dawn's: indexed descriptor arrays, sample-rate shading; ANGLE's ES3: provoking
  vertex, >12 UBOs, transform feedback; vkd3d's draw parameters; GTK4's YCbCr with modifiers last). Likely several loops.
- [ ] L8: the track's end (REPORT.md's VK3 section, docs, plan §6/§7, the final NVIDIA run scripted).

## The green: investigation log (L4b)

Kept by L4b's steps: each step reads all of it first, and adds its row and findings before it ends. The supervisor
re-ranks "Leads" between steps. Facts here are measured; say how (sessions, the JSON).

**The symptom** (L4; REPORT.md "VK3 L4", `results/vk3/l4/green-sessions-m4.json`): on the M4 with `?gpu=vkformats=all`,
the session's first mpv on Vulkan with VA-API (`--vo=gpu-next --gpu-api=vulkan --hwdec=vaapi`) shows chroma = 0 in ~1/3
of fresh sessions (7 of 23 bare), with either FBO family; byte for byte VK2 L7's green picture, and the picture of an
import that never writes chroma. Later mpv runs in a session are right. It persists through a re-render of that frame.
Never on SwiftShader. Not seen with the formats held (the default).

**Established by L4 (to re-check, not to trust blindly):** the worker's calls and the 12 WGSL modules are identical in
green and right sessions; each bind writes the same non-zero bytes; completions put back nothing the CPU wrote;
WebGPU's orderings in isolation are right on Metal (`upload-race.ts`). Any probe hides it: 0 of 22 with a few µs of CPU
per bind, 0 of 22 with extra GPU work, 4 of 7 with a JS-only trace.

**Method** (binding for every step):
- **Statistics.** At a base rate of ~0.3, 12 sessions with no green happen by chance ~1.4% of the time
  (0.7^12); one green in a run disproves "this fixes it" at once. A change counts as "hides or fixes" only at 0 of
  ≥12, confirmed by a second 12. A rate change counts only with the counts given (k of n) for both arms, alternated
  in one sitting.
- **Hiding is not fixing.** Any perturbation hides it, so a change that makes it go away proves little unless it also
  explains the mechanism. Prefer tests that **raise** the rate (a delay injected at one place, without reading data)
  towards a deterministic repro; a deterministic repro, then bisected, beats any number of hiding tests.
- **One variable per arm**; the bare arm alternated with it in the same sitting (the Mac's state drifts).
- **Time box** per step as its brief says; when it runs out, write what was learned and stop.

**Leads** (L4b-0's ranking, after reading the import, bind and upload paths; each ~12 bare + 12 arm sessions, alternated, ~50 min):
1. **Order (`twice`, then `swfirst`):** is the green tied to the session's first run (cold host and guest caches, submits
   held for async pipelines) or to VA-API on Vulkan any time? Cheapest and most informative; it splits the rest.
2. **Held submits (amplify):** a knob that delays the async pipelines' readiness (e.g. 50 ms) without reading data, to
   see whether the rate rises. `web/venus-import.ts`'s binds and pictures go through `later`, but `forget` (virgl unref)
   and `renderer.unrefResource` run at once, and a held bind reads the virgl texture back at drain time, not at call time.
   Then `?gpu=vkpipelines=sync` (L4's c).
3. **The LUT / staging uploads:** `--cscale=bicubic` (L4's a), then a record of `upload()`'s dirty pages (vk/driver/wg_cmd.c)
   kept in memory, compared green vs right. Note that `upload()` consumes the watch's pages once per submit, for memories
   with a GPU buffer only.
4. **Wait-before-signal:** wg_sync declares `VK_SYNC_FEATURE_WAIT_PENDING`, and a wait on a value not yet submitted counts
   as met (the submit runs before its signaller). Cheap check: count such waits in the driver (a counter, no data read).
5. L4's b (libplacebo's trace log in a green session): perturbs; last.

**Tried** (step, theory, arm, result k/n, conclusion):

| step | theory | arm | result | conclusion |
| --- | --- | --- | --- | --- |
| L4 | baseline | bare, `vkformats=all` | 7/23 green | the rate |
| L4 | worker CPU probe | a scan of a few µs per bind | 0/22 | hides (not evidence of cause) |
| L4 | GPU probe | extra GPU work | 0/22 | hides |
| L4 | JS-only trace | trace of calls | 4/7 | doesn't hide; calls identical green/right |
| L4b-0 | baseline at 2f229f0a | bare `vkformats=all` (green.sh, alternated with `held`) | 1/8 | the rate today is lower than L4's 7/23 (or drifts by sitting); the green is L4's rg16float bytes exactly (2,279,070 off), and the page's screen agrees |
| L4b-0 | control | `held` (formats held, the default) | 0/8 | as expected |
| L4c-A | finding 1 fixed (the window's pages to every device, serials global, odd sizes whole) | bare `vkformats=all` at e3d4cd46 | 0/20 | fits a fix (chance ~0.3% at 0.25); the second device during mpv's first run not observed directly; `results/vk3/l4c/a-green.jsonl` |
| L4c-B | confirm after A+B | bare | 0/12 | at 4f76f3e2 (finding 2 fixed too); with A's 0/20: 0 of 32 since A; `results/vk3/l4c/b-green.jsonl` |

**The harness (L4b-0):** `ARMS='bare:vkformats=all|held:' N='15 8' bench/vulkan/green.sh <results.jsonl> [budget s]`: fresh
sessions on the Mac (mpv-frames.ts through sway-mac.sh), arms alternated, each classified green/right/odd/error from
mpv's screenshot and the page's screen (`__webpcGrab`, read only after mpv's screenshot exists) against software
decoding, one JSON line each; resumable, one call ≤ ~570 s (4 sessions). ~116 s a session. Harness-only knobs:
`swfirst` (software decoding's mpv first) and `twice` (VA-API again after software decoding: `verdict2`). The baseline:
`bench/vulkan/results/vk3/l4b/baseline.jsonl` (stopped by the supervisor at 8 + 8 sessions, short of the brief's 15).

**L4b-0's doubts about L4's "established" list:**
- The hiding arms weren't alternated with bare: the scan arms (0/22) ran as loops a, c–e, all with `rg32float` FBOs,
  and the bare greens came mostly from other loops (i, j: 5/16, `rg16float`). Greens cluster by loop (j: 3 in a row), and
  today's 1/8 is under 7/23. So "any probe hides it" is confounded with time and the FBO family; not established.
- "Each bind writes the same non-zero bytes" and "completions put back nothing" were measured only by the probes that
  never showed green (0/22 scan, 0/3 detector): never observed in a green session.
- "Calls identical" covered imports, textures, views, destroys, shaders and held submits, not `gpu_write` (the dirty
  pages uploaded and their bytes), copies, bind groups, samplers or pipeline descriptors: the LUT and staging path is unseen.
- "Only the session's first mpv on Vulkan": VA-API on Vulkan never ran second in a session (the later arms were vkno, GL),
  so this might just as well be "VA-API on Vulkan, any time" (`swfirst` and `twice` test it).
- The green bytes are exactly those of chroma = 0 per FBO family (2,280,642 rg32float, 2,279,070 rg16float). A zero chroma
  texture, all-zero LUT weights or a chroma FBO never rendered would all give exactly these: "the import never wrote
  chroma" is one candidate among several.


## State (2026-10-27, after L4c-E)

- **Done: finding 5, confirmed** by `core/src/mmu/tests.rs` `watched_page_crossing_store_after_overflow` (a look
  between `span`'s translations and the store lost the first page; it failed on the old code, page 63 missing).
  Fixed in `Mmu::span`: when the second page's record overflows the 64, the first page is translated again (only the
  page-crossing branch changed; no JIT code, no hot path, no benchmark; steps.txt unchanged). watch.c gained a phase
  over 80 pages and one of STP Q, STR Q, ST1 across pages, DC ZVA, STLR, CASP, STXP, STTR (docs/devices.md).
- CI: ci.sh, ci-deqp-vk.sh OK. F (the review's other real defects) is next.

## State (2026-10-27, after L4c-D)

- **Done: findings 4, 6 and "suspended and resumed passes", all confirmed** by tests that failed on the old code
  (tests/venus-driver.test.ts "passes: …", wg_test.c `wgt_link`, `wgt_pass`): stages with different programs drew with
  no fragment stage (WebGPU refused the pipeline); NONE and a partial DONT_CARE cleared; a resumed pass cleared again
  and a suspending DONT_CARE discarded. Fixed: resources hashed field by field, `wg_program_merge`, `load_op`/`store_op`
  (vk/README.md). Found on the way: a partial render area's CLEAR cleared to zeros (its clear rect's colour nested).
- **dEQP-VK:** KHR/EXT_load_store_op_none advertised; 119 cases newly pass (60 resumed, 57 op-none, 2 low_res_z),
  172 added to tests/deqp/vk.txt; 34 op-none failures in the backlog. CI: ci.sh, ci-debian.sh, ci-deqp-vk.sh OK.
  No hot path changed (no benchmark).

## State (2026-10-27, after L4c-C)

- **Done: finding 3 (a, b, c) and "the import maps outlive resets", all confirmed** by tests that failed on the old
  code (tests/venus-import.test.ts, tests/virgl-video.test.ts "CallQueue: Venus's calls…"). web/venus-import.ts orders
  its own writes (`later`), skips the readback while the picture is pending, drops a held bind whose resource ended
  since its call, routes `unref` through `later` and prunes `textures`, and forgets everything at `reset`/`load`; the
  call queue runs Venus's making calls (attach included) past waiting virgl calls. The `vaSyncSurface` claim corrected.
- **Not fixed:** a draw queued before its picture lands still samples the texture's earlier bytes (nothing makes the
  guest wait), and the device's attach and the polled ring stay two paths (vk/README.md "Imports"). Found on the way
  (backlog): Venus's contexts outlive a virtio reset. mpv on SwiftShader: vkva ~ vkno as VK2 L6 (243 > 24, mean 0.026).
- CI: ci.sh, ci-debian.sh, ci-machines.sh, ci-deqp-vk.sh OK. No hot path changed (no benchmark).

## State (2026-10-27, after L4c-B)

- **Done: finding 2 fixed, both directions** (4f76f3e2), confirmed by tests that failed on the old code
  (tests/venus-driver.test.ts "in flight: …", wg_test.c `wgt_fl_*`): a page uploaded while a copy into it was in flight
  put the old bytes back on the GPU (the next copy read them); a completion's readback of a row-gapped range overwrote a
  byte the guest wrote meanwhile. The fix (each in-flight range keeps a base; vk/README.md "The driver", "Completion").
- **Worth not re-discovering:** Venus's query feedback fills a slot and copies results into it in one submit; a first
  version of the fix took the fill's bytes for the guest's and mixed timestamp bytes (the scene's GPU ms became 1e11).
  The "ordered" check covers it. Read the scene's GPU ms as a correctness check after any completion change.
- **Cost:** none on the scene at 1,000 fish (M4, rounds overlap: `results/vk3/l4c/b-scene-1000-*.json`). **Green: 0 of
  12 bare** after A+B (`b-green.jsonl`; 0 of 32 since A). CI: ci.sh, ci-debian.sh, ci-deqp-vk.sh OK.

## State (2026-10-27, after L4c-A)

- **Done: the review's finding 1 and "the last bytes of an odd-sized memory never uploaded" are fixed** (e3d4cd46).
  Both confirmed against the code first, then by tests that failed on the old code (tests/venus-driver.test.ts "two
  devices: …", vk/driver/wg_test.c `wgt_two_*`: two devices with memories in one window and a write-watch of the
  test's own whose pages the page marks):
  - a page device 1 wrote, after device 0 submitted, read back stale (old: byte 0 differed);
  - device 1 and device 0 submitting at once with equal per-device serials: device 1's readback lost (byte 0);
  - a 4,099-byte memory through an R8 image: its last 3 bytes zero (byte 4096).
- **The fix** (vk/driver/wg_cmd.c `take_pages`, `upload`): each submit's look at the watch ORs the pages into every
  registered device's bitmap (`wg_device.pages`, a bit a page of the window, 8 KiB at 256 MiB, made at the first look);
  a device's upload walks only its in-window memories' page ranges and clears its own bits. Serials are global; a
  17th device fails `vkCreateDevice` (it used to be unregistered: its submits would never complete). Uploads go to
  `mem->size` (4-aligned) instead of `vk.size & ~3`. vk/README.md "The driver" and "Completion" say so.
- **Cost** (the M4, Chromium 153.0.8010.12, VK0's scene at 1,000 fish, WARMUP 200, FRAMES 300, alternated): before
  2.447, 2.459, 2.548 ms a frame, after 2.481, 2.533, 2.493: the rounds overlap, no difference
  (`results/vk3/l4c/a-scene-1000-*.json`).
- **The green: 0 of 20 bare sessions** (`ARMS='bare:vkformats=all' N=20`, `results/vk3/l4c/a-green.jsonl`), against a
  pooled ~8 of 31 before. 0 of 20 at 0.25 happens by chance ~0.3%: finding 1 fits as the cause (libplacebo's LUT
  written by the CPU, its pages taken by another device's submit). Not observed directly: that a second Venus device
  is alive during mpv's first frames (the review's "Confirm": count `wg_device_register` adds). The method asks for a
  second 12 to call it fixed; the `held` arm wasn't run.
- **Review findings fixed so far:** 1 and "the last bytes of an odd-sized memory". Open: 2, 3, 4, 5, 6 and the other
  real defects (loops B–F).
- **CI at the commit:** ci.sh OK (442 s), ci-debian.sh OK (383 s), ci-deqp-vk.sh OK (243 s).

## State (2026-10-26, after L4)

- **Not done: the M4's green VA-API chroma is reproduced and narrowed, but its cause isn't found**, so `float32-blendable`
  and tier1's storage formats stay held back by default and mpv on Vulkan renders as in VK2 L6 (REPORT.md "VK3 L4",
  JSON in `bench/vulkan/results/vk3/l4/`). **The user's call** (below): ship the advanced path anyway, keep it off, or
  have a later loop go on with the leads.
- **What libplacebo needs:** its 1- and 2-component FBO formats must have every capability of the 4-component one
  (`rgba16float`: renders, blends, filters, storage). So `r16float`/`rg16float` need tier1's storage, or
  `r32float`/`rg32float` need `float32-blendable`. Without either: "Failed creating FBO texture! Disabling advanced
  rendering", then "Failed dispatching scaler.. disabling". The M4 has both features, SwiftShader `float32-blendable` only.
- **Built:** the driver takes both features (`WG_FEATURE_FLOAT32_BLEND`; tier1's storage as a bit of its own,
  `WG_FEATURE_TIER1_STORAGE`, which also says `shaderStorageImageExtendedFormats`: VK2 said that feature without the
  formats' storage bit). The worker holds them back by default (web/venus-gpu.ts `HELD_FEATURES`). `?gpu=vkformats=all`
  passes them, `?gpu=vkhold=<feature>` holds one more. tests/venus-renderer.test.ts covers both settings (planted: an empty
  hold list, caught). Tools: `mpv-frames.ts` (`GPU_KNOBS`, `MPV_ARMS`, `PAIRS`, `SHOT2`, libplacebo's complaints, Venus's
  submits), `upload-race.ts`. nvidia.sh's `mpv` step runs mpv-frames as the page has it and twice with the advanced
  path, plus the gate once with it on (~+11 min: ~56 min whole). Not run end to end (no bundle built; the steps' commands
  ran on the M4 and SwiftShader).
- **The green:** on the M4 with the advanced path on, the session's first mpv on Vulkan with VA-API shows chroma = 0. It
  is VK2 L7's picture byte for byte, and also the picture with the import never writing chroma. It happens in ~1/3 of
  fresh sessions, with either FBO family; later mpv runs in the session were right. It persists for that frame through
  a re-render (debanding toggled, new FBOs, planes imported again) and mpv's screenshot. It never showed on SwiftShader.
  The worker's calls (imports, binds, textures, views, destroys, held submits) and the 12 WGSL modules are identical in
  green and right sessions. Each bind writes the same non-zero bytes. Completions put back nothing the CPU wrote.
  WebGPU's orderings in isolation are right on Metal.
- **It hides under any probe**: 0 green in 22 sessions with a CPU scan of a few µs in each bind, 0 in 22 with probes that
  add GPU work, against 7 of 23 bare and 4 of 7 with a JS-only trace (`green-sessions-m4.json`).
- **Numbers** (M4): formats held, mpv's VA-API frame = the software one (0 bytes), Vulkan vs GL within 4. Advanced path on
  (right sessions): VA-API = software (0), Vulkan's lanczos vs GL's bilinear 544 bytes > 24 (max 47). SwiftShader advanced:
  360 bytes > 24 (VK2 L7's). **The bar with the advanced path on: 0 drops, the guest 14, 13%** (default 14, 13%; GL
  12–13%), mpv's CPU 342–376 ms a second against 326–359.
- **Leads, ranked** (backlog "Imports' gaps"):
  1. libplacebo's filter LUTs: made once, at the first frame, from host-visible memory. They are the chroma-only object
     every later render reuses. Test: `--cscale=bicubic` (no LUT) in bare sessions. If that holds, look at the
     write-watch's view of the guest's stores into that memory (a store form that writes a page without marking it).
  2. libplacebo's trace log in a green session (`--msg-level=vo=trace`; perturbs, like any probe).
  3. The first frame's held submits against `?gpu=vkpipelines=sync`, though VK2 L7 saw the green before async pipelines
     existed.
  Each test needs ~10 bare sessions (~3 min each on the Mac; `/tmp/claude-501/loop2.sh` was the loop, not kept: a for
  loop over `sway-mac.sh` with `SCRIPT=../vulkan/mpv-frames.ts PAIRS='vkva~vkno'`).
- **Left:** the user's decision; the NVIDIA run's three mpv questions (above). dEQP-VK's list doesn't change: the formats
  aren't advertised by default, and CI runs on SwiftShader without tier1.
- **CI at the commit:** ci.sh OK (440 s), ci-debian.sh OK (396 s), ci-deqp-vk.sh OK (244 s). ci-machines.sh not run (no stored-machine code changed).
- **Worth not re-discovering:** see "Things worth not re-discovering" (L4's).

## State (2026-10-26, after L3b)

- **Done: ci-machines.sh green again.** `tests/page-snapshots.test.ts` "kept snapshots…" failed at a Restore ("is it
  full?") or at Suspend ("the browser's storage is full", the 420 s wait for `suspended`): both short writes to OPFS.
- **The cause: the remote disks' block cache (web/diskcache.ts, 2026-10-23) in an off-the-record profile.** Such a
  profile keeps OPFS in memory, where Chromium's sync handles come back short at ~0.8 GB while `estimate()` reports
  ~3.2 GB (docs/devices.md had it). The test's URL disk (served with a validator) is cached, the cache sizes its budget
  from that estimate, and with three snapshots, the forks and the suspended copy the profile passed its real room
  (`estimate()` read 0.76 GB used at the failing Suspend). Measured: the same test with `diskcache=0` passed (60 s);
  ci-machines last passed 2026-10-22, before the cache. Not a storage bug in snapshots or overlays.
- **The fix: the test runs on a fresh on-disk profile** (`launchPersistentContext` under tmpdir, removed after), as
  page-stored does and as a user's profile is; it checks all it did, and the cache stays on. Alone: 54 s.
- **Left for the backlog** (machines' loose ends, "Off the record, the remote disks' block cache crowds out
  snapshots"): a user in an Incognito window can meet the same; the snapshot and suspend writers could give the
  cache's stores up on a short write (`releaseStores`, as a guest's disk write does), or the cache stay small there.
- **CI at the commit:** ci-machines.sh OK (173 s, 5 of 5), ci.sh OK (443 s). ci-debian.sh not run: no page or storage code
  changed (the test and docs only).

## State (2026-10-26, after L2b)

- **Done: the tools for NVIDIA's run, scripted and run end to end on SwiftShader; no fix yet** (REPORT.md "VK3 L2b",
  JSON in `bench/vulkan/results/vk3/l2b/`). Nothing on the M4 or SwiftShader reproduces a 3.4 ms done for a frame
  submit: the bar holds on both (the M4's scene 0.85–0.89 ms at 1 fish, frame submits done in 0.95–1.04).
- **A wrong premise found**: "the GPU works ~0.3 ms a frame" (VK2's run, the plan's L2b) was the driver's CPU clock at
  replay: `vkCmdWriteTimestamp` writes `os_time_get_nano()` (vk/driver/wg_cmd.c `OP_QUERY`), so the scene's "GPU" line
  under Venus is the replay's span. The real GPU time in a Venus frame on NVIDIA is unknown; on the M4 it is 0.41 ms a
  pass (`?gpu=vkgputime`). The GPU's clocks at a light load are back among the suspects.
- **Built** (runtime: instrumentation and two A/B switches, defaults unchanged):
  1. web/venus-gpu.ts: a submit's parts in the stats (encoding = `gpu_encoder` → `gpu_submit`, `queue.submit`'s call,
     passes, draws; `workDone`/`workDoneMs` = the done of submits with a pass) and `?gpu=vkgputime` (each submit's first
     8 passes with `timestampWrites` into a reused query set, resolved and read after done; `deviceRequest` asks
     `timestamp-query` only then). web/venus-host.ts: `VenusTimes` carries them; `?gpu=vknudge=<ms>` sets the pump's
     nudge period (0: none). bench/gpu/guest-session.ts: `renderer.venus.perSubmit` (steady seconds); guest.ts logs a
     `venus a submit:` line.
  2. bench/vulkan/fence.ts `shapes`: frame-shaped submits (1080p pass, 120 draws with dynamic offsets, the scene's
     writes, a map, a staging buffer made per submit, nudged, the page's WebGL drawing, two queued, back to back),
     encoding / `queue.submit` / done / the pass's GPU ms each (`--enable-webgpu-developer-features` added for
     unquantized timestamps).
  3. guest.ts `TRACE=1`: a CDP trace (JSON; Playwright's `browser.startTracing`, not the protobuf startup format) of
     the first setting, `TRACE_MS` from `TRACE_AT`, plus `trace-<setting>-summary.json` (the GPU process's main
     thread).
  4. nvidia.sh: the shapes in `fence`; scene arms `venus-gputime`, `venus-nudge025`, `venus-nonudge` (1 fish) and
     `venus-timeout` dropped from the defaults; a `trace` step; `VK2_STEPS=l2b` = "fence scene trace". Ran whole on the
     dev VM (SwiftShader, `SIZE=320x180`, one round): ~10 min, tarball 3.4 MB (the 52 MB trace compresses well).
     **Expected on NVIDIA: `l2b` ~16 min; the whole default run ~45 min** (was ~40: venus-timeout's ~3 min out, L2b's
     arms ~6 min and the trace ~1.5 min in).
- **Numbers**: a scene frame on the M4 is ~2 submits, 48% with a pass (~120 draws at 1 fish), ~1.5 writes and ~32 KB a
  submit, no readbacks; the worker's encoding 0.054 ms and `queue.submit` 0.003 ms a submit (SwiftShader's VM 0.17,
  0.08). Shapes on the M4: a lone pass done in ~2.3 ms (GPU 0.14) but 1.0 with two queued (GPU 0.09): an idle GPU is
  slower to finish and to report; writes, a map, staging, nudges, WebGL change nothing. SwiftShader is CPU-bound
  (1080p pass ~4 ms); only the page's WebGL doubles a lone done there (shared CPU). M4 A/B, 3 rounds at 1 fish: the
  pump 0.85–0.89, `vknudge=0` 0.83–0.87 (the same), `vkgputime` 0.88–0.95 (its resolve/copy/map add ~0.15 ms to done).
- **Hypotheses** (REPORT.md "VK3 L2b", each with the run's answer above): (1) the GPU at a light load; (2) Chromium's
  looks at the device (each command batch polls, else a 1–2 ms timer every flush pushes back:
  gpu/ipc/service/command_buffer_stub.cc, webgpu_decoder_impl.cc); (3) the GPU process's main thread busy with GL or
  the compositor; (4) the submit's content; (5) Dawn on NVIDIA slow to signal a real pass.
- **Left**: the user's run; then a fix behind a switch (the default flipped only with NVIDIA's numbers and L1's
  presentation check intact). If (1) holds, the fix space is narrow (keeping the GPU busy is no fix): the bar may need
  the user's judgement. Not done: GPU timestamps in the driver itself (`vkCmdWriteTimestamp` still the CPU's clock;
  backlog "The Vulkan driver's gaps").
- **CI at the commit:** ci.sh OK (506 s), ci-debian.sh OK (381 s), ci-deqp-vk.sh OK (242 s). nvidia.sh `VK2_STEPS=l2b` whole on SwiftShader (above).
- **Worth not re-discovering:** see "Things worth not re-discovering" (L2b's).

## State (2026-10-26, after L3)

- **Step 0**: `nvidia.sh page` ran whole on the dev VM (SwiftShader) after L2: nothing broke (venus-run.ts's `share`
  printed as `[object Object]`, fixed); new hooks `VK2_SCENE_ROUNDS`/`VK2_SCENE_ARMS`; ~40 min expected on NVIDIA
  (5b9654ac). The supervisor then had the bundle of 5b9654ac built (`target/vk3-nvidia-bundle-5b9654ac.tar`) and the
  user ran it (above).
- **Done: pipelines made asynchronously, shaders kept across runs** (REPORT.md "VK3 L3", JSON in
  `bench/vulkan/results/vk3/l3/`; vk/README.md "Pipelines made asynchronously", "The shader cache"):
  1. **Async** (web/venus-gpu.ts): `create*PipelineAsync`; the id holds a `Later`. A submit setting a pipeline not ready
     is *recorded* (every command resolves its ids and copies what it reads of memory at its call: ids are reused) and
     held with all queue work after it (`later`: submits, writeBuffers, destroys, web/venus-import.ts's writes) until
     ready (`drain`); completions stay in order. web/venus-share.ts's `prepare` holds a compositor submit sampling a
     Venus image while anything is held (`idle`). The driver makes a render pipeline when its draw is *recorded*
     (vk/driver/wg_cmd.c `record_draw`), so it's usually ready by the submit. `?gpu=vkpipelines=sync` = the old way.
  2. **The store**: Mesa's vk_pipeline_cache with `ENABLE_SHADER_CACHE` (only that file), our `vk/wasi/disk_cache.c`
     as util/disk_cache (imports `gpu_cache_get/read/put`), `wg_serialize`/`wg_deserialize` (WGSL, info, the program's
     data and its *link*: stages find a shared program by it, `program_find`, also at compile, so a partial cache hit
     can't split a vertex/fragment pair), `WG_BUILD_ID` (vk/gen.ts: hash of vk/ sources) in the disk cache identity and
     in `pipelineCacheUUID`/`shaderBinaryUUID`; web/venus-cache.ts: IndexedDB `webpc-shaders`, the origin's, 32 MiB LRU,
     entries of another build dropped at load. `?gpu=vkcache=off` keeps none. The runtime's own
     `GetPipelineCacheData` is back (our override that returned a header only is gone): guest programs' caches carry
     shaders now.
- **Numbers**: async compile of 40 new pipelines on the M4 4.2 s → 0.92 s, and WebGL (the screen) no longer blocked for
  all of it (4.2 s → 50 ms); SwiftShader's done the same, WebGL's stall 0.8 s → 37 ms. vkQuake's replay: a second run
  translates nothing (753/753 found; module 228 → 9 ms on the M4, 271 → 12 on SwiftShader), state load 1.05 → 0.91 s
  (M4), 0.69 → 0.50 s (SwiftShader); across a browser restart on a kept profile the same (M4 1.00 s, 11 ms). Cold load
  on SwiftShader 1.73 → 1.23 s with async; the M4 the same (Metal's on-disk cache already had the shaders).
  vkQuake's entries: 3.5 MiB.
- **The gate holds** on the M4 and SwiftShader: a second run pays no translation its first did. What remains is the
  browser's compile: kept across a restart on Metal (Dawn's cache in the profile + Metal's: 18 ms for 17 pipelines),
  not on SwiftShader (1.4 s again). NVIDIA: the next run (`pipelines` step, above).
- **Tests**: tests/venus-gpu.test.ts (stand-in device: held submit, the work after it, order, completions; ready →
  not held; a refused async pipeline made at once; `vkpipelines=sync`), tests/venus-cache.test.ts (hit, miss, another
  build dropped, budget LRU across loads, a failing backend), tests/venus-driver.test.ts (no pipeline made at once; a
  second run on a new renderer over the same store: no miss, nothing new stored, the same pixels; wg_test.c
  round-trips a VkPipelineCache's data). Planted: the submit not held (caught), the build not checked (caught), the
  deserialized program not shared (caught: the second run's pixels).
- **CI at the commit:** ci.sh OK (442 s), ci-debian.sh OK (385 s), ci-deqp-vk.sh OK (243 s); ci-machines.sh 4 of 5:
  "kept snapshots…" failed at its first Restore with the storage-full error, the backlog's known failure of that test
  (since VK2 L7; its machines have no Vulkan, so the shader store never opens). nvidia.sh's `pipelines` step ran on
  SwiftShader from a bundle of the commit (~6 min).
- **The user approved (2026-10-26)** the store's budget, 32 MiB (nine vkQuakes), and its scope (the origin's, every
  machine's: entries are keyed by content, so the same program on two machines shares its shaders). Later: the budget
  configurable by the user, with the store on the Machines page (backlog "Pipelines' loose ends" (4)).
- **Left** (backlog "Pipelines' loose ends"): pipelines made at vkCreateGraphicsPipelines from static state (guessing
  the dynamic parts), compression in the store, the store on the Machines page, mpv cold/warm on the dev hosts.
- **Worth not re-discovering:** see "Things worth not re-discovering" (L3's).

## State (2026-10-26, after L2)

- **Done: the fence's floor found on the M4 and SwiftShader as two waits, both shortened** (REPORT.md "VK3 L2", JSON
  in `bench/vulkan/results/vk3/l2/`). **The prime blit explains none of it**: VK0's scene draws offscreen, so Mesa's
  WSI never runs; `?gpu=vkvendor=nvidia` changed nothing on either host (M4 0.83–0.87 against 0.83–0.91 ms; SwiftShader
  10.05–10.21 against 9.99–10.04). The waits:
  1. **The ring poller** was a nested `setTimeout(0)`: clamped to 4.4 ms a turn in a Chromium worker on Linux, 6.0 ms
     on the Mac. The guest's fenced `SUBMIT_3D`s (one every two frames now) retire at a poll, 4.3 ms after they were
     sent on the M4, and the scene at 1 fish took **3.0 ms a frame on the M4** too (VK2 L5's 0.93 isn't reproduced
     with today's build and guest, even at its short settings). web/venus-host.ts's **pump** now sleeps 0.25 ms on
     `Atomics.waitAsync`'s timeout between turns (0.49 ms a turn on Linux, 1.55 on the Mac), polls at once on a
     submit, a notify and a completion, and never nests a timer (each turn goes through the timer queue: no
     starvation). `?gpu=vkpoll=timeout` keeps the old way for A/B.
  2. **Dawn on Vulkan says done late**: a trivial submit's `onSubmittedWorkDone` 3.4 ms on SwiftShader, 0.3 ms with
     empty submits sent meanwhile (Chromium's GPU process looks at a busy device on a slow timer, at once when
     commands arrive); Metal 1.3 ms either way. The pump sends an empty submit at most every 1 ms while a submit is in
     flight (web/venus-gpu.ts `nudge`).
- **Numbers** (three alternated rounds): a submit's fence (`costs.ts`) on SwiftShader 3.06–3.24 → **1.01–1.03 ms**, the
  M4 0.32–0.33 → 0.32–0.36 (the same). VK0's scene on the M4: 1 fish **3.02–3.05 → 0.85–0.88 ms** (virgl
  0.87–0.96), 1,000 fish 3.17–3.26 → 2.50–2.55 (virgl 4.55–4.61), toolkit 2.84–2.87 → 0.81 (virgl 3.27–3.46); the
  guest's CPU a frame at 1 fish 0.72 → 0.41 (virgl 0.77). SwiftShader at 320×180 (at 1080p its rendering takes
  ~60 ms a frame either way): Venus 9.99–10.04 either poller, virgl 10.4–13.1. **The bar holds on the M4 and
  SwiftShader.** The breakdown with the pump on the M4 at 1 fish: the GPU's submit done in 0.96 ms, the guest's fence
  retired 1.05 ms after it was sent (old: 4.32), polls ~0.2 ms apart, ~260 nudges a second.
- **Instrumented on every host**: the render stats carry `venus` a second (web/venus-host.ts `VenusTimes`: submits,
  submit-to-done, done-to-completed, polls and gaps, nudges, the guest's fences and their sent-to-retired);
  `bench/gpu/guest-session.ts` sums it into `renderer.venus` (with `doneMsBySecond`), `guest.ts` logs it. New tools:
  `bench/vulkan/fence.ts` (timers and WebGPU's done in a worker; `mac-costs.sh` runs it on the Mac with
  `SCRIPT=fence.ts`), `costs.ts POLL=timeout`, `guest.ts GPU_KNOBS=… SIZE=WxH`.
- **nvidia.sh**: a `fence` step (fence.ts) and the `scene` step now runs Venus with the pump, Venus with
  `vkpoll=timeout` and virgl, two alternated rounds, long enough for the stats (WARMUP 200, FRAMES 300), and prints
  each run's frame and breakdown. Not run end to end on the dev VM (its pieces were: fence.ts, guest.ts with knobs).
  Questions above.
- **Tests**: tests/venus-driver.test.ts's third test runs 20 submits with each poller in Chromium: the old one sends no
  empty submit, the pump's nudges all reach the queue (`queue.submit` wrapped). Its times are logged, not asserted: a
  first version asserted the pump's fence under 0.6 of the old one's (1.1 against 2.8 ms alone) and failed in
  ci.sh, where the native guest tests' load put both at 5–6 ms. Planted: a nudge that sends nothing: caught.
- **Left**: the user's run confirms NVIDIA (above). Backlog: "virgl's occlusion-query poll waits 4 ms a turn" (what's
  left of the pollers' entry), "The guest fences each frame through the virtqueue" (new: VK2 L5's guest sent ~1 a
  second), "Venus's ~4.5 ms fence floor on NVIDIA: the fix awaits the user's run". The presentation copy's place in
  the frame wasn't measured (the scene is offscreen; vkcube and mpv are vsync-paced).
- **CI at the commit:** ci.sh OK (437 s), ci-debian.sh OK (339 s), ci-deqp-vk.sh OK (243 s). ci-deqp.sh and ci-audio.sh not run: virgl's and sound's timers are unchanged (the render stats gained a field).
- **Worth not re-discovering:** see "Things worth not re-discovering" below (L2's).

## State (2026-10-26, after L1)

- **Done: NVIDIA's black found and fixed without the desktop** (REPORT.md "VK3 L1", JSON in
  `bench/vulkan/results/vk3/l1/`). The bitmap way was never the cause: VK2's run shows `shareRefreshes` 0 during mpv on
  Vulkan (24/s on the M4), so nothing was ever copied. The device reported the adapter's maker as its vendor (VK2 L7),
  0x10de on NVIDIA, and Venus's guest driver in Mesa 26 (`vn_wsi_init`) then sends Mesa's WSI down the prime blit: each
  frame copied into an exported linear buffer, a blob with no texture to share. Reproduced on SwiftShader with
  `?gpu=vkvendor=nvidia` on the desktop guest (mpv's page mean 0 against the guest's 55.8; the user's was 0.4); fixed
  by reporting NVIDIA as an unknown maker (web/venus-gpu.ts `VENDORS`; after: right, mean difference 3).
- **The run-time check** (web/venus-share.ts, vk/README.md "Presentation"): three ways now (bitmap, canvas,
  readback); a GPU way's first copies are held while 8 rows are read back from WebGPU and compared with the virgl
  texture (`readExternalRows`); dark frames decide nothing, 3 right frames settle it, a wrong one drops it for the next
  and that frame gets the next way's copy before the submit runs. Forcible: `?gpu=vkbitmap|vkcanvas|vkreadback`
  (checked, never dropped); tests break a way with `vkbreak=<way>`; `vkvendor=<maker>` spoofs the maker. State in the
  render stats (`share`) and on the console. **The page now picks:** bitmap on the M4 (checked right in 3 frames; all
  four arms right in situ; with the bitmap way broken it fell to canvas, checked right), readback on SwiftShader (by
  the renderer's name, as before: a WebGPU canvas there loses the GPU channel).
- **Tests:** tests/venus-share.test.ts (the bytes every way, the fallback with both GPU ways broken incl. on
  SwiftShader, the verdicts in Node; passes on the Mac too, run by hand), tests/page-venus.test.ts (its presentation
  runs with `vkbreak=bitmap,vkbreak=canvas` and asserts the fallback to readback), tests/venus-renderer.test.ts (never
  0x10de). Planted: the check never wrong, the check not holding the submit, NVIDIA's ID back: each caught.
- **nvidia.sh**: a `present` step first (bench/vulkan/present.ts: per way a session, vkcube and mpv in the desktop
  guest, the page's screen against the guest's frames), the tarball now `vk3-nvidia-results.tar.gz`; ran end to end on
  the dev VM (SwiftShader, `VK0_ANY_ARCH=1 VK0_NODE=system VK0_ADAPTER_MATCH=swiftshader VK2_STEPS=present`, the
  bundle rebuilt from this checkout). bench/gpu/sway-mac.sh passes `WAYS` (`SCRIPT=../vulkan/present.ts`).
- **Also fixed:** the readback way leaked: a buffer made and destroyed a frame grew Chromium's GPU process by ~one
  buffer a frame on SwiftShader (vkcube's 1276×670 rgba16float: 1.7 → 3.3 GB in 4 s, OOM); each resource keeps its
  buffer now (steady ~300 MB). Playwright screenshots of the page hang while SwiftShader's GPU process is busy:
  `window.__webpcGrab()` (bench hooks) reads the screen canvas as drawn, in the GPU worker.
- **Left:** the user's run (above) confirms. A WSI that exports buffers (prime blit) still isn't shared (backlog "A WSI
  image exported as a buffer isn't shared"; only a warning). If the next run shows the bitmap way wrong on NVIDIA,
  the check already falls back; the forced arms tell which of the hypotheses (REPORT.md "VK3 L1": a failed swap-buffer
  export gives a transparent image silently; GL/Vulkan memory and semaphore interop) holds.
- **CI at the commit:** ci.sh OK (504 s), ci-debian.sh OK (422 s; page-venus with the GPU ways broken: vkcube right
  through the fallback), ci-deqp-vk.sh OK (252 s). tests/venus-share.test.ts also passes on the Mac (by hand).
- **Worth not re-discovering:** the guest's Mesa reads the device's vendor ID (Venus's WSI: 0x10de means NVIDIA's
  driver underneath); check a vendor-dependent change on the desktop guest (Mesa 26), not Debian's 25. The serial
  `run()` joins a command's output lines: print one line. ffmpeg's `cropdetect` skips 2 frames by default (`skip=0` for
  a PNG). mpv on Venus draws unscaled (its scaler disabled with the FBO formats held back) while its own `screenshot
  window` is scaled: compare cropped pictures. The page-level `present.ts` on SwiftShader takes ~3 min a way.

## State (2026-10-26, before L1)

VK2 ended at cd03da82/465132b6: Venus draws through WebGPU, frames reach virgl's screen by bitmap (L4), mpv on Vulkan
meets its timing bar, 1,463 dEQP-VK cases in CI. The user's NVIDIA run (bench/vulkan/REPORT.md "VK2: the NVIDIA run")
found Venus's presented frames black there (offscreen frames right) and a ~4.5 ms fence floor a frame (the M4's ~0.9).

## Things worth not re-discovering

VK2's list still holds: `git show cd03da82:VK2-HANDOVER.md`, its "Things worth not re-discovering" and each state's
findings. Add VK3's here.

- (L1) Guest-visible identity matters: Venus's guest driver keys its WSI path on the device's vendor ID (0x10de →
  prime blit, frames into buffers that aren't shared). Read a NVIDIA run's render stats first: `shareRefreshes` 0 meant
  nothing was copied, before any theory about the copy.
- (L1) On SwiftShader a WebGPU buffer made and destroyed a frame isn't freed while the queue stays busy (Chromium's GPU
  process grew ~400 MB/s): keep staging buffers. Page screenshots can hang there: use `window.__webpcGrab()`.
- (L2) Chromium's timers in a worker: a nested `setTimeout(0)` is 4.4 ms on Linux and **6.0 ms on the Mac**; a timer set
  from a message's task isn't nested (0.01 ms); `Atomics.waitAsync` with a 0.25 ms timeout is a 0.49 ms sleep on Linux
  but 1.55 ms on the Mac; a loop of messages alone starves timers. `bench/vulkan/fence.ts` measures them.
- (L2) Dawn on Vulkan in Chromium (SwiftShader; likely NVIDIA) reports a submit done only at the GPU process's slow
  look (~3 ms late) unless commands arrive: an empty submit every ~1 ms fixes it. Never flood: unbounded empty submits
  made Metal's done 19.8 ms, every 0.5 ms cost SwiftShader's GPU-bound scene ~3%.
- (L2) The scene's stats need long runs: at ~1 ms a frame VK0's default (30 warm-up, 5 × 30 frames) is under a stats
  second; use WARMUP=200 FRAMES=300. SwiftShader can't show a fence floor with the scene: its rendering takes ~10 ms a
  frame even at 320×180 (two frames queued, 15 ms to done); use `costs.ts` there.
- (L3) Chromium compiles a pipeline made with `createRenderPipeline` on the GPU process's main thread when the command
  arrives: every later command of the device *and the page's WebGL* waits (4.2 s for 40 new pipelines on the M4).
  `createRenderPipelineAsync` compiles on Dawn's workers, in parallel. SwiftShader compiles at the first draw either way.
- (L3) Metal's on-disk shader cache outlives Chrome's profiles (it's per app in the system's caches): on the M4 a
  "cold" run with a fresh profile still has old shaders compiled; use unique shaders (`bench/vulkan/pipelines.ts`'s seed)
  for a true first compile.
- (L3) Mesa looks up a stage's NIR (precomp) before the pipeline's shaders, so both kinds of entry must persist to skip
  spirv_to_nir; and on a partial hit it recompiles the partition but keeps the found stage: why programs are found by
  their link. `vk_pipeline_cache_create` with initial data puts every object to the disk cache again (same keys).
- (L3) A page's IndexedDB is per origin, port included: a kept profile across sessions needs a fixed port
  (`WEBPC_PROFILE` makes guest-session.ts use `WEBPC_PORT`, 8197). venus-run.ts needs `CHROMIUM_ARGS="--enable-unsafe-webgpu
  --enable-features=Vulkan"` on the dev VM, or Venus draws nothing (and vkQuake's replay crashes).
- (L2b) A Venus scene's "GPU x ms" line is the driver's CPU clock at replay, not the GPU's (`OP_QUERY` writes
  `os_time_get_nano()`): use `?gpu=vkgputime`. The render stats' averages include the scene's start; `perSubmit` is
  over the steady seconds. sway-mac.sh's name can't hold a `/` (flat names: `l2b-…`).
- (L2b) On the M4 a lone frame-sized submit is done in ~2.3 ms and its pass takes 0.14 ms; kept queued, 1.0 and 0.09:
  measure a light load queued as the scene runs, not alone. Chromium polls a WebGPU device at each command batch
  (`HandleDawnCommands` → `PerformPollingWork`) and otherwise on a 1–2 ms timer that each flush restarts.
- (L2b) Playwright's `browser.startTracing` gives JSON (CDP's default stream format) of every process: 2 s of the
  scene ~50 MB, ~3 MB gzipped.
- (L2) Completing a submit with nothing to read back before its work is done would hide its latency, but the guest's
  fences would then stop holding it back (unbounded queued frames): not done.
- (L4) The M4's green chroma is a heisenbug: any probe in the GPU worker hides it, even a few µs of CPU per bind or one
  extra submit. Count greens only in bare sessions, at least ~10 each (~1/3 rate). Only the session's first mpv on
  Vulkan shows it. Keep traces in memory, dumped by the grab hook, never `console.log` in the hot path. `mpv-frames.ts`
  with `MPV_ARMS='vkva=…|vkno=…' PAIRS='vkva~vkno'` takes ~2.5 min a session on the Mac.
- (L4) libplacebo's FBO formats need every capability of `rgba16float` (blend, filter, storage, render) in their 1- and
  2-component siblings; `float32-blendable` gives the `rg32float` family, tier1's storage the `rg16float` one (taken
  first). Software decoding gives three R8 planes, VA-API an R8 and an RG8, so only VA-API needs the 2-component FBO.
- (L4) `grep -f`/`pgrep -f` patterns: a kill pipeline whose pattern (`ssh macmini`) appeared later in the same command
  line killed its own shell (exit 144). Find PIDs with `ps` first, in a command of their own.
