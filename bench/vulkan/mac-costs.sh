#!/usr/bin/env bash
# bench/vulkan/costs.ts on the Mac host's GPU (as bench/gpu/sway-mac.sh runs the page there: a copy in
# ~/webpc-gpu-bench, Playwright's Chrome for Testing, nothing installed): the renderer, the page's sources, the driver's
# test shaders compiled here.
#   bench/vulkan/mac-costs.sh <name>     -> bench/results/local/<name>.json (N passed on)
# SCRIPT=fence.ts runs VK3 L2's round trips (bench/vulkan/fence.ts) instead.
# SCRIPT=upload-race.ts VK3 L4's orderings (ALL passed on).
set -euo pipefail
cd "$(dirname "$0")/../.."
HOST=${MAC_HOST:-macmini.lan}
DEST=webpc-gpu-bench
NAME=$1
mkdir -p target/vk/test
for s in tests/venus/driver.vert tests/venus/driver.frag tests/venus/driver.comp bench/vulkan/costs/costs.frag; do
  glslc --target-env=vulkan1.2 -o "target/vk/test/$(basename "$s").spv" "$s"
done
ssh "$HOST" "mkdir -p $DEST/bench/results/local $DEST/target/vk/test $DEST/tests"
rsync -a --delete --exclude results bench/vulkan "$HOST:$DEST/bench/"
rsync -a --delete web "$HOST:$DEST/"
rsync -a tests/venus "$HOST:$DEST/tests/"
rsync -a target/vk/venus.wasm "$HOST:$DEST/target/vk/" && rsync -a target/vk/test/ "$HOST:$DEST/target/vk/test/"
. bench/mac-packages.sh && mac_packages "$HOST" "$DEST"
ssh "$HOST" "cd $DEST && export PATH=/opt/homebrew/bin:\$PATH N=${N:-40} SEED=${SEED:-} POLL=${POLL:-} ALL=${ALL:-} && \
  export CHROMIUM=\"\$(ls -d \$HOME/Library/Caches/ms-playwright/chromium-*/chrome-mac-arm64/*.app | sort | tail -1)/Contents/MacOS/Google Chrome for Testing\" && \
  perl -e 'alarm shift; exec @ARGV' ${MAC_TIMEOUT:-300} node --disable-warning=ExperimentalWarning bench/vulkan/${SCRIPT:-costs.ts} bench/results/local/$NAME.json"
rsync -a "$HOST:$DEST/bench/results/local/$NAME.json" bench/results/local/
