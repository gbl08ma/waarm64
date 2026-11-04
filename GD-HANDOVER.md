# GD handover

## State (2026-11-04)

G1–G6 done (GD-KICKOFF.md). G4's SDFGI stall was Playwright's Chrome for Testing 153.0.8010.12, not ours
(bench/vulkan/REPORT.md "GD G4"); the Mac's runs now use the current Stable Chrome for Testing (bench/mac-chrome.sh;
157.0.8103.38), the VM's Chromium is 155, playwright-core 1.64.1.

**The bar on the M4 holds** (Chrome for Testing 157, `bench/results/local/godot-mac-g4q`, `-g4r`): the editor on the
Forward+ project draws its 3D viewport, and the `sdfgi` scene (a sun with shadows, SDFGI) runs, with no gap over a
second after the first frame (757 and 54 ms) and no abort. **NVIDIA is the bar's other half, unchecked:** G7's
`godot` step for `bench/vulkan/nvidia.sh`, run by the user.

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
