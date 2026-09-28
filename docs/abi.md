# Host ABI (version 26)

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
- Imports: `env.memory`, `env.now_ms() -> f64` (the realtime clock), `env.jit_install(ptr, len,
  slot) -> i32` (below). `web/vm.ts` `coreImports(memory)` returns `{env, jit}`; after
  instantiating, the host calls `jit.bind(instance)`.
- **More instances on the same memory** (one per worker, ABI 20): the core exports
  `__stack_pointer`, `__tls_size`, `__tls_align`, `__wasm_init_tls` and `thread_alloc(size,
  align) -> ptr`. Another instance needs its own stack and TLS block, allocated through an instance
  that's already set up (`web/vm.ts` `threadAlloc`), and set **before any other call**
  (`instantiateThread`: `__stack_pointer` = the stack's top, then `__wasm_init_tls(tls)`); its
  start function finds the memory initialized. Instance 0 keeps the linker's static stack (1 MiB)
  and TLS. Each instance has its own function table, so each has its own JIT host and code.
  `tls_probe()` (a thread-local call count) lets tests check the TLS block is the instance's own.
  Tested with three concurrent instances (interpreter, JIT, JIT) in Node's `worker_threads` and in
  Chromium workers (`tests/threads.test.ts`, `tests/browser/threads.html`).

## Whole-VM exports

- `vm_new(ram: *mut u8, ram_size: u64, cfg: *const VmConfig) -> *mut Vm` (null on an invalid
  config); `vm_free(vm)`. RAM appears at guest PA `0x4000_0000`.
- `vm_boot(vm, kernel_pa, initrd_pa, initrd_len, cmdline_ptr, cmdline_len)`: the host has copied
  the kernel and initrd into RAM; the core writes the DTB and resets the vCPU at the kernel.
- `vm_run(vm, budget: u64) -> u32` (round-robin): an exit kind; details in `vm_exit(vm) -> *const
  ExitInfo` = {kind, steps retired (all vCPUs), value, x0–x3, cpu (the vCPU that exited, ABI 22),
  wake (ABI 25)}.
- `vm_run_cpu(vm, cpu, budget) -> u32` (parallel, ABI 25): runs vCPU `cpu` on the calling thread;
  `vm_exit_cpu(vm, cpu)` its `ExitInfo`; `vm_cpu_signal(vm, i)` vCPU *i*'s wake word (below).
- `vm_cpu(vm, i) -> *mut Cpu`, vCPU *i* (null past the last; registers at fixed offsets: X0–X30, SP, PC at 256, …, `features` at
  1056; `Cpu` is 1072 bytes, 16-byte aligned), `vm_console`, `vm_signal`, `vm_counters(vm, i)`,
  `vm_device(vm, i)`, `vm_framebuffer(vm)` (the framebuffer's PA, 0 if none).
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
| `jit` | 0 interpreter only (the ABI default), 1 JIT, 2 JIT-stress (10), 3 JIT-check (24) |
| `features` | bit 0 `FEATURE_CRYPTO`; other bits reserved, and `vm_new` refuses them (19) |
| `ncpus` | vCPUs, 0 or 1 = one; up to `vm::MAX_CPUS` (123) (21; more than one from 22) |
| `gic` | 0 or 3: the GICv3; `vm_new` refuses others (21; 2, a GICv2, until 23) |
| `smp` | 0 round-robin on the calling thread (`vm_run`), 1 parallel: a thread per vCPU (`vm_run_cpu`), realtime only (25) |

`bootVm` (`web/vm.ts`) and the native runners set `features` bit 0 unless told `crypto: false`;
the ABI's 0 means none.

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
| 91–100 | parallel SMP (26): DSBs that waited for TLBI IS, ns waited; TLBI IS and IC operations broadcast; queue drains that applied something; IDLE exits (WFI); platform-lock acquisitions that found it held, ns waited; WFEs (each a yield); ns out of `vm_run_cpu` between runs (idle or in the host) |

TLB hits stay uncounted: counting them in the fast path wasn't clearly free (one boot run +12%).

## Device backends

Layouts in `core/src/virtio.rs` and `web/devices.ts`; the behavior is in [devices.md](devices.md).
- `DeviceEntry` = 5 u64s: device ID, offered features (the transport masks the reserved bits
  24–40 and adds `VERSION_1` and `INDIRECT_DESC`), queue count (≤ 8), QueueNumMax (power of 2,
  ≤ 1024), config length (≤ 256). Every chain that can be in flight must fit the completion ring
  (queues × size × 2 ≤ 4096 words).
- `vm_device(vm, i) -> *const DevShared`: events u32 at 0 (`EV_REQUEST` 1, `EV_CONFIG` 2,
  `EV_STATUS` 4; the host takes them with a swap), device status at 4, negotiated features (two
  u32s) at 8, reset epoch at 16, config space (256 bytes; the host writes it after `vm_new`, guest
  writes land there with `EV_CONFIG`) at 24, request ring at 280, completion ring at 16672. Each
  ring is SPSC u32 words: head, tail (words written/read, wrapping), 4096 words.
- **Request record:** `w0` = head | queue << 16 | epoch << 24; `w1` = readable count | writable
  count << 16; then (offset from the start of guest RAM, length) per buffer, readable first.
  Offsets are RAM-relative so the words stay u32 natively; the host adds its RAM base.
- **Completion record:** `w0` as posted, then bytes written.

## JIT host interface

The translator is in the core ([jit.md](jit.md)); the host only turns bytes into a module and
puts its functions into the core's table.
- **Table:** the core's `__indirect_function_table` is exported and growable; Rust function
  pointers are indexes into it. `jit.bind(instance)` records `base` = the table's length then. The
  core owns **slot** allocation (slot *s* is table index `base + s`), so eviction reuses slots and
  the table stops growing at the code cache's size.
- **`env.jit_install(ptr, len, slot) -> i32`:** the host copies the bytes out of shared memory,
  compiles and instantiates them **synchronously** (`new WebAssembly.Module`/`Instance` in the
  vCPU worker), grows the table if needed, sets exports `f0, f1, …` at `base + slot + k`, and
  returns `base + slot` (−1 before `bind`: the core then only interprets). A module that doesn't
  compile is a JIT bug: the exception propagates and the run fails.
- **A JIT module's imports:** `env.memory` (limits 0–65536 pages), `env.table`, any core export by
  name (helpers are ordinary exports named `jit_*`, called as wasm imports: no JS in between), and
  module `t`, whose imports are named by table index and resolved with `table.get` (links to
  already-compiled blocks).
- Natively there's no wasm engine: `jit::install` returns `None` and the run loop interprets.
- `jit_helper_report(vcpu) -> *const u8`: NUL-terminated `<Op> <calls>` lines, most frequent
  first (`web/vm.ts` `helperReport`; the benchmarks record it).

## User-mode exports (corpus, differential tests, `bench/interp`)

`vcpu_new`, `mem_new`, `interp_run`, `interp_run_exit` (EL0-style exits, plus trap-to-EL1 and
HVC kinds and the EL1 state at the end of `Cpu`), and their JIT twins over a per-vCPU JIT state:
`jit_new(threshold, batch, capacity, check, region_after)`, `jit_run`, `jit_run_exit`,
`jit_flush` (for hosts that rewrite guest code between runs), `jit_stats`. These vCPUs always
have every optional feature. `jit_add_install`/`jit_call` are the JIT plumbing test.

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
  its code cache (created by `vm_new`, one per vCPU) holds table indexes of that instance.
  `vm_run` is for round-robin only. (The outline had a `vm_runner(vm)` per worker for the cache;
  a cache per vCPU made it unnecessary.)

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

**Broadcast maintenance in parallel mode** ([platform.md](platform.md) "Broadcast
maintenance"): `CPU features` gain an internal `FEATURE_PARALLEL`, under which DSB, ISB and ERET
end the chunk (`Exit::Resync`, retired) in both tiers (the JIT calls the helper for DSB), so the
run loop can apply what other vCPUs queued (context synchronization) and complete this vCPU's
own TLBI IS broadcasts before anything after its DSB runs.

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
