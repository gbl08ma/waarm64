# webpc graphics plan

**Status:** G0 to G5 are done (2026-10-01 to 2026-10-19): virtio-gpu 2D, virgl's guest side measured, our virgl
renderer on WebGL2 as the page's default where WebGL2 is, Firefox and GTK4 on it, dEQP's whole GLES2 and GLES3 lists
passing (on SwiftShader; on the Mac's GPU every failure left is the GPU's), snapshots while 3D is in use. **What exists,
how it works and what was learned is [docs/graphics.md](../graphics.md)**; the device is [devices.md](../devices.md)
"virtio-gpu" and "virgl", video over virgl [video.md](video.md), the loose ends [backlog.md](../backlog.md). This page
keeps the decisions that bind the work and what is still open. Each loop's journal (G0 to G5, the reviews and fixes
up to 2026-10-24) is in git history before this page was cut down.

## 1. Decisions

- **virtio-gpu is the display device**, 2D and 3D over the same device, with the guests' upstream drivers: no guest
  patches. `simple-framebuffer` stays for boot tests and guests without the driver.
- **No translation layer and no software rendering in the guest** (the user, 2026-10-09). The guest's CPU is the
  scarcest thing the machine has: llvmpipe takes 71 ms a compositor frame on 4 vCPUs even after the JIT's NEON work,
  and Zink (GL on Vulkan) would be another layer of Mesa under emulation. The guest runs a thin driver that
  serializes; the work happens on the host.
- **3D is OpenGL ES through Mesa's virgl driver, rendered by our own virgl renderer on WebGL2.** virglrenderer (MIT)
  is the reference (ported from with attribution where it helps, THIRD_PARTY.md); the guest gets what virglrenderer
  gives on a GLES 3.0 host, GLES 3.0 and desktop GL 2.1.
- **WebGL2 is the baseline; WebGPU an optional backend** for the same protocol, only where `navigator.gpu` gives an
  adapter (often missing on Linux), which could advertise more (GLES 3.1: compute, storage buffers). A page without
  WebGL2 offers 2D only.
- **The caps follow the browser**: never more than the renderer backs there (a snapshot restored where its caps can't
  be backed runs with 3D off).
- **virgl's resources are guest-backed**: no `HOSTMEM` window, blob resources or coherent-memory tracking.
- **3D is the page's default where WebGL2 is**, with the Machine menu's Graphics choice; the 2D path stays and stays
  tested (`?gpu=2d`, `WEBPC_PAGE_QUERY=gpu=2d scripts/ci-debian.sh`).
- **Vulkan is deferred**: Venus onto WebGPU (§3) only if Vulkan programs are asked for, and only on the WebGPU backend.
- **Snapshots while 3D is in use save the renderer's state as data** (objects decoded, contents read back), never a
  replay of the commands; refused only while a video decodes.
- **Tests:** 2D is byte-exact in deterministic mode (natively, in Node and in Chromium, with its own guest and kernel
  variant so no other step count moved); 3D runs in realtime mode only, tested at the protocol level in Node and on
  WebGL2 in Chromium; **dEQP's pass lists are the correctness gate** (`scripts/ci-deqp.sh`, for every change that
  touches 3D).
- **Guest pixels are CSS pixels by default**, scaled up crisply, with a HiDPI setting that sends device pixels and the
  physical size in the EDID. Live resize is a guest agent's job, starting from the stock agents ([agent.md](agent.md)).
- **Real-GPU numbers come from headless Chromium on the Mac host** (the bench pages and `bench/gpu/sway-mac.sh`);
  nothing else on that host, and the x86_64 desktop stays off limits.
- Chromium only, as everywhere in the project. Out of scope: multiple scanouts, ACPI.

**Why virgl and not Venus:** the first draft (2026-09-27) chose Venus on WebGPU for Vulkan and Zink over Venus for GL,
one protocol for both, and rejected virgl because it means translating TGSI and emulating desktop GL on a GLES-level
API. G1 and the JIT rounds showed that the guest's CPU decides everything (and Zink is a translation layer in the
guest), WebGL2 is far more widely available than WebGPU, and virglrenderer already runs on GLES hosts, so desktop GL on
GLES is a known, bounded problem, and the guest asks only for what the caps advertise. G2 confirmed it: a sway frame on
virgl costs the guest ~1/12 of llvmpipe's.

## 2. What's open

- **A KDE desktop's session** (the report of 2026-10-24: occlusion queries held every fence, draws refused as feedback
  loops; both fixed, docs/graphics.md "Queries", "Feedback loops"): run KDE Plasma on the desktop guest to see what
  else it asks for, and measure what the feedback copies cost there (a copy at every such draw, no write tracking).
- **G5's leftovers** (docs/backlog.md "Platform and devices"): dEQP on more WebGL2 stacks (Windows' D3D11 first, then
  NVIDIA on Linux, a phone, integrated GPUs), ideally through a dEQP runner page anyone can open; GtkGLArea's offload
  (a Mesa bug in the guest, or caps without `COPY_TRANSFER_BOTH_DIRECTIONS`: measure Firefox and GTK first); Chromium
  in the guest's rare one-frame step back; llvmpipe's stale frames on 2D (a display mode that samples the scanout).
