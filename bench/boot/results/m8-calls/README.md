# Guest calls as host calls (2026-10-16, not kept)

`bench/boot/REPORT.md` "M8: guest calls as host calls".

- `host-calls.patch`: the last variant (b8: a call's continuation a member and an entry of the caller's region),
  against `03cb438`, with its tests. `call-counters.patch`: diagnostic counters of host calls and returns (`Y:<i>`
  lines in `Table::helper_report`, for `bench/boot/userprof.ts`; `tools/ydiag.mjs` prints them per phase), on an
  earlier variant.
- `gates/`: `bench/run.ts` JSON, `a` the baseline; `b3` rounds 1-3, `b4` 4-6, `b8` 7-9, each with the baseline's
  rounds of the same numbers (`tools/gates.mjs <dir> a <b>`).
- `sessions/`: Firefox pages sessions' `results.json` and `stalls.txt` (`a-4` hung on its first page).
- `profile/`: the vCPU threads' samples of a pages session with `--perf-prof` and x16/x17/LR sampled (the tools of
  `results/m8-warm/tools/`), at HEAD (`regs0`), b4 and b8: the attribution, where guest-code samples land
  (`tools/land`), and the kernel's entry stalls by target (`ktarget`; b4 and b8 have the new block signature,
  `0x8000004`, so the second, old-signature table is empty for them and the first for HEAD).
