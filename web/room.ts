// A room from the page's side (docs/networking/rooms.md): the client
// (net/ts, room.rs) in its own worker (web/room-worker.ts), and the WebRTC connections it asks for,
// which live here because Chromium has no RTCPeerConnection in workers. Each connection's data channel
// is negotiated (id 0, unordered, no retransmits: WireGuard's packets, which tolerate loss) and
// transferred to the worker as it's made, before anything is sent on it; descriptions and candidates
// travel inside the WireGuard tunnel, so a peer sees this machine's candidates only after a handshake
// with the room's key.
import type { Lease } from './gateway.ts';
import { fromWire, msg, type Msg, type WireError } from './msg.ts';
import type { FromTailscale, NetMap, Tailscale } from './tailscale.ts';
import type { RoomConfig, TsEvent } from './ts-client.ts';

/** STUN only (no TURN: DERP is the relay). */
export const STUN_SERVERS: RTCIceServer[] = [{ urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302'] }];

export type StartRoom = RoomConfig & {
  /** The node's kept identity: in `webpc-room` under `identityKey` (made the first time), or `identity` (an ephemeral
   * connection's, kept nowhere). Neither, nor `key`: a fresh key each start. */
  identityKey?: string;
  identity?: RoomIdentity;
  /** The ICE servers (default STUN_SERVERS). */
  iceServers?: RTCIceServer[];
  /** Where target/net/ts.wasm is served from (default: this checkout's target/net). */
  wasm?: string;
  /** The gateway's end of the IP port (transferred); default: a new channel, whose device end is `ip`. */
  ip?: MessagePort;
};

export type ToRoom =
  | { type: 'start'; wasm: string; config: RoomConfig; identityKey?: string; identity?: RoomIdentity; ip: MessagePort }
  | { type: 'attach'; ip: MessagePort }
  | { type: 'primary'; primary: boolean; rank?: number; primary6?: boolean }
  | { type: 'detach' }
  | { type: 'rtc-channel'; rtc: number; channel: RTCDataChannel }
  | { type: 'rtc-signal'; rtc: number; json: string }
  | { type: 'rtc-closed'; rtc: number };

export type FromRoom =
  | { type: 'loaded'; ms: number }
  | { type: 'event'; event: TsEvent }
  | { type: 'rtc-open'; rtc: number; offer: boolean }
  | { type: 'rtc-signal'; rtc: number; json: string }
  | { type: 'rtc-close'; rtc: number }
  | { type: 'detached'; ip?: MessagePort }
  | { type: 'error'; error: WireError };

export type RoomPeer = { key: string; address6: number[]; path: 'direct' | 'relay' };

export type Room = {
  /** The device's end of the IP port, when the config brought none. */
  ip?: MessagePort;
  state(): string;
  /** This member's node key, address and name, the room's tag and link, once known. */
  self(): { key: string; address6: number[]; tag?: string; name?: string; link?: string } | undefined;
  lease(): Lease | null;
  /** The peers whose data decrypted, and the path each one's packets take. */
  peers(): RoomPeer[];
  /** Resolves when the client is `Running`; rejects if the worker fails. */
  running: Promise<void>;
  timings(): { loadMs?: number; runningMs?: number };
  attach(ip: MessagePort): void;
  setPrimary(primary: boolean, rank?: number, primary6?: boolean): void;
  detach(): Promise<MessagePort | undefined>;
  /** Closes every WebRTC connection, as a failed path would (the tests' fallback to DERP). */
  dropDirect(): void;
  close(): void;
};

/** A connection the worker asked for. */
type Conn = { pc: RTCPeerConnection; pending: RTCIceCandidateInit[] | null };

/**
 * A room's events: the client's, and the page's own `direct`: whether this browser can make direct paths at all. A
 * connection whose ICE gathering completes without one candidate can't (`blocked`): the browser uses no UDP for WebRTC,
 * as with Chromium's `webrtc.ip_handling_policy` `disable_non_proxied_udp` (ungoogled-chromium's default, its
 * `#webrtc-ip-handling-policy` flag), so every peer goes through the relay. The next connection that gathers one says so.
 */
export type RoomEvent = TsEvent | { type: 'direct'; blocked: boolean };

/** `onError`: the worker failed (after `Running` too, which `running` can't say). */
export function startRoom(config: StartRoom, onEvent: (e: RoomEvent) => void = () => {}, onError: (e: WireError) => void = () => {}): Room {
  const worker = new Worker(new URL('./room-worker.ts', import.meta.url), { type: 'module' });
  const own = config.ip ? undefined : new MessageChannel();
  const port1 = config.ip ?? own!.port1;
  const conns = new Map<number, Conn>();
  const peers = new Map<string, RoomPeer>();
  let state = '';
  let me: ReturnType<Room['self']>;
  let lease: Lease | null = null;
  let detached: ((ip?: MessagePort) => void) | undefined;
  let blocked = false;
  const gathered = (n: number) => {
    if (blocked === (n === 0)) return;
    blocked = n === 0;
    onEvent({ type: 'direct', blocked });
  };
  const t0 = performance.now();
  const timings: { loadMs?: number; runningMs?: number } = {};
  const post = (m: ToRoom, transfer: Transferable[] = []) => worker.postMessage(m, transfer);
  const signal = (rtc: number, v: unknown) => post({ type: 'rtc-signal', rtc, json: JSON.stringify(v) });
  const fail = (rtc: number) => {
    if (!conns.has(rtc)) return;
    conns.get(rtc)!.pc.close();
    conns.delete(rtc);
    post({ type: 'rtc-closed', rtc });
  };

  async function open(rtc: number, offer: boolean) {
    const pc = new RTCPeerConnection({ iceServers: config.iceServers ?? STUN_SERVERS });
    const c: Conn = { pc, pending: [] };
    conns.set(rtc, c);
    const channel = pc.createDataChannel('wg', { negotiated: true, id: 0, ordered: false, maxRetransmits: 0 });
    post({ type: 'rtc-channel', rtc, channel }, [channel as unknown as Transferable]);
    let candidates = 0;
    pc.onicecandidate = (e) => {
      if (e.candidate?.candidate) candidates++;
      if (e.candidate && conns.get(rtc) === c) signal(rtc, e.candidate.toJSON());
    };
    pc.onicegatheringstatechange = () => { if (pc.iceGatheringState === 'complete' && conns.get(rtc) === c) gathered(candidates); };
    pc.onconnectionstatechange = () => { if (pc.connectionState === 'failed') fail(rtc); };
    if (!offer) return;
    try {
      await pc.setLocalDescription();
      if (conns.get(rtc) === c) signal(rtc, pc.localDescription!.toJSON());
    } catch (err) {
      console.log('room: no offer:', err);
      fail(rtc);
    }
  }

  async function remote(rtc: number, json: string) {
    const c = conns.get(rtc);
    if (!c) return;
    try {
      const v = JSON.parse(json) as RTCSessionDescriptionInit & RTCIceCandidateInit;
      if (!v || typeof v !== 'object') throw new Error('not a description or candidate');
      if (v.sdp !== undefined && v.type) {
        await c.pc.setRemoteDescription(v);
        for (const cand of c.pending ?? []) await c.pc.addIceCandidate(cand);
        c.pending = null;
        if (v.type === 'offer') {
          await c.pc.setLocalDescription();
          if (conns.get(rtc) === c) signal(rtc, c.pc.localDescription!.toJSON());
        }
      } else if (c.pending) {
        c.pending.push(v); // before the description: kept until it comes
      } else {
        await c.pc.addIceCandidate(v);
      }
    } catch (err) {
      console.log('room: a peer\'s description or candidate was refused:', err);
      fail(rtc);
    }
  }

  const running = new Promise<void>((resolve, reject) => {
    worker.onerror = (e) => reject(new Error(e.message));
    worker.onmessage = (e: MessageEvent<FromRoom>) => {
      const m = e.data;
      switch (m.type) {
        case 'loaded': timings.loadMs = m.ms; break;
        case 'rtc-open': void open(m.rtc, m.offer); break;
        case 'rtc-signal': void remote(m.rtc, m.json); break;
        case 'rtc-close':
          conns.get(m.rtc)?.pc.close();
          conns.delete(m.rtc);
          break;
        case 'detached': detached?.(m.ip); break;
        case 'error':
          reject(fromWire(m.error));
          onError(m.error);
          break;
        case 'event': {
          const ev = m.event;
          if (ev.type === 'state') {
            state = ev.state;
            if (state === 'Running' && timings.runningMs === undefined) {
              timings.runningMs = performance.now() - t0;
              resolve();
            }
          } else if (ev.type === 'self') me = ev;
          else if (ev.type === 'lease') lease = ev.lease;
          else if (ev.type === 'peer') peers.set(ev.key, { key: ev.key, address6: ev.address6, path: peers.get(ev.key)?.path ?? 'relay' });
          else if (ev.type === 'path') peers.set(ev.key, { key: ev.key, address6: ev.address6, path: ev.path });
          else if (ev.type === 'peer-gone') peers.delete(ev.key);
          onEvent(ev);
        }
      }
    };
  });
  running.catch(() => {});
  const wasm = config.wasm ?? new URL('../target/net/ts.wasm', import.meta.url).href;
  const { room, derpMapURL, key, identityKey, identity } = config;
  post({ type: 'start', wasm, config: { room, derpMapURL, key }, identityKey, identity, ip: port1 }, [port1]);
  return {
    ip: own?.port2, state: () => state, self: () => me, lease: () => lease, peers: () => [...peers.values()],
    running, timings: () => timings,
    attach: (ip) => post({ type: 'attach', ip }, [ip]),
    setPrimary: (primary, rank, primary6) => post({ type: 'primary', primary, rank, primary6 }),
    detach: () => new Promise((resolve) => {
      const t = setTimeout(() => resolve(undefined), 3000);
      detached = (ip) => { clearTimeout(t); resolve(ip); };
      post({ type: 'detach' });
    }),
    dropDirect: () => { for (const rtc of [...conns.keys()]) fail(rtc); },
    close: () => {
      for (const { pc } of conns.values()) pc.close();
      conns.clear();
      worker.terminate();
    },
  };
}

/** A room connection's node key (64 hex digits), kept in this origin's IndexedDB `webpc-room` (docs/networking/adapters.md §2.1). */
export type RoomIdentity = { key: string };
const IDB = 'webpc-room';

function idb<T>(mode: IDBTransactionMode, f: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(IDB, 1);
    open.onupgradeneeded = () => open.result.createObjectStore('identity');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const r = f(db.transaction('identity', mode).objectStore('identity'));
      r.onsuccess = () => { db.close(); resolve(r.result); };
      r.onerror = (e) => { e.preventDefault(); db.close(); reject(r.error); }; // handled here (`add`'s refusal)
    };
  });
}

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

