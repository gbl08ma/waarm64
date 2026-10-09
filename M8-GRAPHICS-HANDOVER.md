# M8 graphics, 3D: handover for G4 (2026-10-09)

G3 is done (docs/plans/graphics.md §20 and its exit): Mesa's virgl driver in an unmodified guest draws through our
renderer on WebGL2, and 3D is the page's default where WebGL2 is. **G4 has no kickoff yet**: a proposal and the
questions for the user are at the end; the kickoff is written from the user's answers. Read first: graphics.md §1
(direction), §7 (steps), §8 (open questions), §20 (G3); docs/devices.md "virgl"; docs/frontend.md "A 3D machine".

## What exists (G3)

- **The device** (`web/gpu.ts`, `GpuOptions.virgl`): the VIRGL/VIRGL2 capsets with the caps it is given, contexts,
  3D resources, transfers, `SUBMIT_3D` walked and checked, then handed to a host (`Gpu.host`, `web/virgl-host.ts`:
  the calls, `runCall`, `localHost` for tests); a fenced command's reply waits for the host. Snapshots (decision 3):
  unused contexts saved and remade, the caps saved, 3D off where a restore's browser can't back them, refused while
  3D is in use (`unsaveable`); the restore tells the host the scanout. `Gpu.onCapture` records a guest's 3D commands
  with the memory they read (`web/virgl-trace.ts`; `web/virgl-replay.ts` replays one through the device).
- **The page** (`web/app/main.ts` `want3d`): a virtio-gpu machine is 3D unless `?gpu=2d` (or `virgl-null`, G2's null
  renderer). The GPU worker (`web/gpu-worker.ts`) owns the canvas as WebGL2, gives the caps (`web/virgl-caps.ts`), runs
  the renderer and draws every scanout (`web/virgl-screen.ts`, once per animation frame). No WebGL2: 2D.
- **The renderer** (`web/virgl-renderer.ts`): vrend's decoder and state model on one WebGL2 context; buffers with a
  CPU copy; formats stored as their bytes and swizzled in the shaders (`web/virgl-formats.ts`); stream output;
  occlusion queries as any-samples-passed, primitive queries counted. **The translator** (`web/virgl-tgsi.ts`): TGSI
  to GLSL ES 3.00 per vertex/fragment pair and draw-state key. What neither does is in §20's exit.
- **Tests:** `tests/virgl.test.ts` (Node, a recording WebGL2 mock), `tests/virgl-browser.test.ts` (Chromium: the TGSI
  corpus compiles, glcomp's trace against llvmpipe's frame, sway's trace against a reference, stream output, glcomp in
  a guest end to end), `tests/gpu.test.ts` (the device). Fixtures in `tests/virgl/`. The page's tests run 3D by
  default; `WEBPC_PAGE_QUERY=gpu=2d scripts/ci-debian.sh` runs them on the 2D path (docs/testing.md).
- **Tools:** the virgl oracle (`tools/virgl-oracle/`: virglrenderer c8e3fc3b with a capture patch, vtest on the dev
  VM's GLES); `tools/virgl-capture.ts`; `bench/gpu/sway-load.ts` (sway and foot on the user's Arch image,
  `bench/results/local/myarch2.qcow2`, git-ignored; `VIRGL_GPU=virgl|virgl-null`, `CAPTURE=`, `PROFILE=1`: the page's
  PC sampler with the kernel's symbols from the guest, and each phase's emulator counters); `bench/gpu/sway-mac.sh`
  (the same on the Mac host's GPU, decision 4).

## What the guests do

- Texture data travels through staging buffers (`COPY_TRANSFER3D` in the stream); glcomp and sway send no
  `TRANSFER_*_3D`. sway: 2 submits a frame, its buffers are 3D resources flipped with `SET_SCANOUT` and
  `RESOURCE_FLUSH`; dumb buffers (fbcon, the cursor, pixman) stay 2D. A scrolling foot uploads its whole window each
  frame (3.7 MB at 1376×762: 200 MB/s at 55 frames a second).
- Linux reads both capsets at probe and keeps them: the caps a guest saw at boot are its Mesa's for the session.
- The guest's cost is its kernel: sway's sys time is ~4–5 ms of a 5.5–7.6 ms frame. Over the date loop the machine
  takes 25,700 TLB flushes and 9,300 syscalls a second (mostly the loop's fork and exec).

## Learned (don't re-discover)

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

## Proposed G4 kickoff (the user's to settle)

**The user's priority for G4 (2026-10-09): Firefox opens on a 3D machine and uses the WebGL2 acceleration**
(WebRender on GLES through virgl). Seen once after 3D became the default, then not again: Firefox didn't open, a
GTK warning "Could not load a pixbuf from icon theme", and `glycin-svg --dbus-fd …` at 100% of a core for good (the
image here, `myarch2.qcow2`, has no Firefox: the user's own image has it). It then opened, and the user confirmed
on their image that **Firefox uses the acceleration**: `about:support` shows Compositing "WebRender" and WebGL 1 and 2
on "Mesa -- virgl (webpc)". **Its performance is underwhelming**: G4 starts by measuring Firefox on the page (an Arch
image with Firefox; frames a second scrolling a page, the guest's CPU per process, the renderer's time, on SwiftShader
and the Mac's GPU, as `bench/gpu/sway-load.ts` does for sway) and making it faster; watch for the glycin hang.

**Goal: breadth and correctness.** GLES 3.0 as Mesa's virgl exposes it, correct against a conformance subset, and
the applications people would run on a 3D machine working on the page.

- **Loop 0, conformance:** a dEQP-GLES2/GLES3 subset (VK-GL-CTS, Apache-2.0) built into a guest image as a workload,
  run on the page under the JIT (and on the oracle's vtest for the expected results); a pass list committed, the
  failures sorted by cause.
- **Loop 1, the failures:** the renderer's and translator's gaps dEQP finds, by how many tests each fixes.
- **Loop 2, applications:** Firefox first (the user's priority, above), then GTK4 (gtk4-demo, GSK's GL renderer),
  Chromium's GPU process, a desktop's compositor (KWin or Mutter on GLES); what each needs, fixed or written down.
- **Loop 3, cost:** shader compiles (a cache by TGSI and key, `KHR_parallel_shader_compile`), the renderer's time on
  the Mac's GPU per application, and the guest kernel's submit path with a finer instrument (a PC published more often
  than once a chunk, or exits counted by PC).
- **Exit:** the pass rate and the applications that work, in graphics.md; G5's outline.

**Questions for the user:**

1. **After Firefox** (the priority), which applications matter most: GTK4 apps, Chromium, or a full desktop (KDE or
   GNOME)? And in which distro image (the Arch image, or Debian with a desktop added to `images/debian`)?
2. **dEQP:** is a conformance subset as G4's correctness gate wanted, and which: GLES2 only, or GLES3 too (larger,
   and a 3.0 context is what Mesa exposes)?
3. **Snapshots while 3D is in use** stay refused (today), or should G4 or G5 rebuild them (the resources from their
   guest backings, the objects replayed)?
4. **3D by default** (flipped at G3's exit, per decision 3): keep it, or make it an option in the page's menu as
   well as `?gpu=2d`?
