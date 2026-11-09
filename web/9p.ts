// virtio-9p backend: a 9P2000.L server over a tree (docs/devices.md "9p"), written from the protocol as the Linux v9fs
// client speaks it (net/9p, fs/9p), with v86's lib/9p.js and TinyEMU's virtio 9p as references (no code copied).
// `P9Server` keeps the protocol (messages, fids, errors) and asks a `P9Tree` for the files. `MemoryTree` is the tests'
// and Alpine's; web/9p-folders.ts is the page's. core/tests/common/p9.rs is the memory tree's native twin and must give
// the same answers: node ids in creation order, and in deterministic mode every timestamp is EPOCH.
//
// Each request chain holds one T-message in its readable buffers and room for
// the R-message in its writable ones (Linux's zero-copy reads and writes split
// the payload into separate buffers, which concatenation undoes).
import { gather, scatter, type Ctx, type Request } from './devices.ts';

/** Initial contents: path (relative, `/`-separated) → file contents. */
export type P9Files = Record<string, string>;

export const EPOCH = 1788220800; // 2026-09-01, the images' SOURCE_DATE_EPOCH
const MSIZE = 1 << 20;

export const S_IFMT = 0o170000;
export const S_IFDIR = 0o040000;
export const S_IFREG = 0o100000;
export const S_IFLNK = 0o120000;

// Linux errno values, as 9P2000.L carries them.
export const EPERM = 1;
export const ENOENT = 2;
export const EIO = 5;
export const E2BIG = 7;
export const EBADF = 9;
export const EACCES = 13;
export const EBUSY = 16;
export const EEXIST = 17;
export const EXDEV = 18;
export const ENOTDIR = 20;
export const EISDIR = 21;
export const EINVAL = 22;
export const ENOSPC = 28;
export const EROFS = 30;
export const ERANGE = 34;
export const ENAMETOOLONG = 36;
export const ENOTEMPTY = 39;
export const ENODATA = 61;
export const EOPNOTSUPP = 95;
export const ESTALE = 116;

/** What a tree answers: at once (the memory tree, so that a deterministic boot's requests complete at their step) or later. */
export type Async<T> = T | Promise<T>;
/** Seconds and nanoseconds. */
export type P9Time = [number, number];
export type P9Stat = { mode: number; uid: number; gid: number; nlink: number; size: number; atime: P9Time; mtime: P9Time; ctime: P9Time };
/** Tsetattr's fields: `valid` says which (1 mode, 2 uid, 4 gid, 8 size, 16 atime, 32 mtime, 128 and 256 the times as given). */
export type P9SetAttr = { valid: number; mode: number; uid: number; gid: number; size: number; atime: P9Time; mtime: P9Time };
/** What Tstatfs answers. */
export type P9StatFs = { bsize: number; blocks: number; bfree: number; bavail: number; files: number; ffree: number };
/** A directory's entry: its name, its node and its offset, the cookie a readdir resumes after (ascending, never 0). */
export type P9Entry<N> = [name: string, node: N, offset: number];
/**
 * A fid: its node, the attach's uid and, once opened, its flags; `list` is what a tree keeps for a directory's readdir.
 * `xattr`: a Txattrwalk's fid (what it reads: a value or the names) or a Txattrcreate's (`set`: what it writes, set at
 * its clunk), the server's own.
 */
export type P9Fid<N> = { node: N; uid: number; flags?: number; list?: P9Entry<N>[]; xattr?: { data: Uint8Array; set?: { name: string; written: number } } };

/** Txattrcreate's flags (setxattr(2)'s). */
export const XATTR_CREATE = 1;
export const XATTR_REPLACE = 2;
/** Linux's limits on a name and a value (XATTR_NAME_MAX, XATTR_SIZE_MAX). */
const XATTR_NAME_MAX = 255;
const XATTR_SIZE_MAX = 65536;

