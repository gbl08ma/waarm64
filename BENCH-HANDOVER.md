# BENCH: faster, quieter A/Bs — handover

The brief, the loops and what needs the user's OK: BENCH-KICKOFF.md. What each loop measured: bench/boot/REPORT.md
"BENCH loop N". What exists: docs/benchmarking.md "The paired A/B", "Counters".

## State (2026-11-23, after loop 2)

Loops 1 and 2 are done. `bench/ab-mac.sh <outdir> <base>=<core.wasm> <arm>=…` is the paired command: a pair is a
fresh browser with a page an arm (a warm-up and a sample each, names and orders drawn at random), the stop on time
and cycles at ±0.5%, an A/A arm in every run. On `user` a pair's ratio spreads 0.38% in time; with the base, `aa` and
one arm a 2% difference takes 4-5 min, 1% ~6, a null ~12 (`boot`: ~4), the cap ~24. Regions of 16 against 64
reproduce (+4.2% and +5.6%); six stopped A/A runs ended `same`. Its commit passed `scripts/ci-fast.sh`.

The user cut the kickoff's "20 A/A runs" (they asked whether that many were needed): three sessions and a replay of
the rule over the measured pairs stand for it (REPORT). Don't re-run it.

## Next: loop 3 (two short workloads from snapshots)

- The kickoff's (a) Node in the guest, a JIT inside the JIT, and (b) the pages session cut to its first pages, each
  as a workload of the paired command if a sample can be made deterministic enough to pair (a fresh browser, a
  warm-up, a sample: a snapshot's restore in `bench/boot/pair.ts`, or pairs of `bench/gpu/ab-mac.sh` sessions read by
  `bench/stats.ts`'s `paired`).
- From loop 2 to use: time is the deciding measure (the renderer's cycles moved 1.0% and −0.2% for regions of 16's
  4-6%, being all its threads'); `instr` decides alone only for changes to the work itself.
- Open from loop 2: a per-thread reading of the vCPU's CPU time or cycles (macOS: `proc_pidinfo`'s thread lists give
  times; counters may need the task port), which would be the tight measure for compile-policy changes; `@<tree>`
  not yet run against a tree of another ABI (loop 4's arms will); why the base arm ran 0.1-0.15% fast under fixed
  names and a rotating order was not found (randomized away).
- Open from loop 1: the pages session's cycles and instructions a step in an A/A.
