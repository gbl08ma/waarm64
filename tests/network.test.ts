// The page's network controller (web/app/network.ts) with a fake Tailscale client: the view of
// each client state, the settings parsers, and where the machine's IP port goes as the client
// connects, the machine restarts and the client disconnects.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createNetwork, parseControlURL, parseHostname, primaryOf, ranksOf, viewOf } from '../web/app/network.ts';
import type { FromTailscale, NetMap, Tailscale, TailscaleConfig } from '../web/tailscale.ts';
import { msg, t } from '../web/i18n.ts';
import { msgOf, toWire } from '../web/msg.ts';

const netmap = (over: Partial<NetMap> = {}): NetMap => ({ name: 'guest.tail.test.', addresses: ['100.90.0.2/32', 'fd7a:115c:a1e0::2/128'], peers: [{ id: 'nPEER', name: 'peer', addresses: ['100.90.0.3/32'], exitNodeOption: false }], mtu: 1280, dns: ['100.100.100.100'], domains: ['tail.test'], exitNode: '', ...over });

test('control server URLs: Tailscale by default, https, http only for this computer', () => {
  assert.deepEqual(parseControlURL(''), { url: 'https://controlplane.tailscale.com' });
  assert.deepEqual(parseControlURL('  '), { url: 'https://controlplane.tailscale.com' });
  assert.deepEqual(parseControlURL('headscale.example.com'), { url: 'https://headscale.example.com' }); // i18n-ignore
  assert.deepEqual(parseControlURL('https://hs.example.com:8443/'), { url: 'https://hs.example.com:8443' });
  assert.deepEqual(parseControlURL('https://example.com/hs/'), { url: 'https://example.com/hs' });
  assert.deepEqual(parseControlURL('http://localhost:8080'), { url: 'http://localhost:8080' });
  assert.deepEqual(parseControlURL('http://127.0.0.1:8080'), { url: 'http://127.0.0.1:8080' });
  for (const bad of ['http://hs.example.com', 'ftp://hs.example.com', 'javascript:alert(1)', 'https://', 'http://']) assert.ok('error' in parseControlURL(bad), bad);
});

test('hostnames: one DNS label, webpc when empty', () => {
  assert.deepEqual(parseHostname(''), { hostname: 'webpc' });
  assert.deepEqual(parseHostname(' My-Box1 '), { hostname: 'my-box1' });
  for (const bad of ['-a', 'a-', 'a b', 'a.b', 'a_b', 'x'.repeat(64), 'é']) assert.ok('error' in parseHostname(bad), bad);
  assert.deepEqual(parseHostname('x'.repeat(63)), { hostname: 'x'.repeat(63) });
});

test('the view of the client: contacting, login, approval, connected, stopped, error', () => {
  assert.deepEqual(viewOf(undefined), { phase: 'off', text: t('network:network.notConnected'), exitNodes: [] });
  assert.equal(viewOf({ state: '' }).phase, 'connecting');
  assert.equal(viewOf({ state: 'Starting' }).phase, 'connecting');
  assert.equal(viewOf({ state: 'NeedsLogin' }).phase, 'connecting'); // no URL yet
  assert.deepEqual(viewOf({ state: 'NeedsLogin', loginURL: 'https://login.example.com/a/1' }), { phase: 'login', text: t('network:network.logIn'), loginURL: 'https://login.example.com/a/1', exitNodes: [] });
  assert.equal(viewOf({ state: 'NeedsMachineAuth' }).phase, 'login');
  const up = viewOf({ state: 'Running', netmap: netmap() }); // i18n-ignore
  assert.equal(up.phase, 'connected');
  assert.equal(up.address, '100.90.0.2');
  assert.equal(up.text, t('network:network.connectedPeers', { connected: msg('network:network.connected.as.address', { name: 'guest.tail.test', address: '100.90.0.2' }), count: 1 }));
  assert.equal(viewOf({ state: 'Running', netmap: netmap({ peers: [] }) }).text, t('network:network.connectedPeers', { connected: msg('network:network.connected.as.address', { name: 'guest.tail.test', address: '100.90.0.2' }), count: 0 })); // i18n-ignore
  assert.equal(up.subnets, undefined, 'no peer routes a subnet: no choice to offer');
  const lan = netmap({ peers: [{ id: 'r', name: 'router.', addresses: [], exitNodeOption: false, routes: ['192.168.1.0/24'] }], acceptRoutes: false });
  assert.deepEqual(viewOf({ state: 'Running', netmap: lan }).subnets, { routes: ['192.168.1.0/24'], on: false }); // i18n-ignore
  assert.equal(viewOf({ state: 'Stopped' }).phase, 'off'); // i18n-ignore
  assert.deepEqual(viewOf({ state: 'Starting', error: new Error('no route', { cause: new Error('more') }) }), { phase: 'error', text: t('network:network.couldntConnect'), details: ['no route', 'more'], exitNodes: [] });
});

