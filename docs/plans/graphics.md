# webpc graphics plan: Vulkan

**Status: planned (the user, 2026-10-25): §2's decisions bind; VK0 is next, in the dev VM and on the Mac host.** What exists (virtio-gpu 2D, virgl onto WebGL2, video, snapshots with
3D, G0 to G5) and the decisions that bind it are [docs/graphics.md](../graphics.md); its loose ends are in
[backlog.md](../backlog.md) "Platform and devices". This page is the work ahead: **Vulkan for unmodified guests,
through Mesa's Venus driver, translated onto WebGPU on the host**, starting with a phase that measures what the design
leans on (VK0) before anything is built.

Why now: programs that need Vulkan and ignore our GLES (native Vulkan games, Vulkan-only tools and toolkits) run on the
guest's lavapipe, which is usable but slow, and every vCPU cycle it rasterizes with is one the program's own logic
doesn't get (llvmpipe: 323 ms a compositor frame on 1 vCPU, 71 ms on 4, ~12× native; graphics.md "Guests that
composite with llvmpipe").

## 1. The bar

**Offering Vulkan must make no program slower than it is today.** The guest picks its API from what the device
offers; we can't steer an unmodified guest per program (the guests aren't ours to configure). Today every program
that can use GL draws through virgl, because the device offers nothing else. Once a Vulkan device appears, some switch
on their own. What we know of their defaults (VK0 checks each on the guests' versions):

| Program | With a Vulkan device present |
|---|---|
| **GTK4** (4.16+, Wayland) | **Switches**: Vulkan is GSK's default; today it tries Mesa's virtio ICD, finds no Venus and takes GL (graphics.md "The guest's 3D") |
| **Chromium** | Compositing stays GL (ANGLE); Vulkan on Linux is opt-in. **Its WebGPU (Dawn) needs Vulkan**: new, not a switch |
| **Firefox** | WebRender is GL only. Its WebGPU (wgpu) would use Vulkan: new |
| **KWin, Qt Quick; Mutter; sway (wlroots)** | GL; Vulkan is opt-in (`QSG_RHI_BACKEND`, `WLR_RENDERER`) |
| **mpv / libplacebo** | Likely switches (Vulkan first) |
| **Native Vulkan games and tools** | Vulkan only: the reason for this plan (Proton's DXVK and VKD3D need what §4 doesn't offer) |

So the programs that switch must be **at least as fast on our Vulkan as on virgl**, or Vulkan isn't offered. A
program that finds a feature it requires missing falls back to GL by itself, so what we advertise also chooses who
switches; that's a lever, but a fragile one to tune per program.

This bar is why a software Vulkan driver on the host (lavapipe or SwiftShader built for wasm, behind Venus) lost
(§8): it would take the rasterizing off the guest's vCPUs, but GTK4 and the rest would move from a GPU to a CPU
rasterizer.

## 2. Decisions (the user, 2026-10-25)

- **Venus**, Mesa's upstream virtio-gpu Vulkan driver (in Debian's and Arch's Mesa: the virtio ICD GTK4 already
  probes): no guest patches. Its host side is ours, in the GPU worker beside the virgl renderer.
- **Translated onto WebGPU**, on the real GPU. No software rasterizer, in the guest or on the host.
- **virgl stays the GL path.** The device offers both capsets; VK0 checks that the guest's Mesa still picks virgl for
  GL and not Zink on Venus.
- **The caps follow the browser:** Vulkan only where `navigator.gpu` gives an adapter (macOS and Windows; on Linux
  since Chrome 144 on Intel Gen12+ and 147–148 on NVIDIA: the user's NVIDIA desktop has it with no flags; the dev VM's
  SwiftShader adapter for tests), and only what that
  adapter backs (its optional features: `clip-distances`, `dual-source-blending`, `shader-f16`, subgroups,
  `primitive-index`, the texture-format tiers). A snapshot restored where its caps can't be backed runs without
  Vulkan, as for 3D.
- **A per-machine choice, off by default,** until every program that switches meets the bar (§1); then on by default
  where WebGPU is.
- **A C toolchain for wasm is allowed** (Emscripten or clang with wasi-sdk), for route (b) of §3 or for pieces of
  route (a) such as Tint. Each library it brings in is still checked against THIRD_PARTY.md and gets its row.
