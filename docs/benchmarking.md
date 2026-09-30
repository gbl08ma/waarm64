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
| `bench/interp/index.html` | `interp_mips`, `interp_fp_mips`, `vm_flat_mips`, `vm_mmu_mips` (interpreter: user-mode integer and FP/NEON guests, the integer guest at EL1 with the MMU off/on), `jit_mips`, `jit_fp_mips`, `vm_jit_flat_mips`, `vm_jit_mmu_mips`, `coremark_mips`, `jit_coremark_mips` (also reported as iterations/s) |
| `bench/boot/index.html` | `boot`, `boot_defconfig`, `boot_alpine` (interpreter), `boot_jit`, `boot_alpine_jit`, `boot_debian_jit`, `alpine_user_jit` (ms per phase), `coremark_vm_jit` (CoreMark as init, realtime), `alpine_crypto_jit` / `alpine_crypto_ce_jit` (`openssl speed`, extensions off/on, realtime) I/O: `dd`, `fio`, `p9`, `net` (realtime) |
| `bench/jit/index.html` | `jit_install`, `jit_first_call` |
| `bench/spike/index.html` | the M0 spike (`node bench/spike/node.ts` in Node) |

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
- **SMP (M7):** `smp_alpine_jit`, `smp_user_jit`, `smp_debian_jit` run parallel SMP (a worker
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
- **Rank tuning by the long, real workloads** (Alpine boot, Alpine userspace, Debian) first.
  **Don't optimize for very short runs:** the Buildroot boot (< 1 s) is a check, not a target; a
  change that makes it even ~50% slower but speeds a distro boot up by 5–10% is worth keeping, and
  the synthetic small guests may lose a few percent for such gains. Report the losses with
  numbers.
- **Don't fit the design to CoreMark:** well-optimized wasm runs 10–30% behind native on
  compute-bound code; CoreMark is at ~70% of QEMU TCG.
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

Chromium 153 on the M4 VM, JIT, crypto extensions on (M6 exit table and M6.5 exit,
`bench/interp/REPORT.md`):

| | webpc | QEMU TCG (same VM) | native (M4) |
|---|---|---|---|
| Buildroot boot to power-off, cold | 674 ms | 0.30 s | 0.10 s (hvf) |
| Alpine boot to power-off, cold | 9.96 s | 5.4–5.6 s | 2.4 s (hvf) |
| Alpine userspace | 24.1 s (compress 2.8, Lua 5.1, churn 2.2, SQLite 4.0) | 11.2 s | 2.9 s (hvf) |
| Debian 13 boot to power-off | 42.2 s | 31.3 s | 2.4 s (hvf) |
| CoreMark, user mode | 8602 it/s | 12,500 | 61,111 |
| integer / FP guest | 5175 / 155 MIPS | | |
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
| Mixed / realistic | `7z b`, compiling a C file with GCC in the guest (heavy code churn) |
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
  published once per chunk, so its resolution is a chunk (32K steps): coarse under the JIT.
- **perf with parallel SMP:** `--perf-prof`'s jitdump misses the code worker isolates compile (the
  guest's blocks run in the vCPU workers: 73% of samples unknown); `--perf-basic-prof` (a
  `/tmp/perf-<pid>.map`) names them. Guest blocks are thousands of symbols that round to 0.00% in
  `perf report`: aggregate `perf script -F tid,time,ip,sym` by guest VA (`<va>_pa<pa>` names) and
  the kernel's System.map (Alpine's is in its rootfs, `/boot/System.map-*`). The VM has no PMU.
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
