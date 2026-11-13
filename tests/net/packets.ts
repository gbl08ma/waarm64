// IP packets for the tailnet client's tests in Node: what a guest's stack would send (UDP, a TCP
// SYN, ICMP echo, DNS queries), and the parts of what comes back the tests look at.
import { checksum } from '../../web/net.ts';

export const v4 = (s: string) => s.split('.').map(Number);
export function v6(a: string) {
  const [l, r = ''] = a.split('::');
  const g = (s: string) => (s ? s.split(':').map((x) => parseInt(x, 16)) : []);
  const words = a.includes('::') ? [...g(l), ...Array(8 - g(l).length - g(r).length).fill(0), ...g(r)] : g(l);
  return words.flatMap((w) => [w >> 8, w & 255]);
}
const addr = (s: string) => (s.includes(':') ? v6(s) : v4(s));

/** A transport segment `seg` (checksum at `at`) from `src` to `dst` in an IP packet of the right family. */
function ip(src: string, dst: string, proto: number, seg: number[], at: number) {
  const [s, d] = [addr(src), addr(dst)];
  const len = seg.length;
  const pseudo = s.length === 4 ? [...s, ...d, 0, proto, len >> 8, len & 255] : [...s, ...d, 0, 0, len >> 8, len & 255, 0, 0, 0, proto];
  const icmp4 = proto === 1;
  const c = checksum(new Uint8Array(icmp4 ? seg : [...pseudo, ...seg]));
  seg[at] = c >> 8; seg[at + 1] = c & 255;
  if (s.length === 16) return new Uint8Array([0x60, 0, 0, 0, len >> 8, len & 255, proto, 64, ...s, ...d, ...seg]);
  const h = [0x45, 0, (20 + len) >> 8, (20 + len) & 255, 0, 0, 0x40, 0, 64, proto, 0, 0, ...s, ...d];
  const hc = checksum(new Uint8Array(h));
  h[10] = hc >> 8; h[11] = hc & 255;
  return new Uint8Array([...h, ...seg]);
}

export function udp(src: string, sport: number, dst: string, dport: number, payload: Uint8Array) {
  const len = 8 + payload.length;
  return ip(src, dst, 17, [sport >> 8, sport & 255, dport >> 8, dport & 255, len >> 8, len & 255, 0, 0, ...payload], 6);
}

export function tcpSyn(src: string, sport: number, dst: string, dport: number) {
  return ip(src, dst, 6, [sport >> 8, sport & 255, dport >> 8, dport & 255, 0, 0, 0, 1, 0, 0, 0, 0, 0x50, 0x02, 0xff, 0xff, 0, 0, 0, 0], 16);
}

export function ping(src: string, dst: string, id: number, seq: number) {
  const six = src.includes(':');
  return ip(src, dst, six ? 58 : 1, [six ? 128 : 8, 0, 0, 0, id >> 8, id & 255, seq >> 8, seq & 255, ...new TextEncoder().encode('waarm64 ping')], 2);
}

export function dnsQuery(id: number, name: string, type: number) {
  const q = [id >> 8, id & 255, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0];
  for (const l of name.split('.')) q.push(l.length, ...new TextEncoder().encode(l));
  q.push(0, type >> 8, type & 255, 0, 1);
  return new Uint8Array(q);
}

/** What the tests read of a packet. */
export function parse(p: Uint8Array) {
  const six = p[0] >> 4 === 6;
  const l4 = six ? 40 : (p[0] & 15) * 4;
  const proto = six ? p[6] : p[9];
  const fmt = (b: Uint8Array) => (six ? Array.from({ length: 8 }, (_, i) => ((b[2 * i] << 8) | b[2 * i + 1]).toString(16)).join(':').replace(/(^|:)0(:0)+(:|$)/, '::') : Array.from(b).join('.'));
  const src = fmt(p.subarray(six ? 8 : 12, six ? 24 : 16));
  const dst = fmt(p.subarray(six ? 24 : 16, six ? 40 : 20));
  const t = p.subarray(l4);
  return { proto, src, dst, sport: (t[0] << 8) | t[1], dport: (t[2] << 8) | t[3], flags: proto === 6 ? t[13] : 0, icmpType: proto === 1 || proto === 58 ? t[0] : -1, payload: proto === 17 ? t.subarray(8) : t };
}

/** The IPv4 addresses in the answer section of a DNS response. */
export function dnsAnswers4(m: Uint8Array) {
  let at = 12;
  while (m[at]) at += m[at] + 1;
  at += 5;
  const out: string[] = [];
  for (let n = (m[6] << 8) | m[7]; n > 0; n--) {
    at += (m[at] & 0xc0) === 0xc0 ? 2 : 0;
    const type = (m[at] << 8) | m[at + 1];
    const len = (m[at + 8] << 8) | m[at + 9];
    if (type === 1) out.push(Array.from(m.subarray(at + 10, at + 14)).join('.'));
    at += 10 + len;
  }
  return { rcode: m[3] & 15, addrs: out };
}