- **Breadth, if the user wants it:** KWin and Mutter sessions, Xorg, GNOME and KDE's behavior at a display event
  (live resize).
- **Security:** the renderer parses untrusted guest data (WebGL validates what it is given); fuzz the stream's decoder
  as the device's commands and the virtqueue parser are.
- **Beyond GLES 3.0 on WebGL2:** desktop GL 3.0 and 3.1 need what WebGL2 lacks or has only as extensions:
  `gl_ClipDistance` (`WEBGL_clip_cull_distance`), depth clamp (`EXT_depth_clamp`), conditional rendering, the sRGB
  framebuffer switch, texture buffers, base vertex (`WEBGL_draw_instanced_base_vertex_base_instance`). Caps that
  follow each extension, where a workload needs one. Geometry and tessellation exist in neither WebGL2 nor WebGPU, so
  desktop GL above 3.1 isn't reachable honestly (compute pre-passes, MoltenVK-style, on the WebGPU backend only if a
  real workload needs them).
- **Later:** the WebGPU backend (GLES 3.1); Vulkan through Venus on it (§3).

## 3. Vulkan: Venus on WebGPU (deferred design)

Kept for if Vulkan is asked for. What exists elsewhere (2026-09-27): Vulkan on a more restrictive API has been done
(MoltenVK on Metal, Mesa's Dozen on D3D12: translate the common core, emulate the awkward parts, don't advertise the
rest); WebGPU is roughly the intersection of Vulkan, Metal and D3D12, a further step down; **no Vulkan-on-WebGPU layer
was found** (wgpu and Dawn go the other way). Venus (renderer in virglrenderer, MIT; protocol in `venus-protocol`)
needs the virtio-gpu features `CONTEXT_INIT`, `HOSTMEM`, `RESOURCE_UUID` and `BLOB_RESOURCES` and the Venus capset;
`HOSTMEM` is a shared window (256 MiB to 8 GiB on QEMU) where host-visible `VkDeviceMemory` is mapped into the guest,
and Mesa's docs say virglrenderer relies on host drivers' behavior there beyond the spec.

- **Shape:** a separate wasm module in the GPU worker (Rust, its own crate: naga is Rust, and the Venus decoder can be
  generated from `venus-protocol` by a `build.rs`), talking to WebGPU through a small `Gpu` trait (JS imports in wasm,
  a recording mock natively). Dependencies to approve first: naga (SPIR-V → WGSL; no combined image-samplers, which
  Zink emits, and extra spills, gfx-rs/wgpu#6670), perhaps spirv-webgpu-transform; Tint reads SPIR-V too but is C++.
- **What to advertise:** map what maps (command buffers, render passes, pipelines, descriptor sets → bind groups),
  accept and ignore barriers and layouts (WebGPU tracks hazards), SPIR-V through naga cached by hash, push constants as
  immediates (Chromium 149+, 64 bytes on both adapters measured) or a uniform buffer, one queue with fences on
  `onSubmittedWorkDone`; don't advertise memory aliasing, sparse, buffer device address, full descriptor indexing
  (which rules out DXVK and VKD3D), geometry, tessellation, transform feedback; 64-bit types and formats per the
  adapter.
- **Memory:** the `HOSTMEM` window in our shared wasm memory outside guest RAM (guest and translator see the same
  bytes: the one place emulation is better placed than a native VMM; it comes out of the same 4 GiB budget). GPU-used
  host-visible memory needs a shadow `GPUBuffer` updated at each submit with the ranges written since; with coherent
  memory the guest never says which, but we own the MMU: write-protect the window's pages in the TLB, mark dirty on
  the first write, upload and protect again at a submit (a write-watch bit next to the TLB tag bits; uploading every
  mapped range is the fallback). Readbacks: `mapAsync` a staging buffer and copy into the window before the fence is
  signalled.
- **Sync:** a guest `vkWaitForFences` is a call the device completes later, like a slow disk read; the vCPU never
  blocks on the GPU worker; the Venus ring polls on the GPU worker. Realtime mode only.

## 4. Alternatives kept open

- **A GLES passthrough library in the guest** (our own `libEGL`/`libGLESv2` forwarding GLES calls, as the Android
  emulator's do for gfxstream): the closest mapping onto WebGL2, GLSL ES untouched. Not taken: the guests aren't ours
  to modify (users bring unmodified images), it would have to integrate where Mesa already does (GBM and dma-bufs, EGL
  on Wayland and X11, GLX for Xwayland, glvnd), and G2 showed Mesa's frontend is cheap: the guest's remaining cost is
  the kernel's submit path, which a library would go through too. gfxstream's own GLES guest side targets Android, and
  Mesa's gfxstream driver is Vulkan only.
- **WebGPU passthrough for guest programs** written against WebGPU (wgpu, Dawn: Dawn's wire protocol is already a
  serialized WebGPU): a guest-side client library and a virtio-gpu context type of our own, with no upstream guest
  support. Demos, not a graphics stack.
