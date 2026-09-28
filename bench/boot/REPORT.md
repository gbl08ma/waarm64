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
