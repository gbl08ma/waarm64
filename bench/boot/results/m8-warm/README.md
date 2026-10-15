# Where a busy vCPU's time goes in Firefox; warm members (2026-10-16)

`bench/boot/REPORT.md` "M8: where a busy vCPU's time goes in Firefox".

- `profile/`: the pages session's vCPU threads resolved against V8's jitdump (`attr.txt`: the attribution;
  `ksym.txt`, `kbucket.txt`: guest-kernel samples by symbol and subsystem; `ktarget.txt`: the kernel's entry stalls by
  target and by how the function was entered, from the session with x16/x17/LR sampled).
- `sessions/`: each pages session's `results.json` (`a`: before; `b1`, `b4`, `b16`, `c16`, `c32`, `c64`: warm 1, 4,
  16, 16, 32, 64; `k16`: warm 16 keeping a member's count), and `stalls.txt`: `bench/gpu/stalls.ts` on each
  session's timeline (busy MIPS).
- `gates/`: `bench/run.ts` JSON (`a`: before, `b16`: warm 16), three alternating rounds.
- `tools/`: ad hoc, paths as they were (`bench/results/local/...`). `run-jd.sh` / `run-regs.sh`: a session with
  `--perf-prof` and `perf record -k mono` (`--user-regs=x16,x17,lr`); `jd`, `jdr`: samples resolved against the
  jitdump by time (renamed `.mts.txt` so `tsc` skips them; run as `.ts` with Node); `attr`, `ksym`, `kbucket`,
  `ktarget`: the splits (the kernel ones need the guest's `System.map` and `Image` from the image's
  `/usr/lib/modules/*/build` and ESP); `entry`: the entry share from a perf map (the Mac host's `sample`);
  `chain.mjs`: the transfer microbenchmark; `abw.sh`, `tpw.sh`: the alternating A/B loops (core builds swapped).
