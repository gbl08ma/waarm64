#!/usr/bin/env bash
# The desktop guest (docs/images.md "Arch Linux"; audio S3, docs/audio.md "Decisions"): Arch Linux (arch.bens.haus's
# aarch64 port) with sway (set up as a conventional desktop: images/arch/desktop/, docs/images.md), foot, fuzzel, jq, Firefox, Chromium (bench/gpu/chromium-flicker.ts), htop, nano, lsof, gtk4-demo (bench/gpu/gtk4-load.ts), mesa-utils, Mesa's Venus
# driver and vulkan-tools (Vulkan on a machine with it: docs/devices.md "Venus"), Xwayland (X11 programs under sway: their
# Vulkan windows through Mesa's prime blit, vk/README.md "Presentation"; GD G7) and PipeWire (WirePlumber, its PulseAudio and ALSA ends), sound through
# the kernel's own virtio_snd module, VA-API through waarm64's driver (our waarm64-va package, docs/graphics.md "Video"), and the
# media of images/arch/media.sh in /home/arch/media. A 20 GiB root, mostly free (the qcow2 is compressed and keeps
# none of it), for packages installed by hand. On demand only: not part of images/build.sh, CI or any test (~10 min,
# mostly pacman and the container builds; the mirror's packages of the day).
#   images/arch/desktop.sh [--kde] [--out file.qcow2]     (default target/arch/desktop.qcow2; EXTRA_PACKAGES adds packages, e.g. gdb)
# --kde (default target/arch/desktop-kde.qcow2): KDE Plasma too (plasma-meta, konsole) and plasma-login-manager, which
# starts at boot on the screen (plasmalogin.service): for reproducing what KDE does (its login screen's sleep key, its
# session); not in CI or any test (~20 min).
# Login arch/arch (the screen) or root/root (the serial console); then `sway` (with 3D, WLR_RENDERER=gles2; see
# docs/frontend.md), and e.g. `firefox file:///home/arch/media/avsync.html?v=sintel.webm`, `mpv ~/media/sintel.webm`,
# `aplay -l`, `wpctl status`. bench/audio/avsync.ts measures A/V sync and the decode's cost on it; bench/gpu/sway-load.ts,
# firefox-load.ts and gtk4-load.ts the graphics.
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/../.." && pwd)
W=$ROOT/target/arch
OUT=
KDE=
while [ $# -gt 0 ]; do
  case $1 in
    --out) OUT=$(realpath -m "$2"); shift 2 ;;
    --kde) KDE=1; shift ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
done
PACKAGES="sway foot fuzzel jq firefox htop ttf-dejavu pipewire pipewire-pulse pipewire-alsa wireplumber alsa-utils mpv libva-utils
  gtk4-demos mesa-utils chromium nano lsof vulkan-virtio vulkan-tools xorg-xwayland xorg-xdpyinfo ${EXTRA_PACKAGES:-}"
[ -z "$KDE" ] || PACKAGES="$PACKAGES plasma-meta plasma-login-manager konsole"
[ -n "$OUT" ] || OUT=$W/desktop${KDE:+-kde}.qcow2

echo "==== waarm64-va"
rm -f "$W"/pkg/waarm64-va-*
"$ROOT/images/arch/waarm64-va.sh"
echo "==== simdutf36-compat"
"$ROOT/images/arch/simdutf36.sh"
echo "==== media"
"$ROOT/images/arch/media.sh" "$W/media"

FILES=$W/desktop-files
rm -rf "$FILES"; mkdir -p "$FILES/root/pkg" "$FILES/home/arch/media"
cp "$W"/pkg/{waarm64-va,simdutf36-compat}-*.pkg.tar.* "$FILES/root/pkg/"
# sway as a conventional desktop: its drop-in, the taskbar's script, the menu's settings (images/arch/desktop/).
cp -a "$ROOT/images/arch/desktop/." "$FILES/"
cp "$W"/media/{avsync.webm,sintel.webm,sintel-silent.webm,sintel_trailer-480p.mp4,avsync.html} "$FILES/home/arch/media/"
echo "==== image"
"$ROOT/images/arch/build.sh" --out "$OUT" --root-mib 20480 --packages "$PACKAGES" --files "$FILES" --setup "$ROOT/images/arch/desktop-setup.sh"
rm -rf "$FILES"
