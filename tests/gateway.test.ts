// The Ethernet gateway (web/gateway.ts): ARP, DHCP and framing at the byte level,
// with a synchronous IP backend, and the same through the device worker's `echo` adapter.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ECHO_LEASE, GATEWAY_IP, GATEWAY_MAC, echoBackend, gateway, type IpBackend, type Lease } from '../web/gateway.ts';
import { checksum } from '../web/net.ts';

const GUEST_MAC = [0x52, 0x54, 0x00, 0x12, 0x34, 0x56];
const hex = (b: ArrayLike<number>) => Buffer.from(Array.from(b)).toString('hex');
const be16 = (b: Uint8Array, at: number) => (b[at] << 8) | b[at + 1];

function rig(lease: Lease | null = ECHO_LEASE, backendSend?: (p: Uint8Array) => void) {
  const out: Uint8Array[] = []; // frames for the guest
  const sent: Uint8Array[] = []; // packets for the backend
  let deliver!: (p: Uint8Array) => void;
  const g = gateway((f) => out.push(f), (d) => {
    deliver = d;
    const inner = echoBackend(lease ?? ECHO_LEASE)(d);
    return { lease: () => lease, send: (p) => { sent.push(p); backendSend?.(p) ?? inner.send(p); } } satisfies IpBackend;
  });
  return { g, out, sent, deliver: (p: Uint8Array) => deliver(p), setLease: (l: Lease | null) => (lease = l) };
}

function frame(dst: Iterable<number>, src: Iterable<number>, type: number, payload: Iterable<number>) {
  return Uint8Array.from([...dst, ...src, type >> 8, type & 255, ...payload]);
}

function arpRequest(senderIp: number[], targetIp: number[]) {
  return frame([255, 255, 255, 255, 255, 255], GUEST_MAC, 0x0806, [0, 1, 8, 0, 6, 4, 0, 1, ...GUEST_MAC, ...senderIp, 0, 0, 0, 0, 0, 0, ...targetIp, ...new Array(18).fill(0)]);
}

function ipv4(src: number[], dst: number[], proto: number, payload: number[], flags = 0) {
  const p = new Uint8Array(20 + payload.length);
  p.set([0x45, 0, (p.length >> 8) & 255, p.length & 255, 0, 1, flags, 0, 64, proto, 0, 0, ...src, ...dst, ...payload]);
  const c = checksum(p.subarray(0, 20));
  p[10] = c >> 8;
  p[11] = c & 255;
  return p;
}

function icmpEcho(type: number, size: number) {
  const m = new Uint8Array(8 + size);
  m.set([type, 0, 0, 0, 0x77, 0x70, 0, 1]);
  m.fill(0xab, 8);
  const c = checksum(m);
  m[2] = c >> 8;
  m[3] = c & 255;
  return Array.from(m);
}

function dhcpMsg(type: number, opts: number[] = [], ciaddr = [0, 0, 0, 0], xid = [0xde, 0xad, 0xbe, 0xef]) {
  const m = new Uint8Array(240);
  m[0] = 1; m[1] = 1; m[2] = 6;
  m.set(xid, 4);
  m.set(ciaddr, 12);
  m.set(GUEST_MAC, 28);
  m.set([0x63, 0x82, 0x53, 0x63], 236);
  const body = Uint8Array.from([...m, 53, 1, type, ...opts, 255]);
  const u = new Uint8Array(8 + body.length);
  u.set([0, 68, 0, 67, (u.length >> 8) & 255, u.length & 255, 0, 0]);
  u.set(body, 8);
  const unicast = ciaddr.some((v) => v);
  return frame(unicast ? GATEWAY_MAC : [255, 255, 255, 255, 255, 255], GUEST_MAC, 0x0800, ipv4(ciaddr, unicast ? GATEWAY_IP : [255, 255, 255, 255], 17, Array.from(u)));
}

/** Splits a frame from the gateway carrying a DHCP reply into its parts. */
function dhcpReply(f: Uint8Array) {
  assert.equal(be16(f, 12), 0x0800);
  const ip = f.subarray(14);
  assert.equal(checksum(ip.subarray(0, 20)), 0, 'IP checksum');
  assert.equal(ip[9], 17);
  assert.equal(be16(ip, 20), 67);
  assert.equal(be16(ip, 22), 68);
  const b = ip.subarray(28, be16(ip, 2));
  const opts = new Map<number, Uint8Array>();
  for (let k = 240; b[k] !== 255; k += 2 + b[k + 1]) opts.set(b[k], b.subarray(k + 2, k + 2 + b[k + 1]));
  return { dst: f.subarray(0, 6), ipDst: ip.subarray(16, 20), ipSrc: ip.subarray(12, 16), xid: b.subarray(4, 8), yiaddr: b.subarray(16, 20), siaddr: b.subarray(20, 24), type: opts.get(53)![0], opts };
}

