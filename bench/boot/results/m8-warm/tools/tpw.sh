#!/bin/bash
# Throughput gates alternating core builds: tpw.sh <name...> -- <round...>
cd ~/Development/webpc
W=target/wasm32-unknown-unknown/release/webpc_core.wasm
V=(); while [ "$1" != "--" ]; do V+=("$1"); shift; done; shift
mkdir -p bench/results/local/warm/tp
for b in smp_alpine_jit smp_user_jit_4; do
  for r in "$@"; do
    for n in "${V[@]}"; do
      cp bench/results/local/warm/$n.wasm $W && cmp -s bench/results/local/warm/$n.wasm $W || { echo "copy $n failed"; exit 1; }
      O=bench/results/local/warm/tp/$b-$n-$r
      systemd-run --user --scope -q -p MemoryMax=10G -p MemorySwapMax=0 -- timeout 590 npm run -s bench -- --page bench/boot/index.html --only $b --out $O.json > $O.log 2>&1
      echo "$b $n $r exit $? $(cmp -s bench/results/local/warm/$n.wasm $W && echo same || echo CHANGED)"
    done
  done
done