test('a login URL that is not http(s) is never offered', () => {
  for (const url of ['javascript:alert(1)', 'data:text/html,x', 'file:///etc/passwd', 'nonsense']) assert.equal(viewOf({ state: 'NeedsLogin', loginURL: url }).loginURL, undefined, url);
});

/** A fake client: records what the controller asks of it. */
function fake() {
  const log: string[] = [];
  const clients: { config: TailscaleConfig; emit(m: FromTailscale): void; attached: MessagePort[]; setState(s: string, nm?: NetMap, url?: string): void }[] = [];
  const start = (config: TailscaleConfig, onEvent: (m: FromTailscale) => void): Tailscale => {
    let state = '';
    let nm: NetMap | undefined;
    let url: string | undefined;
    let held = config.ip;
    const attached: MessagePort[] = [];
    const c = {
      config, attached, emit: onEvent,
      setState(s: string, n?: NetMap, u?: string) { state = s; nm = n; url = u; onEvent({ type: 'state', state: s }); },
    };
    clients.push(c);
    log.push(`start ${config.controlURL} ${config.hostname} ${config.authKey ?? '-'} ${config.persist ?? '-'}`);
    return {
      state: () => state, netmap: () => nm, loginURL: () => url, running: new Promise<NetMap>(() => {}), timings: () => ({}),
      setPrimary: (p) => { log.push(`primary:${p}`); },
      attach: (ip) => { held = ip; attached.push(ip); log.push('attach'); },
      detach: async () => { log.push('detach'); const h = held; held = undefined; return h; },
      setExitNode: async (id) => { log.push(`exit ${id || '-'}`); if (id === 'bad') throw new Error('nope'); },
      setAcceptRoutes: (on) => { log.push(`routes ${on}`); },
      logout: async () => { log.push('logout'); },
      close: () => log.push('close'),
    };
  };
  return { start, log, clients };
}

test('connecting: the client gets the machine\'s port; a restarted machine\'s new port is attached; disconnecting takes it back', async () => {
  const f = fake();
  let changes = 0;
  const net = createNetwork(() => changes++, f.start);
  assert.throws(() => net.connect({ controlURL: 'https://c', hostname: 'h' }), (e) => msgOf(e)?.key === 'network:network.notStarted');

  const dev1 = net.port(); // the machine's end
  net.connect({ controlURL: 'https://c', hostname: 'h', persist: 'https://c' });
  assert.equal(net.active(), true);
  assert.deepEqual(f.log, ['start https://c h - https://c']); // a kept node, under the profile given
  // Packets from the machine reach the client's end of the channel.
  const got = new Promise<unknown>((resolve) => { f.clients[0].config.ip!.onmessage = (e) => resolve(e.data); });
  dev1.postMessage('hello');
  assert.equal(await got, 'hello');

  const dev2 = net.port(); // the machine restarted
  assert.deepEqual(f.log.slice(1), ['attach']);
  f.clients[0].setState('Running', netmap()); // i18n-ignore
  assert.equal(net.view().phase, 'connected');
  assert.ok(changes > 0);

  await net.disconnect();
  assert.equal(net.active(), false);
  assert.equal(net.view().phase, 'off');
  assert.deepEqual(f.log.slice(1), ['attach', 'detach', 'close']);

  // The port came back: the same machine connects again without a restart.
  net.connect({ controlURL: 'https://c', hostname: 'h', authKey: 'tskey-x' });
  assert.equal(f.log.at(-1), 'start https://c h tskey-x -'); // no profile: an ephemeral node
  await net.disconnect();
  dev1.close();
  dev2.close();
});

