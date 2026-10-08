# M8 JIT performance: handover (2026-10-09)

A side track of M8, asked for by the user: make general and "complex app" work faster. Not a
milestone phase; no kickoff. How things work is in docs/jit.md and docs/cpu.md "The block
interpreter"; the measurements in `bench/boot/REPORT.md`, `bench/apps/REPORT.md` and
`bench/interp/REPORT.md` (the M8 sections at their ends); what's open in docs/backlog.md
"Interpreter" and "JIT", most promising first.

## Where it stands

- **The JIT** (to 2026-10-08): `alpine_user_jit` 24.2 → ~18 s in Chromium on the dev VM; V registers
  in v128 locals made llvmpipe and openssl's NEON 1.3–4× faster (`bench/boot/REPORT.md`).
- **The complex-app benchmark** (`c93b0f6`): `bench/apps/chromium.ts` boots the page's Debian with
  Chromium installed (`images/debian-chromium/build.sh`, `?disk=`) on 4 vCPUs and times three
  headless renders of `chrome://newtab`; `--wasm <file>` serves another core (the A/B tool),
  `--perf N` profiles render N (`bench/apps/perf.ts`). ~5 min a run.
- **The block interpreter** (`9809a85`, `core/src/interp/block.rs`, the dispatcher in
  `jit::steps`/`jit::interpret`): what the JIT hasn't compiled runs from the JIT's blocks decoded
  once into micro-ops, chained, counted locally. 2–2.7× the interpreter (`vm_mmu_mips` 72.6 →
  195.6). With it the compile threshold went 50 → 500 (`jit::Config::DEFAULT`):

  | | Chromium renders, s | Alpine boot | Alpine userspace | its hot phases |
  |---|---|---|---|---|
  | old path, threshold 50 | 57.4, 53.7, 45.2 | — | — | — |
  | block interpreter, 50 | 54.2, 40.6, 41.2 | −3.2% | −4.2% | 1–4% faster |
  | block interpreter, 500 | 48.4, 29.8, 28.2 | −8.9% | −2.7% | 1.5–6% *slower* than at 50 |

  (Alpine against the old path at 50, same session; Chromium's old-path row from an earlier,
  ~10% slower session: compare the block-interpreter rows with each other.) At 50 Chromium
  compiles ~150 MiB a render and flushes the 160 MiB cache; 200 flushed by the third render; 500
  compiles 67 MiB once; 1000 interprets 7.7% of the cold render.

## Next: a compile threshold that follows the code cache's pressure

The user's question (2026-10-09): adjust the thresholds dynamically by speed or cache pressure?
Answered yes, by **pressure**, not MIPS (the status bar's MIPS includes idle and I/O, and depends on
the mix). They expect this to be the next step. Goal: Alpine's hot phases as at 50, Chromium as at
500, no flushes where 500 has none.

**Where it goes:** `jit::Cache::miss` (core/src/jit/mod.rs), under the cache's lock already, where
a block's dispatches arrive (each decoded block reports at most every 16 dispatches and at the
threshold: the quota `miss` returns, `interp::block::Cache::quota`). Replace `self.cfg.threshold`
there (both the queueing test and the quota) with a `Cache` field the policy moves; keep
`Config::threshold` as the start, or the fixed value for the forced/stress/check/`INTERP` modes
(threshold 0 and `u32::MAX` must stay fixed). The compile policy changes no guest step, so
`tests/steps.txt` holds; `a_decoded_block_reports_at_the_threshold` pins 50 explicitly.

