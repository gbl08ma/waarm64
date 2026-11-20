// The device worker (docs/devices.md): one per VM, holding
// every backend. On each DEVICE exit the vCPU rings the doorbell (word 0 of
// `bell`); the worker takes every device's events and requests, then writes
// the doorbell value it handled to word 1, which the vCPU waits on in
// deterministic mode. Console output goes to the owner as messages. If a
// backend throws, word 1 becomes -1 so the vCPU fails instead of waiting.
// `close` releases the backends' files (OPFS locks), answers `closed` and ends
// the worker.
import { CLOSE_MS, Devices, stateBuffers, type DevicesInit } from './devices.ts';
import { toWire, type Msg, type WireError } from './msg.ts';
import type { Hinted } from './balloon.ts';
import { answerBuffers, type InspectAnswer, type InspectQuery } from './surface.ts';
import { registerUsbOpener } from './usb.ts';
import { webHidOpener, type WebHidLike } from './webhid.ts';
import { webUsbOpener, type WebUsbLike } from './webusb.ts';

type Init = DevicesInit & { bell: number };

/**
 * Owner (web/vm.ts `deviceHost`) → device worker. Every request but `init`, `release` and `close` has an id, which its
 * answer carries: `flushed`, `drained`, `saved`, `refusal`, or `disk` (`written` and `blocks`: a disk's changes for a
 * snapshot; `compact`, `hint` and `inspect`: a disk's surface, web/surface.ts).
 */
export type ToDeviceWorker =
  | ({ type: 'init' } & Init)
  | { type: 'flush'; id: number }
  | { type: 'drain'; id: number }
  | { type: 'save'; id: number }
  | { type: 'refusal'; id: number }
  | { type: 'written'; id: number; device: number }
  | { type: 'blocks'; id: number; device: number; blocks: Uint32Array }
  | { type: 'compact'; id: number; measure?: boolean }
  | { type: 'hint'; id: number; ms: number }
  | { type: 'inspect'; id: number; device: number; query: InspectQuery }
  | { type: 'release' }
  | { type: 'close' };
/** Device worker → owner: an `error` before `ready` is the start's, after it a backend's (`Devices.serve` threw). */
export type FromDeviceWorker =
  | { type: 'ready' }
  | { type: 'error'; message: string; error: WireError }
  | { type: 'console'; device: number; text: string }
  | { type: 'notice'; message: Msg }
  | DeviceAnswer
  | { type: 'closed'; stats?: unknown };
/** The answer to the request with the same id. */
export type DeviceAnswer =
  | { type: 'flushed'; id: number }
  | { type: 'drained'; id: number }
  | { type: 'saved'; id: number; state?: unknown[]; error?: string; wire?: WireError }
  | { type: 'refusal'; id: number; refused?: WireError }
  | {
      type: 'disk';
      id: number;
      written?: { blocks: Uint32Array; generation?: number };
      bytes?: Uint8Array;
      compacted?: { before: number; after: number };
      hinted?: Hinted;
      inspected?: InspectAnswer;
      error?: string;
    };

// The xHCI's real devices (docs/usb.md): WebUSB's and WebHID's, where this worker has them (the page grants them).
const nav = self.navigator as Navigator & { usb?: WebUsbLike; hid?: WebHidLike };
if (nav.usb) registerUsbOpener('usb', webUsbOpener(nav.usb));
if (nav.hid) registerUsbOpener('hid', webHidOpener(nav.hid));

let devices: Devices | undefined;

