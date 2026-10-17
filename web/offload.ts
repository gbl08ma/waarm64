// virtio-net's offloads (docs/devices.md "net"): what the device does in place of the guest's network stack,
// so that work runs here, at host speed, and not as guest code in the JIT's cache. On the way out the device
// finishes partial checksums (`CSUM`) and cuts large TCP and UDP packets into segments (`HOST_TSO4`,
// `HOST_TSO6` with `HOST_ECN`, `HOST_USO`); on the way in it checks TCP and UDP checksums and marks the
// valid ones (`GUEST_CSUM`), so the guest doesn't check them again. Adapters see ordinary frames either way.

/** The 12-byte `virtio_net_hdr_v1` before every frame (virtio 1.2 §5.1.6). */
export const NET_HDR = 12;
/** A 1500-byte MTU, the Ethernet header and a VLAN tag: the largest frame that isn't cut into segments. */
export const MAX_FRAME = 1518;
/** The largest packet the guest may hand over to be cut: an IPv6 header and the largest payload, behind Ethernet and a VLAN tag. */
export const MAX_GSO_FRAME = 18 + 40 + 65_535;

/** The offload features the device offers (virtio 1.2 §5.1.3). */
export const F_CSUM = 1n << 0n;
export const F_GUEST_CSUM = 1n << 1n;
export const F_HOST_TSO4 = 1n << 11n;
export const F_HOST_TSO6 = 1n << 12n;
export const F_HOST_ECN = 1n << 13n;
export const F_HOST_USO = 1n << 56n;
export const OFFLOADS = F_CSUM | F_GUEST_CSUM | F_HOST_TSO4 | F_HOST_TSO6 | F_HOST_ECN | F_HOST_USO;

const NEEDS_CSUM = 1; // header flags
export const DATA_VALID = 2;
const GSO_NONE = 0; // header gso_type, without the ECN bit (0x80)
const GSO_TCPV4 = 1;
const GSO_TCPV6 = 4;
const GSO_UDP_L4 = 5;

const be16 = (b: Uint8Array, at: number) => (b[at] << 8) | b[at + 1];
const le16 = (b: Uint8Array, at: number) => b[at] | (b[at + 1] << 8);
const put16 = (b: Uint8Array, at: number, v: number) => { b[at] = v >> 8; b[at + 1] = v & 255; };

/** The ones'-complement sum of `b[start, end)` added to `s`, not folded. */
function sum(b: Uint8Array, start: number, end: number, s = 0) {
  let k = start;
  for (; k + 1 < end; k += 2) s += (b[k] << 8) | b[k + 1];
  if (k < end) s += b[k] << 8;
  return s;
}

const fold = (s: number) => {
  while (s > 0xffff) s = (s & 0xffff) + Math.floor(s / 0x10000);
  return s;
};

/** The pseudo-header's sum (RFC 9293 §3.1, RFC 8200 §8.1) for an upper-layer message of `len` bytes. */
function pseudo(f: Uint8Array, l3: number, v6: boolean, proto: number, len: number) {
  return v6 ? sum(f, l3 + 8, l3 + 40, proto + len) : sum(f, l3 + 12, l3 + 20, proto + len);
}

/** Where the IP header starts and which version it is, behind Ethernet and at most one VLAN tag; undefined for other frames. */
function l3Of(f: Uint8Array): { l3: number; v6: boolean } | undefined {
  if (f.length < 14) return undefined;
  let l3 = 14;
  let type = be16(f, 12);
  if (type === 0x8100) {
    if (f.length < 18) return undefined;
    type = be16(f, 16);
    l3 = 18;
  }
  if (type === 0x0800 && f.length >= l3 + 20 && f[l3] >> 4 === 4) return { l3, v6: false };
  if (type === 0x86dd && f.length >= l3 + 40 && f[l3] >> 4 === 6) return { l3, v6: true };
  return undefined;
}

/**
 * The frames for one transmitted chain (`b`: the header, then the frame; the device's copy, changed in place):
 * the frame with its checksum finished, or its segments. Empty when the guest got it wrong (what a NIC drops).
 */
export function transmit(b: Uint8Array): Uint8Array[] {
  if (b.length <= NET_HDR) return [];
  const f = b.subarray(NET_HDR);
  const gso = b[1] & 0x7f;
  if (gso === GSO_NONE) {
    if (f.length > MAX_FRAME) return [];
    if (b[0] & NEEDS_CSUM && !finish(f, le16(b, 6), le16(b, 8))) return [];
    return [f];
  }
  if (f.length > MAX_GSO_FRAME) return [];
  return segments(f, gso, le16(b, 4), b[0] & NEEDS_CSUM ? le16(b, 6) : undefined);
}

