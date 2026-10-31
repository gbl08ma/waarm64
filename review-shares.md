# Shared folders: static review

Static only: nothing was run and no file in the repo was changed. Line numbers are of the working tree on 2026-10-31.
Claims about the Linux client were checked against `target/images/build/linux-6.18.54`. Claims about Chromium come from
`bench/shares/REPORT.md` or the specs. Where a finding rests on the spec or on a narrow timing window, it says so.

Summary: 24 findings. 1-4 can lose data the guest was told was written, 5-10 break a stated rule or leave wrong state,
11-17 need a less likely trigger, and 18-24 are small.

## High

### 1. Stop gives the write sessions about 1 s, not the 2.5 s the doc promises, then kills the worker
`web/vm.ts:1707`, `web/device-worker.ts:24,52`, `web/app/worker.ts:72-73,124`, `web/app/main.ts:838-842`, docs/shares.md §3.3

The device worker waits up to `CLOSE_MS` (2500 ms) for `drain()`. But `deviceHost.close` resolves after a fixed 1000 ms.
So `shutdown` returns, the machine worker posts `stopped`, and `stop()` calls `r.worker.terminate()`. The device worker
is nested in that worker, so it dies too, and the 2.5 s bound is never reached on this path.

Scenario: a guest has a large file open for writing on a host folder and the user presses Stop. Sessions close one at a
time (`flush`, 9p-folders.ts:182), and Chromium does its work on the swap file in `close()`. If the whole flush takes
more than 1 s, the sessions not yet closed are aborted and those files keep their old contents. Several open files, or
one big one, are enough.

On the guest power-off path (worker.ts:546-548), `state('off')` comes after the same 1 s. The page then drops the folder
locks at main.ts:686 while the device worker may still be landing files (see finding 3).

Fix: make the timeout at vm.ts:1707 and the 3000 ms at main.ts:838 longer than `CLOSE_MS`, ideally derived from one
constant. Consider having `flush` close sessions in parallel, so one slow file doesn't use up the others' time.

### 2. One failed write throws away everything the session already acknowledged, and the fid stays broken
`web/9p-folders.ts:525-528`, `:429`, `:408`, `:745`

A rejected `w.write` (host disk full, `QuotaExceededError`, a grant revoked) errors the `WritableStream`. That comes from
the Streams spec; `REPORT.md` didn't measure it. `n.session` stays set, so:
- every later write on the file fails with the same stored error, even after space is freed
- the eventual `s.w.close()` rejects, `abort()` runs, and the swap file is discarded

Scenario: a guest writes 500 MiB, all acknowledged, then hits ENOSPC on the last piece. It deletes something and
retries. The retry fails, and at clunk the host file reverts to its pre-session bytes. The Tclunk error is ignored by
Linux, so `close()` in the guest reports success with all the data gone. The same applies after Allow access: `granted`
clears `mount.denied`, but the dead session stays.

Fix: on any `w.write` or `w.truncate` failure, take `n.session` down at once and answer an errno that says data was lost,
such as EIO. Make the session's failure sticky until the last clunk, so that `fsync` and later writes report it. For
quota errors, consider checking space before writing, since the stream can't be resumed.

### 3. The folder lock is dropped before the device has let go of the folder
`web/app/folders-live.ts:152-155` (`letGo`), `:207-209` (`release`), `web/9p-folders.ts:162-172`, `:762`

`letGo` posts `{type: 'detach'}` and calls `locks.drop` in the same tick. The device's `detach` is asynchronous: it waits
for earlier calls on every node, closes write sessions and closes sync handles. The lock therefore frees while this
machine is still a writer, which breaks rule 4 ("one writer at a time").

Scenarios:
- **Use it here:** tab B takes the exclusive lock and starts writing. Tab A's session then swaps in, replacing the host
  file with A's copy, so B's landed writes are lost.
