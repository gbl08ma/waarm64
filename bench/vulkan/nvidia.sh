#!/usr/bin/env bash
# The Vulkan track's runs on the user's NVIDIA desktop (bench/vulkan/REPORT.md "The NVIDIA desktop", "VK2: the gate
# and the NVIDIA run"), by hand on x86_64 Linux (CachyOS: Chromium with WebGPU). Two modes:
#
#   bench/vulkan/nvidia.sh [dir]                    VK0's arms (default dir ~/webpc-vk0)
#   bench/vulkan/nvidia.sh page <bundle.tar> [dir]  VK2: the page itself (default dir ~/webpc-vk2)
#
# Everything it downloads, builds or writes goes into that one directory, which can be deleted afterwards. No sudo, no
# packages installed; caches and temporary files are pointed into the directory too.
#
# VK0 (it needs curl, tar, xz, git and clang): LunarG's Vulkan SDK for Linux (headers, loader, glslc, GFXReconstruct), a
# portable Node, Playwright's Chrome for Testing, a copy of the benchmark's sources, the WebGL Aquarium's assets, the
# scene's build and the results. What it runs:
#   1. the native scene (arm 1) on the system's Vulkan driver: every fish count and the toolkit setting, MSAA 1 and 4;
#   2. the scene captured with GFXReconstruct and converted for arm 3 (its shaders come translated, from
#      bench/vulkan/translate/scene-shaders.json);
#   3. the browser arms: WebGPU by hand (arm 2, three ways of feeding the fish), the translated replay (arm 3) and the
#      WebGPU questions (C, E, F), in the headless Chrome for Testing if it gets the NVIDIA adapter; otherwise it
#      serves the pages and prints the URLs to open in your own Chromium, where each page downloads its results.
# At the end it writes <dir>/vk0-nvidia-results.tar.gz: send that file back.
#
# VK2 (`page`; it needs curl, tar and xz): the bundle bench/vulkan/nvidia-bundle.sh makes on the dev VM (the
# repository's files, the built wasm core, Vulkan's renderer, the firmware and the guests' images, ~4.8 GB: copy it
# over), unpacked, with a portable Node, the page's npm packages and Playwright's Chrome for Testing. The page runs in
# the headless Chrome for Testing if it gets the NVIDIA adapter, else in your own Chromium (VK2_CHROMIUM=<path>, by
# default the first of chromium, google-chrome-stable, google-chrome on the PATH), headed with a temporary profile: a
# window opens for each run and must stay visible (minimised, Chromium throttles it). Each run is a machine on the page,
# as on the dev VM and the Mac (VK2_STEPS="present replay fence scene trace pipelines mpv" picks some; VK2_STEPS=l2b is
# "fence scene trace", VK3 L2b's, ~12 min):
#   1. present (VK3 L1): what Venus presents on the page's screen, against the guest's own frames, for each way Vulkan's
#      frames reach virgl (the page's own choice and its run-time check, then the bitmap, canvas and readback ways
#      forced): vkcube in sway's window, mpv paused fullscreen (bench/vulkan/present.ts, the desktop guest; ~10 min);
#   2. replay: the programs' frames (vkcube, vkmark's 13 scenes, vkQuake) replayed on the Venus device and compared with
#      lavapipe's (bench/vulkan/venus-run.ts REPLAY=all, the tests' Debian; ~5 min);
#   3. fence (VK3 L2, L2b): what a worker's turn and WebGPU's "done" cost in this Chromium (bench/vulkan/fence.ts: a
#      nested setTimeout(0), Atomics.waitAsync's sleeps; onSubmittedWorkDone alone and nudged by empty submits), then
#      submits shaped like the scene's (a 1080p pass of 120 draws, its writeBuffers, a map, two queued, the page's
#      WebGL drawing meanwhile), each part timed and the pass's GPU ms; ~1 min);
#   4. scene: VK0's scene in the desktop guest on Venus and on virgl at 1 and 1,000 fish and the toolkit, and Venus's
#      L2b arms at 1 fish: `vkgputime` (each submit's pass timed on the GPU), `vknudge=0.25` (empty submits every pump
#      turn), `vknudge=0` (none); two alternated rounds (bench/vulkan/guest.ts; each Venus run's fence breakdown and a
#      submit's parts in renderer.venus; ~11 min);
#   4b. trace (VK3 L2b): a Chromium trace (JSON) of 2 s of Venus's scene at 1 fish, with a summary of the GPU process's
#      main thread (bench/vulkan/guest.ts TRACE=1; ~2 min);
#   5. pipelines (VK3 L3): pipelines made one by one against all at once (bench/vulkan/pipelines.ts), and vkQuake's and
#      a vkmark scene's replays with pipelines made at once and no shader store, then cold and warm across a restart on
#      one kept profile (bench/vulkan/venus-run.ts; ~8 min);
#   6. mpv: its frames on Vulkan (VA-API, software) and GL compared, with libplacebo's complaints, twice as the page has
#      it (libplacebo's advanced path on since VK3 L4e; the page's screen read too, and mpv's exit) and once with it held
#      (`vkformats=held`; bench/vulkan/mpv-frames.ts; ~3 min each), then the gate, mpv on Vulkan with VA-API against
#      mpv on GL, two alternated rounds (bench/audio/avsync.ts);
#   7. deqp (VK3 L8): dEQP-VK's pass lists on this GPU, the direct set's and the emulated rows' (tests/deqp/vk.txt, ~4,700
#      cases) and YCbCr's (tests/deqp/vk-ycbcr.txt), each in a boot of the dEQP-VK guest (bench/gpu/deqp-run.ts vk;
#      ~10 and ~2 min on SwiftShader): what fails here that passes there, the subgroup cases among them;
#   8. rows (VK3 L7.4, L7.5): the emulated rows' programs in the desktop guest: ANGLE's ES3 on Venus in the guest's
#      Chromium (a flat varying from the last vertex, a transform feedback capture, 13 uniform blocks a stage:
#      bench/vulkan/angle/es3.html through bench/vulkan/dawn-frames.ts) and vkd3d's own Direct3D 12 tests
#      (bench/vulkan/vkd3d.ts; ~3 min each).
# At the end it writes <dir>/vk3-nvidia-results.tar.gz (with results/summary.txt: each step's verdict, and whether the
# page held the adapter's subgroups, VK3 L5): send that file back. VK2_KEEP=1 keeps an earlier run's results and adds
# to them (VK2_KEEP=1 VK2_STEPS=none only writes the summary's last line, host.txt and the tarball). VK2_DRY=1 prints what each step would run (no bundle
# unpacked, nothing fetched, nothing run: a check of the script itself, on any machine with VK0_ANY_ARCH=1).
set -euo pipefail
# A step that fails says so, with its line, instead of ending the script silently.
trap 'echo "nvidia.sh: stopped at line $LINENO (exit $?): $BASH_COMMAND" >&2' ERR
REPO=$(cd "$(dirname "$0")/../.." && pwd)
DIR=$(realpath -m "${1:-$HOME/webpc-vk0}")
SDK_VERSION=1.4.363.0
NODE_VERSION=v26.7.0
PLAYWRIGHT=$(grep -m1 -A3 '"node_modules/playwright-core"' "$REPO/package-lock.json" | sed -n 's/.*"version": "\(.*\)".*/\1/p')
say() { printf '\n== %s\n' "$*"; }