/** A new identity (an ephemeral connection's lives in memory). */
export const newRoomIdentity = (): RoomIdentity => ({ key: hex(crypto.getRandomValues(new Uint8Array(32))) });

/** The identity kept under `key`, made the first time. */
export async function roomIdentity(key: string): Promise<RoomIdentity> {
  const made = newRoomIdentity();
  // `add` refuses a key that's there (two workers sharing it, starting at once): then the kept one is read.
  const added = await idb('readwrite', (s) => s.add(made, key)).then(() => true, () => false);
  return added ? made : (await idb<RoomIdentity | undefined>('readonly', (s) => s.get(key))) ?? Promise.reject(new Error(`no room identity under ${key}`));
}

/** The identity kept under `key`, if there is one (none is made). */
export const readRoomIdentity = (key: string) => idb<RoomIdentity | undefined>('readonly', (s) => s.get(key));

/** Keeps `identity` under `key` (a pasted key), in place of what's there. */
export const keepRoomIdentity = (key: string, identity: RoomIdentity) => idb('readwrite', (s) => s.put(identity, key)).then(() => {});

/**
 * A node key as the user pastes it (one copied from a room connection, or mined by net/ts/examples/room-key-mine.rs): 64 hex
 * digits, the X25519 private key, spaces around it ignored; written back in lower case, or undefined if it isn't one.
 */
