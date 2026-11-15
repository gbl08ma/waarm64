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
| 2c | **The map review's fixes** (a static review after 2b, findings in `bench/results/local/resize/review-overlay-map.md`, local): a restore's overlay over a base that can't read (a disk not a multiple of 4 KiB with its last block written), an interrupted conversion's stale records, a short map read as empty, an interrupted merge's leaked files, a failed compaction's lost free slots, the stored disk's export and `written()` walking leaves; the missing flushes between dependent writes measured, kept if within the floor (else the user's call); one block per call in restore/merge/import to the backlog | next |
| 4 | **GROW from the page:** sent at HELLO for marked disks, the mark cleared on GROWN, the answer shown; a machine definition carrying a grown overlay's size. **No new Debian boot** (the user, 2026-11-15: CI's runtime stays as it is): the grow and `df` ride on an existing ci-machines.sh boot that writes a stored disk in place ("a disk stored in the browser (2)"); the Disks tab's in-place shortcut joins tests/page-resize.test.ts (no guest); ci.sh only cheap tests |  |
| 5 | Out-of-context review of the track's code, then the fix loop | |
| 6 | Track end: docs settled, the CI scripts (ci.sh, ci-debian.sh --platform, ci-machines.sh), PLAN.md row done, kickoff and handover deleted | |

## State

Loops 1–3 done. Sizes in the host (docs/machines.md §4.5): an overlay's own size in its `meta` and record, a stored
disk's and a ramdisk's in their record; what the guest sees is `sizeSeen` (web/app/disk-size.ts). web/app/resize.ts:
`resizeCosts`, `resize(..., { grow })`, `growMark`/`clearGrowMark`, `sizeNow`, `attachmentTarget`, `MAX_RESIZE`
(8 TiB). The overlay's map is two-level (docs/devices.md "blk"). The page (frontend.md "The Machines page"):
`ResizeDisk.svelte`, opened from the Disks pane, the Overlays dialog's rows and a machine's Disks tab;
tests/page-resize.test.ts. The grow mark `{ from, to }` sits on the overlay's or stored disk's record.

The agent's side (docs/devices.md "A disk grown"; agent/src/grow.rs, agent/src/table.rs) is built: `CAP.GROW` (bit 17)
in the agent's HELLO; the unit has CAP_SYS_RESOURCE (ext4's resize). **The frames loop 4 uses** (web/agent-frame.ts,
pinned by tests/agent.test.ts and agent/src/frame.rs):
- GROW (30), the page's: u8 length + the serial `waarm64-<attachment id>` (the agent matches its first 20 bytes), u64 LE
  the size in bytes the page expects the guest's disk to have (`encodeGrow(serial, size)`).
- GROWN (31), the agent's, once per GROW (a duplicate while one waits or runs gets none of its own): u8 length + the
  serial, u8 `part` (`GROWN_PART`: GROWN 0, NOTHING 1, NOT_FOUND 2, NOT_YET 3, NO_TABLE 4, NOT_LAST 5, BAD_TABLE 6,
  FAILED 7), u8 `fs` (`GROWN_FS`: GROWN 0, NOTHING 1, NOT_MOUNTED 2, UNSUPPORTED 3, STACKED 4, FAILED 5, SKIPPED 6),
  u32 errno, u64 the partition's size (`decodeGrown`). One disk at a time in the guest; a GROWN can arrive on a later
  connection than its GROW's. Which answers clear the mark is loop 4's call (NOT_YET and NOT_FOUND presumably keep it).

Open: a definition carries the disk's size, not a grown overlay's (§4.5 "Not yet"); the Overlays dialog's rows show what
an overlay holds, not its grown size.
