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

## M8: the block interpreter

2026-10-08/09, the dev VM, Chromium 153.0.8010.52, Debian with Chromium on 4 vCPUs, three renders of
`chrome://newtab` per boot (as above). Raw: `results/m8-dec/` (`dec-nodec50`: the block interpreter
compiled out, the old path; `sweep-c<threshold>`: this commit's core at that compile threshold, one
session).

**What was built** ([docs/cpu.md](../../docs/cpu.md) "The block interpreter"): what the dispatcher
hasn't compiled runs in a second form of the interpreter, the JIT's blocks decoded once into
micro-ops with operands pre-extracted, the common integer, branch and load/store forms specialized,
an inline TLB path, blocks chained without the dispatcher, dispatches counted locally and reported
to the shared cache every 16 (the dispatch that reaches the threshold reports itself). On the
interpreter benchmarks it runs 1.75–2.7× the interpreter's speed (`../interp/REPORT.md` "M8: the
block interpreter").

**Guest seconds per render:**

| core | render 1 (cold) | 2 | 3 | wasm compiled (MiB) | flushes |
|---|---|---|---|---|---|
| old path, threshold 50 | 57.4 | 53.7 | 45.2 | 235, 279, 201 | 1, 2, 1 |
| block interpreter, 50 | 54.2 | 40.6 | 41.2 | ~150 each | 1 each |
| 200 | 47.7 | 30.3 | 38.6 | 88, 21, 95 | 0, 0, 1 |
| **500 (the new default)** | **48.4** | **29.8** | **28.2** | 67, 15, 11 | 0 |
| 1000 | 49.1 | 30.6 | 28.8 | 43, 23, 10 | 0 |

- At threshold 500 the warm renders are 38–45% faster than the old core's. The cold render is no
  longer the price: with the old interpreter, threshold 500 made it 26% slower (72.5 s); with the
  block interpreter it was 6% faster than the old core in the same session (54.0 against 57.4 s,
  an earlier build with the same policy). Over three renders it compiles 94 MiB once, where the old
  path compiled ~715 MiB and kept the 160 MiB budget full (V8 holds ~10× the wasm bytes).
- 200 is near the budget's edge (the third render flushed); 1000 interprets 7.7% of the cold
  render's steps.
- The old core's numbers are from an earlier session the same day (they reproduced the previous
  session's to within 1%); these sweep runs were ~10% faster than the same core's runs earlier
  that day, so compare the sweep rows with each other first.

