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

**Open for the next run:** nothing yet (L2c was stopped; later loops add theirs).

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
- [ ] L3b (added by the supervisor after L3, next): **`scripts/ci-machines.sh` passing again.**
  `tests/page-snapshots.test.ts` "kept snapshots…" has failed since VK2 L7 at its first Restore ("the disk's changes
  can't be written to the browser's storage (is it full?)"; backlog). Not VK3's doing, but the track's end needs
  ci-machines.sh green: find whether it's the test's profile quota or a real storage bug and fix it.
- [ ] L4: libplacebo's advanced path (`float32-blendable`; the M4's green VA-API chroma; tier1's storage formats).
- [ ] L5: the translator's missing adapter features (`subgroups`, `shader-f16`, read-write storage with `tier2`).
- [ ] L6: the driver's gaps from dEQP-VK (per-face stencil, occlusion queries, texel buffers, depth/stencil copies,
  dEQP-VK on the Mac's GPU).
- [ ] L7: §4's emulated rows in order (Dawn's: indexed descriptor arrays, sample-rate shading; ANGLE's ES3: provoking
  vertex, >12 UBOs, transform feedback; vkd3d's draw parameters; GTK4's YCbCr with modifiers last). Likely several loops.
- [ ] L8: the track's end (REPORT.md's VK3 section, docs, plan §6/§7, the final NVIDIA run scripted).

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
