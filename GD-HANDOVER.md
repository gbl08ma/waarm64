# GD handover

## G4 (2026-11-04): read-only storage images as textures — code in, not committed to main, SDFGI stall open

**State.** Branch `wip/gd-g4` (pushed) holds the work; main doesn't. Not committed to main because `scripts/ci.sh`
never ran clean on a healthy host: the M4's GPU was wedged at 100% by GPU work SDFGI left behind (four Chrome GPU
processes stuck exiting, state `E`, unkillable), the Mac throttled, and CI's timing tests (page-statusbar,
page-open) failed and two runs were OOM-killed. The Mac was restarted to free the GPU. Next: `scripts/ci.sh` and
`scripts/ci-deqp-vk.sh` on the healthy host, then merge `wip/gd-g4` to main (rebased) and mark G4's row in
GD-KICKOFF.md.

**What's in it** (vk/README.md "Storage images a stage only reads", "Views in another format", the flat view note):
- Translator: a storage image a stage only reads becomes a texture (`textureLoad` at level 0) where it must (loaded
  without a format, or a format with no storage texture) or where the stage's storage textures pass WebGPU's limit for
  the stage (`wgsl_print_options.storage_limits`, `max_storage_textures`); not otherwise (textures have their own
  16). A size-only image without a format stays as before (refused). `image_texture` on the resource; stages that
  disagree on kind or sample type are refused (wg_shader.c).
- Driver: storage images' textures get `TEXTURE_BINDING`; such a binding takes the storage view; a sampled 2D array
  view of one layer has a 2D twin (`wg_image_view.flat`) for shaders that declare 2D (Godot's SDFGI); a packed 16-bit
  view of another 16-bit image is an alias (`view_format_aliasable`; SDFGI's R16_UINT sampled as R4G4B4A4).
- Tests: tests/venus-driver.test.ts `readOnlyImages` (84), `g4Views` (85), `texturesFull` (86), `sizeOnly` (87), each
  failing with its fix planted out; tests/page-statusbar.test.ts now also waits for "Running" (a race a slow host showed).
- bench/vulkan/godot-disk.sh: projects `sdfgi` and `sdfgi-least`.
- The out-of-context review: branch `review/gd-g4-images` (GD-G4-REVIEW.md); findings 1, 2 fixed, 3–6 in
  docs/backlog.md "Storage images read as textures' leftovers", 7 is G5.

**Results.** Godot's editor corpus (native translator, M4 limits): 209 of 210 translate (the other is G5's
format-less write, a 2D post stage), every stage ≤ 6 storage textures (was 15/9/9), all 209 compile in Chromium.

**The SDFGI stall (open).** Only one valid observation: with the view fixes, the `sdfgi` scene's first frame on the M4
(`bench/results/local/godot-mac-g4b`, a clean GPU) never finishes; the GPU work outlives its process and can't be
reclaimed without restarting the Mac. Every later M4 run (g4c–g4f: the traces, `vkgputime`, `sdfgi-least`) started on
the GPU wedged by g4b and proves nothing; `dispatch-each.ts` (bench/results/local/godot-tools/: each compute stage on
zeroed inputs) finished all 151 stages on SwiftShader and the M4, weak evidence that no stage loops by code alone.
Candidates, none ranked yet: a GPU-made count or index read stale (shadows, alias or words copies), a NaN in a march
that exits only by `break` (ordered vs unordered compares, Metal fast math), an out-of-bounds `textureLoad` where
Vulkan's robustness gives 0, a signedness slip in a loop bound.
**Don't run SDFGI on the M4 again without a guard**: each hang costs a Mac restart. Next: replay SDFGI's real frame on
the dev VM (GFXReconstruct capture on lavapipe, as G7 plans) where a runaway pass kills only its process, with each
pass submitted alone (the hack in the scratch `stall-debug.py`, re-creatable: each compute pass submitted with its
pipelines logged, `dbgsub`/`dbgdone`) to name the pass; or an iteration cap behind a dev knob before any M4 run.
After every Mac run, check the Mac's GPU (`ioreg -r -d 1 -c IOAccelerator`) and leftover Chrome.
