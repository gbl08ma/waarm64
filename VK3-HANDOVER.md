# VK3 handover

What carries VK3 ([VK3-KICKOFF.md](VK3-KICKOFF.md)) from one loop to the next: where it stands, the plan, what the next
NVIDIA run must answer, findings worth not re-discovering. **Kept lean**: a loop adds a short state (≤ 10 lines) on top
of "Where VK3 stands"; the supervisor folds older states into it. History and numbers live in
`bench/vulkan/REPORT.md` (a "VK3 …" section per loop and NVIDIA run, JSON in `bench/vulkan/results/vk3/`), the
docs and the backlog; git keeps the old handovers.

## State (2026-10-28, after L7.5)

- **vkd3d's row backed and advertised:** `shaderDrawParameters` as words of the push buffer at byte 128 (a vertex stage
  reading them takes its push constants from the push buffer); direct draws write theirs in their place, an indirect
  draw's are copied from its arguments into a place of its own before its pass (no break). dEQP-VK's list 4,599 →
  4,672 (REPORT.md "VK3 L7.5"); `draw_index` needs `multiDrawIndirect` (not advertised).
- **The program:** Arch's vkd3d 1.19 makes a D3D12 device at 11_0 in the desktop guest (it stopped at the extension
  before); vkd3d's own d3d12 tests (built in a container, `bench/vulkan/vkd3d.ts`) draw right where they need nothing
  else; what 11_0 lacks and the failures' causes: backlog "vkd3d on Venus".
- Next: the out-of-context reviews of what VK3 changed (after L7), then L8.

## Where VK3 stands (2026-10-28, after L7.5; next the reviews after L7)

- **L7.4:** ANGLE's ES3 row backed (13 uniform buffers a stage, the last vertex provoking, transform feedback); the
  guest's Chromium with `--use-angle=vulkan` gives WebGL 2 on Venus; dEQP-VK's list 4,424 → 4,599.

- **L7.3:** GTK4's black frames were L4c-D's partial CLEAR (fixed since); YCbCr on by default (GTK 4.24 aborted
  without it; it still takes GL); GSK on Vulkan (forced) misses GTK4's bar (iconscroll 9 frames/s against GL's 28):
  backlog "GSK's Vulkan renderer on Venus misses GTK4's bar".

- **L7.2:** YCbCr conversions backed (the 8-bit 2- and 3-plane formats, a texture a plane, Mesa's
  `nir_vk_lower_ycbcr_tex` in the translator); 773 dEQP-VK cases in `tests/deqp/vk-ycbcr.txt` (failing: plane views of
  another format, memory aliased by a plane: backlog "YCbCr's gaps"). Opaque-fd semaphores are the guest's Mesa's
  (hard-coded sync files; a guest Mesa patch is the way: backlog).

- **L7.1b:** Chromium's opaque-fd semaphore exports, which the driver refused (vkr never had the object), now made; the
  guest's Venus then hands back fd 0 and Chromium's GPU process dies ("FD ownership violation"): the guest's (L7.2).

- **L7.1:** Dawn's row backed and advertised (the four `shader*ArrayDynamicIndexing`, `sampleRateShading`, `gl_FragCoord`
  at the sample); dEQP-VK's list 4,251 → 4,424. The program (Dawn in the guest's Chromium) needs YCbCr (L7.2), the guest
  side above, and a window (no Xwayland; `--headless=new` starts).

- **L6c:** vkQuake's frame 5 back at L5's counts (L5b's compute SSBOs `read_write` made a usage-scope conflict: a
  read-only SSBO is now writable only beside a write of its memory); page-venus runs in ci-deqp-vk.sh and fails on any
  WebGPU error; the L5–L6a review's 8 findings fixed. Open: the usage-scope residue (uniform/indirect beside written
  storage of one memory; render passes).

- **L6b:** texel buffers, the depth/stencil copies WebGPU refuses, bind group layouts' uids by content; dEQP-VK's list
  3,972 → 4,251 (on the M4: 3,547 pass, 7 fail, 697 subgroups not supported). Filed: texel buffers past the storage
  count or aliasing, storage without format, D16's partial copies.

