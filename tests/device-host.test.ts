// The device worker's owner (web/device-host.ts `deviceHost`): what a failed start leaves, requests paired with their answers by
// id, and a backend's error after the start reaching what waits on the backends. The device worker is faked here
// (`WarmWorkers.take` hands it out; `WorkerGlobalScope` and `self` make this thread a worker).
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { deviceHost } from '../web/device-host.ts';
import type { WarmWorkers } from '../web/warm-workers.ts';
import { Devices, type DevicesInit } from '../web/devices.ts';
import type { FromDeviceWorker, ToDeviceWorker } from '../web/device-worker.ts';
import { openOverlay } from '../web/overlay.ts';
import { toWire } from '../web/msg.ts';

class FakeDeviceWorker {
  sent: ToDeviceWorker[] = [];
  terminated = false;
  onmessage: ((e: { data: FromDeviceWorker }) => void) | null = null;
  onerror: ((e: { message: string }) => void) | null = null;
  postMessage(m: ToDeviceWorker) {
    this.sent.push(m);
  }
  terminate() {
    this.terminated = true;
  }
  /** Delivers `m` as the device worker's message, on a task of its own as a real worker's. */
  answer(m: FromDeviceWorker) {
    return new Promise<void>((r) =>
      setTimeout(() => {
        this.onmessage!({ data: m });
        r();
      }),
    );
  }
  last<T extends ToDeviceWorker['type']>(type: T) {
    return this.sent.findLast((m) => m.type === type) as Extract<ToDeviceWorker, { type: T }>;
  }
  all<T extends ToDeviceWorker['type']>(type: T) {
    return this.sent.filter((m) => m.type === type) as Extract<ToDeviceWorker, { type: T }>[];
  }
}

const BELL = 64;

/** A host over a fake device worker in a fake worker scope; `ready` posts `ready` (or the start's error). */
async function host(start: FromDeviceWorker = { type: 'ready' }, fake = new FakeDeviceWorker()) {
  const g = globalThis as Record<string, unknown>;
  const scope = class {};
  g.WorkerGlobalScope = scope;
  g.self = new scope();
  const warm: WarmWorkers = { take: () => fake as unknown as Worker, end: () => {} };
  const memory = new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true });
  const init: DevicesInit = { memory, shared: [0], ram: 4096, ramSize: 0, signal: 0, specs: [{ type: 'rng' }], deterministic: false };
  try {
    const h = deviceHost(init, BELL, false, undefined, warm);
    await fake.answer(start);
    return { h: await h, fake, bell: new Int32Array(memory.buffer, BELL, 2) };
  } finally {
    delete g.WorkerGlobalScope;
    delete g.self;
  }
}

test("a device worker that fails to start is ended, the start failing with its error", async () => {
  const fake = new FakeDeviceWorker();
  await assert.rejects(host({ type: 'error', message: 'Error: no image', error: toWire(new Error('no image')) }, fake), /no image/);
  assert.ok(fake.terminated, 'ended: its overlays\' locks and the guest memory go with it');
});

test('overlapping saves and flushes each get their own answer (by id), in any order', async () => {
  const { h, fake } = await host();
  const s1 = h.save();
  const s2 = h.save();
  const [a, b] = fake.all('save');
  assert.notEqual(a.id, b.id);
  await fake.answer({ type: 'saved', id: b.id, state: ['second'] });
  await fake.answer({ type: 'saved', id: a.id, state: ['first'] });
  assert.deepEqual(await s1, ['first']);
  assert.deepEqual(await s2, ['second']);
  const f1 = h.flush();
  const f2 = h.flush();
  for (const f of fake.all('flush')) await fake.answer({ type: 'flushed', id: f.id });
  const settled = await Promise.race([Promise.all([f1, f2]).then(() => 'both'), new Promise((r) => setTimeout(r, 500, 'stranded'))]);
  assert.equal(settled, 'both');
  // A close answers what's still waiting: a drain or a refusal as nothing, a save as an error.
  const r = h.refusal();
  const s = assert.rejects(h.save(), /closed/);
  const closed = h.close();
  await fake.answer({ type: 'closed' });
  assert.equal(await r, undefined);
  await s;
  await closed;
});

test("a backend's error after the start reaches a quiesce, the save waiting and every later request", async () => {
  const { h, fake, bell } = await host();
  const saving = assert.rejects(h.save(), /virtio-rng: boom/);
  // `Devices.serve` threw: the doorbell says -1 at once, the worker's message with the error comes after.
  Atomics.add(bell, 0, 1);
  setTimeout(() => {
    Atomics.store(bell, 1, -1);
    Atomics.notify(bell, 1);
    setTimeout(() => void fake.answer({ type: 'error', message: 'Error: virtio-rng: boom', error: toWire(new Error('virtio-rng: boom')) }), 20);
  }, 10);
  await assert.rejects(h.quiesce(), /virtio-rng: boom/);
  await saving;
  await assert.rejects(h.flush(), /virtio-rng: boom/);
  assert.match(String(await h.failure(new Error('device backends failed (see their error)'))), /virtio-rng: boom/);
  assert.equal(await h.failure('other'), (await h.failure('other')), 'the same error');
});

test('Devices.open releases the overlays it opened when a disk fails to open or a restore throws', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'device-host-'));
  try {
    const image = join(dir, 'disk.img');
    writeFileSync(image, new Uint8Array(1 << 16));
    const memory = new WebAssembly.Memory({ initial: 4, maximum: 4, shared: true });
    const base = { memory, shared: [0, 1024], ram: 8192, ramSize: 0, signal: 4096, deterministic: true };
    const overlay = 'device-host-test';
    // The second disk's image isn't there: the first's overlay was open already.
    await assert.rejects(
      Devices.open(
        {
          ...base,
          specs: [
            { type: 'blk', url: pathToFileURL(image).href, overlay },
            { type: 'blk', url: pathToFileURL(join(dir, 'missing.img')).href },
          ],
        },
        () => {},
      ),
      /ENOENT/,
    );
    (await openOverlay(overlay, undefined, 200)).close(); // not "in use"
    // A restore whose state doesn't fit the devices (another page's snapshot of the machine).
    await assert.rejects(
      Devices.open({ ...base, specs: [{ type: 'blk', url: pathToFileURL(image).href, overlay }], state: [null, null] }, () => {}),
      /other devices/,
    );
    (await openOverlay(overlay, undefined, 200)).close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
