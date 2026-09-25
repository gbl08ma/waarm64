# Benchmarks

`node bench/run.ts [--quick] [--only <bench>] [--config default|liftoff-only|turbofan-only|bounds-checks] [--page <path>] [--out <file>]`
(also available as `npm run bench -- …`)

This serves the repo with COOP/COEP headers, opens `--page` (default: the M0 spike) in
headless Chromium (`CHROMIUM` env var, default `/usr/bin/chromium`) and waits for
`window.benchResult`. It then writes JSON to `--out` (default: `bench/results/local/`, which is
gitignored). `node bench/spike/node.ts` runs the spike in Node for fast iteration.
Chromium numbers are the ones that count.

Result schema (`schema: 1`):

```
{ schema, page, date, commit, dirty, config, jsFlags, quick,
  host: { platform, arch, cpu, cores, memGiB },
  browser: { version, userAgent },
  results: [{ name, unit, params?, samples[], median, iqr, n }] }
```

A benchmark page posts `{ results: [{ name, unit, params?, samples }], crossOriginIsolated, userAgent }`
or `{ error }`. The harness refuses results that aren't cross-origin isolated.

Commit only results that back a written report (for example `bench/spike/results/`).

The M0.5 memory suite has its own drivers under `spike/memory/`, and `node bench/spike/memory/run-all.ts` runs all of them
(capacity, cost under every config, machine code). See `spike/memory/REPORT.md`.
