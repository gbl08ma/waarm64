# GD handover

## State (2026-11-04)

G1–G6 done (GD-KICKOFF.md). The Mac's runs use the current Stable Chrome for Testing (bench/mac-chrome.sh;
157.0.8103.38), the VM's Chromium is 155. **The bar on the M4 holds** (`bench/results/local/godot-mac-g4q`, `-g4r`).
**NVIDIA is the bar's other half, unchecked:** nvidia.sh's `godot` step (below), run by the user.

**G7, X11 windows shown (done for X11; G7's capture, cold/warm start and bigger project left):** every X11 Vulkan client in our guest
takes Mesa's prime blit (its X11 same-GPU check matches PCI devices only; our virtio-gpu is virtio-mmio): each frame is
copied into an exported linear buffer. The driver now names that buffer's GPUBuffer (`venus_resource_buffer`), the
page records buffers' transfer writes, and web/venus-share.ts copies the buffer into a texture before the chosen way
(vk/README.md "Presentation", the prime blit's buffers). `tests/venus-share.test.ts` checks the bytes (failed before);
`tests/page-venus.test.ts` runs vkcube through Xwayland (`X11`, needs images/debian-vulkan/build.sh's new image with
Xwayland and python3). The desktop image gets `xorg-xwayland` (images/arch/desktop.sh), so the Godot harness meets
X11 as the user's desktop does; bench/vulkan/godot.ts logs Godot's display server. The editor under X11 draws in
the dev VM (`prime_blit=1`).

**G8 (the GI demo), first findings:**
- The demo downloads without the asset store's login: bench/vulkan/godot-disk.sh puts it at `/projects/gi`
  (sha256-pinned).
- **"Couldn't map buffer memory (VkResult error -2)" is the window.** Linux's virtio-gpu gives a mappable blob its
  place in the host-visible window when the blob is made, and Venus makes a memory's blob at its first map: the window
  caps what's mapped at once, and a full window fails the create, which Venus returns from the map as
  `VK_ERROR_OUT_OF_DEVICE_MEMORY`. VMA on our 1 GiB heap (a "small" heap to it) takes 128 MiB blocks and keeps them
  mapped; the window was 256 MiB with Venus's rings in it. Now 1,280 MiB (web/ram.ts `VENUS_WINDOW`: the heap whole
  and 256 MiB), node 1's RAM at most 1,536 MiB; `tests/venus/vkmap.py` maps 6 × 128 MiB at once in the page test
  (1 of 6 at 256 MiB, failing with -2; 6 of 6 at 1,280). **Confirmed by the user on NVIDIA:** the demo, out of
  memory before, opens and runs at 60 frames/s with the new window (its GI and reflection modes not all tried yet).
- **A second wall, seen on SwiftShader (`bench/results/local/g8/vm-1`):** the device's address buffer (all memory
  allocated with `VK_MEMORY_ALLOCATE_DEVICE_ADDRESS_BIT` in one GPUBuffer, doubling by copy) grew 256 → 512 MiB in
  the editor and Dawn refused the 512 MiB buffer (SwiftShader's Vulkan OOM): every command using it invalid, the editor
  black. Likely VMA with buffer device addresses gives every block the flag, images' blocks too, whose bytes we never
  use (an image is its own texture). Next: confirm (the driver now says each grow: `wg: the device address buffer
  grows to N MiB`), then place a memory in the address buffer only at its first buffer bind (image-only memories
  never), and see the M4's and NVIDIA's `maxStorageBufferBindingSize`, the buffer's ceiling.
- **The GI demo's screen-space effects (SSAO/SSIL), run outside the editor on NVIDIA (the user):** WebGPU refuses a
  bind group, an `r8unorm` view where the layout says `rgba8unorm` (a stage declares a written image rgba8, Godot binds
  an R8 view; native drivers write the view's format), and the whole guest display freezes until that Godot is
  killed. Fix in progress: such an image keyed to the view's format as G5's formatless ones (driver test 89,
  tests/venus/g7/declared.comp). The freeze's own cause isn't known (not a held command's throw: `runOp` catches).
- SwiftShader also refuses Forward+'s stages (16 textures): the demo needs the M4 or NVIDIA. On the M4 it is a
  suspect run (SDFGI, VoxelGI): only with loop-cap and the user there.

## NVIDIA run (for the user)

On the dev VM: `bench/vulkan/nvidia-bundle.sh --godot` (the core, the renderer, the firmware, the desktop image and
Godot's disk, ~2.5 GB). On the desktop: `VK2_STEPS=godot bench/vulkan/nvidia.sh page <bundle>` (~20 min): the
editor under X11 and Wayland, the Forward+ and SDFGI scenes, the GI demo in the editor.

## Tools for a run that may hang the M4's GPU

Not committed (bench/results/local/godot-tools/): `loop-cap.py` (the printer: every loop breaks after N iterations of
its own; `vk/build.sh` after it, `git checkout vk/compiler/wgsl_print.c` and a rebuild to undo),
`stall-guard-worker.diff` (`git apply`: each pass its own command buffer submitted in turn at the submit, its time to
done logged, submits halted once one is 3 s late), `gpu-sampler.sh` (the Mac's GPU, load and Chrome's processes every
2 s). Never `stall-debug.py`. Rules: nothing suspect on the M4 without the cap and the user there; after every Mac run,
`bench/gpu/mac-leftovers.sh`; a Mac-only GPU failure is checked on the current Stable and Canary Chrome for Testing
before it's taken for ours.
