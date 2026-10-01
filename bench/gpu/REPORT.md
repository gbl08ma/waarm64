# bench/gpu: G0, the WebGPU environment and the ways to present a 2D frame

**2026-10-01.** The measurements behind G0 of [docs/plans/graphics.md](../../docs/plans/graphics.md) and
M8-GRAPHICS-KICKOFF.md loop 1. The suite is `bench/gpu/suite.ts` (a worker, like the other suites);
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
