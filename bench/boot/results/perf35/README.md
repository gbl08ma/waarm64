# PERF loop 35: the end of "Preemption without the budget" (2026-11-17)

The data behind `bench/boot/REPORT.md` "PERF loop 35".

- `pages/<arm>-<round>/`: Firefox's pages session from `target/snapbench/pages.waarm64snap` (made by b770bb20's core,
  `bench/gpu/warm-snapshots.sh firefox`) on the Mac host (M4, macOS 26.6.2, Chrome for Testing 157.0.8103.78),
  `bench/gpu/ab-mac.sh perf35/ab 5 base=<0ffa96ef's core>@../waarm64-base main=<b770bb20's core>`: base is 0ffa96ef
  (before PERF loop 31) with its own web/ (ABI 70), main b770bb20 (loop 34's end, ABI 71); 5 rounds, the first arm
  alternated, nothing else on the dev VM or the Mac. Each session's `results.json`, `counts.json`
  (`bench/boot/results/m8-replay/counts.ts`), `stalls.json` (`bench/gpu/stalls.ts` on its whole-session timeline,
  deleted after), `jit.jsonl.gz`, `wall.txt`; `pages.log` the harness's lines.
- `pages-summary.json`: `node bench/gpu/ab-summary.ts --json bench/boot/results/perf35/pages` (per session and per arm:
  median, IQR, all values; `pagesS` is Firefox's five starts and the pages' loads summed).
- `counts-base.json`, `counts-new.json`: `bench/boot/preempt-counts.ts smp1 smp4 smp-user4` with the diagnostic cores
  (Node 26.7.0 on the dev VM) without and with the final review's fix 1 (a region's edge to a member whose key isn't
  above its block's polls).
- `codestats.json`: `bench/jit/codestats.ts` (arm64, x64) of a parallel boot's modules per core (`dump-modules.ts
  --parallel 1`, Alpine on 1 vCPU), the same two arms.
- `deterministic-modules.json`: Alpine's deterministic boot dumped by b770bb20's core and this loop's: 319 modules each,
  2,651,076,469 steps each, all byte-identical.
