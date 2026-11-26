#!/usr/bin/env bash
# bench/vulkan/tint-time.ts on the Mac host's GPU (Metal, Playwright's Chrome for Testing, as mac-costs.sh runs there):
# each module of a directory of WGSL, its createShaderModule timed.
#   bench/vulkan/mac-tint-time.sh <name> <dir of .wgsl>    -> bench/results/local/<name>.json (TIMEOUT_S, REPEAT passed on;
#                                                              moved back: bench/mac-out.sh)
set -euo pipefail
cd "$(dirname "$0")/../.."
HOST=${MAC_HOST:-macmini.lan}
DEST=waarm64-gpu-bench.noindex
NAME=$1
DIR=$2
ssh "$HOST" "mkdir -p $DEST/bench/vulkan $DEST/bench/results/local && rm -rf $DEST/target/tint-time && mkdir -p $DEST/target/tint-time"
rsync -a bench/vulkan/tint-time.ts "$HOST:$DEST/bench/vulkan/"
rsync -a "$DIR/" "$HOST:$DEST/target/tint-time/"
. bench/mac-packages.sh && mac_packages "$HOST" "$DEST"
. bench/mac-chrome.sh && mac_chrome "$HOST"   # the current Stable Chrome for Testing there
. bench/mac-out.sh && mac_move_at_exit "$HOST" "$DEST" "$(dirname "bench/results/local/$NAME")" "bench/results/local/$NAME.json"
ssh "$HOST" "cd $DEST && export PATH=/opt/homebrew/bin:\$PATH TIMEOUT_S=${TIMEOUT_S:-60} REPEAT=${REPEAT:-1} && \
  export CHROMIUM=\"$MAC_CHROME\" && \
  perl -e 'alarm shift; exec @ARGV' ${MAC_TIMEOUT:-500} node --disable-warning=ExperimentalWarning bench/vulkan/tint-time.ts bench/results/local/$NAME.json target/tint-time"