/** The files a server serves. Errors are `Err`; a promise rejects with one. */
export type P9Tree<N> = {
  readonly root: N;
  /** The qid's path and the node's type (its S_IFMT bits). */
  id(n: N): number;
  type(n: N): number;
  /** The qid's version: changes when the file's contents (a directory's entries) do, so a caching client sees it. 0 without. */
  version?(n: N): number;
  /** `name` in directory `d`, with `.` and `..`; undefined if there's none. */
  walk(d: N, name: string): Async<N | undefined>;
  /** Tlopen: `f.flags` is set by the server after it. */
  open(f: P9Fid<N>, flags: number): Async<void>;
  /** Tlcreate: the new file, opened with `flags`. */
  create(f: P9Fid<N>, name: string, flags: number, mode: number, gid: number): Async<N>;
  read(f: P9Fid<N>, off: number, count: number): Async<Uint8Array>;
  write(f: P9Fid<N>, off: number, data: Uint8Array): Async<void>;
  /** The directory's entries with `.` and `..`, by offset: Treaddir sends those past `off`. */
  entries(f: P9Fid<N>, off: number): Async<P9Entry<N>[]>;
  stat(f: P9Fid<N>): Async<P9Stat>;
  setattr(f: P9Fid<N>, a: P9SetAttr): Async<void>;
  mkdir(f: P9Fid<N>, name: string, mode: number, gid: number): Async<N>;
  symlink(f: P9Fid<N>, name: string, target: string, gid: number): Async<N>;
  mknod(f: P9Fid<N>, name: string, mode: number, gid: number): Async<N>;
  readlink(f: P9Fid<N>): Async<string>;
  link(d: P9Fid<N>, f: P9Fid<N>, name: string): Async<void>;
  rename(od: P9Fid<N>, oname: string, nd: P9Fid<N>, nname: string): Async<void>;
  unlink(d: P9Fid<N>, name: string, rmdir: boolean): Async<void>;
  /** Tremove: the fid's own file (its fid is clunked whatever this answers). */
  remove(f: P9Fid<N>): Async<void>;
  statfs(f: P9Fid<N>): Async<P9StatFs>;
  fsync?(f: P9Fid<N>): Async<void>;
  /**
   * Extended attributes (POSIX ACLs are `system.posix_acl_access` and `_default`): the names, a value (undefined: none, so
   * ENODATA) and a change (`value` undefined: removed; ENODATA if there was none). A tree without them answers EOPNOTSUPP.
   */
  listxattr?(f: P9Fid<N>): Async<string[]>;
  getxattr?(f: P9Fid<N>, name: string): Async<Uint8Array | undefined>;
  setxattr?(f: P9Fid<N>, name: string, value: Uint8Array | undefined): Async<void>;
  /** The fid's end: it was opened if `f.flags` is set. */
  clunk?(f: P9Fid<N>): Async<void>;
};

class Reader {
  private v: DataView;
  private b: Uint8Array;
  k = 7; // past size[4] type[1] tag[2]
  constructor(b: Uint8Array) {
    this.b = b;
    this.v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  }
  u8() { return this.v.getUint8((this.k += 1) - 1); }
  u16() { return this.v.getUint16((this.k += 2) - 2, true); }
  u32() { return this.v.getUint32((this.k += 4) - 4, true); }
  u64() { return Number(this.v.getBigUint64((this.k += 8) - 8, true)); }
  str() { return new TextDecoder().decode(this.bytes(this.u16())); }
  bytes(n: number) {
    if (this.k + n > this.b.length) throw new RangeError('truncated');
    return this.b.subarray(this.k, (this.k += n));
  }
}

class Writer {
  b = new Uint8Array(256);
  k = 7;
  private room(n: number) {
    if (this.k + n <= this.b.length) return;
    const b = new Uint8Array(Math.max(this.b.length * 2, this.k + n));
    b.set(this.b);
    this.b = b;
  }
  u8(v: number) { this.room(1); this.b[this.k++] = v; return this; }
  u16(v: number) { this.room(2); new DataView(this.b.buffer).setUint16(this.k, v, true); this.k += 2; return this; }
  u32(v: number) { this.room(4); new DataView(this.b.buffer).setUint32(this.k, v >>> 0, true); this.k += 4; return this; }
  u64(v: number) { this.room(8); new DataView(this.b.buffer).setBigUint64(this.k, BigInt(v), true); this.k += 8; return this; }
  str(s: string) { const e = new TextEncoder().encode(s); this.u16(e.length); return this.bytes(e); }
  bytes(e: Uint8Array) { this.room(e.length); this.b.set(e, this.k); this.k += e.length; return this; }
  qid(type: number, id: number, version: number) {
    return this.u8(type === S_IFDIR ? 0x80 : type === S_IFLNK ? 0x02 : 0).u32(version).u64(id);
  }
}

/** A request's failure: Linux's errno. */
export class Err {
  errno: number;
  constructor(errno: number) {
    this.errno = errno;
  }
}

// POSIX ACLs as Linux's xattrs carry them (include/uapi/linux/posix_acl_xattr.h): version 2, then tag[2] perm[2] id[4]
// per entry. The client (v9fs) sends them as they are; without `access=client,posixacl` it leaves to the server what a
// local file system would do with them, which the memory tree does: an access ACL gives the mode its bits and `chmod`
// gives them back to it, and a directory's default ACL is what its new entries start with (Linux's posix_acl_create).
export const ACL_ACCESS = 'system.posix_acl_access';
export const ACL_DEFAULT = 'system.posix_acl_default';
const ACL_USER_OBJ = 1;
const ACL_USER = 2;
const ACL_GROUP_OBJ = 4;
const ACL_GROUP = 8;
const ACL_MASK = 0x10;
const ACL_OTHER = 0x20;

