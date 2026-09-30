# Backlog (PLAN.md "M9")

Open items no milestone owns yet, by area. Pick one up when a milestone touches the area or a
measurement says it matters, and move it into that milestone's plan when it's scheduled. **Add to
this list rather than leaving TODOs in code** (the code marks a few with `ponytail:`).

## CPU and ISA

- **Unadvertised extensions the M4 has**, in case real workloads benefit: FP16 (scalar and
  AdvSIMD), DotProd, RDM, FHM, FCMA, JSCVT (JS engines use `FJCVTZS`), FRINTTS, BF16, I8MM, LSE2,
  RCpc, FlagM, SB, DIT, SHA512 and SHA3 (OpenSSL uses both; SHA3's `EOR3`/`RAX1`/`XAR`/`BCAX` speed
  up Keccak and are plain SIMD128 lowerings). Each needs handlers, corpus groups (the generator
  already knows how to avoid them), the ID fields, a decoder-sweep update, a `VmConfig.features`
  bit, and the rule: advertise only if faster than what guests do without it.
- **FEAT_RNG (`RNDR`, `RNDRRS`)** (the user, 2026-09-30): two system-register reads, fed in
  realtime mode from the host's `crypto.getRandomValues()` (a per-vCPU pool refilled by the
  host, as the console's rings are), and in deterministic mode from a seeded PRNG so step counts
  stay exact. `ID_AA64ISAR0_EL1.RNDR` = 1, a `VmConfig.features` bit, corpus coverage of the
  NZCV result (success sets 0000; an empty pool may fail with Z = 1, which guests retry). EDK2
  uses it when present (`RngDxe`, stack cookies: M8 phase B's QEMU runs log `ARM-RNDR`), and
  Linux seeds its CRNG from it at boot, before `virtio_rng` loads from the root filesystem (see
  "No `rng-seed` in the DT" below). Under UEFI it also turns on KASLR (same entry: measure it).
- **Self-hosted debug:** breakpoints, watchpoints and `MDSCR_EL1.SS` single step raise nothing
  (the registers are RAZ/WI). Needed for in-guest `gdb` hardware breakpoints and `ptrace` single
  step (kvm-unit-tests `debug-*`).
- **Spectre reporting:** advertise `CSV2_3` (needs `SCXTNUM_ELx`) or answer SMCCC 1.1
  `ARCH_WORKAROUND_*` as not required, so Linux says "Not affected" instead of "Vulnerable".
- **MMU:** per-ASID stashes of nG entries (the previous ASID's are dropped at a switch; Alpine's
  boot refills ~0.3M); ~0.3M of Alpine's misses are direct-mapped conflicts; no Device-memory
  alignment faults; no address-size fault for VAs past 40 bits with the MMU off (external abort);
  PRFM with a misaligned SP base faults; cache maintenance by VA to a device PA faults.
- **Arm AARCHMRS JSON:** its in-package notice is unread (`THIRD_PARTY.md`); read it only to
  generate decoder tables or coverage checks from it.
- **Corpus depth:** thin FP flag paths (8 `fp_scalar` tests raise Divide-by-Zero); add biased forms
  when touching FP again.

## Interpreter

- No decoded-block cache: each instruction is fetched through `Mem::host` and decoded again
  (`ponytail:` in `interp::step`); FP runs at a sixth of the integer rate (`FMLA`/`FMADD` always
  take the software FMA, vector FP goes lane by lane through `u128`); the MMU copy runs 35% slower
  than the flat one (every fetch through the TLB). None of it matters while the interpreter is the
  JIT's reference and fallback.
- `Mem::rmw` is a generic CAS loop; the JIT does LSE as single wasm ops. Matters again for M7's
  contention.

## JIT

- **Vector registers in locals** (NEON-heavy code; AES-CBC is latency-bound on V register
  stores and reloads).
- Helpers still on real paths: unmasking MSRs, ISB, CASP, exclusive pairs, LSE min/max,
  LD2–LD4/ST2–ST4, scalar `SHL`, `LD1`/`ST1` single structure, CRC32, the 8-bit PMULL/PMUL (unused
  by guests measured). None worth a loop alone.
- MSR left as helpers that end a block: DAIFClr, the regime, FP-control, SPSel and NZCV writes
  (Alpine: 0.66M MSR (register) and 0.15M MSR (immediate) helper calls). The differential test
  can't see an unmasking write done inline (no IRQs in its harness): only a distro boot's steps
  catch it.
- **CoreMark's gap to TCG (~70%)**: the store bounds checks V8 keeps on Linux arm64, register
  write-backs at block exits, call/return between small regions. Only for real programs.
- **Per-module eviction, coldest first,** instead of whole-cache flushes ([jit.md](jit.md)
  "Memory"). A Go build flushes about every 30 s per vCPU today, spending ~6% of CPU compiling.
  - **What it would do:** evict the modules unused for the longest time, unlink what chains to them,
    null their table slots and reuse them from a free list.
  - **FIFO by install order was built and dropped** (branch `fifo-evict-attempt`, local, not pushed).
    Under the 4-vCPU Go load of `bench/stress` it collapsed the guest within 3 min:
    - ~1200 MIPS fell to 4–100;
    - the guest reported hard and soft lockups (97 s);
    - single `vm_run_cpu` calls ran up to 112 s;
    - the renderer grew to 6.8 GB.
  - **Why FIFO failed:** the oldest code is the hottest (Go's runtime, compiled first). Dropping it
    cascades through `linkers` to most of the live code, and modules emptied by the cascade kept
    their bytes until their turn. So the budget stayed full and every install evicted again.
  - **What a coldest-first design needs:**
    - a cheap use signal per module, since blocks run inside V8 without telling the core. For
      example: a word per module that the core or the host sets on dispatch or jump-cache misses and
      a sweep clears (a second-chance clock), or the sampling profiler's PCs;
    - modules released as soon as all their regions are dropped;
    - `drop_key` removals from `pages` and `pending` that don't scan per key.
  - **Worth keeping from that branch:**
    - the explicit `env.jit_release(slot, n)` host signal, in place of `web/vm.ts` detecting a
      flush by slot numbers restarting;
    - `drop_key` removing the keys that `linkers` drops from `pages` too, which invalidation leaks
      today.
  - **Measure it against the flush under the Go load.**
- **Share compiled modules across vCPU workers:** each worker compiles its own copy of the guest's
  code (its own cache, table and instances), ~4× duplication on 4 vCPUs: 615K regions and 294 MB of
  wasm in total after 8 minutes of a mixed load (~150K and ~72 MB per worker), ~10× that in V8
  memory. Posted `WebAssembly.Module`s share V8's code between workers; a shared compile cache
  keyed by physical address and mode would compile each region once. Cross-vCPU invalidation is the
  hard part.
- **Cut V8's per-region overhead:** ~10× the module's bytes, half of it metadata (~2.4 KB of
  PartitionAlloc per region). Batch the tier-up regions into fewer modules (extend the entry below:
  ~561 modules of one function in Alpine), and check whether superseded or invalidated blocks'
  modules stay alive through sibling functions (a module's code is freed only with all of its
  functions' instances).
- **Unexplained ~10 GB samples** in the Go-load runs with the flush and the GC nudge (2 of 4 runs,
  one sample each near the end; `go-cap-nudge*` in `bench/mem/results/summary.json`): the wasm code
  mapping jumps by ~6 GB in under 20 s while compile volume is unchanged. Not seen with 8 s sampling.
  Measure with V8's own counters before trusting the median.
- **JIT memory in long sessions** (the user, 2026-09-30, a Go compile over the tailnet, a 6 GB tab):
  understood and bounded by a byte budget with a flush ([jit.md](jit.md) "Memory"); what's left is
  the items above. The Tailscale client's own memory (a 27 MB wasm Go runtime in its worker)
  wasn't measured: it needs the headscale test tailnet.
- **Compiling off the vCPU thread:** measured and not built ([jit.md](jit.md) "Tried and not
  kept"); revisit with a GUI guest in M8 (latency).
- **A fixed-size memory** so V8 loads the bounds once per function ([v8.md](v8.md)): needs the
  memory sized at creation, our own allocator over a reserved heap, a host ABI to place RAM, and
  JIT modules importing exact limits. Worth a placement-averaged Chromium measurement if the
  bounds-check tax (up to 27% on Linux arm64, none on macOS/x86_64) becomes the lever left.
- Tier-up regions get a module each (~561 in Alpine); batching them is untried.
- kvm-unit-tests `timer` runs slower under the JIT than interpreted (short blocks around timer
  polls).
- Buildroot's warm boot under the JIT has a 10× wider IQR than the interpreter's (V8 tiering
  hundreds of modules at different points, presumably).
- Blocks are formed twice (for the cold path's length on first sight, and at compile time).
- Invalidation is per 4 KiB page, and `IC IALLU` drops everything.

## The core with `simd128`

Off since the pinned nightly miscompiled the JIT's register-mask code three times; nothing needs
it (the JIT's SIMD comes from our encoder; the interpreter is as fast without it: 138.1 vs
138.5–138.8 MIPS). What's known (work files in `bench/results/local/m55`):
- *Case 1, reduced:* a `[u8; 32]` compared lane-wise into a `u32` mask gives `0x24929249` instead
  of `0x92492492` with `+simd128`; in IR, `icmp eq <32 x i8>` + `bitcast <32 x i1> to i32` under
  `llc -mattr=+simd128` puts lanes 0–15 in bits 31:16. Root cause: the WebAssembly backend's
  `performBitcastCombine` combines 16-lane chunks in reverse order (LLVM's own `simd-bitmask.ll`
  expects the swapped code; `llc` 22.1.8 and 23 miscompile). LLVM 23's middle end (the nightly of
  2026-08-06, rust-lang/rust#158734) started vectorizing our Rust into the pattern. **Reported as
  llvm/llvm-project#226741.** `emit::Func::plain` now uses bit masks instead.
- *Cases 2 and 3* (region register states lost a write-back / back-edge loads): probably the same
  pattern, unconfirmed.
- **To turn it on** (a measured need, or a toolchain that carries the fix): rebuild the M5 step
  8.1/8.2 revisions with `+simd128` and check for the pattern (`bitcast <32|64 x i1>` in
  `--emit=llvm-ir`; two `i8x16.bitmask` + a 16-bit shift in `--emit=asm`); add a CI scan for the
  pattern until the fix is in the pinned toolchain; then pass the corpus, `jit-diff`, lockstep and
  the Node boots with it and compare the interpreter's MIPS. Until then any toolchain bump leaves
  `simd128` off.

## Platform and devices

- **Booting conventional arm64 disk images unmodified:** now M8 phase B (PLAN.md §3: through
  UEFI firmware and the image's own bootloader; disk in and out). Until then a distro's kernel
  and initrd are extracted from its image ahead of time (`tools/debian.ts`). Loop 0's findings
  and the design: [plans/uefi.md](plans/uefi.md).
- **ACPI** (only if an ACPI-only guest comes into scope: Windows, an enterprise distro that won't
  boot from a DT). The DT stays the machine's description (plans/uefi.md "DT or ACPI"); the path
  that keeps AML out of the core is EDK2's DynamicTablesPkg building the tables from our DT, plus
  AML for the virtio-mmio transports (its parser doesn't cover them) or a move to virtio-pci; the
  screen then needs a firmware GOP.
- The timer, GIC and PL011 tests have no hardware oracle; a GICv3-free subset of `timer.c`
  (ISTATUS, TVAL, CNTKCTL traps) could run on hvf.
- virtio-console has no host input path (its receive buffers are held forever), so a guest's
  `hvc0` getty is output only. Console input goes to the PL011 (M8); a `MessagePort` in the
  console's spec, as virtio-input has, is the shape if `hvc0` is ever wanted (it would skip the
  PL011's trap per byte).
- **No `rng-seed` in the DT:** Linux's crng initializes only once `virtio_rng` loads from the root
  filesystem (Debian: 26 s into a 31 s boot; `systemd-random-seed` waits for it) and KASLR is off
  ("lack of seed"). `/chosen/rng-seed` (and `kaslr-seed`) from the host's CSPRNG in realtime mode;
  deterministic mode would need a fixed seed (a step-count change). **Measure KASLR before
  turning it on:** on the UEFI oracle (QEMU TCG, M8 phase B loop 1) Debian reached
  `graphical.target` in 12.3 s without seeds, 10.6 s with `rng-seed` alone, and **22.1 s with
  `kaslr-seed`** too (kernel and userspace alike). So the RNG seed is a win, and KASLR may cost
  our JIT and TLB as it cost TCG. Under UEFI the EFI stub randomizes the kernel whenever the
  firmware has an RNG (`EFI_RNG_PROTOCOL`: EDK2 gets one from RNDR, above), so RNDR brings KASLR
  with it unless measured and handled (`nokaslr` isn't ours to pass: GRUB's command line).
- virtio: `EVENT_IDX` not offered (do it when an I/O benchmark shows notify exits or interrupts
  matter); ConfigGeneration always 0 and no host API to change config space under a running driver
  (console resize, capacity change, net link state).
- virtio-blk over HTTP: one synchronous XHR per request, no cache, merging or concurrency; batch,
  cache or go async when an I/O benchmark says so. qcow2: no merging of contiguous clusters into
  one request.
- Overlay: no DISCARD/WRITE_ZEROES, no compaction of leaked slots, no quota handling (OPFS errors
  come back as `IOERR`), the base identified by path and size only, no export or import (M8
  phase D; the reset is `removeOverlay`).
- net: no offloads (`CSUM`, `GSO`, `MRG_RXBUF`), no `CTRL_VQ`, one queue pair; frames from a page
  adapter can't be deterministic. The real backends are in [plans/networking.md](plans/networking.md).
- 9p: an in-memory tree only (OPFS or an HTTP-served tree, as v86's lazy filesystem, are the
  candidates); no xattrs/ACLs; `qid.version` 0 (only `cache=none` coherent); readdir offsets are
  entry indices; whole-second timestamps.
- Input: US PC layout only, no pointer lock (relative mouse), no multitouch; events injected in
  deterministic mode land when they land. Past 1024 queued events the oldest are dropped, so
  anything that types a long string (a test agent, a paste into the screen) must pace itself.
- Framebuffer: a scan of the whole buffer per animation frame to find the changed rows (~0.4 ms
  at 1024×768, on the machine worker), x8r8g8b8 only, fixed size; virtio-gpu's damage rectangles
  would replace the scan ([plans/graphics.md](plans/graphics.md)).
- The TS backends are tested through boots; a Node test with a bare-metal virtio guest would be
  cheaper when they grow (blk).

## Parallel SMP (M7; measurements in `bench/boot/REPORT.md` "M7 loop 8")

- **One copy of compiled code for all vCPU workers:** each worker compiles what it runs (~200 ms of
  compile per vCPU per Alpine boot, ~35 ms in the userspace churn phase: small), but also holds its
  own machine code, which may matter for kernel-heavy phases' footprint (unmeasured: the VM has no
  PMU). Sharing needs position-independent links (through the jump cache) so one
  `WebAssembly.Module` can be instantiated in every worker.
- **The remaining DSB waits** (~3K per userspace run on 4 vCPUs, 20–60 µs each: same-ASID
  targets, and all-ASID or kernel-range TLBIs) wait for the target's chunk boundary. A 4096-step
  chunk in parallel mode cut the average from 100 to 65 µs and polling before sleeping to 55 µs,
  before the ASID filter made both moot; ending a target's chunk from outside would need a memory
  check in the JIT's hot path.
- **Pair atomics:** CASP is the 5th most called helper even on one vCPU (SLUB's `cmpxchg128`,
  ~300K per Alpine boot, ~30 ms); the LSE stack stress takes 2.65 s against 0.4 s on the M4.
  Inline it if a workload shows it.
- **WFE sleeping:** WFE yields (120K per vCPU in 7 s of churn on 4 vCPUs, ~0.1 s); sleep on the
  event word only if a workload shows yields costing.
- **Parallel `make`** as a scaling workload (the image has no toolchain yet).
- **A default vCPU count for users:** the page uses `min(4, cores − 2)` (web/app/machine.ts);
  `bootVm`'s `ncpus` still defaults to 1. Telling the user that a host's efficiency cores make N
  above its performance-core count scale poorly (this host: 4 P + 6 E) belongs with M8 phase D's
  settings and embedding API.
- **The page's memory check** is a rule of thumb (`hostMemoryGiB`: RAM + 1 GiB + 0.3 GiB per
  vCPU, from one host's RSS) against `navigator.deviceMemory`, which Chromium caps at 8 GB and
  rounds down; it can't see what else the host is running. Revisit with RAM settings (phase D) or
  if a user's tab gets killed.
- **Snapshots in parallel SMP** (M8): stop every vCPU worker at a chunk boundary (STOP, all
  `OUT`), with every maintenance queue drained and no CPU_ON request pending, before saving;
  round-robin needs nothing new.
- **Hours-long whole-platform stress** (repeated parallel boots and workloads for hours): deferred
  by the user (2026-09-28) to a later milestone, once more virtio devices and integration features
  exist, when such a run is likelier to catch non-obvious platform-wide issues.

## The page (M8 phase A; [frontend.md](frontend.md))

- **The user's own pass** (after phase A's exit, 2026-09-29): "I like what I see", with four
  rough edges, handled in M8 loop 8: the Keys menu had only Ctrl+Alt+F1 and F2 (now F1 to F12); a
  Restart once failed with "disk in use" (now a Web Lock orders the overlay's hand-over and
  restarts don't overlap: [frontend.md](frontend.md) "Overlay hand-over"); `timer.bin` failed
  under load (hardened: [testing.md](testing.md) "Bare-metal tests"); Debian didn't find its root in Firefox (recorded
  under "Tests and tools", not fixed). Left from it: whether the user's failure was the
  overlapping restart that loop 8 reproduced or a browser releasing a lock before the handles
  (a `NoModificationAllowedError` in the message would say the latter; then a short bounded
  retry after the lock is the fix); the in-use message comes after a 10 s wait now, with the page
  in Loading meanwhile (a "waiting for the disk" line would say why).
- **Clipboard for the screen:** paste into tty1 (typed through virtio-input, paced: its queue
  drops past 1024 events) and copy from fbcon; only the serial terminal has both (xterm.js).
  Phase C, host integration.
- **Keyboard layouts** other than US: the page maps `KeyboardEvent.code` as a US PC keyboard and
  Debian's keymap is US; another layout needs the guest's keymap set to match (loadkeys, or
  `vconsole.keymap=` on the command line). Phase C, host integration.
- **The Keyboard Lock** in full screen is checked by hand only: headless Playwright's keys
  bypass the browser's shortcuts, so no test sees Ctrl+W reach the guest.
- **Settings:** vCPUs and RAM come from `?ncpus=` and machine.ts, no UI (phase D, with the image
  choice and the embedding API).
- **The ready marker is a per-machine regexp** over the serial output (Debian: agetty's
  `login: ` at a line's start). A guest that prints after its prompt, logs in automatically or
  has no serial getty would need its own; a guest-side signal (a byte on a port the page owns, a
  systemd unit writing to a device) would be exact. Revisit with image selection (phase D).
- **No boot-to-login benchmark case:** the page's time to `running` is measured by ad-hoc
  drivers and the end-to-end test (bench/boot/REPORT.md "M8 loop 6"). Snapshots' resume time needs
  a tracked baseline: add a `page_debian` case (page load to `running`, fresh profile) then.
- **Boot time is the page's biggest cost** (~30 s to a login): snapshots (a phase C lane, [plans/snapshots.md](plans/snapshots.md)).

## Network (M8 phase C, networking lane; [plans/networking.md](plans/networking.md), [frontend.md](frontend.md) "Network")

- Left from N5: the Alpine `apk add` smoke test (the test tailnet's peer is now an exit node, so
  only the Alpine image with a card is missing), IPv6, Buildroot's N3 boot and its Rust twin. The details and the order are in M8-PHASEC-NETWORKING-HANDOVER.md.
- The Debian tests (`net-guest`, `page-network`, `net-tailnet`) take ~4 min: they run in `scripts/ci-net.sh`, not `scripts/ci.sh`.

## Tests and tools

- **Firefox and Safari compatibility pass** (moved out of M8 by the user, 2026-09-28; Chromium
  stays the target): the user checks Firefox by hand (never automated here); WebKit could run
  through Playwright. Matters most once the page is publicly hosted. **Found so far (the user's
  check, 2026-09-29):** in Firefox the core runs and the kernel boots, but Debian doesn't find its
  root filesystem and drops to the initramfs emergency shell, so /dev/vda (virtio-blk) doesn't
  work there. Unverified suspects: the virtio-blk backend's disk path in the device worker
  (range reads by synchronous XHR in a worker with `responseType = 'arraybuffer'`; qcow2's
  compressed clusters through `DecompressionStream`), the overlay's OPFS sync access handles in
  a nested worker (and now its Web Lock), or the device worker's doorbell (`Atomics.waitAsync`
  on shared memory). The serial log (Save serial log) from Firefox would show whether virtio-blk
  probed at all and what the first failing request was.
- LTP: only the syscalls subset; the loop-device tests (`getdents01`, `rename01`) and other areas
  need `mkfs` tools, a scratch disk and more RAM. kselftests: not `fp` (minutes of stress) nor the
  generic suites.
- `coremark_vm_jit`: pass a fixed iteration count through init's arguments so a run can't fall
  under CoreMark's 10 s rule.
- The PC-sampling profiler samples once per chunk (32K steps).
- `performance.mark`/`measure` around compile, instantiate, device I/O and boot phases.
- `core/fuzz`: `Mismatch::key` is dead code in the libFuzzer target build (a warning, not in CI).
- Guest images: `images/build.sh alpine` can't run on the arm64 VM ([images.md](images.md)).
- `images/Containerfile` and `images/alpine/user/webpc-user.start` still cite PLAN.md sections
  from before the docs moved; they're image inputs (editing them makes the images stale), so fix
  the comments with their next rebuild.