**Signals the cache already has:** `live_bytes` against `cfg.max_bytes` (160 MiB; the flush when
it's reached is in `Cache::alloc`/`install`), flushes (`drop_all`, `Stats::flushes`), and per
table `stats.steps` (JIT) against `stats.dec_steps` (block interpreter). A first rule to try:
start at 50 (or 100); after a flush, or when `live_bytes` passes ~half the budget, raise it (×2 up
to ~1000); when the budget has room again and the interpreted share is high, lower it. Decide at
batch emission or every N reports, not per dispatch. Note `live_bytes` only grows until a flush
(no eviction), so "room again" may in practice mean "after a flush": think through the steady
state for a working set that never fits (a Go build) versus one that fits at 500 (Chromium).

**Measure** (all in Chromium, A/B alternating, the variant cores kept aside):
- `node bench/apps/chromium.ts --wasm <core> --json <out>`: the target is the 500 row's warm renders
  (28–30 s) with a cold render no worse; check `flushes` and wasm MiB per render in its output.
- `boot_alpine_jit` and `alpine_user_jit` (phases): the target is the 50 row's hot phases. The
  alternating script used last time: `bench/results/local/dec/ab.sh` (git-ignored, on the dev VM
  only; variants `core-<name>.wasm`,
  rounds alternated, JSON moved aside per run; `med.ts` beside it prints the medians).
- Then a long mixed load (`bench/stress` with `--guest-cmd`, a `go build` loop) for pressure that
  never fits.
- Reports: `bench/apps/REPORT.md` and `bench/boot/REPORT.md` new sections, JSON in `results/<name>/`;
  docs/jit.md "Compile policy" (the threshold paragraph and the sweep), the backlog entry out.

**Other open items** (backlog "Interpreter"): the decoded caches are per table and their 2M
micro-op arena restarts when full (~3M decodes a Chromium render, ~1–2% by estimate: drop the
older half instead, or share one store); more micro-op handlers (FP/SIMD loads and stores,
atomics; count the generic ops first); tail-call dispatch as an A/B.

## How to measure

```sh
node bench/boot/userprof.ts                      # Node: per phase, MIPS, dispatches, regions, bytes (~25 s)
WASM=a.wasm node bench/boot/userprof.ts          # another build; alternate two for a quick A/B
npm run bench -- --page bench/boot/index.html --only alpine_user_jit --out <json>   # Chromium, the number that counts
bench/run-mac.sh <name> --page bench/boot/index.html --only alpine_user_jit         # the Mac host's Chromium
```

For NEON-heavy guests: `--only gl_llvmpipe_jit` (and `_4`); per-encoding helper counts with the
lanes' FP classes: `bench/boot/results/m8-llvmpipe/helper-classes.patch`.

A/B in Chromium: keep each build's `webpc_core.wasm` aside, copy one into `target/…/release/`, run,
alternate (A, B, A, B), check `sha256sum` before each run. Also `boot_alpine_jit`, `boot_jit`,
`smp_user_jit_4`, and on `bench/interp/index.html` `jit_coremark_mips`, `vm_jit_mmu_mips`,
`jit_mips`. Per-phase, per-vCPU counters on N parallel vCPUs in Node: `boot()` from
`bench/boot/suite.ts` with `parallel: true` and an `onMark` that records `vm.cpuStats()`.
Diagnostic counters without new ABI: append `<letter>:<n> <count>` lines to
`Table::helper_report` (patches in `bench/boot/results/m8-userprof/` and `m8-entries/`).

## Learned

- **`../webpc-base/target` is a symlink to this checkout's `target`:** a build there overwrites
  this checkout's `webpc_core.wasm` (hard-linked). Rebuild here after building there.
- **A Node gain may not reach Chromium** (scalar `UQSUB` inline: compress −9.5% in Node, nothing
  measurable in Chromium). Confirm in Chromium before claiming; Node boot profiles also vary by a
  few percent between identical runs.
- **Four concurrent guests slow down by themselves on this host** (4 P-cores + 6 E-cores): four
  independent 1-vCPU VMs ran Lua 3–6%, SQLite 11–15%, compress 22% slower than one alone. Compare
  N-vCPU runs with N-vCPU runs.
- **In round-robin SMP one JIT cache serves every vCPU**, each with its own TLB: state derived from
  the cache but kept per vCPU must notice the cache's changes per vCPU (`Cache::drops` against
  `Tlb::xdrops`; a one-shot flag was consumed by whichever vCPU ran next).
- **Code read twice can differ on parallel vCPUs**: read guest code once per decision. A repeated
  boot loop (500 boots in ~5 min) is what finds such races; CI only sometimes.
- **Debugging a bad table index** (a "function signature mismatch" in a worker): dump every index
  the vCPU's JIT state can call (jump cache, hot-word redirects, transfer cache) at the trap and
  test each against the worker's table.
- **Counting in JIT code without new counters:** bump `Tlb::stats.misses` / `.flushes` from wasm
  (an `i64` load, add, store at their `Vcpu` offsets); `userprof.ts`'s TLB columns show them.
