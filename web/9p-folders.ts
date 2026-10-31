// The folders tree (docs/shares.md): what `P9Server` (web/9p.ts) serves on the page: a root the tree makes, with a
// directory per attached folder, each a `FileSystemDirectoryHandle`, on the user's computer (`host`: the asynchronous API)
// or in OPFS (`opfs`: read and written in place through sync access handles, which is why it runs in a worker).
// `bench/shares/REPORT.md` has the numbers and the API's behaviours this is built around.
//
// A directory handle has no inode numbers, owners, modes or links: a node is made on first sight and keeps its qid
// (moved by renames), files are 0666 and directories 0777, owned by whoever asks (the attach's uid: v9fs keeps one owner
// per inode, the last asker's, so what's allowed can't hang on it), `chmod` lasts while the machine runs. Calls on a node run one at a time, in the order they came (`serial`: a promise chain per node).
//
// A host file is written through a write session: Chromium copies the file into a swap file, and closing swaps it in.
// A session is closed by the last clunk of a fid writing the file, by a Tfsync and by `flush` (a snapshot, a power-off),
// so that a file's writes are one session; what it wrote is kept to read back (`Overlay`).
import { EACCES, EBADF, EBUSY, EEXIST, EINVAL, EIO, EISDIR, ENOENT, ENOSPC, ENOTDIR, ENOTEMPTY, EPERM, EROFS, Err, ESTALE, EXDEV, p9Backend, P9Server, S_IFDIR, S_IFREG, type P9Fid, type P9SetAttr, type P9Stat, type P9StatFs, type P9Tree, type P9Time } from './9p.ts';
import { uniqueName } from './app/shape.ts';
import type { Ctx } from './devices.ts';

/** A folder as a machine gets it (web/app/folders.ts): its name at the root is the page's, unique. */
export type FolderSpec = { id: string; name: string; kind: 'host' | 'opfs'; readOnly: boolean; handle: FileSystemDirectoryHandle };
/** What the page tells a running device (`P9Spec.port`) and what it hears back. */
export type FoldersToDevice = { type: 'attach'; folder: FolderSpec } | { type: 'detach'; id: string } | { type: 'granted'; id: string };
export type FoldersFromDevice = { type: 'denied'; id: string } | { type: 'detached'; id: string };

/** A snapshot's state (docs/shares.md §6): the nodes seen (their qids and chmods), by folder and path, and the fids. */
export type FoldersState = {
  ids: number;
  nodes: { folder?: string; path: string[]; dir: boolean; id: number; mode?: number }[];
  /** `stale`: a fid of something gone (a directory or not): it answers ESTALE. */
  fids: { fid: number; node: number; uid: number; flags?: number; stale?: { dir: boolean } }[];
};

type Sync = { read(b: Uint8Array, o: { at: number }): number; write(b: Uint8Array, o: { at: number }): number; truncate(n: number): void; flush(): void; close(): void; getSize(): number };
type SyncFile = FileSystemFileHandle & { createSyncAccessHandle(o: { mode: string }): Promise<Sync> };
type Entries = FileSystemDirectoryHandle & { entries(): AsyncIterable<[string, FileSystemHandle]> };
type Moving = FileSystemFileHandle & { move?(dir: FileSystemDirectoryHandle, name: string): Promise<void> };

const O_ACCMODE = 3;
const O_TRUNC = 0o1000;
/** How long a walk or a getattr trusts what it was last told, ms (a `getFile` or `getFileHandle` is ~200 µs). */
const TRUST_MS = 1000;
/** A readdir's background `getFile`s: at most so many entries, this many at a time (bench/shares/REPORT.md: 5–8× cheaper side by side). */
const PREFILL = 16384;
const PREFILL_WIDTH = 32;
/** What of a session's writes is kept to read back, bytes: past it, a read closes the session. */
const OVERLAY_MAX = 64 << 20;
/** The most a file unlinked while open keeps in memory, bytes: a bigger one answers ESTALE. */
const ORPHAN_MAX = 64 << 20;
/** A host folder doesn't know its free space: 1 TiB, in 4 KiB blocks. */
const HOST_BLOCKS = 2 ** 28;

/** A file's write session (`createWritable`). `base`: the bytes of the file below it that still count. */
type Session = { w: FileSystemWritableFileStream; size: number; base: number; overlay: Overlay };

/** What a session wrote, by offset without overlaps, until there's too much of it (`lost`: a read closes the session instead). */
class Overlay {
  private parts: { off: number; data: Uint8Array }[] = [];
  private bytes = 0;
  lost = false;

  /** Keeps [off, off + data) over what was there. */
  write(off: number, data: Uint8Array) {
    if (this.lost) return;
    const end = off + data.length;
    const last = this.parts.at(-1);
    if (!last || last.off + last.data.length <= off) this.parts.push({ off, data });
    else {
      this.cut(off, end);
      const k = this.parts.findIndex((p) => p.off >= end);
      this.parts.splice(k < 0 ? this.parts.length : k, 0, { off, data });
    }
    this.bytes += data.length;
    if (this.bytes > OVERLAY_MAX) [this.lost, this.parts] = [true, []];
  }

