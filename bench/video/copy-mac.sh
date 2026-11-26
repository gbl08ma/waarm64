#!/usr/bin/env bash
# bench/video/copy.ts on the Mac host's Chrome for Testing (VideoToolbox's hardware decoders, whose frames are NV12: the
# dev VM's Chromium has none), from a copy in ~/waarm64-gpu-bench there (as bench/video/replay-mac.sh: Node and the
# page's packages there; nothing else on the host is touched). Alone: the VM shares the Mac's cores.
#   bench/video/copy-mac.sh <out.json> [copy.ts's arguments]
# TOOL=upload runs bench/video/upload.ts there instead (a picture's uploads, on a real GPU). The JSON is moved back
# (nothing of a run stays on the Mac: bench/mac-out.sh).
set -euo pipefail
cd "$(dirname "$0")/../.."
HOST=${MAC_HOST:-macmini.lan}
DEST=waarm64-gpu-bench
OUT=$1; shift
TOOL=${TOOL:-copy}
ssh "$HOST" "mkdir -p $DEST/bench/results/local/video $DEST/tools"
rsync -a --delete --exclude results bench/video "$HOST:$DEST/bench/"
rsync -a --delete web "$HOST:$DEST/"
# The dev server (Vite: tools/serve.ts) and the packages, installed there (bench/mac-packages.sh).
. bench/mac-packages.sh && mac_packages "$HOST" "$DEST"
. bench/mac-chrome.sh && mac_chrome "$HOST"   # the current Stable Chrome for Testing there
tmp=$(mktemp -d)
. bench/mac-out.sh
trap 'rc=$?; mac_move "$HOST" "$DEST" "$tmp" "bench/results/local/video/$TOOL.json" || { m=$?; [ $rc -ne 0 ] || rc=$m; }; mkdir -p "$(dirname "$OUT")"; [ ! -f "$tmp/$TOOL.json" ] || mv "$tmp/$TOOL.json" "$OUT"; rm -rf "$tmp"; exit $rc' EXIT
ssh "$HOST" "cd $DEST && export PATH=/opt/homebrew/bin:\$PATH VERBOSE=${VERBOSE:-} && [ -n \"\$VERBOSE\" ] || unset VERBOSE; \
  export CHROMIUM=\"$MAC_CHROME\" && \
  perl -e 'alarm shift; exec @ARGV' ${MAC_TIMEOUT:-300} node --disable-warning=ExperimentalWarning bench/video/$TOOL.ts --out bench/results/local/video/$TOOL.json $*"