test('logout logs the node out, then disconnects', async () => {
  const f = fake();
  const net = createNetwork(() => {}, f.start);
  const dev = net.port();
  net.connect({ controlURL: 'https://c', hostname: 'h' });
  await net.logout();
  assert.deepEqual(f.log.slice(1), ['logout', 'detach', 'close']);
  dev.close();
  await net.disconnect(); // nothing to do
});

test('a client that fails shows the error until it comes up', () => {
  const f = fake();
  const net = createNetwork(() => {}, f.start);
  const dev = net.port();
  net.connect({ controlURL: 'https://c', hostname: 'h' });
  f.clients[0].emit({ type: 'error', error: toWire(new Error('the control server is not reachable')) });
  assert.equal(net.view().phase, 'error');
  f.clients[0].setState('Running', netmap()); // i18n-ignore
  assert.equal(net.view().phase, 'connected');
  dev.close();
});

test('exit nodes: the menu lists the approved ones and the one in use; the choice goes to the client and the next connection', async () => {
  const peers = [
    { id: 'nA', name: 'a.tail.test.', addresses: ['100.90.0.3/32'], online: true, exitNodeOption: true },
    { id: 'nB', name: 'b.tail.test.', addresses: ['100.90.0.4/32'], online: false, exitNodeOption: true },
    { id: 'nC', name: 'c.tail.test.', addresses: ['100.90.0.5/32'], exitNodeOption: false },
  ];
  assert.deepEqual(viewOf({ state: 'Running', netmap: netmap({ peers }) }).exitNodes, [ // i18n-ignore
    { id: 'nA', name: 'a.tail.test', online: true, use: false },
    { id: 'nB', name: 'b.tail.test', online: false, use: false },
  ]);
  const used = viewOf({ state: 'Running', netmap: netmap({ peers, exitNode: 'nA' }) }); // i18n-ignore
  assert.deepEqual(used.exitNodes.map((e) => e.use), [true, false]);
  assert.equal(used.text, t('network:network.connectedPeers.via', { connected: msg('network:network.connected.as.address', { name: 'guest.tail.test', address: '100.90.0.2' }), count: 3, via: 'a.tail.test' }));
  assert.deepEqual(viewOf({ state: 'Starting', netmap: netmap({ peers }) }).exitNodes, [], 'only when connected');

  const f = fake();
  const net = createNetwork(() => {}, f.start);
  await assert.rejects(net.setExitNode('nA'), (e) => msgOf(e)?.key === 'network:network.noClient');
  net.port();
  net.connect({ controlURL: 'https://c', hostname: 'h', exitNode: 'nA' });
  assert.equal(f.clients[0].config.exitNode, 'nA', 'a remembered choice is applied from the start');
  await net.setExitNode('nB');
  await net.setExitNode('');
  await assert.rejects(net.setExitNode('bad'), /nope/);
  assert.deepEqual(f.log.slice(1), ['exit nB', 'exit -', 'exit bad']);
});

test('tailcat addresses: tc and base64url, nothing else', async () => {
  const { parseTailcatAddr } = await import('../web/app/network.ts');
  const addr = `tc${'A'.repeat(100)}_-x`;
  assert.deepEqual(parseTailcatAddr(`  ${addr}\n`), { addr });
  assert.ok('error' in parseTailcatAddr(''));
  assert.ok('error' in parseTailcatAddr('https://tailcat.dev'));
  assert.ok('error' in parseTailcatAddr(`tc${'A'.repeat(100)}=`));
});

