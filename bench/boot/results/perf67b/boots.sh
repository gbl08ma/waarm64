#!/usr/bin/env bash
# PERF loop 67b: the parallel boots (smp_alpine_jit) on the Mac, arms alternated, the first rotated each round:
# main (no marker), before (loop 67's warm-up), idle (?jitwarm=idle: posted first, warmed while no job waits).
#   bench/boot/results/perf67b/boots.sh <rounds> -> bench/results/local/mac/p67b-<arm>-r<round>-smp_alpine_jit.json
set -uo pipefail
cd "$(dirname "$0")/../../../.."
d=bench/results/local/perf67b
arms=(main before idle); n=3
declare -A core=([main]=$d/main.wasm [before]=$d/warm.wasm [idle]=$d/warm.wasm)
declare -A q=([main]='' [before]='' [idle]='--query=jitwarm=idle')
for r in $(seq 1 "$1"); do
  for k in $(seq 0 $((n - 1))); do
    arm=${arms[$(( (k + r - 1) % n ))]}
    WASM=${core[$arm]} timeout 640 bench/run-mac.sh "p67b-$arm-r$r-smp_alpine_jit" --page bench/boot/index.html --only smp_alpine_jit ${q[$arm]} 2>&1 \
      | grep -E '^smp_alpine_jit_n[124]_(total|script) |Error' | sed -E "s/ \{.*\}//; s/^/$arm r$r: /"
    echo "$(timeout 60 bench/gpu/mac-leftovers.sh --kill 2>&1 | tail -1)"
  done
done
echo "boots done $(date +%T)"
