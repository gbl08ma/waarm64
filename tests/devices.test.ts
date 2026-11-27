// Device backends without a guest: the 9P2000.L server (web/9p.ts), the
// loopback network adapter (web/net.ts), virtio-input's config answers and queue, and
// the blk and net backends' I/O counters (the page's status, `Ctx.io`), the
// poll's records from before a reset, and the doorbell's server's end
// (`Devices.serve`, parallel mode in Node).
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { test } from 'node:test';
import { MemoryTree, p9Backend, P9Server, type P9Tree } from '../web/9p.ts';
import { deviceEntry, Devices } from '../web/devices.ts';
import { blk } from '../web/blk-device.ts';
import { inputConfig, trimInput } from '../web/input-device.ts';
import { net } from '../web/net-device.ts';
import type { Ctx } from '../web/virtio.ts';
import { memFile } from '../web/overlay.ts';
import { loopback, PEER_IP, PEER_MAC } from '../web/net.ts';

/** A T-message: size, type, tag 1, then the fields ([bytes, value], a string or raw bytes). */
function msg(type: number, ...fields: (string | [number, number] | Uint8Array)[]) {
  const parts: number[] = [];
  for (const f of fields) {
    if (f instanceof Uint8Array) parts.push(...f);
    else if (typeof f === 'string') {
      const e = new TextEncoder().encode(f);
      parts.push(e.length & 0xff, e.length >> 8, ...e);
    } else for (let k = 0; k < f[0]; k++) parts.push(Number((BigInt(f[1]) >> BigInt(8 * k)) & 0xffn));
  }
  const m = new Uint8Array([0, 0, 0, 0, type, 1, 0, ...parts]);
  new DataView(m.buffer).setUint32(0, m.length, true);
  return m;
}
const u32 = (v: number): [number, number] => [4, v];
const u64 = (v: number): [number, number] => [8, v];

test('9p server: create, write, read, readdir, rename, symlink, unlink', () => {
  const s = new P9Server(new MemoryTree({ 'hello.txt': 'hi\n' }, true));
  const call = (m: Uint8Array) => {
    const r = s.handle(m, 8192) as Uint8Array;
    const v = new DataView(r.buffer, r.byteOffset, r.byteLength);
    assert.equal(v.getUint32(0, true), r.length);
    assert.equal(v.getUint16(5, true), 1, 'tag echoed');
    return { type: r[4], v, r };
  };
  const ok = (m: Uint8Array) => {
    const a = call(m);
    assert.equal(a.type, m[4] + 1, a.type === 7 ? `errno ${a.v.getUint32(7, true)}` : '');
    return a;
  };
  assert.equal(ok(msg(100, u32(1 << 30), '9P2000.L')).v.getUint32(7, true), 1 << 20, 'msize capped');
  ok(msg(104, u32(0), u32(~0 >>> 0), 'root', '', u32(0)));
  // Walk to hello.txt and read it.
  assert.equal(ok(msg(110, u32(0), u32(1), [2, 1], 'hello.txt')).v.getUint16(7, true), 1);
  ok(msg(12, u32(1), u32(0)));
  const rd = ok(msg(116, u32(1), u64(0), u32(100)));
  assert.equal(new TextDecoder().decode(rd.r.subarray(11)), 'hi\n');
  // A missing name: ENOENT.
  const miss = call(msg(110, u32(0), u32(2), [2, 1], 'nope'));
  assert.deepEqual([miss.type, miss.v.getUint32(7, true)], [7, 2]);
  // Create d/f through a clone of the root, write past the end, read back.
  ok(msg(110, u32(0), u32(2), [2, 0]));
  ok(msg(72, u32(2), 'd', u32(0o755), u32(0)));
  ok(msg(110, u32(0), u32(3), [2, 1], 'd'));
  ok(msg(14, u32(3), 'f', u32(0), u32(0o644), u32(0)));
  assert.equal(ok(msg(118, u32(3), u64(4), u32(3), [3, 0x636261])).v.getUint32(7, true), 3);
  assert.deepEqual([...ok(msg(116, u32(3), u64(0), u32(100))).r.subarray(11)], [0, 0, 0, 0, 0x61, 0x62, 0x63]);
  // getattr: regular file, 7 bytes, the fixed deterministic time.
  const ga = ok(msg(24, u32(3), u64(0x7ff)));
  assert.equal(ga.v.getUint32(28, true) & 0o170000, 0o100000);
  assert.equal(Number(ga.v.getBigUint64(56, true)), 7);
  assert.equal(Number(ga.v.getBigUint64(96, true)), 1788220800);
  // Rename d/f to top-level g, symlink l → g, then readdir the root.
  ok(msg(74, u32(2), 'd', u32(2), 'e'));
  ok(msg(110, u32(0), u32(4), [2, 1], 'e'));
  ok(msg(74, u32(4), 'f', u32(0), 'g'));
  ok(msg(16, u32(0), 'l', 'g', u32(0)));
  const names = (fid: number) => {
    const r = ok(msg(40, u32(fid), u64(0), u32(4096))).r;
    const out = [];
    for (let k = 11; k < r.length;) {
      const n = r[k + 22] | (r[k + 23] << 8);
      out.push(new TextDecoder().decode(r.subarray(k + 24, k + 24 + n)));
      k += 24 + n;
    }
    return out;
  };
  assert.deepEqual(names(2), ['.', '..', 'hello.txt', 'e', 'g', 'l']);
  // rmdir of a non-empty directory fails; unlink works.
  ok(msg(110, u32(0), u32(5), [2, 1], 'l'));
  assert.equal(new TextDecoder().decode(ok(msg(22, u32(5))).r.subarray(9)), 'g');
  ok(msg(76, u32(0), 'l', u32(0)));
  ok(msg(76, u32(0), 'e', u32(0x200)));
  assert.deepEqual(names(2), ['.', '..', 'hello.txt', 'g']);
  // Unsupported (a 9P2000 Tstat): EOPNOTSUPP; truncated: EINVAL.
  assert.equal(call(msg(124, u32(0))).v.getUint32(7, true), 95);
  assert.equal(call(msg(118, u32(3), u64(0), u32(100))).v.getUint32(7, true), 22);
});

/** A POSIX ACL as Linux's xattr carries it: version 2, then [tag, perm, id] per entry. */
function acl(...entries: [number, number, number][]) {
  const b = new Uint8Array(4 + entries.length * 8);
  const v = new DataView(b.buffer);
  v.setUint32(0, 2, true);
  for (const [k, [tag, perm, id]] of entries.entries()) {
    v.setUint16(4 + k * 8, tag, true);
    v.setUint16(6 + k * 8, perm, true);
    v.setUint32(8 + k * 8, id, true);
  }
  return b;
}
const [USER_OBJ, USER, GROUP_OBJ, MASK, OTHER] = [1, 2, 4, 0x10, 0x20];
const TRANSCRIPT = new URL('./p9/transcript.txt', import.meta.url);

