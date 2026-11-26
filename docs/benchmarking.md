# Benchmarking and profiling

How performance is measured, the rules that keep numbers honest, the current numbers, and the
profiling tools. The raw journals are the reports: `bench/spike/REPORT.md` (M0 JIT design
numbers), `bench/spike/memory/REPORT.md` (M0.5 memory layout decision), `bench/interp/REPORT.md`
(MIPS, CoreMark, the JIT's loops, `openssl speed`), `bench/boot/REPORT.md` (boot times, I/O).
Those are dated lab notebooks, appended to per loop; this page is the current state.

## The harness

`npm run bench -- [--quick] [--only <bench>] [--config default|liftoff-only|turbofan-only|bounds-checks] [--page <path>] [--out <file>]`
(`bench/run.ts`; `bench/README.md` has the result schema). It serves the repo with COOP/COEP,
opens the page in headless Chromium through Playwright, collects `{name, unit, params, samples}`
and writes medians and IQR with host, browser and commit metadata as JSON (default:
`bench/results/local/`, gitignored). The pages run their suites in a worker (so they get the
device worker). **Chromium numbers are the ones that count**; Node is for iteration.

| Page | Benchmarks (`--only`) |
|---|---|
| `bench/interp/index.html` | `interp_mips`, `interp_fp_mips`, `vm_flat_mips`, `vm_mmu_mips` (interpreter: user-mode integer and FP/NEON guests, the integer guest at EL1 with the MMU off/on), `jit_mips`, `jit_fp_mips`, `jit_fz_mips` (the FP guest's FZ mode, `guest-fz.bin`: FPCR.FZ set, a shader-like NEON kernel), `vm_jit_flat_mips`, `vm_jit_mmu_mips`, `coremark_mips`, `jit_coremark_mips` (also reported as iterations/s); `dec_mips`, `dec_fp_mips`, `vm_dec_flat_mips`, `vm_dec_mmu_mips` (the block interpreter: the dispatcher never compiling, `VmConfig.jit` 4; `dec_fp_mips` the FP guest, whose SIMD and FP instructions take its slow path, `interp::exec_at_op`) |
| `bench/boot/index.html` | `boot`, `boot_defconfig`, `boot_alpine` (interpreter), `boot_jit`, `boot_alpine_jit`, `alpine_user_jit` (ms per phase), `alpine_user_spill_jit` (the same with 192 MiB in memory 0 and the rest in a spill memory: the JIT's spill arm's code, spill-memories.md), `coremark_vm_jit` (CoreMark as init, realtime), `alpine_crypto_jit` / `alpine_crypto_ce_jit` (`openssl speed`, extensions off/on, realtime), `gl_llvmpipe_jit` / `_4`, `gl_virgl_jit` / `_4`, `gl_virgl_llvmpipe_jit` / `_4` (ms a frame); `boot_dec`, `boot_alpine_dec` (the Buildroot and Alpine boots as MIPS in the block interpreter alone, `VmConfig.jit` 4), `boot_mips_jit`, `boot_alpine_mips_jit` (the same under the JIT; with `--config liftoff-only` the interpreter's reference); I/O: `dd`, `fio`, `p9`, `net` (realtime) |
| `bench/io/index.html` | `io` (fio and dd on a chosen `File` disk under a fresh OPFS overlay: reads, writes, `fsync`, reads of written data; realtime, a boot per sample; `node bench/run.ts --page bench/io/index.html --input target/bench/io-raw.img`, the input from `head -c 256M /dev/urandom`), `io_reads` (its base reads alone; a `.qcow2` input is read as one, e.g. `target/bench/io-usr.qcow2`, bench/io/REPORT.md "The inflate pool"), `io_stats` (per-stage timers of the blk device, one boot per workload), `io_bulk` (an import of the input as a stored disk, a changes file of it loaded as an overlay, that overlay merged: `bench/io/bulk.ts`). **On a persistent profile** (`--profile=<dir>`, a fresh one made under `<dir>` and removed after; on disk, not the dev VM's `/tmp`: bench/io/REPORT.md "PERF loop 76"): `bench/run.ts` launches off the record otherwise, where OPFS is in memory, a call ~0.3 ms and a flush free, and a user's browser has neither; the Mac with `bench/run-mac.sh <name> --page bench/io/index.html --input target/bench/io-raw.img --only io --profile=target/bench-profiles`; `node bench/io/inflate-page.ts <label> [boot,import,export,export-c,reads]` times Debian's boot, import, export and compressed export on the page, and the qcow2 reader's 1 MiB reads of `target/bench/io-usr.qcow2` (one thread, a pool of four) with the clusters' inflate and deflate alone (bench/boot/REPORT.md "SNAPZ loop 6") |
| `bench/gpu/index.html` | `webgpu_adapter`, `writebuffer`, `present_canvas2d`, `present_canvas2d_rgba`, `present_webgl2`, `present_webgpu` (G0: ms per frame at 1080p/1440p/4K, full and damaged; needs `--chromium-args`, see `bench/gpu/REPORT.md`; `bench/gpu/run-mac.sh` for the Mac host's real GPU), `flush_cost` (the virtio-gpu backend itself: a transfer, a flush with its draw, on the canvas 2D screen and, `*_raw`/`*_webgl2`, the WebGL2 one; no flags needed). Beside the page: `node bench/gpu/page.ts` (Debian on the page, virtio-gpu against the simple framebuffer: first pixel, `running`, key to glyph on the screen and the terminal) and `node bench/gpu/draw-latency.ts`; `node bench/gpu/sway-load.ts` (a compositor's load: sway and foot on the Arch image, the guest's CPU, frames, the stream and, with `VIRGL_GPU=virgl`, the renderer's time; dev-only), `bench/gpu/sway-mac.sh` (the same on the Mac host's GPU; with `SCRIPT=firefox-load.ts`, `WASM=<core>` and
`FROM_SNAPSHOT=<file>` Firefox's pages session there from a snapshot, a core per run: an A/B between cores, with
`bench/gpu/mac-leftovers.sh --kill` after each run); `node bench/gpu/firefox-load.ts` and `node bench/gpu/gtk4-load.ts` (Firefox and gtk4-demo on the Arch image with Firefox, graphics.md "Applications on 3D"), `node bench/gpu/deqp-run.ts` (dEQP on the page; images.md) |
| `bench/jit/index.html` | `jit_install`, `jit_first_call` |
| `bench/spike/index.html` | the M0 spike (`node bench/spike/node.ts` in Node) |

**A disk on a remote server** (`bench/remote-disk/`, beside the harness; journal in `bench/remote-disk/REPORT.md`):
`node bench/remote-disk/boot.ts <label> <url | local:/d47[/r20][/pages]>` boots the Arch desktop guest from a disk
URL (`?disk=`, `?iostats`: `window.__ioStats()` gives the disks' stage timers, a trace of every base read and the
block cache's counters) to Firefox's first paint, with a mark per phase; `local:` serves
`target/images/remote/desktop.qcow2` (a hard link of `target/arch/desktop.qcow2`, made again by hand: the old one
went 2026-11-22) from `bench/remote-disk/server.ts` with latency (`/d<ms>`), a rate (`/r<MB/s>`)
or no ranges (`/pages`) added, and logs each request. `summary.ts` sums a run per phase, `simulate.ts` replays its
trace through a block cache.

**Against the other in-browser systems** (`bench/compare/`; journal in `bench/compare/REPORT.md`; docs/comparison.md
§3): `node bench/compare/run.ts [--rounds 3] [--runs 3] [--size 8] [--only waarm64,unkernel,v86] [--out f]` types one
workload (`work.pl`: six kernels in plain Perl, no module) into each system's guest as shipped (ours: this checkout's
page with the tests' Debian), runs it with the guest's own perl, and times each run from outside, between the
script's first and last lines on the console; a fresh boot a round, the systems alternated, every kernel's checksum
compared. The page's speed figures (`web/app/intro/speed.ts`) are its medians' ratios on the Mac host:
`bench/compare/run-mac.sh <name> [args]` copies the page, the core, the firmware and the Debian image there and runs
the same harness on its Chrome for Testing (the VM idle meanwhile; bench/gpu/mac-leftovers.sh after), its JSON moved
back into `bench/compare/results/`. ~17 min at size
8 on either; alone on the machine, under `timeout`.

**A demo as a visitor meets it** (`bench/demo/`, beside the harness; journal in `bench/demo/REPORT.md`):
`node bench/demo/run.ts <target> [--runs 3] [--apk] [--out f]` opens a target's page in headless Chromium, a fresh
profile and cache each run, and times from the navigation to its prompt, to a typed command's answer and (`--apk`)
`apk add python3`; with the bytes received by each mark (Chromium's net log, `--log-net-log`: every socket's bytes by
host, Chromium's own traffic apart) and the browser's processes' PSS and RSS (/proc) at the prompt and at their peak.
The targets (`bench/demo/targets.ts`: a page, how its console is read and typed on, what its prompt is) are the
others' demos as shipped (`unkernel`, `v86-buildroot`, `v86-arch`), ours (`waarm64-desktop`: the deployed Desktop
Demo; `waarm64-alpine`: Alpine's UEFI cloud image on an `npm run dist` build) and `blank` (the browser alone). Our
Alpine demo becomes a target of its own.

**A complex application** (`bench/apps/`, beside the harness; results and journal in `bench/apps/REPORT.md`):
`node bench/apps/chromium.ts [--ncpus 4] [--json f] [--wasm core.wasm] [--perf N] [page...]` boots the page's
Debian on images/debian-chromium/build.sh's disk (`?disk=`, a fresh overlay), logs in on the serial terminal and
times `chromium --headless --screenshot <page>` in the guest, three times by default (`chrome://newtab`: the
guest's headless Chromium 153 serves the new tab page for every `chrome://` URL; `data:` and `file:` load as
asked). Per run: guest ms, the guest's user/system/iowait share, major faults, steps, MIPS, the interpreted share
and every counter's difference (the page's status carries `Vm.stats`). `--wasm` serves another core (A/B without
rebuilding in between), `--probe '<sh>'` runs one guest command and prints the terminal, `--perf N` records the
page's renderer during run N (`node bench/apps/perf.ts script.txt --map /tmp/perf-<pid>.map`: by category, with
V8's map resolving what perf leaves `[unknown]`).

**Image decoding in the guest's browsers** (`bench/imgdecode/`, its README): Chromium and Firefox ESR on the page's
Debian decode images in a loop, per format; `node bench/imgdecode/profile.ts` counts the images decoded, samples guest
PCs and logs helper calls in a window.

- Boot benchmarks time cold (a fresh `WebAssembly.compile` per boot) and warm boots, to the
  guest's markers and power-off, and **force a GC before each boot** ([v8.md](v8.md) "Module
  reuse"). They set `idleLimitMs`, so a lost wake-up throws instead of hanging.
- **Guest-timed workloads run in realtime mode** (`dd`, `fio`, `openssl speed`, CoreMark in the
  VM); host-timed ones deterministically. I/O benchmarks: one fresh boot per sample, timed by the
  host between the guest script's markers unless the tool times itself. `fio`, `p9` and `net` boot
  under the interpreter unless the page's query (`bench/run.ts --query=`) says `jit=1`; `ncpus=N`
  runs them in parallel SMP (a worker per vCPU, as the page does), `chunk=N` sets its chunk
  (`vm_set_chunk`), `stats=1` logs each `<x> start`/`<x> end` phase's steps, time out of the core,
  IRQs and interpreted steps, and `disk=`/`script=` boot another root disk and script (ad hoc:
  `bench/boot/results/m8-devlat/bench-netload.sh`).
- `alpine_user_jit` (the Alpine userspace benchmark, `images/build.sh alpine-user`): after the
  boot, phases timed from console markers: compression (`xz -6 -T1` and `gzip -9` of a fixed ~16
  MiB corpus on tmpfs, then decompression), Lua (binary-trees, fannkuch-redux, n-body,
  spectral-norm), process churn (fork/exec loop and `find | xargs stat`), SQLite `speedtest1`.
  **Budget: ≤ ~30 s on one vCPU under the JIT** (benchmarks mustn't be slow to wait for). Every
  phase takes a thread/process count so M7 can rerun them at N vCPUs. `waarm64.phase=crypto` runs
  `openssl speed` instead; `waarm64.armcap=X` sets `OPENSSL_armcap`. `7z b` was left out (12 s
  natively for one pass).
- `gl_llvmpipe_jit`, `gl_llvmpipe_jit_4` (llvmpipe, `images/build.sh alpine-gl`): after Alpine's
  boot, `glcomp` (`images/alpine/gl`) composites like a Wayland compositor on Mesa's software
  rasterizer without a display: per frame a 64-row texture upload, 3 blended full-target quads at
  1376×762 and a read-back that waits for the rasterizer. ms a frame (host-timed) and the warm
  phase (LLVM compiling the shaders, 3 frames); a pixel hash checked against llvmpipe natively.
  `gl_llvmpipe_jit`: 1 vCPU, deterministic, `LP_NUM_THREADS=0` (the shaders' code alone, 10
  frames); `_4`: 4 parallel vCPUs, realtime, Mesa's 4 rasterizer threads (30 frames). Natively on
  the dev VM: 26.6 ms a frame on one thread, 7.4 on four.
- `gl_virgl_jit`, `gl_virgl_jit_4` (G2, `images/build.sh alpine-virgl`): the same glcomp frames through Mesa's
  virgl driver on a virtio-gpu with virgl on the **null renderer** (devices.md "virgl": nothing is drawn, fences
  signal at once), so the guest's cost alone: ms a frame, warm, and guest steps a frame (`_frame_steps`, at the run
  loop's chunk resolution). The check is held only to itself (the read-backs are the null renderer's).
  `gl_virgl_llvmpipe_jit[_4]`: llvmpipe from that same Mesa build, the like-for-like baseline. graphics.md "Measurements" has the
  numbers.
- **SMP (M7):** `smp_alpine_jit`, `smp_user_jit` run parallel SMP (a worker
  per vCPU, realtime, JIT) at N = 1, 2, 4 vCPUs, the Ns alternated within each round; `…_8` once
  as a check, `smp_user_jit_4` alone for A/B sessions. Boots report the time to the distro's
  local.d script and to power-off (realtime power-off includes busybox init's 2 s of sleeps after
  SIGTERM and SIGKILL); `smp_user_jit` runs the userspace phases with `waarm64.threads=N` (N copies
  of each phase's work, so perfect scaling keeps the time). Per-vCPU counters (`cpuStats()`) go
  into the params; a boot whose console says "Missing cycle counter" fails (the vCPU workers' clock,
  platform.md "Time").
- **The host limits N:** the M4 has 4 performance and 6 efficiency cores, and the dev VM's 8 vCPUs
  run on either. Once more than ~4 host threads are busy (N vCPU workers, the coordinator, the
  device worker), threads that sleep and wake land on efficiency cores: four independent
  one-vCPU VMs slowed each other's process churn from 1.44 to 3.3 s, and 4, 5, 7 busy threads
  of any kind beside one VM to 2.1, 2.5, 3.3 s (its compute phases lost 10–40%); three threads
  hogging cache or DRAM bandwidth didn't slow it. Read N = 4 on this host as a lower
  bound.
- `coremark_vm_jit`: CoreMark sizes its run from calibration, which a cold JIT slows, so a run can
  fall under CoreMark's 10 s rule (valid results, flagged).
- CoreMark: `bench/interp/build-coremark.sh` fetches EEMBC's pinned sources (unmodified; our port
  layer) into `target/bench/`.

## Starting from a snapshot

A JIT A/B on the desktop guest needs no boot per arm: a **warm snapshot** is made once and every session loads it
(`bench/boot/REPORT.md` "M8: benchmarks started from a snapshot", data in `bench/boot/results/m8-snapbench/`).

- **The snapshots:** `bench/gpu/warm-snapshots.sh firefox` (5.5 min; Arch Linux ARM's disk, sway up, then Firefox
  started on a still page and saved as `target/snapbench/pages.waarm64snap`, then on the WebGL cubes as
  `webgl.waarm64snap`, ~700 MB each, the pages disk attached); `bench/gpu/warm-snapshots.sh debian` (40 s: Debian
  logged in with the Go tree as `/dev/vdb`, `debian-go.waarm64snap`, 176 MB). Each has a sidecar `<file>.json` (the
  core's SHA-256, the commit). Keep them in `target/` (never /tmp, which is RAM): Playwright's downloads go through
  `WAARM64_DOWNLOADS` (the browser's `downloadsPath`). Make them again when the guest-visible machine or the host's
  device state changes (the page refuses another state layout, see below; a host whose devices save other state
  isn't caught).
- **Across core builds:** a snapshot is tied to the core's state layout (`snapshot_version`) and the machine (devices,
  vCPUs, RAM, CPU features), never to the build that made it or its ABI, so a core that differs only in its JIT loads
  it and the guest runs on exactly (`tests/snapshot.test.ts` "a snapshot loads into another build of the core";
  docs/platform.md "The snapshot file"). There is no special mode: the user's Load snapshot does it. The JIT's code,
  the TLBs and the counters aren't in a snapshot (core/src/vm/state.rs), and the restore starts a new machine worker
  with new vCPU workers, so every arm starts with an empty code cache.
- **A session from one:** `FROM_SNAPSHOT=<file>` for `bench/gpu/firefox-load.ts` (no login, no files, no sway: the
  phases begin 11 s after the start, the 700 MB file loading in 9 s), `--from-snapshot <file>` for
  `bench/stress/stress.ts` (the load starts at once). `CORE=<file.wasm>` (`--core`) serves another core build as the
  page's (a route in the browser: target/ is never written, nothing to copy back before CI). A session's
  `results.json` has `from` (the file, which core made it, which runs) and `times`.
- **An A/B:** `FROM=target/snapbench/pages.waarm64snap bash bench/gpu/ab.sh <outdir> <rounds> a=<a.wasm> b=<b.wasm>
  a2=<a copy>` (each round every arm in turn; under a 10 GiB scope and `timeout` each; in the background, alone), then
  `node bench/gpu/ab-summary.ts <outdir>`: per session and per arm (median, IQR) the counts (flushes, modules, wasm
  MB, compiled share, Gsteps interpreted, the first flush's time, flushes a minute, each flush's slow phase), then
  the JIT cache's lock (acquisitions, the share found held, ms waited, ms emitting under it: ABI 46), then
  busy MIPS and stalls, the heavy pages' loads, the session's wall and setup time, and the renderer's RSS and V8's
  wasm code over the workload (`rss.txt`: median and maximum). An arm's core may carry a query for that arm
  (`b160=core.wasm?jitmb=160`). `MEMLOG=10` adds `mem.jsonl`: every 10 s the renderer's smaps by class
  (`bench/mem/probe.ts`), the page's own accounting (`__status.memory`) and, unless `MEMLOG_UASM=0`,
  `measureUserAgentSpecificMemory` (50-60 s a call); `bench/mem/calibrate.ts` compares the page's estimate with smaps
  ([jit.md](jit.md) "The page's memory signal").
- **On the Mac** (the JIT's ranking host; PERF's tier 3): `bench/gpu/ab-mac.sh <outdir> <rounds>
  <arm>=<core.wasm>[@<tree>]...` runs the pages session from `target/snapbench/pages.waarm64snap` (`FROM`) through
  `bench/gpu/sway-mac.sh`, `PHASE_S=1` (a second of each page's frames: Firefox's starts and the pages' loads are the
  measure), each round starting with the next arm, into the same layout as `ab.sh` (so `ab-summary.ts` reads it:
  `pagesS` is the starts and loads summed, `startsS` the starts), with `mac-leftovers.sh --kill` after each session.
  `PHASES=browse` (with `BROWSE_S`, `DWELL_S`, `RESTART_S`, `CHUNK_S`, `RSSLOG=1`, `KEEP_TIMELINES=1`) runs a long
  session instead: the pages disk's sites in one Firefox tab by bot (`firefox/sites.html`), scrolled, Firefox's output
  stamped by the guest's clock so its frames line up with the JIT's counters and the vCPU timeline (in chunks: the
  timeline holds 600 s), Chrome's RSS on the Mac (`bench/gpu/mac-rss.sh`); `bench/gpu/flush-cost.ts <session>` gives
  the compiled MB over time and, per flush, MIPS, the compiled share, stalls and frame gaps against the session's
  other windows (bench/boot/REPORT.md "PERF loop 63").
  `@<tree>` runs an arm from another checkout's web/ (a core of an older ABI: `../waarm64-base` at its commit,
  sharing this `target/`). ~4 min a session (bench/boot/REPORT.md "PERF loop 35"). `MEMLOG` (and `MEMLOG_UASM=0`)
  pass through to the Mac: `mem.jsonl` then has the page's accounting and the JIT's counters, no smaps (macOS has no
  /proc).
- **Turnaround** (the dev VM, Firefox's pages session, 160 against 320 MiB and an A/A, three rounds): from boot a
  session is 441-490 s, 72 s of it the boot, the login and sway; from the snapshot 376-428 s, 11 s of it the restore.
  Nine sessions: 70 min from boot, 59 from the snapshot. The measured phase is the cost: what saves time is a shorter
  workload, below.
- **What differs from a boot:** the guest has done its first-boot work and Firefox has started once (its files are
  in the page cache); the code cache starts empty instead of holding the boot's ~100 MB, so a budget fills later (at
  160 MiB the pages session's first flush came 133 s in, against before 120 s after a boot) and the counts are lower
  (269 MB compiled against 308 at 320 MiB). Compare arms within one mode, never across. A boot benchmark stays a boot.

## The snapshot probe

`bench/snapz/probe.ts` times a snapshot's load and its saves on the page, by the page's own phases (docs/frontend.md
"Snapshots": `#message`'s `data-load` and `data-snapshot`), for the SNAPZ track (`bench/boot/REPORT.md` "SNAPZ loop 0"
on). Dev-only, alone like any Chromium session:

    WAARM64_PROFILE=target/snapz/profile WAARM64_DOWNLOADS=target/snapz/downloads ROUNDS=3 \
      node bench/snapz/probe.ts <desktop|debian> [out.json]
    node bench/snapz/probe-summary.ts <out.json>... [--json <summary.json>]

- **The guests:** `desktop` loads `target/snapbench/pages.waarm64snap` (Firefox on a still page, 689 MB; above,
  "Starting from a snapshot"), `debian` `target/snapbench/debian-go.waarm64snap` (logged in, ~100 MB); `SNAPSHOT=<file>`
  another of the same machine. A round: the file loaded (Load snapshot), then, `SETTLE_S` (20) apart, a kept snapshot,
  the machine started from it (`keptStart`: the Snapshots tab's Restore, the overlay replaced; the snapshot deleted
  after), a file (Save a snapshot to a file: a download, deleted after), a picked file (`picked`: the same with the picker
returning an OPFS file, removed after; a staged save's copy after the resume is its `phases.copy`, in its wall time)
and a Suspend, then the page opened
  again (the resume). Each operation's wall time and phases, and for a save the browser's RSS and PSS (its processes:
  the one with the profile and its descendants, from `/proc/<pid>/smaps_rollup`) before it and at its peak (sampled
  every 250 ms), go to the JSON (default `bench/results/local/snapz-probe/`); `probe-summary.ts` gives medians and
  ranges per operation. Alternate arms by rounds of their own, each in a browser of its own (`ROUNDS=1`: the
  browser's memory grows within a session), an arm being its tree checked out and its wasm copied into the build's
  path (`bench/boot/results/snapz-1/run-ab.sh` and `merge.ts`, which joins the rounds into one file an arm; loop 2's
  `snapz-2/run-ab.sh` for arms that differ in JS only). Since loop 2 a save's `scan`, `compress` and `crc` are the
  pool's workers' sums (CPU time; `pool` says how many): compare its wall by `ram` and `pausedMs`. A pause of ~1 s
  gets ~4 of the 250 ms memory samples: its peak is coarse. **By process:** `bench/snapz/memwatch.ts <profile>
  <out.jsonl> [<stop-file>]` beside it samples every 50 ms (`MS`) each of the browser's processes by type (browser,
  renderer, gpu-process, utility by sub-type: RSS, anonymous, shmem), node's modules only, so one copy serves every
  arm (loop 2b's `bench/boot/results/snapz-2b/run-ab.sh` and `summary.py`, which takes each save's peak against the
  sample before it). The renderer holds the page and all its workers: a save's garbage shows there.
- **A stored machine:** the warm files were saved by transient machines (opened by URL), which keep no snapshots, so
  the probe makes "SNAPZ desktop" (or debian) in the profile, of the files' shape (vCPUs, RAM, 3D, a network card, the
  clock; the disks by URL), and a copy of the file under that machine's header, `target/snapz/<guest>-<hash>.waarm64snap`
  (made once: the header taken from a kept snapshot of the machine's first seconds; its pins name no overlay, so every
  load writes the disk's blocks, replacing the overlay). `MODE=transient` loads the file itself on the transient
  machine and saves to a file only: what `bench/boot/REPORT.md` "SNAPZ: compression across the emulator, measured"
  measured (its 9.8 s load and 4.15-4.25 s pause): loop 0's transient and stored loads were 9.9 and 9.8 s, their file saves' pauses
  4.34 and 4.31 s.
- **A persistent profile, always** (`WAARM64_PROFILE`, a fixed port: `WAARM64_PORT`, default 8197): Playwright's
  default context is off the record, where every OPFS call costs ~250 µs (a desktop save's disk blocks took 2.4 s
  before SNAPZ loop 5's batching, 0.3 s since). To measure that case on purpose, `WAARM64_PROFILE=off`: a fresh
  off-the-record context (the stored machine made again each run; its memory found by the browser's command-line
  flag). `OPS` (comma-separated: `load`, `kept`, `keptStart`, `file`, `picked`, `suspend`, the last with the resume;
  default all) picks a round's operations: off the record loop 5 ran `load,kept,keptStart,file`
  (`bench/boot/results/snapz-5/run-ab.sh`).
- **The disks are URLs on the dev server**, unlike a user's (stored disks, or a remote server): until SNAPZ loop 7 its
  HEADs read the whole image (sirv's), ~1.9 s twice in every desktop load (`prepare` and `start`, 4.3 s of 5.5); loads
  measured before then carry it. Finer than the phases: `bench/boot/results/snapz-7/marks.py` puts timestamps in the
  page and its workers (`UNDO=1` takes them out), into `data-load`'s `marks` and the console (on today's tree:
  `bench/boot/results/perf85/diag-new.py`, the page's start, the GPU worker's and the machine worker's).
- **A run leaves the page by a navigation** (`about:blank`): its `pagehide` clears the mark of a running machine
  (frontend.md "Errors": a tab that went away with its machine running), which a closed browser leaves and which holds the next run's autostart on "the tab closed while
  it was running"; a run killed before its end leaves it, and the next one drops it first.
- **On the Mac's GPU:** `bench/snapz/probe-mac.sh <outdir> <name>=<web dir>...` (arms by their web/ trees, alternated
  by rounds; the desktop's disks copied there, hard links to `bench/gpu/sway-mac.sh`'s copies when they're the same
  files, and the warm snapshot, `SNAPSHOT` (default `target/snapbench/pages.waarm64snap`), each at its fixed path; no
  memory: no /proc; each round's JSON and log moved into `<outdir>`, the probe's profile and saves deleted there: devenv.md
  "The Mac host"). The warm snapshot's caps are SwiftShader's, so it loads with 3D off there: a load's start is
  measured, not the 3D state.
- **The 3D read-back alone:** `bench/snapz/readback.ts` (`WEB=<dir>` an arm's web/, `ROUNDS`, `SAVES`) loads the warm
  desktop's 40 levels into a VirglRenderer on a WebGL2 canvas and times `save()`; `bench/snapz/readback-mac.sh
  <outdir> <name>=<web dir>...` on the Mac's GPU (bench/boot/REPORT.md "PERF loop 85").

## The paired A/B

`bench/ab-mac.sh <outdir> <base>=<core.wasm> <arm>=<core.wasm>[@<tree>][?<query>]...` is the one command for a JIT or
core change's screen on the Mac (`bench/ab.ts` is its driver, which also runs on the dev VM's Chromium, without cycles
and instructions; bench/boot/REPORT.md "BENCH loop 2"). It prints a verdict and stops by itself.

- **Arms.** The first is the base; the others are compared with it, any number. `AA=1` adds `aa`, the base a second
  time: what the same core against itself gives at that moment (the Mac's speed drifts with its temperature, slowly),
  for when a result looks like noise and needs holding against it; the verdict warns when `aa` "differs", and
  `AA=1` with the base alone is an A/A run. It costs an arm's time, so it is off by default (the user, 2026-11-23:
  eight stopped A/A runs all ended `same`). `@<tree>` takes the arm's host code and bench pages from another checkout (a core of another ABI:
  `../waarm64-base`), `?<query>` adds to that arm's page query (`nocw`, `fma=emul`: what `bench/boot/suite.ts`'s
  `boot` reads).
- **A pair** is a freshly launched browser with one page an arm (`bench/boot/pair.ts`: the arm's core compiled once),
  a warm-up sample of each arm and one measured sample of each, one after the other; an arm's sample over the base's
  is the pair's ratio. In every pair the arms draw at random the name their core is served under, the order their
  pages open in and the order they run in. All of it earns its place: arms alternated inside one session have a
  third of the noise of arms in sessions of their own (the clock's single samples 0.32% against 1.57% on the
  userspace workload); a page keeps a speed of its own for as long as it lives (identical cores on two pages stayed
  0.2% apart over 20 rounds, in time and cycles, with equal instructions), so more rounds on the same pages make a
  bias look certain; and with fixed names and a rotating order the base was the fastest of four identical arms in
  four sessions out of four. The warm-up is the workload itself: without one, or after a boot, a pair's ratio spreads
  0.43-0.48% against 0.32% in sessions of 14 pairs, and instructions 0.20% against 0.05%.
- **Workloads** (`WORKLOADS`, default `node`; several with commas, one after the other), deterministic, one vCPU,
  but for `smp`:

  | | a sample | per G step: JIT wasm, dispatches a 1000 steps, interpreted | a pair's time ratio spreads | regions of 16 against 64 |
  |---|---|---|---|---|
  | `boot`: Alpine's boot to power-off (`boot_alpine_jit`) | 3.5 s | 4.3 MiB, 1.8, 5.6% | 0.33% | +5.6% |
  | `user`: Alpine's userspace phases with their boot (`alpine_user_jit`) | 9.4 s | 1.5 MiB, 0.7, 1.9% | 0.38% | +4.2% |
  | `node`: Node running `images/alpine/node/jitjit.js` (image `alpine-node`), timed between its lines | 9.0 s (12.5 with its boot) | 5.6 MiB, 2.3, 5.9% | 0.33% | +1.7% |
  | `smp`: four copies of `jitjit.js` (scale 50) at once on 4 vCPUs, parallel SMP (below) | 9.9 s (12.3 with its boot) | 4.0 MiB, 2.7, 5.8% | 2.5% (1.8% with two copies) | not run |
  | Firefox's pages session, cut to two pages / whole (not a workload of this command: below) | 106 s / 222 s | 2.3 / 1.2 MiB, 2.0 / 1.6, 5.2% / 3.6% | ~1% (sessions) | no change (whole) |

  `node` is the JIT inside the JIT: `jitjit.js` keeps V8 writing, patching and dropping machine code (functions made
  from a template and run through V8's tiers, deoptimizations, one call site over many shapes, regular expressions,
  JSON and the collector between them), 47.5 MiB of JIT wasm in 1452 modules in 9 s, and its check line must be the
  same in every sample of every arm (the run fails otherwise). By its counts and by the one arm with a known answer
  it stands closer to Firefox than the gates do (the calibration below).
  `smp` is the same image on 4 vCPUs in parallel SMP, as the page runs a machine (a worker a vCPU, the compile
  worker, polled code, realtime): `waarm64.par=4` starts four copies of `jitjit.js` at scale 50 at once, so every
  vCPU is busy, the guest's V8s write code on all of them (with their own compile and collector threads beside),
  and the JIT compiles from four tables into one cache through the compile worker (2,500 modules a sample). Its check
  line is the four copies' (`4× jitjit: ce31792e 660`), the same every sample. `?par=N` and `?jj=N` in an arm's
  query change the copies and the scale. Its time is a measure and its only stop measure by default (`STOP` names
  others): parallel SMP's steps aren't fixed work (spins, the guest's scheduling: a sample's steps spread 1.6-2.4%
  a pair), so cycles and instructions a step mean less than on the deterministic workloads, though they still
  carry a CPU cost (the warm-up's below). Each sample also records, over its window (bench/boot/pair.ts `Latency`):
  the share of steps run compiled and in the block interpreter, modules gone overdue and parks, the compile worker's
  modules and busy ms, the delay from a module's emission to `ready` (mean; the buckets of the median, the 99th
  percentile and the longest: web/counters.ts `CompileStat`), and from a 5 ms vCPU timeline (web/profiler.ts
  `summarizeTimeline`) the longest run of rows in which a vCPU inside one core call retired nothing (a compile, V8's
  GC, a lock or a wait on the host), those rows' ms a second and the ms a second out of the core; the verdict prints
  them as the second table's second part. **Its time doesn't screen to ±0.5%**: a pair's ratio spreads 2.5% (12 A/A
  pairs; 1.8% over 8 with two copies), the noise of single samples (their own spread 2.3%: a quarter of the
  renderer's cycles on efficiency cores, how the four copies finish), so 12 pairs give ±2.9% and only a difference
  of ~3% or more is called (24 pairs: ±1.8%). The calibration (bench/boot/REPORT.md "PERF tooling: a multi-vCPU
  paired workload"): `BATCH_STEPS` 100K and the compile worker's warm-up both `open` in time at 12 pairs, the
  warm-up's CPU cost decided (cycles +3.8%, renderer CPU +4.8%) and its counters plain (more interpreted steps,
  `ready` 1.3 ms against 0.3). A pair of the base and one arm is ~62 s, ~92 s with a second arm; four arms' pages
  peaked at 3.2 GiB, no limit needed.
  The pages session itself stays the confirmation: `PAGES=wiki,mdn bench/gpu/ab-mac.sh` halves it (106 s a session,
  77% of the whole session's code compiled, its starts and loads within 0.65% over four A/A sessions, as the whole
  session's), but sessions in browsers of their own spread a pair ~1%, so ±0.5% would take dozens of pairs.
- **Measures**, lower is better in each: `wall` (ms), `cycles` and `instr` (the renderers', a guest step), `cpu`.
  The counters are every renderer's of the browser (the arm running, the others' idle pages; the driver pauses
  0.3 s between samples so one arm's leftovers stay out of the next's sample).
  The verdict's second table has each arm's memory (all the renderers' footprint at a sample's end: compare arms,
  the level includes the other arms' pages), `emitNs`,
  `compileNs`, the JIT's wasm bytes, its modules and the interpreted steps, and the last line the cores' sizes.
- **The stopping rule.** After every pair from `MIN` (4) on, each measure's ratios give a t interval; the workload
  ends when every arm's `STOP` measures (`cycles,wall`; `wall` on `smp`) are each decided, `LOWER` or `HIGHER` (the interval excludes
  zero) or `same` (it lies inside ±`BAND`, 0.5%), or at `CAP` (12 pairs) or `BUDGET` (1500 s for the whole run: a
  workload it leaves no time for isn't run, and the verdict says so), where what is still
  `open` is reported as such with its interval. An arm decided before the others stops running: its verdict is
  the one it had, and the later pairs are the base and the arms still open (the A/A arm runs while any does); the
  table's `pairs` column is each arm's. `CAP` was 24 until PERF loop 65: four arms on `node` took ~42 minutes to
  reach it, held there by the one arm left open; at 12 an interval is ±0.38-0.44% (its tail, 0.2% a look for
  4-12 pairs, is wider than 4-24's), so an arm open at the cap is within about ±0.5% of the base: under the
  floor. `CAP=24` when a row needs the narrower interval, said in its report. (The check run of the change, `bench/boot/results/perf65/cap12-check/`: on
  `boot`, 200K batches against 50K decided at pair 6 and stopped running; 25K ran on alone to the cap, `open`.) A stop measure the host doesn't count (cycles on the dev VM) doesn't
  hold the stop; a mistyped one is refused. Looking after every pair is paid for: each interval is read at the
  tail that keeps a true null's chance of being called a difference at any look at `OVERALL` (1% an interval, so
  several arms and measures each take that chance; `lookAlpha` in `bench/stats.ts`, 0.2% a look for 4-12 pairs), so an interval after four pairs is wide (±2.3% of time on `user`,
  whose pairs' ratios spread 0.38%) and narrows to ±0.64% by 8 pairs and ±0.44% by 12 (with `CAP=24`: ±0.47% by
  12 and ±0.28% by 24).
- **How long a verdict takes** (the rule replayed over 96 measured A/A pairs of `user` and 41 of `boot`,
  `bench/boot/results/bench2/replay.txt`; a pair of the base and one arm is ~40 s on `user`, ~52 s on `node`
  and ~15 s on `boot`, half as much again with `aa` or a second arm, 20 s of set-up a run; `node` takes the pairs `boot` does: `bench3/replay.txt`): a difference of 2% or more in 4 pairs (3 min on `user`, just over 1 on `boot`), 1%
  in 6 (4 min), 0.5% in 10 (16 at the 90th percentile), no difference called `same` in 12 (19: 8-13 min on `user`
  and `node`, 3-4 on `boot`); these were replayed at a cap of 24; at today's 12, what took longer ends `open`. A true 0.25% is inside the band's reach: it ends `HIGHER`, `same` or `open` at the cap. No
  difference is called one in 0.4-0.8% of runs; eight stopped A/A runs on the Mac all ended `same`.
- **Which workload screens what** (bench/boot/REPORT.md "BENCH loop 4": arms whose result on Firefox's pages session
  the reports have, time against the base):

  | Arm | Firefox's pages session | `node` | `user` | `boot` |
  |---|---|---|---|---|
  | regions of 16 blocks for 64 | no change | +1.7% | +4.2% | +5.6% |
  | regions of 32 for 64 | (between: no change) | +0.0% ±0.7 | +1.2% | +2.2% |
  | compile threshold 500/1000 for 1000/2000 | +0.9%, within its noise | +2.3% | −0.1%, same | −0.6% |
  | compile threshold 250/500 | +3.6% | +7.3% | +0.3%, open | +2.1% |

  `node` orders the four as the browser did, about twice as strongly for the threshold, so it is the default and the
  first screen for the JIT's policy (what is compiled, when, how much) and the shape of compiled code. `user` and
  `boot` overstate what longer regions buy a browser by 2-5% and miss most of a lower threshold's cost: they are
  gates for their own guests (a kernel's boot, hot userspace loops), run to see nothing regressed, not to rank a
  change for the browser. None of these three sees a change to parallel SMP or the run loop (one vCPU, deterministic:
  the compiled code carries a step budget, not the page's polls; `smp` runs them, its time to ~±3%): preemption without the budget moved the gates 1-2% and
  the browser 4.7%. That, cache flushes and anything about four vCPUs go to the pages session. A change to the
  interpreter alone wasn't among the arms: `node` interprets the browser's share of its steps (5.9% against 3.6-5.2%),
  which is a reason to expect it to rank one, not a measurement.
- **Read the clock first.** The cycles and instructions are the renderer's, all its threads: V8's compile threads and
  the collector beside the vCPU (12.9 s of CPU in a 9.4 s sample). Regions of 16 blocks against 64 cost 4.2% of
  `user`'s time and 5.6% of `boot`'s, and 1.0% and −0.2% of their cycles. On `node` they point
  the wrong way for regions (16: −6.1% instructions, −4.9% cycles, +1.7% time) and triple a threshold's cost (250/500:
  +12.8% cycles for +7.3% time; on `user` +3.7% for +0.3%): the extra is V8 compiling 44% more wasm on other cores,
  a real cost in cores and energy that the clock of one vCPU doesn't pay. Instructions decide at once when the
  change is to how many instructions the same work takes, and say nothing of waiting, caches or tiers.
- **Running it:** in the background, alone: it takes the CI lock exclusive (the dev VM shares the Mac's cores), is
  bounded on the Mac and here, moves the run's output back from there (also from a run that was ended), and ends
  with `bench/gpu/mac-leftovers.sh --kill`. `<outdir>/ab.json` has every
  sample in the order run (`node bench/ab.ts --analyze <outdir>` prints the verdict again), `log.txt` each pair as it
  ran. Build each arm into a file of its own first (`cp` the wasm aside; restore the source and rebuild after).

## Screening an A/B

**The tiers for a JIT or core change** (the BENCH track, 2026-11-23), cheapest first, on the Mac:

1. **Counts** from a diagnostic build, wherever they can decide (minutes, any host).
2. **`bench/ab-mac.sh <outdir> base=<core> new=<core>`** on `node`, its default ("The paired A/B"): 4-10 min for one
   arm, a verdict to ±0.5%. `node` ranks a change for the browser. Beside it, a short multi-vCPU measure for what one
   vCPU can't show (parallel SMP, the compile worker, the run loop): for time, the parallel boots (`smp_alpine_jit`,
   `smp_user_jit_4`, three rounds alternated, a ~1% floor); for latency under JIT churn and the CPU cost, the paired
   command's `smp` (`WORKLOADS=smp`, ~13 min for one arm at the cap: its counters a sample, its time only to ~±3%).
3. **Firefox's pages session** (`bench/gpu/ab-mac.sh`, "Starting from a snapshot"), `PAGES=wiki,mdn` first (106 s a
   session) and whole (222 s) for a result that will be quoted: the confirmation of what passed 2, not a first
   screen (it is the slowest). Its pairs spread ~1%: three rounds settle 2% or more, nothing under 1%.
4. **The same paired command on `WORKLOADS=user,boot`** last, only for the arm about to be kept: the check that the
   kernel's boot and hot userspace loops didn't regress (~10 min). A win on these one-vCPU gates alone doesn't keep
   an arm (PERF loops 65 and 66: `BATCH_STEPS` 100K and `REGION_AFTER` 250 won there and tied in the browser); for
   a change aimed at the gates themselves they are the measure, and come first.

What follows screens the code cache's policies, which need a cache that fills.

The pages session at 320 MiB no longer flushes, so it doesn't exercise the cache a JIT lane tunes, and its counts
decide within its first two pages (`m8-snapbench/cut.txt`: at 120 s from the snapshot the compiled share was 97.5-97.7%
at 160 MiB against 98.6% at 320 in all six sessions of 320, the A/A within 0.1 point). So:

1. **Screen on counts, with the churn page, from the snapshot.** `PHASES=churn CHURN='rate=60&total=4000'
   CHURN_S=300 FROM=target/snapbench/pages.waarm64snap bash bench/gpu/ab.sh <outdir> 1 <arms…> base2=<base copy>`:
   `bench/gpu/firefox/churn.html` makes JavaScript functions from a template (operators, constants, branches and loops
   varied by their number) and calls each past SpiderMonkey's Baseline and Ion thresholds, so the guest writes new
   machine code all the time; `rate` (functions a second), `calls`, `n` (a call's loop trips) and `total` set the
   cache's fill; `hot=<n>` calls the last n functions made again every frame (a reused hot set beside the churn).
   With `total` the work is fixed and the phase ends when it's done (`doneS`): ~215 s a session, 11 for
   the restore, ~135 for the churn. At 320 MiB it flushes 53 s after the page is ready (`rate=40` without `total`:
   two flushes in 180 s); at 160 MiB 26 s, twice. An A/A arm in every run gives the noise band (main against a copy:
   flushes, modules within 0.3%, wasm MB within 0.6%, compiled share within 0.1 point, `doneS` within 0.6 s).
   Five variants and the A/A: ~22 min. The churn's functions run once and die: it tests the cache's fill and its
   flushes' cost, not how a policy keeps a reused hot set (the pages and the sites do).
2. **Then time only the winner** against the base on the full pages session from the snapshot (three rounds
   alternating, busy MIPS and the heavy pages' loads; at least an A/A once per session of runs), and its gates.
3. **Real sites** (opt-in, benchmarks only, never in CI): `tests/net/tailcat.sh up`, then `TAILCAT=rig PHASES=sites`:
   the page's adapter connected to the rig's exit node, the guest on IPv4 only (the dev VM has no IPv6 out: its IPv6
   default route dropped, DNS at 1.1.1.1, IPv4 preferred, Firefox's `network.dns.disableIPv6`), a curl checked, then
   `bench/gpu/firefox/sites.html` opens `SITES` (a video watch page, three news sites, two web apps by default) in one
   tab, `DWELL_S` (20) each, `CYCLES` times; `results.sites` has the URLs and each visit's time. `GUEST_BROWSER=chromium` opens
   them in the guest's Chromium instead (`target/arch/desktop.qcow2`, `WAARM64_GUEST_USER=arch`: the image with it,
   booted, not the pages snapshot). Real sites change
   daily: an A/A in the same run as each A/B, arms close in time. Six sites at 20 s each didn't flush at 320 MiB (264
   MB in 130 s, against the churn's 424 MB in 120 s): longer runs or more cycles to see a flush.
4. **The `go build` loop** from `debian-go.waarm64snap`: `bench/stress/go-ab.sh <outdir> <rounds> <arm>=<core>…` (4
   vCPUs building `/work/hello` from goroot.ext4 over and over, 420 s a session, each build timed by the guest in
   ms), then `node bench/stress/gobuild.ts <outdir>/[!w]*.jsonl`: per session the median build after the first three
   (the cold ones), per arm the sessions' medians. Judge by the build times, never the MIPS samples (those spread
   1,094-1,489 across sessions of one core; the build times of three sessions agreed within 0.3%). The run's first
   session built 6.6% slower than the rest, so the driver runs a warm-up session first and drops it
   (`bench/interp/REPORT.md` "M8-INTERP loop 11"). Sessions can also fall into two modes ~6% apart with one core (30.1-30.6 s
   against 31.7-32.3 s, each arm in both, `bench/interp/REPORT.md` "SUBS's NZCV from its operands"; the mode shows by
   the second build), so a few sessions a side don't resolve a small difference.

## Rules

- **Don't claim a speedup or regression without `bench/run.ts` numbers in Chromium.** Report
  medians and IQR (take `iqr` from the JSON, never by hand), the host and the Chromium version.
- **Commit the result JSON behind any written report** (`bench/*/results/<milestone>-<loop>/`);
  ad-hoc runs stay in `bench/results/local/`.
- **On the Mac, a core's A/B is `bench/ab-mac.sh`** ("The paired A/B"): a difference is what its verdict calls
  `LOWER` or `HIGHER` in time (the interval of the pairs' ratios excludes zero), no difference what it calls `same`
  (inside ±0.5%), and `open` is neither. Report the interval, the pairs and the workload; the renderer's cycles and
  instructions beside it, never for it.
- **Time that moves while the code doesn't:** when an arm's JIT wasm, instructions and cycles are the base's within
  ~0.1% and only time moves by ~0.5%, the difference can still be real (CPU caches, memory bandwidth, code
  placement), but more pairs of the same workload won't settle it. Give that workload a few more pairs at most
  (within its cap), then try other workloads that may exercise the change differently (the gates, the parallel
  boots, the pages session when it's warranted); a difference none of them confirms is reported as within noise
  (PERF loop 64: regions past 64 blocks, −0.5% `LOWER` at 96 on the same wasm, instructions and cycles, run to 24
  pairs of `node` alone). For a constant's sweep, look at the first pairs' compile counters (`regionBlocks`, the
  wasm, modules in `ab.json`): they show whether an arm changes the code at all.
- **The noise floor of alternated sessions** (the dev VM, the pages session, anything the paired command doesn't
  run): compare builds **A/B in one session, alternating**, three
  rounds or more (`bench/interp/ab.sh`). A difference counts when every round of one arm beats every
  round of the other and it's past ~1%; Buildroot's boot, whose rounds spread 2-3%, needs ~3%. On
  the idle dev VM a build's per-round medians of the yardstick stay within ~0.5% (Alpine's boot
  0.2-0.8 MIPS of ~180, the small guests ~0.5% bar a rare outlier round; `bench/interp/REPORT.md`
  "M8-INTERP loop 8"). Boots are compared only within one session (the host's state moves runs by
  up to ~8% between sessions); check the interpreter's number in the same JSON to see the host's
  state.
- **The small guests run at eight guest-RAM placements** (the placement effect, [v8.md](v8.md)):
  never rank builds on one placement.
- **Rank a JIT or core change for the browser by `node`** (the paired command's default: a JIT inside the JIT, which
  ordered four known changes as Firefox's pages session did), then the pages session; Alpine's boot and userspace
  are gates for their own guests, which rank longer regions 2-6% above what a browser gets and miss a compile
  threshold's cost ("The paired A/B", "Which workload screens what").
- **Among the gates, rank by the long, real workloads** (Alpine boot, Alpine userspace) first. Debian has no benchmark since M8 phase B (its direct-boot ones timed only a boot and power-off; the page's boot times are in the page tests' logs).
  **Don't optimize for very short runs:** the Buildroot boot (< 1 s) is a check, not a target; a
  change that makes it even ~50% slower but speeds a distro boot up by 5–10% is worth keeping, and
  the synthetic small guests may lose a few percent for such gains. Report the losses with
  numbers.
- **Don't fit the design to CoreMark:** well-optimized wasm runs 10–30% behind native on
  compute-bound code; CoreMark is at ~70% of QEMU TCG.
- **The dev VM pays explicit wasm bounds checks that macOS and x86_64 don't** (47% of the userspace
  benchmark: [v8.md](v8.md)). For what a macOS user gets, and before ranking work by a profile
  taken here, run the page on the Mac host's Chromium: `bench/run-mac.sh <name> --page
  bench/boot/index.html --only alpine_user_jit` (it copies the pages, the core and the Alpine and
  Buildroot images to `~/waarm64-bench.noindex` there; `WASM=` picks a core; the Mac side's run is bounded by `MAC_TIMEOUT`, 580 s by default; results are
  moved back into `bench/results/local/mac/`, as every `*-mac.sh` moves its run's output: devenv.md "The Mac host"). `--config bounds-checks` there shows the checks' cost on one machine.
- Benchmarks run in the dev VM on the M4. Keep the `oracle` VM idle, check `ps` for leftover
  experiments first, and don't rebuild or edit served sources while a benchmark runs.
- **Keep every benchmark command under the Bash tool's ~600 s cap** (fewer boots per call, or
  `--quick`), with a `timeout`; a command that overruns gets backgrounded and can stall unseen.
- Numbers from the x86_64 desktop (M0–M5 step 7) aren't comparable with the VM's.
- The Buildroot guests (`boot_jit*`, `boot_mips_jit`, the LTP run) changed on 2026-10-23: built with
  Buildroot's own toolchain (gcc 15.3, glibc 2.44) instead of Bootlin's, their step counts moved
  (Buildroot's boot 40,054,752 → 40,543,331); compare their numbers only from then on.
- **Peer comparisons are rare:** QEMU TCG, native and in-browser peers were measured once, for
  M6's exit table; performance work compares waarm64 with itself. **qemu-wasm is dropped for good**
  (it booted Buildroot 4.7× slower than waarm64, computes CoreMark wrong, looks abandoned); x86 peers
  (v86, JSLinux, WebVM) only as published context.

## Current numbers

Chromium 153 on the M4 VM, JIT, crypto extensions on. waarm64's boots, userspace and CoreMark are
from 2026-10-02 (`bench/boot/REPORT.md` "M8: regions across pages"; before that day's JIT changes:
674 ms, 9.96 s, 24.1 s, 8602 it/s); the rest and the peers are M6's exit table and M6.5's exit
(`bench/interp/REPORT.md`):

| | waarm64 | QEMU TCG (same VM) | native (M4) |
|---|---|---|---|
| Buildroot boot to power-off, cold | 802 ms | 0.30 s | 0.10 s (hvf) |
| Alpine boot to power-off, cold | 9.9 s | 5.4–5.6 s | 2.4 s (hvf) |
| Alpine userspace | 20.5 s (compress 2.4, Lua 3.7, churn 2.0, SQLite 2.9); **14.6 s on the Mac host** (1.9, 3.2, 1.1, 2.3) | 11.2 s | 2.9 s (hvf) |
| Debian 13 boot to power-off | 42.2 s | 31.3 s | 2.4 s (hvf) |
| CoreMark, user mode | 10,080 it/s | 12,500 | 61,111 |
| integer / FP guest | 5175 / 155 MIPS; FP guest 707 MIPS from 2026-10-14 (inline FMA, `bench/interp/REPORT.md` "M8: inline FMA"), 1,405 from 2026-10-18 ("M8: the FP fast paths' SIMD ops") | | |
| EL1 guest, MMU off / on | 4932 / 4045 MIPS | | |
| `openssl speed` 16 KiB: AES-128-GCM / AES-128-CBC / SHA-256 | 232 / 151 / 298 MB/s | | |

Parallel SMP (`bench/boot/REPORT.md` "M7 loop 8"): Alpine to its script 8.4 / 9.1 / 10.1 s on 1 /
2 / 4 vCPUs, Debian 42.3 / 33.5 / 29.6 s; the userspace phases with N copies of the work 25.2 /
27.3 / 31.6 s (compute phases 3.4–3.8× throughput at 4, process churn 1.7×).

Interpreter: ~143 MIPS integer, ~20 FP; Alpine boots in 46.9 s interpreted. The block interpreter alone (2026-10-21,
`bench/interp/REPORT.md` "M8-INTERP loop 4"): 424 MIPS on the user-mode guest, 412-416 at EL1, 114 on Buildroot's boot
and 172 on Alpine's (15.4 s). **Its yardstick** (`bench/interp/yardstick.sh <outdir> <label> [core.wasm] [bench…]`:
those five, one `bench/run.ts` call each under a cap; `CONFIG=liftoff-only` the reference set); `bench/interp/ab.sh
<outdir> <rounds> <name>=<core.wasm>… [-- bench…]` alternates core builds on it and `node bench/interp/ab-summary.ts
<outdir>` sums them up (the arm that sorts first is the base); `bench/interp/ab-mac.sh` does the same on the Mac
host; on a host whose speed drifts (a cloud session, where the rounds spread past the effect),
`bench/interp/paired.ts` runs the arms' small guests side by side in one process, alternating 20M-step chunks in a
shuffled order, so a sample is a paired ratio (`node bench/interp/paired.ts <iterations> <name>=<core.wasm>…`, or
in Chromium `bench/run.ts --page bench/interp/paired.html --query='arms=<name>=<core.wasm>,…&iters=60'` over several
sessions; `--summary <json>…` pools them; an A/A arm shows its floor, ~±1% a session); `node bench/interp/boot-node.ts [buildroot|alpine] [jit]` boots in Node for `perf`. I/O (M4 step 7,
interpreter era): fio random 4 KiB reads ~1,800 IOPS, 9p ~14–25 MiB/s, ~2,660 full-size pings/s.

## Workloads still planned

| KPI | Workload |
|---|---|
| Mixed / realistic | `7z b`, compiling a C file with GCC in the guest (heavy code churn); a browser: `bench/apps/` (above) |
| Kernel paths | lmbench `lat_syscall`, `lat_pagefault`, `lat_ctx` |
| JIT behavior | compile latency p50/p99, % time interpreted, code bytes, invalidations |
| SMP (M7) | parallel `make` (not in the image yet) |
| I/O | a write benchmark (a scratch disk behind an overlay); re-run 9p and net under the JIT |

## Counters

A benchmark run on the Mac records the browser's CPU counters beside its times (bench/boot/REPORT.md "BENCH loop 1"):
macOS's `proc_pid_rusage` gives a process's instructions retired, cycles, CPU time, their part on performance cores
and energy (`bench/mac/procstat.c`, built there by `bench/run-mac.sh` and `bench/gpu/sway-mac.sh`), and
`bench/procstat.ts` sums them over the renderers of the harness's Chromium. On Linux it gives CPU time only.

- **The gates** (`bench/run.ts`, bench/boot's suite): each `<name>_total` has `_cpu_ms`, `_ginstr`, `_gcycles`,
  `_instr_step` and `_cycles_step` (per guest step), `_pshare` (the cycles' share on performance cores) and `_joules`,
  read around each boot (`?proc=<port>`: a local server of the runner's). They are the sum over the renderer's threads,
  V8's compile threads included: "The paired A/B" says what that hides.
- **A guest session** (`bench/gpu/firefox-load.ts`): `results.json`'s `proc`, from the set-up to the last phase's
  end, with the guest's steps over it; `bench/gpu/ab-summary.ts` shows `cpuS`, `ginstr`, `gcycles`, `instrStep`,
  `cyclesStep`, `pshare`.
- **How tight they are** (an A/A on the M4, single samples' coefficient of variation): on the deterministic gates
  instructions a step 0.06-0.07% against the clock's 0.7-1.6%, cycles a step 0.5-0.7%; on the pages session
  instructions 0.28% against `pagesS`'s 0.69% (four sessions), cycles no tighter than the clock. Parallel boots'
  work differs run to run: only their runs' medians are tight.
- **What they don't replace:** instructions miss cache misses, mispredictions and dependency chains. Read them
  beside time, not for it: they are all the renderer's threads', and for regions and compile thresholds they
  pointed the wrong way or several times too far ("The paired A/B", "Read the clock first"). Between runs in
  browsers of their own, one whose P-core share is low ran partly on efficiency cores (on the userspace gate that
  share explained nearly all of the clock's noise); between arms alternated in one browser it explains nothing.

## Instrumentation and profiling

- **Counters** in shared memory ([abi.md](abi.md) "Counters"): steps, exceptions by EC, IRQs, TLB
  misses/walks/flushes, the JIT's compile and execution statistics, and parallel SMP's (DSB waits
  and their time, broadcasts, drains, idles, platform-lock contention, WFEs, time out of the core),
  per vCPU (`cpuStats()`). The benchmarks record them in
  each result's params.
- **The helper histogram** (`jit_helper_report`, `web/counters.ts` `helperReport`): helper calls by
  instruction class, most frequent first; it says what to inline next.
- **PC sampling** (`web/sampler-worker.ts`, `node bench/boot/profile.ts`): reads `Counters.pc` every
  20 µs beside the vCPU worker; symbolized with `System.map` (user space as one bucket). The PC is
  published once per chunk, so its resolution is a chunk (32K steps): coarse under the JIT. A chunk also ends
  at an exit, so a sample names where the current chunk started (the instruction after the last exit: counter
  reads, IRQ unmasks, syscall entries rank high). On the page (`?displaystats`): `window.__waarm64Profile(on)`
  samples every vCPU's block, the histogram lands in `window.__profile`, and `window.__status` holds the last
  status (the counters); while it runs the vCPUs publish their PC every 256 steps (`vm_set_chunk`, parallel
  mode only), so a sample is where the vCPU is, not the exit that started its chunk (the exit sites' share fell to a
  fifth on sway's load). `PROFILE=1` in `bench/gpu/sway-load.ts` and `bench/gpu/gtk4-load.ts` uses it
  and symbolizes in the guest (`/proc/kallsyms`; guest-session.ts `sampler`, `symbolize`). The sampler's worker
  busy-polls and takes a host core: on the dev VM a GTK demo ran at half its speed while sampled (the 256-step
  chunks cost nothing measurable beside it).
- **Guest sessions** (`bench/gpu/guest-session.ts`: sway-load, firefox-load, gtk4-load, avsync; on the Mac through
  `sway-mac.sh`; `bench/gpu/guest-shell.ts` keeps one open for experiments, driven by files): a phase (`load`) records the guest's CPUs, every process's CPU (its /proc stat: threads that exited
  count), every thread over 2 ms a second with schedstat's runs and run-queue wait (read back from a file: the serial
  terminal holds a screenful), and the display's, renderer's and emulator's counters. `SYSCALLS=1` adds the syscalls
  by thread (a kprobe event on `do_el0_svc` into a 16 MiB-a-CPU ring buffer: Arch's kernel has no syscall
  tracepoints; each syscall then traps, so count drops and CPU from runs without it). `TIMELINE=1` records the **vCPU
  timeline** (`web/timeline-worker.ts`, `window.__waarm64Timeline(on)`: every vCPU's counters and liveness slot every 10
  ms, sleeping between reads; `summarizeTimeline`: MIPS, compile and out-of-call time, and **stalls**, 10 ms bins
  inside one `vm_run_cpu` call that retired nothing; a vCPU publishes at a chunk's end, so a stall's compile time shows
  in the bin after it). An install of JIT code over 20 ms logs a `waarm64-slow install` line (its compile,
  instantiation, GC and size), collected into results' `slow`. `sway-mac.sh` samples the Mac's `vm_stat` each second
  (`<name>.vmstat`): its memory is overcommitted by the Lima VMs (graphics.md "Video's measurements"), which shows in latency. Firefox's
  start-up work runs ~30 s past its window: measure steady state at least that long after a launch (`WARM_S`).
  firefox-load's `TIMELINE_ALL=1` records the timeline over its whole `pages` phase (every Firefox start and load,
  where the JIT compiles most), and `QUERY` adds to the page's query (`jit=nocw`: the JIT without its compile
  worker, for A/B). `bench/gpu/stalls.ts` counts a timeline's stalls by length (`--json` for results).
- **Firefox's pages session, the JIT's real workload** (M8; `bench/boot/REPORT.md` from "M8: warm members" on):
  `PHASES=pages TIMELINE_ALL=1 WAARM64_GUEST_USER=alarm node bench/gpu/firefox-load.ts virgl
  target/archarm/desktop.qcow2 <outdir>`, Arch Linux ARM's disk, which every JIT number so far is on (the Arch images
  moved to arch.bens.haus's port, `target/arch/desktop.qcow2`, user `arch`: re-baseline there before comparing across
  disks). ~380 s of pages, ~750 s with the boot and Firefox's start: in the background, `timeout 900`, under
  `systemd-run --user --scope -p MemoryMax=10G -p MemorySwapMax=0`, nothing else Chromium-heavy beside it, and no
  outer timeout shorter than the session around an A/B loop (it kills the loop and leaves the session running).
  Busy MIPS from `bench/gpu/stalls.ts <outdir>/pages-all.timeline.json`; `results.json`'s `jit` has the wasm bytes,
  modules and flushes; each page's `fpsAll` (every second's frames and longest gap since its start, from
  `readyAt` on the host's clock) lines up with the timeline, whose rows also carry each vCPU's `jitSteps` and
  `flushes`; `bench/boot/results/m8-replay/flushes.ts` reads both per flush. `JITLOG=1` logs the JIT's counters once
  a second (`<outdir>/jit.jsonl`; `bench/boot/results/m8-replay/counts.ts report` per flush: the wasm alive before and
  after), with the compile worker's counters as `cw` (the status's `compile`: its busy ms, each module's wait from
  emission to `ready` as a sum and log2 buckets); `bench/boot/results/perf67b/latency.ts` reads them with the
  timeline (`KEEP_TIMELINES=1`) and the frames per page: the compiled share around each Firefox start, the worker's
  busy share, the waits, Firefox's frame gaps and the vCPU stalls. `bench/gpu/ab-mac.sh` takes a page query per arm
  as `QUERY_<arm>`. The renderer's memory: `bench/boot/results/m8-replay/r2/rss.sh <out> [s]` beside the session (the biggest
  `--type=renderer` process's RSS and its executable anonymous mappings, V8's wasm code, every 5 s). At the 320 MiB
  budget the session doesn't flush (it did twice at 160). A/B two sessions each at least,
  alternating: by `QUERY` for a mode the page takes (`jit=nocw`), or by swapping core builds
  (`bench/boot/results/m8-warm/tools/abw.sh`, `cmp` before each run). The gates beside it:
  `tools/tpw.sh` there (`smp_alpine_jit`, `smp_user_jit_4`, three rounds alternating; `bench/run.ts --query=nocw`
  reaches bench/boot's worker). Lessons from those sessions:
  - Browser workloads drift within a session and ~10% between sessions: the baseline in the same session,
    alternating (≥4 pairs for `bench/apps`), reported by pairs. Copying rounds of A/B JSON into one directory: prefix
    each round.
  - The numbers understate interactive gains (the user felt browsing 1.5-2× faster after warm members, the compile
    worker and the yielding vCPUs, more than busy MIPS showed): don't drop a lever only because its busy-MIPS gain is
    small; measure latency to input or frame pacing (`fpsAll`) when a lever's case rests on it. And the converse: a
    synthetic latency win can be nothing on the real workload (a busy vCPU's ping 17% faster, Firefox unchanged).
  - A stall a profile moves isn't a stall removed: compare guest code's total share, not only one spot's.
  - The A/B loops leave the last build they copied in `target/`, newer than the sources (cargo won't rebuild it): copy
    the build you mean back and `cmp` before CI or a profiled run. A host change both builds share needs a baseline
    built against it (a core of the old ABI under the new host fails): build it from the new source with the
    mechanism switched off.
  - A Node gain may not reach Chromium (scalar `UQSUB` inline: compress −9.5% in Node, nothing in Chromium); four
    concurrent guests slow each other down on this host (4 P-cores, 6 E-cores: Lua 3–6%, compress 22%), so compare
    N-vCPU runs with N-vCPU runs; the Mac host shares its cores with the VM (run nothing there meanwhile; a failed
    page leaves `bench/run.ts` and Chrome for Testing idle there).
  - Every install as a `waarm64-slow` line: `SLOW_INSTALL_MS = 0` in `web/jit-host.ts` (57,000 a session, 8.8 MB of
    `results.json`, busy MIPS unchanged).
  - Diagnostic counters without new ABI: `<letter>:<n> <count>` lines appended to `Table::helper_report`
    (`bench/boot/userprof.ts` prints them per phase; patches in `bench/boot/results/m8-userprof/`, `m8-entries/`,
    `m8-devlat/`). `vm::Counters` are summed over the tables by the host, so a value written into one table's
    `Stats` comes back summed: log lines say which table and when. Check a diagnostic against a case whose answer
    you know first (per-table state in `Seen` vanishes at every flush and `IC IALLU`: "cold" once meant install age).
  - Where a timer sample lands inside JIT code says what stalls: it blames the oldest instruction not retired, so a
    function's first instruction collects the frontend's waits for its code (the core's own functions, 0.2-1% at
    entry, are the control); V8's x16/x17 at an entry tell a `call_indirect` (the signature id, which a
    `--perf-prof` session changes) from a tail call. `bench/boot/results/m8-warm/tools/run-jd.sh` (a 10.8 GB
    jitdump; busy MIPS fall ~10% under it; V8's isolate logs land in the cwd) and `jd`, `run-regs.sh` and `jdr`;
    keep perf data and traces in `bench/results/local/` (`/tmp` is a 6.9 GB tmpfs). The desktop guest's kernel
    symbols: `System.map` from `/usr/lib/modules/*/build`, `Image` from the ESP (`mcopy -i <raw>@@1048576 ::/image`;
    not randomized).
  - A microbenchmark that doesn't reproduce a stall can still clear suspects in minutes (the never-yielding worker
    cleared `performance.now()`, Atomics and dying modules); then build the fix behind a switch and A/B the real
    session rather than chase the last cause. In a microbenchmark LLVM deletes an `alloc`/`dealloc` pair nothing
    uses: pass the pointer through `core::hint::black_box`.
  - `scripts/build-wasm.sh` is incremental (~4 s for a small change): check the file's time or `cmp` it against
    saved copies rather than trusting the build's duration.
  - An arm64 `ldr` folds offsets up to 32,760 (8 bytes), 65,520 (`q`), 4,095 (a byte); past that V8 builds the
    constant with `mov`+`movk` at every use, which a timer profile won't show: count such pairs in a hot function's
    disassembly (`ann.sh`).
- **The JIT's compile worker A/B:** `bench/run.ts --query=nocw` turns it off in `bench/boot` (the bench page passes
  its query to its worker); the page takes `?jit=nocw`.
- **The fused FMA A/B:** `bench/run.ts --query=fma=emul` forces the emulation in `bench/interp` and `bench/boot`, the
  same build; the page takes `?fma=emul`.
- **perf with parallel SMP:** `--perf-prof`'s jitdump misses the code worker isolates compile (the
  guest's blocks run in the vCPU workers: 73% of samples unknown); `--perf-basic-prof` (a
  `/tmp/perf-<pid>.map`) names them. Guest blocks are thousands of symbols that round to 0.00% in
  `perf report`: aggregate `perf script -F tid,time,ip,sym` by guest VA (`<va>_pa<pa>` names) and
  the kernel's System.map (Alpine's is in its rootfs, `/boot/System.map-*`). The VM has no PMU.
- **The userspace benchmark by phase** (Node): `bench/boot/userprof.ts` runs `alpine_user_jit`'s guest and
  prints each phase's time, MIPS, dispatches, helper calls and counters, and saves the phase markers'
  monotonic times; under `perf record -k mono … node --perf-prof` its samples are split by phase and
  category (guest code by V8 tier, the dispatcher, the interpreter, V8's compiles) with
  `bench/boot/userprof-perf.ts` (usage in both files' headers). `bench/boot/results/m8-userprof/*.patch`
  are diagnostic builds of the core (why blocks returned to the dispatcher; transfers between blocks by
  kind) that the first tool also prints: apply (they're diffs against the commit their REPORT section names), build,
  run, and **restore the source and rebuild**.
- **perf with V8's `--perf-prof`** (dev-only tool): `perf record -k mono -F 2000 -o x.data node
  --perf-prof …; perf inject -j -i x.data -o x.jit.data; perf report -i x.jit.data --no-children
  --sort sym`; `perf annotate -s "JS:<name>-<n>-turbofan"` for machine code with samples. Run from
  a scratch directory (jitdump files land in the cwd). `perf_event_paranoid` is 2: profile your
  own processes.
- **Machine code:** `tools/v8code.ts` (Node `--print-wasm-code`, by JIT function name). **Emitted
  modules:** dump them from `web/jit-host.ts`'s install temporarily (`if (process.env.X)
  fs.writeFileSync(…)`, and remove it before any Chromium run: `process` doesn't exist there),
  then `wasm-tools print` (shows branch hints) or `wasm-tools validate`.
- **The JIT's machine code, x64 and arm64** (for a change to what the JIT emits; x64 has 16 GPRs where arm64 has 31,
  so spills differ): `node bench/jit/dump-modules.ts <dir> [--wasm core.wasm] [--guest alpine|buildroot]` boots the
  guest in Node deterministically with `WebAssembly.Module` wrapped and saves every module the JIT installs
  (`m<n>.wasm`, the core not; `index.json`: the core's SHA256, steps, modules); Alpine's boot gives 319 modules (12 MB)
  in ~5 s, the same set every run of one core. `node bench/jit/codestats.ts <dir> [<dir>…] [--arch arm64,x64]
  [--json f]` compiles each set in a child Node with `--no-liftoff --no-wasm-lazy-compilation --single-threaded
  --print-wasm-code` (on x64 under qemu-user: devenv.md "An x86_64 Node", the same V8) and sums the TurboFan functions'
  instructions, code bytes, stack slots and instructions with a frame-relative memory operand (spills, fills and
  V8's own frame set-up: compare arms, not absolutes), per function against the first set. Alpine's set takes ~20 s
  on arm64 and ~2 min on x64. Numbers: bench/boot/REPORT.md "PERF loop 30". `--parallel N` dumps a parallel SMP
  boot's modules instead (polled code, PERF loop 31): the workers compile them, so the tool reruns itself with every
  thread's `WebAssembly.Module` wrapped (`--import`), each module saved once by its hash; such runs aren't
  reproducible, so compare per-function means of two cores' sets, not the sets.
- **Timer setters** (PERF loop 53): `node bench/run.ts --page bench/boot/timer-setters.html [--query='ms=3000&gap=1000&cpus=4&only=wait,spin,halve,waitAsync,setTimeout']`
  (on the Mac: `bench/run-mac.sh <name> --page bench/boot/timer-setters.html "'--query=…'"`, the quotes for the remote
  shell): how late each way a page has to wake at a deadline stores 0 in a spinning worker's word: `cpus` spinners,
  one setter keeping a deadline for each `gap` µs ± 50% apart, `ms` per mechanism; per mechanism the wake-up against
  the deadline and the spinner's ack (µs), and the setter's spin share of a core and waits a deadline. The page's
  Mac numbers are bench/boot/REPORT.md "PERF loop 53"'s. `preempt-counts.ts` also runs in the Mac's Node, from
  `~/waarm64-bench.noindex` after a `bench/run-mac.sh` (the diagnostic core copied there): today's latencies on that host.
- **An idle guest's host CPU** (PERF loop 58): `node bench/boot/idle-cpu.ts [ncpus=4] [settle s=6] [measure s=20]
  [spin µs]` boots Buildroot's kernel with `/bin/sleep` as init, parallel on N vCPUs under the JIT, and prints the Node
  process's CPU over the measured span as a share of one core, the idle exits a second and the guest's MIPS (~400 idles
  a second at 4 vCPUs; the Mac's Node 7-8% at the default 20 µs poll, the dev VM's ~11%). `spin` is an idle vCPU's poll
  (`VmOptions.vcpuSpinUs`; the pages' and bench pages' query `vspin=<µs>`). On the Mac from `~/waarm64-bench.noindex` after a `bench/run-mac.sh`
  (which copies it there); runs move by ~±0.5 points, so alternate arms over three rounds.
- **Preemption's counts** (a diagnostic core: the `diag` feature, never in the normal build, whose code section it
  leaves byte-identical): `CARGO_TARGET_DIR=target/diag scripts/build-wasm.sh --features diag` (its own target
  directory, ~20 s from cold), then `node bench/boot/preempt-counts.ts [--json f] [boot user smp1 smp4 smp-user4]`
  runs the gates' guests in Node (Alpine's boot and userspace as `boot_alpine_jit` and `alpine_user_jit`; parallel
  realtime: `smp_alpine_jit`'s boot on 1 and 4 vCPUs, `smp_user_jit_4`; ~1 min for all) and prints per 1000 steps
  (by phase for the userspace runs) what compiled code took: region back-edges and forward edges, transfer cache hits
  and miss-function entries, static chains backward (target PA ≤ source PA) and forward (direct, through the jump
  cache, by VA), host calls and returns, polled code's polls (PERF loop 31); how chunks ended (the budget or an exit, by kind, with their mean steps; for
  round-robin runs too since PERF loop 47, with the virtual timer's arming rate, the IRQs taken, the platform exits by
  register, the timer registers' exits by register with those that could have stayed inline (PERF loop 49), and the
  counter-read exits, by phase; the arming rate counts only arming writes that exit); for parallel runs two latencies: a vCPU's own timer line seen past its deadline, and an IRQ line's rise
  (`Vm::refresh`) to its IRQ taken or its WFI completed, and the run loop's time from a chunk that ended by its steps
  to the next one's start (PERF loop 32). `--chunk N` runs the parallel guests with N-step chunks (`vm_set_chunk`), as
  `smp_alpine_jit` and `smp_user_jit*` do with `?chunk=N` (`bench/run.ts --query=chunk=N`). In Chromium the same
  latencies come from `smp_*` with `--query=tallies` and the diagnostic core (`WASM=…` for `bench/run-mac.sh`): each
  boot's timer line seen in WFI and running, mean and max µs, and the WFI wake-ups, as results (PERF loop 60);
  `vyield=N` sets the vCPU workers' event-loop visits (`VmOptions.vcpuYieldMs`; 1: every exit that may takes one), `vspin=N`
  an idle vCPU's poll before it sleeps (`VmOptions.vcpuSpinUs`, µs). The tallies (`core/src/tally.rs`) live in the `Vcpu` and past
  the end of each vCPU's counters block, where the run loops publish them; a diagnostic core runs the same steps as
  the normal one (Alpine's boot: tests/steps.txt's count).
- Node runners for iteration: `bench/interp/suite.ts` `setup(bin, JIT_DEFAULT, pad)` / `setupVm`
  for the small guests; `runToPowerOff` (`web/test-guests.ts`) for boots. `bench/run.ts --out` resolves
  against the repo root.
- **A core panic's stack trace** (`waarm64_core.wasm.<fn> (wasm-function[N]:0x4031a)`): the
  release wasm carries DWARF, so `llvm-symbolizer --obj=target/wasm32-unknown-unknown/release/waarm64_core.wasm
  -i -f 0x4031a` gives the source line, **with the offset as printed** (it's a file offset; don't
  subtract the code section's base). Only for the binary that crashed: keep it before rebuilding.
- The wasm name section (`<va>_pa<pa>`) makes DevTools and `perf` profiles readable.
  (`performance.mark`/`measure` around compile, instantiate, device I/O and boot phases were
  planned and aren't there yet: backlog.)
