# PERF loop 92: three JIT and run-loop costs counted (2026-11-28)

The data behind `bench/boot/REPORT.md` "PERF loop 92". Tree 5e1e1700. M4, macOS, Chrome for Testing 158.0.8127.88,
the Mac's Node v26.10.0.

- `diag.patch` (applies to 5e1e1700): the `diag` tallies grown to 96 words: 80 a static chain through the jump cache
  that fell through, 81-83 TLB probes run (with SP's guard, all, SP's with a fold constant 0 mod 16 and a span within
  16 bytes), 88-90 `Vm::refresh` calls, its swaps, the swaps that changed the byte; the web/ part sums the tallies into
  `__status.stats.jit.diag`. Built with `CARGO_TARGET_DIR=target/diag scripts/build-wasm.sh --features diag`.
- `preempt-counts.json`: `bench/boot/preempt-counts.ts` with that core in the dev VM's Node (boot, user, smp4,
  smp-user4).
- `pages-diag/`: Firefox's pages session with that core (`bench/gpu/ab-mac.sh`, one session); `jit.jsonl.gz`'s last
  line has the totals (`jit.diag`).
- `chain3.mjs`, `chain3-mac.txt`: `results/m9-relink/chain2.mjs` with the jump cache's tail of a late-compiled
  successor (`jc`, `jcleft`, `jcconst`) beside `indirect`'s constant index (a reserved slot); every kind's memory written
  the same way (see its header: an untouched memory made `indirect` 4× slower in the dev VM).
- `swap.c`, `swap-mac.txt`: refresh's swap of four bytes that other cores read, against a load first.
- `codestats-nosp.json`, `ab-nosp/`: the bound for SP's alignment guard: a core with the guard dropped outright
  (unsound, measurement only), Alpine's boot's modules in `bench/jit/codestats.ts` (arm64, x64) and the paired A/B
  on `node`.
