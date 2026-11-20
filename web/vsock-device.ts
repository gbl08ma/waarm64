// The guest's vsock (docs/devices.md "vsock"): a virtio-vsock (virtio 1.2 §5.10) with two services, systemd's
// `vmm.notify_socket` and the guest agent's port. A `firmware` machine's credential (web/app/firmware-files.ts) points the guest's systemd at
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
//
// The guest agent (web/app/guest-agent.ts) connects to `AGENT_PORT`, one connection at a time, while the page has an
// end for it (`agent`): a byte stream both ways under vsock's credit, the agent's frames (web/agent-frame.ts) in it.
// The page hears the connection open and close (`open`), the agent's bytes (`data`), and how many of its own the guest
// took (`taken`); a page that wants the stream begun afresh resets the connection (`reset`), and the agent connects
// again. Each connection has a number (`conn`) both ways: the page's messages for an earlier one are dropped, and the
// page drops the device's (the agent connects again at once, so the two cross).

import { bytes, type Ram, type Segment } from './ram.ts';
import type { Backend, Ctx, Request } from './devices.ts';

/** The device's ID (virtio 1.2 §5.10). */
export const VSOCK_ID = 19;
/** The guest's CID (the config's `guest_cid`); the host is 2 (VMADDR_CID_HOST). */
export const GUEST_CID = 3;
export const HOST_CID = 2;
/** The host's port the guest's systemd sends its notifications to (`vmm.notify_socket`). */
export const NOTIFY_PORT = 8573;
/** The host's port the guest agent connects to. */
export const AGENT_PORT = 8574;
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
/** The agent's connection's `buf_alloc`: the device hands the agent's bytes to the page at once, so it is credit only. */
export const AGENT_BUF = 256 << 10;
/** How far the agent's bytes taken run ahead of what the guest was told before the device tells it (CREDIT_UPDATE). */
const CREDIT_STEP = AGENT_BUF >> 2;
/** The most page bytes the device holds for the agent's connection before it drops more: the page keeps far fewer in flight (web/app/agent-link.ts). */
export const MAX_PENDING = 1 << 20;

/** The device's entry: ID 19, no optional features (stream sockets are implied), three queues of 64; config `guest_cid`. */
export function vsockEntry(): { entry: bigint[]; config: Uint8Array } {
  const config = new Uint8Array(8);
  new DataView(config.buffer).setBigUint64(0, BigInt(GUEST_CID), true);
  return { entry: [BigInt(VSOCK_ID), 0n, 3n, 64n, 8n], config };
}

/** The device to the page: a notification, its lines (`READY=1`, `STATUS=…`). */
export type VsockFromDevice = { type: 'notify'; lines: string[] };

/**
 * The device to the page's agent end: the agent's connection opened or closed, its bytes, the page's bytes the guest
 * took.
 */
export type AgentFromDevice =
  | { type: 'open'; open: boolean; conn: number }
  | { type: 'data'; bytes: Uint8Array; conn: number }
  | { type: 'taken'; n: number; conn: number };
/** The page's agent end to the device: bytes for the agent, or the connection reset (the agent connects again). */
export type AgentToDevice = { type: 'data'; bytes: Uint8Array; conn: number } | { type: 'reset'; conn: number };

/** `port`: systemd's notifications; `agent`: the guest agent's end (none: the agent's connections are refused). */
export type VsockSpec = { type: 'vsock'; port?: MessagePort; agent?: MessagePort };

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
  // CIDs are 64-bit; as numbers (exact below 2^53), without a BigInt per packet.
  v.setUint32(0, h.srcCid >>> 0, true);
  v.setUint32(4, Math.floor(h.srcCid / 2 ** 32), true);
  v.setUint32(8, h.dstCid >>> 0, true);
  v.setUint32(12, Math.floor(h.dstCid / 2 ** 32), true);
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
    srcCid: v.getUint32(0, true) + v.getUint32(4, true) * 2 ** 32,
    dstCid: v.getUint32(8, true) + v.getUint32(12, true) * 2 ** 32,
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

/**
 * The agent's connection: the guest's port; the guest's bytes taken (`fwdCnt`) and how many of them it was told;
 * the guest's receive space (`bufAlloc`, `peerFwd`) and the bytes sent it (`txCnt`); the page's bytes not sent yet.
 */
type AgentConn = {
  /** Its number, counted from 1 (the page's messages name it). */
  id: number;
  port: number;
  fwdCnt: number;
  told: number;
  bufAlloc: number;
  peerFwd: number;
  txCnt: number;
  pending: Uint8Array[];
  held: number;
};

