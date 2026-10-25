#!/usr/bin/env bash
# Records a Vulkan program's calls with GFXReconstruct's capture layer (build-gfxr.sh) and converts them to JSON lines.
#   tools/vulkan-tools/gfxr-capture.sh <out.gfxr> <range> <command...>
# <range> picks what is kept, as GFXReconstruct's trim ranges ("159-161", "200,301-305"; each range its own file,
# named <out>_queue_submits_<a>_through_<b>.gfxr or <out>_frames_<a>_through_<b>.gfxr):
#   q:<range>  queue submits (0-based vkQueueSubmit calls; for programs without a swapchain, like the scene, whose
#              frames are one submit each after its setup's: the scene with aquarium.pack makes 59 setup submits, so
#              its frame f is submit 59+f; check with `all`)
#   f:<range>  frames (1-based; ended by vkQueuePresentKHR, or a submit carrying VkFrameBoundaryEXT)
#   all        everything (then `grep -c '"vkQueueSubmit"'` on the JSON counts the submits)
# The trimmed file starts with the state the range needs (resources, their contents, descriptor sets, pipelines).
# Each .gfxr gets a .jsonl beside it (gfxrecon-convert --format jsonl; pass GFXR_CONVERT_ARGS for more, such as
# --include-binaries or --expand-flags). Other GFXRECON_* settings pass through (docs: USAGE_desktop_Vulkan.md in
# target/vulkan-tools/gfxreconstruct-src).
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
G=$ROOT/target/vulkan-tools/gfxreconstruct
[ -x "$G/bin/gfxrecon-convert" ] || { echo "build it first: tools/vulkan-tools/build-gfxr.sh" >&2; exit 1; }
[ $# -ge 3 ] || { echo "usage: $0 <out.gfxr> q:<range>|f:<range>|all <command...>" >&2; exit 2; }
out=$(realpath -m "$1") range=$2
shift 2
mkdir -p "$(dirname "$out")"
stem=${out%.gfxr}
rm -f "$stem".gfxr "$stem"_*.gfxr
trim=()
case $range in
  q:*) trim=(GFXRECON_CAPTURE_QUEUE_SUBMITS="${range#q:}") ;;
  f:*) trim=(GFXRECON_CAPTURE_FRAMES="${range#f:}" GFXRECON_QUIT_AFTER_CAPTURE_FRAMES=true) ;;
  all) ;;
  *) echo "bad range: $range" >&2; exit 2 ;;
esac
env VK_LAYER_PATH="$G/share/vulkan/explicit_layer.d${VK_LAYER_PATH:+:$VK_LAYER_PATH}" \
  VK_INSTANCE_LAYERS="VK_LAYER_LUNARG_gfxreconstruct${VK_INSTANCE_LAYERS:+:$VK_INSTANCE_LAYERS}" \
  GFXRECON_CAPTURE_FILE="$out" GFXRECON_CAPTURE_FILE_TIMESTAMP=false GFXRECON_LOG_LEVEL="${GFXRECON_LOG_LEVEL:-warning}" \
  "${trim[@]}" "$@"
for f in "$stem".gfxr "$stem"_*.gfxr; do
  [ -f "$f" ] || continue
  # shellcheck disable=SC2086
  "$G/bin/gfxrecon-convert" --format jsonl ${GFXR_CONVERT_ARGS:-} --output "${f%.gfxr}.jsonl" "$f"
  echo "$f ($(du -h "$f" | cut -f1)) -> ${f%.gfxr}.jsonl ($(du -h "${f%.gfxr}.jsonl" | cut -f1))"
done