if [ "${1:-}" = page ]; then
  BUNDLE=$(realpath -m "${2:?usage: bench/vulkan/nvidia.sh page <bundle.tar> [dir]}")
  DRY=${VK2_DRY:-}
  DIR=$(realpath -m "${3:-$HOME/webpc-vk2}")
  for t in curl tar xz; do command -v "$t" >/dev/null || { echo "missing: $t" >&2; exit 1; }; done
  [ "$(uname -m)" = x86_64 ] || [ -n "${VK0_ANY_ARCH:-}" ] || { echo "this script is for x86_64 Linux" >&2; exit 1; }
  # A run's results only (the run of f55eacd7 carried an earlier run's arms along), unless VK2_KEEP=1: then the steps
  # run add to an earlier run's results and summary (VK2_KEEP=1 VK2_STEPS=none only finishes a run that stopped after
  # its steps: the subgroups verdict, host.txt and the tarball).
  [ -n "${VK2_KEEP:-}" ] || rm -rf "$DIR/results"
  mkdir -p "$DIR"/{dl,t,cache,results}
  export TMPDIR=$DIR/t XDG_CACHE_HOME=$DIR/cache npm_config_cache=$DIR/cache/npm PLAYWRIGHT_BROWSERS_PATH=$DIR/browsers
  export __GL_SHADER_DISK_CACHE_PATH=$DIR/cache/nvidia && mkdir -p "$__GL_SHADER_DISK_CACHE_PATH"

  if [ -n "$DRY" ]; then
    # The dry run: this checkout stands in for the bundle, and each step only says what it would run.
    P=$REPO CHROMIUM=dry HEADED= CHROMIUM_ARGS=dry R=$DIR/results
    export CHROMIUM CHROMIUM_ARGS
    say "a dry run (VK2_DRY): the steps' commands, in $P"
  else
  say "Node $NODE_VERSION"
  if [ "${VK0_NODE:-}" = system ]; then
    mkdir -p "$DIR/node/bin" && ln -sf "$(command -v node)" "$DIR/node/bin/node" && ln -sf "$(command -v npm)" "$DIR/node/bin/npm"
  elif [ ! -x "$DIR/node/bin/node" ]; then
    curl -fL --progress-bar -o "$DIR/dl/node.tar.xz" "https://nodejs.org/dist/$NODE_VERSION/node-$NODE_VERSION-linux-x64.tar.xz"
    mkdir -p "$DIR/node" && tar -xJf "$DIR/dl/node.tar.xz" -C "$DIR/node" --strip-components=1 && rm "$DIR/dl/node.tar.xz"
  fi
  export PATH=$DIR/node/bin:$PATH

  say "the bundle (the page, its binaries and the guests' images; a few minutes the first time)"
  P=$DIR/page
  if [ ! -f "$P/.bundle" ] || [ "$(cat "$P/.bundle")" != "$(stat -c %s-%Y "$BUNDLE")" ]; then
    rm -rf "$P" && mkdir -p "$P" && tar -xf "$BUNDLE" -C "$P" && stat -c %s-%Y "$BUNDLE" > "$P/.bundle"
  fi
  cat "$P/BUNDLE.txt"
  (cd "$P" && npm ci --no-audit --no-fund --loglevel=error >/dev/null)
  node "$P/node_modules/playwright-core/cli.js" install chromium >/dev/null
  CFT=$(ls -d "$PLAYWRIGHT_BROWSERS_PATH"/chromium-*/chrome-linux*/chrome 2>/dev/null | sort | tail -1)

  say "which browser gets the NVIDIA adapter?"
  probe() { (cd "$P" && CHROMIUM=$1 HEADED=$2 CHROMIUM_ARGS="--enable-unsafe-webgpu $3" timeout 120 node bench/vulkan/adapter.ts 2>/dev/null | tail -1) || true; }
  USE= USE_HEADED= USE_ARGS=
  for a in "" "--enable-features=Vulkan --use-angle=vulkan --ignore-gpu-blocklist"; do
    r=$(probe "$CFT" "" "$a")
    echo "  Chrome for Testing, headless, ${a:-no flags} -> ${r:0:160}"
    if echo "$r" | grep -qiE "${VK0_ADAPTER_MATCH:-nvidia}"; then USE=$CFT USE_ARGS="--enable-unsafe-webgpu $a"; echo "$r" > "$DIR/results/adapter.json"; break; fi
  done
  if [ -z "$USE" ]; then
    own=${VK2_CHROMIUM:-$(command -v chromium || command -v google-chrome-stable || command -v google-chrome || true)}
    [ -n "$own" ] || { echo "no Chromium of your own on the PATH: set VK2_CHROMIUM=<path to chromium>" >&2; exit 1; }
    r=$(probe "$own" 1 "")
    echo "  $own, headed -> ${r:0:160}"
    echo "$r" | grep -qiE "${VK0_ADAPTER_MATCH:-nvidia}" || { echo "neither browser got the NVIDIA adapter (above)" >&2; exit 1; }
    USE=$own USE_HEADED=1 USE_ARGS=--enable-unsafe-webgpu
    echo "$r" > "$DIR/results/adapter.json"
    echo "  (a window opens for each run: leave it visible until the run ends)"
  fi
  export CHROMIUM=$USE HEADED=$USE_HEADED CHROMIUM_ARGS="$USE_ARGS --mute-audio" WEBPC_TAILSCALE=0
  [ -n "$HEADED" ] || unset HEADED
  R=$DIR/results
  fi
  [ -n "${VK2_KEEP:-}" ] || : > "$R/summary.txt"
  step() {  # name, seconds allowed, then the command: its output in results/<name>.log; a failure is noted and passed over
    local name=$1 limit=$2
    shift 2
    say "$name"
    if [ -n "$DRY" ]; then echo "  (in $P, at most $limit s) $*"; echo "$name: dry" >> "$R/summary.txt"; return 0; fi
    local rc=0
    (cd "$P" && timeout "$limit" "$@") > "$R/$name.log" 2>&1 || rc=$?
    if [ $rc = 0 ]; then echo "  done"; echo "$name: done" >> "$R/summary.txt"
    else echo "  (failed or timed out, exit $rc: $R/$name.log; going on)"; echo "$name: FAILED or timed out (exit $rc)" >> "$R/summary.txt"; fi
  }
  [[ " ${VK2_STEPS:-} " == *" l2b "* ]] && VK2_STEPS="${VK2_STEPS/l2b/fence scene trace}"
  if [ -z "${VK2_STEPS:-}" ] || [[ " $VK2_STEPS " == *" present "* ]]; then
    step present 2400 env SHIM=1 node bench/vulkan/present.ts target/arch/desktop.qcow2 "$R/present"
    # The page's choice and each way's verdict, on the terminal too.
    [ -f "$R/present/results.json" ] && (cd "$P" && node -e '
      const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
      for (const w of r.ways) { const x = r[w] ?? {}; console.log(`  ${w}: ${x.skipped ?? x.error ?? `vkcube ${x.vkcube?.ok ? "right" : "WRONG"}, mpv ${x.mpv?.ok ? "right" : x.mpv?.black ? "BLACK" : "WRONG"}; the page took ${x.shareAfterMpv?.way ?? x.shareAfterVkcube?.way} (${x.shareAfterMpv?.state ?? x.shareAfterVkcube?.state})`}`); }
    ' "$R/present/results.json") || true
  fi
  if [ -z "${VK2_STEPS:-}" ] || [[ " $VK2_STEPS " == *" replay "* ]]; then
    step replay 1800 env REPLAY=all node bench/vulkan/venus-run.ts target/images/debian-vulkan/disk.qcow2 "$R/replay"
  fi
  if [ -z "${VK2_STEPS:-}" ] || [[ " $VK2_STEPS " == *" fence "* ]]; then
    step fence 300 node bench/vulkan/fence.ts "$R/fence.json"
  fi
  if [ -z "${VK2_STEPS:-}" ] || [[ " $VK2_STEPS " == *" scene "* ]]; then
    # Long enough that the render stats' seconds hold the steady state (VK3 L2).
    # VK2_SCENE_ROUNDS and VK2_SCENE_ARMS pick some (test hooks: the dev VM runs the arms one command at a time).
    # The old poller (`venus-timeout`, answered by the run of 5b9654ac) is no longer a default arm; L2b's run at 1 fish.
    for round in ${VK2_SCENE_ROUNDS:-1 2}; do
      for arm in ${VK2_SCENE_ARMS:-venus virgl venus-gputime venus-nudge025 venus-nonudge}; do
        knobs= fish="1 1000" toolkit=2000
        case $arm in
          venus-timeout) knobs=vkpoll=timeout ;;
          venus-gputime) knobs=vkgputime fish=1 toolkit= ;;
          venus-nudge025) knobs=vknudge=0.25 fish=1 toolkit= ;;
          venus-nonudge) knobs=vknudge=0 fish=1 toolkit= ;;
        esac
        step "scene-$arm-$round" 1200 env FISH="$fish" TOOLKIT="$toolkit" WARMUP=200 FRAMES=300 GPU_KNOBS="$knobs" node bench/vulkan/guest.ts "${arm%%-*}" target/arch/desktop.qcow2 "$R/scene-$arm-$round"
      done
    done
    # The frames and Venus's fence breakdown, on the terminal too.
    for f in "$R"/scene-*-1.log "$R"/scene-*-2.log; do [ -f "$f" ] && grep -hE "msaa1 " "$f" | sed "s|^|  $(basename "$f" .log) |" | cut -c1-300; done || true
  fi
  if [ -z "${VK2_STEPS:-}" ] || [[ " $VK2_STEPS " == *" trace "* ]]; then
    # VK3 L2b: 2 s of Venus's scene at 1 fish traced (JSON: gpu, dawn, viz, the GPU process's tasks), 5 s in.
    step trace 900 env TRACE=1 FISH=1 TOOLKIT= WARMUP=200 FRAMES=1000 node bench/vulkan/guest.ts venus target/arch/desktop.qcow2 "$R/trace"
    grep -h "trace:" "$R/trace.log" 2>/dev/null | cut -c1-400 || true
  fi
  if [ -z "${VK2_STEPS:-}" ] || [[ " $VK2_STEPS " == *" pipelines "* ]]; then
    # VK3 L3: N new pipelines made one by one against all at once (and WebGL's round trips meanwhile), then the
    # programs' replays (vkQuake, a vkmark scene; each twice in a session): pipelines made at once with no store (as
    # before L3), then two sessions on one kept profile (cold, then warm: the shader store in IndexedDB and Chromium's
    # own caches across a restart).
    step pipelines-micro 300 node bench/vulkan/pipelines.ts "$R/pipelines-micro.json"
    rp="vkquake,vkmark-desktop,vkquake,vkmark-desktop"
    step pipelines-sync 900 env REPLAY=$rp GPU_KNOBS=vkpipelines=sync,vkcache=off node bench/vulkan/venus-run.ts target/images/debian-vulkan/disk.qcow2 "$R/pipelines-sync"
    rm -rf "$DIR/t/profile"
    for s in cold warm; do
      step "pipelines-$s" 900 env REPLAY=$rp WEBPC_PROFILE="$DIR/t/profile" node bench/vulkan/venus-run.ts target/images/debian-vulkan/disk.qcow2 "$R/pipelines-$s"
    done
    rm -rf "$DIR/t/profile"
    # vkQuake's state load (GFXReconstruct's "Load time", its pipelines made) and the renderer's part, on the terminal too.
    (cd "$P" && node -e '
      for (const a of ["sync", "cold", "warm"]) {
        let r; try { r = JSON.parse(require("fs").readFileSync(`${process.argv[1]}/pipelines-${a}/results.json`, "utf8")); } catch { console.log(`  ${a}: no results`); continue; }
        for (const k of ["vkquake", "vkquake#2"]) {
          const p = r[`replay ${k} pipelines`] ?? {}, load = /Load time:\s+([\d.]+)/.exec(r[`replay ${k} log`] ?? "")?.[1];
          console.log(`  ${a} ${k}: load ${load} s, translated ${p.translateMs} ms, pipelines ready in ${p.readyMs} ms (summed), submits held ${p.deferredMs} ms, store ${p.cacheHits} found ${p.cacheMisses} missed`);
        }
      }' "$R") || true
  fi
  if [ -z "${VK2_STEPS:-}" ] || [[ " $VK2_STEPS " == *" mpv "* ]]; then
    # VK3 L4, L4e: mpv's paused frame on Vulkan (VA-API's surfaces, and decoded in software) and on GL, compared, with
    # libplacebo's complaints, as the page has it (its advanced path on since L4e: no "Failed creating FBO texture"; the
    # M4's green chroma, fixed in L4c, would be "default ... vkva ~ vkno" off by >24 in ~2.3 M bytes), twice: the first
    # session compiles libplacebo's pipelines (Chromium's shader cache is in the temporary profile), the second may find
    # NVIDIA's driver cache warm. Each also reads the page's screen once mpv's screenshot exists and 20 s later (GRAB,
    # REGRAB) and records mpv's exit (`mpvExit` 0; VK3 L4e: Mesa's async present dropped the first fullscreen frame of
    # a cold mpv, which froze its window and couldn't exit, "page" off by >24 in ~1.6 M bytes and the arm ~50 s: the
    # desktop image sets VN_PERF=no_async_present, GUEST_ENV sets it again on an image built before). Then once with
    # the advanced path held (`vkformats=held`, as before L4e: "Failed creating FBO texture").
    for f in default default2 held; do
      knobs= grab="GRAB=1 REGRAB=20"; [ $f = held ] && knobs=vkformats=held grab=
      step "mpv-frames-$f" 900 env SHIM=1 GPU_KNOBS="$knobs" GUEST_ENV=VN_PERF=no_async_present $grab node bench/vulkan/mpv-frames.ts target/arch/desktop.qcow2 "$R/mpv-frames-$f"
      grep -hE "^\[[0-9.]+\] (vk|gl)" "$R/mpv-frames-$f.log" 2>/dev/null | grep -v ' venus ' | cut -c1-200 | sed "s/^/  $f /" || true
      [ -n "$grab" ] && node -e 'const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
        for (const t of ["vkva", "vkno"]) { const a = r[t] ?? {}; console.log(`  ${t}: ${a.seconds} s, mpv exit ${a.mpvExit}, page ${JSON.stringify(a.page)}`); }
        console.log(`  vkva ~ vkno page: ${JSON.stringify(r["vkva ~ vkno"]?.page)}`);' "$R/mpv-frames-$f/results.json" 2>/dev/null || true
    done
    # The gate (the advanced path on, as the page has it since VK3 L4e; presents on mpv's thread, VN_PERF).
    step mpv 1800 env VIRGL_GPU=virgl,vulkan MEDIA=disk SHIM=1 CLIPS=mpv:sintel_trailer-480p.mp4 WARM_S=8 PHASE_S=20 ROUNDS=2 \
      MPV_ENV=VN_PERF=no_async_present MPV_VARIANTS="vk:--vo=gpu-next --gpu-api=vulkan|gl:--vo=gpu --gpu-api=opengl" node bench/audio/avsync.ts virgl target/arch/desktop.qcow2 "$R/mpv"
  fi
  if [ -z "${VK2_STEPS:-}" ] || [[ " $VK2_STEPS " == *" deqp "* ]]; then
    # VK3 L8: dEQP-VK's pass lists on this GPU (CI runs them on SwiftShader; L6b on the M4: 7 Metal-only failures). Every
    # case should pass but those whose feature this adapter lacks or the page holds (subgroups, if its check fails here:
    # then the list's ~720 subgroup cases are NotSupported).
    if [ -n "$DRY" ] || [ -f "$P/target/deqp/guest-vk.qcow2" ]; then
      step deqp-vk 1800 env CASES=tests/deqp/vk.txt LIMIT_S=1500 DETAIL=40 node bench/gpu/deqp-run.ts vk target/deqp/guest-vk.qcow2 "$R/deqp-vk"
      step deqp-vk-ycbcr 900 env CASES=tests/deqp/vk-ycbcr.txt LIMIT_S=600 DETAIL=20 node bench/gpu/deqp-run.ts vk target/deqp/guest-vk.qcow2 "$R/deqp-vk-ycbcr"
      for l in vk vk-ycbcr; do
        (cd "$P" && node -e '
          let r; try { r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); } catch { console.log(`  ${process.argv[2]}: no results`); process.exit(0); }
          const sub = (r.notPassed ?? []).filter((c) => c.includes(".subgroups.")).length;
          console.log(`  ${process.argv[2]}: ${r.cases} cases, ${JSON.stringify(r.counts)}, ${sub} subgroup cases not passed${r.stoppedAt ? `, stopped at ${r.stoppedAt}` : ""}; adapter ${r.adapter}`);
          for (const c of (r.notPassed ?? []).filter((c) => !c.includes(".subgroups.")).slice(0, 20)) console.log(`    ${c}`);
        ' "$R/deqp-$l/results.json" "$l" | tee -a "$R/summary.txt") || true
      done
    else
      echo "deqp: skipped (the bundle has no target/deqp/guest-vk.qcow2)" | tee -a "$R/summary.txt"
    fi
  fi
  if [ -z "${VK2_STEPS:-}" ] || [[ " $VK2_STEPS " == *" rows "* ]]; then
    # VK3 L7.4: ANGLE's ES3 on Venus (the guest's Chromium with --use-angle=vulkan): on the dev VM (L8) `flat
    # 0,0,255,255`, `xfb 0,0,7,1,1,2,7,1,2,4,7,1,3,6,7,1`, `ubo 156,0,0,255`, as ANGLE on virgl's GL draws them.
    step rows-angle 900 env PAGE=bench/vulkan/angle/es3.html ARMS=--use-angle=vulkan node bench/vulkan/dawn-frames.ts guest target/arch/desktop.qcow2 "$R/rows-angle"
    [ -f "$R/rows-angle.log" ] && grep -hoE 'dawn: [a-z]+ [^"\\|]{0,100}' "$R/rows-angle.log" | sort -u | head -20 | sed 's/^/  /' | tee -a "$R/summary.txt" || true
    # VK3 L7.5: vkd3d 1.19 makes a feature level 11_0 device on Venus; its own tests (the dev VM, L8: the first three
    # pass, test_vertex_id fails 39 of 89 and test_instance_id 84 of 372, gaps filed in docs/backlog.md "vkd3d on Venus").
    if [ -n "$DRY" ] || [ -f "$P/target/vkd3d/vkd3d.ext4" ]; then
      step rows-vkd3d 900 env TESTS=test_draw_instanced,test_draw_indexed_instanced,test_root_constants,test_vertex_id,test_instance_id node bench/vulkan/vkd3d.ts target/arch/desktop.qcow2 "$R/rows-vkd3d"
      [ -f "$R/rows-vkd3d.log" ] && grep -hoE 'test_[a-z_]+ rc=[0-9]+|[0-9]+ tests executed \([0-9]+ failures|level [0-9_]+: hr 0x[0-9a-f]+( \(device made\))?' "$R/rows-vkd3d.log" | sort -u | head -20 | sed 's/^/  /' | tee -a "$R/summary.txt" || true
    else
      echo "rows-vkd3d: skipped (the bundle has no target/vkd3d/vkd3d.ext4)" | tee -a "$R/summary.txt"
    fi
  fi
  # VK3 L5: the page holds the adapter's subgroups where its check finds them wrong in divergent control flow (the M4's
  # Metal). Every Venus step's page log says it if so.
  if [ -z "$DRY" ]; then
    # grep finds nothing when the subgroups aren't held: under pipefail that would stop the script (the run of c8087cb0).
    held=$(grep -rl "subgroups are wrong in divergent control flow" "$R" 2>/dev/null | head -3 | tr '\n' ' ' || true)
    if [ -n "$held" ]; then echo "subgroups: HELD by the page's check (subgroups of one invocation; in $held)"
    else echo "subgroups: not held (the device has the adapter's subgroups: the deqp step's subgroup cases ran on them)"; fi | tee -a "$R/summary.txt"
  fi
  { uname -a; nvidia-smi --query-gpu=name,driver_version --format=csv 2>/dev/null || true; "$CHROMIUM" --version 2>/dev/null || true; cat "$P/BUNDLE.txt" 2>/dev/null || true; } > "$R/host.txt"

  say "results"
  ( cd "$DIR" && tar -czf vk3-nvidia-results.tar.gz results )
  echo "Send back: $DIR/vk3-nvidia-results.tar.gz"
  echo
  echo "Everything this script fetched, unpacked and wrote is in $DIR (Node, Chrome for Testing, the page and its"
  echo "images, the results). To remove it all:"
  echo "  rm -rf $DIR"
  exit 0
fi

for t in curl tar xz git clang; do command -v "$t" >/dev/null || { echo "missing: $t" >&2; exit 1; }; done
# Test hooks (the dev VM runs the whole script with them): VK0_SDK, an SDK directory to use as it is (bin, lib, include,
# share), VK0_NODE=system to use the Node on the PATH, VK0_ANY_ARCH=1 to skip the x86_64 check, VK0_ADAPTER_MATCH (a
# regex, default nvidia) for the adapter the headless browser must get.
[ "$(uname -m)" = x86_64 ] || [ -n "${VK0_ANY_ARCH:-}" ] || { echo "this script is for x86_64 Linux" >&2; exit 1; }
mkdir -p "$DIR"/{dl,t,cache,results}
# Everything that would land in the home directory or /tmp lands here instead (the temporary directory's name is short:
# Chrome's socket lives in it, and a socket's path is limited to 108 bytes).
export TMPDIR=$DIR/t XDG_CACHE_HOME=$DIR/cache npm_config_cache=$DIR/cache/npm PLAYWRIGHT_BROWSERS_PATH=$DIR/browsers
export __GL_SHADER_DISK_CACHE_PATH=$DIR/cache/nvidia MESA_SHADER_CACHE_DIR=$DIR/cache/mesa
mkdir -p "$__GL_SHADER_DISK_CACHE_PATH"

say "Vulkan SDK $SDK_VERSION"
if [ -n "${VK0_SDK:-}" ]; then
  mkdir -p "$DIR/sdk/$SDK_VERSION" && ln -sfn "$VK0_SDK" "$DIR/sdk/$SDK_VERSION/x86_64"
elif [ ! -d "$DIR/sdk/$SDK_VERSION" ]; then
  curl -fL --progress-bar -o "$DIR/dl/sdk.tar.xz" "https://sdk.lunarg.com/sdk/download/$SDK_VERSION/linux/vulkansdk-linux-x86_64-$SDK_VERSION.tar.xz"
  mkdir -p "$DIR/sdk" && tar -xJf "$DIR/dl/sdk.tar.xz" -C "$DIR/sdk" && rm "$DIR/dl/sdk.tar.xz"
fi
export VULKAN_SDK=$DIR/sdk/$SDK_VERSION/x86_64
[ -x "$VULKAN_SDK/bin/glslc" ] || { echo "the SDK's layout isn't what this script expects ($VULKAN_SDK)" >&2; exit 1; }

say "Node $NODE_VERSION"
if [ "${VK0_NODE:-}" = system ]; then
  mkdir -p "$DIR/node/bin" && ln -sf "$(command -v node)" "$DIR/node/bin/node" && ln -sf "$(command -v npm)" "$DIR/node/bin/npm"
elif [ ! -x "$DIR/node/bin/node" ]; then
  curl -fL --progress-bar -o "$DIR/dl/node.tar.xz" "https://nodejs.org/dist/$NODE_VERSION/node-$NODE_VERSION-linux-x64.tar.xz"
  mkdir -p "$DIR/node" && tar -xJf "$DIR/dl/node.tar.xz" -C "$DIR/node" --strip-components=1 && rm "$DIR/dl/node.tar.xz"
fi
export PATH=$DIR/node/bin:$PATH

say "the benchmark's sources and Playwright $PLAYWRIGHT"
S=$DIR/src
mkdir -p "$S/bench/spike"
rsync -a --delete --exclude results "$REPO/bench/vulkan" "$S/bench/" 2>/dev/null || { rm -rf "$S/bench/vulkan"; cp -r "$REPO/bench/vulkan" "$S/bench/"; }
cp "$REPO/bench/stats.ts" "$S/bench/"
cp "$REPO/bench/spike/page.ts" "$REPO/bench/spike/worker.ts" "$REPO/bench/spike/benchmarks.ts" "$S/bench/spike/"
printf '{"private":true,"type":"module","dependencies":{"playwright-core":"%s"}}\n' "$PLAYWRIGHT" > "$S/package.json"
(cd "$S" && npm install --no-audit --no-fund --loglevel=error >/dev/null)
node "$S/node_modules/playwright-core/cli.js" install chromium >/dev/null
CHROME=$(ls -d "$PLAYWRIGHT_BROWSERS_PATH"/chromium-*/chrome-linux*/chrome 2>/dev/null | sort | tail -1)
[ -x "$CHROME" ] || { echo "no Chrome for Testing under $PLAYWRIGHT_BROWSERS_PATH" >&2; exit 1; }
export CHROMIUM=$CHROME
T=$S/target/vulkan
mkdir -p "$T"

say "the Aquarium's assets (Chrome decodes the textures)"
[ -f "$T/aquarium.pack" ] || node "$S/bench/vulkan/assets.ts" "$T/aquarium.pack"

say "the native scene, built with clang against the SDK"
CC=clang NO_GLES=1 "$S/bench/vulkan/scene/build.sh" "$T/scene" >/dev/null
if command -v wasm-ld >/dev/null || command -v ld.lld >/dev/null; then
  "$S/bench/vulkan/webgpu/build.sh" "$T/scene.wasm" >/dev/null 2>&1 || cp "$S/bench/vulkan/webgpu/scene.wasm" "$T/scene.wasm"
else
  cp "$S/bench/vulkan/webgpu/scene.wasm" "$T/scene.wasm"   # the committed copy: clang here has no wasm linker
fi
export LD_LIBRARY_PATH=$VULKAN_SDK/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}
# Which device the scene picks (its first line; the rest discarded, not cut off: under pipefail a closed pipe fails).
"$T/scene/vk" --pack "$T/aquarium.pack" --shaders "$T/scene/shaders" --fish 1 --warmup 1 --samples 1 --frames 1 > "$DIR/t/device.txt" 2>&1 || true
head -1 "$DIR/t/device.txt"

