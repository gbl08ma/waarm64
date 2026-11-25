# PERF: the performance backlog — handover

This file is all a new session needs to carry on the track: what it is, how it's worked, where it stands, what's next.
What each loop did is in the REPORT entries named "PERF loop N" (bench/boot/REPORT.md for the JIT, the ISA and the
devices; bench/interp/REPORT.md for the block interpreter; bench/gpu/REPORT.md for the query poll).

## The brief

The user's (2026-11-10): go through every performance entry of docs/backlog.md that the dev VM or the Mac host can try
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
- The entry, quoted with its docs/backlog.md location, and the files it touches; anything new since it was written
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
committed behind it; the docs page describing what exists (and the finding, so it isn't re-discovered); the backlog
entry removed or reduced to a concrete doable follow-up; this file's queue row and state updated; `git fetch` and
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

## State (2026-11-24, after loop 73)

**The track is paused after loop 73 (the user, 2026-11-24): nothing runs until it is resumed.** To resume: read
this file, then start at "Next" below. The out-of-context review of loop 73's two mechanisms (the sibling fill in
`Mmu::miss`, the TLBI queue's `Collapsed`) is done (branch `review/mmu-tlbi-queue`, 0505820b, deleted since): its two findings (a mid-chunk
ASID change left the old ASID published; `drain` held the queue's lock through its flushes) were fixed in the
commit "PERF: loop 73's review fixed", outside the loops; the track stays paused.

**Resumed 2026-11-24 (the user), with one more rule: spend as little time in benchmarks and CI as the answers allow
("Batching", above).** Loop 72 counted rows 8, 9, 10, 11, 13 and 18 in one pass with one diagnostic core and closed
most as findings. Loop 73 took the three it ranked first (bench/boot/REPORT.md "PERF loop 73",
`bench/boot/results/perf73/`): **the TLB's sibling fill and the collapsed TLBI queue's nG flush are built and kept
within the floor** (a pages session: TLB misses 51.4 M → 40.8 M, flushes of everything 2,398 → 8, 8.6% fewer
instructions in helpers; no time measure moved outside its noise on `node`, the pages session or the gates: small,
tested, no memory, no speedup claimed), **and `JC` stays 65,536** (131,072 and 262,144 `open` on `node`; the gates'
guests refill it tens of thousands of times a run, and loop 72's 1.6 M in `smp_user_jit_4`'s SQLite phase was one
run's placement). Its commit passed `ci-fast.sh`, `ci.sh`, `ci-jit.sh` and `ci-debian.sh`. No export or state layout changed.
Loop 67's warm-up is not landed; the local branches `perf67-warmup` and `perf-smp-warm` stay unpushed;
`../waarm64-base` is detached at 5d8f29ef (clean). The review branch `review/jit-warmup` on origin is moot: the
supervisor may delete it.
**Next, when resumed:** row 10, entries at a region's members (the largest bound left, 1.9%, and the least certain: its count
first on today's tree, the pages session and the wasm's bytes its measure), with row 11 (the helper's second decode,
S, the same files) beside it if the loop has room. Loop 73's lesson for bounds: a count times a unit cost near the
pages session's ~1% floor came out under it twice; rank what is left by bounds well past the floor. `bench/boot/results/perf73/diag.patch` applies to loop 73's commit and carries
the counters a later row may want (the TLB's, the queues', the jump cache's, the members').
`target/snapbench/pages.waarm64snap` loads into the current state layout; `target/archarm/desktop.qcow2` is
ab-mac.sh's default disk. The ABI is 74.

What every loop kept, dropped and found is in its REPORT entry (bench/boot/REPORT.md "PERF loop 36" to "PERF loop
66" for this session) and the docs pages it names; the out-of-context reviews (after loops 8, 19, 21, 23, 28, 32, 34,
36, 42, 47, 50, 55, 58, 71 and 73) were fixed in loops 9, 20, 22, 24, 29, 33, 35, 37, 43, 48, 56, 60 and 72 (50's: comments
only), 73's in its own commit while paused. Built but off by default (measured slower): I8MM, FCMA,
FP16, FHM, BF16. The ABI is 74.

## Still open (the queue: the first is next; by expected gain, highest first)

Refilled by the supervisor on 2026-11-23 (after loop 63) from docs/backlog.md, from four static surveys of the code
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
- A row from the backlog names its entry; the others have none (their finish writes the docs and the REPORT only).
- Rows 3-4 changed which blocks a region gets (on regions of 64 blocks: loop 64; batches of 50K steps: loop 65; `REGION_AFTER` 1000: loop 66): run them one at a time, each on the last one's winner; the compile threshold was re-checked after them (loop 69:
  1000/2000 stays).

