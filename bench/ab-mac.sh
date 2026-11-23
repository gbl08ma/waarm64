#!/usr/bin/env bash
# A paired A/B of core builds on the Mac host's Chrome, with a stopping rule and a verdict (bench/ab.ts;
# docs/benchmarking.md "The paired A/B"): the one command for a JIT or core change's screen.
#   bench/ab-mac.sh <outdir> <base>=<core.wasm> <arm>=<core.wasm>[@<tree>][?<query>]...
# The first arm is the base; an A/A arm (`aa`, the base again) is added. `@<tree>`: the arm's host code from another
# checkout (a core of another ABI, e.g. `../waarm64-base`; its target/ must be this one's, a symlink). Options, as
# variables: WORKLOADS (default `user`; `user,boot`), MIN, CAP (pairs: 4, 24), BAND (0.5, percent), OVERALL (0.01),
# STOP (`cycles,wall`), WARM (`same`), ROUNDS (1), BUDGET (1500: seconds, after which the workload ends at its pair).
# Into <outdir>/: ab.json (every sample), verdict.txt (printed too), log.txt. Bounded on the Mac (the budget and
# 400 s) and here; takes the machine's CI lock exclusive (the dev VM shares the Mac's cores: never beside
# scripts/ci*.sh or another Mac run) and runs bench/gpu/mac-leftovers.sh --kill at its end. Run it in the background.
set -euo pipefail
cd "$(dirname "$0")/.."
repo=$PWD
out=$(realpath -m "$1"); shift
[[ $# -ge 1 ]] || { echo "usage: $0 <outdir> <base>=<core.wasm> [<arm>=<core.wasm>[@<tree>][?<query>]...]" >&2; exit 2; }
source scripts/ci-lock.sh; ci_lock exclusive
HOST=${MAC_HOST:-macmini.lan}
DEST=waarm64-bench
CORE=target/wasm32-unknown-unknown/release
budget=${BUDGET:-1500}
mkdir -p "$out"

# A tree's host code, bench pages and packages at <dest> there; the images, from this tree's target/, once (another
# tree's are hard links to them).
sync_tree() { # <tree> <dest>
  local tree=$1 dest=$2
  ssh "$HOST" "mkdir -p $dest/bench $dest/tools $dest/$CORE $dest/target/images $dest/target/bench $dest/target/ab"
  (cd "$tree" && rsync -a --delete --exclude results --exclude memory bench/boot bench/interp bench/spike bench/mac bench/run.ts bench/stats.ts "$HOST:$dest/bench/" &&
    . "$repo/bench/mac-packages.sh" && mac_packages "$HOST" "$dest" && rsync -a --delete web "$HOST:$dest/")
  rsync -a bench/ab.ts bench/stats.ts bench/procstat.ts "$HOST:$dest/bench/"
  rsync -a bench/boot/pair.html bench/boot/pair-page.ts bench/boot/pair.ts "$HOST:$dest/bench/boot/"
  local link=()
  [[ $dest == "$DEST" ]] || link=(--link-dest="$home/$DEST/target/images/")
  rsync -a "${link[@]}" target/images/alpine target/images/alpine-user "$HOST:$dest/target/images/"
  rsync -a "${link[@]}" --exclude '*defconfig' --exclude 'System.map' target/images/linux target/images/buildroot "$HOST:$dest/target/images/"
}

home=$(ssh "$HOST" 'echo $HOME')
sync_tree "$repo" "$DEST"
ssh "$HOST" "cd $DEST && { [ procstat -nt bench/mac/procstat.c ] || cc -O2 -Wall -o procstat bench/mac/procstat.c; }"
. bench/mac-chrome.sh && mac_chrome "$HOST"
args=() synced=" "
for arm in "$@"; do
  name=${arm%%=*} rest=${arm#*=} query= tree=$repo dest=$DEST
  case $rest in *\?*) query="?${rest#*\?}" rest=${rest%%\?*} ;; esac
  case $rest in *@*) tree=$(realpath "${rest#*@}") rest=${rest%%@*} ;; esac
  if [[ $tree != "$repo" ]]; then
    dest=$DEST-$(basename "$tree")
    [[ $synced == *" $dest "* ]] || { sync_tree "$tree" "$dest"; synced+="$dest "; }
  fi
  rsync -a "$rest" "$HOST:$dest/target/ab/$name.wasm"
  # bench/boot/suite.ts's `images` fetches the tree's default core too: the arm's, so that it exists.
  ssh "$HOST" "cd $dest && cp target/ab/$name.wasm $CORE/waarm64_core.wasm"
  args+=("$name=$home/$dest/target/ab/$name.wasm@$home/$dest$query")
done
code=0
timeout $((budget + 500)) ssh "$HOST" "cd $DEST && export PATH=/opt/homebrew/bin:\$PATH WAARM64_TAILSCALE=0 && \
  export CHROMIUM=\"$MAC_CHROME\" && rm -rf bench/results/local/ab-run && \
  perl -e 'alarm shift; exec @ARGV' $((budget + 400)) node --disable-warning=ExperimentalWarning bench/ab.ts --out bench/results/local/ab-run \
    --workloads ${WORKLOADS:-user} --min ${MIN:-4} --cap ${CAP:-24} --band ${BAND:-0.5} --overall ${OVERALL:-0.01} --stop ${STOP:-cycles,wall} --budget $budget --warm ${WARM:-same} --rounds ${ROUNDS:-1} \
    $(printf "'%s' " "${args[@]}")" 2> "$out/log.txt" || code=$?
rsync -a "$HOST:$DEST/bench/results/local/ab-run/" "$out/" || true
[[ $code -eq 0 ]] || { echo "the run failed (exit $code); the end of $out/log.txt:"; tail -5 "$out/log.txt"; }
timeout 60 bench/gpu/mac-leftovers.sh --kill 2>&1 | tail -1
exit $code
