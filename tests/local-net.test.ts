// The local helper's framing on the page's side (web/local-net.ts): QEMU's stream framing, several whole frames per
// message, as waarm64-net speaks it (at the commit tests/waarm64-net.ts pins); and the helper's link as the page takes it.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { dhcpAck, frameMessage, framesOf, LOCAL_MAX_MESSAGE, LOCAL_SUBPROTOCOL, parseLocalURL, startLocalNet } from '../web/local-net.ts';
import { portAdapter } from '../web/net.ts';
import { MAX_PORT_FRAME } from '../web/offload.ts';
import { MsgError } from '../web/msg.ts';
import { helperSource } from './waarm64-net.ts';

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

test('the limit on a message is the helper\'s, and holds the largest frame', (t) => {
  const src = helperSource();
  if ('skip' in src) return t.skip(src.skip);
  const go = readFileSync(`${src.dir}/link.go`, 'utf8');
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
  assert.deepEqual(parseLocalURL('https://waarm64.com/#net=ws://127.0.0.1:8740/abc'), { url: 'ws://127.0.0.1:8740/abc' });
  assert.deepEqual(parseLocalURL(' http://localhost:8080/#net=ws%3A%2F%2F127.0.0.1%3A9%2Fx '), { url: 'ws://127.0.0.1:9/x' });
  assert.ok('error' in parseLocalURL('https://waarm64.com/#net='));
  assert.ok('error' in parseLocalURL('https://waarm64.com/#net=ws://example.com:8740/abc'), 'loopback only');
  assert.ok('error' in parseLocalURL('https://waarm64.com/#net=ws://127.0.0.1:8740/%E0%A4%A'), 'a malformed escape: a message, not a throw');
});

const GUEST = [0x52, 0x54, 0, 0x12, 0x34, 0x56];
const OTHER = [0x52, 0x54, 0, 0x65, 0x43, 0x21];

/** The helper's DHCP acknowledgment of 192.168.127.<last> for the client `mac`, broadcast (as a client without an address gets it). */
function ackFrame(mac: number[], last = 2) {
  const f = new Uint8Array(14 + 20 + 8 + 240 + 12);
  f.set([0xff, 0xff, 0xff, 0xff, 0xff, 0xff], 0);
  f.set([8, 0], 12);
  f.set([0x45, 0, 0, 0, 0, 0, 0, 0, 64, 17], 14);
  f.set([0, 67, 0, 68], 34);
  const d = 42;
  f[d] = 2;
  f[d + 1] = 1;
  f[d + 2] = 6;
  f.set([192, 168, 127, last], d + 16);
  f.set(mac, d + 28);
  f.set([0x63, 0x82, 0x53, 0x63], d + 236);
  f.set([53, 1, 5, 26, 2, 0x05, 0xdc, 255], d + 240);
  return f;
}

test("the guest's lease from the helper's DHCP acknowledgment (the menu's address)", () => {
  const f = ackFrame(GUEST);
  const d = 42;
  assert.deepEqual(dhcpAck(f, new Uint8Array(GUEST)), { address: '192.168.127.2', mtu: 1500 });
  assert.equal(dhcpAck(f, new Uint8Array(OTHER)), undefined, "another guest's (the switch floods a broadcast acknowledgment to every page)");
  f[d + 242] = 2; // an offer
  assert.equal(dhcpAck(f, new Uint8Array(GUEST)), undefined);
  f[d + 242] = 5;
  f[35] = 69; // not from the server's port
  assert.equal(dhcpAck(f, new Uint8Array(GUEST)), undefined);
});

test("the client's lease is its own guest's, not another's on the same helper", async () => {
  const realSocket = globalThis.WebSocket;
  let socket: { onmessage?: (e: MessageEvent) => void; onopen?: () => void } | undefined;
  globalThis.WebSocket = class {
    static OPEN = 1;
    readyState = 1;
    protocol = LOCAL_SUBPROTOCOL;
    constructor() { socket = this as never; }
    send() {}
    close() {}
  } as unknown as typeof WebSocket;
  const port = { postMessage() {}, close() {} } as unknown as MessagePort;
  try {
    const net = startLocalNet('ws://127.0.0.1:1/t', port);
    socket!.onopen!();
    // The guest's DHCP discovery (its MAC as the source), then the acknowledgments: another guest's first.
    const discovery = new Uint8Array(60).fill(0xff);
    discovery.set(GUEST, 6);
    port.onmessage!({ data: discovery.buffer } as MessageEvent);
    socket!.onmessage!({ data: frameMessage([ackFrame(OTHER, 3)]).buffer } as MessageEvent);
    assert.equal(net.lease(), undefined, "another guest's acknowledgment");
    socket!.onmessage!({ data: frameMessage([ackFrame(GUEST, 2)]).buffer } as MessageEvent);
    assert.deepEqual(net.lease(), { address: '192.168.127.2', mtu: 1500 });
    socket!.onmessage!({ data: frameMessage([ackFrame(OTHER, 3)]).buffer } as MessageEvent);
    assert.deepEqual(net.lease(), { address: '192.168.127.2', mtu: 1500 }, 'kept');
    net.close();
  } finally {
    globalThis.WebSocket = realSocket;
  }
});

