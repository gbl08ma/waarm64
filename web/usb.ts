// The xHCI's host side (docs/usb.md): the glue between the core's controller (core/src/xhci.rs) and
// the USB devices on its root connectors. The core walks the guest's rings and posts each TD as a
// record to the request ring of its shared block (`vm_xhci`); this reads the records, gathers OUT data
// from guest RAM, calls the device (web/usb-device.ts `UsbDevice`), scatters IN data back and posts
// {tag, code, bytes} to the completion ring. Plugging and unplugging go to the same ring. It runs in
// `Devices` (web/devices.ts), on the same doorbell as the virtio backends: in the device worker, or
// inline where the vCPU's thread can't block.
//
// Devices come from openers by API: the virtual ones here (Gadget Zero, the keyboard, the game pad), and the WebUSB and WebHID
// ones a page registers in the device worker (`registerUsbOpener`). The page attaches and detaches
// them with `usb-attach`/`usb-detach` messages on a port and hears `usb-state` back.

import type {
  UsbDevice,
  UsbFromWorker,
  UsbIdentity,
  UsbState,
  UsbOpener,
  UsbProblem,
  UsbResult,
  UsbSpeed,
  UsbToWorker,
  UsbTransfer,
  UsbVirtual,
} from './usb-device.ts';
import { GadgetZero } from './usb-gadget-zero.ts';
import { UsbKeyboard } from './usb-keyboard.ts';
import { UsbGamepad } from './usb-gamepad.ts';
import { bytes, type Ram } from './ram.ts';
import { MsgError, toWire } from './msg.ts';

// xhci::XhciShared (core/src/xhci.rs): events, then two virtio::WordRings of 4096 words.
const RING_WORDS = 4096;
const REQ = 8;
const CPL = REQ + 8 + 4 * RING_WORDS;
const REQ_TRANSFER = 0;
const REQ_RESET = 1;
const REQ_CANCEL = 2;
const REQ_CONFIGURED = 3;
const REQ_CLEAR_HALT = 4;
const CPL_DONE = 0;
const CPL_ATTACH = 1;
const CPL_DETACH = 2;
const SEG_IMMEDIATE = 0x8000_0000;
/** A segment's memory, in its length word's bits 27:24 (core/src/xhci.rs `SEG_MEM_SHIFT`). */
const SEG_MEM_SHIFT = 24;
/** Root connectors (each a USB 2 and a USB 3 port). */
export const CONNECTORS = 4;

const CODES: Record<UsbResult['code'], number> = { success: 1, short: 13, stall: 6, babble: 3, error: 4 };
const SPEEDS: Record<UsbSpeed, number> = { full: 1, low: 2, high: 3, super: 4 };
/** xHCI endpoint types (1–7) as the contract names them. */
const TYPES = ['isoch', 'isoch', 'bulk', 'interrupt', 'control', 'isoch', 'bulk', 'interrupt'] as const;

const openers = new Map<'usb' | 'hid', UsbOpener>();

/** Makes `api` devices attachable (in the device worker, before the machine starts): WebUSB's passthrough, WebHID's device. */
export function registerUsbOpener(api: 'usb' | 'hid', open: UsbOpener) {
  openers.set(api, open);
}

/** A virtual device of ours by its description (`UsbVirtual`). */
export function virtualDevice(d: UsbVirtual, connector = 0): UsbDevice {
  if (d.kind === 'gadget-zero') return new GadgetZero({ speed: d.speed, pattern: d.pattern, serial: d.serial });
  if (d.kind === 'keyboard') return new UsbKeyboard();
  if (d.kind === 'gamepad') return new UsbGamepad({ name: d.name, serial: `waarm64-pad-${connector}` });
  throw new Error(`no virtual USB device ${(d as { kind: string }).kind}`);
}

export type UsbAttach = { connector: number; device: UsbIdentity | UsbVirtual };

export type UsbInit = {
  memory: WebAssembly.Memory;
  /** `vm_xhci`'s address, and guest RAM's. */
  shared: number;
  ram: number;
  ramSize: number;
  /** The spill memories (docs/spill-memories.md), memory 1 first. */
  spill?: WebAssembly.Memory[];
  deterministic: boolean;
  /** Sets SIGNAL_DEVICE and wakes the vCPUs (what `Devices` does after a completion). */
  kick: () => void;
  /** The page's port for `usb-attach`/`usb-detach` (UsbToWorker) and `usb-state` (UsbFromWorker). */
  port?: MessagePort;
  /** Attached before the guest runs (its *attach at start* devices). */
  attach?: UsbAttach[];
  /**
   * The transfers' bytes since the start, for the status bar (`DevicesInit.io`'s last pair): [0] what the devices gave the
   * guest (IN), [1] what they took (OUT); a transfer counts its actual length as it completes, whatever its code.
   */
  io?: Float64Array;
};

