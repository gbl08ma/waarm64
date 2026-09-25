// The device worker (PLAN.md §2 "Device backends (ABI 6)"): one per VM, holding
// every backend. On each DEVICE exit the vCPU rings the doorbell (word 0 of
// `bell`); the worker takes every device's events and requests, then writes
// the doorbell value it handled to word 1, which the vCPU waits on in
// deterministic mode. Console output goes to the owner as messages. If a
// backend throws, word 1 becomes -1 so the vCPU fails instead of waiting.
import { Devices, type DevicesInit } from './devices.ts';

type Init = DevicesInit & { bell: number };

self.onmessage = (e: MessageEvent) => {
  if (e.data.type === 'init') void start(e.data as Init);
  else if (e.data.type === 'flush') self.postMessage({ type: 'flushed' }); // after every earlier message
};

async function start(init: Init) {
  const devices = new Devices(init, (device, text) => self.postMessage({ type: 'console', device, text }));
  const bell = new Int32Array(init.memory.buffer, init.bell, 2);
  self.postMessage({ type: 'ready' });
  for (let seen = 0; ;) {
    const rung = Atomics.load(bell, 0);
    if (rung === seen) {
      const w = Atomics.waitAsync(bell, 0, seen);
      if (w.async) await w.value;
      continue;
    }
    seen = rung;
    try {
      await devices.poll();
    } catch (e) {
      Atomics.store(bell, 1, -1);
      Atomics.notify(bell, 1);
      throw e;
    }
    Atomics.store(bell, 1, seen);
    Atomics.notify(bell, 1);
  }
}
