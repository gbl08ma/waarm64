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

## Done

- Loop 1: the scene, arms 1 (Mac, KosmicKrisp) and 5 (lavapipe natively). KosmicKrisp and lavapipe draw the same
  frame (0.14% of pixels off by more than 8 levels).

## Next

1. Arm 2: the WebGPU page (`bench/vulkan/webgpu/`): the sim built to wasm with clang, WGSL by hand, on SwiftShader and
   the Mac; check the stop line at once against arm 1.
2. Arm 4: the scene on the guest's lavapipe (a guest image with Vulkan) and the GLES port on virgl.
3. C, D, E, F (bench pages and tools), then arm 3's prototype; A, B, G; the NVIDIA script.

## Notes

- The dev VM got `vulkan-devel vulkan-tools vulkan-validationlayers shaderc spirv-tools spirv-cross 7zip` (zypper,
  2026-10-25); CLAUDE.md's environment list gets them at the track's end commit.
- The Mac's disk has ~11 GiB free: keep `~/webpc-gpu-bench` small.
