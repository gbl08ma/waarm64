#!/usr/bin/env bash
# Khronos's Profiles layer (VK_LAYER_KHRONOS_profiles, Apache-2.0; bench/vulkan/REPORT.md "A"): makes a real driver
# advertise only a chosen profile's features, limits, formats and extensions. At the Vulkan SDK 1.4.363.0 tag (the
# system's Vulkan), built natively into target/vulkan-tools/profiles/ with its pinned dependencies (Vulkan-Headers,
# Vulkan-Utility-Libraries, jsoncpp, valijson: scripts/known_good.json, fetched and built by its update_deps.py).
# Dev-only. Needs cmake, ninja, python3. Idempotent: a built tree is reused.
#   tools/vulkan-tools/build-profiles.sh
# Then, to make a driver advertise only a profile (the shipped ones, merged per file:
# target/vulkan-tools/profiles-src/profiles/build/*.json; or one of ours):
#   VK_LAYER_PATH=target/vulkan-tools/profiles/share/vulkan/explicit_layer.d VK_INSTANCE_LAYERS=VK_LAYER_KHRONOS_profiles \
#   VK_KHRONOS_PROFILES_PROFILE_FILE=<profile.json> VK_KHRONOS_PROFILES_PROFILE_NAME=<profile in it> \
#   VK_KHRONOS_PROFILES_SIMULATE_CAPABILITIES=SIMULATE_API_VERSION_BIT,SIMULATE_FEATURES_BIT,SIMULATE_PROPERTIES_BIT,SIMULATE_EXTENSIONS_BIT,SIMULATE_FORMATS_BIT \
#   VK_KHRONOS_PROFILES_DEFAULT_FEATURE_VALUES=DEFAULT_FEATURE_VALUES_FALSE <program>
# (the default simulates only the API version, features and limits, and leaves the device's value for every feature
# the profile doesn't name; DEFAULT_FEATURE_VALUES_FALSE turns those off.)
set -euo pipefail
TAG=vulkan-sdk-1.4.363.0   # commit fce885d30ebafed32e03c0b199bc67d6a758887f
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
W=$ROOT/target/vulkan-tools
P=$W/profiles
mkdir -p "$W"
if [ ! -d "$W/profiles-src" ]; then
  git clone -q --depth 1 --branch "$TAG" https://github.com/KhronosGroup/Vulkan-Profiles.git "$W/profiles-src"
fi
if [ ! -f "$W/profiles-deps/helper.cmake" ]; then
  python3 "$W/profiles-src/scripts/update_deps.py" --dir "$W/profiles-deps" --config release --generator Ninja \
    --known_good_dir "$W/profiles-src/scripts" >/dev/null
fi
if [ ! -f "$W/build-profiles/build.ninja" ]; then
  cmake -S "$W/profiles-src" -B "$W/build-profiles" -G Ninja -C "$W/profiles-deps/helper.cmake" \
    -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX="$P" -DBUILD_TESTS=OFF -DUPDATE_DEPS=OFF >/dev/null
fi
cmake --build "$W/build-profiles" -j "${JOBS:-4}" >/dev/null
cmake --install "$W/build-profiles" >/dev/null
M=$(find "$P" -name VkLayer_khronos_profiles.json | head -1)
L=$(find "$P" -name libVkLayer_khronos_profiles.so | head -1)
# The manifest names the library relative to the loader's search path: point it at ours.
sed -i "s|\"library_path\": \"[^\"]*\"|\"library_path\": \"$L\"|" "$M"
grep -q "\"library_path\": \"$L\"" "$M"
echo "VK_LAYER_PATH=$(dirname "$M")"
