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
| 5 | Out-of-context reviews of the track's code (the agent's GROW, the page's resize), then their fix loops | 5a done |
| 5a | **The agent review's fixes** (findings in `bench/results/local/resize/review-agent-grow.md`, local): a growth within the entry array's sectors (the new backup's entries over the old backup header, no longer zeroed after), a cut run completed (the primary's header repaired from a whole backup with its entries; the backup under the new entries taken as the run's own), the filesystem's ioctl only on the partition's filesystem (st_dev; btrfs's fsid and devid from its superblock), mounts by `major:minor` (`/dev/root`), a GROW that doesn't read answered BAD_REQUEST, ext4's resize under `MemoryMax=32M` measured (no unit change) | done |
| 5b | **The page review's fixes** (findings in `bench/results/local/resize/review-page-resize.md`, local) | next |
| 6 | Track end: docs settled, the CI scripts (ci.sh, ci-debian.sh --platform, ci-machines.sh), PLAN.md row done, kickoff and handover deleted | |

## State

Loops 1–4, 2c and 5a done. Sizes in the host (docs/machines.md §4.5; `sizeSeen`, web/app/disk-size.ts), the two-level
overlay map (docs/devices.md "blk"), the page's Resize… and grow marks (web/app/resize.ts, `ResizeDisk.svelte`,
tests/page-resize.test.ts), GROW from the page (`web/app/areas/grow-actions.ts`; the end-to-end check on
ci-machines.sh's page-stored in-place boot) and the agent's GROW (docs/devices.md "A disk grown"; agent/src/grow.rs,
table.rs: cut runs completed by the next GROW, the filesystem checked to be the partition's, BAD_REQUEST = 8 for a
GROW that doesn't read; the page takes it as a failure). Next: 5b, the page review's findings.

Open: the Overlays dialog's rows show what an overlay holds, not its grown size.
