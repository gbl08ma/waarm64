#!/usr/bin/env bash
# The video track's clips (docs/plans/video.md) as an ext4 the page serves as its second disk (`?disk2=`; the guest
# mounts /dev/vdb): images/archarm/media.sh's (the Sintel trailer as the original H.264 MP4, 854x480, and as VP9 WebM;
# the A/V sync clip) and its avsync.html. Local only (target/, not committed).
#   bench/video/media-disk.sh   -> target/video/media.ext4
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
M=$ROOT/target/archarm/media
W=$ROOT/target/video
[ -f "$M/sintel.webm" ] || "$ROOT/images/archarm/media.sh" "$M"
rm -rf "$W/tree"; mkdir -p "$W/tree"
cp "$M"/{sintel_trailer-480p.mp4,sintel.webm,sintel-silent.webm,avsync.webm,avsync.html} "$W/tree/"
# A VA driver build to try (bench/video/v0.ts SHIM=1), if there is one.
[ ! -f "$W/shim/webpc_drv_video.so" ] || cp "$W/shim/webpc_drv_video.so" "$W/tree/"
rm -f "$W/media.ext4"
mke2fs -q -t ext4 -L media -d "$W/tree" "$W/media.ext4" 256M
rm -rf "$W/tree"
ls -l "$W/media.ext4"