test('a tailcat connection: the address goes to the tailcat client, not the Tailscale one; the view says where it is', async () => {
  const { netmapOf } = await import('../web/tailcat.ts');
  const ts = fake();
  const cats: { addr: string; emit(m: FromTailscale): void; setState(s: string, nm?: NetMap): void }[] = [];
  const startCat = (config: { addr: string; ip?: MessagePort }, onEvent: (m: FromTailscale) => void): Tailscale => {
    let state = '';
    let nm: NetMap | undefined;
    let held = config.ip;
    cats.push({ addr: config.addr, emit: onEvent, setState(s, n) { state = s; nm = n; onEvent({ type: 'state', state: s }); } });
    return {
      state: () => state, netmap: () => nm, loginURL: () => undefined, running: new Promise<NetMap>(() => {}), timings: () => ({}),
      setPrimary: () => {}, attach: (ip) => { held = ip; }, detach: async () => { const h = held; held = undefined; return h; },
      setExitNode: async () => { throw new Error('no'); }, setAcceptRoutes: () => {}, logout: async () => {}, close: () => {},
    };
  };
  const net = createNetwork(() => {}, ts.start, startCat);
  net.port();
  net.connect({ controlURL: '', hostname: '', tailcat: 'tcADDRESS' });
  assert.deepEqual(ts.log, []);
  assert.deepEqual(cats.map((c) => c.addr), ['tcADDRESS']);
  assert.deepEqual(net.view(), { phase: 'connecting', text: t('network:network.loadingClient'), exitNodes: [] });
  cats[0].setState('Meowing');
  assert.equal(net.view().text, t('network:network.meowing'));
  const nm = netmapOf({ address: [192, 0, 0, 2], address6: [0xfd, 0x7a, 0x11, 0x5c, 0xa1, 0xe0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10], mtu: 1280, dns: [[1, 1, 1, 1]], dns6: [[0x26, 0x06, 0x47, 0, 0x47, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x11, 0x11]], domains: [] });
  assert.deepEqual(nm.addresses, ['192.0.0.2/32', 'fd7a:115c:a1e0:102:304:506:708:90a/128']);
  assert.deepEqual(nm.dns, ['1.1.1.1', '2606:4700:4700::1111']);
  cats[0].setState('Running', nm); // i18n-ignore
  assert.deepEqual(net.view(), { phase: 'connected', address: '192.0.0.2', exitNodes: [], internet: true, text: t('network:network.tailcat.address', { address: '192.0.0.2' }) });
  cats[0].emit({ type: 'error', error: toWire(new Error('the tailcat server didn\'t answer')) });
  assert.equal(net.view().phase, 'error');
  await net.disconnect();
  // The next connection is a tailnet's again.
  net.connect({ controlURL: 'https://c.example', hostname: 'h' });
  assert.equal(ts.log.length, 1);
  ts.clients[0].setState('Starting');
  assert.equal(net.view().text, t('network:network.connecting'));
});

test('a served machine (tailcat T3): serving alone or beside a tailcat server; the view shows its address', async () => {
  const { netmapOf } = await import('../web/tailcat.ts');
  const ts = fake();
  const cats: { config: { addr: string; serve?: { relay: string } }; setState(s: string, nm?: NetMap): void }[] = [];
  const startCat = (config: { addr: string; serve?: { relay: string }; ip?: MessagePort }, onEvent: (m: FromTailscale) => void): Tailscale => {
    let state = '';
    let nm: NetMap | undefined;
    let held = config.ip;
    cats.push({ config: { addr: config.addr, serve: config.serve }, setState(s, n) { state = s; nm = n; onEvent({ type: 'state', state: s }); } });
    return {
      state: () => state, netmap: () => nm, loginURL: () => undefined, running: new Promise<NetMap>(() => {}), timings: () => ({}),
      setPrimary: () => {}, attach: (ip) => { held = ip; }, detach: async () => { const h = held; held = undefined; return h; },
      setExitNode: async () => { throw new Error('no'); }, setAcceptRoutes: () => {}, logout: async () => {}, close: () => {},
    };
  };
  const net = createNetwork(() => {}, ts.start, startCat);
  net.port();
  const lease = { address: [192, 0, 0, 2], address6: [0xfd, 0x7a, 0x11, 0x5c, 0xa1, 0xe0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10], mtu: 1280, dns: [], dns6: [], domains: [] };
  // Serving only: no address to connect to; the relay goes to the client.
  net.connect({ controlURL: '', hostname: '', tailcatServe: { relay: '127.0.0.1:8443' } });
  assert.deepEqual(ts.log, []);
  assert.deepEqual(cats[0].config, { addr: '', serve: { relay: '127.0.0.1:8443' } });
  cats[0].setState('Running', netmapOf(lease, 'tcSERVED', false)); // i18n-ignore
  assert.deepEqual(net.view(), { phase: 'connected', exitNodes: [], text: t('network:network.servingOnly'), internet: false, served: 'tcSERVED' });
  await net.disconnect();
  assert.equal(net.view().served, undefined);
  // Beside a tailcat server: both said.
  net.connect({ controlURL: '', hostname: '', tailcat: 'tcEXIT', tailcatServe: { relay: '' } });
  assert.deepEqual(cats[1].config, { addr: 'tcEXIT', serve: { relay: '' } });
  cats[1].setState('Running', netmapOf(lease, 'tcSERVED')); // i18n-ignore
  assert.deepEqual(net.view(), { phase: 'connected', address: '192.0.0.2', exitNodes: [], internet: true, text: t('network:network.tailcat.address.serving', { address: '192.0.0.2' }), served: 'tcSERVED' });
  // Its node key, for the server's `--allow` (the menu shows it through a server only).
  cats[1].setState('Running', netmapOf(lease, undefined, true, `nodekey:${'ab'.repeat(32)}`)); // i18n-ignore
  assert.equal(net.view().tailcatKey, `nodekey:${'ab'.repeat(32)}`);
  await net.disconnect();
  net.connect({ controlURL: '', hostname: '', tailcatServe: { relay: '' } });
  cats[2].setState('Running', netmapOf(lease, 'tcSERVED', false, `nodekey:${'ab'.repeat(32)}`)); // i18n-ignore
  assert.equal(net.view().tailcatKey, undefined, 'serving alone, there is no server to tell');
});

