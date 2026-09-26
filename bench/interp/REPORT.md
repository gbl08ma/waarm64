# Interpreter MIPS baselines (M1 integer, M2 FP/NEON), and the JIT's (M5)

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

## M5 step 2: the gadget-only JIT baseline

**What runs:** the same four guests through the tier-1 JIT's correctness scaffold (`core/src/jit/`): blocks of up to 32 instructions keyed by PA, every instruction a call from the block's wasm function to a core helper (`jit_exec_flat`/`jit_exec_mmu`, the interpreter's `exec_at`), batched into modules, entered through a dispatcher (instruction-TLB translation of the PC, a 4096-entry direct-mapped jump cache, a `call_indirect` through the core's table). Policy `jit::Config::DEFAULT`: threshold 50 dispatches, 32 blocks per module or a 100,000-step timeout, 16,384 blocks of code cache. `jit_mips`/`jit_fp_mips` run in user mode (`jit_new`/`jit_run`), `vm_jit_*` in the whole VM (`VmConfig.jit` = 1). **Expected to be slower than the interpreter; this is the baseline steps 4–8 improve on.**
**Method:** `node bench/run.ts --page bench/interp/index.html`, default config, one full run of all eight benchmarks, x86_64 only (both hosts come in M5 step 10). Code at `2ada422` plus step 2c. JIT counters over the cold window (the first 2M instructions) and the warm window (the 15 measured chunks), from `jit::Stats`.

| Guest | Interpreter warm (IQR) | JIT warm (IQR) | JIT / interp | Interp cold | JIT cold | Dispatches / insn | Avg block | Interpreted, cold / warm | Cold: blocks, modules, bytes, compile |
|---|---|---|---|---|---|---|---|---|---|
| integer, EL0 | 88.7 (±0.60) | **64.8** (±0.31) | −27% | 50.4 | 44.6 | 0.240 | 4.16 | 6.9% / 0 | 20, 4, 6.0 KB, 0.5 ms |
| FP/NEON, EL0 | 15.1 (±0.02) | **14.8** (±0.10) | −2% | 14.5 | 13.2 | 0.087 | 11.48 | 5.7% / 0 | 30, 2, 12.4 KB, 0.2 ms |
| integer, EL1 MMU off | 87.8 (±0.66) | **64.6** (±0.49) | −26% | 87.5 | 43.1 | 0.240 | 4.15 | 7.3% / 0.26% | 25, 5, 6.6 KB, 0.4 ms |
| integer, EL1 MMU on | 54.5 (±0.43) | **54.9** (±0.08) | +1% | 40.5 | 39.7 | 0.240 | 4.15 | 7.3% / 0.26% | 25, 5, 6.6 KB, 0.4 ms |

Host: Ryzen 7 5800X3D, Linux x86_64, Chromium 152.0.7977.75. Raw data: `results/chromium-linux-x86_64-m5-step2.json`.

**Notes**
- **The interpreter didn't move.** Sharing `exec_at` between `step_bus` and the helpers, and the run loop's branch to the dispatcher, left `interp_mips` 86.5 → 88.7, `interp_fp_mips` 14.7 → 15.1, `vm_flat_mips` 89.2 → 87.8 and `vm_mmu_mips` 54.9 → 54.5 against a build of `7de3be8` run just before (all within noise). One full run in between read 81.8 and 80.8 for the first and third; they came back to 88.5 and 86.6 alone and in the run above, so that was the shared desktop.
- **Where the gadget JIT loses:** on the integer guest it costs 15.4 ns per instruction against the interpreter's 11.3, about 17 ns more per 4.16-instruction block. Each block is one dispatch (a PC translation and a jump cache hit: the warm windows compile nothing and never reach the `HashMap`) plus a `call_indirect` over up to 20 hot blocks, which step 1 measured at 13–16 ns cycling over 16 blocks, plus four import calls into the core (~2.2 ns each, spike §3). So the table call, not the lookup, is most of the loss; linking (step 7) removes it, and inlining (steps 4–6) removes the helper calls.
- **FP loses little** because the blocks are long (11.5 instructions) and each instruction's helper does a lot of work.
- **With the MMU on the JIT breaks even**: a block translates its fetch once at entry, where the interpreter's MMU copy translates every instruction's fetch through the TLB (the 36% M4 step 1 measured is partly that).
- **Warm, in the VM, 0.26% of steps are interpreted:** blocks that don't fit in what's left of a 1024-step chunk (or before a deadline) run in the interpreter, which keeps the step count exact.
- **Cold:** 4–5 modules of ≤ 32 blocks compile in 0.4–0.5 ms in total (the 100,000-step timeout emits the partial batches); cold MIPS is 44.6 against the interpreter's 50.4 in user mode. The VM guest's cold window hides the interpreter's own warm-up (87.5, nearly warm), so the JIT's cold number there is mostly V8 compiling the JIT modules lazily.

