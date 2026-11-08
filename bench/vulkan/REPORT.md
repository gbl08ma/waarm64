# bench/vulkan: VK0, is Vulkan on WebGPU worth building?

**2026-10-25.** VK0 of the Vulkan plan ([docs/plans/graphics.md](../../docs/plans/graphics.md) §5; the brief was
`M8-VK0-KICKOFF.md`): measure, before anything is built for the guest, whether Vulkan through Mesa's Venus driver
translated onto WebGPU can be fast enough, and what the translator must do. The JSON behind every number is under
`results/`; `node bench/vulkan/summary.ts` prints S's tables from it.

## The answer

**Continue.** The stop line (the kickoff's: the translated scene several times faster than the guest's lavapipe at
the light settings; a hard stop only past ~20× native) is nowhere near. On the Mac's M4, a whole Vulkan frame
translated at run time onto WebGPU in Chromium costs **1.0–1.8× native Vulkan** (MoltenVK, the faster native driver
there; it beats KosmicKrisp's), and is **200–950× faster than the guest's lavapipe** and **3–19× faster than virgl's
GLES** for the same frame. On the user's NVIDIA desktop (an RTX 3070, the page in their Chromium 153) it costs
**1.9–3.6× native Vulkan**, a fixed ~0.25 ms a frame that WebGPU written by hand pays too:

| ms a frame, 1080p, the M4 | 1 fish | 1,000 fish | 10,000 fish | toolkit, 2,000 quads |
|---|---|---|---|---|
| native Vulkan, MoltenVK | 0.36 | 0.50 | 1.85 | 0.23 |
| **translated onto WebGPU (arm 3)** | **0.36** | **0.73** | **3.04** | **0.35** |
| the guest's GLES on virgl, today's GL path | 1.45 | 4.78 | 41.2 | 3.62 |
| the guest's lavapipe, today's Vulkan path | 345 | 511 | 1,167 | 78.9 |

The programs that switch can be held to the bar (§ "The bar"): GTK4, the one that matters most, doesn't take the
direct set at all (it wants YCbCr and dma-buf modifiers), so what the device advertises keeps it on virgl until it
meets G's numbers. What the numbers don't settle is the guest's side: Venus's encoding costs the guest about as much a light frame as
virgl does (B), and which programs switch to Vulkan depends on what the device advertises (A). Both are VK1's to
build and measure; neither threatens the bar on its own terms. **The route: (b)**, upstream pieces in wasm (Mesa's
runtime, `spirv_to_nir` and NIR's passes under virglrenderer's Venus decoder), chosen by D's shader coverage
(§ "The route"); the advertised set and its order (A), the render-pass rule (C) and the plan's changes follow.

## Setup

| | dev VM | Mac host (real GPU) |
|---|---|---|
| Machine | Lima `dev`, 8 vCPUs on the M4 mini | the same M4 mini (10 cores), macOS 26.6.2 |
| Chromium | 153.0.8010.52 (zypper), SwiftShader WebGPU | 153.0.8010.12 (Playwright's Chrome for Testing, headless), Metal |
| Native Vulkan | lavapipe (Mesa 26.2.3) | KosmicKrisp and MoltenVK 1.4.2 from LunarG's SDK 1.4.363.0, unpacked into `~/webpc-gpu-bench` (nothing installed) |
| Guest (arm 4) | — | Arch Linux aarch64 (Mesa 26.2.5, lavapipe), 4 vCPUs, 4 GiB, on the page's 3D machine |

Frames are drawn offscreen at 1920×1080 (no swapchain, no present) with two in flight, so every arm measures the same
thing; a frame's time is the wall time between frames in steady state, medians of 10 samples of 60 frames (fewer
where frames take seconds). Real-GPU numbers are the Mac's; SwiftShader's are for correctness only.

## The scene

The WebGL Aquarium (WebGLSamples, BSD-3-Clause: its models, textures, fish table, camera, shaders; THIRD_PARTY.json),
ported once and drawn by every arm from the same simulation (`scene/sim.c`: our own sin, cos and random numbers, a
fixed 1/60 s step, no libc, built natively and to wasm) and the same draw order (`scene/scene.h`, a command list each
arm replays as its own API's calls). Fish with per-fish data, the placed props (91 objects), seaweed, bubbles,
light rays, the globe with its environment map, fog, alpha blending, optional 4× MSAA; the fish-count knob (the
Aquarium's split into five species) from 1 to 30,000: 120 draws at 1 fish, 1,119 at 1,000, 30,119 at 30,000. A
toolkit-shaped setting (`scene/toolkit.h`, GTK4's frame): widgets of a rounded background, an icon, a label's
glyphs and separators, instanced quads rebuilt every frame, 400 draws for 2,000 quads, 1,600 for 8,000.

- **Native Vulkan** (`scene/vk.c`), written as Vulkan programs are: command buffers re-recorded every frame, the
  frame's uniforms in host-visible memory with their descriptor set updated every frame, the props' uniforms at
  dynamic offsets, each fish's 44 bytes in push constants, fog a specialization constant, 3 descriptor sets (a
  material's three combined image-samplers), one render pass a frame, a flipped viewport (GL's convention).
- **WebGPU by hand** (`webgpu/`, arm 2): the same frames as a WebGPU author would draw them, in a worker; the fish's
  data three ways: a storage buffer written once a frame and picked by `firstInstance`, a dynamic uniform offset per
  fish, or immediates.
- **GLES 3.0** (`scene/gles.c`, arm 4's virgl side), written as GL programs are: uniform blocks bound by range, a
  fish in one `glUniform4fv`, a sync object a frame.

Every arm draws the same frames: against lavapipe's, KosmicKrisp and MoltenVK differ in 0.14% of the pixels by more
than 8 levels, WebGPU by hand 0.24–0.30%, the translated replay 0.06–0.66%, the GLES port 0.00%; in the guest
(32×18 block thumbnails read back over the serial console) lavapipe and virgl are within one level.

## S: the whole scene

`node bench/vulkan/summary.ts`, ms a frame, 1080p, MSAA 1 (the M4 unless noted; JSON in `results/loop1`, `loop3`,
`loop5`):

| | fish 1 | 100 | 1,000 | 10,000 | 30,000 | toolkit 2,000 | 8,000 |
|---|---|---|---|---|---|---|---|
| native MoltenVK (arm 1) | 0.36 | 0.42 | 0.50 | 1.85 | 5.07 | 0.23 | 0.40 |
| native KosmicKrisp (arm 1) | 0.51 | 0.57 | 0.80 | 4.62 | 15.3 | 0.34 | 0.53 |
| WebGPU by hand, storage (arm 2) | 0.35 | 0.38 | 0.51 | 1.86 | 4.81 | 0.29 | 0.64 |
| WebGPU by hand, dynamic offsets | 0.35 | 0.38 | 0.62 | 3.74 | 9.70 | | |
| WebGPU by hand, immediates | 0.36 | 0.40 | 0.61 | 2.84 | 8.19 | | |
| **translated (arm 3)** | **0.36** | **0.40** | **0.73** | **3.04** | **8.44** | **0.35** | **0.71** |
| the guest's GLES on virgl (arm 4) | 1.45 | 1.24 | 4.78 | 41.2 | 122 | 3.62 | 13.4 |
| the guest's lavapipe (arm 4) | 345 | 382 | 511 | 1,167 | | 78.9 | 110 |
| lavapipe natively, the dev VM (arm 5) | 23.1 | 26.5 | 35.8 | 85.0 | 201 | 4.23 | 6.13 |

With 4× MSAA: MoltenVK 0.36 / 0.55 / 2.06 ms (1 / 1,000 / 10,000 fish), WebGPU by hand 0.35 / 0.57 / 1.98, the
translated replay 0.83 at 1,000 fish and 0.33 for the toolkit (2,000 quads; MoltenVK 0.25), virgl 1.77 / 4.81 / 39.8.
KosmicKrisp pays 0.9–1.4 ms for MSAA at light settings, the others nothing measurable (lazily allocated attachments
changed nothing for it).

**Below 60 frames a second** (16.7 ms): arm 3 never, up to 30,000 fish (8.44 ms); natively neither; virgl between
1,000 and 10,000 fish (4.78 and 41.2 ms); the guest's lavapipe at every setting (345 ms at 1 fish; its toolkit 79).

**The ratios.** Arm 3 against native MoltenVK: 1.00× (1 fish), 0.94×, 1.45× (1,000), 1.64× (10,000), 1.67×
(30,000); the toolkit 1.53× and 1.79×. Against KosmicKrisp, 0.55–0.92× (faster) on the Aquarium. The guest's
lavapipe takes 956× (1 fish), 701× (1,000), 384× (10,000), 223× (toolkit) arm 3's time, virgl 4.0×, 6.6×, 14× and
10×. The stop line asked for "several times" against lavapipe and at most ~20× native: arm 3 is at 1–1.8× native.

**Where arm 3's time goes.** At light settings nowhere: 0.36 ms is the GPU's frame (arm 2's timestamps put its
render pass at 0.23 ms). At 1,000 fish and up it is the CPU: the worker translating (0.22 ms a frame at 1,000 fish, 1.7 ms at
10,000), the renderer's and GPU process's own (0.34 and 0.26 ms of CPU a frame at 1,000 fish). Against WebGPU by
hand it costs what immediates cost against a storage buffer (1.0–1.2× arm 2's immediates mode): the translator's
own run-time work (bind groups looked up by content, push constants, the stream walked in TypeScript) adds little;
WebGPU's per-call cost is the price. A translator could do better than a push-constant-per-draw mapping where the
pattern allows (the storage-and-firstInstance form is 1.6× faster at 10,000 draws), but needn't to meet the bar.

**The host's CPU** (CDP's process times over the timed frames, ms a frame, arm 3 on the M4): 1 fish renderer 0.17 +
GPU process 0.12; 1,000 fish 0.34 + 0.26; 10,000 fish 2.07 + 1.46. Native MoltenVK's process CPU: 0.17, 0.25, 1.60.

**The guest's cost of encoding Venus** (not measured here: no device yet; B's estimate): 0.6–1.2 ms a frame at 1
fish, 1.9–2.5 ms at 1,000, ~14–15 ms at 10,000 on one vCPU. At the light settings about what virgl costs the guest
today, not less; at draw-heavy settings the encoding (≈280 guest instructions a command, 85% of it Mesa's field-by-
field encoder writes) caps one vCPU at ~11–12k simple draws a frame at 60 frames a second. VK1's gate measures it.

## A: who takes which Vulkan

Khronos's Profiles layer (`profiles/`: `make.ts` writes the profiles from the committed WebGPU adapter lists,
`run.sh` runs a program through them; a patched layer, `build-layer.sh`, also reports a GPU's type and identity,
since lavapipe's CPU type alone turns GTK4, libplacebo, Dawn and wlroots away) restricts lavapipe in the dev VM to the
Vulkan 1.3 a WebGPU adapter backs directly (plan §4's direct and adapter rows; `VP_WEBPC_webgpu_mac`,
`_swiftshader`), plus a row a profile for each emulation.

| Program | on the direct profile (Mac and SwiftShader alike) | what decided it, and what brings it |
|---|---|---|
| vkcube 1.4.363, vkmark 2025.01 | Vulkan | — |
| mpv 0.41 / libplacebo 7.360 | Vulkan, plays | (it skips CPU devices: the device must say GPU) |
| vkQuake 1.37 | Vulkan; on SwiftShader's no FP16, no 10-bit colour buffer, no SSAO | optional features only |
| GTK 4.22.5 (4.18–4.22 alike) | crashes (asserts YCbCr when the dma-buf extensions are there) | with YCbCr: "no dmabuf support": GTK4 wants a dma-buf format with a non-LINEAR modifier. **What the device advertises decides whether GTK4 switches** |
| Chromium 153's ANGLE on Vulkan | ES2 only, then GL off | ES3 needs the provoking vertex, >12 uniform buffers and transform feedback or vertex-stage stores |
| Chromium's Dawn (the guest's WebGPU) | rejected | dynamically indexed descriptor arrays (compatibility mode), plus sample-rate shading (core) |
| vkd3d 2.1 (D3D12 demos) | fail | `VK_KHR_shader_draw_parameters`; feature level 11_0 wants much more (geometry, tessellation, stream output…) |
| Firefox 157's wgpu | no adapter with any profile loaded | not measurable here (wgpu-hal's source: sample-rate shading and a conformance version) |
| sway/wlroots on Vulkan | no DRM node in the VM | by source: `VK_EXT_physical_device_drm`, dma-buf modifiers, foreign queue family, timeline semaphores, sync2; opt-in anyway |

**Where WebGPU falls below Vulkan 1.3's required minimums** (to emulate or to violate knowingly):
`maxVertexInputBindings` 8 (16 required: vertex pulling), `maxPerStageResources` 86/50 (128), the per-set descriptor
counts (WebGPU counts per stage: up to 3× by stage visibility, else short), multiview (required since 1.1: replay the
pass per view), `bufferDeviceAddress` and `vulkanMemoryModel` (required by 1.3: not offered; so the device
advertises 1.2 plus the 1.3 features it can back, or 1.3 non-conformantly), push constants 128 bytes (immediates are
64: the rest in a uniform), `R32_UINT` storage-image atomics, and API with no WebGPU counterpart that shaders or copies
must absorb: `CLAMP_TO_BORDER`, `mipLodBias`, texel buffers, 256-byte buffer↔image row pitch, attachment-less render
passes, depth copies, primitive restart always on for strips, extended dynamic state as pipeline variants.

**The advertised set and its order** (from who each row brings): first the direct set with the device reporting
itself a GPU (vkcube, vkmark, mpv, vkQuake: no emulation at all); then the rows that carry whole stacks: dynamically
indexed arrays + sample-rate shading (Dawn: the guest's Chromium WebGPU), the provoking vertex + uniform-buffer count
+ transform feedback (ANGLE's ES3, should Chromium in the guest ever pick Vulkan), draw parameters (vkd3d); YCbCr
conversion only together with the decision about dma-buf modifiers (GTK4: see "The bar"); geometry, tessellation,
large points, multi-draw indirect and 3-component formats last: on their own they brought no program here.

**Zink or virgl for GL** when both capsets exist: not measurable in vtest (the guest's choice is Mesa's loader's, on
the DRM device). By the loader's source (Mesa 26.2): virtio-gpu's kernel driver name picks the `virtio_gpu` gallium
driver, which is virgl; Zink loads by default only for nouveau, otherwise only when asked
(`MESA_LOADER_DRIVER_OVERRIDE`). VK1 checks it on the real device.

## B: the Venus stream

The Venus oracle (`tools/venus-oracle/`: virglrenderer `e0a1caf` with Venus, Mesa 26.2.4's Venus driver over vtest,
on lavapipe) with a capture patch (commands by name, stream bytes by route, replies, the guest's submits, ring
wakeups, host-visible pages changed at each submit; `capture.patch`, `dump.ts`; JSON in `results/b/`). Per steady
frame:

| Workload | commands | stream bytes | replies | guest submits | host-visible mapped / changed |
|---|---|---|---|---|---|
| scene, 1 fish | 320 | 16.9 KiB | 0 | 3 | 46 KiB / 23.1 KiB |
| scene, 1,000 fish | 2,325 | 138 KiB | 0 | 3 | 46 KiB / 23.1 KiB |
| scene, 10,000 fish | 20,325 | 1.20 MiB | 0 | 3 | 46 KiB / 23.1 KiB |
| toolkit, 2,000 quads | 928 | 34.9 KiB | 0 | 3 | 234 KiB / 94 KiB |
| vkcube | 22 | 1.0 KiB | 0 | 7 | 2.4 KiB / 1.2 KiB (+ WSI images) |
| GTK4 fishbowl, GSK on Vulkan | 53 | 3.4 KiB | 0 | 11 | 1 MiB / 4 KiB (+ WSI) |
| vkmark | 8 (pre-recorded) | 0.35 KiB | 0 | 4 | ~0.4 MiB / ≤260 B (+ WSI) |
| vkQuake (2 in-game frames) | ~3,600 | ~190 KiB | 0 | 4 | ~51 MiB / ≤4 KiB |

- **No steady frame waits on the host**: replies come only from setup (memory requirements, device queries,
  vkQuake's 389 synchronous descriptor-set allocations). Fences, queries and events go through renderer syncs and
  feedback slots the GPU writes in host-visible memory, which the host must copy back into the window soon after each
  submit that carries one.
- **Venus does not take the guest's submits off the kernel path**: each vkQueueSubmit is still ~3 small execbuffers
  (a ring-sequence wait carrying the fence, a virtqueue ordering round trip, the ring's wake-up when the host thread
  idled) plus a syncobj wait and reset. Only the command bytes move to the ring (large command buffers go by indirect
  submission from 8 MiB shm pools). Keeping the host's ring poller awake across frames saves the wake-up; the rest is
  Mesa's driver's choice.
- **The write-watch earns its place**: vkQuake maps 51 MiB of host-visible memory and writes ≤4 KiB a frame;
  uploading every mapped range at each submit would move 51 MiB a frame (F: ~5 ms), the written pages a few µs.
- **Beyond the spec** (plan §7's first risk, found in `vkr`): host-visible memory forced exportable as a mappable
  dma-buf or shm and bound to resources created without external-memory info; the mapping assumed coherent with no
  flushes reaching the host (so the host never learns what was written: the write-watch); GPU writes to feedback
  slots visible to the guest without a guest wait; `vkQueueWaitIdle` refused; the ring and the virtqueue wait on each
  other (our worker must service both independently). For us the first three are the shared window: free.

## C: render passes and compute, in Chromium

`micro/suite.ts` on the M4 (`results/loop5/mac-micro-*.json`), ms a frame:

| one render pass split into N (store and load), 200 draws | 1 | 2 | 4 | 8 | 16 | 32 |
|---|---|---|---|---|---|---|
| 1080p | 0.25 | 0.26 | 0.33 | 0.53 | 0.78 | 1.51 |
| 1440p | 0.28 | 0.33 | 0.46 | 0.69 | 1.01 | 1.58 |
| 1080p, 4× MSAA (its colour stored and reloaded) | 0.26 | 0.40 | 0.94 | 1.62 | 2.24 | 2.69 |
| 1440p, 4× MSAA | 0.32 | 0.71 | 1.73 | 2.98 | 4.11 | 4.87 |

| 50 objects, each a compute dispatch writing its vertices, then its draw | 4× MSAA off | on |
|---|---|---|
| no pre-pass (the draws alone) | 0.23 | 0.24 |
| pre-passes hoisted before one render pass | 0.32 | 0.35 |
| interleaved, 5 render passes | 0.54 | 0.74 |
| interleaved, 10 | 0.72 | 1.09 |
| interleaved, 50 (a break per object) | 3.18 | 3.20 |

- A break costs ~40 µs at 1080p without MSAA and 70–160 µs with it (the multisampled attachments go to memory and
  back). **Hoisting is required, not just better**: a break per object makes the frame 10× the hoisted one.
- Geometry and tessellation in compute (libpoly's way) cost little over drawing the same primitives from static
  buffers: 100,000 points to quads 0.65 against 0.54 ms, 1,000 patches tessellated 16×16 0.41 against 0.35 ms.
- Transient attachments exist in Chromium 153 (`GPUTextureUsage.TRANSIENT_ATTACHMENT`, the Mac): a one-pass MSAA
  frame with them 0.28 against 0.26 ms, no difference to see where nothing is stored anyway.

**The render-pass rule:** translate at submit; run every compute pre-pass a render pass needs before it begins (the
hoist, legal for nearly every Vulkan pass); split a pass only where a draw reads storage an earlier draw in the same
pass wrote behind a self-dependency barrier; never break for transfers or clears (do them before, as the pass's load
operations, or as draws); with MSAA, a split costs a store and reload of every sample, so count breaks per frame as a
budget (a handful at 1080p).

## D: shaders

The scene's SPIR-V (glslc) through the chain arm 3 uses (`translate/shaders.ts`), per pipeline stage:
1. spirv-opt freezes the specialization constants to the pipeline's values (naga 30 has no `OpSpecConstantOp`) and
   splits combined image-samplers (WebGPU has none; naga failed 11 of 19 modules without these two);
2. our pass renumbers the bindings (Vulkan's b to 2b, a split sampler to 2b+1: they would otherwise clash);
3. naga 30 to WGSL, twice: clip space kept (a flipped viewport, GL's convention, is WebGPU's) and adjusted (y negated
   for a positive-height viewport);
4. spirv-cross's reflection: the bindings' kinds, texture dimensions, the push-constant bytes read.

All 20 of the scene's stages translate and draw the native frames. Natively the whole chain takes ~4 ms a stage, most
of it starting processes; **naga in wasm** (its CLI built for wasm32-wasip1, under Node's WASI) 1.1 ms a stage (17 ms
for 16 stages) against 0.4 natively, with the same output (`results/loop4/`). Chromium's own part (createShaderModule
and createRenderPipelineAsync, Tint then Metal's compiler) for the scene's 11 pipelines: 98 ms on the M4 (~9 ms a
pipeline; the toolkit's 3 in 19 ms), 45 ms on SwiftShader. So a pipeline costs ~10 ms end to end: a program creating hundreds at load is a
second's stall, so a pipeline cache of WGSL by SPIR-V hash and specialization (as `scene-shaders.json` is) earns its
place, and Chromium caches the compiled pipelines itself.

**A's programs** (`translate/programs.sh`: each program on the dev VM's lavapipe through A's Mac profile, Mesa's
`MESA_SPIRV_DUMP_PATH` saving every stage it compiles, then `translate/coverage.ts`: naga alone, and arm 3's chain;
JSON in `results/d/`):

| Program | stages | naga alone | arm 3's chain | what stops the rest |
|---|---|---|---|---|
| vkcube | 2 | 1 | 2 | |
| vkmark | 16 | 12 | 16 | |
| mpv / libplacebo | 10 | 2 | 10 | |
| the scene (1,000 fish) | 15 | 5 | 15 | |
| vkQuake 1.37 | 51 | 17 | 33 | input attachments (10: naga reads no `SubpassData`); specialization constants spirv-opt can't fold (5: a `Select` on one); one each an initializer of another type, an `Rgb10A2` storage image, a storage class naga lacks |
| GTK 4.22.5, GSK on Vulkan (fishbowl; on plain lavapipe, since it aborts on the profile) | 16 | 0 | 0 | every stage: matrix and array varyings (GSK passes a widget's `mat3x4` and colour arrays flat between stages); naga takes only scalars and vectors, and spirv-opt's command line has no pass that splits them |

`spirv_to_nir` (route (b)'s frontend) took all 110: lavapipe compiled every stage while the programs ran. So naga
with spirv-opt translates what plainly written programs emit (43 of 43 stages), not what a toolkit and a game emit
(33 of 67): each of those failures is a lowering route (a) would write as a SPIR-V pass of its own (varyings split
into vectors, input attachments read as textures, specialization constants evaluated), and each is something NIR
already does (I/O lowered to vector slots, `nir_lower_input_attachments`, constants evaluated by `spirv_to_nir`).
Tint's SPIR-V reader wasn't tried (it builds only from Dawn's tree).

## E: per-draw overhead

10,000 draws a frame on the M4 (`results/loop5/mac-micro-e_draws.json`), µs a draw, the frame's (GPU and all) and the
worker's encoding:

| what feeds each draw | frame | encode |
|---|---|---|
| one bind group, set once | 0.078 | 0.008 |
| a cached group switched per draw | 0.150 | 0.024 |
| a dynamic offset per draw | 0.179 | 0.065 |
| immediates per draw | 0.150 | 0.073 |
| a group created per draw | 0.566 | 0.448 |
| a render bundle of the 10,000 | 0.087 | 0.000 |
| the dynamic-offset loop driven from wasm through imports | 0.179 | 0.069 |

- **Bind groups must be cached, never made per draw** (4× the cost): the translator keys them by the descriptor
  set's content, as arm 3 does (its timed frames create none).
- Push constants as immediates cost what a cached group switch does; a dynamic offset a little more.
- **Calls from wasm cost what calls from JS do**: a translator in wasm loses nothing at the WebGPU boundary.
- Render bundles replay at near a single group's cost: secondary command buffers recorded once and executed many
  times should become bundles; the guest's re-recorded command buffers can't use them.
- So a frame carries ~5,000 Vulkan-style draws (a group switch and a push each) in 1 ms of the frame's budget on the
  M4: the scene's 10,000-fish setting is 3 ms. Games at 3,000–5,000 draws fit; 30,000 doesn't at 60 frames a second.

## F: uploads

`queue.writeBuffer` on the M4 (`results/loop5/mac-micro-f_upload.json`), ms a frame including the submit: 256 B to
64 KiB ~0.11–0.12 ms (the submit's own cost), 1 MiB 0.29, 8 MiB 0.87; from a SharedArrayBuffer at a plain buffer's
cost. A 1 MiB range written as 256 page-sized writes 0.36 ms, as 1,000 KiB-sized ones 0.49: uploading only the pages
the guest wrote costs ~0.3 µs a page more than one range. With B's numbers: the scene uploads 23 KiB a frame, GTK4's
fishbowl 4 KiB, vkQuake ≤4 KiB of its 51 MiB, so **the window's design holds: a write-watch on the window's pages and
an upload of the dirty ones at each submit** (uploading every mapped range would be ~5 ms a frame for vkQuake).

The guest's side of the write-watch (a write-protect bit in the TLB, a dirty mark on the first write to a page after
each submit) was not prototyped in VK0: its cost is one slow-path TLB fill per written page per frame (a few pages in
every workload B captured), far below a millisecond. VK1 builds it.

## G: the bar's baseline

What a program that switches must meet, on virgl today: the Mac (Chrome for Testing 153, ANGLE on Metal), the desktop
guest (Arch Linux, GTK 4.24.1, Mesa 26.2.5, sway 1.12 on GLES 2), 4 vCPUs; `bench/gpu/gtk4-load.ts` through
`sway-mac.sh`, each demo left 30 s, then measured for 10 (`results/g/`):

| gtk4-demo, GSK's GL renderer | frames a second | gtk4-demo's CPU, ms a second | sway's | the guest busy (4 vCPUs) |
|---|---|---|---|---|
| fishbowl (106 icons when measured) | 58.3 | 465 | 137 | 17% |
| frames | 59.8 | 138 | 149 | 9% |
| iconscroll | 37.6 | 895 | 92 | 28% |

- fishbowl and frames hold the display's 60 at under half a vCPU, so their bar is the guest's CPU a frame (gtk4-demo
  8 ms a frame in fishbowl, 2.3 in frames); iconscroll is bound by its own thread in the guest (0.9 vCPU, ~15,800 GL
  draws a second through virgl), so Vulkan helps it only if Venus's encoding costs the guest less than virgl's
  (B's estimate: about the same at light settings). VK1's gate measures exactly this.
- themes redraws only when its toggle is pressed: measured idle, no number.
- **mpv** (from the video track, docs/plans/video.md §7: Sintel's H.264 trailer, `--hwdec=vaapi`, the host
  decoding): 0 of 527 frames dropped, the guest 19–27% busy. On Vulkan libplacebo would take VA-API's surfaces only
  by importing their dma-bufs (`VK_EXT_external_memory_dma_buf` with modifiers), which the direct set lacks: whether
  mpv then decodes on the guest's CPU instead (and so misses this bar) is VK2's to check.

## The route

**Route (b): upstream pieces composed in wasm** (plan §3): virglrenderer's Venus decoder (`vkr`) calling a Mesa
Vulkan driver whose hardware is WebGPU, on Mesa's common runtime, `spirv_to_nir` and NIR's passes, with a NIR → WGSL
backend of ours. Why:

- **D:** naga's chain fails 0 of the plainly written programs' stages and 34 of the toolkit's and the game's 67;
  `spirv_to_nir` takes all 110. Each failure is a lowering NIR has and route (a) would write: GTK4 (the program
  that most decides the bar) fails at its very first, its varyings.
- **A and C:** what brings programs past the direct set (the provoking vertex, transform feedback, sample-rate
  shading, dynamically indexed arrays; then geometry and tessellation in compute, libpoly's way) is NIR passes in
  route (b), our own in route (a).
- **E and D say the cost of C in wasm is small where it runs:** WebGPU calls from wasm cost what calls from JS do,
  and Chromium's own part of a pipeline (~9 ms on the M4) dwarfs a frontend's (naga 1.1 ms a stage in wasm).
- **What it costs:** the project's first C toolchain for wasm (allowed, §2), Mesa's runtime and NIR built for wasm
  (their size and time a stage not measured), a NIR → WGSL backend (KosmicKrisp's NIR → MSL is the model) and
  `vkr`'s beyond-spec behaviors (B) answered by our driver.
- **Not settled here, so VK1 measures it first:** `spirv_to_nir` and NIR's passes built to wasm, their download size
  and ms a stage against naga's 1.1. If they come out too large or slow, route (a) with our own SPIR-V passes for
  D's three lowerings is the fallback.

## The bar

Who switches when the device offers the direct set (A), and what each must meet:

- **GTK4 does not switch** (it needs YCbCr conversion and a dma-buf format with a non-LINEAR modifier): advertising
  neither keeps it on virgl, so the lever of plan §1 works and costs nothing. Advertising them is the decision that
  moves GTK4, taken once Venus meets G's numbers for the guest's CPU a frame.
- **mpv switches**: its bar is the video track's (no drops, 19–27% busy), which depends on importing VA-API's
  surfaces (G).
- **vkcube, vkmark, vkQuake and other Vulkan-only programs** have no GL path: they leave lavapipe for a GPU, 200–950×
  faster for S's scene.
- **Firefox, Chromium, sway, KWin** composite on GL whatever Vulkan offers; Dawn and wgpu (the guests' WebGPU) are new
  capabilities, not switches.

So the bar looks reachable: the one program that switches with a GL baseline is mpv, and the one that would move a
desktop's frames (GTK4) moves only when the device is told to bring it.

## The NVIDIA desktop

`bench/vulkan/nvidia.sh`, run by the user on their desktop on 2026-10-25 (`results/nvidia/`): an RTX 3070 with
NVIDIA's 615.71.09 (Vulkan 1.4.351), CachyOS. Headless Chrome for Testing didn't get the NVIDIA adapter, so the
browser arms ran in the user's own Chromium 153 (the page downloading its results), which shares the desktop with
their other work: these numbers are one session's, not alternated runs.

| ms a frame, 1080p, MSAA 1 | 1 fish | 100 | 1,000 | 10,000 | 30,000 | toolkit 2,000 | 8,000 |
|---|---|---|---|---|---|---|---|
| native Vulkan (frame) | 0.098 | 0.109 | 0.154 | 1.29 | 3.87 | 0.077 | 0.323 |
| native, the GPU's time | 0.087 | 0.097 | 0.121 | 0.324 | 0.764 | 0.057 | 0.217 |
| WebGPU by hand, storage (arm 2) | 0.248 | 0.250 | 0.338 | 1.53 | 4.15 | (1.37) | 0.854 |
| WebGPU by hand, immediates | 0.259 | 0.286 | 0.454 | 2.58 | 7.20 | | |
| **translated (arm 3)** | **0.252** | **0.263** | **0.504** | **2.61** | **7.16** | **0.275** | **0.913** |
| arm 3 / native | 2.6× | 2.4× | 3.3× | 2.0× | 1.9× | 3.6× | 2.8× |

- **The floor is Chromium's, not the translator's**: WebGPU by hand pays the same ~0.25 ms at 1 fish, where the GPU
  works 0.07 ms; on the M4 the same floor hides under the GPU's own 0.3 ms. From 1,000 fish up, arm 3's time is the
  worker's (0.39 ms at 1,000, 2.5 at 10,000), as on the M4. Native NVIDIA is itself CPU-bound past 1,000 fish (the
  driver records 10,000 draws in 1.28 ms).
- **Light GPU loads are bimodal there**: some settings measure ~1.1–1.4 ms a frame where neighbours measure 0.2–0.3
  (the toolkit's 2,000 quads by hand, MSAA 4 at light settings, C's few-pass splits at 1440p, where 1 pass takes 1.15
  ms and 4 take 0.29): the GPU's clocks dropping at light load in a headed browser. Those rows aren't read.
- **E** (µs a draw, frame): one group 0.092, a cached group switched 0.180, a dynamic offset 0.214, immediates 0.182,
  a group made per draw 1.06, a bundle 0.116, from wasm 0.220: the M4's order, ~1.2× its costs.
- **F**: a discrete GPU pays for bytes: 8 MiB a frame 4.9 ms (the M4 0.87), 1 MiB 0.42; the write-watch matters more
  here than on the Mac.
- **C** (no MSAA, 1080p): 32 passes 0.45 against 1 pass 0.20 ms, ~8 µs a break (the M4 ~40): an immediate-mode GPU
  stores little. The interleaved pre-passes still cost 2.6× the hoisted ones (0.78 against 0.30 ms at 50 objects).

The script: everything it fetches or builds it fetches or builds in one deletable
directory (LunarG's Linux SDK, a portable Node, Playwright's Chrome for Testing, the sources, the assets, the
captures, caches, the results); the native sweep on the system's driver; arm 3's captures with the SDK's
GFXReconstruct (the shaders come translated from `translate/scene-shaders.json`); the browser arms headless when
Chrome for Testing gets the NVIDIA adapter, else the pages served for the user's own Chromium, each downloading its
results; at the end `vk0-nvidia-results.tar.gz`. Test hooks (`VK0_SDK`, `VK0_NODE`, `VK0_ANY_ARCH`,
`VK0_ADAPTER_MATCH`) let the dev VM run it whole.

## Not done in VK0, ranked

1. **`spirv_to_nir` and NIR built to wasm** (route (b)'s premise): download size, ms a stage. VK1's first step:
   done, "VK1 step 1" below.
2. **Tint's SPIR-V reader** on D's 110 stages (needs Dawn's tree): route (a)'s other frontend; it matters only if
   route (b) fails its first step.
3. **C (5): the scene's fish through a geometry-shader pre-pass**, the cost in a whole frame (C's isolated geometry
   case cost 1.2× drawing static buffers).
4. **The WebGL Aquarium in the guest's Firefox and the host's Chromium**, arm 4's cross-check: the GLES port matched
   the native frames, so it wasn't needed for correctness.
5. **The NVIDIA desktop again, headless or alternated**: one session in a headed browser, with light-load clocks
   bimodal; a second run would settle the 0.25 ms floor's spread.
6. **mpv on the direct profile with VA-API**: whether libplacebo imports the decoded surfaces or falls back (G).

## VK1 step 1: route (b)'s premise in wasm

**2026-10-25. Passed, far inside the bar** (the kickoff's: within ~5 MiB compressed, ~5 ms a stage at the median).
Mesa's `spirv_to_nir`, NIR and the passes a translator runs, with KosmicKrisp's NIR → MSL backend standing in for our
NIR → WGSL one, built for wasm: **0.42 MiB with brotli (0.64 MiB gzip -9), 0.27 ms a stage at the median in Chromium
on the M4 (p90 3.5 ms), and every one of the 108 stages reaches NIR and MSL**, with the same NIR as the native build.
JSON in `results/vk1/step1/`; `bench/vulkan/nir/` builds and runs it (`build.sh`, `run.ts`, `mac.sh nir`).

**What runs** (`nir/spike.c`, over Mesa 26.2.4, the Venus oracle's tree): `spirv_to_nir` with Vulkan's options;
KosmicKrisp's preprocessing (`msl_preprocess_nir`: inlining, variable splitting, `vars_to_ssa`, sinking), the I/O and
explicit-memory lowering and `msl_optimize_nir`'s loop (copy propagation, CSE, DCE, algebraic, `opt_if`, `opt_loop`,
scalarizing), as its `kosmicomp` tool and `kk_shader.c` run them; the lowerings VK0's D found naga's chain lacking
(input attachments as textures, `vars_to_scratch` for indexed temporaries; varyings are I/O-lowered to vector slots
anyway); a descriptor lowering of ours in place of the driver's, which needs its set layouts (each set and binding a
slot in a table: the shape of a WebGPU binding map); then `nir_to_msl`. The stages are D's programs' again
(`translate/programs.sh` with `SPIRV_DIR`): 108, not D's 110, since GTK4's demo compiled 14 stages in each of two runs
here, not 16.

| a stage, ms (warm: a stage's median of 5 rounds) | median | p90 | max | the phases at the median: to NIR / passes / to MSL | 108 stages cold, once each |
|---|---|---|---|---|---|
| natively, the dev VM (gcc -O2) | 0.17 | 2.6 | 16 | 0.02 / 0.11 / 0.03 | 110 ms |
| wasm in Node 26, the dev VM | 0.29 | 4.0 | 22.5 | 0.03 / 0.17 / 0.07 | 203 ms |
| **wasm in Chromium 153, the dev VM** | **0.28** | **3.7** | 22 | 0.03 / 0.17 / 0.07 | 211 ms |
| **wasm in Chrome for Testing 153, the Mac's M4** | **0.27** | **3.5** | 21 | 0.03 / 0.16 / 0.07 | 181 ms |

- **wasm costs 1.6× native**; the module compiles in 2–3 ms (V8's lazy tiers) and instantiates in 1–2; its memory is
  32 MiB.
- **The tail is GTK4's**: its two uber-shaders take ~20 ms each, nearly all in the optimization loop (~15 ms natively
  too), and its 14 stages 2.8 ms at the median; every other program's stages take 0.2–0.35 ms. Chromium's own part of
  a pipeline is ~9 ms (D), so GTK4's are the only stages where the translator's share is comparable, once each per
  program run before a WGSL cache keeps it.
- **The NIR is the native build's**: the NIR printed after the passes hashes the same for all 108 stages in Node and in
  Chromium. The MSL differs in 7 (mpv's and vkQuake's fragment stages), where a fragment input's type reaches the
  backend's `UNREACHABLE` because the harness lacks a pipeline's linked-stage state; release builds make that undefined
  behaviour, which each build resolves its own way. It is the stand-in backend's gap, not wasm's.
- **The size**: 9.2 MB raw (1.3 MB of code, 7.9 MB of data, mostly zeros), **426 KiB brotli -11, 653 KiB gzip -9, 460
  KiB zstd -19**. Not counted yet: virglrenderer's Venus decoder (`vkr`, 1.4 MB of native text in the oracle's build,
  so ~1.4 MB more raw in wasm, an estimate) and Mesa's Vulkan runtime. Even at several times the estimate the whole
  stays well inside 5 MiB.

**The toolchain: wasi-sdk 34** (clang 23.1 and wasi-libc; the module a WASI reactor; `spirv_to_nir`'s setjmp/longjmp
as wasm exception handling). Emscripten 6.0.13 built the same sources with no shims (its libc has what wasi-libc
stubs), and was measured against it in three alternated rounds on each host (`results/vk1/step1/ab-*`):

| Chromium, a stage's median ms (rounds) / the 108 stages cold, ms | dev VM | the M4 |
|---|---|---|
| wasi-sdk | 0.282, 0.287, 0.280 / 210, 213, 211 | 0.267, 0.275, 0.273 / 180, 181, 182 |
| Emscripten (binaryen's `wasm-opt` at -O2 in its link) | 0.282, 0.275, 0.275 / 246, 244, 250 | 0.265, 0.267, 0.267 / 202, 199, 203 |
| wasi-sdk through `wasm-opt -O2` | 0.275, 0.272, 0.283 / 246, 244, 253 | |

Warm, they are the same (the rounds overlap). Cold, the plain wasi-sdk build is 11–17% faster (the rounds don't
overlap): binaryen's inlining makes V8 compile more before the code runs, and a translator's shaders mostly run once.
Compressed sizes are within 3% either way. So wasi-sdk: one pinned tarball (Emscripten's SDK is 1.8 GB with its own
Python and Node), plain clang, a module whose imports are ours (the WebGPU calls will be imports too, E: from wasm they
cost what calls from JS do), at the price of ~60 lines of shims (`nir/wasi/`: uid calls, signal masks, syslog, a
platform-free `os_misc.c`). Emscripten's own advantages (its POSIX emulation, its WebGPU bindings) aren't needed.

**Licences**: the module compiles 334 of Mesa's files: MIT (88 with SPDX tags, 236 with the MIT text, 5 without a
header under Mesa's MIT), Berkeley SoftFloat 3e (`util/softfloat.c`, BSD-3-Clause), BLAKE3 1.8.2 (CC0-1.0 or
Apache-2.0), and `c11/impl/threads_posix.c` (BSL-1.0); THIRD_PARTY.json has the rows.

## VK1: the write-watch costs machines without a window nothing measurable

**2026-10-25.** The host-visible window's write-watch (docs/devices.md "The host-visible window") adds, on every
machine, a compare to each TLB fill and an `Option` test at each chunk boundary and run-loop exit. A/B of the core
before it (L3's commit) and with it, three rounds alternated in one session, headless Chromium 153 on the dev VM
(`results/vk1/l4-watch/`; `node bench/interp/ab-summary.ts` on each directory):

| | before (rounds' medians) | with the watch | |
|---|---|---|---|
| the block interpreter's yardstick: Alpine's boot, MIPS | 221.1, 219.0, 218.8 | 219.3, 219.3, 219.0 | +0.1% |
| Buildroot's boot, MIPS | 184.8, 180.8, 182.7 | 181.9, 182.6, 182.1 | −0.4% |
| the user-mode guest, the VM flat and with the MMU, MIPS | 466–474 | 467–473 | ±0.6% |
| Alpine's boot under the JIT, total ms | 5574, 5551, 5524 | 5485, 5520, 5523 | −0.6% |
| Alpine on 1 / 2 / 4 parallel vCPUs, total ms | 6860 / 6380 / 6392 (medians) | 6875 / 6405 / 6396 | +0.2 / +0.4 / +0.1% |

Every row's rounds overlap: below the noise floor (~1%). The guest's cost with a window (a TLB miss for a page's
first write after each look) is measured with the renderer, at VK1's gate.

## VK1: the gate — Venus costs the guest less than virgl, but for GTK4's frames

**2026-10-25.** What a frame costs the guest's CPU on Venus (the null renderer: VK1's renderer draws nothing, so the
host's side is absent and only the guest's counts) against virgl, as G2 measured virgl: the Mac host (Chrome for
Testing 153, ANGLE on Metal, macOS 26.6.2, M4), the desktop guest (images/arch/desktop.sh: Arch Linux, Mesa 26.2.5
with Venus's driver, GTK 4.24.1, sway 1.12 on GLES through virgl), 4 vCPUs, one machine with both (`?gpu=virgl,vulkan`)
for every program but the scene's GLES arm (`?gpu=virgl`). JSON in `results/vk1/gate/`.

| Workload | virgl | Venus | |
|---|---|---|---|
| VK0's scene, 1 fish: the process's CPU a frame (`bench/vulkan/guest.ts`) | 1.237 ms (GLES) | 0.442 ms (Vulkan) | 2.8× less |
| the scene, 1,000 fish | 3.357 ms | 1.549 ms | 2.2× less |
| the scene's toolkit, 2,000 quads | 3.576 ms | 0.412 ms | 8.7× less |
| GTK4's fishbowl (`bench/gpu/gtk4-load.ts`, GSK's GL renderer against its Vulkan one): gtk4-demo's CPU a frame | 7.8 ms (53 icons, 54.8 frames/s) | 5.24 ms (59.5 frames/s; icons unseen) | less |
| GTK4's frames, three alternated rounds | 2.72, 2.75, 2.35 ms | 3.35, 3.03, 2.97 ms | **+11% (+0.3 ms)** |
| vkcube against es2gears (`bench/vulkan/apps-load.ts`; different programs, both at the display's 60) | es2gears 1.16 ms | vkcube 1.82 ms | not a pair |

- **The scene and fishbowl pass by a wide margin.** Venus's encoding is cheaper than virgl's in the guest: from 1 to
  1,000 fish the scene adds 1.11 ms a frame on Venus for ~2,000 more commands (B: 320 → 2,325), **≤0.55 µs a command**
  with the program's own work per fish in it, against 2.12 ms on virgl. At the JIT's few hundred to a thousand MIPS
  B's estimate (≈280 guest instructions a command) is 0.3–0.6 µs: confirmed as an upper bound, not refined (the
  scene's instruction counts cover its whole run, loading included). fishbowl's icon count on Vulkan can't be read (the
  screen is black), but fishbowl adds icons while it holds the display's rate, which Vulkan did and GL didn't: it drew
  at least as many for a third less CPU.
- **GTK4's frames costs more on Venus**, in every round. gtk4-demo's user time halves (31 against 65 ms a second) but
  its kernel time grows (113, plus 38 in Venus's WSI thread, against 99 ms a second): 9 guest submits a frame against 4
  on GL, ~0.17 ms of kernel time for each extra one (52 ms a second for 300 more). It is B's finding: Venus doesn't
  take submits off the kernel path. A light
  program pays it; a heavy one (the scene, fishbowl) gains more on encoding than it loses there. The lever is the
  guest's submit path (fewer execbuffers a vkQueueSubmit, a cheaper virtqueue notify in the emulator; plan §7).
- **The write-watch costs nothing measurable a frame**: the scene at 1,000 fish (3 submits a frame, each taking the
  window's written pages), three rounds alternated with and without it (`?gpu=vulkan,nowatch`): 1.472, 1.428, 1.541 ms
  against 1.514, 1.462, 1.485 ms. The rounds overlap.
- vkcube on Venus costs 1.82 ms a frame (all of it kernel time: 7 submits a frame); no GL program draws the same.
- **Verdict:** Venus doesn't clearly cost the guest more than virgl: it costs 2–9× less where a frame has real work and
  ~0.3 ms more where it has almost none. VK2 can proceed; the submit path's cost goes to plan §7 and the backlog.

## VK2 L4: presentation — the bitmap way

**2026-10-26.** How a Vulkan program's WSI image (a WebGPU texture of Venus's renderer) reaches the virgl renderer's
WebGL2 texture that the guest's compositor samples (vk/README.md "Presentation"). Candidates at 1920×1080
(`share.ts`: an app's frame into the image, the copy, a compositor's draw sampling the copy; ms a frame from the
first frame to a `readPixels` after the 120th, five alternated rounds, medians, IQR ≤ 0.07 ms; JSON in
`results/vk2/l4/share-*`):

| | none (the frame alone) | bitmap | canvas | readback |
| --- | --- | --- | --- | --- |
| Apple M4, Metal, Chrome for Testing 153.0.8010.12, `bgra8unorm` | 0.05 | **0.80** (0.79–0.86) | 0.93 (0.89–1.01) | 1.89 |
| the same, `rgba16float` (vkcube's) | 0.05 | **0.96** (0.92–0.97) | 1.09 (1.04–1.15) | 3.57 |
| SwiftShader, dev VM, Chromium 153.0.8010.52, `bgra8unorm` / `rgba16float` | 2.1 / 2.4 | fails | fails | 6.97 / 10.47 |

bitmap: a draw into a WebGPU canvas's texture, `transferToImageBitmap`, `texSubImage2D` from the bitmap; canvas: the
same draw, `texSubImage2D` from the canvas; readback: `copyTextureToBuffer`, `mapAsync` awaited, `texSubImage2D` from
the bytes. The bitmap's and canvas's rounds don't overlap. On SwiftShader a WebGPU canvas can't be made at all (its
swap chain's shared image), and trying loses the page's GPU channel.

**In place** (`apps-load.ts`, the desktop guest at 1920×1080 on the M4: vkcube fills sway's output, 4 vCPUs; two
alternated rounds a way, `?gpu=vkreadback` forcing the readback; JSON and screenshots in `results/vk2/l4/insitu-*`):

| | frames/s | vkcube's CPU a frame (guest) | guest busy | the GPU worker: copies' ms a frame | longest hold of a submit |
| --- | --- | --- | --- | --- | --- |
| bitmap | 59.9, 59.8 | 2.05, 2.56 ms | 11, 12% | 0.07, 0.09 (inside the compositor's submit) | 0 |
| readback | 59.9, 59.9 | 3.17, 3.09 ms | 15, 15% | 0.71, 0.66 (the upload), plus the wait | 7.3, 8.2 ms |

- **The bitmap way is kept** where the page renders on a GPU: 0.8–1 ms a frame end to end at 1080p, ~0.1 ms of the
  worker's thread. The readback way holds the display's rate too on the M4 but costs the worker ~0.7 ms a frame and
  the guest more (its fences come later: vkcube's CPU a frame +0.5 to +1.1 ms, rounds not overlapping); it stays as
  the way of software rendering, where nothing else works.

## VK2 L5: vkmark and vkQuake right, dEQP-VK, frame times on the Mac

**2026-10-26.** JSON in `results/vk2/l5/`.

**Frames** (vk/README.md "Checking frames"): vkmark's 13 scenes and vkQuake (LibreQuake's `start`, frames 200 to 230)
captured on lavapipe through the Venus device's own profile, replayed in the tests' Debian on the page and compared
with lavapipe's: every vkmark scene within 0.1% of a frame's bytes off by more than 24 on SwiftShader (dev VM, Chromium
153.0.8010.52) and on the M4 (Metal, Chrome for Testing 153.0.8010.12, macOS 26.6.2); vkQuake 1.7% on both, the same
counts (systematic, not identified: backlog). vkQuake needed five things of the driver: a fifth descriptor set, push
constants of 128 bytes, a dynamically indexed array of textures, a compute shader whose barriers sit in loops (WGSL's
uniformity analysis), and depth views of a D32S8 image; before them its frames were black.

| The replay's frames a second (GFXReconstruct's, ~30 frames; offscreen) | SwiftShader | M4 |
| --- | --- | --- |
| vkcube | 59 | 69 |
| vkmark's scenes | 66–144 (desktop the least, clear the most) | 60–121 |
| vkQuake | 14 | 43 |

vkmark's rates are the same on both: the guest and Venus's round trips bound them, not the GPU; vkQuake's, three
times higher on the M4, are the GPU's.

**VK0's scene on the M4, VK2's renderer (it draws now) against virgl** (`guest.ts`, the desktop guest, 4 vCPUs, two
alternated rounds a way; ms a frame, medians of 5 samples, and the process's CPU a frame):

| | Venus, VK2 (rounds) | virgl (rounds) | Venus, VK1 (null renderer, 2026-10-25) |
| --- | --- | --- | --- |
| 1 fish: frame / CPU | 0.93, 1.06 / 0.50, 0.56 | 1.45, 1.43 / 1.40, 1.32 | 0.46 / 0.44 |
| 1,000 fish | 2.71, 2.53 / 1.70, 1.69 | 5.46, 4.83 / 3.42, 3.52 | 1.58 / 1.55 |
| the toolkit, 2,000 quads | 0.90, 0.86 / 0.49, 0.46 | 3.60, 3.40 / 3.54, 3.34 | 0.43 / 0.41 |

- **Venus with drawing stays ahead of virgl**: 1.4–1.9× less a frame and 2–7× less of the guest's CPU, the rounds
  apart. Against VK1's null renderer the frame costs ~0.5 ms (1 fish, the toolkit) to ~1 ms (1,000 fish) more, the
  host's work (WGSL pipelines made at the first draws, the submit's replay into WebGPU and its fence's way back); the
  guest's CPU a frame moves by ≤ 0.15 ms (+10%), its fences later. A cross-session comparison (VK1's rounds are a day
  older; the host moves runs by up to ~8%).

**dEQP-VK** (VK-GL-CTS vulkan-cts-1.4.7.0, deqp-vk in Arch Linux with Venus's guest driver, Mesa 26.2.5, on SwiftShader):
samples of the direct set's groups, ~20,000 cases: 4,278 pass, 665 fail, 5 crash, the rest are unsupported (the
features, formats and extensions the device doesn't offer). `tests/deqp/vk.txt` holds 1,471 of the passing ones (the
larger groups thinned evenly, the 20-second format-property queries dropped); all 2,468 of a first draft passed in one
run of 474 s. The failures by cause: docs/backlog.md "The Vulkan driver's gaps". Fixed on the way: a texture-sampler
pair's sample type for depth views (program variants), linear images in host-visible memory (dEQP reads every colour
result through one), triangle fans, depth clip off, 1D images, compressed sizes in whole blocks, 3D slices as
attachments, attributes past their stride, depth and stencil copies (realigned or skipped instead of invalidating the
submit), `indirect-first-instance`, NaN clear values, and bind groups cached by layout ids that WebGPU's ids reuse.

## VK2 L6: the gate — mpv on Vulkan

**2026-10-26.** mpv with `--vo=gpu-next --gpu-api=vulkan --hwdec=vaapi` on the desktop guest (Arch Linux, mpv with
libplacebo 7.360, Mesa 26.2.5, webpc-va 3; sway 1.12 on GLES), Sintel's H.264 trailer (854×480, 24 frames/s) from the
media disk, 4 vCPUs, the screen at 1376×762, the video fullscreen. VA-API's surfaces reach libplacebo as dma-bufs
imported into Venus (vk/README.md "Imports"). Against mpv on virgl's GL in the same boot (`--vo=gpu --gpu-api=opengl`:
gpu-next needs GL 3, and virgl's EGL gives mpv GLES 2 here; the video track's runs were `vo=gpu` too), alternated
(`bench/audio/avsync.ts` with `MPV_VARIANTS`, `ROUNDS`; `WARM_S=8`, `PHASE_S=20`; JSON in `results/vk2/l6/`):

| Apple M4, Chrome for Testing 153.0.8010.12, macOS 26.6.2 | frames shown, dropped | the guest busy | mpv's CPU (ms a second) | sway's | the GPU worker: imports, ms a second |
| --- | --- | --- | --- | --- | --- |
| Vulkan, H.264 decoded in hardware (3 rounds) | 527–528, **0** | **13, 13, 13%** | 336, 325, 325 | 79, 94, 89 | 5.4, 5.1, 5.1 (48 planes, 14 MB) |
| GL, the same | 524–526, 0 | 12, 12, 12% | 300, 300, 294 | 99, 101, 95 | — |
| Vulkan, decoded in software (`swvideo`, the bar's own conditions; 2 rounds) | 528–529, **0** | **13, 13%** | 343, 327 | 81, 91 | 5.2, 5.1 |
| GL, the same | 527–528, 0 | 12, 12% | 294, 290 | 99, 98 | — |
| SwiftShader, dev VM, Chromium 153.0.8010.52 (1 round): Vulkan / GL | 306 / 293, 0 / 0 | 18 / 14% | 447 / 307 | 96 / 93 | 5.9 |

- **The gate passes:** no frame dropped, the guest 13% busy, under the bar's 19–27% (the video track's, measured
  2026-10-14 on an older image; GL in the same boot today is 12%). Rounds don't overlap: Vulkan costs the guest +1
  point of busy and mpv +8–15% of its CPU (libplacebo makes two images on imported memory every frame, and Venus
  encodes them), sway 5–20% less (it composites the frame from a dma-buf instead of mpv's GL buffer). The host's side:
  ~0.2 ms of the GPU worker a frame for the planes' `writeTexture` (the bytes the host decoded anyway) and ~0.08 ms
  for the presentation's copy. Nothing the plan didn't price: no stall, no WebGPU call cost of note.
- **Frames right** (`mpv-frames.ts`: mpv paused at 20 s, its window's screenshot; H.264 decodes exactly, so a
  renderer's two ways must match): on the M4, Vulkan with VA-API's surfaces and Vulkan decoding in the guest are
  **byte-identical**; on SwiftShader 243 of 3.1 M bytes differ by more than 24 (max 82, mean 0.03). Vulkan and GL
  decoding in software differ by at most 4 (renderers' rounding). GL with VA-API pauses on another frame than the
  other three (13% of bytes off by more than 24, the same moment by eye a frame or two apart, on both hosts): virgl's
  GL path's, not Vulkan's (docs/backlog.md).
- On the way: libplacebo failed every pass on Venus (`vkGetPipelineCacheData` answered `VK_INCOMPLETE` to the size it
  had given: the runtime reserves room for objects it then can't serialize; the driver answers the header alone now),
  and with every pass it rendered without FBOs ("Failed creating FBO texture! Disabling advanced rendering": its
  1- and 2-component FBO formats must have every capability of its 4-component one, and `r16float`/`rg16float` aren't
  storage formats in WebGPU without `texture-formats-tier1`): mpv on Vulkan scales bilinearly, as mpv on virgl's GLES 2
  does (it disables its scalers: "GLSL version too old"). Backlog.

## VK2 L7: caps from the adapter, YCbCr dropped, the module's size, a pipeline's and a submit's costs

**2026-10-26.** JSON in `results/vk2/l7/`. Hosts as in L5 and L6: the dev VM's SwiftShader (Chromium 153.0.8010.52)
and the M4 (Metal, Chrome for Testing 153.0.8010.12, macOS 26.6.2).

**What the device advertises follows the browser's WebGPU device** (vk/README.md "The driver"; `tests/venus-renderer.test.ts`
checks the mapping against both adapters' recorded features and limits). The same module reports, for example:

| | SwiftShader | Apple M4 (Metal) |
| --- | --- | --- |
| `maxImageDimension2D`, `maxImageArrayLayers` | 8,192, 256 | 16,384, 2,048 |
| `maxComputeWorkGroupInvocations`, `maxComputeWorkGroupSize[0]` | 256, 256 | 1,024, 1,024 |
| sampled images, storage images a stage | 16, 4 | 48, 8 |
| `maxStorageBufferRange` | 1 GiB | 4 GiB − 4 |
| dual-source blending; 16-bit normalized formats (`texture-formats-tier1`) | no; no | yes; yes |
| vendor ID | Google's (0x1ae0) | Apple's (0x106b) |

Before, every adapter got the Mac's profile: on SwiftShader a 1,024-invocation workgroup or a 16,384-texel image was
advertised and failed. dEQP-VK's pass list lost 8 cases to it (workgroups past SwiftShader's 256 invocations, now
NotSupported): 1,463 pass. The programs' frames, captured again through the regenerated profile
(`images/vkframes/venus-profile.json`, now SwiftShader's own device), all within their tolerances on both hosts
(worst share of a frame's bytes off by more than 24: vkcube 0.03% / 0.001%, vkmark ≤ 0.11% / ≤ 0.11%, vkQuake 1.68% /
1.67%; `replay-*.json`).

Two of the adapter's features are held back, by measurement. **`float32-blendable`** gave mpv's libplacebo a family
of FBO formats (32-bit floats), so mpv on Vulkan rendered with its advanced path (scalers, debanding): decoding in
software its picture is within 47 of GL's bilinear one, and with VA-API it is right on SwiftShader (360 bytes off by
more than 24), but on the M4 the imported chroma plane reads as zeros: a green picture (`mpv-frames-mac-f32blend.json`,
`mpv-mac-f32blend-green.png`). Without it mpv renders as in L6: VA-API's frames byte for byte the software ones on the
M4 (`mpv-frames-mac.json`). Tier1's storage formats would give libplacebo another FBO family and are held back too,
untried on that path. Backlog "Imports' gaps".

**YCbCr conversions are dropped** (the kickoff's choice by measurement; plan §6). GTK 4.24 in the desktop guest takes
GSK's GL renderer by default even with Venus there (`gtk4-default-mac.json`). Forced onto Vulkan (`GSK_RENDERER=vulkan`)
with YCbCr advertised and not honoured, it fails GTK4's bar on the M4 (`gtk4-ycbcr-mac.json`, two alternated rounds):

| gtk4-demo, desktop guest, 4 vCPUs | frames/s | gtk4-demo's CPU a frame | what it drew |
| --- | --- | --- | --- |
| frames, GSK on Vulkan | 59.8, 59.7 | 3.34, 3.16 ms | a black window |
| frames, GSK on GL | 59.8, 59.8 | 2.62, 2.57 ms | right |
| fishbowl, GSK on Vulkan | 57.3, 22.6 | 5.34, 8.61 ms | one icon (5.7 frames/s by its own count) |
| fishbowl, GSK on GL | 53.0, 54.7 | 8.87, 8.31 ms | right |

So the device offers no YCbCr conversions (nor the extension): GTK4 stays on GL; forced onto Vulkan it aborts on its own
assertion (`gdk_display_create_vulkan_device`: `features & GDK_VULKAN_FEATURE_YCBCR`, `gtk4-noycbcr-swiftshader.json`).
The DRM modifier (LINEAR) stays: Venus's WSI needs it.

**The gate, again** (as L6: `avsync.ts`, Sintel's H.264 trailer from the media disk, three alternated rounds,
`mpv-mac.json`): mpv on Vulkan with VA-API's surfaces 528–529 frames shown, **0 dropped, the guest 13, 13, 13% busy**
(GL 12, 12, 12%); mpv's CPU 346, 326, 322 ms a second (GL 297, 297, 286), sway's 82, 92, 89 (GL 101, 101, 93); the
GPU worker's imports 5.1–5.3 ms a second. The same as L6: the bar (19–27% busy, no drops) holds.

**The module** (`module-size.json`): `target/vk/venus.wasm` 12,448,522 bytes (11.9 MiB), 1.18 MiB with gzip -9,
**0.69 MiB with brotli** (what Cloudflare serves), against VK1 step 1's bar of ~5 MiB compressed. It is in `npm run
dist`'s copy (`assets/venus-<hash>.wasm`, `VENUS-LICENSES.txt` beside it), fetched only by a machine with Vulkan on.

**A submit's and a pipeline's costs** (`bench/vulkan/costs.ts`, the driver's test program in the module on the page's
WebGPU: 40 alternated submits of one draw with a pipeline made before, and of one draw with a pipeline made anew from a
fragment shader specialized to a new value; medians, IQR in brackets; `costs-*.json`):

| ms | in the call (record, translate, replay into WebGPU) | until the fence signalled |
| --- | --- | --- |
| M4: a submit | 0.12 (0.05) | 0.68 (0.09) |
| M4: a new pipeline, new to Metal | 0.60 (0.12) | **81.6 (1.6)** |
| M4: the same pipelines again (Metal's on-disk cache) | 0.35 (0.13) | 1.23 (0.55) |
| M4: a hand-written WGSL pipeline of the same kind, new to Metal (`createRenderPipelineAsync` and its draw) | | 74.3 (1.7) |
| SwiftShader: a submit | 0.14 (0.04) | 3.19 (0.51) |
| SwiftShader: a new pipeline | 0.68 (0.16) | 27.1 (1.1) |
| SwiftShader: hand-written WGSL | | 18.0 (0.5) |

- **A pipeline costs the GPU's compiler, not the translation**: SPIR-V to WGSL and the driver's work are 0.6 ms; Metal's
  first compile of a new shader is ~75–80 ms (hand-written WGSL of the same kind: 74 ms), ~1.2 ms once its on-disk
  cache has it. Plan §7 priced ~10 ms from VK0's measurements (likely of shaders Metal had cached). With our WGSL's
  style (every value a `var`, bitcasts), the translation and the submit included, a pipeline costs ~10% more than the
  hand-written one on Metal (82 against 74 ms) and 27 against 18 ms on SwiftShader. Within a frame it costs nothing once made; a program's load
  pays it once a machine (backlog: made asynchronously, cached across runs).
- **A submit costs ~0.1 ms of the GPU worker's thread** on both, and its fence comes back 0.7 ms later on the M4
  (3.2 ms on SwiftShader, its CPU rendering).

**The NVIDIA run** (the gate's last part) is scripted, not run: `bench/vulkan/nvidia.sh page <bundle>` with the bundle
`bench/vulkan/nvidia-bundle.sh` makes on the dev VM (the repository, the built core and renderer, the firmware and the
guests' images, 3.4 GB) runs the programs' replays (REPLAY=all), the scene on Venus and virgl (two alternated rounds)
and mpv's gate (two), in Chrome for Testing headless if it gets the NVIDIA adapter, else headed in the user's own
Chromium, and packs the results. The dev VM ran it whole on SwiftShader (its test hooks).

## VK2: the NVIDIA run — right offscreen, faster than virgl where there's work, but mpv's picture black

**2026-10-26.** The user ran `bench/vulkan/nvidia.sh page` on their desktop with the bundle of cd03da82 (`results/vk2/nvidia/`):
an RTX 3070 with NVIDIA's 615.71.09, CachyOS (kernel 7.2.9), Arch's Chromium 153.0.8010.52; the page's WebGL2 is
ANGLE on NVIDIA's OpenGL ES 3.2, its WebGPU Dawn on Vulkan ("nvidia ampere"); the frames reach virgl by bitmap. One
session, two alternated rounds of the scene and of mpv, on the user's working desktop.

**The programs' frames are right** (`replay/results.json`; the share of a frame's bytes off by more than 24, worst
frame, against lavapipe): vkcube 0.001% (tolerance 0.2%), vkmark's 13 scenes ≤ 0.11% (0.3%; `texture` the worst, as on
the M4), vkQuake 1.67% (3%; the same 1.67–1.68% as on the M4 and SwiftShader: systematic). Replay rates 57 (vkcube),
67–126 (vkmark), 79 (vkQuake) frames/s. The run's warnings name two leads for vkQuake's difference: a shader that
didn't translate (`a texture of sampler dim 5`: texel buffers, its palettization) and depth and stencil copies into
`depth32float-stencil8` that WebGPU refused and the worker skipped.

**VK0's scene, desktop guest, 1080p, MSAA 1** (`scene-*`, medians of two rounds each; the M4's from "VK2 L5"):

| ms a frame (the guest's CPU a frame) | 1 fish | 1,000 fish | toolkit 2,000 |
| --- | --- | --- | --- |
| NVIDIA, Venus | 4.77, 4.90 (1.32, 1.09) | 6.59, 6.78 (3.07, 3.14) | 3.86, 3.75 (1.04, 1.12) |
| NVIDIA, virgl | 2.48, 2.65 (2.39, 2.43) | 9.14, 8.83 (6.16, 5.90) | 7.14, 7.02 (6.89, 6.68) |
| M4, Venus | 0.93–1.06 | 2.53–2.71 | 0.86–0.90 |
| M4, virgl | 1.43–1.45 | 4.83–5.46 | 3.40–3.60 |

- **The guest's CPU a frame is half virgl's or less everywhere** (toolkit: a sixth), as on the M4.
- **But Venus has a ~4.5 ms floor a frame on NVIDIA** (the M4's: ~0.9): at 1 fish it is 1.9× *slower* than virgl,
  though the renderer's GPU time is 0.28 ms and the worker is busy 4 ms a second. The display's fences take 4.1–5.3 ms
  on average to come back (`display.fences.meanMs`; `toGpuMs` 4.3–4.9), against L7's 0.7 ms for a submit's fence on
  the M4: the frame waits on its fence's round trip. Where Dawn on Vulkan (or Chromium's GPU process on Linux)
  spends it (`onSubmittedWorkDone`'s polling, the bitmap copy, the clocks of a lightly loaded GPU: "The NVIDIA
  desktop" saw bimodal light loads) isn't known: VK3.

**mpv's gate: no drops, the guest 11–13% busy, but nothing on the screen** (`mpv/`, Sintel's H.264 trailer, VA-API):

| two rounds | frames shown, dropped | the guest busy | mpv's CPU (ms a second) | sway's | the page's screenshot |
| --- | --- | --- | --- | --- | --- |
| Vulkan (`--vo=gpu-next --gpu-api=vulkan`) | 536, 531; **0** | 13, 11% | 340, 272 | 76, 63 | **black** (mean 0.4 of 255) |
| GL (`--vo=gpu`) | 529, 530; 0 | 9, 8% | 215, 184 | 64, 55 | the film (mean ~100) |

The timing bar holds, but **Vulkan's frames don't reach the screen on NVIDIA**: both rounds' screenshots are black but for
sway's "Click to type", while GL's show the film; the M4's screenshots of the same harness show it on Vulkan
(`bench/results/local/vk2-l7-mpv-mac`, not committed: mean 31 of 255 against GL's 34). The imports ran (48 pictures a second,
14 MB), and the replays, which check frames inside the guest without presenting them, are right: the suspect is L4's
presentation by bitmap (a WebGPU canvas on Dawn's Vulkan, `transferToImageBitmap`, `texSubImage2D` into ANGLE's
OpenGL), which only the M4 had run. The user, watching the run, saw the screen black for several seconds at a time,
repeatedly: every Venus window is likely black there (vkcube on the desktop wasn't in the run to say). **So the gate isn't met on NVIDIA**, the user's own GPU: VK3's first work. libplacebo said "Failed
creating FBO texture! Disabling advanced rendering" (L7's held-back float formats) and "Imported object requires 16384
bytes, larger than the provided size 8192" once a run, as on the M4.

## dEQP-VK's processes a machine: two, the whole list 14% faster

2026-11-07, the dev VM (SwiftShader, Chromium 155.0.8059.84). JSON in `results/vk4/jobs/`: `slice.txt` (every 29th case
of the pass list, 2,032), a run's results each (`j<jobs>-<time>.json`), `ab.txt` (the arms in their order). A machine's
guest has 4 vCPUs and dEQP-VK ran one case at a time, its process waiting on the device for most of each (the VM ~94%
idle with two machines at once): `bench/gpu/deqp-run.ts JOBS=<n>` runs n processes, each on a contiguous block of the
list (the shards' rule: a case keeps the cases before it), in a directory and shader cache of its own, their statuses
joined. On one machine of 1,536 MiB (CI's), two alternated rounds:

| JOBS | dEQP's seconds | each process's | result | the browser's peak RSS |
|---|---|---|---|---|
| 1 | 199, 201 | | 2,032 pass | 5.4 GiB |
| 2 | 161, 170 | 161 and 140, 170 and 148 | 2,032 pass | 5.6–5.7 GiB |
| 4 | 176, 176 | 176, 138, 142, 103 | a Crash each time | 6.1–6.3 GiB |

At 4 the slowest block sets the time and two different `synchronization2.timeline_semaphore.device_host` cases hung
past their watchdog (`write_copy_image_read_copy_image.image_128x128_r32g32b32a32_sfloat`,
`write_blit_image_read_image_compute.image_64x64x8_r32_sfloat`): host waits on a timeline across contexts, VK4-KICKOFF.md
T36's ground. **`tests/page-deqp-vk.test.ts` takes 2** (`WEBPC_DEQP_VK_JOBS` otherwise), for the sample and `--full`:
the whole list (58,906, two machines) passed in 2,470 s against 2,873 s at 1 (−14%), the script 3,229 → 2,826 s. The
sample's time at 2 isn't measured.

## VK4 T41: device addresses at a program's scale — placed at a buffer's bind, regions past a binding, capture and replay; 2,196 cases join the list

2026-11-08, the dev VM (SwiftShader, Chromium 155.0.8059.84) and the M4 (Metal, Chrome for Testing 157.0.8103.38,
`bench/gpu/sway-mac.sh`). JSON in `results/vk4/t41/`: `swiftshader-before.json` and `swiftshader-after.json` every case of
`binding_model.buffer_device_address` (4,718), `m4.json` the 2,196 new ones on the M4, `regions3-sample-swiftshader.json`
and `regions1-sample-swiftshader.json` 24 replay cases at three regions and at one, `gi-editor-swiftshader.json` (and its
last screenshot) Godot's GI demo's editor (`bench/vulkan/godot.ts`, 300 s, as GD G8's).

**What was there.** Before, every case of the group that ran passed (2,524; 1,179 of them in the list): `shaderInt64`
(VK4 T29) had already made `OpConvertUToPtr`'s 504 and the other conversions pass. The rest were not supported: the
1,176 replays and 10 `capture_replay_stress` (no `bufferDeviceAddressCaptureReplay`) and `set15`/`set31` (1,344: their
set numbers past `maxBoundDescriptorSets`' 8).

**What was done** (vk/README.md "Device addresses"):
- **Placed at its GPUBuffer's making.** A memory allocated for addresses goes into the address buffer at its first
  buffer's bind (or a linear image's use), not at its allocation: memory only images use takes no room. It can't move
  there later (commands name a memory's GPUBuffer), so a memory without room has buffers whose address is 0.
- **Regions.** The address buffer is up to four GPUBuffers, an address's high word picking one, each at a binding of
  group 3 (996, then 990 up: the driver's bindings now start at 990), each grown in place to `maxStorageBufferBindingSize`.
  An access through a pointer is an `if` tree on the high word where there are more than one. **At three regions
  (SwiftShader's 1 GiB bindings against the 3 GiB of heaps) 9 of 24 replay cases crashed on dEQP's 30 s watchdog**, the
  pipelines' compile 122 s for 25 against 5.2 s for 28 at one region (the same cases, all passing): SwiftShader's
  compile grows with the loads, and the tree triples them. So the regions reach 1 GiB together: one on SwiftShader, the
  M4 and NVIDIA (whose bindings reach that), four of 128 MiB on an adapter of WebGPU's least.
- **Capture and replay**: a memory allocated with the capture-replay flag is placed at once, at its opaque capture
  address when it has one (the address itself; a buffer's opaque address is 0).

| the 4,718 cases | Pass | Fail | NotSupported |
|---|---|---|---|
| SwiftShader, before | 2,524 | 0 | 2,194 |
| SwiftShader, after | 3,374 | 0 | 1,344 |
| M4, the 2,196 new | 2,196 | 0 | |

The 2,196 that pass on both and weren't in the list join `tests/deqp/vk.txt` (66,745 → 68,941: 840 replays, the 10
stress cases and 1,346 that passed before, not sampled into the list). The driver's test (`tests/venus-driver.test.ts`
"pointers into three regions …": the page tells the driver a binding reaches 1 MiB, so four regions of 1 MiB; a 2 MiB
image memory made for addresses, 600 KiB memories in regions 0 and 1, two more for capture and replay in 2 and 3, freed
and made again in the other order, a dispatch through pointers of three regions) failed before (the second memory refused) and
passes; a planted bug in the tree (one region) and in the replay's place (the next free one) each failed it.

**Godot's GI demo's editor on SwiftShader** (GD G8's run: black, Dawn's `CreateBuffer` refused growing the buffer to
512 MiB): the editor draws (`gi-editor-swiftshader-300s.png`), no WebGPU error, no refused memory. The address buffer
still grew to 512 MiB (128, 256, 512 MiB over the run), so most of what Godot's VMA placed there is its buffers' blocks
(or blocks shared with them), and SwiftShader took the grow this time: the refusal can come back at a larger scene.

**Left** (docs/backlog.md "Device addresses' leftovers"): address memory past 1 GiB where a binding reaches 1 GiB
(pipelines made for the regions in use, made again when another is first used, would reach the heaps without the
tree's cost); a memory whose GPUBuffer was made before a buffer of it asked for an address; replays not kept apart from
other allocations; `set15`/`set31` (8 descriptor sets); a vec4 view for 16-aligned loads and a descriptor beside the
pointers' binding (the review's W2) not done.

## VK4 T40: bindings past WebGPU's limits — words of one memory share a binding; 744 cases join the list

2026-11-08, the dev VM (SwiftShader, Chromium 155.0.8059.84) and the M4 (Metal, Chrome for Testing 157.0.8103.38,
`bench/gpu/sway-mac.sh`). JSON in `results/vk4/t40/`: `swiftshader-before.json` and `swiftshader-after.json` every case
of `binding_model.descriptorset_random.sets4` and `sets8` and `binding_model.descriptor_copy` (21,409; NotSupported
cases left out of the lists), `m4.json` the same on the M4.

**What the refusals were.** Run again before the change, the three groups failed 256 cases (`sets4` 210, `sets8` 40,
`descriptor_copy` 6), every one a pipeline refused at its creation: stages of 11 to 33 storage buffers where
SwiftShader and the M4 have 10, of them up to 19 texel buffers' words and up to 9 uniform buffers read as storage (a
stage's 13 uniform buffers and 4 inline blocks past WebGPU's 12 less the push buffer and the parameter table), and a
storing vertex stage's pre-pass's three bindings (T33's 55); and 4 `descriptor_copy` layouts of 5 or 6 dynamic storage
buffers (dEQP checks Vulkan's limit by the set, not the layout) against WebGPU's 4. `descriptorset_random` binds a
stage's buffers and texel buffer views from one buffer, at `align · d`.

**What was done** (vk/README.md "Texel buffers", "Bindings past WebGPU's", "Transform feedback", "Vertex stages that
store"):
- **Shared words.** A program whose stages fit only with them shared (`wg_bindings_fit`'s best case: a stage's
  shareable words one binding, a parameter table more in each group that has none) has no layouts of its own; each
  draw or dispatch takes a variant (`shared_words`) where the read-only words of texel buffers and folded uniform
  buffers of one memory read through one binding of the whole memory, every group's, each one's place in the binding
  the `.w` of its first vec4 in its group's parameter table, written with the bind group (so the variant is keyed by
  who shares with whom, not by the offsets, and the bind groups stay cached by their sets). A memory past what a
  binding takes, or a set's inline blocks (their set's buffer), share in runs within a group. A variant that still
  doesn't fit refuses its draws, said once.
- **The pre-pass and the capture without a uniform binding.** Their parameters are the first words of their inputs'
  buffer; the pre-pass's inputs and records are one buffer (one binding, three before), the capture's two bindings
  (three before). A capture of a program of four groups joins a copy of group 3 at bindings 997 and 999, as the pre-pass
  does at 995 (it was refused at the pipeline's creation: vkd3d's `test_vertex_id` had two).
- **Dynamic buffers past WebGPU's** (and with the push buffer's: R7's leftover, 8 dynamic uniform buffers and 4 dynamic
  storage ones beside push constants past the immediates) are plain bindings at the offset bound, a bind group each.
- **vkd3d's 14 uniform buffers a stage** are advertised where 8 storage buffers are left beside a third folded one (an
  adapter of 11 or more); SwiftShader's and the M4's 10 keep 13, D3D's 8 UAVs at 11_0 taking the eighth.

| the 21,409 cases | Pass | Fail | NotSupported |
|---|---|---|---|
| SwiftShader, before | 700 | 256 | 20,453 |
| SwiftShader, after | 956 | 0 | 20,453 |
| M4, after | 974 | 0 | 20,435 |

The 744 that pass on both and weren't in the list join `tests/deqp/vk.txt` (66,001 → 66,745: `sets4` 497, `sets8` 105,
`descriptor_copy` 142; 488 of them passed before too, not sampled into the list). Driver tests
(`tests/venus-driver.test.ts`): "12 uniform texel buffers of two buffers, 13 uniform buffers and 4 inline uniform
blocks" (both kinds of sharing), "dynamic uniform and storage buffers beside push constants past the immediates, at two
offsets" and "a capture of a vertex stage of four bind groups" failed before (refused) and pass; a planted bug in each
(the places, a run's places, the baked offsets' cache key, the capture's refusal) failed them. `texelStorage`'s three
texel buffers are of three buffers now (of one, they'd share): refused at the dispatch.

**vkd3d** (`bench/vulkan/vkd3d.ts`, `TESTS=test_vertex_id,test_instance_id`, the desktop guest on SwiftShader):
`test_vertex_id` runs 127 checks, 52 failing (89 and 39 at VK3 L8, its two captures of four groups refused): 75 pass
against 50; the failures seen are the indirect draws' values (base vertices 3, 8, 9), VK4-KICKOFF.md T47's.
`test_instance_id` 24 of 372, as before (divisors: T44).

**Left** (docs/backlog.md "Texel buffers", "Bindings past WebGPU's", "What R7's limits leave"): written storage texel
buffers take a binding each; words of several memories that still don't fit refuse their draws; an attachment read's
textures and pulled vertices' bindings with four groups have no binding numbers left in group 3 (T44 takes the pulled
ones); uniform texel buffers as r32uint textures and inline blocks as one uniform binding weren't needed. The cost of a
variant per sharing pattern, of a whole memory copied into a shadow beside its writes, and of a bind group per baked
offset is unmeasured: only programs past the limits pay them.

## VK4 T39: multisampling's gaps — SwiftShader's short resolves into deep arrays worked around; 455 cases join the list

2026-11-07, the dev VM (SwiftShader, Chromium 155.0.8059.84) and the M4 (Metal, Chrome for Testing 157.0.8103.38,
`bench/gpu/sway-mac.sh`). JSON in `results/vk4/t39/`: `clears-before.json` and `clears.json` the 588
`clear_color_image.2d.optimal.{multiple_layers,remaining_array_layers}.*_sample_count_4` before and after,
`attachments.json` the RGBA8 family's 720 layered multisampled `clear_color_attachment` cases with the 86 R4 took out of
the list, `mutable-diffsize.json` T4's 485 failing multisampled `image.mutable` resolves and the 126
`resolve_image.diff_image_size` ones, `regress.json` the list's 7,345 cases that resolve, clear or multisample (all
pass), `m4.json` the joining cases on the M4, `join.txt` them; `repro.ts` and `repro-layers.ts` the raw WebGPU repros.

**The multisampled clears weren't clears.** In vulkan-cts 1.4.7.0 these cases clear a 4-sample image of 8 layers
whole, then some of its layers, resolve every layer into a single-sampled image and read it back (the source in the
containers of an older CTS checked a single-sampled image; it misled the first hour). The driver's commands and the
worker's were the same for R8 (passing) and RGBA8 (failing), and the resolved texel read back on the GPU was right:
what failed was the last 508 texels of each 256x256 layer, `2 · width − 4` at every size from 16 to 256. A repro without
the driver: **SwiftShader's WebGPU resolves into an `rgba8unorm` or `bgra8unorm` view of a texture of 6 layers or
more leaves the level's last `2 · width − 4` texels unwritten** (4 layers and fewer, R8, RG8, sRGB, RGBA16F, level 1 of
three: right; the view's format decides, not the texture's). Metal resolves every variant rightly. The bytes never
written are whatever the memory held, which is why the backlog saw zeros, colours where zeros belong and colours of
neither, varying with the cases run before. The worker now resolves such a view into a texture of its own and copies it
into the layer (`shortResolve`; `vkCmdResolveImage`'s and a pass's resolve targets), on every adapter: a copy of a
level beside a resolve, and resolves into arrays that deep are rare. It also took the 126 `diff_image_size` resolves
(a destination of 11 layers), which pass now.

| run (SwiftShader) | before | after |
|---|---|---|
| `clear_color_image` layered, 4 samples (588) | 89 fail, 271 pass | 0 fail, 360 pass |
| the RGBA8 family's `clear_color_attachment` layered and R4's 86 (804) | (R4's failed) | 0 fail, 204 pass |
| T4's failing multisampled `image.mutable` resolves (485, before T12) and `diff_image_size` (126) | 485 failed at T4 | 130 fail, 376 pass |
| the list's resolving cases (7,345) | | 7,345 pass |

**The rest of T39:** multisampled copies between a packed format and a plain one, and `rgb10a2` and another of 4 bytes,
carry their bits (`texelFields`, `bitsBetween` over fields; SNORM layouts still skipped). Images made for sampling
already reported 1|4 samples where their format renders (VK4 T4): the backlog's sentence was stale. Of the 130
`image.mutable` failures left, 124 are views in formats WebGPU doesn't multisample (`r32_*`, `rg32_*`: their invalid
textures lose the submit), and 6 are the sRGB twins' ~0.26 in green and blue: SwiftShader again, resolving a 4-sample sRGB
texture through its UNORM view as sRGB (0.5 comes out 55; Metal gives 128): filed, not worked around. `R32G32_SFLOAT` and
`R32G32B32A32_SFLOAT` at 4 samples are left, with the emulation's better shape written down (channels split into
`r32float` attachments, an L task), as is `sampler2DMSArray` sampled whole (a variant keyed by the view's layers):
docs/backlog.md "Sample counts Vulkan wants but WebGPU lacks", "Multisampled arrays' leftovers".

**The list goes 65,546 → 66,001**: the 455 that passed and weren't in it (418 clears, 30 `image.mutable` resolves, 7
`diff_image_size`), all passing on the M4 too (`m4.json`). `scripts/ci.sh` OK (581 s); `scripts/ci-deqp-vk.sh` OK (901 s: a sample of 8,900
of 66,001, seed 2214960829, YCbCr's list and the replays).

## VK4 T38: formats and features a line or a fetch away; 6,443 cases join the list

2026-11-07, the dev VM (SwiftShader, Chromium 155.0.8059.84) and the M4 (Metal, Chrome for Testing 157.0.8103.38,
`bench/gpu/sway-mac.sh`). JSON in `results/vk4/t38/`: `cases.txt` the 16,159 run (every `texture.shadow` case, the
texel buffer groups that store (`api.buffer_view`, `image.*` buffers) and every 20th other `storage_texel_buffer` case,
every 4th case naming `a8_unorm`, every 10th naming a 10-bit SNORM format, the `image.*` storage groups' sRGB and packed
16-bit cases (`texel_view_compatible` every 4th), every `image_2d_view_3d` case); `swiftshader-before.json` before the
change (16,024: the same sets with a wider A8 pattern that also took `r8g8b8a8_unorm`); `swiftshader.json` and `m4.json`
after; `*-rerun.json` the cases `rerun.txt` and `rerun-m4.txt` name, after the fixes below (each overrides its host's
first run for them).

- **What the device does** (vk/README.md "Texel buffers", "Storage images as words", "Packed formats", "Formats a texture
  holds otherwise", "Memory"): depth formats report `SAMPLED_IMAGE_DEPTH_COMPARISON` in `VkFormatProperties3` (a line);
  storage texel buffers take texels of 1 or 2 bytes, a store an `atomicAnd` and an `atomicOr` on its word, the binding
  of atomics only where a store's format is under a word or not declared (R32's atomics were there since VK3 L6b);
  four-channel 8-bit sRGB and the packed 16-bit normalized formats are storage images by their words (Vulkan's
  transfer functions in the shader); `A8_UNORM` is an `r8unorm` texture whose red holds alpha (a view swizzle, clears,
  `override wg_ar` moving the fragment output's alpha to red), not blended nor blitted; the 10-bit SNORM orders are
  `rgba16float` textures through `packPass` (normalized values to and from floats); `VK_EXT_image_2d_view_of_3d`
  (sampled and storage) binds the level's 3D view, a variant keyed by the slice giving every op its third coordinate.
  The kickoff named `rgba16snorm` (tier1) for the SNORM formats: `rgba16float` renders, blends and filters on every
  adapter, SwiftShader included, and holds a 10-bit step to an eighth.
- **Confirming, failing first**: the driver's scenarios 109 (the advertised bits, 10-bit SNORM's texels and clamped clear)
  and 110 (`t38/stores.comp`: four invocations' R8_UINT texel stores into one word, sRGB and R5G6B5 storage stores, an
  A8 clear sampled, a 3D image's slice 2 fetched and slice 3 stored through 2D views) fail before the change (D32_SFLOAT
  lacks the comparison bit; the images refused) and pass after. Planted: a sub-word store's shift taken as 0 fails 110's
  texel bytes.
- **Found by the cases**: non-seamless cubes compared (`texture.shadow.cube*.non_seamless_*`, 360 on each host) were
  WebGPU's seamless samples: the faces' fetches took no comparing sampler (VK4 T28 left it out, its cases not
  supported then); each texel is compared there now. Blits into or from A8 drew its red as colour (the worker's blit draws
  know no swizzle: 73 and 23): its blit bits are off, the cases not supported; its input attachments in their own pass
  read the twin view, whose swizzle didn't know A8 (28). Copies between a 10-bit SNORM format and a float one of its size lost the most negative
  codes (-512, alpha's -2), read -1 as the next code is, back as that next one (26): such a code is -1 − 2⁻¹⁰ in the
  half-float texture, back as itself; it samples one 10-bit step from -1, which `texture.conversion.snorm_clamp`'s
  `a2r10g10b10` case sees (it passed before the fix on the M4): bits over that case.

| set | SwiftShader before | SwiftShader | M4 |
|---|---|---|---|
| shadow (5,377) | 1 / 0 / 5,376 | 1,729 / 0 / 3,648 | 1,729 / 0 / 3,648 |
| texel buffers (4,272) | 1,301 / 0 / 2,971 | 1,701 / 0 / 2,571 | 1,841 / 0 / 2,431 |
| storage images as words (2,478) | 26 / 0 / 2,452 | 857 / 0 / 1,621 | 1,015 / 0 / 1,463 |
| A8_UNORM (2,610) | not offered | 1,656 / 36 / 918 | 1,692 / 0 / 918 |
| 10-bit SNORM (1,640) | 9 / 0 / 1,631 | 1,125 / 31 / 484 | 1,194 / 4 / 442 |
| 2D views of 3D (98) | 2 / 0 / 96 | 50 / 0 / 48 | 50 / 0 / 48 |
| all (16,159) | | 6,951 / 51 / 9,157 | 7,338 / 4 / 8,817 |

  (pass / fail / not supported.) SwiftShader's 51: 44 its own (`count_8` compute stages binding 8 storage textures and
  cube linear filters in compute, as T31's RGBA8 twins; 6 of 7 ASTC-to-SNORM linear blits that pass on the M4), and
  `snorm_clamp`. The M4's 4: `snorm_clamp`, the ASTC 8x8 blit into A2B10G10R10_SNORM (both hosts), two copies from
  `e5b9g9r9_ufloat_pack32` (the M4's own, filed). What stays not supported: 1D depth images and sparse ones (the shadow
  set's), `r32_sfloat` and `r16_unorm` comparisons (1,344: a colour texture compared would be the shader's), storage
  formats WebGPU has no texture or words of (3- and 6-byte texels, sRGB of fewer channels), A8's blits and the
  formats' linear tiling. **The 6,443 that pass on both and weren't in the list join `tests/deqp/vk.txt`** (59,104 →
  65,547).

## VK4 T37: commands WebGPU refused, made valid or refused where they're made

2026-11-07, the dev VM (SwiftShader, Chromium 155.0.8059.84). JSON in `results/vk4/t37/` (`cases.txt` the list run:
every `image.mismatched_formats` case, every 40th of `robustness`'s mustpass and the 22 `extended_dynamic_state` and
`input_attribute_offset` cases whose bindings are read past their end; `before.json` before T37, without those 22).
Nine shapes in which WebGPU refused a dispatch, draw or bind group and dropped its whole submit, each with a driver test
(tests/venus-driver.test.ts, wg_test.c 102 to 108 and `pullPastEnd`) seen failing with its fix taken out and passing
with it:

| shape | now |
|---|---|
| a subresource read as a texture and written through a storage binding in one scope (a 3D level too) | the read takes a copy of the image made at the scope's start (`scope_reads`, `wg_view_loop`'s texture) |
| a one-layer 2D array view bound to a storage image the stage declares 2D | a 2D view of its base layer (`flat_storage`) |
| stages from a cache that disagree on an image (`wg_program_merge`) | the merged program refuses its draws, as compiling them together does (`stages_agree`; a hook in the module tests it, `wgt_merge_refused`: no Venus path makes such a cache) |
| a packed format's copy past `maxStorageBufferBindingSize` (a 512x512x130 A4R4G4B4 3D image, 136 MB unpacked) | `packPass` in slabs that fit; on a device of WebGPU's least, 128 MiB, the last slice came back zeros |
| a storage image as words past that limit (4100x4096 RG32_SFLOAT) | its draws and dispatches refused, said once, the rest of the submit kept (`words_past`) |
| a storage image declared in another format than its view's, only read | keyed by the view's format, as written ones were (GD G7) |
| a direct draw reading a vertex or instance binding past its buffer's end | that binding pulled, loads past its range 0 (`cmd->reach`, `pulledCode`) |
| a uniform block past its range and its memory's pad (a memory within 64 KiB of `maxBufferSize`; the translator caps blocks at the adapter's `maxUniformBufferBindingSize`, 64 KiB on SwiftShader, which the pad covers otherwise) | read from a shadow of the block's size (`scope_use.need`) |
| writable bindings of one range, one of atomics and one not, or past the limit | the draw or dispatch refused, said once (`aliases_refused`); one atomic binding for both needs the plain stage printed again from its NIR (backlog) |

| run | cases | pass | fail | not supported | WebGPU errors |
|---|---|---|---|---|---|
| before (without the 22) | 2,776 | 190 | 39 | 2,547 | 0 |
| after | 2,789 | 202 | 39 | 2,548 | 0 |

The 39 failures are the same in both: `robustness.image_robustness`'s out-of-bounds accesses and one `vertex_access`
case (backlog "Storage images' cases failing before T11"). `image.mismatched_formats` already passed where it ran (GD
G7 keyed written images, G4 made formatless reads textures): the backlog's entry predated them; its not supported cases
are formats offered no storage. `extended_dynamic_state.*vertex_input_multiple_bindings`, which failed (a slot bound
with no bytes left), passes. **197 cases join `tests/deqp/vk.txt`** (→ 59,104), the passes not in it, on SwiftShader
only (the M4 not run).

## VK4 T36: a fence given back is signalled once its work is done; four dEQP processes don't hang

2026-11-07, the dev VM (SwiftShader, Chromium 155.0.8059.84). JSON in `results/vk4/t36/` (`ab.txt` the runs in order).
A ring fence that gave its queue entry back (VK4 R1: the queue full and stalled for 250 ms) was signalled only by the
next fence of its ring with an entry, so a guest waiting for it alone, while the ring's newest waited for what the guest
did next, waited for ever (the review of R1 to R4's C2). Now, once its work is done, the next reply without a fence of
its own carries it in its header (the kernel's dequeue signals a reply's fence whatever its command), and when the guest
sends nothing for 20 ms the device raises the display event, whose GET_DISPLAY_INFO the kernel sends from its own work
(web/gpu.ts `carry`; tests/gpu.test.ts "a fence that gave its entry back …", both failing before: fence 14 signalled of
19). The section above's reproducer, dEQP-VK at `JOBS=4` over its 2,032-case slice on one machine of 1,536 MiB, which hung
a `synchronization2.timeline_semaphore.device_host` case in both runs then, passes every case in three runs now; with
`JOBS=2` alternated:

| JOBS | dEQP's seconds | each process's | result |
|---|---|---|---|
| 4 | 143, 143, 143 | 137–144, 101–105 for the fourth | 2,032 pass |
| 2 | 163, 162 | 143–164 | 2,032 pass |

Four processes are 12% faster than two now that none waits out a watchdog (176 s before). `tests/page-deqp-vk.test.ts`
stays at 2: the browser's peak was 6.1–6.3 GiB a machine at 4 against 5.6–5.7 at 2 (the section above), and
`scripts/ci-deqp-vk.sh` runs two machines under a 14 GiB cap (docs/backlog.md "dEQP-VK's four processes a machine").

Venus's fix for a memory freed while its blob is mapped (VK1 L8) has its test: the guest's commands encoded by hand
(tests/venus-renderer.test.ts `VenusStream`: vkCreateInstance to vkAllocateMemory, vkFreeMemory, through `venus_submit`),
the blob's unmap after the free filling the blob's storage, not the next memory's; with the fix's branch planted out of
vkr (`vkr_wasi_memory_release`), the next memory got the freed storage and the test failed.

## VK4: R32G32B32_SFLOAT no colour attachment (a sample's failure, found running T34's CI)

2026-11-07, the dev VM (SwiftShader). `scripts/ci-deqp-vk.sh`'s sample (seed 1657927271) failed
`api.info.image_format_properties.2d.optimal.r32g32b32_sfloat` ("Required sample counts not supported"), with T34's
changes and without them: since T31 the format is an `rgba32float` texture reported as a colour attachment, and Vulkan
wants every colour attachment format at `framebufferColorSampleCounts` (1 and 4), which WebGPU can't multisample.
Vulkan doesn't require RGB32 colour attachments (most GPUs' drivers lack them), so the format is no colour attachment
any more (`WG_FMT_NO_ATTACHMENT`; its texture still takes the worker's clears and blits), and an input attachment of
it is refused (an input attachment needs a colour or depth attachment format: `unsupported_image_usage`'s query of
it then passed too). Of the mustpass list's 10,987 cases naming the format, run before and after (8,242 reached in the
run's time, then the 43 that didn't pass, on both builds), only 10 of the pass list changed, passing to not supported (58,916 → 58,906)
(9 `blend` and `logic_op_na_formats` draws into it, one partial clear of it as an attachment), taken out of
`tests/deqp/vk.txt`; the 32 failures (SwiftShader's `count_8` compute cases: docs/backlog.md) failed on both.
Confirming test, failing first: tests/venus-renderer.test.ts "what the driver advertises…" (the format's features
without the colour attachment, the input attachment's query refused).

## VK4 T34: mutable descriptors — bind groups of the shader's declarations; 3,561 cases join the list

2026-11-07, the dev VM (SwiftShader, Chromium 155.0.8059.84) and the M4 (Metal, Chrome for Testing 157.0.8103.38,
`bench/gpu/sway-mac.sh`). JSON in `results/vk4/t34/`: `cases-census.txt` (the census's 143 that asked for the
extension), `cases-candidates.txt` (the 10,500 `binding_model.mutable_descriptor` cases without ray tracing stages),
`cases-pass-sw.txt`; `swiftshader-first.json` (the census's and every 8th candidate before the support query),
`swiftshader-candidates.json`, `m4-pass.json`.

- **What the device does** (vk/README.md "Descriptors"): `VK_EXT_mutable_descriptor_type` and `mutableDescriptorType`.
  A set layout keeps each binding's types (a mutable one's list); a slot written as another type than it holds keeps
  nothing of the one before. Nothing else was needed for the kickoff's guess (a bind group layout per set of written
  types): the driver's bind group layouts and groups are made of the program's declarations, each slot's descriptor as
  written, so a mutable slot is bound as the type the shader declares, which Vulkan requires to be the one written.
  A variant is needed only where declarations of several types alias one binding, which dEQP (and the spec's validity)
  gate on `descriptorBindingPartiallyBound`, not advertised. Uniform buffers among a mutable binding's types count in
  `fold_uniforms`' room, so all stages read it alike.
- **Found by the cases**: the first run (606: the census's 143 and every 8th candidate) passed 482 and failed 18, all
  arrays of 6 mutable descriptors read as storage images or texel buffers beside dEQP's own buffers, past the stage's
  WebGPU bindings (refused at the pipeline, said why: nothing written). Vulkan's per-stage limits count only the types,
  so the layout's support query is the device's say: it now answers no where a stage could take more of a kind of
  WebGPU binding than it has, a mutable descriptor counted in every kind its list names, a texel buffer as a storage
  buffer (`wg_mutable_layout_fits`); dEQP checks it and reports those cases not supported.
- **Confirming, failing first**: tests/venus-driver.test.ts "misc: mutable descriptors read as the type last written
  to them, written over another type and copied" (wg_test.c's scenario 101: three mutable bindings, each written as
  another type first, a set copied from it, and the support query's yes and two no's) failed before ("mutableDescriptorType
  isn't reported").

| set | host | pass | fail | not supported |
|---|---|---|---|---|
| the census's 143 | SwiftShader, before (census) | 0 | 0 | 143 |
| | SwiftShader | 37 | 0 | 106 |
| the first sample (606) | SwiftShader, before the support query | 482 | 18 | 106 |
| the candidates (10,500) | SwiftShader | 3,561 | 0 | 6,939 |
| SwiftShader's 3,561 | M4 | 3,561 | 0 | |

  The not supported: update after bind 4,557, acceleration structures 870 and ray-tracing intersection stages 270,
  geometry and tessellation 810, variable descriptor counts 144, aliasing 108 (partially bound), the support query's
  no 105, dynamic indexing of uniform texel buffer arrays 75 (not advertised: docs/backlog.md "Mutable descriptors'
  leftovers"). **The 3,561 join `tests/deqp/vk.txt`** (55,355 → 58,916; none were in it); `scripts/ci-deqp-vk.sh` passed with them and the RGB32 change above
  (seed 1657927271: 8,003 of 58,906, the sample that had failed). vkd3d-proton's descriptor
  heaps (unbounded mutable arrays, update after bind) stay out of reach without WebGPU's binding arrays.

## VK4 T33: writable storage in the vertex stage — the stage as compute in a cut of the pass; 7,314 cases join the list

2026-11-07, the dev VM (SwiftShader, Chromium 155.0.8059.84) and the M4 (Metal, Chrome for Testing 157.0.8103.38,
`bench/gpu/sway-mac.sh`). JSON in `results/vk4/t33/`: `cases-census.txt` (the census's 232 that asked for
`vertexPipelineStoresAndAtomics`, 143 of them without geometry, tessellation, task or mesh stages),
`cases-candidates.txt` (11,271: every case of the groups those name whose vertex stage may store, not in the list),
`cases-wait-before-signal.txt` (928), `cases-pass-sw.txt`; `swiftshader-census-before.json`, `swiftshader-census.json`,
`swiftshader-candidates.json`, `swiftshader-wait-before-signal.json`, `m4-pass.json`; `cost-*.json`.

- **What the device does** (vk/README.md "Vertex stages that store", both sections): WebGPU refuses writable storage
  reached from a vertex entry point, so a vertex stage that writes a buffer or an image or does atomics is printed
  without its entry point, its body (`wg_vs`, transform feedback's) run as compute. A draw of it cuts the WebGPU render
  pass after its state is applied (`vs_prepass`); the worker runs the stage for the draw's vertices, an invocation a
  vertex in the draw's order, on the bind groups, buffers and immediates the pass last set, and writes each vertex's
  outputs as words; the pass begins again loading, and a pass-through vertex stage of the worker's draws the records
  as a vertex buffer (an indexed draw through a list of the records' places, restarts kept). The pre-pass's bindings
  take a group after the program's, or join a copy of group 3 where a program has four (device addresses, sets 3 and up
  and the push buffer live there). Draws that rasterize nothing still run the stage; a draw split by stencil face runs
  it once. Vulkan orders a draw's vertex stage after the commands before it, which the cut keeps (a pre-pass hoisted
  before the pass, the render-pass rule's way, wouldn't see an earlier draw's stores after a barrier).
- **Confirming, failing first**: the census's 143 were all not supported (`swiftshader-census-before.json`); the
  driver's usage-scope scene with a storing vertex stage (tests/venus-driver.test.ts "usage scopes: … a storage buffer
  the vertex stage writes", indexed, not indexed, beside the fragment stage's write, with rasterizer discard) and the
  translator's test (tests/wgsl.test.ts "a vertex stage that writes storage is printed without its entry point").
- **Found by the cases**: (1) the device-address cases' programs have four groups (the address binding is group 3's),
  so the pre-pass had none of its own: its bindings now join a copy of group 3 (`vsGroup3`, from the driver's layouts'
  and groups' entries); the 16 `atomic_operations.*_vertex_reference` cases failed so. (2) dEQP-VK's vertex cases that
  write their results to an image draw with rasterizer discard, which the driver dropped before the vertex stage ran
  (`OP_VS_ONLY`). (3) A grid-stride loop around the stage's body took SwiftShader's GPU process past 4 GiB compiling
  `buffer_device_address.*.depth2.*convertcheckuv2.store.*vert_offset_nonzero` (and the run's 9 GiB cap with it): an
  invocation a vertex over a 2D grid compiles at the usual 3 GiB of the run.

| set | host | pass | fail | not supported |
|---|---|---|---|---|
| the census's 143 | SwiftShader, before | 0 | 0 | 143 |
| | SwiftShader | 111 | 2 | 30 |
| the candidates (10,581 the disk's list has) | SwiftShader | 7,311 | 55 | 3,215 |
| SwiftShader's 7,311 | M4 | 7,311 | 0 | |
| wait_before_signal's 26 | M4 | 26 | 0 | |
| `timeline_semaphore.wait_before_signal` (928) | SwiftShader | 26 | 0 | 902 |

  The candidates that pass by group: `binding_model.shader_access` 5,648, `buffer_device_address` 840,
  `pipeline.monolithic.spec_constant` 522, `descriptorset_random` 169, `opaque_type_indexing` 100, `atomic_operations`
  32. `scripts/ci-deqp-vk.sh` passed with them (a sample of 7,561 of 55,355, seed 1022338136, and YCbCr's list and the
  replays). **The 7,314 that pass on both and weren't in the list join `tests/deqp/vk.txt`** (48,041 → 55,355; 23 were in it
  already: 21 of the spec constants' compute and fragment cases and the two `host_wait_before_signal`). The 55 failures are all
  `descriptorset_random.sets4` and `sets8` stages past WebGPU's bindings with the pre-pass's three (16 to 33 storage
  buffers of 10, texel buffers' words most of them; one over by a uniform buffer: VK4-KICKOFF.md T40). The rest not
  supported: geometry, tessellation, mesh and task stages, `bufferDeviceAddressCaptureReplay`, 64-bit atomics and float
  atomics; every `wait_before_signal` case asks for tessellation whatever its stages, but its 26 of transfers alone.
- **A storing draw's cost** (`bench/vulkan/t33/suite.ts`, `cost-*.json`: in plain WebGPU, the pass ended, a compute
  pass writing each vertex's record and an atomic, the pass begun again loading, the records drawn through a
  pass-through stage, against the same draws with an ordinary vertex stage; 100 draws of a full-target triangle list
  on rgba8unorm, ms a draw, median of 10):

| | 256×256, 3 vertices: plain / storing | 256×256, 3,000 | 1920×1080, 3 | 1920×1080, 3,000 |
|---|---|---|---|---|
| M4 | 0.006 / 0.143 | 0.206 / 0.201 | 0.009 / 0.123 | 5.07 / 4.23 |
| SwiftShader | 0.024 / 0.093 | 7.08 / 7.92 | 0.256 / 0.398 | 224.8 / 230.4 |

  A storing draw costs ~0.12 ms more on the M4 whatever its size, the pass's cut (as T32's reading draws: ~0.1 ms);
  at 3,000 vertices of full-target triangles the fill hides it there (the storing arm's faster on the M4, within
  what fill-bound draws vary: the Mac was loaded, 99% GPU busy from the VM's work beside, IQRs under 1%).
  SwiftShader pays the cut (0.07–0.14 ms) and the compute's ~0.3 µs a vertex. Fine for what stores in the vertex
  stage (dEQP-VK's, a debug counter, a particle system's few draws), not for thousands of draws a frame; no program we
  run stores there (VK0's scene, mpv, vkQuake, GTK4, Godot).

## VK4 T32 (third part): single-sampled attachments rendered multisampled; 1,730 cases join the list, T32 done

2026-11-06, the dev VM (SwiftShader, Chromium 155.0.8059.84) and the M4 (Metal, Chrome for Testing 157.0.8103.38,
`bench/gpu/sway-mac.sh`). JSON in `results/vk4/t32/`: `cases-mrtss-census.txt` (the census's 86),
`cases-mrtss-all.txt` (the group, 4,290), `cases-mrtss-info.txt` (the format queries asking
`VkSubpassResolvePerformanceQueryEXT`, 920), `cases-mrtss-pass-sw.txt`; `swiftshader-mrtss-census.json`,
`swiftshader-mrtss-all-first.json` (before the fix below), `swiftshader-mrtss-all.json`, `swiftshader-mrtss-info.json`,
`m4-mrtss-pass.json`.

- **What the device does** (vk/README.md "Multisampled rendering to single-sampled attachments"):
  `VK_EXT_multisampled_render_to_single_sampled` advertised. A pass with `VkMultisampledRenderToSingleSampledInfoEXT`
  (a subpass's through Mesa's runtime) has its rendering info rewritten: each single-sampled attachment is drawn in a
  4-sample image of its own (`wg_view_ms`) resolving into it, by WebGPU's resolve target for colour and the drawn
  resolves (T27) for depth and stencil; a LOAD first fills every sample with the attachment's texel, the worker's
  `copyMultisampled` now taking a single-sampled source. The resolve performance query says optimal. What it costs
  is what any 4× pass with a resolve costs, and a draw per LOAD (no timing taken: nothing we run uses it).
- **Confirming, failing first**: the driver's scenario 100 (tests/venus-driver.test.ts "a single-sampled attachment
  rendered at 4 samples…": a sample mask of 2 of 4 samples over a loaded colour, the resolve their average). Planted:
  without the fill, the unwritten samples are zeros (blue 64, alpha 128).
- **Found by the cases**: an attachment of a format WebGPU can't multisample (R32G32B32A32_UINT) named by a pass that
  doesn't draw it made an invalid texture and lost the pass (the first run's 9 WebGPU errors): the pass now goes without
  it, its clear made outside the pass.

| set | host | pass | fail | not supported |
|---|---|---|---|---|
| the census's 86 | SwiftShader | 18 | 0 | 68 |
| the group (4,290) | SwiftShader | 810 | 70 | 3,410 |
| the format queries (920) | SwiftShader | 920 | 0 | 0 |
| the 1,730 that pass | M4 | 1,730 | 0 | 0 |

  **The 1,730 join `tests/deqp/vk.txt`** (46,311 → 48,041).
- **The 70 failures**: every one draws an R32G32B32A32_UINT attachment at 4 samples, which our query says it can't
  take (sample counts 1); dEQP-VK checks each format's count only when its first float attachment is single-sampled
  (`checkRequirements`'s `if (params.numFloatColor1Samples == VK_SAMPLE_COUNT_1_BIT)` around every format), so they run.
  Refusing the create flag for such formats would make them not supported, and 151 passing cases with them too: left
  as they are, out of the list.
- **What's left not supported** (the census's reasons): sample counts other than 4 (2, 8 and 16: most), formats
  WebGPU doesn't multisample, Android hardware buffers.

## VK4 T32 (second part): an attachment sampled by its own pass's draws; 561 cases join the list

2026-11-06, the dev VM (SwiftShader, Chromium 155.0.8059.84) and the M4 (Metal, Chrome for Testing 157.0.8103.38,
`bench/gpu/sway-mac.sh`). JSON in `results/vk4/t32/`: `cases-feedback-census.txt` (the census's 48),
`cases-feedback.txt` (the sample, 430), `cases-feedback-all.txt` (the group, 2,387), `cases-feedback-pass-sw.txt`;
`swiftshader-feedback-census-before.json`, `swiftshader-feedback-before.json` (advertised, no copy),
`swiftshader-feedback.json`, `m4-feedback.json`, `swiftshader-feedback-all.json`, `m4-feedback-pass.json`.

- **What the device does** (vk/README.md "Feedback loops"): `VK_EXT_attachment_feedback_loop_layout` and its dynamic
  state are advertised. A draw sampling a view that covers an attachment of its pass (the image with
  `ATTACHMENT_FEEDBACK_LOOP_BIT`) samples the view made again over a copy of the image's texture (`wg_view_loop`),
  every level and layer of the view's range copied into it in a cut of the pass at the first such draw and after a
  barrier or clear, as T12's input attachments' copies.
- **Confirming, failing first**: the driver's scenario 99 (tests/venus-driver.test.ts "a feedback loop…": an image of
  two layers, layer 0 the attachment, sampled through a 2D array view of both; a second draw after a barrier reads the
  first's writes). With the sampled descriptors unmatched (the old code) WebGPU refuses the pass ("TextureBinding|
  RenderAttachment includes writable usage"); `vkskip=feedback` leaves the bytes wrong.

| set | host | pass | fail | not supported |
|---|---|---|---|---|
| the census's 48, advertised, no copy | SwiftShader | 10 | 1 | 37 |
| the sample (every read-write case of the optimal layout but stencil's, the misc ones, every 8th read-only: 430), advertised, no copy | SwiftShader | 86 | 168 | 176 |
| the sample | SwiftShader | 254 | 0 | 176 |
| | M4 | 254 | 0 | 176 |
| the whole group (2,387; the census's 48: 11 pass) | SwiftShader | 561 | 0 | 1,826 |
| its 561 | M4 | 561 | 0 | 0 |

  **The 561 join `tests/deqp/vk.txt`** (none was in it). The read-write cases are 1D and 2D views only; the read-only
  ones (the image sampled, not attached) needed only the extension.
- **What's left not supported** (the group's 1,826): the `general` layout's 1,190 want `VK_KHR_unified_image_layouts`,
  which the tests' guest's Venus (Mesa 26.2) doesn't have (layouts are nothing to WebGPU: it would need only
  advertising once Venus carries it); 300 stencil read-write and interleaved cases want `VK_EXT_shader_stencil_export`
  (WebGPU has no stencil output); 336 image formats or types not offered (1D depth images, 3D depth).

## VK4 T32 (first part): depth bounds, logic ops, advanced blends and local read; 1,084 cases join the list

2026-11-06, the dev VM (SwiftShader, Chromium 155.0.8059.84) and the M4 (Metal, Chrome for Testing 157.0.8103.38,
`bench/gpu/sway-mac.sh`). JSON in `results/vk4/t32/` (`cases-dst.txt`, `cases-local-read.txt`: the cases;
`swiftshader-dst-census.json`, `swiftshader-dst-sample.json`, `m4-dst.json`; `swiftshader-local-read.json` and its
`-rerun` after the fix below, `m4-local-read.json`; `cost-*.json`: a reading draw's cost). Two of the task's six,
`VK_EXT_attachment_feedback_loop_layout` and `VK_EXT_multisampled_render_to_single_sampled`, are left
(VK4-HANDOVER.md "T32").

- **What the device does** (vk/README.md "Reading the attachments", "Colour attachment locations"): a draw whose dynamic
  state has the depth bounds test, a logic op or an advanced blend reads a copy of the attachment, made in a cut of the
  WebGPU pass before every such draw (T12's twins, `dst_copies`), bound in a group of its own; its fragment stage is
  printed for the key, the stage's `main` wrapped by one that tests the depth, calls it, and puts each output through
  the op or the blend against the copy's texel. Local read is T12's input attachments (unchanged) and the colour
  attachment map, which the key holds and the stage is printed for (outputs moved to the attachment that takes them).
- **Confirming, failing first**: the census's 226 depth bounds, logic op and advanced blend cases and its 97 local read
  ones were all not supported; the driver's scenario 98 (tests/venus-driver.test.ts "draws reading the attachments they
  write…") draws each of the three into its own column of one pass. Planted: XOR printed as OR fails its logic op (byte
  2: 204 | 128 is 204), MULTIPLY as a sum its blend.
- **Found by the cases**: Mesa's runtime takes a pipeline's `VkPipelineColorBlendAdvancedStateCreateInfoEXT` as dynamic
  state and drops it unless `advancedBlendCoherentOperations` is enabled, so every advanced blend ran uncorrelated and
  premultiplied (the census's 69 failures): the device enables the flag without advertising it. A destination that
  isn't premultiplied takes the result's colour divided by its alpha (dEQP-VK's reference; 32 failures). A logic op
  turns blending off on every attachment, sRGB and float ones too, which it doesn't apply to (5). Without a fragment
  shader, depth bounds take a stage of the test alone (the `nocolor` cases, 39). Local read's
  `vkCmdSetRenderingAttachmentLocationsKHR` (the `remap`, `unused_writen_discarded` and `formats.*.input` cases: 8).

| set | host | pass | fail | not supported |
|---|---|---|---|---|
| depth bounds, logic op, advanced blend: the census's 226 | SwiftShader, before | 0 | 0 | 226 |
| | SwiftShader | 176 | 0 | 50 |
| and every 10th `logic_op`, 40th `blend_operation_advanced`, 30th depth bounds case (999 in all) | SwiftShader | 783 | 0 | 216 |
| | M4 | 783 | 0 | 216 |
| local read: the census's 97 | SwiftShader | 31 | 0 | 66 |
| every `local_read` case and every 25th `renderpasses.dynamic_rendering` one (1,088) | SwiftShader | 341 | 0 | 747 |
| | M4 | 391 | 0 | 697 |

  **The 1,084 that pass on both and weren't in the list join `tests/deqp/vk.txt`** (44,666 → 45,750): 783 of the
  reading sample, 301 of local read's (40 more were in the list; 50 pass on the M4 only, formats SwiftShader lacks).
- **What's left not supported**: of the reading sample, `VK_EXT_depth_range_unrestricted` (113: depths and bounds past
  [0, 1], which WebGPU's viewport depths can't reach), 16 attachments (65: `advancedBlendMaxColorAttachments` is 8),
  64-bit formats (27), mesh shaders; of local read's, graphics pipeline libraries, sample counts WebGPU lacks,
  `VK_EXT_dynamic_rendering_unused_attachments` (48), `customResolve` (41), fragment density maps.
- **A reading draw's cost** (`bench/vulkan/t32/suite.ts`, `cost-*.json`: in plain WebGPU, what `dst_copies` makes the
  worker do — the pass ended, the attachment copied, the pass begun again loading it, the stage blending against the
  copy — against WebGPU's own blend, 100 fullscreen draws on rgba8unorm, ms a draw, median of 10):

| | 256×256, WebGPU's blend / read | 1920×1080, WebGPU's blend / read |
|---|---|---|
| M4 | 0.006 / 0.100 | 0.034 / 0.144 |
| SwiftShader | 0.045 / 0.150 | 0.781 / 2.457 |

  On the M4 a reading draw costs ~0.1 ms more whatever its size: the pass's cut, not the copy. Bearable for what uses
  these sparingly (a depth bounds test for a light's pass, a logic op for a cursor or a selection), not for a program
  that sets them on thousands of draws a frame; none of the programs we run does (VK0's scene, mpv, Godot, vkQuake,
  GTK4 set none of them).

## VK4 T31: formats WebGPU has no texture of, in wider textures; vertex formats it lacks pulled; 1,733 cases join the list

2026-11-06, the dev VM (SwiftShader, Chromium 155.0.8059.84) and the M4 (Metal, Chrome for Testing 157.0.8103.38,
`bench/gpu/sway-mac.sh`). JSON in `results/vk4/t31/` (`cases.txt`: the 3,155 cases; `swiftshader-before.json`: the
format cases before any change; `swiftshader-scaled-as-floats.json`: the first try, below; `swiftshader-vertex-input.json`;
`cost-*.json`: the copies' cost).

- **What the device does** (vk/README.md "Packed formats", "Pulled vertices"): T30's packed formats' way for every
  format the census's "not supported for sampling / transfer / blending" named: the three-channel ones (`R8G8B8`,
  `B8G8R8` of every type, `R16G16B16`, `R32G32B32`) in a four-channel texture with alpha kept 1, BGRA's UINT, SINT and
  SNORM, `R8_SRGB` and `R8G8_SRGB` in `rgba8unorm-srgb` (G and B kept 0), the 10-bit SINT orders in `rgba16sint`, and the
  scaled formats in their integer twins' textures, for transfers only. The worker's `packPass` now takes an invocation a
  texel (was a row), texels up to 16 bytes at any byte, and each channel's kind, so it extends signs and converts
  integers and floats. Vertex formats WebGPU lacks (three channels of 8 or 16 bits, scaled, BGRA's and the 10-bit packed
  ones of every type) always pull their binding (T5's fetch).
- **Confirming, failing first**: the 2,609 format cases (every 100th of the 260,518 in `vk-main.txt` naming one, without
  protected memory's) were 2,557 not supported, 52 passing, 0 failing; the driver's scenario 97
  (tests/venus-driver.test.ts "formats WebGPU has no texture of…") fails before the change (the images refused) and
  passes after. Planted: `packPass`'s sign extension left out (a round trip through a copy hides it: the bits come back
  masked) fails 10 of 12 `pipeline.monolithic.image` cases sampling the 10-bit SINT formats.
- **Found by the cases: scaled formats**. The first try kept a scaled format's integers as floats (rgba16float,
  rgba32float), sampled and filtered as the spec says (the shader's float sample of an integer converted). Of its 422
  failures (`swiftshader-scaled-as-floats.json`) ~370 were scaled: dEQP-VK's reference treats SCALED as UINT and SINT
  (tcu's channel types), so it samples them through `isampler`/`usampler` (a bind group refused: the float texture
  against an integer binding) and clears them with `int32` values (read as floats: 0). The spec and dEQP disagree, and
  no driver we know samples scaled images; so they are their integer twins' textures (the same bits: copies are plain or
  packed), offered for transfers only, their clears taking integers. Sampling scaled images isn't offered.

| set | host | pass | fail | not supported |
|---|---|---|---|---|
| formats (2,609) | SwiftShader, before | 52 | 0 | 2,557 |
| | SwiftShader | 1,522 | 47 | 1,040 |
| | M4 | 1,772 | 4 | 833 |
| vertex input (542: every other `single_attribute` naming one, every 40th of `multiple_attributes`, `multiple_bindings`) | SwiftShader | 296 | 0 | 246 (`shaderFloat16` 232) |
| | M4 | 528 | 0 | 14 |

  SwiftShader's 47 are its own, filed: the `count_8` compute cases binding 8 storage images (30), integer views with a
  base level (13), and 4 cube samples of `b8g8r8_snorm` and `r8g8_srgb` through a linear filter in a compute stage,
  whose `r8g8b8a8_snorm` and `r8g8b8a8_srgb` twins (run beside them) fail the same. The M4's 4 are its filed ones: copies
  from `e5b9g9r9_ufloat_pack32` (2) and dual-source blends with both blend constants (2). **The 1,733 that pass on
  both and weren't in the list join `tests/deqp/vk.txt`** (42,933 → 44,666): `pipeline` 1,194, `api.copy_and_blit` 410,
  `api.image_clearing` 99, the rest `api.info`, `texture.swizzle`, `renderpasses`; 488 more pass on the M4 only
  (`shaderFloat16`'s vertex cases, SwiftShader's own).
- **What's left not supported** on the M4 (833 of the format cases): scaled formats' sampling (most of the 347 "for
  sampling", by choice), a copy's other format or linear tiling (~180: linear tiling isn't offered for these),
  `VK_EXT_filter_cubic` (70), min/max reductions' component mapping (43, T25's), sample counts (26),
  `legacy_vertex_attributes` (20), blit destinations of formats not rendered to (12); sRGB vertex formats (14 of the
  vertex sample: no driver has them).
- **The copies' cost** (`bench/vulkan/t31/suite.ts`, `cost-*.json`: a 1024×1024 image's copy in and out through the
  worker's own imports, ms a copy, median of 10 samples of 20, back to back):

| | R8G8B8A8_UNORM (one copy) | R8G8B8_UNORM (in rgba8unorm) | B8G8R8A8_UINT (in rgba8uint) |
|---|---|---|---|
| M4, upload / readback | 0.196 / 0.152 | 0.386 / 0.366 | 0.380 / 0.370 |
| SwiftShader, upload / readback | 1.405 / 1.529 | 34.96 / 35.11 | 35.91 / 35.56 |

  On the M4 a converting copy costs ~2× a plain one (the pass and the temporary buffer's copy); SwiftShader runs
  compute on the CPU, 25× slower: what it costs a dEQP case, not a program.

## VK4 T30: D16_UNORM_S8_UINT and the packed formats left; 2,767 cases join the list

2026-11-06, the dev VM (SwiftShader, Chromium 155.0.8059.84) and the M4 (Metal, Chrome for Testing 157.0.8103.38,
`bench/gpu/sway-mac.sh`). JSON in `results/vk4/t30/` (`swiftshader-before.json`: the sample before any change;
`swiftshader-clears.json`: the 48 `a2r10g10b10`/`a2b10g10r10` UINT clear cases after the clear's fix;
`d16-reasons-swiftshader.json` and `packed-reasons-swiftshader.json`: dEQP's reasons for the cases the M4 still
doesn't support, D16S8's 342 and the others' 947).

- **What the device does** (vk/README.md "Packed formats", "Transfers"): `D16_UNORM_S8_UINT` is a depth24plus-stencil8
  texture whose depth is 16-bit unorm in buffers (the copy in draws from half words, the copy out a compute pass writing
  `round(depth · 65535)` as halves, so an uploaded texel comes back with its bits; a depth bias's constant ×256 into
  depth24plus's units). `A4R4G4B4` and `A4B4G4R4` (1.3, `VK_EXT_4444_formats` advertised), `A1B5G5R5` (maintenance5),
  `R4G4` (an `rg8unorm` texture) and `A2R10G10B10`'s UNORM and UINT (`rgb10a2unorm`, `rgb10a2uint`) are packed formats as
  T12's were: the texture holds the channels, and the worker's compute pass between buffer and texture now takes texels
  of 1, 2 or 4 bytes on either side, moving each channel's bits and scaling them where widths differ (`packPass`, one
  pipeline for both ways). A view of another format of the texel's size is a texture of its own, copied the same way.
- **Confirming, failing first**: the 4,197 cases of the sample (`cases.txt`: every 40th D16S8 case of the direct set,
  every 20th of the others', 141 s on SwiftShader) were 4,189 not supported and 8 passing before; the driver's scenario
  96 (tests/venus-driver.test.ts "packed formats WebGPU hasn't...") uploads and reads back each format, a copy of R4G4
  into R8, clears, and D16S8's depth and stencil whole, in part and image to image. Planted: a texel's byte offset by
  `& 2u` in the pass fails R4G4, D16's `· 65534` fails its depth.
- **Found by the cases**: Dawn cuts `rgb10a2uint`'s clear values to 8 bits a channel, which the driver already drew
  past for `A2B10G10R10_UINT`; `A2R10G10B10_UINT` shares the texture and now does too (its 5 attachment clears failed
  with blue 255 for 716; the scenario's load-op clear reproduced it).

| host | pass | fail | not supported |
|---|---|---|---|
| SwiftShader (before) | 8 | 0 | 4,189 |
| SwiftShader | 2,768 (+1 after the clear's fix) | 20 (19 after) | 1,409 |
| M4 | 2,906 | 2 | 1,289 |

  SwiftShader's 19 are its own, filed: the `count_8` compute cases that bind 8 storage images (12) and the integer
  `lod_base_mip_level` views (7). The M4's 2 are copies from `e5b9g9r9_ufloat_pack32` (its filed failure, Metal's
  canonical bits). **The 2,767 both pass join `tests/deqp/vk.txt`** (40,166 → 42,933): D16S8 1,020, R4G4 468,
  A1B5G5R5 374, A2R10G10B10 UNORM 334 and UINT 195, A4R4G4B4 202, A4B4G4R4 201; 139 more pass on the M4 only (SwiftShader
  lacks a pair's other format).
- **What's left not supported**, of D16S8's (342 on the M4): sample counts WebGPU lacks (2, 8, 16: 106), `depthBounds`
  and the feedback loop layout (70, T32's), the compute queue's depth formats (24, dEQP's own rule), image types the
  resolve tests skip (30), shadow sampling (17: `VK_FORMAT_FEATURE_2_SAMPLED_IMAGE_DEPTH_COMPARISON_BIT` isn't reported
  for any depth format: filed), depth bias's other representations (24, T28's); of the packed formats' 947 on the M4
  (`packed-reasons-swiftshader.json`), protected access 235, a copy's or blit's other format or linear tiling ~470 (T31's
  3-component, scaled and BGRA orders, the 10-bit SNORM and SINT ones), cubic filtering 101, min/max reductions'
  component mapping 73 (T25's), sample counts 18.

## VK4 T29: shader types — 8-, 16- and 64-bit integers, 16-bit inputs and outputs, gathers with offsets; 1,750 cases join the list

2026-11-06, the dev VM (SwiftShader, Chromium 155.0.8059.84) and the M4 (Metal, Chrome for Testing 157.0.8103.38,
`bench/gpu/sway-mac.sh`). JSON in `results/vk4/t29/` (`swiftshader-rerun.json`: the subgroup cases and the failures
again after the 64-bit reductions' fix).

- **What the device does** (vk/README.md "The shader path"): advertises `shaderInt8`, `shaderInt16`, `shaderInt64`,
  8-bit storage (buffers, uniform buffers, push constants; `VK_KHR_8bit_storage`, `VK_KHR_shader_float16_int8` now on
  every adapter), `storageInputOutput16` and `shaderImageGatherExtended`. An 8-bit value is a word's low byte, as a
  16-bit one is its low half (loads and stores of bytes of words, the arithmetic at 32 bits); a 16-bit input or output
  is a 32-bit one, converted where it's loaded and stored (`widen_io16`: before, a half's bits went into a 32-bit
  varying and were interpolated as nonsense); a 64-bit integer is a pair of words (`split_64bit_access` makes every
  memory access 32-bit, `nir_lower_int64`, `nir_lower_64bit_phis` and `nir_lower_alu` the rest, the options keeping
  `pack_64_2x32_split` whole: lowered, it became 64-bit shifts); a 64-bit subgroup reduction or scan, which WGSL's
  built-ins don't take, is shuffles of words (the five `subgroups.arithmetic.*_u64vec2` of mul, min and max failed with
  "64-bit values" until it was). Gathers whose offsets aren't constants were T24's fetches already.
- **Confirming, failing first** (tests/wgsl.test.ts, run on SwiftShader): 8-bit storage and arithmetic, 64-bit
  arithmetic, conversions, loads and stores, and 64-bit subgroup reductions failed to translate; a fragment stage's
  16-bit input worked on at 32 bits drew 0 for 16; each passes now. Planted: the bytes' shift by `& 2u` and the 64-bit
  split's second word at +4 fail the 8-bit test (224 values) and both 64-bit ones.
- **The cases** (`cases.txt`, 5,095: the census's 162 that asked for these, every 10th `glsl.texture_gather`, every
  8th `buffer_device_address`, every 5th 8- and 16-bit `ubo.random` and of the `ssbo` and `ubo` layouts' cases of the
  types, every `precision_fconvert`, every 4th typed `spec_constant`, every 10th 16-bit `vertex_input`, every 25th typed
  `spirv_assembly` and every 30th typed `subgroups` case; ~9 min as one list on SwiftShader):

| host | pass | fail | not supported |
|---|---|---|---|
| SwiftShader | 1,877 (751 before the features were advertised) | 21 | 3,197 |
| M4 | 2,019 | 14 | 3,062 |

  The failures: `precision_fconvert`'s f32 (and, with shader-f16, f16) to integer cases of values past the integer's
  range, on both hosts: WGSL's conversion clamps to the largest float under the bound (2147483520 for an i32), and
  Metal took an f16 infinity as 65504. Since fixed: the bound compared in f32, a half converted through
  `unpack2x16float` (tests/wgsl.test.ts "floats convert to 32-bit integers saturating exactly"; `fconvert-cases.txt`'s
  756: of those supported, 16 on SwiftShader and 37 on the M4, all pass; the 8 both pass that weren't in the list join it). On SwiftShader only, each passing on the M4: 9
  compute cube gathers, 2 dynamic-offset gathers of a view with a base level (its known fetch from a base level), a
  16-bit NaN through a vertex input that came back 69696, and `ssbo.layout.random.8bit.all_per_block_buffers.5`,
  which passes in 56 s without dEQP's watchdog (1 s on the M4). Filed (docs/backlog.md "What the device advertises,
  left for the translator"). Of the
  census's 166, 58 pass and 106 remain not supported, by what T29 doesn't take: vertex stores (T33), device addresses'
  capture and replay, set numbers past `maxBoundDescriptorSets`. **The 1,767 both pass, 1,742 of them not in the list
  before, join `tests/deqp/vk.txt`**, and 8 `precision_fconvert` cases after the fix below (→ 40,166; the subgroup cases pass on SwiftShader, but the Mac's subgroups are
  held, so they wait for the M4's). 

## VK4 T28: pipeline state as variants — dynamic vertex input, depth bias control, the third dynamic state, non-seamless cubes

2026-11-06, the dev VM (SwiftShader, Chromium 155.0.8059.84) and the M4 (Metal, Chrome for Testing 157.0.8103.38,
`bench/gpu/sway-mac.sh`). JSON in `results/vk4/t28/`.

- **What the device does** (vk/README.md "Commands", "Samplers in the shader"): every draw's pipeline is already keyed
  by the state it draws with, from the runtime's dynamic state, so the states WebGPU's pipelines hold can be dynamic:
  `VK_EXT_vertex_input_dynamic_state`, `VK_EXT_depth_bias_control` (the format's representation only), and
  `VK_EXT_extended_dynamic_state3` with the depth clamp and clip, sample mask, alpha to coverage, blend enables,
  equations and write masks and the provoking vertex. Alpha to coverage at one sample, which WebGPU refuses (it was
  dropped before, the static state too), is now the fragment stage's: an override discards a fragment whose location
  0's alpha is under a half (the census's `single_sample_alpha_to_coverage_enable` failed first and passes). A pipeline
  with alpha to coverage and no colour target at location 0, which WebGPU refuses, is made without it.
  `VK_EXT_non_seamless_cube_map`: a sampler with the flag and a linear filter keys its cubes' pairs, sampled from the
  faces' fetches, each texel kept on the sample's face and wrapped by U and V (tests/wgsl.test.ts "a non-seamless
  cube...", whose planted bug, the face wrap left out, fails it).
- **The census's cases** (222): 28 pass, 0 fail; the rest need what isn't offered: `VK_EXT_legacy_vertex_attributes`
  (82 of the 85 that asked for dynamic vertex input), `VK_EXT_primitive_restart_index` (16: the guest's Venus, Mesa
  26.2, doesn't pass it on, and WebGPU restarts only at the format's largest index), depth bias's other representations
  and `depthBiasExact` (31), and other extensions besides the third dynamic state (21).
- **The groups** (`cases.txt`, 7,956: every 4th `extended_dynamic_state` and `depth_bias_control` case, every dynamic
  `input_attribute_offset` case, every alpha-to-coverage and non-seamless filtering case, every 10th `vertex_input`
  case, the census's; 197 s as one list on SwiftShader):

| group (SwiftShader) | cases | pass | fail | not supported |
|---|---|---|---|---|
| extended_dynamic_state | 2,058 | 695 | 2 | 1,361 |
| depth_bias_control | 2,091 | 468 | 0 | 1,623 |
| input_attribute_offset, dynamic | 116 | 115 | 1 | 0 |
| alpha to coverage (the rest) | 194 | 10 | 6 | 178 |
| filtering.cube, non-seamless | 822 | 733 | 50 | 39 |
| vertex_input | 2,659 | 498 | 0 | 2,161 |

  The failures: the 50 cubes are nearest-filtered, nearest- or linear-mipmapped, U at clamp-to-border, and their
  seamless twins fail alike (WebGPU's own sample on SwiftShader, not the fetches: docs/backlog.md "Samplers'
  leftovers"); the 6 alpha-to-coverage ones (no colour attachment, an unused one, and `query_pool.discard`'s) failed
  before T28 too, their dynamic twins now alike; the 3 dynamic vertex inputs draw past a vertex buffer's end, which
  Vulkan's robust buffer access reads as zeros and WebGPU refuses (`input_attribute_offset.two_binds_vec4.*.dynamic`
  by design; `extended_dynamic_state.*_draws_dynamic.vertex_input_multiple_bindings`: a slot bound past its buffer's
  end, not looked into further). Since the run, a pipeline whose fragment stage writes `sample_mask` is made without
  alpha to coverage too (WebGPU refused it: `query_pool.discard`'s draws were dropped); those cases still fail.
- **The M4** (148 s): 2,525 pass, 59 fail, 5,372 not supported; its failures SwiftShader's but one each way
  (`alpha_to_coverage_unused_attachment.samples_4.alpha_invisible` on the M4 only), so the 50 cubes too. **The 2,262 both
  pass that weren't in the list join `tests/deqp/vk.txt`** (668 extended dynamic state, 468 depth bias control, 733
  non-seamless cubes, 115 dynamic attribute offsets, 41 alpha to coverage, 269 vertex input, a part of them passing
  before and unsampled; 256 were in it, none failing).

## VK4 T27: depth and stencil resolve modes — 2,503 cases join the list

2026-11-05, the dev VM (SwiftShader, Chromium 155.0.8059.84) and the M4 (Metal, Chrome for Testing 157.0.8103.38,
`bench/gpu/sway-mac.sh`, `VIRGL_GPU=virgl,vulkan`). JSON in `results/vk4/t27/`.

- **What the device does** (vk/README.md "Commands"): every resolve mode the spec allows is advertised, SAMPLE_ZERO,
  MIN and MAX of both aspects and AVERAGE of depth, with `independentResolve` and `independentResolveNone`; the
  worker's drawn resolve at the pass's end (web/venus-gpu.ts `resolveDepth`) folds the pixel's samples by the mode
  before writing `frag_depth` or keeping a stencil bit.
- **Confirming, failing first** (`confirm-cases.txt`, every 12th samples_4 case with a mode other than SAMPLE_ZERO and
  NONE, 258): with the modes advertised and the draws still sample 0's, 44 fail (`before-swiftshader.json`); with the
  draws', 0 fail, 171 pass.
- **Every samples_4 and misc `depth_stencil_resolve` case** (`cases.txt`, 3,823; 20 s as one list on SwiftShader):

| host | pass | fail | not supported |
|---|---|---|---|
| SwiftShader | 2,614 | 0 | 1,209 |
| M4 (12 s) | 2,574 | 40 | 1,209 |

  The not supported: `D16_UNORM_S8_UINT` (1,104, T30's) and geometry shaders (141). The M4's 40 are every
  `*_testing_stencil_samplemask` of D24S8 and D32S8, SAMPLE_ZERO's as well as MIN's: the M4's known stencil failure
  (docs/backlog.md "The M4's own failures", 4 of them before), not the modes. **The 2,503 both pass that weren't in the
  list join `tests/deqp/vk.txt`** (71 were).
- **Planted** (`planted-swiftshader.json`): MIN and MAX swapped and AVERAGE divided by one sample too many: 67 of the
  confirming list's 171 fail.

## VK4 T26: multi-draw — 1,344 cases join the list; the M4 fails `gl_DrawIndex` in a multi-draw indirect

2026-11-05, the dev VM (SwiftShader, Chromium 155.0.8059.84) and the M4 (Metal, Chrome for Testing 157.0.8103.38,
`bench/gpu/sway-mac.sh`, `VIRGL_GPU=virgl,vulkan`). JSON in `results/vk4/t26/`.

- **What the device does** (vk/README.md "Commands", "Multi-draw"): `VK_EXT_multi_draw` as a draw per element with its
  draw index; `multiDrawIndirect`, which the replay already drew a draw per record, each with its index (a place of the
  push buffer each where draw parameters are read, now reserved); `drawIndirectCount` and `VK_KHR_draw_indirect_count`
  as a compute pass before the render pass that copies `maxDrawCount` records and zeroes those past the count, each then
  an indirect draw of its copy (web/venus-gpu.ts `indirectCount`). The census's 203 cases that ask for any (196
  `VK_EXT_multi_draw`, 6 `drawIndirectCount`, 1 `multiDrawIndirect`), every `indirect_draw` and `shader_draw_parameters`
  case of `draw.*` and every 20th `multi_draw` one (`cases.txt`, 2,757):

| host | cases | pass | fail | not supported |
|---|---|---|---|---|
| SwiftShader (118 s as one list) | 2,757 | 1,495 | 0 | 1,262 |
| M4 (92 s) | 2,757 | 1,479 | 16 | 1,262 |

  The not supported: tessellation (585), geometry (293), vertex attribute divisors (176), robustness2's null descriptor
  (32). **The 1,344 both pass that weren't in the list join `tests/deqp/vk.txt`** (135 were). The M4's 16 failures are
  every `shader_draw_parameters.draw_index` case (one indirect op of three draws, each coloured by `gl_DrawIndex`): the
  quads are placed right but all read index 0 (`m4-draw-index-result.png` against `-reference.png`). A plain WebGPU page
  doing the replay's calls (copies into three 256-byte places of a uniform buffer before the pass, three drawIndirects
  with the group's dynamic offset set before each) draws right on the M4, so the cause is between the driver and the
  worker; filed (docs/backlog.md "The M4's own failures").
- **Planted** (`planted-swiftshader.json`): the count's gate left out of `indirectCount` and the draw index left out of
  direct draws: of 114 `indirect_draw_count` cases (every 3rd) and 192 multi-draw cases reading the draw id, 187 fail.

## VK4 T25: min/max reductions — 1,908 cases join the list; a reduced sample ~3.5× WebGPU's own

2026-11-05, the dev VM (SwiftShader, Chromium 155.0.8059.84) and the M4 (Metal, Chrome for Testing 157.0.8103.38,
`bench/gpu/sway-mac.sh`, `VIRGL_GPU=virgl,vulkan`). JSON in `results/vk4/t25/`.

- **What the device does**: `VK_EXT_sampler_filter_minmax` and `samplerFilterMinmax`, through T8's sampler keys and
  T18's filter from fetches (vk/README.md "Samplers in the shader"): a sampler with a MIN or MAX reduction and a linear
  filter keys its pairs (`wgsl_sampler_key.reduction`), and its samples come from fetches whose filter takes the
  component-wise min or max of the footprint's texels with non-zero weights, in a level and across the two a linear
  mipmap reads. Integer textures too (integer min and max: Vulkan lets a reduction filter one linearly); cubes from their
  faces (every sampled cube view now has the 2D array twin). Every sampled format has the `FILTER_MINMAX` bit;
  `filterMinmaxSingleComponentFormats`, and `filterMinmaxImageComponentMapping` where the browser has
  `texture-component-swizzle`. Test: `tests/wgsl.test.ts` "a min or max reduction…" (min, max, a texel of no weight
  left out, two levels, nearest; failing with the reduction planted out of `fetched_filter`).
- **The census's cases** (`census-cases.txt`: the 504 of its sample whose names or reasons are min/max's; 396
  NotSupported for min/max reasons before, all 504 not passing):

| host | cases | pass | fail | not supported |
|---|---|---|---|---|
| SwiftShader (17 s as one list) | 504 | 182 | 0 | 322 |
| M4 | 504 | 192 | 0 | 312 |

  The first SwiftShader run failed 26 cubes: their variants' layouts bound the faces, which only integer and depth
  cube views had. The not supported: 200 `filterMinmaxImageComponentMapping` (195 of the census's count) are dEQP's own
  refusal (`checkSupportImageSamplingInstance` throws for any reduction whose R mapping isn't identity, whatever the
  property), formats WebGPU lacks (76–88: 3-channel, scaled, A8, the 4-bit packed orders, R8_SRGB, D16S8; T30's and
  T31's), linear filtering's bit on depth formats (5) and, on the M4, R16_UNORM and SNORM (2), 3D compressed and depth
  (9) and 3D ASTC (20, T35's).
- **Every 10th of the list's reduction cases** (`tenth-cases.txt`: 3,057 of the 50,940 in `pipeline.monolithic.sampler`,
  without the B and ONE mappings dEQP always refuses):

| host | cases | pass | fail | not supported |
|---|---|---|---|---|
| SwiftShader (78 s) | 3,057 | 1,797 | 0 | 1,260 |
| M4 (72 s) | 3,057 | 1,864 | 0 | 1,193 |

  The not supported are formats again (sampling 879–980, linear filtering 72–106, an image format 5, 3D compressed or
  depth 96, 3D ASTC 107).
  **The 1,908 cases SwiftShader passes of both runs (the M4 passes them all) join `tests/deqp/vk.txt`**, in mustpass
  order at the end.
- **The cost** (`cost/`): `cost/sample.comp`, 16 linear-mipmapped samples (LOD 0.4, two levels) an invocation over a
  512×512 dispatch of a 512² RGBA8 texture, translated once against a key that averages (WebGPU's `textureSampleLevel`,
  2.4 KB of WGSL) and once with MAX (8 `textureLoad`s and the LOD's arithmetic, 10.4 KB), timed in headless Chromium as
  alternated rounds of 10 dispatches to `onSubmittedWorkDone` (an ad-hoc page; median of 7 rounds, of 5 on SwiftShader):

| host | average (ms a dispatch) | max | × |
|---|---|---|---|
| M4 | 0.140 (0.13–0.22) | 0.490 (0.45–0.74) | 3.5 |
| SwiftShader | 10.87 (10.20–11.10) | 34.90 (34.23–35.57) | 3.2 |

  Only a pair whose sampler reduces pays; no replayed program has one (vkd3d's 12_0 asks for the feature).

## VK4 T24: maintenance5, 6 and 8 — 360 cases join the list; maintenance8's 2,246 pass through Mesa 26.3's Venus

2026-11-05, the dev VM (SwiftShader, Chromium 155.0.8059.84) and the M4 (Metal, Chrome for Testing 157.0.8103.38,
`bench/gpu/sway-mac.sh`, `VIRGL_GPU=virgl,vulkan`). JSON in `results/vk4/t24/`; the census's cases asking for each
(`m56-cases.txt`: maintenance5's 454, 6's 234; maintenance8's 34 there, its whole groups below).

- **maintenance5 and 6** were mostly there: the driver had the `*2` commands, index buffer ranges, `VkBindMemoryStatus`
  and `VK_REMAINING_ARRAY_LAYERS` in copies, and Mesa's runtime takes shader modules chained to a stage and the flags2
  words. Added: `vkGetDeviceImageSubresourceLayout`, the two extensions' properties (no early fragment tests, so the
  sample-counting ones false; a swizzle of ONE on depth reads 1; a 3-plane format's 3 descriptors). Before, all 688
  NotSupported; after:

| host | cases | pass | fail | not supported |
|---|---|---|---|---|
| SwiftShader (25 s as one list) | 688 | 360 | 1 | 327 |
| M4, the 360 | 360 | 360 | 0 | 0 |

  The not supported are formats: A8_UNORM 81 and A1B5G5R5 70 (maintenance5's own, not offered: no WebGPU format;
  A1B5G5R5 is T30's), and others WebGPU lacks (3-channel, scaled, compressed 1D: 175), and robustness2's null index
  buffer (1). The failure is `memory.binding.maintenance6.aliasing.suballocated.image_*` (9 of 9 of the group,
  `m6-memory-swiftshader.json`): aliased images, the backlog's "Memory" gap, not maintenance6's. **The 360 join
  `tests/deqp/vk.txt`** (`binding_model.shader_access` 227, `api.copy_and_blit` 67, `pipeline` 60 (57 border swizzles of depth and stencil
  with `with_swizzle_hint`, 3 `dynamic_offset`), the rest 6; 30,039 → 30,399).
- **maintenance8 needs the guest's Venus too**: Mesa 26.2's (the tests' guest's 26.2.5; the port's newest 26.2.6)
  leaves `VK_KHR_maintenance8` out, 26.3's passes it on. `images/deqp/venus-icd.sh` builds 26.3.0-rc3's Venus in the
  Arch container and puts it on a copy of dEQP-VK's disk; deqp-run.ts's `DISK2` and `GUEST_ENV` run deqp-vk through it.
  What the device does for it: offsets that aren't constants (the `Offset` operand) move a fetch, and every sample,
  gather or shadow sample with one comes from the fetches' filter (`wgsl_sampler.c` `dynamic_offset`: the offset in
  texels of each level read); depth and stencil copied with a colour image of their texels' size through a buffer
  (`colorDepthStencil`, on the depth and stencil copies VK3 L6b made); blits between an array's layers and a 3D image's
  slices, a layer a slice (they drew every slice from each layer). SRem and SMod were already SPIR-V's. The groups
  (every `*_pcoffset` case but sparse, every `ds_color_copy` case, every blit between `2d_array` and `3d`):

| host | cases | pass | fail | not supported |
|---|---|---|---|---|
| SwiftShader (55 s + 93 s) | 3,642 | 2,246 | 0 | 1,396 |
| M4, every 4th of `pcoffset` and `ds_color_copy`, every blit | 1,130 | 790 | 0 | 340 |
| M4, the rest | 2,512 | 1,482 | 0 | 1,030 |

  The first sample's one failure, `textureprojlodoffset_pcoffset.*sampler2dshadow_fragment`, was a pipeline WebGPU
  refused: without a key a shadow sample took `plain_key`'s NEVER, which folded the texture away, so the stage's own
  module (whose bindings make the program's layout) had no group 0 while its keyed variant bound one; it now compares
  LESS_OR_EQUAL there. The not supported: depth and stencil copies on transfer and compute queues (maintenance10's),
  minLod clamps (`shaderResourceMinLod`), D24 and D16S8 formats. The M4's 2,272 passes hold SwiftShader's 2,246 (26 more its formats). **SwiftShader's passes are
  `tests/deqp/vk-maintenance8.txt`**,
  run by hand until the guest's Mesa is 26.3 (docs/backlog.md).
- **Tests** (each failing with its rule planted out): `tests/wgsl.test.ts` "offsets that aren't constants" (a fetch, an
  explicit LOD at level 1, gradients, a gather, run on Chromium's WebGPU; the keyless shadow keeps its texture);
  `tests/venus-driver.test.ts` "misc: depth and stencil copied with colour images…" (wg_test.c 95: D32 ↔ R32_SFLOAT,
  S8 ↔ R8_UINT, layers ↔ slices). Not measured: what a fetched sample costs against WGSL's own; no program here has a
  dynamic offset (vkd3d's D3D12 layering asks for them).

## VK4 T23: what the emulations cost Godot's GI demo — SDFGI's rgb9e5 views copied ~34 MB a frame, now decoded in the shader

2026-11-05. Godot 4.7.2's GI demo as it starts in SDFGI mode, vsync off (bench/vulkan/godot-disk.sh's `gi-sdfgi`; with
SSAO and SSIL, `gi-sdfgi-ssil`), in the desktop guest (4 vCPUs, 6 GiB), `?gpu=vkgputime`, on the M4 (macOS 26.6.2,
Chrome for Testing 157.0.8103.38) and the user's NVIDIA desktop (RTX 3070, driver 615.78.08, CachyOS, Chromium
156.0.8078.73 headed: nvidia.sh's `t23` step, bundle d12de9e2). JSON: `results/vk4/t23/` (`m4-a`, `m4-b`, `nvidia`,
`m4-fix-*`).

**The method** (bench/vulkan/t23.ts). The driver and the worker count each emulated path's work (vk/README.md "What
the emulated paths do"; the render stats' `venusEmul`), and `?gpu=vkskip=<path>` leaves out the work of those that
can be left out without a command WebGPU refuses (the copies between view formats, to and from words, a feedback
loop's; the worker's blits and resolves), switched in the run (`window.__webpcVkSkip`): one Godot, settled after its
first frame, arms alternated, 12 s each, medians of the rounds (2 on the M4, 3 on NVIDIA). Shadows, pulled vertices
and keyed variants have no skip (WebGPU would refuse their draws): their counts say what they do. `done` is a submit's
time from `queue.submit` to WebGPU's done: its GPU work.

**What the demo meets, a frame** (the same on both GPUs, in every arm but the one that skips it):

| path | `gi-sdfgi` | `gi-sdfgi-ssil` |
| --- | --- | --- |
| copies between view formats | 9.3, **34 MB** | 9.3, **34 MB** |
| usage scopes' shadows | 8.3, 0.22 MB | 8.3, 0.22 MB |
| draws and dispatches through a keyed variant | 7.4 | 30 |
| words, feedback loops, pulled vertices, prepasses, blits, drawn resolves | 0 | 0 |

The copies were SDFGI's: images Godot writes as `r32uint` storage and samples through `rgb9e5ufloat` views, which
WebGPU can't view one as the other, so each frame each was copied whole into its alias: three or four 128³ volumes
(8 MiB each) and six layers of a 2312×136 array (1.2 MiB each); once, at the start, a 256×128×384 `r16uint` volume
read as `rgba8unorm` (a trace in a throwaway build).

**What they cost:**

| | M4 frames/s | M4 done ms | NVIDIA frames/s | NVIDIA on screen/s | NVIDIA done ms |
| --- | --- | --- | --- | --- | --- |
| `gi-sdfgi`, as it was | 39.7 | 11.33 | 31.7 | 33.4 | 16.90 |
| view copies left out | 39.9 | **9.85** | **35.4** | **37.0** | **14.16** |
| words, feedback or meta left out | 36.8–37.5 | 11.34–11.39 | 31.3–31.6 | 33.1–33.3 | 16.95–16.99 |
| all left out | 40.8 | 9.93 | 33.1 | 36.9 | 14.08 |
| `gi-sdfgi-ssil`, as it was | 36.8 | 13.74 | 29.9 | 31.1 | 18.02 |
| view copies left out | 37.6 | **11.98** | **33.5** | **34.4** | **15.22** |
| words, feedback or meta left out | 36.0–36.2 | 13.29–13.44 | 29.2–29.9 | 30.9–31.2 | 17.84–18.01 |
| all left out | 38.4 | 11.77 | 32.7 | 33.9 | 15.40 |

- **The view copies were the one cost**: 1.5–1.8 ms of each submit's GPU time on the M4, 2.7–2.8 ms on NVIDIA, and
  on NVIDIA +12% frames/s left out (each arm's rounds apart in `done` on both: NVIDIA's 13.7–14.2 against
  16.1–17.1). The M4's frame rate is paced by the guest's CPU (Godot ~55% of one) and moves within its noise. The
  pictures with and without them look alike (the volumes change slowly).
- **The rest is small or none**: the shadows' 0.22 MB a frame; no words, feedback loops, pulling, prepasses, blits
  or drawn resolves in either mode. The keyed variants' cost is in their shaders, not separable without a skip; their
  passes' timed GPU ms are the same in every arm.
- **No freeze** on either GPU (every second had a Vulkan frame on the page's screen), nor any WebGPU error; GD's
  freezes on NVIDIA didn't show in these modes in ~10 minutes each. On NVIDIA the device address buffer grew to 1 GiB
  (docs/backlog.md "Godot on Venus, GD's leftovers").

**The fix.** An E5B9G9R9 view of an R32_UINT or R32_SINT image is now a view of the image's own texture, its pairs
keyed: the translator fetches the words, decodes them and filters as for a padded image (vk/README.md "Views in
another format"; driver test 94, failing before). The copies are gone; on the M4, alternated sessions against the old
copies (`?gpu=vkskip=rgb9e5`, 2 sessions of 3 rounds each; `m4-fix-*`):

| `gi-sdfgi` on the M4 | frames/s (range) | done ms a submit (range) | keyed draws a frame | view copies a frame |
| --- | --- | --- | --- | --- |
| decoded | 41.5 (37.6–44.1) | 11.32 (10.61–11.75) | 15 | 0 |
| copied, as before | 41.1 (35.2–44.1) | 11.50 (11.33–11.77) | 7.5 | 9.6, 35 MB |

On the M4 the decode's fetches (up to 8 a sample in 3D) cost about what the copies did: no gain there that the
ranges show, ~30 MB of alias textures fewer. On NVIDIA the copies cost 2.8 ms of a 17 ms submit; the decode's gain
there is for the next NVIDIA run (nvidia.sh's `t23` step now ends with the copies back, `t23-copies`).

## VK4 T22: queue families of compute and of transfer — 1,465 of the sample's 2,590 cases join the list; mpv the same

2026-11-05. The device has three queue families now, a queue each: graphics, compute and transfer; compute and
transfer; transfer. Every queue is the WebGPU device's one, so their submits have one order, ownership transfers
between families are no-ops and a semaphore between queues is met by that order (vk/README.md "The driver"). What it
took: submits held for a wait not yet met (VK3 L6a) held every later submit of the device, so a submit of the compute
queue that signals what a held graphics one waits for waited behind it for ever (`tests/venus-driver.test.ts`
"a held submit of the graphics queue runs once the compute queue signals what it waits for": a timeout before); now a
held submit holds its own queue's alone, and is retried after every submit that runs. One queue's order also kept a
binary semaphore's wait behind its held signal, which another queue's wait isn't any more: it is held with it ("the
compute queue's wait on a binary semaphore a held submit signals waits for it"). Each test fails with its rule planted
out. Venus's guest binds each queue to a ring of its own (vkr's `ring_idx`), whose fences retire through that queue: a
fence of one queue no longer waits for another queue's held submits, as Vulkan has it. `?gpu=vkqueues=1` gives the
first family alone (A/B). JSON in `results/vk4/t22/`.

- **The reason's cases**: the census's sample has 2,590 cases NotSupported for a queue (1,984 "no matching queue" of
  compute without graphics, 554 "exclusive compute queue", 63 a transfer-only one; `cases.txt`). Run once advertised:

| host | pass | fail | not supported (other reasons) |
|---|---|---|---|
| SwiftShader (Chromium 155.0.8059.84; 83 s as one list) | 1,466 | 166 | 958 |
| M4 (Chrome for Testing 157.0.8103.38) | 1,812 | 1 | 777 |

  SwiftShader's 166 are its own: every case of a compressed format sampled in a compute stage (123; their fragment
  twins pass there, and the M4 passes them all), `count_8`'s 8 storage images past the 4 it advertises (35; dEQP doesn't
  check the limit), and its fetch from a view with a base level (7; filed before). The M4's one is
  `texture.mipmap.cubemap.basic.nearest_nearest_linear_clamp_compute` (its fragment twin passes:
  `m4-cube-compute.json`). Filed (docs/backlog.md). **1,465 pass on both and join `tests/deqp/vk.txt`** (pipeline
  1,331, texture 55, api 48, ubo 22, glsl 8, memory 1; the list 28,575 → 30,040 cases).
- **mpv** (libplacebo takes a dedicated compute and transfer queue where there is one): Sintel's H.264 trailer with
  VA-API (`bench/audio/avsync.ts` through `bench/gpu/sway-mac.sh`, `--vo=gpu-next --gpu-api=vulkan`, `WARM_S=8`,
  `PHASE_S=20`, the desktop guest, 4 vCPUs) on the M4, the three families against `vkqueues=1` in alternated sessions,
  2 rounds: frames 529, 524 against 528, 529, **none dropped** in any; the guest 11% busy in all four; mpv's `vo` thread
  149, 148 against 153, 149 ms a second; 624 `SUBMIT_3D`s a second each way (`mpv-mac-*.json`). No change.

## VK4 T21: the census's failures — a parameter table a group, 16-bit normalized resolves drawn, `&` for booleans; 861 cases join the list

2026-11-05. The census's five failures (the section below) and its new passes, on the dev VM's SwiftShader (Chromium
155.0.8059.84) and the M4 (Chrome for Testing 157.0.8103.38, macOS 26.6.2, `bench/gpu/sway-mac.sh`). JSON in
`results/vk4/t21/`.

- **`descriptorset_random.sets4`'s two** (a fragment stage's output read as zeros): their pipelines were refused at
  creation, "the fragment stage binds 16 uniform buffers, past WebGPU's 12 (of them: 12 texel buffers' parameters)":
  each texel buffer's parameters were a uniform buffer of their own. They are one **parameter table** a group now, a
  uniform buffer at binding 994 holding every texel buffer's and storage image as words' two vec4s at its binding
  (vk/README.md "Texel buffers"; `tests/venus-driver.test.ts` "nine uniform texel buffers beside four uniform buffers",
  refused before: 9 words and 2 folded uniform buffers were 12 storage buffers). The two cases then meet the next
  limit, their 12 to 16 texel buffers' words as storage buffers (WebGPU's 10 here), and so does all of the group:
  `sets4` whole (14,106 cases) went 290 → 291 passing, **all 165 failures left being such refusals** (texel buffers'
  words; uniform buffers and inline uniform blocks folded past the advertised two), filed (docs/backlog.md "Texel
  buffers") with the ways out.
- **The M4's multisampled `self_dep` passes of the 16-bit normalized formats**: WebGPU refused the submit, "the resolve
  target format (RG16Snorm) does not support being used as resolve target" (`m4-self-dep-before.json`; the unorm ones
  too, which the census hadn't sampled). texture-formats-tier1's `r16`, `rg16` and `rgba16` `unorm` and `snorm` render,
  blend and multisample but don't resolve: their resolves are the worker's draws now, at a pass's end and for
  `vkCmdResolveImage`. All 1,374 multisampled cases of those formats in `renderpasses`' formats and resolve groups and
  `pipeline.monolithic.multisample`: **438 pass on the M4, none fail** (`m4-norm16-ms-after.json`); SwiftShader has no
  tier1, so all are NotSupported there and none joins the list.
- **`ssbo.corner_case.long_shader_bitwise_and` on SwiftShader**: 40 s with the watchdog off, of which the translator
  took 0.12 s and the pipeline's compile the rest (`long-shader-nowatchdog.json`). The shader is 589 `ivec4` loads
  through a device address and an AND of their compares; the WGSL, compiled alone (`long-shader-compile.json`):

| the WGSL | `createComputePipelineAsync` on SwiftShader |
|---|---|
| as printed before (`&&`, `||`) | 31.6 s |
| booleans as `&` and `|` (now) | 26.4 s |
| the same, Dawn's robustness off | 26.1 s |
| one `u32` load a vec4 instead of four | 3.1 s |
| no loads | 0.1 s |

  WGSL's `&&` short-circuits, a branch each in Tint's output; NIR's `iand` of booleans evaluates both, so `&` is
  exact. The rest is SwiftShader's compile growing faster than the loads: 2,356 `u32` loads of the address buffer.
  Filed (docs/backlog.md "SwiftShader compiles zero-initialized workgroup memory slowly", its "also slow"): a vec4 view
  of the address buffer for 16-aligned loads would make them one each. The M4 passes it in 3 s.
- **861 sampled cases that pass on both hosts** (pipeline 405, api 299, ssbo 65, renderpasses 47, ubo 25, binding_model
  11, texture 7) pass as one list on SwiftShader in 95 s (`census-861-swiftshader.json`) and join `tests/deqp/vk.txt`
  at its end (27,714 → 28,575 cases).

## VK4: the census again — 0.2% of the M4's supported cases fail, 0.9% of SwiftShader's; what's left is what isn't advertised

**2026-11-05**, at the user's ask, after T2–T19, R1–R7 and GD. JSON in `results/vk4/census2/` (`swiftshader/`, `m4/`: one
file a boot; `census.json`: the failures by cause). T1's sample exactly (every 100th case of `vk-main.txt`, 16,489, as
four boots of `bench/gpu/deqp-run.ts vk` at `STRIDE=400`, `OFFSET` 0, 100, 200, 300), with `DETAIL=20000
DETAIL_NOTSUPPORTED=1` so one run gives the failures' messages and the NotSupported reasons; on the dev VM's SwiftShader
(Chromium 155.0.8059.84, 111–170 s of deqp-vk a boot) and on the M4 (Chrome for Testing 157.0.8103.38, macOS 26.6.2,
68–83 s) through `bench/gpu/sway-mac.sh` with `VIRGL_GPU=virgl,vulkan` (its default, `virgl-null`, has no Vulkan: deqp-vk
then stops at `vkEnumeratePhysicalDevices`, `VK_ERROR_INITIALIZATION_FAILED`, in a second). Classed by
`bench/vulkan/census.ts`; the reasons by its new `--reasons`.

| host | cases | pass | fail | crash | not supported | not passed of supported | T1 (2026-10-29) |
|---|---|---|---|---|---|---|---|
| SwiftShader | 16,489 | 3,657 | 34 | 1 | 12,797 | 35 of 3,692 (0.9%) | 500 of 2,948 (17.0%) |
| M4 | 16,489 | 4,098 | 10 | 0 | 12,381 | 10 of 4,108 (0.2%) | 545 of 3,296 (16.5%) |

- **The failures** (each already filed but two): SwiftShader's 32 `image_view.*.subresource_range.lod_base_mip_level*`
  of integer and padded ASTC formats are its fetch from a view with a base level (backlog; the rules file them under
  T8 and T18, whose causes they aren't); the M4's 5 `blend.dual_source` with both blend constants (backlog
  "Rendering"); `descriptorset_random.sets4`'s 2 on **both hosts** now (T1 saw them on the M4 only: "Failure in copy
  buffer, ptr[0] = 0", a fragment stage's output read as zeros), so SwiftShader can debug it in CI's own host; **new**:
  the M4's 3 multisampled `self_dep` passes of `r16g16_snorm` and `r16g16b16a16_snorm` (input attachments of their own
  pass, 4 samples; the unorm and float ones pass), and SwiftShader's `ssbo.corner_case.long_shader_bitwise_and` past
  dEQP's 30 s watchdog (3 s on the M4: the pipeline's compile on SwiftShader).
- **861 cases of the sample pass on both hosts and aren't in `tests/deqp/vk.txt`** (`pipeline` 405, `api.copy_and_blit`
  230, `api.image_clearing` 67, `ssbo.phys` 44, `renderpasses` 45), all of groups the tasks' lists sampled; 443 more
  pass on the M4 only (formats SwiftShader's Vulkan lacks). No case of the list failed on either host.
- **75% of the sample isn't supported on either host**, so that is where cases are left: by dEQP's reasons on the M4
  (12,373 of its 12,381; SwiftShader's alike, with 418 more for its formats):

| reason (the M4's) | cases | what would back it | task |
|---|---|---|---|
| a queue family with compute and without graphics (1,984 "No matching queue", 541 "Exclusive compute queue") | 2,525 | a second family over the same WebGPU queue | T22 |
| formats not supported for sampling (1,559), transfer, as a source or destination (711), blending (82), vertex input (45), linear filtering (43) | ~2,450 | wider textures, packed and unpacked by copies (T12's packed formats' way) and decoded in the shader | T30, T31 |
| `D16_UNORM_S8_UINT` (353 "Unsupported depth/stencil format") | 353 | a depth32float-stencil8 texture with its copies converting | T30 |
| `VK_KHR_maintenance5`, `6`, `8`, `10` | 756 | host-side mostly; maintenance8's texel offsets that aren't constants in the translator | T24 |
| min/max filtering (`filterMinmaxImageComponentMapping` 195, formats 150, `VK_EXT_sampler_filter_minmax` 51) | 396 | T8's filter from fetches, the min or max of the texels | T25 |
| `VK_EXT_multi_draw` | 196 | a draw per element | T26 |
| depth and stencil resolve modes (130, 46, `independentResolveNone` 19) | 195 | T10's drawn resolves | T27 |
| what reads its own attachment: `VK_KHR_dynamic_rendering_local_read` 97, `multisampled_render_to_single_sampled` 95, advanced blends 94, `depthBounds` 113, `attachment_feedback_loop_layout` 48, logic ops 16 | 463 | T12's feedback copies in a cut pass; a multisampled texture resolved at the pass's end | T32 |
| pipeline state: `vertex_input_dynamic_state` 85, `depth_bias_control` 81, `extended_dynamic_state3` 23, `primitive_restart_index` 16, `non_seamless_cube_map` 17 | 222 | pipeline variants; a seamless cube's filter in the shader | T28 |
| shader types: `storageInputOutput16` 89, 8-bit storage 17, `shaderImageGatherExtended` 31 | 137 | the translator's lowerings (16-bit ones exist for storage) | T29 |
| writable storage in the vertex stage (76, 87, 25, 18, 16 by descriptor type) | 222 | the vertex stage as a compute pre-pass (transform feedback's way) | T33 |
| tessellation 172 + 21 + 21, geometry 86 + 70 | 370 | compute pre-passes too (tier 4) | T33's way |
| mutable descriptor types | 143 | a bind group layout per written set of types | T34 |
| `VK_EXT_texture_compression_astc_3d` | 187 | decoded to RGBA8 at upload | T35 |
| pipeline statistics queries | 188 | none in WebGPU (counters in shader variants could give a few, clipping none) | — |
| protected access 630, cooperative matrices 538, ray tracing ~180, mesh shaders 33, tile images 55, fragment density 33, shading rate 21, descriptor buffers and heaps 81, sparse 40 | ~1,600 | out of WebGPU's reach | — |

- **What changed since T1's reasons**: custom border colours (151), mirror-clamp-to-edge (149), border colour swizzles
  (104) and LOD biases past the limit (108) are gone (T8); the reasons that name a format went 4,310 → 3,681 (T1's
  section rounded a narrower count of them to ~2,000), the queue family's 2,427 → 2,525.

## GD G7–G8: X11's windows (the prime blit's buffers shared) and the window that capped mapped memory

2026-11-04, the dev VM (SwiftShader, Chromium 155), the tests' Debian rebuilt with Xwayland and python3
(images/debian-vulkan/build.sh) and the desktop image with Xwayland (Mesa 26.2.6). JSON: `results/gd/g7/`,
`results/gd/g8/`.

**X11 (G7).** Mesa's X11 WSI takes the prime blit in our guest for every client (its same-GPU check knows PCI only; our
virtio-gpu is virtio-mmio): Godot's editor on the user's NVIDIA desktop, X11 by default where Xwayland is installed,
was black. With the prime blit's buffers shared (vk/README.md "Presentation"):

| | before | after |
| --- | --- | --- |
| `tests/venus-share.test.ts`, a buffer source (256-byte and tight rows) | fails (no texture) | byte for byte, once each write |
| vkcube `--wsi xcb` through Xwayland on a GLES sway (the page test's `X11`) | black (VK3 L1's path) | 74–75% clear colour, frames differ; 538–545 frames copied from buffers |
| Godot 4.7.2's editor, `mobile` project, X11 (`prime_blit=1` 4×, `VN_DEBUG=wsi`) | black on NVIDIA (the user's run) | its 3D viewport draws (`godot-editor-x11.json`) |

**The window (G8).** Godot's GI demo in the editor failed on the user's machine with "Couldn't map buffer memory
(VkResult error -2)". Linux's virtio-gpu gives each mappable blob its place in the host-visible window when the blob is
made and keeps it until the blob's end; Venus makes a memory's blob at its first map. So the window (256 MiB, Venus's
rings in it too) capped the host-visible memory mapped at once, and VMA, which takes 128 MiB blocks on our 1 GiB heap
and keeps them mapped, met it at its second or third. `tests/venus/vkmap.py` (6 memories of 128 MiB, each mapped and
kept, written whole):

| window | mapped | the first failure |
| --- | --- | --- |
| 256 MiB (`window-256.json`) | 1 of 6 | memory 1: `vkMapMemory` -2, Godot's error |
| 1,280 MiB (`window-1280.json`) | 6 of 6 | — |

The window is now 1,280 MiB (the heap whole and 256 MiB), `vm::MAX_WINDOW` 2 GiB; node 1's RAM in memory 1 at most
1,536 MiB (was 2,560), the rest in later spill memories. **On the user's NVIDIA desktop** (this build, by hand) the
demo failed with out-of-memory errors before the change and opens and runs at 60 frames/s with it, no obvious glitches
(not every reflection-probe and lighting mode tried). On SwiftShader
(`gi-editor-swiftshader.json`) Godot leaves Forward+ (16 textures) and the editor stayed black at a wall of ours met
first, the device's address buffer (every memory allocated with a device address, in one GPUBuffer that doubles by
copy) growing 256 → 512 MiB, which SwiftShader's Vulkan refused (`vkAllocateMemory failed with
VK_ERROR_OUT_OF_DEVICE_MEMORY` in Dawn's `CreateBuffer`), every later command using it invalid. docs/backlog.md "Godot on Venus, GD's leftovers" has
the next steps.

**The screen-space effects.** With SSAO/SSIL on (the demo outside the editor, on NVIDIA), WebGPU refused a bind group,
an `r8unorm` view where the layout said `rgba8unorm` (a stage declares a written image rgba8; Godot binds an R8 view,
which native drivers write as the view's format), and the guest's whole display froze until that Godot was killed.
Such an image now takes a variant for the view's format (vk/README.md "Storage images without a format"; driver test
89, failing before); on the user's desktop the effects draw and nothing freezes.

**SDFGI over the level.** In SDFGI mode WebGPU refused a bind group: an 8-layer 2D array view (640×640 RGBA16F)
where a compute stage declares a 2D texture. G4 bound one-layer views so; any such view now binds its base layer, as
native drivers read it (driver test 90, the user's error before). No error since on the user's desktop; the mode
still freezes the display at times, and Godot's window is sometimes black (Wayland too): docs/backlog.md "Godot on
Venus, GD's leftovers", for VK4's T20 first (T23 since 2026-11-05).

## GD G4: SDFGI's stall on the M4 — Playwright's Chrome 153.0.8010.12 clobbered an indirect dispatch's immediates

2026-11-04. With G4's storage images bound, Godot's `sdfgi` scene (bench/vulkan/godot-disk.sh: a floor and a box, a
sun with shadows, SDFGI on) never finished its first frame on the M4: the GPU at 100%, the browser's GPU processes
stuck exiting, only a restart of the Mac freeing it. JSON: `results/gd/g4/stall.json` (each run below; the Mac's GPU
sampled every 2 s by `ioreg`); the runs' logs stay in `bench/results/local/godot-mac-g4*`.

**The method.** Two debug patches, never committed: the printer gave every loop a counter of its own and a `break`
past a cap (a function `var` a loop, so a barrier loop's exit stays uniform: Godot's 76 stages with loops all compiled
so), and the GPU worker gave every render and compute pass a command buffer of its own, submitted in turn at the submit
(after every `queue.writeBuffer` the submit makes: submitting a pass as it ended, as an earlier hack did, ran it before
the writes of later commands and failed 45 driver tests), logged with its time to done, and stopped submitting once a
submit was 3 s late. With the cap the scene drew and the Mac recovered from every run; the pass's time then said which
loop ran to its cap:

| run (Chrome for Testing 153.0.8010.12) | direct-light pass (ms a frame) |
| --- | --- |
| every loop at 4,096 | 12.4 |
| every loop at 65,536 | 116 |
| only loop 6 (the shadow march) at 65,536 | 12.3 |
| loops 0–4 at 65,536 | 115 |
| only loop 4 (the light loop) at 65,536 | 115 |

Loop 4 is `sdfgi_direct_light.glsl`'s `for (uint i = 0; i < params.light_count; i++)`, `light_count` push word 5. The
worker set it to 1 (logged), the indirect arguments were sane (1–59 workgroups); the shader read 0xffffffff.

**The cause.** `bench/vulkan/imm-probe.ts` (a page: 12 immediate words read back by direct and indirect dispatch): on
the M4 with Chrome for Testing 153.0.8010.12, Playwright 1.63's, an indirect dispatch reads its first six words as
`0xffff 0 1 0 0 0xffffffff`; a direct one reads them right; `num_workgroups` makes no difference. 153.0.8010.52 (153's
release), 154, 155, 156, 157.0.8103.38 (stable) and 159 (canary) read them right, sandbox on or off. A bug of that
early build, not ours: the Mac's runs now use the current Stable Chrome for Testing (bench/mac-chrome.sh).

**On Chrome for Testing 157, no debug code:** the scene's first frame comes ~41 s after the splash (its pipelines'
compile), then 44 s of frames at the screen's rate with no gap over 54 ms; the direct-light pass takes 0.02 ms (with
the cap's timing patch); the editor on the Forward+ project draws its 3D viewport ~35 s after it starts, then 82 s with
no gap over 757 ms, and nothing aborts. The GD bar holds on the M4.

## GD G2: Godot's shader modules — Tint's uniformity analysis over 13,000 vars; 3.7 s → 65 ms on the M4

2026-11-03. Each of the 209 stages Godot 4.7.2's editor hands Venus (its scene's 174 among them: SPIR-V dumped on
lavapipe through the Mac profile, GD-KICKOFF.md 4) translated by the native translator (`vk/build.sh native`) and its
WGSL's `createShaderModule` timed to `getCompilationInfo`'s answer on a device of its own (`bench/vulkan/tint-time.ts`;
on the Mac `bench/vulkan/mac-tint-time.sh`), on the dev VM's SwiftShader (Chromium 153.0.8010.52, the translator for
its features: `WGSL_DEVICE=19,1`, no shader-f16) and the M4 (Chrome for Testing 153.0.8010.12, Metal, `27,1`). The GPU
process keeps what it parsed by the text, so each run of a module carries a comment of its own. JSON in `results/gd/g2/`.

**Where the time went.** Tint's uniformity analysis (Dawn's `src/tint/lang/wgsl/resolver/uniformity.cc`, read at
Chromium 153's branch, chromium/8010) visits every function-scope `var` in scope at each `loop`, `break`, `continue`
and `if`, making a node and an edge for each (a break also walks each var's statement up to the loop). The printer
declared every value and register a `var` at the function's top: the Forward+ scene fragment stage has 13,113 of them,
218 loops, 220 breaks and 454 ifs, nested 30 deep. `let`s never enter that set. Building Tint natively to profile it
wasn't allowed in the session; each step below was measured instead.

| step (dev VM, the 209 stages) | Forward+ fragment stages (ms, KiB) | sum (ms) | stages > 100 ms |
| --- | --- | --- | --- |
| before: every value a var at the top | 5,154 / 3,207 (1,254 / 1,264) | 10,760 | 5 |
| lets where the uses stay in the scope; the rest vars where their scope starts, registers outside every loop around them | 250 / 239 (1,146 / 1,154) | 1,551 | 2 |
| registers outside only the loops that may read them before writing them | 189 / 183 | 1,409 | 2 |
| f32 values (a scalar float only floats read) | 134 / 132 (925 / 931) | 1,060 | 2 |
| a register's load by the register's name; float constants as hex literals | 130 / 127 (833 / 839) | 996 | 2 |
| a loop that runs once as its statements (161 of the 218) | 99 / 102 (748 / 753), 3 runs | 894 | 1 |
| integer ops whose bits don't depend on the sign on the u32s | **89 / 89** (722 / 727), 3 runs | **829** | **0** |

| | Forward+ fragment stages (ms) | the next (ms) | sum of 209 (ms) | stages > 100 ms |
| --- | --- | --- | --- | --- |
| M4, before | 3,725 / 3,639 | 446 | 8,889 | 3 |
| **M4, G2** (3 runs, medians) | **62 / 65** | 19 | **488** | **0** |

- **Vars were the superlinear part, volume what's left.** Moving 13,113 vars to 607 took the stage from 5.2 s to
  0.25 s; 329 registers at the top cost ~60 ms more than in their own scopes (~0.17 µs a var a statement). What's left is
  close to linear in the text, ~120 ms a MB on SwiftShader's path (the bitcasts' share: a trial dropping the integer
  ones alone saved ~3%), so the last steps cut text: two thirds of the stage was float arithmetic printed as
  `bitcast<u32>(op(bitcast<f32>(a), …))`.
- **Loop-carried registers.** A register is declared outside each loop around its loads and stores that may read it
  before writing it in an iteration (`carry_list`: a phi's first value can be undefined, with no store before the loop).
  A WGSL `var` declared in a loop is zero at each iteration; SwiftShader's path (Tint's SPIR-V) keeps the last
  iteration's value instead, so only the printed text shows a misplaced one (`tests/venus/g2/values.comp`'s check).
- **The trace's 5–6 s** (GD-KICKOFF.md 3) were on a busy GPU process; alone the M4 took 3.6–3.7 s. The dev VM's
  "didn't finish in 290 s" didn't come back: 3–5 s here.
- **No other program's slower.** The other programs' 105 stages (gtk4, mpv, the scene, vkcube, vkmark, vkQuake:
  `target/vk1/spirv/`) on the dev VM, 5 runs each: 266 → 135 ms in all, the slowest 31 → 12 ms, none slower by over
  10% (`vm-programs-*.json`); their WGSL 1.35 → 0.87 MB.
- **What's left** (docs/backlog.md "The printer's WGSL"): vectors as f32 (inputs and buffer loads are still read as
  `bitcast<f32>(t.x)`), the uniform buffers' word indexing, a native profile of Tint.

## VK4 T17: pipelines' loose ends — made at creation they lose (off by default); the store deflated, shown, cleared and its budget a preference

2026-11-03. vkQuake's capture (its state at frame 200) and vkmark's desktop scene replayed twice in a session each
(`bench/vulkan/venus-run.ts`, `REPLAY=vkquake,vkmark-desktop,vkquake,vkmark-desktop`; Debian with Vulkan, 2 vCPUs) on the
dev VM's SwiftShader (Chromium 153.0.8010.52, `CHROMIUM_ARGS="--enable-unsafe-webgpu --enable-features=Vulkan"`) and the
M4 (Chrome for Testing 153.0.8010.12, through `bench/gpu/sway-mac.sh`), with render pipelines also made at
`vkCreateGraphicsPipelines` (`?gpu=vkpremake=on`, vk/README.md "Pipelines made asynchronously") and without. JSON in
`results/vk4/t17/` (`replay-*-on-r1` with the viewport guess fixed; the same counts).

| vkQuake | made at creation, of them drawn | held for pipelines (ms) | load (s) | the first 31 frames (frames/s) |
| --- | --- | --- | --- | --- |
| SwiftShader, cold, at draws (the default) | — | 2,478 | 1.20 | **11.1** |
| SwiftShader, cold, at creation too (2 sessions) | 100, 8 | 20,788, 22,654 | 2.15, 2.49 | 4.8, 4.4 |
| SwiftShader, again in the session, at draws | — | 446 | 0.44 | 13.8 |
| SwiftShader, again, at creation too | 100, 8 | 169, 2,311 | 0.43, 0.49 | 15.9, 12.4 |
| M4, cold, at draws | — | 2 | 0.87 | **269** |
| M4, cold, at creation too | 100, 8 | 5,438 | 1.41 | 26 |
| M4, again in the session (both) | 100, 8 / — | 0.1 / 1.5 | 0.42 / 0.40 | 326 / 343 |

- **Made at creation, pipelines cost more than they save.** vkQuake makes 285 Vulkan pipelines by its frame 200, 100
  of them with a key their state decides (the rest are made at draws only); its frames draw with 18 render pipelines,
  8 of them among those 100. The other 92 are compiled for nothing, queued on Dawn's workers ahead of those the first
  frames need: cold, its frames run 10× slower on the M4 and 2.3× on SwiftShader. Warm (Dawn's cache in the session) it
  costs little either way. vkmark's 2 pipelines are both made at creation and drawn, no measurable change. So the page
  makes render pipelines at their draws, as before; `?gpu=vkpremake=on` for A/B (backlog "Pipelines' loose ends").
- **The store is deflated in IndexedDB** (CompressionStream's deflate-raw, inflated at the load; vk/README.md "The
  shader cache"): vkQuake's 282 entries, 4.68 MB held, are **0.63 MB stored (7.4×)**, vkmark's 28 KB 2.4 KB. The budget
  counts what's stored, so 32 MiB holds ~50 vkQuakes instead of ~7; the memory held at a full store is ~7× the budget,
  so the Preferences offer 8 to 64 MiB ("Space for Vulkan's shaders", 32 by default). The Machines page's storage line
  lists the store and clears it (tests/page-modal.test.ts).

## VK4 T16: imports without rewrites — a texture per resource; mpv wrote each picture once already, the import's time a frame 0.22 → 0.18 ms

2026-11-03. mpv on Vulkan with VA-API as VK2 L6 (`bench/audio/avsync.ts` through `bench/gpu/sway-mac.sh`, Sintel's H.264
trailer from the media disk, `WARM_S=8`, `PHASE_S=20`, 4 vCPUs; the desktop guest; the M4, Chrome for Testing
153.0.8010.12), each session mpv's default (`--vo=gpu-next --gpu-api=vulkan`) and with interpolation
(`--video-sync=display-resample --interpolation`); the arms in alternated sessions, before (`?gpu=vkimport=rewrite`, each
image its own texture, written at its bind) and after (each resource's own texture, vk/README.md "Imports"). JSON in
`results/vk4/t16/`. The GPU worker's import time is `importMs`, its writes and readbacks (the render stats).

| the M4, 2 rounds | frames, dropped | binds a frame | textures made a frame | KB written a frame | the import's ms a frame |
| --- | --- | --- | --- | --- | --- |
| default, before | 529, 535; 0 | 2.0 | 2.0 | 600 | 0.218, 0.226 |
| default, after | 529, 530; 0 | 2.0 | **0** | 600 | **0.176, 0.178** |
| interpolation, before | 531, 530; 0 | 2.0 | 2.0 | 600 | 0.195, 0.200 |
| interpolation, after | 531, 531; 0 | 2.0 | **0** | 600 | **0.173, 0.172** |

- **The bytes don't change: mpv imports a surface once a picture**, also interpolating (libplacebo keeps a frame's
  mapping while the frame is in its queue). The backlog's "every frame's planes are written again" was the write at
  each bind, which is each picture's one write; with the resource's texture it moves to the picture's landing (or the
  texture's making), and a re-import, which mpv doesn't do, writes nothing.
- **What goes is a texture made and written fresh at every bind**: two a frame before, none once each surface of the
  pool has its own (`importMade`: 0 over the phases). Writing into a texture that already lives is ~20% cheaper on the
  worker's thread (0.04 ms a frame); rounds don't overlap. The guest, the frames and the drops the same.
- Left (backlog "Imports' gaps"): each picture is still 0.6 MB of `writeTexture` at 480p (fewer only with the picture
  on the GPU), and the imported image's own texture is still made at `vkCreateImage` and destroyed at its bind.

## VK4 T13–T14: a synchronous call waited a poll turn — GSK's iconscroll 6.5 → 33 frames/s, past GL; the guest's execbuffers are Mesa's fences

2026-11-02. The desktop guest (Arch Linux, GTK 4.24.1, Mesa 26.2.5, sway 1.12 on GLES through virgl), 4 vCPUs, through
`bench/gpu/gtk4-load.ts` (each demo left 20 s, measured 10; `GSK_RENDERER=vulkan`, forced as in VK3 L7.3); the M4 (Chrome
for Testing 153.0.8010.12, macOS 26.6.2) through `bench/gpu/sway-mac.sh`. JSON in `results/vk4/t13/`.

**What a frame waited for.** vkr now counts the commands it runs (vk/README.md "Calls and rings": by where they came
from, whether they ask for a reply, by type), and the render stats name the replied ones. iconscroll on Vulkan at HEAD
ran at **6.5 frames/s** (GL 27.1; `gtk4-base.json`), and of its ~560 synchronous calls a second **~540 were
`vkAllocateDescriptorSets`**, ~83 a frame (`gtk4-counts.json`). Mesa's Venus allocates sets asynchronously only until
a pool made with `FREE_DESCRIPTOR_SET_BIT` has sets of another layout allocated and then one freed; from there on every
allocation is a ring round trip (`vn_descriptor_set.c`, `VN_ASYNC_SET_ALLOC_NONE`), and GSK's pools get there. A round
trip waits for the next poll: the pump's turns came every **1.33 ms** on the Mac, because Chromium stretches
`Atomics.waitAsync`'s 0.25 ms timeout to ~1.5 ms there (`bench/vulkan/wake.ts`: 1.525 ms median on the M4, 0.165–0.47
on Linux). 83 × ~1.3 ms is most of the 150 ms frame; gtk4-demo woke ~2,100 times a second in `vn_relax`.

**The fix: the pump's turns timed by a ticker worker** (web/venus-ticker.ts): a worker sleeping in a blocking
`Atomics.wait` and then notifying the word the pump `waitAsync`s on. On the M4 such a worker turns every 0.40 ms at
0.25, 0.155 at 0.1 and **0.08 at 0.05**, and a worker its notify wakes turns at the same pace (`wake-mac-*.json`; a latency across the two workers isn't measurable there: their clocks disagree by more); on Linux 0.5, 0.245 and
0.165 (`wake-vm-*.json`), so there only the shorter period helps. The ticker runs only while the pump does.

| iconscroll on the M4, one session each | frames/s | the pump's gap | gtk4-demo wakes a second |
| --- | --- | --- | --- |
| the pump (HEAD) | 6.5 | 1.33 ms | ~2,100 |
| ticker at 0.25 ms | 16.8 | 0.37 | 631 |
| ticker at 0.1 ms | 25.8 | 0.16 | 60 |
| **ticker at 0.05 ms (the default)** | **31.4** | 0.09 | 83 |
| GL, same sessions' arms | 27.1–31.8 | | |

**A defect the runs found, fixed before the A/B:** of seven sessions with the ticker, one's iconscroll fell to 0.9
frames/s (14 polls a second, the pump's gap 129 ms: `gtk4-gtk-1.json`, the screenshot `iconscroll-stalled-gtk-1.png`)
and one's next gtk4-demo died at its start, Venus's watchdog presumably aborting a guest whose replies never came
(`gtk4-repro-1.json`). The pump cleared the ticker's run word whenever a turn found nothing to run, even while a
scheduled turn waited on the ticker; had the ticker just ticked for what it took as the last time, it then never ticked
again, the waiting turn never came, and the pump never scheduled another. The turn now leaves the ticker running while
a turn is pending, and the pump's wait also times out at its old period, so a ticker the OS starves is no slower than
the pump alone. The test (tests/venus-driver.test.ts, the fences' test with the ticker) failed first.

**The A/B after the fix** (three alternated rounds, fishbowl, frames and iconscroll in each session; `gtk4-ab-*.json`):

| M4, GSK on Vulkan | the pump | the ticker |
| --- | --- | --- |
| iconscroll, frames/s | 6.5, 6.5, 6.6 | **33.5, 33.2, 33.7** |
| frames, gtk4-demo's CPU a frame (ms; 60 frames/s) | 2.04, 2.08, 2.01 | **1.96, 1.91, 1.93** |
| fishbowl, frames/s (it adapts its icons) | 59.5, 59.4, 58.5 | 59.3, 57.0, 58.5 |
| the pump's own turns, ms a second (iconscroll) | ~7 | ~50 |

- **GTK4's bar (G) is met on the M4**: iconscroll at 33 frames/s against GL's 27.8–31.8 in this session's GL arms
  (`gtk4-gtk-1.json`, `gtk4-gtk-2.json`; G's own 37.6 was measured under VK0's older setup); frames at GL's CPU a frame
  (GL 1.89–1.99 ms here, VK3 L7.3's Vulkan 2.02–2.07); fishbowl holds 60. No stall in the six sessions.
- **The cost**: while Venus is busy the pump turns ~7,500 times a second at iconscroll, ~50 ms a second of the GPU worker
  (5% of its thread; the old pump 5–10 ms a second; the ticker 12 in frames, 28 in fishbowl), plus the ticker's own wake-ups. It stops when the rings go idle (1 ms
  without commands) and no submit is in flight. **VK0's scene** (`scene-*`, two alternated rounds, ms a frame, medians):
  1 fish 0.946, 0.870 (pump) / 0.848, 0.847 (0.05) / 0.927, 0.876 (0.1); 1,000 fish 2.534, 2.599 / 2.586, 2.555 / 2.498,
  2.508; the toolkit 0.948, 0.946 / 1.084, 0.916 / 0.997, 0.912; the guest's CPU a frame the same within the rounds:
  no arm worse.

**The out-of-context review** (a fresh agent, static, on the local branch `review/vk4-t13`, 10 findings, all fixed):
the tests couldn't fail with a ticker that never ticked or never stopped (the fallback timeout carried the pump): the
fences' test now also counts the ticker's ticks over its run and while idle (F1); a ticker whose worker can't be made
or fails to load hands back to the pump with a warning, instead of a pump left waiting on it or a throw inside vkr's
command (F2, F3; the ticker is made at the renderer's start now, never inside a module's call); `idles` counted every
poll of an idle ring, not each time one went idle (F4: it read ~1,900 a second at iconscroll
in the results' `cmds.idles`); the counters' differences now wrap modulo 2^32 (F5); the knobs out of range (`vktick=NaN`
slept for ever, `vktick=0` spun, a long `vkidle` wrapped and lengthened vkr's synchronous seqno wait, which now keeps
the guest's own idle timeout) are refused with a warning (F6); the bound of command types comes from the module (F7);
a module older than the counts is refused before it runs (F8); comments (F9); `wake.ts`'s latency across two
workers' clocks, which disagree on the Mac by more than it, dropped (F10). Each fix with its test, seen failing with
the fault planted back (F4's in vkr, rebuilt), but F9's and F10's. With the fixes, one session of the three demos on Vulkan and GL
(`gtk4-final-contended.json`, run while CI loaded the dev VM on the same Mac: every arm slower) kept the order:
iconscroll 29.3 frames/s on Vulkan against GL's 22.6, fishbowl and frames at 60; `idles` 60–75 a second, about as many as
the guest's notifies.

**T14: the guest's execbuffers.** Per GTK4 frame (frames, 60 frames/s; the virtqueue's commands by name): 3 fenced
queue submits, each **two** execbuffers (`vn_queue_submission_signal_syncs`: a fenced `vkWaitRingSeqnoMESA`, then a
`vkSubmitVirtqueueSeqnoMESA` round trip), and one `vkNotifyRingMESA` (a ring gone idle); sway's virgl submits make the
rest of the 9 SUBMIT_3D. In Mesa 26 every `VkFence` and sync-fd semaphore is a renderer sync (a DRM syncobj of the
guest's) signalled through the virtqueue: there is no feedback path for fences any more, so the host can't serve them
more cheaply; only the guest's Mesa could. The notify can go: `?gpu=vkidle=<ms>` keeps rings active longer (at 20 ms
fishbowl's notifies 60 → 1 a second, frames' 60 → 6), but gtk4-demo's CPU a frame didn't move (`gtk4-gtk-idle4.json`,
`gtk4-gtk-idle20.json`, one session each: frames 1.96, 1.91 ms) while the pump ran ~6× as often in frames (13,800 turns a second against 2,260: it never
stops between vsync-paced frames): not the default. What VK1's gate saw (GTK4's frames +11% on Venus) is gone with the
ticker: the guest's CPU a frame in frames is GL's.

## VK4 T12: the smaller rendering gaps — layered passes, feedback loops, indirect fans, multisampled arrays, packed 16-bit formats

**2026-10-31.** JSON in `results/vk4/t12/`: `base` a sample of the task's causes before (2,378 cases not in the list), `wide` them after, `ms` the
multisampled ones, `qc` clipping and queries, `p16w` every 14th packed-format case, `p16f` its failures again; `m4a`, `m4b`, `m4c` on the M4 (Metal, Chrome for
Testing 153.0.8010.12); `vkquake-kept.json`, `vkquake-forced.json` the replay. `bench/gpu/deqp-run.ts vk`, SwiftShader on the dev VM, Chromium 153.0.8010.52.
How each works: vk/README.md "Layered passes", "Feedback loops", "Multisampled arrays", "Packed 16-bit formats".

The kickoff's list was older than the code. Before: 97 failures of 780 supported cases, and nothing failed for `ssbo.layout`'s `int16_t`, `numcalls2` or
the clears counted inside a query (T1's causes, gone since). Of what was left:

| cause | before | after | what it took |
|---|---|---|---|
| input attachment reading its own pass's attachment (`self_dep`, `max_attachments`) | 40 of 325 | 0 | a copy, in a cut of the WebGPU pass, at the first such draw and after a barrier or clear |
| indirect fans | 15 of 166 | 0 | a compute pass working out what the arguments draw |
| layers of `vkCmdClearAttachments` and load ops | 6 of 303 | 0 | a pass of several layers replayed a layer at a time, as multiview |
| `a2b10g10r10_uint` clear values past 255 | every one | 0 | a draw: Dawn cuts this format's clear value to 8 bits a channel |
| depth clip with clamp on | 6 of 10 | 0 | `unclippedDepth` only where not clipping: after clipping nothing needs its clamp |
| occlusion queries of two pools, or begun outside a pass | 1 | 0 | a query set of the device's for such a pass; a query spanning passes adds them up |
| multisampled arrays | 568 of 590 run | 183, none of this cause | a texture a layer behind one object in the worker |
| `R5G6B5`, `A1R5G5B5`, `B4G4R4A4` (T1's "refused at creation though advertised") | 33 of 223 | 5 of 3,299 | they weren't advertised at all, and Vulkan requires them: see below |

**The packed formats were a compliance gap the task's line hid.** `render_to_image.*.mipmap` doesn't ask for its format, so what looked like a refusal beside a
depth format was a device without Vulkan's three mandatory 16-bit formats (`api.info.format_properties.r5g6b5_unorm_pack16` failed): 76,976 of the direct set's
cases name one. WebGPU has none, so they are `rgba8unorm` textures whose copies pack and unpack in a compute pass. 3,274 of the 5,698 sampled pass, 2,399 not
supported for other reasons (a compute-only queue, `VK_EXT_filter_cubic`), and every one kept for the list passes on the M4. The 183 left of the multisampled
sample are 124 mutable images viewed as r32 formats, 48 multiview cases on `r32g32b32a32_sfloat` (T7 filed them as multisampled arrays: the cause is the format, which
WebGPU doesn't multisample), 3 sRGB-twin resolves in each of 2D and arrays (T4's), 3 of `diff_image_size.dst_256_256_11` and 2 clears.

**The M4's `generate_mipmaps.from_previous_level` (46 cases, from VK3 L6b) wasn't a hazard.** Halving an image puts each nearest sample exactly on a texel's edge, and an
interpolated coordinate came a hair short of it on Metal, so `floor` took the other texel of two. A texel from the fragment's position by Vulkan's sum, `x0 + (i + 0.5) *
scale`, is exact for such ratios: all 46 pass there. `early_fragment`, the two `texture.mipmap` and `stencil_samplemask` stay filed, with the `e5b9g9r9` copies; two of three
`descriptorset_random.sets4` still fail, the third passed (`m4b`).

**vkQuake's 1.7% is lavapipe's.** A map of the difference showed noise everywhere, and a crop's rows showed our texels repeating where lavapipe's didn't, on a texture
sampled by `NEAREST` with `anisotropyEnable` (logged: `mag 0 min 0 mip 1 aniso 1 16`). WebGPU's anisotropy needs linear filters, so the driver drops it for such a sampler; lavapipe
filters linearly. A trial build forcing linear filters and anisotropy:

| vkQuake, frame 5, SwiftShader | bytes that differ | off by more than 24 |
|---|---|---|
| kept: nearest, no anisotropy (`vkquake-kept.json`) | 723,502 | 15,438 |
| forced: linear with anisotropy, a trial (`vkquake-forced.json`) | 289,073 | 109 |

So the frames are right to the reference's reading, and the driver stays as it was: what `NEAREST` with anisotropy does is the implementation's (radv keeps point sampling, `ANISO_POINT`),
vkQuake asks for that look by name, and the tolerance of 3% stays. The list goes 23,083 → 26,002 cases, all new ones passing on the M4; `tests/deqp/vk.txt` holds a third of the packed sample.

Not measured: the feedback copies' and the packed copies' cost on a program (nothing in the images leans on them). The cuts' price is bounded by design: only a draw reading
an attachment of its pass pays, once per barrier. 3D images through 2D views turned out to be `VK_EXT_image_2d_view_of_3d`, which isn't offered: attachments work, and a stray invalid
view of every such image is gone. Next, by promise: blends with both constants (backlog "Rendering"), then the multisampled clears of `unorm` formats (backlog).

## VK4 T11: storage images as words — any format loaded and stored, tier1's offered everywhere, libplacebo's compute on `rg16f`

**2026-10-31.** JSON in `results/vk4/t11/`. `bench/gpu/deqp-run.ts vk`, SwiftShader on the dev VM, Chromium 153.0.8010.52; `m4/`
and `mpv-m4/` on the M4 (Metal, Chrome for Testing 153.0.8010.12). `image.*` isn't in `vk-main.txt`: case names from the mustpass
files in the `webpc-deqp-vk` image. How it works: vk/README.md "Storage images as words".

**No dEQP-VK case had the cause.** T1 counted none, and rightly: every 8th of the `image.*` groups that store (1,350 cases, `before/`) gave
194 passes, 1,156 not supported and no failure. `load_store` loads one image and stores another, so no case asks for one image both ways
of a format WebGPU gives one way. What the sample did show: the 1,156 include every one of tier1's formats, because SwiftShader has no
`texture-formats-tier1`. So the failing-first tests are our own, and the formats' encodings reach CI by offering tier1's formats on every
adapter, a format WebGPU has no storage texture of going by words for any access. That is more than the task asked, and it is what makes
dEQP-VK test the encodings on SwiftShader at all.

| run | cases | pass | fail | not supported |
|---|---|---|---|---|
| the sample, before | 1,350 | 194 | 0 | 1,156 |
| the sample, after | 1,350 | 426 | 0 | 924 |
| the storage groups whole and neighbours' samples, after (`wide/`) | 10,947 | 3,618 | 27 | 7,302 |
| the 27 on a build without T11 (`fails-on-base/`) | 27 | 0 | 27 | 0 |
| the 3,481 new passes on the M4 (`m4/`) | 3,481 | 3,481 | 0 | 0 |

The 27 aren't T11's: backlog "Storage images' cases failing before T11". The list gains 1,885 (21,198 → 23,083): `format_reinterpret` every 4th, and
without `mismatched_formats` and `texel_view_compatible`, which pass with a submit dropped (a shader's format not its view's, an uncompressed view of
ASTC: WebGPU's errors in the run's warnings, dEQP-VK asks nothing of the result).

**A real program.** `bench/vulkan/t11-rw.hook`, an mpv user shader run through `--vo=gpu-next` (libplacebo 7.360.1): a `//!STORAGE` texture of `rg16f`, which no
tier loads and stores as a texture, written by one compute hook and read by the next, which paints what it found: (0.25, 0.75, 0). Against the same frame
without the hook, by `mpv-frames.ts`'s greenness (mean G less the mean of R and B):

| | hook | plain | what libplacebo and the driver said |
|---|---|---|---|
| without T11, SwiftShader (`mpv-base/`) | 0 | 0 | "a shader didn't translate: a read_write storage image of format rg16float", no picture in either arm |
| T11, SwiftShader (`mpv-swiftshader/`) | 156.9 | 0.7 | nothing |
| T11, M4 (`mpv-m4/`) | 157.9 | 0.8 | nothing |

(A first hook of 32x32 invocations failed silently in libplacebo: 1,024 past WebGPU's default 256, ours to the device's limit, not a defect.) One of the three stages of vkQuake's that didn't translate
stopped at a read-write `rg16float`; it now stops, as the other two, at 16-bit arithmetic on SwiftShader (no `shader-f16`).

**Tests.** `tests/wgsl.test.ts`: 38 rows of formats and ranges against bytes worked out by hand, stored and loaded through Chromium (the refusal's test now asks
for words). `tests/venus-driver.test.ts` `rwImage`, `rwImageWide`: an image cleared, loaded and stored, copied out, twice, a neighbouring level's clear kept. Planted, each failing: a sub-word store
unshifted, no sign extension, snorm by the unsigned maximum, a NaN ufloat, words not recorded as written, no copy to the words, rows of 4 bytes a texel. The last and the NaN first
survived, and got `rwImageWide` (a row only shows past 4 bytes a texel on a wide image) and the out-of-range rows. An older test caught `imageSize` counted as a read, which made a write-only image read-write. A shared
image's flush has no test: nothing in the tests reads such a texture past the replay.

Not measured: the words' and copies' cost on a real program (nothing in the images leans on them; the hook only shows them right). Next, by promise: views past `maxStorageBufferBindingSize`
(an invalid bind group today), the view's format at the bind (what `*WithoutFormat` and `mismatched_formats` need), a second binding for a vertex stage reading what the fragment stage writes: backlog
"Storage images as words' leftovers".

## VK4 T9: the translator's wrong results — shadow samples past level 0, `textureQueryLod`, offsets, helpers, a dispatch's base

**2026-10-31.** JSON in `results/vk4/t9/`: `base` before, `wide` the groups after, `neigh` the neighbouring shadow groups,
`list-new-m4` the list's new cases on the M4 (Metal, Chrome for Testing 153.0.8010.12). `bench/gpu/deqp-run.ts vk`, SwiftShader
on the dev VM, Chromium 153.0.8010.52.

| run | cases | pass | fail | not supported |
|---|---|---|---|---|
| before: shadow, `textureQueryLod`, every 8th offset case, helpers, bases, clip reads | 1,911 | 127 | 417 | 1,367 |
| after: the same groups, every offset case (no `_pcoffset`, no sparse) | 3,270 | 1,924 | 0 | 1,346 |
| every 3rd of `texture.shadow`, every 16th of `pipeline.monolithic`'s shadow and compare, every 4th of `texture_gather`'s shadow | 2,996 | 408 | 0 | 2,588 |
| the list's 2,255 new cases on the M4 | 2,255 | 2,247 | 0 | 8 |

The list 18,943 -> 21,198.

- **Offsets weren't what the backlog said.** Nothing was dynamic: `wgsl_finish` scalarizes constants (`nir_lower_load_const_to_scalar`), so
  every vector offset reached the printer as a vec of scalars, and `nir_src_is_const` said no. Each channel is now found through the
  vec. The truly dynamic `_pcoffset` cases need `maintenance8`, not advertised (2,760 not supported).
- **Shadow samples past level 0** take T18's filter from fetches, each texel compared. What keeps real shadow maps cheap: a view of
  one level and a constant LOD of 0 make no key, no variant and stay `textureSampleCompareLevel`; a test holds that. No program
  replayed here samples a mipmapped shadow map, so the fetches' cost on one is unmeasured (eight `textureLoad`s a trilinear sample, twice that where mag and min filters differ).
- **A trap: infinities.** dEQP's `clamp_min` sets `maxLod` to `inf`, and `min(x, inf)` in WGSL read the last level (indeterminate; a
  bitcast keeps the compiler quiet). Key LODs are clamped to ±1,000 at the sampler. T8's integer path had the same exposure.
- **A trap: `OpImageQueryLod`'s coordinate has no layer**, unlike every other sampling op: the spatial count and 1D's widening
  read past it (a module with `t0.`). And optimization shrinks a size query to the channels used, so the printer now prints what's
  asked (a cube array's `vec2<u32>(vec2<u32>, u32)` didn't compile, and its cases crashed).
- **`textureQueryLod`'s y is before the sampler's clamps**, by dEQP's expectations; its x after.
- **`gl_HelperInvocation`** as an empty `sample_mask`: all pass on SwiftShader and on Metal. No built-in says this is WebGPU's
  promise; a backend that reports coverage for helpers would read false, as all of them did before.
- **Beyond the brief, because the census files it under T9:** `gl_ClipDistance` read by a fragment stage, at free locations (18 failures
  to 0). A mirror-once offset, T8's leftover, which these cases reached once offsets translated (all 21 failures left in the first run).
- **The depth output without a depth aspect** was done by T10 (`fragment_without_depth`): nothing to do here.
- **Tests**: `tests/wgsl.test.ts`'s seven. Planted, each fails: the filter nearest, the reference unclamped, a keyed shadow sample left
  to WGSL, the compare swapped, offsets not found through the vec, a mirror-once offset after the wrap, the query's layer, its
  texture's type, its clamps, helpers as demotes alone, the base off the workgroup id, the clip location. Dispatch bases' pipelines
  and the LOD clamp are dEQP's cases (`dispatch_base` and `clamp_min`, each failing before its fix).

## VK4 T7: API 1.3's required features — R32 atomics, inline uniform blocks, multiview, device addresses

**2026-10-31.** JSON in `results/vk4/t7/`: `bench/gpu/deqp-run.ts vk`, SwiftShader on the dev VM, Chromium 153.0.8010.52;
`list-new-m4` on the M4 (Metal, Chrome for Testing 153.0.8010.12). These groups aren't in `vk-main.txt`: their case names come from
the mustpass files in the `webpc-deqp-vk` image.

| run | cases | pass | fail | not supported |
|---|---|---|---|---|
| atomics, a sample, before | 29 | 0 | 25 | 4 |
| `image.atomic_operations`, R32, no sparse or linear, after | 705 | 705 | 0 | 0 |
| inline uniform blocks (`inline_uniform_blocks`, `descriptor_copy`, a sample of `descriptorset_random`'s `iub`, the limits) | 497 | 28 | 0 | 469 |
| `multiview`, no geometry or tessellation | 742 | 547 | 48 | 147 |
| `buffer_device_address` and a fifth of `ssbo` and `ubo`'s scalar cases | 2,881 | 1,811 | 0 | 1,070 |
| the list's 1,735 new cases on the M4 | 1,735 | 1,735 | 0 | 0 |

The list 17,208 -> 18,943.

- **Atomics are T4's tracking with one more place.** WGSL has no atomics on textures, and the image must stay a texture for
  everything else, so its words are a buffer that `wg_image.valid` tracks beside the alias textures. A program that stays on
  its words pays one copy. The first run's 14 failures were all one thing: a storage-only texture has no copy usages.
- **Multiview costs nothing where it isn't used and needed no layered rendering.** `forget` at a pass's start already makes its
  commands self-contained, so replaying them is a jump back to `OP_PASS`. A pipeline per view only for stages that read
  `gl_ViewIndex`. An input attachment needed no shader change: the view's layer is bound, 2D as declared.
- **The 48 failures are all multisampled arrays** (`multiview.*multisample*`, T12's): WebGPU refuses the texture.
- **Device addresses are a byte of one buffer, not a dispatch over memories.** A stage can reach more memories than
  WebGPU binds, so an `if` tree can't serve; every address memory is in one GPUBuffer. `nir_address_format_2x32bit_global`
  gives pointers without 64-bit integers, and a global access becomes an SSBO's, so the printer needed nothing.
- **Pointers beside a writable descriptor of address memory** would alias in WebGPU and no dEQP case meets it, so
  `wg_test.c`'s scenario 39 does, after a growth: T3's shadows now take writes and copy them back at the scope's end.
- **Not supported, by the reasons of a sample**: vertex stores (`vertexPipelineStoresAndAtomics`), `shaderInt64` and set counts past
  `maxBoundDescriptorSets`. `scalarBlockLayout` was the fourth, and every access is by words, so it is advertised now.
- **A found bug**: a group holding only the pointers' binding returned before its readback, so what a shader wrote through
  pointers never reached the CPU (3 `misc` and `op_access_chain` failures). And a storage binding of 2 bytes, which scalar
  layout allows, was refused: sizes round up within the memory now.

Not measured: the copies' cost on a real program, since none in the images uses these features. Next, by promise: multisampled
arrays (T12: 48 here, 380 in `image.mutable`); `shaderInt64` as 2x32 (504 of `buffer_device_address`, and vkd3d-proton needs
it); address memory past one storage binding, which DXVK's habit of flagging every allocation would meet on an adapter with
a small binding limit.

## VK4 T18: compressed images that aren't whole blocks — sampled in the shader, 648 cases to SwiftShader's own 146

**2026-10-31.** JSON in `results/vk4/t18/`: `cases` the 648 (T1's cause, and T8's sample's 560 compressed failures), `cases-m4`
them on the M4 (Metal, Chrome for Testing 153.0.8010.12), `wide` T8's sample again, `list-new` and `list-new-m4` the list's
change. `bench/gpu/deqp-run.ts vk`, SwiftShader on the dev VM, Chromium 153.0.8010.52.

| run | cases | pass | fail | not supported |
|---|---|---|---|---|
| the 648, before | 648 | 0 | 648 | 0 |
| the 648, after | 648 | 502 | 146 | 0 |
| the 648 on the M4 | 648 | 648 | 0 | 0 |
| T8's sample, 900 failures before | 57,066 | 10,338 | 508 | 46,220 |
| the list's new cases and its padded base-level views | 537 | 532 | 5 | 0 |
| the same on the M4 | 537 | 537 | 0 | 0 |

- **`texture-compression-unaligned` was the obvious way and isn't one.** Dawn takes such a texture with it, on SwiftShader
  and on the M4, but Chromium offers it only behind `--enable-unsafe-webgpu`: CI, which runs with that flag, would have passed
  and no user would have had it. Probing the M4 without the flag said so.
- **Scaled coordinates, the brief's first idea, can't work**: a padded texture's levels aren't in proportion to the
  image's (13×13 of ASTC 8×5 in 16×20: level 1 is 6×6 in 8×10), and clamping or wrapping reads padding. Decoding to an
  uncompressed texture needs decoders for three families and the bytes at every copy, which may be on the GPU.
- **The way taken**: T8's keys, with the view's size: the shader does Vulkan's LOD and filter by the image's own levels from
  texel fetches (`padded_sample`), so such an image alone pays (4 fetches a level, anisotropy lost), a cube bound as its
  faces, a linear filter finding the next face through the texel's direction.
- **The 146, and 5 cases the list had**: all `lod_base_mip_level`: fetched now, they meet SwiftShader's bug T8 found, a
  `textureLoad` on a view from a base level reading further down (from one test, consistent with the base added twice).
  The M4 passes all 648 and the 5. The 5 had passed natively, so they left the list, and `bench/vulkan/nvidia.sh`
  `VK2_STEPS=t18` runs 84 such cases by name: Lavapipe couldn't be put under Chromium, so whether this is
  SwiftShader's or Dawn's Vulkan backend's is open until NVIDIA answers. Sampling at texel centres would dodge it, but a
  sampler's LOD clamps would then cut into a level the shader chose.
- **What's left of T8's 900**: no compressed case but those; 186 integer base-level views, 151 of T9's, 3
  `explicit_lod`, the rest T12's multisampled arrays.
- **What it costs elsewhere**: draws look for padded views only once one was made (`padded_views`), so programs without
  such an image do what T8 measured. Neither T18's filter nor a variant per size is measured on a program: none
  replayed has such an image.
- **Tests**: `tests/wgsl.test.ts` (a key's smaller size on a plain texture: clamp, repeat, linear at the image's edge, its
  size at each level; a cube's edge read across faces). Planted: the seam kept on one face, size queries unminified;
  both fail. The list 16,711 → 17,208.

## VK4 T8: samplers — what WebGPU's samplers can't say, in the shader, 203 of T1's failures to those of other tasks

**2026-10-31.** JSON in `results/vk4/t8/`: `base` and `census-first` T1's sampler failures before and after the first
version, `wide-first` and `wide` the groups below (the second with integer gathers and custom borders), `list-new` the
list's new cases, `list-new-m4` them on the M4 (Metal, Chrome for Testing 153.0.8010.12). `bench/gpu/deqp-run.ts vk`,
SwiftShader on the dev VM, Chromium 153.0.8010.52.

| run | cases | pass | fail | not supported |
|---|---|---|---|---|
| T1's cases of these causes, before | 215 | 0 | 203 | 12 |
| the same, the first version | 215 | 167 | 36 | 12 |
| every 8th of `pipeline.monolithic.sampler`, `image_view`, `texture`, `glsl.texture_functions`, `glsl.texture_gather`, `glsl.opaque_type_indexing.sampler` | 57,066 | 9,946 | 900 | 46,220 |
| the list's new cases, as one list | 3,497 | 3,497 | 0 | 0 |
| the same on the M4 | 3,497 | 3,494 | 3 | 0 |

- **The shape.** A sampler is known at the bind and the shader long before, so each stage that samples keeps its lowered
  NIR and prints again against the bound samplers' keys, as a variant of its program. A plain sampler's module is what
  it was. NIR, not text: every case here is a coordinate or a level the printer needs anyway, and the integer path was a NIR pass already.
  What it keeps: over the programs' 124 stages (1.57 MB of WGSL), the 67 that sample keep 196 KB (+12.5%, serialized
  and stripped), in the shader store too.
- **What's left of the 900**, none of these causes: 560 of compressed images (524 ASTC, 24 of `texture.swizzle`'s EAC npot,
  12 of `texture.compressed`'s npot: T18's padding by their look, not checked one by one), 149 of `glsl.texture_functions`' non-constant offsets
  and `textureQueryLod` (T9), 2 multisampled arrays (T12), 3 `texture.explicit_lod.*_pack16_linear_compute` not looked
  into, and 186 integer `lod_base_mip_level` views, **SwiftShader's**: a `textureLoad` at a view's level 0 reads the
  level after it (found with a compute shader on a view from level 2), which sampling doesn't meet and the M4 doesn't
  do. T1's census had 0 of them on the M4.
- **Beyond the brief, because they were one step away:** `VK_KHR_sampler_mirror_clamp_to_edge`,
  `VK_EXT_custom_border_color` and `VK_EXT_border_color_swizzle` advertised, `maxSamplerLodBias` 2 → 15 (T1 counted these
  ~51,000 cases of the direct set as not supported); a stage that only asks an integer texture's size or levels
  now declares it integer (a bind group error, its submit dropped, was the `texturequerylevels.usampler*` cases').
- **A trap for the next one:** a gathered integer texture is in both of a program's pair lists; keyed as a float, its border
  was float bits (666 `border_swizzle` failures in `wide-first`).
- **Most `not supported` here is the compute-only queue family** (T1's first reason): `border_swizzle`'s and
  `sampler`'s `_compute` variants, not samplers.
- **On the M4** the 3 left out: `sampler.*.astc_*.mipmap.nearest.lod.select_bias_2_5` (2) and
  `texture.mipmap.cubemap.projected.nearest_linear_linear_repeat`; backlog "The M4's own failures".
- **What it costs where no sampler needs it: nothing measurable.** VK0's scene (`guest.ts venus`, the desktop guest, on
  SwiftShader, three rounds alternated against the module before T8, `scene/`), ms a frame: 1,000 fish 90.6–92.4 after,
  90.5–93.0 before; the toolkit at 2,000 21.5–22.1 and 21.6–22.3. The rounds overlap. Its modules are the same text
  and its draws look at each pair's sampler. No replayed program has a sampler that needs a key, so a variant's own
  cost on one is unmeasured.
- **Tests**: `tests/wgsl.test.ts`'s five (a stage printed from NIR serialized, as a variant is, run on WebGPU), dEQP-VK's
  cases. Planted: mirrored repeat off by one, a border's far edge (which first passed: its image was zero there, so
  the test gained a red image), a cube's face sign, the sampler's bias dropped, swizzled views not bound, the border's
  mapping swapped: each fails. The list 13,217 → 16,711.

## VK4 T6: synchronization's failures — `device_host`'s 202 failures to 0, a semaphore's value reached before its batch ran

**2026-10-30.** JSON in `results/vk4/t6/`: `base/` before and `fix/` after (the 1,913 `timeline_semaphore.device_host`
cases of both groups, which aren't in `vk-main.txt`: names from the CTS image's mustpass; `fix/` with the list's other
timeline cases), `m4/` the passing ones on the M4 (Metal, Chrome for Testing 153.0.8010.12), `ab/` below.
`bench/gpu/deqp-run.ts vk`, SwiftShader on the dev VM, Chromium 153.0.8010.52.

| run | cases | pass | fail | not supported |
|---|---|---|---|---|
| before | 1,913 | 351 | 202 | 1,360 |
| after, with the list's other timeline cases | 1,936 | 576 | 0 | 1,360 |
| the M4, the list's | 567 | 567 | 0 | 0 |

- **The pattern misled**: every buffer and 3D case failed and every 1D and 2D one passed, whatever the operations. The
  test's `randomizeData` loops to the image's depth, which is 0 for a 1D or 2D `ResourceDescription`, so those cases
  send zeros down the chain, and what went wrong yields zeros too. Their passes proved nothing (backlog's "69 of 110").
- **The cause**: a driver trace showed the guest's copy of iteration 1 before the read it copies was replayed. Venus's
  timeline semaphore is a DRM syncobj per queue in the guest (`VN_SYNC_TYPE_TIMELINE_SYNC`), its point signalled by the
  fence of the execbuffer sent after each batch. The driver let vkr's fence submits go ahead of held submits (L6a's way
  out of a hang), so a held batch's value read as reached before the batch ran. Held with the rest, the chain's data
  arrives whole. The fence-alone exception and vkr's flag are gone.
- **What L6a's hang was**: not the guest's command streams, as written then. The device answered in order, so a held
  ring fence held the unfenced execbuffer each queue submit also sends: 8 submits (16 replies) filled the page's control
  queue, and `host_wait_before_signal`'s thread stopped in the kernel before its signal. A ring fence's reply is now out
  of line (`web/gpu.ts`, `rings`). A larger queue isn't the way: a full queue is what paces a compositor.
- **A test**: `tests/gpu.test.ts`, the reply out of line. Planted back in line, it fails. dEQP's group is the test of the
  order (no unit test holds Venus's guest driver); the driver's own `emptyAfterHeld` covers a fence alone behind a held
  submit.
- **What it costs** (`ab/`, `bench/vulkan/apps-load.ts` through `bench/gpu/sway-mac.sh`: vkcube on sway at 1080p on the M4,
  macOS 26.6.2, 4 vCPUs, warmed 15 s and measured 15 s, three rounds alternated, the arms differing in `web/gpu.ts`): the
  same, rounds overlapping: 59.75–59.9 frames a second against 59.9, vkcube's 1.42–1.57 ms of CPU a frame against
  1.42–1.47, the guest 9–10% busy against 9%.

Left: backlog "Synchronization" (16 held submits from the thread that signals them fill the control queue).

## VK4 T4: views in another format — every `image.mutable` failure but multisampled ones, 3,132 cases and the plane views

**2026-10-30.** JSON in `results/vk4/t4/`: `base/` before (every 10th of `image.mutable`'s 10,645 cases, which aren't in
`vk-main.txt`: names from the CTS image's mustpass, and the 456 8-bit plane views), `whole/` after (all of them), `m4/` the
3,198 passing on the M4 (Metal, Chrome for Testing 153.0.8010.12), `store-probe/` below. `bench/gpu/deqp-run.ts vk`,
SwiftShader on the dev VM, Chromium 153.0.8010.52.

| run | cases | pass | fail | not supported |
|---|---|---|---|---|
| before, the sample | 1,521 | 132 | 213 | 1,176 |
| after, the sample (before the storage twin's fix) | 1,521 | 389 | 43 | 1,089 |
| after, the whole group | 11,101 | 3,198 | 445 | 7,458 |
| the M4, the 3,198 | 3,198 | 3,198 | 0 | 0 |

- **The fix.** A view WebGPU refuses is of a texture of its own format, and the replay copies subresources between an
  image's textures where one is used that doesn't hold them (vk/README.md "Views in another format"). The lists 9,602 →
  12,733 and 773 → 839 (the 66 plane views). Nothing that passed before fails; one case left the list, not failing:
  `imagesizems.image2dms_fixed_vertex` passed by running nothing (the query said one sample), and now, asked for 4, is
  NotSupported through its image's other usage.
- **What left the failures**: every one of the 445 is multisampled: 380 arrays (WebGPU has none: T12; backlog
  "Multisampled arrays"), 62 view formats WebGPU can't multisample, 3 sRGB-twin resolves not understood (backlog).
- **The query was the larger gate.** `image.mutable` asks every case for a format with more than one sample, whatever
  it does, and we said one for an image without attachment usage (though `sampledImageColorSampleCounts` says 4) and
  refused `EXTENDED_USAGE` usage its format lacks. Both fixed: 83 of the sample's passes.
- **`store` and `load` are still not supported** (dEQP's same check, for storage usage, where 1 is the truth), so the path
  ffmpeg and libplacebo take has no CI case but `mutableViews`. Checked once in a throwaway build reporting samples for
  storage (every 12th, 371 cases): 112 pass, 1 fail, a storage view of an sRGB image's linear twin, which had no
  storage usage; fixed, 113 pass and none fail (258 not supported).
- **Tests**: `misc: mutableViews` failed first with WebGPU's error. Not planted: the copies themselves are what its pixels
  check, and the attachment-resolve bug found on the way (resolves named the image's own texture) was caught by dEQP.
- **Left** (backlog "Views in another format's leftovers"): the copies' cost on a real program isn't measured.

## VK4 T5: vertex strides and offsets that aren't multiples of 4 — 1,002 of `vertex_input`'s failures to 0, pulled from storage

**2026-10-30.** JSON in `results/vk4/t5/`: `base/` before and `after/` after (`pipeline.monolithic.vertex_input.*`,
13,296 cases, `bench/gpu/deqp-run.ts vk`, SwiftShader on the dev VM, Chromium 153.0.8010.52), `m4/` the 1,002 cases on the
M4 (Metal, Chrome for Testing 153.0.8010.12).

| run | cases | pass | fail | not supported |
|---|---|---|---|---|
| before | 13,296 | 1,469 | 1,002 | 10,825 |
| after | 13,296 | 2,471 | 0 | 10,825 |
| the M4, the 1,002 | 1,002 | 1,002 | 0 | 0 |

- **The cause and the fix.** WebGPU refuses a stride or a bound offset that isn't a multiple of 4 and an attribute's
  offset that isn't a multiple of its size (up to 4), which invalidates the pipeline and its submit. Such a binding is
  now read by the vertex stage from a read-only storage binding, as transform feedback's compute pass already read
  vertices (vk/README.md "Pulled vertices"). The list 8,600 → 9,602 cases. The census counted 22 of these in its
  every-100th sample; the group has 1,002 (`multiple_attributes` 949, `single_attribute` 52, `max_attributes` 1).
- **vkd3d's test_instance_id** 84 → 24 failures of 372: the 1-byte stride's row draws. Of the 24 left the run's output shows
  10, all Test 2 (a step rate of 2), whose values are the step rate of 1 row's: the 1-byte stride reads right and the
  rate is ignored (divisors, tier 4). The other 14 weren't seen; a step rate of 0, Test 0, is the likely rest. The first version of the fix left
  84: its draws differ in their base instance alone, which sets the groups again for the parameters' new place, past
  where `apply` had decided the pulled group needn't be set; the program's empty group replaced it. dEQP-VK's group
  didn't meet it (no draw parameters); vkd3d's run did, and `pullDrawParams` now does.
- **Tests** (`tests/venus-driver.test.ts`, 5 new; the first four failed first with WebGPU's error): strides and offsets
  direct, indexed, indirect and beside an ordinary binding; draw parameters; a pipeline with a set in the group the last
  one pulled from; one layout at four bound offsets; and, written after the fix, a transform feedback capture of pulled
  vertices. Planted: no groups
  set after a pulling pipeline (fails `pullGroups`, once its shaders really read their sets: `* 0.0` was folded away,
  no groups at all, and the plant passed), an unaligned offset given to `setVertexBuffer` (fails `pullLayouts`).
- **Left** (backlog "Pulled vertices' leftovers"): a program with no group free stays refused; the cost isn't measured,
  as nothing we run but these tests meets it.

## VK4 T10: copies and resolves WebGPU refuses — 189 of a sample's failures to 0 of those causes

**2026-10-30.** JSON in `results/vk4/t10/`: `base/` before (2,509 cases: samples of `image_to_image`, `resolve_image`,
`depth_stencil_msaa_copy`, buffer ↔ depth and stencil copies, `depth_stencil_resolve` and `multisample_resolve`),
`wide/` after (13,879: larger samples of the same and of `blit_image`), `m4/` the list's new cases on the M4 (Metal,
Chrome for Testing 153.0.8010.12). `bench/gpu/deqp-run.ts vk`, SwiftShader on the dev VM, Chromium 153.0.8010.52.

| run | cases | pass | fail | not supported |
|---|---|---|---|---|
| before | 2,509 | 76 | 189 | 2,244 |
| after, the same 189 alone | 189 | 176 | 13 | 0 |
| after, the wide sample | 13,879 | 1,170 | 84 | 12,625 |
| the M4, the 1,128 new cases | 1,128 | 1,091 | 37 | 0 |

- **What changed:** copies between formats go as bytes through a temporary buffer (no compute copy was needed: the
  buffer forms take any format, and a block maps to a texel); multisampled copies and the resolves WebGPU refuses are
  draws, a single draw shaded per sample for a copy (`sample_index`, not a mask and a pipeline a sample); depth16's parts
  and offsets; whole depth and stencil copies through WebGPU's path (`depthStencilTT` had tested buffer usages).
  **Beside the brief:** partial resolves were wrong, not refused: `vkCmdResolveImage` dropped its offsets and extent.
- **Stencil8's resolves were never about stencil:** the test's fragment stage writes `gl_FragDepth`, and WebGPU refuses
  that pipeline against `stencil8`, so nothing was drawn. A module with the output at a location no target takes fixed
  those and the colour-only `load_store_op_none` cases, T9's item.
- **Blits, the census's "other blits":** 32-bit float and 16-bit norm linear blits are filtered in the shader, integer
  blits clamped into the destination's range, Vulkan's rule (`r32g32b32a32_sint` into `r16g16b16a16_sint`).
- **The 84 left of the wide sample are others':** 67 multisampled images of several layers (T12: WebGPU has no
  multisampled arrays) and 17 `max_attachments_4_samples_4`, an input attachment of its own pass (T12's feedback loops).
  None of T10's causes is left among them.
- **The M4's 37** are out of the list (backlog "The M4's own failures"): 22 `generate_mipmaps.from_previous_level` (the
  census's M4 cause, T12), 11 copies of `e5b9g9r9`, 4 stencil resolves with a sample mask.
- **Cost:** not measured: no program of the replays runs these paths. Whole depth and stencil copies should be cheaper
  than the passes they replace; that is expected, not a measured speedup. A buffer round trip per copy between formats
  costs what a temporary buffer of the region costs.
- **A resolve into a 3D image** has no dEQP-VK case the device runs (`m10_resolve` asks for what isn't advertised): it
  and a multisampled copy within one image are driver tests (`misc: …`, tests/venus-driver.test.ts). Planted: 3D kept
  to WebGPU's resolve, and the within-image copy without its temporary texture: both tests failed.

## VK4 T3: usage scopes — a pass or dispatch that writes storage of a memory it reads otherwise is no longer dropped

**2026-10-30**, the dev VM's SwiftShader (Chromium 153.0.8010.52); JSON in `results/vk4/t3/`. Each `VkDeviceMemory` is
one GPUBuffer, and WebGPU's usage scope (a dispatch; a whole render pass) refuses a buffer bound as writable storage
beside any other usage of it. Before T3 only a dispatch's read-only storage beside storage it wrote elsewhere was served
(bound writable, VK3 L6c); everything else lost its pass or dispatch and its submit.

- **The fix** (vk/README.md "Usage scopes"): the replay scans each scope before it begins (a render pass's commands to
  its end, secondaries included; a dispatch's bound groups and indirect arguments). Where it reads a GPUBuffer it also
  binds writable, those reads are copied into the device's shadow buffer and bound from there: bind groups of the
  scope's own, and vertex, index and indirect buffers at their places. Each buffer's read ranges are merged into spans
  copied once. A dispatch's read-only storage disjoint from what it writes is still bound writable (no copy); one
  overlapping it is copied, since two writable bindings of one range are refused too ("binding aliasing").
- **Tests, failing first** (`tests/venus-driver.test.ts`, wg_test.c `wgt_scope` and misc 33–35), each with WebGPU's own
  error before the fix: a render pass whose fragment stage writes storage of the memory of its vertex buffer, index
  buffer, uniform buffer, a storage buffer its vertex stage reads, its indirect arguments, all of them, or what an
  earlier draw of the pass reads; a dispatch whose uniform buffer, indirect arguments or read-only storage over the very
  range it writes share its memory; and one that holds without a fix (a compute set bound inside a pass is recorded at
  its dispatch, outside the pass, so it never takes the pass's copies). 84 of 84 pass.
- **dEQP-VK doesn't meet it in the direct set.** The old module over the likeliest groups whole (`ssbo`, `memory`,
  `ubo`, `binding_model.descriptor_copy`, `compute.pipeline.basic` and `indirect_dispatch`,
  `draw.renderpass.indirect_draw`: 32,607 cases, 2,193 s; 14,178 pass, 196 fail, 4 resource errors) logged no
  usage-scope error (`groups-old.json`); its 200 cases that didn't pass fail the same with the fix (`failed-new.json`).
  dEQP-VK allocates a memory per buffer; T1 said the census couldn't see this cause, and it can't.
- **vkd3d's suite** (`TESTS=all node bench/vulkan/vkd3d.ts`, new: each of d3d12.c's 175 tests a process of its own,
  since the whole suite in one dies at `test_clear_unordered_access_view_image`; `vkd3d.ts lines` names a run's failing
  tests): 109 pass, 58 fail, 9 crash in the guest, the same before and after, failure for failure (`vkd3d-old.txt`,
  `vkd3d-new.txt`), and no usage-scope error: vkd3d gives each committed resource a memory of its own. So **no program
  measured here meets the cause**, and the copies' cost on one is open (backlog "Usage scopes' leftovers": DXVK, a
  VMA-based program; vkQuake met the dispatch's shape in VK3 L6c).
- **What it costs where nothing conflicts: nothing measurable.** VK0's scene (`guest.ts venus`, the desktop guest,
  three rounds alternated against the module before T3, `scene/`), ms a frame: 1,000 fish 216.2–218.0 before,
  212.5–217.1 after (1,119 draws a frame in one pass, each scanned); the toolkit at 2,000 20.7–22.1 and 20.1–21.5, at
  8,000 53.8–54.1 and 50.4–55.2; the GPU worker 1.0–1.2 ms busy a frame on both. The rounds overlap.

## VK4 T19: the renderer out of memory 0 — Venus's renderer and window in memory 1

**2026-10-30.** Measured first (bench/spike/memory/REPORT.md §6): one memory64 costs ~+15–20% on the userspace
benchmark on macOS, so the user set it aside. Built instead: memory 1 is the renderer's own memory, with the module's
stack, data and heap in an arena of 1,280 MiB at its bottom (web/ram.ts `VENUS_ARENA`; `vk/wasi/arena.c` stops the heap
there), the host-visible window after it (`VmConfig.window_at`, ABI 55), then node 1's RAM if the machine has one. The
guest reaches the window as it reaches node 1: JIT code through the memory-1 arm of each load and store, which every
Vulkan machine's modules now carry. **Memory 0 holds 3,071 MiB of RAM with Vulkan as without** (it was 2,560), and the
first NUMA node holds at most 2,560 MiB beside the arena and window.

**What it costs the guest** (`bench/vulkan/apps-load.ts` through `bench/gpu/sway-mac.sh`: the desktop guest at 2,560 MiB, all
of it in memory 0 on both arms, 4 vCPUs, sway on GLES, each program warmed 20 s and measured 15 s; Apple M4, Chrome for
Testing 153.0.8010.12, macOS 26.6.2; the base is 19f9c740's core, renderer and page, three rounds alternated; JSON in
`results/vk4/t19/`):

| program | window in memory 0 | window in memory 1 | |
| --- | --- | --- | --- |
| vkcube | 1.38, 1.48, 1.48 ms of CPU a frame; 60 frames/s | 1.45, 1.47, 1.50 ms; 60 | the same (rounds overlap) |
| mpv on Vulkan, decoding in software (`--hwdec=no`, Sintel's VP9 480p) | 404, 405, 410 ms/s (16.2–16.4 ms a frame); the guest 14% busy | **436, 436, 436 ms/s** (17.4–17.5); 15% | **+7.5% of mpv's CPU**, rounds clear; 25 frames/s both |
| gtk4-demo's fishbowl, GSK on Vulkan | 272, 304, 448 ms/s; 54–59 frames/s | 304, 404, 420 ms/s; 55–59 | the rounds spread past any difference |

- **mpv in software is the window's heaviest writer**: each decoded frame is copied into mapped host-visible memory,
  through the arm. Its +31 ms of guest CPU a second is the layout's price where it shows. vkcube's command streams are
  too small to see.
- **Host-visible memory's heap** (T2's last step): its own heap of 1 GiB, the arena's (`vk/driver/wg_device.c`; the
  budget counts each heap apart). `memory.allocation.random` and `memory.mapping.suballocation.random` pass, all 300,
  the arena at 242 MiB at their peak (`results/vk4/t19/random-1g-heap.json`), and join the list (7,209 → 7,509).
- **Not measured apart**: the arm's code in every Vulkan machine's modules (on spill machines: 15% more wasm bytes, the
  same compile time, docs/spill-memories.md). It is inside these numbers.

## VK4 T2 (blocked on T19): the renderer's robustness — dead contexts leaked their devices, imports of our own exports were fatal

**2026-10-29**, the dev VM's SwiftShader (Chromium 153.0.8010.52); JSON in `results/vk4/t2/`. What took Vulkan down
for the guest, each reproduced through `bench/gpu/deqp-run.ts vk` (`CASES`) and fixed:

- **A context destroyed with objects left them in the driver.** vkr destroys a dead context's devices, memories and
  syncs in the driver only on the render server's worker thread (natively each context is a process, whose exit frees
  them); in our one module every killed or crashed program leaked its devices, and the 17th failed to be made ("wg:
  more than 16 devices at once"), with its host-visible memory left in the arena. So the cases after a few crashes
  failed too: dEQP-VK's runs met "crashes after enough earlier cases" (`memory.*.random`, T1's `r12x4`). vkr's patch
  now takes the worker thread's way (without its idle wait, which the driver can't make).
- **The guest's export imported again** (`api.external.memory.{opaque_fd,dma_buf}`, T1's `dup2`): our blobs are shared
  memory without fds, which vkr's import refused; the guest allocates without waiting for the result, so its later
  free named a memory vkr never made ("vkFreeMemory resulted in CS error"), fatal for the context. 8 of the group's
  first 12 cases crashed and the run stopped there (`before-extmem.json`); now such an import aliases the exported
  memory (vkr passes its handle as an opaque fd; the driver counts references), and every one of the group's 80
  supported cases passes (16 image cases aren't offered).
- **Host-visible memory on a 2 GiB heap the arena can't back** (open: T2 is blocked on T19). dEQP's random
  allocations keep up to an eighth of each heap allocated, so up to 256 MiB of host-visible memory in a 255 MiB arena:
  the 300 `memory.*.random` cases pass in one run, with the arena's high-water mark at **241.4 MiB** (`one-heap.json`);
  a little more, and an allocation fails as above. A heap of its own of 128 MiB for host-visible memory took the same
  run to **99.3 MiB** (`heap128.json`) and passed both dEQP-VK lists, but every program replay failed: GFXReconstruct
  maps a host-visible type only onto a heap of at least 1 GiB (smaller ones it takes for a discrete GPU's BAR window,
  `portability.cpp` `kMinHeapSize`), and VMA and DXVK budget alike. Reverted: the one heap stays, and the random groups
  stay out of the list until the arena can back a heap of ~1 GiB, which needs the renderer out of memory 0 (T19). The
  memory budget (`VK_EXT_memory_budget`, advertised but unfilled before) now reports the heap and its use.
- **A sync freed while a submit names it**: a held submit's replay (a timeline wait met later) signalled a destroyed
  fence through its freed type, `RuntimeError: function signature mismatch` in Node (`tests/venus-renderer.test.ts`);
  NVIDIA's one-off "table index is out of bounds" in `wg_complete` (VK3 L9b) is the likely same. Destroyed syncs are
  dropped from pending and held submits now.
- **A virtio reset kept Venus's contexts**: the rebooted guest's contexts, whose ids vkr already had, weren't made.
- **`max_workgroup_memory.*`** "crashed": SwiftShader compiles a pipeline with a 16 KiB zero-initialized workgroup array
  in **16.8–17.3 s** through Vulkan's zero-init extension, which Dawn uses where the device has it, against **19 ms**
  with Tint's own loop (the extension disabled; `bench/results/local/t2/wgmem.ts`, workgroup sizes 1, 64 and 247 alike;
  a 64-element array: 72 ms); with dEQP's other compiles, past its 30 s watchdog. dEQP-VK's runs disable the extension.
- **`image_format_properties2.2d.optimal.r12x4_unorm_pack16`** isn't a crash: a YCbCr format adds `DISJOINT` to the
  case's create flags, ~340,000 synchronous queries, and the case passes in **34 s** with the watchdog off
  (`r12x4-nowatchdog.json`): ~0.1 ms a round trip through Venus's ring, T13's concern; out of the list.

The pass list 7,126 → 7,209 cases (the external memory and the workgroup memory).

## VK4 T1: a census of dEQP-VK — 17% of the supported cases fail, two in five of them the samplers'

**2026-10-29.** JSON in `results/vk4/t1/` (`swiftshader/`, `m4/`: one file a boot; `census.json`: every case that
didn't pass, by cause; `new-passes/`: the list's new cases run as one list). Every 100th case of `vk-main.txt` (the
mustpass list of the direct set's groups, 1,648,812 cases: 56% of them `pipeline`), 16,489 cases, as four boots of
`bench/gpu/deqp-run.ts vk` (`STRIDE=400`, `OFFSET` 0, 100, 200, 300; `DETAIL` for every case that didn't pass), on the
dev VM's SwiftShader (Chromium 153.0.8010.52) and on the M4 (Metal, Chrome for Testing 153.0.8010.12, macOS 26.6.2)
through `bench/gpu/sway-mac.sh`; 96–137 s of deqp-vk a boot there, 80–107 s on the M4. Classed by
`bench/vulkan/census.ts` (rules on the case's name and dEQP's messages, read against the renderer's warnings of each
boot; the first that matches wins): of 500 and 545 failures, 1 and 3 aren't classed.

| host | cases | pass | fail | crash | not supported | not passed of supported |
|---|---|---|---|---|---|---|
| SwiftShader | 16,489 | 2,448 | 498 | 2 | 13,541 | 500 of 2,948 (17.0%) |
| M4 | 16,489 | 2,751 | 543 | 2 | 13,193 | 545 of 3,296 (16.5%) |

By cause, ranked by consequence (tier 1 a crash, 2 work WebGPU refuses, so nothing drawn, 3 wrong results), then
count; the task is VK4-KICKOFF.md's:


| cause | tier | swiftshader | m4 | task |
|---|---|---|---|---|
| deqp-vk crashed or hung (a lost device) | 1 | 2 | 2 | T2 |
| copies between formats (size-compatible, compressed ↔ uncompressed) | 2 | 93 | 112 | T10 |
| integer cube textures sampled with a sampler (the stage refused: "an integer texture sampled with a sampler") | 2 | 31 | 31 | T8 |
| an attachment also read as an input attachment with a self-dependency (a feedback loop WebGPU refuses) | 2 | 20 | 27 | T12 |
| vertex attribute offsets and strides that aren't multiples of 4 (the pipeline refused) | 2 | 22 | 22 | T5 |
| texture offsets that aren't constants after optimization (the stage refused) | 2 | 14 | 14 | T9 |
| integer resolves | 2 | 3 | 3 | T10 |
| multisampled images of several layers (WebGPU has no multisampled arrays: the texture refused) | 2 | 2 | 3 | T12 |
| a format advertised for the use but refused at image creation (`VK_ERROR_FORMAT_NOT_SUPPORTED`) | 2 | 2 | 2 | T12 |
| copies of multisampled images | 2 | 1 | 1 | T10 |
| `gl_ClipDistance` read in a fragment shader (inputs past the varyings) | 2 | 1 | 1 | T9 |
| compressed images whose size isn't whole blocks (ASTC's 5-, 6-, 10- and 12-texel blocks): the texture padded to whole blocks, so coordinates land wrong and cube views of it are refused | 3 | 102 | 102 | T18 |
| component swizzles (image views' component mapping) | 3 | 55 | 62 | T8 |
| border colours | 3 | 47 | 48 | T8 |
| integer textures sampled with a sampler (address modes, LOD: fetched at clamp-to-edge) | 3 | 35 | 18 | T8 |
| unnormalized coordinates | 3 | 25 | 28 | T8 |
| clears of several layers or array layers past the first (another layer's value, or none) | 3 | 15 | 18 | T12 |
| blits generating mipmaps (on the M4 over 6 layers; 32-bit float linear) | 3 | 4 | 16 | T12 |
| the sampler's LOD bias and min/max LOD | 3 | 10 | 11 | T8 |
| other blits (32-bit float and 16-bit unorm filtering, 3D) | 3 | 5 | 4 | T10 |
| blends with both CONSTANT_COLOR and CONSTANT_ALPHA (WebGPU has one constant) | 3 | 0 | 4 | T12 |
| `descriptorset_random`'s sets of four (a copy buffer reads zeros) | 3 | 0 | 3 | T12 |
| multisampled rendering (several subpasses, sample masks) | 3 | 3 | 3 | T12 |
| not classed (below) | 3 | 1 | 3 | — |
| `textureQueryLod` | 3 | 2 | 2 | T9 |
| 16-bit types in storage buffer layouts | 3 | 2 | 2 | T12 |
| push descriptors pushed twice for one binding (`numcalls2`) | 3 | 2 | 2 | T12 |
| clears of multisampled integer attachments | 3 | 1 | 1 | T12 |

- **The samplers' causes are 203 of SwiftShader's 500** (integer cube textures, swizzles, border colours, integer
  textures' address modes and LOD, unnormalized coordinates, LOD bias and clamps: T8); a sixth of them (the integer
  cubes) are stages the translator refuses, not wrong pixels. Component swizzles (55 and 62) weren't in T8's brief:
  Vulkan requires them, the driver ignores them (vk/README.md "Not yet").
- **Compressed images whose size isn't whole blocks** (102 on each host, not in the backlog): WebGPU wants a
  compressed texture's level 0 in whole blocks, so the driver makes it padded (a 13×13 image of ASTC 8×5 is a 16×20
  texture); sampling then reads a texture larger than the image (normalized coordinates land wrong), and a cube view of
  it is refused ("width (16) and height (20) are not equal"). On SwiftShader ASTC 4×4 and 8×8, whose blocks divide
  dEQP's power-of-two sizes, pass 13 of 15 `pipeline` cases; the other blocks fail 102 of 107. Same counts on Metal:
  the driver's, not SwiftShader's (the backlog's "ASTC and ETC2 on SwiftShader fail sampling" was this). A new task, T18.
- **Copies between formats** (93 and 112: T10) are the largest cause of dropped work; then integer cube textures (31),
  vertex strides that aren't multiples of 4 (22: `vertex_input.multiple_attributes`' 8- and 16-bit attributes, T5),
  feedback loops through input attachments (20 and 27, T12) and non-constant texture offsets (14, T9).
- **Two crashes, the same on both hosts**: `api.info.image_format_properties2.2d.optimal.r12x4_unorm_pack16` (a
  format query) and `api.external.memory.opaque_fd.dedicated.device_only.dup2`, neither in the backlog (T2). No case hung; no boot stopped early.
- **Smaller new causes** (T12): clears of several layers or of layers past the first (15 and 18: another layer's
  colour, or the clear value cut to 8 bits for `a2b10g10r10_uint`), a 16-bit packed colour format with depth refused
  at image creation though advertised (`render_to_image.*.a1r5g5b5_unorm_pack16_d32_sfloat_s8_uint`,
  `r5g6b5_unorm_pack16_d24_unorm_s8_uint`: `VK_ERROR_FORMAT_NOT_SUPPORTED`), `int16_t` in storage buffer layouts (16-bit
  storage is advertised), push descriptors pushed twice for one binding, and on the M4 three
  `descriptorset_random.sets4` cases and four dual-source blends with both blend constants.
- **What the census can't see**: `vk-main.txt` holds the direct set's groups, so usage scopes (T3), mutable images'
  views (T4: `image.mutable` isn't in it), synchronization (T6) and API 1.3's features (T7: their groups are outside it
  or not supported) aren't counted; they rank by the programs that meet them (the kickoff's reasons stand). 82% of the
  sample is not supported (rasterization 150 of 150, compute 670 of 676, query pools 191 of 193 on SwiftShader): the
  features VK4 doesn't advertise.
- **Why not supported** (the M4's sample again with `DETAIL_NOTSUPPORTED=1`, `m4-notsupported/`: the reasons of its
  13,187): **a compute queue without graphics** 2,427 (18%: "No matching queue found … requiredCaps=0x2,
  excludedCaps=0x1", 1,984, mostly `pipeline`, and "Exclusive compute queue not supported", 443: the device has one
  queue family; a second, compute-only one over the same WebGPU queue would open them), `VK_KHR_maintenance*` 711,
  protected access 524, cooperative matrices 518, formats (not supported, for transfer, as source or destination;
  D16S8; 3-component and packed formats sampled) ~2,000, multi-draw 196, `filterMinmaxImageComponentMapping` 195,
  pipeline statistics queries 188, 3D ASTC 187, tessellation 172 and geometry 156, custom border colours 151,
  mirror-clamp-to-edge 149, mutable descriptor types 143, depth resolve modes 130, ray tracing 129, LOD biases past
  the limit 108, border colour swizzles 104; the long tail below 100 each.
- **The pass list** (`tests/deqp/vk.txt`): 4,725 → 7,126, every case of the census that passed and wasn't in it (2,401;
  memory's random allocations and the large workgroup memory left out, as before); run as one list on SwiftShader
  they all pass, in 240 s of deqp-vk (`new-passes/`); `scripts/ci-deqp-vk.sh` went green with them, 1,148 s
  (the list's test 861 s, its limit 1,500 s). VK2 L5's samples (21,485 cases by group, before VK3) had 670
  not passed of 4,948 supported (13.5%), a different sample: its groups' strides made `pipeline` 7% of it, against 56%
  here, so the shares don't compare.

## VK3: the summary — Venus right on NVIDIA, the adapter's features and §4's emulated rows

**2026-10-28, at the track's end (L8); closed 2026-10-29 after the user's final NVIDIA runs and L9.** VK3 ran 2026-10-26
to 10-29 as loops under a supervisor (`VK3-KICKOFF.md`, `VK3-HANDOVER.md`: `git show 1fce4c0a:VK3-HANDOVER.md`,
"Things worth not re-discovering"), five of the user's NVIDIA runs and eight out-of-context reviews
between them. Each loop's section below has its numbers; JSON in `results/vk3/<loop>/`. Hosts: the dev VM's SwiftShader
(Chromium 153.0.8010.52), the M4 (Metal, Chrome for Testing 153.0.8010.12, macOS 26.6.2) and the user's RTX 3070
(NVIDIA 615.71.09, Arch's Chromium 153.0.8010.52; Dawn on Vulkan, ANGLE on NVIDIA's GL).

**What each loop landed:**

| loop | landed | JSON |
| --- | --- | --- |
| L1 | NVIDIA's black frames: the device's NVIDIA vendor ID sent Venus's guest WSI down Mesa's prime blit (frames into a buffer that isn't shared); NVIDIA reported as an unknown maker; a GPU way checked against a readback at its first copies, dropped for the next way if wrong | `l1/` |
| L2 | the fence's floor: the ring poller off a clamped nested `setTimeout(0)` (4.4 ms on Linux, 6 on the Mac) onto `Atomics.waitAsync`, empty submits nudging Dawn's slow look; the fence's breakdown in the render stats | `l2/` |
| L2b | the tools for NVIDIA's 1 fish (`vkgputime`, `vknudge`, frame-shaped submits, a trace); "the GPU works ~0.3 ms" was the CPU's clock at replay | `l2b/` |
| L3 | pipelines made asynchronously (a submit held for its pipelines), translated shaders kept across runs in IndexedDB (32 MiB, the origin's) | `l3/` |
| L4–L4c | the M4's green VA-API chroma under libplacebo's advanced path: narrowed by experiment (L4), found by a static review (a window page lost between Venus devices) and fixed with eleven more of its findings (L4c) | `l4/`, `l4b/`, `l4c/` |
| L4d–L4e | a cold first mpv's frozen window: Mesa 26's async present drops a present after one that failed; the desktop image presents synchronously (`VN_PERF=no_async_present`); the advanced path on by default | `l4d/`, `l4e/` |
| L4f, L5b | the out-of-context reviews' remaining findings (translator, driver; then L4f's own): fixed with tests or filed; dual-source blending implemented; API 1.3 kept, its gaps filed | (handover, backlog) |
| L5 | WGSL's subgroups (held where the page's check finds them wrong: the M4), 16-bit storage, `shaderFloat16`, tier2's read-write formats | `l5/` |
| L6a | per-face stencil, occlusion queries on the GPU, timeline waits before their signal | (handover) |
| L6b | texel buffers, the depth and stencil copies WebGPU refuses, bind groups kept across submits; dEQP-VK on the M4 (3,547 pass, 7 fail, the rest subgroups held) | `l6b/` |
| L6c | vkQuake's first frame (L5b's writable compute SSBOs made a usage-scope conflict); the replays in ci-deqp-vk.sh; the L5–L6a review's 8 findings | `l6c/` |
| L7.1, L7.1b | Dawn's row (indexed descriptor arrays of every kind, sample-rate shading); opaque-fd semaphores made; Dawn in the guest's Chromium still not on Venus (the guest's Mesa) | `l71/`, `l71b/` |
| L7.2, L7.3 | YCbCr conversions (8-bit multi-planar formats), on by default since GTK 4.24 aborts without them; GTK4's black frames were L4c-D's partial clear; GTK4 takes GL by itself | `l72/`, `l73/` |
| L7.4 | ANGLE's ES3 row (13 uniform buffers a stage, the last vertex provoking, transform feedback, attachment-less passes): WebGL 2 on Venus in the guest's Chromium | `l74/` |
| L7.5 | vkd3d's row (draw parameters): vkd3d 1.19 makes a feature level 11_0 device | `l75/` |
| L7a, L7b | the reviews after L7: one count of the bindings WebGPU takes, the advertised limits from it, a pipeline past them refused saying why; the rest (odd 16-bit index ranges, indirect draws captured, `interpolateAt*`, …) | `l7a/`, (L7b: tests) |
| L9a, L9b | the final NVIDIA run's findings: Venus's submits done ~2 ms later there than at L4e, located in Dawn's `Queue::Submit` (the GPU process's CPU), not reproduced elsewhere, none of the suspects (`?gpu=vkl9=`): filed; an integer texture's explicit LOD clamped to its levels (NVIDIA read past them as zeros); a completion that throws no longer completes later submits early | `l9a/`, `l9b/`, `nvidia-final/`, `nvidia-l9/`, `nvidia-l9b/` |
| L8a | the track-end review: copies and blits within one buffer or subresource (WebGPU refuses them), the provoking vertex's and a capture's index ranges bounded to the draw's, attachment-less passes at the pipelines' samples (secondaries in them too), descriptor copies keeping immutable samplers; its 5th wrong (Vulkan forbids xfb across a suspend) | (tests) |

dEQP-VK's pass list grew from VK2's 1,463 cases to **4,690** (`tests/deqp/vk.txt`), with **773** more for YCbCr
(`tests/deqp/vk-ycbcr.txt`), all passing on SwiftShader in CI (below).

**The gate, row by row** (VK3-KICKOFF.md "The gate", in git history):

| gate item | SwiftShader and the M4 | the user's NVIDIA desktop |
| --- | --- | --- |
| vkcube and mpv on Vulkan visible and right on the page's screen | **met**: every way right on the M4 (`l1/mac-ways.json`; a broken bitmap way dropped for canvas, `l1/mac-bitmap-broken.json`), readback on SwiftShader (`l1/swiftshader-nvidia-sh.json`) | **met** at 5b9654ac, 4fdc69fb and c8087cb0: vkcube and mpv right in every way, the page on bitmap (`nvidia/present/`, `nvidia-l4e/present/`, `nvidia-final/present/`) |
| mpv meets its bar (no drops, the guest ≤ 19–27% busy) | **met** on the M4: 0 dropped, 14 and 13% busy, synchronous presents and the advanced path on (`l4e/mpv-mac-sync.json`) | **met** at 4fdc69fb: 0 dropped, 14 and 12% (`nvidia-l4e/mpv/`); at c8087cb0 0 and 1 dropped of 538 and 532, 14 and 12% (`nvidia-final/mpv/`) |
| VK0's scene no dearer a frame than virgl at every size | **met**: M4 1 fish 0.85–0.88 against 0.87–0.96 ms, 1,000 fish 2.50–2.55 against 4.55–4.61, toolkit 0.81 against 3.27–3.46 (`l2/scene-mac-*`; L6b's bind groups the same or lower, `l6b/bind-groups/`); SwiftShader 10.0 against 10.4–13.1 at 1 fish (`l2/scene-swiftshader-*`) | **1,000 fish and the toolkit met** (5.7 against 8.7–8.9 ms; 3.05–3.19 against 6.81–7.43: `nvidia-l4e/scene-*`); **1 fish not** (2.5 against 1.5), parked by the user: the scene clause is held at 1,000 fish and the toolkit; at c8087cb0 still met there (6.0–6.4 against 9.0; 4.3 against 6.8–7.0) but Venus 5–40% dearer than at 4fdc69fb (its submits done ~2 ms later: "VK3: the final NVIDIA run", filed) |
| the programs' replays within their tolerances | **met**: vkcube, vkmark's 13 scenes, vkQuake (1.7%, tolerance 3%) in `ci-deqp-vk.sh` on SwiftShader (below; `l6c/vkquake-fix.json`); the M4's as in VK2 (`../vk2/l5/`) | **met** at 4fdc69fb and c8087cb0 (`nvidia-l4e/replay/`, `nvidia-final/replay/`) |
| each emulated row: its dEQP-VK groups in the pass list | **met**: Dawn's 173 cases (L7.1) and `interpolateAt*`'s 18 (L7b), ANGLE's ES3 175 (L7.4), vkd3d's 73 (L7.5), YCbCr's 773 (L7.2) | **met** at c8087cb0 but for 2 cases: 4,624 of 4,690 pass (64 NotSupported: ASTC/ETC2, a subgroup size), 773 of 773; the integer texture's LOD fixed in L9b (passes at 2850df53), `memory.binding.*.buffer_1048577` fails there only (filed) (`nvidia-final/deqp-*`, `nvidia-l9b/`) |
| each emulated row: the program it brings runs right | ANGLE's ES3 in the guest's Chromium: right against ANGLE on virgl's GL (`l74/angle-es3.json`; 205 for 156 with Chromium's own Vulkan device too, an sRGB view: filed); vkd3d: a device at 11_0, its draw tests pass, three tests fail on filed gaps (`l75/vkd3d.json`); **Dawn's program not run** (the guest's Mesa hands back fd 0 for opaque-fd semaphores: backlog); GTK4 takes GL by itself, GSK on Vulkan (forced) right but under GTK4's bar (`l73/`). Not as replays against lavapipe: the programs' own checks | **as on SwiftShader** at c8087cb0: ANGLE's probe the same, vkd3d the same counts (`nvidia-final/rows-*`) |
| pipelines: a second run pays no compile its first paid | **met** for the translation on both (vkQuake 271 → 12 ms on SwiftShader, 228 → 9 on the M4; across a restart 11 ms on the M4, `l3/`); the browser's compile kept across a restart on Metal (vkQuake's 17 ready in 18 ms), not on SwiftShader | **met** at f55eacd7, 4fdc69fb and c8087cb0: warm across a restart 0 misses (`nvidia-l2b/pipelines-*`, `nvidia-l4e/pipelines-*`, `nvidia-final/pipelines-*`) |

So the gate is met on SwiftShader and the M4 but for Dawn's program, and on the user's NVIDIA desktop (the final runs:
c8087cb0's code, then L9's at 2850df53) but for 1 fish (parked) and one NVIDIA-only dEQP-VK group (filed); the
adapter's subgroups of 32 are right there and not held. Left open, by the user's call (2026-10-29): Venus's submits
done ~2 ms later on NVIDIA than at 4fdc69fb (docs/backlog.md "Venus's submits ~2 ms later on NVIDIA since 4fdc69fb").

**The numbers the kickoff asked for:**
- *The fence's breakdown:* on the M4 and SwiftShader in "VK3 L2" (`l2/`: the guest's fence 4.32 → 1.05 ms at 1 fish
  on the M4; a submit's fence 3.1 → 1.0 ms on SwiftShader); on NVIDIA in "VK3: the NVIDIA run after L2" and "after
  L2b" (`nvidia/fence.json`, `nvidia-l2b/fence.json`: a trivial submit done in 0.15 ms, a lone real pass 2.2 ms late,
  1.2 nudged, at once while submits keep coming; the scene's pass 0.87–0.89 ms of GPU against the M4's 0.41).
- *Pipelines cold and warm:* "VK3 L3" (`l3/m4/`, `l3/swiftshader/`) and NVIDIA's in "after L2b" (`nvidia-l2b/pipelines-*`:
  16 new pipelines one by one 1.94–1.99 s with WebGL stalled throughout, made at once 0.51–0.54 s).
- *Each row's cost:* none where a program uses none of a row's features: what a row adds is a program variant, a
  compute pass or a copy only on the draws that ask for it (L7.1's tree of ifs, a compare a level, only in a shader
  indexing an array dynamically; L7.4's provoking-vertex index pass and transform feedback's capture pass per such
  draw, hoisted before or run after its render pass, never a break; L7.5's three words of the push buffer and a copy
  per indirect draw that reads them; L7.2's planes, only where a sampler converts). Measured on programs that use
  none of them: VK0's scene through L4c's loops and L6b's bind groups (`l4c/*-scene-1000-*`, `l6b/bind-groups/`:
  rounds overlapping or lower). **Not measured on a program that uses them** (ANGLE's flat varyings and captures,
  vkd3d's draws): backlog "ANGLE's row's gaps", "vkd3d on Venus".
- *The module* (`target/vk/venus.wasm` at the track's end): 12,633,715 bytes (12.05 MiB), 1.24 MiB with gzip -9,
  0.74 MiB with brotli (VK2's: 11.9, 1.18, 0.69).

**The final NVIDIA run** (VK3-HANDOVER.md "What the next NVIDIA run must answer", in git history): `bench/vulkan/nvidia.sh page
<bundle> ~/webpc-vk2`, the bundle built by `bench/vulkan/nvidia-bundle.sh` at the track's last commit (now ~4.8 GB:
the dEQP-VK guest and vkd3d's disk joined it). Its steps: `present`, `replay`, `fence`, `scene`, `trace`,
`pipelines` and `mpv` as in the run of 4fdc69fb, on L5–L7b's code; then, new in L8, `deqp` (both pass lists on the
RTX 3070: dEQP-VK has never run on NVIDIA) and `rows` (ANGLE's ES3 probe and vkd3d's tests in the desktop guest);
`results/summary.txt` gives each step's verdict and **whether the page held the adapter's subgroups** (L5's question:
the line `venus: the WebGPU device's subgroups are wrong in divergent control flow` in any step's page log, or real
subgroups of 32, then mpv's frames and the list's ~720 subgroup cases say whether they're right). ~75 min whole.
`VK2_DRY=1 VK0_ANY_ARCH=1 bench/vulkan/nvidia.sh page - <dir>` prints every step's command without a bundle. The new
steps' commands and summaries ran on the dev VM's SwiftShader (`results/vk3/l8/`): ANGLE's probe on Venus `flat
0,0,255,255`, the capture and `ubo 156` as before; vkd3d a device at 11_0 (11_1 and up refused), test_draw_instanced,
test_draw_indexed_instanced and test_root_constants pass, test_vertex_id still fails 39 of 89 (so L7b's indirect
captures weren't its cause alone) and test_instance_id 84 of 372; a 28-case slice of the list through `deqp-run.ts`
all pass.

**CI at the track's end** (the code at 72d2f561, this loop's changes being scripts and docs; one at a time, alone):
`scripts/ci.sh` OK (532 s); `scripts/ci-deqp-vk.sh` OK (846 s: the 4,690-case list in 588 s, YCbCr's 773 in 89 s,
the replays 169 s); `scripts/ci-debian.sh` OK (416 s); `scripts/ci-machines.sh` OK (168 s). steps.txt unmoved.

## VK3: the final NVIDIA run — right everywhere, subgroups of 32 right, but Venus's submits done ~2 ms later than at L4e

**2026-10-29.** The user ran the whole default `bench/vulkan/nvidia.sh page` with the bundle of c8087cb0 (L8a)
(`results/vk3/nvidia-final/`; RTX 3070, driver 615.71.09, Arch's Chromium 153.0.8010.52, the page on Dawn's Vulkan, as
at L4e). The first attempt stopped after its last step on the subgroups verdict (grep finding nothing under pipefail,
fixed in 5457b183); `VK2_KEEP=1 VK2_STEPS=none` finished it from the same results. The page grabs (PPMs) and the 81 MB
trace aren't committed (`bench/results/local/vk3-nvidia-final/`). Every step `done`.

**The questions** (VK3-HANDOVER.md, in git history):
1. **The gate on L5–L8a's code.** `present`: vkcube and mpv right in every way (auto and bitmap take bitmap, canvas,
   readback). `mpv-frames-*`: the advanced path taken, **VA-API byte for byte software** (`vkva ~ vkno` 0 off) in
   both runs, the page's screens the same, mpv exits 0 in every arm; held, "Failed creating FBO texture" as expected.
   `replay`: as at L4e (vkQuake 1.66% of bytes over, tolerance 3%; the rest within theirs). `pipelines`: warm across a
   restart **0 misses** (vkQuake translated 27 ms, ready 91 ms), cold 279 ms and 282 misses; one by one 1.97 s with
   WebGL stalled, at once 0.50–0.54 s. `fence` (fence.ts, no Venus) within 0.01 ms of L4e's. `trace`: not summarized
   (the summarizer's stack overflow on 81 MB, as at L4e's 137 MB). `mpv`: on Vulkan 538 and 532 frames, **0 and 1
   dropped**, the guest **14 and 12%** busy (GL 9 and 8%); at L4e 0 and 0.
2. **Subgroups not held:** the page's check finds NVIDIA's subgroups right, and they are: every subgroup case in the
   list passes but 11 `ballot_broadcast.compute.*_requiredsubgroupsize4` (NotSupported: NVIDIA's size is 32 only),
   and libplacebo's frames are byte for byte L4e's (which had no subgroups).
3. **dEQP-VK on NVIDIA** (first run there): vk.txt **4,624 pass, 2 fail, 64 NotSupported** of 4,690 in 465 s;
   vk-ycbcr.txt **773 of 773 pass**. NotSupported: 53 ASTC/ETC2/EAC cases (the adapter has no
   `texture-compression-astc`/`-etc2`) and the 11 subgroup sizes above. **Fail:**
   `glsl.texture_functions.textureprojlodoffset.clamp_to_edge.isampler2d_vec4_fragment` (image mismatch, 10,891 against
   0.2) and `memory.binding.regular.suballocated.buffer_1048577`; both pass on SwiftShader in CI.
4. **The rows' programs** as on SwiftShader: ANGLE's ES3 probe `flat 0,0,255,255`, the capture
   `0,0,7,1,1,2,7,1,2,4,7,1,3,6,7,1`, `ubo 156,0,0,255`, glerror 0; vkd3d a device at 11_0 (11_1 and up refused),
   test_draw_instanced, test_draw_indexed_instanced and test_root_constants pass, test_vertex_id fails 39 of 89 and
   test_instance_id 84 of 372.

**The scene** (ms a frame, two rounds; at L4e in brackets): 1,000 fish Venus 6.41, 5.97 (5.71, 5.70) against virgl
9.03, 9.00 (8.85, 8.68); toolkit 4.36, 4.32 (3.19, 3.05) against 6.96, 6.78 (6.81, 7.43); 1 fish 3.63, 3.50 (2.47,
2.59) against 1.54, 1.50 (parked). The clause still holds at 1,000 fish and the toolkit, but **Venus is 5–40% dearer a
frame than at L4e**: a submit is done 5.41 ms after it's made at 1 fish (3.28 at L4e), 6.88 at the toolkit (4.90),
7.03 at 1,000 fish (5.62); mpv's 4.85 and 5.01 (3.89, 3.99). The pass's GPU time is L4e's (`vkgputime` 0.94 against
0.91 ms) and a submit's encoding is cheaper (0.16 against 0.21 ms: L6b's bind groups), so the wait is between the
submit and its "done", in code between 4fdc69fb and c8087cb0 (the host's timers and a bare WebGPU submit's done are
unchanged: `fence`). The arms at 1 fish keep L4e's shape, each ~1 ms dearer: `vknudge=0.25` 3.50, 3.58 (2.43, 2.37), `vknudge=0` 4.36, 4.35 (2.86, 2.79). **Taken by L9**
(VK3-HANDOVER.md).

## VK3: the NVIDIA run for L9 — none of L9a's suspects is the regression; L9b's check ran nothing

**2026-10-29.** The user ran `VK2_STEPS="l9 l9b" bench/vulkan/nvidia.sh page` with the bundle of 2850df53 (after L9b;
`results/vk3/nvidia-l9/`; the host as before: RTX 3070, 615.71.09, Arch's Chromium 153.0.8010.52).

**`l9`** (VK0's scene at 1 fish and the toolkit, ms a frame, two alternated rounds; then a submit's done in ms, and the
traced GPU process's `Queue::Submit` over 0.3 ms, median):

| arm (`?gpu=vkl9=`) | 1 fish | toolkit | done, 1 fish | done, toolkit | `Queue::Submit` |
| --- | --- | --- | --- | --- | --- |
| default | 3.62, 3.60 | 4.41, 4.40 | 5.47, 5.48 | 6.80, 6.68 | 2.82, 2.85 |
| `all` (4fdc69fb's behaviour) | 3.82, 3.75 | 4.50, 4.43 | 5.60, 5.56 | 7.03, 6.87 | 2.92, 3.62 |
| `features` | 3.60, 3.62 | 4.37, 4.46 | 5.54, 5.45 | 6.78, 7.02 | 2.85, 2.76 |
| `limits` | 3.69, 3.64 | 4.41, 4.36 | 5.52, 5.48 | 6.62, 6.64 | 2.92, 2.69 |
| `bindgroups` | 3.91, 3.75 | 4.12, 4.23 | 5.62, 5.54 | 6.05, 6.46 | 2.71, 2.66 |
| `pad` | 3.71, 3.67 | 4.37, 4.37 | 5.52, 5.70 | 6.73, 6.61 | 2.86, 3.31 |

`all` is no cheaper than the default, so **the regression is none of the suspects** (the device's features and limits,
L6b's kept bind groups, L7a's padding). `bindgroups` alone is a little cheaper at the toolkit (rounds apart from the
default's) but not inside `all`, which has it: not a cause. Still outside: the rest of the 34 commits'
changes that the WebGPU stream doesn't show (L9a counted the calls on SwiftShader), and the order or timing of the
calls. Filed: docs/backlog.md "Venus's submits ~2 ms later on NVIDIA since 4fdc69fb".

**`l9b`** ran nothing: `bench/vulkan/l9b-cases.txt` named `memory.binding.regular.suballocated.buffer_1048577` (and
its dedicated twin) again after `memory.binding.regular.*`, and deqp-vk exits at once on a duplicate case (`counts {}`
in 1 s). Fixed: the list names each case once, deqp-run.ts drops duplicates, and the step reads the list from the
checkout and runs on a page already unpacked (the bundle deleted). On SwiftShader the list runs (230 cases, both
cases Pass, every not-passed case outside the pass list, `results/vk3/nvidia-l9/swiftshader-l9b.json`).

**`l9b` again** (the user, from the page already unpacked; `results/vk3/nvidia-l9b/`): 230 cases, 79 pass, 61 fail, 90
NotSupported. **`textureprojlodoffset.clamp_to_edge.isampler2d_vec4_fragment` passes** (L9b's fix confirmed).
`memory.binding.regular.suballocated.buffer_1048577` still fails, with its dedicated, overallocated and aliasing
twins: the only cases that pass on SwiftShader and fail here (the rest fail on both and are outside the pass list),
with no completion trap this time and dEQP's message not kept (DETAIL's 20 lines went to the texture cases; since,
`DETAIL_MATCH`). Filed (docs/backlog.md "`memory.binding.*.buffer_1048577` fails on NVIDIA").

**"SLUB: Unable to allocate memory from node 1"**, which the user saw on the guest's console in that run, isn't
NVIDIA's: the guest kernel prints it at 0.000000 s on every host. The session's machine has 2,560 MiB and Vulkan, and
memory 0 holds 3,071 MiB of RAM less Venus's 512 MiB (its window and renderer, web/app/worker.ts), so `splitRam` put
the last 1 MiB in a spill memory: a NUMA node of 1 MiB whose pages are all unavailable to the kernel ("On node 1, zone
Normal: … pages in unavailable ranges"), so SLUB's per-node structure for it comes from node 0. Filed (docs/backlog.md
"A Venus machine of 2,560 MiB has a 1 MiB NUMA node"; fixed since: "The renderer's arena"). The runs kept no guest kernel log unless they timed out:
deqp-run.ts now saves it (`dmesg.txt`, its warnings in results.json's `kernel`; SwiftShader's boot with the same
node: `results/vk3/nvidia-l9b/swiftshader-memory/dmesg.txt`).

## VK3 L9a: the submit-to-done regression on NVIDIA — not on the M4 or SwiftShader; Dawn's `Queue::Submit` 1 ms dearer there, the suspects switchable for the next run

**2026-10-29.** Why Venus's submits were done ~2 ms later on the user's NVIDIA desktop at c8087cb0 than at 4fdc69fb
("VK3: the final NVIDIA run"). Each arm built in the checkout: `vk/` and `web/` at the commit (`vk/build.sh`; the
core unchanged between them), the scene as `nvidia.sh` runs it (FISH="1 1000" TOOLKIT=2000 WARMUP=200 FRAMES=300), three
alternated rounds; the M4 through `bench/gpu/sway-mac.sh` (Chrome for Testing 153.0.8010.12, macOS 26.6.2, Metal), the
dev VM's SwiftShader (Chromium 153.0.8010.52, 320×180, 1 fish and the toolkit). JSON in `results/vk3/l9a/`.

**Not reproduced.** Ms a frame (median, IQR) and the frame submits' done ms, rounds 1–3:

| | 4fdc69fb | c8087cb0 |
| --- | --- | --- |
| M4, 1 fish | 0.887 (0.066) 0.99, 0.849 (0.026) 0.99, 0.869 (0.061) 1.00 | 0.806 (0.015) 0.95, 0.843 (0.040) 0.98, 0.850 (0.031) 0.98 |
| M4, 1,000 fish | 2.520 1.85, 2.486 1.84, 2.590 1.86 | 2.466 1.85, 2.543 1.84, 2.555 1.85 |
| M4, toolkit | 0.909 0.89, 0.888 0.93, 0.913 0.92 | 0.861 0.85, 0.882 0.84, 0.898 0.85 |
| SwiftShader, 1 fish | 11.29 17.4, 10.74 17.3, 10.36 17.0 | 10.49 17.0, 10.74 17.3, 10.67 16.8 |
| SwiftShader, toolkit | 10.53 17.8, 10.45 17.8, 10.34 17.5 | 10.51 17.8, 10.57 18.2, 10.44 17.5 |

The rounds overlap everywhere (c8087cb0 if anything a little cheaper on the M4: L6b's bind groups); NVIDIA's +2 ms
done (3.28 → 5.41 at 1 fish) would stand far out of either.

**Where NVIDIA's goes: Dawn's `Queue::Submit` in the GPU process.** The NVIDIA runs' traces of 2 s at 1 fish (L2b's,
L4e's, the final run's: `bench/results/local/vk3-nvidia-*`, summarized now by `node bench/vulkan/guest.ts summarize`,
whose stack overflow on 81 MB is fixed; `results/vk3/l9a/traces/`): a frame's submit (those over 0.3 ms; the rest,
nudges and the guest's fences, take ~0.01) keeps the GPU process's main thread **1.55 ms (L2b), 1.56 (4fdc69fb) and
2.53 ms (c8087cb0)** at the median (p25–p75 1.53–1.62 against 2.43–2.68), and its thread time is the same (1.51 against
2.48 ms): CPU, not a wait. With ~150–190 frames a second and the main thread busy 748 → 796 ms a second, a submit
waits behind the one before it: the done's +2 ms. SwiftShader's frame submits take 0.13 ms in `Queue::Submit` at either
commit (`swiftshader-*-summary.json`), the M4's frames don't move: whatever costs it is NVIDIA's (its driver, or Dawn's
Vulkan path there).

**The WebGPU calls are the same.** Counted per frame on SwiftShader by a temporary wrapper of WebGPU's prototypes
(`calls/swiftshader-calls.json`): 1 render pass, 120 draws, 336 `setBindGroup`s with 109 dynamic offsets, 9
pipelines, 4.3 `setImmediates`, 4.7 `copyBufferToTexture`, 3.1 `writeBuffer`s (107 KB), 10.2 `queue.submit`s at both;
the bind groups' entries (sizes, offsets), the 16 pipelines' descriptors, the 31 bind group layouts, 11 pipeline
layouts, 114 textures and 8 samplers dumped and identical. What differs: bind groups made 14.0 → 6.1 a frame (L6b's,
kept by their layouts' content), the timestamp queries' results written as two 16-byte staging copies instead of one
of 32, the memories' GPUBuffers 64 KiB longer (L7a's pad), every vertex shader a `wg_flip_z` override longer (L7.4),
and the device asked for `subgroups`, `shader-f16` and three more limits (L5, L7a), with a subgroups check at start.

**The suspects, switchable for the next run** (`?gpu=vkl9=<suspect>`, repeatable, `all`; default unchanged; vk/README.md):
`features` (no `subgroups`, `shader-f16`: also no check; with `shader-f16` every shader is translated with `enable f16;`, so on NVIDIA's adapter, not on SwiftShader's whose WGSL was compared),
`limits` (not the vertex stage's storage limits nor `maxBindingsPerBindGroup`), `bindgroups` (each pipeline's layouts
their own uids, so bind groups remade as at 4fdc69fb), `pad` (no WG_MEMORY_PAD). On the M4 `vkl9=all` brings the bind
groups made back to 4fdc69fb's (6.8, 7.7, 1.5 a submit against 2.9, 3.4, 0.5) at the same frames (1 fish 0.851,
0.850, 0.880 against 0.856, 0.808, 0.829; `m4/scene-l9{all,default}-*`), and on SwiftShader it runs clean
(`swiftshader/scene-l9all`). `bench/vulkan/nvidia.sh page <bundle> <dir>` with `VK2_STEPS=l9` (~15 min) runs the
scene at 1 fish and the toolkit for `default`, `all` and each suspect, two alternated rounds, each with a 2 s trace's
summary (`Queue::Submit`'s frame ms in its log's `trace:` line): `all` back at ~1.6 ms says it's among them, and the
single arms which; `all` still at ~2.5 says it's outside them (the 16-byte copies, the shaders' override, or NVIDIA's
host since: L4e's virgl frames are within 2% of the final run's).

## VK3 L9b: NVIDIA's two dEQP-VK fails — an integer texture's LOD past its levels (fixed), and a completion fault that cascaded (the cascade fixed, the fault not reproduced)

2026-10-29, on the dev VM (SwiftShader, Chromium 153) and the M4 (Metal, `sway-mac.sh`), with each case's
neighbours by name (`results/vk3/l9b/cases.txt`: `textureprojlodoffset.*`, `textureprojlod.*`, `texturelodoffset.*`,
`memory.binding.*`, 1,272 cases); JSON in `results/vk3/l9b/` (`swiftshader-before`, `swiftshader-after`, `m4-after`).

**`textureprojlodoffset.clamp_to_edge.isampler2d_vec4_fragment`.** The case samples a 256×256 RGBA8I texture of 9
levels at LODs from -1 to 9 (vktShaderRenderTextureFunctionTests.cpp). An integer texture sampled with a sampler is
fetched (`lower_int_sample`, vk/compiler/wgsl_nir.c), and its level was the LOD rounded to even, unclamped: 9 named a
level past the view's (WGSL's `textureLoad` there is undefined: Dawn clamps it on SwiftShader and the M4, NVIDIA's
returns zeros, so 10,891 there against 0.2) and -1 a level below 0, whose extent the negative shift below made 1
(the corner texel; the case's tolerance hid it on SwiftShader). Now the
level is Vulkan's nearest selection (`ceil(d + 0.5) - 1`, the spec's preferred rounding) clamped to the view's
levels (`textureNumLevels`). Its test, failing first on SwiftShader (LOD -1 read 300, not 110): tests/wgsl.test.ts
"an integer texture sampled at an explicit LOD…" (a 4×4 r32sint of three levels at 8 LODs, with and without an
offset). On SwiftShader 26 more of the 1,272 pass and none fewer; on the M4 none of the list's fail; 35
`texturelodoffset`/`textureprojlodoffset` clamp_to_edge `isampler`/`usampler` cases that now pass on both join
tests/deqp/vk.txt (4,725). The other address modes stay clamp-to-edge (docs/backlog.md "Samplers").

**`memory.binding.regular.suballocated.buffer_1048577`** (ten 1 MiB + 1 buffers, each filled by an unaligned
`vkCmdCopyBuffer` and read back through host-visible memory) passes on SwiftShader and the M4, and nothing in the
driver depends on the adapter there (the worker's compute copy, a 4-aligned readback within the memory's 4-aligned
size). NVIDIA's log has what the others don't: `a submit's readbacks failed: RuntimeError: table index is out of
bounds` (a trap in the module's `complete`: an indirect call through a bad pointer) and three pairs of page errors,
`mapAsync … Buffer was destroyed before mapping was resolved` then the trap. The worker's chain of completions made
one fault many: a completion that threw left the chain rejected, and the next submit's link then skipped its own
`done` and completed it at once, its readbacks not mapped (their bytes not landed: a read of them wrong, as this
case's) and their staging destroyed under the map. Fixed (web/venus-gpu.ts `gpu_submit`): each submit waits for its
own work and maps, a completion that throws is warned (`a submit's completion failed`) and the chain goes on;
tests/venus-gpu.test.ts "a completion that throws…", failing first. **The trap itself isn't found**: the indirect
calls under `complete` are the signals' (`vk_sync_signal`) and `wg_submitted`, so a sync freed while its submit was
pending is the likeliest (none found by reading: Mesa's `vk_common_QueueWaitIdle` would do it, as our wait doesn't
block, but vkr never calls it in wasm); SwiftShader with each submit's done 4 ms later (a temporary delay, NVIDIA's
submits being done ~2 ms later) ran ~9 min of the pass list without a fault (cut by its bound). Filed
(docs/backlog.md "A trap in the module's completion on NVIDIA"). **For the next NVIDIA run:** `VK2_STEPS=l9b` (~5 min,
`bench/vulkan/l9b-cases.txt`): both cases and their groups by name, with the completion faults it logs.
CI alone: ci.sh 457 s, ci-deqp-vk.sh 848 s, both OK.

## VK3 L1: NVIDIA's black frames — the vendor ID, not the bitmap way

**2026-10-26.** Why what Venus presented on the user's NVIDIA desktop was black ("VK2: the NVIDIA run"), found without
the desktop. JSON in `results/vk3/l1/`.

**The cause.** VK2's run already said it: its render stats show `shareRefreshes` 0 during mpv on Vulkan there (24 a
second on the M4 with the same guest and the same virtio command mix): web/venus-share.ts never copied a frame, so the
bitmap way never ran. The device reports the adapter's maker as its vendor (VK2 L7's caps), and on NVIDIA that is
0x10de. Venus's guest driver in Mesa 26 (`vn_wsi_init`: "Normally Venus on Nvidia GPUs takes the prime blit path")
then makes the device fail Mesa's same-GPU check, and Mesa's WSI renders into an optimal image and copies each frame
into a linear buffer it exports: sway imports a blob that is a buffer's memory, `venus_resource_texture` names no
texture, and nothing is shared. Debian's Mesa 25.0 (the tests' guest) has no such branch; the desktop guest's 26.2.5
has. Reproduced on SwiftShader with `?gpu=vkvendor=nvidia` on the desktop guest (`present.ts`, 1280×720, VA-API):

| SwiftShader, the device's vendor 0x10de | vkcube: its clear grey on the page | mpv: the page's mean | mpv's own frame's mean | the pictures' mean difference |
| --- | --- | --- | --- | --- |
| before (`swiftshader-vendor-nvidia-before.json`) | 3% (black) | **0** | 55.8 | 55.8 |
| after, NVIDIA reported as an unknown maker (`…-after.json`) | 82% | 42.2 (the film, letterboxed) | 55.8 | 3.0 |

The user's run: mpv's page mean 0.4 of 255, the same black.

**The fix and the safety net.** The device reports an NVIDIA adapter as an unknown maker (0; web/venus-gpu.ts
`VENDORS`, tests/venus-renderer.test.ts; a planted 0x10de is caught). And the page checks a GPU way at its first
copies: 8 rows of the image read back from WebGPU against the virgl texture's, the submit held meanwhile; a dark frame
decides nothing, three right ones settle it, a wrong one drops the way for the next (bitmap, canvas, readback) and the
frame gets the next way's copy before it shows (vk/README.md "Presentation"). `?gpu=vkbitmap|vkcanvas|vkreadback`
force a way, `vkbreak=<way>` breaks one (tests).

**The ways, way by way, in the desktop guest** (`present.ts`: vkcube's window, mpv paused fullscreen on Vulkan with
VA-API against its own screenshot, both cropped to the picture and brought to 64×36):

| | the page's own choice | vkcube | mpv (mean difference of 255) |
| --- | --- | --- | --- |
| M4, Chrome for Testing 153, Metal (`mac-ways.json`) | bitmap, checked right (3 frames) | right, all four arms | right, 8.6, all four arms |
| M4, the bitmap way broken (`mac-bitmap-broken.json`) | bitmap dropped at its first lit frame ("4000 of 4000 texels differ"), canvas checked right | right | right, 8.6 |
| SwiftShader, dev VM (`swiftshader-nvidia-sh.json`: `nvidia.sh page` end to end) | readback (the reference) | right | right, 3.0 |

(The GPU ways aren't run where the page renders in software: a WebGPU canvas there loses the GPU channel.)

**Found on the way.** The readback way made and destroyed a buffer a frame; on SwiftShader Chromium's GPU process grew
by about one a frame (1.7 → 3.3 GB in 4 s at vkcube's 6.8 MB rgba16float frames, 60 a second) until the OOM killer:
the destroyed buffers aren't freed while the queue stays busy. Each resource now keeps its buffer (the GPU process
steady at ~300 MB). VK2 didn't see it: its readback runs were short or small. And a Playwright screenshot of the page
waits for a compositor frame that SwiftShader's busy GPU process may not give for minutes: `present.ts` reads the
screen canvas as drawn instead (`window.__webpcGrab`).

**What Chromium does on the bitmap way** (read for the hypotheses the next run tests): `transferToImageBitmap` on a
WebGPU canvas exports the swap buffer's shared image (`WebGPUSwapBufferProvider::ExportCurrentSharedImage`) as an
`AcceleratedStaticBitmapImage` with a sync token, no copy; if the export fails it returns a transparent image without
an error. `texSubImage2D` from it copies GPU to GPU through the shared image into WebGL's texture: on Linux with Dawn
on Vulkan and ANGLE on NVIDIA's GL that is a Vulkan-backed shared image read by GL through memory-object and semaphore
interop, a path neither the M4 (Metal/IOSurface) nor SwiftShader (no WebGPU canvas) takes. A failed export, missing
interop or a missed semaphore would each give black or stale copies, which the check now catches: the next run's
forced arms say which way works there.

## VK3 L2: the fence's round trip — a clamped poller and Dawn's slow look, not the prime blit

**2026-10-26.** Why a Venus frame waited ~4.5 ms on its fence on the user's NVIDIA desktop ("VK2: the NVIDIA run"),
found and shortened on the M4 (Chrome for Testing 153.0.8010.12, macOS 26.6.2, Metal) and the dev VM's SwiftShader
(Chromium 153.0.8010.52). JSON in `results/vk3/l2/`.

**The prime blit explains none of it.** VK0's scene draws offscreen (`vkWaitForFences` on a fence a frame, no
swapchain), so Mesa's WSI, where the prime blit lives, never runs. With `?gpu=vkvendor=nvidia` (the device reporting
0x10de, as in VK2's run) against without, three alternated rounds, 1 fish: the M4 0.831, 0.848, 0.872 ms against
0.867, 0.829, 0.910 (`scene-mac-vendor-*`); SwiftShader 10.13, 10.21, 10.05 against 9.99, 10.04, 10.03
(`scene-swiftshader-{nvidia,pump}-*`). The same.

**Two waits instead.** Measured with the fence's breakdown, now in the render stats (`venus`, a second: the GPU's
submits and their ms until WebGPU said done, then until completed in order; the ring polls and their gaps; the nudges;
the guest's fences and their ms until retired) and in `guest.ts`'s JSON (`renderer.venus`):

1. **The ring poller was a nested `setTimeout(f, 0)`**, which Chromium clamps from the fifth turn: 4.42 ms a turn in a
   worker on Linux, **6.02 ms on the Mac** (`fence.ts`, `fence-*.json`). The guest sends a fenced `SUBMIT_3D` every two
   frames (269 a second at 1 fish on the M4; VK2 L5's runs saw ~1 a second: backlog "The guest fences each frame
   through the virtqueue"), and a fence retires at a poll: **4.3 ms after it was sent** on the M4 though its submit was
   done in 1.3, and the scene at 1 fish took **3.0 ms a frame on the M4 too** (VK2 L5's 0.93 isn't reproduced with
   today's guest and build, at its own short settings either: 2.9 ms). Now web/venus-host.ts's pump sleeps 0.25 ms on
   `Atomics.waitAsync`'s timeout between turns (0.49 ms a turn on Linux, 1.55 ms on the Mac), polls at once on a
   submit, a notify and a completion, and never nests a timer; each turn goes through the timer queue, so the
   worker's own timers aren't starved (VK2's MessageChannel loop starved them). `?gpu=vkpoll=timeout` keeps the old
   way for A/B.
2. **Dawn on Vulkan says done late.** A trivial submit's `onSubmittedWorkDone` comes back after **3.4 ms** on
   SwiftShader (an error scope's round trip, the IPC alone: 0.36 ms), and after 0.32 ms when the worker sends empty
   submits meanwhile: Chromium's GPU process looks at a device with pending work on a slow timer, but at once when
   commands arrive. On Metal it is 1.3 ms either way (completions by callback). So while a submit is in flight the
   pump sends an empty submit at most every 1 ms (web/venus-gpu.ts `nudge`). Every 0.5 ms cost SwiftShader's
   GPU-bound scene ~3% (10.17–10.29 against 9.82–10.01 ms, three rounds apart: the GPU process's CPU; those runs
   weren't kept), every 1 ms nothing (the table below); an unbounded flood made Metal's done 19.8 ms (`fence-mac.json`). Dawn on NVIDIA's Vulkan most likely shares the slow look (VK2's run:
   fences 4.1–5.3 ms for 0.3 ms of GPU): the next run's `fence` step says.

**A submit's fence** (`costs.ts`, the driver's test program on the page's WebGPU, one draw, 40 submits a round, three
alternated rounds; medians, IQR in brackets; `costs-*.json`):

| ms from the submit to its fence | old poller (`timeout`) | the pump |
| --- | --- | --- |
| SwiftShader | 3.24 (0.47), 3.13 (0.61), 3.06 (0.51) | **1.03 (0.16), 1.02 (0.20), 1.01 (0.18)** |
| M4 | 0.32 (0.09), 0.33 (0.23), 0.32 (0.04) | 0.36 (0.23), 0.35 (0.17), 0.32 (0.10) |

**VK0's scene** (`guest.ts`, the desktop guest, 4 vCPUs, MSAA 1, WARMUP 200, 5 samples of 300 frames, so the stats'
seconds hold the steady state; three alternated rounds; ms a frame, medians, and the guest's CPU a frame):

| M4, 1920×1080 | the pump | old poller | virgl |
| --- | --- | --- | --- |
| 1 fish | **0.877, 0.852, 0.847** (0.43, 0.42, 0.40) | 3.022, 3.054, 3.038 (0.72) | 0.867, 0.957, 0.898 (0.78, 0.76, 0.77) |
| 1,000 fish | **2.542, 2.547, 2.502** (1.63) | 3.263, 3.200, 3.170 (1.58) | 4.607, 4.601, 4.553 (3.06–3.25) |
| toolkit, 2,000 quads | **0.810, 0.815, 0.806** (0.36) | 2.866, 2.854, 2.843 (0.63) | 3.344, 3.274, 3.458 (3.22–3.40) |
| SwiftShader, 320×180 (at 1080p both ~58–60 ms) | | | |
| 1 fish | 9.99, 10.04, 10.03 (1.91–2.12) | 9.96, 10.05, 10.01 (1.94–2.29) | 13.09, 10.38, 11.84 (IQR 1.2–3.3; 1.17–1.24) |

**The breakdown with the pump** (means over the runs' steady seconds):

| | the GPU's submit to done | done to completed | ring polls a second, gap | nudges a second | the guest's fence, sent to retired |
| --- | --- | --- | --- | --- | --- |
| M4, 1 fish | 0.96 ms | 0.00 | ~2,200, 0.21 ms | ~260 | **1.05 ms** (old poller: 4.32) |
| M4, 1,000 fish | 1.86 | 0.00 | ~1,800, 0.37 | ~400 | 1.72 (2.88) |
| M4, toolkit | 0.25 | 0.00 | ~2,100, 0.19 | ~240 | 0.82 (3.81) |
| SwiftShader, 1 fish (320×180) | 15.6 (two frames queued on its CPU rendering) | 0.01 | ~1,750, 0.42 | ~510 | 16.9 (16.7) |

- **The bar holds on the M4 and SwiftShader**: at 1 fish Venus's frame is virgl's (the M4's rounds overlap, 0.85–0.88
  against 0.87–0.96; SwiftShader's Venus 10.0 against virgl's 10.4–13.1, both bound by its rendering), and the guest's
  CPU a frame is half virgl's or less; at 1,000 fish and the toolkit Venus is 1.8× and 4× ahead. The old poller's
  floor (~3 ms on the M4) is gone; the guest's CPU a frame dropped with it (0.72 → 0.41 ms at 1 fish: less spinning
  on its fence).
- **Expected on NVIDIA**: VK2's run had both waits (Linux's 4.4 ms clamp, and Dawn on Vulkan), about its 4.1–5.3 ms
  fences. The next run (`nvidia.sh page`'s `fence` and `scene` steps, the pump against `vkpoll=timeout`) confirms.
- Tried and dropped: turning without any delay for 2 ms after work (MessageChannel hops, each timer set from a
  message's task): ~100,000 polls a second, the same frames (M4 1 fish 0.88–0.93 against 0.87 without; one round, not kept). Completing
  a submit that reads nothing back before its work is done (the "fences with nothing to read back"): the guest's
  fence would no longer hold it back, and it could queue frames without limit; not done. The presentation copy's place
  in the frame isn't in this scene (offscreen); vkcube and mpv are vsync-paced.

## VK3: the NVIDIA run after L2 — Venus on the screen, mpv at its bar, but 1 fish still slower than virgl

**2026-10-26.** The user ran `bench/vulkan/nvidia.sh page` on their desktop with the bundle of 5b9654ac
(`results/vk3/nvidia/`): the RTX 3070 with NVIDIA's 615.71.09, CachyOS (kernel 7.2.9), Arch's Chromium 153.0.8010.52;
WebGL2 ANGLE on NVIDIA's OpenGL ES 3.2, WebGPU Dawn on Vulkan ("nvidia ampere"). One session, on their working desktop.
The user, watching: no black screens beyond the boots'; mpv's paused frame stays on the screen in `present` (by
design: `--pause` at 20 s).

**Presentation is right on NVIDIA, every way** (`present/results.json`): vkcube right in all four arms (mean 56.6–57.2,
`ok`), mpv's picture right in all four (page 42.2 against the guest's 56.1 over the cropped box, mean difference 3.3:
`ok`, not black; VK2's run: 0.4). `auto` settled on **bitmap**, checked right in 3 frames, nothing dropped; forced
bitmap and canvas checked right (`checksWrong` 0), readback the reference. So L1's cause (the vendor ID sending Mesa's
WSI down the prime blit) was the whole of VK2's black, and Chromium's GPU-to-GPU path (Dawn-on-Vulkan shared image
read by ANGLE on NVIDIA's GL) works there. The `isn't (or no longer) a Vulkan image's memory` warnings (32) come only
at a window's resize (vkcube's 500×500 first swapchain) and after a program is killed: no window took the prime blit.

**mpv meets its bar on NVIDIA** (`mpv/results.json`, two rounds): Vulkan 538, 531 frames, **0 dropped**, the guest
12, 11% busy, 24 shared frames a second (VK2: 0); GL 529, 528, 0 dropped, 9, 8%. libplacebo still disables advanced
rendering (L4's work) and translated SPIR-V for 1.3 s on its first run (L3's).

**The replays stay right** (`replay/results.json`): vkcube, vkmark's 13 scenes and vkQuake (1.67%, tolerance 3%) all
pass, as in VK2; the same two leads for vkQuake (texel buffers, depth/stencil copies into `depth32float-stencil8`).

**The fence** (`fence.json`): the timers as on the dev VM (nested `setTimeout(0)` 4.07 ms, `waitAsync` 0.25 ms →
0.31 ms). But **Dawn on NVIDIA's Vulkan says a trivial submit done fast**: `emptySubmitDone` 0.10 ms, `copyDone`
0.15 ms, nudged or not (SwiftShader: 3.4 ms unless nudged). The late-done half of L2's finding doesn't apply there.

**VK0's scene, desktop guest, 1080p, MSAA 1** (`scene-*`, two alternated rounds; ms a frame, then the guest's CPU a
frame; `done`: a submit to WebGPU's done, `fence`: the guest's fence sent to retired, from `renderer.venus`):

| ms a frame | 1 fish | 1,000 fish | toolkit 2,000 |
| --- | --- | --- | --- |
| Venus, the pump | **2.58, 2.50** (0.87, 0.86; done 3.9, 3.4; fence 4.1, 3.5) | 5.65, 5.57 (2.95, 2.93; done 5.4, 5.3) | 3.17, 3.15 (0.83, 0.81; done 4.6, 4.6) |
| Venus, the old poller | 3.63, 3.57 (0.86, 0.83; done 5.2, 5.2; fence 5.5, 5.4) | 6.50, 6.42 (2.90, 2.84) | 4.54, 4.61 (0.80, 0.80) |
| virgl | **1.48, 1.53** (1.41, 1.45) | 8.65, 8.71 (5.87, 5.66) | 7.66, 6.50 (7.41, 6.30) |
| VK2's run, Venus / virgl | 4.77, 4.90 / 2.48, 2.65 | 6.59, 6.78 / 9.14, 8.83 | 3.86, 3.75 / 7.14, 7.02 |

- **The pump took ~1.1 ms off every size** against the old poller in the same session (rounds don't overlap), and
  the poller's own share of a fence is now ~0.1 ms (fence − done). Venus is ahead of virgl at 1,000 fish (0.65×)
  and the toolkit (0.45×), and its guest CPU a frame is 0.6× virgl's at 1 fish, half at 1,000, a ninth at the toolkit.
- **But the bar isn't met at 1 fish: 2.5 ms against virgl's 1.5** (virgl faster than in VK2's run, 2.5: the
  desktop's state, the same bundle's virgl path is unchanged). What remains is **WebGPU's done in the scene: 3.4–3.9
  ms a submit**, though a trivial submit's is 0.15 ms there and the renderer's GPU time a frame ~0.3 ms (VK2). Not the
  poller, not the timers, not Dawn's slow look: something in the scene's submits (their contents, a map or copy in
  them, the queue shared with ANGLE's GL work in Chromium's GPU process, the GPU's clocks at a light load) that only
  NVIDIA shows. Next: VK3-HANDOVER.md "L2b".

## VK3 L3: pipelines made asynchronously, shaders kept across runs — a second run translates nothing

**2026-10-26.** JSON in `results/vk3/l3/` (`swiftshader/`, `m4/`). Hosts as in L2: the dev VM's SwiftShader
(Chromium 153.0.8010.52) and the M4 (Metal, Chrome for Testing 153.0.8010.12). What was built (vk/README.md "Pipelines
made asynchronously", "The shader cache"): the worker makes the driver's pipelines with `create*PipelineAsync` and holds
a submit that draws with one not yet ready (with the queue work after it), the driver makes a render pipeline when its
draw is recorded, and Mesa's pipeline caches keep what they make (a stage's NIR, a pipeline's WGSL) in an IndexedDB store
of the origin's, by BLAKE3 keys that carry the driver's build ID and the device's caps.

**A pipeline made at once blocks the GPU process** (`bench/vulkan/pipelines.ts`: N new render pipelines of unique,
compiler-heavy WGSL, then one submit drawing with each, until done; meanwhile the page's main thread times 1-pixel WebGL
readbacks; three alternated rounds, `micro.json`):

| | made one by one (`createRenderPipeline`) | all at once (`createRenderPipelineAsync`) |
| --- | --- | --- |
| M4, 40 pipelines: until done | 4,207–4,254 ms | **915–963 ms** |
| M4: WebGL's longest round trip meanwhile | 4,197–4,210 ms (blocked throughout) | 44–50 ms |
| SwiftShader, 16 pipelines: until done | 3,402–3,506 ms | 3,745–3,789 ms |
| SwiftShader: WebGL's longest round trip | 14–819 ms | 36–37 ms |

On Metal, Chromium compiles a pipeline made at once on its GPU process's main thread: ~105 ms each in turn, and
virgl's WebGL (the page's screen) waits for all of it. Made asynchronously, Dawn's workers compile them side by side,
4.6× sooner, and WebGL keeps going. SwiftShader compiles at the first draw anyway (its done is the same either way, ~8%
later asynchronously), but no longer stalls WebGL for up to 0.8 s.

**The programs' replays** (bench/vulkan/venus-run.ts: vkQuake's capture (its state at frame 200: 285 pipelines made by
GFXReconstruct, 17 WebGPU render pipelines drawn) and vkmark's desktop scene, each twice in one session; arms
alternated over two rounds; vkQuake's frames within their tolerance in every run). GFXReconstruct's "Load time" is
vkQuake's state made (its pipelines among it); `translated` the module's ms in vkCreate*Pipelines; `ready` the summed ms
from a pipeline's creation to ready; `held` the ms submits waited for them:

| vkQuake | arm | load (s) | translated (ms) | ready (ms) | held (ms) | the first 31 frames (frames/s) |
| --- | --- | --- | --- | --- | --- | --- |
| SwiftShader, cold | at once, no store (before L3) | 1.75, 1.72 | 271, 272 | | | 15.0, 15.1 |
| | async, no store | 1.24, 1.22 | 269, 279 | 1,514, 1,604 | 1,373, 1,418 | 13.3, 13.1 |
| | async, the store | 1.18, 1.24 | 214, 210 | 1,550, 1,739 | 1,485, 1,500 | 13.1, 13.2 |
| SwiftShader, again in the session | at once, no store | 0.68, 0.69 | 202, 205 | | | 21.1, 21.0 |
| | async, no store | 0.69, 0.70 | 197, 203 | 57, 58 | 0.8, 0.7 | 21.2, 21.0 |
| | async, the store | **0.50, 0.50** | **12.0, 11.9** | 5, 6 | 0.6, 0.8 | 20.7, 21.2 |
| SwiftShader, a restart on a kept profile | async, the store | 0.81 | 15.7 | 1,399 | 1,574 | 13.1 |
| M4, cold | at once, no store | 1.27, 1.24 | 230, 226 | | | 287, 280 |
| | async, no store | 1.31, 1.24 | 225, 228 | 285, 300 | 2.1, 2.1 | 280, 283 |
| | async, the store | 1.26, 1.23 | 177, 181 | 163, 310 | 1.8, 2.7 | 266, 263 |
| M4, again in the session | at once, no store | 1.04, 1.07 | 182, 183 | | | 347, 340 |
| | async, no store | 1.04, 1.10 | 181, 183 | 43, 26 | 1.3, 1.1 | 329, 340 |
| | async, the store | **0.91, 0.92** | **8.8, 8.7** | 12, 13 | 1.1, 1.2 | 323, 326 |
| M4, a restart on a kept profile | async, the store | **1.00** | **11.3** | **18** | 1.6 | 283 |

- **The gate holds: a second run translates nothing it translated on its first** — in the session (a new Vulkan
  context: vkr's device and its caches are new, the store isn't) and across a browser restart (IndexedDB): every
  lookup found (753 of 753 for vkQuake, 0 stored), the module's part 95% less (SwiftShader 271 → 12 ms, M4 228 → 9 ms;
  what is left is hashing the SPIR-V and loading the entries). vkQuake's state loads 0.17–0.19 s sooner than without the
  store (SwiftShader 0.69 → 0.50 s, M4 1.05 → 0.91 s). vkmark's scene: 0.6 → 0.14 ms. Even the first run finds 471
  of 753 lookups: the runtime looks up a stage's NIR for each pipeline that shares it.
- **The store's size:** vkQuake's entries take 3.5 MiB (282 entries), vkmark's scene 20 KiB; the budget is 32 MiB (nine
  vkQuakes; the least recently used go first). The user's NVIDIA run had libplacebo translating for 1.3 s on mpv's
  first run (REPORT "VK3: the NVIDIA run after L2"), the case the store is for.
- **Made asynchronously, a cold load is ~0.5 s shorter on SwiftShader** (1.73 → 1.23 s) and the same on the M4 (its
  Metal compiles were in Metal's on-disk cache, which outlives Chrome's profiles: 17 pipelines ready in 0.16–0.31 s
  summed, held ~2 ms in all). What a pipeline costs the first time Metal sees it is the micro-benchmark's: there
  async is 4.6× sooner and doesn't freeze the screen.
- **What remains is the browser's compile, and whether Chromium keeps it depends on the GPU:** on the M4 a restart on a
  kept profile had vkQuake's pipelines ready in 18 ms summed (Dawn's cache in the profile, `DawnWebGPUCache`, with
  Metal's), against 160–310 ms cold. On SwiftShader, 1,399 ms against 1,550–1,740: SwiftShader's compile isn't kept
  across a restart (in the session it is: 5 ms). NVIDIA's (Dawn on Vulkan) is the next run's question.
- Submits held for their pipelines: SwiftShader's first vkQuake frames wait 1.4 s in all (its compiles come at the
  first draw), the M4's ~2 ms; no pipeline was made at once by a submit in any run (`syncPipelines` 0).

## VK3 L2b: where a scene submit's done goes — the tools for NVIDIA's run, and a wrong premise

**2026-10-26.** The user's run of 5b9654ac ("VK3: the NVIDIA run after L2") left Venus at 2.5 ms a frame at 1 fish
against virgl's 1.5, with a scene submit's done at 3.4–3.9 ms though a trivial submit's is 0.15 ms there. Only NVIDIA
shows it; this loop built what the next run needs to say where it goes, and looked at what the M4 (Metal, Chrome for
Testing 153.0.8010.12) and the dev VM's SwiftShader (the same Chrome for Testing, through `nvidia.sh`) show. JSON in
`results/vk3/l2b/` (`m4/`, `swiftshader/`).

**A premise was wrong: "the GPU works ~0.3 ms a frame" was never the GPU's time.** The driver writes a timestamp query
with the CPU's clock at replay (vk/driver/wg_cmd.c `OP_QUERY`; vk/README.md "Not yet": timestamps on the GPU), so the
scene's "GPU 0.27 ms" under Venus was the replay's span on the worker. The GPU's real time in a Venus frame on NVIDIA
is unknown; the native scene's is 0.09 ms ("The NVIDIA desktop") and the M4's, measured now (`?gpu=vkgputime`), is
**0.41 ms a pass** at 1080p. So a GPU slowed at a light load (its clocks) is back among the suspects.

**What a scene submit carries** (the render stats' new `venus.perSubmit`, steady seconds, `m4/scene-*`,
`swiftshader/scene-*`): about two submits a frame, of which **48% have a pass** — the frame's (1 render pass, ~120
draws at 1 fish, ~1,100 at 1,000 fish, ~400 at the toolkit) — and the rest neither pass nor draw (the guest's fence or
upload alone); ~1.5 `writeBuffer`s a submit, ~31–33 KB (the window's dirty pages and the push data: ~66 KB a frame), no
readbacks, no maps. In the worker on the M4 a submit's encoding takes 0.054 ms and `queue.submit`'s call 0.003 ms
(SwiftShader's VM: 0.17 and 0.08): **the worker's own share of a frame is small everywhere**; what's left is between
`queue.submit` and WebGPU's done.

**Submits shaped like the scene's** (`bench/vulkan/fence.ts`'s new `shapes`: a 1080p pass, colour and depth cleared,
120 draws through a uniform group with dynamic offsets; its writes 48 + 16 KB + 512 B; the parts timed in a worker;
the pass's GPU ms from timestamp queries, unquantized; 60 each, medians):

| ms | M4: done | M4: GPU | SwiftShader: done | SwiftShader: GPU |
| --- | --- | --- | --- | --- |
| a trivial copy (L2's `copyDone`) | 1.21 | | 3.44 | |
| pass, alone (2 ms idle between) | 2.34 | 0.14 | 4.65 | 4.06 |
| pass + writes | 2.28 | 0.13 | 6.11 | 4.95 |
| pass + 3 small writes | 2.20 | 0.12 | 5.00 | 4.29 |
| pass + writes + a map | 2.42 | 0.14 | 4.78 | 4.16 |
| pass + writes + a staging buffer made and destroyed | 2.35 | 0.14 | 4.74 | 4.19 |
| pass + writes, nudged every 1 ms | 2.21 | 0.14 | 4.83 | 4.06 |
| two queued (as the scene), frame period | **1.06**, 0.61 | **0.09** | 9.11, 4.69 | 4.62 |
| two queued, nudged | 1.02, 0.61 | 0.09 | 9.00, 4.67 | 4.66 |
| pass + writes, the page's WebGL drawing | 1.96 | 0.14 | **8.58** | 4.17 |
| two queued, nudged, WebGL drawing | 0.93, 0.54 | 0.09 | 10.66, 5.49 | 4.84 |
| back to back, nudged | 0.94, 0.52 | 0.09 | 9.04, 4.67 | 4.66 |

- **On the M4 a lone frame-shaped submit is done in ~2.3 ms, but in ~1.0 when frames are kept queued**, and its pass
  takes 0.14 ms on the GPU idle against 0.09 busy: a lightly loaded GPU is slower to finish *and* to say so. Neither
  writes, maps, staging buffers, nudges nor the page's WebGL change it. The scene keeps two frames queued, which is
  why it meets the bar there (`doneMs` of its frame submits 1.13).
- **SwiftShader is bound by its rendering** (a 1080p pass ~4 ms of CPU; the scene's 320×180 frame ~11 ms with the real
  shaders): it shows nothing of NVIDIA's gap. Its only effect is the page's WebGL doubling a lone submit's done (8.6
  against 4.7 ms): both renderers share its CPU.
- No shape reproduces a 3.4 ms done on either host; NVIDIA has to say which of them does there (its `fence` step).

**The switches the next run tests** (scene arms at 1 fish, two alternated rounds with `venus` and `virgl`):
`?gpu=vkgputime` (each submit's first 8 passes timed on the GPU: the scene's real GPU ms a frame on NVIDIA; the device
asks for `timestamp-query` only then), `?gpu=vknudge=0.25` (an empty submit every pump turn, ~0.3 ms: Chromium looks
at the device at each command batch, `WebGPUDecoderImpl::HandleDawnCommands` → `PerformPollingWork`, else on a 1–2 ms
timer that every flush pushes back: gpu/ipc/service/command_buffer_stub.cc), `?gpu=vknudge=0` (none: whether L2's
nudges do anything on NVIDIA, whose trivial done needs none). On SwiftShader at 320×180 (one round,
`swiftshader/scene-*`) all four arms give the same frame (10.7–10.9 ms; virgl 10.5), as expected of a CPU-bound
renderer. On the M4 (three alternated rounds, 1 fish, 1080p; `m4/scene-*`; ms a frame, IQR in brackets, then the frame
submits' done):

| M4, 1 fish | round 1 | round 2 | round 3 |
| --- | --- | --- | --- |
| the pump (default) | 0.892 (0.058), 1.04 | 0.850 (0.043), 0.96 | 0.887 (0.066), 0.95 |
| `vkgputime` (GPU 0.41 ms a pass) | 0.877 (0.078), 1.12 | 0.908 (0.053), 1.13 | 0.949 (0.013), 1.13 |
| `vknudge=0` | 0.866 (0.039), 0.96 | 0.846 (0.069), 0.95 | 0.833 (0.050), 0.95 |

No nudges cost or gain nothing on Metal (rounds overlap), as L2 found; timing the passes adds ~0.15 ms to a frame
submit's done (its resolve, copy and map), so `vkgputime`'s arm is read for its GPU ms, not its frame time.

**And a trace**: `nvidia.sh`'s `trace` step records 2 s of Venus's scene at 1 fish (Chromium's tracing through CDP,
JSON; gpu, gpu.dawn, dawn, viz, gpu.service, toplevel, scheduler, ipc, mojom and the GPU decoder's disabled-by-default
categories), with a summary of the GPU process's main thread (busy ms a second, Dawn command batches and polls a
second, its heaviest events). On SwiftShader (`swiftshader/trace/…-summary.json`; the 52 MB trace not committed): the
main thread busy 118 ms a second, ~980 Dawn command batches and ~1,040 polls a second, `Queue::Submit` 0.03 ms each.
On NVIDIA it says whether the main thread is busy elsewhere (ANGLE's GL, the compositor) while a submit waits, and
how far apart its looks at the device are.

**The hypotheses, and what in the run settles each:**
1. *The GPU at a light load* (its clocks, its wake-up): `scene-venus-gputime`'s GPU ms a frame against the native
   0.09; the `fence` shapes' GPU ms alone against back to back.
2. *Chromium's looks at the device* (done seen late): `vknudge=0.25` shortening done; the trace's poll gaps.
3. *The GPU process's main thread busy with GL or the compositor*: the trace; the shapes with WebGL drawing.
4. *Something in the submit's content* (writes, a map, staging): the shapes' rows against `pass` alone.
5. *Dawn on NVIDIA's Vulkan slow to signal a real pass* (an implicit barrier or wait for a texture): a lone `pass`
   shape slow while a trivial copy is fast, at a small GPU ms.

## VK3: the NVIDIA run after L2b — a scene pass's GPU time and Chromium's look, pipelines right

**2026-10-26.** The user ran the whole default `bench/vulkan/nvidia.sh page` with the bundle of f55eacd7
(`results/vk3/nvidia-l2b/`; same desktop, driver and Chromium as before). The results directory wasn't cleared
between runs, so the tarball also carried the earlier run's `scene-venus-timeout-*`: left out. The 134 MB trace isn't
committed (`bench/results/local/vk3-nvidia-l2b/`); its summary failed ("Maximum call stack size exceeded").
Presentation, the replays and mpv as in the run of 5b9654ac (right, at the bar).

**Submit shapes** (`fence.json` `shapes`, 1080p, 120 draws, GPU by timestamp queries):

| shape | done (ms) | GPU (ms) |
| --- | --- | --- |
| a lone pass (± writes, a map, WebGL drawing) | 2.23–2.27 | 0.031 |
| + a staging buffer made per submit | 2.73 | 0.037 |
| a lone pass, nudged | 1.17 | 0.031 |
| two queued (± nudges, WebGL) | 0.25–0.28 (a frame 0.20) | 0.031 |
| back to back | 0.29 | 0.031 |

**Chromium on NVIDIA notices a lone real pass done ~2.2 ms after it ends** (a trivial copy: 0.14 ms), 1.2 ms when
nudged, at once while submits keep coming: hypothesis (2)/(5), not the clocks for this tiny pass (0.03 ms of GPU).

**The scene's own GPU time is large** (`scene-venus-gputime-*`, `?gpu=vkgputime`): **0.87–0.89 ms a pass** at 1 fish
(only submits with a pass are timed; a first reading here of ~1.8 ms was wrong), against the M4's 0.41 ms and the
synthetic pass's 0.03. So a frame at 1 fish is ~0.9 ms of GPU plus Chromium's late look: done 3.4 ms.

**Parked by the user (2026-10-26):** 1 fish isn't representative of real workloads; the user suspects NVIDIA's driver
latency or its GPU leaving the low-power state slowly (the M4's leaves it fast). L2c, started on it, was stopped; what
it saw before (not committed): in the trace (tracing halved the frame rate, so inflated) the GPU process's main
thread is busy ~750 ms a second and a frame's `Queue::Submit` takes ~1.55 ms (the M4: under 0.1), the frame's whole
command batch ~2.7 ms; and the driver remakes ~14 bind groups a frame (a descriptor set keeps bind groups for 4
layouts only, and every pipeline has layouts of its own: backlog).

**1 fish, ms a frame (two rounds):** Venus 1.81, 2.59 (the first round's low value unexplained); `vkgputime` 2.54,
2.56; `vknudge=0.25` **2.46, 2.39** (done 3.1); no nudges 3.16, 3.08 (done 4.5); virgl **1.52, 1.55**. 1,000 fish:
Venus 5.46, 5.64 against virgl 8.87, 8.71; toolkit 3.32, 3.15 against 6.58, 6.20. Nudging more often helps a little,
not enough: **the bar at 1 fish is still not met.**

**Pipelines on NVIDIA** (`pipelines-*`): 16 new pipelines one by one 1.94–1.99 s with WebGL stalled up to 1.99 s,
async 0.51–0.54 s (**3.7× sooner**) with WebGL's longest wait 74 ms. vkQuake: cold translation 298–371 ms, 753
misses; warm across a restart **25 ms, 0 misses**, Chromium's pipelines ready in 74 ms for 17 (kept in the profile,
as on Metal); load time 1.05 → 0.97 s. L3's gate holds on NVIDIA.

## VK3 L4: libplacebo's advanced path — the M4's green chroma reproduced and narrowed, not found; its formats stay held

**2026-10-26.** JSON in `results/vk3/l4/`. Hosts as in L3: the M4 (Metal, Chrome for Testing 153.0.8010.12, macOS
26.6.2) through `bench/gpu/sway-mac.sh`, and the dev VM's SwiftShader (Chromium 153.0.8010.52). mpv 0.41, libplacebo
7.360.1, Mesa 26.2.5 in the desktop guest.

**What libplacebo needs** (its `renderer.c` `find_fbo_format`): a 4-component float format of at least 16 bits that
renders and filters, then 1-, 2- and 3-component formats of the same type with *every* capability of that one. Our
`rgba16float` renders, blends, filters and is a storage format (core WebGPU), so `r16float`/`rg16float` must be
storage formats too (WebGPU's `texture-formats-tier1`), or `r32float`/`rg32float` must blend (`float32-blendable`). With
neither, the 1- and 2-component FBO formats are missing: "Failed creating FBO texture! Disabling advanced rendering",
then "Failed dispatching scaler.. disabling" (its separated scalers render their first half into an FBO), and mpv
scales bilinearly, as VK2 L6 measured. The M4 has both features (and tier2), SwiftShader `float32-blendable` only.

**Built** (vk/README.md "The driver"): the driver takes `float32-blendable` (32-bit floats blend) and tier1's storage
(a bit of its own, `WG_FEATURE_TIER1_STORAGE`, which also says `shaderStorageImageExtendedFormats`: VK2 said that
feature with tier1 while those formats had no storage bit, which Vulkan doesn't allow) when the worker passes them.
The worker holds both back by default (web/venus-gpu.ts `HELD_FEATURES`); `?gpu=vkformats=all` passes them,
`?gpu=vkhold=<feature>` holds one more. `tests/venus-renderer.test.ts` checks both settings against the Mac's adapter.

**The green chroma reproduced, and not tied to the format.** `bench/vulkan/mpv-frames.ts` (each arm a fresh mpv paused
at 20 s, its window's screenshot; mpv with VA-API against mpv decoding in software) on the M4 with the advanced path
on: mpv's VA-API frame comes out with its chroma at zero, the VK2 L7 picture byte for byte (2,280,642 of 3,145,536 bytes
off by more than 24, mean 77.5), in about a third of fresh sessions, with either FBO family (`rg16float` with tier1's
storage, `rg32float` with tier1's storage held), always on the session's first mpv on Vulkan; the arms after it in a
session were right. Forcing the import never to write the chroma plane gives the same bytes exactly
(`frames-mac-chroma-unwritten.json`). By what each session carried (`green-sessions-m4.json`):

| M4 sessions, the advanced path on | green |
| --- | --- |
| no instrumentation | 7 of 23 (5 of 18 with `rg16float` FBOs, 2 of 5 with `rg32float`) |
| a JS trace of the worker's imports, textures, views, destroys and shaders (no GPU work) | 4 of 7 |
| the same trace and a CPU scan of every import's bytes (a few µs in each bind) | 0 of 22 |
| probes adding GPU work (readbacks of the imported planes and FBOs at their destroy, after each write, or at 11 s) | 0 of 22 |
| a copy-back detector in the driver (8 MB copied at each readback's completion) | 0 of 3 |

**What it isn't** (each checked in a green session against a right one, or in isolation):
- Not libplacebo's frame cache alone: a second screenshot after debanding is turned on (the frame rendered anew, new FBOs,
  the planes imported again) is green too (`frames-mac-green-rerender.json`), and a session green once stays green for
  that frame.
- Not the import's bytes: every bind of the chroma plane writes the same bytes, read back from virgl's texture at its
  first import (non-zero) and kept since; mpv's screenshot imports the planes anew, written again, and is still green.
- Not the worker's order of calls: the traces of green and right sessions are the same call for call (imports, binds,
  textures and views made, destroys, the submits held for their pipelines), and the 12 WGSL modules mpv's run makes are
  the same in both (hashes).
- Not a completion's copy-back over the guest's newer writes: the only readbacks while mpv runs are its screenshot's
  (8 MB of host-visible memory, after the picture is already green), and they put back nothing the CPU wrote.
- Not WebGPU's ordering on Metal in isolation (`bench/vulkan/upload-race.ts`, `upload-race-mac.json`, 300 rounds each):
  a texture written with `queue.writeTexture` and read right after by a compute or render pass, with the GPU idle or
  busy (8 rounds in flight behind long compute passes); a storage texture written by one dispatch and sampled by the
  next, in one pass or two, fresh or kept: no wrong texel in any.
- Never seen on SwiftShader (the VK2 L7 run and this one, `rg32float` FBOs: right).

**Not found.** The leads left (backlog "Imports' gaps"): libplacebo's filter LUTs, made once at the first frame from
host-visible memory (the one chroma-only object every later render reuses; `--cscale=bicubic` has none), and so the
write-watch's view of what the guest wrote there (a store form that writes a page without marking it would leave the
GPU's copy stale until another store marks the page); libplacebo's trace log in a green session; the first frame's
submits held for their pipelines against `?gpu=vkpipelines=sync` (VK2 L7 saw the green before async pipelines existed).
A CPU scan of a few µs in each bind hid it 22 times out of 22, so whatever races is that tight, and any probe must add
neither GPU work nor time in the worker.

**So the formats stay held by default**: mpv on Vulkan renders as in VK2 L6 (`frames-mac-default.json`: VA-API's frame
byte for byte the software one; Vulkan's and GL's within 4). With `?gpu=vkformats=all`, when it isn't green, the
advanced path's frames are as VK2 L7 had them (`frames-mac-all.json`, `frames-swiftshader-all.json`):

| mpv's paused frame, bytes off by more than 24 (largest, mean) | the M4, formats held | the M4, `vkformats=all` | SwiftShader, `vkformats=all` |
| --- | --- | --- | --- |
| Vulkan: VA-API against software | 0 | 0 (green sessions: 2.28 M, mean 77.4) | 360 (115, 0.03) |
| Vulkan against GL, both decoding in software | 0 (4, 0.23) | 544 (47, 1.06): lanczos against bilinear | 426 (46, 1.04) |

**mpv's bar holds with the advanced path on** (`mpv-mac-all.json` against `mpv-mac-default.json`, two sessions: Sintel's
H.264 trailer, `bench/audio/avsync.ts`, two alternated rounds of Vulkan with VA-API and GL each, as VK2 L6):

| the M4, 4 vCPUs | frames shown, dropped | the guest busy | mpv's CPU (ms a second) | sway's | imports (ms a second) |
| --- | --- | --- | --- | --- | --- |
| Vulkan, advanced path on | 532, 529; **0** | **14, 13%** | 376, 342 | 86, 94 | 5.6, 5.4 |
| Vulkan, formats held (the default) | 533, 530; 0 | 14, 13% | 359, 326 | 90, 97 | 5.8, 5.6 |
| GL (the two sessions) | 524–528; 0 | 12–13% | 303–309 | 102–107 | — |

The scalers cost mpv ~5% more of its CPU and the guest nothing measurable, under the bar's 19–27%.

**nvidia.sh** (`page`, the `mpv` step) runs `mpv-frames.ts` as the page has it and twice with `vkformats=all`, then the
gate as before and once more on Vulkan with the advanced path on: whether NVIDIA shows the green, and its bar.

## VK3 L4b–L4c: the green found by a static review, and fixed with the review's other findings

**2026-10-26/27.** L4 left the M4's green VA-API chroma (`?gpu=vkformats=all`: libplacebo's advanced path) narrowed but
not found. **L4b-0** built the session harness, `bench/vulkan/green.sh` (fresh sessions on the Mac, arms alternated,
each classified green/right from mpv's screenshot and the page's screen against software decoding, one JSON line each;
~116 s a session), and measured 1 green of 8 bare and 0 of 8 held (`results/vk3/l4b/baseline.jsonl`; pooled with L4's,
~8 of 31). It also found L4's "established" list weaker than it read: the arms that "hid" the green were never
alternated with bare ones, and the byte and completion checks never ran in a green session.

Meanwhile **a fresh cloud agent reviewed the picture's path statically**, given only the repo and the symptom
(`origin/review/venus-green`, `VENUS-GREEN-REVIEW.md`, 78d08509): six ranked findings and eight other defects. The user
chose to fix them before more experiments (docs/testing.md "Out-of-context reviews" came of it). **L4c**, six loops, each
finding verified against the code first, then by a test that failed on the old code:

| loop | finding | result |
| --- | --- | --- |
| A (e3d4cd46) | 1: the window's written pages taken by whichever Venus device submitted and lost to the others' memories; completion serials per device matched across devices; an odd-sized memory's last bytes never uploaded | fixed. **The green: 0 of 20 bare sessions** (`results/vk3/l4c/a-green.jsonl`) |
| B (4f76f3e2) | 2: a page's upload put old bytes over an in-flight GPU write; a completion overwrote the guest's newer bytes | fixed (in-flight ranges keep a base). **Green: 0 of 12** (`b-green.jsonl`): 0 of 32 since A, ~0.01% by chance at the old rate |
| C (86ab0902) | 3: the import's readback before its picture landed (the `vaSyncSurface` claim was false), `forget` against deferred binds, the attach against the ring; import maps outliving resets | fixed |
| D (42a96e26) | 4: a draw losing its fragment stage when its stages' programs differed (link hash on padded structs); 6: `LOAD_OP_NONE` and a partial `DONT_CARE` cleared; suspended/resumed passes; a partial clear's colour lost | fixed; `load_store_op_none` advertised, 119 dEQP-VK cases newly pass |
| E (eb6f24ef) | 5: the core's page-crossing store could lose its first page's write-watch mark on a record overflow | fixed in `Mmu::span`; watch.c over 80 pages and the wide/pair/exclusive stores |
| F (01bbffac) | unaligned buffer copies, storage access WebGPU refuses, clears of non-renderable formats and 3D blits, the push buffer's wrap, storage writes for presentation | fixed (two of seven not confirmed: the bind-group key, a failed create's stale object); 84 dEQP-VK cases newly pass |

The green fits finding 1: libplacebo's chroma LUT, written once by the CPU into host-visible memory, its pages taken by
another device's submit (a second Venus device during mpv's first frames wasn't observed directly). Loops A–F cost
nothing measurable: VK0's scene at 1,000 fish on the M4, three alternated rounds each, overlapping
(`results/vk3/l4c/*-scene-1000-*.json`). Of the review's fourteen findings, twelve held up.

## VK3 L4d: the advanced path checked again — right when warm, but a cold first run freezes mpv's window; still held

**2026-10-27**, at 7ce86cb2. JSON in `results/vk3/l4d/`. The M4 (Metal, Chrome for Testing 153.0.8010.12, macOS 26.6.2)
through `bench/vulkan/green.sh` and `bench/gpu/sway-mac.sh`; dEQP-VK on the dev VM's SwiftShader. Bare sessions, arms
alternated.

**The green stays gone, and nothing is refused** (`green.jsonl`, `green-hq.jsonl`): with `?gpu=vkformats=all`, VA-API's
frame is byte for byte the software one (mpv's screenshot and the page's screen) in 10 of 10 sessions with mpv's
defaults and 6 of 6 warm ones with `--profile=high-quality` (polar scalers, debanding); 4 of 4 held sessions alike.
With the 32 of L4c-A/B, 0 green in 48. No session logged "a shader didn't translate" (L4c-F's refusal of `read_write`
storage WebGPU gives one way): libplacebo's paths here, compute ones included, write their storage images only.

**mpv's bar holds warm** (`mpv-mac-all.json` against `mpv-mac-default.json`, one session each, two alternated rounds of
Vulkan with VA-API and GL, as L4): Vulkan 532, 531 frames, **0 dropped**, the guest **15, 13%** busy, mpv 388, 345 ms a
second, against 530, 529, 0, 14, 13%, 364, 322 with the formats held; GL 527–529, 0, 12–13% in both.

**dEQP-VK with the advanced path on**: the pass list's 1,807 cases all pass on SwiftShader (`float32-blendable` only;
`deqp-vk-all-swiftshader.json`). The M4's tier1 storage isn't covered (dEQP-VK on the Mac's GPU is L6's).

**But a cold first run freezes mpv's window** (`green-cold.jsonl`; the page's screens `cold-vkva-page-late.png` against
`cold-vkno-page.png`). The M4 sessions above were warm: Metal's shader cache outlives Chrome's profiles (L3), so only
the first session with new shaders compiles them. Each first session of a new set of mpv options (new shaders for
Metal) went wrong the same way: mpv's screenshot is right (VA-API's frame equals software's), but **the page's screen
stays on mpv's pre-fullscreen frame** (854×480 in the middle, ~1.6 M bytes off by more than 24, mean 35), still the same
25 s later (`REGRAB=25`), and **mpv can't exit** (killed at shot.sh's limit: the arm takes ~50 s instead of ~23). No
1376×762 swapchain resource of that mpv ever reaches venus-share (the warm sessions' first mpv has two); the host's
fences meanwhile aren't stuck (~30–160 ms, at most 0.35 s).

| first session of new shaders | the page's screen |
| --- | --- |
| advanced path: mpv's defaults (`--dither=ordered`, `--deband`), `high-quality`, two polar-scaler sets | **frozen** in 5 of 5 |
| the same with `?gpu=vkpipelines=sync` | frozen (1 of 1): not L3's async pipelines |
| formats held, `--profile=high-quality` | frozen (1 of 1) |
| formats held, mpv's defaults (`--dither=ordered`): no FBOs, few shaders | right (1 of 1) |
| the second session of each set (Metal warm) | right in every one |

So the freeze isn't the advanced path's own (held formats show it with heavy enough shaders), but the advanced path
makes mpv's defaults heavy enough to meet it: a user's first mpv on a host whose GPU cache lacks libplacebo's pipelines
would get a frozen window. **The formats stay held by default.** On NVIDIA, Chromium's own shader cache is in the
profile (temporary in nvidia.sh) while the driver's persists in the run's directory: `mpv-frames-all` is a first run
there, `-all2` likely a warm one, and both now read the page's screen twice (nvidia.sh `GRAB=1 REGRAB=20`).

**Next (proposed L4e)**: find where mpv waits. Leads: the guest's present path at the resize to fullscreen (mpv makes
its new swapchain while its first pipelines are still being made; something it waits on, a WSI image's release or a
present's fence, never comes), and Venus's held submits (`deferred`) around a swapchain's destruction. A knob delaying
pipelines' readiness on the host would reproduce it on any host (SwiftShader in the VM too) without Metal's cache.

`mpv-frames.ts` now reads shot.sh's own words at the end of its output (a killed mpv's "Killed" line made L4d's first
cold sessions read as "VA-API not used"), keeps each page grab as `<tag>-page.ppm`, and takes `REGRAB=<s>`.

## VK3 L4e: the cold freeze was Mesa's async present; the desktop guest presents synchronously, the advanced path is on

**2026-10-27**, at 41f75a09 (with this loop's changes). JSON in `results/vk3/l4e/`. The M4 (Metal, Chrome for Testing
153.0.8010.12, macOS 26.6.2) through `bench/vulkan/green.sh` and `bench/gpu/sway-mac.sh`; the dev VM's SwiftShader
(Chromium 153.0.8010.52). Desktop guest: mpv 0.41.0, libplacebo 7.360.1, Mesa 26.2.5 (`vulkan-virtio`).

**The cause is in the guest's Mesa, not the host.** Venus's guest driver presents on a thread of its own when the
renderer has no implicit fencing (ours: virtio-gpu's), `vn_wsi_present_async` in `src/virtio/vulkan/vn_wsi.c` (since
Mesa MR 39283, 2026-01): `vkQueuePresentKHR` hands the present to the thread and returns the *previous* present's
result. When that result is an error, it returns it **and drops the present it was given**: never handed to the
thread, so its wait semaphores aren't waited, its image never reaches the compositor and its present fence (libplacebo
asks for one, `VK_KHR_swapchain_maintenance1`) is never submitted. What makes the error: mpv resizes to fullscreen
while the present thread still holds the old swapchain's last present, waiting in `vn_wsi_sync_wait` for that frame's
GPU work (seconds when its pipelines are compiled for the first time); libplacebo makes the new swapchain with the old
one as `oldSwapchain`, which retires it (`wsi_common_wayland.c`), and the held present then fails with
`VK_ERROR_OUT_OF_DATE_KHR`. The next present, the new swapchain's first (mpv's fullscreen frame), gets that error and is
dropped; libplacebo ignores an out-of-date present, mpv is paused, so nothing replaces the frame: **the page shows the
pre-fullscreen one for good**. At quit, libplacebo's swapchain teardown waits for every present fence: the dropped one
is a DRM syncobj with no fence attached, waited with `WAIT_FOR_SUBMIT`, so **mpv's `vo` thread waits forever**
(`swiftshader-frozen-stacks.txt`: `vo` in `drmSyncobjTimelineWait` under `pl_swapchain_destroy`, the `vn_wsi` thread
idle). The Wayland trace (WAYLAND_DEBUG) agrees: neither the old swapchain's last present nor the new one's first is
attached. Why only cold: a warm frame's GPU work is done before the resize, so the old present succeeds. Mesa main
(as of 8598bb5c, 2026-10-23, which reworked this function's error handling in MR 45415) still drops it; no issue or MR
upstream covers it. The fix upstream: always hand the present to the thread (`wsi_common_queue_present` submits its
waits and fences before the WSI's own present fails) and report a deferred error only for its own swapchain.

**The remedy, the least invasive one in the guest:** `VN_PERF=no_async_present` (Venus's own switch: presents on the
calling thread, as Venus did before 26.0 and as Debian's Mesa 25.0 still does) in the desktop image's
`/etc/environment` and `/etc/environment.d/` (`images/arch/desktop-setup.sh`). Nothing on the host can prevent it: the
guest driver picks async present from the renderer's lack of implicit fencing, hard-coded for virtio-gpu.

| | without the remedy | with it |
| --- | --- | --- |
| SwiftShader, the session's first mpv on Vulkan (VA-API), the advanced path on | frozen: page off by >24 in 1.62 M bytes, mpv killed (exit 137): every session (9 in L4e) | right: page 358 bytes off (as the screenshots), mpv exits (0), 3 of 3 |
| SwiftShader, mpv on Vulkan playing to the end of the file (backlog "mpv on Vulkan doesn't exit") | killed at the limit (137, 48.7 s) | exits at the end (0, 13.9 s) |
| the M4, a cold first session (new mpv options), the advanced path on | frozen (1.71 M off, 137; L4d: 5 of 5) | right, mpv exits: 3 of 3 cold, 2 of 2 warm |
| the M4, warm, `?gpu=vkpipedelay=1500` | mpv can't exit in either arm (2 of 2; the screen right) | right, exits: 2 of 2 |

`?gpu=vkpipedelay=<ms>` (each pipeline made asynchronously is ready that much later) makes a warm M4 session meet the
bug (the present after one that failed is a later one there: the screen is right but mpv can't exit), so it stays as a
knob for reproducing cold compiles. The check: `CHECK=1 GUEST_ENV=… node bench/vulkan/mpv-frames.ts` on SwiftShader
fails without the remedy (`mpv didn't exit by itself in vkva`) and passes with it (`swiftshader-d-base.json`,
`swiftshader-d-fix.json`; GUEST_ENV writes the image's line on a disk built before it).

**mpv's bar holds with synchronous presents** (`mpv-mac-sync.json`, one session, against L4d's `mpv-mac-all.json`
from earlier the same day, the advanced path on in both; the `vn_wsi` thread is gone from the sync session's threads):

| the M4, 4 vCPUs | frames shown, dropped | the guest busy | mpv's CPU (ms a second) | sway's |
| --- | --- | --- | --- | --- |
| Vulkan with VA-API, synchronous presents | 536, 530; **0** | 14, 13% | 373, 338 | 89, 99 |
| the same, async presents (L4d) | 532, 531; 0 | 15, 13% | 388, 345 | 91, 95 |
| GL (both sessions) | 527–529; 0 | 12–13% | 299–310 | 100–103 |

**The advanced path is on by default** (`HELD_FEATURES` taken unless `?gpu=vkformats=held`): right in every session
above (0 green in 10 more sessions on the M4, 58 since L4c-A), at mpv's bar, dEQP-VK's pass list green with it (`ci-deqp-vk.sh`).
**The desktop image is rebuilt with it** (`images/arch/desktop.sh`, the mirror's packages of the day: Mesa 26.2.5
still). The sessions above set the line at boot (GUEST_ENV/MPV_ENV) on the earlier disk; on the rebuilt one, with
nothing set: SwiftShader's check passes (`swiftshader-rebuilt.json`; `GUEST_ENV=VN_PERF=` clears it and it fails again,
`swiftshader-rebuilt-off.json`), and on the M4 a cold and a warm session are right, mpv exiting
(`green-rebuilt-image.jsonl`). The hosted disk (vmdisks.tny.im) is the old one until it's replaced: a page deployed
with the advanced path on would meet the freeze with its first cold mpv.

How the stacks were had: gdb isn't in the desktop image and an image build didn't fit the disk then (5 GB free), so gdb's packages
(`pacman -Sp gdb` in the guest for the list, from arch.bens.haus) went on a copy of the media disk
(`target/video/media-gdb.ext4`, local) and `mpv-frames.ts` installed them at boot (`DISK2=/target/video/media-gdb.ext4
PRE='pacman -U --noconfirm /mnt/media/gdb/*.zst' DIAG=…`). The guest's libraries are stripped: exported names
(libc, libdrm, libplacebo's API) placed the waits, Mesa's source (`target/vk/mesa`, 26.2.4) the rest.

## VK3: the NVIDIA run after L4e — libplacebo's advanced path right on NVIDIA, mpv exits, the rest unchanged

**2026-10-27.** The user ran the whole default `bench/vulkan/nvidia.sh page` with the bundle of 4fdc69fb
(`results/vk3/nvidia-l4e/`; RTX 3070, driver 615.71.09, Arch's Chromium 153.0.8010.52, the desktop image rebuilt in L4e
with `VN_PERF=no_async_present`, checked in its root filesystem before bundling). The page grabs (16 PPMs, 48 MB) and
the 137 MB trace aren't committed (`bench/results/local/vk3-nvidia-l4e/`).

**The advanced path on NVIDIA** (`mpv-frames-default`, `-default2`): libplacebo takes it without complaint (no "Failed
creating FBO texture"); the adapter reports `ampere`. **VA-API byte for byte software** on Vulkan (`vkva ~ vkno`: 0
bytes off, mean 0) in both runs; the page's screens (`GRAB=1 REGRAB=20`) are the fullscreen frame, identical 20 s
later, and match each other (`vkva ~ vkno` page: 0) and GL's software frame as the screenshots do (`vkno ~ glno` page:
388 bytes off by >24, mean 1.09). **mpv exits 0 in every arm** (8 of 8 Vulkan sessions across the three steps): no
freeze on this host's cold first session. `glva ~ glno` (mean 10.6) is GL's VA-API path, the same on SwiftShader and the
M4 since VK2 L6.

**Held** (`mpv-frames-held`, `vkformats=held`): "Failed creating FBO texture! Disabling advanced rendering" as
expected, VA-API still byte for byte software (0 off).

**mpv's bar with synchronous presents** (`mpv`): on Vulkan 540 and 533 frames, **0 dropped**, the guest **14 and 12%**
busy (the run after L2b, async presents: 13 and 11%); GL 9 and 8%. Within the bar (19–27%).

**Unchanged from the run after L2b:** presentation right in every way (bitmap, canvas, readback, auto: vkcube and
mpv); the replays as before (vkQuake's known 1.67% difference, the rest within tolerance); pipelines one by one 1.95 s
with WebGL stalled 1.95 s, async 0.52 s with WebGL's longest wait 79 ms; vkQuake's cold translation 237 ms, 282 misses;
the fence's shapes within 0.02 ms (a lone pass done 2.24 ms, nudged 1.18, queued 0.27). The scene (ms a frame, two
rounds): 1 fish Venus 2.47, 2.59 against virgl 1.54, 1.50 (parked by the user); 1,000 fish 5.71, 5.70 against 8.85,
8.68; toolkit 3.19, 3.05 against 6.81, 7.43.

## VK3 L5: the translator's adapter features — WGSL's subgroups, 16-bit storage, f16, tier2's read-write formats

**2026-10-28.** JSON in `results/vk3/l5/`. dEQP-VK on the dev VM's SwiftShader (Chromium 153.0.8010.52) and on the M4
(Metal, Chrome for Testing 153.0.8010.12) through `bench/gpu/sway-mac.sh` (`VIRGL_GPU=virgl,vulkan`: without it the
script's default machine has no Vulkan and deqp-vk exits at once with no statuses).

- **Subgroups** (`swiftshader-subgroups.json`): every 32-bit compute and graphics case of `dEQP-VK.subgroups`
  (3,248; vertex-only, mesh, ray tracing and 8-, 16- and 64-bit types left out): **1,865 pass, 0 fail**, 1,383 not
  supported (required sizes other than SwiftShader's 4, other stages, extensions not offered). The first run's 26
  failures were `gl_SubgroupID`/`gl_NumSubgroups` (not translated: now from `local_invocation_index`) and three vec4
  broadcasts that found a **scratch bug older than L5**: the printer added `nir_intrinsic_base` to scratch offsets,
  which scratch intrinsics don't have (it read their alignment, 4): an array past 32 bytes indexed dynamically lost
  its last word. Before L5, subgroups were of one invocation with the basic operations; a stage using more failed.
- **On the M4, subgroups are wrong in divergent control flow** (`mac-before-check.json`): 89 of 503 sampled
  subgroup cases failed (arithmetic in compute and graphics, f16 shuffles in graphics). Narrowed with translated
  kernels run on the Mac's WebGPU: a ballot that is an `if`'s only subgroup operation returns every invocation's bits
  (0xffffffff where 0xaaaaaaaa is right), while the same `if` with an add beside it is right. The GPU worker now runs
  that kernel at Venus's start (`subgroupsRight`) and holds `subgroups` where it fails: on the M4 the device has
  subgroups of one invocation again (`mac.json`: the subgroup cases not supported); SwiftShader passes it.
- **16-bit storage** (`swiftshader-16bit-storage.json`, every adapter): every third `spirv_assembly.*.16bit_storage`
  case without 64-bit or I/O types, **205 of 205 that ran pass** (148 not supported: other stages).
- **16-bit floats** (`mac.json`, the M4's `shader-f16`): of 391 sampled `spirv_assembly.*.float16` cases, 226 pass,
  7 fail (6 on 16-bit infinities and NaNs, which come back 0: WGSL lets a backend assume none; one graphics vector
  shuffle whose WGSL nests ifs past Tint's limit of 127), 158 not supported.
- **tier2's read-write formats** (`mac.json`): 27 of 54 `image.load_store.with_format.2d.*` cases of tier1's and
  tier2's formats pass, 27 not supported; `tests/wgsl.test.ts` checks tier2's formats print `read_write` and the
  others are still refused, and Tint on the Mac compiles them.
- **The pass list** (`tests/deqp/vk.txt`): 2,333 → 3,261 (723 subgroup cases, the large groups thinned to every
  third, and the 205 16-bit-storage ones; the Mac-only cases stay out: CI's adapter is SwiftShader).

## VK3 L6b: texel buffers, the depth and stencil copies WebGPU refuses, bind groups kept, dEQP-VK on the M4

**2026-10-28.** JSON in `results/vk3/l6b/`. dEQP-VK on the dev VM's SwiftShader (Chromium 153.0.8010.52) and on the
M4 (Metal, Chrome for Testing 153.0.8010.12, macOS 26.6.2) through `bench/gpu/sway-mac.sh`.

- **Texel buffers** (`swiftshader-texel-buffers.json`; vk/README.md "The shader path"): a storage buffer of the view's
  words and its format decoded and encoded in WGSL from a uniform buffer of the view's layout. Of a sample of 875
  texel-buffer cases (`texture.texel_buffer`, `api.buffer_view.*`, every twelfth `binding_model.shader_access` one,
  `descriptor_copy`, `memory.pipeline_barrier`), **315 pass, 17 fail, 543 not supported** (geometry and tessellation,
  sRGB, ASTC and 64-bit formats, `uniform_storage_texel_buffer`'s 122 that need storage without a format); before L6b
  no format had texel-buffer features, so all were not supported. The 17 failures are WebGPU's limits: binding
  aliasing of a texel buffer with another writable binding of its memory, and 13 storage buffers in a stage past
  SwiftShader's 10 (backlog "Texel buffers"). `tests/wgsl.test.ts`: 124 of 127 stages translate (vkQuake's
  palettization now does).
- **Depth and stencil copies** (`swiftshader-depth-copies.json`, `…-before.json`): the worker's draws (`frag_depth`
  from the buffer; stencil a bit a draw) and compute passes (depth loaded into the buffer); D24's copies advertised.
  Of 544 `api.copy_and_blit.core` depth/stencil cases (every buffer-image one, every fourth image-image one): **45 →
  81 pass**, 74 → 42 fail; what fails now is depth16unorm's part (1 offset case and its partial image copies) and
  image copies between colour formats (ASTC to and from 32-bit formats: "copies between formats").
- **vkQuake's frames** (`vkquake-replay*.json`, the Debian guest's replay on SwiftShader): frames 15 and 30 differ
  from lavapipe's as before (15,915 and 15,743 bytes past 24 of 921,654, 1.7%), byte for byte the same counts with
  and without texel buffers and the copies: neither was the 1.7%. **Frame 5 differs in 735,281 bytes (80%)** at
  a82e482d (before L6b) as now: vk/README.md's table had it at 1.7%, so something between it and L6a changed the
  first replayed frame (GFXReconstruct's trimmed state restore); not looked into (handover).
- **Bind groups** (`bind-groups/`, VK0's scene in the desktop guest on the M4, three alternated rounds, WARMUP=200
  FRAMES=300; ms a frame, the median of 5 samples, IQR in the logs): layouts' uids by content. Bind groups made a
  submit 6.7 → 2.9 (1 fish), 7.7 → 3.4 (1,000), 1.5 → 0.5 (toolkit 2,000); the worker's encode a submit 0.081–0.087
  → 0.072–0.075 ms, 0.271–0.279 → 0.259–0.262, 0.102–0.106 → 0.095–0.097 (rounds apart in each). Frame times:

  | setting | before (3 rounds) | after (3 rounds) |
  |---|---|---|
  | 1 fish | 0.938, 0.861, 0.849 | 0.842, 0.838, 0.854 |
  | 1,000 fish | 2.612, 2.561, 2.499 | 2.535, 2.537, 2.522 |
  | toolkit 2,000 | 0.933, 0.913, 0.885 | 0.880, 0.902, 0.892 |

  The rounds overlap: no frame-time difference claimed, and not slower; landed for the worker's time.
- **The pass list on the M4** (`mac-list.json`; the VM idle; 4,251 cases in 187 s of deqp-vk): **3,547 pass, 7 fail,
  697 not supported** (every one a subgroup case: the M4's subgroups are held by the worker's check, L5). The 7 fail
  only there: 5 `blit_image.*.generate_mipmaps.from_previous_level.layercount_6` (each level blitted from the one
  before over 6 layers, "Result image is incorrect"; other formats and layer counts pass),
  `fragment_operations.early_fragment.discard_no_early_fragment_tests_depth` (an occlusion count of 496, out of range:
  Metal's visibility results in counting mode, likely) and `texture.mipmap.3d.projected.nearest_linear_mirror` (a
  filtering difference). Not cheap to fix blind: filed (docs/backlog.md "The Vulkan driver's gaps"); the cases stay in
  the list, which CI runs on SwiftShader.
- **The pass list** (`tests/deqp/vk.txt`): 3,972 → 4,251 (198 texel-buffer and 81 copy cases).

## VK3 L8a: the track-end review's findings

2026-10-28. The dev VM's SwiftShader (Chromium 153.0.8010.52) for the driver's tests and dEQP-VK. The findings:
`origin/review/venus-vk3` (`VENUS-VK3-REVIEW.md`, of 3f8aa595..dedd54e6). Each was checked against the code; four were
real and fixed, each with a test that failed first; one (5) is wrong: Vulkan forbids it. Advertised: nothing changed
(`framebufferNoAttachmentsSampleCounts` stays 1 and 4, Vulkan's required minimum, now honoured).

- **1, high** (a 4-aligned `vkCmdCopyBuffer` within one VkDeviceMemory is a same-buffer `copyBufferToBuffer`): real
  ("Source and destination are the same buffer", the submit lost). The worker copies within one GPUBuffer through a
  temporary buffer (`copyWithin`). The other paths checked: unaligned copies, fills, updates, readbacks, buffer ↔ image
  and the depth and stencil paths go through temporaries or distinct objects already; but **image copies and blits
  within one subresource** had the same hazard ("Copy source and destination are overlapping layer ranges"; a blit
  samples the subresource it renders to): an image copy whose source and destination subresources overlap goes through
  a temporary texture of the region (`copyTextureWithin`), and such a blit samples a copy of its source subresource.
  Resolves can't name one image twice. Tests `misc: buffer copies between two buffers of one memory, within one buffer,
  and within the result itself`, `misc: a copy and a blit within one subresource of an image` (both: WebGPU errors,
  the submit invalid).
- **2** (the provoking-vertex pass binds the index buffer to its bound range's end; xfb's index range likewise): real.
  The provoke pass binds from the 256-aligned start of the draw's first index to its last index's end; a direct
  captured draw copies its indices only (an indirect one still takes its range whole: its count is on the GPU). Tests
  in `tests/venus-gpu.test.ts` on a stand-in device (a 1 GiB index buffer bound whole: the binding was 1,073,740,032
  bytes, the capture skipped with a warning). Left filed (backlog "ANGLE's row's gaps"): an indexed or indirect captured
  draw still copies its vertex bindings whole, and so is skipped past `maxStorageBufferBindingSize`.
- **3** (attachment-less passes rasterize at 1 sample with 4 advertised): real, and a secondary command buffer in such a
  pass was worse: its pipelines had no colour target where the pass had the device's ("No attachment was specified",
  the submit lost). The pass is recorded with a 1-sample attachment of the device's, its view's id in ten digits; its
  first draw puts in one of the pipeline's `rasterizationSamples` (or `vkCmdExecuteCommands` the secondary's inherited
  samples), and a secondary inheriting no attachments has the device's attachment where the pass has it. Test
  `samples: passes without attachments at 4 samples, drawn in the pass and by a secondary command buffer` (a fragment
  shader per sample setting its `gl_SampleID`'s bit and counting itself: 0xf and 64; the pass's draw gave 1 and 16 with
  the fix planted out).
- **4** (descriptor copies overwrite immutable samplers): real; a copy keeps the destination's immutable sampler. Test
  `misc: a combined image sampler copied over one with an immutable sampler keeps the immutable one` (sampled.comp read
  100, NEAREST, for LINEAR's 50).
- **5** (transform feedback across a suspended and resumed render pass): **wrong**. A suspending pass ends with
  `vkCmdEndRendering`, and `VUID-vkCmdEndRendering-None-06781` (and `-vkCmdEndRendering2KHR-None-10612`,
  `-vkCmdEndRenderPass-None-02351`, `-vkCmdNextSubpass-None-02349`) say it "must not be recorded when transform feedback
  is active" (`/usr/share/vulkan/registry/validusage.json`, 1.4.363): a capture can't span the parts. Nothing to fix.
- **Found beside them** (filed, backlog "Copies WebGPU refuses"): `depthStencilTT`'s native path for whole depth and
  stencil subresources is never taken (it tests texture usages against the buffer usages' constants), so they go through
  the worker's passes: right, slower.
- **CI** (this code, alone): `scripts/ci.sh` OK (528 s; a first run's one failure was `page-usb.test.ts`'s USB tab, a
  checkbox click not taking, which passed 3 of 3 alone and in the rerun); `scripts/ci-deqp-vk.sh` OK (848 s: the 4,690-case
  list in 589 s, YCbCr's 773 in 88 s, the replays). Nothing newly NotSupported.

## VK3 L7b: the reviews' remaining findings (L7.4–L7.5's and L6b–L7.3's)

2026-10-28. The dev VM's SwiftShader (Chromium 153.0.8010.52) for the driver's and translator's tests and dEQP-VK. The
findings: `origin/review/venus-after-l7` (`VENUS-L74-L75-REVIEW.md` 1, 2, 4, 6, 7, 9) and `origin/review/venus-l6b-l73`
(`VENUS-L6B-L73-REVIEW.md` 1, 3, 4, 5). Each was checked against the code and given a test, which failed first where
the finding is a wrong result; none turned out wrong. Advertised: nothing new; the image-format query now takes a
multi-planar image's plane formats in its format list and refuses it on external memory.

- **L7.4–L7.5's 1, high** (a provoked draw's 16-bit index range rounded down to a word): real, and wider than the
  review said: the end was rounded down whatever the memory around the buffer, so any OP_PROVOKE draw with an odd
  number of 16-bit indices used to the end of its bound range lost its last index. Rounded up within the memory's
  GPUBuffer (4-aligned). Tests `passes: an indexed fan of 5 16-bit indices in a 10-byte buffer`, `… a triangle list of
  3 16-bit indices in a 6-byte buffer` (the fan's third triangle and the list's triangle were the clear colour).
- **2** (indirect draws never captured by transform feedback): real. An indirect draw's capture copies its arguments
  over the capture's parameters on the GPU (VkDrawIndexedIndirectCommand's five words are its count to first
  instance; VkDrawIndirectCommand's first three, then its first instance), takes its index buffer and vertex bindings
  whole, and counts its primitives in the shader (`wgx_prims`), 1,024 workgroups looping. One per `drawCount` (1:
  `multiDrawIndirect` is off). Tests `transform feedback: an indirect draw captured`, `… an indexed indirect draw
  captured` (nothing written, the counter 0).
- **4** (dummy attachments released under recorded command buffers): real, but harmless in the review's form (17 sizes
  growing: the freed id is the next dummy's view, larger than the pass needs). With sizes shrinking the evicted pass
  gets a smaller attachment: "Scissor rect … is not contained in the render area", the submit lost. Dummies are now
  counted (`wg_dummy`): each command buffer whose passes name one holds it until it is reset or freed. Test
  `transform feedback: captures in 17 passes without attachments, each of its own size` (17×17 down to 1×1).
- **6** (8 null colour attachments overrunning `pass.colors`): real, as the review said (the depth format R8, a ninth
  attachment). The dummy takes the eighth's place. Test `… a capture in a pass of eight colour attachments, all null`.
- **7** (a restarted strip or fan walked by one invocation): real (a performance hazard: time, not a wrong result; not
  measured, no test can fail on it cheaply). The walk is 256 invocations, a part each: each finds its part's last
  restart, then walks its part from the run the parts before it leave, a primitive where Vulkan's ends (degenerate
  where a restart leaves none), so the serial depth is the count over 256. Test `passes: an indexed strip with primitive
  restart whose last vertex provokes` (its runs across the parts), which passed on the old walk and fails with the new
  walk planted wrong (the parts before it ignored).
- **9** (the tests miss the configurations): covered by the tests above (odd 16-bit ranges, indirect draws; more
  vertex buffers by L7a's `xfbMany`) and `passes: ANGLE's layout of 13 uniform buffers in each of two stages`
  (`wgt_angle_ubo`: each stage's dynamic default block in set 0, 12 blocks each stage alone sees in set 1), which
  passes: the folding is right for ANGLE's layout, as the review found.
- **L6b–L7.3's 1** (`interpolateAt*` advertised with `sampleRateShading`, refused by the translator): real. The input
  where WebGPU interpolates it (the centre, or the sample at the sample rate) moved to the offset or the sample's
  position along its fine derivatives; flat inputs as they are. Test `tests/wgsl.test.ts` "interpolateAtOffset and
  interpolateAtSample move the input along its derivatives" (the stage failed: "interpolation at an offset or
  sample"); dEQP-VK's 18 samples_4 (and single-sample) cases of `multisample_interpolation`'s
  `offset_interpolate_at_pixel_center`, `offset_interpolation_at_sample_position` and `sample_interpolate_at_*` all pass
  and join the list (4,672 → 4,690).
- **3** (multi-planar images: plane-format lists refused, plane views in other formats invalid): (a) real, fixed: a
  mutable multi-planar image's format list may name its planes' formats or their twins. (b) real, warned (`wg: a view
  of format … of plane …`, no longer suppressed) and left filed (backlog "YCbCr's gaps": Vulkan allows such a view
  without a list, so the query can't refuse it). Test: `tests/venus-renderer.test.ts` "what the driver advertises"
  (NV12, mutable, the list {R8, R8G8}: VK_ERROR_FORMAT_NOT_SUPPORTED before; a list naming RGBA8 still refused).
- **4** (multi-planar images on imported or shared memory): real; refused by the image-format query where an external
  handle type is asked (the planes' textures are neither imported nor exported); an import of each plane's region is
  filed (backlog "YCbCr's gaps"). Test: the same (NV12 with a dma-buf handle type: supported before). The YCbCr list
  (773 cases) passes unchanged: Venus's guest asks for external memory only where the program does.
- **5** (comments of the YCbCr default): fixed (`wg_caps.c`, `wg_private.h`).
- **CI** (the code at 4cfaf2ae, docs after it): `scripts/ci.sh` OK (535 s); `scripts/ci-deqp-vk.sh` OK (846 s: the
  4,690-case list in 588 s, YCbCr's 773 in 88 s, the replays). Nothing newly NotSupported.

## VK3 L7a: the binding model's limits and identities (the reviews after L7)

2026-10-28. The dev VM's SwiftShader (Chromium 153.0.8010.52) for the driver's tests and dEQP-VK; the desktop guest
(Arch, Chromium 153, ANGLE) for ANGLE's probe. The findings: `origin/review/venus-after-l7` (`VENUS-BINDING-REVIEW.md`
whole; `VENUS-L74-L75-REVIEW.md` 3, 5, 8) and `origin/review/venus-l6b-l73` (`VENUS-L6B-L73-REVIEW.md` 2). Each was
checked real and given a test that failed first; JSON in `results/vk3/l7a/`.

- **One count of the bindings WebGPU takes** (`wg_caps.c` "The bindings WebGPU takes", vk/README.md "Bindings past
  WebGPU's"): a program's WebGPU bindings by stage and by layout, the hidden ones named (the push buffer, texel
  buffers' words and parameters, folded uniform buffers, YCbCr planes, input attachments, a capture's). The
  advertised limits follow it where they can: `maxDescriptorSetUniformBuffersDynamic` 8 → 7 (the push buffer's),
  `minUniformBufferOffsetAlignment` the larger of uniform and storage (256 both on SwiftShader and the M4), storage
  buffers and images every stage's least (vertex and fragment limits too), `maxMemoryAllocationSize` 64 KiB less.
  What can't be advertised apart (texel buffers beside full storage, input attachments beside 16 textures, more
  folded uniform buffers than two, bindings past 1,000 or on the push buffer's) is refused at pipeline creation
  (`wg_bindings_fit`), saying why, never an invalid submit. dEQP-VK's list (4,672) passes unchanged: nothing it
  runs became NotSupported.
- **The findings**, binding review: 1 (a capture's compute pass past the storage count: now three bindings whatever
  its buffers, the index and vertex ranges copied into one, the capture refused at creation if the stage's
  bindings and its own don't fit, or the program has four groups); 2 (a sampler shared by an unfilterable and a
  filterable texture: split, its nearest twin at its slot's even binding, in modules of the variant's own); 3
  (widened variants sharing a writer's layout uid: the uid tells written storage); 4 (variants' 64-resource masks:
  128; pairs past the cap fail the stage, 64 → 128); 5 (uniform blocks declared past their memory or range: declared
  at most 64 KiB, each memory's GPUBuffer 64 KiB longer, which fixes the backlog's dynamic-offset form too); 6
  (input attachments: counted, refused); 7 (immutable samplers overwritten by writes: kept); 8 (bindings near 998: a
  guard in the count, out of reach within the limits). L7.4–L7.5: 3 (the same as 1, with the vertex ranges trimmed
  to what a non-indexed draw reaches and checked against the binding size), 5 (the advertised dynamic count), 8 (the
  alignment). L6b–L7.3: 2 (texel buffers: counted, refused).
- **Tests** (`tests/venus-driver.test.ts` misc `texelStorage`, `dynamicUniforms`, `writtenShared`,
  `immutableSampler`, `bigUniform`, `sharedSampler`, transform feedback `xfbMany`, fits `inputAttachments`;
  `tests/wgsl.test.ts` "texture-sampler pairs past what the translator records"): each failed at 15667724 as its
  finding said (11 storage buffers, 9 dynamic uniform buffers, a 128 KiB uniform binding, 12 storage buffers in the
  capture: WebGPU errors; X's 7s not read back; the nearest filter; 144 pairs translated). The count planted out
  (`wg_bindings_fit` returning true) fails `texelStorage` and `inputAttachments` again. Not tested: a draw of more
  than 64 resources and the split sampler in a render pipeline (backlog "Bindings past WebGPU's"); the alignment
  and the 998 guard (no adapter differs).
- **ANGLE's 205 for 156** (`angle-es3.json`; `CHROMIUM_ARGS="--enable-unsafe-webgpu --enable-features=Vulkan"
  PAGE=bench/vulkan/angle/es3.html ARMS='--use-angle=vulkan --enable-features=Vulkan|--use-angle=vulkan' node
  bench/vulkan/dawn-frames.ts guest`): still 205 with Chromium's Vulkan, 156 without (flat and capture right in
  both). Not the folding: 205 is 156 sRGB-encoded exactly (0.6118 → 0.8046). A debug build's log
  (`angle-es3-vulkan-views.log`) shows Chromium's canvas image `R8G8B8A8_SRGB`, mutable (SRGB, UNORM), and ANGLE's
  only attachment view of it SRGB, into which its 4-sample UNORM target is resolved. Filed (backlog "ANGLE with
  Chromium's own Vulkan device too").
- **CI** (the code at 987196c6, docs after it): `scripts/ci.sh` OK (465 s); `scripts/ci-deqp-vk.sh` OK (848 s: the
  4,672-case list in 590 s, YCbCr's 773 in 89 s, the replays).

## VK3 L7.5: vkd3d's row backed (draw parameters); vkd3d makes a Direct3D 12 device at feature level 11_0 on Venus

2026-10-28. The dev VM's SwiftShader (Chromium 153.0.8010.52) for the driver's tests and dEQP-VK (vulkan-cts-1.4.7.0's
deqp-vk in the Arch guest, `bench/gpu/deqp-run.ts vk` with `CASES=`); the desktop guest (Arch Linux, Mesa 26.2.5,
vkd3d 1.19) for the program. JSON in `results/vk3/l75/`.

- **Draw parameters** (`shaderDrawParameters`, `VK_KHR_shader_draw_parameters`). WGSL has no base-vertex, base-instance
  or draw-index built-ins (its `vertex_index` and `instance_index` include the bases, as Vulkan's do). A vertex stage
  that reads them reads three words of the push buffer at byte 128, past Vulkan's 128 bytes of push constants, and its
  push constants go there with them. A direct draw writes its values into its place there, and takes a new place
  only where they change. An indirect draw gets a place of its own before its render pass, and a copyBufferToBuffer of
  its arguments' base vertex and first instance into that place (the render-pass rule: a copy, no pass break). That
  costs no compute pass and no pre-pass shader. Immediates were the cheaper choice for direct draws, but they can't
  take an indirect draw's GPU-written values, so one path serves both. The draw index is 0 except in multi-draw
  indirect, which isn't advertised.
- **dEQP-VK** (`deqp-draw-params.json`): 60 of 76 `draw.*shader_draw_parameters` cases pass (renderpass, dynamic
  rendering primary and both secondary kinds; base vertex, base instance, their `_only` forms, direct, indexed and
  indirect with and without first instances). The 16 `draw_index` cases are not supported without
  `multiDrawIndirect`. The 2 api cases of the feature pass too. Of every tenth `draw.renderpass.instanced` case, 11
  of 102 pass; the rest need divisors, buffer device addresses or multiview, and one indexed-indirect fan fails, which
  is a gap filed in L7.4.
- **The program** (`vkd3d.json`; `node bench/vulkan/vkd3d.ts disk`, then `TESTS=… node bench/vulkan/vkd3d.ts`): Arch's
  vkd3d 1.19 and spirv-tools sit on a second disk and are installed at boot. Without draw parameters (the same build
  with them turned off), `D3D12CreateDevice` fails at 11_0 ("Required device extension VK_KHR_shader_draw_parameters is
  not supported", vr -7). **With them, it makes a device at 11_0**; 11_1, 12_0 and 12_1 are refused. vkd3d lists what
  11_0 lacks and makes the device anyway: push constants (128 of 256 bytes), viewport bounds and sub-pixel bits, 13
  uniform buffers a stage, geometry and tessellation, multi-draw indirect, multiple viewports, precise occlusion
  queries, pipeline statistics, cull distances, extended gathers, storage image writes without a format (its UAV-clear
  pipelines then don't translate), vertex attribute divisors and min/max reduction. vkd3d has no demos package, and
  its demos need an X window, so the program is vkd3d's own Direct3D 12 test suite (tests/d3d12, built in an Arch
  container, offscreen). test_draw_instanced (26 checks), test_draw_indexed_instanced (28) and test_root_constants
  (80) pass. Three tests fail for causes outside this row, filed in docs/backlog.md "vkd3d on Venus":
  - test_vertex_id: 39 of 89 checks fail. Its stream output of indirect draws isn't captured, and one program of four
    bind groups isn't captured either.
  - test_instance_id: 84 of 372 fail, from instance step rates (divisors) and a 1-byte vertex stride WebGPU refuses.
  - test_clear_render_target_view: 16 of 280 fail, from views of other formats and 3D views.
- **The pass list** (`tests/deqp/vk.txt`): 4,599 → 4,672 (62 draw-parameter cases, 11 instanced).
- **Tests** (each failing first, and failing again with a bug planted back):
  - `tests/wgsl.test.ts`: a vertex stage's parameters read from the push buffer at word 32, compiled by Tint.
  - `tests/venus-driver.test.ts` passes `drawParams`: four draws in one pass (direct, indexed, indirect with
    host-written arguments, indexed indirect with arguments written by `vkCmdUpdateBuffer` before the pass), the first
    two with the same push constants. Planted: a place not renewed when only the parameters change, and the indirect
    copy from the wrong word. Each fails the test.
- **CI** (the code at b21e44d9, docs after it): `scripts/ci.sh` OK (532 s); `scripts/ci-deqp-vk.sh` OK (847 s: the 4,672-case list in 590 s, YCbCr's 773 in 88 s, the replays).

## VK3 L7.4: ANGLE's ES3 row backed (the provoking vertex, 13 uniform buffers, transform feedback); ANGLE gives WebGL 2 on Venus

2026-10-28. The dev VM's SwiftShader (Chromium 153) for the driver's tests and dEQP-VK (VK-GL-CTS vulkan-cts-1.4.7.0's
deqp-vk in the Arch guest, `bench/gpu/deqp-run.ts vk` with `CASES=`); the desktop guest (Arch Linux, Chromium
153.0.8010.36, Mesa 26.2.5) for the program. JSON in `results/vk3/l74/`.

- **More than 12 uniform buffers a stage.** `maxPerStageDescriptorUniformBuffers` 12 → 13 (WebGPU's 12, less one for
  the push buffer, plus 2 of the storage buffers: `maxPerStageDescriptorStorageBuffers` 10 → 8 on SwiftShader and the
  Mac); a uniform buffer past its stage's room, by the pipeline layout's stage flags, is read as read-only storage. A
  shader with 12 uniform blocks and push constants past the immediates used to be refused by WebGPU (backlog; it is
  the driver test's `manyUniforms` with 13). dEQP-VK: every `descriptor_limits.{compute,fragment}_shader.uniform_buffers_N`
  up to 13 passes (`deqp-ubo.json`: 22, 14 to 16 not supported).
- **The provoking vertex** (`VK_EXT_provoking_vertex`, the last, per pipeline). A draw whose fragment shader reads a
  flat input and whose last vertex provokes goes through a list of indices of its own, each primitive's rotated, made
  by a compute pass hoisted before its render pass (the render-pass rule: no break); indexed fans the same way (WebGPU
  has none: they used to draw as a list), and non-indexed fans' device indices now Vulkan's order (each triangle's
  first vertex the fan's second, not its centre). dEQP-VK: every `rasterization.provoking_vertex.draw` case but
  adjacency's passes (20; `deqp-pv.json`), and the list's 63 fan, strip and restart cases still pass (`deqp-ia.json`).
- **Transform feedback** (`VK_EXT_transform_feedback`: one stream, no queries, no draws by the captured count). The
  vertex stage's body is a function the WGSL's entry point calls; its captured outputs are copied into a private
  record; after the render pass (Vulkan reads no captured vertex in the pass that wrote it: no break, no pre-pass) the
  worker runs it as compute on the draw's bind groups and vertex buffers (a fetch generated from the render pipeline's
  vertex layout) into copies of the bound ranges, whole primitives only, counters resumed and written. Attachment-less
  passes (all of dEQP's captures) get an attachment of the device's: before, `Render pass has no attachments` dropped
  their submits. dEQP-VK: 134 of 143 supported `transform_feedback.simple` (less queries, streams, indirect, multiview,
  geometry, tessellation) and every-third `fuzz` vertex cases pass (`deqp-xfb.json`); the 9 failures are
  `xfb_clipdistance_*` (the 8th distance reads 0: filed). The first run found arrays' and matrices' records at one
  offset (`nir_io_add_intrinsic_xfb_info` matches by location, before constant folding moved their slots there).
- **The program** (`angle-es3.json`; `PAGE=bench/vulkan/angle/es3.html node bench/vulkan/dawn-frames.ts guest`): the
  guest's Chromium with `--use-angle=vulkan` now gives **WebGL 2.0 (OpenGL ES 3.0) on Venus** ("ANGLE (Google, Vulkan
  1.3.296 (Virtio-GPU Venus (webpc WebGPU)))"; VK0 A had ES2 only). A flat varying from the last vertex, a transform
  feedback capture of four points and 24 uniform blocks summed all match ANGLE on virgl's GL. With Chromium's own
  Vulkan device on too (`--enable-features=Vulkan`) it starts (no crash this time) and the first two match, the
  uniform blocks' sum doesn't (205 for 156: filed).
- **The pass list** (`tests/deqp/vk.txt`): 4,424 → 4,599 (21 uniform-buffer, 20 provoking-vertex, 134 transform
  feedback cases).
- **Tests** (each failing with its bug planted back): `tests/venus-driver.test.ts` misc `manyUniforms`, passes
  `flatLast`, `flatFanLast`, `flatFanFirst`, four `transform feedback:` cases; `tests/wgsl.test.ts` a captured block's
  record. The link test's parse of pipeline cache data now steps to 4-aligned headers (a shader's data needn't end on
  a word: the vertex stage's longer WGSL made one that didn't).
- **CI** (the code at 9f3fd87e, docs after it): `scripts/ci.sh` OK (532 s); `scripts/ci-deqp-vk.sh` OK (828 s: the
  4,599-case list in 570 s, YCbCr's 773 in 89 s, the replays).

## VK3 L7.3: GTK4's black frames were L4c-D's partial CLEAR; GTK4 takes GL anyway; YCbCr on by default (GTK4 aborted without it)

2026-10-28. The desktop guest (Arch Linux, GTK 4.24.1, Mesa 26.2.5, sway 1.12 on GLES through virgl), 4 vCPUs, through
`bench/gpu/gtk4-load.ts` (each demo left 30 s, measured 10; `RENDERERS=default` now leaves GSK_RENDERER unset and the
results keep GSK's "Using renderer"/"Not using" lines); the M4 (Chrome for Testing 153.0.8010.12, ANGLE and WebGPU on
Metal, macOS 26.6.2) through `bench/gpu/sway-mac.sh`, and the dev VM's SwiftShader (Chromium 153). JSON and screenshots
in `results/vk3/l73/`.

- **The black frames are understood, and gone since VK3 L4c-D** (42a96e26). With YCbCr backed (`?gpu=vkycbcr`) and
  GSK forced onto Vulkan, frames and fishbowl draw right on both hosts (`gtk4-ycbcr-mac.json`,
  `gtk4-ycbcr-swiftshader.json`, `frames-vulkan-mac.png`). GSK redraws only the damaged part of its window, a render
  area short of the attachment with a CLEAR load op: the driver clears that with a clear rect, whose colour it nested
  one array too deep until L4c-D ("a partial render area's CLEAR cleared to zeros"), so the worker cleared to zeros.
  **Planting the old nesting back** (`wg_cmd.c`'s clear rect) gives VK2 L7's picture exactly: the headerbar right
  (outside the area), the content black, "Click to type" with no pill (`frames-vulkan-plant-clear-mac.png`,
  `gtk4-plant-clear-mac.json`). The first suspect, dual-source blending refused by the translator before L4f (GSK
  uses `SRC1_ALPHA` where the device has it), was ruled out the same way: planted back, frames still right
  (`gtk4-plant-dualsource-mac.json`). The test that holds the fix is L4c-D's `passes: a resumed pass over part of the
  attachment…` (its top-right quadrant is the clear rect's colour).
- **"Near-empty" fishbowl is fishbowl adapting, not a drawing bug:** it drops icons while its frames are slow. One of
  four fishbowl runs on Vulkan on the M4 settled at 1 icon and 20 frames/s (`fishbowl-vulkan-collapsed-mac.png`,
  `gtk4-bar-mac-2.json`; VK2 L7's "one icon at 6 frames/s"), the others held 59 frames/s with 72–144 icons. Collapsed,
  gtk4-demo woke ~1,950 times a second with the guest 11% busy and each submit had 6.6 passes at one icon: waiting, not
  drawing (backlog "GSK's Vulkan renderer on Venus misses GTK4's bar").
- **GTK4 doesn't take Vulkan by default, with or without YCbCr.** On Wayland GTK tries Vulkan first, but only on a
  device with a dma-buf format other than LINEAR (`gdk_vulkan_init_dmabuf` advertises only modifiers other than LINEAR,
  which it reads through mmap instead), and Venus's device has LINEAR alone: "Not using Vulkan: no dmabuf support",
  GSK's GL renderer (`gtk4-default-swiftshader.json`, `gtk4-default-mac.json`). **Without YCbCr, though, every GTK4
  program aborted at its start on a machine with Vulkan**: GTK 4.24 asserts YCbCr on a device with the dma-buf
  extensions (`gdk_display_create_vulkan_device`: `features & GDK_VULKAN_FEATURE_YCBCR`), and since VK2 L7 dropped
  YCbCr the device has had the extensions and not YCbCr (VK2 L7's "GL by default" was measured with YCbCr advertised
  but not its extension: `vkCreateDevice` failed and GTK fell back to GL) (`gtk4-default-before-virgl-vulkan-swiftshader.json`, `gtk4-default-ycbcr-off-swiftshader.json`:
  gtk4-demo exits; a machine without Vulkan takes GL: `gtk4-default-before-virgl-swiftshader.json`).
- **So YCbCr is on by default** (`?gpu=vkycbcr=off` holds it): the kickoff's condition ("only once GTK4 meets its bar")
  guarded against GTK4 taking Vulkan by default, which it doesn't; without it GTK4 can't start. Guest-visible
  (pre-approved). The caps test now holds it on by default and off with the switch (failing first).
- **GTK4's bar (G) on Vulkan, forced, against GL** (the M4, two rounds alternated, `gtk4-bar-mac-1.json`,
  `gtk4-bar-mac-2.json`; gtk4-demo's CPU in ms a second, the guest's 4 vCPUs busy):

| gtk4-demo | GL: frames/s, CPU, busy | Vulkan: frames/s, CPU, busy | |
| --- | --- | --- | --- |
| fishbowl (icons when shot) | 57.8, 834, 27% (105); 57.1, 422, 15% (92) | 59.4, 318, 13% (72); **20.0**, 338, 11% (1) | less CPU an icon; collapsed once |
| frames | 59.5, 114 (1.91 ms a frame), 8%; 59.8, 109 (1.82), 8% | 59.8, 121 (2.02), 8%; 59.5, 123 (2.07), 8% | +0.1–0.25 ms a frame |
| iconscroll | 29.3, 929, 29%; 27.8, 923, 28% | **8.9**, 375, 11%; **9.3**, 387, 11% | a third of GL's rate |

  GSK on Vulkan misses the bar: iconscroll runs at a third of GL's rate with the guest mostly idle (gtk4-demo ~1,800
  wake-ups a second, Venus's guest yielding in `vn_relax` on the ring; its frames' submits 13 passes and 140 draws,
  done in ~5 ms on Metal, fences back in 7 ms on average and up to 140), and fishbowl can settle in the same slow state.
  What's missing is filed (backlog "GSK's Vulkan renderer on Venus misses GTK4's bar"): which Venus calls a frame waits
  on. GTK4 stays on GL, which it takes by itself; only once GSK on Vulkan meets the bar would a modifier other than
  LINEAR be worth offering.
- **dma-buf modifiers:** GTK4's draws need none (its swapchain is Venus's WSI's, LINEAR); its imports (video,
  GtkGLArea's offload) would, and those are what makes GTK take Vulkan. Nothing to fix on the import side for the bar.
- **CI:** `scripts/ci.sh` OK (454 s); `scripts/ci-deqp-vk.sh` OK (829 s: tests/deqp/vk.txt now with YCbCr on,
  vk-ycbcr.txt, page-venus); `scripts/ci-debian.sh` OK (417 s). steps.txt unmoved.

## VK3 L7.2: YCbCr conversions backed (behind `?gpu=vkycbcr`); opaque-fd semaphores are the guest's Mesa's

2026-10-28, the dev VM (SwiftShader, Chromium 153; the dEQP-VK guest's Mesa 26.2.5); JSON in `results/vk3/l72/`.

- **The feature** (vk/README.md "The driver", YCbCr conversions): with `?gpu=vkycbcr` the device has
  `samplerYcbcrConversion`, `EXT_ycbcr_image_arrays` and the 8-bit multi-planar formats (2- and 3-plane 420, 422, 444:
  every plane a format WebGPU samples and filters), optimal tiling, with midpoint and cosited chroma, a linear chroma
  filter and disjoint planes. A multi-planar image is a texture per plane; a binding whose immutable samplers convert
  has slots for its views' other planes; the translator runs Mesa's `nir_vk_lower_ycbcr_tex` (implicit chroma
  reconstruction) before its own lowering. Off by default (the caps test holds it, NV12's features too).
- **Tests:** `tests/wgsl.test.ts` translates a compute shader with a conversion on its sampler (NV12, BT.709 narrow;
  midpoint nearest and cosited linear) and runs it on two textures against the spec's matrices; it fails with the
  lowering planted out. `tests/venus-driver.test.ts` "misc: a disjoint NV12 image…" uploads a disjoint NV12 image plane
  by plane and samples it through the driver; it fails with the plane views planted out (chroma from the luma plane).
- **dEQP-VK** (`deqp-candidates.json`, `.txt`): of the ycbcr groups' 3,209 cases of the 8-bit formats (optimal tiling,
  compute and fragment, descriptor sets; filtering, misc, single_plane_copy.optimal), **953 pass, 114 fail, the rest
  NotSupported** (other formats, linear tiling, explicit reconstruction, planes as attachments or storage). All of
  conversion's 432 that run pass, format's 48, query's 48. The failures: views of a plane in another format of its
  class (66: WebGPU's views differ only in sRGB-ness, so the view is invalid and its submit dropped) and images aliasing a
  plane's memory (48: images are textures, not their memory's bytes): docs/backlog.md "YCbCr's gaps".
  `tests/deqp/vk-ycbcr.txt` holds 773 of the passes (copy thinned to every second), run by ci-deqp-vk.sh with
  `?gpu=vkycbcr` in a second boot (~1.5 min).
- **The lead (time-boxed): opaque-fd semaphore export can't be made real on the host.** The guest's Venus
  (`vn_physical_device.c`) offers semaphores as sync files only, hard-coded, whatever the renderer has; its
  `vn_CreateSemaphore` backs only a sync-file export, and `vn_GetSemaphoreFdKHR` asserts a sync file (compiled out)
  and returns the payload's union as an fd: the fd 0 L7.1b saw. Neither vkr nor our driver ever sees the export or
  the fd request, so nothing on the host can answer it. A guest-side remedy would be a Mesa patch: offer
  `OPAQUE_FD` beside `SYNC_FD` where the renderer has external sync, and export the semaphore's DRM syncobj as an
  opaque syncobj fd (`vn_renderer_sync_export_syncobj(…, sync_file = false)`), which the kernel gives; that needs a
  patched Mesa in the guest images (or Chromium exporting sync files). Not tried within the hour: filed
  (docs/backlog.md "Dawn in the guest's Chromium on Venus"), so Dawn's samples weren't run on Venus.
- **CI:** `scripts/ci.sh` OK (452 s); `scripts/ci-deqp-vk.sh` OK (822 s: tests/deqp/vk.txt, vk-ycbcr.txt with `vkycbcr`, page-venus).

## VK3 L7.1b: the semaphore vkr never made; Dawn on Venus still not

2026-10-28, the dev VM (SwiftShader, Chromium 153; the desktop guest's Chromium 153.0.8010.36, Mesa 26.2.5); JSON in
`results/vk3/l71b/`.

- **Reproduced** with `?gpu=vkycbcr` (new, opt-in: `samplerYcbcrConversion` advertised, not translated; off by default
  until GTK4's row) and the guest's Chromium as L7.1's `guest4` ran it (`--headless=new --enable-unsafe-webgpu
  --enable-features=Vulkan --use-angle=swiftshader`; `CHROMIUM_ARGS="--enable-unsafe-webgpu --enable-features=Vulkan"`
  for the page's own WebGPU, without which Venus has no device and draws nothing): `before.json`, vkr's `failed to look
  up object 287 of type 5`, the CS error, the context lost.
- **The cause:** Chromium's own Vulkan device creates a semaphore with `VkExportSemaphoreCreateInfo` of **opaque fds**
  (`handleTypes` 1). Venus offers semaphores only as sync files (its external-semaphore properties for opaque fds are
  0: `semfd.txt`) and backs sync-file ones in the guest, but passes any other export to the host, and creates
  semaphores asynchronously (the result never comes back). The driver's semaphores are Mesa's runtime's on
  `wg_sync_type` (sync files only), so `vk_common_CreateSemaphore` refused it (`VK_ERROR_INVALID_EXTERNAL_HANDLE`),
  vkr never had the object, and the next submit naming it was a fatal decoder error.
- **The fix:** `wg_CreateSemaphore` drops the export's handle types other than sync files and makes the semaphore
  (none can be exported through Venus anyway: the guest never asks the host for a semaphore's fd). Its test
  (`tests/venus-renderer.test.ts`, Node: semaphores made with exports of none, sync files, opaque fds, both, a
  timeline's opaque fds) failed first (a mask of 3 for 31: only none and sync files made) and fails with the fix planted out; the caps
  test checks YCbCr is off by default and on with the switch.
- **After it** (`after.json`): no vkr error, but the guest's GPU process dies on `Crashing due to FD ownership
  violation` (exit code 133) and comes back without Vulkan; Dawn takes SwiftShader again (its five samples drawn, as
  L7.1's). `semfd.ts` (ctypes in the guest) shows why that's likely: the guest's Venus hands back **fd 0** for
  `vkGetSemaphoreFdKHR` of an opaque fd (VK_SUCCESS), then -1 (its `vn_GetSemaphoreFdKHR` assumes sync files; a
  device-only semaphore's union reads as fd 0). Chromium then owns stdin. `arms.json`: the same with
  `--disable-gpu-compositing`; `--use-gl=disabled` has no adapter at all.
- **So Dawn did not run on Venus**, and no frames were compared. The remainder is the guest's (Chromium exporting
  opaque fds the device doesn't offer; Venus answering with a descriptor it doesn't own): docs/backlog.md "Dawn in the
  guest's Chromium on Venus".
- **CI:** `scripts/ci.sh` OK (453 s); `scripts/ci-deqp-vk.sh` OK (734 s).

## VK3 L7.1: Dawn's row (indexed descriptor arrays, sample-rate shading); Dawn in the guest's Chromium not yet

2026-10-28, the dev VM (SwiftShader, Chromium 153); JSON in `results/vk3/l71/`.

- **The features, advertised once backed.** Dawn's Vulkan backend refuses a device without the four
  `shader*ArrayDynamicIndexing` features (`PhysicalDeviceVk.cpp`: robustBufferAccess, BC or ETC2+ASTC, the four,
  fragmentStoresAndAtomics, fullDrawIndexUint32), and its core level wants `sampleRateShading` (else compatibility
  only). Arrays of buffers and storage images indexed dynamically are now a tree of ifs over their elements, as
  textures' were; sample-rate shading runs a fragment stage per sample (inputs at their sample, `sample_index` read,
  `gl_FragCoord`/`gl_SamplePosition` at Vulkan's standard locations by an override of the sample count): vk/README.md
  "The shader path". `tests/wgsl.test.ts` has a test for each (both failing first); a planted bug in each (every
  element's access at element 0; the pipeline's sample shading dropped) fails them and 6 of 6 dEQP-VK cases
  (`deqp-planted.json`).
- **dEQP-VK** (`deqp-candidates.json`, `deqp-sample-shading.json`): of 338 candidates, 163 passed at first; the
  min_sample_shading cases failed until `gl_FragCoord` was moved to the sample (WGSL's `position` is the pixel's
  centre at the sample rate too: "less unique colors than requested"), then all 54 that run of the sample-shading
  groups pass. The list grows **4,251 → 4,424**: `glsl.opaque_type_indexing`'s ubo and ssbo (compute, fragment: all
  24) and a third of its sampler group, `multisample.min_sample_shading*`, `multisample_shader_builtin`,
  `multisample_interpolation`'s consistency groups (samples_4), and every sixth SAMPLE_ZERO `depth_stencil_resolve`
  case that passes (38 of the 44 sampled that run; the 6 others are s8_uint's stencil resolves: filed). Not taken: `interpolateAt*` (not translated),
  integer cube textures sampled with a sampler (zeros), samples other than 4.
- **The row's cost:** none where a program uses neither: the tree costs a shader that indexes an array dynamically a
  compare per level (an array of n elements, log2 n ifs and n copies of the access), and sample-rate shading costs
  what per-sample shading costs, only where a pipeline asks for it (a minimum over one sample a pixel, or the shader
  reads the sample).
- **The program: Dawn in the guest's Chromium, not yet** (`dawn-frames.ts`, `dawn/samples.html`: five WebGPU samples
  drawn once and read back in the page, shown on 2D canvases and grabbed from the page's screen; the WebGPU canvas
  too). The method holds: the desktop guest's Chromium on its own SwiftShader draws all five **byte for byte** as the
  dev VM's Chromium does (`compare-guest-swiftshader.json`, 0 bytes off). But its Dawn never takes Venus:
  - without `--enable-features=Vulkan` Chromium's Dawn offers only its SwiftShader (`guest1.json`, `guest2.json`,
    `--disable-gpu-sandbox` too);
  - with it, Chromium's own Vulkan device refuses Venus: `samplerYcbcrConversion is not supported`
    (`gpu/vulkan/vulkan_device_queue.cc`), and on Wayland Chromium warns that `--ozone-platform=wayland` isn't
    compatible with Vulkan (no window came up; the image has no Xwayland for `--ozone-platform=x11`);
  - with YCbCr advertised in an experiment build (not committed: `guest3.json`, `guest4.json`), Chromium starts on
    Wayland and in `--headless=new`, but its GPU process's Vulkan context dies on Venus: vkr logs `failed to look up
    object … of type 5` (a semaphore) in a submit, `early bail due to fatal decoder state`, the GPU process crashes
    and comes back without Vulkan, and Dawn takes SwiftShader again.
  So the program needs more than Dawn's row: YCbCr conversions advertised (GTK4's row, L7.4's), Chromium's Vulkan
  context alive on Venus (the semaphore it submits that the host never made: likely an external semaphore type the
  driver doesn't create), and a window (Xwayland in the desktop image, or `--headless=new`, whose frames would come
  out through the page's log). Filed as L7.1's remainder (VK3-HANDOVER.md, docs/backlog.md).
- **CI:** `scripts/ci.sh` OK (526 s); `scripts/ci-deqp-vk.sh` OK (736 s: all 4,424 of the list pass in 565 s, the
  replays 171 s).
- **The reference**: the dev VM's Chromium wouldn't take lavapipe through the Profiles layer either (its Dawn offers
  its SwiftShader; with `--enable-features=Vulkan`, ANGLE and Skia on the profile's Vulkan fail first), so the frames'
  reference is Dawn on the dev VM's SwiftShader (WebGPU, not through Vulkan).

## VK3 L6c: vkQuake's first frame, the out-of-context review of L5-L6a

2026-10-28, the dev VM (SwiftShader, Chromium 153); JSON in `results/vk3/l6c/`.

- **vkQuake's frame 5** (`vkquake-<commit>.json`, the Debian guest's replay): bytes off by more than 24 from lavapipe's,
  of 921,654, frames 5 / 15 / 30: at 20e9980e (L5) 15,438 / 15,352 / 15,449 (1.7%, vk/README.md's table); at
  96a0142f (L5b) and a82e482d (L6a) **735,281** / 15,915 / 15,743. The table was right; L5b broke it. The page logged
  `usage (Uniform|Storage(read-write)) includes writable usage and another usage in the same synchronization scope`
  and an invalid command buffer: L5b made every compute storage buffer `read_write`, and the frame's dispatch reads a
  uniform buffer and a read-only storage buffer of one memory, so its submit was dropped (the review's finding 2).
  Fixed by binding a read-only storage buffer writable only in a dispatch that writes its memory through another
  binding (a program variant with a module of its own): **15,438 / 15,352 / 15,449**, L5's counts byte for byte
  (`vkquake-fix.json`). Why CI missed it: the replays were only in `ci-debian.sh` (page-venus), which L5b–L6b, Vulkan
  changes, didn't run; `ci-deqp-vk.sh` runs page-venus now, and page-venus fails on any WebGPU error the page logged.
- **The review's 8 findings, all real, all fixed** (each test failing first or with its fix planted out;
  `tests/venus-driver.test.ts` 43, `tests/wgsl.test.ts` 8): 1 a submit of signals alone overtook held submits (held
  now, but vkr's ring fences, flagged by vkr's patch; dEQP-VK's 92 timeline and fence cases of the list pass); 2 above;
  3 a query's write with a compute pass open; 4 clears counted by occlusion queries (the query carried on in one of
  the set's 64 spare slots, added on the GPU); 5 the restore test blind; 6 shared atomics filling the storage with a
  barrier under an `if` (the word borrowed through atomics); 7 the face split now only where both faces use the value
  that differs (the reorder left is inherent: one WebGPU reference); 8 a pool destroyed under a pending submit.

## The renderer's arena: 255 MiB, so a 2.5 GiB machine with Vulkan has one NUMA node

**2026-10-29**, after VK3 (the dev VM, SwiftShader, Chromium 153.0.8010.52; `results/arena/`). A Venus machine's memory
0 holds the core's heap (at least 1 GiB), the scratch page and fw_cfg's files (1 MiB), RAM, Venus's 256 MiB window and
the renderer's arena; with a 256 MiB arena 2,559 MiB of RAM fit, so the page's 2.5 GiB (and guest-session.ts's
default) spilled 1 MiB into a NUMA node all of whose pages the kernel can't use ("SLUB: Unable to allocate memory from
node 1", `dmesg-256.txt`). The arena's use, from web/vm.ts `heapUse` (now counting it apart): dEQP-VK's whole pass
list (4,725 cases, all passing) took its high-water mark to **137.1 MiB** of 256 (28.5 MiB of its pages touched;
`deqp-vk-256.json`), `memory.binding.regular.*` 34.3 MiB. So the arena is **255 MiB** (web/ram.ts `VENUS_ARENA`, the
module linked at 0xF010_0000), 118 MiB above the most seen; the window, which the guest sees, stays. A 2,560 MiB
Vulkan machine now boots with one node ("NUMA: Faking a node", SLUB `Nodes=1`, `dmesg-255.txt`; its memory binding
group passes, `memory-binding-255.json`); 4 GiB with Vulkan splits 2,560 + 1,536 MiB. A snapshot keeps its own split,
so one taken before restores onto 2,559 + 1. The host refuses a renderer module linked elsewhere (`venus_arena_base`,
checked before instantiating: an old module would write its data over the core's heap), and the Machines page's and
the toolbar's NUMA note now count Venus's share of memory 0.

## Tools

- GD G2: `tint-time.ts` (each WGSL module's `createShaderModule` on a device of its own, `REPEAT` runs of their own
  text, a timeout that relaunches the browser) and `mac-tint-time.sh` (the same on the Mac's GPU); a program's stages
  as WGSL from the native translator (`vk/build.sh native`, `WGSL_DEVICE=<features>,<subgroup size>`).
- VK4 T1: `census.ts` (dEQP-VK's not-passed cases by cause, from `../gpu/deqp-run.ts`'s results; `--cases <cause>` lists
  a cause's); `deqp-run.ts`'s `DETAIL` in one pass over the log (a census's hundreds of cases) and `DETAIL_NOTSUPPORTED=1`
  (the reasons of NotSupported cases too; through `../gpu/sway-mac.sh`).
- `nir/` (VK1 step 1): `build.sh` (the native Mesa build for its compile commands and generated sources, the
  toolchains, `gen.ts`'s ninja files), `spike.c`, `spike.ts` (the module with stubbed WASI), `run.ts` (native, Node,
  Chromium), `page.ts`; `mac.sh nir`.
- `scene/` (`build.sh`: vk, gles and their shaders), `assets.ts` (the pack), `sweep.sh` (the native sweep),
  `mac.sh` (`kosmickrisp`, `moltenvk`, `webgpu`, `arm3`, `micro` on the Mac host), `macsdk.ts` (the SDK's parts),
  `nvidia.sh` (the user's desktop).
- `webgpu.ts` (arm 2), `arm3.ts` and `translate/` (arm 3: `capture.sh`, `convert.ts`, `shaders.ts`, `replay.ts`,
  `naga-wasm.ts`; D: `coverage.ts`, `programs.sh`), `micro.ts` and `micro/` (C, E, F), `guest.ts` and `images/vulkan/build.sh` (arm 4), `server.ts`
  (the pages without Vite), `summary.ts`, `tools/ppmdiff.py`.
- `tools/venus-oracle/` (B), `tools/vulkan-tools/` (GFXReconstruct, the Profiles layer), `profiles/` (A).
- VK3 L7.1–L7.1b: `dawn-frames.ts` and `dawn/samples.html` (Dawn's samples in the guest's Chromium against the dev VM's;
  `LOGBEFORE=<pattern>`: the guest Chromium's log up to a line), `semfd.ts` and `semfd.py` (Venus's opaque-fd semaphores in
  the guest, through ctypes).
- VK3 L4d: `mpv-frames.ts` keeps its page grabs (`<tag>-page.ppm`) and takes `REGRAB=<s>` (the screen again that much later,
  mpv held as long; through `sway-mac.sh`, `green.sh` and nvidia.sh's `mpv` step too).
- VK3 L4: `upload-race.ts` (orderings libplacebo's advanced path leans on, in WebGPU alone; `mac-costs.sh` with
  `SCRIPT=upload-race.ts`); `mpv-frames.ts` takes `GPU_KNOBS`, `MPV_ARMS`, `PAIRS` and `SHOT2` (through `sway-mac.sh` too)
  and records libplacebo's complaints and Venus's submits; the page takes `?gpu=vkformats=all` and `?gpu=vkhold=<feature>`.
- VK3 L2: `fence.ts` and `fence/` (a worker's turns: nested `setTimeout`, messages, `postTask`, `Atomics.waitAsync`'s
  sleeps; WebGPU's done alone and nudged; in `nvidia.sh page`'s `fence` step, `mac-costs.sh` with `SCRIPT=fence.ts`
  on the Mac); `costs.ts` takes `POLL=timeout`; `guest.ts` takes `GPU_KNOBS` and `SIZE` and logs Venus's fence
  breakdown.
- VK3 L1: `present.ts` (the page's screen against the guest's frames, way by way; in `nvidia.sh page`'s `present` step,
  and through `../gpu/sway-mac.sh` with `SCRIPT=../vulkan/present.ts`).
- VK2 L7: `costs.ts` and `costs/` (a submit's and a pipeline's costs; `mac-costs.sh` on the Mac), `adapter.ts` (the
  adapter a Chromium gets), `nvidia-bundle.sh` and `nvidia.sh page` (the page on the user's NVIDIA desktop).
- VK2 L6: `mpv-frames.ts` (mpv's frames on Vulkan against software decoding and GL), and `../audio/avsync.ts`'s
  `MPV_ARGS`, `MPV_VARIANTS` (mpv's options in alternated rounds) and `SHIM` (the media disk's VA driver), all through
  `../gpu/sway-mac.sh`.
