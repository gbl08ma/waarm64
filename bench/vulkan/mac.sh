#!/usr/bin/env bash
# VK0's arm 1 on the Mac host's GPU (bench/vulkan/REPORT.md): the native scene on KosmicKrisp (Mesa's Vulkan on Metal,
# from LunarG's macOS SDK) and, for context, MoltenVK. Nothing is installed on the Mac: the SDK's parts
# (bench/vulkan/macsdk.ts), the scene's sources and the asset pack go to ~/webpc-gpu-bench/vulkan there, the scene is
# built there with the Mac's own clang (Command Line Tools), and the loader is pointed at the driver by VK_DRIVER_FILES.
#   bench/vulkan/mac.sh [kosmickrisp|moltenvk] [name]   -> bench/results/local/vk0/<name>/ (one JSON a setting)
#   bench/vulkan/mac.sh webgpu [name]                     arm 2: bench/vulkan/webgpu.ts in the Mac's headless Chrome for
#                                                         Testing (Playwright's, with the packages bench/mac-packages.sh
#                                                         keeps in ~/webpc-gpu-bench); MODES and the rest pass through
#   bench/vulkan/mac.sh micro [name]                      C, E, F: bench/vulkan/micro.ts (ONLY= one benchmark)
#   bench/vulkan/mac.sh nir [name]                        VK1 step 1: bench/vulkan/nir/run.ts (Node, Chromium; WASM=, ARMS=)
#   bench/vulkan/mac.sh arm3 [name]                       arm 3: bench/vulkan/arm3.ts over the converted captures
#                                                         (bench/vulkan/translate/capture.sh; TRACES picks them)
# DUMP=FRAME renders one frame instead (-> <name>.ppm); VALIDATE=1 runs it under the validation layer; SWEEP's
# variables (FISH, TOOLKIT, MSAA, SAMPLES, ...) pass through.
set -euo pipefail
cd "$(dirname "$0")/../.."
HOST=${MAC_HOST:-macmini.lan}
DEST=webpc-gpu-bench/vulkan
DRIVER=${1:-kosmickrisp} NAME=${2:-mac-$DRIVER}
if [ "$DRIVER" = micro ]; then
  W=webpc-gpu-bench/vulkan-web
  ssh "$HOST" "mkdir -p $W/bench/spike"
  rsync -a --delete --exclude results bench/vulkan "$HOST:$W/bench/"
  rsync -a bench/stats.ts "$HOST:$W/bench/" && rsync -a bench/spike/page.ts bench/spike/worker.ts bench/spike/benchmarks.ts "$HOST:$W/bench/spike/"
  . bench/mac-packages.sh && mac_packages "$HOST" webpc-gpu-bench
  ssh "$HOST" "cd $W && export PATH=/opt/homebrew/bin:\$PATH && \
    export CHROMIUM=\"\$(ls -d \$HOME/Library/Caches/ms-playwright/chromium-*/chrome-mac-arm64/*.app | sort | tail -1)/Contents/MacOS/Google Chrome for Testing\" && \
    mkdir -p results && perl -e 'alarm shift; exec @ARGV' ${MAC_TIMEOUT:-580} node --disable-warning=ExperimentalWarning bench/vulkan/micro.ts results/$NAME.json ${ONLY:+--only $ONLY}"
  mkdir -p bench/results/local/vk0
  rsync -a "$HOST:$W/results/$NAME.json" bench/results/local/vk0/
  exit 0
fi
if [ "$DRIVER" = nir ]; then
  # VK1 step 1: bench/vulkan/nir/run.ts's Node and Chromium arms over the stages (target/vk1/spirv) and the wasm
  # build(s) (WASM: target/vk1/<toolchain>/spike.wasm, default the wasi one) -> bench/results/local/vk1/<name>.json
  W=webpc-gpu-bench/vulkan-web
  WASM=${WASM:-target/vk1/wasi/spike.wasm}
  ssh "$HOST" "mkdir -p $W/bench $W/target/vk1 $W/$(dirname "$WASM")"
  rsync -a --delete --exclude results bench/vulkan "$HOST:$W/bench/"
  rsync -a --delete --exclude '*.log' target/vk1/spirv "$HOST:$W/target/vk1/"
  rsync -a "$WASM" "$HOST:$W/$WASM"
  . bench/mac-packages.sh && mac_packages "$HOST" webpc-gpu-bench
  ssh "$HOST" "cd $W && export PATH=/opt/homebrew/bin:\$PATH && \
    export CHROMIUM=\"\$(ls -d \$HOME/Library/Caches/ms-playwright/chromium-*/chrome-mac-arm64/*.app | sort | tail -1)/Contents/MacOS/Google Chrome for Testing\" && \
    mkdir -p results && perl -e 'alarm shift; exec @ARGV' ${MAC_TIMEOUT:-580} node --disable-warning=ExperimentalWarning bench/vulkan/nir/run.ts \
      results/$NAME.json --arm ${ARMS:-node,chromium} --reps ${REPS:-5} --wasm $WASM"
  mkdir -p bench/results/local/vk1
  rsync -a "$HOST:$W/results/$NAME.json" bench/results/local/vk1/
  exit 0