/** The ACL's entries as [tag, perm] by index, or undefined if it isn't a valid one. */
function aclEntries(v: Uint8Array): [number, number][] | undefined {
  if (v.length < 4 || (v.length - 4) % 8 !== 0) return undefined;
  const d = new DataView(v.buffer, v.byteOffset, v.byteLength);
  if (d.getUint32(0, true) !== 2) return undefined;
  const out: [number, number][] = [];
  const count = new Map<number, number>();
  for (let k = 4; k < v.length; k += 8) {
    const [tag, perm] = [d.getUint16(k, true), d.getUint16(k + 2, true)];
    if (![ACL_USER_OBJ, ACL_USER, ACL_GROUP_OBJ, ACL_GROUP, ACL_MASK, ACL_OTHER].includes(tag) || perm > 7) return undefined;
    count.set(tag, (count.get(tag) ?? 0) + 1);
    out.push([tag, perm]);
  }
  const one = (tag: number) => count.get(tag) === 1;
  if (!one(ACL_USER_OBJ) || !one(ACL_GROUP_OBJ) || !one(ACL_OTHER) || (count.get(ACL_MASK) ?? 0) > 1) return undefined;
  if ((count.has(ACL_USER) || count.has(ACL_GROUP)) && !count.has(ACL_MASK)) return undefined;
  return out;
}

/** The ACL with each entry's perm set by `perm(tag, old)`. */
function aclMap(v: Uint8Array, perm: (tag: number, old: number) => number) {
  const out = v.slice();
  const d = new DataView(out.buffer);
  for (let k = 4; k < out.length; k += 8) d.setUint16(k + 2, perm(d.getUint16(k, true), d.getUint16(k + 2, true)), true);
  return out;
}

/** The permission bits an ACL stands for: the owner's, the mask's (the owning group's without one) and the others'. */
function aclMode(e: [number, number][]) {
  const perm = (tag: number) => e.find(([t]) => t === tag)?.[1] ?? 0;
  return perm(ACL_USER_OBJ) << 6 | (e.some(([t]) => t === ACL_MASK) ? perm(ACL_MASK) : perm(ACL_GROUP_OBJ)) << 3 | perm(ACL_OTHER);
}

/** Whether the mode says all an ACL does (no named users or groups, no mask). */
const aclEquiv = (e: [number, number][]) => e.length === 3;

/** `chmod` on an access ACL: the owner's, the mask's (the owning group's without one) and the others' perms. */
function aclChmod(v: Uint8Array, mode: number) {
  const mask = aclEntries(v)!.some(([t]) => t === ACL_MASK);
  return aclMap(v, (tag, old) => tag === ACL_USER_OBJ ? mode >> 6 & 7 : tag === ACL_OTHER ? mode & 7 : tag === (mask ? ACL_MASK : ACL_GROUP_OBJ) ? mode >> 3 & 7 : old);
}

/** A new file's access ACL from its directory's default ACL and the mode it's created with (posix_acl_create_masq): both narrowed to what the other allows. */
function aclCreate(def: Uint8Array, mode: number): { acl: Uint8Array; mode: number } {
  const e = aclEntries(def)!;
  const mask = e.some(([t]) => t === ACL_MASK);
  const group = mask ? ACL_MASK : ACL_GROUP_OBJ;
  const acl = aclMap(def, (tag, old) => tag === ACL_USER_OBJ ? old & mode >> 6 : tag === ACL_OTHER ? old & mode : tag === group ? old & mode >> 3 : old);
  return { acl, mode: (mode & ~0o777) | aclMode(aclEntries(acl)!) };
}

type Node = {
  id: number;
  mode: number;
  uid: number;
  gid: number;
  data: Uint8Array;
  size: number;
  target: string;
  /** A directory's entries in the order they came, and each one's readdir offset (`.` is 1, `..` 2, then from 3 up). */
  children?: Map<string, Node>;
  offsets?: Map<string, number>;
  offset: number;
  parent: Node;
  nlink: number;
  version: number;
  atime: P9Time;
  mtime: P9Time;
  ctime: P9Time;
  xattrs?: Map<string, Uint8Array>;
};

/** Now as [seconds, nanoseconds], from a clock with sub-millisecond steps where there is one. */
function wallClock(): P9Time {
  const ms = performance.timeOrigin + performance.now();
  const s = Math.floor(ms / 1000);
  return [s, Math.min(999_999_999, Math.floor((ms - s * 1000) * 1e6))];
}

/** An in-memory tree: the tests' and Alpine's. */
export class MemoryTree implements P9Tree<Node> {
  private ids = 0;
  readonly root: Node;
  private now: () => P9Time;

  constructor(files: P9Files, deterministic: boolean) {
    this.now = deterministic ? () => [EPOCH, 0] : wallClock;
    this.root = this.node(S_IFDIR | 0o755, undefined);
    for (const [path, text] of Object.entries(files)) {
      let dir = this.root;
      const parts = path.split('/').filter(Boolean);
      for (const p of parts.slice(0, -1)) dir = dir.children!.get(p) ?? this.linked(dir, p, this.node(S_IFDIR | 0o755, dir));
      const f = this.linked(dir, parts.at(-1)!, this.node(S_IFREG | 0o644, dir));
      f.data = new TextEncoder().encode(text);
      f.size = f.data.length;
    }
  }

