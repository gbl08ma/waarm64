// A room's worker (web/room.ts, docs/tailnet.md "Rooms"): the Rust client (net/ts, room.rs) of one room's
// member, its packets on the gateway's IP port. The page holds the WebRTC connections (Chromium has no
// RTCPeerConnection in workers) and transfers each one's data channel here as it makes it, so the peers'
// packets never touch the page's thread; descriptions and candidates pass through.
import { toWire } from './msg.ts';
import { batchSender, packetsOf } from './net.ts';
import { failureOf, TsClient, TsModule, type RoomConfig } from './ts-client.ts';
import { ranked, routedLease, type Lease, type Prefix } from './gateway.ts';
import { roomIdentity, type FromRoom, type ToRoom } from './room.ts';

const post = (m: FromRoom) => self.postMessage(m);

let ip: MessagePort | undefined;
let send: ((packet: Uint8Array) => void) | undefined;
let lease: (Lease & { prefix6?: Prefix }) | null = null;
let primary = true;
let rank = 0;
let client: TsClient | undefined;
/** On another adapter, the room offers its /48 only (docs/network-adapters.md §4). */
const offered = () => ranked(routedLease(lease, primary, { v4: [], v6: lease?.prefix6 ? [lease.prefix6] : [] }), rank);

function attach(port: MessagePort) {
  if (ip) { ip.onmessage = null; ip.close(); }
  ip = port;
  send = batchSender(port);
  port.onmessage = (ev: MessageEvent) => {
    const packets = packetsOf(ev.data);
    if (packets) client?.guest(...packets);
  };
  port.postMessage({ type: 'lease', lease: offered() });
}

self.onmessage = async (e: MessageEvent<ToRoom>) => {
  const m = e.data;
  switch (m.type) {
    case 'attach': return attach(m.ip);
    case 'primary':
      primary = m.primary;
      rank = m.rank ?? 0;
      return ip?.postMessage({ type: 'lease', lease: offered() });
    case 'rtc-channel': return client?.rtcChannel(m.rtc, m.channel);
    case 'rtc-signal': return client?.rtcSignal(m.rtc, m.json);
    case 'rtc-closed': return client?.rtcClosed(m.rtc);
    case 'detach':
      lease = null;
      ip?.postMessage({ type: 'lease', lease: null });
      if (ip) ip.onmessage = null;
      client?.close();
      client = undefined;
      self.postMessage({ type: 'detached', ip } satisfies FromRoom, ip ? [ip] : []);
      ip = undefined;
      send = undefined;
      return;
    case 'start':
      break;
  }
  try {
    attach(m.ip);
    const t0 = performance.now();
    const mod = await TsModule.load(m.wasm);
    post({ type: 'loaded', ms: performance.now() - t0 });
    if (!ip) return; // detached meanwhile
    // The kept identity (docs/network-adapters.md §2.1): the same address and name each time it joins.
    const id = m.identity ?? (m.identityKey !== undefined ? await roomIdentity(m.identityKey) : undefined);
    const config = id ? { ...m.config, key: id.key } : m.config;
    if (!ip) return; // detached meanwhile
    client = new TsClient(mod, config, {
      packet: (p) => send?.(p),
      rtc: {
        open: (rtc, offer) => post({ type: 'rtc-open', rtc, offer }),
        signal: (rtc, json) => post({ type: 'rtc-signal', rtc, json }),
        close: (rtc) => post({ type: 'rtc-close', rtc }),
      },
      event(ev) {
        if (ev.type === 'log') return console.log('room:', ev.msg);
        if (ev.type === 'lease') {
          lease = ev.lease;
          ip?.postMessage({ type: 'lease', lease: offered() });
        }
        if (ev.type === 'state' && ev.state === 'Failed') return post({ type: 'error', error: toWire(failureOf(ev)) });
        post({ type: 'event', event: ev });
      },
    });
  } catch (err) {
    post({ type: 'error', error: toWire(err) });
  }
};
