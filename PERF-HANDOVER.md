# PERF: the performance backlog — handover

This file is all a new session needs to carry on the track: what it is, how it's worked, where it stands, what's next.
What each loop did is in the REPORT entries named "PERF loop N" (bench/boot/REPORT.md for the JIT, the ISA and the
devices; bench/interp/REPORT.md for the block interpreter; bench/gpu/REPORT.md for the query poll).

## The brief

The user's (2026-11-10): go through every performance entry of the backlog (now the issues of type Performance:
[docs/issues.md](docs/issues.md)) that the dev VM or the Mac host can try
(skip what needs an x86_64 CPU and leave those entries as they are). For each: try it, measure it, then keep it, or drop
it and write down why, so the backlog shrinks to what's still open. New ideas found along the way are welcome. ISA
extensions count as performance work: measure them with representative workloads and implement new instructions through
to inline JIT code (not helper calls) where it makes sense; no half-implemented features. An idea that doesn't pan out,
or that the platform doesn't allow, is a finding for the REPORT and the docs, not a backlog item: the backlog holds
only doable to-dos.

## How the track is worked

**The session is a supervisor.** It runs **one subagent at a time** (general-purpose), in the **main checkout** (no
worktrees: the supervisor works alone on the machine), each with **one entry** of the queue below. It waits for the
subagent to finish before starting the next, so A/Bs and CI runs alone. The user is often away: work through the
loops without check-ins, settle choices by measurement, and ask only what can't be measured.

**A loop's brief** (the subagent knows only what's in it; write it fresh each time, neutral, never the supervisor's
theory of the answer):
- Read CLAUDE.md first and follow it exactly (bounded runs with `timeout`, Mac runs bounded on the Mac side too:
  `bench/run-mac.sh`'s `MAC_TIMEOUT`; memory caps via `systemd-run` on every node and cargo run; CI scripts alone in
  the background and waited on **inside its turn**, Monitor or the completion notification, never a hand-back while
  waiting; no self-matching `pkill`). Then this file, docs/benchmarking.md, docs/v8.md, and the docs page of the area.