- **Realtime mode only**, as for virgl; the vCPU never blocks on the GPU worker.
- **Correctness gate: dEQP-VK** (the same VK-GL-CTS build as the GLES gate, a guest workload), with pass lists in CI as
  `scripts/ci-deqp.sh` has for GLES. **The oracle:** virglrenderer's Venus renderer on lavapipe through vtest in the dev
  VM (Mesa's Venus driver can talk vtest natively, as virpipe does for virgl), so protocol captures and reference
  images come without QEMU (which can't run 3D there: graphics.md "Findings").

## 3. Shape

**The device** (devices.md "virtio-gpu"): the features Venus needs, `CONTEXT_INIT` (Linux 5.16+), `RESOURCE_BLOB`,
`HOST_VISIBLE` (a shared-memory region: the virtio-mmio transport has SHM regions already) and `RESOURCE_UUID`
(`CROSS_DEVICE`), and the Venus capset. Blob resources and the host-visible window are new to the device; virgl's
resources stay guest-backed. The guest writes Venus commands into a ring in shared memory that the host polls, with no
ioctl per submit: cheaper for the guest than virgl's execbuffers (G2 found the kernel's submit path to be virgl's
remaining guest cost).

**The translator**, in the GPU worker, talking to WebGPU. Two routes; VK0's measurements choose:

- **(a) Our own crate in Rust**: a Venus decoder generated from `venus-protocol` (MIT) by a `build.rs`, SPIR-V → WGSL
  through naga (MIT/Apache-2.0; or Tint, C++), Vulkan's objects mapped by hand. Small and ours, the way the virgl
  renderer is; every lowering (combined image-samplers, vertex fetch, geometry) written by us; naga's SPIR-V frontend
  is the least exercised of its frontends (combined image-samplers, which Zink and GTK emit, need
  spirv-webgpu-transform or our own pass).
- **(b) Upstream pieces composed in wasm**: virglrenderer's Venus decoder (`vkr`, MIT) calling a **Mesa Vulkan driver
  whose "hardware" is WebGPU**, built on Mesa's common Vulkan runtime (render passes over dynamic rendering, command
  buffer recording, meta operations, synchronization), `spirv_to_nir` (the most battle-tested SPIR-V frontend there
  is) and NIR's lowering passes: libpoly (Mesa's geometry and tessellation in compute, from Asahi and Honeykrisp, now
  being brought to panvk), transform feedback, vertex pulling, sampler splitting. New code: a NIR → WGSL backend (KosmicKrisp's
  NIR → MSL is the model: Mesa's Vulkan on Metal, at MoltenVK's feature level) and the WebGPU calls. The project's first C/C++ toolchain
  for wasm (allowed, §2) and larger downloads; the libraries are all MIT.

Route (b) is "outside in" with a GPU underneath: start from validated infrastructure and fill in the backend. Route
(a) is less to build at first and more to build for each feature. The choice rests on VK0's C (how much emulation the
programs need) and D (shader coverage).

**Mapping** (both routes): command buffers record and translate at submit (so a whole render pass is visible before
it is encoded: §4 "Render pass breaks"); render passes and dynamic rendering → render passes, subpasses split into
passes with input attachments bound as textures; pipelines → render and compute pipelines, compiled from SPIR-V and
cached by hash; descriptor sets → bind groups, which are immutable in WebGPU, so made at bind time and cached by
content, dynamic offsets as dynamic offsets; at most 4 sets advertised (`maxBindGroups`; GTK4 uses exactly 4), so the
translator's own data rides in immediates, not a fifth group; push constants → immediates (64 bytes on both adapters
measured, bench/gpu/REPORT.md) or a uniform buffer past that; secondary command buffers → render bundles where they
fit; barriers and layouts accepted and ignored (WebGPU tracks hazards); one queue family with graphics, compute and
transfer; fences and semaphores on `onSubmittedWorkDone`.

**Memory:** device-local memory that the host never maps is plain `GPUBuffer`s and `GPUTexture`s. Host-visible memory
is the `HOST_VISIBLE` window in our shared wasm memory outside guest RAM (guest and translator see the same bytes),
with a shadow `GPUBuffer` updated at each submit with the ranges written since: with coherent memory the guest never
says which, but we own the MMU, so the window's pages are write-protected in the TLB and marked dirty on the first
write (a write-watch bit next to the TLB tag bits), uploaded and protected again at a submit; uploading every mapped
range is the fallback. Readbacks: `mapAsync` a staging buffer and copy into the window before the fence is signalled.
The window comes out of the same 4 GiB as guest RAM's memory 0 unless it gets a memory of its own (as spill memories
have: docs/spill-memories.md). WebGPU's proposed UMA buffer mapping would remove a copy where it lands.

