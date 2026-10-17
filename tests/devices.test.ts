// Device backends without a guest: the 9P2000.L server (web/9p.ts), the
// loopback network adapter (web/net.ts) and virtio-input's config answers.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { P9Server } from '../web/9p.ts';
import { blk, deviceEntry, Devices, inputConfig, type Ctx } from '../web/devices.ts';
import { memFile } from '../web/overlay.ts';
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

test('changeConfig: the generation goes odd around the write, even after it, and the signal word is set', () => {
  // The layout (docs/abi.md): config_gen at 20, config at 24; the signal word and a vCPU's wake word elsewhere.
  const memory = { buffer: new SharedArrayBuffer(4096) };
  const [shared, signal, wake] = [64, 1024, 1028];
  const gen = new Int32Array(memory.buffer, shared + 20, 1);
  const seen: number[] = [];
  const self = { memory, shared: [shared], signal, wakes: [wake], kick: (Devices.prototype as unknown as { kick(): void }).kick };
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
});

test('terminalBytes: what a terminal sends for the keys that drive EDK2 and GRUB', async () => {
  const { terminalBytes } = await import('../web/input.ts');
  const k = (key: string, m: { ctrlKey?: boolean; altKey?: boolean; metaKey?: boolean } = {}) => terminalBytes({ key, ctrlKey: false, altKey: false, metaKey: false, ...m });
  assert.deepEqual(['a', 'A', '~', ' '].map((c) => k(c)), ['a', 'A', '~', ' ']);
  assert.deepEqual(['Enter', 'Escape', 'Backspace', 'Tab'].map((c) => k(c)), ['\r', '\x1b', '\x7f', '\t']);
  assert.deepEqual(['ArrowUp', 'ArrowDown', 'ArrowRight', 'ArrowLeft', 'Home', 'End', 'Delete', 'F2'].map((c) => k(c)), ['\x1b[A', '\x1b[B', '\x1b[C', '\x1b[D', '\x1b[H', '\x1b[F', '\x1b[3~', '\x1bOQ']);
  assert.equal(k('x', { ctrlKey: true }), '\x18'); // Ctrl-X boots a GRUB entry
  assert.equal(k('e', { altKey: true }), '\x1be');
  assert.deepEqual(['Shift', 'Control', 'CapsLock', 'Dead'].map((c) => k(c)), [null, null, null, null]);
  assert.equal(k('a', { metaKey: true }), null);
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
  const ctx = { ram: () => ram } as unknown as Ctx;
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
    const n = await b.request({ w0: 0, queue: 0, read: [{ off: 0, len: 16 }, { off: 16, len: body.length }].filter((s) => s.len), write: [{ off: 8192, len: room + 1 }] });
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
  assert.deepEqual(b.written!(), [0, 1, 2, 3, 10]);
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
