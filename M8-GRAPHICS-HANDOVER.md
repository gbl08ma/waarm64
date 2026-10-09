# M8 graphics, 3D: handover for G3 (2026-10-09)

For the session that builds G3, the virgl renderer on WebGL2. **The brief is `M8-GRAPHICS-KICKOFF.md`** (the user's
decisions and the loops). This file is what you need to start: where things are, how to run them, and what G2
learned. Read first: [docs/plans/graphics.md](docs/plans/graphics.md) §1 (direction), §8 (open questions), §19 (G2's
measurements); docs/devices.md "virtio-gpu" and "virgl"; docs/frontend.md "The screen".

## What exists (G2)

- **`web/virgl.ts`**: the protocol's names (`CCMD`, `OBJECT`), `walk` (a command buffer: header dword = command in
  bits 0–7, object type 8–15, payload length in dwords 16–31), `VirglStats`, the caps blob's layout
  (`CAPS_FIELDS`, `decodeCaps`, `encodeCaps`: `struct virgl_caps_v2`, 352 dwords; capset 1 is its first 77) and
  `virglCaps(capset)`, the fixed caps advertised today (virglrenderer's on a GLES 3.0 host minus what WebGL2 lacks;
  the kickoff's decision 1 replaces them with caps from the browser).
- **`web/gpu.ts`** (`GpuOptions.virgl`): `control3d` handles `GET_CAPSET_INFO`/`GET_CAPSET`, `CTX_*`,
  `RESOURCE_CREATE_3D` (a `Resource` with `three`: target, bind, depth, array size, levels, samples; no host
  memory), `TRANSFER_*_3D` (checked, counted, nothing copied), `SUBMIT_3D` (walked, counted, `onSubmit` hook).
  Fences signal at once (the reply echoes the fence). A 3D scanout gets black pixels. `save()` marks a machine with
  a context or a 3D resource `unsaveable`, and `vm.snapshot` (web/vm.ts) refuses it with that reason. `busy` counts
  `flushes`, `submits`, `submitBytes` for `?displaystats`. The device's feature bits and `num_capsets` are in
  `deviceEntry` (web/devices.ts).
- **The page:** `?gpu=virgl-null` (web/app/worker.ts `gpuTuning`) turns it on. The screen's canvas goes
  `transferControlToOffscreen` (web/app/main.ts) → the machine worker (web/app/worker.ts, the gpu spec's `canvas`)
  → the device worker (web/vm.ts starts it, nested in the machine worker) → `canvasPresenter` (web/gpu-present.ts,
  canvas 2D). The device worker has no `requestAnimationFrame` (graphics.md §12), which is why the kickoff puts the
  renderer in a top-level GPU worker started by the page.
- **Tests:** `tests/gpu.test.ts`, the "virgl:" tests (capsets, contexts, resources, transfers, submits, a 20,000-command
  fuzz run). No guest in the suites runs virgl, and the Rust twin (`core/tests/common/gpu.rs`) is 2D only (backlog).
- **Benchmarks:** `gl_virgl_jit`, `gl_virgl_jit_4` (glcomp through virgl), `gl_virgl_llvmpipe_jit[_4]` (llvmpipe, same
  Mesa build) in `bench/boot/suite.ts`; results in `bench/boot/results/m8-g2/`. They need
  `images/build.sh alpine-gl alpine-virgl` (~10 min; Alpine's own Mesa has no virgl, so `alpine-virgl` builds Mesa
  26.1.6 into `/opt/mesa`; the cmdline's `webpc.gpu=1` makes the image's start script load `virtio-gpu`).
  On the null renderer glcomp's check is `00000000` (the bench holds it only to itself); with a real renderer it
  should become llvmpipe's (`GL_CHECK` in suite.ts: `285f8eb1` for 10 frames, `a26ac0b1` for 30).

## Tools

- **The virgl oracle** (`tools/virgl-oracle/`): `build.sh` clones virglrenderer `c8e3fc3b` into
  `target/virgl-oracle/`, applies `capture.patch` (writes every submit, resource creation, transfer and capset to
  `VTEST_DUMP`) and builds it in debug mode (`VREND_DEBUG=shader` prints the TGSI received and the GLSL made).
  `capture.sh <out> <name> <client…>` runs a client on `GALLIUM_DRIVER=virpipe` against it on a GLES 3.0 host and
  keeps `<name>.dump`, `.server.log` (TGSI → GLSL pairs), `.client.log`. `dump.ts` summarizes a dump (`--res`,
  `--caps <prefix>`). Example: glcomp (`clang -O2 images/alpine/gl/glcomp.c -lEGL -lGLESv2`) gives 6 submits,
  28,088 bytes, 4 shaders for 3 frames; glmark2-es2 runs as `xvfb-run -a glmark2-es2 --off-screen -s 1376x762 -b
  <scene>:duration=1` (G2 captured 16 scenes: 188 shaders, 61 MB). Dev VM only (CLAUDE.md lists the packages).
- **A compositor's load on the page** (`bench/gpu/sway-load.ts <virgl|pixman|llvmpipe> <image.qcow2>`): sway and
  foot in a UEFI image, measured over the serial terminal (§19's table). `VIRGL_GPU=virgl` picks G3's switch instead
  of `virgl-null`. The image G2 used is the user's Arch (`bench/results/local/myarch2.qcow2` on the dev VM, git-ignored:
  Arch Linux ARM from `images/archarm/build.sh` plus sway and foot, login alarm/alarm on the screen, root/root on the
  serial console; its Mesa 26.2 has virgl). With the null renderer the screen is black.
- **Native client CPU:** `perf record` on a client under `capture.sh`'s setup (paranoid 2: user space only).

## What the guests do (G2's findings, for the renderer)

- **Texture data travels through staging buffers:** Mesa writes uploads into a guest-backed `VIRGL_BIND_STAGING`
  buffer and puts `COPY_TRANSFER3D` in the stream; read-backs are the reverse (`COPY_TRANSFER_BOTH_DIRECTIONS` is in
  the caps). glcomp and sway sent **no `TRANSFER_*_3D` at all**. So the renderer reads the staging buffer's guest
  pages for an upload, and writes them for a read-back before the fence signals, while it decodes the stream. Over
  vtest the same data travels as `TRANSFER3D`/`END_TRANSFERS` in the stream instead (vtest's path, not virtio's).
- **glcomp's stream** (3 frames): 28 command kinds, mostly `SET_CONSTANT_BUFFER`, `SET_VERTEX_BUFFERS`, `DRAW_VBO`,
  `CLEAR`, the object creations and binds, `SET_SUB_CTX`. glmark2's 16 scenes use 44 kinds. **sway** at 60 frames a
  second: 2 submits a frame, ~500 KB of stream a second; its buffers are 3D resources flipped with `SET_SCANOUT` +
  `RESOURCE_FLUSH`; dumb buffers (fbcon, the cursor, pixman) stay 2D.
- **The GLSL virglrenderer makes needs extensions WebGL2 may lack:** `GL_EXT_clip_cull_distance` in every vertex
  shader, `GL_EXT_blend_func_extended` in 110 of 188 fragment shaders, `GL_NV_shader_noperspective_interpolation` in
  8, because its host advertised them. Our translator emits them only when the adapter has them (and the caps then
  say so).
- **Where the guest's time goes** (§19): Mesa's user-space time a sway frame equals pixman's; the remaining cost is the
  guest kernel's submit path (~2.2 ms of sys a frame over pixman's). glcomp's warm-up (two shaders compiled
  GLSL → NIR → TGSI) is ~10 ms.
