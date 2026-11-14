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
