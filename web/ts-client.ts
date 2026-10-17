// The tailnet client's I/O (docs/tailnet.md): the module
// (net/ts, target/net/ts.wasm) holds the protocols' state and never waits;
// this carries out what it asks (WebSockets to DERP relays, fetches, timers)
// and feeds it what comes back, the guest's packets and the time. It runs in
// a worker or in Node alike: WebSocket, fetch and crypto are all it needs.
import type { Lease } from './gateway.ts';
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
};

/** A tailcat server to connect to (`tailcat serve exit-node` printed `addr`), clients to let in (`serve`), or both. */
export type TailcatConfig = {
  addr?: string;
  /** The VM as a tailcat server (docs/tailnet.md "tailcat"): the address's pre-shared key (64 hex digits) and,
   * without `addr`, the relay: one's own derper (`host[:port]`), or a region of the DERP map by ID (0: its first). */
  serve?: { psk: string; relay?: string; region?: number };
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
};

export type TsEvent =
  | { type: 'state'; state: 'FetchingMap' | 'Connecting' | 'Meowing' | 'Handshaking' | 'Running' | 'Failed'; error?: string }
  | { type: 'lease'; lease: Lease }
  | { type: 'self'; key: string; address6: number[] }
  | { type: 'serving'; addr: string }
  | { type: 'client'; key: string; address6: number[] }
  | { type: 'log'; msg: string }
  /** Tailscale: Go's state names (`Starting`, `NeedsLogin`, `Running`), or `Failed` with why. */
  | { type: 'state'; state: 'Starting' | 'NeedsLogin' | 'Running'; error?: string }
  | { type: 'netmap'; netmap: NetMap }
  /** Write this entry of the node's store (hex, as the Go client's store keeps it). */
  | { type: 'store'; key: string; value: string }
  /** The URL to visit to log the node in. */
  | { type: 'login'; url: string }
  | { type: 'loggedout' }
  /** The answer to `setExitNode`: '' when it took, else why not. */
  | { type: 'exitnode'; error: string };

export type TsHandlers = {
  /** An IP packet for the guest (the array is the client's: keep it). */
  packet(p: Uint8Array): void;
  event(e: TsEvent): void;
};

export const DNS4 = [[1, 1, 1, 1], [1, 0, 0, 1]];
export const DNS6 = [[0x26, 0x06, 0x47, 0x00, 0x47, 0x00, 0, 0, 0, 0, 0, 0, 0, 0, 0x11, 0x11]];

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** One instance of the module; it holds any number of clients. */
export class TsModule {
  readonly x: Exports;
  private constructor(x: Exports) {
    this.x = x;
  }

  /** Loads target/net/ts.wasm from `source` (a URL, streamed, or the bytes). */
  static async load(source: string | URL | BufferSource, log?: (line: string) => void): Promise<TsModule> {
    let memory: WebAssembly.Memory | undefined;
    const imports = wasi(() => memory!, log);
    const { instance } = source instanceof ArrayBuffer || ArrayBuffer.isView(source)
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
  private readonly sockets = new Map<number, { ws: WebSocket; queue: Uint8Array<ArrayBuffer>[] | null }>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private closed = false;

  constructor(m: TsModule, config: TailcatConfig | TailnetConfig, on: TsHandlers) {
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

  close() {
    if (this.closed) return;
    this.m.x.ts_close(this.h);
    this.pump();
    this.closed = true;
    clearTimeout(this.timer);
    for (const { ws } of this.sockets.values()) ws.close();
    this.sockets.clear();
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
          if (s?.queue) s.queue.push(rest);
          else if (s?.ws.readyState === WebSocket.OPEN) s.ws.send(rest);
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
      }
    }
    clearTimeout(this.timer);
    const ms = this.closed ? -1 : x.ts_deadline(this.h);
    if (ms >= 0) this.timer = setTimeout(() => { this.m.x.ts_tick(this.h); this.pump(); }, Math.ceil(ms));
  }

  private open(conn: number, url: string, protocol: string) {
    const ws = new WebSocket(url, protocol);
    ws.binaryType = 'arraybuffer';
    const s = { ws, queue: [] as Uint8Array<ArrayBuffer>[] | null };
    this.sockets.set(conn, s);
    ws.onopen = () => {
      for (const b of s.queue ?? []) ws.send(b);
      s.queue = null;
    };
    ws.onmessage = (e: MessageEvent) => {
      if (this.closed || !(e.data instanceof ArrayBuffer)) return;
      this.m.x.ts_ws_message(this.h, conn, ...this.m.put(new Uint8Array(e.data)));
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
      const r = await fetch(url);
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

