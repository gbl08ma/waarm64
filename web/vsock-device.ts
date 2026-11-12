// The guest's notify socket (docs/devices.md "vsock"): a virtio-vsock (virtio 1.2 §5.10) whose one service is systemd's
// `vmm.notify_socket`. A `firmware` machine's credential (web/app/firmware-files.ts) points the guest's systemd at
// `vsock-stream:2:NOTIFY_PORT`, the host's CID, as systemd-vmspawn does; systemd (254 and later) then sends its
// sd_notify messages there, one stream connection each: `READY=1` once the boot's jobs are done, `STATUS=…`,
// `X_SYSTEMD_UNIT_ACTIVE=<target>` (256 and later), `EXIT_STATUS=` at the end. The device answers the connection, takes
// the message, and posts it to the page once the guest has said it sent everything (SHUTDOWN).
//
// The guest waits for the host's end of each connection (systemd 256 and later `recv`s until EOF after its
// `shutdown(SHUT_WR)`, and PID 1 is the sender), so every connection is answered whatever the page does: a request to
// another port or of another type is refused (RST), a guest's half close is answered by the host's full close
// (SHUTDOWN of both ways: the guest resets and its `recv` gives EOF), a guest's full close by RST. Nothing is kept across
// a snapshot: a restored device tells the guest its transport was reset, which drops the guest's connections.

import { bytes, type Ram, type Segment } from './ram.ts';
import type { Backend, Ctx, Request } from './devices.ts';

/** The device's ID (virtio 1.2 §5.10). */
export const VSOCK_ID = 19;
/** The guest's CID (the config's `guest_cid`); the host is 2 (VMADDR_CID_HOST). */
export const GUEST_CID = 3;
export const HOST_CID = 2;
/** The host's port the guest's systemd sends its notifications to (`vmm.notify_socket`). */
export const NOTIFY_PORT = 8573;
/** The credential that points systemd at it (systemd's `vsock-stream:` form, 254 and later). */
export const notifySocket = () => `vsock-stream:${HOST_CID}:${NOTIFY_PORT}`;

/** The queues: receive (device to driver), transmit, event. */
export const RX = 0;
export const TX = 1;
export const EVENT = 2;

/** struct virtio_vsock_hdr's size, packed. */
export const HDR = 44;
export const TYPE_STREAM = 1;
export const OP = { REQUEST: 1, RESPONSE: 2, RST: 3, SHUTDOWN: 4, RW: 5, CREDIT_UPDATE: 6, CREDIT_REQUEST: 7 } as const;
/** SHUTDOWN's flags: the sender receives no more, sends no more. */
export const SHUTDOWN_RCV = 1;
export const SHUTDOWN_SEND = 2;
/** The one event (struct virtio_vsock_event's id). */
export const EVENT_TRANSPORT_RESET = 0;
/** The bytes a connection may send the device (its `buf_alloc`): a notification is a few hundred; past it, RST. */
export const BUF_ALLOC = 64 << 10;
/** The most packets the device holds for the guest's receive buffers before it drops more (a guest that stopped taking them). */
const MAX_OUT = 256;

/** The device's entry: ID 19, no optional features (stream sockets are implied), three queues of 64; config `guest_cid`. */
export function vsockEntry(): { entry: bigint[]; config: Uint8Array } {
  const config = new Uint8Array(8);
  new DataView(config.buffer).setBigUint64(0, BigInt(GUEST_CID), true);
  return { entry: [BigInt(VSOCK_ID), 0n, 3n, 64n, 8n], config };
}

/** The device to the page: a notification, its lines (`READY=1`, `STATUS=…`). */
export type VsockFromDevice = { type: 'notify'; lines: string[] };

export type VsockSpec = { type: 'vsock'; port?: MessagePort };

/** The page's end of the device's port: `up` at each READY=1 (the boot's jobs are done). */
export function onReady(port: MessagePort, up: () => void) {
  port.onmessage = (e: MessageEvent<VsockFromDevice>) => {
    if (e.data.lines.includes('READY=1')) up();
  };
}

export type Header = {
  srcCid: number;
  dstCid: number;
  srcPort: number;
  dstPort: number;
  len: number;
  type: number;
  op: number;
  flags: number;
  bufAlloc: number;
  fwdCnt: number;
};

export function encodeHeader(h: Header): Uint8Array {
  const b = new Uint8Array(HDR);
  const v = new DataView(b.buffer);
  v.setBigUint64(0, BigInt(h.srcCid), true);
  v.setBigUint64(8, BigInt(h.dstCid), true);
  v.setUint32(16, h.srcPort, true);
  v.setUint32(20, h.dstPort, true);
  v.setUint32(24, h.len, true);
  v.setUint16(28, h.type, true);
  v.setUint16(30, h.op, true);
  v.setUint32(32, h.flags, true);
  v.setUint32(36, h.bufAlloc, true);
  v.setUint32(40, h.fwdCnt, true);
  return b;
}

export function decodeHeader(b: Uint8Array): Header {
  const v = new DataView(b.buffer, b.byteOffset, HDR);
  return {
    srcCid: Number(v.getBigUint64(0, true)),
    dstCid: Number(v.getBigUint64(8, true)),
    srcPort: v.getUint32(16, true),
    dstPort: v.getUint32(20, true),
    len: v.getUint32(24, true),
    type: v.getUint16(28, true),
    op: v.getUint16(30, true),
    flags: v.getUint32(32, true),
    bufAlloc: v.getUint32(36, true),
    fwdCnt: v.getUint32(40, true),
  };
}

/** A connection from the guest: its port, the message so far, the bytes taken (`fwd_cnt`). */
type Conn = { chunks: Uint8Array[]; size: number; fwdCnt: number };

