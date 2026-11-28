# The platform: memory map, boot, run loop, broadcast maintenance, time, GIC, timer, UART, PSCI

The machine around the CPU, as built. Devices that need no host (the GICv3, generic timer,
PL011, the PL031 RTC, PSCI, the virtio-mmio transports) live in the Rust core (`core/src/vm.rs`,
`gicv3.rs`, `pl011.rs`, `pl031.rs`, `virtio.rs`), so native runners and wasm share them. virtio backends are in
[devices.md](devices.md); the host ABI in [abi.md](abi.md).

## Memory map (QEMU `virt`'s)

Chosen so kvm-unit-tests runs with its defaults and traces line up with the QEMU oracles.

| PA | What |
|---|---|
| `0x0400_0000` | CFI flash bank, the firmware configuration's variable store (`flash_size`), firmware only |
| `0x0800_0000` | GIC distributor (64 KiB) |
| `0x080a_0000 + 0x2_0000·i` | GICv3 redistributor of CPU *i* (RD_base, then SGI_base) |
| `0x0900_0000` | PL011 UART (SPI 1, INTID 33) |
| `0x0901_0000` | PL031 RTC (SPI 2, INTID 34), realtime mode or the firmware configuration |
| `0x0902_0000` | fw_cfg (data, selector, no DMA), firmware only |
| `0x0a00_0000 + 0x200·i` | virtio-mmio transport *i* (≤ 32; SPI 16+i, INTID 48+i) |
| `0x0c00_0000` | xHCI (64 KiB, `generic-xhci`; SPI 48, INTID 80), with `VmConfig.xhci` only ([usb.md](usb.md)) |
| `0x4000_0000` | RAM (`vm::RAM_BASE`), size from `VmConfig.ram_size` |
| right after RAM | the host-visible window (`VmConfig.window`, ABI 53): memory 1's bytes at `VmConfig.window_at` (ABI 55), outside `/memory`, a virtio transport's shared memory region 1 (virtio-gpu's Venus blobs; docs/devices.md "virtio-gpu") |
| past them, from the next 1 GiB boundary | spill memories' RAM (`VmConfig.spill`), each NUMA node *k* at the 1 GiB boundary past the RAM before it ([spill-memories.md](spill-memories.md)) |

- An access to a PA with no device is an **external abort** (QEMU TCG agrees; QEMU under hvf
  makes it RAZ/WI).
- **Device MMIO never touches the interpreter's fast copies:** an access to a non-RAM PA faults
  there, and the run loop re-executes that one instruction on a third `Bus`, `vm::Io`, which sends
  it to the device (handlers read before they write registers, so the retry is exact). The JIT
  reaches the same path: a helper that hits a non-RAM PA reports `Exit::Fault(Bus)`, which parallel SMP's realtime
  run loop finishes in the helper (docs/jit.md "Device accesses"). A device page's translation is cached in the TLB
  (docs/cpu.md "Pages with no RAM behind them"), so neither try walks the tables.

## Boot (`core/src/boot.rs`, `core/src/fdt.rs`)

- **Direct kernel boot**, no UEFI: the host copies an arm64 `Image` (and initrd) into RAM;
  `vm_boot` checks the `Image` magic and 2 MiB alignment, writes the DTB into **the top 2 MiB of
  RAM** (the initrd must sit below it), and starts the vCPU in its EL1 reset state at the Image
  with x0 = DTB (booting.rst). A headerless kernel (kvm-unit-tests' `.flat`) is entered at its
  first byte, as QEMU does. Distro kernels and initrds are extracted from their images and booted
  the same way.
- **The firmware configuration** (`VmConfig.firmware`, M8 phase B; [abi.md](abi.md) "M8 phase
  B"): the same boot with EDK2's ArmVirtQemuKernel (`QEMU_EFI.fd`, `images/build.sh edk2`) as
  the `Image`, at RAM + 512 KiB (its `text_offset`), no initrd, and EDK2 boots the disk's own
  loader (shim and GRUB, Limine). The DTB stays in the top 2 MiB: EDK2's first act is to copy
  it into the 32 KiB after its image header, before it allocates anything (`vm_boot` refuses a
  bigger DTB there). The DT's `/memory` ends at the framebuffer (or the DTB space), so EDK2,
  which allocates down from `/memory`'s top and ignores `/reserved-memory`, never lands on
  them, and Linux maps the framebuffer as non-RAM (simplefb or simpledrm bind to it); the DT
  gains the flash bank (`cfi-flash`, which EDK2 marks disabled for Linux), fw_cfg and the PL031.
  `tests/dtb/waarm64-firmware.dts` is its decompilation.
- Runner conventions: the Image at RAM + 2 MiB and the initrd at + 128 MiB; raw binaries
  (bare-metal tests) with `kernelOffset: 0`. 256 MiB for Buildroot, 512 MiB for LTP, 1 GiB for the
  distros.
- **The DTB is our own small FDT writer** (not `vm-fdt`): RAM, a PSCI (HVC) `cpu@<affinity>`
  node per vCPU, the GIC (`arm,gic-v3`, one redistributor region), `arm,armv8-timer` (level-high
  PPIs), a 24 MHz fixed clock, the PL011, the PL031 (realtime mode only), one `virtio,mmio` node per device in slot
  order (`dma-coherent`, a **level-high** interrupt: QEMU says edge-rising, but our line follows
  InterruptStatus), and the framebuffer ([devices.md](devices.md)). `tests/dtb/waarm64.dts` is its
  `dtc` decompilation (two vCPUs), checked by a unit test.
- Guest RAM is sized against host RAM at VM start: Chromium gives no catchable error when host RAM
  runs out (the renderer is OOM-killed).

## The run loop (`vm::Vm::run`)

Two ways to run N vCPUs, one core: **deterministic round-robin** on one thread (tests: exact
steps in every runner) and **parallel SMP**, a thread per vCPU (users and the scaling curve;
realtime only). With one vCPU both are the machine as it was before M7.

**N vCPUs, deterministic round-robin** (`VmConfig.ncpus`, M7): `vm_run` runs every vCPU on the
calling thread, a **quantum** (`QUANTUM` = `CHUNK` steps) each in index order; a vCPU that's off
(PSCI) or waiting in WFI is passed over. The JIT (its one function table, on the code cache every
VM shares among its vCPUs: [jit.md](jit.md) "Sharing") lives in vCPU 0's `jit.cache` and moves
into whichever vCPU runs a chunk (block code takes the `Vcpu` pointer). Virtual time counts the
steps of all vCPUs; timer deadlines of every on vCPU cut chunks. A WFI with no interrupt signaled
waits (PC on it) until one is; when every vCPU waits, deterministic time jumps to the earliest
deadline and the vCPUs it was for complete their WFI; with none (or in realtime mode) the run
returns `IDLE`. With more than one vCPU (`cpu::FEATURE_SMP`): **WFE** ends the quantum unless the
vCPU's event (SEV, SEVL) is set, which it consumes; **TLBI … IS** is done on every vCPU's TLB
at once (the others aren't running). With one vCPU the quantum is unbounded, WFE and SEV are
NOPs, and every step count is what it was before M7.

- `vm_run(vm, budget)` (and parallel mode's `vm_run_cpu`) runs **chunks of at most `CHUNK` = 32,768 steps** (instructions retired
  plus exceptions taken), cut at the next timer deadline in deterministic mode so timers fire on
  their exact tick. Each chunk goes through `jit::steps` when the JIT is on, else `interp::steps`. Parallel SMP's
  compiled code isn't counted: a chunk ends at the first poll past its steps, or sooner when the vCPU's stop word
  drops ("Parallel SMP" below).
- **Between chunks:** the signal word, device completion rings, the interrupt lines into the GIC,
  and IRQ entry (vector +0x80) when `PSTATE.I` is clear. The steps and the PC are published at every chunk's end,
  the JIT's and the TLBs' counters every 65,536 steps and at the run's end (`JIT_PUBLISH`, as parallel SMP does;
  at every chunk's end the ~40 words cost ~40 ns a call, ~0.5% of the gates: PERF loop 88).
- **An MSR or ERET that unmasks IRQs ends the chunk** (`Exit::Resync`), so a pending IRQ is taken
  right after it. Under the JIT, deterministic round-robin keeps an unmasking MSR inline while no IRQ can be pending
  and no host signal has arrived ([jit.md](jit.md) "Emission", `jit::Unmask`); realtime round-robin never does, as a timer comes due and devices
  signal mid-chunk (the exit is what takes their IRQ at once; `tests/baremetal/unmask.c`). In the same chunks
  (`Unmask::ok`, no host signal pending) an ERET's `Exit::Resync` and the synchronous exceptions the dispatcher
  returns (SVC, aborts but an MMIO access's) are finished in place too, by round-robin's fast completions
  (`vm::rr_fast`, through `jit::State::fast` as parallel SMP's): the ERET's block goes on, an exception is taken
  and counted as `Vm::exception` would, and the dispatcher goes on from the new PC, as the next chunk would have
  (PERF loop 88: the gates' chunk ends 1.36 M → 0.72 M in the userspace benchmark, 0.60 M → 0.22 M in Alpine's
  boot; `tests/baremetal/eret.c`). That makes the chunk size invisible to deterministic guests: every suite takes
  identical steps at any `CHUNK` from 1024 to 131,072. (It was 1024 until M6, when ERET didn't end
  the chunk; the fix let `CHUNK` grow 32×, which cut Alpine's JIT boot by 14%: hot JIT loops return
  to the run loop far less often.)
- Exits to the host: [abi.md](abi.md) "Exit kinds".

**Parallel SMP** (`VmConfig.smp` = 1, realtime only; `core/src/vm/parallel.rs`, ABI 25): a
thread per vCPU, each calling `vm_run_cpu` for its own vCPU in its own core instance (in the
browser a worker each, `web/vcpu-worker.ts`, coordinated by `web/coordinator.ts`; natively a `std::thread`
each, `core/tests/common` `run_parallel`). Each vCPU has its own code cache (blocks hold table
indexes of their instance).
- **Shared state** (the GIC, the PL011, the virtio transports, completion draining, PSCI power
  states and CPU_ON requests) is behind one lock, `Vm::plat` (a `Mutex`; round-robin reaches it
  through `&mut` without locking). Each vCPU drives its own timer PPIs (taking the lock only when a
  level changes; CPU_ON takes the levels from the GIC, so a line left high at CPU_OFF drops with the
  reset timer) and reads its IRQ line from an atomic that the platform code republishes after
  every change under the lock (`Vm::refresh`, which also wakes a vCPU whose line went up). A chunk
  boundary with nothing new takes no lock: the signal word, the maintenance flag, the clock, the
  timer levels, the IRQ atomic.
- **Signals:** RX and DEVICE are taken by the first vCPU that sees them (`fetch_and`); STOP isn't
  cleared by the core (every vCPU must see it). A host signal wakes every vCPU, and the idle ones that find it taken
  return `IDLE` again with nothing retired: counted (PERF loop 83), ~300 such exits a second in Firefox's pages
  session, 240 in a 4-vCPU boot, under one an idle guest's (whose idles end at their timers), ~1.7% of one host core at
  most on the Mac (each ~11 µs in the core plus its poll). Waking one taker instead would need its own no-missed-wake
  argument and a taker that isn't stalled; skipping the poll after such an exit gains less still, and those polls end
  in a wake-up as often as any (16% against 12% on the pages session): neither is built. **Wake words:** a vCPU with nothing to run
  returns `IDLE` with its wake word as read *before* it looked for work; everything that makes
  work for it (an interrupt line going up, CPU_ON, a drained queue it waits on, a host signal)
  changes that state first, then bumps the word and notifies it, so the host's `Atomics.wait(word,
  wake)` can't miss a wake-up.
- **WFI** returns `IDLE` (value: ns to the vCPU's own deadline) unless an interrupt is signaled
  to it (the worker polls its wake word for 20 µs before `Atomics.wait`, `SPIN_MS`: a wake-up that comes soon, like the
  atomics stress's pingpong's futex hand-offs, is caught without a futex wake, ~11 µs a round on the Mac with a poll of
  10-100 µs and 2.5× that with none, the dev VM's needing 20; every other idle pays the poll whole, and only 12% of
  them ended in a wake-up in Firefox's pages session, so 20 µs instead of M7 loop 8's 50 took 2.8% off the pages
  session's renderer CPU and 12% off an idle guest's, the guest's speed unchanged; none took twice that but slowed the
  hand-offs: bench/boot/REPORT.md "PERF loop 83"), then sleeps to its deadline by
  waits of 2/3 of the time left and a spin of the last 40 µs (`web/idle-wait.ts`, PERF loop 58): a timed wait comes
  back late by a share of its timeout (macOS's timer leeway: in Chromium ~130 µs at the median of a ~1 ms wait, ~470 µs
  of ~4 ms, up to ~50% at the p99; in Node's workers there nearer 50%; Lima's Linux ~180 µs), so one wait to the
  deadline had a vCPU see its own timer in WFI 0.3-2.4 ms late on average in the Mac's Node, and the shares bring that
  to 11-29 µs (the dev VM's 290 µs to 90 µs). Its cost: an idle 4-vCPU guest (~400 idles a second) takes ~0.7% more
  of one host core on the Mac (medians 8.1 → 8.9%), ~2% in the dev VM (11.6 → 13-14%); the gates and Firefox's pages session
  don't move. Tried: a share of 1/2, 6-7 µs late for +3% of a core
  (more waits); 3/5, 8 µs for +2%; 3/4, ~95 µs (its waits overshoot); a sleep instead of the tail's spin, ~15 µs for
  no less CPU (bench/boot/REPORT.md "PERF loop 58"). The deadline counts from `vm_run_cpu`'s return (what the worker
  does after it isn't added); the core's own path from its clock reading to the return isn't covered (an absolute
  deadline in the exit record would be an ABI change, not worth it for that: PERF loop 60). An off vCPU (no deadline)
  waits a second at a time. **WFE** is a
  yield (it ends the chunk, as QEMU's MTTCG does), and SEV does nothing (no vCPU sleeps in WFE):
  a vCPU can't cheaply see the store that clears another's exclusive monitor, which is what
  wakes Linux's LDXR + WFE waits on hardware. Counted, a sleep isn't worth it (2026-11-10, bench/boot/REPORT.md
  "PERF loop 15"): Firefox's pages session (4 vCPUs, 218 s) yields 1.92M times, ~2.2K a second a vCPU; a yield is
  an exit with nothing to do (~65 ns in Node on the dev VM, up to the ~240 ns of a desktop-guest exit), so the spins
  that end in one are ≤0.2% of the session's 263 busy vCPU-seconds, and with 4 vCPUs the host has cores to spare
  for the spinner.
- **The stop word** (PERF loop 31; [jit.md](jit.md) "Preemption", [abi.md](abi.md) "PERF: the stop word"): the
  JIT's code in parallel SMP has no step budget; where a cycle can close it compares its steps with the vCPU's stop
  word (`jit::State::stop`, in its `Vcpu`), and so does the dispatcher before each block. The run loop stores the
  chunk's steps there at the top of each pass, before it reads the signal word, the IRQ line, the queue and the
  timers; whatever makes work for the vCPU stores 0 there after making it: `Vm::wake` (an interrupt line raised by
  `Vm::refresh`, a CPU_ON, a drain that a waiter waits for, `Vm::signal`), `broadcast` for each vCPU whose drain the
  issuer's DSB will wait for, and the host after setting a signal bit (`web/vm.ts` `raise`, the device backends'
  `kick`). A store that lands before the run loop's is seen by its reads; one after stops the chunk at its next poll.
  What has no event (the vCPU's own timer deadline, the xHCI's due time, the worker's event-loop visit, the periodic
  publications, the PC sampler) stays paced by the chunk's steps as before: a vCPU that loops with no exit ends a
  chunk within a poll of 32,768 steps. A ticker that let chunks run longer didn't pay (PERF loop 32: a chunk end
  costs ~0.2 µs, and it's where the vCPU sees its timer and installs compiled modules; [jit.md](jit.md) "No ticker"). The spin tests (`tests/baremetal/spin.c`, `tests/spin.test.ts`) time what a
  looping vCPU answers. Against the counted code before it, on Firefox's pages session (the Mac, PERF loop 35):
  Firefox's starts and the pages' loads −4.7%, busy MIPS +3.4%, and the time issuers' DSBs waited for TLBI IS −83%
  (639 → 107 ms a session: a target stops at its next poll instead of its chunk's end).
- **The worker's event loop:** at the first exit 100 ms after its last return (`VmOptions.vcpuYieldMs`, 0
  never), a vCPU worker returns to its event loop (`web/idle-wait.ts` `turns`): a sleep (IDLE) waits there with
  `Atomics.waitAsync` instead, a BUDGET or DEVICE exit waits a µs on its wake word (so a wake-up ends it). The tasks V8
  and Blink post to the thread run then (Oilpan's sweeping); never returning left them to V8's next major GC, which
  did them all at once on the vCPU ([v8.md](v8.md) "Threads that never return to their event loop"). A return counts
  only when the wait went to the event loop (`waitAsync` returns at once, with no task, on a word already moved or a
  timeout of 0: an IDLE woken within its poll would otherwise use up the return). The event-loop wait's timeout is a
  delayed task, late by a time of its own rather than a share of the timeout (Chrome on the Mac: ~0.6 ms on average,
  ~2 ms at the p99), so an IDLE spends the return there only when the wait can end 2.5 ms before the deadline
  (`LEAD_MS`: half the time left, at most the time left less 2.5 ms; `sleepUntil` does the rest); shorter idles leave
  it due for a later exit, and once it has been due 100 ms more (`OVERDUE_MS`: a vCPU whose idles are all short) the
  next idle takes it anyway. Before, the half-time wait ended past short deadlines: in Chromium on the Mac a vCPU saw
  its timer in WFI 205 µs late on average on one vCPU (17-19 µs on 2-4), 49 µs (10-13) since (bench/boot/REPORT.md
  "PERF loop 60").
- **CPU_ON:** the caller records the request under the lock and wakes the target; the target's
  own thread applies it (no thread writes another's registers), marking itself on under the same
  lock (between taking the request and marking itself on, a second CPU_ON once saw it off: the
  bare-metal `smp` test's check 4 caught it, 1 run in 30).
- **DSB, ISB and ERET end the chunk** (`cpu::FEATURE_PARALLEL`: `Exit::Resync` in the interpreter;
  the JIT calls the helper for DSB, and ISB and ERET were helpers already): the run loop drains
  the vCPU's queue there (context synchronization) and completes its TLBI IS broadcasts. A vCPU that loops with no
  exit reaches no chunk boundary of its own: the issuer's TLBI IS stores 0 in its stop word (above). With one
  vCPU, parallel mode booted Alpine as fast as round-robin realtime in Node (10.28 vs 10.21 s),
  though the boot runs 584K ISBs and 209K ERETs.

## Pausing a VM (`web/vm.ts` `pause`, `resume`)

A snapshot needs every vCPU out of the core and the backends done with every request they
don't hold. `pause()` gets there without ending anything: the vCPU workers keep their core
instances, function tables and JIT code caches. It resolves true once nothing runs guest code and
nothing writes guest RAM (until `resume()`), false if the machine ended meanwhile (an exit that
ends the run, a closed VM); `resume()` without a pause does nothing, and a second `pause()` is the
same pause.
- **Parallel:** the coordinator makes the pause word (scratch page, `S_PAUSE`) odd, a generation,
  and raises STOP (which also bumps the wake words, so idle and off vCPUs wake). A worker that
  gets `STOP` with the word odd writes that generation to its own parked word, bumps the
  coordinator's `ctl` word and `Atomics.wait`s on the pause word until it changes; with the word
  even, STOP ends its run as before. The coordinator waits for every parked word to equal the
  generation (`Atomics.waitAsync` on `ctl`: it never blocks, since the backends may be on its
  thread), then clears STOP (every worker waits on the pause word, so none can miss it), then rings
  the doorbell and waits asynchronously until the backends served it (`bell[1]` reaches the
  rung value). `Devices.serve` awaits every asynchronous request, so what is left in flight is
  what the backends hold (receive buffers, input events). `resume()` makes the word even and
  notifies it. A generation instead of a flag and a count means a late or stale parked word of an
  earlier pause is never mistaken for this one's. A parked worker isn't inside `vm_run_cpu` or
  handling an exit for the liveness block, so it doesn't look stuck. An exit or error that ends
  the machine releases the paused workers (the word goes even) and the pause resolves false;
  `close()` does the same, so a paused or pausing VM ends its workers. The doorbell's wait stops on the backends'
  close too: a closed `Devices.serve` answers no ring, so a `close()` that lands after the doorbell rang would otherwise
  leave the pause pending for good.
- **`runAsync` while paused** keeps returning `BUDGET` (the caller's loop stays alive) after a
  short wait, and the idle limit doesn't count the paused time (the progress clock restarts at
  `resume()`).
- **Round-robin:** the vCPUs are out between `run` calls, so `pause()` only settles the devices
  (a doorbell ring waited on, with a device worker) and `resume()` does nothing. It leaves the
  step count exact.

## Broadcast maintenance

Round-robin makes it synchronous: **TLBI … IS** flushes every other
vCPU's TLB in the run loop (`Exit::TlbiIs`) before anything else runs, and `IC IVAU`/`IC
IALLU(IS)` invalidate the one code cache all vCPUs share (in either mode). JIT code holds no translation of its
own that a TLBI would have to reach: cross-page chains check the running vCPU's instruction TLB,
and blocks are keyed by PA. The bare-metal `maint` test covers every IS flavor and both ICs across
4 vCPUs (on QEMU and hvf too). In **parallel mode**:
- Each vCPU has a queue of TLB operations under a lock, an atomic pending flag checked at every
  chunk boundary, and `queued`/`applied` counts. An issuer pushes to every other vCPU's queue: up
  to 64 TLB operations, then the queue collapses into one flush (`parallel::Collapsed`) of as little as covers
  every operation it held and every one that comes before its drain: **the nG entries** while all of them are by
  ASID or by a VA of the TTBR0 half, **everything** once one is VMALLE1IS or by a VA of the TTBR1 half. The drain
  applies it: a TLBI of the TTBR0 half names nG entries only when the TLB holds no global entry there, which the
  draining vCPU knows (`Tlb::low_global`, below: a firmware's or a bootloader's identity map), so with one it drops
  everything. A vCPU that doesn't drain (idle, or out of the core) is what collects 64: in a Firefox pages session
  on 4 vCPUs (PERF loop 72: 398 K TLBI IS, all but 484 by a user-half VA or an ASID) 231 K drains found a list
  (68% of one operation, 87 of all 64) and 2,398 a collapsed queue, 2,392 of those with only user-half VAs and
  ASIDs. Until PERF loop 73 a collapsed queue dropped everything: every flush of everything in the session, ~2,000
  of the kernel's global entries each time that no queued operation named. Now (bench/boot/REPORT.md "PERF loop
  73") the session has 8 flushes of everything, a TLB at a collapse holds ~31,000 global entries, and EL1's misses
  fell from 7.0 M to 2.75 M (its instruction misses 867 K → 14 K; the sibling fill, [cpu.md](cpu.md) "MMU and TLB",
  has a part in the data arrays'). 155 operations arrive at a collapsed queue on average, so a longer queue
  wouldn't do. `a_collapsed_tlbi_queue_of_user_operations_keeps_the_global_entries` (core/src/vm/tests.rs) runs
  the TLBIs on one vCPU and drains another: lists under 64, a collapse of user operations (the nG entry gone, the
  kernel's kept), a kernel-half VA or VMALLE1IS before the collapse, at it and after, and a TLB with a low global
  entry. Planted, each caught: the drain ignoring `low_global`, an operation after the collapse not widening it,
  the collapse not looking at its list or at the operation that overflowed it, VMALLE1IS taken for a low
  operation, a collapse that drops nothing.
- **IC IVAU and IALLU(IS)** drop the blocks from the shared code cache on the issuing vCPU, and
  every other vCPU's function table catches up before its next block ([jit.md](jit.md)
  "Sharing"): nothing is queued. Before the cache was shared, each vCPU had its own and a queue of
  code pages: Linux cleans a page with an IC IVAU per 64-byte line, and an idle vCPU collected the
  pages of every exec page fault elsewhere, so queues of 64 addresses, then of 64 pages, collapsed
  into whole-cache flushes often enough to compile 6×, then 3×, the blocks of a one-vCPU Alpine
  boot on two vCPUs (1.7× with distinct pages, up to 1024: each vCPU compiled what it ran).
- A vCPU applies its queue at every chunk boundary, and when it enters `vm_run_cpu`, before it
  runs anything. A TLBI IS that its issuer's DSB will wait for also stores 0 in the target's stop word, so a target
  looping in compiled code ends its chunk at its next poll instead of the chunk's end.
- **The issuer's DSB after TLBI IS waits** until each target has applied the operations or isn't
  running guest code: a vCPU is `RUN` inside `vm_run_cpu` and `OUT` once it returns to the host
  (idle or anywhere else: it drains on re-entry, having set `RUN` first, sequentially consistent
  against the issuer's push and check), or `OFF`. The waiter drains its own queue while it waits
  (two issuers can't deadlock), sleeps on its wake word in 1 ms steps (a vCPU that drains wakes
  the vCPUs flagged as waiting), and panics after 10 s of *waiting* (a bug). It counts time only
  for passes of its loop shorter than 100 ms: a longer pass means its own worker thread stalled
  (descheduled, paused, a GC), which says nothing about the vCPUs it waits for, and the loop looks at
  their state again right after it. Those passes are reported apart (`DsbBudget`, parallel.rs), and
  ten limits of wall time end the wait whatever the passes were. A waited vCPU frozen in `RUN`
  still ends it after 10 s (tests/hoststall.test.ts).
- IC operations don't wait: the architecture promises another PE the new code only
  after a context synchronization event *that follows its seeing the change*, which ends the chunk
  here, or under the JIT a fast-completed ISB (docs/jit.md "Fast completions") exits to the dispatcher
  when the vCPU's table is behind the cache's drops (`Jit::behind`): completed in place, it chained on
  into the old code (`isb.c`: 3-8 stale calls in 8 rounds before the fix, 2026-11-03). Its cost, counted in
  Firefox's pages session (4 vCPUs, 218 s; bench/boot/REPORT.md "PERF loop 15"): 13.85M ISBs read the two counters
  and 5.9K exit for them, ~15 ms of 263 busy vCPU-seconds; the userspace benchmark on 4 vCPUs on the Mac without
  the check was even with it (rounds overlapping). `maint.c` had
  its ISB before waiting for the rewrite: parallel mode ran the old code (401), and the test was fixed
  (QEMU TCG and hvf pass it either way).
- **The stale-code checker tolerates** stale blocks in parallel mode (`jit::Cache::tolerant`:
  code another vCPU rewrote is legal to run until this vCPU's next context synchronization): it
  drops the block at the run loop's entry and counts it (`JIT_STALE`, counter word 90), and only
  counts mid-chain; a block another vCPU's IC already dropped passes. Only round-robin runs trap.
- **Only vCPUs that may hold the entries are waited for:** TLBI ASIDE1IS, VAE1IS and
  VALE1IS of a TTBR0-half address are for one ASID, and a vCPU's TLB holds nG entries of its
  current ASID only (an ASID change drops them), so the DSB skips targets whose published ASID
  (`CpuPar::asid`, stored before each chunk; `ANY` with the MMU off) differs; they still apply the
  operation at their next boundary. That needs no global entries in the TTBR0 half, which a TLBI
  for any ASID drops: parallel SMP doesn't cache them (`Mmu::miss`; Linux maps nothing global
  there). The issuer fences between the guest's table stores and reading the ASIDs, the target
  between publishing its ASID and walking. **Firmware and bootloaders do map global entries
  there** (EDK2, shim and GRUB run on an identity map in TTBR0): not caching them made every
  access walk (a third of the steps before Debian's kernel missed the TLB: 70 s from EDK2's boot
  manager to GRUB's menu in Node, 3 s after). So a vCPU caches them, and while its TLB may hold
  one (`Tlb::low_global`, until a flush of everything) it publishes `ANY`, and every TLBI IS
  waits for it; the first such entry publishes `ANY` before the walk it caches, the order a
  TTBR write's new ASID follows. Planted out (no `ANY`), `maint` fails (262, 263). A write that changes the ASID or the
  MMU enable mid-chunk (MSR TTBR0/1_EL1, TCR_EL1's A1 or AS, SCTLR_EL1.M: `interp::sys`'s `write`, which the JIT's
  helper runs too) republishes it after its flush and before anything walks with it (`Tlb::republish`, a fence
  after): before its ISB a PE may already walk with the new TTBR, and a TLBI for the new ASID must wait for an entry
  walked so (`vm::tests` `a_tlbi_is_waits_for_a_vcpu_whose_asid_changed_mid_chunk`; planted out, it and
  `an_msr_that_changes_the_asid_or_the_mmu_republishes_it` fail). So an ISB after a TTBR write completes in place
  like any other (docs/jit.md "Fast completions"). A drain takes the queue and drops its lock before its flushes and
  wake-ups, so an issuer queuing for that vCPU doesn't wait for them. In
  the userspace phases on 4 vCPUs this cut the DSB waits from 92K (8.3 s over the vCPUs) to 3K
  (0.06 s) and process churn by 37% in Chromium (`bench/boot/REPORT.md` "M7 loop 8"): after a
  fork, parent and child have different ASIDs, so COW faults rarely concern another running vCPU.
  What remains (same-ASID targets, all-ASID and kernel-range TLBIs: 0.4% of the vCPUs' time in a
  `go build` loop) isn't worth shortening further ([jit.md](jit.md) "Tried and not kept").
  `maint` rounds 7 and 8 test it (another ASID; a global mapping), on QEMU and hvf too; planted
  out (global entries cached, or same-ASID targets skipped), `maint` fails (checks 261–263,
  212–213).
- Planted bugs: no DSB wait fails `maint` in all 20 native parallel runs (checks 211–213: stale
  translations); no IC broadcast fails it in all 10 JIT runs in Node (401, 402).

## Time

Two modes, chosen by `VmConfig.deterministic`:
- **Deterministic** (the default; tests, most benchmarks, reproducible bugs): the counter is
  steps × `ticks_per_insn` (default 1) plus ticks skipped by WFI, the steps of all vCPUs with
  more than one (one counter for every CPU). `CNTFRQ` defaults to 62.5 MHz
  (QEMU's). WFI completes when the GIC signals an interrupt (masked or not); otherwise virtual
  time jumps to the next armed timer deadline, and with none the run returns the idle exit
  (`value` = u64::MAX), PC on the WFI. A deadline at or past 2^62 ticks (`TIME_MAX`, centuries: a CVAL near 2^64,
  as a negative TVAL early on makes) counts as none: the counter would overflow a few steps past it, and a
  restore refuses a counter that far. **Every guest takes the same number of steps natively, in
  Node and in Chromium, interpreted or under the JIT**; tests assert those counts
  ([testing.md](testing.md) "Step counts"). Under the JIT a counter read is compiled from the step clock
  ([jit.md](jit.md) "Counter reads from the step clock"). The guest's tick runs at its HZ in steps: Alpine's
  linux-virt (HZ=1000) arms the virtual timer once per 62,500 steps (a guest millisecond at 62.5 MHz) and takes as
  many timer IRQs, each with two platform exits in the gates (ICC_IAR1, ICC_EOIR1; the five accesses of CTL and CVAL
  are compiled from the step clock: [jit.md](jit.md) "Timer registers from the step clock", bench/boot/REPORT.md
  "PERF loop 47" and "PERF loop 49"). Fewer ticks would need a guest-visible change (a higher CNTFRQ, or `ticks_per_insn`
  below 1), which moves every step count.
- **Realtime** (I/O benchmarks, `openssl speed`, interactive use): the core imports
  `env.now_ms()` (`performance.timeOrigin + performance.now()` of the thread that creates the VM
  in the browser and Node, which vCPU workers measure: below; `Instant` natively), read once per chunk and
  on timer-register reads; the counter is (host ns since `vm_new`) × CNTFRQ. Chunks aren't cut at
  deadlines, so a timer fires at the first chunk boundary past it (≤ one chunk late, ~0.1 ms of
  latency). A WFI with no interrupt signaled returns `IDLE` with the PC on the WFI and `value` =
  nanoseconds to the next deadline (u64::MAX: none), and re-executes on resume; `web/vm.ts` sleeps
  in `Atomics.wait` on the signal word until then (whoever sets a signal bit must
  `Atomics.notify` it), except on a page's main thread, which gets the exit.
  - `Vm::wfi` takes **one** clock reading (three readings once let a timer fall due between them
    and be neither pending nor a deadline, so the host slept forever).
  - **Parallel SMP:** every vCPU reads the clock itself; the core keeps the counter from going
    back between vCPUs (an atomic maximum of what any vCPU read). A vCPU worker doesn't trust its
    own `performance.timeOrigin`: Chromium derives a new context's from a wall clock, which
    drifted ~1% from the monotonic clock in the dev VM, so a worker started a minute into a page
    ran ~0.6 s behind the VM's creator, and the guest counter read 0 for that long ("Missing cycle
    counter", the RNG's jitter loop spinning). Each worker measures the creator's clock
    instead (`web/core.ts` `clockOffset`: 16 round trips, the shortest one's midpoint). The counter counts in Node's
    `runToPowerOff` too. Loop 15's exit loop seemed to show it standing still, but its own arithmetic overflowed:
    ticks × 10^12 passes 2^64 at 62.5 MHz past ~0.3 s. A phase's start plus its elapsed counter matches the host's
    time within 2 ms (bench/boot/REPORT.md "PERF loop 18").
  - **Idle watchdog:** `idleLimitMs` (`web/vm.ts`, on in the boot benchmarks) throws on an idle
    with no deadline for that long: a deadline-less idle that long is a bug either way.
- Guest-timed benchmarks (`dd`, `fio`, `openssl speed`) are meaningless in deterministic time:
  run them in realtime mode.

## Snapshots (`core/src/snapshot.rs`, `core/src/vm/state.rs`)

The core saves a VM's state without its RAM and restores it into a new VM of the same
configuration (ABI 30, [abi.md](abi.md) "M8 phase C: snapshots"). The host copies RAM and owns the file
(below, "The snapshot file").

- **The format** is an explicit little-endian serialization with a version of its own
  (`snapshot::VERSION`), not a memory dump: each part has a `save` and a `restore` (`Cpu`,
  `Gicv3`, `Pl011`, `Pl031`, `Flash`, `FwCfg`, `Transport`), and `vm/state.rs` writes the
  configuration it is tied to, time, each vCPU with its place in the run loop, and the devices.
- **A state is a file a user chose.** Every read is bounds-checked and every count has a limit; a
  register is masked as a guest's write to it would be (the `interp::sys` and device write
  masks), and a value no guest leaves behind (a PSTATE that isn't EL0t, EL1t or EL1h with DAIF,
  an exclusive monitor of an impossible size, a queue outside RAM) refuses the state. A unit test
  restores the state of a running machine with every byte changed in turn and runs what was
  accepted.
- **When:** with every vCPU out of the core and the devices quiet (no event, request or completion
  for the other side). `Vm::snapshot_size` takes the completions the backends left, exactly as
  the run loop would at its next boundary, so a deterministic machine that is saved and runs on
  takes the steps it would have.
- **A restored VM is the saved one with its TLBs emptied** (and its code caches, which no guest
  sees). That is architecturally invisible, and a deterministic guest restored twice runs the
  same twice; but its step count is the unbroken run's only if the guest never leans on a stale
  TLB entry. Linux does: it clears a page's access flag without a TLBI and takes the fault once
  the entry is gone. Buildroot's and Alpine's boots go through snapshots in an unbroken boot's
  steps; Alpine's userspace benchmark takes 1.1 M fewer of its 10.8 G, exactly the steps of a run
  whose TLBs are only flushed at the same points (`Vm::flush_tlbs`; `alpine-user-snapshots` in
  `tests/steps.txt`). Saving the TLBs instead was not tried: their entries hold host addresses,
  which a file must not supply, so each would be re-validated against the page tables at restore, most of a walk.
- **Buffers the backends hold** (receive buffers of net and console, input's event buffers) are
  in flight when the state is saved. Each queue keeps the heads of its in-flight chains in the
  order they were posted; a restore walks them again in the restored RAM and posts them to the
  request ring, so new backends hold them as the old ones did and need no state for it. A held chain the guest
  overwrote (it changed a buffer it had given a device) makes the machine unsaveable until that queue is reset
  (`vm_snapshot_size` = `u64::MAX`): only a broken guest does it.
- **Time:** deterministic, the step count and skipped ticks continue. Realtime, the clock
  continues from its saved reading (`Clock::base`), so the counter doesn't jump and timers that
  were due fire at once; it **stands at that reading until a vCPU first runs** (`Clock::start`, in
  `run` and `run_cpu`), and so does the saved VM's from the moment its state is taken (`Clock::hold`)
  until it runs on, so the saved and every restored machine go on from the same instant. A guest that was suspended
  (PSCI SYSTEM_SUSPEND, "System suspend" above) is restored suspended, until the host wakes it. The guest's wall
  clock after a restore is the guest agent's to set (frontend.md "The guest's clock"), not the core's. On the page
  the vCPU workers start ~130 ms after the state is restored and a save pauses the machine for as
  long as the file takes; a guest waiting with a shorter timeout (ALSA's wait for a sound period,
  100 ms) found it expired before it ran ([audio.md](audio.md) "Linux driver behavior"). The vCPU workers of a parallel VM start
  together: each waits on the start word (scratch page, `S_START`) until all are instantiated; the PL031 is rebased on the new VM's `rtc`, so it shows the host's time.
- **The host's half** (`web/vm.ts` `snapshot()` and `BootOptions.restore`, `web/snapshot.ts`): the
  file ([frontend.md](frontend.md) has the page's side when it lands) holds the core's state, the
  backends' (`Backend.save`/`restore` in `web/virtio.ts`: the deterministic rng's position; a
  virtio-gpu's resource table, scanout and cursor, whose pixels come back from the restored RAM,
  [devices.md](devices.md) "virtio-gpu"; 9p's in-memory tree refuses to be saved: [shares.md](shares.md) §6) with the serial input the guest hadn't been given, and
  RAM in 1 MiB chunks without their zero pages (the guest's free memory zero by then: the balloon's hint, devices.md
  "balloon"), compressed by the core's lz4_flex (`web/lz.ts`, an
  instance of the core of its own; RAM's frames by a save's pool of workers, "The snapshot file" below). A restore creates the VM without booting it, fills RAM from
  the file, has the core restore its state, starts the backends with theirs and serves the
  doorbell once. A parallel VM is paused first ("Pausing a VM").
- **The disk is in the file** (`web/snapshot.ts`): RAM holds the guest's page cache and filesystem
  state, so a snapshot is only valid on the disk as it was. The header lists each writable disk
  (its slot, the identity of the image its overlay is over, its size, the base's hash where the
  writer knew it) and DISK frames carry the blocks its overlay holds, read through the backends
  (the device worker has the overlay's handles: those in consecutive slots one read). A restore **replaces the
  overlay** with them before the new VM's backends open it: each frame's runs of data blocks and of zero blocks a
  write each (zeros without slots), unordered, both files flushed at the end (docs/devices.md "Crash and refusal");
  a frame past the disk's end is refused before any of it is written. The desktop's 11,952 blocks take ~0.1 s on disk
  (2.0 s one block a write: a data flush each) and ~0.8 s off the record (7.3 s: bench/boot/REPORT.md "SNAPZ loop 5"). Everything that can be refused is refused before that: a
  `File` is read once for its checksums and its end first (a damaged file must not half-replace a
  disk), a pass that also refuses what the disk phase would (a frame out of the restore's order, a DISK frame of a
  slot the header doesn't pin or past its disk's end, one that doesn't unpack to its size: its DISK frames are unpacked
  and dropped, by the pool's workers when there is one, which costs the desktop's load nothing measurable: bench/boot/REPORT.md
  "SNAPZ: the track's end"; tests/snapshot.test.ts "impossible things"), and the disk on the machine must be the snapshot's: the same identity, or, when that
  differs and the file has a hash, the same hash (asked for only then: a restore that "resumes in seconds"
  shouldn't read the whole base every time).
- **Run modes:** round-robin's `Sched` and parallel mode's per-vCPU state are saved in one form
  (on or off, in WFI, a CPU_ON not yet taken), so a realtime state restores under either. A
  restored VM starts with empty TLBs and code caches.
- **Not in a snapshot:** the JIT's code caches, the TLBs, the broadcast-maintenance queues and DSB waits (a restored
  VM starts with none, so there is nothing to maintain), counters, and the firmware image (RAM holds what the guest
  loaded). The base disk image is never in it either: only the overlay's blocks.

### The snapshot file (`web/snapshot-file.ts`, `web/snapshot.ts`)

The user owns snapshots as files (the user's call, 2026-09-29): the page saves one for download and resumes one
given to it, in a fresh browser profile too. A kept snapshot is the same file ([machines.md](machines.md) §5). The
container is streamed both ways (RAM is up to GiBs) and knows nothing of the core:
- **Decisions** (the user's, 2026-11-15, the SNAPZ track): the frames' codec is the LZ4 block format through
  **lz4_flex** (its safe encoder and decoder) and their CRC-32 **crc32fast**, both in the core, and qcow2's clusters
  go through the core's **miniz_oxide** (docs/devices.md "qcow2"); no other codec dependency (zstd, C, was weighed and
  not taken). **Older snapshot files need not load:** a file of an older state version is refused, never migrated
  (below). **A save's pool may hold ~90-140 MiB while a save runs** (its six instances, released after).
- `WAARMSNP`, a u32 format version, the JSON header with its CRC-32, then frames, little-endian. A frame is `{tag,
  codec, index, raw length, stored length, CRC-32, reserved}` (32 bytes; the CRC covers the frame header's first 24
  bytes, so a flipped index or length is caught, then the stored bytes) and the stored bytes.
- **Tags:** `CORE` (the core's state) and `DEVS` (the backends' state as JSON), each cut into 1 MiB frames; `RAM `
  (one per 1 MiB chunk with a non-zero page, `index` the chunk: a 32-byte bitmap of its non-zero 4 KiB pages, then
  those pages; spill memories' chunks follow memory 0's, [spill-memories.md](spill-memories.md)); `DISK` (a run of
  1 to 256 overlay blocks, `index` = the device slot × 2^40 + the first block); `BLOB` (the binary parts of DEVS: each
  Uint8Array in the backends' state, the display's 3D contents, is `{"$blob": n, "length": …}` in the JSON, and blob
  n's 1 MiB chunk k is a frame with `index` = n × 2^24 + k; [graphics.md](graphics.md) "Snapshots with 3D in use");
  `END ` (its `index` is the frame count). A file without its `END ` is truncated. A file with BLOB frames is format
  version 2 (an older page refuses it as newer), one with deflate's frames (codec 3, below) version 3, one with
  neither version 1. The header's own fields are `format`,
  `coreVersion`, `abi`, `created`; the page's are in [frontend.md](frontend.md) "Snapshots".
- **A zero page** is one whose words all are (`zeroPage`, on a Uint32Array over RAM); its word index is the byte
  offset shifted **unsigned** (`>>> 2`). Until 2026-10-19 a signed shift turned offsets past 2^31 negative, so every
  machine with more than 2 GiB of RAM was saved without its top and came back with its vCPUs spinning and no
  interrupts (found on the desktop guest's 2.5 GiB with 3D in use; `tests/snapshot-file.test.ts` "RAM past 2 GiB…").
  Snapshots of such machines saved before then are damaged in a way no check sees.
- **The codec** is per frame (so frames could be made and read by several workers on the shared memory), and a
  frame that doesn't shrink is stored (codec 0). The page writes **codec 2, the LZ4 block format through lz4_flex**
  in the core (`core/src/codec.rs`, its safe encoder and decoder; through `web/lz.ts` on one worker), and the frames'
  CRC-32 goes through the core's crc32fast in the writer and the reader: both are given the codec (the header's CRC,
  read before any core instance exists, stays JS's: `crc32` in `web/snapshot-file.ts`, and `readHeader` reads a
  header alone). Codecs 0, 2 and 3 are all the reader takes. **Codec 3 is raw deflate** through the core's
  miniz_oxide (`inflate_raw`, `deflate_raw`: the exports qcow2's clusters use), written only for a **template's
  download**: `tools/snapshot-template.ts --deflate` (`repackFrames`, web/lz.ts `deflateCodec`, level 9) packs each
  frame again where that's smaller; the page's own saves stay LZ4 (deflate writes at ~5 MB/s). The reader unpacks it
  on one thread (`lzCodec` reads both) and in a load's pool's workers alike. Measured on the Alpine demo's template
  (bench/demo/REPORT.md "DEMO loop 3"): the file 15.7 MB against LZ4's 24.6 (−36%), its frames unpacked ~5× slower
  (~200 MB/s a thread against LZ4's ~1.1 GB/s, spread over the load's pool), which a restore on localhost doesn't
  show; through 100 Mbit/s the click to a command is 0.65 s sooner. Settled by measurement: an LZ saves 6 times faster than
  deflate for a file 1.4 times larger (`bench/boot/REPORT.md` "M8 phase C loop 4"), and lz4_flex replaced the core's
  own LZ (`core/src/lz.rs`, same format) for a desktop save paused 9% less, its RAM frames unpacked 1.6x faster and a
  2% smaller file ("SNAPZ loop 1").
- **A save's pool** (`web/snapshot-pool.ts`, `web/snapshot-pool-worker.ts`; the writer's `RamPool`): RAM's frames are
  made by `min(navigator.hardwareConcurrency − 1, 6)` workers (`poolSize`; the paused machine's vCPU threads are idle).
  Each has a core instance of its own on a small memory (`codecCore` in `web/lz.ts`: the core's imports stubbed, none
  of web/vm.ts loaded) and reads guest RAM where it lies: a job is a shared buffer (memory 0's, or a spill memory's:
  every RAM view is a `SharedArrayBuffer`), an offset, a length and the chunk's index. The worker scans the chunk for
  zero pages, gathers its pages into its instance's memory, compresses them there and takes the frame's CRC over the
  header and the bytes where `lz_compress` left them (no copy), and posts the frame back whole (transferred), in a
  buffer of the largest frame's size that the writer gives back to that worker with a later job once the sink has
  written it (`RamPool.recycle`; a sink's bytes are its only until it returns): a save's frames are a few buffers a
  worker, not a file's worth of garbage waiting for a GC, which had added ~350 MiB to the desktop's suspend ("SNAPZ
  loop 2b"). Chunk c
  goes to worker c mod n, three in flight a worker; the machine worker writes the frames in order. Each frame is
  compressed alone with the same codec and rule (stored when it doesn't shrink), so **the file's bytes don't depend on
  the pool's size**, nor on whether there is one (`tests/snapshot.test.ts` "a save's pool"). The pool covers RAM
  only: CORE, DEVS, BLOB and DISK frames (the desktop's: 46 ms and ~110-180 ms of a 1.1 s pause; the disk's blocks
  are read in runs of consecutive slots since SNAPZ loop 5) stay on the machine worker. It is started **per save, when the save is asked for** (Snapshot, a kept
  snapshot, Suspend: `web/app/worker-snapshot.ts`), beside the balloon's hint, and closed once the file is written:
  its start (~35-45 ms to six instances) is not paused time, and no worker stays between saves. **The fallback:**
  a pool that can't start (no worker, a failed instance, none ready in 10 s, one CPU) is none, and the save runs on
  the machine worker as before. A worker that fails mid-save (an error it didn't catch, which the pool handles and
  cancels so that it goes no further up, or a reply that can't be read), or a pool with work out that answers nothing
  for 10 s (`STALL_MS`), fails **the whole pool**: its workers are ended at once, and every chunk in flight on any of
  them and every later one is made by the writer itself (RAM doesn't move while it is written): time lost, not the
  file; once the write itself has failed (the sink), no chunk is made. A view that isn't shared memory or 4-aligned,
  and a writer of a codec the workers don't write (only the core's codec is `pooled`: web/lz.ts), take the one-thread
  path too (`tests/snapshot-pool.test.ts`). The desktop's pause went from 3.79 s to
  ~1.1 s ("SNAPZ loop 2").
- **A load's pool** (the same workers, `startPool`; the reader's `LoadPool`; `openSnapshot`'s `pool`): started by the
  machine worker when a start has a snapshot (a picked file, a kept snapshot, a suspended copy: `openRestore` in
  `web/app/worker-start.ts`), beside the header's checks; it is that restore's, closed once `bootVm` has filled RAM (or
  failed to), at a refusal, or when the start ends before `fill` (`bootVm` failed earlier: a resume then boots instead,
  without it). A Blob is read in 4 MiB
  slices, four ahead (Chromium reads a picked file's stream at ~1.1 GB/s in 64 KiB chunks, four slices in flight at
  ~3.2 GB/s; the one-thread reader reads a Blob so too). Through the pool each piece goes **whole to a worker**
  (transferred, the least busy one, two pieces a worker at most) with the jobs of the frames in it; a frame across two
  pieces is copied out and given alone. The machine worker parses every frame header and checks the file's structure
  in file order, as on one thread; the workers take each frame's CRC in their own core instance and, for the restore
  pass's RAM frames, unpack them and put their pages straight into guest RAM and the spill memories (`applyRam` on
  the shared memories), posting back only the jobs they failed and their times. CORE, DEVS, BLOB and DISK frames are
  read on the machine worker in the restore pass (the check pass's DISK frames are unpacked by the workers too). **The check pass still comes first and ends only once every CRC is
  in**: a damaged frame anywhere is refused before RAM or a disk is touched, and a refusal is the first failing
  frame's (the frames of the piece in hand not yet given to a worker are checked before a later frame's structural
  refusal) (`tests/snapshot.test.ts` "a load's pool"; the page's refusal in tests/page-snapshot.test.ts). `placed()`
  waits for every RAM frame given so far (the piece in hand given as a copy), so the restore pass's own refusal also
  comes before the disks. **The fallback:** a frame a worker fails, or a piece whose worker failed (a failed worker fails
  the whole pool, as a save's does), is read again from the file and done on the machine worker (a damaged one refused
  there, as on one thread); no pool (it can't start, one CPU), a stream or a codec the workers don't read is the
  one-thread reader. RAM not on shared memory still goes through the pool's check pass; the restore pass places those
  frames from copies on the machine worker. Copying frames into shared slots instead was
  measured first: V8 copies into shared memory word by word, ~220 ms of the machine worker's time a pass for the
  desktop's file, which whole pieces avoid. The desktop's load spends 1.13 s in the check pass, the state and RAM
  against 3.13 s on one thread (wall 9.5 to 7.6 s), Debian's 0.13 s against 0.35 ("SNAPZ loop 3").
- **Refusals** (`SnapshotError`, a `MsgError` with its `problem` and a message of the `snapshots` catalog that names
  what the user can do: docs/i18n.md) come before anything is touched: not a snapshot,
  a newer format, a core state version this core doesn't read, another machine, another disk, a checksum that fails,
  a truncated file, frames that say impossible things (above). A `ReadableStream` (the tests' only) has no check pass:
  its refusals come as its frames are read. **Older files are refused, not read** (the decisions above): the header's `coreVersion`
  is checked first (`otherVersion`, in `readSnapshot` before the check pass and in the machine worker's restore before
  the devices), so a file of an older state version, which may also hold deflate-raw frames (codec 1, no longer
  read) or a device list from before the clock, the notify socket or the balloon, gets
  the other version's refusal (`snapshots:snapshot.otherVersion`: made by another version of this web app), a kept
  snapshot when restored and a suspended machine at its start (dropped, the machine booting, with the note
  [Couldn't resume the suspended machine](ui:machine:worker.notResumed)).
  A state of this version must name the machine's devices exactly (`slotsOf`) and its vCPU features (`cpu`).
- **Out:** a file save is staged through OPFS during the pause, then copied into the picked file
  (`showSaveFilePicker`, called on the click) or downloaded as the staging file itself ([frontend.md](frontend.md)
  "Snapshots"). The copy after the resume took 1.4 s for the desktop's 680 MB beside the running guest, 0.7 s on an
  idle browser: Blob slices written by the browser, file to file; nothing faster was found from the page. A desktop
  save adds ~190-240 MiB while it runs (the pool's six instances and, for a 3D machine, its read-back state: 109 MB of
  BLOB contents held through the save), and a picked file's copy ~310 MiB (its Blob writes in the renderer's
  accounting; bench/boot/REPORT.md "SNAPZ loop 4"). Without room or OPFS the save writes directly: to the picked
  file's stream, or a Blob download, the machine worker posting the frames to the page as they are written
  (`snapshot-chunk`, each copied into a buffer the page gave back, `snapshot-spare`), the page copying each into a
  Blob at once and giving the buffer back. That way, for the desktop's 679 MB file the renderer holds ~600 MiB more
  until the save ends and the browser's blob storage the file (~685 MiB) until the URL is revoked 60 s later.
  **In:** a `File` (a Blob) read in 4 MiB slices, four ahead; a stream as it comes.
- **Versions** (the user's call, 2026-10-01): the core's state has a format version of its own (`snapshot::VERSION`,
  [abi.md](abi.md) "M8 phase C"), bumped when a saved field changes and pinned by a unit test of a fixed machine's
  bytes, **not the wasm's input hash**: that would void every snapshot at every core change, the JIT's too, which
  never changes what is saved. The header's `abi` is recorded, not checked. A restore reads its own version only
  (`snapshot_version`; ABI 69 removed `snapshot_version_min` and the older versions' readers): another is refused;
  there is no migration ([#215](https://github.com/gbl08ma/waarm64/issues/215)). So a file loads into another build of the core with
  the same state version, which is what benchmarks start from ([benchmarking.md](benchmarking.md) "Starting from a
  snapshot"; `tests/snapshot.test.ts` "a snapshot loads into another build of the core…").
- **The base's identity** (on the disk pins above): a chosen file's name, size and modification time, a URL's path,
  and the SHA-256 (`hashSource`) where the writer has it. The cheap identity is checked first because the hash costs
  a read of the whole base (Debian's 384 MiB took 1.8 s when measured), which a restore that resumes in seconds
  shouldn't pay every time.

## The GIC: a GICv3 (`core/src/gicv3.rs`)

The only interrupt controller since M7. **The GICv2 model was dropped** (M7, the user's call): every
guest we run drives a GICv3 (arm64 Linux since 3.17, the BSDs), and keeping a second GIC in step
cost more than the kvm-unit-tests `gicv2-*` coverage of itself was worth. `ID_AA64PFR0_EL1.GIC` =
1 and the `ICC_*` registers exist for a VM's vCPUs (`cpu::FEATURE_GICV3`); user-mode vCPUs don't
have them.

IHI 0069, **no ITS, no LPIs**, per-CPU:
- **One security state** (`GICD_CTLR.DS` = 1) and **affinity routing always on** (`ARE` RAO/WI).
  Group 1 signals IRQ; group 0 would signal FIQ, which nothing takes (Linux and kvm-unit-tests
  use group 1), though `ICC_IAR0_EL1` still acknowledges it.
- **The system-register CPU interface:** `ICC_PMR`, `IAR0/1`, `EOIR0/1`, `HPPIR0/1`, `BPR0/1`,
  `AP0R0`/`AP1R0`, `DIR`, `RPR`, `SGI0R`/`SGI1R`/`ASGI1R`, `CTLR` (CBPR, EOImode), `SRE` (RAO/WI:
  no legacy interface), `IGRPEN0/1`. Accesses leave the interpreter (`Exit::Platform`, as the
  timer registers do) and complete in the run loop; the JIT reaches them through its helper.
- **5 priority bits** (`PRIbits` = 4, as QEMU's): priority fields keep bits 7:3, one
  active-priorities register per group (bit = priority >> 3; the others are UNDEFINED). EOIR drops
  the highest active priority, then deactivates unless EOImode splits that off to `DIR`.
- 96 INTIDs: SGIs and PPIs banked per CPU in its redistributor (`GICR_*`: WAKER,
  TYPER with affinity and Last, IGROUPR0, the enable/pending/active sets, IPRIORITYR, ICFGR1),
  SPIs in the distributor, routed by `GICD_IROUTER` (an affinity, or 1 of N: the lowest-numbered
  CPU with group 1 on). The distributor's SGI/PPI words are RAZ/WI (affinity routing).
- CPU *i*: Aff1 = i / 16, Aff0 = i % 16 (`gicv3::mpidr`, QEMU `virt`'s clustering; a target list
  covers 16 CPUs), which is also its `MPIDR_EL1`.
- `GICR_WAKER.ProcessorSleep` is state only (interrupts are forwarded while it's set, as QEMU
  does). 64-bit registers (`GICR_TYPER`, `GICD_IROUTER`) take 64-bit or 32-bit accesses.
- **Oracles:** QEMU TCG `gic-version=3`, and **Apple's in-kernel vGIC under hvf** (the Mac's QEMU
  uses it by default: its `GICR_TYPER` reads 0 through 32-bit halves, where QEMU's own model
  with `kernel-irqchip=off` doesn't). Where they differ from us: hvf reports
  `ID_AA64PFR0_EL1.GIC` = 0 while its `ICC_*` registers work; Apple reads `GICR_ICFGR0` as 0 (QEMU
  and we: `0xaaaa_aaaa`, 0b10 per SGI as GICv2 prescribed).

## Generic timer

The virtual (PPI 27) and physical (PPI 30) EL1 timers: `CNTV_*`/`CNTP_*` CTL/CVAL/TVAL,
`CNTVCT`/`CNTPCT`, `CNTKCTL_EL1` traps, `CNTFRQ_EL0`. Registers are handled in `interp/sys.rs`
and complete in the run loop (exact counts).

## PL011 (`core/src/pl011.rs`)

DR, FR, IBRD/FBRD, LCR_H, CR, IFLS, IMSC, RIS/MIS/ICR, DMACR, PeriphID/PCellID. Transmit is
instant (FR.TXFE always set; TXRIS set per byte, cleared by ICR); RX/RT pending while the RX ring
has data. The console is two SPSC byte rings ([abi.md](abi.md)); a DR write into a full TX ring
returns the TX-full exit with the store not retired.

**Console input** (M8): the host is the RX ring's one producer. `web/vm.ts` `send(bytes | string)`
queues input and pumps what fits into the ring, then raises `SIGNAL_RX` (so an idle vCPU wakes
and, in parallel mode, the PL011's line is republished); the rest waits and is pumped before each
`vm_run` and at each of `runAsync`'s waits, so nothing is dropped while the guest's tty throttles.
`BootOptions.serialIn` is a `MessagePort` whose messages go to `send`, handled on the VM's thread
between runs (at once while a parallel VM's `runAsync` awaits). In deterministic mode input lands
where the runner sends it: `runToPowerOff`'s `ConsoleInput` (at a step, on a console marker, or
at an idle with no deadline) and the native runners' `Boot.input` pump at the same points, so a
test with input keeps one step count. Parallel `runAsync` returns as soon as the TX ring has
output, so a terminal's echo isn't held back by its 50 ms turns: it sleeps on the TX ring's head,
which the core notifies on a byte into an empty ring ([abi.md](abi.md) "Signal word and console";
before M8 loop 3 it noticed output at its next 10 ms wait).
Without `SIGNAL_RX` a tickless guest (Debian, Alpine) sees input only at its next timer event:
Alpine's shell echoed in ~120 ms instead of ~55 ms, and the bare-metal `rx` test (no timer
armed) never does.

## PL031 RTC (`core/src/pl031.rs`)

In realtime mode, when the host passes its wall clock (`VmConfig.rtc`, Unix ms; `web/vm.ts`
passes `Date.now()`): deterministic runs have no node and no device, so their step counts don't
depend on the date. **The firmware configuration always has it** (EDK2's RTC, and Linux's
`rtc-efi` through EFI `GetTime`); deterministic firmware runs count from a fixed `rtc`
(2026-09-01) plus virtual time, so they keep one step count. Reads of 1, 2 or 4 bytes see the
register's bytes (EDK2 reads the IDs with LDRB, as QEMU allows). DR counts that time plus the realtime clock, in seconds; an LR write moves it
by an offset (so `hwclock --systohc` sticks until the VM is gone). CR reads 1; the match
interrupt never fires (MR and IMSC are storage only: no RTC alarm). Linux's `rtc-pl031` (built
into Debian's kernel; our Buildroot and Alpine kernels have no RTC class) sets the system clock
from it at boot (`hctosys`).

## The firmware configuration's devices (`core/src/flash.rs`, `core/src/fw_cfg.rs`, `core/src/smbios.rs`)

- **The flash bank** (`0x0400_0000`, `VmConfig.flash_size`): EDK2's variable store, three
  256 KiB areas. An MMIO device behaving as QEMU `virt`'s `pflash_cfi01` bank 1 (bank width
  4, two interleaved x16 chips: commands in both 16-bit halves, status and identifiers read
  back in both), with the commands [abi.md](abi.md) lists; operations complete at once, and
  programming stores the data as QEMU does. Every access, array-mode reads included, goes
  through `vm::Io` (a boot reads the store a few times; a guest reading it in a loop would need measuring). There is
  no lock state: every block is unlocked. The host copies the saved bytes in
  and out through `vm_flash`. The bare-metal `flash` test checks it on QEMU and hvf too.
- **fw_cfg** (`0x0902_0000`): QEMU's MMIO interface without DMA: the signature, the ID, the
  file directory and the host's named files. Linux's `qemu_fw_cfg` shows them under
  `/sys/firmware/qemu_fw_cfg`, and systemd imports `opt/io.systemd.credentials/*` as
  credentials (the tests boot Debian unattended that way; the page passes none). With fw_cfg
  there and no ACPI tables in it, EDK2 passes our DT on to Linux.
- **SMBIOS** over fw_cfg, as QEMU serves it: an SMBIOS 3.0 entry point (`etc/smbios/smbios-anchor`)
  and the structures (`etc/smbios/smbios-tables`), which EDK2's SmbiosPlatformDxe installs and
  passes to Linux (`/sys/class/dmi/id`, `dmidecode`, `hostnamectl`). Built by the core from the
  configuration, so a deterministic run repeats: the firmware (type 0: EDK II, UEFI, a virtual
  machine), the system and chassis (`waarm64`, family `Virtual Machine`, no serial numbers, a null
  UUID: systemd takes no machine ID from it), one processor with every vCPU as a core (ARMv8, maker and
  version `waarm64`, which `lscpu` shows as "BIOS Vendor ID" and "BIOS Model name"; its ID MIDR_EL1), RAM as one memory device and where it's mapped, OEM strings (type 11: the spill memories' credential,
  then the host's from fw_cfg's `opt/waarm64/oem-strings`, which isn't served as a file), and a clean boot (type 32); EDK2's setup screen takes its RAM
  size from type 19. The page's Debian test reads them back, and the `edk2-shell` boots' step counts
  (native and Node) include installing them.

## PSCI (over HVC, in the core)

PSCI 1.0: VERSION, FEATURES, **CPU_ON** (SMC32/64: the target by MPIDR affinity starts in its
reset state, EL1h with DAIF masked and the MMU off, at the entry with x0 = the context;
INVALID_PARAMETERS for no such CPU, ALREADY_ON for an on one), **CPU_OFF** (doesn't return; a
later CPU_ON restarts the vCPU), **AFFINITY_INFO** (level 0: ON 0 / OFF 1), MIGRATE_INFO_TYPE (2)
answered in the core; SYSTEM_OFF and SYSTEM_RESET exit to the host (exit kind `PSCI`, PC past the
HVC, the host writes x0 if it resumes); SMCCC 1.1 on the same conduit (`SMCCC_VERSION`,
`SMCCC_ARCH_FEATURES`, which reports `ARCH_WORKAROUND_1/2/3` as NOT_REQUIRED: nothing speculates,
so Linux says "Not affected" for Spectre-v4, [cpu.md](cpu.md)); **SYSTEM_SUSPEND** in realtime mode (below); everything else NOT_SUPPORTED (CPU_SUSPEND included).
Only CPU 0 is on at boot. kvm-unit-tests' `psci` passes all five checks, including the concurrent
cpu-on one QEMU TCG fails. In parallel SMP every vCPU's worker starts at boot and sleeps on its
wake word (`IDLE`, u64::MAX) until a CPU_ON, which its own thread carries out.

### System suspend

**SYSTEM_SUSPEND** (SMC32/64: entry, context) is answered in realtime mode only: a deterministic guest gets
NOT_SUPPORTED from it and from FEATURES, so its PSCI and its step counts are as before. It is DENIED while another vCPU
is on (or starting); otherwise the caller goes off and the machine is **suspended** (`Platform::suspended`: the vCPU,
its entry and context; `Shared::suspended` for the host to read from any thread) until the host wakes it
(`vm_wake`): the vCPU resumes at the entry as from CPU_ON. Nothing in the core wakes it (Linux masks every interrupt
that isn't a wakeup source before it suspends); the page wakes it on a key or a click ([frontend.md](frontend.md)
"The guest's clock"). Linux takes it as suspend-to-RAM (`/sys/power/mem_sleep` lists `deep`, its default), so
`systemctl suspend` and logind's sleep key use it. Every virtio device live at the suspend has its next reset (the
driver's resume) carried over it ([devices.md](devices.md) "Across a suspend"): virtio-gpu and 9p have no `restore`.

**The clock across it.** The counter runs on while the guest is suspended, and Linux's resume counts its progress as
sleep (the arch timer is a nonstop clocksource): CLOCK_REALTIME and CLOCK_BOOTTIME move on, CLOCK_MONOTONIC doesn't,
and the soft-lockup and RCU-stall detectors are reset. The core moves no clock on by time that didn't pass in the VM
(a snapshot sitting in a file); until ABI 67 `vm_clock_skip(ns)` did for a suspended guest, whose own resume then
caught its wall clock up (the page put the guest to sleep for each snapshot): the guest agent now sets the wall clock
instead (frontend.md "The guest's clock"). The same jump in a guest that isn't suspended is what the core never does: measured on Debian 13 (an hour on CNTVCT at a restore), `date` was right at once, but RCU reported a
self-detected stall and systemd killed journald for its watchdog (`WatchdogSec=`, on CLOCK_MONOTONIC); arm64 has no
"guest was paused" signal to the kernel (x86's kvmclock `PVCLOCK_GUEST_STOPPED`: arm64 takes asm-generic's
`kvm_check_and_clear_guest_paused`, which returns false). A snapshot taken while the guest is suspended saves that
(snapshot format 3), so the restored machine is suspended too; one taken after `vm_wake` but before the vCPU ran
(round-robin's next `vm_run` takes the wake) saves the pending start, as a CPU_ON request, so it resumes.

## Bare-metal test convention

A bare-metal test passes by calling PSCI SYSTEM_OFF with x1 = 0 (our own convention; x1 is the
number of the failed check otherwise) and prints `exit <code>` on the PL011
([testing.md](testing.md) "Bare-metal tests").
