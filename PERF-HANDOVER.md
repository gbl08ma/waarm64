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
  3. Firefox's pages session (`bench/results/local/interp/ab-pages.sh`, PHASE_S=1) only for changes to cold browser
     code. It is broken as it stands (it points at the old `~/Development/webpc` checkout and a `.webpcsnap`, and
     `target/snapbench/` has no pages snapshot): make one with `bench/gpu/warm-snapshots.sh` first.
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

## Preemption without the budget (the user's decisions, 2026-11-16)

In parallel realtime mode (what the page runs), replace the step budget inside compiled code (the `left` parameter, its
checks on every chain, edge and back-edge, and its bookkeeping) with the cheapest way to tell a vCPU stuck in a hot loop
to stop. Deterministic mode is a testing gadget, not a product feature: realtime may take a very different path even if
the deterministic tests then cover it less.

**Where it starts** (data in `bench/boot/results/perf30/`, bench/boot/REPORT.md "PERF loop 30"): a build with `left` gone
entirely (no checks, no `left -= len`, a constant in transfers; `nobudget.patch`), Chromium 155 on the dev VM, 3 rounds
alternated, no overlap: `jit_mips` (a user-mode loop, no kernel, no IRQs: clean) **5,662 → 6,623 MIPS (+17%)**. Alpine's
boot −5.1% and userspace −12.4% aren't clean: deterministic chunks then miss timer deadlines (46% fewer IRQs, 3.3%
fewer steps). On x64 (the user's concern: 16 GPRs), Alpine's boot's 319 JIT modules through TurboFan (V8 14.6 on both;
x64 under `qemu-x86_64` with Node's x64 build and a Debian amd64 sysroot), per function: instructions −13.4%, frame
memory operands (spills, fills, frame) **−14.1%**; arm64 −8.7% and −5.7%. What realtime counts steps for: the MIPS
readout and counters (`JIT_PUBLISH`), a cheap clock for periodic run-loop work (`TIMER_STEPS`, `BATCH_TIMEOUT`, the
PC sampler's chunk), the bound of a `vm_run_cpu` call, and preemption; only preemption needs `left` in compiled code
(`acc` stays: MIPS at about no cost). What only a chunk boundary sees today: this vCPU's timers, host signals (STOP,
RX, DEVICE), an IRQ line raised by another vCPU or a device, another vCPU's TLBI IS waiting on this one's drain, the
xHCI's tick, the worker's event-loop visit (`yieldMs`) and a parked module install.

**Decisions (binding):**
1. **Parallel SMP in realtime mode only.** Deterministic round-robin and realtime round-robin (Node's runners and
   benchmarks: one thread, its quantum a count anyway) keep the counted path unchanged; `tests/steps.txt` doesn't move
   (if something moves it, stop and ask). Realtime round-robin may follow later only if the counts make it cheap.
2. **The direction to test first: a per-vCPU stop word polled where cycles close**: a region's loop back-edge,
   indirect transfers (the transfer cache and the miss function), backward static chains (target PA ≤ source PA;
   every cycle of direct chains has one). One atomic load from the `Vcpu`, a branch hinted unlikely, no live register.
   Setters: the host signal word (polled or mirrored), `Vm::refresh` raising the vCPU's line, a TLBI IS push to its
   queue, and **a ticker thread** for what has no event (the vCPU's own timer deadline, the event-loop visit, periodic
   work). A cheaper way found by measurement wins; the finding is written either way.
3. **Exact chunk ends aren't kept** in parallel realtime: a chunk may run on until a poll. Bounds: IRQ and timer
   latency no worse than today's (≤ one chunk, ~1 ms of polling), a TLBI IS shootdown never waiting on a looping vCPU
   longer than that, STOP and snapshot pauses as prompt as today.
4. **The ABI:** the exports and host changes the stop word and the ticker need bump `ABI_VERSION`, with the design note
   in docs/abi.md first; approved. Any other host ABI change is asked.
5. **No new dependency.** The x64 tools (Node's official x64 build, Debian trixie's amd64 libc6, libstdc++6,
   libgcc-s1, libatomic1, checksummed) are dev-only downloads, approved; the first loop makes a script that fetches
   them into `target/` and documents it in docs/devenv.md.
6. Memory: none expected; stated next to every speedup.

**How its loops differ from the rest of PERF:** the **x64 static counts** (instructions, frame memory operands, stack
slots per function, one dumped module set compiled by both arms) for every loop that changes compiled code; ranking on
the Mac by the parallel gates (`smp_alpine_jit`, `smp_user_jit_4`) and `jit_mips` where it can run parallel realtime
(else say what ran), Firefox's pages session at the end; latency from tests/baremetal/timer.c and unmask.c and an IPI
round trip, before and after. **Spin tests** in parallel realtime: a vCPU spinning with no exits (EL0 and EL1; a region
loop, indirect transfers, a backward chain cycle) must take a timer IRQ and an IPI, answer a TLBI IS and stop for STOP,
each in bounded time; a planted bug for each poll point and each setter. The deterministic paths' tests (differential,
lockstep, exact-step boots) must not change. CI as for any JIT loop, plus `scripts/ci-debian.sh` for the run loop or
the host, `ci-usb.sh` for the xHCI's tick, `ci-audio.sh` if the ticker shares a thread with sound. Out-of-context
reviews after the ticker's loop and at the block's end. Its entries in the queue are P0-P4.

## State (2026-11-16, after loop 32)

