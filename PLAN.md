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
| Boot | Direct kernel boot (arm64 `Image` + initrd + DTB) for the tests' guests. **M8 phase B:** boot conventional arm64 disk images unmodified, through UEFI firmware (our EDK2 build, entered as an `Image`: the firmware configuration, loop 2) and their own bootloader; the page boots Debian's published image, or a disk of the user's own, unmodified that way (loops 3–4); the disk's changes or the whole disk go out and come back (loops 5–6) |
| Core | Rust compiled to wasm32 (the same crate builds natively for tests); host glue in TypeScript without a build step |
| Guest memory | **Layout A** (M0.5): one shared wasm32 memory, core state then guest RAM (≤ ~3.5 GiB). One lowering point for guest accesses in generated code; TLB tag bits 3–11 hold a memory index: RAM past memory 0 goes to spill memories, NUMA nodes for the guest ([docs/spill-memories.md](docs/spill-memories.md)) ([docs/architecture.md](docs/architecture.md)) |
| JIT | Gadget style (inline what pays, helper calls into the interpreter's code for the rest), blocks keyed by guest PA, loop regions with tier-up, exact step accounting, one code cache of 320 MiB of wasm flushed whole when full ([docs/jit.md](docs/jit.md)); what isn't compiled runs in the block interpreter, the same blocks decoded once into micro-ops ([docs/cpu.md](docs/cpu.md) "The block interpreter") |
| Determinism | Deterministic mode (time from steps) for tests and most benchmarks: every guest takes the same steps on every host and tier. Realtime mode for guest-timed work and interactive use |
| SMP | N vCPUs, one core, two modes: **deterministic round-robin** on one thread (tests; exact steps; virtual time = the steps of all vCPUs) and **parallel**, a worker per vCPU with its own core instance and function table, on one code cache the vCPUs share (each module compiled once; [docs/jit.md](docs/jit.md) "Sharing") (users, scaling; realtime only). `TLBI …IS` completes before the issuer's `DSB` returns; `IC` drops the code from the shared cache at once, and each vCPU's table catches up before its next block; DMB is a real fence in parallel JIT code; the core's guest-RAM accesses are atomics ([docs/platform.md](docs/platform.md), [docs/cpu.md](docs/cpu.md)) |
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
- **One VM per page**, under the JIT, realtime, parallel SMP. Debian 13 was the page's hardcoded
  machine at first; **since 2026-10-17 (the user, thinking of an early release) the page starts no
  disk image**: its machine is EDK2 with no disk, waiting for the user's (Open disk, a drop,
  `?disk=`), and the page names no distribution. Debian stays the tests' and benchmarks' guest
  (`?machine=debian`); `npm start` no longer downloads it (`images/build.sh debian` does). A
  preloaded image with a snapshot that loads with the page comes later, likely from our Arch
  Linux desktop guest.
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
- **Frontend stack:** Svelte 5 for the page (since 2026-10-17, the user's call: the Machines modal first, then the
  whole page), the rest of `web/` plain TypeScript; Chromium only. Svelte is compiled by `tools/serve.ts` and
  `tools/dist.ts` (as type stripping is), not a separate build. The page looks like a desktop application (a
  toolbar of Tabler's icons, its own dialogs: docs/frontend.md "The toolbar").
- **Public hosting:** M8 started without it (others clone the repo); since 2026-10-17 `npm run dist` makes a static
  copy and the user deploys it at `https://vm.tny.im` (Cloudflare Pages; docs/frontend.md "A static copy"). **No guest
  network in the first phase.**
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
- **B. Your own disk: boot an unmodified image, take the disk back** (done 2026-10-01; the
  user, 2026-09-30: before snapshots, the basic loop has to be right: load a disk into the VM,
  boot it, work, shut down, take the modified disk away). Images in scope: **Debian and Alpine
  only** (Alpine's UEFI cloud images). Loops 0–6; the firmware and what it needs is in
  [docs/firmware.md](docs/firmware.md), the page in [docs/frontend.md](docs/frontend.md)
  "Your own disk", numbers in `bench/boot/REPORT.md` "M8 phase B loop 3". What binds:
  - **Boot it unmodified through UEFI** (the user, 2026-09-30): **EDK2's ArmVirtQemuKernel**
    (BSD-2-Clause-Patent, `images/build.sh edk2` in Podman, reproducible) is entered like a kernel
    through our direct boot (no code flash, no reset vector; stock ArmVirtQemu requires fw_cfg)
    and runs the image's own bootloader (GRUB, Limine), which loads its kernel through the EFI
    stub: the standard path every arm64 distro image supports. **Not** a loader in the page that
    reads `/boot` and guesses the boot entry (rejected: not standardized, breaks with each
    distro's layout, takes the choice of bootloader away). The platform: **one CFI flash bank for
    EFI variables** (kept beside the overlay), the framebuffer outside `/memory`, a **minimal
    fw_cfg** (systemd credentials: the tests boot Debian unattended, the release page's Debian runs
    its first boot as on a regular machine; a NoCloud seed disk for Alpine's tests), the PL031,
    and **the DT stays** the guests' description (DT and ACPI measured the same; ACPI is out of
    scope). Debian boots only this way, in Chromium (docs/testing.md); the direct-kernel Debian
    boot, its tests and its benchmarks were dropped.
  - **Disk in:** a local file (the picker, a drop) or `?disk=<url>`, raw or qcow2 by its magic,
    with an overlay of its own keyed by name, size and modification time.
  - **Work and shut down:** the OPFS overlay; a clean power-off.
  - **Disk out,** two ways: **just the changes**, a qcow2 of the overlay's blocks (4 KiB clusters)
    with the base image as backing file, named and identified by its hash; or **the whole
    disk** as qcow2 or raw. **Changes in:** the same file loaded onto the same base (checked by its
    hash) brings them back, in a fresh profile too; it replaces the overlay and the variable store.
  - Leftovers (the chosen file isn't remembered across reloads, the firmware's setup screen, key
    latency, an unused ext4 reader): [docs/backlog.md](docs/backlog.md).
- **C. Parallel tracks**, each starting from its plan doc (written first where none exists):
  - Networking ([docs/plans/networking.md](docs/plans/networking.md)): the Ethernet gateway and the
    Tailscale backend are built (a VM reaches its tailnet and, through an exit node, the internet);
    left: **IPv6** (required), the card for Alpine. More backends besides Tailscale are wanted
    later behind the same gateway; our own client (a Rust wasm module on tailscale-rs's protocol
    crates: [docs/tailnet.md](docs/tailnet.md); done 2026-10-16: tailcat on the page, the VM as a
    tailcat server, the Tailscale control session and data plane) is the page's Tailscale client:
    0.49 MB Brotli to Go's 4.5, 2.2 times the throughput at 2.5 times less CPU per Mbit. The Go one
    left the page (2026-10-17); `net/tailscale` stays as a test fixture, and Go for development and
    CI. Its loose ends: [docs/backlog.md](docs/backlog.md) "Network". Proposed (2026-10-18):
    peer-to-peer rooms over WebRTC, with DERP as the fallback
    ([docs/plans/networking-p2p.md](docs/plans/networking-p2p.md)), and several network adapters per machine on
    connections kept by the browser, **done 2026-10-19**
    ([docs/network-adapters.md](docs/network-adapters.md): the connections' model and migration, adapters
    in the shape, the default route through the one that reaches the internet (IPv4 follows it within 10 s, IPv6 at
    once), the page's connections per adapter; a tailnet beside tailcat checked against headscale; loose ends in
    [docs/backlog.md](docs/backlog.md) "Several adapters' loose ends").
  - Graphics ([docs/plans/graphics.md](docs/plans/graphics.md)): **virtio-gpu 2D is done (G0 and
    G1, 2026-10-02).** The page's Debian draws through virtio-gpu from the firmware's menu on (the
    first pixel 7.5 s after the load instead of 19 s), at the page's size (CSS pixels, or device
    pixels with HiDPI), with damage only and the guest's cursor as the page's; snapshots keep
    working; guests without the driver keep the simple framebuffer. A console keeps the size it
    was born with (the kernel's fbcon can't resize) and sway takes a new size only when told to
    from inside (a custom mode), so live resize waits for an agent ([docs/plans/agent.md](docs/plans/agent.md)). A compositor
    must render with pixman: llvmpipe, even after the JIT's NEON work (71 ms a frame on 4
    vCPUs, ~12× native), is too slow, and draws after its page flip. **3D direction (the user,
    2026-10-09):** no software rendering or translation layers in the guest; OpenGL ES first,
    through Mesa's upstream **virgl** driver onto **our own virgl renderer on WebGL2** (the
    baseline), a WebGPU backend only where the browser has one, Vulkan (Venus, Zink) deferred
    (graphics.md §1, §18). **G2 is done (2026-10-09, graphics.md §19): the gate passed.** On a
    virtio-gpu with virgl and a null renderer, a sway frame costs the guest 6.6 ms of CPU against
    llvmpipe's 81 (60 frames a second against 28), and glcomp's ~1/190 of llvmpipe's work; Mesa
    is cheap, the kernel's submit path is what's left. **G3 is done (2026-10-09, graphics.md §20): 3D
    is the page's default where WebGL2 is.** Our virgl renderer on WebGL2 (TGSI to GLSL ES 3.00, caps
    from the browser) draws glcomp within 7 levels a byte of llvmpipe, and Arch's sway on GLES at 60
    frames a second on the Mac host's GPU (the null renderer's rate and guest CPU; 55 on SwiftShader).
    The page's tests pass with it; snapshots work while 3D is unused (`?gpu=2d` keeps the 2D path).
    **G4 is done (2026-10-10, graphics.md §21): breadth and correctness.** Firefox runs on 3D (WebRender and WebGL
    on virgl; scrolling real sites at 50–60 frames a second on the Mac's GPU; its start and page loads are the guest's
    CPU, the JIT track's), GTK4's GSK GL renderer draws every gtk4-demo demo, and **dEQP-GLES2 and GLES3's whole
    mustpass lists pass with no failure** (17,027 and 44,398 pass, the rest not supported, on SwiftShader), with a pass
    list as a test of its own (`scripts/ci-deqp.sh`); the menu has a 2D/3D choice. **G5** (proposed at graphics.md
    §21's exit, no kickoff): **dEQP on a real GPU is done** (2026-10-19, graphics.md §23: the whole lists on the Mac's
    M4, ANGLE on Metal, found four bugs of ours SwiftShader hid, fixed; 85 GLES2 and 129 GLES3 failures remain, all the
    GPU's: the filter switch near level 0, one invariance case); other platforms, GtkGLArea's offload and breadth (a
    desktop's compositor, Chromium in the guest) are open items in docs/backlog.md and graphics.md §7, with no handover.
    **Snapshots while 3D is in use are done** (built ahead of it, 2026-10-18 to 10-19, graphics.md §22: the
    renderer's state as data, its contents read back, BLOB frames in the file; refused only while a video decodes).
    On the desktop guest with sway, Firefox on WebGL and GTK4 running: 96 resources, 119 MB of 3D state stored as
    6 MB, read in 0.23 s of an 8.2 s pause (the rest is the guest's RAM); the load brings the session back. It also
    found that every snapshot of a machine over 2 GiB of RAM lost its top (fixed, plans/snapshots.md "The file").
  - Audio ([docs/audio.md](docs/audio.md)): **done (2026-10-12).** virtio-snd to an AudioWorklet over a shared ring the
    device worker writes, the guest's period clock paced by the worklet's consumption (the browser's output latency
    as ALSA's delay); the page's microphone opened on the guest's demand (`getUserMedia`, the browser's processing on,
    Raw microphone off). **Decisions (the user):** playback first, then capture; sound on by default (from the first
    click); Arch Linux ARM's kernel lacked the driver, so we built `virtio_snd` out of tree (a DKMS PKGBUILD,
    dropped when the desktop guest moved to arch.bens.haus's port, whose kernel has it). Debian, Alpine and the desktop guest (sway, Firefox, PipeWire) play under it, and
    Debian and the desktop guest record; a video's sound keeps time with its picture within -17 to +20 ms on the
    Mac's GPU, and sound costs the guest under 1% of its CPU. Snapshots taken while sound plays resume playing (a
    restored clock stands still until its vCPUs run). The user confirmed playback and recording by hand. The video's
    decode is the cost in the guest, not the sound (backlog: hardware video decoding); other loose ends are in the
    backlog too.
  - Video ([docs/plans/video.md](docs/plans/video.md)): **done (2026-10-14 to 10-15).** Hardware video decoding for the guest's
    players. **Decision (the user):** VA-API over virgl, decoded by the browser's WebCodecs (the V4L2/virtio-media route
    lost: Firefox's V4L2 path needs DRM PRIME frames no stock FFmpeg gives, plan §2). V0's gates passed: the guest's Mesa
    takes the caps, FFmpeg and Firefox decode through VA-API (Firefox with a small VA driver wrapper of ours in the
    desktop image), the host's rebuilt H.264 and VP9 streams decode exactly. V1 decodes on the page (VP9 everywhere,
    H.264 where the browser has it in hardware), frame for frame the guest's own decode. V2 measured Firefox on it:
    Sintel's VP9 shown at 87% of its frames against 14% decoded in the guest, A/V sync within ±45 ms, the host's decode
    path costing under 10 ms of pause; the rest is the guest's CPU. V3 offers H.264 where the browser decodes it only
    in software too (Firefox and mpv play it as from hardware). Firefox's cost and pacing measured (plan §8): steady
    playback drops almost nothing (V2's cost was Firefox's start), no pref helps, and the bursts while browsing are the
    guest's CPU and the host's synchronous JIT installs stopping every vCPU at once (since taken off the vCPUs by the JIT's compile worker, jit.md "Sharing"). Seeking,
    size changes, decoder errors and snapshots checked (a held picture written into planes the guest's decoder has let
    go of: plan §9); AV1 decoded on the host, exact in software and in hardware, film grain through webpc-va 2 (plan
    §10). **HEVC dropped (the user, 2026-10-15):** H.264, VP9 and AV1 cover what the web serves, Chromium on Linux has
    no HEVC decoder of its own, and VA-API's parameters would need every slice header rewritten (backlog.md).
  - Host integration: clipboard, dropping files into the guest (9p), pointer lock, keyboard
    layouts; USB devices from the user's computer through WebUSB and WebHID (an xHCI, a
    passthrough backend and an emulated HID device: [docs/usb.md](docs/usb.md)): **done (2026-10-18)**, the
    controller off unless a machine has it (new machines do), its tests' rigs in `scripts/ci-usb.sh`; checked on
    the user's devices (an RTL-SDR at its full rate, an FT232R, a wired Xbox controller); a built-in USB keyboard of
    ours on EDK2's USB stack gives the firmware and GRUB real keys on a machine with the controller. Isochronous
    transfers left out (the user: WebUSB protects the classes that use them); loose ends in backlog.md "USB".
  - Snapshots ([docs/plans/snapshots.md](docs/plans/snapshots.md)): **done (2026-10-01).** Save
    snapshot writes the running machine to a file the user keeps (Debian: 175 MB, the machine
    paused 1.4 s) and Load snapshot resumes it, in a fresh profile too, in 2.1 s instead of a 55 s
    boot; Suspend keeps it in the browser, and the next page load resumes it (0.8 s). The core
    saves and restores CPUs, devices and time (ABI 30, a state format version of its own: a
    snapshot survives core changes that don't change what is saved); the host adds RAM (the
    core's LZ) and the disk's changes, which a load puts in place of the local ones. A snapshot
    pins the disk it was taken on (phase B's identity: a chosen file's name, size and modification
    time, or a URL's path). A restored machine has empty TLBs, which Linux can tell by its step
    count ([docs/platform.md](docs/platform.md) "Snapshots"). Loose ends:
    [docs/backlog.md](docs/backlog.md) "Snapshots".
  - Remote disks (proposed, `M8-REMOTEDISK-HANDOVER.md`, [docs/plans/remote-disks.md](docs/plans/remote-disks.md)): a
    disk from another server read fast (a cache, a chunked image format hosted on Cloudflare R2 or Pages or any static
    host, OPFS persistence, concurrent reads, a boot's read trace), measured first (R0).
  - Disk I/O speed (a chosen `File` under an overlay): **done (2026-10-08).** One change shipped: the overlay
    reads and writes in runs (first writes of 1 MiB 6 → 212 MiB/s, reads of written data 17 → 358 MiB/s, `dd conv=fsync`
    4.9 → 20 MiB/s). The rest was dropped by measurement: Debian's boot from a chosen qcow2 spends 3.9% in file reads and
    6% in all requests (no cache, copy, limit or inflate work clears the 5% bar), `flush()` costs ~10 µs, and the screen
    stays within 22–33 ms of a flush under a continuous disk read, so no blk worker. Numbers: `bench/io/REPORT.md`.
- **D. Choosing and shaping machines:** **starts with machines as the unit (confirmed 2026-10-17, a cloud session first; done;
  [docs/plans/machines.md](docs/plans/machines.md))**: named machines stored in the browser (vCPUs, RAM, any number of
  disks, up to 16, read-only or read-write), managed in a modal (Svelte); overlays per base disk as named variants;
  disk sources from a URL, a file (remembered), a copy in OPFS (which can take an overlay in place or be written in
  place), blank, or a ramdisk emptied at every boot; several
  snapshots per machine kept in OPFS or downloaded, checked against the machine's shape (orphaned when the machine
  changes) and restored without destroying a disk's state (an overlay that moved on is forked, detected by a
  generation counter, not a hash); machine definitions exported and imported. **Built and tested in a cloud session
  (2026-10-17, loops L0–L5, machines.md §11), passed in the dev VM (every CI suite) and by the user by hand.** Then a preloaded image and snapshot
  loaded with the page (likely the Arch desktop guest, decision 1: a built-in machine, after remote disks' content
  identity), a catalog of hosted images (machine definitions) on top of phase B's disk in, and **the stable
  embedding API**, extracted from what the page ended up using (VM config to DTB and devices,
  CPU feature switches, devices, snapshots, network backends), with its docs.
- **Guest RAM past memory 0** (the user, 2026-10-18; **done 2026-10-19**, [docs/spill-memories.md](docs/spill-memories.md)):
  more wasm32 memories the guest sees as CPU-less NUMA nodes, NUMA balancing off through an SMBIOS credential, devices
  and snapshots across memories, one RAM value on the page up to 16 GiB. A spill access costs 2–19× a memory-0 one;
  the guest fills node 0 first and keeps it, and what a desktop user watched held its rate with 1.9 GB of busy tabs
  on node 1, so the JIT's inline second path waits in the backlog; the heap floor stays 1 GiB (the heap reaches
  ~600 MiB).
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
- **Guest RAM ceiling:** memory 0 holds at most 3 GiB less 1 MiB of RAM; past it, spill memories as NUMA nodes
  (done, up to 16 GiB on the page), 2–19× slower to reach (docs/spill-memories.md).
  Chromium gives no catchable error when host RAM runs out (the renderer is OOM-killed), so guest
  RAM is sized against host RAM up front (the page: [docs/frontend.md](docs/frontend.md) "Errors").
- **Linux arm64 has no V8 trap handler:** explicit bounds checks cost up to 27% there, which
  macOS and x86_64 users don't pay; our numbers on the dev VM are pessimistic for them.
- **Cross-origin isolation** (COOP/COEP) is required for `SharedArrayBuffer`; it constrains
  embedding and third-party resources.
