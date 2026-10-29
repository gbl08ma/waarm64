# webpc — plan

A whole-system AArch64 emulator for the browser. Guest code is JIT-compiled to WebAssembly. It
runs unmodified arm64 Linux distributions. Chromium is the primary target.

This file is the plan: the decisions that bind, the milestones that built the emulator, the tracks that
grow it now, the risks. **What exists and how it works is in [`docs/`](docs/README.md)**, organized by
topic. When a decision changes, update this file and the doc it affects in the same change; when a
track lands, its outcome moves into the docs and its row here stays a line.

## 1. Locked-in decisions

| Area | Decision |
|---|---|
| Guest ISA | ARMv8.0-A AArch64 with FP and AdvSIMD, no AArch32; LSE atomics and CRC32; the crypto extensions (AES, PMULL, SHA1, SHA256) switchable and on by default. No SVE/SME, PAC, BTI or MTE (their hint-space encodings are NOPs). **ID registers advertise exactly what's implemented, and an optional extension is advertised only if it's faster than what guests do without it.** ([docs/cpu.md](docs/cpu.md)) |
| Privilege | EL0 and EL1 only. No EL2/EL3, no secure state |
| MMU | Stage 1 only, 4K granule, 48-bit VA, TTBR0/TTBR1, ASIDs, software-managed access flag |
| Platform | QEMU `virt`'s memory map; **GICv3 (no ITS) since M7** (the GICv2 model was dropped in M7: every guest we run has a GICv3 driver); generic timer, PL011, a PL031 RTC (realtime mode), PSCI over HVC (answered in the core, CPU_ON included; SYSTEM_OFF/RESET exit to the host), virtio-mmio v2, a DTB generated from the VM config ([docs/platform.md](docs/platform.md)) |
| Boot | Direct kernel boot (arm64 `Image` + initrd + DTB) for the tests' guests; users' images through UEFI (below) |
| Core | Rust compiled to wasm32 (the same crate builds natively for tests); host glue in TypeScript without a build step |
| Guest memory | **Layout A** (M0.5): one shared wasm32 memory, core state then guest RAM (≤ ~3.5 GiB). One lowering point for guest accesses in generated code; TLB tag bits 3–11 hold a memory index: RAM past memory 0 goes to spill memories, NUMA nodes for the guest ([docs/spill-memories.md](docs/spill-memories.md)) ([docs/architecture.md](docs/architecture.md)) |
| JIT | Gadget style (inline what pays, helper calls into the interpreter's code for the rest), blocks keyed by guest PA, loop regions with tier-up, exact step accounting, one code cache of 320 MiB of wasm flushed whole when full ([docs/jit.md](docs/jit.md)); what isn't compiled runs in the block interpreter, the same blocks decoded once into micro-ops ([docs/cpu.md](docs/cpu.md) "The block interpreter") |
| Determinism | Deterministic mode (time from steps) for tests and most benchmarks: every guest takes the same steps on every host and tier. Realtime mode for guest-timed work and interactive use |
| SMP | N vCPUs, one core, two modes: **deterministic round-robin** on one thread (tests; exact steps; virtual time = the steps of all vCPUs) and **parallel**, a worker per vCPU with its own core instance and function table, on one code cache the vCPUs share (each module compiled once; [docs/jit.md](docs/jit.md) "Sharing") (users, scaling; realtime only). `TLBI …IS` completes before the issuer's `DSB` returns; `IC` drops the code from the shared cache at once, and each vCPU's table catches up before its next block; DMB is a real fence in parallel JIT code; the core's guest-RAM accesses are atomics ([docs/platform.md](docs/platform.md), [docs/cpu.md](docs/cpu.md)) |
| Devices | Backends in TypeScript in one device worker; the core owns the virtio rings; net is raw Ethernet frames ([docs/devices.md](docs/devices.md)) |
| Browsers | Chromium first; cross-origin isolation required |
| License | MIT. GPL/EPL/CeCILL projects are oracles, guest workloads or behavioral references only, never copied (`THIRD_PARTY.md`) |
| The page | **One machine per page**, under the JIT, realtime, parallel SMP. **The page starts no disk image** (since 2026-10-17): its machine is EDK2 waiting for the user's disk (Open disk, a drop, `?disk=`), and it names no distribution; Debian 13 is the tests' and benchmarks' guest (`?machine=debian`). Machines are named and stored in the browser, with their disks, overlays and snapshots ([docs/plans/machines.md](docs/plans/machines.md)). The screen (the framebuffer, then virtio-gpu) is the default view, with keyboard and mouse through virtio-input; a serial terminal on xterm.js is the fallback. Disks persist in OPFS copy-on-write overlays ([docs/frontend.md](docs/frontend.md)) |
| Booting users' images | **Unmodified, through UEFI**: EDK2's ArmVirtQemuKernel (built in Podman, reproducible) entered as an `Image` through our direct boot, running the image's own bootloader (GRUB, Limine, shim). **Not** a loader in the page that reads `/boot` and guesses the boot entry (rejected: not standardized, breaks with each distro's layout, takes the choice of bootloader away). The DT stays the guests' description (ACPI measured the same; out of scope). A disk comes from a file or a URL, raw or qcow2; its changes go out as a qcow2 over the base or as a whole disk, and come back in ([docs/firmware.md](docs/firmware.md)) |
| Frontend | **Svelte 5** for the page, the rest of `web/` plain TypeScript; **built with Vite** (the user, 2026-10-24); a desktop application's look. **`npm start`** on a fresh clone (Node and rustup the only prerequisites) builds and serves it; `npm run dist` makes a static copy, deployed by the user at `https://vm.tny.im` (a Cloudflare Worker with static assets); disk images on `vmdisks.tny.im`, **never R2**, whose uncached reads anyone can bill ([docs/remote-disks.md](docs/remote-disks.md)). New runtime dependencies need the user's OK |
| Graphics | **No software rendering or translation layers in the guest.** OpenGL ES through Mesa's upstream **virgl** onto **our virgl renderer on WebGL2** (the page's default where WebGL2 is; [docs/graphics.md](docs/graphics.md) "Decisions"). **Vulkan** (the user, 2026-10-25): Venus translated onto WebGPU, a per-machine choice until every program that switches to it is no slower than on virgl; a C toolchain for wasm allowed ([docs/plans/graphics.md](docs/plans/graphics.md) §2) |
| Video | VA-API over virgl, decoded by the browser's WebCodecs (not V4L2); H.264, VP9, AV1; **HEVC dropped** ([docs/plans/video.md](docs/plans/video.md)) |
| Audio | virtio-snd to an AudioWorklet; sound on by default (from the first click); the microphone opened when the guest records ([docs/audio.md](docs/audio.md)) |
| USB | WebUSB passthrough and WebHID onto an emulated xHCI; isochronous transfers left out (WebUSB protects the classes that use them) ([docs/usb.md](docs/usb.md)) |
| Network | Raw Ethernet frames to a gateway in the page; our own tailnet client (Rust, wasm) for Tailscale and tailcat; IPv6 required; several adapters per machine on connections the browser keeps ([docs/tailnet.md](docs/tailnet.md), [docs/network-adapters.md](docs/network-adapters.md)) |

