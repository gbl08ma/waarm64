# M8 graphics, 3D: handover after G2 (2026-10-09)

For the session that builds G3, the virgl renderer on WebGL2. The plan is [docs/plans/graphics.md](docs/plans/graphics.md):
§1 the direction, §7 the steps, §8 the open questions, **§19 what G2 measured**. How the device works is docs/devices.md
"virtio-gpu" and "virgl". **G3 isn't scheduled until the user writes its kickoff.** Below: where things stand, a
proposal for the kickoff, and what to know first.

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
  sub-contexts; against a recording WebGL2 mock in Node.
- **Loop 2, TGSI → GLSL ES 3.00** for that corpus, every output compiled in headless Chromium (SwiftShader); no
  `EXT_clip_cull_distance` or `blend_func_extended` unless the adapter has them.
- **Loop 3, the GPU worker:** a top-level worker started by the page, owning the screen's `OffscreenCanvas` with
  one WebGL2 context for every guest context; the device worker forwards the 3D commands (a `MessagePort` first,
  a shared ring if it measures better); scanout from the texture; the 2D path's presentation moved onto the same
  context (G0: WebGL2 was the fastest presenter); fences signalled once the submit is issued.
- **Loop 4, the numbers:** glcomp's pixels against llvmpipe's (a tolerance), sway on the page; frame rate, the
  guest's CPU (as §19) and the renderer's time a frame; the kernel's submit path profiled in the guest.
- **Exit:** sway on GLES draws on the page; docs; G4's outline.

## Questions for the user, before G3 starts

1. **Caps per adapter:** advertise the WebGL2 minimums everywhere (today's `virglCaps`), or raise them per adapter
   from what the page's WebGL2 reports (bigger textures, more samples) at the cost of a machine whose caps depend
   on the browser it started in (a snapshot moved between browsers)?
2. **Where the 2D path's presentation goes:** move it onto the GPU worker's WebGL2 context for every machine (one
   presenter), or only when virgl is on (two paths kept)?
3. **3D on by default** when the browser has WebGL2, once sway draws (G3's exit), or still behind the switch until
   G4's breadth?
4. **The Mac host** for real-GPU numbers in G3 (G0's permission covered the bench page only).

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
