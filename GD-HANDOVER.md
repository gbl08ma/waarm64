# GD handover

## The SDFGI stall (from G4): cause found, a bug of an early Chrome 153 build

**Only Playwright's Chrome.** Every Mac run uses Playwright 1.63's Chrome for Testing 153.0.8010.12 (`chromium-1243`;
stable was 157 on 2026-11-04). `imm-probe.ts` on Chrome for Testing builds (in `~/webpc-gpu-bench/cft/` on the Mac):
the clobber shows only on 153.0.8010.12, sandbox on or off; 153.0.8010.52 (153's last), 154.0.8037.92, 155.0.8059.84,
156.0.8078.80, 157.0.8103.38 (stable) and 159.0.8141.0 (canary) read all twelve words right in all four cases. So a
real user's Chrome doesn't meet it, and the Mac harness measures a stale, buggy Chrome until it runs a current one.

**Cause (2026-11-04).** On the M4, Chrome 153.0.8010.12's WebGPU (Dawn on Metal) gives an **indirect** compute dispatch wrong
immediates: its first six words (bytes 0–23) read `0xffff 0 1 0 0 0xffffffff`, whatever `setImmediates` set; words 6–11
come through; a direct dispatch reads all twelve right; `@builtin(num_workgroups)` makes no difference; SwiftShader
reads them right. Standalone repro: `bench/results/local/godot-tools/imm-probe.ts` (one page, four cases; run on the
Mac through ssh with `CHROMIUM` set to Playwright's Chrome for Testing, as sway-mac.sh does). Godot's
`sdfgi_direct_light.glsl` (stage `0xad9bcc4c09…`, dispatched indirectly) loops `for (i = 0; i < params.light_count;
i++)` with `light_count` its push word 5: it reads 0xffffffff and runs ~4·10⁹ iterations an invocation, which is the
GPU that never finishes, and then the processes stuck exiting (neither Dawn nor macOS ends the work).

How it was found (runs `bench/results/local/godot-mac-g4g`…`g4o`, each with `.gpusamples`: the GPU every 2 s):
every printed loop capped (`godot-tools/loop-cap.py`, a printer patch, never committed), every pass its own submit
with a halt after 3 s (`stall-guard-worker.diff`); SDFGI then draws right on the M4 (box, plane, GI shadow) with one
pass, that stage, at 12 ms a frame; a 16× cap made it 115 ms; caps per loop (only loop 6, the shadow march: no change;
loops 0–4: all of it; loop 4 alone: all of it) gave the light loop; logged immediates (`light_count` 1) and indirect
arguments (1–59 workgroups) were right on the page's side, so the probe followed. The Mac recovered on its own from
every run (the GPU back to 0% as Chrome closed): with the cap, the runaway pass ends.

**Not this cause:** the translation (all ten loops of the stage are bounded by constants or push words, no
`continue` skips an increment), the push constants the worker sets, the indirect counts, the shadow march.

**Unsound tool, don't reuse:** `godot-tools/stall-debug.py` submitted each compute pass as it ended, before the writes
(`gpu_write`'s `queue.writeBuffer`) the rest of its submit makes: 45 driver tests fail with it. The worker diff above
keeps each pass's command buffer and submits them in turn at the submit (135/135 pass).

**Rules.** Nothing suspect on the M4 without a guard (the loop cap) and the user there; after any Mac run,
`bench/gpu/mac-leftovers.sh`.

**Next.**
1. The Mac harness now runs the current Stable Chrome for Testing (bench/mac-chrome.sh; 157.0.8103.38 on 2026-11-04,
   Godot's Forward+ scene checked on it: `godot-mac-cft157`). Next: SDFGI on it with the loop cap (the direct-light
   pass should drop from ~12 ms a frame), and only then without it, the user there.
2. No driver workaround needed for the immediates (fixed in Chrome itself); no Chromium bug to file for it. The other
   finding stands: an endless dispatch wedges the M4's GPU past Dawn's and macOS's recovery (filing is the user's call).
3. Whether a loop cap belongs in the translator for good (a page that hangs the GPU takes the Mac with it): backlog.
