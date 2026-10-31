# What a directory handle costs

For shared folders ([docs/shares.md](../../docs/shares.md)). `bench/shares/index.html` runs
`worker.ts` on a directory: picked by hand, or by `run.ts` headless on OPFS and on a real folder of the machine. A
folder dropped through CDP (`Input.dispatchDragEvent`) gives a real `FileSystemDirectoryHandle` with **read** permission:
write permission's prompt can't be answered headless (no CDP permission name for it, `requestPermission` hangs), so a
real folder's writes need the page opened by hand.

## 2026-10-31, a real folder by hand: the x86_64 Linux desktop (`results/2026-10-31-desktop-tmp.json`)

Chromium 153, 16 threads, the page opened by hand with write permission on an empty folder in `/tmp` (its filesystem
wasn't noted: if it's a tmpfs, these costs aren't a disk's). The second of two runs in a row, whose costs came within ~12%
of each other. Another machine than the section below, so its numbers don't compare with that table's.

| | host |
|---|---|
| `getFileHandle`, found / missing | 150 / 130 µs |
| `getFile`, one at a time / 32 at a time | 93 / 24 µs |
| `entries()`, per entry | 20 µs |
| a 4 KiB file: create, write, close | 639 µs |
| a 4 KiB file: `getFile`, read | 333 µs |
| `removeEntry` of a file | 115 µs |
| 100 MiB in / out / over itself | 172 / 326 / 184 ms |
| session, 100 MiB: open, a 4 KiB write, close | 105 ms, 0.40 ms, 7.9 ms |
| session, 1 GiB: open, a 4 KiB write, close | 1,000 ms, 0.36 ms, 70 ms |
| session without `keepExistingData` | 7.5 ms |

A session's opening is linear in the file, ~1 ms/MiB here, and its close grows with it too (~0.07 ms/MiB): the first
write into a 1 GiB file costs a second. The API's answers are the OPFS run's, but for three:

- **`move(name)` is `NotAllowedError` on a real folder; `move(dir, name)`, the server's call, works:** in the same
  directory, across directories, to a new extension, over an existing file (which it replaces). Renames take no copy.
  A session locks a file against it, as in OPFS.
- **A real folder refuses more names than OPFS, on Linux too** (`TypeError`, "Name is not allowed"): `nul`, `CON`,
  `a:b`, `trailing.`, `trailing `, `x.lnk`, `x.url`, `desktop.ini`, a control character. `x.crswap` and `.DS_Store` are
  taken.
- **A file with a name past 248 bytes can't be written:** to 255 bytes the handle is made, but `createWritable` is
  `InvalidStateError` (`<name>.crswap` would be too long); past 255 the handle is too.

## 2026-10-31, the M4's dev VM, Chromium 153.0.8010.52 (`results/2026-10-31-m4-vm.json`)

One session, one run; µs per operation, or ms for 100 MiB read or written in 1 MiB pieces. "Host" is an XFS directory
under the VM. Host write costs weren't measured: they wait for the page to be opened by hand on a real folder.

| | OPFS | host |
|---|---|---|
| `getFileHandle`, found | 196 | 257 |
| `getFileHandle`, missing | 183 | 245 |
| `getFile`, one at a time | 187 | 172 |
| `getFile`, 32 at a time | 35 | 21 |
| `entries()`, per entry | 7.5 | 21 |
| a 4 KiB file: create, write, close | 1,375 | |
| a 4 KiB file: `getFile`, read | 539 | 479 |
| `removeEntry` of a file | 219 | |
| 100 MiB in, `createWritable` | 192 ms | |
| 100 MiB out, `File.slice` | 291 ms | 242 ms |
| 100 MiB in, sync handle | 258 ms | - |
| 100 MiB out, sync handle | 3.4 ms | - |
| sync handle open + close | 530 | - |

The cost of a session on a big file is all in its opening, ~2.1 ms/MiB: `createWritable({keepExistingData: true})`
took 217 ms on 100 MiB and 2,154 ms on 1 GiB; a 4 KiB write in it 0.6 ms, the close 1.6–8.9 ms. Without
`keepExistingData`, 1.5 ms whatever the size.

What these set:
- **The attribute cache stays, 1 s per node.** A `getattr` without it is a `getFile`, 170–190 µs; a walk's lookup is
  as much again. `getFile` runs 5–8× cheaper side by side, so a readdir starts its entries' `getFile`s in the background,
  32 at a time: `ls -l` and `git status` find them cached.
- **Reading OPFS through a sync handle is ~85× faster** than through `File`: a folder in the browser that the machine
  may write reads through its handle.

## How the API behaves (the same run's `behaviour`)

- **No directory `move()`:** only `FileSystemFileHandle` has it. A directory rename makes the new tree and moves its
  files, one `move()` each (entries, not bytes). A file's `move()` replaces an existing target.
- **A locked file can't be moved or removed** (`NoModificationAllowedError`): an open `createWritable` or sync access
  handle has to end first.
- **`File` objects don't outlive their file:** changed, a read fails with `NotReadableError`; removed, with
  `NotFoundError`. So a file unlinked while open can't be read on through the old `File`: the server takes the bytes
  into memory first, up to a bound.
- **`getFile()` works beside a sync handle** and sees its writes; `createWritable` beside one doesn't. Two `read-only`
  sync handles coexist.
- Names: `/`, `\`, `..` are a `TypeError`; in OPFS everything else tried is taken (`nul`, `a:b`, `x.lnk`, control
  characters, 300 bytes); a real folder refuses more (above). `getDirectoryHandle` on a file and `getFileHandle` on a directory are `TypeMismatchError`;
  `removeEntry` on a non-empty directory `InvalidModificationError`.
- `queryPermission` works in a worker. `navigator.storage.estimate()` too.
- Off the record, reading a stored handle back from IndexedDB takes Chromium down (docs/backlog.md "A handle read back
  off the record"); on a disk profile handles round-trip.
