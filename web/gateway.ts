// The Ethernet gateway (docs/plans/networking.md §3): between virtio-net's
// frames and a layer-3 backend's IP packets (Tailscale, or the synchronous
// test backend). For the guest it is a LAN with one router:
//   - proxy ARP: every ARP request for an address other than the guest's own
//     is answered with the gateway's MAC, so any destination is "on-link";
//   - a DHCP server that hands out the backend's address (the lease follows
//     the backend: none, no offer), the router (the gateway), DNS, the MTU and
//     classless routes; and no address range is assumed;
//   - framing: Ethernet headers off on the way out, on on the way in.
// IPv6 (N6): router advertisements (a default route via the gateway, no prefix),
// DHCPv6 for the node's address, neighbor discovery for the gateway itself, ICMPv6
// echo. It runs in the device worker, so a synchronous backend keeps deterministic
// mode exact (the timer behind periodic advertisements exists only when asked for).
import { eq } from './bytes.ts';
import { batchSender, checksum, IP_HEADROOM, packetsOf, type NetAdapter } from './net.ts';
import {
  ALL_DHCP_AGENTS,
  ALL_NODES,
  domainList,
  icmp6,
  linkLocal,
  multicastMac,
  neighborAdvert,
  routerAdvert,
  sum6,
  udp6,
  type RoutePref,
} from './ip6.ts';

/**
 * What a backend gives the guest. `address` is the guest's own IPv4 address on the network;
 * `address6` (16 bytes) its IPv6 one, if the network has one, with the IPv6 resolvers in `dns6`.
 */
export type Lease = {
  address: number[];
  address6?: number[];
  mtu: number;
  dns: number[][];
  dns6?: number[][];
  domains: string[];
  routes?: Routes;
  peers6?: Prefix[];
};

/** A prefix: its address (4 or 16 bytes) and length. */
export type Prefix = [number[], number];
/**
 * The networks behind a gateway that isn't the guest's way to everything else (docs/networking/adapters.md §4): the
 * lease's `routes`, per family. Without a family's the gateway is that family's default router; with them, it is the
 * router for these prefixes only (IPv4: option 121's routes and no option 3; IPv6: a router advertisement with
 * lifetime 0 and a Route Information option per prefix), so another adapter's gateway can be the default, or none
 * (an adapter whose IPv6 doesn't reach the internet, web/reach6.ts). `pref6`: the IPv6 routes' preference (`ranked`).
 * A lease's `peers6` are addresses reached through this gateway whatever else it is: a Route Information option each, on
 * a default router too, so they win by length over another adapter's wider prefix (tailcat's clients, in a tailnet's /48).
 */
export type Routes = { v4?: Prefix[]; v6?: Prefix[]; pref6?: RoutePref };

/** A tailnet's own addresses (Tailscale's CGNAT range, MagicDNS's 100.100.100.100 in it, and its ULA /48). */
export const TAILNET_ROUTES: Required<Pick<Routes, 'v4' | 'v6'>> = {
  v4: [[[100, 64, 0, 0], 10]],
  v6: [[[0xfd, 0x7a, 0x11, 0x5c, 0xa1, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], 48]],
};
/** tailcat has no prefix of its own: its tunnel addresses are in a tailnet's /48, so its clients are each a route (`peers6`). */
export const TAILCAT_ROUTES: Required<Pick<Routes, 'v4' | 'v6'>> = { v4: [], v6: [] };
/** Route Information options in one advertisement (24 bytes each for a /128): more go in the next, under the MTU. */
const ROUTES_PER_ADVERT = 40;

/**
 * `lease` with its IPv6 routes at the preference of the adapter's `rank` among the machine's connected adapters
 * (web/app/network.ts `ranksOf`): high for the first, medium for the second, low for the rest. Two adapters can offer
 * the same prefix (a tailnet's and tailcat's /48); the guest's kernel takes the more preferred of equal routes, so the
 * earlier adapter's wins.
 */
export const ranked = (lease: Lease | null, rank: number): Lease | null =>
  lease?.routes?.v6?.length
    ? { ...lease, routes: { ...lease.routes, pref6: (['high', 'medium', 'low'] as const)[Math.min(rank, 2)] } }
    : lease;

