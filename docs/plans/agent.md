# A guest agent (a plan for the host-integration track; not scheduled)

**Status:** written at the exit of M8 graphics G1 (2026-10-02) from that step's brainstorm and
measurements. Nothing here is built. The user decided on 2026-10-01 that G1 stays agent-free, that
the agent is **its own later step**, that it **starts from the stock agents' protocols**
(spice-vdagent, qemu-guest-agent) so distro packages work unmodified, and that an agent of ours, if
one is built, reaches arbitrary images **through a tools disk first**, with an opt-in zero-touch
path on systemd ≥ 256.

## What an agent is for

What G1 measured on our machine
([graphics.md](graphics.md) §9, §13, §17):

| Guest software | What a display event does | An agent would |
|---|---|---|
| fbcon (DRM's fbdev emulation) | Nothing useful: its buffer has the size it was born with; a bigger mode is refused, a smaller one crops (the display bounces it). Right size at boot only | Nothing: the buffer's size is the kernel's. A userspace console on KMS (kmscon) is the guest's choice |
| sway 1.12 (wlroots), `WLR_RENDERER=pixman` | The kernel lists the new mode; sway keeps its own (wlroots seems to read the modes only when an output connects) and `swaymsg output … mode WxH` falls back silently | Run `swaymsg -- output Virtual-1 mode --custom WxH` (measured: the screen follows), or speak wlr-output-management as `wlr-randr` does |
| GNOME (mutter), KDE (kwin) on Wayland | Expected to follow (they key on the connector's `hotplug_mode_update`); not measured | Nothing needed, if so |
| Xorg (modesetting) | The mode list updates and nothing applies it | Run `xrandr --auto` in the user's session: spice-vdagent does |

So of what was measured, nothing follows the page's size by itself, and what can follow needs someone
inside the session to say so: resize is an agent's job after all (GNOME and KDE may not need it). The
rest of what a host wants from a guest:

- **the clipboard**, both ways (backlog "Clipboard for the screen"), including text copied from a
  text console (`/dev/vcsN` is readable by a root agent: only an agent of ours could offer that);
- **the time after a resume** (a restored or suspended machine's clock lags until something sets it:
  backlog "Snapshots");
- **a ready signal**, instead of matching a login prompt on the serial output (backlog "The page");
- a graceful power-off and reboot from the page, mounting a dropped-in 9p share, the guest's
  address or OS name in the status line.

A power button alone needs no agent: `KEY_POWER` on the virtio-input keyboard makes systemd-logind
power off. Worth a line in the host-integration track.

## The stock agents first

- **spice-vdagent** (GPL-3: a guest workload only; packaged in Debian, Alpine, Fedora, Ubuntu,
  Arch; preinstalled on many desktop images) talks the VDAgent protocol on a virtio-serial port
  named `com.redhat.spice.0`; udev starts it when the port appears. It does monitor configuration
  (X11's resize through xrandr; on Wayland it leaves that to the compositor), the clipboard (X11,
  and GNOME on Wayland in recent versions) and the mouse mode. The host side is ours, written from
  the protocol's specification; check spice-protocol's license in `THIRD_PARTY.md` before using its
  headers as more than a reference.
- **qemu-guest-agent** (GPL-2: a guest workload; packaged everywhere, started by a unit bound to
  its port `org.qemu.guest_agent.0`): JSON commands, among them `guest-set-time`,
  `guest-shutdown`, `guest-get-osinfo`, `guest-network-get-interfaces`, `guest-exec` (useful to the
  tests too). No display or clipboard.
- **What both need from us, and the step's first slice:** virtio-console's **multiport** feature
  (the control queue, named ports) and its receive path (today its receive buffers are held for
  good: backlog "Platform and devices"). The agents then come from the distro's package manager
  (the guest has a network since the networking track), or are already on the image.

## An agent of ours, only for the gaps

For what the stock ones leave (the console's clipboard, a ready signal on non-systemd guests,
anything webpc-specific): a small static aarch64 binary (Rust, musl) on a port of its own
(`org.webpc.agent.0` or similar) with a line protocol. Reaching arbitrary images:

1. **The tools disk, first.** The page attaches a read-only `WEBPC-TOOLS` FAT disk (`web/fat.ts`
   already writes FAT, for Alpine's CIDATA seed) with the binary, a systemd unit, an OpenRC script
   and `install.sh`; the user mounts it and runs the installer once, as with VirtualBox's Guest
   Additions. Works on any distro, and the result travels with the disk (export, snapshots).
2. **Zero-touch, opt-in, on systemd ≥ 256** (Debian 13 has 257; Arch, Fedora): the
   `systemd.extra-unit.*` credential over fw_cfg (the path the network card's settings already
   use) adds a unit at boot that runs the binary straight from fw_cfg
   (`/sys/firmware/qemu_fw_cfg/by_name/…/raw`; Debian loads `qemu_fw_cfg`). Nothing is written to
   the disk, and it's gone when the option is off. Not for OpenRC (Alpine): the tools disk.
3. Rejected: writing into the user's disk image (it touches their disk behind their back, needs an
   ext4 writer, and is distro-specific); injecting into an initrd (UEFI images load their own).

## Order, when it is scheduled

1. virtio-console multiport and its receive path (unit tests on hand-built rings, a Buildroot guest
   echoing through a named port in every runner).
2. qemu-guest-agent's host side: time after a resume, shutdown, the OS's name; a ready signal for
   the page and the tests where the agent is installed.
3. spice-vdagent's host side: the clipboard, then monitor configuration for X11 sessions. (It won't resize sway:
   a wlroots session needs the command above, which is a reason for step 4 or for a note in the docs.)
4. Only then, and only for a gap that is still wanted: the tools disk and our own agent.

Each needs the user's OK before it starts (a new device feature in every guest's path, and a new
thing a user is asked to install).
