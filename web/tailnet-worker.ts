// The Rust Tailscale backend's worker (docs/plans/tailnet-client.md §5): the tailnet client (net/ts,
// target/net/ts.wasm) logged in to a control server, its packets on the gateway's IP port. It speaks
// the Go client's worker protocol (web/tailscale.ts `ToTailscale`, `FromTailscale`; the Go one is
// web/tailscale-worker.ts), so the page and the gateway don't know which client runs. With
// `persist`, the node is kept in the Go client's store as it is (web/tailscale-state.ts): either
// client comes back as the same node.
import { TsClient, TsModule } from './ts-client.ts';
import { leaseFrom, type FromTailscale, type ToTailscale } from './tailscale.ts';
import { openState } from './tailscale-state.ts';
import type { Lease } from './gateway.ts';

const post = (m: FromTailscale, transfer: Transferable[] = []) => self.postMessage(m, transfer);

let ip: MessagePort | undefined;
let lease: Lease | null = null;
let client: TsClient | undefined;
let state: Awaited<ReturnType<typeof openState>> | undefined;

function attach(port: MessagePort) {
  if (ip) { ip.onmessage = null; ip.close(); }
  ip = port;
  port.onmessage = (ev: MessageEvent) => { if (ev.data instanceof ArrayBuffer) client?.guest(new Uint8Array(ev.data)); };
  port.postMessage({ type: 'lease', lease });
}

self.onmessage = async (e: MessageEvent<ToTailscale>) => {
  const m = e.data;
  if (m.type === 'attach') return attach(m.ip);
  if (m.type === 'detach') {
    lease = null;
    ip?.postMessage({ type: 'lease', lease: null });
    if (ip) ip.onmessage = null;
    post({ type: 'detached', ip }, ip ? [ip] : []);
    ip = undefined;
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
      packet(p) {
        if (!ip) return;
        const b = p.buffer.byteLength === p.length ? p.buffer : p.slice().buffer;
        ip.postMessage(b, [b]);
      },
      event(ev) {
        switch (ev.type) {
          case 'log': return console.log('tailnet:', ev.msg);
          case 'store': return state?.setState(ev.key, ev.value);
          case 'login': return post({ type: 'login', url: ev.url });
          case 'exitnode': return post({ type: 'exitnode', error: ev.error });
          case 'loggedout': return void (state?.clear() ?? Promise.resolve()).then(() => post({ type: 'loggedout' }));
          case 'netmap':
            lease = leaseFrom(ev.netmap);
            ip?.postMessage({ type: 'lease', lease });
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