  /** Drops what is in [from, to). */
  cut(from: number, to = Infinity) {
    this.parts = this.parts.flatMap((p) => {
      const end = p.off + p.data.length;
      if (end <= from || p.off >= to) return [p];
      this.bytes -= Math.min(end, to) - Math.max(p.off, from);
      return [
        ...(p.off < from ? [{ off: p.off, data: p.data.subarray(0, from - p.off) }] : []),
        ...(end > to ? [{ off: to, data: p.data.subarray(to - p.off) }] : []),
      ];
    });
  }

  /** Copies what it has of [off, off + out.length) over `out`. */
  over(off: number, out: Uint8Array) {
    for (const p of this.parts) {
      const [from, to] = [Math.max(off, p.off), Math.min(off + out.length, p.off + p.data.length)];
      if (from < to) out.set(p.data.subarray(from - p.off, to - p.off), from - off);
    }
  }
}

type Mount = { spec: FolderSpec; node: FNode; time: P9Time; detached: boolean; denied: boolean };

type FNode = {
  id: number;
  name: string;
  parent: FNode;
  dir: boolean;
  /** The folder it is in; undefined: the root. */
  mount?: Mount;
  /** The entries seen so far. */
  children?: Map<string, FNode>;
  handle?: FileSystemHandle;
  /** When a lookup or a readdir last saw it, `performance.now()`. */
  seen: number;
  /** What `chmod` or a create said; undefined: the default. */
  mode?: number;
  /** The last call on this node: the next one starts after it. */
  chain: Promise<unknown>;
  /** The attributes, and when they were read (-Infinity: not to be trusted). `moved` counts changes, so that a late background read is dropped. */
  size: number;
  mtime: number;
  attrs: number;
  moved: number;
  /** Fids open on it, and those writing. */
  opens: number;
  writers: number;
  /** A host file's `File`, while open. */
  file?: File;
  session?: Session;
  sync?: Sync;
  /** A write failed: what the session held is lost, and this says so (EIO) until the last clunk. */
  broken?: boolean;
  /** Removed; with `orphan`, it was open and lives on in memory until the last clunk. */
  gone?: boolean;
  orphan?: { data: Uint8Array; size: number };
};

/** Writes `blob` as the whole of the file. */
export async function putFile(h: FileSystemFileHandle, blob: Blob) {
  const w = await h.createWritable();
  await w.write(blob).then(() => w.close()).catch(async (e) => { await w.abort().catch(() => {}); throw e; });
}

const named = (e: unknown, name: string) => (e as Error | undefined)?.name === name;
const secs = (ms: number): P9Time => [Math.floor(ms / 1000), (ms % 1000) * 1e6];

export class FolderTree implements P9Tree<FNode> {
  readonly root: FNode;
  private ids = 0;
  private mounts = new Map<string, Mount>();
  private withSession = new Set<FNode>();
  private withSync = new Set<FNode>();
  private denied: (id: string) => void;

  constructor(folders: FolderSpec[], denied: (id: string) => void = () => {}) {
    this.denied = denied;
    this.root = this.node('', undefined, undefined, true);
    this.root.parent = this.root;
    for (const f of folders) this.attach(f);
  }

  private node(name: string, parent: FNode | undefined, mount: Mount | undefined, dir: boolean): FNode {
    return { id: ++this.ids, name, parent: parent!, dir, mount, seen: performance.now(), chain: Promise.resolve(), size: 0, mtime: 0, attrs: -Infinity, moved: 0, opens: 0, writers: 0, ...(dir ? { children: new Map() } : {}) };
  }

  /** Adds a folder at the root. */
  attach(spec: FolderSpec) {
    const m: Mount = { spec, node: undefined!, time: secs(Date.now()), detached: false, denied: false };
    const name = uniqueName(spec.name, this.root.children!.keys());
    m.node = this.node(name, this.root, m, true);
    m.node.handle = spec.handle;
    this.mounts.set(spec.id, m);
    this.root.children!.set(name, m.node);
    return m;
  }

  /** Takes a folder from the root: what it wrote lands, and its fids answer ESTALE. */
  async detach(id: string) {
    const m = this.mounts.get(id);
    if (!m) return;
    this.mounts.delete(id);
    this.root.children!.delete(m.node.name);
    const nodes = this.subtree(m.node);
    await this.serial(nodes, async () => {
      m.detached = true; // what comes from here answers ESTALE
      const rest = [...this.withSession, ...this.withSync].filter((n) => n.mount === m); // made while this waited, too
      for (const n of new Set([...nodes, ...rest])) await this.quiet(n).catch(() => {});
    });
  }

