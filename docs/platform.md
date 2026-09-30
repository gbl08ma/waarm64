# The platform: memory map, boot, run loop, broadcast maintenance, time, GIC, timer, UART, PSCI

The machine around the CPU, as built. Devices that need no host (the GICv3, generic timer,
PL011, PSCI, the virtio-mmio transports) live in the Rust core (`core/src/vm.rs`, `gicv3.rs`,
`pl011.rs`, `virtio.rs`), so native runners and wasm share them. virtio backends are in
[devices.md](devices.md); the host ABI in [abi.md](abi.md).

## Memory map (QEMU `virt`'s)

Chosen so kvm-unit-tests runs with its defaults and traces line up with the QEMU oracles.

| PA | What |
|---|---|
| `0x0800_0000` | GIC distributor (64 KiB) |
| `0x080a_0000 + 0x2_0000·i` | GICv3 redistributor of CPU *i* (RD_base, then SGI_base) |
| `0x0900_0000` | PL011 UART (SPI 1, INTID 33) |
| `0x0a00_0000 + 0x200·i` | virtio-mmio transport *i* (≤ 32; SPI 16+i, INTID 48+i) |
| `0x4000_0000` | RAM (`vm::RAM_BASE`), size from `VmConfig.ram_size` |

- An access to a PA with no device is an **external abort** (QEMU TCG agrees; QEMU under hvf
  makes it RAZ/WI).
- **Device MMIO never touches the interpreter's fast copies:** an access to a non-RAM PA faults
  there, and the run loop re-executes that one instruction on a third `Bus`, `vm::Io`, which sends
  it to the device (handlers read before they write registers, so the retry is exact). The JIT
  reaches the same path: a helper that hits a non-RAM PA reports `Exit::Fault(Bus)`.

## Boot (`core/src/boot.rs`, `core/src/fdt.rs`)

