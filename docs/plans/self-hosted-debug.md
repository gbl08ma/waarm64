# Self-hosted debug (proposed, not scheduled)

Breakpoints, watchpoints and `MDSCR_EL1.SS` single step raise nothing today: the debug registers
are RAZ/WI ([cpu.md](../cpu.md); [backlog.md](../backlog.md) "Self-hosted debug"). That blocks
in-guest `gdb` (`stepi`, `hbreak`, `watch`), `ptrace` single step, perf's `mem:` events and
kvm-unit-tests' `debug-*`.

**Goal:** the architecture's self-hosted debug (v8.0, the 2 breakpoints, 2 watchpoints and 1 context
comparator `ID_AA64DFR0_EL1` already advertises) with **no cost when nobody debugs**: the JIT's
emitted code, the block interpreter and the step interpreter's loop stay as they are.

## Why it can be free

Debug state only changes where control is already back in the dispatcher (`jit::steps`), so the
fast tiers never look at it.

- **Arming changes only through an MSR** to `MDSCR_EL1`, `DBGBCRn_EL1` or `DBGWCRn_EL1`. None is in
  `msr_continues` (`interp/sys.rs`), so the MSR ends its block (`Next::None`) and the JIT returns to
  the dispatcher without chaining (only BR, BLR and RET take the transfer cache). The block
  interpreter's run of decoded blocks also stops after an instruction it runs generically.
- **The EL changes only through the dispatcher:** exceptions and IRQs are taken in the VM loop,
  ERET ends its block, SVC/HVC/BRK stop a block before them. So arming can be per EL.
- **The precedent exists:** `jit::key()` already sends everything to the interpreter while
  `SCTLR_EL1.A` is set. Generalized into a per-EL "interpret only" mask, recomputed on the rare MSRs
  that change it, the test costs what it costs today, once per dispatch.
- **Unarmed is silent architecturally:** with `MDSCR_EL1.SS` = 0, `MDE` = 0 or no enabled
  comparator nothing is raised, and `eret` already drops `SPSR.SS`, so `PSTATE.SS` stays 0.
- **Linux arms only while needed:** it sets `MDSCR_EL1.SS` on the return to a stepped task and clears
  it at the next kernel entry; `MDE` and a comparator's `E` are set only while a task with a hardware
  breakpoint or watchpoint is on the CPU. A boot writes zeros to the comparators and `TDCC` to
  `MDSCR_EL1`, which don't arm.

## Design

| Piece | What it takes | Where |
|---|---|---|
| Registers | `DBGBVR/BCR0-1`, `DBGWVR/WCR0-1` stored instead of RAZ/WI; `MDSCR_EL1` keeps its bits | `cpu.rs`, `sys.rs` (`raz_wi`), snapshot state (its version bumped) |
| Arming | A per-EL mask, recomputed on those MSRs (and `SCTLR_EL1` writes, which own the `A` case): EL0 armed with `SS`, or `MDE` and an enabled comparator for EL0; EL1 likewise with `KDE`. Coarse on purpose: `PSTATE.D` and the OS lock are checked precisely in the debug interpreter | the `SCTLR_EL1.A` test in `jit::key()`; once per chunk in `vm::chunk` when the JIT is off |
| Debug interpreter | A loop over `step_bus` with the checks below, through a `Watch<B: Bus>` wrapper: its own monomorphized copy, so `interp::steps` is untouched | new, `interp/debug.rs` |
| Software step | Before each instruction: step active and `PSTATE.SS` = 0 raises Software Step (EC 0x32/0x33, ISV and EX for exclusives); an instruction that retires clears `PSTATE.SS`. `PSTATE.SS` is pstate bit 21; ERET copies `SPSR.SS` only when step is active at the target; exception entry (the VM loop's IRQs too) saves it in SPSR by the step rules | the debug loop, `eret`, `enter` |
| Breakpoints | Before each instruction: `MDE`, `E`, PMC matching the EL, an address match (or the linked context comparator) raise Breakpoint (EC 0x30/0x31) | the debug loop |
| Watchpoints | `Watch` checks `read_el`, `write_el`, `host_aligned` (atomics) and DC ZVA against `DBGWVR/WCR` (BAS, LSC, MASK); a hit is a new `FaultKind`, taken as Watchpoint (EC 0x34/0x35, WnR, FAR); its `fast()` returns `None` | the `Watch` wrapper, `take_exception` |

The JIT's emitted code, its system-register paths, the block interpreter and the TLB don't change.

## Cost while debugging

Only what is debugged pays, and only while it is.

- **Single step** (ptrace, gdb `stepi`): each step runs a few hundred kernel instructions (from
  setting `MDSCR_EL1.SS` to the ERET) and one user instruction in the debug interpreter; then the
  kernel clears SS and the JIT takes over. The ptrace round trip dominates.
- **Hardware breakpoints and watchpoints:** the debugged task runs at the step interpreter's speed
  (~80-90 MIPS with the MMU on, [cpu.md](../cpu.md)) while it's on the CPU. Other tasks and the
  kernel stay in the JIT (per-EL arming) unless the comparator targets EL1.

**Not in the first build** (the user, 2026-10-22; a backlog item, revisited if performance is a
concern): hardware breakpoints and watchpoints at JIT speed, by refusing to compile or enter the
pages that hold a breakpoint address and withholding TLB entries for watched pages, so their
accesses take the slow helper, which checks the comparators.

## Constraints it adds

- An MSR to a debug register keeps ending its block: never in `msr_continues` or `plain_write`.
- A new path that changes the EL or enters compiled code passes the dispatcher's test.
- Persistent or profile-guided translation is unaffected: translations stay valid; debug mode only
  stops using them.

## Tests

1. kvm-unit-tests' `debug-*` (breakpoints, watchpoints, single step and their migration variants,
   which cover snapshots), excluded today in `core/tests/kvm_unit_tests.rs` with the backlog item as
   the reason: un-skipping them is the main gate.
2. A bare-metal test in `tests/baremetal/` for the step state machine's edges (stepping over an
   exception, an IRQ while stepping, exclusives), against `tests/baremetal/oracle.sh` (QEMU's TCG
   implements self-hosted debug).
3. Debian on the page: gdb `stepi`, `hbreak` and `watch` on a small program (dev VM).
4. `scripts/ci.sh` and `scripts/ci-debian.sh`, and a Chromium A/B of Alpine's boot and userspace
   showing the dispatcher's test costs nothing (dev VM).

**Guest-visible:** yes (debug exceptions start being raised), so it needs the user's OK; no test
guest arms debug, so `tests/steps.txt` shouldn't move.

**Effort:** ~500-800 lines of Rust plus tests, mostly the step rules and watchpoint matching; one or
two sessions. A cloud session can do the core and the native tests; the A/B and the gdb check need
the dev VM.
