#!/usr/bin/env bash
# Alternated A/B: the exact core against the growable import (?growcore), same build.
cd "$(dirname "$0")/../../../.."
D=bench/results/local/exactcore
for r in 1 2 3; do
  for arm in exact grow; do
    q=; [ $arm = grow ] && q=--query=growcore
    for b in alpine_user_jit boot_alpine_jit; do
      timeout 400 node bench/run.ts --page bench/boot/index.html --only $b $q --out $D/$b-$arm-$r.json > $D/$b-$arm-$r.log 2>&1 || echo "fail $b $arm $r"
      echo "$(date +%T) $b $arm $r: $(grep -o '_total .*' $D/$b-$arm-$r.log | grep -oE '[0-9.]+ ±[0-9.]+ ms')"
    done
  done
done
