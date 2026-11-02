// The page's machine's network adapters live (web/app/net-live.ts, docs/network-adapters.md §3) with fake
// clients over a memory store: what a connection starts its client with (a stored node kept under its profile, an
// ephemeral one not), connect at start, a connection one machine has at a time (two "tabs" on one channel: the holder
// named, Use it here instead), a restart keeping the clients, another machine stopping them, an attachment whose
// connection is gone detached, and the guest's default way out moving to the adapter that reaches the internet.
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { connectionLock, type Connection } from '../web/app/connections.ts';
import { connectOf, HeldError, PageNetwork } from '../web/app/net-live.ts';
import { t } from '../web/i18n.ts';
import { msgOf, toWire } from '../web/msg.ts';
import type { Adapter } from '../web/app/shape.ts';
import { memoryFiles, memoryRecords, Store } from '../web/app/store.ts';
import type { FromTailscale, NetMap, Tailscale, TailscaleConfig } from '../web/tailscale.ts';
import type { TailcatConfig } from '../web/tailcat.ts';

/** Fake clients: what each was started with, and what was asked of it. */
function clients(onLogout?: () => void) {
  const log: string[] = [];
  const all: { config: TailscaleConfig | TailcatConfig; set(state: string, nm?: NetMap): void; fail(error: string): void }[] = [];
  const make = (kind: string) => (config: TailscaleConfig | TailcatConfig, onEvent: (m: FromTailscale) => void): Tailscale => {
    let state = '';
    let nm: NetMap | undefined;
    let held: MessagePort | undefined = config.ip;
    const n = all.length;
    all.push({ config, set(s, m) { state = s; nm = m; onEvent({ type: 'state', state: s }); }, fail(error) { onEvent({ type: 'error', error: toWire(new Error(error)) }); } });
    log.push(`${kind}${n} start ${'persist' in config ? config.persist ?? '-' : ''}`.trim());
    return {
      state: () => state, netmap: () => nm, loginURL: () => undefined, running: new Promise<NetMap>(() => {}), timings: () => ({}),
      setPrimary: (p) => { log.push(`${kind}${n} primary ${p}`); },
      attach: (ip) => { held = ip; log.push(`${kind}${n} attach`); },
      detach: async () => { log.push(`${kind}${n} detach`); const h = held; held = undefined; return h; },
      setExitNode: async (id) => { log.push(`${kind}${n} exit ${id || '-'}`); },
      setAcceptRoutes: (on) => { log.push(`${kind}${n} routes ${on}`); },
      logout: async () => { log.push(`${kind}${n} logout`); onLogout?.(); },
      close: () => { log.push(`${kind}${n} close`); },
    };
  };
  return { log, all, start: make('ts'), startCat: make('cat') };
}

const MAC = '52:54:00:12:34:56';
const netmap = (over: Partial<NetMap> = {}): NetMap => ({ name: 'g.', addresses: ['100.90.0.2/32'], peers: [{ id: 'nEXIT', name: 'exit', addresses: [], exitNodeOption: true }], mtu: 1280, dns: [], domains: [], exitNode: '', ...over });

const opened: (() => void)[] = [];
after(() => { for (const close of opened) close(); }); // a failed test's pages too

/** A page: its store (on `channel`, shared with the other "tabs"), its network, and what it saved for its machine. */
function pageOn(channel: string, name: string, records = memoryRecords(), kept: string[] = []) {
  const store = new Store(records, memoryFiles(), { channel });
  const c = clients(() => { kept.length = 0; }); // the client forgets the node
  const saved: (string | undefined)[] = [];
  const net = new PageNetwork({ store, me: () => name, onChange: () => {}, save: async (i, id) => { saved[i] = id; }, start: c.start, startCat: c.startCat, kept: async () => kept });
  const close = () => { net.locks.close(); store.close(); };
  opened.push(close);
  return { store, records, net, saved, ...c, close };
}
const tailnet = (net: PageNetwork, o: { ephemeral?: boolean } = {}) => net.conns.create({ kind: 'tailnet', ephemeral: o.ephemeral, tailnet: { controlURL: 'https://hs.example', hostname: 'box', exitNode: '' } });
const adapters = (...conns: (Connection | undefined)[]): Adapter[] => conns.map((c, i) => ({ id: `a${i}`, mac: MAC.replace(/6$/, String(6 + i)), ...(c ? { connection: c.id } : {}) }));

