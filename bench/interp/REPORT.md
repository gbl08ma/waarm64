# Interpreter MIPS baselines (M1 integer, M2 FP/NEON)

## M1: integer guest

**What runs:** the tier-0 interpreter (`core/src/interp.rs`) in wasm, on shared memory in a dedicated worker, through the vCPU exports (`interp_run`). The guest is `guest.c`, bare metal on flat memory, built by `build.sh` into the committed `guest.bin` (clang 22.1.8, `-O2 -mgeneral-regs-only`). It's a loop over a table-driven CRC32, insertion sort, a 16×16 integer matrix multiply, a linked-list walk and byte-string work.
**Method:** `node bench/run.ts --page bench/interp/index.html --config <config>`. Cold is the first 2M instructions after instantiation (one sample). Warm is 15 samples of 20M instructions each, taken after 3 warm-up chunks.
**Date:** 2026-09-25, code at commit `fa617211a391`. The x86_64 JSON says `dirty` only because `M1-KICKOFF.md` was untracked. The Mac copy was an rsync of that tree with the same wasm bytes, not a git checkout, so its `commit` is null.

| Host | Chromium | Config | Cold (MIPS) | Warm median (MIPS) | IQR |
|---|---|---|---|---|---|
| Ryzen 7 5800X3D, Linux x86_64 | 152.0.7977.75 | default | 68.3 | **91.0** | ±0.06 |
| | | turbofan-only | 57.7 | 83.7 | ±0.38 |
| | | liftoff-only | 23.9 | 24.1 | ±0.08 |
| Apple M4, macOS 26.6 arm64 | 153.0.8010.12 (Chrome for Testing) | default | 104.2 | **148.8** | ±3.84 |
| | | turbofan-only | 82.5 | 138.5 | ±4.59 |
| | | liftoff-only | 34.1 | 36.6 | ±0.52 |

Raw data: `results/chromium-{linux-x86_64,darwin-arm64}-{default,turbofan-only,liftoff-only}.json`.

**Notes**
- An earlier x86_64 default run on a dirty tree measured 83.9 MIPS against 91.0 here, so treat about ±8% as noise on this shared desktop. The default vs turbofan-only gap is within that noise on both hosts.
- Liftoff is 3.8× (x86_64) and 4.1× (M4) slower than TurboFan on the interpreter. Tier-up happens early: even the cold 2M instructions run mostly in TurboFan code.
- Every instruction does a fetch through `Mem::host`, a bucket decode and a `match` dispatch, with no decode cache (`ponytail:` note in `interp::step`). That's the obvious lever if the interpreter's speed ever matters beyond being the JIT's fallback and reference.

## M2: FP/NEON guest, and the integer re-run

**What runs:** the same harness with a second guest, `guest-fp.c` → `guest-fp.bin` (clang 22.1.8, `-O2 -march=armv8-a -fno-math-errno`, so ARMv8.0 FP/AdvSIMD only). It's a loop over an auto-vectorized 16×16 f32 matrix multiply (FMLA), an 8-body f64 n-body step (FSQRT, FDIV, FMADD), FMA Horner polynomials, float↔int conversions and a NEON-intrinsics u8 image kernel (UMULL, UQXTN, TBL, CNT, UADALP). FPCR is 0 (round to nearest, no FZ/DN), so the fast paths apply wherever the operands allow. The integer guest is unchanged (same `guest.bin`).
**Method:** as for M1 (`node bench/run.ts --page bench/interp/index.html --config <config>`; the suite now runs `interp_mips` and `interp_fp_mips`).
**Date:** 2026-09-25, code at commit `628574ed6df9` on both hosts (`dirty` only because the kickoff notes are untracked). The Mac ran an rsync of that tree with the same wasm bytes (sha256 `b78189ff…`).

