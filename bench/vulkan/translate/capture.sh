#!/usr/bin/env bash
# Arm 3's traces (bench/vulkan/REPORT.md): the native scene on lavapipe captured whole with GFXReconstruct
# (tools/vulkan-tools/gfxr-capture.sh, its binaries included), converted to a command stream (convert.ts) and its shaders
# translated (shaders.ts).
#   bench/vulkan/translate/capture.sh <name> [vk's scene arguments...]   -> target/vulkan/captures/<name>-trace/
# FRAMES (default 20) frames are captured; the replay loops them.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../../.." && pwd)
name=$1; shift
C=$ROOT/target/vulkan/captures T=$ROOT/target/vulkan/scene
mkdir -p "$C"
rm -rf "$C/$name" "$C/$name.gfxr" "$C/$name.jsonl" "$C/$name-trace"
GFXR_CONVERT_ARGS=--include-binaries VK_DRIVER_FILES=${VK_DRIVER_FILES:-/usr/share/vulkan/icd.d/lvp_icd.aarch64.json} \
  "$ROOT/tools/vulkan-tools/gfxr-capture.sh" "$C/$name.gfxr" all "$T/vk" --pack "$ROOT/target/vulkan/aquarium.pack" --shaders "$T/shaders" \
  --warmup 0 --samples 1 --frames "${FRAMES:-20}" "$@" 2>&1 | grep -v 'gfxrecon\] INFO'
node --disable-warning=ExperimentalWarning "$ROOT/bench/vulkan/translate/convert.ts" "$C/$name.jsonl" "$C/$name-trace"
node --disable-warning=ExperimentalWarning "$ROOT/bench/vulkan/translate/shaders.ts" "$C/$name-trace"
rm -rf "$C/$name" "$C/$name.gfxr" "$C/$name.jsonl"
