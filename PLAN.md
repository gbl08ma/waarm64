# webpc — implementation plan

A whole-system AArch64 emulator for the browser. Guest code is JIT-compiled to
WebAssembly. It runs unmodified arm64 Linux distributions. Chromium is the
primary target.

## 1. Locked-in decisions

| Area | Decision |
|---|---|
| Guest ISA | ARMv8.0-A AArch64 with FP and AdvSIMD (NEON), no AArch32. LSE atomics (v8.1) added early. No SVE/SME, PAC, BTI or MTE: leave them unadvertised, and their hint-space encodings run as NOPs |
| Privilege | EL0 and EL1 only. No EL2/EL3 and no secure state |
| MMU | Stage 1 only, 4K granule, 48-bit VA, TTBR0/TTBR1, ASIDs, software-managed access flag |
| Platform | GICv2 (a GICv3 subset later), generic timer, PL011 UART, PSCI over HVC handled by the host, virtio-mmio v2, and a DTB generated from the VM config |
| Boot | Direct kernel boot (arm64 `Image` + initrd + DTB). No UEFI. For distro disk images, the kernel and initrd are extracted and booted directly |
| Core language | Rust compiled to `wasm32` (the same crate also builds natively for tests). Host glue is in TypeScript |
| Guest memory | **Layout A (decided in M0.5, `bench/spike/memory/REPORT.md`):** one shared wasm32 memory: core state first, then guest RAM (≤ ~3.5 GiB, sized against host RAM at VM start). The Rust core targets wasm32. Every >4 GiB layout cost more than the 5% threshold on x86_64 Chromium: C (memory64) +6–20% in JIT code and +11% in the core, B +12–14%, D +19–28%. The guest physical address map is independent of placement, because the TLB translates. Every guest RAM access in generated code goes through one lowering function. TLB tag bits 3–11 are reserved for a memory index, so "A + spill memories" (extra wasm32 memories as NUMA nodes, same fast path as A for memory-0 pages) can be added later without changing A's code |
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

### FP semantics (a known hard spot)

- Wasm arithmetic is round-to-nearest-even only. Other `FPCR.RMode` settings and `FZ` go through a SoftFloat-based slow path.
- Wasm NaN payloads are nondeterministic. After each FP op, a rarely taken branch fixes up NaNs to ARM propagation rules (or to the default NaN when `FPCR.DN=1`).
- Core wasm has no scalar FMA. `FMADD` and friends need an exact software FMA. Validate it against TestFloat.
- Cumulative exception flags in `FPSR` are computed lazily or on demand.

## 3. Repository layout

```
core/      Rust crate: cpu (decode, interp), mmu, jit, platform (gic, timer, pl011, psci, virtio transport), fdt
web/       TypeScript: workers, backends, UI shell
tests/     difftest harness, golden corpus, boot tests, Playwright e2e
bench/     guest workloads, harness, results schema
images/    Buildroot configs + scripts to build test/bench kernels and rootfs
tools/     dev server (serve.ts), decoder-table generation, trace/disasm utilities
scripts/   ci.sh, build-wasm.sh; the entry points CI and humans both use
```

## 4. Testing strategy (starts in M0)

Testing is layered. The cheaper layers run on every commit.

1. **Native unit tests** (`cargo test`) cover the decoder, ALU and flag semantics, bitfield/shift/extend helpers, the MMU walker, the GIC state machine and the virtqueue parser.
2. **Instruction differential testing against real hardware (golden corpus).**
   - Generate random or structured instruction sequences plus initial register/memory state, risu-style.
   - A tiny static harness loads the state, executes and dumps the state. It runs on two oracles:
     - **QEMU user mode** (`qemu-aarch64`, via binfmt on any x86_64 dev machine): always available and used for day-to-day corpus growth. QEMU's A64 is itself validated against hardware with risu, but it can still be wrong.
     - **Real hardware:** the M4 Mac mini, in a Linux VM (Virtualization.framework / OrbStack / UTM). EL0 code runs natively there. This is the authoritative oracle. The corpus is re-validated on it periodically and whenever QEMU and our emulator disagree.
   - The results are committed as golden files. Every CI run compares the interpreter (native build) and the JIT (in Node/V8) against that corpus. The oracles are only needed again when the corpus grows, so the Mac doesn't need to be always-on.
   - The generator must avoid CONSTRAINED UNPREDICTABLE and IMPLEMENTATION DEFINED cases (for example `LDP` with `Rt==Rt2`, or writeback with `Rn==Rt`). Otherwise the oracles legitimately disagree.
3. **System-level oracles**, for things that can't run at EL0 on real hardware:
   - `qemu-system-aarch64 -M virt` for behavioral comparison (traces of exceptions and system register state).
   - The same QEMU with `-accel hvf` on the Mac: real Apple hardware running EL1 code (MMU, exceptions). The devices are still QEMU's.
   - The Sail ARM model as the authoritative reference for disputed corner cases.
