# PERF loop 1: the decoded blocks' slots (2026-11-10)

bench/interp/REPORT.md "PERF loop 1". The M4 Mac mini (macOS 26.6.2), Chrome for Testing 157.0.8103.50; base `5d571308`.

- `pg-<arm>-r<round>.json` and `.jit.jsonl.gz`: Firefox's pages session from `pages.webpcsnap` with `PHASE_S=1`
  (`ab-pages.sh.txt`, rename to `.sh`; `pages-summary.txt` its lines), main against `SLOTS = 1 << 20` (`s20`).
- `p1s-r<round>-<arm>-<bench>.json`: `bench/interp/ab-mac.sh p1s 3 main=… s8=… -- dec_mips vm_dec_mmu_mips
  boot_alpine_dec`, main against the 8-byte slots of `slot8.diff` (against `5d571308`; not kept).
