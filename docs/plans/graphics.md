# webpc graphics plan

**Status:** preliminary exploration, drafted 2026-09-27; not scheduled, and nothing here is decided
until the user confirms it. When a step here is scheduled, move it into PLAN.md and keep this file
as the background it came from.

The question: how does a guest get a real display (mode setting, damage, a cursor) and, later,
**hardware-accelerated 3D** in a browser page, without the guest knowing it runs in one? Today the
guest has a `simple-framebuffer` (`docs/devices.md` "Framebuffer"): a fixed-size x8r8g8b8
region in guest RAM that `web/display.ts` copies to a `<canvas>` on every animation frame, whether
it changed or not (`docs/backlog.md`, "Framebuffer"). The only 3D a guest can do is Mesa's software
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
  ChromeOS). The graphics path doesn't block a later Firefox/Safari pass; a page without WebGPU
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

- **WebGPU passthrough for guest programs.** A guest app written against WebGPU (wgpu, Dawn)
  could have its calls forwarded almost 1:1 to the page, since Dawn's wire protocol is already a
  serialized WebGPU. That would need a guest-side client library and our own virtio-gpu context
  type, with no upstream guest support. Interesting for demos; not a general graphics stack.
- **gfxstream GLES → WebGL2**, if G3 shows that Venus → WebGPU is too costly and GL is what
  users need most (§2).
- **Video decode** (virtio-video or VA-API over Venus) via WebCodecs: far later.
- **Tessellation, geometry shaders, transform feedback** as compute pre-passes, MoltenVK-style,
  only if Zink's GL version or a real workload requires them.

## 6. Testing (`docs/testing.md`)

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

Each step comes with tests at the cheapest layer that catches it (`docs/testing.md`).

- **G0 — WebGPU environment spike, measured (done: §10).** Get a WebGPU adapter in headless Chromium in the
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
  is blk off that thread (asynchronous reads; backlog), also what G3's 3D worker will want.
- **The firmware's keys stay on the serial terminal**: the page's GRUB menu is graphical (`gfxterm`
  takes the GOP) and appears on the screen only; EDK2 has no virtio-input keyboard. `?display=simple` keeps
  the old serial menus for tests (page-uefi-keys) and as a fallback.

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
  `tests/page-grub-screen.test.ts` presses `c` on the screen during GRUB's countdown. A real EDK2 keyboard
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
  worker, ~5%) runs the guest's DRM commits, which is the core the user saw. The knobs are the page's
  `?gpu=eager|lazy|pace|q<N>` (default `lazy,pace,q16`; the tests' guests stay eager and queue 64, so their bytes
  and step counts don't move).
