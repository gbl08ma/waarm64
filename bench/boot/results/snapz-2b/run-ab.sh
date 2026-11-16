#!/usr/bin/env bash
# SNAPZ loop 2b's A/B: each round a fresh browser (ROUNDS=1), the arms alternated; an arm = its tree (git checkout)
# and its wasm (copied into the build's path); bench/snapz/memwatch.ts beside each round (the browser's memory by
# process every 50 ms). Usage: run-ab.sh <guest> <arm order, e.g. "base new wblob">
set -uo pipefail
cd /home/gabriel.guest/Development/waarm64
guest=$1; shift
WASM=target/wasm32-unknown-unknown/release/waarm64_core.wasm
out=bench/results/local/snapz-2b
MW=bench/snapz/memwatch.ts
# base: 7b7b4342 (loop 2, ABI 68); new: this loop (ABI 69); wblob: this loop with the download's Blob made in the machine worker.
declare -A REF=([base]=7b7b4342 [new]=snapz2b [wblob]=snapz2b-wblob)
declare -A CORE=([base]=b2b-base [new]=b2b-new [wblob]=b2b-new)
i=0
for arm in $@; do
  i=$((i+1))
  git checkout -q "${REF[$arm]}" 2>&1 || { echo "checkout $arm failed"; exit 1; }
  cp target/snapz/arms/${CORE[$arm]}.wasm $WASM
  echo "== $guest round $i: $arm at $(git rev-parse --short HEAD), core $(sha256sum $WASM | cut -c1-16), $(grep -o 'export const ABI = [0-9]*' web/vm.ts)"
  tag=$guest-$arm-$i
  rm -f $out/$tag.stop
  systemd-run --user --scope -q -p MemoryMax=1G -p MemorySwapMax=0 -- timeout 600 node $MW target/snapz/profile $out/$tag.mem.jsonl $out/$tag.stop &
  mw=$!
  WAARM64_PROFILE=target/snapz/profile WAARM64_DOWNLOADS=target/snapz/downloads ROUNDS=1 SETTLE_S=20 \
    systemd-run --user --scope -q -p MemoryMax=12G -p MemorySwapMax=0 -- timeout 420 \
    node bench/snapz/probe.ts $guest $out/$tag.json 2>&1 | while IFS= read -r l; do echo "$(date +%s%3N) $l"; done > $out/$tag.log
  echo "rc=${PIPESTATUS[0]} $(grep -o '"core":"[0-9a-f]*"' $out/$tag.json | head -1) $(grep -o '"commit":"[^"]*"' $out/$tag.json)"
  touch $out/$tag.stop; wait $mw
  grep -o 'round 0 [a-z]* {"wallMs":[0-9]*,"kind":"[a-z]*","bytes":[0-9]*,"pausedMs":[0-9]*' $out/$tag.log | cut -c1-120
done
git checkout -q snapz2b
cp target/snapz/arms/b2b-new.wasm $WASM
echo ALLDONE
