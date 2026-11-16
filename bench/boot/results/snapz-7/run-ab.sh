#!/usr/bin/env bash
# SNAPZ loop 7's A/B: each round a fresh browser (ROUNDS=1), the arms alternated; an arm = its tree (git checkout: its
# page and its dev server, vite.config.ts; the wasm is the same, no core change). Every arm runs this loop's probe
# (bench/snapz/probe.ts as at ec293884), with a persistent profile, every operation, and bench/snapz/memwatch.ts beside
# it. Usage: run-ab.sh <guest> <arm order, e.g. "base head new new head base">
set -uo pipefail
cd /home/gabriel.guest/Development/waarm64
guest=$1; shift 1
out=bench/results/local/snapz-7
mkdir -p $out
MW=$out/memwatch.ts
PROBE=bench/snapz/probe-l7.ts
cp bench/snapz/memwatch.ts $MW
git show ec293884:bench/snapz/probe.ts > $PROBE
# base: ec293884 (loop 5); head: + the dev server's HEAD from stat (snapz7-head, a local tag); new: + the warm workers
# and the state moved to the device worker (snapz7-new, a local tag on this loop's work-in-progress commit).
declare -A REF=([base]=ec293884 [head]=snapz7-head [new]=snapz7-new)
i=0
for arm in $@; do
  i=$((i+1))
  git checkout -q "${REF[$arm]}" 2>&1 || { echo "checkout $arm failed"; exit 1; }
  echo "== $guest round $i: $arm at $(git rev-parse --short HEAD), core $(sha256sum target/wasm32-unknown-unknown/release/waarm64_core.wasm | cut -c1-16)"
  tag=$guest-$arm-$i
  rm -f $out/$tag.stop
  systemd-run --user --scope -q -p MemoryMax=1G -p MemorySwapMax=0 -- timeout 900 node $MW target/snapz/profile $out/$tag.mem.jsonl $out/$tag.stop &
  mw=$!
  env WAARM64_PROFILE=target/snapz/profile WAARM64_DOWNLOADS=target/snapz/downloads ROUNDS=1 SETTLE_S=20 \
    systemd-run --user --scope -q -p MemoryMax=12G -p MemorySwapMax=0 -- timeout 580 \
    node $PROBE $guest $out/$tag.json 2>&1 | while IFS= read -r l; do echo "$(date +%s%3N) $l"; done > $out/$tag.log
  echo "rc=${PIPESTATUS[0]}"
  touch $out/$tag.stop; wait $mw
  grep -oE 'round 0 (load|keptStart|resume) \{"wallMs":[0-9]*,"phases":\{[^}]*' $out/$tag.log | sed -E 's/"(checkRead|checkCrc|pool|read|crc|unpack|apply)":[0-9]*,//g'
  grep -oE 'round 0 (kept|file|picked|suspend) \{"wallMs":[0-9]*,"kind":"[a-z]*","bytes":[0-9]*,"pausedMs":[0-9]*' $out/$tag.log
done
git checkout -q main
rm -f $PROBE
echo ALLDONE
