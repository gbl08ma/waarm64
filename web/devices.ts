// virtio device backends (PLAN.md §2 "Device backends (ABI 6)"). The core runs
// the virtio-mmio transports and split queues and posts each descriptor chain
// to the device's request ring as RAM segments; backends here only speak the
// device protocol. `Devices` works on the shared memory from any thread: in the
// device worker (web/device-worker.ts) or inline on the vCPU thread.
import { splitmix64 } from '../tools/corpus/corpus.ts';
import { p9, type P9Files } from './9p.ts';
import { loopback, portAdapter, type NetAdapter } from './net.ts';
import { overlay } from './overlay.ts';
import { openDisk, type Disk } from './qcow2.ts';

/**
 * Host-side device configuration, one per virtio-mmio slot (in order). `blk`
 * is a read-only disk image (raw or qcow2, web/qcow2.ts) read with HTTP range
 * requests; `size` (its virtual size in bytes, a multiple of 512) is filled in
 * by `bootVm` from the file's first bytes if missing. With `overlay` (an OPFS
 * directory name) the disk is writable: writes go to a copy-on-write overlay
 * there (web/overlay.ts), which persists across boots and belongs to that image.
 */
export type DeviceSpec =
  | { type: 'console' }
  | { type: 'rng' }
  | { type: 'blk'; url: string; size?: number; overlay?: string }
  | NetSpec
  | P9Spec
  | InputSpec;

/**
 * virtio-net (web/net.ts): Ethernet frames to and from an adapter, the
 * loopback test adapter in the device worker or a page's adapter behind a
 * MessagePort. `mac` defaults to 52:54:00:12:34:56; the link is always up.
 */
export type NetSpec = { type: 'net'; mac?: string; adapter: 'loopback' | MessagePort };
/** virtio-9p (web/9p.ts): an in-memory tree, mounted by the guest by `tag`, starting with `files` (path → contents). */
export type P9Spec = { type: '9p'; tag: string; files?: P9Files };
/**
 * virtio-input: a keyboard or a tablet (absolute pointer, 0–32767 on both
 * axes). Events for the guest come from `port` as arrays of [type, code,
 * value] (Linux input-event-codes; web/input.ts makes them from DOM events);
 * the guest's status events (LEDs) go to it as one [type, code, value] each.
 */
export type InputSpec = { type: 'input'; kind: 'keyboard' | 'tablet'; port?: MessagePort };

/** The MessagePorts in `specs`, to transfer with them. */
export const specPorts = (specs: DeviceSpec[]) =>
  specs.flatMap((d) => (d.type === 'net' && typeof d.adapter !== 'string' ? [d.adapter] : d.type === 'input' && d.port ? [d.port] : []));

// virtio::DevShared layout (core/src/virtio.rs).
const EVENTS = 0;
const EPOCH = 16;
const CONFIG = 24;
const REQ = 280;
const RING_WORDS = 4096;
const CPL = REQ + 8 + 4 * RING_WORDS;
const SIGNAL_DEVICE = 4;
export const EV_CONFIG = 2;

/** virtio::DeviceEntry (u64s) and the initial config space. */
export function deviceEntry(d: DeviceSpec): { entry: bigint[]; config: Uint8Array } {
  switch (d.type) {
    // id, features, queues, queue size, config length. Console: no optional
    // features, so one port (receiveq 0, transmitq 1); config is cols, rows,
    // max_nr_ports, emerg_wr, unused without them.
    case 'console': return { entry: [3n, 0n, 2n, 64n, 12n], config: new Uint8Array(12) };
    case 'rng': return { entry: [4n, 0n, 1n, 64n, 0n], config: new Uint8Array(0) };
    case 'blk': {
      // Features SEG_MAX (2), and RO (5) or, with an overlay, FLUSH (9); config:
      // capacity in sectors (u64 at 0), seg_max (u32 at 12) = queue size - 2, as QEMU.
      const config = new Uint8Array(16);
      const v = new DataView(config.buffer);
      v.setBigUint64(0, BigInt(Math.floor((d.size ?? 0) / 512)), true);
      v.setUint32(12, 126, true);
      return { entry: [2n, 1n << 2n | (d.overlay ? 1n << 9n : 1n << 5n), 1n, 128n, 16n], config };
    }
    case 'net': {
      // Features MAC (5) and STATUS (16); config: mac, status = LINK_UP. receiveq, transmitq.
      const config = new Uint8Array(8);
      config.set((d.mac ?? '52:54:00:12:34:56').split(':').map((h) => parseInt(h, 16)));
      config[6] = 1;
      return { entry: [1n, 1n << 5n | 1n << 16n, 2n, 256n, 8n], config };
    }
    case '9p': {
      // Feature MOUNT_TAG (0); config: tag length (u16), tag. One request queue.
      const tag = new TextEncoder().encode(d.tag);
      const config = new Uint8Array(2 + tag.length);
      config.set([tag.length & 0xff, tag.length >> 8]);
      config.set(tag, 2);
      return { entry: [9n, 1n, 1n, 128n, BigInt(config.length)], config };
    }
    // eventq, statusq; config: select, subsel, size, 5 reserved, 128 bytes of answer.
    case 'input': return { entry: [18n, 0n, 2n, 64n, 136n], config: new Uint8Array(136) };
  }
}

