// The Rust Tailscale client in Node against a headscale (docs/tailnet.md "Tailscale"), in one
// file because they share the rig.
// T4, the kept node carries over (§5): the Go client (net/tailscale,
// in Node: tests/net/go-client.ts) and the Rust one (net/ts: tests/net/rust-client.ts) run on the
// same store, the page's IndexedDB entries as a map, against a headscale (tests/net/tailnet.sh).
// Each starts on the store the other wrote and is the same node: headscale's node ID and the
// node's addresses unchanged, no new node. Both ways, from a store either one made.
// Opt-in: WEBPC_TAILNET=1 (needs Podman, or WEBPC_TAILNET_SCRIPT=tests/net/tailnet-native.sh;
// target/net/tailscale.wasm and target/net/ts.wasm). The rig's test CA is trusted once it's up
// (`trust`), here and in the Go client's worker.
// T5, the data plane: a stand-in guest (crafted IP packets, tests/net/packets.ts) pings the peer over
// IPv4 and IPv6, asks MagicDNS, reaches UDP and TCP servers on the peer's machine (a userspace
// tailscaled forwards its address's ports to its localhost: this machine, in the rig), and is
// reached: the peer's disco ping gets a pong over DERP, its TCP connection comes in through the
// packet filter. Selecting the exit node is checked; what goes through it needs the internet
// (tests/net-tailnet.test.ts's opt-in phase).
import assert from 'node:assert/strict';
import { execFile, execFileSync, spawnSync } from 'node:child_process';
import { createSocket } from 'node:dgram';
import { createServer } from 'node:net';
import { promisify } from 'node:util';
import * as pk from './net/packets.ts';
import { existsSync } from 'node:fs';
import { trust } from './net/go-client.ts';
import { after, before, test } from 'node:test';
import { startGo } from './net/go-client.ts';
import { startRust } from './net/rust-client.ts';
import type { NetMap } from '../web/tailscale.ts';

const ROOT = new URL('..', import.meta.url).pathname;
const script = process.env.WEBPC_TAILNET_SCRIPT ?? `${ROOT}tests/net/tailnet.sh`;
const skip = process.env.WEBPC_TAILNET !== '1' ? 'SKIPPED: set WEBPC_TAILNET=1'
  : !existsSync(`${ROOT}target/net/tailscale.wasm`) ? 'SKIPPED: no target/net/tailscale.wasm (net/tailscale/build.sh)'
  : !existsSync(`${ROOT}target/net/ts.wasm`) ? 'SKIPPED: no target/net/ts.wasm (net/ts/build.sh)'
  : undefined;

let control: string;
let ca: string;
let env: Record<string, string>;
before(() => {
  if (skip) return;
  env = Object.fromEntries(execFileSync(script, ['up'], { encoding: 'utf8', timeout: 240_000 }).trim().split('\n').map((l) => l.split(/=(.*)/s).slice(0, 2) as [string, string]));
  control = env.WEBPC_TS_CONTROL;
  ca = env.NODE_EXTRA_CA_CERTS;
  trust(ca);
});
after(() => { if (!skip) spawnSync(script, ['down']); });

type HsNode = { id: number | string; name: string; ip_addresses: string[] };
const nodes = (): HsNode[] => JSON.parse(execFileSync(script, ['nodes'], { encoding: 'utf8' }));
const within = <T>(p: Promise<T>, what: string, ms = 60_000) => {
  let t: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([p, new Promise<never>((_, reject) => { t = setTimeout(() => reject(new Error(`${what}: no netmap in ${ms / 1000} s`)), ms); })]).finally(() => clearTimeout(t));
};
const addrs = (nm: NetMap) => [...nm.addresses].sort().join(' ');
/** headscale's node with this name. */
const node = (name: string) => {
  const n = nodes().filter((x) => x.name === name);
  assert.equal(n.length, 1, `one node named ${name}: ${JSON.stringify(nodes())}`);
  return n[0];
};

