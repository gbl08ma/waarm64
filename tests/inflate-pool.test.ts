// The inflate pool (web/inflate-pool.ts): a pool closed while its first request waits for the core starts no workers
// (they'd never be ended), and one pool serves several disks' requests at once. Its workers are faked here (`worker`).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inflatePool } from '../web/inflate-pool.ts';

test('a pool closed before its workers started starts none', async () => {
  const made: { terminated: boolean }[] = [];
  const worker = () => {
    const w = { terminated: false, onmessage: null, onerror: null, postMessage() {}, terminate: () => void (w.terminated = true) };
    made.push(w);
    return w as unknown as Worker;
  };
  const pool = inflatePool(2, { worker });
  const read = pool([new Uint8Array(8), new Uint8Array(8)], 4096); // the first multi-cluster read: the core loads
  pool.close(); // the disk closed meanwhile
  await read.catch(() => undefined);
  assert.ok(made.every((w) => w.terminated), `${made.filter((w) => !w.terminated).length} of ${made.length} workers left running`);
});

test("one pool serves several disks' requests at once: each answer reaches the request it is for, answered in any order", async () => {
  // A worker that answers each request with its own id in every byte, the later ones first.
  const held: { onmessage: ((e: { data: unknown }) => void) | null; req: { id: number; size: number; lengths: Uint32Array } }[] = [];
  const worker = () => {
    const w = {
      onmessage: null as ((e: { data: unknown }) => void) | null,
      onerror: null,
      postMessage(m: { type?: string; id: number; size: number; lengths: Uint32Array }) {
        if (!m.type) held.push({ onmessage: w.onmessage, req: m });
      },
      terminate() {},
    };
    return w as unknown as Worker;
  };
  const pool = inflatePool(1, { worker });
  const size = 16;
  // Two clusters each: the first inflated here (not deflate data: it reads as failed), the second on the worker.
  const reads = [pool([new Uint8Array(4), new Uint8Array(4)], size), pool([new Uint8Array(4), new Uint8Array(4)], size)];
  for (let i = 0; held.length < 2 && i < 400; i++) await new Promise((r) => setTimeout(r, 5));
  for (const { onmessage, req } of held.reverse())
    onmessage!({ data: { id: req.id, ok: Uint8Array.of(1), out: new Uint8Array(size).fill(req.id + 1) } });
  const got = await Promise.all(reads);
  got.forEach((r, k) => {
    assert.equal(r.length, 2);
    assert.equal(r[0], undefined);
    assert.ok(r[1]?.every((x) => x === k + 1), `request ${k} got another's answer`);
  });
  pool.close();
});
