# M8 graphics, G3: kickoff (2026-10-09)

Written from the user's decisions of 2026-10-09 (their answers to the G2 handover's questions; the user asked for
this kickoff to be written from them). What G2 found and how to work is in `M8-GRAPHICS-HANDOVER.md`; the plan is
[docs/plans/graphics.md](docs/plans/graphics.md) (§1 direction, §7 steps, §8 open questions, §19 G2's numbers).

**Goal:** unmodified guests draw OpenGL ES through Mesa's virgl driver onto **our renderer on WebGL2** in the page:
glcomp's frames correct, and sway on GLES as a usable desktop.

## The user's decisions

1. **The advertised caps follow what the browser provides**: the page's WebGL2 limits, extensions and renderable
   formats decide what the device advertises, never more than is backed. G2's fixed caps (`virglCaps`, WebGL2's
   minimums) become the floor.
2. **Presentation, the convenient way:** on a machine with 3D the screen is a WebGL2 canvas and everything is
   presented through it (firmware, console, 2D and 3D scanouts); a machine without 3D keeps today's canvas 2D path
   unchanged.
3. **3D's default, the convenient way, with one condition: snapshots must work when 3D isn't being used.** 3D stays
   behind a page switch (`?gpu=virgl`) through G3; it becomes the default where WebGL2 exists once the page's Debian
   and snapshot tests pass with it on. A machine that has 3D available but isn't using it saves and restores.
4. **The Mac host may be used** for real-GPU numbers (headless Chromium there, as G0 did), not only the bench page.

## Loops

- **Loop 0, fixtures:** real streams captured by the device (`Gpu.onSubmit`, with the staging buffers' bytes):
  glcomp on `alpine-virgl`, sway on the Arch image; a TGSI corpus from them and from the oracle's glmark2 captures
  (`tools/virgl-oracle/`). Small ones committed under `tests/virgl/`.
- **Loop 1, decoder, state and caps** (TypeScript): the commands glcomp and sway send, per-context objects and
  sub-contexts, against a recording WebGL2 mock in Node; virglrenderer's `vrend_decode.c` the reference (MIT,
  attribution). The caps built from the browser's WebGL2 (decision 1), queried once before the machine starts.
- **Loop 2, TGSI → GLSL ES 3.00** for the corpus (`vrend_shader.c` the reference); every output compiles in headless
  Chromium; no extension the adapter lacks.
- **Loop 3, the GPU worker:** a top-level worker started by the page that owns the screen's `OffscreenCanvas`
  (WebGL2, decision 2) and one context for every guest context; the device worker forwards the 3D commands; scanout
  from the texture; fences signalled once the submit is issued; snapshots (decision 3: the caps the guest saw
  recorded, a restore where the browser can't back them refused or started with 3D off; a virgl machine that never
  used 3D, and one whose GL client exited, both save).
- **Loop 4, the numbers:** glcomp's pixels against llvmpipe's (a tolerance); sway on the page: frames a second, the
  guest's CPU (as §19), the renderer's time a frame, in the dev VM (SwiftShader) and on the Mac host's GPU
  (decision 4); the guest kernel's submit path profiled.
- **Exit:** sway on GLES draws on the page; the page and snapshot tests pass with 3D on (or say what's left before
  it can be the default); docs (devices.md, frontend.md, graphics.md §20+, testing.md); G4's outline.
