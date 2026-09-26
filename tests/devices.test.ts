// Device backends without a guest: the 9P2000.L server (web/9p.ts), the
// loopback network adapter (web/net.ts) and virtio-input's config answers.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { P9Server } from '../web/9p.ts';
import { inputConfig } from '../web/devices.ts';
import { loopback, PEER_IP, PEER_MAC } from '../web/net.ts';

/** A T-message: size, type, tag 1, then the fields ([bytes, value] or a string). */
function msg(type: number, ...fields: (string | [number, number])[]) {
  const parts: number[] = [];
  for (const f of fields) {
    if (typeof f === 'string') {
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
  const s = new P9Server({ 'hello.txt': 'hi\n' }, true);
  const call = (m: Uint8Array) => {
    const r = s.handle(m, 8192);
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
  // Unsupported (xattrwalk): EOPNOTSUPP; truncated: EINVAL.
  assert.equal(call(msg(30, u32(0), u32(9), 'user.x')).v.getUint32(7, true), 95);
  assert.equal(call(msg(118, u32(3), u64(0), u32(100))).v.getUint32(7, true), 22);
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

test('virtio-input config answers', () => {
  assert.equal(new TextDecoder().decode(inputConfig('keyboard', 1, 0)), 'webpc keyboard');
  assert.equal(inputConfig('keyboard', 0x11, 1).length, 32); // keys 1-248
  assert.deepEqual([...inputConfig('keyboard', 0x11, 0x11)], [7]);
  assert.deepEqual([...inputConfig('tablet', 0x11, 3)], [3]);
  assert.deepEqual([...new Uint32Array(inputConfig('tablet', 0x12, 1).slice().buffer)], [0, 32767, 0, 0, 0]);
  assert.equal(inputConfig('tablet', 0x12, 2).length, 0);
  assert.equal(inputConfig('keyboard', 0x11, 3).length, 0);
});
