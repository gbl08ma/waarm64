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
| 1 | **Sizes in the host:** an overlay's own size (meta, record), a stored disk's and a ramdisk's grown size, the device worker opening at the size, forks, exports, the shape; the grow mark's storage; `Store` methods for a resize (grow only, its machines off); unit tests | done |
| 2 | **The page:** Resize… in the global Disks pane (stored disk card, overlay rows, ramdisk card) and the machine's Disks tab shortcut; the dialog with the box on; the confirmation (machines, orphaned snapshots); i18n; page tests | done |
| 2b | **A two-level map** (the user's OK, 2026-11-14): the overlay's map as leaves of 1,024 entries (4 MiB of disk each) made at a first write, under a top table, in memory and in the `map` file, so both grow with what's written, not the disk's size (the flat map is 4 bytes per 4 KiB block: 1 GiB per TiB in memory, and a write near the end, as GPT's backup header, makes the file that long); leaf before top entry; old maps converted at their first opening (a version in `meta`); opening, compaction, exports and snapshots walk only leaves; `MAX_RESIZE` raised; an I/O A/B in Chromium | next |
| 3 | **The agent's GROW:** GPT and MBR growth, `BLKPG_RESIZE_PARTITION`, online ext4, btrfs, xfs grow; the frames and capability; native tests on image files | |
| 4 | **GROW from the page:** sent at HELLO for marked disks, the mark cleared on GROWN, the answer shown; a Debian page test (grow, boot, `df`) | |
| 5 | Out-of-context review of the track's code, then the fix loop | |
| 6 | Track end: docs settled, the CI scripts (ci.sh, ci-debian.sh --platform, ci-machines.sh), PLAN.md row done, kickoff and handover deleted | |

## State

Loops 1–2 done. Sizes in the host (docs/machines.md §4.5): an overlay's own size in its `meta` and record, a stored
disk's and a ramdisk's in their record; what the guest sees is `sizeSeen` (web/app/disk-size.ts). web/app/resize.ts:
`resizeCosts`, `resize(..., { grow })`, `growMark`/`clearGrowMark`, `sizeNow`, `attachmentTarget`, `MAX_RESIZE`
(256 GiB: an overlay's map is 4 bytes per 4 KiB in memory). The page (frontend.md "The Machines page"):
`ResizeDisk.svelte`, opened from the Disks pane (stored disk, ramdisk), the Overlays dialog's rows and a machine's
Disks tab; tests/page-resize.test.ts. The grow mark `{ from, to }` sits on the overlay's or stored disk's record:
loop 4 sends GROW at HELLO for it and clears it on GROWN; loop 3 is the agent's side. Open: a definition carries the
disk's size, not a grown overlay's (§4.5 "Not yet"); the Overlays dialog's rows show what an overlay holds, not its
grown size.
