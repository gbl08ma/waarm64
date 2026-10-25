#!/usr/bin/env bash
# VK0's arm 1 on the Mac host's GPU (bench/vulkan/REPORT.md): the native scene on KosmicKrisp (Mesa's Vulkan on Metal,
# from LunarG's macOS SDK) and, for context, MoltenVK. Nothing is installed on the Mac: the SDK's parts
# (bench/vulkan/macsdk.ts), the scene's sources and the asset pack go to ~/webpc-gpu-bench/vulkan there, the scene is
# built there with the Mac's own clang (Command Line Tools), and the loader is pointed at the driver by VK_DRIVER_FILES.
#   bench/vulkan/mac.sh [kosmickrisp|moltenvk] [name]   -> bench/results/local/vk0/<name>/ (one JSON a setting)
# DUMP=FRAME renders one frame instead (-> <name>.ppm); VALIDATE=1 runs it under the validation layer; SWEEP's
# variables (FISH, TOOLKIT, MSAA, SAMPLES, ...) pass through.
set -euo pipefail
cd "$(dirname "$0")/../.."
HOST=${MAC_HOST:-macmini.lan}
DEST=webpc-gpu-bench/vulkan
DRIVER=${1:-kosmickrisp} NAME=${2:-mac-$DRIVER}
[ -f target/vulkan/macsdk/lib/libvulkan_kosmickrisp.dylib ] || node --disable-warning=ExperimentalWarning bench/vulkan/macsdk.ts
[ -f target/vulkan/aquarium.pack ] || node --disable-warning=ExperimentalWarning bench/vulkan/assets.ts
ssh "$HOST" "mkdir -p $DEST/results"
rsync -a --delete target/vulkan/macsdk/ "$HOST:$DEST/sdk/"
rsync -a --delete bench/vulkan/scene/ "$HOST:$DEST/scene/"
rsync -a bench/vulkan/sweep.sh target/vulkan/aquarium.pack "$HOST:$DEST/"
case $DRIVER in
  kosmickrisp) icd=libkosmickrisp_icd.json ;;
  moltenvk) icd=MoltenVK_icd.json ;;
  *) echo "unknown driver $DRIVER" >&2; exit 2 ;;
esac
env="cd $DEST && export VULKAN_SDK=\$PWD/sdk VK_DRIVER_FILES=\$PWD/sdk/share/vulkan/icd.d/$icd VK_LAYER_PATH=\$PWD/sdk/share/vulkan/explicit_layer.d"
[ -n "${VALIDATE:-}" ] && env="$env VK_INSTANCE_LAYERS=VK_LAYER_KHRONOS_validation"
ssh "$HOST" "$env && CC=clang scene/build.sh build >/dev/null"
mkdir -p bench/results/local/vk0
if [ -n "${DUMP:-}" ]; then
  ssh "$HOST" "$env && perl -e 'alarm shift; exec @ARGV' 300 build/vk --pack aquarium.pack --shaders build/shaders ${ARGS:-} --dump $DUMP:results/$NAME.ppm"
  rsync -a "$HOST:$DEST/results/$NAME.ppm" bench/results/local/vk0/
  exit 0
fi
pass="FISH='${FISH:-}' TOOLKIT='${TOOLKIT:-}' MSAA='${MSAA:-}' WARMUP=${WARMUP:-} SAMPLES=${SAMPLES:-} FRAMES=${FRAMES:-}"
ssh "$HOST" "$env && for v in FISH TOOLKIT MSAA WARMUP SAMPLES FRAMES; do :; done; $pass; [ -n \"\$FISH\" ] || unset FISH; [ -n \"\$TOOLKIT\" ] || unset TOOLKIT; [ -n \"\$MSAA\" ] || unset MSAA; [ -n \"\$WARMUP\" ] || unset WARMUP; [ -n \"\$SAMPLES\" ] || unset SAMPLES; [ -n \"\$FRAMES\" ] || unset FRAMES; export FISH TOOLKIT MSAA WARMUP SAMPLES FRAMES 2>/dev/null; rm -rf results/$NAME && bash sweep.sh build/vk aquarium.pack build/shaders results/$NAME $NAME; sw_vers -productVersion > results/$NAME/macos.txt; system_profiler SPDisplaysDataType | grep -E 'Chipset|Metal|Cores' > results/$NAME/gpu.txt"
rsync -a "$HOST:$DEST/results/$NAME" bench/results/local/vk0/
