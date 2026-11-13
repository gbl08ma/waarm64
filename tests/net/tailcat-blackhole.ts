// The tailnet client (net/ts, web/ts-client.ts) in Node against the tailcat rig (tests/net/tailcat.sh), its relay's
// path dying without a word: the WebSocket stays open, and nothing passes either way (a laptop that slept, a network
// that changed). The guest keeps sending UDP echoes to this machine through the exit node; the client must notice
// (derp.rs "Liveness") and reconnect. Prints one JSON line: how long the echoes stopped, the WebSockets opened.
// Usage: NODE_EXTRA_CA_CERTS=$WAARM64_TAILCAT_CA node tests/net/tailcat-blackhole.ts <tc… address>
// (tests/ts-tailcat.test.ts runs it).
import { createSocket } from 'node:dgram';
import { readFileSync } from 'node:fs';
import { checksum } from '../../web/net.ts';
import { failureOf, TsClient, TsModule } from '../../web/ts-client.ts';

const [addr] = process.argv.slice(2);
const GUEST4 = [192, 0, 0, 2];

/** WebSockets that a test can cut off: `dead`, nothing passes, though they stay open. */
const Real = globalThis.WebSocket;
const opened: Holed[] = [];
class Holed {
  static readonly OPEN = Real.OPEN;
  readonly ws: WebSocket;
  dead = false;
  constructor(url: string, protocol: string) {
    this.ws = new Real(url, protocol);
    opened.push(this);
  }
  get readyState() { return this.ws.readyState; }
  set binaryType(t: BinaryType) { this.ws.binaryType = t; }
  set onopen(f: () => void) { this.ws.onopen = f; }
  set onclose(f: () => void) { this.ws.onclose = f; }
  set onmessage(f: (e: MessageEvent) => void) { this.ws.onmessage = (e) => { if (!this.dead) f(e); }; }
  send(b: Uint8Array<ArrayBuffer>) { if (!this.dead) this.ws.send(b); }
  close() { this.ws.close(); }
}
(globalThis as { WebSocket: unknown }).WebSocket = Holed;

const echo = createSocket('udp4');
echo.on('message', (m, r) => echo.send(m, r.port, r.address));
await new Promise<void>((resolve) => echo.bind(0, '127.0.0.1', resolve));
const port = echo.address().port;

/** A UDP packet from the guest to 127.0.0.1:`port` (the exit node's machine is this one) carrying `seq`. */
function udp4(seq: number) {
  const p = new Uint8Array(28 + 4);
  p.set([0x45, 0, 0, p.length, 0, 0, 0x40, 0, 64, 17, 0, 0, ...GUEST4, 127, 0, 0, 1]);
  const c = checksum(p.subarray(0, 20));
  p.set([c >> 8, c & 255], 10);
  p.set([0x9c, 0x40, port >> 8, port & 255, 0, 12], 20);
  new DataView(p.buffer).setUint32(28, seq);
  const pseudo = new Uint8Array(12 + 12);
  pseudo.set([...GUEST4, 127, 0, 0, 1, 0, 17, 0, 12]);
  pseudo.set(p.subarray(20), 12);
  const u = checksum(pseudo) || 0xffff;
  p.set([u >> 8, u & 255], 26);
  return p;
}

const m = await TsModule.load(readFileSync('target/net/ts.wasm'));
const running = Promise.withResolvers<void>();
let last = 0;
const client = new TsClient(m, { addr }, {
  packet(p) { if (p[0] >> 4 === 4 && p[9] === 17 && p.length >= 32) last = Math.max(last, new DataView(p.buffer, p.byteOffset).getUint32(28)); },
  event(e) {
    if (e.type === 'log') console.error('[ts]', e.msg);
    if (e.type === 'state' && e.state === 'Running') running.resolve(); // i18n-ignore
    if (e.type === 'state' && e.state === 'Failed') running.reject(failureOf(e));
  },
});
await running.promise;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Sends echoes every 250 ms until one comes back, or `limit` ms: when, or -1. */
async function echoes(limit: number) {
  const t = performance.now();
  for (let seq = 1; performance.now() - t < limit; seq++) {
    const s = (Date.now() & 0xffffff) * 64 + seq;
    client.guest(udp4(s));
    await sleep(250);
    if (last === s || last > s) return performance.now() - t;
  }
  return -1;
}
const before = await echoes(10_000);
if (before < 0) throw new Error('no echo before the path died');
await sleep(1000); // quiet a moment: what comes next starts the clock afresh
for (const s of opened) s.dead = true;
const sockets = opened.length;
const back = await echoes(40_000);
console.log(JSON.stringify({ before, back, opened: opened.length - sockets }));
client.close();
echo.close();
