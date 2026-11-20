// The balloon's backend (web/balloon.ts, docs/devices.md "balloon") against Linux's virtio_balloon as it drives the
// queues, without a guest: reporting zeroes the reported pages that aren't zero and only reads the others; a hint
// writes its command id, counts the blocks handed over after the driver's start and ends at its STOP; DONE after it,
// and at a restored backend's start when the saved config holds a hint's id.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { balloon, balloonEntry, CMD_DONE, CMD_STOP, F_FREE_PAGE_HINT, F_REPORTING, zeroPages } from '../web/balloon.ts';
import type { Ctx, Request } from '../web/virtio.ts';

const PAGE = 4096;

function fake(features = F_FREE_PAGE_HINT | F_REPORTING, mem = new Uint8Array(64 * PAGE)) {
  const config = new Uint8Array(256);
  let changes = 0;
  const ctx: Ctx = {
    ram: () => [mem],
    layout: [{ pa: 0x4000_0000, size: mem.length, off: 0 }],
    complete: () => undefined,
    config: () => config,
    untaken: () => 0,
    changeConfig: (write) => {
      changes++;
      write(config);
    },
    features: () => features,
  };
  const cmd = () => new DataView(config.buffer).getUint32(8, true);
  return { ctx, mem, config, cmd, changes: () => changes };
}
const out = (mem: Uint8Array, at: number, id: number): Request => {
  new DataView(mem.buffer).setUint32(at, id, true);
  return { w0: 0, queue: 2, read: [{ off: at, len: 4, mem: 0 }], write: [] };
};
const block = (queue: number, off: number, len: number): Request => ({ w0: 0, queue, read: [], write: [{ off, len, mem: 0 }] });

test('the entry: ID 5, FREE_PAGE_HINT and REPORTING, four queues of 128, 12 bytes of config', () => {
  assert.deepEqual(balloonEntry().entry, [5n, (1n << 3n) | (1n << 5n), 4n, 128n, 12n]);
});

test("zeroPages writes only the pages that aren't zero", () => {
  const b = new Uint8Array(4 * PAGE);
  b[PAGE + 17] = 1;
  b[4 * PAGE - 1] = 9;
  assert.equal(zeroPages(b), 2);
  assert.ok(b.every((x) => x === 0));
  assert.equal(zeroPages(b), 0, 'zero pages: nothing written');
});

test('reporting zeroes the reported blocks, on the queue after the hint’s, or third without the hint', () => {
  const f = fake();
  const b = balloon(f.ctx);
  f.mem.fill(7, 4 * PAGE, 12 * PAGE);
  assert.equal(b.request(block(3, 8 * PAGE, 8 * PAGE)), 0);
  assert.ok(f.mem.subarray(8 * PAGE, 16 * PAGE).every((x) => x === 0), 'the reported block zeroed');
  assert.ok(f.mem.subarray(4 * PAGE, 8 * PAGE).every((x) => x === 7), 'nothing else');
  assert.deepEqual(b.reported, { pages: 4, bytes: 8 * PAGE });
  // A driver without the hint: reporting is queue 2.
  const g = fake(F_REPORTING);
  const c = balloon(g.ctx);
  g.mem.fill(7);
  c.request(block(2, 0, PAGE));
  assert.ok(g.mem.subarray(0, PAGE).every((x) => x === 0));
  assert.equal(g.mem[PAGE], 7);
});

test('a hint: the command id, the blocks after the start, done at STOP; DONE after; never a block written', async () => {
  const f = fake();
  const b = balloon(f.ctx);
  f.mem.fill(3, 16 * PAGE, 32 * PAGE);
  const hint = b.hint(5000);
  assert.equal(f.cmd(), 2, 'the first id');
  assert.equal(await b.hint(10), undefined, 'one at a time');
  b.request(block(2, 16 * PAGE, 8 * PAGE)); // a block of an earlier hint, before this one's start: not counted
  b.request(out(f.mem, 0, 2));
  b.request(block(2, 16 * PAGE, 8 * PAGE));
  b.request(block(2, 24 * PAGE, 8 * PAGE));
  b.request(out(f.mem, 0, CMD_STOP));
  assert.deepEqual(await hint, { blocks: 2, bytes: 16 * PAGE, stopped: true });
  assert.ok(f.mem.subarray(16 * PAGE, 32 * PAGE).every((x) => x === 3), 'the hinted blocks are the guest’s: never written');
  b.release();
  assert.equal(f.cmd(), CMD_DONE);
  const changes = f.changes();
  b.release();
  assert.equal(f.changes(), changes, 'DONE once');
  // The next hint has the next id; a guest that never says STOP: the wait ends at its time.
  const t0 = performance.now();
  const late = await b.hint(50);
  assert.equal(f.cmd(), 3);
  assert.deepEqual(late, { blocks: 0, bytes: 0, stopped: false });
  assert.ok(performance.now() - t0 < 1000);
});

test('no hint without the feature; a reset ends a hint and clears the id; a restore says DONE to a held hint', async () => {
  assert.equal(await balloon(fake(F_REPORTING).ctx).hint(10), undefined);
  assert.equal(await balloon(fake(0n).ctx).hint(10), undefined, 'no driver');
  const f = fake();
  const b = balloon(f.ctx);
  const hint = b.hint(5000);
  b.request(out(f.mem, 0, 2));
  b.reset();
  assert.equal((await hint)?.stopped, false, 'ended, without its STOP');
  assert.equal(f.cmd(), CMD_STOP);
  // A snapshot taken while the guest held a hint's blocks: the core restores the config (id 7), the backend says DONE.
  const g = fake();
  new DataView(g.config.buffer).setUint32(8, 7, true);
  const c = balloon(g.ctx);
  c.restore!({ nextId: 8 });
  assert.equal(g.cmd(), CMD_DONE);
  void c.hint(10);
  assert.equal(g.cmd(), 8, 'the ids go on from the saved one');
  // One restored with nothing held: nothing said.
  const h = fake();
  balloon(h.ctx).restore!({ nextId: 3 });
  assert.equal(h.changes(), 0);
});