export type Segment = { off: number; len: number };
export type Request = { w0: number; queue: number; read: Segment[]; write: Segment[] };
export type Ctx = { ram: () => Uint8Array; complete: (w0: number, len: number) => void; config: () => Uint8Array };

/**
 * A backend handles a request now (returns bytes written, or a promise of
 * them: requests complete in order either way), or keeps it and completes it
 * later. `config` runs when the guest wrote the config space.
 */
type Backend = { request(r: Request): number | Promise<number> | undefined; reset(): void; close?(): void; config?(): void };

function console_(out: (text: string) => void, ctx: Ctx): Backend {
  const decoder = new TextDecoder();
  const rx: Request[] = []; // receive buffers, until input arrives (host input comes later)
  return {
    request(r) {
      if (r.queue === 0) {
        rx.push(r);
        return undefined;
      }
      const ram = ctx.ram();
      for (const s of r.read) out(decoder.decode(ram.slice(s.off, s.off + s.len), { stream: true })); // a copy: TextDecoder refuses shared memory
      return 0;
    },
    reset() { rx.length = 0; },
  };
}

function rng(ctx: Ctx, deterministic: boolean): Backend {
  // Deterministic mode: the same bytes natively (core/tests/common) and here,
  // so boots keep one step count. Realtime: the platform's CSPRNG.
  if (!deterministic) {
    return {
      request(r) {
        const ram = ctx.ram();
        let n = 0;
        for (const s of r.write) {
          for (let k = 0; k < s.len; k += 65536) ram.set(crypto.getRandomValues(new Uint8Array(Math.min(65536, s.len - k))), s.off + k); // not on shared memory directly
          n += s.len;
        }
        return n;
      },
      reset() {},
    };
  }
  const g = splitmix64(0n);
  let word = 0n;
  let left = 0;
  const byte = () => {
    if (left === 0) [word, left] = [g.next().value as bigint, 8];
    const b = Number(word & 0xffn);
    word >>= 8n;
    left--;
    return b;
  };
  return {
    request(r) {
      const ram = ctx.ram();
      let n = 0;
      for (const s of r.write) {
        for (let k = 0; k < s.len; k++) ram[s.off + k] = byte();
        n += s.len;
      }
      return n;
    },
    reset() {},
  };
}

/** Bytes of the concatenated segments, `len` of them at most. */
export function gather(ram: Uint8Array, segs: Segment[], len: number) {
  const out = new Uint8Array(len);
  let k = 0;
  for (const s of segs) {
    if (k === len) break;
    const n = Math.min(s.len, len - k);
    out.set(ram.subarray(s.off, s.off + n), k);
    k += n;
  }
  return out.subarray(0, k);
}

/** Writes `data` across the segments, in order. */
export function scatter(ram: Uint8Array, segs: Segment[], data: Uint8Array) {
  let k = 0;
  for (const s of segs) {
    if (k === data.length) break;
    const n = Math.min(s.len, data.length - k);
    ram.set(data.subarray(k, k + n), s.off);
    k += n;
  }
}

