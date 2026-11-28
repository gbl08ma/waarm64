#!/usr/bin/env bash
# PERF loop 100: the parallel boots in Chromium on the Mac (bench/run-mac.sh --page bench/boot/index.html), two trees
# alternated, the first rotated each round:
#   bench/boot/results/perf100/gates.sh <rounds> <arm>=<core.wasm>@<tree>...
#   -> bench/results/local/mac/p100-<arm>-r<round>-<bench>.json (this tree's); python3 ../perf53/summary.py <dir> p100 base new
set -uo pipefail
cd "$(dirname "$0")/../../../.."
repo=$PWD rounds=$1; shift
arms=("$@") n=$#
mkdir -p bench/results/local/mac
for r in $(seq 1 "$rounds"); do
  for k in $(seq 0 $((n - 1))); do
    a=${arms[$(( (k + r - 1) % n ))]}
    s=${a%%=*} rest=${a#*=}
    core=$(realpath "${rest%%@*}") tree=$(realpath "${rest#*@}")
    for b in smp_alpine_jit smp_user_jit_4; do
      name=p100-$s-r$r-$b
      WASM=$core timeout 640 "$tree/bench/run-mac.sh" "$name" --page bench/boot/index.html --only "$b" 2>&1 \
        | grep -E '^[a-z_0-9]+ +[{(].*±|Error' | sed -E "s/ \{.*\}//; s/^/$s r$r: /"
      [ "$tree" != "$repo" ] && mv "$tree/bench/results/local/mac/$name.json" "$repo/bench/results/local/mac/" 2>/dev/null
      echo "$name: $(timeout 60 bench/gpu/mac-leftovers.sh --kill 2>&1 | tail -1)"
    done
  done
done
echo "gates done $(date +%T)"
