// virtio-net's offloads (web/offload.ts) at the byte level: partial checksums finished, TCP and UDP packets
// cut into segments, received checksums vouched for. Checksums are checked with web/net.ts's own `checksum`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checksumValid, MAX_FRAME, NET_HDR, transmit } from '../web/offload.ts';
import { checksum } from '../web/net.ts';

const be16 = (b: Uint8Array, at: number) => (b[at] << 8) | b[at + 1];
const be32 = (b: Uint8Array, at: number) => ((b[at] << 24) | (b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3]) >>> 0;
const put16 = (b: Uint8Array, at: number, v: number) => { b[at] = v >> 8; b[at + 1] = v & 255; };
const ETH = 14;
const SRC4 = [100, 90, 0, 7];
const DST4 = [192, 0, 2, 1];
const SRC6 = [0xfd, 0x7a, 0x11, 0x5c, 0xa1, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 7];
const DST6 = [0x20, 0x01, 0x0d, 0xb8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1];
const TCP = 6;
const UDP = 17;

/** The pseudo-header (IPv4 or IPv6) for an upper-layer message of `len` bytes. */
function pseudo(v6: boolean, proto: number, len: number) {
  return Uint8Array.from(v6 ? [...SRC6, ...DST6, 0, 0, len >> 8, len & 255, 0, 0, 0, proto] : [...SRC4, ...DST4, 0, proto, len >> 8, len & 255]);
}

/** Whether `seg`'s transport checksum is right over its pseudo-header (an independent check). */
function l4Ok(seg: Uint8Array, v6: boolean, proto: number) {
  const l4 = ETH + (v6 ? 40 : 20);
  const msg = seg.subarray(l4);
  const all = new Uint8Array(pseudo(v6, proto, msg.length).length + msg.length);
  all.set(pseudo(v6, proto, msg.length));
  all.set(msg, all.length - msg.length);
  return checksum(all) === 0;
}

/**
 * A packet as the guest hands it over with offloads: the virtio header (`gso`, `mss`, NEEDS_CSUM at the transport
 * header), then Ethernet, IPv4 or IPv6 and TCP (timestamps option, flags `flags`) or UDP, the payload a counting
 * pattern; the transport checksum holds the pseudo-header's sum, as Linux leaves it.
 */
function guestPacket(o: { v6: boolean; proto: number; payload: number; gso: number; mss: number; flags?: number }) {
  const l3 = ETH;
  const l4 = l3 + (o.v6 ? 40 : 20);
  const hl = l4 + (o.proto === TCP ? 32 : 8);
  const f = new Uint8Array(hl + o.payload);
  f.set([0x02, 0x77, 0x65, 0x62, 0x70, 0x63, 0x52, 0x54, 0x00, 0x12, 0x34, 0x56]);
  put16(f, 12, o.v6 ? 0x86dd : 0x0800);
  if (o.v6) {
    f[l3] = 0x60;
    put16(f, l3 + 4, f.length - l4);
    f[l3 + 6] = o.proto;
    f[l3 + 7] = 64;
    f.set(SRC6, l3 + 8);
    f.set(DST6, l3 + 24);
  } else {
    f[l3] = 0x45;
    put16(f, l3 + 2, f.length - l3);
    put16(f, l3 + 4, 0xfffe); // the IDs wrap
    put16(f, l3 + 6, 0x4000); // DF
    f[l3 + 8] = 64;
    f[l3 + 9] = o.proto;
    f.set(SRC4, l3 + 12);
    f.set(DST4, l3 + 16);
    put16(f, l3 + 10, checksum(f.subarray(l3, l4)));
  }
  put16(f, l4, 40000);
  put16(f, l4 + 2, 443);
  let csumOffset: number;
  if (o.proto === TCP) {
    f.set([0xff, 0xff, 0xf0, 0x00], l4 + 4); // the sequence numbers wrap
    f[l4 + 12] = 8 << 4;
    f[l4 + 13] = o.flags ?? 0x18; // ACK, PSH
    put16(f, l4 + 14, 512);
    f.set([1, 1, 8, 10, 0, 0, 0, 1, 0, 0, 0, 2], l4 + 20); // NOP, NOP, timestamps
    csumOffset = 16;
  } else {
    put16(f, l4 + 4, f.length - l4);
    csumOffset = 6;
  }
  for (let k = hl; k < f.length; k++) f[k] = (k * 7) & 255;
  // The pseudo-header's sum, folded and not complemented, where the checksum goes.
  const p = pseudo(o.v6, o.proto, f.length - l4);
  put16(f, l4 + csumOffset, ~checksum(p) & 0xffff);
  const h = new Uint8Array(NET_HDR);
  h[0] = 1; // NEEDS_CSUM
  h[1] = o.gso;
  h.set([hl & 255, hl >> 8, o.mss & 255, o.mss >> 8, l4 & 255, l4 >> 8, csumOffset, 0], 2);
  const b = new Uint8Array(NET_HDR + f.length);
  b.set(h);
  b.set(f, NET_HDR);
  return { b, frame: f.slice(), hl, l4 };
}