test('a connection starts its client: a stored node under its profile, an ephemeral one not; tailcat with its server, identity and relay', async () => {
  const p = pageOn('nl-what', 'M');
  const { net } = p;
  const kept = await tailnet(net);
  const eph = await tailnet(net, { ephemeral: true });
  assert.deepEqual(connectOf(kept, 'tskey-1'), { controlURL: 'https://hs.example', hostname: 'box', authKey: 'tskey-1', exitNode: undefined, persist: kept.id });
  assert.equal(connectOf(eph).persist, undefined, 'an ephemeral connection is an ephemeral node');
  const cat = await net.conns.create({ kind: 'tailcat', tailcat: { exit: 'tcEXIT', serve: true, relay: 'r.example' } });
  assert.deepEqual(connectOf(cat), { controlURL: '', hostname: '', tailcat: 'tcEXIT', tailcatServe: { relay: '', identityKey: cat.id, identity: undefined } }, "through a server, its relay serves");
  const served = await net.conns.create({ kind: 'tailcat', ephemeral: true, tailcat: { serve: true, relay: 'r.example' } });
  assert.deepEqual(connectOf(served).tailcatServe, { relay: 'r.example', identityKey: served.id, identity: served.tailcat!.identity });
  assert.equal(connectOf(served).tailcat, undefined);
  p.close();
});

test('connect at start, a restart keeping the client, Disconnect turning it off, another machine stopping it', async () => {
  const p = pageOn('nl-start', 'M');
  const c = await tailnet(p.net);
  p.net.ports('m1', adapters(c));
  await p.net.autoconnect();
  assert.equal(p.log[0], `ts0 start ${c.id}`);
  assert.equal(p.net.runs(c.id), 0);
  assert.ok(p.net.locks.mine(connectionLock(c.id)), 'its lock is held');
  const used = await p.net.conns.get(c.id);
  assert.ok(used!.lastUsed > 0 && used!.connectAtStart);

  // A restart: the same client, on the new machine's port.
  p.log.length = 0;
  p.net.ports('m1', adapters(c));
  await p.net.autoconnect();
  assert.deepEqual(p.log.filter((l) => !l.includes('primary')), ['ts0 attach']);

  // Disconnect: it stays off at the next start.
  await p.net.disconnect(0);
  assert.equal((await p.net.conns.get(c.id))!.connectAtStart, false);
  assert.ok(!p.net.locks.mine(connectionLock(c.id)), 'its lock is let go');
  p.net.ports('m1', adapters(c));
  await p.net.autoconnect();
  assert.equal(p.net.views()[0].active, false);

  // Connected again, then another machine opens on the page: the client stops, its lock goes.
  await p.net.connect(0, (await p.net.conns.get(c.id))!);
  p.log.length = 0;
  p.net.ports('m2', adapters());
  await new Promise((r) => setTimeout(r, 10));
  assert.ok(p.log.includes('ts1 detach'), `the client stops: ${p.log}`);
  assert.ok(!p.net.locks.mine(connectionLock(c.id)));
  assert.deepEqual(p.net.views(), []);
  p.close();
});

test('one machine has a connection at a time: another tab is told who has it, and takes it when asked', async () => {
  const a = pageOn('nl-held', 'Machine A');
  const b = pageOn('nl-held', 'Machine B', a.records); // one browser: one IndexedDB
  const c = await tailnet(a.net);
  a.net.ports('ma', adapters(c));
  await a.net.autoconnect();
  b.net.ports('mb', adapters(undefined));
  const held = await b.net.attach(0, (await b.net.conns.get(c.id))!).then(() => undefined, (e) => e);
  assert.ok(held instanceof HeldError, `held: ${held}`);
  assert.equal(held.holder, 'Machine A');
  assert.equal(b.saved[0], c.id, 'attached all the same: it connects when it is free');
  await b.net.refresh();
  assert.ok(b.net.held.has(c.id), 'the Attach wizard marks it held');
  await b.net.takeFrom(0, (await b.net.conns.get(c.id))!);
  assert.equal(b.net.runs(c.id), 0, 'B has it');
  assert.equal(a.net.runs(c.id), -1, 'A let it go');
  assert.equal(a.net.views()[0].note, t('network:net-live.taken', { name: c.name }));
  assert.ok(a.log.includes('ts0 detach'));
  const twice = await b.net.connect(0, (await b.net.conns.get(c.id))!).then(() => 'ok', (e) => String(e));
  assert.equal(twice, 'ok', 'connecting what it has is nothing to do');
  a.close();
  b.close();
});