- **A test that waits for a shell should never match the console's end** (`trim.test.ts` failed 1
  in 40 under load until it counted prompt lines).
- **LLVM deletes an `alloc`/`dealloc` pair nothing uses:** pass the pointer through
  `core::hint::black_box`.
- **`/tmp` is a 6.9 GB tmpfs:** keep `perf record` data in `bench/results/local/perf/`.
  `bench/run.ts --out /dev/null` writes `dev/null` in the repo.
- **`tsc` checks `bench/results/local/` too:** keep ad-hoc `.ts` in the scratchpad while CI runs.
  `scripts/ci.sh` runs native tests from the working tree: don't edit `core/` while it runs.
- **The Mac host shares its cores with the VM:** run nothing there during CI or a VM benchmark; a
  failed page leaves `bench/run.ts` and Chrome for Testing idle there (`ssh macmini.lan 'ps -axo
  pid,command | grep -E "bench/run.ts|ms-playwright"'`).
- **Vector fast paths need every lane on the fast path**, so random V registers almost never run
  them: planted bugs in FCVTN's rounding and bounds went unnoticed until the differential test
  filled whole registers with one lane size, mostly plain values (`fpPlain`), ties and the next
  format's range edges. Plant a bug in each new vector rule and check it's caught.
- **Read CI's result before committing or pushing** (`aee50b9` went out with a failed run). A test
  that fails only under CI's load (JS tests beside the native ones) isn't reproduced by running it
  alone; re-run CI and compare with the build before (`../webpc-base`).
- **Input timed by steps is wrong in parallel mode**: the vCPUs' summed steps say nothing about
  how far the boot is (the browser console-input test sent its input before init under load; fixed
  in `f997fa0` by waiting for the prompt).
- **What catches a V-register bug** (planted, 2026-10-08): a dirty V register not written back
  before a helper, or not dropped after one, only in sequences and regions (the single-word classes
  start clean); a load's slow path that keeps its V destination's stale local only under the MMU
  (on the flat bus that path always aborts): the Alpine userspace boot caught it, lockstep,
  Buildroot and the crypto kernel didn't. An edge's write-back of what the target holds clean is
  unreachable in the tests for X registers too (entry states are unions of their edges).
- **Copying rounds of A/B JSON into one directory:** prefix each round, or the second's
  `<bench>-A1.json` overwrites the first's.
- JIT-check and the tests' forced mode form forward regions from any block in reach; JIT-stress (a
  block per batch) makes none. The stale-code checker runs at a region's entries and back-edges.
- **The block interpreter's counts decide the JIT's regions:** forward regions take only the
  pending batch's blocks, so anything that changes *when* a block joins the batch changes the
  regions. Reporting dispatches 16 at a time scattered a path's blocks over batches: 30% more,
  smaller regions, Alpine 8% slower. Check `blocks` against `regionBlocks` in a run's counters
  whenever the counting changes.
- **Decoded blocks must not follow the JIT's dropped keys** (those include every compiled block
  linked to a dropped one, transitively; past 4,096 a table starts over): they're dropped by page
  from `Cache::ival_log`, which every IC feeds and flushes don't touch. A vCPU idle in WFI falls
  behind the log: it's 65,536 entries (Chromium's V8 in the guest issues ~3,000 ICs a second).
- **Direct-mapped counters lose evicted entries' counts** (16,384 slots, ~200K blocks): keep them
  in the backing map, or the effective threshold silently rises.
- **The block interpreter natively:** with `jit` ≠ 0 the native dispatcher runs everything in it
  (no wasm engine), so `WEBPC_NATIVE_JIT=1 cargo test --release --test <t> -- --ignored` checks it
  on every native guest with exact steps in seconds; the run summaries print its share.
- **`bench/apps` runs reproduce to ~1% within a session but drift ~10% between sessions**: always
  run the baseline in the same session (`--wasm` of a core with the change compiled out).
- **A Python edit that replaces `s[s.index(a):s.index(b)]` with an end marker that occurs earlier
  replaces the empty string**, i.e. inserts between every character: assert the slice is non-empty
  (it wrecked `jit/mod.rs` once; restored from git).
