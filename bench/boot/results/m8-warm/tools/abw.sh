#!/bin/bash
# Firefox pages sessions alternating core builds: abw.sh <name...> -- <round...>   (<name>.wasm in this directory)
cd ~/Development/webpc
W=target/wasm32-unknown-unknown/release/webpc_core.wasm
V=(); while [ "$1" != "--" ]; do V+=("$1"); shift; done; shift
for r in "$@"; do
  for n in "${V[@]}"; do
    cp bench/results/local/warm/$n.wasm $W && cmp -s bench/results/local/warm/$n.wasm $W || { echo "copy $n failed"; exit 1; }
    O=bench/results/local/warm/$n-$r; mkdir -p $O
    PHASES=pages TIMELINE_ALL=1 systemd-run --user --scope -q -p MemoryMax=10G -p MemorySwapMax=0 -- timeout 900 node bench/gpu/firefox-load.ts virgl target/archarm/desktop.qcow2 $O > $O/log.txt 2>&1
    echo "$n-$r exit $? $(cmp -s bench/results/local/warm/$n.wasm $W && echo same || echo CHANGED) $(node bench/gpu/stalls.ts $O/pages-all.timeline.json 2>&1)"
  done
done
