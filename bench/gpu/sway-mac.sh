#!/usr/bin/env bash
# G3's real-GPU numbers (the G3 kickoff's decision 4): bench/gpu/sway-load.ts on the Mac host's Chromium (Playwright's
# Chromium, headless, temporary profile) with its GPU, from a copy of what the page needs in ~/webpc-gpu-bench there
# (as run-mac.sh: Node and playwright-core there; nothing else on the host is touched). The disk image is copied once.
#   bench/gpu/sway-mac.sh <virgl|pixman|llvmpipe> <image.qcow2> <name>   -> bench/results/local/<name>/ (VIRGL_GPU as sway-load.ts)
# SCRIPT=firefox-load.ts runs the Firefox harness instead (PHASES, PAGES, WARM_S, TIMELINE_ALL, PROFILE, SYSCALLS, QUERY, CHROMIUM_JS_FLAGS passed on), SCRIPT=../audio/avsync.ts the
# A/V sync one (CLIPS, PHASE_S, MEDIA, MPV_ARGS, MPV_VARIANTS, SHIM, PROFILE, SYSCALLS, TIMELINE, DEBUG (DEBUG=pw:browser logs Chromium's output, e.g. CHROMIUM_ARGS=--js-flags=--trace-gc), FF_PREFS, VARIANTS, ROUNDS, NCPUS passed on; CHROMIUM_ARGS=--mute-audio keeps the Mac's speakers quiet), SCRIPT=../video/v1.ts
# video V1's check (mode `-`: the script takes none; FRAMES, CLIPS, SHIM, CAPTURE passed on; the media disk, target/video/media.ext4, is
# copied when it exists), SCRIPT=../vulkan/venus-run.ts Debian with Vulkan (mode `-`, the image images/debian-vulkan/build.sh's; REPLAY, GPU_KNOBS and WEBPC_PROFILE (a profile directory kept there, relative to its copy) passed on, and images/vkframes/build.sh's disk copied), SCRIPT=../vulkan/apps-load.ts VK1's gate's programs (mode `-`; GPU_KNOBS and SCREEN passed on), SCRIPT=../vulkan/share.ts VK2 L4's sharing candidates (mode `-`; ROUNDS, FORMAT passed on), SCRIPT=../vulkan/present.ts VK3 L1's presentation check (mode `-`, the desktop guest; WAYS, GPU_KNOBS, SCREEN, SHIM passed on), SCRIPT=../vulkan/guest.ts VK0's arm 4 (mode lavapipe|virgl|venus, the image target/vulkan/guest.qcow2 or, for venus, the desktop guest; FISH, TOOLKIT, MSAA, WARMUP, SAMPLES, FRAMES passed on), SCRIPT=deqp-run.ts dEQP (mode gles2|gles3, the image target/deqp/guest.qcow2; STRIDE, OFFSET, CASES (a file under
# the repository, e.g. tests/deqp/gles3.txt), LIMIT_S, DETAIL passed on; images/deqp/build.sh's dEQP disk and tests/deqp/ are copied); the host's `vm_stat 1` over the run, each line after its epoch second (<name>.vmstat: the
# Mac's memory is overcommitted by the Lima VMs, and swap-ins and decompressions stall Chromium's threads); HEADED=1 opens a visible window on the Mac (the user allows it there, when they aren't using it).
set -euo pipefail
cd "$(dirname "$0")/../.."
HOST=${MAC_HOST:-macmini.lan}
DEST=webpc-gpu-bench
MODE=$1 IMAGE=$2 NAME=$3
ssh "$HOST" "mkdir -p $DEST/bench/results/local $DEST/target/images/debian $DEST/target/wasm32-unknown-unknown/release"
rsync -a --delete --exclude results bench/gpu bench/audio bench/video bench/vulkan bench/mem "$HOST:$DEST/bench/"
rsync -a bench/snapshot-start.ts "$HOST:$DEST/bench/"   # guest-session.ts imports it and bench/mem/probe.ts
rsync -a --delete web "$HOST:$DEST/"
ssh "$HOST" "mkdir -p $DEST/tests" && rsync -a tests/page-ask.ts "$HOST:$DEST/tests/"   # guest-session.ts answers the page's dialogs with it
# The dev server (Vite: tools/serve.ts) and the packages, installed there (bench/mac-packages.sh).
. bench/mac-packages.sh && mac_packages "$HOST" "$DEST"
rsync -a target/wasm32-unknown-unknown/release/webpc_core.wasm "$HOST:$DEST/target/wasm32-unknown-unknown/release/"
rsync -a target/images/edk2 "$HOST:$DEST/target/images/"
rsync -a target/images/debian/disk.qcow2 "$HOST:$DEST/target/images/debian/"   # the page's own machine, which starts first
rsync -a "$IMAGE" "$HOST:$DEST/bench/results/local/disk.qcow2"
if [ -f target/vk/venus.wasm ]; then   # Venus's renderer (vk/build.sh): a machine with Vulkan (`gpu=virgl,vulkan`)
  ssh "$HOST" "mkdir -p $DEST/target/vk" && rsync -a target/vk/venus.wasm "$HOST:$DEST/target/vk/"
