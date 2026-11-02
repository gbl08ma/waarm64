// The local helper's framing on the page's side (web/local-net.ts): QEMU's stream framing, several whole frames per
// message, as net/webpc-net speaks it; and the helper's link as the page takes it.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { dhcpAck, frameMessage, framesOf, LOCAL_MAX_MESSAGE, LOCAL_SUBPROTOCOL, parseLocalURL, startLocalNet } from '../web/local-net.ts';
import { MAX_PORT_FRAME } from '../web/offload.ts';

const frame = (n: number, fill: number) => new Uint8Array(n).fill(fill);

/** Hands `n` frames of `size` bytes to a client in one turn (as a burst from the guest comes), and gives the messages it sent. */
async function burst(n: number, size: number) {
  const sent: Uint8Array[] = [];
  const realSocket = globalThis.WebSocket;
  globalThis.WebSocket = class {
    static OPEN = 1;
    readyState = 1;
    protocol = LOCAL_SUBPROTOCOL;
    send(m: Uint8Array) { sent.push(m); }
    close() {}
  } as unknown as typeof WebSocket;
  const port = { postMessage() {} } as unknown as MessagePort;
  try {
    startLocalNet('ws://127.0.0.1:1/t', port);
    for (let k = 0; k < n; k++) port.onmessage!({ data: frame(size, k & 255).buffer } as MessageEvent);
    await new Promise((r) => setTimeout(r, 5));
  } finally {
    globalThis.WebSocket = realSocket;
  }
  return sent;
}

// 1 MiB of a page's batch closed the helper's socket mid-upload (bench/net/REPORT.md "The stalled uploads").
test("a burst of the guest's frames stays under the helper's limit on a message, whole and in order", async () => {
  for (const [n, size] of [[40, MAX_PORT_FRAME], [1000, 1514], [20000, 60]]) {
    const sent = await burst(n, size);
    assert.ok(sent.length > 1, `${n} of ${size}: more than one message`);
    assert.ok(sent.every((m) => m.length <= LOCAL_MAX_MESSAGE), `${n} of ${size}: past the limit, ${Math.max(...sent.map((m) => m.length))}`);
    const got = sent.flatMap((m) => framesOf(m)!);
    assert.equal(got.length, n);
    assert.ok(got.every((f, k) => f.length === size && f[0] === (k & 255)), `${n} of ${size}: out of order`);
  }
});

test('the limit on a message is the helper\'s, and holds the largest frame', () => {
  const go = readFileSync(new URL('../net/webpc-net/link.go', import.meta.url), 'utf8');
  const m = /MaxMessage\s*=\s*1 << (\d+)/.exec(go);
  assert.equal(1 << Number(m?.[1]), LOCAL_MAX_MESSAGE);
  assert.ok(4 + MAX_PORT_FRAME <= LOCAL_MAX_MESSAGE);
});

test('frames go in one message, each after its big-endian length, and come back out whole', () => {
  const a = frame(60, 1);
  const b = frame(1514, 2);
  const m = frameMessage([a, b]);
  assert.equal(m.length, 4 + 60 + 4 + 1514);
  assert.deepEqual([...m.subarray(0, 4)], [0, 0, 0, 60]);
  assert.deepEqual([...m.subarray(64, 68)], [0, 0, 0x05, 0xea]);
  const got = framesOf(m)!;
  assert.equal(got.length, 2);
  assert.equal(Buffer.compare(got[0], a), 0);
  assert.equal(Buffer.compare(got[1], b), 0);
  assert.notEqual(got[0].buffer, m.buffer, 'copies, so each can be transferred');
});

test("a message that isn't whole frames is refused", () => {
  const m = frameMessage([frame(60, 1)]);
  assert.equal(framesOf(m.subarray(0, 63)), undefined, 'cut short');
  assert.equal(framesOf(m.subarray(0, 3)), undefined, 'a length cut short');
  assert.equal(framesOf(frameMessage([frame(10, 0)])), undefined, 'shorter than an Ethernet header');
  assert.deepEqual(framesOf(new Uint8Array(0)), [], 'empty: no frames');
});

test("the helper's link: ws:// on loopback with a token", () => {
  assert.deepEqual(parseLocalURL(' ws://127.0.0.1:8740/abc '), { url: 'ws://127.0.0.1:8740/abc' });
  assert.deepEqual(parseLocalURL('ws://localhost:8740/abc'), { url: 'ws://localhost:8740/abc' });
  for (const bad of ['ws://127.0.0.1:8740/', 'wss://127.0.0.1:8740/abc', 'ws://192.168.1.2:8740/abc', 'http://127.0.0.1:8740/abc', 'nonsense']) {
    assert.ok('error' in parseLocalURL(bad), bad);
  }
});

test('the pairing link the helper prints gives its ws:// link', () => {
  assert.deepEqual(parseLocalURL('https://vm.tny.im/#net=ws://127.0.0.1:8740/abc'), { url: 'ws://127.0.0.1:8740/abc' });
  assert.deepEqual(parseLocalURL(' http://localhost:8080/#net=ws%3A%2F%2F127.0.0.1%3A9%2Fx '), { url: 'ws://127.0.0.1:9/x' });
  assert.ok('error' in parseLocalURL('https://vm.tny.im/#net='));
  assert.ok('error' in parseLocalURL('https://vm.tny.im/#net=ws://example.com:8740/abc'), 'loopback only');
});

test("the guest's lease from the helper's DHCP acknowledgment (the menu's address)", () => {
  const f = new Uint8Array(14 + 20 + 8 + 240 + 12);
  f.set([0xff, 0xff, 0xff, 0xff, 0xff, 0xff], 0);
  f.set([8, 0], 12);
  f.set([0x45, 0, 0, 0, 0, 0, 0, 0, 64, 17], 14);
  f.set([0, 67, 0, 68], 34);
  const d = 42;
  f[d] = 2;
  f.set([192, 168, 127, 2], d + 16);
  f.set([0x63, 0x82, 0x53, 0x63], d + 236);
  f.set([53, 1, 5, 26, 2, 0x05, 0xdc, 255], d + 240);
  assert.deepEqual(dhcpAck(f), { address: '192.168.127.2', mtu: 1500 });
  f[d + 242] = 2; // an offer
  assert.equal(dhcpAck(f), undefined);
  f[d + 242] = 5;
  f[35] = 69; // not from the server's port
  assert.equal(dhcpAck(f), undefined);
});