for (const [name, v6, proto, gso] of [['TCP over IPv4', false, TCP, 1], ['TCP over IPv6', true, TCP, 4], ['UDP over IPv4', false, UDP, 5], ['UDP over IPv6', true, UDP, 5]] as const) {
  test(`${name}: a large packet is cut into segments with their own lengths, IDs, sequence numbers and checksums`, () => {
    const mss = 1228;
    const payload = 3 * mss + 100;
    const { b, frame, hl, l4 } = guestPacket({ v6, proto, payload, gso: gso | (proto === TCP ? 0x80 : 0), mss, flags: 0x80 | 0x18 | 0x01 }); // CWR, ACK, PSH, FIN
    const segs = transmit(b);
    assert.equal(segs.length, 4);
    const data: number[] = [];
    segs.forEach((s, i) => {
      const len = i < 3 ? mss : 100;
      assert.equal(s.length, hl + len, `segment ${i}'s length`);
      assert.equal(Buffer.compare(s.subarray(0, 14), frame.subarray(0, 14)), 0, 'the Ethernet header is kept');
      if (v6) assert.equal(be16(s, ETH + 4), s.length - ETH - 40, 'the IPv6 payload length');
      else {
        assert.equal(be16(s, ETH + 2), s.length - ETH, 'the IPv4 total length');
        assert.equal(be16(s, ETH + 4), (0xfffe + i) & 0xffff, 'the IPv4 ID counts up');
        assert.equal(checksum(s.subarray(ETH, ETH + 20)), 0, 'the IPv4 header checksum');
      }
      assert.ok(l4Ok(s, v6, proto), `segment ${i}'s ${name} checksum`);
      assert.ok(checksumValid(s), `the receive side agrees on segment ${i}`);
      if (proto === TCP) {
        assert.equal(be32(s, l4 + 4), (0xfffff000 + i * mss) >>> 0, 'the sequence number');
        assert.equal(s[l4 + 13], i === 0 ? 0x90 : i === 3 ? 0x19 : 0x10, `segment ${i}'s flags: CWR first, PSH and FIN last`);
        assert.equal(Buffer.compare(s.subarray(l4 + 20, hl), frame.subarray(l4 + 20, hl)), 0, 'the options are kept');
      } else assert.equal(be16(s, l4 + 4), s.length - l4, 'the UDP length');
      data.push(...s.subarray(hl));
    });
    assert.equal(Buffer.compare(Buffer.from(data), frame.subarray(hl)), 0, 'the payloads, in order, are the packet\'s');
  });

  test(`${name}: a packet that isn't cut gets its checksum finished, and one shorter than the MSS is one segment`, () => {
    const { b, l4 } = guestPacket({ v6, proto, payload: 1000, gso: 0, mss: 0 });
    const [f, ...rest] = transmit(b);
    assert.equal(rest.length, 0);
    assert.ok(l4Ok(f, v6, proto) && checksumValid(f), 'the checksum is finished');
    assert.equal(f.length, b.length - NET_HDR);
    const small = transmit(guestPacket({ v6, proto, payload: 1000, gso, mss: 1228 }).b);
    assert.equal(small.length, 1);
    assert.ok(l4Ok(small[0], v6, proto));
    assert.equal(Buffer.compare(small[0].subarray(l4 + 8), f.subarray(l4 + 8)), 0);
  });
}

