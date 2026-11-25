#!/usr/bin/env bash
# One run of bench/io's suite (`--only io`, 5 boots) on a fresh persistent profile, with web/overlay.ts's `ORDERED`
# set to the arm's value for the run and put back after (on: true, off: false).
#   bench/io/results/2026-11-25-perf76/ab.sh <on|off> <round> [vm|mac]
set -euo pipefail
cd "$(dirname "$0")/../../../.."
arm=$1 round=$2 where=${3:-vm}
R=bench/io/results/2026-11-25-perf76
val=$([ "$arm" = on ] && echo true || echo false)
sed -i "s/^export const ORDERED = .*;/export const ORDERED = $val;/" web/overlay.ts
trap 'sed -i "s/^export const ORDERED = .*;/export const ORDERED = true;/" web/overlay.ts' EXIT
if [ "$where" = mac ]; then
  MAC_TIMEOUT=560 bench/run-mac.sh io-$arm-$round --page bench/io/index.html --input target/bench/io-raw.img --only io --profile=target/bench-profiles > /dev/null 2>bench/results/local/perf76/mac-$arm-$round.log
  cp bench/results/local/mac/io-$arm-$round.json $R/mac-io-profile-$arm-$round.json
else
  systemd-run --user --scope -q -p MemoryMax=8G -p MemorySwapMax=0 -- timeout 580 node bench/run.ts --page bench/io/index.html \
    --input target/bench/io-raw.img --only io --profile=target/bench-profiles --out $R/vm-io-profile-$arm-$round.json > /dev/null 2>bench/results/local/perf76/vm-$arm-$round.log
fi
echo "$where $arm $round done"
