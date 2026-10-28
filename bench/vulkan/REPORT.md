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

The WebGL Aquarium (WebGLSamples, BSD-3-Clause: its models, textures, fish table, camera, shaders; THIRD_PARTY.md),
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
Apache-2.0), and `c11/impl/threads_posix.c` (BSL-1.0); THIRD_PARTY.md has the rows.

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

## Tools

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