test('a connection on one adapter only; an attachment whose connection is gone is detached, with a note', async () => {
  const p = pageOn('nl-gone', 'M');
  const c = await tailnet(p.net);
  p.net.ports('m', [...adapters(c), { id: 'a1', mac: '52:54:00:00:00:01', connection: 'ffffffffffff' }]);
  await p.net.autoconnect();
  assert.equal(p.saved[1], undefined);
  assert.ok(1 in p.saved, 'the gone attachment is saved detached');
  assert.equal(p.net.views()[1].note, t('network:net-live.gone'));
  await assert.rejects(p.net.connect(1, c), (e) => msgOf(e)?.key === 'network:net-live.onOtherAdapter' && msgOf(e)?.params?.adapter === 1);
  // Deleting a connection disconnects it here, forgets it and takes it off the adapter.
  await p.net.remove(c);
  assert.equal(await p.net.conns.get(c.id), undefined);
  assert.equal(p.net.views()[0].connection, undefined);
  assert.equal(p.net.views()[0].active, false);
  p.close();
});

test("the guest's default way out: the adapter that reaches the internet, moving as they connect", async () => {
  const p = pageOn('nl-primary', 'M');
  const ts = await tailnet(p.net);
  const cat = await p.net.conns.create({ kind: 'tailcat', tailcat: { exit: 'tcEXIT', serve: false, relay: '' } });
  p.net.ports('m', adapters(ts, cat));
  await p.net.autoconnect();
  assert.equal(p.net.views().findIndex((v) => v.primary), -1, 'none connected yet');
  p.all[0].set('Running', netmap()); // i18n-ignore
  assert.equal(p.net.views().findIndex((v) => v.primary), 0, 'the tailnet without an exit node, the only one up');
  p.all[1].set('Running', { ...netmap(), via: 'tailcat', tailcatExit: true }); // i18n-ignore
  assert.equal(p.net.views().findIndex((v) => v.primary), 1, 'tailcat through a server reaches the internet');
  assert.equal(p.log.filter((l) => l.startsWith('ts0 primary')).at(-1), 'ts0 primary false', 'the tailnet offers its routes only');
  assert.equal(p.log.filter((l) => l.startsWith('cat1 primary')).at(-1) ?? 'cat1 primary true', 'cat1 primary true');
  // The tailnet takes an exit node: it comes first in order, so the default moves to it.
  await p.net.setExitNode(0, 'nEXIT');
  p.all[0].set('Running', netmap({ exitNode: 'nEXIT' })); // i18n-ignore
  assert.equal(p.net.views().findIndex((v) => v.primary), 0);
  assert.equal((await p.net.conns.get(ts.id))!.tailnet!.exitNode, 'nEXIT', 'the exit node is kept with the connection');
  // Subnet routes: on unless turned off, and the choice is kept with the connection too.
  assert.equal((p.all[0].config as TailscaleConfig).acceptRoutes, undefined, 'the default: on');
  await p.net.setAcceptRoutes(0, false);
  assert.ok(p.log.includes('ts0 routes false'));
  assert.equal((await p.net.conns.get(ts.id))!.tailnet!.acceptRoutes, false);
  assert.equal(p.log.filter((l) => l.startsWith('cat1 primary')).at(-1), 'cat1 primary false');
  p.close();
});