const NET_HDR = 12; // virtio_net_hdr_v1: no offloads, so all zeros but num_buffers
const MAX_FRAME = 1518; // a 1500-byte MTU, the Ethernet header and a VLAN tag
const RX_QUEUE = 256; // frames held while the guest has posted no receive buffer

/**
 * virtio-net: each transmitted chain is one frame for the adapter (header
 * stripped); frames from the adapter wait for receive buffers, the oldest
 * dropped past RX_QUEUE, as a NIC drops. Guest bugs (short or oversized
 * chains) drop the frame.
 */
function net(ctx: Ctx, d: NetSpec): Backend {
  const rx: Request[] = [];
  const frames: Uint8Array[] = [];
  const room = (r: Request) => r.write.reduce((n, s) => n + s.len, 0);
  const deliver = () => {
    while (rx.length && frames.length) {
      const f = frames.shift()!;
      if (NET_HDR + f.length > room(rx[0])) continue; // the guest's buffers are too small: dropped
      const r = rx.shift()!;
      const b = new Uint8Array(NET_HDR + f.length);
      b[10] = 1; // num_buffers
      b.set(f, NET_HDR);
      scatter(ctx.ram(), r.write, b);
      ctx.complete(r.w0, b.length);
    }
  };
  const receive = (f: Uint8Array) => {
    frames.push(f);
    if (frames.length > RX_QUEUE) frames.shift();
    deliver();
  };
  const adapter: NetAdapter = d.adapter === 'loopback' ? loopback(receive) : portAdapter(d.adapter, receive);
  return {
    request(r) {
      if (r.queue === 0) {
        rx.push(r);
        deliver();
        return undefined;
      }
      const len = r.read.reduce((n, s) => n + s.len, 0);
      if (len > NET_HDR && len <= NET_HDR + MAX_FRAME) adapter.send(gather(ctx.ram(), r.read, len).subarray(NET_HDR));
      return 0;
    },
    reset() {
      rx.length = 0;
      frames.length = 0;
    },
    close: () => adapter.close?.(),
  };
}

// virtio-input config selectors (virtio 1.2 §5.8.2) and the event types we use.
const CFG_ID_NAME = 1;
const CFG_ID_DEVIDS = 3;
const CFG_EV_BITS = 0x11;
const CFG_ABS_INFO = 0x12;
const EV_KEY = 1;
const EV_REL = 2;
const EV_ABS = 3;
const EV_LED = 0x11;
const EV_REP = 0x14;

/** A bitmap with `bits` set, as the config space carries it. */
function bitmap(bits: number[]) {
  const b = new Uint8Array((Math.max(...bits) >> 3) + 1);
  for (const k of bits) b[k >> 3] |= 1 << (k & 7);
  return b;
}

/** The answer to a config query (select, subsel) about a keyboard or a tablet. */
export function inputConfig(kind: InputSpec['kind'], select: number, subsel: number): Uint8Array {
  const kbd = kind === 'keyboard';
  switch (select) {
    case CFG_ID_NAME: return new TextEncoder().encode(kbd ? 'webpc keyboard' : 'webpc tablet');
    case CFG_ID_DEVIDS: return new Uint8Array(new Uint16Array([6, 0, kbd ? 1 : 2, 1]).buffer); // BUS_VIRTUAL, vendor, product, version
    case CFG_EV_BITS:
      if (kbd && subsel === EV_KEY) return bitmap(Array.from({ length: 248 }, (_, k) => k + 1)); // KEY_ESC to KEY_MICMUTE
      if (kbd && subsel === EV_LED) return bitmap([0, 1, 2]); // Num, Caps, Scroll Lock
      if (kbd && subsel === EV_REP) return new Uint8Array(1); // autorepeat (the kernel's)
      if (!kbd && subsel === EV_KEY) return bitmap([0x110, 0x111, 0x112]); // BTN_LEFT, RIGHT, MIDDLE
      if (!kbd && subsel === EV_REL) return bitmap([8]); // REL_WHEEL
      if (!kbd && subsel === EV_ABS) return bitmap([0, 1]); // ABS_X, ABS_Y
      return new Uint8Array(0);
    case CFG_ABS_INFO: return !kbd && subsel <= 1 ? new Uint8Array(new Uint32Array([0, 32767, 0, 0, 0]).buffer) : new Uint8Array(0); // min, max, fuzz, flat, res
    default: return new Uint8Array(0);
  }
}