- **L6a:** per-face stencil, depth24plus-stencil8's stencil copied, occlusion queries on the GPU, submits held for
  timeline waits nothing signalled (signal-only submits go at once: holding vkr's ring fences hung the guest);
  dEQP-VK's list 3,261 → 3,972. Filed: clears inside an occlusion query, queries outside a pass, `device_host`'s 41.

- **L5b:** the out-of-context review of L4f's six findings fixed (`origin/review/venus-l4f`); usage-scope conflicts
  and float sample counts filed.

- **L5:** WGSL's subgroups where the adapter's have one size (held on the Mac: Chromium's Metal hoists a lone ballot out
  of an `if`; the worker's `subgroupsRight` check falls back to subgroups of one), 16-bit storage, `shaderFloat16`,
  tier2's read-write formats; dEQP-VK's list 2,333 → 3,261 (REPORT.md "VK3 L5").
- **L4f:** the out-of-context reviews' remaining findings fixed (14) or filed (backlog "The Vulkan driver's gaps");
  dual-source blending implemented and advertised, API 1.3 kept; dEQP-VK's list 1,807 → 2,333.
- **Done:** L1 (NVIDIA's black: the vendor ID; a run-time check of the share ways), L2 (the fence's floor: the
  pollers' clamped timers, Dawn's late done), L3 (async pipelines; translated shaders kept across runs, 32 MiB, the
  origin's: approved by the user, the budget to become configurable), L3b (ci-machines.sh green), L4c (a fresh static
  review's twelve real defects fixed, among them the M4's green chroma: REPORT.md "VK3 L4b–L4c"), L4d–L4e (below).
  NVIDIA runs of 5b9654ac and f55eacd7: presentation right in every way, mpv at its bar, pipelines right.
- **Step 4 done: libplacebo's advanced path is on by default** (`?gpu=vkformats=held` holds it; REPORT.md "VK3 L4d",
  "VK3 L4e"). Warm it was right at L4d; a cold first mpv froze its window, which L4e found in the **guest's Mesa**:
  Venus's async present (`vn_wsi_present_async`, Mesa 26.x and main) returns a failed present's error (OUT_OF_DATE from
  a swapchain retired at a resize) for the next present and drops that one unsubmitted. **Remedy:**
  `VN_PERF=no_async_present` in the desktop image (`images/arch/desktop-setup.sh`; `target/arch/desktop.qcow2` rebuilt).
  Right on SwiftShader and the M4, cold and warm; mpv's bar holds (0 drops, 13–14%). Check: `CHECK=1 node
  bench/vulkan/mpv-frames.ts` on SwiftShader; `?gpu=vkpipedelay=<ms>` makes a warm host cold.
- **Confirmed on NVIDIA** (the run of 4fdc69fb, REPORT.md "VK3: the NVIDIA run after L4e"): the advanced path taken,
  VA-API byte for byte software, the page on the fullscreen frame, mpv exits in every arm, mpv at its bar (0 drops,
  12–14%); presentation, replays, pipelines, the fence and the scene as in the run after L2b.
- **Open from L4e:** report the Mesa bug upstream (the fix is written in vk/README.md "The guest's Mesa") and drop the
  workaround when Arch ships one; **the hosted desktop disk (vmdisks.tny.im) is still the old image**: replace it before
  the page is next deployed, or a user's first cold mpv freezes (backlog; deploys are the user's call).
- **Parked by the user (2026-10-26): Venus at 1 fish on NVIDIA** (2.4–2.6 ms a frame against virgl's 1.5): the gate's
  scene clause is held at 1,000 fish and the toolkit unless the user reopens it (backlog "Venus at 1 fish on NVIDIA").
- **The review's branch** `origin/review/venus-green` (78d08509) holds the review itself; its findings now live in
  vk/README.md and the backlog. Kept until the user says to delete it.
- **The out-of-context reviews of the translator and caps and of the driver** (a cloud session, 2026-10-27, after
  L4e; their files deleted at L4f's end: `git show 301dd138:VENUS-COMPILER-REVIEW.md`, `…:VENUS-DRIVER-REVIEW.md`):
  17 and 11+ findings, the open ones in docs/backlog.md "The Vulkan driver's gaps". Fixed
  there, each with its test failing first on SwiftShader (`tests/venus-driver.test.ts`, `tests/wgsl.test.ts`,
  `tests/venus-renderer.test.ts`; 31 pass): indexed strips without restart, a pipeline without a fragment shader in a
  pass with colour, depth bias on lines (each an invalid WebGPU submit); the submit that grows the push buffer
  (invalid); a linear image's freed memory reached by every submit (heap use after free); dynamic storage offsets read
  back at 0; odd-sized storage bindings; `packHalf2x16`/`unpackHalf2x16` refused; a weak compare-exchange;
  `pipelineCacheUUID` blind to the caps; L4f the rest (above).
- **Next:** L7.

## The plan (loops; the supervisor may reorder)

- [x] L4d: L4's remainder checked: right and at its bar warm, but a cold first run freezes mpv's window; still held.
- [x] L4e: the cold freeze is Mesa's async present (the desktop image presents synchronously); the advanced path on by default.
- [x] L4f: the reviews' remaining findings fixed (each with its test failing first or planted back) or filed in
  docs/backlog.md "The Vulkan driver's gaps"; dual-source blending implemented and kept advertised (the user's call:
  it passes the Mac's `dual_source` samples but where a draw mixes the constant's colour and alpha); API 1.3 kept, its
  gaps filed. The review files deleted. The out-of-context review of what L4f changed is the supervisor's.
- [x] L5: the translator's adapter features: subgroups (held on the Mac by a run-time check), 16-bit storage,
  `shaderFloat16`, tier2's read-write formats; left: `shaderInt16`, 16-bit I/O, the Metal ballot workaround (backlog).
- [x] L5b: the out-of-context review of L4f's changes (`origin/review/venus-l4f`, `VENUS-L4F-REVIEW.md` there; 6
  findings, all taken): a `DONT_CARE` multisampled depth/stencil discarded before its resolve reads it; SSBOs a stage
  doesn't write now `read-only-storage`, a usage-scope conflict beside a writable one in the same memory's GPUBuffer;
  `framebuffer(Integer)ColorSampleCounts` past what the 32-bit formats report; `maxComputeSharedMemorySize` 16368 under
  Vulkan's 16384 minimum; the depth resolve's `renderArea` and layers; the tests that defend 3 and 4 or match text only.
  Each with its test failing first. Done: all six fixed (the resolve's layers moot), the usage scopes left filed.
- [x] L6a: the driver's semantics: per-face stencil; occlusion queries with their availability and strided result
  copies (the driver review's 10); timeline waits before their signal (the driver review's 8: backlog
  "Synchronization"); the 34 `load_store_op_none` failures.
- [x] L6b: texel buffers; the depth/stencil copies WebGPU refuses; bind groups remade every frame (a performance item,
  A/B-measured); a dEQP-VK sweep on the Mac's GPU (`SCRIPT=deqp-run.ts CASES=… VIRGL_GPU=virgl,vulkan
  bench/gpu/sway-mac.sh vk target/deqp/guest-vk.qcow2 <name>`).
- [x] L6c: vkQuake's frame 5 (L5b's compute SSBOs `read_write`: a dispatch's read-only SSBO now writable only beside a
  write of its memory; page-venus in ci-deqp-vk.sh); the review of L5–L6a's 8 findings fixed, each with its test.
- [x] L7: §4's emulated rows in order, a loop a row (dotted: the review fix loops after L7 are L7a, L7b, …):
  - [x] L7.1: Dawn's row: dynamically indexed descriptor arrays, sample-rate shading, their dEQP-VK cases and the
    SAMPLE_ZERO `depth_stencil_resolve` ones. **Remainder:** the program (Dawn in the guest's Chromium) needs
    YCbCr (L7.2's), Chromium's Vulkan context alive on Venus (the semaphore vkr never made) and a window (Xwayland in
    the image, or headless): backlog "Dawn in the guest's Chromium on Venus".
  - [x] L7.1b (the supervisor, 2026-10-28): the remainder's semaphore. **Done:** opaque-fd exports the driver refused
    (now dropped); Dawn not yet on Venus (the guest's Venus hands back fd 0 for them: backlog). The brief: A submit naming a semaphore vkr never made is a
    driver or vkr defect whatever brings it: reproduce it (Chromium's Vulkan device in the guest, YCbCr advertised
    **only behind an opt-in switch**, never by default: YCbCr by default stays GTK4's row's (L7.3), since GTK4 would take Vulkan and
    draw black), find which object type or external-semaphore path the driver doesn't make, fix it with a test failing
    first. Time-boxed ~3 h; if Dawn then runs on Venus (`--headless=new`), its samples against the dev VM's frames.
  - **The rows reordered by the user (2026-10-28; VK3-KICKOFF.md "Decisions"):** Chromium's own Vulkan device needs
    YCbCr, so YCbCr comes next, behind `?gpu=vkycbcr`; GTK4 after it decides the default.
  - [x] L7.2: YCbCr conversion (`samplerYcbcrConversion`, its formats and multi-planar images) behind `?gpu=vkycbcr`,
    dEQP-VK's `ycbcr` groups as its gate. Time-boxed lead: the guest Venus's fd 0 for opaque-fd semaphore exports
    (L7.1b), the way to Dawn's program. **Done:** the 8-bit multi-planar formats, 773 cases in vk-ycbcr.txt; the lead
    is the guest's Mesa (filed).
  - [x] L7.3: GTK4: its black frames understood, dma-buf modifiers, its bar (REPORT.md G); YCbCr on by default only
    once GTK4 meets it, else GTK4 stays on GL and YCbCr opt-in. **Done:** the black was L4c-D's partial CLEAR; YCbCr on
    by default (GTK4 aborted without it, and takes GL with it); GSK on Vulkan misses the bar (iconscroll), filed.
  - [x] L7.4: ANGLE's ES3: the provoking vertex, more than 12 uniform buffers, transform feedback. **Done:** all three
    backed; ANGLE gives WebGL 2 on Venus in the guest's Chromium (`--use-angle=vulkan`).
  - [x] L7.5: vkd3d's draw parameters. **Done:** backed and advertised; vkd3d makes an 11_0 device, its own draw tests pass.
- [ ] Out-of-context reviews (CLAUDE.md, docs/testing.md): the translator's and the driver's done (2026-10-27, L4f
  takes their findings); one every ~3 loops after.
- [x] After L7 (the user, 2026-10-28): out-of-context reviews of what VK3 changed: L6b–L7.3
  (`origin/review/venus-l6b-l73`, 5 findings), L7.4–L7.5 and the binding model whole (`origin/review/venus-after-l7`,
  `VENUS-L74-L75-REVIEW.md` 9, `VENUS-BINDING-REVIEW.md` 8 new). All taken, in two fix loops:
  - [ ] L7a: **the binding model's limits and identities.** All of VENUS-BINDING-REVIEW.md (xfb's dispatch past the
    storage-buffer count and binding size: the submit lost, not the capture; one sampler's nearest twin for both
    textures; widened compute variants sharing a layout identity, writes not read back; the 64-resource caps; oversized
    uniform blocks; input attachments uncounted; immutable samplers overridden; slot numbers near 998/1000); L7.4–L7.5's
    3 (same as the first), 5 (draw parameters' push buffer as a 9th dynamic uniform) and 8 (storage alignment on
    folded uniforms); L6b–L7.3's 2 (texel buffers' hidden bindings uncounted). The rule to land: one place that counts
    every hidden binding a stage and a layout take against WebGPU's limits, the device's advertised limits derived
    from it, and a refusal that names the cause instead of an invalid submit. ANGLE's 205-for-156 (L7.4, its 24
    uniform blocks with `--enable-features=Vulkan`) re-checked here: the reviewer found the folding consistent.
  - [ ] L7b: **the rest.** L7.4–L7.5's 1 (16-bit index ranges rounded down in `provoke()`: high), 2 (indirect draws
    never captured), 4 (dummy attachments evicted under recorded buffers), 6 (`pass.colors[8]` overrun), 7 (strips with
    restart on one GPU thread), 9 (tests); L6b–L7.3's 1 (`interpolateAt*` advertised, refused), 3 (mutable
    multi-planar formats, plane views in other formats), 4 (multi-planar on imported memory), 5 (comments).

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
in `bench/results/local/`, delete the tarball.) The last bundle is `target/vk3-nvidia-bundle-4fdc69fb.tar` (run 2026-10-27: REPORT.md "VK3: the NVIDIA run after
L4e").

**Open for the next run:** (L5) whether the page's log on NVIDIA says `venus: the WebGPU device's subgroups are wrong
in divergent control flow` (the device then has subgroups of one, as before L5) or not (real subgroups of 32: mpv's
libplacebo takes its subgroup paths; check its frames are still right). Any step's page log answers it.

## Things worth not re-discovering

VK2's list still holds: `git show cd03da82:VK2-HANDOVER.md`, "Things worth not re-discovering". Add VK3's here.

- (L7.5) A command's output through `s.run` comes back as the serial's last bytes: read a long guest log in parts
  (`sed -n` slices, bench/vulkan/vkd3d.ts). Arch's arch-base container needs `pacman -Syu` before installing (its
  database is stale: "failed to retrieve some files"). vkd3d's d3d12 tests take `VKD3D_TEST_FILTER` (a part of a test's
  name) and run offscreen; Arch packages no vkd3d demos (they'd need an X window anyway).

- (L7.4) A pass with no attachments makes WebGPU drop the whole submit ("Render pass has no attachments"): every dEQP-VK
  transform feedback case has one. dEQP-VK cases outside vk-main.txt's groups run by exact name through `CASES=`
  (the mustpass files are in the `localhost/webpc-deqp-vk` image: `podman run --rm localhost/webpc-deqp-vk cat
  /cts/external/vulkancts/mustpass/main/vk-default/transform-feedback.txt`). `vk/build.sh`'s output can look clean
  when the wasm link failed: check `grep ' error:' target/vk/wasm-build.log` (or its exit status) before a test run.
  `nir_io_add_intrinsic_xfb_info` needs constant folding first (arrays' and matrices' slots). The guest's ANGLE
  probe: `PAGE=bench/vulkan/angle/es3.html ARMS='--use-angle=vulkan' node bench/vulkan/dawn-frames.ts guest`.

- (L7.3) GTK picks its renderer by `GSK_DEBUG=renderer` lines ("Not using Vulkan: …"); gtk4-load.ts keeps them (`took`)
  and `RENDERERS=default` leaves GSK_RENDERER unset. GTK's sources at the guest's tag (`git clone --depth 1 --branch
  4.24.1 https://gitlab.gnome.org/GNOME/gtk.git`) answer what its Vulkan renderer needs in minutes: `gdkvulkancontext.c`
  (features, the YCbCr assert, dma-buf formats), `gsk/gskrenderer.c` (the order it tries). A fixed driver bug is
  confirmed as a symptom's cause by planting it back (vk/build.sh rebuilds in ~12 s) and one sway-mac.sh run.
- (L7.1b) "failed to look up object … of type N" from vkr: suspect a create the driver refused. Venus's guest makes
  most objects asynchronously and never sees the error; a temporary `wg_Create<Object>` wrapper that prints the result
  and the pNext chain's sTypes (stderr reaches the page's log) found it in one run. dawn-frames.ts guest needs
  `CHROMIUM_ARGS="--enable-unsafe-webgpu --enable-features=Vulkan"` on the dev VM, or the page's Venus has no WebGPU
  device and the guest's Chromium never reaches it; L7.1's crashing arm is `--headless=new … --use-angle=swiftshader`.
