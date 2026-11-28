#!/usr/bin/env bash
# PERF loop 99's final A/B on the dev VM: base = web/ at the loop's base (9553399d: this loop's web/ patch taken out),
# new = web.patch applied; each run a fresh browser (ROUNDS=1), the arms alternated, the order rotated each round.
# Usage: run-ab2.sh <outdir> <rounds> <guest>  (OPS, SETTLE_S as bench/snapz/probe.ts's)
set -uo pipefail
cd /home/gabriel.guest/Development/waarm64
out=$1; rounds=$2; guest=$3
patch=bench/boot/results/perf99/web.patch
mkdir -p "$out"
arm() { if [ "$1" = base ]; then git apply -R --check "$patch" 2>/dev/null && git apply -R "$patch"; else git apply --check "$patch" 2>/dev/null && git apply "$patch"; fi; }
trap 'arm new' EXIT
for k in $(seq 1 "$rounds"); do
  for a in $([ $((k % 2)) = 1 ] && echo "base new" || echo "new base"); do
    arm $a
    WAARM64_PORT=8231 WAARM64_PROFILE=target/snapz/profile WAARM64_DOWNLOADS=target/snapz/downloads ROUNDS=1 SETTLE_S=${SETTLE_S:-20} OPS=${OPS:-load,kept} \
      systemd-run --user --scope -q -p MemoryMax=11G -p MemorySwapMax=0 -- timeout 280 \
      node bench/snapz/probe.ts "$guest" "$out/$guest-$a-$k.json" > "$out/$guest-$a-$k.log" 2>&1
    echo "$k $a rc=$? $(grep -E '^round 0 (load|kept)' "$out/$guest-$a-$k.log" | cut -c1-140 | tr '\n' ' ')"
  done
done
echo ALLDONE
