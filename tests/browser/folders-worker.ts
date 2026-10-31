// tests/folders.test.ts's worker: `P9Server` over a `FolderTree` on directories in OPFS, through each backend (the host
// backend on OPFS: the asynchronous API alone), asked as Linux's v9fs asks. Answers each case's failure, if any.
import { P9Server } from '../../web/9p.ts';
import { FolderTree, type FolderSpec } from '../../web/9p-folders.ts';

const [EPERM, ENOENT, EIO, EBADF, EACCES, EEXIST, EXDEV, ENOTDIR, EISDIR, EINVAL, EROFS, ENOTEMPTY, ESTALE] = [1, 2, 5, 9, 13, 17, 18, 20, 21, 22, 30, 39, 116];
const O_WRONLY = 1;
const O_RDWR = 2;
const O_TRUNC = 0o1000;
const text = new TextDecoder();
const same = (a: unknown, b: unknown, what: string) => {
  const [x, y] = [JSON.stringify(a), JSON.stringify(b)];
  if (x !== y) throw new Error(`${what}: ${x}, not ${y}`);
};

/** A fixed-width field or a string, as tests/devices.test.ts writes them. */
type Field = string | [number, number] | Uint8Array;
const u16 = (v: number): Field => [2, v];
const u32 = (v: number): Field => [4, v];
const u64 = (v: number): Field => [8, v];

function msg(type: number, tag: number, fields: Field[]) {
  const parts: Uint8Array[] = [];
  for (const f of fields) {
    if (typeof f === 'string') {
      const e = new TextEncoder().encode(f);
      parts.push(new Uint8Array([e.length & 0xff, e.length >> 8]), e);
    } else if (f instanceof Uint8Array) parts.push(f);
    else parts.push(Uint8Array.from({ length: f[0] }, (_, k) => Number((BigInt(f[1]) >> BigInt(8 * k)) & 0xffn)));
  }
  const m = new Uint8Array(7 + parts.reduce((n, p) => n + p.length, 0));
  new DataView(m.buffer).setUint32(0, m.length, true);
  [m[4], m[5], m[6]] = [type, tag & 0xff, tag >> 8];
  let k = 7;
  for (const p of parts) { m.set(p, k); k += p.length; }
  return m;
}

/** A client: fid numbers are its own, an answer's errno rejects with it. */
class Client {
  server: P9Server<never>;
  private next = 1;
  private tag = 1;
  root = 0;
  constructor(server: P9Server<never>) { this.server = server; }

  async call(type: number, fields: Field[]) {
    const r = await this.server.handle(msg(type, this.tag++ & 0xffff, fields), (1 << 20) + 4096);
    const v = new DataView(r.buffer, r.byteOffset, r.byteLength);
    if (r[4] === 7) throw Object.assign(new Error(`errno ${v.getUint32(7, true)}`), { errno: v.getUint32(7, true) });
    return { r: r.slice(), v: new DataView(r.slice().buffer) };
  }
  /** The errno it fails with. */
  errno(p: Promise<unknown>) { return p.then(() => 0, (e) => { if (e.errno === undefined) throw e; return e.errno as number; }); }

