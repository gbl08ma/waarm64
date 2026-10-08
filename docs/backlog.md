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

- **A compile threshold that follows the code cache's pressure** (the user's suggestion, 2026-10-09):
  500 suits Chromium in Debian (50 overflowed the 160 MiB budget every render) but makes Alpine's
  hot phases 1.5–6% slower than 50 (`bench/boot/REPORT.md` "M8: the block interpreter, and threshold
  500"). Start low and raise it as the live wasm bytes near the budget or after a flush, lower it when
  there's room and much is interpreted; decided where blocks report (`jit::Cache::miss`, under the
  lock already), so it costs nothing per dispatch; guest steps don't depend on it.
- **The block interpreter's caches** ([cpu.md](cpu.md) "The block interpreter"): one per table, so
  four vCPUs decode the same code four times; the 2M micro-op arena starts over when full (6–8
  times a Chromium render over 4 tables: most of its ~3M decodes, ~1–2% of the time by estimate).
  Candidates: drop the older half of the arena instead of all of it; one store the tables share.
- **More micro-op handlers:** FP and SIMD loads and stores (memcpy), exclusives and LSE atomics,
  EXTR, BFM run generically through `exec`; count the generic ops on a real workload first. FP itself
  runs at a sixth of the integer rate (`FMLA`/`FMADD` always take the software FMA, vector FP goes
  lane by lane through `u128`). Tail-call dispatch (`become`, `+tail-call`) as an A/B on top.
- The reference interpreter (`interp::steps`, `VmConfig.jit` 0) still fetches and decodes each
  instruction; the MMU copy runs 35% slower than the flat one. It only runs the interpreter-only
  tests and benchmarks now.
- `Mem::rmw` is a generic CAS loop; the JIT does LSE as single wasm ops. Matters again for M7's
  contention.

## JIT