const INPUT_QUEUE = 1024; // events held while the guest has posted no event buffer

/**
 * virtio-input: events from `port` fill the guest's event buffers, 8 bytes
 * each (type u16, code u16, value s32), the oldest dropped past INPUT_QUEUE;
 * status events from the guest go to `port`.
 */
function input(ctx: Ctx, d: InputSpec): Backend {
  const bufs: Request[] = [];
  const events: number[][] = [];
  const deliver = () => {
    while (bufs.length && events.length) {
      const r = bufs.shift()!;
      const b = new DataView(new ArrayBuffer(8));
      const [type, code, value] = events.shift()!;
      b.setUint16(0, type, true);
      b.setUint16(2, code, true);
      b.setInt32(4, value, true);
      scatter(ctx.ram(), r.write, new Uint8Array(b.buffer));
      ctx.complete(r.w0, 8);
    }
  };
  const inject = (e: number[][]) => {
    events.push(...e);
    events.splice(0, Math.max(0, events.length - INPUT_QUEUE));
    deliver();
  };
  if (d.port) d.port.onmessage = (e: MessageEvent) => inject(e.data);
  return {
    request(r) {
      if (r.queue === 0) {
        bufs.push(r);
        deliver();
        return undefined;
      }
      const b = new DataView(gather(ctx.ram(), r.read, 8).slice().buffer);
      if (b.byteLength === 8) {
        d.port?.postMessage([b.getUint16(0, true), b.getUint16(2, true), b.getInt32(4, true)]);
      }
      return 0;
    },
    config() {
      const c = ctx.config();
      const a = inputConfig(d.kind, c[0], c[1]).subarray(0, 128);
      c[2] = a.length;
      c.fill(0, 8, 136);
      c.set(a, 8);
    },
    reset() {
      bufs.length = 0;
      events.length = 0;
    },
    close: () => d.port?.close(),
  };
}

// virtio-blk request types and status (virtio 1.2 §5.2.6).
const T_IN = 0;
const T_OUT = 1;
const T_FLUSH = 4;
const T_GET_ID = 8;
const S_OK = 0;
const S_IOERR = 1;
const S_UNSUPP = 2;

/** An overlay's OPFS files: sync access handles, so the backend stays synchronous. */
type OverlayFiles = { data: FileSystemSyncAccessHandle; map: FileSystemSyncAccessHandle };

/**
 * Opens (or creates) the overlay directory `name` for the image at `url`. Its
 * `base` file records the image (URL path and size): an overlay only makes
 * sense over the bytes it was written against, so a mismatch is an error.
 */
// ponytail: the image is identified by path and size, not content; add a hash if images get replaced in place.
async function openOverlay(name: string, url: string, size: number): Promise<OverlayFiles> {
  const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle(name, { create: true });
  const open = async (f: string) => (await dir.getFileHandle(f, { create: true })).createSyncAccessHandle();
  const [data, map, base] = [await open('data'), await open('map'), await open('base')];
  const want = JSON.stringify({ path: new URL(url).pathname, size });
  if (base.getSize() === 0) {
    base.write(new TextEncoder().encode(want), { at: 0 });
    base.flush();
  }
  const got = new Uint8Array(base.getSize());
  base.read(got, { at: 0 });
  base.close();
  if (new TextDecoder().decode(got) !== want) {
    data.close();
    map.close();
    throw new Error(`overlay ${name} belongs to ${new TextDecoder().decode(got)}, not ${want}`);
  }
  return { data, map };
}

/** A disk image's bytes: synchronous range reads (`undefined` on a short or failed read). */
type Source = { size: number; read(off: number, len: number): Uint8Array | undefined; close?(): void };

