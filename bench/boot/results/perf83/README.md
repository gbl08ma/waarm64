# PERF loop 83: what wakes an idle vCPU, and its poll before it sleeps (2026-11-26)

The data behind `bench/boot/REPORT.md` "PERF loop 83". Tree: 0c7707e7 plus the loop's change (web/ only: the core,
compiled code and `tests/steps.txt` are 0c7707e7's). M4, macOS; Chrome for Testing 158.0.8127.88 and Node 26.10.0
there; the dev VM's Node 26.7.0.

- `diag.patch` (applies to 0c7707e7; not landed): the diagnostic core's wake tallies (core/src/tally.rs `W_*`, words
  80-98, `N` 104) and the vCPU worker's (web/vcpu-worker.ts, web/idle-wait.ts `spinDiag`): run-loop entries after an
  IDLE exit whose wake word moved or didn't, the IDLE exits that retired nothing after each, the device and RX signals
  taken, `Vm::wake` by caller, the wake words' advance (less the core's own: the host's bumps), the worker's time from
  a sleep's end to the core's return for the empty exits, and every poll's time and whether a wake-up ended it;
  `stats().jit.wake` carries them to a page's JITLOG; `idle-cpu.ts` and `preempt-counts.ts` print or save them.
  `CARGO_TARGET_DIR=target/diag scripts/build-wasm.sh --features diag` with it applied. `python3 wakes.py <file>`
  prints a rate a second of each, for any of the three kinds below.
- `counts-vm.json`: `bench/boot/preempt-counts.ts --json … smp1 smp4 smp-user4` with the diagnostic core, dev VM.
- `idle-diag-vm.txt`: `bench/boot/idle-cpu.ts 4 6 20` with it (`WASM=target/diag/…`), dev VM, the poll at 50 µs.
- `pages-diag/diag-1/`: Firefox's pages session from `target/snapbench/pages.waarm64snap` with it, the Mac
  (`bench/gpu/ab-mac.sh … 1 diag=…`): `jit.jsonl.gz`'s `jit.wake`.
- `idle-mac.txt`: `idle-mac.sh <out> <rounds> 50 0 20 100` (its first two rounds, then a third rotated), the normal
  core: `<spin µs> <round> <idle-cpu.ts's JSON>`. `idle-vm.txt`: the same in the dev VM, 50 and 20, twice.
- `pingpong-mac.txt`: `pingpong.ts 50 0 20 100 10` in the Mac's Node, 3 rounds rotated (`<round> <JSON>`): the
  atomics stress's `pingpong` (20,000 hand-offs a pair, two pairs) on 4 vCPUs, LSE's and LL/SC's times.
- `ab-smp/`: `WORKLOADS=smp bench/ab-mac.sh … base=<core> s0=<core>?vspin=0 s20=…?vspin=20 s100=…?vspin=100`
  (`verdict.txt`).
- `gates/`: `gates.sh 3 50 20` (the parallel boots in Chromium on the Mac, `--query=vspin=<µs>`):
  `p83-s<spin>-r<round>-<bench>.json`; `python3 ../perf53/summary.py gates p83 s50 s20`.
- `pages/`: Firefox's pages session, 3 rounds of `base` (50 µs), `s0`, `s20` (`QUERY_s0=vspin=0 QUERY_s20=vspin=20
  bench/gpu/ab-mac.sh … 3 base=<core> s0=<core> s20=<core>`); `node bench/gpu/ab-summary.ts
  bench/boot/results/perf83/pages`; `results.json`'s `proc` (the renderers' CPU ns and energy).