fi
if [ "$DRIVER" = arm3 ]; then
  W=webpc-gpu-bench/vulkan-web
  TRACES=${TRACES:-fish1 fish100 fish1000 fish10000 fish30000 toolkit2000 toolkit8000}
  ssh "$HOST" "mkdir -p $W/bench $W/target/vulkan/captures"
  rsync -a --delete --exclude results bench/vulkan "$HOST:$W/bench/"
  for t in $TRACES; do rsync -a --delete "target/vulkan/captures/$t-trace" "$HOST:$W/target/vulkan/captures/"; done
  . bench/mac-packages.sh && mac_packages "$HOST" webpc-gpu-bench
  list=; for t in $TRACES; do list="$list vulkan/captures/$t-trace"; done
  ssh "$HOST" "cd $W && export PATH=/opt/homebrew/bin:\$PATH && \
    export CHROMIUM=\"\$(ls -d \$HOME/Library/Caches/ms-playwright/chromium-*/chrome-mac-arm64/*.app | sort | tail -1)/Contents/MacOS/Google Chrome for Testing\" && \
    rm -rf results/$NAME && WARMUP=${WARMUP:-60} SAMPLES=${SAMPLES:-10} FRAMES=${FRAMES:-60} NO_IMMEDIATES=${NO_IMMEDIATES:-} \
    perl -e 'alarm shift; exec @ARGV' ${MAC_TIMEOUT:-580} node --disable-warning=ExperimentalWarning bench/vulkan/arm3.ts results/$NAME $NAME $list; \
    sw_vers -productVersion > results/$NAME/macos.txt"
  mkdir -p bench/results/local/vk0
  rsync -a "$HOST:$W/results/$NAME" bench/results/local/vk0/
  exit 0
fi
if [ "$DRIVER" = webgpu ]; then
  W=webpc-gpu-bench/vulkan-web
  [ -f target/vulkan/scene.wasm ] || bench/vulkan/webgpu/build.sh
  ssh "$HOST" "mkdir -p $W/bench $W/target/vulkan"
  rsync -a --delete --exclude results bench/vulkan "$HOST:$W/bench/"
  rsync -a target/vulkan/aquarium.pack target/vulkan/scene.wasm "$HOST:$W/target/vulkan/"
  . bench/mac-packages.sh && mac_packages "$HOST" webpc-gpu-bench
  ssh "$HOST" "cd $W && export PATH=/opt/homebrew/bin:\$PATH && \
    export CHROMIUM=\"\$(ls -d \$HOME/Library/Caches/ms-playwright/chromium-*/chrome-mac-arm64/*.app | sort | tail -1)/Contents/MacOS/Google Chrome for Testing\" && \
    rm -rf results/$NAME && FISH='${FISH-1 100 1000 10000 30000}' TOOLKIT='${TOOLKIT-2000 8000}' MSAA='${MSAA-1 4}' MODES='${MODES:-storage}' \
    WARMUP=${WARMUP:-60} SAMPLES=${SAMPLES:-10} FRAMES=${FRAMES:-60} GPU_FRAMES=${GPU_FRAMES:-20} \
    perl -e 'alarm shift; exec @ARGV' ${MAC_TIMEOUT:-580} node --disable-warning=ExperimentalWarning bench/vulkan/webgpu.ts results/$NAME $NAME; \
    sw_vers -productVersion > results/$NAME/macos.txt"
  mkdir -p bench/results/local/vk0
  rsync -a "$HOST:$W/results/$NAME" bench/results/local/vk0/
  exit 0
fi
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