  private node(mode: number, parent: Node | undefined, uid = 0, gid = 0): Node {
    const t = this.now();
    const n: Node = { id: ++this.ids, mode, uid, gid, data: new Uint8Array(0), size: 0, target: '', parent: parent!, offset: 2, nlink: 1, version: 0, atime: t, mtime: t, ctime: t };
    if ((mode & S_IFMT) === S_IFDIR) [n.children, n.offsets, n.nlink] = [new Map(), new Map(), 2];
    n.parent ??= n;
    return n;
  }

  /** `name` in `dir` is `n` now: a new name takes the next offset, one there already keeps its own. */
  private linked(dir: Node, name: string, n: Node) {
    if (!dir.children!.has(name)) dir.offsets!.set(name, ++dir.offset);
    dir.children!.set(name, n);
    dir.mtime = dir.ctime = this.now();
    dir.version++;
    return n;
  }

  private unlinked(dir: Node, name: string) {
    dir.children!.delete(name);
    dir.offsets!.delete(name);
    dir.version++;
  }

  private dir(f: P9Fid<Node>) {
    if (!f.node.children) throw new Err(ENOTDIR);
    return f.node;
  }

  /** A new entry `name` in `dir`: EEXIST if taken. It starts with the directory's default ACL, if it has one. */
  private add(dir: Node, name: string, mode: number, gid: number) {
    if (dir.children!.has(name)) throw new Err(EEXIST);
    if (!name || name === '.' || name === '..' || name.includes('/')) throw new Err(EINVAL);
    const n = this.linked(dir, name, this.node(mode, dir, 0, gid));
    const def = dir.xattrs?.get(ACL_DEFAULT);
    if (def && (mode & S_IFMT) !== S_IFLNK) {
      const c = aclCreate(def, mode);
      n.mode = c.mode;
      n.xattrs = new Map();
      if (!aclEquiv(aclEntries(c.acl)!)) n.xattrs.set(ACL_ACCESS, c.acl);
      if (n.children) n.xattrs.set(ACL_DEFAULT, def.slice());
    }
    return n;
  }

  private resize(n: Node, size: number) {
    if (size > n.data.length) {
      const d = new Uint8Array(Math.max(size, n.data.length * 2));
      d.set(n.data.subarray(0, n.size));
      n.data = d;
    } else n.data.fill(0, size, n.size);
    n.size = size;
    n.version++;
  }

  private drop(dir: Node, name: string, rmdir: boolean) {
    const n = dir.children!.get(name);
    if (!n) throw new Err(ENOENT);
    if (n.children && !rmdir) throw new Err(EISDIR);
    if (!n.children && rmdir) throw new Err(ENOTDIR);
    if (n.children?.size) throw new Err(ENOTEMPTY);
    this.unlinked(dir, name);
    n.nlink = n.children ? 0 : n.nlink - 1;
    dir.mtime = dir.ctime = n.ctime = this.now();
  }

  id(n: Node) { return n.id; }
  type(n: Node) { return n.mode & S_IFMT; }
  version(n: Node) { return n.version; }

  walk(d: Node, name: string) {
    return !d.children ? undefined : name === '..' ? d.parent : name === '.' ? d : d.children.get(name);
  }

  open(f: P9Fid<Node>, flags: number) {
    if (flags & 0o1000 && !f.node.children) this.resize(f.node, 0); // O_TRUNC
  }

  create(f: P9Fid<Node>, name: string, _flags: number, mode: number, gid: number) {
    return this.add(this.dir(f), name, S_IFREG | (mode & 0o7777), gid);
  }

  read(f: P9Fid<Node>, off: number, count: number) {
    const n = f.node;
    if (n.children) throw new Err(EISDIR);
    const data = off < n.size ? n.data.subarray(off, Math.min(n.size, off + count)) : new Uint8Array(0);
    n.atime = this.now();
    return data;
  }

  write(f: P9Fid<Node>, off: number, data: Uint8Array) {
    const n = f.node;
    if (n.children) throw new Err(EISDIR);
    if (off + data.length > n.size) this.resize(n, off + data.length);
    n.data.set(data, off);
    n.mtime = n.ctime = this.now();
    n.version++;
  }

  entries(f: P9Fid<Node>): P9Entry<Node>[] {
    const d = this.dir(f);
    return [['.', d, 1], ['..', d.parent, 2], ...[...d.children!].map(([k, n]): P9Entry<Node> => [k, n, d.offsets!.get(k)!])];
  }

  stat(f: P9Fid<Node>): P9Stat {
    const n = f.node;
    return { mode: n.mode, uid: n.uid, gid: n.gid, nlink: n.nlink, size: n.size, atime: n.atime, mtime: n.mtime, ctime: n.ctime };
  }

