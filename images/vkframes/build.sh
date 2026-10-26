#!/usr/bin/env bash
# Vulkan programs' frames for checking the renderer's driver (VK2 L3, vk/README.md "Checking frames"): each program in
# PROGRAMS captured natively with GFXReconstruct's layer (tools/vulkan-tools/build-gfxr.sh) on the dev VM's lavapipe
# (under a headless sway, the WSI's CPU path), its chosen frames replayed natively on lavapipe offscreen as the
# references, and GFXReconstruct's replay built for the tests' Debian in rootless Podman (Debian 13 at images/'s
# snapshot date). On demand only: not in images/build.sh, SHA256SUMS or CI. Result:
#   target/vkframes/vkframes.ext4   ext4, label vkframes, mounted at /vkf: bin/gfxrecon-replay and its libraries, run.sh, and
#                                   per program <name>.gfxr and ref/<name>_frame_<n>.bmp; the page's second disk, which
#                                   tests/page-venus.test.ts mounts
#   images/vkframes/build.sh   (~10 min the first time: the replay's compile)
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
W=$ROOT/target/vkframes
G=$ROOT/target/vulkan-tools/gfxreconstruct
LVP=/usr/share/vulkan/icd.d/lvp_icd.aarch64.json
# name | frames to check | the command captured. vkcube with --use_staging: the driver can't sample linear images,
# so the guest's vkcube stages its texture too.
PROGRAMS=(
  "vkcube|5,15,30|vkcube --wsi wayland --use_staging --c 30"
)
mkdir -p "$W"
"$ROOT/tools/vulkan-tools/build-gfxr.sh"

# The replay for Debian, from the host's clone (build-gfxr.sh's, with its submodules), only the replay tool and no
# window systems (the guest replays offscreen).
podman build -q -t localhost/webpc-vkframes "$ROOT/images/vkframes" >/dev/null
podman run --rm -v "$ROOT/target/vulkan-tools/gfxreconstruct-src:/src:ro,Z" -v "$W:/out:Z" localhost/webpc-vkframes sh -euc '
  [ -f /out/build/build.ninja ] || cmake -S /src -B /out/build -G Ninja -DCMAKE_BUILD_TYPE=Release -DBUILD_WERROR=OFF \
    -DGFXRECON_ENABLE_OPENXR=OFF -DGFXRECON_TOCPP_SUPPORT=OFF -DBUILD_WSI_XCB_SUPPORT=OFF -DBUILD_WSI_XLIB_SUPPORT=OFF \
    -DBUILD_WSI_WAYLAND_SUPPORT=OFF -DBUILD_WSI_DISPLAY_SUPPORT=OFF >/dev/null
  # Its generated sources take ~2 GB each to compile: -j3 keeps it under ~7 GB.
  cmake --build /out/build -j 3 --target gfxrecon-replay >/dev/null'

rm -rf "$W/tree"
T=$W/tree/vkf
mkdir -p "$T/bin" "$T/lib" "$T/ref"
cp "$W/build/tools/replay/gfxrecon-replay" "$T/bin/"
cp "$ROOT/images/vkframes/run.sh" "$T/"
for p in "${PROGRAMS[@]}"; do
  IFS='|' read -r name frames cmd <<< "$p"
  # shellcheck disable=SC2086
  VK_DRIVER_FILES=$LVP SWAY_SIZE=640x480 timeout 120 "$ROOT/tools/venus-oracle/wayland.sh" env MESA_VK_WSI_DEBUG=sw \
    GFXRECON_CAPTURE_FILE="$T/$name.gfxr" GFXRECON_CAPTURE_FILE_TIMESTAMP=false GFXRECON_LOG_LEVEL=warning \
    VK_LAYER_PATH="$G/share/vulkan/explicit_layer.d" VK_INSTANCE_LAYERS=VK_LAYER_LUNARG_gfxreconstruct $cmd > "$W/$name.log" 2>&1
  VK_DRIVER_FILES=$LVP timeout 120 "$G/bin/gfxrecon-replay" --swapchain offscreen --screenshots "$frames" \
    --screenshot-dir "$T/ref" --screenshot-prefix "$name" "$T/$name.gfxr" >> "$W/$name.log" 2>&1
  echo "$name $frames" >> "$T/programs"
  ls "$T/ref/${name}"_frame_*.bmp | wc -l | xargs echo "$name: $(du -h "$T/$name.gfxr" | cut -f1) captured, frames:"
done

# The replay's libraries that Debian's base may lack, beside it; then the disk.
podman run --rm -v "$W:/out:Z" localhost/webpc-vkframes sh -euc '
  strip /out/tree/vkf/bin/gfxrecon-replay
  for l in $(ldd /out/tree/vkf/bin/gfxrecon-replay | awk "/lz4|zstd/ { print \$3 }"); do cp -L "$l" /out/tree/vkf/lib/; done
  size=$(du -sm /out/tree | cut -f1)
  truncate -s $(( size * 13 / 10 + 32 ))M /out/vkframes.ext4.new
  mke2fs -q -t ext4 -L vkframes -d /out/tree/vkf /out/vkframes.ext4.new
  mv /out/vkframes.ext4.new /out/vkframes.ext4'
rm -rf "$W/tree"
ls -l "$W/vkframes.ext4"
