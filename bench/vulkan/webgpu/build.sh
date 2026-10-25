#!/usr/bin/env bash
# The scene's simulation for the WebGPU pages (scene-wasm.c) -> target/vulkan/scene.wasm, with clang's wasm32 target
# and no libc (wasm-ld links it). The default build also refreshes bench/vulkan/webgpu/scene.wasm, the committed copy
# that bench/vulkan/nvidia.sh falls back to where clang has no wasm-ld: commit it with any change to the C it's built
# from.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
out=${1:-$here/../../../target/vulkan/scene.wasm}
mkdir -p "$(dirname "$out")"
clang --target=wasm32-unknown-unknown -O2 -std=c11 -nostdlib -ffreestanding -mbulk-memory -Wall -Wno-unused-function \
  -Wl,--no-entry -Wl,-z,stack-size=1048576 -o "$out" "$here/scene-wasm.c" "$here/../scene/sim.c"
[ -n "${1:-}" ] || cp "$out" "$here/scene.wasm"
echo "built $out ($(wc -c < "$out") bytes)"
