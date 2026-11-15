#!/usr/bin/env bash
# SNAPZ loop 1's A/B: each round a fresh browser (ROUNDS=1), the arms alternated; an arm = its tree (git checkout)
# and its wasm (copied into the build's path). Usage: run-ab.sh <guest> <arm order, e.g. "base new base new base new">
set -uo pipefail
cd /home/gabriel.guest/Development/waarm64
guest=$1; shift
WASM=target/wasm32-unknown-unknown/release/waarm64_core.wasm
out=bench/results/local/snapz-1
declare -A REF=([base]=baa1e0b3 [new]=main)
i=0
for arm in $@; do
  i=$((i+1))
  git checkout -q --detach "${REF[$arm]}" 2>&1 || { echo "checkout $arm failed"; exit 1; }
  [ "$arm" = new ] && git checkout -q main
  cp target/snapz/arms/$arm.wasm $WASM
  want=$(sha256sum target/snapz/arms/$arm.wasm | cut -c1-16)
  echo "== $guest round $i: $arm at $(git rev-parse --short HEAD), core $want, ABI $(grep -o 'export const ABI = [0-9]*' web/vm.ts)"
  WAARM64_PROFILE=target/snapz/profile WAARM64_DOWNLOADS=target/snapz/downloads ROUNDS=1 SETTLE_S=20 \
    systemd-run --user --scope -q -p MemoryMax=12G -p MemorySwapMax=0 -- timeout 420 \
    node bench/snapz/probe.ts $guest $out/$guest-$arm-$i.json > $out/$guest-$arm-$i.log 2>&1
  echo "rc=$? $(grep -o '"core":"[0-9a-f]*"' $out/$guest-$arm-$i.json | head -1) $(grep -o '"commit":"[^"]*"' $out/$guest-$arm-$i.json)"
  tail -6 $out/$guest-$arm-$i.log | cut -c1-200
done
git checkout -q main
