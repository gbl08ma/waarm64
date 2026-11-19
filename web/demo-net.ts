// The demo network's client (docs/networking/demo-network.md; the connection kind `demo`, docs/networking/adapters.md
// §1): a public server (github.com/gbl08ma/waarm64-demonet, a fork of the local helper) gives each WebSocket a network
// of its own, whose way out reaches only its owner's allowlist. As the local helper's client does (web/local-net.ts),
// this moves the card's Ethernet frames between its frame port and the socket in QEMU's framing; and it speaks the
// server's control channel (`waarm64-demonet.v1`, the fork's PROTOCOL.md): text messages of JSON, codes and numbers
// only, which it keeps as the adapter's status (the lane, the day's budget, the destinations refused, a restart
// announced) and passes on as notices for the message bar; and it reconnects by the close codes' rules (4012 when the
// guest next sends a frame; 4008, 4011, 4013 after `reconnect_after` and a random delay; back off while the server is
// unreachable). No pairing, no token, no Local Network Access (a public `wss://` URL). DOM-free, its socket and
// timers given (`DemoEnv`), so tests/demo-net.test.ts runs it against a fake server in Node; web/demo-net-worker.ts
// runs it in a worker of its own.
import { dhcpAck, frameMessage, framedClient, framesOf } from './local-net.ts';
import { msg, MsgError, type Msg } from './msg.ts';
import type { FromTailscale, NetMap, Tailscale } from './tailscale.ts';

/** The subprotocol, checked by both ends (waarm64-demonet `Subprotocol`). */
export const DEMO_SUBPROTOCOL = 'waarm64-demonet.v1';

/**
 * The demo network's server, where a `demo` connection made without a URL goes. A placeholder until the user hosts
 * the fork (DEMO-HANDOVER.md: the user's to confirm).
 */
export const DEMO_URL = 'wss://demonet.tny.im/';

/** The most a message may hold either way (waarm64-demonet `MaxMessage`): past it the server closes with 1009. */
export const DEMO_MAX_MESSAGE = 1 << 20;

/** The frames held while a socket opens (until its `hello`); past it they're dropped, as a link drops them. */
export const DEMO_HOLD = 256 << 10;

/** The random delay added to a server's `reconnect_after` (PROTOCOL.md "closing": up to 30 s). */
export const DEMO_JITTER_MS = 30_000;

/** Backing off while the server is unreachable or dropped the socket: from `BACKOFF_MS`, doubling, to `BACKOFF_MAX_MS`. */
export const BACKOFF_MS = 1000;
export const BACKOFF_MAX_MS = 120_000;
/** The least wait after a refusal for being too many (4008 without a time, 4009): trying sooner only adds to it. */
export const CROWDED_MS = 30_000;

/** How often the day's budget is asked for (`budget?`) while the guest's traffic moves it. */
export const BUDGET_ASK_MS = 60_000;

/**
 * A `wss://` URL of the demo network's server (or `ws://` on this computer, for testing a server of one's own), or an
 * error to show. Empty: the default (`DEMO_URL`).
 */
export function parseDemoURL(input: string): { url: string } | { error: Msg } {
  const s = input.trim();
  if (!s) return { url: DEMO_URL };
  let u: URL;
  try {
    u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `wss://${s}`);
  } catch {
    return { error: msg('network:demo-net.notURL', { input: s }) };
  }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  if (u.protocol !== 'wss:' && !(u.protocol === 'ws:' && local)) return { error: msg('network:demo-net.notWss') };
  return { url: u.href };
}

/** A destination the server refused (PROTOCOL.md "refused"): why, and what it names. */
export type DemoRefusal = { reason: string; name?: string; address?: string; port?: number };

/** The day's bytes for this visitor (PROTOCOL.md "budget"): `resets` an RFC 3339 time. */
export type DemoBudget = { used: number; limit: number; resets?: string };

/**
 * Why the client waits before it tries again: `unreachable`, the socket never opened; `lost`, it closed without the
 * server saying why; else the server's close reason (`guests`, `site`, `connections`: 4008; `full`: 4009; `bytes`:
 * 4010; `maintenance`: 4011; `session`: 4013).
 */
export type DemoWhy = 'unreachable' | 'lost' | 'guests' | 'site' | 'connections' | 'full' | 'bytes' | 'maintenance' | 'session';

