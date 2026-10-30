# Shared folders

A machine sees folders the user shares with it: a folder on the user's computer (File System Access's
`FileSystemDirectoryHandle`) or a folder kept in the browser (OPFS). Like a network connection, a shared folder is
the **browser's**, not the machine's: it keeps its own grant and settings, and machines are attached to it. The guest
reaches every attached folder through **one virtio-9p device** (our 9P2000.L server, [devices.md](../devices.md)
"9p"), mounted for it by the page. Proposed 2026-10-30; the user's calls of that day: guest-visible changes are fine,
and the browser's own folders are part of the first build (so the page's model and UI don't need a second design).

What this builds on: `web/9p.ts`, whose server is complete for what Linux's v9fs asks but serves an in-memory tree
(the tests' and Alpine's); the device layer's asynchronous requests (remote disks, `unordered`); the connections'
model, locks and wizard ([network-adapters.md](../network-adapters.md)); the units the page gives the guest
(`web/app/guest-unit.ts`, [frontend.md](../frontend.md) "What the page sets in the guest").

## 1. The rules

1. **Folders are the browser's.** A list kept in this browser (IndexedDB `webpc`, object store `folders`), each one
   of two kinds: **a folder on this computer** (a directory handle the user picked or dropped) or **a folder in the
   browser** (a directory in OPFS, `folders/<id>/`). Each has a name and **Read-only**. Machines are attached to
   folders; deleting a folder detaches it from every machine (and, for one in the browser, deletes its files, asked
   first with their size).
2. **A machine has shared folders or not** (`shares: true` in the machine record and the shape, left out when off,
   as `usb`; new machines on, older ones off so their shapes and snapshots stay). On, the machine has one 9p device,
   tag `webpc`, whatever is attached. Turning it on or off needs the machine off (no hotplug), as a disk or an
   adapter does.
3. **Attaching and detaching don't touch the shape** and are saved at once, running or not: the device's root is a
   directory the server makes, with one entry per attached folder, under the folder's name (made unique with
   ` (2)`… on a clash). A folder attached while the machine runs appears at the root (the guest mounts with
   `cache=none`, so its next `ls` sees it). One detached while the guest holds fids into it makes them answer
   `ESTALE`. Up to 16 folders per machine (`MAX_FOLDERS`; the root is a listing, so this is a UI bound, not a slot).
4. **One writer at a time.** A Web Lock per folder (`webpc-folder:<id>`), taken by a running machine: `shared` for a
   read-only attachment, `exclusive` for a read-write one (the attachment's own Read-only, or the folder's). Several
   machines can read a folder; one can write it, and then none other reads it (a reader would see writes land
   halfway). A machine that wants a held folder is told which machine holds it and offers **Use it here**, as the
   connections do (`net-who`/`net-held`/`net-release` become messages of a kind for folders, `web/app/locks.ts`).
5. **The grant is the browser's.** A folder on this computer keeps its handle in IndexedDB. At start, a machine
   checks each attached folder's permission (`queryPermission`); where it isn't granted the folder is left out of the
   root and the page shows **Allow access to *name*** (`requestPermission` needs a click), which adds it while the
   machine runs. Chromium's "allow on every visit" makes this rare. A grant lost while running (the user revoked it)
   turns the folder's requests into `EACCES` and brings the same button back.
6. **The guest's side is set by the page:** with **Mount shared folders in the guest** on (`MachineRecord.sharesMount`,
   default on), a systemd automount at the machine's **mount point** (`MachineRecord.sharesPath`, default
   `/mnt/shared`, left out of the record while it is the default), set per machine because distributions differ on
   what lives under `/mnt` and `/media` (§5). Both are carried by definitions and not in the shape (the guest's disk
   decides what a path means, not the device). Nothing is
   installed in the guest's disk.

## 2. The folders

### 2.1 The record