4. **JIT vs interpreter lockstep.** Run the same guest in both and compare architectural state at region boundaries. A "JIT stress" mode sets the compile threshold to 0 and uses a tiny code cache so eviction and invalidation are exercised constantly.
5. **FP conformance.** TestFloat vectors for every FP op, rounding mode, FZ/DN combination and FMA.
6. **Bare-metal system tests.**
   - Small EL1 assembly/C tests report results through PSCI `SYSTEM_OFF` with a code.
   - Run **kvm-unit-tests** (arm64: selftest, psci, gic, timer, mmu-related) unmodified as guests.
7. **Boot tests.**
   - A deterministic Buildroot kernel + initramfs boots, runs a script, powers off, and its console output is asserted.
   - Later: Alpine and Debian arm64 from virtio-blk.
   - These run natively (headless runner around core) *and* in Chromium through Playwright.
8. **In-guest suites.**
   - Subsets of LTP, the kernel's arm64 selftests (fp, signal, abi), BusyBox tests and language test suites (Python).
   - Guest JITs (Node/V8, LuaJIT) exercise code invalidation.
9. **Memory model and SMP** (from M7): herdtools7 `litmus7` ARMv8 litmus tests run in the guest, with observed outcomes checked against the allowed set. Atomics stress tests too.
10. **Fuzzing.** `cargo-fuzz` on the decoder (never panics and matches the reference disassembler), the virtqueue/descriptor parsing and the DTB/boot loader inputs.

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
| [Berkeley SoftFloat 3 / TestFloat 3](http://www.jhauser.us/arithmetic/) | BSD-3-Clause | Software FP slow path (rounding modes, FMA). FP conformance vectors |
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
**Status:** done 2026-09-25 (see `bench/spike/REPORT.md`). Still pending: the M4 Mac Linux VM and a spike re-run on Chromium arm64.

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
**Status:** done 2026-09-25 on x86_64 (see `bench/spike/memory/REPORT.md`). **Decision: A.** Still pending: the arm64 (M4) run with `node bench/spike/memory/run-all.ts`, which reopens the decision only if C comes in at ≤ 5% there on both kernels and the wasm64 core.

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
- Decoder generated from a pattern table (port dynarmic's `a64.inc` or generate from Arm's spec).
- Interpreter for data processing, branches, loads/stores (all addressing modes), exclusives, LSE, on flat memory.
- Golden-corpus generator, oracle harness (qemu-aarch64 + M4 hardware), comparator. Decoder fuzzing against Capstone.
- **Exit:** integer golden corpus passes, and interpreter MIPS in Chromium is recorded.

### M2 — FP and AdvSIMD in the interpreter
- Scalar FP, NEON integer and FP, FPCR/FPSR semantics, SoftFloat slow path, software FMA.
- **Exit:** TestFloat and the FP/NEON golden corpus pass.

### M3 — System level, Linux boots (interpreter only)
- EL0/EL1, the exception model, system registers (ID registers advertising exactly what's implemented), MMU walker + software TLB, TLBI, generic timer, GICv2, PL011, PSCI, DTB generation, `Image` boot protocol.
- kvm-unit-tests. Deterministic mode.
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

### M7 — SMP
- One worker per vCPU on shared memory. PSCI `CPU_ON`, GIC SGIs, WFI → `Atomics.wait`, broadcast TLBI/IC with `DSB` completion, per-worker code caches with cross-vCPU invalidation.
- litmus7 suites and atomics stress. Scaling benchmarks (parallel `make`, `7z b -mmt`).
- **Exit:** a multi-core Debian boot is stable under stress, and the scaling curve is recorded.

### M8 — Product integration
- Snapshots (save/restore CPU + devices + compressed RAM) for instant "boot".
- Stable embedding API (VM config → DTB/devices), networking backend API for your P2P network, persistence UX, docs.
- Firefox and Safari compatibility pass (Chromium remains the performance target).

## 8. Risks to watch

- **Wasm module compile/instantiate latency** dominating JIT benefit. The M0 spike quantifies this; batching and tiering thresholds mitigate it.
- **FP exactness** (FMA, NaN payloads, rounding modes) costing more than expected. It's contained to the slow paths, and TestFloat catches regressions.
- **Broadcast TLBI/IC + `DSB` synchronization** across workers under SMP. This is a known ARM cost that shapes the M7 design.
- **Rust + wasm threads** needs nightly with `-Z build-std`, with atomics enabled via `-Zllvm-target-feature=+atomics` (`-Ctarget-feature=+atomics` is being phased out, rust-lang/rust#162235). The toolchain is pinned in `rust-toolchain.toml`.
- **Guest RAM ceiling / memory layout.** Settled in M0.5: layout A, so guest RAM ≤ ~3.5 GiB. The measured gaps to B/C/D are recorded in `bench/spike/memory/REPORT.md`; re-measure them on new Chromium releases and on arm64. Past 3.5 GiB the path is spill memories as NUMA nodes (the M0.5 NUMA follow-up). Chromium gives no catchable error when host RAM runs out: the renderer is OOM-killed, so guest RAM must be sized against host RAM up front.
- **Cross-origin isolation** (COOP/COEP) is required for `SharedArrayBuffer`. It constrains embedding and third-party resources.