type Plugged = { dev: UsbDevice; device: UsbIdentity | UsbVirtual };
type Segment = { off: number; len: number; mem: number; imm?: Uint8Array };
type InFlight = { connector: number; gen: number; into: boolean; segs: Segment[]; length: number };
/** An attach whose opener is still running; a detach meanwhile cancels it. */
type Opening = { done: Promise<void>; cancelled: boolean };
/** At most this many records in a batch (each has three words). */
const MAX_RECORDS = Math.ceil(RING_WORDS / 3);

export class Usb {
  private init: UsbInit;
  private plugged: (Plugged | undefined)[] = Array(CONNECTORS).fill(undefined);
  /** Detaches each connector has had (mod 256): the core's records carry its count, and stale ones are dropped. */
  private gens = Array(CONNECTORS).fill(0);
  private inflight = new Map<number, InFlight>();
  /** Completion records that found the core's ring full, oldest first. */
  private waiting: [number, number, number][] = [];
  /** Attaches waiting for an opener, by connector. */
  private opening = new Map<number, Opening>();
  private closed = false;
  /** Views of memory 0 and of guest RAM, made again when a memory grows (a new buffer). */
  private u32View?: Uint32Array;
  private ramView: Ram = [];
  /** The batch's records, read out of the core's ring: each one's w0, w1 and where its words start in `words`. */
  private readonly words = new Uint32Array(RING_WORDS);
  private readonly recW0 = new Uint32Array(MAX_RECORDS);
  private readonly recW1 = new Uint32Array(MAX_RECORDS);
  private readonly recAt = new Uint32Array(MAX_RECORDS);

  constructor(init: UsbInit) {
    this.init = init;
    if (init.port) init.port.onmessage = (e: MessageEvent<UsbToWorker>) => this.message(e.data);
    // Not requests of the page's: no `usb-state` for them.
    for (const a of init.attach ?? []) void this.attach(a.connector, a.device, false);
  }

  private u32() {
    const buffer = this.init.memory.buffer;
    if (this.u32View?.buffer !== buffer) this.u32View = new Uint32Array(buffer);
    return this.u32View;
  }

  private post(m: UsbFromWorker) {
    this.init.port?.postMessage(m);
  }

  private message(m: UsbToWorker) {
    if (m?.type === 'usb-attach') void this.attach(m.connector, m.device);
    else if (m?.type === 'usb-detach') this.detach(m.connector, 'page');
    else if (m?.type === 'usb-key') {
      const dev = this.plugged[m.connector]?.dev;
      if (dev instanceof UsbKeyboard) {
        if (m.code) dev.key(m.code, m.down);
        else dev.releaseAll();
      }
    } else if (m?.type === 'usb-pad') {
      const dev = this.plugged[m.connector]?.dev;
      if (dev instanceof UsbGamepad) dev.pad(m.pad);
    }
  }

