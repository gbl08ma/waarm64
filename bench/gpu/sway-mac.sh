#!/usr/bin/env bash
# G3's real-GPU numbers (the G3 kickoff's decision 4): bench/gpu/sway-load.ts on the Mac host's Chromium (Playwright's
# Chromium, headless, temporary profile) with its GPU, from a copy of what the page needs in ~/waarm64-gpu-bench there
# (as run-mac.sh: Node and playwright-core there; nothing else on the host is touched). The disk image is copied once.
#   bench/gpu/sway-mac.sh <virgl|pixman|llvmpipe> <image.qcow2> <name>   -> bench/results/local/<name>/ (VIRGL_GPU as sway-load.ts)
# SCRIPT=firefox-load.ts runs the Firefox harness instead (PHASES, CHURN, CHURN_S, PAGES, WARM_S, TIMELINE_ALL, PROFILE, SYSCALLS, QUERY, CHROMIUM_JS_FLAGS passed on), SCRIPT=../audio/avsync.ts the
# A/V sync one (CLIPS, PHASE_S, MEDIA, MPV_ARGS, MPV_VARIANTS, SHIM, PROFILE, SYSCALLS, TIMELINE, DEBUG (DEBUG=pw:browser logs Chromium's output, e.g. CHROMIUM_ARGS=--js-flags=--trace-gc), FF_PREFS, VARIANTS, ROUNDS, NCPUS passed on; CHROMIUM_ARGS=--mute-audio keeps the Mac's speakers quiet), SCRIPT=../video/v1.ts
# video V1's check (mode `-`: the script takes none; FRAMES, CLIPS, SHIM, CAPTURE passed on; the media disk, target/video/media.ext4, is
# copied when it exists), WASM=<core.wasm> runs that core instead of target's, VENUS=<venus.wasm> that renderer build (A/Bs of vk/), FROM_SNAPSHOT=<file.waarm64snap> starts
# firefox-load.ts from that snapshot (copied, once a file; JITLOG, MEMLOG, MEMLOG_UASM, WAARM64_GUEST_USER, BROWSE_S, DWELL_S, CHUNK_S and RESTART_S passed on; RSSLOG=1 samples Chrome's RSS there, bench/gpu/mac-rss.sh, into <name>.rss: smaps, which macOS lacks, left out), SCRIPT=../vulkan/venus-run.ts Debian with Vulkan (mode `-`, the image images/debian-vulkan/build.sh's; REPLAY, GPU_KNOBS, STORE_DUMP and WAARM64_PROFILE (a profile directory kept there, relative to its copy) passed on, and images/vkframes/build.sh's disk copied), SCRIPT=../imgdecode/codecs.ts a CPU feature's A/B on the codecs (mode `<feature>,<codecs|js>`, the desktop guest; ROUNDS passed on, bench/imgdecode/codecs-disk.sh's disk copied), SCRIPT=../vulkan/vkd3d.ts vkd3d's Direct3D 12 on Venus (mode `-`, the desktop guest; TESTS, FAILED passed on, target/vkd3d/vkd3d.ext4 copied), SCRIPT=../vulkan/godot.ts Godot on Venus (mode `-`; RUNS, RUN_S, SHOT_S, LOG_LINES, GODOT_ENV, GPU_KNOBS, STORE_DUMP passed on, target/godot/godot.ext4 copied), SCRIPT=../vulkan/t23.ts VK4 T23's arms in Godot's GI demo (mode `-`; PROJECTS, ARMS, ROUNDS, ARM_S, SETTLE_S, FIRST_S, GPU_KNOBS passed on, Godot's disk copied), SCRIPT=../vulkan/apps-load.ts VK1's gate's programs (mode `-`; GPU_KNOBS, APPS (no `'` in it), RAM_MIB and SCREEN passed on), SCRIPT=../vulkan/share.ts VK2 L4's sharing candidates (mode `-`; ROUNDS, FORMAT passed on), SCRIPT=../vulkan/present.ts VK3 L1's presentation check (mode `-`, the desktop guest; WAYS, GPU_KNOBS, SCREEN, SHIM passed on), SCRIPT=../vulkan/mpv-frames.ts mpv's frames on Vulkan and GL (mode `-`, the desktop guest; MPV_ARMS, PAIRS, SHOT2, GRAB, REGRAB, DIAG, MPV_ENV, GUEST_ENV, CHECK, HOLD, GPU_KNOBS, SHIM passed on; bench/vulkan/green.sh loops it), SCRIPT=../vulkan/guest.ts VK0's arm 4 (mode lavapipe|virgl|venus, the image target/vulkan/guest.qcow2 or, for venus, the desktop guest; FISH, TOOLKIT, MSAA, WARMUP, SAMPLES, FRAMES passed on), SCRIPT=query-wait.ts PERF loop 16's occlusion-query waits (mode <arms>, the image target/images/alpine-virgl/rootfs-virgl.ext4; GLQ, ROUNDS passed on), SCRIPT=deqp-run.ts dEQP (mode gles2|gles3, the image target/deqp/guest.qcow2, or vk with target/deqp/guest-vk.qcow2; STRIDE, OFFSET, CASES (a file under
# the repository, e.g. tests/deqp/gles3.txt), DISK2 (likewise, copied), GUEST_ENV, LIMIT_S, DETAIL, DETAIL_NOTSUPPORTED, QPA passed on; images/deqp/build.sh's dEQP disk and tests/deqp/ are copied); the host's `vm_stat 1` over the run, each line after its epoch second (<name>.vmstat: the
# Mac's memory is overcommitted by the Lima VMs, and swap-ins and decompressions stall Chromium's threads); HEADED=1 opens a visible window on the Mac (the user allows it there, when they aren't using it).
set -euo pipefail
cd "$(dirname "$0")/../.."
HOST=${MAC_HOST:-macmini.lan}
DEST=waarm64-gpu-bench
MODE=$1 IMAGE=$2 NAME=$3
ssh "$HOST" "mkdir -p $DEST/bench/results/local $DEST/target/images/debian $DEST/target/wasm32-unknown-unknown/release"
rsync -a --delete --exclude results bench/gpu bench/audio bench/video bench/vulkan bench/mem "$HOST:$DEST/bench/"
ssh "$HOST" "mkdir -p $DEST/bench" && rsync -a bench/procstat.ts bench/mac "$HOST:$DEST/bench/" && ssh "$HOST" "cd $DEST && { [ procstat -nt bench/mac/procstat.c ] || cc -O2 -Wall -o procstat bench/mac/procstat.c; }"   # the counters' helper (bench/procstat.ts)
rsync -a bench/snapshot-start.ts "$HOST:$DEST/bench/"   # guest-session.ts imports it and bench/mem/probe.ts
rsync -a --delete web "$HOST:$DEST/"
ssh "$HOST" "mkdir -p $DEST/tests" && rsync -a tests/page-ask.ts "$HOST:$DEST/tests/"   # guest-session.ts answers the page's dialogs with it
# The dev server (Vite: tools/serve.ts) and the packages, installed there (bench/mac-packages.sh).
. bench/mac-packages.sh && mac_packages "$HOST" "$DEST"
. bench/mac-chrome.sh && mac_chrome "$HOST"   # the current Stable Chrome for Testing there
rsync -a "${WASM:-target/wasm32-unknown-unknown/release/waarm64_core.wasm}" "$HOST:$DEST/target/wasm32-unknown-unknown/release/waarm64_core.wasm"
SNAP=
if [ -n "${FROM_SNAPSHOT:-}" ]; then   # firefox-load.ts from a snapshot: the file, under its own name
  SNAP=bench/results/local/$(basename "$FROM_SNAPSHOT")
  rsync -a "$FROM_SNAPSHOT" "$HOST:$DEST/$SNAP"