fi
if [ -f target/video/media.ext4 ]; then   # the clips (bench/video/media-disk.sh)
  ssh "$HOST" "mkdir -p $DEST/target/video" && rsync -a target/video/media.ext4 "$HOST:$DEST/target/video/"
fi
[ "$MODE" = - ] && MODE=
if [ "${SCRIPT:-}" = deqp-run.ts ]; then   # dEQP's disk (images/deqp/build.sh) and the pass lists
  ssh "$HOST" "mkdir -p $DEST/target/deqp $DEST/tests/deqp" && rsync -aL target/deqp/deqp.ext4 "$HOST:$DEST/target/deqp/" && rsync -a tests/deqp/ "$HOST:$DEST/tests/deqp/"
  if [ -n "${CASES:-}" ]; then ssh "$HOST" "mkdir -p $DEST/$(dirname "$CASES")" && rsync -a "$CASES" "$HOST:$DEST/$CASES"; fi
fi
if [ "${SCRIPT:-}" = ../vulkan/guest.ts ]; then   # VK0's arm 4: the scene's second disk (images/vulkan/build.sh)
  ssh "$HOST" "mkdir -p $DEST/target/vulkan" && rsync -a target/vulkan/disk.ext4 "$HOST:$DEST/target/vulkan/"
fi
if [ "${SCRIPT:-}" = ../vulkan/venus-run.ts ] && [ -n "${REPLAY:-}" ]; then   # the frames' disk (images/vkframes/build.sh)
  ssh "$HOST" "mkdir -p $DEST/target/vkframes" && rsync -a target/vkframes/vkframes.ext4 "$HOST:$DEST/target/vkframes/"
fi
if [ -f target/ffpages/pages.ext4 ]; then   # firefox-load.ts's real pages (bench/gpu/firefox-pages.sh)
  ssh "$HOST" "mkdir -p $DEST/target/ffpages" && rsync -a target/ffpages/pages.ext4 "$HOST:$DEST/target/ffpages/"
