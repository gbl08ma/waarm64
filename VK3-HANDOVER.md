# VK3 handover

What carries VK3 ([VK3-KICKOFF.md](VK3-KICKOFF.md)) from one loop to the next: where it stands, the plan, what the next
NVIDIA run must answer, findings worth not re-discovering. **Kept lean**: a loop adds a short state (≤ 10 lines) on top
of "Where VK3 stands"; the supervisor folds older states into it. History and numbers live in
`bench/vulkan/REPORT.md` (a "VK3 …" section per loop and NVIDIA run, JSON in `bench/vulkan/results/vk3/`), the
docs and the backlog; git keeps the old handovers.

## State (2026-10-29, the bundle for L9's NVIDIA run)

- **Built** by the supervisor from a clean checkout at 2850df53 (after L9b): `target/vk3-nvidia-bundle-2850df53.tar`
  (4.7 GiB, BUNDLE.txt "from 2850df53e735"). The user's run: `VK2_STEPS="l9 l9b" bench/vulkan/nvidia.sh page <the
  bundle> ~/webpc-vk2` (~20 min). It answers L9a's suspects (`l9`: which `vkl9=` arm brings a frame's
  `Queue::Submit` back to ~1.6 ms) and L9b's two cases (`l9b`). Then: fix what `l9` names (or look past the
  suspects), and close the track (step 6 below). The old bundle (c8087cb0) is the user's to delete.

## State (2026-10-29, after L9b)

- **`textureprojlodoffset…isampler2d_vec4_fragment`: a Venus defect, fixed.** An integer texture's explicit LOD was
  rounded unclamped: 9 named a level past the view's (Dawn clamps on SwiftShader and the M4; NVIDIA reads zeros), -1
  shrank the extent. Now Vulkan's nearest level within `textureNumLevels` (tests/wgsl.test.ts, failing first); 35
  more clamp_to_edge integer cases in tests/deqp/vk.txt (4,725), 26 more of 1,272 neighbours pass on SwiftShader.
- **`memory.binding…buffer_1048577`: passes on SwiftShader and the M4.** NVIDIA's log had a trap in the module's
  `complete` (`table index is out of bounds`) and the worker then completed the next submits early (readbacks unmapped,
  staging destroyed under the map): that cascade fixed (tests/venus-gpu.test.ts, failing first); the trap's cause not
  found (backlog). **Next NVIDIA run: `VK2_STEPS="l9b"`** (~5 min) with L9a's `l9`; a new bundle (code changed).
- CI alone: ci.sh 457 s, ci-deqp-vk.sh 848 s (the list of 4,725), both OK.

## State (2026-10-29, after L9a)

- **Not reproduced** on the M4 or SwiftShader (alternated A/B of the scene, 4fdc69fb's `vk/`+`web/` against c8087cb0's:
  rounds overlap, c8087cb0 a little cheaper on the M4). **Located on NVIDIA from its traces**: a frame's Dawn
  `Queue::Submit` takes the GPU process's main thread 1.56 ms (4fdc69fb) → 2.53 ms (c8087cb0) of CPU; SwiftShader's 0.13
  at both. The WebGPU calls are the same (counted and dumped on SwiftShader: REPORT.md "VK3 L9a").
- **For the next NVIDIA run** (a new bundle, the supervisor's): `VK2_STEPS=l9` (~15 min) runs `?gpu=vkl9=all` and each
  suspect (`features`, `limits`, `bindgroups`, `pad`: 4fdc69fb's behaviour) against the default, each with a trace's
  `Queue::Submit` line. Then fix the one it names (keeping its commit's dEQP-VK cases), or, if `all` stays at ~2.5 ms,
  look outside them (the 16-byte query copies, the `wg_flip_z` override, NVIDIA's host).
- Worth not re-discovering: Chromium's traces carry thread time (`tdur`): a long Dawn event is CPU or a wait at a glance.
  A temporary wrapper of WebGPU's prototypes in web/gpu-worker.ts (console lines starting `venus`, ≤ 400 chars: chunk
  them) counts or dumps a run's whole WebGPU stream in one SwiftShader boot.
- CI alone: ci.sh 465 s, ci-deqp-vk.sh 853 s, both OK.

## State (2026-10-29, the final NVIDIA run processed: L9 opened)

- **The run** (c8087cb0's bundle, REPORT.md "VK3: the final NVIDIA run", `results/vk3/nvidia-final/`): presentation,
  mpv's frames, replays, pipelines and the rows as on SwiftShader and at L4e; **subgroups of 32 not held and right**;
  dEQP-VK 4,624 pass, 2 fail, 64 NotSupported (ASTC/ETC2, subgroup size 4), YCbCr 773 of 773.
- **Open, taken by L9** (below): Venus's submits are done ~2 ms later than at L4e (the scene 5–40% dearer a frame, the
  GPU's pass the same; mpv 1 drop in one round), and the two NVIDIA-only dEQP-VK fails.
- After L9: its NVIDIA check in a new bundle if a fix needs one (`VK2_STEPS="scene mpv deqp"`), then the close (step 6).

## State (2026-10-28, after L8a: only the user's NVIDIA run is left)

- **Every loop is done** (L1–L8a; REPORT.md "VK3: the summary", each loop's section). L8a fixed the track-end review's
  1–4 with tests (its 5 wrong). CI at c8087cb0, alone: ci.sh 528 s, ci-deqp-vk.sh 848 s; ci-debian.sh and
  ci-machines.sh at L8 (scripts and docs since).
- **The gate:** met on SwiftShader and the M4 but for Dawn's program (the guest's Mesa: backlog); on NVIDIA as of
  4fdc69fb but for 1 fish (parked by the user). L5–L8a haven't run on NVIDIA.
- **Open: the user's final NVIDIA run** (another day, a fresh session): the bundle is built (c8087cb0); how to run it,
  what it must answer and how to process its results and close the track: "The final NVIDIA run" below.

## Where VK3 stands

Every loop L1–L7b is done; what each landed is REPORT.md "VK3: the summary" (and each loop's own section). Still
open beyond the two items above, all filed in docs/backlog.md: Dawn in the guest's Chromium (opaque-fd semaphores, a
guest Mesa change), GSK on Vulkan under GTK4's bar, vkd3d's failing tests, usage scopes, API 1.3's required features,
Venus at 1 fish on NVIDIA (parked), the Mesa async-present report upstream, **the hosted desktop disk
(vmdisks.tny.im) to replace before the next deploy** (an old disk's first cold mpv freezes), the review branches
(`origin/review/venus-*`) kept until the user says to delete them.

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
  - [x] L7a: **the binding model's limits and identities.** **Done:** one count, the limits from it, refusals; every
    finding fixed or guarded; ANGLE's 205 an sRGB view, filed.
  - [x] L7b: **the rest.** **Done:** every finding fixed with its test (7's a performance hazard: its test guards the
    new walk) but L6b–L7.3's 3b and 4's import (warned, refused; filed).

- [ ] **L9** (the final NVIDIA run's findings; time-boxed ~3 h each, ask the user before going past):
  - [x] L9a: **Venus's submit-to-done regression on NVIDIA.** **Done (not reproduced off NVIDIA; located in Dawn's
    `Queue::Submit` there; the suspects switchable, `nvidia.sh` `VK2_STEPS=l9`):** REPORT.md "VK3 L9a". At 4fdc69fb a scene submit was done 3.28 ms after
    it was made at 1 fish (4.90 toolkit, 5.62 at 1,000 fish, mpv 3.89); at c8087cb0 5.41, 6.88, 7.03, 4.85; the pass's
    GPU time and encoding the same or lower, `fence.ts` unchanged (REPORT.md "VK3: the final NVIDIA run"). First: an
    A/B of the scene at 4fdc69fb and c8087cb0 on the M4 (sway-mac.sh, alternated, ≥3 rounds) and SwiftShader, reading
    the render stats' `venus` done and fences. Reproduced: bisect the 34 Venus commits between them (`git log
    4fdc69fb..c8087cb0 -- vk web`) and fix, keeping the change's correctness (its dEQP-VK cases). Not reproduced: make
    the suspects switchable (`?gpu=` knobs, off = L4e's behaviour) and add them as arms to nvidia.sh's scene step for
    the next run.
  - [x] L9b: **the two NVIDIA-only dEQP-VK fails**. **Done (the LOD fixed; the cascade fixed, its trap filed; `nvidia.sh`
    `VK2_STEPS=l9b`):** REPORT.md "VK3 L9b". Was: `glsl.texture_functions.textureprojlodoffset.clamp_to_edge.
    isampler2d_vec4_fragment` and `memory.binding.regular.suballocated.buffer_1048577` (detail in
    `results/vk3/nvidia-final/deqp-vk/results.json`). Read what each checks against what the driver and translator do
    (a defect SwiftShader tolerates?); run them on the M4 by name (`CASES=`). A Venus defect: fixed with its test failing
    first. NVIDIA's (Dawn, the driver): filed in docs/backlog.md with the evidence; the list unchanged.

- [x] L8: the track's end (REPORT.md's VK3 summary, docs, plan §6/§7, the final NVIDIA run scripted, the four CI
  scripts). Left to the supervisor: an out-of-context review of what VK3 changed.
  - [x] L8a: **the track-end review's findings** (`git show origin/review/venus-vk3:VENUS-VK3-REVIEW.md`, of
    3f8aa595..dedd54e6, now 72d2f561): 1 (a 4-aligned `vkCmdCopyBuffer` within one VkDeviceMemory is a same-buffer
    `copyBufferToBuffer`, which WebGPU rejects, losing the submit: high), 2 (the provoking-vertex pass binds the index
    buffer to its end, past `maxStorageBufferBindingSize` on big buffers; xfb's index range skips the capture the same
    way), 3 (attachment-less passes rasterize at 1 sample with 4 advertised), 4 (descriptor copies overwrite immutable
    samplers), 5 (xfb across a suspended/resumed pass: check the spec allows it; fix or file). **Done:** 1–4 fixed with
    tests, 5 wrong (Vulkan forbids it).

## The final NVIDIA run: running it and processing its results

**This is all that's left of VK3.** The user runs it on another day; a fresh session processes the results and closes
the track. Steps 1–2 are the user's, 3–6 the session's.

1. **The bundle** is on the dev VM: `~/Development/webpc/target/vk3-nvidia-bundle-c8087cb0.tar` (4.7 GiB, built
   2026-10-28 from a clean checkout at c8087cb0 (L8a); its `BUNDLE.txt` says "from c8087cb0bf40", no uncommitted
   changes). The commits after c8087cb0 change only docs (`.md` files). If the code changes before the
   run, rebuild the bundle (below) or the results describe old code. **main's history was rewritten on 2026-10-28**
   (an empty-tree commit removed, every hash after 221d16c8 changed): a desktop checkout from before needs
   `git fetch && git reset --hard origin/main`.
2. **On the desktop**, in a checkout at c8087cb0 or later, with the bundle copied there:

       bench/vulkan/nvidia.sh page <the bundle> ~/webpc-vk2

   ~75 min whole (`VK2_STEPS="deqp rows"` runs only the new steps, ~25 min; `VK2_STEPS="…"` any subset). It ends
   with `~/webpc-vk2/vk3-nvidia-results.tar.gz`, which the user copies into the repo's root on the dev VM. The
   first attempt (2026-10-29) ran every step, then stopped on the subgroups verdict (grep finding nothing, under
   pipefail; fixed in the script, the bundle unchanged): `VK2_KEEP=1 VK2_STEPS=none bench/vulkan/nvidia.sh page
   <the bundle> ~/webpc-vk2` writes the verdict, `host.txt` and the tarball from the results already there.
3. **Unpack** into `bench/results/local/vk3-nvidia-final/` and read `results/summary.txt` (a line per step: `done`
   or `FAILED or timed out (exit N)`, plus the deqp, rows and subgroups verdicts) and `results/host.txt` (driver,
   Chromium, BUNDLE.txt: check the commit is c8087cb0). A failed step: its `results/<step>.log`. The last processed
   run is the model: REPORT.md "VK3: the NVIDIA run after L4e" (commit 40348847),
   its JSON in `bench/vulkan/results/vk3/nvidia-l4e/`.
4. **Answer each question** (below) against the run after L4e's numbers and the M4's, and write REPORT.md
   "VK3: the final NVIDIA run" (placed right after "VK3: the summary"); update the summary's gate table (its NVIDIA
   column and the closing paragraph: "outstanding" → what the run found). Commit the JSON and logs to
   `bench/vulkan/results/vk3/nvidia-final/`; page grabs (PPMs), traces and anything over a few MB stay in
   `bench/results/local/vk3-nvidia-final/`. Delete the tarball from the repo's root.
5. **If something fails on NVIDIA:** reproduce it on SwiftShader or the M4 first (dEQP cases by name through `CASES=`,
   "Things worth not re-discovering" below). A fix belongs to a short fix loop (L9, its test failing first, ci.sh and
   ci-deqp-vk.sh; then the steps that failed again on NVIDIA in a new bundle, `VK2_STEPS=…`). What isn't VK3's to fix
   (NVIDIA's driver, Chromium) goes to docs/backlog.md with the evidence. Ask the user before a loop that would take
   more than a few hours: the track is otherwise done. The pass lists are shared by every adapter: an NVIDIA-only
   failure is filed (as L6b's 7 Metal-only ones were), not taken off the list. Subgroups found wrong but not held:
   that's a fix (the page's run-time check must hold them there too).
6. **Close the track** in one commit, once the results are in (and any L9 is done): REPORT.md's summary says the
   gate's outcome on NVIDIA; PLAN.md §3's VK3 row "done" without "but for the user's NVIDIA run"; docs/plans/graphics.md
   §6's VK3 status the same; docs/backlog.md's entry "VK3's gate on NVIDIA: the user's final run" removed (its
   leftovers filed as their own entries); vk/README.md, docs/devices.md "Venus" if the run changed what they say.
   Then **delete VK3-KICKOFF.md and VK3-HANDOVER.md** in that commit (CLAUDE.md: git history keeps them;
   REPORT.md's summary points at `git show <the commit before>:VK3-HANDOVER.md` for "Things worth not
   re-discovering", as VK2's did). A docs-only commit needs no CI. Then ask the user whether VK4 starts (plan §6
   proposes it); also still theirs: the hosted desktop disk (vmdisks.tny.im) to replace before the next deploy, and
   whether to delete the `origin/review/venus-*` branches and the bundle.

**The questions** (each answered by a step; `results/summary.txt` gathers the verdicts):
1. The gate again on L5–L8a's code, against the run after L4e (REPORT.md's summary table): `present` (vkcube and mpv
   right on the page in every way: bitmap, canvas, readback, auto), `mpv` (0 dropped, the guest within 19–27% busy;
   was 14 and 12%), `mpv-frames-*` (the advanced path taken, VA-API byte for byte software), `scene` (1,000 fish and
   the toolkit cheaper a frame than virgl; was 5.7 against 8.7–8.9 and 3.05–3.19 against 6.81–7.43 ms; 1 fish parked
   by the user, report it only), `replay` (within tolerance; vkQuake's known 1.67%), `pipelines` (warm across a
   restart: 0 misses), `fence`, `trace` (as before: report differences).
2. (L5) Whether the page held the adapter's subgroups: summary.txt's `subgroups:` line ("HELD" when any page log has
   `venus: the WebGPU device's subgroups are wrong in divergent control flow`). If not held, the deqp step's ~720
   subgroup cases and mpv's frames (libplacebo's subgroup paths) say whether NVIDIA's subgroups of 32 are right.
