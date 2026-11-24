#!/usr/bin/env bash
# Builds one arm's core: build.sh <name> <WARM> <REPORT>, then restores the sources.
set -euo pipefail
cd ~/Development/waarm64
n=$1 w=$2 r=$3
sed -i "s/^pub const WARM: u32 = [0-9]*;/pub const WARM: u32 = $w;/" core/src/jit/mod.rs
sed -i "s/^pub const REPORT: u32 = [0-9]*;/pub const REPORT: u32 = $r;/" core/src/interp/block.rs
grep -n "^pub const WARM: u32\|^pub const REPORT: u32" core/src/jit/mod.rs core/src/interp/block.rs
systemd-run --user --scope -q -p MemoryMax=6G -p MemorySwapMax=0 -- timeout 580 scripts/build-wasm.sh 2>&1 | tail -2
cp target/wasm32-unknown-unknown/release/waarm64_core.wasm bench/results/local/perf68/$n.wasm
git checkout core/src/jit/mod.rs core/src/interp/block.rs
