#!/usr/bin/env bash
# bench/snapz/probe.ts on the Mac host's GPU (Chrome for Testing, headless; docs/devenv.md "The Mac host"), from a copy
# in ~/waarm64-snapz-bench there: the desktop guest's disks and firmware and the warm snapshot (SNAPSHOT, default
# target/snapbench/pages.waarm64snap: bench/gpu/warm-snapshots.sh firefox), each at its fixed path there (hard links to
# bench/gpu/sway-mac.sh's copies in ~/waarm64-gpu-bench when those are the same files, copies otherwise). Arms alternate
# by rounds, each round a browser of its own (ROUNDS=1): an arm `name=<dir>` is that tree's web/ (under the
# repository), copied over the copy's web/ before its round. No memory there (no /proc). The warm snapshot's caps are
# SwiftShader's, so a 3D machine loads it with 3D off there (the GPU worker still starts): its load's start is
# measured, not a 3D state. Each round's JSON and log are moved back into <outdir>; the probe's saves (downloads) are
# deleted after each round, its profile and copies (target/snapz there) at the end, also of a failed run: nothing of a
# run stays on the Mac (bench/mac-out.sh).
#   [OPS=load] [SETTLE_S=20] [ROUNDS=3] [MAC_TIMEOUT=s, 420] [SNAPSHOT=file] bench/snapz/probe-mac.sh <outdir> <name>=<dir>...
#     -> <outdir>/probe-<name>-<k>.json and .log
set -euo pipefail
cd "$(dirname "$0")/../.."
HOST=${MAC_HOST:-macmini.lan}
DEST=waarm64-snapz-bench
GPU=waarm64-gpu-bench
OUT=$1; shift
SNAPSHOT=${SNAPSHOT:-target/snapbench/pages.waarm64snap}
home=$(ssh "$HOST" 'echo $HOME')
ssh "$HOST" "mkdir -p $DEST && cd $DEST && mkdir -p bench/snapz bench/results/local tests target/wasm32-unknown-unknown/release target/images/edk2 target/snapbench target/archarm target/ffpages"
# The disks are bases, never written (overlays in OPFS): hard links to the same files in ~/$GPU (rsync writes a new
# file and renames it, so neither copy's update changes the other). Hard links, not symlinks: the dev server serves
# no symlink out of its root.
rsync -a --link-dest="$home/$GPU/target/archarm/" target/archarm/desktop.qcow2 "$HOST:$DEST/target/archarm/"
rsync -a --link-dest="$home/$GPU/target/ffpages/" target/ffpages/pages.ext4 "$HOST:$DEST/target/ffpages/"
rsync -a --link-dest="$home/$GPU/target/images/edk2/" target/images/edk2/ "$HOST:$DEST/target/images/edk2/"
# The snapshot likewise, when it's the one sway-mac.sh's FROM_SNAPSHOT last copied there.
rsync -a --link-dest="$home/$GPU/target/in/snapshot/" "$SNAPSHOT" "$HOST:$DEST/target/snapbench/pages.waarm64snap"
rsync -a bench/snapz/probe.ts "$HOST:$DEST/bench/snapz/"
rsync -a bench/snapshot-start.ts "$HOST:$DEST/bench/"
rsync -a tests/page-ask.ts tests/debian-unattended.ts tests/words.ts "$HOST:$DEST/tests/"
rsync -a target/wasm32-unknown-unknown/release/waarm64_core.wasm "$HOST:$DEST/target/wasm32-unknown-unknown/release/"
. bench/mac-packages.sh && mac_packages "$HOST" "$DEST"
. bench/mac-chrome.sh && mac_chrome "$HOST"
. bench/mac-out.sh
trap 'rc=$?; mac_move "$HOST" "$DEST" "$OUT" "bench/results/local/probe-*" 2>/dev/null || true; mac_rm "$HOST" "$DEST" target/snapz || true; exit $rc' EXIT
mkdir -p "$OUT"
for k in $(seq 0 $((${ROUNDS:-3} - 1))); do
  for a in "$@"; do
    n=${a%%=*}
    rsync -a --delete "${a#*=}/" "$HOST:$DEST/web/"
    ssh "$HOST" "cd $DEST && export PATH=/opt/homebrew/bin:\$PATH CHROMIUM=\"$MAC_CHROME\" WAARM64_PROFILE=target/snapz/profile WAARM64_DOWNLOADS=target/snapz/downloads \
      ROUNDS=1 OPS=${OPS:-load} SETTLE_S=${SETTLE_S:-20} WAARM64_PORT=8231 && \
      perl -e 'alarm shift; exec @ARGV' ${MAC_TIMEOUT:-420} node --disable-warning=ExperimentalWarning bench/snapz/probe.ts desktop bench/results/local/probe-$n-$k.json > bench/results/local/probe-$n-$k.log 2>&1; \
      echo \"$n $k rc=\$?\"; grep -E '^round|Error' bench/results/local/probe-$n-$k.log | cut -c1-220"
    mac_move "$HOST" "$DEST" "$OUT" "bench/results/local/probe-$n-$k.json" "bench/results/local/probe-$n-$k.log" 2>/dev/null || true
    mac_rm "$HOST" "$DEST" target/snapz/downloads
  done
done
