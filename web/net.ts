// Network adapters for virtio-net (docs/devices.md "net"): the device hands an
// adapter each Ethernet frame the guest transmits and takes frames for the
// guest from it. IP, ARP, DHCP and the rest live in the adapter or beyond it.
//
// Adapters run in the device worker (the test adapters, which answer
// synchronously so deterministic mode stays exact) or on the page, behind a
// MessagePort handed to the device (`{type: 'net', adapter: port}`): each
// message on the port is one frame, an ArrayBuffer, in either direction, or a
// batch of them (an array of ArrayBuffers, in order: a frame socket's message,
// web/local-net.ts `framePath`).

import { eq } from './bytes.ts';

/** Frames out (`send`, which may keep the array); frames in through the `receive` it was made with. */
export type NetAdapter = { send(frame: Uint8Array): void; close?(): void };

/** The fake peer the loopback adapter plays: 10.0.2.2 at 52:55:0a:00:02:02. */
export const PEER_IP = [10, 0, 2, 2];
export const PEER_MAC = [0x52, 0x55, 0x0a, 0x00, 0x02, 0x02];

/** The Internet checksum of `b`. */
export function checksum(b: Uint8Array) {
  let s = 0;
  for (let k = 0; k < b.length; k += 2) s += (b[k] << 8) | (b[k + 1] ?? 0);
  while (s > 0xffff) s = (s & 0xffff) + (s >>> 16);
  return ~s & 0xffff;
}

/**
 * The loopback test adapter: answers ARP requests and ICMP echo requests for
 * the peer, synchronously, and drops everything else. core/tests/common has
 * its twin, which must answer with the same bytes.
 */
export function loopback(receive: (frame: Uint8Array) => void): NetAdapter {
  return {
    send(f) {
      const type = (f[12] << 8) | f[13];
      if (type === 0x0806 && f.length >= 42 && f[21] === 1 && eq(f, 38, PEER_IP)) {
        // ARP request for the peer: reply from it to the sender.
        const r = new Uint8Array(42);
        r.set(f.subarray(6, 12), 0);
        r.set(PEER_MAC, 6);
        r.set([0x08, 0x06, 0, 1, 0x08, 0, 6, 4, 0, 2], 12);
        r.set(PEER_MAC, 22);
        r.set(PEER_IP, 28);
        r.set(f.subarray(22, 32), 32); // the sender's MAC and IP
        receive(r);
      } else if (type === 0x0800 && f.length >= 34) {
        const ihl = (f[14] & 0xf) * 4;
        const icmp = 14 + ihl;
        if (f[23] !== 1 || !eq(f, 30, PEER_IP) || f.length < icmp + 8 || f[icmp] !== 8) return;
        // ICMP echo request to the peer: the reply swaps both address pairs
        // (the IP checksum doesn't change) and recomputes the ICMP checksum.
        const r = f.slice(0, 14 + ((f[16] << 8) | f[17]));
        r.set(f.subarray(6, 12), 0);
        r.set(PEER_MAC, 6);
        r.set(f.subarray(30, 34), 26);
        r.set(f.subarray(26, 30), 30);
        r[icmp] = 0;
        r[icmp + 2] = r[icmp + 3] = 0;
        const c = checksum(r.subarray(icmp));
        [r[icmp + 2], r[icmp + 3]] = [c >> 8, c & 0xff];
        receive(r);
      }
    },
  };
}

/**
 * Frames cross `port` as ArrayBuffers (transferred): one a message, or a batch (an array of them, received in order
 * within one task: the card delivers them together, web/net-device.ts). Other messages are ignored.
 */
export function portAdapter(port: MessagePort, receive: (frame: Uint8Array) => void): NetAdapter {
  port.onmessage = (e: MessageEvent<unknown>) => {
    const d = e.data;
    if (d instanceof ArrayBuffer) receive(new Uint8Array(d));
    else if (Array.isArray(d)) for (let k = 0; k < d.length; k++) receive(new Uint8Array(d[k] as ArrayBuffer));
  };
  return {
    send(f) {
      const b = f.buffer.byteLength === f.length ? f.buffer : f.slice().buffer;
      port.postMessage(b, [b as ArrayBuffer]);
    },
    close: () => port.close(),
  };
}

/**
 * The IP-packet port of layer-3 backends (Tailscale, docs/plans/networking.md):
 * the same shape as a frame port, but each ArrayBuffer is one IPv4 or IPv6 packet
 * with no Ethernet header; a batch (an array of ArrayBuffers) is what one task
 * sent (`batchSender`). The Ethernet gateway (N3) sits between a frame
 * adapter and one of these. Toward the gateway each buffer has `IP_HEADROOM`
 * bytes before its packet.
 */
export type IpPort = { send(packet: Uint8Array): void; close?(): void };

/** Packets cross `port` as ArrayBuffers (transferred), like frames in `portAdapter`. */
export function ipPort(port: MessagePort, receive: (packet: Uint8Array) => void): IpPort {
  return portAdapter(port, receive);
}

/**
 * The room before each packet an IP port carries toward the gateway: an Ethernet header's, which the gateway writes
 * there, so the buffer that crossed is the guest's frame (web/gateway.ts `portBackend`). The direction says it (a bare
 * ArrayBuffer can't): what a backend posts has it, what the gateway posts doesn't.
 */
export const IP_HEADROOM = 14;

/**
 * The packets in an IP-port message (one ArrayBuffer, or an array of them), each past its buffer's `headroom` bytes;
 * undefined for other messages, and for a buffer shorter than the headroom.
 */
export function packetsOf(data: unknown, headroom = 0): Uint8Array[] | undefined {
  if (data instanceof ArrayBuffer) return data.byteLength >= headroom ? [new Uint8Array(data, headroom)] : undefined;
  if (Array.isArray(data) && data.length && data.every((d) => d instanceof ArrayBuffer && d.byteLength >= headroom))
    return data.map((d) => new Uint8Array(d, headroom));
  return undefined;
}

/**
 * Sends packets on an IP port, those of one task as one message: they wait for the task's end (a microtask),
 * never for a timer, so batching adds no latency. A batch keeps its packets together for the other side
 * (the tailnet client joins their relay frames into one WebSocket message; virtio-net merges TCP segments).
 * With a `headroom`, each buffer has that many bytes before its packet: a packet that is the rest of such a buffer
 * crosses as it is, any other is copied into one.
 */
export function batchSender(port: MessagePort, headroom = 0): (packet: Uint8Array) => void {
  let batch: ArrayBuffer[] = [];
  const flush = () => {
    const b = batch;
    batch = [];
    if (b.length === 1) port.postMessage(b[0], b);
    else port.postMessage(b, b);
  };
  return (p) => {
    if (!batch.length) queueMicrotask(flush);
    if (p.byteOffset === headroom && p.buffer.byteLength === headroom + p.length) batch.push(p.buffer as ArrayBuffer);
    else if (!headroom) batch.push(p.slice().buffer);
    else {
      const b = new Uint8Array(headroom + p.length);
      b.set(p, headroom);
      batch.push(b.buffer);
    }
  };
}
