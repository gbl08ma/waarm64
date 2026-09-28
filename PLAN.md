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
| Platform | QEMU `virt`'s memory map; **GICv3 (no ITS) since M7** (the GICv2 model was dropped in M7: every guest we run has a GICv3 driver); generic timer, PL011, PSCI over HVC (answered in the core, CPU_ON included; SYSTEM_OFF/RESET exit to the host), virtio-mmio v2, a DTB generated from the VM config ([docs/platform.md](docs/platform.md)) |
| Boot | Direct kernel boot (arm64 `Image` + initrd + DTB); no UEFI. Distro kernels and initrds are extracted from their images |
| Core | Rust compiled to wasm32 (the same crate builds natively for tests); host glue in TypeScript without a build step |
| Guest memory | **Layout A** (M0.5): one shared wasm32 memory, core state then guest RAM (≤ ~3.5 GiB). One lowering point for guest accesses in generated code; TLB tag bits 3–11 reserved for a memory index ("A + spill memories" as NUMA nodes later) ([docs/architecture.md](docs/architecture.md)) |
| JIT | Gadget style (inline what pays, helper calls into the interpreter's code for the rest), blocks keyed by guest PA, loop regions with tier-up, exact step accounting ([docs/jit.md](docs/jit.md)) |
| Determinism | Deterministic mode (time from steps) for tests and most benchmarks: every guest takes the same steps on every host and tier. Realtime mode for guest-timed work and interactive use |
| Devices | Backends in TypeScript in one device worker; the core owns the virtio rings; net is raw Ethernet frames ([docs/devices.md](docs/devices.md)) |
| Browsers | Chromium first; cross-origin isolation required |
| License | MIT. GPL/EPL/CeCILL projects are oracles, guest workloads or behavioral references only, never copied (`THIRD_PARTY.md`) |

Deferred: SVE, EL2, 16K/64K granules (needed for RHEL-family kernels), virtio-pci/MSI, GICv3 ITS and LPIs.

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

Kickoff: `M7-KICKOFF.md` (decisions confirmed 2026-09-28). Goal: N vCPUs running Linux SMP on a
GICv3, stable under stress, with a scaling curve. **Done (2026-09-28):** loop 0 (Debian in CI,
litmus image and M4 reference), 1 (core instances per worker), 2 (GICv3 default, native test
kernels), 3 (deterministic round-robin SMP, PSCI CPU_ON/OFF, WFE/SEV, TLBI IS; Linux boots on up
to 8 vCPUs with exact steps in every runner), 3b (the GICv2 dropped), 4 (broadcast TLBI/IC
tests across vCPUs, JIT-check; the realtime queues and DSB wait designed in docs/platform.md).
Next: loop 5, realtime SMP (notes: `M7-LOOP4-HANDOVER.md`).
- **Two execution modes, one core:** deterministic SMP runs every vCPU round-robin on one thread
  with a fixed quantum and one shared code cache (exact, reproducible step counts in every runner;
  virtual time = total steps of all vCPUs); realtime SMP runs **one worker per vCPU** on the shared
  memory, a core instance and a code cache each. Tests use the first, users and scaling the
  second.
- **One core instance per worker:** per-thread stack and TLS exported from the core; `Vm` state
  shared across vCPUs with locks or atomics; per-vCPU `Vcpu` (TLB, JIT state).
- **PSCI** CPU_ON/CPU_OFF/AFFINITY_INFO **in the core** (realtime workers start at boot, parked
  until CPU_ON); `MPIDR_EL1` per vCPU; one DT `cpu` node per vCPU.
- **GICv3 becomes the default** (distributor, per-CPU redistributors, `ICC_*` system registers; no
  ITS/LPIs), so vCPUs aren't capped at 8; a guest-visible change that moves the step counts once.
  **The GICv2 model is dropped** (the user, 2026-09-28, revising decision 8: no guest we run
  needs it, and its tests only tested itself).
- **Broadcast maintenance:** `TLBI …IS` completes before the issuer's `DSB` returns (every
  running vCPU acknowledges at its next chunk boundary; idle ones apply it before resuming);
  `IC IVAU`/`IALLU(IS)` reach every code cache, drained at context synchronization and chunk
  boundaries.
- **Memory model:** DMB/DSB as real fences in the JIT; the interpreter's and walker's shared-RAM
  accesses reviewed; 128-bit atomics (CASP, LDXP/STXP) decided with litmus tests and a CASP
  stress; CAS-based exclusives checked; WFE ends the quantum (deterministic) or yields (realtime).
- **ABI 20:** `VmConfig.ncpus`, the GIC choice, per-vCPU run/state/signals/counters, thread setup
  (design note in `docs/abi.md` first).
- **Tests:** bare-metal SMP and GICv3 tests against QEMU (TCG, and hvf if it gives a GICv3),
  kvm-unit-tests' SMP and `gicv3-*` sets, herdtools7 `litmus7` in the guest, atomics stress,
  deterministic SMP boots with exact steps, repeated realtime boots, ThreadSanitizer on a native
  realtime runner, the userspace phases at N threads. Debian's JIT boot joins default CI.
- **Exit:** Debian boots on 4 vCPUs in realtime mode, stable under stress; litmus suites with no
  forbidden outcome; the scaling curve recorded.

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
