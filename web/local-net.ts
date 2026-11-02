// The local network helper's client (docs/plans/networking-local.md, the connection kind `local`: docs/network-adapters.md).
// The helper (net/webpc-net) runs on the user's computer and serves the guest DHCP, DNS and a gateway onto its own
// sockets, so this only moves Ethernet frames: between a card's frame port (web/net.ts `portAdapter`: one frame per
// message, the page's gateway bypassed: web/gateway.ts `FramePath`) and a WebSocket on loopback. On the socket each
// binary message is one or more whole frames, each after its 4-byte big-endian length (QEMU's stream framing, what the
// helper's switch speaks); the frames that come before a timer's turn go out as one message (`setTimeout(0)`, measured:
// twice the upload of a microtask's batches at the same round trip, bench/net/REPORT.md "The local helper"). It runs in
// a worker of its own (web/local-net-worker.ts: off the page's main thread), behind the tailnet clients' handle
// (`startLocal`), so the page's network drives it as it drives them.
import type { FromTailscale, NetMap, Tailscale } from './tailscale.ts';

/** The framing's name and version, checked by both ends (net/webpc-net `Subprotocol`). */
export const LOCAL_SUBPROTOCOL = 'webpc-net.v1';

/** Why the helper closed the socket (net/webpc-net's close codes), as the page says it. */
export const LOCAL_CLOSE: Record<number, string> = {
  4001: 'the page and the helper are different versions',
  4003: "the helper doesn't accept this page's address (run it with --origin)",
  4004: "the link's token isn't this helper's: pair again with the link it prints",
};

/** Why a socket that never opened didn't (a refused prompt and a stopped helper both fail at once on loopback). */
export const UNREACHED = "couldn't reach the helper: is webpc-net running on this computer?";
export const REFUSED = "this site isn't allowed to reach this computer: allow \u201cLocal network access\u201d in the site's settings (the icon left of the address, then Site settings), then Connect";

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
 * prints (`https://vm.tny.im/#net=ws://…`) gives its `net`.
 */
