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

**Next.**
1. Find the pass that doesn't end, on the dev VM, where a runaway pass kills only its process: SwiftShader's limits
   (16 textures a stage) keep Godot off Forward+, so replay SDFGI's real frame from a capture (GFXReconstruct on
   lavapipe, as G7 plans) with each compute pass submitted alone and logged
   (`bench/results/local/godot-tools/stall-debug.py` patches web/venus-gpu.ts for that: `dbgsub`/`dbgdone`, never
   committed).
2. Reduce it to a standalone page: that pass's shader and its inputs dumped from the frame.
3. Then the cause. Candidates, none ranked: a GPU-made count or index read stale (usage-scope shadows, alias or words
   copies), a NaN in a march that exits only by `break` (ordered vs unordered compares, Metal's fast math), an
   out-of-bounds `textureLoad` where Vulkan's robustness gives 0, a loop bound compared with the wrong signedness.
