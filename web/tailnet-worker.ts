// The Tailscale backend's worker (docs/tailnet.md "Tailscale"): the tailnet client (net/ts,
// target/net/ts.wasm) logged in to a control server, its packets on the gateway's IP port
// (web/tailscale.ts `ToTailscale`, `FromTailscale`). With `persist`, the node is kept in the Go
// client's store format (web/tailscale-state.ts), so a node the Go client made before is the same node. While an exit
// node is in use, it checks whether the exit node's machine reaches the internet over IPv6 (web/reach6.ts), and leases
// the guest no IPv6 default route while it doesn't.
import { batchSender, packetsOf } from './net.ts';
import { TsClient, TsModule } from './ts-client.ts';
import { leaseFrom, subnetsOf, type FromTailscale, type NetMap, type ToTailscale } from './tailscale.ts';
import { openState } from './tailscale-state.ts';
import { ranked, routedLease, TAILNET_ROUTES, type Lease } from './gateway.ts';
import { reach6, unreached6, type Reach6, type Reach6Options } from './reach6.ts';

const post = (m: FromTailscale, transfer: Transferable[] = []) => self.postMessage(m, transfer);

let ip: MessagePort | undefined;
let send: ((packet: Uint8Array) => void) | undefined;
let lease: Lease | null = null;
/** The netmap's installed subnet routes: a lease that isn't the default way out routes them too. */
let subnets = subnetsOf(undefined);
/** The lease last posted (JSON): a netmap that changes nothing of it (a peer coming online) posts none, so no router advertisement either. */
let posted = '';
/** This adapter is the guest's default way out (docs/network-adapters.md §4): otherwise its lease carries only the network's routes. */
let primary = true;
/** Its place among the machine's connected adapters: its IPv6 routes' preference (`ranked`). */
let rank = 0;
let client: TsClient | undefined;
/** While an exit node is in use (`reachVia`, its stable ID): whether its machine's IPv6 reaches the internet. */
let reach: Reach6 | undefined;
let reachVia = '';
let probe6: Reach6Options | undefined;
const offered = () => {
  const routes = { v4: [...TAILNET_ROUTES.v4, ...subnets.v4], v6: [...TAILNET_ROUTES.v6, ...subnets.v6] };
  const l = routedLease(lease, primary, routes);
  return ranked(reach && !reach.reached() ? unreached6(l, routes.v6) : l, rank);
};
/** Tells the gateway the lease, if it changed (`force`: a new port, which hasn't heard it). */
function postLease(force = false) {
  const l = offered();
  const json = JSON.stringify(l);
  if (!force && json === posted) return;
  posted = json;
  ip?.postMessage({ type: 'lease', lease: l });
}
function takeNetmap(nm: NetMap) {
  lease = leaseFrom(nm);
  subnets = subnetsOf(nm);
  probeVia(nm.exitNode ?? '');
  postLease();
}

/** The exit node in use (''); another one is probed from scratch (out until it answers). */
function probeVia(id: string) {
  if (id !== reachVia) {
    reach?.stop();
    reach = id ? reach6((p) => client?.guest(p), () => postLease(), probe6) : undefined;
    reachVia = id;
  }
  if (lease?.address6) reach?.start(lease.address6);
}
let state: Awaited<ReturnType<typeof openState>> | undefined;

function attach(port: MessagePort) {
  if (ip) { ip.onmessage = null; ip.close(); }
  ip = port;
  send = batchSender(port);
  port.onmessage = (ev: MessageEvent) => {
    const packets = packetsOf(ev.data);
    if (packets) client?.guest(...packets);
  };
  postLease(true);
}

self.onmessage = async (e: MessageEvent<ToTailscale>) => {
  const m = e.data;
  if (m.type === 'attach') return attach(m.ip);
  if (m.type === 'primary') {
    primary = m.primary;
    rank = m.rank ?? 0;
    return postLease();
  }
  if (m.type === 'detach') {
    lease = null;
    probeVia('');
    ip?.postMessage({ type: 'lease', lease: null });
    posted = 'null';
    if (ip) ip.onmessage = null;
    post({ type: 'detached', ip }, ip ? [ip] : []);
    ip = undefined;
    send = undefined;
    return;
  }
  if (m.type === 'exitnode') {
    if (!client) return post({ type: 'exitnode', error: 'the client isn\'t running' });
    return client.setExitNode(m.id);
  }
  if (m.type === 'routes') return client?.setAcceptRoutes(m.on);
  if (m.type === 'logout') {
    if (!client) return post({ type: 'loggedout' });
    // `loggedout` comes from the client once the control server has expired the key (or couldn't be reached).
    return client.logout();
  }
  try {
    // The port is this worker's from now: a detach while the module loads hands it back.
    attach(m.ip);
    const t0 = performance.now();
    const mod = await TsModule.load(m.wasm);
    post({ type: 'loaded', ms: performance.now() - t0 });
    if (m.persist) state = await openState(m.persist);
    if (!ip) return; // detached meanwhile
    probe6 = m.probe6;
    client = new TsClient(mod, {
      control: { url: m.controlURL, authKey: m.authKey, hostname: m.hostname ?? 'webpc', ephemeral: !m.persist },
      state: state?.entries() ?? {},
      exitNode: m.exitNode ?? '',
      acceptRoutes: m.acceptRoutes ?? true,
    }, {
      packet: (p) => { if (!reach?.take(p)) send?.(p); },
      event(ev) {
        switch (ev.type) {
          case 'log': return console.log('tailnet:', ev.msg);
          case 'store': return state?.setState(ev.key, ev.value);
          case 'login': return post({ type: 'login', url: ev.url });
          case 'exitnode': return post({ type: 'exitnode', error: ev.error });
          case 'loggedout': return void (state?.clear() ?? Promise.resolve()).then(() => post({ type: 'loggedout' }));
          case 'netmap':
            takeNetmap(ev.netmap);
            return post({ type: 'netmap', netmap: ev.netmap });
          case 'state':
            if (ev.state === 'Failed') return post({ type: 'error', error: ev.error ?? 'the client failed' });
            return post({ type: 'state', state: ev.state });
        }
      },
    });
  } catch (err) {
    post({ type: 'error', error: String((err as Error)?.message ?? err) });
  }
};
