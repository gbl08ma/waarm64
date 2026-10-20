#!/bin/bash
# gates.sh <outdir> <round> <name>=<core.wasm>...: the gates (smp_alpine_jit, smp_user_jit_4) with each core in turn.
set -u
here=$(realpath "$(dirname "$0")")
cd "$(dirname "$0")/../../../.."
out=$1; round=$2; shift 2
mkdir -p "$out"
for b in smp_alpine_jit smp_user_jit_4; do
  for nc in "$@"; do
    name=${nc%%=*}; core=$here/${nc#*=}
    cp "$core" target/wasm32-unknown-unknown/release/webpc_core.wasm || exit 1 #/wasm32-unknown-unknown/release/webpc_core.wasm
    systemd-run --user --scope -q -p MemoryMax=8G -p MemorySwapMax=0 -- timeout 590 node --disable-warning=ExperimentalWarning bench/run.ts --page bench/boot/index.html --only $b --out "$out/$b-$name-$round.json" > "$out/$b-$name-$round.log" 2>&1
    echo "$b $name $round exit $?"
  done
done
