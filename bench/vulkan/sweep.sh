#!/usr/bin/env bash
# VK0's native sweep (bench/vulkan/REPORT.md "The scene"): the scene at every fish count and the toolkit setting,
# without and with 4x MSAA, one JSON a setting. Plain bash 3 (the Mac's /bin/bash); each run bounded by timeout(1), or
# perl's alarm where there's none (the Mac). The binary is vk or gles (bench/vulkan/scene) with its shaders.
#   sweep.sh <vk or gles binary> <pack> <shaders dir> <out dir> [label]
# FISH, TOOLKIT, MSAA (space-separated lists), WARMUP, SAMPLES, FRAMES and RUN_S (each run's bound) override.
set -u
vk=$1 pack=$2 shaders=$3 out=$4 label=${5:-}
mkdir -p "$out"
FISH=${FISH-"1 100 1000 10000 30000"}
TOOLKIT=${TOOLKIT-"2000 8000"}
MSAA=${MSAA-"1 4"}
WARMUP=${WARMUP:-60} SAMPLES=${SAMPLES:-10} FRAMES=${FRAMES:-60} RUN_S=${RUN_S:-300}
rc=0
if command -v timeout >/dev/null; then bound() { timeout "$@"; }; else bound() { perl -e 'alarm shift; exec @ARGV' "$@"; }; fi
run() {  # name, then the binary's arguments
  local name=$1; shift
  bound "$RUN_S" "$vk" --pack "$pack" --shaders "$shaders" --warmup "$WARMUP" \
    --samples "$SAMPLES" --frames "$FRAMES" --label "$label" --json "$out/$name.json" "$@" 2>&1 | grep -v '^device:\|^renderer:' || rc=1
}
for m in $MSAA; do
  for n in $FISH; do run "fish-$n-msaa$m" --fish "$n" --msaa "$m"; done
  for q in $TOOLKIT; do run "toolkit-$q-msaa$m" --toolkit "$q" --msaa "$m"; done
done
exit $rc
