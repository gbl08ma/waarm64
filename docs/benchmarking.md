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
| `bench/interp/index.html` | `interp_mips`, `interp_fp_mips`, `vm_flat_mips`, `vm_mmu_mips` (interpreter: user-mode integer and FP/NEON guests, the integer guest at EL1 with the MMU off/on), `jit_mips`, `jit_fp_mips`, `vm_jit_flat_mips`, `vm_jit_mmu_mips`, `coremark_mips`, `jit_coremark_mips` (also reported as iterations/s); `dec_mips`, `vm_dec_flat_mips`, `vm_dec_mmu_mips` (the block interpreter: the dispatcher never compiling, `VmConfig.jit` 4) |
| `bench/boot/index.html` | `boot`, `boot_defconfig`, `boot_alpine` (interpreter), `boot_jit`, `boot_alpine_jit`, `alpine_user_jit` (ms per phase), `coremark_vm_jit` (CoreMark as init, realtime), `alpine_crypto_jit` / `alpine_crypto_ce_jit` (`openssl speed`, extensions off/on, realtime), `gl_llvmpipe_jit` / `_4`, `gl_virgl_jit` / `_4`, `gl_virgl_llvmpipe_jit` / `_4` (ms a frame); I/O: `dd`, `fio`, `p9`, `net` (realtime) |
| `bench/io/index.html` | `io` (fio and dd on a chosen `File` disk under a fresh OPFS overlay: reads, writes, `fsync`, reads of written data; realtime, a boot per sample; `node bench/run.ts --page bench/io/index.html --input target/bench/io-raw.img`, the input from `head -c 256M /dev/urandom`), `io_stats` (per-stage timers of the blk device, one boot per workload) |
| `bench/gpu/index.html` | `webgpu_adapter`, `writebuffer`, `present_canvas2d`, `present_canvas2d_rgba`, `present_webgl2`, `present_webgpu` (G0: ms per frame at 1080p/1440p/4K, full and damaged; needs `--chromium-args`, see `bench/gpu/REPORT.md`; `bench/gpu/run-mac.sh` for the Mac host's real GPU), `flush_cost` (the virtio-gpu backend itself: a transfer, a flush with its draw; no flags needed). Beside the page: `node bench/gpu/page.ts` (Debian on the page, virtio-gpu against the simple framebuffer: first pixel, `running`, key to glyph on the screen and the terminal) and `node bench/gpu/draw-latency.ts`; `node bench/gpu/sway-load.ts` (a compositor's load: sway and foot on the Arch image, the guest's CPU, frames, the stream and, with `VIRGL_GPU=virgl`, the renderer's time; dev-only), `bench/gpu/sway-mac.sh` (the same on the Mac host's GPU); `node bench/gpu/firefox-load.ts` and `node bench/gpu/gtk4-load.ts` (Firefox and gtk4-demo on the Arch image with Firefox, graphics.md §21), `node bench/gpu/deqp-run.ts` (dEQP on the page; images.md) |
| `bench/jit/index.html` | `jit_install`, `jit_first_call` |
| `bench/spike/index.html` | the M0 spike (`node bench/spike/node.ts` in Node) |

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

- Boot benchmarks time cold (a fresh `WebAssembly.compile` per boot) and warm boots, to the
  guest's markers and power-off, and **force a GC before each boot** ([v8.md](v8.md) "Module
  reuse"). They set `idleLimitMs`, so a lost wake-up throws instead of hanging.
- **Guest-timed workloads run in realtime mode** (`dd`, `fio`, `openssl speed`, CoreMark in the
  VM); host-timed ones deterministically. I/O benchmarks: one fresh boot per sample, timed by the
  host between the guest script's markers unless the tool times itself.
- `alpine_user_jit` (the Alpine userspace benchmark, `images/build.sh alpine-user`): after the
  boot, phases timed from console markers: compression (`xz -6 -T1` and `gzip -9` of a fixed ~16
  MiB corpus on tmpfs, then decompression), Lua (binary-trees, fannkuch-redux, n-body,
  spectral-norm), process churn (fork/exec loop and `find | xargs stat`), SQLite `speedtest1`.
  **Budget: ≤ ~30 s on one vCPU under the JIT** (benchmarks mustn't be slow to wait for). Every
  phase takes a thread/process count so M7 can rerun them at N vCPUs. `webpc.phase=crypto` runs
  `openssl speed` instead; `webpc.armcap=X` sets `OPENSSL_armcap`. `7z b` was left out (12 s
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
  `gl_virgl_llvmpipe_jit[_4]`: llvmpipe from that same Mesa build, the like-for-like baseline. Graphics.md §19 has the
  numbers.
- **SMP (M7):** `smp_alpine_jit`, `smp_user_jit` run parallel SMP (a worker
  per vCPU, realtime, JIT) at N = 1, 2, 4 vCPUs, the Ns alternated within each round; `…_8` once
  as a check, `smp_user_jit_4` alone for A/B sessions. Boots report the time to the distro's
  local.d script and to power-off (realtime power-off includes busybox init's 2 s of sleeps after
  SIGTERM and SIGKILL); `smp_user_jit` runs the userspace phases with `webpc.threads=N` (N copies
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

## Rules

- **Don't claim a speedup or regression without `bench/run.ts` numbers in Chromium.** Report
  medians and IQR (take `iqr` from the JSON, never by hand), the host and the Chromium version.
- **Commit the result JSON behind any written report** (`bench/*/results/<milestone>-<loop>/`);
  ad-hoc runs stay in `bench/results/local/`.
- **Differences under ~5% are noise unless repeated.** Compare builds **A/B in one session,
  alternating**; boots are compared only within one session (the host's state moves runs by up
  to ~8% between sessions); check the interpreter's number in the same JSON to see the host's
  state.
- **The small guests run at eight guest-RAM placements** (the placement effect, [v8.md](v8.md)):
  never rank builds on one placement.
- **Rank tuning by the long, real workloads** (Alpine boot, Alpine userspace) first. Debian has no benchmark since M8 phase B (its direct-boot ones timed only a boot and power-off; the page's boot times are in the page tests' logs).
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
  Buildroot images to `~/webpc-bench` there; `WASM=` picks a core; results land in
  `bench/results/local/mac/`). `--config bounds-checks` there shows the checks' cost on one machine.
- Benchmarks run in the dev VM on the M4. Keep the `oracle` VM idle, check `ps` for leftover
  experiments first, and don't rebuild or edit served sources while a benchmark runs.
- **Keep every benchmark command under the Bash tool's ~600 s cap** (fewer boots per call, or
  `--quick`), with a `timeout`; a command that overruns gets backgrounded and can stall unseen.
- Numbers from the x86_64 desktop (M0–M5 step 7) aren't comparable with the VM's.
- **Peer comparisons are rare:** QEMU TCG, native and in-browser peers were measured once, for
  M6's exit table; performance work compares webpc with itself. **qemu-wasm is dropped for good**
  (it booted Buildroot 4.7× slower than webpc, computes CoreMark wrong, looks abandoned); x86 peers
  (v86, JSLinux, WebVM) only as published context.

## Current numbers

Chromium 153 on the M4 VM, JIT, crypto extensions on. webpc's boots, userspace and CoreMark are
from 2026-10-02 (`bench/boot/REPORT.md` "M8: regions across pages"; before that day's JIT changes:
674 ms, 9.96 s, 24.1 s, 8602 it/s); the rest and the peers are M6's exit table and M6.5's exit
(`bench/interp/REPORT.md`):

| | webpc | QEMU TCG (same VM) | native (M4) |
|---|---|---|---|
| Buildroot boot to power-off, cold | 802 ms | 0.30 s | 0.10 s (hvf) |
| Alpine boot to power-off, cold | 9.9 s | 5.4–5.6 s | 2.4 s (hvf) |
| Alpine userspace | 20.5 s (compress 2.4, Lua 3.7, churn 2.0, SQLite 2.9); **14.6 s on the Mac host** (1.9, 3.2, 1.1, 2.3) | 11.2 s | 2.9 s (hvf) |
| Debian 13 boot to power-off | 42.2 s | 31.3 s | 2.4 s (hvf) |
| CoreMark, user mode | 10,080 it/s | 12,500 | 61,111 |
| integer / FP guest | 5175 / 155 MIPS; FP guest 707 MIPS from 2026-10-14 (inline FMA, `bench/interp/REPORT.md` "M8: inline FMA") | | |
| EL1 guest, MMU off / on | 4932 / 4045 MIPS | | |
| `openssl speed` 16 KiB: AES-128-GCM / AES-128-CBC / SHA-256 | 232 / 151 / 298 MB/s | | |

Parallel SMP (`bench/boot/REPORT.md` "M7 loop 8"): Alpine to its script 8.4 / 9.1 / 10.1 s on 1 /
2 / 4 vCPUs, Debian 42.3 / 33.5 / 29.6 s; the userspace phases with N copies of the work 25.2 /
27.3 / 31.6 s (compute phases 3.4–3.8× throughput at 4, process churn 1.7×).

Interpreter: ~143 MIPS integer, ~20 FP; Alpine boots in 46.9 s interpreted. I/O (M4 step 7,
interpreter era): fio random 4 KiB reads ~1,800 IOPS, 9p ~14–25 MiB/s, ~2,660 full-size pings/s.

## Workloads still planned

| KPI | Workload |
|---|---|
| Mixed / realistic | `7z b`, compiling a C file with GCC in the guest (heavy code churn); a browser: `bench/apps/` (above) |
| Kernel paths | lmbench `lat_syscall`, `lat_pagefault`, `lat_ctx` |
| JIT behavior | compile latency p50/p99, % time interpreted, code bytes, invalidations |
| SMP (M7) | parallel `make` (not in the image yet) |
| I/O | a write benchmark (a scratch disk behind an overlay); re-run 9p and net under the JIT |

## Instrumentation and profiling

- **Counters** in shared memory ([abi.md](abi.md) "Counters"): steps, exceptions by EC, IRQs, TLB
  misses/walks/flushes, the JIT's compile and execution statistics, and parallel SMP's (DSB waits
  and their time, broadcasts, drains, idles, platform-lock contention, WFEs, time out of the core),
  per vCPU (`cpuStats()`). The benchmarks record them in
  each result's params.
- **The helper histogram** (`jit_helper_report`, `web/vm.ts` `helperReport`): helper calls by
  instruction class, most frequent first; it says what to inline next.
- **PC sampling** (`web/sampler-worker.ts`, `node bench/boot/profile.ts`): reads `Counters.pc` every
  20 µs beside the vCPU worker; symbolized with `System.map` (user space as one bucket). The PC is
  published once per chunk, so its resolution is a chunk (32K steps): coarse under the JIT. A chunk also ends
  at an exit, so a sample names where the current chunk started (the instruction after the last exit: counter
  reads, IRQ unmasks, syscall entries rank high). On the page (`?displaystats`): `window.__webpcProfile(on)`
  samples every vCPU's block, the histogram lands in `window.__profile`, and `window.__status` holds the last
  status (the counters); while it runs the vCPUs publish their PC every 256 steps (`vm_set_chunk`, parallel
  mode only), so a sample is where the vCPU is, not the exit that started its chunk (graphics.md §21 loop 6: the
  exit sites' share fell to a fifth). `PROFILE=1` in `bench/gpu/sway-load.ts` and `bench/gpu/gtk4-load.ts` uses it
  and symbolizes in the guest (`/proc/kallsyms`; guest-session.ts `sampler`, `symbolize`). The sampler's worker
  busy-polls and takes a host core: on the dev VM a GTK demo ran at half its speed while sampled (the 256-step
  chunks cost nothing measurable beside it).
- **Guest sessions** (`bench/gpu/guest-session.ts`: sway-load, firefox-load, gtk4-load, avsync; on the Mac through
  `sway-mac.sh`): a phase (`load`) records the guest's CPUs, every process's CPU (its /proc stat: threads that exited
  count), every thread over 2 ms a second with schedstat's runs and run-queue wait (read back from a file: the serial
  terminal holds a screenful), and the display's, renderer's and emulator's counters. `SYSCALLS=1` adds the syscalls
  by thread (a kprobe event on `do_el0_svc` into a 16 MiB-a-CPU ring buffer: Arch's kernel has no syscall
  tracepoints; each syscall then traps, so count drops and CPU from runs without it). `TIMELINE=1` records the **vCPU
  timeline** (`web/timeline-worker.ts`, `window.__webpcTimeline(on)`: every vCPU's counters and liveness slot every 10
  ms, sleeping between reads; `summarizeTimeline`: MIPS, compile and out-of-call time, and **stalls**, 10 ms bins
  inside one `vm_run_cpu` call that retired nothing; a vCPU publishes at a chunk's end, so a stall's compile time shows
  in the bin after it). An install of JIT code over 20 ms logs a `webpc-slow install` line (its compile,
  instantiation, GC and size), collected into results' `slow`. `sway-mac.sh` samples the Mac's `vm_stat` each second
  (`<name>.vmstat`): its memory is overcommitted by the Lima VMs (plans/video.md §8), which shows in latency. Firefox's
  start-up work runs ~30 s past its window: measure steady state at least that long after a launch (`WARM_S`).
  firefox-load's `TIMELINE_ALL=1` records the timeline over its whole `pages` phase (every Firefox start and load,
  where the JIT compiles most), and `QUERY` adds to the page's query (`jit=nocw`: the JIT without its compile
  worker, for A/B). `bench/gpu/stalls.ts` counts a timeline's stalls by length (`--json` for results).
