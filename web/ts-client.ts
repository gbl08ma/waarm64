// The tailnet client's I/O (docs/tailnet.md): the module
// (net/ts, target/net/ts.wasm) holds the protocols' state and never waits;
// this carries out what it asks (WebSockets to DERP relays, fetches, timers)
// and feeds it what comes back, the guest's packets and the time. It runs in
// a worker or in Node alike: WebSocket, fetch and crypto are all it needs.
import type { Lease } from './gateway.ts';
import { MsgError } from './msg.ts';
import { wasi } from './ts-wasi.ts';
import type { NetMap } from './tailscale.ts';

type Exports = {
  memory: WebAssembly.Memory;
  _initialize(): void;
  ts_alloc(len: number): number;
  ts_buf(): number;
  ts_new(ptr: number, len: number): number;
  ts_private_key(h: number): number;
  ts_poll(h: number): number;
  ts_ws_message(h: number, conn: number, ptr: number, len: number): void;
  ts_ws_closed(h: number, conn: number): void;
  ts_fetched(h: number, id: number, ok: number, ptr: number, len: number): void;
  ts_guest(h: number, ptr: number, len: number): void;
  ts_tick(h: number): void;
  ts_deadline(h: number): number;
  ts_close(h: number): void;
  ts_free(h: number): void;
  ts_logout(h: number): void;
  ts_exit_node(h: number, ptr: number, len: number): void;
  ts_accept_routes(h: number, on: number): void;
  ts_rtc_signal(h: number, rtc: number, ptr: number, len: number): void;
  ts_rtc_open(h: number, rtc: number): void;
  ts_rtc_message(h: number, rtc: number, ptr: number, len: number): void;
  ts_rtc_closed(h: number, rtc: number): void;
};

/** A room's member (net/ts/src/room.rs, docs/tailnet.md "Rooms"). */
/** The most messages a WebSocket holds before it opens (a room's lookups while a Nostr relay connects, say). */
const SOCKET_QUEUE = 256;

export type RoomConfig = {
  room: {
    /** The room's link (`webpc-room:<id>?nostr=…&derp=…`, net/ts/src/room/link.rs), or a bare ID (the defaults). */
    link: string;
    /** The home region: an index into the link's DERP regions (default 0). */
    home?: number;
    /** Node keys known by hand (`nodekey:` and 64 hex digits): lookups to them are sealed to them. */
    known?: string[];
    /** No WebRTC: everything through DERP, so no peer learns this machine's IP address. */
    relayOnly?: boolean;
    /** Members may open connections to the guest (default: yes). */
    incoming?: boolean;
    /** The wall clock at the start, Unix seconds (default: the system's): a benchmark's shifted clock. */
    unixTime?: number;
  };
  derpMapURL?: string;
  /** The node's private key, 64 hex digits. */
  key?: string;
};

/** A tailcat server to connect to (`tailcat serve exit-node` printed `addr`), clients to let in (`serve`), or both. */
export type TailcatConfig = {
  addr?: string;
  /** The VM as a tailcat server (docs/tailnet.md "tailcat"): the address's pre-shared key (64 hex digits) and,
   * without `addr`, the relay: one's own derper (`host[:port]`), or a region of the DERP map by ID (0: its first). */
  serve?: { psk: string; relay?: string; region?: number; allow?: string[] };
  /** The DERP map for an address that names only a region (default: tailcat's public one). */
  derpMapURL?: string;
  /** The node's private key, 64 hex digits, to be the same client again (a server may `--allow` only it). */
  key?: string;
  /** Resolvers for the guest's lease, reached through the server (default: Cloudflare's). */
  dns4?: number[][];
  dns6?: number[][];
};

/** A Tailscale node (docs/tailnet.md "Tailscale"): its control server and the kept node's store. */
export type TailnetConfig = {
  control: { url: string; authKey?: string; hostname?: string; ephemeral?: boolean };
  /** The node's store as the Go client keeps it (web/tailscale-state.ts): `<StateKey>` → hex of the bytes. */
  state?: Record<string, string>;
  /** A peer's stable ID to send the guest's internet traffic through ('' for none). */
  exitNode?: string;
  /** Install peers' subnet routes (default: yes, as Tailscale's own apps do). */
  acceptRoutes?: boolean;
};

/** Why the client failed (`Failed`) or refused something: a stable code the page words (`failureOf`), and a developer's detail. */
export type TsFailure = { code?: string; detail?: string };

