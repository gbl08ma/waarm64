// A room from the page's side (docs/plans/networking-p2p.md, docs/tailnet.md "Rooms"): the client
// (net/ts, room.rs) in its own worker (web/room-worker.ts), and the WebRTC connections it asks for,
// which live here because Chromium has no RTCPeerConnection in workers. Each connection's data channel
// is negotiated (id 0, unordered, no retransmits: WireGuard's packets, which tolerate loss) and
// transferred to the worker as it's made, before anything is sent on it; descriptions and candidates
// travel inside the WireGuard tunnel, so a peer sees this machine's candidates only after a handshake
// with the room's key.
import type { Lease } from './gateway.ts';
import { fromWire, type WireError } from './msg.ts';
import type { RoomConfig, TsEvent } from './ts-client.ts';

/** STUN only (no TURN: DERP is the relay). */
export const STUN_SERVERS: RTCIceServer[] = [{ urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302'] }];

export type StartRoom = RoomConfig & {
  /** The ICE servers (default STUN_SERVERS). */
  iceServers?: RTCIceServer[];
  /** Where target/net/ts.wasm is served from (default: this checkout's target/net). */
  wasm?: string;
  /** The gateway's end of the IP port (transferred); default: a new channel, whose device end is `ip`. */
  ip?: MessagePort;
};

export type ToRoom =
  | { type: 'start'; wasm: string; config: RoomConfig; ip: MessagePort }
  | { type: 'attach'; ip: MessagePort }
  | { type: 'primary'; primary: boolean; rank?: number }
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
  /** This member's node key, address and the room's tag, once known. */
  self(): { key: string; address6: number[]; tag?: string } | undefined;
  lease(): Lease | null;
  /** The peers whose data decrypted, and the path each one's packets take. */
  peers(): RoomPeer[];
  /** Resolves when the client is `Running`; rejects if the worker fails. */
  running: Promise<void>;
  timings(): { loadMs?: number; runningMs?: number };
  attach(ip: MessagePort): void;
  setPrimary(primary: boolean, rank?: number): void;
  detach(): Promise<MessagePort | undefined>;
  /** Closes every WebRTC connection, as a failed path would (the tests' fallback to DERP). */
  dropDirect(): void;
  close(): void;
};

/** A connection the worker asked for. */
type Conn = { pc: RTCPeerConnection; pending: RTCIceCandidateInit[] | null };

export function startRoom(config: StartRoom, onEvent: (e: TsEvent) => void = () => {}): Room {
  const worker = new Worker(new URL('./room-worker.ts', import.meta.url), { type: 'module' });
  const own = config.ip ? undefined : new MessageChannel();
  const port1 = config.ip ?? own!.port1;
  const conns = new Map<number, Conn>();
  const peers = new Map<string, RoomPeer>();
  let state = '';
  let me: { key: string; address6: number[]; tag?: string } | undefined;
  let lease: Lease | null = null;
  let detached: ((ip?: MessagePort) => void) | undefined;
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
    pc.onicecandidate = (e) => { if (e.candidate && conns.get(rtc) === c) signal(rtc, e.candidate.toJSON()); };
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
    const v = JSON.parse(json) as RTCSessionDescriptionInit & RTCIceCandidateInit;
    try {
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
        case 'error': reject(fromWire(m.error)); break;
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
          onEvent(ev);
        }
      }
    };
  });
  running.catch(() => {});
  const wasm = config.wasm ?? new URL('../target/net/ts.wasm', import.meta.url).href;
  const { room, derpMapURL, key } = config;
  post({ type: 'start', wasm, config: { room, derpMapURL, key }, ip: port1 }, [port1]);
  return {
    ip: own?.port2, state: () => state, self: () => me, lease: () => lease, peers: () => [...peers.values()],
    running, timings: () => timings,
    attach: (ip) => post({ type: 'attach', ip }, [ip]),
    setPrimary: (primary, rank) => post({ type: 'primary', primary, rank }),
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
