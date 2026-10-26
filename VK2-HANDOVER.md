# M8 VK2 handover

Notes between VK2's sessions (the brief: `VK2-KICKOFF.md`). Newest state first.
VK1's kickoff and handover are in git history (the commit that added this file); what VK1 built is described where it
lives: vk/README.md, docs/devices.md "Venus" and "The host-visible window", bench/vulkan/REPORT.md's VK1 sections.

## State (2026-10-26, after L6)

- **L6 is done: the gate passes. mpv on Vulkan** (`--vo=gpu-next --gpu-api=vulkan --hwdec=vaapi`, the desktop guest,
  Sintel's H.264 trailer, the media disk) **drops no frame and keeps the guest 13% busy on the M4** (3 rounds, H.264
  in hardware; 2 rounds with `swvideo`, the bar's conditions: the same), against GL (`--vo=gpu`) 12% in the same boot
  and the bar's 19–27%. mpv's CPU +8–15%, sway's 5–20% less; the GPU worker ~0.2 ms a frame for the planes. Frames: on
  the M4 Vulkan with VA-API is byte-identical to Vulkan decoding in software (SwiftShader: 243 of 3.1 M bytes off >24).
  REPORT.md "VK2 L6", JSON `results/vk2/l6/`. No check-in was needed: nothing unpriced (no stall, no call cost).
- **How it works** (vk/README.md "Imports"): the device hands a virgl resource attached to a Venus context to Venus's
  renderer (`blob-ctx` with `size`) instead of virgl; `venus_resource_import` makes it a vkr dma-buf resource whose
  "fd" is its id (vkr patch: no dup under wasi); the driver's memory imported from it keeps `import_res`, an image bound
  there calls `gpu_texture_import`, and web/venus-import.ts writes the resource's bytes into the texture
  (`writeTexture`): the last picture at the bind (kept per imported resource; else a one-off `readResource`), and every
  later picture (`VirglRenderer.onPlane`). `wg_GetMemoryFdPropertiesKHR` answers device-local.
- **Three guest-visible fixes it needed:** webpc-va 3 (images/arch/webpc-va/: exported objects sized by their planes;
  Mesa says a page, libplacebo refused every surface); dma-buf images (external or DRM-modifier) have tight rows
  (`wg_image_dma_buf`: libplacebo checks the image fits the plane's object); `wg_GetPipelineCacheData` returns the
  header alone (the runtime's said `VK_INCOMPLETE` to its own size: libplacebo failed every pass). **The desktop image
  was rebuilt** with webpc-va 3 (`target/arch/desktop.qcow2`; the L5 one is `desktop-l5.qcow2`, delete when happy).
- **Tests:** `tests/venus-driver.test.ts` second test (`wgt_import`: an R8G8 LINEAR-modifier image on imported memory,
  copied out, before and after a picture; planted: no `COPY_DST`, no write at a picture: both caught) and the scene
  test's pipeline-cache check (planted `VK_INCOMPLETE`: caught); `tests/gpu.test.ts` the device's hand-over.
- **Tools:** `bench/audio/avsync.ts` `MPV_ARGS`, `MPV_VARIANTS='vk:…|gl:…'` + `ROUNDS` (alternated), `SHIM=1`;
  `bench/vulkan/mpv-frames.ts` (four arms' screenshots compared in the guest); both through `sway-mac.sh`. For quick
  guest work: `bench/gpu/guest-shell.ts` (a session driven by files in /tmp/guest-shell/: commands, raw keys, screenshots);
  `runLines` drops output without a trailing newline, and a heredoc can't go through `run`/`runLines` (use
  `pasteSerial`). `venus: fence … unretired for N s` now warns of a stuck Venus fence.
- **Worth not re-discovering:** mpv's default VO is gpu-next, which needs GL 3; virgl gives mpv GLES 2, so GL arms are
  `--vo=gpu`. With a Venus device mpv's `gpu-api=auto` takes Vulkan. mpv on Vulkan doesn't exit (vo thread in a DRM
  syncobj wait while sway shows its window; no host fence pending): kill -9 (backlog). libplacebo renders without FBOs
  on our device (r16float/rg16float lack storage: backlog). mpv on GL with VA-API pauses on a different frame than the
  other three ways (virgl's GL path; backlog). The guest has python3 and ffmpeg but not grim.
- **CI at the commit:** ci.sh OK (507 s), ci-debian.sh OK (334 s), ci-deqp.sh OK (284 s), ci-deqp-vk.sh OK (247 s).
- **For L7** (unchanged plan) plus: the NVIDIA run is still unscripted (mpv there would show the software-H.264 case on
  the user's host); r16float/rg16float storage (texture-formats-tier1) for libplacebo's FBOs fits "caps from the
  adapter"; regenerate `images/vkframes/venus-profile.json` when the caps change.

## State (2026-10-26, after L5)

- **L5 is done: vkmark's and vkQuake's frames right, dEQP-VK's pass list in CI** (REPORT.md "VK2 L5", JSON in
  `results/vk2/l5/`). `images/vkframes/build.sh` now captures through the Profiles layer with **the Venus device's own
  profile** (`images/vkframes/venus-profile.json`, `vulkaninfo --json` in the guest: regenerate it when the caps change,
  i.e. L7) so programs take our device's paths; programs: vkcube, vkmark's 13 scenes (a capture each, `-p fifo`, 0.5 s),
  vkQuake (trimmed, frames 200–230: `GFXRECON_CAPTURE_FRAMES`; its replay numbers frames from 2). Each program has a
  tolerance in the disk's `programs`; `venus-run.ts REPLAY=all`; `page-venus` checks them all (~50 s more on
  SwiftShader). **Rebuild the vkframes disk** (it needs `target/vk0a/lq-dl` for vkQuake). SwiftShader and the M4 both
  within tolerance; vkQuake 1.7% >24 on both, identical counts: systematic, unidentified (backlog).
- **dEQP-VK:** `images/deqp/build.sh vk` (Containerfile.vk: vulkan-cts-1.4.7.0 deqp-vk; `target/deqp/deqp-vk.ext4`,
  `guest-vk.qcow2`: Arch + vulkan-virtio; the guest is made once, `vk --guest-only` remakes it), `scripts/ci-deqp-vk.sh`
  → `tests/page-deqp-vk.test.ts` over `tests/deqp/vk.txt` (1,471 cases). `bench/gpu/deqp-run.ts vk` gained `PREFIX`
  (groups) and `PASSED=1` (the passing names), `QPA=1` (dEQP's log with images: how the linear-image bug was found),
  crash resume (a crashing case is recorded `Crash`, the run goes on) and the statuses fetched gzipped. Samples: 4,278
  pass / 665 fail / 5 crash of ~20,000; failures by cause in backlog "The Vulkan driver's gaps".
- **Driver/translator changes:** 8 sets (3+ packed into bind group 3, `set_groups`), push constants to 128 bytes (past
  immediates: the device's push buffer, a dynamic offset in group 3), dynamically indexed sampled-image arrays (if
  trees), barriers in loops (`workgroupUniformLoad` conditions), program variants for unfilterable/depth views (+ the
  sampler's nearest twin), aspect views without a format, 1D images as 2D, integer textures sampled → fetched
  (clamp-to-edge), compressed sizes rounded to blocks, 3D slices as attachments (`depthSlice`), attributes past their
  stride (own vertex slot), triangle fans (device fan index buffer), depth clip off, linear images in host-visible
  memory (copied from/to their memory every submit), `indirect-first-instance`, D24S8 stencil copies; a translation
  failure now makes draw-nothing shaders (a failed pipeline killed the guest's whole context: vkr "failed to look up
  object"); the worker skips copies WebGPU refuses and catches what its API throws (both used to wreck the submit or
  the module's state).
- **Frame times on the M4** (VK0's scene, desktop guest): Venus VK2 0.93–1.06 / 2.53–2.71 / 0.86–0.90 ms a frame
  (1 fish / 1,000 / toolkit) against virgl 1.43–1.45 / 4.83–5.46 / 3.40–3.60, and VK1's null renderer 0.46 / 1.58 /
  0.43; the guest's CPU a frame +≤10% over VK1's. Replay rates: vkmark 60–121 fps on the M4 (same as SwiftShader:
  guest-bound), vkQuake 43 (14 on SwiftShader).
- **Worth not re-discovering:** WebGPU object ids are reused: anything cached by an id (a set's bind groups by layout)
  must use a never-reused uid (`bgl_uid`), and ids must not be released while the replay may still set them
  (`released_groups`). Venus's guest driver doesn't wait for pipeline creation: never fail `vk_shader` compile. A
  `pkill -f` on a pattern in your own command line killed the shell again (exit 144): use `pgrep -f "name[.]sh"`.
  `nir_build_tex` takes the dimension from the deref's type (a lowered 1D texture's is still 1D). `align()` asserts a
  power of two (ASTC blocks aren't). dEQP reads colour results through a linear image it maps: without linear-image
  memory every colour test read zeros. Mac benchmarks share the M4 with the dev VM: run them while the VM is idle.
- **CI at the commit:** ci.sh OK (505 s), ci-deqp.sh OK (281 s), ci-deqp-vk.sh OK (246 s), ci-debian.sh OK (349 s).
  The planted fan-index bug was caught by dEQP-VK (`draw.renderpass.basic_draw.draw.triangle_fan.45`), a planted
  push-buffer offset by `venus-driver` (whose compute pass now uses set 4 and 128 bytes of push constants).
- **Not done, for L6/L7:** the user's NVIDIA run is still unscripted (`bench/vulkan/nvidia.sh` runs VK0's arms):
  script the page with REPLAY=all and the scene there (L7). VK1's replay rates weren't measured (no VK1 build in the
  tree; would need its commit's vk/ built in turn). vkQuake's systematic difference; texel buffers (its
  palettization), texture offsets as constants, per-face stencil, occlusion queries; and dEQP-VK on the Mac's GPU
  (`sway-mac.sh` doesn't pass `vk` through yet: it copies only deqp.ext4).

## State (2026-10-26, after L4)

- **L4 is done: Vulkan's frames reach the screen through virgl** (vk/README.md "Presentation", web/venus-share.ts).
  sway on GLES imports a WSI image (a Venus blob) into virgl and types it (`PIPE_RESOURCE_SET_TYPE`, virgl command 49,
  unsupported until now); the virgl renderer makes a texture (`ExternalResource`) and VenusShare fills it from the
  image's WebGPU texture (`venus_resource_texture`: vkr's resource → its device memory → the driver's shared image)
  when the driver wrote it since (web/venus-gpu.ts records each texture's last writing submit). Two ways, chosen by
  `shareMode` (`?gpu=vkbitmap|vkreadback` force one): **bitmap** (a draw into a WebGPU canvas, `transferToImageBitmap`,
  `texSubImage2D`) on a GPU, **readback** (`mapAsync`, the compositor's submit held in the call queue meanwhile) where
  the page renders in software.
- **Measured at 1080p** (bench/vulkan/share.ts, results/vk2/l4/): M4 bitmap 0.80 ms a frame, canvas `texSubImage2D`
  0.93, readback 1.89 (rgba16float 0.96 / 1.09 / 3.57); SwiftShader readback 6.97 / 10.47 ms. In place (desktop guest,
  vkcube at 1080p on the M4, apps-load.ts with `SCREEN`, `GPU_KNOBS`): 60 frames/s both ways; bitmap ~0.08 ms of the
  worker a frame, readback ~0.7 ms plus holds up to 8 ms, and vkcube's guest CPU 2.05–2.56 vs 3.1–3.2 ms a frame.
  REPORT.md "VK2 L4". A fullscreen window (direct scanout) wasn't tried: apps-load's APPS/PRE don't pass through
  sway-mac.sh (they'd need quoting there).
- **Tests:** `tests/venus-share.test.ts` (Chromium: bytes through both ways, staleness, an X format, rgba16float;
  bitmap only where not software: run by hand on the Mac, passes; planted bugs caught: no staleness check, the
  readback's row pitch ignored, a wrong swizzle on the Mac). `tests/page-venus.test.ts` adds a GLES sway with vkcube and
  grim (images/debian-vulkan/build.sh now installs grim: **rebuild that image**): ~74% of the shot is vkcube's clear
  colour and two shots differ; without the sharing the window is black (planted: caught).
- **Worth not re-discovering:** a WebGPU canvas whose swap chain can't be made (SwiftShader in headless Chromium) loses
  the page's whole GPU channel, WebGL contexts and every WebGPU device included, even from a worker of its own: never
  probe it, decide by the renderer's name. Mesa's Wayland WSI offers every format with `COLOR_ATTACHMENT` (it doesn't
  check modifiers), and vkcube takes R16G16B16A16_SFLOAT: hiding the modifier for it made swapchain creation fail
  (cube.c:1486), so float images are shared too. vk/build.sh hid compile errors (`ninja >/dev/null` under `set -e`):
  it now prints the log's tail; check venus.wasm's time after a build.
- **For L5:** the gaps are docs/backlog.md "Presentation's gaps" (fullscreen/direct scanout untried, compute-written
  images, other formats). dEQP-VK as planned.

## State (2026-10-26, after L3)

- **L3 is done: vkcube draws right** (vk/README.md "Checking frames"). Its calls are captured with GFXReconstruct on
  the dev VM's lavapipe and replayed in the guest on the Venus device offscreen, and the frames are compared with
  lavapipe's byte by byte in the guest (`images/vkframes/build.sh`'s disk: the replay built for Debian in Podman, the
  captures and references, `run.sh`). Frames 5, 15 and 30: 0.03% of the bytes off by more than 24 on SwiftShader,
  3–6 bytes on the M4's Metal; the front face inverted gives 12%. `tests/page-venus.test.ts` asserts it (≤ 0.2%) when
  the disk is built; `bench/vulkan/venus-run.ts REPLAY=<names>` runs it, on the Mac too (`sway-mac.sh`,
  `SCRIPT=../vulkan/venus-run.ts`). Results: `bench/vulkan/results/vk2/l3/`.
- **For L5:** add vkmark's and vkQuake's captures to build.sh's `PROGRAMS` (both are installed in the dev VM; a
  program whose frames depend on time needs a capture of fixed frames: GFXReconstruct's replay of it is deterministic
  anyway). The gate's NVIDIA run isn't scripted: `bench/vulkan/nvidia.sh` runs VK0's arms, not the page; the page on
  the user's desktop (a whole machine: core, firmware, images, renderer) is L5/L7's to script, once with all the
  programs.
- The replay needs `-m remap` (lavapipe's memory type 0 is host-visible; ours is device-local): `vkMapMemory` failed
  without it. Debian's Venus ICD is `virtio_icd.json` (no architecture in the name). images/Containerfile's digest is
  amd64's (its image cross-compiles): an arm64 build needs the arm64 digest (images/build.sh's EDK2 container's).

## State (2026-10-25, after L2)

- **L2 is done: the driver on WebGPU** (vk/README.md "The driver"; `vk/driver/`: wg_device.c, wg_format.c,
  wg_descriptor.c, wg_shader.c, wg_cmd.c, wg_gpu.h; web/venus-gpu.ts). Memory as GPU buffers, images as textures,
  shaders through the runtime's `vk_shader` path, render pipelines made at the first draw by a key of the baked state,
  bind groups made at replay and kept on the set, commands recorded into our own list and replayed at submit, host
  writes uploaded from the window's written pages, GPU writes to host-visible memory read back and fills applied
  before the syncs signal (`venus_complete`), fences retired asynchronously (`VenusRenderer.settled` holds the
  device's fence). `tests/venus-driver.test.ts` (Chromium, SwiftShader): a Vulkan program of ours in the module
  (driver/wg_test.c) checks a scene's pixels (texture orientation, depth, a dynamic uniform offset, push constants,
  culling with a clockwise front face), a compute pass's output and a fill, ~0.6 s; planted bug (front face inverted)
  caught. vkcube on Debian through Venus: 300 frames in 6.2 s on SwiftShader, no WebGPU errors (its pixels: L3).
- **The guest oops is found and fixed**: the module's stack was at memory 0's bottom 4 MiB (wasm-ld's `--stack-first`
  default; `--global-base` moves only the data), so every renderer call wrote the core's low memory; L2's deeper calls
  (the compiler in vkcube's start) made it 3 of 3 runs, L1's code 0 of 2. `--no-stack-first` (vk/gen.ts) puts it in the
  arena; then pointers past 2 GiB reach the WASI shims as negative i32s (`>>> 0` there). page-venus now asserts no
  oops. What the stack overwrote in the core wasn't identified (it's 0 to 4 MiB of memory 0: the core's own data).
- Gaps left on purpose: docs/backlog.md "The Vulkan driver's gaps". Next: **L3**.

## State (2026-10-25, after L1)

- **L1 is done: the shader path.** `vk/compiler/` (wgsl.h, wgsl_nir.c, wgsl_print.c, wgsl_test.c): SPIR-V →
  `spirv_to_nir` → our NIR passes → WGSL; how it works is vk/README.md "The shader path". venus.wasm now links
  Mesa's full Vulkan runtime (lite + `libvulkan_runtime` + `libvulkan_instance`), NIR, vtn and `libcompiler`
  (12.4 MB, 1.18 MB gzip). `tests/wgsl.test.ts`: 118 of 127 stages (the scene's + VK1 step 1's 108) translate,
  0.4 ms a stage median in Node, and all 118 compile in Chromium (SwiftShader's Tint); the 9 others are vkQuake's
  outside the direct set. The test checks validity, not semantics: L3's pixels and L5's dEQP-VK do that.
  `vk/build.sh native` also builds `target/vk/wgsl` (ASan) for debugging one stage. `wgsl_link` (nir_opt_varyings
  on a VS/FS pair) and printing a VS against its FS's `wgsl_varyings` are written but untested: the units translate
  stages alone. L2's first pipelines exercise them.

## The plan (loops; each one commit and a short report)

- **L2, the driver on WebGPU** (done; as planned below, but the render pipeline's key is filled at record time and
  the program is made in `compile` from both stages). Replace the null driver's command path with real objects, KosmicKrisp's structure
  (kk_device, kk_shader, kk_cmd_draw: our model, MIT) on the runtime's `vk_shader` path:
  - **Shaders:** `vk_device_shader_ops` (get_nir_options → `wgsl_nir_options()`, get_spirv_options →
    `wgsl_spirv_options()`, preprocess_nir → `wgsl_preprocess`, compile, serialize/deserialize, cmd_bind_shaders,
    cmd_set_dynamic_graphics_state). Monolithic pipelines reach `compile` with VS and FS together (vk_pipeline.c
    partitions them into one linked part): build the `wgsl_layout` from the set layouts (prefix-sum slots per set),
    `wgsl_lower` each, `wgsl_link`, print FS first and pass its `wgsl_varyings` to the VS print. Keep the WGSL and
    `wgsl_info` in the vk_shader (serialize = the pipeline cache by SPIR-V hash, which the runtime keys already).
    `GPUShaderModule`s at compile; the **`GPURenderPipeline` made lazily at draw**, keyed by (VS, FS, the dynamic
    state WebGPU bakes: topology, cull, front face, depth/stencil, blend, write masks, vertex strides and formats,
    attachment formats, sample count, viewport flipped → `wg_flip_y` override), cached. Vulkan 1.3's required
    dynamic states make this unavoidable. Bind group layouts from the merged `wgsl_info.resources` of both stages
    plus the set layout's dynamic-offset types; pipeline layout = 4 BGLs + `immediateSize`.
  - **Calls:** the module imports a small WebGPU API of ours (new `web/venus-gpu.ts` in the GPU worker; the device
    requested there with the adapter's features and limits), objects named by ids the driver assigns (no return
    values crossing, as Dawn's wire does). WebGPU's async parts (mapAsync, onSubmittedWorkDone,
    popErrorScope) resolve outside the module's calls and call back in through exports (e.g. a submit's serial done).
  - **Memory:** a device-local `VkDeviceMemory` is one `GPUBuffer` with every buffer usage (buffers bind as
    (memory buffer, offset): aliasing works); images are a `GPUTexture` per `VkImage` (made at bind). Host-visible
    memory has a shadow `GPUBuffer`; at each submit, upload the window's written pages (web/window.ts `take()`
    already returns them; VK1 only counts) for the memories mapped there, and the whole storage of unmapped ones
    that the CPU wrote (vkr's own storage: track on the C side). GPU writes to host-visible memory (copies, fills,
    updates, query copies, writable storage bindings) are copied back (staging `MAP_READ`, `mapAsync`) **before the
    submit's syncs signal**; fills/updates with CPU-known data can be applied on the CPU at completion instead.
  - **Commands:** record at record time (drop vk_cmd_enqueue): wg_Cmd* capture what's needed into our own command
    list (state from `cmd->dynamic_graphics_state`, bound shaders, descriptor sets' contents at bind → bind groups
    cached by layout and content, created at record or submit); at submit, replay into a `GPUCommandEncoder`
    through the imports. Render passes and dynamic rendering → render passes (subpasses split; the runtime's
    `vk_render_pass` gives dynamic rendering); clears as load ops or `vk_meta` draws; copies/blits per plan §4
    (blits as draws: `vk_meta`); queries (occlusion → WebGPU occlusion query sets + resolve, timestamps where the
    feature is). Syncs: a submit's syncs signal when its `onSubmittedWorkDone` and readbacks finish; the wg_sync
    type stays CPU-side (the guest waits on feedback slots: those are host-visible writes, so they need the
    readback or the CPU-applied fill/update).
  - **y and winding:** VS negates y unless the viewport has negative height (WebGPU's viewport must be positive:
    flip it and set `wg_flip_y` 1). Check the front face empirically with vkcube's culling and dEQP.
  - Not yet decided by measurement: sync `createRenderPipeline` vs `createRenderPipelineAsync` + stalling the ring
    (kickoff: async parts awaited outside the module's calls). Start with the sync one; measure the first-draw stall.
- **L3, vkcube draws right** (done, through GFXReconstruct's replay rather than the WSI's frames: above). Planned as: tests/page-venus.test.ts's sway is headless pixman with `MESA_VK_WSI_DEBUG=sw`, so the
  WSI copies the image to a host-visible buffer and reads it on the CPU: the whole path without presentation. Check
  pixels (e.g. `grim` in the guest, or vkcube's frame read from sway) against the Venus oracle's
  (tools/venus-oracle, lavapipe) within a small difference.
- **L4, presentation on the desktop guest** (done 2026-10-26, as planned; the bitmap way won, the readback way is
  SwiftShader's: above). Planned as: sway on GLES imports Venus's WSI images as dma-bufs into virgl
  (`blob-ctx`, today ignored). Share by resource: a WebGPU texture → the WebGL2 texture of the same resource
  (candidates: a WebGPU canvas context on an OffscreenCanvas + `texImage2D` from it, or `transferToImageBitmap`;
  measure per-frame cost at 1080p; a CPU readback is the slow fallback). `SET_SCANOUT_BLOB` only if a guest scans
  a Venus image out.
- **L5, vkmark and vkQuake right, dEQP-VK** (done 2026-10-26; frames through the L3 replay, the list from samples:
  above): the direct rows' dEQP-VK groups as pass lists in a CI script of their own
  (`scripts/ci-deqp-vk.sh`, as ci-deqp.sh for GLES; images/deqp/build.sh needs deqp-vk). Frame times on the Mac
  (bench/gpu/sway-mac.sh, `SCRIPT=`) against VK1 and against virgl where there's a GL path.
- **L6, mpv (the gate)** (done 2026-10-26: no drops, the guest 13% busy; above): VA-API surfaces (virgl resources
  decoded by WebCodecs) imported into Venus as dma-bufs; libplacebo's import of NV12 planes. Bar: no drops, the guest
  19–27% busy.
- **L7, the rest of the deliverable:** caps from the adapter at start (port bench/vulkan/profiles/make.ts's mapping to
  the worker; pass them to `venus_init`; drop vk/profile.ts's compiled-in Mac profile); YCbCr and modifiers kept or
  dropped by measurement (GTK4 then switches); the Machines page's Vulkan setting; the module in `npm run dist` with
  its licences; REPORT.md's VK2 section (module size, a pipeline's and a submit's cost, the gate), docs, plan §6/§7.

## What the direct set must not advertise yet (found in L1)

- `shaderFloat16` (the Mac profile advertises it; the backend fails 16-bit values: either `shader-f16` support in
  the printer or off), descriptor indexing beyond constants, more than 4 sets, texel buffers. WGSL has no 1D array
  textures, no multisampled arrays, no storage cube views, no image atomics, no `textureQueryLod`, no
  interpolation at offset or sample: keep them unadvertised or lowered.
- WGSL needs the texture's sample type statically (`float` / `unfilterable-float` / `depth`), which Vulkan leaves to
  the bound view: a depth view sampled without compare, or r32float with a linear sampler, need a pipeline variant
  re-printed with that binding typed differently (keep the lowered NIR per shader so WGSL can be re-printed), or
  `float32-filterable` where the adapter has it.

## State before L1 (VK1, 2026-10-25)

- **VK1 is done.** On a machine with Vulkan (`?gpu=vulkan` with 3D; Debian's tests' image with Venus is
  `images/debian-vulkan/build.sh`, the desktop guest has it too): the device, the host-visible window (256 MiB after
  RAM in memory 0) and its write-watch, and the renderer (`vk/build.sh` → `target/vk/venus.wasm`: vkr over a null
  driver on Mesa's lite runtime, instantiated on memory 0 in its 256 MiB arena at 0xF000_0000). vkcube, VK0's scene and
  GTK4 (GSK on Vulkan) run on it and draw nothing. `tests/page-venus.test.ts` (ci-debian) and
  `tests/venus-renderer.test.ts` test it.
- **The gate** (REPORT.md "VK1: the gate"): Venus costs the guest 2.2–8.7× less a frame than virgl in the scene, a third
  less in fishbowl, 11% more in GTK4's frames (the guest's submit path: docs/backlog.md). The write-watch costs nothing
  measurable a frame.
- The harnesses: `bench/vulkan/guest.ts <virgl|venus|venus-nowatch>` (VK0's
  scene), `bench/vulkan/apps-load.ts` (programs under sway), `bench/gpu/gtk4-load.ts` with `VIRGL_GPU=virgl,vulkan`
  and `RENDERERS=gl,vulkan,…` (alternated rounds), all on the Mac through `bench/gpu/sway-mac.sh` (`SCRIPT=`), which
  copies the renderer there.
- How to watch a Mac run (it has no stall check of its own): its log is
  `~/webpc-gpu-bench/bench/results/local/<name>.log` on the Mac; a monitor that greps it every minute for result
  lines and errors and says when it stops growing caught VK1's one stuck run. Match local processes with a pattern
  that can't match the monitor's own command line (`pgrep -f "sway-mac.s[h] …"`).

## Things worth not re-discovering

- A driver on the `vk_shader` path must point `cmd->vk.dynamic_graphics_state.vi` (and `ms.sample_locations`) at
  storage of its own, at create and after each reset: without it the pipeline's vertex input never reaches the state
  (a render pipeline with no vertex buffers).
- The module's stack: see "State after L2" (wasm-ld's `--stack-first` default). Check `__stack_pointer`'s initial
  value (`wasm-tools print target/vk/venus.wasm | grep -m1 global`): it must be in the arena (0xF0xx_xxxx, negative
  as an i32).
- Mesa 26.2's common `vkCmdDrawIndirect`, `vkCmdCopyBuffer2`, `vkCmdFillBuffer` and friends forward to the device
  address forms: the driver implements the classic entry points itself.

- Mesa builds NIR as headers only when no driver that compiles is enabled: the native build enables the Venus ICD
  (`-Dvulkan-drivers=virtio`) just to get libnir whole. Mesa 26.2.4's `spirv2nir` target doesn't link (libnir missing
  from its link line); the harness links the static libraries itself.
- gdb can't run in the dev VM (it fails on the M4's SME/SVE registers under Lima): use the ASan build
  (`bench/vulkan/nir/build.sh native-asan`) for stack traces, valgrind for the rest.
- `nir_to_msl` needs textures as handles (the driver's descriptor lowering) and subpass dims lowered to 2D, or it
  crashes / warns; spike.c has small passes of ours for both.
- The SPIR-V dumps: `SPIRV_DIR=target/vk1/spirv bench/vulkan/translate/programs.sh target/vk1/d` (~8 min, 108 stages;
  GTK4's demo compiles 14 in 15 s, not VK0's 16).
- `tests/usb-glue.test.ts` hung CI again (2026-10-25): a 10 ms wait for port messages failed under load, and the
  ports left open kept the file alive; fixed (bounded wait, `t.after` closes them).
- Don't name a local `window` in `web/vm.ts`'s `bootVm`: `typeof window` decides there whether the thread can block
  (realtime boots in a page worker went idle at virtio probing).
- Venus's guest driver (Mesa 25.0.7) offers `VK_KHR_swapchain` only if the renderer has dma-buf external memory with
  `EXT_image_drm_format_modifier`, `EXT_queue_family_foreign` and a sync-file semaphore it can import (Mesa 26.2 no
  longer asks): vkcube said "failed to find the VK_KHR_swapchain extension" until the null driver advertised them.
- vk/'s two utils: vkr against Mesa 26.2.4's util fails to compile (API drift); it builds against virglrenderer's own
  copy with its symbols renamed (gen.ts). The module's `sbrk` must start at `__heap_end`: from `__heap_base` it
  overlapped dlmalloc's first region ("function signature mismatch" traps far away).
- Mesa 26's Venus driver sends `vkWaitVirtqueueSeqnoMESA` on the ring; vkr's `cnd_wait` there blocked the GPU worker for
  good (the guest: a kworker in `virtio_gpu_queue_fenced_ctrl_buffer`, the page: "virgl: fence N unanswered"). The ring
  now stalls and resumes (vk/README.md). Debian's Mesa 25.0 never sends it.
- Mesa's Wayland WSI wants a modifier the device can render into: with the profile's linear features (no colour
  attachment) `vkGetPhysicalDeviceSurfaceFormatsKHR` failed; Debian's vkcube asserted (`cube.c:4582`), Arch's (release)
  went on and segfaulted on a NULL swapchain. A segfaulting Venus program's core dump then hung the guest for minutes:
  `ulimit -c 0` in experiments. Headless pixman sway offers no dma-buf at all (the WSI's CPU path, `MESA_VK_WSI_DEBUG=sw`).
- GTK's Vulkan renderer asserts `GDK_VULKAN_FEATURE_YCBCR` without `samplerYcbcrConversion` (REPORT D's "aborts on the
  profile"): the driver advertises it. fishbowl adds icons while it holds 60 frames/s, so its CPU a frame is only
  comparable at its icon count (on its screenshot).
- The ring poller stays on `setTimeout(0)`: a MessageChannel loop (to dodge the 4 ms clamp) starved the GPU worker's
  timers while a ring stayed busy, and the device's fence went unanswered (vkcube on Debian hung); it hadn't lowered
  vkcube's guest CPU either. Its guest time is kernel time spread thin (no spin in the profile).
- A blob outlives its device memory: the scene frees its 68 MB staging memory while the blob is still mapped, and the
  unmap's copy-back (and the driver's rebind) wrote into freed heap, which vkr had reused for its objects
  ("failed to look up object 149 of type 9" for a buffer just created). The memory now hands its storage to its
  resource at its free. Not covered by a test yet (it needs Venus commands encoded by hand); the scene's probe
  (`FISH=1 TOOLKIT= bench/vulkan/guest.ts venus`) is the check.
- `images/arch/desktop.sh` with `EXTRA_PACKAGES=gdb --out …` makes a debugging copy (Arch's aarch64 port has no debug
  packages: backtraces show libraries, not functions).
- The Mac's disk has ~8.5 GiB free: VK1's files there are `~/webpc-gpu-bench/vulkan-web/target/vk1` (~15 MB).
- The NIR API in Mesa 26.2: derivatives are intrinsics (`nir_intrinsic_ddx`…), not ALU ops; `nir_lower_flrp` isn't
  run by setting `lower_flrp32` (the printer prints `flrp` as `mix`); `nir_lower_io_vars_to_temporaries` must run
  before the preprocessing's splits (after them `nir_lower_vars_to_ssa` crashed in `foreach_deref_node_worker`).
- WGSL: immediates can't be arrays; a `%` in a printf format of the printer must be `%%` (it printed `(t %s)`).
