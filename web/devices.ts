// virtio device backends (docs/devices.md). The core runs
// the virtio-mmio transports and split queues and posts each descriptor chain
// to the device's request ring as RAM segments; backends here only speak the
// device protocol. `Devices` works on the shared memory from any thread: in the
// device worker (web/device-worker.ts) or inline on the vCPU thread.
import { p9, type P9Files } from './9p.ts';
import { echoBackend, gateway, portBackend } from './gateway.ts';
import { gpuBackend, type GpuOptions } from './gpu.ts';
import { canvasPresenter, pagePresenter, type DisplayFromPage } from './gpu-present.ts';
import { portHost } from './virgl-host.ts';
import { loopback, portAdapter, type NetAdapter } from './net.ts';
import { IoStats } from './iostats.ts';
import { openOverlay, overlay, type OverlayFiles, type WritableDisk } from './overlay.ts';
import { ramDisk } from './ramdisk.ts';
import { openStored, openStoredForWriting } from './stored.ts';
import { openDisk, type Disk } from './qcow2.ts';
import { checksumSink, micSource, patternSource, ringSink, sndBackend, type SndWake } from './snd.ts';

/**
 * Host-side device configuration, one per virtio-mmio slot (in order). `blk`
 * is a read-only disk image (raw or qcow2, web/qcow2.ts) read with HTTP range
 * requests; `size` (its virtual size in bytes, a multiple of 512) is filled in
 * by `bootVm` from the file's first bytes if missing. With `overlay` (an OPFS
 * directory name) the disk is writable: writes go to a copy-on-write overlay
 * there (web/overlay.ts), which persists across boots and belongs to that image. With `file` (a
 * `File` the user chose, structured-cloned to the device worker) the disk is that file instead of
 * `url`, read with `FileReaderSync` (workers only); the overlay then belongs to the file's name,
 * size and modification time (`diskIdentity`). With `discard` (and an overlay) the disk takes
 * DISCARD and WRITE_ZEROES: what the guest trims leaves the overlay (the page's machines; the
 * tests' guests are without it, as their step counts are). `source` is a disk with no image (docs/plans/machines.md
 * §4.2, `size` given): `zero`, a blank disk that reads as zeros (writable through its overlay), or `ram`, a ramdisk
 * (web/ramdisk.ts: writable in itself, empty at every start, with DISCARD). `serial` is what GET_ID answers (default
 * `webpc-blk`); `identity` replaces `diskIdentity`'s for the overlay's check (a machine's disk record says it). `stored`
 * is a disk kept in the browser (web/stored.ts: its OPFS directory, `disks/<id>`, read under its overlay; `size` given);
 * written in place, the disk is instead its own overlay (`overlay` `disks/<id>` over a `zero` source).
 */
export type DeviceSpec =
  | { type: 'console' }
  | { type: 'rng' }
  | BlkSpec
  | NetSpec
  | P9Spec
  | InputSpec
  | GpuSpec
  | SndSpec;

export type BlkSpec = { type: 'blk'; url?: string; source?: 'zero' | 'ram'; stored?: string; size?: number; overlay?: string; file?: Blob; discard?: boolean; stats?: boolean; serial?: string; identity?: string };

/** Whether a disk takes the guest's writes: through an overlay, or a ramdisk. */
export const writable = (d: BlkSpec) => !!d.overlay || d.source === 'ram';

/**
 * virtio-net (web/net.ts): Ethernet frames to and from an adapter: the
 * loopback test adapter in the device worker, a page's frame adapter behind a
 * MessagePort, or the Ethernet gateway (web/gateway.ts) in front of an IP
 * backend: `'echo'` (a synchronous test backend) or `{ip: port}` (a layer-3
 * backend, such as Tailscale, behind a MessagePort). `mac` defaults to
 * 52:54:00:12:34:56; the link is always up.
 */
