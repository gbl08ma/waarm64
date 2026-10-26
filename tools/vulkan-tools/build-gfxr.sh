#!/usr/bin/env bash
# GFXReconstruct (LunarG, MIT; docs/plans/graphics.md §5 S arm 3, B, D): the Vulkan capture layer and its tools,
# at the Vulkan SDK 1.4.363.0 tag (the system's Vulkan), built natively into target/vulkan-tools/gfxreconstruct/.
# Dev-only. Needs cmake, ninja, liblz4-devel, libzstd-devel, the X11/xcb/wayland -devel packages (docs/devenv.md).
# Idempotent: a built tree is reused.
#   tools/vulkan-tools/build-gfxr.sh
# Then: target/vulkan-tools/gfxreconstruct/bin/{gfxrecon-capture-vulkan.py,gfxrecon-convert,gfxrecon-info,
# gfxrecon-replay,...}; the layer's manifest in .../share/vulkan/explicit_layer.d (VK_LAYER_PATH points there).
# Capturing frames of a program without a swapchain (the scene): tools/vulkan-tools/gfxr-capture.sh.
set -euo pipefail
TAG=vulkan-sdk-1.4.363.0   # commit 4401228c791b11fb7ea15b93795cbd1e938307c0
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
W=$ROOT/target/vulkan-tools
P=$W/gfxreconstruct
mkdir -p "$W"
if [ ! -d "$W/gfxreconstruct-src" ]; then
  git clone -q --depth 1 --branch "$TAG" --recurse-submodules --shallow-submodules \
    https://github.com/LunarG/gfxreconstruct.git "$W/gfxreconstruct-src"
fi
if [ ! -f "$W/build-gfxr/build.ninja" ]; then
  cmake -S "$W/gfxreconstruct-src" -B "$W/build-gfxr" -G Ninja -DCMAKE_BUILD_TYPE=Release \
    -DCMAKE_INSTALL_PREFIX="$P" -DBUILD_WERROR=OFF -DGFXRECON_ENABLE_OPENXR=OFF -DGFXRECON_TOCPP_SUPPORT=OFF \
    >/dev/null
fi
# Its generated sources take ~2 GB each to compile: -j3 keeps it under ~7 GB.
cmake --build "$W/build-gfxr" -j "${JOBS:-3}" >/dev/null
cmake --install "$W/build-gfxr" >/dev/null
# The manifest names the library bare (found on the loader's search path): point it at ours.
sed -i "s|\"library_path\": \"libVkLayer_gfxreconstruct.so\"|\"library_path\": \"$P/lib64/libVkLayer_gfxreconstruct.so\"|" \
  "$P/share/vulkan/explicit_layer.d/VkLayer_gfxreconstruct.json"
ls "$P"/bin/gfxrecon-convert "$P"/bin/gfxrecon-info "$P"/bin/gfxrecon-replay "$P"/lib64/libVkLayer_gfxreconstruct.so
grep -q "$P/lib64" "$P/share/vulkan/explicit_layer.d/VkLayer_gfxreconstruct.json"
echo "VK_LAYER_PATH=$P/share/vulkan/explicit_layer.d"