- **OPFS:** B's `createSyncAccessHandle` hits A's open handle and the guest gets a spurious EBUSY.
- **Delete:** see finding 5.

`detach` also only covers the nodes known when it started. A node created by a request already queued can open a session
afterwards, and that session outlives the detach.

Fix: have the device confirm over the port (`{type: 'detached', id}`), and drop the lock in `letGo` only after that,
with a bound for a dead device. `release` and `forget` should await it. In `detach`, close whatever is left in
`withSession` and `withSync` for that mount after setting `m.detached`.

## Medium

### 4. Tlcreate with O_RDONLY leaks a writer, so later sessions never close
`web/9p-folders.ts:471`, `:741-745`, `web/9p.ts:459`

`create` sets `n.writers = 1` whatever the flags. `clunk` decrements only if `f.flags` has write access. Linux passes the
open flags straight through (`v9fs_vfs_atomic_open_dotl`, `p9_omode`), so `open(path, O_CREAT|O_RDONLY)` reaches this
case. util-linux `flock` opens its lock file that way, for example.

After that clunk `n.writers` stays at 1 for the rest of the run. A later `echo x >> file` opens, writes and clunks, but
`writers` only returns to 1, so the session stays open and nothing reaches the host. It lands only on an fsync, a rename,
a snapshot or power-off, and a closed tab loses it. The same leak skips the `!n.writers` close at 9p-folders.ts:433.

Fix: `create` takes `flags` and sets `writers = (flags & O_ACCMODE) !== 0 ? 1 : 0`.

### 5. Delete can strand a folder's files for good, and ignores a machine in another tab
`web/app/folders.ts:111-115`, `web/app/folders-page.ts:20-23`, `web/app/FoldersPane.svelte:67-73`, `web/app/store.ts:224-233`

`deleteFolder` detaches the machines and forgets the record first, then removes `folders/<id>`. `removeEntry` fails with
`NoModificationAllowedError` while a sync handle is open (`REPORT.md`). `remove` passes only `NotFoundError`, so the
failure surfaces after the record is gone. `sweep()` doesn't look at `folders/`, so nothing can reach those bytes again;
they count against the quota with no UI to delete them.

Two ways there:
- This tab's machine has a file open: `live.forget` returns before the device closed it (finding 3).
- Another tab's machine has it: `live.mine` is false and `remove()` doesn't check `folders.held`. If no file is open
  there, the removal succeeds and the running guest loses its files with no warning. The confirmation says only "loses
  it".

Fix: refuse or `takeFrom` when the folder is held. Remove the files first and the record after, or make the removal
retryable. Add `folders/` to `sweep()`.

### 6. `orphan` is set before the entry is really gone, so a failed unlink or rename leaves a live file served from memory
`web/9p-folders.ts:618`, `:625-628`, `:672-677`

`drop` and `moveFile` call `orphan()`, which sets `n.orphan`, and only then call `removeEntry` or `move`. If those fail
(`NoModificationAllowedError` from a host lock, `NotAllowedError`, a quota failure in the copy fallback), the node stays
in the tree, not `gone`, with `n.orphan` set. Every path through `read`, `write`, `attrs` and `setSize` prefers the
orphan.

Scenario: the guest has a file open and `rm` gets EBUSY. Its writes then go to the memory copy, succeed, and vanish at
the last clunk. The host file never changes.

Fix: read the bytes into a local value, and assign `n.orphan` only after the removal or move succeeded.

### 7. A directory rename isn't atomic and has no recovery
`web/9p-folders.ts:699-719`

`moveDir` removes the target, moves the files one at a time, and then runs a recursive `removeEntry` on the source. Any
failure in `carry` leaves the tree split between the two names, and the guest gets an error for a rename that partly
happened. Node handles for the moved files then go stale. The target was already deleted.

Stop has the same effect: a rename of a big tree (one `move()` per file) doesn't finish within finding 1's bound, and
the half-moved state is on the user's real disk.