test("clients let in: tailcat's --allow keys, by commas, spaces or lines; anything else is an error", async () => {
  const { parseAllow } = await import('../web/app/network.ts');
  const k = (c: string) => `nodekey:${c.repeat(64)}`;
  assert.deepEqual(parseAllow(''), { allow: [] });
  assert.deepEqual(parseAllow(` ${k('a')},${k('B')}\n${k('c')}\n\n${k('A')} `), { allow: [k('a'), k('b'), k('c')] });
  for (const bad of ['a', `privkey:${'a'.repeat(64)}`, `nodekey:${'a'.repeat(63)}`, `${'a'.repeat(64)}`, `${k('a')}x`]) assert.ok('error' in parseAllow(bad), bad);
});

test('relays: a host or host:port, nothing that looks like a URL', async () => {
  const { parseRelay } = await import('../web/app/network.ts');
  assert.deepEqual(parseRelay(''), { relay: '' });
  assert.deepEqual(parseRelay(' derp.example.com '), { relay: 'derp.example.com' });
  assert.deepEqual(parseRelay('127.0.0.1:8443'), { relay: '127.0.0.1:8443' });
  assert.deepEqual(parseRelay('[fd00::1]:8443'), { relay: '[fd00::1]:8443' });
  for (const bad of ['https://derp.example.com', 'derp.example.com/derp', 'a b', 'host:port']) assert.ok('error' in parseRelay(bad), bad);
});

test("the guest's default way out: the first adapter that reaches the internet, else the first connected; the client is told, now and at its next start", async () => {
  const c = (phase: 'off' | 'connected' | 'connecting', internet?: boolean) => ({ phase, internet });
  assert.equal(primaryOf([]), -1);
  assert.equal(primaryOf([c('off'), c('connecting')]), -1);
  assert.equal(primaryOf([c('connected', false)]), 0, 'one adapter keeps its default route, internet or not');
  assert.equal(primaryOf([c('connected', false), c('connected', true)]), 1, 'a tailnet without an exit node, then tailcat through a server');
  assert.equal(primaryOf([c('connected', true), c('connected', true)]), 0, 'both reach it: the first in order');
  assert.equal(primaryOf([c('connecting', true), c('connected', false)]), 1);
  assert.deepEqual(ranksOf([c('connected'), c('off'), c('connected'), c('connected')]), [0, 1, 1, 2], 'connected adapters before each');
  assert.deepEqual(ranksOf([c('connecting'), c('connected')]), [0, 0], 'only connected ones count');
  assert.equal(viewOf({ state: 'Running', netmap: netmap() }).internet, false, 'a tailnet without an exit node'); // i18n-ignore
  assert.equal(viewOf({ state: 'Running', netmap: netmap({ exitNode: 'nPEER', peers: [{ id: 'nPEER', name: 'peer', addresses: ['100.90.0.3/32'], exitNodeOption: true }] }) }).internet, true); // i18n-ignore
  const told: (boolean | number)[][] = [];
  const fake = (): Tailscale => ({
    state: () => '', netmap: () => undefined, loginURL: () => undefined, running: new Promise(() => {}), timings: () => ({}),
    setPrimary: (p, r) => { told.push([p, r ?? 0]); }, attach: () => {}, detach: async () => undefined, setExitNode: async () => {}, setAcceptRoutes: () => {}, logout: async () => {}, close: () => {},
  });
  const net = createNetwork(() => {}, fake, fake);
  net.port();
  net.setPrimary(false);
  net.connect({ controlURL: 'https://controlplane.tailscale.com', hostname: 'webpc' });
  assert.deepEqual(told, [[false, 0]], 'a client started on a secondary adapter is told at once');
  net.setPrimary(false);
  net.setPrimary(true);
  net.setPrimary(true, 1);
  net.setPrimary(true, 1);
  assert.deepEqual(told, [[false, 0], [true, 0], [true, 1]], 'and on every change (the rank too), once');
});

