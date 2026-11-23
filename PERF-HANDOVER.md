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
     background, alone; it stops by itself with a verdict to ±0.5%): on `node`, its default, to rank the change for
     the browser (4-10 min), then `WORKLOADS=user,boot` to see the gates didn't regress (~10 min); several arms in
     one run when a row has variants; `AA=1` when a result looks like noise; plus `jit_fp_mips`
     (`bench/interp/ab-mac.sh`) when FP is touched. Read time: the renderer's cycles and instructions are all its
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

## State (2026-11-23, after loop 63)

Loop 63 ran real long browser sessions on the Mac (`bench/gpu/firefox-load.ts` `PHASES=browse`, analysed by
`bench/gpu/flush-cost.ts`): an hour in one Firefox compiled 184 MB, an hour with Firefox restarted every 150 s 173 MB,
~0.8 MB a minute by then: no flush at 320 MiB (hours away). At `?jitmb=128` its one flush (28 min in, the counter
checked end to end) cost 45 s of a lower compiled share and no stall or frame gap beyond the session's own. Nothing
built; the backlog entry is gone (bench/boot/REPORT.md "PERF loop 63", results in `bench/boot/results/perf63/`). Core
unchanged (ABI 74, `tests/steps.txt` unchanged). **The track is paused at the user's request after loop 63
(2026-11-23)**; the next loop is 64, from the queue's first row. The BENCH track that went ahead of it ended the
same day: its paired command and its `node` workload are tier 2 below (bench/boot/REPORT.md "BENCH loop 2" to "the
end").
`target/snapbench/pages.waarm64snap` loads into the current state layout; `target/archarm/desktop.qcow2` is
ab-mac.sh's default disk. `../waarm64-base` is at 1fe6dec0. Loop 63's commit passed `scripts/ci-fast.sh` (bench tools
only).

What every loop kept, dropped and found is in its REPORT entry (bench/boot/REPORT.md "PERF loop 36" to "PERF loop
63" for this session) and the docs pages it names; the out-of-context reviews (after loops 8, 19, 21, 23, 28, 32, 34,
36, 42, 47, 50, 55 and 58) were fixed in loops 9, 20, 22, 24, 29, 33, 35, 37, 43, 48, 56 and 60 (50's: comments only).
The next is due after the next loop that adds a mechanism. Built but off by default (measured slower): I8MM, FCMA,
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
- Rows 2-4 change which blocks a region gets: run them one at a time, each on the last one's winner, and re-check the
  compile threshold (1000/2000 against 500/1000, tied on 2026-11-09 at 16 blocks) once after them.

| # | Entry | Kind | Notes |
|---|---|---|---|
| 1 | **Next:** JIT: regions past 64 blocks (`block::REGION`, core/src/jit/block.rs:210) | sweep | 32 → 64 was still −2.0% on the boot and −1.1 to −1.5% on the parallel boots; 96, 128 and 256 are untried. Watch planning (+35% at 64; the bound on walks that wasn't kept is `region64/` `mitigations.patch`). `block::CAP` 64 as an arm only if cheap (cap-ended blocks 0.03-1% of entries; `Info::len` is a u8, the interpreter's stack array is `2*CAP`) |
| 2 | JIT: `BATCH_STEPS` on the Mac (core/src/jit/mod.rs:530, 50,000; `Config::batch` 512) | sweep, stale verdict | 25K, 50K, 100K, 200K. Set 2026-10-08 in the VM ("The Mac host wasn't measured"); "Larger batches in a browser" (jit.md "Tried and not kept", 2026-11-03) is the VM's, two sessions an arm, never the gates. Forward regions take only their batch's blocks: "Regions of 64 blocks" counts 6.5-9.3 tail exits per 1000 steps to a target compiled before and 4.9-7.0 to one another region of the batch took. Watch interpreted steps, lock acquisitions, stalls ≥ 20 ms |
| 3 | JIT: loop heads compiled alone, then again as a region (`REGION_AFTER` 1000, mod.rs:300; `Cache::plan` mod.rs:1281) | sweep, count | `region_after` 0, 250, 1000 (0 is the forced mode's value: one constant). Last swept at M6 in Node with a threshold of 50; the "regions at the first threshold cost the boots 10-14%" verdict is M5's. After a tier-up every earlier link still enters the head's function, which loads the hot word and transfers again: 145 M redirects a pages session (2026-11-05), 839 of 2,728 installs tier-ups (loop 59), 4.5 exits per 1000 steps into a head compiled alone at 64 blocks. Tally the redirects first; a second arm marks a loop's members taken so they aren't compiled as forward regions too. Watch the wasm (loops compiled twice today) |
| 4 | JIT: Liftoff's lazy compiles on the vCPU's thread | bound first | the compile worker's `new WebAssembly.Module` only validates; V8 compiles each function at its first call, on the vCPU (Liftoff ~22-25 µs/KB against emission's ~12.7: jit.md, bench/interp/REPORT.md). The bound needs no code: an A/B with `CHROMIUM_JS_FLAGS=--no-wasm-lazy-compilation` on the parallel boots and the pages session (the round-robin gates have no worker). If it clears the floor: the worker calls each export once behind an entry guard (measure the guard alone), or V8's compilation hints. Unverified: that a worker's lazy compile reaches the shared module. Sharpens the backlog's "Cold, kernel-heavy phases" |
| 5 | JIT: `WARM` (mod.rs:537, 16) with the interpreter's `REPORT` (interp/block.rs:3154, 16) | sweep, stale verdict | 4, 8, 16, 32 (`REPORT` 8 with `WARM` 8). 1 and 4 lost on 2026-10-16 in the VM on +33-41% wasm and a third flush at 160 MiB; the budget is 320 MiB now, a session doesn't flush in an hour (loop 63) and size costs nothing on the Mac. State the wasm and V8's code memory with the result |
| 6 | Interpreter: XZR's writes through a sink slot, and one TLB probe for a pair (bench/interp/REPORT.md, 2026-10-30/31) | stale verdict | lost in the VM for its store bounds check and a register-allocation cliff in `hot<Flat>`; `hot` has lean and rich copies since loop 19, and the interpreter is 18.4% of the Mac's pages session. The patch: `bench/interp/results/xzr-spike/sink/`; `bench/interp/ab-mac.sh` on the block-interpreter guests, the flat one too |
| 7 | JIT: a settled region's last emission repeats the one before (core/src/jit/block.rs:1023-1057) | count, build | a region of several blocks is emitted to find `plain`, then until its entry states settle, then once more with the arguments that just settled: three emissions where two would do. Emission is ~170 ms of the boot gate's 3.84 s, ~1.9 s of a pages session. A passes-per-region histogram first; the modules must stay byte for byte (`bench/jit/dump-modules.ts`). Follow-up: a single block with `plain` 0 emits twice alike |
| 8 | JIT: transfers that still leave a function (backlog "JIT") | re-count | re-profile with `bench/boot/userprof.ts` at 64 blocks; with it the two verdicts 64 blocks may move: "Regions entered at more than one block" (2026-10-08, the VM; `results/m8-entries/member-entries.patch`: more members now have no function of their own) and loop 50's followed calls that complete inside the region (`WAARM64_FOLLOW_ALL`, `bench/boot/preempt-counts.ts`). Turn into a doable to-do or a finding |
| 9 | JIT: the transfer cache under a browser's code (`XC_ENTRIES` 16,384, core/src/mmu.rs:82; `JC` 65,536, mod.rs:505) | count, sweep | 161 M miss-function calls a pages session against 651 M hits (loop 54); "65,536 measured the same" was Alpine in Node, and loop 28's split of causes (zeroed, another VA's, an older generation) Alpine's userspace run. Its `results/perf28/diag.patch` counters on the pages session; conflicts → 65,536 (+768 KiB a vCPU; the `XC - XC_LO` OR needs its alignment), stale generations → a per-ASID generation (L). `JC` was never swept: count the probes that miss while their key is compiled |
| 10 | MMU: one diagnostic build for the TLB's misses (`Mmu::miss`, core/src/mmu.rs:1097) | count | miss and walk are 1.6-1.9% of the Mac's busy ticks, ~10 M misses a render. Tally: the read/write sibling that walks again (a walk computes all six permissions and fills one array; a mixed group probes the write array), fills next to the last fill (a neighbour's PTE is one load away), walks by level and their time (a last-level table cache), nG-list overflows, `flush_all` calls. Then `TLB_ENTRIES` 32,768 and 65,536 on the Mac (swept in the VM only, 2026-11-03; +1.6 MiB a vCPU a doubling; `NG_SLOTS` 1,024 never resized). Build what the tallies justify, the sibling fill first (not watched pages) |
| 11 | Parallel SMP: a full TLBI queue becomes a whole flush, global entries too (`QUEUE` 64, core/src/vm/parallel.rs:31, :887, :931) | count, build | a vCPU in WFI or on another ASID collects every other vCPU's TLBI IS until it drains; past 64 it flushes everything and walks the kernel's entries again. Tally drains, those with `tlb_all`, the queue's length, whether what overflowed was user-half or by ASID, on `smp_user_jit_4` and the pages session (row 10's build can carry it). Then a longer queue (S), or user-half and ASID overflows collapsing to `flush_ng` (M: a `maint.c` round, a planted bug) |
| 12 | JIT: probes a region's earlier block already made, and the translation memo again (jit.md "Wider groups of accesses", "A TLB translation memo in wasm locals") | re-count, bound | groups are per block; "46% of probes land on the page of one of the function's last two probes" was counted at 16 blocks, the memo lost at M8 in the VM on `alpine_user_jit`, and the groups' "moved no time" is the VM's (its bounds checks tax every access). Count statically (the accstat analysis, `bench/boot/results/accstat/`), on the gates and the pages session, the probes dominated in their region by a probe of the same base and span, the base unchanged (SP's frame first); then an unsound bound that skips them (as `flagx` was); build the dominated-successor form only past ~1%. Check what a poll between the two may change in parallel SMP (another vCPU's TLBI) |
| 13 | JIT: host frames lost when compiled code stops for an uncompiled block (`emit::unreturned`, emit.rs:2037; block.rs:1556) | count | 134.5 M compiled → interpreter round trips a pages session (loop 54), each unwinding every host frame, so the returns above become transfer-cache probes. Split the `XC_HIT` and miss tallies by RET/BLR/BR and take `DEPTH` at "not compiled" stops. A build (the interpreter called under the live frames, as `jit_hot`) is L with re-entrancy: only on a large count |
| 14 | Devices: `bench/io` on a persistent profile, then the overlay's flush per write request (web/overlay.ts:756, :789, `ORDERED`) | re-measure, build | `bench/run.ts` launches off the record, where an OPFS call is 210-300 µs and a flush free; on a profile a call is ~1 µs and each ordered flush ~0.17 ms (SNAPZ loop 5), so bench/io/REPORT.md ranked the blk path on a cost users on a profile don't have. First: a persistent-profile option for `--only io` (`bench/snapz/probe.ts` has the launch), `io_stats` with `ORDERED` on and off, the `scatter`/`gather` copies' share (a read into the guest's segment, if past a few percent). Then map entries kept to the guest's FLUSH with one data flush a group (bench/io/REPORT.md names it twice, never built; `tests/overlay.test.ts`'s crash replay moves); an image's import opened unordered with one flush at its end (web/stored.ts:101; check a half import is always discarded). The Mac too |
| 15 | Devices: restore, merge and Import changes write one block per call (backlog "Platform and devices"; "Off the record" under Snapshots) | measure, build | a 4 GiB overlay ~10 minutes by the reviewer's estimate, unmeasured; runs of consecutive blocks given to `write` and `zero` at once. Measure, then build with row 14's profile option |
| 16 | 3D: virgl sets the whole GL state at every draw (web/virgl-renderer.ts:2791-3135), with the backlog's program-cache key | count, build | some 60-100 WebGL calls a draw before the draw (the survey's reading), by design (graphics.md: nothing assumed bound). Count GL calls and `render-stats`' busy time per draw under `bench/gpu/firefox-load.ts` and `gtk4-load.ts`, on the Mac (`bench/gpu/ab-mac.sh`; SwiftShader hides call overhead). Then a VAO per vertex layout (M), a state shadow the renderer's own passes invalidate (L), the program by a state version; `scripts/ci-deqp.sh` gates it |
| 17 | Run loop: device completions and host signals wake every vCPU (web/devices.ts:976, web/vm.ts:619, parallel.rs:314) | count, build | each other idle vCPU wakes, enters the core, publishes, returns IDLE and spins `SPIN_MS` before it sleeps: host CPU more than guest speed. Tally in web/vcpu-worker.ts the IDLE exits that retired nothing after a wake; `bench/boot/idle-cpu.ts` before and after. Then no spin after an idle that retired nothing (S), or one taker woken (M: the no-missed-wake argument again). `SPIN_MS` 0, 20, 50, 100 µs on the Mac with it (M7 loop 8's value is Node's in the VM) |
| 18 | JIT: what the pages session's 175 M helper steps are (`jit_helper_report`, benchmarking.md "The helper histogram") | count | helper bodies and entries are 4.6-4.9% of the Mac's busy ticks; loop 8's system classes explain 16-30 M. The histogram on a pages session needs no build; what it shows inline-worthy becomes its own row (FlagM's forms among them: backlog "CPU and ISA"). The helper decodes its word twice (mod.rs:2782, :2834): pass the `Op` on |
| 19 | JIT: Liftoff's zero-fill and X registers sharing locals, at 64 blocks (loops 26, 27) | re-count | the fill is linear in a function's locals; 64-block functions hold more registers and are entered less often. The diagnostic cores of `bench/boot/results/perf26/` and `perf27/` on today's tree |
| 20 | Snapshots: the load's start and the pause, what's left (backlog "Snapshots") | build | the start message waits 53-100 ms for the GPU worker's WebGL start (fetch, compile and check meanwhile); two HEADs per remote disk; the 3D read-back copies each level twice (web/virgl-renderer.ts:874-921: `readPixels` straight into `out` for packed formats; 187-230 ms of the desktop's 1.07 s pause). `bench/snapz/probe.ts` before and after |
| 21 | Display: a key's glyph ~13 ms later on virtio-gpu than on the simple framebuffer (backlog "Platform and devices") | measure | the entry's next step: the same measurement on the Mac's GPU, then a device worker with animation frames or drawing from the machine worker |
| 22 | Round-robin's run loop: `Vm::publish` at every chunk end, ERET and SVC through the loop (core/src/vm.rs:1171, :1292; interp/sys.rs:270) | count, build | the gates' own cost, not the page's (parallel throttles `publish_cpu` to every 65,536 steps and its exits are 0.2-0.3%): 1.37 M chunk ends in the userspace gate, 452 K of them an unmasking ERET (`results/perf49/counts-new.json`). The throttle is S (~0.5% by the survey's estimate); completing ERET in place is M and moves the gates without moving a user's machine: low, and say so in its report |
| 23 | Small sweeps, each one screen: `PRESSURE_KNEE` (mod.rs:297; flat 2000 against 1000/2000, the memory side), `VCPU_YIELD_MS` 50/100/250 (web/vm.ts:118; stalls), the table pre-grown at install (web/jit-host.ts:115) | sweep | none swept on the Mac; small expectations |
| 24 | Host, per event: virgl uploads across backing entries join into a fresh buffer (web/virgl-renderer.ts:694; count the joins first), an import's serial 1 MiB reads from a server (web/stored.ts:105), frame ports taking batches (backlog "The network, per packet" P7), the checksum two bytes at a time (web/offload.ts:54), `Devices.poll`'s closures per request (web/devices.ts:887) | count, build | each by its own micro-benchmark; with other work in the file |
| 25 | JIT, likely under the floor: late-compiled successors through a reserved table slot (`via_jc`, emit.rs:2220; relinking and rebinding lost: try `results/perf54/` `chain2.mjs` with a constant index first), SP's alignment guard folded into the tag compare (emit.rs:4297; five wasm ops a probe), `refresh` storing every vCPU's IRQ byte (parallel.rs:814) | count | x64 and arm64 static counts (`bench/jit/codestats.ts`) decide the second |

Swept or measured on the Mac recently, not to redo: the compile threshold (2026-11-09, but see the note above the
table), region sizes 16/32/64, the decoded blocks' budget and slots (loops 1, 38), the block map's constants (loop
41), the parallel chunk (loop 32), the 320 MiB budget (loop 63), the idle wait's constants (loops 53, 58, 60), a
function's size as such (2026-11-05, loop 13), the dispatcher's entries and the signature check (loop 54), lazy NZCV
at a loop's head (loop 42), and the features off by default (I8MM, FCMA, FP16, FHM, BF16: host-op counts, which
nothing since has changed).

Left as they are: x86-only (DotProd/JSCVT tuning, `relaxed_trunc`), the OpenSSL MIDR (the user, 2026-11-10: keep
ours for now), bug watches (Firefox's first page, the lost Firefox process), parallel `make` (needs a harness), the
default vCPU count (settings, not a measurement), FEAT_FP16's scalar forms in the f32 shadows (only if FP16 is ever
advertised), CoreMark's gap (don't fit the design to it), Buildroot's warm-boot IQR (a check guest, not a target),
memory 2's accesses on a Vulkan machine past ~4.5 GiB (the user's call), Vulkan's entries (VK4's).
