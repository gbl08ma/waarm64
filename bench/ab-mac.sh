#!/usr/bin/env bash
# A paired A/B of core builds on the Mac host's Chrome, with a stopping rule and a verdict (bench/ab.ts;
# docs/benchmarking.md "The paired A/B"): the one command for a JIT or core change's screen.
#   bench/ab-mac.sh <outdir> <base>=<core.wasm> <arm>=<core.wasm>[@<tree>][?<query>]...
# The first arm is the base. AA=1 adds an A/A arm (`aa`, the base again: what the same core against itself gives at
# this moment, to hold a result against; with the base alone, an A/A run). `@<tree>`: the arm's host code from another
# checkout (a core of another ABI, e.g. `../waarm64-base`; its target/ must be this one's, a symlink). Options, as
# variables: WORKLOADS (default `node`; `user`, `boot`, several with commas), MIN, CAP (pairs: 4, 24), BAND (0.5, percent), OVERALL (0.01),
# STOP (`cycles,wall`), WARM (`same`), ROUNDS (1), BUDGET (1500: seconds for the whole run, after which a workload
# ends at its pair and the ones after it aren't run).
# Into <outdir>/: ab.json (every sample), verdict.txt (printed too), log.txt. Bounded on the Mac (the budget and
# 400 s) and here; takes the machine's CI lock exclusive (the dev VM shares the Mac's cores: never beside
# scripts/ci*.sh or another Mac run) and runs bench/gpu/mac-leftovers.sh --kill at its end. Run it in the background.
set -euo pipefail
from=$PWD # <outdir>, the cores and the trees are relative to where the command was run
cd "$(dirname "$0")/.."
repo=$PWD
out=$(cd "$from" && realpath -m "$1"); shift
[[ $# -ge 1 ]] || { echo "usage: [AA=1] $0 <outdir> <base>=<core.wasm> [<arm>=<core.wasm>[@<tree>][?<query>]...]" >&2; exit 2; }
source scripts/ci-lock.sh; ci_lock exclusive
trap '' PIPE HUP # a reader that went away doesn't end the run or lose its results
HOST=${MAC_HOST:-macmini.lan}
DEST=waarm64-bench
# A host that went away ends a copy or a command within a minute, not never (the CI lock is held meanwhile).
export RSYNC_RSH='ssh -o ConnectTimeout=10 -o ServerAliveInterval=15 -o ServerAliveCountMax=4'
ssh() { command ssh -o ConnectTimeout=10 -o ServerAliveInterval=15 -o ServerAliveCountMax=4 "$@"; }
CORE=target/wasm32-unknown-unknown/release
budget=${BUDGET:-1500}
mkdir -p "$out"
rm -f "$out/ab.json" "$out/verdict.txt" "$out/log.txt" # an earlier run's verdict doesn't stand beside this one's log

# A tree's host code, bench pages and packages at <dest> there; the images, from this tree's target/, once (another
# tree's are hard links to them).
sync_tree() { # <tree> <dest>
  local tree=$1 dest=$2
  ssh "$HOST" "mkdir -p $dest/bench $dest/tools $dest/$CORE $dest/target/images $dest/target/bench $dest/target/ab"
  (cd "$tree" && rsync -a --delete --ignore-missing-args --exclude results --exclude memory bench/boot bench/interp bench/spike bench/mac bench/run.ts bench/stats.ts "$HOST:$dest/bench/" &&
    . "$repo/bench/mac-packages.sh" && mac_packages "$HOST" "$dest" && rsync -a --delete web "$HOST:$dest/")
  rsync -a bench/ab.ts bench/stats.ts bench/procstat.ts "$HOST:$dest/bench/"
  rsync -a bench/boot/pair.html bench/boot/pair-page.ts bench/boot/pair.ts "$HOST:$dest/bench/boot/"
  local link=()
  [[ $dest == "$DEST" ]] || link=(--link-dest="$home/$DEST/target/images/")
  rsync -a "${link[@]}" target/images/alpine target/images/alpine-user target/images/alpine-node "$HOST:$dest/target/images/"
  rsync -a "${link[@]}" --exclude '*defconfig' --exclude 'System.map' target/images/linux target/images/buildroot "$HOST:$dest/target/images/"
}

home=$(ssh "$HOST" 'echo $HOME')
sync_tree "$repo" "$DEST"
ssh "$HOST" "cd $DEST && { [ procstat -nt bench/mac/procstat.c ] || cc -O2 -Wall -o procstat bench/mac/procstat.c; }"
. bench/mac-chrome.sh && mac_chrome "$HOST"
args=() synced=" "
for arm in "$@"; do
  name=${arm%%=*} rest=${arm#*=} query= tree=$repo dest=$DEST
  [[ $name =~ ^[A-Za-z0-9_.-]+$ && $arm == *=* ]] || { echo "arm \"$arm\": <name>=<core.wasm>[@<tree>][?<query>], the name of letters, digits, _ . -" >&2; exit 2; }
  case $rest in *\?*) query="?${rest#*\?}" rest=${rest%%\?*} ;; esac
  case $rest in *@*) tree=$(cd "$from" && realpath "${rest#*@}") rest=${rest%%@*} ;; esac
  rest=$(cd "$from" && realpath "$rest")
  if [[ $tree != "$repo" ]]; then
    dest=$DEST-$(basename "$tree")
    [[ $synced == *" $dest "* ]] || { sync_tree "$tree" "$dest"; synced+="$dest "; }
  fi
  rsync -a "$rest" "$HOST:$dest/target/ab/$name.wasm"
  # bench/boot/suite.ts's `images` fetches the tree's default core too: the arm's, so that it exists.
  ssh "$HOST" "cd $dest && cp target/ab/$name.wasm $CORE/waarm64_core.wasm"
  args+=("$name=$home/$dest/target/ab/$name.wasm@$home/$dest$query")
done
aa=; [[ ${AA:-0} == 0 ]] || aa=--aa
code=0
timeout $((budget + 500)) ssh "$HOST" "cd $DEST && export PATH=/opt/homebrew/bin:\$PATH WAARM64_TAILSCALE=0 && \
  export CHROMIUM=\"$MAC_CHROME\" && rm -rf bench/results/local/ab-run && \
  perl -e 'alarm shift; exec @ARGV' $((budget + 400)) node --disable-warning=ExperimentalWarning bench/ab.ts --out bench/results/local/ab-run \
    --workloads ${WORKLOADS:-node} --min ${MIN:-4} --cap ${CAP:-24} --band ${BAND:-0.5} --overall ${OVERALL:-0.01} --stop ${STOP:-cycles,wall} --budget $budget --warm ${WARM:-same} --rounds ${ROUNDS:-1} $aa \
    $(printf "'%s' " "${args[@]}")" > /dev/null 2> "$out/log.txt" || code=$?
# The results first, then the verdict from its file: whoever reads this script's output may be gone by now.
rsync -a "$HOST:$DEST/bench/results/local/ab-run/" "$out/" || true
# Nothing below may end the script before its clean-up and its own exit code: a reader gone, leftovers found.
cat "$out/verdict.txt" 2> /dev/null || true
[[ $code -eq 0 ]] || { echo "the run failed (exit $code); the end of $out/log.txt:"; tail -5 "$out/log.txt"; } || true
{ timeout 60 bench/gpu/mac-leftovers.sh --kill 2>&1 | tail -1; } || true
exit $code