3. (L8) dEQP-VK's two pass lists on NVIDIA (`deqp`: 4,690 and 773 YCbCr cases, never run there; L6b's M4 run had 7
   Metal-only failures): each failure by name, grouped by cause.
4. (L7.4, L7.5) The rows' programs (`rows`): ANGLE's ES3 probe in the guest's Chromium (on SwiftShader `flat
   0,0,255,255`, a capture, `ubo 156`); vkd3d's tests (on SwiftShader a device at 11_0; test_draw_instanced,
   test_draw_indexed_instanced and test_root_constants pass, test_vertex_id fails 39 of 89, test_instance_id 84 of
   372: `results/vk3/l8/`). Same or better counts on NVIDIA.

**Rebuilding the bundle** (only if the code changes first): from a **clean** checkout at the commit, with no loop
running: `scripts/build-wasm.sh`, `vk/build.sh`, `bench/vulkan/nvidia-bundle.sh` (~4.8 GB; it needs
`target/deqp/guest-vk.qcow2`, `target/deqp/deqp-vk.ext4` and `target/vkd3d/vkd3d.ext4`), then `mv
target/vk2-nvidia-bundle.tar target/vk3-nvidia-bundle-<commit>.tar`; check its `BUNDLE.txt`. `VK2_DRY=1
VK0_ANY_ARCH=1 bench/vulkan/nvidia.sh page - <dir>` prints each step's command without a bundle.

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
