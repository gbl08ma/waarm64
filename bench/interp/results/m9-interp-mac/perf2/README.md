# PERF loop 2: the dispatcher's loop inside `jit::interpret` (2026-11-10)

bench/interp/REPORT.md "PERF loop 2". The M4 Mac mini (macOS 26.6.2), Chrome for Testing 157.0.8103.50; base `e6f37992`.

- `fuse.diff`: the change, against `e6f37992` (not kept).
- `pg-<arm>-r<round>.json` and `.jit.jsonl.gz`: Firefox's pages session from `pages.webpcsnap` with `PHASE_S=1`
  (`bench/results/local/interp/ab-pages.sh p2 3 main=… fuse=…`, its script as in `../perf1/ab-pages.sh.txt`;
  `pages-summary.txt` its lines).
- `p2j-r<round>-<arm>-<bench>.json`: `bench/interp/ab-mac.sh p2j 3 main=… fuse=… -- boot_alpine_jit alpine_user_jit
  boot_alpine_dec`.
