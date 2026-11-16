#!/usr/bin/env bash
# SNAPZ loop 4's A/B: each round a fresh browser (ROUNDS=1), the arms alternated; an arm = its tree (git checkout; the
# wasm is the same: no core change). Both arms run this loop's probe (its picked-file save), copied beside the probe as
# an untracked bench/snapz/probe-l4.ts; bench/snapz/memwatch.ts beside each round (the browser's memory by process
# every 50 ms). Usage: run-ab.sh <guest> <arm order, e.g. "base new new base">
set -uo pipefail
cd /home/gabriel.guest/Development/waarm64
guest=$1; shift
out=bench/results/local/snapz-4
mkdir -p $out
MW=$out/memwatch.ts
PROBE=bench/snapz/probe-l4.ts
cp bench/snapz/memwatch.ts $MW
git show snapz4:bench/snapz/probe.ts > $PROBE
# base: e62727ec (loop 3 and its flakes' fix); new: this loop with the copy in 4 MiB pieces read in; new2: the copy by Blob slices (this loop).
declare -A REF=([base]=e62727ec [new]=9d8b90ae [new2]=snapz4)
i=0
for arm in $@; do
  i=$((i+1))
  git checkout -q "${REF[$arm]}" 2>&1 || { echo "checkout $arm failed"; exit 1; }
  echo "== $guest round $i: $arm at $(git rev-parse --short HEAD), core $(sha256sum target/wasm32-unknown-unknown/release/waarm64_core.wasm | cut -c1-16)"
  tag=$guest-$arm-$i
  rm -f $out/$tag.stop
  systemd-run --user --scope -q -p MemoryMax=1G -p MemorySwapMax=0 -- timeout 900 node $MW target/snapz/profile $out/$tag.mem.jsonl $out/$tag.stop &
  mw=$!
  WAARM64_PROFILE=target/snapz/profile WAARM64_DOWNLOADS=target/snapz/downloads ROUNDS=1 SETTLE_S=20 \
    systemd-run --user --scope -q -p MemoryMax=12G -p MemorySwapMax=0 -- timeout 580 \
    node $PROBE $guest $out/$tag.json 2>&1 | while IFS= read -r l; do echo "$(date +%s%3N) $l"; done > $out/$tag.log
  echo "rc=${PIPESTATUS[0]} $(grep -o '"commit":"[^"]*"' $out/$tag.json)"
  touch $out/$tag.stop; wait $mw
  grep -oE 'round 0 (kept|file|picked|suspend) \{"wallMs":[0-9]*,"kind":"[a-z]*","bytes":[0-9]*,"pausedMs":[0-9]*' $out/$tag.log
done
git checkout -q snapz4
rm -f $PROBE
echo ALLDONE