**Sync:** a guest `vkWaitForFences` is a call the device completes later, like a slow disk read; the Venus ring polls
on the GPU worker.

## 4. What maps, what's emulated, what isn't offered

| Kind | Vulkan | On WebGPU |
|---|---|---|
| **Direct** | Draws (indexed, instanced, indirect), base vertex, compute, occlusion queries, copies, blits (as draws), mipmaps, BC/ETC2/ASTC where the adapter has them, MSAA at 4 samples, depth bias, stencil, depth clip off | Core WebGPU, or `depth-clip-control` |
| **The adapter's features** | Clip distances, dual-source blending, `shaderFloat16`, subgroups, first instance in indirect draws, timestamp queries, 16-bit normalized formats and read-write storage images | `clip-distances`, `dual-source-blending`, `shader-f16`, `subgroups`, `indirect-first-instance`, `timestamp-query`, `texture-formats-tier1/2` |
| **Shader rewrites** (no extra passes) | Combined image-samplers (split); vertex formats and strides WebGPU lacks (the shader fetches from a storage buffer); push constants; points larger than a pixel (a quad per point, instanced); arrays of textures with constant indices (separate bindings) | At translation, in WGSL |
| **Compute before the pass** | Geometry shaders and tessellation (expand into vertex and index buffers, then draw: libpoly's way); transform feedback (the vertex shader run as compute: WebGPU allows no writable storage in vertex shaders); `vkCmdDrawIndirectCount` (a pass writes the indirect buffer, unused slots as zero-count draws) | A compute pass, its outputs left on the GPU |
| **Copies on the GPU** | Formats WebGPU lacks (3-component, some packed), converted when written; image views that reinterpret a format (WebGPU allows only sRGB variants); memory aliasing between resources | Copy or compute passes: bandwidth, no readback |
| **Not offered** | Sparse resources; 64-bit floats and integers in shaders; logic ops; pipeline statistics queries; sample counts other than 1 and 4; buffer device address and full bindless (until WebGPU's binding arrays exist: DXVK and VKD3D need them); geometry and tessellation until §6's VK3 | |

**Render pass breaks** are the emulation's real cost: WebGPU can't run compute inside a render pass, and ending one
to run a pre-pass, then reopening it, stores and reloads every attachment, expensive on tiled GPUs like the Mac's
(MoltenVK's known tessellation penalty). Because command buffers are translated at submit, the translator sees a whole
render pass and can **run all its pre-passes before it begins**; Vulkan forbids nearly every way one draw could make
input for a later draw in the same render pass, so the hoist is almost always legal. Where it isn't (a draw reading
storage that an earlier draw in the pass wrote, behind a self-dependency barrier), the pass is split.

## 5. VK0: validate and measure

Nothing is built for the guest until VK0 answers. It runs on the user's machine: **the dev VM** (lavapipe, the
oracle, the Profiles layer, our guests, SwiftShader's WebGPU) and **the Mac host it runs on**, which the user allows
agents in the dev VM to use for WebGPU numbers and validation on its M4 (2026-10-25; headless Chromium as
bench/gpu/run-mac.sh does, from a copy in `~/webpc-gpu-bench`; anything else installed there is listed in the report).
The x86_64 desktop stays off limits; a run on the user's NVIDIA desktop is the user's, by hand, from a script we give.
Results go into `bench/vulkan/REPORT.md` with the JSON, under CLAUDE.md's measurement rules (real-GPU numbers from the
Mac; SwiftShader for relative costs and correctness only). The session keeps its notes in `M8-VK0-HANDOVER.md`.

### S. Is it worth it? A whole scene, end to end

The question that can stop the effort: **how much slower is a light but real scene through Vulkan → our translation →
WebGPU in Chromium than through Vulkan on the same GPU natively**, and how it compares with what the guest gets today.
If a whole frame comes out tens of times slower than native, acceleration isn't viable and the plan stops there.

- **The scene**, written by us once (`bench/vulkan/scene/`): the Vulkan counterpart of the WebGL Aquarium. Textured,
  lit fish with per-fish data, alpha-blended plants and bubbles, an environment map, depth, optional 4× MSAA, and the
  Aquarium's fish-count knob (1 to 30,000), so a run sweeps from GPU-light to draw-call-heavy. A second setting is
  toolkit-shaped (many textured quads, few pipelines: GTK4's frame). Written the way Vulkan programs are (descriptor
  sets updated per frame, dynamic uniform offsets, push constants, one render pass a frame), not shaped for WebGPU.
  The Aquarium's own models and textures where its licence allows (BSD, checked into THIRD_PARTY.md), else ours.
- **The arms**, same scene, size and knob settings:
  1. **Native Vulkan on the Mac's GPU** (KosmicKrisp from LunarG's SDK: Vulkan on Metal, itself a thin layer, so a
     slightly generous baseline), and on the user's NVIDIA desktop if they run it.
  2. **WebGPU in Chromium, written as a WebGPU author would**: the cost of WebGPU's model and the browser.
  3. **WebGPU in Chromium, as our translator would emit it**: arm 1's calls recorded with GFXReconstruct, translated
     offline by a throwaway prototype of §3's mapping (SPIR-V → WGSL through naga or Tint, descriptor sets → bind
     groups made and cached as §3 says, render passes as recorded, push constants as immediates) and replayed by a
     page with the per-call work our translator would do at run time. The step 2 → 3 is the translation's own cost,
     and the prototype is §3's mapping's first contact with a real program.
  4. **What the guest has now**, on our machine on the Mac's GPU: the scene on the guest's lavapipe (Vulkan today),
     and a GLES port of it on virgl (what Vulkan competes with; the WebGL Aquarium in the guest's Firefox and in the
     host's Chromium as a cross-check).
  5. **lavapipe natively in the dev VM**: relates arm 4's lavapipe to its native speed.
- **Measured:** frame time medians and IQR at fixed fish counts (1, 100, 1,000, 10,000, 30,000), the count at which
  each arm falls below 60 frames a second, the host's CPU per frame (the page's worker and the GPU process), GPU time
  where timestamp queries exist, draws and bytes uploaded per frame.
