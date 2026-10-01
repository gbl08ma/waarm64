# M8 phase C, snapshots: handover

The lane's plan and design: [docs/plans/snapshots.md](docs/plans/snapshots.md); the ABI's design
note: [docs/abi.md](docs/abi.md) "M8 phase C: snapshots". This file says where the work is.

**Started 2026-10-01.** The user's brief: orchestrate the lane from PLAN.md and the plan doc;
Sonnet subagents allowed for the well-specified parts, the complex parts (the core, the design,
reviews, merges) stay with the orchestrating session.

## Loops (docs/plans/snapshots.md "Loops")

| Loop | State |
|---|---|
| 0. Plan revisited after phase B, ABI 30 design note | done |
| 1. Core, round-robin | done (ABI 30: `core/src/snapshot.rs`, `core/src/vm/state.rs`, each device's `save`/`restore`; native round trips with exact steps) |
| 2. Core, parallel | next (orchestrator): the state already saves both run modes in one form; left are the native thread runner's snapshots, the bare-metal SMP tests, litmus and stress through a restore, ThreadSanitizer, the planted bug |
| 3. Host, round-robin | |
| 4. The file and the RAM codec | done: the container, and the codec by measurement (the core's LZ, one worker); wiring the LZ into the writer as codec 2 is loop 3's |
| 5. Host, parallel: `pause`/`resume` | the pause is done; the round trips after 2 and 3 |
| 6. The disk in the file | |
| 7. The page | |
| 8. Suspend | needs the user's OK |
| 9. Exit | |

## Open with the user

Suspend (a local snapshot in OPFS that stops the machine and resumes on the next load); the
version policy (a state format version, not the core build's hash); the wall clock after a resume.
Recommendations are in the plan doc; loops 1 to 7 don't depend on the answers.

## Delegated work: merged

The file container (`web/snapshot-file.ts`), the LZ codec (`core/src/lz.rs`) and `pause()`/`resume()`
(`web/vm.ts`, `web/vcpu-worker.ts`) were written by Sonnet agents in worktrees, reviewed and merged
(the agents' worktrees `agent-a85db…`, `agent-a923e…`, `agent-a94b9…` under `.claude/worktrees/`
can go; the last holds the RAM dumps the codec was measured on, 3.3 GiB, in its
`bench/results/local/`). The codec's tools are in `bench/results/local/codec/` (untracked), its
numbers in `bench/boot/REPORT.md`. The first session died on 2026-10-01 when an uncapped Node test
in a worktree took 10 GB (CLAUDE.md "Cap memory").

## Notes for the next session

- Delegated work comes back as a branch in a git worktree: review the diff, run `scripts/ci.sh` on
  the merged tree, then commit on `main`.
- Step counts must not move: a VM that is never snapshotted is the machine it was.
