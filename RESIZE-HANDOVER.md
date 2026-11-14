# RESIZE: growing a disk — handover

The brief and the approved design: RESIZE-KICKOFF.md. This file is the current state and plan only.

## How the track is worked

The session is a supervisor: **one subagent at a time** (general-purpose), in the **main checkout** (no worktrees),
each with one loop below; it waits for each to finish, checks its commit, and starts the next. The way of working is
PERF-HANDOVER.md's "How the track is worked" (briefs fresh and neutral, CI alone and waited on inside the subagent's
turn, memory caps, bounded runs, out-of-context reviews, nothing edited in the checkout while a subagent works),
without its measurement part. A loop's finish: its tests, the docs it changes, this file's state, rebased onto
origin/main, committed, pushed.

## Loops

| # | Loop | State |
|---|---|---|
| 1 | **Sizes in the host:** an overlay's own size (meta, record), a stored disk's and a ramdisk's grown size, the device worker opening at the size, forks, exports, the shape; the grow mark's storage; `Store` methods for a resize (grow only, its machines off); unit tests | next |
| 2 | **The page:** Resize… in the global Disks pane (stored disk card, overlay rows, ramdisk card) and the machine's Disks tab shortcut; the dialog with the box on; the confirmation (machines, orphaned snapshots); i18n; page tests | |
| 3 | **The agent's GROW:** GPT and MBR growth, `BLKPG_RESIZE_PARTITION`, online ext4, btrfs, xfs grow; the frames and capability; native tests on image files | |
| 4 | **GROW from the page:** sent at HELLO for marked disks, the mark cleared on GROWN, the answer shown; a Debian page test (grow, boot, `df`) | |
| 5 | Out-of-context review of the track's code, then the fix loop | |
| 6 | Track end: docs settled, the CI scripts (ci.sh, ci-debian.sh --platform, ci-machines.sh), PLAN.md row done, kickoff and handover deleted | |

## State

2026-11-14: the track set up; loop 1 next.