test("a port that comes while the client detaches stays, connected or not: the old one is closed", async () => {
  let give!: (p?: MessagePort) => void;
  const closed: string[] = [];
  const start = ((c: { ip: MessagePort }) => ({
    state: () => 'Running', netmap: () => undefined, loginURL: () => undefined, running: new Promise(() => {}), timings: () => ({}), // i18n-ignore
    setPrimary: () => {}, attach: () => {}, detach: () => new Promise((r) => { give = r; }), setExitNode: async () => {}, setAcceptRoutes: () => {}, logout: async () => {}, close: () => {},
    ip: c.ip,
  })) as never;
  const n = createNetwork(() => {}, start);
  n.port();
  n.connect({ controlURL: 'https://x.example', hostname: 'a' });
  const going = n.disconnect();
  n.port();
  n.connect({ controlURL: 'https://x.example', hostname: 'a' }); // the new machine's port is the new client's
  const old = new MessageChannel();
  old.port1.close = () => { closed.push('old'); };
  give(old.port1);
  await going;
  assert.deepEqual(closed, ['old']);
  old.port2.close();
});

test("a local connection: the helper's link goes to the local client; an IP client after it brings the gateway back first; it is the primary first", async () => {
  const { localNetmap } = await import('../web/local-net.ts');
  const ts = fake();
  const locals: { url: string; ip: MessagePort; setState(s: string, nm?: NetMap): void; emit(m: FromTailscale): void }[] = [];
  const startLocal = (config: { url: string; ip: MessagePort }, onEvent: (m: FromTailscale) => void): Tailscale => {
    let state = '';
    let nm: NetMap | undefined;
    let held: MessagePort | undefined = config.ip;
    locals.push({ url: config.url, ip: config.ip, emit: onEvent, setState(s, n) { state = s; nm = n; onEvent({ type: 'state', state: s }); } });
    return {
      state: () => state, netmap: () => nm, loginURL: () => undefined, running: new Promise<NetMap>(() => {}), timings: () => ({}),
      setPrimary: () => {}, attach: (ip) => { held = ip; }, detach: async () => { const h = held; held = undefined; return h; },
      setExitNode: async () => { throw new Error('no'); }, setAcceptRoutes: () => {}, logout: async () => {}, close: () => {},
    };
  };
  const net = createNetwork(() => {}, ts.start, undefined, startLocal);
  const dev = net.port();
  const seen: unknown[] = [];
  dev.onmessage = (e) => seen.push(e.data);
  net.connect({ controlURL: '', hostname: '', local: 'ws://127.0.0.1:8740/tok' });
  assert.deepEqual(ts.log, []);
  assert.equal(locals[0].url, 'ws://127.0.0.1:8740/tok');
  assert.deepEqual(net.view(), { phase: 'connecting', text: t('network:network.connectingHelper'), exitNodes: [] });
  locals[0].setState('Running', localNetmap({ address: '192.168.127.2' })); // i18n-ignore
  assert.deepEqual(net.view(), { phase: 'connected', address: '192.168.127.2', exitNodes: [], internet: true, local: true, text: t('network:network.connectedLocal.address', { address: '192.168.127.2' }) });
  locals[0].emit({ type: 'error', error: toWire(new Error("couldn't reach the helper")) });
  assert.equal(net.view().phase, 'error');
  await net.disconnect();
  // A tailnet next: the card is told to leave the helper's frames for the gateway, before the client has the port.
  net.connect({ controlURL: 'https://c.example', hostname: 'h' });
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(seen, [{ type: 'gateway' }]);
  await net.disconnect();
  net.connect({ controlURL: 'https://c.example', hostname: 'h' });
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(seen, [{ type: 'gateway' }], 'once: the card is on the gateway already');
  await net.disconnect();
  dev.close();
  const c = (phase: 'connected' | 'off', internet?: boolean, local?: boolean) => ({ phase, internet, local });
  assert.equal(primaryOf([c('connected', true), c('connected', true, true)]), 1, 'a tailnet with an exit node, then a local helper: the helper');
  assert.equal(primaryOf([c('connected', true, true), c('connected', true, true)]), 0, 'two helpers: the first');
  assert.equal(primaryOf([c('off', false, true), c('connected', true)]), 1);
});

