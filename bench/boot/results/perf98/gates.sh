#!/usr/bin/env bash
# PERF loop 98 (from ../perf83/gates.sh): the parallel boots in Chromium on the Mac (bench/run-mac.sh --page bench/boot/index.html), an idle
# vCPU poll rule as the page query's `vmiss=<n>` (bench/boot/suite.ts), the arms alternated, the first rotated each round:
#   bench/boot/results/perf98/gates.sh <rounds> <misses>... -> bench/results/local/mac/p98-m<misses>-r<round>-<bench>.json
set -uo pipefail
cd "$(dirname "$0")/../../../.."
rounds=$1; shift
arms=("$@") n=$#
for r in $(seq 1 "$rounds"); do
  for k in $(seq 0 $((n - 1))); do
    s=${arms[$(( (k + r - 1) % n ))]}
    for b in smp_alpine_jit smp_user_jit_4; do
      name=p98-m$s-r$r-$b
      timeout 640 bench/run-mac.sh "$name" --page bench/boot/index.html --only "$b" "'--query=vmiss=$s'" 2>&1 \
        | grep -E '^[a-z_0-9]+ +[{(].*±|Error' | sed -E "s/ \{.*\}//; s/^/m$s r$r: /"
      echo "$name: $(timeout 60 bench/gpu/mac-leftovers.sh --kill 2>&1 | tail -1)"
    done
  done
done
echo "gates done $(date +%T)"
