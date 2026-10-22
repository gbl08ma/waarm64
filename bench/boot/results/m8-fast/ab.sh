#!/bin/bash
# A/B of the fast completions (bench/boot/REPORT.md "M8: exits finished in place"): arms alternate A B B A A B; D holds a.wasm and b.wasm.
cd "$(dirname "$0")/../../../.."
W=target/wasm32-unknown-unknown/release/webpc_core.wasm
D=${D:-bench/results/local/ab-fast}
i=0
for arm in a b b a a b; do
  i=$((i + 1))
  for bench in smp_user_jit_4 smp_alpine_jit; do
    cp $D/$arm.wasm $W
    systemd-run --user --scope -q -p MemoryMax=10G -p MemorySwapMax=0 -- timeout 560 node bench/run.ts --page bench/boot/index.html --only $bench --out $D/$arm-$i-$bench.json > $D/$arm-$i-$bench.log 2>&1
    echo "$arm $i $bench $(grep -o '"median":[0-9.]*' $D/$arm-$i-$bench.json | head -3 | tr '\n' ' ')"
  done
done
cp $D/b.wasm $W
