# M8 graphics, G2: kickoff (2026-10-09)

The user's brief: "go with the proposal and work independently until you're done with the gate and we've
reached a conclusion on whether moving to G3 is worth it." The proposal is `M8-GRAPHICS-HANDOVER.md`'s
"Proposed G2 kickoff", taken as written; the handover's questions are settled by its defaults:

1. **Guest driver:** Mesa's upstream virgl driver (unmodified guests), measured in G2. Our own GLES
   passthrough library stays the fallback, considered only if Mesa's frontend proves too costly (it needs
   guest changes, so it goes back to the user).
2. **First desktop:** sway/wlroots on GLES2 (Debian or the user's Arch image).
3. **Snapshots with 3D on:** refused while a 3D context exists (the cheap default).
4. **3D off by default:** behind a switch (`?gpu=virgl-null` in G2) until G4.
5. **The Mac host:** not widened; G0's permission (the bench page only) still holds.

**Goal:** know what virgl costs the guest in our machine before building the renderer.

- **Loop 0, the oracle captures** (natively, vtest): the caps virglrenderer reports on a GLES 3.0 host,
  the TGSI per shader, the GLSL virglrenderer makes from it (a debug build), the command streams.
- **Loop 1, the device on a null renderer:** `VIRTIO_GPU_F_VIRGL`, the VIRGL/VIRGL2 capsets, `CTX_*`,
  `RESOURCE_CREATE_3D`, `SUBMIT_3D` (parsed and counted), the 3D transfers, fences at once. Off by default
  (no step count moves); a URL switch on the page and a test guest.
- **Loop 2, the numbers** (Chromium; medians and IQR, JSON committed): glcomp on virgl-null against
  `gl_llvmpipe_jit`/`_4`; sway on GLES against pixman and llvmpipe; the guest's split; shader compiles.
- **The gate:** G3 if a compositor frame costs the guest a small fraction of llvmpipe's. If Mesa's frontend
  is the cost, profile it before considering the passthrough library.
- **Exit:** the numbers, the caps we'll advertise, the decision on G3, the docs (devices.md, graphics.md
  §19+, testing.md).