  setattr(f: P9Fid<Node>, a: P9SetAttr) {
    const n = f.node;
    const now = this.now();
    if (a.valid & 1) {
      n.mode = (n.mode & S_IFMT) | (a.mode & 0o7777);
      const acl = n.xattrs?.get(ACL_ACCESS);
      if (acl) n.xattrs!.set(ACL_ACCESS, aclChmod(acl, n.mode));
    }
    if (a.valid & 2) n.uid = a.uid;
    if (a.valid & 4) n.gid = a.gid;
    if (a.valid & 8) {
      if (n.children) throw new Err(EISDIR);
      this.resize(n, a.size);
      n.mtime = now;
    }
    if (a.valid & 16) n.atime = a.valid & 128 ? a.atime : now;
    if (a.valid & 32) n.mtime = a.valid & 256 ? a.mtime : now;
    n.ctime = now;
  }

  mkdir(f: P9Fid<Node>, name: string, mode: number, gid: number) {
    const d = this.dir(f);
    const n = this.add(d, name, S_IFDIR | (mode & 0o7777), gid);
    d.nlink++;
    return n;
  }

  symlink(f: P9Fid<Node>, name: string, target: string, gid: number) {
    const n = this.add(this.dir(f), name, S_IFLNK | 0o777, gid);
    n.target = target;
    n.size = new TextEncoder().encode(target).length;
    return n;
  }

  mknod(f: P9Fid<Node>, name: string, mode: number, gid: number) {
    const d = this.dir(f);
    if ((mode & S_IFMT) === S_IFDIR || (mode & S_IFMT) === S_IFLNK) throw new Err(EINVAL);
    return this.add(d, name, mode, gid);
  }

  readlink(f: P9Fid<Node>) {
    if ((f.node.mode & S_IFMT) !== S_IFLNK) throw new Err(EINVAL);
    return f.node.target;
  }

  link(df: P9Fid<Node>, f: P9Fid<Node>, name: string) {
    const d = this.dir(df);
    const n = f.node;
    if (n.children) throw new Err(EISDIR);
    if (d.children!.has(name)) throw new Err(EEXIST);
    this.linked(d, name, n);
    n.nlink++;
    n.ctime = this.now();
  }

  rename(odf: P9Fid<Node>, oname: string, ndf: P9Fid<Node>, nname: string) {
    const [od, nd] = [this.dir(odf), this.dir(ndf)];
    const n = od.children!.get(oname);
    if (!n) throw new Err(ENOENT);
    const old = nd.children!.get(nname);
    if (old === n) return;
    if (old) this.drop(nd, nname, !!old.children);
    this.unlinked(od, oname);
    this.linked(nd, nname, n);
    if (n.children) {
      [od.nlink, nd.nlink] = [od.nlink - 1, nd.nlink + 1];
      n.parent = nd;
    }
    od.mtime = od.ctime = n.ctime = this.now();
  }

  unlink(f: P9Fid<Node>, name: string, rmdir: boolean) {
    const d = this.dir(f);
    this.drop(d, name, rmdir);
    if (rmdir) d.nlink--;
  }

  remove(f: P9Fid<Node>) {
    const n = f.node;
    const name = [...n.parent.children!].find(([, c]) => c === n)?.[0];
    if (name === undefined || n === this.root) throw new Err(ENOENT);
    this.drop(n.parent, name, !!n.children);
    if (n.children) n.parent.nlink--;
  }

  statfs(): P9StatFs {
    return { bsize: 4096, blocks: 1 << 18, bfree: 1 << 18, bavail: 1 << 18, files: 1 << 16, ffree: 1 << 16 };
  }

  listxattr(f: P9Fid<Node>) {
    return [...f.node.xattrs?.keys() ?? []];
  }

  getxattr(f: P9Fid<Node>, name: string) {
    return f.node.xattrs?.get(name);
  }

  setxattr(f: P9Fid<Node>, name: string, value: Uint8Array | undefined) {
    const n = f.node;
    if (value && (name === ACL_ACCESS || name === ACL_DEFAULT)) {
      const e = aclEntries(value);
      if (!e) throw new Err(EINVAL);
      if (name === ACL_DEFAULT && !n.children) throw new Err(EACCES);
      if (name === ACL_ACCESS) {
        n.mode = (n.mode & ~0o777) | aclMode(e);
        if (aclEquiv(e)) value = undefined; // the mode says it all: kept as the mode, as Linux does
      }
      if (!value) {
        n.xattrs?.delete(name);
        n.ctime = this.now();
        return;
      }
    } else if (!value && !n.xattrs?.has(name)) throw new Err(ENODATA);
    n.xattrs ??= new Map();
    if (value) n.xattrs.set(name, value.slice());
    else n.xattrs.delete(name);
    n.ctime = this.now();
  }
}

