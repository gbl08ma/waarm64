// The Ethernet gateway (docs/plans/networking.md §3): between virtio-net's
// frames and a layer-3 backend's IP packets (Tailscale, or the synchronous
// test backend). For the guest it is a LAN with one router:
//   - proxy ARP: every ARP request for an address other than the guest's own
//     is answered with the gateway's MAC, so any destination is "on-link";
//   - a DHCP server that hands out the backend's address (the lease follows
//     the backend: none, no offer), the router (the gateway), DNS, the MTU and
//     classless routes; and no address range is assumed;
//   - framing: Ethernet headers off on the way out, on on the way in.
// IPv4 only for now (IPv6 frames are dropped). It runs in the device worker,
// so a synchronous backend keeps deterministic mode exact.
import { checksum, type NetAdapter } from './net.ts';

/** What a backend gives the guest. `address` is the guest's own IPv4 address on the network. */
export type Lease = { address: number[]; mtu: number; dns: number[][]; domains: string[] };

/** A layer-3 backend: IP packets out through `send`, in through the `deliver` it was made with. */
export type IpBackend = { lease(): Lease | null; send(packet: Uint8Array): void; close?(): void };

export type GatewayOptions = {
  /** The gateway's MAC and IP (the guest's router). The IP must not be one a peer can have. */
  mac?: number[];
  ip?: number[];
  /** The mask the lease carries. 0.0.0.0 makes every address on-link, which proxy ARP answers. */
  netmask?: number[];
  leaseSeconds?: number;
};

export const GATEWAY_MAC = [0x02, 0x77, 0x65, 0x62, 0x70, 0x63];
export const GATEWAY_IP = [169, 254, 0, 1];

const BCAST = [0xff, 0xff, 0xff, 0xff, 0xff, 0xff];
const eq = (a: ArrayLike<number>, at: number, b: ArrayLike<number>) => Array.from(b).every((v, k) => a[at + k] === v);
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
const DISCOVER = 1, OFFER = 2, REQUEST = 3, ACK = 5, NAK = 6;

function dhcpOptions(b: Uint8Array) {
  const o = new Map<number, Uint8Array>();
  for (let k = 240; k < b.length; ) {
    const code = b[k];
    if (code === 255) break;
    if (code === 0) { k++; continue; }
    const len = b[k + 1];
    if (k + 2 + len > b.length) break;
    o.set(code, b.subarray(k + 2, k + 2 + len));
    k += 2 + len;
  }
  return o;
}

/**
 * The gateway as a virtio-net adapter. `makeBackend` gets the function that
 * hands the backend's packets for the guest to the gateway.
 */
export function gateway(receive: (frame: Uint8Array) => void, makeBackend: (deliver: (packet: Uint8Array) => void) => IpBackend, opts: GatewayOptions = {}): NetAdapter {
  const mac = opts.mac ?? GATEWAY_MAC;
  const gw = opts.ip ?? GATEWAY_IP;
  const mask = opts.netmask ?? [0, 0, 0, 0];
  const leaseSeconds = opts.leaseSeconds ?? 3600;
  let guestMac: Uint8Array | null = null;

  const backend = makeBackend((packet) => {
    // IPv4 only; the guest hasn't shown a MAC before its first frame (its DHCP request).
    if (!guestMac || packet.length < 20 || packet[0] >> 4 !== 4 || packet.length > 1500) return;
    receive(eth(guestMac, mac, 0x0800, packet));
  });

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
      opt.push(51, 4, ...u32(leaseSeconds), 58, 4, ...u32(leaseSeconds >> 1), 59, 4, ...u32((leaseSeconds * 7) >> 3));
      opt.push(1, 4, ...mask, 3, 4, ...gw);
      if (lease.dns.length) opt.push(6, lease.dns.length * 4, ...lease.dns.flat());
      const domain = lease.domains[0]?.replace(/\.$/, '');
      if (domain) opt.push(15, domain.length, ...new TextEncoder().encode(domain));
      opt.push(26, 2, lease.mtu >> 8, lease.mtu & 255);
      opt.push(28, 4, ...lease.address.map((v, k) => v | (~mask[k] & 255)));
      // Classless routes: the gateway on-link, everything else through it (a client that
      // understands option 121 ignores option 3).
      opt.push(121, 14, 32, ...gw, 0, 0, 0, 0, 0, ...gw);
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

  return {
    send(f) {
      if (f.length < 14) return;
      if ((f[6] & 1) === 0) guestMac = f.slice(6, 12);
      const type = be16(f, 12);
      if (type === 0x0806) {
        // ARP request (not a probe from 0.0.0.0) for anything but the guest's own address.
        if (f.length < 42 || be16(f, 14) !== 1 || be16(f, 16) !== 0x0800 || f[18] !== 6 || f[19] !== 4 || be16(f, 20) !== 1) return;
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
      backend.send(ipPacket.slice());
    },
    close: () => backend.close?.(),
  };
}

/** The test lease of `echoBackend`: an address from the benchmarking range, on purpose not a tailnet's. */
export const ECHO_LEASE: Lease = { address: [198, 18, 0, 15], mtu: 1280, dns: [[198, 18, 0, 53]], domains: ['test.webpc'] };

/** A synchronous test backend: answers ICMP echo requests to any address, and drops everything else. */
export function echoBackend(lease: Lease = ECHO_LEASE) {
  return (deliver: (packet: Uint8Array) => void): IpBackend => ({
    lease: () => lease,
    send(p) {
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
 * ArrayBuffer is one IP packet in either direction, `{type: 'lease', lease}`
 * (or `lease: null`) from the backend sets the lease.
 */
export function portBackend(port: MessagePort) {
  return (deliver: (packet: Uint8Array) => void): IpBackend => {
    let lease: Lease | null = null;
    port.onmessage = (e: MessageEvent) => {
      if (e.data instanceof ArrayBuffer) deliver(new Uint8Array(e.data));
      else if (e.data?.type === 'lease') lease = e.data.lease;
    };
    return {
      lease: () => lease,
      send(p) {
        const b = p.buffer.byteLength === p.length ? p.buffer : p.slice().buffer;
        port.postMessage(b, [b as ArrayBuffer]);
      },
      close: () => port.close(),
    };
  };
}