  /**
   * Plugs `device` into `connector`: opened (a virtual device at once, so in deterministic mode the
   * plug lands before the vCPU runs on), then posted to the core, then `usb-state` attached (or error),
   * the one answer to the page's `usb-attach` (none with `reply` false: the devices plugged in at start).
   */
  async attach(connector: number, device: UsbIdentity | UsbVirtual, reply = true): Promise<UsbState> {
    const fail = (e: unknown, detail?: UsbProblem[]): UsbState => {
      const m: UsbState = {
        type: 'usb-state',
        connector,
        state: 'error',
        message: String((e as Error)?.message ?? e),
        error: toWire(e),
        ...(detail?.length ? { detail } : {}),
      };
      if (reply) this.post(m);
      return m;
    };
    if (!(connector >= 0 && connector < CONNECTORS)) return fail(new Error(`no connector ${connector}`));
    if (this.plugged[connector] || this.opening.has(connector))
      return fail(new Error(`connector ${connector} has a device`));
    let dev: UsbDevice;
    if (device.api === 'virtual') {
      try {
        dev = virtualDevice(device, connector);
        const kbd = dev instanceof UsbKeyboard ? dev : undefined;
        if (kbd) kbd.onLeds = (leds) => this.post({ type: 'usb-leds', connector, leds });
        const pad = dev instanceof UsbGamepad ? dev : undefined;
        if (pad) pad.onRumble = (strong, weak) => this.post({ type: 'usb-rumble', connector, strong, weak });
      } catch (e) {
        return fail(e);
      }
    } else {
      if (this.init.deterministic)
        return fail(new Error('a real device in deterministic mode: its timing would make the run differ'));
      const open = openers.get(device.api);
      if (!open)
        return fail(device.api === 'usb' ? new MsgError('usb:usb.noWebUsb') : new MsgError('usb:usb.noWebHid'));
      const gen = this.gens[connector];
      let resolve = () => {};
      const opening: Opening = {
        done: new Promise<void>((r) => {
          resolve = r;
        }),
        cancelled: false,
      };
      this.opening.set(connector, opening);
      try {
        dev = await open(device, { connector, gone: () => this.gone(connector, gen) });
      } catch (e) {
        return fail(
          new MsgError('usb:usb.openFailed', undefined, { cause: e }),
          (e as { problems?: UsbProblem[] }).problems,
        );
      } finally {
        this.opening.delete(connector);
        resolve();
      }
      if (this.closed || this.plugged[connector] || opening.cancelled) {
        dev.detach();
        return fail(new MsgError('usb:usb.wentAway'));
      }
    }
    this.plugged[connector] = { dev, device };
    this.completion([connector, CPL_ATTACH | (SPEEDS[dev.speed] << 8), 0]);
    const m: UsbState = {
      type: 'usb-state',
      connector,
      state: 'attached',
      device,
      speed: dev.speed,
      ...(dev.problems?.length ? { problems: dev.problems } : {}),
    };
    if (reply) this.post(m);
    return m;
  }

  /** The host's device went away (the device said so): the connector empties. */
  private gone(connector: number, gen: number) {
    if (this.gens[connector] === gen) this.detach(connector, 'unplugged');
  }

  /** Unplugs `connector`: the device is released, the core fails its TDs, the guest sees a disconnect. */
  detach(connector: number, reason: 'unplugged' | 'guest' | 'page' = 'page'): UsbState {
    const p = this.plugged[connector];
    const opening = this.opening.get(connector);
    if (opening) opening.cancelled = true; // its device is let go of when it opens (the page has heard `detached`)
    if (p) {
      this.plugged[connector] = undefined;
      this.gens[connector] = (this.gens[connector] + 1) & 0xff;
      for (const [tag, f] of this.inflight) if (f.connector === connector) this.inflight.delete(tag);
      p.dev.detach();
      this.completion([connector, CPL_DETACH, 0]);
    }
    const m: UsbState = { type: 'usb-state', connector, state: 'detached', reason };
    this.post(m);
    return m;
  }

  /** What is on each connector (for a snapshot's check, the page's menus). */
  attached() {
    return this.plugged.map((p) => p?.device);
  }

