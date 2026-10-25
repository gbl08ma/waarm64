#!/usr/bin/env bash
# VK0 on the user's NVIDIA desktop (bench/vulkan/REPORT.md; the kickoff's "The NVIDIA desktop's script"), run by hand
# from a checkout of this repository on x86_64 Linux (CachyOS: clang installed, Chromium with WebGPU):
#
#   bench/vulkan/nvidia.sh [dir]        (default ~/webpc-vk0)
#
# Everything it downloads, builds or writes goes into that one directory, which can be deleted afterwards: LunarG's
# Vulkan SDK for Linux (headers, loader, glslc, GFXReconstruct), a portable Node, Playwright's Chrome for Testing, a
# copy of the benchmark's sources, the WebGL Aquarium's assets, the scene's build and the results. No sudo, no
# packages installed; caches and temporary files are pointed into the directory too. It needs only curl, tar, xz,
# git and clang, which the desktop has.
#
# What it runs:
#   1. the native scene (arm 1) on the system's Vulkan driver: every fish count and the toolkit setting, MSAA 1 and 4;
#   2. the scene captured with GFXReconstruct and converted for arm 3 (its shaders come translated, from
#      bench/vulkan/translate/scene-shaders.json);
#   3. the browser arms: WebGPU by hand (arm 2, three ways of feeding the fish), the translated replay (arm 3) and the
#      WebGPU questions (C, E, F), in the headless Chrome for Testing if it gets the NVIDIA adapter; otherwise it
#      serves the pages and prints the URLs to open in your own Chromium, where each page downloads its results.
# At the end it writes <dir>/vk0-nvidia-results.tar.gz: send that file back.
set -euo pipefail
# A step that fails says so, with its line, instead of ending the script silently.
trap 'echo "nvidia.sh: stopped at line $LINENO (exit $?): $BASH_COMMAND" >&2' ERR
REPO=$(cd "$(dirname "$0")/../.." && pwd)
DIR=$(realpath -m "${1:-$HOME/webpc-vk0}")
SDK_VERSION=1.4.363.0
NODE_VERSION=v26.7.0
PLAYWRIGHT=$(grep -m1 -A3 '"node_modules/playwright-core"' "$REPO/package-lock.json" | sed -n 's/.*"version": "\(.*\)".*/\1/p')
say() { printf '\n== %s\n' "$*"; }

for t in curl tar xz git clang; do command -v "$t" >/dev/null || { echo "missing: $t" >&2; exit 1; }; done
# Test hooks (the dev VM runs the whole script with them): VK0_SDK, an SDK directory to use as it is (bin, lib, include,
# share), VK0_NODE=system to use the Node on the PATH, VK0_ANY_ARCH=1 to skip the x86_64 check, VK0_ADAPTER_MATCH (a
# regex, default nvidia) for the adapter the headless browser must get.
[ "$(uname -m)" = x86_64 ] || [ -n "${VK0_ANY_ARCH:-}" ] || { echo "this script is for x86_64 Linux" >&2; exit 1; }
mkdir -p "$DIR"/{dl,t,cache,results}
# Everything that would land in the home directory or /tmp lands here instead (the temporary directory's name is short:
# Chrome's socket lives in it, and a socket's path is limited to 108 bytes).
export TMPDIR=$DIR/t XDG_CACHE_HOME=$DIR/cache npm_config_cache=$DIR/cache/npm PLAYWRIGHT_BROWSERS_PATH=$DIR/browsers
export __GL_SHADER_DISK_CACHE_PATH=$DIR/cache/nvidia MESA_SHADER_CACHE_DIR=$DIR/cache/mesa
mkdir -p "$__GL_SHADER_DISK_CACHE_PATH"

say "Vulkan SDK $SDK_VERSION"
if [ -n "${VK0_SDK:-}" ]; then
  mkdir -p "$DIR/sdk/$SDK_VERSION" && ln -sfn "$VK0_SDK" "$DIR/sdk/$SDK_VERSION/x86_64"
elif [ ! -d "$DIR/sdk/$SDK_VERSION" ]; then
  curl -fL --progress-bar -o "$DIR/dl/sdk.tar.xz" "https://sdk.lunarg.com/sdk/download/$SDK_VERSION/linux/vulkansdk-linux-x86_64-$SDK_VERSION.tar.xz"
  mkdir -p "$DIR/sdk" && tar -xJf "$DIR/dl/sdk.tar.xz" -C "$DIR/sdk" && rm "$DIR/dl/sdk.tar.xz"
fi
export VULKAN_SDK=$DIR/sdk/$SDK_VERSION/x86_64
[ -x "$VULKAN_SDK/bin/glslc" ] || { echo "the SDK's layout isn't what this script expects ($VULKAN_SDK)" >&2; exit 1; }

