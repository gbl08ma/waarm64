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
GPU), and 3D the page's default where WebGL2 is. **G4 is done (2026-10-10, §21)**: Firefox and GTK4 on 3D, dEQP's whole
GLES2 and GLES3 lists passing on SwiftShader. Of G5, snapshots while 3D is in use (§22) and dEQP on the Mac's GPU
(§23) are done; what remains is open items in docs/backlog.md (dEQP on more platforms, GtkGLArea's offload) and
breadth if the user wants it (below, §7).

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
G2 onward is the 2026-10-09 proposal, settled by its kickoffs.

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
- **G4 — Breadth and correctness (done 2026-10-10: §21; the kickoff, `M8-GRAPHICS-KICKOFF.md`, is in git history).** Firefox first
  (measured, then made faster), the page's menu choosing 2D or 3D, a dEQP-GLES2/GLES3 subset (VK-GL-CTS,
  Apache-2.0, a guest workload) as the correctness gate and its failures, then GTK4 on the Arch image; the
  shader compile cost. Chromium's GPU process and a full desktop are written down if seen, not targets.
- **G5 — The product (proposed at §21 "G4's exit"; no kickoff):** snapshots while 3D is in use (done, 2026-10-19:
  §22), dEQP on a real GPU (the Mac's, done 2026-10-19: §23; other platforms are docs/backlog.md's "dEQP on more
  platforms"), the guest-side leftovers measured first (docs/backlog.md: GtkGLArea's offload). **Breadth, if the user
  wants it:** KWin or Mutter, Chromium's GPU process in the guest, Xorg; beyond GLES 3.0 is the WebGPU backend
  (below). (The finer instrument
  for the guest's submit path was G4's loop 6: not a cost. Done in G3: the switch, `?gpu=2d`, and the fallback
  without WebGL2; snapshots while 3D is unused; real-GPU numbers.)
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
  driver would be cleaner (backlog). **Since 2026-10-18 a machine with the USB controller has one:** the page's
  built-in USB keyboard, driven by EDK2's UsbKbDxe on the machine's xHCI, takes the screen's keys until the guest's
  virtio keyboard is live (docs/usb.md "The keyboard"). Machines without the controller keep the serial path.

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

## 21. G4: breadth and correctness (2026-10-09 to 10-10, done)

The kickoff was `M8-GRAPHICS-KICKOFF.md` (in git history; the user's decisions: Firefox first, then GTK4 on the Arch image; a
dEQP-GLES2/GLES3 subset as the gate; snapshots while 3D is in use stay G5's; 3D stays the default, with a 2D/3D
choice in the page's menu).

### Loop 0: Firefox measured

**The image:** `bench/results/local/myarch3.qcow2` (the user's Arch Linux ARM with Firefox 157; git-ignored), grown
from 7.6 to 24 GiB and updated under QEMU with hvf on the Mac host with a network (`pacman -Syu`, the kernel held at
7.2.8; mesa-utils, gtk4-demos, strace, cmake, ninja, git, base-devel, wayland-utils added); its initramfs pinned to
`virtio_mmio virtio_blk ext4 vfat` (the update rebuilt it with `autodetect`); saved back as the page writes a disk,
4 KiB compressed clusters. (Both of the user's images were deleted on 2026-10-16: `images/arch/desktop.sh` builds the
desktop guest that replaces them, docs/images.md.)

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
  guest's kernel), and the device holds every reply behind a fenced one (QEMU holds only the fenced reply). Both
  measured later and left as they are: "Firefox's resources and held replies", below.

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
| GLES3 (896) | 884 pass, 6 fail, 4 quality warnings, 2 n/s | 755 pass, 112 fail, 21 q.w., 8 n/s | 837 pass, 51 fail, 8 n/s; then 862 (stream output, below), 869 (depth textures), 875 (integer blits), 878 (transfer strides), 882 (index offsets, alpha without an alpha channel), **889 pass, 0 fail, 7 n/s** (loop 4: the whole list's fixes, MSAA) |

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
- **Depth textures** (all 432 shadow-sampler cases: 108 passed before, 432 now): Mesa uploads a depth texture's
  level through another texture and `RESOURCE_COPY_REGION`, whose source the renderer bound as a color attachment
  (a depth texture can't be one: the copy failed and the texture stayed empty); and Gallium's Z24_UNORM_S8_UINT
  and Z24X8_UNORM keep depth in a word's low 24 bits where GL's UNSIGNED_INT_24_8 keeps it in the high 24, so
  their uploads are rotated. tests/virgl.test.ts checks both on the recording WebGL2 (each planted back fails it).
- **Integer formats** (all 641 `fbo.blit` cases: 629 pass, 12 not supported): a blit between integer formats of one
  signedness goes through GL's blit (the draw that converts formats samples a float texture, which an integer one
  can't be), and RGB10_A2UI reads back as four integers packed again (it read one 32-bit channel).
- **Transfer strides** (`texture.specification.basic_texsubimage2d` and the format filtering groups: all 248
  supported cases): a transfer's stride (and layer stride) of 0 is its level's own pitch, as vrend reads it (the
  backing laid out as the whole level), not the box's width; Mesa writes a sub-image into the level's backing that
  way (`TRANSFER3D`), and every sub-rectangle narrower than its level went up from the wrong rows. Likely beyond
  dEQP: any partial texture update through the backing. And a texture of a format WebGL can't render to (RGB9_E5,
  the SNORMs) keeps its uploaded texels on the CPU, so `RESOURCE_COPY_REGION` from it (Mesa moves a level into
  its final texture that way) copies them (no framebuffer can read it). tests/virgl.test.ts checks the strides.
- **GLES3, still failing** (6, after the GLES2 fixes below): two MSAA derivative cases (the framebuffer is
  incomplete), `textureGradOffset` on a shadow array in a vertex shader (no GLSL ES overload), an occlusion query
  (`conservative_scissor_depth_clear_stencil_write`), a fragment output to RGBA4, MSAA depth32f.

- **The whole GLES2 list** (17,165 cases, five slices: `STRIDE=5 OFFSET=0..4`, ~6 min each on the page): 16,979
  pass, 48 fail, 136 not supported, 2 compatibility warnings (`bench/gpu/results/g4-deqp/full-gles2/`); the oracle,
  on slices 0 and 1, fails 6 of 6,866. Fixed from it: **blends that pair constant color with constant alpha**
  (WebGL refuses them; the source RGB factor is now applied in the fragment shader and blended with ONE,
  `ProgramKey.blendSrc`; on alpha, constant color is constant alpha), and **an inverted depth range** (near above
  far, which WebGL refuses: the range goes the right way round and the vertex shader negates z, `u_adjz`). The 48
  failures rerun on these fixes: **12 left** — index buffers (`buffer.write.use.index_array.*`,
  `draw_elements.indices.buffer.index_byte`/`index_short`), RGB565 render targets blended or shared between
  framebuffers (`fbo.render.color.blend_*rgb565*`, `fbo.render.shared_colorbuffer.rbo_rgb565*`),
  `shaders.builtin_variable.fragcoord_xyz` (only green, y, wrong). **All 12 fixed** (2026-10-10), three bugs:
  - **A draw's indices start at the index buffer's offset alone**: Mesa folds the draw's start into that offset
    (`virgl_draw_vbo`), vrend reads only the offset, and the renderer added the start again, so every indexed draw
    with a nonzero start read the wrong indices (likely beyond dEQP: any application drawing a mesh in parts). And
    WebGL2 always restarts primitives at the type's largest index (GLES 2 never does): such indices, with restart
    off, are widened to the next type; another restart index is mapped onto the largest. tests/virgl.test.ts's
    index case (each planted back fails it). Found by replaying the case's capture on Chromium and comparing each
    `drawElements` read-back with dEQP's `drawArrays` reference (`bench/gpu/virgl-pairs.ts`).
  - **A target without alpha** (RGB565, R8, RG8) had its output's fourth component written 0, which GL blends with as
    the source alpha: it now gets the fragment's alpha (the X formats' fix, for formats with fewer components).
  - **`gl_FragCoord.y` flipped twice:** our caps offer no lower-left origin (no `fragment_coord_conventions`, as
    vrend's on GLES), so Mesa lowers `gl_FragCoord` to upper-left itself (`nir_lower_wpos_ytransform`) and the
    TGSI's `FS_COORD_ORIGIN LOWER_LEFT` is only what the GLSL asked for; vrend on GLES ignores it, and so does the
    translator now.
  The whole GLES2 `fbo` group then passes (618 of 709, the rest not supported). GLES3's every-50th subset: **882 pass,
  6 fail** (from 878 and 10).

### Loop 4: the whole GLES3 list (2026-10-10)

dEQP-GLES3's whole mustpass list (44,768 cases) on the page, in ten slices (`STRIDE=10 OFFSET=0..9`, ~16 min each on
the dev VM): **44,033 pass, 326 fail, 399 not supported**, 8 quality warnings (highp `floor`'s precision) and 2
compatibility warnings (`flush_finish`: timing) (`bench/gpu/results/g4-deqp/full-gles3/`; the cases that didn't pass
in `page-failed.txt`). The failures by cause, and what fixed them:

| failures | cause | |
|---|---|---|
| 172 | MSAA: derivatives on multisampled framebuffers (120), `fbo.msaa` (36), invalidate after an MSAA blit (8), `multisample`, `state_query` max samples | fixed: multisampling advertised and backed |
| 62 | occlusion queries not available after `glFinish` | fixed: a fence waits for them |
| 58 | fragment outputs | fixed: two bugs |
| 18 | `textureSize` on cubes, `textureGrad` on 2D arrays | fixed: the translator |
| 15 | DEPTH32F_STENCIL8 textures | fixed: uploads drawn |
| 1 | a read-pixels format mismatch (negative API) | open |

- **Occlusion queries** (all 62 failed, "no result after glFinish"): GL's results are ready once a fence signals,
  WebGL's only after the task that ended the query, and the GPU worker answered fences at once. A fence is now held
  until the queries ended before it have their results (`FenceGate` in `web/virgl-host.ts`, released from the
  worker's query poll); exact queries use `ANY_SAMPLES_PASSED` (only virgl's conservative type the conservative
  one). Ordinary applications don't pay: a fence waits only behind a pending query.
- **Fragment outputs:** (1) WebGL2 has one color mask, and the renderer made it from the first target's layout,
  switching off the components that target doesn't store: an RG target first masked an RGBA one's B and A (dEQP's
  random output sets); such components now stay on. (2) A blit drawn through two formats' swizzles (Mesa reads an
  R11F_G11F_B10F or RGBA4 target back by blitting it to RGBA32F or RGBA8 first) reused the draw's framebuffer with
  only attachment 0 replaced: the next target sampled was still attached, a feedback loop WebGL refuses (the second
  of three outputs read back empty). Found by replaying the capture on Chromium with every `readPixels` and the GL
  error at each draw recorded.
- **The translator:** `TXQ` on a cube made `ivec4(ivec2, int)` (no program), on a 1D array (a 2D array of height 1)
  returned the height where Gallium wants the layers; `TXD` on 2D arrays passed 3D gradients (no program). The shadow
  array `textureGradOffset` case the subset listed as "no GLSL ES overload" was this.
- **MSAA** (172, the oracle fails the same: vtest on a GLES 3.0 host): Mesa makes a multisampled renderbuffer only
  with `texture_multisample` in the caps, which vrend sets only on GLES 3.1 (`feat_texture_multisample`), so the
  guest had no multisampling at all, though GLES 3.0 requires 4 samples and WebGL2 has multisampled renderbuffers.
  The page's caps now set it where the browser's `MAX_SAMPLES` is above 1, with the depth formats in
  `supported_multisample_formats`. Three things then needed backing: (1) **a multisampled source is resolved** into
  a texture of its own format before a blit that converts layouts (GL's resolve copies bytes: RGBA8 onto a B8G8R8A8
  window swapped red and blue) or whose rectangles differ (Mesa flips onto a window; GLES resolves only onto the
  same rectangle); (2) **the sample mask** (`SET_SAMPLE_MASK`, which Mesa makes from `glSampleCoverage` as the
  first ⌊value × samples⌋ bits, inverted or not) maps back onto WebGL's `sampleCoverage`; (3) the bit also gives the
  guest's desktop GL 2.1 `ARB_texture_multisample`, and WebGL2 samples no multisampled texture, so **a multisampled
  texture sampled is resolved at the draw** and fetched as a 2D texture (one value a pixel: the samples' average,
  whatever sample index the shader asks for; a backing that is close, not exact). Beyond dEQP: Firefox's WebGL
  `antialias` (on by default) gets real multisampling in the guest. The 172 rerun: all pass
  (`full-gles3/page-msaa-rerun.json`, before the last 11 were fixed; then those 11 pass). The every-50th subsets
  after it: **GLES3 889 pass, 0 fail, 7 not supported** (the oracle 884 pass), GLES2 342 (= the oracle).
- **DEPTH32F_STENCIL8** (15): WebGL2 takes no data for `FLOAT_32_UNSIGNED_INT_24_8_REV` (only null), so an upload to
  Z32_FLOAT_S8X24_UINT is drawn: the depths go up as an R32F texture and the stencil bytes as an R8UI one, one pass
  writes `gl_FragDepth` and clears the stencil, then one pass a stencil bit sets it where the byte has it (all 17
  cases of the format pass).
- Flat varyings now travel as integers (`vf_…`), copied from and into each shader's vec4: an integer's bits in a
  float varying are a denormal or a NaN, which GLSL ES lets the interface flush or canonicalize. SwiftShader keeps
  them (tested), so no dEQP case needed it; a real GPU's driver needn't.
- `tests/virgl.test.ts`: a feedback-loop check over every fixture's draws, the color mask at a mixed-width draw
  (`deqp-gles3-fragment-out-int.vglt.gz`), the fence gate, the texture queries in the TGSI corpus; each fix planted
  back fails its test.

### Loop 5: GTK4 (2026-10-10)

`bench/gpu/gtk4-load.ts` runs gtk4-demo's demos (GTK 4.22.5 on the Arch image) one at a time in sway
(`--run=<demo>`, `GSK_RENDERER=gl`: GSK's GL renderer), each left 15 s and measured for 10 (the compositor's frames,
every thread's CPU, the renderer's stats), with a screenshot; sway's start-up moved into
`bench/gpu/guest-session.ts` (`startSway`, `asUser`), shared with firefox-load.ts. GTK tries Vulkan first (the image
has Mesa's virtio ICD, without venus) and takes GSK's GL renderer on "virgl (webpc)", GLES 3.0. Every demo draws as it
should (the screenshots: shaders, gradients, masks, text, icons; no renderer errors). Dev VM, SwiftShader
(`bench/gpu/results/g4-gtk4/`; frames a second, the compositor's, and the threads' guest CPU in ms a second):

| demo | 3D | 2D (llvmpipe in the guest) | 3D: renderer busy ms/s | 3D: busiest threads |
|---|---|---|---|---|
| fishbowl (its own counter: 58 fps) | 56 | 1 | 14 | gtk4-demo 461, sway 344 |
| frames | 60 | 29 | 9 | sway 314, gtk4-demo 299 |
| iconscroll (its counter: 30 fps) | 31 | 1.7 | 42 | gtk4-demo 831, sway 155 |
| gears (GtkGLArea; its counter: 32.5) | 31 | 9.3 | 27 | gtk4-demo 333, sway 170 |
| shadertoy (GtkGLArea) | 15 | 1 | 7 | gtk4-demo 403, sway 134 |
| mask | 12 | 2 | 5 | gtk4-demo 166, sway 60 |

- **3D is what makes GTK4 usable**, as with Firefox: on 2D the guest's llvmpipe holds fishbowl and shadertoy at one
  frame a second. On 3D the limits are the guest's CPU (iconscroll's GTK thread at 0.83 of a core; 8,400 GL draws
  and 57,000 commands a second reach the renderer, which works 42 ms of each second) and, for the GL areas,
  SwiftShader's wait after each present (§21 loop 0): the Mac's GPU is where to judge them.
- **GTK's graphics offload kills a GtkGLArea** (shadertoy; sway disconnects it: `zwp_linux_buffer_params_v1`
  "invalid buffer stride or height for plane 0"). GTK hands the compositor the GL area's texture as a dmabuf, and
  Mesa's virgl backs a texture that isn't `PIPE_BIND_SHARED` with a 1-byte BO when the host copies transfers both
  ways (`use_staging`: our caps', and virglrenderer's own on any host), so the exported dmabuf is a page, smaller than
  its stride × height. A guest-side bug (Mesa exporting a staging-backed texture), not the renderer's; QEMU with
  virgl gets the same. `GDK_DISABLE=offload` avoids it (shadertoy then runs, 15 frames a second); a fix in Mesa
  (reallocate on export), or caps without `COPY_TRANSFER_BOTH_DIRECTIONS` (every texture then has a guest backing:
  to be measured) are the ways out (docs/backlog.md).

### Loop 6: cost (2026-10-10)

- **Shader compiles: no cache built.** The renderer compiles a program the first time a (shader, draw state) pair is
  drawn. In every steady phase measured (Firefox's scrolls, WebGL, real pages; GTK's demos) it compiles nothing;
  Firefox's start compiles 96 programs in 30 s, ~0.2 s of renderer time in a 32 s start that is the guest's CPU
  (loop 1). A cache by TGSI and key, or `KHR_parallel_shader_compile`, would save at most that.
- **A finer instrument for the guest:** the page's PC sampler named where a chunk started, so exits ranked high (§20).
  The vCPUs now publish their PC every 256 steps while it runs (`vm_set_chunk`, ABI 34; parallel mode, the page's:
  round-robin keeps its chunks, which place its interrupts). Sway's date loop, the same load profiled before and
  after (`PROFILE=1 node bench/gpu/sway-load.ts`): the counter read 11.8 → 4.4% of the samples, syscall entry 6.4 →
  0.8%, IRQ-unmasking spin unlocks 10.3 → 2.3%; what shows instead is work: the guest kernel's stack walks and
  preemption checks (`arch_stack_walk`, `check_preemption_disabled`, `preempt_count_add`, `debug_smp_processor_id`:
  the Arch kernel is built with preemption debugging), memset, page-table teardown.
- **The guest kernel's submit path isn't a cost worth chasing:** GTK's fishbowl and iconscroll profiled
  (`PROFILE=1 node bench/gpu/gtk4-load.ts`): 57–68% of the samples idle, GTK's user space ~20%, and the kernel's
  largest items the counter read (1.5–3%) and the debug checks above (~2% together); no virtio-gpu or DRM function in
  the top 60. Sway's ~4–5 ms of system time a frame (loop 0) is spread over the kernel's generic paths (syscalls,
  scheduling, IRQs), not one function. The machine's speed for these applications is the JIT's (`M8-JIT-HANDOVER.md`).
  Sampling costs a host core on the dev VM (a sampled demo runs at half speed); the 256-step chunks cost nothing
  measurable beside it.

### Loop 1: Firefox's start (2026-10-10)

`PHASES=startup` in firefox-load.ts measures a launch on a profile Firefox has used (the threads from launch, the
renderer's stats with its compile time). On the Mac's GPU (`bench/gpu/results/g4-firefox/mac-startup.json`): 32 s to
the page, **one thread busy: Firefox's main thread at about two-thirds of a core** (541 ms user, 128 ms system a
second), the machine at 43% of its 4 vCPUs, **no I/O wait**; the renderer works 8 ms a second, its shader compiles
and links 7 ms a second (96 programs). Firefox's start is its main thread's guest CPU: the emulator's speed (the JIT
track, `M8-JIT-HANDOVER.md`), not the graphics path. Page loads are the same kind of work (§21 loop 0's table).

### Confirmation runs and the dEQP test (2026-10-10)

The whole GLES2 and GLES3 lists again, after loop 4's fixes, found two regressions those fixes had made (the
every-50th subsets had passed with both in):
- **The drawn DEPTH32F_STENCIL8 upload left `UNPACK_ALIGNMENT` at 4**, where the renderer keeps 1: every later upload
  of rows not a multiple of 4 bytes (r8, rg8, r16, rgb565, rgba4, snorm) was skewed; 68 `texture.specification`
  failures, each passing alone. The first after the first depth32f_stencil8 case.
- **A query destroyed with its result pending stayed pending for good** (a deleted WebGL query never has one), so
  the `FenceGate` held every later fence: the guest's control queue filled (the hung tasks' stacks were in
  `virtio_gpu_queue_ctrl_sgs`), dEQP's watchdog killed it, and its exit hung ("Blocked by coredump": the dump waits
  for every thread). Three of ten GLES3 slices hung; the cases near `lifetime` (objects deleted in use) do it.
  The harness now keeps what a hang needs: no core dumps in the guest, the kernel's info on the console, the case
  dEQP stopped at (`stoppedAt`), and the page's whole serial log (`serial.txt`, the `__serialLog` hook) when a run
  times out.

