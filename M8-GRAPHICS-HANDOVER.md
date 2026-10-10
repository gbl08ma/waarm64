# M8 graphics, 3D: handover in G4 (2026-10-10)

G4 is current: the kickoff is `M8-GRAPHICS-KICKOFF.md` (the user's decisions; don't re-ask), the record
docs/plans/graphics.md §21. Read first: graphics.md §1, §7, §20, §21; docs/devices.md "virgl"; docs/frontend.md "A 3D
machine".

## G4 so far

- **Loop 0 (Firefox measured), done** (§21): `bench/gpu/firefox-load.ts` on `bench/gpu/guest-session.ts` (shared
  with sway-load.ts), the pages in `bench/gpu/firefox/`, real sites on a second disk (`bench/gpu/firefox-pages.sh` →
  `target/ffpages/pages.ext4`), `bench/gpu/sway-mac.sh` with `SCRIPT=firefox-load.ts` (and `HEADED=1`: the user
  allows a visible window on the Mac when they aren't using it). Phases: still, scroll, webgl, pages, menu,
  startup, support; `GUEST_CMD`. JSON in `bench/gpu/results/g4-firefox/`.
- **Loop 1 (Firefox faster): measured, nothing for the graphics path to take.** On the Mac's GPU, scrolling real sites
  holds 50–60 frames a second; start-up (32 s) is Firefox's main thread alone at ~2/3 of a core, no I/O wait, the
  renderer 8 ms a second; page loads are the same kind of guest CPU work. The emulator's speed is the JIT track's
  (`M8-JIT-HANDOVER.md`). Left for the graphics side: the 15–18 3D resources a second created and destroyed while
  scrolling (each a guest kernel allocation and `ATTACH_BACKING`), and replies held behind fenced ones (QEMU holds
  only the fenced reply). On SwiftShader (the dev VM) fences wait ~18 ms behind each present: don't judge there.
- **Loop 2 (the menu's Graphics: 3D or 2D), done**: `web/app/main.ts`, tested in `scripts/ci-debian.sh`.
- **Loops 3 and 4 (dEQP and its failures), done but for a confirming run** (§21 "Loop 3"): `images/deqp/build.sh` (VK-GL-CTS 3.2.14.1
  for Arch, `target/deqp/deqp.ext4`, the Podman image `localhost/webpc-deqp`), `bench/gpu/deqp-run.ts` (a slice of a
  mustpass list: `STRIDE=n OFFSET=k`, default every 50th; or `CASES=` names and `*` patterns; `DETAIL=n` dEQP's own
  messages; `VIRGL_GPU=virgl,debug` the renderer's trace in `<out>/virgl-debug.txt`; `CAPTURE=` a fixture),
  `tools/virgl-oracle/deqp.sh` (the same binaries on virpipe against vtest; `OFFSET=` too). Results in
  `bench/gpu/results/g4-deqp/`. Where it stands:
  - **GLES2, the whole list** (17,165): 16,979 pass on the first run; its 48 failures are all fixed (the last 12 on
    2026-10-10: index offsets and restart, alpha on targets without it, `gl_FragCoord.y`; §21). The oracle ran slices
    0 and 1 only (6 fail of 6,866); slices 2–4 not run (`OFFSET=2..4 tools/virgl-oracle/deqp.sh gles2 <out> 5`,
    ~10 min each; never beside CI).
  - **GLES3, the whole list** (44,768, ten slices of ~16 min, one after another in the background: `STRIDE=10
    OFFSET=$k LIMIT_S=1800 node bench/gpu/deqp-run.ts gles3 bench/results/local/myarch3.qcow2 <out>/$k` under
    `timeout 2100`, capped): 44,033 pass, 326 fail (§21 "Loop 4": their causes). Fixed since: all but one: occlusion queries (62),
    fragment outputs (58), texture queries and gradients (18), MSAA (172: `texture_multisample` advertised and
    backed), DEPTH32F_STENCIL8 uploads (15). **Open:** `negative_api.buffer.read_pixels_fbo_format_mismatch`. The
    every-50th subset after them: GLES3 889 pass, 0 fail (the oracle 884). A whole-list rerun hasn't been done. The list of cases
    that didn't pass: `bench/gpu/results/g4-deqp/full-gles3/page-failed.txt` (rerun a group with `CASES=`).
  - The method that worked: a group with `CASES='dEQP-…group.*'` and `DETAIL=3`, then one case with
    `VIRGL_GPU=virgl,debug`; compare with vrend (`target/virgl-oracle/src/src/vrend/vrend_renderer.c`) and Mesa's
    encoder (`~/Development/src/mesa/src/gallium/drivers/virgl/`). Most bugs were WebGL refusing what GLES allows
    (silently: the draw doesn't happen) or protocol meanings that are vrend's, not Gallium's (query numbers,
    stride 0, the append mask, the index offset). A pair of read-backs dEQP compares (an indexed draw and its
    reference) can be replayed from a capture on Chromium and diffed: `bench/gpu/virgl-pairs.ts <capture>`. Each fix gets a cheapest-layer test (tests/virgl.test.ts on the recording mock, or
    tests/browser/virgl-page.ts on Chromium) and a planted-bug check.
  - Fixed so far: an X target's alpha byte (the user's black menu borders), point size declared twice, stencil
    faces, attribute strides, stream output (layouts, resume, query numbering), depth copies and Z24 layouts,
    integer blits and RGB10_A2UI, transfer strides, copies from non-renderable textures, constant-color/alpha
    blends, inverted depth ranges.
- **Loop 5 (GTK4), done** (§21 "Loop 5"): `bench/gpu/gtk4-load.ts` (gtk4-demo's demos one at a time in sway,
  `DEMOS=`, `RENDERERS=`, `GTK_ENV=`; JSON in `bench/gpu/results/g4-gtk4/`). GSK's GL renderer draws every demo right;
  3D against 2D: fishbowl 56 against 1 frames a second, gears 31 against 9. A GtkGLArea dies of GTK's graphics
  offload (a guest-side Mesa bug: a staging-backed texture exported as a dmabuf of a page; `GDK_DISABLE=offload`;
  backlog).
- **Loop 6 (cost), done** (§21 "Loop 6"): no shader cache (steady phases compile nothing; Firefox's start ~0.2 s);
  the PC sampler publishes every 256 steps while it runs (`vm_set_chunk`, ABI 34), `PROFILE=1` in sway-load.ts and
  gtk4-load.ts (guest-session.ts `sampler`, `symbolize`): the guest kernel's submit path isn't a cost (no virtio-gpu
  or DRM function in GTK's top 60). Firefox's leftovers (replies held behind a fenced one, at most a fence's ~0.3 ms
  on a real GPU; 15–18 resources a second, the guest allocating) not pursued.
- **Confirmation runs (2026-10-10):** GLES2's whole list passes (five slices, no failure). GLES3's found a regression
  from the drawn DEPTH32F_STENCIL8 upload (6911844): it left UNPACK_ALIGNMENT at 4 where the renderer keeps 1, so
  every later upload of rows not a multiple of 4 bytes (r8, rg8, r16, rgb565, rgba4, snorm) was skewed: 68 new
  failures in texture.specification, all passing alone; fixed (tests/virgl.test.ts checks the alignment). Three
  slices hung (dEQP "Blocked by coredump"): a query destroyed with its result pending stayed pending for good (a
  deleted WebGL query never has one), so the FenceGate (f481000) held every later fence, the guest's control queue
  filled (both blocked tasks in `virtio_gpu_queue_ctrl_sgs`) and dEQP's watchdog killed it; fixed (`destroyObject`
  drops it; tests/virgl.test.ts). deqp-run.ts: no core dumps, kernel info on the console, `stoppedAt`; a run that
  times out saves the page's whole serial log (`serial.txt`, the `__serialLog` hook).
- **Next, in order:** (1) the whole GLES2 and GLES3 lists again for the exit's numbers (~4 h on the page, nothing
  else beside it); (2) a dEQP pass list as a test: **the user's decision: its own script, `scripts/ci-deqp.sh`, run
  like ci-net.sh** (when a change touches the renderer, translator, caps or virtio-gpu, and at track ends; not
  inside ci.sh or ci-debian.sh); it needs a repo-built guest image with Mesa (images/archarm plus mesa) instead of
  the git-ignored myarch3.qcow2; (3) the exit write-up (§21, PLAN.md, G5's outline).
- The Arch image's guest-side helpers on the Mac: `~/webpc-arch/` (`start.sh` boots `myarch3.qcow2` under hvf with
  a network, virtio-mmio devices as ours; `vmsh.py <sock> <timeout> <cmd>` runs a command on its serial console as
  root). Mesa's source for reading: `~/Development/src/mesa` (sparse, mesa-26.2.4); vrend's:
  `target/virgl-oracle/src/src/vrend`.

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
