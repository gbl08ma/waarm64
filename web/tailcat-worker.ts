// The tailcat backend's worker (web/tailcat.ts, docs/plans/tailnet-client.md
// §4): the Rust tailnet client (net/ts) connected to a tailcat server, its
// packets on the gateway's IP port. It speaks the Go client's worker protocol
// (web/tailscale.ts `ToTailscale`, `FromTailscale`) as far as tailcat has the
// same things: start, attach, detach, state, a network map, errors.
import { TsClient, TsModule } from './ts-client.ts';
import type { FromTailscale } from './tailscale.ts';
import { netmapOf, type ToTailcat } from './tailcat.ts';
import type { Lease } from './gateway.ts';

const post = (m: FromTailscale, transfer: Transferable[] = []) => self.postMessage(m, transfer);

let ip: MessagePort | undefined;
let lease: Lease | null = null;
let client: TsClient | undefined;

function attach(port: MessagePort) {
  if (ip) { ip.onmessage = null; ip.close(); }
  ip = port;
  port.onmessage = (ev: MessageEvent) => { if (ev.data instanceof ArrayBuffer) client?.guest(new Uint8Array(ev.data)); };
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
    return;
  }
  try {
    const t0 = performance.now();
    const mod = await TsModule.load(m.wasm);
    post({ type: 'loaded', ms: performance.now() - t0 });
    attach(m.ip);
    client = new TsClient(mod, { addr: m.addr, derpMapURL: m.derpMapURL }, {
      packet(p) {
        if (!ip) return;
        const b = p.buffer.byteLength === p.length ? p.buffer : p.slice().buffer;
        ip.postMessage(b, [b]);
      },
      event(ev) {
        if (ev.type === 'log') return console.log('tailcat:', ev.msg);
        if (ev.type === 'self') return;
        if (ev.type === 'lease') {
          lease = ev.lease;
          ip?.postMessage({ type: 'lease', lease });
          post({ type: 'netmap', netmap: netmapOf(lease) });
          return;
        }
        if (ev.state === 'Failed') return post({ type: 'error', error: ev.error ?? 'the connection failed' });
        post({ type: 'state', state: ev.state });
      },
    });
  } catch (err) {
    post({ type: 'error', error: String((err as Error)?.message ?? err) });
  }
};
