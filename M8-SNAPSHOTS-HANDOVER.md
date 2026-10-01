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

## Delegated work (worktrees under `.claude/worktrees/`, one branch each)

| Piece | Worktree and branch | State |
|---|---|---|
| The file container (`web/snapshot-file.ts`, its tests) | `agent-a85db6430d0a01228` | done there (`461fef4`), reviewed; to merge. One fix to make when merging: the reader's `Input` keeps every consumed chunk until a read ends exactly on a chunk boundary (a GiB file stays in memory): drop consumed chunks as it goes |
| `pause()`/`resume()` (`web/vm.ts`, `web/vcpu-worker.ts`, `tests/pause.test.ts`) | `agent-a923e0b93b2d75ae3` | done there (`411fb2e`), reviewed; to merge (`web/vm.ts` here only changed `ABI`) |
| The LZ codec (`core/src/lz.rs`, committed there as `9c270ee`) and the codec measurement | `agent-a94b900acc0e54167` | done: the report and JSON are in `bench/results/local/codec/` (untracked; to go into `bench/boot/REPORT.md` with the JSON committed). **Decision by measurement: the core's LZ, one worker** (save 0.44 s against deflate's 2.78 s on 304 MB of pages, restore 0.20 s against 0.41 s, file 91 MB against 64 MB); deflate stays readable as codec 1. To merge: `9c270ee`, its exports folded into ABI 30 |

The briefs given to the agents are in `bench/results/local/snapshots-briefs/` (untracked). The
first session died on 2026-10-01 when an uncapped Node test in a worktree took 10 GB (CLAUDE.md
"Cap memory"); its agents were restarted in the same worktrees.

## Notes for the next session

- Delegated work comes back as a branch in a git worktree: review the diff, run `scripts/ci.sh` on
  the merged tree, then commit on `main`.
- Step counts must not move: a VM that is never snapshotted is the machine it was.
