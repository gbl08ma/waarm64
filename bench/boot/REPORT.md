# Boot time: M3 baseline (interpreter only)

> A dated journal, appended to per milestone and loop; the current numbers and rules are in
> `docs/benchmarking.md`. References to PLAN.md sections (§2, §7 M…, M9) are to its layout before
> 2026-09-28, when that content moved to `docs/` (M9 is now `docs/backlog.md`).

**Workload:** the M3 test guest (`images/`): Linux 6.18.54 from `allnoconfig` + `images/linux.fragment`, a 6.4 MB uncompressed BusyBox initramfs whose `/init` mounts proc/sys/dev, runs `/test.sh` and powers off through PSCI. 256 MiB of RAM, `console=ttyAMA0 earlycon panic=-1`, deterministic mode (62.5 MHz counter, one tick per step). Image and initramfs hashes are in `images/SHA256SUMS`.

**Method:** `node bench/run.ts --page bench/boot/index.html` (default config, full run) in a worker. Metrics: wall time from `vm_boot` to the first `waarm64: init` on the console (the initramfs's `/init` starts; the guest's "shell") and to the PSCI `SYSTEM_OFF` after `/test.sh`. **Cold:** each sample compiles a fresh `WebAssembly.Module` (V8 starts on Liftoff code), and the compile time is included; n = 5. **Warm:** one module, three warm-up boots, then n = 10. Every boot takes exactly **35,362,607 steps** (instructions retired plus exceptions taken), on both hosts and natively. Code at commit `1287f3e0c677`, the same wasm on both hosts (sha256 `e970eba0e18c…`); `dirty` is the untracked kickoff notes.

| Host | Chromium | To /init cold | Power-off cold | To /init warm (IQR) | Power-off warm (IQR) | Warm MIPS |
|---|---|---|---|---|---|---|
| Ryzen 7 5800X3D, Linux x86_64 | 152.0.7977.75 | 689 | 814 | **674** (±5.9) | **797** (±6.3) | 44.3 |
| Apple M4, macOS 26.6 arm64 | 153.0.8010.12 (Chrome for Testing) | 441 | 524 | **436** (±1.3) | **519** (±1.4) | 68.2 |

Milliseconds. Raw data: `results/chromium-{linux-x86_64,darwin-arm64}-default.json`.

**Counters** (identical on both hosts, as deterministic mode promises): 46 IRQs; exceptions by EC: 447 SVC (0x15), 421 data aborts from EL0 (0x24) and 149 instruction aborts from EL0 (0x20), i.e. user page faults, 23 data aborts at EL1 (0x25), 9 UNDEFINED (0x00: EL0 reads of ID registers, which Linux emulates for the `cpuid` hwcap); 64,088 TLB misses, 63,495 completed walks, 771 flushes. TLB hits aren't counted (PLAN.md §7 M3 step 8).

## Notes
- **Cold costs little:** 17 ms (x86_64) and 5 ms (M4) over warm, compile included. V8 compiles the core's big functions in the background early enough that almost all of the boot runs on TurboFan code.
- **System mode runs at about half the user-mode rate:** 44 MIPS against 87.6 for the integer benchmark on x86_64 (`bench/interp/REPORT.md`), 68 against 146 on the M4. The boot runs with the MMU on (every access through the TLB in the MMU copy of the interpreter), takes ~1,000 exceptions and ~46 IRQs, leaves the interpreter for every timer register read (`arch_counter_get_cntvct` is 2.7% of the profile) and every UART access (re-executed through `vm::Io`), and its instruction mix isn't the benchmark's. Which of these the gap is made of isn't measured: the MIPS benchmark through `vm_run` with the MMU on (PLAN.md §7 M9) is the way to split it.

## M4 step 2: the guest with virtio-console and virtio-rng
The kernel gained virtio-mmio, virtio-console and hw_random virtio, `/test.sh` reads `/dev/hwrng` and writes to `/dev/hvc0`, and the runners configure both devices. The boot now takes **39,741,632 steps** (+12.4% over 35,362,607), the same natively and in Chromium.

| Host | Chromium | init cold | total cold | init warm | total warm |
|---|---|---|---|---|---|
| Ryzen 7 5800X3D, Linux x86_64 | 152.0.7977.75 | 738 (±8.5) | 946 (±11.6) | **718** (±5.8) | **925** (±8.0) |

Milliseconds, medians (IQR) of 10. Warm total is +16% over M3's 797 ms: +12.4% is the extra guest work (driver probes, the hwrng thread filling the entropy pool, the test's reads and writes); the rest is DEVICE exits and waits for the device worker (the suite runs in a worker, so it uses one). Counters: 121 IRQs (was 46), 76,053 TLB misses. Not re-run on the M4. Raw: `results/chromium-linux-x86_64-m4-step2.json`.

## M4 step 3: the root filesystem on virtio-blk
No initramfs: the kernel mounts a 32 MiB ext4 image read-only from `/dev/vda`, read by the device worker with synchronous HTTP range requests to `tools/serve.ts` on the same machine. **38,188,077 steps** (−3.9% against step 2: nothing to unpack), the same natively and in Chromium.

| Host | Chromium | init cold | total cold | init warm | total warm |
|---|---|---|---|---|---|
| Ryzen 7 5800X3D, Linux x86_64 | 152.0.7977.75 | 665 (±8.3) | 1017 (±11.2) | **644** (±9.7) | **994** (±9.1) |

Fewer steps, but +7.5% warm total over step 2 (925 ms): every block read is a round trip the vCPU waits for in deterministic mode (one XHR per request, no cache). /init comes sooner (644 against 718 ms) and the test script takes longer (it now runs from the disk, paging in BusyBox). Counters: 184 IRQs, 87,372 TLB misses. Not re-run on the M4. Raw: `results/chromium-linux-x86_64-m4-step3.json`.

## M4 step 4: the distro-like kernel, the distros, and a first I/O number
Same guest (the only change: `/init` takes an optional script after `--`), **38,180,302 steps**. Candidate distro-like kernel: arm64 `defconfig` + `images/linux.fragment` (`linux/Image-defconfig`, 41 MiB against 5.3 MiB), same root filesystem and test, **206,737,284 steps** (5.4×).

| Kernel | Chromium | init cold | total cold | init warm | total warm |
|---|---|---|---|---|---|
| allnoconfig + fragment (default) | 152.0.7977.75 | 730 (±18.8) | 1121 (±13.6) | **680** (±5.5) | **1047** (±12.3) |
| defconfig + fragment | 152.0.7977.75 | 4283 (±104) | 4738 (±127) | **4188** (±183) | **4642** (±211) |

Ryzen 7 5800X3D, Linux x86_64; ms, medians (IQR) of 10 warm and 5 cold. The default's warm total against step 3 (994 ms) is noise: a second run gave 1011 (±27). The defconfig kernel costs 4.4× the boot, almost all before /init (built-in drivers and subsystems initializing: 455 IRQs, 175,813 TLB misses). Raw: `results/chromium-linux-x86_64-m4-step4{,-defconfig}.json`.

Distro boots (deterministic, 1 GiB, root on virtio-blk over HTTP ranges), single runs from the tests, not `bench/run.ts`:

| Guest | Steps (native = Chromium) | Native wall | Chromium wall |
|---|---|---|---|
| Alpine 3.24.2, linux-virt 6.18.53, OpenRC to a local.d script | 2,808,934,324 | 48 s | 66 s |
| Debian 13 nocloud (20260914-2601), 6.12.107, systemd to `systemd.run=` | 16,743,942,794 | 456 s (a Chromium test alongside) | 377 s |

**I/O, realtime mode** (`--only dd`): `/bench-dd.sh` runs `dd if=/dev/vda of=/dev/null bs=1M` over the whole 32 MiB image on a fresh boot, timed by the host between the script's markers: **46.1 MiB/s (±0.7)**, ~690 ms, median of 10. That is the synchronous-XHR backend (one range request per virtio request, to `tools/serve.ts` on the same machine) and the guest's block layer at interpreter speed together; the baseline for step 7. Raw: `results/chromium-linux-x86_64-m4-step4-dd.json`. Not re-run on the M4.


## M4 step 6: the network stack and the step 6 drivers in the test kernel
The kernel adds IPv4, virtio-net, 9p, evdev, virtio-input and simplefb (`images/linux.fragment`); the boot's devices are unchanged (console, rng, blk), so the new drivers only register. **40,764,416 steps** (+6.8% over step 4's 38,180,302), natively and in Chromium.

| Chromium | init cold | total cold | init warm | total warm |
|---|---|---|---|---|
| 152.0.7977.75 | 750 (±14.4) | 1093 (±18.1) | **711** (±9.1) | **1049** (±10.6) |

Ryzen 7 5800X3D, Linux x86_64; ms, medians (IQR) of 10 warm and 5 cold. Warm total against step 4 (1047 ms) is noise; the extra steps are mostly before /init (+4.6% there). Counters: 189 IRQs, 91,956 TLB misses. Raw: `results/chromium-linux-x86_64-m4-step6.json`. Not re-run on the M4.
## M4 step 7: I/O benchmarks and boot times, both hosts
**Date:** 2026-09-26, code at `8349652` plus the step 7 changes (the same wasm on both hosts, sha256 `fe593573…`; the Mac ran an rsync of the tree). Chromium 152.0.7977.75 on the Ryzen 7 5800X3D (Linux x86_64), Chrome for Testing 153.0.8010.12 on the Apple M4 (macOS 26.6). Medians (IQR). The test kernel now has SysV IPC (fio needs it) and the root filesystem fio: **40,909,861 steps**.

**Boot times** (deterministic; ms; 5 cold and 10 warm for Buildroot, 3 cold and 5 warm for Alpine):

| Guest | Host | to script, cold | total, cold | to script, warm | total, warm |
|---|---|---|---|---|---|
| Buildroot (to /init) | x86_64 | 724 (±26.8) | 1062 (±30.6) | **698** (±11.4) | **1034** (±9.7) |
| Buildroot (to /init) | M4 | 421 (±23.0) | 638 (±25.9) | **404** (±2.7) | **621** (±5.1) |
| Alpine 3.24.2 (to its local.d script) | x86_64 | 56,938 (±74) | 67,599 (±32) | **56,982** (±369) | **67,673** (±519) |
| Alpine 3.24.2 (to its local.d script) | M4 | 36,845 (±36) | 43,897 (±154) | **37,146** (±400) | **44,206** (±375) |

Alpine runs as its boot test does (1 GiB, the test devices and a framebuffer, loading linux-virt's modules for them): 3,009,151,562 steps, ~44 MIPS on x86_64 and ~68 on the M4. Cold and warm don't differ for a boot that long. Debian isn't measured (6–8 min a boot; the test-guest decision in PLAN §7 M4); its step 4 single runs are above.

**I/O** (realtime mode, the Buildroot guest, one fresh boot per sample: 10, fio 5):

| Benchmark | What | x86_64 | M4 |
|---|---|---|---|
| `dd` (`--only dd`) | sequential read of the 32 MiB `/dev/vda`, 1 MiB blocks, through the page cache | **47.8** MiB/s (±0.4) | **84.7** (±0.6) |
| fio random read (`--only fio`) | 4 KiB, O_DIRECT, psync, 3 s | **601** IOPS (±2.5), 1592 µs mean latency | **1778** (±10), 522 µs |
| fio sequential read | 1 MiB, O_DIRECT, psync, 3 s | **140** MiB/s (±1.5) | **322** (±3.3) |
| 9p write (`--only p9`) | 16 MiB, `dd` 1 MiB blocks, in-memory tree | **14.1** MiB/s (±0.15) | **21.3** (±0.14) |
| 9p read | the same file back | **16.7** MiB/s (±0.6) | **25.2** (±0.3) |
| 9p create | 200 empty files | **466** files/s (±13) | **688** (±6) |
| 9p `ls -l` | 200 files (a getattr each) | **307** ms (±4.2) | **223** (±2.5) |
| 9p unlink | 200 files | **328** files/s (±4.7) | **498** (±5.1) |
| net, full-size (`--only net`) | `ping -A`, 1472 bytes of data (1514-byte frames), loopback adapter | **1652** round trips/s (±10), 2.39 MiB/s each way, 0.53 ms RTT | **2664** (±35), 3.85 MiB/s, 0.34 ms |
| net, small | `ping -A`, 56 bytes | **2165** round trips/s (±17), 0.40 ms RTT | **3225** (±57), 0.27 ms |

Reading them:
- **Block:** every virtio-blk request is one synchronous XHR (a range read from `tools/serve.ts` on the same machine), so a 4 KiB random read costs ~1.6 ms on x86_64 and ~0.5 ms on the M4: the XHR round trip, not the guest, dominates (the M4's Chromium turns them around three times faster). Large O_DIRECT requests amortize it (1 MiB per XHR: 140 and 322 MiB/s); `dd` through the page cache issues smaller readahead requests and gets 48 and 85 MiB/s (step 4: 46.1). A request cache or asynchronous, merged reads (PLAN M9) is where block speed is.
- **9p and net** are guest-bound: every 9p message and every frame is a `DEVICE` exit, a hop to the device worker and back, and the guest's own stack at interpreter speed (the M4 is ~1.5× faster, like its MIPS). A ping round trip is ~0.4 ms ≈ 20,000 guest instructions on x86_64 plus two worker hops; in realtime mode the completion lands at the next chunk boundary (≤ 1024 steps). `EVENT_IDX` and notification batching (M9) matter only once the JIT makes the guest side fast.

Raw: `results/chromium-{linux-x86_64,darwin-arm64}-m4-step7-{boot,boot_alpine,dd,fio,p9,net}.json`.

## PC-sampling profile (warm boot)
`node bench/boot/profile.ts`: a second worker samples the vCPU's PC from shared memory every 20 µs (34,291 samples on x86_64, 21,084 on the M4); the PC is published at each run-loop chunk end, so a sample stands for the (≤ 1024-step) chunk starting there. Symbolized with `System.map`; user space is one bucket. Raw: `results/profile-{linux-x86_64,darwin-arm64}.json`.

| Symbol | x86_64 | M4 | What it is |
|---|---|---|---|
| [user] | 9.65% | 9.74% | BusyBox: `/init`, `/test.sh` and its commands |
| `__filemap_add_folio` | 6.58% | 6.59% | unpacking the initramfs into the page cache |
| `__pi_memset_generic` | 4.15% | 4.07% | memset (zeroing pages) |
| `generic_perform_write` | 4.12% | 3.73% | initramfs unpacking (tmpfs writes) |
| `memmap_init_range` | 3.31% | 3.11% | `struct page` init for 256 MiB |
| `__call_rcu_common` | 2.78% | 2.73% | RCU callbacks |
| `arch_counter_get_cntvct` | 2.66% | 2.83% | counter reads: each one exits the interpreter |
| `___slab_alloc` | 1.96% | 2.07% | slab allocator |
| `__init_single_page` | 1.74% | 1.72% | `struct page` init |
| `__create_pgd_mapping_locked` | 1.64% | 1.58% | building the kernel's linear map |
| `el0_da` | 1.47% | 1.46% | user data aborts (page faults) |
| `el0_svc` | 1.17% | 1.32% | system calls |

The rest is spread thinly (the next ones are each ~1%: `_parse_integer_limit`, `idr_get_free`, `__free_pages_core`, `blake2s_compress_generic`, `kernfs_*`, `unmap_page_range`). At this size the boot is dominated by unpacking the initramfs and initializing memory, so a smaller initramfs and less RAM are the guest-side levers. On the emulator side, the timer-read exits are a candidate worth measuring.

## M7 loop 0: the single-vCPU reference for the scaling curve

`--only alpine_user_jit`, the userspace phases at N = 1 (`waarm64.threads` unset: one worker per
phase) on today's single vCPU: the reference M7's scaling runs compare against. Chromium
153.0.8010.52, the M4 VM (8 vCPUs), deterministic, JIT, 3 boots, medians (IQR):

| Phase | ms |
|---|---|
| compress | 2680 (±38) |
| Lua | 4958 (±72) |
| churn | 2008 (±31) |
| SQLite | 3856 (±58) |
| **total** (to power-off) | **22,888** (±212) |

10,746,996,638 steps. The M6.5 exit's 24.1 s is from another session (sessions move boots by up
to ~8%); compare later N against this run or re-run it in the same session. Raw:
`results/m7-loop0/alpine_user_jit.json`.

## M7 loop 2: GICv3 as the default GIC

The GICv3 (system-register CPU interface) against the GICv2 (MMIO CPU interface), same session,
alternated (A, B, A, B), Chromium 153, the M4 VM, JIT, warm medians (IQR). The test kernels
(`linux`) are now built natively with Alpine's gcc (images/build.sh), and have the GICv3 driver.

| | GICv3 (default) | GICv2 (`--only …_gicv2`, removed with the GICv2 in loop 3b) |
|---|---|---|
| Alpine boot to power-off | 10,392 (±268), 10,312 (±132) ms | 10,187 (±25), 10,299 (±240) ms |
| Alpine userspace, total | 23,956 (±156), 23,819 (±5) ms | 24,153 (±199), 23,790 (±687) ms |

No difference beyond noise (≤ 2%) either way: interrupts are too few for the cheaper CPU
interface to show (Alpine's boot takes ~15K IRQs). Steps: Alpine 2,856,663,287 (+0.002%),
userspace 10,763,178,470 (+0.15%). Raw: `results/m7-loop2/`.

## M7 loop 5: parallel SMP, single-vCPU check

Loop 5 adds parallel SMP (a worker per vCPU, `VmConfig.smp` = 1) and changes round-robin's code
only where it reaches shared state: the devices behind `Vm::plat` (reached through `&mut`, no
locking), per-vCPU counter blocks, and a `FEATURE_PARALLEL` test at DSB, ISB and ERET in the
interpreter. The one-vCPU deterministic Alpine boot, base (loop 4, `7abbc5e`, A) against loop 5
(B), same session, alternated A, B, A, B, A, B; Chromium 153, the M4 VM, JIT, warm medians (IQR):

| | A (loop 4) | B (loop 5) |
|---|---|---|
| Alpine boot to power-off | 10,106 (±80), 10,119 (±44), 10,406 (±33) ms | 10,219 (±45), 10,258 (±170), 10,339 (±61) ms |

Within noise: B's median of medians is 1.4% above A's, and the third pair reversed. Steps are
identical (2,856,663,287). Raw: `results/m7-loop5/`.

Parallel mode itself isn't benchmarked yet (loop 8). What the tests showed in passing (single
runs, not `bench/run.ts` numbers): in Node, Alpine on one vCPU boots as fast in parallel mode as in
round-robin realtime (10.28 vs 10.21 s), so the extra chunk ends at DSB/ISB/ERET cost little; on 2
and 4 vCPUs it took 12.0 and 14.4 s once the IC queues kept pages (before: 17.9 and 22 s, from
whole-cache flushes, docs/platform.md "Broadcast maintenance"). In Chromium, Alpine on 4 vCPUs
took 16.2 and 16.5 s, Debian on 4 vCPUs 33 s.

## M7 loop 6: memory model, single-vCPU check

Loop 6 changes what one vCPU runs only in the core's guest-RAM accesses (relaxed atomics, which
cost the interpreter 11% on `vm_mmu_mips`: `../interp/REPORT.md` "M7 loop 6") and the pair
atomics (CASP, per-half CASes under a hashed lock); DMB's `atomic.fence` is emitted only in
parallel SMP. The one-vCPU Alpine boot, base (`3fcfafb`, A) against the kept build (E), same
session, alternated; Chromium 153, the M4 VM, JIT, warm medians (IQR):

| | A (base) | E (loop 6) |
|---|---|---|
| Alpine boot to power-off | 10,301 (±27), 10,416 (±32), 10,430 (±49) ms | 10,385 (±69), 10,674 (±56), 10,445 (±17) ms |

Within noise: +0.8%, +2.5%, +0.1% per pair, +0.3% on the median of medians; steps identical
(2,856,663,287). The session drifted (A's first runs of the day were 10,128–10,213 ms). Earlier
pairs in the same session measured B, a first version with a slower interpreter (74.7 MIPS),
at +1 to +5%, and C once; they're kept with the rest. Raw: `results/m7-loop6/`.

## M7 loop 8: scaling (parallel SMP)

New benchmarks `smp_alpine_jit`, `smp_user_jit`, `smp_debian_jit` (docs/benchmarking.md "SMP"):
parallel SMP (a worker per vCPU, realtime, JIT) at N = 1, 2, 4, the Ns alternated within each
round; per-vCPU counters (ABI 26) in the params. Chromium 153.0.8010.52, the M4 VM (8 vCPUs),
medians (IQR). Boots: ms to the distro's local.d script (realtime power-off adds busybox init's
2 s of shutdown sleeps).

**A clock bug first.** The first runs drifted: the same boot got slower and took more steps
through a session (N = 1: 2.66 G → 6.24 G steps). A new worker's `performance.timeOrigin +
performance.now()` ran behind the page's by ~150 ms more per boot (−2.3 s after 11 boots): Chromium
derives a context's `timeOrigin` from a wall clock that drifted ~1% from the monotonic one in this
VM. The vCPU workers' counter read 0 until they caught up with the VM's `t0` ("Missing cycle
counter" in the kernel log, the RNG's jitter entropy loop spinning). Fixed: each worker measures
the creator's clock (`clockOffset`); 12 alternated boots then took constant steps. Node wasn't
affected. Every parallel number below is after the fix.

**Profile of what scaled badly.** The compute phases scaled (N = 4: 3.1–3.5× throughput), process
churn (`fork`/`exec`, `find | xargs stat`) didn't (1.1×). In Node at N = 4, each vCPU did a lone
vCPU's churn work (~500 M steps) in 6.9 s instead of 1.44 s: DSB waits for TLBI IS took 1.3 s
(13K waits, ~100 µs each), time out of the core 0.14 s, the platform lock 2 ms, compiles 35 ms,
WFE yields ~0.1 s; the rest was guest code running ~2.4× slower. That part is the host: four
independent one-vCPU VMs slowed each other's churn the same way (1.44 → 3.3 s; 2.2 s with two,
2.9 s with three), as do four or more busy threads of any kind beside one VM; memory hogs don't. The
M4 has 4 performance cores (docs/benchmarking.md "SMP"). No PMU in the VM to say more.

**Tuning:**
- **DSB waits only for vCPUs running the TLBI's ASID** (docs/platform.md "Broadcast
  maintenance"). A/B at N = 4 (`smp_user_jit_4`, alternated A, B, A, B; A = the same build
  without the filter): churn 7,652 (±7), 7,797 (±71) → 4,871 (±2), 4,929 (±53) ms; total 35,709
  (±96), 36,198 (±9) → 31,224 (±159), 31,434 (±133) ms; DSB waits over the run 92K (8.3 s) → 3K
  (0.06 s). Raw: `results/m7-loop8/asid-*.json`.
- **Idle vCPUs poll 50 µs before `Atomics.wait`:** a futex round trip between two Node threads
  costs 34 µs in this VM (0.5 µs polling). The stress's pingpong (futex hand-offs, N = 2, Node):
  4.2 → 1.25 s; 20 µs did as well. The userspace phases (27.4–28.4 s) and Alpine boots
  (13.4–13.7 s, N = 4, Node) didn't move.
- Tried and dropped (moot after the ASID filter): a 4096-step chunk in parallel mode (average DSB
  wait 100 → 65 µs), polling 50 µs before sleeping in the DSB wait (→ 55 µs).

**The curve** (final build; before = loop 7 plus the clock fix, same day):

| | N = 1 | N = 2 | N = 4 | N = 8 (once) |
|---|---|---|---|---|
| Alpine boot to script, before | 8,393 (±64) | 9,584 (±86) | 11,343 (±32) | |
| Alpine boot to script | 8,401 (±22) | 9,054 (±71) | 10,121 (±88) | 13,217 (2 boots) |
| Debian boot to script (1 boot each) | 42,318 | 33,498 | 29,588 | |
| Userspace total, before | 25,227 (±616) | 29,763 (±168) | 37,308 (±909) | |
| Userspace total | 25,184 (±341) | 27,291 (±67) | 31,576 (±587) | 50,330 |
| compress (throughput vs N = 1) | 2,599 (±190) | 2,272 (2.3×) | 2,704 (3.8×) | 5,355 (3.9×) |
| Lua | 4,758 (±58) | 4,915 (1.9×) | 5,532 (3.4×) | 8,975 (4.2×) |
| churn | 2,103 (±2) | 3,422 (1.2×) | 4,937 (1.7×) | 10,270 (1.6×) |
| SQLite | 3,649 (±12) | 3,931 (1.9×) | 4,239 (3.4×) | 8,146 (3.6×) |

The userspace phases run N copies of the work at N (`waarm64.threads=N`): throughput = N × t₁ / t_N.
Alpine's boot is mostly serial and still loses 20% at N = 4; Debian's (systemd) gains 30%. N = 8
exceeds the VM's cores (N + 2 threads). Raw: `results/m7-loop8/smp_*.json`.

**Single vCPU** (deterministic `boot_alpine_jit`, c2f927a as A against this loop as B, alternated):
10,633 (±202), 10,365 (±154) → 10,598 (±185), 10,333 (±12) ms, steps identical (2,856,663,287).
Raw: `results/m7-loop8/boot_alpine_jit-*.json`.

The boot suite now ignores markers in the kernel's echo of its command line: Debian's contains
`echo waarm64: debian`, so `boot_debian_jit`'s first-marker time (`debian_jit_first`) had been ~1 s
into the boot rather than its script.

## M8 loop 0: Debian for interaction

Debian 13 booted to its login prompts in a throwaway page (Playwright, headless): JIT, realtime,
parallel SMP, the framebuffer, a keyboard and a tablet, the root on a fresh OPFS overlay, then
reloaded onto the same overlay (after an unclean stop, as a closed tab leaves it). Chromium
153.0.8010.52, the M4 VM (8 vCPUs), one boot per cell (two for the 2-vCPU default: 39.1, 39.5 s
fresh; 32.7, 32.0 s reloaded). Seconds from page load to the `ttyAMA0` login prompt; Chromium's
RSS (every process) at that moment. Raw: `results/m8-loop0/interactive-debian.json`.

| Configuration | Fresh overlay | Reload | RSS (MiB) |
|---|---|---|---|
| 1 vCPU, 1 GiB, 1024×768 | 55.1 | 40.4 | 2,345 |
| 2 vCPUs, 1 GiB, 1024×768 | 39.3 | 34.3 | 2,548 |
| 4 vCPUs, 1 GiB, 1024×768 | 35.6 | 31.7 | 3,122 |
| 2 vCPUs, 2 GiB, 1024×768 | 39.6 | 35.2 | 2,618 |
| 2 vCPUs, 1 GiB, 1280×800 | 39.7 | 33.0 | 2,576 |
| 2 vCPUs, 1 GiB, no framebuffer, serial console only | 37.5 | 31.7 | 2,514 |
| 2 vCPUs, 1 GiB, 1024×768, trimmed command line | 33.8 | 29.7 | 2,465 |

- **Both consoles are ready together:** `getty@tty1` and `serial-getty@ttyAMA0` start within
  0.2 s of each other (at 35.3 and 35.4 s of guest uptime in the 2-vCPU fresh boot). The last
  `console=` (tty0) gets `/dev/console`.
- **fbcon draws on `simplefb` from the first kernel line** (a scrolling boot log, then the tty1
  login), and costs 1.5–2 s of boot. The framebuffer's size doesn't show in the boot time.
- **`virtio_input` loads** (udev, from the root filesystem, ~27 s in) and the keyboard reaches
  tty1: the harness logs in and types commands whose output it reads on the serial side. Root is
  locked in the published image; the `login.noauth` credential lets it in (docs/images.md).
- **Guest memory:** 130 MiB used at the prompt of 965 MiB (1 GiB), 133 of 1,968 (2 GiB): 1 GiB is
  plenty for a console. 2 GiB didn't boot at first (JS read the core's pointers past 2 GiB as
  negative, fixed: docs/abi.md), and costs nothing in RSS until the guest touches it.
- **Host memory:** each vCPU adds ~300 MiB of RSS (its worker's core instance, V8 heap and JIT
  code), on top of ~2 GiB for one.
- **Where the time goes** (`systemd-analyze`, 2 vCPUs, fresh): kernel and initrd 7.5 s, userspace
  28.4 s. The critical chain is device discovery (the root's partitions at ~16 s), fsck and mount
  of the ESP, `systemd-tmpfiles-setup`, `ldconfig` (2.7 s), `systemd-logind`. Beside it: AppArmor
  loading ~100 profiles (7.5 s fresh, 3.4 s reloaded, and ~100 lines of audit noise on the
  console), `systemd-resolved`, `systemd-networkd` and `systemd-timesyncd` (no network: pointless).
  The trimmed command line (`apparmor=0` and those four units masked, plus the network generator)
  saves ~5 s fresh and 3–4 s reloaded, with no failed units; it's the page's default.
- `systemd-random-seed` takes 6–8 s waiting for the kernel's entropy (crng ready at 26.6 s, once
  `virtio_rng` loads), off the critical path; KASLR is off for want of a seed (backlog).
- **Noise:** no unit times out without a network. A reload replaces the uncleanly closed journal,
  and timers warn that their stamps are "in the future": the guest's clock starts at systemd's
  build epoch (2026-04-13) with no RTC (backlog). cfg80211 fails to load `regulatory.db`.
- **Defaults from this:** 1 GiB, 1024×768 (fbcon's 8×16 font: 128×48 characters), vCPUs as the
  kickoff says (at most 4, at most the cores minus two: 4 here, where 4 beat 2 by ~10%), the
  trimmed command line, and the screen from the start (the boot log on it is the progress). A
  reload reaches the prompt in ~30 s: phase B's snapshots would take that to seconds.

## M8 loop 1: console input, runAsync check

Parallel `runAsync` now returns as soon as the console has output (within its 10 ms waits)
instead of every 50 ms, so the host drains more often. `smp_user_jit_4` (Chromium 153.0.8010.52,
the M4 VM), alternated A (34701eb, loop 0), B (this loop), A, B, total median (IQR): A 31,136
(±14), 31,717 (±151) ms; B 30,808 (±53), 30,919 (±515) ms. No regression. Raw:
`results/m8-loop1/`.

Echo latency (Node, parallel on 2 vCPUs, Alpine with `init=/bin/sh`, `echo hi` to its prompt, 10
each): 42–75 ms (median ~55); without `SIGNAL_RX` 59–167 ms (~120), since the tickless kernel only
looks at the PL011 at its next timer event. ~55 ms for a shell's echo is slow; loop 3 measures
key-to-glyph and looks into it.

## M8 loop 2: the page

Time from loading the page (`web/app/`, Debian, 4 parallel vCPUs, JIT; Chromium 153.0.8010.52
headless, the M4 VM) to its `running` state (the serial `login: ` prompt): 30.5, 29.9, 30.3,
30.3 s on a fresh overlay (median 30.3), 29.5 s over an existing one. Loop 0's throwaway page took
~34 s fresh; the difference is within what separate sessions give, and nothing on the boot path
changed. Raw: `results/m8-loop2/`.

## M8 loop 3: key-to-glyph latency

Chromium 153.0.8010.52 headless, the M4 VM (8 vCPUs); the page (`web/app/`) in the Both view,
Debian on 4 parallel vCPUs, Buildroot (ash on the serial console) on 2. A key is stamped at its
`keydown`; the terminal's glyph when xterm.js's rows show the text typed so far (a
`MutationObserver`), the screen's when the next draw after it changed pixels. Random letters on one
line, no Backspace (a late echo can't hide behind the next key), 40 keys (Debian) or 100
(Buildroot). Medians, ms. Raw: `results/m8-loop3/`.

| | Loop 2 (0c36e6e) | Loop 3 |
|---|---|---|
| Serial terminal, Debian (bash) | 30.4 | 11.4, 10.5 (two sessions) |
| Serial terminal, Buildroot (ash) | 30.0 | 6.0 |
| Screen, Debian (bash on tty1) | 16.4 | 16.7, 13.8 |

Where a terminal echo went in loop 2 (Buildroot, stamps in the machine worker and the page, since
removed): key to worker 0.5, worker to drained (the guest's echo plus `runAsync`'s 10 ms wait) 9.8,
drained to the page 1.9–3.8, page to glyph ~17. Two changes:
- **The core notifies the TX ring's head** on a byte into an empty ring, and parallel `runAsync`
  sleeps on it as well as on its coordinator word: worker to drained went from 9.8 to 3.2 ms
  (Buildroot; ~7–8 ms on Debian, the guest itself).
- **The machine worker draws the screen** (an `OffscreenCanvas`), with dirty rows. The ~20 ms on
  the page came from the page running an animation-frame loop at all: with it, the worker's
  messages waited 2–6 ms and xterm.js's render landed a frame late (page to glyph ~17 ms);
  without it, 0.4 and ~2 ms. The full copy itself was cheap (0.35 ms convert + 0.11 ms
  `putImageData` per 1024×768 frame on the main thread), and dirty rows alone didn't help (the
  loop stayed). Variants measured on Debian (`variant-*.json`; the first three read the screen
  with `getImageData` in the page's own frame loop, the last two with a draw stamp, so screen
  numbers compare within each group only): the page's loop with dirty rows, terminal 34.7 / screen
  20.2; a 16 ms timer on the page instead, 11.2 / 29.9; frames while the screen changes and a timer
  otherwise, 27.4 / 20.8 (fbcon's blinking cursor keeps it in frames); the page's loop, 30.1 /
  14.1; the worker, 11.1 / 18.1. The worker's is the only one that keeps both. Headless Chromium
  produces frames on demand, so part of the loop's cost may be headless-only; the main thread is
  free of the screen either way.

The rest of a terminal echo is the guest (Debian's tickless bash on ttyAMA0 ~7 ms) and the page
(~2 ms). No regression: `smp_user_jit_4` total, A (0c36e6e) / B (this loop) alternated: A 30,676
(±125), 31,239 (±436) ms; B 30,956 (±100), 30,885 (±360) ms. Page load to `running` (Debian, 4
vCPUs, fresh overlay): 29.0, 28.9, 28.6 s (loop 2: median 30.3), with ~2,400 serial messages to the
page during the boot (23 KB).

A serial flood (`yes` on Debian's ttyAMA0) stays interruptible: Ctrl+C returns the prompt in
~55 ms and the screen keeps drawing (before and after the change; `runAsync` now waits 1 ms rather
than returning at once when output came in since its last return, so a caller can't spin on
microtasks).

## M8 loop 4: loading and boot progress

Chromium 153.0.8010.52 headless, the M4 VM; the page (`web/app/`), Debian on 4 parallel vCPUs, a
fresh overlay each run. Page load to `running` (the serial login prompt): 28.6, 29.1, 28.9, 29.0 s
(loop 3: 29.0, 28.9, 28.6): streaming the downloads for their progress costs nothing measurable.
Where the time goes (one run, 50 ms polling): the downloads (77.6 MB: the kernel, the initrd and
the core, from localhost) are done 0.22 s after page load; fbcon draws its first pixels 2.4 s
later (1.7 s of guest time: the kernel switches its console to the framebuffer then, replaying
the log); the login prompt comes 26 s after that. So the boot card over the screen (the downloads'
progress, then the kernel's serial lines) shows for ~2.6 s, and the screen itself is the boot's
progress for the rest. Raw: `results/m8-loop4/page-running.json`.

## M8 loop 5: `npm start`

Node 26.7.0, rustup 1.29.1, Chromium 153.0.8010.52 headless, the M4 VM. A copy of the repository
as a clone has it, run by `tests/start.test.ts`: with the core copied in, **the URL is printed
1.2 s after `npm start`** (`npm ci` ~0.4 s, Debian's SHA512 over 403 MB and the kernel and initrd
taken out of its `/boot` in Node, ~0.4 s of it, the disk hard-linked from the cache) and the page
reaches `running` 28.7 and 30.7 s later (loop 4: 28.6–29.1 s from page load: unchanged). Building
its own core (`WAARM64_START_COLD=1`): the URL at 11.6 s. A cold `scripts/build-wasm.sh` in a `git
clone` takes 10–11 s (the pinned nightly already installed; installing it into an empty
`RUSTUP_HOME` took 6 s and 722 MB). **With nothing to do, `npm start` serves in ~0.1 s** (0.2 s
through npm). The real download from cloud.debian.org: 7.8 s (55 MB/s). `images/build.sh debian`
now runs the same Node code, 1.6 s, and its outputs match `images/SHA256SUMS`. No boot benchmark
ran: nothing on their path changed (`tools/serve.ts` gained a host parameter and a listen error).
Raw: `results/m8-loop5/npm-start.json`.

## M8 loop 6: the page end to end on Debian

Chromium 153.0.8010.52 headless, Node 26.7.0, the M4 VM. The page's Debian on **2 parallel
vCPUs** (the end-to-end test's configuration), a fresh profile each time: page load to `running`
(the serial login prompt) 30.8–32.5 s, median **31.5 s** over 12 boots (loop 0's throwaway page:
39.3 s on 2 vCPUs; the trimmed command line and later loops' changes account for it; on 4 vCPUs
the page takes ~29 s). `tests/page-debian.test.ts` (three boots: fresh, reloaded, reset; logins
on both consoles) takes **110–112 s** alone, 8 of 8 runs passing with the final test; its phases
(logged in on both consoles at ~38 s, reloaded and running at ~69 s, reset and running at
~106 s) move by under a second between runs. One earlier run sat in `booting` for its whole 240 s
wait, without diagnostics; the page's ready marker is now matched anywhere in the output (the
likely cause: docs/frontend.md "The end-to-end test"). No boot benchmark ran: nothing on their
path changed. Raw: `results/m8-loop6/page-debian.json`.

## M8 loop 7: phase A's exit; an address dependency lost in V8

Node 26.7.0 and Chromium 153.0.8010.52 headless, the M4 VM. **The fix:** in parallel SMP the JIT
emitted `eor wN, wM, wM` as `x ^ x`, which TurboFan folds to 0, dropping the guest's address
dependency (docs/jit.md "Atomics"). The litmus image in Node, parallel JIT, 4 vCPUs,
`-s 1000 -r 200` (400K outcomes a test), 3 runs each: before, MP+dmb.sy+addr's forbidden outcome
**33, 12 and 50 times** (95 in 1.2M); after, **0** (and no other failure). With `-r 50` the
unfixed build failed 5 of 5 runs (the Node parallel JIT test now runs at `-r 50`); at CI's former
`-r 10` 1 of 3 even with `--no-liftoff`: most short-run code is Liftoff's, which doesn't fold.
**Cost:** `smp_user_jit_4` (Alpine userspace on 4 parallel vCPUs), A/B alternating in one
session, 3 runs × 2 samples each: total median 31,191 ms before, 31,131 ms after (compress 2,815
→ 2,717, lua 5,011 → 5,054, churn 4,915 → 4,876, sqlite 4,083 → 4,045): noise. Deterministic and
one-vCPU modules are unchanged (the zero global is defined only in parallel modules). Raw:
`results/m8-loop7/litmus.json`, `results/m8-loop7/smp-user-{base,new}-{1,2,3}.json` (`base` is
b8efa00).

**CI time and the Debian tests** (full `scripts/ci.sh`, warm caches, this host): `npm test` 290 s
in loop 6's last run, 303 s in this loop before the test changes (the Node parallel litmus at
`-r 50`: 13.6 → 33 s under load), 297 s after; `scripts/ci.sh` 446 s. `npm test`'s wall time is
`tests/boot-node.test.ts`'s, whose tests run in sequence (290 s in loop 6, 297 s now). Leaving
out Chromium's deterministic Debian boot (81–85 s) saved nothing (299 s) and was reverted (it's
the only deterministic Debian run in CI); the fresh copy's `npm start` test now stops when the
kernel takes the screen (5.2 s after the URL in CI, was 37–47 s), so the Debian page pair ends at
~186 s instead of ~222–230 s.

## M8 loop 8: the user's rough edges

Node 26.7.0 and Chromium 153.0.8010.52 headless, the M4 VM. **`timer.bin` under load:** the old
and new binaries alternated in a loop while both Debian page tests ran at once beside the rest of
`npm test` (`tests/debian-lock.ts` bypassed), the load that broke it in loop 6. Old: 451 runs, 3
failures of the TVAL check (exit 10) and 1 stall; new: 450 runs, no TVAL failure, 2 stalls ("no
vCPU retired a step in 30000 ms": the host starved every vCPU for 30 s, in both binaries alike,
a load CI doesn't reach). Raw: `results/m8-loop8/timer-load.json`.

**A memory leak in Node's parallel runs, found by running out of memory:** twice in this loop a
Node test process of `npm test` grew to 6.2 and 6.9 GB and the VM's OOM killer ended it (and
with it the developer's session). Cause: in parallel mode in Node the device backends serve the
vCPUs' doorbell on the VM's thread through `Atomics.waitAsync`, which `Devices.close` never ended,
so every closed VM's memory stayed reachable (~10 MB a bare-metal boot, GBs over
`tests/boot-node.test.ts`). `close` now ends `serve`; `tests/boot-node.test.ts` "parallel: a
closed VM is garbage-collected" checks it (a WeakRef to the memory, forced GCs). The page wasn't
affected (a worker per machine, terminated on restart): its tab's memory stayed flat over
repeated restarts.

## M8 phase B loop 3: the page's Debian through UEFI

Chromium 153.0.8010.52 headless, the M4 VM, 2 vCPUs, first boot on a fresh profile, A/B alternated
(3 + 3; `results/m8-phaseb-loop3/page-boot.json`). Time from the page load to `running` (the
login prompt): **direct boot 33.3 s** (32.5, 33.9, 33.3: the kernel and initrd out of the image, the
page's command line) against **53.4 s through EDK2, shim and GRUB** (52.9, 54.6, 53.4). The
+20 s: EDK2 to the kernel ~9 s (Node's stages: boot manager 3.7 s, GRUB's banner 6.7 s, kernel
9.3 s), GRUB's 5 s menu timeout, and ~5 s more in userspace, because GRUB's command line has
neither `apparmor=0` nor the masked units the page's had (docs/frontend.md "Debian through UEFI").
**The busy wait the loop 2 handover suspected between the boot manager and GRUB's menu isn't one:**
the 5.4 G steps (~3 s) are an LZMA range decoder (PC samples at one place; its disassembly shows
the `>> 11` and `>> 5` probability updates), most likely the loader's compressed core image being
unpacked; no WFE or timer would make it idle.

## M8 phase C loop 4: the snapshot's RAM codec

2026-10-01, the M4 VM, Chromium 153.0.8010.52 headless (a worker, cross-origin isolated) and
Node 26.7.0; other work ran on the machine (load 1.6 to 3.6 in the Chromium runs, ~4.9 in
Node's: the ratios are what to read). Raw: `results/m8-snapshots-loop4/` (every sample, 7 per
cell, codecs alternated). RAM images of guests at their power-off, cut as the snapshot file
cuts them (1 MiB chunks, zero 4 KiB pages left out, each chunk compressed alone), every restore
checksummed against the original. `alpine-user8` is the userspace benchmark with eight
workloads at once, the heaviest guest short of Debian: 304 MB of non-zero pages, the size the
page's Debian is assumed to have after a login (its pages are sparser than a page cache's, so
both codecs do somewhat better on it than they will there).

| image (non-zero pages) | codec | file MB (ratio) | save, 1 worker | save, 4 | restore, 1 worker | restore, 4 |
|---|---|---|---|---|---|---|
| alpine (94.7 MB) | deflate-raw | 29.3 (3.2x) | 1.19 s | 0.32 s | 0.15 s | 0.044 s |
| | the core's LZ | 42.5 (2.2x) | 0.22 s | 0.061 s | 0.073 s | 0.020 s |
| alpine-user (122.7 MB) | deflate-raw | 37.5 (3.3x) | 1.71 s | 0.47 s | 0.21 s | 0.063 s |
| | the core's LZ | 54.1 (2.3x) | 0.27 s | 0.081 s | 0.090 s | 0.028 s |
| alpine-user8 (304.3 MB) | deflate-raw | 64.0 (4.8x) | 2.78 s | 0.93 s | 0.41 s | 0.16 s |
| | the core's LZ | 91.0 (3.3x) | 0.44 s | 0.149 s | 0.203 s | 0.067 s |

Per thread: `CompressionStream`'s deflate-raw compresses 75 to 115 MB/s and decompresses 600 to
780 MB/s (in Node 45 to 65 and 165 to 260); the LZ (`core/src/lz.rs`, the LZ4 block format,
greedy, our own code) 640 to 840 MB/s and 1.4 to 1.7 GB/s, the same in Node (it is the same
wasm). The zero-page scan alone is 14 to 17 GB/s (0.07 s for 1 GiB). zstd isn't in Node's
`CompressionStream`, so it wasn't a candidate.

**Decision: the LZ, on one worker.** Save is what the user waits for with the machine paused:
0.44 s against 2.8 s at Debian's assumed size, for a file 1.4 times larger (91 MB against 64 MB,
kept locally). It is synchronous, needs no copy out of the shared memory (`CompressionStream`
refuses shared views), and its bytes and speed don't depend on the host's zlib. Four workers
would take the save from 0.44 s to 0.15 s: not worth their complexity now. If they come, chunks
must be dealt out interleaved (chunk *c* to worker *c* mod *n*): contiguous ranges scaled 1.4x on
four, because the non-zero pages sit at low addresses. The file's frames name their codec, so
deflate-raw stays readable (codec 1) and can be offered where size matters.
Not measured: Debian's own RAM, file I/O, the disk's blocks.

## M8 phase C exit: snapshots on the page

2026-10-01, the M4 VM, Chromium 153.0.8010.52 headless, Debian 13 through UEFI on 2 parallel
vCPUs with 1 GiB, logged in on the serial console. **These are the page tests' own timings**
(`tests/page-snapshot.test.ts`; two to four runs each, beside other work on the machine), not
`bench/run.ts` cases with medians and IQR: read them as orders of magnitude. Raw:
`results/m8-snapshots-exit/page.json`.

| | Debian | Buildroot (256 MiB) |
|---|---|---|
| Boot: page load to `running` | 54 to 57 s | |
| Save snapshot: the file | 170 to 178 MB | 7.8 MB |
| Save snapshot: the machine paused | 1.3 to 1.4 s | 0.07 to 0.11 s |
| Load snapshot, fresh profile: the choice to `running` | 2.1 s | 0.14 to 0.42 s |
| Suspend: the click to `suspended` (the copy kept: 174 MB) | 1.3 s | |
| Resume: a reload to `running` | 0.8 s | 0.15 s |

A booted Debian is back in 2 s from a file and under 1 s from a suspend, against a 55 s boot.
The pause of a save is mostly the file's write (the codec alone compresses that RAM in ~0.5 s,
"M8 phase C loop 4"). In Node, Alpine's userspace benchmark (1 GiB) saves a 40 to 46 MiB file in
0.3 to 0.5 s and starts from one in 0.13 to 0.24 s (`tests/snapshot.test.ts`'s medians).


## M8: where the userspace benchmark's time goes (a profile, and a chaining gap)

2026-10-02, the M4 VM, `d43a536`. `alpine_user_jit` (direct kernel boot, deterministic, one vCPU)
in **Node 26.7** (V8 14.6) under `perf` with `--perf-prof`, split by phase with
`bench/boot/userprof.ts` and `userprof-perf.ts` (new; docs/benchmarking.md "Profiling"), plus two
diagnostic builds of the core (`results/m8-userprof/*.patch`: not for commit). The profile is
Node's; the A/B at the end is `bench/run.ts` in Chromium 153.0.8010.52. Raw:
`results/m8-userprof/`.

**Per phase** (Node, before any change): boot 7.4 s at 318 MIPS, compress 2.6 s at 823, Lua 4.6 s
at 694, churn 1.6 s at 338, SQLite 3.6 s at 600, shutdown 1.0 s at 318. For scale: CoreMark in a
VM runs at ~1,900 MIPS and the EL1 small guest at 4,045.

**Where the main thread's time is** (% of each phase's samples; `base-perf.txt`):

| | boot | compress | Lua | churn | SQLite |
|---|---|---|---|---|---|
| guest code, TurboFan | 24.6 | 64.1 | 75.4 | 43.3 | 64.4 |
| guest code, Liftoff | 35.3 | 7.6 | 3.1 | 37.2 | 5.9 |
| the dispatcher (`jit::steps`, `Cache::miss`) | 4.8 | 10.2 | **14.8** | 2.1 | **18.2** |
| V8's own work on this thread (lazy compiles, module creation, builtins) | 18.2 | 5.2 | 2.7 | 11.4 | 4.3 |
| the interpreter and helper bodies | 10.7 | 7.4 | 2.0 | 2.3 | 4.4 |
| the core's compiler | 3.0 | 0.8 | 0.3 | 0.4 | 0.6 |
| TLB misses and walks | 0.2 | 0.9 | 0.0 | 0.6 | 0.1 |

Two regimes. **Compute phases** (compress, Lua, SQLite) run TurboFan code, and spent 10 to 18% in
the dispatcher. **Cold, kernel-heavy phases** (boot, churn, shutdown: 10 of the run's 22 s) spend
over a third in Liftoff code and 11 to 18% in V8's compiles, as M6 loop 4 found for the boot.
Helpers, the TLB and our own compiler are small everywhere (compress's helper share is one
instruction: `UQSUB`, 2.0M calls).

**Why the dispatcher: cross-page direct branches never chain in a process.** The userspace phases
return to the dispatcher once per 38 (SQLite), 49 (Lua) and 85 (compress) instructions, against
once per 282 in the boot: 150M dispatches at ~11 ns each. By reason (`dispatch-reasons.txt`): 97
to 98.5% of them enter a block that is compiled, in the jump cache and in the instruction TLB,
from a block that ended in a **direct** branch (`B` 55%, `BL` 35% in Lua; `BL` 36%, `B` 30%,
`B.cond` 15% in SQLite). The cause: `block::chain` names a successor in another page by PA
arithmetic (`succ(key, off)`: the block's PA plus the branch offset), which is the successor's PA
only if the two virtual pages are physically contiguous. The kernel's image is; a process's file
pages aren't. So the link is to a key that is never compiled (or its `maps_to` guard fails), and
every call to another page, every `b` to a label in another page and every fall-through at a page
end returns to the dispatcher, each time. Jump-cache conflicts and instruction-TLB misses, the
suspects before measuring, are ~1% of dispatches.

**A prototype** (`chain-by-va-prototype.patch`, 20 lines in `block::chain`): a successor in another
page keeps its guarded direct link when it's compiled at the contiguous PA, and otherwise (or when
the guard fails) is looked up as an indirect branch's target is, by its VA through the instruction
TLB and the jump cache (`emit::indirect`). Steps and the phases' check lines are unchanged.
Dispatches: Lua 66.1M → 1.7M, SQLite 56.6M → 0.9M, compress 25.0M → 0.8M; the dispatcher falls to
1 to 2% of every phase (`fix-perf.txt`).

| `alpine_user_jit`, Chromium, alternated A, B, A, B; medians (IQR), 3 boots each | A (`d43a536`) | B (prototype) | |
|---|---|---|---|
| compress | 2890 (55), 2882 (34) | 2630 (75), 2616 (10) | −9% |
| Lua | 5178 (80), 5152 (56) | 4688 (64), 4598 (53) | −10% |
| churn | 2217 (47), 2176 (27) | 2176 (12), 2174 (6) | |
| SQLite | 4056 (48), 4030 (6) | 3602 (278), 3523 (17) | −12% |
| total, to power-off | 24,299 (267), 24,101 (172) | 23,187 (191), 22,921 (37) | −4.7% |

Steps 10,763,178,470 in all four; dispatches 163.3M → 7.4M. Node agrees (three alternated pairs,
`node-ab.txt`: Lua 4.73 to 4.87 → 4.18 to 4.26 s, SQLite 3.61 to 3.72 → 3.26 to 3.30 s, compress
2.52 to 2.65 → 2.45 to 2.47 s; boot and churn within noise).

**Landed** (the prototype's code, in `block::chain`; docs/jit.md "Linking"). The kernel's own
cross-page links are physically contiguous and keep their direct calls; the lookup by VA is their
fallback, and what a successor not compiled yet gets. Alpine's boot, alternated B, A, B, A in
Chromium (`boot_alpine_jit-*.json`; warm medians, IQR): A 10,211 (45), 10,303 (24) ms; B 10,249
(114), 10,631 (23) ms. Not separable from the session's drift at two pairs (+0.4% and +3%; the
boot is the cold regime, where chaining isn't what costs); steps 2,856,663,287 in all four,
dispatches 12.3M → 3.5M, wasm 22.5 → 23.6 MB (+5%: the lookup's code at every cross-page edge),
compile time unchanged (303 to 322 ms). **Tests:** `block::tests::a_successor_in_another_page_is_found_by_its_va`
(the emitted links), and in `tests/jit.test.ts` a loop over two virtual pages that aren't
contiguous physically, with other code compiled at the PA that would follow and a remap to it
and back: results as interpreted, under 20 dispatches for 5000 steps (2000 before). Planted bugs
caught by it: the direct call without its check (the decoy's code runs), the lookup reading the
other EL's TLB (2000 dispatches), no lookup after a failed check (1001 dispatches).

**What is left after it: the transfers between blocks** (`transfers.txt`, the prototype plus
counters in the emitted code). A block executes 4.6 to 5.5 instructions, so there are ~200
transfers per 1000 instructions, and in Lua and SQLite 89 to 98% of them leave one wasm function
for another (loop regions cover 1.5% and 11% of their block executions; 30% in compress):

| per 1000 instructions | compress | Lua | SQLite |
|---|---|---|---|
| direct, same page (a tail call to another function) | 82.7 | 132.7 | 123.0 |
| direct, another page by its VA (the prototype's) | 11.5 | 20.1 | 26.2 |
| direct, through the jump cache or to a contiguous page | 10.6 | 10.9 | 13.9 |
| `RET` | 8.4 | 11.7 | 16.7 |
| `BR` / `BLR` | 2.6 / 0.7 | 22.6 / 1.3 | 7.7 / 4.0 |
| inside a region (forward edges, back-edges) | 55.0 | 3.1 | 22.9 |

What a transfer costs, from V8's code for hot blocks (`perf annotate`): a five-instruction block
(two loads, a test, a conditional branch) is ~85 host instructions on its hot path, of which ~30
do the guest's work (two inline TLB lookups) and the rest is the block's frame and stack check
(9), reloading registers from the `Cpu` (3), four write-backs (the registers, NZCV, the PC) each
behind a reload of the memory's size and a bounds check (24, **this host only**: [docs/v8.md](../../docs/v8.md)
"Bounds checks"), materializing NZCV (6), the PC (4) and the budget check and tail call (9). An
indirect transfer (`BR`, `RET`, the prototype's by-VA link) adds ~50: the instruction TLB lookup,
the jump-cache probe (the entry's load carries 13 to 32% of such a block's samples: the cache is
1 MiB) and `return_call_indirect`'s table bounds, signature check and code-pointer load. So in
hot userspace code more than half of the host's work is moving between blocks, which is what
separates these phases (600 to 900 MIPS) from guests whose loops are regions (4,000). What follows
from it is in [docs/backlog.md](../../docs/backlog.md) "JIT".

## M8: forward regions (a batch's blocks compiled once each, as functions of several blocks)

2026-10-02, the M4 VM, on `939987b` (the chaining fix above). After that fix, hot userspace code
still left one wasm function for another at 89 to 98% of its block-to-block transfers, two thirds of
them direct and within one guest page ("the transfers between blocks" above). **Forward regions**
(docs/jit.md "Compile policy") make those edges internal: when a batch is compiled, each block takes
the batch's other blocks that static edges reach from it (same page, at most 16, not a call's
target, not a loop head), and the group is one function whose edges keep registers and flags in
locals. A block is compiled once per batch, as a head or as a member; a member entered from
elsewhere is counted and compiled again as a head. Loop regions and their tier-up are unchanged.

**Chromium 153.0.8010.52, alternated A, B, A, B** (A: `939987b`; B: forward regions; medians, IQR;
`results/m8-forward/`, `../interp/results/m8-forward/`):

| | A | B | |
|---|---|---|---|
| `alpine_user_jit` compress (ms) | 2669 (24), 2611 (11) | 2453 (94), 2539 (114) | −5.5% |
| Lua | 4713 (41), 4626 (31) | 3859 (15), 3908 (24) | −17% |
| churn | 2293 (9), 2223 (28) | 1952 (41), 1973 (3) | −13% |
| SQLite | 3601 (30), 3526 (27) | 3204 (19), 3229 (11) | −10% |
| total, to power-off | 23,569 (196), 22,828 (100) | 20,652 (135), 21,079 (223) | −10% |
| Alpine boot to power-off, warm / cold (one pair) | 10,319 (37) / 10,393 (91) | 9754 (39) / 9738 (20) | −5.5% |
| Buildroot boot to power-off, warm / cold (one pair) | 675 (4) / 709 (7) | 727 (7) / 755 (17) | **+8%, +6.5%** |
| CoreMark, user mode (it/s) | 8483 (121), 8435 (260) | 9964 (176), 9898 (251) | +17.5% |
| integer guest (MIPS, eight placements) | 5115 (49), 5054 (157) | 5109 (64), 5105 (39) | |
| EL1 guest, MMU off / on (MIPS) | 4706, 4717 / 3876, 3880 | 4673, 4785 / 3887, 3899 | |
| FP guest (MIPS) | 156.0, 155.5 | 156.2, 155.8 | |

Steps unchanged (userspace 10,763,178,470; Alpine 2,856,663,287; Buildroot 40,505,789). Buildroot's
half-second boot is the loss (a check, not a target: docs/benchmarking.md), from more wasm compiled
while it is still cold. With the chaining fix, the day's two changes take the userspace benchmark
from 24.2 to 20.9 s (−14%), Lua from 5.17 to 3.88 s (−25%) and SQLite from 4.04 to 3.22 s (−20%);
CoreMark is at 79% of QEMU TCG's user mode (it was 69%).

**What was compiled** (Alpine's boot, `boot_alpine_jit-*.json`): 47,215 functions of 49,438 blocks
became 28,469 of 53,463; wasm 23.6 → 27.2 MB (+15%: the blocks compiled a second time as heads, 8%
of them, and the edges' code); modules 1820 → 2004; install time 306 → 327 ms; steps interpreted
40.9M → 43.7M (members waiting to be compiled as heads). **Transfers** (`transfers.txt`, Node, a
diagnostic build): per 1000 instructions, edges inside a region went from 3 to 105 in Lua, 23 to
118 in SQLite and 55 to 107 in compress; direct tail calls within a page fell from 133, 123 and 83
to 30, 24 and 29.

**Tried first, and why it lost** (Node, `bench/boot/userprof.ts`; docs/jit.md "Tried and not kept"):
forward regions behind a tier-up, as loops are (every block with a same-page successor compiled
alone with a hot word, its region after N entries). Lua 4.3 → 3.6 to 3.9 s, but boot 7.7 → 8.8 to
9.1 s and churn 1.7 → 2.0 to 2.1 s at N = 1,000, 10,000 and 50,000 alike: the counting prologue in
nearly every block (+16% wasm), run by the cold code that is most of a boot (`perf`: guest code
+17 to 20% in both tiers, identical shares otherwise). Batch-time regions need no prologue: in Node
(`node-ab.txt`, two alternated pairs) boot 7.68 → 6.94 to 7.04 s, compress 2.41 to 2.45 → 2.25 to
2.29, Lua 4.22 to 4.39 → 3.58 to 3.60, churn 1.67 to 1.72 → 1.42 to 1.43, SQLite 3.30 to 3.32 → 2.94
to 2.96, shutdown 1.04 to 1.07 → 0.89. Flat within noise on top of them: a cap of 8 or 32 blocks,
and taking calls' targets into the caller's region.

**Where a hot region's time goes now** (`perf annotate`, Node, a Lua region of three blocks, 14
guest instructions in ~185 host instructions): its seven guest memory accesses are 11 instructions
each (the inline TLB), and its exit writes back five values (three registers, NZCV, the PC), each
behind a reload of the memory's size and a bounds check: 30 instructions carrying ~45% of the
function's samples. That cost exists only where V8 has no trap handler (this Linux arm64 host;
docs/v8.md "Bounds checks"), so this VM's numbers overstate what write-backs cost on macOS and
x86_64, and understate what forward regions gain there relative to it. docs/backlog.md "JIT" has
what follows.

**Tests:** `block::tests::a_forward_region_is_the_blocks_in_reach_without_calls`,
`jit::tests::a_batch_is_planned_as_forward_regions_and_loop_heads`, a forward region end to end in
`tests/jit.test.ts` (three functions for six blocks, results as interpreted, under 20 dispatches);
the differential test's region class compiles them (2,582 blocks in 1,333 regions). Planted bugs
caught: a forward edge that doesn't bring the registers to the member's entry state (16 of 1024
programs differ), a region that takes a block of the next physical page (the cross-page test: the
decoy's code runs), members left in the batch (compiled twice at once: the plan's unit test and
the end-to-end function count).

## M8: regions across pages; calls followed, returns predicted

2026-10-02, the M4 VM, on `311d21e` (forward regions). **Where calls and returns go** (Node, a
diagnostic build; per 1000 instructions): calls to another page 7 to 19 against 1 to 4 within one,
returns to another page 8 to 20 against 1 to 4, other direct branches to another page 6 to 17. So
85 to 90% of calls and returns cross a page, where a region ended. Two changes (docs/jit.md
"Compile policy"):

- **A forward region takes blocks of other pages**: the batch's block seen at the successor's VA,
  entered through an edge that checks the mapping (unless the member is where its predecessor's
  page or the head's has it); the region is filed under each of its pages.
- **Calls are followed, and a `ret` is predicted** to return after the call that led to it: an
  edge to the block there when X30 says so, the indirect branch otherwise.

**Chromium 153.0.8010.52, alternated A, B, A, B** (A: `311d21e`; B: both changes; medians, IQR;
`results/m8-xpage/`, `../interp/results/m8-xpage/`):

| | A | B | |
|---|---|---|---|
| `alpine_user_jit` compress (ms) | 2463 (122), 2448 (122) | 2389 (8), 2407 (7) | −2% |
| Lua | 3893 (104), 3890 (25) | 3719 (12), 3734 (16) | −4% |
| churn | 2056 (54), 1993 (6) | 1954 (18), 1970 (4) | −3% |
| SQLite | 3202 (41), 3207 (25) | 2940 (17), 2934 (10) | −8% |
| total, to power-off | 21,138 (347), 20,913 (265) | 20,387 (101), 20,537 (91) | −2.7% |
| Alpine boot to power-off, warm / cold (one pair) | 9852 (88) / 9874 (173) | 9871 (26) / 9921 (13) | |
| Buildroot boot to power-off, warm / cold (one pair) | 725 (4) / 754 (17) | 775 (3) / 802 (8) | **+7%, +6%** |
| CoreMark, user mode (it/s) | 9982 (202), 9874 (273) | 10,088 (72), 10,069 (51) | +1.4% |
| EL1 guest, MMU on / integer guest (MIPS) | 3960, 3933 / 5135, 5125 | 3891, 3953 / 5141, 5112 | |

Steps unchanged (10,763,178,470; 2,856,663,287; 40,505,789). Alpine's boot: 28,469 functions →
26,007, wasm 27.2 → 29.6 MB (+9%); the userspace run 31.4 → 34.1 MB. Buildroot's boot loses again
(it is 15% slower than before forward regions: more wasm compiled while everything is cold). The
day's three JIT changes together: the userspace benchmark 24.2 → 20.5 s (−15%), Lua −28%, SQLite
−27%, compress −17%, churn −11%.

**Smaller than the counts promised, and why** (the same diagnostic, before → after, Lua / SQLite):
calls leaving for another page 8.8 → 6.1 / 11.7 → 7.5, returns to another page 10.0 → 9.2 / 15.7 →
14.4, other direct branches to another page 13.4 → 10.4 / 17.0 → 8.4. A region takes only blocks
of **its own batch**, and a shared callee is compiled long before most of its callers: the call
still leaves, and then nothing predicts the return.

**Tried on top, not kept** (Node; `results/m8-xpage/callee-copies-experiment.patch`): copying an
already compiled callee into the caller's region (found through the instruction TLB). Only small
leaf functions (every path returns within 4, or 10, blocks, without calls): no phase moved (Lua
3.40, 3.43 → 3.47 to 3.54 s). Any callee, up to the region's 16 blocks: wasm +80% (Alpine's boot
27 → 48 MB, 7.0 → 9.2 s; churn 1.4 → 1.65 s), Lua 3.42 s, SQLite 2.72 → 2.82 s. So what calls and
returns still cost is not for want of inlining; it is the price of each transfer that leaves
(docs/backlog.md "JIT": the indirect transfers, and on this host the write-backs' bounds checks).

**Tests:** `block::tests::a_forward_region_is_the_blocks_in_reach_with_calls_and_their_returns`
(formation, `Region::checked`, the predicted return's bytes); in `tests/jit.test.ts`, two calls of
one function in one region (one return predicted, one not), and a region across two pages that
aren't contiguous physically (remapped to a decoy and back; rewritten with `ic ivau` on its second
page). Planted bugs caught: the edge into another page without its check (the old page's code
runs after the remap), a region filed under its head's page only (the rewritten page's old code
runs), a predicted return taken without comparing X30 (x6 66,668 for 200,000).

**The stale-code checker and `maint.bin` without its `IC IVAU`** (`tests/boot-node-suite.ts`): the
default JIT used to fail the guest's check 401 there (the rewritten function's old code ran, as
is allowed without the IC). With calls followed, the old code is inside the region of the loop
that called it, and the checking call, from another block, finds the function not compiled and
interprets the new code: the test now accepts either under the default JIT, and still requires
JIT-check's checker to trap (it does). **Tried and not kept:** the checker on every edge inside a
region, not only at entries and back-edges (a member can be rewritten by code of its own region,
which the checker then sees only at the region's next entry): JIT-check re-hashes the whole
region at each edge, and the 4-vCPU litmus test under it took 24 min instead of 71 s.

**A parallel-SMP panic in forward regions, found here and fixed** (it is in `311d21e` too): a batch
reads each head's words twice (`Cache::plan`: once to find loops, once to form the forward region),
and on parallel vCPUs another vCPU can rewrite the code in between (Linux patching itself at boot).
The second read then gives no blocks, and an unguarded `blocks[1..]` panicked in the vCPU's worker:
a 2-vCPU Buildroot boot "hung" about once in 20 to 200 boots (`trim.test.ts` in CI, `ci-long`).
After the fix, 500 boots on 2 vCPUs and 200 on 4 in a row (an ad-hoc loop) all powered off.

## M8: the same builds on the Mac host (no explicit bounds checks)

2026-10-02. `alpine_user_jit` in Chromium 153.0.8010.12 (Playwright's Chrome for Testing,
headless) **on the Mac host itself** (the M4 Mac mini, macOS 26.6, where V8 has its wasm trap
handler and JIT code carries no explicit bounds checks), through `bench/run-mac.sh` (new: it
copies the pages, the core and the images there). Medians (IQR) of 3 boots, the builds alternated;
`results/m8-mac/`. The dev VM's numbers are the sections above (Chromium 153.0.8010.52).

| ms | compress | Lua | churn | SQLite | total |
|---|---|---|---|---|---|
| `d43a536` (before the day's JIT changes) | 2254, 2265 | 4460, 4501 | 1268, 1272 | 3307, 3346 | 17,978, 18,123 |
| `311d21e` (chaining by VA, forward regions) | 1955, 1972 | 3381, 3400 | 1117, 1119 | 2654, 2693 | 15,249, 15,373 |
| regions across pages, predicted returns | 1836, 1878, 1886 | 3126, 3208, 3226 | 1066, 1100, 1091 | 2304, 2343, 2356 | 14,375, 14,657, 14,691 |
| the same, `--wasm-enforce-bounds-checks` | 2862, 2875 | 4062, 4068 | 1854, 1791 | 3598, 3589 | 21,616, 21,423 |
| the same, in the dev VM (above) | 2389, 2407 | 3719, 3734 | 1954, 1970 | 2940, 2934 | 20,387, 20,537 |

- **A macOS user's machine runs the benchmark in 14.6 s where the dev VM takes 20.5 s**, and the
  difference is the bounds checks: with them enforced, the Mac takes 21.5 s. Explicit checks cost
  47% of the whole run there (compress +53%, Lua +27%, churn +68%, SQLite +54%), in the core's
  own code as well as the JIT's. QEMU TCG runs it in 11.2 s.
- **The day's JIT changes are worth more without the checks:** 18.0 → 14.6 s (−19%; Lua −29%,
  SQLite −30%, compress −17%, churn −14%) against −15% in the VM. Regions across pages with
  predicted returns alone: −4.5% (SQLite −13%, Lua −5.5%) against −2.7%.
- So the VM's profiles overstate what a region's write-backs cost a macOS or x86_64 user (they are
  what the checks guard), and the fixed-size memory (docs/backlog.md) is a matter for Linux arm64
  and Android hosts only.

## M8: a VA-keyed cache for indirect transfers (the transfer cache)

2026-10-03. `BR`, `BLR`, `RET` and the by-VA links to other pages (25 to 55 per 1000 instructions
in the userspace benchmark) found their target through two tables: the instruction TLB of the
block's EL (VA to PA, the key) and then the 1 MiB jump cache (key to function). They now probe one,
`Tlb::xc`: 16,384 entries of {VA and regime bits, table index | length << 32 | generation << 48},
per vCPU (docs/jit.md "Indirect transfers"). The A/B is `44dcda9` against the change, alternated in
one session; JSON in `results/m8-xc/`.

| | base | transfer cache | |
|---|---|---|---|
| **dev VM, Chromium 153.0.8010.52**, `alpine_user_jit` total (n9, n6) | 20,088 [20,006–20,161] | 19,810 [19,740–19,895] | −1.4% |
| Lua | 3721 | 3373 | −9.4% |
| SQLite | 2927 | 2788 | −4.7% |
| compress, churn | 2367, 1895 | 2368, 1907 | 0, +0.6% |
| `boot_alpine_jit` total (n10 each) | 9834 [9645–9863] | 9935 [9891–9964] | +1.0% |
| the same, cold (n6) | 9828 | 9903 | +0.8% |
| **Mac host, Chromium 153.0.8010.12** (no bounds checks), `alpine_user_jit` total (n6) | 14,743 [14,702–14,808] | 14,329 [14,265–14,363] | −2.8% |
| Lua, SQLite | 3219, 2358 | 2916, 2214 | −9.4%, −6.1% |
| compress, churn | 1886, 1101 | 1831, 1114 | −2.9%, +1.2% |
| `boot_alpine_jit` total (n10) | 6504 | 6548 | +0.7% |
| **dev VM**: Buildroot `boot_jit` total (n40) | 756 | 768 | +1.5% |
| CoreMark, `jit_mips`, `vm_jit_mmu_mips` (MIPS, 8 placements) | 2463, 5128, 3937 | 2456, 5122, 3906 | −0.3%, −0.1%, −0.8% |

What it took to get there (`bench/boot/userprof.ts` in Node, the misses and hits counted by
measurement-only builds; none of these are in the tree):

- **Filled only by the dispatcher, with one generation that every TLB flush bumped** (the
  handover's first design), a miss returned to the dispatcher: Lua −9%, but dispatches went from
  0.71M to 4.67M in the churn phase and from 0.42M to 2.45M at shutdown (+9%, +7% slower). After
  each of a phase's flushes every hot target is refilled through the dispatcher.
- **A miss falls back in wasm** to the old lookup (instruction TLB, then jump cache) and fills the
  entry there: dispatches back to the base's, but boot +6%, churn +7%: 23% of boot's and 30% of
  churn's transfers missed. Of the flushes, 85 to 99% are by VA (TLBI VAE1 on user pages, which
  are mostly data), the rest drop the nG entries (ASID changes). So a flush by VA now drops the
  page's entries (its VAs fill 1024 consecutive slots: a 16 KiB scan), and the generation is per
  EL, an EL's bumped by dropping the nG entries only if its instruction TLB may hold nG ones: the
  kernel's (global) entries survive context switches. Boot's misses: 10.6M → 3.55M.
- **The fallback was a function in every module**, and in each of boot's 1700 modules it stayed in
  Liftoff (123 of boot's 14,800 samples). It is now one pair per cache in table slots 0 and 1,
  which every module imports: it gets hot and optimized, and the modules shrink (26.7 → 26.5 MB
  for Alpine's boot).
- **4096 entries were too few:** 77% of the remaining misses then found the target in the jump
  cache (conflicts). 16,384 entries halve boot's misses (3.55M → 1.7M); 65,536 measured the same
  as 16,384 in Node.

What's left: boot pays about 1% (VM and Mac alike) for the misses through the shared function (141
of boot's 29,500 samples at 4 kHz) and the scans on TLBI by VA (53); the userspace phases'
transfers missed 0.3 to 2% already at 4096 entries. The table costs 256 KiB per vCPU.

## M8: a fixed-size memory (JIT modules import exact limits)

2026-10-03. On Linux arm64 V8 bounds-checks every wasm store explicitly, and with a growable shared
memory it reloads the memory's size after any call before the next check (docs/v8.md "Bounds
checks"). `bootVm` now makes the memory its final size (RAM, the scratch page, fw_cfg's files and
a 1 GiB heap reserve), and JIT modules import it with `initial = maximum`; V8 then loads the size
once per function. Verified first on a micro-module (`--print-wasm-code`): on a memory created
growable to N pages and grown to N, a module declaring (N, N) loads the size once at entry, one
declaring (0, 65536) after each of its calls. Same steps, same JIT code otherwise. A/B is the same
core with `bootVm`'s `fixedMemory` default flipped, alternated in one session; JSON in
`results/m8-fixedmem/` (the Mac's as `mac-*`). Medians of the pooled runs, [quartiles].

| | growable | fixed | |
|---|---|---|---|
| **dev VM, Chromium 153.0.8010.52**, `alpine_user_jit` total (n9 each) | 20,027 [19,897–20,188] | 18,638 [18,523–18,789] | −6.9% |
| compress, Lua | 2334, 3368 | 2217, 3222 | −5.0%, −4.3% |
| churn, SQLite | 1927, 2800 | 1785, 2596 | −7.3%, −7.3% |
| `boot_alpine_jit` total (n15, n25) | 9952 [9932–10071] | 9234 [9191–9416] | −7.2% |
| the same, cold (n9, n15) | 9959 | 9363 | −6.0% |
| Buildroot `boot_jit` total (n30 each) | 768 [764–772] | 725 [719–733] | −5.6% |
| **Mac host, Chromium 153.0.8010.12** (guard pages), `alpine_user_jit` total (n6 each) | 14,168 [14,091–14,259] | 14,265 [14,249–14,321] | +0.7% (noise) |

- The first three fixed `boot_alpine_jit` runs had no growable partner (those runs hit a 90 s
  bound); three more pairs were run alternated, and all five fixed runs are below all three
  growable ones.
- **The profile overstated it:** `perf annotate` put ~45% of a hot Lua region's samples on its
  size reloads, and Lua gained 4.3%. Samples skid onto the load after a store's check; rank by an
  A/B, not by where a profile's samples sit.
- **The reserve costs no memory:** the Node process's RSS after the userspace benchmark is 608 MiB
  fixed and 620–627 MiB growable (the memory is 2048 MiB against 1051). The core's heap grew to
  ~27 MiB in that run.
- **One trap on the way:** the reserve is one `alloc` and `dealloc` of a large block; LLVM deleted
  the unused pair, the memory never grew, and the host then grew it to its maximum, so the first
  allocation in `vm_new` failed. The pointer goes through `black_box`.
- The core module still imports a growable memory (its code still reloads); docs/backlog.md
  "JIT" has what that would take.

## M8: one code cache for all vCPUs

2026-10-03. The user saw a heavy guest load (Firefox in the guest, 4 vCPUs) flush the JIT cache
every few seconds and stay at 200–300 MIPS. Each vCPU worker had its own cache with a quarter of
the 160 MiB budget, and compiled its own copy of the same code. Now the vCPUs share one cache of
160 MiB, and every worker installs the same module bytes, whose machine code V8 compiles once and
shares (docs/jit.md "Sharing"). Dev VM, Chromium 153.0.8010.52; JSON and logs in
`results/m8-share/`.

**The load:** Debian on 4 vCPUs on the page, a cold `go build` of a small program (`fmt` and its
dependencies, the stress image's Go toolchain on a second disk) in a loop for 300 s, timed by the
guest (`bench/stress/stress.ts --no-load --disk2 … --guest-cmd …`, which now prints the share of
steps interpreted, flushes and compile time per sample). One run each, `results/m8-share/stress/`:

| | build (s) | MIPS median | flushes in ~300 s | steps interpreted | renderer |
|---|---|---|---|---|---|
| 4 caches × 40 MiB (before) | 150, 143 | 296 | ~76 | 2–6% | 3.1–3.7 GB |
| 4 caches × 80 MiB | 107, 91, 98 | 449 | ~16 | 0.5–3% | 3.8–4.6 GB |
| 4 caches × 160 MiB | 98, 72, 74 | 511 | 1 | ~0.1% | 5.3–6.3 GB |
| 4 × 40 MiB, the flushed hot set compiled on first sight | 178 | 259 | ~89 | 3–7% | 2.9–3.6 GB |
| 1 vCPU, 640 MiB (no flush) | 139, 111 | 423 | 0 | ~0% | 3.0–3.5 GB |
| **one shared cache of 160 MiB** | **81, 51, 48, 69, 53** | **755** | **1** | **~0.1%** | **3.2–3.5 GB** |

- **The flushes cost far more than their compiling** (~5% of CPU): after each, hot code runs in
  the interpreter (a few percent of the steps, at a fraction of the speed) and in Liftoff again.
  The steps-per-second check of the earlier memory work missed it; a build timed by the guest
  doesn't.
- **The duplication:** the whole load (boot and builds) compiled 227 MiB of wasm on one vCPU,
  ~650 MiB on four private caches.
- **Eviction can't fix a cache 5× too small:** compiling a block that was compiled before the
  flush on its first sight after it (not after 50 dispatches) filled the cache faster: more
  flushes, slower builds.
- **V8 shares the code** of identical bytes compiled in another worker (its process-wide
  native-module cache): `results/m8-share/chromium-test.ts`, a 5 MB module of 3000 functions,
  first calls of all of them 22.8 ms in the first worker, 3.6 ms in the next two; a module that
  differs by a custom section, 25.7 ms. Node 26 the same (26 vs 1.6 ms).

**The benchmarks**, before and after alternated twice in one session, pooled medians [quartiles],
`results/m8-share/ab/`:

| | before | shared | |
|---|---|---|---|
| `alpine_user_jit` total (n6) | 18,933 [18,864–19,083] | 19,156 [19,073–19,175] | +1.2% |
| `boot_alpine_jit` total (n10) | 9447 [9385–9485] | 9618 [9557–9719] | +1.8% |
| Buildroot `boot_jit` total (n20) | 731 [725–734] | 769 [763–793] | +5.1% |
| `smp_user_jit_4` total (4 parallel vCPUs, n4) | 26,839 [26,723–26,961] | 21,878 [21,765–21,929] | −18.5% |
| its churn, compress | 4379, 2356 | 2666, 2213 | −39%, −6.1% |
| its Lua, SQLite | 3308, 2797 | 3436, 2932 | +3.9%, +4.8% |

- On 4 vCPUs the userspace run compiled 36K regions (39 MB, 0.6 s) where four caches compiled
  91K (104 MB, 2.0 s): the churn phase, kernel and new processes, is where that shows.
- One vCPU pays 1–2%: the jump cache and hot words reached through the vCPU (one more load), and
  each module's bytes copied for the catch-up outside the lock. A first build that installed
  under the lock measured +1.0% and −1.5% for the two Alpine runs (−16% on 4 vCPUs, Lua and SQLite
  +6.5%), the same session layout; Buildroot's half-second boot pays 5%, a check rather than a
  target.
- **Not explained yet:** the single-threaded phases on 4 vCPUs, 4–5% slower (docs/backlog.md
  "JIT").
- **Installs outside the lock:** a worker stalled inside `jit_install` while holding the cache's
  lock kept the other vCPU from reaching its DSB (`tests/hoststall.test.ts`, in CI); a table now
  copies what it lacks under the lock and installs it after.
- **A bug the sharing exposed:** quieting a region member's hot word (`&= REDIRECT`) turned a
  word that already redirected into `REDIRECT | 0`, a call of table slot 0 (a core function:
  "function signature mismatch"). With one cache a tiered-up member's word was never quieted;
  another table replays the enclosing tier-up after its own member tiered up. `maint.bin` in
  parallel found it about one run in five; a dump of each table's references at the trap named it.

## M8: the core's share of the userspace profile; scalar saturating add and subtract inline

2026-10-08, the dev VM, Node 26 (`perf` over `bench/boot/userprof.ts`, `userprof-perf.ts`) and
Chromium 153.0.8010.52; commit `7bafed9` against it plus scalar `SQADD`/`UQADD`/`SQSUB`/`UQSUB`
inline.

**The core's own code** (the dispatcher, the compiler, helper bodies, the allocator, the run loop,
page walks) is 19% of the main thread's samples over the whole run, 8 to 19% in the hot phases
(Lua 8.5%, SQLite 14.6%, compress 19.3%) and 27% in the boot. Exact memory
limits for the core (docs/backlog.md "JIT", item 5) would remove only this VM's explicit bounds
checks from that share: a few percent of a phase at most, nothing on macOS or x86_64. Not worth
an allocator of our own now.

| % of each phase's main-thread samples | boot | compress | Lua | churn | SQLite | all |
|---|---|---|---|---|---|---|
| guest code (TurboFan + Liftoff) | 55.5 | 74.3 | 88.2 | 81.9 | 79.1 | 70.1 |
| core: interpreter and helper bodies | 13.2 | 9.0 | 2.8 | 3.2 | 6.9 | 8.7 |
| core: allocator, std | 4.3 | 2.4 | 1.5 | 0.9 | 2.0 | 2.9 |
| core: compiling | 4.2 | 0.9 | 0.6 | 0.6 | 1.1 | 2.3 |
| core: dispatcher | 3.2 | 1.7 | 1.4 | 1.2 | 1.8 | 2.2 |
| core: run loop, helpers' entry, TLB walks, other | 2.2 | 5.3 | 2.2 | 3.7 | 2.8 | 2.9 |
| V8 native and builtins | 17.3 | 6.2 | 3.2 | 8.7 | 6.2 | 10.9 |

**What compress's helper share was:** 1.97M calls of the scalar `UQSUB` (`UQSUB_1`), ~9% of the
phase in `interp::exec`, `simd_int::same` and `jit_exec_mmu`. The vector forms were made inline in
`7bafed9`, the scalar ones still left `three_same` for the helper. They are inline now (all
element sizes, in i64 arithmetic: elements under 64 bits clamped, 64-bit ones by their overflow;
FPSR.QC as in the vector forms; a new differential-test class, three planted bugs caught).

| | before | scalar inline | |
|---|---|---|---|
| Node `userprof.ts` compress (A, B, A, B) | 2.31, 2.31 s | 2.09, 2.09 s | −9.5% |
| Chromium `alpine_user_jit` compress (n12 pooled) | 2371 [IQR 118] | 2395 [174] | +1.0% |
| its Lua, SQLite | 3488, 2839 | 3580, 2914 | +2.6%, +2.6% |
| its total | 22,041 [1408] | 22,706 [764] | +3.0% |

- Chromium sees **no gain**: the per-run medians alternate (compress A 2364, 2323, 2494, 2377; B
  2241, 2463, 2456, 2379), so the spread is the session's, not the build's. The Mac host was busy
  with the user's own apps (load ~3.5), and every total is ~3 s above the same benchmark's 19 s
  three days ago; B's +3% is in phases with no `UQSUB` at all (churn +14%). Both builds were loaded
  as intended (B: 2 more inline sites, 2 fewer helper sites, the same guest steps).
- **Unexplained:** why a helper that costs Node 0.2 s in this phase costs Chromium nothing
  measurable. Node profiles have led Chromium here before; a Node-only gain is not a gain.
- Kept anyway: no guest-visible change, no cost measured, one fewer helper on a path a common
  guest library takes. `results/m8-sat-scalar/`.

## M8: fewer, larger modules (V8's per-module cost; the batch emitted by interpreted steps)

2026-10-08, the dev VM, Chromium 153.0.8010.52 and Node 26 (V8 14.6); against `37a123e`.
`bench/mem/modules.ts` (synthetic modules, a capture of every JIT module of a run, its replay in
Chromium), `bench/mem/memsample.ts` (the page). Results in `results/m8-batch/`.

**What a module costs V8 besides its functions: ~16 KB** in Chromium (~10 KB in Node). The same
30,720 synthetic functions (~600 wasm bytes each, called once) in modules of K, each module
importing 5 functions of earlier ones as ours import `t`; renderer RSS per function:

| functions per module | 1 | 4 | 16 | 64 | 512 |
|---|---|---|---|---|---|
| total (B) | 24,717 | 11,595 | 9,202 | 8,578 | 8,563 |
| PartitionAlloc | 10,814 | 4,411 | 2,981 | 2,563 | 2,331 |
| `[anon:v8]` (code space: the module's jump tables, its code) | 10,149 | 3,964 | 3,179 | 2,582 | 2,468 |
| `[anon:v8-sandbox]` (V8's heap: instances, exports) | 3,185 | 2,719 | 2,569 | 2,889 | 3,304 |

So ~8 KB of C++ metadata and ~8 KB of code-space pages per module, and the JS objects per function.
In Node 15 more imports added ~1.8 KB (~0.1 KB each). Identical bytes cost nothing twice (V8's
native-module cache): a first synthetic set of only 64 distinct modules measured 1.2 KB per module.

**Where the small modules came from:** a batch was emitted at 512 blocks or 1M steps after its
first entry. Alpine's userspace benchmark made 3,860 modules for 30,394 functions: 1,947 with one
function (684 tier-ups, the rest batches that timed out alone), median 1.4 KB of wasm. A longer
timeout made fewer modules by keeping hot blocks in the interpreter (Node, `userprof.ts`, two runs
each):

| | modules | interpreted steps | total | boot |
|---|---|---|---|---|
| 1M steps (before) | 3,859 | 60M | 16.4–16.9 s | 6.65–6.97 s |
| 4M | 2,228 | 120M | 17.55 s | 7.43 s |
| 16M | 1,259 | 258M | 20.4 s | 8.6 s |
| a tier-up takes the pending batch along | 3,641 | 58M | 16.7–16.9 s | 6.9 s |

**Emit when the waiting costs:** each dispatch of a queued block adds its length to the batch's
interpreted steps; at `BATCH_STEPS` the batch is emitted, and `BATCH_TIMEOUT` only bounds a
lukewarm batch. Blocks that run are compiled sooner than before, the rest wait for company
(with a tier-up taking the pending batch along unless noted):

| steps, timeout | modules | interpreted | total | boot |
|---|---|---|---|---|
| 2K, 16M | 2,073 | 28M | 16.2–16.4 s | 6.4–6.5 s |
| 10K, 4M | 2,372 | 31M | 15.9–16.0 s | 6.2–6.3 s |
| 10K, 16M | 1,517 | 31M | 15.8–16.0 s | 6.2–6.3 s |
| 50K, 16M | 1,268 | 39M | 15.6–16.0 s | 6.2–6.35 s |
| 50K, 16M, tier-ups alone | 1,443 | 41M | 15.6 s | 6.2 s |
| **50K, 64M (kept)** | **970** | 39M | 15.5–15.8 s | 6.2–6.4 s |
| 200K, 16M | 1,180 | 52M | 16.2–16.3 s | 6.5–6.6 s |
| 200K, 64M | 870 | 54M | 16.0 s | 6.4–6.5 s |

**Chromium** (`bench/run.ts`, four alternating rounds; median [IQR], ms):

| | before | 50K, 64M | |
|---|---|---|---|
| `alpine_user_jit_total` (n12) | 19,138 [385] | 18,329 [449] | −4.2% |
| compress, Lua, churn, SQLite | 2172, 3295, 1865, 2673 | 2104, 3280, 1813, 2575 | −3.1, −0.4, −2.8, −3.7% |
| `alpine_jit_total` (Alpine's boot, n20) | 9,543 [187] | 8,592 [64] | −10.0% |
| `boot_jit_total` (Buildroot, n40) | 762.5 [8.5] | 666.8 [8.1] | −12.5% |

The core's own compile time in the userspace run fell 363 → 201 ms (fewer, larger modules).
The Mac host wasn't measured.

**Memory:**
- Alpine's userspace modules installed in Chromium without running (`modules.ts replay`, the same
  34 MB of wasm, two runs each, within 1 MB): 3,860 modules +160 MB (PartitionAlloc 81, code space
  22, V8 heap 43), 971 modules +126 MB (63, 8–10, 40). −34 MB, ~11.7 KB per module.
- The benchmark's peak renderer RSS (shared guest RAM excluded), two runs each: 1,111 and 1,116 MB
  → 1,083 and 1,081 MB.
- **Debian on the page, 4 vCPUs, under `memsample.ts`'s mixed load** (many distinct binaries run
  briefly: many small batches), two runs each, renderer RSS: at login 2,141, 2,140 → 2,125, 2,100
  MB (login at 46 → 42 s); the median under load 3,478, 3,439 → 3,242, 3,250 MB (−6%); the last
  five samples' median (160–250 s) 3,621, 3,489 → 3,290, 3,282 MB, the wasm-code mapping ~670 →
  ~600 MB of it. `results/m8-batch/debian-memsample.json` (per sample, by class).
- Not measured: the Go load at the 160 MiB budget (its batches are larger; the byte budget
  bounds what the modules' code costs, so fewer modules make the budget's tab smaller).
- `memsample.ts` stopped at Debian's first-boot questions since the page stopped passing
  credentials itself: it passes the tests' (`tests/debian-unattended.ts`) now.

## M8: what a region entered at more than one block could win (measured, not built)

2026-10-08, the dev VM, Node 26, `userprof.ts` with a diagnostic core (`results/m8-entries/`:
`member-entries.patch` against `e53f8f3`, the run's marks, `summarize.mjs`). The backlog's last
untried idea for transfers that leave a function: a region whose function takes an entry index
(a `br_table` on it), so a block that is a member of a compiled region is entered there instead of
waiting in the interpreter until it is compiled again as a head.

What that could save is what today's policy spends on such blocks: the steps they run interpreted
before their threshold, the dispatcher's misses on them, and the second copy. The diagnostic core
files every compiled region's members and counts those at the dispatcher:

| phase | steps | interpreted at members (share of steps) | misses at members (of all dispatches) | regions headed by a block that was a member |
|---|---|---|---|---|
| boot | 2,364M | 3.87M (0.16%) | 652K (22%) | 2,848 of 23,151 |
| compress | 2,118M | 0.75M (0.04%) | 123K (16%) | 388 of 1,678 |
| Lua | 3,206M | 0.28M (0.01%) | 60K (6%) | 304 of 1,754 |
| churn | 547M | 0.10M (0.02%) | 19K (3%) | 138 of 449 |
| SQLite | 2,142M | 0.73M (0.03%) | 130K (15%) | 611 of 2,005 |

At the dispatcher's cost (~11 ns at a jump-cache hit, a miss plus the interpreted block a few
hundred) that is about 1% of compress and SQLite and less of the rest, an upper bound: a member
entered from outside would still leave the caller's function (a tail call into the region's), as
it does now into its own region once compiled. The transfers that leave a function in the hot
phases (27 to 37 per 1000 instructions into blocks that head another function) target heads, which
multi-entry doesn't change. Its cost would be an entry parameter on every JIT function and every
call, an entry index in the jump cache and transfer cache entries, and a dispatch at the top of
each loop region's loop. Not built. The second copies are ~15–30% of each phase's regions; their
memory is what larger modules already cut.

## M8: the shared cache's single-threaded phases, rechecked

2026-10-08, the dev VM, Chromium 153, against `3e5d184`; `results/m8-share-recheck/` (A: the
shared cache, B: a build that gives each parallel vCPU a cache of its own, 160 MiB each;
alternated A, B three times, two rounds each). "M8: one code cache for all vCPUs" had Lua and
SQLite 4–5% slower with the shared cache; since the step-weighted batches ("M8: fewer, larger
modules") every phase is faster with it (median [IQR], ms, n6):

| | shared | private | |
|---|---|---|---|
| compress | 1,992 [48] | 2,389 [43] | −16.6% |
| Lua | 3,327 [60] | 3,597 [108] | −7.5% |
| churn | 2,641 [44] | 4,668 [156] | −43.4% |
| SQLite | 2,806 [74] | 3,115 [172] | −9.9% |
| total | 20,694 [127] | 27,750 [203] | −25.4% |

Node agrees (three pairs; per vCPU, private caches interpret about twice the steps and compile
every region four times). Separately, four concurrent copies of the benchmark slow down by
themselves on this host: four independent 1-vCPU VMs at once ran Lua 3–6%, SQLite 11–15% and
compress 22% slower than one alone (Node, one run each), about what 4 vCPUs cost against 1.

## M8: llvmpipe, profiled; its NEON inline

2026-10-08, the dev VM, Chromium 153.0.8010.52; `results/m8-llvmpipe/` (A: `16883ec`, B: `d659d18`,
the commit that inlines what follows). The backlog's question: why sway compositing on Mesa's
llvmpipe kept four vCPUs at ~54% for ~3 frames a second ([docs/graphics.md](../../docs/graphics.md) "Guests that composite with llvmpipe").
The workload is `gl_llvmpipe_jit` (`images/alpine/gl`, docs/benchmarking.md): a compositor's
frame (a 64-row texture upload, 3 blended quads over 1376×762, a read-back) without a display.

**Where the time went** (Node, `perf` with `--perf-prof`, `bench/boot/userprof-perf.ts`'s
categories, 1 vCPU, `LP_NUM_THREADS=0`): in the rasterizing phase only ~5% of the samples were
in compiled guest code; the interpreter's helper bodies were ~50% (`simd_int::permute` and the
`__ashlti3`/`__lshrti3` 128-bit shifts it calls: 37% between them), "core/JS other" 25%, the helpers'
entry 7%. 13% of the instructions were helper calls (per 10 frames: ZIP1 149M, LD1 of a lane 90M,
ZIP2 88M, FCVTL 67M, CMLT #0 38M, FMLA by element 31M, FCMGE and FCMLE #0 30M each, UZP1 30M,
FCVTN 30M, FRINTI 15M, FADD 8M). A diagnostic core that recorded each helper call's encoding and
its operand lanes' classes (`helper-classes.patch`, not for commit to the core) showed why the FP ones weren't inline: FCVTL/FCVTN were
half precision (only single ↔ double was inline), and FMLA and FADD had zero lanes, which the
fast paths rejected as not normal.

**Built** (docs/jit.md): UZP/TRN/ZIP as one shuffle, the integer compares against zero, LD1/ST1
of one lane, the vector FP compares, FRINTN/M/P/Z/I/X, FCVTL/FCVTN from and to half precision,
and zero operands on the vector FP fast paths where the zero case is exact. Node, the rasterizing
phase of 10 frames: 69.7 s → 31.1 s (the permutes and zero compares) → 9.9 s (LD1, compares,
FRINT, half precision) → 4.2 s (zero operands), the same 4,837M steps and pixel hash; 69 → 1,147
MIPS, helper calls 626M → ~5M. Chromium (median (min–max), n3 each):

| | A | B | |
|---|---|---|---|
| `gl_llvmpipe_jit`, ms a frame (1 vCPU, rasterizing on the calling thread) | 6,936 (6,835–6,994) | 445 (444–519) | 15.6× |
| warm (shaders compiled, 3 frames), ms | 24,984 (24,928–25,195) | 5,340 (5,337–5,938) | 4.7× |
| `gl_llvmpipe_jit_4`, ms a frame (4 vCPUs, 4 rasterizer threads) | 1,859 (1,849–1,894) | 100 (100–101) | 18.6× |
| warm, ms | 9,609 (9,471–9,728) | 4,408 (4,402–4,447) | 2.2× |

Natively on the dev VM (the same binary in Alpine's container) a frame takes 26.6 ms on one
thread and 7.4 ms on four: the JIT is now ~17× and ~14× slower there, about the gap it has on
scalar code; the 4-vCPU case scales 4.4× over the 1-vCPU one, so the rasterizer threads' wake-ups
aren't a cost worth chasing yet. What's left is the inline code itself (vector registers in memory
between instructions: the backlog). `alpine_user_jit` (alternated A, B twice, n6): every phase
within 3% (compress −1.3%, Lua −0.6%, churn −2.8%, SQLite −1.3%), noise.

## M8: vector registers in locals

2026-10-08, the dev VM, Chromium 153.0.8010.52; `results/m8-vlocals/` (A: `9d7f8d6`, B: the commit
that keeps the V registers in v128 locals; `r1-`, `r2-`, `r3-` are the rounds, alternated A, B,
`liftoff-` the `--config liftoff-only` runs).

**The profile first** (Node, `perf` with `--perf-prof`, 1 vCPU, `gl_llvmpipe_jit`'s guest as in
"M8: llvmpipe"): with llvmpipe's NEON inline, compiled guest code (TurboFan) was 79% of the
rasterizing phase's samples, the helper bodies 10%; one shader function half of the phase. Its
code was the store-to-load round trip the backlog named: per NEON instruction `ldr q, [x6, #V+16n]`
for each operand, the operation, `str q` back, many of the stores behind an explicit bounds check
(`sub`, `cmp`, `b.cs`: the VM's Chromium has them, docs/benchmarking.md).

**Built** (docs/jit.md "Registers in locals"): the V registers in v128 locals under the integer
registers' rules, in the same masks (bits 32–63), so write-back before helpers and returns,
dropping after helpers, region edges and plain once-read registers apply as they are; the fast
paths' fallbacks drop their V destinations. Node, the rasterizing phase of 10 frames: 4.25 →
3.13 s, the same 4,837M steps and pixel hash. After it the hot shader's samples are ~2% V loads and
stores; the rest is the vector FP fast paths' lane checks (`all_true`: `uminv`, a move to a
general register, a compare; ~18% of its samples land on the move) and the TLB's tag load for its
guest accesses (~11%): the backlog.

Chromium (each value the median of a run's samples; medians over runs, the runs in parentheses):

| | A | B | |
|---|---|---|---|
| `gl_llvmpipe_jit`, ms a frame | 440 (440, 440) | 323 (327, 320) | −26.5% |
| warm, ms | 5,300 | 4,977 | −6.1% |
| `gl_llvmpipe_jit_4`, ms a frame | 98.2 (98, 98) | 70.9 (71, 71) | −27.8% |
| `alpine_crypto_jit` AES-128-CBC, 16 KiB, MB/s | 41.2 (41, 42) | 179.5 (180, 179) | 4.4× |
| AES-128-GCM, 16 KiB | 57.1 | 113.7 | 2.0× |
| AES-256-GCM, 16 KiB | 46.4 | 105.5 | 2.3× |
| SHA-256, 16 KiB | 96.1 | 312.7 | 3.3× |
| SHA-1, 16 KiB | 533.8 | 538.5 | +0.9% |
| `alpine_user_jit` total, ms | 17,766 (17,869, 17,663) | 17,703 (17,711, 17,696) | −0.4% |
| `boot_alpine_jit` total, ms | 8,419 (5 runs: 8,381–8,474) | 8,447 (8,412–8,594) | +0.3% |
| `boot_jit` total, ms | 668 | 670 | +0.2% |
| `jit_coremark_mips` | 2,388 | 2,393 | +0.2% |
| `jit_mips` | 5,369 | 5,330 | −0.7% |
| `vm_jit_mmu_mips` | 4,171 | 4,115 | −1.3% |
| Liftoff only: `boot_alpine_jit` total, ms | 12,550 | 12,613 | +0.5% |
| Liftoff only: `boot_jit` total, ms | 962 | 961 | −0.1% |
| Liftoff only: `jit_mips` | 2,367 | 2,362 | −0.2% |

The crypto rows are `openssl speed` with the crypto extensions off (`OPENSSL_armcap=0x81`), i.e.
the NEON paths: AES-CBC and SHA-256's schedule were latency-bound on the V registers' memory round
trips (`bench/interp/REPORT.md` M6.5), SHA-1's scalar rounds weren't. Everything else is within
noise, Liftoff included: its extra v128 locals (declared only where used) cost nothing measurable.
Each userspace phase moved under 0.3%.

## M8: the block interpreter, and threshold 500

2026-10-09, the dev VM, Chromium 153.0.8010.52; `results/m8-dec/` (`r1-`, `r2-`: two rounds,
alternated; `old50`: the block interpreter compiled out, threshold 50, the old path; `dec50`,
`dec500`: the block interpreter at threshold 50 and 500). Medians of each run, both runs shown:

| ms | old50 | dec50 | dec500 |
|---|---|---|---|
| `boot_alpine_jit` total | 8,944, 8,922 | 8,438, 8,855 (−3.2%) | 8,230, 8,042 (−8.9%) |
| `alpine_user_jit` total | 18,462, 18,774 | 17,859, 17,831 (−4.2%) | 18,088, 18,132 (−2.7%) |
| compress | 2,125, 2,126 | 2,053, 2,043 | 2,195, 2,175 |
| lua | 3,309, 3,303 | 3,210, 3,211 | 3,347, 3,362 |
| churn | 1,838, 1,875 | 1,893, 1,859 | 1,992, 1,985 |
| sqlite | 2,570, 2,611 | 2,505, 2,521 | 2,638, 2,653 |

- At 500 the hot phases wait longer to be compiled (1.5–6% slower than old50); the boot and the
  rest of the run gain more. Chromium in Debian gains far more at 500 (`../apps/REPORT.md`), so 500 is
  the default; a threshold that follows the code cache's pressure is the next try (backlog).
- **A first version lost:** with dispatches reported 16 at a time, blocks joined the pending batch
  at scattered dispatches, and forward regions (which take only their batch's blocks) came out 30%
  more and smaller (Alpine's boot: 33,466 regions of 53,376 blocks against 25,922 of 56,234): the
  boot 7.8% and the userspace benchmark 6% slower than old50. The dispatch that reaches the
  threshold now reports itself (`jit::Cache::miss` returns the slot's quota). Those runs are the
  `nobatchquota-` files (round 2 cut short).
- This session ran ~6% slower than the previous one (`boot_alpine_jit` 8,419 ms in "M8: vector
  registers in locals" for the same old path): compare within the table.

## M8: a compile threshold that follows the code cache's pressure

2026-10-09, the dev VM, Chromium 153.0.8010.52; `results/m8-pressure/` (`r1-` to `r3-`: rounds,
alternated). The threshold starts at 50 and doubles at each eighth of the 160 MiB budget the live
modules fill past the second (so 50 up to 40 MiB, 1000 from 120 MiB), and its floor doubles at each
flush (docs/jit.md "Compile policy"). `press` is that policy; `press100`/`press200` the same from 100
and 200; `fix50`/`fix500` fixed thresholds (`fix500`: the previous default). Medians of each run:

| ms | fix500 | press | press200 | fix50 |
|---|---|---|---|---|
| `boot_alpine_jit` total | 7,974, 7,915, 8,001 | 8,764, 8,496 (+7%) | 8,035, 8,336 | 8,524, 8,520 |
| `alpine_user_jit` total | 17,884, 18,133, 17,991 | 17,726, 17,776, 17,916 (−1.2%) | 17,651, 17,718 | 18,063 |
| compress | 2,171, 2,191, 2,186 | 2,055, 2,044, 2,047 (−6%) | 2,117, 2,109 | 2,077 |
| lua | 3,324, 3,353, 3,313 | 3,213, 3,212, 3,207 (−3.3%) | 3,242, 3,275 | 3,264 |
| churn | 1,947, 1,995, 1,969 | 1,850, 1,861, 1,873 (−5.5%) | 1,892, 1,922 | 1,878 |
| sqlite | 2,629, 2,656, 2,646 | 2,531, 2,502, 2,517 (−5%) | 2,566, 2,564 | 2,514 |

- Alpine compiles ~30 MiB, under the knee, so `press` compiles exactly what `fix50` does (the same
  26,664 regions, 29.8 MB): the hot phases are back at 50's speed, and the boot pays what it paid at
  50. **The boot wants a high threshold without any pressure:** at 500 it compiles half the bytes
  (14.9 MB); its code runs between 50 and 500 times and not again, so compiling it doesn't pay V8's
  compile back. The Debian boot to login on the page (4 vCPUs) didn't move: 40.1–41.6 s for every
  core (`../apps/REPORT.md`).
- Floors 100 and 200 trade the hot phases for the boot (`press200`: the boot within noise of 500,
  the phases between); Chromium in Debian lost most of its gain at 200 (`../apps/REPORT.md`), so the
  floor is 50.
- **Two tries at the boot's lukewarm code lost** (one round, `r3-`): counts halved every 2^18 or
  2^20 interpreted dispatches (a block needs its 50 within a window): the boot 8,681 and 8,609 ms,
  no better than without; the threshold ×10 for EL1 blocks: the boot 8,144 ms, still behind 500, and
  churn (kernel code) 1,991 ms, as slow as at 500.
- Run-to-run spread this session: ~4% on the boot (`press200` 8,035 and 8,336), ~1% on the
  userspace total.

## 2026-10-14: the Alpine images rebuilt from the 3.24.2 release media

Not a measurement: a break in the series. The `alpine` image was lost, and its `linux-virt` 6.18.53
was gone from Alpine's repository, so `images/build.sh alpine` now takes the release's own kernel
(6.18.52), initramfs and modules from the pinned virt ISO (docs/images.md). The boot is 2,821,209,020
steps (was 2,856,663,287) and the userspace benchmark 10,785,493,578 (was 10,755,927,881); `alpine-gl`
and `alpine-virgl` were rebuilt on the new root. Compare `boot_alpine*`, `alpine_user_jit`,
`alpine_crypto*` and `gl_*` only with runs from after this date.

## M8: a TLB translation memo in wasm locals (rejected)

2026-10-14, the dev VM, Chromium 153.0.8010.52; `results/m8-memo/` (A: `8400910`; B, B2, B3 the
variants below, `memo-b3.patch` the last; `r`, `s`, `t` the three sessions, A and the variant
alternated twice in each; every run 2 samples, IQRs within 1.1%).

The backlog's idea: an access keeps the last TLB entry it hit in two i64 locals, and a later
access in that page takes the addend from them, skipping the TLB's index, load and compare. The
idea's safety argument holds: a TLBI or a regime MSR ends the function, since `block::next`
gives those no successor (`End::After` alone would only end the block). Its check didn't: `(va ^ page)
< 0x1000` lets a page-crossing access through, and zeroed locals match page 0. The memo needs
`(va | 0xfff) == tag` plus a page-offset compare for accesses longer than a byte. Built with
bare-metal tests (a crossing load after a load of its first page, a store to a read-only page and an
LDTR of an EL1-only page after loads of them, all in one block); JIT-stress caught each rule planted out.

Hit rates from an instrumented core in Node: one memo per kind (reads, writes) a function
hit 42% (compress) to 62% (churn) of its checks, since code interleaves pages (stack, heap,
globals); one per base register and kind, 74% (compress) to 87% (Lua, churn).

`alpine_user_jit`, ms (the medians of each run):

| | A | variant | |
|---|---|---|---|
| B, one memo per kind: total | 17,173, 17,367 | 19,555, 19,429 | +12.9% |
| compress / Lua / churn / SQLite | | | +18.3 / +6.6 / +17.0 / +11.4% |
| B2, per base register: total | 17,287, 17,405 | 18,474, 18,139 | +5.5% |
| compress / Lua / churn / SQLite | | | +6.5 / −0.2 / +7.0 / +3.5% |
| B3, B2 in loop regions only: total | 17,305, 17,556 | 17,775, 17,831 | +2.1% |
| compress / Lua / churn / SQLite | | | +5.8 / +0.7 / +2.0 / +0.7% |

`gl_llvmpipe_jit` (B3, the shader workload whose profile showed ~11% on the tag load): 309.3,
309.5 → 314.4, 315.9 ms a frame (+1.9%, IQRs ≤ 2.2 ms); warm 4,482, 4,452 → 4,555, 4,543 ms
(+1.8%). The JIT's wasm: +11.7% (B), +8.7% (B2), +0.8% (B3) on the userspace run.

B3's small code growth rules out code size as the whole cost: where the memo applies, a hit is
no cheaper than TurboFan's TLB hit, and misses and the locals carried around loops cost more.
Rejected; docs/jit.md "Tried and not kept".

## M8: the firmware on the screen (2026-10-14)

`images/edk2/virtio-gpu-console.patch` makes the virtio-gpu's GOP a console, so the firmware's logo, its boot
timeout's progress bar and its text show on the page's screen (docs/firmware.md "Our patches").
Measured with `bench/boot/firmware-ab.ts` (new): the page's Debian, 2 vCPUs, seconds from the page's load to
BdsDxe loading the boot option, the EFI stub, and the first boot's question; a and b alternate; Chromium
153.0.8010.52 headless, the dev VM (linux-arm64, 8 vCPUs), Node 26.7.0.

| firmware (a = before, images/SHA256SUMS 1bf82eac) | boot option | EFI stub | first boot's question |
|---|---|---|---|
| a, 4 runs | 3.73 | 13.38 | 40.6 |
| the console patch alone, 4 runs | 7.03 | 16.78 | 44.0 |
| a, `?gpu=nopace`, 2 runs | 3.84 | 13.45 | 41.4 |
| the console patch alone, `?gpu=nopace`, 2 runs | 3.84 | 13.38 | 40.6 |
| a, 4 runs (second session) | 3.76 | 13.39 | 40.7 |
| **both patches**, 4 runs | **3.85** | **13.49** | **41.0** |

Medians. The console patch alone cost 3.4 s, all of it the page's flush pacing: the progress bar drew 199 `Blt`s
of one block each (the boot manager redraws from block 0 every second), each a transfer and a flush that EDK2's
driver waits for, answered one a frame. `boot-logo-progress.patch` draws the new blocks in one `Blt` (3 flushes
for the bar); what is left, ~0.1 s, is inside the runs' spread. JSON: `results/m8-fw-screen/` (`connect-only.json`
from the tool's first, ad-hoc version, copied from its output; `firmware-ab.json` from the committed tool).

**The menus (same day).** The firmware's menus crawled under the pacing: the form browser draws a character or
a run per `Blt`, and each `Blt` was a transfer and a flush waited for. `images/edk2/virtio-gpu-deferred-flush.patch`
transfers at once and flushes a frame later, the union of what was written. Seconds from the key to the step's
last flush (one run each; ad-hoc tool with a debug log, `results/m8-fw-screen/menus.json`):

| step | flush per `Blt`, paced | flush per `Blt`, `?gpu=nopace` | deferred flush, paced |
|---|---|---|---|
| Enter into the setup screen | 2.39 (141 flushes) | 0.18 | **0.18** (6 flushes) |
| an arrow key | 0.70–0.77 (35–38) | 0.04–0.05 | **0.04–0.18** (1; the slower ones wait 0.15 s for their first transfer: the key's way in, not the drawing) |
| Enter into a submenu | 2.33 (130) | 0.25 | **0.26** (3) |

The boot, against both earlier patches (`firmware-ab.ts`, 4 rounds alternating, `deferred-flush-ab.json`):
3.69 against 3.85 s to the boot option, 13.37 against 13.47 s to the EFI stub, 40.3 against 40.8 s to the first
boot's question.

## M9: FEAT_RNG and FEAT_E0PD (2026-10-14)

FEAT_RNG (`RNDR`, `RNDRRS`) from the backlog, and FEAT_E0PD, which its "measure KASLR" turned up (docs/cpu.md).

**What the guests did with RNDR.** Alpine's boot test under the JIT in Node (deterministic, one run each; the
deterministic stream repeats, two runs with it gave the same PCs): `random: crng init done` at 0.000000 s against
16.73 s without it (the crng waited for `virtio_rng`), 2.652G steps against 2.821G (−6%), no KASLR on this direct
boot (the kernel's PCs at the same addresses). Debian on the page (UEFI) had **KASLR and its crng at 0 s already
without RNDR**: EDK2's `EFI_RNG_PROTOCOL` comes from the virtio-rng (`efi: … RNG=` in the log), and the EFI stub
randomizes with it. Its dmesg said `kernel page table isolation forced ON by KASLR`: Linux's
`kaslr_requires_kpti()` turns KPTI on under KASLR unless `ID_AA64MMFR2_EL1.E0PD` says the CPU has E0PD,
whatever CSV3 says. Under KPTI each kernel entry and exit switches ASID, our TLB drops the nG entries at each
switch, and the kernel's own mappings are nG. The Debian boot to its first question with RNDR against without
(`rng=1` against `rng=0`, 3 rounds, an ad-hoc version of `firmware-ab.ts`): 40.89 against 40.34 s, noise.

**What KPTI costs.** Alpine's userspace benchmark under the JIT in Node, `kpti=1` on the command line against
none (two runs each, ad hoc; ms): compress 2715/2717 against 1993/1952, lua 3645/3553 against 2965/2980, churn
1892/1877 against 1244/1254, sqlite 2992/2955 against 2250/2291, total 20.3/20.2 s against 15.3/15.2 s:
**+32%**, the steps the same (10.794G against 10.794G).

**E0PD on the page** (`bench/boot/page-ab.ts`, new: two page queries alternating, Debian unattended with the
tests' credentials, 2 vCPUs; seconds from the page's load to BdsDxe's boot option, the EFI stub and the login
prompt, then as root ms for 300 fork+exec of `/bin/true` and `dd` of 300,000 64-byte blocks to `/dev/null`;
`e0pd=0` against `e0pd=1`, RNDR on in both; 5 rounds; Chromium 153.0.8010.52 headless, the dev VM, linux-arm64,
8 vCPUs, Node 26.7.0; `results/m9-cpu-features/e0pd-ab.json`), median (IQR):

| | without E0PD (KPTI on) | with E0PD (KPTI off) | |
|---|---|---|---|
| to BdsDxe | 3.75 s (0.11) | 3.82 s (0.10) | firmware: the same |
| to the EFI stub | 13.40 s (0.13) | 13.37 s (0.07) | |
| to the login prompt | 46.81 s (0.94) | **39.74 s** (0.29) | −15% (the kernel and userspace boot: −21%) |
| 300 fork+exec | 2972 ms (2) | **2086 ms** (76) | −30% |
| `dd`, 300,000 syscall pairs | 3619 ms (43) | **1155 ms** (44) | 3.1× |

Every run without E0PD logged KPTI forced on, none with it. The page's machines have both features now, and
(the same day) `bootVm` and the native runners too, so every benchmark from here on boots with them: Alpine's boot
test in 2.651G steps against 2.821G, its userspace benchmark in 10.613G against 10.785G (`tests/steps.txt`).

## M8: the JIT's compile worker (2026-10-15)

The backlog's "a compile worker: the host's installs stop every vCPU at once" (graphics.md "Video's measurements": with Firefox on the
desktop guest, installs of 20-58 ms for a few KB, up to 739 ms, most on all four vCPUs at once). All on the dev VM
(Lima on the M4 Mac mini, 8 vCPUs), headless Chromium 153.0.8010.52, Node 26.7.0; the Firefox sessions are
`bench/gpu/firefox-load.ts virgl` with `PHASES=pages` (the desktop image, 4 vCPUs, 2.5 GiB; Firefox started on five
saved sites in turn, each loaded and scrolled: ~400 s).

**Not V8 compiling.** A Chromium microbenchmark of `jitHost`'s install path with Alpine's 971 captured JIT modules
(ad hoc, `bench/mem/modules.ts`'s capture): 0.12 ms median, 0.9 max on one worker; four workers installing the same
bytes in lockstep beside four threads spinning in wasm, and 20 rounds of fresh bytes with flushes (~600K functions),
0.3 ms median, the slowest (~30 ms) modules of 100-270 KB. The stalls didn't reproduce in isolation. A trace of the
real session (Chromium's `--trace-startup` with `v8.wasm`, `disabled-by-default-v8.wasm.detailed`, `v8` and
`disabled-by-default-v8.gc`, 485 s, JSON) put each vCPU at ~14,000 `wasm.SyncCompile`s averaging 0.35 ms (~1% of its
time); the slow ones were V8's housekeeping running into them:

| What | Longest | Where |
|---|---|---|
| a major GC's start (`GCIncrementalMarkingStart`, reason "allocation limit") waiting for the last sweep (`GC_HEAP_ENSURE_SWEEPING_COMPLETED`) | 986, 335, 296 ms | a vCPU thread, at whatever allocated: a module object, an instance |
| a GC's second-pass weak callbacks | 488 ms | a vCPU thread |
| a cache hit, then nothing traced | 558 ms | a vCPU thread |
| the wasm code GC (`ReportLiveCodeForGC`, `FreeDeadCode`), 17-38 times a thread | 33-58 ms | every vCPU, between blocks too |
| `NewNativeModule` blocked while that runs, the other vCPUs waiting on its cache entry (`GetNativeModuleFromCache`) | 25-58 ms | the four-at-once installs |

**What the guest's `IC`s cost** (a diagnostic build, the patch not kept: counters over each page's start and load):
`IC`s dropped 95-282 compiled regions a page (and 4-22 linked to them) against 22,094-165,003 compiled; 30-98 of
those still had their words unchanged at the `IC`; 9-57 came back with the same words, 3-22 changed. Regions
compiled on pages that had seen an `IC` before: 2,602-6,342 a page, 1,216-1,906 on pages with four or more. So
keeping unchanged blocks across an `IC` would save well under 1% of the compiling, and a blocklist of pages a JIT
rewrites 1-6%: not built (docs/jit.md "Tried and not kept"). The volume is new code: Firefox's on its first run, all of it again
after each budget flush (the first page and the last flushed once), 22-28K regions on the pages that reused earlier
launches' code. 96-99% of the steps ran in JIT code.

**The compile worker** (docs/jit.md "Sharing"): the emitting vCPU posts each module to one worker of the VM's,
which compiles it (V8's module cache then holds it); a table installs it once the worker says so, interpreting its
blocks until then. Firefox's pages session, the vCPU timeline over all of it (`TIMELINE_ALL=1`; `bench/gpu/stalls.ts`:
runs of 10 ms bins in which a vCPU inside `vm_run_cpu` retired nothing), two sessions each, alternating
(`results/m8-compile-worker/firefox/`):

| | MIPS | stalls ≥ 20 / 50 / 100 / 250 / 500 / 1000 ms | longest | stalled ms a second a vCPU | `waarm64-slow` installs |
|---|---|---|---|---|---|
| worker | 271, 263 | 8/3/3/0/0/0, 13/6/3/0/0/0 | 182, 224 ms | 0.39, 0.70 | 5, 5 |
| none (`?jit=nocw`) | 270, 267 | 12/8/8/8/0/0, 14/5/5/5/2/1 | 489, 1054 ms | 2.0, 1.8 | 8, 14 |

No stall reached 250 ms with the worker; the four-at-once installs (two sets of four of 25-31 ms in one session
without it) are gone, every module installed from the worker, none overdue. What remains is V8's GC on the vCPU
threads (installs whose cache hit or instantiation took 100-230 ms) and stalls with no install in them at all.

**Throughput** (`bench/run.ts --only smp_alpine_jit` and `--only smp_user_jit_4`, with and without `--query=nocw`,
alternating; `results/m8-compile-worker/smp_*.json`), median ms (IQR):

| | worker | none | |
|---|---|---|---|
| Alpine boot, 1 vCPU | 9925 (88) | 9832 (49) | +0.9% |
| 2 vCPUs | 9822 (46) | 9759 (119) | +0.6% |
| 4 vCPUs | 9848 (49) | 9824 (96) | +0.3% |
| userspace on 4: compress | 1869 (54) | 1832 (39) | +2.0% |
| lua | 3161 (53) | 3106 (104) | +1.8% |
| churn | 3012 (143) | 2957 (27) | +1.9% |
| sqlite | 2487 (99) | 2499 (166) | −0.5% |
| total | 20069 (414) | 19766 (188) | +1.5% |

All under the 5% that noise allows, but mostly one way: ~1-2% plausibly the blocks interpreted while their module
waits for the worker. An A/A of the same (both sides with the worker: the bench page's query didn't reach its worker
then; `results/m8-compile-worker/aa/`) moved sqlite 8% and lua 4%. Kept on: the user's latency over a percent of
throughput. `?jit=nocw` (the page) and `--query=nocw` (bench/boot) turn it off.

## M8: the device round trip, MMIO and copies (2026-10-15)

The question (the user's, after the video track): Firefox's video pipeline copies buffers around, to the virtio
devices too; can copies, MMIO or the vCPUs' traffic with the device worker go faster? Dev VM, Chromium
153.0.8010.52 headless, Node 26.7.0, at `b4e19e4aa1a9`; raw: `results/m8-devlat/`.

**How much the video case copies:** Firefox's VA-API path never puts a picture in guest RAM (dmabuf planes the host
writes, graphics.md "Video's design"). What it sends the GPU is ~175-440 KB a second of `SUBMIT_3D` command streams, ~100-280
requests a second (the video track's JSON, docs/graphics.md "Video's measurements", and this session's runs); the host's write into the planes is 0.04 ms a
picture. In the guest's kernel profile `__arch_copy_from_user` is 0.3% and `memset` 0.4%; in the guest's Chromium
(`results/m8-chromium/perf-base-run1.txt`) glibc's `memcpy`, `memmove` and `memset` are under 2% together.

**What a copy and a device access cost** (`devbench.c`, a bare-metal guest with the MMU on, in Node under the JIT;
`runbm.ts`; natively on the dev VM, `native.c`; best of three rounds):

| | JIT | block interpreter (`jit` 4) | native (M4) |
|---|---|---|---|
| loop of a RAM load | 1.5 ns | 26.5 ns | |
| MMIO read (PL011 FR, GICD_CTLR, virtio-mmio MagicValue) | 219-222 ns | 235-263 ns | |
| ICC_RPR_EL1 read / ICC_PMR_EL1 write | 137 / 131 ns | 166 / 159 ns | |
| copy, LDP/STP Q, 64 KiB (glibc's loop shape) | 21.6 GB/s | 0.27 GB/s | 92-104 GB/s (glibc `memcpy` 105-110) |
| copy, LDP/STP X, 64 KiB | 11.5 GB/s | 0.58 GB/s | 83-94 GB/s |
| copy, LDTR/STTR X, 64 KiB (the kernel's usercopy) | 6.8 GB/s | 0.16 GB/s | |
| `DC ZVA`, 64 KiB | 14.1 GB/s | 0.62 GB/s | 149-158 GB/s |
| copy, LDP/STP Q, 8 MiB | 20.3 GB/s | 0.27 GB/s | 63-64 GB/s |

Copies under the JIT are 3-10× native, no worse than code in general. FEAT_MOPS (`CPYP`/`CPYM`/`CPYE` as a host
`memory.copy`) would be the lever if copies were a cost; they aren't, so it stays unadvertised. A device access is
~150 RAM loads (the block leaves for the run loop, which replays the access on the interpreter's `vm::Io` bus), but
there are few: Firefox's 4,700-5,500 IRQs a second and ~100-280 GPU requests at ~2-5 accesses each are 2-6 ms a
second of four vCPUs' time, ~0.1%.

**The device round trip** (`--only net --query='jit=1&…'`; `?jit=1`, `?ncpus=N`, `?chunk=N`, `?stats=1`, `?disk=`,
`?script=` are new to bench/boot's I/O benchmarks: docs/benchmarking.md). Ping's average RTT, medians of 10 boots
(IQR ≤ 0.009 ms); `bench-netload.sh` (on a copy of the disk: its header) warms up, then 5,000 small pings idle and
5,000 with every vCPU busy:

| | stock `net`: small / full-size | warm small, idle | warm small, vCPUs busy |
|---|---|---|---|
| round-robin (one thread) | 0.109 / 0.220 ms | 0.085 ms | 0.138 ms |
| a worker per vCPU (the page's), 1 vCPU | 0.100 / 0.205 ms | 0.075 ms | 0.144 ms |
| the same, chunk 4,096 | | 0.079 ms | 0.132 ms |
| 2 vCPUs | | 0.085 ms | 0.158 ms |

`?stats=1` splits the phases (`*.log`): an idle round trip is ~81 µs of wall time, ~16,900 guest instructions
(~68 µs: the virtio-net driver, the stack, ping) and **~12 µs out of the core** (the doorbell, the device worker's
gateway answering, the vCPU's wake-up). The bare hops (`hop.html`, `hop.ts`: a worker rings, another answers, by how
each waits; Chromium's timers are 5 µs grains): 10 µs a round trip when the ringing side polls first as the vCPUs do
(50 µs), 25-35 µs when it sleeps at once; the same from a nested worker, and with the answering thread busy 1 ms in
every 4. So the host's share is ~15% of an idle round trip, and the device worker's `waitAsync` costs no more than a
blocking wait. (`dd` and fio's disk path is the backend's own time: bench/io/REPORT.md, which also showed loop 5's
draw stalls behind disk reads gone.)

**A busy vCPU takes an interrupt late:** the run loop looks at the signal word and its IRQ line only between chunks
(32,768 steps, ~60 µs at this guest's ~550 MIPS, longer at a browser's 50-100 MIPS per vCPU), so a ping to a busy vCPU
waits ~60 µs more. A 4,096-step chunk takes 8% off that round trip (its throughput not measured: the next try ends
a chunk only when something waits, and gained more). **Tried: ending the chunk at the next dispatch** once the signal word is set,
another vCPU has queued maintenance (a TLBI broadcast its DSB waits for) or an unmasked IRQ is pending (parallel mode
only: `kick/kick.patch`). The busy round trip went 0.144 → 0.119 ms (1 vCPU, −17%) and 0.158 → 0.142 ms (2), idle
unchanged, the userspace benchmark on 4 vCPUs +0.6% (19,789 ms (197) → 19,908 (232), 8 runs each over 4 alternating
rounds, phases −1.2% to +1.3%: noise). But on Firefox playing the Sintel trailer (`bench/audio/avsync.ts virgl`,
`CLIPS=sintel`, 4 vCPUs, alternating; `kick/firefox/`) it gave nothing: frames dropped 267, 270, 426, 250 (base) against
321, 303, 270, 205, 492, drop rates median 0.53 against 0.58, the guest at 256 against 249 M steps a second, fences
completed to the guest in 0.13-0.20 ms either way. **Not kept** (docs/jit.md "Tried and not kept"): the workload it was
for doesn't move, and a browser's vCPUs are seldom busy when their interrupts come (they idle, and wake in ~10-35 µs).

**The block interpreter's generic path** (the backlog's "FP and SIMD loads and stores (memcpy)"; `generic-count.patch`,
Alpine's userspace benchmark through `bench/boot/userprof.ts`, `userprof-generic.json`): 1.13M of the 39.4M
interpreted steps ran generically (2.9%; the interpreted steps are 0.4% of the run's 10.6G): MRS 29%, EXTR 10%,
UMADDL 5%, FP and SIMD loads and stores ~10% together, STTR 3%, LDADD 3%, DMB 3%. They are 7× slower there than an
integer load loop (the table above), but at that share they cost well under 0.1% of a run; the guest's Chromium,
whose cold code is larger (bench/apps/REPORT.md: 2-5% of its steps interpreted), is where to count them again.

**So:** nothing in copies, MMIO or the device worker's round trip is a lever for Firefox's video; what it drops is the
guest's CPU over its media pipeline, as graphics.md "Video's measurements" found.

## M8: V8's GC on the vCPU threads (2026-10-15)

The backlog's "What V8's GC still stops a vCPU for": with the compile worker, Firefox's pages session still had 3-6
vCPU stalls of 100 ms or more a session (up to 224 ms then, 808 ms in this section's baseline). Same setup as "M8: the
JIT's compile worker" (dev VM, Chromium 153.0.8010.52, `bench/gpu/firefox-load.ts virgl` with `PHASES=pages
TIMELINE_ALL=1`, 4 vCPUs, ~400 s); core `eefaad8`.

**Attribution.** Three traced sessions (`--trace-startup` with `v8.wasm`, `v8`, `disabled-by-default-v8.gc`, then
`cppgc` and `disabled-by-default-cppgc`; JSON needs `--trace-startup-format=json`), each stall of 50 ms or more joined
with the trace's events on the vCPU threads (ad hoc scripts; the workers' epoch clocks differ by ~400 ms, so the
join is anchored on one install both sides saw: docs/v8.md "Threads that never return to their event loop"). Every
long stall is work on the vCPU's own thread (each event's thread CPU time within 1-4% of its wall time):

| What | Seen | Where |
|---|---|---|
| a V8 major GC's start (reason "allocation limit") finishing the sweep of **Oilpan**, Blink's C++ heap (`GC_HEAP_ENSURE_SWEEPING_COMPLETED`, "unified heap" > `CppGC.IncrementalSweep` > `CppGC.SweepFinish`) | 73-658 ms, 2-4 a session; three vCPUs within 12 ms once | at whatever allocated: a module object, an instance |
| the same, inside `new WebAssembly.Module` before V8 decodes anything (no child events in the first traces) | 807 ms | |
| the wasm code GC: the isolate that frees the dead code (`FreeDeadCode`, 43-69 ms of CPU) | 50-75 ms on every vCPU at once | the others in `ReportLiveCodeForGC` with no CPU, waiting |

V8's own sweep was always done by then (`GC_MC_COMPLETE_SWEEPING` at the next minor GC, 0.0 ms) and its major GCs
are 2-8 ms. Oilpan's marking took ~1 ms in the whole session, so its live heap is small: the sweep is garbage whose
finalizers run on the owning thread, and `CppGC.SweepInLowPriorityTask` ran once in the session on a vCPU thread:
**a vCPU worker never returns to its event loop**, so the tasks that sweep in 5 ms slices never run and V8's next
major GC does it all. A microbenchmark of the install path in a worker that never yields (`new Module`, instances,
`table.set`, with and without `jitHost.compile`'s transferring `postMessage`; 38,840 installs) sweeps 94 ms of Oilpan
with the post and nothing without it; `performance.now()`, `timeOrigin`, `Atomics.wait` and `notify` add nothing,
and module objects dying in a simulated flush add nothing. The real sessions' Oilpan garbage is larger than the posts
explain (`CppGC.SweepOnAllocation` inside `wasm.SyncCompile` on the vCPU threads); which Blink object it is wasn't
found.

**What a vCPU's V8 heap holds** (Node 26, the same install path over Alpine's 971 captured modules, heap snapshots
at 2 and 6 rounds; at Firefox's ~13,600 instances, 423K functions: 177 MB): ~13.5 KB an instance, of which ~6 KB is
per table entry (`WasmExportedFunctionData` 88 B, `WasmInternalFunction` 48, `WasmFuncRef` 16, `Cell` 16, the
dispatch table's ~26, made for every function in a table whether exported or written by an element segment), ~1.7
KB the exports object (an element segment instead saves ~10% at scale: 177 → 160 MB) and ~2.5 KB the instance and
its import data. Not the cause of the stalls (the major GCs themselves are short), so the active element segment
(the handover's lever 2) wasn't built.

**The fix:** each vCPU worker returns to its event loop at the first exit 100 ms after its last return
(`web/vcpu-worker.ts` `yieldMs`, `VmOptions.vcpuYieldMs`; `?vyield=0` turns it off on the page and in bench/boot):
idle sleeps wait in `Atomics.waitAsync`, BUDGET and DEVICE exits on a word nothing writes for a µs. Firefox's pages
session, two each, alternating (`results/m8-vcpu-yield/firefox/`, `stalls.json`):

| | MIPS | vCPU stalls ≥ 20 / 50 / 100 / 250 / 500 ms | longest | stalled ms a second a vCPU |
|---|---|---|---|---|
| never (`vyield=0`) | 260, 262 | 8/3/3/1/1, 17/8/6/2/1 | 808, 526 ms | 0.89, 1.1 |
| every 100 ms | 265, 271 | 9/2/0/0/0, 10/1/0/0/0 | 54, 53 ms | 0.2, 0.2 |

What's left at 50 ms is the wasm code GC. **Throughput** (`bench/run.ts --page bench/boot/index.html`, with and
without `--query=vyield=0`, alternating, two each; `results/m8-vcpu-yield/*.json`), medians in ms:

| | yield | none | |
|---|---|---|---|
| Alpine boot to power-off, 1 vCPU | 10055, 9931 | 9926, 9890 | +0.9% |
| 2 vCPUs | 9914, 9884 | 9860, 9840 | +0.5% |
| 4 vCPUs | 9931, 9934 | 9927, 9879 | +0.3% |
| userspace, 4 vCPUs (compress, Lua, churn, SQLite) | 19813, 19617 | 19975, 19818 | −0.9% |

Within noise.

**Busy vCPUs run slowly** (an aside, from the same timelines' `outNs`): over the pages session a vCPU is inside
`vm_run_cpu` 54-62% of the time and retires 106-127 MIPS while there, against 600-800 for the userspace benchmark's
phases on one vCPU; DSB and lock waits are 0.5% of it and compiles 2%. That is the next thing to profile (docs/backlog.md
"JIT").

## M8: where a busy vCPU's time goes in Firefox (2026-10-16)

The dev VM, Chromium 153.0.8010.52, against `b71fd82`; Firefox's pages session (`bench/gpu/firefox-load.ts`, the
desktop guest, 4 vCPUs). The question (backlog, first JIT item): a busy vCPU retires ~115 MIPS there against 600-800
in the userspace benchmark. Raw data in `results/m8-warm/` (the profiles' summaries, the sessions' results, the gates'
JSON); the analysis scripts in `results/m8-warm/tools/`.

**Where inside guest code.** V8's `--perf-prof` writes each function's code bytes (a jitdump, 10.8 GB for a session);
`perf record -k mono` stamps samples with the same clock, so each sample resolves to the code at that address at that
time (code space is reused after flushes and the code GC). Of the vCPU threads' samples (1,056,815):

| | share |
|---|---|
| guest code, **the function's first instruction** (kernel 15.0, user 10.8) | **25.8%** |
| guest code, a `call_indirect`'s signature check (its table load) | 5.3% |
| guest code, the rest (kernel TurboFan 11.4, user TurboFan 11.3, user Liftoff 8.8, kernel Liftoff 4.1) | 35.6% |
| the core: block interpreter 6.1, dispatcher and misses 5.6, helper bodies 2.6, compiles and installs 2.3, other 3.6 | 20.2% |
| V8's runtime, Chromium, libc, vDSO | 12.4% |

The core's own functions have 0.2-1% of their samples at entry, so the first instruction is no sampling artifact; the
Mac host's profile (no VM, 16K pages, `sample`) has 33% of guest code at entry too, so it isn't the VM's iTLB.
**How those functions were entered** (a second session with x16, x17 and LR sampled): 83% after a
`return_call_indirect` (V8 leaves the signature, 0x08000003, in x16 and the target in x17), 13% from the dispatcher,
~0 after a direct or imported `return_call`. 192K distinct guest functions were sampled (3.4 KB of machine code each
on average); a browser's code doesn't fit the caches, and an indirect transfer the branch predictor misses waits for
the target's code. For the guest kernel (half the guest code; Arch's kernel: HZ=1000, `DEBUG_PREEMPT`, PSI) the
targets resolve against the image's `System.map` and `Image`: 57% of its entry stalls were static successors (branch
targets 43%, call targets 14%) reached through the jump cache because they were compiled after their predecessor
(forward regions are never re-emitted), 32% returns (the transfer cache), 9% dispatches.

**A microbenchmark of the transfers** (`tools/chain.mjs`, Node 26, TurboFan only): N functions in a random order, each a
few i64 ops and two loads, tail-calling the next. ns an entry:

| | 16 functions | 1,000 | 32,000 |
|---|---|---|---|
| `return_call`, one module | 12-14 | 21-24 | 22 |
| `return_call` of an import (a module each, compiled in a random order) | 13 | 18 | 18-19 |
| `return_call_indirect`, one table | 15 | 22 | 37-38 |
| `return_call_indirect` of a constant slot in the module's own table | 15 | | 35 |

So it's the indirect transfer itself, not the jump cache's probe or the table's size: a cheaper probe wins little,
fewer indirect transfers win.

**The lever built: warm members** (`jit::Config::warm`, docs/jit.md "Compile policy"): a forward region also takes a
same-page successor that has run 16 dispatches but isn't compiled or in the batch, so the edge into it stays in the
function. Firefox's pages session, alternating, each line one session (busy: a busy vCPU's MIPS inside `vm_run_cpu`):

| | session | busy MIPS | wasm compiled | flushes |
|---|---|---|---|---|
| before | 423, 401, 402, 402 s | 110, 119, 119, 119 | 436-440 MB | 2 |
| warm 1 | 404, 382 s | 124, 130 | 614-618 MB | 3 |
| warm 4 | 376, 379 s | 136, 138 | 580-587 MB | 3 |
| **warm 16** | 375, 363, 364, 371, 370, 375 s | **140, 140, 137, 142, 143, 141** | 506-509 MB | 2 |
| warm 32 | 369 s (the other run timed out, below) | 142 | 495 MB | 2 |
| warm 64 | 373, 377 s | 135, 139 | 478-486 MB | 2 |
| warm 16, a warm member keeps its count | 391, 380 s | 133, 130 | 604-611 MB | 3 |

+18% busy MIPS and −8% session time for 16% more wasm, with the same flushes. The pages start as fast or sooner (hn
36-37 → 16-22 s, github 26 → 22 s, bbc 50 → 44-48 s). A member's count is reset as a batch member's is (it has no
function of its own until it's hot from elsewhere); keeping it compiled 20% more again and was slower. One warm-32
session timed out waiting for Firefox's first page (the guest's kernel and shell alive, nothing in the console); the
other 13 sessions with warm members and the four without ran through.

**The gates** (`bench/run.ts --page bench/boot/index.html`, alternating, three each; medians, ms):

| | before | warm 16 | |
|---|---|---|---|
| `smp_alpine_jit` total, 1 / 2 / 4 vCPUs | 9914, 9804, 9824 | 9575, 9271, 9414 | −3.4, −5.4, −4.2% |
| `smp_user_jit_4` total | 19715 | 19101 | −3.1% |
| compress, Lua, churn, SQLite | 1871, 3111, 2927, 2477 | 1805, 3137, 2554, 2477 | −3.5, +0.8, −12.8, 0% |

**Left** (backlog): returns (a third of the kernel's entry stalls; the host's own call and return would predict
them), the dispatcher's entries, the TLB arrays' offsets as constants in every access, fewer modules for a browser
(~14,500 in a session, ~35 blocks each).

## M8: the `Vcpu`'s fixed offsets within V8's reach (2026-10-16)

Every guest load and store reached its TLB entry at a `Vcpu` offset of 0x10540-0x60548 (one array per EL and use,
64 KiB each, behind `Cpu`), past what an arm64 `ldr` takes as an immediate (32,760 for 8 bytes): V8 built each offset
with a `mov`+`movk`, for the tag and again for the addend, in both tiers. Counted over the 40 hottest functions of
Firefox's pages session (the jitdump of "where a busy vCPU's time goes", 44,567 instructions), the pairs built:

| offset | what | pairs |
|---|---|---|
| 0x10540-0x60548 | the TLB's tags and addends | 474 |
| 0xa0db0 | `JC_PTR` (the jump cache's pointer, in `jit::State` behind the TLB) | 75 |
| 0x60540, 0x60548 | the transfer cache's tag and target | 74 |
| 0xa0540, 0xa0548 | the transfer cache's generations | 37 |

2.4% of those functions' instructions; none of the profile's samples land on them (they retire at once), so the
expected gain was small. The rest of the 32-bit constants there are `jc + constant` (a jump cache entry for a key
known at compile time), inherent. **Built:** (a) the six TLB arrays interleaved by index, `e[index][array]` in a
128-byte line, so the array's offset is `0x600 + 16 × array` and the entry's `(va >> 5) & 0x7ff80` (as many
instructions as `(va >> 8) & 0xfff0`); (b) `jit::State` and the TLB's scalars before the arrays; (c) the transfer
cache at 0x80000 plus a small offset, with 0x80000 ORed into its index (one `orr` against two `mov`+`movk`). Every
fixed offset JIT code loads is now under 0x800 (a compile-time assert). The core's own wasm shrank 62 KB (its Rust
TLB lookups take the small offsets too). V8's code for the `el1-mmu` guest (`tools/v8code.ts`): 116 of the TLB's
pairs and the 15 of `JC_PTR`/`HOT_PTR` gone, 0.6% less code (a guest of few accesses).

Chromium 153, the dev VM (8 vCPUs), alternating. JSON in `results/m8-tlbc/` (`a`: before, `b`: (a) alone, `c`:
all three).

**Firefox's pages session** (busy: a busy vCPU's MIPS inside `vm_run_cpu`; one session each):

| | session | busy MIPS | wasm compiled | flushes |
|---|---|---|---|---|
| before | 376, 375, 372 s | 140, 134, 142 | 507-508 MB | 2 |
| interleaved TLB | 393 s | 129 | 507 MB | 2 |
| **all three** | 366, 364, 373 s | 139, 137, 135 | 506-509 MB | 2 |

Even, within the sessions' spread. A fourth session before the change (`a-1`) waited 330 s for Firefox's first page,
the hang seen once before with warm 32 (backlog); it isn't counted.

**The gates** (`bench/run.ts --page bench/boot/index.html`, three rounds each, pooled medians, ms):

| | before | interleaved TLB | | before | all three | |
|---|---|---|---|---|---|---|
| `smp_alpine_jit` total, 1 / 2 / 4 vCPUs | 9659, 9394, 9536 | 9630, 9349, 9471 | −0.3, −0.5, −0.7% | 9706, 9379, 9490 | 9618, 9310, 9416 | −0.9, −0.7, −0.8% |
| `smp_user_jit_4` total | 18785 | 18691 | −0.5% | 18822 | 18738 | −0.4% |

Below the noise, but the same sign on every boot median; nothing regressed. Kept as less code at no cost: the TLB
grew to 770 KiB a vCPU (two spare slots an index), and a whole flush clears 512 KiB instead of 384.

## M8: the compile worker's modules, posted (2026-10-16)

Queue item 2 was "fewer, larger modules for a browser" (~14,500 a pages session). First, what a module costs the
vCPUs: every vCPU installs every module (`Table::install`: `env.jit_install` on the vCPU's thread), 57,000 installs a
session, 20-21 s of vCPU time (`compileNs`), ~2.5% of a busy vCPU's. One session with every install timed
(`web/vm.ts` instrumented, not kept; `results/m8-posted/install-split.txt`):

| functions | installs | ms each | `new WebAssembly.Module` | `t` imports | instantiate | table sets | KB |
|---|---|---|---|---|---|---|---|
| 1 | 10,803 | 0.093 | 0.068 | 0.010 | 0.015 | 0.001 | 3 |
| 4-7 | 7,495 | 0.198 | 0.154 | 0.016 | 0.024 | 0.003 | 9 |
| 16-31 | 9,955 | 0.378 | 0.307 | 0.025 | 0.038 | 0.005 | 32 |
| 64-127 | 4,042 | 0.881 | 0.729 | 0.048 | 0.081 | 0.016 | 114 |
| 256 up | 372 | 2.657 | 2.277 | 0.112 | 0.199 | 0.057 | 361 |
| all | 57,377 | 0.368 | 81% | 6% | 10% | 2% | |

Four fifths of an install is `new WebAssembly.Module(bytes)`, though the compile worker has compiled the module (a
cache hit), and it grows with the bytes (~6 µs a KB): V8 decodes and validates every function body before it looks the
module up in its cache. Fewer modules would save only the fixed part (~0.08 ms an install, a fifth). Of the modules,
82% are tier-ups (11,860 of 14,436; the batch triggers make the rest).

**Built:** the compile worker posts each compiled `WebAssembly.Module` to every vCPU's host before it publishes
`ready`, and `env.jit_install` takes the module's number (ABI 37): the host instantiates the posted module. It arrives
through the vCPU worker's event loop, which a vCPU visits every 100 ms (`yieldMs`); if it isn't there yet the host
returns −2, the table parks on it (asks again only after the vCPU has been out of the core) and the run ends at the
chunk's end with `BUDGET` short of the budget, on which the vCPU worker goes through its event loop at once. 80-85% of
installs park once; none waited past the second's backstop.

Alternating, Chromium 153, the dev VM. The baseline (`d0`) is the same build with the table always passing 0 (the
host compiles the bytes, as before). JSON in `results/m8-posted/`. The build measured parked every module when there's no
worker (seq 0; fixed before the commit), a path neither the gates nor the page take.

**The gates** (three rounds each, pooled medians, ms; the vCPUs' install time from the counters):

| | before | posted | |
|---|---|---|---|
| `smp_alpine_jit` total, 1 / 2 / 4 vCPUs | 9600, 9313, 9425 | 9478, 9178, 9276 | −1.3, −1.4, −1.6% |
| `smp_user_jit_4` total | 18959 | 18325 | −3.3% |
| compress, Lua, churn, SQLite | 1827, 3067, 2544, 2485 | 1744, 3038, 2448, 2370 | −4.6, −1.0, −3.8, −4.6% |
| install time, `smp_alpine_jit` 1 vCPU / `smp_user_jit_4` | 155-156 / 1284-1301 ms | 37-38 / 251-254 ms | −76, −80% |

Every round's median moved the same way.

**Firefox's pages session** (one session each; stalls: chunks of a vCPU that took 20 ms or more, `bench/gpu/stalls.ts`):

| | session | busy MIPS | vCPU stalls ≥20 ms | vCPU install time | overdue |
|---|---|---|---|---|---|
| before | 373, 378, 377 s | 134, 138, 139 | 5, 7, 9 | 20.2, 21.2, 20.5 s | 0, 60, 0 |
| **posted** | 370, 367 s | 138, 137 | 0, 3 | 3.7, 3.6 s | 0, 0 |

Install time −82%; busy MIPS even, within the sessions' spread (installs were ~2.5% of a busy vCPU); the 20-45 ms
stalls mostly gone: those were installs whose `new WebAssembly.Module` waited on V8 (its module cache while the worker
compiled the same bytes, or the wasm code GC), which no longer runs on a vCPU. The pages load as before. A third
session (`d-2`, not counted) hung 330 s on Firefox's first page as `a-1` did in the A/B before (backlog), with no
stall and no overdue install.

**For "fewer, larger modules"**: what a module costs a vCPU now is the fixed part of an install (~0.06 ms, a table
of four: 0.25 ms of vCPU time) and V8's ~16 KB besides its code; the case for fewer modules rests on memory and the
wasm code GC, not install time.

## M8: counter reads, inline or not (2026-10-16)

The proposal: compute CNTVCT_EL0 inline in JIT code instead of a helper call that returns from the block (the
platform exit, docs/jit.md "Faults and exits"), quoted at 2-5% on kernel-heavy guests from `arch_counter_get_cntvct`'s
2.7% in the boot profile above. That share is the PC sampler's: it charges a chunk to the instruction after the last
exit (docs/benchmarking.md "PC sampling", video.md), so it says where exits are, not what they cost. Counted instead, against
`be6f4d4`: the dev VM, Node 26.7, Chromium 153.0.8010.52. Raw data and tools in `results/m8-cntvct/`
(`count-exits.patch` counts the exits by EL in spare exception-class counters; a diagnostic, not for commit).

**What one read costs** (`tools/micro.ts`, bare metal at EL1, realtime, the JIT; a 4-instruction loop around one
MRS, 2M iterations, five runs each, medians): with `mrs cntvct_el0` 178 ns an iteration, with `mrs tpidr_el1`
(inline) 1 ns; in parallel mode 198 against 38 (that baseline carries the vCPU worker's start-up). The inline version
would still read the host's clock, `performance.now()` through `env.now_ms` (33 ns in Node), and in parallel mode
the atomic maximum: it saves **~150 ns a read** at most.

**How often the guests read it** (realtime, the page's mode; reads a second):

| | reads/s | EL1 / EL0 | steps a read | saved, of busy vCPU time |
|---|---|---|---|---|
| Alpine userspace benchmark, whole run (`tools/count.ts`, Node, 1 vCPU) | 8,070 | all but 52 at EL1 | 84,000 | 0.12% |
| its busiest phase (churn) | 14,200 | all EL1 | 35,000 | 0.21% |
| Firefox, still page (`bench/gpu/firefox-load.ts`, the desktop guest, 4 vCPUs 11% busy) | 30,800 | 26,200 / 4,600 | 2,600 | 1.0% (of 0.44 busy vCPU-s a second) |
| Firefox, scrolling (52% busy) | 87,700 | 63,600 / 24,000 | 2,640 | 0.63% |
| Firefox, WebGL cubes (40% busy) | 56,100 | 47,900 / 8,300 | 2,530 | 0.53% |

The vDSO's reads (EL0) are real in Firefox but a quarter of its reads at most; the kernel's (Arch: HZ=1000, the
scheduler's clock) are the rest. Deterministic time reads 10× as often in Alpine (1.22M against 117K over the run:
a counter tick an instruction runs the guest's clock ~19× faster than the host's), so Node's default runs overstate
the rate.

**Not built:** under 1% of busy time in every workload measured, below what an A/B of the benchmarks resolves, for a
JIT rule that also needs the host-clock import in every module, the atomic maximum in parallel mode, the CNTKCTL_EL1
trap check at EL0 and, in deterministic mode, the step count inside the block. The other timer-register exits
(TVAL, CVAL, CTL: a fifth to half as many) are smaller still.

## M8: guest calls as host calls (2026-10-16; not kept)

The backlog's largest lever after warm members ("Indirect transfers into a browser's code", returns): a guest `BL`/`BLR`
as a wasm `call` and the callee's `ret` as a wasm `return`, so the host's return stack would predict guest returns
instead of an indirect tail call through the transfer cache. Built, tested (lockstep, the differential test, a new
JIT test of leaf calls, recursion past the depth limit and `longjmp`-like returns, with planted bugs caught) and
measured against `03cb438`; the dev VM, Chromium 153.0.8010.52, Node 26.7. Data, the patch and the tools in
`results/m8-calls/`.

**The profile at HEAD** (`results/m8-calls/profile/regs0.txt`, the method of "where a busy vCPU's time goes"): after
warm members, the stall at a guest function's first instruction is 21.4% of the vCPU threads' samples (25.8% before
them), and returns became the largest part of the kernel's (42.5%, from 30%).

**The design** (`host-calls.patch`): every block function takes a fourth parameter, its host call depth; a call below
depth 64 is a `call` (the same probes as the tail call: a compiled callee directly, else the jump or transfer cache),
a `ret` at depth > 0 returns the retired count with bit 31 set, and any other result (exit, budget, a block not
compiled) unwinds every frame unchanged. After a return the caller continues at the call's continuation if the PC is
there (else through the transfer cache's miss function). Variants, each measured:

| | continuation | Alpine boot gate (1/2/4 vCPUs) | userspace phases | Firefox busy MIPS | Firefox wasm |
|---|---|---|---|---|---|
| baseline | (its own function, reached by the `ret`) | | | 129, 135, 122* | 468-508 MB, 2 flushes |
| b3 | a member of the caller's region | +5.4, +4.8, +5.6% | −1 to −3% (1 round) | | |
| b4 | its own function, tail-called by the caller | +2.6, +3.3, +3.2% | Lua +12% (1 round; even in Node) | 136 | 607 MB, 3 flushes |
| b6 | b3 with a leaner post-call path | | | 122 | 671 MB, 3 flushes, dispatches +54% |
| **b8** | a member, and an **entry** of the region | −1.1, −0.9, −0.4% | churn −11%, rest even (3 rounds) | 120 | 624 MB, 3 flushes |

\* hung on the first page (the known hang) and ran 663 s. A continuation inside the caller's region is only reached
from inside while the host frames last; every exit (a syscall, a fault, an interrupt, the chunk's end) unwinds them,
and the returns after it come through the transfer cache, where a member has no function: b6 ran those in the
interpreter until each was compiled again as a head. b8 gave regions entries (the entry number in the depth's high
bits and in the cache's word beside the table index, a prologue that branches to the member), which fixed that and
the boot's cost.

**Why it doesn't pay** (`profile/regs4.txt`, `regs8.txt`, b4 and b8 in the same session as above):

| share of vCPU samples | HEAD | b4 | b8 |
|---|---|---|---|
| guest code at a function's first instruction | 21.4% | 19.3% | 17.0% |
| guest code, the rest (TurboFan and Liftoff) | 36.0% | 37.7% | 40.0% |
| guest code in all (with the signature checks) | 61.3% | 59.8% | 59.6% |
| the kernel's entry stalls at return continuations | 42.5% | 37.2% | 17.5% |

The returns' stalls left the function entries, and the time reappeared in the bodies: at the continuation's code
inside the caller (b8), or at the continuation's function reached by a direct tail call (b4). Samples at the
instruction after the host call itself stayed at 0.1-0.2%. So the stall is mostly fetching code that isn't in the
caches, which a predicted return doesn't fetch any sooner, and the variants' extra code (12% on Alpine, 19-32% in
Firefox) costs Firefox a third budget flush and 15-30% more interpreted steps. In Node (one vCPU) b4 and b8 matched
the baseline on every userspace phase but churn. Not kept; the call counters (`call-counters.patch`) showed 90-96% of
host calls returning to their continuation in the userspace benchmark and the depth limit never reached.

**For the other levers in that backlog item**: re-emitting regions whose jump-cache targets were compiled later (direct
links instead of indirect ones) attacks the same stall by the same theory (an indirect branch the predictor misses),
so it would likely move it too; measure the stall's cause first (a direct tail call into a cold target, `chain.mjs`
with the targets' code evicted) before building either.

## M8: TLBI by VA drops whole blocks (2026-10-16)

The fix for the corruption `scripts/ci-deqp.sh` found once FEAT_E0PD let a KASLR kernel run without KPTI (docs/cpu.md
"Blocks"): our TLB cached a 2 MiB block as entries for the pages used through it, and a TLBI by VA dropped only its own
page, while Linux unmaps a transparent huge page with one TLBI for the 2 MiB. On the Arch dEQP guest GLES2's list
passed 2/2 with `transparent_hugepage=never` and passes 2/2 with the fix. Alpine's userspace benchmark is guest-visibly
different (10,613,406,958 → 10,612,335,608 steps; the run through snapshots, which flushed the TLBs and so the stale
entries, now comes out at the same count) and takes **21% fewer TLB misses** (2.27M → 1.79M; flushes 70,790 → 71,618).

A/B against `35de718` (A) in one session, alternating (ABBAABBA), four rounds each; the dev VM, Chromium 153.0.8010.52.
The JSONs (`results/m8-tlbblock/`) all say `35de718`, dirty: the cores were swapped in by file, A then B in each name.

| median ms, per round | A (`35de718`) | B (the fix) |
|---|---|---|
| `alpine_user_jit_total` | 16,802 · 16,790 · 16,730 · 16,739 | 16,808 · 16,743 · 17,068 · 17,044 |
| `alpine_jit_total` | 7,761 · 8,002 · 7,845 · 7,875 | 7,839 · 7,990 · 7,869 · 7,922 |

The boot is within 0.4%; the userspace benchmark is within 1% on the median of rounds (16,765 against 16,926), with
B's last two rounds 1.8% slower: under the noise threshold, and a fix for corruption is kept whatever it costs at this
size. The scan a TLBI by VA adds runs only while the TLB holds pages of blocks in that VA half.

## M8: the integer NEON inline (2026-10-18)

The integer NEON forms, the structure loads and stores and CRC32 that a cloud session compiled inline (docs/jit.md
"NEON lane by lane", "Structures"; the PR `claude/project-thread-fcaq73`, measured here as `bafe081` against its base
`1f5e8c4`). The dev VM, Chromium 153.0.8010.52; the cores swapped in by file (the JSONs say `9edb021` or `bafe081`,
A and B in each name), alternating ABBAABBA. Data in `results/m8-neon/`.

**The guest's browsers decoding images** (`bench/imgdecode/`: Chromium 153 and Firefox 140.16 ESR on the page's
Debian, 4 vCPUs, 3 GiB; `WARM=15 WINDOW=60`; four sessions A1 B1 B2 A2). Images a second between the first and last
rounds that end in the 60 s window, and the helper calls in it as a share of the guest's instructions:

| case | A (rounds 1 · 2) | B | B/A | helpers A | helpers B |
|---|---|---|---|---|---|
| Chromium JPEG | 2.77 · 2.84 | 7.18 · 7.64 | 2.64× | 7.22 · 7.39% | 0.19 · 0.17% |
| Chromium PNG | 5.51 · 5.38 | 7.78 · 7.50 | 1.40× | 1.09 · 1.16% | 0.34 · 0.37% |
| Chromium WebP | 2.46 · 2.49 | 6.04 · 5.94 | 2.43× | 3.72 · 3.83% | 0.10 · 0.10% |
| Chromium AVIF | 1.61 · 1.74 | 3.37 · 3.30 | 1.99× | 4.96 · 4.80% | 0.10 · 0.15% |
| Firefox JPEG | 2.14 · 2.18 | 9.25 · 9.25 | 4.29× | 12.13 · 12.23% | 0.31 · 0.32% |
| Firefox PNG | 3.26 · 3.34 | 8.76 · 8.74 | 2.65× | 3.86 · 3.81% | 0.14 · 0.14% |
| Firefox WebP | 1.82 · 1.87 | 5.16 · 5.26 | 2.82× | 7.10 · 7.25% | 0.30 · 0.29% |
| Firefox AVIF | 0.98 · 0.99 | 2.21 · 2.61 | 2.45× | 6.18 · 6.36% | 0.24 · 0.21% |

2.48× in the geometric mean. A's top helpers were the forms now inline (SMLAL by element 442M calls in Firefox's
JPEG minute, SMULL/SMLSL by element, RSHRN, SQXTUN, SQDMULH, LD1R, CRC32 73-78M in Chromium's PNG); B's are the
load/store slow paths, YIELD and the system instructions. Firefox's `libz.so` took 28% fewer PC samples per PNG
(~4,100 → ~2,960), while its share of the samples rose 18% → 35% as the rest sped up more; it made no CRC32 calls on
either side. Chromium's zlib is inside its binary (no symbols), so only its whole case (1.40×) says anything.

The first sessions (30 s windows) counted the images decoded, which a round of 24 makes move by 25-33% of the count:
the page now timestamps each round and `profile.ts` reports the rate (README).

**The gates** (four rounds a side, at a host load average under 3; two earlier sets ran beside another session's CI
and were dropped):

| median ms, per round | A (`1f5e8c4`) | B |
|---|---|---|
| `alpine_jit_total` | 7,954 · 8,085 · 8,082 · 7,928 | 8,099 · 8,105 · 8,043 · 7,995 |
| `alpine_user_jit_total` | 17,758 · 17,755 · 17,371 · 17,732 | 17,369 · 17,733 · 17,392 · 17,347 |

The boot is within 0.7% (noise; its CRC32C helper calls, 49,008 a boot, are gone). The userspace benchmark is 2.0%
faster on the median of rounds, every phase −1.0 to −2.3% (compress −1.9%, Lua −1.0%, churn −2.3%, SQLite −1.0%):
under the noise threshold, and the same direction in each.

## M8: what per-module eviction could free (2026-10-18)

**Invalid, rechecked 2026-10-19** (`results/m8-evict/` README, "Rechecked"): the measuring patch lost every table's
marks at the first flush, so its "cold" was install age. With the marks kept, 0-12 MiB of the 160 MiB cache was unused
for 5-60 s at Firefox's flushes: nearly every module holds a region in use, and eviction built on generations (branch
`evict-generations`) never evicted. The cost of generations below stands.

Before building eviction (docs/backlog.md "Per-module eviction, coldest first"): how much of a full cache is cold and
imported by nothing warm, since a module's memory goes only with all its importers. The dev VM, Chromium
153.0.8010.52, the core at `0778386`; the method, the tables and the data in `results/m8-evict/` (README "On the dev
VM"). At Firefox's flushes (the pages session, two sessions, three flushes each, 160 MiB) ~90% of the cache hadn't
been entered for 30 s, but only 3-4% was freeable with every import pinning and 6-9% if imports of targets cold at
compile time didn't pin; with imports only within an eighth of the budget by install order, 88-90% (the 4-vCPU
`go build` loop: 7%, 17%, 90%). That restriction alone (`cost.patch`, no eviction), A/B alternating: Firefox's busy
MIPS 139 · 136 → 137 · 135, `smp_alpine_jit` +0.1%, `smp_user_jit_4` −0.9%: noise. Eviction is built on generations
next.

## M8: carrying the hot set across a flush (2026-10-19)

The user's question: do budget flushes stop stuttering a browser's video, music and WebGL? The dev VM, Chromium
153.0.8010.52, Arch Linux ARM's desktop disk, 4 vCPUs; data and tools in `results/m8-replay/` (README). Three
designs, each A/B alternating against the default of the same build: the replay the cloud built (the hot set
compiled again right after the flush), the same paced, and the carry (the hot set kept running from its slots
while it's compiled again into the other half of the slots; docs/jit.md "Replay after a flush").

**The replay as built stopped every vCPU ~1.2 s at each flush** (Firefox's pages session, 3 of 3 flushes: vCPU
stalls of 1.0-1.24 s on all four at once, `overdue` 229): the first table to miss compiled the whole capped hot
set, ~58,000 regions in ~114 modules, holding the cache's lock. Paced (64 regions a module, one every 4 ms at most),
no stall over 55 ms.

**What the slow phase after a flush is** (`diag.patch`: a flush for room every 30 s of Firefox's WebGL page, per
second the steps interpreted by kind and the compile work): the steps in compiled code fall from ~99% to ~84% for a
second, nearly all of what's interpreted is code compiled before the flush, and the compile work is small (~80 ms
emitting and ~40 ms installing a second over the vCPUs); Firefox's frames fall from ~33 a second to 4-12 at the
worst second, ~24 on average over the 10 s after, and the share is back in 3-4 s. **With the threshold's floor
doubled at each flush** (as at every real session's second and third flush) the same flush took 11-16 s to come
back, frames 6-10 a second for ~10 s (`s1-base`): that is where the user's long stutters come from.

| per flush, WebGL, the floor kept (a first flush) | default (13 flushes) | replay, no carry (8) | carry (8) |
|---|---|---|---|
| slow phase (compiled share back within 2 points) | 3-4 s | 2-3 s | 0 s |
| worst second's frames, median (range) | 8 (4-12) | 7 (4-8) | 18 (13-22) |
| frames a second, mean of the 10 s after (31-34 before) | 22.9-25.1 | 19.3-23.2 | 21.1-26.5 |

Replay without carrying compiles the hot set while everything else runs interpreted: shorter but deeper. The carry
keeps the share at ~99% throughout; what's left is a milder ~5 s dip from the replay's compiling on the vCPUs
(~0.3 s emitting and ~0.1 s installing a second, under the cache's lock).

**Firefox's pages session** (every flush lands on a new page's code, which no hot set holds; busy MIPS from
`stalls.ts`):

| | sessions | flushes | wasm MB | busy MIPS | stalls ≥20 / ≥50 ms | interpreted M steps, 10 s after each flush |
|---|---|---|---|---|---|---|
| default | 7 | 2-3 | 504-551 | 121-138 | 0-4 / 0 | 108-120, 129-153, 58-166 |
| replay as built | 1 | 3 | 624 | 139 | 52 / 27 | 142, 125, 62 |
| replay, paced | 3 | 3 | 624-631 | 125-131 | 11-21 / 0-1 | 107-109, 97-110, 82-133 |
| floor not doubled | 2 | 3 | 641-645 | 120 | 0-2 / 0-1 | 83-84, 76-99, 52-138 |
| carry | 2 | 3 | 633-635 | 118-122 | 15 / 4 | 67-80, 121-126, 29-50 |

In the same pairs: carry 122 busy MIPS against the default's 126; no doubling 120 · 120 against 121 · 121. The
carry's second flush was a classic one each time: the replay had filled half the epoch, which its guard against
carrying again counts as futile. Its third flush interpreted 29-50 M steps against the default's 58-166. The carry
and the replay compile ~25% more wasm and brought a third flush; the doubled floor holds the default to 2-3. The
carry's 20-57 ms stalls are the replay's emitting; `overdue` 68 and 94 (tables waiting a second for the compile
worker while the replay feeds it).

**The gates** (three rounds alternating, medians of each round, ms; `results/m8-replay/gates/`):

| | default | carry | |
|---|---|---|---|
| `smp_alpine_jit_n1_total` | 9,619 · 9,747 · 9,538 | 9,580 · 9,772 · 9,582 | −0.4% |
| `smp_alpine_jit_n4_total` | 9,457 · 9,579 · 9,391 | 9,410 · 9,619 · 9,435 | −0.2% |
| `smp_user_jit_n4_total` | 18,683 · 18,653 · 18,884 | 19,061 · 18,763 · 19,313 | +2.0% |

The userspace benchmark is slower in every round (IQR 17-370): the mark per dispatch, under the noise line but
consistent. Neither gate flushes. **The 4-vCPU `go build` loop** (one each, 420 s): one flush each (in the boot),
MIPS median 1,061 against the carry's 1,176 (first third 896 against 1,105), the renderer 2.9-3.3 GB against 3.2-3.5 GB.

**Decision: the carry lands off by default** (`?jit=replay`). It clearly removes the interpreted slow phase at a
flush in steady playback, where the user hears the stutter. But in page loads it compiles a quarter more wasm and
an extra flush, and it costs the userspace benchmark 2%. What would make it the default (docs/backlog.md "Carrying
the hot set across a flush, by default"): replay only what was marked, emit outside the cache's lock, and mark
only while a probe runs.

## M8: the carry timed, and a larger code cache (2026-10-20)

The second round of carrying the hot set across a flush (replay only what was marked, mark only during a probe, emit
outside the cache's lock and in the compile worker; built and counted in a cloud session, docs/jit.md "Tried and not
kept") timed on the dev VM, and the user's belief tested that Firefox's flushes come from a hot working set larger
than the cache, which only a larger budget fixes. The dev VM, Chromium 153.0.8010.52, Arch Linux ARM's desktop disk,
4 vCPUs, 2.5 GiB; data in `results/m8-replay/r2/` (`results/m8-replay/README.md`). Busy MIPS from `bench/gpu/stalls.ts`; the renderer's RSS
from `results/m8-replay/r2/rss.sh` beside each session (MiB, median and maximum over the session).

**The carry at a flush in steady WebGL** (`results/m8-replay/diag.patch`, updated: a probe 5 s before each flush
forced every 30 s; flushes 2-4 of each session, the one during Firefox's start left out):

| per flush | default (3 sessions, 9 flushes) | carry, the worker emitting (2, 6) | carry, the vCPUs emitting (1, 3) |
|---|---|---|---|
| slow phase (compiled share back within 2 points) | 3-5 s | 2-3 s | 0-3 s |
| worst second's frames (from 31-34), median (range) | 8 (6-9) | 10.5 (6-14) | 10 (10-11) |
| frames a second, mean of the 10 s after | 22.6-25.1 | 24.2-27.2 | 22.8-25.2 |

Better than the default, less than the first carry's (worst second 18): what was marked in the 5 s before the flush
(22,000-47,000 regions, 22-59 MiB of 41-115 MiB alive) leaves code in use unmarked, interpreted after the release.
Where the replay is emitted doesn't show.

**Firefox's pages session**, alternating in one session (round 1: the carry's core at ABI 42, `?jit=replay` for
the carry and the budgets; round 2 the same core with two knobs; then the landed core, ABI 43, by core swap):

| | busy MIPS | flushes | wasm MB | stalls ≥20 / ≥50 ms | wiki, bbc load (s) | RSS median, max (MiB) |
|---|---|---|---|---|---|---|
| default 160 MiB (r1) | 113 · 111 | 2 · 2 | 509 · 504 | 2/0 · 3/0 | 30 · 32, 32 · 29 | 4,562 · 4,570, 5,523 · 5,504 |
| carry 160 MiB (r1) | 107 · 109 | 3 · 3 | 664 · 658 | 23/7 · 18/11 | 30 · 39, 31 · 23 | 4,765 · 4,805, 6,105 · 6,004 |
| carry, vCPUs emitting (r1) | 108 | 3 | 654 | 27/5 | 32, 25 | 4,666, 5,750 |
| carry 240 MiB (r1) | 125 · 124 | 1 · 1 | 499 · 499 | 9/2 · 9/4 | 24 · 27, 22 · 27 | 5,169 · 4,873, 6,155 · 5,957 |
| carry 320 MiB (r1) | 131 · 128 | 0 · 0 | 329 · 326 | 1/1 · 0/0 | 22 · 22, 21 · 23 | 5,803 · 5,488, 6,343 · 6,062 |
| default 160 MiB (r2) | 113 | 2 | 507 | 4/0 | 28, 30 | 4,809, 5,742 |
| carry, `REPLAY_MAX` 2 (r2) | 109 | 3 | 662 | 26/6 | 29, 37 | 4,867, 5,982 |
| carry, `REPLAY_MODULE` 128 (r2) | 109 | 3 | 661 | 23/5 | 30, 25 | 4,487, 5,657 |
| carry (r2) | 105 | 3 | 651 | 28/6 | 29, 27 | 4,738, 5,958 |
| **landed, 160 MiB** | 121 · 127 | 2 · 3 | 506 · 525 | 0/0 · 3/0 | 32 · 25, 30 · 25 | 4,856 · 4,709, 5,955 · 5,552 |
| **landed, 320 MiB** | **144 · 143** | **0 · 0** | 329 · 329 | 1/0 · 0/0 | **19 · 19, 19 · 20** | 5,250 · 5,544, 5,847 · 5,928 |

- **The hot set is about the cache, as the user thought.** At every carried flush the regions marked since the probe
  (from 7/8 of the budget) were more than half the budget: 62,000-77,000 at 160 MiB and 122,000-123,000 at 240, and
  the replay hit its cap each time (81 and 123 MiB). So the carry filled half the next epoch with the old hot set,
  the next flush came after 23 G steps instead of 40, and every second flush was made classic by the guard against
  carrying a replay-filled epoch: a third flush, 30% more wasm, 2-7% fewer busy MIPS in each of four pairs (the first
  round's 122 against 126 too), and 5-11 stalls of 50-95 ms (the replay's modules: `overdue` 116-356) against none.
  A quarter replayed or smaller worker modules (one session each) removed the overdue tables, not the cost.
- **A larger budget is what helps:** at 320 MiB the session never flushes (~330 MB of wasm: the default at 160
  compiled ~505 MB, compiling the same pages' code again after each flush), busy MIPS +16% (143-144 against
  121-127), the heavy pages load in 19 s against 25-32. 240 MiB flushes once.
- **Memory:** the renderer's median RSS +0.4-0.8 GiB (5,250-5,544 MiB against 4,709-4,856), its maximum about the
  same (5,847-5,928 against 5,552-5,955: at 160 MiB the peaks are the flushes' garbage); V8's wasm code (the
  executable mappings) ~1.2 GiB at 320 against ~1.3 at 160, which compiled more. The carry's maximum was 5,750-6,105
  MiB (two halves alive).

**The gates** (three rounds alternating, medians of each round, ms; `results/m8-replay/r2/gates/summary.txt`):

| | landed, 160 MiB | landed, 320 MiB | |
|---|---|---|---|
| `smp_alpine_jit_n1_total` | 9,503 · 9,470 · 9,423 | 9,604 · 9,468 · 9,436 | −0.0% |
| `smp_alpine_jit_n2_total` | 9,233 · 9,228 · 9,156 | 9,345 · 9,213 · 9,198 | −0.2% |
| `smp_alpine_jit_n4_total` | 9,314 · 9,318 · 9,260 | 9,419 · 9,309 · 9,285 | −0.1% |
| `smp_user_jit_n4_total` | 19,023 · 18,673 · 18,461 | 18,725 · 18,657 · 18,425 | −0.1% |

(IQR 2-77, n=5 and 2; the change in the median of the rounds' medians.) In round 1 the carry was even too (+0.1
to +0.8%; `smp_user_jit_4` 18,787-19,445 against 18,691-19,118: marking only during a probe removed the first
round's +2%).

**The 4-vCPU `go build` loop** (420 s, two each alternating; MIPS median): round 1, the default 1,069 · 1,104, the
carry 1,189 · 1,183, the carry's core at 320 MiB 1,212 · 1,181; landed, 160 MiB 1,152 · 1,151, 320 MiB 1,133 ·
1,174. At 160 MiB it flushes once in its first minutes (that build takes 46-49 s, against 39-41 at 320; the steady
builds 37-39 s alike); at 320 never. The renderer: 2,501-3,319 MiB at 160, 3,523-3,852 at 320 (the stress tool's first and last
after its warm-up).

**Decision:** the carry is taken out (ABI 43; docs/jit.md "Tried and not kept"): it costs Firefox's page loads,
the workload whose flushes it was for, in every pair, and its `go build` gain the larger budget gives too. The budget
is **320 MiB** (`MAX_BYTES`): the pages session without a flush, +16% busy MIPS and its heavy pages loaded a third
faster, the gates and the `go build` loop even, for ~0.5 GiB more renderer memory while the cache is full (the
maximum about the same). More would be past the slots (262,144: ~340 MiB at Firefox's ~1.3 KB a region) and past
what the pages session uses.

## M8: smaller slow arms of loads and stores (2026-10-20)

The backlog's first Liftoff item: a load's or store's slow arm (the `else` of its TLB check, which almost never
runs) wrote back every dirty register and stored the lazy flags before its helper, and returned on its own. Now it
writes back only the registers the instruction reads or writes, and a failing helper branches to the block's
**failure chain**, where each register is stored once and the flags once (docs/jit.md "Loads and stores"). The dev
VM, Chromium 153.0.8010.52, Node 26.7.0; `base` main at fbd9b02 (the 320 MiB cache), `chainf` the change, swapped
in as the core; data and tools in `results/m8-liftoff/slowarms/` (README).

**Size** (Alpine's boot in Node, deterministic, 643 modules either way; V8's code from every 8th module compiled
eagerly in one tier with `--print-wasm-code`):

| | base | chain | |
|---|---|---|---|
| wasm | 29.47 MB | 27.68 MB | −6.1% |
| Liftoff code (81 modules, 2,048 functions) | 9.37 MB | 8.57 MB | −8.6% |
| TurboFan code (the same) | 6.17 MB | 5.80 MB | −6.0% |

(The code sizes come from a child compiling plain JS: a `.ts` child loads Node's type stripper, whose own wasm
`--print-wasm-code` prints too; the commit's first numbers, −4.4% and −2.1%, were diluted by it.) A first version
without the shared flag store (each failing site stored NZCV itself) made 2.8% less wasm: the lazy flags' NZCV,
computed at every site, was as big as the write-backs. The backlog's bound
(−12.6% Liftoff with one store per register a function) also dropped the stores the helper needs, which are most of
them: a site's dirty registers are mostly its base and the value it stores.

**Firefox's pages session** (alternating: base-0, chainf-1, base-1, chainf-2, base-2):

| | busy MIPS | wasm MB | modules | flushes | stalls ≥20 ms | RSS median, max (MiB) | wasm code median, max (MiB) |
|---|---|---|---|---|---|---|---|
| base | 144 · 143 · 143 | 329 · 329 · 330 | 8,094-8,155 | 0 | 3 · 0 · 0 | 5,298 · 5,468 · 5,406, 5,888 · 6,062 · 5,825 | 1,007 · 997 · 1,032, 1,201 · 1,165 · 1,207 |
| chain | 145 · 146 | 307 · 307 | 8,161-8,194 | 0 | 1 · 0 | 5,267 · 5,544, 5,763 · 5,945 | 989 · 950, 1,345 · 1,134 |

6.7% less wasm and the same busy MIPS (+1.5%, noise). The renderer's RSS moves ±150 MiB between sessions of one
build, more than the ~30-60 MiB the code saves (V8's wasm code ~1 GiB, of which this is 2-4%), so the memory gain
isn't visible in a session's RSS; the executable mappings' medians are 2-4% lower.

**The gates** (three rounds alternating, medians of each round, ms):

| | base | chain | |
|---|---|---|---|
| `smp_alpine_jit_n1_total` | 9,487 · 9,562 · 9,457 | 9,413 · 9,377 · 9,399 | −0.9% |
| `smp_alpine_jit_n2_total` | 9,209 · 9,234 · 9,231 | 9,167 · 9,158 · 9,123 | −0.8% |
| `smp_alpine_jit_n4_total` | 9,307 · 9,357 · 9,327 | 9,215 · 9,246 · 9,179 | −1.2% |
| `smp_user_jit_n4_total` | 18,513 · 18,971 · 18,574 | 18,809 · 19,271 · 18,427 | +1.3% |

(IQR 12-118, one 553; wasm 30.0 → 28.2 MB for the boot, 38.7 → 36.6 MB for the userspace benchmark.) Within noise
both ways. **Kept:** 6-7% less wasm, 8.6% less Liftoff code and 6% less TurboFan code at no cost in
speed.

## M8: what Liftoff runs that a static change could cut (2026-10-20)

The rest of the Liftoff round after the failure chain (above): one TLB check for a run of accesses off one base,
fewer locals to zero-fill, scalar FP in float locals, and folding constants. Each was counted first with a
diagnostic core (static counts over every function compiled), deciding on **Firefox's pages session** (the
desktop guest) and Alpine's userspace benchmark in Node, Alpine's boot only alongside; data and patches in
`results/m8-liftoff/baseruns/` (README).

| | Firefox's pages session | Alpine userspace (Node) | Alpine boot (Node) |
|---|---|---|---|
| instructions compiled (static) | 2.92 M | 350,000 | 296,000 |
| accesses with a base register | 1.04 M | 101,000 | 84,300 |
| of those after an access off the same unchanged base, same direction, same run | 27.4% | 28.4% | 28.8% |
| scalar FP inline | 14,544 (0.5%) | 30 | 0 |
| MOVK | 32,238 (1.1%) | 2,508 (0.7%) | 2,447 (0.8%) |
| ADRP followed by an ADD of its register | — | 2,003 (0.6%) | 1,864 (0.6%) |
| functions compiled | 249,646 | 27,573 | 22,747 |
| of those zero-filled by Liftoff at entry (more than 12 locals) | 40.2% | 42.1% | 43% |
| zero-fill loop turns, a function | 14.5 | 15.6 | 16.1 |
| functions at 13-16 integer locals | 18.6% | 18.6% | 19% |

- **One check for a run of accesses:** the runs are there (27% of Firefox's access sites), but a base's page
  offset isn't known when compiling, so a follower still needs its full TLB check behind a same-page test (else a
  frame across a page boundary sends one access to the helper every time): more code, and only the ~0.1 ns TLB hit
  saved at run time, the translation memo's shape that lost on `alpine_user_jit` and llvmpipe (docs/jit.md "Tried
  and not kept"). Not built.
- **Zero-filled locals:** V8 fills nothing for 12 integer locals or fewer and everything past that
  (`tools/zerofill.mjs`: 13 locals turn the loop on). Keeping a load's base in the BASE local only when a writeback
  or SP's check needs it (`no-base-local.patch`) moved Firefox's zero-filled functions from 40.2% to 39.7% and the
  fill turns 0.9% (its wasm 0.6% smaller): one local seldom crosses the threshold, and getting most of the 18% at
  13-16 locals under it would take sharing locals between guest registers (a register allocator). Sharing HOST with
  TLBE broke the userspace benchmark (a signature mismatch: something keeps TLBE's local busy while HOST lives) and
  was dropped. Not kept; docs/backlog.md has the entry with these numbers.
- **Scalar FP in float locals:** 0.5% of Firefox's instructions, none in the userspace benchmark: for the FP guest,
  not the ranking workloads. Not started; the backlog entry has the counts.
- **Folding constants:** MOVK 1.1% of Firefox's instructions, ~4 wasm ops saved each: ~0.2% of the wasm. Not built.

## M8: benchmarks started from a snapshot (2026-10-20)

How a JIT A/B on the desktop guest can turn around faster (docs/benchmarking.md "Starting from a snapshot" and
"Screening an A/B"). The dev VM, Chromium 153.0.8010.52, Arch Linux ARM's desktop disk, 4 vCPUs, 2.5 GiB; `main` the
core at e14fb66 (320 MiB), `mainB` a copy of it (the A/A), `b160` the same with `MAX_BYTES` 160 MiB; data in
`results/m8-snapbench/` (per session `results.json`, `counts.json`, `stalls.json`, `jit.jsonl.gz`, `rss.txt`,
`wall.txt`; `summary.json` per directory from `bench/gpu/ab-summary.ts --json`; `cut.txt` from `cut.mjs`, the counts
at cutoffs; `snapshots/` the warm files' sidecars).

**Where a session's time goes** (Firefox's pages session from boot): the page running at 38 s (UEFI and the boot),
the root login and the files by 45 s, sway by 72 s; then the five pages, each Firefox's start, the load, 10 s of rest
and 10 s scrolled, ~370-417 s; 441-490 s in all. The setup is 15% of a session: the boots weren't what made a round
cost 10 hours, the number of full sessions was.

**A snapshot of the warm guest** (`bench/gpu/warm-snapshots.sh`, 321 s once: two files, 701 and 717 MB) loads in
8.7-9.3 s into any core with the same state layout (the page's own rule: `tests/snapshot.test.ts`); the phases begin
11 s after the start. Three rounds each way, alternating the three cores:

| pages session | busy MIPS | flushes | wasm MB | modules | compiled share | wiki, bbc load (s) | wall (s) | setup (s) |
|---|---|---|---|---|---|---|---|---|
| boot, main | 138 · 144 · 135 | 0 | 308 | 8,138-8,199 | 98.8% | 18.8, 19.1 | 441-463 | 72-76 |
| boot, mainB | 142 · 143 · 131 | 0 | 308 | 8,144-8,186 | 98.8% | 19.7, 19.3 | 451-469 | 72-74 |
| boot, b160 | 124 · 125 · 121 | 2 | 468-470 | 13,974-14,119 | 97.5% | 25.3, 31.5 | 481-490 | 71-73 |
| snapshot, main | 146 · 151 · 143 | 0 | 269-270 | 6,632-6,741 | 98.9% | 18.1, 19.2 | 377-380 | 11 |
| snapshot, mainB | 147 · 148 · 140 | 0 | 270 | 6,691-6,807 | 98.9% | 18.9, 18.4 | 376-390 | 11 |
| snapshot, b160 | 124 · 124 · 129 | 2 | 382-426 | 10,654-12,218 | 97.5% | 18.6, 23.3 | 395-428 | 11 |

(The loads are medians. Busy MIPS IQR 2-6 either way; the counts' IQR at 320 MiB 0-0.5 MB and 21-73 modules; at
160 MiB from the snapshot 22 MB and 782 modules, where the second flush's time varies.)

- **The 320 MiB conclusions reproduce both ways:** no flush against two, busy MIPS +12% from boot (138-142 against
  124) and +18% from the snapshot (146-147 against 124), the heavy pages' loads shorter (from boot 18.8-19.7 s against
  25.3-31.5; from the snapshot only bbc's, 18.4-19.2 against 23.3: the first flush comes later there, 133-135 s in,
  after wiki has loaded). The A/A is even both ways.
- **Turnaround:** nine sessions took 70 min from boot, 59 from the snapshot (−16%). A snapshot doesn't change what a
  full session costs; it makes short ones possible.
- **What differs from a boot:** the code cache starts empty (the boot's ~40 MB of compiled code isn't in it), so the
  counts are lower (269 against 308 MB at 320 MiB) and a budget fills later. Arms compare within one mode.

**How early the counts decide** (`cut.txt`): from the snapshot, at 120 s (wiki loaded, mdn starting) the compiled
share since the start was 97.5-97.7% at 160 MiB against 98.6% in all six sessions at 320 (the A/A within 0.1 point);
by 180 s every 160 MiB session had flushed once and none at 320. From boot the 160 MiB sessions had flushed by 120 s.
Busy MIPS needs whole sessions (its spread, 131-151, is wider than the A/A's difference).

**A workload that flushes at 320 MiB: the churn page** (`bench/gpu/firefox/churn.html`: functions made from a
template and called past SpiderMonkey's tiers). From the snapshot at `rate=40` for 180 s: the first flush 60 s after
the page was ready, two in 180 s, 744 MB compiled, 4,960 functions, busy MIPS 185 (`churn1/`). As a screen with fixed
work (`rate=60&total=4000`, the phase ending when the 4,000 are made; `screen/`, one round):

| churn screen | flushes | first flush (s) | wasm MB | modules | compiled share | done in (s) | busy MIPS | wall (s) |
|---|---|---|---|---|---|---|---|---|
| main | 1 | 53 | 546 | 32,790 | 96.4% | 132.7 | 184 | 216 |
| mainB | 1 | 53 | 543 | 32,710 | 96.5% | 133.3 | 189 | 214 |
| b160 | 2 | 26 | 491 | 33,551 | 95.4% | 138.8 | 174 | 220 |

The same verdict as the pages session (more flushes, a lower compiled share, slower) in 3 × ~215 s, 11 min with the
A/A, against 59-70 min for three rounds of full sessions. Its functions run once, so it measures the fill and the
flushes' cost, not the keeping of a reused hot set; the smaller wasm total at 160 MiB is that (dead code isn't
compiled again after a flush).

**Real sites** (opt-in; `sites2/`): the guest online through `tests/net/tailcat.sh`'s exit node, IPv6 dropped in the
guest (a curl to youtube.com: 200 in 1.0 s), six sites (a YouTube watch page, the Guardian, CNN, BBC News,
Excalidraw, Google Maps) 20 s each in one tab: 264 MB compiled and no flush in 130 s at 320 MiB, against the churn's
424 MB in its first 120 s. Too short a run to compare their flushes with the churn's.

**Debian:** `debian-go.waarm64snap` (176 MB, saved 37 s after the start) loaded into the 160 MiB core ran the `go build`
loop at once (`go/`: builds of 55 and 38 s in 120 s, 1,134 MIPS).

**For the next lane:** screen variants with the churn page from the snapshot, an A/A arm in each run (five variants
~22 min), then time the winner on the full pages session from the snapshot (three rounds) and the gates.

## M8: a machine's JIT budget and the page's memory signal (2026-10-20)

Headless Chromium 153.0.8010.52 on the dev VM (Lima `vz`, 8 vCPUs, 14 GiB); the desktop guest from
`target/snapbench/pages.waarm64snap` (Arch Linux ARM, Firefox, 2.5 GiB of RAM, 4 vCPUs, 3D); sessions through
`bench/gpu/ab.sh` with `MEMLOG=10` (`bench/gpu/guest-session.ts`: every 10 s the renderer's smaps by class,
`bench/mem/probe.ts`, and the page's own accounting, `__status.memory`). Data in `bench/boot/results/m8-budget/`.

**A machine's budget** (`VmConfig.jit_bytes`, ABI 44): the page's `?jitmb=`, a stored machine's JIT cache setting
beside its RAM (carried by its shape and definition, outside the shape's hash: the guest doesn't see it, so lowering it
after a crash orphans no snapshot). The page's memory check counts it (`jitHostGiB`: four times the budget past 160
MiB, from the pages session's renderer at 160 and 320 MiB). `?jitmb=` is also how the A/Bs below set their arms
(`bench/gpu/ab.sh` takes `<arm>=<core.wasm>?<query>`).

**What `performance.measureUserAgentSpecificMemory()` counts** (`signal/uasm-j160/`: the churn page at 160 MiB, four
calls over 3 minutes):

| realm (attribution) | MiB | what it is |
|---|---|---|
| 4 × `vcpu-worker.ts` | 14,395 → 14,500 | memory 0's reserved length (3,584 MiB: 2.5 GiB of RAM + the heap reserve) four times, + JS heaps |
| the machine worker (the page's URL) | 3,697-3,703 | memory 0 + its JS heap |
| `device-worker.ts`, `gpu-worker.ts`, `jit-compile-worker.ts` | 3,603-3,604, 3,587-3,595, 3,585-3,586 | memory 0 each |
| `Window` (the page) | 8 | it holds no memory |
| total | 28,883-28,992 | the renderer meanwhile: 3,231-4,819 MiB |

So the user's 41.9 GB is the shared memory charged at its whole length once per realm that holds it (a bigger guest
or more vCPUs), not memory used. All of it is typed `JavaScript`. Between the first and the third call V8's wasm code
grew 209 → 910 MiB and the rest of the renderer's anonymous memory 1,052 → 1,454 MiB, through two flushes, while the
per-realm totals moved by 105 MiB in all: **V8's wasm code and its C++ metadata aren't counted**, only JS heaps. Each
call took 50-60 s (also with `--enable-blink-features=ForceEagerMeasureMemory`). Not usable as a signal.

**The self-accounting estimate against smaps** (`signal/calibration.json`, `bench/mem/calibrate.ts`: the page's
`Signal` over the fixed-320 MiB sessions of the next section, `signal/calib/`):

| session | samples | estimate over the renderer: median (min, max) | V8 code per live wasm byte | other anon per byte | wasm memories resident | renderer max / estimate max (MiB) |
|---|---|---|---|---|---|---|
| pages | 36 | +12.0% (+8.9, +32) | 3.90 | 2.83 | 0.76 | 5,296 / 5,776 |
| pages, again | 36 | +13.6% (+10.8, +30) | 3.94 | 2.77 | 0.74 | 5,208 / 5,772 |
| churn | 21 | +17.5% (+14.5, +42) | 3.95 | 2.21 | 0.74 | 5,100 / 6,771 |
| churn, `hot=1500` | 23 | +18.5% (−30.6, +56) | 3.93 | 2.07 | 0.73 | 8,571 / 6,784 |

- **V8's code is 3.9-4.0 × the live wasm bytes** in every session (smaps' executable anonymous mappings); the rest
  of the anonymous memory grows 2.1-2.8 × them, modules included (the estimate: 1.7 × + 16 KB a module).
- **The wasm memories are 73-76% resident**: from a snapshot the guest hasn't touched all its RAM, and the core's heap
  mark (`heap_stats`, ~510 MiB on the 4-vCPU page) counts reserved, unwritten capacity. Counting RAM whole is the
  estimate's 12-19% over; counting touched pages would take the core marking them at every TLB fill and device
  write, for a figure a long session reaches anyway.
- **Under the spikes:** a flushed epoch's code is freed only when V8's GC collects it; counting it for 30 s after the
  flush (`Signal`) still left one 10 s sample of the hot churn 1.8 GB above the estimate (8.6 GB).
- The virgl resources aren't the renderer's (textures in the GPU process, backing in guest RAM; the shared transfer
  mappings 37-45 MiB).

**Built on it:** the status carries `Vm.hostUse` (RAM, the heap, the JIT's gauge: `vm_jit_gauge` and `heap_stats`,
ABI 45); a running machine keeps a mark in `localStorage`, renewed every 10 s and cleared at a clean stop; a stale
mark at the next start means the tab went away with it running, and the page offers a smaller JIT cache or less RAM;
past `navigator.deviceMemory` the machine worker caps the JIT cache at what it holds (the gauge's limit word).

**An adaptive budget, measured and not kept** (the code: `m8-budget/adaptive.patch`, against the JIT of the per-machine
budget's commit; `VmConfig.jit_start` and `?jitstart=MiB` chose the start). The budget started at 160 MiB and could
reach the machine's (320). From 7/8 of it a probe ran: the dispatchers marked each slot they entered (one shared
`AtomicU32` per slot, stored once a sweep; outside a probe a branch per dispatch). When the live modules reached the
budget, it grew by half if the marked code (the marked slots' share of their modules' bytes, and the loop regions of
marked heads) was more than half of it; otherwise it flushed, and after two flushes in a row with under a quarter in
use it shrank by a third, not below the start. The host's limit capped the growth. Unit-tested, with planted bugs
(the growth and shrink thresholds) caught; a core with the dispatchers' marking taken out never grew (`screen/scr3-plant-1`:
4 flushes, 825 MB compiled, the churn done in 182 s against 151).

The screens (`screen/`, the churn page `rate=60&total=4000`, one session each; `hot=1500` calls the last 1,500
functions made again every frame, a reused hot set):

| churn | arm | flushes | wasm MB | Gsteps interpreted | done in (s) | renderer median / max (MiB) |
|---|---|---|---|---|---|---|
| `hot=1500` | 160 MiB | 3 | 625 | 4.23 | 157.5 | 4,229 / 5,009 |
| | 320 MiB | 2 | 694 | 3.23 | 151.2 | 4,907 / 5,462 |
| | 320 MiB (A/A) | 2 | 697 | 3.38 | 151.0 | 4,893 / 5,433 |
| | adaptive, first form | 2 | 692 | 3.04 | 150.5 | 4,561 / 5,201 |
| none | 160 MiB | 2 | 489 | 3.60 | 139.1 | 4,118 / 4,847 |
| | 320 MiB | 1 | 546 | 2.84 | 138.8 | 4,698 / 5,216 |
| | adaptive, first form | 1 | 546 | 2.81 | 139.2 | 4,810 / 5,363 |
| | adaptive, no link closure | 2 | 600 | 2.55 | 138.8 | 4,461 / — |

- **The first form counted what the marked code links to directly, transitively**: static links reach code that
  doesn't run, and the churn alone (functions that run once) grew it to 320 MiB. Without the closure Firefox's own code
  in use still exceeds 80 MiB at the first fill (both churns grew 160 → 240 and stayed there).
- **The timed pages session** (`timed/`, two pairs alternating, base = the same core with a fixed 320 MiB budget and
  no marking): the adaptive core grew 160 → 240 → 320 MiB without a flush, as base compiled the same ~258 MiB (270 MB
  in all, no flush either way), but ran **busy MIPS 140-141 against 149-153** and loaded bbc in 19.7 s against 16.7.
  Not the probe: dropping its clearing of every jump and transfer cache (which made code entered from compiled code
  come back through a dispatcher) left 141 (`pages3-noclear-1`; it grew at the same points). **The cause was the
  tier-ups:** a loop head that got hot while the live modules were over the budget, between the fill and the next
  module's growth, was refused its region for good (a tier-up can neither flush nor grow, and a refused head stays
  alone until a flush). With the tier-up's room at the cap: busy MIPS 151-152 against base's 139-147, the heavy pages
  even (wiki 17.8-18.9 s against 18.2-19.4, bbc 17.1-18.1 against 17.2-20.2), the renderer the same (median 4,964-4,995
  MiB against 5,040-5,075).
- **That form on the churn** (`timed/churn*`, one pair each): with `hot=1500` done in 158.3 s against 151.6 (+4%; both
  2 flushes, its median renderer 4,648 against 4,833 MiB), without it 139.1 against 139.1 (2 flushes against 1;
  4,583 against 4,773 MiB). The gates (`gates/`, `smp_alpine_jit` and `smp_user_jit_4`, three rounds alternating) even:
  −0.4 to +0.4% (neither fills 160 MiB).

**Why it wasn't kept:** the renderer pays for the code compiled, not for the budget, so a smaller budget saves memory
only by flushing, and flushing is the cost the budget is there to avoid. Where Firefox fills the cache the adaptive
budget grew to 320 and cost the same memory as the fixed one; where it held a budget below 320 it saved 4% of the
renderer's median (~190 MiB of ~4.8 GiB) for an extra flush, and on the reused hot set ran 4% slower. Not "clearly
less memory where the hot set is small" at "320's speed where it is large". The fixed 320 MiB budget stays the
default, with a machine's own (the JIT cache setting) for a device that needs less, and the memory signal's limit
for one that runs short.

## M8: emitting outside the JIT cache's lock (2026-10-20)

Headless Chromium 153.0.8010.52 on the dev VM (Lima `vz`, 8 vCPUs, 14 GiB); the desktop guest from
`target/snapbench/pages.waarm64snap` (Arch Linux ARM, Firefox, 2.5 GiB of RAM, 4 vCPUs, the default 320 MiB budget);
sessions through `bench/gpu/ab.sh`, one per arm with an A/A copy of the base. Data in `bench/boot/results/m8-emit/`
(`churn1/`, `pages1/`: each arm's `results.json`, `counts.json`, `stalls.json`, `rss.txt`, and `summary.json`, the
`ab-summary` of the run). The patch is `outside-lock.patch` there.

**The lock, counted** (counter words 108–113, ABI 46; `ab-summary`'s `locks`, `contended`, `waitMs`, `emitMs`,
`lockedMs`, `planMs`): every vCPU takes the cache's one lock at each jump-cache miss, each decoded block's report
(every 16 dispatches), each catch-up after a flush or an IC, and each tier-up; the vCPU that makes a batch due forms
it and emits its module under it.

| | pages session (base · copy) | churn screen, `rate=60&total=4000` (base · copy) |
|---|---|---|
| acquisitions | 86.9 M · 86.8 M | 66.1 M · 66.1 M |
| found it held | 5.1% · 5.0% | 3.6% · 3.6% |
| vCPU time waiting | 25.4 · 24.5 s | 37.6 · 41.2 s |
| emitting (all under the lock) | 3.6 · 3.6 s | 7.7 · 7.8 s |
| forming batches (under it) | 1.0 · 1.0 s | 2.1 · 2.1 s |
| modules | 6,735 · 6,748 | 33,035 · 32,888 |

Of ~1,450 vCPU-seconds in the pages session the waiting is ~1.7%, of ~800 in the churn ~4.7%; emission is under 1%
of either. Most of the waiting is the acquisitions' number (~230,000 a second), not what is held.

**Emitting outside it** (commit 1e628b8's design for the replay, ported to batches and tier-ups): under the lock a
batch or a tier-up is formed and taken (its slots, a held place in the log, its module number, the epoch, the
`ival_log` position, pinned, and the imports its regions' successors resolve to; its heads marked taken so no batch
takes them again), emitted without it, and committed under it unless the epoch moved, an IC named one of its pages or
an import moved, in which case the whole module goes, its place stays empty and its number reaches the compile worker
as no bytes. Tables install up to the first held place; a head whose tier-up another table is emitting counts 64
entries again. Unit tests for the take and for each discard rule (a planted bug in each failed them); the Node JIT
tests, the boots' exact steps, the parallel boots and the compile worker's tests passed.

| | base · copy | outside the lock |
|---|---|---|
| churn: vCPU time waiting | 37.6 · 41.2 s | 25.9 s |
| churn: busy MIPS | 191 · 187 | 192 |
| churn: `doneS` | 132.3 · 132.7 | 132.5 |
| churn: stalls ≥ 20 ms | 0 · 3 | 0 |
| churn: discarded | | 13 of 32,826 |
| pages: vCPU time waiting | 25.4 · 24.5 s | 19.2 s |
| pages: busy MIPS | 154 · 154 | 155 |
| pages: wiki / bbc load | 17.5 · 17.5 / 16.7 · 16.0 s | 18.0 / 16.5 s |
| pages: stalls ≥ 20 ms | 0 · 4 | 0 |
| pages: discarded | | 2 of 6,755 |

The waiting fell by a third on the churn and a fifth on the pages, and nothing a user would see moved: what it freed
is ~1% of the vCPUs' time at most. **Not kept**; the counters are. **Emitting in the compile worker** would take the
rest of emission off the vCPUs, at most the same ~1%, so it wasn't built. What would cut the waiting is fewer
acquisitions (docs/backlog.md).

## M8: tier-ups folded into the batches (2026-10-20)

The same host, guest and harness as the section above; data in `bench/boot/results/m8-emit/` (`count-*/`, `fold*/`,
`go/`, `gates/`; `hist.jsonl` from `hist.ts`, the counting build is `count.patch`).

**Counted first** (a build that buckets each module by its regions and what emitted it): the modules are the
tier-ups'. A loop head compiled alone that gets hot compiled its region at once, in a module with whatever batch was
pending.

| | modules | regions a module | 1-8 regions | tier-up modules (the region alone) | batches by `BATCH_STEPS` / full / timeout |
|---|---|---|---|---|---|
| pages session | 6,802 | 30.6 | 47% | 5,656 (1,542) | 1,001 / 70 / 75 |
| churn screen | 33,013 | 15.5 | 54% | 17,744 (8,049) | 15,195 / 65 / 9 |

**The fold:** `jit_hot` queues the head's loop region for the next batch instead (`Cache::tierq`), adds
`TIER_STEPS` to the batch's steps and makes the head's word count 64 entries again, in each table that sees it hot,
so a loop that keeps running brings the batch due after `BATCH_STEPS / TIER_STEPS` times hot and lukewarm loops go
with what's pending. `jit_hot` emits the batch it made due if it fits without a flush, else the dispatcher's next
miss does. Batch-1 modes (JIT-stress, JIT-check, forced) tier up at once as before.

Screened on the churn, one session per arm (`fold-churn/`, `fold2-churn/`): the first form (`TIER_STEPS` 6,250 and
1,562: 8 or 32 times hot) cut modules 33,050 → 26,500 and 23,800 but compiled 6% and 11% more wasm (583, 610 MB
against 549): while a head waited, its loop's other blocks (heads alone too) got hot and queued their own regions of
the same loop. With a queued head quieted once an earlier region of the batch covers it (`Info::covered`): 1,562
made 23,031 modules of 531 MB against 32,881 of 546, tier-up regions 17,606 → 7,870, the renderer's median 4,661
against 4,805 MiB (the base's sessions this evening 4,692-4,805), busy MIPS 188 against 193 (187-193), `doneS` 132.6
against 132.6; 6,250 made 25,429. Kept 1,562.

**Timed** (one session each, an A/A in the pages run):

| | base · copy | folded |
|---|---|---|
| pages: modules | 6,731 · 6,767 | 2,778 (75 regions each, 11% with 1-8) |
| pages: wasm | 270 · 270 MB | 268 MB |
| pages: V8's wasm code (median / max) | 927 · 921 / 1,001 · 1,068 MiB | 870 / 985 MiB |
| pages: renderer RSS (median / max) | 4,987 · 5,006 / 5,273 · 5,282 MiB | 4,947 / 5,201 MiB |
| pages: busy MIPS | 152 · 155 | 158 |
| pages: wiki / bbc load | 17.8 · 17.7 / 16.6 · 16.0 s | 16.8 / 15.6 s |
| pages: stalls ≥ 20 ms | 0 · 2 | 0 |
| `go build` loop, 300 s from `debian-go.waarm64snap`: MIPS over the run | 1,110 | 1,141 |
| `go build` loop: the renderer (median of the 30 s samples) | 3,229 MiB | 2,876 MiB |

The gates (`gates/`, three rounds alternating, ms, lower is better): `smp_alpine_jit` n1 9,432 · 9,403 · 9,514
against 9,347 · 9,422 · 9,306 (−0.9%), n2 −1.4%, n4 −0.6%; `smp_user_jit_4` 18,450 · 18,485 · 19,158 against
18,095 · 18,228 · 18,645 (−1.4%). **Kept:** 59% fewer modules on the pages session, V8's code 6% smaller there,
everything timed even or a little faster.

## M8: fewer acquisitions of the JIT cache's lock (2026-10-21)

Headless Chromium 153.0.8010.52 on the dev VM (Lima `vz`, 8 vCPUs, 14 GiB); the desktop guest from
`target/snapbench/pages.waarm64snap` (made again for this lane: Arch Linux ARM, Firefox, 2.5 GiB, 4 vCPUs, 320 MiB);
sessions through `bench/gpu/ab.sh`, one per arm. Data in `bench/boot/results/m8-lock/`: `count/` (the counting
build on both workloads), `screen1/`–`screen4/` (the churn screen, `rate=60&total=4000`), `pages/` (the timed pages
session), `go/` and `go2/` (the `go build` loop from `debian-go.waarm64snap`, 300 s, one session per arm each),
`gates/`; each run's `summary.json` from `ab-summary --json`. `screen.patch` is the screening build: the change
behind switches (`KNOWN`, `KNOWN_Q0`, `RETAIN`, `EMPTY_KEPT`, `LONG`) and per-caller counters (`Stats::lk`, published
as counter words 114 on by a host change not in the patch; `tools/lockby.ts` prints them from `results.json`).

**Counted per caller** (each acquisition attributed once taken; "back in its slot" overlaps the others: a block whose
decoded slot had gone to another key came back with no quota and reported at once):

| | pages session | churn screen |
|---|---|---|
| acquisitions, found held, waited | 86.3 M, 4.7%, 25.2 s | 64.3 M, 3.3%, 38.2 s |
| new to the table (and every key with no instructions) | 15.5%, 3.5 s | 8.0%, 3.2 s |
| a decoded block's report | 47.8%, 9.6 s | 46.7%, 10.0 s |
| the report of a block queued in the batch | 1.4%, 0.2 s | 16.7%, 1.3 s |
| a compiled block out of the jump cache | 33.0%, 10.2 s | 15.9%, 18.6 s |
| compiled, not installed in the table yet | 0.1%, 0.2 s | 8.7%, 2.1 s |
| catch-ups, tier-ups, ICs, flushes | 2.2%, 1.5 s | 3.9%, 3.1 s |
| (of all: a block back in its decoded slot) | 62.5%, 16.1 s | 33.4%, 23.5 s |

So most acquisitions asked the cache what the table had already been told: the decoded cache's 16,384 direct-mapped
slots put a block that lost its slot back with no quota, and a compiled block that lost its jump-cache entry went
back to the cache's map (and ran interpreted for its 16-dispatch quota first).

**The change** (all table-local, no new shared state): a table keeps every key the cache answered compiled for it
this epoch and that it has installed (`Table::known`, dropped at a catch-up with the jump cache's entries, cleared
with it at a new epoch), and answers a miss for one without the lock; such a block's decoded copy gets no quota, so
it comes back to the miss instead of being interpreted. The decoded cache keeps a block's quota with its count when
it loses its slot, and a block out of its slot counts on (`count_out`). A key with no instructions is kept in the
decoded cache with length 0 and answered without the lock. (A first build let such a key take a quota and ran its
block of no instructions forever, which hung the guest in both sessions of that arm; it never takes one now, and a
unit test fails the planted bug.)

Screened on the churn (one session per arm; `none` is the counting build with every switch off):

| | none · none2 | known | retain | all three | and compiled blocks with no quota (A/A) | that, with longer reports |
|---|---|---|---|---|---|---|
| acquisitions | 65.2 · 65.1 M | 54.7 M | 41.9 M | 40.8 M | 38.6 · 38.8 · 39.1 M | 31.6 M |
| found held | 3.4 · 3.4% | 2.6% | 1.7% | 1.2% | 1.4 · 1.1 · 1.1% | 1.3% |
| waiting | 37.5 · 39.4 s | 27.9 s | 27.6 s | 16.9 s | 15.5 · 15.4 · 15.5 s | 14.0 s |
| busy MIPS | 190 · 192 | 195 | 205 | 208 | 220 · 221 · 222 | 228 |
| `doneS` | 133.0 · 132.6 | 126.7 | 126.4 | 126.7 | 120.3 · 120.3 · 120.6 | 120.5 |
| Gsteps interpreted | 2.78 · 2.78 | 2.78 | 3.01 | 3.13 | 2.82 · 2.82 · 2.85 | 2.86 |

(`known` and `retain` are from `screen1/`, whose A/A pair read 63.7 · 65.1 M, 40.4 · 42.6 s, 187 · 183 MIPS; the rest
from `screen3/` and `screen4/`; the keys with no instructions were 1% of the churn's acquisitions, `screen2/`.)
Retaining quotas alone ran more interpreted (compiled blocks out of the jump cache kept running their quota in the
block interpreter); taking the quota from a compiled block fixed that. **Longer reports** (past `warm`, a table
counts its share of what's left to the threshold, 16 to 255, before it reports) took 19% fewer acquisitions and
moved nothing beyond noise: not kept (docs/jit.md "Tried and not kept").

**Timed** (the kept build, without the switches or counters, against main's core):

| | base · base2 | kept |
|---|---|---|
| pages: acquisitions | 84.2 · 86.5 M | 21.9 M |
| pages: found held | 4.9 · 5.0% | 2.4% |
| pages: waiting | 21.8 · 24.5 s | 9.7 s |
| pages: busy MIPS | 158 · 157 | 169 |
| pages: wiki / bbc load | 19.7 · 17.7 / 17.2 · 16.7 s | 15.4 / 14.8 s |
| pages: stalls ≥ 20 / 50 ms | 0 · 1 / 0 · 0 | 1 / 0 |
| pages: modules, wasm | 2,816 · 2,769, 266 · 268 MB | 2,806, 270 MB |
| pages: renderer RSS median / max | 4,844 · 4,896 / 5,158 · 5,133 MiB | 4,909 / 5,127 MiB |
| `go build` loop: MIPS median (two sessions) | 1,296, 1,176 | 1,239, 1,261 |

The gates (`gates/`, three rounds alternating, ms, lower is better): `smp_alpine_jit` n1 9,189 · 9,167 · 9,321
against 9,083 · 9,172 · 9,069 (−1.1%), n2 −2.7%, n4 −2.9%; `smp_user_jit_4` 17,964 · 18,302 · 18,419 against
17,328 · 17,294 · 17,394 (−5.3%). **Kept:** a quarter of the acquisitions on the pages session and three fifths on
the churn, the waiting less than half, busy MIPS +7% and +15%, nothing slower.

## M8: the core's heap bounded (2026-10-21)

**The crash** (the user, at 2460115): the desktop guest, 4 vCPUs, 2.5 GiB, the default 320 MiB JIT budget, after
15 minutes and one flush (Firefox with WebGL, news sites and YouTube, then closed; Chromium in the guest loading
YouTube): `RuntimeError: unreachable` at `rust_oom` < `RawTable<jit::Info>::reserve_rehash` < `Jit::miss`, and no
message. The JIT's block map (`Cache::map`) held every key dispatched since the last flush, compiled or not: at 41 B
a bucket, its doubling from 2^22 buckets needed 328 MiB free beside the old 164 MiB table. Flushes are rare at 320
MiB, so a session's keys accumulated (JavaScript engines' code, run a few times at addresses later reused).

**Reproduced** (`m8-heap/probe.json`, `tests/heap.test.ts`): a guest of nothing but `b .+4`, every word a block
run once, in Node. The old core holds ~127 B a block (1.5M blocks: 190 MiB live); 8M blocks trap it in a 1 GiB heap,
and in a 320 MiB one it traps after 590 ms, first in the decoded blocks' map (`interp::block::Cache`, a key per
micro-op: it too was bounded only by its arena's micro-ops). The fixed core runs the 8M blocks in a 320 MiB heap with
a mark of 131 MiB (5 prunes), and in 96, 64 and 24 MiB heaps through the safety net (17, 25 and 110 rescues), where
the old one traps. Natively, `jit::tests::the_block_map_stays_bounded` (3.2M keys with ICs) saw the old map's table
reach 7.3M keys' capacity (2^23 buckets).

**The fix** (docs/jit.md "The core's heap"): the block map prunes at 1.5 M keys (or when tombstones would double its table) to the needed
keys, the recent ones and the warm ones (below), so its table stays at 2^21 buckets; `Info` 32 → 16 bytes (the stale
checker's hash moved to `spans`, `hits` u16, `len` u8): 25 B a bucket; the decoded blocks' map starts over at 900,000
keys or a key per 4 micro-ops; module bytes held for tables that haven't taken them are capped at 64 MiB (a lagging
table flushes); `try_reserve` before those maps grow, which flushes and frees them on failure; an allocation that
fails records a message. ABI 47 exposes the block map's keys and bytes, the held bytes and each table's decoded and
known bytes.

**A long session** (`m8-heap/long/`: Firefox's pages session then 10 minutes of the churn screen, from the warm
`pages` snapshot, one session each, `MEMLOG=5`; `unbounded` is the same core with the bounds off; MiB):

| | heap live max | mark | decoded blocks | block map max | known | held max | keys max | prunes | flushes |
|---|---|---|---|---|---|---|---|---|---|
| bounded | 485 | 507 | 366 | 62 | 11 | 4 | 1.49 M | 2 | 5 |
| unbounded | 523 | 568 | 365 | 116 | 9 | 10 | 1.93 M | 0 | 6 |

At the highest sample the bounded core's heap was 363 decoded blocks, 62 block map, 9 known, 51 the rest (devices,
jump caches and hot words, stacks); the unbounded one's 349, 116, 9, 50. The pages session reached 1.5 M keys at
212 s (prunes at 212 and 361 s, ~650 K kept); the churn's flushes (every ~2 minutes: the byte budget) emptied the map
after that, so neither session got near the crash's 3.7 M keys. Unbounded, the table had doubled to 2^22 buckets by
1.6 M keys. In the pages part (one session each): busy MIPS 196 against 194, wiki and bbc loads 11.5 and 12.3 s
against 11.9 and 12.1, no stalls ≥ 50 ms. Both sessions ended with the harness's 30 s wait after the churn timing out
(the same in both; the measurements before it are complete).

**The crash's path, reproduced** (`m8-heap/once/`): a run-once churn, `CHURN='rate=300&calls=120&n=2'` for 10 minutes
from the same snapshot (functions compiled by SpiderMonkey's Baseline and run a few dozen times: new guest code that
our JIT never compiles, so the byte budget never fills and nothing flushes). Unbounded, the map grew to 3.2 M keys in
12 minutes with no flush (the table at 2^22 buckets, 226 MiB with its page index; heap 633 MiB live, mark 725): the
crash's state, short of the next doubling, which at the old 41 B a bucket needed 344 MiB more. Bounded: 1.49 M keys
at most, 5 prunes (each back to 80-120 K keys after the first), heap 508 MiB live at most, mark 557.

**A bug found there:** one sample of the bounded session had the table at 2^22 buckets with 1.49 M keys. The first
build counted the keys an IC removed toward the bound (their tombstones fill the table) and reset the count when
`HashMap::capacity` changed, taken as a rebuild; but `capacity` is the keys plus the room left, and drops with each
tombstone, so the count kept resetting. Now a prune also happens when the full table would double past the size that
holds `MAP_KEYS` (`jit::grows_past`), and the same for the decoded blocks' map; two unit tests (IC churn at 1.4 M keys
live, and at 1,700 of 1,792 in a decoded map) fail without it (3.67 M and 3,584 keys' capacity). The churn screens
below ran the first build, the pages sessions the later ones.

**Cost** (A/A screens: the bounded core twice, `fix`·`fix2`, against the same core unbounded; one session each):

| | churn screen (`rate=60&total=4000`): `doneS` | busy MIPS | run-once screen (`…&total=30000`): `doneS` | busy MIPS | prunes |
|---|---|---|---|---|---|
| fix · fix2 | 108.2 · 108.5 | 244 · 241 | 150.0 · 156.8 | 211 · 200 | 2 · 2 |
| unbounded | 114.7 | 232 | 149.9 | 209 | 0 |

The standard screen flushes 53 s in and never prunes; the run-once one prunes twice, within the A/A's spread. A prune
of 1.5 M keys takes 6-11 ms natively (release build; under the cache's lock).

**The pages session** (from the snapshot, no flush; it prunes once, at 221-231 s, in the bbc page's load; s, MIPS):

| | busy MIPS | wiki load | bbc load | keys max |
|---|---|---|---|---|
| unbounded (5 sessions: `pages-warm1/`, `pages-warm2/`, `pages-recent/`) | 196 · 194 · 196 · 189 · 194 | 11.2 · 11.5 · 11.4 · 11.8 · 10.7 | 12.1 · 12.7 · 12.2 · 13.2 · 11.7 | 1.63 M |
| keeping the warm keys only (4: `fix`, `fix2` and two rounds) | 193 · 186 · 198 · 195 | 11.1 · 11.7 · 11.1 · 10.9 | 13.2 · 13.6 · 12.8 · 12.3 | 1.35 M |
| and the recent ones (kept, `pages-recent/`) | 197 · 199 | 10.8 · 11.6 | 11.8 · 11.9 | 1.21 M |

Keeping only the warm keys (counted 16 times) made the bbc load ~0.8 s slower (median 13.0 against 12.2): the page's
code, reported a few times, counted from zero again, and each key coming back was formed again under the lock. A
prune now also keeps every key reported in the last 262,144 keys added to the map (its clock, `Cache::tick`, a byte
in `Info`'s spare room): bbc 11.8 and 11.9, busy MIPS 197 and 199. **Kept:** the heap bounded at no measured cost.

## M8: a miss doesn't wait for the JIT cache's lock, and 2 KiB instruction cache lines (2026-10-21)

Headless Chromium 153.0.8010.52 on the dev VM (Lima `vz`, 8 vCPUs, 14 GiB), on main at 3295fbf (the core's heap
bounded). Four cores, all ABI 48:
- **base:** this lane's tree with the `try_lock` turned off (`strong_count > usize::MAX`). That is main's blocking
  miss with the new counter word; main's own ABI 47 core won't load under this host.
- **base2:** a copy of base, the A/A.
- **lock2:** a miss that finds the lock held runs its block interpreted (docs/jit.md "Sharing" "A miss doesn't wait
  for it").
- **imin:** lock2 with `CTR_EL0.IminLine` 9, 2 KiB lines. This one is guest-visible.

Data in `bench/boot/results/m8-lock2/`; `tools/run.sh` ran them all:
- `churn/` and `pages/`: `bench/gpu/ab.sh` from `target/snapbench/pages.waarm64snap`, one session per arm, with
  `summary.json` from `ab-summary --json`.
- `go/`: the `go build` loop, 300 s from `debian-go.waarm64snap`, two sessions per arm, with `summary.jsonl` from
  `tools/gosum.ts`.
- `boot/`: Debian's boot and login on 4 vCPUs from cold (`bench/stress/stress.ts`), the counts at the login.
- `gates/`.

**The churn screen** (`rate=60&total=4000`):

| | base · base2 | lock2 | imin |
|---|---|---|---|
| waiting for the lock | 10.1 · 9.9 s | 3.4 s | 2.9 s |
| found it held | 1.34 · 1.44% | 0.49% | 0.30% |
| misses that didn't wait | – | 3.23 M | 3.09 M |
| `doneS` | 114.0 · 107.9 | 108.0 | 108.2 |
| busy MIPS | 240 · 252 | 254 | 256 |
| Gsteps interpreted | 5.33 · 5.27 | 5.36 | 5.41 |
| ICs | 1.064 · 1.072 M | 1.071 M | 0.713 M |
| DSB waits; platform lock | 373 · 412 ms; 1,171 · 1,106 ms | 397 ms; 1,392 ms | 495 ms; 1,098 ms |
| stalls ≥ 20 / 50 ms | 1 · 2 / 0 · 0 | 2 / 0 | 1 / 0 |

**The pages session:**

| | base · base2 | lock2 | imin |
|---|---|---|---|
| waiting for the lock | 7.0 · 6.9 s | 2.2 s | 1.8 s |
| found it held | 3.1 · 3.0% | 1.1% | 0.7% |
| misses that didn't wait | – | 2.41 M | 2.43 M |
| busy MIPS | 197 · 189 | 195 | 194 |
| wiki / bbc load | 11.0 · 11.5 / 12.3 · 13.1 s | 11.3 / 11.9 s | 11.2 / 12.3 s |
| Gsteps interpreted | 3.36 · 3.32 | 3.36 | 3.35 |
| modules | 2,932 · 2,923 | 2,938 | 2,923 |
| ICs | 817 · 828 k | 814 k | 512 k |
| DSB waits; platform lock | 1,745 · 1,783 ms; 2,106 · 2,264 ms | 1,728 ms; 2,105 ms | 1,764 ms; 2,163 ms |
| stalls ≥ 20 / 50 ms | 2 · 4 / 0 · 0 | 3 / 0 | 3 / 0 |
| renderer RSS max | 4,166 · 4,211 MiB | 4,136 MiB | 4,114 MiB |

**The `go build` loop** (MIPS per 5 s sample, median of each session). Lane 13 found this loop's spread at one
setting to be 1,094–1,489 MIPS, so its MIPS can't rank differences this small:

| | base | lock2 | imin |
|---|---|---|---|
| MIPS (two sessions) | 1,330, 1,493 | 1,396, 1,395 | 1,421, 1,326 |
| waiting for the lock | 4.1, 4.2 s | 0.54, 0.55 s | 0.38, 0.39 s |
| acquisitions | 4.66, 4.70 M | 4.71, 4.70 M | 4.13, 4.10 M |
| ICs | 286,400 | 286,400 | 8,950 |
| DSB waits | 4.6, 4.4 s | 4.8, 4.9 s | 4.9, 4.7 s |

**Debian's boot to the login** (~35 s, one run per arm):

| | base | lock2 | imin |
|---|---|---|---|
| ICs | 2,124,307 | 2,124,300 | 121,781 |
| lock acquisitions | 6.65 M | 6.67 M | 2.51 M |
| waiting for the lock | 1.41 s | 0.54 s | 0.12 s |

**The gates** (three rounds alternating, ms; each arm's median of rounds against base):

| | base | lock2 | imin |
|---|---|---|---|
| `smp_alpine_jit` n1 | 8,102 · 8,230 · 8,102 | 8,252 · 8,264 · 8,250 (+1.8%) | 8,120 · 8,197 · 8,027 (+0.2%) |
| n2 | 7,567 · 7,709 · 7,565 | 7,674 · 7,705 · 7,672 (+1.4%) | 7,561 · 7,620 · 7,489 (−0.1%) |
| n4 | 7,587 · 7,686 · 7,600 | 7,687 · 7,669 · 7,671 (+0.9%) | 7,542 · 7,582 · 7,467 (−0.8%) |
| `smp_user_jit_4` | 15,840 · 16,007 · 16,035 | 16,046 · 15,962 · 16,146 (+0.2%) | 15,952 · 16,019 · 15,844 (−0.3%) |

lock2 is 1–2% slower on `smp_alpine_jit` at n1 too, where one vCPU has one table and takes the lock exactly as
base does. imin runs the same code with one constant changed and is even. So the difference comes from the build
(code placement), not from the no-wait miss. It's under the 5% the rules call noise, but it held in all three rounds,
so it's noted here.

**Both are kept.**
- **The no-wait miss:**
  - The waiting fell by about 70% on every workload: pages 7.0 · 6.9 → 2.2 s, churn 10.1 · 9.9 → 3.4 s, the
    `go build` loop 4.1 · 4.2 → 0.5 s, Debian's boot 1.41 → 0.54 s. Instead, 2–3 M misses ran interpreted.
  - `interpG`, `doneS`, busy MIPS, the pages' loads and the stalls stayed within the A/A. The DSB waits and the
    platform lock didn't move.
  - A first run of the churn and pages sessions, on main before the heap's bound, read the same: waiting 9.9 · 10.7
    → 3.5 s and 6.9 → 2.1 s.
- **2 KiB lines:**
  - Debian's boot issues 1/17 of the ICs and 38% of the acquisitions. The `go build` loop issues 1/32 of the ICs
    (the kernel syncing each executable page).
  - The snapshot sessions issue only a third fewer. Firefox read CTR_EL0 when it started, before the snapshot was
    saved, and keeps stepping by 64 bytes; content processes started afterwards read 2 KiB.
  - Nothing got slower.

**Steps:**
- Every count in `tests/steps.txt` moved, once, in the IminLine commit: Linux's IC loops step by the line now.
- The USB guest's unplug and replug moved from steps 80M and 100M to 95M and 115M. With 2 KiB lines its first
  `testusb` pass ran past 80M, so the unplug fell in pass 1 and pass 2 never saw it.
- kvm-unit-tests' `cache` test passes; it reads CTR_EL0 and checks code it patches. Nothing in the golden corpus
  reads CTR_EL0.

## M8: exits finished in place, and a cheaper run-loop round trip (2026-10-22)

From the image-decoding investigation on the desktop guest (`bench/imgdecode/README.md` "On the desktop guest"): a
vDSO `clock_gettime` cost 660 ns in the guest (13.5 natively) because `mrs cntvct_el0` left compiled code for the run
loop (~380 ns) and its `isb` did too (~230 ns); Firefox showing images makes ~12K counter reads and ~37K such resyncs
(ISB, DSB, ERET, DAIF writes) a second. Three changes, docs/jit.md "Fast completions" and "What an exit to the run
loop costs": the JIT's helpers finish counter reads and resyncs with nothing to do in place (`jit::State::fast`), the
JIT's counter words are published every 64K steps, and the timers are checked against the host clock every 4096
steps or when their registers change (and before any platform access that shows them).

In the guest, per iteration (`target/imgpipe/clk`, a static binary; the dev VM): `clock_gettime` 660 → 250 ns,
`isb; mrs cntvct_el0` 613 → 195, `mrs cntvct_el0` 382 → 175, an always-exiting `mrs cntfrq_el0` 413 → 240.

**A/B** (the dev VM, Chromium 153.0.8010.52; A = `432cf45`, B = this change; one session, A B B A A B, three rounds
a side; `bench/run.ts --page bench/boot/index.html --only <bench>`; JSON and the script in `results/m8-fast/`).
Medians of each round:

| ms | A | B | B/A |
|---|---|---|---|
| `smp_alpine_jit_n1_total` | 7,927 · 7,951 · 7,935 | 7,669 · 7,728 · 7,772 | 0.974 |
| `smp_alpine_jit_n2_total` | 7,385 · 7,394 · 7,429 | 7,180 · 7,215 · 7,295 | 0.976 |
| `smp_alpine_jit_n4_total` | 7,356 · 7,383 · 7,383 | 7,200 · 7,235 · 7,297 | 0.980 |
| `smp_user_jit_n4_total` | 15,827 · 15,777 · 15,817 | 15,284 · 15,406 · 15,445 | 0.974 |
| of it: churn | 1,797 · 1,855 · 1,829 | 1,760 · 1,767 · 1,741 | 0.962 |
| SQLite | 2,399 · 2,144 · 2,268 | 2,084 · 2,121 · 2,146 | 0.935 |
| Lua | 2,886 · 2,930 · 2,966 | 2,868 · 2,922 · 2,908 | 0.992 |
| compress | 1,662 · 1,634 · 1,651 | 1,682 · 1,666 · 1,667 | 1.010 |

Every total 2.0-2.6% faster with the arms' rounds apart; compress 1.0% slower with its rounds apart too (at the noise
floor; not looked into).

## M8: counter reads compiled inline (2026-10-22)

The step after "exits finished in place": a block's `mrs cntvct_el0` (or `cntpct_el0`) in parallel SMP calls the host
clock import itself and computes the counter inline (docs/jit.md "Counter reads compiled inline"), where it called the
helper, which ran the instruction through the interpreter and the fast completion into `Vm::now`. In the guest
(`target/imgpipe/clk`, the desktop guest on the dev VM): `mrs cntvct_el0` ~178 → ~115 ns, `isb; mrs cntvct_el0` ~200 →
~135, `clock_gettime` ~250 → ~237 (one run against this report's earlier ones). The host clock call is ~115 ns of
what's left.

**A/B** (the dev VM, Chromium 153.0.8010.52; A = `c4deed6`, B = this change; one session, A B B A A B, three rounds a
side; JSON and the script in `results/m8-clock/`). Medians of each round:

| ms | A | B | B/A |
|---|---|---|---|
| `smp_alpine_jit_n1_total` | 7,596 · 7,581 · 7,677 | 7,618 · 7,640 · 7,569 | 1.003 |
| `smp_alpine_jit_n2_total` | 7,147 · 7,105 · 7,244 | 7,163 · 7,180 · 7,101 | 1.002 |
| `smp_alpine_jit_n4_total` | 7,155 · 7,138 · 7,262 | 7,186 · 7,222 · 7,150 | 1.004 |
| `smp_user_jit_n4_total` | 15,399 · 15,302 · 15,238 | 15,333 · 15,465 · 15,367 | 1.004 |
| of it: SQLite | 2,103 · 2,130 · 2,116 | 2,160 · 2,236 · 2,155 | 1.021 |

Every total within the noise with the rounds overlapping; SQLite 2.1% slower with its rounds apart (the last A/B had
its A rounds spread over 2,144-2,399: not looked into). The modules' size didn't move: 36.6-40.5 KB a module in the
boots and 31.6-32.5 KB in the userspace run on both arms (`counters.jit.bytes` / `modules`): only a module with a
counter read imports the clock, and few blocks have one. Kept for the guest's clock reads, which the benchmarks barely
make.

## M8: the core with exact memory limits (2026-10-22)

The core module declares its memory import 18–65536 pages, so its own code reloads the memory's size after calls
before a checked access, where JIT modules (exact limits since "M8: a fixed-size memory") load it once a function.
Now `bootVm` keeps instance 0, which lays the memory out and grows it, for that alone, and runs everything else on a
copy of the module whose import declares the memory's final size both ways (docs/abi.md "A fixed-size memory"): an
instance on its own thread and every vCPU worker's. A/B: the same build, `?growcore` (`exactCore: false`) for the
growable import, alternated in one session (the dev VM, Chromium 153.0.8010.52; JSON and `ab.sh` in
`results/m8-exactcore/`). Medians of each round's samples:

| ms | exact | growable | |
|---|---|---|---|
| `alpine_user_jit_total` (6 rounds × 3) | 14,609 · 14,845 · 14,619 · 14,808 · 14,885 · 14,790 | 14,862 · 14,936 · 14,735 · 14,890 · 14,851 · 15,079 | −0.5% |
| its compress, Lua, churn, SQLite (rounds 1–3 pooled) | 1956, 3073, 1527, 2305 | 1966, 3098, 1526, 2296 | ±1% |
| `boot_alpine_jit_total` (3 rounds × 5) | 6188 · 6135 · 6262 | 6146 · 6237 · 6159 | +0.3% |
| the same, cold (3 rounds × 3) | 6237 pooled | 6289 pooled | −0.8% |

- **No difference**: the rounds overlap on every row. The exact core won five of six userspace pairs, by 0.2-1.9%;
  that's the noise's size here.
- **Why so little:** the block interpreter's hot function (`interp::block::run::<Mmu>`, TurboFan in Node,
  `--print-wasm-code-function-index`) is 20,208 → 20,074 instructions (−0.7%). In this V8 build loads through a base
  go unchecked and stores are checked (docs/v8.md "Bounds checks"), and the core's code is 8-19% of the hot phases:
  the reloads it drops are a sliver of a sliver. The prune of the block map (hash-table work, tests/heap.test.ts's
  guest in Node) took 19.3-19.5 ms either way.
- **Kept:** no cost measured (the second module compiles while instance 0 lays the memory out; boots no slower), and
  the core's code matches the JIT's assumption that the memory never grows.

**Firefox's pages session**, with the block map's page index of 2 bytes a key (docs/jit.md "The core's heap") in the
same change: old = the core with the index of whole keys (the previous `mod.rs` with the prune's clock added, ABI 50)
on the growable import (`?growcore`), new = this commit's core; `bench/gpu/ab.sh` from `pages.waarm64snap`, `MEMLOG=5`,
three rounds alternating (`results/m8-exactcore/pages/`, `run.sh`). Each session's value:

| | old | new |
|---|---|---|
| busy MIPS | 214 · 216 · 215 | 216 · 215 · 212 |
| wiki / bbc load (s) | 10.9 · 10.7 · 10.2 / 11.2 · 10.3 · 10.9 | 11.1 · 10.8 · 10.7 / 10.8 · 10.7 · 10.8 |
| waiting for the lock (ms) | 1687 · 1418 · 1578 | 1697 · 1666 · 1641 |
| stalls ≥ 20 / 50 ms | 3 · 3 · 1 / 0 | 3 · 2 · 1 / 0 |
| heap live at most, mark (MiB) | 294 · 294 · 294, 313 | 283 · 284 · 283, 307 |
| the block map's keys at most | 1.455 · 1.464 · 1.446 M | 1.451 · 1.446 · 1.451 M |
| the prune (one a session, ms) | 35.1 · 35.4 · 35.2 | 35.2 · 35.3 · 36.4 |

- **No regression:** speed, loads and stalls within each other's spread. The lock waits ~90 ms more on new's median, inside the
  270 ms that old's own three rounds spread over (1418-1687; new's 1641-1697).
- **The heap 11 MiB smaller** live, 6 MiB at its mark. The gauge's block map is 55 MiB on new, exact; old's 62 was its
  estimate of 8 B a key, and the heap's "rest" beside it (26 against 21 MiB) is what the estimate missed: the old
  index's lists took ~5 MiB more than it said, ~12 MiB more than the new one in all.
- **A prune in a 4-vCPU session takes ~35 ms** under the cache's lock (19 ms in tests/heap.test.ts's guest in Node): it
  happens once, in the bbc load, which was no slower for it.

## M9: FEAT_SHA512 and FEAT_SHA3 (2026-10-24)

SHA512H/H2/SU0/SU1 and EOR3, RAX1, XAR, BCAX from the backlog, inline in the JIT (docs/cpu.md, docs/jit.md
"Crypto"), advertised as `VmConfig.features` bit 3 (ABI 51). Chromium 153.0.8010.52 headless, the dev VM
(linux-arm64, 8 vCPUs), one session, medians of each run's 5 samples; the JSON is in `results/m9-sha3/`.

**Other workloads: no change.** The change (B, which the guests see: Linux picks its sha512-ce code) against
origin/main (A, `cb08e58`, its own page and core), alternated: Alpine's boot 3 rounds, its userspace benchmark 6
(rounds 4-6 with B first). ms, each round's median; `results/m9-sha3/ab/`:

| | A | B | |
|---|---|---|---|
| Alpine's boot (total, warm) | 5728 · 5635 · 5634; **5635** | 5602 · 5625 · 5634; **5625** | −0.2% |
| userspace: compress | **1971** | **1973** | +0.1% |
| userspace: lua | **3079** | **3095** | +0.5% |
| userspace: churn | **1376** | **1378** | +0.2% |
| userspace: sqlite | **2299** | **2310** | +0.5% |
| userspace: total | 14115 · 14052 · 14156 · 14037 · 14041 · 13973; **14041** | 14107 · 14112 · 14200 · 13725 · 14114 · 14279; **14112** | +0.5% |

Every row's rounds overlap (B has the userspace total's fastest round and its slowest) and none is past 1%: noise
by docs/benchmarking.md "Rules".

**OpenSSL** (`alpine_crypto_ce_jit` against `alpine_crypto_nosha3_jit`, the crypto phase of `images/alpine/user`
with `sha512` and `sha3-256` added; 3 rounds alternated; MB/s; `results/m9-sha3/openssl/`):

| | without SHA512/SHA3 | with them | |
|---|---|---|---|
| sha512, 256 B | 76.2 · 74.7 · 74.2; **74.7** | 83.1 · 83.2 · 83.4; **83.2** | **+11%** |
| sha512, 16 KiB | 288.7 · 266.6 · 265.9; **266.6** | 303.7 · 300.2 · 299.9; **300.2** | **+13%** |
| sha3-256, 16 KiB | **311.1** | **313.7** | the same code |

AES-GCM, AES-CBC, SHA-1 and SHA-256 moved under 1.1% either way, rounds overlapping. sha512-armv8's scalar path is
already 64-bit integer code, which the JIT runs well; SHA512H's two rounds an instruction are what's left to gain.
**OpenSSL 3.5 doesn't use the SHA-3 instructions on our vCPU**: `crypto/armcap.c` sets its "SHA3 and worth using"
bit (1 << 15, its EOR3/RAX1/XAR/BCAX Keccak) only for Apple M1 and M2 MIDRs, and its EOR3 AES-GCM (1 << 12, 1 << 16)
only for Neoverse V1, V2, N2, Cobalt 100 and Ampere; our MIDR's implementer is 0. Its armcap on our vCPU is 0x9fd
(SHA512, SHA3 and RNG set). Told to use both (`waarm64.armcap=0x99fd`, `alpine_crypto_eor3_jit`, against the default;
3 rounds alternated; `results/m9-sha3/openssl-forced/`):

| | default (0x9fd) | forced (0x99fd) | |
|---|---|---|---|
| sha3-256, 256 B | 83.4 · 85.8 · 83.9; **83.9** | 91.3 · 90.5 · 91.2; **91.2** | +9% |
| sha3-256, 16 KiB | 278.7 · 308.0 · 281.1; **281.1** | 520.3 · 510.1 · 514.5; **514.5** | **+83%** |
| aes-128-gcm, 16 KiB | **315.1** | 348.4 · 344.4 · 346.9; **346.9** | +10% |
| aes-256-gcm, 16 KiB | **260.3** | 286.4 · 283.5 · 283.8; **283.8** | +9% |

(256-byte GCM and SHA-512 unchanged.) So the instructions are worth it where a guest uses them: Linux's sha3-ce,
and OpenSSL if the MIDR said a CPU it knows (docs/backlog.md "OpenSSL's MIDR-gated paths").

## M8: the JIT's spill arm (2026-10-24)

Loads and stores in JIT code reach spill memory 1 inline (docs/spill-memories.md "The JIT's spill arm"). Chromium
153.0.8010.52 headless, the dev VM (linux-arm64, 8 vCPUs), one session; the arm off (`jit::INLINE_SPILL` 0, "base")
and on, as two wasm builds swapped between runs. The JSON is in `results/m8-spill/debian-arm/` and
`results/m8-spill/alpine-user-spill/`.

**Debian's workloads bound to node 1** (`results/m8-spill/tools/numa-debian.ts`, `?ram=6144`, 2 vCPUs, `MB=32`;
base, arm, base, arm, three rounds each alternating nodes 0,1 and 1,0; ms in the guest, median of six [range]):

| | node 0, base | node 1, base | node 0, arm | node 1, arm | node 1 / node 0 |
|---|---|---|---|---|---|
| `dd` 512 MiB from /dev/zero | 404 [317–493] | 2490 [2362–2560] | 364 [336–382] | 430 [425–442] | 6.2× → 1.18× |
| `cat` 32 MiB | 234 [164–341] | 482 [402–580] | 196 [176–215] | 208 [198–221] | 2.1× → 1.06× |
| `sha256sum` 32 MiB | 318 [276–407] | 1378 [1267–1463] | 318 [290–334] | 322 [314–343] | 4.3× → 1.01× |
| `gzip -1` 32 MiB | 3685 [3606–3774] | 63606 [63258–64403] | 3720 [3638–3747] | 6020 [6014–6058] | 17× → 1.62× |
| `sort` 16 MiB | 744 [636–897] | 5232 [5132–5427] | 704 [663–758] | 828 [816–921] | 7.0× → 1.18× |
| perl, a 300k-key hash | 1258 [1153–1351] | 12418 [11954–12637] | 1241 [1174–1255] | 1730 [1691–1775] | 9.9× → 1.39× |

On node 1 the arm makes the workloads 2.3× (cat) to 10.6× (gzip) faster: dd 5.8×, sha256 4.3×, sort 6.3×, perl
7.2×. Node 0's ranges overlap across the builds. What's left (gzip's 1.6×) is the arm being out of line: the deferred branch, the
second compare and memory 1's base, which V8 loads from the instance (it reaches memory 1 through a guard region, no
bounds check: `--print-wasm-code` of a two-memory module).

**Alpine's userspace benchmark on a spill machine** (`alpine_user_spill_jit`, new: 192 MiB in memory 0, the
initrd's +128 MiB the floor, and 832 MiB in a spill memory; base, arm, base, arm, three boots each; ms, median of
six):

| | base | arm | |
|---|---|---|---|
| compress | 1974 | 1987 | +0.7%, overlapping |
| lua | 3068 | 3077 | +0.3%, overlapping |
| churn | 1414 | 1397 | −1.2%, overlapping |
| sqlite | 2336 | 2323 | −0.5%, overlapping |
| total | 14598 [14552–14725] | 14301 [14162–14419] | **−2.0%** |

Its phases' pages stay mostly in node 0; the arm's gain is in the boot's share of the total. What it shows is the
code: the same 11,250 blocks compiled into 19.24 MB of wasm with the arm against 16.71 MB without (**+15%**; compile
time 120 vs 121 ms). On a machine without spill memory the code is unchanged: `alpine_user_jit` compiled 16,650,058
bytes with either build (`nospill-*.json`).

## The page under Vite (2026-10-24)

The build system change (docs/frontend.md "The build"): the page's load (to `idle`) and Buildroot's start (to
`running`) on the page, served three ways and alternated, 5 rounds, Chromium 153 on the dev VM
(`results/m8-vite/vite-ab.ts`, `vite-ab.json`; an ad-hoc timing from Playwright, not `bench/run.ts`): the old server
(type stripping, at a67b658), Vite's dev server in mode `test` (what the tests use), and `vite build` behind Vite's
preview server.

| | page idle, ms | Buildroot running, ms | requests to idle |
|---|---|---|---|
| old server | 290 [275–343] | 678 [668–696] | 163 |
| Vite dev server | 248 [228–475] | 704 [675–782] | 239 |
| Vite build | 105 [101–109] | 529 [525–532] | 3 |

The build loads in a third of the time and starts a machine ~150 ms sooner (its workers are one file each); the dev
server is the old server's speed (its first load per process compiles; later loads are cached). The tests stay on the
dev server (their harness pages and in-page imports aren't build entries; docs/backlog.md "Page tests on the build").

## Groups of accesses: one TLB probe for loads or stores off one base (2026-10-30)

docs/jit.md "Loads and stores" (`emit::plan`): two or more loads (or stores) with immediate offsets off one base,
unchanged between them but by writebacks and immediates added to it, over at most 256 bytes, share the leader's
probe, widened to the group's span; a follower emits no address, probe or slow arm. A miss runs the span's
instructions through the helper; on a spill machine the group has one spill arm (the span again on memory k)
instead of one per access. The backlog's question, with `ADD`/`SUB` of the base and flagless integer instructions
allowed between the accesses (fewer of them than followers: each costs a helper call in the cold arm).

The Mac host (Apple M4, macOS), Chromium 153.0.8010.12 headless, `bench/interp/ab-mac.sh grp2 3`: a = groups off
(`emit::GROUPS` false), b = on, the same source otherwise; alternated, 3 rounds, nothing else running. Medians of
the rounds' medians (ms; rounds in `results/groups/`):

| | a | b | |
|---|---|---|---|
| `alpine_user_jit` total | 11,579 · 12,021 · 12,029 | 11,904 · 11,953 · 11,972 | −0.6% |
| compress / Lua / churn / SQLite | | | −0.4 / +0.8 / −2.1 / 0.0% |
| `alpine_user_spill_jit` total | 12,046 · 12,352 · 12,363 | 12,067 · 12,114 · 12,427 | −1.9% |
| `boot_alpine_jit` (to the script) | 3,768 · 3,812 · 3,838 | 3,753 · 3,770 · 3,789 | −1.1% |
| JIT wasm, `alpine_user_jit` | 16.65 MB | 16.07 MB | **−3.5%** |
| JIT wasm, `alpine_user_spill_jit` | 19.24 MB | 18.35 MB | **−4.6%** |
| JIT wasm, Alpine's boot | 12.04 MB | 11.62 MB | **−3.5%** |
| emission, `alpine_user_jit` (ms a run) | 190-196 | 200-202 | +3-5% |

The rounds overlap everywhere (a's first round ran ~4% faster than its others: the host's drift), so no time
difference counts: neither the speedup the backlog hoped for nor the memo's loss. The wasm is 3.5-4.6% smaller,
which is V8's code and metadata (~10× the bytes, docs/jit.md "Memory"); the spill machine gains most, its
followers' spill arms gone. Emission costs ~10 ms more a run (the plan emits each instruction it would put
between accesses once on its own to check it is inline and leaves the flags and `HOST` alone); V8's compile time is
unchanged. Kept. An earlier session of the same A/B (`groups-*`, not kept) ran while the dev VM built and tested
beside it and its a rounds 2-3 came out 7% slow: discarded. On the dev VM one round each: +0.8% (inside its noise),
wasm the same −3.5%.

Tests: `jit::emit::tests::groups_of_accesses` (the plan), `tests/baremetal/mmu.c` checks 35-38 (a group across the
swapped pages, with a writeback and an add between; a group's second store faulting; a load into the base ending
its group), `tests/jit-diff.test.ts` "groups of accesses" on spill memories. Planted: the probe checking the
leader's first byte only (mmu checks 35 and 36 fail; jit-diff's VA = PA pages are contiguous, so it passes), the
cold arm running only the leader (check 36), the spill arm naming memory 0 (jit-diff).

## Groups of accesses, measured: what's left, and mixed groups (2026-10-30)

The leftovers ranked on measurements instead of guesses. An instrumented core (`results/accstat/instrument.patch`,
applied to 4271f7c6; not on main) logged every compiled block's words and execution count, each group's lowest page
offset, cold arms and straddles, and each probe's page against the function's last two, over Firefox's pages session
(5 sites, from `target/snapbench/pages.waarm64snap`). Its analyzer (`examples/accstat.rs`, in the patch) replays the plan's
variants over those blocks. Output: `results/accstat/pages.txt`; 8.6e10 instructions, 227,119 blocks compiled.

- **The mix:** 32.6% of instructions are loads and stores: immediate forms 92.8% (68% loads), register offset 5.6%,
  literal 0.0%, LD/ST structures 0.1%, the rest (exclusives, atomics, acquire/release) 1.5%. So literal and LD1/ST1
  members buy nothing, and a register offset has no static span.
- **Probes left**, of every immediate access probing: today's rule 82.1%. Span cap 32: 88.6; 64: 84.2; 128: 82.3; 512:
  82.0; 4096: 81.8: past 128 bytes the cap does nothing, and 256 stays. Up to 4 others among a group's accesses: 78.0; 16:
  77.8. Mixed loads and stores: 79.8; with 4 others **73.8**. Then two probes in one `if`: 71.8; three: 71.2; any
  instruction between (the bound): 70.0. Inside a block about 30% of probes can go, whatever the rule: blocks are short.
- **What ends a group** that had a same-base access within 12 instructions (2.7% of accesses): SUBS 29%, MRS 14%,
  register offsets 17%, CSEL & co 7%.
- **Straddles:** 0.58% of group runs straddle a page (14 M), 0.68% take the cold arm at all. The predicted rate from
  the offsets (4.7% for 256 bytes, 2.6% for 128, 0.8% for 64) matches the spans actually run, most of them short.
  Offsets are near uniform, the page's last 256 bytes 5.0% of runs where uniform gives 6.25%.
- **Across blocks:** of 1.8e10 probes run, 46% hit the page of one of the function's last two probes.

Built from that: **mixed groups** (the probe in the write array if a member stores; a read entry never answers for a
store) and **up to 4 other instructions** among a group's accesses, the cold arm made one call instead of one each
(`jit_exec_span`, the span's words as constants, six a call: ABI 56). Dev VM, Chromium headless, Firefox's pages
session from the snapshot, `base` = 4271f7c6 with the ABI bumped, `k4m` = this; 4 rounds alternated from the second,
JSON in `results/groups-v2/`:

| | base | k4m | |
|---|---|---|---|
| wasm / inline instruction (B) | 104.43 · 104.46 · 104.56 · 104.43 | 101.75 · 101.70 · 101.82 · 101.56 | **−2.6%** |
| busy-vCPU MIPS | 209 · 208 · 201 · 195 | 211 · 211 · 210 · 191 | overlapping |
| pages' load (ms, sum of 5) | 30,492 · 31,500 · 32,836 · 34,712 | 30,637 · 31,525 · 31,061 · 35,869 | overlapping |
| wasm total (MB) | 133.8 · 133.9 · 133.4 · 133.6 | 132.7 · 132.8 · 132.6 · 133.0 | −0.6% |

The total falls less than the density: the session compiled 1.8% more inline instructions in every `k4m` run
(1.30 M against 1.28 M), which nobody has explained. Other limits, one round: 1 other 102.37 B, 2: 101.63, 8: 101.46; 4
without mixing 102.80. (These ran with the import in every module; the build committed imports it only where a block
has two candidates, which `block.rs`'s byte tests need.) Time doesn't move, as with the first groups: removing a TLB probe saves little per access, and
the session's speed is set elsewhere. Two probes weren't built: 2 points of probes for a second `HOST` through every
body, at about 0.5% of wasm by these ratios.

Tests: `mmu.c` checks 40-42, the plan's unit test, `jit-diff`'s groups now mixed, with an add among them and a dirty
earlier site, each state run twice. Planted: the failure's reload gone (check 39, and `jit-diff`: 13 of 512 groups
differ, the Firefox crash's class), mixed groups on the read array (check 42: a 64-iteration loop compiled nothing,
and with the load only inside the group the plant still passed, for a reason not found; a load of the page before each
call made it fail).


## Groups of accesses: the leftovers closed (2026-11-09)

The backlog's leftovers, decided from the analysis above (`results/accstat/pages.txt`) without new runs. Probes left
of every immediate access's: mixed groups with 4 others (today) 73.8%; any instruction among them, 16 at most, 72.3%
(the flag setters and readers, SUBS 29% and CSEL & co 7% of what ends a group, MRS 14%); two probes in one `if`
71.8%; three and any instruction 70.0%. With probes ~10.3% of the wasm (the census in `results/wasm-size/`), ~5% fewer
probes is ~0.5% of the wasm, under what the size work found users feel (docs/backlog.md "Where the JIT's wasm bytes
go"), and the two rounds of groups (~26 points of probes) moved no time. Not built, by the user's call; docs/jit.md
"Tried and not kept" keeps the numbers and the one lever left (probes across blocks).

## Where a busy vCPU's time goes on the Mac, and the compile threshold there (2026-11-09)

The M4 Mac mini's host (macOS 26.6.2), Chrome for Testing 157.0.8103.38 through `bench/gpu/sway-mac.sh`, where wasm
memory accesses carry no explicit bounds checks (the dev VM's do). Profiles: V8's `--prof` (`CHROMIUM_JS_FLAGS=--prof`,
`CHROMIUM_ARGS=--no-sandbox`, one log per isolate), attributed per tick with `results/m9-macprof/tools/prof-attr.mjs.txt`
into the categories of "Where a busy vCPU's time goes in Firefox, again" (2026-11-04, the VM). The three profiled
sessions ran a core from before c49e4a16 (the FZ fast paths: a shared `target/` left it stale), which moves none of
what follows; the threshold A/B's arms are fresh builds of `307b8d51`. Raw: `results/m9-macprof/` (README).

**Firefox's pages session** (from `pages.waarm64snap`; loads ~10% slower under `--prof`), % of busy vCPU ticks, Mac
(VM 11-04): TurboFan bodies 40.8 (30.8), **block interpreter 18.4 (13.0)**, entries at a function's first instruction
14.1 (22.0), Liftoff bodies 5.4, dispatcher and `Jit::miss` 4.6, Chrome's framework 3.4, helper bodies 3.1, TLB miss
and walk 1.9, helpers' entry 1.8, compile 1.3. Interpreted steps are 3.96% of 88.5 G, so an interpreted step costs
~5.5× a compiled one here (3.5× in the VM: the VM's bounds checks tax compiled code more than the interpreter's).
The interpreter is 13-31% of 20 s windows while pages load. The guest's profile is flat (its top function 0.46%).

**Godot's GI demo in the editor on Venus** (`bench/vulkan/godot.ts`, `gi-editor`): interpreted steps 0.85% of ~232
G, the interpreter 6-7% of the ticks (~8× a compiled step), 21% in the first 20 s and 1.5-2% after 140 s; entries
13-14%. With the default 6144 MiB of RAM, Godot's pages reach spill memory 2 (no inline arm, `jit::INLINE_SPILL` 1:
on a Vulkan machine memory 1 holds the Venus arena, the host-visible window and node 1), and ~16% of the busy ticks go
to its helper chain (`jit_exec_mmu` 6.2%, `ldst::exec` 3.1, `Mmu::miss` 1.9, `read_el`/`write_el` ~2, `spill_load`/
`store` 1.3, `ldst::single` 1.1). At 4608 MiB (no memory 2) the same start took **14% fewer busy ticks** (309 → 265
k), `jit_exec_mmu` 2.8% and the spill calls gone; first frame 10.1 → 8.1 s, last held frame 75.8 → 66.7 s (run 2 had
Metal's shader cache warm, so those two are confounded; the tick counts aren't). Of Godot's log, one texture-array
preview takes 22-25 s, whichever runs first (`zdm2_indirect.exr` at 6144 MiB, `zdm2_all.exr` at 4608), which looks
like waiting more than CPU: not chased.

**The compile threshold on the Mac.** The floor and maximum (1000 and 2000) were set by VM rounds (bench/interp/REPORT.md
"M8-INTERP round 2", "loop 11"); the Mac's dearer interpreted step asked whether they should be lower. Arms floor/max
1000/2000 (`t1000`, today's), 500/1000, 250/500, rotated over 3 rounds; each round per arm Firefox's pages session from
the snapshot (sum of the five loads), then `alpine_user_jit` and `boot_alpine_jit` (`bench/run-mac.sh`), ms:

| Arm | Pages loads, r1/r2/r3 | Interpreted steps | Wasm | Alpine userspace total | Alpine boot (warm total) |
|---|---|---|---|---|---|
| 1000/2000 | 18,194 / 18,350 / 18,636 | 3.9% | 138 MB | 10,824 / 10,892 / 10,860 | 4,129 / 4,154 / 4,139 |
| 500/1000 | 18,526 / 18,720 / 18,197 | 3.1% | 167 MB | 10,841 / 11,014 / 10,876 | 4,121 / 4,132 / 4,111 |
| 250/500 | 18,683 / 18,979 / 19,592 | 2.4% | 206 MB | 11,005 / 11,011 / 11,030 | 4,244 / 4,264 / 4,266 |

250/500 loses everywhere, rounds apart: pages +3.6%, userspace +1.4%, the boot +2.9%. 500/1000 overlaps 1000/2000 in
every column (pages +0.9%, userspace +0.3%, the boot −0.4%) for 21% more wasm. **The threshold stays.** Halving it
takes only a fifth of the interpreted steps away (3.9 → 3.1%), at a fifth more wasm and V8 compile: what runs
interpreted is mostly code that never gets that hot, so the interpreter's own speed is the lever, not the threshold.
Raw: `results/m9-macprof/thr/` (`run.log`, the pages sessions' results and JIT logs, the Alpine JSON).

## FEAT_DotProd and FEAT_JSCVT, measured (2026-11-02)

The dev VM (8 vCPUs, the M4 under Lima), Chromium 153.0.8010.52 headless, the guest on 4 vCPUs, alternating arms, a boot
per arm and round; the x86 side is unmeasured. Medians of rounds, each round the median of three runs in a boot. Raw:
`results/dotprod/`, `results/jscvt/`, how: bench/imgdecode/README.md "A CPU feature's A/B".

**Who has SDOT and UDOT** (words in the guests' executable segments): Chromium 6,472; libaom 4,912; libgkcodecs 2,902
(Arch's Firefox; Debian's has none, and Debian ships libdav1d apart); libvpx 1,200 (Debian), 2,347 (Arch); x264 248; dav1d 174, all
by element; libavcodec 38; libxul 16. **None in libjpeg, libwebp, OpenH264 or rav1e**, so nothing a JPEG decodes runs
differently: the claim that libjpeg-turbo picks a dotprod path is false.

**SDOT's order in wasm**, ns a dot on the M4 in Chromium and in Node's V8 alike (`dot-seq`, ad hoc), accumulating into
one register / with independent results. All gave the same check values.

| Sequence | Host ops (estimated, not disassembled) | Chained | Independent |
|---|---|---|---|
| extmul, extadd_pairwise, an ADDP in shuffles | 8 | 0.51 | 0.51 |
| extended halves, `i32x4.dot_i16x8_s`, the same ADDP | ~8, going by its time | 0.51 | 0.51 |
| even and odd bytes, `i32x4.dot_i16x8_s` | 14 | 0.88 | 0.89 |
| extmul, shuffles, two SADALPs onto Vd | 6 | **1.45** | 0.38 |
| extmul, shuffles, SADDLP and SADALP, then Vd (kept) | 7 | 0.51 | 0.45 |

0.51 is the accumulator's add chain, what native SDOT runs at too (0.50 ns in `q8dot`). Two SADALPs on Vd chain two
long latencies per dot: the fewest ops, and three times slower in a sum loop.

**Codecs, on/off of time** (lower is better), five rounds on the kept order, three on the extended-halves one
(`results/dotprod/first-lowering/`). No workload separates: every pair's rounds overlap.

| Workload | Extended halves | Kept |
|---|---|---|
| dav1d, AV1 decode | 1.010 | 0.984 |
| libvpx, VP9 decode | 0.954 | 0.971 |
| ffvp9 decode | 0.978 | 0.975 |
| x264 veryfast | 0.993 | 0.986 |
| x264 medium | **1.068**, rounds apart | 1.014 |
| libvpx, VP9 encode | 1.005 | 1.004 |
| libaom encode | 0.978 | 1.007 |
| h264 decode (control) | 1.007 | 0.994 |
| djpeg (control) | 1.016 | 0.992 |

`q8dot`, ggml's int8 dot product, is level too (2.26 ns against 2.29 per 16 bytes): SMULL, SMULL2 and two SADALPs are as
cheap in wasm as our SDOT, so the NEON paths DotProd replaces have little to lose to.

**Browsers, images a second** (higher is better), three rounds of `profile.ts`, `imgdecode-rates.json`; the arms overlap
in every case, and rounds move ±7% on AVIF.

| Case | Off | On | On/off by round |
|---|---|---|---|
| Chromium, AVIF | 4.74 | 4.52 | 1.00, 0.94, 1.00 |
| Firefox, AVIF | 3.37 | 3.60 | 0.93, 1.08, 1.07 |
| Chromium, JPEG (control) | 10.59 | 10.84 | 0.97, 1.05, 1.00 |
| Firefox, JPEG (control) | 18.46 | 18.45 | 1.00, 1.00, 1.00 |

A tie: **DotProd is advertised** (the user's rule, PLAN.md).

**JSCVT, on/off of time**, three rounds, `js.html` (kernels written to stress ToInt32, so per operation, not what a page
gains). Both engines use FJCVTZS: the first two forms moved these numbers, though neither binary holds the instruction.

| Kernel | Chromium: first / past int32 inline / kept | Firefox: first / inline / kept |
|---|---|---|
| `wrap`, doubles past int32 | 4.28 / 0.64 / **0.52** | 2.74 / 0.95 / 0.92 |
| `store` into an Int32Array | 0.70 / 0.69 / **0.75** | 0.69 / 0.96 / 0.87 |
| `fixed`, fixed point in floats | 1.17 / 0.94 / **0.63** | 1.09 / 0.95 / 0.92 |
| `bitor`, ToInt32 in range | 1.20 / 0.97 / **0.88** | 0.81 / 0.63 / 0.95 |
| `hash`, `>>> 0` of products | 1.31 / 1.07 / 0.98 | 1.24 / 1.15 / 0.96 |

Bold: rounds apart. *First* took `f64.trunc` and a helper past int32. *Past int32 inline* is one `i64.trunc_sat` with Z
out of the guard and `if !fits` around IOC; `hash`'s values fall on either side of 2^31 at random, and *kept* tests IOC
in the same branch, sticky, so it's taken once. Round 3 of that second column's Chromium arm ran slow in all five
kernels, unexplained; the third column has no such round. Firefox's clock is coarse and its rounds overlap throughout.
Nothing is slower: **JSCVT is advertised.**

Steps move with ABI 59 and 60 together (the guests' Linux sees SB, LRCPC, DIT and the rest): Buildroot +0.14%, Alpine +0.13%,
Alpine's userspace -0.03%, crypto -0.4%, USB -6%. EDK2 doesn't move.

## The wasm code GC today, and larger batches in a browser (2026-11-03)

The backlog's "The wasm code GC stops every vCPU" and "Fewer, larger modules for a browser, what's left". The dev VM,
headless Chromium 153.0.8010.52, core `0cacda0f`; every session from `target/snapbench/pages.waarm64snap` (the desktop
guest, 4 vCPUs) through `bench/gpu/ab.sh`. Data in `results/m9-codegc/` (README).

**What V8's code GC frees and when** (V8's `src/wasm/wasm-engine.cc` and `wasm-code-manager.cc`, read at their
current main): code goes on the engine's potentially-dead list when its last reference drops while its module lives:
Liftoff code that TurboFan replaced (and wrappers). A module that dies takes its code with it in the module's own
teardown, not in the code GC, so a JIT flush doesn't feed it. A GC starts once the potentially-dead code passes
64 KB plus a tenth of all committed wasm code in the process, asks every isolate to report the code on its stacks (a
stack-guard interrupt and a task), and the isolate that reports last frees the dead code (`FreeDeadCode`) under the
engine's mutex. So what it frees follows the tier-ups, not the module count.

**The code GC no longer stops the vCPUs.** One session of each with `--trace-wasm-code-gc` and the vCPU timeline
(`bench/gpu/stalls.ts`; the trace's times can't be used: the renderer's stdout reaches the harness in buffered chunks):

| | code GCs | the largest | stalls ≥ 20 / ≥ 50 ms | longest | all vCPUs at once |
|---|---|---|---|---|---|
| pages session (315 s, 2,798 modules, no flush) | 29 | 6,923 objects in 1,678 modules (limit ~48 MB) | 2 / 0 | 35 ms | 0 |
| churn screen (316 s, 57,390 modules, 1 flush) | 42 | 16,420 objects in 3,771 modules (limit ~92 MB) | 1 / 0 | 41 ms (one vCPU) | 0 |

On 2026-10-15 ("M8: V8's GC on the vCPU threads") the code GC stopped all four vCPUs for 50-75 ms a few times a
session. Since then the vCPU workers return to their event loop and the compile threshold went from 50 to
1000-2000; which of the two removed it wasn't isolated.

**Larger batches** (`BATCH_STEPS` 50K, 200K, 800K; two sessions per arm, alternating; `ab-pages/`, `ab-churn/`,
`summary.txt` in each from `bench/gpu/ab-summary.ts`). The pages session:

| | 50K (kept) | 200K | 800K |
|---|---|---|---|
| modules | 2,793 · 2,758 | 1,516 · 1,516 | 918 · 918 |
| wasm | 133 · 133 MB | 132 · 132 | 132 · 133 |
| busy MIPS | 194 · 186 | 194 · 195 | 197 · 188 |
| interpreted G steps | 3.44 · 3.45 | 3.54 · 3.49 | 3.65 · 3.64 |
| V8's code, median (MiB) | 401 · 414 | 388 · 385 | 379 · 400 |
| renderer RSS, median (MiB) | 3,624 · 3,607 | 3,560 · 3,627 | 3,563 · 3,574 |
| stalls ≥ 20 / ≥ 50 ms | 2 · 1 / 0 | 3 · 2 / 0 | 4 · 2 / 0 |
| wiki, bbc load (s) | 14.5 · 10.5, 10.9 · 12.9 | 10.5 · 10.3, 13.1 · 11.8 | 10.5 · 10.2, 11.8 · 12.3 |

The churn screen (`made`: the page's own work in the session):

| | 50K (kept) | 200K | 800K |
|---|---|---|---|
| modules | 57,447 · 55,678 | 37,857 · 38,978 | 23,973 · 24,195 |
| wasm, flushes | 571 · 557 MB, 2 · 1 | 522 · 533, 1 · 1 | 451 · 452, 1 · 1 |
| `made` | 9,093 · 8,769 | 8,894 · 9,080 | 8,546 · 8,640 |
| busy MIPS | 252 · 245 | 259 · 260 | 251 · 263 |
| share compiled, interpreted G steps | 0.90, 16.5 · 15.9 | 0.883, 18.7 · 19.2 | 0.851, 23.2 · 23.4 |
| the cache's lock acquisitions | 79 · 76 M | 113 · 116 M | 181 · 181 M |
| V8's code, median (MiB) | 562 · 542 | 527 · 513 | 478 · 489 |
| renderer RSS, median (MiB) | 4,179 · 4,166 | 4,029 · 4,074 | 3,976 · 4,013 |
| stalls ≥ 20 / ≥ 50 ms | 1 · 5 / 0 | 2 · 1 / 0 | 4 · 4 / 0 |

Fewer modules for the same wasm, and nothing a user would notice gained: the pages session's busy MIPS and loads
within the sessions' spread, the churn's work even at 200K (its +4% busy MIPS spent on 16% more steps interpreted and
50% more lock acquisitions) and 4% lower at 800K, memory 1-6% lower (13% of V8's code at 800K). Stalls of 20 ms or
more are a few a session in every arm; 800K had the most in both workloads, and a block waiting longer interpreted
makes each batch's install larger, which a slower host would feel. **`BATCH_STEPS` stays 50K.** Rebuilding the live
regions into 512-region modules while the guest idles wasn't built: the rebuilt functions would start in Liftoff and
tier up again, adding to what the code GC frees, for the same module saving that measured flat here.

## The TLB at 16,384 entries; per-ASID stashes and victim buffers measured out

2026-11-03, the dev VM, Chromium 153.0.8010.52; `results/tlb16k/`. The backlog's two MMU speed items: a per-ASID
stash of nG entries (the previous ASID's are dropped at a switch) and the direct-mapped TLB's conflicts.

**What the misses are.** A temporary build (never committed) classified every TLB fill, its counters out through
unused exception-class slots (`counts/`; `exp-*` are Alpine's boot in Node, `userspace-4096.json` the userspace
benchmark in Chromium, its counters cover the boot and the four phases):

| | Alpine boot | boot + userspace phases |
|---|---|---|
| TLB misses | 746,805 | 1,728,182 |
| fills | 626,453 | 1,557,837 |
| fills on a slot holding another page (conflicts) | 287,156 | 971,280 |
| … a victim ring of 4 / 16 / 64 would have served | 199,212 / 223,100 / 237,966 | 518,098 / 588,795 / 672,899 |
| nG fills | 232,409 | 949,924 |
| … a per-ASID stash would have served | 58,581 | 143,786 |
| ASID switches stashed (entries) | 3,625 (110,437) | 9,658 (237,107) |

The stash model was generous (it keeps whatever was live at a switch; any TLBI by VA drops that page from every
stash, ASIDE1 its ASID's, VMALLE1 all) and still serves under a sixth of the nG refills. It would also cost parallel
SMP: a TLBI IS for another ASID skips a vCPU only if it holds nothing of that ASID (`Tlb::low_global`), which a
stash ends. Not built. The conflicts ping-pong (69% are wanted back within four evictions), and nearly all are the
kernel's data (`exp2-alpine.txt`: EL1 reads 199,390 and writes 82,156 of them, EL0 3,820; none between the halves;
the pages under 1 GiB apart, the linear map of the 1 GiB RAM competing for 4,096 slots). A victim buffer would
serve them on `Mmu::miss`, still behind the JIT's helper call; a larger table serves them inline at no cost (the
index mask is a constant). 8,192 entries removed 31% of the boot's conflicts (`exp8k-alpine.txt`), 16,384 more:
the boot's misses 746,805 → 639,853 (`t*-alpine.txt`), steps unchanged (2,655,076,428).

**A/B, alternated in one session** (medians; rounds in `tlb/`, `smp/`, `apps/`):

| | 4,096 | 8,192 | 16,384 |
|---|---|---|---|
| Alpine boot (JIT), 3 rounds | 5392.8 ms | 5401.7 (+0.2%) | 5364.6 (-0.5%) |
| Alpine userspace, total | 13754.4 ms | 13755.9 (+0.0%) | 13465.7 (-2.1%) |
| … compress / lua / churn / sqlite | 1925.0 / 3036.2 / 1219.3 / 2337.0 | +0.5 / +0.1 / +2.4 / +0.1% | **-1.6 / -1.0 / -2.4** / -1.2% |
| 4 vCPUs, parallel (`smp_user_jit_4`), 4 rounds, total | 15594.0 ms | | 15411.4 (-1.2%) |
| … compress / lua / churn / sqlite | 1957.9 / 3256.2 / 1538.7 / 2490.8 | | -3.5 / -0.4 / **-2.8** / +0.3% |
| … TLB misses (4 vCPUs), median | 4.4 M | | 3.1 M |
| Chromium in Debian (`bench/apps/chromium.ts`, 4 vCPUs, 4 pairs): renders 1-3 | 16.83 / 10.41 / 9.89 s | | 16.50 / 10.53 / 9.64 s |
| … TLB misses a render, median | 14.8 / 12.8 / 12.7 M | | 11.4 / 10.0 / 9.7 M |

In bold, the 16,384 arm's rounds all beat 4,096's; the rest overlap (the renders move ±10% from boot to boot).
Misses fall 14% (one vCPU) to 30% (four), the process-heavy phases gain 1-3%, nothing measured slower, four
larger TLBs in parallel SMP included. **The TLB is 16,384 entries**: +1,634 KiB per vCPU (the `Tlb` 823,040 →
2,496,256 bytes), the nG list's slots `u32` (16,384 × 8 slots pass 16 bits). A TLBI by VA in a page of a 1 GiB
block now scans up to 16,384 indices (4,096 before), only while the TLB holds an entry of that class.

## Past the nG list: a scan of nG marks instead of a whole flush (2026-11-04)

The dev VM, Chromium 155.0.8059.84; `bench/gpu/results/p1-ng/`. REVIEW-20261103.md's P1: `Tlb::ng` lists the slots
of nG fills, up to 1,024 (fills, refills included), and past that an ASID switch or `TLBI ASIDE1` flushed the whole
TLB, the kernel's global entries with it (2.3 MiB written). The list wasn't resized with the TLB (16,384 entries
since 2026-11-03, above).

**How often** (a temporary build counting `flush_ng`'s calls and overflows in place of walks and flushes;
`instr-*.json`): Alpine's boot and userspace phases, 12,429 nG drops, 7 of them overflows. Firefox's pages session
(4 vCPUs, from `pages.waarm64snap`), each site's 12 s scroll window: 16 (hn) to 80 (wiki) overflows, ~7 a second.

**The fix:** each slot's byte in `Tlb::blk` (block class in bits 2:0) carries an nG mark (bit 7) set at the fill;
past the list, `flush_ng` reads the 128 KiB of marks eight slots a word and drops only the marked slots.

**A/B, Firefox's pages session from the snapshot**, `bench/gpu/ab.sh`, 3 rounds alternated (`a-*` base, `b-*` the
fix):

| | base | scan | |
|---|---|---|---|
| busy MIPS (rounds) | 204 / 207 / 210 | 214 / 212 / 214 | +3.4% median, no overlap |
| session wall (s) | 335.7 / 334.4 / 335.5 | 331.4 / 332.9 / 330.5 | -1.2%, no overlap |
| TLB misses in the scroll windows, wiki / mdn / github / bbc / hn (median, k) | 344 / 246 / 378 / 342 / 164 | 290 / 208 / 299 / 282 / 129 | -16 to -21% |
| wiki / bbc load (s, median) | 9.9 / 11.3 | 9.1 / 10.8 | overlap |

Alpine userspace has too few overflows to show: not A/B'd. Kept.

## Where a busy vCPU's time goes in Firefox, again (2026-11-04)

"M8: where a busy vCPU's time goes in Firefox" (2026-10-16) profiled the pages session at ~140 busy MIPS; the JIT,
the MMU and the run loop have changed much since (~214 busy MIPS unprofiled today). The same profile again to check
the backlog's CPU, interpreter, JIT and SMP items. The dev VM, Chromium 155.0.8059.84, core `672e9908`; one pages
session from `target/snapbench/pages.waarm64snap` (4 vCPUs) with `--perf-prof` and `perf record -k mono
--user-regs=x16,x17,lr` (`results/m9-ffprof/tools/run.sh`); 352 s (336 unprofiled), 181 busy MIPS under the
profiler. Data, scripts and the microbenchmark's runs in `results/m9-ffprof/` (README).

**The vCPU threads' samples** (478,928; `attr.txt`, the October split's script with perf's map counted as V8 code):

| | 2026-10-16 | now |
|---|---|---|
| guest code, the function's first instruction (kernel, user) | 25.8% (15.0, 10.8) | **22.0%** (12.3, 9.7) |
| guest code, a `call_indirect`'s signature check | 5.3% | 3.0% |
| guest code, TurboFan bodies (kernel, user) | 22.7% | **30.8%** (14.6, 16.2) |
| guest code, Liftoff bodies (kernel, user) | 12.9% | 6.3% (1.9, 4.4) |
| the core: block interpreter | 6.1% | **13.0%** (`hot` alone 9.5%) |
| the core: dispatcher, misses | 5.6% | 3.5% |
| the core: helpers (entry and bodies) | 3.8% | 3.7% (`jit_exec_mmu` 1.2%) |
| the core: TLB misses and walks | 0.8% | 1.6% |
| the core: compiles and installs | 2.3% | 1.0% |
| the core: run loop, devices | 0.4% | 0.7% |
| Chromium (no symbols; no address over 0.2%), vDSO, libc | 10.4% | 11.1% |

**How a function was entered** (`split.txt`): 80% of the entry samples after a `return_call_indirect` (the signature
in x16, the target in x17), 15% from the dispatcher, 5% other: as in October (83%, 13%). The return address is
`jit::steps`' in every sample (a chain of tail calls returns there), so it doesn't name the predecessor; the kernel's
split by target (October: 57% static successors through the jump cache, 32% returns) wasn't redone (it needs the Arch
kernel's `System.map` and `Image`).

**Over time** (`bytime.txt`, 20 s windows; JIT log `jit.jsonl.gz`): the block interpreter is the page loads' cost and
the entry stalls are steady state's.

| | page loads (5 windows) | scrolling (5 windows) |
|---|---|---|
| block interpreter, of the vCPU samples | 14-16% | 2.7-4.1% |
| function entries, of the vCPU samples | 21-24% | 27-29% |
| guest steps interpreted | 2.0-4.0% (8.6-10.3% in the first 40 s) | 0.7-1.0% |
| instructions decoded / invalidations, a window | 1.4-1.9 M / 580-1,320 | 51-98 K / 17-37 |

Over the session 4.1% of the steps ran in the block interpreter for 13% of the samples: an interpreted step costs
~3.5× a compiled one, ~4-5× in the loads. The loads bring new code (Firefox's own JIT among it, whose rewrites are the
invalidations), run interpreted until hot.

**Other counters** (the session's last JIT counters): no JIT flush (132 MB compiled; the session is shorter than
October's, from the snapshot), the cache's lock waited 1.66 s in all (0.35% of busy vCPU time; 79,718 of 18.6 M
acquisitions contended), `lagFlushes` 0, one prune (39 ms). Exits: ~5-10K SVCs, ~0.5-1.2K data aborts and ~2-4K
IRQs a second (the page windows' `exceptions` and `irqs`); at the ~240 ns of an exit's round trip that is ~0.2-0.3% of
busy vCPU time, the run loop's own functions 0.7% of the samples.

**A direct transfer into cold code** (backlog: "first measure whether a direct tail call into code evicted from the
caches stalls as much as an indirect one"). October's `chain.mjs` stopped at 32,000 functions, whose hot lines
(~8 MB) fit the M4's L2. Node v26.7.0, `--no-liftoff`, pad 40, functions chained in a random order (`chain.txt`), ns
an entry:

| | 1,000 | 32,000 | 131,072 |
|---|---|---|---|
| `return_call_indirect`, one table | 25 | 28 | **84** |
| `return_call`, one module (through V8's jump table) | 22 | 22 | 50 |
| `return_call` of an import, a module a function, compiled in a random order | 22 | 20 | **25** |

Stable over two more runs at 131,072 (84 / 50 / 25). Without `--no-liftoff` large chains don't tier up (direct 97,
indirect 134 at 131,072). So in code that doesn't fit the caches the indirect transfer costs ~60 ns more than an
imported tail call, which stays near its warm cost: there the stall is the transfer's dependent loads (table entry,
signature, V8's jump table), not fetching the target's code. That disagrees with the reading of "M8: guest calls as
host calls" (the stall moved to the continuation's code), which was a different change (host calls and returns,
12-32% more code); the microbenchmark's bodies are small and alike, a browser's aren't.

**What it changes in the backlog**: re-emitting hot regions whose jump-cache tails now lead to compiled code (as
imported tail calls) is the most promising lever (entries 22% of the samples, 27-29% in steady state); the block
interpreter's cost in page loads (13% of the samples) is the second; Liftoff's zero-fill (Liftoff's bodies 6.3%), an
exit's cost, the cache's lock and the 320 MiB budget fell to under 1% each in this session.

## Relinking a region once its successors are compiled (2026-11-05)

The backlog's "Tails into code that was cold when its predecessor was compiled", built and measured. The dev VM,
Chromium 155.0.8059.84, core `6abf0919`; Firefox's pages session from `target/snapbench/pages.waarm64snap` (4 vCPUs)
through `bench/gpu/ab.sh`. Data, patches and summaries in `results/m9-relink/` (README).

**What the indirect entries are** (a diagnostic core counting each `return_call_indirect` taken by kind, `count.patch`,
one session, `counts-session/`): of 3.84 G indirect entries plus 0.19 G from the dispatcher,

| kind | entries | share |
|---|---|---|
| RET, through the transfer cache | 1,964 M | 48.7% |
| a static successor not compiled when its predecessor was, through the jump cache | 470 M | 11.7% |
| BLR | 454 M | 11.3% |
| a successor in another page not compiled then, by its VA (transfer cache) | 407 M | 10.1% |
| the dispatcher | 191 M | 4.7% |
| a tier-up redirect (a head compiled alone, entered through a direct link made before its region) | 145 M | 3.6% |
| BR | 108 M | 2.7% |
| the miss function, after a fill | 102 M | 2.5% |

Direct tail calls taken: 1,755 M, and 969 M behind the instruction-TLB check. So re-linking can reach at most the
22% that are static tails and by-VA links; returns are half.

**A typed table** (`(ref null $t)` defined in the module, so V8 could skip the signature check): no faster in
`chain.mjs` at 131,072 functions (85 ns, the funcref table's 86; `chain2.mjs`). An imported tail call stays at 25 ns
there even with its instances scattered through the heap: V8 keeps an import's target in the calling instance's data,
which the function has in cache already.

**The mechanism** (`relink.patch`, ABI 61 there): a forward region's hot word (its slot's, unused outside tier-ups)
counted the jump-cache tails and by-VA links it took; the hit that reached zero called `jit_relink(vcpu, key)`, which
queued the region; the next batch formed it again from its recipe (head VA, members' VA and key) and emitted it with
the successors compiled since as imports, and each table, once it installed that module, repointed the key's
jump-cache and known entries from the old index to the new one (where they still held the old). Once a region.
Tested (a new `tests/jit.test.ts` case and the two-page MMU case with relinking, a planted off-by-one caught by both).

**A/B**, one round each and the base twice (`summary.txt`; busy MIPS from `bench/gpu/stalls.ts`, RSS the renderer's
in MB, loads in ms: wiki / mdn / github / bbc / hn):

| | busy MIPS | wasm (MiB) | relinks | RSS median / max | loads |
|---|---|---|---|---|---|
| no relinking | 212, 205 | 126.7, 126.3 | 0 | 3,692 / 3,978, 3,668 / 3,885 | 9105/3954/2897/11285/2512, 10240/4120/2990/11517/2772 |
| after 256 hits | 200 | 141.2 | 10,113 | 3,791 / 4,129 | 10795/4563/3060/10914/2866 |
| after 64 hits | 187 | 139.8 | 10,477 | 3,758 / 4,001 | 15121/4950/3380/12974/3081 |

Stopped after that (the second round's r256 session cut short): nothing gained, 11% more wasm, 3% more RSS, and the
more eagerly it relinks the slower. A relinked region is new code: it starts in Liftoff again, and its old copy
stays in use through its direct importers and the transfer cache's entries (two copies of hot code). Not kept
(docs/jit.md "Tried and not kept"). **On the Mac host too** (2026-11-05, after "What a function's size costs, in the
VM and on the Mac" showed code size costs nothing there; Chrome for Testing 157, `bench/gpu/sway-mac.sh`, the patch
built at ABI 60, `mac/`): busy MIPS 304 at HEAD (304-306 in its five Mac sessions that night) against 296 after 256
hits, 127.3 against 144.3 MiB of wasm; stopped after that round. Not tried: rebinding a module's imports by instantiating it again (no new code,
V8 shares the compiled code between instances), which needs an import stub per uncompiled successor and
re-instantiation in every table.

## What a function's size costs, in the VM and on the Mac (2026-11-05)

Whether shrinking the JIT's code (the backlog's "Where the JIT's wasm bytes go") can pay, measured from the other
side: every JIT function made bigger by a known amount. The dev VM (Chromium 155.0.8059.84) and the Mac host (Chrome
for Testing 157.0.8103.38, its GPU, `bench/gpu/sway-mac.sh` with `SCRIPT=firefox-load.ts`), both from
`pages.waarm64snap`, core `b7a813d0`; data in `results/m9-size/` (README).

**The microbenchmark first** (`results/m9-relink/chain2.mjs`, Node 26.7.0, `--no-liftoff`): at a fixed number of
functions, a `return_call_indirect` gets slower as each function's cold padding grows (32,000 functions: 24.6, 29.7,
41.7 ns at 0, 40, 200 padding ops; 131,072: 41.8, 84.4), with `--no-wasm-lazy-compilation` too (30.0 and 54.5 ns at 0
and 200), and the padding hinted unlikely barely helps (52.7 → 48.5 ns: TurboFan moves cold code to its function's
end, but the next function's hot code comes after it). An imported tail call stays at 18-26 ns at every size. A
padding op is ~6.7 bytes of TurboFan code (200 of them: 208 → 1,552 bytes).

**Real functions are big:** in Firefox's pages session (the 2026-11-04 jitdump) 217,248 TurboFan compiles averaged
4,958 bytes of machine code (median 2,880) and 425,472 Liftoff ones 5,923. In the 40 hottest functions (7.5 KB on
average) the stores' bounds checks (`sub`, `cmp`, `b.hs`) are 15.8% of the instructions and their trap stubs 6.3%:
code macOS and x86_64 don't have (guard pages there); a `call_indirect`'s signature sequence ~6.8%.

**The A/B:** 150 dead ops at every function's entry behind `left == 0x7ffffff1` hinted unlikely (`pad.patch`), ~1 KB
of TurboFan code a function (+~20%), +52% wasm. Two rounds each, alternated (busy MIPS from `bench/gpu/stalls.ts`;
loads in ms, wiki / mdn / github / bbc / hn; RSS the renderer's, VM only):

| | busy MIPS | wasm (MiB) | loads | RSS median |
|---|---|---|---|---|
| VM, HEAD | 215, 213 | 126.8, 126.5 | 9262/4190/2787/10488/2395, 9294/3836/2644/10846/2535 | 3,695, 3,686 |
| VM, padded | 204, 207 | 192.7, 191.6 | 10315/4342/3033/11189/2861, 10790/4904/2750/11016/2530 | 3,775, 3,663 |
| Mac, HEAD | 304, 305 | 127.1, 126.9 | 6616/2893/1949/6638/1645, 7062/2689/1863/6811/1613 | |
| Mac, padded | 304, 306 | 198.4, 197.1 | 7116/2922/1792/6834/1619, 6790/2708/1770/7108/1653 | |

In the VM 20% more machine code costs 3.5% (rounds apart), on the same M4 without the VM nothing: the VM's code is
denser with bounds checks and its instruction-TLB misses cost more (nested paging), and neither reaches a macOS or
x86_64 user. So shrinking the JIT's code is not a lever for users; cuts aimed at it are measured on the Mac first. A
first cut was built and set aside without an A/B (`nzcv-helpers.patch`: the failure chains' and slow arms' NZCV
through four small functions of the module, not exported; the JIT tests and the differential test pass).

**Notes for the Mac:** `sway-mac.sh` now takes `WASM=` (a core) and `FROM_SNAPSHOT=` (copied once) and copies the
image to its own path there, since a snapshot loads only with the disk it was taken on open, by its URL
(`otherDisk`); `loadSnapshotFile` reports the page's details with its message. On the Mac's GPU the guest's kernel
logs `virtio_gpu_dequeue_ctrl_func` errors while Firefox loads pages (`ERR_UNSPEC` to a `CTX_CREATE`, then
`ERR_INVALID_CONTEXT_ID` to that context's `CTX_ATTACH_RESOURCE` and `SUBMIT_3D`), and they garble the console line the harness reads the loads from (results.json's `loadMs`
holds them): backlog, graphics.

## Chromium's own share of a vCPU thread, by its callers (2026-11-05)

"Where a busy vCPU's time goes in Firefox, again" left 9.3% of the vCPU threads' samples in Chromium's binary
unexplained: openSUSE ships no debuginfo for its aarch64 Chromium (`repo-debug` has none) and the binary has no symbols
at all. The callers say instead: a pages session from the snapshot under `--perf-prof` with `perf record -g` (V8's
code keeps frame pointers, `results/m9-native/run-g.sh`), and for each sample whose leaf is in Chromium, libc or the
vDSO, the first JavaScript or wasm frame above it, resolved against the jitdump (`callers.mts.txt`). The dev VM,
Chromium 155.0.8059.84, core `9becded1`; 454,630 vCPU-thread samples (`callers.txt`):

| first frame above a native leaf | share of the vCPU threads' samples |
|---|---|
| `runCpu` (web/vcpu-worker.ts), JavaScript | 5.38% (+0.19% in its other tiers) |
| `jit::steps` (the core's dispatcher) | 1.62% |
| web/vm.ts's JIT host (`install`: a module instantiated and put in the table) | 1.40% + 0.15% |
| unresolved, guest code, the rest | ~1.5% |

The leaves: Chromium 9.26%, the vDSO 1.34%, libc 0.47%. What `runCpu` itself calls is its idle path: a vCPU that
went idle polls its wake word with `performance.now()` (the vDSO's clock) for up to `SPIN_MS` (50 µs) and then
sleeps in `Atomics.wait`. That is outside `vm_run_cpu`, so it costs host CPU, not busy MIPS (busy time is the time
inside it). So none of the 9.3% is a lever for a busy vCPU's speed: instantiating modules (1.5%) is the part on the
busy path, and the dispatcher's 1.6% is V8's runtime under the core's own calls (not attributable without symbols).

## Guest calls as host calls, again: +10% on the Mac, Firefox lost in the VM (2026-11-05)

"M8: guest calls as host calls" (2026-10-16) was not kept on the dev VM's numbers: the returns' entry stalls moved
into the callers' bodies, and 23% more wasm cost a third flush then. Two things changed: code size costs nothing on
the Mac ("What a function's size costs, in the VM and on the Mac"), and from the snapshot the session doesn't flush.
October's last variant (`results/m8-calls/host-calls.patch`: a BL/BLR a wasm `call` below a depth of 64, a `ret`
at a depth above 0 a wasm `return` flagged `RETURNED`, a call's continuation a member and an entry of its caller's
region) ported to `517ef961`, on branch `wip/host-calls` (XF-HANDOVER.md).

**The port's bug:** its call depth's local (118) had become `FZOK`'s (FPCR.FZ clear) since October, so a block's FP
guard overwrote the depth and a `ret` at depth 0 returned as a host call's; the dispatcher added the flagged result
to its counts (the sound kernel's boot 91 M steps against 36.5 M, the litmus 3.65 G against 882 M; a first Mac run
read 755 busy MIPS). The depth is local 128 now (the encoder's placeholders go to 255 and compact under 128). Then
every Linux boot test (exact steps), the parallel boots, the JIT tests, the differential test and lockstep pass.

**Firefox's pages session on the Mac host** (Chrome for Testing 157, its GPU, from `pages.waarm64snap`; `a2272932`, two
rounds alternated, `results/m9-hostcalls/mac/`):

| | busy MIPS | wasm (MiB) | loads (ms: wiki / mdn / github / bbc / hn) |
|---|---|---|---|
| HEAD | 302, 305 | 126.8, 127.0 | 7195/2798/1888/6653/1669, 6880/2862/1970/6825/1546 |
| host calls | **332, 336** | 131.8, 132.2 | 6763/2565/1593/6432/1445, 6054/2593/1603/5752/1360 |

+10% busy MIPS with the rounds apart, every page faster (6-19%), 4% more wasm.

**In the dev VM** (the same cores, `bench/gpu/ab.sh`, `results/m9-hostcalls/vm/`) the first host-calls session lost
Firefox: its process was gone in both page windows (the guest's kernel and sway ran on), the pages timed out and the
session hit its 900 s bound. A guest-visible bug the boots, the differential test and lockstep miss. The second
host-calls session ran through: busy MIPS 236 against HEAD's 215 and 210 (+11%), the renderer's RSS median 3,629
against 3,678 and 3,693 MB, 131.2 against 126.4 MiB of wasm, loads 10133/3849/2707/9140/2203 against
9295/4105/2992/10574/2660 and 9567/4887/2696/11120/2563. So the gain holds in the VM too; the loss of Firefox (1 of 3
host-calls sessions that night, 0 of 2 on the Mac) is what blocks it.

**The out-of-context review** (on `a2272932`): five findings, in the branch's commit `337228d7`. The stale-code
checker missed a host return's continuation (fixed, its test failing first) and an entry at a member's later
members (its test written; the fix in `Cache::install` doesn't make it pass yet); a region using every local index
would overflow 128 locals now; `MAX_DEPTH` 64's host stack is unmeasured in Chromium; table indices aren't asserted
under 2^24. Not merged: XF-HANDOVER.md has the order.

**After the review** (the branch at `be42d12f`: findings 1, 2, 3 and 5 fixed, each with its test; `scripts/ci.sh` and
`scripts/ci-debian.sh` pass there): three VM sessions with the fixes' first core ran through (busy MIPS 224, 233,
231), and four alternated rounds against HEAD (`results/m9-hostcalls/vm4/`):

| | busy MIPS | wasm (MiB) | RSS median (MB) |
|---|---|---|---|
| HEAD | 207, 212, 213, 210 | 126.4 | 3,618, 3,703, 3,688, 3,683 |
| host calls | **235, 234, 230, 236** | 130.6-131.2 | 3,679, 3,668, 3,660, 3,696 |

+11% with every round apart, no more memory, every session's Firefox up: 1 lost of 10 host-calls sessions in the VM,
none of the last 7.

## The host stack that host calls take, and merged (2026-11-05)

The review's finding 4: `MAX_DEPTH` 64 host-call frames sit on the vCPU worker's V8 stack, plus whatever a helper
does at the deepest (`jit_hot` can emit and install a tier-up there). Measured in Chromium 155.0.8059.84 (the dev VM,
arm64) with `results/m9-hostcalls/stack/` (`run.ts [js-flags]`): in a dedicated worker, a guest (`guest.s`) recurses
100 deep through a block that ends in the `BL` and uses all 32 V registers and the FMA's locals, and a JS function
pads the stack under the run. Each number is the deepest padding (frames of ~80 B: `calib.ts` in Node, 12,717 at
`--stack-size=1000` and 25,517 at 2000) under which the run still fits; a fresh machine each probe:

| | default tiering | `--liftoff-only` | `--no-liftoff` |
|---|---|---|---|
| an empty call | 5,322 | 5,322 | 5,322 |
| the dispatcher alone (`brk`) | 5,300 | 5,300 | 5,300 |
| recursion 16 / 32 / 64 / 100 deep | 5,249 / 5,196 / 5,215 / 5,214 | 5,247 / 5,193 / 5,087 / 5,083 | 5,279 / 5,257 / 5,215 / 5,213 |
| batch 4, warm / with the tier-up in the run | 5,084 / 5,081 | 5,081 / 5,080 | 5,170 / 5,170 |

So a worker leaves ~425 KB under the dispatcher. Under Liftoff a host-call frame of this block costs ~3.4 padding
frames (~270 B), linear to 64 and flat past it (tail calls): ~17 KB, 4% of the headroom; TurboFan about half. A
function using every local (38 v128, ~90 others, all spilled in Liftoff) would be ~1.6 KB a frame, ~100 KB at 64, a
quarter of it. The tier-up emitted and installed during the run (the stats: 0 tier-ups after the warm-up, 1 after)
added nothing measurable. `MAX_DEPTH` stays 64. A stack overflow would be a `RangeError` in the vCPU worker (the
machine stops), not a guest process lost, so it doesn't explain the VM session that lost Firefox.

**Merged** into main (`f0e8c112`) on the user's call after they ran the branch themselves. The lost Firefox (1 of 10
VM sessions, none since) stays in docs/backlog.md with what to read if it recurs.


## Rebinding a module's tails once their blocks are compiled: 5% slower (2026-11-05)

The backlog's untried idea for the tails into code that was cold when its predecessor was compiled (22% of the
indirect entries: "Relinking a region once its successors are compiled"): instead of emitting the region again,
instantiate its module again with the successor bound as an import, since V8 shares a module's code between its
instances. Built on branch `wip/rebind` (`results/m9-rebind/rebind.patch`, README):

- **A site** a tail to a successor not compiled yet: the module imports a function `s.<n>`, an i32 global `g.<n>`
  (the bound block's length, `0x7fffffff` unbound) and, for a link by VA, an i64 global `h.<n>` (the host address the
  VA must map to). The tail calls the import when `left` covers both blocks (and the VA maps there), else goes on
  through the jump or transfer cache as before.
- **The binding:** the cache keeps the sites waiting by key or VA; a module whose head is one logs a rebinding after
  itself (a site by VA also binds at once to a head compiled at that VA already), and each table applies it in order
  (`env.jit_rebind`: the module instantiated again with its bindings and its `t` imports resolved again, its functions
  set back in their slots). The regions leaving for a bound block go with it (`Cache::linkers`).
- Tested: a lap of a three-module loop takes one transfer through the table instead of two (every JIT slot wrapped
  in a counting function), a rebound site dropped with its block after an IC, by VA with the page remapped; four
  planted bugs caught. `scripts/ci.sh` passed (once of two: the first run's parallel litmus and stress in Chromium
  timed out at 300 s, not seen again in 30 runs alone nor the second CI run).
- **A limit found writing the tests:** an instance imports only instances that exist, so a loop through several
  modules keeps one indirect edge a lap.

**Firefox's pages session on the Mac host** (Chrome for Testing 157, from `pages.waarm64snap`; arms built from the same
source, so the host and ABI are the same; `results/m9-rebind/mac/summary.txt`):

| | busy MIPS | wasm (MiB) | rebindings logged / applied | their time (ms, 4 vCPUs) |
|---|---|---|---|---|
| no sites (`WAARM64_NO_REBIND`) | 330, 333, 335; 330, 330 | 131.7-132.5 | 0 | 0 |
| sites, never bound (`WAARM64_NO_BIND`) | 327, 320 | 137.0 | 0 | 0 |
| rebinding | **316, 316, 316** | 137.0-137.1 | 14,200-14,400 / 56,800-57,600 | 3,840-4,000 |

Rebinding ran 5% slower with every round apart, the pages' loads slower in 13 of 15 pairs (wiki 7.2-7.7 s against
6.3-7.1), no vCPU stall to speak of in either (one of 20 ms). The sites' code alone (4% more wasm, a global's load
and a compare before each cold tail's probe) cost ~2%; binding them cost ~3% more, of which applying the rebindings
was ~1.4% of the busy vCPU time (4 s over 4 × 257 s × 0.27). The rest is unexplained (V8 keeps a function's tier-up
budget per instance: a module instantiated again may stay in Liftoff longer; not measured). Not kept: both halves
lose and the bound tails won nothing back (docs/jit.md "Tried and not kept").

## PERF loop 5: FEAT_I8MM (2026-11-10)

USDOT (vector and by element), SUDOT, SMMLA, UMMLA and USMMLA in both tiers, inline in the JIT (docs/jit.md), as
`VmConfig.features` bit 11 (ABI 61). The Mac host (M4, macOS 26.6.2), Chrome for Testing 157.0.8103.50 headless,
through `bench/gpu/sway-mac.sh` (`SCRIPT=../imgdecode/codecs.ts`); the desktop guest on 4 vCPUs, `?i8mm=0` against on,
alternated, a boot per arm and round, each round the median of three runs in a boot. Raw: `results/i8mm/`.

**Who runs it** (the desktop guest's Linux shows `i8mm`; x264 and x265 say `I8MM` in their capabilities). Words in
executable segments: x265 7,900 (5,336 USMMLA), libaom 1,600, Chromium 1,200 (SMMLA, USMMLA, USDOT), libvpx 410,
libavcodec 460, SVT-AV1 530, dav1d 206, libgkcodecs 195, libxul 28. Executed through the JIT (a diagnostic build with
the forms as helper calls, vCPU 0's helper report, each codec under `taskset -c 0`; `results/i8mm/counts.json`):

| Workload | USDOT | USDOT by element | USMMLA | SMMLA |
|---|---|---|---|---|
| dav1d, 200 frames of AV1 | | 5.5 M | 8.6 M | |
| libvpx, 200 frames of VP9 decoded | | 62 M | | |
| FFmpeg, 288 frames of HEVC | 19.5 M | | | |
| x264 veryfast, 96 frames | | 11.5 M | | |
| x265 fast, 24 frames | | 46 M | 21 M | |
| libvpx, 48 frames of VP9 encoded | | 2.1 M | | |
| q8dot's int8 tile | | | | 1.0 M |

None in FFmpeg's VP9 and H.264, libaom's real-time encoder or djpeg (the controls).

**On/off of time** (lower is better), two sessions of three rounds; ms, each round's median, then the median of the
six (q8dot: ns per 16 bytes):

| Workload | Off | On | On/off |
|---|---|---|---|
| dav1d, AV1 decode | 1292 · 1357 · 1370 · 1279 · 1320 · 1269; **1320** | 1412 · 1367 · 1320 · 1256 · 1281 · 1279; **1320** | 1.001 |
| libvpx, VP9 decode | 635 · 639 · 699 · 625 · 739 · 657; **657** | 676 · 667 · 634 · 620 · 639 · 680; **667** | 1.014 |
| FFmpeg, HEVC decode | 1503 · 1410 · 1588 · 1440 · 1430 · 1413; **1440** | 1535 · 1560 · 1500 · 1423 · 1444 · 1440; **1500** | 1.042 |
| x264 veryfast | 2956 · 2890 · 3223 · 2747 · 2822 · 2760; **2890** | 2902 · 3013 · 2737 · 2708 · 2759 · 3170; **2902** | 1.004 |
| x264 medium | 2598 · 2642 · 2581 · 2651 · 2554 · 2593; **2598** | 2612 · 2631 · 2636 · 2567 · 2640 · 2537; **2631** | 1.012 |
| x265 fast | 2365 · 2454 · 2457 · 2395 · 2336 · 2378; **2395** | 2425 · 2476 · 2428 · 2372 · 2395 · 2381; **2425** | 1.013 |
| libvpx, VP9 encode | 812 · 795 · 777 · 774 · 765 · 771; **777** | 801 · 839 · 844 · 749 · 734 · 775; **801** | 1.032 |
| ffvp9 decode (control) | 780 · 784 · 864 · 744 · 761 · 764; **780** | 794 · 825 · 781 · 757 · 761 · 741; **781** | 1.002 |
| h264 decode (control) | 1596 · 1474 · 1692 · 1426 · 1391 · 1403; **1474** | 1524 · 1531 · 1476 · 1394 · 1428 · 1426; **1476** | 1.001 |
| libaom encode (control) | 247 · 252 · 263 · 250 · 241 · 247; **250** | 242 · 248 · 237 · 296 · 241 · 243; **243** | 0.973 |
| djpeg (control) | 121 · 118 · 121 · 116 · 118 · 115; **118** | 118 · 126 · 121 · 116 · 119 · 111; **119** | 1.008 |
| q8dot, one SDOT dot (control) | 1.97 · 1.96 · 1.98 · 1.95 · 1.95 · 1.93; **1.96** | 1.98 · 2.05 · 2.00 · 1.96 · 1.97 · 1.95; **1.98** | 1.012 |
| q8dot, 2×2 int8 tile | 3.21 · 3.18 · 3.23 · 3.17 · 3.15 · 3.16; **3.18** | 3.78 · 3.81 · 3.84 · 3.71 · 3.73 · 3.79; **3.79** | **1.192** |

Every codec's rounds overlap, and the sessions disagree in sign (libvpx's decode 1.044 then 0.972, its encode 1.055
then 0.972); the controls move as much. **The int8 tile is 19% slower, rounds apart in both sessions**: ggml's q8_0 dot
with I8MM (two rows at once, their 64-bit halves zipped into SMMLA) against four SDOTs. In wasm a matrix product is
about 19 host instructions (SMMLA, UMMLA: four `extmul`s of Vn with Vm and with Vm's halves swapped, four
`extadd_pairwise`, six shuffles and three adds to sum each output across) or 22 (USMMLA widens both sides first),
SDOT 8, USDOT 12 (no mixed-sign `extmul`), so two SMMLAs and their four zips (42) lose to four SDOTs (32): a perfect
16-instruction SMMLA would still lose. The codecs' DotProd paths pay for their bias trick about what USDOT costs
over SDOT, hence the tie. On the M4 itself (`q8dot` natively in the dev VM) the tile is slower with SMMLA too: 1.32
against 0.65 ns.

**I8MM stays implemented, off by default** (the rule, PLAN.md: a loss stays unadvertised): `cpu::DEFAULT_FEATURES`,
`bootVm`'s `i8mm: true`, the page's `?i8mm=1`. Nothing a guest sees by default changes: steps and the shape's hash
stay. Memory: none; the core's wasm grows by `inline_i8mm`'s 7.1 KB.

## PERF loop 6: FEAT_RDM and FEAT_LRCPC2 (2026-11-10)

SQRDMLAH and SQRDMLSH (vector, scalar, by element) and LDAPUR*/STLUR* in both tiers, inline in the JIT (docs/jit.md),
as `VmConfig.features` bits 12 and 13 (ABI 62). The Mac host (M4, macOS 26.6.2), Chrome for Testing 157.0.8103.50
headless, through `bench/gpu/sway-mac.sh` (`SCRIPT=../imgdecode/codecs.ts`, mode `<feature>,kernels`); the desktop
guest on 4 vCPUs, `?<feature>=0` against on, alternated, a boot per arm and round, each round the median of three runs
of `bench/imgdecode/rdmk.c` in a boot. Raw and medians: `results/rdm/`, `results/rcpc2/` (`results/rdm/results.json`).

**Who runs them.** Every ELF of the desktop (Arch) and Debian guests, words matching the encodings in executable
segments, then disassembled (`llvm-objdump --mattr=+all`) to drop data: SQRDMLAH/SQRDMLSH only in glycin's image
loader (`glycin-image-rs`, 44 + 44); no codec (dav1d, libvpx, libaom, x264, x265, FFmpeg, SVT-AV1), no browser
(Chromium, Firefox's libxul and libgkcodecs), no library dispatches on `asimdrdm`. LDAPUR/STLUR: one or two `ldapurh`
words in libgnutls, libleancrypto, Chromium and chromedriver, isolated (likely data among the text: none of them
targets v8.4); nothing built for v8.4+. So no workload to count at run time: the A/B is a kernel each, written as libraries write the paths
they pick from the hwcap (`rdmk.c`): a Q15 FIR of 8 taps by element, Q15 and Q31 multiply-accumulates by vector
(SQRDMLAH with `asimdrdm`, SQRDMULH then SQADD without), and a chain of nodes read with two acquire loads at offsets 12
and 16 (LDAPUR with `ilrcpc`, ADD then LDAPR without). The emitters changed no shared path, so no gates.

**On/off of time** (ns per 8 outputs for fir16 and mac16, per 4 for mac32, per node for acquire; lower is better),
three rounds' medians, then the median:

| Kernel | Off | On | On/off |
|---|---|---|---|
| fir16, Q15 FIR by element (`?rdm`) | 10.94 · 11.05 · 10.80; **10.94** | 9.56 · 9.79 · 9.12; **9.56** | **0.874** |
| mac16, Q15 multiply-accumulate (`?rdm`) | 2.96 · 3.07 · 2.94; **2.96** | 2.91 · 3.01 · 2.74; **2.91** | 0.983 |
| mac32, Q31 multiply-accumulate (`?rdm`) | 5.49 · 5.76 · 5.44; **5.49** | 3.37 · 3.46 · 3.26; **3.37** | **0.614** |
| acquire (`?rdm`, a control: both arms LDAPUR) | 4.66 · 5.19 · 4.71; **4.71** | 4.97 · 5.52 · 4.77; **4.97** | 1.054 |
| acquire, LDAPUR against ADD and LDAPR (`?rcpc2`) | 4.96 · 4.80 · 4.61; **4.80** | 4.82 · 5.32 · 4.57; **4.82** | 1.003 |
| fir16 (`?rcpc2`, a control) | 9.11 · 9.10 · 9.10; **9.10** | 9.09 · 9.13 · 9.07; **9.09** | 0.999 |
| mac32 (`?rcpc2`, a control) | 3.26 · 3.28 · 3.26; **3.26** | 3.28 · 3.28 · 3.26; **3.28** | 1.004 |

**RDM is faster, rounds apart**: the FIR by 12.6% (one SQRDMLAH by element, ~11 host instructions with its QC check,
about what SQRDMULH and SQADD take between them, but one guest instruction's register traffic instead of two), the Q31
form by 39% (SQADD on words is lane code here, `simd_lane`, where
SQRDMLAH's i64 lanes are ~30 instructions for all four); mac16 1.7%, rounds overlapping (it streams three arrays: its
loads and stores dominate). The two arms compute the same sums (the kernels' checks agree). **LRCPC2 ties** (+0.3%,
rounds overlapping): the ADD it saves is nothing beside the atomic load and the TLB probe. Both are advertised (PLAN.md's
rule: a tie is advertised): on by default, `?rdm=0` and `?rcpc2=0` for an A/B. Memory: none; the core's wasm grows by
`simd::inline_rdm`'s 12.4 KB, `simd_lane::inline_rdm`'s 0.9 KB and the interpreter's 0.9 KB.

Steps move (guest-visible: the guests' Linux sees `asimdrdm` and `ilrcpc`, prints them and patches its alternatives):
Buildroot −0.01%, Alpine +0.06%, Alpine's userspace +0.06%, LTP −0.25%, crypto −1.0%, USB +3.8%; EDK2 doesn't move.

## PERF loop 7: FEAT_FCMA (2026-11-10)

FCMLA (vector and by element) and FCADD on singles and doubles in both tiers, inline in the JIT through the FMA and
FADD fast paths on shuffled, sign-flipped operands (docs/jit.md "Floating point"), as `VmConfig.features` bit 14 (ABI
63); the half forms are FEAT_FP16's and stay UNDEFINED. The Mac host (M4, macOS 26.6.2), Chrome for Testing
157.0.8103.50 headless, through `bench/gpu/sway-mac.sh` (`SCRIPT=../imgdecode/codecs.ts`, mode `fcma,kernels`); the
desktop guest on 4 vCPUs, `?fcma=0` against `?fcma=1`, alternated, a boot per arm and round, each round the median of
three runs in a boot. Raw and medians: `results/fcma/` (`results.json`; the scan's words in `words.txt`).

**Who runs them.** Every ELF of the desktop (Arch) and Debian guests (`debian`, `-browsers`, `-sway`, `-tools`),
words matching the three encodings in executable segments (2,778 files on Arch, 1,162-1,326 on Debian: almost all
data), then disassembled (`llvm-objdump --mattr=+all`): three FP16 by-element `fcmla` words in libgnutls and
libleancrypto, which are data (`6f727070`, ASCII); no real FCMLA or FCADD anywhere. FFmpeg's TX/FFT, libopus,
FFTW, libjxl and Highway, Mesa, Chromium and Firefox have no FCMA path in these builds. So the A/B is kernels
written as libraries write them, each picking its path from HWCAP_FCMA (`bench/imgdecode/fcmak.c`, run after
`rdmk.c` in the `kernels` mode): a complex multiply-accumulate of interleaved arrays by vector, singles and doubles
(FCMLA #0 and #90, against TRN1/TRN2 (DUP for doubles), REV64, EOR and two FMLAs), a multiply-accumulate by a complex
constant (FCMLA by element, against REV64 and two FMLAs by hoisted constants), and a radix-4 butterfly (FCADD #90 and
#270, against one REV64, EOR, FADD and FSUB). Both arms compute the same sums (the kernels' checks agree).

**On/off of time** (ns per complex output, lower is better), three rounds' medians, then the median:

| Kernel | Off | On | On/off |
|---|---|---|---|
| cmac32, FCMLA vector, singles | 1.987 · 1.975 · 1.977; **1.977** | 1.913 · 1.955 · 1.989; **1.955** | 0.989 |
| cmac64, FCMLA vector, doubles | 3.694 · 3.701 · 3.708; **3.701** | 3.650 · 3.770 · 3.684; **3.684** | 0.995 |
| cgain32, FCMLA by element | 1.579 · 1.584 · 1.580; **1.580** | 1.715 · 1.759 · 1.743; **1.743** | **1.103** |
| fft4, FCADD | 1.358 · 1.352 · 1.348; **1.352** | 1.369 · 1.426 · 1.394; **1.394** | **1.031** |
| rdmk's fir16, mac16, mac32, acquire (controls: the same code in both arms) | | | 0.990, 0.974, 0.971, 0.966 (each pair of rounds overlapping) |

**FCMLA by vector ties** (−1.1% and −0.5%, rounds overlapping): its two instructions do what the v8.0 sequence's six
do, but each is its shuffles of Vn and Vm, a sign flip and the fused `madd` with the checks, so the host work is about
the same. **By element it is 10% slower and FCADD 3% slower, rounds apart**: the v8.0 code keeps the constant's
negated pair in a register and shares one REV64 between the butterfly's two outputs, where each FCMLA by element
shuffles Vn and the element's pair again and loads its sign mask, and each FCADD shuffles and flips its own copy.
So FEAT_FCMA is **implemented, unadvertised** (PLAN.md's rule, like I8MM): off by default, `bootVm`'s `fcma: true` and
the page's `?fcma=1`; no guest-visible change by default, so the steps and the shape's pinned hash stay. Memory:
none.

## PERF loop 8: the helpers left on real paths (2026-11-10)

The backlog's two JIT entries (unmasking MSRs, ISB, LSE min/max; the MSRs that end a block), counted first, then the
ones that can matter inline. Raw: `results/perf8/` (the counts, the diagnostic patch and its decoder `diag.ts`, the
Debian counter `debian-count.ts`, the A/B's JSON).

**Counts** (a diagnostic core: `diag.patch` splits the helper report's MSR and ISB classes by register and EL; Alpine
in Node through `bench/boot/userprof.ts`, deterministic like the gates; Debian on the page in the dev VM, 2 vCPUs,
parallel and realtime, the boot to the login prompt and page-ab.ts's fork/dd workload; Firefox's pages session from
the snapshot on the Mac, 4 vCPUs, summed over the vCPUs):

| Helper calls | Alpine boot (2.1 G steps) | Alpine compress / Lua / churn / SQLite | Debian boot (33 G) | Debian fork+dd (1.2 G) | Firefox pages (96 G) |
|---|---|---|---|---|---|
| MSR DAIF that unmasks | 358K | 19K / 17K / 148K / 18K | 2.65M | 1.75M | 4.94M |
| MSR DAIFClr | 99K | 17K / 11K / 55K / 26K | 201K | 31K | 2.78M |
| MSR DIT, #1 (Linux 6.x, every kernel entry) | 134K | 44K / 58K / 40K / 43K | 687K | 668K | 2.81M |
| ISB | 369K | 398K / 566K / 122K / 386K | 690K | 64K | 13.66M (3.8M at EL0) |
| MRS (all of them; the counter's in Alpine) | 346K | 370K / 517K / 114K / 353K | 67K | 11K | 2.03M |
| timer and GIC MSRs (CNTV_CTL/CVAL, EOIR, SGI1R) | 126K | 142K / 205K / 35K / 137K | 33K | 11K | 2.16M |
| TTBR0/1, FPCR/FPSR | 7K | 13K / 0 / 10K / 0 | 28K | 3K | 0.68M |
| LSE min/max (LD/ST SMAX, UMIN, …) | 0 | 0 | 0 | 0 | 0 |

NZCV and SPSel writes don't show. What each costs differs by mode: in the gates (deterministic, one vCPU) an unmasking
DAIF or DAIFClr is an `Exit::Resync` to the run loop, DIT and the unmasking forms end the block, ISB is a helper call
that does nothing; on the page (parallel, realtime) all of them are helper calls finished in place (`fast`, ~20 ns).

**What changed** (docs/jit.md "Emission", "Blocks and keys"): DAIFClr and `MSR DIT, #imm` inline and no longer ending
a block; an unmasking DAIF write (register or DAIFClr) stays inline while `jit::State::unmask` says the run loop would
find no IRQ (round-robin SMP: the GIC signals none to the vCPU as of the chunk's start, and nothing raises one inside a
chunk but an exit; not while the xHCI has an event due, whose tick runs between chunks: the first CI run's USB guest
parted from its interpreter run without that); parallel SMP: the chunk has fast completions and the vCPU's IRQ byte reads 0); ISB inline outside
parallel SMP. Steps don't move (checked: Alpine 2,652,860,340 and the userspace benchmark 10,612,856,957 as in
tests/steps.txt). Planted bugs: DIT's bit and DAIFClr's mask each fail the differential test (81 and 102 of 4,096
words; it now generates DIT too); ignoring the gate moves both Alpine counts (2,649,165,359; 10,607,750,636); the
inline ISB without its PC store hangs Alpine's boot after "Switched to clocksource" (a one-word block of it looped).
The parallel IRQ byte's check isn't seen by any test (a missed one waits for the chunk's end at most).

**The gates** (the Mac host, M4, macOS 26.6.2, Chrome for Testing 157.0.8103.50 headless; `bench/interp/ab-mac.sh perf8
3 base=… new=… -- boot_alpine_jit alpine_user_jit`, arms alternated; ms, each round's median):

| | base (`eac874a4`) | new | |
|---|---|---|---|
| `alpine_jit_total` | 3,934 · 4,004 · 4,027; **4,004** | 3,890 · 3,928 · 3,932; **3,928** | **−1.9%**, rounds apart |
| `alpine_user_jit_total` | 11,087 · 11,202 · 11,196; **11,196** | 11,370 · 11,057 · 11,048; **11,057** | −1.2%, overlapping (new's first round) |
| churn (the most DAIF writes) | 799 · 808 · 822; **808** | 802 · 782 · 776; **782** | −3.2%, overlapping |
| compress / Lua / SQLite | | | −0.4% / −0.6% / 0.0% |

The boot's 76 ms against ~0.6M exits and block ends removed is ~130 ns each, about what an exit to the run loop costs.
**Kept.** Memory: 8 bytes a vCPU (`jit::State::unmask`); `emit::msr` 3,900 → 3,865 B, `emit::daif` 1,937 B.

**Not A/B'd on the page**: there the removed calls were fast-completed helpers, ~10.5M in the pages session at ~20 ns,
~0.2 s of its ~100 vCPU-seconds: under what that session resolves. **Left as helpers** (docs/jit.md "What still runs
through helpers"): ISB in parallel SMP (13.7M in the pages session, ~0.3 s; inline it needs every condition `fast`
checks, several of which change mid-chunk), LSE min/max (nothing runs them), the regime's and FP control's MSRs
(context switches), the timer and GIC registers (the run loop's). The deterministic counter reads (0.35-0.52M a phase,
each a full exit) are the gates' next lever, in docs/backlog.md.
CI: `scripts/ci.sh` (its second run; the first found the xHCI case above), `scripts/ci-jit.sh` and
`scripts/ci-debian.sh` passed.

## PERF loop 9: the review's fixes (2026-11-10)

An out-of-context static review of loops 1-8 (`review/perf`, deleted once triaged) found no wrong result; four
findings, all about loop 8's inline unmask. Each fix began with a test that failed on `15c0dc69`.

1. **Realtime round-robin delayed IRQs after an unmask (real; fixed).** `Vm::run` set `jit::Unmask::ok` in realtime
   mode too, where chunks don't end at deadlines and devices signal at any time, so a timer that came due under the
   mask was taken at the chunk's end, not at the unmask. New bare-metal test `tests/baremetal/unmask.c` (`// round-robin`:
   not run in parallel SMP, and run in realtime round-robin under the JIT by `tests/boot-node-suite.ts`): CNTV comes
   due 0.32 µs into a 4K-step masked spin, then DAIFClr or MSR DAIF, Xt in turn; the IRQ must come within 16
   instructions. On main: exit 11 or 12 every run (a diagnostic build: 1,088 of 3,000 reps late, up to 5,753
   iterations). Fix: `ok` is 0 in realtime mode, as before loop 8 there. Realtime round-robin is Node's runners and
   the I/O and script benchmarks: not the gates (deterministic) and not the page (parallel). QEMU TCG takes this IRQ
   late too (its timer raises the line from its main loop), so the bound is ours: the oracle builds check only that
   the IRQ comes (TCG and hvf pass).
2. **Parallel SMP's inline unmask skipped `fast`'s queue check (real, latency; fixed).** With another vCPU's TLBI IS
   queued, the unmask used to end the chunk and drain it; inline, that vCPU's DSB waited for this one's next drain
   point (up to a chunk). `jit::Unmask` gains `pending` (`CpuPar::pending`), and parallel blocks load that byte too:
   one more atomic byte load per DAIF write and 4 bytes a vCPU. The published ASID stays unchecked: a DAIF write
   isn't context synchronization, and the ISB after a TTBR write ends the chunk (the comment now says so).
3. **The inline arm had no differential test (real; fixed).** New exports `jit_unmask` and `jit_parallel` (ABI 64)
   let `tests/jit-diff.test.ts` "unmasking DAIF writes inline" (round-robin and parallel) run the arm against the
   interpreter. It also counts helper calls: none with `ok`, every unmask with `ok` 0, the IRQ byte or the pending
   byte. Before fix 2, the parallel case failed with 0 helper calls against 6,295 expected. Planted bugs: the inline
   store keeping the old I bit fails both cases (2,375 and 2,387 of 4,096 words), while the old system-register test
   passes; dropping the IRQ byte's load fails the parallel case (0 helper calls against 6,167).
4. **Stale comments (real; fixed):** `interp/sys.rs` (ERET's note, `PlainWrite::Daif`, `msr_continues`),
   `jit/block.rs` `Next`, `vm.rs` `CHUNK`, `vm/parallel.rs`; and docs/jit.md, platform.md, abi.md and testing.md.

Steps unchanged (deterministic mode untouched; `tests/steps.txt` as it was). **The gates** (the Mac, M4, Chrome for
Testing 157.0.8103.50 headless; `bench/interp/ab-mac.sh perf9 3 base=… new=… -- boot_alpine_jit alpine_user_jit`, arms
alternated; base = `15c0dc69` with only `ABI_VERSION` raised to 64, as the page's JS checks it; ms, each round's
median; raw: `results/perf9/`): `alpine_jit_total` base 3,931 · 3,942 · 3,963 (**3,942**), new 3,948 · 3,949 · 3,950
(**3,949**); `alpine_user_jit_total` base 11,081 · 11,087 · 11,436 (**11,087**), new 11,094 · 11,090 · 11,085
(**11,090**). Overlapping, within 0.2%: no change, as expected (round-robin blocks compile the same; the run loop
gains one branch a chunk). Not measured on the page, where the change is one atomic byte load per DAIF write.
CI: `scripts/ci.sh`, `scripts/ci-jit.sh` and `scripts/ci-debian.sh` passed.

## PERF loop 10: FEAT_FP16 and FEAT_FHM (2026-11-10)

FEAT_FP16 (every half-precision form, scalar and AdvSIMD, FPCR.FZ16, FCMLA/FCADD's half forms) and FEAT_FHM (FMLAL,
FMLSL and the "2" forms, vector and by element) in both tiers, inline in the JIT for the arithmetic, FMA, min/max,
compare and bit forms (docs/jit.md "Half precision"), as `VmConfig.features` bits 15 and 16 (ABI 65; FHM only with
FP16). The Mac host (M4, macOS 26.6.2), Chrome for Testing 157.0.8103.50 headless, through `bench/gpu/sway-mac.sh`
(`SCRIPT=../imgdecode/codecs.ts`, mode `fp16k`); the desktop guest on 4 vCPUs, a boot per arm and round, arms
alternated, each round the median of three runs of `bench/imgdecode/fp16k.c` in a boot. FP16: `?fp16=0` against
`?fp16=1` (FHM off in both); FHM: `?fp16=1` in both, `?fhm=0` against `?fhm=1`. Raw and medians: `results/fp16/`,
`results/fhm/` (`results.json`; the scan in `words.txt`).

**Who runs them.** Every ELF of the desktop (Arch) and Debian guests (`debian`, `-browsers`, `-sway`, `-tools`),
words matching the FP16 and FHM encodings in executable segments (2,458 files on Arch, nearly all data), then each
such file disassembled (`llvm-objdump --mattr=+all`; Chromium, libxul and libLLVM whole): FP16 only in Highway's
`vqsort` on `float16_t` (libhwy_contrib, per-target code) and VapourSynth's filters (with 1,588 FMLAL lines); a few
isolated words in libgnutls, libleancrypto and glycin are data. No codec, browser, Mesa or ML runtime in the images
has an FP16 or FHM path. So the A/B is kernels written as fp16 libraries write them, each picking its path from
`asimdhp`/`fphp`/`asimdfhm` (`fp16k.c`): an axpy on halves in memory (FMLA .8h by element, against FCVTL/FCVTL2,
two FMLA .4s, FCVTN/FCVTN2), a dot product (half accumulators, ggml's F16 vec_dot on fp16 arithmetic, against the
halves widened into single accumulators), a 4×8 GEMM tile by element (XNNPACK's f16 shape: FMLA .8h by A's lanes,
against B's row and A's column widened and eight FMLA .4s by element), a scalar `_Float16` Horner (FMADD h, against
FCVT, FMADD s, FCVT), and FHM's dot product and tile in single accumulators (FMLAL/FMLAL2, vector and by element,
against the v8.0 widening; both arms compute the same sums: the checks agree).

**On/off of time** (ns per output or element, lower is better), three rounds' medians, then the median:

| Kernel | Off | On | On/off |
|---|---|---|---|
| axpy16, FMLA .8h by element (`?fp16`) | 0.947 · 0.944 · 0.946; **0.946** | 0.690 · 0.690 · 0.694; **0.690** | **0.729** |
| dot16, half accumulators (`?fp16`) | 0.580 · 0.576 · 0.579; **0.579** | 0.612 · 0.617 · 0.615; **0.615** | **1.062** |
| gemm16, a half tile by element (`?fp16`) | 0.261 · 0.263 · 0.264; **0.263** | 0.539 · 0.541 · 0.540; **0.540** | **2.053** |
| poly16, scalar FMADD h (`?fp16`) | 4.824 · 4.804 · 4.759; **4.804** | 10.303 · 10.355 · 10.303; **10.303** | **2.145** |
| dotw, gemmw (`?fp16`, controls: v8.0 code in both arms) | | | 1.003, 1.034 |
| dotw, FMLAL/FMLAL2 (`?fhm`) | 0.579 · 0.585 · 0.597; **0.585** | 0.488 · 0.488 · 0.491; **0.488** | **0.834** |
| gemmw, FMLAL by element (`?fhm`) | 0.249 · 0.250 · 0.247; **0.249** | 0.336 · 0.334 · 0.337; **0.336** | **1.349** |
| axpy16, dot16, gemm16, poly16 (`?fhm`, controls: FP16 code in both) | | | 0.994, 0.970, 0.982, 0.982 |

Every bold pair's rounds are apart. **FP16 wins where the v8.0 code converts both ways around a single operation**
(the axpy: one FMLA .8h for FCVTL ×2, FMLA ×2, FCVTN ×2) **and loses where the halves are computed on** (the tile 2.05×,
the scalar Horner 2.1×, the dot product 6%): a half operation here is its operands widened to singles exactly, the
single operation and the rounding back with its checks, about 50 lane ops an FADD .8h against 5 an FADD .4s, so
code that widens once and computes in singles is cheaper than code that stays in halves. **FMLAL by vector wins
17%** (it fuses two FCVTLs into the multiply-add) **and by element loses 35%**: the tile's eight FMLALs each widen
the same B row again, where the v8.0 tile widens it once a step. The controls move up to 3.4% (gemmw under `?fp16`,
the same code in both arms), so the 6% dot product is near that noise; the 2× and 35% are not. The first FP16 build
ran the axpy 9.6× slower: every FMA whose single sum lands on a half's midpoint went to the helper, and exact sums
of short significands (y + x·2^-7) do that all the time; the branch that lets exact midpoint sums through
(docs/jit.md "Half precision") fixed it. **Both stay implemented, unadvertised** (PLAN.md's rule: the GEMM shapes,
fp16 inference's main use, are slower): off by default, `bootVm`'s `fp16: true` and `fhm: true`, the page's
`?fp16=1` and `?fhm=1`; no guest-visible change by default, so steps and the shape's pinned hash stay. Memory: none.

Correctness: corpus groups `fp16` (12,820) and `fhm` (2,300) on the M4 and QEMU (QEMU 11 disagrees on 60 and 8; we
match the M4 on all); `tests/jit-diff.test.ts` classes for every FP16 and FHM class plus FP edge cases (a half
midpoint sum, ±0 and negatives a last place apart for FMAX/FMIN/FCMGE); the FP suite extended to 766 forms (every
FP16 form and FMLAL/FMLSL(2) on TestFloat's f16 cases, under FZ16 too) passes natively on the M4 (766M checks) and in
the guest under the JIT, both FMA arms. Found by it: FPCR dropped FZ16 on MSR (`cpu::fpcr_mask` keeps it with FP16);
the corpus and jit-diff set FPCR directly and missed it. Planted, each failing: the narrowing's rounding constant,
the FMA midpoint test (jit-diff's scalar class and edge cases, the FP suite's FMA forms), the exact-midpoint test,
the min/max key's inverse, the compare key, the by-element index, FHM's "2" half, FZ16's guard, the finite test. The
decoder sweep: 0 mismatch classes (FP16 and FHM out of `NOT_OURS`). CI: `scripts/ci.sh`, `scripts/ci-jit.sh`,
`scripts/ci-fp.sh` passed.

## PERF loop 11: FEAT_BF16 (2026-11-10)

FEAT_BF16 (BFCVT, BFCVTN/BFCVTN2, BFDOT and BFMLALB/T vector and by element, BFMMLA) in both tiers, inline in the JIT
(docs/jit.md "BFloat16"), as `VmConfig.features` bit 17 (ABI 66). The M4 has FEAT_BF16 and not FEAT_EBF16
(`hw.optional.arm.FEAT_EBF16: 0`; the oracle VM's `bf16`, no `ebf16`), so BFDOT and BFMMLA are BFDotAdd's standard
behavior: FPCR ignored, no flags, denormals flushed, the default NaN, every step rounded to odd, and an exact sum
from 2^128 infinite (probed on the M4: `0x7f7fffff + 0x7f7f·1` gives `0x7f800000`, where FPRound's round to odd would
give the largest finite). The Mac host (M4, macOS 26.6.2), Chrome for Testing 157.0.8103.50 headless, through
`bench/gpu/sway-mac.sh` (`SCRIPT=../imgdecode/codecs.ts`, mode `bf16k`); the desktop guest on 4 vCPUs, `?bf16=0`
against `?bf16=1`, a boot per arm and round, arms alternated, each round the median of three runs of
`bench/imgdecode/bf16k.c` in a boot. Raw and medians: `results/bf16/` (`results.json`; the scan in `words.txt`).

**Who runs it.** Every ELF of the desktop (Arch) and Debian guests (`debian`, `-browsers`, `-sway`, `-tools`,
`-vulkan`): 566 files have words of BF16's encodings in executable segments (libopus 478, gtk4-demo 233, libavcodec
82, libLLVM 75, …), and disassembled (`llvm-objdump --mattr=+all`) none has a BF16 instruction: the words are data.
No browser, codec, Mesa or ML runtime in the images has a BF16 path. So the A/B is kernels written as bf16 libraries
write them, each picking its path from HWCAP2_BF16 (`bf16k.c`), against XNNPACK's "neonfma-shland" (a bfloat16
widened by a shift or a mask, FMLA .4s): a dot product with BFDOT and with BFMLALB/T, a 4×8 GEMM tile (K = 64) with
BFMMLA on KleidiAI's packing and with BFDOT by element on XNNPACK's, singles to bfloat16 in memory with BFCVTN/BFCVTN2
against the integer rounding to nearest even with NaNs quieted, and the same one value at a time (BFCVT, as a
`(__bf16)` cast compiles); the v8.0 dot product and tile in both arms as controls.

**On/off of time** (ns per output or element, lower is better), three rounds' medians, then the median:

| Kernel | Off | On | On/off |
|---|---|---|---|
| dot, BFDOT | 0.374 · 0.373 · 0.373; **0.373** | 0.550 · 0.553 · 0.551; **0.551** | **1.477** |
| dotl, BFMLALB/T | 0.369 · 0.371 · 0.368; **0.369** | 0.366 · 0.367 · 0.367; **0.367** | **0.995** |
| gemm, BFMMLA | 0.199 · 0.198 · 0.200; **0.199** | 0.519 · 0.519 · 0.518; **0.519** | **2.608** |
| gemmdot, BFDOT by element | 0.197 · 0.198 · 0.196; **0.197** | 0.447 · 0.446 · 0.445; **0.446** | **2.264** |
| cvt, BFCVTN/BFCVTN2 | 0.345 · 0.347 · 0.355; **0.347** | 0.401 · 0.403 · 0.405; **0.403** | **1.161** |
| cvts, BFCVT | 2.225 · 2.224 · 2.258; **2.225** | 2.694 · 2.713 · 2.696; **2.696** | **1.212** |
| dotv8, gemmv8 (controls: v8.0 code in both arms) | | | 1.011, 1.015 |

All but dotl's rounds are apart; the controls move 1.5% at most. Natively on the M4 (the dev VM) BFDOT's dot product
is 3.1× faster than the v8.0 code (0.037 against 0.115 ns) and BFMMLA's tile level with it. **Every BF16 form loses
or ties here:** a BFDOT is the products, two TwoSums and two steps to odd, and the operand and result tests that keep
it off the flushes (about 60 lane ops against 20 for the two widenings and two FMLA .4s it replaces); BFMMLA and BFDOT
by element are worse still, each instruction redoing the shuffles and widening the v8.0 tile does once a step;
BFMLALB/T is FMLA .4s on lanes widened by one op, as the v8.0 code is; and BFCVTN's FPOK, range and zero tests and the
packing shuffle cost more than the six integer instructions per four lanes the v8.0 rounding takes (BFCVT the same
on a whole vector against scalar integer code). **Unadvertised** (PLAN.md's rule): off by default, `bootVm`'s
`bf16: true`, the page's `?bf16=1`; no guest-visible change by default, so steps and the shape's pinned hash stay.
Memory: none.

Correctness: corpus group `bf16` (6,600, M4 and QEMU agree, we match both); the FP suite extended to 777 forms (BFCVT,
BFCVTN(2), BFMLALB/T, BFDOT, BFMMLA on TestFloat's f32 cases and their top halves, against a BFDotAdd written in
fptest.c apart from the core's): 791M checks natively on the M4, no failure, and in the guest (`scripts/ci-fp.sh`);
`fp::tests::bf_dot_add_edges` (the M4's results for overflow, flushes and zero signs); `tests/jit-diff.test.ts`
classes for the seven forms, a BF16 sequence and edge cases (sums to odd, the operand bound, BFCVTN's boundaries,
a product below the singles' range in BFMLAL). Planted, each failing its classes: BFCVTN's rounding constant, its
boundary, BFCVTN2's kept half, the operand bound, the away test and the odd bit of the step to odd, BFMMLA's pair
order, the by-element index (BFDOT's, BFMLAL's), a product's operand, BFMLAL's B/T, the Q = 0 mask; the 2^126 bound on
Vd (loosened to the finite range) fails nothing: it's a margin (a 400M-case search found no TwoSum overflow with a
finite sum). The decoder sweep: 0 mismatch classes (BF16 out of `NOT_OURS_PREFIX`), the system sweep too.
CI: `scripts/ci.sh` passed but for the known clipboard-toolbar timeout (`tests/page-clipboard-ui.test.ts`, passing
alone right after), `scripts/ci-jit.sh` and `scripts/ci-fp.sh` passed.

## PERF loop 12: FEAT_LSE2 (2026-11-10)

The backlog's last unadvertised M4 extension, FEAT_LSE2 (`ID_AA64MMFR2_EL1.AT` = 1, Linux's `uscat` hwcap), weighed
and **dropped**: it can't be both correct and cheap under parallel SMP, and nothing in the guests would use it. Raw:
`results/perf12/` (the prototype's patch `pairs16.patch`, the scan `pairops-desktop.txt`, the A/B's JSON).

**What LSE2 promises** (the ARM ARM's single-copy atomicity rules and `AArch64.UnalignedAccessFaults`): every load
and store whose bytes lie in one aligned 16-byte granule is single-copy atomic, misaligned or not (to Normal
write-back memory); LDP/LDNP/STP of two X registers aligned to 16 bytes are one single-copy-atomic 16-byte access;
exclusives and LSE atomics don't fault misaligned inside a granule (across one they still do); LDAR/STLR/LDAPR and
LDAPUR/STLUR inside a granule don't, and across one fault only while `SCTLR_ELx.nAA` is 0. Guests use the pair rule:
libatomic's `__atomic_load_16`/`__atomic_store_16` (ifuncs, GCC 13+) become a plain LDP/STP with barriers on
`HWCAP_USCAT`, where without it they're LDXP/STXP loops; its compare-exchange stays CASP.

**Why not correct and cheap.** An LDP or STP that is a 16-byte atomic has to be atomic against CASP and STXP too,
which wasm can't give: it has no 128-bit RMW. Our pair ops (docs/cpu.md "Memory accesses and atomics") take a lock
only other pair ops take and write the halves with two 64-bit CASes; an LSE2 LDP between those CASes would read the
new low half with the old high one (the case that design leaves uncovered because no guest reads pairs that way: with
LSE2 libatomic's every 16-byte load does). Writing a CASP's new pair as one 16-byte store instead closes that and
opens another: an STP between the CASP's read and its store is lost while the CASP reports success. Closing either takes every
16-byte-aligned LDP/STP (every frame's `stp x29, x30, [sp, #-16]!`) into the lock or a check of it, or a stop of the
other vCPUs per pair op, which docs/cpu.md already rejects at SLUB's one CASP per ~10K instructions. Misaligned atomic
RMWs inside a granule but across an 8-byte boundary have the same problem (no wasm atomic spans them); those inside an
aligned 8 bytes could be an i64 CAS loop. The interpreter would also need its misaligned accesses inside a granule
as one host access, which its split relaxed atomics aren't (a 16-byte one needs `simd128`, which the core is built
without).

**Who would use it.** Every ELF of the desktop guest (Arch: `/usr/lib`, `/usr/bin`, 3,149 files, disassembled) for
CASP/LDXP/LDAXP/STXP/STLXP on X pairs, the 16-byte atomics a guest makes: libatomic (39, its own variants), Chromium
(6), libtsan, Firefox's crashhelper, crashpad and chromedriver (2 each); **Firefox's libxul none**. Nothing links
libatomic in the desktop guest; in Debian's only GLib does, and it imports nothing from it (over-linking). The Alpine
images have no libatomic. Misaligned atomics fault on every CPU without LSE2 (and are UB in C), so no guest code
relies on them; x86 emulators (FEX, Box64) would, and none is in the images. So LSE2's gain here is nil, and counts
of executed pair ops weren't taken.

**What the cheap half costs.** The one piece that is buildable, LDP/STP of X pairs as one 16-byte host access in the
JIT (`v128.load` and two `i64x2.extract_lane`; `i64x2.splat`, `replace_lane` and `v128.store`; `pairs16.patch`,
the interpreter left alone), was measured to bound it: the Mac host (M4, macOS 26.6.2), Chrome for Testing
157.0.8103.50 headless, `bench/interp/ab-mac.sh lse2 3 base=… new=… -- boot_alpine_jit alpine_user_jit` and one more
round (`lse2b`) in a second session, arms alternated (ms, each round's median; steps unchanged, 2,652,860,340 and
10,612,856,957; the compiled wasm +0.39% / +0.36%):

| | base (`56d2a010`) | pairs as 16 bytes | |
|---|---|---|---|
| `alpine_jit_total` | 4,505 · 3,920 · 3,929 · 4,122 | 3,946 · 3,968 · 3,951 · 4,040 | base's first round of each session is cold (IQR 354 and 370 ms); rounds 2-3 +0.6 to +1.2%, apart |
| `alpine_user_jit_total` | 11,014 · 11,078 · 11,080 · 11,127; **11,079** | 11,102 · 11,126 · 11,178 · 11,205; **11,152** | +0.7%, overlapping (round 4's base) |

About +0.7% on both, at the bar: V8 lowers the lane moves to `fmov`/`mov v.d[1]` beside the `ldr q`/`str q`, a
few cycles a pair. Not the obstacle, but not free for a feature that has no user. **Dropped**, the v8.0 alignment
rules kept (docs/cpu.md "Left out, unadvertised"); the backlog item is gone, its list empty (MOPS's rejection moved to docs/cpu.md). CI: docs only, none run.

## PERF loop 13: the JIT's wasm size cuts (2026-11-10)

The backlog's "Where the JIT's wasm bytes go" sub-items, each built as its own arm behind a switch, sized, and screened
on the Mac: the M4 Mac mini's host (macOS 26.6.2), Chrome for Testing 157.0.8103.50 headless; the gates through
`bench/interp/ab-mac.sh` (`boot_alpine_jit alpine_user_jit`, arms alternated each round) and Firefox's pages session
from `pages.waarm64snap` through `bench/gpu/sway-mac.sh` (`TIMELINE_ALL`, busy MIPS from `bench/gpu/stalls.ts`), base
`272f7f13`. Raw: `results/perf13/` (README: the arms' patch, sizes, JSON).

**The arms and their size** (wasm compiled over Alpine's boot and userspace benchmark in Node, deterministic: the
same 10,612,856,957 steps in every arm; base 17,528,836 bytes):

| arm | what | wasm |
|---|---|---|
| tee | `local.set N; local.get N` as `local.tee N` (`wasm::Code::local_get`, not across a `mark` or right after a `rewind`) | −1.39% |
| small | tee, a `const 0` dropped before `add`/`sub`/`or`/`xor`, UBFM's LSR/LSL as one shift, SXTB/H/W as `extendN_s`, CSET/CSETM from the condition | −1.66% |
| cold | the failure chains', slow arms' and FP guard's NZCV through four helpers of the module (`m9-size/nzcv-helpers.patch`, rebased) | −1.58% |
| missfb | a guarded chain's fallback (the check failed) a tail call of the miss function, no transfer cache probe | −3.28% |
| **S** | small + cold + missfb | **−6.44%** |
| Shot | S, and every NZCV through the helpers (the hot sites: commits before branches, computed conditions) | −11.07% |
| Sunc | S, and an uncompiled successor in another page through the miss function too | −9.79% |
| **Scnt** | S, and one budget counter: edges update only `left`, `acc` is `SUM − left` | **−5.81%** (+0.68% over S) |

The counter makes the wasm bigger: every exit pushes `SUM − left` (3 bytes more) where an edge saves `acc += len` (7);
regions have more exits than edges. Its first session's build shared FP16's local 129 (no FP16 runs in Alpine; the
differential test's FP16 sequences caught it), the second's is the kept one at 138.

**The gates** (ms, each round's median, the median of rounds; session 1's first round ran ~8% slow on every arm, the
host settling, so its boot is from rounds 2-3):

| | base | S | Shot | Sunc | Scnt |
|---|---|---|---|---|---|
| session 1 `alpine_jit_total` | 4,305 · 4,315 · 3,961 | 4,272 · 3,951 · 3,938 | 4,343 · 3,989 · 3,979 | 4,390 · 4,063 · 4,031 | 3,983 · 3,954 · 3,942 |
| session 1 `alpine_user_jit_total` | 11,834 · 11,161 · 11,131; **11,161** | 11,897 · 11,086 · 11,083; **11,086** | 11,975 · 11,228 · 11,215; **11,228** | 12,702 · 11,942 · 11,896; **11,942** (+7.0%) | 11,908 · 11,062 · 11,080; **11,080** |
| session 1 Lua | 2,739 · 2,644 · 2,650 | 2,740 · 2,629 · 2,621 | 2,773 · 2,648 · 2,648 | 3,083 · 2,964 · 2,973 (+12%) | 2,736 · 2,599 · 2,590 |
| session 2 `alpine_jit_total` | 5,274 · 3,953 · 3,963; **3,963** | 3,962 · 3,923 · 3,944; **3,944** (−0.5%) | | | 3,947 · 3,946 · 3,946; **3,946** (−0.4%) |
| session 2 `alpine_user_jit_total` | 11,195 · 11,100 · 11,087; **11,100** | 11,128 · 11,091 · 11,076; **11,091** (−0.1%) | | | 11,116 · 11,076 · 11,000; **11,076** (−0.2%) |
| session 2 Lua | 2,625 · 2,619 · 2,633; **2,625** | 2,632 · 2,622 · 2,631; **2,631** | | | 2,579 · 2,592 · 2,580; **2,580** (−1.7%, rounds apart) |

**Firefox's pages session** (busy MIPS, wasm compiled; 3 rounds, the arms' order rotated each round):

| | busy MIPS | wasm (MiB) |
|---|---|---|
| base | 320 · 350 · 327; **327** | 132.8 · 131.9 · 132.2 |
| S | 347 · 353 · 320; **347** | 128.9 · 129.0 · 128.9 |
| Scnt | 346 · 348 · 351; **348** | 128.9 · 129.4 · 128.6 |

The rounds overlap (each arm's spread is 3-10% here; base's first session ran first): even, as the size A/B
predicted (20% more machine code cost nothing on the Mac).

**Kept:** S (the peepholes, the idioms, the cold NZCV helpers, a failed guard's miss function) and the one budget
counter. Nothing they change shows on the gates or the pages session but the counter's loops (Lua −1.7% against base
and −1.9% against S in session 2, −1.1% against S in session 1, rounds apart both times); what they save is memory:
−6.4% of the wasm on Alpine's boot (12.8 → 12.0 MB) and −2.5% in Firefox's pages session (132.2 → 128.9 MiB, less
for V8's code too), for the JIT's budget to fill later. **Dropped:** every NZCV through the helpers (+1.3% on the
userspace benchmark against S, rounds apart, the boot +1%) and an uncompiled successor through the miss function (+7%,
Lua +12%, SQLite +10%: a hot site, two lookups each time instead of one probe). Not built: register offsets past 128 in
one byte (~1 B on half the write-backs, a `Cpu` layout change) and anything else that is size alone. docs/jit.md has
the kept rules ("Linking", "Emission") and the dropped ones ("Tried and not kept"); the backlog entry is gone.

Checks: steps unchanged in every arm (the gates' and `tests/steps.txt`'s); new differential classes for the forms
random fields seldom hit (bitfield shifts and extensions, CSET/CSETM: planted, CSET without its `eqz`, LSL by `immr`,
SXTB as `extend16_s` and LSR as arithmetic each fail them); `jit::wasm::tests::peepholes` (planted, a tee across a mark
fails it); the region tests' bytes updated for the counter.
CI: `scripts/ci.sh` (709 s) and `scripts/ci-jit.sh` passed. Memory: no new state; the JIT's code 2.5-6.4% smaller.

## PERF loop 14: the shared cache's leftovers (2026-11-10)

The backlog's "The shared cache's leftovers", each sub-item counted first. Gates on the Mac host (M4 Mac mini, macOS
26.6.2, Chrome for Testing 157.0.8103.50 headless) through `bench/interp/ab-mac.sh perf14 3 base=… L=… F=… LF=… --
boot_alpine_jit alpine_user_jit`, arms alternated each round; counts in Node on the dev VM (`bench/boot/userprof.ts`,
deterministic, the same 10,612,856,957 steps in every arm) and one churn screen on the dev VM's Chromium (`bench/gpu/ab.sh`
from `pages.waarm64snap`, `PHASES=churn CHURN='rate=60&total=4000'`). Base `367757a9`. Raw: `results/perf14/` (README).

**Where one vCPU's 1-2% went.** It was measured on 2026-10-03 against a cache per vCPU, whose code no longer exists, so
each remaining cost of the sharing on one table got its own arm (`arms.patch`, build-time switches):
- **L**: the jump cache's and hot words' addresses as constants in the modules (the one table's), not loaded through
  the vCPU (`emit::JC_PTR`, `HOT_PTR`: the "one more load"). Wasm −0.45% (16.51 → 16.43 MB over the userspace run).
- **F**: a catch-up that has nothing to take returns at once. Of the userspace run's 581K lock acquisitions (all
  uncontended, one table), 571K (98%) caught up with nothing new.
- The bytes "copied for the catch-up" are no copy any more: a table's `Todo` shares them (`Arc<[u8]>`). What is left is
  the emitted `Vec` turned into an `Arc` once per module, 16.5 MB over the userspace run (~2 ms of memcpy, 0.02%): not built.

| ms, each round; median of rounds | base | L | F | LF |
|---|---|---|---|---|
| `alpine_jit_total` | 3,847 · 3,927 · 3,931; **3,927** | 3,895 · 3,918 · 3,929; **3,918** (−0.2%) | 3,912 · 3,920 · 3,931; **3,920** (−0.2%) | 3,940 · 3,897 · 3,901; **3,901** (−0.7%) |
| `alpine_user_jit_total` | 10,948 · 10,979 · 11,033; **10,979** | 10,912 · 10,970 · 10,963; **10,963** (−0.2%) | 11,083 · 11,007 · 11,044; **11,044** (+0.6%) | 10,957 · 10,939 · 10,932; **10,939** (−0.4%) |
| compress | 1,655 · 1,644 · 1,645; **1,645** | 1,627 · 1,636 · 1,627; **1,627** (−1.1%, apart) | **1,651** (+0.4%) | 1,624 · 1,629 · 1,630; **1,629** (−0.9%, apart) |
| Lua / churn / SQLite | 2,571 / 783 / 2,227 | +0.4 / −2.1 / 0.0% (overlapping) | 0.0 / +1.3 / +0.9% | −0.1 / −0.7 / −0.4% |

All totals within ±0.7%, the rounds overlapping: the 1-2% isn't there any more (what removed it is the work since:
the known blocks, the decoded blocks' slots, the compile worker's posted modules). The constants are worth ≤0.4% of a
total (compress ~1%), for one-table VMs only (the gates, a 1-vCPU machine), and they'd make a lone table's bytes
differ from any other's; the no-op catch-up is even. **Neither kept** (docs/jit.md "Tried and not kept").

**Every module installed by every table.** Firefox's pages session (loop 13's base, the Mac): 2,700 modules, 10,800
installs, 0.60 s of install time (`compileNs`) over the four vCPUs (~0.6% of the session's ~100 busy vCPU-seconds).
The churn screen here: 20,856 modules, 83,424 installs, 2.84 s over ~97 s × 4 vCPUs (0.7%). Installing only what a
table runs would save at most the other tables' three quarters of that (≤0.5% of either), less what a table that needs a module later
pays to take it then (a parked install, interpreted meanwhile). Under the 1% bar on the costliest workload: dropped.

**Lagging tables.** `lagFlushes` 0 in loop 13's pages sessions and in this churn screen, as in every session measured.
The recompile-what-it-runs alternative stays unbuilt (docs/jit.md "Sharing"). The held-bytes count in `Cache::install`
now has a native test (`installed_modules_count_in_the_held_bytes`: two tables, modules emitted through
`Cache::install`, one falling behind past `HELD_MAX`); planted, the install not counting its bytes and the install not
shedding each fail it.

**The cache's lock:**
- **Firefox's ICs** on the churn screen: 638K in a 97 s run (`doneS` 96.9), against 1.07 M with 64-byte lines and 0.71 M
  with 2 KiB lines on 2026-10-21. Not the few times fewer expected: what's left is ICs over code the guest wrote (a
  page each), not 64-byte steps. The lock's waiting 2.66 s over 4 vCPUs (0.16% contended, 3.93 M misses run
  interpreted instead), busy MIPS 288, no stall ≥ 20 ms.
- **Allocations under the lock** (a diagnostic core counting the allocator's calls, `WAARM64_ALLOCS` in `arms.patch`):
  over the userspace run 2.79 M calls, of which **all but ~2,000 are under the cache's lock**, 1.66 M (60%) emitting
  modules (`block::module`, ~3,000 a module), the rest the misses' map and region work. So the allocator's own spin
  lock is hardly contended by them (the cache's lock serializes them already); what they cost is the lock's hold time,
  of which emitting is most (5.3 s of the churn screen's 5.3 s held, the waiting 2.7 s). Fewer allocations in the
  emitter would shorten holds by a part of that part: under what a session resolves. Not worth a loop.
- **Coalescing ICs per page**: no guest seen that steps by its own line regardless of CTR_EL0 (the ICs left are a page
  each already). Not built.

Memory: nothing kept. Checks: steps unchanged in every arm. CI: `scripts/ci.sh` (the new test the only code change).

## PERF loop 15: the parallel SMP leftovers (2026-11-10)

This loop took the backlog's three parallel SMP items, which are the ISB fix's cost, WFE sleeping and an exit's remaining
cost. It counted each one first. The raw data is in `results/perf15/`: the counting patch, the A/B's base patch, the
pages session's counts, the A/B's JSON, and the exit loop with its profiles. **Nothing is kept**, and all three items
leave the backlog as findings.

**The counts.** They come from Firefox's pages session with a counting core (`diag.patch`), started from
`pages.waarm64snap` on the Mac host (M4, macOS 26.6.2, Chrome for Testing 157.0.8103.50 headless). The guest had 4 vCPUs
and ran 218 s, 98 G steps. The vCPUs spent 609 of their 872 s out of the core, which leaves ~263 busy vCPU-seconds.

| over the session, 4 vCPUs | count |
|---|---|
| ISBs that read the `behind` counters and completed in place | 13.85 M (loop 8 counted 13.66 M) |
| ISBs that exited because the JIT table was behind | **5,927** |
| IC broadcasts | 537 K |
| WFE yields | **1.92 M** (~2.2 K a second per vCPU) |
| DSB waits | 36,884, 0.63 s in all |

**The ISB fix's cost.** Each fast ISB pays for one flag and two relaxed loads, ~14 ms over the session at ~1 ns each.
The 5.9 K exits add ~1.5 ms at the ~240 ns a desktop-guest exit costs. Together that is ~0.006% of the busy time,
below anything an A/B can resolve. The A/B ran anyway, on the Mac, with `bench/interp/ab-mac.sh perf15 3 nofix=…
main=… -- smp_user_jit_4` and the arms alternated. The base arm is main without the `behind` check (`nofix.patch`), and
the arms differ in `fast_exit`'s size, 973 B against 1,040 B. The table gives ms per round (each round's median), with
the median of the rounds last:

| | nofix | main | main/nofix |
|---|---|---|---|
| `smp_user_jit_n4_total` | 11,650 · 11,784 · 11,772; **11,772** | 11,696 · 11,808 · 11,582; **11,696** | 0.994, overlapping |
| compress | 1,415 · 1,453 · 1,523 | 1,373 · 1,530 · 1,393 | 0.959, overlapping |
| Lua | 2,441 · 2,423 · 2,503 | 2,502 · 2,417 · 2,494 | 1.022, overlapping |
| churn | 902 · 910 · 892 | 923 · 896 · 907 | 1.006, overlapping |
| SQLite | 1,884 · 1,861 · 1,891 | 1,870 · 1,950 · 1,825 | 0.993, overlapping |

The arms' rounds overlap and the difference is within the noise, as the count predicted. The desktop guest's image
decoding (`bench/imgdecode/`) wasn't run, because its second disk (`target/imgpipe`) isn't built here. The pages
session decodes the pages' images, and its count covers that case. The finding is in docs/platform.md "Broadcast
maintenance".

**WFE sleeping.** The session yields 1.92 M times. A yield is an exit with nothing to do: ~65 ns in the profile below,
and at most the desktop guest's ~240 ns. So the spins that end in a yield take 0.12-0.46 s of 263 busy vCPU-seconds,
≤0.2%. Sleeping on the event word would save only that host time, and with 4 vCPUs on 10 cores no other thread is
waiting for that core. It would also add a wake-up to each waiter's latency (~17 µs for a futex in the dev VM).
**Not built.** The finding is in docs/platform.md "Parallel SMP".

**An exit's remaining cost, part by part.** The test is `exitloop.c`, a bare-metal loop of 40 M runs of one
instruction with the MMU on (nG 1 GiB blocks, an ASID). It ran in Node on the dev VM in parallel SMP with 2 vCPUs,
realtime and under the JIT, timed by the host: the run's ms less an empty loop's 124 ms. The guest's own counter
timings looked invalid, as if the realtime clock didn't count in `runToPowerOff`; it does, and the fault was the
program's own arithmetic (PERF loop 18, below). The profiles are `perf record -F
4999 -g` with `node --perf-basic-prof`. Two runs gave these costs per instruction:

| | ns per instruction (two runs) |
|---|---|
| `wfe`, a yield: an exit with nothing to do | 61, 69 |
| `mrs cntfrq_el0`, an always-exiting platform read | 144, 160 |
| `isb`, completed in place | 18, 25 |
| `svc` with start.S's handler (288-byte frame, a C call, ERET completed in place) | 155, 151 |

These are the shares of a yield's ~65 ns (`perf-only2.txt`):

| Part | Share |
|---|---|
| `jit::steps`' re-entry (`key`, `Cache::enter`, `fresh`) | 20% |
| `run_cpu`'s own iteration (the atomics, the timer test, the chunk's set-up) | 19% |
| `jit_exec_mmu` and `interp::sys::exec` (the helper decodes and runs the exiting instruction through the interpreter) | 21% |
| `publish_cpu` | 4% |
| `handle_par` | 3% |
| `Vm::counter`'s u128 division, every chunk | 2.5% |
| `drain` | 2% |
| the guest's block | 2% |
| `fast_exit` | 1% |

The word is decoded three times: by `exec_at`, by `count`, and by `fast`. `cntfrq_el0` (`perf-only0.txt`) adds the
host clock: `__kernel_clock_gettime` 12%, plus the JS import and its wrapper 4%. Every `Exit::Platform` reads the
clock first, although CNTFRQ shows no timer. The SVC loop's own `svc #0` begins its block, so that block runs through
the interpreter each time (`interp::steps` 6%, the decoded block's miss 2.4%). Linux's syscall stubs end a compiled
block with their SVC instead.

Each part costs a few ns. The cheap cuts would each save 1-3 ns of an exit: the counter's division cached, the clock
read only for a timer's register, one decode passed on. But exits are ~0.2-0.3% of a busy vCPU's time in a browser
(this report's "Where a busy vCPU's time goes in Firefox, again"), so each cut would come to ~0.01%. **Nothing cut.**
The profile is in docs/jit.md "What an exit to the run loop costs".

**The other two items** in the section stay in the backlog:
- **Parallel `make`**: `images/debian-tools` has gcc and make now. No harness exists yet to boot it at N vCPUs with a
  source tree, and that isn't a cheap measurement; the 4-vCPU `go build` loop covers compile scaling meanwhile. The
  entry is reworded.
- **A default vCPU count for users**: this is about the settings and their advice to the user, not about speed.

Memory: nothing kept. Steps: unchanged (no code change). CI: none, since no core code changed (`tsc` passes over the
two scripts in `results/perf15/`).

## PERF loop 18: the counter in parallel realtime under `runToPowerOff` (2026-11-10)

Loop 15 timed `exitloop.c` by the host's clock because the guest's own timings looked wrong: `mrs cntfrq_el0` at
1-70 ns where the host said ~145 ns. That read as CNTVCT not advancing in Node's `runToPowerOff` in parallel realtime.
**It isn't an emulator defect: the counter counts.** The program's `report` overflowed. It computed
`(t1 - t0) * 10^12 / f / n`, and at 62.5 MHz the product passes 2^64 once a phase runs past ~0.295 s. Every
exiting phase ran longer than that (0.3-0.7 s), so each wrapped once or twice. A 0.5745 s cntfrq phase wraps to 69.8 ns,
which is what loop 15 printed in its rounds before the MMU was on (72 ns). With the MMU on, the 0.605 s phases wrapped
twice and showed 3.7 ns.

The checks were made in the dev VM: Node, 2 vCPUs, parallel, realtime, JIT (`run.ts 2`), with the wasm of `446bff72`.
- One kind per run, with and without the MMU, each printing its start time and its elapsed counter in µs: the counter's
  start (~95 ms) plus its elapsed time matched the host's `ms` within 2 ms in all eight runs (cntfrq 4 M: 96 + 605 µs
  against 701 ms; empty 10^9 iterations: 98 + 412 against 511).
- `exitloop.c` with `report` computing through µs (`ticks * 10^6 / f * 10^6 / n`, committed in `results/perf15/`): its
  own timings now agree with the host's and with loop 15's host-timed table. cntfrq gave 138-146 ns, `isb` 15-17, `wfe`
  70-77, `svc` 163-183 and the empty loop 0.39-0.41 ns. The rounds sum to 9.9 s against the host's 10.1 s.

Nothing in the core changed, and no numbers move. `docs/platform.md` "Time" says so under parallel SMP.

## PERF loop 20: the second review's fixes (2026-11-10)

An out-of-context review of `15c0dc69..9dd6119b` (the PERF loops 8-19) left five findings; each fix below started
with its test, failing on `9dd6119b`.

1. **The `spin` query poll followed the count of pending queries, not the set** (web/virgl-host.ts
   `queryScheduler`): a client that keeps one query in flight (the next ended as the last settles) holds the count at 1
   and fell to the 4 ms timer 2 ms after its first query. The renderer now counts each query added or settled
   (`queryChanges`) and the poll restarts its window on that. Test: tests/virgl.test.ts "the poll keeps spinning while
   the pending set turns over at a steady count" (the scheduler on the test's clock, its 4 ms timers counted: every
   look past the first 2 ms by the timer before, none after; the loop 16 test moved to that clock too, as both missed
   their wall-clock bounds under CI's load). glquery waits on each
   query at once (the count goes 1, 0, 1), so loop 16's numbers stand: on the M4 (Chrome for Testing 157.0.8103.50),
   3 rounds alternated, the old rule against the new gave waits of 0.81 / 0.775 / 0.77 ms against 0.815 / 0.77 /
   0.79 ms (medians), 265-275 against 260-272 frames/s (bench/gpu/results/perf20/mac-spin-set.json; bench/gpu/REPORT.md
   "PERF loop 20").
2. **A call's failed guard tail-called the miss function** (core/src/jit/block.rs `chain`, loop 13's `missfb`): the
   callee ran at the caller's depth and the rest of that guest call chain lost its host-call return prediction. The
   fallback now transfers as the chain does (`Xfer::Call` for a call: a host call below `MAX_DEPTH`, its result
   through `returned()`). Test: `a_calls_failed_guard_still_calls_the_miss_function` (the module's bytes: `call` of the
   miss function and `br` to the call's `returned()` block; before, a `return_call`). Planted: the `br` one block too
   far (inner 1) fails it; Alpine's boot and userspace benchmark took the same 10,612,856,957 steps with it planted,
   so the path is rare there. **Size:** the wasm compiled over Alpine's boot and userspace benchmark (Node,
   `bench/boot/userprof.ts`) went from 16,510,885 to 16,626,528 bytes (+0.70%; loop 13's `missfb` had saved 3.28%).
   **The gate** (`bench/interp/ab-mac.sh perf20 3`, M4, macOS 26.6.2, Chrome for Testing 157.0.8103.50; round 1 ran
   beside wasm builds in the dev VM and is left out): `alpine_jit_total` tail 3,943 · 3,920, call 3,902 · 3,923 ms;
   `alpine_user_jit_total` tail 11,001 · 10,988, call 11,032 · 11,021 ms (+0.3%, under the noise); Lua and SQLite
   even. Kept. JSON in `results/perf20/`.
3. **`Known::at`'s 25-bit start field** (core/src/interp/block.rs) was guarded by a `debug_assert!` only: a cache's
   budget is now held under `START_LIMIT` (2^25) in `Cache::new`, and `MAX_BUDGET <= START_LIMIT` is a compile-time
   assertion. Test: `a_cache_budget_fits_the_start_field` (a cache asked for `usize::MAX` kept it).
4. **Deterministic round-robin's inline unmask didn't see host signals arriving mid-chunk** (core/src/vm.rs,
   `jit::Unmask`): a completion, console input or a stop that came while the guest had IRQs masked waited for the
   chunk's end (up to 32K steps) where the unmask's `Exit::Resync` used to bring the run loop's checks forward. The run
   loop now points `Unmask::irq` at the signal word, whose low byte holds its bits, and a round-robin block's inline
   arm loads that byte atomically (as a parallel one loads its IRQ byte). Reproducible runs set the word only between
   runs (the loop's top clears it), so steps don't move. Test: tests/jit-diff.test.ts "unmasking DAIF writes inline"
   has the round-robin arm "a host signal pending" (every unmask took the helper after; none before).
5. **The `ticker` poll's worker is never terminated** (web/virgl-host.ts): not a defect. It is the GPU worker's
   dedicated child, ended with it (the page terminates the GPU worker; a worker's dedicated workers end with their
   owner), one per GPU worker, and parked on its word (no CPU) while no query is pending. Said in
   `queryScheduler`'s comment.

No step count moved. CI: `scripts/ci.sh`, `ci-jit.sh`, `ci-graphics.sh` and `ci-debian.sh` pass.

## PERF loop 21: the MMIO read's cost (2026-11-14)

The handover's "Next": an MMIO read cost ~0.29 µs under the JIT on Debian (fw_cfg's data register, docs/clipboard.md
"What it costs"), unbroken down. Raw: `results/perf21/` (`mmio.c` and `run.ts`, the micro-benchmark; `micro/` its
JSON; `gates/` the Mac screen's; `page-fwcfg.json` the Debian check).

**The micro-benchmark** (`results/perf21/mmio.c`): bare metal, the MMU on as Linux has it (48-bit VAs, four levels,
the register's page a 4 KiB Device-nGnRE page at level 3, as `ioremap` maps it), 250,000 iterations of 8 `ldr w2`
of one register, timed by the host (`run.ts`: Node 26.7.0 on the dev VM, one vCPU, parallel SMP and realtime, the
page's mode, JIT), less the same loop on RAM (~90-130 ms, noisy): 2M reads.

**Where a read's ~0.21 µs went** (Node's `--cpu-prof` at 50 µs, PL011's FR; the shares of the vCPU thread's time):
- **the run loop and re-entry, ~30%**: the helper's `Exit::Fault(Bus)` ended the block and the chunk; `run_cpu`'s
  iteration (the atomics, the chunk's set-up), `jit::steps`' dispatch of the next block (a block per entry point
  after each read), `handle_par`, `publish_cpu`, `drain`, the counter's u128 division;
- **three table walks, ~20-30%**: a page with no RAM was never cached in the TLB, so the helper's try walked
  (`Mmu::miss`: `walk`, then `Mem::host_spill` looking for a spill memory), `Io`'s run walked again, and `Io::pa`
  walked a third time for the PA;
- **the interpreter twice, ~25%**: the helper's try (`jit_exec_mmu`: decode, `ldst::exec`) and `Io`'s run
  (`interp::step_bus`: fetch, decode, `ldst::exec`);
- the platform's lock and `refresh` (`spis`, `Gicv3::signaled` for every vCPU), ~5%; the device itself (PL011's
  `read`, `Io::dev_read`), ~3%; the compiled loop, the rest.

**What was built** (no rearchitecting: both reuse what's there):
1. **Device pages in the TLB** (core/src/mmu.rs): a walk that ends on a PA with no RAM fills the data array's entry
   with memory index `MMIO` (0xff, the tag's bits 10:3 zero), the PA as its "host address", Device or not as the walk
   said. `Mmu::miss`'s look for spill and Device entries finds it, checks the alignment, and returns the bus fault;
   `Io::pa` reads the PA from it (`Mmu::mmio_pa`). Fills, flushes, nG and block marks, `low_global`: as RAM's.
2. **Device accesses finished in the helper** (core/src/vm/parallel.rs `Vm::fast`, the existing fast completions,
   parallel SMP in realtime mode): `Exit::Fault(Bus)` runs `io` under the platform's lock as `handle_par` would, and the
   block goes on, unless that left a `DEVICE` exit, a full TX ring, a fault or an unmasked IRQ on the line: then its
   outcome waits in `jit::State::io` and `handle_par` takes it instead of running the access again.

| per read, µs (rounds 1-3, the arms alternated) | base | 1: device entries | 1 + 2 |
|---|---|---|---|
| PL011 FR | 0.24 · 0.21 · 0.21 | 0.14 · 0.16 · 0.15 | 0.09 · 0.08 · 0.08 |
| GICD_CTLR | 0.23 · 0.21 · 0.20 | 0.16 · 0.15 · 0.14 | 0.09 · 0.07 · 0.08 |

(Each round's median of 3 runs less its RAM loop's; an earlier session with fewer arms: 0.214, 0.157, 0.091.) The rounds
don't overlap: **about −60% a read** (0.21 → 0.08 µs).

**Debian on the page** (`tests/page-agent.test.ts`'s fw_cfg diagnostic, the agent's 108,409-byte gzip read in 26
pieces, Chromium 155.0.8059.84 headless on the dev VM, the arms swapped in `target/` and alternated): base 78.2 and
75.5 ms (721, 696 ns a byte), new 45.6 ms (421) and 44.3 in the run before (408): **−41%**, ~32 ms of a vCPU at every
boot.

**What's left of a read** (~85 ns; the new arm's profile): the interpreter twice (the helper's try and `Io`'s run:
`jit_exec_mmu` and `vm::io` the largest two), the lock and `refresh` ~15%, the device ~5%. Tried: handing `Io` the
helper's word instead of fetching it again: no difference (273-280 against 277-292 ms), dropped. Not built: an access
compiled to a device call (the slow arm reading the PA from the device entry and calling a per-size helper without the
decode, ~30-40 ns): a new slow-arm form on every load and store (code size the Mac ranks) and a second copy of `Io`'s
dispatch, for a cost that nothing we run pays often (Debian's fw_cfg read, ~100K reads a boot, is the largest; virtio's
registers are a few reads a request). Not needed either: inline JIT code reading a device. The exit to the run loop was
the cost, not the helper call; the device's own work is a few ns.

**The screen** (`bench/interp/ab-mac.sh perf21 3`, the JIT gates, M4, macOS, Chrome for Testing 157.0.8103.78,
base then the new arm each round), ms:

| | base | new |
|---|---|---|
| `alpine_jit_total` | 3,910 · 3,922 · 3,936; **3,922** | 3,924 · 3,958 · 3,952; **3,952** (+0.8%) |
| `alpine_user_jit_total` | 10,516 · 10,586 · 10,636; **10,586** | 10,590 · 10,657 · 10,645; **10,645** (+0.6%) |

The rounds overlap and the differences are under the ~1% floor: no regression shown (the gates run deterministic,
where only the device entries apply). **Size:** `Mmu::miss` 1,088 → 1,195 bytes, `Vm::io_par` 341 new (`tools/wasm-sizes.ts`;
the core 9,319,175 → 9,321,984 bytes). **Memory:** none (the entries are the TLB's own slots; `State::io` is a few
words a vCPU).

**Checks:** tests/baremetal/mmio.c (new; QEMU agrees, `oracle.sh`): fw_cfg's data register read 140K times through
an aliased 4 KiB Device page (the bytes in order), the page remapped and flushed, misaligned and empty-page accesses
from compiled code, an SPI made pending by a store taken before the next instruction; `mmu::tests::
device_pages_are_cached_as_the_bus` (no second walk, `mmio_pa`, the fetch array left empty, alignment, a TLBI).
Planted, each failing: the PA from the entry wrong (mmio.c, natively and in wasm); the IRQ check dropped (mmio.c's
check 30, 5 of 5 runs); faults finished in place (mmio.c's check 21); `DEVICE` exits finished in place (the parallel
USB test, testusb against Gadget Zero, timed out). No step count moved.
CI: `scripts/ci.sh` (778 s), `scripts/ci-jit.sh` and `scripts/ci-debian.sh` pass.

## PERF loop 22: the review of loop 21 (2026-11-14)

The out-of-context review of loop 21 (`review/perf-loop21`, static) had three findings; each checked against the code.
Raw: `results/perf22/` (the micro-benchmark's JSON).

1. **A device access `fast` ran but left for the run loop lost its result to a stale register store: real.** The
   failure chain of a load or store (`emit::fallback_arm`) assumed an arm whose helper reports an exit retired
   nothing; since loop 21 `Vm::fast` runs the access through `Io` (destination written, PC advanced) and still
   reports the exit when it leaves a `DEVICE` exit, a full TX ring, a fault or an unmasked IRQ. An earlier site's
   segment of the same chain then stored its locals, the pre-access value of this access's destination or writeback
   base among them, over what `Io` wrote. **Test** (tests/baremetal/mmio.c, new case): `mov x9, <GICD_ISPENDR1>;
   ldr x, [ram]; str w, [x9], #4` with IRQs unmasked, 20,000 times: the store makes SPI 40 pending, so `fast` runs it
   and leaves the IRQ to the run loop; x9 must be the post-index base. It failed before the fix in parallel SMP under
   the JIT (check 31, the first run). **Fix:** `fallback_arm` reloads from the `Cpu`, in the helper's failure branch,
   the registers the instruction writes that an earlier segment stores (`written & ch.cum`), as the span path already
   did. That is right whether or not the access retired (the `Cpu` holds them either way: stored before the call, or
   clean), costs nothing on the fast path, and emits code only where a chain holds such a register; loop 21's
   in-place completions stay as they were. The planted bug is the code before the fix (the test fails; restored, it
   passes 5 of 5 runs, JIT and JIT-check).
2. **In-place device accesses no longer bound other vCPUs' DSB waits and the run loop's due work: real, latency
   only.** Before loop 21 each device access ended the chunk, so the run loop's top drained queued TLBIs and ticked
   the xHCI's due completions about once per access; now a loop polling a register did so once per chunk (32768
   steps, about a millisecond of polling at ~0.08 µs a read). **Fix** (cheap, so taken over a line of docs): the
   device arm declines, before running anything, while `par.pending` is set (as the ISB/DSB arm does) or the xHCI's
   completions are due (`xhci_due` reached; the clock is read only while a TD waits). The timers' lines and IRQs
   arriving after the access stay at the chunk's end, as for any code that doesn't exit (docs/jit.md "Device
   accesses"). No test: a latency bound, not a result.
3. **Small things: real.** `MMIO`'s doc linked `Tlb::mmio_pa` (it is `Mmu::mmio_pa`); `fallback_chain`'s doc, the
   span path's comment and `jit::Fast`'s now say what the failure arms do. The RAM regions' page alignment, which a
   device entry covering a whole page assumes, is asserted: `Mem::at` (every VM's memory 0), `with_spill` and
   `with_window` (each region and memory 0 before them); every RAM size we use was already whole pages.

**The micro-benchmark** (loop 21's `results/perf21/run.ts` and `mmio.c`, N = 250,000 iterations of 8 reads; Node
26.7.0 on the dev VM, one vCPU, parallel SMP and realtime, JIT; base = main at 5b2e0a41, new = this loop; arms
alternated, 3 runs each a round), medians in ms:

| | base r1 · r2 · r3 | new r1 · r2 · r3 |
|---|---|---|
| RAM (the loop's own cost, noisy) | 95.2 · 99.9 · 104.7 | 89.1 · 91.1 · 92.5 |
| PL011 FR | 239.3 · 240.5 · 237.1 | 239.3 · 241.4 · 240.7 |
| GICD_CTLR | 242.5 · 241.7 · 241.6 | 242.7 · 246.6 · 243.0 |

Even: the device rounds overlap or differ under ~1% (GICD's r2 is one slow run of three), ~0.07 µs a read both ways
(the loop's fast path doesn't change: the reload is on the failure branch, and the arm adds an atomic load).

No step count moved. CI: `scripts/ci.sh` (767 s), `scripts/ci-jit.sh` (105 s), `scripts/ci-debian.sh` and
`scripts/ci-usb.sh` pass.

## PERF loop 23: scalar FP in f32 and f64 shadows (2026-11-14)

The backlog's "Scalar FP in f64 and f32 locals": a scalar FADD was the op and five lane ops (two lane extracts, the
result's move to a general register for its check, `movi` and `ins` to write it back zero-extended), and on the M4
these paths are bound by the SIMD pipes (docs/jit.md "What the checks cost"). Raw: `results/perf23/` (the Mac's
JSON, `perf23fp-*` the FP guest, `perf23-*` the gates; `vm-*-fp.json` the dev VM's FP guest).

**Counts** (the FP guest, `bench/interp/guest-fp.c`, clang -O2): its scalar FP is n-body's inner loop (42 words: 3
FSUB, 5 FMUL, 3 FNMUL, FADD, FSQRT, FDIV, 8 FMADD, 11 LDR d, 6 STR d), Horner's reduction (16 FADD d and 8 `mov d, v.d[1]`
an iteration; the polynomial itself is FMLA .2D) and `convert`'s second loop (LDR s, SCVTF s, FMADD s, STR s, 256
times a round). Before: arithmetic six lane ops (with the op), a fused FMADD four (`madd`, `umov`, `movi`, `ins`), a
LDR d none (`v128.load64_zero`), a STR d one (`umov`). With shadows, on operands in shadows: arithmetic two (the op,
`fmov` of its result for the check), FMADD four to six (a `dup` a shadow-only operand, `madd`, `umov`, `fmov`), loads
and stores none. n-body's loop: about 116 lane ops an iteration to about 76. TurboFan's code of that loop
(`tools/v8code.ts --guest fp`): `mov` between lanes and general registers 159 → 70, `movi` 22 → 7, `fmov` 14 → 73,
`dup` 0 → 8, its size 8,770 → 10,953 lines (the failure segments store a shadow as two stores, `f64.store` and the
zeros above it, where a v128 was one). The FP guest's wasm 65,839 → 68,411 bytes (+3.9%).

**Built** (docs/jit.md "Scalar shadows"): `Regs` gains `s32`/`s64`, an f32 and an f64 local per V register holding
lane 0 (locals 139-202, past 128: the two-byte indices `compact_locals` already had); scalar results go to the
shadow alone, readers take it without lane ops, a vector reader builds the v128 from a dirty shadow, stores write the
shadow and zeros. Region merges keep a register shadow-only only when every side holds it so and all are dirty or all
clean; failure chains record each register's form per segment. SIMD&FP loads of singles and doubles go to the shadow
when the next instruction naming the register is a scalar FP arithmetic or store (else the v128, which integer NEON
reads with no lane op); DUP's scalar form of a single or double extracts into the shadow.

**The FP guest** (`bench/interp/ab-mac.sh perf23fp 3`, `jit_fp_mips`, M4, macOS, Chrome for Testing 157.0.8103.78,
base then the new arm each round; the harness's median over eight placements), MIPS:

| | round 1 | round 2 | round 3 |
|---|---|---|---|
| base | 3,259 | 3,215 | 3,200 |
| shadows | 3,510 | 3,523 | 3,497 |

**+8.9%** (median 3,215 → 3,510), the rounds far apart. On the dev VM (Chromium, one run each): 2,725 → 2,863 MIPS.

**The gates** (`bench/interp/ab-mac.sh perf23 3`, the same session), ms:

| | base | shadows |
|---|---|---|
| `alpine_jit_total` | 3,865 · 3,940 · 3,946; **3,940** | 3,928 · 3,966 · 3,972; **3,966** (+0.7%) |
| `alpine_user_jit_total` | 10,547 · 10,620 · 10,606; **10,606** | 10,610 · 10,646 · 10,652; **10,646** (+0.4%) |

The rounds overlap and the differences are under the ~1% floor: no regression shown, though the new arm was the
slower in each round (neither guest runs scalar FP to speak of; the core's emitter is bigger: next line). **Size:**
`float::inline` 32,977 → 33,572 bytes, `Func::chain_open` 731 → 844 (`tools/wasm-sizes.ts`); the core 9,324,318 →
9,391,668 bytes. **Memory:** none at run time beyond the code (the locals are a function's frame; the FP guest's
modules +3.9%).

**Checks:** the differential test's new "scalar FP, its loads and stores, vector readers" sequences (both FMA arms)
and the region and loop programs with scalar FP. Planted, each failing: the zeros above a stored shadow left out
(six tests), a dirty shadow's v128 built as a splat (four), merges keeping a shadow-only register where one side is
clean (the region and loop tests). Not reached by any test: a failure site that writes more bits of a register a
segment stores from its shadow than the shadow holds (only a 16-byte device access `Vm::fast` retires and still
reports would); the rule that starts a new chain there stays as a guard. No step count moved.
CI: `scripts/ci.sh` (754 s), `scripts/ci-jit.sh` (96 s) and `scripts/ci-fp.sh` (436 s) pass.

**Not done:** FEAT_FP16's scalar forms in the f32 shadows (backlog: only if FP16 is ever advertised); FMADD's
operands still splat a shadow-only register (one `dup` each: n-body's eight FMADDs take most of the 76).

## PERF loop 24: loop 23's review fixed (2026-11-14)

The out-of-context review of loop 23's scalar shadows (`review/perf-loop23`, static) found no wrong guest value and
five findings. Raw: `results/perf24/` (the Mac's JSON: `perf24fp-*` the FP guest, `perf24-*` and `perf24b-*` the
gates).

**1. A dirty shadow-only register never survived a merge** (performance): true. Each member's merge started from
`Regs::default()`, and the default is a real state (not held, clean), so "both sides dirty in one shadow" never
held. The review's trap is also real: at a loop head the default stands for the function's entry, where the `Cpu`
holds the upper bits. *Test first*: "JIT vs interpreter, regions: scalar shadows across loop heads and joins"
(`tests/jit-diff.test.ts`): V registers with random upper halves, a head that leaves before the loop writes d0 (its
`cbz`, or its `ldr d1, [x0], #8` faulting with x0 outside RAM), the review's reduction loop, and three joins (one
side writes d0, the other nothing, an s0 or a d0), a vector reader (`umov` of both halves) after each. It passes on
main; the careless fix (every member's merge starting from its first edge, the head's too) fails it in programs 0
and 2 (V0's upper half zeroed: `Cpu` byte 312, or x3 from `umov`). *Fix*: a member's state merges only its real
predecessors (`reached` in `emit_region`), the head's starting from the function's entry explicitly; and
`Regs::merge` keeps a register shadow-only when each side holds it in that shadow alone or not at all, **dirty only
when both are dirty so, else clean** (the edges where it is dirty store the shadow and the zeros above). The head
then holds a loop-carried scalar clean in its shadow: the back-edge stores it (two stores, no lane op), where it
built a v128 and the next reader extracted lane 0 again. Planted: that merge keeping a dirty side's dirt (the
scalar-FP region and loop tests and the new test fail). *Lane ops* (`a_loop_carried_scalar_keeps_its_shadow`, a unit
test in `block.rs` on the review's loop): **6 → 0** from the loop on (both V0 and V1 were v128s at the head). *The
FP guest* (`bench/interp/ab-mac.sh perf24fp 3`, `jit_fp_mips`, M4, Chrome for Testing 157.0.8103.78, base · the
exact entry merge with loop 23's rule · this rule, each round), MIPS:

| | round 1 | round 2 | round 3 | median |
|---|---|---|---|---|
| base | 3,512 | 3,503 | 3,493 | **3,503** |
| exact entry merge | 3,468 | 3,486 | 3,492 | 3,486 |
| clean shadows at heads | 3,484 | 3,462 | 3,471 | **3,471** (−0.9%) |

No gain: the FP guest has no loop-carried scalar in a register (n-body's inner loop keeps its sums in memory,
Horner's polynomial is FMLA .2D), and the changed regions trade lane ops for stores and spills (TurboFan's code of
the region at 0x1045c: `mov` 311 → 294, `movi` 13 → 0, `str` 1,568 → 1,657, `ldur` 763 → 843; of 0x10470 and
0x1051c fewer moves and stores). The new arm is slower in each round, under the ~1% floor. Kept for the reductions it serves
(the lane-op count above) and because the merge is now exact; a guest with reductions would decide it.

**2. `conform` wrong for one target shape, the settle loop may end unsettled** (latent): true, and reachable once
1 is fixed (a member after a forward join can be dirty in a shadow alone). A target dirty in a shadow alone is right
only from an edge that holds it so in the same shadow; `conform` now `debug_assert`s that (the native tests compile
the loop regions with it), and a region whose entry states don't settle in four emissions makes those registers
clean (`Regs::loose`), a form any edge conforms to (stores, then loads from the `Cpu`). No test makes a region that
doesn't settle (none known); `merged_shadow_forms` covers `loose`.

**3. `merge`'s f32/f64 precedence** (latent): the state it would mishandle (both shadows, no v128) never occurs, as
the review says. `Regs::only` now returns each shadow alone with no precedence, `merge` uses it, `Regs::sound` (no
register in both shadows without its v128) is asserted in `merge` and `reload`, and `reload`'s branch for "the other
shadow alone" is gone: where this side holds the other shadow clean (`conform` stored it if dirty) the `Cpu` holds
the value, so it loads lane 0 as from nothing. Unit test `merged_shadow_forms` (each pair of side forms; the two
shadows merge to a v128).

**4. Group leaders split the chain on any SIMD&FP span** (performance): true, and cheap: the leader now passes the
span's SIMD&FP loads and their widest per-register write (`span_vloads`) to `chain_open`, as a single access does.
Not reached by the tests, as loop 23 found for the rule itself (only a device access `Vm::fast` retires and still
reports writes more than its shadow); no planted bug can fail a test. Effect: FP regions' code a little smaller
(the FP guest's modules 68,411 → 68,409 bytes).

**5. `scalar_next` quadratic** (compile time): true. It is a table now, made by one backward pass over the block
(`scalar_uses`, decoded once a word), equal to the forward scan (`next_scalar_uses` compares the two on random
blocks; planted, a pass that doesn't clear on another use fails it). Built eagerly for every block, the table cost the
gates: same code (Alpine's modules 12,120,141 bytes in both arms) but `emitNs` 174 → 187 ms in Alpine's boot and
242 → 259 ms in Alpine's userspace, and the boot +0.8% (3,924 → 3,957 ms, `perf24-*`, base first each round). Built
at a block's first single or double load instead, `emitNs` is back to the base's (175-178 against 175, 242-246
against 242-245).

**The gates** (`bench/interp/ab-mac.sh perf24b 3`, the final arm first each round, so no order favors it), ms:

| | final | base |
|---|---|---|
| `alpine_jit_total` | 4,328 · 4,002 · 3,962; **4,002** | 3,950 · 3,956 · 3,957; **3,956** |
| `alpine_user_jit_total` | 10,662 · 10,756 · 10,665; **10,665** | 10,760 · 10,610 · 10,617; **10,617** (+0.5%) |

The boot's first round is the session's first boot (its `compileNs` 58 ms where every other run took 50-51), and
the code both arms make is byte-identical with the same emit time from round 2, so we read the boot's +1.2% as host
noise, not the change. Alpine's userspace is within the floor. The same `emitNs` counter may explain loops 21 and 23's
slightly slower gates. **Size:** `emit_region` 18,293 → 18,892 bytes (`tools/wasm-sizes.ts`; 19,192 with the eager
table), `access` for `ldst_fp` 9,078 → 9,171, `scalar_uses` 2,308 new; the core 9,391,681 → 9,418,141 bytes.
**Memory:** nothing at run time; while compiling, 8 bytes a word for the block being emitted, only in blocks with a
single or double load.

No step count moved. CI: `scripts/ci.sh` (784 s), `scripts/ci-jit.sh` (102 s) and `scripts/ci-fp.sh` (504 s) pass.

## PERF loop 25: do loops 21-24 add up on the gates? (2026-11-14)

Loops 21, 23 and 24 each measured the JIT gates slower in every round by 0.4-0.8%, under the floor; the question was
whether the sum is a regression. Raw: `results/perf25/` (the Mac's JSON; `perf25a-*`, `perf25b-*`, `perf25c-*` the
three rounds).

**The arms:** base = 36c399a1 (just before loop 21, built in `../waarm64-base`: the core 9,319,175 bytes, as loop
21's base), new = e7575694 (loop 24; f64ff188 after it touches only the page: 9,418,983 bytes, the same file as loop
24's final arm). Checked by size (`tools/wasm-sizes.ts`): `Mmu::miss` 1,088 → 1,195, `Vm::io_par` absent → 341,
`emit_region` 17,112 → 18,892, `Func::chain_open` 731 → 839, `scalar_uses` absent → 2,308.

**The screen** (`bench/interp/ab-mac.sh`, one round a call, base first in rounds 1 and 3, new first in round 2;
M4, macOS, Chrome for Testing 157.0.8103.78; the harness's median of 5 boots, 3 userspace runs, 8 placements):

| | base r1 · r2 · r3; median | new r1 · r2 · r3; median |
|---|---|---|
| `alpine_jit_total`, ms | 3,851 · 3,933 · 3,950; **3,933** | 3,935 · 3,948 · 3,954; **3,948** (+0.4%) |
| `alpine_user_jit_total`, ms | 10,539 · 10,619 · 10,607; **10,607** | 10,659 · 10,580 · 10,655; **10,655** (+0.5%) |
| `jit_fp_mips`, MIPS | 3,222 · 3,209 · 3,215; **3,215** | 3,441 · 3,472 · 3,465; **3,465** (+7.8%) |

The gates' rounds overlap (the boot's new 3,935 under base's 3,950; userspace's new 10,580 under base's 10,607 and
10,619) and the sums are under the ~1% floor: **the four loops don't add up to a regression shown**. The base's
first round is the session's first boots and the fastest of it (3,851). The arm run first in a session's first
round is an outlier in every screen since loop 21: fast in loops 21, 23 and 24's first (3,910, 3,865, 3,861, the
base each time, which made those screens read the new arm slower), slow in loop 24's second (4,328, the new arm).
Without round 1 the boot is +0.4% and +0.1%. The FP guest keeps loop 23's gain.

**The counters** (the same in every round of an arm, but for the emitter's time):

| | base | new |
|---|---|---|
| Alpine's boot: `emitNs`, ms | 167.9 · 169.0 · 170.2 | 176.3 · 176.1 · 175.9 (+6-8) |
| Alpine's boot: modules' bytes | 12,102,464 | 12,120,141 (+0.15%) |
| Alpine's boot: `compileNs`, ms | 51.6 · 50.2 · 51.2 | 50.1 · 51.0 · 50.7 |
| Alpine's boot: TLB misses | 580,302 | 520,646 (the device pages, loop 21) |
| userspace: `emitNs`, ms | 233.6 · 234.7 · 233.4 | 242.8 · 243.4 · 244.2 (+9-10) |
| userspace: bytes | 16,596,829 | 16,623,681 (+0.16%) |
| userspace: `compileNs`, ms | 76.7 · 77.8 · 76.2 | 77.1 · 77.5 · 77.1 |

Dispatches (5,775,582; 9,808,548), helper kinds, blocks and modules are equal in both arms. From the earlier loops'
committed JSON, which loop moved what: the bytes moved in loop 22 (`fallback_arm`'s reloads: loop 23's base,
c0b88ae0, already makes 12,120,141), the emitter's time in loop 23 (~170 → ~175 ms, the shadows' bookkeeping; loop
24's lazy table brought its own eager +12 ms back out); loop 21 moved neither. **Where the rest is:** the emitter's
+6-8 ms is ~0.2% of the boot and +9-10 ms ~0.1% of userspace, run on the vCPU's thread at compile; the code's
+0.15% bytes may cost a little in V8's compile (`compileNs` level) or at run time; together they are of the size
of the medians' 0.4-0.5%, which is under what this screen resolves. Nothing to fix at that size: a cheaper
`emit_region` bookkeeping for blocks without scalar FP would be the place to look if a later loop stacks more there.

Also: `bench/run-mac.sh` bounds its Mac side now (`perl -e 'alarm'`, `MAC_TIMEOUT`, 580 s by default), so a hung
run no longer outlives the local `timeout`. No step count moved. CI: `scripts/ci.sh` (783 s) passes.

## PERF loop 26: Liftoff's zero-fill, measured (2026-11-14)

The backlog's "Liftoff zero-fills its locals at every entry", bounded at ~0.3% of a browser from a profile's sample
shares (M8), and the question of whether loop 23's f32/f64 shadows made more functions fill. Raw:
`results/perf26/` (README; the Mac's JSON, the counts, the tools).

**V8's rule, from its source** for both browsers in use (Chromium 155.0.8059.84's V8 712e1808, Chrome for Testing
157.0.8103.78's 30710815; `src/wasm/baseline/liftoff-compiler.cc` `SpillLocalsInitially` and
`arm64/liftoff-assembler-arm64-inl.h` `FillStackSlotsWithZero`, the same text in both): Liftoff fills when a function
has more than 12 locals besides its parameters (half the 24 cache registers) or any local not i32/i64; it fills every
local's slot (8 bytes, 16 for a v128) at every entry, with straight `stp xzr, xzr` for up to 96 bytes and past that a
loop of 4-byte stores (`sub`, `str wzr, [x16], #4`, `cbnz`: two turns a local, four a v128). `tools/fillcost.mjs`
(`node --liftoff-only`, the dev VM): a call costs 2.0 ns with 12 locals of any scalar type, 8.2 with 13, then
+0.23 ns a turn (11.5 at 20, 17.0 at 32); f64 locals fill as i64 ones do; 12 v128s cost 13.3 ns.

**Counts** (`tools/locals.ts`, every module of the guest in Node; before = the core before loop 23):

| | FP guest before · now | Alpine boot | Alpine userspace before · now |
|---|---|---|---|
| functions (incl. the modules' NZCV helpers) | 69 · 69 | 7,236 | 10,308 · 10,308 |
| zero-filled | 25 · 25 | 3,560 (49.2%) | 4,861 · 4,861 (47.2%) |
| of those, with 12 or fewer locals: by a v128 · by f32/f64 alone | 0 · 0 | 3 · 0 | 17 · 0 → 10 · 7 |
| functions with f32/f64 locals (locals) | 4 (4) · 15 (111) | 0 | 0 · 17 (34) |
| fill loop turns, a filled function | 71.2 · 73.4 | 42.4 | 42.2 · 42.2 |
| integer-only at 13-16 locals | 2.9% | 14.8% | 14.0% |

**Loop 23 made no function fill that didn't**: every function with a shadow already filled (more than 12 locals, or
a v128 for the register its scalar FP wrote); in Alpine's userspace 7 functions with 12 or fewer locals fill now for
their f32/f64 locals where they filled for a v128 before, more cheaply (a shadow's slot is 8 bytes, a v128's 16: 5
more of them take the straight fill). The FP guest's fills are 3% longer (73.4 turns against 71.2), in functions
whose hot paths run in TurboFan. Nothing to fix there: not declaring shadows (or declaring them differently) can't
take a function under the rule, and the shadows' functions have more than 12 locals anyway.

**What the fill costs** (no profile: an A/B that doubles it). `pad.patch` declares 21 unused i64 locals more in every
function Liftoff fills (42.4 → 84.3 turns a filled function in Alpine's boot): TurboFan drops unused locals, and the
code, compile time and emit time are the base's (Alpine's modules 12,120,141 → 12,127,341 bytes; `compileNs` 50-51
ms both), so the difference is the fill's. `bench/interp/ab-mac.sh` on the Mac (M4, Chrome for Testing
157.0.8103.78), base first in rounds 1 and 3, ms:

| | base r1 · r2 · r3; median | pad r1 · r2 · r3; median |
|---|---|---|
| `alpine_jit_total` | 3,852 · 3,951 · 3,938; **3,938** | 4,003 · 4,058 · 4,049; **4,049** (+2.8%) |
| `alpine_user_jit_total` | 10,943 · 10,606 · 10,604; **10,606** | 10,732 · 10,821 · 10,784; **10,784** (+1.7%) |

The boot's rounds don't overlap; userspace's do only through base's first round (the session's first run, IQR ±504
ms: loop 25's outlier), the other two 10,604-10,606 against 10,784-10,821. Since a fill's cost is linear in its turns
(above), **today's fills cost about 2.8% of Alpine's boot and 1.7% of its userspace on the Mac**: ten times the
backlog's ~0.3% (which came from a profile's prologue share in the VM, against a browser's busy time; Alpine's JIT
time is two-thirds Liftoff code, docs/v8.md "Tiering").

**Where a filled function's locals come from** (a diagnostic core counting the locals each function with more than 12
uses, by role; Alpine's boot, 3,557 functions): 21.1 locals each, of them **10.6 guest X registers**, 3.1 i32
scratch, 2.5 i64 scratch, 2.1 flag locals and 2.8 others (ENTRY, TAKEN, SUM, V registers, FP scratch); userspace
the same shape (10.5 X registers of 21.1). So the lever is the X registers: a local each per register the function
touches, held from first use to the write-back. One local fewer in every filled function saves ~0.13% of the
boot (2.8% × 2 of 42.4 turns); getting a function to 12 or fewer saves its whole fill, which 14.8% of
the functions (13-16 integer locals) are near.

**Not built**: no cheap change reaches it. Every scratch local is used where it's declared (`compact_locals`
declares only those), the flag and scratch locals are split by type (i32 and i64 can't share a wasm local), and
parameters (which Liftoff doesn't fill) would cost every caller the same stores. What would: sharing one local
between X registers whose live ranges don't overlap within a function (a backward liveness pass, as
`emit::scalar_uses` is for shadows, plus region merges and failure chains that know a local's register changes),
docs/backlog.md's entry with these numbers. No core change; no step count moved. CI: `scripts/ci.sh` (864 s) passes.

## PERF loop 27: sharing X-register locals, estimated (2026-11-14)

The backlog's "Liftoff zero-fills its locals at every entry: share X-register locals" (loop 26: today's fills cost
~2.8% of Alpine's boot and ~1.7% of its userspace on the Mac). Estimated before building, with a diagnostic core;
**not built**: the whole design is worth under the noise floor. Raw: `results/perf27/` (README, `diag.patch`,
`tools/estimate.ts`, `counts.txt`).

**The model** (the best sharing can do without changing what a function holds where it's used): each X register
drops its local after its last touch in the function (a read or write, as the first emission sees them), stored
there if dirty; registers whose held ranges never overlap share a local (greedy colouring). Two scopes: the block
step (single-block functions, ranges cut at helper calls, which drop every local) and the region step (every
non-looped region too, members in order, ranges not cut). In a loop every register the loop touches is live at the
head, so looped regions keep theirs in both. Costs the model leaves out, all against sharing: a dropped register in
an open failure chain makes the next site start a new chain (more wasm), and an edge stores a dirty register its
target doesn't need where the exit stored it before.

**Counts** (`tools/estimate.ts`, Node in the dev VM; the X locals today match loop 26's role count, 37,711 against
37,709). Of the 3,560 functions Alpine's boot fills, only 412 are single blocks outside a loop; 650 are looped
regions and the other 2,498 forward regions (userspace: 634, 845 and 3,382 of 4,861).

| | block step: boot · userspace | region step: boot · userspace |
|---|---|---|
| X locals in filled functions (today 37,711 · 50,968) | 36,011 · 48,654 | 29,292 · 39,744 |
| functions out of the fill | 225 · 309 | 405 · 534 |
| fill turns, static (today 150,422 · 204,368) | −5.3% · −5.4% | −17.0% · −16.6% |
| **fill turns, weighted by calls** (94 M · 429 M calls of filled functions) | **−3.7% · −2.1%** | **−14.9% · −13.5%** |

The weighted count: every filled function's prologue added its fill's turns today and with sharing to two
counters. A fill's cost is linear in its turns (loop 26's `fillcost.mjs`; a function that leaves the fill also saves
~1 ns of the loop's setup, ~5 turns, under 0.03% here), so with loop 26's measured cost **the block step is worth
~0.1% of Alpine's boot and ~0.04% of its userspace, and the whole region design at best ~0.4% and ~0.25%**: under
the ~1% a Mac A/B can tell, before the costs the model leaves out.

**Cheaper ways, bounded the same way**: a local fewer in every filled function is ~0.13% of the boot (loop 26);
with the 320 functions at exactly 13 locals (9% of those filled, static) leaving the fill too, ~0.3%. No single
local is that cheap to take out: the scratch locals are four fixed roles of each type (ADDR, BASE, OFF, a
temporary; HOST, TLBE, a temporary, a call's result), the flag locals are split by type (2.1 a filled function: about one
setter size's pair), and the entry PC (local 1) as a parameter would change the block type for every
caller (the dispatcher, the jump and transfer caches, imports, host calls) for that one local.

The work this would take, for the block step alone: a last-touch table from the first emission, drops with their
stores, a colouring the second emission's `Func::local` follows, a check at every register-local access that no
other held register shares its local (falling back to one local each), failure chains that don't join across a
drop; then regions (live-in masks on the entry states, the settled emission's conflicts) for the rest. Out of
proportion to ~0.1-0.4%. No core change; no step count moved. CI: `scripts/ci.sh` passes but for `tests/usb-keyboard.test.ts`'s glue
case, a fixed 20 ms wait under load that passes alone (docs/backlog.md "Tests and tools").

## PERF loop 28: the transfer cache's costs, counted (2026-11-14)

The backlog's "The transfer cache's costs in kernel-heavy phases" (a miss costs a call to the shared miss function, a
TLBI by VA a 16 KiB scan; M8 put both at ~0.7% of the boot from samples). Counted first with a diagnostic core
(`results/perf28/diag.patch`: counters in `TlbStats`, `jit_helper_report` printing them, the scan timed with the host
clock) in `bench/boot/userprof.ts` (Alpine's userspace benchmark in Node, its boot the first phase, `churn` the
fork/exec phase). Raw: `results/perf28/` (README).

**The flushes by VA** (per phase: boot 24,316, compress 1,026, Lua 5,658, churn 12,882, SQLite 9,688, shutdown
6,328): **99.95% cleared nothing** (boot: 11 cleared any of 45 entries; the run: 60,054 flushes, 124 entries), being
for data pages. A scan took ~0.4 µs (wasm, Node, the dev VM): 10 ms of the boot's 3.64 s (0.27%), 0.56% of churn,
0.53% of shutdown, 0.03-0.18% of the compute phases, ~0.2% of the whole run. The nG drops (boot 3,596, 2,755 of them
bumping an EL) and the rest are cheap.

**The miss function** (calls per phase): boot 4.70M (probes hit 15.7M, missed 23%), compress 2.31M (8%), Lua
1.98M (1.5%), churn 1.39M (25%), SQLite 1.73M (2.5%), shutdown 0.76M (13%). Through a probe the boot's misses are
2.08M zeroed entries (a target not entered yet), 0.95M another VA's, 0.13M an older generation: little to save but
the conflicts, and 65,536 entries measured as 16,384 in M8. But most calls outside the boot don't come from a probe:
**host returns that land elsewhere than the call's continuation** (boot 1.57M, compress 2.00M, Lua 1.80M, churn
0.82M, SQLite 1.20M, shutdown 0.46M: 10-16% of the host returns of the userspace phases), whose entry was valid; a
by-VA link whose check failed is rare (boot 5,747, compress 67,648). Bucketed further (`diag-depth-marks.json`):
all at a host depth under 8, and nearly none (boot 13,675) a region's mispredicted internal return. Two changes
tried on that, neither kept: a probe's miss inside a guest call made a host call (it's a tail call), no change
(`diag-miss-call-marks.json`); a loop around the call that host-calls the miss function at the mismatch and checks the
continuation again, so a lost frame can't make every outer return miss (`diag-with-call-loop.patch`): compress
2.00M → 1.38M, Lua 1.80M → 2.34M, so they aren't such a cascade. Their cause is the backlog's new entry.

**Built: a flush by VA scans only a page that instruction fetches translated** (`Tlb::xpages`, docs/jit.md
"Linking"): eight 4096-bit maps by EL, global or nG and VA half, set in `Mmu::miss` for every fetch it translates
(cached or not), the nG ones cleared with the EL's nG entries when its transfer cache entries go, all of them by a
flush of everything, none by a bump alone (the TLB's entries fill the cache again without a walk). Counted
(`fix-counts-marks.json`): 1,058 of the 60,054 flushes scan (1.8%; the boot 652 of 24,316, 475 of them of the 3,408
in the kernel's half, whose map holds the kernel's text). Memory: 4 KiB a vCPU. Arms by size (`tools/wasm-sizes.ts`):
`Tlb::flush_va` 2,835 → 2,971 bytes, `Mmu::miss` 1,195 → 1,313, `flush_ng` 730 → 768.

`bench/interp/ab-mac.sh` on the Mac (M4, Chrome for Testing 157.0.8103.78), base c283763f, base first in rounds 1 and
3, fix first in round 2, ms:

| | base r1 · r2 · r3; median | fix r1 · r2 · r3; median |
|---|---|---|
| `alpine_jit_total` | 3,872.7 · 3,979.0 · 3,921.3; **3,921.3** | 3,888.2 · 3,896.3 · 3,925.5; **3,896.3** (−0.6%) |
| `alpine_user_jit_total` | 10,488.4 · 10,602.1 · 10,609.8; **10,602.1** | 10,532.3 · 10,553.5 · 10,589.9; **10,553.5** (−0.5%) |

The rounds overlap: within the floor, as the counts bound it (~0.27% of the boot). Kept: it costs nothing the gates
see and takes the scans out of the kernel-heavy phases where they were ~0.5%.

**Tests**: `tests/baremetal/xcache.c` (2 vCPUs): a page of code remapped under a BLR between three callees, each
remap followed by a TLBI (VAE1, VALE1, VAAE1, ASIDE1, VMALLE1; global through an ASIDE1 after an nG page ran at EL1,
then a VAE1; after an IC IALLU, which keeps the TLB's entry), the call right after the TLBI the compiled loop's; then
CPU 1 calling while CPU 0 remaps with each IS form. Its image is mapped by pages: a block entry in the half makes every
flush by VA there drop the EL's whole transfer cache, which hid planted bugs. `mmu::tests` "a flush by VA scans the
transfer cache for fetched pages". Planted, each failing both: never scanning; dropping the nG entries clearing the
global maps; a bump clearing them; global fetches not marked. Skipping the IS by-VA flushes on the other vCPUs fails
the bare-metal test too. `isb.bin` came out of `build.sh` different (the clang here), rebuilt with the others. No step
count moved. CI: `scripts/ci.sh` (794 s) and `scripts/ci-jit.sh` (261 s) pass.

## PERF loop 29: the review of loop 28 (2026-11-16)

The out-of-context review of loop 28 (`review/perf-l28`) found:

1. **(High, from 53c603b6) A block's transfer cache entries outlived the block's TLBI.** `Tlb::xblk[el][half]` (a
   flush by VA in the half bumps the EL's transfer cache, since the block's other pages may have entries there) was
   set only by a fill of an instruction TLB entry from a block, and cleared by every bump. A bump drops only the
   transfer cache: the TLB's block entries stay, and the dispatcher and the miss function fill the cache again from
   them on a hit, with no fill to set the flag. A TLBI later for another page of the block (Linux's one TLBI per
   2 MiB: munmap, mremap, migration of an exec THP) then dropped the TLB's entries but left the refilled transfer
   cache entry, and compiled code kept branching to the old block. Any bump cleared the flag: the JIT's dropping
   blocks (frequent), a flush by VA of any page of the half, the nG entries' drop.
2. **(Low)** `xpage_bit`'s comment: the 12-bit fold keeps the pages of an *aligned* 16 MiB apart, not any 16 MiB.
   Comment and docs/jit.md fixed. A collision only costs a scan.

The review's latent case (a RAM region not in whole pages, whose block page would hand out a translation without a
TLB fill) can't arise in a VM: `Mem::at`, `with_spill` and `with_window` assert whole pages (docs/cpu.md); only the
bare `mem_new` export (the interpreter benchmarks, MMU off) skips `at`. Nothing added.

**The fix:** `Tlb::xblkn[el][half]` counts the EL's live instruction TLB entries from blocks (`fill` adds,
`drop_slot` removes; `drop_slot` forced inline, which keeps `fill`, `flush_va` and `flush_ng` as before), and a bump
sets `xblk` from it instead of clearing it: after a bump the cache can hold an entry for a page of a block only if
an entry from a block was live then or was filled since. Checking the count at flush time alone would be wrong: an
entry for a page whose TLB entry was since evicted would survive (a case of the new unit test). Setting the flag
at the transfer cache's fills from a hit, the review's other direction, would add a load to the miss function; this
adds nothing to compiled code or the dispatcher, only an add or subtract on a TLB fill or drop of a block's entry.
What it does cost: while Linux's kernel text (2 MiB blocks, global) is in EL1's instruction TLB, every flush by VA in
the kernel's half bumps EL1's transfer cache (3,408 of the boot's 24,316 flushes by VA, loop 28's counts), as was
the intent.

**Measured** (`bench/interp/ab-mac.sh`, the Mac M4, Chrome for Testing 157.0.8103.78, base 818a9422, base first in
rounds 1 and 3, fix first in round 2; `results/perf29/`), ms:

| | base r1 · r2 · r3; median | fix r1 · r2 · r3; median |
|---|---|---|
| `alpine_jit_total` | 4,013.9 · 4,034.8 · 4,027.6; **4,027.6** | 4,016.9 · 4,021.6 · 4,050.8; **4,021.6** (−0.1%) |
| `alpine_user_jit_total` | 10,806.3 · 10,823.6 · 10,814.2; **10,814.2** | 10,803.2 · 10,805.3 · 10,892.9; **10,805.3** (−0.1%) |

The rounds overlap: no cost the gates see. Memory: 16 bytes a vCPU.

**Tests**, each failing on 818a9422 first: `mmu::tests` "a block flush drops transfer cache entries filled from
hits" (the review's two cases and the nG drop's, each with and without the page's TLB entry evicted by a page's:
all six failed); `tests/baremetal/xblock.c`: a BLR into a page of a 2 MiB block, the transfer cache dropped with the
TLB's entry kept (IC IALLU; a TLBI of a data page in the half; an nG page run, then ASIDE1), the calls going on, then
the block remapped and flushed by VA at its start: under the JIT in Node, each of the three failed on the unfixed
core (exits 132, 138, 144: the new block's first call ran the old code). It passes on hvf (the M4, `oracle.sh
--hvf`); QEMU 11.1's TCG fails it as we did (exit 132; docs/testing.md). Planted: the count not decremented (fails
`block_counts_follow_their_block`, which now checks the counts); the flag replaced by the count at flush time (fails
the new unit test's evicted cases). The other bare-metal binaries came out of `build.sh` unchanged. No step count
moved. CI: `scripts/ci.sh` (838 s) and `scripts/ci-jit.sh` (112 s) pass.

## SNAPZ: compression across the emulator, measured (2026-11-15)

The M4 dev VM (Lima, 8 vCPUs), Chromium 155.0.8059.84 headless, commit 40751074; nothing else ran. Tools:
`bench/snapz/` (its README); raw: `results/snapz-eval/`. The question (the user's): which codec and which wiring makes
snapshot operations on a multi-hundred-MB machine fastest at about today's ratio; the snapshot's codec 2, qcow2's
clusters, the export. Format compatibility with existing snapshots was not required. The guest's agent is out of scope:
the page ships it already compressed (zopfli).

**The guest:** `target/snapbench/pages.waarm64snap` (`bench/gpu/warm-snapshots.sh firefox`: Arch Linux ARM, sway,
Firefox on a still page; 4 vCPUs, 2560 MiB), a 689 MB file: 1.52 GB of non-zero RAM pages in 1,577 frames, 109 MB of
3D state (138 BLOB frames), 49 MB of disk blocks (11,952), 1.4 MB of CORE and DEVS. The core's LZ gets 2.26x on its
RAM (3.3x on loop 4's Alpine image: a desktop's pages pack worse).

**Today's save and load on the page** (`phases.json`; the page's code timed by `bench/snapz/phases.patch`, two saves):

| | ms |
|---|---|
| save: the pause | 4,148-4,251 |
| ... the devices' state (3D read back) | 187-218 |
| ... RAM: compress (the core's LZ, one thread, ~520 MB/s) | 2,894-2,920 |
| ... RAM: the frames' CRC (JS) and encoding | 422-431 |
| ... RAM: the zero-page scan and the gather | 305-402 |
| ... the sink (the download path's `snapshot-chunk` posts) | 118-125 |
| ... the disk's blocks | 145-175 |
| load (Load snapshot to `running`) | 9,782 |
| ... the check pass: read 242, CRC (JS) 424 | 674 |
| ... RAM: read 184, CRC 347, decompress 1,688, `applyRam` 313 | to 3,209 from the start |
| ... the disk's blocks into the overlay, one 4 KiB write each | 2,245 |
| ... the rest (the machine started: workers, the core, the 3D state restored) | ~4,300 |

**Off the record, OPFS costs ~250 µs a call.** Playwright's default context (`browser.newContext()`) is off the
record: OPFS lives in memory behind IPC, and every sync-handle `read` or `write` costs 210-300 µs whatever its size
(50 MB in 4 KiB reads: 2.6 s; in 1 MiB reads: 25 ms; `opfs.json`). In a profile on disk (`WAARM64_PROFILE`) a 4 KiB
read is ~1 µs (12 ms; `opfs-persistent.json`). So the page tests' and benches' snapshot numbers overstate the disk's
part: the same save paused 6.4-6.7 s off the record (the disk's blocks 2.3-2.6 s) and the load took 15.3 s; the warm
snapshot's own save, 7.5 s. An incognito window pays it too. Measure snapshots with a persistent profile.

**The codecs on one thread** (`single-2.json`; 3 rounds, alternated, each after a 64-frame warm-up: a new module's
first frames run in Liftoff; the RAM frames whole, the slow codecs on every fourth; MB/s of raw bytes, the copies in
and out of the codec's memory included):

| codec | ratio | compress | decompress |
|---|---|---|---|
| the core's LZ (`core/src/lz.rs`) | 2.26 | 503-512 | 934-1,069 |
| lz4_flex 0.14.2 (unsafe paths) | 2.31 | 614-620 | 2,047-2,120 |
| lz4_flex, `safe-encode` + `safe-decode` | 2.31 | 582-595 | 1,970-2,009 |
| snap 1.1.2 (raw) | 2.27 | 653-669 | 1,464-1,507 |
| zstd 1.5.7 (C, through zstd-safe), level −4 | 2.37 | 665-686 | 1,505-1,545 |
| zstd −1 | 2.77 | 590-602 | 1,354-1,377 |
| zstd 1 | 3.14 | 516-525 | 1,034-1,068 |
| zstd 3 | 3.39 | 363 | 928 |
| miniz_oxide 0.9.1, level 1 (deflate-raw) | 2.80 | 250 | 397 |
| fflate 0.8.3, level 1 | 3.12 | 80 | 204 |
| `CompressionStream('deflate-raw')` | 3.26 | 82 | 449 |

ruzstd 0.9.1's encoder ("Fastest") was 123 MB/s at 2.34x (a first run, its JSON not kept: it shared the machine with
the warm snapshots' making); miniz_oxide 6 and fflate 6, 40-52 MB/s. CRC-32: crc32fast 1.5 in wasm 3.4 GB/s; the
page's JS slicing-by-8 0.5-0.7 GB/s cold and 1.7 warm. **lz4_flex and the core's LZ read each other's output**
(`bench/snapz/compat.mjs`: 800 frames each way, byte-exact): both write the LZ4 block format, so lz4_flex can be codec
2 with every existing file still readable.

**The wiring: a pool of workers** (`pool-1.json`; 3 rounds). Frames are dealt to `n` workers (frame c to worker
c mod n, three in flight each), each reading its raw frame straight from a SharedArrayBuffer (guest RAM's stand-in),
compressing it in its own instance and taking the CRC in wasm; the coordinator writes them in order. The frames were
gathered beforehand, so the scan (~0.35 s on one thread) is not in these. Wall ms for the 1.52 GB:

| codec | n=1 | 2 | 4 | 6 | 4, the OPFS sink | 4, CRC in JS | restore n=1 | restore n=4 |
|---|---|---|---|---|---|---|---|---|
| the core's LZ | 3,149-3,171 | 1,650-1,669 | 872-875 | 689-717 | 1,114-1,376 | 955-1,043 | 2,088-2,220 | 571-575 |
| lz4_flex (safe) | 2,783-2,826 | 1,452-1,481 | 757-770 | 598-608 | 967-1,008 | 836-867 | 1,449-1,462 | 404-412 |
| zstd −4 | 2,443-2,453 | 1,288-1,296 | 682-688 | 557-566 | 901-925 | 788-824 | 1,639 | 462 |
| zstd −1 | 2,729-2,730 | 1,428-1,438 | 757-767 | 621-632 | 939-942 | 844-885 | 1,686-1,695 | 476-501 |
| zstd 1 | 3,070-3,134 | 1,596-1,602 | 840-843 | 694-698 | 1,005-1,051 | 928-946 | 1,966-1,970 | 538-545 |

The pool scales near-linearly to 4 (3.6x) and gives ~20% more at 6; the codec adds 10-20% over the core's LZ at any
`n`. The OPFS sink (a sync access handle written by the coordinator between dispatches) adds ~0.2-0.25 s at 4.
"restore": each worker CRCs its stored frame, decompresses it and writes it into a shared output.

**The picked file's stream** (`clusters-1.json`'s `writable`: `createWritable` on an OPFS file, as on a picked one):
680 MB in 450 KB writes in 1.50-1.72 s, ~430 MB/s, awaited one by one or eight in flight alike. A pool makes ~0.8 GB/s
of output: on that path the stream becomes the pause.

**qcow2's clusters** (`clusters-1.json`; 1,500 non-zero 64 KiB pieces of the corpus deflated at level 6 by fflate, 2.89x;
8,000 4 KiB pieces; µs a cluster, two runs):

| | DecompressionStream / CompressionStream | fflate | miniz_oxide in wasm |
|---|---|---|---|
| inflate a 64 KiB cluster (a disk's read) | 393-410 | 301-332 | 159-163, synchronous |
| deflate a 4 KiB cluster (an export), level 6 | 307 (3.06x) | 86-87 (3.09x) | 66 (3.12x) |
| the same, level 1 | | 68-70 (2.97x) | 20-21 (2.81x) |

**Where this leaves the snapshot's wait** (projected for this guest, a kept snapshot or a suspend, 4 workers): the
pause from 4.2 s to ~1.2-1.3 s (the state 0.2, RAM ~0.9 with lz4_flex and the scan dealt out too, the disk's blocks
0.15), ~1.0-1.1 s with 6; the load's compression share from ~3.3 s to ~0.8 s (9.8 s to ~7 s), the rest being the
overlay's per-block writes (2.25 s) and the machine's start (~4.3 s), neither of them compression.

**Decided (the user, 2026-11-15):** lz4_flex replaces the core's LZ (codec 2), crc32fast takes the CRC into wasm, and
the save and the load go through a pool; a picked file is staged through OPFS when there's room, else written
directly. zstd (C: clang for wasm32 in every build) was not taken. The work: the SNAPZ track (its kickoff in git history; the outcome: "SNAPZ: the track's end").

## SNAPZ loop 0: the probe and the baseline (2026-11-15)

The M4 dev VM (Lima, 8 vCPUs), Chromium 155.0.8059.84 headless, a persistent profile (`target/snapz/profile`),
this loop's tree (on c0297bd8); nothing else ran. Raw: `results/snapz-0/` (`<guest>.json` per round, `summary.txt` and
`summary.json` from `bench/snapz/probe-summary.ts`, the logs). **Built:** the page's save and load time themselves by
phase, always (docs/frontend.md "Snapshots": `#message`'s `data-snapshot` for every save, a kept one, a file and a
suspend, with its `kind` and `phases`; `data-load` for a start from a snapshot or a suspended copy), and
`bench/snapz/probe.ts` (docs/benchmarking.md "The snapshot probe"), which replaced the measuring session's
`phases.patch` and `probe-save.ts`. Three rounds each, `SETTLE_S=20`; median (range), ms.

**Does it measure what the REPORT did?** The transient machine (`MODE=transient`: the file itself, a download) loaded
the desktop file in 9,905 (9,546-10,414) and paused 4,335 (4,225-4,644) for the file: the entry above's 9.8 s and
4.15-4.25 s. The stored machine (the probe's default: the same frames under its header) loaded in 9,757
(9,537-10,183) and paused 4,310 (4,287-4,445) for a file. Same thing measured.

**The desktop guest** (`target/snapbench/pages.waarm64snap`, 689 MB; a stored machine):

| save | paused | state | blobs | ram (scan / compress / crc / sink) | disk | close | MB |
|---|---|---|---|---|---|---|---|
| kept | 4,216 (4,130-4,427) | 237 | 46 | 3,804 (560 / 2,807 / 434 / 100) | 128 | 177 | 690 |
| file (a download) | 4,310 (4,287-4,445) | 188 | 48 | 3,898 (515 / 2,922 / 428 / 128) | 170 | 0 | 693 |
| suspend | 4,275 (4,061-4,344) | 176 | 63 | 3,820 (560 / 2,756 / 413 / 97) | 0 | 210 | 675 |

(`scan`, `compress`, `crc`, `sink` are summed over all the frames: RAM's are nearly all of them. `close`: a kept
snapshot's file closed after the resume, a suspended copy's before the stop. The vCPUs stop in 0-4 ms.)

| load | total | prepare | check (read / crc) | state | ram (read / crc / unpack / apply) | disk | start | wall |
|---|---|---|---|---|---|---|---|---|
| a file | 9,520 (9,297-9,978) | 1,907 | 678 (252 / 424) | 101 | 2,375 (166 / 355 / 1,686 / 287) | 2,123 | 2,231 | 9,757 |
| the resume | 7,919 (7,551-7,999) | 2,081 | 599 (183 / 407) | 97 | 2,619 (205 / 349 / 1,741 / 373) | 0 | 2,498 | 8,454 |

`prepare` is the core fetched and compiled (and the firmware's files); `start` the rest to `running` (bootVm's own
work, the machine's workers, the 3D state put back): the entry above's "~4.3 s, the machine started" is these two.
The disk's 11,952 blocks into the overlay, one 4 KiB write each: 2.1 s (loop 5's).

**Debian** (`target/snapbench/debian-go.waarm64snap`, 97 MB now: the balloon's hint leaves 700 MB of free memory out;
a stored machine): kept pauses 589 (579-601: ram 549, of it compress 380, scan 98, crc 61), a file 609 (606-615),
a suspend 559 (558-567); a load 2,020 (1,918-2,101: prepare 376, check 96, ram 336 with unpack 230, disk 460 for 2,103
blocks, start 699), a resume 1,424 (1,387-1,480). The transient machine: load 2,198, file 614.

**Memory** (the browser's processes, RSS summed and PSS; added = the peak during a save over the memory before it):
the desktop's kept save added 52 MiB (25-269), the file 994 (977-1,031: the page holds the download's 690 MB of Blob
parts), the suspend 186 (182-192); Debian's 63, 193, 68. Against these the pool's instances (loop 2) state theirs.
**The browser's memory grows with each load:** the desktop's was 3.3 GB resident before the first round's saves, 5.5
before the second's and 7.2 before the third's (PSS 2.7, 4.9, 6.6); the transient rounds 3.4, 6.2, 7.9; Debian's
transient 1.8 to 2.7, its stored rounds flat at 1.7-1.8. Which process holds it isn't found yet (docs/backlog.md).

## SNAPZ loop 1: lz4_flex and crc32fast in the core (2026-11-15)

The M4 dev VM (Lima, 8 vCPUs), Chromium 155.0.8059.84 headless, the persistent profile `target/snapz/profile`;
nothing else ran. Raw: `results/snapz-1/` (`<guest>-<arm>.json`, three rounds each, joined from `rounds/` by
`merge.ts`; `summary.txt`, `summary.json` from `bench/snapz/probe-summary.ts`; `run-ab.sh`, the driver; `ab.txt`, its
log). **Built:** lz4_flex 0.14.2 (`safe-encode`, `safe-decode`, no defaults: the hash table on the stack, no
allocation) behind codec 2's exports in place of `core/src/lz.rs` (removed; its contract tests ported to
`core/src/codec.rs`), and crc32fast 1.5.5 behind a new export, `crc32(seed, src, len)`, which the writer and the
reader take the frames' checksums through (`Codec.crc32`, `web/lz.ts`); the header's CRC stays JS's. ABI 68
(docs/abi.md "SNAPZ: the snapshot codec and CRC").

**The arms:** base = baa1e0b3 (the tree checked out and its wasm, core `d7814c3d…`, ABI 67), new = this loop's tree
(core `0ffff6be…`, ABI 68), each wasm copied into the build's path before its round; each round's JSON records the
commit and the core's hash, and a wrong pairing fails the page's ABI check. Alternated base, new, ×3 per guest, **each
round a browser of its own** (`ROUNDS=1`): loop 0's growth of the browser's memory within a session (~2 GB a desktop
round) can't build up across rounds or favour an arm (the RSS before each desktop save stayed 3.3-4.2 GB in every
round of both arms). Both arms load the same warm file (written by the old codec: the new arm's load is the old
format's compatibility, at speed); the resume loads each arm's own suspend. Median (range), ms:

| desktop (689 MB file) | base | new | |
|---|---|---|---|
| kept: paused | 4,175 (4,162-4,221) | 3,786 (3,755-3,820) | −9.3% |
| ... compress | 2,792 (2,787-2,810) | 2,554 (2,548-2,558) | −8.5% |
| ... crc | 425 (418-428) | 293 (290-296) | −31% |
| file: paused | 4,193 (4,192-4,302) | 3,792 (3,776-3,795) | −9.6% |
| suspend: paused | 4,101 (4,085-4,113) | 3,729 (3,700-3,749) | −9.1% |
| load (the old file): wall | 10,066 (10,041-10,369) | 9,232 (9,131-9,442) | −8.3% |
| ... check's crc | 416 (415-421) | 272 (271-278) | −35% |
| ... ram's unpack | 1,810 (1,684-1,814) | 1,145 (1,117-1,223) | 1.6x |
| resume (its own suspend): wall | 8,343 (7,893-8,385) | 7,244 (7,184-7,423) | −13% |
| ... unpack | 1,667 (1,647-1,689) | 999 (956-1,005) | 1.7x |
| file's size, MB: kept / file / suspend | 690 / 693 / 676 | 676 / 679 / 661 | −2% |

| Debian (97 MB file) | base | new | |
|---|---|---|---|
| kept: paused | 588 (575-604) | 530 (518-551) | −10% |
| file: paused | 610 (601-618) | 543 (543-547) | −11% |
| suspend: paused | 562 (556-571) | 506 (499-507) | −10% |
| load: wall | 2,181 (2,179-2,372) | 2,077 (1,970-2,087) | −5% |
| resume: wall | 2,035 (1,938-2,141) | 1,931 (1,827-2,016) | −5% |
| file's size, MB (kept) | 97 | 95 | −2% |

No range overlaps for any pause or load. **Against the eval's margins** (one thread, its harness): compression 8.5%
faster on the page (the eval: 10-20%; the page's figure includes the copies in and out of the codec's memory, the
same in both arms), decompression 1.6-1.7x (the eval: ~2x, its copies included too), the CRC 31-35% less time
(crc32fast's 3.4 GB/s of the eval, less a copy of the stored bytes into the codec's buffer each time: 293 ms for the
desktop's ~680 MB is 2.3 GB/s, the JS's 1.6). The copy is the one-thread path's; loop 2's workers take the CRC where
`lz_compress` left the bytes (the exports' shape: docs/abi.md), so it wasn't optimized here.

**Memory:** nothing added: the codec's instance is the one it was (two 1.1 MiB buffers now, 5% more, `lz_bound` being
lz4_flex's larger bound). A save's added RSS: desktop kept 21 MiB (13-46; the base's rounds −165 to 274, noise of
a settling browser), file 990 (the download's Blob, as before), suspend 182 (183); Debian 65, 186, 46 (61, 194, 66).

**Compatibility:** `tests/fixtures/old-lz.waarm64snap` (52 KB, written by the old codec before its removal: CORE,
DEVS, two RAM frames, three DISK runs, all codec 2; its content from `tests/old-lz-content.ts`) loads byte-exact
(`tests/snapshot.test.ts`, and natively `core/src/codec.rs` `old_codec_frames_still_load`); the desktop's warm file
loaded in every new-arm round above.

## SNAPZ loop 2: the save's pool (2026-11-15)

The M4 dev VM (Lima, 8 vCPUs: `hardwareConcurrency` 8, so a pool of 6), Chromium 155.0.8059.84 headless, the
persistent profile `target/snapz/profile`; nothing else ran. Raw: `results/snapz-2/` (`<guest>-<arm>.json`, three
rounds each, joined from `rounds/` by `merge.ts`; `summary.txt`, `summary.json`; `run-ab.sh`, the driver; `ab.txt`, its
log). **Built:** RAM's frames made by a pool of workers (`web/snapshot-pool.ts`, `web/snapshot-pool-worker.ts`;
docs/platform.md "A save's pool"), for a kept snapshot, a file and a suspend: `min(hardwareConcurrency − 1, 6)`
workers, each with a core instance of its own on a small memory, scanning, gathering, compressing and CRC-ing its
chunks straight from guest RAM (the shared memories), chunk c to worker c mod n, three in flight a worker, the machine
worker writing the frames in order. No core or ABI change (loop 1's exports served as they were); the codec's instance
now stubs the core's imports (`codecCore`, web/lz.ts), so a pool worker loads none of web/vm.ts. The pool starts when
the save is asked for, beside the balloon's hint, and ends with the save: no warm pool.

**The arms:** base = 0094eeee (loop 1, one thread), new = this loop's tree (6 workers), four = the same capped at 4
(`POOL_MAX`), all on the same wasm (core `0ffff6be…`); the JSON's commits 2b030a6f and ebd5263f are local commits of
this tree (new, and four's one-line change), squashed into this loop's. Each round a browser of its own (`ROUNDS=1`); Debian base, new
×3, the desktop in a Latin square (base new four, new four base, four base new). Median (range), ms:

| desktop (689 MB file) | base | new (6) | four | new vs base |
|---|---|---|---|---|
| kept: paused | 3,801 (3,767-3,814) | 1,069 (1,067-1,143) | 1,223 (1,184-1,269) | −72%, 3.6x |
| ... ram (wall) | 3,365 (3,332-3,401) | 674 (671-716) | 820 (794-836) | 5.0x |
| file: paused | 3,823 (3,805-3,827) | 1,155 (1,143-1,194) | 1,272 (1,256-1,284) | −70% |
| suspend: paused | 3,665 (3,626-3,742) | 1,100 (1,041-1,132) | 1,206 (1,164-1,218) | −70% |
| kept: wall (Snapshot to done) | 4,154 (4,087-4,177) | 1,392 (1,346-1,498) | 1,535 (1,481-1,642) | |
| the pool's start / the save's wait for it | | 35-38 / 0-28 | 27-31 / 0-20 | |
| file's size, MB: kept / file / suspend | 676 / 679 / 661 | 676 / 679 / 661 | 676 / 679 / 661 | same |

| Debian (97 MB file) | base | new (6) | |
|---|---|---|---|
| kept: paused | 520 (519-523) | 162 (160-165) | −69% |
| file: paused | 535 (534-544) | 168 (167-168) | −69% |
| suspend: paused | 502 (499-515) | 141 (139-143) | −72% |

No range overlaps. Loads and resumes are unchanged (loop 3's), as they should be: desktop load 9,126 / 9,102, resume
7,241 / 6,937; Debian 2,065 / 2,078. **Against the projection** ("SNAPZ: compression…": ~1.2-1.3 s at 4 workers,
~1.0-1.1 s at 6): 1.22 s at 4, 1.07 s at 6. What is left of the 1.07 s: the devices' state 0.23 s (3D read back), the
BLOB frames 0.05, RAM's wall 0.67 (the workers' sums: scan 0.27, codec 2.94, CRC 0.53 s of CPU, against one thread's
0.49 / 2.56 / 0.29: the codec ~15% slower a frame on six busy threads, the CRC's sum includes each frame's copy out of
the worker's memory), the disk's blocks 0.12 (mostly their reads), and the frames' writing in order (sink 0.27 summed,
on the machine worker). The pool's start (six workers and their instances, the core module posted) takes 35-38 ms,
under the hint; the save waited 0-28 ms for it.

**Memory** (the browser's RSS, the peak during a save over the memory before it; samples every 250 ms, ~4 in a 1.1 s
pause): Debian kept +63 → +151 MiB, file +199 → +286, suspend +71 → +68; the desktop kept −5 → +137 (four: +122),
file +987 → +1,303 (+1,456), suspend +185 → +532 (+511). So the pool's six instances cost ~90-140 MiB while a save runs
(Node: a pool of six +132 MiB, six empty worker threads +50: each instance's memory and its isolate); the desktop's file
and suspend added ~170-210 MiB more than that, not explained here (docs/backlog.md). It is transient: no worker stays,
and the RSS before each next save was loop 1's (kept 3,783 against 3,784 MiB; file 3,322 / 3,317; suspend 4,028 /
4,184).

**Correctness:** `tests/snapshot.test.ts` "a save's pool": 32 MiB of RAM on shared memory in two views (zero chunks and
pages, incompressible chunks stored as codec 0, compressible ones; the second view at an offset, numbered on as a spill
memory's) written through pools of 1, 2, 3 and 6 real workers (Node's worker_threads) and on one thread: the files
byte-identical, the progress the same calls in the same order, the pages and frames counted alike; a pool that can't
start (a module without the codec, 0 workers) is none; a pool failing every third chunk and one closed halfway give the
same file (the writer makes those chunks itself); a view not on shared memory is written on one thread. Planted, each
caught by it: frames written as they finish rather than in order; a worker's frame dropped; the pool's replies matched
to the wrong job; the worker's CRC over the stored bytes only; a failed chunk not made by the writer. The page tests'
`checkSave` (tests/snapshot-phases.ts) now has every save on a host with a thread to spare go through a pool.

## SNAPZ loop 2b: older files refused; the save's unexplained memory found and cut (2026-11-15)

The M4 dev VM (Lima, 8 vCPUs: a pool of 6), Chromium 155.0.8059.84 headless, the persistent profile
`target/snapz/profile`, nothing else running. Raw: `results/snapz-2b/` (`rounds/<guest>-<arm>-<n>.{json,log}` and
`.mem.jsonl.gz`, the probe's and memwatch's per round; `summary.py` → `summary.txt`, `summary.json`; `run-ab.sh`, the
driver; `ab.txt`, its log; `rounds/diag-*`, the first diagnosis on 7b7b4342 and one with the recycling alone).

**Part 1, older files refused** (the kickoff's decision 7, now docs/platform.md "The snapshot file"; ABI 69, docs/abi.md "SNAPZ: older files refused"):
gone are codec 1 (deflate-raw) in the reader and as the writer's default (the writer and the reader are given their
codec, whose CRC-32 takes the frames'; `readHeader` reads a header alone with the JS CRC), the old-LZ fixture and its
tests, the core's readers of state versions 4 and 5 (`snapshot_version_min`, the xHCI's state without its CSS state,
a transport's without its carried reset, a format 5 suspended guest's devices), and the page's fallbacks for files of
those versions (a device list without the clock, the notify socket or the balloon, a header without `cpu`, the sound
device's one-stream state). Version 1 files (no BLOB frames) are still what most saves write. An older file is refused
by its header's `coreVersion` before its frames are read (`otherVersion`, also first in the machine worker's restore),
so it gets "made by another version of this web app", not "damaged": tests/snapshot.test.ts (an older header over a
codec 1 frame) and tests/page-snapshot.test.ts (a suspended machine in OPFS rewritten to the older version: the page
boots instead with [Couldn't resume the suspended machine](ui:machine:worker.notResumed) and the refusal as its
detail). Planted: no version check (both fail), the check after the check pass (the Node test fails: "damaged").
bench/snapz's copy of the old LZ stays (compat.mjs and run.ts run as before; README).

**Part 2, where the memory went.** `bench/snapz/memwatch.ts` sampled each of the browser's processes every 50 ms
beside the probe. On 7b7b4342 every save's extra was the **renderer's** (the page and all its workers), and it grew
with the bytes written, falling back at a GC: a desktop suspend climbed steadily by ~540 MiB through its 1.1 s pause, a
kept snapshot in a sawtooth of ~300-400 MiB (its GCs fell inside the pause: +120 at the peak), the file +1,120 MiB
in the renderer and +685 in the browser process (the download's blob storage). The garbage: each RAM frame a pool
worker made was a new ~1 MiB ArrayBuffer, transferred to the machine worker and dropped after the sink wrote it (a
file's worth, 660 MB, waiting for a GC), and on the download path each chunk again (copied for the page, kept by it
as a Blob, its buffer dropped). **Built:** the frames' buffers are recycled (`RamPool.recycle`: after the sink wrote a
frame its buffer goes back to its worker with that worker's next job; a sink's bytes are its only until it returns),
and the page gives each download chunk's buffer back once it has copied it into a Blob (`snapshot-spare`). A pool
now makes a few buffers a worker (tests: a pool of 1 or 2 made at most 5 a worker for 24 frames; planted, no
recycling and a buffer given back before the sink wrote it, both caught).

Base = 7b7b4342 (core `0ffff6be`, ABI 68), new = this loop (core `a8deea54`, ABI 69), wblob = new with the download's
Blob made in the machine worker instead (an arm only; the JSON's commits 6535bb0d and be434c73 are local commits of
this tree and of that arm, squashed into this loop's); each round a browser of its own, the desktop in a Latin
square, Debian base new new base base new. Median (range) of 3; memory = the peak over the sample before the save,
MiB, the whole browser (memwatch's 50 ms) and its renderer:

| desktop | pause base | new | wblob | memory base | new | wblob | renderer base | new |
|---|---|---|---|---|---|---|---|---|
| kept | 1,341 (1,337-1,435) | 1,184 (1,173-1,184) | 1,188 | +125 (124-155) | +89 (71-90) | +90 | +122 | +85 |
| file | 1,587 (1,584-1,619) | 1,359 (1,354-1,397) | 1,796 (1,697-1,844) | +1,560 (1,472-1,570) | +1,238 (1,223-1,257) | +1,012 | +1,120 | +615 |
| suspend | 1,162 (1,104-1,175) | 1,169 (1,162-1,175) | 1,227 | +535 (533-538) | +206 (205-210) | +169 | +535 | +205 |

| Debian | pause base | new | memory base | new |
|---|---|---|---|---|
| kept | 174 (172-198) | 164 (163-168) | +150 (139-156) | +66 (63-70) |
| file | 186 (172-187) | 167 (166-172) | +331 (329-343) | +207 (206-208) |
| suspend | 151 (148-172) | 145 (144-145) | +139 (130-397) | +54 (53-308) |

The desktop's suspend added 535 → 206 MiB, its kept snapshot 125 → 89, its file 1,560 → 1,238; Debian's saves
84-124 MiB less. The pauses got shorter too, without overlap but for the suspend's (the same): the desktop's kept
−12%, file −14% (fewer GCs in the pause; the probe's own 250 ms RSS agrees: kept −2 against +129, suspend +180
against +494). Loads and resumes don't change (desktop load 9.3 s against 9.6, resume 8.5 / 8.5; Debian 2.2 / 2.0,
1.8 / 2.0: noise, nothing on that path changed). **What is left**, by the timelines: a suspend's +205 is the pool's six
instances (~90-140, decision 8) and the desktop's 3D state read back (109 MB of BLOB contents held through the save);
a kept snapshot's the same, part of it hidden by a GC early in the save. The file's +1,238 is the browser's blob
storage holding the file (~685) and ~600 more in the renderer that falls back as the save ends: the page's Blobs'
bytes, held until the browser has taken them. Making the Blobs in the machine worker held only ~336 MiB there but
paused the save 0.44 s longer (1.80 against 1.36 s): not taken; loop 4's staging through OPFS is to replace the
download's memory (docs/backlog.md SNAPZ).

## SNAPZ loop 3: the load's pool (2026-11-15)

The M4 dev VM (Lima, 8 vCPUs: a pool of 6), Chromium 155.0.8059.84 headless, the persistent profile
`target/snapz/profile`, nothing else running. Raw: `results/snapz-3/` (`rounds/<guest>-<arm>-<n>.{json,log}` and
`.mem.jsonl.gz`, the probe's and memwatch's per round; `summary.py` → `summary.txt`, `summary.json`; `run-ab.sh`, the
driver; `ab-*.txt`, its logs; `readbench.ts` and `readbench.txt`, the read measurement below). **Built:** the load's
pool (docs/platform.md "A load's pool"): the save's workers (`startPool`) take the check pass's CRCs and the restore
pass's RAM frames (CRC, unpack, pages straight into guest RAM and the spill memories), for a picked file, a kept
snapshot's start and a resume; a Blob is read in 4 MiB slices, four ahead, and each piece goes whole to a worker. The
probe now also starts the machine from its kept snapshot (`keptStart`). No core or ABI change (core `a8deea54` in both
arms).

**Measured first** (this tree's probe on 85e2681e, one desktop round): a load 8.56 s = prepare 1.77, check 0.79 (read
0.52, CRC 0.27), state 0.07, ram 1.77 (read 0.18, CRC 0.32, unpack 1.02, apply 0.32), disk 2.15, start 2.01. A first
pool (frames copied into shared slots for the workers) took ram to ~0.95 s and left the check pass at ~0.74: both
passes were then bound by reading. **The file's reads** (`readbench.ts`, the desktop's 689 MB File, three runs): its
stream 593-1,057 ms in 64-69 KiB chunks; one slice at a time 1 MiB 976-1,054, 16 MiB 624-637; **4 MiB slices four in
flight 213-228 ms** (3.2 GB/s), 16 MiB four in flight 180-229; 1 MiB slices read by 6 workers 278-283. With slices
the check pass was ~0.45 s, of which ~0.22 s the machine worker's copies into the shared slots (V8 copies into
shared memory word by word): pieces handed whole to the workers (transferred) took that away, the check pass to
~0.28-0.36 s.

**The A/B:** base = 85e2681e (loop 2b), new = this loop (the JSON's commit fb3daf5d is a local commit of this tree,
squashed into this loop's); each round a browser of its own, base new new base base new for each guest. Median
(range) of 3, ms; "share" = check + state + ram, the load's compression share:

| desktop (689 MB file) | base | new | |
|---|---|---|---|
| load: wall | 9,518 (9,437-9,647) | 7,620 (7,603-8,129) | −20% |
| ... share | 3,126 (3,019-3,160) | 1,133 (1,079-1,144) | 2.8x |
| ... check (read / CRC) | 786 (509 / 271) | 434 (341 / 395 summed) | |
| ... state | 75 | 82 | |
| ... ram (CRC / unpack / apply, summed) | 2,268 (337 / 1,325 / 419) | 619 (454 / 794 / 741) | 3.7x |
| ... prepare / disk / start | 1,896 / 2,155 / 2,269 | 1,954 / 2,155 / 2,216 | same |
| kept snapshot's start: wall | 10,694 (10,408-11,040) | 8,376 (8,302-8,939) | −22% |
| ... share | 3,214 (3,077-3,319) | 1,124 (1,116-1,230) | |
| resume: wall | 8,232 (8,068-8,341) | 6,546 (6,489-6,790) | −20% |
| ... share | 2,932 (2,887-3,026) | 1,122 (1,057-1,187) | |
| saves' pauses: kept / file / suspend | 1,220 / 1,666 / 1,309 | 1,281 / 1,671 / 1,271 | ranges overlap |

| Debian (97 MB file) | base | new | |
|---|---|---|---|
| load: wall | 2,069 (1,981-2,273) | 1,977 (1,965-2,067) | −4%, ranges overlap |
| ... share | 354 (348-395) | 134 (130-135) | 2.6x |
| kept snapshot's start: wall | 2,309 (2,123-2,396) | 2,074 (1,887-2,100) | −10% |
| resume: wall | 2,026 (1,966-2,186) | 1,837 (1,827-1,896) | −9% |
| saves' pauses: kept / file / suspend | 166 / 183 / 153 | 165 / 179 / 152 | same |

No load's range overlaps but Debian's picked file's (its `start` was 70 ms longer in the new arm's rounds, 756 against
829, the pool's six workers starting beside the machine's). **Against the projection** ("SNAPZ: compression…": the
share from ~3.3 s to ~0.8 s): 3.13 to 1.13 s. What is left of it: the check pass ~0.4 s, read-bound (the file is read
once a pass at ~3.2 GB/s at best); the state 0.08 s (the BLOB frames, on the machine worker); RAM ~0.6 s wall for ~2 s
of the workers' CPU, `apply` up to 0.75 of it (pages copied from the instance into guest RAM, shared memory both, and
fresh RAM's first touches). Not taken further here (docs/backlog.md SNAPZ). The rest of a load: the disk's blocks
(2.2 s, loop 5) and the machine's start (prepare ~2 s, start ~2.2 s, loop 7).

**Memory** (the whole browser, memwatch's 50 ms samples; before = the last sample before the operation, peak = during
it): the desktop's load 1,546 → peak 3,427 MiB (base) against 1,555 → 3,255 (new), its kept start 3,316 → 5,309 against
3,323 → 5,066: the new arm's peak 170-240 MiB lower (the one-thread reader's per-frame copies and 64 KiB chunks no
longer pile up; the pool's six instances, ~90-140 MiB, are within it). Debian's load 1,439 → 1,778 against 1,447 →
1,836 (+58 MiB at the peak: the pool), its kept start 1,733 → 2,139 against 1,737 → 1,847. The pool's own buffers: at
most 12 pieces with the workers and 4 being read (64 MiB), each piece freed by its worker once done; the pool ends
with the load.

**Correctness:** `tests/snapshot.test.ts` "a load's pool": RAM in two views (the spill memory's at an offset of its
buffer) restored by `readSnapshot` through pools of 1, 2, 3 and 6 and on one thread, byte-identical; RAM not on shared
memory placed on the machine worker; a worker failing every third piece, one reporting each piece's first frame failed,
a pool closed halfway: the same RAM; pieces of 4,099 B, 64 KiB + 7, 1 MiB + 17, 3 MiB and the default (frames and their
headers across pieces), with a DISK frame after RAM's (`placed()` has every RAM frame in when it comes); a byte flipped
in a RAM frame refused as "a checksum fails" by the check pass with and without a pool, the fresh RAM all zeros, and
by the pooled restore pass on its own; for every piece size, a damaged frame refused. `tests/page-snapshot.test.ts`:
a byte flipped in a RAM frame of a real snapshot refused on the page as not loaded, the disk untouched. Planted, each
caught: the check pass returning before its CRCs are in (writes before the check finishes: the Node test, and the page
test, whose refusal becomes "not restored"), a frame placed at the wrong address (the view's offset ignored), a
worker's frame dropped, the frames a worker failed not redone, a failed worker's piece not redone, a frame across
pieces not checked, one not placed, `placed()` without the piece in hand.

## SNAPZ loop 4: the review's findings; a file save staged through OPFS (2026-11-16)

The M4 dev VM (Lima, 8 vCPUs: a pool of 6), Chromium 155.0.8059.84 headless, the persistent profile
`target/snapz/profile`, nothing else running. Raw: `results/snapz-4/` (`rounds/<guest>-<arm>-<n>.{json,log}` and
`.mem.jsonl.gz`, the probe's and memwatch's per round; `summary.py` → `summary.txt`, `summary.json`; `run-ab.sh`, the
driver; `ab-*.txt`, its logs; `copybench.ts` and `copybench.txt`, the copy's measurement below; `nested-error.ts`
and `.txt`, R1's check).

**Part 1, the review of loop 3** (`review/snapz-3`, a static review of 5104f64b; each real finding's test written
first and seen failing): R1 (a pool worker's uncaught error not cancelled, so it went on to the machine worker's
parent and the page took it for the machine's crash) real, confirmed in Chromium 155 (`nested-error.ts`: the page's
`Worker.onerror` fires unless the parent cancels it); fixed (`preventDefault`, and `messageerror` handled).
R3 (a lost reply hung the save, paused) real: a pool with work out and no reply for 10 s (`STALL_MS`) fails. R4 (one
worker's failure left the others running their given-up jobs) real: a failure ends every worker at once; a writer
whose sink failed no longer makes chunks itself. R5 (workers spawned before a failed spawn leaked) real:
`Promise.allSettled`, the made ones ended. R6 (a refusal could name a later frame) real: a job's refusal is thrown
before the later jobs are looked at. R10 (the writer gave RAM to the pool on the codec's id alone) real: a codec says
`pooled` (only `lzCodec`); the reader is gated the same way. Their tests: `tests/snapshot-pool.test.ts` (fake workers
through `startPool`'s `spawn`, and real ones). R2 (the load's pool leaked when a resume's `bootVm` failed before
`fill`) and R7 (`fill` closed whatever pool was current) real by the code: the pool is now its restore's (a local of
`openRestore`, with `release`), and `start` releases it once `bootVm` settles, whatever the outcome; no test reaches
that path (it needs `bootVm` to fail before `fill`). R8 not a defect: the page test tells the passes apart by the
headline (the check pass's refusal is "Couldn't load the snapshot", the restore pass's "Couldn't restore"); planted,
the check pass ignoring its workers' failures fails it, and every load on that page is checked to go through the
pool. R9 (docs) fixed.

**Part 2, built:** a file save (a picked file, a download) goes to a staging file in OPFS during the pause
(`web/snapshot-stage.ts`; docs/frontend.md "Snapshots"), the machine resumes (`snapshot-resumed`: input, USB and the
clock back), then the picked file gets the staging file copied in and it's removed, and a download is the staging
file itself (removed with its address, 60 s on). The fallbacks write directly: no room (the estimate against
`snapshotBound` plus a tenth and 64 MiB), a staging write refused partway (written again directly, still paused), no
OPFS. "A picked file" on this page is `showSaveFilePicker`'s writable in Chromium and a download elsewhere (and where
the picker throws); both were bound by their path (the writable at ~140-150 MB/s here, the download's Blob parts in
the page), so both stage. **The copy** first read the staging file in 4 MiB pieces into the worker (arm "new"): 3.9 s
for the desktop's 680 MB beside the running guest, +594 MiB of the renderer's garbage. Writing it as 64 MiB Blob
slices instead (the browser copies file to file) took 0.69-0.89 s against 1.27-1.40 s on an idle browser
(`copybench.txt`) and is what was taken ("new2").

**The A/B:** base = e62727ec (loop 3), new = this loop with the copy read in pieces (9d8b90ae, a local commit), each
round a browser of its own, base new new base base new per guest; then new2 = this loop (the Blob copy) three rounds
a guest in the same session after them (not alternated: the pause's code is new's; its kept pauses ran ~10% higher
than new's, the session's drift). The probe's new `picked` save stands an OPFS file in for the pick (a writable as
a real pick's). Median (range) of 3, ms; memory = the whole browser's peak over the sample before the save, MiB
(memwatch's 50 ms):

| desktop (689 MB file) | base | new | new2 |
|---|---|---|---|
| kept: paused | 1,261 (1,193-1,341) | 1,294 (1,175-1,325) | 1,438 (1,353-1,467) |
| download: paused | 1,811 (1,747-1,893) | 1,366 (1,363-1,426) | 1,450 (1,444-1,458) |
| ... memory added (browser process / renderer) | +1,144 (684 / 530) | +229 (7 / 218) | +239 (7 / 227) |
| picked: paused | 4,679 (4,571-4,817) | 1,399 (1,316-1,410) | 1,368 (1,363-1,373) |
| ... the copy after the resume | | 3,884 (3,866-4,031) | 1,379 (1,330-1,379) |
| ... wall (click to done) | 4,903 (4,818-5,049) | 5,756 (5,723-5,861) | 3,130 (3,072-3,237) |
| ... memory added | +282 | +594 | +313 |
| suspend: paused | 1,288 (1,251-1,487) | 1,215 (1,214-1,269) | 1,265 (1,241-1,297) |

| Debian (97 MB file) | base | new | new2 |
|---|---|---|---|
| kept: paused | 164 (163-174) | 162 (157-163) | 163 (162-179) |
| download: paused | 181 (169-182) | 163 (158-167) | 166 (165-167) |
| ... memory added | +209 | +95 | +82 |
| picked: paused | 491 (478-505) | 160 (155-170) | 160 (156-166) |
| ... the copy after the resume | | 210 (194-214) | 114 (106-114) |
| suspend: paused | 145 (145-157) | 146 (146-149) | 148 (144-150) |

**Against the goal** (the picked file's pause equal to a kept snapshot's within the noise): the desktop's picked
pause 4.68 → 1.37-1.40 s, a kept one's 1.29 (new) and 1.44 (new2) in the same sessions, the ranges overlapping in
each; the download's 1.81 → 1.37-1.45 s. Within a round the file saves' pauses run 70-100 ms over the kept one's in
`disk` (the disks' blocks read: 250-310 ms against 160-200; the base's file saves the same against its kept), not in
the sink (264-316 ms against 330-418): the overlay is the kept snapshot's restore's by then, later in the round.
Debian's picked pause 0.49 → 0.16 s, the kept one's. **Memory:** the download's +1,144 MiB is +229-239 (the pool's
instances and the 3D read-back, as a kept snapshot's +187-200); the browser process's 684 MiB of blob storage is
gone, and nothing of the file is in the page. The picked file's +282 → +313 MiB (the Blob copy; +594 when read in).
Loads, resumes and kept starts don't change (nothing on their path did; desktop load 8.2 / 7.4 s, Debian 1.67 /
1.72).

**Correctness:** `tests/page-snapshot-stage.test.ts` (Buildroot, an on-disk profile): a download and a picked file
staged (the picked file's bytes the file's, its staging file gone, the download's kept for its address), a staging
write refused partway (the origin's quota at half a file over its usage, `Storage.overrideQuotaForOrigin`: a whole
file written directly, `staging: refused`), a copy that fails after the resume (the quota at 1.5 files: the message
and its cause, the picked file empty, no staging file left, the machine running), a staging file no page holds and
the download's (its page gone) removed at the next start, and no room (`?stageroom=0`: written directly,
`staging: room`). Planted, each caught: the stale files kept (no `removeStale` at the start), a failed copy's staging
file kept (neither the worker nor the page's release removing it), the room never checked, and a refusal partway not
written again. `tests/snapshot-file.test.ts`: `snapshotBound` over the worst case (incompressible RAM, blobs,
scattered blocks) is never under the file and is told before its first byte.

## SNAPZ loop 5: the disk's blocks in runs (2026-11-16)

The M4 dev VM (Lima, 8 vCPUs), Chromium 155.0.8059.84 headless, nothing else running. Raw: `results/snapz-5/`
(`rounds/<guest>-<profile>-<arm>-<n>.{json,log}` and the persistent rounds' `.mem.jsonl.gz`; `summary.py` →
`summary.txt`, `summary.json`; `run-ab.sh`, the driver; `ab-*.txt`, its logs; `harness/`, the breakdown below).

**Where the time went** (`harness/`: the restore's disk phase alone in a worker, over OPFS, every sync-handle call
timed; `extract.ts` keeps a snapshot's DISK frames in a file of their own; `h.ts <arms> <file>`, `PROFILE=<dir>` for
a persistent profile; `summary.txt`, 3 rounds each). The desktop's 11,952 blocks are 211 DISK frames, 177 runs of
consecutive blocks, 2,234 zero blocks; as runs of one kind (data or zeros) within a frame, 1,117 overlay calls
(`runs.txt`; Debian's 2,103 blocks: 300). One overlay write a block, as the restore did (arm `block`), ms:

| desktop | persistent | off the record |
|---|---|---|
| the disk phase (block) | 1,913 (1,727-2,111) | 7,104 (7,082-7,145) |
| ... `data` flushes (9,719) | 1,664 | 5 |
| ... `data` writes (9,718) / map writes (11,953) | 57 / 113 | 3,025 / 3,606 |
| ... `getSize` (a zeroing's `shrink`) | 2 | 382 |
| ... frames read and unpacked / `isZero` | 37 / 8 | 35 / 11 |
| a run a call (`run`: 1,117 calls) | 198 (174-200) | 739 (732-744) |
| a run a call, unordered (`runu`: no flush between a run's data and its map) | 62 (62-73) | 742 (738-747) |
| the save's reads: a block a read / in runs of consecutive slots | 26-30 / 8-12 | 2,134-2,153 / 166-170 |

On disk each first write's `data` flush (`ORDERED`) was the cost: ~0.17 ms each, 87% of the phase. Off the record a
flush is free and every call ~0.3 ms. **Built** (`runu` and the reads in runs): the restore writes each DISK frame's
runs of data blocks and of zero blocks with one call each (`diskRuns`, web/snapshot-file.ts), the overlay's map
updated once a run (a leaf at a time: the write path as it was), and opens its overlay unordered, flushing both files
at its end (docs/devices.md "Crash and refusal": until then the overlay is part of a snapshot over an emptied one
whatever its order); a frame past the disk's end is refused before any of it is written. A save reads a batch of
blocks with the overlay's `blocks(list)` (those in consecutive slots one read; a ramdisk's as before). Not built: a
restore-only bulk write (a frame's data, then each leaf's entries once), which would take the off-the-record map
writes from ~1,100 to one per leaf touched (~0.3 s off the record, ~5 ms on disk: docs/backlog.md SNAPZ).

**The A/B on the page** (`bench/snapz/probe.ts`, which now has `WAARM64_PROFILE=off` and `OPS`: docs/benchmarking.md
"The snapshot probe"): base = a34c9c85 (loop 4 and the SURFACE merge), new = this loop; both run this loop's probe;
each round a browser of its own, base new new base base new per guest and profile. Persistent: the profile
`target/snapz/profile`, every operation, `SETTLE_S=20`, memwatch beside it. Off the record: a fresh context per
round, the load, a kept snapshot, the start from it and a download. Median (range) of 3, ms; `disk` the phase:

| desktop (689 MB file) | persistent base | persistent new | off base | off new |
|---|---|---|---|---|
| load: total | 7,332 (6,962-7,720) | 5,310 (5,107-5,873) | 12,345 (12,308-12,399) | 5,846 (5,766-5,936) |
| ... disk | 1,972 (1,917-2,056) | 100 (99-116) | 7,252 (7,225-7,295) | 764 (763-797) |
| kept snapshot's start: total | 7,647 (7,199-7,840) | 5,224 (5,181-5,661) | 12,811 (12,476-12,854) | 6,101 (5,964-6,518) |
| ... disk | 2,033 (2,000-2,115) | 111 (109-121) | 7,287 (7,266-7,360) | 774 (761-819) |
| kept: paused (disk) | 1,164 (150) | 1,116 (109) | 5,036 (2,440) | 2,721 (325) |
| download: paused (disk) | 1,312 (200) | 1,263 (178) | 5,260 (2,760) | 2,698 (360) |
| picked: paused (disk) | 1,269 (241) | 1,207 (176) | | |
| suspend: paused / resume: total | 1,296 / 5,745 | 1,282 / 5,610 | | |

| Debian (97 MB file) | persistent base | persistent new | off base | off new |
|---|---|---|---|---|
| load: total (disk) | 1,814 (456) | 1,359 (34) | 2,578 (1,336) | 1,405 (220) |
| kept snapshot's start: total (disk) | 1,695 (413) | 1,322 (33) | 2,464 (1,338) | 1,397 (218) |
| kept: paused (disk) | 163 (25) | 157 (23) | 874 (542) | 450 (116) |
| download: paused (disk) | 165 (29) | 157 (18) | 877 (536) | 447 (107) |

(The pauses' ranges are in `summary.txt`; a pause's `disk` medians, ranges there too: desktop kept 138-151 against
103-138.) **Against the goal:** the desktop's restore of its blocks 1.97-2.03 s → 0.10-0.11 s with a persistent
profile (the load 7.3 → 5.3 s, a kept snapshot's start 7.6 → 5.2 s), 7.3 s → 0.77 s off the record (the load 12.3 →
5.8 s). The save's disk blocks: 150-200 → 109-178 ms with a persistent profile (their reads were ~30 ms of it; the
rest is the frames' copies, compression and the device worker's messages), 2.4-2.8 s → 0.33-0.36 s off the record (a
desktop save's pause 5.0-5.3 → 2.7 s there; 2.2 s of what's left is the sink, the file's OPFS writes). Debian: its
load's disk 456 → 34 ms, off the record 1,336 → 220. Nothing else moved past its ranges (the RAM, check and start
phases, suspends and resumes).

**Memory** (memwatch, the whole browser's peak over the sample before the save, MiB): less, not more: desktop kept
+184 (171-197) → +141 (122-148), download +217 → +163, picked +317 → +253, suspend +214 → +211 (no blocks); Debian
kept +69 → +60. The save no longer makes a 4 KiB array per block in the device worker; a batch is one array, as
before.

**Correctness:** `tests/snapshot.test.ts` "a restore writes a disk's blocks in runs" (a made file: data and zero runs,
one across the 1,024-block leaf boundary, a frame of 256, lone blocks, the disk's last block of 1,000 bytes, over an
overlay that had other blocks; read back by a new opening: the blocks it holds, each one's bytes and whether it's a
zero without a slot, the data file a slot per data block, the whole disk; a frame past the disk's end refused as
corrupt), `tests/snapshot-file.test.ts` (`diskRuns`: runs split where data turns to zeros and back, a block whose
last byte isn't zero is data, views of the frame, bad sizes refused) and `tests/overlay.test.ts` "blocks() reads a
list of held blocks" (slots out of the blocks' order, across leaves, zeroed blocks, a list in any order: the bytes
`block()` reads, one read per run of consecutive slots; a block not held and a failed read give undefined). Planted,
each caught: a run's map entries not written to the file (`setRun` without its `putMap`), runs not split where data
turns to zeros (both the restore's test and the file's), `blocks()` reading across a slot gap, and no past-the-end
check (the write refused, said as the storage full instead of a damaged file).

## SNAPZ loop 7: the load's machine start (2026-11-16)

The M4 dev VM (Lima, 8 vCPUs), Chromium 155.0.8059.84 headless, the persistent profile `target/snapz/profile`,
nothing else running. Raw: `results/snapz-7/` (`breakdown/`, the instrumented loads below; `variants/`, which
workers to start ahead; `rounds/<guest>-<arm>-<n>.{json,log,mem.jsonl.gz}`, the A/B's probe and memwatch per round,
`s1-…` its first session; `summary.py` → `summary.txt`, `summary.json`; `run-ab.sh`, the driver; `ab-*.txt`, its logs;
`marks.py`, the timing marks: `python3 marks.py` puts them in the tree, `UNDO=1` takes them out).

**Where the time went.** `marks.py` timestamps the machine worker's start (`performance.timeOrigin + now()`, so the
workers' clocks agree), its device worker (module loaded, `init` received, `Devices.open` done, each backend's
`restore`), the vCPU workers (module loaded, job, instantiated, running), the GPU worker (the 3D state's `load`, its
first present) and the page (`Runner.start`, the start message posted); `data-load` carries the machine worker's
marks. One load each on ec293884 (`breakdown/i1-*.json`), ms from the machine worker's start:

| | desktop | Debian |
|---|---|---|
| `prepare`: the core fetched (cached) / compiled (V8 compiles lazily) | 19 / 7 | 65 / 8 |
| ... **the disks' HEAD** (web/app/worker-fetch.ts `checkDisks`, beside the fetch, awaited after it) | **1,851** | **382** |
| check pass and state (with the pool's start, 14-17) | 963 | 83 |
| `bootVm` to `fill` (instantiate, the memories grown, the disks' specs) / `fill` (RAM, the disks' blocks) | 34 / 794 | 19 / 116 |
| the device worker: its module loaded / `init` in (the state's structured copy) | 105 / 34 | 47 / 0 |
| ... **`Devices.open`** (the URL disks' sync HEADs, web/devices.ts `httpSource`; the backends' `restore` 5) | **2,416** | **604** |
| quiesce, the screen, `running` | 9 | 6 |
| total | 6,245 | 1,342 |

**4.3 s of the desktop's 5.5 s load were the dev server's HEADs.** sirv (vite.config.ts serves `target/` with it)
answers a HEAD as a GET: it pipes the whole file into a response Node then drops, ~1.2 GB/s from the page cache, so
the desktop's 2.26 GB qcow2 took ~1.9 s per HEAD (Debian's 403 MB ~0.35 s), and a load makes two: the machine worker's
check that the disk is there and the device worker's size. This is the dev server's (the tests, the probe, `npm run
serve`), not the page's: `npm start` and the deployed page serve no disk images, and stored disks make no request.
Every load the SNAPZ probe measured since loop 0 had it in `prepare` and `start` ("the machine's start ~4.3 s"). What
the rest was (after the HEAD's fix, `breakdown/i2-*.json`; desktop / Debian): `prepare` 20 / 22; the device worker's
module 76 / 57 ms and `init` 19 / 1; `Devices.open` 20 / 26 (the overlays' OPFS handles); the other parts as above.
After `running`, outside `total`: the vCPU workers run ~120 ms later (spawned at the first run: their modules ~100-115
ms, the clock's queries 3, instantiating 1; platform.md "Snapshots"), and on the desktop the GPU worker's 3D state
`load` takes 51-108 ms, its first present 4 ms after it. Before the worker's start, on the page: the GPU worker's
WebGL start, 53-100 ms, comes before the start message (the caps are in it), and the file's handling ~45-75 ms.
The core: compiled once a load (4-7 ms: V8 compiles lazily, so its cost is in the first calls), the copy with exact
memory limits compiled while the first instance lays the memory out (awaited 0 ms); no code cache applies
(`WebAssembly.compile` of bytes, and the exact copy's bytes are rewritten), and how the core's code tiers up is the
JIT's compile policy (not touched).

**Built:** (1) **the dev server answers a HEAD under `target/` from the file's `stat`** (vite.config.ts `headOnly`:
sirv's headers for the file in dev mode, Content-Length, Last-Modified, the server's; anything else goes on to sirv).
(2) **The device worker is started beside the check pass** (web/vm.ts `warmWorkers`, `BootOptions.warm`: the machine
worker starts it once the load's pool is up, at once for a boot; `bootVm` takes it, ends what it doesn't take), and
**a restore's state moves to it** (the 3D contents transferred, not copied: with the worker started early the copy was
what was left of its start, 79 ms). Starting the vCPU workers (and the compile worker) ahead too was measured and lost
(`variants/`, desktop loads, 3 each): all started ahead 1,045-1,329 ms (the check pass 409-525), the device worker
only 973-1,024 (check 332-343), all after the check pass 1,080-1,152 (RAM's phase 498-559 against 390-425): six
workers' modules loading beside the pool's six cost the check pass (or RAM) 80-100 ms, more than the device worker's
start saves; the vCPU workers still start at the first run. (The first session's arm `s1-allwarm` is that variant.)

**The A/B:** base = ec293884 (loop 5), head = + the HEAD fix, new = + the device worker ahead and the state moved
(this loop); each round a browser of its own, base head new new head base base new head per guest, every operation,
`SETTLE_S=20`, memwatch beside it. Median (range) of 3, ms; memory = the whole browser at the operation's peak, MiB:

| desktop (689 MB file) | base | head | new |
|---|---|---|---|
| load: total | 5,575 (5,358-5,951) | 1,563 (1,540-1,620) | 1,436 (1,416-1,437) |
| ... wall (the probe's: the file chosen to `running`) | 5,721 (5,505-6,105) | 1,762 (1,675-1,762) | 1,577 (1,571-1,578) |
| ... prepare / check / ram / start | 1,993 / 413 / 623 / 2,472 | 28 / 506 / 624 / 229 | 27 / 495 / 617 / 89 |
| ... memory peak | 3,389 | 3,414 | 3,202 |
| kept snapshot's start: total | 6,117 (5,888-6,166) | 1,516 (1,435-1,558) | 1,371 (1,344-1,523) |
| ... start / memory peak | 2,678 / 5,106 | 284 / 5,128 | 110 / 4,821 |
| resume: total | 5,594 (5,566-5,879) | 1,378 (1,356-1,379) | 1,192 (1,191-1,197) |
| ... start | 2,267 | 287 | 125 |
| saves' pauses: kept / file / picked / suspend | 1,173 / 1,273 / 1,222 / 1,240 | 1,126 / 1,275 / 1,216 / 1,210 | 1,111 / 1,257 / 1,183 / 1,279 |

| Debian (97 MB file) | base | head | new |
|---|---|---|---|
| load: total | 1,437 (1,376-1,501) | 316 (303-317) | 288 (279-295) |
| ... wall | 1,577 (1,567-1,668) | 457 (456-460) | 456 (455-456) |
| ... prepare / check / start | 485 / 55 / 777 | 25 / 54 / 128 | 22 / 70 / 84 |
| kept snapshot's start: total | 1,291 (1,284-1,352) | 301 (295-312) | 288 (271-293) |
| resume: total | 1,283 (1,201-1,315) | 314 (309-329) | 288 (276-298) |
| saves' pauses: kept / file / picked / suspend | 159 / 158 / 156 / 151 | 154 / 161 / 156 / 152 | 162 / 156 / 156 / 156 |

**Against the goal:** the desktop's load 5.6 → 1.4 s (its `prepare` + `start` 4.5 s → 0.12 s), a kept snapshot's
start 6.1 → 1.4, the resume 5.6 → 1.2; Debian's load 1.44 → 0.29 s. The HEAD fix is nearly all of it; the device worker
ahead is 130-190 ms more on the desktop (`start` 229-287 → 89-125: load and resume past the ranges, the kept start's
overlapping), 13-28 on Debian (load past the ranges), net of what the device worker's start costs the check pass
beside it (Debian's 54 → 70 ms; the desktop's within its noise). The saves don't move. What a load is now
(desktop): the check pass ~0.4-0.5 s (read-bound), the state 0.09, RAM ~0.6, the disk 0.1, the rest 0.12; the probe's
wall is ~0.14-0.2 s more (the page's side, the GPU worker's start). **Memory:** less: the desktop's load peaks ~190-210
MiB lower (3,202 against 3,389-3,414), a kept start's ~285-305 lower, and the browser holds ~170-310 MiB less before
each later save of the round (the state's 109 MB copy and its source no longer both kept); Debian's within its ranges.

**Correctness:** `tests/serve.test.ts` "a HEAD under target/ is answered from the file's stat" (the headers a GET has;
a file that can't be read still answers 200 with its size; a missing one 404); `tests/warm-workers.test.ts` (fake
browser workers: each kind made ahead and taken in turn, then new ones; a worker that failed to load replaced and its
error kept from the page; `end` ends only those not taken; none outside a browser worker; and a real `bootVm` in
Node: the warm workers ended once the vCPU workers start, not before, when `bootVm` fails, and at the boot of a machine
that isn't parallel). The page's own snapshot, 3D and machines tests run the new start (`scripts/ci-debian.sh`,
`ci-machines.sh`). Planted, each caught: the HEAD handler left out (the unreadable file's HEAD never answers), `end`
not terminating, a failed worker handed out, the coordinator not ending them, `bootVm`'s failure not ending them, a
machine without vCPU workers not ending them.
`scripts/ci.sh` (815 s), `ci-debian.sh` (344 s), `ci-machines.sh` (343 s) and `ci-graphics.sh` (266 s, the 3D state
handed over differently) green over loop 5 and this loop, once each, alone.

## SNAPZ loop 6: qcow2's clusters through miniz_oxide (2026-11-16)

The M4 dev VM (Lima, 8 vCPUs), Chromium 155.0.8059.84 headless, nothing else running. Raw: `results/snapz-6/`
(`rounds/page-<arm>-<n>.{json,log,rss}`, `rounds/io-<arm>-<n>.{json,log,rss}`; `run-ab.sh`, the driver; `ab.txt`, its
log; `summary.py` → `summary.txt`, `summary.json`). **Built:** two core exports, `inflate_raw` and `deflate_raw`
(miniz_oxide 0.9.1, now a normal dependency; ABI 70, docs/abi.md "SNAPZ: qcow2's clusters through miniz_oxide"), and
`web/deflate.ts`: a codec-only core instance per thread (`codecCore`), synchronous. qcow2's reader inflates through
it (on the reading thread and in each inflate-pool worker, which gets the thread's core first; the device worker's
codec runs on the machine's core, `DevicesInit.core`; other threads fetch `CORE`), and a compressed export's
clusters are deflated through it at level 6 (in place, and in each deflate-pool worker). `DecompressionStream` and
`CompressionStream` are gone from qcow2's paths, and with them the byte-by-byte retry Firefox's stream needed.

**The arms:** base = 8facaffa (the streams; its web files and core, ABI 69), new = this loop, nopool = this loop
with `inflatePool`'s default size 0 (every cluster on the reading thread); each arm's files and wasm swapped into the
checkout before its run. Rounds base new nopool, nopool new base, new base nopool. Per round and arm,
`bench/io/inflate-page.ts` (extended here: `reads`, `export-c`; a fresh persistent profile per run) and bench/io's
`io_reads` (fio in Buildroot over `target/bench/io-usr.qcow2`: 256 MiB of a tar of `/usr`, `qemu-img convert -c`,
64 KiB clusters, 99 MB; 5 boots a run, the run's median). Median (range) of 3:

| | base (streams) | new (miniz_oxide) | nopool |
|---|---|---|---|
| Debian's boot to its login (compressed qcow2 over HTTP), s | 25.65 (25.45-27.19) | 25.66 (25.59-25.95) | 25.76 (25.75-26.01) |
| import as a stored disk, s | 14.43 (13.94-14.58) | **13.86 (13.57-13.88)** | 15.19 (15.07-15.31) |
| export, qcow2, s | 7.60 (7.45-7.86) | **7.22 (7.21-7.41)** | 8.45 (8.25-8.48) |
| export, compressed qcow2, s | 8.64 (8.51-9.01) | **8.19 (8.09-8.24)** | 8.86 (8.48-9.05) |
| ... its size, MB | 448.3 | 444.6 | 444.6 |
| fio sequential 1 MiB, MiB/s | 225.1 (220.7-225.3) | **230.8 (230.5-231.4)** | 174.3 (173.2-174.9) |
| fio sequential 128 KiB, MiB/s | 88.8 (88.6-88.9) | **91.5 (91.3-91.6)** | 89.0 (88.5-89.1) |
| fio random 4 KiB, MiB/s | 4.51 (4.51-4.54) | **4.57 (4.56-4.58)** | 4.57 (4.57-4.57) |
| the reader alone (the page's thread), a 1 MiB read, one thread, ms | **2.77 (2.72-2.78)** | 2.95 (2.95-2.95) | 2.94 |
| ... with a pool of four, ms | 1.61 (1.59-1.62) | **1.51 (1.48-1.52)** | 1.49 |
| inflate a 64 KiB cluster, one after another, µs | **158 (158-163)** | 172 (171-172) | 171 |
| deflate a 4 KiB cluster (`qcow2-write.ts` `deflate`), µs | 82 (80-85) at 2.27x | **72 (72-72) at 2.35x** | 71 |
| the browser's RSS peak, a page run (the boot's), MiB | 2,881 (2,851-2,891) | **2,680 (2,673-2,699)** | 2,617 |
| ... a fio run, MiB | 1,680 (1,648-1,687) | **1,538 (1,519-1,544)** | 1,332 |

**Against the goal:** the kickoff's numbers (160 against ~400 µs a 64 KiB cluster, 66 against 307 a 4 KiB one) were
the measuring session's harness, which piped each cluster through `Blob.stream().pipeThrough(...)` and collected the
chunks: the page's own stream code (one writer, one reader, the output written in place) was much cheaper, 158 µs
and 82 µs. So on one thread the core's inflate is **9% slower** a cluster (172 µs) and its deflate 12% faster at a
3.5% better ratio. End to end the new arm is still ahead in every measure but the boot, each outside the other's
range: the import 4% faster, the export 5%, the compressed export 5% (and 0.8% smaller), fio's reads 1-3%, the
reader's pooled 1 MiB read 6%, the browser's peak 140-200 MiB lower (not broken down by process: the
streams' buffers on four workers are the likely difference). The one-thread 1 MiB read is 7% slower; it is what Node and a thread
without workers run, never the page's guests. **The boot doesn't move** (25.6-25.7 s in all three arms): its reads
are mostly one or two clusters, and inflating is a small part of it. **The inflate pool still pays:** without it fio's 1
MiB reads were 24% slower, the import 10% and the export 17%; it stays. **Memory:** a codec instance is a 2 MiB memory,
2.6 MiB after a deflate (its compressor's ~200 KiB tables from the heap, allocated and freed per call: miniz_oxide
boxes them, so `deflate_raw` isn't allocation-free; `inflate_raw` is): one per thread that reads a compressed qcow2
(the device worker and its four inflate workers: ~13 MiB), and during an export the disk-out worker's and its four
deflate workers' (~13 MiB more); the threads without the machine's core (the disk-in and disk-out workers) hold its
9.6 MB wire bytes too. The measured peaks are lower than base's all the same. The core's wasm grew 155 KB (9.49 →
9.64 MB).

**Correctness:** natively (`cargo test`, `core/src/codec.rs`, `core/src/lib.rs`): round trips at every level with
junk after the stream, the stream read by the native twin's inflater; `deflate_raw` refusing a `cap` it doesn't fit;
`inflate_raw` refusing every truncation, a stream past its bound, a reserved block type, a stored block's bad length
and a distance before the output's start, and 20,000 flipped-bit streams and 5,000 garbage inputs without a panic;
the exports over 3,000 random inputs, caps and levels (a result within the cap, or the failure value). Planted, each
caught: a corrupt stream taken (`inflate_raw` returning what it produced whatever its status: 3 tests fail), an
inflate past its bound taken (`HasMoreOutput` as done: 2 fail). In Node (`tests/deflate.test.ts`): Node's zlib with
QEMU's 4 KiB window (`windowBits: 12`) reads the core's 4 KiB clusters, the core reads zlib's 64 KiB ones and its own
with a sector's junk after; corrupt, truncated, short and overlong streams refused; planted: a short cluster taken
(caught). `tests/qcow2.test.ts`: a damaged compressed cluster fails its read, the clusters before it still read (the
Firefox stream test is gone with the retry). The exports stay valid qcow2 for QEMU: `tests/qcow2-write.test.ts`
(`qemu-img check` and `qemu-img compare` of compressed whole disks and changes files) and the page's
`tests/page-save.test.ts` and `tests/page-disks.test.ts` (an image imported and exported compressed, compared by
qemu-img) pass. A first version of the inflate pool started its workers twice when two requests came before the core
was compiled; it starts them once now.
`scripts/ci.sh` (788 s), `ci-debian.sh` (411 s) and `ci-machines.sh` (316 s) green on the finished tree, once each, alone.

## SNAPZ: the track's end (2026-11-16)

The M4 dev VM (Lima, 8 vCPUs: a pool of 6), Chromium 155.0.8059.84 headless, nothing else running. Raw:
`results/snapz-end/` (`rounds/<guest>-<arm>-<n>.{json,log,mem.jsonl.gz}`, the probe and memwatch per round;
`summary.py` → `summary.txt`, `summary.json`; `run-ab.sh`, the driver; `ab-*.txt`, its logs; `e1/`, the review's
first finding's cost).

**The arms:** base = loop 0's tree (baa1e0b3) and its core (`e4050123…`, ABI 67), **with loop 7's dev-server fix**
(vite.config.ts answers a HEAD under `target/` from the file's `stat`; sirv read the whole disk image for each, 4.3 s
of every desktop load, the dev server's and not the page's: a local commit, 0199f99e); new = the finished tree
(0e8f3e68, core `44210116…`, ABI 70). So the comparison is the track's code, the HEAD's cost taken out of both.
Each round a browser of its own with a persistent profile of the arm's (`target/snapz/profile-end-<arm>`, new for
this run: loop 0's page and the finished one's store differ), every operation of `bench/snapz/probe.ts` (the
finished one, which now reads headers itself so that it runs on loop 0's tree), `SETTLE_S=20`, memwatch beside it;
the order base new base new new base base new per guest, the first two rounds (each arm's first in its fresh
profile) left out: 3 rounds an arm. Median (range), ms; memory: the whole browser, MiB, the peak during the
operation over the sample before it (`memAdded`).

| desktop (689 MB file) | loop 0 (+ HEAD fix) | the end | |
|---|---|---|---|
| **load**: total | 5,762 (5,504-5,788) | 1,214 (1,129-1,240) | 4.7x |
| ... wall (the file chosen to `running`) | 5,902 (5,695-5,986) | 1,357 (1,262-1,357) | |
| ... check / state / RAM / disk / start | 729 / 102 / 2,610 / 2,055 / 158 | 404 / 78 / 482 / 101 / 95 | |
| ... memory added (peak) | +2,175 (3,712) | +1,740 (3,253) | −435 |
| **kept snapshot's start**: total | 6,010 (5,527-6,072) | 1,274 (1,267-1,356) | 4.7x |
| ... memory added (peak) | +2,115 (5,433) | +1,642 (4,879) | |
| **resume**: total | 4,060 (3,607-4,075) | 1,258 (1,240-1,278) | 3.2x |
| **kept**: paused | 4,815 (4,744-4,853) | 1,089 (1,079-1,115) | 4.4x |
| ... memory added | +64 (49-69) | +131 (126-131) | +67 |
| **download**: paused | 5,824 (5,110-5,859) | 1,248 (1,238-1,317) | 4.7x |
| ... memory added | +562 (536-594) | +169 (169-171) | −393 |
| **picked file**: paused | 8,887 (7,599-8,990) | 1,285 (1,281-1,370) | 6.9x |
| ... wall (with the copy after the resume, 1,348) | 9,019 | 3,087 | |
| ... memory added | +521 (485-525) | +251 (244-256) | −270 |
| **suspend**: paused | 5,443 (4,848-5,483) | 1,290 (1,231-1,290) | 4.2x |
| ... memory added | +185 (184-188) | +213 (203-214) | +28 |
| file's size, MB: kept / download / suspend | 690 / 693 / 677 | 676 / 679 / 663 | −2% |

| Debian (97 MB file) | loop 0 (+ HEAD fix) | the end | |
|---|---|---|---|
| **load**: total | 961 (930-1,061) | 268 (261-283) | 3.6x |
| ... check / RAM / disk / start | 92 / 336 / 420 / 82 | 72 / 59 / 37 / 71 | |
| **kept snapshot's start**: total | 997 (968-1,006) | 288 (283-314) | 3.5x |
| **resume**: total | 597 (597-616) | 273 (268-284) | 2.2x |
| **kept** / **download** / **picked** / **suspend**: paused | 597 / 636 / 949 / 585 | 158 / 162 / 156 / 151 | 3.8-6.1x |
| memory added: kept / download / picked / suspend | +77 / +177 / +141 / +69 | +86 / +98 / +100 / +64 | |

Small machines got faster too (the kickoff allowed them slower). Every range is apart. **Memory:** the kept save holds
~67 MiB more while it runs (the pool's six instances: kickoff decision 8 allowed 90-140), a suspend ~28 more; the
file saves hold less (the download ~390 MiB less, a picked file ~270: staged through OPFS, no Blob parts); a load
peaks ~435-460 MiB lower on the desktop. Against loop 0's own numbers (`results/snapz-0/`, the HEAD's cost in them):
the desktop's pause 4.2 s → 1.1 s, its load 9.5 s → 1.2 s; this session's base pauses ran ~0.6 s over loop 0's
(4.8 against 4.2 kept: the host), so the same-session column is the one to read.

**What each loop gave** (the desktop guest; each loop's own A/B, its REPORT entry above):

| loop | what | gave |
|---|---|---|
| 0 | the page's phase timings, `bench/snapz/probe.ts` | the baseline: pause 4.2 s, load 9.5 s |
| 1 | lz4_flex and crc32fast in the core | pauses −9%, the load −8%, files −2% |
| 2 | the save's pool (6 workers) | pause 3.80 → 1.07 s (Debian 0.52 → 0.16) |
| 2b | older files refused; the save's garbage recycled | the suspend's memory +535 → +206 MiB, the download's +1,560 → +1,238 |
| 3 | the load's pool | check, state and RAM 3.13 → 1.13 s (wall 9.5 → 7.6) |
| 4 | the first review's findings; a file save staged through OPFS | a picked file's pause 4.7 → 1.4 s; the download's memory +1,144 → +235 |
| 5 | the disk's blocks in runs | the restore's blocks 1.97 → 0.10 s (load 7.3 → 5.3; off the record 7.3 → 0.77) |
| 7 | the load's machine start | the dev server's HEAD from stat, the device worker ahead: load 5.6 → 1.4 s |
| 6 | qcow2's clusters through miniz_oxide | an import, an export 4-5% faster, the browser's peak 140-200 MiB lower |
| end | the final review's findings (E1-E6) | refusals before anything is touched; the load unchanged (below) |

**The final review** (`review/snapz-end`, a static review of f31e50f1; six findings, all real, each fixed with its test
failing first): **E1** a restore emptied and recreated an overlay before refusing a DISK frame of an unpinned slot,
one past the disk's end, one that doesn't unpack, or a frame out of order (all CRC-valid): the check pass now refuses
them (the frames' order, each DISK frame's slot and place, and its unpacking: by the pool's workers, a job's `unpack`).
Its cost on the desktop's load (`e1/`, two sessions, prefix = f31e50f1 against the fix, the same core, 3 rounds each
per session): total 1,063 (1,055-1,069) against 1,060 (1,036-1,065) in the second session, 1,112 (1,095-1,216) against
1,067 (1,044-1,075) in the first (its last round slow in every phase); the check pass 333 against 331, 347 against 327:
~0-2%, within what the sessions move. A fresh overlay switched in at the end (the other way) wasn't needed. **E2** an
inflate worker whose codec failed to start never answered, and the guest's read waited for good: it answers with an
error now, and a request unanswered for 10 s fails the pool (its share done on the reading thread). **E3** a download's
staging file was removed 60 s after the click whether or not the browser had read it (a `File` over a removed OPFS
file reads `NotFoundError`, confirmed): it is kept until the next file save or the page's end. **E4** a thread's qcow2
codec that failed once stayed failed: tried again at the next call. **E5** through the pool, an earlier frame's bad
CRC came out as a later frame's structural refusal: the piece in hand's frames are checked first. **E6**
`inflate_raw`/`deflate_raw` made a slice of a null pointer for length 0 (UB; a debug build aborted on it): no slice
for no bytes.

**Correctness:** tests/snapshot.test.ts "impossible things" (four CRC-valid damaged files, with and without a pool:
refused with their own message, the overlay's blocks and generation as they were; planted, each caught: no DISK check
in the check pass, no order check, no DISK unpacking, a failed worker's frame not unpacked again) and "a frame's bad
CRC is refused before a later frame's bad structure" (planted: the batch not given first); tests/qcow2.test.ts "the
inflate pool in Chromium" (a worker whose codec can't start, its stall timer past the read's bound; a silent worker;
both hung before); tests/page-snapshot-stage.test.ts "a download's staging file is kept" (a fake clock ten minutes on:
`NotFoundError` before); tests/deflate.test.ts (a codec whose memory was refused once); `cargo test` "no buffer for no
bytes" (aborted before).
`scripts/ci.sh` (797 s; its first run failed once on tests/page-clipboard-ui.test.ts's "the agent's end got [], not 62
bytes", a clipboard test this can't reach, green on its rerun), `ci-debian.sh --platform` (612 s), `ci-graphics.sh` (257 s)
and `ci-machines.sh` (325 s) green on the finished tree, once each, alone.

## PERF loop 30: preemption's counts and tools (2026-11-16)

The first entry of "Preemption without the budget" (PERF-HANDOVER.md, P0): tools and numbers for the loops that take
the step budget out of parallel realtime's compiled code. No behavior changes. Data: `bench/boot/results/perf30/`
(its README).

**The tools** (docs/benchmarking.md "The JIT's machine code, x64 and arm64" and "Preemption's counts", docs/devenv.md
"An x86_64 Node"; the 2026-11-16 prototypes in `bench/results/local/nobudget/` made permanent):
- `tools/x64node.ts`: Node's official linux-x64 build of the running version (checked against `SHASUMS256.txt`) and
  Debian trixie's amd64 libc6 2.41-12+deb13u4, libstdc++6, libgcc-s1 and libatomic1 14.2.0-19 (checked against the
  `Packages` index) into `target/x64node/`, run under `qemu-x86_64 -L`: x64 Node 26.7.0, the same V8 (14.6.202.34).
- `bench/jit/dump-modules.ts`: every JIT module of a deterministic guest run in Node (`WebAssembly.Module` wrapped,
  web/vm.ts untouched); Alpine's boot: 319 modules, 12.1 MB, in 5 s, the same set as the prototype's.
- `bench/jit/codestats.ts`: TurboFan code of dumped sets on arm64 and x64, per function (instructions, bytes, stack
  slots, frame memory operands). Its child is plain JavaScript through `-e`: a `.ts` child made V8 print Node's own
  type-stripping wasm too (12,048 functions instead of 7,232). It reproduces the prototype's awk exactly.
- The `diag` feature (`core/src/tally.rs`; `CARGO_TARGET_DIR=target/diag scripts/build-wasm.sh --features diag`) and
  `bench/boot/preempt-counts.ts`: tallies bumped by compiled code in the `Vcpu` and by the parallel run loop, published
  past each vCPU's counters block. The normal build's code section is byte-identical with and without the change (its
  data section differs only in panic locations' line numbers); the diagnostic core runs Alpine's boot in exactly
  tests/steps.txt's 2,651,076,469 steps.

**Counts per 1000 steps** (the diagnostic core in Node on the dev VM; `boot` and `user` deterministic on 1 vCPU as
`boot_alpine_jit` and `alpine_user_jit`, `smp1`/`smp4` `smp_alpine_jit`'s boot, `smp-user4` `smp_user_jit_4`, parallel
realtime):

| | boot | user | compress | Lua | churn | SQLite | smp1 | smp4 | smp-user4 |
|---|---|---|---|---|---|---|---|---|---|
| region back-edge | 19.5 | 12.3 | 17.4 | 1.1 | 14.7 | 17.0 | 21.1 | 21.4 | 11.9 |
| region forward edge | 106.9 | 113.4 | 97.8 | 117.3 | 117.6 | 125.4 | 106.9 | 106.2 | 110.3 |
| transfer cache hit (BR/BLR/RET) | 4.5 | 13.2 | 4.8 | 25.7 | 5.1 | 13.9 | 3.7 | 3.6 | 15.5 |
| miss function | 2.3 | 1.3 | 1.1 | 0.6 | 2.7 | 0.8 | 2.2 | 2.6 | 0.8 |
| chain backward (direct) | 11.7 | 11.4 | 5.1 | 18.1 | 11.7 | 7.1 | 11.7 | 12.0 | 12.0 |
| chain forward (direct) | 21.4 | 21.4 | 28.1 | 16.1 | 22.4 | 22.5 | 21.7 | 22.6 | 26.2 |
| chain via jump cache, back / fwd | 0.5 / 6.3 | 0.7 / 7.2 | 0.6 / 8.0 | 0.1 / 7.2 | 0.9 / 7.9 | 1.8 / 7.0 | 0.5 / 6.4 | 0.4 / 5.9 | 0.7 / 7.9 |
| by-VA link, back / fwd | 2.7 / 1.0 | 9.3 / 2.0 | 5.9 / 2.3 | 14.2 / 1.9 | 1.5 / 1.2 | 13.8 / 3.3 | 2.9 / 1.0 | 2.7 / 1.0 | 10.8 / 2.4 |
| host call / return | 12.4 / 11.6 | 11.0 / 10.3 | 6.7 / 6.2 | 9.2 / 8.7 | 17.1 / 16.2 | 13.4 / 12.8 | 11.8 / 11.5 | 11.1 / 10.7 | 9.4 / 9.3 |
| **decision 2's poll points** | 41.1 | 48.2 | 34.9 | 59.8 | 36.6 | 54.4 | 42.0 | 42.6 | 51.7 |
| today's `left` checks taken | 176.7 | 192.3 | 171.1 | 202.3 | 185.7 | 212.6 | 178.1 | 178.3 | 198.4 |

The poll points are the back-edges, transfer cache hits, miss-function entries, MMU-off jump cache hits (none: Linux
runs with the MMU on) and backward static chains of every form; today's checks are every edge, chain and transfer
taken. So a poll comes every 16-29 steps where a check comes every ~5: forward region edges, 55-63% of today's checks,
need none. Backward static chains are as frequent as back-edges (Lua: 18 against 1.1, its loops are chains of
regions), and in user space the by-VA links (backward 6-14 in compress, Lua and SQLite) go through the transfer cache
probe and so take its poll. Host calls (~10) need none of their own (a recursion past `MAX_DEPTH` is a tail call, a
backward chain).

**How parallel realtime chunks end** (CHUNK 32,768):

| | smp1 | smp4 | smp-user4 |
|---|---|---|---|
| chunks (mean steps) | 350,839 (6,933) | 925,626 (2,745) | 3,127,705 (10,114) |
| by the budget: chunks, steps | 11.5%, 54.1% | 4.4%, 52.1% | 26.8%, 86.8% |
| SVC | 32.2% | 12.3% | 6.6% |
| Resync (ISB, DSB, ERET, unmask not fast-completed) | 29.4% | 19.7% | 9.6% |
| exceptions (faults, traps) | 13.6% | 5.2% | 6.9% |
| platform (timer and GIC registers) | 8.8% | 11.4% | 10.6% |
| WFE / SEV | - | 26.7% / 13.4% | 22.4% / 11.3% |
| TLBI IS | - | 3.9% | 4.7% |
| device, IC, counter, WFI, HVC | 4.6% | 3.0% | 1.0% |

No chunk ended early without an exit. Most chunks end by an exit, but the budget-ended ones hold half the boot's
steps and 87% of the userspace phases': that's the time a stop word must cut short instead of the budget.

**Latency today** (the same parallel runs; Node in the dev VM, so the host's sleeps are Node's): a vCPU's own timer
line seen by its run loop past the deadline, while running: mean 78 / 86 / 42 µs (smp1 / smp4 / smp-user4), max 5.1-6.7
ms; in WFI (the host's sleep to the deadline): mean 1.55 ms / 318 / 299 µs, max ~10.5-11 ms. An interrupt line's rise
(`Vm::refresh`, any thread: SGIs, devices, timers) to the IRQ taken while running: mean 2.8 / 10.3 / 4.1 µs, 99% / 92%
/ 95% under 10 µs, 2 / 18 / 17 over 1 ms (max 3.8-9.2 ms; a vCPU out in the host or the guest masking IRQs counts
too); to a WFI completed: mean 0.3 / 11.6 / 13.2 µs. tests/baremetal/timer.c and unmask.c report no latency (they pass
or fail; unmask.c runs in round-robin only, where it bounds the unmask's lag at 16 loop trips), and no test or tool
measures an IPI round trip: P1's spin tests should time one.

**Static counts of today's code** (Alpine's boot, 319 modules, 7,232 TurboFan functions; `codestats.json`), per
function: arm64 1,070.3 instructions, 4,063 bytes, 15.6 stack slots, 199.4 frame memory operands; x64 840.1, 3,681,
13.8, 175.0. The prototype's `nobudget.patch` set (317 modules, 7,143 functions) against it: arm64 −8.7% instructions,
−8.8% bytes, −4.6% slots, −5.7% frame operands; x64 −13.4%, −12.0%, −4.8%, −14.1% (the handover's numbers,
reproduced by the tools). x64 compiles a set in ~2 min under qemu, arm64 in ~20 s.

**The baseline on the Mac** (M4, Chrome for Testing 157.0.8103.78, b707e614's code, 3 rounds, medians a round;
`mac-r*.json`): `smp_alpine_jit` to its script / to power-off on 1 vCPU 2,913-2,949 / 5,523-5,535 ms, on 2
2,519-2,538 / 5,127-5,163, on 4 2,481-2,504 / 5,123-5,154; `smp_user_jit_4` total 11,297 / 11,593 / 11,467 ms
(compress 1,272-1,367, Lua 2,370-2,723: round 2's two samples 340 ms apart, churn 790-811, SQLite 1,835-1,947); `jit_mips`
6,723-6,809 MIPS (the user-mode small guest: one thread, no VM, so not parallel realtime; it gauges compiled code's
own cost). Spotlight indexing (`mds_stores`) took a core on the Mac right after the run (when it started is unknown). An orphaned hvf bare-metal
QEMU from an earlier oracle run had spun for 50 minutes there before the run; it was ended first. `smp_user_jit_4`
takes two samples a round and spread 2.6% across rounds: P1's A/B needs more rounds for it to resolve ~1%.

Firefox's pages session wasn't run: its harness is broken (PERF-HANDOVER.md's queue) and P4 runs it.

`scripts/ci.sh` (817 s) and `scripts/ci-jit.sh` (112 s) green, alone; `cargo clippy --features diag` clean.

## PERF loop 31: parallel SMP's code without `left`, with a stop word (2026-11-16)

P1 of "Preemption without the budget" (PERF-HANDOVER.md): in parallel SMP compiled code carries no step budget; it
polls a per-vCPU stop word where a cycle can close. Data: `bench/boot/results/perf31/` (its README). docs/jit.md
"Preemption (parallel SMP's polled code)", docs/platform.md "Parallel SMP", docs/abi.md "PERF: the stop word" (ABI 71).

**As built.** `jit::Config::polled` (parallel SMP only; round-robin, deterministic or realtime, and user mode keep the
counted code): no `left` checks, no `left -= len`, no `SUM`, `left` passed as 0; `acc` a plain local that edges bump.
The poll is `acc < stop` (`i32.atomic.load` of `jit::State::stop` at a fixed `Vcpu` offset, ANDed into the transfer's
condition, so a failed poll takes the path a failed budget check took). Points: static transfers (region edges,
direct chains, chains through the jump cache, by-VA links) whose target VA is at or before their block's start, and
every indirect transfer (the transfer cache's probe, the MMU-off jump cache's, the miss function). The run loop stores
the chunk's steps in the word at the top of each pass, before it reads the signal word, the IRQ line, the queue and
the timers; the dispatcher passes the steps done as `acc` and stops when the word is at or under them. Setters store 0
after making their news: `Vm::wake` (a raised IRQ line through `Vm::refresh`, CPU_ON, drains, `Vm::signal`), the TLBI
IS push for each target the issuer's DSB will wait for, and the host after a signal bit (`raise`, the backends' `kick`)
through the new `vm_cpu_stop`.

**The timer and the event loop without a ticker.** Decision 2 names a ticker thread for what has no event (the vCPU's
own deadline, `yieldMs`, periodic work); the stop word's value is the chunk's steps instead of a flag, so a vCPU
looping with no exit still ends a chunk at the first poll past them (Alpine's boot: 32,793 steps on average for the
chunks that ran out, against 32,768), and every bound that was "within a chunk" stays one, at the same cost as a
flag (one compare against a live `acc`). It also keeps `acc` far from `RETURNED` without a guard. A ticker that lets
chunks run longer is P2's to measure against this. A test (`vm_set_chunk`, up to 2^30 in polled mode) makes chunks
long so that only the setters end one early.

**Counted code unchanged:** Alpine's deterministic boot dumped by both cores (`bench/jit/dump-modules.ts`): 319
modules, the same steps (2,651,076,469), 317 byte-identical; the other two differ only in one `i32.load` offset, the
address of the core's CRC tables, which moved with the core's data (`deterministic-modules.json`). The stop word sits
in the padding after `jit::State::mem`, so no other `Vcpu` offset moved. tests/steps.txt didn't move.

**Polls, chunks and latency** (the diagnostic core, `bench/boot/preempt-counts.ts`, Node on the dev VM; base 0ffa96ef
against this; `counts-base.json`, `counts-new.json`):

| | smp1 base / new | smp4 base / new | smp-user4 base / new |
|---|---|---|---|
| polls per 1000 steps | - / 56.4 | - / 55.9 | - / 65.1 (compress 46.7, Lua 74.7, churn 53.6, SQLite 73.3) |
| chunks; ended by the steps | 352,302; 11.4% / 352,606; 11.4% | 761,324; 5.4% / 761,974; 5.2% | 3,051,006; 27.6% / 2,734,491; 30.7% |
| ended early by the word | - / 0.61% | - / 0.71% | - / 0.32% |
| own timer seen late, running (mean) | 80.9 / 83.0 µs | 91.3 / 93.8 µs | 42.9 / 39.3 µs |
| IRQ line to IRQ, running (mean; <10 µs) | 3.3 / 2.9 µs; 98.9 / 98.9% | 12.6 / 10.0 µs; 93.1 / 93.1% | 5.3 / 4.1 µs; 95.3 / 96.6% |
| wall time in Node | 6.4 / 6.5 s | 6.2 / 6.1 s | 15.2 / 13.7 s |

The polls run at 56-65 per 1000 steps where loop 30 estimated 42-52 from its tallies of the points: the probes that
miss poll twice (the probe's, then the miss function's), and region edges to a member at a lower VA poll too.
Latency is no worse (one run each: within noise, the IRQ means a little lower).

**Static counts** (`bench/jit/codestats.ts`, `codestats.json`) of a parallel SMP boot's modules (Alpine on 1 vCPU,
`dump-modules.ts --parallel 1`, a set per core: not the same regions, so per-function means; base 313 modules, 7,134
functions; new 312, 7,096): arm64 instructions −6.3%, code bytes −6.5%, stack slots −3.9%, frame memory operands
−5.7%; x64 −9.8%, −8.9%, −4.0%, −13.8% (loop 30's `nobudget.patch`, no polls at all: arm64 −8.7%/−5.7%, x64
−13.4%/−14.1%).

**Spin tests** (`tests/baremetal/spin.c`, `tests/spin.test.ts`; docs/testing.md "Spin tests"): CPU 1 loops with no
exit in five shapes (a one-block loop, a 20-block chain cycle, a BR to itself, two BRs sharing a transfer cache slot,
a by-VA link back), at EL1 with the MMU off and on and at EL0; it takes CPU 0's IPIs (round trip timed: medians 2-21
µs under the JIT, 37-296 under JIT-check), answers TLBI IS (DSB 30-110 µs), takes its timer (6-420 µs late under the
JIT with the default chunk, one first-run outlier at 11 ms), and the machine pauses in ~0.1 ms (the first pause ~7
ms); also with 2^30-step chunks, where only the setters end a chunk early. Planted, each caught: every poll kind
(region edge, direct chain, chain through the jump cache under JIT-stress, transfer cache probe, miss function,
MMU-off jump cache, by-VA link under JIT-check), every setter (`Vm::wake`, the TLBI IS push, the host's `raise`, the
backends' `kick` by tests/devices.test.ts), the dispatcher's check and the chunk bound. The guest passes on QEMU TCG
and hvf; QEMU faulted its first version's code writer, whose 8-byte store at a 4-byte boundary to Device memory (MMU
off) waarm64 ran: in docs/backlog.md.

Memory: none (4 bytes a vCPU, in padding).

**The Mac A/B** (M4, Chrome for Testing 157.0.8103.78, 5 rounds, the first arm alternated, nothing else running on
the dev VM or the Mac; medians a round; `mac-r*.json`; an earlier session beside `scripts/ci.sh` was discarded):

| | base | new | |
|---|---|---|---|
| `smp_alpine_jit` n1 script / total (ms) | 2915-2947 / 5510-5539 | 2884-2940 / 5453-5535 | −1.0% / −0.8%, overlapping |
| n2 script / total | 2531-2565 / 5149-5179 | 2483-2548 / 5086-5168 | −0.9% / −0.7%, overlapping |
| n4 script / total | 2476-2530 / 5119-5180 | 2446-2503 / 5081-5139 | −2.1% / −0.8%, overlapping |
| `smp_user_jit_4` total | 11275-11676 | 11225-11620 | −1.6%, overlapping |
| compress / Lua / churn / SQLite | 1270-1398 / 2373-2780 / 816-835 / 1768-1995 | 1214-1389 / 2365-2870 / 799-827 / 1713-1815 | +5.5% / +0.3% / −0.9% / −0.7% |

Every median is lower but compress's, and no difference resolves: compress is bimodal in both arms (base 1270-1288
in four rounds and 1398 in one; new 1346-1389 in three and 1214-1216 in two), Lua spreads 400 ms in both. The
parallel-realtime run nearest a loop-heavy small guest is `smp_alpine_jit` n1 (one vCPU worker) and the Lua phase:
both even. jit_mips (round-robin's user mode, not this path) wasn't run: its code is unchanged. Loop 30's nobudget
patch bounded the gain at +17% for a user-mode loop with no polls at all; with them, the boots and the userspace
phases move ~1-2%, under the gates' resolution here. In `scripts/ci.sh` "alpine boots on 4 vCPUs in parallel" took
66 s (49-60 s in earlier logs, under CI's load; 110 s in the contended run); alone it takes 14.6 s.

CI, each alone: `scripts/ci.sh` (896 s), `scripts/ci-jit.sh` (134 s, the spin tests under JIT-stress and JIT-check with it), `scripts/ci-debian.sh` (332 s); the xHCI's tick path and sound are untouched (no `ci-usb.sh`, `ci-audio.sh`). The oracle runs (`oracle.sh`, `--hvf`) left a QEMU spinning on the Mac
(`watch`, docs/backlog.md's known leak); the supervisor ended it.

## PERF loop 32: what a chunk end costs, and the ticker that wasn't kept (2026-11-16)

P2 of "Preemption without the budget" (PERF-HANDOVER.md): since loop 31 parallel SMP's polled code ends a chunk at the
first poll past its steps (32,768), and decision 2's ticker (a thread storing 0 in the stop words at each vCPU's timer
deadline and periodically, so that chunks could run far longer) didn't exist. This loop measured whether one pays:
first what a chunk end costs, then the ceiling (long chunks with nothing to end them), then a ticker built behind a
switch. **Not kept: nothing beat loop 31 past the gates' noise, and long chunks without a prompt end lose 2-4%.** Data:
`bench/boot/results/perf32/` (its README); nothing of the arms is in the tree.

**What a chunk end costs.** The diagnostic core times the run loop's work between a chunk that ended by its steps
and the next one (`core/src/tally.rs` `BETWEEN`, `BETWEEN_NS`; `bench/boot/preempt-counts.ts` prints it; Node on the
dev VM, loop 31's code, `counts-default.json`): **189 / 204 / 220 ns** a chunk end (smp1 / smp4 / smp-user4; two
clock reads included), at 40,105 / 42,143 / 837,147 such ends (11.4% / 5.2% / 31.4% of the chunks). Against the vCPU
time that's 0.12% of Alpine's boot on 1 vCPU and 0.36% of the userspace phases on 4 (837K × 220 ns over 4 × 12.7 s),
before the dispatcher's re-entry (a key, a lookup, a call: not timed, the same order). So the most any ticker can win
is ~0.5% of the gates, under their ~1% floor. And on the Mac, 4× the chunk ends cost nothing that shows: `?chunk=8192`
against the default, 3 rounds alternated (`mac-short`), every gate within −0.5% to +0.9%, overlapping.

**The ceiling: long chunks, nothing to end them.** The same core with 2^20-step chunks (`?chunk=1048576`, the bench's
`smp()` takes it now), 5 rounds alternated (`mac-ceiling`; ranges of the rounds' medians, ms):

| | default | 2^20 | |
|---|---|---|---|
| `smp_alpine_jit` n1 script / total | 2822-2928 / 5379-5501 | 2980-3020 / 5551-5608 | +3.5% / +1.7%, no overlap |
| n2 script / total | 2445-2522 / 5019-5126 | 2576-2608 / 5156-5214 | +3.5% / +1.9%, no overlap |
| n4 script / total | 2417-2491 / 5032-5138 | 2544-2575 / 5168-5214 | +4.1% / +2.0%, no overlap |
| `smp_user_jit_4` total | 10956-11490 | 11145-11869 | +2.7%, overlapping |

Longer chunks lose, though they end 98-99% fewer chunks by their steps (Node: 674 / 697 / 17,628). Two things only a
chunk end did, measured: the vCPU's own timer (Node, seen late while running: 83 / 84 / 36 µs mean → 178 / 161 / 260
µs, `counts-long.json`), and **the installs of compiled modules**: the dispatcher installs what the compile worker
finished (`Jit::fresh`) and a vCPU in compiled code reaches it only at a chunk's end, so the block interpreter runs
on meanwhile: interpreted steps in the boot (`jit.decSteps`, medians of 5) 156 → 171M on 1 vCPU, 180 → 196M on 2,
210 → 225M on 4. IRQs from other vCPUs and devices (loop 31's setters) stayed prompt (2.3-10.4 µs mean).

**A ticker without a thread: paced chunks** (`paced.patch`, a `paced` feature). A thread that wakes at deadlines
costs a futex wake-up (~17 µs in the dev VM, docs/platform.md "Parallel SMP"), with macOS's timer slack on top; the
run loop already knows the vCPU's deadline, so this arm put it in the stop word instead: at each timer check it
measures the vCPU's steps per counter tick (an average over the checks of one run) and sets the chunk to 7/8 of the
steps estimated to its next deadline, at most 2^20 steps or ~1 ms (the event-loop visit, the publications and the
sampler keep their bounds; 32,768 while the xHCI's completions wait), lowering the word with a compare-exchange when
the guest sets a nearer deadline (a setter's 0 wins). Node (`counts-paced.json`): chunk ends by the steps −59% /
−52% / −71% (16,446 / 20,129 / 244,178, 48-94K steps each), the timer seen 71 / 69 / 26 µs late (from 83 / 84 / 36),
IRQ line to IRQ 3.3 / 14.2 / 3.7 µs (2.8 / 13.7 / 2.8). On the Mac it lost like the long chunks (`mac-paced`, one
round of each arm and a second of `paced`): boots +2.3-4.1% to the script, interpreted steps 156 → 160M: the module
installs again. So the compile worker became a setter too (`compile-stops.patch`: when `ready` moves it stores 0 in
every stop word, which `vm_cpu_stop` already gives the host). Then, 5 rounds alternated, three arms (`mac-cw`):

| | loop 31 | + the compile worker's stores | paced, with them |
|---|---|---|---|
| `smp_alpine_jit` n1 script / total | 2912-2929 / 5492-5510 | 2914-2938 / 5500-5527 (+0.2% / +0.1%) | 2911-2981 / 5487-5574 (+0.2% / +0.1%) |
| n2 script / total | 2508-2533 / 5105-5147 | 2489-2537 / 5069-5142 (−0.1% / 0.0%) | 2510-2548 / 5106-5158 (−0.1% / +0.1%) |
| n4 script / total | 2457-2487 / 5092-5128 | 2471-2492 / 5108-5129 (+0.4% / +0.3%) | 2459-2517 / 5092-5176 (−0.1% / 0.0%) |
| `smp_user_jit_4` total | 11194-11466 | 11147-11431 (−0.2%) | 10979-11708 (+0.7%) |
| compress / Lua / churn / SQLite | 1243-1377 / 2351-2659 / 778-829 / 1723-1866 | −0.1% / −0.2% / +0.7% / −4.5% | −5.3% / −0.6% / +0.5% / +2.5% |

Every range overlaps; interpreted steps 156 / 156 / 158M on 1 vCPU. Neither the stores nor the pacing resolve, as the
chunk-end cost said they couldn't, and the pacing's rate estimate can only make its timer worse than a bound in steps
where the rate drops (interpreted code, compiles). Both were left out; so was a ticker thread, which could win no more
than the paced arm's ceiling (the same chunk ends saved) and adds a thread's wake-ups and their jitter.

**What it means for the next loops.** The chunk's steps in the stop word are the cheap ticker: they bound the timer's
and the installs' latency at a cost under the gates' resolution, and a chunk end is what installs compiled code.
Dropping `acc` (P3) would need something else to end a chunk with no exit at about 32K steps' pace (timers, installs);
this loop measured that nothing cheaper does it, so P3 should keep `acc` as the bound unless its own cost is shown.
Latency (decision 3's bounds) is as loop 31 left it: the code didn't change (the spin tests and `preempt-counts.ts`
weren't re-run for it; the numbers above are this session's of loop 31's code).

Memory: none. The Mac's Spotlight (`mds_stores`, ~40% of a core) ran through all the sessions, both arms alike. Kept:
the diagnostic tally of the time between chunks, `preempt-counts.ts --chunk N` and `smp()`'s `?chunk=` (docs/benchmarking.md);
the normal build's code section is byte-identical to a9b8d140's.

CI, each alone: `scripts/ci.sh` (827 s) and `scripts/ci-jit.sh` (131 s) green; `cargo clippy --features diag` clean.
Not run: `scripts/ci-debian.sh`, `ci-usb.sh`, `ci-audio.sh` (no run loop, host, xHCI or sound change is left), the spin
tests and `oracle.sh` on the arms (none was kept).

## PERF loop 33: the review of the preemption code, fixed (2026-11-16)

The out-of-context review of loops 31-32's preemption (the stop word, its polls and setters; branch
`review/perf-preempt`, deleted with this loop) found four things; all four are fixed, and a fifth, next to the first,
that the review had passed over. Data: `bench/boot/results/perf33/` (its README). docs/jit.md "Preemption (parallel
SMP's polled code)", docs/testing.md "Spin tests" and "Polled code against the interpreter".

**1. A cycle of compiled blocks needn't have a backward PC.** docs/jit.md argued that around any cycle of static
transfers the offsets sum to 0, so one transfer is backward and polls. That holds for transfers to fixed targets (their
key, a PA, only grows forward), not for a **by-VA link**, whose target is whatever its VA maps now: a run forward
through VAs that alias pages already run reaches the same compiled blocks again. The review's bound was too high (a
code offset's entries fit in only 16 transfer cache slots, VA bits 12-15, so a run with no poll is at most ~16 × the
compiled code, not 16,384 × a page), but it is a multiple of the code, not of a chunk. **And host calls** (not in the
review, which took "a host call needs none" from the docs): a callee's return lands back in its caller with no
transfer, so forward calls from a run of call sites to one callee, nested, run steps that multiply with the depth
(four levels of 256 sites would pass 2^31 steps, where `acc` reads as `RETURNED` and the dispatcher's assert panics the
vCPU's worker).
- *Confirming tests, failing first:* two spin.c shapes that record where CPU 1 took each of CPU 0's 8 pings (ELR):
  `alias` (MMU on: 16 VA copies of 4 pages of UDIVs, each copy's entry in its own transfer cache slot; a tail page
  after the last copy with the lap's check and counter) and `calls` (16 BLs to f1, f1 16 BLs to f2, f2 16 UDIVs, each
  callee in a later page: host calls once compiled), each warmed first (200 and 400 laps; spin.c now takes ~84M
  steps, so the bare-metal tests' step bound is 150M in `core/tests/baremetal.rs` and `boot-node`). With a poll only at the lap's check every
  ping lands there: on 783e88a7 **0-1 of 8** inside the shape for `alias` (EL1, EL0; default chunks: with 2^30-step
  chunks the copies may still run interpreted when the pings come) and `calls` (EL1 MMU off and on, EL0) under the
  JIT, and `calls` 0 of 8 under JIT-check (JIT-stress evicts too fast to show it); the test wants at least 4. The round
  trips didn't show it: the laps (~64K and ~4K steps) take tens of µs. A first version with short pages (a few dozen
  UDIVs) didn't separate the arms: the pings landed at the lap's end more than its share of steps, at EL1 often all 8
  with the fix too (what a lap's end costs outweighed the copies).
- *Fix:* polled code polls every by-VA link (`block::chain`'s `by_va`: the transfer cache probe's poll) and a RET at a
  host-call depth (`emit::ret_up`): a failed poll returns the count without `RETURNED`, the stop every caller passes
  up to the dispatcher, the PC at the return's target. Unpolled are then only forward transfers to fixed targets,
  each compiled block at most once a run: a run with no poll is bounded by the compiled code (and `acc` by
  2^30 + it). After: 6-8 of 8 inside, in every mode (JIT, JIT-stress, JIT-check, the block interpreter; both chunk lengths). Planted: each poll left out is the base above.

**2. Interpreted code ignored the stop word under long chunks.** `jit::steps` ran the block interpreter (and the
debug interpreter, for an EL armed for debug) for the rest of the chunk: up to 2^30 steps under `vm_set_chunk`.
- *Confirming tests, failing first:* a spin.c shape `debug` (the one-block loop with a breakpoint armed at an address
  never executed: the debug interpreter runs it), and the spin test under the block interpreter alone (`VmConfig.jit`
  4, in `scripts/ci-jit.sh`). On 783e88a7 with 2^30-step chunks: under the JIT, CPU 0's IPI wait gave up (exit 27,
  `debug` at EL1, MMU off); under the block interpreter, no power-off in 60 s (stuck in the first shape).
- *Fix:* in polled code the dispatcher interprets at most `jit::POLLED_RUN` (32,768, a default chunk) steps before it
  reads the word again: the default chunk's bound at no cost per block (a check at the block interpreter's block
  boundaries would cost one per block). After: `debug`'s round trips 0.5-1.3 ms in both chunk modes (~32K steps of
  the debug interpreter), the block interpreter's runs pass (round trips 4-16 µs).

**3. Polled code had no differential coverage.** A knob without a host ABI change (a `jit_parallel` bit or an export
would have been one, ABI 72; not taken): the **polled test core**, Cargo feature `polled` built into `target/polled/`
(~20 s), whose user-mode JIT vCPUs compile polled code; its `jit_run` stores the steps left in the stop word, as a run
loop stores its chunk's, and returns the steps the code ran. `WAARM64_CORE=… WAARM64_POLLED=1` runs
`tests/jit-diff.test.ts`, the user-mode lockstep and `tests/corpus-wasm.test.ts` on it, the interpreter running the
steps the JIT ran (one more after an exit); `scripts/ci-jit.sh` does, with 1024 words a class (~1.5 min; all 4096:
~6 min, green). The harness skips a polled run that stored into code: it runs on past the steps asked for into other
words and the data area's random ones, and then runs stale blocks, as the tests already skip a run that rewrote its
own code (two such runs failed the first full pass). Planted on the polled core, each caught by the differential test:
a region edge's `acc` bump one too many (18 tests fail), a host-call return's stop without its block's length
(`branch to register`), the jump cache's poll ORed into its condition instead of ANDed (42 tests). A region edge's
`acc` bump left out (or one short) leaves a one-block loop polling past nothing: the run hangs at its bound (caught,
not as a named failure). A poll that always or never passes changes no result the interpreter sees: the spin tests
catch those. The MMU-on paths (the transfer cache, by-VA links, the miss function) stay the parallel boots' and the
spin tests' (docs/backlog.md).

**4. SeqCst on one side.** The run loop stores the chunk's steps (SeqCst), then reads the signal word (Acquire);
`Vm::signal` sets its bit with an AcqRel `fetch_or` before the setter's SeqCst store of 0: store-then-load needs SC on
all four under the C++20/Rust model, or fences. Now a SeqCst fence after the run loop's store and one in `Vm::stop`
before its store of 0, which covers every kind of news whatever its own ordering (the fence rules). No test can show
it: wasm's atomics are all SC, and natively AArch64's STLR then LDAR and x86's locked store don't reorder either.

**Counted code unchanged:** Alpine's deterministic boot dumped by both cores: 319 modules each, all byte-identical,
2,651,076,469 steps each (`deterministic-modules.json`); tests/steps.txt didn't move.

**Polls and latency** (the diagnostic cores, `preempt-counts.ts`, Node 26.7.0 on the dev VM; `counts-base.json`,
`counts-new.json`):

| | smp1 base / new | smp4 base / new | smp-user4 base / new |
|---|---|---|---|
| polls per 1000 steps | 56.3 / 69.0 | 56.5 / 68.2 | 65.5 / 77.4 (compress 46.7 / 54.0, Lua 74.9 / 85.2, churn 54.5 / 72.3, SQLite 74.2 / 91.4) |
| host returns; by-VA links forward, per 1000 | 11.5; 1.1 / 11.5; 1.0 | 10.6; 1.0 / 10.9; 0.7 | 9.5; 2.2 / 9.9; 2.7 |
| chunks ended early by the word | 0.60 / 0.61% | 0.74 / 0.72% | 0.32 / 0.29% |
| own timer seen late, running (mean) | 79.4 / 83.3 µs | 86.0 / 86.3 µs | 35.4 / 36.2 µs |
| IRQ line to IRQ, running (mean) | 3.2 / 2.9 µs | 13.4 / 13.0 µs | 3.6 / 3.6 µs |

The polls rise ~12 per 1000 steps (+21%): the host returns, 10-12 per 1000; the forward by-VA links ~1-3. Latency as
before (one run each).

**Static counts** (`codestats.json`: a parallel boot's modules per core, `dump-modules.ts --parallel 1`, per function;
base 310 modules / 7,043 functions, new 311 / 7,102): arm64 instructions −0.3%, code bytes −0.4%, stack slots −0.3%,
frame memory operands −1.1%; x64 0.0%, −0.2%, −0.3%, −1.0%. A poll is one atomic load and a compare in a function
that already had the transfer; the sets differ a little run to run, so this is "no change".

**The Mac A/B** (M4, Chrome for Testing 157, 5 rounds, the first arm alternated, nothing else on the dev VM; medians a
round, ms; `mac-r*.json`, `summary.py . mac base new`):

| | base | new | |
|---|---|---|---|
| `smp_alpine_jit` n1 script / total | 2886-2919 / 5464-5506 | 2901-2947 / 5484-5533 | +0.5% / +0.3%, overlapping |
| n2 script / total | 2486-2538 / 5072-5150 | 2501-2537 / 5088-5132 | 0.0% / +0.2%, overlapping |
| n4 script / total | 2451-2480 / 5084-5097 | 2451-2493 / 5091-5126 | +0.5% / +0.3%, overlapping |
| `smp_user_jit_4` total | 11116-11333 | 11040-11420 | −0.4%, overlapping |
| compress / Lua / churn / SQLite | 1230-1402 / 2347-2635 / 777-801 / 1695-1915 | 1196-1309 / 2339-2460 / 793-835 / 1714-1951 | −1.5% / +1.3% / +3.7% / −0.8%, overlapping |

Nothing resolves: the boots' medians move +0.2-0.5% (under the ~1% floor, overlapping), the userspace total −0.4%;
churn's +3.7% overlaps (777-801 against 793-835). Memory: none (a constant, two fences, the polls' bytes in the
modules).

**Oracles:** spin.c passes on QEMU TCG and hvf (hvf with the shapes' first version; the breakpoint's registers too),
the final spin.bin and the fixed smp.bin on TCG; `oracle.sh` also printed what it does with binaries this loop didn't
change (TCG: `watch` timed out, `xblock` 132, once `isb` 10; hvf: `debug` 2, `mmio` 11, `watch` timed out). No QEMU or
Chrome left on the Mac.

**smp.c's lost wake-up (a guest bug, its own commit).** `scripts/ci-jit.sh` failed 4 times in a row on `parallel:
bare-metal smp.bin (JIT-check)` (exit 30 after ~100 s): a secondary frozen at 211 steps in its WFI loop. It reproduced
on the base core too (1 in 30 runs beside that suite), and the supervisor's static review found the cause: both of
smp.c's WFI loops checked their condition with IRQs unmasked, so an IRQ taken between the check and the WFI returned
onto the WFI, and the last one left the CPU asleep for good (architecturally allowed). The loops check masked now and
unmask only around the WFI: 60 of 60 runs beside the suite passed. No other bare-metal test checks unmasked before a
WFI (timer.c and rx.c wait masked; the rest end in a WFI loop). Beside it, ci-jit.sh now runs the spin tests in a step
of their own: they shared the cores with the parallel boots and missed a bound once (JIT-stress's round trips, 1.4 ms
median) when ci-jit.sh ran them together.

CI, each alone, on the final tree: `scripts/ci.sh` (826 s), `scripts/ci-jit.sh` (287 s: the polled core's build and
its differential, lockstep and corpus runs ~100 s of it), `scripts/ci-debian.sh` (362 s; the run loop's fences). Not
run: `ci-usb.sh`, `ci-audio.sh` (no xHCI or sound change), `oracle.sh --hvf` on the final spin.bin (the first version
passed there; the breakpoint arming is unchanged).

## PERF loop 34: what's left of the preemption's cost (2026-11-16)

P3 of "Preemption without the budget" (PERF-HANDOVER.md): what `acc`, the poll points and the poll's form still cost
in parallel SMP's polled code, each kept or dropped by numbers. **Kept: plain loads for the polls but on looped
regions' edges** (arm64 −1.4% instructions, x64 −2.1%; the Mac's gates −0.2 to −1.0%). **`acc` costs ~1-2%** and stays
(it's the chunk's bound and the step count; its replacement is filed); no poll point is redundant; `word == 0` saves
nothing. Data: `bench/boot/results/perf34/` (its README). docs/jit.md "Preemption (parallel SMP's polled code)".

**Static counts** (`bench/jit/codestats.ts`, per function; sets dumped by `dump-modules.ts --parallel 1`, Alpine's boot
on 1 vCPU, ~7,060 functions; the poll forms are the *same* set rewritten in place by `rewrite.mjs`, exact; two dumps
of one core differ by +0.5% instructions, +0.6% frame operands):

| | arm64 instructions / frame memory operands | x64 instructions / frame memory operands |
|---|---|---|
| plain `i32.load` for every poll | −1.6% / −1.1% | −2.3% / −1.1% |
| `0 <u word` (the `word != 0` form) | −0.1% / +0.3% | 0.0% / +0.6% |
| no poll at all (`i32.const 1`: the polls' whole cost) | −3.5% / −1.0% | −5.4% / −1.5% |
| **kept: plain but on looped regions' edges** (its set against itself all atomic) | **−1.4% / −1.1%** | **−2.1% / −1.0%** |
| no `acc` (`noacc.patch`, two dumps against base's) | −1.8, −2.6% / −8.7, −9.4% | −2.7, −3.5% / −10.2, −10.9% |

An `i32.atomic.load` of the word is, on arm64, an address add, `tst` and `b.ne` to a trap stub (alignment), another
add and an LDAR, against one `ldr w, [x, #1444]`: ~7 instructions more a poll, at ~2 polls a function. `0 <u word`
compiles to the same compare as `acc <u word`, so the `word == 0` form saves nothing and would lose the chunk's bound.
`acc`'s cost is in the frame: it's a parameter live everywhere and across the helper calls, spilled at each of the
edges' bumps.

**Is a plain load correct?** Wasm's memory model (JavaScript's) lets a compiler merge racy plain reads, and TurboFan
(V8 14.6) does: a stand-alone `loop` of a plain load and a compare loads the word once before the loop (`hoist.mjs`;
the atomic form loads it every lap), and a direct tail call to itself is inlined four levels with one load, then a
real call (`tailself.mjs`). In the JIT's own loops (`spin.c`'s new `pure` shape, dumped from the spin test) it loads
the word once per four unrolled laps: the loop's stack check, a call on its slow path, makes it read memory again at
the head. A read gone stale is the chunk's steps or 0 (nothing else is ever stored), so the chunk's bound holds
whatever is merged; only a setter's promptness could suffer. So the polls on a looped region's edges (one is on every
lap of the wasm loop) stay atomic, and the rest (chains, the transfer cache's and jump cache's probes, the miss
function, host-call returns: each leaves the function's invocation when it passes, and V8 reads memory afresh in each
invocation and after any call) are plain: 1,255 of ~15,000 polls atomic in a boot's set.

**Fewer poll points:** none is redundant. Polling only a region's back-edge (the head's edge), not its other edges to
a lower VA, took the polls from 69 / 68 / 77 to 56 / 55 / 62 per 1000 steps (smp1 / smp4 / smp-user4) and failed the
spin test with 2^30-step chunks under the JIT (CPU 0's DSB waited 10 s): the 20-block chain's cycle leaves its region
and comes back through chains forward, and its only backward step is an edge to a non-head member, a forward `br` in
the wasm. The miss function's second poll after the probe's (when the probe's tag missed; 1-4% of the polls) is the
only poll of a guarded chain whose guard failed, and the probe's failed poll falls to the miss function, which would
then run on. Host-call returns (10-12 per 1000) bound nested forward calls (loop 33).

**What `acc` costs on the Mac** (`noacc.patch`: `acc` a constant 0, the polls `0 < word`, so chunks end only at exits
and setters; with `compile-stops.patch` on its runs, so that modules' installs stay prompt, PERF loop 32; its steps
and MIPS are wrong by design: measurement only). The A/B (M4, Chrome for Testing 157, 5 rounds, each round's order of
the three arms rotated, nothing else on the dev VM; medians a round, ms; `mac-r*.json`, `summary.py . mac base new`):

| | base | new (kept) | | noacc (measurement) | |
|---|---|---|---|---|---|
| `smp_alpine_jit` n1 script / total | 2887-2920 / 5448-5515 | 2884-2906 / 5451-5488 | −0.4% / −0.3% | 2870-2882 / 5430-5456 | **−1.3%** / −1.0% |
| n2 script / total | 2493-2542 / 5091-5150 | 2477-2512 / 5068-5124 | −0.8% / −0.4% | 2459-2498 / 5030-5100 | −1.6% / −0.9% |
| n4 script / total | 2461-2502 / 5083-5144 | 2433-2456 / 5056-5086 | **−1.0%** / −0.8% | 2416-2428 / 5026-5045 | **−2.0% / −1.3%** |
| `smp_user_jit_4` total | 11017-11334 | 11087-11469 | −0.2% | 10860-11112 | −2.5% |
| compress / Lua / churn / SQLite | 1215-1298 / 2337-2489 / 784-809 / 1722-1923 | −2.1% / +1.8% / −1.2% / +3.0% | | −4.1% / −4.7% / −3.1% / +0.2% | |

Bold: no overlap. The kept change: every boot median lower (n4's script past the rounds' spread), the userspace
total even; Lua and SQLite spread 150-200 ms in each arm. Without `acc` the boots are 1-2% faster and the userspace
phases 2.5% (overlapping), though its chunks run long between exits (its own timer seen later, loop 32): `acc`'s ~1-2%
is about what loop 31 got from dropping `left`. It stays: it bounds the chunk (the timer and the installs, loop 32: no
cheaper bound) and it is the steps the MIPS readout, the run loop's step clocks and the sampler count. Dropping it needs
a setter for each and time in place of the steps: docs/backlog.md "Parallel SMP's code without `acc`".

**Polls and latency** (the diagnostic cores, `preempt-counts.ts`, Node 26.7.0 on the dev VM; `counts-*.json`): polls
per 1000 steps unchanged (base 68.9 / 68.1 / 76.6, new 69.0 / 67.8 / 76.8); chunks ended early by the word 0.60 /
0.86 / 0.28% (base 0.61 / 0.54 / 0.30%); own timer seen late while running, means 80-96 µs in 3 runs of each arm on
1 vCPU (base 81-88), 94 / 38 µs on smp4 / smp-user4 (base 97 / 36); IRQ line to IRQ while running 3.0-3.5 µs (base
3.0-3.3), 14.2 / 3.9 µs (base 14.3 / 3.7). Memory: none (the modules ~1% smaller in machine code).

**Counted code unchanged:** Alpine's deterministic boot dumped by both cores: 319 modules each, all byte-identical,
2,651,076,469 steps each (`deterministic-modules.json`); tests/steps.txt didn't move.

**Tests.** `spin.c` has a ninth shape, `pure`: a loop of a register add with no memory access (the only kind where
V8 might keep a plain load of the word out of the loop for good); only an IRQ ends it (the handler moves ELR past the
loop once `done` is set; CPU 0 pings until it's out). It passes on QEMU TCG and hvf. Planted: polls on a region's
back-edge only (above: the spin test with 2^30-step chunks fails under the JIT); the looped regions' polls as plain
loads: **nothing fails**, under every mode and chunk, `pure` included (V8 reloads every four laps there): the atomic
loads are the memory model's guarantee, not a tested behavior. The spin tests (all modes, both chunk lengths) and
the polled differential, lockstep and corpus (1024 words a class) pass.

**The oracle side check** (its own commit, ce9a22a7): `xblock`'s 132 on TCG is QEMU's (docs/testing.md "System-level
oracles" already had it). `isb`'s exit 10 on TCG reproduces every run now (30 of 30: 5-8 stale calls of 8 after the
architected cross-modification sequence, MMU off) and passes 30 of 30 on hvf: a TCG difference, recorded there. On
hvf, `mmio`'s 11 was the known RAZ/WI of holes, and past it QEMU asserted on MMIO accesses with no syndrome (a
misaligned one, one with a writeback): its `-DHVF` build leaves those out and it passes on both; `watch` is a
`// window` test the host drives, which `oracle.sh` now skips; `debug`'s 2 is QEMU's hvf model of `OSLSR_EL1` (it
reads 0 where an ARMv8 PE reads 0x8), with a later failure (exit 120) behind it: docs/backlog.md. The committed
binaries didn't change.

CI, each alone, on the final tree: `scripts/ci.sh` (863 s), `scripts/ci-jit.sh` (283 s). Not run: `scripts/ci-debian.sh`
(no run loop or host change), `ci-usb.sh`, `ci-audio.sh`; Firefox's pages session (P4's).

## PERF loop 35: the block's end, Firefox's pages session and the final review (2026-11-17)

P4 of "Preemption without the budget" (PERF loops 30-35): the whole block measured on the JIT's real workload, the
final out-of-context review's findings fixed, every CI layer the area names run. Data: `bench/boot/results/perf35/`
(its README). docs/jit.md "Preemption (parallel SMP's polled code)", docs/testing.md "Spin tests".

**Firefox's pages session on the Mac.** Its old harness (a local script pointing at the pre-rename checkout and a
`.webpcsnap`) is now `bench/gpu/ab-mac.sh` (docs/benchmarking.md "Starting from a snapshot"): `bench/gpu/sway-mac.sh`
from `target/snapbench/pages.waarm64snap` (made again with `bench/gpu/warm-snapshots.sh firefox`, 292 s), each round
starting with the next arm, into `ab.sh`'s layout so that `bench/gpu/ab-summary.ts` reads it (which now also sums
Firefox's starts and the pages' loads, `pagesS`); `@<tree>` runs an arm from another checkout, which the base needed:
0ffa96ef's core is ABI 70, so it ran with 0ffa96ef's web/ (`../waarm64-base`). The snapshot loads into both (its
layout didn't change). ~225 s a session. Base 0ffa96ef (before loop 31) against b770bb20 (loop 34's end), 5 rounds
alternated, M4, macOS 26.6.2, Chrome for Testing 157.0.8103.78, nothing else on the dev VM or the Mac; medians, IQR,
[ranges]:

| | base | new | |
|---|---|---|---|
| Firefox's starts + the pages' loads (s) | 76.8, IQR 1.3 [76.3-79.1] | 73.2, IQR 2.0 [72.2-75.8] | **−4.7%**, no overlap |
| the starts alone (s) | 57.4, IQR 1.0 [57.3-58.4] | 54.8, IQR 1.6 [54.3-56.4] | **−4.5%**, no overlap |
| busy MIPS (the vCPUs' timeline) | 407, IQR 1 [404-410] | 421, IQR 3 [417-425] | **+3.4%**, no overlap |
| the heavy pages' loads, wiki / bbc (s) | 5.6 / 6.6 | 5.2 / 6.3 | −7% / −5% |
| Gsteps interpreted | 3.35 | 3.27 | −2.4% |
| DSB waits for TLBI IS (ms a session) | 639, IQR 22 | 107, IQR 15 | −83% |
| stalls of 20 ms+ | 2 | 0 | |
| modules / wasm MB / emit ms | 2826 / 135 / 2080 | 2866 / 135 / 2123 | +1.4% / 0 / +2.1% |

The gates moved ~1-2% over the block (loops 31-34, within their spread each time); the browser moves more, and its
largest single change is the DSB waits: a TLBI IS's issuer waited for each target's chunk end before, ~640 ms of a
session; now its target stops at its next poll (decision 3's bound). Memory: none (the renderer's RSS wasn't sampled on the Mac).

**The final review** (`review/perf-preempt-final`, deleted with this loop): four findings, all fixed.
1. *A cycle with no poll through a region's cross-page edge* (medium). `block::forward` takes a member in another page
   by the VA it was queued at, whatever PA that VA maps, and the edge polled only when the target's VA was at or
   before its block's: with one physical page at successive VAs, a region whose head at 0x800 reaches a member at
   0x100 of the next VA page (a lower key) that chains forward in VA back to the head's key runs up through the
   aliases with no poll. *Confirming test, failing first:* `spin.c`'s `xpage` (three variants, 32 aliases each; MMU
   on, EL1 and EL0): on b770bb20's core 0-1 of 8 pings inside the shape in every variant (the test wants 4). Whether
   the region forms depends on when each block reaches the compile threshold (the dispatcher counts the same-page
   branch into the head only now and then): alone (`SPIN_ONLY`), about one run in three formed it; after the other
   shapes every variant did, in each of 3 runs. *Fix:* polled code also polls a region's edge whose target key isn't
   above its block's (`(to.key & !3) <= (b.key & !3)`, known when compiling; chains' keys move with their VA): along
   unpolled transfers to fixed targets the key now only grows. After: 7-8 of 8. Planted (the condition removed):
   0-1 of 8 again. Polls per 1000 steps (`counts-*.json`): smp1 68.9 → 68.9, smp4 67.9 → 67.6, smp-user4 76.6 → 77.9
   (Lua 83.9 → 85.2, SQLite 89.9 → 93.2: user processes' pages are scattered in PA). Static counts of a parallel
   boot's modules (`codestats.json`): arm64 instructions +0.2%, frame memory operands +0.1%; x64 +0.3%, +0.2%, inside
   two dumps' run-to-run spread (+0.5%, PERF loop 34): no Mac A/B.
2. *The stop word inside `&mut Vcpu`* (low): other threads store to `jit::State::stop` while the vCPU's thread holds
   `&mut Vcpu`, outside Rust's aliasing rules. Documented at the field, not restructured: every Rust access is atomic
   (compiled code's are wasm, which the core's compiler doesn't see); moving it to `CpuPar` would add a pointer load
   to every poll, and a run loop on a raw `*mut Vcpu` would rewrite `vm::parallel` and `jit::steps` for no behavior.
3. *The polled differential test passed every run that stored into code* (low): such a run returned before
   comparing, and the JIT side's RAM wasn't resynced. Now only a run whose interpreter stored into code is skipped;
   one where only the JIT's side did fails; both resync. Planted (a polled store writing a byte into the code area
   too): the old harness passed 3 of 3 memory classes, the new one fails them; unplanted, the polled core passes all
   179 classes at 1024 words.
4. *Nits:* `emit::returned` no longer updates `left` in polled code (Alpine's deterministic boot: 319 modules
   byte-identical with b770bb20's, the same steps, `deterministic-modules.json`); `vm_set_chunk`'s doc names ABI 71's
   long chunks; `tests/spin.test.ts`'s count of shapes.

tests/steps.txt didn't move.

CI, each alone, on the final tree: `scripts/ci.sh` (960 s), `scripts/ci-jit.sh` (290 s; the spin tests in every mode,
the polled differential, lockstep and corpus), `scripts/ci-debian.sh --platform` (614 s, 20 of 20), `scripts/ci-usb.sh`
(9 s, 9 of 9 through the rigs), `scripts/ci-audio.sh` (47 s, 6 of 6). Not run: `oracle.sh` on the new `xpage` shapes.

## HOST: the host code's A/B (2026-11-20)

The HOST track (fixes, allocations and splits in `web/*.ts`: no core change, one core for both arms) against the tree
before it. A = `3c6a5e38` (../waarm64-base), B = `19c9a66d` (main), each serving its own `web/`; `bench/run.ts --page
bench/boot/index.html`, the arms alternated per round (AB, BA, …); dev VM (8 vCPUs, 18 GiB), Chromium 155.0.8059.84,
headless. JSON: `results/HOST-ab/` (`<arm>-<bench>-r<round>.json`; A's `dirty` is an untracked directory). Per-round
medians:

| Metric | A (6 rounds) | B (6 rounds) | B against A |
|---|---|---|---|
| `smp_user_jit_n4_total` ms | 12594–12995 | 12551–15493 | −0.5% (median of rounds), overlapping |
| `smp_user_jit_n4_sqlite` ms | 1916–2055 | 1888–2090 | +0.5%, overlapping |
| `smp_user_jit_n4_lua` ms | 2433–2828 | 2460–2937 | +4.5%, overlapping (both arms bimodal: 2.4–2.5 s or 2.8–3.0 s) |
| `smp_user_jit_n4_compress` ms | 1381–1517 | 1410–3730 | +2.9%, overlapping (B's 3730: one sample of 6068 in round 1, while a static review agent read files) |
| `smp_user_jit_n4_churn` ms | 1048–1125 | 1042–1152 | +0.6%, overlapping |
| `boot_alpine_jit_total` ms (3 rounds) | 4865–5012 | 4890–5092 | −1.0%, overlapping |
| `boot_alpine_jit_mips` (3 rounds) | 529–545 | 521–542 | overlapping |
| `gl_virgl_jit_frame` ms (3 rounds) | 0.8 | 0.8 | −1.1%, B's rounds all below A's |
| `gl_virgl_jit_warm` ms (3 rounds) | 8.8–9.2 | 8.6–8.8 | −1.8%, overlapping |

No regression past the noise, and no speedup either on these workloads, where the host's code is a small share: the
guest's own time dominates. The one separation is the virgl frame (the device side's submit path: VirglStats by
number, CallQueue.pass's reused sets), small. `fio` and `net` ran in B only (A's `target/` is a symlink out of its
worktree, which Vite's strict serving refuses): they pass, unpaired. The allocation changes (per packet, per TD, per
WebHID report, the agent's frames) were not measured: no benchmark here drives them hard enough to show.

## PERF loop 36: host returns that landed elsewhere, a region's followed calls (2026-11-21)

The backlog's "Host returns that land elsewhere than the call's continuation" (PERF loop 28: 10-16% of the userspace
phases' host returns go to the miss function with a valid entry). Raw: `results/perf36/` (README).

**Counted** (a diagnostic core: a histogram of each such return's RET, continuation, PC and the code around them;
`bench/boot/userprof.ts` in Node). Returns elsewhere per phase: boot 1.57M, compress 1.82M, Lua 1.61M, churn 0.83M,
SQLite 1.03M, shutdown 0.46M. The top entries are pairs, e.g. compress's (772,718 and 504,624): F calls G with BLR (a
host call, expecting F's continuation), G calls a leaf L with BL, and L's `ret` lands in F's frame; then G's `ret`
lands in the frame of F's caller. One host frame was missing: G's call to L wasn't a host call. G's region had
**followed** that call (`block::forward`: the callee taken as a member, the BL a `br`, its `ret` predicted to return
to the member after the call), but the callee could leave the region before its predicted return: here L's `ret` had
no member to return to (the continuation wasn't taken); in Lua's and SQLite's pairs the callee was too long and its
code left the region by a chain. Leaving is a tail call at the region's depth, so the callee's `ret` is a `ret_up`
to the region's caller, one frame early, which doesn't match there; that frame goes to the miss function, and every
frame above it in turn (the cascade loop 28's host-call loop half-undid). Tallied: followed calls per phase compress
3.30M, Lua 8.64M, SQLite 6.64M; exits from inside them 0.66M, 3.11M, 2.84M; `ret_up`s of a followed callee with no
prediction (the leaf's case) compress 0.78M; with a wrong one (loop 28's "mispredicted internal return") under 15K
anywhere.

**Bound**: each return elsewhere is a miss-function call (an instruction-TLB probe, the jump cache, the entry's fill,
an indirect call) and a frame lost; ~7.3M in the userspace run, at ~15 ns each on the Mac ~1% of it, more if the lost
frames' later returns cost too.

**Built: a region follows a call only if its callee can't leave the region** but by its predicted return
(docs/jit.md "Calls"): after the walk, a member taken inside a followed call that branches to a block not taken,
branches indirectly or ends on a `ret` with no member to return to makes the innermost call it is in a host call
(its continuation taken as an entry), and the walk runs again until none is open (`forward`, `walk`,
`Region::open_call`). Emission is unchanged. Counted with the rule (`diag-fix-marks.json`): returns elsewhere boot
74K, compress 5K, Lua 15K, churn 31K, SQLite 11K, shutdown 22K (−95 to −99.7%); miss-function calls compress 2.12M →
0.31M, Lua 1.84M → 0.23M, SQLite 1.50M → 0.38M, boot 4.77M → 3.19M; host calls +23-28%; followed calls −93 to −97%
(nearly every followed callee had some exit). Arms by size: `block::forward` 1,236 → 4,735 bytes (the walk inlined
into it), `Walk::visit` 2,354 → 2,585.

`bench/interp/ab-mac.sh` on the Mac (M4, Chrome for Testing 158.0.8127.36), base 3d71d489, base first in rounds 1
and 3, fix first in round 2, ms:

| | base r1 · r2 · r3; median | fix r1 · r2 · r3; median |
|---|---|---|
| `alpine_jit_total` | 3,833.8 · 3,943.8 · 3,950.3; **3,943.8** | 3,806.3 · 3,837.4 · 3,852.7; **3,837.4** (−2.7%) |
| `alpine_user_jit_total` | 10,383.2 · 10,597.3 · 10,619.2; **10,597.3** | 10,264.3 · 10,333.2 · 10,361.2; **10,333.2** (−2.5%) |
| compress | 1,502.7 · 1,529.4 · 1,542.5; 1,529.4 | 1,495.0 · 1,499.5 · 1,497.5; 1,497.5 (−2.1%) |
| Lua | 2,568.3 · 2,609.5 · 2,605.0; 2,605.0 | 2,565.8 · 2,581.1 · 2,580.3; 2,580.3 (−0.9%) |
| SQLite | 1,892.0 · 1,916.7 · 1,914.0; 1,914.0 | 1,871.4 · 1,897.9 · 1,884.4; 1,884.4 (−1.5%) |

The userspace total's rounds don't overlap (fix's slowest 10,361 under base's fastest 10,383); the boot's do by one
round (base's first, 3,833.8, inside fix's range), the fix faster in every round (−0.7, −2.7, −2.5%). The steps are
the same (2,650,367,147 and 10,431,311,691). Compile side, per run: wasm 12.12 → 11.73 MB in the boot (−3.3%), 16.60 →
15.94 MB in the userspace run (−4.0%), modules 312 → 310 and 547 → 534; `emitNs` 173-176 → 169-170 ms and 240-244 →
228-233 ms; `compileNs` the same (50-51, 76-80 ms); dispatches −2.3%. Memory: less (the code), nothing kept besides.
Static counts (`codestats.json`, Alpine's boot, 7,230 → 7,220 functions): arm64 instructions −2.0% in all, −1.8% per
function, frame memory operands −1.8%; x64 −1.7% in all, −1.5% per function, frame operands −2.8%. Kept. Not measured
in Firefox's pages session (no block's end changes; the same rule in polled code).

Left: callees that complete inside the region are host calls now too when they have any exit (Lua's 5.5M of 8.6M
followed calls had completed inside); keeping them needs every exit from inside a followed call to be a host call to
the pending continuation, bound ~0.5% by the counts (docs/backlog.md "Followed calls whose callee completes inside
the region").

**Tests**: `jit::block` "a callee that can leave the region is called" (a callee whose callee branches out: the inner
call a host call, the outer followed with its return predicted; a `ret x1`: neither followed) and the forward test's
case without the block after the call (now 4 blocks, the callee called). Planted, each failing a test: `open_call`
never finding one; a `ret` never leaving; the walk ignoring the calls not to follow; branches never leaving. No step
count moved. CI: `scripts/ci.sh` (620 s) and `scripts/ci-jit.sh` (256 s) pass.

## PERF loop 37: the review of region formation, fixed (2026-11-21)

An out-of-context static review of loop 36's region formation (`block::forward`, `walk`, `Region::open_call`, the
emitter's calls and returns) left seven findings. Raw: `results/perf37/` (README). Each was checked against the code
with a unit test in `jit::block` that failed on 10882a61 first:

1. **A second call to a callee taken was a `br` with no prediction** (confirmed): the emitter made any BL to a later
   member a branch, and the walk, finding the callee's VA taken, took neither it nor the call's continuation; the
   callee's `ret` compared X30 with the first call's return and went `ret_up`, one frame early. Now a call is followed
   only through the call that took the callee (`Region::follows`; the emitter, `module`'s links and `open_call` all
   decide by it), every other BL is a host call, and its continuation is taken. Test: "a second call to a callee taken
   is a host call".
2. **A callee branching into a block taken outside it could leave unseen** (confirmed): `open_call` knew each member
   only by the call that first took it. Now where each followed call's code runs is a fixpoint over the region's
   edges (a predicted return carries on in its call's caller only when it matches that call; a `ret` reached inside a
   call it doesn't predict leaves). Test: "a callee that leaves through a block taken elsewhere is called" (a shared
   tail-call target; a callee tail-calling another call's callee).
3. **Recursion to the head was a loop back-edge** (confirmed): `block::region` followed a BL to its target, so a
   self-recursive entry headed a loop region with `bl` its back-edge, and a forward region whose callee called the
   head (across pages) became `looped()`, without entries. A BL is no edge in `region` now (`branches`), and a BL to
   the head is a host call by 1. Test: "recursion to the head is called".
4. **`open_call` ignored checked edges** (confirmed): an edge inside a followed callee that checks its member's
   mapping chains out when the check fails. It leaves now, and so does a followed call's own checked edge (its
   fallback is a host call) when the continuation it then returns to is checked or not a member. Tests: "a callee
   with a checked edge is called", "a checked call whose continuation is checked is called in a call".
5. **Loops through calls have no entries** (true, a docs and design finding): `for (…) f(x);` is a forward region with
   an edge back to its head, so `entries()` gives none. Written in docs/jit.md "Continuations are entries"; a counted
   backlog entry ("Entries for loops through calls").
6. **`member` ran before the dedup and again on every re-walk** (confirmed): `take` now checks the VA (and a near key)
   first, and `Cache::plan` asks whether a block outside the batch heads a loop once per batch (a memo). Test: the
   second-call test counts `member`'s calls (5, was 6).
7. **Docs** (confirmed): docs/jit.md said both region kinds stay in one page, and that a failed predicted return is an
   indirect branch (at depth > 0 it is `ret_up`, also when only the edge's budget or page check fails); the
   `forward` comment contradicted itself. Corrected.

**Counted** (loop 36's diagnostic ported, `results/perf37/diag.py`; Alpine's userspace benchmark in Node): returns
elsewhere boot 74K → 58K, compress 5K, Lua 15K, churn 31K → 30K, SQLite 11K (the same), shutdown 22K → 20K;
miss-function calls the same (boot 3.19M → 3.18M, the phases within 0.3%); followed calls −7 to −19% (boot 0.73M →
0.68M, Lua 0.28M → 0.23M, SQLite 0.21M → 0.17M); host calls +0.1-0.2%; a followed callee's `ret_up` past its
prediction (tally 13) churn 3K → 1K. So the cases were real but rare in Alpine: the fix is for correctness of the
rule, not a speedup.

`bench/interp/ab-mac.sh` on the Mac (M4, Chrome for Testing 158.0.8127.36), base 10882a61, base first in rounds 1
and 3, fix first in round 2, ms:

| | base r1 · r2 · r3; median | fix r1 · r2 · r3; median |
|---|---|---|
| `alpine_jit_total` | 3,712.8 · 3,814.6 · 3,830.1; **3,814.6** | 3,806.3 · 3,810.0 · 3,847.3; **3,810.0** (−0.1%) |
| `alpine_user_jit_total` | 10,135.3 · 10,307.7 · 10,322.1; **10,307.7** | 10,274.5 · 10,299.1 · 10,386.2; **10,299.1** (−0.1%) |
| compress | 1,474.0 · 1,500.1 · 1,497.6; 1,497.6 | 1,472.5 · 1,490.7 · 1,486.7; 1,486.7 (−0.7%) |
| Lua | 2,525.0 · 2,574.2 · 2,586.5; 2,574.2 | 2,587.6 · 2,589.3 · 2,591.3; 2,589.3 (+0.6%) |
| SQLite | 1,859.0 · 1,891.2 · 1,875.6; 1,875.6 | 1,877.9 · 1,878.0 · 1,886.1; 1,878.0 (+0.1%) |

No difference: the rounds overlap in every row, all within 1%. Steps the same (2,650,367,147 and 10,431,311,691).
Compile side: wasm 11.73 → 11.69 MB in the boot, 15.94 → 15.90 MB in the userspace run (−0.3%, −0.2%), modules 310 →
308 and 534 → 532; `planNs` 42-43 → 45 ms and 58-59 → 61 ms (+4%: the fixpoint, after the memo and the dedup took
their share), `emitNs` (which includes it) 165-170 → 171-173 and 227-232 → 235-236 ms; `compileNs` the same (50,
77 ms); dispatches +0.1% and −0.3%. Memory: nothing kept (the memo lives for one `plan`). Static counts
(`codestats.json`, Alpine's boot, 7,220 → 7,225 functions): arm64 instructions per function +0.0%, frame memory
operands −0.1%; x64 +0.1% and −0.0%. The measured fix arm lacked the last rule of 4 (a followed call's checked edge);
the final core's modules of Alpine's boot are the measured arm's (the same 315, two of them differing in 32 and 45
bytes of embedded addresses). Kept.

**Planted**, each failing a test: the emitter ignoring `follows` (4 tests); the walk not taking a host call's
continuation when the callee is taken (2); the fixpoint not propagating a branch (2); a `ret` matching any call's
return (1); checked edges staying (1); `region`'s loop pass following a BL (1); `take` asking `member` for a VA
taken (1); a followed call's checked edge never leaving (1). `tests/jit.test.ts`'s forward region (two calls of one
function) now makes three functions of 10 blocks, not two of 7: its second call is a host call to the callee compiled
as a head, through the dispatcher until that batch is emitted (8,336 dispatches, the same for 4× the turns). No step
count moved. CI: `scripts/ci.sh` (663 s) and `scripts/ci-jit.sh` (261 s) pass.

## PERF loop 38: the decoded blocks' budget, measured (2026-11-21)

The backlog's "The core's heap, after the bound" asked whether the decoded blocks' budget (`interp::block::BUDGET`,
16M micro-ops shared out among the tables: 4M, 32 MiB of arena, a table on 4 vCPUs) should follow the heap's room
instead of being fixed. Measured, not built. Firefox's pages session from a fresh `pages.waarm64snap` (cda6cfa7's
core) on the Mac (M4, Chrome for Testing 158.0.8127.36), `MEMLOG=5`, three rounds, the first arm alternating:
`d1` main with a diagnostic (`results/perf38/diag.patch`: each vCPU's decoded-block counters in the page's status,
and a table's clear for its keys rather than its arena counted apart), `d2` the same with `BUDGET` doubled (8M a
table). Raw: `results/perf38/` (README). (`bench/gpu/sway-mac.sh` now passes `MEMLOG` to the Mac, and
`bench/mem/probe.ts` skips smaps where there is no /proc.)

**Where the memory is** (each session the same within 1 MiB; at the heap's live maximum): live 315 MiB, of it the
decoded blocks 206 (four tables, ~50 MiB each: arena 32, map 17, its page index ~1; vCPU 0's 58), the block map 55
(1.48 M keys, no prune), known blocks 9, the rest 45; the mark 315-329 MiB of the 1 GiB reserve. **Every table fills
its arena** three times in the session (12 clears, all for the arena; ~0.75 M blocks a fill, ~5.5 micro-ops each;
11.0-11.4 M decodes).

| | `d1` (4M a table) r1 · r2 · r3 | `d2` (8M a table) r1 · r2 · r3 |
|---|---|---|
| decoded blocks at most (MiB) | 206 · 206 · 206 | 302 · 302 · 302 |
| heap live at most; mark (MiB) | 315 · 315 · 315; 329 · 320 · 315 | 411 · 411 · 411; 411 · 412 · 411 |
| clears (of them for the keys) | 12 · 12 · 12 (0) | 7 · 6 · 6 (all) |
| blocks decoded (M) | 11.00 · 11.21 · 11.36 | 8.87 · 8.45 · 8.26 (−24%) |
| Gsteps interpreted | 3.18 · 3.17 · 3.17 | 3.15 · 3.13 · 3.15 (−0.8%) |
| JIT cache lock acquisitions (M) | 15.58 · 15.75 · 15.90 | 13.71 · 13.28 · 13.17 (−15%) |
| Firefox's starts and the pages' loads, `pagesS` (s) | 75.1 · 73.5 · 74.4; **74.4** | 75.2 · 74.4 · 72.6; **74.4** |
| starts (s) | 56.8 · 55.3 · 56.3 | 56.7 · 55.9 · 54.6 |
| busy MIPS | 447 · 450 · 452 | 449 · 448 · 454 |
| wiki / bbc load (s) | 5.9 · 5.7 · 5.5 / 5.8 · 6.0 · 6.2 | 6.0 · 5.8 · 5.7 / 5.8 · 5.8 · 5.9 |

(r1 ran `d1` first, r2 `d2`, r3 `d1`; no stalls ≥ 20 ms in any.) With 8M a table the map's 900,000 keys start it
over before the arena's 64 MiB (vCPU 0's arena stayed at 32 MiB).

- **More room buys nothing measured**: 96 MiB more heap for a quarter fewer decodes, and every speed row's rounds
  overlap (`pagesS` the same median). What the 2.7 M re-decodes cost is small beside the session's 3.2 G
  interpreted steps (0.8% more of them interpreted, and the lock trips of the misses' reports). The other direction has its number already: 2M a
  table was 3.5% slower on Chromium's renders in the guest (bench/apps/REPORT.md "M8: the decoded blocks' arenas").
- **Less use gives nothing back**: an arena that never fills holds only what it decoded (Alpine on 1 vCPU, ~1M
  micro-ops of 8M), and the heap's allocator keeps what it frees, so the tab pays the heap's mark: a budget that
  followed the heap's room could only raise it.
- **Dropped**: the budget stays fixed; the finding is in docs/jit.md "The core's heap", the backlog sub-item removed.
  No core change, no step count moved.

## PERF loop 39: the block map's page index, measured (2026-11-21)

The backlog's "The core's heap, after the bound" had the page index without lists (`jit::PageIndex`: a table of pages,
a list of 2-byte keys a page) as its next item, on the premise that the table and the list headers matter where pages
hold a key or two. Measured, not built. A diagnostic core (`results/perf39/diag.patch`: gauge words 8-15 with the
index's parts, recounted every 4,096 keys added and after a prune; on 3cfc1834) from `target/snapbench/pages.waarm64snap`
on the Mac (M4, Chrome for Testing 158.0.8127.36), `MEMLOG=5`, one session each (loop 38's three sessions agreed within
1 MiB): Firefox's pages session (`bench/gpu/ab-mac.sh`) and the run-once churn (`PHASES=churn
CHURN='rate=300&calls=120&n=2' CHURN_S=600` through `bench/gpu/sway-mac.sh`, which now passes `CHURN` and `CHURN_S`
on). Raw: `results/perf39/` (README); `indexsum.json` from `indexsum.ts`.

| at the heap's live maximum | pages session | run-once churn |
|---|---|---|
| heap live; mark (MiB) | 314.9; 315.4 | 310.4; 333.2 |
| keys; block map with index (MiB) | 1.48 M; 55.1 | 1.40 M; 55.6 |
| **the index** (MiB) | **5.12** | **5.62** |
| its lists (MiB; bytes a key) | 4.04; 2.87 | 3.76; 2.83 |
| its table of pages (MiB; pages) | 0.78; 25,049 | 1.56; 29,527 |
| the allocator's 8 bytes a list; the regions' heads (MiB) | 0.19; 0.11 | 0.23; 0.07 |
| keys a page; pages with 1 key; with 2-4 | 58.8; 515; 1,383 | 47.2; 956; 2,531 |
| guest ICs in the session; of them on a page with keys | 0.53 M; 7,696 | 24.6 M; 0.31 M (5 prunes) |

(In wasm a `Vec` header is 12 bytes, a bucket of the table of pages 25; the backlog's 33 and 24 were the native sizes.
The pages session's speed was as loop 38's: `pagesS` 73.3 s, busy MIPS 451.)

- **The premise doesn't hold**: pages hold ~50 keys, 2-3% one; the table of pages and the headers are ~1-1.8 MiB, the
  rest is the keys themselves (2 bytes and the lists' doubling slack).
- **The bound**: lists threaded through `Info` (a 2-byte next key per entry, as the decoded blocks' map does, with
  `Info`'s three flags packed into a byte to keep it 16 bytes) and a table of 17-byte buckets (a page's first key)
  would leave ~0.5 MiB: at most ~4.5 MiB saved, 1.4% of the pages session's mark; in the churn the mark is set when
  the index is 3.3 MiB (below), so ~3 MiB, 0.9%. The heap is a small part of the tab (guest RAM alone is 2.5 GiB).
  It would need an `IC IVAU` that unlinks a linker from the middle of another page's chain, and a prune that threads
  the chains again: out of proportion. The lookup the backlog asked for, a cheap test of whether a page has keys, is
  what the index is already: 1.4% of the pages session's 0.53 M guest ICs and 1.3% of the churn's 24.6 M found keys
  (one hash probe for the rest).
- **What sets the mark** (found on the way): in the churn the mark rose from 315 to 333 MiB between two samples where
  the block map's table went from 2^20 to 2^21 buckets (28 → 53 MiB with its index) after the first prune, the old
  table and the new one live together; a prune rebuilds the table to fit (`shrink_to(0)`), so every prune's regrowth
  doubles it again near the heap's maximum. In the pages session (no prune) the doubling came at 0.92 M keys with the
  heap at 284 MiB and the mark is its live maximum. Filed: docs/backlog.md "The block map's table kept across a prune"
  (up to ~23 MiB of the churn's mark).
- **Dropped**: the finding is in docs/jit.md "The core's heap"; the backlog sub-item replaced by that follow-up. No
  core change, no step count moved.

## PERF loop 40: the block map's table kept across a prune (2026-11-21)

The backlog's "The block map's table kept across a prune" (loop 39's finding): a prune rebuilt the table to fit
(`shrink_to(0)`), so in the run-once churn the keys growing back doubled it again near the heap's maximum. Built: the
table keeps its buckets, and the prune rehashes it in place. Diagnostic gauges (`results/perf40/diag.patch`: the
block map's reserves that rehashed in place or resized, with their ns, and its tombstones) on 87a8dd52, from
`target/snapbench/pages.waarm64snap` on the Mac (M4, Chrome for Testing 158.0.8127.36), `MEMLOG=5`: `d0` main, `d1`
the `shrink_to(0)` removed, `d2` the kept change. The run-once churn (`CHURN='rate=300&calls=120&n=2'`, 600 s) in the
order d0 d1 d1 d0 d2 d0 d2; Firefox's pages session two rounds alternated each for d0/d1 and d2/d0. Raw:
`results/perf40/` (README); `memsum.json` from `sum.ts`.

| the run-once churn | `d0` main (3 sessions) | `d1` the shrink removed (2) | `d2` kept, rehashed (2) |
|---|---|---|---|
| heap mark (MiB) | 333.1 · 333.2 · 333.2 | 328.7 · 312.6 | **312.6 · 312.9** |
| heap live at most (MiB) | 310.7 · 310.7 · 310.6 | 309.8 · 309.8 | 310.7 · 310.6 |
| the mark set at | 90-95 s (the doubling after the first prune) | 15 s | 15-20 s (the first doubling, before any prune) |
| prunes; ms each (`pruneNs`) | 5; 36.9 · 34.8 · 36.3 | 7; 42.4 · 41.6 | 5; 35.7 · 35.2 |
| rehashes on demand; their ms in all | 0 | 3 · 4; 28.7 · 42.1 | 0 |
| tombstones at most | 0.34-0.36 M (the ICs') | 1.45-1.55 M | 0.35-0.36 M |

- **The mechanism holds**: main's table went 2^21 → 2^19 at each prune and doubled back; at the 2^20 → 2^21 doubling
  after the first prune the old 25 MiB and the new 50 lived together and the heap's top grew: the mark 333 MiB.
  Kept, the mark is what the pages session's is: the table's first doubling (at ~0.95 M keys, 15 s in, before the
  churn prunes), 313 MiB, −20 MiB. Where that doubling lands in the heap's free space moves it by up to ~15 MiB
  (one `d1` session 329, the pages sessions 315-329 in every arm).
- **Removing the shrink alone isn't enough**: a prune comes only with the table full at 2^21 buckets (at
  `MAP_KEYS`, or the tombstones' guard), so the dropped keys leave tombstones, not empty buckets (1.5 M of them): every
  probe longer (the prune's own page-index pass among them: 42 ms instead of 36) and no room, so the guard pruned
  early (7 prunes instead of 5) and reserves rehashed on demand (~10 ms each). Kept: the prune reserves the room past
  the tombstones, which hashbrown does as a rehash in place while that's at most half the table's
  (`reserve_rehash`); a prune then takes what main's did (35 ms: the rehash replaces the rebuild). Where a prune
  keeps almost nothing (tests/heap.test.ts's guest of `b .+4` in Node, 6 prunes, two runs each alternated) the
  rehash of the 2^21 buckets costs more than rebuilding a table of the few kept keys: 27.0-29.7 ms a prune against
  19.6-22.6; the mark the same there (111 MiB).
- **The pages session** (no prune) is unchanged: marks 315.4-320.2 (`d0`, 4 sessions), 320.3-320.5 (`d1`),
  315.6-328.7 (`d2`), live at most 314.8-314.9 in all; `pagesS` 72.8-74.0 s (`d0`), 71.1-73.3 (`d1`), 73.2-73.8
  (`d2`), busy MIPS 449-459.
- **The page's gauge**: with tombstones, `HashMap::capacity` leaves them out, and the table's bytes counted from it
  read 2^19 buckets for a 2^21 table; they're counted now from the most keys the table has held since it was
  allocated (`Cache::map_full`).
- **Speed** (the gate screen, `bench/interp/ab-mac.sh`, `results/perf40/screen.json`), base 87a8dd52, base first
  in rounds 1 and 3, ms:

| | base r1 · r2 · r3; median | kept r1 · r2 · r3; median |
|---|---|---|
| `alpine_jit_total` | 3,796.4 · 3,850.5 · 3,847.7; **3,847.7** | 3,826.3 · 3,832.5 · 3,844.9; **3,832.5** |
| `alpine_user_jit_total` | 10,270.4 · 10,360.6 · 10,356.8; **10,356.8** | 10,300.4 · 10,342.6 · 10,372.8; **10,342.6** |

  The rounds overlap: no change (neither prunes). Arms by size: `Jit::miss` (the prune inlined) 12,076 → 11,308
  bytes. No step count moved.
- **Kept**: docs/jit.md "The core's heap" says what exists and why; tests `a_prune_keeps_the_table` (the table's room
  after each prune past 2^20 buckets' and within 2^21's: fails with the shrink back and with the rehash left out) and
  `the_map_bytes_count_tombstones` (fails with the bytes from `capacity` and with `room` not tracking the most); the
  backlog sub-item removed.

## PERF loop 41: the block map's constants, measured; its bound halved (2026-11-21)

The backlog's "The core's heap, after the bound", "Not tuned": `KEEP_HITS` (16), `RECENT_TICKS` (262,144 keys),
`WARM_TICKS` (2 M), the prune's target (half of `MAP_KEYS`), `MAP_KEYS` (1.5 M) and the decoded blocks' `MAX_KEYS`
(900,000) had been set from the heap's budget and one A/B. Counts first: a diagnostic core (`results/perf41/diag.patch`
on 54507cfd: at each prune the keys by class, which retain it fell to, the keys dropped; Bloom filters of the dropped
keys, so the ones added again before the next prune and those of them that reached the threshold), then clean arms.
All on the Mac (M4, Chrome for Testing 158.0.8127.36), from `target/snapbench/pages.waarm64snap` (cda6cfa7's core),
`MEMLOG=5`: Firefox's pages session (`bench/gpu/ab-mac.sh`, 3 rounds, the first arm alternating) and the run-once
churn (`CHURN='rate=300&calls=120&n=2'`, 600 s). Raw: `results/perf41/` (README); `memsum.json` from `sum.ts`.

**What decides what, at main's 1.5 M keys:**
- **The pages session never prunes** (1.48 M keys at most, 1.65 M added): none of `KEEP_HITS`, `RECENT_TICKS`,
  `WARM_TICKS` or the half do anything there. `MAP_KEYS` decides the table: 2^21 buckets once past 0.92 M keys.
- **The run-once churn prunes 5 times**, each from 1.49 M keys to its second retain (the needed and the recent keys:
  ~67,000 and ~147,000; the warm ones, 0.76 M a prune, would pass the half): the warm rule never applies. Of 26.7 M keys
  added, 1.2 M are dropped keys added again; 2,100 of those reached the threshold. Its keys run a few times by design:
  what the rules keep changes nothing there.
- **`MAX_KEYS` never binds**: every decoded-block clear in both sessions is for the arena (loop 38: ~0.75 M blocks a
  fill, under 900,000); the table is at 2^20 buckets either way (0.75 M > 2^19's 458,752). Keeping it at 2^19 would
  need clears at ~60% of the arena, a smaller budget in effect (the half cost 3.5% on Chromium's renders: bench/apps/REPORT.md
  "M8: the decoded blocks' arenas"). Left.

So `MAP_KEYS` is the one that can matter, and it's the table's size: tried at 900,000 (2^20 buckets, `d1`), 450,000
(2^19, `d2`), and 900,000 with the prune's second retain keeping the needed and the warm keys instead of the recent ones
(`d3`).

| diagnostic arms, the pages session | `d0` 1.5 M | `d1` 900,000 | `d2` 450,000 | `d3` 900,000, warm first |
|---|---|---|---|---|
| prunes (ms each, the diagnostic's own taken out) | 0 | 7-8 (22-24) | 22 (11) | 8 (27) |
| of them to the third retain (the needed alone) | | 5-7 | 22 | 0 (all to needed + warm) |
| keys added (M); dropped keys added again (M) | 1.65; 0 | 6.2; 3.5 | 9.0; 3.1 | 5.3; 1.8 |
| of those, reached the threshold | | 55,000 | 58,000 | 6,400 |
| Gsteps interpreted | 3.15-3.17 | 3.51-3.55 | 3.86-3.97 | 3.26-3.29 |
| heap live at most (MiB) | 322.8 | 295.4-295.9 | 278.8-282.0 | 295.9-296.1 |
| `pagesS` (s), first A/B: d0 · d1 | 74.6 · 74.2 · 73.9 | 72.8 · 73.3 · 72.7 | | |
| `pagesS`, second A/B: d1 · d2 · d3 | | 76.8 · 73.6 · 72.4 | 73.0 · 72.2 · 73.9 | 74.6 · 73.7 · 72.8 |

(The diagnostic's Bloom filters take 8 MiB and its prune a `Vec` of the dropped keys, so its marks are high; the clean
arms' are below.) At 900,000 the recent keys alone are ~440,000 a prune (those reported, not added, in the last 262,144
keys added), more than the half, so a prune keeps the needed ones only; 12% more steps run interpreted and the speed
doesn't move (the first A/B even had `d1` ahead, the second not). Keeping the warm keys first brings the re-added keys
and the interpreted steps back most of the way and isn't faster either. At 450,000 its half (225,000) is near what a
busy cache needs kept (past it a prune flushes), for 16 MiB more: not taken.

**The clean arms** (`c0` main, `c1` `MAP_KEYS` 900,000 with the table's bound `MAP_BUCKETS` 2^20):

| | `c0` main | `c1` 900,000 |
|---|---|---|
| pages session: mark (MiB) | 315.1 · 315.3 · 315.4 | **288.1 · 288.9 · 288.1** (−27) |
| heap live at most; block map at most (MiB) | 314.8-314.9; 55.1 | 287.5-288.0; 28.3-28.5 |
| prunes (ms each) | 0 | 7-8 (23.6-24.4) |
| `pagesS` (s) | 71.8 · 72.8 · 71.3; **71.8** | 72.4 · 73.4 · 71.9; **72.4** |
| busy MIPS; wiki / bbc load (s) | 452 · 457 · 457; 5.5-5.9 / 5.5-5.9 | 454 · 456 · 458; 5.7-5.9 / 5.7-5.9 |
| run-once churn (2 sessions, c1 c0 c0 c1): mark (MiB) | 313.1 · 311.1 | **285.3 · 283.6** (−27) |
| heap live at most (MiB); prunes (ms each) | 310.7 · 310.6; 5 (36.2 · 35.8) | 283.1 · 283.2; 13 · 15 (20.7) |

Every speed row overlaps (`pagesS` +0.8% in the medians, within the session-to-session spread; no stalls ≥ 50 ms in
any). The churn makes the same 179,850 functions in every session (it's rate-bound: memory, not speed). Prunes under
the cache's lock: 0.19 s in 10 minutes of the churn before, 0.29 s now.

**The gates** (`bench/interp/ab-mac.sh`, `results/perf41/screen.json`; base first in rounds 1 and 3; ms):

| | base r1 · r2 · r3; median | 900,000 r1 · r2 · r3; median |
|---|---|---|
| `alpine_jit_total` | 3,846.3 · 3,850.3 · 3,851.1; **3,850.3** | 3,857.9 · 3,855.7 · 3,865.0; **3,857.9** (+0.2%) |
| `alpine_user_jit_total` | 10,332.8 · 10,347.3 · 10,370.3; **10,347.3** | 10,298.3 · 10,344.6 · 10,379.7; **10,344.6** |

The boot's rounds don't overlap but differ by 0.2%, under the floor; neither guest gets near 900,000 keys. Arms by
size: `Jit::miss` 11,308 → 11,307 bytes. No step count moved.

- **Kept**: `MAP_KEYS` 900,000, the table at most `MAP_BUCKETS` (2^20 buckets, 25 MiB; a `const` assert ties the
  two): the heap's mark 27 MiB lower in both sessions at the same speed. `KEEP_HITS`, `RECENT_TICKS`, `WARM_TICKS` and
  the half stay as they are: in these sessions the prune falls past the warm rule (and at 900,000 in the pages session
  past the recent one too), and what keeping more brings back measured no faster.
- **Tests**: tests/heap.test.ts's 320 MiB guest checks the block map at most 32 MiB with its page index (was 64): with
  the old bound back it fails at 54 MB. Its safety-net test runs in 48 MiB instead of 64: in 64 the block map's
  table now finds room and only the decoded blocks' maps started over (9 rescues, no flush); in 48, 24 rescues and 12
  flushes. The native tests take the bound from `MAP_BUCKETS`.
- docs/jit.md "The core's heap" has the bound and the finding; the backlog sub-item removed.

## Lazy NZCV at loop heads, counted (2026-11-21)

From the introduction's captures (web/intro-captures/blocks.json): the byte-sum loop (`ldrb w9, [x0], #1; subs x1,
x1, #1; add w8, w8, w9; b.ne`) computes and stores NZCV on every lap, though nothing on the lap reads it. A loop's
head is never lazy (M5 step 8.4: the function starts from memory), and a head counts as needing NZCV in memory when
anything before its first setter could want it, a load's or store's slow arm included (`Func::touched`; a head that
sets flags first, like the Collatz capture's, takes its back-edges without a store). So the back-edge of nearly every
loop that touches memory before its first setter pays the store for a cold path. Explored in a cloud session
(x86_64 container, Node v26.13.1, Chromium 153.0.8010.12): counts and machine code, **no speed claim** (docs/cloud.md:
this host can't rank builds). Patch, tools and data: `results/flagx/` (README).

- **How often** (a diagnostic core, two tallies at the edges; per 1000 guest steps): edges that stored NZCV for a
  member where only cold paths (slow arms, failure chains) need it before its first setter, and the other storing
  edges (a hot reader, a helper, an FP instruction's slow arm, a block with no setter):

| | back-edges | forward edges | stored, cold only | stored, other |
|---|---|---|---|---|
| bench/interp's EL1 guest (Node; MMU on and off the same) | 127.2 | 112.6 | 16.5 | 0.0 |
| Debian's boot on the page, 1 vCPU: Linux, EFI stub to login (10.35 G steps) | 25.7 | 102.2 | 16.0 | 7.0 |
| the same run's firmware (11.55 G steps) | 91.2 | 105.4 | 45.9 | 43.6 |

- **What a store costs** (TurboFan, x86-64, `results/flagx/loops-x64.txt`): the byte-sum loop is 54 instructions a
  lap, 29 with the store off the lap (a core that calls such a head's flags dead: unsound, a bound). The AArch64
  capture has the same lines (about 15 instructions and, on Linux, a bounds check and the store). At 16 a 1000 steps
  that is some 0.3-0.4 host instructions a guest step in a Linux boot. Liftoff runs every one of them too.
- **A paired A/B of that bound** in Node (`results/flagx/tools/paired.mjs`, arms side by side, 40 iterations of 100 M
  steps; percent over the base, median [quartiles]; the A/A arm says how much this host resolves): the integer guest
  +4.5 [2.2, 8.7] and +5.6 [3.2, 10.8] at two placements (A/A +0.6 [−2.6, 3.3], +2.1 [−3.8, 5.6]), at EL1 +3.9
  [1.8, 8.1] and +2.1 [0.0, 7.1] (A/A +1.1, +0.4), the FP guest +13.2 [8.5, 15.8] (A/A −0.3 [−5.3, 3.7]). A second
  run of 30 gave the same signs with wider quartiles. Suggestive, not a measurement: the Mac's gates decide.
  Debian boots to its login on the page with it.
- **The branch outcome at a loop's exit** (`TAKEN`): the Collatz capture's lap is 15 host instructions on AArch64
  for 7 of the guest's, 3 of them the outcome made a 0/1 value (`cset; tst; cset`) and a repeated compare, because
  the exit reads the outcome from a local that then lives across the loop. Computing a lazy B.cond's outcome again
  at the exit (`takenx`) takes x86-64's four unrolled laps from 63 instructions to 51; it changes nothing in the
  other captured loops (the byte-sum loop keeps its `setnz`: an exit use the prototype didn't reach), and its paired
  A/B is inside this host's noise (−1.7 to +0.9, A/A −2.8 to +1.3). Not counted: how many laps have that shape.
- **Not built.** A sound form keeps the store off the lap and has the cold paths store NZCV when it is pending: a
  head state "lazy on the back-edges, in memory from the entry", a local saying which, set on the edges and tested
  in the slow arms, the failure chains and any exit before the head's first setter (the failure chains' class of
  rule: a planted bug each, the differential test's region classes). docs/backlog.md "JIT" has both entries.

## PERF loop 42: lazy NZCV at a loop's head, bounded on the Mac: dropped (2026-11-21)

The backlog's "Lazy NZCV at a loop's head" (the entry above, "Lazy NZCV at loop heads, counted") in its order: the
patch's tallies on the gates' guests and Firefox's pages session, then its unsound bound (`--features flagx`: a head
whose flags only cold paths want before its first setter counts them dead, so its back-edges store no NZCV) on the
Mac. `results/flagx/experiment.patch` applied unchanged on baf10886 (after loops 36 and 37); this loop's additions
(tallies of the branch outcome's shape, for the entry after it) are in `results/perf42/diag.patch`. Raw:
`results/perf42/` (README).

**Counts** (per 1000 guest steps; the gates' guests in Node on the dev VM, the pages session on the Mac, 97.9 G steps):

| | back-edges | forward edges | NZCV stored, cold only | stored, other | `TAKEN` laps: lazy B.cond, other (back-edges) | the same, forward in a loop |
|---|---|---|---|---|---|---|
| Alpine's boot (`boot_alpine_jit`) | 19.5 | 107.3 | **11.0** | 4.2 | 13.5, 5.1 | 12.4, 10.9 |
| Alpine's userspace (`alpine_user_jit`) | 12.5 | 113.7 | **6.9** | 4.0 | 9.1, 3.1 | 11.8, 6.1 |
| of it: compress · Lua · churn · SQLite | | | 11.3 · 1.0 · 6.2 · 9.3 | | | |
| Firefox's pages session | 12.6 | 133.7 | **6.9** | 5.7 | 9.4, 3.1 | 17.6, 11.0 |

The cold-only stores are as frequent as the cloud session counted in Debian's boot (16) and the small guests (16.5):
7-11 a 1000 steps on the gates and the pages session.

**The bound** (Mac M4, Chrome for Testing 158.0.8127.36; `results/perf42/screen.json`, base first in rounds 1 and 3;
ms):

| | base r1 · r2 · r3; median | flagx r1 · r2 · r3; median |
|---|---|---|
| `alpine_jit_total` | 3,807.4 · 3,867.6 · 3,857.6; **3,857.6** | 3,848.7 · 3,838.1 · 3,861.2; **3,848.7** (−0.2%) |
| `alpine_user_jit_total` | 10,300.2 · 10,328.9 · 10,362.1; **10,328.9** | 10,359.6 · 10,341.5 · 10,346.8; **10,346.8** (+0.2%) |

Firefox's pages session (`bench/gpu/ab-mac.sh`, 3 rounds, the first arm alternating; `results/perf42/pages-summary.txt`):
`pagesS` base 73.5 · 72.3 · 73.1 (**73.1**), flagx 73.5 · 73.5 · 72.5 (**73.5**); busy MIPS 450 · 458 · 453 (**453**)
against 456 · 454 · 457 (**456**). Every row overlaps. The arms differ where they should: the flagx core's wasm is
0.23% (boot) and 0.29% (userspace) smaller, its `emitNs` 1-2% higher (the patch's second `touched`).

- **Dropped.** Taking the store off every such lap, unsoundly and so at no cost to the cold paths, gains nothing the
  Mac's gates or the pages session can see: the cloud session's +2-5% on x86-64 Node was that host's noise or
  x86-64's alone. At 7-11 laps a 1000 steps and ~25 instructions a lap (the x86-64 count), the store is ~0.2-0.3 host
  instructions a guest step, none on the loop's dependence chain (NZCV computed from the flag locals and stored,
  nothing reads it back): on the M4 it costs no measurable time. The sound form (a head
  state lazy on the back-edges and in memory from the entry, a local saying which, tested on every cold path before
  the first setter) would add that test to the cold paths and a flag state to review; not built.
- **The branch outcome kept across a loop**, decided by its counts with it: 9-13.5 back-edges a 1000 steps leave a
  member whose lazy B.cond's outcome lives in `TAKEN` (the shape the `takenx` prototype reaches), 12-18 more forward
  edges in loops. At the 3 host instructions a lap the Collatz capture showed, that is a tenth of the bound above,
  which measured nothing: dropped, not built.
- No core change, no step count moved. The findings are in docs/jit.md "Tried and not kept"; both backlog entries
  are removed.

## PERF loop 43: the review of the block map and the heap's bounds, fixed (2026-11-21)

An out-of-context static review after loop 42 (`review/jit-heap.md` on the deleted `review/jit-heap` branch) ranked
seven findings. Each was checked against the code and hashbrown 0.17.1 / dlmalloc 0.2.14 (std's, in the pinned
nightly's `rust-src`), confirmed by a test failing on 84ed7551 where it was real, then fixed. A test hook in the core's
allocator (`crate::test_heap`, `cfg(test)`: the bytes growing allocations asked for on the thread, and a full heap that
fails them until a free of 1 MiB) lets the native tests check what allocates.

| finding | verdict | test (fails on 84ed7551) | fix |
|---|---|---|---|
| 1. off by one at `grows_past`: a 2^20 table with no room and exactly 458,752 keys doubles | real (`reserve_rehash_inner` rehashes in place only at `items + 1 <= full / 2`), for the decoded blocks' map too | `a_full_table_at_half_its_keys_prunes` (doubled to 1,835,008), `decoded_keys_at_half_start_over` (3,584) | prune (start over) with no room at **at least** the half, the table at its bound (`map_full`, the decoded blocks' new `full`, more than half of it held); `a_half_table_grows_to_the_bound` keeps a 2^19 table's growth |
| 2a. the prune's `shrink_to` of the page index's and links' tables allocates infallibly | real for the tables (0.5 MiB in the test's prune); the lists' `shrink_to_fit` isn't (dlmalloc shrinks in place) | `a_prune_takes_no_memory` | the tables kept, as the map's |
| 2b. the page index grows with no `try_reserve` | real: a new page's list traps (`memory allocation of 8 bytes failed`) | `a_page_index_without_room_rescues` (aborted) | `room` reserves the new key's page entry and list place (`PageIndex::reserve`), rescuing if not; `room` runs for new keys only |
| 2c. `install` / `tier_up` file keys and links outside `room` | real, latent (members are keys the map holds but in the forced mode) | | docs/jit.md "Not covered", a backlog entry (count first) |
| 3. gauges under-count tombstones elsewhere; `invalidate` doesn't publish the keys | real | `the_page_index_bytes_count_tombstones`, `the_known_bytes_count_tombstones`, `the_decoded_bytes_count_tombstones`, `the_key_gauge_follows_an_ic` | every table counted from the most it held with its room since allocated; `publish_keys` at an IC |
| 4. tests/heap.test.ts's safety net doesn't show the block map rescued | real (`rescues` sums three) | | counter word 121 `mapRescues` (ABI 72); the 48 MiB run: 12 of the block map's of 24 |
| 5. the map's u8 clock wraps between far-apart prunes | real | `the_map_clock_does_not_wrap_into_recent` | a u16 clock (`Info` stays 16 bytes) and a prune clamps the ages it keeps to `WARM_TICKS`; prunes ~9,000 keys apart when a prune can't rehash: real, not seen (docs) |
| 6. a key-count flush doubles the threshold's floor | real, intended | | stated in docs/jit.md |
| 7. stale comments and docs (2^21; a key per slot; "counts from zero") | real | | corrected |

**Measured** (Mac M4, Chrome for Testing 158.0.8127.36; `base` 84ed7551, `fix` this commit, both from
`target/snapbench/pages.waarm64snap`, `MEMLOG=5`; arms checked by size: `Jit::miss` 11,307 → 11,708 bytes,
`interp::block::Cache::miss` 5,870 → 5,941). Raw: `results/perf43/` (`pages-summary.txt`, `pages-mem.json`,
`churn-mem.json` from `sum.ts`, loop 41's; `screen.json`).

| | base | fix |
|---|---|---|
| pages session (3 rounds, first arm alternating): `pagesS` (s) | 73.2 · 72.3 · 71.5; **72.3** | 71.6 · 72.2 · 73.2; **72.2** |
| busy MIPS; Gsteps interpreted | 459 · 460 · 457; 3.54-3.58 | 459 · 455 · 451; 3.52-3.55 |
| heap's mark; live at most; block map at most (MiB) | 288.0-288.9; 287.5-287.6; 28.2-28.4 | 288.2-288.4; 287.4-287.7; 28.2-28.5 |
| prunes (ms each) | 9 · 9 · 7 (22-24) | 7 · 7 · 9 (23-25) |
| run-once churn (fix base base fix, 600 s): mark; live at most (MiB) | 285.0 · 285.4; 283.2 · 283.2 | 286.2 · 285.6; 283.8 · 283.7 |
| block map at most (MiB); prunes (ms each) | 28.3; 15 (20.3-20.4) | 29.0; 15 (20.8-21.2) |
| `alpine_jit_total` (ms; base first in rounds 1 and 3) | 3,812.2 · 3,852.5 · 3,865.4; **3,852.5** | 3,861.2 · 3,850.5 · 3,855.9; **3,855.9** |
| `alpine_user_jit_total` (ms) | 10,312.7 · 10,346.0 · 10,333.7; **10,333.7** | 10,347.0 · 10,380.1 · 10,360.5; **10,360.5** (+0.25%) |

The pages session is the same in every row. In the churn the block map counts 0.7 MiB more (the page index's tables
kept across prunes, and now counted whole) and the heap's live maximum is 0.5 MiB higher; prunes the same count and
time. The user-mode gate's rounds don't overlap by 0.25%, under the floor; the boot's overlap. In Node,
tests/heap.test.ts's 320 MiB guest prunes 12 times at 16.1-17.5 ms (base) and 16.5-18.0 (fix). No step count moved.

**Planted bugs** (each caught, the source restored, the wasm rebuilt): the old `n > half` (both maps:
`a_full_table_…`, `decoded_keys_at_half_…`); `n >= half` without the table's size (`a_half_table_grows_to_the_bound`,
`decoded_keys_at_half_…`, `decoded_keys_are_bounded`); no age clamp (`the_map_clock_…`); no page reservation in `room`
(`a_page_index_without_room_rescues` aborts); the links' `shrink_to(0)` back (`a_prune_takes_no_memory`); no
`map_rescues` count (`a_rescue_frees_the_maps`; tests/heap.test.ts too).

## PERF loop 44: the core's heap over 15 minutes of real sites (2026-11-21)

The backlog's "The core's heap, after the bound", "The user's own session wasn't replayed": the crash of "M8: the core's
heap bounded" came after 15 minutes of the desktop guest on real sites (Firefox's, then Chromium's) and one flush.
That session, replayed with the bounds as loops 40-43 left them: main's core at 732f9498, booted from
`target/arch/desktop.qcow2` (Arch Linux aarch64 with sway; Chromium 156.0.8078.79 and Firefox 160.0 in the guest, the
image `images/arch/desktop.sh` makes), 4 vCPUs, 2.5 GiB, the 320 MiB JIT budget, online through `tests/net/tailcat.sh`'s
exit node (`TAILCAT=rig PHASES=sites`), the six default sites (a YouTube watch page, the Guardian, CNN, the BBC's
news, Excalidraw, Google Maps) 30 s each, five times through (900 s), `MEMLOG=5`. One session in the guest's Chromium
(`GUEST_BROWSER=chromium`, new: the sites phase drove only Firefox), one in its Firefox. On the dev VM (Chromium
155.0.8059.84): the tailcat rig runs there, and `bench/gpu/sway-mac.sh` doesn't pass it to the Mac; the heap's gauges
are the core's own accounting, the same on either host. Raw: `results/perf44/` (README; `sum.ts`).

| | Chromium in the guest | Firefox in the guest |
|---|---|---|
| visits; the sites' phase (s) | 30; 906 | 30; 910 |
| heap live at most (MiB; when, s) | **283.7** (815) | **293.0** (765) |
| heap's mark (MiB) | **284.5** | **295.4** |
| of the live maximum: decoded blocks · block map · known blocks · held · the rest | 198.1 · 29.3 · 8.5 · 0.0 · 47.7 | 198.1 · 29.3 · 17.0 · 0.0 · 48.6 |
| block map's keys at most | 896,720 | 899,078 |
| prunes (ms each) | 57 (28.5) | 52 (29.6) |
| flushes; rescues; `mapRescues`; lag flushes | 0; 0; 0; 0 | **1** (845 s, the byte budget); 0; 0; 0 |
| JIT live bytes at most (MiB); wasm compiled (MB) | 217.4; 233 | 317.8; 475 |
| decoded-block clears; ICs | 161; 19,384 | 173; 100,725 |
| guest MIPS a pass through the sites (180 s each) | 460 · 449 · 406 · 438 · 480 | 605 · 386 · 463 · 422 · 433 |

- **Within the budget, nothing aborted.** The block map stops at its 900,000 keys in both and prunes every ~16 s
  (1.5-1.6 s under the cache's lock in 15 minutes); the heap's live bytes stay flat from the second minute on
  (281-284 MiB in Chromium; 280-293 in Firefox, whose known blocks' table doubled once, 8.5 → 17 MiB, with the code
  this epoch compiled before its flush), its mark within 2.5 MiB of the live maximum: no table doubles beside its old
  one, the crash's path. Firefox's session flushed once at 845 s, the crash's moment: the heap's live bytes fell 3.5
  MiB and stayed below their maximum after it. The decoded blocks are the largest part (the 128 MiB arena and four maps, loop 38's
  fixed budget); the rest (devices, jump caches, stacks) 48 MiB.
- **Nothing slowed over the session**: the guest's MIPS a pass through the sites shows no trend (Firefox's first pass
  holds its start); no slow commands, every visit made. The only warnings were virgl's video decoder giving
  up on 1-8 pictures at YouTube's page in both (a decoder warning, not the heap).
- **What the run doesn't cover**: a session longer than one flush, Chromium's at the point its budget fills (217 of
  320 MiB at 15 minutes); the module install's growth outside the bound (the other sub-item of the backlog entry)
  isn't seen in any gauge here (the block map never passed its 900,000 keys).
- No core change; the tool change: `bench/gpu/firefox-load.ts`'s sites phase takes `GUEST_BROWSER=chromium`, and
  `firefox/sites.html` logs through the console where there's no `dump()`. The backlog sub-item is removed.

## PERF loop 45: memory 0 holds a whole 3 GiB of RAM (2026-11-21)

The user's request: memory 0 held at most 3071 MiB (`MAX_MEMORY0_RAM` = 4 GiB − `HEAP_FLOOR` − 1 MiB), the MiB kept
for the scratch page and fw_cfg's files outside the 1 GiB heap reserve. Now the reserve holds them, as it holds the
core's static data and stack: `MAX_MEMORY0_RAM` = 3 GiB, and a fixed memory is RAM + the reserve (web/vm.ts
`fixedPages`), exactly 65536 pages at 3072 MiB whatever fw_cfg's files (the heap gets at most ~1 MiB less than
before at that size). The RAM slider's 3 GiB no longer stands for 3071 MiB (`stands` removed from ui/Slider.svelte);
the introduction's memory deep dive at 3 GiB shows memory 0 full and no 1 MiB memory 1, its words say "3 GiB", and its
slider has a notch at 3 GiB. Machines of more than 3071 MiB on the automatic split get the new layout (node 1 now at
5 GiB, the boundary past RAM's end at 4 GiB); their older snapshots refuse to restore (the memory differs), which the
user accepted; machines of 3071 MiB or less, or with a split set by hand, are unchanged (docs/machines.md §5.1).

- Tests: tests/core-wasm.test.ts (`fixedPages`: 65536 pages at 3 GiB; the split's numbers), tests/heap.test.ts (a boot
  in Node with 3 GiB of RAM, with 960 KiB of fw_cfg files and without: a 4 GiB memory, the exact core, an 896 MiB
  allocation in the heap; 3073 MiB grows), tests/page-intro.test.ts (3 GiB is one full bar). The old formula planted
  back failed both of the first two; restored.
- The real run: tests/page-spill.test.ts now runs Debian on the page with `?split=3072,1024,512`: memory 0 at
  2^32 bytes (`__waarm64Heap`'s new `memoryBytes`), the DT's memory nodes at 0x40000000 (size 0xc0000000),
  0x140000000 and 0x1c0000000 (node 0's reg 0xbfe00000 bytes: 3 GiB less the firmware's 2 MiB DTB space), MemTotal
  node 0 2,986,676 kB, node 1 1,032,176 kB, node 2 505,984 kB, the snapshot reloaded in a fresh profile.
- CI: `scripts/ci-fast.sh`, `scripts/ci.sh` (1907 passed), `scripts/ci-debian.sh` (15 of 15), `scripts/ci-machines.sh`
  (14 passed, 1 skipped).
- `tests/steps.txt` didn't move (the test guests are small).

## PERF loop 46: what an epoch's modules keep alive (2026-11-22)

The backlog's "V8's per-function overhead" left one question: whether superseded or invalidated blocks' modules stay
alive through sibling functions (V8 frees a module's code only with all its instances), which larger modules make
likelier. Measured, not built. How it works now: within an epoch the slots are bump-allocated (`Cache::alloc`) and
never reused, and `web/jit-host.ts` writes every installed function into the table and nulls slots only when a flush
starts them over; modules import the functions they chain to (`t`). So every function of the epoch stays alive until
the flush, whatever its siblings: the question is how much of it is dead. A diagnostic core
(`results/perf46/diag.patch`, README) sampled each epoch's modules: the functions the block map no longer names (a
head or an entry), of them the loop heads compiled alone that tiered up, and the modules with every function unnamed
(freeable if no named module imports them, transitively) or some.

| run (functions at the last sample) | modules, wasm | unnamed functions | of them tiered-up heads | invalidated share in live modules | modules all unnamed, freeable |
|---|---|---|---|---|---|
| Alpine's boot, 1 vCPU (5,377) | 308, 11.1 MiB | 581 | 383 | 0.32 MiB | 3, < 0.01 MiB |
| Alpine's userspace, 1 vCPU (7,802) | 534, 15.2 MiB | 553 | 536 | 0.02 MiB | 3, < 0.01 MiB |
| `smp_alpine_jit`'s boot, 4 vCPUs parallel (5,155) | 293, 9.5 MiB | 457 | 302 | 0.26 MiB | 0 |
| `smp_user_jit_4` (9,397) | 548, 16.1 MiB | 513 | 513 | 0.02 MiB | 0 |
| Firefox's pages session on the Mac, 4 vCPUs (55,208) | 2,768, 109.1 MiB | 3,907 | 3,665 | 0.57 MiB (0.5%) | 2, 0.05 MiB |

(The Alpine runs in Node, `results/perf46/alpine.json`; the pages session from `pages.waarm64snap` on the Mac, M4,
Chrome for Testing, one session with `MEMLOG=10`, 7,706 ICs and no flush, `results/perf46/pages/`; an earlier session
without the tiered split gave the same counts within 2%, `pages-first/`. The invalidated share is a module's bytes
times its invalidated functions over its functions.)

- **What's unnamed is nearly all tiered-up heads** (94% in the pages session, 97-100% in the userspace runs), and they
  aren't dead: the head's prologue tail-calls the region through its hot word, and blocks linked to the head call it
  directly (docs/jit.md "Compile policy", tier-up). Freeing one would mean relinking its callers, which are compiled
  code in immutable modules.
- **The dead (invalidated) code is 0.5% of the pages session's wasm** and 0.1-3% of Alpine's; modules whose every
  function is dead are ≤ 0.05 MiB. So nulling invalidated slots on the host would free ≤ 0.05 MiB of wasm (~0.5 MiB
  of V8 memory at its ~10×), and even modules of one function, which cost ~16 KB each besides their functions (docs/jit.md
  "Memory"), could free at most the 0.57 MiB of invalidated code (~6 MiB) while adding ~16 KB to every module.
- **The element segment** (the entry's other lever: the table written by the module, no exports object, ~1.7 KB an
  instance a table: "M8: V8's GC on the vCPU threads") bounds at 2,768 modules × 4 tables × 1.7 KB ≈ 19 MB of the
  renderer's 5.1-5.4 GiB in this session; not built.
- **Dropped**: no change. The finding is in docs/jit.md "Memory" ("What an epoch keeps alive"); the backlog entry is
  removed.

## PERF loop 47: counter reads from the step clock; the gates' timer rate (2026-11-22)

The backlog's two adjacent entries: the deterministic runs' counter reads, each an exit to the run loop (PERF loop 8),
and the gates' timer reprogramming rate against the guest's HZ. Raw: `results/perf47/` (the diagnostic counts
`counts-base.json` and `counts-new.json`, the Mac A/B's JSON, the static counts `codestats.json`).

**Counts** (a diagnostic core: `bench/boot/preempt-counts.ts boot user`, which now tallies round-robin chunk ends too,
the virtual timer's arming, the IRQs and the platform exits by register; Node on the dev VM, deterministic, 1 vCPU):

| | boot (2.65 G steps) | userspace (10.43 G) | compress / Lua / churn / SQLite |
|---|---|---|---|
| counter-read exits | 307,868 (28% of chunk ends) | 1,204,864 (36%) | 232K / 361K / 74K / 247K |
| steps a counter read | 8,609 | 8,658 | 8,769 / 8,892 / 7,288 / 8,653 |
| CNTV_CVAL/TVAL armed | 41,555 | 166,020 | 32,556 / 51,424 / 8,687 / 34,215 |
| steps a write | 63,780 | 62,832 | 62,499 / 62,500 / 62,503 / 62,502 |
| timer IRQs taken | 42,060 | 166,780 | as the writes |
| platform exits: ICC read / ICC written / timer CTL, CVAL, TVAL | 42K / 42K / 208K | 167K / 167K / 830K | |

**The timer rate is the guest's HZ.** One arming and one IRQ per 62,500 steps is one per millisecond of guest time at
62.5 MHz and a tick a step: Alpine's linux-virt ticks at HZ=1000 and the busy CPU takes every tick (NO_HZ_IDLE).
Each tick costs seven platform exits (ICC_IAR1, ICC_EOIR1, five CTL/CVAL accesses), not the ~10 ISBs (inline since
loop 8). Fewer ticks per step would need a guest-visible change (CNTFRQ, `ticks_per_insn`), which moves every step
count: not done. The timer registers' five exits are a backlog follow-up (docs/backlog.md "The gates' timer register
accesses inline").

**What was built** (docs/jit.md "Counter reads from the step clock"): in counted code an `MRS CNTVCT_EL0/CNTPCT_EL0`
reads `jit::State::ticks.end - (left - k)`: the run loop stores the counter as of the chunk's end (the VM's steps, the
chunk's *n*, the ticks WFI skipped) before each chunk, and `left` at the member's entry less the *k* instructions
before the read is what the chunk still has to run. One load, a test, a subtraction; the helper's exit while `end` is
0 (realtime, `ticks_per_insn` other than 1, the xHCI with an event due) and at EL0 without CNTKCTL_EL1's enable. 8
bytes a vCPU; no ABI change (the field is the `State`'s last, so nothing else moved). Steps don't move: Alpine
2,650,367,147 and the userspace benchmark 10,431,311,691 as in tests/steps.txt. Counter-read exits after: 3,692 (boot)
and 3,667 (userspace), the reads in code still interpreted. Node (dev VM, diagnostic core, one run each): boot 4.72 →
4.62 s, userspace 11.78 → 11.50 s.

**The gates** (the Mac host, M4, Chrome for Testing 158.0.8127.36 headless; `bench/interp/ab-mac.sh`, one round a
call, the order base-new, new-base, base-new; ms, each round's median; base `e62cbb4c`):

| | base | new | |
|---|---|---|---|
| `alpine_jit_total` | 3,748 · 3,854 · 3,837; **3,837** | 3,724 · 3,735 · 3,777; **3,735** | **−2.7%**, every round's pair faster (−0.6, −3.1, −1.6%), rounds overlapping (base's first 3,748 against new's 3,777) |
| `alpine_user_jit_total` | 10,179 · 10,340 · 10,331; **10,331** | 9,970 · 10,025 · 10,084; **10,025** | **−3.0%**, rounds apart |
| compress / Lua / churn / SQLite (medians) | 1,485 / 2,587 / 751 / 1,886 | 1,430 / 2,496 / 729 / 1,827 | −3.7 / −3.5 / −2.9 / −3.1% |

The userspace run's ~0.3 s against 1.2M exits removed is ~250 ns an exit on the Mac (loop 8 estimated ~130). Compile
side, base → new: `emitNs` 168-173 → 171-174 ms (boot), 234-237 → 234-239 ms (userspace); `compileNs` 50 → 50 and 75
→ 75 ms; wasm bytes 11,690,221 → 11,690,440 (boot), 15,904,178 → 15,901,652 (userspace). Static code of the boot's 315
modules (`bench/jit/codestats.ts`, every function in TurboFan): arm64 instructions +0.1% (7,595,520 → 7,603,150), code
bytes +0.1%; x64 instructions +0.1% (5,987,201 → 5,994,072), code bytes +0.1%; stack slots and frame operands within
0.1%. Memory: 8 bytes a vCPU. **Kept.**

Tests: `tests/baremetal/counter.c` (the reads at a loop's head and further in, in a callee, after a forward edge, at
EL0 with and without the enable; a hash of every reading on the console, which the deterministic runs compare between
the interpreter and the JIT) and the emitter's `counter_reads_inline_from_the_step_clock`. Planted bugs: *k* dropped
(the hash differs, and the steps: 1,194,661 → 1,196,002); the EL0 check dropped (counter.c exit 3, timer.c); the
xHCI's condition dropped (the USB guest's JIT run 188,563,323 → 193,007,148 steps against the interpreter's). An inline
check of the host signal byte, as the unmask has, was built and dropped: planting it out changed nothing any test sees.
CI: `scripts/ci.sh` (its second run: the first found `system_register_reads` still expecting the counter read as a helper call) and `scripts/ci-jit.sh` passed.

## PERF loop 48: the review of the block map's bounds and RAM's layout, fixed (2026-11-22)

An out-of-context static review after loop 47 (`review/heap-ram.md` on the deleted `review/heap-ram` branch) ranked
six findings. Each was checked by a test failing first on 2e202705, then fixed. Raw: `results/perf48/` (the gate
screen's JSON, the pages sessions' memory logs and summary).

| finding | verdict | test (fails on 2e202705) | fix |
|---|---|---|---|
| 1. the decoded blocks' arena grows amortized from its first block's length, to anywhere up to twice its budget | real | `the_arena_stays_within_the_budget` (a budget of 1,000: 1,024 micro-ops for a first block of 2) | `interp::block::Cache::grow`: doubling, capped at the budget (`try_reserve_exact`) |
| 2. a member `install` files outside `room` can double the block map's table to 2^21 buckets, infallibly | real | `an_entry_filed_by_an_install_keeps_the_bound` (the table at 2^20 with one key's room, a miss's key, then a member: 1,835,008 keys' table) | `jit::Cache::entry`: a new member goes in only with room by `room`'s rule and a `try_reserve`, else it isn't filed (its block runs interpreted until compiled as a head) |
| 3. `linkers` lists keep dead and repeated keys for the life of their target | real | `linkers_drop_dead_and_repeated_keys` (1,001 linkers after 1,000 ICs and recompiles of one block) | `jit::Cache::link`: a list about to grow first drops the keys no longer compiled and its repeats, and grows only if that leaves it more than half full |
| 4. `Mem::host0`'s `ptr::add` past `isize::MAX` (2 GiB) on wasm32: undefined behaviour | real (std's precondition panics in a core built with `-Zub-checks=yes` and debug assertions: `panic_nounwind_fmt` from `Mem::write`) | tests/core-wasm.test.ts "RAM past 2 GiB in memory 0" (jit 0, 4, 1) under `WAARM64_WASM` = that core; the release core passes either way | `wrapping_add` (the bounds are checked just above) |
| 5. the firmware, kernel and initrd copied into memory 0 unchecked; `?ram=` unvalidated | real | tests/heap.test.ts "images that don't fit in RAM are refused" (`vm_boot rejected the Image or layout` for a 2 MiB firmware in 1 MiB); tests/config.test.ts `?ram=1`, `99999`, `1000.3`, `-5` | `bootVm` refuses images past RAM's end (`MsgError` `machine:vm.ramTooSmall`, its details the sizes); the page takes `?ram=` as the Machine menu's slider's nearest stop (256-16384 MiB in steps of 64): **clamped**, not refused, as the address's other sizes fall back rather than stop the page, and what runs is what the menu then shows |
| 6. docs contradicting the code | real | | spill-memories.md "The heap floor", abi.md, architecture.md, jit.md "The core's heap", web/ram.ts's comment: the bounds as the code sets them and loop 44's measured heap |

**Memory** (finding 1; the Mac M4, Chrome for Testing 158.0.8127.36, Firefox's pages session once an arm from
`target/snapbench/pages.waarm64snap`, `MEMLOG=5`; 4 vCPUs, 4 tables of a 32 MiB share each): the decoded blocks'
bytes at most (`decBytes`, arenas and maps) **206.1 → 198.1 MiB**; the heap's mark 288.4 → 280.8 MiB, its live bytes
at most 287.6 → 279.6; the block map 28.4 either way, 7 prunes, no rescue, no flush. That is one table's arena at 40
MiB in the base session, as a first block of 5·2^k micro-ops after the restore makes it (8 MiB more, one session
each); with the fix every arena stops at its 32 MiB share. `pagesS` 74.6 → 70.8 s in the one round each (not a claim).

**The gates** (`bench/interp/ab-mac.sh`, a round a call, base first in rounds 1 and 3; ms, each round's median; arms
checked by size: `jit::Cache::install` 11,680 → 10,879 bytes, `Jit::miss` 11,708 → 10,953 (`link` and
`PageIndex::reserve` out of line now), `interp::block::Cache::miss` 5,941 → 5,968, `Mmu::miss` 1,313 → 1,394 and
`Mmu`'s `read_el`/`write_el` +54 each (`Mem::host` inlined into them since `wrapping_add`); `hot` unchanged):

| | base | fix |
|---|---|---|
| `alpine_jit_total` | 3,676.6 · 3,764.2 · 3,784.3; **3,764.2** | 3,727.5 · 3,729.1 · 3,793.1; **3,729.1** (−0.9%, rounds overlapping) |
| `alpine_user_jit_total` | 9,898.7 · 10,043.3 · 10,113.6; **10,043.3** | 9,995.0 · 10,025.4 · 10,071.8; **10,025.4** (−0.2%, overlapping) |

Neutral: each round's pair differs either way (+1.4, −0.9, +0.2% boot). No step count moved.

**Planted bugs** (each caught, the source restored, the wasm rebuilt): the arena's growth without the cap
(`the_arena_stays_within_the_budget`); `entry` without `room`'s rule (`an_entry_filed_…`); `link` without its pass
(`linkers_drop_…`); the pass without its growth (the same test: a list of 7 live keys of 8 would pass again at the
next push); `host0`'s `add` back (the RAM-past-2-GiB test, under the checked core); `bootVm` without the initrd's
check (heap.test.ts's "an initrd at 128 MiB"); `?ram=` unclamped (config.test.ts).

CI: `scripts/ci.sh` (its second run: the first found web/vm.ts unformatted), `scripts/ci-jit.sh` and
`scripts/ci-debian.sh` (its second run: the first's reload check typed `cat` at a serial login that came before the
boot's last status lines, which overwrote the files' output; tests/page-debian.test.ts now waits for
`systemctl is-system-running --wait` and clears the screen first) passed.

## PERF loop 49: the timer registers from the step clock (2026-11-22)

The backlog's follow-up of loop 47: Alpine's tick (HZ=1000, once per 62,500 steps) cost seven `Exit::Platform` exits
in the deterministic gates, five of them the virtual timer's CTL and CVAL. Raw: `results/perf49/` (the diagnostic
counts `counts-base.json` and `counts-new.json`, the Mac A/B's JSON, the static counts `codestats.json`).

**Counts** (the diagnostic core, `bench/boot/preempt-counts.ts boot user`, which now splits the timer registers'
exits by register and counts those that could have stayed inline: a chunk with a step clock, EL1, and for a write a
new state that fires nothing before the chunk's end; Node on the dev VM, deterministic, 1 vCPU):

| | boot (2.65 G steps) | userspace (10.43 G) |
|---|---|---|
| CTL read / CVAL, TVAL read | 83,035 / 0 | 331,983 / 0 |
| CTL written / CVAL, TVAL written | 83,035 / 41,555 | 331,983 / 166,020 |
| reads that could read the step clock | 83,035 (all) | 331,983 (all) |
| writes whose new state fires nothing before the chunk's end | 124,575 (all) | 497,988 (all) |
| of them, writes that change the timer's line | 41,478 | 165,961 |
| physical timer's accesses | 0 | 0 |

Per tick: CTL read and written (the handler's IMASK, which lowers the line), CTL read, CVAL written (62,500 ahead,
past the chunk's end: chunks are at most 32,768 steps) and CTL written (enabled). Every one could stay; the third
that lowers the line needs the GIC told before anything reads it. At loop 47's ~250 ns an exit on the Mac, the
bound was ~0.2 s of the userspace gate (~2%) and ~0.05 s of the boot's (~1.4%).

**What was built** (docs/jit.md "Timer registers from the step clock"): in counted code at EL1, MRS of CNTV_/CNTP_
CTL, CVAL and TVAL computes the platform's answer at the step clock's counter (`end - (left - k)`, loop 47's), and
an MSR stays in the block when `end` is set and the new state is disabled, masked, or has CVAL ≥ `end`; it sets
`StepClock::wrote`, and the run loop drives that vCPU's timer lines into the GIC when the chunk returns, before its
exit (an ICC_IAR1, an EOIR, ISR_EL1, a GIC MMIO access) and its next look for an IRQ. Otherwise the helper's exit as
before (realtime, `ticks_per_insn` ≠ 1, the xHCI with an event due, EL0, a write that would fire inside the chunk).
The timer MSRs no longer end a block. 4 bytes a vCPU, in the `State`'s padding (the TLB's 128-byte alignment kept
every offset: `Vcpu::tlb` stays at 1,664); no ABI change. Steps don't move: Alpine 2,650,367,147 and the userspace
benchmark 10,431,311,691, as in tests/steps.txt; IRQs taken and GIC exits identical (42,060 and 166,780). Timer
register exits after: 5,415 in each (the reads and writes in code still interpreted early in the boot); platform
exits 0.29M → 0.09M (boot), 1.16M → 0.34M (userspace). Node (dev VM, diagnostic core, one run each): boot 4.67 →
4.51 s, userspace 11.46 → 11.24 s.

**The gates** (the Mac host, M4, Chrome for Testing 158.0.8127.36 headless; `bench/interp/ab-mac.sh`, one round a
call, the order base-new, new-base, base-new; ms, each round's median; base `b166af24`):

| | base | new | |
|---|---|---|---|
| `alpine_jit_total` | 3,671 · 3,759 · 3,748; **3,748** | 3,745 · 3,751 · 3,726; **3,745** | −0.1%, rounds overlapping: neutral |
| `alpine_user_jit_total` | 10,032 · 10,036 · 10,058; **10,036** | 9,936 · 9,957 · 9,866; **9,936** | **−1.0%**, rounds apart, every pair faster (−1.0, −0.8, −1.9%) |
| compress / Lua / SQLite (round 3) | 1,441 / 2,509 / 1,845 | 1,405 / 2,466 / 1,794 | −2.5 / −1.7 / −2.7% |

Half the bound on the userspace gate: ~0.1 s against 0.82M exits removed, ~120 ns an exit (loop 47's estimate came
from the counter reads, whose exits return to a hotter path). The boot's 0.21M exits (~25 ms at that rate) are
under its noise. Compile side, base → new: `emitNs` 169-173 → 172-175 ms (boot), 237-238 → 236-239 ms (userspace);
`compileNs` 50 → 50 and 75 → 75 ms; wasm bytes 11,690,440 → 11,691,014 (boot), 15,901,652 → 15,902,225
(userspace). Static code of the boot's 315 modules (`bench/jit/codestats.ts`, every function in TurboFan): arm64
instructions 7,603,150 → 7,603,634, code bytes 28,882,744 → 28,884,544; x64 instructions 5,994,072 → 5,994,371, code
bytes 26,188,880 → 26,190,324; per function all within 0.1%. Memory: none (the flag sits in padding). **Kept.**
Only the deterministic gates gain: the page runs parallel SMP, whose timer and GIC registers stay exits.

Tests: `tests/baremetal/timerjit.c` (the physical timer armed a few hundred ticks ahead sets the chunk's end; the
virtual one armed 50 and 1 before it, at it, 1 and 50 after it and already due, through CVAL and TVAL, enabled
before or after the compare value; the counter at every IRQ and the registers' readings hashed to the console,
which the deterministic runs compare between the interpreter, the JIT and JIT-stress; a fired timer masked inline
then ISR_EL1 and ICC_IAR1 read with IRQs masked; passes on QEMU TCG and on the M4 through hvf, where a masked
timer's IRQ can come again while its line falls, so the oracles check only that each fired) and the emitter's
`timer_registers_inline_from_the_step_clock`. Planted: the run loop's line refresh dropped (exit 10, the ISR read);
the deadline condition dropped (the hash and steps differ; the JIT run hangs to its budget); `cval + 1 >= end`
(an off-by-one, the hash and steps differ under the JIT and JIT-stress); TVAL's *k* dropped (the hash differs);
TVAL's write zero-extended (the run hangs). The first version of the test read ISR_EL1 right after arming, an exit
that re-cut the chunk at the new deadline and hid the dropped condition (unmask.c caught it then); the read moved
to where the line must be low.
CI: `scripts/ci.sh`, `scripts/ci-jit.sh` and `scripts/ci-debian.sh` passed (each first run).

## PERF loop 50: followed calls whose callee completes inside the region, counted (2026-11-22)

The backlog's "Followed calls whose callee completes inside the region" (PERF loop 36's follow-up): a region follows
a call only if its callee can't leave the region, so a callee with any exit is a host call even on the runs that
return inside. Keeping those would need every exit from inside a followed call (a chain, an indirect transfer, a
by-VA link, a checked edge's fallback, an unpredicted `ret`) to be a host call expecting the pending continuation,
nested once per pending call. Counted first; **not built**: the bound is under the gates' floor. Raw:
`results/perf50/` (README).

**Counted** (a diagnostic core, tallies 14 and 15: a followed call run, a predicted return taken; a second core whose
`forward` keeps every callee its walk takes, `WAARM64_FOLLOW_ALL`; `bench/boot/preempt-counts.ts`, Node, the dev VM;
steps the same in both). What would become in-region: the predicted returns that following every callee adds, each
a host call and return today. Exits from inside a followed call stay one host call each in the design (made at the
exit instead of at the call), so only these count:

| | boot | compress | Lua | churn | SQLite |
|---|---|---|---|---|---|
| host calls today | 39.55M | 16.51M | 38.04M | 11.17M | 35.11M |
| followed calls today / completed inside | 0.85M / 0.70M | 0.18M / 0.14M | 0.23M / 0.17M | 0.20M / 0.16M | 0.17M / 0.13M |
| every callee followed / completed inside | 7.43M / 3.07M | 3.19M / 1.02M | 8.63M / 4.34M | 2.02M / 0.84M | 6.64M / 3.22M |
| **host calls that would go** | **2.37M** (6.0%) | **0.88M** (5.3%) | **4.16M** (10.9%) | **0.69M** (6.2%) | **3.09M** (8.8%) |

Fewer complete inside than loop 36 counted (Lua 5.5M of 8.6M then, 4.3M now): loop 37's rules (a second call to a
callee taken, checked edges) already take some of them out of following.

**A host call's cost** (`results/perf50/calls/`: f calls four leaves, followed in one guest and host calls in the
other, the leaves' work the same but for a few instructions; per round, scaled by the steps): on the Mac (M4, Node
26.10.0, 5 rounds alternated) 7,511 ns a round followed (56,006 steps) against 14,740 ns host-called (49,006 steps):
**~2.0 ns a call and its return** more than a `br` and a predicted return; on the dev VM the same 2.0 ns (11,567 against
18,329 ns). Little is live across these calls; a call with more registers in locals flushes and reloads more, so
say 2-4 ns.

**Bound**: at 2-4 ns a call, Lua 8-17 ms of its ~2.6 s phase (0.3-0.6%), SQLite 6-12 ms (0.3-0.7%), compress and
churn ~0.1-0.2%; the userspace gate 18-35 ms of ~10.3 s (**0.17-0.34%**), the boot 5-10 ms of ~3.8 s (0.13-0.25%).
Against it: the callees' code back in their callers' regions, wasm 10.8 → 11.3 MB in the boot (+4.6%) and blocks in
regions 21,505 → 21,935 (`userprof-diag*.json`), loop 36's 5-11 ms of `emitNs` a run back, before the code the
nested exits would add on every exit path inside a followed call. No arm could show a net gain past the ~1% floor,
and the design touches every way out of a region (the chains, the transfer cache's probe, the by-VA links, the
checked edges, `ret_up`, the stale-code checker's entries). Dropped: docs/jit.md "Calls" has the finding, the
backlog entry is removed. No code changed (docs, results and the microbenchmark); `scripts/ci-fast.sh` passed.

## PERF loop 51: a looped region's call continuations, counted (2026-11-22)

The backlog's "Entries for loops through calls" (the review after PERF loop 36): a forward region with an edge back to
its head (`for (…) f(x);`) is `looped()`, and `Region::entries` gives such a region none, so after anything that
unwinds inside `f` (a failed poll, an exit, the chunk's end) `f`'s return at depth 0 misses the transfer cache, the
dispatcher interprets the continuation, and the members after it, until the run reaches the head's compiled code again
or the continuation is compiled as a head of its own. Counted first; **not built**: the bound is under the floor.
Raw: `results/perf51/` (README).

**Counted** (a diagnostic core: each key's dispatches as its decoded block reports them to the cache, so a chain in the
block interpreter counts too; the keys filed at the looped region's install; Node on the dev VM, and one Firefox pages
session on the Mac). Interpreted dispatches and their steps:

| | boot | userspace (4 phases) | smp1 boot | smp4 boot | smp-user4 | Firefox pages |
|---|---|---|---|---|---|---|
| steps | 2,650M | 10,431M | 2,432M | 2,583M | 31,616M | 97,750M |
| continuations: dispatches / steps | 150K / 0.44M | 181K / 0.57M | 145K / 0.43M | 191K / 0.60M | 297K / 1.05M | 1.91M / 5.84M |
| later members: dispatches / steps | 249K / 1.08M | 305K / 1.34M | 258K / 1.10M | 295K / 1.29M | 541K / 2.62M | 3.70M / 16.3M |
| all interpreted steps (reported) | 133M | 179M | 132M | 142M | 232M | 3,552M |
| **share of the run's steps** | **0.057%** | **0.018%** | **0.063%** | **0.073%** | **0.012%** | **0.023%** |

The later members are an upper bound (a member can be reached interpreted from elsewhere too). PERF loop 48's rule
(`Cache::entry` declining a member under `room`) declined **none** in any run: the continuations counted are all of
the looped regions'.

**Bound**: an entry would save each such dispatch's round trip (the miss function back to the dispatcher, the
interpreted run, the head entered again: ~50-100 ns, a guess from a chunk end's ~0.2 µs, PERF loop 32) and the steps'
interpretation (~1.5 ns a step more than compiled code at the Mac's ~500 interpreted MIPS), one round trip per
continuation dispatch (the later members run on in the same interpreted run): the boot 10-17 ms of ~3.8 s
(0.3-0.45%), the userspace gate 12-21 ms of ~10.3 s (0.1-0.2%), Firefox's session 0.13-0.22 s of ~860 vCPU-seconds
(under 0.03%). Against it: a wasm `loop` has one way in, so an entry inside one needs a dispatch at the loop's top
(an entry local and a `br_table` on every lap, in every looped region with a call, including round-robin's counted
code) or the region's members emitted again outside the loop for each entry, with the stale-code checker's hash and
the polls on every new edge. No arm could show a gain past the ~1% floor: dropped. docs/jit.md "Calls" has the
finding; the backlog entry is removed. No code changed (results and docs); `scripts/ci-fast.sh` passed.

## PERF loop 53: `acc`'s bound re-measured, and a timer setter on the Mac (2026-11-22)

Stages 1 and 2 of docs/backlog.md "Parallel SMP's code without `acc`" (PERF loop 34's follow-up): what dropping `acc`
from parallel SMP's polled code would win on today's code, and whether anything in a cross-origin-isolated page can
end a looping vCPU's chunk at its timer's deadline as promptly as the chunk's steps do now. **The bound holds (the
gates −1.3 to −1.6% where they resolve, Firefox's pages session −3.6% in two sessions), and a setter meets decision 3:
a ticker worker waiting by halves.** The design is in docs/abi.md "PERF: parallel SMP's code without `acc`"; nothing
of it is built (stage 3, docs/backlog.md). Data: `bench/boot/results/perf53/` (its README).

**The bound** (`noacc.patch`, loop 34's, applied unchanged to 2ae98b16: `acc` a constant 0, the polls `0 < word`, so
chunks end only at exits and setters, steps and MIPS wrong by design; with `compile-stops.patch`, the compile worker
storing 0 in every stop word when `ready` moves, in its web/ only, so installs stay prompt). M4, macOS, Chrome for
Testing 158.0.8127.36, 3 rounds alternated (the first arm swapped each round), nothing else on the dev VM; ranges of
the rounds' medians (ms; `p53-*.json`, `summary.py . p53 base noacc`):

| | base | noacc | |
|---|---|---|---|
| `smp_alpine_jit` n1 script / total | 2663-2764 / 5202-5328 | 2683-2715 / 5205-5250 | −2.3% / −1.6%, overlapping |
| n2 script / total | 2286-2356 / 4839-4915 | 2309-2321 / 4858-4875 | −1.0% / −0.8%, overlapping |
| n4 script / total | 2265-2298 / 4852-4901 | 2246-2257 / 4818-4842 | **−1.6% / −1.3%**, no overlap |
| `smp_user_jit_4` total | 10724-10931 | 10585-10870 | −0.8%, overlapping |
| compress / Lua / churn / SQLite | 1184-1252 / 2337-2437 / 741-755 / 1704-1806 | 1152-1170 / 2339-2544 / 718-751 / 1658-1895 | **−2.8%** / +0.3% / −2.9% / −7.7% |

Loop 34 had boots −1.0 to −2.0% and userspace −2.5%: the same bound, within the gates' spread. On the browser it is
larger. Firefox's pages session from `pages.waarm64snap` (`bench/gpu/ab-mac.sh`, 3 rounds alternated; two sessions of
runs, the second with a third arm; medians, IQR, [ranges]):

| | base | noacc | |
|---|---|---|---|
| Firefox's starts + the pages' loads, session 1 (s) | 73.0, IQR 1.05 [72.3-74.4] | 70.4, IQR 0.75 [69.9-71.4] | **−3.6%**, no overlap |
| the same, session 2 (s) | 72.5, IQR 1.7 [71.0-74.4] | 69.9, IQR 0.8 [68.8-70.4] | **−3.6%**, no overlap |
| the starts alone, sessions 1 / 2 (s) | 55.2 / 54.6 | 53.2 / 52.6 | −3.6% / −3.7%, no overlap |
| modules; wasm MB; emit ms | 2784; 116; 1886 | 2597; 114; 1859 | −6.7%; −2%; −1.4% |
| Gsteps interpreted | 3.55 | 3.55 | |
| stalls of 20 ms+ (sessions 1 / 2, medians) | 0 / 1 | 2 / 4 | |

The noacc arm makes 6.7% fewer modules: its table's clock (`Table::clock`, `BATCH_TIMEOUT`'s, 64M steps) counts
only interpreted steps, so lukewarm batches wait longer. The second session's third arm, `batch.patch` (the base with
only that: polled code's compiled steps left out of the clock), made as few modules (2591) and ran even with the base
(72.5 s, [71.9-73.5]): the fewer modules are not the gain. The stalls rise because nothing ends a looping chunk at
its timer in this arm: what the ticker below is for.

**Today's timer latency on the Mac** (the diagnostic core, `preempt-counts.ts` in the Mac's Node 26.10.0;
`counts-mac-today*.json`): a vCPU's own timer seen late while running, mean 76.0 / 79.8 / 31.5 µs (smp1 / smp4 /
smp-user4; max 7.8 / 13.0 / 6.0 ms), and in WFI (the host's `Atomics.wait` to the deadline) 1,924 / 291 / 280 µs;
an IRQ line to the IRQ while running 2.6 / 11.2 / 2.1 µs. That's decision 3's "today" on the ranking host.

**The setters** (`bench/boot/timer-setters.html`, new: 4 spinner workers poll a stop word each in a loop, as compiled
code does; one setter worker keeps a deadline per spinner, `gap` ± 50% apart, wakes at the earliest by the mechanism
under test, stores 0 in each word due, and times its own wake against the deadline and the spinner's ack, on one
clock; 3 s per mechanism; the Mac, Chrome 158; `setters-mac*.json`), µs late:

| mechanism | gap 1 ms: mean / p50 / p99 / max | gap 4 ms | its cost |
|---|---|---|---|
| `Atomics.wait` to the deadline | 158 / 132 / 489 / 693 | 561 / 467 / 1,763 / 2,642 (17% over 1 ms) | none |
| `Atomics.wait` to 200 µs before, then a spin | 10 / 2.8 / 154 / 553 | 342 / 231 / 1,500 / 2,359 | 36% / 2.4% of a core |
| **waits of half the time left, spinning the last 40 µs** | **4.1 / 2.8 / 35 / 309** | **8.5 / 2.9 / 43 / 4,419** (3 of 2,981 over 1 ms) | **6.3% / 1.5% of a core; 1.3 / 2.2 waits a deadline** |
| `Atomics.waitAsync` (a worker's event loop) | 628 / 598 / 1,931 / 2,083 (12% over 1 ms) | | |
| `setTimeout` in a worker | 4,752 / 4,911 / 5,647 / 5,727 | | |

The spinner sees the store within the clock's 5 µs grain (p99 5-15 µs). macOS's timed waits come back late by a
share of the timeout (its timer leeway: 132 µs at the median of a ~1 ms wait, 467 µs of ~4 ms), so a fixed lead
fails at longer gaps, and waiting half the time left converges on the deadline in one or two more waits. On the dev
VM (Linux under Lima) the plain wait is ~180 µs late at the median too (`timer-setters` there, not committed).
Against decision 3 (IRQ and timer latency no worse than today's, ≤ one chunk, ~1 ms): the halving ticker is 4-9 µs
late on average where the chunk's steps give 31-80 µs, its p99 under 45 µs; a plain wait, `waitAsync` and
`setTimeout` don't meet it. The same leeway is why a vCPU in WFI wakes 0.3-1.9 ms late on average now (above): the
vCPU worker's sleep to its deadline is one plain `Atomics.wait` (docs/backlog.md, new).

**The decision** (docs/abi.md "PERF: parallel SMP's code without `acc`", the track's call on these numbers): build it.
One ticker worker per machine, halving waits, storing 0 in a vCPU's stop word at its timer's deadline and at a
periodic tick (1 ms) for what the steps paced (the publications, the xHCI's completions, the worker's event-loop
visit, the PC sampler); the compile worker storing 0 when modules are ready; the step clocks moved to time; the
status bar's MIPS and JIT share in parallel SMP replaced by what time can say. Not built in this loop: stage 3 is a
mechanism with its tests, reviews and a page change of its own (docs/backlog.md).

Memory: none (nothing built; the ticker will be one more worker). x64 static counts: compiled code unchanged (loop
34's `cs-*-noacc.json` stand: arm64 −9% frame memory operands, x64 −10 to −11%). `scripts/ci-fast.sh` passed (a
bench page and docs).

## PERF loop 54: the dispatcher's entries and the signature check, counted on the Mac (2026-11-22)

docs/backlog.md's "Indirect transfers into a browser's code", what remained: the dispatcher's entries (15% of the entry
stalls in the dev VM on 2026-11-04 for 4.7% of the indirect entries) and the signature check's table load (3.0% of the
VM's samples). Counted again on the ranking host before building anything. **Nothing to build: the entries the
dispatcher could hand to compiled code directly are under 0.6% of busy time even at a fully cold transfer each, and
eliding the signature check costs the same as keeping it.** M4, macOS, Chrome for Testing 158.0.8127.36, 4fe2f1b3's
core; Firefox's pages session from `pages.waarm64snap` (`bench/gpu/ab-mac.sh`), one session per measurement. Data:
`bench/boot/results/perf54/` (its README).

**Where a busy vCPU's time goes today** (V8's `--prof`, 155,025 busy vCPU ticks, `prof/attr.txt`; 2026-11-09's in
brackets): TurboFan bodies 43.1% (40.8), the block interpreter 17.5% (18.4), **entries at a function's first
instruction 12.7% (14.1)**, the dispatcher, `Jit::miss` and `xmiss` 4.4% (4.6; `jit::steps` alone 2.2%), Liftoff
bodies 5.5%, helpers 4.6%, TLB 1.6%, compile 1.3%. `--prof` has no registers, so it can't tell an entry from the
dispatcher from one after a `return_call_indirect` (both land at the same instruction with the dispatcher's return
address): the split below is by counts.

**The dispatcher's entries by what came before them** (a diagnostic core, `dispatch-counts.patch`: the `diag` tallies
grown by 16 words and summed into the page's JIT log; 97.5 G steps, 442 busy MIPS, ~220 busy vCPU-seconds):

| before the block call | calls | share |
|---|---|---|
| the block interpreter, stopped before a compiled block | 131.5 M | 81.7% |
| the block interpreter, otherwise | 1.1 M | 0.7% |
| an exit (the run loop handled it) | 10.6 M | 6.6% |
| a chunk's end | 2.0 M | 1.3% |
| a compiled block that returned with no exit, its successor in the jump cache | 11.5 M | 7.1% |
| the same, the successor found through `Jit::miss` | 4.1 M | 2.6% |
| all (`dispatches`) | 160.9 M | |

Compiled code went to interpreted code 134.5 M times (151.4 M interpreted runs, 23 steps each): the session's
interpreted 3.6% of the steps come and go as that cycle, compiled → dispatcher → interpreter → dispatcher → compiled.
Inside compiled code the indirect entries were 1,855 M (transfer-cache hits 651 M, jump-cache tails 615 M, by-VA links
589 M; the miss function 161 M more), the direct and imported chains 3,232 M: the dispatcher's 161 M are 8% of the
indirect entries (4.7% on 2026-11-05, before host returns took the returns out of the entries).

**The bound.** At a fully cold indirect transfer each (78 ns on the Mac in `chain2.mjs` at 131,072 functions, against
~5 ns warm), all 161 M would be 12.5 s, 5.7% of busy time; at the VM's ratio (an entry from the dispatcher stalling
~3.2× the average entry) they're ~22% of the entry ticks, ~2.8% of busy time. Of them 82% follow interpreted code:
how much code runs interpreted is the compile threshold's call, and halving it lost on the Mac ("Where a busy vCPU's
time goes on the Mac, and the compile threshold there"); the dispatcher's call is the entry itself, which any path from
the interpreter to compiled code takes. Exits and chunk ends (8%) are the run loop's by definition (the chunk ends
are what docs/abi.md "PERF: parallel SMP's code without `acc`" will change: 2.0 M here, 1.3%, so that design and this
entry don't interact). What compiled code could have taken itself, a block that returned with its successor compiled,
is 15.6 M calls: at 78 ns each 1.2 s, **0.55% of busy time at most**, under the pages session's ~1% floor before any
code to take them; dropped.

**The signature check** (`chain2-mac.txt`, the Mac's Node 26.10.0, `--no-liftoff`, ns an entry, two runs): a funcref
table 78.1-79.5 at 131,072 functions and 4.6-5.4 at 1,000; a table of a final function type, where V8 needn't check
the signature, 77.6-79.1 and 4.9: the same. The check's samples are the dispatch table's line being fetched, which the
target's load would wait for without it (an imported tail call, 27 ns, is the only cheaper transfer: what the jump
cache's tails already are once compiled, "Tried and not kept"). A typed table would also have to be defined by a module
rather than made by the page and shared: dropped, nothing to gain.

Memory: none (nothing built). Compiled code unchanged (no x64 counts). `scripts/ci-fast.sh` passed (docs and data).

## PERF loop 55: parallel SMP's polled code without `acc`, built and measured (2026-11-22)

Stage 3 of docs/backlog.md "Parallel SMP's code without `acc`": the design of PERF loop 53 (docs/abi.md "PERF:
parallel SMP's code without `acc`", ABI 73) built. Polled code has two modes, counted (as before) and uncounted (`acc`
the constant 0); the page counts while its status bar shows MIPS or JIT share (the default layout does; a "Faster
defaults" preset drops them), the benchmarks count unless `--query=uncounted`; a ticker worker (`web/ticker-worker.ts`)
ends uncounted chunks at the vCPU's timer deadline and every 1 ms, the compile worker when modules are ready; a mode
change flushes the JIT's code. **Built and tested, but on the Mac the uncounted mode doesn't beat the base: Firefox's
pages session even (73.2 s against 73.1, overlapping), the parallel gates +0.4 to +0.7%. Loop 53's −3.6% went to
something the mode adds, and the counters point at two things: 18% more modules (+19% compile time) and the platform
lock's contention ×2.7.** Round-robin's code and gates are unchanged. Data: `bench/boot/results/perf55/` (its README).

**The code** (`codestats.json`: `bench/jit/codestats.ts` on Alpine's parallel boot on 4 vCPUs, dumped by each core in
the dev VM's Node; per function, against the base): counted arm64 −0.6% instructions, frame memory operands even; x64
−0.5%, −0.1%. **Uncounted arm64 −3.9% instructions, −11.4% frame memory operands** (−6.5% slots); x64 −4.7% and
−12.9% (−8.0%). As loop 34's measurement core had it (−9%, −10 to −11%): the code is what the bound was measured on.
Round-robin's code is the base's byte for byte (Alpine's boot dumped by both cores), and `tests/steps.txt` didn't move.

**The gates** (M4, macOS, Chrome for Testing 158.0.8127.36; `gates.sh`, 3 rounds, the three arms alternated with the
first rotated each round, nothing on the dev VM; ranges of the rounds' medians, ms; `p55-*.json`, `summary.py`):

| | base | counted | uncounted | uncounted against base |
|---|---|---|---|---|
| `smp_alpine_jit` n1 script / total | 2754-2781 / 5298-5346 | 2788-2825 / 5350-5371 | 2786-2815 / 5335-5370 | +0.6% (no overlap) / +0.4% |
| n2 script / total | 2383-2391 / 4938-4965 | 2379-2411 / 4940-4986 | 2403-2411 / 4981-4986 | +0.7% / +0.6% (both no overlap) |
| n4 script / total | 2305-2340 / 4908-4948 | 2343-2352 / 4942-4974 | 2340-2379 / 4937-4999 | +0.8% / +0.6%, overlapping |
| `smp_user_jit_4` total | 10909-11154 | 10894-11051 | 10743-11382 | +0.5%, overlapping |
| compress / Lua / churn / SQLite | 1182-1227 / 2479-2560 / 737-760 / 1725-1880 | 1214-1333 / 2339-2444 / 745-793 / 1736-1874 | 1156-1312 / 2333-2438 / 758-769 / 1685-2136 | −2.4 / **−5.7** / +1.3 / +8.5% |

Counted against uncounted: within ±0.3% on every total, overlapping. Counted against the base: +0.5 to +0.7% on the
boots' totals (n1's past the spread), the userspace total +0.2%. Lua's −6% is both of this loop's arms against the
base, not the mode. Compile counters (the n4 runs, medians): `emitNs` 155 / 156 / 154 ms (the boot) and 265 / 265 /
264 (the userspace); `compileNs` 34 / 35 / 36 and 66 / 67 / 70 (**+5% uncounted**); wasm bytes 9.90 / 9.83 / 9.49 MB
(−4%) and 16.8 / 16.8 / 16.2 MB; modules 293 / 289 / 300 and 561 / 554 / 550. The uncounted runs count 1 flush: the
mode's, at the first chunk, before anything is compiled.

**Round-robin** (`boot_alpine_jit`, `alpine_user_jit`; `p55rr-*.json`, base and counted, 3 rounds alternated): the
boot's total 3745-3787 against 3754-3770 (+0.3%), cold 3836-3920 against 3864-3900; the userspace total 9946-9978
against 9964-9993 (+0.3%), every phase within ±0.3%, all overlapping: unchanged, as the code is.

**Firefox's pages session** (`pages/`, `bench/gpu/ab-mac.sh`, 3 rounds, the arms alternated, from
`pages.waarm64snap`; medians, [ranges]):

| | base | counted | uncounted |
|---|---|---|---|
| Firefox's starts + the pages' loads (s) | 73.1 [71.1-74.4] | 73.7 [73.7-73.9] | 73.2 [72.4-73.7] |
| the starts alone (s) | 55.2 [53.7-56.2] | 55.7 [55.6-55.7] | 55.1 [54.4-55.5] |
| modules; wasm MB | 2757; 116 | 2777; 116 | **3271 (+18.6%)**; 112 (−3%) |
| `emitNs`; `compileNs` (ms) | 1883; 463 | 1878; 462 | 1875; **551 (+19%)** |
| the platform lock: contended acquisitions; wait (ms) | 37,351; 161 | 37,222; 152 | **100,176 (×2.7); 284 (+76%)** |
| dispatches (M); stalls of 20 ms+ | 160; 0 | 160; 0 | 159; 0 |

The base's rounds fell from 74.4 to 71.1 s through the session (it ran first in round 1): the three arms overlap and
**the uncounted mode doesn't beat the base**. Loop 53's noacc arm, the same code without a ticker, was −3.6% in two
sessions, with 6.7% fewer modules. What the uncounted mode adds beside the code is what to look at, and two counters
move: the batch clock by time (PERIODIC advances `Table::clock` by ns, so `BATCH_TIMEOUT`'s 64M is 64 ms of host time,
shorter than 64M steps of a vCPU at ~450 MIPS) makes more, smaller modules; and the ticker's periodic tick ends every
vCPU's chunk at the same moment, and the platform lock's contended acquisitions nearly triple (which of the run loop's
takes of it collide is not yet counted). Neither, by its own time (90 ms of compile worker, 120 ms of lock wait over ~210 s), adds up to loop 53's
~2.6 s: the next step is a diagnostic build that takes each out in turn (docs/backlog.md, new), not a guess.

Memory: one more worker (the ticker, an isolate of a few MiB); the Mac's `vm_stat` is the whole machine's and spreads
by ~1 GiB between sessions of one arm, so no per-arm RSS here. Tests (`tests/ticker.test.ts`, the spin tests counted
and uncounted, the polled differential test uncounted with `WAARM64_POLLED=2`, the compile worker's stores, the page's
presets and step rates) and their planted bugs: docs/testing.md and the loop's commits. `scripts/ci.sh` (742 s),
`scripts/ci-jit.sh` (319 s) and `scripts/ci-debian.sh --platform` (472 s) passed on the loop's tree.

## PERF loop 56: the ticker review's findings fixed, measured again (2026-11-22)

The out-of-context review of loop 55's ticker and uncounted mode (`review/ticker-count`, eight findings) fixed, each
fix with its confirming test shown failing first (the commit names them), then the Mac's measurements again. **The
fixes did what the counters asked (modules −3% against the base where loop 55 had +18.6%; compile time −2% where it
had +19%; the platform lock's contended acquisitions ×1.2-1.9 where it had ×2.7), and the uncounted mode is still no
faster: Firefox's pages session 73.1-74.5 s against the base's 72.3-76.2 and the counted 73.2-75.6, the parallel
gates within ±0.4%, all overlapping.** So, as the user decided for this outcome, the page's "Faster defaults" preset
and the editor's note that counting slows the machine were taken out (the default bar is unchanged); the mechanism
stays for now, and whether to revert it is the next decision (docs/backlog.md "Keep or revert parallel SMP's code
without `acc`", with what a revert removes). Round-robin's code is unchanged (no emitter changed; `tests/steps.txt`
didn't move), so its gates weren't rerun. Data: `bench/boot/results/perf56/` (its README).

**Per finding:**
1. *The batch clock counted wall time, idle spells included.* `Jit::unpark` (each run loop's start) forgets the last
   tick, so only the time between two ticks of one run loop counts, against `BATCH_TIMEOUT_NS` = 140 ms (about 64M
   steps of a vCPU at ~450 MIPS) instead of 64 ms. Test: `the_batch_clock_by_time_skips_time_out_of_the_core`
   (fails at "the idle spell doesn't count" without the forget, at "not due yet" at 64 ms). Pages: modules
   2680-2703 against the base's 2769-2820, `compileNs` 460-462 ms against 465-484.
2. *Every vCPU stopped at once.* Timer deadlines that pass together fire `STAGGER_MS` = 10 µs apart; the xHCI's due
   time stores 0 in one vCPU's stop word, the next one's each time (one in WFI wakes for it by itself), and the run
   loop claims the due time with a compare-exchange before it takes the platform lock; the xHCI's bell rings after
   the lock's release (`Shared::ring_owed`, `vm::parallel::Plat`). Tests: tests/ticker.test.ts's stagger and xHCI
   cases (0.2-5 µs apart and both stop words at once before), `the_bell_rings_after_the_platform_lock_is_released`.
   The claim has no unit test (one thread can't race it natively): the pages session's counters are its check.
   Contended acquisitions 43.6k-69.8k against the base's 35.7k-37.3k (loop 55: 100k); wait 132-242 ms against
   131-151. Not split by call site (no diagnostic build): what's left is the next step's, if the mode is kept.
3. *`WindowWatch.take()` waited for a period.* It stores 0 in each running vCPU's stop word after its bump (the
   stop words reach the Venus renderer through `venus-init`'s window). Test: tests/window-watch.test.ts, a worker
   playing a vCPU that acks only at a 0 (the 500 ms timeout and every page before; within the test's bound after).
4. *An early fire ping-ponged.* A deadline published again after its fire refires no sooner than a gap that doubles
   from 20 µs (to 1 ms). Test: the ticker 1 ms ahead of the vCPU's clock: 384 early fires before, at most 12 after (the doubling's ~7).
5. *The bell rang on every move.* Only a deadline or xHCI due time that moves earlier rings; a mode change's
   withdrawal doesn't. Test: `without_step_counts_the_timer_deadline_is_published_for_the_ticker` (later: no bell).
6. *A held clock spun the ticker.* While `t0` is u64::MAX the ticker looks at no deadline (the periodic tick goes on,
   so a restart is seen within a period). Test: 92-93% of a core before, ~0 after.
7. *The poll's plain loads.* Kept plain (an atomic load costs code size, PERF loop 34: −1.4%/−2.1% instructions):
   the `poll` docs now give the argument that holds without `acc`: only a wasm `loop`'s back edge (a looped region's,
   whose polls are atomic) or calls (after which V8 reads memory again) let code run on without end, and inlining
   merges a bounded amount of code. No test can force V8's inlining reliably; the spin tests run every shape both ways.
8. *Minor.* The compile worker's view of the memory is made once (a test counts constructions: 20 for 20 modules
   before); the ticker reads `base`, `t0`, `base` and retries on a change; the status bar's counting follower moved to
   `statusbar.ts` with an owner, let go when its run ends (a test of the API; a planted no-op fails it);
   `Status.counted` is `Vm.countedSinceLook()`, false across an off-then-on (tests/spin.test.ts; fails with the old
   `counting()`). Not fixed: the ticker's 1 kHz on an idle machine (an ABI word for "running" vCPUs; docs/backlog.md
   "The ticker on an idle machine", kept) and its late start (its loop can't take the clock handshake later;
   docs/backlog.md "The ticker starts late", new). None of the eight was judged not a defect.

**The gates** (M4, macOS, Chrome for Testing 158.0.8127.36; `gates.sh`, 3 rounds, arms alternated with the first
rotated; base = 1b0224f8's core and tree from `../waarm64-base`, checked different by `tools/wasm-sizes.ts`; ranges of
the rounds' medians, ms; `p56-*.json`, `summary.py`):

| | base | counted | uncounted | uncounted against base |
|---|---|---|---|---|
| `smp_alpine_jit` n1 total | 5320-5374 | 5353-5363 | 5335-5356 | −0.2%, overlapping |
| n2 total | 4959-5012 | 4966-4976 | 4963-4989 | −0.2%, overlapping |
| n4 total | 4962-4977 | 4944-4961 | 4939-4958 | −0.4% (no overlap, under the ~1% floor) |
| `smp_user_jit_4` total | 10896-11022 | 10886-10947 | 10820-10926 | −0.8%, overlapping |

Counted against uncounted: within ±0.3%, overlapping. The userspace run's modules 559 / 551 / 530.

**Firefox's pages session** (`pages/`, `bench/gpu/ab-mac.sh`, 3 rounds, arms alternated, from `pages.waarm64snap`;
base from `../waarm64-base`, counted `+count=1`, uncounted `+count=0`; ranges):

| | base | counted | uncounted |
|---|---|---|---|
| Firefox's starts + the pages' loads (s) | 72.3-76.2 | 73.2-75.6 | 73.1-74.5 |
| the starts alone (s) | 54.8-57.3 | 55.1-56.7 | 55.5-56.1 |
| modules; wasm MB | 2769-2820; 117-118 | 2785-2797; 116-118 | 2680-2703; 112-115 |
| `compileNs` (ms) | 465-484 | 465-475 | 460-462 |
| the platform lock: contended; wait (ms) | 35.7k-37.3k; 131-151 | 37.0k-37.6k; 124-159 | 43.6k-69.8k; 132-242 |

Memory: unchanged from loop 55 (the same workers). CI on the fixes' tree: `scripts/ci.sh` (689 s; a first run failed
four new timing tests under CI's load, made robust in the second commit), `scripts/ci-jit.sh` (306 s),
`scripts/ci-debian.sh --platform` (399 s), `scripts/ci-usb.sh` (10 s, the xHCI claim); the preset's removal
`scripts/ci-fast.sh` and `tools/i18n-check.ts`, tests/page-statusbar.test.ts. `scripts/ci-graphics.sh`: Debian's
graphics passed; the arch-desktop demo's Ctrl+C at its countdown failed, and fails alike with loop 55's page and core
(rerun alone, three ways; `df -h /` 44 GiB free): not this loop's, filed in docs/backlog.md.

## PERF loop 57: parallel SMP's polled code without `acc` reverted (2026-11-22)

The user's decision after loop 56: the uncounted mode measured no faster on the Mac (Firefox's pages session even
with the base, the parallel gates within ±0.4%), and its conditional paths cost tests and reviews. **Reverted whole**
by a commit on main (not a reset): the code, tests, scripts and bench tooling that loops 55-56 changed went back to
216adb06 (loop 54's tree), 57 files, +175 −1,917 lines (the core −773, the host and page −410, the tests −521 with
`web/ticker-worker.ts`'s 191 and `tests/ticker.test.ts`'s 278; the docs −193). Kept: the compile worker's memory
view made once and re-made only when the buffer changes (before loop 55 it made a `Uint32Array` per installed
module), with loop 56's test; page-modal's bounded remote-cache test (a flake guard). `ABI_VERSION` 74 (forward: 73
had the exports), the host's check and the tests' pins with it. The finding is docs/jit.md "Tried and lost: polled
code without `acc`".

**The core against 216adb06's**, built in the side checkout and here: `tools/wasm-sizes.ts` lists the same 1,233
functions at the same sizes, and the module's sections other than the custom ones (debug info, whose paths differ)
are byte for byte the same but one byte of the code section, the ABI constant. So no Mac measurement: the code is
loop 54's. `tests/steps.txt` didn't move.

**CI** on the merged tree (the revert, `origin/claude/great-dirac-kahwh7`'s demo-store commits, the host's ABI
check): `scripts/ci-fast.sh` failed once on page-modal's remote-cache test (the guard named the step: `no answer in
60 s, at: clearCaches`, the rare storage hang loop 55 saw once in ~30 runs; it passed alone in 2.2 s, `/` 71% used);
then `scripts/ci.sh` (747 s), `scripts/ci-jit.sh` (256 s) and `scripts/ci-debian.sh --platform` (479 s) passed.
arch-desktop's "Ctrl+C at a desktop's countdown" still ends `counting foot shell noapp` alone on this tree, so the
mechanism didn't cause it (docs/backlog.md).

## Regions of 64 blocks (2026-11-22)

`block::REGION` 16 → 64 (data and scripts: `results/region64/`, its README). 16 came from M5 step 8.1; M8's forward
regions found 8 and 32 flat within noise in Node (2026-10-02, no numbers kept). M4, macOS, Chrome for Testing 158;
each A/B three rounds alternated, the first arm rotated each round; ranges are the rounds' medians.

**Why it could matter** (diagnostic cores in the dev VM's Node, `results/region64/counts/`). Registers and lazy flags
stay in locals across a region's edges and are written back where code leaves the function. At 16, per 1000 steps,
Alpine's boot takes 127 edges inside regions and leaves them by 32 static tail transfers, 14 host calls, 14 host
returns and 4 indirect transfers. By why the successor wasn't a member, the tail exits: a loop region's own exits 8.7,
the target compiled before 6.5, another region of the batch took it 4.9, a loop head compiled alone 4.5, the region
full 2.5 (userspace: 9.5, 9.3, 7.0, 3.9 and 1.7 of 42). At 32 the region is full far less (0.3) and the other
reasons shrink too: the boot's tail exits 32.0 → 23.6 (−26%), the userspace's 42.0 → 35.7 (−15%), compress −33%,
churn −36%, SQLite −9%, Lua flat.

**16 against 32** (`mac/rg-*`):

| | 16 | 32 | |
|---|---|---|---|
| `boot_alpine_jit` total (ms) | 3698-3762 | 3618-3631 | −3.3%, apart |
| `alpine_user_jit` total | 9880-9975 | 9663-9728 | −3.0%, apart |
| ... compress / Lua / churn / SQLite | | | −7.5%, +0.5% (overlap), −5.3%, −1.9% |
| `smp_alpine_jit` n1 / n2 / n4 | | | −1.6%, −0.8%, −1.1%, apart |
| `smp_user_jit_4` total | 10,889-11,056 | 10,813-11,323 | −0.7%, overlap |

**32 against 64** (`mac/rh-*`): the boot 3602-3640 → 3548-3595 (−2.0%, apart), `smp_alpine_jit` n1 −1.1%, n2
−0.7%, n4 −1.5% (apart), `alpine_user_jit` −1.3% and `smp_user_jit_4` +0.4% (both overlap; the latter's phases
±8% in both arms). The 32 arm ran the same in both sessions (the boot 3618-3631 and 3602-3640), so against 16:
the boot ~5%, the userspace ~4%, the parallel boots 2-3%.

**What it costs** (medians; the JIT's counters and the Mac's RSS): wasm +2-3% from 16 to 32 (the boot 11.1 → 11.4
MiB) and the same at 64; V8's compile time and the modules the same; emission +2-4%; planning (`planNs`) +20% at 32
and +35% at 64 (the boot 46 → 55 → 61 ms, `smp_user_jit_4` 73 → 87 → 101 ms; ~0.4% of the boot, in its times
above). The peak summed RSS of Chrome's processes the same: the boot 1536 / 1541 / 1541-1559 MiB at 16 / 32 / 64,
the userspace 1830 / 1834 / 1836-1839 (16's first round read 1624, its others 1833 and 1830), `smp_user_jit_4`
1785-2050 in every arm.

**Firefox's pages session** (`pages/`, 16 against 64): the starts and loads 71.8-73.1 against 71.3-74.2 s, planning
486-487 against 480-492 ms, wasm 115-116 against 115-117 MB, 60 fps on every page in both; Chrome's RSS peak
3566-4090 against 3486-4236 MiB (±400 MiB between sessions of one arm). No change.

**Planning's walks, bounded and cached; not kept** (`mitigations.patch`, `counts/walkstat.*`, `mac/rm-*`). A forward
region is walked again for each call whose callee can leave it, so 64 blocks full of such calls could take ~64 walks.
Alpine's regions take 1.15-1.19 walks (84-98% one, ~0.5% five or more, churn's 0.7% nine or more). Built: a bound of
8 walks (the last following no call) and a map of the blocks a plan forms. On the Alpine gates no region reached the
bound (the same compiled bytes); planning fell 4-7% (the boot 61.0 → 58.5 ms, the userspace 85 → 80) but the totals
came out 0.4-0.9% slower, overlapping (n2's +0.5% apart), so both were left out.

**The block cap stays at 32** (`counts/capstat.*`): blocks the cap ends are 0.54% of the boot's compiled block
entries (3.3% of its compiled steps, one fall-through every 974 steps), 0.31% of the userspace's (compress 0.97%, Lua
0.04%, SQLite 0.03%); 79-100% of their straight runs end within 63 instructions, none past 255. Their successor is
mostly a member of the same region, an edge, so a longer cap buys a fall-through's per-block costs at most: not
measured. 58-65% of compiled block entries are blocks of 1-4 instructions.

## PERF loop 58: WFI's sleep to its deadline on macOS (2026-11-23)

docs/backlog.md's "WFI's sleep wakes late on macOS" (PERF loop 53's finding): the vCPU worker slept to its deadline
in one `Atomics.wait`, which macOS's timer leeway brings back late by a share of the timeout. **Kept: waits of 2/3 of
the time left and a spin of the last 40 µs (web/idle-wait.ts), a vCPU's own timer seen in WFI 11-29 µs late on average
in the Mac's Node instead of 276-2,376 µs, for ~0.7% more of one host core in an idle 4-vCPU guest; the gates and Firefox's
pages session don't move.** Only the worker's idle path changed (the core, compiled code and `tests/steps.txt` are
5d8f29ef's). M4, macOS, Node 26.10.0 and Chrome for Testing 158; nothing else on the dev VM. Data:
`bench/boot/results/perf58/` (its README).

**The latency** (`preempt-counts.ts`, the diagnostic core, the Mac's Node; "timer line seen, in WFI", mean µs, two
runs each):

| | smp1 | smp4 | smp-user4 |
|---|---|---|---|
| one wait to the deadline | 1,956 / 2,376 (max 10.1 ms) | 301 / 298 | 276 / 277 |
| waits of 1/2, 40 µs spun | 8.2 / 10.6 / 7.4 (max 62-280 µs) | 7.6 / 8.4 / 6.5 | 5.7 / 7.6 / 6.2 |
| **waits of 2/3, 40 µs spun (kept)** | **29.4 / 28.5 (max 69-88 µs)** | **12.4 / 14.1** | **12.5 / 11.4** |

The ~5,000 WFI wake-ups of smp4 and smp-user4 kept a few maxima of 3-9 ms in every arm (a vCPU held elsewhere, not the
wait). In the dev VM's Node the plain wait is 291-294 µs late (Lima's Linux), 1/2 55-59 µs, 2/3 90 µs. The bound this
gives: the plain wait's lateness is time a waiting guest loses, ~0.2 s of smp1's 5.2 s boot at most; the boots
didn't move (below), so the guests' timers aren't on their critical path there.

**The screen of variants** (smp4 / smp-user4 mean µs late; an idle 4-vCPU guest's host CPU, `bench/boot/idle-cpu.ts`:
Buildroot with `/bin/sleep` as init, ~400 idle exits a second, the Node process's CPU as a share of one core):

| | late (µs) | idle host CPU (%), per run | |
|---|---|---|---|
| one wait to the deadline | 298-301 / 276-277 | 7.7-8.8 (8 runs, median 8.1) | |
| 1/2, 40 µs spun | 6.5-8.4 / 5.5-7.6 | 10.4-12.1 (11 runs, median 10.9) | the waits: the system share 0.7 → 2.0% |
| 1/2, 20 µs spun | 7.6 / 5.3 | 11.3 (1) | |
| 1/2, a wait instead of the spin | 17.1 / 14.2 | 10.3-10.9 (3) | the spin isn't the cost |
| 3/5, 40 µs spun | 8.6 / 8.0 | 9.6-10.7 (4) | |
| **2/3, 40 µs spun** | **12-17 / 11-17** | **8.3-9.1 (5, median 8.9)** | |
| 3/4, 40 µs spun | 97.5 / 90.5 | 9.6 (1) | its waits overshoot |

In Node's workers on the Mac the leeway is near half the timeout (3/4's waits overshoot; 2/3's first wait often lands
in the tail), more than Chromium's ~13% at the median in `timer-setters.html` (PERF loop 53; its p99 ~50%), so 2/3 is
where Node's waits still converge and Chromium's converge in fewer of them than 1/2's. In the dev VM the idle guest
went 11.6 → 13.0-13.8% (2/3; 14.6% at 1/2).

**The gates** (`smp_alpine_jit`, `smp_user_jit_4` in Chromium, `bench/run-mac.sh`, the first arm swapped each round;
ranges of the rounds' medians, ms):

| | base | 1/2 (3 rounds; 6 for userspace) | base | 2/3 (3 rounds) |
|---|---|---|---|---|
| n1 / n2 / n4 total | 5088-5126 / 4730-4795 / 4762-4810 | 5020-5118 / 4717-4790 / 4755-4792 | 5093-5132 / 4750-4786 / 4757-4785 | 5016-5118 / 4714-4778 / 4740-4764 |
| `smp_user_jit_4` total | 10553-10945 | 10558-10863 (+1.9%, overlapping) | 10644-10849 | 10556-10611 (−2.4%, no overlap) |

All boots overlap (within ±0.7%). The userspace moved +1.9% and −2.4% in two sessions of the same kind of change
(Spotlight indexed on the Mac during the first): its spread, not the change.

**Firefox's pages session** (`bench/gpu/ab-mac.sh` from `pages.waarm64snap`, 3 rounds alternated; the starts and the
pages' loads, s, median [range]):

| | base | arm | |
|---|---|---|---|
| session 1, 1/2 (its first session first) | 67.2 [66.6-68.9] | 68.4 [67.7-71.0] | +1.8%, overlapping |
| session 2, 2/3 (the base first) | 67.5 [67.5-69.1] | 67.6 [67.3-68.7] | +0.1%, overlapping |
| busy MIPS, modules, stalls of 20 ms+ (session 2) | 481, 2722, 0 | 479, 2714, 0 | |

Memory: none (a few closures at start). Host CPU: +0.6-0.8% of a core for an idle 4-vCPU guest on the Mac (~15-20 µs an
idle exit), ~2% in the dev VM; busy guests don't wait. Tests: `tests/idle-wait.test.ts` (a fake clock whose waits come
back 0-50% late: within 5 µs of the deadline, a bounded number of waits, a wake-up ends the sleep; and one real
3 ms sleep); planted bugs, each caught: one wait to the deadline (12 of 24 fail), no tail spin (16), a wake-up ignored
(2), a share of 0.8 against the 50% leeway case (8). `tests/spin.test.ts`'s IPI round trip (docs/backlog.md) isn't
this: its wake-ups are notifies, which the change leaves as they were.

## PERF loop 59: what a module's install grows outside the heap's bound, counted (2026-11-23)

docs/backlog.md's "The core's heap, after the bound", "What a module's install adds outside the bound": past its
members (filed only with room since PERF loop 48), `Cache::install` files the links (`linkers`: each target's list of
the blocks that chain to it), the page index's region heads under a region's other pages, the module log, and its
callers the tiers (`tiers`, the loop regions compiled for heads compiled alone), all without a `try_reserve`; and
`Cache::tier_up` reaches it from JIT code, where nothing may flush. **Counted, not built: those allocations are small
and bounded, at most 1.6 MiB at once and ~6 MB over a session, against ~730 MiB the heap's reserve leaves past its
mark.** No code changed (the core is 96ca41ae's, ABI 74, `tests/steps.txt` unchanged). Data:
`bench/boot/results/perf59/` (its README).

**The counts** (a diagnostic core, `diag.patch`: each install's allocations by structure, as the bytes of the table
or list it grew to; Mac M4, Chrome for Testing 158.0.8127.36, 4 vCPUs, from `target/snapbench/pages.waarm64snap`,
once each; `alpine_user_jit`'s guest in the dev VM's Node, 1 vCPU, for scale):

| | pages session (200 s) | run-once churn (715 s) | Alpine userspace (Node) |
|---|---|---|---|
| installs / from a tier-up | 2,728 / 839 | 2,353 / 533 | 531 / 164 |
| installs that allocated | 2,565 (94%) | 2,080 (88%) | 472 (89%) |
| bytes they allocated, all | 5.71 MB | 3.68 MB | 0.78 MB |
| the largest install's / a tier-up's | 1.64 MB / 0.82 MB | 0.82 MB / 0.41 MB | 205 KB / 17 KB |
| links' table: doublings, at most | 15, 1.56 MiB (2^16 buckets) | 14, 0.78 MiB | 12, 200 KiB |
| links' keys at most (block map's keys) | 34,547 (668,720) | 22,849 (769,972) | 5,176 (133,584) |
| links' lists: reallocations, bytes | 38,531, 1.48 MB (of 74,167 links) | 27,932, 1.37 MB | 6,025, 238 KB |
| region heads: table doublings, at most; lists | 10, 50 KiB; 1,606, 51 KB | 10, 50 KiB; 1,105, 36 KB | 8, 12.5 KiB; 253, 9 KB |
| tiers' table: doublings, at most | 12, 264 KiB | 11, 132 KiB | 9, 33 KiB |
| module log: reallocations, at most | 11, 128 KiB | 11, 128 KiB | 8, 16 KiB |
| the heap's live bytes / mark at most | 279.3 / 279.4 MiB | 274.9 / 276.8 MiB | 29.4 / 32.4 MiB |

Nearly every install allocates, but almost all of it is a links list's doubling (~40 bytes each); the tables double a
dozen times an epoch, and the largest single allocation was the links' table at 2^16 buckets (1.6 MiB). No head was
new to the block map at its install (a head is always a key the map holds), and neither session flushed or rescued.

**The bounds** (wasm32 sizes): the links' keys are compiled keys (heads and members entered at an entry, each dropped
from the links with its key), so at most the block map's (`MAP_KEYS`, a prune past ~917,000): a table of 2^20 buckets
at most, 25 MiB, its last doubling allocating that beside the 12.5 it frees; the tiers' keys and the log's entries
at most an epoch's slots (`Config::capacity`, 262,144): 2^19 buckets of 33 bytes, 16.5 MiB, and 8 MiB; the region
heads' pages fewer than the heads. In the sessions the links held 3-5% of the map's keys and the tiers' and log's 1-3%
of those bounds. **What it would take:** a links' list or table that couldn't grow can't be left out the way a member
is (an IC must find every block that chains to the code it drops), so the reserve would go between the emit and the
module's log, sized from the emit's `links` and `entries`, with an install that discards its module when it fails
(its slots, its pending blocks' flags) and a tier-up that skips it. That is a mechanism on every install for
allocations two orders of magnitude under the heap's headroom (the reserve is 1 GiB, `HEAP_FLOOR`; the heaviest
sessions measured hold 275-293 MiB: PERF loop 44): not built. The finding is in docs/jit.md "The core's heap"; the
backlog entry is removed.

CI: no code changed (docs and the results directory); `scripts/ci-fast.sh` passed.

## PERF loop 60: the vCPU worker's idle and wake paths, the review's findings fixed (2026-11-23)

The out-of-context review after PERF loop 58 (`review/vcpu-idle.md`, static, of 96ca41ae) found six things in the
vCPU worker's idle and wake paths. Each was checked against the code; five are real and fixed, one (4) is real but
only its worker-side part is worth fixing. **Kept: in Chromium on the Mac a vCPU now sees its own timer in WFI 49 µs
late on average on one vCPU (was 205), 10-13 µs on 2-4 (was 17-19), with no cost to the gates, Firefox's pages
session or an idle guest's host CPU.** The core, compiled code and `tests/steps.txt` are 1fe6dec0's: only web/ changed
(the worker's waits factored into `web/idle-wait.ts` so the tests drive them with a fake clock). M4, macOS, Chrome for
Testing 158.0.8127.36, Node 26.10.0 there; nothing else on the dev VM. The base arm is `../waarm64-base` at 1fe6dec0.
Data: `bench/boot/results/perf60/` (its README).

**The findings:**

| | the review | checked | done |
|---|---|---|---|
| 1 | the event-loop wait (half the time left) ends past short deadlines: its timeout is a delayed task, ~0.6 ms late on average in Chrome on the Mac | real | taken only when it can end `LEAD_MS` (2.5 ms) before the deadline, at most the time left less that; else left due, taken anyway once due 100 ms more (`OVERDUE_MS`) |
| 2 | a `waitAsync` that returned at once (word moved, timeout 0) counted as a return | real (an IDLE woken in its poll, one shorter than the poll) | counted only when it went async |
| 3 | the BUDGET and DEVICE yields wait on a word nothing writes: a wake-up waits for the timer | real | they wait on the wake word with its current value |
| 4 | the deadline counts from after the exit: host delays there are added | real, small | counted from `vm_run_cpu`'s return (before the liveness write, the record's BigInts and the test hook); the core's own path from its clock reading to its return stays (below) |
| 5 | no test bounds the tail spin, the IDLE case, a leeway past 50% | real | tests for each (below) |
| 6 | a comment says "half"; TX_FULL's 1 ms wait counted as host work in the liveness block | real | the comment went with the code; `handled` before the wait |

Finding 4's rest: what's left between the core's clock reading (`run_loop`, `parallel.rs`) and the worker's is the
core's timers, the xHCI's due check and the return, the platform lock only when a timer line changes (its contended
waits average ~1.6 µs in `smp_user_jit_4`); a host stall there delays a timer by the stall plus the idle instead of
the stall alone, in a window of a few µs per idle exit (~400 a second in an idle 4-vCPU guest). An absolute deadline in the
exit record would close it, an ABI change not worth that: not built, no backlog entry.

**The latency in Chromium** (the diagnostic core, `bench/boot/index.html` with `--query=tallies`, new: the timer line
seen late in WFI, µs, the mean of a boot, median of the boots [range]; 2 rounds of 4 arms rotated, 5 boots of each N a
run and 2 of `smp_user_jit_4`; `vyield=1`: every exit that may takes the event loop, the review's way to put every
idle on the yield path; `python3 tallies.py`):

| | base | fix | base, `vyield=1` | fix, `vyield=1` |
|---|---|---|---|---|
| `smp_alpine_jit` n1 | 205 [148-218] | **49 [26-57]** | 404 [336-440] | 44 [43-48] |
| n2 | 18.9 [16.0-20.2] | **9.6 [8.3-10.7]** | 177 [161-190] | 10.0 [9.1-12.0] |
| n4 | 17.0 [15.2-18.7] | **12.8 [10.2-19.5]** | 223 [217-232] | 13.2 [10.7-13.5] |
| `smp_user_jit_4` | 16.6 [15.1-16.8] | **11.4 [9.8-12.1]** | 212 [209-214] | 12.9 [10.6-13.1] |
| n1, the boot's max | 1,480 | 165 | 1,565 | 180 |

The one-vCPU boot has ~110 WFI wake-ups with long idles between, so its 100 ms yield lands in an idle most times: the
base's half-time wait made it 205 µs late on average (the Mac's Node, PERF loop 58: 29 µs, where libuv's timer is
the delayed task). The timer seen late while running doesn't move (77-89 µs, 32-33 in userspace). One run of the
fix with `vyield=1` failed at its first boot: "no vCPU retired a step in 30000 ms", the vCPU on `cpu_do_idle`'s
WFI. It didn't show again in ~180 more boots of the fix with `vyield=1` (8 quick runs on the Mac, 8 alternated with
the base's, 5 in the dev VM's Chromium) or ~120 of the base, nor in the default yield's runs below; a stress of
`Atomics.waitAsync` racing `notify` at a µs timeout in Chrome on the Mac (4 pairs of workers, 90 s: 9.7M waits, 1.4M
ended by a notify) lost none. Not attributed: the idle limit's error now says where each vCPU was (docs/backlog.md).

**The gates** (`smp_alpine_jit`, `smp_user_jit_4` in Chromium, `bench/run-mac.sh`, the first arm swapped each round,
3 rounds; ranges of the rounds' medians, ms; `python3 ../perf53/summary.py gates p60 base fix`):

| | base | fix | |
|---|---|---|---|
| n1 / n2 / n4 total | 5044-5132 / 4711-4795 / 4731-4805 | 5103-5156 / 4738-4792 / 4766-4805 | −0.1 / −0.4 / +0.2%, overlapping |
| `smp_user_jit_4` total | 10601-10973 | 10527-10747 | −1.8%, overlapping |

**Firefox's pages session** (`bench/gpu/ab-mac.sh` from `pages.waarm64snap`, 3 rounds, the base first in rounds 1
and 3): the starts and the pages' loads 68.6 s [67.8-69.1] base, 67.9 s [67.1-69.1] fix (−1.0%, overlapping); busy
MIPS 474 / 480; modules 2719 / 2737; stalls of 20 ms+ 1 / 1, of 50 ms+ 0 / 0.

**An idle guest's host CPU** (`bench/boot/idle-cpu.ts 4 5 20` in the Mac's Node, 3 rounds alternated, ~401 idle exits
a second): base 8.40-8.60% of a core (median 8.58), fix 8.03-8.53% (median 8.06). Memory: none (a few closures at
start).

Tests: `tests/idle-wait.test.ts` covers the worker's waits on a fake host (a clock moving 0.5 µs a read, timed waits
late by a share of their timeout, event-loop waits late by a fixed 0.6 or 2 ms, a wake-up at a set time): an idle with
the return due ends within 5 µs of its deadline (0.2 ms-1 s), long ones take the return, one woken in its poll or
shorter than it leaves the return due, an off vCPU's, short idles alone take it once overdue, a delay after the exit
isn't added, the BUDGET/DEVICE yield ends on a wake-up and isn't counted when it returned at once, TX_FULL's `handled`
precedes its wait; the sleep's tail spin stays under 45 µs (not `TAIL_MS`, so raising it fails); leeways of 80% and
100% overshoot by the first wait's excess only. On 1fe6dec0's behavior (factored, unchanged) 13 cases failed: 7 of
finding 1, 4 of 2, 1 of 3, 1 of 6. Planted bugs, each caught: the half-time wait without the lead (2 fail), the lead
ignored for short idles (1), a returned-at-once wait counted (1), the yield on a word nothing writes (1), a 2 ms tail
(16), no overdue fallback (1), `handled` after TX_FULL's wait (1), the deadline from the wait instead of the exit (1),
a first wait of 0.9 of the time left (32, all six past-50% cases among them).

CI: `scripts/ci.sh` (722 s), `scripts/ci-jit.sh`, `scripts/ci-debian.sh` and `scripts/ci-usb.sh` (testusb through
the DEVICE exit's new yield) passed, each alone.

## PERF loop 61: kvm-unit-tests `timer` under the JIT, re-measured (2026-11-23)

The backlog's "kvm-unit-tests `timer` runs slower under the JIT than interpreted (short blocks around timer polls)",
from M5 step 5 (2026-09-26, bench/interp/REPORT.md: 3.3 s under the JIT against 2.6 s interpreted in Node, x86_64,
106M steps, a dispatch per short block around the timer polls and WFI). Re-measured in the same harness the Node
tests use (`runToPowerOff`, deterministic, 1 vCPU, 256 MiB, `timer.flat` with no arguments; the arms alternated,
which runs first swapped every round; `results/perf61/kut-timer.ts`), Node 26.7.0 on the dev VM (M4):

| | interpreter | JIT | JIT / interpreter |
|---|---|---|---|
| HEAD `949b742b`, 5 rounds | 2,200 · 2,060 · 2,081 · 2,138 · 2,081 ms; **2,081** | 170 · 132 · 133 · 133 · 136 ms; **133** | **0.064 (15.6× faster)** |
| loop 49's base `b166af24`, 3 rounds | 2,203 · 2,026 · 2,027 ms; **2,027** | 193 · 154 · 154 ms; **154** | 0.076 (13.2×) |

Steps 106,198,491 in every run, every run `EXIT: STATUS=1`. **The gap is gone, and was gone before loop 49**: the
JIT had already closed it by the time loop 49 started (which of the JIT's changes since M5 step 5 did it, linking and
regions among them, wasn't bisected: nothing hangs on it); loop 49's timer registers from the step clock took the JIT's run a further
−14% (154 → 133 ms: the test's CTL/CVAL/TVAL accesses no longer exit). Nothing to build; the backlog entry is
removed. No code change, so no gate A/B, no counted code and no step count moved. Raw: `results/perf61/`
(`node-949b742b.json`, `node-b166af24.json`). The watched idle-limit hang (loop 60) wasn't run into: this loop ran
no parallel guests besides CI's.

## PERF loop 62: the Go load's ~10 GB samples, re-measured (2026-11-23)

The backlog's "unexplained ~10 GB samples in the Go-load runs with the flush and the GC nudge" (2026-09-30,
`go-cap-nudge*` in `bench/mem/results/summary.json`: Chromium 153 on the dev VM, Debian on 4 vCPUs, the `go build`
loop of `/work/web`, per-vCPU caches of 40 MiB, 54-69 flushes and 2.4-3.0 GB of wasm in ~450 s; two of the runs had
one sample near 10 GB, the `rwxp [anon:v8]` mappings up ~6 GB within 20 s). Its raw samples weren't kept, so the
loop re-ran the workload on the same host (the dev VM, Chromium 155.0.8059.84, `bench/mem/memsample.ts` brought up to
today's page, `GO=1 V8TRACE=1 EVERY=10000`, 450 s of load each, alone on the machine).

**Could the old samples be the sampler's?** It summed each mapping's `Rss:` (resident), not `Size:`, so the code
space's reservations (today ~1.7× its resident bytes) weren't counted; a GC mid-sample only unmaps, it can't add.
What wasn't checked then: that smaps, read in pieces while the renderer maps and unmaps, sums to one moment's RSS,
and transparent huge pages (the VM runs THP `always`, `max_ptes_none` 511, which could fault or collapse a sparse
code range into 2 MiB pages). The sampler now records, per class, resident, reserved and `AnonHugePages` bytes, the
kernel's `VmRSS` read just before and after the smaps read, `/proc/vmstat`'s THP counters, every realm's
`Runtime.getHeapUsage`, the page's status (JIT counters, its memory estimate) and V8's own wasm code GC lines
(`--trace-wasm-code-gc` from the renderer's stdout). V8 has no other counter of its wasm code in a release build:
`--trace-wasm-native-heap` prints nothing, Chromium's memory-infra dump has only the main isolate's JS heap spaces,
`Browser.getHistograms` has no `Wasm` histograms (docs/v8.md); `measureUserAgentSpecificMemory` counts JS heaps only.

**Six runs** (`results` below: `bench/mem/results/perf62.json`, by `bench/mem/summarize.mjs`; MB are MiB):

| run | budget | flushes | wasm compiled | modules | renderer RSS median / p90 / max | VmRSS max | code median / max | largest code rise in 10 s | V8's dead code counted, max |
|---|---|---|---|---|---|---|---|---|---|
| b160-1 | 160 MiB | 0 | 129 MB | 4,848 | 3,077 / 3,171 / 3,186 | 3,186 | 371 / 411 | 107 (boot) | 38 |
| b320-1 | 320 (default) | 0 | 130 MB | 4,133 | 3,157 / 3,184 / 3,194 | 3,194 | 404 / 421 | 111 (boot) | 42 |
| b16-1 | 16 MiB | 130 | 2,205 MB | 40,366 | 2,874 / 3,268 / 3,305 | 3,308 | 311 / 520 | 208 | 56 |
| b16-2 | 16 | 131 | 2,222 | 40,547 | 2,930 / 3,252 / 3,375 | 3,377 | 290 / 547 | 216 | 51 |
| b16-3 | 16 | 132 | 2,241 | 40,994 | 2,913 / 3,301 / 3,437 | 3,437 | 303 / 561 | 216 | 51 |
| b16-4 | 16 | 130 | 2,199 | 40,288 | 2,828 / 3,225 / 3,303 | 3,307 | 277 / 535 | 217 | 53 |

- **Today's JIT doesn't flush in this load at 160 or 320 MiB**: one shared cache (docs/jit.md "Sharing") and the
  step-weighted batches compile ~130 MB of wasm in 450 s, against the old runs' 2.4-3.0 GB over four per-vCPU copies.
  The 16 MiB floor brings the old churn back (130 flushes, ~2.2 GB, ~40K modules).
- **No spike in 146 samples after 120 s** (the four churn runs; 218 in all six): the renderer at most 3.44 GB, the code
  a sawtooth of 25-561 MB with a flush every ~3.5 s, V8's code GC freeing each epoch's code within a sample or two (its
  dead bytes counted never past 56 MB). The smaps sum matched `VmRSS` within 71 MB in every sample (3 MB without
  flushes); no huge pages in the code (0 MB in every sample; the THP fault and collapse counters didn't move during
  the runs). JS heaps 81-148 MB over all realms; the page's estimate 2.6 GB at 16 MiB, 3.2 at the defaults.
- **Not reproducible, entry removed.** What made the old samples can't be told now (no raw files); what has changed
  since is the per-vCPU copies (four isolates each holding flushed code until its own GC) and the module count
  (190K against 40K). The sampler isn't at fault in today's numbers, and now records what would tell a recurrence
  apart (VmRSS around the read, reservations, THP, V8's GC lines). No core change; no step count moved. Test:
  `tests/mem-smaps.test.ts` (the smaps parser and classes; planted: Size summed as Rss, AnonHugePages unread, both
  caught). The watched "no vCPU retired a step" wasn't seen.

## PERF loop 63: a long browser session against the 320 MiB budget (2026-11-23)

The backlog's "a browser session past the 320 MiB budget": does a real, long session on the desktop guest reach the
JIT's budget and flush, and what does a flush cost? The Mac mini (M4, macOS 26.6.2, Chrome for Testing 158.0.8127.36,
its GPU), the desktop guest from `target/snapbench/pages.waarm64snap` (Arch Linux ARM, 2.5 GiB, 4 vCPUs, 3D), the core
at 50de1ca9 (ABI 74). A new phase of `bench/gpu/firefox-load.ts`, `PHASES=browse`: the pages disk's five saved sites
(wiki, mdn, github, bbc, hn) opened in one Firefox tab by `firefox/sites.html`, 30 s each round and round, the mouse's
wheel scrolling all along; `RESTART_S` closes and starts Firefox again that often, on the next site. Firefox's output
is stamped by the guest's clock (bash's `EPOCHREALTIME`), so every page's frames a second line up with the JIT's
counters once a second and the vCPU timeline (in 500 s chunks); `bench/gpu/mac-rss.sh` samples Chrome's RSS on the
Mac; `bench/gpu/flush-cost.ts` gives, per flush, MIPS and the compiled share in 5 s bins, the vCPU stalls and
Firefox's worst frame gap in the 30 s from it, against the session's other 30 s windows. Results:
`results/perf63/` (`flush-cost.json`; per session `results.json`, `jit.jsonl.gz`, `mem.jsonl.gz` with the page's JIT
gauge, `mac.rss`, `stalls.json`).

| session (60 min unless said) | wasm compiled: start, 10, 30, 60 min (MB) | live at the end | rate, second half | flushes | busy MIPS | renderer RSS median / max |
|---|---|---|---|---|---|---|
| one Firefox | 46, 140, 161, 184 | 175 MiB | 0.8 MB/min | 0 | 277-294 | 2,972 / 3,962 MiB |
| restarted every 150 s (23 restarts) | 47, 131, 148, 173 | 165 MiB | 0.8 MB/min | 0 | 282-318 | 2,885 / 3,847 MiB |
| restarted every 150 s, `?jitmb=128`, 40 min | 48, 115, 194, 238 (40 min) | 98 MiB | 5.6 MB/min (the refill) | 1, at 28 min | 296-314 | 2,777 / 3,979 MiB |

- **At 320 MiB a real session doesn't flush within an hour.** Most of the code comes in the first ten minutes
  (Firefox's own, then each site's); after that ~1 MB a minute, slowing: at the second half's rate the budget is
  ~3 hours away, more as it slows. Restarting Firefox adds little (its code is keyed by physical address: the
  libraries' pages are shared across starts). Five sites are fewer than a user visits; new sites add code, which the
  churn page bounds (two flushes in ~140 s at 320 MiB, `M8: benchmarks started from a snapshot`).
- **The metering is right:** in the 128 MiB session the page's gauge read a budget of 134,217,728 bytes and the flush
  count moved 0 → 1 as the live bytes crossed it (131.2 MB, then 136.3 MB compiled with the epoch at 1, the live bytes
  21.5 MB); `tests/jit-lockstep.test.ts`'s stress variant checks the same counter through `vm.stats()`.
- **What the flush cost** (128 MiB, on hn's page): the compiled share fell to 71% in the worst 5 s and was back within
  2 points of its 98.8% in 45 s; the guest's MIPS didn't drop (it was mostly idle, 293 before, 249 over the 30 s
  after); no vCPU stall of 50 ms or more (none in any session); Firefox's worst frame gap in the 30 s after was 594 ms
  with 2 seconds over 100 ms, against the session's other windows' p90 of 435 ms and maximum 665 ms (the restarts'
  gaps) and p90 of 2 slow seconds. Not distinguishable from the session's own stutter. The refill compiled ~100 MB in
  12 minutes at the doubled floor (2000), reaching 98 MiB live by the end.
- **Nothing built.** The floor's doubling (and anything else about a flush) would only matter past the budget, which
  a real session reaches after hours at the default; at 128 MiB its one flush was hidden in the session's own frame
  gaps. The backlog entry is removed; the harness stays for the next question about a flush.

No core change; `tests/steps.txt` unchanged. The watched "no vCPU retired a step" wasn't seen.

## BENCH loop 1: the browser's CPU counters as a benchmark's measures (2026-11-23)

The BENCH track's first loop (BENCH-KICKOFF.md): what repeats more tightly than wall time on the Mac. macOS gives a
process's instructions retired, cycles, CPU time, their part on performance cores and energy through
`proc_pid_rusage` (`RUSAGE_INFO_V6`), with no privilege for one's own processes: `bench/mac/procstat.c` prints them,
`bench/procstat.ts` sums them over the harness's process tree and its renderers, `bench/run.ts` serves them to the
page (`?proc=<port>`), and `bench/boot/suite.ts` reads them around each boot: a gate's results gain
`<name>_total_cpu_ms`, `_ginstr`, `_gcycles`, `_instr_step`, `_cycles_step` (per guest step), `_pshare` (the cycles'
share on performance cores) and `_joules`, of the renderer. `bench/gpu/firefox-load.ts` reads them from the set-up to
each phase's end (`results.json` `proc`), and `bench/gpu/ab-summary.ts` shows `cpuS`, `ginstr`, `gcycles`,
`instrStep`, `cyclesStep`, `pshare`. A shell loop of fixed work, three times: instructions within 0.002%, cycles
within ~2% (half a second each).

**The gates' A/A** (one core as both arms, `bench/interp/ab-mac.sh`, three rounds; M4 Mac mini, macOS 26.6.2, Chrome
for Testing 158.0.8127.36; `results/bench1/gates/`, `node bench/boot/results/bench1/aa.mjs`). The coefficient of
variation of single samples (of the six runs' medians), the userspace gate's first boot of a run left out:

| Gate (samples) | wall | cycles a step | instructions a step | P-core share |
|---|---|---|---|---|
| `alpine_user_jit_total` (12) | 1.57% (1.62%) | 0.66% (0.63%) | 0.061% (0.025%) | 0.07% |
| `alpine_jit_total` (30) | 0.71% (0.62%) | 0.49% (0.30%) | 0.073% (0.048%) | 0.09% |
| `smp_alpine_jit_n1_total` (30) | 0.35% (0.19%) | 0.72% (0.69%) | 0.14% (0.08%) | 0.32% |
| `smp_alpine_jit_n2_total` (30) | 0.66% (0.09%) | 1.19% (0.52%) | 0.69% (0.21%) | 0.43% |
| `smp_alpine_jit_n4_total` (30) | 0.91% (0.40%) | 1.53% (0.72%) | 1.04% (0.17%) | 0.54% |
| `smp_user_jit_n4_total` (12) | 2.82% (1.82%) | 1.12% (0.57%) | 1.94% (1.16%) | 0.21% |

- **Deterministic gates:** instructions a step repeat 10-25 times more tightly than wall time. The session's first
  run (the known outlier) was 4.0% slower by the clock and 0.07% apart in instructions. Cycles are 1.5-2.5 times
  tighter than the clock.
- **Where the clock's noise comes from, on the userspace gate:** over its 12 samples wall time correlates −0.97 with
  the P-core share (98.6-99.0% of the renderer's cycles) and 0.96 with cycles; the share explains the cycles too
  (−0.90). The boot gate shows no such tie (0.44; cycles and the share −0.50). So part of a run's noise is how much
  of the renderer's work the scheduler put on efficiency cores, and the share is a covariate loop 2 can adjust by.
  No two modes ~6% apart (docs/benchmarking.md) appeared in these 24 runs.
- **Parallel boots:** a realtime guest's work differs run to run (its steps too), so a sample's instructions are no
  tighter than its time; the runs' medians are (0.2% at 2 and 4 vCPUs). `smp_user_jit_4` stays over 1% by any
  measure: a poor gate for small differences.

**The pages session's A/A** (`bench/gpu/ab-mac.sh`, two rounds, four sessions of ~221 s, `results/bench1/pages-aa/`):

| | `pagesS` | busy MIPS | G steps | CPU s | G instructions | G cycles | P-core share |
|---|---|---|---|---|---|---|---|
| a-1 | 69.5 | 474 | 97.16 | 283.4 | 2321.4 | 962.6 | 0.9005 |
| a-2 | 68.7 | 477 | 97.03 | 281.9 | 2314.1 | 956.4 | 0.8998 |
| b-1 | 69.7 | 468 | 96.98 | 285.0 | 2313.5 | 974.1 | 0.9017 |
| b-2 | 68.9 | 477 | 97.08 | 282.0 | 2305.3 | 955.7 | 0.8989 |
| CV | 0.69% | 0.90% | 0.08% | 0.51% | 0.28% | 0.88% | 0.13% |

The session's work is steadier than assumed (its steps within 0.08%), and its instructions 2.5 times tighter than
`pagesS`; its cycles are no tighter than the clock. Four sessions: a first look, not a floor. Three of the four
lacked the steps at the set-up (a restored machine's first status lagged; the harness now waits for it), so cycles
and instructions a step are missing there.

**What instructions don't see:** cache misses, mispredicted branches and dependency chains, so a change that only
moves those shows in cycles and time alone. Which measure ranks which kind of change as the full session does is
loop 4's question; until then a verdict isn't read from instructions alone.

Nothing in the core changed (ABI 74). On Linux `bench/procstat.ts` gives CPU time only (/proc).

## BENCH loop 2: the paired A/B with a stopping rule (2026-11-23)

The BENCH track's second loop: one command for a Mac A/B, `bench/ab-mac.sh <outdir> <base>=<core.wasm>
<arm>=<core.wasm>[@<tree>][?<query>]...` (driver `bench/ab.ts`, an arm's page `bench/boot/pair.ts`, the statistics in
`bench/stats.ts`, tests/ab-stats.test.ts; docs/benchmarking.md "The paired A/B" says what exists). M4 Mac mini, Chrome
for Testing 158.0.8127.36; every session's samples and verdict are in `results/bench2/<session>/`, with the scripts
that read them (`noise.ts`, `place.mjs`, `replay.ts`). The core is the same in every A/A arm (ABI 74, 9,786,743 bytes).

**Arms alternated inside one browser** (`aa1`: four pages of one core kept alive, 20 rounds of the userspace workload,
the first draft of the driver): single samples of the clock spread 0.32% (loop 1, arms in runs of their own: 1.57%),
cycles 0.33%, instructions 0.05%; a pair's ratio 0.29% and 0.23%. The P-core share stops mattering there: it spreads
0.03%, the pairs' time against its difference has r 0.37 and the residual is the spread (0.272 against 0.293);
rejecting pairs by it changes nothing. Loop 1's −0.97 was between runs. Not used.

**A page keeps its own speed.** In `aa1` the three other arms were +0.21%, +0.13% and +0.04% against the base in time
(t 3.2, 1.9, 0.7) and the same in cycles, with instructions equal within 0.003%: the A/A arm was called a difference.
More rounds on the same pages only tighten a wrong answer, so a pair is now a freshly launched browser.

**The warm-up** (`warm-none`, `warm-boot`, `warm-user`: four identical arms, 14 fresh-browser pairs each):

| Warm-up before the sample | a pair's ratio: time | cycles | instructions | samples a pair and arm |
|---|---|---|---|---|
| none | 0.40-0.45% | 0.46-0.59% | 0.19-0.22% | 1 |
| a boot (3.5 s) | 0.36-0.57% | 0.53-0.60% | 0.20-0.21% | 1.4 |
| the workload itself | 0.25-0.44% | 0.21-0.40% | 0.05% | 2 |

The workload as its own warm-up costs twice a cold sample and is the tightest by enough to pay for it in cycles and
instructions (and even in time); the boot as a warm-up buys nothing.

**The base was the fastest arm** in all four of those sessions: 0.10-0.15% under its round's mean in time (`place.mjs`),
whichever place it ran in. A fifth session with the names moved (`names`: the reference called `a0`, an arm called
`base`, two blocks of ten rounds) showed no arm ahead by name or by slot (−0.04%, −0.02%, −0.02%, +0.08%), so the
cause wasn't found. The driver now leaves it nothing to act through: in every pair the arms draw the name their core
is served under, the order their pages open in and the order they run in. Since then (96 A/A pairs of the userspace
workload) the A/A arm's time is +0.06% ± 0.04 against the base.

**A known difference** (`r16`: `block::REGION` 16 against the 64 it has been since 0793f714, which measured the gates
4-5% faster; the defaults, both workloads, 8 min 13 s with the copying):

| | pairs | time | cycles a step | instructions a step | A/A arm's time |
|---|---|---|---|---|---|
| `user` | 5 | +4.19% [+3.23, +5.15] | +1.02% [+0.26, +1.77] | +0.59% [+0.27, +0.92] | −0.03% [−1.48, +1.44] |
| `boot` | 8 | +5.64% [+5.25, +6.04] | −0.18% [−0.44, +0.08] | −0.72% [−0.73, −0.70] | +0.04% [−0.81, +0.90] |

**The renderer's cycles miss it.** They are the sum over the renderer's threads: a `user` sample is 9.4 s of wall and
12.9 s of CPU (V8's compile threads, the collector), and what regions of 16 cost the vCPU's thread (dispatches +5.5%
and +6.4%) is diluted by the rest and partly paid back by less compiling. Time is the measure that saw it, so the
stop needs it; instructions and cycles decide alone only for changes to how much work the same code is. A per-thread
reading (the vCPU's) would be the tight measure for this kind of change: open.

**The stopping rule on A/A runs.** Three sessions of the base alone (`aa-s1` to `aa-s3`: its A/A arm holds the stop),
both workloads, the defaults (4-24 pairs, band ±0.5%, 1% over all looks: each interval's tail 0.12%):

| | `user`: pairs, time | `boot`: pairs, time |
|---|---|---|
| 1 | 16, +0.03% [−0.40, +0.46] same | 12, −0.14% [−0.50, +0.23] same |
| 2 | 17, −0.13% [−0.49, +0.24] same | 12, −0.04% [−0.49, +0.41] same |
| 3 | 16, −0.02% [−0.35, +0.30] same | 9, −0.16% [−0.49, +0.17] same |

Six of six ended `same` (cycles too), a session of both in ~13 min. The kickoff asked for 20 such runs; the user
questioned the number and it was cut: the rule holds a null's false calls at 1% by construction, which 20 runs can't
measure, and a gross failure shows in a few. Instead the rule was replayed over the measured A/A pairs (`replay.ts`,
`replay.txt`: 96 of `user`, 41 of `boot`, drawn with replacement, shifted by a true difference; 20,000 runs a row):

| True difference | `user` time: ends | pairs, median (90%) | `boot` time: ends | pairs |
|---|---|---|---|---|
| 0 | same 97.6%, a difference 0.7%, open 1.7% | 12 (19) | same 99.5%, a difference 0.4% | 11 (16) |
| 0.25% | higher 37%, same 43%, open 20% | 17 (24) | higher 54%, same 38%, open 8% | 15 (24) |
| 0.5% | higher 99.1% | 10 (16) | higher 99.8% | 9 (15) |
| 1% | higher 100% | 6 (8) | higher 100% | 6 (8) |
| 2% | higher 100% | 4 (6) | higher 100% | 4 (5) |

A pair's ratio spreads 0.38% in time and 0.36% in cycles on `user`, 0.33% and 0.22% on `boot`, 0.12% and 0.03% in
instructions. A pair of the base, `aa` and one arm takes ~60 s on `user` and ~23 s on `boot`: a 2% difference in 4-5
min, 1% in ~6, a null in ~12 (`boot`: ~4), a close call at the cap in ~24, against the 25-70 min of three alternated
rounds of runs before. Every later A/B carries its A/A arm, so the count of A/A runs grows by itself.

Also: `bench/procstat.ts` ran `ps -Axo`, which Linux's `ps` refuses, so `bench/run.ts` failed on the dev VM since loop
1 (`-Ao` now); the helper prints the renderers' memory (the verdict's column). `@<tree>` is written and not yet run
against a tree of another ABI. Nothing in the core changed.

## BENCH loop 3: a JIT inside the JIT as a paired workload; the pages session cut (2026-11-23)

The BENCH track's third loop: short workloads that stand for a browser. M4 Mac mini, Chrome for Testing
158.0.8127.36, the core of loop 2 (ABI 74); data in `results/bench3/` (`replay.txt`: loop 2's `replay.ts` over this
loop's A/A pairs).

**`node`, a workload of the paired command** (`WORKLOADS=node`): the new image `alpine-node` (alpine's root with
Alpine's Node 24.22.3 and `images/alpine/node/jitjit.js`) boots like the userspace image and runs fixed work whose
cost is machine code V8 writes as it goes: 1320 functions made from text (a template's operators, constants, branches
and loops varied; objects' methods; functions fed integers, then doubles, another shape and a string), each run past
V8's tiers, one call site over 24 targets replaced each round, 200 regular expressions, and JSON, sorts, Maps and
typed arrays between them. Its check line (`jitjit: 48846038 1320`) is the same natively and in the guest, and the
driver fails a run whose samples' lines differ. A sample is the time between "node start" and "node end" (9.0 s on
the Mac; the boot before it isn't counted), deterministic on one vCPU: every sample interprets 502,928,284 steps.

**What each workload exercises** (one sample's whole run; the pages sessions from the set-up to the end):

| | G steps | JIT wasm MiB (a G step) | modules | dispatches a 1000 steps | interpreted | invalidations | emit / V8 compile ms |
|---|---|---|---|---|---|---|---|
| `boot` | 2.7 | 11.4 (4.3) | 310 | 1.82 | 5.6% | 204 | 177 / 47 |
| `user` | 10.4 | 15.5 (1.5) | 530 | 0.69 | 1.9% | 121 | 243 / 76 |
| `node` | 8.5 | 47.5 (5.6) | 1452 | 2.26 | 5.9% | 481 | 735 / 226 |
| pages, `wiki,mdn` | 39.1 | 89.5 (2.3) | 2071 | 1.99 | 5.2% | 2940 | 1557 / 332 |
| pages, all five | 96.4 | 115.7 (1.2) | 2744 | 1.58 | 3.6% | 7769 | 1979 / 447 |

`node` compiles in 9 s half of what the two-page session does in 95, with the session's share of interpreted steps
and its rate of dispatches; `user` has a third of both. None of the three flushes the cache or runs four vCPUs:
the pages session alone has those.

**Regions of 16 against 64 again** (`r16-3`, the defaults, three workloads, 20.6 min):

| | pairs | time | cycles a step | instructions a step |
|---|---|---|---|---|
| `node` | 9 | +1.65% [+0.06, +3.27] | −4.86% [−6.13, −3.56] | −6.10% [−6.34, −5.86] |
| `user`, its phases alone | 6 | +3.52% [+2.10, +4.96] | +1.55% [+0.25, +2.87] | +1.21% [+1.02, +1.41] |
| `boot` | 11 | +5.64% [+5.25, +6.04] | −0.15% [−0.49, +0.20] | −0.70% [−0.77, −0.62] |

On Firefox's pages session regions of 64 were "no change" ("Regions of 64 blocks": the starts and loads 71.8-73.1
against 71.3-74.2 s). `node`'s +1.7% is the nearest of the three to that; the boot's +5.6% would have ranked the
change as one of PERF's largest. One arm: loop 4 is the calibration. And the counters point the wrong way here:
regions of 16 take 6% fewer of the renderer's instructions on `node` and more time (loop 2's caveat, stronger).

**A/A** (`aa-node`: the base alone, the defaults): `node` ended `same` after 15 pairs (−0.11% [−0.48, +0.27]), the
userspace phases after 22 (−0.02% [−0.48, +0.43]). With `r16-3`'s A/A arm, 24 pairs of `node`: a pair's ratio
spreads 0.33% in time, 0.27% in cycles, 0.10% in instructions; replayed, no difference is called `same` in a median
of 10 pairs (16 at the 90th percentile), 1% decided in 5, 0.5% in 8. A pair of the base, `aa` and one arm is ~77 s:
a null in ~13 min, 1% in ~6.5.

**The userspace phases alone: not kept.** `user` timed between "compress start" and "sqlite end" (its boot and
power-off left out) spreads 0.53% a pair (28 pairs) against the whole run's 0.38%: the same noise over two thirds of
the time. A null then takes a median of 21 pairs instead of 12, which is what the sharper signal (regions of 16:
+3.5% against +4.2% over the whole run, where the boot's own +5.6% is mixed in) would have to pay for. `user` is
the whole run again. No snapshot under either workload: `node`'s boot (3.5 s of a 12.5 s sample) is outside its
window, and a restore in the bench page would be its own piece of work for at most that.

**The pages session cut to its first two pages** (`pages-cut`: `PAGES=wiki,mdn bench/gpu/ab-mac.sh`, an A/A of four
sessions): 106 s a session against 222, 89.5 of the whole session's 115.7 MiB compiled (77%), Firefox's starts and
loads 32.1-32.6 s, spreading 0.65% (the whole session's `pagesS`: 0.69%; in loop 1's four sessions the first two
pages' sum spread 0.70% too). So the cut confirms at half the cost and the same precision, and neither is a screen
for ±0.5%: sessions in browsers of their own spread a pair ~1%, dozens of pairs. Bringing a desktop session into
one browser as the paired command does its arms is the step that would change that; not built.

`bench/ab-mac.sh` copies `alpine-node` to the Mac; tests/ab-stats.test.ts pins `jitjit.js`'s check line at a small
scale. Nothing in the core changed.

## BENCH loop 4: the paired workloads against the browser's answers (2026-11-23)

The BENCH track's fourth loop: which short workload ranks a change as Firefox's pages session does. Arms whose
pages-session result the reports already have, built from the current source with one constant changed (ABI 74), run
by `bench/ab-mac.sh` with its A/A arm on `node`, `user` and `boot` (`results/bench4/cal`, 12 pairs a workload, 54 min
for four arms and the A/A; regions of 16 from loops 2 and 3). The user asked that the pages sessions not be run
again where history has them, so none were: the browser's column is "Regions of 64 blocks" (2026-11-22) and "the
compile threshold there" (2026-11-09, an older core: its direction is what is used). M4, Chrome for Testing
158.0.8127.36. Time against the base, the interval the run's own:

| Arm | Firefox's pages session (history) | `node` | `user` | `boot` |
|---|---|---|---|---|
| regions of 16 for 64 | no change (71.8-73.1 against 71.3-74.2 s) | +1.65% [+0.06, +3.27] | +4.19% [+3.23, +5.15] | +5.64% [+5.25, +6.04] |
| regions of 32 for 64 | not run (between 16 and 64: no change) | +0.03% [−0.66, +0.72] | +1.21% [+0.85, +1.56] | +2.19% [+1.75, +2.63] |
| threshold 500/1000 for 1000/2000 | +0.9%, rounds overlapping | +2.34% [+1.33, +3.36] | −0.09% [−0.45, +0.26] | −0.56% [−0.98, −0.13] |
| threshold 250/500 | +3.6%, rounds apart | +7.30% [+6.76, +7.85] | +0.30% [−0.05, +0.65] | +2.10% [+1.81, +2.39] |
| the A/A arm | | −0.11% [−0.79, +0.56] | +0.09% [−0.23, +0.41] | +0.09% [−0.30, +0.48] |

- **`node` orders the four as the browser did**: nothing for regions of 32, little for 16, a small loss at 500/1000, a
  clear one at 250/500, the threshold's about twice the browser's size (it compiles 5.6 MiB a G step against the
  session's 1.2-2.3). It becomes the command's default workload.
- **The gates don't**: `user` and `boot` put regions of 16 at 4-6% (the browser: none), and `user` sees no cost in
  either threshold (history's `alpine_user_jit` had 250/500 at +1.4% on 2026-11-09's core). They stay what they are,
  gates for a kernel's boot and hot userspace loops; a change is ranked for the browser by `node` and confirmed on the
  pages session.
- **The counters by arm** (the renderer's, all threads): for the thresholds they are two to twelve times the time's
  move (`node` 250/500: cycles +12.8%, instructions +5.5%; `user`: cycles +3.7% for +0.3% of time), V8 compiling 44%
  more wasm (68.5 against 47.5 MiB) on other cores; for regions they have the wrong sign on `node` (32: −1.5% cycles,
  −2.5% instructions for no change in time). Time decides; cycles say what the change costs in cores.
- **Memory shows**: the renderers' footprint at a sample's end is 1970 MiB on `node`'s base and 2387 at 250/500.
- **What no paired workload sees**: parallel SMP and the run loop (one deterministic vCPU runs budgeted code, not the
  page's polled code: "PERF loop 35" had the gates at 1-2% and the browser at −4.7% for the preemption block), cache
  flushes, four vCPUs. Not rebuilt here (its base is another ABI). The interpreter alone had no arm; the nulls of
  PERF loops 42 and 54 were counts and an experiment's patch, not arms to rebuild: the null here is regions of 32 on
  `node` and the A/A arms.

**The A/A arm is opt-in** (`AA=1`; the user, after loop 3): a third of a two-arm run's time back. A pair of the base
and one arm is ~52 s on `node`: 2% in ~4 min, 1% in ~5, a null in ~9 (14 at the 90th percentile).

The run's results didn't come back by themselves: the pages sessions queued behind it were cancelled by ending
their shell, which was also the reader of this run's output, and the script ended before its copy (which signal ended
it wasn't established). Fetched by hand from the Mac; `bench/ab-mac.sh` now ignores a closed pipe and a hang-up,
copies the results first and prints the verdict from its file.

## BENCH: the end (2026-11-23)

**Loop 5, a measurement queue: nothing built.** `bench/ab-mac.sh` takes the machine's CI lock exclusive, so runs
queue behind each other and behind `scripts/ci*.sh` by themselves, and each leaves `<outdir>/verdict.txt`; with a run
at 4-15 min there is no wait long enough for a queue's runner to pay.

**The out-of-context review** (`review/bench-ab`, deleted with this commit; a static read of the tools at f05dac3e):
twelve findings. Fixed, the first four with tests/ab-stats.test.ts's new case failing first:
- a stop measure the host doesn't count, or a mistyped one, counted as decided and ended a workload at four pairs
  (now: an arm with no stop measure to read is never decided; unknown names are refused);
- a sample whose counters went backwards (a renderer ending inside it) made its measure `NaN` to the cap (now: that
  pair is left out of that measure);
- a pair the run ended inside counted for the arms that had run (now: for none);
- `jitjit.js`'s check line didn't cover its deoptimization part: the string call's result is not a number and
  turned that part's sum into 0 every time (now: `jitjit: 59d7b7a8 1320` at the default scale, where loop 3 had
  `48846038`; the image's hash moved; `node` on the fixed script: 8.8 s a sample, 47.4 MiB of wasm, regions of 16
  still fewer instructions and more time in the two pairs of the check run);
- a failed run wrote no verdict and an older `verdict.txt` could stand beside the new log (now: the verdict of what
  it had, `FAILED: <why>`, exit 1; the wrapper clears the three files first);
- the wrapper's last lines could end it before its clean-up or change a good run's exit (`mac-leftovers.sh` exits 1
  when it found something; a closed pipe under the ignored SIGPIPE), `AA=0` turned the arm on, paths were taken
  from the repository instead of where the command ran, its copies had no bound while the CI lock was held, a tree
  without `bench/mac` failed the copy, names weren't checked and an arm called `slot0` would have been overwritten;
- a later workload's first pair ran in the previous workload's browser (now: every pair a new one);
- one arm's leftovers (its collector, freed code) could land in the next arm's counters, which are every renderer's
  (now: 0.3 s between samples; the docs say whose the counters and the memory are);
- the budget is one clock for the whole run where the docs said a workload's (the docs; a workload with no time
  left isn't run and the verdict says so); the seed is recorded; the header's "rotates" was the first draft's.
Left as it is, and said in the docs: the 1% is an interval's, so several arms and measures each take that chance;
the counters' span around a boot is a little wider than the clock's; `alpine-node` takes Node from Alpine's live
repository, as `alpine-user` takes its packages (docs/images.md). Checked on the Mac after the fixes: a two-workload
run started from another directory with `AA=0` (exit 0, results copied), and a run with a core that isn't wasm
(`FAILED` in `verdict.txt`, exit 1, the clean-up run).

**What the track leaves** (docs/benchmarking.md "The paired A/B", "Screening an A/B", "Rules"): one command with a
verdict to ±0.5% in 4-10 min for one arm where three alternated rounds took 25-70 with a ~1% floor; `node` as the
workload that ranks for the browser; the pages session, whole or cut to two pages, as the confirmation and the only
measure of parallel SMP, the run loop and flushes. Open, in docs/backlog.md "The paired A/B's reach": a paired
workload under parallel SMP, a desktop session inside one browser beside its other arm, the vCPU thread's own
counters, an interpreter-only arm for the calibration.

## PERF loop 64: regions past 64 blocks (2026-11-23)

PERF-HANDOVER.md's queue row 1 (no docs/backlog.md entry): `block::REGION` 64 against 96, 128 and 256. **Not kept:
past 64 the regions barely change, and the paired command saw no difference in what runs, so the time it called
`LOWER` is noise; 64 stays.** No code changed (the core is f4390e99's, ABI 74, `tests/steps.txt` unchanged). Data:
`bench/boot/results/perf64/` (`ab.json`, `verdict.txt`, `log.txt` of `bench/ab-mac.sh`). M4, macOS, Chromium
158.0.8127.36 (Chrome for Testing).

**What bounds a region's size besides `REGION`** (read, not run): nothing at or near 64. `block::region` and
`block::forward`'s walks stop at `REGION`; members are `Vec`s; a member's label is a nested wasm `block` and the
branch to it a LEB depth; the one fixed width is a region's entry number (a call's continuation), 8 bits above
`ENTRY_SHIFT` (24) in a table index, so at most 255 entries: a region of `REGION` blocks has at most `REGION - 1`, which
fits up to 256 exactly (past 256 it would need a wider field). The cores differ in `block::region::visit` (the bound's
immediate, +1 byte; `tools/wasm-sizes.ts`).

**`node`, the four arms in one paired run** (24 pairs, the cap; time against 64, the interval, the verdict):

| | wall | cycles | instructions | JIT wasm | planning | modules |
|---|---|---|---|---|---|---|
| 64 | 8886 ms | | | 47.42 MiB | 385.4 ms | 1443 |
| 96 | −0.51% [−0.73, −0.29] `LOWER` | −0.01% `same` | +0.02% `same` | 47.42 MiB | 389.3 ms | 1421 |
| 128 | −0.46% [−0.80, −0.11] `LOWER` | +0.17% `same` | +0.15% `HIGHER` | 47.47 MiB | 390.3 ms | 1418 |
| 256 | −0.34% [−0.78, +0.09] `open` | +0.28% `open` | +0.16% `HIGHER` | 47.47 MiB | 390.2 ms | 1418 |

Emission (718.7-721.6 ms) and V8's compile (215.9-217.6 ms) the same; memory 1711 against 1720-1721 MiB (the level
includes the other arms' pages); interpreted steps −0.4%. The blocks compiled in regions 99,249 → 99,301 (96) and
99,448-99,455 (128, 256): +0.05-0.2%, so the regions a 64-block bound cut short are a few loops (tier-ups 1671 →
1643, regions 21,435 → 21,131-21,153), and 128 already holds every region 256 does. **Why the `LOWER` is
noise:** at 96 the compiled wasm, the instructions and the cycles are the base's within 0.02%: no change in the work
can move the time 0.5%, and a page's own speed (docs/benchmarking.md "The paired A/B": two pages of one core stay
~0.2% apart) and the arms' four pages a pair take a share that size. An A/A run was started and stopped (the user:
the same code and counts already decide it). The gates (`user`, `boot`), the parallel boots and the pages session
weren't run: what the arms change is too small to measure on any of them.

**`block::CAP` 64: left out.** The cap ends 0.03-1% of compiled block entries, whose successor is mostly a member of
the same region already ("Regions of 64 blocks"), and the cap also shapes the interpreter's blocks (`form` is
shared; its constant stack is `2 * CAP`), where a block's end decides where a chunk can stop, so its step counts
would likely move: a guest-visible change for a gain bounded below the floor.

## PERF loop 65: `BATCH_STEPS` on the Mac (2026-11-23)

PERF-HANDOVER.md's queue row (no docs/backlog.md entry): `jit::BATCH_STEPS` (the interpreted steps of a pending
batch's blocks at which it is emitted) at 25K, 100K and 200K against 50K, last set in the dev VM (2026-10-08) and
measured since only in the VM ("The wasm code GC today, and larger batches in a browser", 2026-11-03). **Not kept:
50K stays.** No code changed (the core is d1fcaf2a's, ABI 74, `tests/steps.txt` unchanged). Data:
`bench/boot/results/perf65/` (README). M4, macOS, Chrome for Testing 158.0.8127.36 (the pages session 158.0.8127.88).

**What the constants govern** (read): a block joins the shared cache's pending batch at the compile threshold; each
later report of a queued block adds its length times its dispatches to `pending_steps`, and a tier-up waiting for
the batch adds `TIER_STEPS` (1,562); the batch is emitted, as one module, at `BATCH_STEPS`, at `Config::batch`
(512) blocks, or `BATCH_TIMEOUT` (64M steps by the table's clock) after a table first saw it. One cache for every
vCPU, so in parallel SMP all of them add to one batch, and the vCPU that makes it due emits it and hands it to the
compile worker. A larger value: fewer, larger modules, the batch's blocks longer interpreted (and their reports
taking the lock), forward regions with more of the batch to take. `Config::batch` wasn't an arm: the batches hold
14-27 regions of 64-130 blocks a module here (`blocks`, `regionBlocks` over `modules`), far from 512. Each arm's core carries its constant (an `i64.const` of N and N−1 in
`Cache::due`, the cores the same size).

**`node`, the four arms in one paired run** (21 pairs, every stop measure decided; time against 50K):

| | wall | cycles | instructions | modules | JIT wasm | interpreted | lock acquisitions | V8 compile | footprint |
|---|---|---|---|---|---|---|---|---|---|
| 50K | 8925 ms | | | 1443 | 47.42 MiB | 502 M | 1.60 M | 219 ms | 1723 MiB |
| 25K | −0.07% [−0.47, +0.33] `same` | −0.12% `same` | −1.05% `LOWER` | +26% | +0.05% | −3.6% | −15% | +12% | 1712 |
| 100K | +0.18% [−0.15, +0.50] `same` | −0.70% `LOWER` | +0.18% `HIGHER` | −21% | −1.5% | +5.1% | +22% | −10% | 1704 |
| 200K | **+1.39% [+1.20, +1.59] `HIGHER`** | −1.82% `LOWER` | +0.24% `HIGHER` | −35% | −2.8% | +13.7% | +59% | −19% | 1688 |

The counters move (the first three pairs already showed them), so the arms change what is compiled; the blocks
compiled in regions fall 0.4-2% and emission 2-4% at the larger values. 200K's lower cycles are V8 compiling less on
other cores; the vCPU's clock pays for the 14% more steps interpreted. The footprints include the other arms' pages.

**The gates** (`WORKLOADS=user,boot`, 25K and 100K; 200K out):

| | `user` (18 pairs) | `boot` (22 pairs) |
|---|---|---|
| 25K | +0.19% [−0.11, +0.49] `same`; modules +22%, interpreted −3.0% | +0.16% [−0.15, +0.48] `same`; modules +25%, interpreted −2.1% |
| 100K | **−0.36% [−0.72, −0.01] `LOWER`**, cycles −0.41% `LOWER`; modules −21%, interpreted +4.4%, V8 compile −11% | **−0.67% [−0.96, −0.39] `LOWER`**, cycles −0.94% `LOWER`; modules −24%, interpreted +3.4%, V8 compile −12% |

The wasm within 0.25% in every arm; the footprints even.

**The parallel boots, 50K against 100K** (`bench/run-mac.sh`, 3 rounds alternated, `perf65/gates.sh`): 100K is
the same or slower. `smp_alpine_jit`'s totals +0.2% (n1), +0.7% (n2), both without overlap, +0.1% (n4, overlap);
`smp_user_jit_4`'s total +0.7% (overlap; Lua +2.4%, compress −1.2%, all overlapping). Everything is under the ~1%
floor, but it points the other way from the gates. Peak RSS the same (1544-1554 MiB against 1552-1672 on
`smp_alpine_jit`, 2037-2039 against 2032-2036 on `smp_user_jit_4`).

**Firefox's pages session, cut to two pages** (`PAGES=wiki,mdn`, 2 sessions each, alternated): run for the counters
the row names under four vCPUs, which the deterministic workloads can't show. **There the constant doesn't change
what is compiled:** modules 1505 · 1520 at 50K against 1530 · 1528 at 100K, wasm 92.5 MB in both, interpreted steps
2.06-2.07 G in both, lock acquisitions 9.48 · 9.53 M against 9.56 · 9.40 M, tier-ups 2869 · 2841 against 2838 ·
2854. Busy MIPS 429.5 against 429, the starts and loads 24.6 + 32.45 s against 24.4 + 32.2 s, no stall of 20 ms or
more in any session. The 2026-11-03 VM run (the whole session, 200K) had 45% fewer modules; the cut session on the
Mac today has 27 regions a module in either arm. Which trigger makes those batches due instead (the steps of a few
hot blocks, the tier-ups, the timeout) wasn't isolated: the tier-ups add ~4.5 M steps of the ~75 M the 1505 batches
needed at 50K, and the timeout (64 M steps of one vCPU, ~0.6 s) is longer than the session's ~65 ms between modules.

**Why nothing is kept.** `node`, the ranking workload, calls 25K and 100K `same` and 200K `HIGHER` (+1.4%). 100K's
gains are on the one-vCPU gates (−0.4%, −0.7%, with modules −21-24% and V8 compiling 11-12% less under them), and
the parallel boots, which share the batch among four vCPUs as the page does, lean 0.2-0.7% the other way. The
browser's session compiles the same at 100K as at 50K, so it has nothing to gain. A constant that would help the
gates and not the page isn't worth the move. Memory: the same in every arm within the levels' noise (`node`'s
footprints −11 to −35 MiB from 25K to 200K, the arms' pages together). **50K stays, and it is the base rows 3-4
build on.**

## PERF loop 66: loop heads compiled alone, then as a region (`REGION_AFTER`) (2026-11-23)

PERF-HANDOVER.md's queue row (no docs/backlog.md entry): `jit::REGION_AFTER`, the entries of a loop head compiled
alone before its loop region is compiled, at 250 and 0 against 1000, last swept at M6 in Node. **Not kept: 1000
stays.** 0 doubles the compiled code and costs `node` 11%; a second arm that keeps a loop's members out of forward
regions changes nothing; 250 is 0.35-0.57% faster on the one-vCPU gates and the same on `node`, the parallel boots and
Firefox's pages session. No code changed (the core is 8505db4a's, ABI 74, `tests/steps.txt` unchanged). Data:
`bench/boot/results/perf66/` (README). M4, macOS, Chrome for Testing 158.0.8127.88.

**What the constant governs** (read): a batch's block that heads a loop (`Cache::plan`: its loop region has more
than one block) is compiled alone with a hot word counting `region_after` entries down (`emit::tier_up`); the entry
that reaches 0 queues the loop region for the next batch (`Cache::tier_up`), and once that region is installed the
word holds `REDIRECT | index`. From then on the dispatcher's jump cache points at the region, but every link compiled
earlier still enters the head's own function, which loads the word and transfers again (`return_call_indirect`). At
0 the loop region is compiled at the threshold, with every block the dispatcher has seen that leads back to the head,
and no word. The arms carry their constant (`cmp` shows the immediates; at 0 `Vm::with_devices` is 3 bytes shorter,
and `ra0t`'s `Cache::plan` 5,035 → 5,899 bytes in `tools/wasm-sizes.ts`).

**The counts** (a diagnostic core, `diag.patch`: the redirects through a head's word, its entries while it counts
down, the heads compiled alone, the blocks of tier-up regions, the blocks compiled again since the last flush; 2 pairs
of `bench/ab-mac.sh` and one cut pages session each; medians):

| at 1000 (250) | `node` | `user` | `boot` | pages session (4 vCPUs, 40 G steps) |
|---|---|---|---|---|
| redirects | 14.4 M (10.4), 1.70 per 1000 steps (1.23) | 23.2 M (18.8), 2.22 (1.80) | 5.8 M (3.2), 2.20 (1.19) | 61.9 M (48.8), 1.54 (1.21) |
| entries while counting down | 7.7 M (2.7) | 1.9 M (0.7) | 1.5 M (0.6) | 23.8 M (7.2) |
| heads compiled alone / tier-ups | 9,334 / 1,671 (8,658 / 1,928) | 2,200 / 545 (2,057 / 629) | 1,674 / 421 (1,584 / 502) | 11,836 / 2,871 (10,833 / 3,304) |
| tier-ups among the regions | 7.8% (9.2) | 7.1% (8.3) | 7.6% (9.1) | 7.0% (8.1) |
| blocks compiled again / in regions | 21.6% (22.1) | 18.4% (19.4) | 16.0% (17.5) | 16.1% (16.4) |
| of them in tier-up regions | 13,754 of 21,437 | 3,028 of 6,264 | 2,136 of 4,135 | 13,928 of 31,868 |

So a fifth of the heads compiled alone tier up, and those regions hold about half of what is compiled twice. The
redirects bound the gain: each is two loads, a compare and an indirect tail call, ~1.5-2.2 per 1000 steps; 250 takes
a fifth to two fifths of them away (and two thirds of the counting entries) for 15-19% more tier-ups. Even at the
indirect call's cold cost (~60 ns in a browser's footprint: "Relinking a region once its successors are compiled")
the 13 M fewer redirects of the pages session are ~0.8 s of its ~380 vCPU-seconds, ~0.2%; at a warm few ns, nothing.

**`node`, the four arms in one paired run** (time against 1000, the interval, pairs, the counters' medians):

| | wall | instructions | JIT wasm | regions / blocks in them | tier-ups | modules | emission | footprint |
|---|---|---|---|---|---|---|---|---|
| 1000 | 8876 ms | | 47.42 MiB | 21,435 / 99,249 | 1,671 | 1443 | 722 ms | 1489 MiB |
| 250 | −0.44% [−1.42, +0.55] `open` (12, the cap) | −0.11% `same` | +0.9% | −2.0% / +1.0% | +15% | +0.8% | +0.9% | 1500 |
| 0 | **+11.4% [+2.6, +20.9] `HIGHER`** (4) | +25.4% `HIGHER` | +107% | −16.8% / +119% | 0 | −29% | +106% | 1929 |
| 0, members taken | **+12.6% [+9.3, +16.0] `HIGHER`** (4) | +26.5% `HIGHER` | +107% | the same as 0 | 0 | −29% | +105% | 1955 |

**Why 0 loses** (the counts at 0: blocks compiled again 139 K of 218 K on `node`, 64%; 34-38% on the gates): a loop
region takes every seen block that leads back to its head, so nested loops and loops sharing blocks compile the same
blocks into each other's regions, and at the threshold that is every lukewarm loop (9,334 heads on `node`, of which
1,671 would have tiered up). The distinct blocks compiled are the same in both (78 K); 0 compiles 139 K copies of them,
1000 21 K. The M5 verdict ("regions at the first threshold cost the boots 10-14%") holds at 64-block regions and a
threshold of 1000 on the Mac: the gates there didn't move in time (the diagnostic pairs: `user` −1.0%, `boot` −1.0%,
`open` at 2 pairs) but compiled 27% and 22% more wasm, and `node` doubled it.
**The second arm** (`taken.patch`: at 0, a loop region's members other than inner loops' heads taken in the batch, so
no forward region compiles them too) compiled the same wasm within 0.01%: the copies are loop regions overlapping one
another and blocks compiled in earlier batches, not forward regions of the same batch. Not measured further, and not
built for `region_after` > 0 either: there it would leave a loop's body interpreted until its head tiers up (the 7.7 M
entries counting down on `node`, each a lap of the loop in the interpreter, against 502 M steps interpreted now).

**250 on the gates** (`WORKLOADS=user,boot`):

| | wall | cycles | instructions | wasm | tier-ups | modules |
|---|---|---|---|---|---|---|
| `user` (12 pairs) | **−0.57% [−0.98, −0.15] `LOWER`** | −0.14% `open` | −0.19% `LOWER` | +1.4% | +15% | +1.7% |
| `boot` (8 pairs) | **−0.35% [−0.66, −0.04] `LOWER`** | +0.33% `HIGHER` | +0.26% `HIGHER` | +2.1% | +19% | +1.0% |

Emission +1.6% and +2.4%; footprints 958 → 961 and 849 → 850 MiB.

**The parallel boots, 1000 against 250** (`bench/run-mac.sh`, 3 rounds alternated, `perf66/gates.sh`): every total
within its rounds' overlap. `smp_alpine_jit` −0.6% (n1), −0.3% (n2), −0.5% (n4); `smp_user_jit_4` +0.3% (Lua −0.9%,
SQLite −2.3%, compress +0.7%, all overlapping). Peak RSS the same (1548-1568 against 1554-1665 MiB on
`smp_alpine_jit`, 2035-2050 against 2035-2054 on `smp_user_jit_4`).

**Firefox's pages session, cut to two pages** (`PAGES=wiki,mdn`, 3 sessions each, alternated, no flush): **the
same**. Busy MIPS 425 · 428 · 428 at 1000 against 427 · 426 · 431 at 250, the starts 25.1 · 24.6 · 24.6 against 25.2 ·
24.6 · 24.7 s, the loads 33.2 · 32.3 · 32.5 against 33.3 · 32.5 · 32.3 s, the renderer's CPU 138.5 against 137.9 s
(medians), no stall of 20 ms or more but one at 250. The code moved as on `node`: tier-ups 2,880-2,889 against
3,311-3,343 (+15%), modules +1.7%, wasm 93.8-94.5 against 94.6-95.4 MB (+0.9%), interpreted 2.02-2.04 against
2.00-2.03 G steps, emission 1.54 against 1.56 s.

**Why nothing is kept.** `node`, the ranking workload, leaves 250 `open` at the cap within ±0.5% of 1000 on the same
instructions, and the pages session and the parallel boots run it the same; its gains are the one-vCPU gates'
(−0.4%, −0.6%), for ~1-2% more wasm. As in PERF loop 65, a constant that helps only the gates isn't worth the move.
The redirects it removes bound any gain under ~0.2% of a browser's session. **The winner is 1000 (250 ties it for the
browser)**, the base for the next rows (Liftoff's lazy compiles; the compile threshold's re-check after it).

## PERF tooling: a multi-vCPU paired workload (2026-11-24)

The PERF track's tooling loop, item (2) of PERF-HANDOVER.md's plan: a paired workload under parallel SMP for the
screening tiers' multi-vCPU measure, and per-sample counters for the stutter investigation that comes next. M4 Mac
mini, Chrome for Testing 158.0.8127.88, ABI 74 (the core unchanged); data in `results/perf-smp-pair/` (its README,
`spread.mjs` for the pairs' spreads).

**The workload, `smp`** (`WORKLOADS=smp`; bench/boot/pair.ts): the `alpine-node` image on 4 vCPUs in parallel SMP (a
worker a vCPU and the compile worker, realtime, polled code: a user's machine), running four copies of
`jitjit.js` at once (`waarm64.par=4`, new in the image's local.d script; scale 50), timed between "node start" and
"node end". Chosen over `smp_user_jit_4`'s userspace phases because it keeps every vCPU busy writing new code (each
guest V8 with its own compile and collector threads) and the JIT compiling from four tables into one cache through
the compile worker, 2,500 modules a sample, where the userspace phases are mostly hot loops (1.5 MiB of JIT wasm a G
step against 4.0). Its check line is the four copies' (`4× jitjit: ce31792e 660`), the same in all 120 samples. A
sample's window is 9.9 s, 12.3 s with its boot; 20.9 G steps a run, 84 MiB of JIT wasm, 5.5% of the window's steps
in the block interpreter. The image moved (`images/SHA256SUMS`); `node` is unchanged (no `waarm64.par`, the same
script path).

**Per sample**, over the window (`PairSample.lat`, the verdict's second table's second part): the share of steps run
compiled and interpreted, modules gone overdue, parks, the compile worker's modules and busy ms, the delay from a
module's emission to the ready word reaching it, and from a 5 ms vCPU timeline the longest stall (a vCPU inside one
core call retiring nothing), the stalls' ms a second and the time out of the core. New, host-side only: the compile
worker counts into a shared block (web/counters.ts `CompileStat`: modules, busy ms, the delays' sum, longest and log2
buckets; each module carries its emission time from web/jit-host.ts), read by the VM's `compileStats()`;
`summarizeTimeline` moved from bench/gpu/guest-session.ts to web/profiler.ts so a page can use it. Overdue and parks
were core counters already.

**A/A** (`aa1`: the base and its A/A arm, 12 pairs fixed; `aa-par2`: two copies, 8 pairs):

| | a pair's ratio spreads: time | cycles | cycles a step | instructions | steps | renderer CPU |
|---|---|---|---|---|---|---|
| four copies (`aa1`) | 2.51% | 1.67% | 2.28% | 2.30% | 2.41% | 1.61% |
| two copies (`aa-par2`) | 1.82% | 2.12% | 1.53% | 1.58% | 1.94% | 2.18% |
| `node`, for comparison (BENCH loop 3) | 0.33% | 0.27% | | 0.10% | 0 | |

The noise is the single samples' (their own spread 2.3%), not the pages': a quarter of the renderer's cycles run on
efficiency cores (P share 0.73: four vCPU workers, the compile worker and V8's threads against four performance
cores), and the window ends with the slowest of the four copies (the slowest samples tended to have the most
time out of the core). Taking busy vCPU time (the window × 4 less the time out of the core) instead of the
clock: 1.96%. Steps are not fixed work here (spins, the guest's scheduling): cycles and instructions a step carry the
steps' noise. **What 12 pairs decide:** at 2.5% the stopping rule's interval is ±2.9% at 12 pairs (±1.8% at 24), so a
difference of ~3% or more; nothing is called `same`. The time stays the stop measure (`STOP` defaults to `wall` on
`smp`), so an arm under ~3% runs to the cap and ends `open`.

**Calibration** (`cal`: the base, `BATCH_STEPS` 100K (`perf65/b100000.wasm`), the compile worker's warm-up
(`perf67/warm.wasm` with `perf67-warmup`'s host code over this loop's, `@../waarm64-base`), 12 pairs, 18 min):

| | pairs | time | cycles a step | instructions a step | renderer CPU a step |
|---|---|---|---|---|---|
| `BATCH_STEPS` 100K | 12 | −0.60% [−4.42, +3.38] open | −0.23% [−2.44, +2.02] open | +0.52% [−1.90, +3.00] open | −0.30% [−2.42, +1.87] open |
| the warm-up | 12 | −0.35% [−3.21, +2.59] open | +3.79% [+1.97, +5.64] HIGHER | +4.08% [+1.59, +6.64] HIGHER | +4.82% [+3.02, +6.65] HIGHER |

The known answers: 100K leaned +0.2-0.7% slower on the parallel boots and was the same on the pages session (here:
open, as expected under ±3%); the warm-up ran the parallel boots 1.8-3.8% faster (`smp_alpine_jit`) and
`smp_user_jit_4` +0.2% (here: open in time, −0.35%). The workload doesn't resolve either in time.

**The counters, by arm** (medians of 12 samples; "of any" the most of any sample), as data for the stutter
investigation:

| | compiled | interpreted | overdue | parks | modules | worker busy ms | ready: mean, p50, p99, top (of any) ms | longest stall (of any) ms | stalls ms/s | out of core ms/s |
|---|---|---|---|---|---|---|---|---|---|---|
| base | 94.44% | 5.55% | 0 | 9,965 | 2,527 | 597 | 0.33, 1, 2, 8 (16) | 8 (8) | 0.8 | 86 |
| `BATCH_STEPS` 100K | 94.08% | 5.92% | 0 | 8,088 | 2,036 | 509 | 0.33, 1, 2, 8 (16) | 8 (15) | 2.0 | 73 |
| the warm-up | 93.97% | 6.03% | 0 | 10,252 | 2,602 | 3,007 | 1.32, 2, 8, 16 (32) | 8 (8) | 1.5 | 91 |

Under the warm-up the compile worker is busy five times as long (3.0 s of a 9.9 s window, calling every function
of every module once), a module waits four times as long for `ready` (p99 8 ms against 2), and a little more of the
window runs interpreted (6.03% against 5.55%, +0.5 point, as loop 67's `smp_user_jit_4` had +4.6% interpreted
steps), while the renderer spends 4-5% more cycles. No module went overdue and no vCPU stalled past 15 ms in any
arm: at 5 ms rows the stalls are the timeline's resolution, not stutter. The whole run's JIT wasm and interpreted
steps (second table): base 84.2 MiB and 1.20 G steps, warm-up 87.0 MiB and 1.31 G.

**Memory:** the renderers' footprint at a sample's end was 1.8-2.4 GiB with two arms, up to 3.2 GiB with three:
four 4-vCPU machines are never live at once (an arm's machine ends with its sample), so no limit on arms.

**What it decides, and tier 2:** time under parallel SMP to ~±3% in 12 pairs, where the parallel boots' three
alternated rounds hold ~1%: the parallel boots stay tier 2's multi-vCPU time measure (docs/benchmarking.md
"Screening an A/B"), and `smp` goes beside them for what they don't give, a CPU cost decided in a few percent and
the latency counters a sample. Untried (docs/backlog.md "The paired A/B's reach"): each copy's own duration from the
guest, `WARM=none ROUNDS=3`, Node's `--single-threaded` in the guest, 3 vCPUs.

Tests: tests/jit-compile-worker.test.ts (the delay runs to `ready`, not to the module's own compile; the buckets and a
quantile's bound), tests/ab-stats.test.ts (`smp`'s default stop is the clock, `--stop` overrides it, an older run reads
as before; the latency table). Planted bugs, each caught by its test, then restored: delays counted at a module's
arrival, every workload on the default stop, a quantile's bound one bucket low.
CI at this commit: `scripts/ci-fast.sh`, `scripts/ci.sh` (719 s) and `scripts/ci-jit.sh` (256 s) passed.

## PERF loop 67b: the warm-up's latency (2026-11-24)

The user's report after loop 67 (the compile worker's warm-up, on the local branch `perf67-warmup`, never on main), by
eye: more stutter in latency-sensitive loads (audio, video, games), a much lower share of steps in the JIT in the
status bar under JIT churn (a large program opened, a new site), and worse desktop responsiveness after the last 24
hours' changes. **Stutter not reproduced, from any arm; the lower compiled share and the worker's longer waits
reproduced, small on the Mac; the one variant that takes them back added vCPU stalls of 88-114 ms under load. Not
landed: the warm-up is filed under docs/jit.md "Tried and not kept". Loops 58-66: no regression.** M4 Mac mini (4 P +
6 E cores), macOS 26.6.2, Chrome for Testing 158.0.8127.88; ABI 74, core unchanged since 96ca41ae^. Arms and data:
`results/perf67b/` (README); the measures per session in each run's `latency.txt` (`results/perf67b/latency.ts`).

**Before loop 58 against main against the warm-up** (Firefox's pages session, 3 rounds alternated; `pre58` is
96ca41ae^'s host code, `main` a1ece66b's, `warm` loop 67's):

| | pre58 | main | warm |
|---|---|---|---|
| Firefox's starts (5 pages, s) | 51.5 · 52.0 · 50.5 | 51.8 · 52.0 · 51.3 | 50.4 · 50.9 · 50.4 |
| starts and loads (`pagesS`) | 67.8 · 68.7 · 67.0 | 68.3 · 68.5 · 68.0 | 66.6 · 67.3 · 67.0 (−1.9%, no overlap with main) |
| compiled share, launch to 10 s past `ready` (median page) | 96.90 · 96.89 · 96.98% | 96.95 · 96.91 · 96.87% | 96.94 · 96.94 · 96.94% |
| the compile worker busy (busiest second) | | 0.3% (3.4-3.8%) | 1.4-1.6% (17-19%) |
| emission to `ready`: mean, p99 bucket | | 0.30 ms, 1 | 1.16-1.31 ms, 8 |
| seconds with a frame gap past 50 ms (of 109) | 22 · 24 · 23 | 25 · 21 · 25 | 22 · 26 · 22 |
| frame gaps p99 / max (ms) | 463-486 / 484-492 | 483-500 / 504-539 | 484-510 / 505-642 |
| vCPU stalls of 20 ms or more (longest) | 0 · 0 · 0 | 0 · 0 · 0 | 1 · 1 · 0 (24, 27 ms) |
| renderer CPU (s), P-core share | | 277.0-280.7, 0.900-0.902 | 281.7-282.8, 0.892-0.897 |

The idle waits of loops 58 and 60 (the only host changes on the vCPU's path in loops 58-66; 59 and 61-66 changed no
code, the tooling loop only counters) move nothing: `pre58` and `main` agree in every row, so there was no bisection
to do. NAMES2's changes (the network's names) were not measured: the sessions run offline. In this session the
churn is mild (the worker at 0.3% of a second's time under main), so the warm-up's delay doesn't reach the compiled
share; its costs show in the worker (5×) and the waits (4×), its gain in the starts.

**Heavier churn** (`PHASES=churn`, bench/gpu/firefox/churn.html: Firefox making and running new JS functions for 90
s), with the variants of when the worker calls the functions (each a switch, `?jitwarm=`): `before` as loop 67 (then
post and move `ready`), `after` (post and move `ready`, then warm in the same job), `idle` (post and move `ready`, warm
one module a task while no compile job waits):

| 40 functions a second, 2 rounds | main | before | after | idle |
|---|---|---|---|---|
| compiled share (interpreted) | 92.45 · 92.43% (7.56%) | 91.88 · 91.91% (8.11%, +7%) | 92.40 · 92.42% | 92.37 · 92.42% |
| worker busy (busiest second) | 1.8% (4.8-5.0%) | 6.1-6.3% (19-21%) | 5.9% (18%) | 5.9-6.0% (19-20%) |
| emission to `ready`: mean, p99 bucket | 0.15 ms, 1 | 0.45-0.46 ms, 4 | 0.15-0.16 ms, 1 | 0.16 ms, 1 |
| stalls of 20 ms or more | 0 · 0 | 0 · 0 | 0 · 0 | 0 · 0 |
| seconds with a frame gap past 50 ms (of 92) | 10 · 8 | 7 · 9 | 8 · 9 | – · 10 (one read failed) |

| 200 functions a second, six busy loops on the Mac (four cores free), 2 rounds | main | before | idle |
|---|---|---|---|
| compiled share | 91.87 · 91.87% | 91.18 · 91.24% (+8% interpreted) | 91.85 · 91.78% |
| worker busy (busiest second) | 2.9% (5.2-5.4%) | 10.3-10.6% (22-25%) | 9.8-10.1% (20-21%) |
| emission to `ready`: mean, p99 bucket | 0.13-0.14 ms, 1 | 0.42-0.43 ms, 4 | 0.15-0.16 ms, 1 |
| functions made in 90 s (the guest's throughput) | 6776 · 6910 | 6678 · 6804 | 6910 · 6977 |
| stalls of 20 ms or more (longest) | 0 · 1 (22 ms) | 0 · 0 | 2 · 1 (88, 114 ms) |

At 200 a second the page itself keeps Firefox's frames ~1.3 s apart in every arm, so the frame gaps tell nothing
there. The warm-up as built (`before`) holds each module back until the worker has called its functions, serially:
the waits triple and 7-8% more steps run interpreted under churn, the user's status-bar reading in direction (here
0.5-0.7 points of the share; it grows with the worker's load, toward the 1 s overdue backstop on a host where one
worker falls behind). Posting first (`after`, `idle`) takes the waits and the share back to main's, but brings back
what loop 67 feared: a vCPU reaching a function before the worker compiles it there, while the worker compiles the
same module. Under load `idle` stalled vCPUs 88 and 114 ms inside one core call (3 stalls of 20 ms in 2 sessions,
against none for `before` and one of 22 ms for main), the stutter the user describes; `after`, the same race over a
shorter window, wasn't run under load.

**The gains** (the parallel boots `smp_alpine_jit`, 3 rounds rotated; n1 / n2 / n4 total, ms):

| | main | before | idle |
|---|---|---|---|
| total | 5049-5108 / 4706-4757 / 4727-4751 | 4917-4937 / 4604-4625 / 4637-4713 (−3.0 / −2.4 / −1.4%) | 4936-4962 / 4624-4645 / 4655-4692 (−2.6 / −2.0 / −1.2%) |
| CPU (all threads, ms) | 5237-5317 / 6102-6166 / 7390-7499 | 5382-5398 / 6254-6315 / 7578-7713 (+2.2 / +2.6 / +2.6%) | 5383-5414 / 6225-6288 / 7575-7634 (+2.3 / +2.0 / +1.9%) |

The pages session with `idle` (2 rounds; `pages-idle/`): starts 52.6 · 50.4 s against main's 50.9 · 52.0 and
`before`'s 49.9 · 51.0, `pagesS` 69.5 · 66.7 against 67.3 · 69.0 and 66.4 · 67.5: no gain shown past the rounds'
spread; compiled share, frame gaps and stalls of 20 ms as main's.

**Decided by the user's rule.** Stutter isn't shown worse on the Mac for the warm-up as built (frame gaps, stalls of 50
ms: none; two of 24-27 ms in three pages sessions against none in six), so that part is inconclusive; what is shown is
the compiled share's drop under churn and the waits behind it, and the variant that removes them adds stalls of ~0.1 s
under load. The rule's default for an inconclusive answer and its condition for a variant both say: not landed.
Main stays as it is (no warm-up, no guard); the idea is filed under docs/jit.md "Tried and not kept" and PERF-HANDOVER's
queue row 4 is closed. Kept, as tooling: the compile worker's counters in the machine's status
(`Status.compile`) and in the pages session's `jit.jsonl` (`cw`, once a second), `bench/gpu/ab-mac.sh`'s
`QUERY_<arm>` (a page query per arm), and `results/perf67b/latency.ts`. Untried: a warm-up the user's x86_64 host
would show differently (one worker against a slower core), a budget per module of the functions likely hot, and
audio underruns or a key's echo measured directly (no harness gives them per session yet).

## PERF loop 68: `WARM` with `REPORT` (2026-11-24)

PERF-HANDOVER.md's queue row 5 (no docs/backlog.md entry): `jit::WARM` (the dispatches a block must have run for a
forward region to take it as a member, 16) with `interp::block::REPORT` (the dispatches a decoded block counts before it
reports them to the cache, 16), last swept on 2026-10-16 in the dev VM, where 1 and 4 cost 33-41% more wasm and a
third flush at 160 MiB. **Not kept: 16 and 16 stay.** No code changed (ABI 74, `tests/steps.txt` unchanged). Data:
`bench/boot/results/perf68/` (README). M4 Mac mini, macOS 26.6.2, Chrome for Testing 158.0.8127.88.

**How the two relate** (read): a fresh block reports at its first dispatch, then every `REPORT` (`Cache::miss` hands
back the quota), until it has `warm.max(REPORT)` hits; then once more at the threshold (at most 255 at a time); a
queued block reports every `REPORT` for the batch's `BATCH_STEPS`. So the cache sees a block's hits as 1, 1 + R,
1 + 2R..., and a `WARM` below `REPORT` acts as `REPORT` (`WARM` 8 with `REPORT` 16 takes the members `WARM` 16 does). The
arms pair `REPORT` with `WARM` (w4r4, w8r8, w64r64, w128r128) or keep it below (w32r16, w64r32, w128r64: `REPORT`'s
lock acquisitions apart from `WARM`'s members). `REPORT` stays under the slot's u8 quota.

**`node`** (three paired runs of four arms against w16r16, 12 pairs each unless decided sooner; time, the interval,
pairs; the counters' medians against the base: 47.69 MiB of JIT wasm, 1461 modules, 504 M steps interpreted, 1.61 M
lock acquisitions; no flush in any arm):

| | wall | cycles | instructions | JIT wasm | modules | interpreted | locks | emission |
|---|---|---|---|---|---|---|---|---|
| w4r4 | **+1.45% [+0.12, +2.81] `HIGHER`** (5) | +2.39% `HIGHER` | +2.25% | +2.7% | +1.0% | −0.9% | +103% | +3.1% |
| w8r8 | **+0.41% [+0.01, +0.81] `HIGHER`** (9) | +1.23% `HIGHER` | +1.13% | +1.5% | +0.7% | −0.6% | +38% | +1.5% |
| w32r16 | +0.24% [−0.51, +1.00] `open` | −0.73% `LOWER` | −0.88% | −1.7% | −0.1% | +0.5% | +10% | −1.3% |
| w32r32 (2 runs) | −0.22% `open`, −0.13% `open`; pooled −0.18% [−0.40, +0.05] (24) | −1.0% `LOWER` | −1.0% | −1.5% | −1.3% | +1.1% | −22% | −1.2% |
| w64r32 | −0.20% [−0.69, +0.30] `open` | −2.57% `LOWER` | −2.39% | −3.4% | −1.4% | +1.9% | −13% | −3.6% |
| w64r64 (2 runs) | **−0.66% [−1.32, −0.01] `LOWER`** (10), −0.45% [−0.92, +0.04] `open`; pooled −0.55% [−0.82, −0.27] (22) | −3.05% `LOWER` | −2.8% | −3.5% | −4.0% | +3.1% | −33% | −4.0% |
| w128r64 | +0.00% [−0.47, +0.48] `same` (7) | −3.94% `LOWER` | −3.74% | −5.3% | −3.6% | +4.4% | −26% | −5.7% |
| w128r128 | −0.01% [−0.77, +0.75] `open` | −4.68% `LOWER` | −4.21% | −5.1% | −5.8% | +7.1% | −40% | −5.9% |

The October verdict on low values holds, for another reason: at 64-block regions and 320 MiB, 4 and 8 add only
1.5-2.7% wasm (not 33-41%) and no flush, but their reports (twice and four times the locks) and members cost `node`
0.4-1.5%. Higher values compile less (smaller regions: the blocks in regions −2 to −5.5%, more regions), report less,
and interpret more; V8 compiles less on the other cores, so the cycles fall 1-4.7%, and the vCPU's clock gains
little: the time is best at 64 (−0.55% pooled) and back to the base's at 128, where the interpreted steps (+4-7%) take
the rest. Footprints within the levels' noise (1684-1981 MiB, the arms' pages together; no arm's pattern).

**w64r64 on four vCPUs:**
- `smp` (the paired command, 12 pairs): wall −0.24% [−2.53, +2.09] `open`, cycles −1.19% `open`, wasm −3.0%,
  interpreted +3.2%, locks −34%. The latency counters: compiled 94.23% against 94.43% (interpreted 5.76 against 5.57%),
  modules and parks the same, the compile worker 579 against 577 ms, `ready` 0.32 ms mean in both (p99 bucket 2, the
  longest 16 against 8 ms), stalled 1.3 against 1.5 ms/s, the longest stall 8 ms in both.
- The parallel boots (`bench/run-mac.sh`, 3 rounds alternated): `smp_alpine_jit`'s totals +0.2% (n1), −0.3% (n2),
  +0.3% (n4), all overlapping, for 2.2-2.7% less CPU (no overlap); `smp_user_jit_4`'s total +2.5% (overlap; compress
  +7.1%, Lua +0.3%, SQLite −4.0%, all overlapping), its **churn phase +2.5% without overlap** (702-715 against 727-737
  ms), its CPU +0.2%. Peak RSS the same (1548-1666 MiB against 1528-1677 on `smp_alpine_jit`, 2023-2057 against 2036-2054 on `smp_user_jit_4`).

**Firefox's pages session, cut to two pages** (`PAGES=wiki,mdn`, 3 sessions each, alternated, no flush): **not
confirmed, leaning slower.** Busy MIPS 423 · 422 · 428 against 431 · 425 · 431 (−1.9% by the medians, the rounds
overlapping), the starts 25.2 · 24.7 · 24.7 against 24.6 · 24.7 · 24.6 s, `pagesS` 32.6 against 32.4 s, the
renderer's CPU 138.3 against 138.4 s. The code moved as on `node`: wasm 88-90 against 93-94 MB (−5%), modules −3%,
locks −13%, emission 1.45 against 1.54 s, interpreted 2.08-2.09 against 2.04-2.05 G steps; the compiled share in
Firefox's churn windows (`latency.ts`) 96.74-96.83% against 96.82-96.88%, its worst second 92.6-93.1% against
92.8-93.2%, `ready` 0.29-0.30 ms in both, no stall of 20 ms, frame gaps the same within the sessions' spread.

**Why nothing is kept.** The one decided win is w64r64's on `node` (−0.55% pooled, at 3% fewer cycles); the pages
session doesn't confirm it (MIPS −1.9% within the rounds' overlap, starts and loads +0.1-0.2 s), the parallel boots
tie in time with `smp_user_jit_4`'s churn phase 2.5% slower, and every multi-vCPU measure shows the compiled share a
little lower under churn (0.05-0.2 point), which the user's rule doesn't trade for a one-workload gain. The gates
(`WORKLOADS=user,boot`) weren't run: no arm got that far. What stays measured: 4 and 8 lose on `node`; above 16 the
JIT compiles 1.5-5% less for 1-7% more interpreted steps and saves the renderer 1-4.7% of its cycles (V8's compiles,
on other cores), not the vCPU's time. A larger `REPORT` alone (w64r32 against w64r64; w128r64 against w128r128) is
most of the locks' difference and none of the time.

## PERF loop 69: the compile threshold at 64-block regions (2026-11-24)

The re-check PERF-HANDOVER.md's queue notes called for after loops 64-66 (regions of 64 blocks, `BATCH_STEPS` 50K,
`REGION_AFTER` 1000; `WARM`/`REPORT` 16/16 after loop 68): `Config::DEFAULT`'s `threshold` (the floor: dispatches of
a block key before it joins the batch) and `threshold_max` (what `Cache::retune` raises it to past `PRESSURE_KNEE`'s
eighths of the 320 MiB budget, and each flush doubles the floor toward), 1000/2000, tied with 500/1000 on 2026-11-09
at 16 blocks ("Where a busy vCPU's time goes on the Mac, and the compile threshold there"). **Not kept: 1000/2000
stays.** No code changed (ABI 74, `tests/steps.txt` unchanged). Data: `bench/boot/results/perf69/` (README). M4 Mac
mini, macOS 26.6.2, Chrome for Testing 158.0.8127.88.

The maximum binds only past 120 MiB of live modules (the floor doubles at each eighth past two: 2000 needs 3/8), which
no workload here reached (`node` 48 MiB, `smp` 85, the pages session 93, no flush in any): every arm ran at its floor.

**`node`** (two paired runs against t1000; the counters' medians against its 47.7 MiB of wasm, 1461 modules, 504 M
steps interpreted, 723 ms of emission):

| | wall | cycles | instructions | JIT wasm | modules | interpreted | emission | footprint |
|---|---|---|---|---|---|---|---|---|
| 500/1000 | **+2.62% [+0.92, +4.35] `HIGHER`** (5) | +6.4% `HIGHER` | +2.6% | +20% | −1.9% | −33% | +19% | 1516 against 1637 MiB |
| 2000/4000 | **−0.98% [−1.91, −0.04] `LOWER`** (6), **−1.36% [−2.62, −0.08] `LOWER`** (8); pooled −1.20% [−1.72, −0.67] (14) | −6.9% `LOWER` | −3.0% | −24% | −7.0% | +47% | −23% | 1383-1404 against 1450-1637 |
| 4000/8000 | **+0.74% [+0.16, +1.32] `HIGHER`** (5) | −12.3% `LOWER` | −4.3% | −40% | −16% | +114% | −39% | 1338 against 1450 |

Halving the threshold costs `node` 2.6% (a fifth more wasm, V8 compiling it on the other cores: the cycles +6.4%)
for a third fewer interpreted steps; doubling it saves 1.2% of the time and 7% of the cycles for half again as many
interpreted steps; at 4000 the interpreter takes back more than the compiles save.

**2000/4000 on four vCPUs:**
- `smp` (the paired command, 7 pairs): **wall −4.20% [−7.53, −0.75] `LOWER`**, cycles −1.65% `open`, wasm −17%,
  modules −5.8%, interpreted +35%. The latency counters: **compiled 92.30% against 94.47%** (interpreted 7.70 against
  5.53%), the compile worker 517 against 584 ms, `ready` 0.30 against 0.31 ms mean (p99 bucket 1 against 2, the
  longest 8 against 16 ms), stalled 0.5 against 1.2 ms/s, the longest stall 5 against 6 ms.
- The parallel boots (`bench/run-mac.sh`, 3 rounds alternated): `smp_alpine_jit`'s totals **+2.9% (n1), +1.8% (n2)
  without overlap**, +0.2% (n4, overlap), for 2.9 / 1.6 / 0.9% less CPU; `smp_user_jit_4`'s total +0.7% (overlap;
  compress +1.4%, Lua +3.1%, SQLite −4.2%, all overlapping), its churn phase **−5.6% without overlap** (671-686 against
  707-740 ms), its CPU −1.1%. Peak RSS the same within the rounds (1522-1668 against 1536-1677 MiB on `smp_alpine_jit`,
  2003-2019 against 2033-2048 on `smp_user_jit_4`).

**Firefox's pages session, cut to two pages** (`PAGES=wiki,mdn`, 3 sessions each, alternated, no flush): **no time
gain.** Busy MIPS 418 · 430 · 435 against 416 · 433 · 430 (the same median), the starts 25.1 · 24.5 · 24.0 against
25.2 · 24.1 · 24.6 s, `pagesS` 32.4 against 32.4 s; the renderer's CPU 132.7 against 137.3 s (−3.3%, no overlap),
its cycles −3.9%. The code: wasm 70-73 against 93-94 MB (−24%), modules −2%, emission 1.19 against 1.52 s,
interpreted 2.84 against 2.03 G steps (the whole session's compiled share 92.9 against 94.9%). In Firefox's churn
windows (`latency.ts`: launch to 10 s past each page's `ready`) **the compiled share 95.37-95.64% against
96.80-96.90%**, its worst second 90.2-91.1% against 92.8-94.2%, its worst 100 ms 42.6-43.7% against 55.7-59.7%;
`ready` 0.27 against 0.31-0.34 ms mean, no stall of 20 ms, frame gaps the same within the sessions' spread.

**Why nothing is kept.** 2000/4000 has decided wins on `node` (−1.2% pooled) and `smp` (−4.2%), and saves the
renderer 3-7% of its cycles, but the pages session doesn't confirm them in time, the parallel boot loses 1.8-2.9% on
one and two vCPUs (cold code runs twice the dispatches interpreted before it compiles), and every measure under churn runs 1.4-2.2 points fewer
steps compiled, the worst second 3 points lower: the status bar's reading, which the user's rule doesn't trade
(`ready` waits and stalls aren't worse). The gates (`WORKLOADS=user,boot`) weren't run: no arm got that far.
500/1000's tie of 2026-11-09 is a loss at 64-block regions (`node` +2.6%), and 4000/8000 loses `node` too. What stays
measured: the threshold trades the renderer's compile cycles against the compiled share almost linearly (each
doubling ~7% of `node`'s cycles, a fifth to a quarter of the wasm, half again as many interpreted steps), and the
vCPU's time is best between 1000 and 2000. Untried: a floor of ~1400, a higher floor only for blocks seen after the
boot's first compile burst (the boots' loss is cold code).

## PERF loop 71: a region's last emission when it repeats the one before (2026-11-24)

Queue row 7: `block::module` emits a function more than once. A first emission finds the plain registers, the
members' entry states and dead flags. A region of several blocks is then emitted until its entry states settle (at
most four times), then once more with what settled. That last emission's arguments are those of the emission that
showed the states settled, so it repeated that one, and a single block whose second emission has the first's
arguments (nothing plain, flags not dead, no state carried) emitted twice alike. **Kept:** an emission whose
arguments (`plain`, the entry register and flag states) are the last emission's is that one, kept, not emitted again
(core/src/jit/block.rs). The modules are byte for byte the same; no ABI or step change (ABI 74, `tests/steps.txt`
unchanged). Data: `bench/boot/results/perf71/` (README). M4 Mac mini, macOS 26.6.2, Chrome for Testing
158.0.8127.88.

**Counts** (a diagnostic core that emits each kept emission again and asserts the two identical, on the dev VM's
Chromium: `counts/passes.txt`; no assertion failed on `boot`, `user`, `node` or `smp`). Counted per member emitted
(an emission of an n-block region counts n), the repeated last pass was 10.4% of the members emitted on `boot`, 10.2%
on `user`, 8.1% on `node` and 9.0% on `smp`:

| | functions | of several blocks | their passes: 3 / 4 / 5 / 6 | never settled | single blocks emitted twice alike |
|---|---|---|---|---|---|
| `boot` | 5564 | 2916 | 34 / 22 / 14 / 30% | 594 | 588 of 2648 (22%) |
| `user` | 7653 | 3946 | 35 / 22 / 14 / 30% | 819 | 773 of 3707 (21%) |
| `node` | 21580 | 9385 | 28 / 22 / 12 / 39% | 2789 | 1770 of 12195 (15%) |
| `smp` | 44916 | 16149 | 31 / 22 / 12 / 35% | 4477 | 4236 of 28767 (15%) |

The brief's estimate (three emissions where two would do) assumed all of emission could shrink by a third. The
cost sits elsewhere: **regions whose states never settle** (6 emissions each, no repeat to skip) are 20-30% of the
regions of several blocks but 53% of the members emitted on `boot` and 62% on `node` (`counts/cycles.txt`, a second
diagnostic). None of them returned to an earlier state within the four iterations, so no cycle lets a pass be
skipped without changing the code. Cutting those passes (fewer iterations, or loosening the entry states earlier)
changes the emitted code and would be an A/B of its own; it is in docs/backlog.md.

**Byte for byte:** `bench/jit/dump-modules.ts` on Buildroot's boot (43 modules) and Alpine's (317): every module
identical between base and new (`dump/`).

**The Mac** (`emitNs` against the base; time and cycles from the paired command):

| | pairs | wall | cycles | instructions | `emitNs` |
|---|---|---|---|---|---|
| `node` | 12 | −0.01% [−0.54, +0.52] `open` | +0.04% `same` | −0.22% `LOWER` | 728 → 688 ms (−5.5%) |
| `user` | 12 | −0.48% [−1.22, +0.26] `open` | −0.20% `open` | −0.04% `same` | 243 → 224 ms (−8.0%) |
| `boot` | 9 | **−0.44% [−0.77, −0.11] `LOWER`** | −0.37% `LOWER` | −0.46% `LOWER` | 176 → 163 ms (−7.5%) |

JIT wasm, modules, interpreted steps and `compileNs` are equal in every workload. The footprint is bimodal in both
arms alike: on `node` it is about 1230 or about 1490 MiB depending on the pages' order, in either arm.

- The parallel boots (3 rounds alternated): `smp_alpine_jit` totals −0.1% (n1), +0.1% (n2), −0.6% (n4), all within
  the rounds' spread but n4, whose ranges just miss each other (4752-4775 against 4778-4787 ms). In
  `smp_user_jit_4` the compress phase was +11.6% with no overlap in the first three rounds (one sample of 1449 ms) and
  −3.3% with no overlap in three more; its totals were +1.4% and −0.9%, overlapping. That is the multi-vCPU phases'
  noise, not the change. Peak RSS was the same (1532-1667 against 1646-1667 MiB, 2020-2055 against 2020-2041).
- Firefox's pages session (`PAGES=wiki,mdn`, 3 sessions each, alternated): **emission 1522-1561 → 1438-1440 ms
  (−6.0%, no overlap)**, waits for the cache's lock 586-662 → 549-572 ms; `pagesS` 33.1 against 32.5 s, busy MIPS
  428 against 427, the starts 25.1 against 24.6 s (overlapping). The compiled share under churn was 96.85-96.90%
  against 96.84-96.91%, `ready` 0.29-0.30 against 0.29-0.31 ms mean (p99 bucket 1 in both), no stall of 20 ms in
  either (`pages/latency.txt`).

**Why it is kept.** The change only removes work, the output is identical, and every measure agrees: `emitNs`
−5.5 to −8% everywhere and boot `LOWER`. The time gains on `node` and the pages session are under the ~1% floor, as
the counts predicted: the 40 ms saved is 0.4% of a `node` sample, and the 92 ms saved is 0.07% of the pages
session's 138 s of renderer CPU. A byte-identical
change that strictly removes work is kept on decided `emitNs` savings with no contradicting browser measure. It
costs no memory: a function holds one more `Emission` while it settles, and drops it at the function's end.

**Tests:** the JIT's unit tests and the byte check. A planted bug that keeps an emission when only `plain` and the
flag states match, ignoring the register states, fails two unit tests (`a_loop_carried_scalar_keeps_its_shadow`,
`a_region_is_a_loop_with_registers_across_its_edges`) and changes 26 of Buildroot's 43 modules. One that ignores the
flag states changes nothing on either gate: no emission there has the last one's `plain` and register states with
other flag states. The comparison stays anyway: an emission is a function of all three.

## Workers stranded at a machine's end (2026-11-24)

A cloud session (x86_64, 4 vCPUs), Playwright's Chromium (Chrome for Testing 158.0.8127.36) headless, Debian on the
page's transient machine (2 vCPUs, 1 GiB), a snapshot of it saved from the page (~97 MB) and loaded again and again.
Raw: `results/stranded/` (`runs.json`; `loads.ts`, the raw-CDP driver). This is the backlog's "the browser's memory
grows with each load of a big snapshot" (SNAPZ loop 0 above: the desktop 3.3, 5.5, 7.2 GB over three rounds).

**What grows:** the renderer alone (the GPU and browser processes flat), ~290 MiB a load of Debian, which a full GC
(CDP's `HeapProfiler.collectGarbage`) doesn't give back: anonymous memory 530 → 2,563 MiB over 8 loads, and two worker
threads more after each. Not Playwright's doing: Chromium driven over raw CDP with no auto-attach (`loads.ts`) grew
the same on 7 of 8 loads. **What holds it:** the old machine's worker and its device worker. After a load the targets
list them twice; the old pair doesn't answer `Runtime.evaluate` (their scripts are ended) and their threads never exit
(90 s and more, until the page goes), so their isolates and the guest's RAM stay. Their own workers did end (the old
vCPU and inflate workers' targets are gone, new ones listed).

**Why, by elimination** (4-8 loads each): the device worker's `self.close()` replaced by its host's `terminate` on
`closed`: as bad (the pairs piled up, 5 after 8 loads). No warm device worker for a snapshot's start: as bad. The
inflate pool off: 3 of 4 loads clean. **No nested worker ended explicitly at the end** (the inflate pool's, the vCPU
and compile workers, the device worker): 6 of 6 clean, the renderer flat at ~500 MiB anonymous, 9 worker threads
throughout. So Chromium (Chrome for Testing 158.0.8127.36 here) strands a worker that terminates a worker of its own just
before it is terminated itself; the same terminates in the middle of a worker's life (a load's snapshot pool, closed
after its fill) strand nothing.

**Built:** `endWithOwner` (web/worker-end.ts): a close that says it is its thread's end (`ending`: the machine
worker's stop, `Vm.close({ ending: true })`) leaves, in a browser worker, the workers it started to that end (the vCPU
and compile workers, the device worker, the RAM scanner, a save's pool during a stop; the inflate and deflate pools
always, as they close only at their thread's end); any other close terminates them as before, and so does the page
and Node. The device worker no longer calls `self.close()`: its host terminates it after `closed`, or leaves it to
an ending close. docs/host-code.md §2.1 has the rule. **With it** (the first form, which left every in-worker close's
workers; the stop path is the same): 21 of 22 loads clean (6 + 8 + 8: the last two runs, 9 worker threads and
~490-500 MiB throughout); one load (run 1's fourth) left a pair again (+290 MiB), for a reason not found
(docs/backlog.md). The final form, two runs of 8: one thread stranded in each (at the second and the fifth load,
+270-280 MiB, one thread where the pair was two), and none after it: the renderer stays at that level (~750-780 MiB
anonymous) where the base grew ~290 MiB with every load. The desktop guest on the dev VM isn't measured yet.

## PERF loop 72: one counting pass for six queue rows, and loop 71's review (2026-11-24)

Queue rows 8, 9, 10, 11, 13 and 18 each began with a count on the same workloads, so they were counted in one pass with
one diagnostic core, and nothing was built: this entry decides what is worth building. **Three rows close as findings
(the transfer cache's size and generations, host frames lost at a stop, the helper histogram), and four builds stay
open, the largest a TLB fill for the sibling array (≤ 1.3-1.4% of the page's busy time).** Data:
`bench/boot/results/perf72/` (README: the patch, the raw tallies, `summary.txt`).

**What ran** (one run each; counts of guest events need no rounds). The diagnostic core is `diag.patch` on the loop's
tree (the `diag` feature's tallies grown from 80 to 1,280 words; nothing of it is in the tree):
- Alpine's boot, its userspace benchmark and `smp_user_jit_4`'s guest, in Node on the dev VM
  (`bench/boot/preempt-counts.ts`, 34 s for the three). They count what the guest and the JIT do, which doesn't depend
  on the host: the one-vCPU runs are deterministic (the boot's 2,650,367,147 steps), and the parallel run differs from
  run to run on any host.
- One Firefox pages session on the Mac from `target/snapbench/pages.waarm64snap` (`bench/gpu/ab-mac.sh`, 226 s; M4,
  macOS 26.6.2, Chrome for Testing 158.0.8127.88): the workload only runs in a browser, and its mix (four vCPUs, the
  compile worker, Firefox's processes) is the ranking one. 97.2 G steps, 443 busy MIPS (the normal core's 442 in PERF
  loop 54), so ~219 busy vCPU-seconds.
- A second diagnostic core with `WAARM64_FOLLOW_ALL` (PERF loop 50's switch) for the followed calls, the dev VM again.

**How a count becomes a bound.** No time was measured here. A count is turned into time with unit costs already in
this file, all the Mac's, from PERF loop 54's profile of the same session (155,025 busy ticks) unless said: an
interpreted step 9.9 ns (17.5% of busy time over 3.85 G steps) against 1.4 ns compiled; a dispatch 30 ns
(`jit::steps`' 2.2% over 163 M); a TLB miss and its walk 68 ns (1.6% over 51.4 M); an instruction run by a helper 60 ns
(4.6% over 168 M); an indirect entry 5 ns warm and 78 ns cold (`chain2.mjs`); a host call and return 2-4 ns over a
followed one (PERF loop 50). Each bound assumes every counted event goes away at its full unit cost and that the
build adds nothing: an upper bound, to compare with the pages session's ~1% floor. The unit costs are averages over
classes (a helper's 60 ns mixes ISB's ~20 ns with a group's loads), so a bound within a factor of two of the floor
decides nothing by itself.

| row | what was counted (pages session unless said) | bound, of the page's busy time | verdict |
|---|---|---|---|
| 8 | interpreted steps at a region's member: 8.3% of those reported (boot 8.8%, userspace 12.2%); 11.4 M round trips | ≤ 1.9% (1.2% the steps, 0.7% the trips) | **open**, M: entries at members |
| 8 | every callee followed: 10-14% of the host calls would go (boot 10.1%, userspace 11.6%) | 0.2-0.45% | closed again (PERF loop 50's verdict holds at 64 blocks) |
| 9 | the miss function: 167.4 M calls, 124.2 M of them find nothing compiled; 43.3 M refill | conflicts ≤ 0.2%, generations ≤ 0.3% | **closed**: neither 65,536 entries nor a per-ASID generation |
| 9 | the jump cache: 4.50 M fills, 4.36 M over another key's entry, 4.13 M refills of a block already installed | 0.55-0.75% | **open**, S: a sweep of `JC` |
| 10 | 51.4 M misses; 10.6 M fills had the page in the same EL's other data array | ≤ 1.3-1.4% | **open**, S-M: fill the sibling |
| 10 | 17.2% of misses on a slot holding another page; 82.8% on an empty one | ≤ 0.7% at 32,768, ≤ 0.9% at 65,536 | **closed**: `TLB_ENTRIES` |
| 10 | a miss's last-level table in a 64-entry cache 81.7%; next to the last miss 4.9%; nG list overflowed in 4.9% of `flush_ng` | ≤ 0.7%, ≤ 0.3%, 0.02% | **closed**: a table cache, a neighbour fill, `NG_SLOTS` |
| 11 | 2,398 queues collapsed into a flush of everything, 2,392 of them holding only user-half VAs and ASIDs; ~2,030 global entries dropped each | ≤ 1.0% | **open**, S-M: collapse to `flush_ng` |
| 13 | 73.8 M host frames left unreturned (52.8 M at stops for an uncompiled block) | 0.2-0.8% | **closed**: an L build for under the floor |
| 18 | 167.6 M instructions in helpers: 73% loads and stores, 18% system, 6% integer instructions of groups' spans; FlagM none | nothing inline-worthy (≤ 0.05% a class) | **closed**; the second decode ≤ 0.4%, S |

**Row 8, transfers that leave a function.** Per 1000 steps (`summary.txt`; edges stay inside a function):

| | edges | direct chains | through the jump cache | by-VA links | transfer cache RET / BLR / BR | miss function | host calls | interpreted |
|---|---|---|---|---|---|---|---|---|
| boot | 141.9 | 23.7 | 3.4 | 4.0 | 1.9 / 1.1 / 1.1 | 1.42 | 15.0 | 5.6% |
| compress | 128.5 | 27.3 | 3.5 | 8.2 | 0.3 / 0.7 / 2.6 | 0.16 | 8.1 | 0.7% |
| Lua | 120.1 | 34.4 | 6.6 | 17.4 | 0.3 / 1.3 / 22.5 | 0.07 | 11.8 | 0.2% |
| churn | 144.9 | 29.0 | 4.2 | 3.8 | 1.6 / 1.8 / 0.3 | 1.19 | 20.6 | 2.6% |
| SQLite | 148.4 | 26.2 | 6.8 | 19.1 | 0.4 / 4.0 / 7.7 | 0.18 | 16.4 | 0.8% |
| Firefox pages | 152.7 | 30.3 | 3.9 | 6.1 | 1.9 / 4.6 / 1.5 | 1.72 | 21.4 | 4.0% |

In Lua and SQLite the backlog entry counted 27-37 direct transfers, 10-14 through the jump cache, 15 by VA, 10-15
returns and 12-24 other indirect branches (2026-10); the returns are host returns now (0.3-0.4 probes left), the
jump cache's share halved, and 56-73% of all transfers are edges. What is left of the entry's two verdicts:
- *Regions entered at more than one block.* A block installed as a region's member and entered from outside it runs
  interpreted until it is compiled again as a head. Of the interpreted steps reported at a key with no function,
  those at such members: boot 11.1 M of 126.7 M (8.8%; 0.42% of all steps, 0.16% in October at 16 blocks), userspace
  20.9 M of 170.8 M (12.2%; 0.20% of the steps, where October had 0.01-0.04%), pages 178.9 M of 2,150 M (8.3%).
  15.2% of the pages session's regions (6,605 of 43,364) were headed by a block that was already a member: compiled
  twice. Scaled to the session's 3.85 G interpreted steps that is 320 M steps at 8.5 ns more each (2.7 s, 1.2%) and
  11.4 M of the 137.6 M compiled → interpreter round trips (two dispatches and a cold entry, 1.6 s, 0.7%). The
  objection of October (an entry parameter on every function) is gone: a function's entries exist since host calls
  (`Region::entries`, a call's continuations). **Open** (M): entries for members besides continuations, where the
  head's page has them and outside loops; the pages session and the wasm's bytes measure it.
- *Followed calls whose callee completes inside* (PERF loop 50, counted at 16 blocks). With every callee followed the
  host calls that would go are 4.04 M of 39.9 M in the boot (10.1%; 6.0% then), 16.35 M of 140.6 M in the userspace
  run (11.6%: compress 14.1%, Lua 13.1%, churn 9.4%, SQLite 12.3%; 5.3-10.9% then). At 2-4 ns each: 0.3-0.65% of the
  userspace gate, 0.2-0.45% of the boot; the pages session's 2,078 M host calls at the same share, 0.2-0.45%. Larger
  regions raised the share by half and the verdict stands: under the floor for a design that touches every exit.

**Row 9, the transfer cache and the jump cache.** In the pages session the probes of BR, BLR and RET hit 640.8 M times
and missed 137.8 M; the by-VA links hit 594.2 M and missed 18.1 M; with a chain's failed guard (2.3 M) and a host
return that landed elsewhere (9.3 M) the miss function ran 167.4 M times. **RET is 39% hits (72.2 M of 187.0 M
probes) where BLR is 97% and BR 95%**, and RET's 114.8 M misses are 69% of the miss function's calls. The miss
function found the block 43.3 M times and failed 124.2 M times (74%): the target isn't compiled (a return into a
caller that runs interpreted), which no cache size changes. By the entry it found: another VA's tag 108.1 M (of
those 27.6 M would share a slot among 65,536 entries too, a quarter, what chance gives unrelated tags), an older
generation 31.0 M, zeroed 21.1 M, tag and generation right 7.2 M (the budget or a poll). Only the 43.3 M refills are
the cache's to lose: 65,536 entries could save at most three quarters of the conflicts among them (~21 M refills at
~15-20 ns: ≤ 0.2%, for 768 KiB a vCPU), a per-ASID generation at most the stale ones (≤ 31 M: ≤ 0.3%, L). **Closed.**
The jump cache is another matter: 65,536 entries a table hold the session's 43,364 functions and their entries by PA
bits 17:2, and **4.36 M of its 4.50 M fills overwrote another key's entry**; 4.13 M times `Jit::miss` found a block
compiled and installed but out of the jump cache (`smp_user_jit_4`'s SQLite phase: 1.60 M fills, all but 4,000 over
another key, two hot blocks taking one slot from each other). Each is a probe that failed in compiled code, the host
frames unwound, a dispatch and a map lookup: at 300-400 ns, 1.2-1.65 s, 0.55-0.75%. **Open** (S): `JC` at 131,072
and 262,144 (1 MiB a table today, +1 and +3 MiB a vCPU), arms of one paired run.

**Row 10, the TLB's misses.** 51.4 M misses in the pages session (529 per million steps; boot 198, userspace 96):
EL0 read 21.6 M, write 8.3 M, exec 14.5 M, EL1 read 3.5 M, write 2.6 M, exec 0.9 M; 48.6 M walks ended at level 3,
1.7 M at level 2, 0.9 M faulted, 0.2 M lacked the permission.
- *The sibling.* A walk computes what each EL may do with the page and fills one array. 4.24 M read fills found the
  page in the same EL's write array and 6.39 M write fills found it in the read array: 21.1% of the 50.3 M fills
  (boot 25.4%, userspace 30.6%). The other EL's array had it 95 times, the exec and data arrays 0.14 M: nothing
  there. A data miss costs its walk and the helper that runs the access's group (3.7 instructions in helpers a data
  miss: 132.8 M over 36.0 M): 260-290 ns, so 2.8-3.1 s, **≤ 1.3-1.4%**. It assumes the write was permitted when the
  read walked (190 K walks lacked a permission, so mostly yes), and that the extra fill evicts nothing useful.
  Nothing in the walk has state to update (the access flag is software-managed, no DBM), so the read walk's fill of
  the write array is the architecture's own TLB behaviour. **Open** (S-M; not watched pages, which record their write
  fills).
- *The size.* 82.8% of the misses found their slot empty: flushes, not capacity (121,978 `flush_ng` dropped 28.2 M
  listed slots, 55% of the misses' number; 1.16 M flushes by VA). 8.79 M fills evicted another page's entry, 4.96 M of
  them apart among 32,768 entries and 6.96 M among 65,536. An eviction is at most one later miss: ≤ 0.7% and ≤ 0.9%
  at 290 ns, for +2.1 and +6.4 MiB a vCPU and flushes that clear as much more. **Closed** for the page. (On
  `smp_user_jit_4` in Node the share is larger, 41% of its misses on an occupied slot, compress 85%: a gate's, not the
  page's.)
- *The rest.* A 64-entry cache of last-level tables would serve 81.7% of the walks three of their four loads (≤ 37 ns
  of a walk: ≤ 0.7%, with every table write to track); 4.9% of the misses are next to the last miss's page (≤ 0.3%);
  the nG list overflowed in 5,929 of 121,978 `flush_ng` (a 128 KiB scan each, ~0.02%). **Closed**, and per-ASID
  stashes stay measured out (docs/cpu.md).

**Row 11, a full TLBI queue.** 398,371 TLBI IS operations in the pages session: 393,292 by a user-half VA, 4,595 by
ASID, 484 by a kernel-half VA, none of everything. 231,342 drains found something queued: lists of one 157,895, of
2-7 54,070, of 8-63 16,892, of 64 87; **2,398 queues had collapsed** (372,541 operations arrived at a collapsed
queue, 155 a collapse: a longer queue would collapse nearly as often). They are every `flush_all` of the session.
2,392 of them had collected only user-half VAs and ASIDs since their last drain, which dropping the nG entries would
have served; a sample of 152 held 2,540 valid entries each, 2,032 of them global. So ~4.9 M global entries a session
are dropped for nothing, against 7.0 M EL1 misses in all: at 290 ns ≤ 0.6%, plus the flush's own 2.3 MiB cleared
2,398 times (~0.25%) and both ELs' transfer cache generations (~0.1%): **≤ 1.0%**. `smp_user_jit_4`: 266 collapses
(Node). **Open** (S-M): a collapsed queue that saw only user-half VAs and ASIDs drops the nG entries, unless the
TLB may hold global entries in the low half (`Tlb::low_global`); a `maint.c` round and a planted bug.

**Row 13, host frames lost.** A block returned to its caller with no exit and no transfer 153.6 M times in the pages
session, 152.1 M of them not for the stop word: 124.2 M are the miss function's failures above, and the dispatcher
then ran interpreted code 137.6 M times (24.7 steps a run). 19.5 M of those stops were above depth 0, with 52.8 M
frames above them (2.7 each); in all 73.8 M host frames were left with their call unreturned (exits take the rest),
3.5% of the 2,078 M host calls. A lost frame costs its `ret` a transfer cache probe in place of a host return, 5 ns
when it hits and ~25 ns through the miss function: 0.4-1.8 s, **0.2-0.8%**. The interpreter called under the live
frames would save that and not the round trip, whose cost is the dispatcher's (PERF loop 54: how much code runs
interpreted is the compile threshold's call). **Closed.** 917 guest calls reached the depth limit of 64.

**Row 18, the helpers.** 163.0 M helper steps, 167.6 M instructions by class (the histogram, published with the
tallies): `STP`/`LDP` 56.4 M, `STR`/`LDR` with an unsigned offset 48.8 M, the other loads and stores 17.1 M (73.0%:
the slow arms of the fast path, 36.0 M data TLB misses' worth, a group's span run by `jit_exec_span`); ISB 13.7 M,
ERET 3.3 M, MSR 3.3 M, DSB 2.1 M, MRS 2.0 M, WFE, YIELD and SEVL 3.5 M, the cache operations 1.7 M (18.1%: the run
loop's or a block's end by design, PERF loop 8); `ADD`/`ORR`/`MOVZ` and kin 10.4 M (6.2%: the integer instructions
inside a group's span); atomics 2.6 M (CAS 0.89 M, LDADD 0.53 M: their slow arms); FP 1.8 M (FCVTZS 0.86 M and SCVTF
0.69 M to and from a general register). **FlagM's forms: none**, nor any other class missing an inline form above
0.9 M: at 60 ns a class of 1 M is 0.03% of busy time. **Closed**: what would shrink the histogram is fewer data TLB
misses (row 10's sibling). The helper decodes its word twice (`jit::count`, then the interpreter's): ≤ 5 ns of 168 M,
≤ 0.4%; S, with other work in the file.

**Ranked** (expected gain for the page against effort): 1. the TLB's sibling fill (S-M, ≤ 1.3-1.4%); 2. the
collapsed queue to `flush_ng` (S-M, ≤ 1.0%), the same files and tests as 1, one loop; 3. `JC`'s sweep (S, 0.55-0.75%);
4. entries at members (M, ≤ 1.9% as a bound and half of it at best: the largest and the least certain); 5. the
helper's second decode (S, ≤ 0.4%).

**PERF loop 71's review** (`review/jit-emission-memo`, a static reading of the kept emission): both findings
confirmed, one suggested test refuted.
- *No test checked a kept emission against the one it replaces.* Fixed three ways. `block::module` asserts, wherever
  debug assertions are on (every native test that compiles a region), that a kept emission is byte for byte the one
  its arguments make (`Emission::same`). `a_kept_emission_has_its_flag_states`: a block that loops to itself with its
  flags dead at entry and no register in a local (`cmp xzr, xzr; b.ne .`) has the first emission's `plain` and
  register states and other flag states. `an_unsettled_region_enters_no_member_dirty_in_a_shadow_alone`: a chain of
  nine blocks carrying D0's shadow settles in no four emissions, and its first edge stores the shadow
  (`Regs::loose`). Planted: the memo not comparing the flag states fails the first test (the assertion, and with the
  assertion off the test's own check); not comparing the register states or `plain` fails two tests each as before
  and now the assertion too; `loose` taken out fails the second test.
- *A test that reaches the `bad` fallback:* not written, because nothing reaches it. A member's entry flags are lazy
  only when every edge into it carried the same setter in the emission before; an edge's setter is its own block's or
  its block's entry state passed on; so the first entry to change from lazy to anything else would need an earlier
  one. Counted: 0 fallbacks in 2,916 regions of several blocks in the boot (594 never settled), 3,946 in the userspace
  run, 4,559 in `smp_user_jit_4` and 22,892 in the pages session (5,375 never settled, 23.5%). The fallback and its
  assertion stay.
- *`Emission`'s doc comment sat on `type Last`.* Moved.

Memory: none (nothing built; the debug assertion emits a kept emission again in debug builds only). Compiled code
unchanged (no x64 counts). The runs: three of 34 s in Node (the gates' guests twice, once more with every callee followed) and 226 s on the
Mac; no CI but the finish's.

## PERF loop 73: the TLB's sibling fill, a collapsed TLBI queue's nG flush, the jump cache's size (2026-11-24)

The three rows PERF loop 72 ranked first. **Two are built and kept, by their counts: a walk fills the same EL's
other data array too, and a collapsed TLBI queue of user operations drops the nG entries instead of everything. In a
Firefox pages session the TLB's misses fall 20.7% (51.4 M → 40.8 M) and the flushes of everything from 2,398 to 8;
no time measure moves outside its noise (`node`, the pages session, the gates), so both are kept as small, tested
changes within the floor, not as measured speedups. The jump cache stays at 65,536 entries.** Data:
`bench/boot/results/perf73/` (README; `summary.txt` has the counts before and after). The Mac: M4, macOS 26.6.2,
Chrome for Testing 158.0.8127.88; the counts' Node runs on the dev VM.

**What was built.**
- *The sibling fill* (`Mmu::miss`, core/src/mmu.rs): after a data access's walk fills its array, the same EL's other
  data array gets the page too when the walk permits that access and the slot there is empty. Not for a Device page,
  nor the write entry of a page of the watched window (those are filled by a write, recorded). The first form filled
  the sibling over whatever its slot held, and was wrong for a copy: a page read and another of the same TLB index
  written (64 MiB apart) then walk at every access, each walk evicting the other page's entry from both arrays. Its
  count on the gates' guests: Alpine's boot 525 K → 437 K misses and the userspace run 998 K → 748 K, but
  `smp_user_jit_4`'s guest 3.15 M → 3.16 M with EL0's read misses 1.14 M → 2.06 M and evictions 1.30 M → 3.61 M.
  Into empty slots only, a fill can't add a miss the base didn't have: boot 455 K (−13.3%), userspace 885 K
  (−11.3%), `smp_user_jit_4` 2.55 M (−19%, EL0 read 0.99 M).
- *The collapsed queue* (`parallel::Collapsed`, core/src/vm/parallel.rs): a queue past 64 operations remembers
  whether everything it held and got since was by ASID or by a VA of the TTBR0 half; its drain then drops the nG
  entries (`flush_ng`) unless the vCPU's TLB holds a global entry in that half (`Tlb::low_global`: a firmware's
  identity map), and everything otherwise, as before. The architecture's side: a TLBI by a TTBR0-half VA or by ASID
  names entries of that half or of an ASID, which are nG ones when the TLB has no global entry there.

**Counts, before (PERF loop 72's) → after, one run each** (the diagnostic core with both changes, `diag.patch`):

| | Alpine's boot | its userspace run | `smp_user_jit_4`'s guest | Firefox's pages session (Mac) |
|---|---|---|---|---|
| TLB misses | 525,032 → 455,226 (−13.3%) | 997,811 → 885,171 (−11.3%) | 3.15 M → 2.55 M (−19%) | 51.41 M → 40.79 M (−20.7%; 529 → 419 per M steps) |
| EL0 read / write | 104 K / 70 K → 76 K / 59 K | 377 K / 292 K → 319 K / 260 K | 1,141 K / 948 K → 992 K / 828 K | 21.56 M / 8.34 M → 19.73 M / 3.80 M |
| EL1 read / write / exec | 126 K / 77 K / 29 K → 110 K / 63 K / 29 K | 49 K / 59 K / 12 K → 35 K / 51 K / 12 K | 297 K / 226 K / 90 K → 126 K / 124 K / 43 K | 3.53 M / 2.60 M / 0.87 M → 1.44 M / 1.30 M / 0.014 M |
| sibling fills (at a read's walk / a write's) | 41 K / 63 K | 69 K / 96 K | 197 K / 233 K | 9.53 M / 2.56 M |
| fills with the page in the other array | 118 K → 48 K | 271 K → 159 K | 992 K → 591 K | 10.63 M → 3.58 M |
| instructions run by helpers | 1.37 M → 1.29 M | 7.33 M → 7.20 M | (not reproducible) | 167.6 M → 153.4 M (−8.6% a step) |
| flushes of everything | 79 → 79 | 33 → 33 | 391 → 153 | 2,398 → 8 |
| collapsed queues; of user operations only | | | 266; 240 → 269; 246 | 2,398; 2,392 → 2,306; 2,298 |
| entries at a collapse (sampled): valid, global | | | 1,593, 1,289 → 17,309, 16,943 | 2,540, 2,032 → 31,786, 31,122 |

The one-vCPU runs are deterministic and their steps didn't move (2,650,367,147 and 10,431,311,691). In the pages
session no collapsed queue found a low global entry in its TLB (0 of 2,298). The misses that went are 10.6 M: at
PERF loop 72's 260-290 ns a data miss, 2.8-3.1 s of the session's ~220 busy vCPU-seconds, **1.3-1.4%** as a bound, of
which EL1's 4.2 M (7.0 M → 2.75 M) are mostly the queue's (its instruction misses, which no sibling fill touches,
867 K → 14 K). What the sibling leaves: 3.58 M fills still find the page in the other array, where the slot held
another page at the first walk (≤ 0.45%; taking them is the evicting form). Its costs, counted: evictions 8.79 M →
9.65 M (primary fills over a sibling's entry), the nG list overflowing in 6.0% of `flush_ng` for 4.9% (7,378 of
122,656 for 5,929 of 121,978; a 128 KiB scan each).

**Time** (the Mac):

| workload | arm | time against the base | pairs / rounds | verdict |
|---|---|---|---|---|
| `node` (`bench/ab-mac.sh`) | the sibling fill | +0.10% [−0.59, +0.79]; cycles +0.09% [−0.42, +0.60]; instructions +0.00% [−0.09, +0.09] | 12 | `open` at the cap: within ±0.8% |
| `node` | `JC` 131,072 | +0.17% [−0.62, +0.97]; instructions −0.01% | 12 | `open` |
| `node` | `JC` 262,144 | +0.40% [−0.74, +1.55]; instructions −0.08% [−0.16, +0.01] | 12 | `open` |
| Firefox's pages session (`bench/gpu/ab-mac.sh`, 3 rounds alternated) | both changes | starts and loads 68.0 / 69.4 / 69.0 s → 68.5 / 67.5 / 68.7 s (medians 69.0 → 68.5, −0.7%); starts 51.4 / 52.4 / 51.9 → 51.9 / 51.3 / 51.8 s; busy MIPS 482 / 470 / 480 → 480 / 478 / 478 | 3 | the rounds overlap: no difference |
| `user` (`WORKLOADS=user,boot bench/ab-mac.sh`) | both changes | +0.09% [−0.41, +0.59]; cycles +0.02% [−0.37, +0.41] `same`; instructions −0.10% [−0.22, +0.03] | 12 | `open` at the cap in time, `same` in cycles |
| `boot` | both changes | −0.02% [−0.48, +0.45]; cycles +0.01% [−0.37, +0.40]; instructions −0.12% [−0.16, −0.09] `LOWER` | 7 | `same` |

The queue's change can only act with several vCPUs in parallel mode, so it had no arm on `node` (one vCPU); the
pages session is its measure and the sibling's confirmation, and one A/B of both against the base served the two.
Neither shows: a bound of 1.3-1.4% that assumes every miss costs its full 260-290 ns is at the session's ~1% floor to
begin with, and the session says the real gain is under it. The session's other counters agree with a small effect:
CPU 279.2 → 280.6 s, the renderer's instructions a step 23.96 → 23.87 (−0.4%, IQR 0.20 and 0.02), the time DSBs
waited 126 / 146 / 103 → 115 / 150 / 142 ms.

**Kept and dropped.**
- **Kept, within the floor: the sibling fill and the collapsed queue's nG flush.** Their counts bounded them at the
  floor (≤ 1.3-1.4% together), the counters show the events they target gone (10.6 M misses and 14 M helper
  instructions a session, 2,390 flushes of everything), nothing regressed, they are small (some 20 and 45 lines of code), each
  rule is tested with a planted bug, and neither takes memory. No speedup is claimed for either.
- **Dropped: the jump cache at 131,072 and 262,144 entries** (+1 and +3 MiB a vCPU). No verdict on `node` (both
  `open`, the larger nominally slower), and the counts take the rest of its case away: the gates' guests refill the
  cache 28-43 K times a run at 65,536 (17-23 K at 131,072, 9 K at 262,144: milliseconds), and the 1.60 M refills of
  `smp_user_jit_4`'s SQLite phase in PERF loop 72's run were that run's placement of two hot blocks, not the
  workload's: 7,195 fills in this loop's run of the same guest at 65,536 (7,264 and 4,404 at the larger sizes). What
  is left is the pages session's 4.1 M refills, ≤ 0.55-0.75% as a bound, under what the session resolves; no pages
  session was spent on it. A finding (docs/jit.md "Dispatch").

**Tests and planted bugs.**
- The sibling: `a_walk_fills_the_sibling_data_array` (a read then a write and the reverse walk once; read-only pages
  at EL1 and EL0 fill no write entry and the write faults; a page made read-only between a read and a write, with
  its TLBI; nG entries dropped with the ASID's; Device memory; a block's two entries counted and dropped by another
  VA's TLBI; a copy between two pages of one index), `a_read_fills_no_write_entry_for_a_watched_page`, the
  random-remap test with read-only pages and blocks, `spill_memory_pages` (the write's walk fills the read array),
  and bare-metal `mmu` (checks 23-29). Planted, each caught: no permission check (two unit tests; `mmu` check 24),
  a watched page's write entry filled at a read, a Device page's sibling filled, the sibling over another page's
  entry.
- The queue: `a_collapsed_tlbi_queue_of_user_operations_keeps_the_global_entries` (core/src/vm/tests.rs: vCPU 0
  runs the TLBIs, vCPU 1 out of the core drains): lists of 64 applied one by one; a collapse of user-half VAs and
  ASIDs (the nG entry gone, the kernel's global one kept); a kernel-half VA or VMALLE1IS before the collapse, at it
  and after (everything); a TLB with a low global entry (everything). It fails on the base (the global entry gone).
  Planted, each caught: the drain not looking at `low_global`, an operation after the collapse not widening it, the
  collapse not looking at its list, or not at the operation that overflowed it, VMALLE1IS or a kernel-half VA taken
  for a low operation, a collapse that drops nothing. No `maint.c` round: a queue collapses only when a vCPU stays
  out of the core through 64 operations, which the unit test arranges exactly and a bare-metal guest on threads
  can't.

Memory: none (the arrays and the queue exist; `node`'s footprint 1,709 MiB against the base's 1,718). Compiled code
unchanged (no x64 counts). No export or state layout changed: the ABI stays 74 and
`target/snapbench/pages.waarm64snap` loads as before. The runs: four counts in Node (36 s each: one of the evicting
form, one of the kept form, two for `JC`), one counting pages session (227 s), the paired run on `node` (4 arms, 12
pairs, 23 min), six pages sessions (22 min), the gates' paired run (10 min).
CI: `ci-fast.sh` (246 s), `ci.sh` (733 s), `ci-jit.sh` (269 s) and `ci-debian.sh` (309 s: Debian through UEFI is
the guest whose firmware fills global entries in the TTBR0 half, the queue's `low_global` branch); `tests/steps.txt`
unmoved.

## PERF loop 74: entries at every member a region's head page has, and the helper's one decode (2026-11-25)

Queue rows 10 and 11 (docs/backlog.md "Entries at a region's members", "The helper decodes its word twice"). **Both
are built and kept. Every member of a forward region where the head's page has it is now an entry of the region's
function, not only a call's continuation: on the Mac `node` −1.42%, the 4-vCPU `smp` −3.14%, the gates −0.49% and
−2.07%, Firefox's pages session 1.5% less CPU and cycles, for less wasm and no memory. The helpers decode their
word once (~0.9 ns a call by its micro-benchmark).** Data: `bench/boot/results/perf74/` (README). The Mac: M4, macOS
26.6.2, Chrome for Testing 158.0.8127.88; the counts' Node runs and the micro-benchmark on the dev VM (Node 26.7.0).

**The counts first, on today's tree** (PERF loop 73's diagnostic core with six slots more, `diag.patch`; one run each),
and with the same core built so that every member where the head's page has it is an entry (`WAARM64_ENTRIES_ALL`),
which costs one line in `Region::entries` and so was counted as built rather than estimated (`summary.txt`):

| | Alpine's boot | its userspace run | `smp_user_jit_4`'s guest | Firefox's pages session (Mac) |
|---|---|---|---|---|
| interpreted steps reported at a key with no function | 126.7 M → 119.5 M | 170.8 M → 157.5 M | 191.7 M → 168.7 M | 2,156 M → 2,054 M |
| of those at a member | 11.1 M → 3.5 M | 20.9 M → 6.6 M | 33.6 M → 9.1 M | 185.1 M → 78.1 M |
| at a member where the head's page has it, no loop | 7.39 M → 0.05 M | 13.55 M → 0.05 M | 24.0 M → 0.05 M | 108.8 M → 0.35 M |
| at a member of a region with a loop; in another page | 2.7 M; 1.0 M | 5.0 M; 2.3 M | 5.5 M; 4.1 M | 43.4 M; 33.0 M |
| regions; headed by a block already a member | 5,565; 939 → 5,123; 479 | 7,649; 1,579 → 6,871; 764 | 9,092; 1,856 → 8,117; 756 | 43,342; 6,532 → 40,824; 3,927 |
| entries made | 3,442 → 14,442 | 4,202 → 18,391 | 4,669 → 20,038 | 22,413 → 113,964 |
| wasm bytes | 18.36 M → 17.92 M (−2.4%) | 24.65 M → 23.71 M (−3.8%) | 27.17 M → 25.66 M (−5.6%) | 152.2 M → 149.6 M (−1.7%) |
| `compileNs` (V8) | −5.9% | −11.6% | −10.2% | −3.3% |
| `emitNs`; `planNs` | +0.2%; −2.6% | −2.9%; −4.8% | +1.3%; −7.1% | −1.4%; −1.7% |
| all interpreted steps (`decSteps`) | −4.2% | −6.0% | −6.2% | −2.3% |
| compiled block, then interpreted code | 4.40 M → 4.26 M | 6.12 M → 5.83 M | 9.47 M → 9.16 M | 138.9 M → 136.2 M |
| static NZCV loads at a condition (`condMemory`) | +11.3% | +9.2% | +9.6% | +39% |

The one-vCPU runs are deterministic and took the same steps in both (2,650,367,147 and 10,431,311,691). Today's
share of the interpreted steps reported at members is loop 72's (pages 8.6% against 8.3%, the boot 8.8%, userspace
12.2%), and the part an entry can take, where the head's page has the member outside a loop, is 5.0% of them in the
pages session and 5.8-12.5% on the gates' guests. As a bound for the page
the counts gave ~0.5%: 87 M interpreted steps fewer at 8.5 ns more each (0.74 s) and 2.6 M round trips at ~140 ns
(0.37 s) of ~220 busy vCPU-seconds, under the session's ~1% floor. It was built anyway because the build was the
count: entries make the regions compiled again (the 15% of the session's regions headed by a member) unnecessary, so
the extension took wasm, compile time and modules *away* on every workload where the backlog expected it to cost
them, which no bound in steps counts; entries per region went from 0.5-0.6 to 2.5-2.8. What it costs is the flags:
an entry's way in is one more edge into its member, with NZCV in memory, so an edge that carried them lazily stores
them now (`condMemory`, the conditions that load NZCV, +9-39% statically).

**What was built** (`Region::entries`, core/src/jit/block.rs): every member where the head's page has it, in a
region without a `loop`, is an entry (before: a member after a call, the call's continuation). The rest (the prologue's
branch to an entry's member with its registers loaded and its flags in memory, the entry number in the jump and
transfer caches' words, the checker hashing the whole region at an entry, the map's entries installed with the
region) existed for the continuations and serves any member. Members of a region with a `loop` stay without (PERF
loop 51: inside the wasm `loop`), and so do members in another page (their edges' unchecked mapping relies on entering
at the head's page).

**Time** (the Mac):

| workload | arm | time against the base | cycles | instructions | pairs / rounds | verdict |
|---|---|---|---|---|---|---|
| `node` (`bench/ab-mac.sh`) | every member an entry | −1.42% [−2.42, −0.41] | −1.22% [−1.74, −0.69] | +0.50% [+0.47, +0.53] | 6 | `LOWER` |
| `smp` (4 vCPUs, same run) | every member an entry | −3.14% [−6.03, −0.16] | −0.59% `open` | +1.63% `open` | 10 | `LOWER` |
| Firefox's pages session (`bench/gpu/ab-mac.sh`, alternated) | every member an entry | starts and loads 68.6 / 68.4 / 67.3 → 67.7 / 66.5 / 65.6 s (medians −2.8%, one round overlapping); CPU 279.4 → 275.1 s (−1.5%), cycles 945.9 → 932.1 G (−1.5%), neither overlapping; busy MIPS 481 → 487 | | instructions +1.4% | 3 | CPU and cycles lower |
| `user` (`WORKLOADS=user,boot`) | both changes | −0.49% [−0.90, −0.08] | −0.87% [−1.39, −0.34] | +1.55% [+1.36, +1.75] | 9 | `LOWER` |
| `boot` | both changes | −2.07% [−3.57, −0.54] | −1.53% [−2.49, −0.57] | −0.08% `same` | 6 | `LOWER` |

The pages session's other counters: modules 2,729 → 2,684, wasm 119 → 118 MB, `emitMs` 1,819 → 1,756, `planMs` 665
→ 636, interpreted steps 3.49 → 3.40 G, the lock taken 17.5 → 17.1 M times. More instructions for fewer cycles: the
flags stored on the way into members are cheap stores, and what goes is interpreted steps and dispatches. On `node`
the wasm 47.69 → 47.26 MiB, modules 1,461 → 1,417, interpreted steps −3.9%, `emit` −2.7%, `compile` −3.8%.

**Memory: none.** The verdict's footprint column averages a bimodal measure: in each pair the session that runs
second reads ~520 MiB (`node`) or ~750 MiB (`smp`) more, in either arm (the first arm's idle pages are in it), and
the random order put `new` second in 8 of `smp`'s 10 pairs. By position: `smp` first 1,749-1,837 (base) and
1,809-1,818 MiB (new), second 2,551-2,636 and 2,522-2,662; `node` 1,125 against 1,115-1,121 first, 1,643-1,647
against 1,640-1,646 second; the gates 954 and 854 → 954 and 851. An entry's key is mostly one the map held already
(its member ran interpreted before it was compiled); what it adds is a word in its head's list of linkers.

**Row 11, the helper's second decode** (`jit_exec_flat`/`jit_exec_mmu` decoded the word for the interpreter's
`exec` and again for the helper histogram, `jit::count`): the word is decoded once and the `Op` passed to both
(`interp::exec_at_decoded`). Its micro-benchmark (`helper.c`: 1 M iterations of 8 `LDSMAX`, which has no inline form,
each a `jit_exec_mmu` call, with the MMU on; PERF loop 21's runner, Node on the dev VM, alternated, medians of five
runs): **246.8 / 246.6 / 246.4 → 239.1 / 238.7 / 242.9 ms, −3.0%, the rounds apart**: ~0.9 ns a call of the ~30 ns
the loop takes per `LDSMAX`. At the pages session's 168 M helper instructions that is ~0.15 s, ~0.07% of its busy
time; the gates' run above carries it (with the entries). The helpers grew ~1 KB each (`jit_exec_mmu` 14,466 →
15,508 bytes: the decode is inline in them now).

**The code** (`codestats.json`: `bench/jit/codestats.ts` on the modules of Alpine's boot, dumped by each core, every
function in TurboFan): 317 modules and 6,677 functions → 300 and 6,061. In all, arm64 7.71 M → 7.65 M instructions
(−0.8%), 29.26 → 29.07 MB of code (−0.6%), frame memory operands −4.0%; x64 6.044 M → 6.049 M instructions (+0.1%),
26.52 → 26.65 MB (+0.5%), frame memory operands −0.7%, stack slots −10%. Per function +9-11% (fewer functions, each
with the entries' prologue and the members it no longer leaves to another function). Deterministic and realtime
round-robin's code changes with the rule as parallel SMP's does (the same regions and entries); `tests/steps.txt`
doesn't move.

**Tests and planted bugs.** `a_member_a_branch_reaches_is_an_entry` (block.rs: a region whose members only branches
reach has them all as entries, with their numbers and lengths in `Emitted::entries`); tests/jit.test.ts "a region's
member is an entry: run from outside, it isn't compiled again" (a member that the head reaches by `b` with its flags
lazy from a `subs`, entered by the PC from outside with NZCV in the `Cpu` both ways: it runs compiled, branches by the
`Cpu`'s flags, with X3 from the `Cpu`, and no region is compiled for it); the existing tests' entries updated (a
callee taken and what its `ret` returns to are entries too). Planted, each caught: entries only at continuations
again (the JS test: a region compiled for the member), the entry's way in not taking the flags from memory (the JS
test: the branch taken the wrong way), the head's-page condition dropped (`an_aliased_continuation_is_no_entry`),
entries in a region with a `loop` (`a_call_not_taken_returns_to_an_entry`, `flags_cross_region_edges_lazily`). Row
11 changes no behavior (the histogram's counts are the tests' already).

Next, untried: an entry costs a member whose flags arrived lazily their store on that edge (the +0.5% instructions on
`node`); a member whose every edge carries lazy flags and that nothing outside enters often could stay without, which
needs the emission's flag states before the entries are chosen (they are chosen first, for the map and the
imports). The members left without entries interpret 77 M steps in the pages session (loops 43 M, other pages 33 M),
~0.3% of its busy time at most.

The runs: two counts in Node (35 s each) and two counting pages sessions (225 s each); `node` and `smp` paired (6 and 10
pairs), six pages sessions (22 min), the gates paired (9 and 6 pairs); the micro-benchmark (3 rounds of 5 runs each
arm); the static counts (5 min). CI: `ci.sh` (726 s) and `ci-jit.sh` (274 s); `tests/steps.txt` unmoved. No export or
state layout changed: the ABI stays 74. Also fixed on the way: `bench/mac-packages.sh` sends `tools/remote-chromium.ts`
to the Mac, which `bench/gpu/guest-session.ts` imports since 157831d4 (every Mac pages session failed at its start).

## PERF loop 75: loop 74's review, probes a region's earlier block made, Liftoff's fill at 64 blocks (2026-11-25)

The out-of-context review of loop 74's entries (`review/jit-entries`, ff930add: static, nothing run), then queue rows
12 and 19, which both start with a count on the same workloads and shared one diagnostic core. **The review's one
defect is fixed (a caller of an entry the map had no room for outlived that entry's region), its performance claim
is counted at ≤ 0.2% of Firefox's pages session and recorded, and both rows close as findings under the floor:
probes that an earlier probe of the region already made are 0.4-0.7% of the probes with today's entries, and X
registers sharing locals would save ~0.25% of the boot at best.** Nothing that changes compiled code was kept. Data:
`bench/boot/results/perf75/` (README).

**The review's findings.**
1. *A region that calls an entry `Cache::entry` couldn't file isn't dropped with that entry's region* (the latent
   lost invalidation). Confirmed: the filing half of `Cache::install` is `Cache::file` now, callable natively, and
   `a_caller_of_an_entry_not_filed_goes_with_its_region` (`jit/mod.rs`) fills the map to its bound
   (`at_the_bound`, factored out of `an_entry_filed_by_an_install_keeps_the_bound`), files R (head and member m in
   page P) and R2 (page Q, linking m), and invalidates P. Against loop 74's filing it failed twice: no checker words
   for m (JIT-check's `jit_check(m)` would index a missing span and panic), and with that assertion off, "the region
   calling the entry stayed compiled". Fixed: the checker's words go in for every entry, filed or not, and an entry
   not filed hands its linkers to its region's head (after the whole module is filed, so a later region's link
   counts too; a prune would have dropped them, keyed by a key not in the map). Reachable only in the forced and
   JIT-check modes with the map at its bound, as the reviewer said; no guest-visible change.
2. *A loop head taken as a member is frozen as an entry and never gets a loop region.* Counted, not changed. The
   diagnostic core counts every backward transfer that lands at an entry (a chain, a by-VA link or a jump-cache hit
   whose word has an entry number), whatever its cause: 1.3 M in Alpine's boot, 10.4 M in its userspace run, 38.6 M
   in `smp_user_jit_4`'s guest and 40.9 M in the pages session, against 56 M, 141 M, 409 M and 1,310 M loop
   back-edges (and 8.5 M, 45 M, 162 M and 352 M ways in at an entry in all). At ~10 ns each more than a `br` that is
   ≤ 0.2% of the session's ~230 busy vCPU-seconds. Loop 74's own two cores bound what that loop moved more tightly:
   their back-edges per step differed by +0.02%, −0.14%, −0.9% and −0.44% (≤ 6 M laps of the session, ~0.03%), and
   the session measured 1.5% less CPU with the cost inside it. docs/jit.md "Entries" records it with the fix's shape
   (ask `plan` about loops across pages, or count an entry's ways in) should it ever count.
3. *Comments and docs the change made wrong:* `Cache::plan`'s doc, `Region`'s, `ENTRY_SHIFT`'s, `ENTRY_BIT`'s,
   `Cache::entry`'s, docs/jit.md's line on what decodes a helper's word again (only `fast` since loop 74) and its
   sentence on aliased entries (what is fixed at formation, and what the mapping argument then gives) corrected.

Of the three it found suspicious: **the checker at an entry hashed the whole region**, so a head rewritten without an
IC failed a way in that never runs it (a test mode's false positive). Changed: an entry's words are its member's and
the later members' (an entry is in a region without a `loop`, so nothing before it runs), which
`the_checker_at_an_entry_reads_what_it_can_run` covers (planted back to the whole region: the entries' checks fail).
**A followed callee entered from outside** is correct, as the reviewer found (it costs a frame when X30 matches).
**An entry overwriting a compiled key's word** happens only where the forced and JIT-check modes take compiled
blocks as members; conservative, now said in docs/jit.md "Compile policy".

**Row 12, probes a region's earlier block already made** (and the translation memo again). The core runs a dataflow
over each region's edges (each member's edges in, a host call's continuation, a predicted return; a loop's head
knows nothing) and walks each member's instructions: a probe whose base register is unchanged or moved by an
immediate (SP by multiples of 16, `mov` and `add` copying a base) since probes on every path in covered a range
holding its own, in the write array if it stores, is counted, weighted by the member's runs. Three variants: today's
entries (an entry's way in knows nothing), entries whose way in probed again, and that plus SP and X19-X29 keeping
their ranges across host calls (which would need a check of the register: the memo's shape).

| | Alpine's boot | its userspace run | `smp_user_jit_4` | Firefox's pages session (Mac) |
|---|---|---|---|---|
| immediate probes run (a step) | 404 M (0.152) | 1,966 M (0.188) | 6,473 M (0.195) | 21,759 M (0.210) |
| made earlier in the region, today's entries | 0.64% (SP 0.29) | 0.59% (SP 0.37) | 0.43% (SP 0.28) | 0.68% (SP 0.22) |
| entries probing again | 4.74% | 3.84% | 3.26% | 4.83% |
| and SP, X19-X29 across host calls | 11.81% | 9.11% | 6.98% | 11.71% |
| made earlier in the same block, no group | 1.33% | 1.10% | 1.12% | 0.70% |
| static: today's / probing again / across calls | 1.1 / 6.0 / 17.6% | 1.2 / 5.7 / 16.9% | 1.2 / 5.4 / 16.0% | 1.3 / 5.0 / 14.9% |

X29 bases are ≤ 0.05% everywhere; loop regions hold 12-30% of the probes but few dominated ones (the head knows
nothing at each lap). Probes are ~10% of the wasm, so the static shares are ~0.1%, ~0.5% and ~1.5% of it, and none
of it is a region or a module (loop 74's lesson: nothing compiled goes away but probes). At a generous 0.5 ns a probe
(the groups took ~26 points of probes and moved no time) the three are ≤ 0.03%, ≤ 0.23% and ≤ 0.55% of the session,
the last before its checks: **closed, no bound built** (the brief built the unsound bound only past ~1%). The
translation memo's probes are the same 0.21 a step, and a hit would save part of a TLB hit at best (it lost by
2-13% in the VM at M8): under the floor too. **Parallel SMP**: nothing changes a vCPU's TLB while its compiled code
runs (another vCPU's TLBI is applied by this vCPU's own run loop, `drain`, at a chunk's end; a failed poll leaves the
function), so a poll between two probes changes nothing they share.

**Row 19, Liftoff's zero-fill and X registers sharing locals at 64 blocks.** Loop 27's model ported into the same
core (each X register's local dropped after its last touch, non-overlapping ones sharing; looped regions keep
theirs), counted at every call of a function that fills (more than 12 locals, or one not i32/i64; two turns a local):

| | Alpine's boot | its userspace run | `smp_user_jit_4` | pages session |
|---|---|---|---|---|
| calls of filling functions, per 1000 steps (loop 27) | 26.3 (35.5) | 37.0 (41.1) | 38.4 | 29.8 |
| turns a call (loop 27) | 44.9 (43.4) | 42.1 (42.6) | 40.4 | 42.9 |
| turns a step (loop 27) | 1.18 (1.54) | 1.56 (1.75) | 1.55 | 1.28 |
| fewer turns with sharing (loop 27, region model) | 11.6% (14.9%) | 11.0% (13.5%) | 14.6% | 9.8% |

The 64-block functions are entered less often and fill about as many turns a call, so the fill runs 24% fewer turns a
step in the boot and 11% fewer in userspace than at loop 27; with loop 26's measured cost (2.8% and 1.7% then) the
fill is ~2.1% and ~1.5% now and sharing would save ~0.25% and ~0.17% at best, before the costs loop 27's model leaves
out: **closed**.

The runs: the gates' counts twice in Node (35 s each; the second core adds finding 2's counters, the shared counts
are the same), two counting pages sessions (286 s each). No A/B: the kept changes don't change compiled code
(filing an entry the map has no room for, and the checker's words in the check mode). Tests: the two above, each
failing first; `tests/steps.txt` unmoved; no export or state layout changed, the ABI stays 74. CI: `ci.sh` (736 s) and `ci-jit.sh` (270 s).

## PERF loop 83: what wakes an idle vCPU, and its poll before it sleeps (2026-11-26)

The queue's row 17 (PERF-HANDOVER.md, from a static survey): a device completion or a host signal bumps every vCPU's
wake word, so each other idle vCPU wakes, enters the core, finds the signal taken, returns `IDLE` with nothing retired
and polls `SPIN_MS` before it sleeps again. **Counted: those empty exits are ~300 a second in Firefox's pages session,
~1.7% of one host core at most on the Mac, and under one a second in an idle guest; waking one taker instead (M) and
skipping the poll after an empty exit (S) are not built. The poll itself was the larger cost: it ended in a wake-up
for 12% of the idles in the pages session and none in an idle guest. Kept: a 20 µs poll instead of 50 (web/idle-wait.ts
`SPIN_MS`): the pages session's renderer CPU −2.8% (energy −3%), an idle 4-vCPU guest's host CPU −12%, the parallel
boots' CPU −1.2 to −4.0%, the guest's speed unchanged everywhere and the futex hand-offs the poll is for as fast.** Only
web/ changed (the vCPU worker's idle path and a `vcpuSpinUs` knob, `?vspin=<µs>`); the core, compiled code,
deterministic and round-robin runs and `tests/steps.txt` are 0c7707e7's. M4, macOS, Chrome for Testing 158.0.8127.88,
Node 26.10.0 there; nothing else on the dev VM. Data: `bench/boot/results/perf83/` (its README).

**The counts** (a diagnostic build, `diag.patch`: the core tallies each run-loop entry after an `IDLE` by whether its
wake word moved, the `IDLE` exits that retired nothing after it, the signals taken and `Vm::wake` by caller; the worker
times the empty exits' core round trip and every poll, and whether a wake-up ended it; `python3 wakes.py`; a second
each, summed over 4 vCPUs):

| | pages session (Mac, Chrome) | `smp_alpine_jit` n4 (VM, Node) | `smp_user_jit_4` (VM) | idle guest (VM) |
|---|---|---|---|---|
| entries woken / after a timed sleep | 1,166 / 677 | 936 / 1,021 | 642 / 457 | 0.8 / 400 |
| **of them, `IDLE` again with nothing retired** | **297** (2 the device signal's taker) | **242** (19) | **138** (29) | 0.6 |
| device / RX signals taken | 110 / 50 | 97 / 0 | 65 / 0 | 0.2 / 0 |
| the host's wake-word bumps; the core's (IRQ rises) | 641; 2,733 (2,667) | 389; 2,909 (2,802) | 262; 3,697 (3,660) | 1; 400 (400: its own timer) |
| an empty exit's cost: core round trip + poll | 11.4 + 47.2 µs | 3.4 + 46.9 µs | 3.4 + 42.4 µs | |
| **the empty exits, of one host core** | **1.74%** | 1.22% | 0.63% | 0 |
| their polls ended by a wake-up | 16% | 5% | 30% | |
| **every poll: a second, of one core, ended by a wake-up** | **1,843, 8.96%, 12%** | 1,957, 8.78%, 10% | 1,099, 4.61%, 21% | 401, 1.86%, 0% |

The idle guest's exits are WFIs to their timers (its 400 core wakes a second are each vCPU's own timer line, raised
while it runs): nothing wakes it early, so no exit is empty and no poll ever catches a wake-up. Where devices complete,
the broadcast does make empty exits, but their bound is 1.7% of a core of host CPU and none of the guest's speed (the
vCPUs it wakes were idle). **M** (one taker) saves at most that and needs a new no-missed-wake argument and a taker
that isn't stalled (a single woken vCPU in a GC or an event-loop visit would hold every completion); **S** (no poll
after an empty exit) saves at most the polls' share, ~1.4%, and those polls end in a wake-up as often as any (16%
against 12%): a partial poll cut, which the sweep below covers. Neither is built.

**The poll's sweep** (`vcpuSpinUs`, new: `VmOptions`, the page's and the bench pages' `?vspin=<µs>`, idle-cpu.ts's 4th
argument). An idle 4-vCPU guest's host CPU (`bench/boot/idle-cpu.ts 4 5 20 <µs>`, the Mac's Node, 3 rounds rotated,
`idle-mac.txt`), % of a core: 0 µs 6.09-6.80 (median 6.30); 20 µs 7.15-7.86 (7.42); **50 µs (before) 8.26-8.49
(8.47)**; 100 µs 9.82-11.41 (10.30). In the dev VM 50 → 20: 11.8-12.1 → 10.8-11.0. The futex hand-offs the poll was
made for (M7 loop 8): the atomics stress's `pingpong` (two pairs of threads, 20,000 hand-offs each, through a mutex
and a condition variable) on 4 vCPUs (`pingpong.ts`; the Mac's Node, 3 rounds; LSE's / LL/SC's s): 0 µs 0.55 / 0.51;
10 µs 0.23 / 0.17; 20 µs 0.22-0.23 / 0.17-0.18; 50 µs 0.21-0.22 / 0.16-0.17; 100 µs 0.21 / 0.16-0.17: ~11 µs a
hand-off with any poll from 10 µs, 2.5× that with none. In the dev VM 10 µs isn't enough (1.27-1.32 / 0.93-1.04
against 0.27-0.37 / 0.21-0.25 at 20 and 50; 1.72 / 1.66 at 0): 20 µs is the least that keeps the hand-offs on both.

Firefox's pages session from `pages.waarm64snap` (`bench/gpu/ab-mac.sh`, 3 rounds, each round starting with the next
arm; median [range]; `cpuS` the renderers' CPU over the session, `proc`):

| | 50 µs (base) | 0 µs | 20 µs (kept) |
|---|---|---|---|
| the starts and the pages' loads (s) | 67.8 [65.7-69.5] | 66.8 [65.6-67.5] (−1.5%, overlapping) | 66.6 [66.1-67.0] (−1.8%, overlapping) |
| **the renderers' CPU (s)** | 274.6 [273.2-283.1] | 258.8 [256.5-260.5] (**−5.8%**, no overlap) | 266.8 [265.7-267.4] (**−2.8%**, no overlap) |
| their instructions (G) | 2,296 [2,295-2,301] | 2,003 [1,995-2,009] (−12.7%) | 2,143 [2,126-2,148] (−6.6%) |
| energy (J) | 800 [783-804] | 743 [736-757] (−7.1%) | 772 [771-779] (−3.5%) |
| busy MIPS; modules; stalls of 20 ms+ | 490; 2,662; 2 | 485; 2,664; 1 | 487; 2,652; 0 |

The paired A/B's multi-vCPU workload (`WORKLOADS=smp bench/ab-mac.sh`, four copies of jitjit.js on 4 vCPUs, 12 pairs,
the cap; `ab-smp/verdict.txt`), against 50 µs, wall: 0 µs +0.00% [−2.26%, +2.32%], 20 µs −0.62% [−4.02%, +2.89%],
100 µs −0.55% [−4.60%, +3.66%], all open (the workload's wall is that noisy; the CPU a step −0.3 to −0.6%, open): no
arm moves it. The parallel boots in Chromium (`gates.sh 3 50 20`, `bench/run-mac.sh`, 3 rounds alternated; ranges of
the rounds' medians, ms; `python3 ../perf53/summary.py gates p83 s50 s20`):

| | 50 µs | 20 µs | |
|---|---|---|---|
| `smp_alpine_jit` n1 / n2 / n4 total | 5000-5045 / 4708-4735 / 4679-4702 | 5042-5055 / 4701-4713 / 4684-4741 | +0.2 / +0.0 / −0.2%, overlapping |
| their CPU (ms) | 5222-5293 / 6135-6191 / 7349-7469 | 5260-5290 / 6026-6047 / 7149-7190 | −0.1 / **−1.9 / −4.0%**, the last two no overlap |
| `smp_user_jit_4` total; its CPU | 10547-10689; 33185-33325 | 10573-10738; 32752-33048 | +0.0%, overlapping; **−1.2%**, no overlap |

Not run: the paired command's `node`, `user` and `boot` workloads (deterministic round-robin: the vCPU worker, the only
code changed, doesn't run there). **Kept: 20 µs.** 0 µs would save twice the CPU (the pages session −5.8%, the idle
guest −26%) and the pages session didn't slow, but a guest that hands work between CPUs through futexes would run
those hand-offs 2.5-5× slower; 20 is the least poll that kept them in both hosts. Memory: none. A next step, not
taken: a poll that adapts per vCPU (none after idles whose polls haven't caught a wake-up lately), which the idle
guest's 0% and the pages session's 12% suggest; its bound is the rest of the poll's cost, ~5% of a core on the pages
session and 1.1 points of the idle guest (docs/backlog.md).

Tests: `tests/idle-wait.test.ts` "an idle polls its wake word for its spin (`spinMs`) before it waits, and none at
0" (the first wait starts after the poll, a wake-up within it ends the idle without a wait); planted bug, caught: `idle`
polling `SPIN_MS` whatever `spinMs` says (1 fails). The plumbing to the page and the bench pages showed in the runs
(each arm's CPU moved with its `vspin`); `tests/knobs.test.ts` pins `?vspin=` (it failed first, unpinned). A flake
`scripts/ci.sh` showed meanwhile, fixed: the guest agent's GROW test sent a disk's two GROWs apart, and when the
agent reaped the first's child before reading the second it answered both (agent/src/serve_test.rs; now one write, so
one read; with a 50 ms gap between the sends the old form fails every time). CI: `scripts/ci.sh` (736 s),
`scripts/ci-jit.sh` (245 s) and `scripts/ci-debian.sh` (333 s) passed, each alone.

## PERF loop 85: a load's start and a save's 3D read-back (2026-11-26)

The PERF queue's row 20 (docs/backlog.md "Snapshots": "What is left of a load's start", "What stays on the machine
worker during the pause"): three parts, each measured before anything was built. The dev VM (M4, Lima, 8 vCPUs),
Chromium 155.0.8059.84 headless (SwiftShader), the persistent profile `target/snapz/profile`; the Mac host, Chrome for
Testing 158.0.8127.88 headless on its GPU (ANGLE Metal, Apple M4). Raw: `results/perf85/` (`diag.py` and `diag/`,
the marks on loop 84's tree and what they gave; `diag-new.py`, the same on this loop's; `rounds/` and
`ab-desktop.txt`, the probe's A/B, `run-ab.sh` its driver; `mac-probe/`, `vm-readback/`, `mac-readback/`;
`tools/`, the one-off measurements; `summary.json`).

**What each part was** (`diag.py`: `[d85]` marks on the page, the GPU worker, the device worker, the machine worker's
HEAD and the renderer's read-back; the desktop's warm snapshot through `bench/snapz/probe.ts`, `OPS=load,kept`):

| part | measured | share |
|---|---|---|
| the start message waiting for the GPU worker's caps | the page's `Runner.start` to the GPU worker's `ready` 80-138 ms, then the lock, the disks and the folders 2-3 ms, then the start | see below: hidden behind the machine worker's own module load |
| two HEADs a remote disk | dev server 1-2 ms each; a demo's chunked disk (disks.waarm64.com, `tools/demo.ts`): the machine worker's HEAD 1.5-2.2 ms and the device worker's manifest GET 1.0-1.5 ms, both from the browser's cache (the page's own check GETs the manifest, `max-age=300`); **a plain file on a server** (`tools/heads.ts`): every HEAD a round trip, 36-89 ms from the dev VM (a HEAD is never answered from the cache, an `immutable` file's either), and the device worker's sync one is on the start's path (`Devices.open`) | one round trip a remote plain disk a start: ~3-7% of a 1.2 s load; under the floor for the demos |
| the 3D read-back copying each level twice | the kept save's `state` 206-224 ms: `readPixels` 75-79, the packing 73-75, the rest (allocations, buffers' copies, objects, transfer) ~60; by format (`diag2-desktop.log`), the three 2048² R8 glyph atlases 85 ms of it (34 ms reading RGBA, four times their bytes, 51 ms packing them in JS at ~4 ns a byte), RGBA8/BGRA8 88 MB a plain second copy | ~15% of the 0.99 s pause |

**Built:**
1. **The read-back reads a level straight into the saved bytes** when the GL reads it as stored (web/virgl-renderer.ts
   `readsAsStored`, docs/graphics.md "Snapshots with 3D in use"): the format's reader reads its own upload format and
   type at its size (RGBA8 and the BGR formats on it, RGB10_A2, the 32-bit RGBA ones), or the GL's own read pair
   (`IMPLEMENTATION_COLOR_READ_FORMAT`/`_TYPE`, asked once per internal format) is that pair: R8 as RED bytes, RG8 as
   RG, RGB565 and RGBA4 as shorts, the same on SwiftShader and on the Mac's Metal (`tools/readfmt.ts`). A packed box
   only (a guest's strided read is packed as before); the scratch buffer is made only for the others. A guest's packed
   read-back takes the same path. `bench/snapz/readback.ts` (new: the desktop's 40 levels, 103 MB, loaded into a
   renderer in the page and saved; 5 saves a round, a browser a round, arms alternated), medians of the rounds'
   medians, ms:

   | | base (bc6852bf) | new | |
   |---|---|---|---|
   | dev VM, SwiftShader, 5 rounds | 143.0 (141.2-155.7) | 44.1 (42.3-46.4) | 3.2x |
   | Mac, Metal, 5 rounds (`readback-mac.sh`) | 130.6 (127.2-131.9) | 39.2 (38.9-40.2) | 3.3x |

2. **One HEAD a remote disk a start:** the machine worker's check (`checkDisks`) keeps each server's answer (size,
   validator: `DiskHead`), and the device worker's `httpSource` takes it from the disk's spec (`BlkSpec.head`,
   web/app/worker-devices.ts `finishSpecs`) instead of its own sync HEAD (docs/devices.md "blk"). Not measured on the
   probe (its disks are the dev server's, ~1 ms a HEAD): the gain is the round trip above, for a plain file on a
   server; the demos' chunked disks had none to lose.
3. **The start message goes without waiting for the GPU worker** (web/app/run/runner.ts `#gpu`): the caps go in it if
   the GPU worker was ready first, else in a `caps` message after it, which the machine worker waits for before it
   makes the devices (`startCaps`: after its fetch and a snapshot's check pass, before anything is touched); a GPU
   worker that fails after the start ends that worker and the machine starts again as 2D, as before. Measured
   (`diag-new.py`): the page now posts the start 8-17 ms after `Runner.start`, but the machine worker's own module
   load (the dev server compiles its graph per request) ends ~95-110 ms after it, beside the GPU worker's (~100 ms
   to its `init`, 15 ms to `ready`): on the dev server the two loaded side by side before too, and the wait was
   mostly hidden. The probe's load (below): the dev VM 1,166 → 1,159 ms, the Mac 801 → 791 (−0.6%, −1.2%, within or
   at the floor). Kept as small and tested: a fresh browser's first WebGL2 context on the Mac's GPU takes 27-178 ms
   (`tools/glstart.ts`; 10 ms on SwiftShader), so where the machine worker's modules load faster than that (a
   build's bundle, not measured: the dev VM's `npm start` serves the user's) the start no longer waits on it.

**The probe, before and after** (desktop, the dev VM, `OPS=load,kept`, `SETTLE_S=20`, a browser a round, base new new
base base new new base; medians (ranges) of 4, ms; memory = the browser's RSS at the save's peak over the sample
before it, MiB):

| | base (bc6852bf) | new |
|---|---|---|
| load: wall (the file chosen to `running`) | 1,166 (1,155-1,259) | 1,159 (1,155-1,162) |
| ... the worker's `total` | 963 (951-1,107) | 970 (951-971) |
| kept snapshot: paused | 993 (982-1,026) | **874** (862-887) |
| ... `state` (the 3D read-back in it) | 222 (215-227) | **107** (104-109) |
| ... memory added | +151 (141-184) | +128 (123-128) |

The pause 12% shorter, the save's memory 23 MiB lower (no scratch buffers). On the Mac (`mac-probe/`,
`bench/snapz/probe-mac.sh`, new: `OPS=load`, 3 rounds an arm, base's first the profile's first): load wall 801
(798-1,082) → 791 (756-793); the warm snapshot's caps are SwiftShader's, so it loads with 3D off there and the
Mac's pause has no 3D state to measure (the read-back's Mac numbers are `readback.ts`'s, above).

**Tests:** tests/virgl.test.ts "a read-back of texels the GL reads as stored goes straight into the bytes…" (a mock GL
whose `readPixels` answers by position and layer: an array's layers at their places, a strided read at its stride,
R8 straight with RED as the read pair and packed without, the same bytes, another read type not straight); the
browser's snapshotFormats ("every format's contents… saved as they were loaded") and the trace saves on SwiftShader;
tests/sync-xhr.test.ts (an HTTP source opened with a HEAD makes none; without, one); tests/worker-devices.test.ts
(new: `finishSpecs` puts the late caps and each URL disk's HEAD on its device and nothing else; `startCaps`);
tests/page-template-first.test.ts (the stand-in GPU worker failing before the start and after it, the 3D restore
ended without caps and a boot after it; ready after the start, its caps following and the restore going on;
tests/demo-fixture.ts's stand-in machine worker answers a 3D start without caps only once they come);
tests/page-restore.test.ts's "a start opens its machine's record as it is once it holds the machine's lock" made its
window with the GPU worker's start, which no longer comes first: it now holds the start's take of the lock instead
(planted: the record not read again under the lock, caught). **Planted
bugs**, each caught, the source restored: the straight read for any stride (the strided assertion), every layer into
the first (the mock test and snapshotFormats), the read pair matched by format alone (the read-type assertion),
`httpSource` ignoring the head (sync-xhr), `finishSpecs` not passing the head (worker-devices), `startCaps` taking
the start's caps only (worker-devices), the start never owing its caps (the template's late-caps test).

**The probe itself:** it leaves the page by a navigation at its end (a closed browser left the running machine's mark,
which held the next run's autostart on "the tab closed while it was running") and drops a leftover mark first; it
reads no memory where there's no /proc (the Mac).

CI: `scripts/ci.sh` (708 s; its first runs failed on two files past the page's 300 lines and on
tests/page-restore.test.ts's window, both fixed above), `scripts/ci-debian.sh` (258 s), `scripts/ci-machines.sh`
(335 s), `scripts/ci-graphics.sh` (318 s) and `scripts/ci-deqp.sh` (655 s) passed, each alone.


## PERF loop 88: round-robin's chunk ends, the publication and ERET and exceptions in place (2026-11-28)

The queue's row 22: deterministic round-robin's run loop published every counter at every chunk's end (`Vm::publish`)
and ended the chunk at every unmasking ERET, SVC and abort, the gates' own cost (the page runs parallel SMP, whose
publication is throttled and whose ERETs finish in place already). Raw: `results/perf88/` (the diagnostic counts
`counts-base.json` and `counts-new.json`, the publication's cost `publish-*.json`, the Mac A/Bs `gates-ab.json`,
`node-ab.json` and their verdicts).

**Counts** (the diagnostic core, `bench/boot/preempt-counts.ts boot user`, Node on the dev VM, deterministic, 1 vCPU;
loop 49's had been taken before 64-block regions):

| chunk ends | boot (2.65 G steps) | userspace (10.43 G) |
|---|---|---|
| all | 604,712 | 1,362,450 |
| the chunk's steps (budget, deadlines) | 68,514 | 314,276 |
| `Exit::Resync` (an unmasking ERET; DAIF writes stay inline) | 249,095 | 445,346 |
| SVC / other exceptions (aborts) | 112,106 / 47,666 | 136,718 / 89,571 |
| platform (the GIC's IAR and EOIR, two an IRQ) | 89,689 | 339,132 |
| device (MMIO) | 29,894 | 29,861 |

**What one publication costs:** a diagnostic core calling `publish` ten more times at each chunk's end took the
userspace gate from 10.70 · 10.85 s to 11.33 · 11.30 s: ~41 ns a call (~40 relaxed stores and the JIT's `Stats` copy),
so ~55 ms of the gate at 1.36 M calls, ~0.5%; a bound at the floor. The rest of a chunk end (the run loop's top:
the signals, the xHCI's tick, the timer lines, the pick, the IRQ check, the chunk's set-up; `jit::steps`' exit and
re-entry) is what finishing an exit in place saves: ~670 K of the userspace gate's ends and ~410 K of the boot's.

**What was built:**
- *The publication throttled*, as parallel SMP's `publish_cpu`: the steps and the PC at every chunk's end, the JIT's
  and the TLBs' counters every `JIT_PUBLISH` (65,536) steps and at the run's end (and after a restore).
- *ERET and exceptions in place* (`vm::rr_fast`, a round-robin `jit::Fast` hook, set for a chunk only where
  `Unmask::ok` is, and checking the signal byte): an ERET's `Exit::Resync` from its helper retires and its block goes
  on to its indirect exit, as parallel SMP's `fast` does; and what `jit::steps`' dispatcher would return, an
  `Exit::Resync` or an SVC, an instruction abort or a data abort (not an MMIO access's, `FaultKind::Bus`), is
  finished there (`jit::at_dispatcher`, the hook called with `jit::DISPATCHER` as the instruction: the exception
  taken and counted by EC as `Vm::exception` does) and the dispatcher goes on from the new PC within the same chunk.
  A helper's abort is never finished in place: its block would go on past the access. Not in polled code. Compiled
  code is unchanged (no emitter change), so the static counts are the base's.

After: chunk ends 604,712 → 216,680 (boot) and 1,362,450 → 723,697 (userspace); in place 246,531 Resyncs and 159,768
exceptions (boot), 441,663 and 226,285 (userspace). Steps don't move: Alpine 2,650,367,147 and the userspace
benchmark 10,431,311,691, as in tests/steps.txt; IRQs taken identical (42,060 and 166,780).

**The gates** (the Mac host, M4, Chrome for Testing 158.0.8127.88 headless; `bench/ab-mac.sh`, `WORKLOADS=user,boot`,
three arms: `base` c9f69b80, `thr` the throttle alone, `new` both):

| | `thr` against base | `new` against base |
|---|---|---|
| `user` (12 pairs, the cap) | wall −0.18% [−0.90%, +0.54%] open; instructions −0.35% LOWER | **wall −0.41% [−0.80%, −0.01%] LOWER**; cycles −0.38% [−0.68%, −0.09%] LOWER |
| `boot` | 12 pairs: wall −0.12% [−0.46%, +0.23%] **same** | 6 pairs: **wall −0.78% [−1.40%, −0.16%] LOWER**; cycles −0.43% LOWER |

Medians (ms): user 9,140 / 9,101 / 9,107, boot 3,330 / 3,324 / 3,301. `node` (the browser ranking, 10 pairs): wall
+0.20% [−0.04%, +0.45%] **same** (9,288 → 9,299 ms). Compile side, base → new: `emitNs` 210.0 → 210.3 ms (user),
156.9 → 156.9 (boot), 662.4 → 665.2 (node); `compileNs` 68.9 → 69.2, 45.7 → 45.9, 212.0 → 212.6; JIT wasm 15.06,
11.23 and 47.26 → 47.30 MiB; modules 493 → 492, 293 → 292, 1417 → 1417. Interpreted steps +0.2% (183.0 → 183.3 M
in user): a chunk going on after an exit has fewer steps left, and a block longer than them runs interpreted. Memory:
one u64 in the `Vm`; the renderer's RSS column moves ±100-250 MiB either way between arms (noise). **Kept**, both:
the throttle alone is under the floor (as its 0.5% bound said), the pair moves the gates 0.4-0.8% and not a user's
machine (parallel SMP had both already), as the row expected.

Tests: `tests/baremetal/eret.c` (new): EL0 loops of SVCs, compiled, then of SVCs and unaligned loads with
SCTLR_EL1.A (interpreted), the virtual timer re-armed at every IRQ a pseudo-random time ahead so it comes due in
EL0's work and in the handlers' masked spins (then taken right after the ERET); each IRQ's ELR and counter reading
hashed to the console, which the deterministic runs compare between the interpreter, the JIT and JIT-stress; passes
on QEMU TCG (oracle.sh). **Planted bugs**, each caught, the source restored and the wasm rebuilt: the hook set
without `ok` (eret, timerjit and unmask under the JIT), an exception in place not counted as a step (eret, counter,
exceptions), a helper's abort finished in place (Buildroot's JIT boot: 20 G steps without powering off). The
signal-byte check moves no step (a host signal's latency only), as for the inline unmask.

CI: `scripts/ci.sh` (752 s) and `scripts/ci-jit.sh` (248 s) passed, each alone. No device exit changed (an MMIO
access's abort still goes to the run loop), so not `ci-debian.sh` or `ci-usb.sh`.

## PERF loop 89: three small sweeps by their counts — the pressure knee, the vCPU's yield, the table's growth (2026-11-28)

The queue's row 23: `PRESSURE_KNEE` (core/src/jit/mod.rs: the eighths of the 320 MiB budget the live modules fill
before the compile threshold leaves its floor of 1000 for 2000), `VCPU_YIELD_MS` (web/vm.ts: a busy vCPU worker's
return to its event loop, 100 ms) and the host's function table, grown at each install by the module's functions
(web/jit-host.ts `install`) rather than once at bind. **Each closed by its counts, nothing built, no Mac run**: every
arm's reach is under the floor or is a trade a measured loop already declined. No code changed (ABI 74,
`tests/steps.txt` unchanged). Data: `results/perf89/` (`knee.py` and `knee.txt` over loop 63's long sessions;
`micro.ts` and `micro-vm.json`, five rounds in headless Chromium 155.0.8059.84 on the dev VM; `tablemem.mjs`).

**`PRESSURE_KNEE` (2).** Where the live modules reach each eighth (loop 63's browse sessions, the Mac, 320 MiB, no
flush; `knee.txt`) against what the benchmarks compile:

| | 40 MiB (knee 1) | 80 MiB (knee 2: past it 1000 → 2000 by 120) | 120 MiB (threshold 2000) | 160 MiB |
|---|---|---|---|---|
| one Firefox, 62 min | 20 s | 40 s | 240 s | 2,040 s |
| Firefox restarted every 150 s, 62 min | 20 s | 30 s | 280 s | 3,182 s |
| the benchmarks' whole runs (loop 69) | `node` 48, `smp` 85, the cut pages session 93; the parallel boots 10-16 MiB | | never | never |

- *Flat 2000* (the floor at the maximum) is what loop 69's 2000/4000 arm ran in every workload (none reached its
  120 MiB step): `node` −1.2%, `smp` −4.2%, the parallel boots +1.8-2.9% on one and two vCPUs, the pages session a tie
  in time with the compiled share under churn 1.4 points lower. Not kept there; nothing to re-run.
- *A lower knee* (0 or 1) puts the threshold at 2000 past 40 or 80 MiB: the parallel boots never get there; `node`'s
  last ~17% of code at knee 0, `smp`'s last ~6% at knee 1 (~half at 0), and Firefox's code from 20-40 s into a session
  on: loop 69's trade again, on less of each workload (`node`'s share of its −1.2% ~0.2%, under the floor; the pages
  session still a tie in time with its compiled share lower from Firefox's first page on), so declined for the same
  reason.
- *A higher knee* (3 or more) changes only a session past 120 MiB of live code, 4-5 minutes into a real one (no
  benchmark gets there). Past it 98.0-99.5% of the steps already run compiled (3.6 and 15.0 G steps interpreted of
  772 and 753 G in 58 minutes, a guest averaging ~220 MIPS), and 47-56 MiB of wasm are compiled at 2000. At 1000
  instead, loop 69's ratio (wasm +31% at 1000 against 2000, on `node` and the pages session alike) makes that
  +15-17 MiB of wasm an hour, ~90-170 MiB of the renderer at V8's 6-10× (docs/jit.md "Memory"), past the line where
  the user is asked, for what loop 69's pages session measured at 1000 against 2000: the same busy MIPS and page
  times, the renderer's CPU +3.4%. Nothing to gain in time; not built.

**`VCPU_YIELD_MS` (100).** A vCPU yields at most once per period, and only when busy (an idle wait's return resets
it), so ≤ 10, 20 or 4 times a second at 100, 50 or 250 ms. One yield (`yieldTurn`'s 1 µs `Atomics.waitAsync` in a
worker that otherwise spins, as a vCPU's BUDGET exit does) takes 5-15 µs at the median at 50 and 100 ms and 10-25 µs
at 250, so the period costs ≤ 0.03% of a busy vCPU at 50 ms and saves ≤ 0.02% at 250; the spinning worker's work in
3 s against a worker that never yields moved −0.9 to +1.2% in every arm (the VM's noise, no order). In some 3 s
rounds of every period one yield took 17-18 ms: work queued to the thread that runs whenever the loop is visited,
not a cost of how often. What the period is for, the stalls (Oilpan's sweep tasks, "M8: V8's GC on the
vCPU threads"), is already gone at 100: no stall of 20 ms in loop 69's pages sessions, 0-2 in loop 83's, and what
that entry's traces left past 50 ms is the wasm code GC (every vCPU at once), which a yield doesn't touch. 50 has nothing to remove and 250 nothing to
gain past its risk of the sweep's stalls; no pages session run.

**The table's growth.** Each install grows the core's table by its module's functions (`table.grow(at + n −
length)`), and the grows are cheap (~0.5 µs each, so V8 doesn't copy the table at each): in the micro-benchmark
(a table defined by a module like the core's, modules importing it and using it in a `call_indirect`, as the JIT's)
`node`'s shape (1,461 modules of 13 functions, 21K entries) spends 0.61-0.93 ms growing in all, a long Firefox hour's
(4,744 of 16, 78K entries) 2.5-3.9 ms, against installs of 7.8 and 28 ms in that loop alone; pre-growing to the
cache's 262,144 slots at bind costs 2.2-3.0 ms once and ~8 MiB a table (Node 26: 6.0 MiB of heap, 8.2 of RSS), ~32
MiB on four vCPUs, to save < 1 ms of a 9 s workload (< 0.01%). Not built.

No CI (results and docs only).

## PERF loop 90: the out-of-context review of round-robin's run loop, fixed (2026-11-28)

The static review of loop 88 (round-robin's run loop and its hand-offs with the JIT: `Vm::run`, `rr_fast`,
`jit::at_dispatcher`, `Unmask`, `StepClock`) found no correctness defect, three low findings and four untested paths.
Each was checked against the code. ABI 74 unchanged, `tests/steps.txt` unchanged, the counted code byte for byte
the same (the core's changes are in `Vm::run`'s Rust only).

**1. Round-robin ignored `vm_set_chunk`: held, fixed.** `Vm::run` cut its chunks at `CHUNK` whatever
`Shared::chunk` said, so the PC sampler on a round-robin machine (`bench/boot/suite.ts`'s `?chunk=` runs, the
profiler outside the page, which always runs parallel SMP) saw only chunk ends: since loop 88 almost all of them the
32K budget or a deadline. The comment that kept it out ("its chunks place interrupts, so its step counts would
move") was stale: the in-place completions made the chunk size invisible to deterministic guests (docs/platform.md),
the quantum stays `QUANTUM`, and the default (0) is `CHUNK`. Now `n = min(chunk, CHUNK, left, deadline, quantum)`,
one relaxed load a chunk. The only guest-visible difference while a sampler runs is a due xHCI event fired at an
earlier chunk's end (documented). Test: `vm::tests::round_robin_publishes_its_pc_at_the_chunk_the_sampler_sets`, a
sampler thread reading `retired` while a 1-vCPU spin runs with chunk 256: it failed on today's tree ("the sampler saw
only CHUNK's ends", after 200 runs) and passes with the fix.

**2. The in-place completions rest on an unchecked invariant: held as unguarded, guarded.** No violation today, as
the reviewer found. The reviewer's `debug_assert!` after the chunk wouldn't run (the JIT runs only in the release
wasm), and checking `gic.irq(c)` there would miss the case named (the GIC sees an inline timer write only at
`timer_lines`). The parts: nothing in a chunk can reach the GIC (compiled code and the hook get the vCPU, the memory
and `Shared`, by type), and the other timers' deadlines cut the chunk, so the one inline path is `emit::timer_msr`'s
rule. After every chunk that wrote a timer inline (`StepClock::wrote`: deterministic round-robin only, a few per
guest timer tick), `Vm::inline_timer_writes_fired_nothing` now panics if one of the vCPU's timer lines that was low at
the chunk's top would be high a step before its end. It is out of line (`#[inline(never)]`, 594 bytes): `Vm::run`
5,751 → 5,792 bytes with finding 1's load. Planted: `timer_msr`'s `cval >= end` dropped, and timerjit.c and
unmask.c stop with the guard's panic under the JIT (without the guard they fail on their hashes; Linux guests compare
only steps).

**3. The JIT's and TLBs' counters lag `retired` and `pc` within a run: held, by design.** Up to 65,535 steps, as
in parallel SMP, settled at a run's end. Documented where it applies (docs/platform.md, "Between chunks"), not
changed: no consumer computes a ratio from them mid-run except the vCPU timeline's compile time, which is parallel
SMP's and already lags there.

**The untested paths, covered:**
- *SMP, instruction aborts, watchpoints:* `tests/baremetal/eret_smp.c` (`// smp: 2`), each vCPU with its own timer,
  hash and EL0 stack, through SVCs, alignment faults, instruction aborts (a call to an address with nothing there,
  the handler returning to the caller; not on the oracles) and watchpoint hits (MDSCR_EL1.MDE, EL0 loads), each
  handler a pseudo-random masked spin before its ERET. Interpreter against JIT in Node (44.6 M steps), natively,
  and parallel SMP (counts); on the oracles it passes on TCG and hvf (eret.c's and its IRQ-count checks now left out
  of the hvf build: the M4 runs the rounds in a fraction of a millisecond, a few IRQs, and eret.c failed there with
  `exit 4` since loop 88). Planted, each caught by `eret_smp` only (eret.c passes): an in-place Fetch taken as a
  data abort (`exit 86`), a watchpoint taken as an alignment fault (`exit 41`), `ok` from vCPU 0's GIC state for
  every vCPU (both hashes move).
- *`ticks_per_insn > 1`:* `eret`, `eret_smp`, `timerjit` and `unmask` also run at three ticks a step, interpreter
  against JIT (a test-only `ticksPerInsn` boot option, web/vm.ts). Planted: the step clock left on at three ticks
  moves eret's, eret_smp's and timerjit's hashes there; the one-tick runs pass.
- *A host signal at `rr_fast`:* `vm::tests::round_robins_fast_completion_declines_once_a_host_signal_arrives` calls
  the hook with each signal bit set (it declines, the CPU untouched), with an MMIO bus fault, a helper's SVC and a
  helper's resync (declined), then an ERET's resync and a dispatcher SVC (taken as `take_exception` does, counted).
  Planted: the signal check dropped fails it.

**Cost.** One relaxed load a chunk and the out-of-line check after a chunk with an inline timer write. The paired A/B
on the Mac (`results/perf90/ab/`, Chrome for Testing 158.0.8127.88, 12 pairs each): the userspace gate wall −0.03%
[−0.54%, +0.49%], cycles −0.22% [−0.81%, +0.38%]; Alpine's boot wall +0.22% [−0.12%, +0.55%], cycles +0.15%
[−0.09%, +0.39%] (`same`); instructions within ±0.07%, the JIT's wasm, modules and interpreted steps identical.
No difference.

CI: `scripts/ci.sh` (758 s) and `scripts/ci-jit.sh` (282 s) passed at this commit.

## PERF loop 92: late-compiled successors, SP's alignment guard and `refresh`'s stores, counted (2026-11-28)

Queue row 25: three small costs, each counted before anything is built. **All three close as findings; nothing
kept.** Tree 5e1e1700; M4, macOS, Chrome for Testing 158.0.8127.88, the Mac's Node 26.10.0. Data:
`bench/boot/results/perf92/` (its README). The counts are a diagnostic core's (`diag.patch`): the gates in the dev
VM's Node (`preempt-counts.json`) and one Firefox pages session on the Mac (`pages-diag/`: 97.3 G steps, 442 busy
MIPS, ~220 busy vCPU-seconds).

**1. A static successor compiled after its block, through the jump cache** (`emit::via_jc` with a key). Per 1000
steps, hits / fall-throughs: Alpine's boot 2.95 / 0.33, the userspace gate 4.57 / 0.13, parallel boot on 4 vCPUs
2.61 / 0.44, parallel userspace 6.30 / 0.07; **the pages session 3.31 / 0.21 (322 M hits, 20.6 M fall-throughs)**,
half PERF loop 54's 6.3 with 16-block regions. What a reserved table slot (`i32.const slot; return_call_indirect`)
would save a hit, `chain3.mjs` on the Mac (ns an entry, four runs of each, every kind's memory written alike): at
1,000 functions the jump cache's tail 8.6-10.3 against the constant index's 4.7-5.1 (+3.5-5.5 ns), at 32,768 35-38
against 24-28, at 131,072 95-99 against 78-85 (+12-18 ns); with the entry at a constant address (no load of the JC
pointer) 8.0-8.1, 27 and 91-92: the cost is the entry's load ahead of the index, not the pointer's. **The bound:**
322 M hits at 4 ns (a warm entry) is 1.3 s, 0.6% of busy time; at 13 ns (an entry missing every cache) 1.9%; the fall-throughs could gain only where the successor was compiled by then (PERF loop 54's dispatcher count
bounds those, ≤0.55%). The micro-benchmark's bodies are ~20 instructions, so it shows the tail's latency more than
a 64-block region's exit does: the gain is nearer the low end. **Not built:** a slot named before its block is
compiled needs a reservation per key that outlives the block (kept while any tail names it, reset to a stub on
invalidation and flushes, the chain graph's bookkeeping the jump cache spares today), a stub of the tail's type in
every table at every reserved index (a host ABI change), and polled code only: counted code checks `left` against
the successor's length, which the slot doesn't carry, and round-robin's code stays byte for byte. So `node` (counted)
can't rank it and the pages session resolves ~1%: a redesign for ~0.5% that no measure here can see. (The miss in
`chain3.mjs`: one write to a wasm memory whose pages the bodies read but never wrote moved `indirect` from 5 to
22 ns in the dev VM; its kinds now write the same memory.)

**2. SP's alignment guard on a probe** (`emit::guard`'s `Guard::Sp`, five wasm ops ANDed into the TLB's tag
compare). Per 1000 steps, probes with SP's guard / all probes: the gates 37-50 / 185-294; **the pages session 59.4
/ 238 (25%)**; of SP's, 21.6 (36%) have the form a two-op fold can take (the address SP + 16k, the access within 16
bytes: `((ADDR | 0xff0) + 15) == tag` checks both page and alignment). **The bound, the guard dropped outright**
(unsound, a measurement core): Alpine's boot's 300 modules −0.43% wasm (11.77 → 11.72 MB), per TurboFan function
**arm64 −0.5% instructions** (−0.5% code bytes, −0.6% frame memory operands) and **x64 −1.1%** (−0.9%, −0.5%)
(`codestats-nosp.json`); the paired A/B on `node` (`ab-nosp/`, 10 pairs): **wall −0.35% [−0.69%, −0.01%] `LOWER`**,
cycles −0.35%, instructions −0.38%, emit −0.6%, the JIT's wasm −0.3%, modules and interpreted steps the same. A
sound fold gets part of that: it covers 36% of the SP probes and puts back two ops of its own, ~0.1-0.2%. And the
two-op fold isn't sound as it stands: an SP misaligned by one in the top page wraps `(Y | 0xff0) + 15` to 0, an
empty TLB entry's tag (the default 0) at that index; the XOR and add-after forms collide with spill memory 1's tag
(bits 10:3 inverted, 0xff7) at a misalignment of 8. It would need the TLB's empty tag moved off zero. Not built.

**3. `Vm::refresh` storing every vCPU's IRQ byte** (a SeqCst swap of each, under the platform lock). The pages
session: 2.46 M refreshes (~11,400 a second), 9.85 M swaps, 1.15 M (11.7%) changing the byte; the parallel gates
~16,000 refreshes a second, 9-11% changing. What a swap of an unchanged byte other cores read costs against a load
first (`swap.c` on the Mac, three readers spinning on their bytes, one writer): 84 ns a refresh of four bytes against
2-4, the readers' loads unchanged at a refresh every 20 µs (48.97 M/s both ways; −1% at every 2 µs, far above the
real rate). **The bound:** 2.46 M × ~80 ns = 0.2 s, 0.09% of busy time: under the floor; not built.

Memory: none (nothing kept). Compiled code unchanged (no kept code: the x64 counts above are the bound's). No CI:
the loop changes only docs, REPORTs and results.

## PERF loop 94: the settling emissions emit only the members whose entry states changed (2026-11-28)

Queue row 27 ([#15](https://github.com/gbl08ma/waarm64/issues/15)): regions whose entry states never settle take six
emissions each. **Kept:** the emissions until the states settle are analyses that emit only the members whose entry
states changed since the one before and take the others' edges from it (core/src/jit/block.rs: `redo`,
`Emission::edges`, `emit_region`'s `redo`); a region's `looped` and `entries` are found once for its emissions. The
modules are byte for byte the same; no ABI or step change (ABI 74, `tests/steps.txt` unchanged). Base 78d0bf39. Data:
`bench/boot/results/perf94/` (README). M4 Mac mini, macOS, Chrome for Testing 158.0.8127.88; the dev VM's Chromium
155.0.8059.84 for the counts.

**The re-count** (a diagnostic core, `diag.py`, on the dev VM; loop 71's were on 16-block regions):

| | regions of several blocks | never settled | their share of the members emitted | settle within 8 / 16 emissions |
|---|---|---|---|---|
| `boot` | 2726 | 562 (20.6%) | 61.9% | 390 / 541 |
| `user` | 3618 | 771 (21.3%) | 62.9% | 540 / 740 |
| `node` | 8772 | 2706 (30.8%) | 71.1% | 1742 / 2445 |

64-70% of the unsettled regions would settle in eight emissions and 90-96% in sixteen: a slow fixed point (a state
moves one edge an emission), not a cycle. So their number of emissions can't be cut without changing their code
(fewer, or `Regs::loose` earlier, gives other entry states; more would settle most of them, a different and longer
code path), and the work to cut is what each emission emits: between two settling emissions, most members' entry
states are the same. Re-emitting only the changed ones would emit 17-21% fewer members in all (22-28% fewer in the
unsettled regions). That bounded the gain at ~1/5 of emission, ~30 ms of the boot gate and ~130 ms of `node` on the
Mac, if emission were proportional to members.

**The rule.** What a member's edges carry (the register state and lazy flags before they conform to the target's)
is a function of `plain` and the member's own entry states: `emit_region` sets each member's registers and flags at
its start, and the target's states shape only the code on the edge. So a settling emission whose `plain` is the one
before's emits the members whose entry register or flag state changed (`redo`), skips the others' code, and merges
their recorded edges in their order; whether an edge contradicts its target's lazy flags (`bad`) is found again from
what it carried. One where every member changed, or `plain` did (the first after the first emission, outside loops),
is whole and may be kept, as before; one with every member unchanged is the one before. An analysis's code is never
the function's, so a region that settled in one ends with a whole emission (the base kept the settling one). An
earlier rule that also re-emitted a member whose successors' flag states changed was dropped: no test or workload
could tell it apart, the edge's recorded state being taken before its stores.

**Counted again on the change** (`diag2.py`, guest instructions emitted): 21.3% fewer on `boot`, 20.9% on `user`,
20.4% on `node` (e.g. `node`: 2.08 M → 1.66 M; of the partial emissions' 1.17 M, half skipped; the whole last
emissions added back 0.16 M). Time fell less: a partial emission keeps a region's fixed costs (the function's
setup, the prologue, the entries, the labels and the merges), and `module` outside `emit_region` (the plans, the
module's assembly) is unchanged. In Node's deterministic Alpine boot (`--cpu-prof`, base and new alternated twice)
`module` took 206.9-226.1 ms against 196.0-209.7 ms.

**Correctness.** Wherever debug assertions are on, each partial emission is checked against a whole one
(`Emission::found`: the states, the dead flags, `bad` and every edge). A core with that check an `assert!` in release
ran `boot`, `user`, `node` and `smp` in the dev VM's Chromium (two pairs each) with no failure. `bench/jit/dump-modules.ts`:
Buildroot's 43 modules and Alpine's 300 identical between base and new but three that differ only in the CRC32
table's address in the core's memory (an `i32.load` offset, 128 bytes later in the new core's data), so no x64 or
arm64 static count moves. New test: `lazy_flags_cross_members_that_keep_them` (a loop of four members holding no
register, a compare's lazy flags reaching the last across three edges: a member whose flag state alone changes).
Planted: `redo` ignoring a member's flag state fails that test (its check, and the assertion); ignoring its register
state fails eight tests; ignoring a change of `plain` two; the replayed edges not recorded for the next analysis
six.

**The Mac** (the paired command against the base; counters from it):

| | pairs | wall | cycles | instructions | `emitNs` |
|---|---|---|---|---|---|
| `node` | 6 | **−0.82% [−1.53, −0.11] `LOWER`** | −0.58% `LOWER` | −0.70% `LOWER` | 671 → 598 ms (−10.8%) |
| `smp` | 8 (cap) | +0.32% [−2.91, +3.66] `open` | +0.84% `open` | +0.08% `open` | 1231 → 1121 ms (−9.0%) |
| `user` | 12 (cap) | −0.46% [−1.43, +0.52] `open` | −0.34% `open` | −0.34% `LOWER` | 212 → 192 ms (−9.6%) |
| `boot` | 11 | **−0.38% [−0.76, −0.00] `LOWER`** | −0.20% `same` | −0.60% `LOWER` | 157 → 141 ms (−10.4%) |

JIT wasm, modules and interpreted steps are equal on `node` (on `smp` within its run-to-run spread); `planNs` and
`compileNs` unchanged. The footprint on `node` was 1488 against 1219 MiB, the bimodal footprint loop 71 saw in
both arms alike; on `smp` 2334 against 2348 MiB.

- The parallel boots (3 rounds alternated, `boots/summary.txt`): `smp_alpine_jit` totals −0.2% (n1), −0.3% (n2, the
  rounds just apart: 4630-4653 against 4616-4628 ms), −0.2% (n4); `smp_user_jit_4` −2.4% (10489-10599 against
  10309-10448 ms), its phases spread as loop 71 saw. Peak RSS the same (1543-1548 against 1555-1672 MiB, 2029-2041
  against 2034-2035).
- Firefox's pages session (`PAGES=wiki,mdn`, 4 sessions each, the first arm alternating): **emission 1371-1383 →
  1228-1253 ms (−9.6%, no overlap)**, the cache lock's waits 511-568 → 466-499 ms; `pagesS` 30.2-31.1 against
  29.9-30.9 s, busy MIPS 446-454 against 452-457, the renderer's CPU 127.3-129.6 against 125.3-127.4 s
  (overlapping); modules, the compiled share (95.0%) and interpreted steps alike. One vCPU stall of 22 ms in one new
  session (none in the fourth round's), none in the base's.

**Why it is kept.** The output is the same and every measure of the work agrees (`emitNs` −9 to −11% on the Mac, the
pages session's emission −9.6%), `node` is `LOWER` past the floor and the boot gate `LOWER`, the userspace gate
`open` on the side of a gain. Memory: an emission holds its edges (a few
dozen 32-byte records) while its region settles, dropped at the function's end. CI: `scripts/ci.sh` (746 s) and
`scripts/ci-jit.sh` (282 s) passed.

## PERF loop 95: block ends at the system instructions, counted (2026-11-28)

Queue row 28 ([#315](https://github.com/gbl08ma/waarm64/issues/315)): JIT blocks still end at the MSRs outside
`interp::sys::msr_continues`, SYS (TLBI, AT), CLREX, IC and the DC operations other than ZVA. **Closed as a finding:
no class ends blocks often enough to matter; nothing relaxed, no code changed.** Tree 387a6c2a. Data:
`bench/boot/results/perf95/` (README). The counts are a diagnostic core's (`diag.patch`: at a block's last word, a
tally by the instruction's class and register or op, and whether the block goes on to a member of its region): the
gates in the dev VM's Node (`preempt-counts.json`), `node` and `smp` in the dev VM's Chromium (`counts/`), one Firefox
pages session on the Mac (`pages-diag/`, 96.4 G steps, 4 vCPUs). Only compiled code counts (94-97% of the steps).

**Block ends a 1000 steps, out of the function** (to the dispatcher, a chain or an exit; the edges to a member are
negligible but where noted):

| | `boot` | `user` | `node` | `smp` (4 vCPUs) | pages (Mac) |
|---|---|---|---|---|---|
| MSR ICC_EOIR1, SGI1R (the GIC: an exit anyway) | 0.0155 | 0.0159 | 0.0158 | 0.0037 | 0.0076 |
| MSR TTBR0/1 (the regime) | 0.0030 | 0.0024 | 0.0009 | 0.0015 | 0.0032 |
| MSR FPCR/FPSR | 0.0014 | 0.0010 | 0.0062 | 0.0012 | 0.0038 |
| TLBI VAE1IS/VALE1IS/ASIDE1IS/VAALE1IS (an exit with several vCPUs) | 0.0093 | 0.0048 | 0.0099 | 0.0125 | 0.0039 |
| TLBI local (VALE1 and kin) | 0 | 0 | 0 | 0 | 0.0012 |
| DC CVAC/CIVAC | 0.0045 | 0.0010 | 0.0012 | 0.0003 | 0.0001 (+0.0052 to a member) |
| IC IVAU (an exit anyway: `Exit::Invalidate`) | 0.0012 | 0.0003 | 0.0030 | 0.0014 | 0.0054 |
| YIELD, SEVL (out; spin loops) | 0 | 0 | 0 (+0.0012 to a member) | 0.0124 (+0.2035 to a member) | 0.0010 (+0.0185 to a member) |
| **all of the issue's classes** | **0.0348** | **0.0254** | **0.0370** | **0.0331** | **0.0261** |
| of them not exiting anyway | 0.0152 | 0.0068 | 0.0173 | 0.0140 | 0.0060 |

None of the rest ran in any workload: CLREX, AT, SYS's other ops, TCR, SCTLR, CONTEXTIDR, VBAR, CPACR, MDSCR, NZCV,
CNTKCTL, MSR PAN or SPSel, DC IVAC/CVAU/set-way, IC IALLU. For scale, the ends outside the issue: ISB 0.18 a 1000 steps
to a member on the gates and `node` (inline, an edge), 0.12 + 0.016 out on the pages session (the helper in parallel
SMP: PERF loop 8); WFE 0.015-0.017 and ERET 0.026-0.075 out, which must end.

**The bound** (`bound.txt`): every end of the issue's classes at 130 ns (an exit to the run loop, PERF loop 8's
upper end; most are cheaper, a return to the dispatcher or a chain at ~11-30 ns) and every edge to a member at 5 ns,
against a guest step at 1.6 ns of busy time: **0.21-0.33% of busy time on every workload, all classes together**
(`boot` 0.28%, `user` 0.21%, `node` 0.30%, `smp` 0.33%, the pages session 0.22%). Relaxing can't take that whole:
the GIC's registers exit to the run loop (`Exit::Platform`), IC to the invalidation (`Exit::Invalidate`), TLBI IS
with several vCPUs to the others' shootdown (`Exit::TlbiIs`) whatever the block does, and TTBR0/1 change what the
next block is compiled for. What a relaxation could reach is 0.06-0.18%, and for most of it (TLBI's local flushes:
the TLB compiled code probes, which a member's earlier probes may have read; FPCR: what the FP fast paths assume) a
continuation would need state reloaded mid-block. All of it is under the paired command's ±0.5% and the pages
session's ~1%: **no class is relaxed**, and `block::end` stays as it is. Which ends a block and why is now in
docs/jit.md "Blocks and keys".

Memory: none. Compiled code unchanged (nothing built: no static counts or steps move). No CI: the loop changes only
docs, a comment, REPORTs and results.

## PERF loop 96: the review of loop 94's emission fixed (2026-11-28)

An out-of-context static review of how a region is emitted (`block::module`, the settle loop, loop 94's partial
emissions; branch `review/jit-emission`, now deleted) found no miscompilation and four risks. Each checked against the
code; all four held. Tree 9752bb9a. Data: `bench/boot/results/perf96/` (`node/`: the paired A/B; `dump.txt`).

1. **Medium, held: the equivalence checks never saw real guest code.** `Emission::found`, `Emission::same`,
   `conform`'s dirty-shadow check and `Regs::merge`'s `sound` are debug assertions, and natively no test emits a
   guest's code (the native JIT runs through the block interpreter; the image tests are `--release`). Added
   `block::tests::regions_of_a_real_kernel_emit_as_their_arguments_do`: the loops and forward regions (admitting
   any block that heads no loop, as the differential tests do) at every block start of 40 pages of each Buildroot
   kernel's text (`Image`, `Image-defconfig`; skipped without them), emitted in modules as the JIT does, polled and
   not, with and without the jump cache: ~8,400 regions an image, ~2,900 unsettled, ~20,000 analyses (16,000-19,000
   with entries), 17 s in the debug tests. And a **release guard**: `conform` records an unfit edge
   (`Func::unfit`) instead of asserting, and `module` emits such a region again with its entries made clean
   (`Regs::loose`), in the tests an assertion (`an_unfit_edge_emits_the_region_again_with_its_entries_clean`
   provokes it with a test-only `Regs::tight`).
2. **Low, held: `redo`'s invariant was wider than its doc.** A successor's flag state also decides whether a
   member stores NZCV before its branch; edges stay their member's alone because `commit_flags` keeps the flags lazy,
   touches no register and can't make the flags dead (verified: `touched` goes only from unset to true). The doc
   comment now says so; `a_commit_before_the_branch_changes_no_edge` is a loop whose member alone is redone when its
   successor's flags turn dead.
3. **Low, held: the entries' prologue didn't feed `bad`.** It does now (`bad |= fin[j]` lazy); unreachable while
   `settle` sees the prologue's merge in memory. `an_entry_member_reads_its_flags_from_memory` pins it.
4. **Low, held: paths no test reached.** The pass whose arguments are the last one's
   (`a_region_settled_at_once_keeps_its_first_emission`, with a second region where only `plain` changes), and
   analyses of a region with entries (`a_region_with_entries_settles_in_analyses`). The `x.bad` fallback stays a
   release `assert!` and unreached (0 in the ~17,000 kernel regions too).

**Planted bugs** (the `jit::` tests, each restored): an analysis's skipped member replacing its target's merged
state instead of merging — caught only by the new tests (the entries test, the kernel test); its dead flags taken as
live (5 tests); `redo` ignoring flag states (3, the new loop test among them); the pre-branch commit retiring the
lazy flags (4); the last pass's arguments reused although `plain` changed — only the new tests; the prologue's
flags-in-memory merge left out (the entry test through `bad`, and the kernel test); that merge and the new `bad`
line both left out (the entry test: the member reads flag locals nothing set); the unfit fallback disabled (the
provoking test).

**Cost:** modules byte for byte the same (Buildroot's 43 and Alpine's 300, `dump.txt`); `tests/steps.txt` and the
ABI unchanged. The Mac's paired A/B on `node` (12 pairs, Chrome for Testing 158): wall −0.01% [−0.40, +0.39] same,
cycles +0.08% [−0.30, +0.46] same; `emitNs` median +0.42%, `compileNs` +0.15%, `planNs` +0.29%, inside each arm's
spread (580-618 ms, both arms bimodal); footprint the same distribution. Memory: none.

**CI:** `ci.sh` and `ci-jit.sh` passed. The first `ci.sh` run hit [#286](https://github.com/gbl08ma/waarm64/issues/286)
a third time (`tests/browser.test.ts` "the page says what's wrong": a running machine's `page.close` after the core's
Retry never returned); that test now bounds its closes at 20 s and goes on in a new context, and passed 5 of 5 alone
and in the next `ci.sh`.

## PERF loop 97: per-ASID stashes of nG TLB entries, counted (2026-11-28)

Queue row 29 ([#316](https://github.com/gbl08ma/waarm64/issues/316)): an ASID switch drops the previous ASID's nG
entries instead of keeping them for when it is current again. **Closed as a finding: a stash would serve at most
1.2% of a Firefox pages session's busy time before its own costs and under 0.4% of every other workload; nothing
built.** Tree 43696a9b (ABI 74). Data: `bench/boot/results/perf97/` (README).

**How it differs from what was measured before.** The 2026-11-03 model ("The TLB at 16,384 entries; per-ASID stashes
and victim buffers measured out") counted Alpine's boot and userspace run at 4,096 entries, before the global
entries survived an overflowing nG list, the sibling fill and the collapsed queue's nG flush (PERF loop 73), and on
no multi-process browser workload. PERF loop 72's closed rows (the transfer cache's per-ASID generation, the TLB's
size, `NG_SLOTS`) were about other structures: none kept entries across a switch. This loop counts on today's tree,
on the pages session too, with two models.

**What ran** (one run each: counts). A diagnostic core (`diag.patch` on 43696a9b; nothing of it is in the tree)
models two stashes beside the real TLB, which it doesn't change. At an ASID switch (`interp::sys`'s flush of the nG
entries) it records the live nG entries for the old ASID; a walk's later nG fill of a page and array the current
ASID has recorded, with the same tag and addend, is a refill the stash would have saved. TLBI by VA drops the page
from every stash, ASIDE1 its ASID's, everything all of them, an nG flush of no known ASID (a collapsed queue) all
of them. *Strict*: the stash is exactly what was live at the last switch away (what a design restoring at the switch
back would hold); *generous*: also everything stashed before and not refilled since, uncapped. The gates' guests in
the dev VM's Node (`preempt-counts.json`), `node` and `smp` in its Chromium 155 (`counts/`), one pages session on the
Mac (`pages-diag/`; M4, Chrome for Testing 158.0.8127.88; 97.4 G steps, 453 busy MIPS; a first session with the
generous model alone gave the same within 4%).

| | `boot` | `user` | `smp_user_jit_4`'s guest | `node` | `smp` | pages (Mac) |
|---|---|---|---|---|---|---|
| ASID switches (a million steps) | 3,674 (1.4) | 9,566 (0.9) | 7,774 (0.25) | 3,405 (0.4) | 12,712 (0.6) | 107,352 (1.1) |
| nG refills (walks); share of all walks' fills | 193 K; 49% | 676 K; 87% | 2.76 M; 87% | 673 K; 86% | 7.00 M; 95% | 37.7 M; 93% |
| strict: served, data / instruction | 17.8 K / 32.4 K (26%) | 55.1 K / 62.4 K (17%) | 25.9 K / 35.4 K (2.2%) | 16.8 K / 29.9 K (6.9%) | 595 K / 625 K (17%) | 7.36 M / 7.17 M (38.5%) |
| strict: entries restored a switch | 21.8 | 20.6 | 12.0 | 21.7 | 298 | 313 |
| generous: served | 56.2 K (29%) | 135 K (20%) | 65.9 K (2.4%) | 51.6 K (7.7%) | 2.25 M (32%) | 20.8 M (55%) |
| generous: entries to restore a switch; ASIDs with a stash, most | 36; 11 | 86; 11 | 28; 39 | 34; 7 | 1,465; 16 | 4,429; 62 |
| **bound, strict** (generous) | **0.15-0.17%** (0.17-0.18) | **0.16-0.18%** (0.19-0.20) | **0.02%** (0.02) | **0.05%** (0.05-0.06) | **0.33-0.36%** (0.56-0.61) | **1.16-1.26%** (1.68-1.84) |

No stashed entry was ever refilled with another translation (0 stale), and a restore would land on a global entry's
slot 4 times in the session (682 K times on another nG entry's). **The bound** (`bound.py`, `bound.txt`): each served
data refill at PERF loop 72's 260-290 ns (a walk and the helper that runs the access's group), each instruction
refill at a walk's 68 ns, of busy time (the Node runs' wall, ×4 for 4 vCPUs; Chromium's medians; the session's steps
at its busy MIPS), nothing for the stash's own costs. Those are: copying ~620 entries a switch on the session (67 M
entry copies, ~0.1% at 3 ns each), every TLBI by VA (1.2 M a session) looking in every stash, memory (~24 KiB an
ASID at 1,024 entries of tag, addend and slot, ×16-62 ASIDs, a vCPU), and in parallel SMP the TLBI IS skip
(vm/parallel.rs `broadcast`: an issuer doesn't wait for a vCPU running another ASID, which applies the operation at
its next chunk boundary) means a restore must wait for the vCPU's queue to drain, or the issuer for every vCPU
stashing the ASID. Against the floors: the gates, `node`, `smp` and `smp_user_jit_4` are under the paired command's
±0.5% as gross bounds; the session's 1.16-1.26% is at its ~1% floor before the costs, and PERF loop 73's sibling fill
took more data misses out of the same session (10.6 M, bounded at 1.3-1.4% the same way) without a resolvable
change. The generous model's larger share needs ~4,400 entries restored a switch (475 M copies a session), which
eats what it adds. **Closed**: not built (docs/cpu.md "ASIDs").

**Also counted: TLBI ASIDE1 of another ASID.** The TLB holds only the current ASID's nG entries, and `flush_ng`
drops them at any ASIDE1, whatever its ASID: in the session 14,123 of 17,787 ASIDE1s (mostly other vCPUs' broadcast
`flush_tlb_mm`, drained here) named another ASID and dropped 5.31 M live entries for nothing, 1.97 M of which were
refilled before the next switch (`smp_user_jit_4`'s guest 21,423 of 25,992, 249 K refilled; the one-vCPU runs ~2 K).
Skipping the flush when the operation's ASID (masked as `TCR_EL1.AS` says) isn't the current one would be right and
cheap, and is worth at most 0.06-0.28% of the session and 0.03-0.14% of `smp_user_jit_4`: under both floors, not
built, recorded with the finding.

Memory: none. Compiled code unchanged (nothing built: no static counts; `tests/steps.txt` unmoved). The runs: three
in Node (~30 s), one `node`/`smp` pass in Chromium (2 pairs, ~8 min), two pages sessions (225 s each). No CI: the
loop changes only docs, a comment, REPORTs and results.

## PERF loop 98: an adaptive idle-vCPU poll (2026-11-28)

The PERF queue's row 30 ([#134](https://github.com/gbl08ma/waarm64/issues/134)): every idle vCPU polled its wake
word 20 µs (`SPIN_MS`) before sleeping, and most polls caught nothing. **Built: the poll adapts
(web/idle-wait.ts `pollRule`): after 8 idles in a row that a poll didn't end (`POLL_MISSES`), a vCPU sleeps at once,
until an idle's wake-up comes within the poll and a wait's wake-up of its start (`WAIT_WAKE_MS`, 60 µs). An idle
4-vCPU guest's host CPU on the Mac 7.8 → 6.7% of a core (no overlap), the pages session's renderer CPU −1.2%
(overlapping; instructions −2.3% and energy −1.2%, no overlap), the 4-vCPU boot's energy −2%; the futex hand-offs as
fast on both hosts, the pages session's and the parallel boots' times unchanged.** Only web/ changed (the vCPU
worker's idle path, a `vcpuPollMisses` knob, `?vmiss=<n>`, 0: always poll); the core, compiled code, deterministic
and round-robin runs and `tests/steps.txt` are 5d9fd31e's. M4, macOS, Chrome for Testing 158.0.8127.88, Node 26.10.0
there; the dev VM's Node 26.7.0. Data: `bench/boot/results/perf98/` (its README).

**The counts** (a diagnostic build, `diag.patch`: each vCPU worker tallies its idles' outcomes and simulates ten
candidate rules on them as they run; `python3 rules.py`, `rules-out.txt`; a second each, summed over 4 vCPUs):

| | pages session (Mac, Chrome) | `smp_alpine_jit` n4 (VM) | `smp_user_jit_4` (VM) | idle guest (VM) | `pingpong` (VM) |
|---|---|---|---|---|---|
| idles / ended by the poll | 1,890 / 120 (6.3%) | 1,903 / 105 (5.5%) | 1,112 / 111 (10%) | 401 / 0 | 157,543 / 149,369 (95%) |
| woken later / at the deadline | 1,076 / 694 | 824 / 973 | 520 / 480 | 1 / 401 | 8,053 / 122 |
| the poll, of one core | 4.25% | 3.42% | 1.95% | 0.64% | 52% |
| woken within 20-50 µs (a longer poll's) | 69 | 25 | 22 | 0 | 1,490 |

By the idle's deadline nothing separates them: in the pages session 7% of the idles of 0.1-1 ms end in the poll, 5%
of those past 16 ms; the boots' catches are all 0.1-1 ms idles, like most of their idles. What separates them is how
the catches come: in runs in the pingpong (a hand-off a round), scattered elsewhere. The rules' prediction (the poll's
CPU it would save, of one core; the catches it would slow, as a share of all):

| rule | pages session | `smp_alpine_jit` n4 | `smp_user_jit_4` | idle guest | `pingpong` |
|---|---|---|---|---|---|
| streak of 1 miss | 4.00%; 86% | 3.26%; 54% | 1.79%; 62% | 0.64%; - | 12.6%; 1.9% |
| 4 | 3.38%; 66% | 3.01%; 38% | 1.57%; 23% | 0.64% | 4.9%; 0.4% |
| **8** | **2.76%; 49%** | 2.75%; 30% | 1.43%; 15% | 0.64% | 2.5%; 0.1% |
| 16 | 1.96%; 29% | 2.36%; 22% | 1.24%; 10% | 0.64% | 1.2%; 0.03% |
| a catch within 10 ms | 2.87%; 53% | 2.52%; 25% | 1.33%; 13% | 0.64% | 0.9%; 0.005% |
| within 100 ms | 0.72%; 7% | 0.95%; 7% | 0.50%; 4% | 0.64% | 0.6%; 0.005% |

A slowed catch costs a wake-up through `Atomics.wait` instead of the poll: ~16 µs on the Mac, ~36 µs in the dev VM
(loop 83's pingpong with no poll against with one); the pages session's and the boots' catches are ~100 a second over
4 vCPUs, so even all of them slowed is ≤ 4 ms a second of vCPU time, and loop 83's 0 µs poll didn't slow the pages
session. The pingpong is where a slowed catch shows, and the simulation, which can't see that a slowed hand-off delays
the next ones, undercounts it: a streak of 1 slowed it 1.8-2.5× in the dev VM (predicted 1.9% of its hand-offs).

**The rule's two forms.** First, a wake-up within twice the poll counted as a catch whether or not the idle polled;
in the dev VM a wake-up through the wait often comes later than that (36 µs), so an idle that stopped polling seldom
saw a catch and stayed stopped: 4 and 8 slowed the pingpong there (LSE's 1.01 s median → 1.075 and 1.045 at 4 rounds,
`pingpong-vm-4x.txt`; the Mac's unchanged, `pingpong-mac-4x.txt`). Kept: an unpolled idle's wake-up counts within the
poll and 60 µs. The pingpong (80,000 hand-offs a pair, `PP_N=1280000`; LSE's / LL/SC's s, medians [range]):

| misses | dev VM, 4 rounds | Mac, 5 rounds |
|---|---|---|
| 0 (always poll, before) | 1.065 [0.98-1.17] / 0.905 [0.87-1.06] | 0.71 [0.70-0.74] / 0.63 [0.63-0.65] |
| 1 | 1.81 [1.74-1.99] / 1.83 [1.60-1.95] | |
| 4 | 1.125 [1.04-1.19] / 0.92 [0.89-1.02] | |
| **8 (kept)** | 1.04 [1.02-1.17] / 0.90 [0.89-1.04] | 0.71 [0.70-0.72] / 0.65 [0.63-0.66] |

**Kept: 8**, the least that kept the hand-offs on both hosts. An idle 4-vCPU guest's host CPU (`idle-cpu.ts 4 5 20 -
<misses>`, the Mac's Node, 4 rounds alternated, % of a core): always polling 7.69-7.92 (7.77), 8: 6.59-7.02 (6.71),
**−1.06 points**, the bound of loop 83's 0 µs arm. Firefox's pages session (`bench/gpu/ab-mac.sh`, 3 rounds, each
round starting with the next arm; median [range]):

| | always poll (`vmiss=0`) | 8 (kept) | |
|---|---|---|---|
| the renderers' CPU (s) | 259.9 [257.8-260.4] | 256.8 [256.1-258.7] | −1.2%, overlapping |
| their instructions (G) | 2,120 [2,108-2,135] | 2,072 [2,064-2,082] | −2.3%, no overlap |
| energy (J) | 774 [773-777] | 765 [762-770] | −1.2%, no overlap |
| the starts and the pages' loads (s) | 49.2 + 65.0 | 49.2 + 65.1 | unchanged |
| busy MIPS; modules; stalls of 20 ms+ | 500; 2,674; 0-1 | 498; 2,652; 1-2 | |

The renderers' CPU fell by ~3 s against the ~5.6 s the counts predicted (2.76% of a core over 202 s): an unpolled
idle's wait has costs of its own the poll's time doesn't include. The parallel boots in Chromium (`gates.sh 3 0 8`,
`bench/run-mac.sh`, 3 rounds alternated; ranges of the rounds' medians, ms; `python3 ../perf53/summary.py`):
`smp_alpine_jit` n1 / n2 / n4 total 4866-4988 / 4558-4630 / 4553-4632 → 4909-4989 / 4592-4653 / 4564-4632 (+0.0 /
+0.0 / −0.4%, overlapping), n4's CPU −1.8% (overlapping), its instructions −2.8% and energy −2.0% (no overlap);
`smp_user_jit_4` 10278-10690 → 10362-10425 (−0.2%, overlapping), its CPU −0.6% (overlapping). Not run: the paired
command's `node`, `user` and `boot` (deterministic round-robin: the vCPU worker doesn't run there). Memory: none (a
counter a vCPU).

Tests: `tests/idle-wait.test.ts` "a vCPU stops polling after `misses` idles in a row without a wake-up a poll catches,
and polls again after one" and "an idle that doesn't poll still ends at its wake-up, through the wait" (one that came
before the idle began ends it at once, polled or not); `tests/knobs.test.ts` pins `?vmiss=`. Planted, each caught by
the first or the second: an unpolled idle's soon wake-up not bringing the poll back; `misses` 0 never polling; a catch
not resetting the count; an unpolled idle sleeping on its wake word as it is now instead of the exit's value (a
wake-up between the core's return and the idle lost). The worker passes `idle` the exit's wake value whatever the
rule says (the spin, host-stall and SMP tests ran with the rule on). CI: `scripts/ci.sh` passed (731 s; its first run
failed only the remote disks' cache test at "cacheBytes before", the known flake #279, which passed alone 3 of 3 right
after), `scripts/ci-jit.sh` (284 s) and `scripts/ci-debian.sh` (295 s), each alone.


## PERF loop 99: a snapshot's load in one pass, its BLOB frames and a save's BLOB and DISK frames on the pool (2026-11-28)

The PERF queue's row 31 ([#209](https://github.com/gbl08ma/waarm64/issues/209),
[#210](https://github.com/gbl08ma/waarm64/issues/210), [#211](https://github.com/gbl08ma/waarm64/issues/211)): one
probe pass over all three, then what the counts justified. The dev VM (M4, Lima, 8 vCPUs), Chromium 155.0.8059.84
headless (SwiftShader), the persistent profile `target/snapz/profile`, `bench/snapz/probe.ts` (`OPS=load,kept`,
`SETTLE_S=20` unless said); the Mac host through `bench/snapz/probe-mac.sh` (Chrome for Testing on its GPU; the warm
snapshot loads with 3D off there). Raw: `results/perf99/` (`baseline/`, today's tree before anything; `start/`, the
start's marks, `marks.py` their patch; `ab-load/` and `ab-load2/`, the variants' A/B, `run-ab.sh` its driver;
`final/` and `final2/`, base against new, `run-ab2.sh` and `web.patch`; `mac/`; `summary.py` → `summary.json`).

**Today's numbers** (one run each after a warm-up read of the file; the desktop, ms): the load's worker `total`
930-951: `check` 312, of which waiting for the file's pieces 224-232, `state` 70, `ram` 381-400 (its own reads 230-262:
the file read a second time), `disk` 66-69, `start` 75-78. The kept save's pause 867-884: `state` 105, `blobs` 44,
`ram` 621-640, `disk` 90. Debian: `total` 267 (`check` 64, `ram` 55, `disk` 37-41, `start` 73), pause 143-144.

**#209, the load.** Bounded first: the check pass with its RAM frames also unpacked (a diagnostic, nothing placed)
took 389-406 ms against 312, so one pass that checks and places would take ~450 against `check` + `state` + `ram` ≈
770. Built:
1. **One pass** (docs/platform.md "One pass"): the machine worker makes the machine's memories as soon as the header's
   refusals are past (web/vm.ts `makeMemories`, the layout `bootVm` makes, which takes them as `BootOptions.memories`
   and refuses another shape's), and `readSnapshot`'s `ram` reads the file once: every frame's CRC and the structure
   checked as the check pass did, the state kept, RAM's pages put into the new memories, the DISK frames checked; `fill`
   reads only the DISK frames again, from the first one's place (`openSnapshot`'s `from`). No disk is touched before
   the whole file is checked; RAM is, but it is the new machine's (a refusal drops it). The memory grows moved ahead
   of the core's instance: the instance doesn't grow the memory (checked), so RAM's place is the same.
2. **Eight pieces read ahead** (`AHEAD` 4 → 8): the one pass waited 260-290 ms for its pieces at four, 60-90 at eight,
   ~20 at sixteen. 32 MiB in flight instead of 16.
3. **A piece waits for any worker's, not the oldest's**: the reader had waited 216 ms of a 451 ms pass behind the
   oldest piece while the workers done with theirs sat idle (`room`); a refusal is still the first failing frame's.
4. **The one pass's BLOB frames on the workers** (the issue's "state on a pool job"): the piece's worker unpacks a BLOB
   frame and posts its bytes back (transferred: `FrameJob.back`, `ReadFrame.later`); one it fails, or whose bytes
   don't come, is done on the machine worker. Alone (before 2 and 3) it moved `state` 86 → 24 ms into `ram` and the
   pass no shorter: the pass was bound by the reads then.

The variants alternated (`ab-load.txt`, `ab-load2.txt`; the desktop, `OPS=load`, `SETTLE_S=5`, worker `total`, medians
(ranges)):

| arm | rounds | total | pass (`check`+`state`+`ram`) | waiting for pieces |
|---|---|---|---|---|
| base (two passes) | 3 | 944 (937-949) | 779 (774-780) | 261-262 (restore pass) |
| one pass | 3 | 646 (641-657) | 481 (473-485) | 269-290 |
| + eight ahead | 3 | 616 (608-624) | 445 (441-455) | 60-89 |
| + any worker | 3 | 605 (603-613) | 437 (435-446) | 183-192 |
| + sixteen ahead, any worker | 3 | 610 (596-610) | 444 (430-445) | 20-28 |
| eight ahead, BLOB on the workers | 4 | 628 (608-630) | 458 (439-461) | 54-112 |
| eight ahead, any worker, BLOB on the workers | 3 + 4 | 587 (586-591), 584 (575-585) | 418, 412 | 163-232 |

Any worker alone overlaps eight ahead (608-624 against 603-613); with the BLOB frames on the workers it counts (584
against 628, 4 rounds each, apart): kept together. Sixteen ahead gave nothing over eight.

**#211, the save.** Counted first (a diagnostic of the writer's frames, `d99-desktop.log`): the BLOB frames 148, 114 MB
→ 1.9 MB packed, 21.6 ms of the codec and CRC of their 44; the DISK frames 200, 36 MB → 3.9 MB, 17.7 ms of the codec
and 12.6 of reading the blocks from the device worker; the rest copies, the sink and OPFS. Built: **BLOB and DISK
frames as the pool's `bytes` jobs** (the writer's `pool`; three in flight a worker, written in order; a copy of the
bytes transferred to the worker, in buffers the workers give back with their frames, a frame its worker failed made
on the machine worker from the caller's bytes). A first version that made a new copy a frame added 64 MiB to the save's
peak (`final/`: 209 MiB against 145); with the buffers given back it adds ~13 (`final2/`).

**Before and after** (base = 9553399d's web/, new = this loop's; alternated rounds, a browser each, medians (ranges),
ms; memory = the browser's RSS at the save's peak over the sample before it, MiB):

| | desktop base (`final2/`, 3) | desktop new | Debian base (`final/`, 3) | Debian new |
|---|---|---|---|---|
| load: the worker's `total` | 1,012 (977-1,033) | **639** (602-677) | 282 (269-332) | **230** (229-230) |
| ... the pass(es) | 825 (812-853) | 451 (427-492) | 138 (129-185) | 90 (90-93) |
| ... `disk` | 66 (65-104) | 78 (78-81) | 39 (39-42) | 42 (41-43) |
| load: wall (100 ms polls) | 1,157 | 855 | 456 | 355 |
| kept save: paused | 898 (867-966) | **790** (789-857) | 146 (144-149) | 147 (146-152) |
| ... `blobs` | 47 (46-48) | 15 | 1 | 1 |
| ... `disk` | 98 (91-116) | 36 (36-68) | 16 | 15 |
| ... memory added | 131 (129-136) | 144 (135-151) | 98 | 105 |

The first session (`final/`, 4 desktop rounds, before the buffers were given back) had the load 1,095 → 628 and the
pause 974 → 822. The disk pass costs ~8 ms to its first frame (its own reads); `disk`'s spread is OPFS's flush (60 ms
either way, two passes too). **On the Mac** (`mac/`, 3 rounds an arm, 3D off): the load's `total` 796 (791-797) → 466
(418-472), −41%; the pause 679 (670-727) → 638 (626-639) (no 3D state there: its BLOB frames are 1 ms), its `disk` 90
→ 44. The load's memory: eight pieces ahead hold 16 MiB more while it reads; the BLOB frames' copies are 1 MiB each,
transient, as the machine worker's own were.

**#210, the start** (closed by its counts; `start/`): the machine worker's module load (the page's `new Worker` to its
module's first statement) is 64-66 ms on the dev server and **16-26 on a build** (`npm run dist -- --out`, served by
the new `DIST=` of the probe); the vCPU workers run 25-39 ms after the machine worker's `loaded` answer on the dev
server and **17-18 on a build** (the issue's ~95-110 and ~120 were the dev server's of their time). The build's start
shows another 360-420 ms in `prepare`: the preview server's HEAD of a disk URL reads the whole file (sirv's; Debian's
400 MB: 380 ms by curl), a bench artifact (a user's disks are files or another server's), now in
docs/benchmarking.md. The desktop's 3D state `load` isn't on the path to `running`: Debian's `start`, without 3D, is the
same 73-76 ms as the desktop's. The memories' grows (12-18) now run before the pass, not in `start`. Nothing left
there worth building.

**Not built:** a frame index at the file's end (#209: the pass is no longer bound by one thread's reads but by the
workers' RAM work; the reader's wait is 160-230 ms of a ~420 ms pass spent with every worker busy); the 3D state sent
to the GPU worker before RAM (#210: not on the path).

**Tests:** tests/snapshot.test.ts "a load's one pass" (new: RAM in the views made ahead and the blobs whole before
`readSnapshot` returns, for one thread and pools of 1, 3 and 6, a pool failing every third piece, one returning no
bytes or bytes of the wrong size, one closed halfway; the overlay untouched until `fill`, which refuses other views;
a damaged RAM frame refused by the pass itself with the disk untouched, before a later DISK frame's refusal of its
slot, which alone is refused as that; RAM of another size refused; the pass's frames through pieces of 4,099 bytes to
the default, the disk pass's blocks from the first DISK frame and the end's count), "memories made ahead…" (new:
another shape refused, three ways; its RAM the machine's), "a save's pool" (now with BLOB frames, a run of 300
blocks in one buffer and blocks of their own, through pools of 1-6, a pool failing every third BLOB or DISK frame and
one closed among them, the caller's blobs as they were, the copies' buffers at most those in flight);
`runThroughSnapshots` restores every other snapshot through the one pass (the step-exact boots through snapshots).
**Planted bugs**, each caught, the source restored: the pass not placing RAM, the disk pass's count one off, a DISK
frame's refusal not waiting for the frames before it, the refusal of the oldest work read as the work, a BLOB frame's
bytes taken at any size, a `bytes` frame of the wrong tag, a failed `bytes` frame not made here, the copy one byte
short, the copies' buffers not given back, the memories' shape not checked, `fill`'s views not checked.

CI: `scripts/ci.sh` (729 s), `scripts/ci-machines.sh` (327 s), `scripts/ci-debian.sh` (266 s) and
`scripts/ci-graphics.sh` (320 s) passed, each alone, on the first run.


## PERF loop 100: the review of the idle wait fixed (2026-11-28)

An out-of-context static review of how an idle vCPU waits and is woken in parallel SMP (`review/idle-wait`: web/idle-wait.ts
with loop 98's `pollRule`, the vCPU worker, core/src/vm/parallel.rs, the xHCI's due time, the console drain) reported
five findings. **All five held; each is fixed with its test failing first on 545bf283.** Base for the numbers:
545bf283 (its web/ and core); data `bench/boot/results/perf100/` (its README).

1. **An off vCPU took the host's device and RX signals** (held). Every vCPU is woken by a signal and takes the bits at
   its pass's top, an off one too, which returns `IDLE` at the off branch without the xHCI's tick; a completion that
   came within the xHCI's 125 µs latency leaves a due time (`spis`) that only an on vCPU's tick or idle deadline acts on,
   and an on vCPU that read `xhci_due` before the store idled to its own timer. Fixed: an off vCPU leaves
   `SIGNAL_RX`/`SIGNAL_DEVICE` to the on ones (whom the same signal woke), and takes them only when every vCPU is off
   (SYSTEM_SUSPEND). Test: core/src/vm/tests.rs `an_off_vcpu_leaves_the_host_signals_to_an_on_one` (failed first: the
   off vCPU 1 cleared the bit).
2. **A DSB waiter wasn't woken when its target left the core** (held). `sync` takes a target that isn't `RUN` as done,
   but only a drain woke the waiter: a target that went idle (or CPU_OFF) between its last drain and its return left the
   waiter in its 1 ms `memory.atomic.wait32`. Fixed: `run_cpu`, after its `RUN → OUT` (or with `OFF` stored), wakes the
   waiters when its queue is still pending (`wake_waiters`, which `drain` now shares). Test:
   `a_vcpu_that_leaves_with_maintenance_queued_wakes_the_dsb_waiters` (another thread holds the platform lock that
   CPU_OFF takes, marks vCPU 0's queue pending and vCPU 1 waiting; failed first: vCPU 1's wake word didn't move).
3. **`pollRule` counted catches in different windows polled and unpolled** (held): polled `ms < 2·spun` (40 µs),
   unpolled `ms < spinMs + WAIT_WAKE_MS` (80 µs), so wake-ups 40-80 µs into an idle (minus the wait's latency) had 8
   idles in 9 poll in vain. Fixed with 5.
4. **The console drain didn't wake a vCPU in TX_FULL** (held): the worker waited a whole ms on its wake word, which the
   drain doesn't bump (and on the word's value at the wait, not the exit's). Fixed: the worker waits on the TX ring's
   tail while the ring is full (`txFull(ctl, ring, …)`), and `web/vm.ts` `drain` notifies the tail. Tests:
   tests/idle-wait.test.ts "TX_FULL waits for the drain…" (unit; failed first: 1 ms) and "parallel: a vCPU stopped by a
   full console ring runs on when the host drains it, not a ms later" (one vCPU storing to the PL011 forever, the host
   draining a full ring 31 times; the median from the drain to the next byte 0.40 ms before, 0.045-0.054 after).
5. **Unpolled, the poll came back only if the wait woke within 60 µs** (held): on a host whose futex wake is slower,
   hand-offs within the poll never registered once it stopped. Fixed with 3: a polled idle is caught only when its
   poll ended it (`ms < spun + 8 µs`: a wait's wake-up takes longer), an unpolled one only when woken within the poll's
   length (a wake-up a poll would have caught whatever the wait's latency); and once stopped the vCPU still polls one
   idle in `POLL_PROBE` (16), whose catch brings the poll back. `WAIT_WAKE_MS` is gone. Tests: "wake-ups past the
   poll stop it…" (900 idles woken at 35-300 µs on wait latencies of 16-36 µs: 800 polled before, ≤ 64 now) and "a
   vCPU that stopped polling polls again once wake-ups come within the poll, however slow the wait wakes" (16-300 µs:
   0 of 800 hand-offs polled at 90 µs before); the rule's own test rewritten for the probes.

The review's paths no test reaches: the worker's wiring of the rule (`seen`'s clock, the off vCPU's one-second idles
counted as misses) stays covered only by the guests' runs (spin, host-stall, SMP, the benches), as before; an on
vCPU's deadline-less idle is correct as it is (nothing is due), its doc comment unchanged.

**Planted bugs**, each caught, the source restored and the wasm rebuilt: the off vCPU taking the bits (test 1); every
vCPU off never taking them (test 1's suspend case); no wake-up after leaving with a queue pending (test 2); the probes
never firing (the rule's test and "polls again"); the unpolled window back to the poll and 60 µs (the oscillation
test); the polled window back to twice the poll (the rule's test); the drain not notifying the tail, a lost wake-up
(the end-to-end test); TX_FULL waiting with room in the ring (the unit test).

**Numbers** (median [range]; base → new):

| | base | new | |
|---|---|---|---|
| pingpong, dev VM, 5 rounds: LSE / LL/SC (s) | 1.05 [1.00-1.09] / 0.91 [0.88-0.94] | 1.08 [1.04-1.11] / 0.91 [0.88-0.93] | overlapping |
| pingpong, Mac, 5 rounds | 0.71 [0.69-0.73] / 0.66 [0.62-0.66] | 0.71 [0.69-0.77] / 0.63 [0.61-0.68] | overlapping |
| idle 4-vCPU guest's host CPU, Mac, 4 rounds (% of a core) | 6.68 [6.55-6.87] | 6.51 [6.18-7.05] | overlapping: loop 98's gain kept |
| pages session, 3 rounds alternated: renderers' CPU (s) | 257.6 [254.4-258.0] | 253.6 [253.6-255.2] | −1.6%, overlapping |
| its instructions (G); energy (J) | 2,066 [2,058-2,074]; 769 [762-774] | 2,025 [2,017-2,026]; 756 [753-757] | −2.0%, −1.7%, no overlap |
| its starts + pages' loads (s); busy MIPS | 48.8 + 64.5; 498 | 48.7 + 64.3; 500 | unchanged |

The parallel boots in Chromium on the Mac (2 rounds alternated, ranges of the rounds' medians, ms): `smp_alpine_jit`
n1 / n2 / n4 total 4861-4916 / 4550-4577 / 4536-4574 → 4905-4914 / 4546-4576 / 4553-4566 (0.0 / 0.0 / −0.2%,
overlapping), n4's CPU −0.7% (overlapping); `smp_user_jit_4` 10677-10679 → 10324-10374 (−2.9%, no overlap in 2
rounds; its lua phase's spread is ±270 ms, so no gain is claimed), its CPU −1.0%. No regression anywhere. The pages
session's small drop is consistent with fewer polls in vain (finding 3's oscillation). Memory: none. Deterministic and
realtime round-robin run none of the changed code (the vCPU worker and the parallel run loop's off branch and exit);
`tests/steps.txt` unchanged; no ABI change (the core's exports and the exit record are as they were).
