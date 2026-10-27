# VK3 handover

What carries VK3 ([VK3-KICKOFF.md](VK3-KICKOFF.md)) from one loop to the next: where it stands, the plan, what the next
NVIDIA run must answer, findings worth not re-discovering. **Kept lean**: a loop adds a short state (≤ 10 lines) on top
of "Where VK3 stands"; the supervisor folds older states into it. History and numbers live in
`bench/vulkan/REPORT.md` (a "VK3 …" section per loop and NVIDIA run, JSON in `bench/vulkan/results/vk3/`), the
docs and the backlog; git keeps the old handovers.

## Where VK3 stands (2026-10-27, after L4c-F; the first supervisor session halted here, before L5)

- **Done:** L1 (NVIDIA's black: the vendor ID; a run-time check of the share ways), L2 (the fence's floor: the
  pollers' clamped timers, Dawn's late done), L3 (async pipelines; translated shaders kept across runs, 32 MiB, the
  origin's: approved by the user, the budget to become configurable), L3b (ci-machines.sh green), L4c (a fresh static
  review's twelve real defects fixed, among them the M4's green chroma: REPORT.md "VK3 L4b–L4c"). NVIDIA runs of
  5b9654ac and f55eacd7: presentation right in every way, mpv at its bar, pipelines right (REPORT.md "VK3: the NVIDIA
  run after L2", "… after L2b").
- **Parked by the user (2026-10-26): Venus at 1 fish on NVIDIA** (2.4–2.6 ms a frame against virgl's 1.5): 1 fish isn't
  representative; likely NVIDIA's driver latency or its GPU leaving low power slowly. Venus is well ahead at 1,000 fish
  and the toolkit (5.5 against 8.8 ms, 3.2 against 6.4), so the gate's scene clause is held at those sizes unless the
  user reopens it (backlog "Venus at 1 fish on NVIDIA").
- **L4's remainder:** libplacebo's advanced path (`float32-blendable`, tier1's storage formats) is still held by default
  (`HELD_FEATURES`; `?gpu=vkformats=all` takes it). The green is fixed (0 of 32 bare sessions since L4c-A), so: check
  mpv's frames and bar with it on at today's code (L4c-F refused `read_write` storage WebGPU can't give: libplacebo's
  compute paths may meet it), dEQP-VK with it on, then turn it on by default; the NVIDIA run's mpv questions below.
- **The review's branch** `origin/review/venus-green` (78d08509) holds the review itself; its findings now live in
  vk/README.md and the backlog. Kept until the user says to delete it.

## The plan (loops; the supervisor may reorder)

- [ ] L4d: L4's remainder (above): the advanced path on by default if right; ~1 loop.
- [ ] L5: the translator's missing adapter features (`subgroups`, `shader-f16`, read-write storage with `tier2`: see
  backlog for what L4c-F refused).
- [ ] L6: the driver's gaps from dEQP-VK (per-face stencil, occlusion queries, texel buffers, depth/stencil copies,
  dEQP-VK on the Mac's GPU; the 34 `load_store_op_none` failures; bind groups remade every frame).
- [ ] L7: §4's emulated rows in order (Dawn's: indexed descriptor arrays, sample-rate shading; ANGLE's ES3: provoking
  vertex, >12 UBOs, transform feedback; vkd3d's draw parameters; GTK4's YCbCr with modifiers last). Likely several loops.
- [ ] Out-of-context reviews (CLAUDE.md, docs/testing.md): the two in the backlog (the translator; the driver outside
  the import path) after L4d, and one every ~3 loops after.
- [ ] L8: the track's end (REPORT.md's VK3 summary, docs, plan §6/§7, the final NVIDIA run scripted, ci-debian.sh and
  ci-machines.sh, an out-of-context review of what VK3 changed).

## What the next NVIDIA run must answer

Each loop that needs an NVIDIA number extends `bench/vulkan/nvidia.sh` (one command, one results tarball, `results/`
cleared at the start) and adds its question here. **The bundle** is built by the supervisor from a **clean** checkout
at the commit, with no loop running: `scripts/build-wasm.sh`, `vk/build.sh`, then `bench/vulkan/nvidia-bundle.sh`
(~3.4 GB) and `mv target/vk2-nvidia-bundle.tar target/vk3-nvidia-bundle-<commit>.tar`; check its `BUNDLE.txt` names the
commit without "with uncommitted changes". On the desktop, in a checkout at the same commit:

    bench/vulkan/nvidia.sh page <the bundle> ~/webpc-vk2

(~56 min whole; `VK2_STEPS="…"` runs some steps; results: `~/webpc-vk2/vk3-nvidia-results.tar.gz`, which the user puts
in the repo's root. Process it into REPORT.md and `bench/vulkan/results/vk3/nvidia-<name>/`, leave traces over a few MB
in `bench/results/local/`, delete the tarball.) The last bundle (`target/vk3-nvidia-bundle-f55eacd7.tar`) predates L4c:
build a new one.

**Open for the next run** (rewrite them if L4d turns the advanced path on by default):
- (L4) `mpv-frames-default`: as the page has it, libplacebo complains "Failed creating FBO texture" and VA-API's frame is
  byte for byte the software one (`vkva ~ vkno` 0) — the same as on the M4?
- (L4) `mpv-frames-all`, `mpv-frames-all2` (`?gpu=vkformats=all`: libplacebo's advanced path): no complaint; is VA-API's
  chroma right (`vkva ~ vkno` near 0) or green (~2.28 M bytes off by more than 24, mean ~77) in either session? Which
  FBO family did NVIDIA's adapter give (the log's `venus` line has no format; `texture-formats-tier1` in
  `adapter.json` says `rg16float`)?
- (L4) `mpv-all`: mpv on Vulkan with the advanced path on meets the bar (no drops, the guest no busier than 19–27%)?

## Things worth not re-discovering

VK2's list still holds: `git show cd03da82:VK2-HANDOVER.md`, "Things worth not re-discovering". Add VK3's here.

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
- (L4, L4c) The M4's green chroma looked like a heisenbug (probes in the GPU worker seemed to hide it) and was a lost
  write-watch page between two Venus devices (L4c-A): a probe changes how devices' submits interleave. Count such a bug
  only in bare sessions with `bench/vulkan/green.sh` (arms alternated, k of n both arms), and get a fresh static review
  before long experiment series (docs/testing.md "Out-of-context reviews").
- (L4c-B) Venus's query feedback fills a slot and copies results into it in one submit: a completion change that took
  the fill's bytes for the guest's made the scene's GPU ms 1e11. Read the scene's GPU ms as a correctness check after
  any completion change.
- (L4) libplacebo's FBO formats need every capability of `rgba16float` (blend, filter, storage, render) in their 1- and
  2-component siblings; `float32-blendable` gives the `rg32float` family, tier1's storage the `rg16float` one (taken
  first). Software decoding gives three R8 planes, VA-API an R8 and an RG8, so only VA-API needs the 2-component FBO.
- (L4) `grep -f`/`pgrep -f` patterns: a kill pipeline whose pattern (`ssh macmini`) appeared later in the same command
  line killed its own shell (exit 144). Find PIDs with `ps` first, in a command of their own.