| Host | Chromium | Config | Integer cold | Integer warm (IQR) | FP/NEON cold | FP/NEON warm (IQR) |
|---|---|---|---|---|---|---|
| Ryzen 7 5800X3D, Linux x86_64 | 152.0.7977.75 | default | 50.9 | **95.2** (±0.10) | 14.9 | **15.3** (±0.05) |
| | | turbofan-only | 45.7 | 87.4 (±0.37) | 14.0 | 18.5 (±0.06) |
| | | liftoff-only | 23.6 | 24.0 (±0.03) | 6.0 | 6.0 (±0.01) |
| Apple M4, macOS 26.6 arm64 | 153.0.8010.12 (Chrome for Testing) | default | 64.4 | **151.7** (±2.97) | 21.8 | **22.7** (±0.08) |
| | | turbofan-only | 62.1 | 137.4 (±2.81) | 22.5 | 30.1 (±0.09) |
| | | liftoff-only | 31.2 | 32.2 (±0.33) | 8.5 | 8.8 (±0.07) |

Raw data: `results/chromium-{linux-x86_64,darwin-arm64}-{default,turbofan-only,liftoff-only}.json` (these replace the M1 files, which stay in git history; each now holds both guests).

**Notes**
- **Integer re-run:** 95.2 MIPS on x86_64 (M1: 91.0) and 151.7 on the M4 (M1: 148.8). Adding V0–V31, FPCR and FPSR to `Cpu` and the FP/SIMD decode arms cost nothing measurable; both differences are inside the ±8% noise noted above.
- **The FP/NEON guest runs at about a sixth of the integer rate** (15.3 vs 95.2 on x86_64, 22.7 vs 151.7 on the M4). Every FMLA/FMADD takes the exact software FMA in `fp.rs`. Every vector FP instruction goes lane by lane through an `Fpu` context and `u128` lane extraction. Those are the levers if the interpreter's FP speed ever matters. The JIT (M5) will inline the RNE fast paths instead.
- **TurboFan-only beats the default tiering on the FP guest** on both hosts: +21% on x86_64, +32% on the M4, repeated and well past noise. The integer guest shows the opposite. Why V8's dynamic tiering ends up slower here is open. It's worth a look when the core's helpers become JIT slow paths in M5.

## M3 step 3: the re-run after the MMU

**What changed:** every guest access now goes through `mmu::Bus` (`core/src/mmu.rs`). The benchmark guests still run in user mode with the MMU off (`interp_run`), so this measures what the MMU costs code that doesn't use it. Measuring with the MMU on needs the whole-VM export (`run_system`), which waits for the host ABI note.
**Method:** as for M1/M2. Code at commit `345b4a415737` on both hosts, the same wasm bytes (sha256 `030e4e01e2f3…`). `dirty` in the JSON is only the untracked kickoff notes, plus on the Mac the result files of the earlier configs of the same run.

| Host | Chromium | Config | Integer cold | Integer warm (IQR) | FP/NEON cold | FP/NEON warm (IQR) |
|---|---|---|---|---|---|---|
| Ryzen 7 5800X3D, Linux x86_64 | 152.0.7977.75 | default | 50.5 | **85.7** (±0.22) | 14.2 | **14.8** (±0.10) |
| | | turbofan-only | 40.6 | 80.7 (±0.62) | 12.7 | 17.5 (±0.10) |
| | | liftoff-only | 23.2 | 23.5 (±0.02) | 5.8 | 5.6 (±0.05) |
| Apple M4, macOS 26.6 arm64 | 153.0.8010.12 (Chrome for Testing) | default | 75.5 | **139.5** (±2.31) | 21.5 | **22.1** (±0.03) |
| | | turbofan-only | 61.4 | 127.5 (±2.57) | 21.0 | 29.1 (±0.20) |
| | | liftoff-only | 30.1 | 32.2 (±0.30) | 8.6 | 8.6 (±0.07) |

