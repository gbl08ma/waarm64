#!/usr/bin/env bash
# The second disk of codecs.ts: images/arch/media.sh's clips, eight of gen.py's JPEGs (target/imgdecode/files),
# codecs.sh, js.html and q8dot, built natively (it uses nothing past the guest's glibc).
#   bench/imgdecode/codecs-disk.sh   -> target/imgdecode/codecs.ext4
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
H=$ROOT/bench/imgdecode
W=$ROOT/target/imgdecode
rm -rf "$W/tree"; mkdir -p "$W/tree"
cp "$ROOT"/target/arch/media/{sintel.webm,sintel-av1.webm,sintel_trailer-480p.mp4} "$W/tree/"
for i in 0 1 2 3 4 5 6 7; do cp "$W/files/$i.jpg" "$W/tree/"; done
cp "$H/codecs.sh" "$H/js.html" "$W/tree/"
gcc -O2 -o "$W/tree/q8dot" "$H/q8dot.c"
rm -f "$W/codecs.ext4"
mke2fs -q -t ext4 -L codecs -d "$W/tree" "$W/codecs.ext4" 128M
rm -rf "$W/tree"
ls -l "$W/codecs.ext4"
