#!/bin/bash
# pages.sh <core.wasm> <name>: Firefox's pages session with this core, the renderer's RSS beside it.
set -u
core=$(realpath "$1")
cd "$(dirname "$0")/../../../.."
name=$2
out=bench/results/local/liftoff/pages/$name
mkdir -p "$out"
cp "$core" target/wasm32-unknown-unknown/release/webpc_core.wasm || exit 1
bash bench/boot/results/m8-replay/r2/rss.sh "$out/rss.txt" 900 &
rp=$!
PHASES=pages TIMELINE_ALL=1 JITLOG=1 WEBPC_GUEST_USER=alarm systemd-run --user --scope -q -p MemoryMax=10G -p MemorySwapMax=0 -- timeout 900 node bench/gpu/firefox-load.ts virgl target/archarm/desktop.qcow2 "$out" > "$out/log.txt" 2>&1
echo "exit $?" >> "$out/log.txt"
kill $rp
node bench/gpu/stalls.ts "$out/pages-all.timeline.json" > "$out/stalls.txt" 2>&1