test('a machine powered off lets its connections go, and connects them at its next start', async () => {
  const p = pageOn('nl-off', 'M');
  const c = await tailnet(p.net);
  const other = await p.net.conns.create({ kind: 'tailcat', tailcat: { exit: 'tcEXIT', serve: false, relay: '' } });
  p.net.ports('m', adapters(c));
  await p.net.autoconnect();
  p.log.length = 0;
  p.net.machineOff();
  await new Promise((r) => setTimeout(r, 10));
  assert.ok(p.log.includes('ts0 detach'), `the client stops: ${p.log}`);
  assert.ok(!p.net.locks.mine(connectionLock(c.id)), 'its lock is let go');
  assert.equal(p.net.runs(c.id), -1);
  assert.equal((await p.net.conns.get(c.id))!.connectAtStart, true, "it isn't a Disconnect");
  assert.equal(p.net.views()[0].on, false, 'the menu has no Connect to offer');
  await assert.rejects(p.net.connect(0, c), (e) => msgOf(e)?.key === 'network:net-live.off');
  // Attaching stays possible: it is saved, and connects at the start.
  await p.net.attach(0, other);
  assert.equal(p.saved[0], other.id);
  assert.equal(p.net.runs(other.id), -1, 'nothing to connect it to');
  await p.net.attach(0, c);
  p.net.ports('m', adapters(c));
  await p.net.autoconnect();
  assert.equal(p.net.runs(c.id), 0, 'connected again');
  assert.ok(p.net.locks.mine(connectionLock(c.id)));
  p.close();
});

test("a machine powered off keeps an ephemeral tailnet's client: its node would be lost, a login with it", async () => {
  const p = pageOn('nl-off-eph', 'M');
  const c = await tailnet(p.net, { ephemeral: true });
  p.net.ports('m', adapters(c));
  await p.net.autoconnect();
  p.log.length = 0;
  p.net.machineOff();
  await new Promise((r) => setTimeout(r, 10));
  assert.ok(!p.log.includes('ts0 detach'), `the client stays: ${p.log}`);
  p.net.ports('m', adapters(c));
  await p.net.autoconnect();
  assert.deepEqual(p.log.filter((l) => !l.includes('primary')), ['ts0 attach'], 'on the new port');
  p.close();
});

test('attached from another tab to a running machine: it connects at once; detached there, it stops; while off, it waits', async () => {
  const a = pageOn('nl-follow', 'Machine A');
  const b = pageOn('nl-follow', 'Machine B', a.records);
  const c = await tailnet(a.net);
  a.net.ports('ma', adapters(undefined));
  const on = (conn?: Connection) => adapters(conn);
  await a.net.follow(on(c));
  assert.equal(a.net.runs(c.id), 0, 'connected at once');
  assert.equal(a.net.views()[0].connection?.id, c.id);
  // A connection's Disconnect stays off.
  await a.net.follow(on());
  assert.equal(a.net.runs(c.id), -1, 'detached there: it stops');
  assert.ok(!a.net.locks.mine(connectionLock(c.id)));
  await a.net.conns.put({ ...(await a.net.conns.get(c.id))!, connectAtStart: false });
  await a.net.follow(on((await a.net.conns.get(c.id))!));
  assert.equal(a.net.runs(c.id), -1, 'not connecting at start: it waits for Connect');
  await a.net.follow(on());
  await a.net.conns.put({ ...(await a.net.conns.get(c.id))!, connectAtStart: true });
  // One another machine has: the adapter says so.
  b.net.ports('mb', adapters(c));
  await b.net.autoconnect();
  await a.net.follow(on(c));
  assert.equal(a.net.runs(c.id), -1);
  assert.equal(a.net.views()[0].note, t('network:net-live.held', { name: c.name, holder: 'Machine B' }));
  await a.net.follow(on());
  assert.equal(a.net.views()[0].note, undefined);
  await b.net.disconnect(0, false);
  // Powered off: the attachment is taken in, and nothing runs.
  a.net.machineOff();
  await a.net.follow(on(c));
  assert.equal(a.net.runs(c.id), -1);
  assert.equal(a.net.views()[0].connection?.id, c.id);
  a.close();
  b.close();
});

test('adapters reordered: the clients follow their adapters across the restart, locks held', async () => {
  const p = pageOn('nl-order', 'M');
  const ts = await tailnet(p.net);
  const cat = await p.net.conns.create({ kind: 'tailcat', tailcat: { exit: 'tcEXIT', serve: false, relay: '' } });
  const two = adapters(ts, cat);
  p.net.ports('m', two);
  await p.net.autoconnect();
  p.log.length = 0;
  p.net.ports('m', [two[1], two[0]]);
  await p.net.autoconnect();
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(p.log.filter((l) => !l.includes('primary')).sort(), ['cat1 attach', 'ts0 attach'], 'no client stopped or started');
  assert.equal(p.net.runs(cat.id), 0);
  assert.equal(p.net.runs(ts.id), 1);
  assert.deepEqual(p.net.views().map((v) => v.connection?.id), [cat.id, ts.id]);
  assert.ok(p.net.locks.mine(connectionLock(ts.id)) && p.net.locks.mine(connectionLock(cat.id)));
  p.close();
});

