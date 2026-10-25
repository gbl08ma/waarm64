#!/usr/bin/env bash
# The guest-side cost of Venus's encoding, in AArch64 instructions (the guest's ISA; the JIT runs about one step per
# instruction): the scene through the Venus oracle under callgrind, counting only inside Mesa's Venus entry points
# (--toggle-collect='vn_*', their callees too: the encoder's memcpys), at two frame counts; the difference over the
# extra frames is the instructions a frame. Counts, not timing. Needs valgrind (zypper) and build.sh's oracle.
#   tools/venus-oracle/encode-cost.sh [scene args...]   (default: --fish 1000)
# Prints instructions per frame. The loader's trampolines jump (not call) into vn_*, so callgrind keeps collecting a
# little past some returns: a few % of the app's own code (sin_d, sim_fish) lands in the count.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
[ $# -gt 0 ] || set -- --fish 1000
dir=$(mktemp -d /tmp/venus-cg.XXXXXX)
trap 'rm -rf "$dir"' EXIT
declare -A ir
for F in 20 60; do
  VENUS_SERVER_LOG=/dev/null VENUS_TIMEOUT=${VENUS_TIMEOUT:-500} "$ROOT/tools/venus-oracle/run.sh" valgrind --tool=callgrind \
    --toggle-collect='vn_*' --callgrind-out-file="$dir/$F.out" "$ROOT/target/vulkan/scene/vk" \
    --pack "$ROOT/target/vulkan/aquarium.pack" --shaders "$ROOT/target/vulkan/scene/shaders" "$@" \
    --warmup 5 --samples 1 --frames "$F" > "$dir/$F.log" 2>&1
  ir[$F]=$(sed -n 's/.*Collected : \([0-9]*\).*/\1/p' "$dir/$F.log")
done
echo "$* : $(( (ir[60] - ir[20]) / 40 )) instructions a frame in vn_* (${ir[20]} at 25 frames, ${ir[60]} at 65)"
