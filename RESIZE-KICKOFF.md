# RESIZE: growing a disk — kickoff

**The user's brief (2026-11-14)**, in their words, then the design they approved in the same conversation.

> can we add a built-in tool to increase a qcow2's max size? with bonus points if it can resize filesystems too
> (eventually via the agent on the next boot?). This would be accessible for each disk that's writable, in the disks
> section of the machine menu

> the global disks section should allow for resizing disks too, no?

> go, box on by default, mounted filesystems only. use subagents to tackle different loops and monitor them

(A resizing guest of our own, a Buildroot image that only resizes, is the user's idea for later: docs/backlog.md
"A resizing guest of our own". **Not part of any loop.**)

## The approved design

**What has a size.** Writable disks aren't qcow2 files: a qcow2 or raw image is only a read-only base, and a guest's
writes go into an overlay (our sparse 4 KiB-block format in OPFS); a stored disk is that format too (machines.md §4.4).
So growing is:
- **An overlay** (over a URL, file or blank disk) gets a **size of its own**, at least its base's; reads past the base's
  end are zeros. Per overlay, not per disk: overlays are a base's named variants (rule 3), and a blank disk's identity
  holds its size. Kept in its `meta` file (what the device worker reads at its opening) and its IndexedDB record; a
  restore's fork keeps it.
- **A stored disk** (written in place, or under overlays): its record's size grows; an overlay over it is the larger of
  its own size and the disk's.
- **A ramdisk** (empty at every boot): its record's size.
- **Read-only URL and file bases** themselves: no resize (their overlays can grow).
- **Grow only**, never shrink. The machines using it **off** (no capacity change at run time; the size is in the
  shape, so a resize orphans those machines' snapshots, as any shape edit does: rule 7; the confirmation says so).
- **Exports** take the new size (a changes-only qcow2 may be larger than its backing file).

**Where.** **Resize…** on the Machines page's global **Disks** pane: on a stored disk's card (the disk; its overlays
grow with it), on each overlay's row in the Overlays… dialog, on a ramdisk's card. A machine's **Disks** tab has it on
each writable attachment as a shortcut to the same action (its chosen overlay, or its stored disk when written in
place). The confirmation lists every machine that uses it (all must be off: the lock and running check Merge uses) and
the snapshots orphaned across them.

**The guest's side.** The dialog has a box, **on by default**: grow the partition and filesystem at the next start.
The mark (old size, new size) is the resized overlay's or stored disk's, not an attachment's, so whichever machine
boots it next with the agent does it. At the agent's HELLO the page sends GROW with the disk's serial
(`waarm64-<attachment id>`); the agent answers GROWN with what it did and why not; the page clears the mark only then
and shows the answer. The agent, by ioctls (no guest programs, `rustix` only):
1. the disk by its serial (`/sys/block/vd*/serial`);
2. the partition that **ends last** (Debian's p1 ends after p14 and p15), when the new space follows it: GPT (the
   backup header moved to the new end, the entry extended, both CRCs) or MBR (the last primary extended), then
   `BLKPG_RESIZE_PARTITION` (online, mounted or not);
3. the filesystem on it **if mounted** (only mounted filesystems: the user's choice): ext4 `EXT4_IOC_RESIZE_FS`, btrfs
   `BTRFS_IOC_RESIZE` "max", xfs `XFS_IOC_FSGROWFSDATA`;
4. anything else (unmounted, LVM, LUKS, a partition after the free space) left alone, the reason reported.
Its unit has `CAP_SYS_ADMIN`, and `ProtectSystem=strict` leaves `/dev`: no sandbox change expected (to confirm).

**Tests.** The agent's GPT and MBR code natively against image files (Debian's layout among them); sized overlays (reads
past the base, a fork, an export) as unit tests; a page test on Debian: grow, boot, `df` sees it.

**The risk** is writing a mounted root disk's partition table: native tests come first, and the agent touches only a
disk the page marked.
