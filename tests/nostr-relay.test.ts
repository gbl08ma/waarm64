// The tests' Nostr relay (tests/net/nostr-relay.ts), with Node's own WebSocket client: it forwards events to the
// subscriptions whose kind and `#x` tags match, stores nothing, refuses a wrong id, and forgets a closed subscription.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { startNostrRelay } from './net/nostr-relay.ts';

function event(kind: number, x: string, content: string) {
  const e = { pubkey: 'ab'.repeat(32), created_at: 1_764_000_000, kind, tags: [['x', x]], content, sig: '00'.repeat(64) };
  const id = createHash('sha256').update(JSON.stringify([0, e.pubkey, e.created_at, e.kind, e.tags, e.content])).digest('hex');
  return { id, ...e };
}

async function client(url: string) {
  const ws = new WebSocket(url);
  const got: unknown[][] = [];
  const waiters: (() => void)[] = [];
  ws.onmessage = (m) => { got.push(JSON.parse(m.data as string)); waiters.splice(0).forEach((w) => w()); };
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  const next = async (pred: (m: unknown[]) => boolean, ms = 2000) => {
    const t = Date.now();
    for (;;) {
      const i = got.findIndex(pred);
      if (i >= 0) return got.splice(i, 1)[0];
      if (Date.now() - t > ms) return undefined;
      await new Promise<void>((r) => { waiters.push(r); setTimeout(r, 50); });
    }
  };
  return { ws, got, next, send: (m: unknown) => ws.send(JSON.stringify(m)) };
}

test('the relay forwards by kind and tag, and stores nothing', { timeout: 20_000 }, async () => {
  const relay = await startNostrRelay();
  try {
    const a = await client(relay.url);
    const b = await client(relay.url);
    a.send(['REQ', 's1', { kinds: [26354], '#x': ['t1', 't2'], limit: 0 }]);
    assert.deepEqual(await a.next((m) => m[0] === 'EOSE'), ['EOSE', 's1']);
    const e = event(26354, 't2', 'hello');
    b.send(['EVENT', e]);
    assert.deepEqual(await b.next((m) => m[0] === 'OK'), ['OK', e.id, true, '']);
    assert.deepEqual(await a.next((m) => m[0] === 'EVENT'), ['EVENT', 's1', e]);
    b.send(['EVENT', event(1, 't2', 'another kind')]);
    b.send(['EVENT', event(26354, 't3', 'another tag')]);
    b.send(['EVENT', { ...event(26354, 't1', 'x'), id: '00'.repeat(32) }]);
    assert.equal((await b.next((m) => m[0] === 'OK' && m[2] === false))?.[3], 'invalid: the id');
    assert.equal(await a.next((m) => m[0] === 'EVENT', 300), undefined, 'none of those');
    // A late subscriber gets nothing old.
    const c = await client(relay.url);
    c.send(['REQ', 's', { kinds: [26354], '#x': ['t2'] }]);
    assert.equal(await c.next((m) => m[0] === 'EVENT', 300), undefined);
    a.send(['CLOSE', 's1']);
    await new Promise((r) => setTimeout(r, 100));
    b.send(['EVENT', event(26354, 't1', 'after the close')]);
    assert.equal(await a.next((m) => m[0] === 'EVENT', 300), undefined);
    assert.equal(relay.events.length, 4);
    for (const x of [a, b, c]) x.ws.close();
  } finally {
    await relay.close();
  }
});

test('a frame declaring more than a megabyte closes the connection, not waited on', { timeout: 20_000 }, async () => {
  const relay = await startNostrRelay();
  try {
    const { connect } = await import('node:net');
    const { port } = new URL(relay.url);
    const s = connect(Number(port), '127.0.0.1');
    await new Promise((r) => s.once('connect', r));
    const key = Buffer.alloc(16).toString('base64');
    s.write(`GET / HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
    const closed = new Promise<void>((r) => s.once('close', () => r()));
    s.on('data', () => {});
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(relay.clients(), 1);
    // A masked text frame of 2^40 bytes, declared; its first bytes only.
    const head = Buffer.alloc(14);
    head[0] = 0x81;
    head[1] = 0x80 | 127;
    head.writeBigUInt64BE(1n << 40n, 2);
    s.write(Buffer.concat([head, Buffer.alloc(64)]));
    await Promise.race([closed, new Promise((_, no) => setTimeout(() => no(new Error('still open')), 2000))]);
    assert.equal(relay.clients(), 0);
  } finally {
    await relay.close();
  }
});
