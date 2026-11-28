#!/usr/bin/env bash
# PERF loop 100: the atomics stress's futex hand-offs (../perf98/pingpong.ts, the default poll rule) in the dev VM,
# two trees alternated, the first rotated each round:
#   bench/boot/results/perf100/pingpong-vm.sh <out.txt> <rounds> <arm>=<core.wasm>@<tree>...
# Each line: "<arm> <round> <JSON>". Run alone.
set -euo pipefail
cd "$(dirname "$0")/../../../.."
out=$1 rounds=$2; shift 2
arms=("$@") n=$#
for r in $(seq 1 "$rounds"); do
  for k in $(seq 0 $((n - 1))); do
    a=${arms[$(( (k + r - 1) % n ))]}
    name=${a%%=*} rest=${a#*=}
    core=$(realpath "${rest%%@*}") tree=$(realpath "${rest#*@}")
    line=$(WASM=$core PP_N=${PP_N:-1280000} systemd-run --user --scope -q -p MemoryMax=4G -p MemorySwapMax=0 -- \
      timeout 150 node --disable-warning=ExperimentalWarning "$tree/bench/boot/results/perf98/pingpong.ts" 8 | tail -1)
    echo "$name $r $line" | tee -a "$out"
  done
done