/**
 * The server: `handle` answers one T-message, at once if the tree does. Requests overlap when a tree answers later:
 * Linux matches replies by tag, so a later one may finish first, but a Tflush is answered after the request it names.
 */
export class P9Server<N = unknown> {
  private fids = new Map<number, P9Fid<N>>();
  /** The requests running, by tag. */
  private running = new Map<number, Promise<unknown>>();
  readonly tree: P9Tree<N>;

  constructor(tree: P9Tree<N>) {
    this.tree = tree;
  }

  /** Every fid (a tree's snapshot, web/9p-folders.ts), by number. */
  get open() { return this.fids; }

  private fid(r: Reader) {
    const f = this.fids.get(r.u32());
    if (!f) throw new Err(EBADF);
    return f;
  }

  private dir(r: Reader) {
    const f = this.fid(r);
    if (this.tree.type(f.node) !== S_IFDIR) throw new Err(ENOTDIR);
    return f;
  }

  /** Answers the T-message `m` into at most `room` bytes. */
  handle(m: Uint8Array, room: number): Uint8Array | Promise<Uint8Array> {
    const tag = m[5] | m[6] << 8;
    const type = m[4];
    const w = new Writer();
    const failed = (e: unknown) => {
      if (!(e instanceof Err) && !(e instanceof RangeError)) throw e; // RangeError: a truncated message
      w.k = 7;
      w.u32(e instanceof Err ? e.errno : EINVAL);
      return finish(w, 7, m);
    };
    if (type === 108) { // Tflush: oldtag
      const old = this.running.get(new Reader(m).u16());
      if (old) return old.then(() => finish(w, 109, m));
    }
    const g = this.op(type, new Reader(m), w, room);
    // A tree that answers at once costs no microtask: the request completes at the step it was taken.
    const on = (next: () => IteratorResult<unknown, void>): Uint8Array | Promise<Uint8Array> => {
      try {
        for (let s = next(); ; s = g.next(s.value)) {
          if (s.done) return finish(w, type + 1, m);
          if (s.value instanceof Promise) return s.value.then((v) => on(() => g.next(v)), (e) => on(() => g.throw(e)));
        }
      } catch (e) {
        return failed(e);
      }
    };
    const reply = on(() => g.next());
    if (reply instanceof Promise) {
      this.running.set(tag, reply);
      void reply.catch(() => {}).finally(() => this.running.delete(tag));
    }
    return reply;
  }

