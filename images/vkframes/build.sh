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
LQ=$ROOT/target/vk0a/lq-dl/unz/lite
# name | frames to check | the share of a frame's bytes that may differ from lavapipe's by more than 24 (of 255:
# rasterization and filtering differ at edges; vkQuake's nearest-filtered textures and text the most) | where it runs
# (wayland: a headless sway, the WSI's CPU path; x11: Xvfb) | the command captured. vkcube with --use_staging: the driver can't sample linear images, so the guest's vkcube stages its texture
# too. vkmark's scenes one capture each (fifo: ~30 frames in half a second). vkQuake (LibreQuake's data, VK0 A's) from
# its 200th frame to its 230th, a trimmed capture (GFXRECON_CAPTURE_FRAMES: the replay rebuilds the state at frame
# 200 first), so its replay numbers them from 2 (frame 1 rebuilds the state).
VKMARK="vkmark --winsys wayland --size 640x480 -p fifo -b"
PROGRAMS=(
  "vkcube|5,15,30|0.002|wayland|vkcube --wsi wayland --use_staging --c 30"
  "vkmark-vertex|10,25|0.003|wayland|$VKMARK vertex:device-local=true:duration=0.5"
  "vkmark-vertex-host|10,25|0.003|wayland|$VKMARK vertex:device-local=false:interleave=false:duration=0.5"
  "vkmark-texture|10,25|0.003|wayland|$VKMARK texture:anisotropy=16:duration=0.5"
  "vkmark-texture-nearest|10,25|0.003|wayland|$VKMARK texture:anisotropy=0:texture-filter=nearest:duration=0.5"
  "vkmark-gouraud|10,25|0.003|wayland|$VKMARK shading:shading=gouraud:duration=0.5"
  "vkmark-blinn-phong-inf|10,25|0.003|wayland|$VKMARK shading:shading=blinn-phong-inf:duration=0.5"
  "vkmark-phong|10,25|0.003|wayland|$VKMARK shading:shading=phong:duration=0.5"
  "vkmark-cel|10,25|0.003|wayland|$VKMARK shading:shading=cel:duration=0.5"
  "vkmark-edge|10,25|0.003|wayland|$VKMARK effect2d:kernel=edge:duration=0.5"
  "vkmark-blur|10,25|0.003|wayland|$VKMARK effect2d:kernel=blur:duration=0.5"
  "vkmark-desktop|10,25|0.003|wayland|$VKMARK desktop:duration=0.5"
  "vkmark-cube|10,25|0.003|wayland|$VKMARK cube:duration=0.5"
  "vkmark-clear|10,25|0.003|wayland|$VKMARK clear:duration=0.5"
  "vkquake|5,15,30|0.03|x11|env GFXRECON_CAPTURE_FRAMES=200-230 timeout 20 vkquake -basedir $LQ -width 640 -height 480 -window +map start"
)
mkdir -p "$W"
"$ROOT/tools/vulkan-tools/build-gfxr.sh"
"$ROOT/tools/vulkan-tools/build-profiles.sh"
[ -d "$LQ/id1" ] || { echo "vkframes: LibreQuake's data isn't in $LQ (VK0 A's download)"; exit 1; }

