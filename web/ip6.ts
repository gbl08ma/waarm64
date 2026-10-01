// IPv6 packet building for the Ethernet gateway (web/gateway.ts, docs/plans/networking.md §3):
// headers, ICMPv6 and UDP with their pseudo-header checksums, and the neighbor discovery and
// DHCPv6 messages the gateway sends.
import { checksum } from './net.ts';

/** The gateway's link-local address, from its MAC (modified EUI-64): the router the guest's RAs name. */
export const linkLocal = (mac: ArrayLike<number>) => [0xfe, 0x80, 0, 0, 0, 0, 0, 0, mac[0] ^ 2, mac[1], mac[2], 0xff, 0xfe, mac[3], mac[4], mac[5]];

export const ALL_NODES = [0xff, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1];
export const ALL_ROUTERS = [0xff, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2];
export const ALL_DHCP_AGENTS = [0xff, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 2];
/** The Ethernet address of an IPv6 multicast address. */
export const multicastMac = (a: ArrayLike<number>) => [0x33, 0x33, a[12], a[13], a[14], a[15]];

/** An IPv6 header followed by `payload`. */
export function ip6(src: ArrayLike<number>, dst: ArrayLike<number>, next: number, payload: Uint8Array, hop = 64) {
  const p = new Uint8Array(40 + payload.length);
  p[0] = 0x60;
  p[4] = payload.length >> 8;
  p[5] = payload.length & 0xff;
  p[6] = next;
  p[7] = hop;
  p.set(src, 8);
  p.set(dst, 24);
  p.set(payload, 40);
  return p;
}

/** The checksum of an upper-layer message with its pseudo-header (RFC 8200 §8.1); 0 over a valid one. */
export function sum6(src: ArrayLike<number>, dst: ArrayLike<number>, next: number, msg: Uint8Array) {
  const pseudo = new Uint8Array(40 + msg.length);
  pseudo.set(src, 0);
  pseudo.set(dst, 16);
  pseudo[34] = msg.length >> 8;
  pseudo[35] = msg.length & 0xff;
  pseudo[39] = next;
  pseudo.set(msg, 40);
  return checksum(pseudo);
}

/** An ICMPv6 message (type, code, 4 bytes after the checksum, then `body`) in an IPv6 packet. */
export function icmp6(src: ArrayLike<number>, dst: ArrayLike<number>, type: number, code: number, rest: ArrayLike<number>, body: ArrayLike<number> = [], hop = 64) {
  const m = new Uint8Array(8 + body.length);
  m[0] = type;
  m[1] = code;
  m.set(rest, 4);
  m.set(body, 8);
  const c = sum6(src, dst, 58, m);
  m[2] = c >> 8;
  m[3] = c & 0xff;
  return ip6(src, dst, 58, m, hop);
}

/** A UDP datagram in an IPv6 packet. */
export function udp6(src: ArrayLike<number>, dst: ArrayLike<number>, sport: number, dport: number, data: Uint8Array) {
  const u = new Uint8Array(8 + data.length);
  u.set([sport >> 8, sport & 0xff, dport >> 8, dport & 0xff, u.length >> 8, u.length & 0xff]);
  u.set(data, 8);
  const c = sum6(src, dst, 17, u) || 0xffff;
  u[6] = c >> 8;
  u[7] = c & 0xff;
  return ip6(src, dst, 17, u);
}

export type RouterAdvert = { mac: number[]; lifetime: number; mtu: number; dns: number[][]; dnsLifetime: number };

/**
 * A router advertisement: managed (the address comes from DHCPv6) and other-config flags, a
 * router lifetime (0 withdraws the router), the link-layer address, the MTU and the resolvers.
 * No prefix information: nothing is on-link and nothing is autoconfigured, so the guest sends
 * everything to the router and uses the address DHCPv6 gives it.
 */
export function routerAdvert(src: number[], a: RouterAdvert) {
  const rdnss = a.dns.length ? [25, 1 + 2 * a.dns.length, 0, 0, a.dnsLifetime >>> 24, (a.dnsLifetime >>> 16) & 255, (a.dnsLifetime >>> 8) & 255, a.dnsLifetime & 255, ...a.dns.flat()] : [];
  const body = [1, 1, ...a.mac, 5, 1, 0, 0, a.mtu >>> 24, (a.mtu >>> 16) & 255, (a.mtu >>> 8) & 255, a.mtu & 255, ...rdnss];
  // hop limit 64, flags M|O, router lifetime, reachable time and retransmit timer unspecified
  return icmp6(src, ALL_NODES, 134, 0, [64, 0xc0, a.lifetime >> 8, a.lifetime & 255], [0, 0, 0, 0, 0, 0, 0, 0, ...body], 255);
}

/** A neighbor advertisement for `target` (router, solicited, override), with the link-layer address. */
export const neighborAdvert = (src: number[], dst: ArrayLike<number>, mac: number[]) =>
  icmp6(src, dst, 136, 0, [0xe0, 0, 0, 0], [...src, 2, 1, ...mac], 255);

/** Domain names in DHCPv6's wire format (RFC 8415 §10): length-prefixed labels, a zero at the end of each. */
export function domainList(names: string[]) {
  const out: number[] = [];
  for (const name of names) {
    for (const label of name.replace(/\.$/, '').split('.')) out.push(label.length, ...new TextEncoder().encode(label));
    out.push(0);
  }
  return out;
}