export function parseRoomKey(s: string): string | undefined {
  const k = s.trim().toLowerCase();
  return /^[0-9a-f]{64}$/.test(k) ? k : undefined;
}

/** Whether there's an identity kept under `key`. */
export const hasRoomIdentity = (key: string) => idb<number>('readonly', (s) => s.count(key)).then((n) => n > 0, () => false);

/** Forgets the identity under `key`: the next start makes a new key, so a new address and name in every room that used it. */
export const forgetRoomIdentity = (key: string) => idb('readwrite', (s) => s.delete(key)).then(() => {});

// A room's link, as net/ts/src/room/link.rs reads it: `webpc-room:<id>?nostr=<wss URL>&…&derp=<region>&…`, each part
// percent-encoded. The page builds it (Create a room) and checks one pasted (Join a room); the module reads it again.
export const ROOM_SCHEME = 'webpc-room:';
/** What link.rs allows: an ID of at most 256 bytes, at most 8 relays and 8 regions. */
export const ROOM_MAX_ID = 256;
export const ROOM_MAX_RELAYS = 8;

/** A private room's ID: the name the user chose, a hyphen and 128 random bits in base32 (26 characters). */
const PRIVATE = /-[a-z2-7]{26}$/;

/** RFC 4648's base32, lower case, no padding (as room.rs `base32`). */
export function base32(b: Uint8Array): string {
  const A = 'abcdefghijklmnopqrstuvwxyz234567';
  let out = '', acc = 0, bits = 0;
  for (const x of b) {
    acc = ((acc << 8) | x) & 0xffff;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += A[(acc >> bits) & 31];
    }
  }
  if (bits > 0) out += A[(acc << (5 - bits)) & 31];
  return out;
}