fi
rc=0
ssh "$HOST" "cd $DEST && export PATH=/opt/homebrew/bin:\$PATH WEBPC_TAILSCALE=0 VIRGL_GPU=${VIRGL_GPU:-virgl-null} PHASES=${PHASES:-} WARM_S=${WARM_S:-30} HEADED=${HEADED:-} CLIPS=${CLIPS:-} FRAMES=${FRAMES:-} PHASE_S=${PHASE_S:-} MEDIA=${MEDIA:-} PROFILE=${PROFILE:-} SYSCALLS=${SYSCALLS:-} TIMELINE=${TIMELINE:-} DEBUG=${DEBUG:-} FF_PREFS='${FF_PREFS:-}' VARIANTS='${VARIANTS:-}' MPV_ARGS='${MPV_ARGS:-}' MPV_VARIANTS='${MPV_VARIANTS:-}' ROUNDS=${ROUNDS:-1} NCPUS=${NCPUS:-4} DEMOS=${DEMOS:-} RENDERERS=${RENDERERS:-} FISH='${FISH-1 100 1000 10000}' TOOLKIT='${TOOLKIT-2000 8000}' MSAA='${MSAA:-1}' WARMUP=${WARMUP:-} SAMPLES=${SAMPLES:-} FRAMES=${FRAMES:-} SHIM=${SHIM:-} REPLAY=${REPLAY:-} GPU_KNOBS=${GPU_KNOBS:-} SCREEN=${SCREEN:-} WAYS='${WAYS:-}' FORMAT=${FORMAT:-} CAPTURE=${CAPTURE:-} CHROMIUM_ARGS='${CHROMIUM_ARGS:-}' CHROMIUM_JS_FLAGS='${CHROMIUM_JS_FLAGS:-}' TIMELINE_ALL=${TIMELINE_ALL:-} PAGES=${PAGES:-} QUERY='${QUERY:-}' STRIDE=${STRIDE:-} OFFSET=${OFFSET:-} CASES=${CASES:-} LIMIT_S=${LIMIT_S:-} DETAIL=${DETAIL:-} WEBPC_PROFILE=${WEBPC_PROFILE:-} && [ -n \"\$STRIDE\" ] || unset STRIDE; [ -n \"\$WEBPC_PROFILE\" ] || unset WEBPC_PROFILE; [ -n \"\$WARMUP\" ] || unset WARMUP; [ -n \"\$DEMOS\" ] || unset DEMOS; [ -n \"\$RENDERERS\" ] || unset RENDERERS; [ -n \"\$SAMPLES\" ] || unset SAMPLES; [ -n \"\$FRAMES\" ] || unset FRAMES; [ -n \"\$OFFSET\" ] || unset OFFSET; [ -n \"\$CASES\" ] || unset CASES; [ -n \"\$LIMIT_S\" ] || unset LIMIT_S; [ -n \"\$DETAIL\" ] || unset DETAIL; [ -n \"\$SHIM\" ] || unset SHIM; [ -n \"\$CAPTURE\" ] || unset CAPTURE; [ -n \"\$PHASES\" ] || unset PHASES; [ -n \"\$CLIPS\" ] || unset CLIPS; [ -n \"\$FRAMES\" ] || unset FRAMES; [ -n \"\$PHASE_S\" ] || unset PHASE_S; [ -n \"\$MEDIA\" ] || unset MEDIA; [ -n \"\$PROFILE\" ] || unset PROFILE; [ -n \"\$SYSCALLS\" ] || unset SYSCALLS; [ -n \"\$TIMELINE\" ] || unset TIMELINE; [ -n \"\$DEBUG\" ] || unset DEBUG; [ -n \"\$FF_PREFS\" ] || unset FF_PREFS; [ -n \"\$VARIANTS\" ] || unset VARIANTS; [ -n \"\$HEADED\" ] || unset HEADED; [ -n \"\$PAGES\" ] || unset PAGES; [ -n \"\$WAYS\" ] || unset WAYS; \
  export CHROMIUM=\"\$(ls -d \$HOME/Library/Caches/ms-playwright/chromium-*/chrome-mac-arm64/*.app | sort | tail -1)/Contents/MacOS/Google Chrome for Testing\" && \
  rm -rf bench/results/local/$NAME && { vm_stat 1 | perl -ne '\$|=1; print time(), \" \", \$_' > bench/results/local/$NAME.vmstat & } && perl -e 'alarm shift; exec @ARGV' ${MAC_TIMEOUT:-500} node --disable-warning=ExperimentalWarning bench/gpu/${SCRIPT:-sway-load.ts} $MODE bench/results/local/disk.qcow2 bench/results/local/$NAME > bench/results/local/$NAME.log 2>&1; \
  rc=\$?; sw_vers -productVersion > bench/results/local/$NAME.macos; pkill -x vm_stat; sysctl vm.swapusage >> bench/results/local/$NAME.vmstat; system_profiler SPDisplaysDataType | grep -E 'Chipset|Metal|Cores' > bench/results/local/$NAME.gpu; exit \$rc" || rc=$?
mkdir -p bench/results/local
rsync -a "$HOST:$DEST/bench/results/local/$NAME" "$HOST:$DEST/bench/results/local/$NAME.*" bench/results/local/
exit $rc
