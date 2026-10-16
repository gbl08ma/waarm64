// The tailnet client's module and its I/O (web/ts-client.ts, net/ts) in Node,
// with no network: a stub WebSocket stands in for the relay. The protocols
// are covered natively (`cargo test -p webpc_ts`, a fake tailcat server
// included); a real tailcat server is bench/net/tailcat.ts's and
// tests/net/tailcat.sh's (docs/plans/tailnet-client.md).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { TsClient, TsModule, type TsEvent } from '../web/ts-client.ts';

const WASM = 'target/net/ts.wasm';
const skip = existsSync(WASM) ? false : `${WASM} isn't built (net/ts/build.sh)`;

// The test address of net/ts/src/tailcat.rs: a server key, its PSK, relay derp.test.
const ADDR = 'tcpGFwWCD6tj4GWmabWiCU0q3bAIGiFEcL6Go87N0Qni4RXuJhJmFrWCBC_L02Yu8_NEGn0VTiLqGBwlkQrHPf6CSafFRGuItfa2FxWCDiOfsMhfnPU0l4J6uNzlWpHAiXT7YYZFkqTzlrMprJ5mFygaFhToGhYWhpZGVycC50ZXN0';

/** WebSockets the client opened, as stubs that record what it sent. */
class StubSocket {
  static opened: StubSocket[] = [];
  static readonly OPEN = 1;
  readyState = 0;
  binaryType = '';
  sent: Uint8Array[] = [];
  closed = false;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: ArrayBuffer }) => void) | null = null;
  onclose: (() => void) | null = null;
  readonly url: string;
  readonly protocol: string;
  constructor(url: string, protocol: string) {
    this.url = url;
    this.protocol = protocol;
    StubSocket.opened.push(this);
  }
  send(b: Uint8Array) { this.sent.push(b.slice()); }
  close() { this.closed = true; }
  open() { this.readyState = 1; this.onopen?.(); }
  receive(b: Uint8Array) { this.onmessage?.({ data: b.slice().buffer }); }
  drop() { this.readyState = 3; this.onclose?.(); }
}

async function withStub<T>(f: () => Promise<T>) {
  const real = globalThis.WebSocket;
  StubSocket.opened = [];
  (globalThis as { WebSocket: unknown }).WebSocket = StubSocket;
  try { return await f(); } finally { (globalThis as { WebSocket: unknown }).WebSocket = real; }
}

const hex = (b: number[]) => b.map((x) => x.toString(16).padStart(2, '0')).join('');

test('the module takes an address, says who the node is, and opens the relay with the derp subprotocol', { skip }, () => withStub(async () => {
  const m = await TsModule.load(readFileSync(WASM));
  assert.throws(() => new TsClient(m, { addr: 'hello' }, { packet() {}, event() {} }), /starts with "tc"/);
  const events: TsEvent[] = [];
  const key = '11'.repeat(32);
  const c = new TsClient(m, { addr: ADDR, key }, { packet() {}, event: (e) => events.push(e) });
  assert.equal(c.privateKey(), key);
  const self = events.find((e) => e.type === 'self');
  assert.ok(self && self.type === 'self');
  // The tunnel address is Tailscale's ULA prefix and the public key's first 80 bits.
  assert.deepEqual(self.address6.slice(0, 6), [0xfd, 0x7a, 0x11, 0x5c, 0xa1, 0xe0]);
  assert.equal(hex(self.address6.slice(6)), self.key.slice('nodekey:'.length, 'nodekey:'.length + 20));
  assert.deepEqual(events.filter((e) => e.type === 'state'), [{ type: 'state', state: 'Connecting' }]);
  assert.deepEqual(StubSocket.opened.map((s) => [s.url, s.protocol, s.binaryType]), [['wss://derp.test/derp', 'derp', 'arraybuffer']]);
  // The server speaks first: nothing goes out on open.
  StubSocket.opened[0].open();
  assert.equal(StubSocket.opened[0].sent.length, 0);
  c.close();
  assert.ok(StubSocket.opened[0].closed);
}));

test('a fresh key per client, and the same key is the same node', { skip }, () => withStub(async () => {
  const m = await TsModule.load(readFileSync(WASM));
  const selfOf = (key?: string) => {
    let self = '';
    const c = new TsClient(m, { addr: ADDR, key }, { packet() {}, event: (e) => { if (e.type === 'self') self = e.key; } });
    const k = c.privateKey();
    c.close();
    return [self, k];
  };
  const [a, ka] = selfOf();
  const [b] = selfOf();
  assert.notEqual(a, b);
  assert.equal(selfOf(ka)[0], a);
}));

test('a relay that isn\'t one is dropped and another connection tried after a backoff', { skip }, () => withStub(async () => {
  const m = await TsModule.load(readFileSync(WASM));
  const logs: string[] = [];
  const c = new TsClient(m, { addr: ADDR }, { packet() {}, event: (e) => { if (e.type === 'log') logs.push(e.msg); } });
  const first = StubSocket.opened[0];
  first.open();
  first.receive(new TextEncoder().encode('HTTP/1.1 400 Bad Request\r\n\r\n'));
  assert.ok(first.closed);
  assert.match(logs.join('\n'), /not a DERP server/);
  const t = performance.now();
  while (StubSocket.opened.length < 2 && performance.now() - t < 5000) await new Promise((r) => setTimeout(r, 50));
  assert.equal(StubSocket.opened.length, 2, 'a second connection');
  assert.ok(performance.now() - t >= 500, 'after a backoff');
  // A closed connection counts the same.
  StubSocket.opened[1].drop();
  c.close();
}));