Raw data: `results/chromium-{linux-x86_64,darwin-arm64}-{default,turbofan-only,liftoff-only}.json` (these replace the M2 files).

**Notes**
- **Against M2: integer −10% on x86_64 (95.2 → 85.7) and −8% on the M4 (151.7 → 139.5); FP/NEON −3% on both.** Step 1 (exception model, system registers) had cost nothing: 94.9 on x86_64. The loss is the MMU step.
- **The first MMU build lost 43% (54.4 MIPS on x86_64),** although no guest instruction took an MMU path. Any call site into MMU code (a TLB miss, a page split) inlined into the interpreter's big dispatch function slowed the whole function down in V8: the fast paths are the same, only the untaken calls differ. Moving the fetch back to a plain physical read alone recovered 60 → 79 (`--quick`). The fix is two copies of the interpreter: `Bus` is a trait with `Flat` (MMU and `SCTLR_EL1.A` off: one physical access) and `Mmu` (TLB, walks, page splits), and the run loop picks the copy per instruction from `SCTLR_EL1`. Forcing the per-instruction step into the run loops (instead of leaving the call to V8) was worth another ~15%.
- **What the remaining 10% is** (x86_64, default, full runs): the SP alignment check on SP-based loads/stores costs 3.3% (88.6 without it), and it's architectural (Linux sets `SA0`). Choosing the interpreter copy per instruction costs 2.7% (88.1 with `Flat` hard-wired); moved out of the loop below. The last ~4% is spread over the new fault and accessor types and wasn't split further.
- **Choosing the copy outside the loop (commit `8912986`).** An `MSR` that changes `SCTLR_EL1.M` or `.A` now retires with the internal `Exit::Resync`, and the run loops re-pick the copy only then. Default config, full runs, same wasm on both hosts (sha256 `cae0c2c9c75b…`): **x86_64 88.5 integer / 15.2 FP** (±0.14 / ±0.05), **M4 145.4 / 22.4** (±2.50 / ±0.10). Against the per-instruction choice that's +3.3% integer on x86_64 (confirmed back to back: 86.7 old vs 88.8 new) and +4.3% on the M4; FP is unchanged. That leaves integer −7% (x86_64) and −4% (M4) against M2, of which the architectural SP alignment check is ~3%. `results/chromium-*-default.json` now hold these runs; the turbofan-only and liftoff-only files are still from `345b4a4`.
- These are V8 code-generation effects, so they will look different in JIT code. The JIT (M5) inlines its own TLB lookup and keeps slow paths as helper calls, which is the shape that suffered here: check the generated machine code (M0.5 method) when it's built.

## M3 step 4: the re-run after the platform devices

**What changed:** the timer, GIC, PL011 and the whole-VM run loop (`core/src/vm.rs`). The benchmark still runs the guests in user mode through `interp_run`, so this checks that the interpreter's flat and MMU copies didn't pay for the devices. They shouldn't: device MMIO re-executes the faulting instruction on a third `Bus` copy (`vm::Io`), and timer registers leave the interpreter through an exit. `exec` grew by 26 bytes per copy (`tools/wasm-sizes.ts`) and kept its inlined handlers.
**Method:** default config, full runs, code at commit `88c35afe466b`, the same wasm on both hosts (sha256 `19abbd20fd7f…`). `dirty` is the untracked kickoff notes. Before that, three back-to-back `--quick` pairs on x86_64 against a build of `fd7a3c0`: integer 88.3/87.7/88.3 old vs 88.6/88.3/86.6 new, FP 15.0/15.1/15.0 vs 15.0/15.0/15.1.

| Host | Chromium | Integer cold | Integer warm (IQR) | FP/NEON cold | FP/NEON warm (IQR) |
|---|---|---|---|---|---|
| Ryzen 7 5800X3D, Linux x86_64 | 152.0.7977.75 | 51.8 | **87.6** (±0.15) | 14.5 | **15.1** (±0.02) |
| Apple M4, macOS 26.6 arm64 | 153.0.8010.12 (Chrome for Testing) | 68.4 | **146.2** (±1.79) | 21.7 | **22.3** (±0.07) |