test("a message's frames reach the card as one post, in order and transferred; a frame alone as a bare ArrayBuffer", async () => {
  const realSocket = globalThis.WebSocket;
  let socket: { onmessage?: (e: MessageEvent) => void; onopen?: () => void } | undefined;
  globalThis.WebSocket = class {
    static OPEN = 1;
    readyState = 1;
    protocol = LOCAL_SUBPROTOCOL;
    constructor() { socket = this as never; }
    send() {}
    close() {}
  } as unknown as typeof WebSocket;
  const posts: { data: unknown; transfer: Transferable[] }[] = [];
  const port = { postMessage(data: unknown, transfer: Transferable[]) { posts.push({ data, transfer }); }, close() {} } as unknown as MessagePort;
  try {
    const net = startLocalNet('ws://127.0.0.1:1/t', port);
    socket!.onopen!();
    socket!.onmessage!({ data: frameMessage([frame(60, 1), frame(1514, 2), frame(14, 3)]).buffer } as MessageEvent);
    assert.equal(posts.length, 1, 'one post for the message');
    const batch = posts[0].data as ArrayBuffer[];
    assert.ok(Array.isArray(batch), 'a batch');
    assert.deepEqual(batch.map((b) => [b.byteLength, new Uint8Array(b)[0]]), [[60, 1], [1514, 2], [14, 3]]);
    assert.equal(posts[0].transfer.length, 3);
    assert.ok(batch.every((b, k) => posts[0].transfer[k] === b), "each frame's buffer is transferred");
    socket!.onmessage!({ data: frameMessage([frame(60, 4)]).buffer } as MessageEvent);
    assert.equal(posts.length, 2);
    assert.ok(posts[1].data instanceof ArrayBuffer && posts[1].transfer[0] === posts[1].data, 'one frame: a bare ArrayBuffer');
    socket!.onmessage!({ data: new ArrayBuffer(0) } as MessageEvent);
    assert.equal(posts.length, 2, 'a message with no frame posts nothing');
    assert.deepEqual([net.stats().rxFrames, net.stats().rxMessages, net.stats().rxBytes], [4, 3, 60 + 1514 + 14 + 60]);
    net.close();
  } finally {
    globalThis.WebSocket = realSocket;
  }
});

test('a batch crosses a real port to the card\'s adapter as its frames, in order', async () => {
  const realSocket = globalThis.WebSocket;
  let socket: { onmessage?: (e: MessageEvent) => void; onopen?: () => void } | undefined;
  globalThis.WebSocket = class {
    static OPEN = 1;
    readyState = 1;
    protocol = LOCAL_SUBPROTOCOL;
    constructor() { socket = this as never; }
    send() {}
    close() {}
  } as unknown as typeof WebSocket;
  const mc = new MessageChannel();
  const got: number[] = [];
  let done!: () => void;
  const all = new Promise<void>((r) => (done = r));
  const card = portAdapter(mc.port2, (f) => { got.push(f[0]); if (got.length === 4) done(); });
  try {
    const net = startLocalNet('ws://127.0.0.1:1/t', mc.port1);
    socket!.onopen!();
    socket!.onmessage!({ data: frameMessage([frame(60, 1), frame(1514, 2), frame(14, 3)]).buffer } as MessageEvent);
    socket!.onmessage!({ data: frameMessage([frame(60, 4)]).buffer } as MessageEvent);
    await all;
    assert.deepEqual(got, [1, 2, 3, 4]);
    net.close();
  } finally {
    globalThis.WebSocket = realSocket;
    card.close!();
    mc.port1.close();
  }
});

test('a closed client closes its frame port: a late message from the socket reaches no one', async () => {
  const realSocket = globalThis.WebSocket;
  let socket: { onmessage?: (e: MessageEvent) => void; onopen?: () => void } | undefined;
  globalThis.WebSocket = class {
    static OPEN = 1;
    readyState = 1;
    protocol = LOCAL_SUBPROTOCOL;
    constructor() { socket = this as never; }
    send() {}
    close() {}
  } as unknown as typeof WebSocket;
  const mc = new MessageChannel();
  let got = 0;
  mc.port2.onmessage = () => got++;
  try {
    const net = startLocalNet('ws://127.0.0.1:1/t', mc.port1);
    socket!.onopen!();
    net.close();
    socket!.onmessage!({ data: frameMessage([ackFrame(GUEST, 2)]).buffer } as MessageEvent);
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(got, 0);
  } finally {
    globalThis.WebSocket = realSocket;
    mc.port1.close();
    mc.port2.close();
  }
});

test("a link Chromium's WebSocket refuses (a blocked port) closes the client with a sentence, not a throw", () => {
  const realSocket = globalThis.WebSocket;
  globalThis.WebSocket = class {
    constructor() { throw new DOMException("The port 6000 is not allowed.", 'SyntaxError'); }
  } as unknown as typeof WebSocket;
  try {
    let changed = 0;
    const net = startLocalNet('ws://127.0.0.1:6000/t', { postMessage() {} } as unknown as MessagePort, () => changed++);
    assert.equal(net.state(), 'closed');
    assert.ok(net.error() instanceof MsgError, String(net.error()));
    net.close();
  } finally {
    globalThis.WebSocket = realSocket;
  }
});
