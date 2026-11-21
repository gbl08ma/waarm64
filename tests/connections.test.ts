// The browser's network connections (docs/networking/adapters.md §2): web/app/connections.ts's records, stored
// and ephemeral, their state forgotten with them, the Attach wizard's preselection, the migration of the single
// connection the page kept before (planted: a kept node's prefix rewritten, so the node would log in again), and their
// locks between two "tabs" (two Stores on one BroadcastChannel); in Chromium, the store's upgrade to `connections` over
// a database the page made before, and the kept profiles read from `waarm64-tailscale`.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { chromium, type Browser } from 'playwright-core';
import { startServer } from '../tools/serve.ts';
import { connectionLock, Connections, defaultName, migrateLegacy, preselect, type Connection } from '../web/app/connections.ts';
import { newRoomIdentity, parseRoomKey } from '../web/room.ts';
import { connectOf } from '../web/app/net-connect.ts';
import { Locks } from '../web/app/locks.ts';
import { DEFAULT_SETTINGS } from '../web/app/network.ts';
import { Store } from '../web/app/store.ts';
import { memoryFiles, memoryRecords } from '../web/app/store-backends.ts';
import { profilesOf } from '../web/tailscale-state.ts';
import { t } from '../web/i18n.ts';
import { exportNames, importNames } from '../web/names-export.ts';
import { memoryNamesStore, type TitleRecord } from '../web/names-store.ts';
import { parseRoomExport } from '../web/names.ts';

const store = (channel: string | false = false) => new Store(memoryRecords(), memoryFiles(), { channel });
const fakeState = () => {
  const forgot: string[] = [];
  /** The names kept under a key, forgotten with it (web/names.ts's stores: `heldNames`, `forgetNames`). */
  const namesForgot: string[] = [];
  /** `waarm64-room`'s entries: what a room connection's first start keeps, and pasted keys. */
  const rooms = new Map<string, { key: string }>();
  return {
    forgot, rooms, namesForgot,
    state: {
      forgetTailnet: async (k: string) => { forgot.push(`tailnet:${k}`); }, forgetTailcat: async (k: string) => { forgot.push(`tailcat:${k}`); },
      forgetRoom: async (k: string) => { forgot.push(`room:${k}`); rooms.delete(k); },
      readRoom: async (k: string) => rooms.get(k), keepRoom: async (k: string, i: { key: string }) => { rooms.set(k, i); },
      roomIdentity: async (k: string) => { if (!rooms.has(k)) rooms.set(k, newRoomIdentity()); return rooms.get(k)!; },
      forgetNames: async (k: string) => { namesForgot.push(k); },
    },
  };
};