Against step 3 (88.5 / 15.2 and 145.4 / 22.4): −1.0% and −0.7% on x86_64, +0.6% and −0.4% on the M4, all under the 5% noise threshold and not seen in the back-to-back pairs. **No change.** Raw data: `results/chromium-{linux-x86_64,darwin-arm64}-default.json` (replacing the step 3 runs).

## M4 step 1: `vm_run` MIPS, splitting the system-mode gap

**What runs:** the integer guest (`guest.c`, rebuilt as `guest-vm.bin` linked at `0x4021_0000`; `guest.bin` rebuilds bit for bit) in a whole VM through `vm_run`, at EL1 with DAIF masked and no timer armed, so the run loop does its per-chunk work (signal word, interrupt lines, GIC, deadline, 1024 steps a chunk) but never takes an IRQ. `vm-start.S` (raw binary at `0x4020_0000`, booted by `vm_boot` like a kvm-unit-tests `.flat`) enables FP and, for `vm_mmu_mips`, the MMU: one 1 GiB identity block through TTBR0 (T0SZ 25), so VA = PA and the guest's code and data are the same in both variants. The TLB is per 4 KiB page whatever the block size, so after warm-up every access hits.
**Method:** `node bench/run.ts --page bench/interp/index.html`, default config, full runs; the four benchmarks in one page. Same wasm on both hosts (sha256 `e970eba0e18c…`), code at `d421351` plus this change. The Mac ran an rsync of the working tree, so its JSON's `commit` is its stale checkout's, not the code's.

| Host | Chromium | `interp_mips` (EL0, flat) | `vm_flat_mips` (EL1, MMU off) | `vm_mmu_mips` (EL1, MMU on) | Linux boot (`bench/boot`) |
|---|---|---|---|---|---|
| Ryzen 7 5800X3D, Linux x86_64 | 152.0.7977.75 | **87.5** (±1.13) | **85.9** (±0.82) | **54.9** (±0.12) | 44 |
| Apple M4, macOS 26.6 arm64 | 153.0.8010.12 (Chrome for Testing) | **145.9** (±3.82) | **145.7** (±3.36) | **94.7** (±1.30) | 68 |

Cold (first 2M instructions): 50.3 / 86.1 / 41.0 on x86_64, 78.2 / 144.8 / 68.9 on the M4. FP/NEON (`interp_fp_mips`) 15.0 and 22.4, unchanged. Raw data: `results/chromium-{linux-x86_64,darwin-arm64}-default.json` (replacing the M3 step 4 runs).

**The split of the gap** (user mode 87.5 → boot 44 on x86_64; 146 → 68 on the M4):
- **The run loop costs nothing measurable:** −1.8% on x86_64, −0.1% on the M4, both under noise. Chunking at 1024 steps and checking the signal word and the interrupt lines between chunks is free at this granularity.
- **The MMU copy of the interpreter costs 36% (x86_64) and 35% (M4)** on a guest whose every fetch, load and store hits the TLB. It's most of the gap: 87.5 → 54.9 of the way to 44, and 146 → 95 of the way to 68.
- **The rest (54.9 → 44, 95 → 68, about −20% and −28%) is the boot's own work:** TLB misses and walks, ~1,000 exceptions, ~46 IRQs, timer and UART accesses leaving the interpreter, and a different instruction mix (`bench/boot/REPORT.md`).
- Why the TLB-hit path costs a third isn't split yet: every instruction fetch goes through the TLB (no decode cache or per-page fetch pointer), and so does every load and store. M3 step 3 measured the MMU copy only with the MMU off. The JIT (M5) replaces both paths with its own inlined lookup, so whether to tune the interpreter's is an open choice (PLAN.md §7 M9).
