# Host ABI (version 61)

The contract between the Rust core (`core/src/lib.rs` exports) and its hosts (`web/vm.ts`, the
native runners in `core/tests/common`, the benchmarks). Exports are `#[unsafe(no_mangle)] extern
"C"`; **`ABI_VERSION` is bumped whenever they change**, and `web/vm.ts` `ABI` must match
(`abi_version()`; the Chromium smoke test checks it). `repr(C)` structs only grow at the end.
Design notes for an ABI change go in this file before the code.

## Instantiation

- The core is one wasm32 module built with `--import-memory --shared-memory
  --max-memory=4GiB --export-table --growable-table` (`.cargo/config.toml`). **Layout A:** one
  shared memory holds the core's static data, stack (1 MiB, `__stack_pointer`), heap, and guest
  RAM, which the host places after the heap ([architecture.md](architecture.md)).
- Imports: `env.memory`, `env.now_ms() -> f64` (the realtime clock), `env.jit_compile(…)`, `env.jit_install(ptr, len,
  slot) -> i32` (below), and `ram.load(m, off, size) -> i64`, `ram.store(m, off, size, val)`, `ram.cas(m, off,
  size, expected, new) -> i64` (ABI 39): aligned single-copy-atomic accesses to spill memory `m` (1 and up), from a
  module `web/spill.ts` makes over the spill memories (traps with none; [spill-memories.md](spill-memories.md)).
  `web/vm.ts` `coreImports(memory, …, spill)` returns `{env, ram, jit}`; after instantiating, the host calls
  `jit.bind(instance)`.
