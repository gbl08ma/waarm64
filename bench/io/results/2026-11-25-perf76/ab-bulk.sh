#!/usr/bin/env bash
# One run of bench/io's `io_bulk` (an import, a changes file's load, a merge: 3 rounds each) with this loop's change
# (`new`: bulk.patch applied, as committed) or without it (`base`: bulk.patch taken out for the run, put back after).
#   bench/io/results/2026-11-25-perf76/ab-bulk.sh <base|new> <round> [vm|mac] [off]   (off: off the record)
set -euo pipefail
cd "$(dirname "$0")/../../../.."
arm=$1 round=$2 where=${3:-vm} rec=${4:-profile}
R=bench/io/results/2026-11-25-perf76
prof=--profile=target/bench-profiles
[ "$rec" = off ] && prof=
if [ "$arm" = base ]; then
  git apply -R $R/bulk.patch
  trap 'git apply $R/bulk.patch' EXIT
fi
name=$where-bulk-$rec-$arm-$round
if [ "$where" = mac ]; then
  MAC_TIMEOUT=560 bench/run-mac.sh $name --page bench/io/index.html --input target/bench/io-raw.img --only io_bulk $prof > /dev/null 2>bench/results/local/perf76/$name.log
  cp bench/results/local/mac/$name.json $R/$name.json
else
  systemd-run --user --scope -q -p MemoryMax=8G -p MemorySwapMax=0 -- timeout 580 node bench/run.ts --page bench/io/index.html \
    --input target/bench/io-raw.img --only io_bulk $prof --out $R/$name.json > /dev/null 2>bench/results/local/perf76/$name.log
fi
echo "$name done"
