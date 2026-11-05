// The agent's device (docs/devices.md "agent"; docs/plans/clipboard.md §2): a virtio-console of its own, with the
// MULTIPORT feature and one named port, `org.webpc.agent.0`, the guest's agent's way to the page. It is on a machine
// only while its clipboard setting is on, so it leaves every other machine's shape alone. Linux's virtio_console
// makes `/dev/vport<N>p0` of the port and udev links it as `/dev/virtio-ports/org.webpc.agent.0`; no port is a console
// (no CONSOLE_PORT message), so no hvc appears.
//
// The control handshake (virtio 1.2 §5.3.6.2, as Linux's driver runs it): the driver fills the control receive queue
// and sends DEVICE_READY; the device adds each port (PORT_ADD); the driver makes the port and sends PORT_READY; the
// device names it (PORT_NAME) and says the host end is open (PORT_OPEN 1: the page is always there). The guest's
// opens and closes of the port come as PORT_OPEN (1, 0): the page hears `open`. While the guest has the port closed
// the page's bytes are dropped (Linux drops what arrives for a port nobody holds open, too).

import { bytes, type Ram, type Segment } from './ram.ts';
import type { Backend, Ctx, Request } from './devices.ts';

/** The port names, in port order: their ids are their indices. */
export const AGENT_PORTS = ['org.webpc.agent.0'];

/** VIRTIO_CONSOLE_F_MULTIPORT. */
export const F_MULTIPORT = 1n << 1n;

// Control events (struct virtio_console_control: le32 id, le16 event, le16 value).
export const DEVICE_READY = 0;
export const PORT_ADD = 1;
export const PORT_READY = 3;
export const CONSOLE_PORT = 4;
export const PORT_OPEN = 6;
export const PORT_NAME = 7;
const CTL = 8;

/** The queues: port 0's receive and transmit, the control receive (device to driver) and transmit, then port 1's, … */
export const CTL_RX = 2;
export const CTL_TX = 3;
export const portQueues = (p: number) => (p === 0 ? [0, 1] : [2 + 2 * p, 3 + 2 * p]);

/** The device's entry: ID 3, MULTIPORT, (ports + 1) * 2 queues of 64; config cols, rows, max_nr_ports, emerg_wr. */
export function agentEntry(ports = AGENT_PORTS.length): { entry: bigint[]; config: Uint8Array } {
  const config = new Uint8Array(12);
  new DataView(config.buffer).setUint32(4, ports, true);
  return { entry: [3n, F_MULTIPORT, BigInt((ports + 1) * 2), 64n, 12n], config };
}

/** The device to the page: a port's guest end opened or closed, bytes the guest wrote, host bytes the guest took. */
export type AgentFromDevice =
  | { type: 'open'; port: number; open: boolean }
  | { type: 'data'; port: number; bytes: Uint8Array }
  | { type: 'taken'; port: number; n: number };
/** The page to the device: bytes for the guest's end of a port. */
export type AgentToDevice = { type: 'data'; port: number; bytes: Uint8Array };

/** The most host bytes the device holds for a port before it drops more: the page keeps far fewer in flight (web/app/agent-link.ts). */
export const MAX_PENDING = 1 << 20;

export type AgentSpec = { type: 'agent'; port?: MessagePort };

/** A port's state: its receive buffers, the page's bytes waiting for them, and whether the guest holds it open. */
type Port = { rx: Request[]; pending: Uint8Array[]; held: number; ready: boolean; open: boolean };

