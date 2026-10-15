# Boot time: M3 baseline (interpreter only)

> A dated journal, appended to per milestone and loop; the current numbers and rules are in
> `docs/benchmarking.md`. References to PLAN.md sections (§2, §7 M…, M9) are to its layout before
> 2026-09-28, when that content moved to `docs/` (M9 is now `docs/backlog.md`).

**Workload:** the M3 test guest (`images/`): Linux 6.18.54 from `allnoconfig` + `images/linux.fragment`, a 6.4 MB uncompressed BusyBox initramfs whose `/init` mounts proc/sys/dev, runs `/test.sh` and powers off through PSCI. 256 MiB of RAM, `console=ttyAMA0 earlycon panic=-1`, deterministic mode (62.5 MHz counter, one tick per step). Image and initramfs hashes are in `images/SHA256SUMS`.

**Method:** `node bench/run.ts --page bench/boot/index.html` (default config, full run) in a worker. Metrics: wall time from `vm_boot` to the first `webpc: init` on the console (the initramfs's `/init` starts; the guest's "shell") and to the PSCI `SYSTEM_OFF` after `/test.sh`. **Cold:** each sample compiles a fresh `WebAssembly.Module` (V8 starts on Liftoff code), and the compile time is included; n = 5. **Warm:** one module, three warm-up boots, then n = 10. Every boot takes exactly **35,362,607 steps** (instructions retired plus exceptions taken), on both hosts and natively. Code at commit `1287f3e0c677`, the same wasm on both hosts (sha256 `e970eba0e18c…`); `dirty` is the untracked kickoff notes.

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

`--only alpine_user_jit`, the userspace phases at N = 1 (`webpc.threads` unset: one worker per
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

The userspace phases run N copies of the work at N (`webpc.threads=N`): throughput = N × t₁ / t_N.
Alpine's boot is mostly serial and still loses 20% at N = 4; Debian's (systemd) gains 30%. N = 8
exceeds the VM's cores (N + 2 threads). Raw: `results/m7-loop8/smp_*.json`.

**Single vCPU** (deterministic `boot_alpine_jit`, c2f927a as A against this loop as B, alternated):
10,633 (±202), 10,365 (±154) → 10,598 (±185), 10,333 (±12) ms, steps identical (2,856,663,287).
Raw: `results/m7-loop8/boot_alpine_jit-*.json`.

The boot suite now ignores markers in the kernel's echo of its command line: Debian's contains
`echo webpc: debian`, so `boot_debian_jit`'s first-marker time (`debian_jit_first`) had been ~1 s
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
its own core (`WEBPC_START_COLD=1`): the URL at 11.6 s. A cold `scripts/build-wasm.sh` in a `git
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
llvmpipe kept four vCPUs at ~54% for ~3 frames a second ([plans/graphics.md](../../docs/plans/graphics.md) §16).
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
timeout's progress bar and its text show on the page's screen (docs/plans/uefi.md "Graphics in the firmware").
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

The backlog's "a compile worker: the host's installs stop every vCPU at once" (plans/video.md §8: with Firefox on the
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

| | MIPS | stalls ≥ 20 / 50 / 100 / 250 / 500 / 1000 ms | longest | stalled ms a second a vCPU | `webpc-slow` installs |
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
writes, plans/video.md §1). What it sends the GPU is ~175-440 KB a second of `SUBMIT_3D` command streams, ~100-280
requests a second (plans/video.md §6's JSON and this session's runs); the host's write into the planes is 0.04 ms a
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
guest's CPU over its media pipeline, as plans/video.md §6 found.
