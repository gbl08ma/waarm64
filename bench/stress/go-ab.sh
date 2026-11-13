#!/usr/bin/env bash
# The `go build` loop as an A/B gate (docs/benchmarking.md "Screening an A/B"): from target/snapbench/debian-go.waarm64snap
# (bench/gpu/warm-snapshots.sh debian), 4 vCPUs, the guest building /work/hello from goroot.ext4 over and over, each
# build timed by the guest in ms; the arms alternate each round. Then `node bench/stress/gobuild.ts <outdir>/[!w]*.jsonl`.
#   [SECONDS_=420] [WARMUP=0] bench/stress/go-ab.sh <outdir> <rounds> <arm>=<core.wasm>...
# A first session of the first arm runs before the rounds and is dropped (`warmup-0`: the first session of a run
# built 6.6% slower than the three after it, which agreed within 0.3%; WARMUP=0 skips it). Each session runs under a 10 GiB scope and `timeout`: run this alone, in the background.
set -u
cd "$(dirname "$0")/../.."
out=$1 rounds=$2; shift 2
mkdir -p "$out"
loop='mount -o ro /dev/vdb /mnt 2>/dev/null; while :; do rm -rf /tmp/gc /tmp/work; cp -r /mnt/work /tmp/work; cd /tmp/work/hello; s=$(date +%s%N); GOROOT=/mnt/go GOCACHE=/tmp/gc GOFLAGS=-mod=mod /mnt/go/bin/go build -o /tmp/web .; r=$?; e=$(date +%s%N); echo GOBUILD rc=$r $(( (e - s) / 1000000 ))ms; cd /; done'
first=$1
[ "${WARMUP:-1}" = 0 ] || set -- "warmup=${first#*=}" "$@"
for r in $(seq 1 "$rounds"); do
  for arm in "$@"; do
    [ "${arm%%=*}" = warmup ] && { [ "$r" = 1 ] || continue; r0=$r; r=0; }
    name=${arm%%=*} core=${arm#*=}
    [ -f "$core" ] || { echo "no core $core"; exit 1; }
    systemd-run --user --scope -q -p MemoryMax=10G -p MemorySwapMax=0 -- timeout $(( ${SECONDS_:-420} + 240 )) \
      node --disable-warning=ExperimentalWarning bench/stress/stress.ts --from-snapshot target/snapbench/debian-go.waarm64snap \
      --disk2 target/images/stress/goroot.ext4 --no-load --seconds "${SECONDS_:-420}" --ncpus 4 --core "$core" \
      --guest-cmd "$loop" --out "$out/$name-$r.jsonl" > "$out/$name-$r.log" 2>&1
    echo "$name-$r exit $? $(grep -c '"gobuild"' "$out/$name-$r.jsonl" 2>/dev/null) builds"
    [ "$name" = warmup ] && r=$r0
  done
done
