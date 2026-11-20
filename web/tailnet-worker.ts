// The Tailscale backend's worker (docs/networking/tailnet.md "Tailscale"): the tailnet client (net/ts,
// target/net/ts.wasm) logged in to a control server, its packets on the gateway's IP port
// (web/tailscale.ts `ToTailscale`, `FromTailscale`). With `persist`, the node is kept in the Go
// client's store format (web/tailscale-state.ts), so a node the Go client made before is the same node. While an exit
// node is in use, it checks whether the exit node's machine reaches the internet over IPv6 (web/reach6.ts), and leases
// the guest no IPv6 default route while it doesn't.
import { MsgError, toWire } from './msg.ts';
import { exitNodeError, failureOf, TsClient, TsModule } from './ts-client.ts';
import { leaseFrom, subnetsOf, type FromTailscale, type NetMap, type ToTailscale } from './tailscale.ts';
import { openState } from './tailscale-state.ts';
import { ranked, routedLease, TAILNET_ROUTES, type Lease } from './gateway.ts';
import { ipPortHost } from './ts-port.ts';
import { reach6, unreached6, type Reach6, type Reach6Options } from './reach6.ts';

const post = (m: FromTailscale, transfer: Transferable[] = []) => self.postMessage(m, transfer);

/** The client's lease (from its netmap); the gateway's port hears it routed for the adapter's place (`offered`). */
let lease: Lease | null = null;
/** The netmap's installed subnet routes: a lease that isn't the default way out routes them too. */
let subnets = subnetsOf(undefined);
let client: TsClient | undefined;
/** While an exit node is in use (`reachVia`, its stable ID): whether its machine's IPv6 reaches the internet. */
let reach: Reach6 | undefined;
let reachVia = '';
let probe6: Reach6Options | undefined;
const port = ipPortHost(
  ({ primary, primary6, rank }) => {
    const routes = { v4: [...TAILNET_ROUTES.v4, ...subnets.v4], v6: [...TAILNET_ROUTES.v6, ...subnets.v6] };
    const l = routedLease(lease, primary, routes, primary6);
    return ranked(reach && !reach.reached() ? unreached6(l, routes.v6) : l, rank);
  },
  (packets) => client?.guest(...packets),
);
/** The last netmap, posted again with `reached6` when the probe's answer changes. */
let netmap: NetMap | undefined;
const postNetmap = () => netmap && post({ type: 'netmap', netmap: { ...netmap, reached6: !!reach?.reached() } });
function takeNetmap(nm: NetMap) {
  netmap = nm;
  lease = leaseFrom(nm);
  subnets = subnetsOf(nm);
  probeVia(nm.exitNode ?? '');
  port.postLease();
  postNetmap();
}

/** The exit node in use (''); another one is probed from scratch (out until it answers). */
function probeVia(id: string) {
  if (id !== reachVia) {
    reach?.stop();
    reach = id
      ? reach6(
          (p) => client?.guest(p),
          () => {
            port.postLease();
            postNetmap();
          },
          probe6,
        )
      : undefined;
    reachVia = id;
  }
  if (lease?.address6) reach?.start(lease.address6);
}
let state: Awaited<ReturnType<typeof openState>> | undefined;

self.onmessage = async (e: MessageEvent<ToTailscale>) => {
  const m = e.data;
  if (m.type === 'attach') return port.attach(m.ip);
  if (m.type === 'primary') return port.place(m);
  if (m.type === 'detach') {
    // The client stays (logged in, its netmap coming): the next attach is the same node.
    lease = null;
    netmap = undefined;
    probeVia('');
    const ip = port.detach();
    return post({ type: 'detached', ip }, ip ? [ip] : []);
  }
  if (m.type === 'exitnode') {
    if (!client) return post({ type: 'exitnode', error: toWire(new MsgError('network:tailnet-worker.notRunning')) });
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
    port.attach(m.ip);
    const t0 = performance.now();
    const mod = await TsModule.load(m.wasm);
    post({ type: 'loaded', ms: performance.now() - t0 });
    if (m.persist) state = await openState(m.persist);
    if (!port.attached()) return; // detached meanwhile
    probe6 = m.probe6;
    client = new TsClient(
      mod,
      {
        control: { url: m.controlURL, authKey: m.authKey, hostname: m.hostname ?? 'waarm64', ephemeral: !m.persist },
        state: state?.entries() ?? {},
        exitNode: m.exitNode ?? '',
        acceptRoutes: m.acceptRoutes ?? true,
      },
      {
        packet: (p) => {
          if (!reach?.take(p)) port.send(p);
        },
        event(ev) {
          switch (ev.type) {
            case 'log':
              return console.log('tailnet:', ev.msg);
            case 'store':
              return state?.setState(ev.key, ev.value);
            case 'login':
              return post({ type: 'login', url: ev.url });
            case 'exitnode':
              return post(ev.code ? { type: 'exitnode', error: toWire(exitNodeError(ev)) } : { type: 'exitnode' });
            case 'loggedout':
              return void (state?.clear() ?? Promise.resolve()).then(() => post({ type: 'loggedout' }));
            case 'netmap':
              return takeNetmap(ev.netmap);
            case 'state':
              if (ev.state === 'Failed')
                return post({
                  type: 'error',
                  error: toWire(ev.code ? failureOf(ev) : new MsgError('network:tailnet-worker.failed')),
                });
              return post({ type: 'state', state: ev.state });
          }
        },
      },
    );
  } catch (err) {
    post({ type: 'error', error: toWire(err) });
  }
};
