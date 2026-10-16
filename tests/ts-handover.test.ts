// The kept node carries over (docs/plans/tailnet-client.md §5, T4): the Go client (net/tailscale,
// in Node: tests/net/go-client.ts) and the Rust one (net/ts: tests/net/rust-client.ts) run on the
// same store, the page's IndexedDB entries as a map, against a headscale (tests/net/tailnet.sh).
// Each starts on the store the other wrote and is the same node: headscale's node ID and the
// node's addresses unchanged, no new node. Both ways, from a store either one made.
// Opt-in: WEBPC_TAILNET=1 (needs Podman, or WEBPC_TAILNET_SCRIPT=tests/net/tailnet-native.sh;
// target/net/tailscale.wasm and target/net/ts.wasm). The rig's test CA is trusted once it's up
// (`trust`), here and in the Go client's worker.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
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