- **llvmpipe under the JIT** ([plans/graphics.md](plans/graphics.md) §16): sway compositing
  through Mesa's software GL kept four vCPUs at ~54% for ~3 frames a second at 1376×762 (pixman:
  4–8%). Profiled 2026-10-08 with a compositor-like GLES load (`images/alpine/gl`): ~95% of the
  rasterizer's time was helper calls for NEON the JIT didn't inline (ZIP/UZP, LD1 of a lane, half
  precision FCVTL/FCVTN, FP compares, FRINTI, FMLA/FADD with zero lanes); with those inline the
  frame is 15.6× faster in Chromium on 1 vCPU (6,936 → 445 ms) and 18.6× on 4 (1,859 → 100 ms:
  10 frames a second), ~17× and ~14× native (`gl_llvmpipe_jit`, `bench/boot/REPORT.md` "M8:
  llvmpipe"). Left: what the inline code costs (vector registers in memory, below), and sway itself
  on the page again (the user's manual check).
- **Per-module eviction, coldest first,** instead of whole-cache flushes ([jit.md](jit.md)
  "Memory"). With the shared cache a 4-vCPU `go build` loop flushes about once in 5 minutes; a
  larger working set (a browser in the guest) is where this counts again. A flush also has every
  table catch up on the new epoch's modules.
  - **What it would do:** evict the modules unused for the longest time, unlink what chains to them,
    null their table slots and reuse them from a free list.
  - **FIFO by install order was built and dropped** (branch `fifo-evict-attempt`, local, not
    pushed). Under the 4-vCPU Go load of `bench/stress` it collapsed the guest within 3 min: ~1200
    MIPS fell to 4–100, the guest reported hard and soft lockups (97 s), single `vm_run_cpu` calls
    ran up to 112 s, the renderer grew to 6.8 GB. The oldest code is the hottest (Go's runtime,
    compiled first): dropping it cascades through `linkers` to most of the live code, and modules
    emptied by the cascade kept their bytes until their turn, so the budget stayed full and every
    install evicted again.
  - **What a coldest-first design needs:** a cheap use signal per module, since blocks run inside
    V8 without telling the core (a word per module that the core or the host sets on dispatch or
    jump-cache misses and a sweep clears, a second-chance clock; or the sampling profiler's PCs);
    modules released as soon as all their regions are dropped; `drop_key` removals from `pages` and
    `pending` that don't scan per key.
  - **Worth keeping from that branch:** the explicit `env.jit_release(slot, n)` host signal, in
    place of `web/vm.ts` detecting a flush by slot numbers restarting; `drop_key` removing the keys
    that `linkers` drops from `pages` too, which invalidation leaks today.
  - **Measure it against the flush under the Go load.**
- **`vm_run_cpu` calls of 2 to 4 s under a heavy load** (2026-10-03, the 4-vCPU `go build` loop of
  `bench/stress` with `--guest-cmd`, Debian, Chromium in the dev VM): with the cache flushing every
  ~14 s per vCPU and with one flush in 300 s alike; one vCPU peaked at 0.77 s. A chunk is bounded
  by its step budget, so a call that long is a synchronous compile of a very large batch module (V8
  on the vCPU's thread), a GC pause (the 256 MiB nudge after a flush can't be all of it: it happens
  without flushes), or a stall worth fixing (a lock, a DSB wait, an `Atomics.wait`). Time the
  compile, the instantiation and the run inside the call (the liveness block has room for it):
  harmless, or a latency problem a GUI guest would feel.
- **Transfers that still leave a function** (the userspace benchmark's remaining lever:
  `bench/boot/REPORT.md` from "M8: where the userspace benchmark's time goes"; re-profile with
  `bench/boot/userprof.ts` before and after). Per 1000 instructions in Lua and SQLite: 27 to 37
  direct transfers within a page and 10 to 14 to a successor compiled later (both into a block that
  heads another function), 15 to another page by its VA, 10 to 15 returns, 12 to 24 other indirect
  branches. They leave because the target was compiled in **another batch**: a shared callee is hot
  long before its callers. Tried: copies of compiled callees in callers (lost), a region entered at
  more than one block (measured, ~1% at most): [jit.md](jit.md) "Tried and not kept". Not levers in
  that profile: TLB misses (~1% of a phase), the remaining helpers, the core's compiler (under 1%
  outside the boot).
- **The vector FP fast paths' lane checks** (llvmpipe's shaders; `bench/boot/REPORT.md` "M8:
  vector registers in locals"): with the V registers in locals, each inline vector FP
  instruction's cost is mostly its check that every lane is on the fast path, reduced to an i32
  per instruction (`all_true`: `uminv`, a move to a general register, a compare before the `if`;
  ~18% of the hot shader's samples land on the move). Ideas: one check for a run of FP
  instructions, its fallback re-running the run from saved inputs; cheaper masks (float compares
  on `|x|` instead of exponent arithmetic). The same shader's guest loads spend ~11% on the TLB's
  tag load.
- **Cold, kernel-heavy phases** (boot, process churn, shutdown: 10 of the userspace run's 22 s) are a
  third Liftoff code and 11 to 18% V8's compiles on the vCPU's thread. **Compiling off the vCPU
  thread** was measured and not built ([jit.md](jit.md) "Tried and not kept"); revisit with a GUI
  guest (latency).
- **The transfer cache's costs in kernel-heavy phases** ([jit.md](jit.md) "Linking"): a miss costs
  a call to the shared miss function, a TLBI by VA a 16 KiB scan (the boot ~1% slower with it).
- **The shared cache's leftovers** ([jit.md](jit.md) "Sharing"):
  - one vCPU pays 1–2% (Alpine's boot +1.8%, userspace +1.2%): partly each module's bytes copied
    for the catch-up even when the table is the only one (a lone table could take them instead);
  - a worker installs every module of the epoch, those its vCPU never runs too (an instance and
    table entries each: small, not measured);
  - a module's bytes stay in the core's heap until every table has it, and a vCPU that never runs
    (offline) holds them until the next flush (at most the 160 MiB budget);
  - the cache's lock is taken on every jump-cache miss and held while a batch is planned and
    emitted (V8 compiles outside it); contention wasn't measured.
- **V8's per-function overhead** ([jit.md](jit.md) "Memory"): ~8.5 KB per synthetic function of
  ~600 wasm bytes, a third each in PartitionAlloc, code and V8's heap (the instance's exports,
  which every function needs for the table). Left to check: whether superseded or invalidated
  blocks' modules stay alive through sibling functions (a module's code is freed only with all of
  its functions' instances), which larger modules make likelier.
- **Unexplained ~10 GB samples** in the Go-load runs with the flush and the GC nudge (2 of 4 runs,
  one sample each near the end; `go-cap-nudge*` in `bench/mem/results/summary.json`): the wasm code
  mapping jumps by ~6 GB in under 20 s while compile volume is unchanged. Not seen with 8 s
  sampling. Measure with V8's own counters before trusting the median.
- **The core's own memory is growable** ([abi.md](abi.md) "A fixed-size memory"): exact limits
  there need an allocator of our own over a region the host gives the core. The core's code is 8 to
  19% of the userspace benchmark's hot phases (`bench/boot/REPORT.md` "M8: the core's share of the
  userspace profile"), so a few percent of a phase at most, and only where wasm bounds checks are
  explicit (Linux arm64). Not worth the allocator now.
- Helpers still on real paths: unmasking MSRs, ISB, CASP, exclusive pairs, LSE min/max,
  LD2–LD4/ST2–ST4, LD1R, scalar `SHL`, CRC32, saturating add and subtract
  on 32- and 64-bit vector lanes, the 8-bit PMULL/PMUL (unused by guests measured). None worth a
  loop alone.
- MSR left as helpers that end a block: DAIFClr, the regime, FP-control, SPSel and NZCV writes
  (Alpine: 0.66M MSR (register) and 0.15M MSR (immediate) helper calls). The differential test
  can't see an unmasking write done inline (no IRQs in its harness): only a distro boot's steps
  catch it.
- **CoreMark's gap to TCG (~70%)**: the same transfers between blocks (above) and the store bounds
  checks V8 keeps on Linux arm64. Don't fit the design to it.
- kvm-unit-tests `timer` runs slower under the JIT than interpreted (short blocks around timer
  polls).
- Buildroot's warm boot under the JIT has a 10× wider IQR than the interpreter's (V8 tiering
  hundreds of modules at different points, presumably).
- Blocks are formed twice: decoded for the block interpreter on first sight (which gives the cache
  their length) and again at compile time.
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

- **The firmware configuration** (loop 2): fw_cfg has no DMA interface (ramfb, a firmware GOP,
  needs it: plans/uefi.md "Graphics in the firmware"), no SMBIOS or other standard items; the
  flash bank's array-mode reads go through `vm::Io` one instruction at a time (fine for a store
  read a few times a boot: measure if a guest reads it in a loop); no lock state (every block
  unlocked). Between EDK2's boot manager and GRUB's menu Debian retires 5.4G steps in ~3 s in
  Node (Alpine: 0.2G): **not a busy wait** (loop 3): PC samples sit in one LZMA range decoder, most
  likely Debian's GRUB unpacking its compressed core image (bench/boot/REPORT.md "M8 phase B
  loop 3"); nothing to make idle.
- **EDK2's terminal modes** (loop 3): `images/build.sh edk2` patches TerminalDxe to offer only the
  80×25 text mode, because GRUB takes the largest (240×56) and asks the terminal to resize with
  `CSI 8;r;c t`, which xterm.js doesn't do: the menu was lost on the page's 80-column terminal.
  A virtio-gpu machine has a GOP now and its GRUB draws on the screen (`gfxterm`), so the patch matters only where the
  firmware has no display: `?display=simple` and the simple-framebuffer machines, whose GRUB menu is still on the
  serial terminal. **Remove it when no machine boots through UEFI without a virtio-gpu** (not re-checked: what
  ConSplitter offers the serial terminal next to a GOP without the patch).
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
  matter); the host can change config space under a running driver since ABI 31
  (`Devices.changeConfig`, docs/abi.md), but only virtio-gpu's display events use it: console resize,
  capacity change and net link state don't yet.
- virtio-blk over HTTP: synchronous XHRs, no cache or concurrency (a request's qcow2 clusters are
  read in merged ranges, nothing is merged across requests); batch, cache or go async when an I/O
  benchmark says so. qcow2's compressed clusters are inflated one at a time on the reading thread.
- Overlay: no quota handling (OPFS errors come back as `IOERR`), the base identified by path and
  size only.
- blk DISCARD/WRITE_ZEROES ([devices.md](devices.md)) is the page's only: offering it to the
  tests' guests moves every writable guest's step count (the driver reads the longer config) and
  needs the native twin (`core/tests/common` `Overlay`) to take the requests. One segment per
  request (`max_discard_seg` 1); a compaction copies synchronously in the device worker (at most
  the blocks freed, so a trim of GBs can hold the guest's I/O for seconds). The page's Debian
  doesn't mount with `discard`: the user runs `fstrim`, or waits for `fstrim.timer`.
- net: no offloads (`CSUM`, `GSO`, `MRG_RXBUF`), no `CTRL_VQ`, one queue pair; frames from a page
  adapter can't be deterministic. The real backends are in [plans/networking.md](plans/networking.md).
- 9p: an in-memory tree only (OPFS or an HTTP-served tree, as v86's lazy filesystem, are the
  candidates); no xattrs/ACLs; `qid.version` 0 (only `cache=none` coherent); readdir offsets are
  entry indices; whole-second timestamps.
- Input: US PC layout only, no pointer lock (relative mouse), no multitouch; events injected in
  deterministic mode land when they land. Past 1024 queued events the oldest are dropped, so
  anything that types a long string (a test agent, a paste into the screen) must pace itself.
- **A real keyboard driver in EDK2** (instead of the screen's keys going to the serial console): EDK2 has no virtio-input driver (`OvmfPkg` has none; ArmVirt's keyboard is the PL011 console), so on a virtio-gpu machine GRUB's menu, which takes the GOP, would otherwise ignore keys typed on the screen. Today the page works around it: until the guest's virtio-input keyboard has its DRIVER_OK (`Vm.deviceStatus` → `keyboard {live}`), `attachInput`'s `text` option sends the screen's keys to the serial console as a terminal would (`terminalBytes` in web/input.ts; `tests/page-grub-screen.test.ts`; graphics.md §12). The limits: only keys that have a terminal encoding reach the firmware (no key-up, no modifiers alone), and the page must know when the guest takes over. A DXE driver for virtio-input (or USB-HID over a virtio-mmio-less path) in `images/build.sh edk2` would give the firmware the keyboard directly and let that special case go; it needs a driver written for the mmio transport (none to port from OvmfPkg) and an EDK2 rebuild.
- **Guests that composite with llvmpipe show stale frames on virtio-gpu** (graphics.md §16; devices.md): the
  rasterizer threads draw after the transfer. `WLR_RENDERER=pixman` in the guest avoids it. A display mode that
  samples the scanout's memory at each refresh and holds a flipped buffer until it is stable would hide it for
  unmodified guests: not built (a full compare per refresh; build it if GL compositors become fast enough to use).
- **virtio-gpu's flush pacing counts a firmware's flushes too**: EDK2's GOP waits for every reply, so its `Blt`s
  complete 60 a second after the first. Not seen to matter (GRUB's menu, the boot's time to `running`); a guest that
  waits needs no pacing, if a way to tell it from one that floods turns up.
- **A key's glyph is ~13 ms later on the virtio-gpu screen than on the simple framebuffer** (53 against 39 ms in
  headless Chromium on the dev VM; bench/gpu/REPORT.md "G1 exit"). Not the device: the flush arrives 12 ms after
  the key and is drawn within 1 ms; the time goes between `putImageData` in the device worker and the page seeing
  the canvas. The device worker is nested in the machine worker and Chromium gives a nested worker no
  `requestAnimationFrame`, so it draws outside animation frames (the simple framebuffer is drawn inside the machine
  worker's): the suspect, not proven (a standalone page shows no penalty). Next: the same measurement on a real GPU
  (the Mac host; the dev VM composites in software), then a device worker the page creates (a top-level worker has
  animation frames; moving blk off that thread and G3's GPU worker want the same change) or drawing from the
  machine worker out of shared memory.
- **A transfer costs ~0.7 ms a megapixel in Chromium** (`flush_cost`: 1.5 ms at 1080p, 2.6 at 1440p, 5.9 at 4K), all of
  it the swizzle to RGBA on the device worker: fine for a compositor at 1080p, a quarter of a frame at 4K HiDPI. If
  that matters: copy the bytes raw (`set`, ~4 times faster) and swizzle in the draw (a WebGL or WebGPU texture
  upload takes BGRA as it is: bench/gpu/REPORT.md).
- **virtio-gpu, not built or not measured in G1:** GNOME, KDE and Xorg sessions (sway is: graphics.md §17); a page test
  of the pointer through a letterboxed screen (checked by hand with sway); an overlay for a guest that warps its
  cursor (`MOVE_CURSOR` away from the pointer: none seen); sizes beyond 4088 pixels a side (a DisplayID block in the
  EDID); a display event at a fixed step beyond the test hook (`GpuOptions.resize`).
- Framebuffer (the simple-framebuffer machines that remain: Buildroot's page, the test guests, `?display=simple`): a
  scan of the whole buffer per animation frame to find the changed rows (~0.4 ms at 1024×768, on the machine
  worker), x8r8g8b8 only, fixed size. Guests with the driver use virtio-gpu ([devices.md](devices.md)); nothing
  is planned for the rest.
- The TS backends are tested through boots; a Node test with a bare-metal virtio guest would be
  cheaper when they grow (blk).

## Parallel SMP (M7; measurements in `bench/boot/REPORT.md` "M7 loop 8")

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
- **Hours-long whole-platform stress** (repeated parallel boots and workloads for hours): deferred
  by the user (2026-09-28) to a later milestone, once more virtio devices and integration features
  exist, when such a run is likelier to catch non-obvious platform-wide issues.

## The page (M8 phase A; [frontend.md](frontend.md))

- **Settings:** vCPUs and RAM come from `?ncpus=` and machine.ts, no UI (phase D, with the image
  choice and the embedding API).
- **Remember the chosen disk across reloads:** a `File` isn't kept; a `FileSystemFileHandle` in IndexedDB (permission asked each session) would let the page boot the user's disk again without the picker (phase B loop 4).
- **Clipboard for the screen:** paste into tty1 (typed through virtio-input, paced: its queue
  drops past 1024 events) and copy from fbcon; only the serial terminal has both (xterm.js).
  Phase C, host integration.
- **Keyboard layouts** other than US: the page maps `KeyboardEvent.code` as a US PC keyboard and
  Debian's keymap is US; another layout needs the guest's keymap set to match (loadkeys, or
  `vconsole.keymap=` on the command line). Phase C, host integration.
- **Restart's "disk in use"** (the user's pass after phase A, 2026-09-29; loop 8 made restarts
  not overlap and ordered the overlay's hand-over with a Web Lock: [frontend.md](frontend.md)
  "Overlay hand-over"): whether the user's failure was that overlap or a browser releasing a lock
  before the handles is open (a `NoModificationAllowedError` in the message would say the latter;
  then a short bounded retry after the lock is the fix). The in-use message comes after a 10 s
  wait, with the page in Loading meanwhile: a "waiting for the disk" line would say why.
- **The ready marker is a per-machine regexp** over the serial output (Debian: agetty's
  `login: ` at a line's start). A guest that prints after its prompt, logs in automatically or
  has no serial getty would need its own; a guest-side signal (a byte on a port the page owns, a
  systemd unit writing to a device) would be exact. Revisit with image selection (phase D).
- **After phase B (the page's UEFI path):** EDK2's setup screen says `0 MB RAM` (no SMBIOS;
  cosmetic); a lone Esc takes ~2 s on the serial terminal and PageUp/PageDown aren't decoded by
  EDK2's terminal driver (frontend.md "The serial terminal"); Debian's GRUB waits 5 s on every
  boot; loading a changes file also resets the variable store (the file doesn't carry it).
- **The Keyboard Lock** in full screen is checked by hand only: headless Playwright's keys
  bypass the browser's shortcuts, so no test sees Ctrl+W reach the guest.

## Snapshots (M8 phase C, snapshots lane; [plans/snapshots.md](plans/snapshots.md), [platform.md](platform.md) "Snapshots")

- **9p's state isn't saved** (the server's tree and its fids): a VM with a 9p device refuses a
  snapshot. The page's machines have none; the device test and Alpine's test image do, so their
  host round trips run without it (`tests/snapshot.test.ts`). It needs the tree serialized with
  node identities (fids and unlinked-but-open files point into it).
- **The base image's hash is never written by the page**, so a snapshot only loads on a disk of
  the same identity (a URL's path and size, or a chosen file's name, size and modification time): a
  copy of the same image with another date is refused. `readSnapshot` already accepts a matching
  hash when the file has one (`SnapshotDisk.sha256`); what's missing is computing it off the save
  path (`hashSource`, web/changes.ts: ~640 MiB/s; cache it beside the overlay) and hashing the base at a restore
  whose identity differs.
- **The network across a snapshot:** the guest keeps its lease and its connections' state; the
  restored machine's card is on whatever the page connects it to now. A link down/up at restore
  would make the guest ask for a lease again; open connections are lost either way.
- **The guest's clock after a restore** is behind by the time the snapshot sat in its file (the
  RTC shows the host's time, the counter continues): until something sets it (`hwclock -s`,
  timesyncd over a network). A hint to the guest (an RTC alarm, a virtio device event) could
  make it resync.
- **One worker compresses RAM** (the core's LZ): 0.44 s for 304 MB of pages. Four would take it
  to 0.15 s (`bench/boot/REPORT.md` "M8 phase C loop 4"); chunks must then be dealt out
  interleaved, not as ranges. And the file's blocks are copied through the codec's own instance
  (a second copy each way): compressing in place in the VM's memory would save it.
- **A restore empties the TLBs**, which Linux can tell by its step count (not its behaviour): a
  test that wants an unbroken run's steps through a snapshot needs a guest that doesn't lean on
  stale entries, or the count of a run with TLB flushes at the same points
  (`alpine-user-snapshots`). Saving TLB contents would need entries re-validated against the
  page tables at restore (they hold host addresses), which is most of a walk.
- **A tracked benchmark case for the page** (`page_debian`: page load to `running` with a fresh
  profile, measured today only by ad-hoc drivers and the end-to-end test; a snapshot
  load to `running`, a suspend and its resume, the file's size and the pause): the lane's numbers
  are the page tests' own timings, two or three runs each (`bench/boot/REPORT.md` "M8 phase C
  exit").
- **Suspend and a chosen disk:** the suspended copy is beside that disk's overlay, and the page
  forgets a chosen file over a reload, so it resumes only when the user opens the disk again.
  And nothing tells a second tab that the first resumed the machine (it boots or waits for the
  disk, as any second tab does).
- **Save snapshot's pause is the file's write** (1.4 s for Debian's 175 MB through the picked
  file's stream): writing to memory first and to the file after the resume would shorten it to
  the compression's ~0.5 s, for the file's size in memory.
- **Snapshots between core versions:** a state of another `snapshot::VERSION` is refused; a
  migration path (or a reader per old version) would keep users' files alive across a format
  change. Prebuilt snapshots shipped with the repository (a Debian that resumes in seconds for a
  first-time visitor) need this, or a rebuild at each format change.
- **Parallel round trips beyond the tests' guests:** save and restore work in parallel SMP
  ([plans/snapshots.md](plans/snapshots.md) step 5); not yet run through a snapshot on 4 vCPUs:
  Buildroot, the litmus and the stress guests, in Node and Chromium.
- **A held chain the guest overwrote** (it changed a buffer it had given a device) makes the
  machine unsaveable until that queue is reset (`vm_snapshot_size` = `u64::MAX`): only a broken
  guest does it; the page would say so and offer nothing.

## Network (M8 phase C, networking lane; [plans/networking.md](plans/networking.md), [frontend.md](frontend.md) "Network")

- Loose ends: the menu's login-URL and approval states are `viewOf` unit tests only (no Chromium test against headscale); the page's Buildroot machine has no `network` entry (its kernel has virtio-net, but nothing brings the interface up); `tests/net/tailnet.sh`'s approval assumes the peer is headscale node 1; IPv6 to the internet through an exit node, and a real Tailscale exit node with its own nameservers, are untested; router advertisements repeat every 60 s only on a port backend; the network tests ran in cloud sessions (Chromium 141) as well as here (153), so recheck with `scripts/ci-net.sh` in the dev VM after a change.
- The Debian tests (`net-guest`, `page-network`, `net-tailnet`) take ~4 min: they run in `scripts/ci-net.sh`, not `scripts/ci.sh`.
- The Tailscale client's own memory (a 27 MB wasm Go runtime in its worker) wasn't measured: it
  needs the headscale test tailnet.

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
- **Alpine's package pins drift:** the container is pinned by digest but `apk` reads the live repository,
  so a pinned version that leaves it breaks the build (2026-10-02: `openssl-dev=3.5.8-r0` had gone, 3.5.9
  needs the newer libcrypto; `KERNEL_TOOLS` is bumped, `USERLAND_PKGS`' `openssl=3.5.8-r0` for
  `alpine-user` has the same problem when that image is next built). A mirror of the pinned packages
  (or `apk` against a dated snapshot) would end it.
- `images/Containerfile` and `images/alpine/user/webpc-user.start` still cite PLAN.md sections
  from before the docs moved; they're image inputs (editing them makes the images stale), so fix
  the comments with their next rebuild.

- **No consumer left:** `web/bootfs.ts` and `web/ext4.ts` (the ext4 reader that took Debian's
  kernel and initrd out of its disk; only `tests/ext4.test.ts` uses them: remove them or keep them
  for a later feature); `images/stress/` and `bench/stress`/`bench/mem`'s `GO` path route Debian's
  initrd, which the page's UEFI boot ignores (docs/images.md: put the binaries on a second disk
  to revive them).
