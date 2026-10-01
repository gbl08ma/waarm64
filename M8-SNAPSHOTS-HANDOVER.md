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
| 2. Core, parallel | done (bare-metal, Buildroot, litmus and stress through snapshots in parallel and round-robin, under TSan too) |
| 3. Host, round-robin | done: `vm.snapshot()`, `BootOptions.restore`, `web/snapshot.ts` (`writeSnapshot`, `readSnapshot`, `runThroughSnapshots`), `web/lz.ts`, backend state; exact steps in Node and Chromium |
| 4. The file and the RAM codec | done: the container, and the codec by measurement (the core's LZ, one worker); wiring the LZ into the writer as codec 2 is loop 3's |
| 5. Host, parallel: `pause`/`resume` | done: the pause, and parallel round trips in Node (Buildroot, litmus and stress on 4) and Chromium (Buildroot on 4) |
| 6. The disk in the file | done: DISK frames through the backends, the overlay replaced by a restore (after a checksum pass over a `File` and the disk's identity check), the hash asked for only when the identity differs |
| 7. The page | next. For it: `writeSnapshot`/`readSnapshot` (`web/snapshot.ts`) do the file; the worker pauses, saves, resumes; a restore needs the previous machine closed (the overlay's lock), `readSnapshot`'s `devices` and `sha256` options, and `saveFlash(overlay, vm.flash())` right after it starts (the restore deleted the copy beside the overlay); decide when the base's SHA-256 is computed for the header (not while paused: cache it beside the overlay) |
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

- **A restore is a TLB flush to the guest.** Step counts through snapshots equal an unbroken run's
  only for guests that never lean on stale TLB entries (Buildroot, Alpine's boot); Alpine's
  userspace benchmark has its own count (`alpine-user-snapshots`), equal to a run with TLB flushes
  at the same steps (docs/platform.md "Snapshots"). A new entry in `tests/steps.txt`, no entry moved.
- A VM with a 9p device refuses a snapshot (its server's tree and fids aren't saved): the page's
  machines have none; the device test and Alpine's test image do.

- Delegated work comes back as a branch in a git worktree: review the diff, run `scripts/ci.sh` on
  the merged tree, then commit on `main`.
- Step counts must not move: a VM that is never snapshotted is the machine it was.
