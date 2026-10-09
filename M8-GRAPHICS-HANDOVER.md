# M8 graphics, 3D: handover (2026-10-09)

For the session that takes graphics on from virtio-gpu 2D to acceleration. The plan is
[docs/plans/graphics.md](docs/plans/graphics.md): §1 is the direction as revised today, §7 the steps,
§8 the open questions, §18 what was measured for the direction. How the 2D device works is in
docs/devices.md "virtio-gpu" and docs/frontend.md "The screen". **G2 isn't scheduled until the user
writes its kickoff.** Below is the proposal for it, the questions to put to the user first, and what to
know before touching anything.

## Where it stands

- **2D is done (G0, G1, 2026-10-02):** `web/gpu.ts` (the backend in the device worker), `web/gpu-present.ts`,
  `web/edid.ts`, the native twin `core/tests/common/gpu.rs`, the `linux-gpu` test guest, Debian on the page
  from EDK2's GOP to a desktop. Presentation is canvas 2D in the device worker; flushes are paced at 60 Hz
  (graphics.md §16).
- **llvmpipe got much faster, and it still isn't enough** (`bench/boot/REPORT.md` "M8: llvmpipe" and "M8: vector
  registers in locals"; `gl_llvmpipe_jit`/`_4`, the workload `images/alpine/gl/glcomp.c`, a compositor's GLES2
  frame at 1376×762):

  | ms a frame, Chromium, dev VM | before the NEON work | NEON inline | + V regs in locals | native |
  |---|---|---|---|---|
  | 1 vCPU, rasterizing on the calling thread | 6,936 | 445 | 323 | 26.6 |
  | 4 vCPUs, 4 rasterizer threads | 1,859 | 100 | 71 | 7.4 |

  That is ~14 frames a second with every vCPU saturated, about 12× native. Guest CPU is the constraint.
- **The direction (the user, 2026-10-09; graphics.md §1):**
  - no software rendering and no translation layers (llvmpipe, Zink) in the guest;
  - **OpenGL ES first, through Mesa's upstream virgl driver**, onto **our own virgl renderer on WebGL2**;
  - WebGL2 is the baseline because it is far more widely available than WebGPU, which Chromium on Linux often
    lacks;
  - a WebGPU backend only where `navigator.gpu` exists;
  - Vulkan (Venus on WebGPU, graphics.md §4) deferred.
- **Measured today for it** (graphics.md §18):
  - **Versions:** virglrenderer on a GLES 3.0 host (`MESA_GLES_VERSION_OVERRIDE=3.0`, about what WebGL2 is)
    gives the client **GLES 3.0 and desktop GL 2.1** (no core profile).
  - **Pixels:** glcomp's pixel hash through virgl equals llvmpipe's own (`a26ac0b1`).
  - **Client CPU:** ~83 µs a frame natively, against 24.6 ms for llvmpipe on one thread (~300× less).
  - Caveat: vtest has no guest kernel in the path and no JIT factor, so this is the guest side's lower bound.
    G2's first job is the real number.
- **From the kernel's source** (Linux 6.18, `drivers/gpu/drm/virtio/`, read today):
  - **Dumb buffers stay 2D resources with virgl on** (`RESOURCE_CREATE_2D`, `TRANSFER_TO_HOST_2D`;
    `virtio_gpu_mode_dumb_create` never sets `params.virgl`). fbcon, the cursor and pixman compositors keep
    G1's path unchanged.
  - **A GL compositor's buffer is a 3D resource** that is flipped with `SET_SCANOUT` + `RESOURCE_FLUSH` only:
    no transfer, and no plane fence unless dumb or imported (`virtgpu_plane.c`). It travels on the same ctrlq
    as the `SUBMIT_3D` that drew it. A host that runs the queue in order therefore shows complete frames, which
    ends §16's stale-frame problem for GL guests.
  - The atomic commit waits for the buffer's implicit fences (the execbuffer's), so **fences must signal**.

## Proposed G2 kickoff (for the user to confirm or change)

**Goal:** know what virgl costs the guest in our machine before building the renderer. Leave a device that
speaks virgl to a null renderer, plus the oracle captures the renderer will be built against.

