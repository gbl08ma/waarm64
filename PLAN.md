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
| Platform | QEMU `virt`'s memory map; **GICv3 (no ITS) since M7** (the GICv2 model was dropped in M7: every guest we run has a GICv3 driver); generic timer, PL011, a PL031 RTC (realtime mode), PSCI over HVC (answered in the core, CPU_ON included; SYSTEM_OFF/RESET exit to the host), virtio-mmio v2, a DTB generated from the VM config ([docs/platform.md](docs/platform.md)) |
| Boot | Direct kernel boot (arm64 `Image` + initrd + DTB) for the tests' guests. **M8 phase B:** boot conventional arm64 disk images unmodified, through UEFI firmware (our EDK2 build, entered as an `Image`: the firmware configuration, loop 2) and their own bootloader; the page boots Debian's published image unmodified that way (loop 3) |
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

- Each milestone starts from a kickoff brief (`M<n>-KICKOFF.md`, tracked in the repo root) that
  the user confirms: goal, decisions already taken, loops, what needs their OK, validation, exit
  criteria. Handovers (`M<n>-*-HANDOVER.md`, tracked too) carry the work from one session to the
  next; only the current milestone's brief and latest handover stay in the tree.
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
  and initrd without host tools beyond Node, serves on localhost and prints the URL (since phase B loop 3 it links the disk and builds the UEFI firmware with Podman instead of extracting a kernel). Done in M8
  loop 5 ([docs/frontend.md](docs/frontend.md) "`npm start`").
- **Frontend stack:** start with plain TypeScript and the DOM (as the rest of `web/`); Chromium
  only. **Not a hard rule:** Svelte is pre-approved if a framework would make a specific part
  easier. It needs compiling, so it would come with a compile step in `tools/serve.ts` (as type
  stripping is) rather than a separate build.
- **No public hosting in M8** (others clone the repo); **no guest network in the first phase.**
- The Firefox and Safari pass left M8 for the backlog (the user checks Firefox by hand later).

Phases (A first; after A, the tracks in C can run in parallel, one agent each):
- **A. The interactive machine — done (2026-09-29, loops 0–7).** `npm start` on a fresh clone
  (Node ≥ 26 and rustup; ~0.1 s when nothing changed, ~12 s cold plus Debian's 400 MB download)
  serves `http://127.0.0.1:8080/`, where Debian 13 boots under the JIT on `min(4, cores − 2)`
  parallel vCPUs with fbcon on the canvas and a getty on the serial terminal (xterm.js); root logs
  in without a password on either; the disk persists in the OPFS overlay across reloads, with
  Reset disk. Page load to the login prompt **~29 s on 4 vCPUs, 31.5 s on 2** (this host);
  key to glyph **~11 ms** on the terminal, **~15 ms** on the screen. Console input through the
  PL011 RX ring in every runner; loading progress, errors with actions (Retry, Reset disk, the
  serial log), a host-memory check; Node's disk reader (partitions, ext4) replaced the host tools
  for Debian's kernel and initrd. `tests/page-debian.test.ts` (logins on both consoles, a marker
  across them, persistence and reset) and `tests/start.test.ts` (a fresh clone through `npm
  start`) run in CI with the Debian image. The exit fixed a JIT memory-ordering bug (address
  dependencies through `eor x, x, x`, [docs/jit.md](docs/jit.md) "Atomics"). The user's pass
  ("I like what I see") left four rough edges, handled in loop 8: Ctrl+Alt+F1–F12 in the Keys
  menu; the overlay's hand-over between machines ordered by a Web Lock, with restarts that can't
  overlap (a Restart had once failed with "disk in use"); `timer.bin` robust to a descheduled
  vCPU; Firefox's missing root disk recorded in the backlog. Rough edges the user finds go to
  [docs/backlog.md](docs/backlog.md) "The page". Details: [docs/frontend.md](docs/frontend.md);
  numbers: `bench/boot/REPORT.md` "M8 loop 0"–"M8 loop 8".
- **B. Your own disk: boot an unmodified image, take the disk back** (the user, 2026-09-30:
  before snapshots, the basic loop has to be right: load a disk into the VM, boot it, work, shut
  down, take the modified disk away). Kickoff confirmed 2026-09-30 (`M8-PHASEB-KICKOFF.md`): **images in scope are Debian and
  Alpine only** (Alpine's UEFI cloud images). Loop 0 (the QEMU oracle, 2026-09-30) settled the
  shape ([docs/plans/uefi.md](docs/plans/uefi.md)): **EDK2's ArmVirtQemuKernel** entered like a
  kernel through our direct boot (no code flash, no reset vector; stock ArmVirtQemu requires
  fw_cfg), **one CFI flash bank for EFI variables**, the framebuffer moved out of `/memory`
  (EDK2 ignores `/reserved-memory`), a **minimal fw_cfg** (systemd credentials so the tests
  boot Debian unattended; the release build's Debian runs its first boot as on a regular machine,
  the user's call; later ramfb, a firmware GOP), a NoCloud seed disk for Alpine's tests, and **the DT stays** the guests' description (DT and ACPI
  measured the same on these images; the user asked). Loop 1: `images/build.sh edk2`
  (reproducible) and the UEFI oracle `tools/uefi-oracle.ts`; loop 2 (the platform) is next.
  - **Disk in:** an image by URL (hosted, as the Debian image is now) or a local file, qcow2 or raw,
    over the existing blk backends. The same path takes a disk of changes back in (below).
  - **Boot it unmodified through UEFI** (the user, 2026-09-30): EDK2's ArmVirtQemu firmware
    (BSD-2-Clause-Patent, built in Podman as a guest workload) runs the image's own bootloader
    (GRUB, systemd-boot), which loads its kernel through the EFI stub. That's the standard path
    every arm64 distro image supports, so the user's image boots the way it would on a real
    machine. It covers any filesystem, GRUB menus, EFI variables and kernel updates in the guest.
    **Not** a loader in the page that reads `/boot` and guesses the boot entry. That was proposed
    and rejected: it isn't standardized, would break with each distro's layout, and takes the
    choice of bootloader away from the user. It needs a CFI flash for the firmware and its
    variables, and QEMU's DTB handover; the PL031 is there.
  - **Work and shut down:** the OPFS overlay as today; a clean power-off.
  - **Disk out,** two ways:
    - **Just the changes:** a qcow2 holding the overlay's blocks (4 KiB clusters, as the overlay
      stores them), with the base image as its backing file (named, and identified by its SHA-256).
      A user of a hosted image keeps only their documents and software, not the whole OS. The same
      file uploaded onto the same base brings them back; our qcow2 reader learns backing files for it.
    - **The whole disk:** the base merged with the overlay, as a qcow2 or raw download, for use
      elsewhere.
- **C. Parallel tracks**- **C. Parallel tracks**, each starting from its plan doc (written first where none exists):
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
  - Snapshots ([docs/plans/snapshots.md](docs/plans/snapshots.md)): save and restore CPU, devices
    and compressed RAM, so the page resumes a booted machine in seconds instead of a full boot, as
    files the user downloads and uploads. After phase B: a snapshot pins the disk it was taken
    with, and phase B settles what the disk is.
- **D. Choosing and shaping machines:** a catalog of hosted images (Debian, Alpine, …) on top of
  phase B's disk in, extra disks, RAM and vCPU settings (default vCPUs from
  `navigator.hardwareConcurrency` minus the device worker and the page, with the P/E-core
  caveat); and **the stable
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
