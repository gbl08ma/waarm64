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
the Mac run was made from a copy (`~/webpc-gpu-bench`: `bench/`, `tools/serve.ts`, a copy of
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
skipped with G2's caps). Details in docs/plans/graphics.md §20.

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
which run on SwiftShader, keep testing that screen; `?gpu=gl2d` forces WebGL2 (`WEBPC_PAGE_QUERY=gpu=2d,gl2d` runs the
page tests on it), `?gpu=canvas2d` canvas 2D.