| # | Entry | Kind | Notes |
|---|---|---|---|
| 10 | **Next:** JIT: entries at a region's members (backlog "Entries at a region's members") | build | loop 72: 8-12% of the interpreted steps reported are at blocks installed as members (0.2-0.4% of the gates' steps, ~0.3% of a pages session's), 15% of the session's regions headed by a block already a member; bound 1.9% (1.2% the steps, 0.7% the round trips), half at best. M: `Region::entries` for members entered from outside (the head's page, no `loop`); the pages session and the wasm's bytes. The largest bound and the least certain |
| 11 | JIT: the helper decodes its word twice (`jit::count`, then `interp::exec_at`; backlog) | build | 168 M instructions in helpers a pages session (loop 72), under 0.4% at 5 ns; S, by its own micro-benchmark, with other work in the file |
| 12 | JIT: probes a region's earlier block already made, and the translation memo again (jit.md "Wider groups of accesses", "A TLB translation memo in wasm locals") | re-count, bound | groups are per block; "46% of probes land on the page of one of the function's last two probes" was counted at 16 blocks, the memo lost at M8 in the VM on `alpine_user_jit`, and the groups' "moved no time" is the VM's (its bounds checks tax every access). Count statically (the accstat analysis, `bench/boot/results/accstat/`), on the gates and the pages session, the probes dominated in their region by a probe of the same base and span, the base unchanged (SP's frame first); then an unsound bound that skips them (as `flagx` was); build the dominated-successor form only past ~1%. Check what a poll between the two may change in parallel SMP (another vCPU's TLBI) |
| 14 | Devices: `bench/io` on a persistent profile, then the overlay's flush per write request (web/overlay.ts:756, :789, `ORDERED`) | re-measure, build | `bench/run.ts` launches off the record, where an OPFS call is 210-300 µs and a flush free; on a profile a call is ~1 µs and each ordered flush ~0.17 ms (SNAPZ loop 5), so bench/io/REPORT.md ranked the blk path on a cost users on a profile don't have. First: a persistent-profile option for `--only io` (`bench/snapz/probe.ts` has the launch), `io_stats` with `ORDERED` on and off, the `scatter`/`gather` copies' share (a read into the guest's segment, if past a few percent). Then map entries kept to the guest's FLUSH with one data flush a group (bench/io/REPORT.md names it twice, never built; `tests/overlay.test.ts`'s crash replay moves); an image's import opened unordered with one flush at its end (web/stored.ts:101; check a half import is always discarded). The Mac too |
| 15 | Devices: restore, merge and Import changes write one block per call (backlog "Platform and devices"; "Off the record" under Snapshots) | measure, build | a 4 GiB overlay ~10 minutes by the reviewer's estimate, unmeasured; runs of consecutive blocks given to `write` and `zero` at once. Measure, then build with row 14's profile option |
| 16 | 3D: virgl sets the whole GL state at every draw (web/virgl-renderer.ts:2791-3135), with the backlog's program-cache key | count, build | some 60-100 WebGL calls a draw before the draw (the survey's reading), by design (graphics.md: nothing assumed bound). Count GL calls and `render-stats`' busy time per draw under `bench/gpu/firefox-load.ts` and `gtk4-load.ts`, on the Mac (`bench/gpu/ab-mac.sh`; SwiftShader hides call overhead). Then a VAO per vertex layout (M), a state shadow the renderer's own passes invalidate (L), the program by a state version; `scripts/ci-deqp.sh` gates it |
| 17 | Run loop: device completions and host signals wake every vCPU (web/devices.ts:976, web/vm.ts:619, parallel.rs:314) | count, build | each other idle vCPU wakes, enters the core, publishes, returns IDLE and spins `SPIN_MS` before it sleeps: host CPU more than guest speed. Tally in web/vcpu-worker.ts the IDLE exits that retired nothing after a wake; `bench/boot/idle-cpu.ts` before and after. Then no spin after an idle that retired nothing (S), or one taker woken (M: the no-missed-wake argument again). `SPIN_MS` 0, 20, 50, 100 µs on the Mac with it (M7 loop 8's value is Node's in the VM) |
| 19 | JIT: Liftoff's zero-fill and X registers sharing locals, at 64 blocks (loops 26, 27) | re-count | the fill is linear in a function's locals; 64-block functions hold more registers and are entered less often. The diagnostic cores of `bench/boot/results/perf26/` and `perf27/` on today's tree |
| 20 | Snapshots: the load's start and the pause, what's left (backlog "Snapshots") | build | the start message waits 53-100 ms for the GPU worker's WebGL start (fetch, compile and check meanwhile); two HEADs per remote disk; the 3D read-back copies each level twice (web/virgl-renderer.ts:874-921: `readPixels` straight into `out` for packed formats; 187-230 ms of the desktop's 1.07 s pause). `bench/snapz/probe.ts` before and after |
| 21 | Display: a key's glyph ~13 ms later on virtio-gpu than on the simple framebuffer (backlog "Platform and devices") | measure | the entry's next step: the same measurement on the Mac's GPU, then a device worker with animation frames or drawing from the machine worker |
| 22 | Round-robin's run loop: `Vm::publish` at every chunk end, ERET and SVC through the loop (core/src/vm.rs:1171, :1292; interp/sys.rs:270) | count, build | the gates' own cost, not the page's (parallel throttles `publish_cpu` to every 65,536 steps and its exits are 0.2-0.3%): 1.37 M chunk ends in the userspace gate, 452 K of them an unmasking ERET (`results/perf49/counts-new.json`). The throttle is S (~0.5% by the survey's estimate); completing ERET in place is M and moves the gates without moving a user's machine: low, and say so in its report |
| 23 | Small sweeps, each one screen: `PRESSURE_KNEE` (mod.rs:297; flat 2000 against 1000/2000, the memory side), `VCPU_YIELD_MS` 50/100/250 (web/vm.ts:118; stalls), the table pre-grown at install (web/jit-host.ts:115) | sweep | none swept on the Mac; small expectations |
| 24 | Host, per event: virgl uploads across backing entries join into a fresh buffer (web/virgl-renderer.ts:694; count the joins first), an import's serial 1 MiB reads from a server (web/stored.ts:105), frame ports taking batches (backlog "The network, per packet" P7), the checksum two bytes at a time (web/offload.ts:54), `Devices.poll`'s closures per request (web/devices.ts:887) | count, build | each by its own micro-benchmark; with other work in the file |
| 25 | JIT, likely under the floor: late-compiled successors through a reserved table slot (`via_jc`, emit.rs:2220; relinking and rebinding lost: try `results/perf54/` `chain2.mjs` with a constant index first), SP's alignment guard folded into the tag compare (emit.rs:4297; five wasm ops a probe), `refresh` storing every vCPU's IRQ byte (parallel.rs:814) | count | x64 and arm64 static counts (`bench/jit/codestats.ts`) decide the second |

