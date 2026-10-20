# M8 interpreter speed: handover (2026-10-20)

**The goal is the block interpreter's own speed**, judged alone, not through what it adds to a JIT run. The
reason is the JIT cache. Days of work on flushes went into the stalls, carrying the hot set and V8's memory
(docs/jit.md "Tried and not kept"), with little to show. The lever left is to **compile less**. Today the block
interpreter runs at ~200-260 MIPS, within roughly 1.5-2× of Liftoff code. The closer it gets to Liftoff, the
higher the compile threshold can go: fewer modules, less V8 memory, and more of the cache left for code that is
really hot. Even if the emulator gets no faster overall, it would use less memory and flush later.

The assessment behind this (written in a cloud session from the code and the repo's numbers, nothing timed) is in
the project's files, `cpu-sota/interpreter.md` and `cpu-sota/assessment.md`. This handover is self-contained.

Read first: docs/cpu.md "The block interpreter"; `core/src/interp/block.rs` (`Uop`, `run`, `Cache`) and
`core/src/jit/mod.rs` `interpret`; docs/v8.md (spills at calls, bounds checks, the growable memory's size reloads,
the placement effect); docs/cpu.md "Memory accesses and atomics" (why the core's guest accesses are atomics);
bench/interp/REPORT.md "M8: the block interpreter" (how it reached today's speed); docs/backlog.md "Interpreter".

## The yardstick

Interpreter MIPS, from benchmarks that run **only** the block interpreter (VmConfig.jit 4 or `jit_new` with a
threshold of `u32::MAX`: `bench/interp/suite.ts` `JIT_INTERP`):

- the existing small guests: `dec_mips` (user mode, eight placements), `vm_dec_flat_mips`, `vm_dec_mmu_mips`, and
  their `_cold` samples. These are hot loops, so they show per-instruction and per-block costs but not cold code's
  mix;
- **new in loop 0**: the boots under `jit` 4 in Chromium, timed as MIPS (steps over time) and checked against
  `tests/steps.txt`. Use Buildroot (40.5M steps, well under a second) and Alpine (2,856,663,287 steps, ~15-20 s at
  today's speed; natively the same boot runs at ~190 MIPS, 15 s). They are real cold code (the kernel, BusyBox,
  libc) with exact steps for free. This is a deliberate exception to CLAUDE.md's rule against booting complex
  guests interpreted in Chromium: that rule is about the old interpreter's minutes. Keep each run under a
  `timeout` and a memory cap, as always.
- **the reference to close in on:** the same boots and small guests under the JIT with `--config liftoff-only`
  (`bench/run.ts`). That's Liftoff's speed with its compile included, the cost the interpreter competes with.

Rank on the dev VM (Chromium, A/B in one session, alternated, small guests at eight placements:
docs/benchmarking.md). **Confirm each kept change on the Mac host** (`bench/run-mac.sh`): the dev VM pays explicit
bounds checks that macOS and x86_64 users don't, and an interpreter that keeps guest registers in memory pays them
on every operand.

## The loops

In order, one commit and a REPORT section (`bench/interp/REPORT.md`, JSON in `bench/interp/results/`) per loop.
Drop or reorder items on what loop 0 shows. Each item below says what to look for.

### 0. Profile and baseline

- `perf` with `--perf-prof` in Node (docs/benchmarking.md "Profiling") on the Alpine and Buildroot boots under
  `jit` 4: the share of `interpret`, `run`, `Cache::get`/`miss`, `exec_at_op` (the generic path), `Bus::fast` and
  the slow paths. `perf annotate` `run`'s hot handlers.
- `--print-wasm-code` (`tools/v8code.ts` is the model) for `interp::block::run` and `jit::interpret`. Look for:
  - loop-carried values (`pc`, the index, the slice, `c`) spilled at definition, because of the calls in the
    generic arm and the slow paths;
  - `run`'s return value going through the shadow stack (`__stack_pointer`);
  - bounds checks and memory-size reloads around `Cpu.x`;
  - `ldar` and `stlr` on guest accesses;
  - how the `match` became a jump table.
- Count at decode, over the boots' and a browser's decoded blocks: the instruction mix, the generic path's share
  by class, and the most frequent adjacent pairs and triples (input for loop 4). A browser's cold code is the
  snapshot-started Firefox pages session (bench/gpu, docs/benchmarking.md "Starting from a snapshot"), counted
  with a diagnostic core, not timed.
- Baseline every yardstick, with liftoff-only beside it.

### 1. A call-free hot loop

Merge `interpret` and `run` into one loop over blocks and micro-ops. The generic path, the slow arms of loads and
stores, and exits leave it with a small status, as JIT code leaves for its helpers (0 retired, 1 exit pending),
and the loop resumes after the call outside it. Nothing returns through the shadow stack. Check with
`--print-wasm-code` that the loop's state stays in registers. If V8 still spills at calls, split the loop so the
calls sit in the outer function.

### 2. Pre-linked successors

A decoded block keeps the arena index of its taken and fall-through successors, filled the first time each is
followed. They're cleared with the arena's restart and by the page's invalidation (both already epoch-like), and
guarded for another page, as `interpret` does now through the instruction TLB. A "compiled" bit in the slot,
set when the table installs the key, replaces the jump-cache check. The counting stays exact: a block reports at
its threshold (docs/cpu.md "Counting"), and `blocks` against `regionBlocks` must not move.

### 3. Lazy NZCV

ADDS, SUBS, CMP, CMN, TST, ADCS and SBCS keep their operands and kind in the `Cpu` (or in the loop's locals, after
loop 1). B.cond, CSEL, CCMP and CSET read conditions from the operands where the kind allows, as `emit.rs` does.
NZCV is materialized before the generic path, at exits, and wherever anything reads `c.nzcv`. The JIT's rules
(docs/jit.md "Lazy NZCV") are the model.

### 4. Superinstructions

The top pairs and triples from loop 0's count become single micro-ops, generic over registers and immediates,
fused at decode. Likely candidates: CMP+B.cond, TST+B.cond, ADRP+ADD, ADRP+LDR, MOVZ+MOVK, LDR+CBZ/CBNZ, ADD+B,
and runs of LDP and STP off one base. Take the 16-32 that cover the most of the counted mix. One fused micro-op
still retires its instructions one by one where an exit can fall between them: a fault in the second instruction
must retire the first, with the step count and PC the interpreter gives.

### 5. Specialization and more handlers

Resolve at decode what `run` tests at run time: XZR or SP (`reg`/`set_reg`'s branch), `sf`, shift 0, extend kinds.
Add handlers for what loop 0 finds on the generic path. Expected: EXTR, UMADDL/SMADDL/UMULL, MRS of plain
registers, FP and SIMD loads and stores (Q pairs are memcpy: 0.27 GB/s now against 21.6 under the JIT), LDADD and
the other LSE ops, and the exclusives.

### 6. The threshold, again

With the interpreter faster, sweep the pressure-driven threshold's floor (50 now; 100, 200, 500) and `warm`, as in
bench/boot/REPORT.md "M8: a compile threshold that follows the code cache's pressure". Measure:
- **wasm compiled, modules and the renderer's memory** first: Firefox's pages session from the snapshot, and the
  churn page for flushes;
- then busy MIPS, the Alpine boot and userspace benchmark, and Chromium's renders.

The goal is the lowest compile volume that holds speed. A small loss of speed for much less code is worth showing
the user.

### 7. One decoded-block store shared by the tables

Docs/backlog.md "Interpreter", first item: each vCPU's table decodes the same code again. A shared arena with an
epoch scheme like the code cache's `drops` gives each table the whole budget and decodes once. Measure with the
4-vCPU Chromium renders and Firefox's pages session.

## Not to do

- **Threaded dispatch through tail calls** (handlers as functions calling the next with `return_call_indirect`,
  nightly Rust's `become`). On wasm each hop is a `call_indirect`, 2.5 ns on the M4 (bench/spike/REPORT.md),
  against a jump-table branch the M4 predicts well. Try it only if loop 0 shows the dispatch branch mispredicting.
- **Plain (non-atomic) guest accesses from Rust.** These are UB under races, and volatile accesses measured no
  better (docs/cpu.md). If loop 0 shows `ldar` or `stlr` costing a lot, bring the numbers to the user before
  changing the memory rules.
- A rebuild. The structure is right; every item above changes `interp/block.rs` and `jit::interpret` in place.

## Rules that bite here

- **The block interpreter is the reference for cold code's steps.** Every change keeps `interp::steps`'s steps and
  exits. The tests are its native differential test against `interp::steps` (`interp::block::tests`), the corpus
  through it on wasm (`tests/corpus-wasm.test.ts`), the native boots through it
  (`linux_boots_through_the_block_interpreter`, `alpine_boots_through_the_block_interpreter`;
  `WEBPC_NATIVE_JIT=1`), and every JIT run's exact steps. Plant a bug for every new handler, fused pair and lazy
  flag rule, and check that the tests catch it.
- No guest-visible change, so `tests/steps.txt` must not move.
- `scripts/ci.sh` per loop; also `scripts/ci-debian.sh` at loop 6 (it changes what compiles on the page) and at
  the end.
- Native speed isn't the yardstick: the interpreter runs natively in `cargo test`, but what counts is what V8
  makes of it. Profile in Node, decide in Chromium.
- Cap memory and bound every run (CLAUDE.md "Working rules"). Run the CI scripts alone.

## When done

Write the outcome into docs/cpu.md "The block interpreter" (what was built, and what was tried and lost), close the
backlog's "Interpreter" items that were done, update CLAUDE.md's status and PLAN.md, and delete this file in that
commit.
