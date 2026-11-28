#!/usr/bin/env bash
# PERF loop 99's load A/B on the dev VM: arms are the temporary toggles (AB99_* in web/snapshot-file.ts and
# web/app/worker-start.ts) set by sed before each run, each run a fresh browser (ROUNDS=1), the arms in turn, the order
# rotated each round. Usage: run-ab.sh <outdir> <rounds> <arm>... (arms: base one one8 one8any one8anyblob one16any one16anyblob one8blob)
set -uo pipefail
cd /home/gabriel.guest/Development/waarm64
out=$1; rounds=$2; shift 2
mkdir -p "$out"
set_arm() { # one ahead any blob
  sed -i "s|^const ONE99 = .*; // AB99_ONE|const ONE99 = $1; // AB99_ONE|" web/app/worker-start.ts
  sed -i "s|^const AHEAD = .*; // AB99_AHEAD|const AHEAD = $2; // AB99_AHEAD|; s|^const ANY99 = .*; // AB99_ANY|const ANY99 = $3; // AB99_ANY|; s|^const BLOB99 = .*; // AB99_BLOB|const BLOB99 = $4; // AB99_BLOB|" web/snapshot-file.ts
}
declare -A ARM=([base]="false 4 false false" [one]="true 4 false false" [one8]="true 8 false false" [one8any]="true 8 true false" [one8anyblob]="true 8 true true" [one16any]="true 16 true false" [one16anyblob]="true 16 true true" [one8blob]="true 8 false true")
arms=("$@")
for k in $(seq 1 "$rounds"); do
  for i in "${!arms[@]}"; do
    a=${arms[$(( (i + k) % ${#arms[@]} ))]}
    set_arm ${ARM[$a]}
    WAARM64_PORT=8231 WAARM64_PROFILE=target/snapz/profile WAARM64_DOWNLOADS=target/snapz/downloads ROUNDS=1 SETTLE_S=${SETTLE_S:-5} OPS=${OPS:-load} \
      systemd-run --user --scope -q -p MemoryMax=11G -p MemorySwapMax=0 -- timeout 240 \
      node bench/snapz/probe.ts ${GUEST:-desktop} "$out/$a-$k.json" > "$out/$a-$k.log" 2>&1
    echo "$k $a rc=$? $(grep -E '^round 0 (load|kept)' "$out/$a-$k.log" | cut -c1-160 | tr '\n' ' ')"
  done
done
set_arm true 8 true true
echo ALLDONE
