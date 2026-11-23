#!/usr/bin/env bash
# PERF loop 65: BATCH_STEPS arms on the Mac's parallel boots (bench/run-mac.sh per run), the arms alternated, the first
# rotated each round, with the peak summed RSS of Chrome for Testing's processes sampled every second on the Mac.
# Takes the CI lock exclusive (the dev VM shares the Mac's cores).
#   ARMS="b50k b25k b100k" bench/boot/results/perf65/gates.sh <rounds> <bench>...
#   cores: bench/results/local/perf65/<arm>.wasm -> bench/results/local/mac/pg-<arm>-r<round>-<bench>.json (copied to smp/),
#   bench/results/local/perf65/rss/<name>.txt
set -uo pipefail
cd "$(dirname "$0")/../../../.."
source scripts/ci-lock.sh; ci_lock exclusive
d=bench/results/local/perf65
mkdir -p $d/rss
rounds=$1; shift
read -r -a arms <<< "${ARMS:-b50k b25k b100k}"; pre=${PREFIX:-pg}; n=${#arms[@]}
for r in $(seq 1 "$rounds"); do
  for k in $(seq 0 $((n - 1))); do
    arm=${arms[$(( (k + r - 1) % n ))]}
    for b in "$@"; do
      name=$pre-$arm-r$r-$b
      stop=/tmp/pg-stop-$name
      # The Mac side ends at the stop file, or after 700 s whatever happens (perl alarm).
      timeout 720 ssh macmini.lan "rm -f $stop; perl -e 'alarm 700; exec @ARGV' sh -c 'm=0; while [ ! -e $stop ]; do s=\$(ps -Ao rss=,comm= | awk \"/Chrome for Testing/ {t+=\\\$1} END {print t+0}\"); [ \$s -gt \$m ] && m=\$s; sleep 1; done; echo \$m'; rm -f $stop" > $d/rss/$name.txt 2>&1 &
      sp=$!
      WASM=$d/$arm.wasm timeout 640 bench/run-mac.sh "$name" --page bench/boot/index.html --only "$b" 2>&1 \
        | grep -E '^[a-z_0-9]+ +[{(].*±|Error' | sed -E "s/ \{.*\}//; s/^/$arm r$r: /"
      timeout 30 ssh macmini.lan "touch $stop"
      wait $sp
      echo "$name: rss peak $(( $(tail -1 $d/rss/$name.txt) / 1024 )) MiB; $(timeout 60 bench/gpu/mac-leftovers.sh --kill 2>&1 | tail -1)"
    done
  done
done
echo "gates done $(date +%T)"