Deferred: SVE, EL2, 16K/64K granules (needed for RHEL-family kernels), virtio-pci/MSI, GICv3 ITS and LPIs.

## 2. How work runs

- M0–M7 ran as milestones, M8 as one large milestone of phases; since then work runs as **tracks**: a feature, an
  idea of the user's or a backlog item worth taking on, each with a plan doc when it needs one
  (`docs/plans/`). §3 lists them.
- A track that spans sessions starts from a kickoff brief the user confirms (`<TRACK>-KICKOFF.md`, tracked in the
  repo root: goal, decisions taken, loops, what needs their OK, validation, the end), and handovers
  (`<TRACK>-HANDOVER.md`) carry it from one session to the next. Several tracks can be open at once. When a track
  ends, its outcome moves into the docs and its row in §3, and its kickoff and handover leave the tree (git history
  keeps them).
- Work goes in **short loops: one slice, one commit, a short report**, and continues through the
  track without check-ins; only decisions that can't be settled by measurement go to the user
  (dependencies, host ABI changes need a design note in [docs/abi.md](docs/abi.md) first,
  guest-visible changes and step counts, CPU features, FP semantics, forcing TurboFan).
- A track ends with all test layers green, its numbers recorded, the docs updated, and new backlog entries.
- Measurement records go to `bench/*/REPORT.md` with committed JSON ([docs/benchmarking.md](docs/benchmarking.md)).