  /** The user gave a denied folder's permission back. */
  granted(id: string) {
    const m = this.mounts.get(id);
    if (m) m.denied = false;
  }

  /** Lands what's written (write sessions, a snapshot's and a power-off's). */
  async flush() {
    await Promise.all([...this.withSession].map((n) => this.serial([n], () => this.closeSession(n)).catch(() => {})));
  }

  /** What a snapshot keeps: `flush` ran, so no session is open. A file removed while open isn't kept: its fids answer ESTALE. */
  save(fids: Map<number, P9Fid<FNode>>): FoldersState {
    const nodes: FoldersState['nodes'] = [];
    const used = new Set([...fids.values()].map((f) => f.node));
    const walk = (n: FNode, folder: string | undefined, path: string[]) => {
      if (n === this.root || n === n.mount?.node || used.has(n) || n.mode !== undefined) nodes.push({ folder, path, dir: n.dir, id: n.id, ...(n.mode === undefined ? {} : { mode: n.mode }) });
      for (const [name, c] of n.children ?? []) walk(c, c.mount?.spec.id, c === c.mount?.node ? [] : [...path, name]);
    };
    walk(this.root, undefined, []);
    const stale = (n: FNode) => n.gone || n.mount?.detached;
    return { ids: this.ids, nodes, fids: [...fids].map(([fid, f]) => ({ fid, node: f.node.id, uid: f.uid, ...(f.flags === undefined ? {} : { flags: f.flags }), ...(stale(f.node) ? { stale: { dir: f.node.dir } } : {}) })) };
  }

  /**
   * The state of a snapshot, into this tree of the folders attached now. The nodes are made from their paths and nothing
   * is asked of the folders yet: a path gone answers ESTALE when it's used, and so does all of a folder detached since.
   * Fids are filled into `fids`. A fid's file opens again at its next read or write.
   */
  restore(s: FoldersState, fids: Map<number, P9Fid<FNode>>) {
    const byId = new Map<number, FNode>([[s.nodes[0].id, this.root]]);
    this.root.id = s.nodes[0].id;
    this.ids = Math.max(this.ids, s.ids);
    const gone = new Map<string, Mount>();
    const mountOf = (id: string) => {
      const live = this.mounts.get(id);
      if (live) return live;
      if (!gone.has(id)) {
        const m: Mount = { spec: { id, name: '', kind: 'opfs', readOnly: false, handle: undefined! }, node: undefined!, time: secs(0), detached: true, denied: false };
        m.node = this.node('', this.root, m, true);
        gone.set(id, m);
      }
      return gone.get(id)!;
    };
    const fresh = new Set(this.mounts.values());
    for (const x of s.nodes.slice(1)) {
      const m = mountOf(x.folder!);
      let n = m.node;
      for (const [k, name] of x.path.entries()) {
        const dir = k < x.path.length - 1 || x.dir;
        let c = n.children!.get(name);
        if (!c) n.children!.set(name, (c = this.node(name, n, m, dir)));
        n = c;
      }
      fresh.delete(m);
      [n.id, n.mode, n.seen] = [x.id, x.mode, -Infinity];
      byId.set(x.id, n);
    }
    for (const m of fresh) m.node.id = ++this.ids; // attached since: their first ids may be taken
    for (const f of s.fids) {
      let node = byId.get(f.node);
      if (f.stale) {
        node = this.node('', this.root, undefined, f.stale.dir);
        node.gone = true;
      }
      if (!node) continue;
      fids.set(f.fid, { node, uid: f.uid, flags: f.flags });
      if (f.flags !== undefined && !node.dir) {
        node.opens++;
        if ((f.flags & O_ACCMODE) !== 0) node.writers++;
      }
    }
  }

  /** The machine's end: its files are let go of at once (the next machine opens them). */
  close() {
    for (const n of this.withSync) this.closeSync(n);
  }

  /** The node and all it has inside, as far as they are known. */
  private subtree(n: FNode): FNode[] {
    return [n, ...[...n.children?.values() ?? []].flatMap((c) => this.subtree(c))];
  }

  /** Runs `f` after every earlier call on `nodes` (taken in one step, so two calls can't wait for each other). */
  private serial<T>(nodes: FNode[], f: () => T | Promise<T>): Promise<T> {
    const p = (nodes.length === 1 ? nodes[0].chain : Promise.all(nodes.map((n) => n.chain))).then(f);
    const tail = p.catch(() => {});
    for (const n of nodes) n.chain = tail;
    return p.catch((e) => { throw this.err(nodes[0], e); });
  }

  /** `serial` for a fid's file: gone from under it, it answers ESTALE (a new walk says ENOENT). */
  private opened<T>(n: FNode, f: () => Promise<T>) {
    return this.serial([n], () => f().catch((e) => { throw named(e, 'NotFoundError') ? new Err(ESTALE) : e; }));
  }

