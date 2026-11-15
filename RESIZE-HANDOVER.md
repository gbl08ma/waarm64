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
| 2b | **A two-level map** (the user's OK, 2026-11-14): the overlay's map as leaves of 1,024 entries (4 MiB of disk each) made at a first write, under a top table, in memory and in the `map` file, so both grow with what's written, not the disk's size (the flat map is 4 bytes per 4 KiB block: 1 GiB per TiB in memory, and a write near the end, as GPT's backup header, makes the file that long); leaf before top entry; old maps converted at their first opening (a version in `meta`); opening, compaction, exports and snapshots walk only leaves; `MAX_RESIZE` raised; an I/O A/B in Chromium | done |
| 3 | **The agent's GROW:** GPT and MBR growth, `BLKPG_RESIZE_PARTITION`, online ext4, btrfs, xfs grow; the frames and capability; native tests on image files | done |
| 2c | **The map review's fixes** (a static review after 2b, findings in `bench/results/local/resize/review-overlay-map.md`, local): a restore's overlay over a base that can't read (a disk not a multiple of 4 KiB with its last block written), an interrupted conversion's stale records, a short map read as empty, an interrupted merge's leaked files, a failed compaction's lost free slots, the stored disk's export and `written()` walking leaves; the missing flushes between dependent writes measured, kept if within the floor (else the user's call); one block per call in restore/merge/import to the backlog | done |
| 4 | **GROW from the page:** sent at HELLO for marked disks, the mark cleared on GROWN, the answer shown; a machine definition carrying a grown overlay's size. **No new Debian boot** (the user, 2026-11-15: CI's runtime stays as it is): the grow and `df` ride on an existing ci-machines.sh boot that writes a stored disk in place ("a disk stored in the browser (2)"); the Disks tab's in-place shortcut joins tests/page-resize.test.ts (no guest); ci.sh only cheap tests | done |
| 5 | Out-of-context review of the track's code, then the fix loop | next |
| 6 | Track end: docs settled, the CI scripts (ci.sh, ci-debian.sh --platform, ci-machines.sh), PLAN.md row done, kickoff and handover deleted | |

## State

Loops 1–4 and 2c done. Sizes in the host (docs/machines.md §4.5): an overlay's own size in its `meta` and record, a
stored disk's and a ramdisk's in their record; what the guest sees is `sizeSeen` (web/app/disk-size.ts). The overlay's
map is two-level (docs/devices.md "blk"). The page: `ResizeDisk.svelte` from the Disks pane, the Overlays dialog's rows
and a machine's Disks tab (tests/page-resize.test.ts); web/app/resize.ts does the resize and holds the grow mark
`{ from, to, failed? }` on the overlay's or stored disk's record. The agent (docs/devices.md "A disk grown";
agent/src/grow.rs, table.rs) answers GROW with GROWN.

The page's side (loop 4; devices.md "A disk grown", "The page's side"): `web/app/areas/grow-actions.ts` `GrowActions`,
a follower of each run's link (agent-actions.ts `LinkFollower`): GROW at each HELLO with `CAP.GROW` for the marks
standing then (`growsOf`); each GROWN against the marks then; final answers clear and are said once, NOT_FOUND/NOT_YET
keep silently, FAILED keeps once (`growFailed`) and clears at the second. A definition carries a grown overlay's size
(`overlaySize`; the import makes an empty overlay at it, marked). The end-to-end check rides on page-stored's in-place
boot (ci-machines.sh).

Open: the Overlays dialog's rows show what an overlay holds, not its grown size.
