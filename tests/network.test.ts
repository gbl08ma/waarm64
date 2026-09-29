// The page's network controller (web/app/network.ts) with a fake Tailscale client: the view of
// each client state, the settings parsers, and where the machine's IP port goes as the client
// connects, the machine restarts and the client disconnects.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createNetwork, parseControlURL, parseHostname, viewOf } from '../web/app/network.ts';
import type { FromTailscale, NetMap, Tailscale, TailscaleConfig } from '../web/tailscale.ts';

const netmap = (over: Partial<NetMap> = {}): NetMap => ({ name: 'guest.tail.test.', addresses: ['100.90.0.2/32', 'fd7a:115c:a1e0::2/128'], peers: [{ name: 'peer', addresses: ['100.90.0.3/32'], exitNodeOption: false }], mtu: 1280, dns: ['100.100.100.100'], domains: ['tail.test'], ...over });

test('control server URLs: Tailscale by default, https, http only for this computer', () => {
  assert.deepEqual(parseControlURL(''), { url: 'https://controlplane.tailscale.com' });
  assert.deepEqual(parseControlURL('  '), { url: 'https://controlplane.tailscale.com' });
  assert.deepEqual(parseControlURL('headscale.example.com'), { url: 'https://headscale.example.com' });
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
  assert.deepEqual(viewOf(undefined), { phase: 'off', text: 'Not connected' });
  assert.equal(viewOf({ state: '' }).phase, 'connecting');
  assert.equal(viewOf({ state: 'Starting' }).phase, 'connecting');
  assert.equal(viewOf({ state: 'NeedsLogin' }).phase, 'connecting'); // no URL yet
  assert.deepEqual(viewOf({ state: 'NeedsLogin', loginURL: 'https://login.example.com/a/1' }), { phase: 'login', text: 'Log in to connect', loginURL: 'https://login.example.com/a/1' });
  assert.equal(viewOf({ state: 'NeedsMachineAuth' }).phase, 'login');
  const up = viewOf({ state: 'Running', netmap: netmap() });
  assert.equal(up.phase, 'connected');
  assert.equal(up.address, '100.90.0.2');
  assert.match(up.text, /Connected as guest\.tail\.test \(100\.90\.0\.2\), 1 peer$/);
  assert.match(viewOf({ state: 'Running', netmap: netmap({ peers: [] }) }).text, /0 peers$/);
  assert.equal(viewOf({ state: 'Stopped' }).phase, 'off');
  assert.deepEqual(viewOf({ state: 'Starting', error: 'no route\nmore' }), { phase: 'error', text: "Couldn't connect: no route" });
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
      attach: (ip) => { held = ip; attached.push(ip); log.push('attach'); },
      detach: async () => { log.push('detach'); const h = held; held = undefined; return h; },
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
  assert.throws(() => net.connect({ controlURL: 'https://c', hostname: 'h' }), /no network card/);

  const dev1 = net.port(); // the machine's end
  net.connect({ controlURL: 'https://c', hostname: 'h' });
  assert.equal(net.active(), true);
  assert.deepEqual(f.log, ['start https://c h - https://c']); // a login's node is kept, under its server's name
  // Packets from the machine reach the client's end of the channel.
  const got = new Promise<unknown>((resolve) => { f.clients[0].config.ip!.onmessage = (e) => resolve(e.data); });
  dev1.postMessage('hello');
  assert.equal(await got, 'hello');

  const dev2 = net.port(); // the machine restarted
  assert.deepEqual(f.log.slice(1), ['attach']);
  f.clients[0].setState('Running', netmap());
  assert.equal(net.view().phase, 'connected');
  assert.ok(changes > 0);

  await net.disconnect();
  assert.equal(net.active(), false);
  assert.equal(net.view().phase, 'off');
  assert.deepEqual(f.log.slice(1), ['attach', 'detach', 'close']);

  // The port came back: the same machine connects again without a restart.
  net.connect({ controlURL: 'https://c', hostname: 'h', authKey: 'tskey-x' });
  assert.equal(f.log.at(-1), 'start https://c h tskey-x -'); // a key's node isn't kept
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
  f.clients[0].emit({ type: 'error', error: 'the control server is not reachable' });
  assert.equal(net.view().phase, 'error');
  f.clients[0].setState('Running', netmap());
  assert.equal(net.view().phase, 'connected');
  dev.close();
});
