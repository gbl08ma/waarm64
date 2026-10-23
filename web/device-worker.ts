// The device worker (docs/devices.md): one per VM, holding
// every backend. On each DEVICE exit the vCPU rings the doorbell (word 0 of
// `bell`); the worker takes every device's events and requests, then writes
// the doorbell value it handled to word 1, which the vCPU waits on in
// deterministic mode. Console output goes to the owner as messages. If a
// backend throws, word 1 becomes -1 so the vCPU fails instead of waiting.
// `close` releases the backends' files (OPFS locks), answers `closed` and ends
// the worker.
import { Devices, stateBuffers, type DevicesInit } from './devices.ts';
import { registerUsbOpener } from './usb.ts';
import { webHidOpener, type WebHidLike } from './webhid.ts';
import { webUsbOpener, type WebUsbLike } from './webusb.ts';

type Init = DevicesInit & { bell: number };

// The xHCI's real devices (docs/usb.md): WebUSB's and WebHID's, where this worker has them (the page grants them).
const nav = self.navigator as Navigator & { usb?: WebUsbLike; hid?: WebHidLike };
if (nav.usb) registerUsbOpener('usb', webUsbOpener(nav.usb));
if (nav.hid) registerUsbOpener('hid', webHidOpener(nav.hid));

let devices: Devices | undefined;

self.onmessage = (e: MessageEvent) => {
  if (e.data.type === 'init') start(e.data as Init).catch((err) => self.postMessage({ type: 'error', message: String(err) }));
  else if (e.data.type === 'flush') self.postMessage({ type: 'flushed' }); // after every earlier message
  else if (e.data.type === 'save') {
    // The backends' state for a snapshot (the owner has the devices quiet).
    devices!.save().then(
      (state) => self.postMessage({ type: 'saved', state }, stateBuffers(state)),
      (err) => self.postMessage({ type: 'saved', error: String(err instanceof Error ? err.message : err) }),
    );
  }
  else if (e.data.type === 'written' || e.data.type === 'blocks') {
    // A disk's changes for a snapshot: the blocks its overlay holds, then their bytes in batches.
    const { type, id, device, blocks } = e.data as { type: 'written' | 'blocks'; id: number; device: number; blocks: number[] };
    try {
      if (type === 'written') self.postMessage({ type: 'disk', id, written: devices!.written(device) });
      else {
        const bytes = devices!.blocks(device, blocks);
        self.postMessage({ type: 'disk', id, bytes }, { transfer: [bytes.buffer] });
      }
    } catch (err) {
      self.postMessage({ type: 'disk', id, error: String(err instanceof Error ? err.message : err) });
    }
  }
  else if (e.data.type === 'close') {
    const stats = devices?.stats(); // the blk devices' timers (spec `stats`), before close
    devices?.close();
    self.postMessage({ type: 'closed', stats });
    self.close();
  }
};

async function start(init: Init) {
  devices = await Devices.open(init, (device, text) => self.postMessage({ type: 'console', device, text }));
  // The page's `?iostats` (bench/remote-disk): the blk timers whenever the page asks, between requests.
  if (init.specs.some((d) => d.type === 'blk' && d.stats)) new BroadcastChannel('webpc-iostats').onmessage = (e) => { if (e.data === 'ask') (e.target as BroadcastChannel).postMessage(devices!.stats()); };
  self.postMessage({ type: 'ready' });
  await devices.serve(new Int32Array(init.memory.buffer, init.bell, 2));
}