export type TsEvent =
  | ({ type: 'state'; state: 'FetchingMap' | 'Connecting' | 'Meowing' | 'Handshaking' | 'Running' | 'Failed' } & TsFailure)
  | { type: 'lease'; lease: Lease }
  /** This node; a room's member also has the room's tag, its own name (`<key>.<tag>.p2p.internal`) and the link. */
  | { type: 'self'; key: string; address6: number[]; tag?: string; name?: string; link?: string }
  | { type: 'serving'; addr: string }
  | { type: 'client' | 'client-gone'; key: string; address6: number[] }
  /** A room: a peer whose data decrypted, and the path a peer's packets take. */
  | { type: 'peer'; key: string; address6: number[]; name?: string }
  /** A peer confirmed earlier is forgotten (idle, lost, or a trial that ran out). */
  | { type: 'peer-gone'; key: string; address6: number[]; name?: string }
  | { type: 'path'; key: string; address6: number[]; path: 'direct' | 'relay' }
  | { type: 'log'; msg: string }
  /** Tailscale: Go's state names (`Starting`, `NeedsLogin`, `Running`), or `Failed` with why. */
  | ({ type: 'state'; state: 'Starting' | 'NeedsLogin' | 'Running' } & TsFailure)
  | { type: 'netmap'; netmap: NetMap }
  /** Write this entry of the node's store (hex, as the Go client's store keeps it). */
  | { type: 'store'; key: string; value: string }
  /** The URL to visit to log the node in. */
  | { type: 'login'; url: string }
  | { type: 'loggedout' }
  /** The answer to `setExitNode`: no `code` when it took, else why not (`no-exit-node`: no peer `id` offers to be one). */
  | ({ type: 'exitnode'; id?: string } & TsFailure);

export type TsHandlers = {
  /** An IP packet for the guest (the array is the client's: keep it). */
  packet(p: Uint8Array): void;
  event(e: TsEvent): void;
  /** A room's WebRTC connections, which the page holds (web/room.ts): it hands each one's data channel back with
   * `rtcChannel` and its descriptions and candidates with `rtcSignal`. */
  rtc?: RtcHandlers;
};

export type RtcHandlers = {
  /** Set up connection `rtc` with its negotiated data channel, making the offer when `offer`. */
  open(rtc: number, offer: boolean): void;
  /** The peer's description or candidate (JSON) for `rtc`. */
  signal(rtc: number, json: string): void;
  close(rtc: number): void;
};

/**
 * The error a client's `Failed` state stands for (net/ts's codes, docs/tailnet.md "The ABI"): the words the page has
 * for its code, or, for a code whose only words are technical, its detail (a developer's, shown as details).
 */
export function failureOf(f: TsFailure): Error {
  const detail = f.detail ? new Error(f.detail) : undefined;
  switch (f.code) {
    case 'no-browser-relay': return new MsgError('network:ts-client.noBrowserRelay');
    case 'region-no-browser-relay': return new MsgError('network:ts-client.regionNoBrowserRelay');
    case 'derp-map': return new MsgError('network:ts-client.derpMap', { url: f.detail ?? '' });
    case 'server-silent': return new MsgError('network:ts-client.serverSilent');
    case 'handshake': return new MsgError('network:ts-client.handshake');
    case 'control-refused': return new MsgError('network:ts-client.controlRefused', undefined, { cause: detail });
    case 'not-authorized': return new MsgError('network:ts-client.notAuthorized');
    case 'tailnet-lock': return new MsgError('network:ts-client.tailnetLock');
    // `relay`, `derp-map-invalid`, `control-answer` and codes newer than this page: the detail says it.
    default: return detail ?? new Error(f.code ?? '');
  }
}

/** Why an exit node wasn't taken (an `exitnode` event with a `code`). */
export function exitNodeError(e: TsFailure & { id?: string }): Error {
  if (e.code === 'no-exit-node') return new MsgError('network:ts-client.noExitNode', { id: e.id ?? '' });
  return failureOf(e);
}

export const DNS4 = [[1, 1, 1, 1], [1, 0, 0, 1]];
export const DNS6 = [[0x26, 0x06, 0x47, 0x00, 0x47, 0x00, 0, 0, 0, 0, 0, 0, 0, 0, 0x11, 0x11]];

/** How long a fetch (the control server's key, a DERP map or probe, DNS over HTTPS) may take. */
const FETCH_MS = 15_000;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** One instance of the module; it holds any number of clients. */
export class TsModule {
  readonly x: Exports;
  private constructor(x: Exports) {
    this.x = x;
  }

  /** Loads target/net/ts.wasm from `source` (a URL, streamed, the bytes, or compiled: a benchmark's many instances). */
  static async load(source: string | URL | BufferSource | WebAssembly.Module, log?: (line: string) => void): Promise<TsModule> {
    let memory: WebAssembly.Memory | undefined;
    const imports = wasi(() => memory!, log);
    const { instance } = source instanceof WebAssembly.Module
      ? { instance: await WebAssembly.instantiate(source, imports) }
      : source instanceof ArrayBuffer || ArrayBuffer.isView(source)
      ? await WebAssembly.instantiate(source, imports)
      : await WebAssembly.instantiateStreaming(fetch(source), imports);
    const x = instance.exports as unknown as Exports;
    memory = x.memory;
    x._initialize();
    return new TsModule(x);
  }