/** A private room's ID for the name `name`: only those given its link can guess it. */
export const privateRoomId = (name: string) => `${name.trim()}-${base32(crypto.getRandomValues(new Uint8Array(16)))}`;

/** Whether a room's ID has a private room's suffix (the only form the page takes as private). */
export const isPrivateRoom = (id: string) => PRIVATE.test(id);

/** The name a room's ID shows: a private one's without its suffix. */
export const roomName = (id: string) => id.replace(PRIVATE, '');

/** The global public room's name: the wizard's first choice for a room joins it, on the defaults (docs/networking/rooms.md). */
export const GLOBAL_ROOM = 'global';

/** A room's parts, as the link carries them; empty lists: the defaults. */
export type RoomLink = { id: string; nostr: string[]; derp: string[] };

const enc = (s: string) => Array.from(new TextEncoder().encode(s), (c) => /[A-Za-z0-9\-._~]/.test(String.fromCharCode(c)) ? String.fromCharCode(c) : `%${c.toString(16).toUpperCase().padStart(2, '0')}`).join('');

function dec(s: string): string | undefined {
  const out: number[] = [];
  const b = new TextEncoder().encode(s);
  for (let i = 0; i < b.length; i++) {
    if (b[i] === 0x25) {
      const h = String.fromCharCode(b[i + 1] ?? 0, b[i + 2] ?? 0); // the bytes', as link.rs reads them
      if (!/^[0-9a-fA-F]{2}$/.test(h)) return undefined;
      out.push(parseInt(h, 16));
      i += 2;
    } else out.push(b[i]);
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(out));
  } catch {
    return undefined;
  }
}

/** A DERP region as a link names it: a region's number in the DERP map, or a derper's `host[:port]` (never a negative
 * number, which link.rs refuses). */
const DERP = /^(?!-\d+$)(\d+|(\[[0-9a-fA-F:.]+\]|[A-Za-z0-9.-]+)(:\d{1,5})?)$/;

