// The Tailscale backend's worker (docs/tailnet.md "Tailscale"): the tailnet client (net/ts,
// target/net/ts.wasm) logged in to a control server, its packets on the gateway's IP port
// (web/tailscale.ts `ToTailscale`, `FromTailscale`). With `persist`, the node is kept in the Go
// client's store format (web/tailscale-state.ts), so a node the Go client made before is the same node.
import { batchSender, packetsOf } from './net.ts';
import { TsClient, TsModule } from './ts-client.ts';
import { leaseFrom, type FromTailscale, type ToTailscale } from './tailscale.ts';
import { openState } from './tailscale-state.ts';
import { routedLease, TAILNET_ROUTES, type Lease } from './gateway.ts';

const post = (m: FromTailscale, transfer: Transferable[] = []) => self.postMessage(m, transfer);

let ip: MessagePort | undefined;
let send: ((packet: Uint8Array) => void) | undefined;
let lease: Lease | null = null;
/** This adapter is the guest's default way out (docs/plans/network-adapters.md §4): otherwise its lease carries only the network's routes. */
let primary = true;
const offered = () => routedLease(lease, primary, TAILNET_ROUTES);
let client: TsClient | undefined;
let state: Awaited<ReturnType<typeof openState>> | undefined;

function attach(port: MessagePort) {
  if (ip) { ip.onmessage = null; ip.close(); }
  ip = port;
  send = batchSender(port);
  port.onmessage = (ev: MessageEvent) => {
    const packets = packetsOf(ev.data);
    if (packets) client?.guest(...packets);
  };
  port.postMessage({ type: 'lease', lease: offered() });
}

self.onmessage = async (e: MessageEvent<ToTailscale>) => {
  const m = e.data;
  if (m.type === 'attach') return attach(m.ip);
  if (m.type === 'primary') {
    primary = m.primary;
    return ip?.postMessage({ type: 'lease', lease: offered() });
  }
  if (m.type === 'detach') {
    lease = null;
    ip?.postMessage({ type: 'lease', lease: null });
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
  if (m.type === 'logout') {
    if (!client) return post({ type: 'loggedout' });
    // `loggedout` comes from the client once the control server has expired the key (or couldn't be reached).
    return client.logout();
  }
  try {
    const t0 = performance.now();
    const mod = await TsModule.load(m.wasm);
    post({ type: 'loaded', ms: performance.now() - t0 });
    if (m.persist) state = await openState(m.persist);
    attach(m.ip);
    client = new TsClient(mod, {
      control: { url: m.controlURL, authKey: m.authKey, hostname: m.hostname ?? 'webpc', ephemeral: !m.persist },
      state: state?.entries() ?? {},
      exitNode: m.exitNode ?? '',
    }, {
      packet: (p) => send?.(p),
      event(ev) {
        switch (ev.type) {
          case 'log': return console.log('tailnet:', ev.msg);
          case 'store': return state?.setState(ev.key, ev.value);
          case 'login': return post({ type: 'login', url: ev.url });
          case 'exitnode': return post({ type: 'exitnode', error: ev.error });
          case 'loggedout': return void (state?.clear() ?? Promise.resolve()).then(() => post({ type: 'loggedout' }));
          case 'netmap':
            lease = leaseFrom(ev.netmap);
            ip?.postMessage({ type: 'lease', lease: offered() });
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
