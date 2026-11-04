**Approved by the user (2026-11-03).** Drafted by the session that looked into Godot on Venus (its findings below);
the track's row is PLAN.md §3's Vulkan row. Tasks run as VK4's do (VK4-KICKOFF.md "How VK4 runs"): one session each,
the confirming test first, `scripts/ci.sh` and `scripts/ci-deqp-vk.sh` before done, the row below marked with its outcome.

# GD: Godot 4 on Vulkan, end to end

Godot 4.7.2's arm64 build (one binary, few dependencies) as the realistic Vulkan workload that VK4's dEQP-VK work
leads to: its editor and a 3D scene on Forward+ and Mobile in the desktop guest, on the M4, NVIDIA and SwiftShader.
Before more VK4 tasks, so that what VK4 does next is ranked by what a real program meets.

## What was found (2026-11-03)

Harness (committed with G1): `bench/vulkan/godot-disk.sh` (the disk: Godot and two projects, the same scene on Forward+ and Mobile),
`bench/vulkan/godot.ts` (the desktop guest, Godot started by sway, the screen every SHOT_S, Godot's log, the renderer's
stats, its threads' stacks, the journal with any core dump's backtrace), on the Mac through `bench/gpu/sway-mac.sh`
(`SCRIPT=../vulkan/godot.ts`). In the dev VM the page needs `CHROMIUM_ARGS=--enable-unsafe-webgpu` for a WebGPU adapter
(without it Venus has no device, every submit is dropped and the window stays black whatever Godot does).
Results in `bench/results/local/godot/` (dev VM) and `godot-mac-*` (the M4).

1. **SwiftShader (dev VM): Mobile draws right**, ~17 frames/s. Godot leaves Forward+ itself: "Platform supports less than
   48 textures per stage" (WebGPU's 16 sampled textures there). The M4 (48) and NVIDIA stay on Forward+.
2. **M4, Forward+: the background draws, every mesh is missing.** Godot's Forward+ scene shader uses fragment subgroups
   unconditionally (`subgroupBroadcastFirst(subgroupMin(…))` around each cluster loop: scene_forward_clustered.glsl,
   no check of `subgroupSupportedStages`), and on the M4 our device has subgroups of one invocation (held on Chromium's
   Metal path). The translator lowers the rest for size 1 but refuses `read_invocation` ("the subgroup operation
   read_invocation without the device's subgroups"), so the pipelines draw nothing. Printing it as its own value (a
   subgroup of one reads itself) made the box draw at 60 frames/s and the editor's 3D viewport work (`godot-mac-2`, `-7`):
   G1, done.
3. **Then the stalls the user saw on NVIDIA: seconds-long freezes, and the editor killed.** The Forward+ scene fragment
   shader is 275 KB of SPIR-V that prints as **1.3 MB of WGSL** (28,700 lines, 13,113 function-scope `var`s in one
   function, 218 loops, nesting 20 deep). A Chromium trace on the M4 (`godot-mac-7/trace.json`, `long.txt`): Dawn's
   `DeviceBase::APICreateShaderModule` takes **5.0, 6.3 and 5.5 s** on the GPU process's main thread, which every
   WebGPU and WebGL call of the page goes through. Meanwhile the GPU worker blocks: in a synchronous WebGL call of the
   virgl renderer (sway's `CheckFramebufferStatus`, 5 s), and on WebGPU's full command buffer (`WaitForAvailableEntries`,
   3.4 and 6 s). Nothing polls the rings, so the ring's alive bit goes unset past Venus's watchdog (a guest wait checks
   it every ~3.5 s: `vn_relax` in Mesa's vn_common.c) and the guest driver **aborts Godot** (SIGABRT in
   libvulkan_virtio.so on a worker thread, `godot-mac-6/dmesg-editor.txt`; 3 of 4 editor runs; the traced one lived).
   In headless Chromium on the dev VM the same module didn't finish `createShaderModule` in 290 s, while a 363 KB
   module with 4,220 vars takes 0.5 s: the cost is superlinear in the module's shape, not its size. The likeliest
   culprit is Tint's uniformity analysis over a function whose every value is a `var`; not yet confirmed.
4. **WebGPU's binding limits are not what blocks Godot.** Of its ~210 stages (the editor's, `MESA_SPIRV_DUMP_PATH` on
   lavapipe through the Mac profile, then the native translator), 209 translate; with the M4's limits only three compute
   stages are refused ("binds 15/9/9 storage textures, past WebGPU's 8": SDFGI's 3D volumes, run only with SDFGI on),
   and in them 12 of the 15 are only read. One compute stage writes an image declared without a format
   (`StorageImageWriteWithoutFormat`, which we don't advertise; Godot uses it anyway). At startup Godot logs
   "Format 'R8_Uint' does not support usage as storage image". The texture counts (up to 33 sampled) fit the M4's and
   NVIDIA's 48.
5. Godot's first frame on the M4: 206 stages translated in 2.1 s, then 60 frames/s with 5 passes and 3 draws a frame;
   natively the scene makes 190 compute and 16 graphics pipelines from 382 shader modules.

## The tasks (in the order proposed)

- **G1. Subgroups of one** (done 2026-11-03: `read_invocation` printed as its value where the device's subgroups are of
  one invocation, the only operation NIR left for size 1: every family of `tests/venus/l5/subgroups.comp` now translates
  and `subgroups-run.comp` runs right with subgroups of one (tests/wgsl.test.ts); Godot's Forward+ box and editor
  viewport draw on the M4 (`godot-mac-2`, `-7`). Left: nothing).
- **G2. Shader modules Dawn takes seconds over** (done 2026-11-03: Tint's uniformity analysis visits every `var` in
  scope at each loop, break and if, and the printer declared all 13,113 values at the top; values are now `let`s where
  their uses stay in scope, vars declared where their scope starts, registers outside only the loops that carry them,
  run-once loops as their statements, scalar floats as f32, register loads by the register's name. The Forward+
  fragment stages 3,725 → 65 ms on the M4 (5,154 → 89 on SwiftShader), every Godot stage under 100 ms, the 209 in all
  8.9 → 0.49 s; the other programs' 105 stages 266 → 135 ms, none slower (bench/vulkan/REPORT.md "GD G2",
  tests/venus/g2/values.comp). Left: backlog "The printer's WGSL"). Find where the time goes (Tint built natively from
  Dawn's sources, profiled on Godot's two modules), then make the printer's WGSL cheap for it: likely values defined
  once as `let` rather than `var` where they dominate their uses, fewer vars, the texture arrays' if-trees not copying
  more than the access. *Done:* every Godot stage's `createShaderModule` under ~100 ms on the M4 (a script over the
  dumped corpus, `bench/results/local/godot-tools/tint-time.ts` made a bench tool), no other program's slower, the
  translator's tests and dEQP-VK's list unchanged. This one affects every large program (vkd3d's games, DXVK).
- **G3. A long GPU-process call must not kill the guest's program** (done 2026-11-03: the ticker is vkr's ring monitor,
  setting the monitored rings' alive bits every second from its own thread through a table the patch keeps under a
  lock; vkcube lives through a 6 s stall of the GPU worker, where it died of "expired ring alive status" (134) before
  (tests/page-venus.test.ts, `window.__webpcStallGpu`; vk/README.md "The ring monitor"). Left: `?gpu=vkpoll=pump` and
  `timeout`, A/B knobs, have no monitor between polls). The ring's alive bit set from outside the
  GPU worker's thread while that thread is in a call (the ticker, web/venus-ticker.ts, already runs beside it), so
  Venus's watchdog sees a busy renderer, not a dead one; Mesa's own 895 s abort stays for real hangs. *Done:* a test
  that blocks the worker past 4 s under a guest wait without the program aborting.
