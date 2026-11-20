// The inflate pool (web/inflate-pool.ts): a pool closed while its first request waits for the core starts no workers
// (they'd never be ended). Its workers are faked here (`worker`).
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