  /** The file's session is lost to a failed write: the stream is dead, and acknowledged writes went with it. */
  private async lostSession(n: FNode) {
    const s = n.session;
    [n.session, n.file, n.broken] = [undefined, undefined, true];
    this.withSession.delete(n);
    this.changed(n);
    await s?.w.abort().catch(() => {});
  }

  /** A browser's error as Linux's. */
  private err(n: FNode, e: unknown): Err {
    if (e instanceof Err) return e;
    if (named(e, 'NotAllowedError') && n.mount) {
      if (!n.mount.denied) this.denied(n.mount.spec.id);
      n.mount.denied = true;
      return new Err(EACCES);
    }
    const errno = named(e, 'NotFoundError') ? ENOENT : named(e, 'TypeMismatchError') ? ENOTDIR : named(e, 'InvalidModificationError') ? ENOTEMPTY
      : named(e, 'NoModificationAllowedError') ? EBUSY : named(e, 'QuotaExceededError') ? ENOSPC : named(e, 'SecurityError') ? EACCES : named(e, 'TypeError') ? EINVAL : EIO;
    return new Err(errno);
  }

  /** The node can be used: throws what it answers otherwise. */
  private live(n: FNode) {
    if (n.mount?.detached || (n.gone && !n.orphan)) throw new Err(ESTALE);
    if (n.mount?.denied) throw new Err(EACCES);
  }

  private writable(n: FNode) {
    this.live(n);
    if (!n.mount) throw new Err(EACCES); // the root is the server's
    if (n.mount.spec.readOnly) throw new Err(EROFS);
  }

  private async dirHandle(n: FNode): Promise<FileSystemDirectoryHandle> {
    n.handle ??= await (await this.dirHandle(n.parent)).getDirectoryHandle(n.name);
    return n.handle as FileSystemDirectoryHandle;
  }

  private async fileHandle(n: FNode): Promise<FileSystemFileHandle> {
    n.handle ??= await (await this.dirHandle(n.parent)).getFileHandle(n.name);
    return n.handle as FileSystemFileHandle;
  }

  /** `name` removed behind our back. */
  private forget(d: FNode, name: string) {
    const c = d.children!.get(name);
    if (c) c.gone = true;
    d.children!.delete(name);
  }

  /** Asks the directory for `name`: a file or a directory, whichever it was last. */
  private async lookup(d: FNode, name: string): Promise<FNode | undefined> {
    const h = await this.dirHandle(d);
    const c = d.children!.get(name);
    const get = (dir: boolean): Promise<FileSystemHandle> => (dir ? h.getDirectoryHandle(name) : h.getFileHandle(name));
    let found: FileSystemHandle;
    try {
      found = await get(!!c?.dir).catch((e) => { if (named(e, 'TypeMismatchError')) return get(!c?.dir); throw e; });
    } catch (e) {
      if (named(e, 'TypeError')) return undefined; // not a name a folder can have
      if (!named(e, 'NotFoundError')) throw e;
      this.forget(d, name);
      return undefined;
    }
    return this.seen(d, name, found);
  }

  /** The node of `name`, seen as `h` now. */
  private seen(d: FNode, name: string, h: FileSystemHandle) {
    const dir = h.kind === 'directory';
    let c = d.children!.get(name);
    if (c && c.dir !== dir) {
      this.forget(d, name);
      c = undefined;
    }
    if (!c) d.children!.set(name, (c = this.node(name, d, d.mount, dir)));
    c.handle ??= h;
    c.seen = performance.now();
    return c;
  }

  id(n: FNode) { return n.id; }
  type(n: FNode) { return n.dir ? S_IFDIR : S_IFREG; }

  walk(d: FNode, name: string): FNode | undefined | Promise<FNode | undefined> {
    if (!d.dir) return undefined;
    if (name === '.') return d;
    this.live(d);
    if (name === '..') return d.parent;
    const c = d.children!.get(name);
    if (!d.mount) return c; // the root's entries are the attachments
    if (c && performance.now() - c.seen < TRUST_MS) return c;
    return this.serial([d], () => this.lookup(d, name));
  }

  /** The file's size and modification time, ms. */
  private async attrs(n: FNode): Promise<{ size: number; mtime: number }> {
    if (n.orphan) return { size: n.orphan.size, mtime: n.mtime };
    if (n.session) return { size: n.session.size, mtime: n.mtime };
    if (n.sync) return { size: n.sync.getSize(), mtime: n.mtime || Date.now() };
    if (performance.now() - n.attrs < TRUST_MS) return n;
    const file = await this.file(n);
    if (n.opens) n.file = file;
    return n;
  }

  /** A new `File`: the file as it is now. */
  private async file(n: FNode) {
    const moved = n.moved;
    const file = await (await this.fileHandle(n)).getFile();
    if (moved === n.moved) [n.size, n.mtime, n.attrs] = [file.size, file.lastModified, performance.now()];
    return file;
  }

