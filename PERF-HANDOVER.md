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
  2. a ~15-20 min screen, 3 rounds alternated: `bench/run-mac.sh` / `bench/interp/ab-mac.sh` for the JIT gates
     (`alpine_jit_total`, `alpine_user_jit_total`), plus `jit_fp_mips` when FP is touched;
  3. Firefox's pages session on the Mac (`bench/gpu/ab-mac.sh`, docs/benchmarking.md "Starting from a snapshot";
     ~4 min a session, from `target/snapbench/pages.waarm64snap`, which `bench/gpu/warm-snapshots.sh firefox` makes
     again when the machine's state layout changes) for changes to cold browser code or a block's end; `@<tree>` for
     a base of another ABI.
- A difference counts past ~1% when the arms' rounds don't overlap. **Alternate which arm runs first**: the session's
  first boot is an outlier either way (loop 25).
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
replacement, is in docs/backlog.md "Parallel SMP's code without `acc`".

## State (2026-11-22, after loop 48)

Loop 48 fixed the six findings of the review of the block map's bounds and RAM's layout (bench/boot/REPORT.md "PERF
loop 48"): the decoded blocks' arenas capped at their share (the pages session's decoded blocks 206 → 198 MiB, the
heap's mark 288 → 281), an install's new members filed only with room, `linkers` lists cleaned as they grow,
`Mem::host0` without `ptr::add` past 2 GiB, `bootVm` refusing images past RAM's end and the page clamping `?ram=` to
the slider; the gates neutral. The branch is deleted. The next out-of-context review is due within ~3 loops. Main is
clean at loop 48's commit, no run pending.

What every loop kept, dropped and found is in its REPORT entry (bench/boot/REPORT.md "PERF loop 36" to "PERF loop
48" for this session) and the docs pages it names; the out-of-context reviews (after loops 8, 19, 21, 23, 28, 32, 34,
36, 42 and 47) were fixed in loops 9, 20, 22, 24, 29, 33, 35, 37, 43 and 48. Built but off by default (measured slower): I8MM,
FCMA, FP16, FHM, BF16. Where things stand: regions follow a call only when its callee can't leave them (loops 36-37,
the gates −2.5%); the core's heap is measured and bounded (loops 38-44: the block map at 900,000 keys and 2^20
buckets, its table kept across a prune, its prune allocating nothing; 15 minutes of real sites in the desktop guest's
Chromium and Firefox stay at 284-295 MiB with no rescue); lazy NZCV at a loop's head measured nothing on the Mac and
was dropped (loop 42). The ABI is 72 (loop 43's `mapRescues`); snapshots are unaffected. `target/snapbench/pages.waarm64snap`
was remade from cda6cfa7's core (it loads into loop 46's).

## Still open (the queue: the first is next; by expected gain)

| Entry (docs/backlog.md) | Notes |
|---|---|
| **Next:** JIT: the gates' timer register accesses inline (loop 47's follow-up) | gates only; bound ~2% of the userspace gate |
| JIT: followed calls whose callee completes inside the region (loop 36's follow-up) | bound ~0.5%; exits from inside a followed call as host calls to the pending continuation |
| JIT: entries for loops through calls (loop 37's review finding 5) | count first: a looped forward region's call continuations run interpreted after an unwind |
| Interpreter, loop 19's ideas | cheaper `SWITCH` re-entry; more rich handlers (FMADD, FCVTZS, SIMD&FP LDR/STR register, vector MUL/SUB/CMxx, shifts, permutes); blocks marked rich at run time for hot slow paths (misaligned stores, STTR/LDTR, CASP); count single-MOVI rich blocks |

Left as they are: x86-only (DotProd/JSCVT tuning, `relaxed_trunc`), the OpenSSL MIDR (the user, 2026-11-10: keep
ours for now), bug watches (Firefox's first page, the lost Firefox process), parallel `make` (needs a harness), the
default vCPU count (settings, not a measurement), FEAT_FP16's scalar forms in the f32 shadows (only if FP16 is ever
advertised).