/** An image over HTTP range requests: synchronous XHRs (workers only), so the device worker simply blocks on the network. */
// ponytail: one request at a time, no cache (the guest's page cache is the cache); batch or cache if an I/O benchmark says so.
function httpSource(url: string): Source {
  const xhr = (method: string, range?: string) => {
    const x = new XMLHttpRequest();
    x.open(method, url, false);
    x.responseType = 'arraybuffer';
    if (range) x.setRequestHeader('Range', range);
    x.send();
    return x;
  };
  const head = xhr('HEAD');
  if (head.status !== 200) throw new Error(`${url}: ${head.status}`);
  return {
    size: Number(head.getResponseHeader('content-length')),
    read(off, len) {
      const x = xhr('GET', `bytes=${off}-${off + len - 1}`);
      const b = x.response as ArrayBuffer | null;
      return x.status === 206 && b?.byteLength === len ? new Uint8Array(b) : undefined;
    },
  };
}

/** An image in a local file (`file:` URLs, Node only: its boots and the JIT's). */
export async function fileSource(url: string): Promise<Source> {
  const fs = await import('node:fs');
  const fd = fs.openSync(new URL(url), 'r');
  return {
    size: fs.fstatSync(fd).size,
    read(off, len) {
      const b = new Uint8Array(len);
      return fs.readSync(fd, b, 0, len, off) === len ? b : undefined;
    },
    close: () => fs.closeSync(fd),
  };
}

/**
 * virtio-blk over a `Source` (HTTP ranges, or a file in Node). Only qcow2's
 * compressed clusters are asynchronous (DecompressionStream). Read-only, or
 * writable through an overlay on OPFS.
 */
function blk(ctx: Ctx, src: Source, files?: OverlayFiles): Backend {
  const base = openDisk((off, len) => (len === 0 ? new Uint8Array(0) : src.read(off, len)), src.size);
  const rw = files && overlay(base, files.data, files.map);
  const disk: Disk = rw ?? base;
  return {
    async request(r) {
      const ram = ctx.ram();
      const last = r.write.at(-1);
      if (!last || last.len === 0) return 0; // no status byte: nothing to answer with
      // Data: every writable byte but the status byte at the end.
      const data = [...r.write.slice(0, -1), { off: last.off, len: last.len - 1 }];
      const room = data.reduce((n, s) => n + s.len, 0);
      const h = new DataView(gather(ram, r.read, 16).slice().buffer);
      let [status, n] = [S_UNSUPP, 0];
      if (h.byteLength === 16 && h.getUint32(0, true) === T_IN) {
        const bytes = await disk.read(Number(h.getBigUint64(8, true)) * 512, room);
        if (bytes) scatter(ram, data, bytes);
        [status, n] = bytes ? [S_OK, room] : [S_IOERR, 0];
      } else if (h.byteLength === 16 && h.getUint32(0, true) === T_GET_ID) {
        const id = new Uint8Array(20);
        id.set(new TextEncoder().encode('webpc-blk'));
        scatter(ram, data, id.subarray(0, room));
        [status, n] = [S_OK, Math.min(room, 20)];
      } else if (h.byteLength === 16 && h.getUint32(0, true) === T_OUT) {
        // The data follows the header in the readable buffers. Read-only: IOERR.
        const len = r.read.reduce((k, s) => k + s.len, 0);
        const ok = rw && (await rw.write(Number(h.getBigUint64(8, true)) * 512, gather(ram, r.read, len).subarray(16)).catch(() => false)); // e.g. OPFS over quota
        status = ok ? S_OK : S_IOERR;
      } else if (h.byteLength === 16 && h.getUint32(0, true) === T_FLUSH && rw) {
        rw.flush();
        status = S_OK;
      }
      ram[last.off + last.len - 1] = status;
      return n + 1;
    },
    reset() {},
    close() {
      src.close?.();
      files?.data.close();
      files?.map.close();
    },
  };
}

export type DevicesInit = {
  memory: WebAssembly.Memory;
  /** Addresses in `memory` of each device's `virtio::DevShared`, of guest RAM and of the signal word. */
  shared: number[];
  ram: number;
  signal: number;
  specs: DeviceSpec[];
  deterministic: boolean;
};