- **G4. Read-only storage images bound as sampled textures** (done 2026-11-04: a storage image a stage only reads is a
  texture where it must be (loaded without a format, or a format with no storage texture) or where the stage's storage
  textures pass WebGPU's; SDFGI's one-layer 2D array views bound where 2D is declared and its R4G4B4A4 views of R16_UINT
  images as packed aliases; Godot's 209 stages within 6 storage textures (was 15/9/9), driver tests 84–87, dEQP-VK's
  list unchanged and passing (vk/README.md "Storage images a stage only reads"). SDFGI draws on the M4: its stall, a
  first frame that never finished, was Playwright's Chrome for Testing 153.0.8010.12 reading an indirect dispatch's
  first immediates clobbered (`light_count` as 0xffffffff in the direct-light loop), fixed in Chrome itself; the Mac's
  runs now use the current Stable Chrome for Testing, and on 157 the scene and the editor meet the bar (bench/vulkan/REPORT.md
  "GD G4"). Left: the review's other findings in docs/backlog.md "Storage images read as textures' leftovers"; the
  endless dispatch that wedged the M4's GPU, an upstream report in docs/backlog.md). A storage image a stage only reads is a texture
  read by `textureLoad` (the texture gets `TEXTURE_BINDING`), which takes Godot's SDFGI stages under 8 storage textures
  and helps any program past WebGPU's storage limit. *Done:* Godot with SDFGI on draws; dEQP-VK cases with read-only
  storage images still pass.
- **G5. Storage images without a format** (done 2026-11-04: `shaderStorageImageReadWithoutFormat` and
  `WriteWithoutFormat` offered with their format features; a storage image written or only sized without a format is
  printed for the bound view's format through a variant keyed by it (a storage texture, or words), one only loaded is a
  texture (G4); Godot's corpus all translates (210 and 175 stages), driver test 88 (and 87 answers the size now);
  92 more of `api.buffer_view.access` in the list, passing already (not G5's: never sampled); the 122
  `uniform_storage_texel_buffer` cases need `VK_KHR_maintenance5`, not these features, and this dEQP-VK build has no
  `image` group: no image case to add. Left: nothing). A variant by the view's
  format at the bind (or words), and `shaderStorageImageWriteWithoutFormat` advertised. *Done:* Godot's stage translates;
  `api.buffer_view`'s and the image cases join the list.
- **G6. R8_UINT storage** (S) (done 2026-11-04, nothing to change: Godot asks it of its default VRS texture, R8_UINT
  4x4 as colour attachment, sampled and storage, on devices without VRS; our device offers R8_UINT storage in optimal
  tiling on every adapter since VK4 T11 (words without tier1). The error came only from the two dev VM runs without a
  WebGPU adapter (`vm-1`, `vm-2`: "this browser has no WebGPU adapter here"), where the driver has no adapter caps;
  none of the runs with one logged it. Left: images/vkframes/venus-profile.json predates T11, docs/backlog.md).
  What Godot asks of it, offered through words or tier1.
- **G7. Godot as a standing workload** (M). A capture of Godot's scene frames (GFXReconstruct on lavapipe, as vkQuake's)
  replayed on the page beside the other programs' (tests/page-venus.test.ts); the editor's first start timed on the M4
  (cold and with the shader store warm); a `godot` step for `bench/vulkan/nvidia.sh` so the user's next NVIDIA run
  confirms G1–G3 there; then a bigger project (one of Godot's demos with lights, shadows, decals, SDFGI and
  post-processing) to find what the simple scene doesn't reach.

**The bar:** the editor opens a Forward+ project and its 3D viewport draws, and a Forward+ scene with lights and shadows
runs, on the M4 and on NVIDIA, with no stall over a second after the first frame's compile, and no abort.
