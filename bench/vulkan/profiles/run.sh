#!/usr/bin/env bash
# Runs a program on the dev VM's lavapipe through one of VK0 A's profiles (bench/vulkan/profiles/make.ts) with the
# Profiles layer (tools/vulkan-tools/build-profiles.sh). PROFILE is a file stem and a profile suffix:
#   PROFILE=mac bench/vulkan/profiles/run.sh vulkaninfo --summary          (VP_WEBPC_webgpu_mac in webgpu-mac.json)
#   PROFILE=swiftshader:gs bench/vulkan/profiles/run.sh <cmd>               (VP_WEBPC_webgpu_swiftshader_gs)
# PROFILE unset or "none" runs the program on lavapipe as it is. PROFILES_LOG=1 turns on the layer's debug output.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../../.." && pwd)
P=${PROFILE:-none}
if [ "$P" != none ]; then
  file=${P%%:*}; row=${P#*:}; [ "$row" = "$P" ] && row=
  # The Profiles layer with the device's identity (vendorID, deviceID, deviceType, deviceName) made modifiable:
  # bench/vulkan/profiles/build-layer.sh builds it into target/vk0a/profiles. LAYER_DIR=target/vulkan-tools/profiles/share/vulkan/explicit_layer.d is the stock one
  # (which leaves lavapipe's CPU identity).
  export VK_LAYER_PATH=${LAYER_DIR:-$ROOT/target/vk0a/profiles/share/vulkan/explicit_layer.d}
  export VK_INSTANCE_LAYERS=VK_LAYER_KHRONOS_profiles
  export VK_KHRONOS_PROFILES_PROFILE_FILE=$ROOT/bench/vulkan/profiles/webgpu-$file.json
  # A copy of the file with one profile: the direct block and each row's (rows combine with '+'). The layer reports
  # what the profile says even where the driver lacks it (it doesn't intersect features), so features lavapipe lacks
  # are turned off in the copy (LAVAPIPE_FIX=0 keeps them): a program that enables every reported feature would
  # otherwise fail vkCreateDevice. On lavapipe 26.2 that's textureCompressionETC2 and textureCompressionASTC_LDR.
  tmp=${TMPDIR:-/tmp}/webgpu-$file-${row//+/_}.json
  python3 -I - "$VK_KHRONOS_PROFILES_PROFILE_FILE" "$file" "$row" "$tmp" "${LAVAPIPE_FIX:-1}" <<'PY'
import json, sys
src, name, rows, out, fix = sys.argv[1:]
d = json.load(open(src))
p = dict(d['profiles'][f'VP_WEBPC_webgpu_{name}'])
if rows == 'all':
    p = dict(d['profiles'][f'VP_WEBPC_webgpu_{name}_all'])
else:
    p['capabilities'] = [f'{name}_direct'] + [f'{name}_{r}' for r in rows.split('+') if r]
if fix == '1':
    f = d['capabilities'][f'{name}_direct']['features']['VkPhysicalDeviceFeatures']
    f['textureCompressionETC2'] = False
    f['textureCompressionASTC_LDR'] = False
d['profiles'] = {f'VP_WEBPC_webgpu_{name}_run': p}
json.dump(d, open(out, 'w'))
PY
  export VK_KHRONOS_PROFILES_PROFILE_FILE=$tmp VK_KHRONOS_PROFILES_PROFILE_NAME=VP_WEBPC_webgpu_${file}_run
  export VK_KHRONOS_PROFILES_SIMULATE_CAPABILITIES=${PROFILES_SIMULATE:-SIMULATE_API_VERSION_BIT,SIMULATE_FEATURES_BIT,SIMULATE_PROPERTIES_BIT,SIMULATE_EXTENSIONS_BIT,SIMULATE_FORMATS_BIT}
  export VK_KHRONOS_PROFILES_DEFAULT_FEATURE_VALUES=DEFAULT_FEATURE_VALUES_FALSE
  export VK_KHRONOS_PROFILES_EMULATE_PORTABILITY=false
  # The layer adds the names of every extension promoted to the profile's API version; hide those whose features
  # the profile leaves off (a program that checks names rather than feature bits would otherwise be misled).
  ex=VK_EXT_4444_formats,VK_EXT_descriptor_indexing,VK_EXT_sampler_filter_minmax,VK_EXT_scalar_block_layout
  ex=$ex,VK_EXT_shader_viewport_index_layer,VK_EXT_texture_compression_astc_hdr,VK_EXT_ycbcr_2plane_444_formats
  ex=$ex,VK_KHR_16bit_storage,VK_KHR_8bit_storage,VK_KHR_buffer_device_address,VK_KHR_multiview
  ex=$ex,VK_KHR_sampler_mirror_clamp_to_edge,VK_KHR_sampler_ycbcr_conversion,VK_KHR_shader_atomic_int64
  ex=$ex,VK_KHR_shader_draw_parameters,VK_KHR_variable_pointers
  case +$row+ in *+mdi+*|*+all+*) ;; *) ex=$ex,VK_KHR_draw_indirect_count ;; esac
  case +$row+ in *+ycbcr+*|*+all+*) ex=${ex/,VK_KHR_sampler_ycbcr_conversion/} ;; esac
  case +$row+ in *+drawparams+*|*+all+*) ex=${ex/,VK_KHR_shader_draw_parameters/} ;; esac
  export VK_KHRONOS_PROFILES_EXCLUDE_DEVICE_EXTENSIONS=${PROFILES_EXCLUDE:-$ex}
  if [ -n "${PROFILES_LOG:-}" ]; then
    export VK_KHRONOS_PROFILES_DEBUG_REPORTS=DEBUG_REPORT_NOTIFICATION_BIT,DEBUG_REPORT_WARNING_BIT,DEBUG_REPORT_ERROR_BIT
  else
    export VK_KHRONOS_PROFILES_DEBUG_REPORTS=DEBUG_REPORT_ERROR_BIT
  fi
fi
exec "$@"
