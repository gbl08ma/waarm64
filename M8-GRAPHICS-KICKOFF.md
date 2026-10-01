# M8 graphics kickoff: G0 and G1, the 2D display

**Drafted 2026-10-01 in a cloud session; the user's answers are below** (section "The user's
answers"). Covers steps **G0** (the WebGPU environment spike, measured) and **G1** (virtio-gpu 2D:
the screen follows the page, damage instead of scans, a cursor, EDID) of
[docs/plans/graphics.md](docs/plans/graphics.md), the graphics track of PLAN.md §3 M8 phase C.
G2 onward (the software 3D baseline, Venus, the decision gate) get their own kickoff. The work runs
in the Lima VM `dev` (CLAUDE.md "Development environment"), not in a cloud session.

CLAUDE.md's conventions and working rules apply; `scripts/ci.sh` must pass at every commit that
isn't docs only. Work as in M8's other phases: short loops (one slice, one commit, a short report
each), and continue unless something needs the user's decision. Read first: PLAN.md §3 "M8",
docs/plans/graphics.md (all of it: §3 is G1's sketch), docs/devices.md (the split between core and
host, "Framebuffer", "input"), docs/frontend.md ("The screen", "Input", "Debian through UEFI",
"Snapshots"), docs/abi.md (device backends, ABI 29–30), docs/platform.md ("Boot", "Snapshots"),
docs/plans/uefi.md ("Graphics in the firmware"), docs/testing.md, and `web/display.ts`,
`web/devices.ts`, `web/app/worker.ts`, `web/app/main.ts`, `web/app/machine.ts`,
`core/src/virtio.rs`.

## What exists (2026-10-01)

