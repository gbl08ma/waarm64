// The browser's network connections (docs/plans/network-adapters.md §2): web/app/connections.ts's records, stored
// and ephemeral, their state forgotten with them, the Attach wizard's preselection, the migration of the single
// connection the page kept before (planted: a kept node's prefix rewritten, so the node would log in again), and their
// locks between two "tabs" (two Stores on one BroadcastChannel); in Chromium, the store's upgrade to `connections` over
// a database the page made before, and the kept profiles read from `webpc-tailscale`.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { chromium, type Browser } from 'playwright-core';
import { startServer } from '../tools/serve.ts';
import { connectionLock, Connections, defaultName, migrateLegacy, preselect, type Connection } from '../web/app/connections.ts';
import { Locks } from '../web/app/locks.ts';
import { DEFAULT_SETTINGS } from '../web/app/network.ts';
import { memoryFiles, memoryRecords, Store } from '../web/app/store.ts';
import { profilesOf } from '../web/tailscale-state.ts';

const store = (channel: string | false = false) => new Store(memoryRecords(), memoryFiles(), { channel });
const fakeState = () => {
  const forgot: string[] = [];
  return { forgot, state: { forgetTailnet: async (k: string) => { forgot.push(`tailnet:${k}`); }, forgetTailcat: async (k: string) => { forgot.push(`tailcat:${k}`); } } };
};

test('connections: stored and ephemeral, their names and state keys, deleted with their state', async () => {
  const s = store();
  const { forgot, state } = fakeState();
  const conns = new Connections(s, state);
  const ts = await conns.create({ kind: 'tailnet', tailnet: { controlURL: 'https://controlplane.tailscale.com', hostname: 'webpc', exitNode: '' } });
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
  assert.deepEqual((await conns.list()).map((c) => c.id), [ts.id, ts2.id]);
  assert.equal(defaultName({ kind: 'tailnet', tailnet: { controlURL: 'http://127.0.0.1:8080', hostname: '', exitNode: '' } }), '127.0.0.1:8080');
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
  assert.deepEqual([ts.tailnet?.hostname, ts.tailnet?.exitNode, ts.connectAtStart], ['webpc', '', false]);
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
  const channel = `webpc-net-test-${process.pid}`;
  const [a, b] = [store(channel), store(channel)];
  const released: string[] = [];
  const locksA = new Locks(a, 'net', () => 'Machine A', (lock) => { released.push(lock); locksA.drop(lock); });
  const locksB = new Locks(b, 'net', () => 'Machine B', () => {});
  const usb = new Locks(b, 'usb', () => 'Machine B (USB)', () => { throw new Error('a net note reached the USB locks'); });
  try {
    const lock = connectionLock('a00000000001');
    assert.equal(lock, 'webpc-net:a00000000001');
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
      const o = indexedDB.open('webpc', 1);
      o.onupgradeneeded = () => { for (const k of ['machines', 'disks', 'overlays', 'snapshots']) o.result.createObjectStore(k, { keyPath: 'id' }); };
      o.onsuccess = () => resolve(o.result);
      o.onerror = () => reject(o.error);
    });
    await idb(old.transaction('machines', 'readwrite').objectStore('machines').put({ id: 'aaaaaaaaaaaa', name: 'Brisk Heron' }));
    // A kept node, as the page kept it before connections.
    const ts = await new Promise<IDBDatabase>((resolve, reject) => {
      const o = indexedDB.open('webpc-tailscale', 1);
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
    const { Store, idbRecords, memoryFiles } = await import('/web/app/store.ts' as string);
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
