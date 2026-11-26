#!/usr/bin/env bash
# bench/compare/run.ts on the Mac host's Chrome (the current Stable Chrome for Testing, headless: bench/mac-chrome.sh),
# as bench/run-mac.sh runs the boot benchmarks there: macOS has V8's wasm trap handler, so compiled code carries no
# explicit bounds checks, as on most visitors' computers and unlike this Linux arm64 VM (docs/v8.md "Bounds checks").
# The page, the core, the firmware and the tests' Debian image are copied to ~/waarm64-bench there (~450 MB more), the
# peers are opened on their own sites from there. Run nothing in the VM meanwhile (it shares the Mac's cores), and
# bench/gpu/mac-leftovers.sh after.
#   [MAC_TIMEOUT=s, the Mac side's bound, 2400] bench/compare/run-mac.sh <name> [bench/compare/run.ts args]   -> bench/compare/results/<name>.json
# and the screenshots, bench/results/local/compare-*.png, both moved back (nothing of a run stays on the Mac:
# bench/mac-out.sh), also from a failed run.
set -euo pipefail
cd "$(dirname "$0")/../.."
name=$1; shift
HOST=${MAC_HOST:-macmini.lan}
DEST=waarm64-bench
CORE=target/wasm32-unknown-unknown/release
ssh "$HOST" "mkdir -p $DEST/bench $DEST/tools $DEST/tests $DEST/$CORE $DEST/target/images/edk2 $DEST/target/images/debian $DEST/target/images/agent $DEST/bench/results/local"
rsync -a --delete --exclude results bench/compare bench/demo bench/stats.ts "$HOST:$DEST/bench/"
. bench/mac-packages.sh && mac_packages "$HOST" "$DEST"
. bench/mac-chrome.sh && mac_chrome "$HOST"
rsync -a --delete web "$HOST:$DEST/"
rsync -a tests/debian-unattended.ts "$HOST:$DEST/tests/"
rsync -a "$CORE/waarm64_core.wasm" "$HOST:$DEST/$CORE/waarm64_core.wasm"
rsync -a target/images/edk2/QEMU_EFI.fd target/images/edk2/LICENSES.txt "$HOST:$DEST/target/images/edk2/"
rsync -aL target/images/debian/disk.qcow2 "$HOST:$DEST/target/images/debian/"
rsync -a target/images/agent/waarm64-agent.gz "$HOST:$DEST/target/images/agent/"
commit=$(git rev-parse --short=12 HEAD)
. bench/mac-out.sh
trap 'rc=$?; mac_move "$HOST" "$DEST" bench/compare/results "bench/results/local/$name.json" || { m=$?; [ $rc -ne 0 ] || rc=$m; }; mac_move "$HOST" "$DEST" bench/results/local "bench/results/local/compare-*.png" 2>/dev/null || true; exit $rc' EXIT
ssh "$HOST" "cd $DEST && export PATH=/opt/homebrew/bin:\$PATH WAARM64_TAILSCALE=0 WAARM64_COMMIT=$commit && \
  export CHROMIUM=\"$MAC_CHROME\" && \
  perl -e 'alarm shift; exec @ARGV' ${MAC_TIMEOUT:-2400} node --disable-warning=ExperimentalWarning bench/compare/run.ts --out \$PWD/bench/results/local/$name.json $*"
