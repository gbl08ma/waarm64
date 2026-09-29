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
| Boot | Direct kernel boot (arm64 `Image` + initrd + DTB); no UEFI. Distro kernels and initrds are extracted from their images. **Goal for a future milestone:** boot conventional arm64 disk images unmodified, through their own bootloader (UEFI; [backlog](docs/backlog.md)) |
| Core | Rust compiled to wasm32 (the same crate builds natively for tests); host glue in TypeScript without a build step |
| Guest memory | **Layout A** (M0.5): one shared wasm32 memory, core state then guest RAM (≤ ~3.5 GiB). One lowering point for guest accesses in generated code; TLB tag bits 3–11 reserved for a memory index ("A + spill memories" as NUMA nodes later) ([docs/architecture.md](docs/architecture.md)) |
| JIT | Gadget style (inline what pays, helper calls into the interpreter's code for the rest), blocks keyed by guest PA, loop regions with tier-up, exact step accounting ([docs/jit.md](docs/jit.md)) |
| Determinism | Deterministic mode (time from steps) for tests and most benchmarks: every guest takes the same steps on every host and tier. Realtime mode for guest-timed work and interactive use |
| SMP | N vCPUs, one core, two modes: **deterministic round-robin** on one thread (tests; exact steps; virtual time = the steps of all vCPUs) and **parallel**, a worker per vCPU with its own core instance and code cache (users, scaling; realtime only). `TLBI …IS` completes before the issuer's `DSB` returns; `IC` reaches every code cache by its next context synchronization; DMB is a real fence in parallel JIT code; the core's guest-RAM accesses are atomics ([docs/platform.md](docs/platform.md), [docs/cpu.md](docs/cpu.md)) |
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
| M7 | SMP (2026-09-28) | A GICv3 (the GICv2 dropped), PSCI CPU_ON/OFF/AFFINITY_INFO, per-CPU timers, SGIs, WFE/SEV; deterministic round-robin (Linux on up to 8 vCPUs with exact steps in every runner) and parallel SMP (a worker per vCPU in the browser and Node, a thread natively; ABI 20–26); broadcast TLBI/IC with the DSB wait; the memory model (DMB as `atomic.fence`, relaxed atomics, hashed pair locks); litmus7 with no forbidden outcome and an atomics stress in every mode and tier, ThreadSanitizer in CI. On 4 parallel vCPUs Debian boots to its script in 29.6 s (42.3 s on 1); compute throughput 3.4–3.8×, process churn 1.7× |

Details of each: the docs (by topic) and `bench/*/REPORT.md` (by date). Numbers today:
[docs/benchmarking.md](docs/benchmarking.md) "Current numbers".

### M8 — A usable machine

**Drive:** something to show for the project. A person runs one command on a fresh clone, opens a
URL and uses a Linux VM with keyboard and mouse, seeing its screen live, as in v86's demos. Until
M8 every guest ran headless under a test. Snapshots, networking, graphics, audio and the
embedding API are scheduled by what that page needs, not as ends in themselves. Kickoff:
`M8-KICKOFF.md`.

Decisions (the user, 2026-09-28):
- **One VM per page, Debian 13 first**, hardcoded at the start (the nocloud image: root without a
  password), under the JIT, realtime, parallel SMP. Image choice, extra disks and settings come
  later in M8 or after it.
- **The framebuffer is the default view**: the guest's fbcon on the canvas (Debian's kernel has
  `simplefb` and `fbcon` built in), with keyboard and mouse through virtio-input. **A serial
  terminal on xterm.js** (`@xterm/xterm`, MIT: approved as the first runtime dependency, with its
  official addons) is the fallback, debug and "advanced" view.
- **The disk persists** across reloads in the OPFS copy-on-write overlay, with a reset on the
  page.
