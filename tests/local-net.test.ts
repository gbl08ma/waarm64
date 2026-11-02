// The local helper's framing on the page's side (web/local-net.ts): QEMU's stream framing, several whole frames per
// message, as net/webpc-net speaks it; and the helper's link as the page takes it.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dhcpAck, frameMessage, framesOf, parseLocalURL } from '../web/local-net.ts';

const frame = (n: number, fill: number) => new Uint8Array(n).fill(fill);

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
