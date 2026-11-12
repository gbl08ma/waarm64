# Shared folders

A machine sees folders the user shares with it: a folder on the user's computer (File System Access's
`FileSystemDirectoryHandle`) or a folder kept in the browser (OPFS). Like a network connection, a shared folder is
the **browser's**, not the machine's: it keeps its own grant and settings, and machines are attached to it. The guest
reaches every attached folder through **one virtio-9p device** (our 9P2000.L server, [devices.md](devices.md)
"9p"), mounted for it by the page. Built 2026-10-31; numbers and the API's behaviours are in `bench/shares/REPORT.md`.

What it builds on: `web/9p.ts`'s server; the device layer's asynchronous requests (`Backend.concurrent`, remote
disks'); the connections' model, locks and wizard ([networking/adapters.md](networking/adapters.md)); the units the page gives
the guest ([frontend.md](frontend.md) "What the page sets in the guest").

## 1. The rules

1. **Folders are the browser's.** A list kept in this browser (IndexedDB `webpc`, object store `folders`), each one
   of two kinds: [a folder on your computer](ui:folders:FolderWizard.state.host) (a directory handle the user picked or dropped) or **a folder in the
   browser** (a directory in OPFS, `folders/<id>/`). Each has a name and **Read-only**. Machines are attached to
   folders; deleting a folder detaches it from every machine (and, for one in the browser, deletes its files, asked
   first with their size).
2. **A machine has shared folders or not** (`shares: true` in the machine record, left out when off; the shape's
   `devices` lists `9p`, before the disks; new machines on, older ones off so their shapes and snapshots stay). On, the
   machine has one 9p device, tag `webpc`, whatever is attached. Turning it on or off needs the machine off (no hotplug), as a disk or an
   adapter does.
3. **Attaching and detaching don't touch the shape** and are saved at once, running or not: the device's root is a
   directory the server makes, with one entry per attached folder, under the folder's name (made unique with
   ` (2)`… on a clash). A folder attached while the machine runs appears at the root (the guest mounts with
   `cache=none`, so its next `ls` sees it). One detached while the guest holds fids into it makes them answer
   `ESTALE`. Up to 16 folders per machine (`MAX_FOLDERS`; the root is a listing, so this is a UI bound, not a slot).
4. **One writer at a time.** A Web Lock per folder (`webpc-folder:<id>`), taken by a running machine: `shared` for a
   read-only attachment, `exclusive` for a read-write one (the attachment's own Read-only, or the folder's). Several
   machines can read a folder; one can write it, and then none other reads it (a reader would see writes land
   halfway). A machine that wants a held folder is told which machine holds it and offers [Use it here](ui:folders:FoldersMenu.useHere), as the
   connections do (`web/app/locks.ts`, topic `folder`).
5. **The grant is the browser's.** A folder on this computer keeps its handle in IndexedDB. At start, a machine
   checks each attached folder's permission (`queryPermission`); where it isn't granted the folder is left out of the
   root and the page shows **Allow access to *name*** (`requestPermission` needs a click), which adds it while the
   machine runs. Chromium's "allow on every visit" makes this rare. A grant lost while running (the user revoked it)
   turns the folder's requests into `EACCES` and brings the same button back.
6. **The guest's side is set by the page:** with **[Mount shared folders in the guest](ui:machines:FoldersTab.sharesMount)** on (`MachineRecord.sharesMount`,
   default on), a systemd automount at the machine's **mount point** (`MachineRecord.sharesPath`, default
   `/mnt/shared`, left out of the record while it is the default), set per machine because distributions differ on
   what lives under `/mnt` and `/media` (§5). Both are carried by definitions and not in the shape (the guest's disk
   decides what a path means, not the device). Nothing is installed in the guest's disk.

## 2. The folders

### 2.1 The record