  /** Takes the core's records: TDs to the devices, and their resets, cancels and endpoints. */
  poll() {
    const u32 = this.u32();
    const at = this.init.shared / 4;
    Atomics.exchange(u32, at, 0);
    const ring = at + REQ / 4;
    let tail = u32[ring + 1];
    const head = Atomics.load(u32, ring);
    const { words, recW0, recW1, recAt } = this;
    // The records are copied out before the tail moves (the core may reuse their room after): into `words`, which
    // holds a whole ring.
    let count = 0;
    let used = 0;
    let cancels = false;
    while (tail !== head) {
      recW0[count] = u32[ring + 2 + (tail++ % RING_WORDS)];
      const w1 = u32[ring + 2 + (tail++ % RING_WORDS)];
      recW1[count] = w1;
      const n = u32[ring + 2 + (tail++ % RING_WORDS)];
      recAt[count++] = used;
      for (let k = 0; k < n; k++) words[used++] = u32[ring + 2 + (tail++ % RING_WORDS)];
      if (w1 >>> 16 === REQ_CANCEL) cancels = true;
      tail >>>= 0;
    }
    Atomics.store(u32, ring + 1, tail);
    this.flushCompletions();
    // A TD cancelled before it was read never reaches its device: the guest may have its buffer back already.
    // From the end, so that a tag given again after its cancel (in the same batch) is the new TD's.
    let skip: Set<number> | undefined;
    if (cancels) {
      skip = new Set<number>();
      const cancelled = new Set<number>();
      for (let i = count - 1; i >= 0; i--) {
        const kind = recW1[i] >>> 16;
        const w = recAt[i];
        if (kind === REQ_CANCEL) for (let k = 0; k < words[w]; k++) cancelled.add(words[w + 1 + k]);
        else if (kind === REQ_TRANSFER && cancelled.delete(recW0[i] & 0xff_ffff)) skip.add(i);
      }
    }
    for (let i = 0; i < count; i++) {
      const w0 = recW0[i];
      const w1 = recW1[i];
      const w = recAt[i];
      const connector = w1 & 0xff;
      const dci = (w1 >>> 8) & 0xff;
      const gen = w0 >>> 24;
      const p = this.plugged[connector];
      if (!p || gen !== this.gens[connector]) continue; // for a device that's gone
      const ep = dci === 1 ? 0 : (dci >> 1) | ((dci & 1) << 7);
      switch (w1 >>> 16) {
        case REQ_TRANSFER: {
          if (skip?.has(i)) break;
          const tag = w0 & 0xff_ffff;
          try {
            this.transfer(p, connector, gen, tag, ep, w);
          } catch (e) {
            // Before the TD reached the device (its words don't parse, its buffer isn't in RAM).
            console.error(`waarm64: USB device on connector ${connector}: a transfer threw`, e);
            this.completion([tag | (gen << 24), CPL_DONE | (CODES.error << 8), 0]);
          }
          break;
        }
        case REQ_RESET:
          this.guarded(connector, 'reset', () => p.dev.reset());
          break;
        case REQ_CANCEL: {
          const tags: number[] = [];
          for (let k = 0; k < words[w]; k++) {
            const t = words[w + 1 + k];
            if (this.inflight.delete(t)) tags.push(t);
          }
          if (tags.length) this.guarded(connector, 'cancel', () => p.dev.cancel(ep, tags));
          break;
        }
        case REQ_CONFIGURED: {
          const eps = Array.from({ length: words[w] }, (_, i) => {
            const a = words[w + 1 + 2 * i];
            const b = words[w + 2 + 2 * i];
            const d = a & 0xff;
            return {
              ep: (d >> 1) | ((d & 1) << 7),
              type: TYPES[(a >>> 8) & 7] as 'bulk' | 'interrupt' | 'isoch',
              maxPacket: b & 0x7ff,
              interval: (a >>> 16) & 0xff,
            };
          });
          this.guarded(connector, 'configured', () => p.dev.configured?.(eps));
          break;
        }
        case REQ_CLEAR_HALT:
          this.guarded(connector, 'clearHalt', () => p.dev.clearHalt?.(ep));
          break;
      }
    }
    // In realtime mode the core holds the command that cancelled until this has read the cancel (no
    // `done` writes into those TDs' buffers after it): the signal lets it complete.
    if (!this.init.deterministic && cancels) this.init.kick();
  }

  /** A device that throws fails its TD (or loses the call), not the device worker with its disks and network. */
  private guarded(connector: number, what: string, f: () => void) {
    try {
      f();
    } catch (e) {
      console.error(`waarm64: USB device on connector ${connector}: ${what} threw`, e);
    }
  }