export class Devices {
  private memory: WebAssembly.Memory;
  private shared: number[];
  private signal: number;
  private backends: Backend[];
  private epochs: number[];
  /** `out` receives what a console device's guest side wrote. */
  private constructor({ memory, shared, ram, signal, specs, deterministic }: DevicesInit, overlays: (OverlayFiles | undefined)[], sources: (Source | undefined)[], out: (device: number, text: string) => void) {
    [this.memory, this.shared, this.signal] = [memory, shared, signal];
    this.backends = specs.map((d, i) => {
      const ctx: Ctx = {
        ram: () => new Uint8Array(this.memory.buffer, ram),
        complete: (w0, len) => this.complete(i, w0, len),
        config: () => new Uint8Array(this.memory.buffer, shared[i] + CONFIG, 256),
      };
      switch (d.type) {
        case 'console': return console_((t) => out(i, t), ctx);
        case 'rng': return rng(ctx, deterministic);
        case 'blk': return blk(ctx, sources[i]!, overlays[i]);
        case 'net': return net(ctx, d);
        case '9p': return p9(ctx, d.files ?? {}, deterministic);
        case 'input': return input(ctx, d);
      }
    });
    this.epochs = specs.map(() => 0);
  }

  /** Builds the backends, opening any overlays first (OPFS handles are created asynchronously). */
  static async open(init: DevicesInit, out: (device: number, text: string) => void) {
    const overlays = await Promise.all(init.specs.map((d) => (d.type === 'blk' && d.overlay ? openOverlay(d.overlay, d.url, d.size ?? 0) : undefined)));
    const sources = await Promise.all(init.specs.map((d) => (d.type !== 'blk' ? undefined : d.url.startsWith('file:') ? fileSource(d.url) : httpSource(d.url))));
    return new Devices(init, overlays, sources, out);
  }

  /** Releases the backends' files (an overlay's handles lock them). */
  close() {
    for (const b of this.backends) b.close?.();
  }

  /** Writes each device's initial config space (after vm_new, before the guest runs). */
  static writeConfig(memory: WebAssembly.Memory, shared: number[], specs: DeviceSpec[]) {
    specs.forEach((d, i) => new Uint8Array(memory.buffer).set(deviceEntry(d).config, shared[i] + CONFIG));
  }

  /**
   * Takes every device's events and requests, completing what can be completed
   * now; resolves once the asynchronous ones completed too (in order). Without
   * those it all happens before it returns.
   */
  async poll() {
    for (const [i, b] of this.backends.entries()) {
      const u32 = new Uint32Array(this.memory.buffer);
      const base = this.shared[i] / 4;
      const events = Atomics.exchange(u32, base + EVENTS / 4, 0);
      if (events & EV_CONFIG) b.config?.();
      const epoch = Atomics.load(u32, base + EPOCH / 4) & 0xff;
      if (epoch !== this.epochs[i]) {
        b.reset();
        this.epochs[i] = epoch;
      }
      const ring = base + REQ / 4;
      let tail = u32[ring + 1];
      const head = Atomics.load(u32, ring);
      const word = () => u32[ring + 2 + (tail++ % RING_WORDS)];
      while (tail !== head) {
        const w0 = word();
        const n = word();
        const segs = (k: number) => Array.from({ length: k }, () => ({ off: word(), len: word() }));
        const r = { w0, queue: (w0 >>> 16) & 0xff, read: segs(n & 0xffff), write: segs(n >>> 16) };
        tail >>>= 0;
        Atomics.store(u32, ring + 1, tail);
        if (w0 >>> 24 !== epoch) continue; // posted before a reset
        const len = b.request(r);
        if (len !== undefined) this.complete(i, w0, typeof len === 'number' ? len : await len);
      }
    }
  }

  private complete(i: number, w0: number, len: number) {
    const u32 = new Uint32Array(this.memory.buffer);
    const ring = (this.shared[i] + CPL) / 4;
    const head = u32[ring];
    if (RING_WORDS - ((head - Atomics.load(u32, ring + 1)) >>> 0) < 2) throw new Error('completion ring full'); // the core sizes it for every buffer in flight
    u32[ring + 2 + (head % RING_WORDS)] = w0;
    u32[ring + 2 + ((head + 1) % RING_WORDS)] = len;
    Atomics.store(u32, ring, (head + 2) >>> 0);
    const sig = new Int32Array(this.memory.buffer, this.signal, 1);
    Atomics.or(sig, 0, SIGNAL_DEVICE);
    Atomics.notify(sig, 0);
  }
}