/** What `p` came to: 'ok', or its error's message's key (its words, without one). */
const quietly = (p: Promise<unknown>) => p.then(() => 'ok', (e) => msgOf(e)?.key ?? String(e?.message ?? e));

test('a kept node is logged out with no machine running it, and only one that is kept can be', async () => {
  const kept: string[] = [];
  const p = pageOn('nl-kept', 'M', memoryRecords(), kept);
  const c = await tailnet(p.net);
  await p.net.refresh();
  assert.equal(p.net.hasNode(c), false, 'never logged in');
  kept.push(c.tailnet!.stateKey);
  await p.net.refresh();
  assert.equal(p.net.hasNode(c), true);
  const out = p.net.logoutKept(c);
  await new Promise((r) => setTimeout(r, 5));
  assert.ok(p.net.locks.mine(connectionLock(c.id)), 'its lock is held meanwhile');
  assert.equal((p.all[0].config as TailscaleConfig).persist, c.tailnet!.stateKey, 'the node\'s own keys');
  assert.equal((p.all[0].config as TailscaleConfig).authKey, undefined);
  assert.ok(!p.log.includes('ts0 logout'), 'not before the control server has answered: unconnected it would only forget it here');
  p.all[0].set('Connecting'); // i18n-ignore
  p.all[0].set('NeedsLogin');
  assert.ok(!p.log.includes('ts0 logout'), "NeedsLogin without a link is where a client starts");
  p.all[0].set('Running', netmap()); // i18n-ignore
  await out;
  assert.deepEqual(p.log.filter((l) => !l.includes('primary')), [`ts0 start ${c.id}`, 'ts0 logout', 'ts0 close']);
  assert.equal(p.net.hasNode(c), false);
  assert.ok(!p.net.locks.mine(connectionLock(c.id)));
  assert.equal((await p.net.conns.get(c.id))!.connectAtStart, false, 'off at the next start, as a Log out on an adapter');
  p.close();
});

test("a kept node whose control server doesn't answer stays as it was", async () => {
  const kept: string[] = [];
  const p = pageOn('nl-kept-down', 'M', memoryRecords(), kept);
  const c = await tailnet(p.net);
  kept.push(c.tailnet!.stateKey);
  const out = quietly(p.net.logoutKept(c));
  await new Promise((r) => setTimeout(r, 5));
  p.all[0].fail('no route');
  assert.equal(await out, 'network:net-live.notLoggedOut');
  assert.ok(!p.log.includes('ts0 logout'));
  assert.deepEqual(kept, [c.tailnet!.stateKey]);
  // Deleting it all the same says the node is left behind.
  const del = p.net.remove(c);
  await new Promise((r) => setTimeout(r, 5));
  p.all[1].fail('no route');
  assert.equal(await del, true, 'stranded');
  assert.equal(await p.net.conns.get(c.id), undefined, 'deleted all the same');
  p.close();
});

test('a running client that logs out or is deleted stops first: unconnected, the module would only forget the keys and strand the node', async () => {
  const kept: string[] = [];
  const p = pageOn('nl-del', 'M', memoryRecords(), kept);
  const c = await tailnet(p.net);
  kept.push(c.tailnet!.stateKey);
  p.net.ports('m', adapters(c));
  await p.net.autoconnect();
  // Still connecting: the server may be down.
  const out = quietly(p.net.logout(0));
  await new Promise((r) => setTimeout(r, 5));
  assert.ok(!p.log.includes('ts0 logout'), `not through the unconnected client: ${p.log}`);
  assert.ok(p.log.includes('ts0 detach'));
  p.all[1].fail('no route');
  assert.equal(await out, 'network:net-live.notLoggedOut');
  assert.deepEqual(kept, [c.tailnet!.stateKey], 'nothing forgotten');

  await p.net.connect(0, (await p.net.conns.get(c.id))!);
  const del = p.net.remove(c);
  await new Promise((r) => setTimeout(r, 5));
  p.all[3].set('Running', netmap()); // i18n-ignore
  assert.equal(await del, false);
  assert.ok(p.log.includes('ts3 logout'), `${p.log}`);

  const e = await tailnet(p.net, { ephemeral: true });
  const n = p.all.length;
  assert.equal(await p.net.remove(e), false);
  assert.equal(p.all.length, n, 'an ephemeral connection has nothing kept');
  p.close();
});

