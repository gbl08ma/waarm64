#!/bin/bash
# Firefox sessions alternating core builds (docs/benchmarking.md "Starting from a snapshot"; dev-only):
#   bench/gpu/ab.sh <outdir> <rounds> <arm>=<core.wasm>[?<query>]...
# (a `?<query>` after an arm's core adds to the page's query for that arm: e.g. `b160=core.wasm?jitmb=160`).
# Per round, each arm in turn: bench/gpu/firefox-load.ts virgl on Arch Linux ARM's desktop disk with CORE=<core.wasm>
# (served as the page's core: target/ is never written), PHASES=pages by default, TIMELINE_ALL=1 and JITLOG=1, the
# renderer's RSS beside it (bench/boot/results/m8-replay/r2/rss.sh). FROM=<file.webpcsnap> starts every session from
# that snapshot (FROM_SNAPSHOT); other firefox-load variables (PHASES, PAGES, PHASE_S, WARM_S, TIMELINE, QUERY) pass
# through; TAILCAT=rig (or an address) puts the guest online for PHASES=sites (opt-in, benchmarks only). Into <outdir>/<arm>-<round>/: results.json, log.txt, wall.txt, rss.txt, stalls.json (bench/gpu/stalls.ts),
# counts.json (bench/boot/results/m8-replay/counts.ts report), jit.jsonl.gz; the timelines are deleted (KEEP_TIMELINE=1
# keeps them). Then `node bench/gpu/ab-summary.ts <outdir>`. Each session runs under a 10 GiB scope and `timeout`
# (SESSION_S, default 900): run this alone, in the background, nothing else Chromium-heavy beside it.
set -u
cd "$(dirname "$0")/../.."
out=$1 rounds=$2; shift 2
[ -n "${FROM:-}" ] && export FROM_SNAPSHOT=$FROM
# TAILCAT=rig: the guest online through tests/net/tailcat.sh's exit node (run `tests/net/tailcat.sh up` first).
[ "${TAILCAT:-}" = rig ] && { TAILCAT=$(tests/net/tailcat.sh env | sed -n 's/^WEBPC_TAILCAT_ADDR=//p'); export TAILCAT; [ -n "$TAILCAT" ] || { echo "no tailcat rig: tests/net/tailcat.sh up"; exit 1; }; }
cap() { systemd-run --user --scope -q -p MemoryMax="$1" -p MemorySwapMax=0 -- timeout "$2" "${@:3}"; }
for r in $(seq 1 "$rounds"); do
  for arm in "$@"; do
    name=${arm%%=*} core=${arm#*=} aq=
    case $core in *\?*) aq=${core#*\?} core=${core%%\?*} ;; esac
    [ -f "$core" ] || { echo "no core $core"; exit 1; }
    o=$out/$name-$r
    rm -rf "$o"; mkdir -p "$o"
    bash bench/boot/results/m8-replay/r2/rss.sh "$o/rss.txt" "${SESSION_S:-900}" &
    rp=$!
    t0=$(date +%s.%N)
    CORE=$core QUERY=${QUERY:-}${QUERY:+${aq:+&}}$aq PHASES=${PHASES:-pages} TIMELINE_ALL=${TIMELINE_ALL-1} JITLOG=1 WEBPC_GUEST_USER=${WEBPC_GUEST_USER:-alarm} \
      cap 10G "${SESSION_S:-900}" node bench/gpu/firefox-load.ts virgl "${IMAGE:-target/archarm/desktop.qcow2}" "$o" > "$o/log.txt" 2>&1
    code=$?
    t1=$(date +%s.%N)
    kill $rp 2>/dev/null
    echo "$t0 $t1 $code" | awk '{printf "wall %.1f exit %d\n", $2-$1, $3}' > "$o/wall.txt"
    tl=$(ls "$o"/*.timeline.json 2>/dev/null)
    [ -n "$tl" ] && cap 4G 120 node bench/gpu/stalls.ts --json $tl > "$o/stalls.json" 2>/dev/null
    [ -f "$o/jit.jsonl" ] && cap 4G 120 node bench/boot/results/m8-replay/counts.ts report --json "$o/jit.jsonl" > "$o/counts.json" 2>/dev/null && gzip -f "$o/jit.jsonl"
    [ -n "${KEEP_TIMELINE:-}" ] || rm -f $tl
    echo "$name-$r $(cat "$o/wall.txt")"
  done
done
