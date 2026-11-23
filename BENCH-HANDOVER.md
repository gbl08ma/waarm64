# BENCH: faster, quieter A/Bs — handover

The brief, the loops and what needs the user's OK: BENCH-KICKOFF.md. What each loop measured: bench/boot/REPORT.md
"BENCH loop N". What exists: docs/benchmarking.md "The paired A/B", "Counters".

## State (2026-11-23, after loop 4)

Loops 1-4 are done. `bench/ab-mac.sh <outdir> <base>=<core.wasm> <arm>=…` is the paired command (a pair is a fresh
browser with a page an arm, a warm-up and a sample each, names and orders drawn at random; the stop on time and
cycles at ±0.5%). Workloads: `node` (the default: Node in the guest, a JIT inside the JIT), `user`, `boot`. A pair's
time ratio spreads 0.33-0.38%; for one arm on `node` 2% takes ~4 min, 1% ~5, a null ~9. Loop 4's calibration: `node`
orders regions of 16 and 32 and the thresholds 500/1000 and 250/500 as the pages session did; `user` and `boot` don't
(gates for their own guests); nothing paired sees parallel SMP, the run loop or flushes. Read time; the renderer's
cycles and instructions are all its threads'. Loop 4's commit passed `scripts/ci-fast.sh`.

Decisions the user took on the way (in the kickoff's "Decisions taken" too): the A/A arm is opt-in (`AA=1`); no new
full pages sessions for arms history already has; loop 2's "20 A/A runs" cut to sessions and a replay.

## Next: loop 6 (the end); loop 5 has nothing to build

- Loop 5 (a measurement queue): `bench/ab-mac.sh` takes the CI lock exclusive, so runs queue by themselves and leave
  `<outdir>/verdict.txt`; a run is 4-15 min. Nothing more is worth building: say so in the REPORT at the end.
- Loop 6: docs/benchmarking.md's "Rules" and "Screening an A/B" rewritten around the tiers (counts; `node` paired;
  the gates paired as regression checks; the pages session cut, then whole) and CLAUDE.md's "Performance" bullets
  with them (the user's OK for the rules: propose the text); PERF-HANDOVER.md's "Measurement" pointing at the one
  command; an out-of-context review of the new tools (`bench/ab.ts`, `bench/ab-mac.sh`, `bench/boot/pair*.ts`,
  `bench/stats.ts`, `bench/procstat.ts`); the loose ends below into docs/backlog.md; `scripts/ci.sh`; PLAN.md's
  row; this file and the kickoff deleted.
- Loose ends for the backlog: a per-thread reading of the vCPU's CPU time or cycles (the tight measure for
  compile-policy changes); a paired workload under parallel SMP (polled code, 2-4 vCPUs), which nothing paired
  covers; a desktop session inside one browser beside its other arm (so the pages session pairs as tightly as the
  gates); `@<tree>` not yet run against a tree of another ABI; an interpreter-only arm for the calibration; why the
  base arm ran 0.1-0.15% fast under fixed names and a rotating order (randomized away).
