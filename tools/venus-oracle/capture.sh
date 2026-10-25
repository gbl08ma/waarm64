#!/usr/bin/env bash
# Captures one Venus client through the oracle's capture build (build.sh --capture): run.sh with VENUS_DUMP set to
# target/venus-oracle/captures/<name>.jsonl (emptied first), then prints dump.ts's summary of it.
#   tools/venus-oracle/capture.sh <name> <client command...>
#   e.g. tools/venus-oracle/capture.sh fish1000 target/vulkan/scene/vk --pack target/vulkan/aquarium.pack \
#          --shaders target/vulkan/scene/shaders --fish 1000 --warmup 5 --samples 1 --frames 20
# Env: run.sh's (VENUS_WSI, VENUS_TIMEOUT, ...); DUMP_ARGS: dump.ts's options (default "--last 15").
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
[ $# -ge 2 ] || { echo "usage: $0 <name> <client command...>" >&2; exit 2; }
name=$1
shift
out=$ROOT/target/venus-oracle/captures/$name.jsonl
mkdir -p "$(dirname "$out")"
: > "$out"
status=0
VENUS_DUMP=$out "$ROOT/tools/venus-oracle/run.sh" "$@" || status=$?
# shellcheck disable=SC2086
node "$ROOT/tools/venus-oracle/dump.ts" "$out" ${DUMP_ARGS:---last 15}
exit $status