test('connections: stored and ephemeral, their names and state keys, deleted with their state', async () => {
  const s = store();
  const { forgot, state } = fakeState();
  const conns = new Connections(s, state);
  const ts = await conns.create({ kind: 'tailnet', tailnet: { controlURL: 'https://controlplane.tailscale.com', hostname: 'waarm64', exitNode: '' } });
  const hs = await conns.create({ kind: 'tailnet', tailnet: { controlURL: 'https://hs.example.com', hostname: 'box', exitNode: '' } });
  const ts2 = await conns.create({ kind: 'tailnet' });
  const cat = await conns.create({ kind: 'tailcat', tailcat: { exit: 'tcAAAA', serve: true, relay: '' } });
  const eph = await conns.create({ kind: 'tailcat', ephemeral: true, tailcat: { serve: true, relay: '' } });
  assert.deepEqual([ts.name, hs.name, ts2.name, cat.name, eph.name], ['Tailscale', 'hs.example.com', 'Tailscale (2)', 'tailcat', 'tailcat (2)']);
  assert.equal(ts2.tailnet?.controlURL, 'https://controlplane.tailscale.com', 'a tailnet without settings is Tailscale\'s');
  // Two connections to one tailnet are two nodes: each has its own profile.
  assert.equal(ts.tailnet?.stateKey, ts.id);
  assert.notEqual(ts.tailnet?.stateKey, ts2.tailnet?.stateKey);
  assert.equal(cat.tailcat?.identityKey, cat.id);
  assert.equal(cat.tailcat?.identity, undefined, 'a stored connection\'s identity is the client\'s to keep');
  assert.match(eph.tailcat?.identity?.key ?? '', /^[0-9a-f]{64}$/, 'an ephemeral one has its own, in memory');
  assert.equal(cat.tailcat?.exit, 'tcAAAA', 'a stored connection keeps the address it goes online through');
  // Ephemeral ones aren't in the store; this page lists them with the rest.
  assert.deepEqual((await s.all('connections')).map((c) => c.id).sort(), [ts.id, hs.id, ts2.id, cat.id].sort());
  assert.deepEqual((await conns.list()).map((c) => c.id).sort(), [ts, hs, ts2, cat, eph].map((c) => c.id).sort());
  assert.equal((await new Connections(s).list()).length, 4, 'another page doesn\'t have this one\'s ephemeral connections');
  // Edits go back where the connection lives.
  await conns.put({ ...eph, name: 'Mine' });
  await conns.touch(hs.id, 1234);
  assert.equal((await conns.get(eph.id))?.name, 'Mine');
  assert.equal((await s.get('connections', hs.id))?.lastUsed, 1234);
  // Deleting forgets the state: the next connection made is a new node.
  await conns.delete(hs.id);
  await conns.delete(cat.id);
  await conns.delete(eph.id);
  assert.deepEqual(forgot, [`tailnet:${hs.id}`, `tailcat:${cat.id}`]);
  assert.deepEqual((await conns.list()).map((c) => c.id).sort(), [ts.id, ts2.id].sort());
  assert.equal(defaultName({ kind: 'tailnet', tailnet: { controlURL: 'http://127.0.0.1:8080', hostname: '', exitNode: '' } }), '127.0.0.1:8080');
  // The local helper: its link (with the token) kept in a stored connection, nothing kept elsewhere to forget.
  const here = await conns.create({ kind: 'local', local: { url: 'ws://127.0.0.1:8740/tok' } });
  assert.equal(here.name, t('network:connections.thisComputer'));
  assert.deepEqual((await s.get('connections', here.id))?.local, { url: 'ws://127.0.0.1:8740/tok' });
  assert.deepEqual(connectOf(here), { controlURL: '', hostname: '', local: 'ws://127.0.0.1:8740/tok' });
  await conns.delete(here.id);
  assert.deepEqual(forgot, [`tailnet:${hs.id}`, `tailcat:${cat.id}`]);
});

