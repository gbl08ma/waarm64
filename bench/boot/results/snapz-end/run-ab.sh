#!/usr/bin/env bash
# SNAPZ's end A/B (bench/boot/REPORT.md "SNAPZ: the track's end"): each round a fresh browser (ROUNDS=1), the arms
# alternated; an arm = its tree (git checkout: its page, its dev server) and its core (copied into the build's path).
# Every arm runs the finished tree's probe (bench/snapz/probe.ts at snapzend-fix: it reads headers itself, so it runs
# on loop 0's tree), with a persistent profile of the arm's own (loop 0's page and the finished one's store differ),
# every operation (OPS overrides), bench/snapz/memwatch.ts beside it.
#   run-ab.sh <guest> <arm order, e.g. "base new new base">
# base: loop 0 (baa1e0b3) + vite.config.ts's HEAD from stat (loop 7's, not the code under test: snapzend-base, a local
# tag) and loop 0's core; new: the finished tree (snapzend-fix) and its core; prefix: f31e50f1 (before the review's
# fixes) with the finished core (E1's cost: the core's change, E6, is the deflate exports' only).
set -uo pipefail
cd /home/gabriel.guest/Development/waarm64
guest=$1; shift 1
out=bench/results/local/snapz-end
mkdir -p $out
WASM=target/wasm32-unknown-unknown/release/waarm64_core.wasm
MW=$out/memwatch.ts
PROBE=bench/snapz/probe-end.ts
cp bench/snapz/memwatch.ts $MW
git show snapzend-fix:bench/snapz/probe.ts > $PROBE
declare -A REF=([base]=snapzend-base [new]=snapzend-fix [prefix]=snapzend-prefix)
declare -A PROF=([base]=target/snapz/profile-end-base [new]=target/snapz/profile-end-new [prefix]=target/snapz/profile-end-new)
i=0
for arm in $@; do
  i=$((i+1))
  git checkout -q --detach "${REF[$arm]}" 2>&1 || { echo "checkout $arm failed"; exit 1; }
  cp target/snapz/end-arms/$arm.wasm $WASM
  echo "== $guest round $i: $arm at $(git rev-parse --short HEAD), core $(sha256sum $WASM | cut -c1-16)"
  tag=$guest-$arm-$i
  rm -f $out/$tag.stop
  systemd-run --user --scope -q -p MemoryMax=1G -p MemorySwapMax=0 -- timeout 900 node $MW ${PROF[$arm]} $out/$tag.mem.jsonl $out/$tag.stop &
  mw=$!
  env WAARM64_PROFILE=${PROF[$arm]} WAARM64_DOWNLOADS=target/snapz/downloads ROUNDS=1 SETTLE_S=20 \
    systemd-run --user --scope -q -p MemoryMax=12G -p MemorySwapMax=0 -- timeout 580 \
    node $PROBE $guest $out/$tag.json 2>&1 | while IFS= read -r l; do echo "$(date +%s%3N) $l"; done > $out/$tag.log
  echo "rc=${PIPESTATUS[0]}"
  touch $out/$tag.stop; wait $mw
  grep -oE 'round 0 (load|keptStart|resume) \{"wallMs":[0-9]*,"phases":\{[^}]*' $out/$tag.log | sed -E 's/"(checkRead|checkCrc|pool|read|crc|unpack|apply)":[0-9.]*,//g' | cut -c1-200
  grep -oE 'round 0 (kept|file|picked|suspend) \{"wallMs":[0-9]*,"kind":"[a-z]*","bytes":[0-9]*,"pausedMs":[0-9]*' $out/$tag.log
done
git checkout -q main
cp target/snapz/end-arms/new.wasm $WASM
rm -f $PROBE
echo ALLDONE
