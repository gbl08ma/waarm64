// The machine worker's devices as `bootVm` takes them (web/app/worker-devices.ts `finishSpecs`): what the start learnt
// after making them goes on them, a 3D machine's caps that came after the start message and each URL disk's HEAD
// (the machine worker's check, which the device worker then doesn't repeat); nothing else changes.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { DeviceSpec } from '../web/devices.ts';
import { finishSpecs, startCaps, type StartMessage } from '../web/app/worker-devices.ts';

test("the start's late caps go to the 3D machine's GPU device, each URL disk's HEAD to its disk, nothing else changes", () => {
  const { port1 } = new MessageChannel();
  const specs: DeviceSpec[] = [
    { type: 'blk', url: 'http://h/a.img' },
    { type: 'blk', url: 'http://h/b.json', chunked: 'x' },
    { type: 'blk', stored: 'disks/1', size: 4096 },
    { type: 'gpu', width: 640, height: 480, renderer: port1, virgl: true },
    { type: 'rng' },
  ];
  const caps = new Uint8Array([1, 2, 3]);
  const head = { size: 1 << 20, validator: '"v"' };
  const out = finishSpecs(specs, { caps, heads: new Map([['http://h/a.img', head]]) });
  assert.deepEqual(out[0], { type: 'blk', url: 'http://h/a.img', head });
  assert.equal(out[1], specs[1], 'a disk without a HEAD as it was');
  assert.equal(out[2], specs[2]);
  assert.equal(out[3].type === 'gpu' && out[3].caps, caps);
  assert.equal(out[4], specs[4]);
  // Caps in the start already: the device keeps them; a 2D GPU (no renderer) gets none.
  const had = new Uint8Array([9]);
  const own = finishSpecs([{ type: 'gpu', width: 1, height: 1, renderer: port1, virgl: true, caps: had }], {});
  assert.equal(own[0].type === 'gpu' && own[0].caps, had);
  const flat = finishSpecs([{ type: 'gpu', width: 1, height: 1 }], { caps });
  assert.equal(flat[0].type === 'gpu' && flat[0].caps, undefined);
  port1.close();
});

test("a 3D start without caps waits for the later ones; with them, or without 3D, it doesn't", async () => {
  const { port1 } = new MessageChannel();
  const later = new Uint8Array([7]);
  const pending = Promise.resolve(later);
  const own = new Uint8Array([1]);
  assert.equal(await startCaps({ ports: { renderer: port1 } as StartMessage['ports'] }, pending), later, 'the later caps');
  assert.equal(await startCaps({ ports: { renderer: port1 } as StartMessage['ports'], caps: own }, pending), own, "the start's own");
  assert.equal(await startCaps({ ports: {} as StartMessage['ports'] }, pending), undefined, 'no 3D: none');
  port1.close();
});
