#!/usr/bin/env bash
# The Venus oracle (docs/plans/graphics.md §2, §5): virglrenderer with Venus (vtest server and render server) and
# Mesa's Venus driver (the virtio Vulkan ICD), both at pinned versions, built natively into target/venus-oracle/.
# A Vulkan client on Mesa's Venus talks vtest to `virgl_test_server --venus`, whose render server runs the commands
# on the host's Vulkan (lavapipe in the dev VM). tools/venus-oracle/run.sh runs a client through it.
# Dev VM only: needs meson, ninja, cmake, python313-Mako, python313-PyYAML, python313-packaging, bison, flex,
# glslang-devel, libdrm-devel, libxshmfence-devel, vulkan-devel, libepoxy-devel, libgbm-devel (CLAUDE.md).
# Running it needs /dev/udmabuf open to the user (run.sh says how). Idempotent: a built tree is reused.
#   tools/venus-oracle/build.sh   -> target/venus-oracle/install/{bin,libexec,lib64,share}
# Two variants, each in its own source/build/install dirs so the plain oracle stays as it is:
#   --capture  virglrenderer with capture.patch (VK0 B: VENUS_DUMP=<file> writes what vkr decodes per queue submit;
#              dump.ts reads it), from a git worktree -> target/venus-oracle/install-capture (run.sh: VENUS_DUMP)
#   --wsi      Mesa's Venus driver with the Wayland platform, for clients that present (vkcube, GTK4)
#              -> target/venus-oracle/install-wsi (run.sh: VENUS_WSI=1); needs wayland-protocols-devel
set -euo pipefail
CAPTURE=0 WSI=0
for a in "$@"; do
  case $a in
    --capture) CAPTURE=1 ;;
    --wsi) WSI=1 ;;
    *) echo "usage: $0 [--capture] [--wsi]" >&2; exit 2 ;;
  esac
done
VIRGL_COMMIT=e0a1caf3b147bb26dfe524dbb85ded1177e7e49e   # virglrenderer main, 2026-10-21 (MIT)
MESA_TAG=mesa-26.2.4                                     # the system's Mesa (lavapipe is 26.2.3) (MIT)
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
W=$ROOT/target/venus-oracle
P=$W/install
mkdir -p "$W"

if [ ! -d "$W/virglrenderer" ]; then
  git clone -q https://gitlab.freedesktop.org/virgl/virglrenderer.git "$W/virglrenderer"
fi
git -C "$W/virglrenderer" checkout -q --force "$VIRGL_COMMIT"
if [ ! -d "$W/build-virgl" ]; then
  meson setup "$W/build-virgl" "$W/virglrenderer" --prefix="$P" --libdir=lib64 -Dbuildtype=debugoptimized \
    -Dvenus=true -Dtests=false >/dev/null
fi
ninja -C "$W/build-virgl" install >/dev/null

if [ ! -d "$W/mesa" ]; then
  git clone -q --depth 1 --branch "$MESA_TAG" https://gitlab.freedesktop.org/mesa/mesa.git "$W/mesa"
fi
if [ ! -d "$W/build-mesa" ]; then
  # Only the virtio Vulkan driver: no GL, no window-system platforms (the oracle renders offscreen).
  meson setup "$W/build-mesa" "$W/mesa" --prefix="$P" --libdir=lib64 -Dbuildtype=debugoptimized \
    -Dvulkan-drivers=virtio -Dgallium-drivers= -Dplatforms= -Dglx=disabled -Degl=disabled -Dgbm=disabled \
    -Dopengl=false -Dgles1=disabled -Dgles2=disabled -Dllvm=disabled -Dvideo-codecs= -Dvulkan-layers= \
    -Dtools= -Dbuild-tests=false >/dev/null
fi
ninja -C "$W/build-mesa" install >/dev/null
if [ "$CAPTURE" = 1 ]; then
  C=$W/virglrenderer-capture
  [ -d "$C" ] || git -C "$W/virglrenderer" worktree add -q --detach "$C" "$VIRGL_COMMIT"
  git -C "$C" checkout -q --force "$VIRGL_COMMIT"
  git -C "$C" clean -fdq
  git -C "$C" apply "$ROOT/tools/venus-oracle/capture.patch"
  if [ ! -d "$W/build-virgl-capture" ]; then
    meson setup "$W/build-virgl-capture" "$C" --prefix="$W/install-capture" --libdir=lib64 \
      -Dbuildtype=debugoptimized -Dvenus=true -Dtests=false >/dev/null
  fi
  ninja -C "$W/build-virgl-capture" install >/dev/null
  ls "$W/install-capture/bin/virgl_test_server" "$W/install-capture/libexec/virgl_render_server"
fi
if [ "$WSI" = 1 ]; then
  if [ ! -d "$W/build-mesa-wsi" ]; then
    meson setup "$W/build-mesa-wsi" "$W/mesa" --prefix="$W/install-wsi" --libdir=lib64 -Dbuildtype=debugoptimized \
      -Dvulkan-drivers=virtio -Dgallium-drivers= -Dplatforms=wayland -Dglx=disabled -Degl=disabled -Dgbm=disabled \
      -Dopengl=false -Dgles1=disabled -Dgles2=disabled -Dllvm=disabled -Dvideo-codecs= -Dvulkan-layers= \
      -Dtools= -Dbuild-tests=false >/dev/null
  fi
  ninja -C "$W/build-mesa-wsi" install >/dev/null
  ls "$W"/install-wsi/share/vulkan/icd.d/virtio_icd.*.json
fi
ls "$P"/bin/virgl_test_server "$P"/libexec/virgl_render_server "$P"/share/vulkan/icd.d/virtio_icd.*.json