- The entry, quoted with its issue's link, and the files it touches; anything new since it was written
  that bears on it (e.g. a later loop's change that could interact).
- How to decide: counts from a diagnostic build first, bounding the gain before building; build only what the counts
  justify; if it needs a redesign out of proportion to the measured gain, stop and write the finding.
- The measurement rules (below), the correctness rules (below), and the finish (below).
- The reply: a short report with the counts, what was built or why not, the numbers (medians, rounds), memory, tests
  and planted bugs, CI results, the commit hash.

**Measurement** (docs/benchmarking.md; bench/interp/REPORT.md "The block interpreter on the Mac, loops 1-5"):
- Rank on the **Mac** (the VM distorts code size and bounds checks). Tiers, so no one decision takes 70 minutes:
  1. counts from a diagnostic build, wherever they can decide;
  2. `bench/ab-mac.sh <outdir> base=<core.wasm> new=<core.wasm>` (docs/benchmarking.md "The paired A/B"; in the
     background, alone; it stops by itself with a verdict to ±0.5%, at 12 pairs at most): on `node`, its default, to
     rank the change for the browser (4-10 min), with a short multi-vCPU measure beside it (the parallel boots, until
     the paired command has a multi-vCPU workload); several arms in one run when a row has variants; `AA=1` when a
     result looks like noise; plus `jit_fp_mips` (`bench/interp/ab-mac.sh`) when FP is touched. `WORKLOADS=user,boot`
     (the one-vCPU gates) comes last, after tier 3, only for the arm about to be kept (a gate-only win keeps
     nothing; docs/benchmarking.md "Screening an A/B"). Read time: the renderer's cycles and instructions are all its
     threads' and have pointed the wrong way;
  3. Firefox's pages session on the Mac (`bench/gpu/ab-mac.sh`, docs/benchmarking.md "Starting from a snapshot";
     ~4 min a session, `PAGES=wiki,mdn` under 2; from `target/snapbench/pages.waarm64snap`, which
     `bench/gpu/warm-snapshots.sh firefox` makes again when the machine's state layout changes) to confirm what
     passed tier 2, and for what tier 2 can't see: parallel SMP, the run loop, cache flushes; `@<tree>` for a base
     of another ABI.
- The paired command's verdict is the rule for tier 2 (`LOWER`/`HIGHER`: a difference; `same`: within ±0.5%). On
  the pages session a difference counts past ~1% when the arms' rounds don't overlap; **alternate which arm runs
  first** there: the session's first boot is an outlier either way (loop 25).
- Track the compile-side counters too (`emitNs`, `compileNs`, wasm bytes): an emitter's bookkeeping can cost the
  gates without changing the code (loop 24's eager table, +12 ms `emitNs`).
- `bench/gpu/mac-leftovers.sh` after every Mac run (`--kill` allowed); a killed run can leave its node harness behind:
  find it with `ps`, kill it by PID.
- A loop creates no new directory on the Mac (or removes it at its end), and after its Mac runs the disk report of
  `bench/gpu/mac-leftovers.sh` shows no per-run output left (docs/devenv.md "The Mac host").
- Check each arm by a changed function's size (`tools/wasm-sizes.ts`), not `cmp`. `../waarm64-base` (a detached side
  checkout for base arms) shares `target/`: touch a core source after building there.
- State the memory cost next to every speedup; ask the user before anything past a few tens of MiB.
- A micro-op entry (one device read, one instruction form) is judged by its own micro-benchmark, before and after, with
  the gate screen only showing no regression (loop 21's MMIO).
- Feature A/Bs: `SCRIPT=../imgdecode/codecs.ts ROUNDS=3 MAC_TIMEOUT=2700 bench/gpu/sway-mac.sh <feature>,<mode>
  target/arch/desktop.qcow2 <name>` (modes `codecs`, `kernels`, `fp16k`, `bf16k`).

**Batching** (the user, 2026-11-24): rows that start with a count on the same workloads share one diagnostic core
and one pass of those workloads (one run each: counts need no rounds), and their loop reports a bound a row; a row
under the floor closes as a finding there, with no A/B. A/Bs are for what the counts leave standing, several arms in
one paired run. One push tier (`ci.sh` and the topic scripts) for a batch of kept changes, targeted tests while
iterating; a loop that changes only docs, REPORTs and results needs none. Before a long run, check the REPORTs for a
number that already answers it.

**Correctness:** new behavior gets a test at the cheapest layer (bare-metal tests in tests/baremetal/ for JIT and MMU
paths; golden corpus for instruction semantics); each new rule gets a planted bug that a test must catch, then the
source is restored and the wasm rebuilt. `cargo fmt --all`, then `scripts/ci.sh`, plus the topic scripts for what the
change touches: `ci-jit.sh` for the JIT, `ci-fp.sh` for floating point, `ci-debian.sh` for devices and guest-visible
changes, `ci-usb.sh` for USB and device-exit paths (a device-exit bug was caught only by its testusb). `interp::block::hot`
makes no calls (tests/core-wasm.test.ts). Step counts (tests/steps.txt) move only for a guest-visible change,
pre-approved for performance, once, in its commit.

**The finish of a loop** (the subagent does it, code or no code): a REPORT entry "PERF loop N" with its results JSON
committed behind it; the docs page describing what exists (and the finding, so it isn't re-discovered); its issue
closed (`Fixes #n` in the commit) or reduced to a concrete doable follow-up (`node tools/issue.ts edit`, docs/issues.md); this file's queue row and state updated; `git fetch` and
rebase onto origin/main, commit, push to origin main.

**The supervisor between loops:**
- Check the report against the repo (`git log`, the pushed commit, `git status` clean), and `ps` for leftovers
  (stray `tail -F`/`ugrep` watchers outlive subagents).
- Triage: a kept change within the floor is fine when the counts bounded it there and it's small and tested; say so to
  the user. A loop's consistent small slowdown in every round is noted; if loops stack them, run a cumulative A/B
  (loop 25 did 21-24).
- **Out-of-context reviews**: after a loop that adds a subsystem or a new state form (loop 21's device path, loop 23's
  scalar shadows), and otherwise every ~3 loops: a fresh agent with only the area and "find real defects", never the
  loop's theories; it works statically (another job may use the machine), writes ranked findings to
  `review/<area>.md` on a `review/<area>` branch through a scratch worktree it removes. The next loop fixes them,
  each with its confirming test failing first, and deletes the branch on origin.
- A flaky test found by a loop's CI is fixed (wait on the condition, not a fixed time), not filed; `ci.sh` must pass.
- Small supervisor fixes (a flake, wording) are done directly, with their CI.
- Never edit or commit in the checkout while a subagent works there (a commit would sweep its unfinished edits):
  queue the user's small requests and do them between loops.

**The user's other requests mid-track** (they come in while loops run):
- **Merging a remote branch** (`claude/…`, from the user's cloud sessions): wait for the running loop to finish; read
  its log and diff; `git merge --no-edit origin/<branch>`; check that merged changes agree with each other (two
  branches fixing the same behavior can leave docs describing each other's old state); run the CI scripts the
  branch's author names plus what CLAUDE.md requires for what it touches, combined once for all branches merged
  together, one at a time; push only when all pass.
- **A bug to fix before the next loop**: a subagent of its own with the user's report quoted exactly (by-eye numbers
  marked as such), the commit that fixed it before if any, and "find the cause, don't assume it's in our code".
- **Waiting for another session to go idle**: `~/.claude/sessions/<pid>.json`'s `status` (`idle` vs `busy`/`shell`);
  its MCP servers stay as child processes for the session's life, so count only shells and tool runs. A watcher logs
  what it waits on at each check; one that demanded zero children cost a night.

## Preemption without the budget (done, loops 30-35)

The user's block of 2026-11-16: parallel SMP's compiled code without the step budget, polling a per-vCPU stop word.
Done; what exists is in docs/jit.md "Preemption (parallel SMP's polled code)", docs/platform.md "Parallel SMP" and
docs/abi.md "PERF: the stop word", the decision in docs/decisions.md "JIT", the numbers in bench/boot/REPORT.md "PERF
loop 30" to "PERF loop 35" (Firefox's pages session −4.7%, busy MIPS +3.4%, DSB waits −83%). What still binds PERF
loops that touch it: deterministic and realtime round-robin keep the counted code byte for byte and
`tests/steps.txt` doesn't move (if something moves it, stop and ask); a loop that changes compiled code gives the x64
static counts (`bench/jit/codestats.ts`) beside the Mac's; the spin tests and the polled differential test
(`scripts/ci-jit.sh`) cover a new poll point or setter, each with its planted bug. Its follow-up, `acc`'s
replacement, was built in loop 55 and reverted in loop 57 (docs/jit.md "Tried and lost: polled code without `acc`").

## State (2026-11-28, after loop 87)

**The track resumed 2026-11-28 (paused after loop 86).** Loop 87 did row 21 (bench/gpu/REPORT.md "PERF loop 87"): #57
closed as a finding, nothing built; the next row is 22.

**The rule since 2026-11-24 (the user): spend as little time in benchmarks and CI as the answers allow
("Batching", above).** Loop 75's notes still hold: `bench/boot/results/perf75/diag.patch` applies to 3a08fdf3; loop
67's warm-up is not landed (local branches `perf67-warmup`, `perf-smp-warm`, unpushed); `../waarm64-base` is detached
at 5d8f29ef. Loop 83's `diag.patch` (wake tallies) applies to 0c7707e7. Loop 85 did row 20 (bench/boot/REPORT.md
"PERF loop 85"): the 3D read-back reads levels straight into the saved bytes (the desktop's pause −12%), one HEAD a
remote disk a start, the start message no longer waits for the GPU worker (under the floor on the dev server: the
machine worker's own module load ran beside it). Its marks: `bench/boot/results/perf85/diag-new.py` (today's start).
The snapshot probe runs on the Mac too (`bench/snapz/probe-mac.sh`; `pages.waarm64snap` loads with 3D off there, its
caps being SwiftShader's), and the read-back alone on both (`bench/snapz/readback.ts`, `readback-mac.sh`).
Loop 86 fixed the out-of-context review of loop 84 (bench/io/REPORT.md "PERF loop 86"). `target/snapbench/pages.waarm64snap` loads into the current state layout;
`target/archarm/desktop.qcow2` is ab-mac.sh's default disk. The ABI is 74.

What every loop kept, dropped and found is in its REPORT entry (bench/boot/REPORT.md "PERF loop 36" to "PERF loop
66" for this session) and the docs pages it names; the out-of-context reviews (after loops 8, 19, 21, 23, 28, 32, 34,
36, 42, 47, 50, 55, 58, 71, 73, 74, 76, 77, 78, 79, 80, 82 and 84) were fixed in loops 9, 20, 22, 24, 29, 33, 35, 37, 43, 48, 56, 60, 72,
75, 77, 78, 80, 81, 82, 84 and 86 (50's: comments only), 73's in its own commit while paused. Built but off by default (measured slower): I8MM, FCMA,
FP16, FHM, BF16. The ABI is 74.

## Still open (the queue: the first is next; by expected gain, highest first)

Refilled by the supervisor on 2026-11-23 (after loop 63) from the backlog (now issues), from four static surveys of the code
(the JIT, the core outside its emitters, the host's devices and workers, the tunables and the old verdicts) and from
the user's two prompts: measurements taken against an earlier design may not hold, and constants nobody swept may be
worth as much as `block::REGION` 16 → 64 was (0793f714, 2026-11-22: the gates 4-5% faster, no memory). What bears on
every row:
- **Every count and A/B up to loop 57 was taken with 16-block regions**, and the compile policy's constants were last
  swept in the dev VM in October. A row marked *sweep* is a constant's A/B on the Mac (the gates, the parallel boots
  `smp_alpine_jit` and `smp_user_jit_4`, one pages session; `bench/boot/results/region64/gates2.sh` and its
  `pages-ab.sh`, `summary.py`), watching `planNs`, `emitNs`, the wasm's bytes, modules, flushes and RSS. A row marked
  *re-count* runs an old diagnostic on today's tree before anything is built.
- The rows are the surveys' reading of the code, nothing run: each row's figures are a bound to check, its count
  comes first, and a count that leaves a row under the floor closes it as a finding (the REPORT, the docs).
- A row from the backlog names its entry (now an issue: search for it with `node tools/issue.ts search`); the others have none (their finish writes the docs and the REPORT only).
- Rows 3-4 changed which blocks a region gets (on regions of 64 blocks: loop 64; batches of 50K steps: loop 65; `REGION_AFTER` 1000: loop 66): run them one at a time, each on the last one's winner; the compile threshold was re-checked after them (loop 69:
  1000/2000 stays).

| # | Entry | Kind | Notes |
|---|---|---|---|
| 22 | **Next**: Round-robin's run loop: `Vm::publish` at every chunk end, ERET and SVC through the loop (core/src/vm.rs:1171, :1292; interp/sys.rs:270) | count, build | the gates' own cost, not the page's (parallel throttles `publish_cpu` to every 65,536 steps and its exits are 0.2-0.3%): 1.37 M chunk ends in the userspace gate, 452 K of them an unmasking ERET (`results/perf49/counts-new.json`). The throttle is S (~0.5% by the survey's estimate); completing ERET in place is M and moves the gates without moving a user's machine: low, and say so in its report |
| 23 | Small sweeps, each one screen: `PRESSURE_KNEE` (mod.rs:297; flat 2000 against 1000/2000, the memory side), `VCPU_YIELD_MS` 50/100/250 (web/vm.ts:118; stalls), the table pre-grown at install (web/jit-host.ts:115) | sweep | none swept on the Mac; small expectations |
| 24 | Host, per event: virgl uploads across backing entries join into a fresh buffer (web/virgl-renderer.ts:694; count the joins first), an import's serial 1 MiB reads from a server (web/stored.ts:105), frame ports taking batches (P7 of the old backlog's "The network, per packet", which no issue carries), the checksum two bytes at a time (web/offload.ts:54), `Devices.poll`'s closures per request (web/devices.ts:887) | count, build | each by its own micro-benchmark; with other work in the file |
| 25 | JIT, likely under the floor: late-compiled successors through a reserved table slot (`via_jc`, emit.rs:2220; relinking and rebinding lost: try `results/perf54/` `chain2.mjs` with a constant index first), SP's alignment guard folded into the tag compare (emit.rs:4297; five wasm ops a probe), `refresh` storing every vCPU's IRQ byte (parallel.rs:814) | count | x64 and arm64 static counts (`bench/jit/codestats.ts`) decide the second |

Swept, measured or counted on the Mac recently, not to redo: a key's glyph on each screen (loop 87: every virtio-gpu screen 26-29 ms, the simple framebuffer 35-37, VM and Mac; the 2D presenter's upper quartile ~8 ms over the GPU worker's on the Mac, not worth a device worker with animation frames), the start message's wait for the GPU worker (loop 85: hidden behind the machine worker's own module load on the dev server, −7 ms on the VM and −10 ms on the Mac's load once removed; a fresh browser's first WebGL2 context on the Mac's GPU 27-178 ms), device completions and host signals waking every vCPU (loop 83: ~300 empty `IDLE` exits a second on the pages session, ≤1.7% of a core, none in an idle guest; one taker or no poll after them not built), the idle poll's `SPIN_MS` 0/10/20/50/100 µs (loop 83: 20 kept, renderer CPU −2.8%; 0 slows futex hand-offs 2.5×; an adaptive poll is [#134](https://github.com/gbl08ma/waarm64/issues/134)), virgl's GL calls a draw (loop 79: 79 before a draw, 80% repeats; the framebuffer's points and draw buffers, the vertex arrays and the uniforms now kept; the rest, global state ~0.5 µs a draw, left: bench/gpu/REPORT.md "PERF loop 79"), the blk path on a persistent profile (loop 76: `ORDERED`'s flushes, the copies, the bulk writes), probes a region's earlier block already made, the translation memo and X registers sharing locals at 64 blocks (loop 75: closed under the floor), what entries cost a loop through another page (loop 75: ≤ 0.2%), entries at every member of the head's page and the helper's one decode (loop 74: kept; left without entries: loop regions' members and other pages', ~0.3% of the page at most), the jump cache's size (loop 73: `JC` 131,072 and 262,144), the sibling fill over another page's entry (loop 73: it thrashes a copy between two pages of one index), loop 72's closed counts (the transfer cache at 65,536 entries and a per-ASID generation, `TLB_ENTRIES` 32,768 and 65,536, a last-level table cache, a fill of the neighbour's PTE, `NG_SLOTS`, a longer TLBI queue, the interpreter under live host frames, the helper histogram: nothing to inline, FlagM never runs), the repeated last emission (loop 71: kept), XZR's write sink (kept) and one probe for an LdO/StO pair (loop 70), the compile threshold (loop 69: 500/1000 to 4000/8000), region sizes 16/32/64 and 96/128/256 (loop 64), the decoded blocks' budget and slots (loops 1, 38), the block map's constants (loop
41), the parallel chunk (loop 32), `BATCH_STEPS` (loop 65), `REGION_AFTER` (loop 66), the compile worker's warm-up (loops 67, 67b), `WARM` with `REPORT` (loop 68), the 320 MiB budget (loop 63), the idle wait's constants (loops 53, 58, 60), a
function's size as such (2026-11-05, loop 13), the dispatcher's entries and the signature check (loop 54), lazy NZCV
at a loop's head (loop 42), and the features off by default (I8MM, FCMA, FP16, FHM, BF16: host-op counts, which
nothing since has changed).

Left as they are: x86-only (DotProd/JSCVT tuning, `relaxed_trunc`), the OpenSSL MIDR (the user, 2026-11-10: keep
ours for now), bug watches (Firefox's first page, the lost Firefox process), parallel `make` (needs a harness), the
default vCPU count (settings, not a measurement), FEAT_FP16's scalar forms in the f32 shadows (only if FP16 is ever
advertised), CoreMark's gap (don't fit the design to it), Buildroot's warm-boot IQR (a check guest, not a target),
memory 2's accesses on a Vulkan machine past ~4.5 GiB (the user's call), Vulkan's entries (VK4's).
