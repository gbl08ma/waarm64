# PERF loop 30: preemption's counts and tools (2026-11-16)

The data behind `bench/boot/REPORT.md` "PERF loop 30".

- `nobudget-r<round>-<arm>-<bench>.json`: the A/B that opened "Preemption without the budget" (PERF-HANDOVER.md),
  `bench/interp/ab.sh` on the dev VM (Chromium 155.0.8059.84), 3 rounds alternated; `a-base` 3d09c97e, `b-nob` the
  same with `nobudget.patch` (no `left` in compiled code: a test build, never meant to ship; its deterministic chunks
  then run past timer deadlines, and `vm_jit_mmu_mips` stopped early in every round, so it has no `b-nob` file).
- `codestats.json`: `bench/jit/codestats.ts` on two dumped module sets of Alpine's boot (`bench/jit/dump-modules.ts`):
  `mods-alpine` today's core (the base's code: 319 modules), `mods-nobudget` the patch's (317), both arches, Node 26.7.0
  (V8 14.6.202.34), x64 under qemu-x86_64 11.1.1 (`tools/x64node.ts`).
- `counts.json`: `bench/boot/preempt-counts.ts` with the diagnostic core (`--features diag`, on b707e614's sources), the
  dev VM, Node 26.7.0: `boot`, `user` (deterministic, 1 vCPU), `smp1`, `smp4`, `smp-user4` (parallel realtime);
  `node bench/boot/preempt-counts.ts --in counts.json` prints it.
- `mac-r<round>-base-<bench>.json`: the baseline, `bench/interp/ab-mac.sh` on the Mac (M4), one arm (b707e614's code;
  this loop changes no code the normal build has), 3 rounds.