// What the guest relies on past the basics: readdir offsets that survive a listing's entries going, qid versions that
// change with the contents, nanosecond times, xattrs, and POSIX ACLs kept as a local file system keeps them. The
// exchanges are tests/p9/transcript.txt, which the native twin (core/tests/common/p9.rs) answers the same way
// (core/tests/p9.rs); P9_TRANSCRIPT=write records it again.
test('9p server: readdir offsets, qid versions, nanosecond times, xattrs, ACLs (and the native twin\'s transcript)', () => {
  const s = new P9Server(new MemoryTree({ 'hello.txt': 'hi\n' }, true));
  const lines: string[] = [];
  const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
  const call = (m: Uint8Array) => {
    const r = s.handle(m, 8192) as Uint8Array;
    lines.push(`${hex(m)} ${hex(r)}`);
    return { type: r[4], v: new DataView(r.buffer, r.byteOffset, r.byteLength), r };
  };
  const ok = (m: Uint8Array) => {
    const a = call(m);
    assert.equal(a.type, m[4] + 1, a.type === 7 ? `type ${m[4]}: errno ${a.v.getUint32(7, true)}` : '');
    return a;
  };
  const errno = (m: Uint8Array) => {
    const a = call(m);
    assert.equal(a.type, 7, `type ${m[4]} succeeded`);
    return a.v.getUint32(7, true);
  };
  const walk = (fid: number, newfid: number, ...names: string[]) => ok(msg(110, u32(fid), u32(newfid), [2, names.length], ...names));
  const clunk = (fid: number) => ok(msg(120, u32(fid)));
  const attr = (fid: number) => {
    const v = ok(msg(24, u32(fid), u64(0x7ff))).v;
    const big = (k: number) => Number(v.getBigUint64(k, true));
    return { version: v.getUint32(16, true), mode: v.getUint32(28, true), atime: [big(80), big(88)], mtime: [big(96), big(104)] };
  };
  /** Sets `name` on `fid`'s node through a clone (`via`), as v9fs does: Txattrcreate, Twrite, Tclunk; the clunk's answer. */
  const setx = (fid: number, name: string, value: Uint8Array, flags = 0) => {
    walk(fid, 90);
    ok(msg(32, u32(90), name, u64(value.length), u32(flags)));
    if (value.length) ok(msg(118, u32(90), u64(0), u32(value.length), value));
    return call(msg(120, u32(90)));
  };
  /** The value of `name` (empty: the names), or the errno. */
  const getx = (fid: number, name: string) => {
    const a = call(msg(30, u32(fid), u32(91), name));
    if (a.type === 7) return a.v.getUint32(7, true);
    const size = Number(a.v.getBigUint64(7, true));
    const data = ok(msg(116, u32(91), u64(0), u32(1000))).r.slice(11);
    assert.equal(data.length, size);
    clunk(91);
    return data;
  };
  const names = (r: Uint8Array) => {
    const out: [string, number][] = [];
    for (let k = 11; k < r.length;) {
      const n = r[k + 22] | (r[k + 23] << 8);
      out.push([new TextDecoder().decode(r.subarray(k + 24, k + 24 + n)), Number(new DataView(r.buffer, r.byteOffset + k + 13).getBigUint64(0, true))]);
      k += 24 + n;
    }
    return out;
  };

  ok(msg(100, u32(1 << 20), '9P2000.L'));
  ok(msg(104, u32(0), u32(~0 >>> 0), 'root', '', u32(0)));
  ok(msg(72, u32(0), 'd', u32(0o755), u32(0)));
  walk(0, 1, 'd');
  // Readdir offsets: five files, a listing that stops after two of them, the two removed, the rest from where it stopped.
  for (const f of ['a', 'b', 'c', 'x', 'y']) {
    walk(1, 10);
    ok(msg(14, u32(10), f, u32(0), u32(0o644), u32(0)));
    clunk(10);
  }
  walk(1, 2);
  ok(msg(12, u32(2), u32(0)));
  const first = names(ok(msg(40, u32(2), u64(0), u32(101))).r); // 25, 26, 25 and 25 bytes
  assert.deepEqual(first, [['.', 1], ['..', 2], ['a', 3], ['b', 4]]);
  ok(msg(76, u32(1), 'a', u32(0)));
  ok(msg(76, u32(1), 'b', u32(0)));
  assert.deepEqual(names(ok(msg(40, u32(2), u64(4), u32(4096))).r), [['c', 5], ['x', 6], ['y', 7]], 'none skipped');
  // A rename takes a new offset: a listing past its old one sees it once, at the end.
  ok(msg(74, u32(1), 'c', u32(1), 'z'));
  assert.deepEqual(names(ok(msg(40, u32(2), u64(5), u32(4096))).r), [['x', 6], ['y', 7], ['z', 8]]);
  assert.deepEqual(names(ok(msg(40, u32(2), u64(8), u32(4096))).r), [], 'the end');
  clunk(2);
  // qid versions: a file's moves with each write and truncate, a directory's with its entries; a chmod moves neither.
  walk(1, 3, 'x');
  const v0 = attr(3).version;
  ok(msg(12, u32(3), u32(2)));
  ok(msg(118, u32(3), u64(0), u32(3), new Uint8Array([1, 2, 3])));
  const v1 = attr(3).version;
  assert.ok(v1 > v0, `version ${v0} -> ${v1} after a write`);
  ok(msg(118, u32(3), u64(0), u32(1), new Uint8Array([9])));
  const v2 = attr(3).version;
  assert.ok(v2 > v1, 'an overwrite in place too');
  ok(msg(26, u32(3), u32(1), u32(0o600), u32(0), u32(0), u64(0), u64(0), u64(0), u64(0), u64(0)));
  assert.equal(attr(3).version, v2, 'chmod: the same contents');
  ok(msg(26, u32(3), u32(8), u32(0), u32(0), u32(0), u64(1), u64(0), u64(0), u64(0), u64(0)));
  assert.ok(attr(3).version > v2, 'a truncate');
  const dv = attr(1).version;
  walk(1, 10);
  ok(msg(14, u32(10), 'n', u32(0), u32(0o644), u32(0)));
  clunk(10);
  assert.ok(attr(1).version > dv, 'a directory with a new entry');
  // Explicit times keep their nanoseconds; "now" is the deterministic tree's EPOCH, at 0 ns.
  ok(msg(26, u32(3), u32(16 | 32 | 128 | 256), u32(0), u32(0), u32(0), u64(0), u64(100), u64(123456789), u64(200), u64(987654321)));
  assert.deepEqual([attr(3).atime, attr(3).mtime], [[100, 123456789], [200, 987654321]]);
  ok(msg(26, u32(3), u32(32), u32(0), u32(0), u32(0), u64(0), u64(0), u64(0), u64(0), u64(0)));
  assert.deepEqual(attr(3).mtime, [1788220800, 0]);
  // xattrs: set, read, list, the flags, a short write, removal.
  assert.equal(getx(3, 'user.k'), 61, 'ENODATA');
  assert.equal(setx(3, 'user.k', new TextEncoder().encode('abc')).type, 121);
  assert.equal(new TextDecoder().decode(getx(3, 'user.k') as Uint8Array), 'abc');
  assert.equal(setx(3, 'user.j', new TextEncoder().encode('j')).type, 121);
  assert.equal(new TextDecoder().decode(getx(3, '') as Uint8Array), 'user.k\0user.j\0');
  walk(3, 90);
  assert.equal(errno(msg(32, u32(90), 'user.k', u64(1), u32(1))), 17, 'XATTR_CREATE on one there: EEXIST');
  assert.equal(errno(msg(32, u32(90), 'user.q', u64(1), u32(2))), 61, 'XATTR_REPLACE on none: ENODATA');
  assert.equal(errno(msg(32, u32(90), 'user.q', u64(65537), u32(0))), 7, 'past XATTR_SIZE_MAX: E2BIG');
  assert.equal(errno(msg(32, u32(90), 'user.' + 'q'.repeat(251), u64(1), u32(0))), 34, 'a name past 255 bytes: ERANGE');
  ok(msg(32, u32(90), 'user.q', u64(4), u32(0)));
  ok(msg(118, u32(90), u64(0), u32(2), new Uint8Array([1, 2])));
  assert.equal(errno(msg(120, u32(90))), 22, 'fewer bytes than announced: EINVAL at the clunk');
  assert.equal(getx(3, 'user.q'), 61);
  assert.equal(setx(3, 'user.k', new Uint8Array(0), 2).type, 121, 'an empty value removes');
  assert.equal(getx(3, 'user.k'), 61);
  assert.equal(setx(3, 'user.k', new Uint8Array(0)).v.getUint32(7, true), 61, 'removing none: ENODATA');
  assert.equal(new TextDecoder().decode(getx(3, '') as Uint8Array), 'user.j\0');
  // POSIX ACLs: d's default ACL is what its new entries start with, narrowed by the mode they're created with.
  const def = acl([USER_OBJ, 7, 0], [USER, 7, 1000], [GROUP_OBJ, 5, 0], [MASK, 7, 0], [OTHER, 5, 0]);
  assert.equal(setx(3, 'system.posix_acl_default', def).v.getUint32(7, true), 13, 'a default ACL on a file: EACCES');
  assert.equal(setx(1, 'system.posix_acl_default', def).type, 121);
  assert.equal(setx(1, 'system.posix_acl_access', acl([USER_OBJ, 7, 0], [OTHER, 5, 0])).v.getUint32(7, true), 22, 'no owning group: EINVAL');
  walk(1, 4);
  ok(msg(14, u32(4), 'f', u32(0), u32(0o666), u32(0)));
  assert.equal(attr(4).mode, 0o100664);
  assert.deepEqual(getx(4, 'system.posix_acl_access'), acl([USER_OBJ, 6, 0], [USER, 7, 1000], [GROUP_OBJ, 5, 0], [MASK, 6, 0], [OTHER, 4, 0]));
  assert.equal(getx(4, 'system.posix_acl_default'), 61, 'a file has no default ACL');
  // A chmod is the ACL's owner, mask and other entries.
  ok(msg(26, u32(4), u32(1), u32(0o640), u32(0), u32(0), u64(0), u64(0), u64(0), u64(0), u64(0)));
  assert.deepEqual(getx(4, 'system.posix_acl_access'), acl([USER_OBJ, 6, 0], [USER, 7, 1000], [GROUP_OBJ, 5, 0], [MASK, 4, 0], [OTHER, 0, 0]));
  // An access ACL the mode can say is the mode.
  assert.equal(setx(4, 'system.posix_acl_access', acl([USER_OBJ, 7, 0], [GROUP_OBJ, 5, 0], [OTHER, 1, 0])).type, 121);
  assert.equal(attr(4).mode, 0o100751);
  assert.equal(getx(4, 'system.posix_acl_access'), 61);
  // A new directory takes the default ACL as its own default too; a symlink takes none.
  ok(msg(72, u32(1), 'e', u32(0o777), u32(0)));
  walk(1, 5, 'e');
  assert.equal(attr(5).mode, 0o40775);
  assert.deepEqual(getx(5, 'system.posix_acl_default'), def);
  ok(msg(16, u32(1), 'l', 'f', u32(0)));
  walk(1, 6, 'l');
  assert.equal(new TextDecoder().decode(getx(6, '') as Uint8Array), '');
  // A hard link shares them.
  ok(msg(70, u32(1), u32(4), 'g'));
  walk(1, 7, 'g');
  assert.equal(setx(7, 'user.h', new Uint8Array([7])).type, 121);
  assert.deepEqual(getx(4, 'user.h'), new Uint8Array([7]));

  const text = lines.join('\n') + '\n';
  if (process.env.P9_TRANSCRIPT === 'write') writeFileSync(TRANSCRIPT, text);
  assert.ok(readFileSync(TRANSCRIPT, 'utf8') === text, 'the exchanges are tests/p9/transcript.txt\'s (P9_TRANSCRIPT=write records them)');
});