test('while a node logs out nothing connects it, and no other tab is let in', async () => {
  const kept: string[] = [];
  const records = memoryRecords();
  const a = pageOn('nl-leaving', 'Machine A', records, kept);
  const b = pageOn('nl-leaving', 'Machine B', records, kept);
  const c = await tailnet(a.net);
  kept.push(c.tailnet!.stateKey);
  a.net.ports('ma', adapters(c));
  await a.net.conns.put({ ...c, connectAtStart: false });
  const out = a.net.logoutKept(c);
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(await quietly(a.net.connect(0, c)), 'network:net-live.loggingOut');
  assert.equal(await b.net.locks.takeFrom(connectionLock(c.id), { ms: 300 }), false, 'the other tab waits');
  assert.ok(a.net.locks.mine(connectionLock(c.id)));
  a.all[0].set('Running', netmap()); // i18n-ignore
  await out;
  assert.ok(!a.net.locks.mine(connectionLock(c.id)));
  assert.match(await quietly(a.net.connect(0, c)), /^ok$/, 'then it can');
  a.close();
  b.close();
});

test('a lock taken for a machine that stopped meanwhile is let go', async () => {
  const a = pageOn('nl-off-take', 'Machine A');
  const b = pageOn('nl-off-take', 'Machine B', a.records);
  const c = await tailnet(a.net);
  a.net.ports('ma', adapters(c));
  await a.net.autoconnect();
  b.net.ports('mb', adapters(undefined));
  b.net.machineOff();
  await b.net.takeFrom(0, c);
  assert.equal(b.saved[0], c.id, 'attached');
  assert.ok(!b.net.locks.mine(connectionLock(c.id)), 'no machine here to hold it for');
  // Stopped while its lock is asked for: no client starts.
  b.net.ports('mb', adapters(undefined));
  const going = quietly(b.net.connect(0, c));
  b.net.machineOff();
  assert.equal(await going, 'network:net-live.off');
  assert.equal(b.net.views()[0].active, false);
  assert.ok(!b.net.locks.mine(connectionLock(c.id)));
  a.close();
  b.close();
});

test("off, the adapters are the record's: moved or removed, the page's order follows, and an edit leaves a kept client alone", async () => {
  const p = pageOn('nl-off-order', 'M');
  const ts = await tailnet(p.net);
  const cat = await p.net.conns.create({ kind: 'tailcat', tailcat: { exit: 'tcEXIT', serve: false, relay: '' } });
  const two = adapters(ts, cat);
  p.net.ports('m', two);
  p.net.machineOff();
  await p.net.follow([two[1], two[0]]);
  assert.deepEqual(p.net.views().map((v) => v.connection?.id), [cat.id, ts.id]);
  await p.net.follow([two[1]]);
  assert.equal(p.net.views().length, 1);

  const eph = await tailnet(p.net, { ephemeral: true });
  p.net.ports('m', adapters(eph));
  await p.net.autoconnect();
  p.net.machineOff();
  p.log.length = 0;
  await p.net.edit({ ...eph, name: 'Renamed' });
  assert.deepEqual(p.log, [], 'its node is in the client');
  p.close();
});

test('logging out a node another tab has: refused until taken from it', async () => {
  const kept: string[] = [];
  const records = memoryRecords();
  const a = pageOn('nl-kept-held', 'Machine A', records, kept);
  const b = pageOn('nl-kept-held', 'Machine B', records, kept);
  const c = await tailnet(a.net);
  kept.push(c.tailnet!.stateKey);
  a.net.ports('ma', adapters(c));
  await a.net.autoconnect();
  const held = await b.net.logoutKept(c).then(() => undefined, (e) => e);
  assert.ok(held instanceof HeldError);
  assert.ok(await b.net.locks.takeFrom(connectionLock(c.id)));
  assert.equal(a.net.runs(c.id), -1);
  const out = b.net.logoutKept(c);
  await new Promise((r) => setTimeout(r, 5));
  b.all[0].set('Running', netmap()); // i18n-ignore
  await out;
  assert.deepEqual(kept, []);
  a.close();
  b.close();
});
