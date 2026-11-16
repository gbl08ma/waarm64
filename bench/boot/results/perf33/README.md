# PERF loop 33: the review of the preemption code, fixed (2026-11-16)

The data behind `bench/boot/REPORT.md` "PERF loop 33". Base: 783e88a7 (loop 32's code); new: this loop.

- `deterministic-modules.json`: the SHA-256 of every module of Alpine's deterministic boot (`bench/jit/dump-modules.ts`)
  under both cores: 319 each, 2,651,076,469 steps each, none differing.
- `counts-base.json`, `counts-new.json`: `bench/boot/preempt-counts.ts` with each arm's diagnostic core (`--features
  diag`), the dev VM, Node 26.7.0: `smp1`, `smp4`, `smp-user4`; `--in` prints them.
- `codestats.json`: `bench/jit/codestats.ts` on two sets dumped by `dump-modules.ts --parallel 1` (Alpine's boot,
  parallel SMP on 1 vCPU; a set per core: per-function means), arm64 and x64.
- `mac-r<round>-<arm>-<bench>.json`: the Mac A/B (`bench/run-mac.sh` with `WASM=` per arm, Chrome for Testing 157), 5
  rounds, the arms' order reversed every other round, nothing else running on the dev VM. `python3 summary.py . mac base
  new` prints each bench's per-round medians as ranges, the change and the overlap.