Kept, with numbers in the REPORT entries: SUBS/CMP micro-op kinds (dec_mips +3%); misaligned pair and SIMD&FP loads
inline; the rich FP copy of `hot` per block (FP guest +12-14%); DAIF/DAIFClr/DIT and ISB (outside parallel) inline
(Alpine's boot −1.9%); the JIT's wasm size cuts (−6% wasm) and one budget counter (Lua −1.7%); virgl's `spin` query
poll (glquery 15 → 280 frames/s); FEAT_RDM and FEAT_LRCPC2 advertised; device pages in the TLB and MMIO finished in the
JIT's helper (loops 21-22: a read 0.21 → 0.07 µs, Debian's fw_cfg read of the agent 77 → 45 ms); scalar FP in f32/f64
shadows of the V registers (loops 23-24: the FP guest +8-9%); a flush by VA scans the transfer cache only for fetched
pages (loop 28: 1.8% of flushes scan, 4 KiB a vCPU, the gates −0.5-0.6% within the floor). Loops 21-24 together are
within the gates' noise (loop 25: +0.4%/+0.5%, overlapping rounds). Built but off by default (measured slower): I8MM,
FCMA, FP16, FHM, BF16. Dropped with findings in the docs: slot size/count, the dispatcher in `interpret`, SUBS's carry
as a field, NZCV in a local, ADRP+ADD, misaligned stores, CCMP's kind, LSE2, LSE min/max inline, ISB inline in
parallel, the shared cache's leftovers, the SMP leftovers, a device call compiled into the slow arm (loop 21), sharing
X-register locals against Liftoff's zero-fill (loop 27: at best ~0.4% of the boot; the fills themselves cost ~2.8% of
the boot and ~1.7% of userspace, loop 26, docs/v8.md). Out-of-context reviews after loops 8, 19, 21, 23 and 28, fixed in
loops 9, 20, 22, 24 and 29 (loop 29: a block's transfer cache entries refilled from TLB hits outlived its TLBI;
`Tlb::xblk` now follows a count of the EL's block exec entries, the gates unchanged). Loop 30 (P0): preemption's tools (`tools/x64node.ts`, `bench/jit/dump-modules.ts`, `bench/jit/codestats.ts`, the `diag`
core and `bench/boot/preempt-counts.ts`), the counts and the Mac baseline in its REPORT entry. Loop 31 (P1): parallel SMP's code without `left`, polling a per-vCPU stop word (`acc` against the chunk's steps, 0 from the setters) at the cycle points; the spin tests; numbers in its REPORT entry. Loop 32 (P2): no ticker; a chunk end costs ~0.2 µs (≤~0.5% of the gates), longer chunks lose 2-4% (the timer and compiled modules' installs wait for a chunk end), a run-loop ticker (paced chunks, the compile worker as a setter) didn't beat the steps bound on the Mac; the finding in its REPORT entry and docs/jit.md "No ticker".

## Still open (the queue: the first is next; by expected gain)

| Entry (docs/backlog.md) | Notes |
|---|---|
| **Next:** the out-of-context review of the preemption code (loops 31-32: `jit::emit::poll` and its points, the stop word's setters, the parallel run loop) | a fresh agent, the area and "find real defects" only; its findings to `review/preemption` |
| P3: the review's findings, then what's left of the cost | whether `acc` costs measurably (it bounds the chunk now; loop 32 found no cheaper bound: a chunk end must still come at about 32K steps' pace for the timer and the installs of compiled modules, so dropping `acc` needs its own cost shown first), whether fewer poll points suffice (56-75 polls per 1000 steps measured against loop 30's estimate of 42-52), the poll's form on both hosts (atomic against plain load, `acc < word` against `word == 0`); each kept or dropped by numbers |
| P4: the block's end | Firefox's pages session on the Mac, every CI layer the area names, the final review's findings fixed or filed, docs/jit.md and docs/platform.md describing what exists |
| JIT: host returns that land elsewhere than the call's continuation (loop 28's follow-up, docs/backlog.md) | 10-16% of the userspace phases' host returns reach the miss function with a valid entry; a diagnostic histogram of their PCs first; the guess is a callee taken into a region that leaves it before its RET; cost unmeasured |
| JIT: the core's heap (the decoded blocks' budget, the page index without lists, the untuned constants), the 320 MiB budget session | memory more than speed; measure before building; one loop each |
| JIT: V8's per-function overhead (whether superseded blocks' modules stay alive through siblings) | memory; measure first |
| JIT: counter reads inline in deterministic runs; the gates' timer rate (loop 8) | gates only |
| Interpreter, loop 19's ideas | cheaper `SWITCH` re-entry; more rich handlers (FMADD, FCVTZS, SIMD&FP LDR/STR register, vector MUL/SUB/CMxx, shifts, permutes); blocks marked rich at run time for hot slow paths (misaligned stores, STTR/LDTR, CASP); count single-MOVI rich blocks |
| Firefox's pages session harness (`ab-pages.sh`) | broken since the rename (above); fix it when a loop needs tier 3 |

Left as they are: x86-only (DotProd/JSCVT tuning, `relaxed_trunc`), the OpenSSL MIDR (the user, 2026-11-10: keep
ours for now), bug watches (Firefox's first page, the lost Firefox process), parallel `make` (needs a harness), the
default vCPU count (settings, not a measurement), FEAT_FP16's scalar forms in the f32 shadows (only if FP16 is ever
advertised).