test('rooms: named by the room, a key of their own or another connection\'s, forgotten when no other connection shares it', async () => {
  const s = store();
  const { forgot, namesForgot, state } = fakeState();
  const conns = new Connections(s, state);
  const link = 'waarm64-room:gabriel-lan';
  const pub = await conns.create({ kind: 'room', room: { link, incoming: true, relayOnly: false } });
  const priv = await conns.create({ kind: 'room', room: { link: 'waarm64-room:work-abcdefghijklmnopqrstuvwxyz?derp=7', incoming: false, relayOnly: true } });
  // The same key in another room: its entry in waarm64-room is the first one's.
  const shared = await conns.create({ kind: 'room', room: { link: 'waarm64-room:other', incoming: true, relayOnly: false, keyOf: pub.id } });
  const eph = await conns.create({ kind: 'room', ephemeral: true, room: { link, incoming: true, relayOnly: false } });
  const ephShared = await conns.create({ kind: 'room', ephemeral: true, room: { link: 'waarm64-room:third', incoming: true, relayOnly: false, keyOf: pub.id } });
  assert.deepEqual([pub.name, priv.name, shared.name, eph.name], ['gabriel-lan', 'work', 'other', 'gabriel-lan (2)'], 'named by the room, a private one without its suffix');
  assert.equal(pub.room?.identityKey, pub.id);
  assert.equal(pub.room?.identity, undefined, 'a stored connection\'s key is the client\'s to keep');
  assert.equal(shared.room?.identityKey, pub.id, 'sharing a key shares its entry');
  assert.equal(ephShared.room?.identityKey, pub.id, 'an ephemeral connection may share a stored one\'s key');
  assert.equal(ephShared.room?.identity, undefined);
  assert.match(eph.room?.identity?.key ?? '', /^[0-9a-f]{64}$/, 'an ephemeral one has its own, in memory');
  assert.ok(!('keyOf' in (await s.get('connections', shared.id))!.room!), 'the choice isn\'t kept, only the key it names');
  assert.deepEqual(connectOf(priv), { controlURL: '', hostname: '', room: { link: priv.room!.link, incoming: false, relayOnly: true, identityKey: priv.id, identity: undefined } });
  // A key another connection shares stays until the last one using it is deleted, ephemeral or not.
  assert.equal(await conns.sharesKey(pub), true);
  await conns.delete(pub.id);
  await conns.delete(shared.id);
  assert.deepEqual(forgot, [], 'shared: kept');
  await conns.delete(ephShared.id);
  assert.deepEqual(forgot, [`room:${pub.id}`], 'the last one using it forgets it');
  await conns.delete(priv.id);
  await conns.delete(eph.id);
  assert.deepEqual(forgot, [`room:${pub.id}`, `room:${priv.id}`], 'a key of its own is forgotten; an ephemeral one\'s own is in memory');
  // The names kept under a key go with it, at the same time (the delete said so first: web/app/areas/network-actions.ts).
  assert.deepEqual(namesForgot, [pub.id, priv.id, eph.id], 'names: with the last one that uses their key');
});

test("rooms: another tab's ephemeral connection on a stored one's key keeps it through Delete and New name", async () => {
  // Two Connections on one store: two tabs (Node's Web Locks are the process's, as a browser's are the origin's).
  const s = store();
  const { forgot, state } = fakeState();
  const [tab1, tab2] = [new Connections(s, state), new Connections(s, state)];
  const link = 'waarm64-room:lobby';
  const stored = await tab1.create({ kind: 'room', room: { link, incoming: true, relayOnly: false } });
  const eph = await tab2.create({ kind: 'room', ephemeral: true, room: { link: 'waarm64-room:other', incoming: true, relayOnly: false, keyOf: stored.id } });
  assert.equal(eph.room!.identityKey, stored.id);
  assert.equal(await tab1.sharesKey(stored), true, "tab 1 sees tab 2's");
  assert.equal(await tab2.sharesKey(eph), true);
  // New name in tab 1: its own entry from now on; tab 2's keeps the old one.
  await tab1.newRoomKey(stored as typeof stored & { room: NonNullable<typeof stored.room> });
  assert.deepEqual(forgot, [], 'shared: kept');
  const renamed = (await tab1.get(stored.id))!;
  assert.notEqual(renamed.room!.identityKey, stored.id);
  assert.equal(await tab1.sharesKey(renamed), false);
  assert.equal(await tab2.sharesKey(eph), false, 'only its own hold on it now');
  // Delete in tab 1 forgets only its new entry; the last one using the old entry, in tab 2, forgets that.
  await tab1.delete(stored.id);
  assert.deepEqual(forgot, [`room:${renamed.room!.identityKey}`]);
  await tab2.delete(eph.id);
  assert.deepEqual(forgot, [`room:${renamed.room!.identityKey}`, `room:${stored.id}`]);
  // And Delete with tab 2's still running keeps the entry.
  const again = await tab1.create({ kind: 'room', room: { link, incoming: true, relayOnly: false } });
  const eph2 = await tab2.create({ kind: 'room', ephemeral: true, room: { link, incoming: true, relayOnly: false, keyOf: again.id } });
  await tab1.delete(again.id);
  assert.equal(forgot.length, 2, 'in use by tab 2: kept');
  await tab2.delete(eph2.id);
  assert.deepEqual(forgot.at(-1), `room:${again.id}`);
});