Swept, measured or counted on the Mac recently, not to redo: the jump cache's size (loop 73: `JC` 131,072 and 262,144), the sibling fill over another page's entry (loop 73: it thrashes a copy between two pages of one index), loop 72's closed counts (the transfer cache at 65,536 entries and a per-ASID generation, `TLB_ENTRIES` 32,768 and 65,536, a last-level table cache, a fill of the neighbour's PTE, `NG_SLOTS`, a longer TLBI queue, the interpreter under live host frames, the helper histogram: nothing to inline, FlagM never runs), the repeated last emission (loop 71: kept), XZR's write sink (kept) and one probe for an LdO/StO pair (loop 70), the compile threshold (loop 69: 500/1000 to 4000/8000), region sizes 16/32/64 and 96/128/256 (loop 64), the decoded blocks' budget and slots (loops 1, 38), the block map's constants (loop
41), the parallel chunk (loop 32), `BATCH_STEPS` (loop 65), `REGION_AFTER` (loop 66), the compile worker's warm-up (loops 67, 67b), `WARM` with `REPORT` (loop 68), the 320 MiB budget (loop 63), the idle wait's constants (loops 53, 58, 60), a
function's size as such (2026-11-05, loop 13), the dispatcher's entries and the signature check (loop 54), lazy NZCV
at a loop's head (loop 42), and the features off by default (I8MM, FCMA, FP16, FHM, BF16: host-op counts, which
nothing since has changed).

Left as they are: x86-only (DotProd/JSCVT tuning, `relaxed_trunc`), the OpenSSL MIDR (the user, 2026-11-10: keep
ours for now), bug watches (Firefox's first page, the lost Firefox process), parallel `make` (needs a harness), the
default vCPU count (settings, not a measurement), FEAT_FP16's scalar forms in the f32 shadows (only if FP16 is ever
advertised), CoreMark's gap (don't fit the design to it), Buildroot's warm-boot IQR (a check guest, not a target),
memory 2's accesses on a Vulkan machine past ~4.5 GiB (the user's call), Vulkan's entries (VK4's).