`Folder` in `web/app/folders.ts` (DOM-free), IndexedDB `webpc` `folders`: an id (also the lock's name and, for a folder in the
browser, its OPFS directory), the user's name (a picked folder's starts as its directory's name), `kind: 'host' |
'opfs'`, `readOnly`, `handle` (host only), `lastUsed` (what the wizard preselects). A machine record's
`folders: {id, readOnly}[]` are its attachments, in the root's order. A definition (export) carries `shares` and
`sharesMount` and `sharesPath`, never folders (as it carries MACs and no connections).

No ephemeral folders: a host folder's handle has to be kept for its grant to be asked again, and a folder in the
browser is its stored files.

### 2.2 Making one

From **[Shared folders](ui:machines:MachinesPage.folders.heading)** in the list of machines (as **Connections** is) and from the wizard (§4): **A folder on this
computer** (`showDirectoryPicker({mode: 'readwrite'})`, or `'read'` with Read-only ticked first), **A new folder in
the browser** (a name), and a folder **dropped** on the page or on the Machines page
(`DataTransferItem.getAsFileSystemHandle()`: a directory becomes a host folder; files dropped on a folder in the
browser go into it). Chromium refuses some directories (the home directory itself, system ones): its error is
shown as it is.

### 2.3 A folder in the browser's contents

Its card lists the top level with sizes and has [Add files…](ui:folders:FoldersPane.add) (`showOpenFilePicker`, multiple, or a drop), **Copy
into a folder on this computer…** and **Copy from a folder on this computer…** (`showDirectoryPicker`, recursive, with
progress and Cancel), **[Empty](ui:folders:FoldersPane.empty)** (`web/app/folder-files.ts`); `folders/` counts in the storage estimate as OPFS does. Copying through a picked folder replaces an
archive format (no zip writer, no dependency). While a machine writes the folder (its lock is exclusive) the card's
changes are disabled and say which machine has it.

## 3. The server

### 3.1 One server, three trees

`P9Server` (`web/9p.ts`) keeps the protocol (messages, fids, qids, errors) and asks a **tree** for the files. A request
runs as a generator whose `yield` is `await`: a tree that answers at once costs no microtask.
- **memory** (`MemoryTree`): the tests' and Alpine's (`{type: '9p', tag, files}`), synchronous, the one the native twin
  (`core/tests/common/p9.rs`) matches.
- **folders** (`FolderTree`, `web/9p-folders.ts`): the page's (`{type: '9p', tag: 'webpc', folders: [...]}` with the handles, structured-cloned to the
  device worker): the root is the server's own directory (mode 0555, the attached folders' names), and each name is a
  directory handle served by one of two backends:
  - **host**: the asynchronous File System Access API only (`getFile`, `createWritable`, `removeEntry`, `move`,
    `entries`).
  - **opfs**: the same, but files are read and written through `createSyncAccessHandle` (workers only, which the
    device worker is): in place, no swap file.

Requests are asynchronous (the backend's `request` returns a promise; the device is `concurrent`, so realtime
`Devices.poll` doesn't wait on a slow host read). Linux matches replies by tag, so order doesn't matter to the guest;
what does: requests on one file are serialized in the tree (a promise chain per node), and **`Tflush` is answered
after the request it names**. What changes while the machine runs comes over the spec's `port`
(`FoldersToDevice`: attach, detach, a grant given back; `denied` the other way).

### 3.2 What a directory handle can't say, and what the server answers

- **Identity:** no inode numbers. A qid path comes from a map of the node's path, made on first walk and moved by
  renames. Paths are per folder, so two folders can't collide.
- **Owner and mode:** none. Files are 0666 and directories 0777, owned by the uid of the attach (Linux's v9fs attaches
  per user with `access=user`, sending `n_uname`'s uid), so whoever uses the mount owns what's in it. v9fs keeps one owner
  per inode, the last asker's, so on a dentry pinned by one user's cwd another's `ls` changes it: the open modes are why
  access doesn't hang on that. `chmod` is
  kept in memory for the session (so `chmod +x` and then running it works), as is a create's mode (so a compiler's
  output runs) and answered; `chown` and setting times succeed without effect (`cp -p`, `tar`, `rsync` set them and
  would fail otherwise). v9fs takes per-attach owners under `cache=none`: root and `nobody` each see themselves as owner
  (tests/page-folders.test.ts).
- **Times:** a file's `lastModified` (ms); directories have none and answer the folder's attach time.
- **`qid.version`:** a file's from its `lastModified` and size as last seen (QEMU's way), so a change on the host shows
  as a new version to a caching mount; a directory's counts the changes to its entries this tree saw (its own, and what
  a lookup or a readdir found).
- **No symlinks, hard links or device nodes:** `symlink`, `link`, `mknod` answer `EPERM`. Entries that aren't files
  or directories don't appear.
- **Names:** what Chromium refuses answers `EINVAL`. In a folder in the browser that's `/`, `\`, `.` and `..`; a host
  folder refuses more, measured on Linux: `:` in a name, a trailing dot or space, control characters, Windows' device names
  (`nul`, `CON`), `.lnk`, `.url`, `desktop.ini`. A name past 255 bytes (UTF-8, Linux's `NAME_MAX`, what statfs says)
  answers `ENAMETOOLONG` to every call that takes one. A host file with a name past 248 bytes can't be written, its
  swap file's name (`<name>.crswap`) being past 255 (bench/shares/REPORT.md): creating one answers `ENAMETOOLONG`, as
  does opening one to write or truncating it; a rename to such a name works (the file reads), and a directory's name
  takes all 255. On a case-insensitive host, a name differing
  only in case from an existing one `EEXIST` (what the host does).
- **Renames:** `FileSystemFileHandle.move(directory, name)` for files (a host folder refuses `move(name)`), or a copy
  and a remove where a host file has none. Directories
  have no `move()` (Chromium 153): the new tree is made and its files are moved into it, entries not bytes; on a failure
  what moved goes back, and a machine's end in the middle of it leaves the tree split: such a rename isn't atomic. A rename
  from one folder to another, or into or out of the root, is `EXDEV`.
- **Unlinked while open:** a removed file's `File` reads no more, so it keeps its bytes in memory until its last
  clunk, up to 64 MiB (past that its fids answer `ESTALE`).
- **statfs:** a folder in the browser `navigator.storage.estimate()`; a host folder doesn't know, and says 1 TiB free.

### 3.3 Reads and writes on a host folder

- **Reads** take the node's `File` (`getFile()`), kept while the fid is open, and `slice().arrayBuffer()`. A
  `NotReadableError` (the host changed the file) takes a new `File` once and reads again.
- **Writes** go to a **write session per file**: the first write opens `createWritable({keepExistingData: true})`
  (Chromium copies the file into a swap file then), later writes `seek`+`write`, and the session is closed (Chromium
  swaps it in) on the last clunk of a fid writing it, on `Tfsync`, before a snapshot (`Devices.drain`) and at power-off
  (the device worker's `close` waits up to 2.5 s for it). A closed tab loses what wasn't closed, as a pulled plug does. A
  read of a file with a session open reads the `File` with what the session wrote over it (kept up to 64 MiB; past that
  the read closes the session). Truncation is `truncate()` on the session; a truncate to 0 starts a session without
  copying.
- So writing small or whole files is cheap and one write into a big file costs a copy of it (~2 ms/MiB on the M4's VM
  on OPFS, ~1 ms/MiB on a real folder of the desktop's: `bench/shares/REPORT.md`): SQLite databases or disk images on a
  host folder are slow, and the wizard says so. A folder in the browser has no such cost.
- A write that fails ends the session (a stream that errored takes the acknowledged writes with it): the file stays as it
  was, and `EIO` answers later writes and `Tfsync` until the last clunk.
- A session's swap file (`<name>.crswap`) is hidden from listings while it's the session's.
- **Attributes:** `getattr` needs a `getFile()` (size, time): cached per node for 1 s, dropped by the server's own
  writes; a readdir starts its entries' in the background, 32 at a time (5–8× cheaper side by side). A readdir takes the directory's entries once at offset 0 and serves later offsets from that list (its
  offsets are positions in that list, which doesn't change), so the host or the guest changing the directory mid-listing
  doesn't skip or repeat entries.

## 4. The page

- **The Machines page:** a **[Shared folders](ui:machines:MachinePane.tab.folders)** tab per machine: **[Shared folders](ui:machines:FoldersTab.shares)** (the switch: in the shape, so asked
  as Settings' changes are), **[Mount shared folders in the guest](ui:machines:FoldersTab.sharesMount)** and under it **[Mount point](ui:machines:FoldersTab.sharesPath)** (a text field, default
  `/mnt/shared`, checked as typed by `sharesPathError`, §5; on the machine running on this page a change says it takes
  effect at the next start), and the attached folders in order (name, kind,
  Read-only, held by another machine, no permission in this browser; up, down, Detach, Allow…). [Attach a folder…](ui:folders:Folders.attach)
  opens the **Folder wizard** (`FolderWizard.svelte`): the browser's folders first, those in use marked with their
  machine, after [New folder…](ui:folders:FolderWizard.pick.new): the kind, each explained, then its settings (for a folder on the
  user's computer, numbered steps, Read-only then the picker, that end at **[Pick the folder…](ui:folders:FolderWizard.choose)**, and a note on the folders Chromium refuses). **[Shared folders](ui:machines:MachinesPage.folders.heading)** in the list of
  machines is the browser's (§2.2, §2.3), with rename, Read-only, Delete (naming the machines that lose it).
- **The toolbar:** a **Folders** menu while the page's machine has `shares`: each attached folder with its state,
  **Allow access…**, Detach, [Attach a folder…](ui:folders:FoldersMenu.attach) (the wizard), and where the guest finds them (`<mount point>/<name>`).
- **A drop on the page's screen** of a directory offers to attach it to the running machine (and keep it as a folder).
- The transient machine (`?machine=`, `?disk=`) has no folders: it isn't stored, and tests make their own.

## 5. The guest

- **The mount** is units of the page's (`web/app/shares-mount.ts`, SMBIOS credentials, systemd 256+): `<unit>.mount`
  (`What=webpc`, `Where=<mount point>`, `Type=9p`,
  `Options=trans=virtio,version=9p2000.L,cache=none,msize=1048576,access=user,nofail`) and `<unit>.automount`, wanted
  by `remote-fs.target` through a drop-in, so the first access mounts it and a guest without the module or the device
  boots on. systemd creates the mount point if it is missing. Debian 13 loads `9pnet_virtio` from the device's modalias
  (our own kernels have it built in, `images/linux.fragment`). The transport caps `msize` at 512,000 bytes under the
  1 MiB asked (the mount says so).
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

A machine with `shares` saves and restores. The in-memory tree (the tests' and Alpine's) refuses a snapshot: it serves
no feature, so its tree and fids aren't serialized. The server's state for a folders tree is its fids (node, open mode, uid), the nodes seen by folder and path (their
qids and chmods); the write sessions are closed first (`drain`). On restore the nodes are made from their paths and
nothing is asked of the folders until the guest does: a folder detached since, or a path gone, makes those fids answer
`ESTALE` (the guest's open file fails, the mount lives on). A file unlinked while open isn't kept: its fids go stale. A host folder changed
between save and restore is the host's business, as a network share's would be.

## 7. Testing

`tests/folders.test.ts`: the tree's 9P answers in Chromium on OPFS directories, through both backends (the host backend
on OPFS: the asynchronous API alone, `tests/browser/folders-worker.ts`), and over a memory store the records, attachments,
the mount unit (against `systemd-escape`) and the live side. `tests/page-folders.test.ts`: the wizard, the lock between
two tabs, the tab and the pane without a guest; on Debian (`scripts/ci-machines.sh`) the mount, owners, a workload through
both backends (`?sharesasync=<name>` serves a browser's folder through the host backend), a folder attached and one
detached with a file open, another mount point, snapshots; make, gcc and git in a share on the on-demand
`images/debian-tools/build.sh` Debian; a real folder, dropped through CDP, read-only (write permission
can't be granted headless, so a real folder's writes are `bench/shares/index.html`'s, by hand).

## 8. Not built

- An HTTP-served tree (v86's lazy filesystem): read-only images of files; no one has asked.
- virtio-fs: FUSE over virtio needs a FUSE server and, for its speed, DAX windows on shared memory; 9p's server
  exists and the costs above are the browser's, not the protocol's.
- `FileSystemObserver` (the host's changes pushed to the guest): with `cache=none` the guest asks every time.
- xattrs and ACLs (the server has them, `docs/devices.md` "9p"; a directory handle can't keep them, and keeping them in
  memory for the session, as `chmod` is, would lose a `cp -a`'s labels at power-off without a word: they answer
  `EOPNOTSUPP`), POSIX locks between machines (one writer: rule 4).