The final `removeEntry(..., {recursive: true})` also deletes anything that appeared in the source after `carry` listed
it. That covers a host process writing there, and a guest create under a directory that wasn't in `subtree(known)`.

Fix: on failure, move what was carried back, best effort. Replace the recursive remove with a non-recursive walk that
removes only what `carry` moved, so unexpected entries surface as an error instead of being deleted. Have a power-off
wait for a rename in progress, or at least state the risk in the doc.

### 8. Changes from another tab never reach a machine running elsewhere
`web/app/folders-live.ts:135`, `:144`, `:162-166`, docs/shares.md rule 3

`attach` and `detach` act on the device only when `machine === this.machine`. Otherwise they only edit the record. The
tab running the machine hears of it through `refresh()`, which doesn't touch `attached`, `served` or the device.

Scenario: on the Machines page in tab B, the user detaches a folder from a machine running in tab A. The record says
detached, yet A's guest keeps reading and writing it and A keeps the lock. Attach likewise does nothing until a restart,
against the doc's "saved at once, running or not", and the tab's note saying the same.

Fix: send a store note (`folder-attachments`, machine id) that the running tab applies through its own `attach` and
`detach`, or have `refresh()` reconcile `attached` against the record.

### 9. Per-attach owners flip on a dentry pinned by another user
`web/9p-folders.ts:566`, docs/shares.md §3.2, `fs/9p/vfs_inode_dotl.c:443-457`

Files answer `uid = f.uid`, so the owner depends on who asks. `v9fs_vfs_getattr_dotl` writes that answer into the shared
inode (`v9fs_stat2inode_dotl`). With `cache=none`, each lookup makes a new inode, which is why the per-user test passes.
But a dentry pinned by a cwd or an open file is reused, and there is no `.permission` for dotl, so `generic_permission`
uses the flipped `i_uid`.

Scenario: a user runs `cd /mnt/shared/proj`, then `sudo ls -la /mnt/shared/proj`. Root's stat of `.` sets `i_uid` to 0.
The directory is 0755, so the user's next `touch x` gets EACCES, until something stats it as that user. Any root job
walking the share (a cron `find`, `updatedb`) does the same to any shell sitting in it.

Fix: make access independent of the owner by answering 0777 for directories and 0666 for files unless chmodded, or
answer one fixed uid. Add a test with one user holding a cwd and root stat'ing it.

### 10. Two records for one directory defeat the lock
`web/app/folders.ts:51-56`, `web/app/main.ts:1457`, `:2055-2058`

Each pick or drop makes a new record with a new id, and the lock is by id. Dropping the same directory twice gives `x`
and `x (2)`. Two machines can then each hold an exclusive lock and write the same files, and one machine can even attach
both, with independent nodes and sessions. Nested picks (`proj` and `proj/src`) have the same effect.

Fix: in `createFolder`, compare with existing host handles through `isSameEntry` and return the existing record. For
nesting, `resolve()` can detect it, at least to warn.

## Lower

### 11. A start that was stopped takes locks and marks the device running with no machine
`web/app/main.ts:749-764`, `web/app/folders-live.ts:84-97`

The success path of `begin` has no `run !== r` check before `holdLock()` and `folders.begin()`, and line 764 returns
without undoing them. `stop()` answers at once when the worker has nothing booting. So Stop during `startDisks` runs
`folders.end()` first, and then `begin` takes every folder lock and sets `port` and `machine`.

Result: the folders stay exclusively held by no machine, the Folders menu shows, and other tabs see them in use, until
the next stop in this tab. The machine lock leaks the same way.

Fix: check `run !== r` before line 760, and call `folders.end()` in the return at line 764.

### 12. A folder that can't be prepared hangs the start
`web/app/main.ts:761`, `web/app/folders-live.ts:119`

`folders.begin` is outside the `try`. If `access.directory` or `queryPermission` rejects, the promise is unhandled, no
`start` message goes out, and the page stays on "Loading" with locks already taken.

