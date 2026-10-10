# M8 graphics, 3D: handover after G4 (2026-10-10)

G4 is done (docs/plans/graphics.md §21, "G4's exit"); its kickoff is retired (git history has it). **G5 is proposed
here and waits for the user's kickoff.** Read first: graphics.md §1, §18, §20, §21; docs/devices.md "virgl";
docs/frontend.md "A 3D machine"; docs/testing.md (`scripts/ci-deqp.sh`).

## G5, proposed

1. **Snapshots while 3D is in use** (G4's decision 4 left it to G5). Today `Gpu.save()` marks a machine whose 3D is
   in use unsaveable and `vm.snapshot` refuses it; unused contexts are saved and remade. The renderer's state lives
   in WebGL, so either the device's side keeps what a context created (objects, resource contents read back) and a
   load rebuilds a fresh renderer from it, or the commands since each context's creation are kept and replayed.
   Design against what Firefox and sway hold (their resource counts and sizes), measure the save's size and time.
2. **dEQP on a real GPU:** the whole lists, or the pass lists, on the Mac host's GPU (ANGLE on Metal) through
   `bench/gpu/sway-mac.sh`'s route (`SCRIPT=`): every G4 run was on SwiftShader. Whatever differs is what users hit.
3. **The guest-side leftovers**, each measured first (docs/backlog.md): GtkGLArea's graphics offload (caps without
   `COPY_TRANSFER_BOTH_DIRECTIONS`, every texture then guest-backed, or a Mesa fix), Firefox's 15–18 resources a
   second, replies held behind a fenced one.
4. **Breadth, if the user wants it:** KWin or Mutter, Chromium's GPU process in the guest, Xorg. Beyond GLES 3.0
   (compute, GLES 3.1) is the WebGPU backend, deferred by the 3D decision (§18).

## Tools G4 left

- `bench/gpu/guest-session.ts` (a page session on a guest image: serial root shell, sway, load phases, the PC
  sampler `PROFILE=1`, the whole serial log on a timeout), `firefox-load.ts`, `gtk4-load.ts`, `sway-load.ts`,
  `sway-mac.sh` (the Mac host's GPU; `HEADED=1` allowed when the user isn't using the Mac).
- dEQP: `images/deqp/build.sh` (`target/deqp/deqp.ext4` and the guest `target/deqp/guest.qcow2`),
  `bench/gpu/deqp-run.ts` (`STRIDE`/`OFFSET` slices, `CASES=` lists and patterns, `DETAIL=`, `VIRGL_GPU=virgl,debug`,
  `CAPTURE=`; `stoppedAt`), `tools/virgl-oracle/deqp.sh` (vtest), `bench/gpu/virgl-pairs.ts` (a capture's read-back
  pairs on Chromium), `scripts/ci-deqp.sh` (the pass lists, `tests/deqp/`). A whole GLES3 list is ten slices of ~17
  min (`STRIDE=10 OFFSET=$k LIMIT_S=1800` under `timeout 2100`); validation, so other work may run beside it.
- The method that found G4's bugs: a group with `CASES='dEQP-…group.*'` and `DETAIL=3`, then one case with
  `VIRGL_GPU=virgl,debug`; compare with vrend (`target/virgl-oracle/src/src/vrend/`) and Mesa's encoder
  (`~/Development/src/mesa/src/gallium/drivers/virgl/`). Most bugs were WebGL refusing what GLES allows (silently)
  or protocol meanings that are vrend's, not Gallium's. A hang: the hung tasks' stacks in `serial.txt`.

## What exists (G3, with G4's changes in graphics.md §21)

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
- **Images:** `bench/results/local/myarch3.qcow2` (git-ignored, the user's, 2026-10-09) is the Arch image **with
  Firefox** (7.58 GiB virtual, 3.5 GiB used), beside `myarch2.qcow2` (no Firefox). G4's Firefox work uses it. The
  user allows growing its disk (`qemu-img resize`, then the partition and filesystem inside) and installing more into
  it on the oracle side (QEMU with a network connection, `pacman`); keep the untouched download as a copy first.

## What the guests do

- Texture data travels through staging buffers (`COPY_TRANSFER3D` in the stream); glcomp and sway send no
  `TRANSFER_*_3D`. sway: 2 submits a frame, its buffers are 3D resources flipped with `SET_SCANOUT` and
  `RESOURCE_FLUSH`; dumb buffers (fbcon, the cursor, pixman) stay 2D. A scrolling foot uploads its whole window each
  frame (3.7 MB at 1376×762: 200 MB/s at 55 frames a second).
- Linux reads both capsets at probe and keeps them: the caps a guest saw at boot are its Mesa's for the session.
- The guest's cost is its kernel: sway's sys time is ~4–5 ms of a 5.5–7.6 ms frame. Over the date loop the machine
  takes 25,700 TLB flushes and 9,300 syscalls a second (mostly the loop's fork and exec).

## Learned (don't re-discover)

- **On SwiftShader the GPU worker stalls ~33 ms after every present** (the canvas commit waits for the GPU process
  to draw; fences queue behind it: 18 ms on the way in, WebGL capped at ~34 frames a second). On the Mac's GPU none.
  `transferToImageBitmap` moved the wait, didn't remove it. Don't judge fence latency on the dev VM.
- Firefox: a fresh profile's first minute is busy (WebExtensions, settings sync failing offline): warm up 30 s before
  measuring. Its WebGL runs in the parent (`CanvasRenderer`), presented through DMABUF. G2's null renderer
  (`?gpu=virgl-null`) can't run Firefox's WebGL page (it never gets ready).
- The guest's `pacman -Syu` rebuilds the initramfs with `autodetect`: keep `MODULES=(virtio_mmio virtio_blk ext4
  vfat)` in its mkinitcpio.conf (set in myarch3).
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
