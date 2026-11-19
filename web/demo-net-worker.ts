// The demo network's client in a worker of its own (web/demo-net.ts `startDemo`; docs/networking/demo-network.md), as
// the local helper's is (web/local-net-worker.ts): it holds the card's IP port while it runs and puts the card on a
// frame port of its own (web/gateway.ts `FramePath`), whose frames go to the server's WebSocket (`startDemoNet`). It
// speaks the tailnet clients' worker protocol as far as it has the same things (start, attach, detach, state, a
// network map with the demo network's status, errors) and posts the message bar's notices (`{type: 'notice'}`).
import { demoNetmap, startDemoNet, type DemoNet } from './demo-net.ts';
import type { ToLocal } from './local-net.ts';
import { MsgError, toWire } from './msg.ts';
import type { FromTailscale } from './tailscale.ts';

const post = (m: FromTailscale, transfer: Transferable[] = []) => self.postMessage(m, transfer);

let ip: MessagePort | undefined;
let client: DemoNet | undefined;
let url = '';

/** Puts the card behind `port` on a new frame channel; the client (started the first time) takes its other end. */
function attach(port: MessagePort) {
  ip?.close();
  ip = port;
  const ch = new MessageChannel();
  port.postMessage({ type: 'frames', port: ch.port2 }, [ch.port2]);
  // A restarted machine keeps the socket, so its network and the server's budgets aren't spent on a new one.
  if (client && client.state() !== 'closed') client.setFrames(ch.port1);
  else client = startDemoNet(url, ch.port1, { change: () => queueMicrotask(report), notice: (notice) => post({ type: 'notice', notice }) });
}

let last = '';
function report() {
  const c = client;
  if (!c) return;
  const s = c.state();
  if (s === 'closed') return post({ type: 'error', error: toWire(c.error() ?? new MsgError('network:demo-net-worker.closed')) });
  post({ type: 'netmap', netmap: demoNetmap(c.lease(), c.status()) });
  const state = s === 'connected' || s === 'idle' ? 'Running' : 'Connecting';
  if (state !== last) post({ type: 'state', state });
  last = state;
}

self.onmessage = (e: MessageEvent<ToLocal>) => {
  const m = e.data;
  if (m.type === 'start') {
    url = m.url;
    post({ type: 'state', state: 'Connecting' });
    last = 'Connecting';
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
