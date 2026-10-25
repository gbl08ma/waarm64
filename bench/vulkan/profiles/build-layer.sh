#!/usr/bin/env bash
# The Profiles layer for VK0 A (bench/vulkan/profiles/run.sh): tools/vulkan-tools/build-profiles.sh's source and
# dependencies, with two changes so a profile can give lavapipe a GPU's identity (the stock layer keeps the driver's
# vendorID, deviceID, deviceType and deviceName, and lavapipe's CPU type alone turns GTK4, libplacebo and Dawn away):
# those four made modifiable in gen_profiles_layer.py, and enum values accepted as numbers (its string table has no
# VkPhysicalDeviceType). Built into target/vk0a/profiles. Dev-only.
#   tools/vulkan-tools/build-profiles.sh && bench/vulkan/profiles/build-layer.sh
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../../.." && pwd)
W=$ROOT/target/vulkan-tools
V=$ROOT/target/vk0a
mkdir -p "$V"
rm -rf "$V/psrc"
rsync -a --exclude build "$W/profiles-src/" "$V/psrc/"
G=$V/psrc/scripts/gen_profiles_layer.py
sed -i -E 's/GET_VALUE\(prop, (vendorID|deviceID), true, requested_profile\)/GET_VALUE(prop, \1, false, requested_profile)/' "$G"
sed -i 's/GET_VALUE_ENUM_WARN(prop, deviceType, true,/GET_VALUE_ENUM_WARN(prop, deviceType, false,/' "$G"
sed -i 's/"deviceName", dest->deviceName, true)/"deviceName", dest->deviceName, false)/' "$G"
python3 -I - "$G" <<'PY'
import sys
p = sys.argv[1]; s = open(p).read()
old = """            new_value = static_cast<T>(VkStringToUint64(value.asString()));
        }
        if (warn_func) {"""
new = """            new_value = static_cast<T>(VkStringToUint64(value.asString()));
        } else if (value.isIntegral()) {
            new_value = value.asUInt();
        }
        if (warn_func) {"""
assert s.count(old) == 1, 'GetValueEnum not found'
open(p, 'w').write(s.replace(old, new))
PY
[ "$(grep -c 'false, requested_profile' "$G")" -ge 4 ]
cmake -S "$V/psrc" -B "$V/pbuild" -G Ninja -C "$W/profiles-deps/helper.cmake" -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_INSTALL_PREFIX="$V/profiles" -DBUILD_TESTS=OFF -DUPDATE_DEPS=OFF >/dev/null
cmake --build "$V/pbuild" -j "${JOBS:-4}" >/dev/null
cmake --install "$V/pbuild" >/dev/null
M=$V/profiles/share/vulkan/explicit_layer.d/VkLayer_khronos_profiles.json
L=$V/profiles/lib64/libVkLayer_khronos_profiles.so
sed -i "s|\"library_path\": \"[^\"]*\"|\"library_path\": \"$L\"|" "$M"
echo "VK_LAYER_PATH=$(dirname "$M")"
