// The local helper's client in a worker of its own (web/local-net.ts `startLocal`; docs/networking/local-helper.md "The page's side": off
// the page's main thread at no cost, and a worker's socket asks for Local Network Access as the page's does). It holds
// the card's IP port while it runs and puts the card on a frame port of its own (web/gateway.ts `FramePath`); the frames
// go to the helper's WebSocket (`startLocalNet`). It speaks the tailnet clients' worker protocol as far as it has the
// same things: start, attach, detach, state, a network map, errors.
import { helperClosed, localNetmap, startLocalNet, type LocalNet, type ToLocal } from './local-net.ts';
import { toWire } from './msg.ts';
import type { FromTailscale } from './tailscale.ts';

const post = (m: FromTailscale, transfer: Transferable[] = []) => self.postMessage(m, transfer);

let ip: MessagePort | undefined;
let client: LocalNet | undefined;
let url = '';

/** Puts the card behind `port` on a new frame channel, and the client on its other end. */
function attach(port: MessagePort) {
  ip?.close();
  ip = port;
  const ch = new MessageChannel();
  port.postMessage({ type: 'frames', port: ch.port2 }, [ch.port2]);
  client?.close();
  client = startLocalNet(url, ch.port1, report);
}

function report() {
  const c = client;
  if (!c) return;
  const s = c.state();
  // Closed: an error each time it's told (the reason can come later: the permission's answer).
  if (s === 'closed') return post({ type: 'error', error: toWire(c.error() ?? helperClosed()) });
  post({ type: 'netmap', netmap: localNetmap(c.lease()) });
  post({ type: 'state', state: s === 'connected' ? 'Running' : 'Connecting' });
}

self.onmessage = (e: MessageEvent<ToLocal>) => {
  const m = e.data;
  if (m.type === 'start') {
    url = m.url;
    post({ type: 'state', state: 'Connecting' });
    return attach(m.ip);
  }
  if (m.type === 'attach') return attach(m.ip);
  // Detach: the socket closes, and the card stays on frames with none (the next client says which way it goes).
  client?.close();
  client = undefined;
  ip?.postMessage({ type: 'frames', port: null });
  if (ip) ip.onmessage = null;
  post({ type: 'detached', ip }, ip ? [ip] : []);
  ip = undefined;
};
