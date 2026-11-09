#!/usr/bin/env bash
# The Vulkan renderer (docs/graphics.md "Vulkan through Venus", route (b); VK1): virglrenderer's Venus decoder (vkr) over our driver on
# Mesa's Vulkan runtime, built for wasm with wasi-sdk -> target/vk/venus.wasm, which the GPU worker instantiates on
# memory 0 (vk/README.md). Native meson builds of virglrenderer and Mesa give the compile commands and the generated
# sources (gen.ts reads both); their C is compiled again for wasm32-wasip1 with our shims (vk/wasi/) and patches
# (vk/patches/). Idempotent: built trees are reused.
#   vk/build.sh            -> target/vk/venus.wasm
#   vk/build.sh native     -> also target/vk/wgsl (the translator natively, with ASan: one stage's WGSL)
#   vk/build.sh --inputs   print the key of what decides the module (vk/ and the arena's size), which a build writes to
#                          venus.wasm.inputs beside it: `npm start` rebuilds the module when they differ
# VK_WORK=<dir> builds in <dir> instead of target/vk (images/build.sh venus: in Podman, docs/images.md "venus").
# Needs what tools/venus-oracle/build.sh needs (meson, ninja, python313-Mako, …), Node and network the first time.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
W=${VK_WORK:-$ROOT/target/vk}
inputs() {
  { for f in $(cd "$ROOT" && find vk -type f ! -name '*.md' | LC_ALL=C sort); do printf '%s\0' "$f"; cat "$ROOT/$f"; done
    grep -E '^export const VENUS_ARENA ' "$ROOT/web/ram.ts"; } | sha256sum | cut -c1-16
}
if [ "${1:-}" = --inputs ]; then inputs; exit 0; fi
KEY=$(inputs)
VIRGL_COMMIT=e0a1caf3b147bb26dfe524dbb85ded1177e7e49e   # virglrenderer main, 2026-10-21 (MIT): the Venus oracle's
MESA_TAG=mesa-26.2.4                                     # MIT, as the oracle
case $(uname -m) in
  aarch64) WASI_SDK=wasi-sdk-34.0-arm64-linux WASI_SHA256=f7e243dff54d60bcc576e94d6166b69f410f2500ae4a9ceef34315be10e77971 ;;
  x86_64) WASI_SDK=wasi-sdk-34.0-x86_64-linux WASI_SHA256=b761e3a0721dbae9c09a0059e5fdb2bf917d1b4a8a7b430fb3b5aafb0984b2c4 ;;
  *) echo "no wasi-sdk for $(uname -m)" >&2; exit 2 ;;
esac
mkdir -p "$W"

# wasi-sdk 34 (Apache-2.0 WITH LLVM-exception; THIRD_PARTY.json).
if [ ! -x "$W/$WASI_SDK/bin/clang" ]; then
  curl -sSfL -o "$W/$WASI_SDK.tar.gz" "https://github.com/WebAssembly/wasi-sdk/releases/download/wasi-sdk-34/$WASI_SDK.tar.gz"
  echo "$WASI_SHA256  $W/$WASI_SDK.tar.gz" | sha256sum -c --quiet
  tar xzf "$W/$WASI_SDK.tar.gz" -C "$W" && rm "$W/$WASI_SDK.tar.gz"
fi

# Mesa: its util, the Vulkan runtime (lite: no shaders yet) and vk.xml's generated tables.
if [ ! -d "$W/mesa" ]; then
  git clone -q --depth 1 --branch "$MESA_TAG" https://gitlab.freedesktop.org/mesa/mesa.git "$W/mesa"
fi
if [ ! -d "$W/build-mesa" ]; then
  # The Venus ICD only for what it pulls in (the lite runtime, vulkan util): Mesa has no option for those alone.
  meson setup "$W/build-mesa" "$W/mesa" -Dbuildtype=release -Dvulkan-drivers=virtio -Dgallium-drivers= -Dplatforms= \
    -Dglx=disabled -Degl=disabled -Dgbm=disabled -Dopengl=false -Dgles1=disabled -Dgles2=disabled -Dllvm=disabled \
    -Dvideo-codecs= -Dvulkan-layers= -Dtools= -Dbuild-tests=false -Dshared-glapi=disabled >/dev/null