  /** Copies `b` into a buffer of the module's, for a call that takes it. */
  put(b: Uint8Array): [number, number] {
    const ptr = this.x.ts_alloc(b.length);
    new Uint8Array(this.x.memory.buffer, ptr, b.length).set(b);
    return [ptr, b.length];
  }

  /** The `len` bytes at `ts_buf()`, copied out. */
  buf(len: number): Uint8Array<ArrayBuffer> {
    return new Uint8Array(this.x.memory.buffer, this.x.ts_buf(), len).slice();
  }
}

/** A client of the module: tailcat (the guest's network through a tailcat server) or, with `control`, Tailscale. */
export class TsClient {
  private readonly m: TsModule;
  private readonly h: number;
  private readonly on: TsHandlers;
  private readonly sockets = new Map<number, { ws: WebSocket; text: boolean; queue: Uint8Array<ArrayBuffer>[] | null }>();
  /** A room's data channels, by connection. */
  private readonly channels = new Map<number, RTCDataChannel>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private closed = false;

  constructor(m: TsModule, config: TailcatConfig | TailnetConfig | RoomConfig, on: TsHandlers) {
    this.m = m;
    this.on = on;
    const json = encoder.encode(JSON.stringify({ dns4: DNS4, dns6: DNS6, ...config }));
    const h = m.x.ts_new(...m.put(json));
    if (h <= 0) throw new Error(decoder.decode(m.buf(-h)));
    this.h = h;
    this.pump();
  }

  /** The node's private key, to keep (`TailcatConfig.key`). */
  privateKey(): string {
    const n = this.m.x.ts_private_key(this.h);
    return Array.from(this.m.buf(n), (b) => b.toString(16).padStart(2, '0')).join('');
  }

  /** IP packets from the guest (one IP-port message): all in, then the actions they caused, so their relay frames leave together. */
  guest(...ps: Uint8Array[]) {
    if (this.closed) return;
    for (const p of ps) this.m.x.ts_guest(this.h, ...this.m.put(p));
    this.pump();
  }

  /** Tailscale: logs the node out (`loggedout` follows) and tells the store to forget it. */
  logout() {
    if (this.closed) return;
    this.m.x.ts_logout(this.h);
    this.pump();
  }

  /** Tailscale: sends the guest's internet traffic through the peer with this stable ID ('' stops); answered by an `exitnode` event. */
  setExitNode(id: string) {
    if (this.closed) return;
    this.m.x.ts_exit_node(this.h, ...this.m.put(encoder.encode(id)));
    this.pump();
  }

  /** Tailscale: installs peers' subnet routes, or stops; a `netmap` event follows. */
  setAcceptRoutes(on: boolean) {
    if (this.closed) return;
    this.m.x.ts_accept_routes(this.h, on ? 1 : 0);
    this.pump();
  }

  /** A room: connection `rtc`'s data channel (made negotiated, as `open` asked), whose messages are the peer's packets. */
  rtcChannel(rtc: number, dc: RTCDataChannel) {
    if (this.closed) return dc.close();
    this.channels.get(rtc)?.close();
    this.channels.set(rtc, dc);
    dc.binaryType = 'arraybuffer';
    const live = () => !this.closed && this.channels.get(rtc) === dc;
    const opened = () => { if (live()) { this.m.x.ts_rtc_open(this.h, rtc); this.pump(); } };
    dc.onopen = opened;
    dc.onmessage = (e: MessageEvent) => {
      if (!live() || !(e.data instanceof ArrayBuffer)) return;
      this.m.x.ts_rtc_message(this.h, rtc, ...this.m.put(new Uint8Array(e.data)));
      this.pump();
    };
    dc.onclose = () => this.rtcClosed(rtc, dc);
    if (dc.readyState === 'open') opened();
  }

  /** A room: connection `rtc`'s local description or candidate (JSON), for the peer. */
  rtcSignal(rtc: number, json: string) {
    if (this.closed) return;
    this.m.x.ts_rtc_signal(this.h, rtc, ...this.m.put(encoder.encode(json)));
    this.pump();
  }

  /** A room: connection `rtc` closed or failed (`dc`: only if that channel is still the connection's). */
  rtcClosed(rtc: number, dc?: RTCDataChannel) {
    if (this.closed || (dc && this.channels.get(rtc) !== dc)) return;
    this.channels.delete(rtc);
    this.m.x.ts_rtc_closed(this.h, rtc);
    this.pump();
  }

