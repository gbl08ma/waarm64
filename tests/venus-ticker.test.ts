// The ticker as vkr's ring monitor (GD G3; web/venus-ticker.ts `setAlive`): the alive bit set on each of the table's
// status words under the table's lock, never while vkr holds it, and the pause from the report period asked.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setAlive } from '../web/venus-ticker.ts';

test('the ticker sets the monitored rings alive under the table\'s lock', () => {
  const memory = new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true });
  const u = new Uint32Array(memory.buffer), table = 256;
  // Two rings' status words at 1024 and 2048 (IDLE set on the first: kept), and a third past the count (not touched).
  u.set([0, 3_000_000, 2, 1024, 2048, 4096], table >> 2);
  u[1024 >> 2] = 1;
  assert.equal(setAlive(memory, table), 1000);
  assert.deepEqual([u[1024 >> 2], u[2048 >> 2], u[4096 >> 2], u[table >> 2]], [5, 4, 0, 0]);
  // vkr holds the lock: nothing written, tried again later.
  u[1024 >> 2] = u[2048 >> 2] = 0;
  u[table >> 2] = 1;
  assert.equal(setAlive(memory, table), undefined);
  assert.deepEqual([u[1024 >> 2], u[2048 >> 2], u[table >> 2]], [0, 0, 1]);
  // No ring asked yet: Mesa's 3 s, a third of it.
  u.set([0, 0, 0], table >> 2);
  assert.equal(setAlive(memory, table), 1000);
});
