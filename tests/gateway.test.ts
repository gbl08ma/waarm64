// The Ethernet gateway (web/gateway.ts): ARP, DHCP and framing at the byte level,
// with a synchronous IP backend, and the same through the device worker's `echo` adapter.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ECHO_LEASE, GATEWAY_IP, GATEWAY_IP6, GATEWAY_MAC, echoBackend, gateway, type IpBackend, type Lease } from '../web/gateway.ts';
import { ALL_DHCP_AGENTS, ALL_NODES, ALL_ROUTERS, icmp6, ip6, multicastMac, sum6, udp6 } from '../web/ip6.ts';
import { checksum } from '../web/net.ts';

const GUEST_MAC = [0x52, 0x54, 0x00, 0x12, 0x34, 0x56];
const hex = (b: ArrayLike<number>) => Buffer.from(Array.from(b)).toString('hex');
const be16 = (b: Uint8Array, at: number) => (b[at] << 8) | b[at + 1];

function rig(lease: Lease | null = ECHO_LEASE, backendSend?: (p: Uint8Array) => void) {
  const out: Uint8Array[] = []; // frames for the guest
  const sent: Uint8Array[] = []; // packets for the backend
  let deliver!: (p: Uint8Array) => void;
  let changed!: () => void;
  const g = gateway((f) => out.push(f), (d, c) => {
    deliver = d;
    changed = c;
    const inner = echoBackend(lease ?? ECHO_LEASE)(d);
    return { lease: () => lease, send: (p) => { sent.push(p); backendSend?.(p) ?? inner.send(p); } } satisfies IpBackend;
  });
  return { g, out, sent, deliver: (p: Uint8Array) => deliver(p), setLease: (l: Lease | null) => { lease = l; changed(); } };
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
  assert.equal(hex(o.get(1)!), 'ffffffff', 'mask: a /32 (systemd-networkd rejects 0.0.0.0), the routes come from option 121');
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
  out.length = 0; // (the lease's IPv6 address was advertised: N6)
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

// ---- IPv6 (N6) ----

const L6 = ECHO_LEASE.address6!;
const GUEST_LL = [0xfe, 0x80, 0, 0, 0, 0, 0, 0, 0x50, 0x54, 0x00, 0xff, 0xfe, 0x12, 0x34, 0x56];
const SOLICITED = [0xff, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0xff, ...GATEWAY_IP6.slice(13)];
const toGateway = (packet: Uint8Array, dst: Iterable<number> = GATEWAY_MAC) => frame(dst, GUEST_MAC, 0x86dd, packet);

/** An IPv6 frame from the gateway: checks the headers and checksums and returns the parts. */
function v6(f: Uint8Array) {
  assert.equal(be16(f, 12), 0x86dd);
  const p = f.subarray(14);
  assert.equal(p[0] >> 4, 6);
  assert.equal(be16(p, 4), p.length - 40, 'payload length');
  const [src, dst, next] = [p.subarray(8, 24), p.subarray(24, 40), p[6]];
  const body = p.subarray(40);
  assert.equal(sum6(src, dst, next, body), 0, `checksum (next header ${next})`);
  return { dstMac: f.subarray(0, 6), src, dst, next, hop: p[7], body };
}

function rs() {
  return toGateway(icmp6(GUEST_LL, ALL_ROUTERS, 133, 0, [0, 0, 0, 0], [1, 1, ...GUEST_MAC], 255), multicastMac(ALL_ROUTERS));
}

test('a router solicitation is answered with an advertisement: default router, M and O, the MTU, no prefix', () => {
  const { g, out } = rig();
  g.send(rs());
  assert.equal(out.length, 1);
  const r = v6(out[0]);
  assert.equal(hex(r.dstMac), hex(multicastMac(ALL_NODES)));
  assert.deepEqual(Array.from(r.src), GATEWAY_IP6);
  assert.deepEqual(Array.from(r.dst), ALL_NODES);
  assert.equal(r.hop, 255);
  assert.equal(r.body[0], 134);
  assert.equal(r.body[5] & 0xc0, 0xc0, 'managed and other-config');
  assert.equal(be16(r.body, 6), 1800, 'router lifetime');
  // options: source link-layer address, MTU, RDNSS; never a prefix information option (3)
  const types: number[] = [];
  const opts = new Map<number, Uint8Array>();
  for (let k = 16; k < r.body.length; k += r.body[k + 1] * 8) { types.push(r.body[k]); opts.set(r.body[k], r.body.subarray(k + 2, k + r.body[k + 1] * 8)); }
  assert.deepEqual(types, [1, 5, 25]);
  assert.equal(hex(opts.get(1)!), hex(GATEWAY_MAC));
  assert.equal(Buffer.from(opts.get(5)!.subarray(2, 6)).readUInt32BE(0), 1280);
  assert.deepEqual(Array.from(opts.get(25)!.subarray(6, 22)), ECHO_LEASE.dns6![0]);
});

test('advertisements follow the lease: none without an IPv6 address, one when it appears, a lifetime-0 one when it goes', () => {
  const { g, out, setLease } = rig({ ...ECHO_LEASE, address6: undefined });
  g.send(rs());
  assert.equal(out.length, 0, 'IPv4 only: nothing to advertise');
  setLease({ ...ECHO_LEASE, address6: undefined });
  assert.equal(out.length, 0);
  setLease(ECHO_LEASE);
  assert.equal(out.length, 1, 'the lease gained an address: advertised unprompted');
  assert.equal(be16(v6(out[0]).body, 6), 1800);
  setLease({ ...ECHO_LEASE, address6: undefined });
  assert.equal(out.length, 2);
  assert.equal(be16(v6(out[1]).body, 6), 0, 'the router goes away');
  setLease(null);
  assert.equal(out.length, 2, 'once is enough');
});

test('neighbor discovery: the gateway answers for its own link-local address only; probes are ignored', () => {
  const { g, out } = rig();
  const ns = (target: number[], src = GUEST_LL, hop = 255) => toGateway(icmp6(src, SOLICITED, 135, 0, [0, 0, 0, 0], [...target, 1, 1, ...GUEST_MAC], hop), multicastMac(SOLICITED));
  g.send(ns(GATEWAY_IP6));
  assert.equal(out.length, 1);
  const na = v6(out[0]);
  assert.equal(hex(na.dstMac), hex(GUEST_MAC));
  assert.deepEqual(Array.from(na.src), GATEWAY_IP6);
  assert.deepEqual(Array.from(na.dst), GUEST_LL);
  assert.equal(na.body[0], 136);
  assert.equal(na.body[4], 0xe0, 'router, solicited, override');
  assert.deepEqual(Array.from(na.body.subarray(8, 24)), GATEWAY_IP6);
  assert.deepEqual(Array.from(na.body.subarray(24, 32)), [2, 1, ...GATEWAY_MAC]);
  g.send(ns(L6)); // the guest's own address, a peer's: not ours
  g.send(ns(GATEWAY_IP6, new Array(16).fill(0))); // duplicate address detection
  g.send(ns(GATEWAY_IP6, GUEST_LL, 64)); // not from the link
  assert.equal(out.length, 1);
});

test('ICMPv6 echo to the gateway is answered', () => {
  const { g, out, sent } = rig();
  g.send(rs()); // the guest's MAC is learned
  out.length = 0;
  g.send(toGateway(icmp6(GUEST_LL, GATEWAY_IP6, 128, 0, [0x12, 0x34, 0, 1], [1, 2, 3, 4, 5])));
  assert.equal(sent.length, 0);
  const r = v6(out[0]);
  assert.equal(r.body[0], 129);
  assert.deepEqual(Array.from(r.body.subarray(4)), [0x12, 0x34, 0, 1, 1, 2, 3, 4, 5]);
  assert.deepEqual(Array.from(r.dst), GUEST_LL);
});

const DUID_CLIENT = [0, 3, 0, 1, ...GUEST_MAC];
const d6opt = (code: number, body: number[]) => [code >> 8, code & 255, body.length >> 8, body.length & 255, ...body];
const IAID = [0, 0, 0, 1];
const iaNa = (addr?: number[]) => d6opt(3, [...IAID, 0, 0, 0, 0, 0, 0, 0, 0, ...(addr ? d6opt(5, [...addr, 0, 0, 0, 0, 0, 0, 0, 0]) : [])]);
const SERVER_ID = [0, 3, 0, 1, ...GATEWAY_MAC];

function dhcp6Msg(type: number, opts: number[], dst: ArrayLike<number> = ALL_DHCP_AGENTS) {
  const data = Uint8Array.from([type, 0xab, 0xcd, 0xef, ...d6opt(1, DUID_CLIENT), ...opts]);
  const dstMac = dst === ALL_DHCP_AGENTS ? multicastMac(ALL_DHCP_AGENTS) : GATEWAY_MAC;
  return toGateway(udp6(GUEST_LL, dst, 546, 547, data), dstMac);
}

function dhcp6Reply(f: Uint8Array) {
  const r = v6(f);
  assert.equal(r.next, 17);
  assert.equal(be16(r.body, 0), 547);
  assert.equal(be16(r.body, 2), 546);
  assert.deepEqual(Array.from(r.dst), GUEST_LL);
  assert.deepEqual(Array.from(r.src), GATEWAY_IP6);
  assert.equal(hex(r.dstMac), hex(GUEST_MAC));
  const m = r.body.subarray(8);
  const opts = new Map<number, Uint8Array>();
  for (let k = 4; k < m.length; k += 4 + be16(m, k + 2)) opts.set(be16(m, k), m.subarray(k + 4, k + 4 + be16(m, k + 2)));
  return { type: m[0], xid: hex(m.subarray(1, 4)), opts };
}

test('DHCPv6: solicit, advertise, request, reply with the lease\'s address as one IA_NA, resolvers and domain', () => {
  const { g, out } = rig();
  g.send(dhcp6Msg(1, iaNa()));
  const adv = dhcp6Reply(out.pop()!);
  assert.equal(adv.type, 2);
  assert.equal(adv.xid, 'abcdef');
  assert.equal(hex(adv.opts.get(1)!), hex(DUID_CLIENT));
  assert.equal(hex(adv.opts.get(2)!), hex(SERVER_ID));
  const ia = adv.opts.get(3)!;
  assert.equal(hex(ia.subarray(0, 4)), hex(IAID));
  assert.equal(be16(ia, 12), 5);
  assert.deepEqual(Array.from(ia.subarray(16, 32)), L6);
  g.send(dhcp6Msg(3, [...d6opt(2, SERVER_ID), ...iaNa(L6)]));
  const rep = dhcp6Reply(out.pop()!);
  assert.equal(rep.type, 7);
  assert.deepEqual(Array.from(rep.opts.get(3)!.subarray(16, 32)), L6);
  assert.equal(Buffer.from(rep.opts.get(3)!.subarray(32, 36)).readUInt32BE(0), 3600, 'preferred');
  assert.deepEqual(Array.from(rep.opts.get(23)!), ECHO_LEASE.dns6!.flat());
  assert.equal(hex(rep.opts.get(24)!), hex([4, ...Buffer.from('test'), 5, ...Buffer.from('webpc'), 0]));
});

test('DHCPv6: renew keeps the address, another address has no binding, confirm and information-request', () => {
  const { g, out } = rig();
  g.send(dhcp6Msg(5, [...d6opt(2, SERVER_ID), ...iaNa(L6)], GATEWAY_IP6));
  assert.deepEqual(Array.from(dhcp6Reply(out.pop()!).opts.get(3)!.subarray(16, 32)), L6);
  const other = L6.slice(0, 15).concat([0x77]);
  g.send(dhcp6Msg(5, [...d6opt(2, SERVER_ID), ...iaNa(other)], GATEWAY_IP6));
  const nb = dhcp6Reply(out.pop()!).opts.get(3)!;
  assert.equal(be16(nb, 12), 13, 'a status code instead of an address');
  assert.equal(be16(nb, 16), 3, 'NoBinding');
  g.send(dhcp6Msg(6, iaNa(L6))); // rebind: no server id
  assert.equal(dhcp6Reply(out.pop()!).type, 7);
  g.send(dhcp6Msg(4, iaNa(L6)));
  assert.equal(be16(dhcp6Reply(out.pop()!).opts.get(13)!, 0), 0, 'confirm: success');
  g.send(dhcp6Msg(4, iaNa(other)));
  assert.equal(be16(dhcp6Reply(out.pop()!).opts.get(13)!, 0), 4, 'confirm: NotOnLink');
  g.send(dhcp6Msg(11, []));
  const info = dhcp6Reply(out.pop()!);
  assert.equal(info.opts.has(3), false);
  assert.deepEqual(Array.from(info.opts.get(23)!), ECHO_LEASE.dns6!.flat());
});

test('DHCPv6 follows the lease: no IPv6 address, no answer; a request for another server is ignored', () => {
  const { g, out, setLease } = rig({ ...ECHO_LEASE, address6: undefined });
  g.send(dhcp6Msg(1, iaNa()));
  assert.equal(out.length, 0);
  setLease(ECHO_LEASE);
  out.length = 0;
  g.send(dhcp6Msg(3, [...d6opt(2, [0, 3, 0, 1, 1, 2, 3, 4, 5, 6]), ...iaNa(L6)]));
  assert.equal(out.length, 0);
});

test('IPv6 framing: packets lose their Ethernet header out and gain it in; the echo backend answers any address', () => {
  const { g, out, sent, deliver } = rig();
  g.send(rs());
  out.length = 0;
  const peer = [0xfd, 0x7a, 0x11, 0x5c, 0xa1, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 9];
  const ping = icmp6(L6, peer, 128, 0, [0x77, 0x70, 0, 1], new Array(32).fill(0xab));
  g.send(toGateway(Uint8Array.from([...ping, 0, 0, 0]))); // padding is cut
  assert.equal(sent.length, 1);
  assert.equal(hex(sent[0]), hex(ping));
  assert.equal(out.length, 1);
  const r = v6(out[0]);
  assert.equal(r.body[0], 129);
  assert.deepEqual(Array.from(r.src), peer);
  assert.deepEqual(Array.from(r.dst), L6);
  assert.equal(hex(r.dstMac), hex(GUEST_MAC));
  out.length = 0;
  deliver(ping);
  assert.equal(hex(out[0]), hex(frame(GUEST_MAC, GATEWAY_MAC, 0x86dd, ping)));
});

test('IPv6 that must not reach the backend is dropped: spoofed sources, multicast, hop-by-hop, no address, a truncated packet', () => {
  const { g, sent, setLease } = rig();
  const peer = [0xfd, 0x7a, 0x11, 0x5c, 0xa1, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 9];
  const echo = (src: number[], dst: number[]) => toGateway(icmp6(src, dst, 128, 0, [0, 0, 0, 1], [1]));
  g.send(echo(peer, peer)); // not the guest's address
  g.send(echo(GUEST_LL, peer)); // link-local sources don't leave the LAN
  g.send(echo(L6, [0xff, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xfb])); // mDNS and the rest of multicast
  const hbh = ip6(L6, peer, 0, Uint8Array.from([58, 0, 1, 4, 0, 0, 0, 0]));
  g.send(toGateway(hbh));
  g.send(toGateway(ip6(L6, peer, 58, new Uint8Array(8)).subarray(0, 44))); // shorter than its length says
  setLease({ ...ECHO_LEASE, address6: undefined });
  g.send(echo(L6, peer));
  assert.equal(sent.length, 1, 'only the hop-by-hop packet got through the filters, by design: extension headers are the backend\'s to judge');
  assert.equal(sent[0][6], 0);
});

test('an IPv6 packet over the MTU: Packet Too Big with the MTU and as much of the packet as fits', () => {
  const { g, out, sent } = rig();
  const peer = [0xfd, 0x7a, 0x11, 0x5c, 0xa1, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 9];
  g.send(toGateway(udp6(L6, peer, 1000, 2000, new Uint8Array(1300))));
  assert.equal(sent.length, 0);
  const r = v6(out[0]);
  assert.equal(r.body[0], 2);
  assert.equal(Buffer.from(r.body.subarray(4, 8)).readUInt32BE(0), 1280);
  assert.deepEqual(Array.from(r.dst), L6);
  assert.deepEqual(Array.from(r.body.subarray(8, 16)), [0x60, 0, 0, 0, 0x05, 0x1c, 17, 64], 'the quoted header of the guest\'s packet');
  assert.ok(14 + 40 + r.body.length <= 14 + 1280 + 0, 'the message fits the minimum MTU');
});

/** A TCP segment from `src` to `dst` (4 or 16 bytes each) with these flags and options, its checksum set. */
function tcp(src: number[], dst: number[], flags: number, options: number[]) {
  const t = new Uint8Array(20 + options.length);
  t.set([0xc0, 0x01, 0x01, 0xbb, 0, 0, 0, 1, 0, 0, 0, 0, ((20 + options.length) / 4) << 4, flags, 0xff, 0xff]);
  t.set(options, 20);
  const c = tcpSum(src, dst, t);
  t[16] = c >> 8;
  t[17] = c & 255;
  return t;
}
/** TCP's checksum over its pseudo-header: 0 for a segment whose checksum is right. */
function tcpSum(src: number[], dst: number[], t: Uint8Array) {
  if (src.length === 16) return sum6(src, dst, 6, t);
  return checksum(Uint8Array.from([...src, ...dst, 0, 6, t.length >> 8, t.length & 255, ...t]));
}
// MSS 1460, SACK permitted, a NOP, window scale 7: what Linux sends from a 1500-byte link.
const SYN_OPTIONS = [2, 4, 0x05, 0xb4, 4, 2, 1, 3, 3, 7];

test('TCP SYNs both ways get an MSS that fits the lease\'s MTU (1240 over IPv4, 1220 over IPv6), checksums patched', () => {
  const { g, sent, out, deliver } = rig();
  g.send(dhcpMsg(1));
  g.send(rs());
  out.length = 0;
  const peer4 = [89, 144, 30, 89];
  const peer6 = [0x2a, 0x01, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x89];
  const mssOf = (t: Uint8Array) => be16(t, 22);
  // The guest's SYN, out.
  g.send(frame(GATEWAY_MAC, GUEST_MAC, 0x0800, ipv4(ECHO_LEASE.address, peer4, 6, Array.from(tcp(ECHO_LEASE.address, peer4, 0x02, SYN_OPTIONS)))));
  let t = sent.at(-1)!.subarray(20);
  assert.equal(mssOf(t), 1240);
  assert.equal(tcpSum(ECHO_LEASE.address, peer4, t), 0, 'the TCP checksum still holds');
  assert.equal(checksum(sent.at(-1)!.subarray(0, 20)), 0, 'the IP header is untouched');
  assert.deepEqual(Array.from(t.subarray(24, 30)), SYN_OPTIONS.slice(4), 'the other options are untouched');
  // The server's SYN-ACK, in.
  deliver(ipv4(peer4, ECHO_LEASE.address, 6, Array.from(tcp(peer4, ECHO_LEASE.address, 0x12, SYN_OPTIONS))));
  t = out.at(-1)!.subarray(14 + 20);
  assert.equal(mssOf(t), 1240);
  assert.equal(tcpSum(peer4, ECHO_LEASE.address, t), 0);
  // IPv6: 1220.
  g.send(toGateway(ip6(L6, peer6, 6, tcp(L6, peer6, 0x02, SYN_OPTIONS))));
  t = sent.at(-1)!.subarray(40);
  assert.equal(mssOf(t), 1220);
  assert.equal(tcpSum(L6, peer6, t), 0);
  // Left alone: an MSS already under it, and segments that aren't SYNs.
  const small = [2, 4, 0x04, 0xb0]; // 1200
  g.send(frame(GATEWAY_MAC, GUEST_MAC, 0x0800, ipv4(ECHO_LEASE.address, peer4, 6, Array.from(tcp(ECHO_LEASE.address, peer4, 0x02, small)))));
  assert.equal(mssOf(sent.at(-1)!.subarray(20)), 1200);
  const ack = ipv4(ECHO_LEASE.address, peer4, 6, Array.from(tcp(ECHO_LEASE.address, peer4, 0x10, SYN_OPTIONS)));
  g.send(frame(GATEWAY_MAC, GUEST_MAC, 0x0800, ack));
  assert.equal(hex(sent.at(-1)!), hex(ack));
});
