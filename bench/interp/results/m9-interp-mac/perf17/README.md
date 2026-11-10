# PERF loop 17: more handlers (2026-11-10)

bench/interp/REPORT.md "PERF loop 17: more handlers". The Mac host (Apple M4, macOS 26.6.2), Chrome for Testing
157.0.8103.50; base `215cdba5`.

- `diag.patch`: the counting core (not for commit): `interp::block::diag` counts each exit from `hot` by its first
  micro-op's class (an `Op`, or `K_<kind>` for a handled kind's slow path, with `<kind>_mis|cross|other|fpen` and
  `pair_misaligned|crosspage` causes) and each stretch micro-op, process-wide; dumped as a `webpc-slow diag17` line every
  20 s (`web/vm.ts`'s `diag_log` import) and by `alpine_boots_through_the_block_interpreter` natively.
  `diag17.ts.txt` prints a line by class (rename to `.ts`). `alpine-native-diag17.txt`: Alpine's native boot;
  `pages-p17diag-diag-r1.txt` and `pages-p17diag2-diag-r1.txt` (with the causes): Firefox's pages session from the
  snapshot.
- `mis.diff` (kept: misaligned pair and SIMD&FP loads inline, PRFM by register a `Nop`; `prfm.diff` alone),
  `rich.diff` (on top of `mis`: the rich copy of `hot`), `rich2.diff` (its `jit/mod.rs` going back to the lean copy
  after each stop), `rich3.diff` (rich with the rich kinds in generic stretches), `leanonly.diff` (rich never entered).
- `p17-r<round>-<arm>-<bench>.json`: main, mis, rich on `dec_mips`, `vm_dec_mmu_mips`, `boot_alpine_dec`,
  `dec_fp_mips`; `p17b-…` mis, rich, rich2; `p17c-…` mis, rich, rich3; `p17d-…` mis, leanonly, rich
  (`bench/interp/ab-mac.sh`, rounds alternated; `p17sum.ts.txt` prints the medians).
- `pg-<arm>-r<round>.json`, `pages-summary.txt`: Firefox's pages session (`ab-pages.sh.txt`, `PHASE_S=1`), main, mis,
  rich, three rounds alternated.
