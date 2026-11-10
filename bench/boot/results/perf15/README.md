# PERF loop 15: the parallel SMP leftovers (2026-11-10)

`bench/boot/REPORT.md` "PERF loop 15: the parallel SMP leftovers".

- `diag.patch`: the counting core against `0b3e44e7`. It reuses the platform lock's two counter words: `lockContended`
  counts ISBs that the fast completion refused because the JIT table was behind (`Jit::behind`), and `lockWaitNs`
  counts ISBs that passed that check. Diagnostic only.
- `nofix.patch`: the A/B's base arm, which is main without the ISB's `behind` check.
- `pages/`: Firefox's pages session with the diagnostic core, from `pages.webpcsnap` on the Mac (`results.json`'s
  `par`, `jit.jsonl`).
- `ab/`: `bench/interp/ab-mac.sh perf15 3 nofix=… main=… -- smp_user_jit_4` (`perf15-r<round>-<arm>-smp_user_jit_4.json`).
- `exitloop/`: `exitloop.c` is a bare-metal EL1 loop of one exiting instruction. Built as tests/baremetal/build.sh
  builds its tests (`-I tests/baremetal`, with `start.S` and `link.ld`). `-DONLY=<k> -DONLY_N=40000000ull` runs one kind
  with the MMU on: 0 is `mrs cntfrq_el0`, 1 is `isb`, 2 is `wfe`, 3 is `svc`, and 9 is an empty loop. Without `ONLY`
  it runs every kind in rounds, but its own counter timings aren't valid: that clock doesn't count in
  `runToPowerOff`, so read the host's `ms`. `BIN=only<k>.bin node run.ts 2` runs one in Node in parallel SMP with 2
  vCPUs, realtime, under the JIT. `perf-only<k>.txt` holds the flat profiles from
  `perf record -F 4999 -g -- node --perf-basic-prof --interpreted-frames-native-stack run.ts 2`.