/** Puts the checksum of `f[start, end)` (the guest left the pseudo-header's sum in its place) at `start + offset`. */
function finish(f: Uint8Array, start: number, offset: number) {
  const at = start + offset;
  if (at + 2 > f.length) return false;
  put16(f, at, ~fold(sum(f, start, f.length)) & 0xffff || 0xffff);
  return true;
}

/**
 * Cuts a TCP or UDP packet into `mss`-byte payloads, each with the headers and its own lengths, IPv4 ID,
 * sequence number and checksums; FIN and PSH stay on the last TCP segment, CWR on the first (RFC 3168 §6.1.2).
 * `l4` is where the guest says the transport header starts (its `csum_start`), so IPv6 extension headers pass.
 */
function segments(f: Uint8Array, gso: number, mss: number, l4?: number): Uint8Array[] {
  const ip = l3Of(f);
  if (!ip || mss === 0) return [];
  const { l3, v6 } = ip;
  const tcp = gso !== GSO_UDP_L4;
  if (tcp && gso !== (v6 ? GSO_TCPV6 : GSO_TCPV4)) return [];
  const ipEnd = v6 ? l3 + 40 : l3 + (f[l3] & 0xf) * 4;
  l4 ??= ipEnd;
  if (l4 < ipEnd || l4 + (tcp ? 20 : 8) > f.length) return [];
  if (!v6 && (f[l3 + 9] !== (tcp ? 6 : 17) || be16(f, l3 + 6) & 0x3fff)) return []; // the protocol; not a fragment
  const hl = tcp ? l4 + (f[l4 + 12] >> 4) * 4 : l4 + 8;
  if (hl > f.length || (tcp && hl < l4 + 20)) return [];
  const payload = f.length - hl;
  const n = Math.max(1, Math.ceil(payload / mss));
  const seq = tcp ? ((f[l4 + 4] << 24) | (f[l4 + 5] << 16) | (f[l4 + 6] << 8) | f[l4 + 7]) >>> 0 : 0;
  const id = v6 ? 0 : be16(f, l3 + 4);
  const out: Uint8Array[] = [];
  for (let i = 0; i < n; i++) {
    const len = Math.min(mss, payload - i * mss);
    const s = new Uint8Array(hl + len);
    s.set(f.subarray(0, hl));
    s.set(f.subarray(hl + i * mss, hl + i * mss + len), hl);
    const l4len = hl - l4 + len;
    if (v6) put16(s, l3 + 4, hl - l3 - 40 + len);
    else {
      put16(s, l3 + 2, hl - l3 + len);
      put16(s, l3 + 4, (id + i) & 0xffff);
      put16(s, l3 + 10, 0);
      put16(s, l3 + 10, ~fold(sum(s, l3, ipEnd)) & 0xffff);
    }
    let c: number;
    if (tcp) {
      const q = (seq + i * mss) >>> 0;
      s[l4 + 4] = q >>> 24; s[l4 + 5] = (q >> 16) & 255; s[l4 + 6] = (q >> 8) & 255; s[l4 + 7] = q & 255;
      if (i < n - 1) s[l4 + 13] &= ~0x09; // FIN, PSH
      if (i > 0) s[l4 + 13] &= ~0x80; // CWR
      c = l4 + 16;
    } else {
      put16(s, l4 + 4, l4len);
      c = l4 + 6;
    }
    put16(s, c, 0);
    put16(s, c, ~fold(sum(s, l4, s.length, pseudo(s, l3, v6, tcp ? 6 : 17, l4len))) & 0xffff || 0xffff);
    out.push(s);
  }
  return out;
}

/**
 * Whether `f` is a TCP or UDP packet (IPv4, or IPv6 without extension headers; not a fragment) whose checksum is
 * right, so the device may tell the guest so (`DATA_VALID`). Padding past the IP length is left out, as the guest does.
 */
export function checksumValid(f: Uint8Array): boolean {
  const ip = l3Of(f);
  if (!ip) return false;
  const { l3, v6 } = ip;
  let l4: number, end: number, proto: number;
  if (v6) {
    l4 = l3 + 40;
    end = l4 + be16(f, l3 + 4);
    proto = f[l3 + 6];
  } else {
    l4 = l3 + (f[l3] & 0xf) * 4;
    end = l3 + be16(f, l3 + 2);
    proto = f[l3 + 9];
    if (be16(f, l3 + 6) & 0x3fff || l4 < l3 + 20) return false; // a fragment or a bad header
  }
  if ((proto !== 6 && proto !== 17) || end > f.length || l4 + (proto === 6 ? 20 : 8) > end) return false;
  if (proto === 17 && !v6 && be16(f, l4 + 6) === 0) return false; // no checksum: nothing to vouch for
  return fold(sum(f, l4, end, pseudo(f, l3, v6, proto, end - l4))) === 0xffff;
}