/**
 * `lease` for the adapter that is the guest's default way out (`primary`), or only for `routes`, per family: `primary6`
 * (default `primary`) for IPv6, whose default can come from another adapter than IPv4's (docs/networking/adapters.md §4,
 * "A primary per family"); null stays null.
 */
export const routedLease = (lease: Lease | null, primary: boolean, routes: Routes, primary6 = primary): Lease | null =>
  !lease
    ? null
    : primary && primary6
      ? { ...lease, routes: undefined }
      : { ...lease, routes: { ...routes, v4: primary ? undefined : routes.v4, v6: primary6 ? undefined : routes.v6 } };

/** A layer-3 backend: IP packets out through `send`, in through the `deliver` it was made with. */
export type IpBackend = { lease(): Lease | null; send(packet: Uint8Array): void; close?(): void };

/**
 * The other way an IP port's card can go (web/devices.ts): `{type: 'frames', port}` on the port (the local helper's
 * client) puts the card's frames on `port`, the gateway bypassed (`port` null: dropped until one comes), and
 * `{type: 'gateway'}` brings the gateway back. Each switch flaps the link under a driver.
 */
export type FramePath = { frames(port: MessagePort | null): void; gateway(): void };

/** What `gateway` gives a backend's maker: where the guest's packets come from, and to tell the gateway its lease changed. */
/**
 * A packet for the guest. `headroom`: the `IP_HEADROOM` bytes before it in its buffer are the gateway's, which writes
 * the Ethernet header there and hands the guest that buffer; without it the gateway copies the packet into a frame.
 */
export type Deliver = (packet: Uint8Array, headroom?: boolean) => void;

export type GatewayOptions = {
  /** The gateway's MAC and IP (the guest's router). The IP must not be one a peer can have. */
  mac?: number[];
  ip?: number[];
  /**
   * The mask the lease carries: a /32, with option 121 giving the gateway on-link and the default route through it.
   * Not 0.0.0.0 (everything on-link): current systemd-networkd takes a zero mask for no mask at all
   * (`DHCP error: no netmask`) and drops the lease. Arch Linux ARM found it; Debian 13's older systemd didn't mind.
   */
  netmask?: number[];
  leaseSeconds?: number;
  /** When the guest renews its IPv4 lease (DHCP's T1; default half the lease). */
  renewSeconds?: number;
  /** Send unsolicited router advertisements this often (milliseconds; realtime only: a timer). 0: only when asked, and when the lease changes. */
  advertiseMs?: number;
  /** The backend's lease moved to another address than the guest was given: the device flaps the link (web/devices.ts). */
  stale?: () => void;
};

export const GATEWAY_MAC = [0x02, 0x77, 0x65, 0x62, 0x70, 0x63];
export const GATEWAY_IP = [169, 254, 0, 1];
/** The gateway's IPv6 link-local address: the guest's default router. */
export const GATEWAY_IP6 = linkLocal(GATEWAY_MAC);

/**
 * The gateway of a machine's adapter `n` (docs/networking/adapters.md §4): its own MAC and IPv4 address, so the
 * guest tells its adapters' routers apart (the IPv6 one is the MAC's link-local). Adapter 0's are `GATEWAY_MAC` and
 * `GATEWAY_IP`, as the one card's were.
 */
export const gatewayOf = (n: number): { mac: number[]; ip: number[] } => ({
  mac: [...GATEWAY_MAC.slice(0, 5), GATEWAY_MAC[5] + n],
  ip: [169, 254, 0, 1 + n],
});

const BCAST = [0xff, 0xff, 0xff, 0xff, 0xff, 0xff];
const isZero = (a: Uint8Array, at: number, n: number) => a.subarray(at, at + n).every((v) => v === 0);
const be16 = (b: Uint8Array, at: number) => (b[at] << 8) | b[at + 1];

function eth(dst: ArrayLike<number>, src: ArrayLike<number>, type: number, payload: Uint8Array) {
  const f = new Uint8Array(14 + payload.length);
  f.set(dst, 0);
  f.set(src, 6);
  f[12] = type >> 8;
  f[13] = type & 0xff;
  f.set(payload, 14);
  return f;
}