  private changed(n: FNode) {
    n.moved++;
    n.attrs = -Infinity;
    n.mtime = Date.now();
  }

  private async useSync(n: FNode) {
    if (n.sync) return n.sync;
    if (!n.mtime) await this.file(n); // a sync handle has no time
    const mode = n.mount!.spec.readOnly ? 'read-only' : 'readwrite';
    n.sync = await (await this.fileHandle(n) as SyncFile).createSyncAccessHandle({ mode });
    this.withSync.add(n);
    return n.sync;
  }

  private closeSync(n: FNode) {
    if (!n.mount?.spec.readOnly) n.sync?.flush();
    n.sync?.close();
    n.sync = undefined;
    this.withSync.delete(n);
  }

  private async useSession(n: FNode, keep: boolean) {
    if (n.session) return n.session;
    const size = keep ? (await this.attrs(n)).size : 0;
    const w = await (await this.fileHandle(n)).createWritable({ keepExistingData: keep });
    n.session = { w, size, base: size, overlay: new Overlay() };
    this.withSession.add(n);
    return n.session;
  }

  private async closeSession(n: FNode) {
    const s = n.session;
    if (!s) return;
    [n.session, n.file] = [undefined, undefined];
    this.withSession.delete(n);
    this.changed(n);
    await s.w.close().catch(async (e) => { await s.w.abort().catch(() => {}); throw e; }).finally(() => this.changed(n)); // the size read during the swap is the old one
  }

  /** Lets go of the file: what would lock it against a move or a remove. */
  private async quiet(n: FNode) {
    await this.closeSession(n);
    this.closeSync(n);
    n.file = undefined;
  }

  private async setSize(n: FNode, size: number) {
    if (n.orphan) {
      this.resizeOrphan(n, size);
      n.orphan.data.fill(0, size, n.orphan.size);
      n.orphan.size = size;
    } else if (n.mount!.spec.kind === 'opfs') {
      const s = await this.useSync(n);
      s.truncate(size);
      if (!n.opens) this.closeSync(n);
    } else {
      if (n.broken) throw new Err(EIO);
      const s = await this.useSession(n, size > 0);
      await s.w.truncate(size).catch(async (e) => { await this.lostSession(n); throw e; });
      s.size = size;
      s.base = Math.min(s.base, size);
      s.overlay.cut(size);
      if (!n.writers) await this.closeSession(n);
    }
    this.changed(n);
  }

  private resizeOrphan(n: FNode, size: number) {
    const o = n.orphan!;
    if (size <= o.data.length) return;
    if (size > ORPHAN_MAX) throw new Err(ENOSPC);
    const d = new Uint8Array(Math.max(size, o.data.length * 2));
    d.set(o.data.subarray(0, o.size));
    o.data = d;
  }

  open(f: P9Fid<FNode>, flags: number) {
    const n = f.node;
    const write = (flags & O_ACCMODE) !== 0;
    if (n.dir) {
      if (write) throw new Err(EISDIR);
      this.live(n);
      return;
    }
    return this.serial([n], async () => {
      if (write) this.writable(n);
      else this.live(n);
      if (flags & O_TRUNC && write) await this.setSize(n, 0);
      n.opens++;
      if (write) n.writers++;
    });
  }

  create(f: P9Fid<FNode>, name: string, flags: number, mode: number) {
    const d = f.node;
    this.writable(d);
    return this.serial([d], async () => {
      if (await this.lookup(d, name)) throw new Err(EEXIST);
      const h = await (await this.dirHandle(d)).getFileHandle(name, { create: true });
      const n = this.seen(d, name, h);
      [n.mode, n.size, n.mtime, n.attrs, n.opens, n.writers] = [S_IFREG | (mode & 0o7777), 0, Date.now(), performance.now(), 1, (flags & O_ACCMODE) !== 0 ? 1 : 0];
      return n;
    });
  }

  read(f: P9Fid<FNode>, off: number, count: number) {
    const n = f.node;
    if (n.dir) throw new Err(EISDIR);
    return this.opened(n, async () => {
      this.live(n);
      if (n.orphan) return n.orphan.data.subarray(Math.min(off, n.orphan.size), Math.min(off + count, n.orphan.size));
      if (n.mount!.spec.kind === 'opfs') {
        const s = await this.useSync(n);
        const out = new Uint8Array(Math.max(0, Math.min(count, s.getSize() - off)));
        if (out.length) s.read(out, { at: off });
        if (!n.opens) this.closeSync(n);
        return out;
      }
      if (n.session?.overlay.lost) await this.closeSession(n);
      const s = n.session;
      if (!s) return this.slice(n, off, off + count);
      const out = new Uint8Array(Math.max(0, Math.min(count, s.size - off)));
      if (off < s.base) out.set(await this.slice(n, off, Math.min(off + out.length, s.base)));
      s.overlay.over(off, out);
      return out;
    });
  }