## M5 step 4: inline integer ALU and branches

**What runs:** the step 2 JIT with `core/src/jit/emit.rs`: moves, ADR/ADRP, add/sub (all forms, with flags), ADC/SBC, logical, bitfield moves, EXTR, shifts, conditional select and compare, multiplies, divides, REV/RBIT/CLZ/CLS, the NOP hints and every branch are emitted as wasm over the `Cpu` in memory (NZCV stored whole after each flag-setting instruction). Everything else (loads and stores above all) is still a helper call. Same policy as step 2 (threshold 50, batches of 32, 16,384 blocks).
**Method:** `node bench/run.ts --page bench/interp/index.html`, default config, one full run of the eight benchmarks at `641aa67`; `interp_mips` again alone twice (below). Boots: `--page bench/boot/index.html --only boot|boot_jit|boot_alpine|boot_alpine_jit` (the `_jit` variants are new: `VmConfig.jit` = 1), deterministic, 5 cold and 10 warm Buildroot boots, 3 cold and 5 warm Alpine boots. "Inline, static / dynamic": the share of compiled instructions that are inline, and of the instructions run in JIT code (`jit::Stats`, ABI 12).

| Guest | Interpreter warm (IQR) | JIT warm (IQR) | JIT / interp | Step 2 JIT | Interp cold | JIT cold | Dispatches / insn | Inline, static / dynamic |
|---|---|---|---|---|---|---|---|---|
| integer, EL0 | 88.8 (±0.33)¹ | **134.8** (±0.15) | **+52%** | 64.8 | 48.4¹ | 89.3 | 0.240 | 72% / 72% |
| FP/NEON, EL0 | 15.2 (±0.01) | **15.5** (±0.03) | +1% | 14.8 | 14.2 | 13.6 | 0.087 | 28% / 30% |
| integer, EL1 MMU off | 89.1 (±0.11) | **131.9** (±0.12) | **+48%** | 64.6 | 77.5 | 65.0 | 0.240 | 70% / 72% |
| integer, EL1 MMU on | 54.1 (±0.19) | **90.5** (±0.09) | **+67%** | 54.9 | 41.0 | 55.9 | 0.240 | 70% / 72% |

¹ Alone (`results/chromium-linux-x86_64-m5-step4-interp-alone.json`; a second run read 88.6 ± 0.21). In the full run it read 69.0 (± 1.20), the shared desktop's one-off low reading the step 2 notes describe; the interpreter's code didn't change in step 4 (a few field helpers became `pub(crate)`).

| Boot (Chromium, deterministic) | Interpreter warm (IQR) | JIT warm (IQR) | JIT / interp | Step 3 JIT | Steps in JIT code | Dispatches / insn | Inline, static / dynamic | Compiled |
|---|---|---|---|---|---|---|---|---|
| Buildroot, to power-off | 1069 ms (±6) | **1071 ms** (±113) | 0% | 1.6 s² | 84.5% | 0.198 | 66% / 68% | 12,425 blocks, 471 modules, 2.0 MB, 51 ms |
| Alpine, to power-off | 68.1 s (±0.07) | **58.9 s** (±0.05) | **−14%** | 104 s² | 96.1% | 0.180 | 70% / 73% | 244,487 blocks, 15,116 modules, 42 MB, 1.49 s, 14 flushes |
| Alpine, to its script | 57.3 s (±0.07) | **48.2 s** (±0.07) | −16% | | | | | |

² `tests/browser.test.ts` timings from step 3 (one boot each), not `bench/run.ts`. Cold boots: Buildroot 1168 ms JIT vs 1091 interpreter, Alpine 58.9 s vs 68.1 s.

Host: Ryzen 7 5800X3D, Linux x86_64, Chromium 152.0.7977.75. Raw data: `results/chromium-linux-x86_64-m5-step4.json`, `results/chromium-linux-x86_64-m5-step4-interp-alone.json`, `../boot/results/chromium-linux-x86_64-m5-step4-{boot,boot_jit,boot_alpine,boot_alpine_jit}.json`.