test('9p backend: an Rread lands in the guest\'s buffers whole, its header and data across segments', () => {
  const ram = new Uint8Array(4096);
  const ctx = { ram: () => [ram] } as unknown as Ctx;
  const data = 'the quick brown fox jumps over the lazy dog';
  const be = p9Backend(ctx, new P9Server(new MemoryTree({ f: data }, true)));
  // Each request at 0; the reply in three segments that split the 11-byte header and the data.
  const ask = (m: Uint8Array, write = [{ off: 1000, len: 5, mem: 0 }, { off: 2000, len: 9, mem: 0 }, { off: 3000, len: 1000, mem: 0 }]) => {
    ram.set(m, 0);
    return be.request({ w0: 0, queue: 0, read: [{ off: 0, len: m.length, mem: 0 }], write }) as number;
  };
  ask(msg(100, u32(1 << 20), '9P2000.L'));
  ask(msg(104, u32(0), u32(~0 >>> 0), 'root', '', u32(0)));
  ask(msg(110, u32(0), u32(1), [2, 1], 'f'));
  ask(msg(12, u32(1), u32(0)));
  ram.fill(0, 1000);
  const n = ask(msg(116, u32(1), u64(4), u32(100)));
  const out = Buffer.concat([ram.subarray(1000, 1005), ram.subarray(2000, 2009), ram.subarray(3000, 4000)]).subarray(0, n);
  assert.equal(n, 11 + data.length - 4);
  assert.equal(out.readUInt32LE(0), n, 'size');
  assert.deepEqual([out[4], out.readUInt16LE(5), out.readUInt32LE(7)], [117, 1, data.length - 4], 'type, tag, count');
  assert.equal(out.subarray(11).toString(), data.slice(4));
  // Buffers smaller than the count: the read is cut to them.
  assert.equal(ask(msg(116, u32(1), u64(0), u32(100)), [{ off: 1000, len: 20, mem: 0 }]), 20);
});

test('9p server: a tree out of deterministic mode has nanosecond times', () => {
  const s = new P9Server(new MemoryTree({ 'f': '' }, false));
  s.handle(msg(100, u32(1 << 20), '9P2000.L'), 8192);
  s.handle(msg(104, u32(0), u32(~0 >>> 0), 'root', '', u32(0)), 8192);
  s.handle(msg(110, u32(0), u32(1), [2, 1], 'f'), 8192);
  const r = s.handle(msg(24, u32(1), u64(0x7ff)), 8192) as Uint8Array;
  const v = new DataView(r.buffer, r.byteOffset);
  const [sec, ns] = [Number(v.getBigUint64(96, true)), Number(v.getBigUint64(104, true))];
  assert.ok(Math.abs(sec + ns / 1e9 - Date.now() / 1000) < 5, `mtime ${sec}.${ns}`);
  assert.ok(ns < 1e9);
});