let ipId = 0;
/** An IPv4 header (no options) followed by `payload`, its checksum filled in. */
function ip4(src: ArrayLike<number>, dst: ArrayLike<number>, proto: number, payload: Uint8Array, df = false) {
  const p = new Uint8Array(20 + payload.length);
  p[0] = 0x45;
  p[2] = p.length >> 8;
  p[3] = p.length & 0xff;
  ipId = (ipId + 1) & 0xffff;
  p[4] = ipId >> 8;
  p[5] = ipId & 0xff;
  if (df) p[6] = 0x40;
  p[8] = 64;
  p[9] = proto;
  p.set(src, 12);
  p.set(dst, 16);
  const c = checksum(p.subarray(0, 20));
  p[10] = c >> 8;
  p[11] = c & 0xff;
  p.set(payload, 20);
  return p;
}

function udp(src: ArrayLike<number>, dst: ArrayLike<number>, sport: number, dport: number, data: Uint8Array) {
  const u = new Uint8Array(8 + data.length);
  u[0] = sport >> 8;
  u[1] = sport & 0xff;
  u[2] = dport >> 8;
  u[3] = dport & 0xff;
  u[4] = u.length >> 8;
  u[5] = u.length & 0xff;
  u.set(data, 8);
  const pseudo = new Uint8Array(12 + u.length);
  pseudo.set(src, 0);
  pseudo.set(dst, 4);
  pseudo[9] = 17;
  pseudo[10] = u.length >> 8;
  pseudo[11] = u.length & 0xff;
  pseudo.set(u, 12);
  const c = checksum(pseudo) || 0xffff;
  u[6] = c >> 8;
  u[7] = c & 0xff;
  return u;
}

// DHCP message types and the options we read or write (RFC 2131, 2132, 3442).
const DISCOVER = 1,
  OFFER = 2,
  REQUEST = 3,
  ACK = 5,
  NAK = 6;

function dhcpOptions(b: Uint8Array) {
  const o = new Map<number, Uint8Array>();
  for (let k = 240; k < b.length;) {
    const code = b[k];
    if (code === 255) break;
    if (code === 0) {
      k++;
      continue;
    }
    const len = b[k + 1];
    if (k + 2 + len > b.length) break;
    o.set(code, b.subarray(k + 2, k + 2 + len));
    k += 2 + len;
  }
  return o;
}

/**
 * Lowers the MSS option of a TCP SYN in the IP packet `p` (IPv4, or IPv6 without extension headers) to what fits `mtu`,
 * in place, with the TCP checksum patched (RFC 1624). A guest whose link MTU is 1500 (one that ignores DHCP's MTU, as
 * networkd does without UseMTU) would otherwise ask servers for 1460-byte segments, and those don't fit a 1280-byte
 * tunnel: where the server ignores the exit node's "fragmentation needed", its large packets are lost for good (TLS
 * handshakes that hang on some hosts, found 2026-10-17). Both directions: the guest's SYN and the SYN-ACK to it.
 */
export function clampMss(p: Uint8Array, mtu: number) {
  const v6 = p[0] >> 4 === 6;
  const at = v6 ? 40 : (p[0] & 0xf) * 4;
  if ((v6 ? p[6] : p[9]) !== 6 || (!v6 && (be16(p, 6) & 0x1fff) !== 0) || p.length < at + 20) return; // TCP, not a later fragment
  if ((p[at + 13] & 0x02) === 0) return; // SYN
  const mss = mtu - at - 20;
  const end = Math.min(p.length, at + (p[at + 12] >> 4) * 4);
  for (let o = at + 20; o < end;) {
    const kind = p[o];
    if (kind === 0) return;
    if (kind === 1) {
      o++;
      continue;
    }
    const len = p[o + 1];
    if (len < 2 || o + len > end) return;
    if (kind === 2 && len === 4) {
      const old = be16(p, o + 2);
      if (old <= mss) return;
      p[o + 2] = mss >> 8;
      p[o + 3] = mss & 255;
      let sum = (~be16(p, at + 16) & 0xffff) + (~old & 0xffff) + mss;
      while (sum > 0xffff) sum = (sum & 0xffff) + (sum >>> 16);
      const c = ~sum & 0xffff;
      p[at + 16] = c >> 8;
      p[at + 17] = c & 255;
      return;
    }
    o += len;
  }
}

