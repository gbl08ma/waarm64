# bench/gpu: G0, the WebGPU environment and the ways to present a 2D frame

**2026-10-01.** The measurements behind G0 of [docs/plans/graphics.md](../../docs/plans/graphics.md) and
the G0/G1 kickoff's loop 1 (`M8-GRAPHICS-KICKOFF.md`, in git history since G1's exit). The suite is `bench/gpu/suite.ts` (a worker, like the other suites);
the JSON is committed in `results/`.

```sh
# the dev VM: a software adapter (SwiftShader), correctness and relative costs only
node bench/run.ts --page bench/gpu/index.html --chromium-args='--enable-unsafe-webgpu --enable-features=Vulkan --use-angle=swiftshader --use-gl=angle'
# the Mac host: the real GPU (the user's answer 5 to the kickoff), headless, temporary profile
bench/gpu/run-mac.sh
```

## Setup

| | dev VM (software) | Mac host (real GPU) |
|---|---|---|
| Machine | Lima `dev`, 8 vCPUs on the M4 mini | the same M4 mini (10 cores), macOS 26.6.2 |
| Chromium | 153.0.8010.52 (the zypper package) | 153.0.8010.12 (Playwright's Chrome for Testing, headless) |
| Flags | `--enable-unsafe-webgpu --enable-features=Vulkan --use-angle=swiftshader --use-gl=angle` | `--enable-unsafe-webgpu` |
| WebGPU adapter | google / swiftshader | apple / metal-3 (Apple M4, Metal 4) |
| Samples | 20 after 3 warm-up frames, medians and IQR in ms | the same |

The JSON's commit is the one the suite was committed on top of (`dirty`: the suite itself was new);
the Mac run was made from a copy (`~/waarm64-gpu-bench`: `bench/`, `tools/serve.ts`, a copy of
`playwright-core`; Node 26 and Playwright's Chromium were there already). Nothing else on the host
was installed or changed.

## What a headless Chromium needs for WebGPU

- **`--enable-unsafe-webgpu`** is enough for an adapter (`navigator.gpu` exists only in a secure
  context: `http://127.0.0.1` counts, `about:blank` doesn't). On the VM it is a **SwiftShader**
  Vulkan adapter with 21 features (subgroups, BC/ETC2/ASTC, `clip-distances`,
  `bgra8unorm-storage`, `float32-filterable`; no `shader-f16`, no `dual-source-blending`); the Mac's
  Metal adapter has 25 (adds `shader-f16`, `dual-source-blending`, `primitive-index`,
  `texture-formats-tier1/2`, `chromium-experimental-subgroup-matrix`). The lists are in the JSON.
- **Presenting to an `OffscreenCanvas` from a worker** (`getContext('webgpu')`, `getCurrentTexture`,
  a render pass) fails on the software adapter with `OperationError: A valid external Instance
  reference no longer exists` unless the Vulkan shared-image path is on: **`--enable-features=Vulkan
  --use-angle=swiftshader --use-gl=angle`**. With them it works, and so does WebGL2 (ANGLE on
  SwiftShader). The same flags are what the correctness tests will use.
- **Don't use WebGPU on the main thread and in a worker of the same page on the software adapter:**
  the worker's `requestAdapter()` then resolved to `null` (one software adapter; found while
  probing, not pursued). The page's graphics path lives in one thread anyway.
- **Real GPU, headless:** the Mac's Chrome for Testing gives a Metal adapter with no extra flags.

Adapter limits, real GPU: `maxBufferSize` and `maxStorageBufferBindingSize` 4294967292,
`maxTextureDimension2D` 16384, `maxImmediateSize` 64 (immediates are there); what a default device
gets is smaller (`maxBufferSize` 256 MiB, `maxTextureDimension2D` 8192) unless `requestDevice` asks
for the adapter's limits. The software adapter: `maxBufferSize` 1 GiB, `maxTextureDimension2D` 8192,
`maxImmediateSize` 64. The full lists are in the JSON.

## Shared memory into WebGPU and WebGL

`queue.writeBuffer`, `queue.writeTexture` and `gl.texSubImage2D` **all accept views of a
`SharedArrayBuffer`** in Chromium 153 (no error, and no cost over a plain `ArrayBuffer`'s) The bytes are the
guest's RAM in our machine, so a backend can hand a view of a framebuffer's pages to the GPU with no
intermediate buffer.

`writeBuffer` of a whole frame (ms; "return" is the time the call takes, "done" until
`onSubmittedWorkDone`), real GPU:

| size | source | return | done |
|---|---|---|---|
| 1080p | SharedArrayBuffer | 0.22 | 1.13 |
| 1080p | plain ArrayBuffer | 0.17 | 0.87 |
| 1440p | SharedArrayBuffer | 0.32 | 2.88 |
| 1440p | plain ArrayBuffer | 0.31 | 2.15 |
| 4k | SharedArrayBuffer | 0.71 | 5.21 |
| 4k | plain ArrayBuffer | 0.72 | 5.01 |

## Presenting a frame (the real GPU, ms until the work is done)

x8r8g8b8 frame in shared memory (B, G, R, X in memory), onto an `OffscreenCanvas` in a worker.
`damage10` is a rectangle of ~10% of the area. Canvas 2D: swizzle in JS, `putImageData` of the
rectangle, then a 1-pixel `getImageData` to wait for the drawing; WebGL2: `texSubImage2D` of the raw
bytes (`UNPACK_ROW_LENGTH`/`SKIP_*` select the rectangle), the swizzle in the fragment shader, a
full-screen quad, `finish()`; WebGPU: `writeTexture` into a **`bgra8unorm` texture** (no swizzle),
a full-screen quad, `onSubmittedWorkDone`.

| size, damage | canvas 2D (JS swizzle) | canvas 2D (RGBA ready) | WebGL2 | WebGPU |
|---|---|---|---|---|
| 1080p full | 3.58 ±0.15 | 1.58 ±0.54 | 0.82 ±0.15 | 2.21 ±0.16 |
| 1080p damage10 | 0.94 ±0.45 | 0.38 ±0.01 | 0.06 ±0.06 | 1.40 ±0.21 |
| 1440p full | 5.90 ±0.14 | 2.96 ±0.12 | 1.89 ±0.20 | 3.49 ±0.35 |
| 1440p damage10 | 0.77 ±0.22 | 0.47 ±0.01 | 0.19 ±0.03 | 1.08 ±0.01 |
| 4k full | 12.28 ±0.16 | 5.70 ±0.56 | 4.32 ±0.24 | 6.21 ±0.26 |
| 4k damage10 | 1.79 ±0.09 | 1.13 ±0.54 | 0.68 ±0.03 | 2.61 ±0.47 |

The software adapter (SwiftShader, VM; relative costs only; its WebGPU numbers are dominated by
rasterizing the full-screen quad in software):

| size, damage | canvas 2D (JS swizzle) | canvas 2D (RGBA ready) | WebGL2 | WebGPU |
|---|---|---|---|---|
| 1080p full | 4.81 ±0.11 | 3.18 ±0.11 | 1.16 ±0.16 | 9.13 ±3.82 |
| 1080p damage10 | 0.89 ±0.05 | 0.75 ±0.06 | 0.04 ±0.01 | 6.97 ±1.05 |
| 1440p full | 8.50 ±0.06 | 5.54 ±0.06 | 2.35 ±1.32 | 10.35 ±1.04 |
| 1440p damage10 | 1.16 ±0.05 | 0.94 ±0.03 | 0.30 ±0.39 | 8.62 ±1.73 |
| 4k full | 18.34 ±0.26 | 11.57 ±0.33 | 10.10 ±0.55 | 19.81 ±0.58 |
| 4k damage10 | 2.13 ±0.06 | 1.49 ±0.07 | 0.17 ±1.80 | 15.99 ±0.42 |

"Return" times (the thread's own cost, without waiting for the GPU) are in the JSON; on the real
GPU the calls return in under 1 ms in every path at every size except where the CPU does the work:
the JS swizzle (canvas 2D, full frame: 1.6 ms at 1080p, 2.9 ms at 1440p, 6.8 ms at 4K) and WebGL2's
4K full-frame upload (4.3 ms).

## What it means for G1

- **A damaged rectangle is cheap in every path** (≤ 1.4 ms at 1080p, ≤ 2.6 ms at 4K, real GPU). The
  JS swizzle is what canvas 2D pays for: with the data already RGBA it's 2 to 3 times cheaper. So
  the swizzle should happen once, **inside `TRANSFER_TO_HOST_2D`'s gather** (the backend copies the
  rectangle out of the scatter list anyway), and the canvas gets RGBA.
- **Full frames** (a video, a full-screen redraw): canvas 2D with the swizzle fused into the
  transfer is 1.6 ms (1080p), 3.0 ms (1440p), 5.7 ms (4K); WebGL2 is 0.8, 1.9, 4.3 ms. Both are
  fine for a 60 Hz budget of 16.7 ms and neither is on the main thread. **Canvas 2D stays the
  choice for G1** (graphics.md's proposal; nothing in the numbers contradicts it), and the 3D steps
  bring the WebGPU canvas. A canvas's context type can't change once chosen: when 3D turns on, the
  page swaps in a new canvas (a `screen` event already exists for size changes).
- WebGPU's 2D path is the slowest for a damaged rectangle on the real GPU too (it redraws the whole
  surface at each present: 1.1 to 2.6 ms against 0.2 to 0.9 for the others) and about the same as
  the others for a full frame, so it earns its place as the 3D path's canvas, not the 2D one's.
- The numbers say nothing about **which thread** presents: that is loop 4's measurement
  (key-to-glyph, flush during a disk read).

## G1 exit: the device as built (2026-10-02)

Chromium 153.0.8010.52 headless on the dev VM (software compositing), commit `3943483` plus the exit's tools.

**The backend's own cost** (`flush_cost`: `web/gpu.ts` and `web/gpu-present.ts` as the page runs them, a resource whose
backing is 64 KiB chunks; `results/2026-10-02-vm-flush-cost.json`; ms, median ±IQR of 20):

| | `TRANSFER_TO_HOST_2D` | `RESOURCE_FLUSH` with its draw, to return | until the canvas has it |
|---|---|---|---|
| 1080p full | 1.49 ±0.04 | 1.39 ±0.74 | 1.43 ±0.77 |
| 1080p damage10 | 0.73 ±0.31 | 0.34 ±0.07 | 0.39 ±0.09 |
| 1440p full | 2.61 ±0.03 | 2.56 ±0.48 | 2.62 ±0.48 |
| 1440p damage10 | 0.95 ±0.26 | 0.52 ±0.39 | 0.57 ±0.44 |
| 4k full | 5.88 ±0.04 | 5.84 ±3.36 | 5.91 ±3.36 |
| 4k damage10 | 1.40 ±0.56 | 1.12 ±0.13 | 1.17 ±0.15 |

A transfer is ~0.7 ms a megapixel (the swizzle to RGBA), a flush's draw about as much again. The page's main thread
does nothing per frame (the canvas is the device worker's).

**The page's Debian, virtio-gpu against the simple framebuffer** (`node bench/gpu/page.ts`, two boots each,
alternating, 4 vCPUs, the Both view; `results/2026-10-02-page.json`):

| | virtio-gpu | simple framebuffer |
|---|---|---|
| Load to the first lit pixel | 7.6, 7.5 s (EDK2's graphics output) | 18.8, 18.7 s (the kernel's console) |
| Load to `running` | 52.2, 52.3 s | 53.6, 50.8 s |
| Key to glyph, serial terminal (ms, median, quartiles) | 10.8 (7.7–13.3, n 80) | 11.6 (10.3–14.1, n 80) |
| Key to glyph, screen (bash on tty1) | 52.8 (46.1–59.6, n 72) | 39.2 (35.7–42.1, n 74) |

- The terminal didn't move (the 10.5–11.4 ms of M8 loop 3), and `virtio_gpu` costs the boot nothing measurable.
- **The screen is ~13 ms slower on virtio-gpu, and it isn't the device.** The instrument (a frame loop on the page
  reading the canvas back) is not the one behind the ~15 ms of M8 loop 3 (draws seen in the worker), so only the two
  columns compare, and it says when the page's main thread can read the frame, not when it is on the glass. Split
  with a temporary timestamp in the presenter (40 keys): key to the flush at the device 12.2 ms (quartiles
  8.6–14.2), drawn 0.5 ms later, and then 43 ms until the probe sees the canvas change. So the time is lost after
  `putImageData`. **Why isn't settled.** The device worker is nested in the machine worker, where Chromium has no
  `requestAnimationFrame`, so it draws when the flush arrives, while the simple framebuffer is drawn inside the
  machine worker's animation frames: the likely cause is a frame drawn outside an animation frame being handed to
  the page later. A standalone page (three workers filling a canvas: in an animation frame, at once, at once from a
  nested worker; `bench/results/local/present/`, not committed) reproduces only part of it: all three reach the
  page in 11–12 ms, so drawing at once gains nothing over waiting for the frame, but loses nothing either. Backlog:
  measure on a real GPU (the Mac host), then try a device worker with animation frames.

**Host memory:** a resource is 4 bytes a pixel of JS memory: 8.3 MB at 1080p, 66.8 MB at the largest size the EDID
can say (4088×4088, just under the 64 MiB cap per resource); the 256 MiB total holds a console's buffer and a
compositor's two at that size, not a third.

## G3 loop 4: sway through the WebGL2 renderer (2026-10-09)

`bench/gpu/sway-load.ts` with `VIRGL_GPU=virgl` (G3's renderer in the GPU worker) and `virgl-null` (G2's), the dev
VM (SwiftShader, Chromium 153.0.8010.52) and the Mac host (`bench/gpu/sway-mac.sh`: ANGLE over Metal, M4, Chromium
153.0.8010.12); `results/g3-sway/`. Foot scrolling a `date` loop: the null renderer 59.8 frames a second in the VM
and 60 on the Mac; the renderer 55.6 and 55.0 in the VM, 60 on the Mac, sway's CPU a frame equal to the null
renderer's on the Mac (5.5 ms) and ~0.8 ms more on SwiftShader; the renderer's own time 1.1 ms a frame in the VM,
0.65 on the Mac. A first run made 38.8 (`vm-renderer-1.json`): the GPU worker committed a canvas frame at every
scanout and damage call (three a guest frame), held to the display's rate with the fences behind; drawing in an
animation frame fixed it (the split runs are `vm-skip-1.json`, the submits skipped, and `vm-skipfloor-1.json`,
skipped with G2's caps). Details in docs/graphics.md "The GPU worker".

## A 2D machine on WebGL2 (2026-10-18)

A 2D machine's screen draws through WebGL2 where the browser has it on a GPU (`web/gpu-present.ts`): the device copies
the guest's bytes as they are (`transfer_raw`) and the 3D machine's `Screen` uploads the damaged rectangle and draws
the scanout through the format's swizzle, as the 3D machine already did for its 2D scanouts. `flush_cost` runs both
screens side by side (commit `3bf4473` plus this change; ms, median of 20). The device worker's own time is the
transfer plus the flush until it returns (the draw is in it: the presenter draws at once a frame after the last).

| Mac host (M4, Metal; Chrome for Testing 153.0.8010.12, macOS 26.6.2) | transfer + flush, canvas 2D | transfer + flush, WebGL2 |
|---|---|---|
| 1080p full | 1.35 + 1.14 = 2.49 | 0.34 + 1.34 = 1.68 |
| 1080p damage10 | 0.53 + 0.39 = 0.92 | 0.18 + 0.48 = 0.66 |
| 1440p full | 2.40 + 1.95 = 4.35 | 0.66 + 2.05 = 2.71 |
| 1440p damage10 | 0.81 + 0.65 = 1.46 | 0.47 + 0.67 = 1.14 |
| 4k full | 5.39 + 4.22 = 9.61 | 1.44 + 9.20 = 10.64 |
| 4k damage10 | 0.95 + 1.40 = 2.35 | 0.25 + 1.15 = 1.40 |

`results/2026-10-18-mac-flush-cost.json`. A quarter to a third less everywhere but a full 4K frame, about even there
(+10%). **A full 4K upload costs 8–9 ms after an idle gap** of 20 ms or more and 2.3–4.7 ms back to back (an ad-hoc
`texSubImage2D` loop, 10 per variant): the same whatever selects the rectangle (whole view, `srcOffset`,
`UNPACK_ROW_LENGTH`, a shared buffer) and no better in strips of 16 to 540 rows. Not pursued: a guest redrawing a 4K
screen whole at every frame pays the same either way. "Until the canvas has it" (a 1-pixel read) is 1 to 6 ms
longer on WebGL2 than canvas 2D's; that read waits for the GPU process, which a real present doesn't.

**Software WebGL loses** (the dev VM, SwiftShader; `results/2026-10-18-vm-flush-cost.json`): the device worker's time
falls at the larger sizes (4K full 6.77 → 4.22, 4K damage10 1.04 → 0.55; 1080p full even, 1.81 → 1.89), but every present draws the
whole scanout on the CPU: 7 to 18 ms until the canvas has it, against 0.2 to 1 ms for canvas 2D. So `auto` keeps
canvas 2D where the renderer is software (SwiftShader, llvmpipe, Windows' Basic Render Driver), and the page tests,
which run on SwiftShader, keep testing that screen; `?gpu=gl2d` forces WebGL2 (`WAARM64_PAGE_QUERY=gpu=2d,gl2d` runs the
page tests on it), `?gpu=canvas2d` canvas 2D.

## dEQP-GLES's census (2026-11-09)

The whole GLES2 and GLES3 mustpass lists ran again on the dev VM's SwiftShader (Chromium 155.0.8059.84, ANGLE on
SwiftShader's Vulkan; the guest images/deqp/build.sh's: Arch Linux, Mesa 26.2.4, kernel 7.2.9; commit `6216098f` plus
this change), last counted whole at G4 (2026-10-10) before that track's last fixes. `bench/gpu/deqp-run.ts` over the
lists' contiguous slices (`CASES`, 4 slices of GLES2's 17,165 cases and 10 of GLES3's 44,768), four dEQP processes a
machine (`JOBS=4`), `PASSED=1 DETAIL=400`, two machines at once: ~55 min in all. `bench/gpu/deqp-census.ts` totals
them (`results/gles-census/`: `census.json`, each slice's result without its passed names, `slices/`).

| whole mustpass list | pass | fail | not supported | warnings |
|---|---|---|---|---|
| GLES2 (17,165) | 17,027 | 0 | 136 | 2 |
| GLES3 (44,768) | 44,399 | 0 | 358 | 11 |

G4's table, one GLES3 case more (a warning there). **No case fails**, and none crashed or hung. The warnings are
G4's: `flush_finish.finish` and `finish_wait` (timing, both lists), highp `floor`'s precision on SwiftShader (8), and
`fbo.completeness.renderable.renderbuffer.color0.rbo1_rbo2_rbo4`'s mixed sample counts (a status the spec allows).

**What isn't supported, by dEQP's reason** (the 494 run again with `DETAIL_NOTSUPPORTED=1`:
`results/gles-census/notsupported-gles*.json`):

| cause | GLES2 | GLES3 | |
|---|---|---|---|
| separate depth and stencil attachments (WebGL allows one depth-stencil attachment) | 91 | 12 | could be emulated: backlog |
| `EXT_draw_buffers_indexed` (WebGL2's `OES_draw_buffers_indexed` is there: a cap we don't take) | | 79 | **backlog** |
| `EXT_clip_control` (WebGL2's `EXT_clip_control` is there: `CLIP_HALFZ`) | 8 | | **backlog** |
| multiview (WebGL2's `OVR_multiview2` is there) | | 3 | **backlog** |
| `EXT_debug_marker` (the guest's Mesa doesn't expose it) | 3 | | backlog |
| `EXT_texture_sRGB_R8`, `_RG8` (not in WebGL2) | | 64 | could be emulated: backlog |
| transform feedback's separate components (WebGL2's limit is GLES's minimum, 4) | | 108 | WebGL2 |
| 8 samples (SwiftShader's WebGL2 has 4) | | 38 | the GPU |
| wide lines (WebGL2's widths are 1) | 17 | 28 | WebGL2 |
| `KHR_blend_equation_advanced`, `EXT_multisampled_render_to_texture` (not in WebGL2) | 1 | 10 | WebGL2 |
| no multisample default framebuffer (the run's `rgba8888d24s8ms0` configuration) | 16 | 16 | the run |

The probe of the page's WebGL2 (`OES_draw_buffers_indexed`, `EXT_clip_control`, `OVR_multiview2` offered;
`MAX_TRANSFORM_FEEDBACK_SEPARATE_COMPONENTS` 4, `MAX_SAMPLES` 4) is what places each row.

**The pass lists** are now every case that passed (`deqp-census.ts --lists`: 342 → 17,027 and 1,214 → 44,399, the
old lists' every case among them), and `scripts/ci-deqp.sh` takes `ci-deqp-vk.sh`'s seeded sample of each (every 8th
case of a group from a drawn offset; `tests/deqp-lists.ts`, shared), both machines at once, `--full` the whole lists.

**dEQP's processes a machine** (a 448-case GLES3 slice, `STRIDE=100 OFFSET=7`; `results/gles-census/jobs/`): dEQP's
own time 48 s at one process, 30 s at two, 27 s at four, the same results. Four it is (`WAARM64_DEQP_JOBS`): the gain
past two is small, and more contexts side by side is more of what one process never does. Contiguous quarters of a
slice are uneven: in the slice holding GLES3's `builtin_functions.precision` group (1,245 cases, up to 32 s each)
the processes took 121, 1,500 (the limit: 76 cases left, all passing when run alone), 397 and 150 s.
`deqp-run.ts`'s `JOBS_BLOCK=16` deals the list to the processes in blocks of 16 instead, which the test takes;
dEQP-VK's runs keep contiguous blocks (its neighbours as in the list).

| `scripts/ci-deqp.sh` (dev VM) | cases | seconds |
|---|---|---|
| before (the fixed lists) | 342 + 1,214 | ~360 |
| a sample (seed 3630069298) | 2,221 + 5,739 | 546 |
| `--full` | 17,027 + 44,399 | 2,873 (GLES2 1,085 s, GLES3 2,890 s, at once) |

## virgl's caps from WebGL2's extensions (2026-11-09)

The census's "not supported" rows marked backlog, taken (the same VM, Chromium 155.0.8059.84 on SwiftShader, the same
guest; `results/gles-caps-ext/`):

- **Independent blending** (`OES_draw_buffers_indexed`): `bset`'s `indep_blend_enable` and `indep_blend_func`, which
  give the guest's Mesa `OES`/`EXT_draw_buffers_indexed`; the renderer sets each buffer's blend, equation and color
  mask through its own layout (`enableiOES`, `blendFuncSeparateiOES`…). Of the 89 cases asked for, 77 pass and 12 are
  still not supported: they want `KHR_blend_equation_advanced` (WebGL2 has none). Two `random` cases failed first: the
  one blend color went through the first blended buffer's layout, an RGB565's, which stores no alpha, so the constant
  alpha became 1. Its alpha is now the guest's wherever the layout stores no channel there (one RGB565 target with
  `CONSTANT_ALPHA` was as wrong before).
- **Clip control** (`EXT_clip_control`): `CLIP_HALFZ`; the rasterizer's `clip_halfz` sets clip control's 0-to-1 depth,
  an inverted depth range turned round as `w - z`. GLES2's 8 `clip_control` cases pass.
- **Not reachable**: multiview (`OVR_multiview2` is there, but Mesa 26.2.4's virgl driver sets no `multiview` cap and
  virgl's protocol has no views) and `EXT_debug_marker` (Mesa 26.2.4 has none).

The pass lists take the 85: 17,035 and 44,476. Beside them, the groups the change could break (`grep`ped from the pass
lists: blending, `fragment_out`, depth ranges, clipping, draw buffers, polygon offset, `rasterization.fbo`), JOBS=4:
GLES3's 4,025 all pass but one, `rasterization.fbo.rbo_multisample_4.interpolation.triangles`, which uses neither and
passed alone and in two runs of its group at four processes; GLES2's 1,826 all pass.

## PERF loop 16: virgl's query poll (2026-11-10)

The backlog's "virgl's occlusion-query poll waits 4 ms a turn": a GL program waiting on `GL_QUERY_RESULT` waits for the
GPU worker's next look at its query. **The workload** is new: `glquery` (images/alpine/gl/glquery.c, in alpine-gl and
alpine-virgl, `waarm64.glq=`), GLES 3.0 on EGL surfaceless through Mesa 26.1.6's virgl: per frame a full-target quad,
then 4 small quads each in an `ANY_SAMPLES_PASSED` query whose result is waited on at once (an occlusion culler testing
a box), then a `glFinish`; 300 frames at 640×480, each wait and finish timed in the guest. It runs through
tests/browser/virgl-boot.html (the page's GPU worker, alpine-virgl under the JIT in a worker, now in realtime when
glquery runs: in deterministic time the idle guest's clock skipped ahead and a wait read 3.5 s) by
`bench/gpu/query-wait.ts`, arms alternated, three rounds, on the M4 (macOS 26.6.2, Chrome for Testing 157.0.8103.50,
Metal) through `sway-mac.sh` (`SCRIPT=query-wait.ts`). JSON in `results/perf16/`. The arms (`?gpu=querypoll=`,
web/virgl-host.ts `QueryPoll`): `timeout` (HEAD: a 4 ms timer), `wait` (`Atomics.waitAsync`'s 0.25 ms timeout),
`ticker` (Venus's ticker worker, web/venus-ticker.ts, notifying every 0.05 ms), `message` (a message to itself: every
task), `spin` (every task for 2 ms since the pending queries last changed, then the 4 ms timer).

**A defect first:** glquery's first wait never ended (the guest made ~5,500 fences a second for good). Mesa's
`get_query_result`, when its wait finds the state not DONE, maps the query's buffer by transfers from the host in a
loop until it reads DONE; the renderer wrote the state only into the guest's memory, and each transfer copied the
buffer's CPU copy, without it, over it. The state now goes into the CPU copy too (`queryState`); the queries' test in
tests/virgl-browser.test.ts reads the states after a transfer from the host and failed first. Why the first wait found
the state not DONE (its fence should have been held for the query) wasn't known here: the kernel's 15 s wait timed out in deterministic time (PERF loop 18).

| M4, glquery (rounds) | wait median, ms (IQR) | wait max | frames/s | glFinish median |
| --- | --- | --- | --- | --- |
| `timeout` (HEAD), session 1 | 14.17 (13.29–15.02), 13.13 (12.25–13.34), 13.16 (12.26–13.38) | 198–218 | 15.75 / 17.03 / 17.07 | 1.0–1.6 |
| `wait` | 7.17 (6.56–8.10), 7.15 (6.85–7.38), 7.10 (6.83–7.32) | 158–162 | 29.7 / 29.9 / 28.7 | 0.81–0.95 |
| `ticker` | 2.42 (2.38–3.34), 2.42 (2.38–3.33), 2.42 (2.39–3.33) | 11–12 | 91.1 / 92.9 / 92.8 | 0.13 |
| `message` | 0.815 (0.735–0.845), 0.81 (0.735–0.845), 0.81 (0.755–0.84) | 6.7–6.9 | 271.1 / 271.3 / 269.7 | 0.13 |
| `timeout` (HEAD), session 2 | 14.50 (13.56–15.11), 13.39 (12.92–14.69), 13.14 (12.29–13.40) | 157–223 | 14.97 / 16.50 / 17.42 | 1.0–1.7 |
| **`spin`** | **0.745 (0.68–0.83), 0.72 (0.675–0.79), 0.735 (0.685–0.83)** | 8.4–13.6 | **279.3 / 286.7 / 284.8** | 0.13 |
| `message`, session 2 | 0.81 (0.76–0.84), 0.815 (0.755–0.845), 0.81 (0.74–0.84) | 5.8–6.0 | 268.6 / 267.3 / 271.7 | 0.13 |

- **A 4 ms timer gave a result ~13 ms after its query ended**, three looks: WebGL makes a query's result available
  only a look or two after the GPU has it (presumably Blink's `WebGLQuery`, which lets a query's availability change
  only after a task it posts when a look found none: not checked in Chromium's source), so each look the poller skips costs a period, and the Mac's `waitAsync` turns (~1.5 ms) and even a
  ticker's 0.08 ms turns didn't land the looks where WebGL wanted them. Looking at every task saw the result ~0.75 ms
  after the end: **17× the frame rate** of HEAD in this program (16 → 280 frames/s), the wait 18× shorter; `spin` and
  `message` are the same within their rounds (`spin`'s 0.72–0.745 ms against 0.81 is ~10%, rounds not overlapping, one
  session; why isn't known).
- **The cost:** nothing while no query is pending (no poller runs). While one is, `spin` keeps the GPU worker's thread
  looking (~2 µs a look: ~290,000 looks in a second of ~660 ms pending), so glquery, which does almost nothing but wait,
  had the worker busy ~0.7 ms a query, ~65% of a core over its frames; under HEAD the same waits left the worker idle
  and the guest waiting 13 ms. The spin is capped at 2 ms after each change of the pending set (then 4 ms looks), so a
  result that takes long (a heavy frame on the GPU, a context lost) costs at most 2 ms of a core each time.
- On the dev VM's SwiftShader (Chromium 155.0.8059.84, one round, 200 frames: `results/perf16/vm-4arms.json`):
  `timeout` 11.6 ms (17.7 frames/s), `wait` 3.7 (59.8), `ticker` 2.9 (75.6), `message` 1.25 (167.5).

**Kept: `spin` is the default** (`?gpu=querypoll=timeout` for HEAD's). The KDE session the backlog pointed at wasn't run:
which of its programs use queries isn't known (graphics.md "Queries"), and glquery is the direct case of the wait.

CI: `scripts/ci.sh` and `scripts/ci-graphics.sh` pass; `scripts/ci-deqp.sh`'s sample (seed 2720526300) passed GLES2's
2,234 and GLES3's 5,744 of 5,745: `flush_finish.flush` gave a CompatibilityWarning (its calibration's draw times
jumped 2–50 ms with both lists running at once: timing, no queries in it), and passed alone with `wait` and
`flush_wait` (`deqp-run.ts`, `CASES=`).

## PERF loop 18: why glquery's first wait read the query not DONE (2026-11-10)

Loop 16 fixed the read-back of a query's state, but left a question open: why did Mesa's `get_query_result` read
the state not DONE after waiting for the fence that is held for it? **The cause isn't in the renderer. The guest gave
up on the fence:** the kernel's wait times out after 15 s of guest time, and in deterministic time that happens within
milliseconds on the host.

**Mesa's side** (virgl as of 26.x, `virgl_query.c`). `end_query` writes WAIT_HOST into the buffer through its mapping,
encodes END_QUERY and GET_QUERY_RESULT, and adds the buffer to the command buffer. `get_query_result` flushes if the
buffer is referenced, then calls `resource_wait`, which is `DRM_IOCTL_VIRTGPU_WAIT` on the buffer and so waits for
the submit's fence. Then it reads the state through the raw mapping, and only if that isn't DONE does it start the
loop of transfers from the host. The kernel's `virtio_gpu_wait_ioctl` (Linux 6.18) waits `15 * HZ`, and Mesa ignores
the error. **Our side:** the GPU worker holds that fence (`FenceGate`) until `pollQueries` has written DONE into the
guest's memory, so a wait that doesn't time out reads DONE.

**The runs.** These were glquery on alpine-virgl in the dev VM's Chromium 155 on SwiftShader (`query-wait.ts`,
`GLQ=3,4,640,480`, one round). The renderer and the GPU worker logged each submit, each state written, each fence and
each transfer from the host. In deterministic runs (virgl-boot-worker's `realtime` turned off), the first result was
also held on purpose for a set time. A transfer from the host of the query's buffer is the sign that Mesa found the
state not DONE.

| run | fence 4 (the first query's) held | transfers of a query buffer from the host |
| --- | --- | --- |
| realtime, `spin` | 33 ms | none |
| realtime, first result held 10 s | 10.0 s | none |
| realtime, first result held 16 s | 16.0 s | **1** (the first query's, after the fence) |
| deterministic, `timeout` | 40 ms | **1** (the first query's, only that one) |
| deterministic, first result held 3 s | 3.0 s | **1** (the first query's) |

In deterministic time the idle guest's clock jumps from deadline to deadline while the host holds the fence. glquery's
timed waits read 1.8-4.5 s of guest time for ~9 ms of host time, about 400 guest seconds to the host's second. The first
query's fence waits ~40 ms on shader compiles, which comes to past 15 s of guest time. Later waits are shorter and stay
under the timeout. Loop 16's harness ran deterministic until that loop moved it to realtime, which is presumably when the
spin was seen.

**Correct as it is.** Without the timeout, the fence and the state agree. With it, Mesa's fallback, which the read-back
fix made work, ends at the next look. A realtime guest falls back only when a result takes 15 s (a lost context's, say),
and then the read-back fix is what keeps it from spinning. Nothing changed, and no performance number moves: realtime
glquery never takes the fallback. Doc: docs/graphics.md "Fences". The counter question of the same loop is
bench/boot/REPORT.md "PERF loop 18".

## PERF loop 20: the query poll follows the pending set (2026-11-10)

A review found `spin` restarted its 2 ms window only when the *count* of pending queries changed; it now follows the
set (bench/boot/REPORT.md "PERF loop 20", finding 1). glquery waits on each query at once, so the count went 1, 0, 1
and loop 16's numbers stand: the old rule against the new, 3 rounds alternated on the M4 (Chrome for Testing
157.0.8103.50), waits 0.81 / 0.775 / 0.77 against 0.815 / 0.77 / 0.79 ms, 265.4 / 274.9 / 272.6 against 260.0 /
271.9 / 268.5 frames/s (`results/perf20/mac-spin-set.json`: `spincount` the old rule, a temporary arm).

## PERF loop 79: a draw's GL calls, counted, and what only the renderer sets kept (2026-11-26)

PERF-HANDOVER.md's row 16: virgl sets the whole GL state at every draw (docs/graphics.md "The renderer": nothing is
assumed bound, since every guest context draws on one WebGL2 context). The M4 Mac mini (macOS 26.6.2, Metal 4) with
Chrome for Testing 158.0.8127.88, headless; ANGLE's Metal renderer. Results in `results/perf79/` (the sessions'
results.json; `counts.py` and `ab.py` read them; `diag.patch` is the counting build).

**The counts** (`diag.patch` on this loop's commit, `?gpu=virgl,glcount`: the GPU worker's WebGL2 context wrapped so
every call is counted, each state call judged against a shadow of the state it sets; a draw's phases timed). Over
Firefox's scroll and its five pages (12,209 draws, `ff-count/`): **79 calls before each draw call, 63 of them (80%)
setting what was already set** (the survey's 60-100 holds). By kind, calls / repeats a draw: the framebuffer 15.0 /
13.8 (`framebufferRenderbuffer(…, null)` 11.1 / 10.6: the ten points with nothing to attach emptied again; the color
attachment 1.5 / 0.9; `drawBuffers` 1.1 / 1.1), the vertex attributes 29 / 23 (11.6 of them disabling unused slots),
the capabilities 10 / 9.3, a view's levels 5.2 / 5.2, the texture units 5.2 / 0.6, samplers 2.6 / 2.1, uniforms 3.2 /
3.1, the rest (viewport, depth range, front face, masks, blend, depth) ~9 / 6. GTK 4's demos (`gtk-count/`, counted with the framebuffer's cache
below already in): 42-62 calls a draw past the framebuffer's, 66-97% repeats. Without the counter (`ff-clean/`), a
Firefox draw costs the GPU worker 76-115 µs, most of it its uploads (30-180 MB/s); its state setting 5.6-8.5 µs.

**What a repeated call costs** (`bench/gpu/state-cost.ts`, no emulator: small textured quads into a framebuffer of
their own, each preceded by the renderer's calls for a draw, or only those that change something, or all but one
group's repeats; `state-cost-512.json`, µs a draw to the calls' return / to the GPU's end): all 17.3 / 39.6, only the
changes 0.25 / 1.43, **all but the framebuffer's 1.60 / 2.15**. The framebuffer's cost is the seven empty color points
emptied again: those alone add 0.4 µs to the calls but **38 µs to the end**, the same at a 64², 512² and 2048² target
(`state-cost-64.json`, `-2048.json`): ANGLE takes it as a changed framebuffer, a fixed cost in the GPU process (the
caller's 17 µs is the command buffer filling). Re-attaching the texture already attached costs 0.3 µs, `drawBuffers`
0.5. The other groups' repeats, to the calls' return: the vertex attributes 0.68, the capabilities, viewport, blend and
masks 0.45, the program's uniforms 0.20, a view's unit, levels and sampler 0.07.

**Built** (both kept; `?gpu=noattachcache`, `?gpu=nodrawcache` set everything again, as before):
1. The attachments of the renderer's two framebuffers and `fbo`'s draw buffers, kept and set only where they differ
   (`attached`; bindings through `bindFb`, the depth-stencil point both the depth and the stencil ones).
2. Each sub-context's vertex array (`Sub.vaoState`: enabled bits, each attribute's buffer, pointer and divisor) and each
   program's uniforms (`Program.set`), likewise. Nothing else changes either, so nothing invalidates them.

Memory: two maps of eleven points, sixteen-entry arrays a sub-context, a program's constants as doubles (well under
1 MiB for a desktop session's programs).

**The A/B on the Mac** (booted sessions: `pages.waarm64snap` restores with 3D off on the Mac's real renderer, its caps
being SwiftShader's; each pass alternated which arm went first). gtk4-demo (`bench/gpu/gtk4-load.ts`, WARM_S 10,
PHASE_S 8; the GPU process's CPU from `bench/procstat.ts`'s new `gpu` set), first the framebuffer's cache against none
(`gtk-a-*`), then the arrays' and uniforms' added against the framebuffer's alone (`gtk-b-*`), two rounds each:

| | none | framebuffer's | + arrays', uniforms' |
|---|---|---|---|
| iconscroll: the GPU process, ms a second | 477 / 507 | 222 / 207 | 232 / 229 (b: attach 235 / 232) |
| iconscroll: the GPU worker, µs a draw | 22.1 / 18.4 | 12.4 / 7.7 | 6.8 / 7.1 (b: 7.6 / 7.3) |
| iconscroll: draws a second | 13,982 / 14,795 | 16,611 / 15,291 | 18,062 / 17,488 (b: 17,470 / 17,635) |
| gears: the GPU worker, µs a draw | 3.4 / 3.4 | 3.0 / 3.0 | 2.6 / 2.6 (b: 3.0 / 3.1) |
| mask: the GPU process, ms a second | 155 / 147 | 140 / 133 | 134 / 130 (b: 138 / 135) |
| frames: the GPU worker, µs a draw | 65.3 / 62.4 | 61.7 / 60.2 | 60.2 / 59.4 (b: 61.5 / 63.5) |

fishbowl (it adds fish while it keeps up) drew 2,098 / 475 draws a second with none and 7,639 / 1,316 with the
framebuffer's cache, but its rounds vary 4× (shader compiles inside the phase): a hint, not a measure. Firefox's
scroll and pages (`bench/gpu/firefox-load.ts`, PHASES=scroll,pages, PHASE_S 5; both caches against none, three rounds,
`ff-base-*`, `ff-both-*`): the GPU process 86.5 / 96.6 / 86.5 → 81.5 / 90.2 / 80.5 ms a second on wiki, 89.3 / 96.1 /
94.0 → 83.8 / 87.6 / 88.2 on github, 98.0 / 90.7 / 91.4 → 83.9 / 84.5 / 89.6 on bbc (5-8%; mdn's, hn's and the
scroll's overlap); the worker's time a draw, the frame rates (60) and the pages' starts unchanged within the rounds'
spread (its draws are few, 130-500 a second, and their uploads are what they cost).

**Not built: a shadow of the rest** (the capabilities, viewport, blend, masks, depth and stencil, texture units, a
view's levels, samplers, uniform buffers). Its repeats are ~0.5 µs a draw of the worker's calls (above) and ~0.1 µs of
the GPU process's: 15-20% of gears' 2.6 µs a draw, ~7% of iconscroll's, under 1% of a Firefox draw's; in none of them
is the worker the bound (gears and iconscroll run at the compositor's rate or the guest's, the worker 4-13% busy). Unlike
what was built, that state is global: the blits, clears, copies, uploads, read-backs, snapshots, the video paths and
the screen (`web/virgl-screen.ts`) set it too (~110 call sites), and each would have to invalidate the shadow. Left
as a finding.

Tests (tests/virgl.test.ts): sway's, glcomp's and three dEQP traces replayed with the caches and without, the
framebuffers every draw, clear, blit and read sees (GLES 3.0's model of their state) and every draw's vertex array and
uniforms the same, with far fewer calls; and two command streams of their own (targets of other levels, layers and
depth points with a blit and a snapshot between; draws of other buffers, strides, offsets, divisors and contexts).
Planted and caught: the depth-stencil point as one, the level or the layer left out of an attachment's comparison,
the draw buffers kept on other framebuffers, an attribute's buffer, stride, offset or divisor left out of the
comparison, its enabled bit taken as set, one array's state for every sub-context, the constants compared by their
first vector, a scalar uniform kept by name alone.

## PERF loop 81: the review of loop 79's caches fixed (2026-11-26)

The out-of-context review of loop 79's renderer caches (`review/virgl-caches`, six findings at d8792cbf) checked
against main: all six real. Each got a test in `tests/virgl.test.ts` that failed on 650d988d first, then its fix. The
M4 Mac mini, Chrome for Testing 158.0.8127.88, ANGLE on Metal; results in `results/perf81/` (`ab.sh` the A/B;
`../perf79/ab.py 'bench/gpu/results/perf81/gtk-*'` reads it).

1. **A draw or clear with a depth or stencil target detached it and attached it again** (the cache compared each
   call with the last one: the three depth and stencil points emptied, then the target's attached). Now the target is
   attached at its own point and only the point it leaves empty is emptied. Counted on the recording WebGL2: dEQP-GLES2's
   stencil-stride trace (481 draws into one target) made 978 attachment calls, now 11. **What it cost**
   (`bench/gpu/state-cost.ts ZS=1`, a DEPTH24_STENCIL8 texture on the target, `state-cost-zs.json`, µs a draw to the
   calls' return / to the GPU's end): the changes alone 0.25 / 1.43, with the texture detached and attached again
   0.48 / 39.40, attached again alone 0.50 / 2.13: the churn is a changed framebuffer to ANGLE, the same ~38 µs of the
   GPU process as an empty point emptied again. **The A/B** (gtk4-demo, WARM_S 10, PHASE_S 8, three rounds, the arm
   first alternating; `gtk-base-*`: 650d988d's renderer, `gtk-new-*`: this loop's): gears (17,160 draws a second into a
   GtkGLArea with a depth buffer) took the GPU process 351.2 / 319.5 / 317.6 ms a second, now 88.8 / 87.7 / 89.8
   (**−72%**, 1,270 / 1,160 / 1,155 → 272 / 261 / 276 M cycles a second; ~13 µs a draw), the GPU worker 2.0-2.2 µs a draw
   either way; iconscroll (no depth) unchanged (the GPU process 218 / 231 → 222-228 ms a second past the session's first
   round, the worker 7.0-8.2 against 7.3-8.0 µs a draw).
2. **The screen bound the default framebuffer past the renderer** (`web/virgl-screen.ts`), so between calls the
   renderer's `boundFb` wasn't GL's binding (latent: every attachment site binds first). The screen now binds through
   `VirglRenderer.bindDefaultFramebuffer`; the framebuffers' model in the tests also fails any attachment made with the
   default framebuffer bound.
3. **The uniforms kept took −0 for +0** (a blend color's sign, which the shader's folded blend reads). They are now kept
   as 32-bit words and compared by bits (the constants were words already: half the memory of the doubles), the scalars
   with `Object.is`.
4. **The caches allocated at every draw** (an array a call to `attachTo`, a string a `setDrawBuffers`, two arrays an
   attribute changed, the draw buffers' array): constant arrays, a kept `Int32Array` of the draw buffers, the points
   updated in place, the attributes' pointers in one `Float64Array` a sub-context. Nothing measured: hygiene (docs/host-code.md).
5. **`fbCache` was dead** (never read, seven clears) and a comment named it as the attachments' cache: removed.
6. **A forget of the draw states kept every program under the old state ids** (a guest making states without end added a
   copy of every program in use at each forget, until its shaders died): `forgetStates` deletes them, a shader object's
   or one destroyed while bound. Two rounds of 4,200 states peaked at 8,400 live programs, now 4,200.

Memory: none added; less by reading (the constants' half, the programs a forget frees). Planted and caught: the
depth-stencil point emptied before it's attached, the other point left on, the stencil half of the depth-stencil point
not compared, the screen binding past the renderer, a blend color's sign lost, the draw buffers' count not compared, an
attribute's offset not compared, a forget's programs kept (the bound shader's and every object's).
Its commit passed `scripts/ci.sh`, `ci-graphics.sh` and `ci-deqp.sh`.

## PERF loop 87: a key's glyph on each screen, today (2026-11-28)

[#57](https://github.com/gbl08ma/waarm64/issues/57) (G1 exit, above: the virtio-gpu screen ~13 ms later than the
simple framebuffer, the nested device worker's draws outside animation frames the suspect) measured again on today's
tree (de23ab7f), on the dev VM and on the Mac's GPU. **Which thread draws what today:** a 3D machine's screen (the
default wherever the browser has WebGL2, the console's scanouts too) is the page's top-level GPU worker's
(`web/virgl-screen.ts`, once per animation frame); a 2D machine's (`?gpu=2d`, or the Machine menu's 2D) is still the
device worker's, nested in the machine worker with no `requestAnimationFrame` (`web/gpu-present.ts`
`canvasPresenter`: a damage a frame after the last draw is drawn at once, else on a timer; WebGL2 on a GPU, a 2D
context on software GL); the simple framebuffer's is the machine worker's (`web/display.ts`, its animation frames).

`node bench/gpu/page.ts` (the G1 instrument: a key's `keydown` to the first page animation frame that sees the
canvas changed, so a frame's resolution; Debian's bash on tty1, 4 vCPUs, the Both view), now with the arms `gpu3d`
(`?gpu=virgl`), `gpu2d` (`?gpu=2d`), `gpu2dc` (`?gpu=2d,canvas2d`, the Mac only) and `simple` (`?gpu=2d&display=simple`),
two rounds alternating, 40 keys an arm a round; on the Mac through `SCRIPT=page.ts bench/gpu/sway-mac.sh -
target/images/debian/disk.qcow2 <name>`. Key to glyph on the screen, ms, median (quartiles), n:

| | gpu3d (GPU worker) | gpu2d (device worker) | gpu2dc (device worker, 2D context) | simple (machine worker) |
|---|---|---|---|---|
| dev VM, Chromium 155.0.8059.84, SwiftShader (`results/perf87/vm-page.json`) | 28.6 (23.3–35.1), 80 | 26.2 (20.9–32.6), 80 (a 2D context: software GL) | | 36.8 (31.7–40.8), 74 |
| Mac (M4, ANGLE on Metal), Chrome for Testing 158.0.8127.88, macOS 26.6.2 (`results/perf87/mac-page.json`) | 27.7 (19.0–33.2), 80 | 27.3 (19.9–41.0), 80 (WebGL2) | 29.4 (21.0–41.4), 80 | 34.8 (32.4–39.5), 76 |

Per round (medians): VM gpu3d 29.2 / 28.0, gpu2d 24.1 / 27.2, simple 36.8 / 36.8; Mac gpu3d 25.5 / 28.8,
gpu2d 26.8 / 28.2, gpu2dc 30.0 / 29.3, simple 36.3 / 34.5. The serial terminal: 7.2-7.3 ms on the VM, 3.9-4.1 on the
Mac, every arm. A first Mac session (the same tree, three arms, its JSON lost to the harness's `git` call in the
Mac's copy, now caught) gave the same picture: gpu3d 26.7 / 24.2, gpu2d 25.3 / 28.7, simple 34.6 / 35.8.

- **The gap is gone, and the other way round**: both virtio-gpu screens show a key ~7-10 ms *earlier* than the simple
  framebuffer, on both hosts, every round (the rounds don't overlap). The simple framebuffer waits for the machine
  worker's next animation frame and its scan; the 2D presenter draws a key's lone damage at once in the flush's task.
  So drawing outside animation frames costs a 2D machine nothing at the median. What made October's 52.8 against
  39.2 ms isn't identified (the presenter's draw-at-once rule was already there; Chromium was 153 then): not
  re-measurable on that tree's browser, and nothing of it is left to fix.
- **The 2D screen's upper quartile on the Mac is ~8 ms above the 3D screen's** (41.0 / 41.4 against 33.2), the
  medians equal: under a frame of the instrument, WebGL2 and the 2D context alike, so it is the worker's commit
  outside a frame being shown a frame later some of the time, not the context. A 2D machine on a GPU is the user's
  choice (3D is the default there), so a device worker with animation frames (made by the page, a redesign of the
  machine worker's start and every device's plumbing) isn't justified by a quarter of keys a frame later on a
  non-default path. Not built; #57 closed.

## PERF loop 91: the host's per-event costs: virgl's joins, an import's reads, frame batches, the checksum, the poll (2026-11-28)

PERF-HANDOVER.md's row 24: five per-event costs from a static survey, each counted under the workload that drives it,
then built where the count left a gain, judged by its own micro-benchmark. The dev VM (Lima vz, 8 vCPUs, arm64),
Chromium 155.0.8059.84 headless, Node 26.7.0. Results in `results/perf91/`.

**1. virgl's joins** (`web/virgl-renderer.ts` `readBacking`: a transfer's range across backing entries copied into a
fresh buffer). **Counted** with the renderer's new `backingReads`, `joins` and `joinBytes` stats (kept: `render-stats`,
guest-session.ts's `renderer`), on Firefox's scroll and five pages from `target/snapbench/pages.waarm64snap`
(`ff-count.json`): 15-171 joins a second carrying 9-115 MB/s, **76-100% of the bytes uploaded** (a staging buffer's
pages are scattered: one join of ~900 KB a frame on the scroll), against the GPU worker's 11-53 ms busy a second.
**Bound** (`bench/gpu/join.ts`, `join.json`: the same loop over a backing of 4 KiB pages and of 64 KiB runs, 15 rounds
alternating, 911,000 bytes): in Chromium a fresh buffer's join 103 µs (IQR 100.5-104.8) and 107 (104.5-109), into a
kept one 32.3 (31.8-32.3) and 13.8 (13.5-14.3); Node alike (132 / 117 against 45 / 27, the fresh arm's IQR wide: GC).
So the fresh buffer (its allocation, zeroing and collection) is ~70-90 µs of a join's ~105: 1-15 ms of the worker's
second on these pages. **Built:** the join's buffer is kept for the next one (`joined`, grown to the largest join, at
most `JOIN_KEPT` 16 MiB; bigger joins stay fresh); the video path's reads (`DECODE_BITSTREAM` holds its desc and data at
once) take fresh ones (`keep`). The consumers copy at once (`texSubImage*`, `bufferSubData` from the shadow, the CPU
copies), as they must for the in-place views of guest RAM. Memory: one buffer the size of the largest join, ~1 MB on
Firefox's pages (a full 1920×1080 frame 7.9 MiB). Tests: tests/virgl.test.ts "transfers across a backing's entries
upload their own bytes, the joined buffer kept between them" (joins growing past twice the kept size, a smaller one in
it, a read inside one entry), tests/virgl-video.test.ts "a picture's desc and data whose backings span entries are both
read whole". Planted and caught: the video path's reads into the kept buffer (the desc overwritten by the data: no
longer a key frame), the kept buffer grown to twice its size without the join's own length.

**2. An import's reads** (`web/stored.ts` `importImage`). The survey's "serial 1 MiB reads from a server" isn't
what exists: an import reads a `File` (the page's file picker, or a fetched image made one), through
`FileReaderSync` in the disk worker; there is no import from a server, so no latency to hide. What is serial is each
chunk's read (and its compressed clusters' inflation in the pool) before its write. **Counted** (a timing build, two
imports of Debian's qcow2, 400 MB, 3 GiB virtual, 3,072 chunks, `import.json` `diag_ahead1`): 3.0-3.2 s, of which
the reads 2.37-2.49 s (their synchronous part 1.0 s, waiting for the pool 1.4 s) and the zero scan and writes 0.60-0.67
s. **Bound:** the pool's wait overlapped with the writes, ≤ ~0.6 s. **Built:** `IMPORT_AHEAD` chunks in flight
(`import.json`: each arm a page session of three imports into OPFS, two passes in opposite orders): 1 (before)
3,158 ms (IQR 3,105-3,191), **2: 2,755 (2,720-2,776), −12.8%**, 4: 2,783 (2,728-2,797), 8: 2,722 (2,714-2,722); the
rounds of 1 don't overlap the others', and past 2 nothing more (the worker's own reads and writes are the bound). Kept
at 2: one more MiB chunk (and its compressed bytes) in flight. A read ahead's failure is caught when it's made, so a
failed import leaves no unhandled rejection. Test: tests/stored.test.ts "an import reads the next chunk before it
writes this one, in order; a chunk that fails to read stops it with its offset". Planted and caught: one chunk at a
time (`IMPORT_AHEAD` 1), the chunks taken out of order, the read ahead's catch removed (the fifth chunk's throw
unhandled).

**3. Frame ports taking batches** (P7 of the old backlog's "The network, per packet"): **already built** on
2026-11-24 (4abdff36: a helper's or the demo network's message reaches the card as one post, its TCP segments merged
as an IP port's), the day after the survey that queued it. What it's worth is [#271](https://github.com/gbl08ma/waarm64/issues/271)
(`bench/net/local.ts`'s download, base against new; a UDP burst), left open: a measure of a kept change, nothing to
build.

**4. The checksum** (`web/offload.ts` `sum`, two bytes a step). **Counted** by what drives it: every byte through the
offloads is summed once (a sent segment's or frame's TCP/UDP checksum, a received frame's check for `DATA_VALID`), so
the device worker sums at the network's rate: 432 Mbit/s down and 291 up in `ci-net.sh`'s run, 1.0-1.35 Gbit/s at the
helper's 65,520 MTU (bench/net/REPORT.md). **Bound** (`bench/net/csum.ts`, `csum.json`: 64 MiB a measure, frames of
1,514 and 65,226 bytes at even and odd offsets, 11 rounds alternating): two bytes a step 0.369-0.383 ns a byte in
Chromium (0.410-0.418 in Node), ~47 ms of the worker's second at 1 Gbit/s. **Built:** `csumSum`, four bytes a load
through a word view of the buffer (little-endian words' sum byte-swapped back; folded every 8,192 words so it stays a
small integer): **0.097-0.119 ns a byte in Chromium** (IQRs within ±0.002), 0.096-0.117 in Node, 3.2-3.9× less, ~35 ms of
the worker's second saved at 1 Gbit/s. One small view a call (a frame already allocates its own buffer); nothing
kept. Test: tests/offload.test.ts "csumSum: the sum of every range at every alignment of its view is the two-bytes-a-step
one's" (four view offsets, eight starts, lengths 0-65,539, runs of 0xffff past a fold). Planted and caught: the sum not
swapped back, the leading bytes' halves taken all high, the trailing bytes' all low.

**5. `Devices.poll`'s closures** (`web/devices.ts`: `word` a poll, `segs` and `Array.from`'s mapping a request).
**Counted** by what drives it: a request per buffer the guest posts or sends, ~30 K a second on a gigabit download
into mergeable ~4 KB buffers, ~1-6 K a second of blk. **Bound** (`bench/io/poll.ts`, `poll.json`: the real `poll` over a
ring of requests a backend takes for later, 7 rounds a run, three runs a tree alternated): with the closures 220-241 ns
a request of one segment and 314-339 of three; **built** as plain loops into the segment arrays: **19.1-19.9 and
34.2-35.6 ns**; every round apart. At 30 K requests a second that is ~6-9 ms of the worker's second. Nothing kept.
Test: tests/devices.test.ts "each request reaches its backend with its queue and segments, its words wrapping the
ring". Planted and caught: the write segments counted by the read count, a segment's first word read without the
ring's wrap.

No workload A/B beyond CI: each change is a micro-op judged by its micro-benchmark. CI at this loop's commit, on the dev
VM: scripts/ci.sh (757 s), ci-net.sh (424 s), ci-graphics.sh (323 s), ci-machines.sh (251 s), ci-debian.sh (317 s),
ci-usb.sh (10 s) and ci-deqp.sh (639 s), all passed.

## PERF loop 93: the review of loop 91's host paths fixed (2026-11-28)

The out-of-context review of loop 91's four changes (`review/host-events`, four low findings at 5e1e1700, "no high- or
medium-severity defect") checked against main (351fc173): all four hold as described. Each code fix got a test that
failed on 351fc173 first, then passed.

1. **`IMPORT_AHEAD`'s comment said two chunks read ahead; the code keeps one** (`web/stored.ts`: the count is the
   chunks in flight, the one written next among them). Comment only, reworded to say so (and docs/machines.md); loop
   91's test already catches `IMPORT_AHEAD` 1 (no read ahead).
2. **`readBacking(…, keep)` gave a view of guest RAM for a range inside one entry**, though its comment read as if
   the caller owned the bytes. Its one caller, the video path's `read`, copied both reads at once, so nothing was
   wrong yet; a decoder holding them past the command would have read RAM the guest reuses. Now `own`: a copy either
   way (a join into a fresh buffer), `VideoEnv.read` documented as the reader's own bytes, and `DECODE_BITSTREAM`'s
   two `slice()`s gone (a join is copied once, not twice). Test: tests/virgl-video.test.ts "the video path reads a
   backing into bytes of its own, inside one entry too" (guest RAM written after the read; failed first: the bytes
   changed). The tests' fake envs slice too, as the contract now says.
3. **An empty read at the backing's end returned null**, so a zero-width transfer there failed silently (at an
   interior boundary it read as empty). Pre-existing. Now `len <= 0` reads as no bytes before the walk. Test:
   tests/virgl.test.ts "an empty transfer at the end of a backing is a no-op that succeeds" (failed first: false).
4. **A concurrent request's completion that threw (a full completion ring) was an unhandled rejection** and left
   `failed` unset (`.then(ok, err)`'s `err` doesn't see `ok`'s throw). Not reachable at today's queue sizes (the
   review's count: 512 words in flight across a reset against 4,096), so a latent fix: `.then(complete).catch(failed
   ??= e)`, the next poll throws it. Test: tests/devices.test.ts "a concurrent request whose completion throws (its
   ring full) fails the next poll, not unhandled" (failed first: the unhandled `completion ring full`). docs/devices.md
   says so.

Planted and caught beyond the failing-first runs: the video path's join into the kept buffer (loop 91's two-reads
test), the empty guard written `len < 0` (the new transfer test). **Performance where loop 91 put it:** the poll's parse
is untouched (`bench/io/poll.ts` on the dev VM, Node 26.7, 11 rounds, base/new/base: 19.6/19.6/19.6 ns a one-segment
request, 35.1/35.2/35.5 a three-segment one, IQRs within ±0.4; `results/perf93/poll.json`); the transfers' joins keep
their path (one compare added before it; `bench/gpu/join.ts` measures a copy of the loop, not the renderer, so it
wasn't re-run); the checksum wasn't touched.

CI at this loop's commit, on the dev VM: scripts/ci.sh (770 s), ci-graphics.sh (326 s), ci-machines.sh (256 s),
ci-debian.sh (322 s) and ci-usb.sh (9 s), all passed.
