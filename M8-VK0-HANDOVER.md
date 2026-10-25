# M8 VK0 handover

VK0 measures whether Vulkan through Venus translated onto WebGPU is worth building (`M8-VK0-KICKOFF.md`,
docs/plans/graphics.md §5). The report is `bench/vulkan/REPORT.md`; this file carries the work between sessions.

## Where things are

- **The scene** (`bench/vulkan/scene/`): the WebGL Aquarium ported. `sim.c`/`sim.h` (the simulation, our own sin, cos
  and random numbers, no libc: the wasm build shares it), `scene.h` (the Aquarium's draw order as a command list every
  arm replays), `toolkit.h` (the GTK4-shaped setting), `shaders/` (GLSL 450), `vk.c` (native Vulkan: offscreen, two
  frames in flight, re-recorded command buffers, per-frame descriptor updates, dynamic offsets, push constants),
  `build.sh`. `bench/vulkan/assets.ts` makes `target/vulkan/aquarium.pack` (textures decoded by Chromium).
- **Native runs:** `bench/vulkan/sweep.sh` (every fish count and toolkit size, MSAA 1 and 4, one JSON each);
  `bench/vulkan/mac.sh [kosmickrisp|moltenvk]` runs it on the Mac host from `~/webpc-gpu-bench/vulkan` with the SDK
  parts that `bench/vulkan/macsdk.ts` unpacks (nothing installed there); `DUMP=300 ARGS='--fish 1000'` renders one
  frame. Frames compare with `bench/vulkan/tools/ppmdiff.py`.
- **Results so far:** `bench/vulkan/results/loop1/` (arm 1 on KosmicKrisp, arm 5 lavapipe in the VM).
- **Arm 2** (`bench/vulkan/webgpu/`, run by `bench/vulkan/webgpu.ts`): the sim built to wasm (`build.sh`; a committed
  copy, `scene.wasm`, for machines without wasm-ld), WGSL by hand (`wgsl.ts`), the renderer in a worker
  (`aquarium.ts`); fish data by storage + firstInstance, dynamic offsets or immediates (`MODES`). Served by
  `bench/vulkan/server.ts` (no Vite: TS stripped by Node). `--probe`, `--dump`; `?sweep` runs in any browser.
- **Arm 4**: `gles.c` (the GLES 3.0 port, shaders from `gles-shaders.ts`), `images/vulkan/build.sh` (the guest
  `target/vulkan/guest.qcow2` with lavapipe, the second disk `disk.ext4`), `bench/vulkan/guest.ts <lavapipe|virgl>`
  (`CHECK=1` compares 32x18 thumbnails of the guest's frames with the native ones).
- **Tools** (a subagent built them): `tools/venus-oracle/` (Venus on lavapipe over vtest: `run.sh <client>`; needs
  `/dev/udmabuf` open to the user: `sudo setfacl -m u:gabriel:rw /dev/udmabuf`, lost at a reboot),
  `tools/vulkan-tools/` (GFXReconstruct: `gfxr-capture.sh out.gfxr q:159-161 <cmd>` captures frames 100-102 of the
  scene by queue submit, 59 setup submits; the Profiles layer).

## Done

- Loop 1: the scene, arms 1 (Mac, KosmicKrisp) and 5 (lavapipe natively). KosmicKrisp and lavapipe draw the same
  frame (0.14% of pixels off by more than 8 levels).
- Loop 2: arms 2 and 4 built and checked on the dev VM: every arm draws the same frames (WebGPU 0.24% of pixels off
  by more than 8; the GLES port 0.00%; the guest's virgl and lavapipe thumbnails within 1 level).

## Next

1. The Mac: arm 2's sweep (all modes), arm 4 (guest lavapipe and virgl through sway-mac.sh). Check the stop line.
2. C, D, E, F (bench pages and tools), then arm 3's prototype (GFXR capture -> a Vulkan command stream translated at
   run time); A (Profiles layer runs), B (Venus captures), G; the NVIDIA script (`bench/vulkan/nvidia.sh`).

## Notes

- The dev VM's new packages are in CLAUDE.md's environment list.
- The Mac's disk has ~11 GiB free: keep `~/webpc-gpu-bench` small.
