#!/usr/bin/env bash
# bench/snapz/readback.ts on the Mac host's GPU (Chrome for Testing, headless; docs/devenv.md "The Mac host"), from a
# copy in ~/waarm64-snapz-bench there. Arms alternate by rounds, each round a browser of its own: `name=<dir>` serves
# <dir> (a tree's web/, under the repository) as that arm's /web, at arms/<name>/ there (the arms of earlier runs
# deleted). Each round's JSON is moved back, also from a failed run: nothing of a run stays on the Mac (bench/mac-out.sh).
#   [ROUNDS=6] [SAVES=5] [MAC_TIMEOUT=s, 580] bench/snapz/readback-mac.sh <outdir> <name>=<dir>...   -> <outdir>/<name>-<k>.json
set -euo pipefail
cd "$(dirname "$0")/../.."
HOST=${MAC_HOST:-macmini.lan}
DEST=waarm64-snapz-bench
OUT=$1; shift
. bench/mac-out.sh
names=; for a in "$@"; do names+=" ${a%%=*}"; done
ssh "$HOST" "mkdir -p $DEST/bench/snapz $DEST/arms"
mac_bash "$HOST" "cd $DEST/arms && shopt -s nullglob && for d in *; do case \" $names \" in *\" \$d \"*) ;; *) rm -rf -- \"\$d\" ;; esac; done"
rsync -a bench/snapz/readback.ts "$HOST:$DEST/bench/snapz/"
for a in "$@"; do rsync -a --delete "${a#*=}/" "$HOST:$DEST/arms/${a%%=*}/"; done
. bench/mac-packages.sh && mac_packages "$HOST" "$DEST"
. bench/mac-chrome.sh && mac_chrome "$HOST"
trap 'rc=$?; mac_move "$HOST" "$DEST" "$OUT" "bench/results/local/rb-*" 2>/dev/null || true; exit $rc' EXIT
mkdir -p "$OUT"
for k in $(seq 0 $((${ROUNDS:-6} - 1))); do
  for a in "$@"; do
    n=${a%%=*}
    ssh "$HOST" "cd $DEST && export PATH=/opt/homebrew/bin:\$PATH CHROMIUM=\"$MAC_CHROME\" WEB=arms/$n ROUNDS=1 SAVES=${SAVES:-5} && \
      perl -e 'alarm shift; exec @ARGV' ${MAC_TIMEOUT:-580} node --disable-warning=ExperimentalWarning bench/snapz/readback.ts bench/results/local/rb-$n-$k.json" | grep -E '^round|^wrote'
    mac_move "$HOST" "$DEST" "$OUT" "bench/results/local/rb-$n-$k.json"
    mv "$OUT/rb-$n-$k.json" "$OUT/$n-$k.json"
  done
done