  async attach(uid = 1000) {
    await this.call(100, [u32(1 << 20), '9P2000.L']);
    await this.call(104, [u32(0), u32(0xffffffff), 'user', '', u32(uid)]);
  }
  async walk(path: string, from = this.root) {
    const names = path.split('/').filter(Boolean);
    const fid = this.next++;
    const { v } = await this.call(110, [u32(from), u32(fid), u16(names.length), ...names]);
    if (v.getUint16(7, true) !== names.length) throw Object.assign(new Error('partial walk'), { errno: ENOENT });
    return fid;
  }
  open(fid: number, flags = 0) { return this.call(12, [u32(fid), u32(flags)]); }
  async create(dir: string, name: string, mode = 0o644, flags = O_WRONLY) {
    const fid = await this.walk(dir);
    await this.call(14, [u32(fid), name, u32(flags), u32(mode), u32(0)]);
    return fid;
  }
  async read(fid: number, off = 0, count = 1 << 20) {
    const { r } = await this.call(116, [u32(fid), u64(off), u32(count)]);
    return r.subarray(11);
  }
  async write(fid: number, off: number, data: Uint8Array | string) {
    const b = typeof data === 'string' ? new TextEncoder().encode(data) : data;
    await this.call(118, [u32(fid), u64(off), u32(b.length), b]);
  }
  clunk(fid: number) { return this.call(120, [u32(fid)]); }
  async stat(fid: number) {
    const { v } = await this.call(24, [u32(fid), u64(0x7ff)]);
    return { qid: Number(v.getBigUint64(20, true)), mode: v.getUint32(28, true), uid: v.getUint32(32, true), gid: v.getUint32(36, true), size: Number(v.getBigUint64(56, true)), mtime: Number(v.getBigUint64(96, true)) };
  }
  async statPath(path: string) { const f = await this.walk(path); const s = await this.stat(f); await this.clunk(f); return s; }
  async readPath(path: string) { const f = await this.walk(path); await this.open(f); const b = await this.read(f); await this.clunk(f); return text.decode(b); }
  async put(dir: string, name: string, data: string | Uint8Array) { const f = await this.create(dir, name); await this.write(f, 0, data); await this.clunk(f); }
  async mkdir(dir: string, name: string) { const f = await this.walk(dir); await this.call(72, [u32(f), name, u32(0o755), u32(0)]); await this.clunk(f); }
  async rename(a: string, an: string, b: string, bn: string) { const [x, y] = [await this.walk(a), await this.walk(b)]; try { await this.call(74, [u32(x), an, u32(y), bn]); } finally { await this.clunk(x); await this.clunk(y); } }
  async unlink(dir: string, name: string, rmdir = false) { const f = await this.walk(dir); try { await this.call(76, [u32(f), name, u32(rmdir ? 0x200 : 0)]); } finally { await this.clunk(f); } }
  async truncate(path: string, size: number) { const f = await this.walk(path); await this.call(26, [u32(f), u32(8), u32(0), u32(0), u32(0), u64(size), u64(0), u64(0), u64(0), u64(0)]); await this.clunk(f); }
  async chmod(path: string, mode: number) { const f = await this.walk(path); await this.call(26, [u32(f), u32(1), u32(mode), u32(0), u32(0), u64(0), u64(0), u64(0), u64(0), u64(0)]); await this.clunk(f); }
  async ls(path: string, count = 4096) {
    const f = await this.walk(path);
    await this.open(f);
    const out: string[] = [];
    for (let off = 0; ;) {
      const { r } = await this.call(40, [u32(f), u64(off), u32(count)]);
      if (r.length === 11) break;
      for (let k = 11; k < r.length;) {
        const n = r[k + 22] | r[k + 23] << 8;
        out.push(text.decode(r.subarray(k + 24, k + 24 + n)));
        off = Number(new DataView(r.buffer, r.byteOffset).getBigUint64(k + 13, true));
        k += 24 + n;
      }
    }
    await this.clunk(f);
    return out.filter((n) => n !== '.' && n !== '..').sort();
  }
}

type Rig = { c: Client; tree: FolderTree; denied: string[]; dir: FileSystemDirectoryHandle; other: FileSystemDirectoryHandle; ro: FileSystemDirectoryHandle };

