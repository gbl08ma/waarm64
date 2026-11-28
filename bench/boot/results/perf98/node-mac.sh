#!/usr/bin/env bash
# PERF loop 98: the Mac's Node, arms rotated each round (after a bench/run-mac.sh or ab-mac.sh has put the images in
# ~/waarm64-bench.noindex; this copies web/, bench/boot and the core there):
#   bench/boot/results/perf98/node-mac.sh <out.txt> <rounds> idle|pingpong <misses>...
# idle: bench/boot/idle-cpu.ts 4 5 20 - <misses> (an idle 4-vCPU guest's host CPU); pingpong: pingpong.ts <misses>
# (PP_N passed on).
# Each line: "<misses> <round> <JSON>". Bounded on the Mac (perl alarm) and here.
set -euo pipefail
cd "$(dirname "$0")/../../../.."
out=$1 rounds=$2 what=$3; shift 3
HOST=${MAC_HOST:-macmini.lan} DEST=waarm64-bench.noindex CORE=target/wasm32-unknown-unknown/release
rsync -a --delete web "$HOST:$DEST/"
rsync -a --delete --include 'results/perf98/***' --exclude 'results/*' bench/boot "$HOST:$DEST/bench/"
rsync -a "${WASM:-$CORE/waarm64_core.wasm}" "$HOST:$DEST/$CORE/waarm64_core.wasm"
arms=("$@") n=$#
for r in $(seq 1 "$rounds"); do
  for k in $(seq 0 $((n - 1))); do
    m=${arms[$(( (k + r - 1) % n ))]}
    case $what in
      idle) cmd="node --disable-warning=ExperimentalWarning bench/boot/idle-cpu.ts 4 5 20 - $m" ;;
      pingpong) cmd="env PP_N=${PP_N:-320000} node --disable-warning=ExperimentalWarning bench/boot/results/perf98/pingpong.ts $m" ;;
    esac
    line=$(timeout 120 ssh "$HOST" "cd $DEST && export PATH=/opt/homebrew/bin:\$PATH && perl -e 'alarm shift; exec @ARGV' 100 $cmd" | tail -1)
    echo "$m $r $line" | tee -a "$out"
  done
done
