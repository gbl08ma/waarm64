# BENCH: faster, quieter A/Bs for the performance work — kickoff

The user's brief (2026-11-23), in their words:

> working through perf optimization ideas has been slow because small guests can be unrepresentative (particularly the
> boots ones, which have code characteristics that differ from userspace loads) and longer workloads like the pages
> session are, well, long. However, the pages session workload has important characteristics that I believe our
> shorter userspace load doesn't have, namely, it tests the "JIT within a JIT" behavior that only things like web
> browsers have (but maybe we could instead test nodejs within the guest?), and web browsers are also a mixed workload
> (image decoding, layout, JS execution, GUI updates...) that is difficult to replicate otherwise. then there's the
> fact that these runs are often repeated multiple times (typically 3 times for a total of 6 runs in an A/B
> comparison), because even though only macOS+claude+tmux is running in this physical machine that this VM runs in,
> there's always noise (probably also because the test workloads within our emulator have some variability of their
> own). This makes it tricky to assess changes that sometimes warrant just a 0.5% perf improvement or degradation. how
> would you optimize the benchmarking so that agents working through this queue of ideas can iterate faster?

> a short track of its own, ahead of row 1

(The second answers the proposal this file writes down; "row 1" is PERF-HANDOVER.md's queue, which waits for this
track.)

## The goal

An agent working PERF's queue gets a verdict on a JIT or core change on the Mac, at a ±0.5% resolution, in a few
minutes for a clear win or a clear null and in well under today's ~25-70 minutes for a close call, from workloads
shown to rank changes as Firefox's pages session does. The full pages session becomes the confirmation of what passed
a screen, not the screen.

## Decisions taken

- A short track of its own, ahead of PERF's row 1 (the user, 2026-11-23). PERF stays paused meanwhile.
- The Mac is the host it is built for (PERF ranks there). The dev VM's runs keep working as they do.
- Nothing here changes the core, the JIT or what a guest sees: harness, tools, guest images and docs only. If a loop
  finds it wants a hook in the core (a counter, an export), that is a host ABI change: a design note in docs/abi.md
  and the user's OK first.
- A proxy workload earns its place by calibration (loop 4), not by argument: one that ranks past changes otherwise
  than the full pages session is dropped, and the track says so.
- docs/benchmarking.md's rules change only at the track's end, from what the loops measured (the floor, the rounds,
  what counts as a difference); until then the ~1% rule stands.

## The loops

One slice, one commit and a short report each (a REPORT entry "BENCH loop N" in bench/boot/REPORT.md with its JSON);
a loop whose idea doesn't hold is a finding, written down, and the next loop starts.

1. **A quieter measure.** On the Mac, read the renderer's (and its helper processes') instructions retired, cycles
   and CPU time around the measured phase (`proc_pid_rusage`'s `ri_instructions`/`ri_cycles`, or what turns out to
   work for Chrome's processes from `bench/gpu/sway-mac.sh`), per thread if the host allows it. A/A sessions of the
   gates and the pages session give each measure's spread beside wall time's and busy MIPS's. Add host cycles (and
   instructions) per guest step on busy vCPUs, with the interpreted share beside it. Record which cores a session's
   vCPU threads ran on, if the host says, and look at the two modes ~6% apart that benchmarking.md records. Outcome:
   the measures a verdict is read from, each with its A/A floor.
2. **Paired samples with a stopping rule.** One command for a Mac A/B (`bench/ab-mac.sh` or the like, over what
   `bench/run-mac.sh`, `bench/gpu/ab-mac.sh` and `bench/interp/ab-mac.sh` do): arms as `name=core.wasm[@tree][?query]`,
   any number against one base, an A/A arm always; short alternated pairs, the first boot discarded, the order
   alternated; the paired ratios' interval per measure; it stops when the interval excludes zero or lies within
   ±0.5%, or at a cap, and prints a verdict (and the memory, `emitNs`, `compileNs`, the wasm's bytes, as PERF asks);
   `mac-leftovers.sh` and the Mac-side bound inside it. `bench/interp/paired.ts` is the precedent for the analysis.
3. **Two short workloads from snapshots.** (a) Node in the guest running a fixed script that compiles, patches and
   discards code (a JIT inside the JIT: fresh code, cache flushes, indirect transfers into new code), ~20-30 s,
   from a warm snapshot made by `bench/gpu/warm-snapshots.sh`. (b) The pages session cut to its first pages
   (`PAGES=wiki,mdn` or what the full sessions' counts say carries the signal), the backlog's "Screening an A/B" item.
   Each with its counts (compiled MB, interpreted share, modules, transfers by kind) beside the full session's, to
   say what it does and doesn't exercise. Also the userspace gate from a snapshot (no boot per sample), if its boot
   is a visible share of a sample.
4. **Calibration against history.** Arms with a known result on the full pages session and the gates, rebuilt
   (`../waarm64-base`, `@<tree>`): `block::REGION` 16/32/64, the compile threshold 1000/2000 against 500/1000 and
   250/500, preemption without the budget against before it (if its base still loads the snapshot), and two or three
   clear nulls (loops 42, 54). Each proxy and each measure against the full session's ranking and sizes. Outcome: a
   table of which proxy and measure can screen which kind of change (compile policy, compiled code, the interpreter,
   the run loop), and the ones dropped.
5. **A measurement queue.** A runner that takes enqueued A/Bs (arms already built, a spec file), runs them one at a
   time on the Mac under the CI lock's rules (never beside `scripts/ci*.sh` or another Mac run: the VM shares the
   Mac's cores), and leaves each verdict and its JSON where the agent that asked finds it, so a PERF loop does its
   next row's counts while its A/B runs. Only if loops 1-4 leave an A/B long enough to be worth it.
6. **The end:** docs/benchmarking.md rewritten around the new tiers and rules; PERF-HANDOVER.md's "Measurement"
   section pointing at the one command; an out-of-context review of the new tools; the loose ends in the backlog.

## What needs the user's OK

- A new dependency (a statistics package, a native helper's build dependency on the Mac): ask first. A small helper
  compiled on the Mac with its own toolchain (clang, already there) is not one.
- Installing anything on the Mac beyond `bench/mac-packages.sh`'s list.
- Any change to the core or the host ABI (above), and anything guest-visible.
- Changing docs/benchmarking.md's "Rules" before the track's end.

## Validation

- Each measure and each proxy has its A/A spread on the Mac, committed.
- Loop 4's table: the proxies' verdicts against the full session's on the same arms.
- The one command reproduces a known result (regions of 64 against 16) and a known null within its stated floor,
  and its early stop doesn't call an A/A a difference in 20 A/A runs.
- Tools changed get `scripts/ci-fast.sh`; a changed guest image its tests; `scripts/ci.sh` before the track's last
  push.

## The end

The command, the workloads and the calibration table in docs/benchmarking.md; the numbers in bench/boot/REPORT.md
"BENCH loop N"; PERF-HANDOVER.md updated to use them and PERF's row 1 next; this file and BENCH-HANDOVER.md deleted;
PLAN.md's row set to done.
