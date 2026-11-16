#!/usr/bin/env bash
# SNAPZ loop 6's A/B (bench/boot/REPORT.md "SNAPZ loop 6"): per round and arm, bench/io/inflate-page.ts (Debian's boot to
# its login from the compressed qcow2, the reader's 1 MiB reads and the codec alone, an import, an export, a
# compressed export) and bench/io's `io_reads` (fio in the guest over target/bench/io-usr.qcow2), with the browser's
# RSS (every Chromium process, summed) sampled beside each. ARMS: a directory with swap.sh <arm> (each arm's web files
# and core wasm: base = 8facaffa, new = this loop, nopool = this loop with inflatePool's default size 0).
set -euo pipefail
cd "$(dirname "$0")/../../../.."
OUT=bench/boot/results/snapz-6/rounds
mkdir -p "$OUT"
rss() { # the peak of the browser's summed RSS (KiB) until the file $1 exists
  local peak=0 s
  while [ ! -e "$1" ]; do
    s=$(ps -eo comm=,rss= | awk '$1 ~ /chrom|headless/ {t+=$2} END {print t+0}')
    [ "$s" -gt "$peak" ] && peak=$s
    sleep 0.2
  done
  echo "$peak"
}
run() { # run <round> <arm>
  local r=$1 a=$2 stop
  "$ARMS/swap.sh" "$a"
  stop=$(mktemp -u); rss "$stop" > "$OUT/page-$a-$r.rss" & local p=$!
  systemd-run --user --scope -q -p MemoryMax=10G -p MemorySwapMax=0 -- timeout 400 \
    node bench/io/inflate-page.ts "$a-$r" boot,reads,import,export,export-c > "$OUT/page-$a-$r.json" 2> "$OUT/page-$a-$r.log" || echo "page $a $r failed"
  touch "$stop"; wait $p; rm -f "$stop"
  stop=$(mktemp -u); rss "$stop" > "$OUT/io-$a-$r.rss" & p=$!
  systemd-run --user --scope -q -p MemoryMax=10G -p MemorySwapMax=0 -- timeout 400 \
    node bench/run.ts --page bench/io/index.html --input target/bench/io-usr.qcow2 --only io_reads --out "$OUT/io-$a-$r.json" > "$OUT/io-$a-$r.log" 2>&1 || echo "io $a $r failed"
  touch "$stop"; wait $p; rm -f "$stop"
  echo "$(date +%T) round $r $a: $(tail -c 300 "$OUT/page-$a-$r.json")"
}
for a in base new nopool; do run 1 $a; done
for a in nopool new base; do run 2 $a; done
for a in new base nopool; do run 3 $a; done
"$ARMS/swap.sh" new
