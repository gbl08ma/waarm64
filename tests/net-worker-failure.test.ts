// The network clients' handles hear their worker fail after `Running` too (docs/host-code.md §2.2): an uncaught error
// in the worker (a wasm trap in a timer) reaches `onEvent` as a posted `error` would, so the Network menu says so.
// The Worker global is a fake the test drives.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { FromTailscale } from '../web/tailscale.ts';

class FakeWorker {
  static last?: FakeWorker;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onerror: ((e: { message: string }) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  constructor() {
    FakeWorker.last = this;
  }
  postMessage() {}
  terminate() {}
}
(globalThis as Record<string, unknown>).Worker = FakeWorker;

const { startTailscale } = await import('../web/tailscale.ts');
const { startTailcat } = await import('../web/tailcat.ts');
const { startLocal } = await import('../web/local-net.ts');
const { startRoom } = await import('../web/room.ts');

const netmap = { name: '', addresses: ['100.64.0.1/32'], peers: [], mtu: 1280, dns: null, domains: null, exitNode: '' };

/** Starts a client, brings it to Running, then makes its worker throw: the error must reach `errors`. */
async function check(start: (onEvent: (m: FromTailscale) => void) => { running: Promise<unknown> }) {
  const errors: unknown[] = [];
  const h = start((m) => m.type === 'error' && errors.push(m.error));
  const w = FakeWorker.last!;
  w.onmessage!({ data: { type: 'netmap', netmap } });
  w.onmessage!({ data: { type: 'state', state: 'Running' } }); // i18n-ignore: the client's state, not words
  await h.running;
  w.onerror!({ message: 'RuntimeError: unreachable' });
  assert.equal(errors.length, 1, 'the failure after Running is heard');
}

test('a tailnet client whose worker fails after Running says so', async () => {
  await check((onEvent) => startTailscale({ controlURL: 'https://example.invalid' } as never, onEvent));
});

test('a tailcat client whose worker fails after Running says so', async () => {
  await check((onEvent) => startTailcat({ addr: 'x' } as never, onEvent));
});

test('a local helper client whose worker fails after Running says so', async () => {
  const mc = new MessageChannel();
  await check((onEvent) => startLocal({ url: 'ws://127.0.0.1:1', ip: mc.port1 }, onEvent));
  mc.port1.close();
  mc.port2.close();
});

test('a room whose worker fails after Running says so', async () => {
  const errors: unknown[] = [];
  const r = startRoom({ room: { link: 'x' } } as never, () => {}, (e) => errors.push(e));
  const w = FakeWorker.last!;
  w.onmessage!({ data: { type: 'event', event: { type: 'state', state: 'Running' } } }); // i18n-ignore: the client's state, not words
  await r.running;
  w.onerror!({ message: 'RuntimeError: unreachable' });
  assert.equal(errors.length, 1);
  r.close();
});
