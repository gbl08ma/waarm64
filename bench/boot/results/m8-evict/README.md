# Per-module eviction: what the cache could free (measurement before building)

**The measurement below is invalid** (found 2026-10-19, "Rechecked" at the end): `measure.patch` keeps each table's
hot-word pointer in `Seen`, and `Cache::drop_all` (every flush, and the boot's `IC IALLU`) rebuilds `Seen` from its
default, so after the first one no table's marks were read and each module's "last use" was its install. Every "cold"
figure here is install age, not use. `cost.patch`'s A/B (what imports within generations cost) stands.

The first step of docs/backlog.md "Per-module eviction, coldest first": before building eviction, measure how much
of a full code cache a coldest-first design could free. A module's memory can only go together with every module
that imports it (an import keeps its target's instance alive; imports point from newer modules to older ones), so
what counts is the cold code **no warm module imports**, not just the cold code. The design this decides between
(eviction of importer-closed sets, or two live epochs if too little is freeable) is in the project's
`jit-eviction/proposal.md` (2026-10-18), summarized in `M8-JIT-HANDOVER.md`.

Counts only: the patch costs every region entry a few instructions, so don't read its sessions' MIPS or timings.

## The patch (`measure.patch`, diagnostic, never committed to the source)

- Every region's prologue stores its table's tick (100 ms of the host clock, set by the dispatcher at each `steps`)
  in a per-slot word after the table's hot words: when each slot was last entered, however it was entered
  (dispatcher, jump cache, transfer cache, chains, tier-up redirects).
- The cache keeps a record per module of the epoch: bytes, slots, install tick, and the modules it imports from (from
  `block::module`'s `links`), each import flagged if its target had not been entered for 15 s when the importer was
  compiled (the proposal's "cold target" rule: such a link would go through the jump cache and not pin).
- Every ~10 s (at an install) the cache writes an `E tick …` line, and at each flush an `E flush …` line and an `M`
  line per module. For thresholds of 5, 15, 30, 60 and 120 s an `E` line has `c<s>=<cold>/<freeable>/<freeable with
  the rule>` bytes: freeable means cold with every importer, transitively, freeable too.
- `web/vcpu-worker.ts` takes the lines through `jit_helper_report` every 5 s and logs them as `webpc-evict` lines;
  `bench/gpu/guest-session.ts` appends them to `<outdir>/evict.txt`.

## Running it (dev VM)

```sh
git apply bench/boot/results/m8-evict/measure.patch && scripts/build-wasm.sh
PHASES=pages TIMELINE_ALL=1 WEBPC_GUEST_USER=alarm timeout 900 node bench/gpu/firefox-load.ts virgl target/archarm/desktop.qcow2 bench/results/local/evict/s1
node bench/boot/results/m8-evict/evict.ts bench/results/local/evict/s1/evict.txt
git apply -R bench/boot/results/m8-evict/measure.patch && scripts/build-wasm.sh
```

(Under `systemd-run --user --scope -p MemoryMax=10G -p MemorySwapMax=0`, in the background, alone: the handover's
"How to measure".) Two sessions; the 4-vCPU `go build` loop of `bench/stress` (docs/jit.md "Sharing", where FIFO
collapsed) is the second workload, its `--guest-cmd` as in `results/m8-share/`; there the lines come from the page's
console, so collect `webpc-evict` lines the way the stress tool collects others, or run it through a session.

`evict.ts` prints each `E` line as shares of the live bytes, then each flush's dump recomputed at each threshold
(other thresholds: `evict.ts <file> 10,20,40`).

## Reading it

`evict.ts` gives four answers per threshold: cold (what no pinning at all would free), freeable with every import
pinning, freeable with the cold-target rule, and freeable if modules imported only within their generation (an eighth
or a quarter of the live bytes by install order). The gate: if a third of the budget or more is freeable at the
flushes (at 30 s, say) with every import, build eviction of importer-closed sets; if only the rule or generations get
there, build that with it (generations first need `cost.patch`'s A/B, below); if nothing does, the two-epoch design.

## A first look (cloud, 2026-10-18; Debian on the page, 4 vCPUs, the budget cut to 24 MiB so the boot flushes)

`cloud-debian-24mib.txt` (the IALLUs at the boot's start show as `flush` there: the patch labels them `iallu` now).

Not the workload that decides, but it already shows the problem: at the boot's flushes 77-79% of the cache hadn't been
entered for 15 s, yet only 3% was freeable with every import pinning and 4% with the cold-target rule; with imports
only within eighths, 76-78% (half the import edges, counted statically, cross an eighth). Idle at the login prompt
after the boot: 99% cold, 5% freeable, ~all of it with the rule (what was compiled after the boot imported boot code
that had gone cold). **A few recent modules pin almost everything, transitively**: eviction of importer-closed sets
alone can't work, so the rule or generations have to come with it.

## The cost side (`cost.patch`, an experiment, not a measurement patch)

Generations cost something the rule doesn't: every link to a block of an older generation becomes a jump-cache tail
(`return_call_indirect`, the transfer that stalls in a browser's footprint: `bench/boot/REPORT.md` "where a busy
vCPU's time goes in Firefox"), hot or not. `cost.patch` makes a module import only blocks of its own generation (an
eighth of the budget by install order, `GEN_EIGHTHS`) and nothing else: no eviction. A/B it against the baseline like
any JIT change (the handover's "How to measure": Firefox's busy MIPS, two sessions each, alternating; the gates), after
`tests/jit.test.ts`, the differential test and lockstep. If it costs little, generations make eviction possible
whatever the rule finds; if it costs a lot, the rule (whose cost is only on links to targets cold at compile time)
has to carry it, or the two-epoch design.

Not measured here, on purpose: which modules a real use signal would see as cold (the design's signal is coarser than
these exact entry times, and errs toward "used"); tier-up redirects (a head's hot word naming its region) aren't
pins, since eviction would reset the word.

## On the dev VM (2026-10-18; its "cold" is install age, see the top): generations seemed to free enough, at no measurable cost

`devvm/`: the raw lines gzipped (`gunzip -c devvm/firefox-s1.evict.txt.gz > /tmp/e.txt` before `evict.ts`) and
`evict.ts`'s output for each run. Chromium 153.0.8010.52, the core at `0778386` with `measure.patch`.

**Firefox's pages session** (Arch Linux ARM's disk, `WEBPC_GUEST_USER=alarm`; two sessions, 3 flushes each in ~460 s,
every one at the full 160 MiB, ~4,400-4,900 modules, ~34,000 imports). Shares of the cache at each flush, threshold
30 s (sessions 1 · 2):

| | flush 1 | flush 2 | flush 3 |
|---|---|---|---|
| cold | 75 · 75% | 91 · 90% | 91 · 91% |
| freeable, every import pinning | 3 · 3% | 4 · 4% | 3 · 3% |
| freeable, the cold-target rule | 6 · 6% | 7 · 9% | 8 · 7% |
| freeable, imports only within eighths | 68 · 75% | 88 · 88% | 88 · 88% |
| freeable, imports only within quarters | 75 · 75% | 76 · 76% | 76 · 76% |

At 5 or 15 s the same within a few points (cold 88-99%, freeable 3-5%, the rule 7-10%, eighths 88-89%). 41-56% of
the imports cross an eighth, 21-45% a quarter; 14-37% of the imports were of targets cold at compile time.

**The 4-vCPU `go build` loop** (`bench/stress` on Debian, 600 s, `gobuild.log`): one flush, during its boot
(t = 142 s), none in the build loop at 160 MiB. There at 30 s: cold 95%, freeable 7%, the rule 17%, eighths 90%,
quarters 78%.

**The gate** (a third of the budget freeable at 30 s): every import pinning fails everywhere (3-7%), the cold-target
rule too (6-17%); only generations pass (eighths 68-90%, quarters 75-78%).

**What generations cost** (`cost.patch`, `GEN_EIGHTHS = 1`, no eviction; `devvm/cost/`; `tests/jit.test.ts`, the
differential test and lockstep passed with it, 104/104). Firefox's pages session, alternating ABAB:

| | busy MIPS | flushes | modules | stalls ≥ 20 ms |
|---|---|---|---|---|
| A (baseline) | 139 · 136 | 3 · 3 | 15,239 · 14,979 | 1 · 9 |
| B (imports within eighths) | 137 · 135 | 2 · 3 | 14,532 · 15,119 | 4 · 1 |

−1.1%, within the sessions' noise. The gates, three rounds alternating (median ms per round):

| | A | B | B/A |
|---|---|---|---|
| `smp_alpine_jit_n4_total` | 9,324 · 9,370 · 9,330 | 9,336 · 9,326 · 9,352 | +0.1% |
| `smp_alpine_jit_n1_total` | 9,490 · 9,502 · 9,483 | 9,492 · 9,504 · 9,513 | +0.1% |
| `smp_user_jit_n4_total` | 19,022 · 18,574 · 18,854 | 18,690 · 18,619 · 18,945 | −0.9% |

Userspace phases ±2% in both directions (compress −1.8%, Lua +1.9%, churn −1.9%, SQLite −1.7%): noise. Neither gate
flushes; the Alpine userspace run compiles ~38 MiB, nearly two 20 MiB eighths, so links do cross generations
there (how many wasn't counted). **The jump-cache tails that generations add cost nothing this workload or the gates can see**: build
coldest-first eviction with modules importing only within their generation.

## Rechecked (2026-10-19): almost nothing is cold at a module's granularity

Eviction was built on the numbers above (branch `evict-generations`: generations, a mark per dispatch, a probe at 7/8
that clears the jump and transfer caches, coldest-first importer-closed eviction down to 6/8, slots held until every
table lets go; JIT-evict passes the boot tests and its planted bugs). In Firefox's pages session (`?jit=evict`, six
sessions: two of the clean build, four of the debug builds) it never evicted: at each full cache too little was cold and it flushed. `devvm/recheck/recheck.patch`
(applies on that branch) logs each attempt and adds the region-prologue marks `measure.patch` meant to have, with the
pointer kept across flushes. Firefox's pages session, the 160 MiB cache full (`firefox-evict-dbg.txt`):

| at the attempt | not entered for 5 s | 15 s | 30 s | 60 s | not entered since the probe began (16-50 s) |
|---|---|---|---|---|---|
| 1 | 12 MiB | 7 | 5 | 4 | 6 MiB |
| 2 | 8 MiB | 3 | 1 | 0 | 0 MiB |

The dispatcher's marks (only the entries that come through it, after the probe cleared the caches) agree: 1-7 MiB cold,
19-20 MiB installed during the probe, 157-159 MiB kept with their imports; each table entered 48,000-77,000 distinct
slots in the window, about half of the ~120,000. So about half the regions are idle, but a module is a batch of what got
hot at the same time, and nearly every module holds at least one region in use. V8 frees code only a module at a time,
so per-module eviction can't free a full cache's memory in this workload, with generations or without.

What could, for the user to choose (none measured): recompiling the regions in use out of cold-ish modules into new
ones and then dropping the old (compaction: what a flush's recompile costs, spread out and without the interpreted
phase); the two-epoch design (keep the old epoch's code running while the new one compiles its hot set, memory
briefly double); after a flush, compiling the previous epoch's hot set at once (the marks give it) rather than raising
the threshold (`Cache::flush` doubles its floor); a bigger budget.
