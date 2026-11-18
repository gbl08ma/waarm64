// A room's member in Node, as R3's synthetic members (bench/net/room-scale.ts, docs/networking/rooms.md "Numbers"): the
// Rust client (target/net/ts.wasm, room.rs) in a module instance of its own, as a page's worker has, relay only (Node
// has no WebRTC), its guest played as tests/browser/room.html plays it: UDP to its port 7 is echoed back, and `ping`
// sends to another member's port 7 until an echo comes back.
import { TsClient, TsModule, type NamesTitle, type TsEvent } from '../../web/ts-client.ts';

export type MemberOptions = {
  link: string;
  /** Unix seconds at the start (`Config::unix_time`): a clock shifted to put the hour's turn into the run. */
  unixTime?: number;
  incoming?: boolean;
  /** The node's private key (64 hex digits): a fresh one without. */
  key?: string;
  /** Room names (bench/net/names-public.ts): the node's titles, which make it a server. */
  names?: { titles: NamesTitle[]; maxNames?: number; maxBytes?: number };
  /** Every packet to the guest, before the echo's handling. */
  packet?(p: Uint8Array): void;
  /** Every event. */
  event?(e: TsEvent): void;
};

export type Member = {
  /** The node's address (16 bytes). */
  address6: number[];
  key: string;
  /** ms from the start to `Running` (the home region connected), once it is. */
  runningMs?: number;
  failed?: string;
  /** Peers seen (`peer` events), by key. */
  peers: Set<string>;
  /** Echoes until one comes back or `ms` pass: the time to the first, or -1. */
  ping(to: number[], ms?: number): Promise<number>;
  /** `n` echoes of `size` bytes to `to`, `window` in flight: how many came back, the time, and each one's RTT. */
  echoes(to: number[], n: number, size: number, window?: number, timeout?: number): Promise<{ back: number; ms: number; rtts: number[] }>;
  /** The client's log lines (`log` events: what relays said, among others), the latest 200. */
  logs: string[];
  /** The module instance's linear memory, bytes. */
  memory(): number;
  /** The client (to send the guest's own packets). */
  client: TsClient;
  close(): void;
};

let seq = 0;

/** A member on its own instance of `wasm` (the compiled module, shared: instantiating it is per member). */
export async function startMember(wasm: WebAssembly.Module, o: MemberOptions): Promise<Member> {
  const mod = await TsModule.load(wasm);
  const t0 = performance.now();
  const waiting = new Map<number, () => void>();
  let self: { key: string; address6: number[] } | undefined;
  const m: Member = {
    address6: [], key: '', peers: new Set(), logs: [], client: undefined as unknown as TsClient,
    memory: () => mod.x.memory.buffer.byteLength,
    close: () => client.close(),
    async ping(to, ms = 10_000) {
      const t = performance.now();
      while (performance.now() - t < ms) {
        const s = ++seq;
        const back = await new Promise<boolean>((resolve) => {
          const timer = setTimeout(() => { waiting.delete(s); resolve(false); }, 500);
          waiting.set(s, () => { clearTimeout(timer); waiting.delete(s); resolve(true); });
          client.guest(udp(m.address6, to, s));
        });
        if (back) return performance.now() - t;
      }
      return -1;
    },
    async echoes(to, n, size, window = 32, timeout = 3000) {
      let back = 0;
      const rtts: number[] = [];
      const t = performance.now();
      const one = () => new Promise<void>((resolve) => {
        const s = ++seq;
        const sent = performance.now();
        const timer = setTimeout(() => { waiting.delete(s); resolve(); }, timeout);
        waiting.set(s, () => { clearTimeout(timer); waiting.delete(s); back++; rtts.push(performance.now() - sent); resolve(); });
        client.guest(udp(m.address6, to, s, size));
      });
      let started = 0;
      await Promise.all(Array.from({ length: window }, async () => { while (started < n) { started++; await one(); } }));
      return { back, ms: performance.now() - t, rtts };
    },
  };
  const client = new TsClient(mod, {
    room: { link: o.link, relayOnly: true, incoming: o.incoming ?? true, unixTime: o.unixTime, ...(o.names ? { names: o.names } : {}) },
    ...(o.key ? { key: o.key } : {}),
  }, {
    packet(p) {
      o.packet?.(p);
      if (p[0] >> 4 !== 6 || p[6] !== 17 || p.length < 52) return;
      const dport = (p[42] << 8) | p[43];
      if (dport === 7) { // echo: swap addresses and ports
        const r = p.slice();
        r.set(p.subarray(24, 40), 8); r.set(p.subarray(8, 24), 24);
        r.set(p.subarray(42, 44), 40); r.set(p.subarray(40, 42), 42);
        client.guest(r);
      } else waiting.get(new DataView(p.buffer, p.byteOffset).getUint32(48))?.();
    },
    event(e: TsEvent) {
      o.event?.(e);
      const ev = e as TsEvent & { key?: string; address6?: number[]; state?: string; code?: string };
      if (ev.type === 'self') self = { key: ev.key!, address6: ev.address6! };
      else if (ev.type === 'state' && ev.state === 'Running') m.runningMs ??= performance.now() - t0;
      else if (ev.type === 'state' && ev.state === 'Failed') m.failed = ev.code ?? 'failed';
      else if (ev.type === 'peer') m.peers.add(ev.key!);
      else if (ev.type === 'log') {
        m.logs.push(String((ev as { msg?: string }).msg));
        if (m.logs.length > 200) m.logs.shift();
      }
    },
  });
  if (!self) throw new Error('no self event');
  m.client = client;
  m.address6 = self.address6;
  m.key = self.key;
  return m;
}

/** An IPv6 UDP packet from `from` to `to`'s port 7 with `s` first in its `size`-byte payload (checksum 0: nothing checks it). */
function udp(from: number[], to: number[], s: number, size = 32) {
  const p = new Uint8Array(48 + size);
  const len = 8 + size;
  p.set([0x60, 0, 0, 0, len >> 8, len & 255, 17, 64]);
  p.set(from, 8);
  p.set(to, 24);
  p.set([0x4e, 0x20, 0, 7, len >> 8, len & 255, 0, 0], 40);
  new DataView(p.buffer).setUint32(48, s);
  return p;
}