**Notes**
- **The JIT now beats the interpreter** on every integer guest and on Alpine. The integer guest costs 7.4 ns per instruction against 15.4 at step 2 and the interpreter's 11.3; the other 28% of its instructions (loads and stores) are still helper calls, and each 4.2-instruction block is still one dispatch and one `call_indirect`, the costs steps 5 and 7 remove.
- **With the MMU on the gain is largest (+67%)**: the interpreter translates every fetch through the TLB, a block translates once at entry, and inline instructions touch no TLB at all.
- **FP barely moves**: its hot code is FP and NEON helpers (M6 lowers them); 30% of its steps are inline integer bookkeeping.
- **Buildroot breaks even**: its boot is short and cold. 15.5% of its steps run in the interpreter (code below the threshold, or blocks that don't fit a chunk), the JIT compiles 12k blocks in 51 ms, and its warm IQR (±113 ms) is 10× the interpreter's, which looks like V8 tiering the 471 modules up at different points in each boot.
- **Alpine flushes the code cache 14 times** (244k blocks through a 16,384-block cache). What it costs, and a larger cache or per-module eviction, belong to steps 7–8 (linking and regions change the block count anyway).
- **The dynamic mix follows the static one** (72% of the integer guest's instructions are inline, statically and as run). The helper-call histogram that picked group 6 was ad hoc (a counter in the interpreter's step for words `emit::inline` rejects, over the Buildroot boot): loads and stores were 85% of the remaining helper calls; then NOP/BTI/PAC hints (2.9% of helper calls), MRS (1.7%), exclusives, MADD (1.1%), DC ZVA, DMB, REV, UMADDL, CLZ. The histogram by `Op` is step 9.

## M5 step 5: inline loads and stores

**What runs:** step 4 plus `emit::ldst`: LDR/STR of every size and sign (unsigned offset, unscaled, pre/post-index, register offset), the integer pairs, LDR (literal) and PRFM inline, through the TLB array of the block's EL with the MMU on (the spike's fast path: tag compare on `(va + len − 1) | 0xfff`, `host = va + addend`) or a bounds check against RAM with it off. Misses, faults, MMIO, page-crossing accesses and a misaligned SP base re-execute the instruction through the step 2 helper. Exclusives, atomics, LDTR/STTR and FP/SIMD accesses stay helpers. **Method:** as step 4, one full `bench/interp` run at `1f5c2b9`, then `boot_jit` and `boot_alpine_jit`; the interpreter's boot numbers are step 4's (its code hasn't changed since).

| Guest | Interpreter warm (IQR) | JIT warm (IQR) | JIT / interp | Step 4 JIT | Interp cold | JIT cold | Inline, dynamic |
|---|---|---|---|---|---|---|---|
| integer, EL0 | 89.2 (±0.31) | **337.9** (±0.80) | **3.79×** | 134.8 | 51.9 | 116.6 | 100% |
| FP/NEON, EL0 | 15.2 (±0.04) | **15.6** (±0.05) | +3% | 15.5 | 14.6 | 15.3 | 31% |
| integer, EL1 MMU off | 89.0 (±0.08) | **218.6** (±0.26)³ | **2.46×** | 131.9 | 78.2 | 98.5 | 100% |
| integer, EL1 MMU on | 54.0 (±0.25) | **179.6** (±0.32)³ | **3.33×** | 90.5 | 40.6 | 81.5 | 100% |

³ The low of two modes. In other runs the same builds switched mid-run, for several samples, to 320 (MMU off) and 225–240 (MMU on) and back (`../results/local` runs; the step 5.1 samples `217 217 217 217 320 320 …`), under the default config and under `--config turbofan-only` alike, so it isn't Liftoff→TurboFan tier-up. It's plausibly V8's speculative inlining of the core's `call_indirect` into the blocks and its deopts, but I haven't verified that. Linking (step 7) replaces that call; until then, compare these guests' modes, not their medians alone.

| Boot (Chromium, deterministic) | Interpreter warm (IQR) | JIT warm (IQR) | JIT / interp | Step 4 JIT | Steps in JIT code | Inline, dynamic | Compiled |
|---|---|---|---|---|---|---|---|
| Buildroot, to power-off | 1069 ms (±6) | **853 ms** (±136) | **−20%** | 1071 ms | 84.5% | 97.1% | 12,425 blocks, 471 modules, 3.4 MB, 56 ms |
| Alpine, to power-off | 68.1 s (±0.07) | **40.1 s** (±0.18) | **−41%** | 58.9 s | 96.1% | 96.9% | 244,487 blocks, 15,116 modules, 69 MB, 1.98 s, 14 flushes |
| Alpine, to its script | 57.3 s (±0.07) | **32.3 s** (±0.12) | −44% | 48.2 s | | | |

Cold: Buildroot 962 ms (JIT) vs 1091 (interpreter), Alpine 40.2 s vs 68.1 s. Host: Ryzen 7 5800X3D, Linux x86_64, Chromium 152.0.7977.75. Raw data: `results/chromium-linux-x86_64-m5-step5.json`, `../boot/results/chromium-linux-x86_64-m5-step5-{boot_jit,boot_alpine_jit}.json`, `results/m5-step5-tlb/` (the layout experiments).

**TLB entry layout (PLAN §7 M5):** against the 16-byte {tag, u64 addend} entry, (A) a `usize` addend (32 bits on wasm32, added in i32) and (B) A plus split tag and addend arrays (12 bytes per entry), on Alpine's boot under the JIT: 40.34 s (±0.21), 40.42 s (±0.02), 41.23 s (±0.18); the interpreter's MMU guest 53.4, 52.6, 52.5 MIPS; Buildroot's JIT boot 857, 860, 870 ms (±135 each) and the JIT's MMU guest (TurboFan-only, bimodal as above) the same within noise. Neither pays: B's extra index arithmetic (the addend offset is half the tag's) costs more than the denser arrays save on this trace, and A saves one wasm op. The entry stays as it is; the emitter finds it with one shift and mask, `(va >> 8) & 0xfff0`.