test('9p server: a tree that answers later: requests overlap, a Tflush ends after its request', async () => {
  // The memory tree, its reads and removes held until the test lets them go.
  const held: (() => void)[] = [];
  const later = <T,>(f: () => T) => new Promise<T>((resolve, reject) => held.push(() => { try { resolve(f()); } catch (e) { reject(e); } }));
  const mem = new MemoryTree({ 'a': 'aaa', 'b': 'bbb' }, true);
  const tree = Object.create(mem) as typeof mem & P9Tree<ReturnType<typeof mem.walk>>;
  tree.read = ((f: never, off: number, count: number) => later(() => mem.read(f, off, count))) as never;
  tree.remove = ((f: never) => later(() => mem.remove(f))) as never;
  const clunked: unknown[] = [];
  tree.clunk = ((f: unknown) => { clunked.push(f); }) as never;
  const s = new P9Server(tree as never);
  const tagged = (tag: number, m: Uint8Array) => { m[5] = tag; return m; };
  s.handle(msg(100, u32(1 << 20), '9P2000.L'), 8192);
  s.handle(msg(104, u32(0), u32(~0 >>> 0), 'root', '', u32(0)), 8192);
  s.handle(msg(110, u32(0), u32(1), [2, 1], 'a'), 8192);
  s.handle(msg(110, u32(0), u32(2), [2, 1], 'b'), 8192);
  const text = (r: Uint8Array) => new TextDecoder().decode(r.subarray(11));
  const [a, b] = [s.handle(tagged(7, msg(116, u32(1), u64(0), u32(100))), 8192), s.handle(tagged(8, msg(116, u32(2), u64(0), u32(100))), 8192)];
  assert.ok(a instanceof Promise && b instanceof Promise, 'the reads are held');
  // Answered at once while nothing else is held: what didn't touch the held calls.
  assert.equal((s.handle(msg(24, u32(1), u64(0x7ff)), 8192) as Uint8Array)[4], 25);
  const order: string[] = [];
  const flushOf = (tag: number) => {
    const m = msg(108, [2, tag]);
    m[5] = 9;
    return s.handle(m, 8192);
  };
  const flush = Promise.resolve(flushOf(7)).then((r) => { order.push('flush'); return r; });
  void Promise.resolve(a).then(() => order.push('a'));
  held[1](); // b, the later one, ends first
  assert.equal(text(await b), 'bbb');
  await new Promise((r) => setTimeout(r, 1));
  assert.deepEqual(order, [], 'the flush waits for its request');
  held[0]();
  assert.equal(text(await a), 'aaa');
  assert.equal((await flush)[4], 109);
  assert.deepEqual(order, ['a', 'flush']);
  // A flush of nothing running answers at once; a failed Tremove clunks its fid.
  assert.equal((flushOf(7) as Uint8Array)[4], 109);
  held.length = 0;
  s.handle(msg(110, u32(0), u32(3), [2, 0]), 8192);
  const rm = s.handle(msg(122, u32(3)), 8192);
  held[0](); // the root: ENOENT
  const ans = await rm;
  assert.deepEqual([ans[4], new DataView(ans.buffer, ans.byteOffset).getUint32(7, true)], [7, 2]);
  assert.equal(clunked.length, 1);
  assert.equal((s.handle(msg(120, u32(3)), 8192) as Uint8Array)[4], 7, 'the fid is gone');
});

test('loopback adapter answers ARP and ping for the peer, and nothing else', () => {
  const guest = [0x52, 0x54, 0, 0x12, 0x34, 0x56];
  const got: Uint8Array[] = [];
  const a = loopback((f) => got.push(f));
  const arp = new Uint8Array([...Array(6).fill(0xff), ...guest, 8, 6, 0, 1, 8, 0, 6, 4, 0, 1, ...guest, 10, 0, 2, 15, 0, 0, 0, 0, 0, 0, ...PEER_IP]);
  a.send(arp);
  assert.deepEqual([...got[0]], [...guest, ...PEER_MAC, 8, 6, 0, 1, 8, 0, 6, 4, 0, 2, ...PEER_MAC, ...PEER_IP, ...guest, 10, 0, 2, 15]);
  a.send(arp.map((b, k) => (k === 41 ? 3 : b))); // someone else
  assert.equal(got.length, 1);
  // An echo request with 4 bytes of data, and its reply's checksums.
  const ip = [0x45, 0, 0, 32, 0, 1, 0, 0, 64, 1, 0, 0, 10, 0, 2, 15, ...PEER_IP];
  const icmp = [8, 0, 0, 0, 0x12, 0x34, 0, 1, 1, 2, 3, 4];
  const sum = (b: number[]) => {
    let s = 0;
    for (let k = 0; k < b.length; k += 2) s += (b[k] << 8) | b[k + 1];
    while (s > 0xffff) s = (s & 0xffff) + (s >>> 16);
    return ~s & 0xffff;
  };
  [ip[10], ip[11]] = [sum(ip) >> 8, sum(ip) & 0xff];
  [icmp[2], icmp[3]] = [sum(icmp) >> 8, sum(icmp) & 0xff];
  a.send(new Uint8Array([...PEER_MAC, ...guest, 8, 0, ...ip, ...icmp, 0, 0])); // padded, as short frames are
  const r = [...got[1]];
  assert.equal(r.length, 14 + 32, 'padding dropped');
  assert.deepEqual(r.slice(0, 12), [...guest, ...PEER_MAC]);
  assert.deepEqual(r.slice(26, 34), [...PEER_IP, 10, 0, 2, 15]);
  assert.equal(sum(r.slice(14, 34)), 0, 'IP checksum');
  assert.equal(r[34], 0, 'echo reply');
  assert.equal(sum(r.slice(34)), 0, 'ICMP checksum');
  assert.deepEqual(r.slice(38), icmp.slice(4), 'identifier, sequence and data kept');
});

test('virtio-input drops the oldest whole frames past its queue', () => {
  const key = (code: number) => [[1, code, 1], [0, 0, 0], [1, code, 0], [0, 0, 0]];
  const q = [...key(30), ...key(31), ...key(32)]; // 12 events, frames of 2
  trimInput(q, 12);
  assert.equal(q.length, 12, 'within the bound: kept');
  trimInput(q, 11); // one too many: the first frame goes, not just its press
  assert.deepEqual(q, [...key(30).slice(2), ...key(31), ...key(32)]);
  trimInput(q, 7); // three too many, a cut after 31's press: through its SYN_REPORT
  assert.deepEqual(q, [...key(31).slice(2), ...key(32)]);
  const open = [[1, 30, 1], [1, 31, 1], [1, 32, 1]]; // a frame with no SYN_REPORT yet, cut: all of it
  trimInput(open, 2);
  assert.deepEqual(open, []);
});

test('virtio-input config answers', () => {
  assert.equal(new TextDecoder().decode(inputConfig('keyboard', 1, 0)), 'waarm64 keyboard');
  assert.equal(inputConfig('keyboard', 0x11, 1).length, 32); // keys 1-248
  assert.deepEqual([...inputConfig('keyboard', 0x11, 0x11)], [7]);
  assert.deepEqual([...inputConfig('tablet', 0x11, 3)], [3]);
  assert.deepEqual([...new Uint32Array(inputConfig('tablet', 0x12, 1).slice().buffer)], [0, 32767, 0, 0, 0]);
  assert.equal(inputConfig('tablet', 0x12, 2).length, 0);
  assert.equal(inputConfig('keyboard', 0x11, 3).length, 0);
  // The pointers' buttons: left, right, middle, side and extra (0x110-0x114).
  assert.deepEqual([...inputConfig('tablet', 0x11, 1)].slice(0x110 >> 3), [0x1f]);
  assert.deepEqual([...inputConfig('mouse', 0x11, 1)].slice(0x110 >> 3), [0x1f]);
  // The wheels: REL_HWHEEL (6), REL_WHEEL (8), REL_WHEEL_HI_RES (11), REL_HWHEEL_HI_RES (12); the mouse's REL_X, REL_Y too.
  assert.deepEqual([...inputConfig('mouse', 0x11, 2)], [0x43, 0x19]);
  assert.deepEqual([...inputConfig('tablet', 0x11, 2)], [0x40, 0x19]);
  assert.equal(inputConfig('mouse', 0x11, 3).length, 0);
  assert.equal(new TextDecoder().decode(inputConfig('touch', 1, 0)), 'waarm64 touchscreen');
  assert.deepEqual([...inputConfig('touch', 0x10, 0)], [2]); // INPUT_PROP_DIRECT
  assert.equal(inputConfig('tablet', 0x10, 0).length, 0);
  const abs = inputConfig('touch', 0x11, 3);
  for (const a of [0, 1, 0x2f, 0x35, 0x36, 0x39]) assert.ok(abs[a >> 3] & (1 << (a & 7)), `ABS ${a}`);
  assert.deepEqual([...new Int32Array(inputConfig('touch', 0x12, 0x2f).slice().buffer)], [0, 9, 0, 0, 0]);
  assert.deepEqual([...new Int32Array(inputConfig('touch', 0x12, 0x35).slice().buffer)], [0, 32767, 0, 0, 0]);
  assert.equal(inputConfig('touch', 0x12, 2).length, 0);
});

