#!/usr/bin/env bash
# The virgl oracle (docs/graphics.md "Tools"): virglrenderer at a pinned commit, built natively in debug mode (so
# VREND_DEBUG=shader prints the GLSL it makes) with capture.patch, which writes every submit, resource creation,
# transfer and capset to the file named by VTEST_DUMP. Dev VM only (needs meson, ninja, libepoxy-devel,
# libdrm-devel, libgbm-devel: CLAUDE.md). Result: target/virgl-oracle/build/vtest/virgl_test_server.
#   tools/virgl-oracle/build.sh
set -euo pipefail
COMMIT=c8e3fc3bd2f367d92fb1027061fe51afeec5136e
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
W=$ROOT/target/virgl-oracle
mkdir -p "$W"
if [ ! -d "$W/src" ]; then
  git clone -q https://gitlab.freedesktop.org/virgl/virglrenderer.git "$W/src"
fi
git -C "$W/src" checkout -q --force "$COMMIT"
git -C "$W/src" apply "$ROOT/tools/virgl-oracle/capture.patch"
[ -d "$W/build" ] || meson setup "$W/build" "$W/src" -Dbuildtype=debug -Dtests=false -Dvenus=false -Dminigbm_allocation=false >/dev/null
ninja -C "$W/build" >/dev/null
echo "$W/build/vtest/virgl_test_server"