- **Direct kernel boot**, no UEFI: the host copies an arm64 `Image` (and initrd) into RAM;
  `vm_boot` checks the `Image` magic and 2 MiB alignment, writes the DTB into **the top 2 MiB of
  RAM** (the initrd must sit below it), and starts the vCPU in its EL1 reset state at the Image
  with x0 = DTB (booting.rst). A headerless kernel (kvm-unit-tests' `.flat`) is entered at its
  first byte, as QEMU does. Distro kernels and initrds are extracted from their images and booted
  the same way.
- Runner conventions: the Image at RAM + 2 MiB and the initrd at + 128 MiB; raw binaries
  (bare-metal tests) with `kernelOffset: 0`. 256 MiB for Buildroot, 512 MiB for LTP, 1 GiB for the
  distros.
- **The DTB is our own small FDT writer** (not `vm-fdt`): RAM, a PSCI (HVC) `cpu@<affinity>`
  node per vCPU, the GIC (`arm,gic-v3`, one redistributor region), `arm,armv8-timer` (level-high
  PPIs), a 24 MHz fixed clock, the PL011, one `virtio,mmio` node per device in slot
  order (`dma-coherent`, a **level-high** interrupt: QEMU says edge-rising, but our line follows
  InterruptStatus), and the framebuffer ([devices.md](devices.md)). `tests/dtb/webpc.dts` is its
  `dtc` decompilation (two vCPUs), checked by a unit test.
- Guest RAM is sized against host RAM at VM start: Chromium gives no catchable error when host RAM
  runs out (the renderer is OOM-killed).

## The run loop (`vm::Vm::run`)

Two ways to run N vCPUs, one core: **deterministic round-robin** on one thread (tests: exact
steps in every runner) and **parallel SMP**, a thread per vCPU (users and the scaling curve;
realtime only). With one vCPU both are the machine as it was before M7.

**N vCPUs, deterministic round-robin** (`VmConfig.ncpus`, M7): `vm_run` runs every vCPU on the
calling thread, a **quantum** (`QUANTUM` = `CHUNK` steps) each in index order; a vCPU that's off
(PSCI) or waiting in WFI is passed over. The code cache lives in vCPU 0's `jit.cache` and moves
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
  their exact tick. Each chunk goes through `jit::steps` when the JIT is on, else `interp::steps`.
- **Between chunks:** the signal word, device completion rings, the interrupt lines into the GIC,
  and IRQ entry (vector +0x80) when `PSTATE.I` is clear.
- **An MSR or ERET that unmasks IRQs ends the chunk** (`Exit::Resync`), so a pending IRQ is taken
  right after it. That makes the chunk size invisible to deterministic guests: every suite takes
  identical steps at any `CHUNK` from 1024 to 131,072. (It was 1024 until M6, when ERET didn't end
  the chunk; the fix let `CHUNK` grow 32×, which cut Alpine's JIT boot by 14%: hot JIT loops return
  to the run loop far less often.)
- Exits to the host: [abi.md](abi.md) "Exit kinds".

**Parallel SMP** (`VmConfig.smp` = 1, realtime only; `core/src/vm/parallel.rs`, ABI 25): a
thread per vCPU, each calling `vm_run_cpu` for its own vCPU in its own core instance (in the
browser a worker each, `web/vcpu-worker.ts`, coordinated by `web/vm.ts`; natively a `std::thread`
each, `core/tests/common` `run_parallel`). Each vCPU has its own code cache (blocks hold table
indexes of their instance).
- **Shared state** (the GIC, the PL011, the virtio transports, completion draining, PSCI power
  states and CPU_ON requests) is behind one lock, `Vm::plat` (a `Mutex`; round-robin reaches it
  through `&mut` without locking). Each vCPU drives its own timer PPIs (taking the lock only when a
  level changes) and reads its IRQ line from an atomic that the platform code republishes after
  every change under the lock (`Vm::refresh`, which also wakes a vCPU whose line went up). A chunk
  boundary with nothing new takes no lock: the signal word, the maintenance flag, the clock, the
  timer levels, the IRQ atomic.
- **Signals:** RX and DEVICE are taken by the first vCPU that sees them (`fetch_and`); STOP isn't
  cleared by the core (every vCPU must see it). **Wake words:** a vCPU with nothing to run
  returns `IDLE` with its wake word as read *before* it looked for work; everything that makes
  work for it (an interrupt line going up, CPU_ON, a drained queue it waits on, a host signal)
  changes that state first, then bumps the word and notifies it, so the host's `Atomics.wait(word,
  wake)` can't miss a wake-up.
- **WFI** returns `IDLE` (value: ns to the vCPU's own deadline) unless an interrupt is signaled
  to it (the worker polls its wake word for 50 µs before `Atomics.wait`: a futex wake-up costs
  ~17 µs in the dev VM, and the stress's pingpong went from 34 to 10 µs a hand-off); **WFE** is a
  yield (it ends the chunk, as QEMU's MTTCG does), and SEV does nothing (no vCPU sleeps in WFE):
  a vCPU can't cheaply see the store that clears another's exclusive monitor, which is what
  wakes Linux's LDXR + WFE waits on hardware. Measure before making WFE sleep
  ([backlog.md](backlog.md)).
- **CPU_ON:** the caller records the request under the lock and wakes the target; the target's
  own thread applies it (no thread writes another's registers), marking itself on under the same
  lock (between taking the request and marking itself on, a second CPU_ON once saw it off: the
  bare-metal `smp` test's check 4 caught it, 1 run in 30).
- **DSB, ISB and ERET end the chunk** (`cpu::FEATURE_PARALLEL`: `Exit::Resync` in the interpreter;
  the JIT calls the helper for DSB, and ISB and ERET were helpers already): the run loop drains
  the vCPU's queue there (context synchronization) and completes its TLBI IS broadcasts. With one
  vCPU, parallel mode booted Alpine as fast as round-robin realtime in Node (10.28 vs 10.21 s),
  though the boot runs 584K ISBs and 209K ERETs.

## Broadcast maintenance

Round-robin makes it synchronous: **TLBI … IS** flushes every other
vCPU's TLB in the run loop (`Exit::TlbiIs`) before anything else runs, and `IC IVAU`/`IC
IALLU(IS)` invalidate the one code cache all vCPUs share. JIT code holds no translation of its
own that a TLBI would have to reach: cross-page chains check the running vCPU's instruction TLB,
and blocks are keyed by PA. The bare-metal `maint` test covers every IS flavor and both ICs across
4 vCPUs (on QEMU and hvf too). In **parallel mode**:
- Each vCPU has a queue (TLB operations, and code pages for its cache) under a lock, an atomic
  pending flag checked at every chunk boundary, and `queued`/`applied` counts. An issuer pushes
  to every other vCPU's queue: up to 64 TLB operations (then one flush-all), and **distinct code
  pages**, up to 1024 (then the whole cache). Linux cleans a page with an IC IVAU per 64-byte line,
  and an idle vCPU collects the pages of every exec page fault elsewhere: queues of 64 addresses,
  then of 64 pages, collapsed into whole-cache flushes often enough to compile 6×, then 3×, the
  blocks of a one-vCPU Alpine boot on two vCPUs (now 1.7×: each vCPU compiles what it runs).
- A vCPU applies its queue at every chunk boundary, and when it enters `vm_run_cpu`, before it
  runs anything.
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
  here. `maint.c` had its ISB before waiting for the rewrite: parallel mode ran the old code (401),
  and the test was fixed (QEMU TCG and hvf pass it either way).
- **The stale-code checker tolerates** stale blocks in parallel caches (`jit::Cache::tolerant`:
  code another vCPU rewrote is legal to run until this vCPU drains the IC): it drops the block at
  the run loop's entry and counts it (`JIT_STALE`, counter word 90), and only counts mid-chain. Only
  round-robin runs trap.
- **Only vCPUs that may hold the entries are waited for:** TLBI ASIDE1IS, VAE1IS and
  VALE1IS of a TTBR0-half address are for one ASID, and a vCPU's TLB holds nG entries of its
  current ASID only (an ASID change drops them), so the DSB skips targets whose published ASID
  (`CpuPar::asid`, stored before each chunk; `ANY` with the MMU off) differs; they still apply the
  operation at their next boundary. That needs no global entries in the TTBR0 half, which a TLBI
  for any ASID drops: parallel SMP doesn't cache them (`Mmu::miss`; Linux maps nothing global
  there). The issuer fences between the guest's table stores and reading the ASIDs, the target
  between publishing its ASID and walking. A TTBR write that changes the ASID mid-chunk needs an
  ISB before the new ASID is promised to translate, and the ISB ends the chunk (and drains). In
  the userspace phases on 4 vCPUs this cut the DSB waits from 92K (8.3 s over the vCPUs) to 3K
  (0.06 s) and process churn by 37% in Chromium (`bench/boot/REPORT.md` "M7 loop 8"): after a
  fork, parent and child have different ASIDs, so COW faults rarely concern another running vCPU.
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
  (`value` = u64::MAX), PC on the WFI. **Every guest takes the same number of steps natively, in
  Node and in Chromium, interpreted or under the JIT**; tests assert those counts
  ([testing.md](testing.md) "Step counts").
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
    instead (`web/vm.ts` `clockOffset`: 16 round trips, the shortest one's midpoint).
  - **Idle watchdog:** `idleLimitMs` (`web/vm.ts`, on in the boot benchmarks) throws on an idle
    with no deadline for that long: a deadline-less idle that long is a bug either way.
- Guest-timed benchmarks (`dd`, `fio`, `openssl speed`) are meaningless in deterministic time:
  run them in realtime mode.

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

## PSCI (over HVC, in the core)

PSCI 1.0: VERSION, FEATURES, **CPU_ON** (SMC32/64: the target by MPIDR affinity starts in its
reset state, EL1h with DAIF masked and the MMU off, at the entry with x0 = the context;
INVALID_PARAMETERS for no such CPU, ALREADY_ON for an on one), **CPU_OFF** (doesn't return; a
later CPU_ON restarts the vCPU), **AFFINITY_INFO** (level 0: ON 0 / OFF 1), MIGRATE_INFO_TYPE (2)
answered in the core; SYSTEM_OFF and SYSTEM_RESET exit to the host (exit kind `PSCI`, PC past the
HVC, the host writes x0 if it resumes); everything else NOT_SUPPORTED (CPU_SUSPEND included).
Only CPU 0 is on at boot. kvm-unit-tests' `psci` passes all five checks, including the concurrent
cpu-on one QEMU TCG fails. In parallel SMP every vCPU's worker starts at boot and sleeps on its
wake word (`IDLE`, u64::MAX) until a CPU_ON, which its own thread carries out.

## Bare-metal test convention

A bare-metal test passes by calling PSCI SYSTEM_OFF with x1 = 0 (our own convention; x1 is the
number of the failed check otherwise) and prints `exit <code>` on the PL011
([testing.md](testing.md) "Bare-metal tests").
