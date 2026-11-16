# PERF loop 31: parallel SMP's code without `left`, with a stop word (2026-11-16)

The data behind `bench/boot/REPORT.md` "PERF loop 31". Base: 0ffa96ef (loop 30's code, its own `web/`); new: loop 31.

- `counts-base.json`, `counts-new.json`: `bench/boot/preempt-counts.ts` with each arm's diagnostic core (`--features
  diag`), the dev VM, Node 26.7.0: `smp1`, `smp4`, `smp-user4` (parallel realtime); `--in` prints them.
- `codestats.json`: `bench/jit/codestats.ts` on two sets dumped by `bench/jit/dump-modules.ts --parallel 1` (Alpine's
  boot, parallel SMP on 1 vCPU; a set per core, not the same regions: per-function means), arm64 and x64.
- `deterministic-modules.json`: the SHA-256 of every module of Alpine's deterministic boot under both cores, and the
  two that differ (a core table's address).
- `mac-r<round>-<arm>-<bench>.json`: the Mac A/B (`bench/run-mac.sh`, Chrome for Testing 157), 5 rounds, the arm that
  runs first alternated each round, nothing else running on the dev VM or the Mac.