  close() {
    if (this.closed) return;
    this.m.x.ts_close(this.h);
    this.pump();
    this.closed = true;
    clearTimeout(this.timer);
    for (const { ws } of this.sockets.values()) ws.close();
    this.sockets.clear();
    for (const dc of this.channels.values()) dc.close();
    this.channels.clear();
    this.m.x.ts_free(this.h);
  }

  /** Carries out every queued action, then sets the timer for the next deadline. */
  private pump() {
    const { x } = this.m;
    for (let n = x.ts_poll(this.h); n > 0; n = x.ts_poll(this.h)) {
      const a = this.m.buf(n);
      const id = a[1] | (a[2] << 8) | (a[3] << 16) | (a[4] << 24);
      const rest = a.subarray(5);
      switch (a[0]) {
        case 1: {
          const nul = rest.indexOf(0);
          this.open(id, decoder.decode(rest.subarray(nul + 1)), decoder.decode(rest.subarray(0, nul)));
          break;
        }
        case 2: {
          const s = this.sockets.get(id);
          // Until it opens; a socket that never does holds at most SOCKET_QUEUE messages.
          if (s?.queue) { if (s.queue.length < SOCKET_QUEUE) s.queue.push(rest); }
          else if (s?.ws.readyState === WebSocket.OPEN) s.ws.send(s.text ? decoder.decode(rest) : rest);
          break;
        }
        case 3:
          this.sockets.get(id)?.ws.close();
          this.sockets.delete(id);
          break;
        case 4:
          this.fetch(id, decoder.decode(rest));
          break;
        case 5:
          this.on.packet(rest);
          break;
        case 6:
          this.on.event(JSON.parse(decoder.decode(rest)));
          break;
        case 7:
          this.on.rtc?.open(id, rest[0] === 1);
          break;
        case 8:
          this.on.rtc?.signal(id, decoder.decode(rest));
          break;
        case 9: {
          const dc = this.channels.get(id);
          // A full send queue throws: the packet is lost, as on any congested path.
          if (dc?.readyState === 'open') try { dc.send(rest); } catch { /* dropped */ }
          break;
        }
        case 10: {
          const dc = this.channels.get(id);
          this.channels.delete(id);
          dc?.close();
          this.on.rtc?.close(id);
          break;
        }
      }
    }
    clearTimeout(this.timer);
    const ms = this.closed ? -1 : x.ts_deadline(this.h);
    if (ms >= 0) this.timer = setTimeout(() => { this.m.x.ts_tick(this.h); this.pump(); }, Math.ceil(ms));
  }

  /** A WebSocket for the module: binary with a subprotocol (DERP), text without one (a room's Nostr relays: the
   * module's bytes are UTF-8 both ways). */
  private open(conn: number, url: string, protocol: string) {
    let ws: WebSocket;
    const text = protocol === '';
    try {
      ws = text ? new WebSocket(url) : new WebSocket(url, protocol);
    } catch {
      // A URL the browser refuses: closed at once, as far as the module knows (not from inside this pump).
      setTimeout(() => { if (!this.closed) { this.m.x.ts_ws_closed(this.h, conn); this.pump(); } });
      return;
    }
    ws.binaryType = 'arraybuffer';
    const s = { ws, text, queue: [] as Uint8Array<ArrayBuffer>[] | null };
    this.sockets.set(conn, s);
    ws.onopen = () => {
      for (const b of s.queue ?? []) ws.send(text ? decoder.decode(b) : b);
      s.queue = null;
    };
    ws.onmessage = (e: MessageEvent) => {
      if (this.closed) return;
      const b = typeof e.data === 'string' && text ? encoder.encode(e.data) : e.data instanceof ArrayBuffer ? new Uint8Array(e.data) : undefined;
      if (!b) return;
      this.m.x.ts_ws_message(this.h, conn, ...this.m.put(b));
      this.pump();
    };
    ws.onclose = () => {
      if (this.closed || this.sockets.get(conn)?.ws !== ws) return;
      this.sockets.delete(conn);
      this.m.x.ts_ws_closed(this.h, conn);
      this.pump();
    };
  }

  private async fetch(id: number, url: string) {
    let ok = 0;
    let body = new Uint8Array();
    try {
      // A fetch on a path that died could hang for minutes: the module's waits are shorter.
      const r = await fetch(url, { signal: AbortSignal.timeout(FETCH_MS) });
      body = new Uint8Array(await r.arrayBuffer());
      ok = r.ok ? 1 : 0;
    } catch {
      // ok stays 0: the client says the map couldn't be loaded
    }
    if (this.closed) return;
    this.m.x.ts_fetched(this.h, id, ok, ...this.m.put(body));
    this.pump();
  }
}