export type NetSpec = { type: 'net'; mac?: string; adapter: 'loopback' | 'echo' | MessagePort | { ip: MessagePort } };
/** virtio-9p (web/9p.ts): an in-memory tree, mounted by the guest by `tag`, starting with `files` (path → contents). */
export type P9Spec = { type: '9p'; tag: string; files?: P9Files };
/**
 * virtio-input: a keyboard or a tablet (absolute pointer, 0–32767 on both
 * axes). Events for the guest come from `port` as arrays of [type, code,
 * value] (Linux input-event-codes; web/input.ts makes them from DOM events);
 * the guest's status events (LEDs) go to it as one [type, code, value] each.
 */
export type InputSpec = { type: 'input'; kind: 'keyboard' | 'tablet'; port?: MessagePort };

/**
 * virtio-gpu, 2D and, with `virgl`, 3D (web/gpu.ts; rendered by `renderer`, or on a null renderer without one): the display's size, the EDID's DPI, and a test hook that changes the
 * size after some flushes. Where the pixels go is the page's business (`GpuHooks`).
 */
export type GpuSpec = {
  type: 'gpu';
  /** The page's screen (a worker's `OffscreenCanvas`, transferred): the scanout is drawn on it (web/gpu-present.ts). */
  canvas?: OffscreenCanvas;
  /** The page's end of the display: the backend says `mode` (the scanout's size) and takes `size` (the page's, for the display info and the EDID). */
  port?: MessagePort;
  /** Report flush-to-draw latencies on the port once a second (bench/gpu). */
  stats?: boolean;
  /** Post `flash` on the port when a draw turns the screen's centre bright (`?avprobe`: A/V sync, bench/audio/avsync.ts); 2D screens (a 3D machine's GPU worker probes its own). */
  probe?: boolean;
  /**
   * A 3D machine's GPU worker (web/gpu-worker.ts): the device's 3D work and its scanouts go there (web/virgl-host.ts),
   * and `canvas` is unused (the GPU worker has the screen). With `virgl`.
   */
  renderer?: MessagePort;
  /** Post a trace of the guest's 3D commands on the port (`{ type: 'capture', record }`, web/virgl-trace.ts): the renderer's fixtures. */
  capture?: boolean;
  /** The queues' size (a power of 2, default 64). A small one is back-pressure: with replies paced to the frame, a guest that floods the display waits for room instead of burning its CPU on commits. */
  queueSize?: number;
} & GpuOptions;

/**
 * virtio-snd (web/snd.ts): an output and an input stream, no jacks or channel maps. In deterministic mode the
 * output's frames go to the checksum sink and the input's come from the pattern source (each message completes at
 * the DEVICE exit that posted it); in realtime mode the output goes to the ring sink: the page's sound ring (`ring`,
 * played by web/audio.ts's worklet, which says on `port` when a stream starts and stops), or without one a ring of
 * its own played on the sink's own clock; the input records from the page's microphone ring (`mic`, filled while the
 * page has the microphone: it opens it at the input's start), else silence on its own clock (docs/audio.md).
 */
export type SndSpec = {
  type: 'snd';
  /** The page's sound ring (web/audio-ring.ts). */
  ring?: SharedArrayBuffer;
  /** The page's microphone ring (the same layout, filled by web/audio.ts's `webpc-mic` worklet). */
  mic?: SharedArrayBuffer;
  /** The page's end: the streams' starts (their rates) and stops, and with `stats` the completions' timing once a second. */
  port?: MessagePort;
  /** What wakes the sink to complete played messages (default the worklet's notify): measurements. */
  wake?: SndWake;
  stats?: boolean;
};

/** The MessagePorts and canvases in `specs`, to transfer with them. */
export const specPorts = (specs: DeviceSpec[]): Transferable[] =>
  specs.flatMap((d) => (d.type === 'net' && typeof d.adapter !== 'string' ? [d.adapter instanceof MessagePort ? d.adapter : d.adapter.ip] : (d.type === 'input' || d.type === 'snd') && d.port ? [d.port] : d.type === 'gpu' ? [...(d.canvas ? [d.canvas] : []), ...(d.port ? [d.port] : []), ...(d.renderer ? [d.renderer] : [])] : []));

