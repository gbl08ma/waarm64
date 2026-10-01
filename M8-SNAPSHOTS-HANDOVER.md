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
| 1. Core, round-robin | next (orchestrator) |
| 2. Core, parallel | |
| 3. Host, round-robin | |
| 4. The file and the RAM codec | delegated (worktree), independent of 1 to 3 |
| 5. Host, parallel: `pause`/`resume` | the pause itself delegated (worktree); the round trips after 2 and 3 |
| 6. The disk in the file | |
| 7. The page | |
| 8. Suspend | needs the user's OK |
| 9. Exit | |

## Open with the user

Suspend (a local snapshot in OPFS that stops the machine and resumes on the next load); the
version policy (a state format version, not the core build's hash); the wall clock after a resume.
Recommendations are in the plan doc; loops 1 to 7 don't depend on the answers.

## Notes for the next session

- Delegated work comes back as a branch in a git worktree: review the diff, run `scripts/ci.sh` on
  the merged tree, then commit on `main`.
- Step counts must not move: a VM that is never snapshotted is the machine it was.
