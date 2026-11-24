// A room's worker (web/room.ts, docs/networking/rooms.md): the Rust client (net/ts, room.rs) of one room's
// member, its packets on the gateway's IP port. The page holds the WebRTC connections (Chromium has no
// RTCPeerConnection in workers) and transfers each one's data channel here as it makes it, so the peers'
// packets never touch the page's thread; descriptions and candidates pass through.
import { toWire } from './msg.ts';
import { failureOf, TsClient, TsModule } from './ts-client.ts';
import { ranked, routedLease, type Lease, type Prefix } from './gateway.ts';
import {
  parseRoomLink,
  roomIdentity,
  roomNamesStore,
  type FromRoom,
  type RoomNamesStore,
  type ToRoom,
} from './room.ts';
import { idbNamesStore, NAMES_CHANNEL, roomTitles } from './names-store.ts';
import { serviceFetch } from './names-fetch.ts';
import { namesOp } from './names-ops.ts';
import { ipPortHost } from './ts-port.ts';

const post = (m: FromRoom) => self.postMessage(m);

let lease: (Lease & { prefix6?: Prefix }) | null = null;
let client: TsClient | undefined;
/** A stored connection's registry records (web/room.ts `roomNamesStore`); an ephemeral one keeps none. */
let names: RoomNamesStore | undefined;
/** The names agent's word that a connection's titles changed (web/names.ts): the running room's are given again. */
let titlesChannel: BroadcastChannel | undefined;
/** On another adapter, the room offers its /48 only (docs/networking/adapters.md §4). */
const port = ipPortHost(
  ({ primary, primary6, rank }) =>
    ranked(routedLease(lease, primary, { v4: [], v6: lease?.prefix6 ? [lease.prefix6] : [] }, primary6), rank),
  (packets) => client?.guest(...packets),
);

self.onmessage = async (e: MessageEvent<ToRoom>) => {
  const m = e.data;
  switch (m.type) {
    case 'attach':
      return port.attach(m.ip);
    case 'primary':
      return port.place(m);
    case 'rtc-channel':
      return client?.rtcChannel(m.rtc, m.channel);
    case 'rtc-signal':
      return client?.rtcSignal(m.rtc, m.json);
    case 'rtc-closed':
      return client?.rtcClosed(m.rtc);
    case 'rtc-blocked':
      return client?.rtcBlocked(m.blocked);
    case 'detach': {
      titlesChannel?.close();
      // The client closes: the next start joins again.
      lease = null;
      const ip = port.detach();
      client?.close();
      client = undefined;
      // What waits for the names store is written before the page goes on (it may close the worker next).
      const store = names;
      names = undefined;
      await store?.flush();
      self.postMessage({ type: 'detached', ip } satisfies FromRoom, ip ? [ip] : []);
      return;
    }
    case 'close': {
      titlesChannel?.close();
      client?.close();
      client = undefined;
      const store = names;
      names = undefined;
      await store?.flush();
      return post({ type: 'closed' });
    }
    case 'start':
      break;
  }
  try {
    port.attach(m.ip);
    const t0 = performance.now();
    const mod = await TsModule.load(m.wasm);
    post({ type: 'loaded', ms: performance.now() - t0 });
    if (!port.attached()) return; // detached meanwhile
    // The kept identity (docs/networking/adapters.md §2.1): the same address and name each time it joins.
    const id = m.identity ?? (m.identityKey !== undefined ? await roomIdentity(m.identityKey) : undefined);
    // The room's registry records, streamed in before the first tick (docs/networking/tailnet.md "The module").
    const parsed = parseRoomLink(m.config.room.link);
    // The connection's titles (the names agent's, web/names.ts): with them the node serves the room's names.
    const ids = m.identityKey;
    const titlesOf = async () =>
      ids !== undefined && 'room' in parsed
        ? roomTitles(idbNamesStore(), (op, input) => namesOp(mod, op, input), ids, parsed.room.id).catch(() => [])
        : [];
    const titles = await titlesOf();
    const withKey = id ? { ...m.config, key: id.key } : m.config;
    const config = titles.length
      ? { ...withKey, room: { ...withKey.room, names: { ...withKey.room.names, titles } } }
      : withKey;
    // A stored connection's records only: an ephemeral one (its key in memory, `identity`) would leave its own when its
    // page closes, under an id nothing names again. One on a stored connection's key (no `identity`) keeps that one's.
    const store =
      m.identityKey !== undefined && !m.identity && 'room' in parsed
        ? await roomNamesStore(parsed.room.id, m.identityKey).catch(() => undefined)
        : undefined;
    const records = (await store?.load().catch(() => undefined)) ?? [];
    if (!port.attached()) return; // detached meanwhile
    names = store;
    client = new TsClient(mod, config, {
      namesStore: (k, record) => names?.write(k, record),
      // A server's asks outside the room: the compiled calendars and explorers only (web/names.ts `serviceFetch`).
      namesFetch: (fid, url) => {
        const asker = client; // an answer that comes after a restart isn't the new client's
        void serviceFetch(url).then((r) => {
          if (asker && client === asker) asker.namesFetched(fid, r.status, r.body);
        });
      },
      packet: (p) => port.send(p),
      rtc: {
        open: (rtc, offer) => post({ type: 'rtc-open', rtc, offer }),
        signal: (rtc, json) => post({ type: 'rtc-signal', rtc, json }),
        close: (rtc) => post({ type: 'rtc-close', rtc }),
      },
      event(ev) {
        if (ev.type === 'log') return console.log('room:', ev.msg);
        if (ev.type === 'lease') {
          lease = ev.lease;
          port.postLease();
        }
        if (ev.type === 'state' && ev.state === 'Failed') return post({ type: 'error', error: toWire(failureOf(ev)) });
        post({ type: 'event', event: ev });
      },
    });
    // Before the first tick (the timer the constructor set fires later): one the module doesn't take is deleted.
    for (const r of records) if (!client.namesLoad(r.record)) names?.write(r.id, null);
    if (ids !== undefined) {
      try {
        titlesChannel = new BroadcastChannel(NAMES_CHANNEL);
        titlesChannel.onmessage = async (e: MessageEvent<{ identityKey: string }>) => {
          if (e.data.identityKey !== ids || !client) return;
          const now = await titlesOf();
          client?.namesTitles(now);
        };
      } catch {
        /* no channel: the titles at the start */
      }
    }
  } catch (err) {
    post({ type: 'error', error: toWire(err) });
  }
};