// virtio::DevShared layout (core/src/virtio.rs).
const EVENTS = 0;
const EPOCH = 16;
const CONFIG_GEN = 20;
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
      // With `discard`: DISCARD (13) and WRITE_ZEROES (14), and the config goes on to 60 bytes:
      // max_discard_sectors (u32 at 36), max_discard_seg, discard_sector_alignment (the overlay's
      // 4 KiB blocks: Linux's discard granularity), max_write_zeroes_sectors, max_write_zeroes_seg,
      // write_zeroes_may_unmap (u8 at 56).
      const discard = (!!d.overlay && !!d.discard) || d.source === 'ram';
      const config = new Uint8Array(discard ? 60 : 16);
      const v = new DataView(config.buffer);
      v.setBigUint64(0, BigInt(Math.floor((d.size ?? 0) / 512)), true);
      v.setUint32(12, 126, true);
      if (discard) {
        v.setUint32(36, BLK_MAX_UNMAP_SECTORS, true);
        v.setUint32(40, 1, true);
        v.setUint32(44, 8, true);
        v.setUint32(48, BLK_MAX_UNMAP_SECTORS, true);
        v.setUint32(52, 1, true);
        v.setUint8(56, 1);
      }
      return { entry: [2n, 1n << 2n | (writable(d) ? 1n << 9n : 1n << 5n) | (discard ? 1n << 13n | 1n << 14n : 0n), 1n, 128n, BigInt(config.length)], config };
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
    // Feature EDID (1); controlq and cursorq; config: events_read, events_clear, num_scanouts = 1, num_capsets = 0.
    case 'gpu': {
      // Features EDID (1) and, with `virgl`, VIRGL (0); config: num_scanouts (u32 at 8), num_capsets (at 12: VIRGL, VIRGL2).
      const config = new Uint8Array(16);
      new DataView(config.buffer).setUint32(8, 1, true);
      if (d.virgl) new DataView(config.buffer).setUint32(12, 2, true);
      return { entry: [16n, d.virgl ? 3n : 1n << 1n, 2n, BigInt(d.queueSize ?? 64), 16n], config };
    }
    // No features; controlq, eventq, txq, rxq; config: jacks 0, streams 1, chmaps 0.
    case 'snd': return { entry: [25n, 0n, 4n, 64n, 12n], config: new Uint8Array([0, 0, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0]) }; // jacks 0, streams 2 (out, in), chmaps 0
  }
}

export type Segment = { off: number; len: number };
export type Request = { w0: number; queue: number; read: Segment[]; write: Segment[] };
export type Ctx = {
  ram: () => Uint8Array; ramSize: number; complete: (w0: number, len: number) => void; config: () => Uint8Array;
  /** Completions given (`complete`) that the core hasn't taken yet: it takes them when a vCPU runs. */
  untaken: () => number;
  /** Changes the config space under a running driver (docs/abi.md, ABI 31): `write` gets it, and the guest gets a config-change interrupt. */
  changeConfig: (write: (config: Uint8Array) => void) => void;
};

/**
 * A backend handles a request now (returns bytes written, or a promise of
 * them: requests complete in order either way), or keeps it and completes it
 * later. `config` runs when the guest wrote the config space.
 */