fi
ninja -C "$W/build-mesa" src/vulkan/runtime/libvulkan_lite_runtime.a src/vulkan/runtime/libvulkan_runtime.a \
  src/vulkan/runtime/libvulkan_instance.a src/vulkan/util/libvulkan_util.a src/util/libmesa_util.a \
  src/c11/impl/libmesa_util_c11.a src/util/blake3/libblake3.a src/compiler/nir/libnir.a src/compiler/spirv/libvtn.a \
  src/compiler/libcompiler.a >/dev/null

# virglrenderer: Venus only, the Vulkan library linked (our driver's vkGetInstanceProcAddr), no render server use.
if [ ! -d "$W/virglrenderer" ]; then
  git clone -q https://gitlab.freedesktop.org/virgl/virglrenderer.git "$W/virglrenderer"
fi
git -C "$W/virglrenderer" checkout -q --force "$VIRGL_COMMIT"
git -C "$W/virglrenderer" clean -fdq -e subprojects
for p in "$ROOT"/vk/patches/*.patch; do [ -f "$p" ] && git -C "$W/virglrenderer" apply "$p"; done
if [ ! -d "$W/build-virgl" ]; then
  meson setup "$W/build-virgl" "$W/virglrenderer" -Dbuildtype=release -Dvrend=false -Dvenus=true -Dvulkan-dload=false \
    -Dtests=false -Dplatforms= -Ddrm-renderers= -Dvideo=false >/dev/null
fi
# src/mesa/libmesa.a by name: meson 1.12 builds libvirgl.a without its objects (gen.ts reads them).
ninja -C "$W/build-virgl" src/libvirgl.a src/mesa/libmesa.a >/dev/null

# Our driver's entrypoint tables (prefix wg), as Mesa's drivers make theirs.
G=$W/gen
mkdir -p "$G"
python3 "$W/mesa/src/vulkan/util/vk_entrypoints_gen.py" --xml "$W/mesa/src/vulkan/registry/vk.xml" --proto --weak \
  --out-h "$G/wg_entrypoints.h" --out-c "$G/wg_entrypoints.c" --prefix wg --beta false

node "$ROOT/vk/gen.ts" "$W" "$W/$WASI_SDK"
# Quiet, but a failure shows its end (a compile error).
ninja -C "$W" -f wasm.ninja > "$W/wasm-build.log" || { tail -30 "$W/wasm-build.log"; exit 1; }
if [ "${1:-}" = native ]; then ninja -C "$W" -f native.ninja > "$W/native-build.log" || { tail -30 "$W/native-build.log"; exit 1; }; fi

# The licences shipped beside the module (`npm run dist` copies both; THIRD_PARTY.json's row).
{
  cat "$ROOT/vk/LICENSES.head"
  section() { printf '\n\n==== %s ====\n\n' "$1"; }
  section 'virglrenderer: COPYING'; cat "$W/virglrenderer/COPYING"
  section 'Mesa: docs/license.rst'; cat "$W/mesa/docs/license.rst"
  section 'MIT (Mesa: licenses/MIT)'; cat "$W/mesa/licenses/MIT"
  section 'Berkeley SoftFloat 3e (Mesa: src/util/softfloat.c)'; sed -n '2,/^ \*\/$/p' "$W/mesa/src/util/softfloat.c" | sed -n '1,/DAMAGE\./p'
  section 'BSL-1.0 (Mesa: licenses/BSL-1.0)'; cat "$W/mesa/licenses/BSL-1.0"
  section 'Apache-2.0 (Mesa: licenses/Apache-2.0)'; cat "$W/mesa/licenses/Apache-2.0"
  section 'LLVM Exceptions to the Apache 2.0 License'; cat "$ROOT/vk/LLVM-exception.txt"
} > "$W/LICENSES.txt"
echo "$KEY" > "$W/venus.wasm.inputs"
ls -l "$W/venus.wasm"
