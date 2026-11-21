// The local network helper's client (docs/networking/local-helper.md, the connection kind `local`: docs/networking/adapters.md).
// The helper (github.com/gbl08ma/waarm64-net) runs on the user's computer and serves the guest DHCP, DNS and a gateway onto its own
// sockets, so this only moves Ethernet frames: between a card's frame port (web/net.ts `portAdapter`: one frame per
// message, the page's gateway bypassed: web/gateway.ts `FramePath`) and a WebSocket on loopback. On the socket each
// binary message is one or more whole frames, each after its 4-byte big-endian length (QEMU's stream framing, what the
// helper's switch speaks); the frames that come before a timer's turn go out as one message, up to `LOCAL_MAX_MESSAGE`
// (`setTimeout(0)`, measured: twice the upload of a microtask's batches at the same round trip, bench/net/REPORT.md
// "The local helper"). It runs in a worker of its own (web/local-net-worker.ts: off the page's main thread), behind the tailnet clients' handle
// (`startLocal`), so the page's network drives it as it drives them.
import { msg, MsgError, type Msg } from './msg.ts';
import { workerHandle, type FromTailscale, type NetMap, type Tailscale } from './tailscale.ts';

/** The framing's name and version, checked by both ends (waarm64-net `Subprotocol`). */
export const LOCAL_SUBPROTOCOL = 'waarm64-net.v1';

/**
 * The most a message may hold (waarm64-net `MaxMessage`): past it the helper closes the socket. A burst of the guest's
 * frames can pass it before the timer's turn, at any MTU, so a batch goes out early rather than growing past it.
 */
export const LOCAL_MAX_MESSAGE = 1 << 20;

/** Why the helper closed the socket (waarm64-net's close codes), as the page says it; undefined for another code. */
export function closeError(code: number): MsgError | undefined {
  switch (code) {
    case 4001:
      return new MsgError('network:local-net.versions');
    case 4003:
      return new MsgError('network:local-net.origin');
    case 4004:
      return new MsgError('network:local-net.token');
  }
  return undefined;
}

/** The helper closed the connection (`reason`: what its close frame said, a developer's words). */
export const helperClosed = (reason = '') =>
  new MsgError('network:local-net.closed', undefined, reason ? { cause: new Error(reason) } : undefined);

/**
 * Whether the browser refuses this origin loopback (Chromium's Local Network Access: the `loopback-network` permission,
 * whose refusal stays until the user changes the site's settings). False where the name isn't known.
 */
export async function loopbackRefused(): Promise<boolean> {
  try {
    return (await navigator.permissions.query({ name: 'loopback-network' as PermissionName })).state === 'denied';
  } catch {
    return false;
  }
}

/** Frames as one message: each after its length. */
export function frameMessage(frames: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(frames.reduce((n, f) => n + 4 + f.length, 0));
  const v = new DataView(out.buffer);
  let at = 0;
  for (const f of frames) {
    v.setUint32(at, f.length);
    out.set(f, at + 4);
    at += 4 + f.length;
  }
  return out;
}

/** A message's frames (copies), or undefined when it isn't whole frames. */
export function framesOf(msg: Uint8Array): Uint8Array[] | undefined {
  const v = new DataView(msg.buffer, msg.byteOffset, msg.byteLength);
  const out: Uint8Array[] = [];
  let at = 0;
  while (at < msg.length) {
    if (at + 4 > msg.length) return undefined;
    const n = v.getUint32(at);
    if (n < 14 || at + 4 + n > msg.length) return undefined;
    out.push(msg.slice(at + 4, at + 4 + n));
    at += 4 + n;
  }
  return out;
}

/**
 * A `ws://127.0.0.1:<port>/<token>` (or `[::1]`, `localhost`) URL, or an error to show. The pairing link the helper
 * prints (`https://waarm64.com/#net=ws://…`) gives its `net`.
 */