- **Not measured here:** the guest's cost of encoding Venus (no device yet). Estimated from B's bytes and commands per
  frame and virgl's measured guest cost per submit (graphics.md "Measurements"), stated as an estimate; VK1's gate
  measures it.
- **Order:** arms 1, 2, 4 and 5 first (no prototype needed): if arm 2 alone is far off native, stop and report. Arm 3
  after D and E have shaped the prototype.

### The other questions

- **A. Who accepts which Vulkan.** Khronos's Profiles layer (`VK_LAYER_KHRONOS_profiles`, Apache-2.0, a dev-only
  tool) makes a real driver advertise only a chosen profile. Write the profile of §4's direct and feature-gated rows
  (the Mac's adapter, then SwiftShader's), run the programs of §1 on lavapipe through it natively in the dev VM
  (GTK4's gtk4-demo, Chromium with Vulkan on and with WebGPU, Firefox's WebGPU, mpv, sway with `WLR_RENDERER=vulkan`,
  vkcube, vkmark, a few native Vulkan games), and record who takes Vulkan, who falls back, and the feature that
  decided it. Then add each emulated row and see who it brings. *Settles:* the order of §6's VK3, whether the bar can
  hold (who switches), and whether the GTK4 lever is needed. Also: whether the guest's Mesa picks Zink over Venus for
  GL when both capsets exist (in vtest).
- **B. The Venus stream.** The oracle (vtest, Venus on lavapipe) with a capture patch like virgl's: commands, bytes
  and replies per frame for S's scene, vkcube, GTK4 and a game; how much host-visible memory each maps and writes per
  frame. *Settles:* the write-watch's worth (versus uploading every mapped range), the ring's sizing, the decoder's
  scope, and S's estimate of the guest's cost.
- **C. Render passes and compute, in Chromium.** A bench page (bench/gpu/) on the Mac's M4 and SwiftShader, and the
  user's NVIDIA desktop if they run it: (1) one render pass split into N with store and load, at 1080p and 1440p, with
  depth, with and without 4× MSAA (the resolve too); (2) a compute pass writing a vertex buffer the next render pass
  draws (the geometry pattern), interleaved between draws against hoisted before the pass; (3) transient attachments
  where Chromium has them; (4) libpoly-style geometry expansion and a tessellation pre-pass against the same
  primitives drawn directly; (5) S's scene with fish drawn through a geometry-shader pre-pass, to see the cost in a
  frame and not only in isolation. *Settles:* how many breaks a frame affords, whether hoisting is required or just
  better, what geometry and tessellation cost.
