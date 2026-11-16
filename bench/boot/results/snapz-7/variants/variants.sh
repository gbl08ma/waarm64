#!/usr/bin/env bash
# SNAPZ loop 7: which workers to start ahead, on the working tree (loads only): new (every worker ahead: its logs are
# desktop-allwarm-*), dev (the device worker only: what was taken), late (every worker, after the check pass)
set -uo pipefail
cd /home/gabriel.guest/Development/waarm64
g=$1; shift
out=bench/results/local/snapz-7/var; mkdir -p $out
i=0
for arm in "$@"; do
  i=$((i+1))
  git checkout -q -- web/app/worker.ts
  case $arm in
    dev) sed -i 's|() => (warm ??= warmFor(m)))|() => (warm ??= warmWorkers(0, false)))|' web/app/worker.ts; sed -i "s|^import { bootVm, compileCore, Exit, PSCI_SYSTEM_OFF, type Restore, type Vm, type WarmWorkers } from '../vm.ts';|import { bootVm, compileCore, Exit, PSCI_SYSTEM_OFF, warmWorkers, type Restore, type Vm, type WarmWorkers } from '../vm.ts';|" web/app/worker.ts;;
    late) sed -i 's|, () => (warm ??= warmFor(m)));|);\n  warm ??= warmFor(m);|' web/app/worker.ts;;
  esac
  git diff --stat web/app/worker.ts | tail -1
  env WAARM64_PROFILE=target/snapz/profile WAARM64_DOWNLOADS=target/snapz/downloads ROUNDS=1 SETTLE_S=3 OPS=load \
    systemd-run --user --scope -q -p MemoryMax=12G -p MemorySwapMax=0 -- timeout 300 node bench/snapz/probe.ts $g $out/$g-$arm-$i.json > $out/$g-$arm-$i.log 2>&1
  echo "$arm $(grep -oE 'round 0 load \{"wallMs":[0-9]*,"phases":\{[^}]*' $out/$g-$arm-$i.log | sed -E 's/"(checkRead|checkCrc|pool|read|crc|unpack|apply)":[0-9]*,//g')"
done
git checkout -q -- web/app/worker.ts
echo VDONE
