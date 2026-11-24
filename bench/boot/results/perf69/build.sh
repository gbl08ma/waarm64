#!/usr/bin/env bash
# Builds one arm's core: build.sh <name> <threshold> <threshold_max>, then restores the source.
set -euo pipefail
cd ~/Development/waarm64
n=$1 t=$2 m=$3
sed -i "s/^        threshold: 1000,$/        threshold: $t,/; s/^        threshold_max: 2000,$/        threshold_max: $m,/" core/src/jit/mod.rs
grep -n "^        threshold: $t,\|^        threshold_max: $m," core/src/jit/mod.rs
systemd-run --user --scope -q -p MemoryMax=6G -p MemorySwapMax=0 -- timeout 580 scripts/build-wasm.sh 2>&1 | tail -2
cp target/wasm32-unknown-unknown/release/waarm64_core.wasm bench/results/local/perf69/$n.wasm
git checkout core/src/jit/mod.rs