- **Loop 0, the oracle captures** (dev VM, natively, no guest):
  - Run glcomp, glmark2-es2 (`zypper in glmark2`, not installed yet) and `es2gears` over
    `virgl_test_server --use-gles --use-egl-surfaceless` with `MESA_GLES_VERSION_OVERRIDE=3.0`, and the client
    on `GALLIUM_DRIVER=virpipe VTEST_SOCKET_NAME=…`.
  - Record: the caps virglrenderer reports (the VIRGL2 capset blob: G2's device starts from these, trimmed to
    what WebGL2 backs); the TGSI per shader (`VIRGL_DEBUG=tgsi` on the client); and the command streams. The
    vtest protocol carries the same `SUBMIT_3D` payloads as virtio-gpu, so a small socket proxy in Node can
    write them to files.
  - For the GLSL virglrenderer generates from each TGSI (`VREND_DEBUG=shader`), build virglrenderer from
    source in debug mode (meson, natively in the dev VM, or in Podman per the images rule if it needs
    dependencies). The distro's build is release and prints nothing.
  - Keep the captures under `bench/results/local/` while they are ad hoc, and as test fixtures once tests use
    them.
- **Loop 1, the device on a null renderer:**
  - `web/gpu.ts` and the Rust twin advertise `VIRTIO_GPU_F_VIRGL`, answer `GET_CAPSET_INFO`/`GET_CAPSET`
    (VIRGL and VIRGL2) with loop 0's caps limited to GLES 3.0, and accept `CTX_CREATE`/`DESTROY`,
    `CTX_ATTACH`/`DETACH_RESOURCE`, `RESOURCE_CREATE_3D`, `SUBMIT_3D` (parsed into virgl commands and counted)
    and the 3D transfers (copies to and from a host-side byte image).
  - Fences complete at once.
  - An option keeps it off, so no existing guest's step count moves.
  - Behind a URL switch on the page (e.g. `?gpu=virgl-null`) and in a test guest. Debian's kernel has virgl in
    `virtio_gpu`, and its Mesa has `virtio_gpu_dri.so`. For Buildroot/Alpine guests, check `DRM_VIRTIO_GPU` and
    Mesa's virgl driver (Alpine: `mesa-dri-gallium`).
- **Loop 2, the numbers** (Chromium, the page or `bench/boot`; medians and IQR, JSON committed):
  - guest CPU per frame for glcomp on virgl-null against `gl_llvmpipe_jit`/`_4`;
  - sway on GLES (`WLR_RENDERER=gles2`) against pixman and llvmpipe: per-core load and frames a second, as in
    §16's table;
  - the guest's split (Mesa, the kernel's virtio-gpu path, idle), from the profile tools in
    `bench/boot/userprof-perf.ts`/`bench/apps/perf.ts`;
  - shader compiles in the guest (GLSL → NIR → TGSI, kept in Mesa's disk cache) timed separately.
- **The gate:** go on to the WebGL2 renderer (G3) if a compositor frame costs the guest a small fraction of
  llvmpipe's (expect low milliseconds under the JIT). If Mesa's frontend is the cost, profile it before
  considering the alternative in graphics.md §5 (a GLES passthrough library in the guest: it needs guest
  changes, so it's the user's call).
- **Exit:** the numbers, the caps we'll advertise, the decision on G3, and docs (devices.md, graphics.md
  §19+, testing.md for the new guest).

After G2 (graphics.md §7):
- **G3:** the renderer on WebGL2: a GPU worker, the TGSI → GLSL ES 3.00 translator, the first frames of glcomp
  and sway.
- **G4:** breadth: GTK4, Chromium's GPU process and Firefox in the guest, KDE or GNOME, a dEQP-GLES subset.
- **G5:** performance and the product.
- **Later:** the WebGPU backend (GLES 3.1), and Vulkan.

## Questions for the user, before G2 starts

1. **Guest-side thin driver: Mesa's virgl (unmodified guests) vs our own GLES passthrough library** (the
   user's first idea: the least guest CPU and a 1:1 mapping onto WebGL2, but it means shipping guest software
   and rebuilding the EGL/GBM/dma-buf/Wayland/GLX integration Mesa already has). The proposal is virgl,
   measured in G2, with the library as the fallback if Mesa's frontend proves too costly.
2. **What desktop to aim at first:** sway/wlroots on GLES2 (cheap; it is what §16 measured) on Debian or the
   user's Arch image; then GTK4 apps, a browser in the guest, KDE or GNOME. This decides G4's test guest.
