#!/bin/bash
# Lane jitlock2 (bench/boot/REPORT.md "M8: a miss doesn't wait…"): run.sh churn|pages|go <round>|boot <round>|gates <round...>; the arms' cores in bench/results/local/arms/, results into bench/results/local/lock2/
cd "$(dirname "$0")/../../../../.."
A=bench/results/local/arms
O=bench/results/local/lock2
case $1 in
churn)
  PHASES=churn CHURN='rate=60&total=4000' CHURN_S=300 FROM=target/snapbench/pages.webpcsnap SESSION_S=500 \
    bash bench/gpu/ab.sh $O/churn${2:-} 1 base=$A/base.wasm lock2=$A/lock2.wasm imin=$A/imin.wasm base2=$A/base2.wasm ;;
pages)
  FROM=target/snapbench/pages.webpcsnap SESSION_S=700 \
    bash bench/gpu/ab.sh $O/pages${2:-} 1 base=$A/base.wasm lock2=$A/lock2.wasm imin=$A/imin.wasm base2=$A/base2.wasm ;;
go)
  # go.sh <round>: each arm's go build loop, 300 s from debian-go.webpcsnap
  CMD='GOTARGET=hello; mount -o ro /dev/vdb /mnt; while :; do s=$(date +%s); rm -rf /tmp/gc /tmp/work; cp -r /mnt/work /tmp/work; cd /tmp/work/${GOTARGET:-hello} && GOROOT=/mnt/go GOCACHE=/tmp/gc GOFLAGS=-mod=mod /mnt/go/bin/go build -o /tmp/web . ; echo GOBUILD rc=$? $(( $(date +%s) - s ))s; cd /; done'
  mkdir -p $O/go
  for arm in ${ARMS:-base lock2 imin}; do
    systemd-run --user --scope -q -p MemoryMax=10G -p MemorySwapMax=0 -- timeout 500 node bench/stress/stress.ts --seconds 300 --ncpus 4 --no-load \
      --disk2 target/images/stress/goroot.ext4 --core $A/$arm.wasm --from-snapshot target/snapbench/debian-go.webpcsnap \
      --guest-cmd "$CMD" --out $O/go/$arm-$2.jsonl > $O/go/$arm-$2.log 2>&1
    echo "go $arm $2 exit $?"
  done ;;
boot)
  # boot.sh <round>: Debian's boot and login (4 vCPUs), counts at the first sample
  mkdir -p $O/boot
  for arm in ${ARMS:-base imin}; do
    systemd-run --user --scope -q -p MemoryMax=10G -p MemorySwapMax=0 -- timeout 300 node bench/stress/stress.ts --seconds 10 --interval 5 --ncpus 4 --no-load \
      --core $A/$arm.wasm --out $O/boot/$arm-$2.jsonl > $O/boot/$arm-$2.log 2>&1
    echo "boot $arm $2 exit $?"
  done ;;
gates)
  # gates <round...>: smp_alpine_jit and smp_user_jit_4, the arms alternating within each round (as m8-lock/tools/tpw.sh)
  shift; W=target/wasm32-unknown-unknown/release/webpc_core.wasm
  cp $W $A/built.wasm
  mkdir -p $O/gates
  for b in smp_alpine_jit smp_user_jit_4; do
    for r in "$@"; do
      for n in ${ARMS:-base lock2 imin}; do
        cp $A/$n.wasm $W && cmp -s $A/$n.wasm $W || { echo "copy $n failed"; exit 1; }
        G=$O/gates/$b-$n-$r
        systemd-run --user --scope -q -p MemoryMax=10G -p MemorySwapMax=0 -- timeout 590 npm run -s bench -- --page bench/boot/index.html --only $b --out $G.json > $G.log 2>&1
        echo "$b $n $r exit $? $(cmp -s $A/$n.wasm $W && echo same || echo CHANGED)"
      done
    done
  done
  cp $A/built.wasm $W ;;
esac
