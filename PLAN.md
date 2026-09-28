# webpc — plan

A whole-system AArch64 emulator for the browser. Guest code is JIT-compiled to WebAssembly. It
runs unmodified arm64 Linux distributions. Chromium is the primary target.

This file is the plan: the decisions that bind, the milestones, the risks. **What exists and how
it works is in [`docs/`](docs/README.md)**, organized by topic. When a decision changes, update
this file and the doc it affects in the same change; when a milestone lands, its outcome moves into
the docs and its entry here shrinks to a summary.

## 1. Locked-in decisions

| Area | Decision |
|---|---|
| Guest ISA | ARMv8.0-A AArch64 with FP and AdvSIMD, no AArch32; LSE atomics and CRC32; the crypto extensions (AES, PMULL, SHA1, SHA256) switchable and on by default. No SVE/SME, PAC, BTI or MTE (their hint-space encodings are NOPs). **ID registers advertise exactly what's implemented, and an optional extension is advertised only if it's faster than what guests do without it.** ([docs/cpu.md](docs/cpu.md)) |
| Privilege | EL0 and EL1 only. No EL2/EL3, no secure state |
| MMU | Stage 1 only, 4K granule, 48-bit VA, TTBR0/TTBR1, ASIDs, software-managed access flag |
| Platform | QEMU `virt`'s memory map; GICv2 (a GICv3 subset later), generic timer, PL011, PSCI over HVC (answered in the core; SYSTEM_OFF/RESET and CPU_ON exit to the host), virtio-mmio v2, a DTB generated from the VM config ([docs/platform.md](docs/platform.md)) |
| Boot | Direct kernel boot (arm64 `Image` + initrd + DTB); no UEFI. Distro kernels and initrds are extracted from their images |
| Core | Rust compiled to wasm32 (the same crate builds natively for tests); host glue in TypeScript without a build step |
| Guest memory | **Layout A** (M0.5): one shared wasm32 memory, core state then guest RAM (≤ ~3.5 GiB). One lowering point for guest accesses in generated code; TLB tag bits 3–11 reserved for a memory index ("A + spill memories" as NUMA nodes later) ([docs/architecture.md](docs/architecture.md)) |
| JIT | Gadget style (inline what pays, helper calls into the interpreter's code for the rest), blocks keyed by guest PA, loop regions with tier-up, exact step accounting ([docs/jit.md](docs/jit.md)) |
| Determinism | Deterministic mode (time from steps) for tests and most benchmarks: every guest takes the same steps on every host and tier. Realtime mode for guest-timed work and interactive use |
| Devices | Backends in TypeScript in one device worker; the core owns the virtio rings; net is raw Ethernet frames ([docs/devices.md](docs/devices.md)) |
| Browsers | Chromium first; cross-origin isolation required |
| License | MIT. GPL/EPL/CeCILL projects are oracles, guest workloads or behavioral references only, never copied (`THIRD_PARTY.md`) |

Deferred: SVE, EL2, 16K/64K granules (needed for RHEL-family kernels), virtio-pci/MSI, GICv3 ITS.

## 2. How milestones run

- Each milestone starts from a kickoff brief (`M<n>-KICKOFF.md`, untracked) that the user
  confirms: goal, decisions already taken, loops, what needs their OK, validation, exit criteria.
- Work goes in **short loops: one slice, one commit, a short report**, and continues through the
  milestone without check-ins; only decisions that can't be settled by measurement go to the user
  (dependencies, host ABI changes need a design note in [docs/abi.md](docs/abi.md) first,
  guest-visible changes and step counts, CPU features, FP semantics, forcing TurboFan).
- Every milestone ends with all test layers green, a recorded benchmark baseline in Chromium, the
  counters reviewed, the docs updated, and new backlog entries.
- Measurement records go to `bench/*/REPORT.md` with committed JSON ([docs/benchmarking.md](docs/benchmarking.md)).

## 3. Milestones

### Done

| | Milestone | Outcome |
|---|---|---|
| M0 | Foundations and feasibility spike (2026-09-25) | Repo, CI scripts, the Playwright harness; JIT design numbers in `bench/spike/REPORT.md` (compile ~46 µs per module, so batch; import calls ~2 ns; sync compile in a worker is fine). Re-run on arm64 in M6 |
| M0.5 | Memory architecture (2026-09-25) | Layout A on both hosts: every >4 GiB layout cost more than 5% (`bench/spike/memory/REPORT.md`) |
| M1 | A64 integer interpreter + golden corpus (2026-09-25) | Decoder from dynarmic's table; corpus against the M4 and QEMU; exhaustive decoder sweep vs Capstone clean |
| M2 | FP and AdvSIMD in the interpreter (2026-09-25) | All v8.0 FP/SIMD; our own software FP passes TestFloat 3e (51.2M cases); ~46,000 corpus tests |
| M3 | System level: Linux boots on the interpreter (2026-09-25) | EL1, MMU + TLB, GICv2, timer, PL011, PSCI, DTB, the whole-VM ABI, deterministic time; bare-metal tests; kvm-unit-tests; the Buildroot guest boots natively and in Chromium in the same steps |
| M4 | virtio devices and real distros (2026-09-26) | virtio-mmio: console, rng, blk (HTTP, qcow2, OPFS overlay), net, 9p, input, a framebuffer; realtime mode; Alpine and Debian 13 boot; LTP subset and arm64 kselftests pass; I/O benchmarks |
| M5 | JIT tier 1 (2026-09-27) | Gadget JIT with inline ALU, loads/stores through the TLB, registers in locals, lazy flags, linking, loop regions; every suite under the JIT and JIT-stress with the interpreter's steps. Integer 27×, CoreMark 11.3× the interpreter; Alpine 18.4 s vs 46.9 s |
| M6 | JIT optimization (2026-09-27) | System instructions, SIMD&FP loads/stores, NEON as SIMD128, exact FP fast paths, atomics inline; global TLB entries kept across ASIDs; bigger modules; branch hints; `CHUNK` 32K after ERET ends the chunk. Alpine 10.2 s (target ≤ 12.2 s), FP guest 155 MIPS (target ≥ 98), CoreMark 69% of QEMU TCG (a stretch goal, not an exit blocker); the Alpine userspace benchmark; the M6 exit table vs QEMU and native |
| M6.5 | Crypto extensions (2026-09-28) | AES, PMULL, SHA1, SHA256 in both tiers (our own code), switchable (ABI 19), advertised by default: `openssl speed` 1.5–4.7× the NEON-only paths |

Details of each: the docs (by topic) and `bench/*/REPORT.md` (by date). Numbers today:
[docs/benchmarking.md](docs/benchmarking.md) "Current numbers".

### M7 — SMP

Kickoff: `M7-KICKOFF.md` (drafted 2026-09-28, to confirm). Goal: N vCPUs (≤ 8, GICv2's limit)
running Linux SMP, stable under stress, with a scaling curve.
- **Two execution modes, one core:** deterministic SMP runs every vCPU round-robin on one thread
  with a fixed quantum (exact, reproducible step counts natively, in Node and in Chromium, as
  today; how QEMU's single-threaded TCG and icount work); realtime SMP runs **one worker per vCPU**
  on the shared memory (parallel, as MTTCG). Tests use the first, users and scaling benchmarks the
  second. (Proposed; confirm at kickoff.)
- **One core instance per worker** on the shared memory, each with its own stack and TLS (the core
  must export them; today a second instance would share the first one's stack); `Vm` state shared
  across vCPUs with locks or atomics; per-vCPU `Vcpu` (TLB, JIT state, code cache, table).
- **PSCI** `CPU_ON`/`CPU_OFF`/`AFFINITY_INFO` for real; `MPIDR_EL1` per vCPU; one DT `cpu` node
  per vCPU.
- **GICv2 per-CPU:** banked SGI/PPI state (enable, pending, active, priority) and a CPU interface
  per vCPU; `GICD_ITARGETSR` implemented with SPIs routed by target; `GICD_TYPER.CPUNumber`; SGIs to
  other CPUs and all-but-self through `GICD_SGIR` with the source in `GICC_IAR` bits 12:10;
  `GICD_CPENDSGIR`/`SPENDSGIR`. A cross-worker way to raise a line and wake a vCPU (per-vCPU signal
  words, `Atomics.notify`).
- **Broadcast maintenance:** `TLBI …IS` on another vCPU completes before the issuer's `DSB`
  (a request each target acknowledges at its next chunk boundary or while idle; the issuer waits,
  as QEMU's `*_all_cpus_synced`); `IC IVAU`/`IALLU(IS)` invalidate every vCPU's code cache, drained
  at context synchronization (ISB, exception entry, ERET) and chunk boundaries.
- **Memory model:** DMB/DSB become real fences (`atomic.fence`) in the JIT; the interpreter's
  plain accesses reviewed for data races; **128-bit atomics** (CASP, LDXP/STXP under one lock that
  only excludes other pair ops) decided with litmus tests and a CASP stress; CAS-based exclusives
  checked against litmus7; WFE/SEV as a real wait (a spinning vCPU mustn't burn its quantum or a
  host core).
- **Tests:** kvm-unit-tests' SMP tests (`selftest-smp`, `gicv2-ipi`, `gicv2-mmio`, `psci`),
  herdtools7 `litmus7` suites in the guest, atomics stress, SMP boots of Buildroot, Alpine and
  Debian in both modes, the Alpine userspace phases at N threads.
- **Exit:** a multi-core Debian boot is stable under stress, the litmus suites pass, and the
  scaling curve (userspace phases and a parallel build at 1–N vCPUs) is recorded.

### M8 — Product integration

- Snapshots (save/restore CPU + devices + compressed RAM) for instant "boot".
- A stable embedding API (VM config → DTB/devices; a user-facing CPU features toggle), the
  networking backend API, persistence UX, docs.
  - Networking: [docs/plans/networking.md](docs/plans/networking.md) (exploration, not scheduled):
    the frame interface stays, v86 adapter compatibility dropped, a Tailscale backend first
    (upstream Go client in wasm behind a DHCP/ARP gateway), `tailscale-rs` re-evaluated later,
    WebRTC experimental.
  - Graphics: [docs/plans/graphics.md](docs/plans/graphics.md) (exploration, not scheduled):
    virtio-gpu 2D, a software baseline, then Venus (Vulkan) replayed on WebGPU, with OpenGL
    through Zink, behind a decision gate after the first frame.
- Compiling off the vCPU thread if a GUI guest's latency asks for it.
- Firefox and Safari compatibility pass (Chromium stays the performance target).

### M9 — Backlog

Unscheduled loose ends, by area: [docs/backlog.md](docs/backlog.md).

## 4. Risks

- **Broadcast TLBI/IC + `DSB` synchronization across workers** (M7): a known ARM cost that shapes
  the SMP design; the issuer waits for every running vCPU to reach a chunk boundary.
- **Wasm module compile latency** dominating JIT gains: batching, thresholds and tier-up keep it
  down today (compile pauses ≤ 1.3 ms); per-vCPU code caches in M7 multiply compile work by N.
- **FP exactness** costing more than expected: contained to slow paths; TestFloat and the
  differential test catch regressions.
- **Rust + wasm threads** needs nightly (`-Zbuild-std`, `-Zllvm-target-feature=+atomics`); the
  toolchain is pinned, and `simd128` stays off until LLVM's bitmask bug is fixed.
- **Guest RAM ceiling:** layout A caps RAM at ~3.5 GiB; past it, spill memories as NUMA nodes.
  Chromium gives no catchable error when host RAM runs out (the renderer is OOM-killed), so guest
  RAM is sized against host RAM up front.
- **Linux arm64 has no V8 trap handler:** explicit bounds checks cost up to 27% there, which
  macOS and x86_64 users don't pay; our numbers on the dev VM are pessimistic for them.
- **Cross-origin isolation** (COOP/COEP) is required for `SharedArrayBuffer`; it constrains
  embedding and third-party resources.