- **One command from a fresh clone** (`npm start`): builds from source on Linux and macOS (Node
  and rustup are the only prerequisites, with the C compiler Rust's build scripts need; it says
  clearly what's missing), builds the wasm core if stale, downloads Debian and extracts its kernel
  and initrd without host tools beyond Node, serves on localhost and prints the URL. Done in M8
  loop 5 ([docs/frontend.md](docs/frontend.md) "`npm start`").
- **Frontend stack:** start with plain TypeScript and the DOM (as the rest of `web/`); Chromium
  only. **Not a hard rule:** Svelte is pre-approved if a framework would make a specific part
  easier. It needs compiling, so it would come with a compile step in `tools/serve.ts` (as type
  stripping is) rather than a separate build.
- **No public hosting in M8** (others clone the repo); **no guest network in the first phase.**
- The Firefox and Safari pass left M8 for the backlog (the user checks Firefox by hand later).

Phases (A first; after A, the tracks in C can run in parallel, one agent each):
- **A. The interactive machine** (the kickoff): console input from the host (the PL011 RX path
  the core already has), the page (screen, input focus and capture, the xterm.js view, power
  and disk controls, boot progress, errors a user can act on), `npm start`, and an end-to-end
  Chromium test that logs in and runs a command (done in M8 loop 6: `tests/page-debian.test.ts`,
  in CI with the Debian image; [docs/frontend.md](docs/frontend.md) "The end-to-end test").
- **B. Instant start: snapshots.** Save and restore CPU, devices and compressed RAM, so the page
  resumes a booted machine in seconds instead of a full Debian boot. A snapshot pins the overlay
  state it was taken with; parallel SMP stops every vCPU at a chunk boundary first
  ([backlog](docs/backlog.md) "Snapshots in parallel SMP").
- **C. Parallel tracks**, each starting from its plan doc (written first where none exists):
  - Networking ([docs/plans/networking.md](docs/plans/networking.md)): the Ethernet gateway, then
    a first backend. For a page served by our dev server, a relay to a user-mode NAT in the dev
    server (no account needed) is the candidate to weigh against the plan's Tailscale-first
    order, which targets static hosting.
  - Graphics ([docs/plans/graphics.md](docs/plans/graphics.md)): virtio-gpu 2D first (the screen
    follows the page's size, damage instead of full copies, a cursor), then the software
    baseline and the 3D decision gate.
  - Audio: virtio-snd to an AudioWorklet over a shared ring (`docs/plans/audio.md`, to write).
  - Host integration: clipboard, dropping files into the guest (9p), pointer lock, keyboard
    layouts.
- **D. Choosing and shaping machines:** image selection (Debian, Alpine, a URL), extra disks,
  RAM and vCPU settings (default vCPUs from `navigator.hardwareConcurrency` minus the device
  worker and the page, with the P/E-core caveat), overlay export and import; and **the stable
  embedding API**, extracted from what the page ended up using (VM config to DTB and devices,
  CPU feature switches, devices, snapshots, network backends), with its docs.
- Compiling off the vCPU thread, if a GUI guest's latency asks for it.

### M9 — Backlog

Unscheduled loose ends, by area: [docs/backlog.md](docs/backlog.md).

## 4. Risks

- **Broadcast TLBI + `DSB` across workers:** the issuer waits for the targets' chunk boundaries.
  Waiting only for vCPUs running the TLBI's ASID left ~3K waits of 20–60 µs per userspace run on 4
  vCPUs; a workload heavy in all-ASID or kernel-range TLBIs would pay more.
- **Wasm module compile latency** dominating JIT gains: batching, thresholds and tier-up keep it
  down today (compile pauses ≤ 1.3 ms). Parallel SMP compiles per vCPU (each what it runs, ~200 ms
  per vCPU in an Alpine boot) until code can be shared across workers.
- **Host core topology bounds parallel SMP:** past the host's performance cores (4 on the M4),
  vCPU workers that sleep and wake land on efficiency cores and scaling flattens; the user-facing
  default vCPU count must account for it (backlog).
- **FP exactness** costing more than expected: contained to slow paths; TestFloat and the
  differential test catch regressions.
- **Rust + wasm threads** needs nightly (`-Zbuild-std`, `-Zllvm-target-feature=+atomics`); the
  toolchain is pinned, and `simd128` stays off until LLVM's bitmask bug is fixed.
- **Guest RAM ceiling:** layout A caps RAM at ~3.5 GiB; past it, spill memories as NUMA nodes.
  Chromium gives no catchable error when host RAM runs out (the renderer is OOM-killed), so guest
  RAM is sized against host RAM up front (the page: [docs/frontend.md](docs/frontend.md) "Errors").
- **Linux arm64 has no V8 trap handler:** explicit bounds checks cost up to 27% there, which
  macOS and x86_64 users don't pay; our numbers on the dev VM are pessimistic for them.
- **Cross-origin isolation** (COOP/COEP) is required for `SharedArrayBuffer`; it constrains
  embedding and third-party resources.
