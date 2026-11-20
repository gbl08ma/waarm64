// The tailcat backend's worker (web/tailcat.ts, docs/networking/tailnet.md
// §4): the Rust tailnet client (net/ts) connected to a tailcat server, its
// packets on the gateway's IP port. It speaks the Go client's worker protocol
// (web/tailscale.ts `ToTailscale`, `FromTailscale`) as far as tailcat has the
// same things: start, attach, detach, state, a network map, errors. Serving
// (T3), it gives the module the kept identity (so the machine's address stays
// the same) and, on tailcat's public relays, the nearest region; a kept connection's key is the same going online
// through a server too (so the server can `--allow` it). Going online through a server, it checks
// whether the server's machine reaches the internet over IPv6 (web/reach6.ts), and leases the guest no IPv6
// default route while it doesn't.
import { MsgError, toWire } from './msg.ts';
import { failureOf, TsClient, TsModule, type TailcatConfig } from './ts-client.ts';
import type { FromTailscale } from './tailscale.ts';
import { nearestRegion, netmapOf, tailcatIdentity, type ToTailcat } from './tailcat.ts';
import { ranked, routedLease, TAILCAT_ROUTES, type Lease, type Prefix } from './gateway.ts';
import { ipPortHost } from './ts-port.ts';
import { reach6, unreached6, type Reach6 } from './reach6.ts';

const post = (m: FromTailscale, transfer: Transferable[] = []) => self.postMessage(m, transfer);

let lease: Lease | null = null;
let client: TsClient | undefined;
let serving: string | undefined;
let exit = true;
/** The machine's node key (`nodekey:…`). */
let selfKey: string | undefined;
/** Through a server: whether its machine's IPv6 reaches the internet. */
let reach: Reach6 | undefined;
/** The clients let in: each a route of its own, so the guest answers them here beside a tailnet's /48 (docs/networking/adapters.md §4). */
let clients: Prefix[] = [];
const port = ipPortHost(
  ({ primary, primary6, rank }) => {
    const l = routedLease(lease, primary, TAILCAT_ROUTES, primary6);
    const r = ranked(reach && !reach.reached() ? unreached6(l, TAILCAT_ROUTES.v6) : l, rank);
    return r && { ...r, peers6: clients };
  },
  (packets) => client?.guest(...packets),
);

/** The network map for the page, with whether the server's IPv6 reaches the internet (`reached6`). */
function postNetmap() {
  if (lease)
    post({ type: 'netmap', netmap: { ...netmapOf(lease, serving, exit, selfKey), reached6: !!reach?.reached() } });
}

self.onmessage = async (e: MessageEvent<ToTailcat>) => {
  const m = e.data;
  if (m.type === 'attach') return port.attach(m.ip);
  if (m.type === 'primary') return port.place(m);
  if (m.type === 'detach') {
    // The client closes: the next start connects again.
    lease = null;
    clients = [];
    reach?.stop();
    reach = undefined;
    const ip = port.detach();
    client?.close();
    client = undefined;
    return post({ type: 'detached', ip }, ip ? [ip] : []);
  }
  try {
    // The port is this worker's from now: a detach while the module loads hands it back.
    port.attach(m.ip);
    const t0 = performance.now();
    const mod = await TsModule.load(m.wasm);
    post({ type: 'loaded', ms: performance.now() - t0 });
    if (!port.attached()) return; // detached meanwhile
    exit = !!m.addr;
    const config: TailcatConfig = { addr: m.addr, derpMapURL: m.derpMapURL };
    const id =
      m.identity ?? (m.identityKey !== undefined || m.serve ? await tailcatIdentity(m.identityKey) : undefined);
    if (id) config.key = id.key;
    if (m.serve && id) {
      const region =
        m.addr || m.serve.relay
          ? 0
          : await nearestRegion(m.derpMapURL ?? 'https://tailcat.dev/derpmap.json').catch(() => 0);
      config.serve = { psk: id.psk, relay: m.addr ? '' : m.serve.relay, region, allow: m.serve.allow ?? [] };
    }
    if (!port.attached()) return; // detached meanwhile
    if (exit)
      reach = reach6(
        (p) => client?.guest(p),
        () => {
          port.postLease();
          postNetmap();
        },
        m.probe6,
      );
    client = new TsClient(mod, config, {
      packet: (p) => {
        if (!reach?.take(p)) port.send(p);
      },
      event(ev) {
        if (ev.type === 'log') return console.log('tailcat:', ev.msg);
        if (ev.type === 'self') {
          selfKey = ev.key;
          return;
        }
        if (ev.type === 'client' || ev.type === 'client-gone') {
          console.log(
            ev.type === 'client' ? 'tailcat: a client came in,' : 'tailcat: a client that made room is forgotten,',
            ev.key,
          );
          const same = (p: Prefix) => p[0].every((b, k) => b === ev.address6[k]);
          clients = clients.filter((p) => !same(p));
          if (ev.type === 'client') clients.push([ev.address6, 128]);
          return port.postLease();
        }
        if (ev.type === 'serving') {
          serving = ev.addr;
          return postNetmap();
        }
        if (ev.type === 'lease') {
          lease = ev.lease;
          if (lease?.address6) reach?.start(lease.address6);
          port.postLease();
          return postNetmap();
        }
        if (ev.type !== 'state') return; // the Tailscale client's events
        if (ev.state === 'Failed')
          return post({
            type: 'error',
            error: toWire(ev.code ? failureOf(ev) : new MsgError('network:tailcat-worker.failed')),
          });
        post({ type: 'state', state: ev.state });
      },
    });
  } catch (err) {
    post({ type: 'error', error: toWire(err) });
  }
};
