#!/usr/bin/env bash
# G3's real-GPU numbers (the G3 kickoff's decision 4): bench/gpu/sway-load.ts on the Mac host's Chromium (Playwright's
# Chromium, headless, temporary profile) with its GPU, from a copy of what the page needs in ~/webpc-gpu-bench there
# (as run-mac.sh: Node and playwright-core there; nothing else on the host is touched). The disk image is copied once.
#   bench/gpu/sway-mac.sh <virgl|pixman|llvmpipe> <image.qcow2> <name>   -> bench/results/local/<name>/ (VIRGL_GPU as sway-load.ts)
# SCRIPT=firefox-load.ts runs the Firefox harness instead (PHASES, WARM_S, TIMELINE_ALL, QUERY, CHROMIUM_JS_FLAGS passed on), SCRIPT=../audio/avsync.ts the
# A/V sync one (CLIPS, PHASE_S, MEDIA, PROFILE, SYSCALLS, TIMELINE, DEBUG (DEBUG=pw:browser logs Chromium's output, e.g. CHROMIUM_ARGS=--js-flags=--trace-gc), FF_PREFS, VARIANTS, ROUNDS, NCPUS passed on; CHROMIUM_ARGS=--mute-audio keeps the Mac's speakers quiet), SCRIPT=../video/v1.ts
# video V1's check (mode `-`: the script takes none; FRAMES, CLIPS, SHIM, CAPTURE passed on; the media disk, target/video/media.ext4, is
# copied when it exists); the host's `vm_stat 1` over the run, each line after its epoch second (<name>.vmstat: the
# Mac's memory is overcommitted by the Lima VMs, and swap-ins and decompressions stall Chromium's threads); HEADED=1 opens a visible window on the Mac (the user allows it there, when they aren't using it).
set -euo pipefail
cd "$(dirname "$0")/../.."
HOST=${MAC_HOST:-macmini.lan}
DEST=webpc-gpu-bench
MODE=$1 IMAGE=$2 NAME=$3
ssh "$HOST" "mkdir -p $DEST/bench/results/local $DEST/target/images/debian $DEST/target/wasm32-unknown-unknown/release $DEST/node_modules/@xterm"
rsync -a --delete --exclude results bench/gpu bench/audio bench/video "$HOST:$DEST/bench/"
rsync -a --delete web "$HOST:$DEST/"
rsync -a tools/serve.ts tools/tailscale.ts tools/nosme.ts "$HOST:$DEST/tools/"
rsync -a package.json "$HOST:$DEST/"
rsync -a node_modules/@xterm/ "$HOST:$DEST/node_modules/@xterm/"
rsync -a target/wasm32-unknown-unknown/release/webpc_core.wasm "$HOST:$DEST/target/wasm32-unknown-unknown/release/"
rsync -a target/images/edk2 "$HOST:$DEST/target/images/"
rsync -a target/images/debian/disk.qcow2 "$HOST:$DEST/target/images/debian/"   # the page's own machine, which starts first
rsync -a "$IMAGE" "$HOST:$DEST/bench/results/local/disk.qcow2"
if [ -f target/video/media.ext4 ]; then   # the clips (bench/video/media-disk.sh)
  ssh "$HOST" "mkdir -p $DEST/target/video" && rsync -a target/video/media.ext4 "$HOST:$DEST/target/video/"
fi
[ "$MODE" = - ] && MODE=
if [ -f target/ffpages/pages.ext4 ]; then   # firefox-load.ts's real pages (bench/gpu/firefox-pages.sh)
  ssh "$HOST" "mkdir -p $DEST/target/ffpages" && rsync -a target/ffpages/pages.ext4 "$HOST:$DEST/target/ffpages/"
fi
rc=0
ssh "$HOST" "cd $DEST && export PATH=/opt/homebrew/bin:\$PATH WEBPC_TAILSCALE=0 VIRGL_GPU=${VIRGL_GPU:-virgl-null} PHASES=${PHASES:-} WARM_S=${WARM_S:-30} HEADED=${HEADED:-} CLIPS=${CLIPS:-} FRAMES=${FRAMES:-} PHASE_S=${PHASE_S:-} MEDIA=${MEDIA:-} PROFILE=${PROFILE:-} SYSCALLS=${SYSCALLS:-} TIMELINE=${TIMELINE:-} DEBUG=${DEBUG:-} FF_PREFS='${FF_PREFS:-}' VARIANTS='${VARIANTS:-}' ROUNDS=${ROUNDS:-1} NCPUS=${NCPUS:-4} SHIM=${SHIM:-} CAPTURE=${CAPTURE:-} CHROMIUM_ARGS='${CHROMIUM_ARGS:-}' CHROMIUM_JS_FLAGS='${CHROMIUM_JS_FLAGS:-}' TIMELINE_ALL=${TIMELINE_ALL:-} QUERY='${QUERY:-}' && [ -n \"\$SHIM\" ] || unset SHIM; [ -n \"\$CAPTURE\" ] || unset CAPTURE; [ -n \"\$PHASES\" ] || unset PHASES; [ -n \"\$CLIPS\" ] || unset CLIPS; [ -n \"\$FRAMES\" ] || unset FRAMES; [ -n \"\$PHASE_S\" ] || unset PHASE_S; [ -n \"\$MEDIA\" ] || unset MEDIA; [ -n \"\$PROFILE\" ] || unset PROFILE; [ -n \"\$SYSCALLS\" ] || unset SYSCALLS; [ -n \"\$TIMELINE\" ] || unset TIMELINE; [ -n \"\$DEBUG\" ] || unset DEBUG; [ -n \"\$FF_PREFS\" ] || unset FF_PREFS; [ -n \"\$VARIANTS\" ] || unset VARIANTS; [ -n \"\$HEADED\" ] || unset HEADED; \
  export CHROMIUM=\"\$(ls -d \$HOME/Library/Caches/ms-playwright/chromium-*/chrome-mac-arm64/*.app | sort | tail -1)/Contents/MacOS/Google Chrome for Testing\" && \
  rm -rf bench/results/local/$NAME && { vm_stat 1 | perl -ne '\$|=1; print time(), \" \", \$_' > bench/results/local/$NAME.vmstat & } && perl -e 'alarm shift; exec @ARGV' ${MAC_TIMEOUT:-500} node --disable-warning=ExperimentalWarning bench/gpu/${SCRIPT:-sway-load.ts} $MODE bench/results/local/disk.qcow2 bench/results/local/$NAME > bench/results/local/$NAME.log 2>&1; \
  rc=\$?; sw_vers -productVersion > bench/results/local/$NAME.macos; pkill -x vm_stat; sysctl vm.swapusage >> bench/results/local/$NAME.vmstat; system_profiler SPDisplaysDataType | grep -E 'Chipset|Metal|Cores' > bench/results/local/$NAME.gpu; exit \$rc" || rc=$?
mkdir -p bench/results/local
rsync -a "$HOST:$DEST/bench/results/local/$NAME" "$HOST:$DEST/bench/results/local/$NAME.*" bench/results/local/
exit $rc
