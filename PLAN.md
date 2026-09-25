# webpc — implementation plan

A whole-system AArch64 emulator for the browser. Guest code is JIT-compiled to
WebAssembly. It runs unmodified arm64 Linux distributions. Chromium is the
primary target.

## 1. Locked-in decisions

| Area | Decision |
|---|---|
| Guest ISA | ARMv8.0-A AArch64 with FP and AdvSIMD (NEON), no AArch32. LSE atomics (v8.1) added early. The crypto extensions (AES, PMULL, SHA1, SHA2) come in M6.5, and stay unadvertised until then. No SVE/SME, PAC, BTI or MTE: leave them unadvertised, and their hint-space encodings run as NOPs |
| Privilege | EL0 and EL1 only. No EL2/EL3 and no secure state |
| MMU | Stage 1 only, 4K granule, 48-bit VA, TTBR0/TTBR1, ASIDs, software-managed access flag |
| Platform | GICv2 (a GICv3 subset later), generic timer, PL011 UART, PSCI over HVC (the core answers calls that need no host and exits to the host for SYSTEM_OFF, SYSTEM_RESET and, from M7, CPU_ON; decided in M3), virtio-mmio v2, and a DTB generated from the VM config |
| Boot | Direct kernel boot (arm64 `Image` + initrd + DTB). No UEFI. For distro disk images, the kernel and initrd are extracted and booted directly |
| Core language | Rust compiled to `wasm32` (the same crate also builds natively for tests). Host glue is in TypeScript |
| Guest memory | **Layout A (decided in M0.5, `bench/spike/memory/REPORT.md`):** one shared wasm32 memory: core state first, then guest RAM (≤ ~3.5 GiB, sized against host RAM at VM start). The Rust core targets wasm32. Every >4 GiB layout cost more than the 5% threshold on x86_64 Chromium: C (memory64) +6–20% in JIT code and +11% in the core, B +12–14%, D +19–28%. On arm64 (M4, macOS Chromium 153) they cost C +17–19% in JIT code (its wasm64 core is free there), B +31–40% and D +26–32%. The guest physical address map is independent of placement, because the TLB translates. Every guest RAM access in generated code goes through one lowering function. TLB tag bits 3–11 are reserved for a memory index, so "A + spill memories" (extra wasm32 memories as NUMA nodes, same fast path as A for memory-0 pages) can be added later without changing A's code |
| License | MIT (or MIT OR Apache-2.0, the Rust-ecosystem default, which also adds a patent grant). Nothing in §6 requires GPL |

Deferred: SVE, EL2, 16K/64K granules (needed for RHEL-family kernels), virtio-pci/MSI, GICv3 ITS.

## 2. Architecture overview

```
┌──────────────────────── Worker (one per vCPU) ─────────────────────────┐
│  core.wasm (Rust)                                                      │
│   ├─ A64 decoder (table-driven)                                        │
│   ├─ interpreter (tier 0; reference semantics; JIT fallback helpers)   │
│   ├─ JIT (tier 1+): guest block/region → wasm bytes → Module           │
│   ├─ MMU walker + per-vCPU software TLB                                │
│   ├─ exceptions, system registers, generic timer, GIC CPU interface    │
│   └─ perf counters (in shared memory)                                  │
│  jit modules: import memory + core helpers, exported via a table       │
└────────────────────────────────────────────────────────────────────────┘
            │ shared linear memory (CPU state, guest RAM, device rings)
┌──────────────────────── Device worker / main thread (TS) ──────────────┐
│  virtio-mmio transports + virtqueues (Rust, in core)                   │
│  backends (TS): block (HTTP ranges, OPFS overlay), net (pluggable →    │
│  your WebRTC network), 9p, console, input, framebuffer → canvas        │
└────────────────────────────────────────────────────────────────────────┘
```

Key design points. The spike in M0 will confirm or adjust each of these.

- **Gadget-style JIT, as in v86.** Tier 1 inlines simple ops (ALU, branches, loads and stores through the inline TLB fast path) and calls core helpers for everything else. Tier 2 widens what gets inlined, forms multi-block regions and turns guest loops into real wasm `loop`s.
- **Guest registers live in wasm locals inside a compiled region.** They're written back to the CPU state struct on region exit, on helper calls that need them, and on exceptions.
- **Lazy NZCV.** Only `S`-suffixed instructions and `CMP`/`CCMP`/`TST` produce flags, so dead flags are eliminated per region.
- **Software TLB.** It's direct-mapped per vCPU with separate read and write entries. The fast path adds the host offset (QEMU-style addend) and takes about 6–8 wasm instructions. MMIO and unmapped pages take the slow path.
- **Faults from JIT code.** A helper records the exception and returns a status. The generated code stores the statically known PC and returns to the dispatcher. No wasm exception handling.
- **Code invalidation driven by `IC IVAU`/`IC IALLU`**, with `CTR_EL0.DIC=0` advertised so guests issue those instructions. A debug-only "stale translation checker" hashes guest code at block entry during tests.
- **Interrupt and exit checks** read an atomic flag on every region exit and loop back-edge. The atomic also stops V8 from hoisting guest spin-loop loads out of the loop.
- **Timers have two modes.** *Deterministic* mode derives virtual time from the instruction count, for tests, benchmarks and reproducible bugs. *Realtime* mode uses `performance.now()`.
- **SMP readiness from day one.** No mutable globals in core: all vCPU state sits behind a per-vCPU pointer. Exclusives and LSE atomics use wasm atomics even in single-core builds. `TLBI …IS` and `IC IVAU` are broadcast operations on ARM, so the design must allow another vCPU to raise a request that a `DSB` waits on.

### Host ABI for a whole VM (ABI 5, approved in M3)

Devices M3 has (GICv2 distributor and CPU interface, generic timer, PL011) live in the Rust core, so native and wasm share them and M3 needs no device-access exits. An access to an unmapped PA stays an external abort. The EL0 exports (`vcpu_new`, `mem_new`, `interp_run*`) stay for the corpus and benchmarks.