fi
rsync -a target/images/edk2 "$HOST:$DEST/target/images/"
rsync -a target/images/debian/disk.qcow2 "$HOST:$DEST/target/images/debian/"   # the page's own machine, which starts first
# At its own path (relative to the repository), else under its own name: a snapshot loads only with the disk it was
# taken on open, by the URL the page opened it at (web/app/main.ts).
case $IMAGE in /*|../*) DISK=bench/results/local/$(basename "$IMAGE") ;; *) DISK=$IMAGE ;; esac
ssh "$HOST" "mkdir -p $DEST/$(dirname "$DISK")"
rsync -a "$IMAGE" "$HOST:$DEST/$DISK"
if [ -f "${VENUS:-target/vk/venus.wasm}" ]; then   # Venus's renderer (vk/build.sh; VENUS=<venus.wasm> another build's): a machine with Vulkan (`gpu=virgl,vulkan`)
  ssh "$HOST" "mkdir -p $DEST/target/vk" && rsync -a "${VENUS:-target/vk/venus.wasm}" "$HOST:$DEST/target/vk/venus.wasm"
fi
if [ -f target/video/media.ext4 ]; then   # the clips (bench/video/media-disk.sh)
  ssh "$HOST" "mkdir -p $DEST/target/video" && rsync -a target/video/media.ext4 "$HOST:$DEST/target/video/"
fi
[ "$MODE" = - ] && MODE=
if [ "${SCRIPT:-}" = deqp-run.ts ]; then   # dEQP's disk (images/deqp/build.sh) and the pass lists
  # Mode vk: dEQP-VK's disk (images/deqp/build.sh vk) and the guest-vk image as <image>.
  disk=deqp.ext4; [ "$MODE" = vk ] && disk=deqp-vk.ext4
  ssh "$HOST" "mkdir -p $DEST/target/deqp $DEST/tests/deqp" && rsync -aL "target/deqp/$disk" "$HOST:$DEST/target/deqp/" && rsync -a tests/deqp/ "$HOST:$DEST/tests/deqp/"
  if [ -n "${CASES:-}" ]; then ssh "$HOST" "mkdir -p $DEST/$(dirname "$CASES")" && rsync -a "$CASES" "$HOST:$DEST/$CASES"; fi
  # DISK2: another second disk (a path under the repository; deqp-run.ts's), e.g. dEQP-VK's with a Venus of its own.
  if [ -n "${DISK2:-}" ]; then ssh "$HOST" "mkdir -p $DEST/$(dirname "$DISK2")" && rsync -a "$DISK2" "$HOST:$DEST/$DISK2"; fi
fi
if [ "${SCRIPT:-}" = ../vulkan/guest.ts ]; then   # VK0's arm 4: the scene's second disk (images/vulkan/build.sh)
  ssh "$HOST" "mkdir -p $DEST/target/vulkan" && rsync -a target/vulkan/disk.ext4 "$HOST:$DEST/target/vulkan/"
fi
if [ "${SCRIPT:-}" = ../vulkan/venus-run.ts ] && [ -n "${REPLAY:-}" ]; then   # the frames' disk (images/vkframes/build.sh)
  ssh "$HOST" "mkdir -p $DEST/target/vkframes" && rsync -a target/vkframes/vkframes.ext4 "$HOST:$DEST/target/vkframes/"
fi
if [ "${SCRIPT:-}" = ../vulkan/godot.ts ] || [ "${SCRIPT:-}" = ../vulkan/t23.ts ]; then   # Godot and its projects (bench/vulkan/godot-disk.sh)
  ssh "$HOST" "mkdir -p $DEST/target/godot" && rsync -a target/godot/godot.ext4 "$HOST:$DEST/target/godot/"
fi
if [ "${SCRIPT:-}" = ../vulkan/vkd3d.ts ]; then   # vkd3d and its tests (bench/vulkan/vkd3d.ts disk)
  ssh "$HOST" "mkdir -p $DEST/target/vkd3d" && rsync -a target/vkd3d/vkd3d.ext4 "$HOST:$DEST/target/vkd3d/"
fi
if [ "${SCRIPT:-}" = ../imgdecode/codecs.ts ]; then   # a CPU feature's A/B on the codecs (bench/imgdecode/codecs-disk.sh's disk)
  rsync -a --delete bench/imgdecode "$HOST:$DEST/bench/"
  ssh "$HOST" "mkdir -p $DEST/target/imgdecode" && rsync -a target/imgdecode/codecs.ext4 "$HOST:$DEST/target/imgdecode/"
fi
if [ "${SCRIPT:-}" = query-wait.ts ]; then   # glquery on alpine-virgl (<image> its rootfs-virgl.ext4): the boot page and alpine's kernel
  ssh "$HOST" "mkdir -p $DEST/tests/browser $DEST/target/images/alpine" && rsync -a tests/browser/virgl-boot.html tests/browser/virgl-boot-worker.ts "$HOST:$DEST/tests/browser/"
  rsync -a target/images/alpine/Image target/images/alpine/initramfs-virt "$HOST:$DEST/target/images/alpine/"
fi
if [ -f target/ffpages/pages.ext4 ]; then   # firefox-load.ts's real pages (bench/gpu/firefox-pages.sh)
  ssh "$HOST" "mkdir -p $DEST/target/ffpages" && rsync -a target/ffpages/pages.ext4 "$HOST:$DEST/target/ffpages/"
fi
rc=0
ssh "$HOST" "cd $DEST && export PATH=/opt/homebrew/bin:\$PATH WAARM64_TAILSCALE=0 VIRGL_GPU=${VIRGL_GPU:-virgl-null} PHASES=${PHASES:-} CHURN='${CHURN:-}' CHURN_S=${CHURN_S:-} WARM_S=${WARM_S:-30} HEADED=${HEADED:-} CLIPS=${CLIPS:-} FRAMES=${FRAMES:-} PHASE_S=${PHASE_S:-} MEDIA=${MEDIA:-} PROFILE=${PROFILE:-} SYSCALLS=${SYSCALLS:-} TIMELINE=${TIMELINE:-} DEBUG=${DEBUG:-} FF_PREFS='${FF_PREFS:-}' VARIANTS='${VARIANTS:-}' MPV_ARGS='${MPV_ARGS:-}' MPV_VARIANTS='${MPV_VARIANTS:-}' MPV_ARMS='${MPV_ARMS:-}' PRE='${PRE:-}' PAIRS='${PAIRS:-}' SHOT2=${SHOT2:-} GRAB=${GRAB:-} REGRAB=${REGRAB:-} DIAG=${DIAG:-} MPV_ENV='${MPV_ENV:-}' GUEST_ENV='${GUEST_ENV:-}' CHECK=${CHECK:-} HOLD=${HOLD:-} GLQ=${GLQ:-300,4,640,480} ROUNDS=${ROUNDS:-1} NCPUS=${NCPUS:-4} DEMOS=${DEMOS:-} RENDERERS=${RENDERERS:-} FISH='${FISH-1 100 1000 10000}' TOOLKIT='${TOOLKIT-2000 8000}' MSAA='${MSAA:-1}' WARMUP=${WARMUP:-} SAMPLES=${SAMPLES:-} FRAMES=${FRAMES:-} SHIM=${SHIM:-} REPLAY=${REPLAY:-} GPU_KNOBS=${GPU_KNOBS:-} APPS='${APPS:-}' RAM_MIB=${RAM_MIB:-} SCREEN=${SCREEN:-} WAYS='${WAYS:-}' FORMAT=${FORMAT:-} CAPTURE=${CAPTURE:-} CHROMIUM_ARGS='${CHROMIUM_ARGS:-}' CHROMIUM_JS_FLAGS='${CHROMIUM_JS_FLAGS:-}' TIMELINE_ALL=${TIMELINE_ALL:-} PAGES=${PAGES:-} QUERY='${QUERY:-}' STRIDE=${STRIDE:-} OFFSET=${OFFSET:-} CASES=${CASES:-} DISK2=${DISK2:-} LIMIT_S=${LIMIT_S:-} DETAIL=${DETAIL:-} DETAIL_NOTSUPPORTED=${DETAIL_NOTSUPPORTED:-} QPA=${QPA:-} WAARM64_PROFILE=${WAARM64_PROFILE:-} RUNS='${RUNS:-}' RUN_S=${RUN_S:-} SHOT_S=${SHOT_S:-} LOG_LINES=${LOG_LINES:-} GODOT_ENV='${GODOT_ENV:-}' STORE_DUMP=${STORE_DUMP:-} PROJECTS='${PROJECTS:-}' ARMS='${ARMS:-}' ARM_S=${ARM_S:-} SETTLE_S=${SETTLE_S:-} FIRST_S=${FIRST_S:-} TESTS='${TESTS:-}' FAILED=${FAILED:-} FROM_SNAPSHOT=$SNAP JITLOG=${JITLOG:-} MEMLOG=${MEMLOG:-} MEMLOG_UASM=${MEMLOG_UASM:-} WAARM64_GUEST_USER=${WAARM64_GUEST_USER:-} BROWSE_S=${BROWSE_S:-} DWELL_S=${DWELL_S:-} CHUNK_S=${CHUNK_S:-} RESTART_S=${RESTART_S:-} && [ -n \"\$BROWSE_S\" ] || unset BROWSE_S; [ -n \"\$RESTART_S\" ] || unset RESTART_S; [ -n \"\$DWELL_S\" ] || unset DWELL_S; [ -n \"\$CHUNK_S\" ] || unset CHUNK_S; [ -n \"\$FROM_SNAPSHOT\" ] || unset FROM_SNAPSHOT; [ -n \"\$MEMLOG\" ] || unset MEMLOG; [ -n \"\$MEMLOG_UASM\" ] || unset MEMLOG_UASM; [ -n \"\$JITLOG\" ] || unset JITLOG; [ -n \"\$WAARM64_GUEST_USER\" ] || unset WAARM64_GUEST_USER; [ -n \"\$RUNS\" ] || unset RUNS; [ -n \"\$TESTS\" ] || unset TESTS; [ -n \"\$FAILED\" ] || unset FAILED; [ -n \"\$STORE_DUMP\" ] || unset STORE_DUMP; [ -n \"\$PROJECTS\" ] || unset PROJECTS; [ -n \"\$ARMS\" ] || unset ARMS; [ -n \"\$ARM_S\" ] || unset ARM_S; [ -n \"\$SETTLE_S\" ] || unset SETTLE_S; [ -n \"\$FIRST_S\" ] || unset FIRST_S; [ -n \"\$RUN_S\" ] || unset RUN_S; [ -n \"\$SHOT_S\" ] || unset SHOT_S; [ -n \"\$LOG_LINES\" ] || unset LOG_LINES; [ -n \"\$STRIDE\" ] || unset STRIDE; [ -n \"\$WAARM64_PROFILE\" ] || unset WAARM64_PROFILE; [ -n \"\$WARMUP\" ] || unset WARMUP; [ -n \"\$DEMOS\" ] || unset DEMOS; [ -n \"\$RENDERERS\" ] || unset RENDERERS; [ -n \"\$SAMPLES\" ] || unset SAMPLES; [ -n \"\$FRAMES\" ] || unset FRAMES; [ -n \"\$OFFSET\" ] || unset OFFSET; [ -n \"\$CASES\" ] || unset CASES; [ -n \"\$DISK2\" ] || unset DISK2; [ -n \"\$LIMIT_S\" ] || unset LIMIT_S; [ -n \"\$DETAIL\" ] || unset DETAIL; [ -n \"\$DETAIL_NOTSUPPORTED\" ] || unset DETAIL_NOTSUPPORTED; [ -n \"\$QPA\" ] || unset QPA; [ -n \"\$SHIM\" ] || unset SHIM; [ -n \"\$CAPTURE\" ] || unset CAPTURE; [ -n \"\$PHASES\" ] || unset PHASES; [ -n \"\$CHURN\" ] || unset CHURN; [ -n \"\$CHURN_S\" ] || unset CHURN_S; [ -n \"\$CLIPS\" ] || unset CLIPS; [ -n \"\$FRAMES\" ] || unset FRAMES; [ -n \"\$PHASE_S\" ] || unset PHASE_S; [ -n \"\$MEDIA\" ] || unset MEDIA; [ -n \"\$PROFILE\" ] || unset PROFILE; [ -n \"\$SYSCALLS\" ] || unset SYSCALLS; [ -n \"\$TIMELINE\" ] || unset TIMELINE; [ -n \"\$DEBUG\" ] || unset DEBUG; [ -n \"\$FF_PREFS\" ] || unset FF_PREFS; [ -n \"\$VARIANTS\" ] || unset VARIANTS; [ -n \"\$HEADED\" ] || unset HEADED; [ -n \"\$PAGES\" ] || unset PAGES; [ -n \"\$APPS\" ] || unset APPS; [ -n \"\$RAM_MIB\" ] || unset RAM_MIB; [ -n \"\$WAYS\" ] || unset WAYS; [ -n \"\$MPV_ARMS\" ] || unset MPV_ARMS; [ -n \"\$PAIRS\" ] || unset PAIRS; [ -n \"\$SHOT2\" ] || unset SHOT2; \
  export CHROMIUM=\"$MAC_CHROME\" && \
  rm -rf bench/results/local/$NAME bench/results/local/$NAME.rss && { vm_stat 1 | perl -ne '\$|=1; print time(), \" \", \$_' > bench/results/local/$NAME.vmstat & } && { [ -z \"${RSSLOG:-}\" ] || { bash bench/gpu/mac-rss.sh bench/results/local/$NAME.rss ${MAC_TIMEOUT:-500} & echo \$! > bench/results/local/$NAME.rsspid; }; } && perl -e 'alarm shift; exec @ARGV' ${MAC_TIMEOUT:-500} node --disable-warning=ExperimentalWarning bench/gpu/${SCRIPT:-sway-load.ts} $MODE $DISK bench/results/local/$NAME > bench/results/local/$NAME.log 2>&1; \
  rc=\$?; [ -f bench/results/local/$NAME.rsspid ] && kill \$(cat bench/results/local/$NAME.rsspid) && rm bench/results/local/$NAME.rsspid; sw_vers -productVersion > bench/results/local/$NAME.macos; pkill -x vm_stat; sysctl vm.swapusage >> bench/results/local/$NAME.vmstat; system_profiler SPDisplaysDataType | grep -E 'Chipset|Metal|Cores' > bench/results/local/$NAME.gpu; exit \$rc" || rc=$?
mkdir -p bench/results/local
rsync -a "$HOST:$DEST/bench/results/local/$NAME" "$HOST:$DEST/bench/results/local/$NAME.*" bench/results/local/
exit $rc
