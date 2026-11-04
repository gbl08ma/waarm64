# Where a busy vCPU's time goes in Firefox, again (2026-11-04)

`bench/boot/REPORT.md` "Where a busy vCPU's time goes in Firefox, again".

- `attr.txt`: the vCPU threads' samples by category; `split.txt`: how functions were entered and the top non-guest
  functions; `bytime.txt`: the categories per 20 s window; `stalls.txt`: `bench/gpu/stalls.ts` (busy MIPS).
- `results.json`, `jit.jsonl.gz`: the session's results and the JIT's counters once a second (`JITLOG=1`).
- `chain.txt`: `bench/boot/results/m8-warm/tools/chain.mjs` at 1K-262K functions.
- `tools/`: `run.sh` (the session with `--perf-prof` and perf, from the snapshot; paths as they were, under
  `bench/results/local/ff-prof/`); `jdr` (samples against the jitdump, a time column added), `attr` (perf's map
  counted as V8 code), `split`, `bytime` (renamed `.mts.txt` so `tsc` skips them; the vCPU thread ids are hard-coded
  in `split` and `bytime`). The jitdump (3.6 GB) and perf.data (42 MB) weren't kept. Then:
  `perf script -F tid,time,ip,dso,uregs > samples.txt`, `jdr <jd dir> samples.txt jit.tsv`, `attr samples.txt jit.tsv`.