- `vm_new(ram: *mut u8, ram_size: u64, cfg: *const VmConfig) -> *mut Vm`. RAM is placed by the host after the core's heap (layout A) and appears at guest PA `0x4000_0000`. `VmConfig` (`repr(C)`, new fields at the end): RAM size, deterministic flag, `CNTFRQ` (default 62.5 MHz, QEMU's), timer ticks per retired instruction (default 1). `vm_free(vm)`.
- `vm_cpu(vm) -> *mut Cpu`: registers at the existing offsets (PC at 256, …).
- `vm_boot(vm, kernel_pa, initrd_pa, initrd_len, cmdline_ptr, cmdline_len)` (M3 step 5): the host copies the Image and initrd into RAM; the core writes the DTB and sets x0 = DTB, PC = entry, per booting.rst.
- `vm_run(vm, budget: u64) -> u32` exit kind; details in `vm_exit(vm) -> *const ExitInfo` = {kind, instructions retired, value, x0–x3}. Kinds: 0 budget used up; 1 PSCI call for the host (SYSTEM_OFF, SYSTEM_RESET, later CPU_ON; PC already past the HVC, the host writes x0 if it resumes); 2 idle (WFI with nothing pending; realtime mode only, `value` = deadline; deterministic mode instead jumps virtual time to the next timer deadline); 3 console TX ring full (drain, resume); 4 unimplemented instruction (`value` = Op index); 5 stop requested.
- PSCI in the core: VERSION (1.0), FEATURES, AFFINITY_INFO, MIGRATE_INFO_TYPE, and NOT_SUPPORTED for the rest.
- Console: two SPSC byte rings (TX, RX, 4 KiB each, atomic head/tail) at `vm_console(vm) -> *const Rings`. The PL011 writes TX; the host drains it after each `vm_run`, fills RX from any thread, then sets the signal word.
- Signal word `vm_signal(vm) -> *const AtomicU32`: bit 0 stop request, bit 1 RX data. The core checks it every 1024 instructions and on WFI (the interpreter's form of the §2 exit-check flag).
- Counters `vm_counters(vm) -> *const Counters`: a `repr(C)` block of u64s written with relaxed atomic stores and read with `Atomics.load`: instructions retired, exceptions by EC (64), IRQs, TLB hits/misses/walks/flushes, and the current PC for the sampling profiler. The layout is fixed in step 4 and filled in step 8 (TLB hit counting gets measured before it's turned on).
- Deferred: realtime mode (`performance.now()`, the idle exit waiting on `Atomics.wait`) and SMP (`CPU_ON`, M7).

### FP semantics (a known hard spot)

- Wasm arithmetic is round-to-nearest-even only. Other `FPCR.RMode` settings and `FZ` go through a software slow path: `core/src/fp.rs`, our own implementation written from the ARM pseudocode (FPRound with tininess before rounding, FZ, DN, the ARM NaN order) over one generic u128 unpack/round/pack for half, single and double. It was chosen over porting SoftFloat in M2, being smaller and ARM-specific; TestFloat 3e validates it. Single and double add/sub/mul/div/sqrt take host arithmetic in round-to-nearest-even when inputs are normal and the result is normal above the smallest binade, with the Inexact flag computed exactly.
- Wasm NaN payloads are nondeterministic. After each FP op, a rarely taken branch fixes up NaNs to ARM propagation rules (or to the default NaN when `FPCR.DN=1`).
- Core wasm has no scalar FMA. `FMADD` and friends use the exact software FMA in `fp.rs`, validated against TestFloat.
- Cumulative exception flags in `FPSR` are computed lazily or on demand.

## 3. Repository layout

```
core/      Rust crate: cpu (decode, interp), mmu, jit, platform (gic, timer, pl011, psci, virtio transport), fdt
web/       TypeScript: workers, backends, UI shell
tests/     difftest harness, golden corpus, boot tests, Playwright e2e
bench/     guest workloads, harness, results schema
images/    Buildroot configs + scripts to build test/bench kernels and rootfs (in rootless Podman; outputs in target/images/)
tools/     dev server (serve.ts), trace/disasm utilities (the decoder is generated by core/build.rs from core/src/a64/a64.inc)
scripts/   ci.sh, build-wasm.sh; the entry points CI and humans both use
```

## 4. Testing strategy (starts in M0)

Testing is layered. The cheaper layers run on every commit.

1. **Native unit tests** (`cargo test`) cover the decoder, ALU and flag semantics, bitfield/shift/extend helpers, the MMU walker, the GIC state machine and the virtqueue parser.
2. **Instruction differential testing against real hardware (golden corpus).**
   - Generate random or structured instruction sequences plus initial register/memory state, risu-style.
   - A tiny static harness loads the state, executes and dumps the state. It runs on two oracles:
     - **QEMU user mode** (`qemu-aarch64`, via binfmt on any x86_64 dev machine): always available and used for day-to-day corpus growth. QEMU's A64 is itself validated against hardware with risu, but it can still be wrong.
     - **Real hardware:** the M4 Mac mini (`macmini.lan`, macOS 26), in a Linux VM. EL0 code runs natively there. This is the authoritative oracle. The corpus is re-validated on it periodically and whenever QEMU and our emulator disagree.
       - The VM is **Lima** (`vz` backend, Virtualization.framework, plain mode) instance `oracle`: Debian 13 arm64, 4 vCPU, 8 GiB, 60 GiB disk, 4K pages. It was created with `limactl create --name=oracle --vm-type=vz --cpus=4 --memory=8 --disk=60 --plain template:debian-13`. Reach it with `ssh macmini.lan /opt/homebrew/bin/limactl shell oracle <cmd>` (Homebrew isn't on the non-interactive ssh `PATH`).
       - Apple's hypervisor filters the ID registers, so the guest sees v8.x/v9 features that PLAN §1 leaves out: `paca pacg bti` plus `sb flagm2 frint i8mm bf16 afp dit`, and no SVE or SME. PAC hint-space instructions (e.g. `PACIASP`) really sign pointers there, while our emulator treats them as NOPs. The corpus generator must exclude them, or the comparator must skip the registers they affect.
     - Homebrew `qemu` (11.1) on the same Mac provides `qemu-system-aarch64 -accel hvf` for the system-level oracle (item 3).
   - The results are committed as golden files. Every CI run compares the interpreter (native build) and the JIT (in Node/V8) against that corpus. The oracles are only needed again when the corpus grows, so the Mac doesn't need to be always-on.
   - The generator must avoid CONSTRAINED UNPREDICTABLE and IMPLEMENTATION DEFINED cases (for example `LDP` with `Rt==Rt2`, or writeback with `Rn==Rt`). Otherwise the oracles legitimately disagree.
   - **Corpus format (M1, `webpc-corpus 1`):** `tests/corpus/<group>.txt`, line-oriented text. Each test has `code`, a `seed` (splitmix64 expands to X0–X30, SP, NZCV, then the 8 KiB data region, then V0–V31 as low/high u64 pairs; FPCR and FPSR start at 0), `in` overrides, then the oracle's `out` (changed registers), `mem` (changed bytes) and `exit` (`end`, or `sigill`/`sigbus`/`sigsegv`/`sigtrap` with PC offset, `si_code` and fault address). A `note qemu: …` line records a QEMU result that differs from the M4's. New keys are additive (M2 added `v0=0x<32 hex digits>`, `fpcr=` and `fpsr=`); anything else bumps the version. Fixed guest VAs: code at `0x100000` followed by a `brk #0` end marker, data at `0x200000`, harness at `0x400000`.
   - **Tooling:** `tests/harness/harness.c` (static, freestanding, general registers only in C; state loaded by an asm trampoline, including FPCR, FPSR and V0–V31, and dumped from the signal `ucontext` and its `fpsimd_context` record on an alternate stack), `tools/corpus/gen.ts` (deterministic generator), `tools/corpus/run.ts` (runs QEMU and the M4, writes the golden files; `node tools/corpus/run.ts [--oracle qemu|m4|both] [group…]`), and `core/tests/corpus.rs` (the comparator in `cargo test`).
   - **Known oracle behavior** (M1 findings; the generator avoids these):
     - Both oracles implement FEAT_LSE2: misaligned exclusives, `LDAR`/`STLR` and LSE atomics only fault when they cross a 16-byte granule. We don't advertise LSE2 and keep the v8.0 rule (natural alignment or an alignment fault). Wasm atomics need natural alignment anyway, so the check costs nothing extra.
     - QEMU's `max` CPU has MTE (`ADDG`/`SUBG`, `STGP` execute), while the M4 raises SIGILL, as we do. QEMU's `DC ZVA` block is 512 bytes; the M4's is 64, as is ours.
     - The M4 guest also advertises `lrcpc ilrcpc dcpop dcpodp flagm uscat sha3 sha512 asimddp asimdrdm fphp jscvt fcma`, so the generator must not emit those instructions either.
     - M2: beyond v8.0 FP/AdvSIMD the M4 runs FP16 (including FP16 FMOV and the fixed-point conversions with immh = 001x), BF16 (BFCVT is the FCVT encoding with ftype 01, opc 10), FHM, RDM, DotProd, I8MM, FCMA, JSCVT and FRINTTS, plus AES/PMULL/SHA1/SHA2 (M6.5). The generator emits none of them. QEMU agreed with the M4 on every M2 test.
3. **System-level oracles**, for things that can't run at EL0 on real hardware:
   - `qemu-system-aarch64 -M virt` for behavioral comparison (traces of exceptions and system register state).
   - The same QEMU with `-accel hvf` on the Mac: real Apple hardware running EL1 code (MMU, exceptions). The devices are still QEMU's.
   - The Sail ARM model as the authoritative reference for disputed corner cases.
4. **JIT vs interpreter lockstep.** Run the same guest in both and compare architectural state at region boundaries. A "JIT stress" mode sets the compile threshold to 0 and uses a tiny code cache so eviction and invalidation are exercised constantly.
5. **FP conformance.** TestFloat vectors for every FP op, rounding mode, FZ/DN combination and FMA. `scripts/testfloat.sh` (part of `scripts/ci.sh`) builds TestFloat 3e under `target/testfloat` and runs `core/tests/testfloat.rs`, which checks every case under all four FZ/DN combinations. The golden corpus also runs on the wasm core in Node (`tests/corpus-wasm.test.ts`), because host float behavior is where native and wasm builds can diverge.
6. **Bare-metal system tests.**
   - Small EL1 assembly/C tests report results through PSCI `SYSTEM_OFF` with a code.
   - Run **kvm-unit-tests** (arm64: selftest, psci, gic, timer, mmu-related) unmodified as guests.
   - **Harness (M3):** `tests/baremetal/`: `start.S` (stack, vectors that call `on_exception(frame, vector)`, FP on, `run_el0()` to drop to EL0 and come back through SVC #1) plus one C file per test, built with host clang and lld by `build.sh` into committed flat `.bin`s loaded at `0x4000_0000`. A test passes when it calls PSCI `SYSTEM_OFF` with x1 = 0 (our own convention); x1 is otherwise the number of the failed check. `core/tests/baremetal.rs` runs them all in `cargo test`. `oracle.sh` runs the `-DORACLE` builds (implementation-specific checks such as ID register values left out) on `qemu-system-aarch64 -M virt` TCG, reading x1 from QEMU's CPU log. Tests must not rely on reset values of registers the architecture leaves UNKNOWN or IMPLEMENTATION DEFINED, and must pick unmapped addresses that are also unmapped on `virt` (its flash covers `0x0`–`0x0800_0000`).
7. **Boot tests.**
   - A deterministic Buildroot kernel + initramfs boots, runs a script, powers off, and its console output is asserted.
   - Later: Alpine and Debian arm64 from virtio-blk.
   - These run natively (headless runner around core) *and* in Chromium through Playwright.
8. **In-guest suites.**
   - Subsets of LTP, the kernel's arm64 selftests (fp, signal, abi), BusyBox tests and language test suites (Python).
   - Guest JITs (Node/V8, LuaJIT) exercise code invalidation.
9. **Memory model and SMP** (from M7): herdtools7 `litmus7` ARMv8 litmus tests run in the guest, with observed outcomes checked against the allowed set. Atomics stress tests too.
10. **Fuzzing.** `cargo-fuzz` on the decoder (never panics and matches the reference disassembler), the virtqueue/descriptor parsing and the DTB/boot loader inputs.
    - **Decoder (M1):** `core/fuzz`, a separate workspace so Capstone never reaches the core's builds. `cargo fuzz run decode` (from `core/`) runs libFuzzer. `cargo run --release --bin sweep` (from `core/fuzz/`) checks all 2³² words in about 2 minutes on 16 threads: every word executes on a scratch vCPU without panicking, and "valid instruction" agrees with Capstone 5.0. `core/fuzz/src/check.rs` lists the expected differences: features we leave out (SVE/SME, MTE, PAC outside the hint space, RCpc, LOR, MOPS, HBC, and since M2 FP16, BF16, FHM, RDM, DotProd, I8MM, FCMA, JSCVT, FRINTTS, SHA3/SHA512/SM3/SM4, and the v8.0 crypto until M6.5), CONSTRAINED UNPREDICTABLE encodings Capstone rejects, and should-be-one fields that the M4 ignores. Since M2 only EL1 system encodings are left out of the comparison as unimplemented; the full sweep was clean again on 2026-09-25. `core/build.rs` relaxes those fields to match the M4, except in CAS/CASP, where the M4 raises UNDEFINED. The fuzzer isn't part of `scripts/ci.sh` (it builds Capstone from C); rerun it when the decoder changes.

**CI:** everything lives in plain scripts (`cargo xtask` or shell) that run the same way locally and in CI. The CI config is a thin wrapper around them, so no particular CI host is required.
- Any x86_64 Linux machine: native tests, wasm build, Node JIT difftests, Playwright Chromium boot tests.
- The M4 Mac (ssh into the Linux VM, or a self-hosted runner for whatever forge you use): growing and re-validating the corpus, native arm64 benchmark baselines, and Chromium on macOS/arm64 benchmarks.

## 5. Performance monitoring and benchmarking (starts in M0)

### Built-in instrumentation

- Counters in shared memory, readable live by an overlay and dumped by the harness:
  - guest instructions retired, split into interpreter vs JIT;
  - regions compiled, compile time, wasm bytes, modules instantiated;
  - TLB hits and misses, page walks;
  - exceptions by class, IRQs;
  - helper calls by opcode (tells you what to inline next);
  - flag materializations, invalidations;
  - dispatcher round-trips vs chained transitions.
- **Guest PC sampling profiler.** Another thread samples the vCPU PC from shared memory, and the samples are symbolized with the guest `vmlinux`/binaries. This shows which *guest* code is slow under emulation.
- JIT modules carry a wasm **name section** naming functions after guest PCs, so DevTools and `perf` profiles are readable.
- `performance.mark`/`measure` around compile, instantiate, device I/O and boot phases, so they show up in DevTools and Perfetto traces.

### Benchmark harness

- A **bench image** (Buildroot) contains the prebuilt workloads and a `/bench/run.sh` that prints `BENCH <name> <value> <unit>` to the serial console. The same binaries also run natively and under QEMU.
- `bench/run.ts` works like this:
  1. Playwright launches a **pinned Chromium**.
  2. The page is served with COOP/COEP headers (needed from M7).
  3. The page boots the bench image in deterministic mode.
  4. The harness parses serial output and repeats N runs.
  5. Median and IQR go to JSON along with the counters and the browser/commit metadata.
- The same harness runs in Node for quick development iteration. **Chromium numbers are the ones that count.**
- Results are stored per commit, with trend charts added once there are enough data points. Shared or virtualized machines are noisy, so use them for trends and a dedicated quiet machine for regression gates (for example, fail on a >5% median regression on a key benchmark).
- Tiering matters: V8 runs new wasm under Liftoff and tiers up to TurboFan later. Always report cold and warm numbers, and compare runs with Liftoff or tier-up disabled through `--js-flags` to understand the effect.
- `perf` with V8's `--perf-prof` (via `--js-flags`) handles native-level profiling of JIT'd wasm on Linux.
- **Benchmark on two host architectures:** Chromium on x86_64 Linux and Chromium on macOS arm64 (the M4). V8 lowers wasm differently on each: register count (16 vs 31 GPRs matters for locals-heavy JIT code), bounds-check strategy and SIMD lowering. Results can diverge.

### Workloads and KPIs

| KPI | Workload |
|---|---|
| Boot time to shell | deterministic Buildroot kernel+initramfs; later Alpine/Debian |
| Integer throughput (guest MIPS) | CoreMark, Dhrystone |
| Mixed / realistic | `7z b`, SQLite `speedtest1`, compiling a C file with GCC in the guest (heavy code/JIT churn) |
| SIMD | `openssl speed` (NEON paths), glibc string/memcpy microbenchmarks |
| Kernel paths | lmbench `lat_syscall`, `lat_pagefault`, `lat_ctx` |
| JIT behaviour | compile latency p50/p99, % time interpreted, code bytes, invalidations |
| I/O | `dd`/`fio` on virtio-blk, 9p file ops, virtio-net throughput to a loopback backend |
| Startup | core instantiate time, time to first console output |

### Comparison targets

- **Native arm64** (M4 Linux VM). Gives the slowdown factor, the headline number.
- **QEMU TCG** (`qemu-system-aarch64 -M virt`, native, same kernel and image). The practical reference for "good" emulation speed.
- **In-browser peers** running the same workload built for their ISA, in the same Chromium:
  - v86 (i686);
  - TinyEMU/JSLinux (riscv64);
  - WebVM/CheerpX (proprietary, comparison only).

Targets are set after the M3/M5 baselines exist. A provisional ambition is CoreMark within ~2–3× of native QEMU TCG by the end of M6.

## 6. Reference projects

Licenses were verified in M0. Commits, caveats and details are in [`THIRD_PARTY.md`](THIRD_PARTY.md).

**Permissive licenses** (code can be ported or reused with attribution in `THIRD_PARTY.md`):

| Project | License | Use for |
|---|---|---|
| [v86](https://github.com/copy/v86) | BSD-2-Clause | JIT architecture (wasmgen, block compilation and batching), 9p server + lazy HTTP filesystem (`lib/9p.js`), state save/restore, async HTTP disk images |
| [TinyEMU](https://bellard.org/tinyemu/) | MIT | Compact virtio-mmio + virtio-blk/net/9p/console/input implementation in C. JSLinux is an in-browser comparison target |
| [dynarmic](https://github.com/lioncash/dynarmic) (archived) | 0BSD | A64 decoder pattern table (`frontend/A64/decoder/a64.inc`), IR design, A64 semantics, JIT techniques |
| [crosvm](https://chromium.googlesource.com/crosvm/crosvm) | BSD-3-Clause | virtio devices (blk, net, gpu, input, snd), `p9` crate, arm64 FDT generation, PSCI handling |
| [Firecracker](https://github.com/firecracker-microvm/firecracker) | Apache-2.0 | Minimal virtio-mmio device model, arm64 FDT, direct kernel boot |
| [rust-vmm](https://github.com/rust-vmm) (`vm-fdt`, `virtio-queue`, `virtio-bindings`) | Apache-2.0 / BSD-3-Clause (virtio-queue requires both) | Crates usable directly from core |
| [gem5](https://github.com/gem5/gem5) | BSD-3-Clause | GICv2/GICv3 and generic timer models |
| [Berkeley SoftFloat 3 / TestFloat 3](http://www.jhauser.us/arithmetic/) | BSD-3-Clause | FP conformance vectors (`scripts/testfloat.sh`). The FP slow path itself is our own (M2, §2) |
| [Capstone](https://github.com/capstone-engine/capstone) | BSD-3-Clause | Disassembly for traces and debugging, and cross-checking the decoder |
| [Sail ARM model](https://github.com/rems-project/sail-arm) | BSD-3-Clause-Clear | Executable ISA model derived from Arm's ASL. Oracle for corner cases |
| Arm A64 machine-readable spec (AARCHMRS JSON) | "BSD license" release, but it defers to an in-package notice: read that before use | Decoder generation and encoding coverage checks |
| [Playwright](https://github.com/microsoft/playwright) | Apache-2.0 | Chromium automation for e2e tests and benchmarks |

**Copyleft or other** (used as oracles, run as guest workloads, or read for behavior only; never copy code):

| Project | License | Use for |
|---|---|---|
| QEMU | GPL-2.0 (parts LGPL-2.1) | `qemu-aarch64` / `qemu-system-aarch64 -M virt` as oracle and comparison target; `hw/arm/virt.c` as the de facto platform reference |
| Unicorn | GPL-2.0 | Optional in-process oracle for fuzzing (test tooling only, not distributed) |
| Linux kernel | GPL-2.0 | `Documentation/arch/arm64/booting.rst`, the DT bindings, and the drivers as the "spec" your devices must satisfy |
| kvm-unit-tests | GPL-2.0 | Guest-run system tests |
| LTP, kernel selftests | GPL-2.0 | In-guest test suites |
| herdtools7 (`litmus7`) | CeCILL-B (`asllib/` BSD-3-Clause) | Memory-model litmus tests |
| Linaro risu | EPL-1.0 | Random-instruction test methodology, the model for the golden-corpus generator |
| Buildroot | GPL-2.0 | Building test and bench images |

Guest images you distribute (kernel, BusyBox, and so on) carry their own GPL obligations: publish the Buildroot configs and point to the sources. That's separate from the emulator's MIT license.

## 7. Milestones

Every milestone ends with: all test layers green, a recorded benchmark baseline in Chromium, and the counters reviewed.

### M0 — Foundations and feasibility spike
**Status:** done 2026-09-25 (see `bench/spike/REPORT.md`). The M4 Mac Linux VM is up (§4.2). Still pending: a spike re-run on Chromium arm64 (tracked in M9).

- Repo, license, `THIRD_PARTY.md`, Rust core building to both native and wasm (pinned nightly toolchain), TS host skeleton, script-based CI, Linux VM on the M4 Mac with remote access.
- Playwright harness serving with COOP/COEP headers, results JSON schema, Node variant.
- **Spike: micro-benchmarks in Chromium** that fix the JIT design numbers:
  - generate + compile + instantiate latency vs module size, synchronous `new WebAssembly.Module` in a worker vs async;
  - call cost from a JIT module into core helpers (imported functions);
  - `call_indirect`/table dispatch cost;
  - inline TLB fast-path cost;
  - shared vs non-shared memory access cost;
  - Liftoff vs TurboFan behavior on generated code;
  - wasm SIMD128 availability and cost.
- License verification of every §6 source (done; see `THIRD_PARTY.md`).
- **Exit:** CI green. Spike report written into `bench/` with numbers.

### M0.5 — Memory architecture experiment (decision gate)
**Status:** done 2026-09-25 on x86_64 and arm64 (M4, macOS; machine code from the arm64 Linux VM). See `bench/spike/memory/REPORT.md` §5. **Decision: A, on both hosts.**

This decision shapes the TLB entry format, the core's memory layout and the Rust target, so it's made before M1 writes any of them.
Code lives in `bench/spike/memory/`, and results plus the written decision go in `bench/spike/memory/REPORT.md`.

**Candidates:**

| | Layout | Rust core target |
|---|---|---|
| A | One wasm32 memory: core state + guest RAM (≤ ~3.5 GiB) | wasm32 |
| B | wasm32 core memory + N wasm32 RAM memories (multi-memory, ≤ 4 GiB each). The TLB entry carries a memory index | wasm32 |
| C | One memory64: core + RAM | wasm64 (tier 3, needs build-std, which threads already need) |
| D | wasm32 core memory + one memory64 RAM memory (multi-memory mixing index types). Generated code uses i64 addresses on the RAM memory | wasm32 |

**Capacity experiments.** Run on each host: x86_64 Linux and the M4 Mac, both in Chromium; Firefox as secondary data. Scale sizes to host RAM.
- Maximum size per memory, for wasm32 and memory64, shared and non-shared, and maximum declarable `maximum`.
- Maximum total across many memories in one page, including memories created in dedicated workers. Workers live in the same renderer process, and a `SharedArrayBuffer` can only be shared within one process, so one VM's RAM can't be spread across processes.
- Whether large allocations are lazily committed: reserved vs resident memory after touching only part of the RAM. Also how many large reservations fit in V8's address space.
- How failure shows up: a catchable `RangeError` on allocate/grow, or a tab crash ("Aw, Snap!") when the pages are touched.
- Whether shared memory64 and atomics on non-zero memories are supported.

**Cost experiments.** Kernels shaped like the planned JIT output: inline TLB lookup + load/store, mixed with ALU ops at a realistic ratio (about 1 memory op per 3 instructions). Access patterns: sequential, random (pointer chase), and many pages spread over large RAM. Run under Liftoff and TurboFan, on both hosts.
- A vs C vs D: what the bounds checks cost for memory64.
- B: memory 0 vs memory N used alone, to see whether V8 gives non-zero memories guard pages or explicit checks (**asymmetric** cost). Then the memory-select strategies:
  1. an `if`/`br_table` on the TLB memory index;
  2. a guarded specialization on the memory seen at compile time, with a slow-path exit when it differs;
  3. a helper call.
  Each is measured with a predictable and with an alternating memory index.
- Access from the Rust side (interpreter, virtio DMA). Rust can't address non-zero memories directly, so this means calls into a small hand-written accessor module.
- **Check the machine code, not just the timings.** Use `perf annotate` on V8's `--perf-prof` jitdump output, or a d8 build with the disassembler, to confirm what bounds checks and memory-base loads each engine actually emits.

**NUMA follow-up** (only if B shows asymmetric cost):
- Describe each RAM memory as a NUMA node in the DTB: `numa-node-id` on the memory nodes, plus a `distance-map`.
- vCPUs belong to node 0 and the extra memories are CPU-less nodes. Linux then allocates from the fast memory first and spills over by distance.
- Validated in M3 once Linux boots. It only changes DTB contents, so nothing in this decision depends on it.
- To check then: whether distro arm64 kernels enable `CONFIG_NUMA`, and whether memory tiering/demotion applies to DT-described CPU-less nodes. Disable NUMA balancing: its hinting faults would be expensive under emulation.

**Decision rule** (the threshold can be adjusted):
- Measure the realistic mixed kernel, not the bare access path.
- If a >4 GiB-capable layout (B, C or D) costs **≤ 5%** vs A, adopt it, even if today's browsers can't back more than 4 GiB.
- Otherwise adopt A and record the measured gap, so the decision can be revisited as engines improve. The single lowering point keeps a later switch contained to the emitter and the core allocator.

- **Exit:** `REPORT.md` with capacity tables, cost tables, machine-code evidence and the decision. The §1 "Guest memory" row is updated.

### M1 — A64 integer interpreter + golden corpus
**Status:** done 2026-09-25. The decoder is generated from dynarmic's table; 13,940 golden tests with M4 results all pass; the exhaustive 2³² decoder sweep against Capstone is clean. Warm interpreter speed is 91 MIPS (x86_64, Chromium 152) and 149 MIPS (M4, Chromium 153), see `bench/interp/REPORT.md`.

- Decoder generated from a pattern table (port dynarmic's `a64.inc` or generate from Arm's spec).
- Interpreter for data processing, branches, loads/stores (all addressing modes), exclusives, LSE, on flat memory.
- Golden-corpus generator, oracle harness (qemu-aarch64 + M4 hardware), comparator. Decoder fuzzing against Capstone.
- **Exit:** integer golden corpus passes, and interpreter MIPS in Chromium is recorded.

### M2 — FP and AdvSIMD in the interpreter
**Status:** done 2026-09-25. All v8.0 FP/AdvSIMD, including every FP/SIMD load and store; FPCR RMode/FZ/DN/AHP and FPSR flags and QC. `core/src/fp.rs` (own software FP from the ARM pseudocode, RNE fast paths) passes 51.2M TestFloat 3e cases under every FZ/DN combination. 31,850 new golden tests (45,790 in all) pass natively and on the wasm core in Node, with M4 results and no QEMU disagreements. The decoder sweep is clean again. Interpreter speed: 95 MIPS integer / 15 MIPS FP/NEON (x86_64, Chromium 152), 152 / 23 MIPS (M4, Chromium 153); see `bench/interp/REPORT.md`.

- Scalar FP, NEON integer and FP, FPCR/FPSR semantics, a software slow path (our own; see §2), software FMA.
- **Exit:** TestFloat and the FP/NEON golden corpus pass.

### M3 — System level, Linux boots (interpreter only)
- EL0/EL1, the exception model, system registers (ID registers advertising exactly what's implemented), MMU walker + software TLB, TLBI, generic timer, GICv2, PL011, PSCI, DTB generation, `Image` boot protocol.
- kvm-unit-tests. Deterministic mode.
- **Platform map and DTB:** the guest physical addresses follow QEMU `virt` (GICv2 at `0x0800_0000`/`0x0801_0000`, PL011 at `0x0900_0000`, RAM from `0x4000_0000`), so kvm-unit-tests runs with its defaults and traces line up with the QEMU oracles. The DTB comes from our own small FDT writer in `core/`, not `vm-fdt`.
- **Guest images** (decided before M3 started):
  - They build in a rootless Podman container, never on the host. `images/Containerfile` is Debian 13, pinned by digest, with apt on a `snapshot.debian.org` date. `images/build.sh` runs it with `--userns=keep-id` and writes to `target/images/<name>/`. The Mac builds nothing and gets artifacts by `scp`.
  - Buildroot 2026.08 (pinned tag) with Bootlin's prebuilt aarch64 glibc toolchain and `BR2_REPRODUCIBLE`. Linux 6.18 LTS, configured as `allnoconfig` plus a committed fragment for our platform only. The initramfs is BusyBox with an `/init` that runs a script and powers off. A distro-like defconfig image waits for M4.
  - kvm-unit-tests: a pinned commit, built in the same container with Debian's `gcc-aarch64-linux-gnu`.
  - `images/` commits the configs, scripts and `SHA256SUMS`, never binaries. `scripts/ci.sh` runs the image tests when `target/images/` exists and prints a loud skip otherwise.
- Carry-overs from M1: SP alignment checking (`SCTLR_EL1.SA0`, which Linux sets; the M1 corpus keeps SP 16-byte aligned), `DCZID_EL0.BS = 4` to match the 64-byte `DC ZVA`, faults for EL0 cache maintenance to unmapped addresses, and page-crossing accesses in `Mem::host`.
- Carry-overs from M2:
  - FP/AdvSIMD access traps from `CPACR_EL1.FPEN`. They apply to FP/SIMD loads and stores and to FPCR/FPSR accesses too.
  - The ID registers advertise exactly what M2 implements. `ID_AA64PFR0_EL1.FP` and `.AdvSIMD` = 0 (present, no FP16). `ID_AA64ISAR0/1_EL1` report no AES/PMULL/SHA (until M6.5), RDM, DotProd, FHM, FCMA, JSCVT, FRINTTS, BF16 or I8MM. `ID_AA64MMFR*`/`ISAR*` fields report no AFP. The hwcaps follow from these.
  - EL0-accessible system registers: `TPIDR_EL0`, `TPIDRRO_EL0`, `CTR_EL0` (`DIC=0`, §2), `DCZID_EL0`, `CNTVCT_EL0`, `CNTFRQ_EL0`. Linux emulates EL0 reads of ID registers.
  - Once the MRS/MSR/SYS space is implemented, it joins the decoder sweep comparison. `core/fuzz/src/check.rs` still skips it.
  - `interp_run_exit` reports only EL0-style exits. ABI 4 (M3 step 1) added trap-to-EL1 and HVC kinds and the EL1 state at the end of `Cpu`. The whole-VM ABI (ABI 5, approved in M3 before step 4) is in §2 "Host ABI for a whole VM".
- **Progress:**
  - Step 1 (EL1 state and exception model) done: PSTATE EL/SPSel/DAIF with banked SP, exception entry and ERET (illegal returns take the Illegal Execution State exception), EL0→EL1 traps (`SCTLR_EL1` UCT/UMA/DZE/UCI/nTWI/nTWE, `CPACR_EL1.FPEN`), and the system register table in `core/src/interp/sys.rs`. `interp::run` still hands exceptions to the host (corpus, benchmarks); `interp::run_system` takes them into EL1 and exits only for HVC and unimplemented instructions. `Cpu::default()` is a Linux user process at EL0, `Cpu::reset()` the EL1 boot state. Still open from the step: no wasm export for EL1 reset or `run_system` yet (the ABI note above), and TCR/TTBR/MAIR/PAR are plain storage until step 3 interprets them. Step 3 must also cover the M1 carry-over of EL0 cache maintenance (`DC CVAC/CVAU/CIVAC`, `IC IVAU`) faulting on unmapped addresses.
  - Step 2 (bare-metal harness) done: `tests/baremetal/` (§4 item 6), with `exceptions.c` passing natively and on QEMU TCG. `Mem` places RAM at a guest physical base (`Mem::at`), `0x4000_0000` for VMs. The hvf oracle can't report x1 (no TCG log); it waits for the PL011 in step 4, when tests can print their result.
  - Step 3 (MMU) done: `core/src/mmu.rs`. The 4K-granule stage 1 walker (TTBR0/TTBR1 with T0SZ/T1SZ 16–39, TBI, EPD, IPS capped at the 40-bit PARange, APTable/UXNTable/PXNTable, WXN, the implicit PXN on EL0-writable pages, software-managed AF), AT S1E{0,1}{R,W} into `PAR_EL1`, and TLBI (VMALLE1, ASIDE1, VAE1, VAAE1, VALE1, VAALE1, and IS). The TLB is the M0 spike's shape: direct-mapped, 4096 × {tag, addend} per (EL, read/write/execute), the tag being the page VA with bits 11:0 all ones (bits 11:3 the inverted memory index), compared with `(va + size - 1) | 0xfff` so page-crossing accesses miss and are split. It holds no ASIDs and is flushed when the effective ASID or `SCTLR_EL1.M` changes. Faults carry kind, level and access (ESR WnR, CM). `SCTLR_EL1.A` alignment faults, SP alignment faults (`SA`/`SA0`, EC 0x26), and cache maintenance by VA translates and faults like a read (`DC IVAC` like a write). `tests/baremetal/mmu.c` passes natively and on QEMU TCG. Interpreter MIPS with the MMU off: −7% integer on x86_64, −4% on the M4, FP unchanged within noise (`bench/interp/REPORT.md`, M3), after splitting the interpreter into a flat and an MMU copy chosen outside the instruction loop.
  - Oracle disagreement: **QEMU TCG raises no SP alignment faults** (`SCTLR_EL1.SA` set, misaligned SP as a base). We follow the architecture; `mmu.c` leaves that check out of its ORACLE build. Re-check on hvf once tests can print (step 4).
  - ID registers: `MIDR_EL1` implementer 0 (software use); `ID_AA64PFR0_EL1` sets **CSV2 and CSV3** (nothing speculates, and it spares the guest Spectre mitigations and KPTI); 4K granule, 16-bit ASIDs, 40-bit PA; LSE and CRC32 only in ISAR0; `CTR_EL0` IDC=1, DIC=0; `CLIDR_EL1` = 0 (no caches, so set/way ops are NOPs). Trapped FP and WFx ISS use CV=1, COND=AL, as QEMU does.
- **Exit:** Buildroot kernel boots to a shell in native and Chromium test runners. First **boot-time baseline** and PC-sampling profile.

### M4 — virtio devices and real distros
- virtio-mmio v2 transport and split virtqueues. Devices, in order:
  1. console, rng, blk: HTTP range-request read-only backend, then a writable overlay on OPFS;
  2. net: a pluggable backend interface, a loopback test backend first, your WebRTC network later;
  3. 9p: port or adapt v86;
  4. input;
  5. display: `simple-framebuffer` DT node → canvas first, virtio-gpu 2D later.
- **Exit:** Alpine and Debian arm64 boot from virtio-blk, LTP subset and selftests run, I/O benchmarks recorded.

### M5 — JIT tier 1
- TLB entry layout experiments the M0 spike suggested and M3 didn't test (they only matter for inlined JIT code): an i32 addend (layout A host addresses are 32-bit), and split tag and addend arrays for density. The interpreter's TLB (`core/src/mmu.rs`) is the spike's measured 16-byte {tag, addend} shape.
- Region formation from hot blocks, wasm emitter (own minimal encoder), gadget-style helpers plus inlined simple ops, lazy flags, inline TLB, block chaining inside a module, batched module compilation, dispatcher, exits and faults, IC-driven invalidation.
- Lockstep and JIT-stress test modes. The golden corpus also runs through the JIT.
- **Exit:** all suites pass under JIT and JIT-stress, and the CoreMark / boot-time speedup over the interpreter is recorded.

### M6 — JIT optimization
- Driven by the counters and profiles:
  - multi-block regions with real loops;
  - register allocation into locals across blocks;
  - wider inlining (guided by the helper-call histogram);
  - NEON → SIMD128 lowering;
  - tuning compile thresholds and batch sizes for V8 tiering.
- **Exit:** meets the targets set after M5, and the comparison table against QEMU TCG, native and in-browser peers is published.

### M6.5 — Crypto extensions
- AES (`AESE`/`AESD`/`AESMC`/`AESIMC`), `PMULL`/`PMULL2` (including the 64-bit form), SHA1 and SHA256, in the interpreter and the JIT. Advertise them in `ID_AA64ISAR0_EL1` and the hwcaps only once both tiers pass.
- They come after the JIT so the lowering can be designed with it (wasm SIMD128 has no AES or carry-less multiply, so they're helper calls or table-based), and before SMP so they're settled before the concurrency work.
- **Exit:** golden-corpus coverage on the M4, NIST/known-answer vectors, and `openssl speed` (AES-GCM, SHA-256) recorded in Chromium against the NEON-only baseline.

### M7 — SMP
- One worker per vCPU on shared memory. PSCI `CPU_ON`, GIC SGIs, WFI → `Atomics.wait`, broadcast TLBI/IC with `DSB` completion, per-worker code caches with cross-vCPU invalidation.
- litmus7 suites and atomics stress. Scaling benchmarks (parallel `make`, `7z b -mmt`).
- **Revisit 128-bit atomics.** Wasm has no 128-bit compare-and-swap, so since M1 `CASP` and 64-bit-pair `LDXP`/`STXP` run under one spinlock in `Mem` (`core/src/mem.rs`, `pair_locked`). The lock only excludes other pair operations: a concurrent 64-bit atomic or plain store from another vCPU to the same bytes can interleave with a locked pair op, which breaks single-copy atomicity. Options: make every atomic that can overlap a pair take the lock (hashed per-line locks to limit contention), or stop the world for pair ops. Decide with litmus tests and a CASP-heavy stress test (e.g. lock-free 128-bit queues).
- **Exclusives are compare-and-swap based:** `STXR` succeeds if memory still holds the value `LDXR` saw (ABA-tolerant, like QEMU). Check that litmus7 and the atomics stress tests accept this.
- **Exit:** a multi-core Debian boot is stable under stress, and the scaling curve is recorded.

### M8 — Product integration
- Snapshots (save/restore CPU + devices + compressed RAM) for instant "boot".
- Stable embedding API (VM config → DTB/devices), networking backend API for your P2P network, persistence UX, docs.
- Firefox and Safari compatibility pass (Chromium remains the performance target).

### M9 — Loose ends (unscheduled)
Open items that no milestone owns yet. Pick them up when a milestone touches the area or a measurement says they matter; move an item into that milestone when it's scheduled.

- **M0 spike re-run on Chromium arm64** (the M4), to confirm the JIT design numbers in `bench/spike/REPORT.md` on the second host.
- **Interpreter speed** (`bench/interp/REPORT.md`). There's no decoded-block cache yet: each instruction is fetched through `Mem::host` and decoded again (`ponytail:` in `interp::step`). FP runs at about a sixth of the integer rate. `FMLA`/`FMADD` always take the exact software FMA, and vector FP goes lane by lane through an `Fpu` context and `u128` lanes. None of this matters while the interpreter is only the JIT's reference and fallback.
- **V8 tiering on FP-heavy code.** On the FP/NEON guest, TurboFan-only beats the default tiering by 21% (x86_64) and 32% (M4); the integer guest shows the opposite. Understand it before the core's FP helpers become JIT slow paths (M5).
- **`Mem::rmw`** is a generic CAS loop (`ponytail:` in `core/src/mem.rs`). Map add/and/or/xor/xchg to single wasm `atomic.rmw` ops if a profile shows LSE atomics.
- **Extensions the M4 has and we leave unadvertised**, in case real workloads benefit: FP16 (scalar and AdvSIMD), DotProd, RDM, FHM, FCMA, JSCVT (JS engines use `FJCVTZS`), FRINTTS, BF16, I8MM, LSE2, RCpc, FlagM, SB, DIT. Each needs the handlers, golden-corpus groups (the generator already knows how to avoid them), the ID register fields and a decoder-sweep update.
- **Arm AARCHMRS JSON:** its in-package proprietary notice is still unread (`THIRD_PARTY.md`). Read it only if we want to generate decoder tables or coverage checks from it.
- **Corpus depth:** some FP flag paths are thin (only 8 `fp_scalar` tests raise Divide-by-Zero). Add biased forms when touching FP again.
- **MMU loose ends (M3 step 3):**
  - The TLB holds no ASIDs, so every ASID change flushes it, global kernel entries included. Tag entries with the ASID (and keep nG) if the TLB counters (step 8) show refills after context switches matter.
  - No Device-memory alignment faults (misaligned accesses to Device memory, or with the MMU off) and no address size fault for VAs past 40 bits with the MMU off (they fault as external aborts).
  - PRFM with a misaligned SP as its base takes an SP alignment fault, where hardware wouldn't.
  - Interpreter speed with the MMU on isn't measured yet: it needs the whole-VM export.
- **Self-hosted debug:** `ID_AA64DFR0_EL1` advertises the architectural minimum (v8.0 debug, 2 breakpoints, 2 watchpoints, 1 context comparator). ARMv8.0 doesn't allow advertising less, so this is the one deliberate exception to "ID registers advertise exactly what's implemented". The breakpoint and watchpoint registers are RAZ/WI, the OS lock is only state, and no debug exceptions are raised (breakpoints, watchpoints, `MDSCR_EL1.SS` single step). Needed for in-guest `gdb` hardware breakpoints and `ptrace` single step.
- **`core/fuzz` hygiene:** `Mismatch::key` is dead code in the libFuzzer target build (a warning, not in CI).

## 8. Risks to watch

- **Wasm module compile/instantiate latency** dominating JIT benefit. The M0 spike quantifies this; batching and tiering thresholds mitigate it.
- **FP exactness** (FMA, NaN payloads, rounding modes) costing more than expected. It's contained to the slow paths, and TestFloat catches regressions.
- **Broadcast TLBI/IC + `DSB` synchronization** across workers under SMP. This is a known ARM cost that shapes the M7 design.
- **Rust + wasm threads** needs nightly with `-Z build-std`, with atomics enabled via `-Zllvm-target-feature=+atomics` (`-Ctarget-feature=+atomics` is being phased out, rust-lang/rust#162235). The toolchain is pinned in `rust-toolchain.toml`.
- **Guest RAM ceiling / memory layout.** Settled in M0.5: layout A, so guest RAM ≤ ~3.5 GiB. The measured gaps to B/C/D are recorded in `bench/spike/memory/REPORT.md`; re-measure them on new Chromium releases. Past 3.5 GiB the path is spill memories as NUMA nodes (the M0.5 NUMA follow-up). Chromium gives no catchable error when host RAM runs out: the renderer is OOM-killed, so guest RAM must be sized against host RAM up front.
- **Cross-origin isolation** (COOP/COEP) is required for `SharedArrayBuffer`. It constrains embedding and third-party resources.
