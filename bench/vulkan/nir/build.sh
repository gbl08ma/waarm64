#!/usr/bin/env bash
# VK1 step 1 (bench/vulkan/REPORT.md "VK1"): route (b)'s shader path (spirv_to_nir, NIR's passes, KosmicKrisp's
# nir_to_msl as a NIR -> WGSL backend's stand-in) built for wasm and natively from Mesa's sources, with the harness
# spike.c. A spike: nothing of it reaches the page.
#   bench/vulkan/nir/build.sh [wasi|emscripten|native|native-asan...]   (default: wasi native)
#     -> target/vk1/<toolchain>/spike.wasm (or spike, natively)
# Mesa's tree is the Venus oracle's (tools/venus-oracle/build.sh: mesa-26.2.4, MIT); a native meson build of it
# (target/vk1/build-native) gives the compile commands and the generated sources (gen.ts reads both). The toolchains
# are fetched into target/vk1 at pinned versions: wasi-sdk 34 (Apache-2.0 WITH LLVM-exception; wasi-libc's parts
# MIT/Apache-2.0/CC0) and Emscripten's emsdk (MIT/NCSA).
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../../.." && pwd)
HERE=$ROOT/bench/vulkan/nir
W=$ROOT/target/vk1
MESA=$ROOT/target/venus-oracle/mesa
TOOLCHAINS=${*:-wasi native}
WASI_SDK=wasi-sdk-34.0-arm64-linux
WASI_SHA256=f7e243dff54d60bcc576e94d6166b69f410f2500ae4a9ceef34315be10e77971
EMSDK_VERSION=6.0.13
mkdir -p "$W"
[ -d "$MESA" ] || "$ROOT/tools/venus-oracle/build.sh"

if [ ! -d "$W/build-native" ]; then
  # The Venus ICD only so that NIR is built whole (Mesa builds only its headers without a driver that compiles).
  meson setup "$W/build-native" "$MESA" -Dbuildtype=release -Dvulkan-drivers=virtio -Dgallium-drivers= \
    -Dplatforms= -Dglx=disabled -Degl=disabled -Dgbm=disabled -Dopengl=false -Dgles1=disabled -Dgles2=disabled \
    -Dllvm=disabled -Dvideo-codecs= -Dvulkan-layers= -Dtools=nir -Dbuild-tests=false -Dshared-glapi=disabled \
    >/dev/null
fi
ninja -C "$W/build-native" src/compiler/nir/libnir.a src/compiler/spirv/libvtn.a src/util/libmesa_util.a \
  src/compiler/libcompiler.a src/c11/impl/libmesa_util_c11.a src/util/blake3/libblake3.a >/dev/null

for tc in $TOOLCHAINS; do
  case $tc in
    wasi)
      R=$W/$WASI_SDK
      if [ ! -d "$R" ]; then
        curl -sSfL -o "$W/$WASI_SDK.tar.gz" \
          "https://github.com/WebAssembly/wasi-sdk/releases/download/wasi-sdk-34/$WASI_SDK.tar.gz"
        echo "$WASI_SHA256  $W/$WASI_SDK.tar.gz" | sha256sum -c --quiet
        tar xzf "$W/$WASI_SDK.tar.gz" -C "$W"
      fi ;;
    emscripten)
      R=$W/emsdk/upstream/emscripten
      if [ ! -x "$R/emcc" ]; then
        [ -d "$W/emsdk" ] || git clone -q https://github.com/emscripten-core/emsdk.git "$W/emsdk"
        (cd "$W/emsdk" && ./emsdk install "$EMSDK_VERSION" >/dev/null && ./emsdk activate "$EMSDK_VERSION" >/dev/null)
      fi ;;
    native|native-asan) R= ;;  # native-asan: -O1 -g with AddressSanitizer, for stack traces (gdb fails in the dev VM)
    *) echo "unknown toolchain $tc" >&2; exit 2 ;;
  esac
  O=$W/$tc
  mkdir -p "$O/gen"
  python3 "$MESA/src/kosmickrisp/compiler/msl_nir_algebraic.py" -p "$MESA/src/compiler/nir" > "$O/gen/msl_nir_algebraic.c"
  node "$HERE/gen.ts" "$W/build-native" "$O" "$tc" "$R"
  ninja -C "$O" >/dev/null
  ls -l "$O"/spike*
done