say "Node $NODE_VERSION"
if [ "${VK0_NODE:-}" = system ]; then
  mkdir -p "$DIR/node/bin" && ln -sf "$(command -v node)" "$DIR/node/bin/node" && ln -sf "$(command -v npm)" "$DIR/node/bin/npm"
elif [ ! -x "$DIR/node/bin/node" ]; then
  curl -fL --progress-bar -o "$DIR/dl/node.tar.xz" "https://nodejs.org/dist/$NODE_VERSION/node-$NODE_VERSION-linux-x64.tar.xz"
  mkdir -p "$DIR/node" && tar -xJf "$DIR/dl/node.tar.xz" -C "$DIR/node" --strip-components=1 && rm "$DIR/dl/node.tar.xz"
fi
export PATH=$DIR/node/bin:$PATH

say "the benchmark's sources and Playwright $PLAYWRIGHT"
S=$DIR/src
mkdir -p "$S/bench/spike"
rsync -a --delete --exclude results "$REPO/bench/vulkan" "$S/bench/" 2>/dev/null || { rm -rf "$S/bench/vulkan"; cp -r "$REPO/bench/vulkan" "$S/bench/"; }
cp "$REPO/bench/stats.ts" "$S/bench/"
cp "$REPO/bench/spike/page.ts" "$REPO/bench/spike/worker.ts" "$REPO/bench/spike/benchmarks.ts" "$S/bench/spike/"
printf '{"private":true,"type":"module","dependencies":{"playwright-core":"%s"}}\n' "$PLAYWRIGHT" > "$S/package.json"
(cd "$S" && npm install --no-audit --no-fund --loglevel=error >/dev/null)
node "$S/node_modules/playwright-core/cli.js" install chromium >/dev/null
CHROME=$(ls -d "$PLAYWRIGHT_BROWSERS_PATH"/chromium-*/chrome-linux*/chrome 2>/dev/null | sort | tail -1)
[ -x "$CHROME" ] || { echo "no Chrome for Testing under $PLAYWRIGHT_BROWSERS_PATH" >&2; exit 1; }
export CHROMIUM=$CHROME
T=$S/target/vulkan
mkdir -p "$T"

say "the Aquarium's assets (Chrome decodes the textures)"
[ -f "$T/aquarium.pack" ] || node "$S/bench/vulkan/assets.ts" "$T/aquarium.pack"

say "the native scene, built with clang against the SDK"
CC=clang NO_GLES=1 "$S/bench/vulkan/scene/build.sh" "$T/scene" >/dev/null
if command -v wasm-ld >/dev/null || command -v ld.lld >/dev/null; then
  "$S/bench/vulkan/webgpu/build.sh" "$T/scene.wasm" >/dev/null 2>&1 || cp "$S/bench/vulkan/webgpu/scene.wasm" "$T/scene.wasm"
else
  cp "$S/bench/vulkan/webgpu/scene.wasm" "$T/scene.wasm"   # the committed copy: clang here has no wasm linker
fi
export LD_LIBRARY_PATH=$VULKAN_SDK/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}
# Which device the scene picks (its first line; the rest discarded, not cut off: under pipefail a closed pipe fails).
"$T/scene/vk" --pack "$T/aquarium.pack" --shaders "$T/scene/shaders" --fish 1 --warmup 1 --samples 1 --frames 1 > "$DIR/t/device.txt" 2>&1 || true
head -1 "$DIR/t/device.txt"

say "arm 1: the native sweep (a few minutes)"
bash "$S/bench/vulkan/sweep.sh" "$T/scene/vk" "$T/aquarium.pack" "$T/scene/shaders" "$DIR/results/native" nvidia || echo "(some native runs failed: see above; going on)"
"$VULKAN_SDK/bin/vulkaninfo" --summary > "$DIR/results/native/vulkaninfo.txt" 2>&1 || true