- **D. Shaders.** SPIR-V from S's scene and A's programs (a capture layer or their pipeline caches) through naga,
  through spirv-webgpu-transform + naga, through Tint, and through `spirv_to_nir` (route b's frontend, natively): how
  many translate, how long each takes in wasm, and what `createShaderModule` and pipeline creation then cost in
  Chromium (Tint → MSL → Metal on the Mac: Vulkan programs make many pipelines). *Settles:* route (a) or (b), and
  whether pipelines need a persistent cache of ours.
- **E. Per-draw overhead.** A page issuing Vulkan-shaped work through WebGPU: thousands of draws a frame with a bind
  group made per draw against cached, dynamic offsets, immediates, render bundles; WebGPU calls from wasm against from
  JS. *Settles:* the descriptor mapping and the draw rate a frame can carry (S's high fish counts are this case).
- **F. Uploads.** `writeBuffer` from the shared window (Chrome 144 made it up to 2× faster) at B's per-frame sizes,
  and the TLB write-watch's cost on the guest side (a prototype in the core's TLB, measured on a guest that writes
  mapped memory). *Settles:* §3's memory design.
- **G. The bar's baseline.** GTK4's gtk4-demo and mpv on virgl today (frame times, guest CPU; `bench/gpu/gtk4-load.ts`)
  on the Mac host, so each switching program has a number to meet.

**Tools to install** (dev-only unless VK1 needs them; each noted in CLAUDE.md's development environment when added):
in the dev VM, lavapipe and the Vulkan tools and validation layers from zypper, glslc or glslang, GFXReconstruct and
the Profiles layer (from source if not packaged), virglrenderer with Venus and Mesa's Venus driver built natively for
the oracle (as `tools/virgl-oracle/` does for virgl), naga's CLI, Tint, and the wasm C toolchain; on the Mac, only
what the native arm needs (the user's OK pending, §9).

**Exit:** `bench/vulkan/REPORT.md` with S's ratios (arm 3 against arm 1, and against arm 4's lavapipe and virgl), the
route chosen, the advertised set and its emulation order, the render-pass rule, and whether the bar looks reachable
for the programs that switch. The user decides whether VK1 starts.

## 6. After VK0 (sketch; VK0 revises it)

- **VK1, the device and a null renderer:** the features, blob resources, the window and the Venus capset; a null
  Venus renderer that answers what must be answered and draws nothing. *Gate (as G2's for virgl):* vkcube's and
  GTK4's frames cost the guest no more than on virgl.
- **VK2, core translation:** vkcube, vkmark, GTK4 on Vulkan drawing right on SwiftShader and the Mac; the dEQP-VK
  subset of the direct rows as pass lists. *Gate:* GTK4 meets the bar (§5 G).
- **VK3, emulation in A's order:** each layer a translation pass with its dEQP-VK groups as its gate and C's rules
  applied.
- **VK4, breadth and the default:** the programs of A, snapshots while Vulkan is in use (state as data, as for virgl:
  objects, device memory and the window read back), on by default where every switching program meets the bar.

## 7. Risks

- **Venus leans on host-driver behavior beyond the spec** (Mesa's docs say it violates the spec in places and relies
  on implementation-defined behavior, and the renderer assumes host-visible memory can be exported as a mappable
  dma-buf). We are the host driver, so we can choose those behaviors, but they must be found first: B's captures and
  reading `vkr`.
- **Pipeline creation stalls.** Each Vulkan pipeline becomes a WGSL module and a WebGPU pipeline compiled by Chromium's
  Tint and the platform's compiler; D measures it, and a cache across sessions may be needed.
- **WebGPU's validation and per-call cost** in Chromium (every call crosses to the GPU process) may cap the draw rate
  below what games want (E).
- **Adapters differ** (limits, features, formats, precision), as WebGL2 stacks did for dEQP-GLES: the caps per
  adapter, and dEQP-VK on more than SwiftShader and Metal.
- **The 4 GiB budget**: the host-visible window shares it with guest RAM and the core's heap unless it gets a memory
  of its own.

## 8. Alternatives considered

- **A software Vulkan driver on the host** (2026-10-25: lavapipe or SwiftShader built for wasm, behind Venus).
  Attractive: shaders as wasm SIMD instead of emulated NEON (an estimated 1.3–2.5× native against ~12–17× under
  emulation, unmeasured), the rasterizing off the guest's vCPUs, a conformant feature set, and host-visible memory that
  is simply the rasterizer's own bytes (no write tracking). Lost on §1's bar: the programs that switch to Vulkan would
  leave virgl's GPU for a CPU rasterizer. Its hard parts too: llvmpipe's LLVM JIT can't run in wasm (ship LLVM and its
  wasm backend, or write a NIR → wasm backend; SwiftShader's Reactor, with a Subzero backend, is the narrower seam),
  and it competes with the vCPU workers for the host's cores. Kept as a fallback for pages without WebGPU only if a
  user asks.
- **A hybrid: a software driver that hands parts of its work to WebGL2 or WebGPU.** Lost: work split between the CPU
  and the GPU crosses between them at every dependency, and readbacks in a browser are asynchronous and slow; Mesa's
  old drivers' per-feature software fallbacks were performance cliffs for the same reason. The workable form is
  choosing a backend per device, not per draw.
- **Software rasterization on the GPU**: Vulkan's whole pipeline written in WebGPU compute (the semantics ours, any
  feature emulable), as research rasterizers in CUDA have done within a few times of fixed-function hardware. A
  research project: WebGPU lacks 64-bit atomics (a depth test and its payload in one `atomicMax`, proposed for
  WebGPU), and it still needs SPIR-V → WGSL. §4's compute pre-passes take the useful part of it.
- **Venus onto WebGL2**: no compute, no storage buffers in WebGL2; nothing Vulkan programs need beyond GLES maps.
- **WebGPU passthrough for guest programs** written against WebGPU (wgpu, Dawn: Dawn's wire protocol is already a
  serialized WebGPU): a guest-side client library and a virtio-gpu context type of our own, with no upstream guest
  support. Demos, not a graphics stack.

## 9. Open questions for the user

Asked 2026-10-25, before VK0 starts:
- **The stop line:** which whole-frame ratio in S stops the effort, and against which arm (native Vulkan, the guest's
  lavapipe, virgl's GLES port).
- **The Mac host:** whether the native arm may install LunarG's Vulkan SDK (KosmicKrisp) and the Xcode command-line
  tools there, or the native baseline comes only from the user's NVIDIA desktop.
- **The NVIDIA desktop:** whether the user will run a script by hand there (the native arm and the Chromium pages).
- **Check-ins:** whether VK0 stops for the user after S's first arms, or runs through to its report.

## Sources

Venus's requirements: [Mesa's Venus docs](https://docs.mesa3d.org/drivers/venus.html). WebGPU in Chromium:
[Chrome 144](https://developer.chrome.com/blog/new-in-webgpu-144) (Linux), [142](https://developer.chrome.com/blog/new-in-webgpu-142)
(texture-format tiers, primitive index), [149–150](https://developer.chrome.com/blog/new-in-webgpu-149-150) (immediates),
[151–152](https://developer.chrome.com/blog/new-in-webgpu-151-152), [what's next](https://developer.chrome.com/blog/next-for-webgpu)
(bindless, multi-draw indirect, 64-bit atomics, UMA mapping: proposed); multi-draw indirect is still
`chromium-experimental-multi-draw-indirect`. Geometry and tessellation in compute: [libpoly in panvk
(FOSDEM)](https://fosdem.org/schedule/event/KZUJ9X-geometry_shaders_in_panvk_with_libpoly). Vulkan on Metal in Mesa:
[KosmicKrisp (XDC 2025)](https://www.lunarg.com/wp-content/uploads/2025/10/XDC-2025-KosmicKrisp-Overview.pdf). The
[Profiles layer](https://vulkan.lunarg.com/doc/view/latest/mac/profiles_layer.html) (only lowers what a driver has).
GTK4's Vulkan use: `gdk/gdkvulkancontext.c` (instance at Vulkan 1.3; dmabufs, YCbCr, timeline semaphores optional) and
`gsk/gpu/gskvulkandevice.c` (4 descriptor sets, arrays of 3 combined image-samplers, a dynamic uniform buffer, no push
constants). No Vulkan-on-WebGPU layer was found (2026-10-25). KosmicKrisp ships in LunarG's Vulkan SDK for macOS
(1.4.357, 2026-07-28: [the release](https://lunarg.com/lunarg-releases-vulkan-sdk-1-4-357-0/)), conformant on Metal 4.
Recording and replaying Vulkan calls: [GFXReconstruct](https://github.com/LunarG/gfxreconstruct) (MIT).