/** What the adapter's status shows of the demo network: what the client does, and what the server last said. */
export type DemoStatus = {
  /** `idle`: the server closed an idle network (4012) and the client opens another when the guest next sends. */
  phase: 'connecting' | 'connected' | 'idle' | 'waiting';
  /** It was connected before (a reconnect, not the first connect). */
  again: boolean;
  /** Waiting: why, and when it tries again (ms since the epoch, `Date.now()`'s); `resets`, the budget's (4010). */
  wait?: { why: DemoWhy; at: number; resets?: string };
  /** The lane: `fast` (the allowlist at full speed), `none` (the day's budget spent: nothing leaves). */
  lane?: 'fast' | 'none';
  /** The lane `none`'s end, when the budget resets. */
  laneResets?: string;
  budget?: DemoBudget;
  /** The destinations refused on this network: how many in all, and the last few (oldest first). */
  refused?: { total: number; last: DemoRefusal[] };
  /** A restart announced by the server's owner: when it goes down, and when it's expected back. */
  notice?: { at: string; backAt?: string };
  /** The guest's gateway and the URL it can fetch the same numbers from (`http://<gateway>/status`). */
  gateway?: string;
  status?: string;
};

/** What the message bar says of the demo network (web/app/demo-view.ts words it). */
export type DemoNotice =
  /** The day's budget passed 80 % or 100 %. */
  | { kind: 'budget'; threshold: number; used: number; limit: number; resets?: string }
  /** The lane changed: `none` when the budget is spent, `fast` when it's back. */
  | { kind: 'lane'; lane: 'fast' | 'none'; resets?: string }
  /** The server's owner announced a restart. */
  | { kind: 'restart'; at: string; backAt?: string }
  /** The server refused a new socket: today's budget is spent (4010, no lane message before it). */
  | { kind: 'spent'; resets?: string }
  /** A connected socket closed without the server saying why (the server or the way to it went down). */
  | { kind: 'lost' };

/** Why the server closed for good, as the page says it (no reconnect follows), for a close code; undefined: another. */
export function demoCloseError(code: number, reason = ''): MsgError | undefined {
  const cause = reason ? { cause: new Error(reason) } : undefined;
  switch (code) {
    case 4001: return new MsgError('network:demo-net.versions');
    case 4003: return new MsgError('network:demo-net.origin');
    case 1002: case 1009: return new MsgError('network:demo-net.protocol', { code }, cause);
  }
  return undefined;
}

/** A socket as the client uses it (the browser's `WebSocket`; the tests' fake). */
export type SocketLike = {
  binaryType: string;
  readonly readyState: number;
  readonly protocol: string;
  send(data: string | Uint8Array<ArrayBuffer>): void;
  close(code?: number, reason?: string): void;
  onopen: ((e: unknown) => void) | null;
  onmessage: ((e: { data: unknown }) => void) | null;
  onclose: ((e: { code: number; reason: string }) => void) | null;
  onerror: ((e: unknown) => void) | null;
};

/** What the client runs on: the page's globals, or the tests' fakes. */
export type DemoEnv = {
  socket: (url: string, protocol: string) => SocketLike;
  setTimeout: (f: () => void, ms: number) => unknown;
  clearTimeout: (t: unknown) => void;
  /** Wall-clock time in ms (`Date.now()`: compared with the server's RFC 3339 times). */
  now: () => number;
  random: () => number;
};

export const browserEnv = (): DemoEnv => ({
  socket: (url, protocol) => new WebSocket(url, protocol) as unknown as SocketLike,
  setTimeout: (f, ms) => setTimeout(f, ms),
  clearTimeout: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
  now: () => Date.now(),
  random: () => Math.random(),
});

/** The card's end: one Ethernet frame per message (a `MessagePort`). */
export type FramePort = {
  onmessage: ((e: MessageEvent) => void) | null;
  postMessage(data: ArrayBuffer, transfer: Transferable[]): void;
};

export type DemoState = DemoStatus['phase'] | 'closed';

export type DemoNet = {
  state(): DemoState;
  status(): DemoStatus;
  /** Why it closed for good (undefined until then). */
  error(): Error | undefined;
  /** The guest's address and MTU, from the server's last DHCP acknowledgment. */
  lease(): { address: string; mtu?: number } | undefined;
  stats(): { rxFrames: number; txFrames: number; rxBytes: number; txBytes: number; sockets: number };
  /** The card's frames to another port (the machine restarted): the socket, and so the guest's network, stay. */
  setFrames(frames: FramePort): void;
  close(): void;
};