test('rooms: a pasted key is kept as the new connection\'s, or is the connection\'s that has it', async (ctx) => {
  // A key's holder is the oldest connection that has it (`list`: by `created`, then by the random id): a clock that
  // ticks at each read keeps two connections made in one millisecond in the order they were made.
  let now = Date.now();
  ctx.mock.method(Date, 'now', () => ++now);
  const { rooms, state } = fakeState();
  const conns = new Connections(store(), state);
  const link = 'waarm64-room:lobby';
  const [k1, k2, k3] = ['1', '2', '3'].map((d) => d.repeat(64));
  const stored = await conns.create({ kind: 'room', room: { link, incoming: true, relayOnly: false, key: k1 } });
  assert.equal(stored.room!.identityKey, stored.id);
  assert.equal(stored.room!.identity, undefined, 'stored: in waarm64-room, not the record');
  assert.deepEqual(rooms.get(stored.id), { key: k1 });
  assert.equal(Object.hasOwn(stored.room!, 'key'), false, 'the key is not in the record');
  const eph = await conns.create({ kind: 'room', ephemeral: true, room: { link, incoming: true, relayOnly: false, key: k2 } });
  assert.deepEqual(eph.room!.identity, { key: k2 }, 'ephemeral: in memory');
  assert.equal(rooms.has(eph.id), false);
  // The same key again is that connection's: one entry, so one lock (roomKeyLock) between them.
  const again = await conns.create({ kind: 'room', room: { link: 'waarm64-room:other', incoming: true, relayOnly: false, key: k1 } });
  assert.equal(again.room!.identityKey, stored.id);
  assert.equal(rooms.has(again.id), false);
  assert.equal(await conns.keyLock(again.room!), await conns.keyLock(stored.room!));
  // A key kept by a connection's first start (not pasted) is found as well, and an ephemeral one's, which a stored
  // connection keeps in its own entry (never in its record), on the same lock.
  const plain = await conns.create({ kind: 'room', room: { link, incoming: true, relayOnly: false } });
  rooms.set(plain.id, { key: k3 });
  assert.equal((await conns.create({ kind: 'room', room: { link, incoming: true, relayOnly: false, key: k3 } })).room!.identityKey, plain.id);
  const ofEph = await conns.create({ kind: 'room', room: { link, incoming: true, relayOnly: false, key: k2 } });
  assert.equal(ofEph.room!.identity, undefined);
  assert.deepEqual(rooms.get(ofEph.id), { key: k2 });
  assert.equal(await conns.keyLock(ofEph.room!), await conns.keyLock(eph.room!));
  assert.deepEqual((await conns.create({ kind: 'room', ephemeral: true, room: { link, incoming: true, relayOnly: false, key: k2 } })).room!.identity, { key: k2 }, 'ephemeral too: its key');
  // `keyOf` wins over a pasted key.
  const of = await conns.create({ kind: 'room', room: { link, incoming: true, relayOnly: false, keyOf: plain.id, key: k1 } });
  assert.equal(of.room!.identityKey, plain.id);
});

test("rooms: a stored connection made with an ephemeral one's key keeps it in waarm64-room, never in its record, and New name changes it", async () => {
  const { state } = fakeState();
  const s = store();
  const conns = new Connections(s, state);
  const link = 'waarm64-room:lobby';
  const eph = await conns.create({ kind: 'room', ephemeral: true, room: { link, incoming: true, relayOnly: false } });
  const key = eph.room!.identity!.key;
  /** The key a start of connection `c` uses (web/room-worker.ts: `identity`, else the one under `identityKey`). */
  const used = async (c: Connection) => c.room!.identity?.key ?? (await state.roomIdentity(c.room!.identityKey)).key;
  for (const how of [{ key }, { keyOf: eph.id }]) {
    const stored = await conns.create({ kind: 'room', room: { link: 'waarm64-room:other', incoming: true, relayOnly: false, ...how } });
    const record = (await s.get('connections', stored.id))!;
    assert.equal(record.room!.identity, undefined, `${JSON.stringify(Object.keys(how))}: no key in the stored record`);
    assert.equal(await used(record), key, 'the same key, in waarm64-room');
    await conns.newRoomKey({ ...record, room: record.room! });
    const renamed = (await conns.get(stored.id))!;
    assert.notEqual(await used(renamed), key, 'New name: a new key');
    assert.equal(await used((await conns.get(eph.id))!), key, 'the ephemeral one keeps its own');
  }
});

