// virtio-9p backend: a 9P2000.L server over an in-memory tree (docs/devices.md
// "9p"), written from the protocol as the Linux v9fs client speaks it
// (net/9p, fs/9p), with v86's lib/9p.js and TinyEMU's virtio 9p as references
// (no code copied). core/tests/common/p9.rs is its native twin and must give
// the same answers: node ids in creation order, and in deterministic mode
// every timestamp is EPOCH.
//
// Each request chain holds one T-message in its readable buffers and room for
// the R-message in its writable ones (Linux's zero-copy reads and writes split
// the payload into separate buffers, which concatenation undoes).
import { gather, scatter, type Ctx, type Request } from './devices.ts';

/** Initial contents: path (relative, `/`-separated) → file contents. */
export type P9Files = Record<string, string>;

export const EPOCH = 1788220800; // 2026-09-01, the images' SOURCE_DATE_EPOCH
const MSIZE = 1 << 20;

const S_IFMT = 0o170000;
const S_IFDIR = 0o040000;
const S_IFREG = 0o100000;
const S_IFLNK = 0o120000;

// Linux errno values, as 9P2000.L carries them.
const ENOENT = 2;
const EBADF = 9;
const EEXIST = 17;
const ENOTDIR = 20;
const EISDIR = 21;
const EINVAL = 22;
const ENOTEMPTY = 39;
const EOPNOTSUPP = 95;

type Node = {
  id: number;
  mode: number;
  uid: number;
  gid: number;
  data: Uint8Array;
  size: number;
  target: string;
  children?: Map<string, Node>;
  parent: Node;
  nlink: number;
  atime: number;
  mtime: number;
  ctime: number;
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
  qid(n: Node) {
    const t = n.mode & S_IFMT;
    return this.u8(t === S_IFDIR ? 0x80 : t === S_IFLNK ? 0x02 : 0).u32(0).u64(n.id);
  }
}

class Err {
  errno: number;
  constructor(errno: number) {
    this.errno = errno;
  }
}

/** The server: `handle` answers one T-message. Exported for tests. */
export class P9Server {
  private ids = 0;
  private fids = new Map<number, Node>();
  readonly root: Node;
  private now: () => number;

  constructor(files: P9Files, deterministic: boolean) {
    this.now = deterministic ? () => EPOCH : () => Math.floor(Date.now() / 1000);
    this.root = this.node(S_IFDIR | 0o755, undefined);
    for (const [path, text] of Object.entries(files)) {
      let dir = this.root;
      const parts = path.split('/').filter(Boolean);
      for (const p of parts.slice(0, -1)) dir = dir.children!.get(p) ?? this.link(dir, p, this.node(S_IFDIR | 0o755, dir));
      const f = this.link(dir, parts.at(-1)!, this.node(S_IFREG | 0o644, dir));
      f.data = new TextEncoder().encode(text);
      f.size = f.data.length;
    }
  }

  private node(mode: number, parent: Node | undefined, uid = 0, gid = 0): Node {
    const t = this.now();
    const n: Node = { id: ++this.ids, mode, uid, gid, data: new Uint8Array(0), size: 0, target: '', parent: parent!, nlink: 1, atime: t, mtime: t, ctime: t };
    if ((mode & S_IFMT) === S_IFDIR) [n.children, n.nlink] = [new Map(), 2];
    n.parent ??= n;
    return n;
  }

  private link(dir: Node, name: string, n: Node) {
    dir.children!.set(name, n);
    dir.mtime = dir.ctime = this.now();
    return n;
  }

  private fid(r: Reader) {
    const n = this.fids.get(r.u32());
    if (!n) throw new Err(EBADF);
    return n;
  }

  private dir(r: Reader) {
    const d = this.fid(r);
    if (!d.children) throw new Err(ENOTDIR);
    return d;
  }

  /** A new entry `name` in `dir`: EEXIST if taken. */
  private create(dir: Node, name: string, mode: number, gid: number) {
    if (dir.children!.has(name)) throw new Err(EEXIST);
    if (!name || name === '.' || name === '..' || name.includes('/')) throw new Err(EINVAL);
    return this.link(dir, name, this.node(mode, dir, 0, gid));
  }

  private resize(n: Node, size: number) {
    if (size > n.data.length) {
      const d = new Uint8Array(Math.max(size, n.data.length * 2));
      d.set(n.data.subarray(0, n.size));
      n.data = d;
    } else n.data.fill(0, size, n.size);
    n.size = size;
  }

  private unlink(dir: Node, name: string, rmdir: boolean) {
    const n = dir.children!.get(name);
    if (!n) throw new Err(ENOENT);
    if (n.children && !rmdir) throw new Err(EISDIR);
    if (!n.children && rmdir) throw new Err(ENOTDIR);
    if (n.children?.size) throw new Err(ENOTEMPTY);
    dir.children!.delete(name);
    n.nlink = n.children ? 0 : n.nlink - 1;
    dir.mtime = dir.ctime = n.ctime = this.now();
  }