export function parseLocalURL(input: string): { url: string } | { error: string } {
  let s = input.trim();
  const at = s.indexOf('#net=');
  if (at >= 0) s = decodeURIComponent(s.slice(at + 5).split('&')[0]);
  if (!s) return { error: 'Paste the link webpc-net prints (https://vm.tny.im/#net=ws://127.0.0.1:…).' };
  let u: URL;
  try {
    u = new URL(s.trim());
  } catch {
    return { error: `“${s}” isn't the helper's link (ws://127.0.0.1:<port>/<token>)` };
  }
  if (u.protocol !== 'ws:' || !['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname) || u.pathname.length < 2) return { error: `“${s}” isn't the helper's link (ws://127.0.0.1:<port>/<token>)` };
  return { url: u.href };
}

/** The address and MTU a DHCP acknowledgment in `f` (an Ethernet frame to the guest) gives, if it is one. */
export function dhcpAck(f: Uint8Array): { address: string; mtu?: number } | undefined {
  if (f.length < 14 + 20 + 8 + 240 || f[12] !== 8 || f[13] !== 0 || f[14] >> 4 !== 4 || f[23] !== 17) return undefined;
  const udp = 14 + (f[14] & 15) * 4;
  const d = udp + 8;
  if (((f[udp] << 8) | f[udp + 1]) !== 67 || ((f[udp + 2] << 8) | f[udp + 3]) !== 68 || d + 240 > f.length || f[d] !== 2) return undefined;
  if (f[d + 236] !== 0x63 || f[d + 237] !== 0x82 || f[d + 238] !== 0x53 || f[d + 239] !== 0x63) return undefined;
  let ack = false;
  let mtu: number | undefined;
  for (let k = d + 240; k < f.length && f[k] !== 255;) {
    if (f[k] === 0) { k++; continue; }
    if (k + 1 >= f.length) break;
    const [code, len] = [f[k], f[k + 1]];
    if (code === 53 && len >= 1) ack = f[k + 2] === 5;
    if (code === 26 && len === 2) mtu = (f[k + 2] << 8) | f[k + 3];
    k += 2 + len;
  }
  return ack ? { address: Array.from(f.subarray(d + 16, d + 20)).join('.'), mtu } : undefined;
}

export type LocalState = 'connecting' | 'connected' | 'closed';

export type LocalNet = {
  state(): LocalState;
  /** Why it closed, as the page says it (undefined while open). */
  error(): string | undefined;
  /** Frames and bytes each way (the tests' and benchmarks'). */
  stats(): { rxFrames: number; txFrames: number; rxBytes: number; txBytes: number; rxMessages: number; txMessages: number };
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
  let error: string | undefined;
  const stats = { rxFrames: 0, txFrames: 0, rxBytes: 0, txBytes: 0, rxMessages: 0, txMessages: 0 };
  const ws = new WebSocket(url, LOCAL_SUBPROTOCOL);
  ws.binaryType = 'arraybuffer';
  let pending: Uint8Array[] = [];
  let lease: { address: string; mtu?: number } | undefined;
  const flush = () => {
    const b = pending;
    pending = [];
    if (ws.readyState !== WebSocket.OPEN || !b.length) return;
    stats.txMessages++;
    ws.send(frameMessage(b));
  };
  frames.onmessage = (e: MessageEvent) => {
    const f = new Uint8Array(e.data as ArrayBuffer);
    stats.txFrames++;
    stats.txBytes += f.length;
    if (!pending.length) setTimeout(flush, 0);
    pending.push(f);
  };
  ws.onopen = () => {
    if (ws.protocol !== LOCAL_SUBPROTOCOL) {
      error = LOCAL_CLOSE[4001];
      ws.close();
      return;
    }
    state = 'connected';
    onChange();
  };
  ws.onmessage = (e: MessageEvent) => {
    const got = framesOf(new Uint8Array(e.data as ArrayBuffer));
    if (!got) {
      error = "the helper sent a message that isn't whole frames";
      ws.close();
      return;
    }
    stats.rxMessages++;
    for (const f of got) {
      stats.rxFrames++;
      stats.rxBytes += f.length;
      const ack = dhcpAck(f); // its first checks (the length, IPv4, UDP) turn other frames away at once
      if (ack) {
        lease = ack;
        onChange();
      }
      frames.postMessage(f.buffer, [f.buffer]);
    }
  };
  ws.onclose = (e: CloseEvent) => {
    // A socket that never opened on loopback: the helper isn't running, or the browser refuses this site loopback.
    const never = state === 'connecting';
    error ??= LOCAL_CLOSE[e.code] ?? (never ? UNREACHED : `the helper closed the connection${e.reason ? `: ${e.reason}` : ''}`);
    state = 'closed';
    if (never && error === UNREACHED) void loopbackRefused().then((refused) => { if (refused) error = REFUSED; onChange(); });
    else onChange();
  };
  return {
    state: () => state,
    error: () => (state === 'closed' ? error : undefined),
    stats: () => ({ ...stats }),
    lease: () => lease,
    close() {
      frames.onmessage = null;
      ws.close();
    },
  };
}

/** Messages to web/local-net-worker.ts. */
export type ToLocal = { type: 'start'; url: string; ip: MessagePort } | { type: 'attach'; ip: MessagePort } | { type: 'detach' };

/** A local connection's network map: the guest's address, once the helper leased it. */
export const localNetmap = (lease: { address: string; mtu?: number } | undefined): NetMap => ({ name: '', addresses: lease ? [`${lease.address}/32`] : [], peers: [], mtu: lease?.mtu ?? 1500, dns: null, domains: null, exitNode: '', via: 'local' });

/**
 * The client of a `local` connection (web/app/network.ts drives it as it drives a tailnet's): its worker takes the
 * card's IP port and puts the card on a frame port to the helper (`FramePath`), and hands it back with the card
 * still on frames (`{type: 'frames', port: null}`), so a reconnect to the same helper doesn't flap the link.
 * State `Running` once the socket is open; an error when it closes (the reason as the page says it).
 */
export function startLocal(config: { url: string; ip: MessagePort }, onEvent: (m: FromTailscale) => void = () => {}): Tailscale {
  const worker = new Worker(new URL('./local-net-worker.ts', import.meta.url), { type: 'module' });
  let detached: ((ip?: MessagePort) => void) | undefined;
  let state = '';
  let netmap: NetMap | undefined;
  const t0 = performance.now();
  const timings: { loadMs?: number; runningMs?: number } = {};
  const running = new Promise<NetMap>((resolve, reject) => {
    worker.onerror = (e) => reject(new Error(e.message));
    worker.onmessage = (e: MessageEvent<FromTailscale>) => {
      const m = e.data;
      if (m.type === 'state') {
        state = m.state;
        if (state === 'Running') { timings.runningMs ??= performance.now() - t0; resolve(netmap ?? localNetmap(undefined)); }
      } else if (m.type === 'netmap') netmap = m.netmap;
      else if (m.type === 'detached') detached?.(m.ip);
      else if (m.type === 'error') reject(new Error(m.error));
      onEvent(m);
    };
  });
  running.catch(() => {});
  worker.postMessage({ type: 'start', url: config.url, ip: config.ip } satisfies ToLocal, [config.ip]);
  const refuse = () => Promise.reject(new Error("the helper on this computer has no exit nodes"));
  return {
    state: () => state, netmap: () => netmap, loginURL: () => undefined, running, timings: () => timings,
    attach: (ip) => worker.postMessage({ type: 'attach', ip } satisfies ToLocal, [ip]),
    setPrimary: () => {}, // the helper's DHCP always routes everything through it (network.ts `primaryOf` ranks it first)
    detach: () => new Promise((resolve) => {
      const t = setTimeout(() => resolve(undefined), 3000);
      detached = (ip) => { clearTimeout(t); resolve(ip); };
      worker.postMessage({ type: 'detach' } satisfies ToLocal);
    }),
    setExitNode: refuse,
    setAcceptRoutes: () => {},
    logout: () => Promise.resolve(),
    close: () => worker.terminate(),
  };
}
