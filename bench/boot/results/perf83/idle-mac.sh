#!/usr/bin/env bash
# PERF loop 83: an idle 4-vCPU guest's host CPU in the Mac's Node (bench/boot/idle-cpu.ts 4 5 20 <spin µs>), the
# arms rotated each round: bench/boot/results/perf83/idle-mac.sh <out.txt> <rounds> <spin µs>... (after a
# bench/run-mac.sh or ab-mac.sh has put the images in ~/waarm64-bench; this copies web/, bench/boot and the core).
# Each line: "<spin> <round> <idle-cpu.ts's JSON>". Bounded on the Mac (perl alarm) and here.
set -euo pipefail
cd "$(dirname "$0")/../../../.."
out=$1 rounds=$2; shift 2
HOST=${MAC_HOST:-macmini.lan} DEST=waarm64-bench CORE=target/wasm32-unknown-unknown/release
rsync -a --delete web "$HOST:$DEST/"
rsync -a --delete --exclude results bench/boot "$HOST:$DEST/bench/"
rsync -a "${WASM:-$CORE/waarm64_core.wasm}" "$HOST:$DEST/$CORE/waarm64_core.wasm"
arms=("$@") n=$#
for r in $(seq 1 "$rounds"); do
  for k in $(seq 0 $((n - 1))); do
    s=${arms[$(( (k + r - 1) % n ))]}
    line=$(timeout 120 ssh "$HOST" "cd $DEST && export PATH=/opt/homebrew/bin:\$PATH && perl -e 'alarm shift; exec @ARGV' 100 node --disable-warning=ExperimentalWarning bench/boot/idle-cpu.ts 4 5 20 $s" | tail -1)
    echo "$s $r $line" | tee -a "$out"
  done
done