test('proxy ARP answers for every address but the guest\'s own, from the gateway MAC', () => {
  const { g, out } = rig();
  g.send(arpRequest(ECHO_LEASE.address, [100, 90, 0, 1])); // any address, a tailnet peer's
  g.send(arpRequest(ECHO_LEASE.address, GATEWAY_IP));
  g.send(arpRequest(ECHO_LEASE.address, ECHO_LEASE.address)); // the guest's own: not ours to answer
  g.send(arpRequest([0, 0, 0, 0], [100, 90, 0, 1])); // a probe
  assert.equal(out.length, 2);
  assert.equal(
    hex(out[0]),
    hex(frame(GUEST_MAC, GATEWAY_MAC, 0x0806, [0, 1, 8, 0, 6, 4, 0, 2, ...GATEWAY_MAC, 100, 90, 0, 1, ...GUEST_MAC, ...ECHO_LEASE.address])),
  );
  assert.deepEqual(Array.from(out[1].subarray(28, 32)), GATEWAY_IP);
});

test('DHCP: discover, offer, request, ack with the backend\'s address and the options', () => {
  const { g, out } = rig();
  g.send(dhcpMsg(1));
  const offer = dhcpReply(out.pop()!);
  assert.equal(offer.type, 2);
  assert.equal(hex(offer.dst), 'ffffffffffff');
  assert.equal(hex(offer.ipDst), 'ffffffff');
  assert.deepEqual(Array.from(offer.ipSrc), GATEWAY_IP);
  assert.equal(hex(offer.xid), 'deadbeef');
  assert.deepEqual(Array.from(offer.yiaddr), ECHO_LEASE.address);
  g.send(dhcpMsg(3, [50, 4, ...ECHO_LEASE.address, 54, 4, ...GATEWAY_IP]));
  const ack = dhcpReply(out.pop()!);
  assert.equal(ack.type, 5);
  assert.deepEqual(Array.from(ack.yiaddr), ECHO_LEASE.address);
  const o = ack.opts;
  assert.equal(hex(o.get(1)!), '00000000', 'mask: everything on-link');
  assert.deepEqual(Array.from(o.get(3)!), GATEWAY_IP, 'router');
  assert.deepEqual(Array.from(o.get(6)!), ECHO_LEASE.dns[0], 'dns');
  assert.equal(Buffer.from(o.get(15)!).toString(), 'test.webpc');
  assert.equal(be16(o.get(26)!, 0), 1280, 'mtu');
  assert.equal(hex(o.get(51)!), '00000e10');
  assert.equal(hex(o.get(121)!), hex([32, ...GATEWAY_IP, 0, 0, 0, 0, 0, ...GATEWAY_IP]), 'classless routes');
  assert.deepEqual(Array.from(o.get(54)!), GATEWAY_IP);
});

test('DHCP follows the backend: no lease, no offer; a request for another address or without a lease is refused', () => {
  const { g, out, setLease } = rig(null);
  g.send(dhcpMsg(1));
  assert.equal(out.length, 0);
  g.send(dhcpMsg(3, [50, 4, 10, 0, 0, 9]));
  assert.equal(dhcpReply(out.pop()!).type, 6); // NAK: no lease
  setLease(ECHO_LEASE);
  g.send(dhcpMsg(3, [50, 4, 10, 0, 0, 9]));
  const nak = dhcpReply(out.pop()!);
  assert.equal(nak.type, 6);
  assert.equal(nak.opts.has(1), false);
  g.send(dhcpMsg(3, [50, 4, ...ECHO_LEASE.address, 54, 4, 1, 2, 3, 4])); // another server's: ignored
  assert.equal(out.length, 0);
});

test('DHCP renewal (ciaddr set) is answered unicast to the guest', () => {
  const { g, out } = rig();
  g.send(dhcpMsg(3, [], ECHO_LEASE.address));
  const ack = dhcpReply(out.pop()!);
  assert.equal(ack.type, 5);
  assert.equal(hex(ack.dst), hex(GUEST_MAC));
  assert.deepEqual(Array.from(ack.ipDst), ECHO_LEASE.address);
});

