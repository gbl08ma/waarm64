# Mesa 26.3 on our virgl: GTK4 finds no EGL config — handover

A brief for a fresh session: GTK4 gets no EGL config from Mesa 26.3; the cause is found (below: a Mesa regression);
what's left is the way out (the user's call) and bringing the `arch-3d` demo back. Read CLAUDE.md first; then docs/graphics.md (the guest's
3D, "The caps", GTK4), `web/virgl.ts` (`virglCaps`) and docs/backlog.md "GTK4 finds no EGL config on Mesa
26.3".

## The problem (found 2026-11-22)

The Arch desktop image (`images/arch/desktop.sh`, the mirror's packages of the day) moved from Mesa 26.2.7 to 26.3.1.
With 26.3.1, every GTK4 program on virgl gets no EGL config: a GtkGLArea shows "No EGL configuration available"
(gtk4-demo's shadertoy, the `arch-3d` demo's app), and GTK draws its windows in software. Same GTK (4.24.1) on both.

- **26.2.7** (works): `GDK_DEBUG=opengl` prints `EGL API version 1.5 found …`, `Selected fbconfig: R8G8B8A8, depth 0,
  stencil 0`, `Creating EGL context version 3.0 (… es:yes)`, `Using OpenGL backend EGL`; the shader draws.
- **26.3.1** (broken): `GDK_DEBUG=opengl` prints nothing about EGL at all; the GL area shows the error.
- On 26.3.1, `eglinfo -B -p wayland` still reports `virgl (waarm64)`, GLES 3.0 and desktop GL 2.1 (compatibility),
  as on 26.2 (docs/graphics.md: that's what our caps give on a GLES 3.0 host). sway (`WLR_RENDERER=gles2`) and
  Firefox (WebRender) still render. So EGL works for them; what GTK asks for doesn't match any config any more.
- Seen on headless Chromium's SwiftShader (the dev VM). Not yet checked on a real GPU (the Mac: `bench/gpu/sway-mac.sh`).

## The cause (found 2026-11-22): a Mesa regression, not ours

- GTK's "No EGL configuration available" comes from `gdk_display_create_egl_config` (GTK 4.24.1 `gdk/gdkdisplay.c`):
  EGL initialised, but `eglChooseConfig({WINDOW_BIT, RGB_BUFFER, R8 G8 B8 A8})` returned 0. (The "EGL API version"
  debug line is printed only after a config is chosen: GDK did reach EGL.)
- Mesa `338afb32f86` ("mesa: don't advertise APIs that are not built", MR 46169; in 26.3.1 as `1224ff36188`):
  `_mesa_get_version` returns 0 for `API_OPENGLES` when GLES1 isn't built (Arch: `-D gles1=disabled`; the guest has
  no libGLESv1), so no config gets `EGL_OPENGL_ES_BIT`. `eglChooseConfig`'s default `EGL_RENDERABLE_TYPE` is
  `EGL_OPENGL_ES_BIT` (the spec's, `eglconfig.c`), and GDK doesn't set it: nothing matches. Every driver, every
  platform; real GPUs too: mesa/mesa#16934 (radeonsi, open, "regression"), Satty #831, agterm-omarchy #485.
- Measured (`bench/results/local/eglconfigs.py`: Python ctypes, Wayland platform, in the sway session):
  26.2.7: RGBA8888 configs `RENDERABLE_TYPE` 0x4d, GDK's attributes match 15. 26.3.1: 105 configs, all 0x4c, GDK's
  attributes match 0, and 15 with `EGL_RENDERABLE_TYPE=EGL_OPENGL_ES2_BIT` added.
- Nothing in our caps or device can set the bit (it's compiled out). **The way out is the user's call:** wait for an
  upstream fix (a Mesa revert or fix, or GTK setting `EGL_RENDERABLE_TYPE`) to reach Arch's port and rebuild the
  image; or a workaround in the desktop image (e.g. an `LD_PRELOAD` shim adding the attribute to `eglChooseConfig`,
  which needs a build in Podman).

## What's at hand

- **Both images, side by side:** `target/arch/desktop.qcow2` (Mesa 26.3.1, the current desktop image) and
  `target/arch/desktop-old.qcow2` (Mesa 26.2.7; a hard link to `../waarm64-ci/target/arch/desktop.qcow2`). **Keep
  the old one**: the port's mirror keeps no old Mesa, so it's the only working 26.2 there is. Login arch/arch.
- **A driver for a running guest** (git-ignored, local only): `bench/results/local/sway-drive.ts <image> <dir>` (env
  `GPU=virgl` for 3D) boots the image on the page in headless Chromium, logs in, starts sway, then takes commands
  from `<dir>/cmd-<n>.txt` and writes `<dir>/out-<n>.txt`: `run <cmd>` (root on the serial console), `user <cmd>`
  (in the sway session), `put <guest path> <local path>`, `shot <name>`, `click`, `key`, `wait`, `quit`. Run it
  under a memory cap (`systemd-run --user --scope -q -p MemoryMax=8G -p MemorySwapMax=0 -- timeout 3000 node …`).
  Wait for `<dir>/ready` first. Keys go where the focus is: `run` clicks the serial terminal, so `click` the screen
  before a `key`.
- **The repro in the guest** (as the user, in sway): `GDK_DEBUG=opengl GDK_DISABLE=offload gtk4-demo --run=shadertoy`
  (`GDK_DISABLE=offload`: another, known bug; docs/backlog.md "GTK4's graphics offload kills a GtkGLArea on virgl").
- **The guest has no compiler**, but it has Python: `bench/results/local/eglconfigs.py` (git-ignored) lists the
  configs and GDK's `eglChooseConfig` through ctypes (`put` it, then `user python3 /tmp/eglconfigs.py`). A `quit` in
  the same command file as other commands overwrites their output: give it its own file.

## The fix and the checks

- The cause isn't in our caps or device (above), so no 3D CI follows from it. A workaround in the image is an image
  change (images/arch/desktop/), checked on the page with both Mesas.
- A change to the caps or the renderer is a 3D change: `scripts/ci-graphics.sh` and `scripts/ci-deqp.sh` (a sample;
  `--full` before the end) besides `scripts/ci.sh`; dEQP's pass lists are the gate. Plant a check that fails without
  the fix (a test at the cheapest layer: the caps' unit tests if the cause is a cap).
- Check both Mesas after the fix: 26.3.1 gets a config and draws the shader; 26.2.7 still does.

## The demos and the deploys (state on 2026-11-22)

- **Deployed (disks.waarm64.com, waarm64.com): unchanged and working**, on the old desktop image (content id
  `aebf65542def…`, Mesa 26.2.7, the stock sway): `alpine-term`, `arch-desktop`, `arch-3d`. **Don't deploy** until
  this is settled (the user's call): the deployed files are, at a limit, where an older Mesa or GTK could be copied
  from (the image's pieces, ~1.9 GB, are also all in `target/disks/pieces/`, and the image whole in
  `target/arch/desktop-old.qcow2`).
- **The local site `target/disks/`** matches the deployed one (its ledger `.publish.json` and the two desktop demos'
  directories as deployed; every piece their manifests and snapshots name is there). Not touched since: no publish
  `--apply`.
- **The source `deploy/disks/demos.json`** (committed) has `alpine-term` and `arch-desktop` only: `arch-3d` is out, and
  `arch-desktop`'s card has the new desktop's notes and summary. A publish from it would retire `arch-3d` and refuse
  `arch-desktop` (its image changed: a new image is a new id with `replaces`, docs/decisions.md "Demos"; the user
  allows dropping the old versions instead, the site not being announced yet: clear their ledger entries and
  directories at that publish, as was done and undone on 2026-11-22).
- **A new `arch-desktop` template** is built in `target/demos/arch-desktop/` from the new `target/arch/desktop.qcow2`
  (Mesa 26.3.1, sway as a conventional desktop: images/arch/desktop/). Its desktop works (Firefox through GL); only
  GTK4's GL is broken. Publishing it before the fix is the user's call.
- **The Desktop Demo** (`desktop/` on the site: `?disk=…/desktop/prefetch.json`) is still the old image, with its own
  944 pieces (backlog "The desktop demos' loose ends").
- static.gbl08ma.com serves no desktop image any more (the user removed them).

## Bringing `arch-3d` back (at the end)

Its entry left `deploy/disks/demos.json` on 2026-11-22; the last version is in git
(`git show 4979f2aa:deploy/disks/demos.json`, the second desktop entry). Put it back, with its notes and summary
following `arch-desktop`'s current ones (the taskbar and Alt+F1 line). Add a sway rule or the countdown's own step to
open the shader demo maximized: windows float now (images/arch/desktop/etc/sway/config.d/60-waarm64.conf), and it
opens tall and narrow. Then `node tools/build-demos.ts --only arch-3d` and the publish plan (docs/remote-disks.md
"Deploying the demos"). Its thumbnail must show the shader, not the error. `tests/build-demos.test.ts` ("the source's desktops") expects one desktop demo
while it's out: make it two again.

## Needs the user's OK

Deploys (never without being asked). Changes to the host ABI or anything guest-visible beyond the caps' fix (say
what the guest sees differently). Forcing a Mesa version into the image isn't possible (the port drops old packages).