/** The cases, each on fresh folders: `a` and `b` writable, `ro` read-only. `kind` is the backend. */
const cases: Record<string, (r: Rig, kind: string) => Promise<void>> = {
  async 'the root lists the folders and is the server\'s'({ c }) {
    same(await c.ls(''), ['a', 'b', 'ro'], 'the root');
    const root = await c.stat(0);
    same([root.mode, root.uid], [0o040555, 1000], 'the root\'s mode and owner');
    same(await c.errno(c.create('', 'x')), EACCES, 'a file at the root');
    same(await c.errno(c.rename('', 'a', 'a', 'z')), EXDEV, 'a folder moved');
    same(await c.errno(c.walk('c')), ENOENT, 'no such folder');
  },
  async 'files: create, write, read back, stat, readdir, unlink'({ c }) {
    await c.put('a', 'f', 'hello');
    same(await c.readPath('a/f'), 'hello', 'read');
    const s = await c.statPath('a/f');
    same([s.mode, s.uid, s.gid, s.size], [0o100644, 1000, 1000, 5], 'stat');
    if (Math.abs(s.mtime - Date.now() / 1000) > 5) throw new Error(`mtime ${s.mtime}`);
    same(await c.statPath('a/f').then((x) => x.qid), s.qid, 'the qid stays');
    await c.mkdir('a', 'd');
    same((await c.statPath('a/d')).mode, 0o040755, 'mkdir\'s mode');
    same(await c.ls('a'), ['d', 'f'], 'readdir');
    same(await c.errno(c.put('a', 'f', 'x')), EEXIST, 'create over a file');
    same(await c.errno(c.mkdir('a', 'f')), EEXIST, 'mkdir over a file');
    same(await c.errno(c.unlink('a', 'd')), EISDIR, 'unlink of a directory');
    same(await c.errno(c.unlink('a', 'f', true)), ENOTDIR, 'rmdir of a file');
    await c.put('a/d', 'g', '');
    same(await c.errno(c.unlink('a', 'd', true)), ENOTEMPTY, 'rmdir of a full directory');
    await c.unlink('a/d', 'g');
    await c.unlink('a', 'd', true);
    await c.unlink('a', 'f');
    same(await c.ls('a'), [], 'emptied');
    same(await c.errno(c.unlink('a', 'f')), ENOENT, 'unlink again');
  },
  async 'a big directory reads in pieces, from one listing'({ c, dir }) {
    for (let k = 0; k < 300; k++) await (await dir.getFileHandle(`file-${k}`, { create: true })).createWritable().then((w) => w.close());
    const f = await c.walk('a');
    await c.open(f);
    const first = await c.call(40, [u32(f), u64(0), u32(512)]);
    await dir.removeEntry('file-299'); // a change mid-listing neither skips nor repeats
    const names = new Set<string>();
    for (let off = 0, r = first.r; r.length > 11;) {
      for (let k = 11; k < r.length;) {
        const n = r[k + 22] | r[k + 23] << 8;
        names.add(text.decode(r.subarray(k + 24, k + 24 + n)));
        off = Number(new DataView(r.buffer, r.byteOffset).getBigUint64(k + 13, true));
        k += 24 + n;
      }
      r = (await c.call(40, [u32(f), u64(off), u32(512)])).r;
    }
    same(names.size, 302, 'every entry once');
    await c.clunk(f);
  },
  async 'writes: in pieces, past the end, read while writing, truncate'({ c }) {
    const f = await c.create('a', 'f', 0o644, O_RDWR);
    await c.write(f, 0, 'aaaa');
    await c.write(f, 2, 'bbbb');
    same(text.decode(await c.read(f)), 'aabbbb', 'read back through the writing fid');
    await c.write(f, 8, 'c');
    same([...await c.read(f, 5)], [98, 0, 0, 99], 'the hole reads zeros');
    same((await c.stat(f)).size, 9, 'the size while writing');
    const big = new Uint8Array(1 << 20).fill(5);
    await c.write(f, 1 << 20, big);
    same((await c.read(f, (1 << 20) - 1, 2)).length, 2, 'a read across the write');
    await c.clunk(f);
    same((await c.statPath('a/f')).size, 2 << 20, 'the size after');
    await c.truncate('a/f', 3);
    same(await c.readPath('a/f'), 'aab', 'truncated');
    const g = await c.walk('a/f');
    await c.open(g, O_WRONLY | O_TRUNC);
    same((await c.stat(g)).size, 0, 'O_TRUNC');
    await c.write(g, 0, 'new');
    await c.clunk(g);
    same(await c.readPath('a/f'), 'new', 'written after O_TRUNC');
    // Grown by truncate within a session: the bytes past the old end are zeros.
    const h = await c.walk('a/f');
    await c.open(h, O_RDWR);
    await c.write(h, 1, 'x');
    await c.call(26, [u32(h), u32(8), u32(0), u32(0), u32(0), u64(1), u64(0), u64(0), u64(0), u64(0)]);
    await c.call(26, [u32(h), u32(8), u32(0), u32(0), u32(0), u64(4), u64(0), u64(0), u64(0), u64(0)]);
    same([...await c.read(h)], [110, 0, 0, 0], 'cut and grown');
    await c.call(50, [u32(h), u32(0)]); // Tfsync lands it
    await c.write(h, 0, 'y');
    await c.clunk(h);
    same([...new TextEncoder().encode(await c.readPath('a/f'))], [121, 0, 0, 0], 'after an fsync, more writes');
  },
  async 'a write lands at the clunk, and two fids share a session'({ c, dir }, kind) {
    const [x, y] = [await c.create('a', 'f'), await c.walk('a/f')];
    await c.open(y, O_WRONLY);
    await c.write(x, 0, 'one');
    await c.clunk(x);
    await c.write(y, 3, 'two');
    await c.clunk(y);
    same(await (await (await dir.getFileHandle('f')).getFile()).text(), 'onetwo', `on the folder (${kind})`);
  },
  async 'modes: chmod and create\'s last the session; owners and times are no error'({ c }) {
    await c.put('a', 'f', '');
    const run = await c.create('a', 'g', 0o755);
    await c.clunk(run);
    same((await c.statPath('a/g')).mode, 0o100755, 'create\'s mode');
    await c.chmod('a/f', 0o700);
    same((await c.statPath('a/f')).mode, 0o100700, 'chmod');
    const f = await c.walk('a/f');
    await c.call(26, [u32(f), u32(2 | 4 | 16 | 32 | 128 | 256), u32(0), u32(0), u32(0), u64(0), u64(1), u64(0), u64(1), u64(0)]);
    same((await c.stat(f)).uid, 1000, 'chown does nothing');
    await c.clunk(f);
    const other = new Client(c.server);
    other.root = 90;
    await c.call(104, [u32(90), u32(0xffffffff), 'root', '', u32(0)]);
    same((await other.statPath('a/f')).uid, 0, 'each attach owns what it sees');
  },
  async 'no links or nodes'({ c }) {
    await c.put('a', 'f', '');
    const d = await c.walk('a');
    const f = await c.walk('a/f');
    same(await c.errno(c.call(16, [u32(d), 'l', 'f', u32(0)])), EPERM, 'symlink');
    same(await c.errno(c.call(70, [u32(d), u32(f), 'l'])), EPERM, 'link');
    same(await c.errno(c.call(18, [u32(d), 'n', u32(0o010644), u32(0), u32(0), u32(0)])), EPERM, 'mknod');
    same(await c.errno(c.call(14, [u32(d), 'a\\b', u32(O_WRONLY), u32(0o644), u32(0)])), EINVAL, 'a name a folder can\'t have');
  },
  async 'renames: files, over a file, directories with what\'s in them'({ c, dir }) {
    await c.put('a', 'f', 'one');
    await c.chmod('a/f', 0o600);
    const q = (await c.statPath('a/f')).qid;
    await c.rename('a', 'f', 'a', 'g');
    same(await c.readPath('a/g'), 'one', 'renamed');
    const moved = await c.statPath('a/g');
    same([moved.qid, moved.mode], [q, 0o100600], 'the qid and the mode move with it');
    same(await c.errno(c.walk('a/f')), ENOENT, 'the old name');
    await c.put('a', 'h', 'two');
    await c.rename('a', 'h', 'a', 'g');
    same(await c.readPath('a/g'), 'two', 'over a file');
    same(await c.ls('a'), ['g'], 'one file left');
    await c.mkdir('a', 'd');
    await c.mkdir('a/d', 'e');
    await c.put('a/d', 'x', 'in d');
    await c.put('a/d/e', 'y', 'in e');
    const inner = await c.walk('a/d/e/y');
    const wq = (await c.stat(inner)).qid;
    const w = await c.walk('a/d/x');
    await c.open(w, O_RDWR);
    await c.write(w, 0, 'IN');
    await c.rename('a', 'd', 'a', 'n');
    same(await c.ls('a'), ['g', 'n'], 'the directory moved');
    same(await c.readPath('a/n/e/y'), 'in e', 'deep in it');
    same(await c.readPath('a/n/x'), 'IN d', 'what was being written');
    same((await c.stat(inner)).qid, wq, 'a fid inside keeps working');
    await c.write(w, 2, ' D');
    await c.clunk(w);
    same(await c.readPath('a/n/x'), 'IN D', 'a fid inside goes on writing');
    await c.clunk(inner);
    same((await (await dir.getDirectoryHandle('n')).getDirectoryHandle('e')).kind, 'directory', 'on the folder');
    same(await c.errno(c.rename('a', 'n', 'a/n/e', 'm')), EINVAL, 'into itself');
    await c.mkdir('a', 'full');
    await c.put('a/full', 'z', '');
    same(await c.errno(c.rename('a', 'n', 'a', 'full')), ENOTEMPTY, 'over a full directory');
    same(await c.errno(c.rename('a', 'n', 'a', 'g')), ENOTDIR, 'over a file');
    same(await c.errno(c.rename('a', 'g', 'a', 'n')), EISDIR, 'a file over a directory');
    same(await c.errno(c.rename('a', 'g', 'b', 'g')), EXDEV, 'across folders');
    same(await c.errno(c.rename('nope', 'g', 'a', 'g').catch((e) => { throw e; })), ENOENT, 'from nowhere');
  },
  async 'a file removed while open lives on until its last clunk'({ c }) {
    await c.put('a', 'f', 'data');
    const f = await c.walk('a/f');
    await c.open(f, O_RDWR);
    await c.unlink('a', 'f');
    same(await c.errno(c.walk('a/f')), ENOENT, 'its name is gone');
    same(text.decode(await c.read(f)), 'data', 'read on');
    await c.write(f, 4, '+more');
    same(text.decode(await c.read(f)), 'data+more', 'written on');
    same((await c.stat(f)).size, 9, 'its size');
    await c.clunk(f);
    await c.put('a', 'f', 'new');
    const g = await c.walk('a/f');
    await c.open(g);
    await c.put('a', 'h', 'over');
    await c.rename('a', 'h', 'a', 'f');
    same(text.decode(await c.read(g)), 'new', 'replaced by a rename while open');
    await c.clunk(g);
    same(await c.readPath('a/f'), 'over', 'the new one');
    // A fid that isn't open has nothing to keep.
    const n = await c.walk('a/f');
    await c.unlink('a', 'f');
    same(await c.errno(c.stat(n)), ESTALE, 'a fid of a removed file');
  },
  async 'read-only'({ c, ro }) {
    const w = await (await ro.getFileHandle('kept', { create: true })).createWritable();
    await w.write('kept');
    await w.close();
    same(await c.readPath('ro/kept'), 'kept', 'a read');
    same(await c.errno(c.put('ro', 'x', '')), EROFS, 'create');
    const f = await c.walk('ro/kept');
    same(await c.errno(c.open(f, O_WRONLY)), EROFS, 'open for writing');
    same(await c.errno(c.mkdir('ro', 'x')), EROFS, 'mkdir');
    same(await c.errno(c.unlink('ro', 'kept')), EROFS, 'unlink');
    same(await c.errno(c.rename('ro', 'kept', 'ro', 'y')), EROFS, 'rename');
    same(await c.errno(c.truncate('ro/kept', 0)), EROFS, 'truncate');
    same(await c.errno(c.chmod('ro/kept', 0o600)), EROFS, 'chmod');
  },
  async 'a write without a writing fid'({ c }) {
    await c.put('a', 'f', 'x');
    const f = await c.walk('a/f');
    await c.open(f);
    same(await c.errno(c.write(f, 0, 'y')), EBADF, 'a read-only fid');
    await c.clunk(f);
  },
  async 'a folder attached and detached while the machine runs'({ c, tree, other }) {
    await c.put('b', 'f', 'hello');
    const inside = await c.walk('b/f');
    await c.open(inside, O_RDWR);
    await c.write(inside, 0, 'J');
    await tree.detach('b');
    same(await c.ls(''), ['a', 'ro'], 'gone from the root');
    same(await c.errno(c.stat(inside)), ESTALE, 'a fid into it');
    same(await c.errno(c.read(inside)), ESTALE, 'a read');
    same(await (await (await other.getFileHandle('f')).getFile()).text(), 'Jello', 'what it wrote landed');
    tree.attach({ id: 'b', name: 'back', kind: 'opfs', readOnly: false, handle: other });
    same(await c.ls(''), ['a', 'back', 'ro'], 'attached');
    same(await c.readPath('back/f'), 'Jello', 'read');
  },
  async 'what the host changes is seen'({ c, dir }) {
    await c.put('a', 'f', 'one');
    same(await c.ls('a'), ['f'], 'first');
    await new Promise((r) => setTimeout(r, 1100));
    const w = await (await dir.getFileHandle('g', { create: true })).createWritable();
    await w.write('host');
    await w.close();
    await dir.removeEntry('f');
    same(await c.ls('a'), ['g'], 'a listing');
    same(await c.errno(c.walk('a/f')), ENOENT, 'a walk');
    same(await c.readPath('a/g'), 'host', 'a read');
  },
  async 'a grant lost, and back'({ c, tree, denied, dir }, kind) {
    await c.put('a', 'f', 'x');
    const real = dir.getFileHandle;
    // What a revoked grant does: every call on the folder is refused.
    const refuse = () => Promise.reject(new DOMException('revoked', 'NotAllowedError'));
    await new Promise((r) => setTimeout(r, 1100));
    (dir as { getFileHandle: unknown }).getFileHandle = refuse;
    same(await c.errno(c.walk('a/f')), EACCES, `a walk (${kind})`);
    same(denied, ['a'], 'the page is told once');
    same(await c.errno(c.walk('a/g')), EACCES, 'later calls');
    same(denied, ['a'], 'still once');
    (dir as { getFileHandle: unknown }).getFileHandle = real;
    tree.granted('a');
    same(await c.readPath('a/f'), 'x', 'granted again');
  },
  async 'a host change under an open file is read anew'({ c, dir }, kind) {
    await c.put('a', 'f', 'one');
    const f = await c.walk('a/f');
    await c.open(f);
    same(text.decode(await c.read(f)), 'one', 'first');
    if (kind === 'host') {
      await new Promise((r) => setTimeout(r, 20));
      const w = await (await dir.getFileHandle('f')).createWritable();
      await w.write('changed');
      await w.close();
      same(text.decode(await c.read(f)), 'changed', 'NotReadableError takes a new File');
    }
    await c.clunk(f);
  },
  async 'requests in parallel: one file\'s stay in order'({ c }) {
    const f = await c.create('a', 'f', 0o644, O_RDWR);
    const parts = Array.from({ length: 64 }, (_, k) => c.write(f, k * 8, String(k).padStart(8, '0')));
    const clunk = (async () => { await Promise.all(parts); })();
    const other = Array.from({ length: 8 }, (_, k) => c.put('a', `g${k}`, 'x'));
    await Promise.all([clunk, ...other]);
    same(text.decode(await c.read(f, 16, 8)), '00000002', 'the writes');
    const size = c.stat(f);
    const end = c.clunk(f); // after the stat, whatever each costs
    same((await size).size, 512, 'in order');
    await end;
    same((await c.ls('a')).length, 9, 'the others');
  },
  async 'a failed write lands nothing and says so until the last clunk'({ c, dir }, kind) {
    if (kind !== 'host') return;
    await c.put('a', 'f', 'old');
    const f = await c.walk('a/f');
    await c.open(f, O_RDWR);
    await c.write(f, 3, '+new');
    const proto = FileSystemWritableFileStream.prototype;
    const real = proto.write;
    proto.write = function () { proto.write = real; return Promise.reject(new DOMException('full', 'QuotaExceededError')); };
    same(await c.errno(c.write(f, 7, 'x')), 28, 'the failed write');
    same(await c.errno(c.write(f, 7, 'x')), EIO, 'a later write');
    same(await c.errno(c.call(50, [u32(f), u32(0)])), EIO, 'fsync says so');
    await c.clunk(f);
    same(await (await (await dir.getFileHandle('f')).getFile()).text(), 'old', 'the file is as it was');
    const g = await c.walk('a/f');
    await c.open(g, O_WRONLY);
    await c.write(g, 0, 'NEW');
    await c.clunk(g);
    same(await c.readPath('a/f'), 'NEW', 'a new open starts clean');
  },
  async 'a create without write flags leaves no writer'({ c, dir }) {
    const f = await c.create('a', 'f', 0o644, 0);
    await c.clunk(f);
    const g = await c.walk('a/f');
    await c.open(g, O_WRONLY);
    await c.write(g, 0, 'landed');
    await c.clunk(g);
    same(await (await (await dir.getFileHandle('f')).getFile()).text(), 'landed', 'on the folder at the clunk');
  },
  async 'a remove that fails keeps the file live'({ c, dir }) {
    await c.put('a', 'f', 'data');
    const f = await c.walk('a/f');
    await c.open(f, O_RDWR);
    const real = dir.removeEntry;
    (dir as { removeEntry: unknown }).removeEntry = () => Promise.reject(new DOMException('no', 'NoModificationAllowedError'));
    same(await c.errno(c.unlink('a', 'f')), 16, 'EBUSY');
    (dir as { removeEntry: unknown }).removeEntry = real;
    await c.write(f, 0, 'DATA');
    await c.clunk(f);
    same(await (await (await dir.getFileHandle('f')).getFile()).text(), 'DATA', 'its writes reach the file');
  },
  async 'a directory rename that fails goes back'({ c, dir }) {
    await c.mkdir('a', 'd');
    await c.put('a/d', 'x', 'one');
    await c.put('a/d', 'y', 'two');
    await c.put('a/d', 'z', 'three');
    const proto = FileSystemFileHandle.prototype as unknown as { move(d: unknown, n: string): Promise<void> };
    const real = proto.move;
    let n = 0;
    proto.move = function (d, name) { if (++n === 2) return Promise.reject(new DOMException('full', 'QuotaExceededError')); return real.call(this, d, name); };
    const e = await c.errno(c.rename('a', 'd', 'a', 'n'));
    proto.move = real;
    same(e, 28, 'ENOSPC');
    same(await c.ls('a/d'), ['x', 'y', 'z'], 'all back');
    same(await c.ls('a'), ['d'], 'no half of it under the new name');
    same(await c.readPath('a/d/x'), 'one', 'read');
    void dir;
  },
  async 'Tversion again: open fids end once'({ c, tree, dir }) {
    await c.put('a', 'f', 'x');
    const f = await c.walk('a/f');
    await c.open(f, O_WRONLY);
    await c.write(f, 0, 'y');
    await c.call(100, [u32(1 << 20), '9P2000.L']);
    same(await (await (await dir.getFileHandle('f')).getFile()).text(), 'y', 'landed');
    await c.call(104, [u32(0), u32(0xffffffff), 'user', '', u32(1000)]);
    const g = await c.walk('a/f');
    await c.open(g, O_WRONLY);
    await c.write(g, 0, 'z');
    await c.clunk(g);
    same(await (await (await dir.getFileHandle('f')).getFile()).text(), 'z', 'counts right after it');
    void tree;
  },
  async 'a rename onto its own other case'({ c, dir }, kind) {
    await c.put('a', 'f', 'x');
    const real = dir.getFileHandle.bind(dir);
    // A host that ignores case: F is f.
    (dir as { getFileHandle: unknown }).getFileHandle = (n: string, o?: object) => real(n === 'F' ? 'f' : n, o);
    await new Promise((r) => setTimeout(r, 1100));
    const e = await c.errno(c.rename('a', 'f', 'a', 'F'));
    (dir as { getFileHandle: unknown }).getFileHandle = real;
    same(e, 0, 'no error');
    same(await (await (await dir.getFileHandle('F')).getFile()).text(), 'x', `the file lives (${kind})`);
  },
  async 'a snapshot: fids that were stale stay stale, only what counts is kept'({ c, tree, dir }) {
    await c.put('a', 'keep', 'x');
    await dir.getFileHandle('other', { create: true });
    await c.ls('a');
    same((await c.statPath('a/other')).mode, 0o100666, 'a file nothing said a mode for');
    const f = await c.walk('a/keep');
    const dead = await c.walk('b');
    await tree.detach('b');
    const s = tree.save((c.server as unknown as P9Server<never>).open);
    same(s.nodes.some((x) => x.path.includes('other')), false, 'a node nothing points at');
    same(s.fids.some((x) => x.fid === f), true, 'a live fid');
    const next = new FolderTree([]);
    const d = new Client(new P9Server(next) as P9Server<never>);
    next.restore(s, d.server.open as never);
    same(await d.errno(d.stat(dead)), ESTALE, 'a fid of a detached folder');
  },
  async 'statfs'({ c }, kind) {
    const f = await c.walk('a');
    const { v } = await c.call(8, [u32(f)]);
    const blocks = Number(v.getBigUint64(15, true));
    if (kind === 'host' ? blocks !== 2 ** 28 : blocks <= 0 || blocks === 2 ** 28) throw new Error(`blocks ${blocks}`);
  },
};