After both fixes (`8b243ad`), on the dev VM (SwiftShader; `bench/gpu/results/g4-deqp/exit-gles2/`, `exit-gles3/`):

| whole list | pass | fail | not supported | warnings |
|---|---|---|---|---|
| GLES2 (17,165) | 17,027 | **0** | 136 | 2 compatibility (`flush_finish`: timing) |
| GLES3 (44,768) | 44,398 | **0** | 358 | 9 quality (highp `floor`'s precision, one `fbo.completeness.samples`), 3 compatibility (`flush_finish`) |

(GLES2's run was before `8b243ad`; neither fix touches what GLES2 can reach.) Loop 4's open
`read_pixels_fbo_format_mismatch` passes. GLES3 took 172 minutes in ten slices.

**The test** (the user's decision: a script of its own, as `ci-net.sh`): `scripts/ci-deqp.sh` (~7 min) runs
`tests/page-deqp.test.ts`, GLES2's and GLES3's pass lists (`tests/deqp/`: the every-50th subsets, 342 and 889 cases,
and for GLES3 the `lifetime`, `occlusion_query` and `texstorage2d/3d.format` groups, 325, which catch the two
regressions where the subsets didn't: each planted back fails it, the alignment with 27 cases, the hang in ~11
minutes with the serial log kept). It must pass when a change touches 3D and at a graphics track's end. Its guest is
the repo's: `images/deqp/build.sh` makes `target/deqp/guest.qcow2` (Arch Linux with mesa and libpng,
`images/arch/build.sh --packages`; Arch Linux ARM until 2026-10-16), so it no longer needs the user's image.

### G4's exit (2026-10-10)

- **Firefox** (decision 1): it opens on a 3D machine with WebRender and WebGL on "virgl (webpc)", GLES 3.0. Scrolling
  real sites holds 50–60 frames a second on the Mac's GPU, against 4–44 on SwiftShader and 23 (a JS scroll) on 2D;
  WebGL 2 cubes 60 against 2 on 2D. "Faster" found nothing on the graphics path to take: start-up (32 s) and page
  loads (5–17 s) are the guest's CPU (Firefox's main thread, content processes), the JIT track's. The one
  correctness bug the user saw (black menu borders) was fixed in loop 0.
- **dEQP** (decision 3): GLES2 and GLES3's whole mustpass lists pass with **no failure** (above; from 16,979 and
  44,033 passing at their first runs, 48 and 326 failing), better than the oracle (vtest on llvmpipe's GLES 3.0,
  which fails MSAA); a pass list is a test (`scripts/ci-deqp.sh`). The causes, by count: MSAA not advertised (172),
  occlusion queries before a fence (62), fragment outputs (58), and protocol meanings that are vrend's rather than
  Gallium's (query numbers, stride 0, index offsets, the append mask), WebGL refusing what GLES allows, and the
  translator's gaps (loops 3 and 4).