test('IP framing: packets lose their Ethernet header out and gain it in', () => {
  const { g, out, sent, deliver } = rig();
  g.send(dhcpMsg(1)); // the guest's MAC is learned from its first frame
  out.length = 0;
  const ping = ipv4(ECHO_LEASE.address, [100, 90, 0, 1], 1, icmpEcho(8, 32));
  g.send(frame(GATEWAY_MAC, GUEST_MAC, 0x0800, [...ping, 0, 0, 0])); // Ethernet padding is cut
  assert.equal(sent.length, 1);
  assert.equal(hex(sent[0]), hex(ping));
  // The echo backend answered synchronously: a frame from the gateway to the guest.
  assert.equal(out.length, 1);
  const r = out[0];
  assert.equal(hex(r.subarray(0, 6)), hex(GUEST_MAC));
  assert.equal(hex(r.subarray(6, 12)), hex(GATEWAY_MAC));
  assert.deepEqual(Array.from(r.subarray(26, 30)), [100, 90, 0, 1]);
  assert.equal(r[34], 0); // echo reply
  assert.equal(checksum(r.subarray(34)), 0);
  // A packet from the backend at another time is framed the same way.
  out.length = 0;
  deliver(ping);
  assert.equal(hex(out[0]), hex(frame(GUEST_MAC, GATEWAY_MAC, 0x0800, ping)));
});

test('what must not reach the backend is dropped: spoofed sources, multicast, IPv6, other ethertypes, no lease', () => {
  const { g, sent, setLease } = rig();
  const to = (src: number[], dst: number[]) => frame(GATEWAY_MAC, GUEST_MAC, 0x0800, ipv4(src, dst, 1, icmpEcho(8, 8)));
  g.send(to([10, 9, 9, 9], [100, 90, 0, 1])); // not the guest's address
  g.send(to(ECHO_LEASE.address, [224, 0, 0, 251]));
  g.send(to(ECHO_LEASE.address, [255, 255, 255, 255]));
  g.send(frame(GATEWAY_MAC, GUEST_MAC, 0x86dd, new Array(60).fill(0)));
  g.send(frame(GATEWAY_MAC, GUEST_MAC, 0x88cc, new Array(60).fill(0)));
  g.send(new Uint8Array(10));
  setLease(null);
  g.send(to(ECHO_LEASE.address, [100, 90, 0, 1]));
  assert.equal(sent.length, 0);
});

test('a packet over the MTU: ICMP fragmentation needed with DF, dropped without', () => {
  const { g, out, sent } = rig();
  const big = (flags: number) => frame(GATEWAY_MAC, GUEST_MAC, 0x0800, ipv4(ECHO_LEASE.address, [100, 90, 0, 1], 17, new Array(1400).fill(1), flags));
  g.send(big(0));
  assert.equal(out.length, 0);
  g.send(big(0x40));
  assert.equal(sent.length, 0);
  assert.equal(out.length, 1);
  const ip = out[0].subarray(14);
  assert.equal(checksum(ip.subarray(0, 20)), 0);
  assert.deepEqual(Array.from(ip.subarray(12, 16)), GATEWAY_IP);
  assert.deepEqual(Array.from(ip.subarray(16, 20)), ECHO_LEASE.address);
  assert.deepEqual(Array.from(ip.subarray(20, 22)), [3, 4]);
  assert.equal(be16(ip, 26), 1280);
  assert.equal(checksum(ip.subarray(20)), 0);
  assert.deepEqual(Array.from(ip.subarray(28, 32)), [0x45, 0, 5, 0x8c]); // the quoted header of the 1420-byte packet
});

test('the gateway answers pings to its own address', () => {
  const { g, out, sent } = rig();
  g.send(frame(GATEWAY_MAC, GUEST_MAC, 0x0800, ipv4(ECHO_LEASE.address, GATEWAY_IP, 1, icmpEcho(8, 16))));
  assert.equal(sent.length, 0);
  assert.equal(out.length, 1);
  assert.equal(out[0][34], 0);
  assert.deepEqual(Array.from(out[0].subarray(26, 30)), GATEWAY_IP);
  assert.equal(checksum(out[0].subarray(34)), 0);
});
