# Complex applications: measurement journal

Dated sections, newest last. How to run: [docs/benchmarking.md](../../docs/benchmarking.md) "A complex
application"; the disk: [docs/images.md](../../docs/images.md) "Debian with Chromium".

## M8: Chromium in the guest, where its time goes

2026-10-08, the dev VM (8 vCPUs), headless Chromium 153.0.8010.52 on the host and in the guest, the page's
Debian on 4 vCPUs (1 GiB), commit `ff362d8` plus the status's counters. The workload:
`chromium --headless --no-sandbox --disable-gpu --screenshot` of `chrome://newtab` (every `chrome://` URL
gives the new tab page in the guest's headless Chromium), three runs on one boot, the same profile
directory. The question (the user's): is the interpreter why complex applications run at 200–300 MIPS?
Raw: `results/m8-chromium/`.

**Base: ~55 s a render at ~170 MIPS, and the warm runs aren't faster.** Each run is ~9.3 G guest steps,
the guest's CPUs 76–87% busy (user ~55%, system ~30%: Chromium's processes, mmap, page faults), so
~50 MIPS per busy vCPU. Only **~2% of the steps are interpreted**, but every run compiles **200–275 MiB
of wasm** (145K–200K blocks), more than the code cache's 160 MiB budget: it flushes once or twice a run
and the next run compiles it all again.

**Profile** (`--perf 1`, the second run, `perf-base-run1.txt`; % of the 4 vCPU threads' samples):

| | % |
|---|---|
| guest code in Liftoff (user 24.7, kernel 8.1) | 32.8 |
| guest code in TurboFan (user 14.0, kernel 8.7) | 22.7 |
| `[unknown]` native: V8 in Chromium's stripped binary (lazy Liftoff compiles, instantiation, GC) | 15.6 |
| interpreter and helper bodies (`interp::exec` 6.2) | 10.0 |
| dispatcher, transfer-cache misses | 7.4 |
| allocator, our compiler, TLB walks | 9.6 |

V8's background threads (TurboFan, module compiles) add ~20% of the vCPUs' sample count beside them.
V8's perf map has 1.76M Liftoff functions against 180K TurboFan ones: most guest code never tiers up
(`--wasm-tiering-budget` is 13M; not settable from a page). So, as in Alpine's boot, the cold-code
pipeline (Liftoff code, V8's compiles, ours) is over half the time; the interpreter is a tenth.

**A/B: what compiling less does** (variant cores served with `--wasm`, one boot each, in one session):

| render, guest s | 1 (cold) | 2 | 3 | wasm compiled per render (MiB) | flushes |
|---|---|---|---|---|---|
| base: threshold 50, 160 MiB | 57.5 | 53.7 | 44.9 | 236, 275, 197 | 1, 1, 1 |
| threshold 500 | 72.5 | **34.4** | **29.6** | 77, 22, 14 | 0 |
| budget 480 MiB | 51.5 | **27.4** | 32.2 | 172, 42, 103 | 0, 0, 1 |

- At threshold 500 the code fits and stays: the warm renders are 35–45% faster (up to 290 MIPS). The cold
  render is 26% slower: 5% of its steps (508M) are interpreted, at the interpreter's ~80 MIPS.
- A larger budget gets the warm gain without the cold loss, at ~10× the bytes in V8 memory (docs/jit.md
  "Memory"): what the budget was sized to avoid.
- So the interpreter's speed matters as the price of compiling less: a faster interpreter makes a higher
  threshold pay on cold code too, with a third of the compiled code (and of V8's memory).
- One boot per variant: the warm gains are far above run-to-run spread seen in base (44.9–57.5 s across
  renders), the cold-render difference needs repeats before it's quoted.
