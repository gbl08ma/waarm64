#!/usr/bin/env bash
# bench/video/replay.ts on the Mac host's Chrome for Testing (Google's build: FFmpeg's software decoders, VideoToolbox's
# hardware ones), from a copy in ~/webpc-gpu-bench there (as bench/gpu/sway-mac.sh: Node and playwright-core there;
# nothing else on the host is touched). The capture is copied once.
#   bench/video/replay-mac.sh <capture.vglt> <codec index> <orig.md5> [visible width] [hw|sw]
set -euo pipefail
cd "$(dirname "$0")/../.."
HOST=${MAC_HOST:-macmini.lan}
DEST=webpc-gpu-bench
CAPTURE=$1 MD5=$3
ssh "$HOST" "mkdir -p $DEST/bench/results/local/video $DEST/tools"
rsync -a --delete --exclude results bench/video "$HOST:$DEST/bench/"
rsync -a --delete web "$HOST:$DEST/"
rsync -a tools/nosme.ts "$HOST:$DEST/tools/"
. bench/mac-chrome.sh && mac_chrome "$HOST"   # the current Stable Chrome for Testing there
rsync -a "$CAPTURE" "$HOST:$DEST/bench/results/local/video/capture.vglt"
rsync -a --checksum "$MD5" "$HOST:$DEST/bench/results/local/video/orig.md5"
ssh "$HOST" "cd $DEST && export PATH=/opt/homebrew/bin:\$PATH VERBOSE=${VERBOSE:-} REORDER=${REORDER:-} && [ -n \"\$VERBOSE\" ] || unset VERBOSE; [ -n \"\$REORDER\" ] || unset REORDER; \
  export CHROMIUM=\"$MAC_CHROME\" && \
  perl -e 'alarm shift; exec @ARGV' ${MAC_TIMEOUT:-300} node --disable-warning=ExperimentalWarning bench/video/replay.ts bench/results/local/video/capture.vglt $2 bench/results/local/video/orig.md5 ${4:-} ${5:-}"