  /** A TD to its device: its words are `this.words` from `w` (the record's after its three). */
  private transfer(p: Plugged, connector: number, gen: number, tag: number, ep: number, w: number) {
    const words = this.words;
    const w0 = words[w];
    const nseg = w0 & 0xffff;
    const eptype = (w0 >>> 16) & 0xff;
    const length = words[w + 1];
    let k = w + 2;
    let setup: UsbTransfer['setup'];
    if ((w0 >>> 24) & 1) {
      const a = words[w + 2];
      const b = words[w + 3];
      setup = {
        requestType: a & 0xff,
        request: (a >>> 8) & 0xff,
        value: a >>> 16,
        index: b & 0xffff,
        length: b >>> 16,
      };
      k = w + 4;
    }
    const segs: Segment[] = [];
    for (let i = 0; i < nseg; i++) {
      const off = words[k++];
      const len = words[k++];
      if (len & SEG_IMMEDIATE) {
        const bytes = new Uint8Array(8);
        const v = new DataView(bytes.buffer);
        v.setUint32(0, words[k++], true);
        v.setUint32(4, words[k++], true);
        segs.push({ off: 0, len: len & 0xff, mem: 0, imm: bytes.subarray(0, len & 0xff) });
      } else segs.push({ off, len: len & 0xff_ffff, mem: (len >>> SEG_MEM_SHIFT) & 0xf });
    }
    const into = setup ? (setup.requestType & 0x80) !== 0 : (ep & 0x80) !== 0;
    const type = TYPES[eptype & 7];
    const t: UsbTransfer = { tag, ep, type, length, setup };
    if (!into && length > 0) t.data = this.gather(segs, length);
    if (type === 'isoch') t.packets = [length];
    this.inflight.set(tag, { connector, gen, into, segs, length });
    try {
      p.dev.submit(t, (r) => this.done(tag, r));
    } catch (e) {
      // A device that completed the TD and then threw has completed it: `done` is once per TD.
      console.error(`waarm64: USB device on connector ${connector}: a transfer threw`, e);
      this.done(tag, { code: 'error', actual: 0 });
    }
  }

  /** Guest RAM's views, made again only when a memory grew. */
  private ram(): Ram {
    const v = this.ramView;
    const spill = this.init.spill ?? [];
    let stale = v[0]?.buffer !== this.init.memory.buffer;
    for (let i = 0; i < spill.length && !stale; i++) stale = v[i + 1].buffer !== spill[i].buffer;
    if (stale) {
      this.ramView = [new Uint8Array(this.init.memory.buffer, this.init.ram, this.init.ramSize)];
      for (const m of spill) this.ramView.push(new Uint8Array(m.buffer));
    }
    return this.ramView;
  }

  private gather(segs: Segment[], length: number) {
    const out = new Uint8Array(length);
    const ram = this.ram();
    let at = 0;
    for (const s of segs) {
      out.set(s.imm ?? bytes(ram, s), at);
      at += s.len;
    }
    return out;
  }

  private done(tag: number, r: UsbResult) {
    const f = this.inflight.get(tag);
    if (!f || this.closed) return; // cancelled, or its device is gone
    this.inflight.delete(tag);
    let actual = Math.max(0, Math.min(r.actual, f.length));
    if (f.into) {
      const data = r.data ?? new Uint8Array(0);
      actual = Math.min(actual, data.length);
      const ram = this.ram();
      let at = 0;
      for (const s of f.segs) {
        if (at >= actual) break;
        const n = Math.min(s.len, actual - at);
        bytes(ram, s).set(data.subarray(at, at + n));
        at += n;
      }
    }
    if (this.init.io) this.init.io[f.into ? 0 : 1] += actual;
    this.completion([tag | (f.gen << 24), CPL_DONE | (CODES[r.code] << 8), actual]);
  }

  /** A record for the core's completion ring (it is sized for every TD in flight), then the signal. */
  private completion(w: [number, number, number]) {
    this.waiting.push(w);
    this.flushCompletions();
  }

  /**
   * Moves waiting completion records into the core's ring as far as it has room, in order. The core
   * keeps it big enough for its TDs in flight, but a backend may still complete TDs the core has
   * already stopped (and given their room to new ones): those wait here for the next poll.
   */
  private flushCompletions() {
    if (!this.waiting.length) return;
    const u32 = this.u32();
    const ring = (this.init.shared + CPL) / 4;
    let moved = false;
    while (this.waiting.length) {
      const head = u32[ring];
      if (RING_WORDS - ((head - Atomics.load(u32, ring + 1)) >>> 0) < 3) break;
      const w = this.waiting.shift()!;
      for (let i = 0; i < 3; i++) u32[ring + 2 + ((head + i) % RING_WORDS)] = w[i] >>> 0;
      Atomics.store(u32, ring, (head + 3) >>> 0);
      moved = true;
    }
    if (moved) this.init.kick();
  }

  /** Waits for attaches whose device is still opening. */
  async settled() {
    await Promise.all(Array.from(this.opening.values(), (o) => o.done));
  }

  close() {
    this.closed = true;
    for (let c = 0; c < CONNECTORS; c++) this.plugged[c]?.dev.detach();
    this.plugged.fill(undefined);
    if (this.init.port) {
      this.init.port.onmessage = null;
      this.init.port.close();
    }
  }
}
