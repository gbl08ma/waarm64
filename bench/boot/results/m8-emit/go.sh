#!/bin/bash
# The 4-vCPU `go build` loop from target/snapbench/debian-go.webpcsnap (docs/benchmarking.md "Screening an A/B" 4),
# alternating core builds: go.sh <outdir> <seconds> <rounds> <name>=<core.wasm>... (in the background, alone).
cd "$(dirname "$0")/../../../.."
out=$1 secs=$2 rounds=$3; shift 3
mkdir -p "$out"
CMD='GOTARGET=hello; mount -o ro /dev/vdb /mnt; while :; do s=$(date +%s); rm -rf /tmp/gc /tmp/work; cp -r /mnt/work /tmp/work; cd /tmp/work/${GOTARGET:-hello} && GOROOT=/mnt/go GOCACHE=/tmp/gc GOFLAGS=-mod=mod /mnt/go/bin/go build -o /tmp/web . ; echo GOBUILD rc=$? $(( $(date +%s) - s ))s; cd /; done'
for r in $(seq 1 "$rounds"); do
  for arm in "$@"; do
    name=${arm%%=*} core=${arm#*=}
    systemd-run --user --scope -q -p MemoryMax=10G -p MemorySwapMax=0 -- timeout $((secs + 120)) \
      node bench/stress/stress.ts --seconds "$secs" --ncpus 4 --no-load --disk2 target/images/stress/goroot.ext4 \
      --core "$core" --from-snapshot target/snapbench/debian-go.webpcsnap --guest-cmd "$CMD" --out "$out/$name-$r.jsonl" > "$out/$name-$r.log" 2>&1
    echo "$name-$r exit $?"
  done
done
