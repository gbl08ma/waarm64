# BENCH: faster, quieter A/Bs — handover

The brief, the loops and what needs the user's OK: BENCH-KICKOFF.md. What each loop measured: bench/boot/REPORT.md
"BENCH loop N". What exists: docs/benchmarking.md "The paired A/B", "Counters".

## State (2026-11-23, after loop 3)

Loops 1-3 are done. `bench/ab-mac.sh <outdir> <base>=<core.wasm> <arm>=…` is the paired command (a pair is a fresh
browser with a page an arm, a warm-up and a sample each, names and orders drawn at random; the stop on time and
cycles at ±0.5%; an A/A arm in every run), with three workloads: `user` (the default), `boot`, and `node` (Node in
the guest running `images/alpine/node/jitjit.js`, image `alpine-node`: a JIT inside the JIT). A pair's time ratio
spreads 0.33-0.38%; with the base, `aa` and one arm, 1% takes ~6 min and a null ~12-13 on `user` and `node`, ~4 on
`boot`. The pages session cut to `PAGES=wiki,mdn` is 106 s a session with the whole session's precision (0.65%):
the confirmation at half the cost, not a screen. Loop 3's commit passed `scripts/ci-fast.sh`.

The user cut loop 2's "20 A/A runs" (they asked whether that many were needed): sessions and a replay of the rule
over the measured pairs stand for it (REPORT). Don't re-run it.

## Next: loop 4 (calibration against history)

- Arms with a known result on the full pages session and the gates, built from the current source with one constant
  changed (each into a file of its own; restore and rebuild after): `block::REGION` 16/32/64 (16 is measured:
  `node` +1.7%, `user` +4.2%, `boot` +5.6%, the pages session no change), the compile threshold 1000/2000 against
  500/1000 and 250/500 (`jit::REGION_AFTER` and its pair), preemption without the budget against before it, and two
  or three nulls (PERF loops 42, 54). One `bench/ab-mac.sh` run takes several arms: `WORKLOADS=node,user,boot`.
- The outcome is the table of which workload and measure ranks which kind of change as the pages session did, and
  what is dropped. Already known: read time first; the renderer's cycles and instructions are all its threads' and
  went the wrong way on `node` for regions of 16 (−5% and −6% for +1.7% of time).
- Open: a per-thread reading of the vCPU's CPU time or cycles; `@<tree>` not yet run against a tree of another ABI;
  why the base arm ran 0.1-0.15% fast under fixed names and a rotating order (randomized away); a desktop session
  inside one browser beside its other arm (what would make the pages session pair as tightly as the gates); the
  pages session's cycles and instructions a step in an A/A (loop 1).
- Loop 5 (a measurement queue): `bench/ab-mac.sh` already takes the CI lock exclusive, so runs queue by themselves;
  what is left of it is leaving verdicts where an agent finds them, which `<outdir>/verdict.txt` does. Likely
  nothing to build: decide after loop 4.
