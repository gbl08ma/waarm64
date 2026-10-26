# M8 VK2 handover

Notes between VK2's sessions (the brief: `VK2-KICKOFF.md`). Newest state first.
VK1's kickoff and handover are in git history (the commit that added this file); what VK1 built is described where it
lives: vk/README.md, docs/devices.md "Venus" and "The host-visible window", bench/vulkan/REPORT.md's VK1 sections.

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
- **L4, presentation on the desktop guest:** sway on GLES imports Venus's WSI images as dma-bufs into virgl
  (`blob-ctx`, today ignored). Share by resource: a WebGPU texture → the WebGL2 texture of the same resource
  (candidates: a WebGPU canvas context on an OffscreenCanvas + `texImage2D` from it, or `transferToImageBitmap`;
  measure per-frame cost at 1080p; a CPU readback is the slow fallback). `SET_SCANOUT_BLOB` only if a guest scans
  a Venus image out.
- **L5, vkmark and vkQuake right, dEQP-VK:** the direct rows' dEQP-VK groups as pass lists in a CI script of their own
  (`scripts/ci-deqp-vk.sh`, as ci-deqp.sh for GLES; images/deqp/build.sh needs deqp-vk). Frame times on the Mac
  (bench/gpu/sway-mac.sh, `SCRIPT=`) against VK1 and against virgl where there's a GL path.
- **L6, mpv (the gate):** VA-API surfaces (virgl resources decoded by WebCodecs) imported into Venus as dma-bufs;
  libplacebo's import of NV12 planes. Bar: no drops, the guest 19–27% busy.
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
