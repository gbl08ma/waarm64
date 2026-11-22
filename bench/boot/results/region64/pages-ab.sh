#!/usr/bin/env bash
# REGION 16 vs 64 on Firefox's pages session (bench/gpu/ab-mac.sh, one arm a call), arms alternated, the first rotated
# each round, with the peak summed RSS of Chrome for Testing's processes on the Mac sampled every second.
#   bench/results/local/region-pages/run.sh <rounds>   -> <arm>-<round>/ (ab-mac's), rss-<arm>-<round>.txt
set -euo pipefail
cd "$(dirname "$0")/../../../.."
source scripts/ci-lock.sh
ci_lock exclusive
d=bench/results/local/region-pages
arms=(r16 r64)
for r in $(seq 1 "$1"); do
  for k in 0 1; do
    arm=${arms[$(( (k + r - 1) % 2 ))]}
    stop=/tmp/rp-stop-$arm-$r
    timeout 900 ssh macmini.lan "rm -f $stop; perl -e 'alarm 880; exec @ARGV' sh -c 'm=0; while [ ! -e $stop ]; do s=\$(ps -Ao rss=,comm= | awk \"/Chrome for Testing/ {t+=\\\$1} END {print t+0}\"); [ \$s -gt \$m ] && m=\$s; sleep 1; done; echo \$m'; rm -f $stop" > $d/rss-$arm-$r.txt 2>&1 &
    sp=$!
    rm -rf $d/tmp; bench/gpu/ab-mac.sh $d/tmp 1 "$arm=$d/cores/n${arm#r}.wasm"
    rm -rf $d/$arm-$r; mv $d/tmp/$arm-1 $d/$arm-$r; rm -rf $d/tmp
    timeout 30 ssh macmini.lan "touch $stop"; wait $sp
    echo "$arm-$r: rss peak $(( $(tail -1 $d/rss-$arm-$r.txt) / 1024 )) MiB"
  done
done
echo "pages done $(date +%T)"
