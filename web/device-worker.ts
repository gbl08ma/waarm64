// The device worker (docs/devices.md): one per VM, holding
// every backend. On each DEVICE exit the vCPU rings the doorbell (word 0 of
// `bell`); the worker takes every device's events and requests, then writes
// the doorbell value it handled to word 1, which the vCPU waits on in
// deterministic mode. Console output goes to the owner as messages. If a
// backend throws, word 1 becomes -1 so the vCPU fails instead of waiting.
// `close` releases the backends' files (OPFS locks), answers `closed` and ends
// the worker.
import { Devices, type DevicesInit } from './devices.ts';

type Init = DevicesInit & { bell: number };

let devices: Devices | undefined;

self.onmessage = (e: MessageEvent) => {
  if (e.data.type === 'init') start(e.data as Init).catch((err) => self.postMessage({ type: 'error', message: String(err) }));
  else if (e.data.type === 'flush') self.postMessage({ type: 'flushed' }); // after every earlier message
  else if (e.data.type === 'save') {
    // The backends' state for a snapshot (the owner has the devices quiet).
    try {
      self.postMessage({ type: 'saved', state: devices!.save() });
    } catch (err) {
      self.postMessage({ type: 'saved', error: String(err instanceof Error ? err.message : err) });
    }
  }
  else if (e.data.type === 'close') {
    devices?.close();
    self.postMessage({ type: 'closed' });
    self.close();
  }
};

async function start(init: Init) {
  devices = await Devices.open(init, (device, text) => self.postMessage({ type: 'console', device, text }));
  self.postMessage({ type: 'ready' });
  await devices.serve(new Int32Array(init.memory.buffer, init.bell, 2));
}
