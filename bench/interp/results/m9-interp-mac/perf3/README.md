# PERF loop 3: `hot`'s cost per micro-op (2026-11-10)

bench/interp/REPORT.md "PERF loop 3". The M4 Mac mini (macOS 26.6.2), Chrome for Testing 157.0.8103.50; base `b74e1319`.

- `subs.diff`, `nzloc.diff`, `adrp.diff`: the three arms, each against `b74e1319` (none kept).
- `p3-r<round>-<arm>-<bench>.json`: `bench/interp/ab-mac.sh p3 3 main=… subs=… nzloc=… adrp=… -- dec_mips
  vm_dec_mmu_mips boot_alpine_dec`, the four arms alternated in each round.
