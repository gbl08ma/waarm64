// The tailcat backend's worker (web/tailcat.ts, docs/tailnet.md
// §4): the Rust tailnet client (net/ts) connected to a tailcat server, its
// packets on the gateway's IP port. It speaks the Go client's worker protocol
// (web/tailscale.ts `ToTailscale`, `FromTailscale`) as far as tailcat has the
// same things: start, attach, detach, state, a network map, errors. Serving
// (T3), it gives the module the kept identity (so the machine's address stays
// the same) and, on tailcat's public relays, the nearest region.
import { batchSender, packetsOf } from './net.ts';
import { TsClient, TsModule, type TailcatConfig } from './ts-client.ts';
import type { FromTailscale } from './tailscale.ts';
import { nearestRegion, netmapOf, tailcatIdentity, type ToTailcat } from './tailcat.ts';
import type { Lease } from './gateway.ts';

const post = (m: FromTailscale, transfer: Transferable[] = []) => self.postMessage(m, transfer);

let ip: MessagePort | undefined;
let send: ((packet: Uint8Array) => void) | undefined;
let lease: Lease | null = null;
let client: TsClient | undefined;
let serving: string | undefined;
let exit = true;

function attach(port: MessagePort) {
  if (ip) { ip.onmessage = null; ip.close(); }
  ip = port;
  send = batchSender(port);
  port.onmessage = (ev: MessageEvent) => {
    const packets = packetsOf(ev.data);
    if (packets) client?.guest(...packets);
  };
  port.postMessage({ type: 'lease', lease });
}

self.onmessage = async (e: MessageEvent<ToTailcat>) => {
  const m = e.data;
  if (m.type === 'attach') return attach(m.ip);
  if (m.type === 'detach') {
    lease = null;
    ip?.postMessage({ type: 'lease', lease: null });
    if (ip) ip.onmessage = null;
    client?.close();
    client = undefined;
    post({ type: 'detached', ip }, ip ? [ip] : []);
    ip = undefined;
    send = undefined;
    return;
  }
  try {
    const t0 = performance.now();
    const mod = await TsModule.load(m.wasm);
    post({ type: 'loaded', ms: performance.now() - t0 });
    attach(m.ip);
    exit = !!m.addr;
    const config: TailcatConfig = { addr: m.addr, derpMapURL: m.derpMapURL };
    if (m.serve) {
      const id = await tailcatIdentity();
      const region = m.addr || m.serve.relay ? 0 : await nearestRegion(m.derpMapURL ?? 'https://tailcat.dev/derpmap.json').catch(() => 0);
      Object.assign(config, { key: id.key, serve: { psk: id.psk, relay: m.addr ? '' : m.serve.relay, region } });
    }
    client = new TsClient(mod, config, {
      packet: (p) => send?.(p),
      event(ev) {
        if (ev.type === 'log') return console.log('tailcat:', ev.msg);
        if (ev.type === 'self') return;
        if (ev.type === 'client') return console.log('tailcat: a client came in,', ev.key);
        if (ev.type === 'serving') {
          serving = ev.addr;
          if (lease) post({ type: 'netmap', netmap: netmapOf(lease, serving, exit) });
          return;
        }
        if (ev.type === 'lease') {
          lease = ev.lease;
          ip?.postMessage({ type: 'lease', lease });
          post({ type: 'netmap', netmap: netmapOf(lease, serving, exit) });
          return;
        }
        if (ev.type !== 'state') return; // the Tailscale client's events
        if (ev.state === 'Failed') return post({ type: 'error', error: ev.error ?? 'the connection failed' });
        post({ type: 'state', state: ev.state });
      },
    });
  } catch (err) {
    post({ type: 'error', error: String((err as Error)?.message ?? err) });
  }
};