type Backend = {
  request(r: Request): number | Promise<number> | undefined; reset(): void; close?(): void; config?(): void;
  /** Runs after the device's requests of a DEVICE exit were taken (every exit, even without any): virtio-snd's deterministic sink completes there. */
  polled?(): void;
  /**
   * A snapshot (docs/plans/snapshots.md): what the backend must keep besides the requests it holds,
   * as JSON, and the same given to a new backend. The core posts held requests to a restored VM's
   * backends again, so one that only holds buffers has neither.
   */
  save?(): unknown; restore?(state: unknown): void;
  /** A writable disk's changes, for a snapshot: the blocks (4 KiB) its overlay holds, and their bytes. */
  written?(): number[]; blocks?(blocks: number[]): Uint8Array;
};

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
  // splitmix64 seeded 0 (tools/corpus/corpus.ts has the generator), a byte at a time; its
  // position is the backend's state.
  const M64 = (1n << 64n) - 1n;
  let s = 0n;
  let word = 0n;
  let left = 0;
  const byte = () => {
    if (left === 0) {
      s = (s + 0x9e3779b97f4a7c15n) & M64;
      let z = s;
      z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & M64;
      z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & M64;
      [word, left] = [z ^ (z >> 31n), 8];
    }
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
    save: () => ({ s: s.toString(16), word: word.toString(16), left }),
    restore(state) {
      const t = state as { s: string; word: string; left: number };
      if (typeof t?.s !== 'string' || typeof t.word !== 'string' || !(t.left >= 0 && t.left <= 8)) throw new Error('the snapshot has no state for the random number device');
      [s, word, left] = [BigInt(`0x${t.s}`) & M64, BigInt(`0x${t.word}`) & M64, t.left];
    },
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
  const a = d.adapter;
  const adapter: NetAdapter =
    a === 'loopback' ? loopback(receive)
    : a === 'echo' ? gateway(receive, echoBackend())
    : a instanceof MessagePort ? portAdapter(a, receive)
    : gateway(receive, portBackend(a.ip), { advertiseMs: 60_000 });
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
const T_DISCARD = 11;
const T_WRITE_ZEROES = 13;
/** The most sectors one DISCARD or WRITE_ZEROES segment covers (2 GiB, whole 4 KiB blocks). */
const BLK_MAX_UNMAP_SECTORS = 1 << 22;
const S_OK = 0;
const S_IOERR = 1;
const S_UNSUPP = 2;

/** A disk image's bytes: synchronous range reads (`undefined` on a short or failed read). */
export type Source = { size: number; read(off: number, len: number): Uint8Array | undefined; close?(): void };

/** An image over HTTP range requests: synchronous XHRs (workers only), so the device worker simply blocks on the network. */
// ponytail: one request at a time, no cache (the guest's page cache is the cache); batch or cache if an I/O benchmark says so.
export function httpSource(url: string): Source {
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

/** An image the user chose (a `File`): `FileReaderSync`'s synchronous slices, so workers only. */
export function blobSource(file: Blob): Source {
  const reader = new FileReaderSync();
  return {
    size: file.size,
    read(off, len) {
      if (off + len > file.size) return undefined;
      try {
        const b = reader.readAsArrayBuffer(file.slice(off, off + len));
        return b.byteLength === len ? new Uint8Array(b) : undefined;
      } catch {
        return undefined; // the file changed or went away under us
      }
    },
  };
}

/**
 * What an overlay over `d`'s image belongs to (web/overlay.ts `openOverlay`): the spec's `identity` where the page gave
 * one (a machine's disk record), else the URL's path, or a chosen file's name, size and modification time, or the
 * source (a blank disk); and the virtual size.
 */
export const diskIdentity = (d: { url?: string; file?: Blob; source?: string; identity?: string }, size: number) =>
  d.identity ?? JSON.stringify(d.file ? { file: (d.file as File).name, bytes: d.file.size, modified: (d.file as File).lastModified, size } : d.url ? { path: new URL(d.url, 'http://x').pathname, size } : { source: d.source, size });

/** A blank disk's bytes: zeros. */
export const zeroSource = (size: number): Source => ({ size, read: (off, len) => (off >= 0 && off + len <= size ? new Uint8Array(len) : undefined) });

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
 * writable through an overlay on OPFS; with `discard`, DISCARD and WRITE_ZEROES
 * reach the overlay (`deviceEntry` offers them).
 */
export function blk(ctx: Ctx, src: Source | WritableDisk, files?: OverlayFiles, discard = false, st?: IoStats, serial = 'webpc-blk'): Backend {
  let rw: WritableDisk | undefined;
  let base: Disk;
  if ('write' in src) {
    base = rw = src; // a disk that takes writes in itself (a ramdisk)
  } else {
    if (st) {
      const read = src.read;
      src = { ...src, read: (off, len) => st.time('base.read', len, () => read(off, len)) };
      if (files) files = { ...files, data: st.file('data', files.data), map: st.file('map', files.map) };
    }
    const s = src;
    base = openDisk((off, len) => (len === 0 ? new Uint8Array(0) : s.read(off, len)), s.size);
    rw = files && overlay(base, files.data, files.map, files.meta);
  }
  const disk: Disk = rw ?? base;
  const backend: Backend = {
    async request(r) {
      const ram = ctx.ram();
      const last = r.write.at(-1);
      if (!last || last.len === 0) return 0; // no status byte: nothing to answer with
      // Data: every writable byte but the status byte at the end.
      const data = [...r.write.slice(0, -1), { off: last.off, len: last.len - 1 }];
      const room = data.reduce((n, s) => n + s.len, 0);
      const h = new DataView(gather(ram, r.read, 16).slice().buffer);
      const op = h.byteLength === 16 ? h.getUint32(0, true) : -1;
      if (st) st.size(({ 0: 'read', 1: 'write', 4: 'flush' } as Record<number, string>)[op] ?? `op${op}`, op === T_OUT ? r.read.reduce((k, x) => k + x.len, 0) - 16 : room);
      let [status, n] = [S_UNSUPP, 0];
      if (h.byteLength === 16 && h.getUint32(0, true) === T_IN) {
        const bytes = await disk.read(Number(h.getBigUint64(8, true)) * 512, room);
        if (bytes) st ? st.time('scatter', bytes.length, () => scatter(ram, data, bytes)) : scatter(ram, data, bytes);
        [status, n] = bytes ? [S_OK, room] : [S_IOERR, 0];
      } else if (h.byteLength === 16 && h.getUint32(0, true) === T_GET_ID) {
        const id = new Uint8Array(20);
        id.set(new TextEncoder().encode(serial).subarray(0, 20));
        scatter(ram, data, id.subarray(0, room));
        [status, n] = [S_OK, Math.min(room, 20)];
      } else if (h.byteLength === 16 && h.getUint32(0, true) === T_OUT) {
        // The data follows the header in the readable buffers. Read-only: IOERR.
        const len = r.read.reduce((k, s) => k + s.len, 0);
        const payload = st ? st.time('gather', len, () => gather(ram, r.read, len)) : gather(ram, r.read, len);
        const ok = rw && (await rw.write(Number(h.getBigUint64(8, true)) * 512, payload.subarray(16)).catch(() => false)); // e.g. OPFS over quota
        status = ok ? S_OK : S_IOERR;
      } else if (h.byteLength === 16 && h.getUint32(0, true) === T_FLUSH && rw) {
        st ? st.time('flush', 0, () => rw.flush()) : rw.flush();
        status = S_OK;
      } else if (h.byteLength === 16 && (h.getUint32(0, true) === T_DISCARD || h.getUint32(0, true) === T_WRITE_ZEROES) && rw && discard) {
        // One segment after the header (max_*_seg is 1): sector (u64), sectors (u32), flags (u32; bit 0: unmap,
        // which a WRITE_ZEROES may set and we always do, and a DISCARD must not: UNSUPP, as for unknown flags).
        const zeroes = h.getUint32(0, true) === T_WRITE_ZEROES;
        const len = r.read.reduce((k, s) => k + s.len, 0);
        const seg = new DataView(gather(ram, r.read, len).slice(16).buffer);
        if (seg.byteLength !== 16) status = S_IOERR;
        else if (seg.getUint32(12, true) & (zeroes ? ~1 : ~0)) status = S_UNSUPP;
        else {
          const [off, bytes] = [Number(seg.getBigUint64(0, true)) * 512, seg.getUint32(8, true) * 512];
          const ok = bytes <= BLK_MAX_UNMAP_SECTORS * 512 && off + bytes <= disk.size && (zeroes ? await rw.zero(off, bytes).catch(() => false) : rw.discard(off, bytes));
          status = ok ? S_OK : S_IOERR;
        }
      }
      ram[last.off + last.len - 1] = status;
      return n + 1;
    },
    reset() {},
    written: rw && (() => rw.written()),
    blocks: rw && ((blocks) => {
      const out = new Uint8Array(blocks.length * 4096);
      blocks.forEach((b, k) => {
        const bytes = rw.block(b);
        if (!bytes) throw new Error(`the disk's changes can't be read from the browser's storage (block ${b})`);
        out.set(bytes, k * 4096);
      });
      return out;
    }),
    close() {
      if (!('write' in src)) src.close?.();
      files?.close();
    },
  };
  if (st) {
    const request = backend.request;
    backend.request = async (r) => {
      const t = performance.now();
      const n = (await request.call(backend, r)) as number;
      st.add('request', 0, performance.now() - t);
      return n;
    };
  }
  return backend;
}

/** Rings the doorbell; with `wait`, returns once the backends took everything up to this ring. */
export function ring(bell: Int32Array, wait: boolean) {
  const n = Atomics.add(bell, 0, 1) + 1;
  Atomics.notify(bell, 0);
  if (!wait) return;
  // Other threads ring too: the backends may have handled past `n` (wrapping compare).
  for (let a; ((a = Atomics.load(bell, 1)) - n | 0) < 0;) {
    if (a === -1) throw new Error('device backends failed (see their error)');
    Atomics.wait(bell, 1, a, 1000);
  }
}

export type DevicesInit = {
  memory: WebAssembly.Memory;
  /** Addresses in `memory` of each device's `virtio::DevShared`, of guest RAM and of the signal word. */
  shared: number[];
  ram: number;
  ramSize: number;
  signal: number;
  specs: DeviceSpec[];
  deterministic: boolean;
  /** Parallel SMP: each vCPU's wake word (`vm_cpu_signal`), bumped and notified after the signal word (docs/abi.md). */
  wakes?: number[];
  /** A VM restored from a snapshot: each backend's saved state (`Devices.save`), null where it had none. */
  state?: unknown[];
};

export class Devices {
  private memory: WebAssembly.Memory;
  private shared: number[];
  private signal: number;
  private wakes: number[];
  private backends: Backend[];
  private epochs: number[];
  /** Set by `close`: `serve` returns. */
  private closed = false;
  /** The timers of the blk devices with `stats` (web/iostats.ts), by device. */
  private ioStats: Record<number, IoStats> = {};
  private served?: Int32Array;
  /** `out` receives what a console device's guest side wrote. */
  private constructor({ memory, shared, ram, ramSize, signal, specs, deterministic, wakes, state }: DevicesInit, overlays: (OverlayFiles | undefined)[], sources: (Source | WritableDisk | undefined)[], out: (device: number, text: string) => void) {
    [this.memory, this.shared, this.signal, this.wakes] = [memory, shared, signal, wakes ?? []];
    this.backends = specs.map((d, i) => {
      const ctx: Ctx = {
        ram: () => new Uint8Array(this.memory.buffer, ram),
        ramSize,
        complete: (w0, len) => this.complete(i, w0, len),
        untaken: () => this.untaken(i),
        config: () => new Uint8Array(this.memory.buffer, shared[i] + CONFIG, 256),
        changeConfig: (write) => this.changeConfig(i, write),
      };
      switch (d.type) {
        case 'console': return console_((t) => out(i, t), ctx);
        case 'rng': return rng(ctx, deterministic);
        case 'blk': {
          const st = d.stats ? (this.ioStats[i] = new IoStats()) : undefined;
          return blk(ctx, sources[i]!, overlays[i], d.discard || d.source === 'ram', st, d.serial);
        }
        case 'net': return net(ctx, d);
        case '9p': return p9(ctx, d.files ?? {}, deterministic);
        case 'input': return input(ctx, d);
        case 'gpu': {
          const b = gpuBackend(ctx, d, d.renderer ? pagePresenter(d.port, d.stats) : d.canvas ? canvasPresenter(d.canvas, d.port, d.stats, d.probe) : {});
          if (d.renderer && d.virgl) {
            // The GPU worker reads and writes guest RAM in place: it gets the shared memory first.
            const host = portHost(d.renderer);
            const ram = ctx.ram();
            host.call({ t: 'ram', buffer: ram.buffer, offset: ram.byteOffset, length: Math.min(ram.length, ctx.ramSize) });
            b.gpu.host = host;
          }
          if (d.port) d.port.onmessage = (e: MessageEvent<DisplayFromPage>) => { if (e.data?.type === 'size') b.gpu.setSize(e.data.width, e.data.height); };
          if (d.capture && d.port) b.gpu.onCapture = (record) => d.port!.postMessage({ type: 'capture', record }, [record.buffer]);
          return b;
        }
        case 'snd': return deterministic ? sndBackend(ctx, checksumSink(), patternSource()) : sndBackend(ctx, ringSink({ ring: d.ring, port: d.port, wake: d.wake, stats: d.stats, untaken: () => ctx.untaken() }), micSource({ ring: d.mic, port: d.port, untaken: () => ctx.untaken() }));
      }
    });
    this.epochs = specs.map(() => 0);
    if (state) {
      if (state.length !== specs.length) throw new Error('the snapshot is of a machine with other devices');
      // The devices are as the snapshot left them (their epoch is not a reset), with the backends' state.
      const u32 = new Uint32Array(memory.buffer);
      this.epochs = shared.map((at) => Atomics.load(u32, (at + EPOCH) / 4) & 0xff);
      this.backends.forEach((b, i) => { if (state[i] !== null && state[i] !== undefined) b.restore?.(state[i]); });
    }
  }

  /** Device `i`'s changed blocks (4 KiB each, ascending) if it is a disk with an overlay, for a snapshot. */
  written(i: number): number[] | undefined {
    return this.backends[i]?.written?.();
  }

  /** The bytes of `blocks` (some of `written(i)`), one after the other. */
  blocks(i: number, blocks: number[]): Uint8Array {
    return this.backends[i].blocks!(blocks);
  }

  /** Each backend's state for a snapshot (null: none), with the devices quiet (`poll` resolved). */
  save(): unknown[] {
    return this.backends.map((b) => b.save?.() ?? null);
  }

  /** Builds the backends, opening any overlays first (OPFS handles are created asynchronously). */
  static async open(init: DevicesInit, out: (device: number, text: string) => void) {
    // A stored disk written in place is opened as its store is for any writer: an interrupted merge is finished first.
    const overlays = await Promise.all(init.specs.map((d) => (d.type !== 'blk' || !d.overlay ? undefined : d.overlay.startsWith('disks/') ? openStoredForWriting(d.overlay, diskIdentity(d, d.size ?? 0), d.size ?? 0) : openOverlay(d.overlay, diskIdentity(d, d.size ?? 0)))));
    const sources = await Promise.all(init.specs.map((d) => {
      if (d.type !== 'blk') return undefined;
      if (d.source) {
        if (!d.size) throw new Error(`a ${d.source === 'ram' ? 'ramdisk' : 'blank disk'} needs a size`);
        return d.source === 'ram' ? ramDisk(d.size) : zeroSource(d.size);
      }
      if (d.stored) return openStored(d.stored, d.size ?? 0);
      if (d.file) return blobSource(d.file);
      if (!d.url) throw new Error('a disk with no image (url, file or source)');
      return d.url.startsWith('file:') ? fileSource(d.url) : httpSource(d.url);
    }));
    return new Devices(init, overlays, sources, out);
  }

  /** The I/O timers of the blk devices that have them (spec `stats`), by device index. */
  stats() {
    return Object.fromEntries(Object.entries(this.ioStats).map(([i, st]) => [i, st.json()]));
  }

  /** Releases the backends' files (an overlay's handles lock them). */
  close() {
    for (const b of this.backends) b.close?.();
    // End `serve`: its pending Atomics.waitAsync would otherwise keep the VM's memory alive for
    // good (Node's parallel runs, where the backends share the VM's thread: ~10 MB a boot).
    this.closed = true;
    if (this.served) Atomics.notify(this.served, 0);
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
      b.polled?.();
    }
  }

  private untaken(i: number) {
    const u32 = new Uint32Array(this.memory.buffer);
    const ring = (this.shared[i] + CPL) / 4;
    return ((Atomics.load(u32, ring) - Atomics.load(u32, ring + 1)) >>> 0) / 2;
  }

  private complete(i: number, w0: number, len: number) {
    const u32 = new Uint32Array(this.memory.buffer);
    const ring = (this.shared[i] + CPL) / 4;
    const head = u32[ring];
    if (RING_WORDS - ((head - Atomics.load(u32, ring + 1)) >>> 0) < 2) throw new Error('completion ring full'); // the core sizes it for every buffer in flight
    u32[ring + 2 + (head % RING_WORDS)] = w0;
    u32[ring + 2 + ((head + 1) % RING_WORDS)] = len;
    Atomics.store(u32, ring, (head + 2) >>> 0);
    this.kick();
  }

  /** Sets the signal word's device bit and wakes the vCPUs, so the core takes what the backends left. */
  private kick() {
    const sig = new Int32Array(this.memory.buffer, this.signal, 1);
    Atomics.or(sig, 0, SIGNAL_DEVICE);
    Atomics.notify(sig, 0);
    for (const w of this.wakes) {
      const word = new Int32Array(this.memory.buffer, w, 1);
      Atomics.add(word, 0, 1);
      Atomics.notify(word, 0);
    }
  }

  /**
   * Changes device `i`'s config space under a running driver (docs/abi.md "config changes"): the
   * generation goes odd, `write` changes the bytes, it goes even, and the core raises the
   * config-change interrupt when it takes the signal.
   */
  changeConfig(i: number, write: (config: Uint8Array) => void) {
    const gen = new Int32Array(this.memory.buffer, this.shared[i] + CONFIG_GEN, 1);
    Atomics.add(gen, 0, 1);
    write(new Uint8Array(this.memory.buffer, this.shared[i] + CONFIG, 256));
    Atomics.add(gen, 0, 1);
    this.kick();
  }

  /**
   * Serves the doorbell (docs/devices.md): whenever a vCPU bumps word 0, takes
   * every device's events and requests, then writes the value it handled to
   * word 1 (-1 if a backend threw, and the error propagates). Returns once
   * `close` was called.
   */
  async serve(bell: Int32Array) {
    this.served = bell;
    // A guest that rings continuously (tty1 scrolling: hundreds of flushes a second) keeps this loop on microtasks only
    // (`waitAsync` on a changed word returns at once): timers and the ports' messages (a key's release, the page's size)
    // starve behind it, for up to a second. Yield to the event loop every few ms of work.
    const turn = new MessageChannel();
    const macrotask = () => new Promise<void>((resolve) => { turn.port1.onmessage = () => resolve(); turn.port2.postMessage(0); });
    let since = performance.now();
    for (let seen = 0; !this.closed;) {
      if (performance.now() - since > 2) {
        await macrotask();
        since = performance.now();
      }
      const rung = Atomics.load(bell, 0);
      if (rung === seen) {
        const w = Atomics.waitAsync(bell, 0, seen);
        if (w.async) await w.value;
        continue;
      }
      seen = rung;
      try {
        await this.poll();
      } catch (e) {
        Atomics.store(bell, 1, -1);
        Atomics.notify(bell, 1);
        throw e;
      }
      Atomics.store(bell, 1, seen);
      Atomics.notify(bell, 1);
    }
    turn.port1.close();
  }
}
