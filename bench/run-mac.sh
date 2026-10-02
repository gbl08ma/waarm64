#!/usr/bin/env bash
# The boot and small-guest benchmarks on the Mac host's Chromium (Playwright's Chrome for Testing,
# headless, temporary profile): macOS has V8's wasm trap handler, so its numbers are without the
# explicit bounds checks this Linux arm64 VM's carry (docs/v8.md "Bounds checks"). The pages, the
# wasm core and the Alpine images are copied to ~/webpc-bench there (~600 MB); it needs Node and
# playwright-core (taken from ~/webpc-gpu-bench/node_modules, bench/gpu/run-mac.sh's, if missing)
# and the Chromium that Playwright installed. Nothing else on the host is touched.
#   [WASM=core.wasm] bench/run-mac.sh <name> [bench/run.ts args]   -> bench/results/local/mac/<name>.json
# e.g. bench/run-mac.sh user-default --page bench/boot/index.html --only alpine_user_jit
set -euo pipefail
cd "$(dirname "$0")/.."
name=$1; shift
HOST=${MAC_HOST:-macmini.lan}
DEST=webpc-bench
CORE=target/wasm32-unknown-unknown/release
ssh "$HOST" "mkdir -p $DEST/bench $DEST/tools $DEST/$CORE $DEST/target/images $DEST/target/bench && { [ -d $DEST/node_modules ] || cp -R webpc-gpu-bench/node_modules $DEST/; }"
rsync -a --delete --exclude results --exclude memory bench/boot bench/interp bench/spike bench/run.ts bench/stats.ts "$HOST:$DEST/bench/"
rsync -a tools/serve.ts tools/tailscale.ts "$HOST:$DEST/tools/"
rsync -a --delete --include '*/' --include '*.ts' --exclude '*' web "$HOST:$DEST/"
rsync -a package.json "$HOST:$DEST/"
rsync -a "${WASM:-$CORE/webpc_core.wasm}" "$HOST:$DEST/$CORE/webpc_core.wasm"
rsync -a target/images/alpine target/images/alpine-user "$HOST:$DEST/target/images/"
rsync -a --exclude '*defconfig' --exclude 'System.map' target/images/linux target/images/buildroot "$HOST:$DEST/target/images/"
rsync -a target/bench/coremark.bin target/bench/coremark-linux "$HOST:$DEST/target/bench/"
ssh "$HOST" "cd $DEST && export PATH=/opt/homebrew/bin:\$PATH WEBPC_TAILSCALE=0 && \
  export CHROMIUM=\"\$(ls -d \$HOME/Library/Caches/ms-playwright/chromium-*/chrome-mac-arm64/*.app | sort | tail -1)/Contents/MacOS/Google Chrome for Testing\" && \
  node --disable-warning=ExperimentalWarning bench/run.ts --out bench/results/local/$name.json $*"
mkdir -p bench/results/local/mac
rsync -a "$HOST:$DEST/bench/results/local/$name.json" bench/results/local/mac/