test('a room connection: its link and switches go to the room client; the view shows its name and never the internet', async () => {
  const ts = fake();
  const rooms: { config: { link: string; incoming?: boolean; relayOnly?: boolean; identityKey?: string }; setState(s: string, nm?: NetMap): void; emit(m: FromTailscale): void }[] = [];
  const startRoom = (config: { link: string; ip?: MessagePort }, onEvent: (m: FromTailscale) => void): Tailscale => {
    let state = '';
    let nm: NetMap | undefined;
    let held = config.ip;
    rooms.push({ config, emit: onEvent, setState(s, n) { state = s; nm = n; onEvent({ type: 'state', state: s }); } });
    return {
      state: () => state, netmap: () => nm, loginURL: () => undefined, running: new Promise<NetMap>(() => {}), timings: () => ({}),
      setPrimary: () => {}, attach: (ip) => { held = ip; }, detach: async () => { const h = held; held = undefined; return h; },
      setExitNode: async () => { throw new Error('no'); }, setAcceptRoutes: () => {}, logout: async () => {}, close: () => {},
    };
  };
  const net = createNetwork(() => {}, ts.start, undefined, undefined, startRoom);
  net.port();
  const room = { link: 'webpc-room:gabriel-lan', incoming: false, relayOnly: true, identityKey: 'c1' };
  net.connect({ controlURL: '', hostname: '', room });
  assert.deepEqual(ts.log, []);
  assert.deepEqual(rooms.map((r) => ({ link: r.config.link, incoming: r.config.incoming, relayOnly: r.config.relayOnly, identityKey: r.config.identityKey })), [room]);
  assert.deepEqual(net.view(), { phase: 'connecting', text: t('network:network.loadingClient'), exitNodes: [] });
  rooms[0].setState('Connecting'); // i18n-ignore
  assert.equal(net.view().text, t('network:network.connectingRelay'));
  const name = `${'a'.repeat(52)}.abcdefgh.p2p.internal`;
  const nm: NetMap = {
    name, via: 'room', addresses: ['fd12:3456:789a:1:2:3:4:5/128'], mtu: 1280, dns: ['fd12:3456:789a::53'], domains: ['abcdefgh.p2p.internal'], exitNode: '',
    peers: [{ id: 'nodekey:01', name: 'peer', addresses: ['fd12:3456:789a::1/128'], exitNodeOption: false }],
    room: { name, link: room.link, incoming: false, relayOnly: true },
  };
  rooms[0].setState('Running', nm); // i18n-ignore
  assert.deepEqual(net.view(), { phase: 'connected', address: 'fd12:3456:789a:1:2:3:4:5', exitNodes: [], internet: false, room: { name, link: room.link, incoming: false }, text: t('network:network.room'), details: [t('network:network.room.connections', { count: 1 })] });
  assert.equal(primaryOf([net.view(), { phase: 'connected', internet: true }]), 1, 'a room beside a way to the internet is never the default way out');
  rooms[0].emit({ type: 'error', error: toWire(new Error('the relay closed')) });
  assert.equal(net.view().phase, 'error');
  await net.disconnect();
  net.connect({ controlURL: 'https://c.example', hostname: 'h' });
  assert.equal(ts.log.length, 1, 'the next connection is a tailnet\'s again');
});