`Folder` in `web/app/folders.ts`, IndexedDB `webpc` `folders`: an id (also the lock's name and, for a folder in the
browser, its OPFS directory), the user's name (a picked folder's starts as its directory's name), `kind: 'host' |
'opfs'`, `readOnly`, `handle` (host only), `lastUsed` (what the wizard preselects). A machine record's
`folders: {id, readOnly}[]` are its attachments, in the root's order. A definition (export) carries `shares` and
`sharesMount` and `sharesPath`, never folders (as it carries MACs and no connections).

No ephemeral folders: a host folder's handle has to be kept for its grant to be asked again, and a folder in the
browser is its stored files.

### 2.2 Making one

From **Shared folders** in the list of machines (as **Connections** is) and from the wizard (§4): **A folder on this
computer** (`showDirectoryPicker({mode: 'readwrite'})`, or `'read'` with Read-only ticked first), **A new folder in
the browser** (a name), and a folder **dropped** on the page or on the Machines page
(`DataTransferItem.getAsFileSystemHandle()`: a directory becomes a host folder; files dropped on a folder in the
browser go into it). Chromium refuses some directories (the home directory itself, system ones): its error is
shown as it is.

### 2.3 A folder in the browser's contents

Its card lists the top level with sizes and has **Add files…** (`showOpenFilePicker`, multiple, or a drop), **Copy
into a folder on this computer…** and **Copy from a folder on this computer…** (`showDirectoryPicker`, recursive, with
progress and Cancel), **Empty**, and its size in the storage estimate. Copying through a picked folder replaces an
archive format (no zip writer, no dependency). While a machine writes the folder (its lock is exclusive) the card's
changes are disabled and say which machine has it.

## 3. The server

### 3.1 One server, three trees

`P9Server` keeps the protocol (messages, fids, qids, errors) and asks a **tree** for the files:
- **memory**: today's in-memory tree, unchanged, still the tests' and Alpine's (`{type: '9p', tag, files}`), the one
  the native twin (`core/tests/common/p9.rs`) matches. The refactor moves no step count.
- **folders**: the page's (`{type: '9p', tag: 'webpc', folders: [...]}` with the handles, structured-cloned to the
  device worker): the root is the server's own directory (mode 0555, the attached folders' names), and each name is a
  directory handle served by one of two backends:
  - **host**: the asynchronous File System Access API only (`getFile`, `createWritable`, `removeEntry`, `move`,
    `entries`).
  - **opfs**: the same, but files are read and written through `createSyncAccessHandle` (workers only, which the
    device worker is): in place, no swap file.

Requests become asynchronous (the backend's `request` returns a promise; the device is `unordered`, so realtime
`Devices.poll` doesn't wait on a slow host read). Linux matches replies by tag, so order doesn't matter to the guest;
what does: requests on one file are serialized in the server (a promise chain per node), and **`Tflush` is answered
after the request it names** (today every request completes at once, so it's answered straight away).

### 3.2 What a directory handle can't say, and what the server answers

- **Identity:** no inode numbers. A qid path comes from a map of the node's path, made on first walk and moved by
  renames. Paths are per folder, so two folders can't collide.
- **Owner and mode:** none. Files are 0644 and directories 0755, owned by the uid of the attach (Linux's v9fs attaches
  per user with `access=user`, sending `n_uname`'s uid), so whoever uses the mount owns what's in it. `chmod` is
  kept in memory for the session (so `chmod +x` and then running it works) and answered; `chown` and setting times
  succeed without effect (`cp -p`, `tar`, `rsync` set them and would fail otherwise). Measure first (§7 L0) how v9fs
  takes per-attach owners with `cache=none`; fixed 1000:1000 is the fallback.
- **Times:** a file's `lastModified` (ms); directories have none and answer the folder's attach time.
- **No symlinks, hard links or device nodes:** `symlink`, `link`, `mknod` answer `EPERM`. Entries that aren't files
  or directories don't appear.
- **Names:** what Chromium refuses (`/`, `\`, `.`/`..`, and on Windows its reserved characters) answers `EINVAL`; on
  a case-insensitive host, a name differing only in case from an existing one `EEXIST` (what the host does).
- **Renames:** `FileSystemFileHandle.move()` for files. Moving a directory is either supported by then or done as
  a copy and remove (or `EXDEV`, which `mv` handles by copying itself): §7 L0 decides. A rename from one folder to
  another, or into or out of the root, is `EXDEV`.
- **statfs:** a folder in the browser `navigator.storage.estimate()`; a host folder doesn't know, and says 1 TiB free.

### 3.3 Reads and writes on a host folder

- **Reads** take the fid's `File` (`getFile()`), kept while the fid is open, and `slice().arrayBuffer()`. A
  `NotReadableError` (the host changed the file) takes a new `File` once and reads again.
- **Writes** go to a **write session per file**: the first write opens `createWritable({keepExistingData: true})`
  (Chromium copies the file into a swap file then), later writes `seek`+`write`, and the session is closed (Chromium
  swaps it in) on the last clunk of a fid writing it, on `Tfsync`, before a snapshot (`drain`) and at power-off. A
  read of a file with a session open reads through the session's own bytes (kept as written) over the `File`.
  Truncation is `truncate()` on the session.
- So writing small or whole files is cheap and one write into a big file costs a copy of it: SQLite databases or disk
  images on a host folder are slow, and the docs will say so. A folder in the browser has no such cost.
- **Attributes:** `getattr` needs a `getFile()` (size, time): cached per node for 1 s, dropped by the server's own
  writes. A readdir takes the directory's entries once at offset 0 and serves later offsets from that list (offsets
  are entry indices), so the host changing it mid-listing doesn't skip or repeat entries.

## 4. The page

- **The Machines page:** a **Shared folders** tab per machine: **Shared folders** (the switch: in the shape, so asked
  as Settings' changes are), **Mount shared folders in the guest** and under it **Mount point** (a text field, default
  `/mnt/shared`, checked as typed by `sharesPathError`, §5; on the machine running on this page a change says it takes
  effect at the next start), and the attached folders in order (name, kind,
  Read-only, held by another machine, no permission in this browser; up, down, Detach, Allow…). **Attach a folder…**
  opens the **Folder wizard** (`FolderWizard.svelte`): the browser's folders first, those in use marked with their
  machine, after **New folder…**: the kind, each explained, then its settings. **Shared folders** in the list of
  machines is the browser's (§2.2, §2.3), with rename, Read-only, Delete (naming the machines that lose it).
- **The toolbar:** a **Folders** menu while the page's machine has `shares`: each attached folder with its state,
  **Allow access…**, Detach, **Attach a folder…** (the wizard), and where the guest finds them (`<mount point>/<name>`).
- **A drop on the page's screen** of a directory offers to attach it to the running machine (and keep it as a folder).
- The transient machine (`?machine=`, `?disk=`) has no folders: it isn't stored, and tests make their own.

## 5. The guest

- **The mount** is a unit of the page's (`guestUnit`, SMBIOS credentials, systemd 256+): `<unit>.mount`
  (`What=webpc`, `Where=<mount point>`, `Type=9p`,
  `Options=trans=virtio,version=9p2000.L,cache=none,msize=1048576,access=user,nofail`) and `<unit>.automount`, wanted
  by `remote-fs.target` through a drop-in, so the first access mounts it and a guest without the module or the device
  boots on. systemd creates the mount point if it is missing. Debian 13 and Arch load `9pnet_virtio` from the
  device's modalias (to be checked on both in L5; our own kernels have it built in, `images/linux.fragment`).
- **The mount point** is the machine's (`sharesPath`, default `/mnt/shared`). `<unit>` is its name as systemd escapes
  a path (`systemd-escape --path`: `/mnt/shared` is `mnt-shared`, `/home/me/host files` is `home-me-host\x20files`),
  done by `web/app/shares-mount.ts` `mountUnit` and unit-tested against `systemd-escape`'s outputs. `sharesPathError`
  takes an absolute, normalized path (no `.`, `..`, `//` or trailing `/`; no control characters; at most 255 bytes) and
  refuses `/` and the guest's own trees (`/bin`, `/boot`, `/dev`, `/etc`, `/lib*`, `/proc`, `/run`, `/sbin`, `/sys`,
  `/tmp`, `/usr`, `/var` themselves, and anything under `/dev`, `/proc`, `/sys`); mounting over a directory that has
  files hides them, which the field's note says. The units are read at boot, so a new mount point applies at the next
  start.