  /** The bytes of the file as it is on disk. */
  private async slice(n: FNode, from: number, to: number): Promise<Uint8Array> {
    const file = n.file ?? await this.file(n);
    if (n.opens) n.file = file;
    const take = async (x: File) => new Uint8Array(await x.slice(from, to).arrayBuffer());
    return take(file).catch(async (e) => {
      if (!named(e, 'NotReadableError')) throw e;
      n.file = await this.file(n); // the host changed it
      return take(n.file);
    });
  }

  write(f: P9Fid<FNode>, off: number, data: Uint8Array) {
    const n = f.node;
    if (n.dir) throw new Err(EISDIR);
    if (f.flags === undefined || (f.flags & O_ACCMODE) === 0) throw new Err(EBADF);
    return this.opened(n, async () => {
      this.writable(n);
      if (n.orphan) {
        const end = off + data.length;
        this.resizeOrphan(n, end);
        n.orphan.data.set(data, off);
        n.orphan.size = Math.max(n.orphan.size, end);
      } else if (n.mount!.spec.kind === 'opfs') {
        (await this.useSync(n)).write(data, { at: off });
      } else {
        if (n.broken) throw new Err(EIO);
        const s = await this.useSession(n, true);
        await s.w.write({ type: 'write', position: off, data: data as Uint8Array<ArrayBuffer> }).catch(async (e) => { await this.lostSession(n); throw e; });
        s.size = Math.max(s.size, off + data.length);
        s.overlay.write(off, data);
      }
      this.changed(n);
    });
  }

  entries(f: P9Fid<FNode>, off: number) {
    const d = f.node;
    if (off > 0 && f.list) return f.list;
    return this.serial([d], async () => {
      this.live(d);
      const dots: [string, FNode][] = [['.', d], ['..', d.parent]];
      if (!d.mount) return (f.list = [...dots, ...d.children!]);
      const seen = new Set<string>();
      for await (const [name, h] of (await this.dirHandle(d) as Entries).entries()) {
        if (name.endsWith('.crswap') && d.children!.get(name.slice(0, -'.crswap'.length))?.session) continue; // a write session's swap file
        seen.add(name);
        this.seen(d, name, h);
      }
      for (const name of [...d.children!.keys()]) if (!seen.has(name)) this.forget(d, name);
      this.prefill([...d.children!.values()]);
      return (f.list = [...dots, ...d.children!]);
    });
  }

  /** Starts the entries' `getFile`s, in the background: the `ls -l` or `git status` after a readdir finds them cached. */
  private prefill(nodes: FNode[]) {
    const stale = nodes.filter((n) => !n.dir && !n.session && !n.sync && performance.now() - n.attrs >= TRUST_MS).slice(0, PREFILL);
    void (async () => {
      for (let k = 0; k < stale.length; k += PREFILL_WIDTH) await Promise.all(stale.slice(k, k + PREFILL_WIDTH).map((n) => this.file(n).catch(() => {})));
    })();
  }

  stat(f: P9Fid<FNode>): P9Stat | Promise<P9Stat> {
    const n = f.node;
    const stat = (mode: number, size: number, ms: number | undefined) => {
      const t = ms === undefined ? n.mount?.time ?? secs(0) : secs(ms);
      return { mode, uid: f.uid, gid: f.uid, nlink: n.dir ? 2 : 1, size, atime: t, mtime: t, ctime: t };
    };
    if (n.dir) {
      this.live(n);
      return stat(n.mount ? n.mode ?? S_IFDIR | 0o777 : S_IFDIR | 0o555, 0, undefined);
    }
    return this.opened(n, async () => {
      this.live(n);
      const a = await this.attrs(n);
      return stat(n.mode ?? S_IFREG | 0o666, a.size, a.mtime);
    });
  }

  setattr(f: P9Fid<FNode>, a: P9SetAttr) {
    const n = f.node;
    if (!n.mount) throw new Err(EPERM);
    return this.serial([n], async () => {
      this.writable(n);
      // Owners and times can't be set, and `cp -p`, `tar` and `rsync` would fail if that were an error.
      if (a.valid & 1) n.mode = (n.dir ? S_IFDIR : S_IFREG) | (a.mode & 0o7777);
      if (a.valid & 8) {
        if (n.dir) throw new Err(EISDIR);
        await this.setSize(n, a.size);
      }
    });
  }

  mkdir(f: P9Fid<FNode>, name: string, mode: number) {
    const d = f.node;
    this.writable(d);
    return this.serial([d], async () => {
      if (await this.lookup(d, name)) throw new Err(EEXIST);
      const n = this.seen(d, name, await (await this.dirHandle(d)).getDirectoryHandle(name, { create: true }));
      n.mode = S_IFDIR | (mode & 0o7777);
      return n;
    });
  }