say "arm 3's captures (GFXReconstruct on this driver) and their conversion"
C=$T/captures
mkdir -p "$C"
capture() {  # name, then the scene's arguments; succeeds when the trace exists (run as an if's condition, so no set -e)
  local name=$1; shift
  [ -f "$C/$name-trace/stream.bin" ] && return 0
  rm -rf "$C/$name" "$C/$name.gfxr" "$C/$name-trace"
  VK_LAYER_PATH=$VULKAN_SDK/share/vulkan/explicit_layer.d VK_INSTANCE_LAYERS=VK_LAYER_LUNARG_gfxreconstruct \
    GFXRECON_CAPTURE_FILE=$C/$name.gfxr GFXRECON_CAPTURE_FILE_TIMESTAMP=false GFXRECON_LOG_LEVEL=warning \
    "$T/scene/vk" --pack "$T/aquarium.pack" --shaders "$T/scene/shaders" --warmup 0 --samples 1 --frames "${FRAMES:-20}" "$@" >/dev/null 2>&1 &&
  "$VULKAN_SDK/bin/gfxrecon-convert" --format jsonl --include-binaries --output "$C/$name.jsonl" "$C/$name.gfxr" >/dev/null &&
  node "$S/bench/vulkan/translate/convert.ts" "$C/$name.jsonl" "$C/$name-trace" &&
  cp "$S/bench/vulkan/translate/scene-shaders.json" "$C/$name-trace/shaders.json"
  rm -rf "$C/$name" "$C/$name.gfxr" "$C/$name.jsonl"
  [ -f "$C/$name-trace/shaders.json" ]
}
TRACES=
for c in "fish1 20 --fish 1" "fish100 20 --fish 100" "fish1000 20 --fish 1000" "fish10000 10 --fish 10000" "fish30000 6 --fish 30000" \
         "toolkit2000 20 --toolkit 2000" "toolkit8000 20 --toolkit 8000" "fish1000ms 20 --fish 1000 --msaa 4" "toolkit2000ms 20 --toolkit 2000 --msaa 4"; do
  set -- $c
  n=$1 f=$2; shift 2
  if (FRAMES=$f capture "$n" "$@"); then TRACES="$TRACES $n"; else echo "(capturing $n failed: skipped)"; fi
done
TRACES=${TRACES# }

say "which adapter does the headless Chrome for Testing get?"
ARGS=
for a in "--enable-unsafe-webgpu" "--enable-unsafe-webgpu --enable-features=Vulkan --use-angle=vulkan --ignore-gpu-blocklist" \
         "--enable-unsafe-webgpu --enable-features=Vulkan,VulkanFromANGLE,DefaultANGLEVulkan --use-angle=vulkan --use-vulkan --ignore-gpu-blocklist"; do
  probe=$(CHROMIUM_ARGS="$a" timeout 120 node "$S/bench/vulkan/webgpu.ts" --probe 2>/dev/null | tail -1 || true)
  echo "  $a -> ${probe:0:160}"
  if echo "$probe" | grep -qiE "${VK0_ADAPTER_MATCH:-nvidia}"; then ARGS=$a; echo "$probe" > "$DIR/results/adapter.json"; break; fi
done

if [ -n "$ARGS" ]; then
  export CHROMIUM_ARGS=$ARGS
  say "arm 2: WebGPU written by hand (headless)"
  MODES="storage dynamic immediates" node "$S/bench/vulkan/webgpu.ts" "$DIR/results/webgpu" nvidia || echo "(arm 2 failed: going on)"
  say "arm 3: the translated replay (headless)"
  list=; for t in $TRACES; do list="$list vulkan/captures/$t-trace"; done
  TARGET=$S/target node "$S/bench/vulkan/arm3.ts" "$DIR/results/arm3" nvidia $list || echo "(arm 3 failed: going on)"
  say "C, E, F: the WebGPU questions (headless)"
  node "$S/bench/vulkan/micro.ts" "$DIR/results/micro.json" || echo "(C, E, F failed: going on)"
else
  say "the headless Chrome got no NVIDIA adapter: over to your own Chromium"
  PORT=${PORT:-8197}
  echo "Open these three pages in your Chromium, one after the other, and leave each until it says \"done\" (minutes):"
  echo "  http://127.0.0.1:$PORT/bench/vulkan/webgpu/index.html?sweep                          -> downloads vk0-webgpu-results.json"
  echo "  http://127.0.0.1:$PORT/bench/vulkan/translate/index.html?sweep=${TRACES// /,}         -> downloads vk0-translated-results.json"
  echo "  http://127.0.0.1:$PORT/bench/vulkan/micro/index.html?download                         -> downloads vk0-micro-results.json"
  echo "Then move the downloaded files into $DIR/results/ and press Enter here (the server stops)."
  node --input-type=module -e "
    import { serve } from '$S/bench/vulkan/server.ts';
    const s = await serve('$S', '$S/target', $PORT);
    process.stdin.once('data', () => { s.close(); process.exit(0); });
  "
fi

say "results"
( cd "$DIR" && tar -czf vk0-nvidia-results.tar.gz results )
cat <<EOF
Send back: $DIR/vk0-nvidia-results.tar.gz

Everything this script fetched, built and wrote is in $DIR (the SDK, Node, Chrome for Testing, the sources, the assets,
the captures, caches and the results). To remove it all:
  rm -rf $DIR
EOF