Fix: catch per folder in `take` and record a new problem kind, so one bad folder doesn't stop the machine.

### 13. Read-only changed on a held or denied attachment is ignored
`web/app/folders-live.ts:162-166`, `:173`, `:185-187`, `web/app/Folders.svelte:57`

The pane enables Read-only when the attachment has a problem. `setReadOnly` writes the record but not `this.attached`.
`allow` and `useHere` then use the old value.

Scenario: a folder is held by another machine, so the user ticks Read-only to share it and presses Use it here. This
takes the lock exclusively (`shared: false`) and evicts the other machine, which is what the tick was meant to avoid.
The device then gets a writable spec too.

`move` has the same staleness, so the toolbar menu keeps the old order.

Fix: update `this.attached` in `setReadOnly` and `move`.

### 14. Snapshot: `quiesce` drains, then rings, so a request can be in flight at `vm_snapshot_save`
`web/vm.ts:1680-1686`, `:1047-1049`, `web/devices.ts:1033-1035`

`quiesce` sends `drain` first and rings the doorbell after. A request still unread in the ring when the drain finishes
is taken by that poll and left detached, and `drain` isn't run again before `vm_snapshot_save`. `save`'s own `drain`
then completes it into RAM after the state was taken, so the chain is in the saved in-flight list as well.

At restore the core posts it again, and 9P requests aren't idempotent. A Tlcreate answers EEXIST, a Tunlinkat ENOENT,
and a Tlopen counts `opens` and `writers` twice (which then has the effect of finding 4).

The window is narrow: the doorbell usually gets there first, but the two arrive by different task sources on a busy
device worker. Blk writes share the path, but a repeated disk write is harmless.

Fix: ring first, then drain.

### 15. Page operations on a browser folder take no lock, and `held` goes stale
`web/app/folders-live.ts:73-78`, `web/app/FoldersPane.svelte:31,63-66`, `web/app/folder-files.ts:3`, docs/shares.md §2.3

`folder-files.ts` says it runs "on a folder no machine writes (its lock says so)", but nothing takes the lock. `busy()`
reads `folders.held`, which is refreshed only on a store change or a page action, and a machine starting in another tab
doesn't necessarily write a record.

Scenarios: Empty goes ahead on a folder a guest is using, because the card still looks free. Or a machine starts during
a long Copy from…, and both sides then fail on each other's locks (EBUSY in the guest, `NoModificationAllowedError` on
the page).

Fix: hold `folderLock(id)` exclusively for the length of each operation, and refuse if it isn't free.

### 16. `close()` failing leaves a writer unaborted
`web/app/folder-files.ts:34-36`, `:59-61`, `web/9p-folders.ts:692-694`

A failed `w.write` (quota, a source file changed) leaves the stream open. Its lock remains until garbage collection.

Scenario: Copy from… runs out of quota, the user presses Empty, and `removeEntry` fails with
`NoModificationAllowedError`, on a folder nothing is using.

Fix: `try { … } catch { await w.abort(); throw }`.

### 17. A stale size can be cached for 1 s after a session closes
`web/9p-folders.ts:405-408`, `:367`, `:558`

`closeSession` calls `changed(n)` before `await s.w.close()`. A `prefill` `getFile` that starts during the swap sees the
old file with `moved` unchanged, and stores old size and time with a fresh `attrs`. Scenario: `ls -l` runs while another
process finishes writing. The next getattr answers the old size for up to 1 s, and with `cache=none` that is what
`i_size` becomes.

Fix: bump `n.moved` and clear `n.attrs` after the close as well.

## Small

### 18. Root names can differ from the device, or collide
`web/app/folders-live.ts:126`, `:219`, `web/9p-folders.ts:157`, `:166`

