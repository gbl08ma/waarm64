// IPv4 ICMP echo packets, for talking to a tailnet peer from JS alone.
function checksum(b: Uint8Array) {
  let s = 0;
  for (let k = 0; k < b.length; k += 2) s += (b[k] << 8) | (b[k + 1] ?? 0);
  while (s > 0xffff) s = (s & 0xffff) + (s >>> 16);
  return ~s & 0xffff;
}

const ip4 = (a: string) => a.split('.').map(Number);

/** An echo request from `src` to `dst` carrying `payload`, with identifier `id` and sequence `seq`. */
export function echoRequest(src: string, dst: string, id: number, seq: number, payload: Uint8Array) {
  const p = new Uint8Array(20 + 8 + payload.length);
  const v = new DataView(p.buffer);
  p[0] = 0x45;
  v.setUint16(2, p.length);
  v.setUint16(4, seq & 0xffff);
  p[8] = 64;
  p[9] = 1;
  p.set(ip4(src), 12);
  p.set(ip4(dst), 16);
  v.setUint16(10, checksum(p.subarray(0, 20)));
  p[20] = 8;
  v.setUint16(24, id);
  v.setUint16(26, seq & 0xffff);
  p.set(payload, 28);
  v.setUint16(22, checksum(p.subarray(20)));
  return p;
}

/** The identifier and sequence of an echo reply for us, or null if `p` isn't one. */
export function echoReply(p: Uint8Array) {
  if (p.length < 28 || p[0] >> 4 !== 4 || p[9] !== 1) return null;
  const ihl = (p[0] & 0xf) * 4;
  if (p[ihl] !== 0) return null;
  const v = new DataView(p.buffer, p.byteOffset, p.length);
  return { id: v.getUint16(ihl + 4), seq: v.getUint16(ihl + 6), len: p.length };
}
