#!/bin/bash
# The warm snapshots for snapshot-started sessions (docs/benchmarking.md "Starting from a snapshot"; dev-only):
#   bench/gpu/warm-snapshots.sh <firefox|debian|all> [dir=target/snapbench]
# firefox: Arch Linux ARM's desktop disk booted, sway up, Firefox started (bench/gpu/firefox-load.ts SAVE_SNAPSHOTS):
#   <dir>/pages.waarm64snap (Firefox on a still page) and <dir>/webgl.waarm64snap (Firefox on the WebGL cubes), ~780 MB each.
# debian: Debian booted and logged in on the serial console with the Go tree as its second disk (bench/stress/stress.ts
#   --save-snapshot): <dir>/debian-go.waarm64snap, for the `go build` loop.
# Each file has a sidecar <file>.json (the core's SHA-256, the commit). Playwright's downloads go through <dir>/tmp
# (WAARM64_DOWNLOADS, the browser's downloadsPath), not /tmp (RAM on the dev VM; TMPDIR there makes Chromium's socket path too long). CORE=<file.wasm> saves with that core. Runs alone, like any Chromium session.
set -u
cd "$(dirname "$0")/../.."
what=${1:-all} dir=${2:-target/snapbench}
mkdir -p "$dir/tmp"
export WAARM64_DOWNLOADS=$(realpath "$dir/tmp")
cap() { systemd-run --user --scope -q -p MemoryMax=10G -p MemorySwapMax=0 -- timeout "$@"; }
log=bench/results/local/snapbench-make
mkdir -p "$log"
if [ "$what" = firefox ] || [ "$what" = all ]; then
  t0=$(date +%s)
  SAVE_SNAPSHOTS=$dir WAARM64_GUEST_USER=${WAARM64_GUEST_USER:-alarm} cap 900 node bench/gpu/firefox-load.ts virgl "${IMAGE:-target/archarm/desktop.qcow2}" "$log/firefox" > "$log/firefox.log" 2>&1
  echo "firefox: exit $? in $(( $(date +%s) - t0 )) s"
fi
if [ "$what" = debian ] || [ "$what" = all ]; then
  t0=$(date +%s)
  cap 600 node bench/stress/stress.ts --ncpus 4 --no-load --disk2 target/images/stress/goroot.ext4 ${CORE:+--core "$CORE"} --save-snapshot "$dir/debian-go.waarm64snap" --out "$log/debian.jsonl" > "$log/debian.log" 2>&1
  echo "debian: exit $? in $(( $(date +%s) - t0 )) s"
fi
rm -rf "$dir/tmp"
ls -la "$dir"