A rename while the machine runs changes `views()`, but the device keeps the old name, so the menu names a path the guest
doesn't have. Rename A from `a` to `b`, rename C to `a`, attach C: `root.children.set('a', …)` replaces A's entry. A
later detach of A then runs `root.children.delete('a')`, which removes C.

Fix: `attach` picks a name unique in `root.children`, reports it back, and `detach` deletes only if the entry is
`m.node`.

### 19. Hosts that ignore case (macOS, Windows)
`web/9p-folders.ts:325-335`, `:658-662`, `:691`

`rename foo Foo`: `lookup` makes a second node for the same file, so `t !== n`. In the fallback path, `removeEntry(name)`
then deletes the source itself, and the copy fails: **the file is lost**. This takes a file that `move()` can't move.
The same rename on a directory runs `removeEntry` on the directory itself, which answers ENOTEMPTY or deletes it if
empty.

Fix: test with `isSameEntry` before treating `t` as a target.

### 20. Mount points that pass `sharesPathError` but fail in systemd
`web/app/shares-mount.ts:17-26`, `:48-49`

- `%` in `Where=` is a specifier.
- Trailing whitespace is stripped, so `Where=` no longer matches the unit name.
- A trailing `\` continues the line.
- A short path can escape past the 255-character unit name limit.

The result is silent: no mount and no message. Fix: refuse these, or write `%%`, and check the escaped name's length.

### 21. Snapshot state: dropped fids and unbounded nodes
`web/9p-folders.ts:188-193`, `:231-233`, `:147`

- Fids on a gone or detached node aren't restored, so they answer EBADF rather than the ESTALE of §6.
- `children` is never pruned, so `save` writes every node ever seen with its full path. A `find` over a large tree stays
  in memory and in every snapshot.

Fix: save the fids as dead, and save only nodes with a fid or a chmod. A saved `ids` is enough to keep new qids from
colliding, though a file's qid then changes across a restore.

### 22. Tversion's clunks can fail the mount and count twice
`web/9p.ts:412-413`

A rejected `clunk` makes Tversion answer an error with the fids still in the map, so the next mount clunks them again
and `n.opens` goes negative. After that `!n.opens` is false and nothing closes.

Fix: catch per fid and always clear.

### 23. A failed `statfs` stops the machine
`web/9p-folders.ts:721-728`, `web/9p.ts:376`

It is the one tree call not wrapped by `serial`, so a rejected `estimate()` reaches `failed` as a non-`Err`, is rethrown,
and becomes the device's fatal error. Fix: catch it, and use `max(0, …)` for a quota under usage.

### 24. UI and listing details
- `web/app/FoldersMenu.svelte:18-21`, `web/app/Toolbar.svelte:137`, `web/app/main.ts:763`: the menu remounts with
  `opened = 0`, so once any start has had a problem, every later start in that session opens the menu. Fix: start
  `opened` at `untrack(() => ui.folders.open)` and have `main.ts` raise it after mounting.
- `web/9p-folders.ts:542-548`: `.crswap` is hidden by name alone. A stale swap file makes `rmdir` answer ENOTEMPTY on a
  directory that lists empty. A guest's own `x.crswap` is forgotten at the next readdir, which turns its open fids
  ESTALE.
- `web/app/FoldersPane.svelte:79`: the filter drops empty files without saying so.
- `web/app/FoldersPane.svelte:35,37`: one `entries` serves all cards, so a slow `show` or `refreshOf` can show folder A's
  files under B.

## Checked, no defect found
- Wire layouts of every message handled, including the replies, against the kernel's expectations.
- Tflush ordering. `req_done` ignores a zero-length reply, so `send`'s `return 0` would hang a caller, but a reply can't
  exceed `room` for what the server answers, and the epoch case is a reset.
- `serial` can't deadlock: chains are taken in one step and no body nests a `serial`.
- The `..` walk stops at the root, and `Overlay` arithmetic is correct.
- The tag map isn't deleted late enough to catch a reused tag.
