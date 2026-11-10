# PERF loop 4: misaligned stores inline; SUBS and ADDS as their own kinds (2026-11-10)

bench/interp/REPORT.md "PERF loop 4". The M4 Mac mini (macOS 26.6.2), Chrome for Testing 157.0.8103.50; base `93307eb8`.

- `p4-r<round>-<arm>-<bench>.json`: `bench/interp/ab-mac.sh p4 3 main=… stores=… subs=… -- dec_mips vm_dec_mmu_mips
  boot_alpine_dec`, the three arms alternated in each round. `stores` is `stores-loop.diff`; `subs` is the commit.
- `p4b-r<round>-<arm>-<bench>.json`: the second session, `ab-mac.sh p4b 3 subs=… main=… both=… subs2=…`: `both` is
  `subs` with `stores-bytes.diff`, `subs2` is `subs` with `ccmp.diff`.
- `stores-loop.diff`, `stores-bytes.diff` (against `93307eb8`), `ccmp.diff` (against the SUBS kinds): not kept.
