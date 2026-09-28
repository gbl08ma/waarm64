# webpc graphics plan

**Status:** preliminary exploration, drafted 2026-09-27; not scheduled, and nothing here is decided
until the user confirms it. When a step here is scheduled, move it into PLAN.md and keep this file
as the background it came from.

The question: how does a guest get a real display (mode setting, damage, a cursor) and, later,
**hardware-accelerated 3D** in a browser page, without the guest knowing it runs in one? Today the
guest has a `simple-framebuffer` (M4 step 6, PLAN.md §2 "Step 6 devices"): a fixed-size x8r8g8b8
region in guest RAM that `web/display.ts` copies to a `<canvas>` on every animation frame, whether
it changed or not (PLAN.md §7 M9, "Framebuffer"). The only 3D a guest can do is Mesa's software
renderers (llvmpipe, lavapipe) on our emulated CPU.

## 1. Proposed decisions

- **virtio-gpu is the display device**, first 2D, then 3D over the same device. The guest drivers
  are upstream (`DRM_VIRTIO_GPU` in Linux, Mesa's Venus in userspace), so the guest needs no
  patches, and 2D alone already fixes today's gaps: mode setting (the canvas size follows the
  page), damage rectangles, a hardware cursor, EDID. `simple-framebuffer` stays for boot tests and
  guests without the driver.
- **3D: Vulkan in the guest, WebGPU in the page, translated on the host side.** The guest runs
  Mesa's **Venus** driver, which serializes Vulkan calls over virtio-gpu (a "context" of capset
  Venus). On native hosts, virglrenderer replays that stream on the host's Vulkan. We would write
  the replay side as a **Venus → WebGPU translator** in its own worker. OpenGL in the guest comes
  from Mesa's **Zink** (GL on Vulkan) over Venus, so there's one protocol to implement, not two.
- **Translate on the host, not in the guest.** A Vulkan driver inside the guest that emits
  WebGPU-shaped commands would run under emulation, at JIT speed. On the host the translator is
  native wasm, and it can block the guest's fence waits on WebGPU's async completion (§4.4).
- **Target a small, honest Vulkan**: roughly Vulkan 1.1 with only the features WebGPU can back,
  non-conformant but never lying in its feature bits (§4.2). Apps that need Vulkan 1.3-class
  features (DXVK, VKD3D-Proton) are out of scope, and that's accepted.
- **A software baseline comes before any GPU work** (G2): llvmpipe/lavapipe in the guest on
  virtio-gpu 2D. It works as soon as 2D works, it's the bar the WebGPU path has to beat, and its
  images are the reference for tests.
- **A decision gate after the first frame** (G3): if Venus's memory model makes the translator
  too slow or too complex, stop and reconsider the alternatives in §2.
- Chromium only, as everywhere in the project. WebGPU ships in Chromium (Linux, macOS, Windows,
  ChromeOS). The graphics path doesn't block the Firefox/Safari pass in M8; a page without WebGPU
  falls back to 2D plus the software baseline.

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
  translating TGSI and emulating desktop GL on a GLES-level API. Rejected in favor of Zink on
  Venus, unless G3 fails.
- **gfxstream** (Google, Apache-2.0; Android emulator, now also in crosvm and Mesa): serializes
  Vulkan, and also GLES in the Android emulator. Its **GLES** stream against **WebGL2** (≈ GLES
  3.0) would be a much closer mapping than Vulkan against WebGPU. That makes it the main
  alternative at the G3 gate. How usable its guest-side GLES is on a Linux guest is unknown (§8).
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
- **crosvm's `rutabaga_gfx`** (BSD-3, already a reference in PLAN.md §6): the virtio-gpu device
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

## 4. 3D: Venus on WebGPU

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
  guest RAM (layout A, PLAN.md §7 M0.5), so its size is a VM config choice (e.g. 256 MiB).
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
- **3D runs in realtime mode only**, like networking (PLAN-NETWORKING N4). Deterministic tests
  stop at 2D and at the protocol level (§6).
- SMP (M7) changes nothing here: the guest's threads all end up in the same virtqueues.

## 5. Later, and alternatives kept open

- **WebGPU passthrough for guest programs.** A guest app written against WebGPU (wgpu, Dawn)
  could have its calls forwarded almost 1:1 to the page, since Dawn's wire protocol is already a
  serialized WebGPU. That would need a guest-side client library and our own virtio-gpu context
  type, with no upstream guest support. Interesting for demos; not a general graphics stack.
- **gfxstream GLES → WebGL2**, if G3 shows that Venus → WebGPU is too costly and GL is what
  users need most (§2).
- **Video decode** (virtio-video or VA-API over Venus) via WebCodecs: far later.
- **Tessellation, geometry shaders, transform feedback** as compute pre-passes, MoltenVK-style,
  only if Zink's GL version or a real workload requires them.

