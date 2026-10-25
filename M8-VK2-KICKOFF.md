**A draft, written 2026-10-25 at the user's request by the session that finished VK1. The content is the user's to
approve or change; until then nothing here binds.** Covers **VK2** of the Vulkan plan
([docs/plans/graphics.md](docs/plans/graphics.md) §6), M8's graphics track. VK3 and later get their own kickoffs.

Start **VK2: core translation, the direct set.** VK1 built what the guest sees (the device, the host-visible window
and its write-watch, Venus's capset) and a renderer that answers Venus and draws nothing: virglrenderer's `vkr` and a
null driver on Mesa's lite runtime, one wasm module on memory 0 (vk/README.md). Its gate found Venus's encoding cheaper
for the guest than virgl's (bench/vulkan/REPORT.md "VK1: the gate": 2–9× less where a frame has work, ~0.3 ms more
where it has almost none). VK2 makes the null driver draw: Vulkan's direct rows (plan §4) translated onto WebGPU in
the GPU worker, with shaders through `spirv_to_nir` and NIR (VK1 step 1) into WGSL, so the programs of the direct set
draw right.

Read docs/plans/graphics.md whole (§2 the decisions, §3 the shape, §4 the map and its direct rows, §6 VK2, §7 the
risks) and bench/vulkan/REPORT.md (C, D, E, F, "The route", "The bar", "VK1 step 1", "VK1: the gate"). Then
vk/README.md, docs/devices.md "Venus" and "The host-visible window", docs/graphics.md ("Decisions", "The GPU worker",
"Findings", "Tools"), docs/plans/video.md (mpv's bar and VA-API's surfaces), docs/testing.md "dEQP", docs/benchmarking.md
and THIRD_PARTY.md. `M8-VK2-HANDOVER.md` carries VK1's findings worth not re-discovering. CLAUDE.md's conventions and
working rules apply. Work as in the other tracks: short loops, one commit and a short report each, without check-ins,
except as below.

## Decisions (binding once approved)

- **Everything in plan §2 still binds**, and VK1's choices stand: Vulkan a per-machine choice, off by default (a
  machine without it sees exactly today's device; `tests/steps.txt` unmoved), the renderer on memory 0 in its arena,
  vkr on one thread (its waits polls that stall and resume, never block: vk/README.md).
- **The translator is route (b)'s:** Mesa's full Vulkan runtime (VK1 used the lite one) with `spirv_to_nir` and NIR's
  passes, and a NIR → WGSL backend of ours, modelled on KosmicKrisp's NIR → MSL as step 1's spike was (MIT; nothing
  copied that THIRD_PARTY.md doesn't allow, an attribution row for what is ported). Pipelines cached as WGSL by SPIR-V
  hash and specialization.
- **The WebGPU device lives in the GPU worker,** beside the renderer (a `GPUDevice` can't cross workers). The driver
  calls it through imports; WebGPU's asynchronous parts (pipeline creation, mapping, `onSubmittedWorkDone`) are
  awaited outside the module's calls, since vkr's calls must return.
- **What the device advertises follows the browser's adapter** (plan §2: the caps follow the adapter), computed at
  start from its limits, features and formats instead of VK1's compiled-in Mac profile; the direct rows only, plus
  what Venus's WSI shares through. Whether YCbCr and the dma-buf modifiers stay advertised (GTK4 then takes Vulkan and
  must meet its bar) or go until VK3 is VK2's choice, by measurement.
- **Memory:** the window's written pages (the write-watch's, counted in VK1) are uploaded at each submit; what the GPU
  writes that the guest reads (feedback slots, queries, host-visible memory written by copies or shaders) is copied
  back before the fence that covers it retires.
- **Presentation:** a Venus program's frames reach the page's screen. Today the guest's compositor (sway on GLES)
  imports Venus's WSI images as dma-bufs into virgl, and the host's virgl renderer can't see them (VK1's `blob-ctx` is
  ignored). Sharing a blob between a Venus and a virgl context (the same texture on the host, by the resource's UUID)
  is part of VK2; `SET_SCANOUT_BLOB` too if a guest scans a Venus image out directly.
- **Where VK2 runs:** the dev VM (headless Chromium with `--enable-unsafe-webgpu`: SwiftShader's WebGPU, for
  correctness and CI), and the Mac host for numbers on a real GPU, as in VK0 and VK1. Nothing is installed on the Mac:
  it runs from `~/webpc-gpu-bench` (keep it small: ~8 GiB free). The x86_64 desktop is never touched by an agent; if a
  number from the user's NVIDIA desktop would settle something, extend `bench/vulkan/nvidia.sh` and say so, without
  waiting for the user's run.
- **Check-ins:** none, except stop and report at once if a direct-row program can't reach its bar for a reason the
  plan didn't price (WebGPU's per-call cost, pipeline stalls or uploads well past REPORT.md's C to F), since that
  would reopen route (b) or the bar.

## What VK2 builds

- **The driver on WebGPU** (vk/driver/): memory, buffers, images and views, samplers, descriptor sets and pipeline
  layouts as WebGPU bind groups, render passes and dynamic rendering, graphics and compute pipelines, the draw, dispatch
  and transfer commands of the direct rows, queries and syncs; command buffers recorded through the runtime and
  replayed into WebGPU command encoders at submit.
- **The shader path:** SPIR-V → NIR → our lowering passes → WGSL, the pipeline cache, and the size and time of the
  module against step 1's bar (download within ~5 MiB compressed, fetched only by a machine with Vulkan on).
- **Uploads and readbacks** around each submit, timed against F's numbers.
- **Presentation** (above), and the page's per-machine Vulkan setting once a program draws (the Machines page, not
  only `?gpu=vulkan`), with the module in `npm run dist`'s copy and its licences beside it (THIRD_PARTY.md's row).

## The gate

Plan §6's: **mpv meets its bar on Vulkan** (the video track's: no frames dropped, the guest 19–27% busy), which needs
VA-API's surfaces imported as dma-bufs. Also **vkcube, vkmark and vkQuake draw right** (their frames compared with the
same frames on lavapipe or the Venus oracle, within a small difference) on SwiftShader and the Mac, and on NVIDIA by
the user's run; their frame times and the guest's CPU a frame against VK1's and against virgl where the program has a
GL path.

**Tests** at the cheapest layer that catches each thing: the translator's units in Node (NIR → WGSL over step 1's
108 stages, compiled by Chromium's WebGPU), dEQP-VK's groups for the direct rows as pass lists (every case expected
to pass; a CI script of their own, as `ci-deqp.sh` is for GLES), and `tests/page-venus.test.ts` checking vkcube's
pixels, skipping where the page has no WebGPU adapter.

## Deliverable

- REPORT.md's VK2 section with JSON: the gate's numbers, the module's size, a pipeline's and a submit's costs.
- The translator and the presentation path, with docs that state how they work now: vk/README.md, devices.md
  "Venus", graphics.md.
- THIRD_PARTY.md current (the full runtime, the backend's model, dEQP-VK).
- Plan §6 and §7 revised from what VK2 learned, with loose ends in docs/backlog.md.
- `scripts/ci.sh`, and the CI scripts the change touches, passing.

Notes between sessions go in `M8-VK2-HANDOVER.md`. I decide whether VK3 starts.
