# GD handover

## State (2026-11-04)

G1–G6 done (GD-KICKOFF.md). G4's SDFGI stall was Playwright's Chrome for Testing 153.0.8010.12, not ours
(bench/vulkan/REPORT.md "GD G4"); the Mac's runs now use the current Stable Chrome for Testing (bench/mac-chrome.sh;
157.0.8103.38), the VM's Chromium is 155, playwright-core 1.64.1.

**The bar on the M4 holds** (Chrome for Testing 157, `bench/results/local/godot-mac-g4q`, `-g4r`): the editor on the
Forward+ project draws its 3D viewport, and the `sdfgi` scene (a sun with shadows, SDFGI) runs, with no gap over a
second after the first frame (757 and 54 ms) and no abort. **NVIDIA is the bar's other half, unchecked:** G7's
`godot` step for `bench/vulkan/nvidia.sh`, run by the user.

**NVIDIA, the user's first look (2026-11-04): Godot's editor black under X11, drawing under Wayland.** Godot picked X11
(XWayland) there; Mesa's X11 WSI then took the prime blit (`VN_DEBUG=wsi MESA_LOG_LEVEL=debug`: `prime_blit=1`), whose
buffers the page can't show; `--display-driver wayland` drew (`prime_blit=0`). Not NVIDIA's: the X11 same-GPU check
matches PCI devices only and our virtio-gpu is virtio-mmio, so every X11 Vulkan client is black (docs/backlog.md "A
WSI image exported as a buffer isn't shared", now needed, and the Mesa upstream report). The M4 runs drew on Wayland
because our desktop image has no Xwayland (images/arch/); the user's test image has it, so Godot chose X11. Under
Wayland the editor on NVIDIA holds 60 frames/s (a handful of CSGBox3D cubes). The fix is G7's (GD-KICKOFF.md "X11
windows shown": the page shares the prime blit's buffers); the harness then needs Xwayland in its image and Godot's
display driver logged.

**G8 (the GI demo, GD-KICKOFF.md):** its "Couldn't map buffer memory (VkResult error -2)" is
`VK_ERROR_OUT_OF_DEVICE_MEMORY` at a map; first lead, Venus's host-visible window (256 MiB by default, `VENUS_WINDOW`;
docs/devices.md "The host-visible window"). The demo's download may need the user (the asset store).

**Next: G7.** Also worth a look there: the first frame comes ~35 s (editor) and ~41 s (SDFGI scene) after Godot
starts, its pipelines' compile; how much of it the shader store saves on a second start is G7's "cold and warm".

## Tools for a run that may hang the M4's GPU

Not committed (bench/results/local/godot-tools/): `loop-cap.py` (the printer: every loop breaks after N iterations of
its own; `vk/build.sh` after it, `git checkout vk/compiler/wgsl_print.c` and a rebuild to undo),
`stall-guard-worker.diff` (`git apply`: each pass its own command buffer submitted in turn at the submit, its time to
done logged, submits halted once one is 3 s late; immediates, dispatches and indirect arguments logged),
`gpu-sampler.sh` (the Mac's GPU, load and Chrome's processes every 2 s, beside a run). Never `stall-debug.py`: it
submitted passes before their submit's writes. Rules: nothing suspect on the M4 without the cap and the user there;
after every Mac run, `bench/gpu/mac-leftovers.sh`; a Mac-only GPU failure is checked on the current Stable and Canary
Chrome for Testing before it's taken for ours.