export function agentDevice(ctx: Ctx, d: AgentSpec, names = AGENT_PORTS): Backend {
  let ports: Port[] = names.map(() => ({ rx: [], pending: [], held: 0, ready: false, open: false }));
  const ctlRx: Request[] = [];
  let ctlOut: Uint8Array[] = [];
  const post = (m: AgentFromDevice, transfer: Transferable[] = []) => d.port?.postMessage(m, transfer);

  const control = (id: number, event: number, value: number, extra?: Uint8Array) => {
    const m = new Uint8Array(CTL + (extra?.length ?? 0));
    const v = new DataView(m.buffer);
    v.setUint32(0, id, true);
    v.setUint16(4, event, true);
    v.setUint16(6, value, true);
    if (extra) m.set(extra, CTL);
    ctlOut.push(m);
    flushControl();
  };
  const flushControl = () => {
    while (ctlRx.length && ctlOut.length) {
      const r = ctlRx.shift()!;
      const m = ctlOut.shift()!;
      // A control buffer shorter than the message is a driver's bug: it gets what fits.
      ctx.complete(r.w0, scatter(ctx.ram(), r.write, m));
    }
  };

  /** Fills port `p`'s receive buffers with the page's bytes, as many as there are of both. */
  const deliver = (p: number) => {
    const port = ports[p];
    let taken = 0;
    while (port.rx.length && port.pending.length) {
      const r = port.rx.shift()!;
      const room = r.write.reduce((n, s) => n + s.len, 0);
      const chunk = take(port.pending, room);
      port.held -= chunk.length;
      scatter(ctx.ram(), r.write, chunk);
      ctx.complete(r.w0, chunk.length);
      taken += chunk.length;
    }
    if (taken) post({ type: 'taken', port: p, n: taken });
  };

  const fromPage = (m: AgentToDevice) => {
    if (m?.type !== 'data' || !(m.bytes instanceof Uint8Array)) return;
    const port = ports[m.port];
    if (!port?.open || !m.bytes.length) return;
    if (port.held + m.bytes.length > MAX_PENDING) return;
    port.pending.push(m.bytes);
    port.held += m.bytes.length;
    deliver(m.port);
  };
  if (d.port) d.port.onmessage = (e: MessageEvent<AgentToDevice>) => fromPage(e.data);

  const onControl = (r: Request) => {
    const m = gather(ctx.ram(), r.read, CTL);
    if (m.length < CTL) return;
    const v = new DataView(m.buffer, m.byteOffset, CTL);
    const [id, event, value] = [v.getUint32(0, true), v.getUint16(4, true), v.getUint16(6, true)];
    switch (event) {
      case DEVICE_READY:
        if (value === 1) names.forEach((_, p) => control(p, PORT_ADD, 0));
        break;
      case PORT_READY:
        // 0: the driver couldn't make the port; nothing to do but leave it.
        if (value === 1 && ports[id] && !ports[id].ready) {
          ports[id].ready = true;
          control(id, PORT_NAME, 0, new TextEncoder().encode(names[id]));
          control(id, PORT_OPEN, 1);
        }
        break;
      case PORT_OPEN: {
        const port = ports[id];
        if (!port || port.open === (value === 1)) break;
        port.open = value === 1;
        if (!port.open) [port.pending, port.held] = [[], 0];
        post({ type: 'open', port: id, open: port.open });
        break;
      }
    }
  };

  return {
    request(r) {
      if (r.queue === CTL_RX) {
        ctlRx.push(r);
        flushControl();
        return undefined;
      }
      if (r.queue === CTL_TX) {
        onControl(r);
        return 0;
      }
      const p = r.queue < 2 ? 0 : (r.queue - 2) >> 1;
      if (!ports[p]) return 0;
      if (r.queue === portQueues(p)[0]) {
        ports[p].rx.push(r);
        deliver(p);
        return undefined;
      }
      const out = gather(ctx.ram(), r.read, r.read.reduce((n, s) => n + s.len, 0)).slice();
      if (out.length) post({ type: 'data', port: p, bytes: out }, [out.buffer]);
      return 0;
    },
    reset() {
      for (const [p, port] of ports.entries()) if (port.open) post({ type: 'open', port: p, open: false });
      ports = names.map(() => ({ rx: [], pending: [], held: 0, ready: false, open: false }));
      ctlRx.length = 0;
      ctlOut = [];
    },
    close: () => d.port?.close(),
    // The buffers the guest gave are posted again by the core at a restore; what the backend keeps is each port's
    // state, the page's bytes not yet taken, and control messages not yet sent.
    save: () => ({ ports: ports.map((p) => ({ ready: p.ready, open: p.open, pending: concat(p.pending) })), control: ctlOut }),
    restore(state) {
      const s = state as { ports?: { ready?: boolean; open?: boolean; pending?: Uint8Array }[]; control?: Uint8Array[] };
      (s.ports ?? []).forEach((x, p) => {
        if (!ports[p]) return;
        const pending = x.pending instanceof Uint8Array && x.pending.length ? [x.pending] : [];
        ports[p] = { rx: [], pending, held: pending[0]?.length ?? 0, ready: !!x.ready, open: !!x.open };
        if (ports[p].open) post({ type: 'open', port: p, open: true });
      });
      ctlOut = (s.control ?? []).filter((m) => m instanceof Uint8Array);
    },
  };
}

/** The first `n` bytes (at most) of a queue of chunks, taken off it. */
function take(q: Uint8Array[], n: number): Uint8Array {
  if (q[0].length <= n && q.length === 1) return q.shift()!;
  const out = new Uint8Array(Math.min(n, q.reduce((a, b) => a + b.length, 0)));
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