type Kind = 'go' | 'rust';
async function run(kind: Kind, state: Map<string, string>, hostname: string, authKey?: string) {
  if (kind === 'go') {
    const g = startGo({ controlURL: control, authKey, hostname, state, ca });
    try { return await within(g.running, 'the Go client'); } finally { await new Promise((r) => setTimeout(r, 1500)); await g.stop(); }
  }
  const r = await startRust({ controlURL: control, authKey, hostname, state });
  try { return await within(r.running, 'the Rust client'); } finally { r.stop(); }
}

for (const [first, second] of [['go', 'rust'], ['rust', 'go']] as [Kind, Kind][]) {
  test(`a node the ${first} client made is the same node in the ${second} client, and back`, { skip, timeout: 240_000 }, async () => {
    const hostname = `${first}-first`;
    const key = execFileSync(script, ['key', 'lasting'], { encoding: 'utf8' }).trim();
    const state = new Map<string, string>();
    const nm1 = await run(first, state, hostname, key);
    const made = node(hostname);
    const count = nodes().length;
    assert.ok(state.has('_machinekey') && state.has('_current-profile'), `the ${first} client kept its node: ${[...state.keys()]}`);
    // No auth key from here on: a node that needed one would fail.
    const nm2 = await run(second, state, hostname);
    assert.equal(addrs(nm2), addrs(nm1), `the ${second} client has the same addresses`);
    assert.equal(node(hostname).id, made.id, 'the same node at the control server');
    const nm3 = await run(first, state, hostname);
    assert.equal(addrs(nm3), addrs(nm1), `the ${first} client again, on the store the ${second} one wrote`);
    assert.equal(node(hostname).id, made.id);
    assert.equal(nodes().length, count, 'no new node');
    console.log(`# ${first} → ${second} → ${first}: node ${made.id}, ${addrs(nm1)}`);
  });
}

test('the Rust client\'s netmap matches what the tailnet\'s peer sees', { skip, timeout: 120_000 }, async () => {
  const state = new Map<string, string>();
  const r = await startRust({ controlURL: control, authKey: execFileSync(script, ['key'], { encoding: 'utf8' }).trim(), hostname: 'netmap', state });
  try {
    const nm = await within(r.running, 'the Rust client');
    const peer = nm.peers.find((p) => p.addresses.some((a) => a.startsWith(`${env.WEBPC_TS_PEER_IP}/`)));
    assert.ok(peer, `the peer is in the netmap: ${JSON.stringify(nm.peers)}`);
    assert.equal(peer.name, env.WEBPC_TS_PEER_NAME);
    assert.ok(peer.addresses.includes(`${env.WEBPC_TS_PEER_IP6}/128`));
    assert.equal(peer.exitNodeOption, true, 'the peer offers itself as the exit node');
    assert.equal(peer.online, true);
    // The peer's view: our node with our addresses (headscale tells it within a few seconds).
    type Status = { Self: { TailscaleIPs: string[] }; Peer: Record<string, { HostName: string; DNSName: string; TailscaleIPs: string[] }> };
    let ours: Status['Peer'][string] | undefined;
    for (let i = 0; i < 40 && !ours; i++) {
      const st: Status = JSON.parse(execFileSync(script, ['peer', 'status', '--json'], { encoding: 'utf8' }));
      ours = Object.values(st.Peer ?? {}).find((p) => p.HostName === 'netmap');
      if (!ours) await new Promise((res) => setTimeout(res, 250));
      else assert.deepEqual(nm.peers.find((p) => p.name === peer.name)!.addresses.map((a) => a.replace(/\/\d+$/, '')).sort(), [...st.Self.TailscaleIPs].sort());
    }
    assert.ok(ours, 'the peer sees the node');
    assert.deepEqual([...ours.TailscaleIPs].sort(), nm.addresses.map((a) => a.replace(/\/\d+$/, '')).sort());
    assert.equal(ours.DNSName, nm.name);
    assert.deepEqual(nm.dns?.slice(0, 1), ['100.100.100.100'], 'MagicDNS on');
  } finally { r.stop(); }
});