test('changeConfig: the generation goes odd around the write, even after it, and the signal word is set', () => {
  // The layout (docs/abi.md): config_gen at 20, config at 24; the signal word, a vCPU's wake word and its stop word
  // (ABI 71, parallel SMP: compiled code stops at its next poll) elsewhere.
  const memory = { buffer: new SharedArrayBuffer(4096) };
  const [shared, signal, wake, stop] = [64, 1024, 1028, 1032];
  Atomics.store(new Int32Array(memory.buffer, stop, 1), 0, 32768);
  const gen = new Int32Array(memory.buffer, shared + 20, 1);
  const seen: number[] = [];
  const self = { memory, shared: [shared], signal, wakes: [wake], stops: [stop], ramAt: 0, spillViews: [], kick: (Devices.prototype as unknown as { kick(): void }).kick, views: (Devices.prototype as unknown as { views(): unknown }).views };
  Atomics.add(gen, 0, 4); // earlier changes
  (Devices.prototype.changeConfig as (this: unknown, i: number, w: (c: Uint8Array) => void) => void).call(self, 0, (c) => {
    seen.push(gen[0]); // mid-update
    c[0] = 9;
  });
  assert.deepEqual(seen, [5]);
  assert.equal(gen[0], 6);
  assert.equal(new Uint8Array(memory.buffer)[shared + 24], 9);
  assert.equal(Atomics.load(new Int32Array(memory.buffer, signal, 1), 0), 4, 'SIGNAL_DEVICE');
  assert.equal(Atomics.load(new Int32Array(memory.buffer, wake, 1), 0), 1, 'the vCPU woken');
  assert.equal(Atomics.load(new Int32Array(memory.buffer, stop, 1), 0), 0, 'its chunk stopped');
});

test('poll: records from before a reset are skipped, and the signal word set (a chain may wait for their room)', async () => {
  // The layout (docs/abi.md): events at 0, epoch at 16, the request ring (head, tail, words) at 280.
  const memory = { buffer: new SharedArrayBuffer(1 << 16) };
  const [shared, signal] = [0, 40_000];
  const u32 = new Uint32Array(memory.buffer);
  u32[16 / 4] = 1; // the transport was reset once
  const ring = 280 / 4;
  u32.set([0 << 24 | 3, 0], ring + 2); // epoch 0's record of head 3, no segments
  Atomics.store(u32, ring, 2);
  const seen: number[] = [];
  const backend = { reset() {}, request: (r: { w0: number }) => { seen.push(r.w0); return 0; } };
  const self = { memory, shared: [shared], signal, wakes: [], stops: [], backends: [backend], epochs: [0], deterministic: true, detached: new Set(), ramAt: 0, spillViews: [], kick: (Devices.prototype as unknown as { kick(): void }).kick, views: (Devices.prototype as unknown as { views(): unknown }).views };
  await (Devices.prototype.poll as (this: unknown) => Promise<void>).call(self);
  assert.deepEqual(seen, [], 'the stale record skipped');
  assert.equal(Atomics.load(u32, ring + 1), 2, 'and taken');
  assert.equal(Atomics.load(new Int32Array(memory.buffer, signal, 1), 0), 4, 'SIGNAL_DEVICE');
});

test("poll: a poll's completions wake each vCPU once, before the poll resolves (the doorbell's answer follows it)", async () => {
  // The layout (docs/abi.md): events at 0, epoch at 16, the request ring at 280, the completion ring after its words.
  const memory = { buffer: new SharedArrayBuffer(1 << 16) };
  const [signal, wake] = [40_000, 40_004];
  const u32 = new Uint32Array(memory.buffer);
  const ring = 280 / 4;
  u32.set([1, 0, 2, 0, 3, 0], ring + 2); // three records of epoch 0, no segments
  Atomics.store(u32, ring, 6);
  const backend = { reset() {}, request: () => 0 };
  const proto = Devices.prototype as unknown as Record<string, unknown>;
  const self = { memory, shared: [0], signal, wakes: [wake], stops: [], backends: [backend], epochs: [0], deterministic: true, detached: new Set(), ramAt: 0, spillViews: [], kickOwed: false, kick: proto.kick, views: proto.views, complete: proto.complete };
  await (Devices.prototype.poll as (this: unknown) => Promise<void>).call(self);
  const cpl = (280 + 8 + 4 * 4096) / 4;
  assert.equal(Atomics.load(u32, cpl), 6, 'three completions');
  assert.equal(Atomics.load(new Int32Array(memory.buffer, signal, 1), 0), 4, 'SIGNAL_DEVICE');
  assert.equal(Atomics.load(new Int32Array(memory.buffer, wake, 1), 0), 1, 'the vCPU woken once');
});

test('net: a received frame across merged buffers (MRG_RXBUF): the header, then the frame, over their segments', () => {
  const ram = new Uint8Array(1 << 16);
  const done: number[] = [];
  const ctx = { ram: () => [ram], complete: (_w0: number, len: number) => done.push(len), features: () => 1n << 15n, io: new Float64Array(2) } as unknown as Ctx;
  const n = net(ctx, { type: 'net', adapter: 'loopback' });
  // Two receive buffers: 20 bytes in segments of 5 and 15 (the header split across them), then 100.
  n.request({ w0: 10, queue: 0, read: [], write: [{ off: 8000, len: 5, mem: 0 }, { off: 9000, len: 15, mem: 0 }] });
  n.request({ w0: 11, queue: 0, read: [], write: [{ off: 10000, len: 100, mem: 0 }] });
  const guest = [0x52, 0x54, 0, 0x12, 0x34, 0x56];
  const arp = [...Array(6).fill(0xff), ...guest, 8, 6, 0, 1, 8, 0, 6, 4, 0, 1, ...guest, 10, 0, 2, 15, 0, 0, 0, 0, 0, 0, ...PEER_IP];
  ram.fill(0, 0, 12);
  ram.set(arp, 12);
  n.request({ w0: 1, queue: 1, read: [{ off: 0, len: 12 + arp.length, mem: 0 }], write: [] });
  // The 42-byte reply after its 12-byte header: 20 bytes in the first buffer, 34 in the second.
  assert.deepEqual(done.slice(-2), [20, 34]);
  const got = [...ram.subarray(8000, 8005), ...ram.subarray(9000, 9015), ...ram.subarray(10000, 10034)];
  assert.deepEqual(got.slice(10, 12), [2, 0], 'num_buffers');
  assert.deepEqual(got.slice(12), [...guest, ...PEER_MAC, 8, 6, 0, 1, 8, 0, 6, 4, 0, 2, ...PEER_MAC, ...PEER_IP, ...guest, 10, 0, 2, 15]);
});