export function vsockDevice(ctx: Ctx, d: VsockSpec): Backend {
  const conns = new Map<number, Conn>();
  const rx: Request[] = [];
  let out: Uint8Array[] = [];
  const events: Request[] = [];
  let resetPending = false;

  const flush = () => {
    while (rx.length && out.length) {
      const r = rx.shift()!;
      ctx.complete(r.w0, scatter(ctx.ram(), r.write, out.shift()!));
    }
  };
  const flushEvents = () => {
    if (!resetPending || !events.length) return;
    resetPending = false;
    const r = events.shift()!;
    ctx.complete(r.w0, scatter(ctx.ram(), r.write, new Uint8Array(4))); // le32 id 0: TRANSPORT_RESET
  };
  /** A packet to the guest's `port` from the host's `from`. */
  const send = (port: number, from: number, op: number, flags = 0) => {
    if (out.length >= MAX_OUT) return;
    const fwdCnt = conns.get(port)?.fwdCnt ?? 0;
    out.push(
      encodeHeader({
        srcCid: HOST_CID,
        dstCid: GUEST_CID,
        srcPort: from,
        dstPort: port,
        len: 0,
        type: TYPE_STREAM,
        op,
        flags,
        bufAlloc: BUF_ALLOC,
        fwdCnt,
      }),
    );
    flush();
  };
  /** The guest's whole message, posted (empty: nothing). */
  const finish = (c: Conn) => {
    if (!c.size) return;
    const text = new TextDecoder().decode(concat(c.chunks));
    const lines = text.split('\n').filter((l) => l);
    d.port?.postMessage({ type: 'notify', lines } satisfies VsockFromDevice);
  };

  const onPacket = (h: Header, payload: Uint8Array) => {
    const port = h.srcPort;
    const conn = conns.get(port);
    const ours = h.dstCid === HOST_CID && h.dstPort === NOTIFY_PORT && h.type === TYPE_STREAM;
    if (h.op === OP.RST) {
      if (conn) finish(conn);
      conns.delete(port);
      return;
    }
    if (h.op === OP.REQUEST) {
      if (!ours) return send(port, h.dstPort, OP.RST);
      conns.set(port, { chunks: [], size: 0, fwdCnt: 0 });
      return send(port, h.dstPort, OP.RESPONSE);
    }
    if (!conn || !ours) return send(port, h.dstPort, OP.RST);
    switch (h.op) {
      case OP.RW:
        if (conn.size + payload.length > BUF_ALLOC) {
          conns.delete(port);
          return send(port, h.dstPort, OP.RST);
        }
        conn.chunks.push(payload.slice());
        conn.size += payload.length;
        conn.fwdCnt = (conn.fwdCnt + payload.length) >>> 0;
        return;
      case OP.CREDIT_REQUEST:
        return send(port, h.dstPort, OP.CREDIT_UPDATE);
      case OP.SHUTDOWN:
        if (!(h.flags & SHUTDOWN_SEND)) return; // it still sends: the message isn't whole
        finish(conn);
        conn.chunks = [];
        conn.size = 0;
        // A full close is answered by RST (the guest waits for it); a half close by the host's own close, which the
        // guest answers with RST (its `recv` then gives EOF).
        if (h.flags & SHUTDOWN_RCV) {
          conns.delete(port);
          return send(port, h.dstPort, OP.RST);
        }
        return send(port, h.dstPort, OP.SHUTDOWN, SHUTDOWN_RCV | SHUTDOWN_SEND);
      default:
        return; // CREDIT_UPDATE: the device sends no data, so the guest's credit doesn't matter
    }
  };

  return {
    request(r) {
      if (r.queue === RX) {
        rx.push(r);
        flush();
        return undefined;
      }
      if (r.queue === EVENT) {
        events.push(r);
        flushEvents();
        return undefined;
      }
      if (r.queue !== TX) return 0;
      const len = r.read.reduce((n, s) => n + s.len, 0);
      if (len < HDR) return 0;
      const packet = gather(ctx.ram(), r.read, len);
      const h = decodeHeader(packet);
      onPacket(h, packet.subarray(HDR, HDR + Math.min(h.len, len - HDR)));
      return 0;
    },
    reset() {
      conns.clear();
      rx.length = 0;
      events.length = 0;
      out = [];
      resetPending = false;
    },
    close: () => d.port?.close(),
    // The guest's buffers are posted again by the core at a restore; the connections aren't kept: the guest is told its
    // transport was reset, so it drops them (a notification in flight is lost; its sender gets an error, not a hang).
    save: () => ({ reset: true }),
    restore() {
      resetPending = true;
      flushEvents();
    },
  };
}

const concat = (q: Uint8Array[]) => {
  const out = new Uint8Array(q.reduce((a, b) => a + b.length, 0));
  let k = 0;
  for (const c of q) {
    out.set(c, k);
    k += c.length;
  }
  return out;
};

function gather(ram: Ram, segs: Segment[], len: number) {
  const out = new Uint8Array(len);
  let k = 0;
  for (const s of segs) {
    if (k === len) break;
    const n = Math.min(s.len, len - k);
    out.set(bytes(ram, s).subarray(0, n), k);
    k += n;
  }
  return out.subarray(0, k);
}

/** Writes `data` across the segments; the bytes written. */
function scatter(ram: Ram, segs: Segment[], data: Uint8Array) {
  let k = 0;
  for (const s of segs) {
    if (k === data.length) break;
    const n = Math.min(s.len, data.length - k);
    bytes(ram, s).set(data.subarray(k, k + n));
    k += n;
  }
  return k;
}