**Notes**
- **Where the integer guest's time goes now:** 3.0 ns per instruction (11.2 in the interpreter), every instruction inline, one dispatch and one `call_indirect` per 4.2-instruction block. That per-block cost is likely most of what's left: step 1's 13–16 ns per table call cycling over 16 blocks would be more than the whole 12.4 ns a block takes now, so it's cheaper in this steady loop, but it's still a call V8 can't inline without speculation, and linking (step 7) removes it. Registers and NZCV still round-trip through memory (step 6).
- **Alpine:** 97% of the instructions run in JIT code are inline, and 3.9% of its steps are interpreted (cold code under the threshold, blocks that don't fit a chunk). Compiling costs 2.0 s of the 40 s (69 MB of wasm: inline loads and stores are larger than the helper calls they replace, +65% bytes over step 4), and the 16,384-block cache flushes 14 times.
- **Buildroot:** −20%, but its warm IQR stays wide (±136 ms), which fits the same bimodality at boot scale.
- **Still slower under the JIT:** kvm-unit-tests `timer` (3.3 s vs 2.6 s in Node, 106M steps): it spends its time in short blocks around timer polls and WFI, where a dispatch per block costs more than it saves.

## M5 step 6: registers in locals, lazy NZCV

**What runs:** step 5 plus, within each block: guest registers in i64 locals (loaded on first use, written back before helper calls and returns; the load/store slow path writes back before its helper and reloads the instruction's destinations after it), lazy NZCV (setters keep their operands in flag locals; a setter the next one replaces emits no flag code; conditions come straight from the operands where the kind allows, e.g. `cmp; b.lt` is `i64.lt_s`; NZCV is stored before helpers, on a load/store's failure return, and before the block's branch), only the locals a block uses declared, and registers read once and never written read straight from memory. NZCV is still live out of every block (no successor knowledge until steps 7–8). **Method:** as step 5: one full `bench/interp` run at `901bb1a`, `boot_jit` and `boot_alpine_jit`; `--only jit_mips --config liftoff-only|turbofan-only` runs for the per-tier numbers (`results/m5-step6/`, each named after the slice and experiment).

| Guest | Interpreter warm (IQR) | JIT warm (IQR) | JIT / interp | Step 5 JIT |
|---|---|---|---|---|
| integer, EL0 | 89.4 (±0.16) | **370.5** (±1.04) | **4.14×** | 337.9 |
| FP/NEON, EL0 | 15.1 (±0.03) | **15.5** (±0.04) | +3% | 15.6 |
| integer, EL1 MMU off | 88.0 (±0.29) | **349.6** (±0.89)⁴ | **3.97×** | 218.6 (modes 218 / 320) |
| integer, EL1 MMU on | 54.2 (±0.22) | **192.8** (±0.10)⁴ | **3.56×** | 179.6 (modes 177 / 240) |

⁴ The high mode (MMU off) and the low mode (MMU on) of step 5's two-mode behavior, which persists: compare with 320 and 177–180. Earlier step 6 runs read MMU off at 307, 220 and 231.

**The integer guest by V8 tier and slice** (`--only jit_mips`, MIPS):

| Build | Default | TurboFan only | Liftoff only |
|---|---|---|---|
| step 5 | 337.9 | 351.7 | 118.1 |
| 6.1 registers in locals | 357.4 | 368.1 | 111.3 |
| 6.2 lazy NZCV (stored at the block's end) | **240.5** | 231.9 | 105.5 |
| 6.3 NZCV stored before the block's branch | 369.8 | | 101.1 |
| 6.4 only the used locals declared | 373.5 | 382.2 | 107.9 |
| 6.5 once-read registers without a local | 370.5 | 379–384 | 116.2 |

| Boot (Chromium, deterministic) | Step 5 JIT | Step 6 JIT (IQR) | Steps in JIT code | Inline, dynamic | Compiled |
|---|---|---|---|---|---|
| Buildroot, to power-off | 853 ms (modes 785 / 920) | **867 ms** (±157; modes 786 / 945) | 84.5% | 97.1% | 12,425 blocks, 3.9 MB (+13%), 56 ms |
| Alpine, to power-off | 40.1 s (±0.18) | **39.3 s** (±0.32) | 96.1% | 96.9% | 244,487 blocks, 77.6 MB (+12%), 2.04 s, 14 flushes |
| Alpine, to its script | 32.3 s (±0.12) | **31.5 s** (±0.27) | | | |

**Flags (static, `jit::Stats`, ABI 13):** in Alpine's compiled code 8.5% of the lazy flag setters are never stored (Buildroot 9.2%) and 90.5% of conditions are computed directly from a setter's operands (0.8% from NZCV computed in registers, 8.6% from NZCV in memory: flags set before the block). The rest of the setters are stored because NZCV is live out of every block; that, and the conditions from memory, are what steps 7–8 (successor knowledge, regions) can remove.

Host: Ryzen 7 5800X3D, Linux x86_64, Chromium 152.0.7977.75. Raw data: `results/chromium-linux-x86_64-m5-step6.json`, `results/m5-step6/`, `../boot/results/chromium-linux-x86_64-m5-step6-{boot_jit,boot_alpine_jit}.json`.

**Notes**
- **Where NZCV is computed matters to TurboFan, not how often.** 6.2 computed the lazy NZCV at the block's end, after the branch's `select` of the next PC: 240 MIPS (TurboFan only 232). Storing it eagerly after every setter (more work) ran at 368, and storing it just before the block's last instruction at 371. So 6.3 stores lazy flags before a block-ending instruction, keeping them lazy so the branch's condition stays direct. I haven't looked at V8's machine code to see why; the order is pinned by a unit test.
- **Liftoff pays for every declared local**, on every call (it zero-initializes them): 20 unused i64 locals took the integer guest from 101 to 83 MIPS under `--liftoff-only`. Registers in locals won under TurboFan (+5–9%) and lost under Liftoff (118 → 101), which is why the boots didn't gain at first (Alpine 41.9 s at 6.3, Buildroot slower in both modes: much of a boot runs in Liftoff code, and Alpine flushes and recompiles 14 times). Declaring only the used locals (6.4) and leaving once-read registers in memory (6.5) brought Liftoff back to 116 and Alpine to 39.3 s.
- **Code size:** +12–13% over step 5, mostly the load/store slow paths (each writes back the dirty registers before its helper call, stores lazy NZCV on its failure return, and reloads after). Compile time barely moved (Alpine 2.04 s vs 1.98 s).
- **A rustc/LLVM miscompile** (wasm32, simd128, nightly-2026-09-24): counting register uses in a `[u8; 32]` and comparing it into a u32 mask swapped the mask's 16-bit halves (PLAN.md M9 has a 12-line repro). The multi-instruction differential test caught it within the first run; the emitter tracks uses as bit masks instead.

## M5 step 7: linking

**What runs:** step 6 plus chaining. Block functions are `block(vcpu, acc, left) -> acc + retired`; a block whose successor is static (a direct branch, both sides of a conditional one, the fall-through, or the instruction after an MRS, a barrier, CLREX, YIELD/SEV or DC whose helper retired) tail-calls it (`return_call`) with `acc + len` and `left − len` when `left` covers both, so chains retire exactly what the dispatcher would have run. Compiled successors are direct calls (same batch) or imports by table index (`t.<index>`); with the MMU on, one in another guest page is chained behind an instruction-TLB check that its VA still maps to the PA it was compiled for. A successor compiled *after* its predecessor, and every BR/BLR/RET target (translated through the instruction TLB), is probed in the jump cache from wasm and tail-called through the table (`return_call_indirect`). The code cache holds 65,536 blocks (was 16,384) and the jump cache 65,536 entries. **Method:** `bench/run.ts` as step 6, one full `bench/interp` run and `boot_jit`/`boot_alpine_jit` at `b4884bf`; step 6's boots re-measured with the new harness (a GC before every boot, below) at `9b8370b`.

| Guest | Interpreter warm (IQR) | JIT warm (IQR) | JIT / interp | Step 6 JIT | Dispatches / insn (step 6) |
|---|---|---|---|---|---|
| integer, EL0 | 89.1 (±0.29) | **1258.3** (±1.39) | **14.1×** | 370.5 | 0.0000 (0.240) |
| FP/NEON, EL0 | 15.2 (±0.02) | **15.7** (±0.01) | +3% | 15.5 | 0.0000 (0.087) |
| integer, EL1 MMU off | 87.9 (±0.10) | **1090.8** (±7.91) | **12.4×** | 349.6 | 0.001 (0.240) |
| integer, EL1 MMU on | 53.9 (±0.22) | **925.5** (±5.05) | **17.2×** | 192.8 | 0.001 (0.240) |

| Boot (Chromium, deterministic, GC before each) | Interpreter | Step 6 JIT (IQR) | Step 7 JIT (IQR) | Step 7 / step 6 | Dispatches / insn (step 6) | Compiled (step 6) |
|---|---|---|---|---|---|---|
| Buildroot, to power-off | 1069 ms | 938 ms (±3) | **927 ms** (±6) | −1% | 0.0075 (0.198) | 12,430 blocks, 5.0 MB, 68 ms (12,425, 3.9 MB, 56 ms) |
| Alpine, to power-off | 68.1 s | 39.4 s (±0.07) | **24.0 s** (±0.38) | **−39%** | 0.0062 (0.180) | 56,791 blocks, 23.9 MB, 0.78 s, no flush (244,487, 77.6 MB, 1.83 s, 14 flushes) |
| Alpine, to its script | 57.3 s | 31.9 s | **20.2 s** | −37% | | |

Alpine now boots 2.84× faster than on the interpreter. The interpreter numbers are step 4's (its code hasn't changed). Host: Ryzen 7 5800X3D, Linux x86_64, Chromium 152.0.7977.75. Raw data: `results/chromium-linux-x86_64-m5-step7.json`, `results/m5-step7/`, `../boot/results/chromium-linux-x86_64-m5-step{7,6-gc}-{boot_jit,boot_alpine_jit}.json`, `../boot/results/m5-step7-modes/`.

**How the dispatches went** (Alpine in Node, `bench/results/local` scripts, ad hoc): 0.18 per instruction at step 6 → 0.068 with direct links (7.1) → 0.067 with cross-page links and the larger cache → 0.025 with the jump cache for indirect branches → 0.0062 with jump-cache probes for successors compiled later. A histogram of why blocks returned (ad hoc instrumentation, reverted) drove each slice: after 7.1, Buildroot's 2.8M dispatches were RET 28%, successors in another page or not yet compiled 43%, system-instruction ends 16%; after the jump cache, failed probes were almost all misses of blocks compiled after their predecessor, which the static probes then took.

**The two modes (steps 4–6) are explained.** V8 reuses a module's compiled code when a module with the same bytes is still alive, and a deterministic boot emits the same JIT modules every time (and loads the same core), so a boot ran in the fast mode when the previous boot's modules hadn't been collected yet. Without a GC before each boot, Buildroot's samples split 700 / 920 ms (default tiering) and 630 / 2975 ms (TurboFan-only: every module compiled eagerly, or reused); a per-VM nonce appended to each module removes the fast mode; disabling speculative `call_indirect` inlining and deopts changes nothing (`../boot/results/m5-step7-modes/`). `bench/run.ts` now passes `--expose-gc` and the boot suite collects before every timed boot, so the numbers are a first boot's. The user-mode guests' mid-run switches are gone with the dispatcher's `call_indirect` off the hot path.

**Notes**
- **Relinking was tried and dropped:** recompiling a block once a successor it returned through got compiled doubled Alpine's compiled blocks and its cache flushes (30) for 9% fewer dispatches. The jump-cache probe gets the same links without compiling anything, and needs no bookkeeping: the jump cache only ever holds compiled blocks, and invalidation clears it. Direct links are recorded, and dropping a block drops the blocks linked to it, transitively (`tests/jit.test.ts`).
- **The code cache size mattered more than any link:** at 16,384 blocks Alpine flushed 14 times and recompiled 244k blocks; at 65,536 it compiles 56,791 once (Node: 32.4 → 24.8 s).
- **Buildroot doesn't gain:** its boot is short and cold (15.6% of its steps interpreted, 12k blocks compiled for 41M steps), so compiling and Liftoff code dominate, not dispatch.
- **Two bugs in 7.2/7.3 only cost chaining,** so no correctness test could see them: the cross-page guard compared against the page's host address instead of the target's, and the jump-cache index was computed wrongly. The dispatch histogram found both; a call-and-return loop test now pins the indirect lookup.
- **Open (M9):** the jump-cache probes cost the integer guest 12% under default tiering (1258 vs 1430 MIPS without them) though they run once per ~5,000 instructions, and the same build does 1481 under TurboFan-only; flags for inlining, deopts and the tier-up budget change nothing, and moving the probes out of line made the EL1 guest erratic. The remaining Alpine dispatches are mostly instruction-TLB refills after whole-TLB flushes (41,665 per boot: no ASIDs, M9).

## M5 step 8: regions

**Host change.** From step 8 on, numbers come from the Lima VM `dev` on the M4 Mac mini (openSUSE Tumbleweed aarch64, 8 vCPUs, Chromium 153.0.8010.52 headless), not the x86_64 desktop: none of the step 2–7 numbers above compare with them. The step 7 commit `70e323d` is re-measured there as the baseline (a worktree build, with simd128 as it was then).

### 8.1–8.2 measured (regions as the head's loop)

**What runs:** step 7 plus regions (8.1: one function per region, members as nested wasm `block`s, registers kept across internal edges; 8.2: members only the seen blocks of the head's loop, back-edges a wasm `loop` under the budget check). **Method:** `bench/run.ts`, default config, one full `bench/interp` run and `boot_jit` / `boot_alpine_jit` for each build; Buildroot again for the tier split and the experiments; Alpine also in Node (`bench/results/local` scripts, single runs, for profiles).

| Guest (MIPS) | Step 7 (IQR) | 8.2 (IQR) | 8.2 / step 7 | Blocks per region, back-edges (static) |
|---|---|---|---|---|
| interpreter, integer | 138.6 (±1.85) | 138.8 (±1.49) | 0% | |
| integer, EL0 | 1184.5 (±4.6) | **2607.6** (±15.2) | **2.20×** | 2.15, 20 |
| FP/NEON, EL0 | 20.3 (±0.10) | 20.4 (±0.16) | +1% | 1.43, 18 |
| integer, EL1 MMU off | 1105.9 (±10.7) | **1942.7** (±16.9) | **1.76×** | 1.37, 24 |
| integer, EL1 MMU on | 1072.4 (±4.6) | **1736.1** (±19.1) | **1.62×** | 1.37, 24 |

| Boot (Chromium, deterministic, warm; cold) | Step 7 | 8.2 | Compiled, step 7 → 8.2 |
|---|---|---|---|
| Buildroot, to power-off | **655 ms** (±8), rerun 677 (±7); cold 685 | 746 ms (±5), rerun 767 (±6); cold 805 | 12,430 blocks, 5.0 MB → 12,225 regions of 16,970 blocks (1,212 back-edges), 6.8 MB |
| Alpine, to power-off | **17.54 s** (±0.15); cold 17.99 | 18.23 s (±0.19); cold 17.85 | 56,791 blocks, 23.9 MB → 56,137 regions of 69,166 blocks (3,620 back-edges), 28.5 MB |

Dispatches per instruction don't move (Buildroot 0.0075 → 0.0072, Alpine 0.0062). Between runs of the same build the Buildroot medians moved ~3% (655 vs 677), more than their IQRs.

**Buildroot by V8 tier** (warm total, ms): default 655 / 746 / 678, Liftoff-only 1012 / 1054 / 950, TurboFan-only 2147 / 2845 / 2221 for step 7 / 8.2 / 8.2 with regions cut to the head (self-loops still wasm loops). Regions cost ~10% in both tiers and +28% where everything is compiled by TurboFan; without them 8.2 is step 7 within noise.

**Where the boots lose** (Node `--cpu-prof`, self time, step 7 → 8.2):
- Buildroot: JIT code 99 → 92 ms (regions do save execution), but the dispatcher (`jit::steps`, which V8's lazy compilation of JIT functions is charged to) 206 → 245 ms, and our own emission ~+45 ms (`emit_region` runs twice per region, up to six times for a loop, with allocations; `block::next` recomputed per query). 930 of the 12,227 regions are loops, 6.1 blocks each: their members, mostly also compiled on their own, are the +4,750 block copies.
- Alpine (Node: 17.0 s step 7 and 8.2 without regions, 17.7 s 8.2): JIT code 8.28 → 8.62 s, dispatcher +0.20 s, emission ~+0.15 s. By tier (Node, one run each): Liftoff-only 25.6 → **23.6 s**, TurboFan-only 20.4 → 23.1 s; with V8's tier-up budget lowered to 2M (diagnostic only) 16.6 → **16.1 s**, raised to 60M 17.4 → 17.3 s. Region code is faster once compiled; the loss is compiling more and bigger code, and when it reaches TurboFan.
- **Deferring loop regions** to 500 dispatches of the head (the head interpreted until then): Buildroot 705 ms (8.2: 746), Alpine 18.23 s (±0.92; no gain); 5,000: Buildroot 728 ms (interpreting the heads costs more). Not kept (`../boot/results/m5-step8/loop-wait.diff`).

**simd128** (off since 8.2, PLAN M9): the interpreter doesn't notice it: 138.1 (±2.2) integer, 19.7 FP, 142.9 EL1 MMU off, 84.2 MMU on with `+simd128`, against 138.5–138.8, 19.6–19.7, 140.5–142.4, 84.7–85.3 without (two runs).

Raw data: `results/m5-step8/chromium-linux-arm64-{step7,step8.2,step8.2-r2,step8.2-simd128}.json`, `../boot/results/m5-step8/`.

### 8.3: tier-up to loop regions

**What runs:** a head whose region is a loop is compiled alone first, with a hot word counting its entries down from 1000 (`jit::Config::region_after`); the entry that reaches 0 calls `jit_hot`, which compiles the loop region at once and points the head at it (its prologue then tail-calls the region through the table). A region's members that are candidate heads stop counting, except inner loops' heads (PLAN §2 "ABI 17"). **Method:** as 8.2; `region_after` picked in Node (Buildroot 640 / 607 / 620 ms and Alpine within noise at 100 / 1000 / 10,000).

| | Step 7 | 8.2 | **8.3** |
|---|---|---|---|
| integer guest, EL0 (MIPS) | 1184.5 | 2607.6 | **2672.0** |
| EL1 MMU off / on (MIPS) | 1105.9 / 1072.4 | 1942.7 / 1736.1 | **1878.8 / 1724.9** |
| Buildroot, warm (cold) | 655 / 677 ms (685) | 746 / 767 ms (805) | **694 ms** (±6; cold 724) |
| Alpine, warm (cold) | 17.54 s (17.99) | 18.23 s (17.85) | **17.81 s** (±0.30; cold 17.76) |
| Buildroot compiled | 12,430 blocks, 5.0 MB | 16,970 blocks in 12,225 regions, 6.8 MB | 12,777 blocks in 12,494 functions, 69 tier-ups, 5.3 MB |
| Alpine compiled | 56,791 blocks, 23.9 MB | 69,166 in 56,137, 28.5 MB | 59,540 in 57,292, 566 tier-ups, 25.3 MB |

The first version silenced every member that was a candidate head, which left nested loops' inner loops without a region (the integer guest ran at 1637 MIPS: `results/m5-step8/chromium-linux-arm64-step8.3-silenced-inner-heads.json`); `block::Region::inner_free` keeps inner loops' heads counting. **Validation:** the corpus through the JIT (forced: regions at once; stress: tier-up on the second entry, which found that a tier-up must never flush the cache, since JIT code is running: the stale-code checker tripped in kvm-unit-tests `cache`), `tests/jit-diff.test.ts`, a tier-up test in `tests/jit.test.ts`, the Node boots with exact steps. Buildroot is still ~3–6% behind step 7 (694 vs 655–677 ms), Alpine even within noise; the steady-state guests keep regions' gain.

Raw data: `results/m5-step8/chromium-linux-arm64-step8.3*.json`, `../boot/results/m5-step8/chromium-linux-arm64-step8.3-*.json`.

### 8.4: flags across region edges

**What runs:** each region member starts with its flags lazy (every edge into it carries the same setter: conditions come from its operands, `cmp; b` → `b.lt` is `i64.lt_s` across the edge), in memory, or dead (a setter comes before anything reads them, a helper or a possible exit: `emit::Func::touched`); an edge stores NZCV only into a member that needs it in memory, and a block skips the store before its branch when every successor is such a member (exits store it on their way out). The head's flags are never lazy (the function starts from memory), but a head that sets flags first takes its back-edges without a store.

| Guest (MIPS) | 8.3 default | **8.4 default** | 8.3 / 8.4 Liftoff only | 8.3 / 8.4 TurboFan only |
|---|---|---|---|---|
| integer, EL0 | 2672.0 (±12) | **3279.2** (±17), **+23%** | 1639 / **1898** (+16%) | 2683 / **1802** (−33%) |
| EL1 MMU off | 1878.8 | **1944.7** (+3.5%) | 1225 / 1324 | — / 1969 |
| EL1 MMU on | 1724.9 | **1749.9** (+1.4%) | 1118 / 1231 | — / 1747 |

Static counts (integer guest): conditions direct 30 → 32, from memory 5 → 3. Boots unchanged within noise (they have few loop regions): Buildroot 711 ms (±8), Alpine 17.79 s (±0.12).

**TurboFan-only runs the integer guest 33% slower**, the default 23% faster, and both come from the store skipped before the branch: storing there always (lazy flags and dead flags still carried) reads 2642 default and 2674 TurboFan-only. Both tiers run TurboFan code in the loop; what differs is the feedback dynamic tiering collects in Liftoff (speculative inlining of indirect calls among others), which is also where step 7's jump-cache probe cost showed up. Default tiering is the product configuration (M5 decision), so the skip stays; the TurboFan-only drop is in PLAN M9. **Validation:** `tests/jit-diff.test.ts` region classes fail with each planted bug (no store on any edge: 4 and 10 of 1024 programs differ; every member's flags dead: 17 / 19; lazy entry states started from memory: 9 / 4); unit test `flags_cross_region_edges_lazily`; CI.

Raw data: `results/m5-step8/chromium-linux-arm64-step8.{3,4}*.json`, `../boot/results/m5-step8/chromium-linux-arm64-step8.4-*.json`.
