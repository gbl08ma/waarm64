#!/usr/bin/env bash
# The second disk of codecs.ts: images/arch/media.sh's clips, eight of gen.py's JPEGs (target/imgdecode/files),
# codecs.sh, js.html, q8dot, rdmk, fcmak, fp16k and bf16k, built natively (it uses nothing past the guest's glibc), and 12 s of the trailer in
# HEVC (x265 at its medium preset, made once in rootless Podman: Alpine's ffmpeg).
#   bench/imgdecode/codecs-disk.sh   -> target/imgdecode/codecs.ext4
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
H=$ROOT/bench/imgdecode
W=$ROOT/target/imgdecode
rm -rf "$W/tree"; mkdir -p "$W/tree"
if [ ! -f "$W/sintel-hevc.mp4" ]; then
  C=$(grep -E '^USERLAND_CONTAINER=' "$ROOT/images/build.sh" | cut -d= -f2 | cut -d' ' -f1)
  podman run --rm -v "$ROOT/target/arch/media:/in:ro,Z" -v "$W:/out:Z" "$C" sh -euc 'apk add -q --no-cache ffmpeg
    ffmpeg -loglevel error -y -i /in/sintel_trailer-480p.mp4 -t 12 -an -c:v libx265 -preset medium \
      -x265-params log-level=error -pix_fmt yuv420p /out/sintel-hevc.mp4'
fi
cp "$W/sintel-hevc.mp4" "$W/tree/"
cp "$ROOT"/target/arch/media/{sintel.webm,sintel-av1.webm,sintel_trailer-480p.mp4} "$W/tree/"
for i in 0 1 2 3 4 5 6 7; do cp "$W/files/$i.jpg" "$W/tree/"; done
cp "$H/codecs.sh" "$H/js.html" "$W/tree/"
gcc -O2 -o "$W/tree/q8dot" "$H/q8dot.c"
gcc -O2 -o "$W/tree/rdmk" "$H/rdmk.c"
gcc -O2 -o "$W/tree/fcmak" "$H/fcmak.c"
gcc -O2 -o "$W/tree/fp16k" "$H/fp16k.c"
gcc -O2 -o "$W/tree/bf16k" "$H/bf16k.c"
rm -f "$W/codecs.ext4"
mke2fs -q -t ext4 -L codecs -d "$W/tree" "$W/codecs.ext4" 128M
rm -rf "$W/tree"
ls -l "$W/codecs.ext4"
