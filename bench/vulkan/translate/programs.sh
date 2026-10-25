#!/usr/bin/env bash
# Question D's coverage over A's programs (bench/vulkan/REPORT.md "D"): each program runs on the dev VM's lavapipe
# with Mesa's MESA_SPIRV_DUMP_PATH (every SPIR-V stage it hands spirv_to_nir, one file each), then coverage.ts takes
# the dumps through naga alone and through arm 3's chain.
#   bench/vulkan/translate/programs.sh [out dir] [program...]     (default: bench/vulkan/results/d, every program)
# Programs: vkcube, vkmark, gtk4 (gtk4-demo's fishbowl, GSK on Vulkan), mpv (libplacebo, from target/vk0a/root),
# vkquake (LibreQuake's data in target/vk0a/lq-dl), the scene. Wayland ones beside a headless sway
# (tools/venus-oracle/wayland.sh), vkQuake under Xvfb. Each runs through A's Mac profile (PROFILE, default mac:
# bench/vulkan/profiles/run.sh; none for lavapipe as it is), so a program compiles the shaders it would on our device
# (libplacebo also needs the device to say GPU). SPIRV_DIR=<dir> keeps the dumps there (<dir>/<program>/*.spv: VK1's
# bench/vulkan/nir/ reads them), else they go to a temporary directory.
set -uo pipefail
ROOT=$(cd "$(dirname "$0")/../../.." && pwd)
OUT=$(realpath -m "${1:-$ROOT/bench/vulkan/results/d}"); shift || true
PROGRAMS=${*:-vkcube vkmark gtk4 mpv vkquake scene}
W="$ROOT/tools/venus-oracle/wayland.sh env PROFILE=${PROFILE:-mac} $ROOT/bench/vulkan/profiles/run.sh"
R=$ROOT/target/vk0a/root
mkdir -p "$OUT"
if [ -n "${SPIRV_DIR:-}" ]; then
  dumps=$(realpath -m "$SPIRV_DIR"); mkdir -p "$dumps"
else
  dumps=$(mktemp -d "${TMPDIR:-/tmp}/vk0-spv.XXXXXX")
  trap 'rm -rf "$dumps"' EXIT
fi
for p in $PROGRAMS; do
  d=$dumps/$p; rm -rf "$d"; mkdir -p "$d"
  export MESA_SPIRV_DUMP_PATH=$d
  case $p in
    vkcube) timeout 60 $W vkcube --wsi wayland --c 30 ;;
    vkmark) timeout 300 $W vkmark --winsys wayland --size 640x360 ;;
    # GTK4 aborts on the profile (A: it asserts YCbCr), so it runs on lavapipe as it is.
    gtk4) timeout 60 "$ROOT/tools/venus-oracle/wayland.sh" env GSK_RENDERER=vulkan timeout 15 gtk4-demo --run=fishbowl ;;
    mpv) timeout 60 $W env LD_LIBRARY_PATH="$R/usr/lib64" "$R/usr/bin/mpv" --no-config --vo=gpu-next --gpu-api=vulkan \
           --gpu-context=waylandvk --frames=30 --ao=null "$ROOT/target/vk0a/clip.mp4" ;;
    vkquake) B=$ROOT/target/vk0a/lq-dl/unz/lite
             timeout 60 xvfb-run -a -s "-screen 0 800x600x24" env PROFILE=${PROFILE:-mac} "$ROOT/bench/vulkan/profiles/run.sh" timeout 15 vkquake -basedir "$B" -width 640 -height 480 \
               -window +map start ;;
    scene) PROFILE=${PROFILE:-mac} "$ROOT/bench/vulkan/profiles/run.sh" "$ROOT/target/vulkan/scene/vk" --pack "$ROOT/target/vulkan/aquarium.pack" \
             --shaders "$ROOT/target/vulkan/scene/shaders" --fish 1000 --warmup 1 --samples 1 --frames 2 ;;
    *) echo "unknown program $p" >&2; continue ;;
  esac > "$dumps/$p.log" 2>&1
  echo "$p: exit $?, $(ls "$d" | wc -l) stages dumped"
  [ -n "$(ls "$d")" ] || tail -5 "$dumps/$p.log"
  # Mesa names them <hash>.<stage>; coverage.ts takes .spv files.
  for f in "$d"/*; do [ -f "$f" ] && mv "$f" "$f.spv"; done
  node "$ROOT/bench/vulkan/translate/coverage.ts" "$p" "$d" "$OUT/$p.json"
done
