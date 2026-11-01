// The local helper's framing on the page's side (web/local-net.ts): QEMU's stream framing, several whole frames per
// message, as net/webpc-net speaks it; and the helper's link as the page takes it.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { frameMessage, framesOf, parseLocalURL } from '../web/local-net.ts';

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