say "arm 1: the native sweep (a few minutes)"
bash "$S/bench/vulkan/sweep.sh" "$T/scene/vk" "$T/aquarium.pack" "$T/scene/shaders" "$DIR/results/native" nvidia || echo "(some native runs failed: see above; going on)"
"$VULKAN_SDK/bin/vulkaninfo" --summary > "$DIR/results/native/vulkaninfo.txt" 2>&1 || true

say "arm 3's captures (GFXReconstruct on this driver) and their conversion"
C=$T/captures
mkdir -p "$C"
capture() {  # name, then the scene's arguments; succeeds when the trace exists (run as an if's condition, so no set -e)
  local name=$1; shift
  [ -f "$C/$name-trace/stream.bin" ] && return 0
  rm -rf "$C/$name" "$C/$name.gfxr" "$C/$name-trace"
  VK_LAYER_PATH=$VULKAN_SDK/share/vulkan/explicit_layer.d VK_INSTANCE_LAYERS=VK_LAYER_LUNARG_gfxreconstruct \
    GFXRECON_CAPTURE_FILE=$C/$name.gfxr GFXRECON_CAPTURE_FILE_TIMESTAMP=false GFXRECON_LOG_LEVEL=warning \
    "$T/scene/vk" --pack "$T/aquarium.pack" --shaders "$T/scene/shaders" --warmup 0 --samples 1 --frames "${FRAMES:-20}" "$@" >/dev/null 2>&1 &&
  "$VULKAN_SDK/bin/gfxrecon-convert" --format jsonl --include-binaries --output "$C/$name.jsonl" "$C/$name.gfxr" >/dev/null &&
  node "$S/bench/vulkan/translate/convert.ts" "$C/$name.jsonl" "$C/$name-trace" &&
  cp "$S/bench/vulkan/translate/scene-shaders.json" "$C/$name-trace/shaders.json"
  rm -rf "$C/$name" "$C/$name.gfxr" "$C/$name.jsonl"
  [ -f "$C/$name-trace/shaders.json" ]
}
TRACES=
for c in "fish1 20 --fish 1" "fish100 20 --fish 100" "fish1000 20 --fish 1000" "fish10000 10 --fish 10000" "fish30000 6 --fish 30000" \
         "toolkit2000 20 --toolkit 2000" "toolkit8000 20 --toolkit 8000" "fish1000ms 20 --fish 1000 --msaa 4" "toolkit2000ms 20 --toolkit 2000 --msaa 4"; do
  set -- $c
  n=$1 f=$2; shift 2
  if (FRAMES=$f capture "$n" "$@"); then TRACES="$TRACES $n"; else echo "(capturing $n failed: skipped)"; fi
