#!/bin/bash
# Firefox's pages session from a warm snapshot on the Mac host, alternating core builds (docs/benchmarking.md
# "Starting from a snapshot"; dev-only):
#   bench/gpu/ab-mac.sh <outdir> <rounds> <arm>=<core.wasm>[@<tree>][+<query>]...
# Each session is bench/gpu/sway-mac.sh's SCRIPT=firefox-load.ts with WASM=<core.wasm>, FROM_SNAPSHOT=$FROM (default
# target/snapbench/pages.waarm64snap, bench/gpu/warm-snapshots.sh firefox), PHASES=pages, PHASE_S (default 1: each
# page's frames for a second, the starts and loads are the measure), JITLOG=1 and TIMELINE_ALL=1 on Arch Linux ARM's
# disk (IMAGE). `@<tree>` runs that arm from another checkout (its own web/ and scripts: a core whose ABI the current
# page doesn't take, e.g. `../waarm64-base` at an older commit); its target/ must be this one's (a symlink), so the
# snapshot's disk opens at the same path. `+<query>` adds to that arm's page query (QUERY's, e.g. `+count=0`: PERF
# loop 55's polled code without `acc`). Each round starts with the next arm (a session's first run is an outlier
# either way). Into <outdir>/<arm>-<round>/: results.json, log.txt, wall.txt, stalls.json (bench/gpu/stalls.ts),
# counts.json, jit.jsonl.gz (as bench/gpu/ab.sh), the Mac's vmstat; the timelines are deleted. bench/gpu/mac-leftovers.sh
# --kill after every session. Then `node bench/gpu/ab-summary.ts <outdir>` (`pagesS`: Firefox's starts and the pages'
# loads, summed). Each session is bounded on the Mac (MAC_TIMEOUT, default 600 s) and here (SESSION_S, 800): run it
# alone, in the background, nothing on the dev VM or the Mac beside it.
set -u
cd "$(dirname "$0")/../.."
repo=$PWD
out=$(realpath -m "$1") rounds=$2; shift 2
from=$(realpath "${FROM:-target/snapbench/pages.waarm64snap}") || exit 1
cap() { systemd-run --user --scope -q -p MemoryMax="$1" -p MemorySwapMax=0 -- timeout "$2" "${@:3}"; }
arms=("$@") n=$#
for r in $(seq 1 "$rounds"); do
  for k in $(seq 0 $((n - 1))); do
    arm=${arms[$(( (k + r - 1) % n ))]}
    name=${arm%%=*} rest=${arm#*=} tree=$repo q=${QUERY:-}
    case $rest in *+*) q=${q:+$q&}${rest#*+} rest=${rest%%+*} ;; esac
    case $rest in *@*) tree=$(realpath "${rest#*@}") rest=${rest%%@*} ;; esac
    core=$(realpath "$rest") || exit 1
    tag=abmac-$name-$r o=$out/$name-$r
    rm -rf "$o" "$tree/bench/results/local/$tag" "$tree/bench/results/local/$tag".*; mkdir -p "$o"
    t0=$(date +%s.%N)
    QUERY=$q WASM=$core SCRIPT=firefox-load.ts FROM_SNAPSHOT=$from PHASES=pages PHASE_S=${PHASE_S:-1} JITLOG=1 TIMELINE_ALL=1 \
      WAARM64_GUEST_USER=${WAARM64_GUEST_USER:-alarm} MAC_TIMEOUT=${MAC_TIMEOUT:-600} \
      timeout "${SESSION_S:-800}" "$tree/bench/gpu/sway-mac.sh" virgl "${IMAGE:-target/archarm/desktop.qcow2}" "$tag" > "$o/log.txt" 2>&1
    code=$?
    t1=$(date +%s.%N)
    echo "$t0 $t1 $code" | awk '{printf "wall %.1f exit %d\n", $2-$1, $3}' > "$o/wall.txt"
    mv "$tree/bench/results/local/$tag"/* "$o/" 2>/dev/null
    for f in "$tree/bench/results/local/$tag".*; do [ -f "$f" ] && mv "$f" "$o/mac${f##*/$tag}"; done
    rmdir "$tree/bench/results/local/$tag" 2>/dev/null
    tl=$(ls "$o"/*.timeline.json 2>/dev/null)
    [ -n "$tl" ] && cap 4G 120 node bench/gpu/stalls.ts --json $tl > "$o/stalls.json" 2>/dev/null
    [ -f "$o/jit.jsonl" ] && cap 4G 120 node bench/boot/results/m8-replay/counts.ts report --json "$o/jit.jsonl" > "$o/counts.json" 2>/dev/null && gzip -f "$o/jit.jsonl"
    rm -f $tl
    echo "$name-$r $(cat "$o/wall.txt") $(timeout 60 bench/gpu/mac-leftovers.sh --kill 2>&1 | tail -1)"
  done
done