# Each program runs on lavapipe as the renderer's device: the Profiles layer reports venus-profile.json (vulkaninfo
# --json of the Venus device in the tests' guest, on SwiftShader) in place of lavapipe's own features, properties,
# extensions and formats, so a program takes the paths it takes on the device (vkQuake its non-fp16 shaders); the
# capture layer sits above it. Compressed formats lavapipe lacks are left out (a program enabling them would fail
# vkCreateDevice there).
python3 -I - "$ROOT/images/vkframes/venus-profile.json" "$W/profile.json" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
f = d['capabilities']['device']['features']['VkPhysicalDeviceFeatures']
f['textureCompressionETC2'] = False
f['textureCompressionASTC_LDR'] = False
json.dump(d, open(sys.argv[2], 'w'))
PY
PROFILE_NAME=$(python3 -I -c 'import json, sys; print(next(iter(json.load(open(sys.argv[1]))["profiles"])))' "$W/profile.json")
capture() {
  env VK_DRIVER_FILES=$LVP MESA_VK_WSI_DEBUG=sw \
    VK_LAYER_PATH="$G/share/vulkan/explicit_layer.d:$ROOT/target/vulkan-tools/profiles/share/vulkan/explicit_layer.d" \
    VK_INSTANCE_LAYERS=VK_LAYER_LUNARG_gfxreconstruct:VK_LAYER_KHRONOS_profiles \
    VK_KHRONOS_PROFILES_PROFILE_FILE="$W/profile.json" VK_KHRONOS_PROFILES_PROFILE_NAME="$PROFILE_NAME" \
    VK_KHRONOS_PROFILES_SIMULATE_CAPABILITIES=SIMULATE_API_VERSION_BIT,SIMULATE_FEATURES_BIT,SIMULATE_PROPERTIES_BIT,SIMULATE_EXTENSIONS_BIT,SIMULATE_FORMATS_BIT \
    VK_KHRONOS_PROFILES_DEFAULT_FEATURE_VALUES=DEFAULT_FEATURE_VALUES_FALSE VK_KHRONOS_PROFILES_EMULATE_PORTABILITY=false \
    VK_KHRONOS_PROFILES_DEBUG_REPORTS=DEBUG_REPORT_ERROR_BIT \
    GFXRECON_CAPTURE_FILE="$1" GFXRECON_CAPTURE_FILE_TIMESTAMP=false GFXRECON_LOG_LEVEL=warning "${@:2}"
}
# For the runners (wayland.sh, xvfb-run), which take a command: `bash -c "$CAPTURE" - <file> <command...>`.
CAPTURE="$(declare -f capture); $(declare -p LVP G ROOT W PROFILE_NAME); capture \"\$@\""

# The replay for Debian, from the host's clone (build-gfxr.sh's, with its submodules), only the replay tool and no
# window systems (the guest replays offscreen).
podman build -q -t localhost/waarm64-vkframes "$ROOT/images/vkframes" >/dev/null
podman run --rm -v "$ROOT/target/vulkan-tools/gfxreconstruct-src:/src:ro,Z" -v "$W:/out:Z" localhost/waarm64-vkframes sh -euc '
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
  IFS='|' read -r name frames tolerance where cmd <<< "$p"
  rm -f "$T/$name"*.gfxr
  # shellcheck disable=SC2086
  case $where in
    wayland) SWAY_SIZE=640x480 timeout 120 "$ROOT/tools/venus-oracle/wayland.sh" bash -c "$CAPTURE" - "$T/$name.gfxr" $cmd ;;
    x11) timeout 120 xvfb-run -a -s "-screen 0 800x600x24" bash -c "$CAPTURE" - "$T/$name.gfxr" $cmd ;;
  esac > "$W/$name.log" 2>&1 || true
  # A trimmed capture is named for its frames.
  for f in "$T/$name"_frames_*.gfxr; do [ -f "$f" ] && mv "$f" "$T/$name.gfxr"; done
  [ -f "$T/$name.gfxr" ] || { echo "vkframes: $name wasn't captured ($W/$name.log)"; exit 1; }
  VK_DRIVER_FILES=$LVP timeout 120 "$G/bin/gfxrecon-replay" --swapchain offscreen --screenshots "$frames" \
    --screenshot-dir "$T/ref" --screenshot-prefix "$name" "$T/$name.gfxr" >> "$W/$name.log" 2>&1
  echo "$name $frames $tolerance" >> "$T/programs"
  ls "$T/ref/${name}"_frame_*.bmp | wc -l | xargs echo "$name: $(du -h "$T/$name.gfxr" | cut -f1) captured, frames:"
done

# The replay's libraries that Debian's base may lack, beside it; then the disk.
podman run --rm -v "$W:/out:Z" localhost/waarm64-vkframes sh -euc '
  strip /out/tree/vkf/bin/gfxrecon-replay
  for l in $(ldd /out/tree/vkf/bin/gfxrecon-replay | awk "/lz4|zstd/ { print \$3 }"); do cp -L "$l" /out/tree/vkf/lib/; done
  size=$(du -sm /out/tree | cut -f1)
  truncate -s $(( size * 13 / 10 + 32 ))M /out/vkframes.ext4.new
  mke2fs -q -t ext4 -L vkframes -d /out/tree/vkf /out/vkframes.ext4.new
  mv /out/vkframes.ext4.new /out/vkframes.ext4'
rm -rf "$W/tree"
ls -l "$W/vkframes.ext4"