- **The JIT's compile worker A/B:** `bench/run.ts --query=nocw` turns it off in `bench/boot` (the bench page passes
  its query to its worker); the page takes `?jit=nocw`.
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
  modules:** dump them from `web/vm.ts`'s install temporarily (`if (process.env.X)
  fs.writeFileSync(…)`, and remove it before any Chromium run: `process` doesn't exist there),
  then `wasm-tools print` (shows branch hints) or `wasm-tools validate`.
- Node runners for iteration: `bench/interp/suite.ts` `setup(bin, JIT_DEFAULT, pad)` / `setupVm`
  for the small guests; `runToPowerOff` (`web/vm.ts`) for boots. `bench/run.ts --out` resolves
  against the repo root.
- **A core panic's stack trace** (`webpc_core.wasm.<fn> (wasm-function[N]:0x4031a)`): the
  release wasm carries DWARF, so `llvm-symbolizer --obj=target/wasm32-unknown-unknown/release/webpc_core.wasm
  -i -f 0x4031a` gives the source line, **with the offset as printed** (it's a file offset; don't
  subtract the code section's base). Only for the binary that crashed: keep it before rebuilding.
- The wasm name section (`<va>_pa<pa>`) makes DevTools and `perf` profiles readable.
  (`performance.mark`/`measure` around compile, instantiate, device I/O and boot phases were
  planned and aren't there yet: backlog.)
