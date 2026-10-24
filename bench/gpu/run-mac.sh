#!/usr/bin/env bash
# G0's real-GPU numbers (the user's answer to the G0/G1 kickoff, docs/plans/graphics.md §1): the bench page on the Mac host's
# Chromium (Playwright's Chrome for Testing, headless, temporary profile), served from a small copy in
# ~/webpc-gpu-bench there. It needs Node and playwright-core (a copy of node_modules/playwright-core
# from any checkout there) and the Chromium that Playwright installed. Nothing else on the host is touched.
#   bench/gpu/run-mac.sh [extra bench/run.ts args]    -> bench/results/local/gpu-mac.json
set -euo pipefail
cd "$(dirname "$0")/../.."
HOST=${MAC_HOST:-macmini.lan}
DEST=webpc-gpu-bench
rsync -a --delete --exclude results --exclude memory bench/gpu bench/spike bench/run.ts bench/stats.ts "$HOST:$DEST/bench/"
rsync -a tools/serve.ts tools/tailscale.ts tools/nosme.ts "$HOST:$DEST/tools/"
rsync -a --delete --include '*/' --include '*.ts' --exclude '*' web "$HOST:$DEST/"   # flush_cost runs the backend itself (web/gpu.ts and what it imports)
rsync -a package.json "$HOST:$DEST/"
ssh "$HOST" "cd $DEST && export PATH=/opt/homebrew/bin:\$PATH && \
  export CHROMIUM=\"\$(ls -d \$HOME/Library/Caches/ms-playwright/chromium-*/chrome-mac-arm64/*.app | sort | tail -1)/Contents/MacOS/Google Chrome for Testing\" && \
  node --disable-warning=ExperimentalWarning bench/run.ts --page bench/gpu/index.html --chromium-args='--enable-unsafe-webgpu' --out bench/results/local/gpu-mac.json $* && \
  sw_vers -productVersion > bench/results/local/gpu-mac.macos && system_profiler SPDisplaysDataType | grep -E 'Chipset|Metal|Cores' > bench/results/local/gpu-mac.gpu"
mkdir -p bench/results/local
rsync -a "$HOST:$DEST/bench/results/local/gpu-mac.*" bench/results/local/