test('terminalBytes: what a terminal sends for the keys that drive EDK2 and GRUB', async () => {
  const { terminalBytes } = await import('../web/input.ts');
  const k = (key: string, m: { ctrlKey?: boolean; altKey?: boolean; metaKey?: boolean } = {}) => terminalBytes({ key, ctrlKey: false, altKey: false, metaKey: false, ...m });
  assert.deepEqual(['a', 'A', '~', ' '].map((c) => k(c)), ['a', 'A', '~', ' ']);
  assert.deepEqual(['Enter', 'Escape', 'Backspace', 'Tab'].map((c) => k(c)), ['\r', '\x1b', '\x7f', '\t']);
  // i18n-ignore-next: KeyboardEvent.key values
  assert.deepEqual(['ArrowUp', 'ArrowDown', 'ArrowRight', 'ArrowLeft', 'Home', 'End', 'Delete', 'F2'].map((c) => k(c)), ['\x1b[A', '\x1b[B', '\x1b[C', '\x1b[D', '\x1b[H', '\x1b[F', '\x1b[3~', '\x1bOQ']);
  assert.equal(k('x', { ctrlKey: true }), '\x18'); // Ctrl-X boots a GRUB entry
  assert.equal(k('e', { altKey: true }), '\x1be');
  assert.deepEqual(['Shift', 'Control', 'CapsLock', 'Dead'].map((c) => k(c)), [null, null, null, null]);
  assert.equal(k('a', { metaKey: true }), null);
});

test('Windows\' AltGr (a left Ctrl and a right Alt at one time) reaches the guest as AltGr alone; a left Ctrl of its own goes on', async () => {
  const { altGrFilter, ALTGR_MS, onWindows } = await import('../web/input.ts');
  const got: string[] = [];
  let pending: (() => void) | undefined;
  const timer = { set: (f: () => void) => ((pending = f), 1), clear: () => (pending = undefined) };
  const f = altGrFilter((e, down) => got.push(`${e.code}${down ? '+' : '-'}${e.repeat ? 'r' : ''}`), timer);
  let prevented = 0;
  const KEY: Record<string, string> = { ControlLeft: 'Control', AltRight: 'AltGraph', Digit2: '@', KeyC: 'c', KeyA: 'a' };
  const ev = (code: string, timeStamp: number, repeat = false, key = KEY[code]) => ({ code, key, timeStamp, repeat, preventDefault: () => prevented++ }) as unknown as KeyboardEvent;
  // AltGr+2, held a while (Windows repeats both), released; Chrome 158 on Windows 10 put the Ctrl and the Alt 0.2 ms apart.
  f.key(1)(ev('ControlLeft', 100));
  f.key(1)(ev('AltRight', 100));
  f.key(1)(ev('ControlLeft', 600, true));
  f.key(1)(ev('AltRight', 600, true));
  f.key(1)(ev('Digit2', 700));
  f.key(0)(ev('Digit2', 750));
  f.key(0)(ev('ControlLeft', 800));
  f.key(0)(ev('AltRight', 800));
  assert.deepEqual(got, ['AltRight+', 'AltRight+r', 'Digit2+', 'Digit2-', 'AltRight-']);
  assert.equal(prevented, 3, 'the Ctrl\'s press, repeat and release: no browser action');
  // A left Ctrl of its own: on the next key (Ctrl+C), or after the wait (Ctrl alone, Ctrl+click), and a right Alt
  // later than the wait (Ctrl then AltGr).
  got.length = 0;
  f.key(1)(ev('ControlLeft', 1000));
  f.key(1)(ev('KeyC', 1080));
  f.key(0)(ev('KeyC', 1100));
  f.key(0)(ev('ControlLeft', 1120));
  f.key(1)(ev('ControlLeft', 2000));
  assert.ok(pending);
  pending!();
  f.key(1)(ev('AltRight', 2000 + ALTGR_MS + 30));
  f.key(0)(ev('AltRight', 2200));
  f.key(0)(ev('ControlLeft', 2210));
  assert.deepEqual(got, ['ControlLeft+', 'KeyC+', 'KeyC-', 'ControlLeft-', 'ControlLeft+', 'AltRight+', 'AltRight-', 'ControlLeft-']);
  // A layout without AltGr (its right Alt is Alt; Windows adds no Ctrl): a left Ctrl just before it is a Ctrl.
  got.length = 0;
  f.key(1)(ev('ControlLeft', 2500));
  f.key(1)(ev('AltRight', 2500.2, false, 'Alt'));
  f.key(0)(ev('AltRight', 2600, false, 'Alt'));
  f.key(0)(ev('ControlLeft', 2610));
  assert.deepEqual(got, ['ControlLeft+', 'AltRight+', 'AltRight-', 'ControlLeft-']);
  // A release (a blur) drops a waiting Ctrl.
  got.length = 0;
  f.key(1)(ev('ControlLeft', 3000));
  f.reset();
  f.key(1)(ev('KeyA', 3010));
  assert.deepEqual(got, ['KeyA+']);
  assert.deepEqual([onWindows({ platform: 'Win32' }), onWindows({ userAgentData: { platform: 'Windows' } }), onWindows({ platform: 'Linux aarch64' }), onWindows({ platform: 'MacIntel' })], [true, true, false, false]);
});

