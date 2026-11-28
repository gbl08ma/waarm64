# PERF loop 100: the review of the idle wait fixed (2026-11-28)

The data behind `bench/boot/REPORT.md` "PERF loop 100". Base: 545bf283 (its web/ and core, built in `../waarm64-base`);
new: the loop's tree. M4, macOS; Chrome for Testing and Node there as in PERF loop 99; the dev VM's Node 26.7.0.

- `pingpong-vm.sh <out> <rounds> <arm>=<core>@<tree>...`: ../perf98/pingpong.ts (the default rule, `PP_N=1280000`) in
  the dev VM, arms alternated: `pingpong-vm.txt` (5 rounds).
- `node-mac.sh <out> <rounds> idle|pingpong` (`BASE_TREE`, `BASE_WASM`, `WASM`): the same and `bench/boot/idle-cpu.ts 4
  5 20` in the Mac's Node, the base tree in a `p100base/` there that it removes: `pingpong-mac.txt` (5 rounds),
  `idle-mac.txt` (4 rounds).
- `pages/`: Firefox's pages session, `bench/gpu/ab-mac.sh … 3 base=<core>@../waarm64-base new=<core>`;
  `node bench/gpu/ab-summary.ts bench/boot/results/perf100/pages`.
- `gates.sh <rounds> <arm>=<core>@<tree>...`: the parallel boots in Chromium on the Mac (2 rounds):
  `gates/p100-<arm>-r<round>-<bench>.json`; `python3 ../perf53/summary.py bench/boot/results/perf100/gates p100 base new`.
- `summary.json`: the measures above in one place.