**Found on the way** (each cost a run to see):
- Tying the decoded blocks to the JIT's dropped keys emptied every table's decoded cache dozens of
  times a render: an `IC IVAU` drops the compiled blocks linked to the page's too, transitively, and
  past 4,096 keys a table starts over. Decoded blocks are now dropped by page, from a log of the
  pages ICs named (65,536 entries: the guest's V8 issues ~3,000 ICs a second, and a vCPU in WFI
  doesn't catch up; at 4,096 the cold render still cleared ~140 times).
- Counting dispatches in direct-mapped slots lost the counts of evicted blocks (16,384 slots,
  ~200K blocks): a hidden, uneven threshold rise. The map keeps them now.
- What's left: ~3M blocks decoded per render (4 tables), mostly re-decodes after a table's 2M
  micro-op arena fills (6–8 times a render); about 1–2% of the time by estimate (backlog).

## M8: a compile threshold that follows the code cache's pressure

2026-10-09, the dev VM, Chromium 153.0.8010.52; `results/m8-pressure/`. The threshold starts at 50
and rises with the live wasm bytes, doubling at each eighth of the 160 MiB budget past the second
(1000 from 120 MiB), and its floor doubles at each flush (docs/jit.md "Compile policy"). Same
session, alternated (`apps-r<round>-<core>.json`):

| core | render 1 (cold) | 2 | 3 | wasm compiled (MiB) | flushes |
|---|---|---|---|---|---|
| fixed 500 (the previous default), r1 | 48.1 | 30.1 | 27.5 | 67, 15, 11 | 0 |
| fixed 500, r2 | 48.4 | 29.6 | 28.4 | 67, 15, 11 | 0 |
| **pressure, from 50**, r1 | **46.0** | **28.5** | **26.8** | 60, 12, 7 | 0 |
| pressure, from 50, r2 | 46.3 | 28.3 | 27.3 | 60, 12, 7 | 0 |
| pressure, from 200, r2 | 47.2 | 29.9 | 27.6 | 51, 19, 7 | 0 |

- 4–5% faster than 500 on every render, with less wasm and no flushes. The renders compile less
  than at 500 though they interpret less of the cold render (4.7% of its steps against 5.3%): the
  Debian boot before them compiles at 50, from the bottom of the budget, so by the renders the
  threshold has risen (the boot's own bytes aren't recorded; the docs' figure for Debian's boot at
  50 is ~73 MiB, which puts it at 200–400).
- The Debian boot to login (UEFI, 4 vCPUs, the `# logged in` line) is 40.1–41.6 s with every core.
- **The `go build` loop** of `../boot/REPORT.md` "M8: one code cache for all vCPUs" (Debian on 4
  vCPUs, 300 s, `bench/stress/stress.ts --no-load --disk2 … --guest-cmd …`; `stress/go-*.jsonl`):

  | target | fixed 500: builds (s), compiled | pressure from 50 |
  |---|---|---|
  | `hello` (`fmt`) | 77, 60, 59, 58; 134 MB | 73, 57, 54, 54, 54; 164 MB |
  | `web` (`net/http`) | 168, 139; 137 MB | 158, 132; 165 MB |

  5–8% faster, and neither flushed: at the end the pressure core held ~157 MiB of the 160 with
  the threshold at 1000, compiling only what runs that often. A load that overflows it still
  flushes; the floor then starts at 100 (200, …), which no run here reached.

## M8: the decoded blocks' arenas

2026-10-09, the dev VM, Chromium 153.0.8010.52; `results/m8-dcache/` (`apps-r<round>-<core>.json`).
Each table's block-interpreter cache held 2M micro-ops (32 MiB) and started over when full: ~3.5M
blocks re-decoded per render over the 4 tables, 9–15 restarts. Five alternated pairs of the base core
(`base`) and one with 4M micro-ops a table (`big2`, rounds 1–3; `share`, rounds 4–5: the committed
budget, 16M micro-ops shared out, which is 4M a table on 4 vCPUs):

| round | base: renders (s) | 4M a table | decodes, base → 4M (M) |
|---|---|---|---|
| 1 | 46.7, 29.0, 27.5 | 46.1, 27.7, 25.5 | 4.2, 3.5, 3.6 → 3.1, 2.2, 1.3 |
| 2 | 51.2, 29.6, 27.3 | 45.2, 28.1, 26.0 | 4.5, 3.7, 3.5 → 3.4, 1.8, 1.8 |
| 3 | 46.5, 29.3, 27.8 | 45.8, 27.8, 26.4 | 4.1, 3.7, 3.4 → 3.2, 2.0, 1.9 |
| 4 | 45.7, 28.0, 26.2 | 45.6, 27.6, 26.1 | 4.2, 3.6, 3.3 → 3.0, 1.5, 2.0 |
| 5 | 45.7, 28.2, 26.5 | 45.5, 27.9, 26.4 | |

- The warm renders' means 28.8 → 27.8 s and 27.1 → 26.1 s (−3.5%), the cold render's median
  46.5 → 45.6 s; per pair 1–7% (the base runs got faster over the session, the 4M runs didn't move).
- **8M a table** (128 MiB × 4): the core's 1 GiB heap ran out in the third render (a `hashbrown`
  rehash in `interp::block::Cache::miss`). The committed budget is 16M micro-ops (256 MiB) shared
  out among a VM's tables, at most 8M each; before, 123 vCPUs could have asked for 3.9 GiB.
- **Evicting instead of starting over** (2M a table, round 3): keeping the blocks in the slots and the
  arena's newer half, compacted: 45.9, 28.7, 26.6 s; keeping those that entered a slot in the last
  half of the arena's fill: 46.1, 28.6, 26.7 (decodes 3.7, 2.8, 2.7M); with 4M a table: 45.9, 28.2,
  26.6, no better than 4M alone. A first try that kept the blocks run since the last eviction kept
  everything decoded since, so it always started over (base's numbers). What fills the arena is
  code that runs again: capacity, not dead blocks. The eviction is in
  `results/m8-dcache/evict-lru.patch`.
- Alpine on 1 vCPU never fills the arena (162K decodes, ~1M micro-ops; its 4 restarts are `IC
  IALLU` and flushes): `boot_alpine_jit` 8,585, 8,550 → 8,711, 8,539 ms, `alpine_user_jit` 17,835
  → 17,866 ms (`../boot/results/m8-dcache/`).