test('virtio-blk DISCARD and WRITE_ZEROES: offered with `discard` over an overlay, they reach it; bad requests are refused', async () => {
  // The offer: features 13 and 14 and a 60-byte config, only with an overlay and `discard`.
  const plain = deviceEntry({ type: 'blk', url: 'x', size: 1 << 20, overlay: 'o' });
  assert.deepEqual([plain.entry[1], plain.config.length], [1n << 2n | 1n << 9n, 16]);
  assert.equal(deviceEntry({ type: 'blk', url: 'x', size: 1 << 20, discard: true }).entry[1], 1n << 2n | 1n << 5n);
  const offered = deviceEntry({ type: 'blk', url: 'x', size: 1 << 20, overlay: 'o', discard: true });
  assert.equal(offered.entry[1], 1n << 2n | 1n << 9n | 1n << 13n | 1n << 14n);
  assert.equal(offered.entry[4], 60n);
  const c = new DataView(offered.config.buffer);
  assert.deepEqual([c.getUint32(36, true), c.getUint32(40, true), c.getUint32(44, true), c.getUint32(48, true), c.getUint32(52, true), c.getUint8(56)], [1 << 22, 1, 8, 1 << 22, 1, 1]);

  const size = 64 * 4096;
  const image = new Uint8Array(size).fill(7);
  const ram = new Uint8Array(1 << 16);
  const ctx = { ram: () => [ram] } as unknown as Ctx;
  const src = { size, read: (off: number, len: number) => image.slice(off, off + len) };
  const [data, map] = [memFile(), memFile()];
  const files = { data, map, meta: memFile(), close() {} };
  /** A request: the header (type, sector), `body` after it, `room` writable bytes before the status byte; resolves to the status. */
  const ask = async (b: ReturnType<typeof blk>, type: number, sector: number, body: Uint8Array, room = 0) => {
    const h = new DataView(ram.buffer, 0, 16);
    h.setUint32(0, type, true);
    h.setBigUint64(8, BigInt(sector), true);
    ram.set(body, 16);
    ram[8192 + room] = 0xff;
    const n = await b.request({ w0: 0, queue: 0, read: [{ off: 0, len: 16, mem: 0 }, { off: 16, len: body.length, mem: 0 }].filter((s) => s.len), write: [{ off: 8192, len: room + 1, mem: 0 }] });
    assert.equal(n, (type === 0 && ram[8192 + room] === 0 ? room : 0) + 1);
    return ram[8192 + room];
  };
  const seg = (sector: number, sectors: number, flags = 0) => {
    const s = new DataView(new ArrayBuffer(16));
    s.setBigUint64(0, BigInt(sector), true);
    s.setUint32(8, sectors, true);
    s.setUint32(12, flags, true);
    return new Uint8Array(s.buffer);
  };
  const [IN, OUT, DISCARD, ZEROES, OK, IOERR, UNSUPP] = [0, 1, 11, 13, 0, 1, 2];
  const first = async (b: ReturnType<typeof blk>, sector: number) => { assert.equal(await ask(b, IN, sector, new Uint8Array(0), 512), OK); return ram[8192]; };

  const b = blk(ctx, src, files, true);
  assert.equal(await ask(b, OUT, 0, new Uint8Array(4 * 4096).fill(9)), OK); // blocks 0 to 3
  assert.equal(data.getSize(), 4 * 4096);
  assert.equal(await ask(b, DISCARD, 8, seg(8, 16)), OK); // blocks 1 and 2
  assert.deepEqual([await first(b, 0), await first(b, 8), await first(b, 16), await first(b, 24)], [9, 0, 0, 9]);
  assert.equal(await ask(b, DISCARD, 0, seg(80, 8)), OK); // a block the overlay doesn't hold: the base stays
  assert.equal(await first(b, 80), 7);
  assert.equal(await ask(b, ZEROES, 0, seg(80, 8, 1)), OK); // write zeroes (unmap allowed): zeros
  assert.equal(await first(b, 80), 0);
  assert.equal(await ask(b, ZEROES, 0, seg(24, 8)), OK); // block 3: the last slot goes
  assert.equal(data.getSize(), 1 * 4096);
  // A snapshot's `written` pins the generation (1: this opening's first change moved it) and sets the next change to
  // move it again (docs/machines.md §3.3): writes after a snapshot are another generation.
  const pinned = b.written!();
  assert.deepEqual({ ...pinned, blocks: [...pinned!.blocks] }, { blocks: [0, 1, 2, 3, 10], generation: 1 });
  assert.equal(await ask(b, OUT, 0, new Uint8Array(512).fill(9)), OK);
  assert.equal(b.written!().generation, 2, 'a write after the snapshot moved the generation');
  assert.equal(b.written!().generation, 2, 'reading it alone moves nothing');
  // Refused: the unmap flag on a discard and unknown flags (UNSUPP), past the end, too long, no or two segments (IOERR).
  assert.equal(await ask(b, DISCARD, 0, seg(0, 8, 1)), UNSUPP);
  assert.equal(await ask(b, ZEROES, 0, seg(0, 8, 2)), UNSUPP);
  assert.equal(await ask(b, DISCARD, 0, seg(size / 512 - 4, 8)), IOERR);
  assert.equal(await ask(b, DISCARD, 0, seg(0, (1 << 22) + 8)), IOERR);
  assert.equal(await ask(b, DISCARD, 0, new Uint8Array(0)), IOERR);
  assert.equal(await ask(b, DISCARD, 0, new Uint8Array([...seg(0, 8), ...seg(8, 8)])), IOERR);
  assert.equal(await first(b, 0), 9);
  // Not offered: unsupported, with an overlay or without one.
  assert.equal(await ask(blk(ctx, src, files), DISCARD, 0, seg(0, 8)), UNSUPP);
  assert.equal(await ask(blk(ctx, src, undefined, true), ZEROES, 0, seg(0, 8)), UNSUPP);
  assert.equal(await first(b, 0), 9);
});

test('virtio-blk: a write that finds the storage full gets the remote disks\' kept blocks out of the way, and lands', async () => {
  const { blockStore } = await import('../web/diskcache.ts');
  const size = 16 * 4096;
  const ram = new Uint8Array(1 << 16);
  const ctx = { ram: () => [ram] } as unknown as Ctx;
  const src = { size, read: (off: number, len: number) => new Uint8Array(len).fill(7) };
  // The storage is full while the store keeps anything: the overlay's data writes then fall short.
  const kept = memFile();
  const store = blockStore(kept, memFile(), size, 4096, 8);
  store.put(0, new Uint8Array(4096).fill(1));
  const full = memFile();
  const data = { ...full, read: full.read.bind(full), getSize: full.getSize.bind(full), truncate: full.truncate.bind(full), flush: full.flush.bind(full),
    write: (buf: Uint8Array, o: { at: number }) => (kept.getSize() > 0 ? 0 : full.write(buf, o)) };
  const files = { data, map: memFile(), meta: memFile(), close() {} };
  const b = blk(ctx, src, files);
  const h = new DataView(ram.buffer, 0, 16);
  h.setUint32(0, 1, true); // OUT, sector 0
  h.setBigUint64(8, 0n, true);
  ram.fill(9, 16, 16 + 4096);
  ram[8192] = 0xff;
  await b.request({ w0: 0, queue: 0, read: [{ off: 0, len: 16, mem: 0 }, { off: 16, len: 4096, mem: 0 }], write: [{ off: 8192, len: 1, mem: 0 }] });
  assert.deepEqual([ram[8192], store.stats().gaveUp, kept.getSize(), full.getSize()], [0, true, 0, 4096]);
  store.close();
});

test('virtio-blk: a write of zeroes that finds the storage full (its leaf made) gets the kept blocks out of the way and lands, or is told; a discard needs no room', async () => {
  const { blockStore } = await import('../web/diskcache.ts');
  const size = 3 * 1024 * 4096; // three leaves of the overlay's map (4 MiB each)
  const ram = new Uint8Array(1 << 16);
  const ctx = { ram: () => [ram] } as unknown as Ctx;
  const src = { size, read: (off: number, len: number) => new Uint8Array(len).fill(7) };
  // The map file's writes that grow it need room: none while the store keeps anything (or ever, with `never`).
  let never = false;
  const kept = memFile();
  const store = blockStore(kept, memFile(), size, 4096, 8);
  const m = memFile();
  const map = { ...m, read: m.read.bind(m), getSize: m.getSize.bind(m), truncate: m.truncate.bind(m), flush: m.flush.bind(m),
    write: (buf: Uint8Array, o: { at: number }) => (o.at + buf.length > m.getSize() && (never || kept.getSize() > 0) ? 0 : m.write(buf, o)) };
  let told = 0;
  const b = blk(ctx, src, { data: memFile(), map, meta: memFile(), close() {} }, true, undefined, 'waarm64-blk', false, () => told++);
  /** DISCARD (11) or WRITE_ZEROES (13, unmap allowed) of blocks [k, k + n); the status. */
  const ask = async (type: number, k: number, n: number) => {
    const h = new DataView(ram.buffer, 0, 32);
    h.setUint32(0, type, true);
    h.setBigUint64(8, 0n, true);
    h.setBigUint64(16, BigInt(k * 8), true);
    h.setUint32(24, n * 8, true);
    h.setUint32(28, type === 13 ? 1 : 0, true);
    ram[8192] = 0xff;
    await b.request({ w0: 0, queue: 0, read: [{ off: 0, len: 16, mem: 0 }, { off: 16, len: 16, mem: 0 }], write: [{ off: 8192, len: 1, mem: 0 }] });
    return ram[8192];
  };
  const [OK, IOERR] = [0, 1];
  store.put(0, new Uint8Array(4096).fill(1));
  assert.deepEqual([await ask(13, 4, 4), store.stats().gaveUp, told], [OK, true, 0], 'zeroes: the store gave its room up, and they landed');
  const again = blockStore(kept, memFile(), size, 4096, 8);
  again.put(0, new Uint8Array(4096).fill(1));
  // A discard changes only blocks the overlay holds, in a leaf there is: written over in place, the file doesn't grow.
  assert.deepEqual([await ask(11, 2, 4), await ask(11, 2000, 4), again.stats().gaveUp, told], [OK, OK, false, 0], 'a discard: no room needed');
  never = true;
  assert.deepEqual([await ask(13, 1024 + 50, 4), await ask(13, 2048 + 50, 4), await ask(11, 4, 4), told], [IOERR, IOERR, OK, 1], 'still full: zeroes failed (new leaves), told once; a discard lands');
  store.close();
  again.close();
});

