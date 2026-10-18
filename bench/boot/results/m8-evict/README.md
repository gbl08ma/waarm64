# Per-module eviction: what the cache could free (measurement before building)

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
