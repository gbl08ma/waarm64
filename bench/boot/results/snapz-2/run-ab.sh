#!/usr/bin/env bash
# SNAPZ loop 2's A/B: each round a fresh browser (ROUNDS=1), the arms alternated; an arm = its tree (git checkout). The
# core is the same in every arm (loop 2 changed no Rust): one wasm. Usage: run-ab.sh <guest> <arm order, e.g. "base new four">
set -uo pipefail
cd /home/gabriel.guest/Development/waarm64
guest=$1; shift
out=bench/results/local/snapz-2
mkdir -p $out
# base: loop 1 (one thread); new: this loop (the pool, 6 workers on the dev VM's 8 threads); four: a local branch, this
# loop with POOL_MAX = 4 in web/snapshot-pool.ts (removed after the run).
declare -A REF=([base]=0094eeee [new]=main [four]=snapz2-four)
i=0
for arm in $@; do
  i=$((i+1))
  git checkout -q "${REF[$arm]}" 2>&1 || { echo "checkout $arm failed"; exit 1; }
  echo "== $guest round $i: $arm at $(git rev-parse --short HEAD), pool max $(grep -o 'POOL_MAX = [0-9]*' web/snapshot-pool.ts 2>/dev/null || echo none)"
  WAARM64_PROFILE=target/snapz/profile WAARM64_DOWNLOADS=target/snapz/downloads ROUNDS=1 SETTLE_S=20 \
    systemd-run --user --scope -q -p MemoryMax=12G -p MemorySwapMax=0 -- timeout 420 \
    node bench/snapz/probe.ts $guest $out/$guest-$arm-$i.json > $out/$guest-$arm-$i.log 2>&1
  echo "rc=$? $(grep -o '"commit":"[^"]*"' $out/$guest-$arm-$i.json)"
  tail -6 $out/$guest-$arm-$i.log | cut -c1-160
done
git checkout -q main
echo ALLDONE