  /** Answers the T-message `m` into at most `room` bytes. */
  handle(m: Uint8Array, room: number): Uint8Array {
    const r = new Reader(m);
    const type = m[4];
    const w = new Writer();
    try {
      this.op(type, r, w, room);
    } catch (e) {
      if (!(e instanceof Err) && !(e instanceof RangeError)) throw e; // RangeError: a truncated message
      w.k = 7;
      w.u32(e instanceof Err ? e.errno : EINVAL);
      return finish(w, 7, m);
    }
    return finish(w, type + 1, m);
  }

  private op(type: number, r: Reader, w: Writer, room: number) {
    const now = this.now();
    switch (type) {
      case 100: { // Tversion: msize, version
        const msize = r.u32();
        this.fids.clear();
        w.u32(Math.min(msize, MSIZE)).str(r.str() === '9P2000.L' ? '9P2000.L' : 'unknown');
        return;
      }
      case 104: { // Tattach: fid, afid, uname, aname, n_uname
        const fid = r.u32();
        this.fids.set(fid, this.root);
        w.qid(this.root);
        return;
      }
      case 110: { // Twalk: fid, newfid, nwname, names
        let n = this.fid(r);
        const newfid = r.u32();
        const names = Array.from({ length: r.u16() }, () => r.str());
        const qids: Node[] = [];
        for (const name of names) {
          const next = !n.children ? undefined : name === '..' ? n.parent : name === '.' ? n : n.children.get(name);
          if (!next) break;
          qids.push((n = next));
        }
        if (qids.length === 0 && names.length > 0) throw new Err(ENOENT);
        if (qids.length === names.length) this.fids.set(newfid, n);
        w.u16(qids.length);
        for (const q of qids) w.qid(q);
        return;
      }
      case 12: { // Tlopen: fid, flags
        const n = this.fid(r);
        if (r.u32() & 0o1000 && !n.children) this.resize(n, 0); // O_TRUNC
        w.qid(n).u32(0);
        return;
      }
      case 14: { // Tlcreate: fid (the directory, then the new file), name, flags, mode, gid
        const k = r.k;
        const d = this.dir(r);
        const name = r.str();
        r.u32();
        const f = this.create(d, name, S_IFREG | (r.u32() & 0o7777), r.u32());
        r.k = k;
        this.fids.set(r.u32(), f);
        w.qid(f).u32(0);
        return;
      }
      case 116: { // Tread: fid, offset, count
        const n = this.fid(r);
        if (n.children) throw new Err(EISDIR);
        const off = r.u64();
        const count = Math.min(r.u32(), room - 11);
        const data = off < n.size ? n.data.subarray(off, Math.min(n.size, off + count)) : new Uint8Array(0);
        n.atime = now;
        w.u32(data.length).bytes(data);
        return;
      }
      case 118: { // Twrite: fid, offset, count, data
        const n = this.fid(r);
        if (n.children) throw new Err(EISDIR);
        const off = r.u64();
        const data = r.bytes(r.u32());
        if (off + data.length > n.size) this.resize(n, off + data.length);
        n.data.set(data, off);
        n.mtime = n.ctime = now;
        w.u32(data.length);
        return;
      }
      case 40: { // Treaddir: fid, offset, count; entries qid, offset, type, name
        const d = this.dir(r);
        const off = r.u64();
        const count = Math.min(r.u32(), room - 11);
        const all: [string, Node][] = [['.', d], ['..', d.parent], ...d.children!];
        const e = new Writer();
        e.k = 0;
        for (let k = off; k < all.length; k++) {
          const [name, n] = all[k];
          const t = n.mode & S_IFMT;
          const before = e.k;
          e.qid(n).u64(k + 1).u8(t === S_IFDIR ? 4 : t === S_IFLNK ? 10 : t === S_IFREG ? 8 : 0).str(name);
          if (e.k > count) {
            e.k = before;
            break;
          }
        }
        w.u32(e.k).bytes(e.b.subarray(0, e.k));
        return;
      }
      case 24: { // Tgetattr: fid, request_mask
        const n = this.fid(r);
        w.u64(0x7ff).qid(n).u32(n.mode).u32(n.uid).u32(n.gid).u64(n.nlink).u64(0).u64(n.size).u64(4096).u64(Math.ceil(n.size / 512));
        for (const t of [n.atime, n.mtime, n.ctime, 0]) w.u64(t).u64(0);
        w.u64(0).u64(0); // gen, data_version
        return;
      }
      case 26: { // Tsetattr: fid, valid, mode, uid, gid, size, atime, mtime (seconds, nanoseconds)
        const n = this.fid(r);
        const [valid, mode, uid, gid, size, as] = [r.u32(), r.u32(), r.u32(), r.u32(), r.u64(), r.u64()];
        r.u64();
        const ms = r.u64();
        if (valid & 1) n.mode = (n.mode & S_IFMT) | (mode & 0o7777);
        if (valid & 2) n.uid = uid;
        if (valid & 4) n.gid = gid;
        if (valid & 8) {
          if (n.children) throw new Err(EISDIR);
          this.resize(n, size);
          n.mtime = now;
        }
        if (valid & 16) n.atime = valid & 128 ? as : now;
        if (valid & 32) n.mtime = valid & 256 ? ms : now;
        n.ctime = now;
        return;
      }
      case 72: { // Tmkdir: dfid, name, mode, gid
        const d = this.dir(r);
        const name = r.str();
        const n = this.create(d, name, S_IFDIR | (r.u32() & 0o7777), r.u32());
        d.nlink++;
        w.qid(n);
        return;
      }
      case 16: { // Tsymlink: fid, name, target, gid
        const d = this.dir(r);
        const [name, target] = [r.str(), r.str()];
        const n = this.create(d, name, S_IFLNK | 0o777, r.u32());
        n.target = target;
        n.size = new TextEncoder().encode(target).length;
        w.qid(n);
        return;
      }
      case 18: { // Tmknod: dfid, name, mode, major, minor, gid
        const d = this.dir(r);
        const name = r.str();
        const mode = r.u32();
        r.u32();
        r.u32();
        if ((mode & S_IFMT) === S_IFDIR || (mode & S_IFMT) === S_IFLNK) throw new Err(EINVAL);
        w.qid(this.create(d, name, mode, r.u32()));
        return;
      }
      case 22: { // Treadlink: fid
        const n = this.fid(r);
        if ((n.mode & S_IFMT) !== S_IFLNK) throw new Err(EINVAL);
        w.str(n.target);
        return;
      }
      case 70: { // Tlink: dfid, fid, name
        const d = this.dir(r);
        const n = this.fid(r);
        if (n.children) throw new Err(EISDIR);
        const name = r.str();
        if (d.children!.has(name)) throw new Err(EEXIST);
        this.link(d, name, n);
        n.nlink++;
        n.ctime = now;
        return;
      }
      case 74: { // Trenameat: olddirfid, oldname, newdirfid, newname
        const od = this.dir(r);
        const oname = r.str();
        const nd = this.dir(r);
        const nname = r.str();
        const n = od.children!.get(oname);
        if (!n) throw new Err(ENOENT);
        const old = nd.children!.get(nname);
        if (old === n) return;
        if (old) this.unlink(nd, nname, !!old.children);
        od.children!.delete(oname);
        this.link(nd, nname, n);
        if (n.children) {
          [od.nlink, nd.nlink] = [od.nlink - 1, nd.nlink + 1];
          n.parent = nd;
        }
        od.mtime = od.ctime = n.ctime = now;
        return;
      }
      case 76: { // Tunlinkat: dirfd, name, flags (AT_REMOVEDIR 0x200)
        const d = this.dir(r);
        const name = r.str();
        const rmdir = (r.u32() & 0x200) !== 0;
        this.unlink(d, name, rmdir);
        if (rmdir) d.nlink--;
        return;
      }
      case 120: // Tclunk: fid
        if (!this.fids.delete(r.u32())) throw new Err(EBADF);
        return;
      case 122: { // Tremove: fid, clunked even if the remove fails
        const k = r.k;
        const n = this.fid(r);
        this.fids.delete((r.k = k, r.u32()));
        const name = [...n.parent.children!].find(([, c]) => c === n)?.[0];
        if (name === undefined || n === this.root) throw new Err(ENOENT);
        this.unlink(n.parent, name, !!n.children);
        if (n.children) n.parent.nlink--;
        return;
      }
      case 108: // Tflush: oldtag (every request is answered at once)
      case 50: // Tfsync
        return;
      case 8: // Tstatfs: type V9FS_MAGIC, bsize, blocks, bfree, bavail, files, ffree, fsid, namelen
        this.fid(r);
        w.u32(0x01021997).u32(4096).u64(1 << 18).u64(1 << 18).u64(1 << 18).u64(1 << 16).u64(1 << 16).u64(0).u32(255);
        return;
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
      default: // xattrs and the rest
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

/** The virtio-9p backend around a server on `files`. */
export function p9(ctx: Ctx, files: P9Files, deterministic: boolean) {
  const server = new P9Server(files, deterministic);
  return {
    request(r: Request) {
      const ram = ctx.ram();
      const len = r.read.reduce((n, s) => n + s.len, 0);
      const room = r.write.reduce((n, s) => n + s.len, 0);
      const m = gather(ram, r.read, len);
      const size = len < 7 ? 0 : new DataView(m.buffer, m.byteOffset).getUint32(0, true);
      if (size < 7 || size > len || room < 11) return 0; // malformed: no answer
      const reply = server.handle(m.slice(0, size), room);
      if (reply.length > room) return 0;
      scatter(ram, r.write, reply);
      return reply.length;
    },
    reset() {},
  };
}
