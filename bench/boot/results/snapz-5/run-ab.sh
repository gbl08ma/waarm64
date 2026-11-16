#!/usr/bin/env bash
# SNAPZ loop 5's A/B: each round a fresh browser (ROUNDS=1), the arms alternated; an arm = its tree (git checkout; the
# wasm is the same: no core change). Both arms run this loop's probe (its OPS and off-the-record mode), copied beside
# the probe as an untracked bench/snapz/probe-l5.ts. A persistent profile's rounds run every operation with
# bench/snapz/memwatch.ts beside them; off the record (Playwright's default context) the load, a kept snapshot, the
# start from it and a download. Usage: run-ab.sh <guest> <persistent|off> <arm order, e.g. "base new new base">
set -uo pipefail
cd /home/gabriel.guest/Development/waarm64
guest=$1; prof=$2; shift 2
out=bench/results/local/snapz-5
mkdir -p $out
MW=$out/memwatch.ts
PROBE=bench/snapz/probe-l5.ts
cp bench/snapz/memwatch.ts $MW
git show snapz5:bench/snapz/probe.ts > $PROBE
# base: a34c9c85 (loop 4 and the SURFACE merge); new: this loop (snapz5, a local tag on its work-in-progress commit e407818b, which differs from the commit that has this script in its docs and results only).
declare -A REF=([base]=a34c9c85 [new]=snapz5)
i=0
for arm in $@; do
  i=$((i+1))
  git checkout -q "${REF[$arm]}" 2>&1 || { echo "checkout $arm failed"; exit 1; }
  echo "== $guest $prof round $i: $arm at $(git rev-parse --short HEAD), core $(sha256sum target/wasm32-unknown-unknown/release/waarm64_core.wasm | cut -c1-16)"
  tag=$guest-$prof-$arm-$i
  if [ "$prof" = persistent ]; then
    rm -f $out/$tag.stop
    systemd-run --user --scope -q -p MemoryMax=1G -p MemorySwapMax=0 -- timeout 900 node $MW target/snapz/profile $out/$tag.mem.jsonl $out/$tag.stop &
    mw=$!
    env WAARM64_PROFILE=target/snapz/profile WAARM64_DOWNLOADS=target/snapz/downloads ROUNDS=1 SETTLE_S=20 \
      systemd-run --user --scope -q -p MemoryMax=12G -p MemorySwapMax=0 -- timeout 580 \
      node $PROBE $guest $out/$tag.json 2>&1 | while IFS= read -r l; do echo "$(date +%s%3N) $l"; done > $out/$tag.log
    echo "rc=${PIPESTATUS[0]}"
    touch $out/$tag.stop; wait $mw
  else
    env WAARM64_PROFILE=off WAARM64_DOWNLOADS=target/snapz/downloads ROUNDS=1 SETTLE_S=20 OPS=load,kept,keptStart,file \
      systemd-run --user --scope -q -p MemoryMax=12G -p MemorySwapMax=0 -- timeout 580 \
      node $PROBE $guest $out/$tag.json 2>&1 | while IFS= read -r l; do echo "$(date +%s%3N) $l"; done > $out/$tag.log
    echo "rc=${PIPESTATUS[0]}"
  fi
  grep -oE 'round 0 (load|keptStart|resume) \{"wallMs":[0-9]*,"phases":\{[^}]*"disk":[0-9]*' $out/$tag.log | sed -E 's/"phases":\{.*"disk"/disk/'
  grep -oE 'round 0 (kept|file|picked|suspend) \{"wallMs":[0-9]*,"kind":"[a-z]*","bytes":[0-9]*,"pausedMs":[0-9]*' $out/$tag.log
done
git checkout -q main
rm -f $PROBE
echo ALLDONE
