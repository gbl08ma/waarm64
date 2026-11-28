# PERF loop 98: an adaptive idle-vCPU poll (2026-11-28)

The data behind `bench/boot/REPORT.md` "PERF loop 98". Tree: 5d9fd31e plus the loop's change (web/ only: the core,
compiled code and `tests/steps.txt` are 5d9fd31e's). M4, macOS; Chrome for Testing 158.0.8127.88 and Node 26.10.0
there; the dev VM's Node 26.7.0.

- `diag.patch` (applies to 5d9fd31e; not landed): each vCPU worker's idle tallies in a `SharedArrayBuffer`
  (web/vcpu-worker.ts `diagIdle`, carried by web/vm.ts `stats().jit.idle98`, summed over the vCPUs): every idle's
  outcome (ended by the poll, by a later wake-up, at its deadline), when the wake-up came, the idles and the poll's
  catches by the idle's deadline, and ten candidate rules simulated on the idles as they ran (each rule's polls, poll
  time, catches kept and catches it would have slowed): a streak of K misses (K 1-64), and "a catch within T ms"
  (T 1, 10, 100). `python3 rules.py <file>` prints them a second (`rules-out.txt`).
- `counts.ts`: the counts in Node (`idle`, `pingpong`, `smp4`, `smp-user4`) with the patch applied: `counts-vm.txt`
  (the dev VM).
- `pages-diag/diag-1/`: Firefox's pages session from `target/snapbench/pages.waarm64snap` with the patch, the Mac
  (`bench/gpu/ab-mac.sh … 1 diag=<core>`): `jit.jsonl.gz`'s `jit.idle98`.
- `pingpong.ts`: ../perf83/pingpong.ts with `VmOptions.vcpuPollMisses` as its arms (`PP_N=1280000`: 80,000 hand-offs a
  pair). `node-mac.sh <out> <rounds> idle|pingpong <misses>...`: those and `bench/boot/idle-cpu.ts 4 5 20 - <misses>`
  in the Mac's Node, arms rotated (`<misses> <round> <JSON>`).
  - `pingpong-mac.txt` (the stress's default n, 3 rounds), `pingpong-mac-4x.txt` and `pingpong-vm-4x.txt` (the dev
    VM, `<round> <JSON>`): the rule's first form, which counted a wake-up within twice the poll as a catch whether or
    not the idle polled.
  - `pingpong-vm-4x-b.txt`, `pingpong-mac-k8.txt`, `idle-mac.txt`: the kept form (an unpolled idle's wake-up counts
    within the poll and `WAIT_WAKE_MS`).
- `pages/`: the pages session, 3 rounds of `base` (`QUERY_base=vmiss=0`: always polls) and `new` (the default, 8),
  `bench/gpu/ab-mac.sh … 3 base=<core> new=<core>` (one core); `node bench/gpu/ab-summary.ts bench/boot/results/perf98/pages`;
  `results.json`'s `proc` (the renderers' CPU ns and energy).
- `gates/`: `gates.sh 3 0 8` (the parallel boots in Chromium on the Mac, `--query=vmiss=<n>`):
  `p98-m<n>-r<round>-<bench>.json`; `python3 ../perf53/summary.py bench/boot/results/perf98/gates p98 m0 m8`.
- `summary.json`: the measures above in one place.
