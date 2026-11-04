# GD handover

## The SDFGI stall (from G4, open)

**State.** G4 is done (GD-KICKOFF.md); with it Godot's `sdfgi` scene (bench/vulkan/godot-disk.sh) gets SDFGI's
pipelines on the M4, and its first frame never finishes: the GPU stays at 100%, the browser's GPU processes can't exit
(state `E`, `kill -9` doesn't take them) and only a restart of the Mac frees the GPU. One valid run shows it
(`bench/results/local/godot-mac-g4b`, Chrome's default flags, a clean GPU). Every later M4 run that night (g4c–g4f:
traces, `vkgputime`, `sdfgi-least`) started on the GPU g4b had wedged and proves nothing. `godot-tools/dispatch-each.ts`
(each translated compute stage once, on zeroed inputs) finished all 151 on SwiftShader and the M4: weak evidence that
no stage loops by its code alone.

**A finding of its own.** Web content (our page, WebGPU on by default on macOS) made the M4's GPU run without end, and
neither Chrome (Dawn's device loss, its watchdog) nor macOS (Metal's timeout) recovered: the GPU processes stuck
exiting, the Mac throttled (the dev VM's CI with it) until restarted. A small standalone WebGPU page reproducing it
would be worth a Chromium bug (and Apple's, for processes stuck exiting); filing is the user's call.

**Rules.** No SDFGI (or other suspect) run on the M4 without a guard against a runaway pass, and none without the user
there to restart the Mac if it wedges; after any Mac run, `bench/gpu/mac-leftovers.sh` (`--kill` allowed).

**Tried on the dev VM (2026-11-04).** Chromium's WebGPU can't run on lavapipe here: Dawn finds it (`chrome://gpu`:
"llvmpipe … Blocklisted - crbug.com/40057808: CPU adapters not fully tested or conformant") and hands out SwiftShader
whatever the switches (`--use-vulkan=native`, `--use-webgpu-adapter=default`, `forceFallbackAdapter`,
`--disable-dawn-features=use_blocklist`), so the page can't get the M4's limits (48 textures, 8 storage textures) and
SDFGI's pipelines can't run on the page here. `dispatch-each.ts` with adversarial inputs (`FILL=ones|nan|big`: every
buffer word and sampled texel `0xffffffff`, a NaN, or 1e30) runs 2, 7 and 9 stages past 15 s on one workgroup (none on
zeros); the ones read are bounded by a count from a buffer (volumetric fog's `0x8b27729f8e…`: `i >= params[0x38]`
compared signed, ~2·10⁹ with those fills), so long on bad data natively too: such a test can't tell a translation bug
from a count read wrong, but shows that a "never-ending" stall can be a count read wrong (candidate 1 below). The two
big SDFGI-like stages (`0x9ba24f3b3f…`, `0xb1ba74114c…`: 9–10 3D textures, 4 3D storage images) ran past 15 s only on
`big`. Tools in `bench/results/local/godot-tools/` (`dispatch-each.ts`, `adapter-probe.ts`, `gpu-page.ts`).

**Next.**
1. Find the pass that doesn't end. The page on the dev VM can't run SDFGI's pipelines (above), so either:
   a. a guard first: a dev knob that caps every translated loop's iterations (the printer's loops; past the cap, break
      and count it), then one M4 run with each compute pass submitted alone and logged
      (`bench/results/local/godot-tools/stall-debug.py` patches web/venus-gpu.ts for that: `dbgsub`/`dbgdone`, never
      committed); with the user there, since a run without the cap needs a Mac restart; or
   b. a capture of SDFGI's frame (GFXReconstruct natively on lavapipe through the Mac profile, as G7 plans), its
      counts and indirect arguments read at each dispatch natively (the oracle), against what our replay computes.
2. Reduce it to a standalone page: that pass's shader and its inputs dumped from the frame.
3. Then the cause. Candidates, none ranked: a GPU-made count or index read stale (usage-scope shadows, alias or words
   copies), a NaN in a march that exits only by `break` (ordered vs unordered compares, Metal's fast math), an
   out-of-bounds `textureLoad` where Vulkan's robustness gives 0, a loop bound compared with the wrong signedness.
