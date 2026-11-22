# PERF loop 52: what leaves `hot` counted again; exact zero results inline (2026-11-22)

bench/interp/REPORT.md "PERF loop 52". The Mac host (Apple M4, macOS 26.6.2), Chrome for Testing 158.0.8127.36; base
`9895a9bd`.

- `diag.patch`: the counting core (not for commit): `interp::block::diag` counts `hot`'s returns by copy and status,
  the steps each copy retired, the changes of copy, the rich stints by the block that started them, and each exit by
  copy, its first micro-op's class (with the loads' and stores' causes and `Farith`'s) and its stretch's classes
  together; a `waarm64-slow waarm64-diag52` line every 2^26 interpreted steps on wasm (the page's `slow` lines, so
  `results.json`), and at the end of `alpine_boots_through_the_block_interpreter` natively. `diag52.ts.txt` summarizes
  a file's last line (rename to `.ts`).
- `alpine-native-diag.txt`: Alpine's native boot (the first version of the core, without `Farith`'s causes);
  `dec_fp_mips-diag.txt`: the FP guest's last placement (`bench/run.ts --only dec_fp_mips` on the dev VM's Chromium;
  `jit_fp_mips` interprets only its cold sample); `pages-diag.txt`: Firefox's pages session from the snapshot
  (`bench/gpu/ab-mac.sh`, one session, with `Farith`'s causes).
- `p52s<round>-r1-<arm>-<bench>.json`: main and zero (kept) on the block-interpreter guests and the JIT gates
  (`screen.sh.txt`: `bench/interp/ab-mac.sh` a round at a time, the first arm swapped each round); `p52sum.ts.txt`
  prints the medians (rename to `.ts`, run from the repo root with the files under `bench/results/local/mac/`).
- `pg-<arm>-<round>.json`, `pages-summary.txt`: Firefox's pages session, main and zero, three rounds alternated
  (`bench/gpu/ab-mac.sh`; `node bench/gpu/ab-summary.ts`).
