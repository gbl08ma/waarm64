#!/bin/sh
# A/B of the byte budget: alternates two builds of the core (copies at $A and $B) over the same benchmark.
# usage: bench/mem/ab.sh <bench> <pairs> <A.wasm> <B.wasm> <outprefix>
set -e
W=target/wasm32-unknown-unknown/release/webpc_core.wasm
for i in $(seq 1 "$2"); do
  for v in A B; do
    if [ $v = A ]; then cp "$3" $W; else cp "$4" $W; fi
    timeout 300 node bench/run.ts --page bench/boot/index.html --only "$1" --out "$5-$v-$i.json" > /dev/null 2>&1
    echo "done $v $i"
  done
done