- **More instances on the same memory** (one per worker, ABI 20): the core exports
  `__stack_pointer`, `__tls_size`, `__tls_align`, `__wasm_init_tls` and `thread_alloc(size,
  align) -> ptr`. Another instance needs its own stack and TLS block, allocated through an instance
  that's already set up (`web/vm.ts` `threadAlloc`), and set **before any other call**
  (`instantiateThread`: `__stack_pointer` = the stack's top, then `__wasm_init_tls(tls)`); its
  start function finds the memory initialized. Instance 0 keeps the linker's static stack (1 MiB)
  and TLS. Each instance has its own function table, so each has its own JIT host; the modules it
  installs are the other instances' bytes, whose machine code V8 shares ([jit.md](jit.md) "Sharing").
  `tls_probe()` (a thread-local call count) lets tests check the TLS block is the instance's own.
  Tested with three concurrent instances (interpreter, JIT, JIT) in Node's `worker_threads` and in
  Chromium workers (`tests/threads.test.ts`, `tests/browser/threads.html`).
- **A fixed-size memory** (ABI 32): `bootVm` makes the memory its final size, so that V8 loads its
  size once per JIT function instead of after every call (Linux arm64 and Android, where wasm
  accesses are bounds-checked explicitly: [v8.md](v8.md) "Bounds checks"). The memory is created
  with `maximum` = the scratch page + RAM + fw_cfg's files + the heap reserve (which holds the core's
  static data and stack too): what 4 GiB leaves after the rest, capped at `HEAP_RESERVE` (1 GiB) and never
  under `HEAP_FLOOR` (1 GiB: the heap reaches ~600 MiB, [spill-memories.md](spill-memories.md) "The heap floor"), so
  memory 0 holds at most `MAX_MEMORY0_RAM` (3 GiB less 1 MiB) of RAM and `splitRam()` puts the rest in spill memories; after the host has grown its parts, `heap_reserve(pages) ->
  pages` allocates and frees one block that grows the memory to within two pages of `pages`. The
  allocator keeps what is freed (it can't shrink a wasm memory), so the core's later allocations
  come from that block and never grow the memory; its pages cost nothing until used. The host
  grows the last page or two and passes the size in `VmConfig.mem_pages`, and JIT modules import
  the memory with those exact limits. `heap_reserve` returns 0 if `pages` leaves no room (natively,
  always). **The core runs with exact limits too:** the core module declares 18–65536 pages, so the instance that
  lays the memory out (instance 0, the only one that can grow it) stays on it, and once the memory is at its size
  everything else runs on a copy of the module whose memory import declares `pages` both (`memoryLimits` in
  `web/vm.ts` rewrites the import section; `exactCore`, compiled once a size, while instance 0 works): a second
  instance on `bootVm`'s thread (a stack and TLS of its own, as a worker's) and every vCPU worker's. Instance 0 isn't
  called again. It needs the core's bytes, so a host compiles the core with `compileCore` (a module compiled
  otherwise boots on the growable import); `exactCore: false` keeps that too. Measured neutral on this host
  (bench/boot/REPORT.md "M8: the core with exact memory limits"). Running out of the reserve traps (the core's allocations fail); the
  heap measured ~27 MB through the userspace benchmark and ~150 MB under a heavy 4-vCPU load
  ([jit.md](jit.md) "Memory"). `fixedMemory: false`, or a RAM size that leaves no room for the
  reserve in 4 GiB, keeps the growable memory (0 in `mem_pages`).

## Whole-VM exports

- `vm_new(ram: *mut u8, ram_size: u64, cfg: *const VmConfig) -> *mut Vm` (null on an invalid
  config); `vm_free(vm)`. RAM appears at guest PA `0x4000_0000`.
- `vm_boot(vm, kernel_pa, initrd_pa, initrd_len, cmdline_ptr, cmdline_len)`: the host has copied
  the kernel and initrd into RAM; the core writes the DTB and resets the vCPU at the kernel.
- `vm_run(vm, budget: u64) -> u32` (round-robin): an exit kind; details in `vm_exit(vm) -> *const
  ExitInfo` = {kind, steps retired (all vCPUs), value, x0–x3, cpu (the vCPU that exited, ABI 22),
  wake (ABI 25)}.
- `vm_run_cpu(vm, cpu, budget) -> u32` (parallel, ABI 25): runs vCPU `cpu` on the calling thread (STOP at once past
  the last vCPU); `vm_exit_cpu(vm, cpu)` its `ExitInfo`; `vm_cpu_signal(vm, i)` vCPU *i*'s wake word (below).
  `vm_set_chunk(vm, steps)` (ABI 34, any thread): the steps between two publications of a vCPU's PC in its counters,
  32768 by default (0 restores it); the guest PC sampler (web/profiler.ts) shortens it while it runs, so a sample is
  at most that many instructions old instead of naming the exit that ended a long chunk. Round-robin is unaffected.
- `vm_cpu(vm, i) -> *mut Cpu`, vCPU *i* (null past the last; registers at fixed offsets: X0–X30, SP, PC at 256, …, `features` at
  1056; `Cpu` is 1168 bytes, 16-byte aligned), `vm_console`, `vm_signal`, `vm_counters(vm, i)`,
  `vm_device(vm, i)`, `vm_framebuffer(vm)` (the framebuffer's PA, 0 if none), `vm_flash(vm)` (the
  flash bank's bytes, null without one; ABI 29), `vm_xhci(vm)` (the xHCI's shared block, null without one;
  ABI 38, "USB" below).
- `vm_window_watch(vm) -> *const u32` (ABI 53; null without a window): the host-visible window's write-watch, u32
  words read and written with atomics: 0 the generation (the host bumps it to look), 1 the vCPUs, 2 the bitmap's
  words, 3 the window's pages, from 4 an ack per vCPU (the generation it last dropped its watched write entries for),
  from 132 a running word per vCPU, from 260 the bitmap (bit `p % 32` of word `p / 32` for page `p`); web/window.ts
  `WindowWatch` is the host's side ([devices.md](devices.md) "The host-visible window").
- `vm_jit_gauge(vm) -> *const u64` (ABI 45; null without a JIT; asked once, before any vCPU runs: the words stay
  put): the JIT code cache's gauge, `jit::GAUGE_WORDS` u64s read with atomic loads: the wasm bytes and the modules
  installed since the last flush (what V8 holds code and metadata for), the byte budget now, the epochs (flushes and
  `IC IALLU`s), and word 4, the **host's limit** on the budget (bytes, 0: none, at least 16 MiB; the host writes it
  with an atomic store, and the cache flushes at it: the page's memory signal); words 5–7 (ABI 47): the block map's keys,
  the heap bytes its table and page index take (estimated), and the module bytes held for tables that haven't taken
  them ([jit.md](jit.md) "Memory"). `heap_stats(out)` (ABI 45, any instance): writes the core heap's live
  bytes and their high-water mark since `heap_reserve` (the allocator keeps what it frees) to `out[0..2]`; the
  global allocator counts them. Both feed `Vm.hostUse` ([jit.md](jit.md) "The page's memory signal").
- `vm_snapshot_size(vm)`, `vm_snapshot_save(vm, ptr, len)`, `vm_snapshot_restore(vm, ptr, len)`,
  `snapshot_version()` (ABI 30): a VM's state without its RAM, out and into a new VM ("M8 phase
  C: snapshots", below).
- `lz_bound(len) -> usize`, `lz_compress(src, len, dst, cap) -> usize` (0: it doesn't fit),
  `lz_decompress(src, len, dst, cap) -> usize` (`usize::MAX`: malformed) (ABI 30): the LZ4 block
  format (`core/src/lz.rs`), the snapshot file's codec for RAM and disk blocks. They take no VM:
  any instance on the memory may call them. The decompressor is for files a user chose: it never
  reads or writes out of bounds, whatever the bytes.
- **Addresses are u32, but JS sees a wasm `i32` as signed:** past 2 GiB of memory (a guest with
  2 GiB of RAM puts the core's later allocations there) they'd come back negative. `web/vm.ts`
  `unsigned` wraps the exports that return one, and `jit_install` unsigns its `ptr`.

### `VmConfig` (u64 fields, in order)

| Field | Meaning (ABI that added it) |
|---|---|
| `ram_size` | bytes of guest RAM (5) |
| `deterministic` | non-zero: time from the step count; 0: realtime (5; realtime 7) |
| `cntfrq` | Hz, 0 → 62.5 MHz (5) |
| `ticks_per_insn` | counter ticks per step, 0 → 1 (5) |
| `devices`, `ndevices` | address and count (≤ 32) of `DeviceEntry`s (6) |
| `fb_width`, `fb_height` | a `simple-framebuffer`, 0: none (8) |
| `jit` | 0 interpreter only (the ABI default), 1 JIT, 2 JIT-stress (10), 3 JIT-check (24), 4 the dispatcher without compiling: the block interpreter (33) |
| `features` | bit 0 `FEATURE_CRYPTO` (19), bit 1 `FEATURE_RNG`: `RNDR`/`RNDRRS`, bit 2 `FEATURE_E0PD` (35), bit 3 `FEATURE_SHA3`: FEAT_SHA512 and FEAT_SHA3, only with bit 0 (51), bit 4 `FEATURE_JSCVT`: `FJCVTZS`, bits 5 to 9 `FEATURE_RCPC`, `FEATURE_SB`, `FEATURE_FLAGM` (FlagM and FlagM2), `FEATURE_DIT`, `FEATURE_FRINTTS` (59), bit 10 `FEATURE_DOTPROD` (60), bit 11 `FEATURE_I8MM` (61); other bits reserved, and `vm_new` refuses them |
| `ncpus` | vCPUs, 0 or 1 = one; up to `vm::MAX_CPUS` (123) (21; more than one from 22) |
| `gic` | 0 or 3: the GICv3; `vm_new` refuses others (21; 2, a GICv2, until 23) |
| `smp` | 0 round-robin on the calling thread (`vm_run`), 1 parallel: a thread per vCPU (`vm_run_cpu`), realtime only (25) |
| `rtc` | Unix time in ms at `vm_new`: a PL031 RTC (at 0x0901_0000, SPI 2, in the DT) counts from it; 0 or deterministic mode: none (28), except in the firmware configuration, where it counts virtual time (29) |
| `firmware` | 1: the firmware configuration (below, "M8 phase B"); 0: direct kernel boot (29) |
| `flash_size` | the firmware configuration's flash bank, a multiple of 256 KiB from 768 KiB to 64 MiB; 0 otherwise (29) |
| `fw_cfg`, `fw_cfg_len` | address and length of fw_cfg's files, copied by `vm_new` (firmware only; 0: none) (29) |
| `mem_pages` | the memory's size in 64 KiB pages when the host made it fixed (above, "A fixed-size memory"): JIT modules import it with exact limits; 0: growable; over 65536 is refused (32) |
| `rng_seed` (4 words) | FEAT_RNG's 256-bit ChaCha20 key in realtime mode, from the host's CSPRNG; deterministic mode ignores it and uses zeros (35) |
| `xhci` | an xHCI ([usb.md](usb.md)): its USB 2 ports \| USB 3 ports << 8, `0x404` (4 and 4, the only counts built; `vm_new` refuses others) or 0, none (38) |
| `spill` (8 words) | the spill memories' sizes, memory 1 first, the first 0 ending the list: multiples of 64 KiB, at most 4 GiB each; the core places each at the 1 GiB boundary past the RAM before it (`VmConfig::spill_layout`), a NUMA node in the DT, and reaches it through the `ram` imports ([spill-memories.md](spill-memories.md)). Natively `vm_new` refuses them (a Rust runner passes its own `Mem`) (39) |
| `jit_bytes` | the JIT's code cache budget in wasm bytes, for `jit` 1 and 4 (JIT-stress and JIT-check keep theirs): the most the live modules hold before a flush ([jit.md](jit.md) "Memory"); 0: the core's default, `jit::MAX_BYTES`. Not part of a snapshot's state: a state restores under any budget. The host's scratch page holds the config's words at 0 and the device entries from 512 (44) |
| `window` | the host-visible window's bytes: guest-physical memory right after RAM, outside the DT's `/memory`, a multiple of 2 MiB up to 2 GiB (`vm::MAX_WINDOW`) after RAM of whole 64 KiB pages; its bytes are memory 1's at `window_at`; a transport whose entry has `shm` reports it as its shared memory region 1, and the spill memories' guest PAs start past it; 0: none ([devices.md](devices.md) "virtio-gpu") (53) |
| `window_at` | where the window's bytes start in memory 1, a multiple of 64 KiB (a Venus machine's renderer arena before it: web/ram.ts `VENUS_ARENA`); node 1's RAM follows the window there, so memory 1 is `window_at + window + spill[0]` bytes (`VmConfig::memory_sizes`, which JIT modules import as `env.ram1`'s exact limits) (55) |
| `fma` | non-zero: the host's relaxed-SIMD `madd` fuses in every tier, and the JIT's FMA forms use it (`web/fma.ts` probes it; `bootVm`'s `fma: false` forces the emulation). Nothing the guest can see depends on it |

`bootVm` (`web/vm.ts`) and the native runners set `features` bit 0 unless told `crypto: false`,
and bits 1 to 10 unless told `rng: false`, `e0pd: false`, `sha3: false` and so on (the bare-metal tests are); bit 11
(FEAT_I8MM) only when told `i8mm: true` (`cpu::DEFAULT_FEATURES`); the ABI's 0 means none.

### Exit kinds

| Kind | Meaning |
|---|---|
| 0 `BUDGET` | the budget is used up |
| 1 `PSCI` | a PSCI call for the host (SYSTEM_OFF, SYSTEM_RESET; M7 handles CPU_ON in the core). PC is past the HVC; the host writes x0 if it resumes |
| 2 `IDLE` | WFI with nothing pending, realtime mode only: `value` = ns to the next timer deadline (u64::MAX: none); PC on the WFI. (Deterministic mode jumps virtual time instead, and returns `IDLE` with u64::MAX only when no timer is armed.) Parallel mode: per vCPU, also for an off vCPU (u64::MAX), with `wake` the wake word's value to wait on |
| 3 `TX_FULL` | the console TX ring is full: drain and resume |
| 4 `UNIMPLEMENTED` | `value` = the `Op` index |
| 5 `STOP` | a stop was requested through the signal word |
| 6 `DEVICE` | `value` = slot \| events << 8 (informational: every device's events are in its `DevShared`); PC past the register access |

### Signal word and console

- `vm_signal(vm) -> *const AtomicU32`: bit 0 `SIGNAL_STOP`, bit 1 `SIGNAL_RX`, bit 2
  `SIGNAL_DEVICE`. Checked between chunks and on WFI. Whoever sets a bit `Atomics.notify`s it, and
  in parallel mode also bumps and notifies every vCPU's wake word (`vm_cpu_signal`; `web/vm.ts`
  `signal`, `Vm::signal` natively, the device backends' completions). Parallel mode leaves STOP
  set; the host clears it.
- `vm_console(vm)`: two SPSC byte rings (TX, RX), 4 KiB each, atomic head/tail (head, tail, then
  the bytes; RX follows TX). The PL011 writes TX; the host drains it after each `vm_run` and fills
  RX (one producer, any thread), then sets `SIGNAL_RX` ([platform.md](platform.md) "PL011").
- **A byte into an empty TX ring notifies its head word** (`memory.atomic.notify`, M8 loop 3), so
  a host that drained the ring can sleep on the head (`Atomics.waitAsync(head, value)`) and wake
  at the next output: parallel `runAsync` does, so a terminal's echo isn't held back by its 10 ms
  wait. Only the empty-to-non-empty transition notifies (a flood doesn't pay one per byte); the
  exports didn't change, and a host that relies on it with an older core only waits longer, so
  the ABI version stayed.

### Counters (`vm_counters(vm, i)`, u64 words, relaxed atomic stores; `web/vm.ts` `Counter`)

One block per vCPU (ABI 25): round-robin publishes everything in block 0, parallel mode each
vCPU's own counts in its block; hosts sum them (`stats()`). Word 70 (PC) is per block.

| Words | What |
|---|---|
| 0 | steps retired |
| 1–64 | exceptions by EC |
| 65 | IRQs taken |
| 66–69 | TLB hits (not counted: 0), misses, walks, flushes (published once per chunk) |
| 70 | current PC, published at every chunk end (the PC sampler reads it) |
| 71–90 | `jit::Stats`: regions compiled, modules, wasm bytes, compile ns, steps in JIT code, dispatches, invalidations, flushes; instructions compiled inline and as helpers, inline steps run; static flag setters stored/elided, conditions direct/computed/from memory; blocks in regions, back-edges, tier-ups; stale blocks tolerated (parallel, 25) |
| 91–100 | parallel SMP (26): DSBs that waited for TLBI IS, ns waited; TLBI IS broadcast and IC operations issued (ICs are not broadcast: the code cache is shared, [jit.md](jit.md) "Sharing"); queue drains that applied something; IDLE exits (WFI); platform-lock acquisitions that found it held, ns waited; WFEs (each a yield); ns out of `vm_run_cpu` between runs (idle or in the host) |
| 101–103 | the block interpreter (33, [cpu.md](cpu.md) "The block interpreter"): steps it ran, blocks it decoded, times a table's cache of them started over (full) |
| 104–105 | the compile worker (36, `env.jit_compile` above): modules a table installed once the worker had compiled them; ones it compiled itself after waiting a second for the worker |
| 106–107 | (37) times the host didn't have the worker's compiled module yet when a table went to install it; runs that ended early (`BUDGET`) for it to arrive |
| 108–113 | (46) the JIT cache's lock ([jit.md](jit.md) "Sharing"): acquisitions, those that found it held, ns they waited; ns spent emitting modules, ns of those under the lock (all of them: emission runs under it), ns forming batches into regions (under it) |
| 114–118 | (47) the core's heap ([jit.md](jit.md) "Memory"): the block map's prunes; flushes because the heap had no room for a map to grow (the block map, a table's decoded or known blocks: those free their tables whole); flushes because a table lacked modules whose bytes were dropped; the heap bytes the table's decoded blocks (arena, map, page index) and its known blocks take, estimated |
| 119 | (48) jump-cache misses that found the JIT cache's lock held and ran their block interpreted instead of waiting ([jit.md](jit.md) "Sharing") |
| 120 | (50) the ns the JIT block map's prunes took, under the cache's lock ([jit.md](jit.md) "The core's heap"; 0 natively) |

TLB hits stay uncounted: counting them in the fast path wasn't clearly free (one boot run +12%).

## Device backends

Layouts in `core/src/virtio.rs` and `web/devices.ts`; the behavior is in [devices.md](devices.md).
- `DeviceEntry` = 6 u64s: device ID, offered features (the transport masks the reserved bits
  24–40 and adds `VERSION_1`, `INDIRECT_DESC` and `EVENT_IDX`), queue count (≤ 8), QueueNumMax (power of 2,
  ≤ 1024), config length (≤ 256), `shm` (ABI 53: 1, the VM's window is the transport's shared memory region 1,
  SHMSel/SHMLen/SHMBase; 0, no regions). Every chain that can be in flight must fit the completion ring
  (queues × size × 2 ≤ 4096 words).
- `vm_device(vm, i) -> *const DevShared`: events u32 at 0 (`EV_REQUEST` 1, `EV_CONFIG` 2,
  `EV_STATUS` 4; the host takes them with a swap), device status at 4, negotiated features (two
  u32s) at 8, reset epoch at 16, config generation at 20 (ABI 31, below), config space (256 bytes; the host writes it after `vm_new`, guest
  writes land there with `EV_CONFIG`) at 24, request ring at 280, completion ring at 16672. Each
  ring is SPSC u32 words: head, tail (words written/read, wrapping), 4096 words.
- **Request record:** `w0` = head | queue << 16 | epoch << 24; `w1` = readable count | writable
  count << 16; then (offset, length, memory) per segment, readable first (ABI 40). Memory 0's
  offsets are from the start of its guest RAM (so the words stay u32 natively; the host adds its RAM
  base), a spill memory's from its start; a buffer that crosses a memory's edge is two segments.
- **Completion record:** `w0` as posted, then bytes written.

### USB (ABI 38)

Layouts in `core/src/xhci.rs` and `web/usb.ts`; the behavior is in [usb.md](usb.md).
- `vm_xhci(vm) -> *const XhciShared`: events u32 at 0 (`EV_REQUEST` 1; the host takes them with a swap),
  a pad word, the request ring at 8 and the completion ring at 16400: `WordRing`s of 4096 words, as
  `DevShared`'s. A doorbell or command that posted records exits `DEVICE` with slot 32.
- **Request record:** `w0` = tag (24 bits, from 1; 0 for the non-transfer kinds) | the connector's
  generation (its detaches, mod 256) << 24; `w1` = connector | DCI << 8 | kind << 16; `w2` = the words
  that follow. Kinds: 0 transfer (segment count | xHCI endpoint type << 16 | has-setup << 24, length,
  the setup packet's two words for a control transfer, then (RAM offset, length | memory << 24) per segment
  (ABI 40; the offset as virtio's, lengths under 16 MiB, memories as `SEG_MEM_SHIFT`); immediate
  data is (0, length | 1 << 31) and two words of bytes), 1 reset, 2 cancel (count, tags), 3 configured
  (count, then (DCI | type << 8 | interval << 16, max packet) each), 4 clear-halt.
- **Completion record**, three words, `w1 & 0xff` the kind: 0 done (`w0` as posted, `w1` = xHCI
  completion code << 8, `w2` = bytes transferred), 1 attach (`w0` = connector, `w1` = speed ID << 8: 1
  full, 2 low, 3 high, 4 super), 2 detach (`w0` = connector). The core keeps at most 1024 TDs in flight,
  so the ring never fills.
- **Snapshots:** a machine with a device on a port refuses (`vm_snapshot_size` returns `u64::MAX`); the
  configuration words gain `xhci` only when it is set, so other machines' states (and `snapshot::VERSION`)
  are as they were.

## JIT host interface

The translator is in the core ([jit.md](jit.md)); the host only turns bytes into a module and
puts its functions into the core's table.
- **Table:** the core's `__indirect_function_table` is exported and growable; Rust function
  pointers are indexes into it. `jit.bind(instance)` records `base` = the table's length then. The
  core owns **slot** allocation (slot *s* is table index `base + s`), so eviction reuses slots and
  the table stops growing at the code cache's size.
- **`env.jit_install(ptr, len, slot, seq) -> i32`:** with `seq` 0 the host copies the bytes out of
  shared memory and compiles them **synchronously** (`new WebAssembly.Module` in the vCPU worker);
  with `seq` ≠ 0 (ABI 37) it takes instead the module the compile worker compiled as number `seq`
  (below), which the worker posts to every vCPU's host and which arrives through the vCPU worker's
  event loop, or returns **−2** if it hasn't arrived yet. Then it instantiates the module, grows
  the table if needed, sets exports `f0, f1, …` at `base + slot + k`, and returns `base + slot`
  (−1 before `bind`: the core then only interprets). On −2 the table keeps the module queued
  (its blocks interpreted), asks again only after its vCPU has been out of the core, and ends the
  run early with `BUDGET` (fewer steps than the budget): the host's vCPU worker then goes through
  its event loop before it runs the vCPU again. Past a second it passes `seq` 0. A module that
  doesn't compile is a JIT bug: the exception propagates and the run fails.
- **`env.jit_compile(ptr, len, seq, epoch, ready) -> i32`** (ABI 36): the core hands each module it
  emits to the host's compile worker first (`web/jit-compile-worker.ts`, parallel SMP), as number
  `seq` (from 1, by the cache) of code-cache epoch `epoch`. The host posts a copy and returns 1, or
  returns 0 (no worker: round-robin, or before `bind`), and the core installs that module at once as
  before. The worker compiles the modules (`new WebAssembly.Module`, which fills V8's module cache)
  and, when every module up to `seq` is compiled, stores `seq` atomically into the u32 at byte
  address `ready`. A table installs a module (`jit_install`, then a cache hit) only once `ready`
  has reached it, interpreting its blocks until then, or after a second without it.
- **A JIT module's imports:** `env.memory` (limits 0–65536 pages, or exactly `VmConfig.mem_pages`: ABI 32), on a machine
  with spill memory the first `jit::INLINE_SPILL` spill memories as `env.ram1`, … (exact limits, its size: ABI 52;
  [spill-memories.md](spill-memories.md) "The JIT's spill arm"), `env.table`, any core export by
  name (helpers are ordinary exports named `jit_*`, called as wasm imports: no JS in between), and
  module `t`, whose imports are named by table index and resolved with `table.get` (links to
  already-compiled blocks).
- Natively there's no wasm engine: `jit::install` returns `None` and the run loop interprets.
- `jit_helper_report(vcpu) -> *const u8`: NUL-terminated `<Op> <calls>` lines, most frequent
  first (`web/vm.ts` `helperReport`; the benchmarks record it).

## System suspend (ABI 54)

A guest in PSCI SYSTEM_SUSPEND ([platform.md](platform.md) "System suspend") has every vCPU off until the host wakes
it. In parallel mode all three from any thread; in round-robin, `vm_suspended` from any thread, `vm_wake` and
`vm_clock_skip` between `vm_run` calls (a wake takes effect at the next one, and a snapshot taken before it keeps it):
- `vm_suspended(vm) -> u32`: 1 while the guest is suspended.
- `vm_wake(vm) -> u32`: its vCPU resumes at the entry it gave, with x0 = its context (parallel mode: the vCPU's wake
  word is bumped and notified). 0 if it wasn't suspended.
- `vm_clock_skip(vm, ns) -> u32`: moves a suspended guest's realtime clock on by `ns` (the PL031 keeps showing the
  host's time); 0, and nothing done, if the guest isn't suspended or time is deterministic. Linux counts the jump as
  sleep when it resumes.

## User-mode exports (corpus, differential tests, `bench/interp`)

`vcpu_new`, `mem_new`, `interp_run`, `interp_run_exit` (EL0-style exits, plus trap-to-EL1 and
HVC kinds and the EL1 state at the end of `Cpu`), and their JIT twins over a per-vCPU JIT state:
`jit_new(threshold, batch, capacity, check, region_after)`, `jit_fma(v, on)` (`VmConfig.fma` for such a vCPU, before
its first run: the emulation unless set), `jit_run`, `jit_run_exit`,
`jit_flush` (for hosts that rewrite guest code between runs: drops compiled and decoded blocks),
`jit_stats`. These vCPUs always
have every optional feature. The host writes their `Cpu` fields directly between runs (an EL1 test
sets SCTLR_EL1.M), so the run exports (`interp_run`, `jit_run` and their `_exit` twins) derive the
dispatcher's bytes (`Cpu.dispatch`, `interp_only`) again before each run; the core derives them
itself on every other path. `jit_add_install`/`jit_call` are the JIT plumbing test.

## M7 (SMP): design note for ABI 20 onward

Each commit that changes the exports bumps the version (20: the thread setup exports; 21:
`VmConfig.ncpus` and `gic`; 22: `vm_cpu(vm, i)`, `ExitInfo.cpu`, round-robin SMP; 23: no GICv2;
24: JIT-check; **25: parallel mode**, below; 26: parallel counters). Written before the code
(pre-approved on the outline), and it describes what was built. With
`ncpus` ≤ 1, `smp` = 0 and the defaults, a host that passes CPU index 0 everywhere sees the
single-CPU machine.

**Two ways to run the vCPUs.**
- *Round-robin* (`VmConfig.smp` = 0, the default; deterministic or realtime): `vm_run(vm,
  budget)` runs every vCPU on the calling thread, one quantum (`CHUNK` steps, cut at the next
  timer deadline in deterministic mode) each in index order, skipping vCPUs that are off or idle.
  `budget` counts the steps of all vCPUs. One code cache serves them all (block code takes the
  `Vcpu` pointer). In deterministic mode virtual time is the total steps of all vCPUs
  (× `ticks_per_insn`, plus WFI skips), one counter for every CPU; the run returns `IDLE` only
  when every on vCPU is idle (time jumps to the earliest deadline first).
- *Parallel* (`smp` = 1, realtime only: `vm_new` refuses it with `deterministic`): one thread
  (worker) per vCPU, each with its own core instance on the shared memory. Each worker calls
  `vm_run_cpu(vm, cpu, budget)` for its vCPU, and **vCPU *i* always runs on the same instance**:
  its JIT table (`jit::Table`, created by `vm_new`, one per vCPU, on the code cache they share)
  records what that instance's function table holds. `vm_run` is for round-robin only. (The
  outline had a `vm_runner(vm)` per worker for the cache; a table per vCPU made it unnecessary.)

**`VmConfig`** (appended u64 fields; 0 keeps today's meaning):

| Field | Meaning |
|---|---|
| `ncpus` | vCPUs, 0 or 1 = one; at most `vm::MAX_CPUS` (ABI 21) |
| `gic` | 0 or 3, the GICv3 (ABI 21; the GICv2 option was dropped in 23) |
| `smp` | 0 round-robin on the calling thread, 1 parallel (ABI 25) |

**Exports (ABI 25).**
- `vm_run_cpu(vm, cpu, budget) -> kind`: parallel mode; runs vCPU `cpu` until an exit or
  `budget` of its own steps. `vm_exit_cpu(vm, cpu) -> *const ExitInfo`, that vCPU's last exit
  (`vm_exit(vm)` is `vm_exit_cpu(vm, 0)` in parallel mode). `ExitInfo` gains `wake` (appended):
  on `IDLE`, the vCPU's wake word as the core read it before deciding to idle.
- `vm_counters(vm, i)`: a counters block per vCPU. Round-robin publishes everything in block 0
  (the others stay zero); parallel mode publishes each vCPU's steps, exceptions, IRQs, TLB and
  JIT counts in its own block. Hosts sum the blocks for totals.
- `vm_cpu_signal(vm, i) -> *const AtomicU32`: vCPU *i*'s **wake word**, a counter, the only word
  its worker sleeps on (`Atomics.wait(word, ExitInfo.wake, ms)` after `IDLE`). Whoever makes
  something true that the vCPU waits for bumps it (`fetch_add`) and notifies it, after the
  change: the core for interrupts it raises (an SGI, an SPI or PPI line that goes up), PSCI
  CPU_ON, and a DSB wait (below); the host for `vm_signal` bits (it sets the bit, then bumps and
  notifies every vCPU's wake word; `web/vm.ts` `signal()`).
- **Signals in parallel mode.** The VM signal word keeps STOP, RX and DEVICE. RX and DEVICE are
  taken by whichever vCPU sees them first (`fetch_and`), which drains the completion rings and
  updates the lines under the platform lock. **STOP isn't cleared by the core** (every vCPU must
  see it); the host clears it before running the VM again.
- **Exit kinds per vCPU:** `IDLE` for an off vCPU has `value` = u64::MAX until PSCI CPU_ON (in
  the core) starts it; a vCPU in WFI returns `IDLE` with the ns to its own timer deadline.
  SYSTEM_OFF/RESET exit `PSCI` on the vCPU that called it, and the host stops the others with
  STOP. `TX_FULL` and `DEVICE` exit on whichever vCPU hit them; the console's TX ring has one
  consumer (the host thread that drains it), and its producer holds the platform lock.
- **Shared state** (the GIC, the PL011, the virtio transports, completion draining, the PSCI
  power states) sits behind one lock in the core (`Vm.plat`); round-robin reaches it without
  locking. Per vCPU, each thread publishes its GIC IRQ line (an atomic the platform code updates
  under the lock), so the fast path between chunks takes no lock.
- **Time:** the host clock through `env.now_ms`, which must be one clock for every instance:
  the VM creator's `performance.timeOrigin + performance.now()`; a vCPU worker measures that
  clock's offset from its own `performance.now()` (`web/vm.ts` `clockOffset`) rather than
  trusting its own `timeOrigin`, which Chromium derives from a drifting wall clock
  ([platform.md](platform.md) "Time"). The core keeps the counter
  monotonic across vCPUs (an atomic maximum), so CNTVCT never goes back between CPUs.

**Panic message (ABI 27).** The core is built `panic = "abort"`, so a panic reaches the host as a
trap (`RuntimeError: unreachable`) with nothing else. `vm_new` installs a panic hook that keeps
the first panic's message (thread, location, text; at most 4096 bytes) in a static in the shared
memory, and `panic_message()` (core/src/diag.rs) returns its address: a u32 length (0 = none)
then that many UTF-8 bytes. The hosts read it after catching a trap (`web/vm.ts` `panicMessage`,
`withPanic`; the vCPU worker and the round-robin `run`) and put it in the error. A DSB wait that
times out (10 s of waiting: passes over 100 ms are the waiter's own thread stalling and don't
count) panics with each waited vCPU's state, queue and progress, and the waiter's own timing
(`Vm::dsb_report`, core/src/vm/parallel.rs). An allocation that fails (the heap is full: `handle_alloc_error`, which
aborts without the panic hook) records a message through the allocation error hook (ABI 47): the size asked for and the
heap's live bytes and high-water mark, formatted without the heap.

**Broadcast maintenance in parallel mode** ([platform.md](platform.md) "Broadcast
maintenance"): `CPU features` gain an internal `FEATURE_PARALLEL`, under which DSB, ISB and ERET
end the chunk (`Exit::Resync`, retired) in both tiers (the JIT calls the helper for DSB), so the
run loop can apply what other vCPUs queued (context synchronization) and complete this vCPU's
own TLBI IS broadcasts before anything after its DSB runs.

## M8 phase B: the firmware configuration (design note for ABI 29)

Written before the code (M8 phase B), and it describes what was built (loop 2; the firmware
itself: [firmware.md](firmware.md)). The page's machine boots EDK2's ArmVirtQemuKernel (`images/build.sh edk2`) the way it boots a kernel today;
EDK2 then boots the disk's own loader. With `firmware` = 0 nothing below exists and every guest
is the machine it was (the tests' step counts don't move).

**`VmConfig`** (appended u64 fields):

| Field | Meaning |
|---|---|
| `firmware` | 0 direct kernel boot (as before); 1 the firmware configuration, below |
| `flash_size` | bytes of the variable flash bank (firmware only, required there): a multiple of 256 KiB from 768 KiB to 64 MiB |
| `fw_cfg`, `fw_cfg_len` | address and length of the host's fw_cfg files (firmware only; 0: none), copied by `vm_new` |

**What `firmware` = 1 changes** (`vm_new` refuses it without `flash_size`, or without `rtc`):
- **Boot:** unchanged. The host copies `QEMU_EFI.fd` into RAM as the `Image` (its header's
  `text_offset` is 512 KiB, so at RAM + 512 KiB, where QEMU puts it) and calls `vm_boot` with no
  initrd and an empty command line. The DTB still goes in the top 2 MiB: EDK2's first act
  (`ArmVirtPkg/PrePi/ModuleEntryPoint.S` `DiscoverDramFromDt`, before any allocation) is to copy
  it into the 32 KiB after its own image header, so nothing EDK2 allocates can land on it
  first. `vm_boot` refuses a DTB over 32 KiB − 64 in this configuration.
- **The DT:** `/memory` ends at the framebuffer's base (without one, at the DTB space): the
  framebuffer and the DTB space stay where they are in the same wasm memory (so `vm_framebuffer`,
  the display and the guest's PA-to-host translation don't change), invisible to EDK2's
  allocator, which works down from `/memory`'s top. No `/reserved-memory`. New nodes:
  `flash@4000000` (`cfi-flash`, `bank-width` 4, `reg` = `flash_size`) and `fw-cfg@9020000`
  (`qemu,fw-cfg-mmio`, `reg` size 0x18 as QEMU's, `dma-coherent`); the PL031 always.
- **The flash bank** at PA `0x0400_0000` (QEMU `virt`'s bank 1): an MMIO device in the core
  behaving as QEMU's `pflash_cfi01` with bank width 4 and two interleaved x16 chips (a command is
  written to both 16-bit halves; status reads return it in both). Array-mode reads are the
  bytes (any size or alignment); writes are commands: read array (0xFF), read status (0x70),
  clear status (0x50), block erase (0x20, 0xD0 in the 256 KiB block), word program (0x40 or
  0x10, then the data), buffered program (0xE8 at the target, the word count − 1, that many
  32-bit words, 0xD0), block lock/unlock (0x60, then 0x01 or 0xD0: accepted, nothing locks),
  read identifier (0x90: manufacturer 0x89, device 0x18, lock status 0) and CFI query (0x98:
  `QRY` at word 0x10). Operations complete at once (status 0x80: ready). Programming stores the
  data as QEMU does (it doesn't AND it into the old bytes as NOR does). Anything else sets the
  status's command-sequence error bits (4, 5) and returns to read array.
- **`vm_flash(vm) -> *mut u8`** (a new export; null without a flash): the bank's `flash_size`
  bytes in the shared memory, erased (all ones) by `vm_new`. The host copies the saved store
  in before the first run and reads it back whenever it wants to save it (at power-off, or on
  `vm.close`); in parallel mode a read while the guest writes can see a half-done update, so a
  host saves after the vCPUs stopped.
- **fw_cfg** at PA `0x0902_0000` (QEMU `virt`'s): data at +0 (reads of 1, 2, 4 or 8 bytes return
  the item's next bytes in order, zeros past its end or for an absent item), the selector at
  +8 (a 16-bit big-endian write; it rewinds the offset), no DMA (+0x10 reads as 0 and ignores
  writes; `ID` says so). Items: signature (0x0000, `QEMU`), ID (0x0001, 1: the traditional
  interface), the file directory (0x0019: a big-endian count, then per file size, select, a
  reserved u16 and a 56-byte name), and the host's files at 0x0020 upwards in its order, then the core's SMBIOS tables
  (`etc/smbios/smbios-anchor` and `etc/smbios/smbios-tables`, `core/src/smbios.rs`) unless the host
  passed a file under `etc/smbios/`. The
  host's buffer is a sequence of records: a 56-byte NUL-padded name, a u32 LE size, the bytes
  (`vm_new` refuses a malformed one). Writes to the data register are ignored. The DMA interface
  (only ramfb would need it, and ramfb isn't wanted: firmware.md "Our patches") would be a
  later, appended change.
- **The PL031 in deterministic mode** (firmware only): its time is `rtc` plus virtual time
  (the counter over CNTFRQ), so firmware boots keep one step count. Hosts pass a fixed `rtc`
  there (web/vm.ts: 2026-09-01, as the 9p server's timestamps).

## M8 phase C: snapshots (ABI 30)

As built (`core/src/snapshot.rs`,
`core/src/vm/state.rs`; what a snapshot is: [platform.md](platform.md) "Snapshots"). The core
saves and restores everything a VM is except guest RAM, which the host copies (it owns the memory
and the file format). A VM that is never snapshotted is the machine it was.

**Exports**, each called with **every vCPU out of the core** (round-robin: between `vm_run`
calls; parallel: every vCPU's thread out of `vm_run_cpu`, STOP set or not):
- `vm_snapshot_size(vm) -> u64`: gets the VM ready. It takes the completions the backends left
  into the used rings and clears `SIGNAL_DEVICE`, as the run loop does at its next boundary (so a
  deterministic machine that runs on takes the steps it would have). Returns the state's size in
  bytes; **0 while a device isn't quiet** (an event the host hasn't taken, a request it hasn't
  read, chains that hadn't fit a request ring and were posted now): the host serves the doorbell
  and calls it again; **`u64::MAX` if the chains the backends hold couldn't be posted again** by a
  restore (one no longer walks: the guest changed a buffer it had given away; or together they
  exceed a request ring, which no device of ours reaches): this VM can't be saved now.
- `vm_snapshot_save(vm, ptr, len) -> u64`: writes the state at `ptr` (in the memory, outside guest
  RAM) and returns its size; 0 if `len` is too small or a device isn't quiet. It changes nothing:
  the VM runs on afterwards.
- `vm_snapshot_restore(vm, ptr, len) -> u32`, on a VM fresh from `vm_new` (no `vm_boot`, never
  run) **whose RAM the host has already filled** with the snapshot's (the transports read their
  in-flight chains from it): 0, or 1 not a state or another `SNAPSHOT_VERSION`, 2 the VM's
  configuration differs, 3 truncated or inconsistent (a guest address outside RAM, a count past
  its limit, a PSTATE no instruction leaves, in-flight chains that don't walk or fit). After a
  failure the VM is only good for `vm_free`. Nothing in a state panics the core: a field holds
  what a guest's write could have left in it (the registers' write masks are applied), or the
  state is refused. The host writes nothing else (the config spaces and the flash bank come from
  the state), then **serves the doorbell once** before it runs the VM: the restore posted every
  in-flight chain to its request ring again (`EV_REQUEST`), which is how the new backends get the
  buffers the old ones held. A backend whose `epochs` start at 0 sees the restored epoch as a
  reset first, which a new backend ignores.
- `snapshot_version() -> u32`: `snapshot::VERSION`, for the file's header and the host's refusal
  message. It is bumped when a saved field is added, removed or changes meaning; a unit test
  pins the bytes of a fixed machine's state, so a layout change without the bump fails.
  `snapshot_version_min() -> u32` (ABI 54): the oldest version a restore still reads (`snapshot::VERSION_MIN`), when a
  newer layout only added something an older state can lack: version 3 added a suspended guest after the devices, so a
  version 2 state was a version 3 one without it; version 4 added fields inside the devices' (a transport's SHMSel, an
  xHCI endpoint's walk waiting for room), so it reads only itself. The host accepts a file whose version is in that range.

**What must match** between the state and the `VmConfig` of the VM it is restored into:
`ram_size`, `deterministic`, `cntfrq`, `ticks_per_insn`, the device entries, `fb_width`,
`fb_height`, `features`, `ncpus`, whether there is an RTC, `firmware`, `flash_size`. Free: `jit`
(a state is the same under either tier), `fma` (under either FMA arm: a machine saved on a host that fuses restores on one that doesn't) and `jit_bytes`, `mem_pages`, `smp` in realtime mode (the per-vCPU state is saved in
one form: power, WFI, a pending CPU_ON), `rtc`'s value and the fw_cfg files (the state's files
replace the VM's: they are part of the machine).

**The state** (little-endian; `WPCS`, the version, the configuration words above, then in a
fixed order):
- Time: the steps of all vCPUs and the ticks WFI skipped, round-robin's current vCPU and the rest
  of its quantum, and in realtime mode the clock's nanoseconds, from which the restored clock
  continues (CNTVCT doesn't jump back or forward).
- Per vCPU: `Cpu`'s registers field by field (`features` and `mpidr` are the new VM's), power,
  WFI state, the event register, a pending CPU_ON (entry, context).
- The GICv3 (distributor, redistributors, CPU interfaces), the PL011's registers and what both
  console rings hold (RX bytes the guest hasn't read, TX bytes the host hasn't taken), the PL031
  (in realtime mode its base is recomputed from the new VM's `rtc`, so it shows the host's time;
  deterministic, the saved base), the flash bank (bytes, mode, status), fw_cfg (files, selector,
  offset).
- Per virtio transport: its registers (SHMSel among them: version 4) and queues (addresses, sizes, `last_avail`, `used`), the
  **in-flight chains of each queue in the order they were posted**, and its `DevShared` status,
  features, epoch and config space. The rings are empty by the rules above and aren't saved.
- Version 3: last, and only when the guest is in PSCI SYSTEM_SUSPEND, the vCPU that suspended it (u32), its entry and
  context (u64s); every vCPU is then off with no CPU_ON pending, or the state is refused.

**Not saved:** TLBs, code caches, maintenance queues, DSB waits, counters, exits, signal bits.
A restored vCPU's timer lines are taken from the GIC's saved levels; every vCPU's published IRQ
line is recomputed.

**A transport tracks its in-flight chains** (a list per queue instead of a count; a completion
is taken only for a chain in the list): this is the only change to a path that runs without
snapshots.

## M8 graphics: config changes (design note for ABI 31)

Until now a device's config space never changed under a running driver: `ConfigGeneration` read 0 and
the only config-change interrupt was the transport's own NEEDS_RESET. virtio-gpu's display events
(`events_read`, a size change from the page) need a host-initiated change, and so would a console
resize, a block capacity change or a net link state (backlog "Platform and devices"; none is
implemented by this step).

- **`DevShared` word 5 (offset 20, the old padding) is `config_gen`**: the host's generation counter.
  The layout and size are unchanged.
- **Host protocol** (`web/devices.ts` `Devices.changeConfig(i, write)`, `DevShared::update_config`
  natively): `config_gen += 1` (odd: an update is in progress), write the config bytes, `config_gen +=
  1` (even), then set `SIGNAL_DEVICE` like a completion does. The stores are sequentially consistent.
- **The transport** keeps the generation it last raised an interrupt for. When it drains completions
  (the `SIGNAL_DEVICE` path, on whichever vCPU thread takes it) and `config_gen` is even and differs,
  it sets InterruptStatus bit 1 (INT_CONFIG), so the line rises, and remembers it; a reset keeps it,
  as it keeps the epoch. No `EV_*` event goes to the host.
- **`ConfigGeneration` (0x0fc)** reads `config_gen` while it is even. While it is odd the transport
  returns a value that differs at every read, so a driver's "generation, read config, generation"
  loop (Linux `virtio_cread` on a multi-field struct) retries until the host's update is done, and
  one that read a stable generation twice read a consistent config in parallel SMP.
- **Config writes by the guest** still land in `config` with `EV_CONFIG`; write-1-to-clear fields
  (virtio-gpu's `events_clear`) are the backend's to implement on that event.
- **Snapshots:** a device with `config_gen` ahead of what the transport raised isn't quiet (the
  host's change hasn't been taken), so a snapshot waits like it does for other events; nothing new is
  saved (a restore starts at generation 0, the interrupt state `isr` is saved already).

## Version history

| ABI | What changed |
|---|---|
| 4 | trap-to-EL1 and HVC exit kinds; EL1 state appended to `Cpu` |
| 5 | the whole-VM exports (`vm_*`), console rings, signal word, counters |
| 6 | virtio-mmio devices: `DeviceEntry`, `DevShared`, the `DEVICE` exit |
| 7 | realtime mode: `env.now_ms`, `IDLE` with a deadline |
| 8 | `simple-framebuffer`: `fb_width`/`fb_height`, `vm_framebuffer` |
| 9 | JIT plumbing: exported table, `env.jit_install` |
| 10 | `VmConfig.jit`; JIT counters |
| 11 | `jit_new` gains `check` (the stale-code checker) |
| 12 | inline counters |
| 13 | lazy-flag counters |
| 14 | chaining: block signature `(vcpu, acc, left)`, module `t` imports by table index |
| 15–17 | regions: region counters, back-edges, tier-up (`jit_hot`, `region_after`) |
| 18 | `jit_helper_report` |
| 19 | `VmConfig.features` (crypto extensions); `Cpu.features` |
| 20 | thread setup for more instances on one memory: `__stack_pointer`, `__tls_size`, `__tls_align`, `__wasm_init_tls`, `thread_alloc`, `tls_probe` (M7) |
| 21 | `VmConfig.ncpus` and `VmConfig.gic`; GICv3 the default (M7) |
| 22 | `vm_cpu(vm, i)` takes a vCPU index; `ExitInfo.cpu`; `ncpus` > 1 accepted on a GICv3 (deterministic round-robin) (M7) |
| 23 | the GICv2 dropped: `VmConfig.gic` 2 is refused (M7) |
| 24 | `VmConfig.jit` 3: JIT-check (M7) |
| 25 | parallel SMP: `VmConfig.smp`, `vm_run_cpu`, `vm_exit_cpu`, `vm_cpu_signal`, `ExitInfo.wake`, `vm_counters(vm, i)` per vCPU, counter word 90 (JIT stale blocks); `env.now_ms` is one clock for every instance (M7) |
| 26 | counter words 91–100: parallel SMP's DSB waits, broadcasts, drains, idles, platform-lock contention, WFEs, time out of the core (M7) |
| 27 | `panic_message() -> *const u8`: the first panic's message (BUG1) |
| 28 | `VmConfig.rtc`: a PL031 RTC in realtime mode |
| 29 | the firmware configuration (M8 phase B): `VmConfig.firmware`, `flash_size`, `fw_cfg`, `fw_cfg_len`; `vm_flash`; the PL031 in deterministic mode there |
| 30 | snapshots (M8 phase C): `vm_snapshot_size`, `vm_snapshot_save`, `vm_snapshot_restore`, `snapshot_version` (above); `lz_bound`, `lz_compress`, `lz_decompress` |
| 31 | config changes (M8 graphics): `DevShared.config_gen`, the config-change interrupt raised from the signal path, `ConfigGeneration` (above) |
| 32 | a fixed-size memory: `VmConfig.mem_pages`, `heap_reserve`; JIT modules import the memory with exact limits (M8 JIT) |
| 33 | the block interpreter: `VmConfig.jit` 4, counter words 101–103, `jit::Stats` gains three fields (M8) |
| 34 | `vm_set_chunk` (the PC sampler's chunk in parallel mode; M8 graphics G4) |
| 35 | FEAT_RNG and FEAT_E0PD: `VmConfig.features` bits 1 and 2, `VmConfig.rng_seed`; a snapshot of a VM with FEAT_RNG keeps each vCPU's stream position |
| 36 | `env.jit_compile`: the JIT's modules compiled in a worker of their own before the vCPUs install them |
| 38 | USB: `VmConfig.xhci`, `vm_xhci` (above, "USB"); the `DEVICE` exit's slot 32 for the xHCI |
| 39 | spill memories: `VmConfig.spill`, the `ram` imports; until S1 of the plan, devices take buffers in memory 0 only |
| 40 | device records name the memory: virtio segments are (offset, length, memory), the xHCI's length word carries it in bits 27:24 |
| 41 | `VmConfig.jit` 5 and 6: the JIT carrying its hot set across a flush and compiling it again, and that in a small cache (the tests); counters 108–110; `env.jit_release` |
| 42 | `vm_jit_emit`, `vm_jit_active`: the replay's modules emitted by the compile worker's own core instance; counters 111–123 |
| 43 | 41 and 42 taken out (the carry wasn't kept: [jit.md](jit.md) "Tried and not kept"): exports, imports, counters and `VmConfig.jit` as in 40 |
| 44 | `VmConfig.jit_bytes`: a machine's JIT code cache budget (the page's `?jitmb=`, a stored machine's JIT cache setting) |
| 45 | the page's memory signal: `vm_jit_gauge` (the JIT cache's state, and the host's limit on its budget), `heap_stats` |
| 46 | counter words 108–113: the JIT cache's lock and the time emission holds it |
| 47 | the core's heap bounded: `vm_jit_gauge` words 5–7 (`jit::GAUGE_WORDS` 8), counter words 114–118; an allocation that fails records a `panic_message` |
| 48 | counter word 119: jump-cache misses that found the JIT cache's lock held and ran their block interpreted instead of waiting ([jit.md](jit.md) "Sharing") |
| 49 | the host's type 11 strings: fw_cfg's `opt/webpc/oem-strings` (NUL-separated), which the core moves into SMBIOS type 11 (systemd credentials whose names don't fit fw_cfg's; the keyboard layout, [frontend.md](frontend.md)) |
| 50 | counter word 120: the ns the block map's prunes took; `heap_probe(size)`: an infallible allocation of `size` bytes, freed at once, so a test can run the heap out through the allocation error hook (tests/heap.test.ts) |
| 51 | FEAT_SHA512 and FEAT_SHA3: `VmConfig.features` bit 3 (`FEATURE_SHA3`, with bit 0); `ID_AA64ISAR0_EL1` SHA2 = 2, SHA3 = 1 |
| 53 | the host-visible window: `VmConfig.window` (memory 0's bytes after RAM), `DeviceEntry.shm` (6 u64s an entry), the transport's SHM registers for region 1, `vm_window_watch` (VK1, docs/plans/graphics.md) |
| 55 | the window in memory 1: `VmConfig.window_at`; memory 0 holds RAM alone (`vm_new`'s `ram`), memory 1 the bytes before the window (Venus's renderer), the window, then node 1's RAM; a device's (memory, offset) counts from the memory's first byte (VK4 T19) |
| 56 | `jit_exec_span(vcpu, pc, n, w0, w1, w2)`: `jit_exec_mmu` for up to six instructions, their words as constants; returns how many retired (a group of accesses' cold arm, docs/jit.md "Loads and stores") |
| 58 | `VmConfig.fma` and `jit_fma(v, on)`: the JIT's FMA forms on the host's fused relaxed-SIMD `madd` (`web/fma.ts`; docs/jit.md "Floating point") |
| 59 | FEAT_JSCVT, FEAT_LRCPC, FEAT_SB, FEAT_FlagM/FlagM2, FEAT_DIT, FEAT_FRINTTS: `VmConfig.features` bits 4 to 9; their ID fields (ISAR0 TS, ISAR1 JSCVT, LRCPC, FRINTTS, SB, PFR0 DIT) |
| 60 | FEAT_DotProd: `VmConfig.features` bit 10; `ID_AA64ISAR0_EL1` DP = 1 |
| 61 | FEAT_I8MM: `VmConfig.features` bit 11; `ID_AA64ISAR1_EL1` I8MM = 1 |
| 54 | PSCI SYSTEM_SUSPEND in realtime mode: `vm_suspended`, `vm_wake`, `vm_clock_skip`; snapshot format 3 (a suspended guest) and `snapshot_version_min` (2: format 2 states still restore) |
| 52 | a JIT module on a machine with spill memory imports spill memory 1 as `env.ram1` (`coreImports(…, spill)` passes them on): loads and stores reach its pages inline |
| 37 | `env.jit_install` takes the module's number: the vCPU instantiates the compile worker's compiled module, posted to it, instead of compiling the bytes again (−2: not arrived yet); counters 106–107 |
