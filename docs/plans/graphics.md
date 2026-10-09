# webpc graphics plan

**Status:** drafted 2026-09-27 as an exploration. **G0 and G1 (virtio-gpu 2D) are done (2026-10-02)**:
what exists is in the topic docs ([devices.md](../devices.md) "virtio-gpu", [frontend.md](../frontend.md)
"The screen", [abi.md](../abi.md) ABI 31, [testing.md](../testing.md)), the numbers in
`bench/gpu/REPORT.md`, the loose ends in [backlog.md](../backlog.md); §9 to §17 are the record of
what each loop found. **The 3D direction changed on 2026-10-09** (the user, §18): OpenGL ES first, through
**virgl** (Mesa's upstream guest driver) onto **WebGL2** as the baseline, a WebGPU backend only where the
browser has one, and Vulkan (Venus, Zink) deferred. §1 and §7 are the plan as revised; §4 (Venus on WebGPU)
is kept as the deferred Vulkan design. **G2 is done (2026-10-09, §19): virgl's guest side measured on a null
renderer, and the gate passed** (a sway frame costs the guest ~1/12 of llvmpipe's, at 60 frames a second). **G3 is done
(2026-10-09, §20): the WebGL2 renderer**, glcomp and sway on GLES drawing on the page (60 frames a second on a real
GPU), and 3D the page's default where WebGL2 is. G4 (breadth and correctness) waits for its kickoff: a proposal and
questions in `M8-GRAPHICS-HANDOVER.md`.

The question: how does a guest get a real display (mode setting, damage, a cursor) and, later,
**hardware-accelerated 3D** in a browser page, without the guest knowing it runs in one? Today the
guest has a `simple-framebuffer` (`docs/devices.md` "Framebuffer"): a fixed-size x8r8g8b8
region in guest RAM that `web/display.ts` copies to a `<canvas>` on every animation frame, whether
it changed or not (`docs/backlog.md`, "Framebuffer"). The only 3D a guest can do is Mesa's software
renderers (llvmpipe, lavapipe) on our emulated CPU.

## 1. Decisions (revised 2026-10-09)

- **virtio-gpu is the display device**, 2D (done) and then 3D over the same device. The guest drivers
  are upstream, so the guest needs no patches. `simple-framebuffer` stays for boot tests and guests
  without the driver.
- **No translation layer and no software rendering in the guest.** The guest's CPU is the scarcest
  thing the machine has: even after the JIT's NEON rounds llvmpipe takes 323 ms a compositor frame on
  1 vCPU and 71 ms on 4 (§18), and Zink (GL on Vulkan) would be another layer of Mesa running under
  emulation. The guest runs a thin driver that serializes; the work happens on the host.
- **3D: OpenGL ES through virgl, rendered with WebGL2.** The guest runs Mesa's **virgl** Gallium driver
  (in every distro's Mesa: `virtio_gpu_dri.so`), which sends Gallium state, TGSI shaders and resource
  transfers over virtio-gpu's VIRGL capset. The host side is **our own virgl renderer on WebGL2**:
  decode the command stream, translate TGSI to GLSL ES 3.00, issue WebGL2 calls. virglrenderer (MIT) does
  the same on native GL/GLES hosts and is the reference (port from it with attribution where it helps).
  On a GLES 3.0 host, which WebGL2 roughly is, virglrenderer gives the guest **OpenGL ES 3.0 and desktop
  GL 2.1** (§18). That covers wlroots, KWin and GTK4's GLES paths, and the browsers' ANGLE.
- **WebGL2 is the baseline and WebGPU an optional backend.** WebGL2 is everywhere Chromium is; WebGPU is
  often missing on Linux. A later WebGPU backend for the same protocol could advertise more (compute and
  storage buffers: GLES 3.1), only where `navigator.gpu` gives an adapter. A page without WebGL2 doesn't
  advertise virgl: 2D only, as today.
- **virgl's resources are guest-backed** (`RESOURCE_CREATE_3D`, `TRANSFER_TO_HOST_3D`/`FROM_HOST_3D`
  copy between the backing pages and the host object). No `HOSTMEM` window, no blob resources and no
  coherent-memory tracking are needed: the problem that made Venus hard (§4.3) doesn't arise.
- **Vulkan is deferred**: Venus → WebGPU (§4) only if Vulkan programs are asked for, and only on the
  WebGPU backend.
- **The guest side is measured before the renderer is built** (G2, §7): virgl on a null renderer in our
  machine, guest CPU a frame against llvmpipe's.
- Chromium only, as everywhere in the project.

### What the first draft decided, and why it changed
The 2026-09-27 draft chose Venus on WebGPU for Vulkan and Zink over Venus for GL, so that one protocol
covered both, and rejected virgl because it means translating TGSI and emulating desktop GL on a GLES-level
API. Two things changed. G1 and the JIT rounds showed that guest CPU decides everything (§16, §18), and Zink
is a translation layer in the guest. And the user noted that WebGL2 is far more widely available than
WebGPU (Chromium on Linux often has no WebGPU). virglrenderer already runs on GLES hosts, so the "desktop GL
on GLES" emulation is a known, bounded problem, and the guest can only ask for what our caps advertise.

## 2. What exists elsewhere (findings, 2026-09-27)

- **Vulkan on a more restrictive API has been done before.** MoltenVK (Vulkan on Metal; the reason
  `VK_KHR_portability_subset` exists) and Mesa's Dozen (Vulkan on D3D12) translate the common core
  directly, emulate the awkward parts (MoltenVK runs tessellation as a compute pre-pass) and don't
  advertise the rest. WebGPU is roughly the intersection of Vulkan, Metal and D3D12, so it's a
  further step down, not a different problem. **We found no existing Vulkan-on-WebGPU layer**:
  wgpu and Dawn go the other way (WebGPU on Vulkan/Metal/D3D12).
- **Venus** ([Mesa docs](https://docs.mesa3d.org/drivers/venus.html); protocol and codegen in
  `venus-protocol`, renderer in [virglrenderer](https://gitlab.freedesktop.org/virgl/virglrenderer),
  MIT): the guest driver needs the virtio-gpu features `CONTEXT_INIT`, `HOSTMEM`, `RESOURCE_UUID`
  and `BLOB_RESOURCES`, plus the Venus capset. `HOSTMEM` is a shared-memory window (typically
  256 MiB to 8 GiB on QEMU) where host-visible `VkDeviceMemory` is mapped into the guest
  (`RESOURCE_MAP_BLOB`). Mesa's docs say virglrenderer relies on host drivers' current behavior
  for host-visible memory, beyond what the spec guarantees. Supported by crosvm and QEMU
  ([Collabora, 2025](https://www.collabora.com/news-and-blog/blog/2025/01/15/the-state-of-gfx-virtualization-using-virglrenderer/)).
- **virgl** (OpenGL over virtio-gpu, the older path): the guest sends Gallium state and TGSI
  shaders, and the host renders with desktop OpenGL. Mapping that onto WebGL2 or WebGPU means
  translating TGSI and emulating desktop GL on a GLES-level API. First rejected in favor of Zink on
  Venus; **chosen on 2026-10-09** (§1, §18). virglrenderer (MIT) supports GLES hosts (`use_gles`: GLSL
  levels 130 on GLES 3.0, 310 on 3.1).
- **gfxstream** (Google, Apache-2.0; Android emulator, now also in crosvm and Mesa): serializes
  Vulkan, and also GLES in the Android emulator. Its **GLES** stream against **WebGL2** (≈ GLES
  3.0) would be a much closer mapping than Vulkan against WebGPU. Its GLES guest libraries target
  Android, and Mesa's gfxstream driver is Vulkan only, so for unmodified Linux guests it means shipping our
  own guest side (§5, "A GLES passthrough library").
- **Native contexts** (virtio-gpu passing a real GPU's own kernel protocol through: freedreno,
  amdgpu, i915): need a real GPU driver on the host. Not applicable in a browser.
- **Shader translation:** Venus carries SPIR-V, and WebGPU only accepts WGSL.
  [naga](https://github.com/gfx-rs/wgpu) (MIT OR Apache-2.0, Rust, part of wgpu) has a SPIR-V
  frontend and a WGSL backend. Known gaps: no combined image-samplers (Vulkan GLSL uses them all
  the time; Zink emits them), and extra spills for SPIR-V values used outside their scope
  ([#6670](https://github.com/gfx-rs/wgpu/issues/6670)).
  [spirv-webgpu-transform](https://github.com/davnotdev/spirv-webgpu-transform) patches some
  unsupported SPIR-V (combined samplers among them) before naga. Tint (Dawn's compiler,
  Apache-2.0, C++) also reads SPIR-V, but it's C++ and we'd have to build it to wasm ourselves.
- **WebGPU in Chromium, relevant bits:** immediates (push constants: the WGSL `<immediate>`
  address space and `setImmediates()`) shipped in Chromium 149–150
  ([blog](https://developer.chrome.com/blog/new-in-webgpu-149-150)); subgroups, `shader-f16`, clip
  distances, dual-source blending and BC/ETC2/ASTC compression are optional features, with
  availability depending on the adapter. `queue.writeBuffer` should accept views of a
  `SharedArrayBuffer` (our guest RAM), but Chromium's history there is mixed
  ([gpuweb#4186](https://github.com/gpuweb/gpuweb/issues/4186)): check it in G0. WebGPU works in
  workers, with `OffscreenCanvas` for presentation.
- **crosvm's `rutabaga_gfx`** (BSD-3, already a reference in `THIRD_PARTY.md`): the virtio-gpu device
  model with 2D, virgl, Venus and gfxstream behind one interface. Our model for the device side
  and the command set.

## 3. virtio-gpu 2D

The transport and queues are the ones we already have (`core/src/virtio.rs`); the backend is
TypeScript in the device worker, like blk and net.

- **Commands:** `GET_DISPLAY_INFO`, `GET_EDID`, `RESOURCE_CREATE_2D`, `RESOURCE_ATTACH_BACKING`
  (a scatter list of guest pages: they are in the shared memory already, so the backend reads them
  in place), `SET_SCANOUT`, `TRANSFER_TO_HOST_2D` (copies only the damaged rectangle),
  `RESOURCE_FLUSH` (presents), `UPDATE_CURSOR`/`MOVE_CURSOR` on the cursor queue.
- **Presentation:** the page transfers its canvas to the device worker (`transferControlToOffscreen`)
  so a flush doesn't cross the main thread. A 2D context is enough for this step; the WebGPU
  context comes with 3D. The cursor is a CSS cursor made from the cursor resource, or a small
  overlay canvas.
- **Resize:** the page's size becomes the display info (`VIRTIO_GPU_EVENT_DISPLAY` config
  change), and the guest's KMS picks the new mode. Multiple scanouts only if someone asks.
- **Deterministic mode:** 2D is byte-exact, so the device tests keep exact step counts (natively
  with a Rust twin in `core/tests/common`, as with 9P and net).
- The guest side: `DRM_VIRTIO_GPU` in the Buildroot kernel (with fbdev emulation for the test
  script); Alpine's linux-virt has it as a module.

## 4. 3D: Venus on WebGPU (deferred: the Vulkan design, if Vulkan is asked for)

### 4.1 Shape
- **The translator is a separate wasm module in its own worker (the GPU worker)**, not part of the
  core: the core stays small and the vCPU's hot path doesn't grow. It owns the `GPUDevice`, the
  scanout's `OffscreenCanvas` (moved there from the device worker once 3D is on) and the Venus
  contexts. The device worker forwards 3D commands (`CTX_CREATE`, `SUBMIT_3D`,
  `RESOURCE_CREATE_BLOB`, `RESOURCE_MAP_BLOB`, …) to it over a `MessagePort`, and 2D stays where
  it is.
- **Proposed language: Rust**, as its own crate built with the project's toolchain, because naga
  is Rust and the Venus decoder can be generated from `venus-protocol`'s definitions by a
  `build.rs`, as the A64 decoder is. It talks to WebGPU through a small `Gpu` trait: in wasm, JS
  imports calling `navigator.gpu`; natively, a recording mock for `cargo test` (wgpu natively
  later, if a real native backend proves worth a dependency).
- **Dependencies to approve before G3:** naga (and perhaps spirv-webgpu-transform), plus whatever
  WebGPU bindings we choose (hand-written imports are the default, to stay minimal).

### 4.2 The Vulkan we advertise
Map what maps, emulate what's cheap, don't advertise the rest:

| Vulkan | WebGPU | Plan |
|---|---|---|
| Command buffers, render passes, pipelines, descriptor sets | Similar model | Mostly 1:1; render passes → `beginRenderPass`, descriptor sets → bind groups |
| Pipeline barriers, image layouts, events | Automatic hazard tracking | Accept them and ignore them |
| SPIR-V | WGSL only | naga at pipeline creation, cached by SPIR-V hash (compiles are slow; G4 measures) |
| Push constants | Immediates (Chromium 149+) | Direct; a uniform buffer where immediates are missing or too small |
| Queues, fences, timeline semaphores | One queue, async completion | One queue advertised; fences via `onSubmittedWorkDone` (§4.4) |
| Host-visible, coherent memory | No persistent mapping | The hard part: §4.3 |
| Memory aliasing (images and buffers sharing memory), sparse | Not possible | Not advertised; each image gets its own `GPUTexture` |
| Buffer device address, full descriptor indexing | No pointers, limited bindless | Not advertised (this is what rules out DXVK/VKD3D) |
| Geometry, tessellation shaders, transform feedback | Missing (vertex shaders can't even write storage) | Not advertised at first; a compute pre-pass later if Zink needs it (§8) |
| 64-bit shader types, many formats | Missing or optional | Advertise per the adapter's features and limits |

### 4.3 Memory
- **The `HOSTMEM` window lives in our shared wasm memory**, outside guest RAM in guest-physical
  space. Guest and translator see the same bytes with no copy: that's the one place where
  emulation is better placed than a native VMM. It comes out of the same 4 GiB wasm32 budget as
  guest RAM (layout A, `docs/architecture.md`), so its size is a VM config choice (e.g. 256 MiB).
- **Host-visible memory used by the GPU needs a shadow `GPUBuffer`**, updated at `vkQueueSubmit`
  with the ranges the guest wrote since the last submit. With coherent memory, the guest never
  says which ranges it wrote. **We own the MMU**, so we can track that: the window's pages start
  write-protected in the TLB, the first write to a page marks it dirty and makes it writable, and
  a submit uploads the dirty pages and protects them again. The mechanism is new (a write-watch
  bit, next to the TLB tag bits reserved in M0.5) and needs its own design and measurement in
  G4; uploading every mapped range on each submit is the simple fallback.
- **GPU → host-visible** (readbacks, query results): after the submit completes, `mapAsync` a
  staging buffer and copy into the window *before* the fence is signalled to the guest.
- Device-local memory is `GPUBuffer`/`GPUTexture` only; the guest never maps it.

### 4.4 Synchronization and threads
- WebGPU's completion is async and the vCPU runs in a worker. A guest `vkWaitForFences` is a
  Venus call that the device can complete later, like a slow disk read. The vCPU never blocks
  on the GPU worker, as with blk in realtime mode. The Venus "ring" (the driver's
  shared-memory command ring, used where it avoids a virtqueue round trip) polls on the GPU
  worker.
- **3D runs in realtime mode only**, like networking (`networking.md` N4). Deterministic tests
  stop at 2D and at the protocol level (§6).
- SMP (M7) changes nothing here: the guest's threads all end up in the same virtqueues.

## 5. Later, and alternatives kept open

- **A GLES passthrough library in the guest** (our own `libEGL`/`libGLESv2` that forwards GLES calls,
  as the Android emulator's guest libraries do for gfxstream): the closest possible mapping onto WebGL2 and
  the least guest CPU, since GLSL ES would pass through untouched. Not first, because the guests aren't
  ours to modify (users bring unmodified images, phase B), and because the library would have to integrate
  where Mesa already does: GBM and dma-bufs for compositors, EGL on Wayland and X11, GLX for Xwayland, glvnd.
  Revisit only if G2 shows that Mesa's virgl driver costs the guest too much. gfxstream's own GLES guest side
  targets Android; Mesa's gfxstream driver is Vulkan only.
- **WebGPU passthrough for guest programs.** A guest app written against WebGPU (wgpu, Dawn)
  could have its calls forwarded almost 1:1 to the page, since Dawn's wire protocol is already a
  serialized WebGPU. That would need a guest-side client library and our own virtio-gpu context
  type, with no upstream guest support. Interesting for demos; not a general graphics stack.
- **Video decode** (virtio-video, or virgl's video commands) via WebCodecs: far later.
- **Geometry shaders, tessellation**: neither WebGL2 nor WebGPU has them, so desktop GL above 3.1 isn't
  reachable honestly. Compute pre-passes (MoltenVK-style) on the WebGPU backend only if a real workload
  needs them.

## 6. Testing (`docs/testing.md`)

- **2D:** byte-exact, deterministic, natively and in Chromium (G1, as built).
- **The virgl device natively and deterministically:** the device's 3D commands on the null renderer
  (fences signalled at once) in the Rust twin (`core/tests/common/gpu.rs`), with a gpu guest that runs
  glcomp on virgl: exact step counts, like the 2D guest.
- **The renderer's unit tests in Node:** recorded virgl streams (captured from real Mesa clients through a
  vtest server, or from the device) decoded onto a recording WebGL2 mock; TGSI → GLSL ES on a corpus of the
  shaders Mesa sends (`VIRGL_DEBUG=tgsi` prints them), each compiled in headless Chromium.
- **In Chromium:** headless WebGL2 on SwiftShader in the dev VM. Pixels are compared with llvmpipe's
  with a tolerance, since GPUs aren't bit-exact. Through virglrenderer on llvmpipe, glcomp's pixel hash
  equals llvmpipe's own (§18), so the reference images can come from the oracle natively.
- **A guest subset of dEQP-GLES2/GLES3** (VK-GL-CTS: a guest workload, not copied code), growing with the
  caps.
- Benchmarks: glcomp (`gl_llvmpipe_jit` gains a virgl twin), glmark2-es2 and a compositor frame rate, each
  against llvmpipe; the complex-app benchmark (`bench/apps/chromium.ts`) with the guest's GPU process on
  virgl.

## 7. Steps

Each step comes with tests at the cheapest layer that catches it (`docs/testing.md`). G0 and G1 are done;
G2 onward is the 2026-10-09 proposal, settled by its kickoff. The proposal in detail is in
`M8-GRAPHICS-HANDOVER.md`.

- **G0 — WebGPU environment spike, measured (done: §10).**
- **G1 — virtio-gpu 2D (done: §9, §11 to §17).**
- **G2 — virgl's guest side, measured (decision gate; done: §19, go).** The oracle traces first (QEMU's
  `virtio-gpu-gl` on the dev VM's llvmpipe; virglrenderer's vtest server). Then the device advertises
  `VIRTIO_GPU_F_VIRGL` and the VIRGL/VIRGL2 capsets with caps that a WebGL2 renderer can honour, and
  accepts `CTX_*`, `SUBMIT_3D`, `RESOURCE_CREATE_3D` and the 3D transfers with a **null renderer**:
  commands parsed and counted, fences signalled at once. Measure guest CPU a frame for glcomp and for sway
  on virgl against llvmpipe and pixman, and which GL and GLES the guest's Mesa reports. Go on if a
  compositor frame costs the guest a small fraction of llvmpipe's.
- **G3 — The WebGL2 renderer, first frames (done: §20; 3D is the page's default).** A GPU worker that owns a WebGL2 context on the screen's
  `OffscreenCanvas`; resources as textures and buffers; the virgl decoder; TGSI → GLSL ES 3.00 for what
  glcomp and wlroots' GLES2 renderer send; a scanout shown straight from its texture; fences. Done when
  glcomp's pixels match llvmpipe's (with a tolerance) and sway on GLES draws on the page.
- **G4 — Breadth and correctness (current: §21; the kickoff is `M8-GRAPHICS-KICKOFF.md`).** Firefox first
  (measured, then made faster), the page's menu choosing 2D or 3D, a dEQP-GLES2/GLES3 subset (VK-GL-CTS,
  Apache-2.0, a guest workload) as the correctness gate and its failures, then GTK4 on the Arch image; the
  shader compile cost. Chromium's GPU process and a full desktop are written down if seen, not targets.
- **G5 — Performance and the product:** profiles of the renderer and the guest's driver (the kernel's submit
  path needs a finer instrument than the chunk-end PC sampler: §20); snapshots while 3D is in use. (Done in G3:
  the switch, `?gpu=2d`, and the fallback without WebGL2; snapshots while 3D is unused; real-GPU numbers.)
- **Later:** the WebGPU backend for the same protocol (GLES 3.1); Vulkan through Venus on it (§4).

## 8. Open questions

- **What virgl costs the guest under the JIT**: measured (§19). Mesa's frontend and shader compiles are cheap; the
  kernel's submit path is the remaining cost (~2.2 ms of sys a sway frame over pixman's), to profile in G3.
- **Which GL our caps can honestly reach on WebGL2.** virglrenderer on GLES 3.0 gives GLES 3.0 and GL 2.1. GL
  3.0 and 3.1 need things WebGL2 lacks or has only as extensions: `gl_ClipDistance`
  (`WEBGL_clip_cull_distance`), depth clamp (`EXT_depth_clamp`), conditional rendering, the sRGB
  framebuffer switch, texture buffers, texture swizzle (in GLES 3.0, not in WebGL2: done in the generated
  shader instead), base vertex (`WEBGL_draw_instanced_base_vertex_base_instance`). What Firefox's WebRender
  needs (GL 3.1 or GLES 3.0) and takes on Linux is to be measured.
- **One WebGL2 context for every guest context.** WebGL contexts share no objects, while virglrenderer gives
  each guest context a GL context in one share group. The renderer keeps each guest context's state and
  rebinds it when the guest switches.
- **Where the renderer runs:** settled in G3 (§20): a GPU worker started by the page owns the screen's canvas
  as WebGL2 and presents every scanout, 2D ones too; the virtqueues stay in the device worker, which forwards.
- **Fences and readbacks.** WebGL2's `clientWaitSync` takes only a zero timeout in Chromium. Since one
  context runs everything in order, a fence can be signalled when its submit has been issued, and a
  `TRANSFER_FROM_HOST_3D` read synchronously (`readPixels`, `getBufferSubData`) or, if that stalls too
  long, through a pixel-pack buffer polled with `fenceSync`.
- **Snapshots with 3D on**: the host's GL objects aren't in guest RAM. Settled for G3 (the kickoff's decision 3):
  a machine with 3D that isn't using it saves (unused contexts remade, the caps kept); one using it is refused.
  Rebuilding a machine in use (guest-backed resources from their backings, objects replayed) is open.
- **Shader compiles on the host**: ANGLE plus the driver under our GLSL; a cache by TGSI hash, and
  `KHR_parallel_shader_compile`.
- **Real-GPU measurements**: the Mac host's headless Chromium (widened in G3 to the page:
  `bench/gpu/sway-mac.sh`).
- **Security:** the decoder parses untrusted guest data and WebGL validates everything it's given; fuzz the
  decoder like the virtqueue parser.
- **Venus's assumptions about host-visible memory**, naga or Tint: only if Vulkan (§4) is taken up.

## 9. G1 loop 0: what the oracle showed (2026-10-01)

QEMU 11.1.1 `virtio-gpu-device` (mmio; the dev VM needs `sudo zypper in qemu-hw-display-virtio-gpu
edid-decode`) under `tools/uefi-oracle.ts --extra='<qemu args>'`, our EDK2, Debian 13's image
(kernel 6.12.107), QEMU's own VNC server for `SetDesktopSize` (`bench/results/local/rfb-resize.ts`,
dev-only). Commands traced with `-trace 'virtio_gpu_cmd_*'`.

- **The transport has to be modern.** QEMU's virtio-mmio is legacy by default, and the guest's
  `virtio_gpu` then stays at status `FAILED` with no message. The oracle needs
  `-global virtio-mmio.force-legacy=false` (our transport is modern, so we meet this).
- **EDK2 gives a GOP over virtio-mmio** (`VirtioGpuDxe`: a 640×480 resource created and set as the
  scanout before the kernel starts). **GRUB takes it:** with a GOP, GRUB's `gfxterm` initialises and
  the menu goes to the screen, **not to the serial console** (without a GPU: "error: no suitable
  video mode found" and a serial menu). The oracle's loader detection saw no menu, the 5 s timeout
  ran out (kernel at 12.4 s instead of 7.5 s). So on a virtio-gpu machine the boot menu is on the
  screen only, and a test that presses Enter at GRUB's serial menu needs a different way (the page's
  tests don't press it: they wait for the timeout).
- **Linux:** no `efifb` (the GOP is Blt-only, as expected), the screen is dark from the kernel's
  start until udev loads `virtio_gpu` (10.1 s of a 21 s boot to login, after the root mounts), then
  `[drm] features: -virgl +edid -resource_blob -host_visible`, 1 scanout, 0 capsets, `fb0:
  virtio_gpudrmfb`. The driver's first sequence: `GET_DISPLAY_INFO`, `RESOURCE_CREATE_2D` 0x2
  (1280×800: the preferred mode from the EDID), `ATTACH_BACKING`, `SET_SCANOUT`, then
  `RESOURCE_UNREF` of EDK2's resource 1, then per frame `TRANSFER_TO_HOST_2D` +
  `RESOURCE_FLUSH`. fbcon takes `fb0` at once (160×50 characters: 8×16 glyphs).
- **Resizing (display event, fbcon):** the guest reads `GET_EDID` and `GET_DISPLAY_INFO` and issues
  `SET_SCANOUT` with resource 0 (disable), then the **same 1280×800 resource with a rectangle of
  the new mode**. The console buffer never changes: `fb0` stays 1280×800 and `tty1` 160×50. A
  request for 1600×900 gave **1280×768** (the largest mode of the EDID's list that fits the
  buffer); 800×600 and 1024×768 gave a **rectangle smaller than the resource: fbcon crops**, as
  predicted. So the host must show exactly the scanout rectangle (never the whole resource), and
  the policy for shrinking while only the console runs is loop 5's to settle (the console can't be
  grown or re-fitted by any host action).
- **QEMU's EDID** (`bench/results/local/qemu.edid`, 256 bytes: base block + CTA extension) decoded
  by `edid-decode`: EDID 1.4, DisplayPort digital, a preferred detailed timing of the requested
  size (QEMU puts the size in a private `0xf7` descriptor too), standard timings up to 2048×1152,
  and the list Linux derives from that is what `modes` showed (5120×2160 down to 640×480). Our
  generator is checked against `edid-decode`, not against QEMU's bytes.
- **Not measured here, deferred to loop 5 on our machine** (the same machine they will run on,
  and a desktop install over QEMU's user network costs hours for what loop 5 measures anyway):
  GNOME and KDE on Wayland, a wlroots compositor, Xorg; `simple-framebuffer` next to a virtio-gpu
  (the page's Debian will not have both, so it's academic).

## 10. G0, measured (2026-10-01; `bench/gpu/REPORT.md`)

- **Headless WebGPU works in the dev VM** with `--enable-unsafe-webgpu` (a SwiftShader adapter); to
  present on an `OffscreenCanvas` from a worker it also needs `--enable-features=Vulkan
  --use-angle=swiftshader --use-gl=angle`, else `getCurrentTexture` fails with "A valid external
  Instance reference no longer exists". The Mac host's Chrome for Testing gives a Metal adapter with
  the first flag alone (the user's answer 5; `bench/gpu/run-mac.sh`, Node 26 and Playwright's
  Chromium were already there, nothing was installed).
- **`writeBuffer`, `writeTexture` and WebGL's `texSubImage2D` accept `SharedArrayBuffer` views** in
  Chromium 153, at the cost of plain ones: a backend can upload from the guest's pages directly.
- **Presentation of a 2D frame** (real GPU, ms to completion, 1080p / 1440p / 4K full frame; 10%
  rectangle): canvas 2D with a JS swizzle 3.6 / 5.9 / 12.3 (0.9 / 0.8 / 1.8); with RGBA ready
  1.6 / 3.0 / 5.7 (0.4 / 0.5 / 1.1); WebGL2 0.8 / 1.9 / 4.3 (0.06 / 0.2 / 0.7); WebGPU 2.2 / 3.5 / 6.2
  (1.4 / 1.1 / 2.6). **G1 uses canvas 2D, with the swizzle fused into `TRANSFER_TO_HOST_2D`'s
  gather**; WebGPU is the 3D steps' canvas (a canvas can't change context type: the page swaps
  canvases when 3D turns on).
- Still open for G3: `writeBuffer` cost is fine at scanout sizes; the immediates limit (64 bytes)
  exists on both adapters; subgroups are on both, `shader-f16` only on the real GPU.

## 11. G1 loop 3: the device (2026-10-02)

The backend (`web/gpu.ts`), the EDID (`web/edid.ts`), the native twin (`core/tests/common/gpu.rs`)
and the gpu test guest (`images/build.sh linux-gpu`) exist; [devices.md](../devices.md) "virtio-gpu"
says what they do and [testing.md](../testing.md) how they are tested. What the real driver showed:

- **Linux 6.18's `virtio_gpu` needs `CONFIG_DRM_VIRTIO_GPU_KMS=y`**: without it the driver binds,
  logs "KMS disabled" and offers no connector (`getresources: Not supported`).
- **Dumb buffers are always `B8G8R8X8` resources**, whatever the framebuffer's format later is. A
  hardware cursor (an ARGB8888 framebuffer on a dumb buffer) therefore carries its alpha in the
  X byte, and the host must keep that byte: the first version forced alpha to 255 for X formats
  and the cursor came out opaque. The resource keeps the raw fourth byte for every format; the
  screen ignores it (its hash forces it opaque; loop 4 checks that `putImageData` into an
  `alpha: false` canvas ignores it too).
- **A mode set is one full transfer and flush; `DIRTYFB` with a clip is a transfer and flush of that
  rectangle only** (`drm_atomic_helper_damage_merged`), so a write outside the clip stays
  invisible until the next flush: the test relies on it. A cursor update is a transfer of its
  64×64 and an `UPDATE_CURSOR` on the cursorq; a legacy `CURSOR` move is `MOVE_CURSOR` only.
- **The display event is raised by a config change and taken by a work item**: after our
  `changeConfig` the driver does `GET_DISPLAY_INFO` and `GET_EDID`, and the connector's preferred mode
  changes (`GETCONNECTOR` polling sees 800×600 with the physical size from the EDID, 210×160 mm
  at 96 dpi). This is the first real driver on loop 2's interrupt and generation; both worked.
- **The EDID is read as designed**: 640×480 is "preferred 640x480@59" (CVT-RB's 59.87 Hz), 170×130
  mm, one mode.
- **The test's display change is a hook, not an injected event**: after the Nth `RESOURCE_FLUSH`
  (`resize: {after, width, height}`) the backend changes the size, which is the same path a page
  resize takes (`Gpu.setSize`) and is exact in deterministic mode with no step to pick.
- **`edid-decode` rejects pixel clocks under 10 MHz**, so the smallest EDID is 480×300; the page's
  minimum (640×480) is above it.
- The guest is an initramfs with a static init and no fbcon or fbdev emulation: it is the only DRM
  master and the console isn't involved. 37.8M steps (the kernel's boot is most of it).

## 12. G1 loop 4: on the page (2026-10-02)

Debian's page runs on virtio-gpu ([frontend.md](../frontend.md) "The screen", devices.md): EDK2's graphics
output, GRUB's menu and "Loading Linux…", then fbcon on `virtio_gpu`; the login on the screen works;
`tests/page-debian.test.ts` passes (running at 54.8 s, the baseline's 53 s within noise; `/proc/fb` is
`virtio_gpudrmfb`; the canvas isn't black). What it found:

- **EDK2 writes QueueNum 0** and the transport put the device in NEEDS_RESET: the firmware stopped
  after its banner with no output at all. QEMU ignores a 0; ours now treats 0 (or never written) as the
  device's maximum (unit test; the shell test boots with a gpu).
- **A worker has no `requestAnimationFrame`** for a canvas handed from the machine worker to the device
  worker ("not supported in this Worker"): the presenter draws at once if the last draw was a frame
  ago, else on a 16 ms timer.
- **`getContext('2d', {alpha: false})` didn't make the screen opaque** in that worker: X formats' unused
  byte (0 for a primary plane) drew as transparent, white over the page. The scanout resource is made
  opaque when it is shown (loop 3's finding turned around: the cursor keeps raw alpha, the screen
  never does).
- **Which thread presents** (the kickoff's open question): measured, and moot. Flush-to-draw is a
  frame idle (median 16–17 ms) and, with the guest reading its disk, a median of 17–66 ms and a worst
  case of 89–972 ms, because virtio-blk's synchronous XHRs occupy the device worker and a flush is
  served only between them; drawing from the machine worker would wait for the same service. The fix
  was blk off that thread. **Superseded (2026-10-08):** once `serve` yielded every ~2 ms the worst flush-to-draw under a
  continuous disk read is 22–33 ms (`bench/io/REPORT.md` "Loop 5 judged"), so blk stays where it is; G3's 3D worker
  is its own question.
- **The firmware's keys stay on the serial terminal**: the page's GRUB menu is graphical (`gfxterm`
  takes the GOP) and appears on the screen only; EDK2 has no virtio-input keyboard. `?display=simple` keeps
  the old serial menus for tests (the key flow in `tests/page-disk.test.ts`) and as a fallback.

### After the user's manual test (2026-10-02)

- **Console output (`dmesg`, `less`) lagged, sometimes locked, on one boot of Debian; not reproducible on
  later boots, and not seen on Arch.** What was measured (Debian, `cat` of 2,130 lines to tty1): fbcon's
  scrolling sends hundreds of full-screen `TRANSFER_TO_HOST_2D`s a second (400–800), each ~2.5 ms of the device
  worker's time, so that thread was saturated and the guest waits for each reply. Two changes: the transfer's
  gather works in 32-bit words for the common formats (full 1024×768: 2.9 → 1.6 ms in Node), and the cat takes
  ~4.7–5.1 s (it was 4.5 s on the one earlier run). **Tried and dropped: lazy transfers** (note the rectangle,
  copy once per drawn frame): the same cat took ~9 s, so the copy was not the bottleneck once it was fast, and the
  guest's own work (4+ s of `sys`: fbcon's software scroll under emulation) is. A boot-dependent slow case
  (host load, a worker placement) is likely; `bench/results/local/dmesg-load.ts` is the repro to try.
- **GRUB's menu didn't take keys typed on the screen.** EDK2 has no keyboard driver but the serial console's, so
  until the guest has a driver on virtio-input (the keyboard's DRIVER_OK, polled by the machine worker →
  `keyboard {live}` to the page) the screen's keys are sent to the serial console as a terminal sends them
  (`terminalBytes` in web/input.ts); the serial terminal still takes its own keys when it is focused.
  `tests/page-debian.test.ts` presses `c` on the screen during GRUB's countdown. A real EDK2 keyboard
  driver would be cleaner (backlog).

## 13. G1 loop 5: resize (2026-10-02)

The page sends its screen box (docs/frontend.md "The screen"); what Debian's kernel does with it, on our machine:

- **fbcon can't grow, and a rejected mode blanks it.** The born size is the console's buffer. A bigger
  preferred mode is rejected in `drm_client_modeset_probe` (`Rejected mode ... (VIRTUAL_X)`); with no other
  mode in the EDID the result is "No connectors reported connected with modes", the fbdev client commits an
  empty mode and **the screen goes dark**. (QEMU's EDID lists standard modes, so it never showed.) Fix: the EDID
  always lists the born size (and the floor) after the preferred mode. A fresh probe (`echo detect >
  /sys/class/drm/card0-Virtual-1/status`) lists the new preferred mode, so the guest's connector has it for a
  desktop that uses it.
- **A shrink crops the console** (loop 0): fbcon takes the smaller preferred mode on the same resource. The
  display now notices the crop (`SET_SCANOUT` with a rectangle at the origin smaller than the resource) and
  asks for the resource's size again (the floor, one more display event): the console is whole, letterboxed.
  Planted (floor removed): the canvas followed the crop to 640×662, the page test fails.
- Not measured here, still: GNOME/KDE on Wayland, wlroots, Xorg (G2 picks a compositor by this; the
  floor and the extra modes are written so that a compositor allocating a resource per mode isn't affected,
  a unit test checks the logic, not a desktop).
- The page's `both` view shrinks the screen box (the terminal beside it): the size follows the layout, not
  only the window; the test uses it.

### After the user's manual test of loop 5 (2026-10-02)

- **The lock-ups were the device worker's event loop starving, not the display.** `Devices.serve` rang through
  `Atomics.waitAsync`, which returns at once when the word already changed, and `poll` is all microtasks: with the
  guest ringing continuously (tty1 scrolling under `dmesg`: 70–130 flushes a second, each a ~2 ms transfer) the loop
  never reached the event loop, so timers and the ports' messages waited, up to ~1.3 s measured. Everything on that thread
  waited with them: a key's **release** (the guest then autorepeats: the Enter keys that filled the screen with
  prompts), the page's `size`, the draw timer (the frozen-looking screen). `serve` now yields through a
  `MessageChannel` after every ~2 ms of work. Measured with the stats' new `lag` (the longest a 4 ms timer was late
  in the device worker, per second; `bench/results/local/lag.ts`, not committed): idle 2–4 ms; `dmesg` storm
  1000–1370 → 22–30 ms; storm plus a disk read 1.2–5.6 s → ~110 ms (blk's synchronous XHRs: the backlog item).
  No unit test: a Node reproduction (a worker ringing the bell, a slow `poll`) did not behave like Chromium
  (timers starved either way), so the evidence is the Chromium measurement above.
- **The size select "did nothing" for the console, by the kernel's design**: fbcon's buffer is the born size; a bigger
  mode is rejected, a smaller one crops (the display bounces it, above). A fixed size therefore applies at the next
  boot for a text console; the menu says so. Desktops follow at once (not yet measured here).
- **"Laggier than the framebuffer": measured, and mostly fixed** (`bench/results/local/fps.ts`, `busy.ts`: tty1 scrolling
  `dmesg` in a loop on Debian, 672×762; changed canvas frames per second and `dmesg` runs per 10 s, same host):

  | | frames/s | `dmesg` per 10 s |
  |---|---|---|
  | simple framebuffer (before the gpu) | 63 | 17 |
  | virtio-gpu as first built | 43 | 8 |
  | + lazy transfers | 60 | 5 |
  | + paced replies | 60 | 8–9 |
  | + queue size 16 | 56 | 12 |

  What it is: fbcon scrolling makes the guest send **~2,400 full-screen `TRANSFER_TO_HOST_2D` a second** (4,800
  requests with the flushes) while the page draws ~60 frames. Copying each (0.4 ms at this size) kept the device worker
  ~95% busy (the draw, 5 ms/s, was never the cost): `GpuOptions.lazyTransfer` notes the rectangles and copies the union
  once per drawn frame (`ScanoutSource.sync`; also at a state read, a detach, a cursor, a snapshot). That fixed the
  frame rate but not the guest: with replies instant the guest's damage worker (Linux copies the damaged clip from
  its shadow buffer and does an atomic commit per damage; no fences on 2D) ran flat out, ~5,000 commits a second, and
  `dmesg` got *slower* (5). `paceReplies` completes transfers and flushes at most once per 16 ms (the first after an idle
  moment at once: a key's glyph isn't delayed; a burst waits for the frame, as a real flush completes at the refresh)
  and a queue of 16 makes a flooding guest wait for room. Result: ~70% of the framebuffer's `dmesg` speed at an
  equal frame rate. **What remains is the guest's own cost of Linux's virtio-gpu fbdev path** (shadow copy + commit
  per damage; a framebuffer has none), which a host can't remove; `?display=simple` gives the old screen on a
  machine that wants the console fast. A held Enter is the same effect at a smaller scale: the vCPU (not the device
  worker, ~5%) runs the guest's DRM commits, which is the core the user saw. The tests' guests stay unpaced with a
  queue of 64, so their bytes and step counts don't move. **Lazy transfers were removed and the pacing was redone in
  §16** (a copy later than the command is wrong for a compositor; pacing flushes alone gives the same numbers).

## 14. G1 loop 6: the cursor (2026-10-02)

The guest's cursor is the canvas's CSS cursor. `UPDATE_CURSOR`'s 64×64 image reaches the page as a `cursor` message on
the display port (`web/gpu-present.ts`: RGBA copy and hotspot; **sent only when the image or hotspot changes**, never for
`MOVE_CURSOR`: the tablet is absolute, so the host's pointer is the guest's and moves at the host's rate with no round
trip). The page (`showCursor` in `web/app/main.ts`) draws it at the canvas's scale (a guest pixel is `scale` device
pixels; smoothing only when the scale isn't whole, capped at 128×128 device pixels, Chromium's limit for a cursor),
makes a PNG blob and sets `image-set(url(blob) <dpr>x) hotX hotY, none` with the hotspot scaled the same; it redraws on
every `fit()` (a resized window or screen menu changes the scale). Three states: **never set** (no guest cursor: the
page's own pointer, so EDK2's screens and a console with no mouse driver have one), **hidden** (`UPDATE_CURSOR` with
resource 0: `cursor: none`) and **an image**. A virtio reset goes back to "never set" (`GpuHooks.cursorReset`; a restored
snapshot sends its cursor again through `cursor`).
- **No overlay for `MOVE_CURSOR` warps:** the guests in scope (fbcon, KMS compositors) move the cursor plane only to
  follow the pointer they were given; a guest that warps would show the host's pointer where the user's is anyway. Build the
  overlay when one is seen.
- Tests: `tests/gpu-present.test.ts` (the messages: change vs. move, a copy, hidden vs. never set), `tests/page-cursor.test.ts`
  (the page: a message injected into the display port of Debian's page, the machine's worker stopped so its own resets
  don't race it: the CSS value, the scaled hotspot, the blob's size and alpha, `none`, back to the default; planted: the
  hotspot ignored, caught). The guest's own cursor bytes are the gpu guest's (loop 3).
- Chromium normalizes `-webkit-image-set(...)` to `image-set(...)`; a hotspot is in the image's pixels.

## 15. G1 loop 7: snapshots on a gpu machine (2026-10-02)

The machinery was there from loop 3 (`Gpu.save`/`restore`: the resource table, the scanout, the cursor; host pixels come back
from the backing in the restored RAM; the header lists the `gpu` kind) and loop 5 (the `size` message at `running`). Loop 7
adds the page's proof, in `tests/page-snapshot.test.ts` (Debian: a snapshot of the logged-in machine, loaded in a fresh
profile **with another window size**):
- the restored canvas has the saved size (fbcon's buffer: the console is never cropped) and is drawn, not black;
- the guest then has the new window's size as its connector's preferred mode (the test probes the connector,
  `echo detect >/sys/class/drm/card0-Virtual-1/status`, before it reads `modes`). **The empty `modes` file first seen
  here was a bug, found in §16's review:** the EDID's fallback mode was the size the display *started* with, which
  after a restore is the new page's, so a console restored into a bigger window found no mode its buffer holds and
  blanked the screen (the test passed on one lit frame before that). The fallback is now the size of the resource the
  guest last showed, kept in the snapshot, and the test checks the console is still shown after the event.
- Planted: the scanout not restored. The unit test (`tests/gpu.test.ts`, restore) and the page test both fail.
- A guest that wrote a backing without transferring it shows the newer pixels after a restore until its next flush
  (the restore re-reads every backing): harmless.

## 16. The review after sway (2026-10-02)

The user ran sway and foot (Debian, then their Arch image) and saw flashes of oddly shaped areas, a typed command's last
letter missing, all four cores busy, and, after two attempted fixes, the picture flipping between later and earlier frames.
A review of the whole 2D path followed; the dev-only driver is `bench/results/local/sway-diag.ts` (the Arch image in the
page, headless, 1376×762, 4 vCPUs; display statistics from `?displaystats`).

**What it was: the guest composites with llvmpipe, and llvmpipe is asynchronous.** Stock sway (1.12, Mesa 26.2, kernel
7.2.8; no `WLR_RENDERER` set) renders through Mesa's software rasterizer (`ps -T` shows `llvmpipe-0…3` inside sway; its
scanout buffers are 1408×768 for a 1376×762 mode, llvmpipe's 64-pixel tiles). The mechanism, from wlroots' and Linux's
sources (read, not traced in the guest): wlroots' GLES2 renderer ends a frame with `glFlush`, which hands the scene to
llvmpipe's rasterizer threads and returns, and then page-flips; Linux's primary-plane update sends `TRANSFER_TO_HOST_2D`
+ `SET_SCANOUT` + `RESOURCE_FLUSH` at once and waits for nothing (`virtgpu_plane.c`: no fence on a primary plane without
a blob). A GPU's fences make the flip wait for the rendering; llvmpipe has none. So **the transfer copies a buffer the rasterizer
threads are still filling** (measured: the host's copy equals the backing right after the flush and differs 30 ms later,
at every flip; a full-window redraw arrives over ~600 ms), and the host shows each buffer as it was two flips ago plus
whatever tiles were done: the missing last letter, the tile-shaped holes, a clock two seconds behind. A real display hides
the race by scanning memory continuously; a virtio-gpu host only wins it if its command path is slower than the
rasterizer (QEMU wasn't measured), and under the JIT the rasterizer is slow and the device is fast, so we always lose it.

| the same session | llvmpipe (sway's default) | `WLR_RENDERER=pixman` |
|---|---|---|
| per-core load with htop running (4 vCPUs) | ~54% on each | 4–8% |
| frames a second, `while true; do date; done` in foot | 9 | 46–55 (the guest's 60 Hz vblank timer) |
| host copy vs. backing after a flip | differs at every flip | never (0 mismatches in the session) |
| idle (a clock in the bar) | ~94% idle, 1 frame a second | the same |

**So nothing floods and vsync isn't the problem**: sway idles when nothing changes, and the load is llvmpipe's four
threads rasterizing (roughly 600 ms of vCPU time a frame). That cost is the JIT's to explain
(backlog; G2 was going to measure llvmpipe anyway) and decides whether GL desktops are usable at all; a compositor that
renders with pixman is cheap and correct today.

**What was tried, and why it lost:**
- *Lazy transfers* (§13: note the rectangle, copy at the page's draw): wrong by the protocol. The guest doesn't wait for
  replies, so by the time of a deferred copy a compositor is drawing a later frame into the same buffer. Removed.
- *`settle`* (copy before the reply reaches the guest): the same mistake one step earlier; the reply isn't what the
  guest waits for. Removed with the above.
- *`poll`/`scanPoll`* (re-read the shown resource's backing every 30 ms and draw what changed): it made llvmpipe's late
  pixels appear, and made it worse. At a flip the host shows the new buffer as transferred (frame N−2 with some of N),
  30 ms later the poll shows what the rasterizer has done since, and the buffer shown before had been polled up to
  N−1: the screen goes N−1, N−2, N, the flip-flop the user saw. It also read a buffer the guest was drawing into
  whenever the host was a command behind. Removed, with its `?gpu=verify` debug check.
- *Paced replies as built* held transfers as well as flushes, so a guest that waits for each reply (EDK2's GOP) got
  one command per frame.

**What exists now** (devices.md "virtio-gpu"): a transfer copies when it arrives; only `RESOURCE_FLUSH` and `SET_SCANOUT`
damage the screen (a transfer used to, so a draw could show a transfer before its flush); one flush reply per 60 Hz frame,
the first after idle at once, the rest of the queue held behind it in order (`paceFlushes`), with a queue of 16. The crop
floor's event is raised once more when the guest clears the event (it used to be five timers). The EDID's fallback mode
is the shown resource's size (§15: a restored console blanked). Console scrolling
(`bench/results/local/fps.ts`: `dmesg` in a loop on tty1, Debian, changed frames a second and `dmesg` runs per 10 s, one
session, single runs):

| | frames/s | `dmesg` per 10 s |
|---|---|---|
| before (lazy transfers, all display replies paced, queue 16), two runs | 60, 60 | 10, 11 |
| now (eager, flushes paced, queue 16), three runs | 55, 56, 59 | 11, 11, 12 |
| now, queue 64 | 52 | 12 |
| now, no pacing | 64 | 7 |

(The first two "now" runs were before the pacing kept a 60 Hz cadence against late timers.) Eager copies cost what lazy
ones did once the guest commits once a frame: the pacing was what mattered.

**Open, for the user:** a guest that composites with llvmpipe still shows stale frames (monotonic now, two flips late,
no flip-flop). The device can't know when the rasterizer is done. If such guests must look right before llvmpipe is
fast enough to matter, the honest emulation is a display that samples the scanout's memory at its refresh and holds a
flipped buffer back until it stops changing (complete frames, a frame or two late, a full compare per refresh); it
is a mode of its own, not built. The guest-side fix is one line: `WLR_RENDERER=pixman` (wlroots' source refuses a
software EGL device unless `WLR_RENDERER_ALLOW_SOFTWARE` is set; here it took llvmpipe without it, not looked into).

## 17. G1's exit (2026-10-02)

**The goal, against what was built.** The page's Debian draws through virtio-gpu from the firmware's menu (EDK2's GOP,
GRUB's `gfxterm`) through the console to a desktop; the canvas has the scanout's size, 1:1 in CSS pixels or in device
pixels with HiDPI; a scanout that doesn't fit is scaled down or letterboxed, never cropped; only flushed rectangles
are drawn; the guest's cursor is the page's; snapshots keep working (and a restored console no longer blanks, §15);
2D is byte-exact in deterministic mode natively, in Node and in Chromium (the `gpu` guest's steps and hashes).
**Not met as written: "resizing tells the guest, and guests that follow it take it".** The guest is told; of the
guests measured, none takes a new size live:

| Guest software | On a display event, on our machine | Without an agent |
|---|---|---|
| fbcon (Debian 13, kernel 6.12) | The buffer has the size it was born with: a bigger mode is refused (the EDID's second mode keeps the console), a smaller one crops and the display bounces it (§13) | The page's size at boot; letterboxed or scaled after |
| sway 1.12 (wlroots; Arch, kernel 7.2), pixman | The kernel lists the new preferred mode at once (and our fallback after it), but sway keeps its mode (wlroots seems to read an output's modes only when it connects: not checked in its source), so `swaymsg output Virtual-1 mode WxH` falls back silently too. `swaymsg -- output Virtual-1 mode --custom WxH` works: a new resource, the canvas follows 1:1 | The page's size when sway starts |
| GNOME, KDE on Wayland; Xorg | Not measured (none installed) | Expected: live for the first two, `xrandr --auto` for Xorg |

So live resize is the agent's first job after all ([agent.md](agent.md)), or a desktop's own setting.

**With sway on the screen** (the user's Arch image, `WLR_RENDERER=pixman`; `bench/results/local/sway-exit.ts`, dev-only):
the guest's cursor arrives as the canvas's CSS cursor (`image-set(...)`: loop 6's check with a real guest), and the
pointer goes where the user's is (focus follows the mouse between two windows, also with the screen scaled to 0.69).

**Numbers** (bench/gpu/REPORT.md "G1 exit"; headless Chromium 153 on the dev VM):
- the first pixel 7.5 s after the page's load (the firmware) instead of 18.7 s (the kernel's console); `running` at
  ~52 s either way: `virtio_gpu` costs the boot nothing measurable;
- key to glyph on the serial terminal 10.8 ms (unmoved); on the screen 52.8 ms against the simple framebuffer's
  39.2 with the same instrument: the guest's flush reaches the device 12 ms after the key and is drawn within 1 ms,
  and the rest is after the draw (the device worker draws outside animation frames: suspected, backlog);
- the backend: a transfer ~0.7 ms a megapixel (1.5 ms at 1080p, 2.6 at 1440p), a flush with its draw 1.4 and 2.6 ms
  for a full frame, 0.3 to 0.7 ms for a tenth of it; nothing per frame on the page's main thread;
- host memory 4 bytes a pixel per resource (8.3 MB at 1080p; capped at 64 MiB each, 256 MiB together);
- a desktop: §16's table (pixman 46 to 55 frames a second in a scrolling terminal at 4 to 8% a core when idle with
  htop; llvmpipe 9 and ~54%).

**The user's decisions for G0 and G1** (2026-10-01; the kickoff, `M8-GRAPHICS-KICKOFF.md`, is in git history):
guest pixels are CSS pixels by default, scaled up crisply, with a HiDPI setting that sends device pixels and the
physical size in the EDID; G1 is agent-free, and the agent is a later step that starts from the stock agents
([agent.md](agent.md)); the tests get a kernel variant of their own (`Image-gpu`) and a new guest, so no existing
step count moved; real-GPU numbers come from headless Chromium on the Mac host, for the bench page only (anything
else on that host, and the x86_64 desktop, stay off limits). Out of scope then and still: multiple scanouts,
pointer lock and a relative mouse (the host-integration track), browsers other than Chromium, ACPI.

**What G1 leaves** is in the backlog ("Platform and devices": the key's 13 ms, the transfer's cost at 4K, the
unmeasured desktops, the letterbox's page test, llvmpipe's stale frames, the firmware's flushes under the pacing; "JIT":
llvmpipe's speed).

## 18. The direction after the JIT rounds (2026-10-09)

The user's direction: no software rendering or translation layers in the guest, OpenGL ES ahead of Vulkan,
WebGL2 as the baseline with WebGPU only where it exists (§1). What was measured for it, on the dev VM:

- **llvmpipe after the JIT's NEON work** (`bench/boot/REPORT.md` "M8: llvmpipe", "M8: vector registers in
  locals"; `gl_llvmpipe_jit`: glcomp, a compositor's GLES2 frame at 1376×762): 6,936 → 445 → 323 ms a frame on
  1 vCPU and 1,859 → 100 → 71 ms on 4, about 12× native (26.6 and 7.4 ms). That is ~14 frames a second with
  every vCPU busy: far better, still unusable as a desktop's renderer. The old G2 (the software baseline) is
  dropped as a step, since these numbers are the baseline.
- **virgl's guest side, natively** (glcomp built on the VM, Mesa 26.2; `virgl_test_server --use-gles
  --use-egl-surfaceless` with `MESA_GLES_VERSION_OVERRIDE=3.0`, the client on `GALLIUM_DRIVER=virpipe`):
  - the client gets **OpenGL ES 3.0 (GLSL ES 3.00) and desktop GL 2.1 compat (GLSL 1.20)**, no core profile;
    on a GLES 3.2 or a desktop GL host it gets GL 4.3 and GLES 3.2;
  - glcomp's pixel hash through virgl equals llvmpipe's own (`a26ac0b1`, 30 frames);
  - **the client's CPU is ~83 µs a frame** (user + sys over 300 frames minus 1, the frames' 4 MB read-backs
    included) **against 24.6 ms on llvmpipe with one thread**: roughly 300× less, and start-up (EGL, the
    two shaders compiled) ~26 ms. vtest skips the kernel's virtio-gpu path, and the JIT's factor isn't
    applied, so G2 measures the real cost in our machine;
  - `VIRGL_DEBUG=tgsi` on the client prints the TGSI it sends (glcomp's two shaders: 6 and 3 instructions).
    The distro's virglrenderer is a release build, so `VREND_DEBUG=shader` (TGSI and the GLSL it makes)
    needs a debug build of it.
- The oracle tools are installed in the dev VM (CLAUDE.md): `virglrenderer-test-server`, `Mesa-demo`
  (`eglinfo`, `es2_info`), Mesa's EGL/GLES headers (glcomp builds natively with `clang -O2
  images/alpine/gl/glcomp.c -lEGL -lGLESv2`), and `qemu-ui-opengl`. **QEMU's `virtio-gpu-gl` doesn't run
  there:** `egl-headless` needs a DRM render node ("egl: no drm render node available"), the VM has no
  `/dev/dri`, and its kernel ships neither `vgem` nor `vkms`. So vtest is the protocol's oracle, and the
  guest kernel's 3D command sequence (fences on the plane, whether dumb buffers become 3D resources) comes
  from the kernel's source and from our device's own command log in G2.

## 19. G2: virgl's guest side, measured (2026-10-09)

The kickoff (`M8-GRAPHICS-KICKOFF.md`, in git history after this step): the handover's proposal, with Mesa's virgl
in unmodified guests, sway on GLES as the first desktop, snapshots refused while 3D is in use, 3D off by default
behind `?gpu=virgl-null`, and the Mac host not widened.

### Loop 0: the oracle (natively, vtest)

A debug build of virglrenderer `c8e3fc3b` (meson, natively in the dev VM; `tools/virgl-oracle/build.sh`) with a
patch that writes every submit, resource creation, transfer and capset to a file (`VTEST_DUMP`,
`tools/virgl-oracle/capture.patch`; `capture.sh` runs a client, `dump.ts` reads the file), and
`VREND_DEBUG=shader` for the GLSL it makes; `virgl_test_server --use-gles --use-egl-surfaceless` with
`MESA_GLES_VERSION_OVERRIDE=3.0` on llvmpipe, the clients on `GALLIUM_DRIVER=virpipe`. Captured (in
`bench/results/local/g2/`, ad hoc until G3's tests use them): glcomp, and glmark2-es2 under `xvfb-run` (16 scenes:
build, texture, shading, bump, effect2d, pulsar, desktop, buffer, ideas, jellyfish, terrain, shadow, refract,
conditionals, function, loop). es2gears doesn't start on Xvfb (EGLUT wants DRI3).

- **The caps** (`decodeCaps` in `web/virgl.ts` reads them): VIRGL is v1's 308 bytes, VIRGL2 the full 1408, max
  versions 1 and 2. On the GLES 3.0 host: GLSL level 130, `HOST_IS_GLES`, 16,384² textures, 8 samples, 15 uniform
  blocks; and bits WebGL2 can't back: independent blending, conditional rendering, `start_instance`, timer queries,
  depth clamp, `textureQueryLod`, sample shading, cull distance, fbfetch, sRGB write control, ASTC, half-z clip, dual-
  source blending, advanced blend equations. The device's caps (`virglCaps`) are these minus that list, with
  WebGL2's minimum limits (devices.md "virgl").
- **The shaders:** 192 shader pairs (TGSI in, GLSL ES 3.00 out). virglrenderer's GLSL needs **`GL_EXT_clip_cull_
  distance` in every vertex shader and `GL_EXT_blend_func_extended` in 110 of the fragment shaders** (because the host
  advertised them), and `GL_NV_shader_noperspective_interpolation` in 8: on WebGL2 those are extensions at best, so
  G3's translator must not emit them unless the adapter has them (clip distances only when the guest writes them;
  dual-source blending is off in our caps).
- **The streams:** glcomp is 6 submits, 28 KB and 28 command kinds for 3 frames; glmark2's 16 scenes are 10,638
  submits, 61 MB and 44 kinds (`VirglStats` names them). Over vtest, uploads and read-backs travel as
  `TRANSFER3D`/`END_TRANSFERS` in the stream (vtest's own path); over virtio-gpu they don't (below).
- QEMU's `virtio-gpu-gl` still can't run here (§18), so the guest kernel's sequence came from our device.

### Loop 1: the device on a null renderer

devices.md "virgl" says what exists. What the guests showed:
- **Alpine's Mesa has no virgl at all**: its APKBUILD's gallium drivers leave it out on every architecture, so
  `virtio_gpu_dri.so` is a stub and EGL says "virtio_gpu: driver missing" and falls back to llvmpipe (the
  handover's assumption was wrong). `images/build.sh alpine-virgl` builds Mesa 26.1.6 (Alpine's own version)
  from source with llvmpipe and virgl into `/opt/mesa` (~6 min), so the two renderers are measured on one build.
- Linux 6.18 (Alpine) and 7.2 (Arch) take the device as QEMU's: `features: +virgl +edid`, both capsets read,
  a context per DRM file. Mesa 26.1 reports `virgl (webpc)`, GLES 3.0 (glcomp asks for 2.0).
- **Mesa moves texture data through staging buffers**: a `glTexSubImage2D` is a copy into a guest-backed
  `VIRGL_BIND_STAGING` buffer and a `COPY_TRANSFER3D` in the stream, and `glReadPixels` the same in reverse, so
  glcomp and sway send **no `TRANSFER_TO_HOST_3D`/`FROM_HOST_3D` at all**. G3's renderer reads (and for read-backs
  writes) the staging buffers' guest pages while it runs the stream: the backing must be resolved per command, not
  per transfer.
- The Rust twin wasn't extended: the null renderer is a measuring device, G3 replaces it with one that can't run
  natively, and the Node tests cover it (backlog, if a native virgl guest is ever wanted).

### Loop 2: the numbers

**glcomp** (`gl_virgl_jit*` against `gl_virgl_llvmpipe_jit*`, the same Mesa build; Chromium 153.0.8010.52, the dev
VM, one session; medians of 3, IQR; `bench/boot/results/m8-g2/`; steps at the run loop's resolution,
±0.1M a frame on 1 vCPU):

| a compositor's frame (glcomp, 1376×762) | virgl, null renderer | llvmpipe, same build | Alpine's packaged llvmpipe |
|---|---|---|---|
| 1 vCPU, ms a frame | **1.68** ±0.03 | 314.7 ±1.6 | 326.8 ±1.4 |
| 1 vCPU, guest steps a frame | **0.70M** | 476M | 484M |
| 4 vCPUs (realtime, parallel), ms a frame | **1.30** ±0.02 | 69.3 ±0.4 | (71: §18) |
| 4 vCPUs, guest steps a frame (all vCPUs) | **0.62M** | 441M | |
| warm-up (3 frames, the two shaders compiled), ms | **10.0** / 13.3 | 4,472 / 3,820 | 4,490 |

So the guest does **~190× less work a frame on one vCPU, ~53× less wall time on four** (where llvmpipe has all four
busy and virgl one), and compiles glcomp's two shaders (GLSL → NIR → TGSI) in well under 10 ms. Of virgl's 0.7M
steps, about half is glcomp's own client work, which a compositor doesn't do: natively, under `perf` over vtest,
glcomp's pixel loop is 24% of the client's CPU, its `memcpy` into the staging buffer 23%, Mesa 21%, syscalls ~9%,
and dynamic linking (once) 13%. 1.68 ms for 0.7M steps (~0.4G steps a second, against llvmpipe's ~1.5G) means the
rest of the frame is the exits and the device's round trips, not guest code.

**Sway** (the user's Arch image, `bench/results/local/myarch2.qcow2`: kernel 7.2.8, sway 1.12, Mesa 26.2.3; the page
headless, 4 vCPUs, the screen fixed at 1376×762, foot scrolling `while true; do date; done`; the guest's
`/proc/stat` and sway's and foot's `/proc/<pid>/stat` over 10 s read on the serial terminal, frames from
`?displaystats`; the dev-only driver is `bench/gpu/sway-load.ts`, the results
`bench/boot/results/m8-g2/sway-*.json`; one session per mode, a second session gave the same to within 3%):

| foot scrolling | virgl, null renderer (`WLR_RENDERER=gles2`) | pixman | llvmpipe (gles2, no virgl) |
|---|---|---|---|
| frames a second | **60** (the pacing's cap) | 60 | 27.9 |
| all CPUs busy (user / sys) | 52% (9 / 43) | 51% (10 / 40) | 92% (57 / 34) |
| sway, ms of CPU a second (user + sys) | 102 + 294 | 88 + 162 | 2,098 + 172 |
| **sway, ms a frame** | **6.6** (1.7 user, 4.9 sys) | 4.2 | **81** |
| foot, ms a second | 381 | 470 | 265 |
| the device: submits, stream, transfers a second | 121 submits, 497 KB | 63 Mpx transferred | 29 Mpx |
| idle (sway alone; foot open) | 3% | 3% | 3% |

- The busy-CPU line is mostly the `date` loop's fork and exec (equal in the three); sway's own time is the
  compositor's cost. On virgl it is **8% of llvmpipe's** a frame, at more than twice the frame rate.
- **Mesa isn't the cost:** sway's user time a frame is pixman's (1.7 against 1.5 ms). The cost over pixman is
  **sys, ~2.2 ms a frame more** (two `SUBMIT_3D`s a frame: the kernel's execbuffer, fence and atomic-commit path
  under emulation). That is G3's first thing to profile; a GLES passthrough library (§5) would go through the same
  kernel path, so it isn't indicated.
- The null renderer answers at once; G3's renderer adds its own latency to the fences, which this doesn't measure.

### The gate: go on to G3

The gate was "a compositor frame costs the guest a small fraction of llvmpipe's". Measured: glcomp's frame is
~1/190 of llvmpipe's guest work on one vCPU, and sway's is ~1/12 of llvmpipe's guest CPU a frame and keeps 60
frames a second where llvmpipe makes 28. Mesa's frontend is cheap and its shader compiles take milliseconds. **G3 (the
WebGL2 renderer) is worth building.** What it starts from: the caps in `virglCaps`; the streams and shader corpus in
`bench/results/local/g2/` on the dev VM (to become fixtures; `tools/virgl-oracle/capture.sh` makes them again); staging buffers read and written through their guest pages per
`COPY_TRANSFER3D`; GLSL without the extensions virglrenderer leans on; the kernel's per-submit cost as the guest's
remaining overhead.

## 20. G3: the virgl renderer on WebGL2 (2026-10-09, done)

The kickoff was `M8-GRAPHICS-KICKOFF.md` (in git history; the user's decisions: caps that follow the browser, WebGL2 presentation on 3D
machines with canvas 2D kept without 3D, 3D behind `?gpu=virgl` until the page and snapshot tests pass with it, the
Mac host for real-GPU numbers). What exists is in devices.md "virgl"; this is the record.

### Loop 0: fixtures

- **The device captures what a guest sends** (`Gpu.onCapture`, `GpuSpec.capture`, the page's `?gpu=…,capture`): a
  trace (`web/virgl-trace.ts`) of every 3D control command and, before a command that reads guest memory, the bytes
  it reads. `tools/virgl-capture.ts` runs glcomp on `alpine-virgl` in Node (`--llvmpipe`: on llvmpipe instead, keeping
  the last frame's pixels from glcomp's new `dump` argument, `webpc.gldump=1`); `bench/gpu/sway-load.ts` with
  `CAPTURE=` keeps sway's on the page. `tools/virgl-trace.ts` summarizes one.
- **What reads guest memory** is three commands, not one: `COPY_TRANSFER3D` from a staging buffer (texture uploads),
  and **`TRANSFER3D` in the stream** (the guest writes a buffer's own pages, vertex data, and the stream names the
  range: `VIRGL_CAP_TRANSFER`), and the virtio `TRANSFER_TO_HOST_3D` (neither guest sends it). Every submit starts
  with the queued `TRANSFER3D`s and an `END_TRANSFERS` padded to 1,009 dwords (4 KB of each submit is padding).
- Committed (`tests/virgl/`): glcomp at 128×96 (3+3 frames, 285 KB) with llvmpipe's last frame (`check d90f3ca3`);
  sway on the user's Arch image at 640×480 from its start to foot running `echo hello from foot; ls /` (765 records,
  8.8 MB, 204 KB gzipped); the TGSI corpus (65 distinct shaders: the oracle's 16 glmark2 scenes and the two traces'),
  `tests/virgl/tgsi-corpus.txt`. One of glcomp's two contexts is the initramfs's `nlplug-findfs`, which opens the
  render node at boot and never closes it.

### Loops 1 and 2: the renderer and the translator

- **The renderer** (`web/virgl-renderer.ts`, TypeScript on one WebGL2 context) decodes the stream as vrend_decode.c
  does and keeps vrend's model: contexts with sub-contexts that own the objects, resources attached to contexts, the GL
  state set from the sub-context at every draw (nothing is assumed bound between draws, so one context serves all the
  guest's). Buffers keep a CPU copy: WebGL2 forbids a buffer that is both an element array and anything else, and
  Mesa's upload buffer is both, so the element buffer is made from the copy when an indexed draw needs it; a
  vertex buffer with a zero stride (a constant) is read from it too, and base-vertex draws rebase their indices there.
- **No BGRA and no texture swizzle in WebGL2:** a format is stored as its bytes are (`B8G8R8X8` is an RGBA8 texture
  holding B, G, R, X) and swizzled in the generated shaders, on sampling (the format's swizzle composed with the
  sampler view's) and on writing (the render target's stored order, the clear color, the blend color and the color
  mask through it). An upload is then the guest's bytes as they are (no CPU pass), a read-back too, and the scanout
  is drawn through the format's swizzle. Destination alpha of an X format reads 1 (the blend factors substituted).
- **The translator** (`web/virgl-tgsi.ts`) parses the TGSI text tgsi_dump writes and generates GLSL ES 3.00 for a
  vertex and fragment shader *pair* (their varyings must agree in name and interpolation, which only the pair knows):
  registers are float vec4s holding bits (as vrend), constant buffer 0 a `uvec4` uniform array, the others uniform
  blocks, immediates literals (bits where a float literal would be a denormal or not finite: small integers moved into
  float registers must survive flushing). Programs are made at the draw that needs them, keyed by the state the
  shader can't know (the attributes' integer-ness, each sampler's type and swizzle, each color buffer's type and
  stored order, alpha test, flat shading, two-sided color, points). What GLES 3.0 lacks is refused with a reason
  (images, buffers, `IMUL_HI`, cube arrays, multisampled textures); none of it is advertised.
- **Caps from the browser** (`web/virgl-caps.ts`, decision 1): G2's caps are the floor (GLES 3.0's bits); the limits
  are the context's, the format masks the table's formats whose extensions are present (`R16_UNORM` with
  `EXT_texture_norm16`, float render targets with `EXT_color_buffer_float`, the compressed families with theirs),
  constant buffer 0 the uniform vectors less 16 for the generated shaders' own. `capsBacked` says whether caps a
  guest was given are still backed (a snapshot restored elsewhere).
- **Coordinates:** our textures store rows as the guest does (row 0 first), which is Gallium's upper-left origin and
  GL's own window coordinates, so nothing is flipped except: the front face (Gallium's is in its y-down window space:
  `front_ccw` inverts, as vrend does for guest resources), a viewport with a negative y scale (the shader flips
  `gl_Position.y` and the viewport is made positive), a fragment shader asking for a lower-left origin, and the
  screen, whose top is row 0.

**Results:** the corpus's 37 programs compile and link in Chromium (195 ms, SwiftShader). glcomp's trace, replayed
through the device into the renderer on Chromium's WebGL2, draws what llvmpipe drew to within 7 levels a byte (mean
0.76; the blended quads' filtering and rounding differ). sway's trace draws its desktop: the bar, foot's window, the
prompt and `ls`'s colored output (147 draws, 4 programs, no errors).

- **Stream output** (transform feedback: GLES 3.0 needs it, so it is advertised, `max_streamout_buffers` 4): the
  vertex shader gets an output per captured range (`tf_<k>`, the components the guest asked for, taken before the
  position is flipped), given to `transformFeedbackVaryings` before the link. GLES 3.0 has two layouts, everything
  packed into one buffer or one output to a buffer of its own; Mesa's GLES streams are one of the two, and anything
  else (gaps, two buffers with several outputs) is refused with a reason. GLES 3.0 also captures only unindexed point,
  line and triangle lists and refuses a draw that would overflow a buffer, where Gallium stops writing at the end: the
  draw is cut to the primitives that fit. Each target remembers how far it is written (an append in
  `SET_STREAMOUT_TARGETS` continues there: pause and resume), the captured bytes are read back into the buffer's CPU
  copy after the draw, and PRIMITIVES_GENERATED and PRIMITIVES_EMITTED are counted by the draws. A draw with nothing
  to draw on (capture only) gets a 1×1 framebuffer of its own with the rasterizer off.

**On the page** (`?gpu=virgl`, loop 3): the GPU worker owns the screen as WebGL2 and runs the renderer; the device
worker forwards its 3D work and the scanout. Arch's sway and foot draw through it (`bench/gpu/sway-load.ts` with
`VIRGL_GPU=virgl`; one rough run on SwiftShader: the date loop at ~35 flushes a second against the null renderer's
60, loop 4 measures it). The page's Debian tests pass with 3D on (`WEBPC_PAGE_QUERY=gpu=virgl
scripts/ci-debian.sh`), the snapshot saved, loaded in a fresh profile, suspended and resumed: the restore tells the
GPU worker what the scanout shows, which the first run found missing (the restored screen stayed black).

### Loop 4: sway on the page with the renderer (2026-10-09)

`bench/gpu/sway-load.ts` (§19's harness: Arch's sway and foot, 4 vCPUs, the screen at 1376×762, foot scrolling
`while true; do date; done`, 10 s per phase) with `VIRGL_GPU=virgl` against the null renderer, alternating in one
session; the renderer's own time from the GPU worker's stats. The dev VM's Chromium 153.0.8010.52 on SwiftShader;
the Mac host's (`bench/gpu/sway-mac.sh`, decision 4) Chromium 153.0.8010.12 on ANGLE over Metal, Apple M4. JSON in
`bench/gpu/results/g3-sway/`.

| foot scrolling | dev VM, null renderer | dev VM, renderer | Mac, null renderer | Mac, renderer |
|---|---|---|---|---|
| frames a second | 59.8, 59.8 | **55.6, 55.0** | 60 | **60** (the pacing's cap) |
| sway, ms of CPU a frame | 6.7, 6.9 | 7.9, 7.6 | 5.5 | 5.5 |
| the renderer's time a frame (submits, uploads, the screen) | | 1.07, 1.10 ms | | 0.65 ms |
| uploads | | 200 MB/s (foot's whole window each frame) | | 220 MB/s |
| all CPUs busy | 54% | 58% | 48% | 48% |

- **On a real GPU, 3D costs sway nothing measurable** over the null renderer: the same frame rate and the same CPU a
  frame. On SwiftShader (whose GL runs on the same CPUs as the guest) it is 7% fewer frames and ~0.8 ms of sway's
  CPU a frame more.
- **The first run made 38.8 frames a second.** Split with temporary changes (the GPU worker skipping the submits:
  42.3; skipping them and giving G2's fixed caps: 34.0), neither the renderer's work nor the caps were the cost:
  the GPU worker drew the screen at every `scanout` and `damage` call, three times a guest frame, and each task that
  draws commits a frame of the canvas, which Chromium holds to the display's rate, with the fence replies queued
  behind. The screen now draws in an animation frame, once however many calls came (`web/virgl-screen.ts`):
  55.6 frames a second. (`vm-renderer-1.json` is that first run; `vm-skip-*` the split.)
- The renderer's own time is ~1 ms a frame even on SwiftShader, most of it the upload of foot's window (3.7 MB a
  frame: a scrolling terminal changes all of it). The guest kernel's submit path (sway's sys time, ~4–5 ms of the
  frame) is the largest cost on both hosts.
- **The guest's kernel, profiled** (`PROFILE=1`: the page's PC sampler over every vCPU, the kernel's PCs symbolized
  in the guest against `/proc/kallsyms`; with the counters a second, `vm-profile-1.json`; the sampler's busy loop
  takes a host core, so that run made 37 frames a second). The emulator's counts over the date loop, all vCPUs: 9,300
  syscalls, 7,100 data and 1,700 instruction aborts from EL0, 4,500 IRQs, **25,700 TLB flushes** and 505,000 TLB
  misses a second. The profile: 38% idle (`cpu_do_idle`), then exit sites: the counter read
  (`arch_counter_get_cntvct` 11.8%), spin unlocks that unmask IRQs (10%), syscall entry (6.4%), EL0 aborts (2.8%),
  TLB range flushes (2.4%); nothing of virtio-gpu or DRM above 0.3%. **What it can't say:** the sampled PC is where a
  vCPU's current run chunk started (published at each chunk's end), so a chunk's time goes to the instruction after
  the last exit, and the date loop's fork and exec (page tables, TLB flushes, ASLR's randomness) is most of the
  kernel's work. Sway's submit path needs a finer instrument (a PC published more often than once a chunk, or
  exits counted by PC) and a load without fork and exec: G4's.

### G3's exit (2026-10-09)

- **Done:** Mesa's virgl driver in an unmodified guest draws through our renderer on WebGL2: glcomp's frame within
  7 levels a byte of llvmpipe's (also read back by the guest through the renderer, end to end in Chromium), and Arch's
  sway on GLES with foot as a desktop on the page, at 60 frames a second on the Mac host's GPU (the null renderer's
  rate and guest CPU) and 55 on SwiftShader. Caps follow the browser (decision 1); a 3D machine's screen is a WebGL2
  canvas for everything, the 2D path unchanged without 3D (decision 2); the page's Debian, snapshot, cursor and
  network tests pass with 3D on, so **3D is the page's default where WebGL2 is** (decision 3; `?gpu=2d` for the 2D
  path, which `WEBPC_PAGE_QUERY=gpu=2d scripts/ci-debian.sh` keeps tested); the Mac host measured the page (decision 4).
- **What the renderer doesn't do** (none of it advertised, or refused with a reason): indexed or strip stream
  output (GLES 3.0's limit), conditional rendering, user clip planes, multisampled textures sampled, depth
  read-backs, indirect draws; images, buffer textures, `IMUL_HI`, cube arrays (TGSI refused). The guest gets
  GLES 3.0 and GL 2.1.
- **Not measured yet:** anything beyond glcomp and sway: GTK4, the browsers in the guest, KDE or GNOME, a dEQP subset.
  The guest kernel's submit path (sway's sys time, ~4–5 ms a frame) is the largest cost and the profile couldn't
  separate it. Snapshots while 3D is in use are refused.
- **G4** (proposed in `M8-GRAPHICS-HANDOVER.md`, the kickoff the user's): breadth and correctness. A dEQP-GLES2/GLES3
  subset as a guest workload, then the applications (GTK4, a browser in the guest, a desktop's compositor), the gaps
  they hit, and the shader compile cost.

## 21. G4: breadth and correctness (2026-10-09, current)

The kickoff is `M8-GRAPHICS-KICKOFF.md` (the user's decisions: Firefox first, then GTK4 on the Arch image; a
dEQP-GLES2/GLES3 subset as the gate; snapshots while 3D is in use stay G5's; 3D stays the default, with a 2D/3D
choice in the page's menu).

### Loop 0: Firefox measured

**The image:** `bench/results/local/myarch3.qcow2` (the user's Arch Linux ARM with Firefox 157; git-ignored), grown
from 7.6 to 24 GiB and updated under QEMU with hvf on the Mac host with a network (`pacman -Syu`, the kernel held at
7.2.8; mesa-utils, gtk4-demos, strace, cmake, ninja, git, base-devel, wayland-utils added); its initramfs pinned to
`virtio_mmio virtio_blk ext4 vfat` (the update rebuilt it with `autodetect`); saved back as the page writes a disk,
4 KiB compressed clusters. The download is kept as `myarch3-orig.qcow2`.

**The harness:** `bench/gpu/firefox-load.ts` (on `bench/gpu/guest-session.ts`, shared with sway-load.ts: every
thread's CPU in the guest, the display's and the renderer's stats, the emulator's counters, per phase): sway on GLES,
then Firefox in kiosk mode with a profile of its own (`bench/gpu/firefox/user.js`) on synthetic pages (a still page,
a long page scrolled 6 px a frame from JS, WebGL 2 cubes) and on real sites saved with what they load
(`bench/gpu/firefox-pages.sh`: Wikipedia's Linux article, an MDN page, GitHub's torvalds/linux, BBC News, Hacker
News, on a second disk) scrolled by the mouse's wheel from the host (Firefox's asynchronous scrolling). Each Firefox
is waited for (its page's `FFBENCH ready`), left 30 s (a fresh profile's first minute is busy) and measured for 10 s:
the frames its animation ran a second (`dump` to stdout), the screen's flushes, the threads. An autoconfig
(`firefox/webpc.cfg`) writes about:support's graphics section. `bench/gpu/sway-mac.sh` runs it on the Mac host
(`SCRIPT=firefox-load.ts`; `HEADED=1` a visible window). JSON in `bench/gpu/results/g4-firefox/`.

**What Firefox does on virgl** (about:support): WebRender, accelerated, on "virgl (webpc)", GLES 3.0 for WebGL 1 and 2;
WebGL reaches WebRender through DMABUF (`DMABUF_WEBGL`: no read-backs), accelerated canvas 2D, Mesa's threading on;
Firefox blocks only its native compositor (`WEBRENDER_COMPOSITOR`, by gfxInfo), video decoding and DMABUF export.
Only the parent process maps Mesa (WebRender and WebGL run there). One shader fails to compile in the guest
(`GL_EXT_shader_texture_lod`, which Mesa 26 has for no GLES driver): not ours.

| (frames a second, median of 10; start in s) | dev VM, SwiftShader, 3D | dev VM, 2D (llvmpipe in the guest) | Mac, M4 GPU, 3D |
|---|---|---|---|
| still page | 60 | 60 | — |
| scrolling page (JS) | 53 | 23 | 59 |
| WebGL 2 cubes | 34 | 2 | 60 |
| Wikipedia, wheel | 4 (start 69, load 28 s) | | 49 (start 41, load 15 s) |
| MDN | 17 (44, 14 s) | | 59 (25, 7.5 s) |
| GitHub | 21 (28, 7 s) | | 59 (19, 4.8 s) |
| BBC News | 44 (57, 37 s) | | 60 (30, 17 s) |
| Hacker News | 32 (29, 10 s) | | 60 (23, 5.4 s) |

- **3D is what makes Firefox usable:** on 2D the guest's llvmpipe takes all four vCPUs for sway alone (scrolling 23
  frames a second, WebGL 2). Headed and headless Chromium on the Mac give the same numbers (the user's question: no
  headless throttling).
- **On a real GPU, scrolling holds 50–60 frames a second on the real sites; start-up and loads are slow:** 18–41 s
  to start (a warm profile) and 5–17 s to load a page, the guest's CPU-bound work (the content process, WebRender's
  render backend and renderer threads, Firefox's main thread; 40–60% of four vCPUs, a quarter to a half of it in the
  kernel).
- **On SwiftShader the GPU worker stalls after every present**: Chromium holds a worker's canvas commit until the GPU
  process has drawn the frame, ~33 ms with SwiftShader drawing WebGL on the CPU (25 stalls, 850 ms a second; every
  one after a present, none after a submit alone). A fence waits behind it: 18 ms on the way to the GPU worker,
  0.2 ms back, against 0.2–0.3 ms on the Mac. Firefox waits on fences several times a frame, so WebGL holds at ~34
  frames a second there. Presenting through `transferToImageBitmap` instead moved the same wait into the transfer
  (no gain). SwiftShader is the dev VM's and CI's, not a user's: not pursued.
- **The device counts its commands** (`?displaystats`: per type, fences' round trip and each hop, replies held):
  Firefox's Wikipedia and MDN scrolls create and destroy ~15–18 3D resources a second (each an `ATTACH_BACKING` in the
  guest's kernel), and the device holds every reply behind a fenced one (QEMU holds only the fenced reply).

### A correctness fix: translucent surfaces on an X target (2026-10-09)

The user saw a black border around every Firefox menu on a 3D machine (rounded corners and a shadow drawn as an
opaque rectangle); on a 2D machine they were right. The renderer's trace (`?gpu=virgl,debug`, below) showed the
menus drawn by Firefox in software into shared memory, uploaded by sway into B8G8R8A8 textures with their alpha
(transparent corners, a translucent shadow), and blended by sway (`ONE, ONE_MINUS_SRC_ALPHA`) onto its B8G8R8X8
output. The translator wrote a constant 1 into an X target's unused byte, and GL blends with the fragment's alpha
as written: the source alpha became 1. The X byte now gets the fragment's alpha (`writeOf` in
`web/virgl-formats.ts`; tests/virgl.test.ts checks the program, and failed with the old layout); sampling an X
format still reads 1 and its destination alpha is still substituted. No dEQP had run yet: G4's loop 3 is the gate
that should find this class of bug.

- **The renderer's trace** (`?gpu=virgl,debug`; the harness writes it to `<out>/virgl-debug.txt`): each distinct
  resource creation, surface, sampler view, draw (its targets, blend, the views it samples), clear, blit, copy and
  texture upload (with an alpha histogram for 4-byte formats), once. `GUEST_CMD` in firefox-load.ts runs a command
  in sway's session (the guest's `eglinfo` configs, for one: Mesa on our caps lists AR30 first, llvmpipe AB30).

### Loop 3: dEQP, the correctness gate (2026-10-09)

Moved ahead of Firefox's speed: the menus' black borders (above) were a conformance bug no test had looked for.
`images/deqp/build.sh` builds dEQP (images.md); `bench/gpu/deqp-run.ts` runs a case list on the page under the JIT
(the Arch image on a 3D machine, dEQP as its second disk, as root on EGL's surfaceless platform: no compositor):
every 50th case of the GLES2 and GLES3 mustpass lists (344 and 896 cases), or named cases and `*` patterns
(`CASES=`), with the renderer's trace (`VIRGL_GPU=virgl,debug`) or a capture (`CAPTURE=`). The oracle,
`tools/virgl-oracle/deqp.sh`, runs the same binaries on Mesa's virpipe against vtest on llvmpipe's GLES 3.0. A
subset takes 40 s (GLES2) and 3 min (GLES3) on the page. Results in `bench/gpu/results/g4-deqp/`.

| every 50th case | oracle (vtest, GLES 3.0) | page, first run | page, after the fixes below |
|---|---|---|---|
| GLES2 (344) | 342 pass, 2 not supported | 301 pass, 41 fail | **342 pass, 2 not supported** |
| GLES3 (896) | 884 pass, 6 fail, 4 quality warnings, 2 n/s | 755 pass, 112 fail, 21 q.w., 8 n/s | 837 pass, 51 fail, 8 n/s; then **862 pass, 26 fail, 8 n/s** (stream output, below) |

- **Point size declared twice** in a vertex shader that writes it (`o_psize`: every such program failed to link).
- **Stencil faces:** WebGL refuses a draw whose front and back stencil reference or masks differ (GLES allows it);
  such a draw now goes once per face (devices.md "virgl"). The whole GLES2 depth/stencil group passes (621).
- **Vertex strides:** WebGL refuses strides and offsets that aren't multiples of the type's size, and strides over
  255; such attributes are repacked. The whole GLES2 vertex-array group passes (571).
- Failures that came only after other cases (culling, single attributes) went with these: earlier draws broken by
  them, not state leaking.
- `tests/virgl.test.ts` replays a capture of two of these cases (`tests/virgl/deqp-gles2-stencil-stride.vglt.gz`) on
  the recording WebGL2 and checks WebGL's rules at every draw; each fix planted back fails it.
- **Stream output** (all 1,320 transform feedback cases: 0 passed before, 1,212 now, the rest not supported), three
  bugs: (1) GLES 3.0's two capture layouts can't express Gallium's (several outputs a buffer, several buffers,
  gaps): every output is now captured interleaved, as bits, into one scratch buffer and scattered to its target in
  the buffer's copy, then uploaded (`SoPlan`); (2) Mesa never sets the append mask: a resume sets the same targets
  again, and vrend continues a set of targets it has seen (a new Begin makes new targets), so the renderer did the
  same instead of restarting at every set; (3) query types are virgl's numbers (`VIRGL_QUERY_*`: 5 primitives
  generated, 6 emitted, 11 the conservative occlusion predicate), not Gallium's, so "primitives written" counted
  generated ones. tests/virgl-browser.test.ts's stream output case covers a mixed layout with gaps, a resume as
  Mesa encodes it and a paused draw inside the query (the old numbering, planted, fails it).
- **The renderer's error log** is capped per kind of error (5 each, 200 in all): 49 copy-region errors had used up
  the old cap of 50 and hidden the stream output's.
- **GLES3, still failing** (26): shadow samplers (7), integer blits between formats (5), RGB9_E5 (2), two MSAA
  derivative cases, a blend equation with constant color, `textureGradOffset` on a shadow array in a vertex shader
  (no GLSL ES overload), a copy from a source that can't be read, an occlusion query, a buffer mapped as an index
  array, two fragment outputs (RGB10_A2UI, RGBA4), a shared R16F renderbuffer, MSAA depth32f. Next by count.