- **The screen is a `simple-framebuffer`**: x8r8g8b8 of a fixed size (`VmConfig.fb_width`/
  `fb_height`; the page's Debian 1024×768, Buildroot 640×480), outside `/memory` since phase B so
  EDK2 doesn't allocate over it. `web/display.ts` runs on the **machine worker's** animation frames
  on a transferred `OffscreenCanvas`: it compares the whole buffer with the last frame (~0.4 ms at
  1024×768) and puts the changed rows. The page scales the canvas with CSS (integer multiples in
  device pixels when one fits, `pixelated`; smooth downscale otherwise). Key to glyph on the screen
  ~15 ms (Debian, fbcon), ~11 ms on the serial terminal; the page's main thread does no per-frame
  work, and that has to stay so (frontend.md "The screen" says why: a frame loop on the page cost
  the terminal ~20 ms).
- **Debian through UEFI:** EDK2 (ArmVirtQemuKernel, `images/build.sh edk2`) has **no graphics
  output**: firmware, GRUB and the first boot's questions are on the serial console, and the screen
  stays black until tty1's getty (GRUB passes no `console=tty0`). Our EDK2 build already contains
  `OvmfPkg/VirtioGpuDxe` (plans/uefi.md "Graphics in the firmware"), which would give it a GOP on a
  virtio-gpu. `images/build.sh edk2` patches TerminalDxe down to 80×25 (backlog: "remove if the
  UEFI ever gets graphical modes").
- **Debian's kernel** (6.12) has `simplefb` and `fbcon` built in; `virtio_gpu` is a **module on
  the root filesystem, not in the initrd** (M8 kickoff), loaded by udev after the root mounts.
  Alpine's linux-virt has it as a module too. The Buildroot test kernel (`images/linux.fragment`)
  has `FB_SIMPLE` and no fbcon, no DRM.
- **The virtio-mmio transport** (`core/src/virtio.rs`): ConfigGeneration is always 0, there is no
  config-change interrupt and **no host API to change config space under a running driver**
  (backlog "Platform and devices"); virtio-gpu's display events need both. SHM regions are absent
  (2D doesn't need them; 3D's `HOSTMEM` will). A config write is a `DEVICE` exit that waits for the
  device worker even in realtime mode (virtio-input's `select`).
- **Device backends** run in the device worker (TypeScript), twinned in Rust in
  `core/tests/common` for the native runners. The device worker serves the doorbell with
  `Atomics.waitAsync` (so it has an event loop and animation frames), but **blk over HTTP is a
  synchronous XHR per request** on that same thread.
- **Snapshots** (done): the core saves transports and in-flight chains; a backend with state of
  its own gives it as JSON (`Backend.save`/`restore`); RAM and the disk's changes go in the file.
  A snapshot pins the machine's configuration (the framebuffer size is in the header).
- **Input:** virtio-input keyboard and tablet (absolute, 0–32767 over the canvas's box), no
  pointer lock. The guest's cursor is drawn by the guest into the framebuffer (fbcon has none).
- THIRD_PARTY.md has crosvm (`rutabaga_gfx`, BSD-3) as the reference for the device side.

## The user's answers (2026-10-01; don't re-ask)

1. **Guest pixels are CSS pixels by default**, upscaled crisply (integer, `pixelated`) by
   `devicePixelRatio`, so fbcon's 8×16 font stays readable on a HiDPI screen. A **HiDPI setting**
   sends device pixels instead, with the physical size in the EDID so desktops (GNOME, KDE) choose
   their own scale. Remembered per browser, like the view.
2. **G1 is agent-free.** Resize goes through virtio-gpu's display events and EDID only. A guest
   agent becomes **its own later step** (the host-integration track), starting from the stock
   agents' protocols (spice-vdagent, qemu-guest-agent) so distro packages work unmodified. The
   brainstorm below ("The guest agent") is the background for that step, not work for this one.
3. **Our own agent, if one is built later, reaches arbitrary images both ways, the tools disk
   first:** a read-only tools disk the page attaches (the user installs once), and an opt-in
   zero-touch path on systemd ≥ 256 (a unit through a systemd credential over fw_cfg, nothing
   written to the disk).
4. **The tests get a separate kernel variant**, `Image-gpu` (as `images/crypto` does it), and a new
   test guest with its own row in `tests/steps.txt`; the existing step counts don't move.

## Goal

**Done when:** the page's Debian draws through virtio-gpu, and its screen has the page's size:
the canvas shows the guest's pixels 1:1 in CSS pixels (or device pixels with HiDPI on) with no
scaling blur, from the firmware's menu (EDK2's GOP, if loop 0 confirms it) through the console to
any desktop the user installs. Resizing the window, switching views or entering full screen tells
the guest the new size, and guests that follow it (a Wayland desktop, the console at its next
boot) take it; guests that don't are letterboxed, never cropped or stretched. Only damaged
rectangles are copied; the guest's hardware cursor is the host's pointer. Snapshots keep working.
The display is byte-exact in deterministic mode, natively and in Chromium, and G0's numbers say
how to present frames and what WebGPU in Chromium gives the 3D steps.

## Design to start from (proposals; loops settle them by measurement)

### The device
- **virtio-gpu (device ID 16), 2D only:** controlq and cursorq; feature `VIRTIO_GPU_F_EDID`; config
  space `events_read`, `events_clear`, `num_scanouts` = 1, `num_capsets` = 0. Commands:
  `GET_DISPLAY_INFO`, `GET_EDID`, `RESOURCE_CREATE_2D`, `RESOURCE_UNREF`, `SET_SCANOUT`,
  `RESOURCE_FLUSH`, `TRANSFER_TO_HOST_2D`, `RESOURCE_ATTACH_BACKING`, `RESOURCE_DETACH_BACKING`,
  `UPDATE_CURSOR`, `MOVE_CURSOR`; everything else `ERR_UNSPEC`, bad IDs and rectangles the
  spec's errors. The fence flag is echoed and completes at once (2D work is synchronous).
  Formats: the eight 32-bit ones in the spec (Linux's primary plane uses `B8G8R8X8`, the cursor
  `B8G8R8A8`).
- **Backing pages are guest addresses inside the payload**, which the core's chain checks don't
  cover: the backend checks every entry lies in RAM (else an error response, never a read outside
  RAM). `TRANSFER_TO_HOST_2D` gathers the rectangle from the scatter list into the host resource,
  converting to what the presentation path wants (RGBA for `ImageData`, or raw for a shader that
  swizzles: loop 1 decides). Host resources are JS memory in the backend, capped (a size limit per
  resource and in total, refused with `ERR_OUT_OF_MEMORY`), not wasm memory.
- **Display events need the core:** a host API to update a device's config space and raise the
  config-change interrupt (InterruptStatus bit 1, ConfigGeneration bumped), safe against vCPUs
  reading config in parallel SMP; `events_clear` handled as write-1-to-clear. It's an ABI change:
  **the design note in docs/abi.md first** (pre-approved, as in earlier phases), then ABI 31. It
  also covers the backlog's other users of the same gap (console resize, capacity change, net link
  state) without implementing them. If the core's saved state changes, `SNAPSHOT_VERSION` moves.
- **The Rust twin** (`core/tests/common/gpu.rs`) gives the native runners the same bytes, as for
  9p and net.

### The page's machine
- **virtio-gpu replaces the `simple-framebuffer` on the page's Debian.** With both, fbcon stays on
  the first framebuffer registered: virtio-gpu over virtio-mmio removes no conflicting firmware
  framebuffer (its aperture hand-off is PCI-only), so the console would never move to it
  (expected; loop 0 confirms on the oracle). Guests without the driver (the Buildroot page machine,
  the tests' guests, kernels without DRM) keep the simple framebuffer; `machine.ts` says which
  machine has which.
- **What the user sees through UEFI** (expected; loop 0 confirms): EDK2's `VirtioGpuDxe` gives a
  GOP, so EDK2's own screens and GRUB's menu (text through ConOut, mirrored to the serial console)
  appear on the screen. VirtioGpuDxe's GOP is reportedly **Blt-only** (no linear framebuffer), so
  GRUB can't use `gfxterm` on it and Linux gets no `efifb`: the screen goes dark from GRUB's
  hand-off until udev loads `virtio_gpu` (Debian: after the root mounts), then fbcon takes tty1.
  Today the screen is black until the getty anyway, so this is a net gain. Re-check the
  TerminalDxe patch once the GOP exists (ConSplitter's text modes are those every console
  supports).

### Presentation
- **Which thread draws is a measurement, not a given.** graphics.md proposed the device worker
  (flushes don't cross threads). Against it: blk's synchronous XHRs block that thread, so a flush
  would wait behind a disk read. The alternative: the backend writes host resources into a
  `SharedArrayBuffer` and posts damage to the machine worker (which draws today) or a display
  worker of its own. Loop 4 measures key-to-glyph and a flush during disk I/O both ways.
- **The API is loop 1's measurement:** canvas 2D (`putImageData` of the damaged rectangle, a
  swizzle in JS) against WebGL2 (`texSubImage2D` of raw bytes, the swizzle in the shader) and,
  for later reuse, WebGPU (`writeTexture`). graphics.md says a 2D context is enough; keep it unless
  the numbers say otherwise at 1080p and 1440p.
- **Draw on flush, at most once per animation frame**: damage accumulates between frames. No
  scans of guest memory at all on a virtio-gpu machine.
- The canvas's backing store is the scanout's size; when the guest changes it, the worker resizes
  the canvas and tells the page (`mode {width, height}`), which refits the CSS box. **Letterbox,
  never stretch:** a scanout smaller or larger than the view is shown centred, scaled by an integer
  factor when one fits, smoothly down otherwise (as today). The tablet maps through the drawn
  rectangle, not the element.

### Resize: what follows the page without an agent
- **The page measures the screen's box** (the view's area for the screen, in CSS pixels, times
  `devicePixelRatio` with HiDPI on), **debounced** (a few hundred ms after the last change, and
  not while a pointer drag is resizing), and sends it to the backend, which answers
  `GET_DISPLAY_INFO` with it, regenerates the EDID and raises `VIRTIO_GPU_EVENT_DISPLAY`. The
  **start message carries the initial size**, so the console and the firmware get the page's size
  at boot with no event at all.
- **Sizes:** width rounded down to a multiple of 8 (Linux's CVT rounds widths so: without it the
  guest picks a mode 1–7 px narrower and the page letterboxes a sliver), a minimum (640×480) and a
  maximum (EDID's detailed timings stop at 4095 px a side: a cap, or a DisplayID extension block
  if 5K HiDPI is wanted; decide in loop 5 by what it costs). The EDID is ours (128-byte base block,
  CVT reduced-blanking timings for the preferred mode, the physical size from the DPI, a few
  standard modes), checked with `edid-decode` in the dev VM (dev-only, `sudo zypper in` if
  packaged) and by the guest's `/sys/class/drm/*/edid`.
- **What the guest does with it** (expectations; loop 0 measures each on the oracle, loop 5 on our
  machine, and the docs record the table):

  | Guest software | Expected on a display event | Without an agent |
  |---|---|---|
  | fbcon (DRM's fbdev emulation) | The fbdev buffer is allocated once at the first probe, at the preferred mode; a hotplug re-probes **within** that size (no growing; a shrink may crop the console) | Right size at boot only; letterboxed after. No agent can change this (it's the kernel); a userspace console on KMS (kmscon) would be the guest's choice |
  | GNOME (mutter), KDE (kwin) on Wayland | Follow the new preferred mode (they key on the connector's `hotplug_mode_update`) | Live resize |
  | wlroots (sway, cage, labwc), weston | Unknown | Measure: G2 picks its compositor partly by this |
  | Xorg (modesetting) | Mode list updates, nothing applies it | Needs `xrandr --auto` in the session: an agent's job (spice-vdagent does it) |

  If fbcon does crop on a shrink (loop 0), keep the console usable without an agent: the EDID can
  list the size the console was born with as a second detailed timing, so a re-probe within the
  fbdev's size picks it; a smaller preferred mode still wins, so the measurement decides whether
  the page should avoid sending shrinks while the scanout resource is the one created at boot.
  Choose by what loop 0 shows, and write the policy down.
- **Full screen** is just another size. A fixed-size option ("Screen size: fit / 1024×768 /
  1280×800 / 1920×1080") in the Screen menu is cheap and useful for screenshots and tests: add it.

### Cursor
- `UPDATE_CURSOR`'s 64×64 `B8G8R8A8` resource becomes a **CSS cursor** on the screen element
  (`cursor: url(<data or blob URL>) hotX hotY, none`, scaled by the canvas's current scale so it
  matches the guest's pixels; Chromium caps CSS cursors at 128×128, beyond that fall back to an
  overlay). Since the tablet is absolute, the host pointer *is* the guest pointer, so the cursor
  moves at the host's rate with no round trip. Resource 0 hides it. A `MOVE_CURSOR` that
  disagrees with the pointer (a guest warping the cursor) is drawn on a small overlay canvas until
  the pointer moves; check whether any guest in scope does it before building more than that.
- The Buildroot gpu guest tests the cursor's bytes deterministically; the page test checks the
  CSS cursor appears and hides.

### Snapshots
- The backend's state is small: the resource table (ID, format, size, backing entries), the
  scanout, the cursor. It goes through `Backend.save` as JSON. **Host resources' pixels aren't
  saved:** a restore re-reads every resource from its backing in the restored RAM (a full
  transfer) and redraws the scanout. A guest that wrote its backing without transferring shows
  the newer pixels until its next flush, which is harmless; write it down.
- The header's machine description gains the display device; a restore into a page of another
  size sends a display event after resuming. `tests/page-snapshot.test.ts` covers a gpu machine.

### Determinism and the tests
- 2D is byte-exact. A **gpu test guest**: Buildroot's rootfs on `Image-gpu` (allnoconfig + the
  fragment + `images/gpu/linux.fragment`: `DRM`, `DRM_VIRTIO_GPU`, `DRM_FBDEV_EMULATION` for
  `/dev/fb0`, no fbcon) and a small static KMS test program of ours (C, built in `images/` in
  Podman: dumb buffers, a mode set, damage through `DRM_IOCTL_MODE_DIRTYFB`, the cursor ioctls,
  a mode change after a display event), on the guest's own appended initramfs cpio or a disk of
  its own so the shared rootfs (and every other step count) doesn't move. The test reads the
  scanout back (natively from the twin's resource, in Chromium from the canvas) and compares
  hashes. Exact steps in every runner, a new `tests/steps.txt` row.
- **A display event at a fixed step** in deterministic mode (as console input is injected), so
  the resize path is exact too.
- Fuzz the backend's command parser like the virtqueue (`core/fuzz` on the twin, or a Node
  random-command test): it parses untrusted guest data.
- QEMU's `virtio-gpu-device` is the behavioral oracle (loop 0); its trace events
  (`virtio_gpu_cmd_*`) give the reference command sequences of Debian's driver.

## Loops (order is a suggestion; the numbers decide)

0. **The oracle.** `qemu-system-aarch64` in the dev VM with `-device virtio-gpu-device` (mmio, no
   PCI), our EDK2 through `tools/uefi-oracle.ts`, Debian 13's image. Settle where it's cheap to
   see: whether VirtioGpuDxe gives a GOP over virtio-mmio, Blt-only or not, and what appears on
   the screen (EDK2, GRUB); what Linux does with a `simple-framebuffer` and a virtio-gpu together
   (which one fbcon uses); when Debian loads `virtio_gpu`; the command sequence (trace events);
   and the resize table above: fbcon growing and shrinking, GNOME on Wayland, one wlroots
   compositor (cage or sway), Xorg. QEMU changes its display size when a VNC client sends
   `SetDesktopSize` (a small dev-only RFB client in `bench/results/local/`, or a QMP command if
   QEMU 11 has one). Desktops come from Debian's packages over QEMU's user network, in a
   throwaway overlay. Record it in graphics.md (a "G1 loop 0" section, as uefi.md did).
1. **G0, measured.** A bench page (`bench/gpu/` or similar) run headless in the dev VM:
   - a WebGPU adapter in headless Chromium without a GPU (SwiftShader or Dawn on lavapipe: find
     the flags that work); its features and limits, recorded as JSON;
   - `queue.writeBuffer`/`writeTexture` from views of a `SharedArrayBuffer` (accepted? copied?
     cost at 1080p, 1440p, 4K);
   - WebGPU and WebGL2 on an `OffscreenCanvas` in a worker;
   - the 2D presentation paths above, per frame, full frame and a 10% damage rectangle, at the
     same sizes: medians and IQR from `bench/run.ts`, JSON committed, a section in a
     `bench/gpu/REPORT.md` (new) or `bench/boot/REPORT.md`.
   Software-adapter numbers are for correctness and relative costs only. **How real-GPU numbers
   are taken is the user's decision** (below); propose it in the loop's report.
2. **The core: config changes.** The abi.md design note, then the config-space update API, the
   config-change interrupt, ConfigGeneration, write-1-to-clear for `events_clear`, snapshot state
   if it changes. Unit tests on hand-built rings (the event raised, read, cleared; a generation
   seen to move mid-read retried), natively and in wasm.
3. **The device.** The backend (TypeScript) and its twin, the EDID generator (unit-tested,
   `edid-decode` as the oracle), `Image-gpu` (`images/build.sh`), the gpu test guest with its KMS
   program, byte-exact natively, then in Node and Chromium with the same steps. Planted: a
   transfer off by a row, a backing entry outside RAM accepted, a stride ignored.
4. **On the page.** The page's Debian on virtio-gpu (no simple framebuffer), the presentation
   thread chosen by measurement (key-to-glyph against today's ~15 ms, a flush during a disk read),
   damage-only drawing, the `screen` event, letterboxing and the tablet through it, the firmware's
   GOP if loop 0 found one. `tests/page-debian.test.ts` keeps passing (its screen login now goes
   through virtio-gpu); screenshots.
5. **Resize.** The page's size to the guest (debounced, the start size, CSS pixels and the HiDPI
   setting, rounding and caps, full screen, the fixed sizes), the fbcon policy from loop 0, the
   resize table measured on our machine. A page test: change the viewport, the guest's connector
   lists the new preferred mode (`/sys/class/drm/card*-Virtual-1/modes` over the serial console),
   the canvas follows what the guest sets, the console never crops.
6. **Cursor.** CSS cursor, hiding, scaling, the overlay for warps if needed; the gpu guest's
   cursor bytes; the page test.
7. **Snapshots.** Backend state, the restore's re-transfer, a restore into another page size;
   the page's snapshot test on a gpu machine. Planted: the scanout not restored.
8. **Exit.** Numbers (below); the backlog's framebuffer item closed or rewritten for the
   simple-framebuffer machines that remain; docs: devices.md (virtio-gpu), frontend.md (the
   screen, resize, HiDPI, cursor), abi.md, platform.md, testing.md, images.md (`Image-gpu`);
   graphics.md updated with what G0 and G1 found and G2's next step; PLAN.md's graphics line; the
   agent step written up as a plan doc (`docs/plans/agent.md`) from the brainstorm below plus what
   loops 0 and 5 measured; new backlog entries; a proposed outline for G2's kickoff. Delete this
   kickoff and any handover in the exit commit (CLAUDE.md).

## The guest agent (brainstorm for the later step; not G1's work)

**Is one needed for resize?** Mostly not. The console gets the page's size at boot from the
preferred mode, and Wayland desktops that follow the preferred mode resize live (both agent-free,
to be confirmed in loops 0 and 5). An agent is needed for **X11 sessions** (someone has to run
`xrandr --auto` inside the user's session) and for any compositor that ignores the preferred mode.
**No agent can make fbcon resize live**: its buffer size is the kernel's. The agent earns its place
through everything else a host wants from a guest:
- **clipboard** both ways (the backlog's "Clipboard for the screen"), including copying text from
  a text console (`/dev/vcsN` is readable by a root agent: only our own agent could offer that);
- **time after a resume** (the backlog: the guest's clock lags a restored snapshot until something
  sets it);
- **a ready signal** instead of matching a login prompt on the serial output (backlog "The page");
- graceful power-off and reboot from the page; mounting a dropped-in 9p share; reporting the
  guest's IP or OS name in the status line.
  (A power button alone needs no agent: `KEY_POWER` on the virtio-input keyboard makes
  systemd-logind power off. Worth a line in the host-integration track.)

**The stock agents first** (the user's answer 2):
- **spice-vdagent** (GPL-3, a guest workload only; packaged in Debian, Alpine, Fedora, Ubuntu,
  Arch; preinstalled on many desktop images) talks the VDAgent protocol on a virtio-serial port
  named `com.redhat.spice.0`; udev starts it when the port appears. Monitor configuration (X11
  resize through xrandr; on Wayland it leaves resize to the compositor), the clipboard (X11, and
  GNOME on Wayland in recent versions), and the mouse mode. The host side is ours, written from
  the protocol's spec and headers (check spice-protocol's license in THIRD_PARTY.md before reading
  its headers as more than a reference).
- **qemu-guest-agent** (GPL-2, a guest workload; packaged everywhere, started by a unit bound to
  its port `org.qemu.guest_agent.0`): JSON commands, among them `guest-set-time`,
  `guest-shutdown`, `guest-get-osinfo`, `guest-network-get-interfaces`, `guest-exec` (useful to
  tests too). No display or clipboard.
- **What both need from us:** virtio-console's **multiport** feature (the control queue, named
  ports) and its receive path (today its receive buffers are held forever: backlog). That's the
  first slice of the agent step. Delivery is the distro's package manager (the guest has a network
  since the networking track) or nothing, on images that ship them.

**Our own agent, only for gaps the stock ones leave** (the console's clipboard, a ready signal on
non-systemd guests, anything webpc-specific): a small static aarch64 binary (Rust, musl), on a port
of its own (`org.webpc.agent.0` or similar), a tiny line protocol. Delivery to arbitrary images
(the user's answer 3):
1. **The tools disk, first:** the page attaches a read-only `WEBPC-TOOLS` FAT disk (web/fat.ts
   already writes FAT, for Alpine's CIDATA seed) with the binary, a systemd unit, an OpenRC
   script and `install.sh`; the user mounts it and runs the installer once, as with VirtualBox's
   Guest Additions. Works on any distro, and the result travels with the disk (export, snapshots).
2. **Zero-touch, opt-in, on systemd ≥ 256** (Debian 13 has 257; Arch, Fedora): the
   `systemd.extra-unit.*` credential over fw_cfg (the path the network card's settings already
   use) adds a unit at boot that runs the binary straight from fw_cfg
   (`/sys/firmware/qemu_fw_cfg/by_name/…/raw`, Debian loads `qemu_fw_cfg`). Nothing is written to
   the disk, and it's gone when the option is off. Not for OpenRC (Alpine): the tools disk.
3. Rejected: writing into the user's disk image (touches their disk behind their back, needs an
   ext4 writer, distro-specific); injecting into an initrd (UEFI images load their own).

## Check with the user first
- Any dependency (none is expected: the EDID, the backend and the presentation are ours).
- **Real-GPU measurements** (G0): the dev VM has no GPU. Running Chromium on the Mac host
  (outside the VM) is the user's machine and needs their OK; the x86_64 desktop is off limits.
  Propose a way in loop 1's report; until then, software adapters only.
- Changes to the tests' guests or their step counts (`Image-gpu` and the gpu guest are new, not
  changes); changes to the Debian image's bytes (never).
- Anything the user sees change on the page beyond this brief (the screen's default size policy,
  removing the fixed 1024×768 entirely, a new menu).
- Anything that makes the headless boots or benchmarks slower beyond noise (the page's Debian
  loading `virtio_gpu` costs some boot time: measure it).
- Starting G2 or the agent step: this kickoff ends at its exit report.

## Validation per loop
Tests at the cheapest layer: core unit tests (config changes), Node tests of the backend and the
EDID generator, the gpu guest byte-exact in every runner with exact steps, the page tests in
Chromium (repeated: realtime is nondeterministic), screenshots at each loop's end in
`bench/results/local/` (committed only if small and useful). Planted bugs where a rule is new (the
ones named in the loops, plus a display event never raised, damage outside the rectangle drawn,
a cursor hotspot ignored). `scripts/ci.sh` at every code commit; `scripts/ci-long.sh` if the core
change touches parallel SMP's config path.

## Numbers
- **Key to glyph on the screen** (Debian, fbcon on virtio-gpu) against today's ~15 ms, and on the
  serial terminal (~11 ms: must not move).
- **Per-flush cost** (device side and drawing) at 1080p and 1440p, full frame and damaged, and the
  page's main-thread cost (zero today: keep it).
- **Page load to `running`** for the page's Debian (53 s through UEFI today): `virtio_gpu` loading
  must not cost beyond noise; time to the first pixel on the screen (EDK2's GOP vs today).
- Host memory for resources at the largest size allowed.
- G0's table: the adapter, its limits, `writeBuffer`/`writeTexture` from shared memory, each
  presentation path.
Medians and IQR from `bench/run.ts` in Chromium, host and Chromium versions, JSON committed behind
any written report (CLAUDE.md "Performance").

## Out of scope
3D of any kind (G2 onward), virtio-gpu's 3D features (`CONTEXT_INIT`, blob resources, `HOSTMEM`),
multiple scanouts (only if someone asks), a guest agent (a later step: the brainstorm above), pointer
lock and relative mouse (host-integration track), the Firefox/Safari pass, ACPI.

## Report at the end of each loop, then continue
What changed; validation (tests added, planted bugs, repeated runs); numbers where relevant; a
screenshot or the forwarding command (`ssh -L …` through `macmini.lan`) when there's something to
look at; choices the user may want to overrule; next loop.
