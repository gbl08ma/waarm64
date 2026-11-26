#!/usr/bin/env bash
# bench/video/replay.ts on the Mac host's Chrome for Testing (Google's build: FFmpeg's software decoders, VideoToolbox's
# hardware ones), from a copy in ~/waarm64-gpu-bench.noindex there (as bench/gpu/sway-mac.sh: Node and playwright-core there;
# nothing else on the host is touched). The capture and the hashes are copied to target/replay/ there, the next run's
# over them; the run writes nothing there (its report is its output here).
#   bench/video/replay-mac.sh <capture.vglt> <codec index> <orig.md5> [visible width] [hw|sw]
set -euo pipefail
cd "$(dirname "$0")/../.."
HOST=${MAC_HOST:-macmini.lan}
DEST=waarm64-gpu-bench.noindex
CAPTURE=$1 MD5=$3
ssh "$HOST" "mkdir -p $DEST/target/replay $DEST/tools"
rsync -a --delete --exclude results bench/video "$HOST:$DEST/bench/"
rsync -a --delete web "$HOST:$DEST/"
rsync -a tools/nosme.ts "$HOST:$DEST/tools/"
. bench/mac-chrome.sh && mac_chrome "$HOST"   # the current Stable Chrome for Testing there
rsync -a "$CAPTURE" "$HOST:$DEST/target/replay/capture.vglt"
rsync -a --checksum "$MD5" "$HOST:$DEST/target/replay/orig.md5"
ssh "$HOST" "cd $DEST && export PATH=/opt/homebrew/bin:\$PATH VERBOSE=${VERBOSE:-} REORDER=${REORDER:-} && [ -n \"\$VERBOSE\" ] || unset VERBOSE; [ -n \"\$REORDER\" ] || unset REORDER; \
  export CHROMIUM=\"$MAC_CHROME\" && \
  perl -e 'alarm shift; exec @ARGV' ${MAC_TIMEOUT:-300} node --disable-warning=ExperimentalWarning bench/video/replay.ts target/replay/capture.vglt $2 target/replay/orig.md5 ${4:-} ${5:-}"
