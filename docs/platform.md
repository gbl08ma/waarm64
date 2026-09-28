# The platform: memory map, boot, run loop, time, GIC, timer, UART, PSCI

The machine around the CPU, as built. Devices that need no host (GICv2, generic timer, PL011,
PSCI, the virtio-mmio transports) live in the Rust core (`core/src/vm.rs`, `gic.rs`, `pl011.rs`,
`virtio.rs`), so native runners and wasm share them. virtio backends are in
[devices.md](devices.md); the host ABI in [abi.md](abi.md).

## Memory map (QEMU `virt`'s)

Chosen so kvm-unit-tests runs with its defaults and traces line up with the QEMU oracles.

| PA | What |
|---|---|
| `0x0800_0000` / `0x0801_0000` | GICv2 distributor / CPU interface |
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
- **The DTB is our own small FDT writer** (not `vm-fdt`): RAM, one PSCI (HVC) CPU, the GICv2,
  `arm,armv8-timer`, a 24 MHz fixed clock, the PL011, one `virtio,mmio` node per device in slot
  order (`dma-coherent`, a **level-high** interrupt: QEMU says edge-rising, but our line follows
  InterruptStatus), and the framebuffer ([devices.md](devices.md)). `tests/dtb/webpc.dts` is its
  `dtc` decompilation, checked by a unit test.
- Guest RAM is sized against host RAM at VM start: Chromium gives no catchable error when host RAM
  runs out (the renderer is OOM-killed).

## The run loop (`vm::Vm::run`)

- `vm_run(vm, budget)` runs **chunks of at most `CHUNK` = 32,768 steps** (instructions retired
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

## Time

Two modes, chosen by `VmConfig.deterministic`:
- **Deterministic** (the default; tests, most benchmarks, reproducible bugs): the counter is
  steps × `ticks_per_insn` (default 1) plus ticks skipped by WFI. `CNTFRQ` defaults to 62.5 MHz
  (QEMU's). WFI completes when the GIC signals an interrupt (masked or not); otherwise virtual
  time jumps to the next armed timer deadline, and with none the run returns the idle exit
  (`value` = u64::MAX), PC on the WFI. **Every guest takes the same number of steps natively, in
  Node and in Chromium, interpreted or under the JIT**; tests assert those counts
  ([testing.md](testing.md) "Step counts").
- **Realtime** (I/O benchmarks, `openssl speed`, interactive use): the core imports
  `env.now_ms()` (`performance.now()` in the browser, `Instant` natively), read once per chunk and
  on timer-register reads; the counter is (host ns since `vm_new`) × CNTFRQ. Chunks aren't cut at
  deadlines, so a timer fires at the first chunk boundary past it (≤ one chunk late, ~0.1 ms of
  latency). A WFI with no interrupt signaled returns `IDLE` with the PC on the WFI and `value` =
  nanoseconds to the next deadline (u64::MAX: none), and re-executes on resume; `web/vm.ts` sleeps
  in `Atomics.wait` on the signal word until then (whoever sets a signal bit must
  `Atomics.notify` it), except on a page's main thread, which gets the exit.
  - `Vm::wfi` takes **one** clock reading (three readings once let a timer fall due between them
    and be neither pending nor a deadline, so the host slept forever).
  - **Idle watchdog:** `idleLimitMs` (`web/vm.ts`, on in the boot benchmarks) throws on an idle
    with no deadline for that long: a deadline-less idle that long is a bug either way.
- Guest-timed benchmarks (`dd`, `fio`, `openssl speed`) are meaningless in deterministic time:
  run them in realtime mode.

## GICv2 (`core/src/gic.rs`)

IHI 0048B without the Security Extensions, **single-CPU** (M7 makes it per-CPU):
- 96 INTIDs (`u128` masks, `ITLinesNumber` 2), all group 0 and IRQ (IGROUPR RAZ/WI), 8 priority
  bits, BPR group priority for preemption, IAR/EOIR/DIR with the `EOImode` split, ICFGR (SGIs edge,
  read-only), self-SGIs through `GICD_SGIR`.
- **`GICD_ITARGETSR` is RAZ/WI**, as the spec prescribes for a uniprocessor GIC and QEMU does
  (kvm-unit-tests `gicv2-mmio-up` fails the same two checks on QEMU TCG as on us).
- RAZ/WI: `GICD_CPENDSGIR`/`SPENDSGIR`, `GICC_APR*`. The SGI source CPU is always 0.
- No hardware oracle: HVF can't emulate a GICv2, so the GIC, timer and UART tests compare
  against QEMU TCG only.

## Generic timer

The virtual (PPI 27) and physical (PPI 30) EL1 timers: `CNTV_*`/`CNTP_*` CTL/CVAL/TVAL,
`CNTVCT`/`CNTPCT`, `CNTKCTL_EL1` traps, `CNTFRQ_EL0`. Registers are handled in `interp/sys.rs`
and complete in the run loop (exact counts).

## PL011 (`core/src/pl011.rs`)

DR, FR, IBRD/FBRD, LCR_H, CR, IFLS, IMSC, RIS/MIS/ICR, DMACR, PeriphID/PCellID. Transmit is
instant (FR.TXFE always set; TXRIS set per byte, cleared by ICR); RX/RT pending while the RX ring
has data. The console is two SPSC byte rings ([abi.md](abi.md)); a DR write into a full TX ring
returns the TX-full exit with the store not retired. There's no host input path to the RX ring
from `web/vm.ts` yet (backlog).

## PSCI (over HVC, in the core)

PSCI 1.0: VERSION, FEATURES, AFFINITY_INFO (CPU 0 is on), MIGRATE_INFO_TYPE (2) answered in the
core; SYSTEM_OFF and SYSTEM_RESET exit to the host (exit kind `PSCI`, PC past the HVC, the host
writes x0 if it resumes); everything else NOT_SUPPORTED. **CPU_ON is M7's**, and will also exit
to the host, which starts the vCPU's worker.

## Bare-metal test convention

A bare-metal test passes by calling PSCI SYSTEM_OFF with x1 = 0 (our own convention; x1 is the
number of the failed check otherwise) and prints `exit <code>` on the PL011
([testing.md](testing.md) "Bare-metal tests").
