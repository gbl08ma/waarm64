#!/usr/bin/env bash
# SNAPZ loop 3's A/B: each round a fresh browser (ROUNDS=1), the arms alternated; an arm = its tree (git checkout; the
# wasm is the same, core a8deea54: no core change). Both arms run this loop's probe (its kept-snapshot start), copied
# beside the probe as an untracked bench/snapz/probe-l3.ts; bench/snapz/memwatch.ts beside each round (the browser's
# memory by process every 50 ms). Usage: run-ab.sh <guest> <arm order, e.g. "base new new base">
set -uo pipefail
cd /home/gabriel.guest/Development/waarm64
guest=$1; shift
out=bench/results/local/snapz-3
mkdir -p $out
MW=$out/memwatch.ts
PROBE=bench/snapz/probe-l3.ts
cp bench/snapz/memwatch.ts $MW
git show snapz3:bench/snapz/probe.ts > $PROBE
# base: 85e2681e (loop 2b); new: this loop.
declare -A REF=([base]=85e2681e [new]=snapz3)
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
    systemd-run --user --scope -q -p MemoryMax=12G -p MemorySwapMax=0 -- timeout 480 \
    node $PROBE $guest $out/$tag.json 2>&1 | while IFS= read -r l; do echo "$(date +%s%3N) $l"; done > $out/$tag.log
  echo "rc=${PIPESTATUS[0]} $(grep -o '"commit":"[^"]*"' $out/$tag.json)"
  touch $out/$tag.stop; wait $mw
  grep -oE 'round 0 (load|keptStart|resume) \{"wallMs":[0-9]*' $out/$tag.log
done
git checkout -q snapz3
rm -f $PROBE
echo ALLDONE