done
TRACES=${TRACES# }

say "which adapter does the headless Chrome for Testing get?"
ARGS=
for a in "--enable-unsafe-webgpu" "--enable-unsafe-webgpu --enable-features=Vulkan --use-angle=vulkan --ignore-gpu-blocklist" \
         "--enable-unsafe-webgpu --enable-features=Vulkan,VulkanFromANGLE,DefaultANGLEVulkan --use-angle=vulkan --use-vulkan --ignore-gpu-blocklist"; do
  probe=$(CHROMIUM_ARGS="$a" timeout 120 node "$S/bench/vulkan/webgpu.ts" --probe 2>/dev/null | tail -1 || true)
  echo "  $a -> ${probe:0:160}"
  if echo "$probe" | grep -qiE "${VK0_ADAPTER_MATCH:-nvidia}"; then ARGS=$a; echo "$probe" > "$DIR/results/adapter.json"; break; fi
done

if [ -n "$ARGS" ]; then
  export CHROMIUM_ARGS=$ARGS
  say "arm 2: WebGPU written by hand (headless)"
  MODES="storage dynamic immediates" node "$S/bench/vulkan/webgpu.ts" "$DIR/results/webgpu" nvidia || echo "(arm 2 failed: going on)"
  say "arm 3: the translated replay (headless)"
  list=; for t in $TRACES; do list="$list vulkan/captures/$t-trace"; done
  TARGET=$S/target node "$S/bench/vulkan/arm3.ts" "$DIR/results/arm3" nvidia $list || echo "(arm 3 failed: going on)"
  say "C, E, F: the WebGPU questions (headless)"
  node "$S/bench/vulkan/micro.ts" "$DIR/results/micro.json" || echo "(C, E, F failed: going on)"
else
  say "the headless Chrome got no NVIDIA adapter: over to your own Chromium"
  PORT=${PORT:-8197}
  echo "Open these three pages in your Chromium, one after the other, and leave each until it says \"done\" (minutes):"
  echo "  http://127.0.0.1:$PORT/bench/vulkan/webgpu/index.html?sweep                          -> downloads vk0-webgpu-results.json"
  echo "  http://127.0.0.1:$PORT/bench/vulkan/translate/index.html?sweep=${TRACES// /,}         -> downloads vk0-translated-results.json"
  echo "  http://127.0.0.1:$PORT/bench/vulkan/micro/index.html?download                         -> downloads vk0-micro-results.json"
  echo "Then move the downloaded files into $DIR/results/ and press Enter here (the server stops)."
  node --input-type=module -e "
    import { serve } from '$S/bench/vulkan/server.ts';
    const s = await serve('$S', '$S/target', $PORT);
    process.stdin.once('data', () => { s.close(); process.exit(0); });
  "
fi

say "results"
( cd "$DIR" && tar -czf vk0-nvidia-results.tar.gz results )
cat <<EOF
Send back: $DIR/vk0-nvidia-results.tar.gz

Everything this script fetched, built and wrote is in $DIR (the SDK, Node, Chrome for Testing, the sources, the assets,
the captures, caches and the results). To remove it all:
  rm -rf $DIR
EOF