onmessage = async () => {
  const failed: string[] = [];
  const passed: string[] = [];
  const base = await (await navigator.storage.getDirectory()).getDirectoryHandle('folders-test', { create: true });
  for (const kind of ['opfs', 'host'] as const) {
    for (const [name, run] of Object.entries(cases)) {
      const top = await base.getDirectoryHandle(`${kind}-${Object.keys(cases).indexOf(name)}`, { create: true });
      const [dir, other, ro] = [await top.getDirectoryHandle('a', { create: true }), await top.getDirectoryHandle('b', { create: true }), await top.getDirectoryHandle('ro', { create: true })];
      const specs: FolderSpec[] = [{ id: 'a', name: 'a', kind, readOnly: false, handle: dir }, { id: 'b', name: 'b', kind, readOnly: false, handle: other }, { id: 'ro', name: 'ro', kind, readOnly: true, handle: ro }];
      const denied: string[] = [];
      const tree = new FolderTree(specs, (id) => denied.push(id));
      const c = new Client(new P9Server(tree) as P9Server<never>);
      try {
        await c.attach();
        await Promise.race([run({ c, tree, denied, dir, other, ro }, kind), new Promise((_, no) => setTimeout(() => no(new Error('timed out')), 10000))]);
        passed.push(`${kind}: ${name}`);
      } catch (e) {
        failed.push(`${kind}: ${name}: ${(e as Error).stack}`);
      }
      await Promise.race([tree.flush(), new Promise((r) => setTimeout(r, 1000))]);
      console.log(`${kind}: ${name}: done`);
    }
  }
  await (await navigator.storage.getDirectory()).removeEntry('folders-test', { recursive: true }).catch(() => {});
  postMessage({ passed, failed });
};