test('transmit: what the guest gets wrong is dropped, a packet without offloads passes untouched', () => {
  const ok = guestPacket({ v6: false, proto: TCP, payload: 4000, gso: 1, mss: 1228 });
  assert.deepEqual(transmit(new Uint8Array(NET_HDR)), [], 'the header alone');
  const noMss = ok.b.slice(); noMss[4] = noMss[5] = 0;
  assert.deepEqual(transmit(noMss), [], 'no MSS');
  const wrongFamily = ok.b.slice(); wrongFamily[1] = 4;
  assert.deepEqual(transmit(wrongFamily), [], 'TCPV6 on an IPv4 packet');
  const fragment = ok.b.slice(); fragment[NET_HDR + ETH + 6] = 0x20;
  assert.deepEqual(transmit(fragment), [], 'an IPv4 fragment');
  const big = guestPacket({ v6: false, proto: UDP, payload: MAX_FRAME, gso: 0, mss: 0 });
  assert.deepEqual(transmit(big.b), [], 'a frame over the MTU without GSO');
  const badCsum = guestPacket({ v6: false, proto: UDP, payload: 10, gso: 0, mss: 0 }).b;
  badCsum[8] = 200;
  assert.deepEqual(transmit(badCsum), [], 'a checksum place past the frame');
  const plain = guestPacket({ v6: false, proto: UDP, payload: 10, gso: 0, mss: 0 }).b;
  plain[0] = 0;
  const [f] = transmit(plain);
  assert.equal(Buffer.compare(f, plain.subarray(NET_HDR)), 0, 'no NEEDS_CSUM: the frame as it is');
});

test('checksumValid: right TCP and UDP checksums only, padding left out; not ICMP, fragments or UDP without a checksum', () => {
  const [f] = transmit(guestPacket({ v6: false, proto: TCP, payload: 20, gso: 0, mss: 0 }).b);
  assert.ok(checksumValid(f));
  const padded = new Uint8Array(f.length + 6); padded.set(f);
  padded.fill(0xaa, f.length);
  assert.ok(checksumValid(padded), 'Ethernet padding past the IP length');
  const bad = f.slice(); bad[bad.length - 1] ^= 1;
  assert.ok(!checksumValid(bad), 'a payload byte changed');
  const short = f.slice(); put16(short, ETH + 2, f.length); // the IP length claims more than there is
  assert.ok(!checksumValid(short));
  const frag = f.slice(); put16(frag, ETH + 6, 0x2000);
  assert.ok(!checksumValid(frag), 'a fragment');
  const icmp = f.slice(); icmp[ETH + 9] = 1;
  assert.ok(!checksumValid(icmp), 'ICMP isn\'t vouched for');
  const [u] = transmit(guestPacket({ v6: false, proto: UDP, payload: 20, gso: 0, mss: 0 }).b);
  assert.ok(checksumValid(u));
  const none = u.slice(); put16(none, ETH + 20 + 6, 0);
  assert.ok(!checksumValid(none), 'UDP over IPv4 without a checksum');
  const [u6] = transmit(guestPacket({ v6: true, proto: UDP, payload: 20, gso: 0, mss: 0 }).b);
  assert.ok(checksumValid(u6));
  const ext = u6.slice(); ext[ETH + 6] = 0; // a hop-by-hop header first
  assert.ok(!checksumValid(ext), 'IPv6 with an extension header is left to the guest');
  assert.ok(!checksumValid(Uint8Array.from([1, 2, 3])));
});
