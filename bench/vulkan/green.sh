#!/usr/bin/env bash
# VK3 L4b's harness for the M4's green VA-API chroma (VK3-HANDOVER.md "The green: investigation log"): fresh sessions
# of bench/vulkan/mpv-frames.ts on the Mac (bench/gpu/sway-mac.sh), each one arm's page knobs and mpv options, arms
# alternated (the next session is the arm with the fewest sessions in the results file, ties in ARMS' order), each
# classified by bench/vulkan/green.ts (green / right / odd / error, from mpv's screenshot and the page's screen, VA-API
# against software decoding) and appended to the results file as a JSON line. Resumable: run it again with the same
# file and it carries on. It starts a session only while BUDGET seconds (default 540) leave room for one (~200 s), so
# one call stays under the Bash tool's cap; nothing is added to the GPU worker beyond L4's bare sessions (the page's
# screen is read once mpv's screenshot exists).
#   ARMS='bare:|held:vkformats=held' N='15 8' bench/vulkan/green.sh <results.jsonl> [budget s]
# An arm is `name:knobs[ mpv options]`: knobs go to the page's `?gpu=virgl,vulkan,<knobs>` (empty: as the page has
# it), the options to both mpv runs (VA-API first, the session's first mpv on Vulkan, then software decoding), e.g.
# `bicubic: --cscale=bicubic`. Two knobs are the harness's own (not the page's): `swfirst` runs software
# decoding first (VA-API's mpv then isn't the session's first on Vulkan), `twice` runs VA-API again after software
# decoding (vkva2: classified too). GUEST_ENV and the rest of mpv-frames.ts's settings pass through. N: sessions per arm, one number or one per arm (default 12). Sessions'
# logs and results: bench/results/local/green-<arm>-<time>/ (and .log, .driver.log).
set -euo pipefail
cd "$(dirname "$0")/../.."
OUT=$1 BUDGET=${2:-540}
IFS='|' read -ra SPECS <<< "${ARMS:?ARMS='name:knobs[ mpv options]|…'}"
read -ra NS <<< "${N:-12}"
mkdir -p "$(dirname "$OUT")" bench/results/local && touch "$OUT"
# The commit, and whether the tree differs from it outside results (a session's line says so).
COMMIT=$(git rev-parse --short HEAD)
[ -z "$(git status --porcelain -- . ':!bench/vulkan/results' ':!bench/results')" ] || COMMIT="$COMMIT+dirty"
START=$(date +%s)
while :; do
  best=-1 bestn=0
  for i in "${!SPECS[@]}"; do
    name=${SPECS[$i]%%:*}
    n=$(grep -c "\"arm\":\"$name\"" "$OUT" || true)
    want=${NS[$i]:-${NS[-1]}}
    if [ "$n" -lt "$want" ] && { [ $best -lt 0 ] || [ "$n" -lt $bestn ]; }; then best=$i bestn=$n; fi
  done
  [ $best -ge 0 ] || { echo "every arm has its sessions"; exit 0; }
  left=$((BUDGET - ($(date +%s) - START)))
  [ $left -ge 200 ] || { echo "budget spent: run again to go on"; exit 0; }
  spec=${SPECS[$best]} name=${SPECS[$best]%%:*}
  rest=${spec#*:} knobs=${rest%% *} extra=
  [[ "$rest" == *" "* ]] && extra=${rest#* }
  va="vkva=--hwdec=vaapi --vo=gpu-next --gpu-api=vulkan $extra" no="vkno=--hwdec=no --vo=gpu-next --gpu-api=vulkan $extra"
  mpv_arms="$va|$no" pairs='vkva~vkno' page=
  for k in ${knobs//,/ }; do
    case $k in
      swfirst) mpv_arms="$no|$va" ;;
      twice) mpv_arms="$va|$no|vkva2=${va#vkva=}" pairs='vkva~vkno vkva2~vkno' ;;
      *) page=${page:+$page,}$k ;;
    esac
  done
  sname=green-$name-$(date +%m%d-%H%M%S)
  echo "$(date +%T) $sname (${name}: knobs '$knobs', mpv '$extra'; session $((bestn + 1)))"
  t0=$(date +%s)
  rc=0
  MAC_TIMEOUT=$((left - 30)) SCRIPT=../vulkan/mpv-frames.ts GPU_KNOBS="$page" GRAB=1 PAIRS="$pairs" MPV_ARMS="$mpv_arms" \
    timeout $((left - 5)) bench/gpu/sway-mac.sh - target/arch/desktop.qcow2 "$sname" > "bench/results/local/$sname.driver.log" 2>&1 || rc=$?
  systemd-run --user --scope -q -p MemoryMax=1G -p MemorySwapMax=0 -- timeout 30 node bench/vulkan/green.ts "bench/results/local/$sname" "$OUT" \
    "$name" "$knobs" "$extra" "$COMMIT" $(( $(date +%s) - t0 )) $rc
done