3. **Snapshots with 3D on:** the GL objects live on the host. Refuse to save while a 3D context exists (QEMU
   doesn't migrate virgl state either: worth confirming), or rebuild them? The first is the cheap default.
4. **3D on by default** when WebGL2 is present, or behind a switch until G4?
5. **The Mac host for real-GPU numbers** again (G0's permission covered the bench page only).

## Design notes the renderer will need (G3, graphics.md §8)

- **One WebGL2 context for every guest context.** WebGL contexts share no objects; virglrenderer uses a GL
  share group. The renderer keeps per-guest-context state and rebinds on switch.
- **Where it runs:** a GPU worker started by the page (a top-level worker; the device worker is nested in the
  machine worker and has no `requestAnimationFrame`, §12), owning the screen's `OffscreenCanvas`. The device
  worker keeps the virtqueues and forwards 3D commands over a `MessagePort`, or a shared ring. A canvas can't
  change context type, so the 2D path's presentation should move onto the same WebGL2 context; G0 measured
  WebGL2 as the fastest presenter (0.8 ms at 1080p against canvas 2D's 3.6).
- **Fences:** Chromium's `clientWaitSync` takes only a zero timeout. Since one context runs everything in
  order, a fence can signal once its submit is issued. `TRANSFER_FROM_HOST_3D` reads synchronously
  (`readPixels`, `getBufferSubData`) or through a pixel-pack buffer polled with `fenceSync`.
- **WebGL2 below GLES 3.0:**
  - no texture swizzle: do it in the generated shader;
  - no `glMapBufferRange`: shadow copies and `bufferSubData`;
  - no BGRA formats: swizzle on upload or in the shader;
  - fixed-index primitive restart only;
  - base vertex, clip distances, depth clamp and polygon mode are extensions that only some adapters have.
  Advertise caps per adapter, never more than is backed.
- **Language:** TypeScript, which calls WebGL directly and matches the other device backends, is the
  default. Tests run in Node against a recording WebGL2 mock, and every generated shader compiles in headless
  Chromium. A Rust crate would cross wasm→JS on every GL call.
- **Licensing:** virglrenderer is MIT (cloned today at `c8e3fc3`; `src/vrend/vrend_shader.c` is the TGSI →
  GLSL translator, `vrend_decode.c` the command decoder, `src/virgl_protocol.h` and `virgl_hw.h` the protocol).
  Porting from it is allowed. Add its row to THIRD_PARTY.md and keep the headers. Mesa is MIT too (the guest
  side, a reference only).

## How to reproduce today's numbers

```sh
S=<a tmp dir>
clang -O2 -o $S/glcomp images/alpine/gl/glcomp.c -lEGL -lGLESv2
MESA_GLES_VERSION_OVERRIDE=3.0 timeout 120 virgl_test_server --use-egl-surfaceless --use-gles \
  --no-loop-or-fork --socket-path $S/v.sock &      # one client, then it exits
GALLIUM_DRIVER=virpipe VTEST_SOCKET_NAME=$S/v.sock eglinfo -p surfaceless   # versions the client gets
GALLIUM_DRIVER=virpipe VTEST_SOCKET_NAME=$S/v.sock VIRGL_DEBUG=tgsi $S/glcomp 30
LP_NUM_THREADS=0 $S/glcomp 30                      # llvmpipe directly
```

Client CPU per frame is the user + sys difference between runs of `glcomp 1` and `glcomp 301` under `time`.
Without `--use-gles`, or without the override, the host is GL 4.x/GLES 3.2 and the client gets GL 4.3, which
WebGL2 can't back: always measure with the override.

## Learned (don't re-discover)

- **QEMU's `virtio-gpu-gl` can't run in the dev VM:** `egl-headless` needs a DRM render node, and the VM has no
  `/dev/dri` and no `vgem`/`vkms` modules. vtest is the protocol oracle. The kernel's sequence comes from its
  source (`target/images/build/linux-6.18.54/drivers/gpu/drm/virtio/`) and from our device's log.
- Installing the oracle packages upgraded the VM's Mesa (26.2.3 → 26.2.4). The guest images pin their own Mesa
  (`images/build.sh` `GL_PKGS`, Alpine 26.1.6), so no image moved.
- The distro's virglrenderer ignores `VREND_DEBUG` (a release build). `VIRGL_DEBUG=tgsi` on the Mesa side works.
- virglrenderer's GLSL level on GLES hosts: 120 (GLES 2), 130 (GLES 3.0), 310 (GLES 3.1). It raises the level
  ("lies") only when geometry shaders, tessellation and `gpu_shader5` are all present, which neither WebGL2
  nor WebGPU has. Desktop GL above 3.1 isn't reachable honestly on either.
- The CLAUDE.md rules that bite here: cap memory on every `node`/`cargo` run; no headed Chromium (Playwright
  headless only; WebGL2 there is SwiftShader); a new guest-visible device feature needs the user's OK and
  leaves existing step counts alone (an option, off by default, as G1 did with `Image-gpu`).
