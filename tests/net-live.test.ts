// The page's machine's network adapters live (web/app/net-live.ts, docs/plans/network-adapters.md §3) with fake
// clients over a memory store: what a connection starts its client with (a stored node kept under its profile, an
// ephemeral one not), connect at start, a connection one machine has at a time (two "tabs" on one channel: the holder
// named, Use it here instead), a restart keeping the clients, another machine stopping them, an attachment whose
// connection is gone detached, and the guest's default way out moving to the adapter that reaches the internet.
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { connectionLock, type Connection } from '../web/app/connections.ts';
import { connectOf, HeldError, PageNetwork } from '../web/app/net-live.ts';
import type { Adapter } from '../web/app/shape.ts';
import { memoryFiles, memoryRecords, Store } from '../web/app/store.ts';
import type { FromTailscale, NetMap, Tailscale, TailscaleConfig } from '../web/tailscale.ts';
import type { TailcatConfig } from '../web/tailcat.ts';

/** Fake clients: what each was started with, and what was asked of it. */
function clients() {
  const log: string[] = [];
  const all: { config: TailscaleConfig | TailcatConfig; set(state: string, nm?: NetMap): void }[] = [];
  const make = (kind: string) => (config: TailscaleConfig | TailcatConfig, onEvent: (m: FromTailscale) => void): Tailscale => {
    let state = '';
    let nm: NetMap | undefined;
    let held: MessagePort | undefined = config.ip;
    const n = all.length;
    all.push({ config, set(s, m) { state = s; nm = m; onEvent({ type: 'state', state: s }); } });
    log.push(`${kind}${n} start ${'persist' in config ? config.persist ?? '-' : ''}`.trim());
    return {
      state: () => state, netmap: () => nm, loginURL: () => undefined, running: new Promise<NetMap>(() => {}), timings: () => ({}),
      setPrimary: (p) => { log.push(`${kind}${n} primary ${p}`); },
      attach: (ip) => { held = ip; log.push(`${kind}${n} attach`); },
      detach: async () => { log.push(`${kind}${n} detach`); const h = held; held = undefined; return h; },
      setExitNode: async (id) => { log.push(`${kind}${n} exit ${id || '-'}`); },
      logout: async () => { log.push(`${kind}${n} logout`); },
      close: () => {},
    };
  };
  return { log, all, start: make('ts'), startCat: make('cat') };
}

const MAC = '52:54:00:12:34:56';
const netmap = (over: Partial<NetMap> = {}): NetMap => ({ name: 'g.', addresses: ['100.90.0.2/32'], peers: [{ id: 'nEXIT', name: 'exit', addresses: [], exitNodeOption: true }], mtu: 1280, dns: [], domains: [], exitNode: '', ...over });

const opened: (() => void)[] = [];
after(() => { for (const close of opened) close(); }); // a failed test's pages too

/** A page: its store (on `channel`, shared with the other "tabs"), its network, and what it saved for its machine. */
function pageOn(channel: string, name: string, records = memoryRecords()) {
  const store = new Store(records, memoryFiles(), { channel });
  const c = clients();
  const saved: (string | undefined)[] = [];
  const net = new PageNetwork({ store, me: () => name, onChange: () => {}, save: async (i, id) => { saved[i] = id; }, start: c.start, startCat: c.startCat });
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
  assert.match(a.net.views()[0].note ?? '', /taken by another machine/);
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
  assert.match(p.net.views()[1].note ?? '', /gone/);
  await assert.rejects(p.net.connect(1, c), /on adapter 1 already/);
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
  p.all[0].set('Running', netmap());
  assert.equal(p.net.views().findIndex((v) => v.primary), 0, 'the tailnet without an exit node, the only one up');
  p.all[1].set('Running', { ...netmap(), via: 'tailcat', tailcatExit: true });
  assert.equal(p.net.views().findIndex((v) => v.primary), 1, 'tailcat through a server reaches the internet');
  assert.equal(p.log.filter((l) => l.startsWith('ts0 primary')).at(-1), 'ts0 primary false', 'the tailnet offers its routes only');
  assert.equal(p.log.filter((l) => l.startsWith('cat1 primary')).at(-1) ?? 'cat1 primary true', 'cat1 primary true');
  // The tailnet takes an exit node: it comes first in order, so the default moves to it.
  await p.net.setExitNode(0, 'nEXIT');
  p.all[0].set('Running', netmap({ exitNode: 'nEXIT' }));
  assert.equal(p.net.views().findIndex((v) => v.primary), 0);
  assert.equal((await p.net.conns.get(ts.id))!.tailnet!.exitNode, 'nEXIT', 'the exit node is kept with the connection');
  assert.equal(p.log.filter((l) => l.startsWith('cat1 primary')).at(-1), 'cat1 primary false');
  p.close();
});
