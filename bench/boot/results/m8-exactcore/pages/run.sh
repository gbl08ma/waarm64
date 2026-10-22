#!/bin/bash
# The pages session A/B of bench/boot/REPORT.md "M8: the core with exact memory limits": old = the core with the block
# map's page index of whole keys (core/src/jit/mod.rs at 739e76b plus the prune's clock, ABI 50) on the growable import
# (?growcore); new = cde27e5's core. Run from the repo, alone.
D=bench/results/local/pageidx
FROM=target/snapbench/pages.webpcsnap MEMLOG=5 bash bench/gpu/ab.sh $D/pages 3 "old=$D/old.wasm?growcore" new=$D/new.wasm
node bench/gpu/ab-summary.ts $D/pages
node bench/boot/results/m8-heap/long/tools/heapsum.ts $D/pages
