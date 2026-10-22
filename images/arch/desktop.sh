#!/usr/bin/env bash
# The desktop guest (docs/images.md "Arch Linux"; audio S3, docs/audio.md "Decisions"): Arch Linux (arch.bens.haus's
# aarch64 port) with sway, foot, Firefox, Chromium (bench/gpu/chromium-flicker.ts), htop, gtk4-demo (bench/gpu/gtk4-load.ts), mesa-utils and PipeWire (WirePlumber, its PulseAudio and ALSA ends), sound through
# the kernel's own virtio_snd module, VA-API through webpc's driver (our webpc-va package, docs/plans/video.md), and the
# media of images/arch/media.sh in /home/arch/media. A 20 GiB root, mostly free (the qcow2 is compressed and keeps
# none of it), for packages installed by hand. On demand only: not part of images/build.sh, CI or any test (~10 min,
# mostly pacman and the container builds; the mirror's packages of the day).
#   images/arch/desktop.sh [--out file.qcow2]     (default target/arch/desktop.qcow2)
# Login arch/arch (the screen) or root/root (the serial console); then `sway` (with 3D, WLR_RENDERER=gles2; see
# docs/frontend.md), and e.g. `firefox file:///home/arch/media/avsync.html?v=sintel.webm`, `mpv ~/media/sintel.webm`,
# `aplay -l`, `wpctl status`. bench/audio/avsync.ts measures A/V sync and the decode's cost on it; bench/gpu/sway-load.ts,
# firefox-load.ts and gtk4-load.ts the graphics.
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/../.." && pwd)
W=$ROOT/target/arch
OUT=$W/desktop.qcow2
while [ $# -gt 0 ]; do
  case $1 in
    --out) OUT=$(realpath -m "$2"); shift 2 ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
done
PACKAGES="sway foot firefox htop ttf-dejavu pipewire pipewire-pulse pipewire-alsa wireplumber alsa-utils mpv libva-utils
  gtk4-demos mesa-utils chromium"

echo "==== webpc-va"
rm -f "$W"/pkg/webpc-va-*
"$ROOT/images/arch/webpc-va.sh"
echo "==== media"
"$ROOT/images/arch/media.sh" "$W/media"

FILES=$W/desktop-files
rm -rf "$FILES"; mkdir -p "$FILES/root/pkg" "$FILES/home/arch/media"
cp "$W"/pkg/webpc-va-*.pkg.tar.* "$FILES/root/pkg/"
cp "$W"/media/{avsync.webm,sintel.webm,sintel-silent.webm,avsync.html} "$FILES/home/arch/media/"
echo "==== image"
"$ROOT/images/arch/build.sh" --out "$OUT" --root-mib 20480 --packages "$PACKAGES" --files "$FILES" --setup "$ROOT/images/arch/desktop-setup.sh"
rm -rf "$FILES"
