#!/usr/bin/env bash
# G0's real-GPU numbers (the user's answer to the G0/G1 kickoff, docs/graphics.md "Decisions"): the bench page on the Mac host's
# Chromium (Playwright's Chrome for Testing, headless, temporary profile), served from a small copy in
# ~/waarm64-gpu-bench there, the packages installed there. It needs Node, npm and the Chromium that Playwright
# installed. Nothing else on the host is touched.
#   bench/gpu/run-mac.sh [extra bench/run.ts args]    -> bench/results/local/gpu-mac.json
set -euo pipefail
cd "$(dirname "$0")/../.."
HOST=${MAC_HOST:-macmini.lan}
DEST=waarm64-gpu-bench
rsync -a --delete --exclude results --exclude memory bench/gpu bench/spike bench/run.ts bench/stats.ts "$HOST:$DEST/bench/"
rsync -a --delete web "$HOST:$DEST/"   # flush_cost runs the backend itself (web/gpu.ts and what it imports)
# The dev server (Vite: tools/serve.ts) and the packages, installed there (bench/mac-packages.sh).
. bench/mac-packages.sh && mac_packages "$HOST" "$DEST"
. bench/mac-chrome.sh && mac_chrome "$HOST"   # the current Stable Chrome for Testing there
ssh "$HOST" "cd $DEST && export PATH=/opt/homebrew/bin:\$PATH && \
  export CHROMIUM=\"$MAC_CHROME\" && \
  node --disable-warning=ExperimentalWarning bench/run.ts --page bench/gpu/index.html --chromium-args='--enable-unsafe-webgpu' --out bench/results/local/gpu-mac.json $* && \
  sw_vers -productVersion > bench/results/local/gpu-mac.macos && system_profiler SPDisplaysDataType | grep -E 'Chipset|Metal|Cores' > bench/results/local/gpu-mac.gpu"
mkdir -p bench/results/local
rsync -a "$HOST:$DEST/bench/results/local/gpu-mac.*" bench/results/local/