/**
 * The gateway as a virtio-net adapter. `makeBackend` gets the function that
 * hands the backend's packets for the guest to the gateway.
 */
export function gateway(
  receive: (frame: Uint8Array) => void,
  makeBackend: (deliver: Deliver, leaseChanged: () => void) => IpBackend,
  opts: GatewayOptions = {},
): NetAdapter {
  const mac = opts.mac ?? GATEWAY_MAC;
  const gw = opts.ip ?? GATEWAY_IP;
  const mask = opts.netmask ?? [255, 255, 255, 255];
  const leaseSeconds = opts.leaseSeconds ?? 3600;
  const renewSeconds = opts.renewSeconds ?? leaseSeconds >> 1;
  const gw6 = linkLocal(mac);
  let guestMac: Uint8Array | null = null;
  let advertised = false;
  let defaultRouter = false;
  let again: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  /** The IPv4 address the guest was last given (acknowledged). */
  let given: number[] | undefined;

  let leaseNow = (): Lease | null | undefined => undefined; // the backend's, once it exists
  const backend = makeBackend(
    (packet, headroom) => {
      // The guest hasn't shown a MAC before its first frame (its DHCP request).
      if (!guestMac || packet.length > 1500) return;
      const v = packet[0] >> 4;
      const type = v === 4 && packet.length >= 20 ? 0x0800 : v === 6 && packet.length >= 40 ? 0x86dd : 0;
      if (!type) return;
      const lease = leaseNow();
      if (lease) clampMss(packet, lease.mtu);
      if (!headroom || packet.byteOffset < IP_HEADROOM) return receive(eth(guestMac, mac, type, packet));
      // The header goes in the room before the packet (per packet: no frame allocated, nothing copied).
      const f = new Uint8Array(packet.buffer, packet.byteOffset - IP_HEADROOM, IP_HEADROOM + packet.length);
      f.set(guestMac, 0);
      f.set(mac, 6);
      f[12] = type >> 8;
      f[13] = type & 0xff;
      receive(f);
    },
    () => {
      // A lease for another address than the one the guest holds (another connection on the adapter): the guest would keep
      // it until its renewal, so the link flaps and it asks now. The same address again (a reconnect) doesn't.
      const lease = backend.lease();
      if (given && lease && !eq(lease.address, 0, given)) {
        given = undefined;
        opts.stale?.();
      }
      advertise();
    },
  );
  leaseNow = () => backend.lease();

  /** A router advertisement to all nodes: the gateway is the default router while the lease has an IPv6 address, and isn't once it hasn't. */
  function advertise() {
    if (closed) return;
    const lease = backend.lease();
    const on = !!lease?.address6;
    if (!on && !advertised) return;
    advertised = on;
    const dns = lease?.dns6 ?? [];
    const routes = on ? [...(lease.routes?.v6 ?? []), ...(lease.peers6 ?? [])] : [];
    const lifetime = on && !lease.routes?.v6 ? 1800 : 0;
    for (let at = 0; at === 0 || at < routes.length; at += ROUTES_PER_ADVERT) {
      receive(
        eth(
          multicastMac(ALL_NODES),
          mac,
          0x86dd,
          routerAdvert(gw6, {
            mac,
            lifetime,
            mtu: lease?.mtu ?? 1280,
            dns: on ? dns : [],
            dnsLifetime: 1800,
            routes: routes.slice(at, at + ROUTES_PER_ADVERT),
            pref: lease?.routes?.pref6,
          }),
        ),
      );
    }
    // No longer the default router but still one for `routes`: systemd-networkd drops the default route's nexthop,
    // which the routes this advertisement gave share, so they went too (back ~11 s later). Once more, a second on.
    if (defaultRouter && !lifetime && routes.length && opts.advertiseMs) {
      clearTimeout(again);
      again = setTimeout(advertise, 1000);
    }
    defaultRouter = lifetime > 0;
  }
  const timer = opts.advertiseMs ? setInterval(advertise, opts.advertiseMs) : undefined;

  function dhcp(f: Uint8Array, at: number, len: number) {
    const b = f.subarray(at, at + len);
    if (b.length < 241 || b[0] !== 1 || b[1] !== 1 || b[2] !== 6 || !eq(b, 236, [0x63, 0x82, 0x53, 0x63])) return;
    const o = dhcpOptions(b);
    const type = o.get(53)?.[0];
    const lease = backend.lease();
    let reply: number | null = null;
    if (type === DISCOVER) {
      if (lease) reply = OFFER;
    } else if (type === REQUEST) {
      const sid = o.get(54);
      if (sid && !eq(sid, 0, gw)) return; // the client chose another server
      const want = o.get(50) ?? (isZero(b, 12, 4) ? undefined : b.subarray(12, 16));
      reply = lease && want && eq(want, 0, lease.address) ? ACK : NAK;
    }
    if (reply === null) return;
    const opt: number[] = [53, 1, reply, 54, 4, ...gw];
    if (reply !== NAK && lease) {
      const u32 = (n: number) => [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
      opt.push(51, 4, ...u32(leaseSeconds), 58, 4, ...u32(renewSeconds), 59, 4, ...u32((leaseSeconds * 7) >> 3));
      opt.push(1, 4, ...mask, ...(lease.routes?.v4 ? [] : [3, 4, ...gw]));
      if (lease.dns.length) opt.push(6, lease.dns.length * 4, ...lease.dns.flat());
      const domain = lease.domains[0]?.replace(/\.$/, '');
      if (domain) opt.push(15, domain.length, ...new TextEncoder().encode(domain));
      opt.push(26, 2, lease.mtu >> 8, lease.mtu & 255);
      opt.push(
        28,
        4,
        ...(mask.every((v) => v === 255) ? [255, 255, 255, 255] : lease.address.map((v, k) => v | (~mask[k] & 255))),
      ); // a /32 has no subnet broadcast
      // Classless routes: the gateway on-link, everything else through it (a client that
      // understands option 121 ignores option 3), or only the lease's routes (no default: another adapter's).
      const routes = (lease.routes?.v4 ?? [[[0, 0, 0, 0], 0]]).flatMap(([a, len]) => [
        len,
        ...a.slice(0, Math.ceil(len / 8)),
        ...gw,
      ]);
      opt.push(121, 9 + routes.length, 32, ...gw, 0, 0, 0, 0, ...routes);
    }
    opt.push(255);
    const m = new Uint8Array(240 + opt.length);
    m[0] = 2;
    m[1] = 1;
    m[2] = 6;
    m.set(b.subarray(4, 8), 4); // xid
    m.set(b.subarray(10, 12), 10); // flags
    m.set(b.subarray(12, 16), 12); // ciaddr
    if (reply !== NAK && lease) m.set(lease.address, 16); // yiaddr
    if (reply === ACK && lease) given = [...lease.address];
    if (reply !== NAK) m.set(gw, 20); // siaddr
    m.set(b.subarray(24, 44), 24); // giaddr, chaddr
    m.set([0x63, 0x82, 0x53, 0x63], 236);
    m.set(opt, 240);
    // A renewing client (ciaddr set) is answered unicast, everyone else by broadcast.
    const renew = !isZero(b, 12, 4) && reply === ACK;
    const dstIp = renew ? b.subarray(12, 16) : [255, 255, 255, 255];
    const packet = ip4(gw, dstIp, 17, udp(gw, dstIp, 67, 68, m));
    receive(eth(renew ? f.subarray(6, 12) : BCAST, mac, 0x0800, packet));
  }

  /** ICMP type 3 code 4 to `f`'s sender: the packet was over the MTU and had DF set. */
  function tooBig(ipPacket: Uint8Array, mtu: number) {
    const ihl = (ipPacket[0] & 0xf) * 4;
    const quoted = ipPacket.subarray(0, ihl + 8);
    const icmp = new Uint8Array(8 + quoted.length);
    icmp[0] = 3;
    icmp[1] = 4;
    icmp[6] = mtu >> 8;
    icmp[7] = mtu & 255;
    icmp.set(quoted, 8);
    const c = checksum(icmp);
    icmp[2] = c >> 8;
    icmp[3] = c & 255;
    receive(eth(guestMac!, mac, 0x0800, ip4(gw, ipPacket.subarray(12, 16), 1, icmp)));
  }

  function echoToGateway(ipPacket: Uint8Array) {
    const ihl = (ipPacket[0] & 0xf) * 4;
    if (ipPacket[9] !== 1 || ipPacket[ihl] !== 8) return;
    const icmp = ipPacket.slice(ihl);
    icmp[0] = 0;
    icmp[2] = icmp[3] = 0;
    const c = checksum(icmp);
    icmp[2] = c >> 8;
    icmp[3] = c & 255;
    receive(eth(guestMac!, mac, 0x0800, ip4(gw, ipPacket.subarray(12, 16), 1, icmp)));
  }

  // DHCPv6 (RFC 8415): stateful, one IA_NA with the lease's address as a /128, the resolvers and the search domain.
  const duid = [0, 3, 0, 1, ...mac];
  function dhcp6(f: Uint8Array, srcIp: Uint8Array, data: Uint8Array) {
    if (data.length < 4) return;
    const type = data[0];
    const opts = new Map<number, Uint8Array>();
    for (let k = 4; k + 4 <= data.length;) {
      const len = be16(data, k + 2);
      if (k + 4 + len > data.length) return;
      if (!opts.has(be16(data, k))) opts.set(be16(data, k), data.subarray(k + 4, k + 4 + len));
      k += 4 + len;
    }
    const sid = opts.get(2);
    if (sid && !eq(sid, 0, duid)) return; // another server's
    const cid = opts.get(1);
    const lease = backend.lease();
    if (!cid || !lease?.address6) return; // no client, or no lease: no answer
    const a6 = lease.address6;
    const u16 = (n: number) => [n >> 8, n & 255];
    const u32 = (n: number) => [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
    const opt = (code: number, body: ArrayLike<number>) => [...u16(code), ...u16(body.length), ...Array.from(body)];
    const status = (code: number) => opt(13, u16(code));
    const ia = opts.get(3);
    // The addresses an IA_NA names (IA_ADDR options after its 12 bytes).
    const named: Uint8Array[] = [];
    for (let k = 12; ia && k + 4 <= ia.length; k += 4 + be16(ia, k + 2))
      if (be16(ia, k) === 5 && be16(ia, k + 2) >= 24) named.push(ia.subarray(k + 4, k + 20));
    const mine = named.some((x) => eq(x, 0, a6));
    const out = [...opt(1, cid), ...opt(2, duid)];
    const t = leaseSeconds;
    const binding = () =>
      opt(3, [
        ...ia!.subarray(0, 4),
        ...u32(t >> 1),
        ...u32(((t * 4) / 5) | 0),
        ...opt(5, [...a6, ...u32(t), ...u32(t)]),
      ]);
    let reply = 7; // REPLY
    if (type === 1) {
      // SOLICIT: ADVERTISE
      if (!ia || ia.length < 12) return;
      reply = 2;
      out.push(...binding());
    } else if (type === 3) {
      // REQUEST
      if (!sid || !ia || ia.length < 12) return;
      out.push(...binding());
    } else if (type === 5 || type === 6) {
      // RENEW, REBIND: the lease's address is renewed, any other has no binding
      if (!ia || ia.length < 12 || (type === 5 && !sid)) return;
      out.push(...(mine ? binding() : opt(3, [...ia.subarray(0, 4), ...u32(0), ...u32(0), ...status(3)])));
    } else if (type === 4) {
      // CONFIRM: is the address still right for this link
      out.push(...status(mine ? 0 : 4));
    } else if (type !== 11) return; // INFORMATION-REQUEST: only the options below
    if (type !== 4) {
      if (lease.dns6?.length) out.push(...opt(23, lease.dns6.flat()));
      if (lease.domains.length) out.push(...opt(24, domainList(lease.domains)));
    }
    const m = Uint8Array.from([reply, ...data.subarray(1, 4), ...out]);
    receive(eth(f.subarray(6, 12), mac, 0x86dd, udp6(gw6, srcIp, 547, 546, m)));
  }

  /** The guest's IPv6 frames: neighbor discovery and DHCPv6 are the gateway's; the rest goes to the backend. */
  function send6(f: Uint8Array) {
    if (f.length < 54 || f[14] >> 4 !== 6) return;
    const payload = be16(f, 18);
    if (40 + payload > f.length - 14) return;
    const p = f.subarray(14, 14 + 40 + payload);
    const next = p[6];
    const src = p.subarray(8, 24);
    const dst = p.subarray(24, 40);
    if (dst[0] === 0xff || eq(dst, 0, gw6)) {
      // multicast and the gateway's own address: neighbor discovery, DHCPv6, echo; nothing else leaves the LAN
      const body = p.subarray(40);
      if (next === 58 && body.length >= 8 && sum6(src, dst, 58, body) === 0) {
        if (body[0] === 133)
          advertise(); // router solicitation
        else if (body[0] === 135 && body.length >= 24 && eq(body, 8, gw6) && !isZero(p, 8, 16) && p[7] === 255)
          receive(eth(f.subarray(6, 12), mac, 0x86dd, neighborAdvert(gw6, src, mac)));
        else if (body[0] === 128 && eq(dst, 0, gw6))
          receive(eth(guestMac!, mac, 0x86dd, icmp6(gw6, src, 129, 0, body.subarray(4, 8), body.subarray(8))));
      } else if (
        next === 17 &&
        body.length >= 8 &&
        be16(body, 2) === 547 &&
        (eq(dst, 0, gw6) || eq(dst, 0, ALL_DHCP_AGENTS))
      ) {
        dhcp6(f, src, body.subarray(8, Math.min(body.length, be16(body, 4))));
      }
      return;
    }
    const lease = backend.lease();
    if (!lease?.address6 || !eq(src, 0, lease.address6)) return; // no address yet, or not ours: dropped
    if (p.length > lease.mtu) {
      // Packet Too Big (RFC 4443 §3.2): IPv6 isn't fragmented on the way, the guest lowers its path MTU
      const quoted = p.subarray(0, Math.min(p.length, 1280 - 48));
      receive(
        eth(
          guestMac!,
          mac,
          0x86dd,
          icmp6(
            gw6,
            src,
            2,
            0,
            [lease.mtu >>> 24, (lease.mtu >>> 16) & 255, (lease.mtu >>> 8) & 255, lease.mtu & 255],
            quoted,
          ),
        ),
      );
      return;
    }
    const out = p.slice();
    clampMss(out, lease.mtu);
    backend.send(out);
  }

  return {
    send(f) {
      if (f.length < 14) return;
      if ((f[6] & 1) === 0 && !(guestMac && eq(f, 6, guestMac))) guestMac = f.slice(6, 12);
      const type = be16(f, 12);
      if (type === 0x86dd) return send6(f);
      if (type === 0x0806) {
        // ARP request (not a probe from 0.0.0.0) for anything but the guest's own address.
        if (
          f.length < 42 ||
          be16(f, 14) !== 1 ||
          be16(f, 16) !== 0x0800 ||
          f[18] !== 6 ||
          f[19] !== 4 ||
          be16(f, 20) !== 1
        )
          return;
        if (isZero(f, 28, 4)) return;
        const lease = backend.lease();
        if (lease && eq(f, 38, lease.address)) return;
        const r = new Uint8Array(28);
        r.set([0, 1, 8, 0, 6, 4, 0, 2], 0);
        r.set(mac, 8);
        r.set(f.subarray(38, 42), 14); // the address asked about
        r.set(f.subarray(22, 28), 18); // the asker's MAC and IP
        r.set(f.subarray(28, 32), 24);
        receive(eth(f.subarray(6, 12), mac, 0x0806, r));
        return;
      }
      if (type !== 0x0800 || f.length < 34 || f[14] >> 4 !== 4) return;
      const ihl = (f[14] & 0xf) * 4;
      const total = be16(f, 16);
      if (ihl < 20 || total < ihl || 14 + total > f.length) return;
      const ipPacket = f.subarray(14, 14 + total);
      if (ipPacket[9] === 17 && total >= ihl + 8 && be16(ipPacket, ihl + 2) === 67) {
        dhcp(f, 14 + ihl + 8, total - ihl - 8);
        return;
      }
      const dst = ipPacket.subarray(16, 20);
      if (eq(dst, 0, gw)) return echoToGateway(ipPacket);
      if (dst[0] >= 224) return; // multicast and broadcast don't leave the LAN
      const lease = backend.lease();
      if (!lease || !eq(ipPacket, 12, lease.address)) return; // no address yet, or not ours: dropped
      if (total > lease.mtu) {
        if (ipPacket[6] & 0x40) tooBig(ipPacket, lease.mtu);
        return;
      }
      const out = ipPacket.slice();
      clampMss(out, lease.mtu);
      backend.send(out);
    },
    close: () => {
      closed = true;
      if (timer) clearInterval(timer);
      clearTimeout(again);
      backend.close?.();
    },
  };
}

/** The test lease of `echoBackend`: an address from the benchmarking range, on purpose not a tailnet's. */
export const ECHO_LEASE: Lease = {
  address: [198, 18, 0, 15],
  address6: [0xfd, 0, 0x5e, 0xb0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x0f],
  mtu: 1280,
  dns: [[198, 18, 0, 53]],
  dns6: [[0xfd, 0, 0x5e, 0xb0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x53]],
  domains: ['test.waarm64'],
};

/** `echoBackend`'s lease for adapter `n`: `ECHO_LEASE` with the guest's addresses moved up by `n`, so a machine's adapters have their own. */
export function echoLease(n: number): Lease {
  if (!n) return ECHO_LEASE;
  const address6 = [...ECHO_LEASE.address6!];
  address6[15] += n;
  return { ...ECHO_LEASE, address: [198, 18, 0, 15 + n], address6 };
}

/** A synchronous test backend: answers ICMP and ICMPv6 echo requests to any address, and drops everything else. */
export function echoBackend(lease: Lease = ECHO_LEASE) {
  return (deliver: Deliver): IpBackend => ({
    lease: () => lease,
    send(p) {
      if (p[0] >> 4 === 6) {
        if (p[6] !== 58 || p.length < 48 || p[40] !== 128) return;
        const r = p.slice();
        r.set(p.subarray(24, 40), 8);
        r.set(p.subarray(8, 24), 24);
        r[40] = 129;
        r[42] = r[43] = 0;
        const c = sum6(r.subarray(8, 24), r.subarray(24, 40), 58, r.subarray(40));
        r[42] = c >> 8;
        r[43] = c & 255;
        deliver(r);
        return;
      }
      const ihl = (p[0] & 0xf) * 4;
      if (p[9] !== 1 || p.length < ihl + 8 || p[ihl] !== 8) return;
      const r = p.slice();
      r.set(p.subarray(16, 20), 12); // the addresses swap; the IP checksum doesn't change
      r.set(p.subarray(12, 16), 16);
      r[ihl] = 0;
      r[ihl + 2] = r[ihl + 3] = 0;
      const c = checksum(r.subarray(ihl));
      r[ihl + 2] = c >> 8;
      r[ihl + 3] = c & 255;
      deliver(r);
    },
  });
}

/**
 * A backend on the other end of a MessagePort (the Tailscale worker): an
 * ArrayBuffer is one IP packet in either direction, an array of them a batch
 * (web/net.ts `batchSender`), `{type: 'lease', lease}` (or `lease: null`) from
 * the backend sets the lease. The backend's buffers have `IP_HEADROOM` bytes
 * before their packet, where the Ethernet header is written.
 */
export function portBackend(port: MessagePort, path?: FramePath) {
  return (deliver: Deliver, leaseChanged: () => void): IpBackend => {
    let lease: Lease | null = null;
    const send = batchSender(port);
    port.onmessage = (e: MessageEvent) => {
      const packets = packetsOf(e.data, IP_HEADROOM);
      if (packets) for (const p of packets) deliver(p, true);
      else if (e.data?.type === 'lease') {
        lease = e.data.lease;
        leaseChanged();
      } else if (e.data?.type === 'frames') path?.frames(e.data.port ?? null);
      else if (e.data?.type === 'gateway') {
        lease = null; // the helper's frames went: whoever comes next leases afresh
        path?.gateway();
      }
    };
    return {
      lease: () => lease,
      send,
      close: () => port.close(),
    };
  };
}