export function vsockDevice(ctx: Ctx, d: VsockSpec): Backend {
  const conns = new Map<number, Conn>();
  let agent: AgentConn | undefined;
  let lastConn = 0;
  const rx: Request[] = [];
  let out: Uint8Array[] = [];
  const events: Request[] = [];
  let resetPending = false;
  const toPage = (m: AgentFromDevice, transfer: Transferable[] = []) => d.agent?.postMessage(m, transfer);

  /** Room for the agent's bytes in the guest's receive space (vsock's credit). */
  const credit = (a: AgentConn) => Math.max(0, a.bufAlloc - ((a.txCnt - a.peerFwd) >>> 0));
  /** The control packets first, as far as the guest's buffers go. */
  const flushOut = () => {
    while (rx.length && out.length) {
      const r = rx.shift()!;
      ctx.complete(r.w0, scatter(ctx.ram(), r.write, out.shift()!));
    }
  };
  const flush = () => {
    flushOut();
    // The page's bytes for the agent, as far as the guest's buffers and its credit go: a packet a buffer.
    let taken = 0;
    while (agent && rx.length && agent.held) {
      const room = Math.min(credit(agent), rx[0].write.reduce((n, s) => n + s.len, 0) - HDR);
      // Out of credit: Linux's receiver sends CREDIT_UPDATE by itself as its reader frees room. (A CREDIT_REQUEST
      // here is answered at once, freed room or not, and the two sides bounced packets until the agent read.)
      if (room <= 0) break;
      const chunk = take(agent.pending, room);
      agent.held -= chunk.length;
      agent.txCnt = (agent.txCnt + chunk.length) >>> 0;
      const r = rx.shift()!;
      // The header and the chunk straight into the guest's buffer.
      ctx.complete(r.w0, scatter(ctx.ram(), r.write, agentHeader(agent, OP.RW, chunk.length), chunk));
      taken += chunk.length;
    }
    if (taken && agent) toPage({ type: 'taken', n: taken, conn: agent.id });
  };
  const flushEvents = () => {
    if (!resetPending || !events.length) return;
    resetPending = false;
    const r = events.shift()!;
    ctx.complete(r.w0, scatter(ctx.ram(), r.write, new Uint8Array(4))); // le32 id 0: TRANSPORT_RESET
  };
  const header = (
    port: number,
    from: number,
    op: number,
    o: { flags?: number; len?: number; bufAlloc?: number; fwdCnt?: number } = {},
  ) =>
    encodeHeader({
      srcCid: HOST_CID,
      dstCid: GUEST_CID,
      srcPort: from,
      dstPort: port,
      len: o.len ?? 0,
      type: TYPE_STREAM,
      op,
      flags: o.flags ?? 0,
      bufAlloc: o.bufAlloc ?? BUF_ALLOC,
      fwdCnt: o.fwdCnt ?? 0,
    });
  /** A packet of the agent's connection; it tells the guest the bytes taken. */
  const agentHeader = (a: AgentConn, op: number, len = 0, flags = 0) => {
    a.told = a.fwdCnt;
    return header(a.port, AGENT_PORT, op, { len, flags, bufAlloc: AGENT_BUF, fwdCnt: a.fwdCnt });
  };
  /** A packet to the guest's `port` from the host's `from`. */
  const send = (port: number, from: number, op: number, flags = 0) => {
    if (out.length >= MAX_OUT) return;
    if (from === AGENT_PORT && agent?.port === port) out.push(agentHeader(agent, op, 0, flags));
    else out.push(header(port, from, op, { flags, fwdCnt: conns.get(port)?.fwdCnt ?? 0 }));
    flush();
  };
  /** The guest's whole message, posted (empty: nothing). */
  const finish = (c: Conn) => {
    if (!c.size) return;
    const text = new TextDecoder().decode(concat(c.chunks));
    const lines = text.split('\n').filter((l) => l);
    d.port?.postMessage({ type: 'notify', lines } satisfies VsockFromDevice);
  };
  /** The agent's connection gone (the page hears it). */
  const dropAgent = () => {
    if (!agent) return;
    const conn = agent.id;
    agent = undefined;
    toPage({ type: 'open', open: false, conn });
  };

  const onAgent = (h: Header, payload: Uint8Array) => {
    const port = h.srcPort;
    if (h.op === OP.REQUEST) {
      if (!d.agent) return send(port, AGENT_PORT, OP.RST);
      // One connection: a new one (the agent started again, or its port reused) takes the old one's place.
      if (agent) {
        if (agent.port !== port) send(agent.port, AGENT_PORT, OP.RST);
        dropAgent();
      }
      const id = ++lastConn;
      agent = { id, port, fwdCnt: 0, told: 0, bufAlloc: h.bufAlloc, peerFwd: h.fwdCnt, txCnt: 0, pending: [], held: 0 };
      send(port, AGENT_PORT, OP.RESPONSE);
      toPage({ type: 'open', open: true, conn: id });
      return;
    }
    const a = agent;
    if (!a || a.port !== port) return h.op === OP.RST ? undefined : send(port, AGENT_PORT, OP.RST);
    if (h.op === OP.RST) return dropAgent();
    // Every packet says the guest's receive space.
    [a.bufAlloc, a.peerFwd] = [h.bufAlloc, h.fwdCnt];
    switch (h.op) {
      case OP.RW:
        if (payload.length) {
          a.fwdCnt = (a.fwdCnt + payload.length) >>> 0;
          // The packet's own buffer (gathered for it): transferred, its header before the view.
          toPage({ type: 'data', bytes: payload, conn: a.id }, [payload.buffer as ArrayBuffer]);
          if ((a.fwdCnt - a.told) >>> 0 >= CREDIT_STEP) send(port, AGENT_PORT, OP.CREDIT_UPDATE);
        }
        break;
      case OP.CREDIT_REQUEST:
        send(port, AGENT_PORT, OP.CREDIT_UPDATE);
        break;
      case OP.SHUTDOWN:
        // The agent closes or shuts down a way: the connection is done (the page starts afresh with the next).
        send(port, AGENT_PORT, OP.RST);
        return dropAgent();
    }
    flush(); // the guest's credit may have grown
  };

  const onPacket = (h: Header, payload: Uint8Array) => {
    if (h.dstCid === HOST_CID && h.dstPort === AGENT_PORT && h.type === TYPE_STREAM) return onAgent(h, payload);
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
        return; // CREDIT_UPDATE: the device sends no data on these, so the guest's credit doesn't matter
    }
  };

  const fromPage = (m: AgentToDevice | undefined) => {
    // An earlier connection's (the page hadn't heard it end yet): dropped.
    if (!agent || m?.conn !== agent.id) return;
    if (m?.type === 'reset') {
      send(agent.port, AGENT_PORT, OP.RST);
      return dropAgent();
    }
    if (m?.type !== 'data' || !(m.bytes instanceof Uint8Array) || !m.bytes.length) return;
    if (agent.held + m.bytes.length > MAX_PENDING) return;
    agent.pending.push(m.bytes);
    agent.held += m.bytes.length;
    flush();
  };
  if (d.agent) d.agent.onmessage = (e: MessageEvent<AgentToDevice | undefined>) => fromPage(e.data);

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
      dropAgent();
      rx.length = 0;
      events.length = 0;
      out = [];
      resetPending = false;
    },
    close() {
      d.port?.close();
      d.agent?.close();
    },
    // The guest's buffers are posted again by the core at a restore; the connections aren't kept: the guest is told its
    // transport was reset, so it drops them (a notification in flight is lost, its sender gets an error, not a hang;
    // the agent connects again).
    save: () => ({ reset: true }),
    restore() {
      resetPending = true;
      flushEvents();
    },
  };
}

/** The first `n` bytes (at most) of a queue of chunks, taken off it. */
function take(q: Uint8Array[], n: number): Uint8Array {
  if (q[0].length <= n && q.length === 1) return q.shift()!;
  const out = new Uint8Array(
    Math.min(
      n,
      q.reduce((a, b) => a + b.length, 0),
    ),
  );
  let k = 0;
  while (k < out.length) {
    const c = q[0];
    const m = Math.min(c.length, out.length - k);
    out.set(c.subarray(0, m), k);
    k += m;
    if (m === c.length) q.shift();
    else q[0] = c.subarray(m);
  }
  return out;
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

/** Writes `data`, then `more`, across the segments, as one run of bytes; the bytes written. */
function scatter(ram: Ram, segs: Segment[], data: Uint8Array, more?: Uint8Array) {
  let k = 0;
  let src = data;
  let at = 0;
  for (const s of segs) {
    let off = 0;
    while (off < s.len) {
      if (at === src.length) {
        if (!more || src === more) return k;
        src = more;
        at = 0;
        continue;
      }
      const n = Math.min(s.len - off, src.length - at);
      ram[s.mem].set(src.subarray(at, at + n), s.off + off);
      off += n;
      at += n;
      k += n;
    }
  }
  return k;
}
