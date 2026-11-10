# PERF loop 19: the copy of `hot` chosen per block (2026-11-10)

bench/interp/REPORT.md "PERF loop 19: the copy of `hot` chosen per block". The Mac host (Apple M4, macOS 26.6.2),
Chrome for Testing 157.0.8103.50; base `e78e110b`.

- `p19-r<round>-<arm>-<bench>.json`: main, blk (kept: loop 17's rich copy entered per block), rich (loop 17's `rich`,
  the rich copy to the end of `interpret`'s call, merged onto main) on `dec_mips`, `vm_dec_mmu_mips`,
  `boot_alpine_dec`, `dec_fp_mips` (`bench/interp/ab-mac.sh`, rounds alternated); `p19b-…` main, blk, blklit (blk with
  the literal loads choosing the rich copy too). `p19sum.ts.txt` prints the medians (rename to `.ts`, run from the repo
  root with the files under `bench/results/local/mac/`).
- `pg-<arm>-r<round>.json`, `pages-summary.txt`: Firefox's pages session (`../perf17/ab-pages.sh.txt`, `PHASE_S=1`),
  main and blk, five rounds alternated; `pg-diag-r1.json` and `pg-diag-r1-jit.json`: one session of blk counting its
  switches between the copies in `jit::Stats::rescues` (a diagnostic build only: 10.76 M switches, `rescues`).