test('the guest reaches the peer and is reached, through DERP, the filter and MagicDNS', { skip, timeout: 180_000 }, async () => {
  const got: Uint8Array[] = [];
  let arrived = () => {};
  const r = await startRust({ controlURL: control, authKey: execFileSync(script, ['key'], { encoding: 'utf8' }).trim(), hostname: 'dataplane', state: new Map(), packet: (p) => { got.push(p); arrived(); } });
  const udpServer = createSocket('udp4');
  const tcpServer = createServer((s) => s.end());
  try {
    const nm = await within(r.running, 'the Rust client');
    const self4 = nm.addresses.find((a) => !a.includes(':'))!.replace(/\/\d+$/, '');
    const self6 = nm.addresses.find((a) => a.includes(':'))!.replace(/\/\d+$/, '');
    const peer4 = env.WEBPC_TS_PEER_IP;
    const peer6 = env.WEBPC_TS_PEER_IP6;
    /** Sends `p` every 500 ms until a packet `match`es (resolves with it and the time since the last send) or `ms` pass. */
    const exchange = async (what: string, send: () => Uint8Array, match: (q: ReturnType<typeof pk.parse>) => boolean, ms = 20_000) => {
      const t0 = performance.now();
      while (performance.now() - t0 < ms) {
        got.length = 0;
        const sent = performance.now();
        r.client.guest(send());
        const deadline = sent + 500;
        while (performance.now() < deadline) {
          await new Promise<void>((res) => { arrived = res; setTimeout(res, deadline - performance.now()); });
          const hit = got.map(pk.parse).find(match);
          if (hit) return { hit, ms: performance.now() - t0, rtt: performance.now() - sent };
        }
      }
      throw new Error(`${what}: nothing back in ${ms / 1000} s; events: ${JSON.stringify(r.events.filter((e) => e.type === 'log' || e.type === 'state').slice(-10))}`);
    };

    let seq = 0;
    const first = await exchange('ping the peer', () => pk.ping(self4, peer4, 0x77, ++seq), (q) => q.proto === 1 && q.icmpType === 0 && q.src === peer4);
    console.log(`# first echo reply from the peer after ${first.ms.toFixed(0)} ms (DERP, the WireGuard handshake)`);
    const rtts: number[] = [];
    for (let i = 0; i < 10; i++) rtts.push((await exchange('ping again', () => pk.ping(self4, peer4, 0x77, ++seq), (q) => q.proto === 1 && q.icmpType === 0 && q.src === peer4)).rtt);
    rtts.sort((x, y) => x - y);
    console.log(`# ping RTT through the local DERP: median ${rtts[5].toFixed(1)} ms (min ${rtts[0].toFixed(1)}, max ${rtts[9].toFixed(1)})`);
    await exchange('ping the peer over IPv6', () => pk.ping(self6, peer6, 0x78, ++seq), (q) => q.proto === 58 && q.icmpType === 129);

    // MagicDNS: the peer's name, and a name in the tailnet's domain that doesn't exist.
    const peerName = env.WEBPC_TS_PEER_NAME.replace(/\.$/, '');
    const a = await exchange('MagicDNS', () => pk.udp(self4, 40001, '100.100.100.100', 53, pk.dnsQuery(7, peerName, 1)), (q) => q.proto === 17 && q.src === '100.100.100.100' && q.dport === 40001);
    assert.deepEqual(pk.dnsAnswers4(a.hit.payload), { rcode: 0, addrs: [peer4] });
    const nx = await exchange('MagicDNS NXDOMAIN', () => pk.udp(self4, 40002, '100.100.100.100', 53, pk.dnsQuery(8, `nope.${peerName.split('.').slice(1).join('.')}`, 1)), (q) => q.proto === 17 && q.dport === 40002);
    assert.equal(pk.dnsAnswers4(nx.hit.payload).rcode, 3);

    // UDP and TCP to servers on the peer's machine (its localhost).
    udpServer.on('message', (m, from) => udpServer.send(m, from.port, from.address));
    await new Promise<void>((res) => udpServer.bind(0, '127.0.0.1', res));
    const uport = udpServer.address().port;
    const echo = await exchange('UDP echo', () => pk.udp(self4, 41000, peer4, uport, new TextEncoder().encode('hello peer')), (q) => q.proto === 17 && q.sport === uport && q.dport === 41000);
    assert.equal(new TextDecoder().decode(echo.hit.payload), 'hello peer');
    await new Promise<void>((res) => tcpServer.listen(0, '127.0.0.1', res));
    const tport = (tcpServer.address() as { port: number }).port;
    const synack = await exchange('TCP SYN', () => pk.tcpSyn(self4, 42000, peer4, tport), (q) => q.proto === 6 && q.sport === tport);
    assert.equal(synack.hit.flags & 0x12, 0x12, 'a SYN-ACK');

    // Reached: the peer's disco ping (answered by a pong through DERP) and a TCP connection to the guest.
    const run = promisify(execFile);
    const pong = await run(script, ['peer', 'ping', '-c', '5', self4], { timeout: 30_000 }).then((o) => o.stdout, (e) => `${e.stdout}${e.stderr}`);
    assert.match(pong, /pong from dataplane .* via DERP/, pong);
    got.length = 0;
    const nc = run(script, ['peer', 'nc', self4, '8080'], { timeout: 10_000 }).catch(() => {});
    let syn: ReturnType<typeof pk.parse> | undefined;
    for (let i = 0; i < 100 && !syn; i++) {
      await new Promise((res) => setTimeout(res, 50));
      syn = got.map(pk.parse).find((q) => q.proto === 6 && q.dport === 8080 && (q.flags & 0x12) === 0x02);
    }
    assert.ok(syn, 'the peer\'s SYN reaches the guest through the filter');
    assert.equal(syn.src, peer4);
    await nc;

    // The exit node: the peer offers it, the client takes it and gives it back; an unknown one is refused.
    const answer = async (id: string) => {
      const n = r.events.length;
      r.client.setExitNode(id);
      const e = r.events.slice(n).find((x) => x.type === 'exitnode') as { error: string } | undefined;
      return e?.error;
    };
    const exitPeer = nm.peers.find((p) => p.exitNodeOption)!;
    assert.equal(await answer(exitPeer.id), '');
    assert.equal(r.netmap()?.exitNode, exitPeer.id);
    assert.equal(await answer(''), '');
    assert.match((await answer('no-such-peer'))!, /no peer/);
  } finally {
    r.stop();
    udpServer.close();
    tcpServer.close();
  }
});

test('without an auth key the node logs in interactively: a login URL, then the node once it\'s approved', { skip, timeout: 120_000 }, async () => {
  let url = '';
  const r = await startRust({ controlURL: control, hostname: 'interactive', state: new Map(), onLogin: (u) => { url = u; } });
  try {
    for (let i = 0; i < 100 && !url; i++) await new Promise((res) => setTimeout(res, 100));
    assert.match(url, /\/register\/\S+$/, 'headscale\'s login URL');
    assert.ok(r.events.some((e) => e.type === 'state' && e.state === 'NeedsLogin'));
    // The admin approves the login (what the user's browser does with Tailscale's own control server).
    execFileSync(script, ['register', url.split('/').pop()!], { encoding: 'utf8' });
    const nm = await within(r.running, 'the Rust client after the login');
    assert.equal(nm.name.split('.')[0], 'interactive');
  } finally { r.stop(); }
});
