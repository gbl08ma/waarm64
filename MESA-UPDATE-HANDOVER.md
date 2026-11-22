# Mesa 26.3 on our virgl: GTK4 finds no EGL config — handover

A brief for a fresh session: find why GTK4 gets no EGL config from Mesa 26.3's virgl driver on our device, fix it on
our side (the emulator), and bring the `arch-3d` demo back. Read CLAUDE.md first; then docs/graphics.md (the guest's
3D, "The caps", GTK4), `web/virgl.ts` (`virglCaps`) and docs/backlog.md "GTK4 finds no EGL config on Mesa 26.3's
virgl".

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

**The first lead to rule out: Vulkan.** GTK4 tries Vulkan first (Mesa's virtio ICD, `vulkan-virtio`, from the same
Mesa) and falls back to GL (docs/graphics.md "GTK4"). On 26.3.1, `GDK_DEBUG=opengl` printing nothing at all suggests
GDK never initialised EGL, rather than finding no config; the 26.3.1 run did print `Vulkan: Loader Message:
setup_loader_term_phys_devs: Failed to detect any valid GPUs` and a `vkEnumeratePhysicalDevices()` error (whether
26.2.7 prints the same wasn't recorded). Try `GDK_DISABLE=vulkan` (and `GSK_RENDERER=gl`) on 26.3.1 first, and diff
the whole `GDK_DEBUG=opengl,vulkan` output between the two Mesas. If that's it, the question becomes what 26.3's virtio
ICD now does on a device without Venus (our virtio-gpu's capsets: a machine without Vulkan offers none for Venus).
(Not the same thing as backlog "maintenance8's cases wait for the guest's Mesa 26.3", which is Venus picking up
maintenance8; but 26.3 is now the port's, so that item is actionable too: rebuild the dEQP-VK guest and move the list.)

**Ruled out on 2026-11-22** (26.3.1, the rebuilt image, virgl on SwiftShader): `GDK_DISABLE=offload,vulkan` changes
nothing (still "No EGL configuration available"). `EGL_LOG_LEVEL=debug` prints nothing from GTK's process, and
`GDK_DEBUG=opengl,dmabuf,misc` (211 lines: the globals, shm formats, sway's dmabuf table of 90 entries) has no GL or
EGL line at all: **GTK never reaches EGL**, so look at what GDK checks before `gdk_display_init_egl` (GTK 4.24's
`gdk/wayland/gdkdisplay-wayland.c` and `gdk/gdkdisplay.c`: `gdk_display_prepare_gl`, its reasons to skip GL, e.g. a
software or unsupported device seen through `EGL_EXT_device_query`, epoxy finding libEGL), and only then at Mesa's
configs. On 26.2.7 the same command prints `EGL API version 1.5 found …` first.

If not, the likely shape (not verified): Mesa's EGL/DRI builds its config list from the driver's formats (the gallium
screen's `is_format_supported` with display-target/scanout bindings, or a new requirement in 26.3's dri2/kopper
config code), and our device's caps (`virglCaps`, what virglrenderer's host side reports) no longer give a format
or binding 26.3 now checks, so the configs GTK wants (window surface, RGBA8888, alpha, ES 3 renderable; GTK uses
`EGL_EXT_config_select_group`, `EGL_KHR_no_config_context`) disappear. Possibly Wayland-platform only. Mesa is MIT:
its source can be read and quoted (THIRD_PARTY.json rules for anything ported). Compare 26.2.7 and 26.3.1 in
`src/gallium/drivers/virgl/`, `src/gallium/winsys/virgl/`, `src/egl/drivers/dri2/` (`dri2_add_config`,
`platform_wayland.c`) and `src/gallium/frontends/dri/` (the config list).

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
- **The guest has no compiler.** Mesa-utils' `eglinfo` no longer lists configs. To see the configs on both versions,
  build a small static aarch64 program (`eglGetConfigs` plus each config's attributes; `eglChooseConfig` with what
  GDK asks for) in Podman (images/ rules: rootless Podman, never cross toolchains on the host) and `put` it into the
  guest; or install `gcc` in a copy of the image with `pacman -S` (the guest needs a network: the page's).
  `EGL_LOG_LEVEL=debug` and `MESA_DEBUG` are worth a try first.

## The fix and the checks

- The fix is on our side if it's in our caps or device (`web/virgl.ts`, the renderer). If it's a Mesa bug (a check
  that real hardware passes only by accident), say so with the evidence and propose the least change on our side.
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
