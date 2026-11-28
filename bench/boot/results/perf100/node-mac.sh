#!/usr/bin/env bash
# PERF loop 100: the Mac's Node, two trees alternated, the first rotated each round (after a bench/run-mac.sh or
# ab-mac.sh has put the images in ~/waarm64-bench.noindex). `new` is this tree (web/, bench/boot, its core) in the
# bench directory; `base` is BASE_TREE's web/ and bench/boot with BASE_WASM in its p100base/ (removed at the end):
#   BASE_TREE=../waarm64-base BASE_WASM=<core> bench/boot/results/perf100/node-mac.sh <out.txt> <rounds> idle|pingpong
# idle: bench/boot/idle-cpu.ts 4 5 20 (an idle 4-vCPU guest's host CPU); pingpong: ../perf98/pingpong.ts 8 (PP_N
# passed on, default 1280000). Each line: "<arm> <round> <JSON>". Bounded on the Mac (perl alarm) and here.
set -euo pipefail
cd "$(dirname "$0")/../../../.."
out=$1 rounds=$2 what=$3
HOST=${MAC_HOST:-macmini.lan} DEST=waarm64-bench.noindex CORE=target/wasm32-unknown-unknown/release
base=$(realpath "$BASE_TREE")
rsync -a --delete web "$HOST:$DEST/"
rsync -a --delete --include 'results/perf98/***' --exclude 'results/*' bench/boot "$HOST:$DEST/bench/"
rsync -a "${WASM:-$CORE/waarm64_core.wasm}" "$HOST:$DEST/$CORE/waarm64_core.wasm"
timeout 30 ssh "$HOST" "mkdir -p $DEST/p100base/bench $DEST/p100base/$CORE && ln -sfn ../../target/images $DEST/p100base/target/images"
rsync -a --delete "$base/web" "$HOST:$DEST/p100base/"
rsync -a --delete --include 'results/perf98/***' --exclude 'results/*' "$base/bench/boot" "$HOST:$DEST/p100base/bench/"
rsync -a "$BASE_WASM" "$HOST:$DEST/p100base/$CORE/waarm64_core.wasm"
trap 'timeout 30 ssh "$HOST" "rm -rf $DEST/p100base"' EXIT
arms=(base new)
for r in $(seq 1 "$rounds"); do
  for k in 0 1; do
    a=${arms[$(( (k + r - 1) % 2 ))]}
    dir=$DEST; [ "$a" = base ] && dir=$DEST/p100base
    case $what in
      idle) cmd="node --disable-warning=ExperimentalWarning bench/boot/idle-cpu.ts 4 5 20" ;;
      pingpong) cmd="env PP_N=${PP_N:-1280000} node --disable-warning=ExperimentalWarning bench/boot/results/perf98/pingpong.ts 8" ;;
    esac
    line=$(timeout 120 ssh "$HOST" "cd $dir && export PATH=/opt/homebrew/bin:\$PATH && perl -e 'alarm shift; exec @ARGV' 100 $cmd" | tail -1)
    echo "$a $r $line" | tee -a "$out"
  done
done
