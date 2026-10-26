# VK3 handover

The notes that carry VK3 ([VK3-KICKOFF.md](VK3-KICKOFF.md)) from one loop to the next. Newest state first. Each loop
adds a "State (<date>, after Ln)" section on top of the states, and marks its bullet in "The plan" done.

## What the next NVIDIA run must answer

Kept by the supervisor. Each loop that needs an NVIDIA number extends `bench/vulkan/nvidia.sh` (one command, one
results tarball) and adds its question here.

- (none yet: L1 adds the presentation check)

## The plan (loops; the supervisor may reorder)

The kickoff's eight steps, one loop each unless a loop says otherwise:

- [ ] L1: presentation on NVIDIA (why the bitmap way is black; a run-time check of the first copy and the readback
  fallback; nvidia.sh's presentation check).
- [ ] L2: the fence's round trip (instrumented on every host; the pollers' `setTimeout(0)` first; the bar: Venus at
  1 fish no slower than virgl on any host).
- [ ] L3: pipelines made asynchronously, WGSL cached by SPIR-V hash across runs.
- [ ] L4: libplacebo's advanced path (`float32-blendable`; the M4's green VA-API chroma; tier1's storage formats).
- [ ] L5: the translator's missing adapter features (`subgroups`, `shader-f16`, read-write storage with `tier2`).
- [ ] L6: the driver's gaps from dEQP-VK (per-face stencil, occlusion queries, texel buffers, depth/stencil copies,
  dEQP-VK on the Mac's GPU).
- [ ] L7: §4's emulated rows in order (Dawn's: indexed descriptor arrays, sample-rate shading; ANGLE's ES3: provoking
  vertex, >12 UBOs, transform feedback; vkd3d's draw parameters; GTK4's YCbCr with modifiers last). Likely several loops.
- [ ] L8: the track's end (REPORT.md's VK3 section, docs, plan §6/§7, the final NVIDIA run scripted).

## State (2026-10-26, before L1)

VK2 ended at cd03da82/465132b6: Venus draws through WebGPU, frames reach virgl's screen by bitmap (L4), mpv on Vulkan
meets its timing bar, 1,463 dEQP-VK cases in CI. The user's NVIDIA run (bench/vulkan/REPORT.md "VK2: the NVIDIA run")
found Venus's presented frames black there (offscreen frames right) and a ~4.5 ms fence floor a frame (the M4's ~0.9).

## Things worth not re-discovering

VK2's list still holds: `git show cd03da82:VK2-HANDOVER.md`, its "Things worth not re-discovering" and each state's
findings. Add VK3's here.
