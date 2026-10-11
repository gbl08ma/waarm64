#!/usr/bin/env bash
# The desktop guest of audio S3 (docs/plans/audio.md §10.8): Arch Linux ARM with sway, foot, Firefox and PipeWire
# (WirePlumber, its PulseAudio and ALSA ends), sound through our virtio-snd-dkms package (DKMS builds the module in the
# image for its kernel), and the media of images/archarm/media.sh in /home/alarm/media. On demand only: not part of
# images/build.sh, CI or any test (~15 min, mostly pacman and the container builds; the mirror's packages of the day).
#   images/archarm/desktop.sh [--out file.qcow2]     (default target/archarm/desktop.qcow2)
# Login alarm/alarm (the screen) or root/root (the serial console); then `sway` (with 3D, WLR_RENDERER=gles2; see
# docs/frontend.md), and e.g. `firefox file:///home/alarm/media/avsync.html?v=sintel.webm`, `mpv ~/media/sintel.webm`,
# `aplay -l`, `wpctl status`. bench/audio/avsync.ts measures A/V sync and the decode's cost on it.
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/../.." && pwd)
W=$ROOT/target/archarm
OUT=$W/desktop.qcow2
while [ $# -gt 0 ]; do
  case $1 in
    --out) OUT=$(realpath -m "$2"); shift 2 ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
done
PACKAGES="sway foot firefox ttf-dejavu pipewire pipewire-pulse pipewire-alsa wireplumber alsa-utils mpv dkms linux-aarch64-headers gcc make"

echo "==== virtio-snd-dkms"
rm -f "$W"/pkg/virtio-snd-dkms-*
"$ROOT/images/archarm/virtio-snd-dkms.sh"
echo "==== media"
"$ROOT/images/archarm/media.sh" "$W/media"

FILES=$W/desktop-files
rm -rf "$FILES"; mkdir -p "$FILES/root/pkg" "$FILES/home/alarm/media"
cp "$W"/pkg/virtio-snd-dkms-*.pkg.tar.* "$FILES/root/pkg/"
cp "$W"/media/{avsync.webm,sintel.webm,sintel-silent.webm,avsync.html} "$FILES/home/alarm/media/"
echo "==== image"
"$ROOT/images/archarm/build.sh" --out "$OUT" --root-mib 10000 --packages "$PACKAGES" --files "$FILES" --setup "$ROOT/images/archarm/desktop-setup.sh"
rm -rf "$FILES"