- Guests without systemd 256 see the device and mount it by hand: `mount -t 9p -o trans=virtio,version=9p2000.L,cache=none webpc /mnt`.
  The Folders menu says so.

## 6. Snapshots

A machine with `shares` saves and restores (the refusal stays for the in-memory tree only: backlog "9p's state isn't
saved"). The server's state for a folders tree is its fids (folder id, path, open mode), the qid map and the chmods;
the write sessions are closed first (`drain`). On restore the fids are walked again: a folder detached since, or a
path gone, makes those fids answer `ESTALE` (the guest's open file fails, the mount lives on). A host folder changed
between save and restore is the host's business, as a network share's would be.

## 7. Loops

- **L0, measurements and checks:** on OPFS directories in headless Chromium, through both backends: `getattr` over
  5,000 files, a readdir of 5,000, `cp` of 100 MB in and out. On a real host folder: a page under `bench/shares/` the
  user opens once in their Chromium, picks a folder, and gets the JSON (the picker can't be driven headless): the same,
  plus `move()` of a file and a directory, and a write session's cost on a 100 MB and a 1 GB file. Under the dev VM's
  Debian: how v9fs takes per-attach owners with `cache=none` (§3.2). Results in `bench/shares/REPORT.md`; they set
  the attribute cache, directory renames and owners.
- **L1, the server:** `P9Server` over a tree; the memory tree unchanged (native twin, step counts and
  `tests/devices.test.ts` the same); asynchronous requests, per-node ordering, `Tflush` after its request.
- **L2, the folders tree:** the root, both backends, §3's answers, write sessions; tests in Chromium on OPFS
  directories (the host backend run on an OPFS directory through the asynchronous API), including a guest's
  workload: Debian builds a small C project in the share, `git init`/`commit`/`status`, `rm -r`, a rename across folders
  (`EXDEV`).
- **L3, the model:** `folders` store, locks, the machine record (`shares`, `sharesMount`, `folders`), the shape,
  definitions, the worker protocol (attach, detach and grants while running), permissions.
- **L4, the page:** §4 and §2.2–2.3. Page tests with folders in the browser (the wizard, attach while running, the
  lock's Use it here between two tabs, Delete).
- **L5, the guest:** the mount unit; `tests/page-debian.test.ts` (or `ci-machines.sh`'s) reads and writes
  `/mnt/shared/<name>`, then another mount point after a restart, and sees a folder attached while running; Arch's desktop by hand.
- **L6, snapshots:** §6, with a test that saves with a file open for writing and restores into a detached folder.
- **The end:** an out-of-context review of `web/9p.ts` and the folders' code; `scripts/ci.sh`, `ci-debian.sh`,
  `ci-machines.sh`; the outcome into docs (`docs/shares.md`, devices.md "9p", frontend.md) and PLAN.md §3.

## 8. Not now

- An HTTP-served tree (v86's lazy filesystem): read-only images of files; no one has asked.
- virtio-fs: FUSE over virtio needs a FUSE server and, for its speed, DAX windows on shared memory; 9p's server
  exists and the costs above are the browser's, not the protocol's.
- `FileSystemObserver` (the host's changes pushed to the guest): with `cache=none` the guest asks every time.
- xattrs, ACLs, POSIX locks between machines (one writer: rule 4).