  symlink(): FNode { throw new Err(EPERM); }
  mknod(): FNode { throw new Err(EPERM); }
  readlink(): string { throw new Err(EINVAL); }
  link() { throw new Err(EPERM); }

  /** Before `n`'s entry goes: if open, its bytes, for the node to keep in memory once it is gone (a removed file's `File` reads no more). */
  private async keep(n: FNode): Promise<FNode['orphan']> {
    if (n.dir || !n.opens) return undefined;
    await this.closeSession(n);
    const size = (await this.attrs(n)).size;
    if (size > ORPHAN_MAX) return undefined;
    const data = new Uint8Array(size);
    if (n.mount!.spec.kind === 'opfs') (await this.useSync(n)).read(data, { at: 0 });
    else data.set(await this.slice(n, 0, size));
    return { data, size };
  }

  private async drop(d: FNode, n: FNode, rmdir: boolean) {
    if (n.dir !== rmdir) throw new Err(n.dir ? EISDIR : ENOTDIR);
    const orphan = await this.keep(n);
    await this.quiet(n);
    await (await this.dirHandle(d)).removeEntry(n.name);
    [n.gone, n.orphan] = [true, orphan];
    d.children!.delete(n.name);
  }

  unlink(f: P9Fid<FNode>, name: string, rmdir: boolean) {
    const d = f.node;
    this.writable(d);
    const known = d.children!.get(name);
    return this.serial(known ? [d, known] : [d], async () => {
      const n = await this.lookup(d, name);
      if (!n) throw new Err(ENOENT);
      await this.drop(d, n, rmdir);
    });
  }

  remove(f: P9Fid<FNode>) {
    const n = f.node;
    if (n === this.root || n === n.mount?.node) throw new Err(EBUSY);
    this.writable(n);
    return this.serial([n.parent, n], () => this.drop(n.parent, n, n.dir));
  }

  rename(odf: P9Fid<FNode>, oname: string, ndf: P9Fid<FNode>, nname: string) {
    const [od, nd] = [odf.node, ndf.node];
    if (od.dir !== true || nd.dir !== true) throw new Err(ENOTDIR);
    if (!od.mount || !nd.mount || od.mount !== nd.mount) throw new Err(EXDEV);
    this.writable(od);
    const known = od.children!.get(oname);
    const over = nd.children!.get(nname);
    const nodes = new Set([od, nd, ...(known ? this.subtree(known) : []), ...(over ? [over] : [])]);
    return this.serial([...nodes], async () => {
      const n = await this.lookup(od, oname);
      if (!n) throw new Err(ENOENT);
      let t = await this.lookup(nd, nname);
      if (t === n) return;
      // On a host that ignores case, Foo over foo is one file, not a target.
      const recased = t?.handle && n.handle && await t.handle.isSameEntry(n.handle);
      if (recased) {
        nd.children!.delete(nname);
        t = undefined;
      }
      if (n.dir) await this.moveDir(n, od, nd, nname, t, !!recased);
      else await this.moveFile(n, nd, nname, t, !!recased);
      od.children!.delete(oname);
      [n.name, n.parent] = [nname, nd];
      nd.children!.set(nname, n);
    });
  }

  private async moveFile(n: FNode, nd: FNode, name: string, over: FNode | undefined, recased: boolean) {
    if (over?.dir) throw new Err(EISDIR);
    const orphan = over && await this.keep(over);
    if (over) await this.quiet(over);
    await this.quiet(n);
    const target = await this.dirHandle(nd);
    await this.moveHandle(await this.fileHandle(n), await this.dirHandle(n.parent), target, name, over !== undefined, recased);
    n.handle = undefined;
    if (over) [over.gone, over.orphan] = [true, orphan];
    n.moved++;
  }

  /** A file's `move()`, or a copy and a remove where the browser has no `move()` for this file. */
  private async moveHandle(h: Moving, from: FileSystemDirectoryHandle, target: FileSystemDirectoryHandle, name: string, replaces = false, recased = false) {
    if (h.move) {
      try {
        await h.move(target, name);
        return;
      } catch (e) {
        if (!named(e, 'NotSupportedError') && !named(e, 'AbortError') && !named(e, 'InvalidStateError') && !named(e, 'TypeError')) throw e;
      }
    }
    if (recased) throw new Err(EINVAL); // a copy onto itself, and then its removal, would be the end of it
    if (replaces) await target.removeEntry(name);
    await putFile(await target.getFileHandle(name, { create: true }), await h.getFile());
    await from.removeEntry(h.name);
  }

