#!/usr/bin/env bash
# Builds VK0's native scene (bench/vulkan/REPORT.md): the shaders to SPIR-V with glslc and vk.c with the system's C
# compiler against the Vulkan headers and loader it finds (VULKAN_SDK's when set: the macOS SDK unpacked by
# bench/vulkan/mac.sh, the Linux SDK of the NVIDIA desktop's script); on Linux also the GLES port (gles.c; NO_GLES=1
# skips it), its shaders made by gles-shaders.ts where Node is (the guest's build gets them made).
#   bench/vulkan/scene/build.sh [out-dir]     -> target/vulkan/scene/ (vk, shaders/*.spv, gles, gles-shaders/)
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
out=${1:-$here/../../../target/vulkan/scene}
mkdir -p "$out/shaders"
GLSLC=${GLSLC:-glslc}
[ -n "${VULKAN_SDK:-}" ] && [ -x "$VULKAN_SDK/bin/glslc" ] && GLSLC=$VULKAN_SDK/bin/glslc
for s in "$here"/shaders/*.vert "$here"/shaders/*.frag; do
  n=$(basename "$s")
  "$GLSLC" --target-env=vulkan1.1 -O -I "$here/shaders" -o "$out/shaders/$n.spv" "$s"
done
CC=${CC:-cc}
flags=(-O2 -std=c11 -D_POSIX_C_SOURCE=200809L -Wall -Wextra -Wno-unused-function -Wno-missing-field-initializers)
if [ -n "${VULKAN_SDK:-}" ]; then
  flags+=(-I "$VULKAN_SDK/include" -L "$VULKAN_SDK/lib" -Wl,-rpath,"$VULKAN_SDK/lib")
fi
"$CC" "${flags[@]}" -o "$out/vk" "$here/vk.c" "$here/sim.c" -lvulkan -lm
echo "built $out/vk"
# The GLES port (arm 4's virgl side) where EGL and GLES 3 are (Linux): its shaders generated from the same sources.
if [ "$(uname)" = Linux ] && [ -z "${NO_GLES:-}" ]; then
  if command -v node >/dev/null; then
    node --disable-warning=ExperimentalWarning "$here/gles-shaders.ts" "$out/gles-shaders"
  fi
  "$CC" "${flags[@]}" -o "$out/gles" "$here/gles.c" "$here/sim.c" -lEGL -lGLESv2 -lm
  echo "built $out/gles"
fi
