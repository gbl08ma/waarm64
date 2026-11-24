# PERF tooling: a multi-vCPU paired workload (2026-11-24)

The data behind `bench/boot/REPORT.md` "PERF tooling: a multi-vCPU paired workload". M4, macOS, Chrome for Testing
158.0.8127.88, `bench/ab-mac.sh` with `WORKLOADS=smp`; each directory is its `<outdir>` (`ab.json`, `log.txt`,
`verdict.txt`). The cores (not committed): `main` (4d0fce43, ABI 74), `bench/results/local/perf65/b100000.wasm`
(`BATCH_STEPS` 100K), `bench/results/local/perf67/warm.wasm` (the local branch `perf67-warmup`'s core).

- `aa1/`: `AA=1 MIN=12 CAP=12`, the base alone, four copies (the default).
- `aa-par2/`: `AA=1 MIN=8 CAP=8`, `?par=2&jj=50`: two copies.
- `cal/`: `BUDGET=1800`, `base=main batch100k=b100000 warm=warm@../waarm64-base` (that tree: 4d0fce43 with this
  loop's changes and `perf67-warmup`'s web/ changes over them).
- `spread.mjs`: `node spread.mjs <dir> [workload] [arm]`: each measure's pairs against the base, their spread.