test('rooms: a connection\'s export carries its names (the owners\' secret and titles), which the connection made from it in another browser holds', async () => {
  // Two browsers: each its connections, its waarm64-room (keys, and the names agent's stores).
  const browser = () => {
    const { state, rooms } = fakeState();
    const names = memoryNamesStore();
    return { rooms, names, conns: new Connections(store(), { ...state, exportNames: (k) => exportNames(names, k), keepNames: (k, b) => importNames(names, k, b) }) };
  };
  const a = browser();
  const link = 'waarm64-room:lobby';
  const c = await a.conns.create({ kind: 'room', room: { link, incoming: true, relayOnly: false } });
  assert.equal(await a.conns.exportKey(c), '', 'no key before its first start');
  const key = (await a.rooms.get(c.id)) ?? { key: '7'.repeat(64) };
  a.rooms.set(c.id, key);
  assert.equal(await a.conns.exportKey(c), key.key, 'no names: the key alone');
  // A title registered (the agent's record, as web/names.ts keeps it).
  await a.names.addSecret(c.room!.identityKey, '5'.repeat(64));
  const title: TitleRecord = {
    identityKey: c.room!.identityKey, room: 'lobby', link, name: 'test123', item: '02aa', stamps: {}, collect: {},
    points: [{ label: null, key: 'ab'.repeat(32) }], zone: { n: 3, branch: 9 }, made: 1,
  };
  await a.names.put(title);
  const exported = await a.conns.exportKey(c);
  const parsed = parseRoomExport(exported);
  assert.equal(parsed?.key, key.key);
  assert.ok(parsed?.names);
  // Pasted in another browser: the key, the owners' secret and the title are the new connection's.
  const b = browser();
  const d = await b.conns.create({ kind: 'room', room: { link, incoming: true, relayOnly: false, key: parsed.key, names: parsed.names } });
  assert.deepEqual(b.rooms.get(d.id), key);
  assert.equal(Object.hasOwn(d.room!, 'names'), false, 'not in the record');
  assert.equal(await b.names.secret(d.room!.identityKey), '5'.repeat(64));
  const [got] = await b.names.titles(d.room!.identityKey);
  assert.equal(got.item, title.item);
  assert.equal(got.name, 'test123');
  assert.notEqual(got.zone.branch, 9, 'a branch of its own');
  assert.equal((await a.names.titles())[0].zone.branch, 9, 'the exported one keeps its own');
  assert.equal(parseRoomExport('zz'), undefined);
  assert.deepEqual(parseRoomExport(` ${'AB'.repeat(32)} `), { key: 'ab'.repeat(32) });
});

test('pasted room keys: 64 hex digits, spaces around them ignored, lower case', () => {
  assert.equal(parseRoomKey(` ${'AB'.repeat(32)}\n`), 'ab'.repeat(32));
  for (const bad of ['', 'ab'.repeat(31), 'ab'.repeat(33), `${'ab'.repeat(31)}zz`, `${'ab'.repeat(16)} ${'ab'.repeat(16)}`]) assert.equal(parseRoomKey(bad), undefined, bad);
});

test('the Attach wizard preselects the most recently used connection no other machine holds', () => {
  const c = (id: string, lastUsed: number) => ({ id, lastUsed }) as Connection;
  const all = [c('a', 10), c('b', 30), c('c', 20), c('d', 0)];
  assert.equal(preselect(all, () => false), 'b');
  assert.equal(preselect(all, (id) => id === 'b'), 'c');
  assert.equal(preselect([c('d', 0)], () => false), undefined, 'never used: nothing preselected (the wizard offers New connection…)');
});