- Linux (6.18 and 7.2) reads both capsets at probe and caches them, so the caps a guest saw at boot are what its Mesa
  uses for the whole session: why a snapshot must record them (the kickoff's decision 3).

## The renderer's design notes (graphics.md §8)

- **One WebGL2 context for every guest context**: WebGL contexts share no objects; virglrenderer uses a share group.
  Keep each guest context's state and rebind on a switch.
- **Fences:** Chromium's `clientWaitSync` takes only a zero timeout. One context runs everything in order, so a fence
  can signal once its submit is issued. Read-backs: `readPixels`/`getBufferSubData` synchronously, or a pixel-pack
  buffer polled with `fenceSync` if that stalls.
- **WebGL2 below GLES 3.0:** no texture swizzle (do it in the shader), no `glMapBufferRange` (shadow copies and
  `bufferSubData`), no BGRA formats (swizzle on upload or in the shader), fixed-index primitive restart only; base
  vertex, clip distances, depth clamp and polygon mode are extensions on some adapters only.
- **Language:** TypeScript (calls WebGL directly, like the other backends). A Rust crate would cross wasm → JS on every
  GL call.
- **Licensing:** virglrenderer is MIT (THIRD_PARTY.md has its row: the protocol, `vrend_decode.c`, `vrend_shader.c`):
  porting with attribution and kept headers is allowed. Mesa (MIT) is a reference for the guest side.

## Learned (don't re-discover)

- `Gpu.save()` is also the tests' state read (`vm.deviceState`): don't throw there; mark and let `vm.snapshot` refuse.
- `sway-load.ts` sets the page's screen size through the `webpc.settings` local-storage key (`screen: '1376x762'`).
  Text typed into a guest shell from a TS template literal: an awk `\n` must be written `\\n`.
- QEMU's `virtio-gpu-gl` can't run in the dev VM (no DRM render node): vtest and our own device are the oracles.
- The rules that bite here: cap memory on every `node`/`cargo` run; Playwright headless only (WebGL2 there is
  SwiftShader; the Mac host's Chromium gives a real GPU, `bench/gpu/run-mac.sh` is G0's way there); a guest-visible
  device feature stays an option, off by default, until the kickoff's condition for the default is met.

## G3 progress (2026-10-09, end of session)

Done and committed (74804b6, CI green): loops 0–2 (graphics.md §20). Work in progress (committed after this note,
**scripts/ci.sh not run on it**): loop 3's wiring. The device's `renderer` port (devices.ts, `pagePresenter`), the
page's `?gpu=virgl` (main.ts starts web/gpu-worker.ts with the canvas, waits for its caps, falls back to 2D without
WebGL2), snapshots per decision 3 (contexts that never submitted are saved and remade; the guest's caps saved; a
restore whose caps this browser can't back turns 3D off). Tests pass: `tests/virgl.test.ts`, `tests/gpu.test.ts`,
`tests/virgl-browser.test.ts` (including glcomp in a guest with the renderer in the GPU worker, its read-back
within 7 of llvmpipe).
Next: the exit: docs (frontend.md "The screen" for the WebGL2 path), G4's outline, and whether 3D can be the
default (the kickoff's condition: the page's Debian and snapshot tests pass with it on, which they now do).
The kernel profile (graphics.md §20 loop 4) couldn't isolate sway's submit path (the sampler credits a chunk's time to
its first PC, and the date loop's fork and exec dominates): a finer instrument is G4's.
Loop 4's numbers are in graphics.md §20 (sway at 60 frames a second on the Mac's GPU, as the null renderer; 55 on
SwiftShader, after the screen began drawing once per animation frame: it was 39).
Done since: `scripts/ci.sh` and `ci-debian.sh` pass on 12f6158. `VIRGL_GPU=virgl node bench/gpu/sway-load.ts
virgl …myarch2.qcow2` runs all its phases on the page (the earlier "stopped" was a wait that gave up early): sway and
foot draw through the renderer onto the WebGL2 screen; one rough run on SwiftShader, the date loop at ~35 flushes a
second (G2's null renderer: 60), sway 328 ms CPU a second. `WEBPC_PAGE_QUERY=gpu=virgl scripts/ci-debian.sh`: the
page's Debian tests on a 3D machine pass, after a fix (a restore didn't tell the GPU worker the scanout: the restored
screen stayed black). Stream output is in the renderer (graphics.md §20), tested on Chromium from a stream made in
the test; no guest in the images uses it (glcomp and sway don't).
