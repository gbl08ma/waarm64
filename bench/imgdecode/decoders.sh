#!/bin/sh
# The image decoders alone (README.md "On the desktop guest"): Arch's dwebp, djpeg, avifdec (dav1d) and tjbench over
# photos.py's 1024 px images, run the same in the desktop guest (desktop.ts GUEST_CMD) and natively (the arch-base
# container), so their ratio is the emulation's cost on each decoder. Prints `DEC <tool> <ms per image>`: wall time
# over 16 images x R runs less the tool's start-up (its --version, as many times), and tjbench's own lines.
#   decoders.sh <img dir> [R]
D=${1:?usage: decoders.sh <img dir> [R]}
R=${2:-3}
ns() { date +%s%N; }
per() { # <label> <startup command> <decode command with %f>
  label=$1 start=$2 cmd=$3
  t0=$(ns); i=0; while [ $i -lt $((16 * R)) ]; do $start >/dev/null 2>&1; i=$((i + 1)); done; t1=$(ns)
  r=0; while [ $r -lt "$R" ]; do for k in $(seq 0 15); do f=$D/$k.$4; eval "$(echo "$cmd" | sed "s#%f#$f#g")" >/dev/null 2>&1; done; r=$((r + 1)); done; t2=$(ns)
  echo "DEC $label $(( ((t2 - t1) - (t1 - t0)) / (16 * R) / 1000 )) us/image (startup $(( (t1 - t0) / (16 * R) / 1000 )) us)"
}
per dwebp 'dwebp -version' 'dwebp %f -o /dev/null -ppm' webp
per djpeg 'djpeg -version' 'djpeg -outfile /dev/null %f' jpg
per djpeg-scale4 'djpeg -version' 'djpeg -scale 1/4 -outfile /dev/null %f' jpg
per avifdec 'avifdec --version' 'avifdec -j 1 %f /tmp/dec.y4m' avif
tjbench $D/0.jpg -benchtime 3 -warmup 1 2>&1 | grep -E -i "Decomp|Mpixels" | head -6 | sed 's/^/TJ /'