/** What the client tells: anything in `state()`, `status()`, `lease()` changed; a notice for the message bar. */
export type DemoHooks = { change?: () => void; notice?: (n: DemoNotice) => void };

const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const budgetOf = (v: unknown): DemoBudget | undefined => {
  const b = v as Record<string, unknown> | null;
  const used = num(b?.used);
  const limit = num(b?.limit);
  return used === undefined || limit === undefined ? undefined : { used, limit, ...(str(b?.resets) ? { resets: str(b?.resets) } : {}) };
};
const refusalOf = (v: unknown): DemoRefusal => {
  const r = v as Record<string, unknown> | null;
  const name = str(r?.name);
  const address = str(r?.address);
  const port = num(r?.port);
  return { reason: str(r?.reason) ?? '', ...(name ? { name } : {}), ...(address ? { address } : {}), ...(port !== undefined ? { port } : {}) };
};

/**
 * Connects the card behind `frames` to the demo network's server at `url`, and keeps it connected by the close codes'
 * rules until `close()`, or until the server closes for good (another version, another origin, a protocol error).
 */
export function startDemoNet(url: string, frames: FramePort, hooks: DemoHooks = {}, env: DemoEnv = browserEnv()): DemoNet {
  const change = () => hooks.change?.();
  /** The last notice given: a lost socket's "trying again" is followed by the spent budget's, if that's what it meets. */
  let said: DemoNotice['kind'] | undefined;
  const notice = (n: DemoNotice) => {
    said = n.kind;
    hooks.notice?.(n);
  };
  const stats = { rxFrames: 0, txFrames: 0, rxBytes: 0, txBytes: 0, sockets: 0 };
  const status: DemoStatus = { phase: 'connecting', again: false };
  let port = frames;
  let ws: SocketLike | undefined;
  let error: Error | undefined;
  let stopped = false;
  let lease: { address: string; mtu?: number } | undefined;
  /** The guest's MAC, from the first unicast source of its frames (its DHCP acknowledgments are the ones for it). */
  let mac: Uint8Array | undefined;
  /** This socket's: it opened, its `hello` came, its `closing` message (the last before the server's close). */
  let opened = false;
  let hello = false;
  let closing: Record<string, unknown> | undefined;
  /** The backoff's step (0 after a `hello`). */
  let attempt = 0;
  let timer: unknown;
  let asker: unknown;
  let asked = -1;
  /** The guest's frames: a batch for the timer's turn, and those held while a socket opens. */
  let batch: Uint8Array[] = [];
  let batchBytes = 0;
  let held: Uint8Array[] = [];
  let heldBytes = 0;

  const setPhase = (p: DemoStatus['phase']) => {
    status.phase = p;
    if (p !== 'waiting') delete status.wait;
  };
  const clear = () => {
    if (timer !== undefined) env.clearTimeout(timer);
    timer = undefined;
  };

  const flush = () => {
    const b = batch;
    batch = [];
    batchBytes = 0;
    if (!ws || !hello || ws.readyState !== 1 || !b.length) return;
    ws.send(frameMessage(b));
  };
  const send = (f: Uint8Array) => {
    if (batchBytes + 4 + f.length > DEMO_MAX_MESSAGE) flush();
    if (!batch.length) env.setTimeout(flush, 0);
    batch.push(f);
    batchBytes += 4 + f.length;
  };
  const onFrame = (e: MessageEvent) => {
    const f = new Uint8Array(e.data as ArrayBuffer);
    if (!mac && f.length >= 14 && !(f[6] & 1)) mac = f.slice(6, 12);
    stats.txFrames++;
    stats.txBytes += f.length;
    if (status.phase === 'connected') return send(f);
    if (status.phase === 'idle') open(); // 4012: the guest woke; this frame and those after it wait for the `hello`
    if (status.phase === 'connecting' && heldBytes + f.length <= DEMO_HOLD) {
      held.push(f);
      heldBytes += f.length;
    }
  };
  port.onmessage = onFrame;

  /** Asks for the day's budget, every `BUDGET_ASK_MS` while frames move it. */
  const ask = () => {
    asker = env.setTimeout(() => {
      const moved = stats.rxBytes + stats.txBytes;
      if (ws && hello && moved !== asked) {
        asked = moved;
        ws.send(JSON.stringify({ type: 'budget?' }));
      }
      ask();
    }, BUDGET_ASK_MS);
  };

  function open() {
    clear();
    if (stopped) return;
    setPhase('connecting');
    [opened, hello, closing] = [false, false, undefined];
    let s: SocketLike;
    try {
      s = env.socket(url, DEMO_SUBPROTOCOL);
    } catch (e) { // a URL the browser refuses outright
      return end(new MsgError('network:demo-net.unreached', undefined, { cause: e }));
    }
    ws = s;
    stats.sockets++;
    s.binaryType = 'arraybuffer';
    s.onopen = () => {
      if (s !== ws) return;
      if (s.protocol !== DEMO_SUBPROTOCOL) {
        error = demoCloseError(4001);
        s.close();
        return;
      }
      opened = true;
    };
    s.onmessage = (e) => {
      if (s !== ws) return;
      if (typeof e.data === 'string') return control(e.data);
      const got = framesOf(new Uint8Array(e.data as ArrayBuffer));
      if (!got) {
        error = new MsgError('network:demo-net.notFrames');
        s.close();
        return;
      }
      for (const f of got) {
        stats.rxFrames++;
        stats.rxBytes += f.length;
        const ack = mac && dhcpAck(f, mac);
        if (ack) {
          lease = ack;
          change();
        }
        port.postMessage(f.buffer as ArrayBuffer, [f.buffer]);
      }
    };
    s.onclose = (e) => {
      if (s === ws) closed(e.code, e.reason);
    };
    s.onerror = () => {};
  }

  /** A control message: kept as the status, said as a notice where the message bar shows it. */
  function control(text: string) {
    let m: Record<string, unknown>;
    try {
      m = JSON.parse(text) as Record<string, unknown>;
    } catch {
      return; // not ours to break the socket over: within v1, ignore what isn't understood
    }
    if (typeof m !== 'object' || m === null) return; // eslint-disable-line @typescript-eslint/no-unnecessary-condition -- JSON can be anything
    switch (m.type) {
      case 'hello': {
        hello = true;
        attempt = 0;
        setPhase('connected');
        status.lane = m.lane === 'none' ? 'none' : 'fast';
        const [gateway, st] = [str(m.gateway), str(m.status)];
        if (gateway) status.gateway = gateway;
        if (st) status.status = st;
        const h = held;
        [held, heldBytes] = [[], 0];
        for (const f of h) send(f);
        if (asker === undefined) ask();
        break;
      }
      case 'budget': {
        const fast = budgetOf(m.fast);
        if (!fast) return;
        status.budget = fast;
        const threshold = num(m.threshold);
        if (m.reason === 'threshold' && threshold !== undefined) notice({ kind: 'budget', threshold, ...fast });
        break;
      }
      case 'lane': {
        const lane = m.lane === 'none' ? 'none' : 'fast';
        const resets = str(m.resets);
        if (lane === status.lane) return;
        status.lane = lane;
        if (resets && lane === 'none') status.laneResets = resets;
        else delete status.laneResets;
        notice({ kind: 'lane', lane, ...(resets ? { resets } : {}) });
        break;
      }
      case 'refused': {
        const total = num(m.total);
        if (total === undefined) return;
        status.refused = { total, last: Array.isArray(m.last) ? m.last.slice(-4).map(refusalOf) : [] };
        break;
      }
      case 'notice': {
        const at = str(m.at);
        if (m.notice === 'restart-at' && at) {
          const backAt = str(m.back_at);
          const was = status.notice;
          status.notice = { at, ...(backAt ? { backAt } : {}) };
          if (was?.at !== at || was.backAt !== backAt) notice({ kind: 'restart', ...status.notice });
        } else if (m.notice === 'none') delete status.notice;
        else return; // another notice: none to show within v1's codes
        break;
      }
      case 'closing':
        closing = m;
        return;
      default:
        return; // a type of a later v1: ignored
    }
    change();
  }

  /** Waits `ms`, then tries again, saying why (`resets`: the budget's, for 4010). */
  function wait(why: DemoWhy, ms: number, resets?: string) {
    setPhase('waiting');
    status.wait = { why, at: env.now() + ms, ...(resets ? { resets } : {}) };
    timer = env.setTimeout(open, ms);
    change();
  }
  /** The next backoff's delay: doubling from `BACKOFF_MS`, at most `BACKOFF_MAX_MS`, the second half of it random. */
  const backoff = (least = 0) => {
    const full = Math.min(BACKOFF_MAX_MS, BACKOFF_MS * 2 ** attempt++);
    return Math.max(least, full / 2 + (full / 2) * env.random());
  };
  /** Until `at` (an RFC 3339 time) and a random delay, as the server asks; a backoff when it gave none. */
  const until = (at: unknown, least = 0) => {
    const t = Date.parse(str(at) ?? '');
    return Number.isFinite(t) ? Math.max(0, t - env.now()) + DEMO_JITTER_MS * env.random() : backoff(least);
  };

  function end(e: Error) {
    error = e;
    ws = undefined;
    clear();
    if (asker !== undefined) env.clearTimeout(asker);
    asker = undefined;
    port.onmessage = null;
    change();
  }

  function closed(code: number, reason: string) {
    ws = undefined;
    [batch, batchBytes, held, heldBytes] = [[], 0, [], 0];
    if (stopped) return;
    const was = hello;
    if (was) status.again = true;
    const final = error ?? demoCloseError(code, reason);
    if (final) return end(final);
    // The closing message before the close says the same as the code, with its numbers.
    const c = closing && num(closing.code) === code ? closing : undefined;
    switch (code) {
      case 4012:
        setPhase('idle');
        return change();
      case 4008: {
        const why = c?.reason === 'connections' || c?.reason === 'site' ? c.reason : 'guests';
        return wait(why, until(c?.reconnect_after, CROWDED_MS));
      }
      case 4009:
        return wait('full', backoff(CROWDED_MS));
      case 4010: {
        const resets = str(c?.resets);
        // Said unless the lane's message said it, and nothing said otherwise since (a socket lost past the grace, whose
        // reconnect meets this: the message bar's "trying again" would stay until the reset).
        if (status.lane !== 'none' || said === 'lost') notice({ kind: 'spent', ...(resets ? { resets } : {}) });
        status.lane = 'none';
        if (resets) status.laneResets = resets;
        return wait('bytes', until(resets, CROWDED_MS), resets);
      }
      case 4011:
        return wait('maintenance', until(c?.reconnect_after, CROWDED_MS));
      case 4013:
        return wait('session', until(c?.reconnect_after));
    }
    if (!opened) return wait('unreachable', backoff());
    if (was) {
      notice({ kind: 'lost' });
      attempt = 0;
    }
    wait('lost', backoff());
  }

  open();
  return {
    state: () => (error ? 'closed' : status.phase),
    status: () => structuredClone(status),
    error: () => error,
    lease: () => lease,
    stats: () => ({ ...stats }),
    setFrames(f) {
      port.onmessage = null;
      port = f;
      if (!error) port.onmessage = onFrame;
    },
    close() {
      stopped = true;
      clear();
      if (asker !== undefined) env.clearTimeout(asker);
      asker = undefined;
      port.onmessage = null;
      ws?.close(1000);
      ws = undefined;
    },
  };
}

/** A demo connection's network map: the guest's address once the server leased it, and the status (`demo`). */
export const demoNetmap = (lease: { address: string; mtu?: number } | undefined, demo: DemoStatus): NetMap => ({
  name: '', addresses: lease ? [`${lease.address}/32`] : [], peers: [], mtu: lease?.mtu ?? 1500, dns: null, domains: null, exitNode: '', via: 'demo', demo,
});

/**
 * The client of a `demo` connection (web/app/network.ts drives it as it drives the local helper's): its worker
 * (web/demo-net-worker.ts) puts the card on a frame port to the server, and posts the status in its network map and
 * the message bar's notices (`{type: 'notice'}`). State `Running` while connected or idle.
 */
export function startDemo(config: { url: string; ip: MessagePort }, onEvent: (m: FromTailscale) => void = () => {}): Tailscale {
  const worker = new Worker(new URL('./demo-net-worker.ts', import.meta.url), { type: 'module' });
  return framedClient(worker, config, onEvent, () => new MsgError('network:demo-net.noExitNodes'));
}