self.onmessage = (e: MessageEvent<ToDeviceWorker>) => {
  if (e.data.type === 'init')
    start(e.data).catch((err) =>
      self.postMessage({ type: 'error', message: String(err), error: toWire(err) } satisfies FromDeviceWorker),
    );
  else if (e.data.type === 'flush')
    self.postMessage({ type: 'flushed', id: e.data.id } satisfies FromDeviceWorker); // after every earlier message
  else if (e.data.type === 'drain') {
    const id = e.data.id;
    void devices!.drain().then(() => self.postMessage({ type: 'drained', id } satisfies FromDeviceWorker));
  } else if (e.data.type === 'save') {
    // The backends' state for a snapshot (the owner has the devices quiet).
    const id = e.data.id;
    devices!.save().then(
      (state) => self.postMessage({ type: 'saved', id, state } satisfies FromDeviceWorker, stateBuffers(state)),
      (err) =>
        self.postMessage({
          type: 'saved',
          id,
          error: String(err instanceof Error ? err.message : err),
          wire: toWire(err),
        } satisfies FromDeviceWorker),
    );
  } else if (e.data.type === 'refusal') {
    // Why a snapshot would be refused now, asked before it touches the machine (a failed ask refuses nothing: `save` decides).
    const id = e.data.id;
    devices!.refusal().then(
      (refused) => self.postMessage({ type: 'refusal', id, refused } satisfies FromDeviceWorker),
      () => self.postMessage({ type: 'refusal', id } satisfies FromDeviceWorker),
    );
  } else if (e.data.type === 'written' || e.data.type === 'blocks') {
    // A disk's changes for a snapshot: the blocks its overlay holds, then their bytes in batches.
    const m = e.data;
    const { id, device } = m;
    try {
      if (m.type === 'written')
        self.postMessage({ type: 'disk', id, written: devices!.written(device) } satisfies FromDeviceWorker);
      else {
        const bytes = devices!.blocks(device, m.blocks);
        self.postMessage({ type: 'disk', id, bytes } satisfies FromDeviceWorker, { transfer: [bytes.buffer] });
      }
    } catch (err) {
      self.postMessage({
        type: 'disk',
        id,
        error: String(err instanceof Error ? err.message : err),
      } satisfies FromDeviceWorker);
    }
  } else if (e.data.type === 'compact') {
    // The overlays compacted after a trim the page asked for (web/devices.ts `Devices.compact`).
    const id = e.data.id;
    devices!.compact(e.data.measure).then(
      (compacted) => self.postMessage({ type: 'disk', id, compacted } satisfies FromDeviceWorker),
      (err) =>
        self.postMessage({
          type: 'disk',
          id,
          error: String(err instanceof Error ? err.message : err),
        } satisfies FromDeviceWorker),
    );
  } else if (e.data.type === 'hint') {
    // The balloon's free page hint before a snapshot (web/balloon.ts), answered when the guest said STOP or the wait ended.
    const id = e.data.id;
    devices!.hint(e.data.ms).then(
      (hinted) => self.postMessage({ type: 'disk', id, hinted } satisfies FromDeviceWorker),
      (err) =>
        self.postMessage({
          type: 'disk',
          id,
          error: String(err instanceof Error ? err.message : err),
        } satisfies FromDeviceWorker),
    );
  } else if (e.data.type === 'inspect') {
    // A disk's surface or one of its ranges (web/surface.ts), from the maps in memory; the arrays transferred.
    const id = e.data.id;
    devices!.inspect(e.data.device, e.data.query).then(
      (inspected) =>
        self.postMessage({ type: 'disk', id, inspected } satisfies FromDeviceWorker, answerBuffers(inspected)),
      (err) =>
        self.postMessage({
          type: 'disk',
          id,
          error: String(err instanceof Error ? err.message : err),
        } satisfies FromDeviceWorker),
    );
  } else if (e.data.type === 'release') devices!.release();
  else if (e.data.type === 'close') {
    // What the backends hold back (a shared folder's write sessions) lands first, bounded: a host that doesn't answer doesn't keep the page.
    void Promise.race([devices?.drain().catch(() => {}), new Promise((r) => setTimeout(r, CLOSE_MS))]).then(() => {
      const stats = devices?.stats(); // the blk devices' timers (spec `stats`), before close
      devices?.close();
      self.postMessage({ type: 'closed', stats } satisfies FromDeviceWorker);
      self.close();
    });
  }
};

async function start(init: Init) {
  devices = await Devices.open(
    init,
    (device, text) => self.postMessage({ type: 'console', device, text } satisfies FromDeviceWorker),
    (message) => self.postMessage({ type: 'notice', message } satisfies FromDeviceWorker),
  );
  // The page's `?iostats` (bench/remote-disk): the blk timers whenever the page asks, between requests.
  if (init.specs.some((d) => d.type === 'blk' && d.stats))
    new BroadcastChannel('waarm64-iostats').onmessage = (e) => {
      if (e.data === 'ask') (e.target as BroadcastChannel).postMessage(devices!.stats());
    };
  self.postMessage({ type: 'ready' } satisfies FromDeviceWorker);
  await devices.serve(new Int32Array(init.memory.buffer, init.bell, 2));
}