  /** One request: `yield` is `await` for what the tree answers. */
  private *op(type: number, r: Reader, w: Writer, room: number): Generator<unknown, void, any> {
    const t = this.tree;
    const qid = (n: N) => w.qid(t.type(n), t.id(n), t.version?.(n) ?? 0);
    switch (type) {
      case 100: { // Tversion: msize, version
        const msize = r.u32();
        const open = [...this.fids.values()];
        this.fids.clear();
        for (const f of open.filter((f) => !f.xattr)) {
          try {
            yield t.clunk?.(f);
          } catch { /* each fid ends once, whatever its clunk says */ }
        }
        w.u32(Math.min(msize, MSIZE)).str(r.str() === '9P2000.L' ? '9P2000.L' : 'unknown');
        return;
      }
      case 104: { // Tattach: fid, afid, uname, aname, n_uname
        const fid = r.u32();
        r.u32();
        r.str();
        r.str();
        const uid = r.u32();
        this.fids.set(fid, { node: t.root, uid: uid === 0xffffffff ? 0 : uid });
        qid(t.root);
        return;
      }
      case 110: { // Twalk: fid, newfid, nwname, names
        const f = this.fid(r);
        let n = f.node;
        const newfid = r.u32();
        const names = Array.from({ length: r.u16() }, () => r.str());
        const qids: N[] = [];
        for (const name of names) {
          const next: N | undefined = yield t.walk(n, name);
          if (next === undefined) break;
          qids.push((n = next));
        }
        if (qids.length === 0 && names.length > 0) throw new Err(ENOENT);
        if (qids.length === names.length) this.fids.set(newfid, { node: n, uid: f.uid });
        w.u16(qids.length);
        for (const q of qids) qid(q);
        return;
      }
      case 12: { // Tlopen: fid, flags
        const f = this.fid(r);
        const flags = r.u32();
        yield t.open(f, flags);
        f.flags = flags;
        qid(f.node).u32(0);
        return;
      }
      case 14: { // Tlcreate: fid (the directory, then the new file), name, flags, mode, gid
        const k = r.k;
        const d = this.dir(r);
        const name = r.str();
        const flags = r.u32();
        const n: N = yield t.create(d, name, flags, r.u32(), r.u32());
        r.k = k;
        const f = { node: n, uid: d.uid, flags };
        this.fids.set(r.u32(), f);
        qid(n).u32(0);
        return;
      }
      case 116: { // Tread: fid, offset, count
        const f = this.fid(r);
        const off = r.u64();
        const count = Math.min(r.u32(), room - 11);
        const x = f.xattr;
        const data: Uint8Array = x ? (x.set ? new Uint8Array(0) : x.data.subarray(Math.min(off, x.data.length), Math.min(off + count, x.data.length))) : yield t.read(f, off, count);
        w.u32(data.length).bytes(data);
        return;
      }
      case 118: { // Twrite: fid, offset, count, data
        const f = this.fid(r);
        const off = r.u64();
        let data = r.bytes(r.u32());
        const x = f.xattr;
        if (x) { // a Txattrcreate's value, up to the size it gave
          if (!x.set) throw new Err(EBADF);
          if (off > x.data.length) throw new Err(ENOSPC);
          data = data.subarray(0, x.data.length - off);
          x.data.set(data, off);
          x.set.written += data.length;
        } else yield t.write(f, off, data);
        w.u32(data.length);
        return;
      }
      case 40: { // Treaddir: fid, offset, count; entries qid, offset, type, name
        const d = this.dir(r);
        const off = r.u64();
        const count = Math.min(r.u32(), room - 11);
        const all: P9Entry<N>[] = yield t.entries(d, off);
        const e = new Writer();
        e.k = 0;
        for (const [name, n, next] of all) {
          if (next <= off) continue;
          const type = t.type(n);
          const before = e.k;
          e.qid(type, t.id(n), t.version?.(n) ?? 0).u64(next).u8(type === S_IFDIR ? 4 : type === S_IFLNK ? 10 : type === S_IFREG ? 8 : 0).str(name);
          if (e.k > count) {
            e.k = before;
            break;
          }
        }
        w.u32(e.k).bytes(e.b.subarray(0, e.k));
        return;
      }
      case 24: { // Tgetattr: fid, request_mask
        const f = this.fid(r);
        const s: P9Stat = yield t.stat(f);
        w.u64(0x7ff);
        qid(f.node).u32(s.mode).u32(s.uid).u32(s.gid).u64(s.nlink).u64(0).u64(s.size).u64(4096).u64(Math.ceil(s.size / 512));
        for (const [sec, ns] of [s.atime, s.mtime, s.ctime, [0, 0]]) w.u64(sec).u64(ns);
        w.u64(0).u64(0); // gen, data_version
        return;
      }
      case 26: { // Tsetattr: fid, valid, mode, uid, gid, size, atime, mtime (seconds, nanoseconds)
        const f = this.fid(r);
        const [valid, mode, uid, gid, size] = [r.u32(), r.u32(), r.u32(), r.u32(), r.u64()];
        const atime: P9Time = [r.u64(), r.u64()];
        yield t.setattr(f, { valid, mode, uid, gid, size, atime, mtime: [r.u64(), r.u64()] });
        return;
      }
      case 72: { // Tmkdir: dfid, name, mode, gid
        const d = this.dir(r);
        const name = r.str();
        qid(yield t.mkdir(d, name, r.u32(), r.u32()));
        return;
      }
      case 16: { // Tsymlink: fid, name, target, gid
        const d = this.dir(r);
        const [name, target] = [r.str(), r.str()];
        qid(yield t.symlink(d, name, target, r.u32()));
        return;
      }
      case 18: { // Tmknod: dfid, name, mode, major, minor, gid
        const d = this.dir(r);
        const name = r.str();
        const mode = r.u32();
        r.u32();
        r.u32();
        qid(yield t.mknod(d, name, mode, r.u32()));
        return;
      }
      case 22: // Treadlink: fid
        w.str(yield t.readlink(this.fid(r)));
        return;
      case 70: { // Tlink: dfid, fid, name
        const d = this.dir(r);
        const f = this.fid(r);
        yield t.link(d, f, r.str());
        return;
      }
      case 74: { // Trenameat: olddirfid, oldname, newdirfid, newname
        const od = this.dir(r);
        const oname = r.str();
        const nd = this.dir(r);
        yield t.rename(od, oname, nd, r.str());
        return;
      }
      case 76: { // Tunlinkat: dirfd, name, flags (AT_REMOVEDIR 0x200)
        const d = this.dir(r);
        const name = r.str();
        yield t.unlink(d, name, (r.u32() & 0x200) !== 0);
        return;
      }
      case 120: { // Tclunk: fid; a Txattrcreate's sets its attribute now (a value of 0 bytes removes it, as QEMU's)
        const k = r.k;
        const f = this.fid(r);
        this.fids.delete((r.k = k, r.u32()));
        const set = f.xattr?.set;
        if (set) {
          if (set.written !== f.xattr!.data.length) throw new Err(EINVAL);
          yield t.setxattr!(f, set.name, f.xattr!.data.length ? f.xattr!.data : undefined);
        } else if (!f.xattr) yield t.clunk?.(f);
        return;
      }
      case 30: { // Txattrwalk: fid, newfid, name (empty: the names, each ending in a NUL) → the value's size; newfid reads it
        const f = this.fid(r);
        const newfid = r.u32();
        const name = r.str();
        if (!t.getxattr || !t.listxattr) throw new Err(EOPNOTSUPP);
        let data: Uint8Array | undefined;
        if (name) data = yield t.getxattr(f, name);
        else data = new TextEncoder().encode(((yield t.listxattr(f)) as string[]).map((x) => `${x}\0`).join(''));
        if (!data) throw new Err(ENODATA);
        if (data.length > XATTR_SIZE_MAX) throw new Err(E2BIG);
        this.fids.set(newfid, { node: f.node, uid: f.uid, xattr: { data: data.slice() } });
        w.u64(data.length);
        return;
      }
      case 32: { // Txattrcreate: fid (becomes the value's to write), name, attr_size, flags (XATTR_CREATE, XATTR_REPLACE)
        const f = this.fid(r);
        const [name, size, flags] = [r.str(), r.u64(), r.u32()];
        if (!t.getxattr || !t.setxattr) throw new Err(EOPNOTSUPP);
        if (!name || flags & ~(XATTR_CREATE | XATTR_REPLACE)) throw new Err(EINVAL);
        if (new TextEncoder().encode(name).length > XATTR_NAME_MAX) throw new Err(ERANGE);
        if (size > XATTR_SIZE_MAX) throw new Err(E2BIG);
        if (f.flags !== undefined || f.xattr) throw new Err(EINVAL);
        if (flags) {
          const had = (yield t.getxattr(f, name)) !== undefined;
          if (flags & XATTR_CREATE && had) throw new Err(EEXIST);
          if (flags & XATTR_REPLACE && !had) throw new Err(ENODATA);
        }
        f.xattr = { data: new Uint8Array(size), set: { name, written: 0 } };
        return;
      }
      case 122: { // Tremove: fid, clunked even if the remove fails
        const k = r.k;
        const f = this.fid(r);
        this.fids.delete((r.k = k, r.u32()));
        try {
          yield t.remove(f);
        } finally {
          yield t.clunk?.(f);
        }
        return;
      }
      case 108: // Tflush whose request already ended
        return;
      case 50: // Tfsync: fid, datasync
        yield t.fsync?.(this.fid(r));
        return;
      case 8: { // Tstatfs: type V9FS_MAGIC, bsize, blocks, bfree, bavail, files, ffree, fsid, namelen
        const s: P9StatFs = yield t.statfs(this.fid(r));
        w.u32(0x01021997).u32(s.bsize).u64(s.blocks).u64(s.bfree).u64(s.bavail).u64(s.files).u64(s.ffree).u64(0).u32(255);
        return;
      }
      case 52: // Tlock: success (one client)
        w.u8(0);
        return;
      case 54: { // Tgetlock: fid, type, start, length, proc_id, client_id → unlocked
        this.fid(r);
        r.u8();
        const [start, len, pid, client] = [r.u64(), r.u64(), r.u32(), r.str()];
        w.u8(2).u64(start).u64(len).u32(pid).str(client);
        return;
      }
      default: // the rest
        throw new Err(EOPNOTSUPP);
    }
  }
}

