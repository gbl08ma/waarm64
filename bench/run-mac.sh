#!/usr/bin/env bash
# The boot and small-guest benchmarks (and bench/vulkan's pages) on the Mac host's Chromium (Playwright's Chrome for Testing,
# headless, temporary profile): macOS has V8's wasm trap handler, so its numbers are without the
# explicit bounds checks this Linux arm64 VM's carry (docs/v8.md "Bounds checks"). The pages, the
# wasm core and the Alpine images are copied to ~/waarm64-bench.noindex there (~600 MB), the packages installed there; it
# needs Node, npm and the Chromium that Playwright installed. Nothing else on the host is touched.
#   [WASM=core.wasm] [MAC_TIMEOUT=s, the Mac side's bound, 580] bench/run-mac.sh <name> [bench/run.ts args]   -> bench/results/local/mac/<name>.json
# The JSON is moved back (nothing of a run stays on the Mac: bench/mac-out.sh), and a --profile=<dir>'s profiles that
# run.ts left there (it removes them unless it was ended) deleted, also after a failed run.
# e.g. bench/run-mac.sh user-default --page bench/boot/index.html --only alpine_user_jit
#      bench/run-mac.sh io-profile --page bench/io/index.html --input target/bench/io-raw.img --only io --profile=target/bench-profiles
set -euo pipefail
cd "$(dirname "$0")/.."
name=$1; shift
HOST=${MAC_HOST:-macmini.lan}
DEST=waarm64-bench.noindex
CORE=target/wasm32-unknown-unknown/release
ssh "$HOST" "mkdir -p $DEST/bench $DEST/tools $DEST/$CORE $DEST/target/images $DEST/target/bench"
rsync -a --delete --exclude results --exclude memory bench/boot bench/interp bench/io bench/spike bench/vulkan bench/mac bench/run.ts bench/stats.ts bench/procstat.ts "$HOST:$DEST/bench/"
# The counters' helper (bench/procstat.ts: instructions, cycles and CPU time of the browser's processes), built there.
ssh "$HOST" "cd $DEST && { [ procstat -nt bench/mac/procstat.c ] || cc -O2 -Wall -o procstat bench/mac/procstat.c; }"
# The dev server (Vite: tools/serve.ts) and the packages, installed there (bench/mac-packages.sh).
. bench/mac-packages.sh && mac_packages "$HOST" "$DEST"
. bench/mac-chrome.sh && mac_chrome "$HOST"   # the current Stable Chrome for Testing there
rsync -a --delete web "$HOST:$DEST/"
rsync -a "${WASM:-$CORE/waarm64_core.wasm}" "$HOST:$DEST/$CORE/waarm64_core.wasm"
rsync -a target/images/alpine target/images/alpine-user "$HOST:$DEST/target/images/"
rsync -a --exclude '*defconfig' --exclude 'System.map' target/images/linux target/images/buildroot "$HOST:$DEST/target/images/"
rsync -a target/bench/coremark.bin target/bench/coremark-linux "$HOST:$DEST/target/bench/"
# A page's chosen file (bench/io's `--input target/bench/…`), at the same path there.
prev= profiles=()
for a in "$@"; do
  case $prev in --input) rsync -a "$a" "$HOST:$DEST/$a" ;; --profile) profiles+=("$a/profile-*") ;; esac
  case $a in --input=*) rsync -a "${a#--input=}" "$HOST:$DEST/${a#--input=}" ;; --profile=*) profiles+=("${a#--profile=}/profile-*") ;; esac
  prev=$a
done
. bench/mac-out.sh
trap 'rc=$?; mac_move "$HOST" "$DEST" "$(dirname "bench/results/local/mac/$name")" "bench/results/local/$name.json" || { m=$?; [ $rc -ne 0 ] || rc=$m; }; mac_rm "$HOST" "$DEST" "${profiles[@]}" || true; exit $rc' EXIT
ssh "$HOST" "cd $DEST && export PATH=/opt/homebrew/bin:\$PATH WAARM64_TAILSCALE=0 && \
  export CHROMIUM=\"$MAC_CHROME\" && \
  perl -e 'alarm shift; exec @ARGV' ${MAC_TIMEOUT:-580} node --disable-warning=ExperimentalWarning bench/run.ts --out bench/results/local/$name.json $*"
