#!/bin/bash
# bench/boot/results/m8-warm/tools/tpw.sh for this worktree: tpw.sh <name...> -- <round...> (cores in final/<name>.wasm)
cd "$(dirname "$0")/../../../.."
W=target/wasm32-unknown-unknown/release/webpc_core.wasm
D=bench/results/local/final
V=(); while [ "$1" != "--" ]; do V+=("$1"); shift; done; shift
mkdir -p $D/tp
for b in smp_alpine_jit smp_user_jit_4; do
  for r in "$@"; do
    for n in "${V[@]}"; do
      cp $D/$n.wasm $W && cmp -s $D/$n.wasm $W || { echo "copy $n failed"; exit 1; }
      O=$D/tp/$b-$n-$r
      systemd-run --user --scope -q -p MemoryMax=10G -p MemorySwapMax=0 -- timeout 590 npm run -s bench -- --page bench/boot/index.html --only $b --out $O.json > $O.log 2>&1
      echo "$b $n $r exit $? $(cmp -s $D/$n.wasm $W && echo same || echo CHANGED)"
    done
  done
done