## 6. Testing (PLAN.md §4)

- **2D:** byte-exact, deterministic, natively and in Chromium: a guest script draws through KMS
  (a dumb buffer with damage, a cursor), and the test reads the canvas back, as
  `/test-devices.sh` does for `/dev/fb0` today.
- **Translator unit tests natively**: decode recorded Venus streams (captured once from a real
  guest) into calls on the recording `Gpu` mock; shader translation of a SPIR-V corpus (what Zink
  and the Vulkan CTS emit) through naga, validated.
- **In Chromium:** the guest runs a subset of the Vulkan CTS (dEQP-VK, Apache-2.0: a guest
  workload, not copied code), and images are compared with lavapipe's (G2), with a tolerance,
  since GPUs aren't bit-exact. The subset grows with the advertised features.
- **No GPU in the dev VM.** Chromium there needs a software WebGPU adapter (SwiftShader, or Dawn
  on Mesa's lavapipe): which flags work headless is for G0 to find out. Real-GPU numbers need
  Chromium on a machine with a GPU (§8).
- Benchmarks: vkcube, vkmark and glmark2 in the guest, frame times in `bench/`, each against the
  software baseline.

## 7. Steps

Each step comes with tests at the cheapest layer that catches it (PLAN.md §4).

- **G0 — WebGPU environment spike, measured.** Get a WebGPU adapter in headless Chromium in the
  dev VM (software), and record the adapter's features and limits. Check `writeBuffer` from a
  `SharedArrayBuffer`-backed view and its cost at scanout sizes. Check `OffscreenCanvas` +
  WebGPU in a worker. Decide how real-GPU numbers are taken (§8).
- **G1 — virtio-gpu 2D** (§3): device, backend, `OffscreenCanvas` presentation, resize, cursor,
  EDID; the Buildroot kernel with `DRM_VIRTIO_GPU`; byte-exact tests natively and in Chromium.
  Close the M9 framebuffer item.
- **G2 — Software baseline:** llvmpipe/lavapipe in a guest image (Alpine, e.g. `mesa-dri-gallium`,
  `mesa-vulkan-swrast`; a small Wayland compositor such as `cage`), vkcube and glmark2 numbers
  under the M6 JIT. Also the reference images for later tests.
- **G3 — Venus first frame (decision gate).** The virtio-gpu 3D features (`CONTEXT_INIT`,
  `HOSTMEM`, blob resources, the Venus capset), the `HOSTMEM` window, the GPU worker, and a
  translator that gets `vulkaninfo` and vkcube's first frame onto the canvas. Measure submit
  latency and frame time against G2. Then decide: continue (G4), switch to the gfxstream GLES
  path, or stop at G2.
- **G4 — Translator breadth:** the §4.2 table filled in, dirty-page tracking for coherent memory
  (§4.3, measured against uploading everything), pipeline and shader caches, a growing dEQP-VK
  subset.
- **G5 — OpenGL through Zink** on Venus; which GL/GLES version Zink reaches on our feature set;
  glmark2 and a desktop session (a Wayland compositor with a browser or a terminal) as the smoke
  test.
- **G6 — Performance** (profiles of the translator and the GPU worker; batching of Venus calls),
  and the product surface with M8 (a GPU on/off switch, fallback when WebGPU is missing).

## 8. Open questions

- **Which GL does Zink reach on what we can advertise?** Transform feedback (GL 3.0) and geometry
  shaders (3.2) aren't in WebGPU. If Zink needs them for anything above GLES 2/GL 2.1, either
  the compute pre-passes (§5) move earlier or GL goes through gfxstream/WebGL2.
- **Venus's assumptions about host-visible memory** (Mesa's docs: "illegal" but relied on): what
  exactly the renderer expects, and whether our shadow-buffer model (§4.3) satisfies it.
- **gfxstream's GLES guest side on Linux:** packaged, buildable in `images/`, maintained?
- **Real-GPU measurements:** the dev VM has no GPU. Options: Chromium on the Mac host (outside
  the VM; only with the user's OK, since it's their machine), or another machine. Software-adapter
  numbers from the VM are for correctness only.
- **naga vs Tint** for SPIR-V → WGSL: naga fits our Rust toolchain; Tint covers more SPIR-V.
  Decide in G3 on Zink's and vkcube's shaders.
- **Where virtio-gpu's queues are served** once 3D is on: the device worker forwarding to the GPU
  worker (proposed), or the GPU worker owning the whole device.
- **Security:** the translator parses untrusted guest data, and WebGPU validates everything it's
  given, so the worst case should be a lost device, not a page compromise. Fuzz the Venus decoder
  like the virtqueue parser (`core/fuzz`).