test('virtio-blk: a write the storage refuses (short, or QuotaExceededError) is told once, until a write lands again; other errors aren\'t', async () => {
  const size = 16 * 4096;
  const ram = new Uint8Array(1 << 16);
  const ctx = { ram: () => [ram] } as unknown as Ctx;
  const src = { size, read: (off: number, len: number) => new Uint8Array(len).fill(7) };
  // The overlay's data file: `mode` says how its writes go.
  let mode: 'ok' | 'short' | 'quota' | 'other' = 'ok';
  const file = memFile();
  const data = { ...file, read: file.read.bind(file), getSize: file.getSize.bind(file), truncate: file.truncate.bind(file), flush: file.flush.bind(file),
    write: (buf: Uint8Array, o: { at: number }) => {
      if (mode === 'short') return 0;
      if (mode === 'quota') throw new DOMException('No space available for this operation', 'QuotaExceededError');
      if (mode === 'other') throw new TypeError('something else');
      return file.write(buf, o);
    } };
  let told = 0;
  const b = blk(ctx, src, { data, map: memFile(), meta: memFile(), close() {} }, true, undefined, 'waarm64-blk', false, () => told++);
  /** Writes block `k` (OUT; or WRITE_ZEROES over its first half); the status. */
  const write = async (k: number, zeroes = false) => {
    const h = new DataView(ram.buffer, 0, 16);
    h.setUint32(0, zeroes ? 13 : 1, true);
    h.setBigUint64(8, BigInt(zeroes ? 0 : k * 8), true);
    const body = new Uint8Array(zeroes ? 16 : 4096).fill(9);
    if (zeroes) { const seg = new DataView(body.buffer); seg.setBigUint64(0, BigInt(k * 8), true); seg.setUint32(8, 4, true); seg.setUint32(12, 0, true); } // half a block: its bytes are written
    ram.set(body, 16);
    ram[8192] = 0xff;
    await b.request({ w0: 0, queue: 0, read: [{ off: 0, len: 16, mem: 0 }, { off: 16, len: body.length, mem: 0 }], write: [{ off: 8192, len: 1, mem: 0 }] });
    return ram[8192];
  };
  const [OK, IOERR] = [0, 1];
  assert.equal(await write(0), OK);
  mode = 'short';
  assert.deepEqual([await write(1), await write(2), told], [IOERR, IOERR, 1], 'a short write: told once');
  mode = 'quota';
  assert.deepEqual([await write(3), await write(4, true), told], [IOERR, IOERR, 1], 'still full: not told again (a write of zeroes too)');
  mode = 'ok';
  assert.equal(await write(5), OK);
  mode = 'quota';
  assert.deepEqual([await write(6), told], [IOERR, 2], 'full again after a write landed: told again');
  mode = 'ok';
  assert.equal(await write(7), OK);
  mode = 'other';
  assert.deepEqual([await write(8), told], [IOERR, 2], 'another error fails the request, and is no full storage');
});

test('the I/O counters: blk counts the bytes of completed reads and writes, net the frames to and from the guest', async () => {
  const ram = new Uint8Array(1 << 16);
  const io = new Float64Array(4); // two devices' worth: each backend gets its own two slots, as `Devices` hands them out
  const done: number[] = [];
  const ctxOf = (k: number) => ({ ram: () => [ram], complete: (_w0: number, len: number) => done.push(len), features: () => 0n, io: io.subarray(2 * k, 2 * k + 2) }) as unknown as Ctx;
  const size = 16 * 4096;
  const src = { size, read: (off: number, len: number) => (off + len <= size ? new Uint8Array(len) : undefined) };
  const files = { data: memFile(), map: memFile(), meta: memFile(), close() {} };
  const d = blk(ctxOf(0), src, files);
  /** A request of `type` at `sector` with `body` after the header and `room` bytes to read into; its status. */
  const ask = async (type: number, sector: number, body: number, room: number) => {
    const h = new DataView(ram.buffer, 0, 16);
    h.setUint32(0, type, true);
    h.setBigUint64(8, BigInt(sector), true);
    await d.request({ w0: 0, queue: 0, read: [{ off: 0, len: 16, mem: 0 }, { off: 16, len: body, mem: 0 }].filter((x) => x.len), write: [{ off: 16384, len: room + 1, mem: 0 }] });
    return ram[16384 + room];
  };
  assert.equal(await ask(0, 0, 0, 4096), 0);
  assert.equal(await ask(1, 8, 8192, 0), 0);
  assert.equal(await ask(4, 0, 0, 0), 0); // a flush: nothing
  assert.equal(await ask(0, size / 512, 0, 512), 1); // past the end: IOERR, nothing
  assert.deepEqual([...io], [4096, 8192, 0, 0]);
  // The loopback answers an ARP for its peer: a 42-byte frame out (after virtio's 12-byte header), its 42-byte reply in.
  const n = net(ctxOf(1), { type: 'net', adapter: 'loopback' });
  const guest = [0x52, 0x54, 0, 0x12, 0x34, 0x56];
  const arp = [...Array(6).fill(0xff), ...guest, 8, 6, 0, 1, 8, 0, 6, 4, 0, 1, ...guest, 10, 0, 2, 15, 0, 0, 0, 0, 0, 0, ...PEER_IP];
  ram.fill(0, 0, 12);
  ram.set(arp, 12);
  n.request({ w0: 1, queue: 1, read: [{ off: 0, len: 12 + arp.length, mem: 0 }], write: [] });
  assert.deepEqual([...io], [4096, 8192, 0, 42]);
  n.request({ w0: 2, queue: 0, read: [], write: [{ off: 4096, len: 2048, mem: 0 }] });
  assert.equal(done.at(-1), 12 + 42);
  assert.deepEqual([...io], [4096, 8192, 42, 42]);
});

test('serve ends on a close that lands while it yields to the event loop', async () => {
  // `serve` yields through a MessageChannel after 2 ms of work; a listening port keeps Node's process alive, so a
  // close it missed there left the process up for good once the tests ended (tests/pause.test.ts).
  const memory = new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true });
  const d = await Devices.open({ memory, shared: [], ram: 0, ramSize: 0, signal: 0, specs: [], deterministic: false }, () => {});
  const bell = new Int32Array(memory.buffer, 64, 2);
  // A poll that works 3 ms, then closes the devices on the microtask after the one where `serve` answered the
  // ring and started its yield (the yield's message can't arrive between microtasks).
  d.poll = async () => {
    for (const t = performance.now(); performance.now() - t < 3;);
    const closeOnAnswer = () => (Atomics.load(bell, 1) === 1 ? d.close() : queueMicrotask(closeOnAnswer));
    queueMicrotask(closeOnAnswer);
  };
  const served = d.serve(bell).then(() => 'ended');
  Atomics.add(bell, 0, 1);
  Atomics.notify(bell, 0);
  const r = await Promise.race([served, new Promise((resolve) => setTimeout(resolve, 2000, 'hung'))]);
  if (r === 'hung') {
    // Let it out (a ring wakes it and it sees the close), or this file's process never exits.
    Atomics.add(bell, 0, 1);
    Atomics.notify(bell, 0);
    await served;
  }
  assert.equal(r, 'ended');
});