## 3. Milestones and tracks

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

M8, **a usable machine** (from 2026-09-28): a person opens a URL and uses a Linux VM with keyboard, mouse and its
screen live. It ran as phases (A, the interactive page; B, your own disk through UEFI; C, parallel tracks; D, machines
as the unit) and turned into the tracks below.

### Tracks

What each built is in its doc; numbers in the reports it names. Open loose ends: [docs/backlog.md](docs/backlog.md).

| Track | State | Where |
|---|---|---|
| The interactive page (M8 phase A) | Done 2026-09-29 | [frontend.md](docs/frontend.md); `bench/boot/REPORT.md` "M8 loop 0"–"8" |
| Your own disk through UEFI (phase B) | Done 2026-10-01 | [firmware.md](docs/firmware.md), [frontend.md](docs/frontend.md) "Your own disk" |
| Snapshots and Suspend | Done 2026-10-01 | [plans/snapshots.md](docs/plans/snapshots.md), [platform.md](docs/platform.md) "Snapshots" |
| virtio-gpu 2D (G0, G1) | Done 2026-10-02 | [graphics.md](docs/graphics.md) |
| Disk I/O speed | Done 2026-10-08 (the overlay's runs; the rest dropped by measurement) | `bench/io/REPORT.md` |
| 3D through virgl on WebGL2 (G2–G4) | Done 2026-10-10: Firefox, GTK4, dEQP-GLES2/3's whole lists | [graphics.md](docs/graphics.md) |
| G5: 3D's breadth | Snapshots with 3D in use and dEQP on the Mac's GPU done 2026-10-19; the rest open, no kickoff | [graphics.md](docs/graphics.md) "Testing", backlog |
| Audio | Done 2026-10-12 | [audio.md](docs/audio.md) |
| Video decoding | Done 2026-10-15 | [plans/video.md](docs/plans/video.md) |
| Networking and the tailnet client | Done 2026-10-16, IPv6 among the loose ends | [plans/networking.md](docs/plans/networking.md), [tailnet.md](docs/tailnet.md) |
| Several network adapters | Done 2026-10-19 | [network-adapters.md](docs/network-adapters.md) |
| Machines as the unit (phase D's start) | Done 2026-10-17 (a cloud session) | [plans/machines.md](docs/plans/machines.md) |
| USB (WebUSB, WebHID) | Done 2026-10-18 | [usb.md](docs/usb.md) |
| Guest RAM past memory 0, the JIT's spill arm | Done 2026-10-19, 2026-10-24 | [spill-memories.md](docs/spill-memories.md) |
| A browser's code in the JIT (cache size, the memory signal, the compile worker, the cache's lock) | Done 2026-10-20 to 10-23 | [jit.md](docs/jit.md) |
| The block interpreter's speed | Done 2026-10-22 | [cpu.md](docs/cpu.md) "The block interpreter", `bench/interp/REPORT.md` |
| Remote disks | Done 2026-10-23 | [remote-disks.md](docs/remote-disks.md), `bench/remote-disk/REPORT.md` |
| Self-hosted debug | Done 2026-10-23 | [cpu.md](docs/cpu.md) "Self-hosted debug" |
| **Vulkan** (VK0, VK1 done 2026-10-25) | **VK2 done 2026-10-26**: Vulkan through Venus on the browser's WebGPU, a per-machine setting (the Machines page) with the module in `npm run dist`; the direct set translated (NIR → WGSL), what the device advertises from the adapter, frames to the screen through virgl; vkcube's, vkmark's and vkQuake's frames match lavapipe's, 1,463 dEQP-VK cases pass (`scripts/ci-deqp-vk.sh`), the gate (mpv on Vulkan with VA-API: no drops, the guest 13% busy on the M4); YCbCr and GTK4 left to VK3. On the user's NVIDIA desktop what Venus presented was black and a frame waited ~4.5 ms on its fence (REPORT.md "VK2: the NVIDIA run"): VK3's start. **VK3 done 2026-10-29** (REPORT.md "VK3: the summary"): NVIDIA's black frames (the device's NVIDIA vendor ID sent Venus's guest WSI down its prime blit; a GPU way's first copies now checked, with a fallback) and the fence's floor (a clamped `setTimeout(0)` poller, Dawn's late done) fixed; pipelines made asynchronously and translated shaders kept across runs; libplacebo's advanced path on (the M4's green a window page lost between devices, found by a static review; a cold mpv's freeze Mesa 26's async present, which the desktop image turns off); the adapter's subgroups, 16-bit storage and floats, tier2's formats; the driver's gaps dEQP-VK found; §4's emulated rows for Dawn, ANGLE's ES3 (WebGL 2 on Venus in the guest's Chromium) and vkd3d (a feature level 11_0 device), YCbCr conversions on by default (GTK 4.24 aborts without them; GTK4 takes GL by itself); one count of the bindings WebGPU takes, the advertised limits from it. dEQP-VK's list 1,463 → 4,690 cases, and 773 for YCbCr. Nine out-of-context reviews' findings fixed or filed (the track-end one's in L8a). The gate holds on SwiftShader and the M4 but for Dawn's program (the guest's Mesa), and on the user's NVIDIA desktop but at 1 fish (parked by the user): dEQP-VK's lists 4,624 of 4,690 there (one NVIDIA-only group, filed) and 773 of 773, subgroups of 32 right; Venus's submits there ~2 ms later than at L4e (none of the suspects; filed by the user's call). **VK4 started 2026-10-29** as tasks the user starts, ranked by compliance then cost ([VK4-KICKOFF.md](VK4-KICKOFF.md); plan §3); T1 done 2026-10-29: dEQP-VK's census (16,489 cases), 17% of the supported ones fail, two fifths of them the samplers' and a fifth compressed images padded to whole blocks (a new task, T18); the list 4,725 → 7,126 cases, the tasks re-ranked (REPORT.md "VK4 T1"); how Vulkan works now: [graphics.md](docs/graphics.md) "Vulkan through Venus" | [plans/graphics.md](docs/plans/graphics.md), [vk/README.md](vk/README.md), `bench/vulkan/REPORT.md` |

Proposed, not started: peer-to-peer rooms over WebRTC ([plans/networking-p2p.md](docs/plans/networking-p2p.md)); a
local network helper ([plans/networking-local.md](docs/plans/networking-local.md)); a guest agent and live resize
([plans/agent.md](docs/plans/agent.md)); a preloaded image and snapshot loaded with the page (likely the Arch desktop
guest), a catalog of hosted images, and the stable embedding API, extracted from what the page ended up using
([plans/machines.md](docs/plans/machines.md)); Firefox and Safari (the user checks Firefox by hand; backlog).

### Backlog

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
- **Guest RAM ceiling:** memory 0 holds at most 3 GiB less 1 MiB of RAM; past it, spill memories as NUMA nodes
  (done, up to 16 GiB on the page): node 1 at 1.0–1.6× memory 0's time through the JIT's spill arm, nodes 2 and up
  2–19× (docs/spill-memories.md).
  Chromium gives no catchable error when host RAM runs out (the renderer is OOM-killed), so guest
  RAM is sized against host RAM up front (the page: [docs/frontend.md](docs/frontend.md) "Errors").
- **Linux arm64 has no V8 trap handler:** explicit bounds checks cost up to 27% there, which
  macOS and x86_64 users don't pay; our numbers on the dev VM are pessimistic for them.
- **Cross-origin isolation** (COOP/COEP) is required for `SharedArrayBuffer`; it constrains
  embedding and third-party resources.
