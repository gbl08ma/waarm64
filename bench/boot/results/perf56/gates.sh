#!/usr/bin/env bash
# PERF loop 56's gates on the Mac (bench/run-mac.sh), arms alternated, the first arm rotated each round:
#   bench/boot/results/perf56/gates.sh <prefix> <rounds> <bench>...
# Arms: `base` (../waarm64-base's tree at the loop's base, 1b0224f8, its core WASM_BASE), `counted` (this tree, its core WASM_NEW,
# the benchmarks' default: every step counted) and `uncounted` (the same core with `--query=uncounted`: polled code
# without `acc`). ARMS limits them (e.g. ARMS="base counted"). Results in bench/results/local/mac/<prefix>-<arm>-r<round>-<bench>.json.
set -uo pipefail
cd "$(dirname "$0")/../../../.."
repo=$PWD
prefix=$1 rounds=$2; shift 2
read -r -a arms <<< "${ARMS:-base counted uncounted}"
n=${#arms[@]}
for r in $(seq 1 "$rounds"); do
  for k in $(seq 0 $((n - 1))); do
    arm=${arms[$(( (k + r - 1) % n ))]}
    for b in "$@"; do
      name=$prefix-$arm-r$r-$b
      case $arm in
        base) (cd ../waarm64-base && WASM=$WASM_BASE timeout 640 bench/run-mac.sh "$name" --page bench/boot/index.html --only "$b") ;;
        counted) WASM=$WASM_NEW timeout 640 bench/run-mac.sh "$name" --page bench/boot/index.html --only "$b" ;;
        uncounted) WASM=$WASM_NEW timeout 640 bench/run-mac.sh "$name" --page bench/boot/index.html --only "$b" --query=uncounted ;;
      esac 2>&1 | grep -E '^[a-z_0-9]+ +[{(].*±|Error' | sed -E "s/ \{.*\}//; s/^/$arm r$r: /"
      [ -f ../waarm64-base/bench/results/local/mac/$name.json ] && mv ../waarm64-base/bench/results/local/mac/$name.json bench/results/local/mac/
      echo "$name: $(timeout 60 bench/gpu/mac-leftovers.sh --kill 2>&1 | tail -1)"
    done
  done
done