test("the page's single connection becomes stored ones: the kept nodes and the served address stay as they are", async () => {
  const s = store();
  const conns = new Connections(s);
  const settings = { ...DEFAULT_SETTINGS, controlURL: 'hs.example.com', hostname: 'box', exitNode: 'nEXIT', autoconnect: true, tailcatRelay: 'derp.example.com' };
  const legacy = { settings, profiles: ['https://controlplane.tailscale.com', 'https://hs.example.com'], served: true };
  const made = await migrateLegacy(conns, legacy);
  // The connection the settings were on comes first: a machine's first adapter attaches to it.
  assert.deepEqual(made.map((c) => c.name), ['hs.example.com', 'Tailscale', 'tailcat']);
  const [hs, ts, cat] = made;
  // Planted: a profile rewritten to the connection's id means the kept node is lost and the user logs in again.
  assert.equal(hs.tailnet?.stateKey, 'https://hs.example.com');
  assert.equal(ts.tailnet?.stateKey, 'https://controlplane.tailscale.com');
  assert.deepEqual([hs.tailnet?.hostname, hs.tailnet?.exitNode, hs.connectAtStart], ['box', 'nEXIT', true], 'the settings were this one\'s');
  assert.deepEqual([ts.tailnet?.hostname, ts.tailnet?.exitNode, ts.connectAtStart], ['waarm64', '', false]);
  assert.deepEqual([cat.tailcat?.identityKey, cat.tailcat?.serve, cat.tailcat?.relay, cat.tailcat?.exit, cat.connectAtStart], ['served', true, 'derp.example.com', undefined, false]);
  assert.deepEqual((await s.all('connections')).map((c) => c.tailnet?.stateKey ?? c.tailcat?.identityKey).sort(), ['https://controlplane.tailscale.com', 'https://hs.example.com', 'served']);
  // Again (another tab, a reload before the settings were dropped): nothing new.
  const again = await migrateLegacy(conns, legacy);
  assert.deepEqual(again.map((c) => c.id), made.map((c) => c.id));
  assert.equal((await s.all('connections')).length, 3);
  // A page that was on tailcat, serving only and connecting on load: that one first, and it reconnects.
  const s2 = new Connections(store());
  const cats = await migrateLegacy(s2, { settings: { ...DEFAULT_SETTINGS, kind: 'tailcat', tailcatExit: false, tailcatServe: true, autoconnect: true }, profiles: ['https://controlplane.tailscale.com'], served: true });
  assert.deepEqual(cats.map((c) => [c.kind, c.connectAtStart]), [['tailcat', true], ['tailnet', false]]);
  // Nothing kept, nothing made (the settings alone are no node: a new connection is the wizard's).
  assert.deepEqual(await migrateLegacy(new Connections(store()), { settings, profiles: [], served: false }), []);
  assert.deepEqual(await migrateLegacy(new Connections(store()), { profiles: ['https://controlplane.tailscale.com'], served: false }).then((x) => x.map((c) => c.name)), ['Tailscale']);
});

test('the kept profiles: the prefixes that hold a node', () => {
  assert.deepEqual(profilesOf([
    'https://controlplane.tailscale.com/_machinekey', 'https://controlplane.tailscale.com/_current-profile', 'https://controlplane.tailscale.com/profile-1a2b',
    'http://127.0.0.1:8080/hs/_current-profile', 'https://only-a-key.example/_machinekey', 'a00000000001/_current-profile',
  ]), ['https://controlplane.tailscale.com', 'http://127.0.0.1:8080/hs', 'a00000000001']);
});