/** Fills in size, type and tag (the T-message's). */
function finish(w: Writer, type: number, m: Uint8Array) {
  const v = new DataView(w.b.buffer);
  v.setUint32(0, w.k, true);
  w.b[4] = type;
  w.b.set(m.subarray(5, 7), 5);
  return w.b.subarray(0, w.k);
}

/** The virtio-9p backend around `server`. A request the tree answers later completes when it does, any other at once. */
export function p9Backend<N>(ctx: Ctx, server: P9Server<N>) {
  let epoch = 0; // a reset's: what answers after one has no buffers left
  return {
    concurrent: true,
    request(r: Request) {
      const ram = ctx.ram();
      const len = r.read.reduce((n, s) => n + s.len, 0);
      const room = r.write.reduce((n, s) => n + s.len, 0);
      const m = gather(ram, r.read, len);
      const size = len < 7 ? 0 : new DataView(m.buffer, m.byteOffset).getUint32(0, true);
      if (size < 7 || size > len || room < 11) return 0; // malformed: no answer
      const was = epoch;
      const send = (reply: Uint8Array) => {
        if (reply.length > room || was !== epoch) return 0;
        scatter(ctx.ram(), r.write, reply);
        return reply.length;
      };
      const reply = server.handle(m.slice(0, size), room);
      return reply instanceof Promise ? reply.then(send) : send(reply);
    },
    reset() { epoch++; },
  };
}

/** The virtio-9p backend around a server on `files`. */
export function p9(ctx: Ctx, files: P9Files, deterministic: boolean) {
  return {
    ...p9Backend(ctx, new P9Server(new MemoryTree(files, deterministic))),
    // The in-memory tree is the tests' and Alpine's only: its tree and fids aren't saved (docs/shares.md §6).
    save(): unknown { throw new Error("a machine with a 9p device can't be saved to a snapshot yet"); },
  };
}