  /**
   * No directory has a `move()`: the new tree is made and the files are moved into it (entries, not bytes), and each
   * directory left empty goes; on a failure what moved goes back. What a machine's end interrupts stays half moved: a
   * rename of a tree isn't atomic, on any folder.
   */
  private async moveDir(n: FNode, od: FNode, nd: FNode, name: string, over: FNode | undefined, recased: boolean) {
    if (recased) throw new Err(EINVAL); // the same directory: moving into it would be moving onto itself
    if (over && !over.dir) throw new Err(ENOTDIR);
    for (let up = nd; up !== up.mount?.node; up = up.parent) if (up === n) throw new Err(EINVAL); // into itself
    const nodes = this.subtree(n);
    for (const x of nodes) await this.quiet(x);
    const parent = await this.dirHandle(od);
    if (over) {
      await (await this.dirHandle(nd)).removeEntry(name); // only if it's empty, as rename(2)
      over.gone = true;
    }
    /** The files moved, by their path in the tree; the directories made, by their parent and name. */
    const moved: string[][] = [];
    const made: [FileSystemDirectoryHandle, string][] = [];
    const carry = async (from: FileSystemDirectoryHandle, to: FileSystemDirectoryHandle, path: string[]) => {
      // Until it's empty: the guest's walk isn't stopped, and a file can come while this runs.
      for (;;) {
        const list: [string, FileSystemHandle][] = [];
        for await (const e of (from as Entries).entries()) list.push(e);
        if (!list.length) return;
        for (const [k, h] of list) {
          if (h.kind === 'directory') {
            made.push([to, k]);
            await carry(h as FileSystemDirectoryHandle, await to.getDirectoryHandle(k, { create: true }), [...path, k]);
            await from.removeEntry(k);
          } else {
            await this.moveHandle(h as Moving, from, to, k);
            moved.push([...path, k]);
          }
        }
      }
    };
    const [source, target] = [await this.dirHandle(n), await this.dirHandle(nd)];
    made.push([target, name]);
    try {
      const top = await target.getDirectoryHandle(name, { create: true });
      await carry(source, top, []);
      await parent.removeEntry(n.name);
    } catch (e) {
      for (const path of moved.reverse()) {
        await (async () => {
          let [to, from] = [source, await target.getDirectoryHandle(name)];
          for (const p of path.slice(0, -1)) [to, from] = [await to.getDirectoryHandle(p, { create: true }), await from.getDirectoryHandle(p)];
          await this.moveHandle(await from.getFileHandle(path.at(-1)!) as Moving, from, to, path.at(-1)!);
        })().catch(() => {});
      }
      for (const [d, k] of made.reverse()) await d.removeEntry(k).catch(() => {});
      throw e;
    } finally {
      for (const x of nodes) [x.handle, x.moved] = [undefined, x.moved + 1];
    }
  }

  async statfs(f: P9Fid<FNode>): Promise<P9StatFs> {
    const free = async () => {
      const e = await navigator.storage.estimate().catch(() => undefined);
      return e ? Math.floor(((e.quota ?? 0) - (e.usage ?? 0)) / 4096) : HOST_BLOCKS;
    };
    const blocks = f.node.mount?.spec.kind === 'opfs' ? await free() : HOST_BLOCKS;
    return { bsize: 4096, blocks, bfree: blocks, bavail: blocks, files: 1 << 24, ffree: 1 << 24 };
  }

  fsync(f: P9Fid<FNode>) {
    const n = f.node;
    return this.serial([n], async () => {
      if (n.broken) throw new Err(EIO);
      await this.closeSession(n);
      if (!n.mount?.spec.readOnly) n.sync?.flush();
    });
  }

  clunk(f: P9Fid<FNode>) {
    const n = f.node;
    if (f.flags === undefined || n.dir) return;
    const write = (f.flags & O_ACCMODE) !== 0;
    return this.serial([n], async () => {
      n.opens--;
      if (write) n.writers--;
      if (!n.writers) {
        n.broken = false;
        await this.closeSession(n);
      }
      if (!n.opens) {
        this.closeSync(n);
        [n.file, n.orphan] = [undefined, undefined];
      }
    });
  }
}

/** The device on `folders` (`P9Spec.folders`): `port` carries the page's attachments and grants, and says when one is denied. */
export function folders9p(ctx: Ctx, folders: FolderSpec[], port?: MessagePort) {
  const tree = new FolderTree(folders, (id) => port?.postMessage({ type: 'denied', id } satisfies FoldersFromDevice));
  const server = new P9Server(tree);
  if (port) {
    port.onmessage = (e: MessageEvent<FoldersToDevice>) => {
      const m = e.data;
      if (m.type === 'attach') tree.attach(m.folder);
      else if (m.type === 'detach') void tree.detach(m.id).catch(() => {}).then(() => port.postMessage({ type: 'detached', id: m.id } satisfies FoldersFromDevice));
      else tree.granted(m.id);
    };
  }
  return {
    ...p9Backend(ctx, server),
    flush: () => tree.flush(),
    close() {
      tree.close();
      port?.close();
    },
    save: () => tree.save(server.open),
    restore: (state: unknown) => tree.restore(state as FoldersState, server.open),
  };
}
