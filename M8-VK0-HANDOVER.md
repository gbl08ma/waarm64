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
- **Arm 3** (`bench/vulkan/translate/`): `capture.sh <name> <scene args>` captures the native scene on lavapipe with
  GFXReconstruct, `convert.ts` makes a command stream (`stream.ts`'s format) and `setup.json`, `shaders.ts` translates
  each pipeline stage (spirv-opt: spec constants frozen, combined samplers split; bindings renumbered 2b/2b+1; naga,
  clip space kept and adjusted; spirv-cross reflection); `replay.ts` translates at run time in a worker
  (`bench/vulkan/arm3.ts`, `mac.sh arm3`). Traces in `target/vulkan/captures/<name>-trace`.
- **Tools** (a subagent built them): `tools/venus-oracle/` (Venus on lavapipe over vtest: `run.sh <client>`; needs
  `/dev/udmabuf` open to the user: `sudo setfacl -m u:gabriel:rw /dev/udmabuf`, lost at a reboot),
  `tools/vulkan-tools/` (GFXReconstruct: `gfxr-capture.sh out.gfxr q:159-161 <cmd>` captures frames 100-102 of the
  scene by queue submit, 59 setup submits; the Profiles layer).

## Done

VK0 is done (2026-10-25): `bench/vulkan/REPORT.md` holds S's ratios, A to G, the route (b), the advertised set and
its order, the render-pass rule and the bar; the plan's §3 to §7 are updated from it. The NVIDIA desktop's results are
in `bench/vulkan/results/nvidia/`, G's in `results/g/`, D's program coverage in `results/d/`
(`translate/programs.sh`).

## Next

The user decides whether VK1 starts (it gets its own kickoff; this handover and `M8-VK0-KICKOFF.md` go in that
commit). REPORT.md "Not done in VK0, ranked" lists what VK0 left; the first is VK1's first step (`spirv_to_nir` and
NIR built to wasm).

## Notes

- The dev VM's new packages are in CLAUDE.md's environment list.
- The Mac's disk has ~11 GiB free: keep `~/webpc-gpu-bench` small.