test('one running machine has a connection: its lock, who holds it, and asking for it between two tabs', async (t) => {
  if (!globalThis.navigator?.locks) return t.skip('no Web Locks in this Node');
  const channel = `waarm64-net-test-${process.pid}`;
  const [a, b] = [store(channel), store(channel)];
  const released: string[] = [];
  const locksA = new Locks(a, 'net', () => 'Machine A', (lock) => { released.push(lock); locksA.drop(lock); });
  const locksB = new Locks(b, 'net', () => 'Machine B', () => {});
  const usb = new Locks(b, 'usb', () => 'Machine B (USB)', () => { throw new Error('a net note reached the USB locks'); });
  try {
    const lock = connectionLock('a00000000001');
    assert.equal(lock, 'waarm64-net:a00000000001');
    assert.equal(await locksA.take(lock), true);
    assert.equal(await locksB.take(lock), false, 'another tab\'s machine has it');
    assert.equal(await locksB.holder(lock), 'Machine A');
    assert.equal(await locksB.takeFrom(lock), true, 'asked for, let go, taken');
    assert.deepEqual(released, [lock]);
    assert.equal(await locksA.take(lock), false);
    assert.equal(await locksA.holder(lock), 'Machine B');
  } finally {
    for (const l of [locksA, locksB, usb]) l.close();
    a.close();
    b.close();
  }
});

let browser: Browser | undefined;
let base = '';
let close = () => {};
before(async () => {
  const server = await startServer();
  close = () => server.close();
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium' });
});
after(async () => { await browser?.close(); close(); });

test("in Chromium: the store upgrades a database made before connections, keeping its records; the kept profiles are read", async () => {
  const context = await browser!.newContext();
  const page = await context.newPage();
  await page.goto(`${base}/tests/browser/core.html`);
  const r = await page.evaluate(async () => {
    const idb = <T>(req: IDBRequest<T>) => new Promise<T>((resolve, reject) => { req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });
    // Version 1, as the page made it before connections, with a machine in it.
    const old = await new Promise<IDBDatabase>((resolve, reject) => {
      const o = indexedDB.open('waarm64', 1);
      o.onupgradeneeded = () => { for (const k of ['machines', 'disks', 'overlays', 'snapshots']) o.result.createObjectStore(k, { keyPath: 'id' }); };
      o.onsuccess = () => resolve(o.result);
      o.onerror = () => reject(o.error);
    });
    await idb(old.transaction('machines', 'readwrite').objectStore('machines').put({ id: 'aaaaaaaaaaaa', name: 'Brisk Heron' }));
    // A kept node, as the page kept it before connections.
    const ts = await new Promise<IDBDatabase>((resolve, reject) => {
      const o = indexedDB.open('waarm64-tailscale', 1);
      o.onupgradeneeded = () => o.result.createObjectStore('state');
      o.onsuccess = () => resolve(o.result);
      o.onerror = () => reject(o.error);
    });
    const st = ts.transaction('state', 'readwrite').objectStore('state');
    for (const k of ['_machinekey', '_current-profile', 'profile-1a2b']) st.put('00', `https://controlplane.tailscale.com/${k}`);
    await new Promise((r) => { st.transaction.oncomplete = r; });
    ts.close();
    // The old page is still open: the new one's upgrade must not wait for it forever (a newer page asks it to let go).
    old.onversionchange = () => old.close();
    const { Store } = await import('/web/app/store.ts' as string);
    const { idbRecords, memoryFiles } = await import('/web/app/store-backends.ts' as string);
    const { Connections, migrateLegacy } = await import('/web/app/connections.ts' as string);
    const { keptProfiles } = await import('/web/tailscale-state.ts' as string);
    const s = new Store(await idbRecords(), memoryFiles(), { channel: false });
    const conns = new Connections(s);
    const made = await migrateLegacy(conns, { profiles: await keptProfiles(), served: false });
    const s2 = new Store(await idbRecords(), memoryFiles(), { channel: false });
    return { machines: (await s.all('machines')).map((m: { name: string }) => m.name), made: made.map((c: { tailnet?: { stateKey: string } }) => c.tailnet?.stateKey), reread: (await s2.all('connections')).length };
  });
  await context.close();
  assert.deepEqual(r, { machines: ['Brisk Heron'], made: ['https://controlplane.tailscale.com'], reread: 1 });
});