- (L7.1) WGSL's `@builtin(position)` is the pixel's centre even when the fragment shader runs per sample (Tint on
  SwiftShader): Vulkan's `FragCoord` is at the sample, so dEQP-VK's min_sample_shading (`fract(gl_FragCoord.xy)`)
  saw one colour a pixel until the translator added the sample's offset. Chromium's Dawn takes a system Vulkan device
  only with `--enable-features=Vulkan` (else its SwiftShader, in the guest and on the dev VM alike), and that turns on
  Chromium's own Vulkan device, which refuses one without `samplerYcbcrConversion`; on the dev VM the Profiles layer
  over lavapipe can't stand in (ANGLE and Skia fail on the profile's Vulkan first). Guest Chromium logs: `--enable-
  logging=stderr`, console lines as `"dawn: …"`; `VK_LOADER_DEBUG` through `CR_ENV`.
- (L6c) Dawn refuses a `storage` layout entry for a shader's `var<storage, read>` (an invalid pipeline): widening a
  binding's layout takes a module with it `read_write` too. A vkQuake replay with a frame far off: look first for
  `venus-gpu: WebGPU:` warnings in the run's results.json (an invalid command drops the whole submit). Heap canaries
  for use-after-free in the wasm driver don't land (dlmalloc coalesces the freed arrays): test the references instead.
