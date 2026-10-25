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

1. **`spirv_to_nir` and NIR built to wasm** (route (b)'s premise): download size, ms a stage. VK1's first step.
2. **Tint's SPIR-V reader** on D's 110 stages (needs Dawn's tree): route (a)'s other frontend; it matters only if
   route (b) fails its first step.
3. **C (5): the scene's fish through a geometry-shader pre-pass**, the cost in a whole frame (C's isolated geometry
   case cost 1.2× drawing static buffers).
4. **The WebGL Aquarium in the guest's Firefox and the host's Chromium**, arm 4's cross-check: the GLES port matched
   the native frames, so it wasn't needed for correctness.
5. **The NVIDIA desktop again, headless or alternated**: one session in a headed browser, with light-load clocks
   bimodal; a second run would settle the 0.25 ms floor's spread.
6. **mpv on the direct profile with VA-API**: whether libplacebo imports the decoded surfaces or falls back (G).

## Tools

- `scene/` (`build.sh`: vk, gles and their shaders), `assets.ts` (the pack), `sweep.sh` (the native sweep),
  `mac.sh` (`kosmickrisp`, `moltenvk`, `webgpu`, `arm3`, `micro` on the Mac host), `macsdk.ts` (the SDK's parts),
  `nvidia.sh` (the user's desktop).
- `webgpu.ts` (arm 2), `arm3.ts` and `translate/` (arm 3: `capture.sh`, `convert.ts`, `shaders.ts`, `replay.ts`,
  `naga-wasm.ts`; D: `coverage.ts`, `programs.sh`), `micro.ts` and `micro/` (C, E, F), `guest.ts` and `images/vulkan/build.sh` (arm 4), `server.ts`
  (the pages without Vite), `summary.ts`, `tools/ppmdiff.py`.
- `tools/venus-oracle/` (B), `tools/vulkan-tools/` (GFXReconstruct, the Profiles layer), `profiles/` (A).
