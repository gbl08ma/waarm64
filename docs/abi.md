# Host ABI (version 20)

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
- `vm_run(vm, budget: u64) -> u32`: an exit kind; details in `vm_exit(vm) -> *const ExitInfo` =
  {kind, instructions retired, value, x0–x3}.
- `vm_cpu(vm) -> *mut Cpu` (registers at fixed offsets: X0–X30, SP, PC at 256, …, `features` at
  1056; `Cpu` is 1072 bytes, 16-byte aligned), `vm_console`, `vm_signal`, `vm_counters`,
  `vm_device(vm, i)`, `vm_framebuffer(vm)` (the framebuffer's PA, 0 if none).

### `VmConfig` (u64 fields, in order)

| Field | Meaning (ABI that added it) |
|---|---|
| `ram_size` | bytes of guest RAM (5) |
| `deterministic` | non-zero: time from the step count; 0: realtime (5; realtime 7) |
| `cntfrq` | Hz, 0 → 62.5 MHz (5) |
| `ticks_per_insn` | counter ticks per step, 0 → 1 (5) |
| `devices`, `ndevices` | address and count (≤ 32) of `DeviceEntry`s (6) |
| `fb_width`, `fb_height` | a `simple-framebuffer`, 0: none (8) |
| `jit` | 0 interpreter only (the ABI default), 1 JIT, 2 JIT-stress (10) |
| `features` | bit 0 `FEATURE_CRYPTO`; other bits reserved, and `vm_new` refuses them (19) |

`bootVm` (`web/vm.ts`) and the native runners set `features` bit 0 unless told `crypto: false`;
the ABI's 0 means none.

### Exit kinds

| Kind | Meaning |
|---|---|
| 0 `BUDGET` | the budget is used up |
| 1 `PSCI` | a PSCI call for the host (SYSTEM_OFF, SYSTEM_RESET; M7 handles CPU_ON in the core). PC is past the HVC; the host writes x0 if it resumes |
| 2 `IDLE` | WFI with nothing pending, realtime mode only: `value` = ns to the next timer deadline (u64::MAX: none); PC on the WFI. (Deterministic mode jumps virtual time instead, and returns `IDLE` with u64::MAX only when no timer is armed) |
| 3 `TX_FULL` | the console TX ring is full: drain and resume |
| 4 `UNIMPLEMENTED` | `value` = the `Op` index |
| 5 `STOP` | a stop was requested through the signal word |
| 6 `DEVICE` | `value` = slot \| events << 8 (informational: every device's events are in its `DevShared`); PC past the register access |

### Signal word and console

- `vm_signal(vm) -> *const AtomicU32`: bit 0 `SIGNAL_STOP`, bit 1 `SIGNAL_RX`, bit 2
  `SIGNAL_DEVICE`. Checked between chunks and on WFI. Whoever sets a bit `Atomics.notify`s it.
- `vm_console(vm)`: two SPSC byte rings (TX, RX), 4 KiB each, atomic head/tail. The PL011 writes
  TX; the host drains it after each `vm_run` and fills RX from any thread.

### Counters (`vm_counters`, u64 words, relaxed atomic stores; `web/vm.ts` `Counter`)

| Words | What |
|---|---|
| 0 | steps retired |
| 1–64 | exceptions by EC |
| 65 | IRQs taken |
| 66–69 | TLB hits (not counted: 0), misses, walks, flushes (published once per chunk) |
| 70 | current PC, published at every chunk end (the PC sampler reads it) |
| 71–89 | `jit::Stats`: regions compiled, modules, wasm bytes, compile ns, steps in JIT code, dispatches, invalidations, flushes; instructions compiled inline and as helpers, inline steps run; static flag setters stored/elided, conditions direct/computed/from memory; blocks in regions, back-edges, tier-ups |

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

The whole set was called "ABI 20" in the kickoff; each commit that changes the exports bumps the
version (20: the thread setup exports). Pre-approved on the outline in `M7-KICKOFF.md` (decision 7); written before the code, and
revised here if the code teaches otherwise. With `ncpus` ≤ 1 and the defaults, a host that
passes CPU index 0 everywhere sees today's machine (except the GIC, which becomes GICv3 by
default in loop 2).

**Two ways to run the vCPUs.**
- *Round-robin* (`VmConfig.smp` = 0, the default; deterministic or realtime): `vm_run(vm,
  budget)` runs every vCPU on the calling thread, one quantum (`CHUNK` steps, cut at the next
  timer deadline in deterministic mode) each in index order, skipping vCPUs that are off or idle.
  `budget` counts the steps of all vCPUs. One code cache serves them all (block code takes the
  `Vcpu` pointer). In deterministic mode virtual time is the total steps of all vCPUs
  (× `ticks_per_insn`, plus WFI skips), one counter for every CPU; the run returns `IDLE` only
  when every on vCPU is idle (time jumps to the earliest deadline first).
- *Parallel* (`smp` = 1, realtime only; `vm_new` refuses it with `deterministic`): one thread
  (worker) per vCPU, each with its own core instance on the shared memory and its own code
  cache. Each worker calls `vm_run_cpu(runner, cpu, budget)` for its vCPU.

**Many core instances on one memory** (done, ABI 20): "Instantiation" above.

**`VmConfig`** (appended u64 fields; 0 keeps today's meaning):

| Field | Meaning |
|---|---|
| `ncpus` | vCPUs, 0 or 1 = one; at most `vm::MAX_CPUS` |
| `gic` | 0 the default (GICv3 from loop 2), 2 GICv2 (≤ 8 CPUs), 3 GICv3 |
| `smp` | 0 round-robin on the calling thread, 1 parallel (one thread per vCPU; realtime only) |

**Exports that change or appear.**
- `vm_run(vm, budget)`: round-robin mode (as today for one vCPU). `vm_exit(vm)` gains `cpu` (the
  vCPU that exited, appended to `ExitInfo`).
- `vm_runner(vm) -> *mut Runner`: parallel mode, once per worker after its thread setup: this
  instance's code cache (the JIT installs into this instance's table). `vm_run_cpu(runner, cpu,
  budget) -> kind` runs vCPU `cpu` until an exit; `vm_exit_cpu(vm, cpu)` its `ExitInfo`.
- Per vCPU: `vm_cpu(vm, i)` (the `Cpu`), `vm_counters(vm, i)` (a counters block per vCPU: the
  host sums them for totals; the JIT words describe the code cache that runs vCPU *i*, so in
  round-robin mode they're in block 0 only and the sum is the total either way), `vm_cpu_signal(vm,
  i)` (below). Existing calls pass `i` = 0.
- **Signals.** The VM's signal word (`vm_signal`) keeps STOP, RX and DEVICE. Each vCPU also has a
  wake word, the only word its worker sleeps on (`Atomics.wait`, in `IDLE` and while the vCPU is
  off): whoever sets a VM signal bit must also bump every vCPU's wake word and notify it (the
  host's `signal()` does both), so a wake-up can't fall between a check and the wait. The core
  bumps and notifies wake words itself for what it raises (SGIs, SPIs routed to a vCPU, CPU_ON,
  SEV, a TLBI broadcast waiting on idle vCPUs).
- **Exit kinds per vCPU:** `IDLE` for an off vCPU has `value` = u64::MAX until PSCI CPU_ON (in
  the core) starts it; SYSTEM_OFF/RESET from any vCPU exits `PSCI` on that vCPU's thread, and the
  host stops the others with STOP. `TX_FULL` and `DEVICE` exit on whichever vCPU hit them.
- Shared device state (the GIC distributor, the PL011 and console rings, the virtio transports,
  device completion draining) sits behind one lock in the core in parallel mode; the console's
  TX ring stays single-producer because PL011 writes hold it.

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