/** Checks a room's parts and writes its link, or says what's wrong. */
export function roomLink(l: RoomLink): { link: string } | { error: Msg } {
  const id = l.id.trim();
  if (!id) return { error: msg('network:room.noName') };
  if (new TextEncoder().encode(id).length > ROOM_MAX_ID) return { error: msg('network:room.longName', { max: ROOM_MAX_ID }) };
  const nostr = l.nostr.map((n) => n.trim()).filter((n) => n);
  const derp = l.derp.map((d) => d.trim()).filter((d) => d);
  const badRelay = nostr.find((n) => !/^wss?:\/\/[^\s/?#]+/.test(n));
  if (badRelay) return { error: msg('network:room.badRelay', { relay: badRelay }) };
  const badDerp = derp.find((d) => !DERP.test(d) || Number(/:(\d+)$/.exec(d)?.[1] ?? 0) > 65535);
  if (badDerp) return { error: msg('network:room.badDerp', { relay: badDerp }) };
  if (nostr.length > ROOM_MAX_RELAYS || derp.length > ROOM_MAX_RELAYS) return { error: msg('network:room.tooMany', { max: ROOM_MAX_RELAYS }) };
  const parts = [...nostr.map((n) => `nostr=${enc(n)}`), ...derp.map((d) => `derp=${enc(d)}`)];
  return { link: `${ROOM_SCHEME}${enc(id)}${parts.length ? `?${parts.join('&')}` : ''}` };
}

/** A room's link as pasted, or a bare ID (a public room's name: the defaults), checked and written again; or what's wrong. */
export function parseRoomLink(input: string): { link: string; room: RoomLink } | { error: Msg } {
  const s = input.trim();
  if (!s) return { error: msg('network:room.pasteLink') };
  let room: RoomLink = { id: s, nostr: [], derp: [] };
  if (s.startsWith(ROOM_SCHEME)) {
    const rest = s.slice(ROOM_SCHEME.length);
    const q = rest.indexOf('?');
    const id = dec(q < 0 ? rest : rest.slice(0, q));
    if (id === undefined) return { error: msg('network:room.badLink') };
    room = { id, nostr: [], derp: [] };
    for (const part of (q < 0 ? '' : rest.slice(q + 1)).split('&').filter((p) => p)) {
      const eq = part.indexOf('=');
      const [k, v] = eq < 0 ? [part, ''] : [part.slice(0, eq), dec(part.slice(eq + 1))];
      if (v === undefined) return { error: msg('network:room.badLink') };
      if (k === 'nostr') room.nostr.push(v);
      else if (k === 'derp') room.derp.push(v);
      // Another key is a later version's: ignored, as link.rs does.
    }
  }
  const l = roomLink(room);
  return 'error' in l ? l : { link: l.link, room: { ...room, id: room.id.trim() } };
}

/** What starts a room connection's client: its link, its switches and its kept identity. */
export type RoomNetConfig = {
  link: string;
  incoming?: boolean;
  relayOnly?: boolean;
  identityKey?: string;
  identity?: RoomIdentity;
  derpMapURL?: string;
  iceServers?: RTCIceServer[];
  wasm?: string;
  ip?: MessagePort;
};

const v6text = (b: number[]) => {
  const groups = Array.from({ length: 8 }, (_, k) => ((b[2 * k] << 8) | b[2 * k + 1]).toString(16));
  let best = [-1, 0];
  for (let k = 0; k < 8;) {
    let n = 0;
    while (k + n < 8 && groups[k + n] === '0') n++;
    if (n > best[1] && n > 1) best = [k, n];
    k += n || 1;
  }
  if (best[0] < 0) return groups.join(':');
  return `${groups.slice(0, best[0]).join(':')}::${groups.slice(best[0] + best[1]).join(':')}`;
};

/**
 * A room as the page's network controller drives a client (web/app/network.ts): the `Tailscale` handle tailcat's has
 * too, with a network map of the room (`via: 'room'`): the guest's address, the member's name to give out, the peers
 * reached. What a room doesn't have (exit nodes, logging out) is refused or nothing.
 */
export function startRoomNet(c: RoomNetConfig, onEvent: (m: FromTailscale) => void = () => {}): Tailscale {
  let state = '';
  let netmap: NetMap | undefined;
  let lease: Lease | null = null;
  let me: { name?: string; link?: string; address6: number[] } | undefined;
  let directBlocked = false;
  const peers = new Map<string, { name: string; address6: number[] }>();
  let resolveRunning: (n: NetMap) => void = () => {};
  const map = (): NetMap | undefined => {
    if (!lease || !me) return undefined;
    return {
      name: me.name ?? '', via: 'room', mtu: lease.mtu, exitNode: '', domains: lease.domains ?? [],
      addresses: lease.address6 ? [`${v6text(lease.address6)}/128`] : [],
      dns: (lease.dns6 ?? []).map(v6text),
      peers: [...peers.entries()].map(([key, p]) => ({ id: key, name: p.name, addresses: [`${v6text(p.address6)}/128`], exitNodeOption: false })),
      room: { name: me.name ?? '', link: me.link ?? c.link, incoming: c.incoming !== false, relayOnly: !!c.relayOnly, directBlocked },
    };
  };
  const changed = () => {
    netmap = map();
    if (!netmap) return;
    onEvent({ type: 'netmap', netmap });
    if (state === 'Running') resolveRunning(netmap);
  };
  const r = startRoom(
    { room: { link: c.link, incoming: c.incoming, relayOnly: c.relayOnly }, derpMapURL: c.derpMapURL, identityKey: c.identityKey, identity: c.identity, iceServers: c.iceServers, wasm: c.wasm, ip: c.ip },
    (ev) => {
      if (ev.type === 'log') return;
      if (ev.type === 'state') {
        if (ev.state === 'Failed') return; // the worker's error follows
        state = ev.state;
        onEvent({ type: 'state', state });
        if (state === 'Running' && netmap) resolveRunning(netmap);
        return;
      }
      if (ev.type === 'self') me = ev;
      else if (ev.type === 'lease') lease = ev.lease;
      else if (ev.type === 'peer') peers.set(ev.key, { name: ev.name ?? '', address6: ev.address6 });
      else if (ev.type === 'peer-gone') peers.delete(ev.key);
      else if (ev.type === 'direct') directBlocked = ev.blocked;
      else return;
      changed();
    },
    (error) => onEvent({ type: 'error', error }),
  );
  const running = new Promise<NetMap>((resolve, reject) => {
    resolveRunning = resolve;
    r.running.catch(reject);
  });
  running.catch(() => {});
  return {
    ip: r.ip, state: () => state, netmap: () => netmap, loginURL: () => undefined, running, timings: r.timings,
    attach: r.attach, setPrimary: r.setPrimary, detach: r.detach,
    setExitNode: () => Promise.reject(new Error('a room has no exit nodes')),
    setAcceptRoutes: () => {},
    logout: () => Promise.resolve(),
    close: r.close,
  };
}
