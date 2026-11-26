#!/usr/bin/env bash
# bench/snapz/probe.ts on the Mac host's GPU (Chrome for Testing, headless; docs/devenv.md "The Mac host"), from a copy
# in ~/waarm64-snapz-bench there, its disks, firmware and the warm snapshot those bench/gpu/sway-mac.sh left in
# ~/waarm64-gpu-bench (hard-linked, not copied). Arms alternate by rounds, each round a browser of its own (ROUNDS=1): an
# arm `name=<dir>` is that tree's web/ (under the repository), copied over the copy's web/ before its round. No
# memory there (no /proc). The warm snapshot's caps are SwiftShader's, so a 3D machine loads it with 3D off there (the
# GPU worker still starts): its load's start is measured, not a 3D state.
#   [OPS=load] [SETTLE_S=20] [ROUNDS=3] [MAC_TIMEOUT=s, 420] bench/snapz/probe-mac.sh <outdir> <name>=<dir>...  -> <outdir>/<name>-<k>.json
set -euo pipefail
cd "$(dirname "$0")/../.."
HOST=${MAC_HOST:-macmini.lan}
DEST=waarm64-snapz-bench
GPU=waarm64-gpu-bench
OUT=$1; shift
# Hard links (the dev server serves no symlink out of its root): the disks are bases, never written (overlays in OPFS).
ssh "$HOST" "cd $DEST && mkdir -p bench/snapz tests target/wasm32-unknown-unknown/release target/images/edk2 target/snapbench target/archarm target/ffpages && \
  ln -f ~/$GPU/target/archarm/desktop.qcow2 target/archarm/ && ln -f ~/$GPU/target/ffpages/pages.ext4 target/ffpages/ && \
  ln -f ~/$GPU/target/images/edk2/* target/images/edk2/ && ln -f ~/$GPU/bench/results/local/pages.waarm64snap target/snapbench/"
rsync -a bench/snapz/probe.ts "$HOST:$DEST/bench/snapz/"
rsync -a bench/snapshot-start.ts "$HOST:$DEST/bench/"
rsync -a tests/page-ask.ts tests/debian-unattended.ts tests/words.ts "$HOST:$DEST/tests/"
rsync -a target/wasm32-unknown-unknown/release/waarm64_core.wasm "$HOST:$DEST/target/wasm32-unknown-unknown/release/"
. bench/mac-packages.sh && mac_packages "$HOST" "$DEST"
. bench/mac-chrome.sh && mac_chrome "$HOST"
mkdir -p "$OUT"
for k in $(seq 0 $((${ROUNDS:-3} - 1))); do
  for a in "$@"; do
    n=${a%%=*}
    rsync -a --delete "${a#*=}/" "$HOST:$DEST/web/"
    ssh "$HOST" "cd $DEST && export PATH=/opt/homebrew/bin:\$PATH CHROMIUM=\"$MAC_CHROME\" WAARM64_PROFILE=target/snapz/profile WAARM64_DOWNLOADS=target/snapz/downloads \
      ROUNDS=1 OPS=${OPS:-load} SETTLE_S=${SETTLE_S:-20} WAARM64_PORT=8231 && \
      perl -e 'alarm shift; exec @ARGV' ${MAC_TIMEOUT:-420} node --disable-warning=ExperimentalWarning bench/snapz/probe.ts desktop bench/results/local/probe-$n-$k.json > bench/results/local/probe-$n-$k.log 2>&1; \
      echo \"$n $k rc=\$?\"; grep -E '^round|Error' bench/results/local/probe-$n-$k.log | cut -c1-220"
    rsync -a "$HOST:$DEST/bench/results/local/probe-$n-$k.json" "$HOST:$DEST/bench/results/local/probe-$n-$k.log" "$OUT/" 2>/dev/null || true
  done
done