- **GTK4** (decision 2): every gtk4-demo demo draws right with GSK's GL renderer; 3D against 2D, fishbowl 56 against
  1 frames a second. GtkGLArea needs `GDK_DISABLE=offload` (a Mesa bug in the guest; backlog).
- **Snapshots while 3D is in use** stay refused (decision 4: G5's). **3D stays the default**, with the menu's
  Graphics choice (decision 5, loop 2).
- **Cost** (loop 6): no shader cache needed (steady phases compile nothing); the PC sampler publishes every 256
  steps while it runs (ABI 34), which showed the guest kernel's submit path isn't a cost: these applications wait on
  the emulator's speed.
- **Not tried:** Chromium's GPU process in the guest (since run: §24), KDE or GNOME (KWin, Mutter), Xorg. **Not measured:** dEQP on a
  real GPU (every run was on SwiftShader).

**G5, proposed** (for the user's kickoff): (1) **snapshots while 3D is in use** (decision 4): the renderer's state
lives in WebGL, so a snapshot needs the guest-visible state of each context and resource saved from the device's
side (resource contents read back, the objects a context created) and rebuilt into a fresh renderer on load, or the
commands since each context's creation kept and replayed; to be designed against what Firefox and sway hold. (2)
**dEQP on a real GPU** (the Mac's, ANGLE on Metal), what users run: precision, formats and limits differ from
SwiftShader's. (3) **The guest-side leftovers**, each measured first: GtkGLArea's offload (caps without
`COPY_TRANSFER_BOTH_DIRECTIONS`, or a Mesa fix); Firefox's resources a second and the replies held behind a fenced
one were measured and cost nothing worth taking (below). (4) **Breadth**, if the user wants it: a desktop's compositor (KWin, Mutter), Chromium in the guest. Beyond
WebGL2's GLES 3.0 (compute, GLES 3.1) is the WebGPU backend, deferred by the 3D decision (§18).

### Firefox's resources and held replies, measured (2026-10-17)

The backlog's item from loop 0: Firefox scrolling Wikipedia and MDN made 15–18 3D resources a second, and the
device holds every reply behind a fenced one. Measured with `bench/gpu/firefox-load.ts` (`PHASES=pages
PAGES=wiki,mdn`, Firefox 158, Mesa 26.2.4) on the dev VM (SwiftShader) and on the Mac host's GPU (`sway-mac.sh`, ANGLE
on Metal, Apple M4), 13 s of wheel scrolling a site; JSON in `bench/gpu/results/firefox-churn/`. **Neither is worth
changing:**

| (a second, over the scroll) | VM wiki | VM MDN | Mac wiki | Mac MDN |
|---|---|---|---|---|
| resources created | 10–14 | 13–25 | 7.4 | 15.9 |
| guest kernel in virtio_gpu, virtqueue, drm, shmem, dma-buf (% of all samples) | 0.94 | 1.00 | 1.51 | 1.14 |
| fence round trip, mean (max), ms | 15.6 (450) | 8.6 (299) | 0.5 (12.5) | 0.7 (18.4) |
| replies held: all, ms (of it unfenced, held only behind another) | 799 (393) | 297 (154) | 672 (26) | 686 (52) |
| control queue full (16 held), ms | 37 | 12 | 0.2 | 1.0 |

- **What is made:** the renderer's trace (`?gpu=virgl,debug`) now writes a `life` line at each resource's unref (its
  age, uploads, bytes staged; `vm-lives.txt`). Of 980 resources over two sites, 784 were small vertex buffers (16 to
  a few hundred bytes, written whole once or twice by inline writes, living 1.3 s / 3.2 s / 21 s at p10 / p50 / p90),
  most likely WebRender's per-frame vertex and instance data. The rest: 1 MiB staging buffers (Mesa's staging
  manager starts a new one when one fills), WebRender's 1024×512 texture-cache pages, sway's and Firefox's window
  buffers. The guest's Mesa makes a new resource whenever `glBufferData` changes a buffer's size (`bufferobj_data`),
  or rewrites a busy one (virgl reallocates it); its winsys keeps a released buffer for 1 s and reuses it only if it
  is idle and between the requested size and twice it. That's the guest's behavior: the device can't change it, and
  it isn't a cost.
- **What it costs:** the PC sampler (`PROFILE=1`, with the kernel's samples summed by group: `symbolGroups` in
  `guest-session.ts`) puts the whole 3D driver stack in the guest's kernel at 1–1.5% of the vCPUs' samples. Most of
  that is ioctl dispatch for every 3D call, not resource creation: no virtio_gpu function reaches the profile's
  top 60 (0.1% each). On the device, every control command together takes 3–6 ms a second (`requestMs`).
- **Held replies:** most of the held time is the paced flushes (devices.md "Flush replies are paced", by design).
  Unfenced replies held only behind a fenced one add 26–52 ms a second on the Mac, and the guest's 16-entry control
  queue is full for 0.2–1 ms a second. On SwiftShader it fills for 12–37 ms a second, inside the GPU worker's
  present stalls (300–450 ms, above), when the commands behind it would wait for the same worker anyway. Answering
  unfenced replies at once (QEMU's way) would win nothing on a real GPU. The display stats now count it
  (`fences.behindMs`, `fullMs`, `heldMax`).

## 22. G5: snapshots while 3D is in use (2026-10-18 to 10-19, done)

Started in a cloud session at the user's word ahead of a G5 kickoff (`M8-GRAPHICS-HANDOVER.md` item 1). The device
used to refuse a snapshot as soon as a context had submitted; now a machine using 3D saves, unless a video plays.

**The design: state as data, contents read back.** Not a replay of the commands since each context was made: that
grows without bound (Firefox makes 10–25 resources a second, §21), where the state is bounded by what the guest holds.
- **Objects** are already decoded data in the renderer (`Sub`: shaders as TGSI text, blend, rasterizer and DSA states,
  vertex elements, sampler views and states, surfaces, queries, stream-output targets; the bound state, constants,
  uniform buffers, vertex and index buffers, viewport, scissor). `VirglRenderer.save` writes each sub-context's
  objects as a list and its bound state as places in it (a value bound but no longer named by a handle is kept
  unnamed); `load` makes the values again, shaders re-parsed with new serials (programs are compiled at the draws that
  need them), GL objects (samplers, the VAO, transform feedback, queries) made on demand as always. An occlusion
  query begun and not ended is begun again (its "any samples passed" before the snapshot is lost); queries ended are
  settled first (the GPU worker polls them before it answers), their results already in the guest's memory.
- **Contents**, a resource's level at a time (`SavedLevel`, every layer): a buffer's CPU copy (`shadow`, nothing to
  read); a color texture through `readback` (with two formats the guest isn't offered read-back of: A4B4G4R4 as
  RGBA8, R11G11B10_FLOAT as floats, `snapshotReader`); a format WebGL can't render to, its uploaded texels (`texels`);
  a compressed one, its uploaded blocks (`blocks`, kept since G5: nothing reads compressed texels back); a multisampled
  color renderbuffer, resolved into a texture (a load draws it into every sample). Depth and stencil can't be read
  with `readPixels`: each layer is blitted to a 2D texture of its format (resolving samples), its depths drawn as
  float bits into R32UI, its stencil a bit a pass (a stencil test per bit adding the bit's weight into RGBA8); a load
  draws them back with the DEPTH32F_STENCIL8 upload's program, generalized (`drawZs`). A 16-bit depth is written a
  quarter step up: SwiftShader truncates the float. Lost (logged, `SavedResource.lost`): multisampled integer color.
- **Carried**: the GPU worker answers `save` with the state, transferring the contents' buffers; the device worker
  adds its tables (`Gpu.save`, async) and the state goes to the snapshot as JSON with Uint8Arrays, which
  `writeSnapshot` writes as BLOB frames (format version 2, plans/snapshots.md "The file"); a restore hands the state
  to the new GPU worker (`load`) before it shows the scanout.
- **Refused** only while a context has video codecs or buffers (`snapshotRefusal`): WebCodecs keeps its reference
  pictures, so a decode can't go on from a snapshot. "Close the video player first".
- **The size, before saving**: every 3D resource's bytes follow from its description (`VirglRenderer.snapshotBytes`:
  a buffer's width; each level's texels or blocks; 5 bytes a depth-stencil texel). The page asks the GPU worker and,
  from 64 MiB, says how much the 3D state adds and asks first (docs/frontend.md "Snapshots").

**Tests** (cloud, Chromium 141's SwiftShader): `tests/virgl-browser.test.ts` replays glcomp's and sway's traces with
the renderer saved and loaded into a fresh one on a new WebGL2 context at several submits (3 and 4 times), and the
final frame is the same bytes as without; each save, saved again from the renderer it loaded into, is the same
bytes. Every format as each kind of resource (2D with two levels, cube, 2D array, 3D, 4 samples; 353 resources)
loads and saves back exactly. A snapshot through the GPU worker's port into a second worker. Planted bugs (a load
that skips the texture uploads; one that drops the bound blend state; a stencil bit not read) fail them.
`tests/snapshot-file.test.ts`: BLOB frames round trip and their refusals. Sizes in the traces: glcomp 1.1 MiB
(4 resources), sway at 640×480 3.4 MiB (7).

**On a real guest (the dev VM, 2026-10-19; `bench/gpu/snapshot-3d.ts`, `bench/gpu/results/2026-10-19-snapshot-3d.json` and
`…-snapshot-3d-restore.json`).**
The desktop guest (`target/arch/desktop.qcow2`: sway 1.12, Mesa 26.2.4, Firefox 158, GTK 4.24) opened by its URL,
4 vCPUs, 2.5 GiB, 1376×762, Chromium 153 on SwiftShader; three saves (a download) per scene, medians:

| scene | 3D state (resources; raw → stored) | the file | the pause (of it, the devices' state) |
|---|---|---|---|
| idle (root shell, no 3D yet) | none | 369 MB | 2.4 s (13 ms) |
| sway and foot | 10 resources (8 textures, 2 buffers): 12.9 → 0.1 MB | 458 MB | 3.1 s (25 ms) |
| sway, Firefox on 400 WebGL 2 cubes, gtk4-demo's gears | 96 resources (55 textures 109 MB, 38 buffers 10.8 MB, 3 depth-stencil 4.7 MB; 8 contexts, 16 sub-contexts, 145 objects): 118.9 → 6.0 MB | 819 MB | 8.2 s (0.23 s) |

- **The 3D state is a small part of a snapshot, in time and in bytes.** Reading 119 MB back from the renderer
  (`stateMs`: the devices' state, the GPU worker's read-back in it) takes ~0.23 s; the rest of the pause is guest RAM
  (1.6 GB of non-zero pages for the desktop, 753 MB stored) and the overlay's blocks. The contents compress ~20 to 1
  (the largest resources are glyph and texture atlases, 2048×2048, mostly empty). The page's 64 MiB question comes up
  for the desktop scene (its `snapshotBytes` count is the raw size).
- **The load brings the session back:** the last desktop file, loaded in a fresh profile (a new browser context, the
  same disk by URL), runs 14.2 s after the choice; sway, foot, Firefox and gtk4-demo are there, Firefox's WebGL page
  counts 28–29 frames a second (25–28 before the save), the compositor 26 a second, the screen moves, and the
  renderer logs no error. No resource came back `lost`. A second run (`…-restore.json`: one save of the same scene,
  810 MB, loaded in 11.7 s; Firefox 20–23 frames a second after as before) also started a new GL client after the
  load, `es2gears_wayland`: it maps its window and draws. (gtk4-demo is one instance: another `--run` opens nothing.)
- **The machine runs on after each save** (the compositor's frames over 5 s afterwards; the guest keeps its frame rate).
- **What the first run found was not 3D's:** every restore of a machine with more than 2 GiB of RAM came back with its
  RAM past 2 GiB zeroed (the vCPUs spinning with no interrupts, the serial dead), the idle scene too. The snapshot
  writer's zero-page check shifted the byte offset signed (`off >> 2`), so pages past 2^31 read as zero and were left
  out; `>>>` fixed it (plans/snapshots.md "The file"; `tests/snapshot-file.test.ts` "RAM past 2 GiB").
- No page test of it: the desktop guest's session takes ~10 minutes to set up and an 800 MB file; the renderer's save
  and load are tested on traces (above), the file's large RAM in `tests/snapshot-file.test.ts`, and a snapshot's
  restore on Debian in `scripts/ci-debian.sh`.
- `scripts/ci-deqp.sh` passes with `drawZs` (the DEPTH32F_STENCIL8 upload shares its program now).
- **On the Mac host's GPU** (`bench/gpu/sway-mac.sh` with `SCRIPT=snapshot-3d.ts`, the same scenes; ANGLE on Metal,
  Apple M4, Chromium 153; `bench/gpu/results/2026-10-19-snapshot-3d-mac.json`), medians of three:

  | scene | the pause, Mac (SwiftShader) | the devices' state, Mac (SwiftShader) | the file |
  |---|---|---|---|
  | idle | 2.0 s (2.4 s) | 15 ms (13) | 374 MB |
  | sway and foot | 2.4 s (3.1 s) | 19 ms (25) | 452 MB, 13.5 MB of 3D state stored as 0.1 MB |
  | desktop | 5.2 s (8.2 s) | 195 ms (233) | 823 MB, 125–127 MB of 3D state stored as 6.2 MB |

  The 3D read-back barely shrinks on a GPU (195 against 233 ms for ~125 MB: the copies and the transfer to the device
  worker, not the drawing); the rest of the pause (the guest's RAM) is shorter on the Mac itself than in the dev VM,
  where SwiftShader also draws on the CPUs. The desktop ran at 60 frames a second before the save (Firefox's
  WebGL page; 25–28 on SwiftShader), the load ran 6.7 s after the choice (14.2 s), and the restored session went on at
  60 (Firefox and the compositor), with no renderer error; `es2gears_wayland` started after the load mapped its window
  and drew.

## 23. G5: dEQP on a real GPU (2026-10-19, done)

Every G4 run was on SwiftShader. Here the same harness ran on the Mac host's GPU (the handover's item; the handover is
retired with it): `bench/gpu/sway-mac.sh` with `SCRIPT=deqp-run.ts` (it copies the dEQP disk, `tests/deqp/` and a
`CASES` file; `STRIDE`, `OFFSET`, `CASES`, `LIMIT_S`, `DETAIL` passed on), Playwright's Chromium 153.0.8010.12
headless with a temporary profile, **"ANGLE (Apple, ANGLE Metal Renderer: Apple M4, Unspecified Version)"**, macOS
26.6.2, an Apple M4 with 10 GPU cores and Metal 4 (`system_profiler`). The same guest (`target/deqp/guest.qcow2`, Mesa
26.2.4) and the same slices as G4's exit. JSON in `bench/gpu/results/g5-deqp-metal/`. dEQP runs ~2.4 times as fast as
on the dev VM (GLES3's pass list 118 s against ~280; a GLES3 slice ~7 min against ~17).

| whole list | SwiftShader (G4's exit) | Metal, first run | Metal, after the fixes below |
|---|---|---|---|
| GLES2 (17,165) | 17,027 pass, 0 fail | 16,921 pass, 104 fail | **16,939 pass, 85 fail**, 136 n/s, 2 quality, 3 compatibility |
| GLES3 (44,768) | 44,398 pass, 0 fail | 44,268 pass, 137 fail (with the stream output fix) | **44,276 pass, 129 fail**, 358 n/s, 5 quality |

(GLES3's pass list, before any fix, failed 9 of 1,214, 5 of them stream output on lines: the first fix. The whole
GLES3 list ran with it; its isnan and invariance groups ran again after the last.)

**Ours, fixed** (each with a test in `tests/virgl.test.ts` that fails with the fix taken out; SwiftShader passed
these cases before and after):
- **One program with transform feedback on and off** (220 of the 440 `transform_feedback.*lines*` cases failed, 0
  after; `checks/tf-lines-*.json`): the renderer linked the vertex shader's program with the captured varyings only
  while targets were bound, so a shader drew through two programs, and dEQP compares the two drawings exactly. Metal's
  compiler computed the position differently in each (lines moved by a pixel). A shader with stream outputs now
  captures all of them, bound or not (`soOutputs`), as GL's one program does.
- **Invariance** (14 of GLES2's 15 `shaders.invariance` failures): Mesa marks an invariant position by the
  instructions that compute it (`_PRECISE`; GLES 3.0 has no `precise` to say it with), and the translator dropped the
  mark. A vertex shader with a precise instruction or an invariant declaration now says `invariant gl_Position;`
  (ANGLE then has Metal preserve invariance). The parser also read `MUL_SAT_PRECISE` as an unknown `MUL_SAT`.
- **Integer constants that are NaNs** (the 4 `argument_eval_order` cases and `shaders.random.all_features.vertex.39`):
  an integer immediate whose bits aren't a normal float went out as `uintBitsToFloat(4294967295u)`, which ANGLE folds
  into a float constant and its Metal backend writes as a canonical NaN: -1 came back as 0x7fc00000. Such immediates
  now read `uintBitsToFloat(K ^ u_zero)` (`u_zero` a uniform never set: 0, and not a constant). Likely beyond dEQP:
  any guest shader that selects a negative integer constant.
- **isnan** (8 `common.isnan` cases, GLES3): Mesa writes `isnan(x)` as `x != x`, which Metal's fast math folds to
  false; `FSNE` and `FSEQ` of an operand with itself are now `isnan` and `!isnan`, which ANGLE keeps.

**What stays different, and why** (none ours to fix; what a user on a Mac sees):
- **Mixed filters near the switch between magnification and minification** (84 GLES2 and 128 GLES3 failures,
  `texture.filtering.*` and `texture.vertex.*.filtering` with `nearest_linear` or `linear_nearest`): Apple's GPU keeps
  the magnifying filter up to a level of detail between 0.01 and 0.02, where GLES switches above 0. Shown without the
  emulator by `bench/gpu/filter-probe.ts` (a 2×1 texture sampled at explicit levels; `filter-probe-*.json`):
  SwiftShader switches as GLES does, Metal still magnifies at 0.004 and 0.01. A few pixels a case, and only where the
  two filters differ.
- **One invariance case** (`shaders.invariance.lowp.loop_2`, in both lists): both programs are invariant, and Metal
  still computes the loop's position differently in each (highp and mediump pass).
- **Quality warnings on lines** (`rasterization.*interpolation.*lines`): Metal's line rasterization. `flush_finish`'s
  compatibility warnings are timing, as on SwiftShader; SwiftShader's highp `floor` precision warnings pass on Metal.

No cap we advertise is beyond Metal: no `NotSupported` count moved and no case failed for a limit. The pass lists of
`scripts/ci-deqp.sh` stay as they are (CI runs SwiftShader). Still open: the other WebGL2 stacks users have
(docs/backlog.md "dEQP on more platforms").

## 24. Chromium in the guest showed older frames (2026-10-22, fixed)

**What the user saw** (their x86_64 desktop's NVIDIA GPU, the desktop guest with Arch's Chromium 153 on Wayland, ANGLE
on virgl, `VaapiVideoDecoder` through webpc-va): on pages playing video (YouTube), parts of Chromium's window, its tab
strip and address bar too, flickered between a later and an earlier frame, the regions out of step with each other,
until a navigation; the video's own frames jumped back and forth too. `--ui-disable-partial-swap` left only whole-page
jumps back while scrolling; `?gpu=2d` (llvmpipe) none. Firefox never showed it.

**Why:** the GPU worker's `CallQueue` (devices.md "virgl", plans/video.md §7) holds a context's calls while it may see
a picture being decoded, and let every other context's run ahead. The guest has no sync between virtio-gpu contexts:
a compositor samples a client's buffer right after the client's draws into it were sent, trusting the host to run
them in order (virglrenderer runs every context's commands as they come). So sway composited Chromium's window
buffer before Chromium's held draws into it had run, and showed what that buffer held a few frames back. Chromium's
partial redraws (only what changed since the buffer was last drawn) make a stale region show whatever frame last drew
it into that buffer: regions from different times. Firefox waits on its fences before handing sway a frame, so it
never gave sway a buffer with draws still held. **Fixed:** a call also waits behind a held context when it could see
what that context draws (a submit of a context sharing an attached resource with it, a transfer of one of its
resources); video's decode-only submits still pass (`tests/virgl-video.test.ts`, the compositor case; each half of
the rule planted back fails it). Checked by the user on their desktop (NVIDIA): YouTube in the guest's Chromium no longer
flickers; the green stripes at videos' right and bottom edges are gone too (below).

**Measured** (`bench/gpu/chromium-flicker.ts`: the desktop image with Chromium, sway on 3D, Chromium in kiosk mode on a
page playing sintel-silent.webm beside a frame counter in two rows of blocks, the second the first over 16; the host
reads the screen through Chromium's screencast, 30 s after 20 s of warm-up; the dev VM, SwiftShader, Chromium
153.0.8010.52; JSON in `bench/gpu/results/2026-10-22-chromium-flicker/`). "Back": frames whose counter is below one
already shown; "split": the two rows from different frames.

| Run | Frames read | Back (most frames back) | Split | Calls run ahead a second |
|---|---|---|---|---|
| old rule | 986 | 1 (2) | 0 | 12.9 |
| old rule, counting the hazard | 1,012 | 4 (7) | 1 | 9.9 of them shared a resource with the held context |
| new rule | 1,005 | 1 (1) | 0 | 8.5 (none sharing) |
| old rule, decoder slowed to ~50 ms, two rounds | 960, 920 | 20 (8), 22 (8) | 2, 3 | 23.5, – |
| new rule, decoder slowed, two rounds | 917, 972 | 0, 1 (1) | 0, 0 | 13.8, – |
| `?gpu=2d` (no virgl) | 653 | 0 | 0 | – |

The dev VM's software VP9 decodes a picture in ~9 ms, so calls are held briefly and the old rule shows few stale
frames; the slowed decoder (an experiment: each picture's output delayed 40 ms, as a hardware decoder that holds
frames would) makes it plain. The page's frame rate didn't move (counted frames 778–880 in every 3D run). Left: a single
one-frame step back in two of the new rule's four runs (none in the 2D run), not traced (docs/backlog.md).

**The green stripe** the user also saw beside videos in Chromium and mpv (not Firefox): every 3D run's screenshot had
one down the video's right edge. The planes are the coded size (864×480 for the 854×480 trailer) and the host wrote
only the visible picture, so the 10 columns past it kept zeros (luma and chroma 0: green), which Chromium and mpv show
and Firefox crops. Now each plane is filled to its texture's size with the picture's edge repeated (`padPlane`,
web/virgl-video.ts; the stripe gone in the same scene, `bench/results/local/chromium-flicker/padded`).

## 25. Working notes for 3D (carried from the graphics handover, 2026-10-19)

The tools, what the guests do and what was learned, kept from `M8-GRAPHICS-HANDOVER.md` when it was retired (G5's
items done or in docs/backlog.md).

### Tools

- `bench/gpu/guest-session.ts` (a page session on a guest image: serial root shell, sway, load phases, the PC
  sampler `PROFILE=1`, the whole serial log on a timeout), `firefox-load.ts`, `gtk4-load.ts`, `sway-load.ts`,
  `sway-mac.sh` (the Mac host's GPU; `HEADED=1` allowed when the user isn't using the Mac; `SCRIPT=deqp-run.ts` runs dEQP there, §23), `filter-probe.ts` (which filter a browser's WebGL2 applies at a level of detail), `snapshot-3d.ts`
  (snapshots of the desktop guest with 3D in use, and the load in a fresh profile; graphics.md §22).
- dEQP: `images/deqp/build.sh` (`target/deqp/deqp.ext4` and the guest `target/deqp/guest.qcow2`),
  `bench/gpu/deqp-run.ts` (`STRIDE`/`OFFSET` slices, `CASES=` lists and patterns, `DETAIL=`, `VIRGL_GPU=virgl,debug`,
  `CAPTURE=`; `stoppedAt`), `tools/virgl-oracle/deqp.sh` (vtest), `bench/gpu/virgl-pairs.ts` (a capture's read-back
  pairs on Chromium), `scripts/ci-deqp.sh` (the pass lists, `tests/deqp/`). A whole GLES3 list is ten slices of ~17
  min (`STRIDE=10 OFFSET=$k LIMIT_S=1800` under `timeout 2100`); validation, so other work may run beside it.
- The method that found G4's bugs: a group with `CASES='dEQP-…group.*'` and `DETAIL=3`, then one case with
  `VIRGL_GPU=virgl,debug`; compare with vrend (`target/virgl-oracle/src/src/vrend/`) and Mesa's encoder
  (`~/Development/src/mesa/src/gallium/drivers/virgl/`). Most bugs were WebGL refusing what GLES allows (silently)
  or protocol meanings that are vrend's, not Gallium's. A hang: the hung tasks' stacks in `serial.txt`.
- What found G5's Metal bugs (§23): the case's TGSI (log `sh.text` in `VirglRenderer.finishShader` behind the debug
  trace, for one run), its GLSL from `generate()` in Node, and that GLSL alone in a WebGL2 page on the Mac with
  variants (folded or not, invariant or not): a difference that shows without the emulator is the browser's.

### What the guests do

- Texture data travels through staging buffers (`COPY_TRANSFER3D` in the stream); glcomp and sway send no
  `TRANSFER_*_3D`. sway: 2 submits a frame, its buffers are 3D resources flipped with `SET_SCANOUT` and
  `RESOURCE_FLUSH`; dumb buffers (fbcon, the cursor, pixman) stay 2D. A scrolling foot uploads its whole window each
  frame (3.7 MB at 1376×762: 200 MB/s at 55 frames a second).
- Linux reads both capsets at probe and keeps them: the caps a guest saw at boot are its Mesa's for the session.
- The guest's cost is its kernel: sway's sys time is ~4–5 ms of a 5.5–7.6 ms frame. Over the date loop the machine
  takes 25,700 TLB flushes and 9,300 syscalls a second (mostly the loop's fork and exec).

### Learned (don't re-discover)

- **On SwiftShader the GPU worker stalls ~33 ms after every present** (the canvas commit waits for the GPU process
  to draw; fences queue behind it: 18 ms on the way in, WebGL capped at ~34 frames a second). On the Mac's GPU none.
  `transferToImageBitmap` moved the wait, didn't remove it. Don't judge fence latency on the dev VM.
- Firefox: a fresh profile's first minute is busy (WebExtensions, settings sync failing offline): warm up 30 s before
  measuring. Its WebGL runs in the parent (`CanvasRenderer`), presented through DMABUF. G2's null renderer
  (`?gpu=virgl-null`) can't run Firefox's WebGL page (it never gets ready).
- The guest's `pacman -Syu` rebuilds the initramfs with `autodetect`: keep `MODULES=(virtio_mmio virtio_blk ext4
  vfat)` in its mkinitcpio.conf (images/arch/build.sh sets it in `/etc/mkinitcpio.conf.d/webpc.conf`).
- **A worker's canvas commits a frame at the end of every task that draws**, and Chromium holds those commits to the
  display's rate: draw in `requestAnimationFrame`, once (three draws a guest frame capped sway at 39 frames a second).
- The PC sampler names where a vCPU's current chunk started (the PC is published at chunk ends, which exits cause):
  it ranks exit sites (counter reads, IRQ unmasks, syscall entries), not where time goes.
- `Gpu.save()` is also the tests' state read (`vm.deviceState`): don't throw there; mark and let `vm.snapshot` refuse.
- Playwright's `keyboard.insertText` sends no Enter for a `\n`: paste lines and press Enter (sway-load does). The
  tty's line is 4096 bytes.
- The Mac host's shell is zsh (`status` is read-only) and has no `timeout` (`perl -e 'alarm shift; exec @ARGV' N`).
  The dev VM runs on the same Mac: never measure on both at once.
- QEMU's `virtio-gpu-gl` can't run in the dev VM (no DRM render node): vtest and our own device are the oracles.
- Cap memory on every `node`/`cargo` run; Playwright headless only (WebGL2 there is SwiftShader, whose GL runs on
  the guest's CPUs: real-GPU numbers come from the Mac host).
