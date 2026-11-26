#!/usr/bin/env bash
# PERF loop 85's probe A/B on the dev VM: each round a fresh browser (ROUNDS=1), the arms alternated; an arm = its tree
# (git checkout: base = loop 84's bc6852bf, new = this loop); one core wasm (no Rust changed). The probe itself is this
# loop's (copied out as bench/snapz/probe85-run.ts: it leaves the page by a navigation, so the next round's autostart
# isn't held by a "closed while running" mark). Usage: run-ab.sh <new ref> <arm order, e.g. "base new new base">
set -uo pipefail
cd /home/gabriel.guest/Development/waarm64
newref=$1; shift
out=bench/boot/results/perf85/rounds
mkdir -p $out
declare -A REF=([base]=bc6852bf [new]=$newref)
i=0
for arm in $@; do
  i=$((i+1))
  git checkout -q "${REF[$arm]}" 2>&1 || { echo "checkout $arm failed"; exit 1; }
  echo "== round $i: $arm at $(git rev-parse --short HEAD)"
  WAARM64_PORT=8231 WAARM64_PROFILE=target/snapz/profile WAARM64_DOWNLOADS=target/snapz/downloads ROUNDS=1 SETTLE_S=20 OPS=load,kept \
    systemd-run --user --scope -q -p MemoryMax=11G -p MemorySwapMax=0 -- timeout 420 \
    node bench/snapz/probe85-run.ts desktop $out/desktop-$arm-$i.json > $out/desktop-$arm-$i.log 2>&1
  echo "rc=$? $(grep -E '^round 0 (load|kept)' $out/desktop-$arm-$i.log | cut -c1-120 | tr '\n' ' ')"
done
git checkout -q "$newref"
echo ALLDONE