export function parseLocalURL(input: string): { url: string } | { error: Msg } {
  let s = input.trim();
  const at = s.indexOf('#net=');
  if (at >= 0) {
    s = s.slice(at + 5).split('&')[0];
    try {
      s = decodeURIComponent(s);
    } catch {
      return { error: msg('network:local-net.notLink', { link: s }) };
    }
  }
  if (!s) return { error: msg('network:local-net.pasteLink') };
  let u: URL;
  try {
    u = new URL(s.trim());
  } catch {
    return { error: msg('network:local-net.notLink', { link: s }) };
  }
  if (u.protocol !== 'ws:' || !['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname) || u.pathname.length < 2)
    return { error: msg('network:local-net.notLink', { link: s }) };
  return { url: u.href };
}

/**
 * The address and MTU a DHCP acknowledgment in `f` (an Ethernet frame to the guest) gives, if it is one and for the
 * client `mac`: the helper broadcasts acknowledgments to clients without an address, and its switch floods them to every
 * page connected, another machine's included.
 */
export function dhcpAck(f: Uint8Array, mac: Uint8Array): { address: string; mtu?: number } | undefined {
  if (f.length < 14 + 20 + 8 + 240 || f[12] !== 8 || f[13] !== 0 || f[14] >> 4 !== 4 || f[23] !== 17) return undefined;
  const udp = 14 + (f[14] & 15) * 4;
  const d = udp + 8;
  if (
    ((f[udp] << 8) | f[udp + 1]) !== 67 ||
    ((f[udp + 2] << 8) | f[udp + 3]) !== 68 ||
    d + 240 > f.length ||
    f[d] !== 2
  )
    return undefined;
  if (f[d + 236] !== 0x63 || f[d + 237] !== 0x82 || f[d + 238] !== 0x53 || f[d + 239] !== 0x63) return undefined;
  if (f[d + 2] !== 6 || mac.length !== 6 || mac.some((b, k) => f[d + 28 + k] !== b)) return undefined;
  let ack = false;
  let mtu: number | undefined;
  for (let k = d + 240; k < f.length && f[k] !== 255;) {
    if (f[k] === 0) {
      k++;
      continue;
    }
    if (k + 1 >= f.length) break;
    const [code, len] = [f[k], f[k + 1]];
    if (code === 53 && len >= 1) ack = f[k + 2] === 5;
    if (code === 26 && len === 2) mtu = (f[k + 2] << 8) | f[k + 3];
    k += 2 + len;
  }
  return ack ? { address: Array.from(f.subarray(d + 16, d + 20)).join('.'), mtu } : undefined;
}

/** A card's frame port as the frame path posts to it (a `MessagePort`; the demo network's tests' fake). */
type FrameSink = { postMessage(data: ArrayBuffer, transfer: Transferable[]): void };

/**
 * The frame path this client and the demo network's (web/demo-net.ts) share between the card and a socket: the guest's
 * frames batched into one message per timer's turn, at most `maxMessage` (`LOCAL_MAX_MESSAGE`); the guest's MAC, from
 * the first unicast source of its frames (its DHCP acknowledgments are the ones for it); and a message's frames to the
 * card, an acknowledgment for the guest kept as its lease (`leased` hears it). The client owns the socket: a batch is
 * sent while `ready()`, else dropped.
 */
export function framePath(o: {
  maxMessage: number;
  ready: () => boolean;
  send: (message: Uint8Array<ArrayBuffer>) => void;
  leased: () => void;
  setTimeout?: (f: () => void, ms: number) => unknown;
}) {
  const later = o.setTimeout ?? ((f: () => void, ms: number) => setTimeout(f, ms));
  const stats = { rxFrames: 0, txFrames: 0, rxBytes: 0, txBytes: 0, rxMessages: 0, txMessages: 0 };
  let mac: Uint8Array | undefined;
  let lease: { address: string; mtu?: number } | undefined;
  let batch: Uint8Array[] = [];
  let batchBytes = 0;
  const flush = () => {
    const b = batch;
    batch = [];
    batchBytes = 0;
    if (!o.ready() || !b.length) return;
    stats.txMessages++;
    o.send(frameMessage(b));
  };
  return {
    stats,
    lease: () => lease,
    /** A frame from the card's port: counted, its source taken for the guest's MAC. */
    frame(e: MessageEvent): Uint8Array {
      const f = new Uint8Array(e.data as ArrayBuffer);
      if (!mac && f.length >= 14 && !(f[6] & 1)) mac = f.slice(6, 12);
      stats.txFrames++;
      stats.txBytes += f.length;
      return f;
    },
    /** Into the batch, which goes out at the timer's turn (or now, before it would pass `maxMessage`). */
    queue(f: Uint8Array) {
      if (batchBytes + 4 + f.length > o.maxMessage) flush();
      if (!batch.length) later(flush, 0);
      batch.push(f);
      batchBytes += 4 + f.length;
    },
    /** The batch dropped (the socket closed). */
    drop() {
      batch = [];
      batchBytes = 0;
    },
    /** A socket's binary message to the card: false when it isn't whole frames. */
    receive(data: ArrayBuffer, to: FrameSink): boolean {
      const got = framesOf(new Uint8Array(data));
      if (!got) return false;
      stats.rxMessages++;
      for (const f of got) {
        stats.rxFrames++;
        stats.rxBytes += f.length;
        const ack = mac && dhcpAck(f, mac); // its first checks (the length, IPv4, UDP) turn other frames away at once
        if (ack) {
          lease = ack;
          o.leased();
        }
        to.postMessage(f.buffer as ArrayBuffer, [f.buffer]);
      }
      return true;
    },
  };
}

export type LocalState = 'connecting' | 'connected' | 'closed';

export type LocalNet = {
  state(): LocalState;
  /** Why it closed, as the page says it (undefined while open). */
  error(): Error | undefined;
  /** Frames and bytes each way (the tests' and benchmarks'). */
  stats(): {
    rxFrames: number;
    txFrames: number;
    rxBytes: number;
    txBytes: number;
    rxMessages: number;
    txMessages: number;
  };
  /** The guest's address and MTU, from the helper's last DHCP acknowledgment. */
  lease(): { address: string; mtu?: number } | undefined;
  close(): void;
};

/**
 * Connects the card behind `frames` (the page's end of its frame port) to the helper at `url`. `onChange` hears the
 * state change and a new lease. It doesn't reconnect by itself: the Network menu's Connect does.
 */
export function startLocalNet(url: string, frames: MessagePort, onChange: () => void = () => {}): LocalNet {
  let state: LocalState = 'connecting';
  let error: Error | undefined;
  let ws: WebSocket;
  try {
    ws = new WebSocket(url, LOCAL_SUBPROTOCOL);
  } catch (e) {
    // a URL the browser refuses outright (a port it blocks, such as 6000)
    const failed = new MsgError('network:local-net.unreached', undefined, { cause: e });
    queueMicrotask(onChange);
    const stats = { rxFrames: 0, txFrames: 0, rxBytes: 0, txBytes: 0, rxMessages: 0, txMessages: 0 };
    return {
      state: () => 'closed',
      error: () => failed,
      stats: () => ({ ...stats }),
      lease: () => undefined,
      close() {},
    };
  }
  ws.binaryType = 'arraybuffer';
  const path = framePath({
    maxMessage: LOCAL_MAX_MESSAGE,
    ready: () => ws.readyState === WebSocket.OPEN,
    send: (m) => ws.send(m),
    leased: onChange,
  });
  frames.onmessage = (e: MessageEvent) => path.queue(path.frame(e));
  ws.onopen = () => {
    if (ws.protocol !== LOCAL_SUBPROTOCOL) {
      error = closeError(4001);
      ws.close();
      return;
    }
    state = 'connected';
    onChange();
  };
  ws.onmessage = (e: MessageEvent) => {
    if (!path.receive(e.data as ArrayBuffer, frames)) {
      error = new MsgError('network:local-net.notFrames');
      ws.close();
    }
  };
  ws.onclose = (e: CloseEvent) => {
    // A socket that never opened on loopback: the helper isn't running, or the browser refuses this site loopback.
    const never = state === 'connecting';
    const unreached = never && !error && !closeError(e.code);
    error ??= closeError(e.code) ?? (never ? new MsgError('network:local-net.unreached') : helperClosed(e.reason));
    state = 'closed';
    if (unreached)
      void loopbackRefused().then((refused) => {
        if (refused) error = new MsgError('network:local-net.refused');
        onChange();
      });
    else onChange();
  };
  return {
    state: () => state,
    error: () => (state === 'closed' ? error : undefined),
    stats: () => ({ ...path.stats }),
    lease: path.lease,
    close() {
      frames.onmessage = null;
      frames.close(); // the socket's late messages post into nothing
      ws.close();
    },
  };
}

/** Messages to web/local-net-worker.ts. */
export type ToLocal =
  { type: 'start'; url: string; ip: MessagePort } | { type: 'attach'; ip: MessagePort } | { type: 'detach' };

/** A local connection's network map: the guest's address, once the helper leased it. */
export const localNetmap = (lease: { address: string; mtu?: number } | undefined): NetMap => ({
  name: '',
  addresses: lease ? [`${lease.address}/32`] : [],
  peers: [],
  mtu: lease?.mtu ?? 1500,
  dns: null,
  domains: null,
  exitNode: '',
  via: 'local',
});

/**
 * The client of a `local` connection (web/app/network.ts drives it as it drives a tailnet's): its worker takes the
 * card's IP port and puts the card on a frame port to the helper (`FramePath`), and hands it back with the card
 * still on frames (`{type: 'frames', port: null}`), so a reconnect to the same helper doesn't flap the link.
 * State `Running` once the socket is open; an error when it closes (the reason as the page says it).
 */
export function startLocal(
  config: { url: string; ip: MessagePort },
  onEvent: (m: FromTailscale) => void = () => {},
): Tailscale {
  const worker = new Worker(new URL('./local-net-worker.ts', import.meta.url), { type: 'module' });
  return framedClient(worker, config, onEvent, () => new MsgError('network:local-net.noExitNodes'));
}

/**
 * The page's handle on a worker that moves a card's frames over a WebSocket (web/local-net-worker.ts, and the demo
 * network's web/demo-net-worker.ts), as web/app/network.ts drives a tailnet's client: it speaks `ToLocal`, and posts
 * the tailnet clients' state, network map, `detached` and errors. `noExits`: the error for an exit node asked of it.
 */
export function framedClient(
  worker: Worker,
  config: { url: string; ip: MessagePort },
  onEvent: (m: FromTailscale) => void,
  noExits: () => Error,
): Tailscale {
  let state = '';
  let netmap: NetMap | undefined;
  const h = workerHandle<FromTailscale, NetMap>(worker, (m) => {
    if (m.type === 'state') {
      state = m.state;
      if (state === 'Running') h.ran(netmap ?? localNetmap(undefined));
    } else if (m.type === 'netmap') netmap = m.netmap;
    onEvent(m);
  });
  worker.postMessage({ type: 'start', url: config.url, ip: config.ip } satisfies ToLocal, [config.ip]);
  const refuse = () => Promise.reject(noExits());
  return {
    state: () => state,
    netmap: () => netmap,
    loginURL: () => undefined,
    running: h.running,
    timings: h.timings,
    attach: (ip) => worker.postMessage({ type: 'attach', ip } satisfies ToLocal, [ip]),
    setPrimary: () => {}, // the far end's DHCP always routes everything through it (network.ts `primaryOf` ranks it first)
    detach: h.detach,
    setExitNode: refuse,
    setAcceptRoutes: () => {},
    logout: () => Promise.resolve(),
    close: () => worker.terminate(),
  };
}
