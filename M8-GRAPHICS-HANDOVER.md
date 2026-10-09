# M8 graphics, 3D: handover after G2 (2026-10-09)

For the session that builds G3, the virgl renderer on WebGL2. The plan is [docs/plans/graphics.md](docs/plans/graphics.md):
§1 the direction, §7 the steps, §8 the open questions, **§19 what G2 measured**. How the device works is docs/devices.md
"virtio-gpu" and "virgl". **G3 isn't scheduled until the user writes its kickoff.** Below: where things stand, a
proposal for the kickoff with the user's answers to its questions (2026-10-09) worked in, and what to know first.

## Where it stands

- **G2 is done and the gate passed** (graphics.md §19; the G2 kickoff is in git history): `GpuOptions.virgl` (the
  page's `?gpu=virgl-null`) gives a virtio-gpu with `VIRTIO_GPU_F_VIRGL`, the VIRGL/VIRGL2 capsets (`virglCaps` in
  `web/virgl.ts`: GLES 3.0, trimmed to what WebGL2 backs) and a **null renderer** (streams walked and counted, fences
  at once, a 3D scanout black). Off by default; snapshots refused while 3D is in use.
- **The numbers** (Chromium 153, dev VM):
  - glcomp, 1 vCPU: **1.68 ms a frame, 0.7M guest steps**, against llvmpipe's 315 ms and 476M (same Mesa build);
    4 vCPUs 1.30 against 69 ms (`gl_virgl_jit*`, `gl_virgl_llvmpipe_jit*`, `images/build.sh alpine-virgl`).
  - sway on the user's Arch image with foot scrolling: **60 frames a second, sway 6.6 ms of CPU a frame**; pixman
    60 and 4.2 ms; llvmpipe 28 and 81 ms. Mesa's user time equals pixman's; the extra is the kernel's submit path
    (~2.2 ms of sys a frame, two `SUBMIT_3D`s).
- **Alpine's Mesa has no virgl** (its APKBUILD leaves it out): `alpine-virgl` builds Mesa 26.1.6 into `/opt/mesa`.
  Debian's and Arch's Mesa have it.
- **Mesa moves texture data through staging buffers** (`VIRGL_BIND_STAGING` + `COPY_TRANSFER3D` in the stream):
  glcomp and sway send no `TRANSFER_*_3D`. The renderer reads (uploads) and writes (read-backs) the staging buffers'
  guest pages while it decodes the stream.
- **The oracle is ready:** a debug virglrenderer `c8e3fc3b` with a capture patch (`bench/results/local/virgl-build`,
  `virglrenderer/src/virglrenderer.c`'s `wdump`, `VTEST_DUMP=<file>`), `bench/results/local/g2/dump.ts` (a capture's
  summary) and `caps.ts`, and captures of glcomp and 16 glmark2-es2 scenes with the TGSI and the GLSL virglrenderer
  made (192 shaders; `*.server.log`). All local and git-ignored: rebuild with meson as §19 says.

## Proposed G3 kickoff (for the user to confirm or change)

**Goal:** glcomp's frames and sway's desktop drawn by our renderer on WebGL2 in the page, from unmodified guests.

- **Loop 0, the fixtures:** the device's `onSubmit` captures real streams (glcomp on alpine-virgl, sway on Arch)
  with the staging buffers' bytes; a corpus of TGSI from them and from glmark2's captures. Committed as small
  fixtures (`tests/virgl/`).
- **Loop 1, the decoder and state** (TypeScript, `web/virgl/`): the commands glcomp and sway send (the 28 kinds of
  glcomp's stream first; virglrenderer's `vrend_decode.c` is the reference, MIT, attribution), per-context objects,
  sub-contexts; against a recording WebGL2 mock in Node. **The caps from the browser** (answer 1): `virglCaps` takes
  the page's WebGL2 limits, extensions and renderable formats (queried once, before the machine starts, and handed
  to the device worker) and advertises what they back, never more; today's WebGL2 minimums become the floor and
  the unit tests' fixed input.
- **Loop 2, TGSI → GLSL ES 3.00** for that corpus, every output compiled in headless Chromium (SwiftShader); no
  `EXT_clip_cull_distance` or `blend_func_extended` unless the adapter has them.
- **Loop 3, the GPU worker:** a top-level worker started by the page, owning the screen's `OffscreenCanvas` with
  one WebGL2 context for every guest context; the device worker forwards the 3D commands (a `MessagePort` first,
  a shared ring if it measures better); scanout from the texture; the 2D path's presentation moved onto the same
  context when 3D is on (answer 2: a canvas can't change context type, so a virgl machine presents everything,
  firmware and console included, through WebGL2; a machine without 3D keeps today's canvas 2D path unchanged);
  fences signalled once the submit is issued.
- **Loop 4, the numbers:** glcomp's pixels against llvmpipe's (a tolerance), sway on the page; frame rate, the
  guest's CPU (as §19) and the renderer's time a frame, in the dev VM (SwiftShader) **and on the Mac host's real GPU**
  (answer 4); the kernel's submit path profiled in the guest.
- **Snapshots** (answer 3's condition): a machine with 3D available but unused saves and restores as today. Refused
  only while a 3D context or 3D resource exists (as G2 built it); G3 adds a test that a virgl machine that never
  used 3D, and one whose GL client has exited, both save. Because the caps now follow the browser and the guest's
  kernel reads the capsets once at probe, the snapshot records the caps the guest saw, and a restore in a browser
  that can't back them refuses with a message (or starts the restored machine with 3D off: the loop decides).
- **3D's default** (answer 3, "whatever is most convenient"): behind `?gpu=virgl` through G3, so the page's tests and
  the Debian machine don't change while the renderer is young; on by default where WebGL2 exists once the page's
  Debian and the snapshot tests pass with it on (G3's exit or G4, whichever reaches that first).
- **Exit:** sway on GLES draws on the page; docs; G4's outline.

## The user's answers (2026-10-09)

1. **Caps follow what the browser provides** (not fixed WebGL2 minimums): per adapter, never more than is backed.
2. **Presentation:** whatever is most convenient: WebGL2 for every scanout on a 3D machine, canvas 2D kept for
   machines without 3D (above).
3. **3D's default:** whatever is most convenient, **as long as snapshots work when 3D isn't being used** (above).
4. **The Mac host may be used** for real-GPU numbers in G3 (headless Chromium there, as G0 did), beyond the bench
   page.

These settle the questions; the kickoff itself is still the user's to write.

## Learned (don't re-discover)

- `?gpu=virgl-null` makes a GL desktop's screen black (nothing renders); measure through the serial terminal
  (`bench/results/local/g2/sway-virgl.ts`: root on ttyAMA0, `/proc/stat` and `/proc/<pid>/stat`, frames from
  `?displaystats`'s new `flushes`/`submits`). The page's fixed screen size is the `webpc.settings` local-storage
  key's `screen`.
- Text typed into a shell through xterm from a TS template literal: `\n` inside an awk string must be `\\n`.
- `Gpu.save()` is also the tests' state read (`vm.deviceState`): it marks a 3D machine `unsaveable` and
  `vm.snapshot` refuses it; throwing there broke every state read.
- glcomp's check is `00000000` on the null renderer (read-backs of nothing); the bench holds it only to itself.
- The CLAUDE.md rules that bite here: cap memory on every `node`/`cargo` run; no headed Chromium (WebGL2 in headless
  Chromium is SwiftShader); a new guest-visible device feature stays an option, off by default.