- (L6b) Dawn refuses two writable storage bindings of one GPUBuffer whose ranges overlap ("Writable storage buffer
  binding aliasing"), besides the usage scopes' storage/read-only-storage rule: with every compute storage binding
  `read_write`, overlapping views of one memory in a dispatch fail. A WGSL division rounds differently from the CPU's
  (SwiftShader): a D24 round trip through `f32(v) / 16777215.0` needs the readback to pick the word that maps back.
- (L6b) `venus-run.ts`'s replay needs `CHROMIUM_ARGS="--enable-unsafe-webgpu --enable-features=Vulkan"` on the dev VM;
  for a baseline arm check out `vk/` and `web/venus-gpu.ts` at the base commit, build, run, and check them out again.
- (L6a) A guest stuck in D state (deqp-vk) with "fence … unretired" warnings: look for host submits held behind a
  wait. vkr retires the guest's ring fences through empty submits on the queue, and Venus's guest waits on them before
  reusing its command streams. vk-main.txt has duplicate lines: `sort -u` a CASES file, or deqp-vk exits at once.
- (L5) `bench/gpu/sway-mac.sh` with `SCRIPT=deqp-run.ts` needs `VIRGL_GPU=virgl,vulkan` for dEQP-VK (its default
  machine has no Vulkan: deqp-vk exits at once, no statuses). A translated WGSL kernel runs on the Mac's WebGPU in
  seconds through a small Playwright script there (REPORT.md "VK3 L5"): the fastest way to narrow a Metal-only failure.
- (L4e) A Vulkan window frozen with its app unable to exit, host fences fine: look at the guest's present path first.
  Mesa 26's Venus presents on a thread (`vn_wsi[q,i]`) and drops a present after one that failed (OUT_OF_DATE from a
  retired swapchain); `VN_PERF=no_async_present` is the A/B. A `vo` thread in `drm_syncobj_array_wait_timeout` with no
  host fence pending means a guest syncobj point nobody submitted (Venus waits with `WAIT_FOR_SUBMIT`).
- (L4e) User stacks in the desktop guest without an image build: gdb's packages on a copy of the media disk,
  installed at boot (`DISK2`, `PRE`, `DIAG` in mpv-frames.ts; REPORT.md "VK3 L4e"). `su` from root runs no pam_env:
  /etc/environment doesn't reach `su arch -c` (shot.sh sources it), and the file's last line has no newline.
- (L4e) A desktop image build needs ~12 GB free (packages, a copy of the root, the ext4); the dev VM's disk is near
  full: check `df` before one, and run it alone (an earlier L4e session's VM crashed with one beside Chromium).

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
- (L4d) Metal's shader cache makes M4 sessions warm after the first with the same shaders: a bug that needs a cold
  compile shows only in the first session of new shaders. Vary mpv's options (`--dither=ordered`, `--deband`, another
  polar scaler) to get a cold one; count cold and warm sessions apart.
- (L4d) shot.sh's output under a killed mpv starts with the shell's "Killed" line, and the serial joins lines: parse
  its last words (`mpv-frames.ts`), or a frozen mpv reads as "VA-API not used".
