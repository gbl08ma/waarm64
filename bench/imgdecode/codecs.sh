#!/bin/sh
# What FEAT_DotProd, FEAT_JSCVT and FEAT_I8MM change for programs that pick their paths from the hwcaps (REPORT in
# bench/boot/REPORT.md "FEAT_DotProd and FEAT_JSCVT, measured", "PERF loop 5: FEAT_I8MM"), run the same in the Arch
# guest with the feature on and off (codecs.ts).
#   codecs.sh <dir> codecs [R]    each codec one-threaded, R + 1 times, the first printed as cold; `CODEC <name> <us>`
#   codecs.sh <dir> js [R]        js.html in Chromium and Firefox, R runs; `JS <browser> <kernel> <ms>`
#   codecs.sh <dir> kernels [R]   rdmk.c (FEAT_RDM's and FEAT_LRCPC2's kernels) and fcmak.c (FEAT_FCMA's), R runs; `KERN <kernel> <ns>`
#   codecs.sh <dir> fp16k [R]     fp16k.c (FEAT_FP16's and FEAT_FHM's kernels), R runs; `KERN <kernel> <ns>`
#   codecs.sh <dir> bf16k [R]     bf16k.c (FEAT_BF16's kernels), R runs; `KERN <kernel> <ns>`
D=${1:?usage: codecs.sh <dir> codecs|js [R]}
MODE=${2:-codecs}
R=${3:-3}
ns() { date +%s%N; }
grep -m1 Features /proc/cpuinfo
timed() { # <name> <command>
  name=$1; shift
  k=0
  while [ "$k" -le "$R" ]; do
    t0=$(ns); "$@" >/dev/null 2>&1; rc=$?; t1=$(ns)
    [ "$rc" = 0 ] || echo "FAILED $name rc=$rc"
    if [ "$k" = 0 ]; then echo "COLD $name $(((t1 - t0) / 1000))"; else echo "CODEC $name $(((t1 - t0) / 1000))"; fi
    k=$((k + 1))
  done
}
if [ "$MODE" = fp16k ]; then
  "$D/fp16k" 200 | sed 's/^/COLD /'
  k=0
  while [ "$k" -lt "$R" ]; do "$D/fp16k" 20000; k=$((k + 1)); done
  echo CODECS-END
  exit 0
fi
if [ "$MODE" = bf16k ]; then
  "$D/bf16k" 200 | sed 's/^/COLD /'
  k=0
  while [ "$k" -lt "$R" ]; do "$D/bf16k" 20000; k=$((k + 1)); done
  echo CODECS-END
  exit 0
fi
if [ "$MODE" = kernels ]; then
  "$D/rdmk" 10000 | sed 's/^/COLD /'
  "$D/fcmak" 10000 | sed 's/^/COLD /'
  k=0
  while [ "$k" -lt "$R" ]; do "$D/rdmk" 100000; "$D/fcmak" 100000; k=$((k + 1)); done
  echo CODECS-END
  exit 0
fi
if [ "$MODE" = js ]; then
  cp "$D/js.html" /tmp/js.html
  r=0
  while [ "$r" -lt "$R" ]; do
    rm -rf /tmp/pc /tmp/pf; mkdir -p /tmp/pf
    chromium --headless --no-sandbox --disable-gpu --no-first-run --user-data-dir=/tmp/pc --virtual-time-budget=100000 --dump-dom file:///tmp/js.html 2>/dev/null | grep '^JS \|>JS ' | sed 's/.*JS /JS chromium /'
    cat > /tmp/pf/user.js <<'E'
user_pref("browser.dom.window.dump.enabled", true);
user_pref("datareporting.policy.dataSubmissionEnabled", false);
user_pref("browser.shell.checkDefaultBrowser", false);
E
    MOZ_HEADLESS=1 timeout 200 firefox --headless --no-remote --profile /tmp/pf file:///tmp/js.html > /tmp/ff.log 2>&1 &
    f=$!
    n=0
    while [ "$n" -lt 190 ] && ! grep -q JS-END /tmp/ff.log; do sleep 1; n=$((n + 1)); done
    kill "$f" 2>/dev/null; pkill -f firefox 2>/dev/null; wait "$f" 2>/dev/null
    grep '^JS ' /tmp/ff.log | sed 's/^JS /JS firefox /'
    r=$((r + 1))
  done
  echo CODECS-END
  exit 0
fi
ffmpeg -v error -threads 1 -i "$D/sintel.webm" -frames:v 96 -pix_fmt yuv420p -y /tmp/s.y4m
x264 --threads 1 --preset veryfast -o /dev/null /tmp/s.y4m 2>&1 | grep -m1 'using cpu capabilities'
X265="x265 --pools 1 --frame-threads 1 --no-wpp --lookahead-slices 0 --preset fast --frames 24"
$X265 --log-level info -o /dev/null /tmp/s.y4m 2>&1 | grep -m1 'capabilities'
"$D/q8dot" 2000 | sed 's/^/COLD /'
timed dav1d-av1 ffmpeg -v error -threads 1 -c:v libdav1d -i "$D/sintel-av1.webm" -frames:v 200 -f null -
timed libvpx-vp9-dec vpxdec --threads=1 --i420 --limit=200 -o /dev/null "$D/sintel.webm"
timed ffvp9-dec ffmpeg -v error -threads 1 -c:v vp9 -i "$D/sintel.webm" -frames:v 200 -f null -
timed h264-dec ffmpeg -v error -threads 1 -c:v h264 -i "$D/sintel_trailer-480p.mp4" -frames:v 300 -f null -
timed hevc-dec ffmpeg -v error -threads 1 -c:v hevc -i "$D/sintel-hevc.mp4" -frames:v 288 -f null -
timed x264-veryfast x264 --threads 1 --preset veryfast --quiet -o /dev/null /tmp/s.y4m
timed x264-medium x264 --threads 1 --preset medium --quiet --frames 48 -o /dev/null /tmp/s.y4m
timed libvpx-vp9-enc vpxenc --codec=vp9 --rt --cpu-used=8 --threads=1 --limit=48 -o /dev/null /tmp/s.y4m
timed x265-fast $X265 --log-level none -o /dev/null /tmp/s.y4m
timed libaom-enc aomenc --rt --cpu-used=9 --threads=1 --limit=12 --ivf -o /dev/null /tmp/s.y4m
timed djpeg sh -c "for i in 0 1 2 3 4 5 6 7; do djpeg -outfile /dev/null $D/\$i.jpg; done"
k=0
while [ "$k" -lt "$R" ]; do
  "$D/q8dot" 40000
  tjbench "$D/0.jpg" -benchtime 3 -warmup 1 2>&1 | grep -E -i 'Decomp' | tail -2 | sed 's/^/TJ /'
  k=$((k + 1))
done
echo CODECS-END
