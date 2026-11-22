// virtio device backends (docs/devices.md). The core runs
// the virtio-mmio transports and split queues and posts each descriptor chain
// to the device's request ring as RAM segments; backends here only speak the
// device protocol. `Devices` works on the shared memory from any thread: in the
// device worker (web/device-worker.ts) or inline on the vCPU thread.
// What a backend is and the shared layout are web/virtio.ts; blk, net and input are their own modules
// (web/blk-device.ts, web/net-device.ts, web/input-device.ts), the disks' sources web/disk-sources.ts.
import { msg, type Msg, type WireError } from './msg.ts';
import { browserClock, clockAnswer, CLOCK_ID } from './clock.ts';
import { balloon, balloonEntry, type Balloon } from './balloon.ts';
import { vsockDevice, vsockEntry, type VsockSpec } from './vsock-device.ts';
import { p9, type P9Files } from './9p.ts';
import { folders9p, type FolderSpec } from './9p-folders.ts';
import type { GpuOptions } from './gpu.ts';
import { gpuBackend } from './gpu-backend.ts';
import { canvasPresenter, pagePresenter, type DisplayFromPage, type Screen2d, type ScreenPng } from './gpu-present.ts';
import { portHost } from './virgl-host.ts';
import { OFFLOADS } from './offload.ts';
import { IoStats } from './iostats.ts';
import type { BlockCacheStats } from './blockcache.ts';
import { openOverlay, storageNumbers, type OverlayFiles, type WritableDisk } from './overlay.ts';
import type { InspectAnswer, InspectQuery } from './surface.ts';
import { ramDisk, swapHeader } from './ramdisk.ts';
import { openStored, openStoredForWriting } from './stored.ts';
import { coreModule } from './deflate.ts';
import { Usb, type UsbAttach } from './usb.ts';
import { sndBackend } from './snd.ts';
import type { SndMixer } from './snd-proto.ts';
import { micSource, ringSink, type SndWake } from './snd-realtime.ts';
import { checksumSink, patternSource } from './snd-test.ts';
import { bytes, ramLayout, type RamLayout } from './ram.ts';
import {
  CONFIG,
  CONFIG_GEN,
  CPL,
  EPOCH,
  EV_CONFIG,
  EVENTS,
  FEATURES,
  gather,
  REQ,
  RING_WORDS,
  scatter,
  SIGNAL_DEVICE,
  type Backend,
  type Ctx,
  type Request,
} from './virtio.ts';
import { net } from './net-device.ts';
import { input } from './input-device.ts';
import { blk, BLK_MAX_UNMAP_SECTORS } from './blk-device.ts';
import { blobSource, fileSource, remoteSource, zeroSource, type Source } from './disk-sources.ts';

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
 * tests' guests are without it, as their step counts are). `source` is a disk with no image (docs/machines.md
 * §4.2, `size` given): `zero`, a blank disk that reads as zeros (writable through its overlay), or `ram`, a ramdisk
 * (web/ramdisk.ts: writable in itself, empty at every start, with DISCARD; with `swap`, a swap area labelled so at
 * every start: `swapHeader`). `serial` is what GET_ID answers (default
 * `waarm64-blk`); `identity` replaces `diskIdentity`'s for the overlay's check (a machine's disk record says it). `stored`
 * is a disk kept in the browser (web/stored.ts: its OPFS directory, `disks/<id>`, read under its overlay; `size` given);
 * a `size` larger than the image's (a grown overlay, docs/machines.md §4.5) is what the guest sees, the image read as
 * zeros past its end, and `diskSize` is then a stored or blank disk's own size (what its surface draws as the disk:
 * web/surface.ts; nothing the guest sees or any I/O goes by it);
 * written in place, the disk is instead its own overlay (`overlay` `disks/<id>` over a `zero` source). A `url` disk is
 * read through a block cache whose blocks are kept in OPFS (web/diskcache.ts) unless `keep` is false.
 */
export type DeviceSpec =
  | { type: 'console' }
  | { type: 'rng' }
  | BlkSpec
  | NetSpec
  | P9Spec
  | InputSpec
  | GpuSpec
  | SndSpec
  | { type: 'clock' }
  | { type: 'balloon' }
  | VsockSpec;

export type BlkSpec = {
  type: 'blk';
  url?: string;
  chunked?: string;
  keep?: boolean;
  source?: 'zero' | 'ram';
  stored?: string;
  size?: number;
  overlay?: string;
  file?: Blob;
  discard?: boolean;
  stats?: boolean;
  serial?: string;
  identity?: string;
  diskSize?: number;
  ramInit?: [number, Uint8Array][];
  swap?: string;
};

/**
 * What the page says when a disk's write found the browser's storage full (docs/machines.md "Storage"), with the storage's
 * numbers where the browser gives them (as the Home page's storage line has them).
 */
export async function storageFull(): Promise<Msg> {
  const n = await storageNumbers();
  return n
    ? msg('disks:devices.storageFull.numbers', { used: n.used, quota: n.quota })
    : msg('disks:devices.storageFull');
}

/** Whether `m` is `storageFull`'s (the page then has the guest trim: web/app/areas/trim-actions.ts `full`). */
export const isStorageFull = (m: Msg) =>
  m.key === 'disks:devices.storageFull' || m.key === 'disks:devices.storageFull.numbers';

/** How often the page is told at most that the storage is full. */
const FULL_REPEAT_MS = 60_000;

/** Whether a disk takes the guest's writes: through an overlay, or a ramdisk. */
export const writable = (d: BlkSpec) => !!d.overlay || d.source === 'ram';

/**
 * virtio-net (web/net.ts): Ethernet frames to and from an adapter: the
 * loopback test adapter in the device worker, a page's frame adapter behind a
 * MessagePort, or the Ethernet gateway (web/gateway.ts) in front of an IP
 * backend: `'echo'` (a synchronous test backend) or `{ip: port}` (a layer-3
 * backend, such as Tailscale, behind a MessagePort). `mac` defaults to
 * 52:54:00:12:34:56; the link is always up. `gateway`: the machine's adapter this is (0 by default), whose gateway has
 * its own MAC and address (web/gateway.ts `gatewayOf`), and whose echo backend leases its own addresses (`echoLease`).
 * `leaseSeconds`: the DHCP lease's (default an hour), `renewSeconds` when the guest renews it (default half of it): a
 * machine with several adapters has `SEVERAL_ADAPTERS`, so that the IPv4 default route moves from one to another at the
 * next renewal.
 */
export type NetSpec = {
  type: 'net';
  mac?: string;
  gateway?: number;
  leaseSeconds?: number;
  renewSeconds?: number;
  adapter: 'loopback' | 'echo' | MessagePort | { ip: MessagePort; link?: MessagePort };
};
/**
 * The DHCP timers of a machine with several adapters (docs/networking/adapters.md §4): the guest renews every 10 s,
 * so the IPv4 default route follows the primary within that (IPv6's moves with the router advertisement), and the lease
 * itself lasts two minutes, so a gateway that stops answering for a while (its client reconnecting) costs no address.
 */
export const SEVERAL_ADAPTERS = { leaseSeconds: 120, renewSeconds: 10 };

/**
 * virtio-9p (web/9p.ts), mounted by the guest by `tag`: an in-memory tree starting with `files` (path → contents), or with
 * `folders` the page's shared folders (web/9p-folders.ts), `port` carrying what changes while the machine runs.
 */
export type P9Spec = { type: '9p'; tag: string; files?: P9Files; folders?: FolderSpec[]; port?: MessagePort };
/**
 * virtio-input: a keyboard, a tablet (absolute pointer, 0–32767 on both
 * axes), a mouse (relative: the pointer while the page holds the mouse) or a
 * touchscreen (direct, multitouch: 10 slots, 0–32767 on both axes). Events for
 * the guest come from `port` as arrays of [type, code, value] (Linux
 * input-event-codes; web/input.ts makes them from DOM events); the guest's
 * status events (LEDs) go to it as one [type, code, value] each.
 */
export type InputSpec = { type: 'input'; kind: 'keyboard' | 'tablet' | 'mouse' | 'touch'; port?: MessagePort };

/**
 * virtio-gpu, 2D and, with `virgl`, 3D (web/gpu.ts; rendered by `renderer`, or on a null renderer without one): the display's size, the EDID's DPI, and a test hook that changes the
 * size after some flushes. Where the pixels go is the page's business (`GpuHooks`).
 */
export type GpuSpec = {
  type: 'gpu';
  /** The page's screen (a worker's `OffscreenCanvas`, transferred): the scanout is drawn on it (web/gpu-present.ts). */
  canvas?: OffscreenCanvas;
  /** Which screen draws it (web/gpu-present.ts `Screen2d`; the page's `?gpu=canvas2d` or `gl2d`). Default `auto`. */
  screen2d?: Screen2d;
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
 * page has the microphone: it opens it at the input's start), else silence on its own clock (docs/audio.md). With
 * `mixer` (the page's machines) it offers `VIRTIO_SND_F_CTLS`: a Master volume and switch that are the page's Sound
 * menu, both ways, on `port`; without (the test guests, as QEMU's device, the oracle) no controls.
 */
export type SndSpec = {
  type: 'snd';
  /** The page's sound ring (web/audio-ring.ts). */
  ring?: SharedArrayBuffer;
  /** The page's microphone ring (the same layout, filled by web/audio.ts's `waarm64-mic` worklet). */
  mic?: SharedArrayBuffer;
  /** The page's end: the streams' starts (their rates) and stops, and with `stats` the completions' timing once a second. */
  port?: MessagePort;
  /** What wakes the sink to complete played messages (default the worklet's notify): measurements. */
  wake?: SndWake;
  stats?: boolean;
  /** The page's volume and mute when the machine starts: the device has controls (`VIRTIO_SND_F_CTLS`) for them. */
  mixer?: SndMixer;
};

/** The MessagePorts and canvases in `specs`, to transfer with them. */
export const specPorts = (specs: DeviceSpec[]): Transferable[] =>
  specs.flatMap((d) =>
    d.type === 'net' && typeof d.adapter !== 'string'
      ? d.adapter instanceof MessagePort
        ? [d.adapter]
        : [d.adapter.ip, ...(d.adapter.link ? [d.adapter.link] : [])]
      : (d.type === 'input' || d.type === 'snd' || d.type === '9p') && d.port
        ? [d.port]
        : d.type === 'vsock'
          ? [...(d.port ? [d.port] : []), ...(d.agent ? [d.agent] : [])]
          : d.type === 'gpu'
            ? [...(d.canvas ? [d.canvas] : []), ...(d.port ? [d.port] : []), ...(d.renderer ? [d.renderer] : [])]
            : [],
  );

/** u64s in a `virtio::DeviceEntry`: `deviceEntry`'s five, then `deviceShm`'s (ABI 53). */
export const ENTRY_WORDS = 6;

/** `DeviceEntry.shm` (ABI 53): 1 when the VM's host-visible window is the device's shared memory region 1. */
export function deviceShm(d: DeviceSpec): bigint {
  return d.type === 'gpu' && d.virgl && d.venus ? 1n : 0n;
}

// A Venus machine's window and renderer arena in memory 0 (web/ram.ts, beside the split they move).
export { VENUS_ARENA, VENUS_WINDOW } from './ram.ts';

/** virtio::DeviceEntry's first five u64s and the initial config space. */
export function deviceEntry(d: DeviceSpec): { entry: bigint[]; config: Uint8Array } {
  switch (d.type) {
    // id, features, queues, queue size, config length. Console: no optional
    // features, so one port (receiveq 0, transmitq 1); config is cols, rows,
    // max_nr_ports, emerg_wr, unused without them.
    case 'console':
      return { entry: [3n, 0n, 2n, 64n, 12n], config: new Uint8Array(12) };
    case 'rng':
      return { entry: [4n, 0n, 1n, 64n, 0n], config: new Uint8Array(0) };
    // virtio-rtc (web/clock.ts): no features (no alarms), the requestq alone; no config space.
    case 'clock':
      return { entry: [BigInt(CLOCK_ID), 0n, 1n, 64n, 0n], config: new Uint8Array(0) };
    // Free page reporting and hinting (web/balloon.ts): never inflated.
    case 'balloon':
      return balloonEntry();
    // systemd's notify socket and the guest agent's port (web/vsock-device.ts): a virtio-vsock, the guest's CID 3.
    case 'vsock':
      return vsockEntry();
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
      return {
        entry: [
          2n,
          (1n << 2n) | (writable(d) ? 1n << 9n : 1n << 5n) | (discard ? (1n << 13n) | (1n << 14n) : 0n),
          1n,
          128n,
          BigInt(config.length),
        ],
        config,
      };
    }
    case 'net': {
      // Features MAC (5), STATUS (16) and the offloads (web/offload.ts); config: mac, status = LINK_UP. receiveq, transmitq.
      const config = new Uint8Array(8);
      config.set((d.mac ?? '52:54:00:12:34:56').split(':').map((h) => parseInt(h, 16)));
      config[6] = 1;
      return { entry: [1n, (1n << 5n) | (1n << 16n) | OFFLOADS, 2n, 256n, 8n], config };
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
    case 'input':
      return { entry: [18n, 0n, 2n, 64n, 136n], config: new Uint8Array(136) };
    // Feature EDID (1); controlq and cursorq; config: events_read, events_clear, num_scanouts = 1, num_capsets = 0.
    case 'gpu': {
      // Features EDID (1) and, with `virgl`, VIRGL (0); with `venus` also RESOURCE_UUID (2), RESOURCE_BLOB (3) and
      // CONTEXT_INIT (4). Config: num_scanouts (u32 at 8), num_capsets (at 12: VIRGL, VIRGL2, and VENUS).
      const config = new Uint8Array(16);
      new DataView(config.buffer).setUint32(8, 1, true);
      const venus = !!d.virgl && !!d.venus;
      if (d.virgl) new DataView(config.buffer).setUint32(12, venus ? 3 : 2, true);
      return { entry: [16n, venus ? 0x1fn : d.virgl ? 3n : 1n << 1n, 2n, BigInt(d.queueSize ?? 64), 16n], config };
    }
    // No features, or with `mixer` CTLS (0); controlq, eventq, txq, rxq; config: jacks 0, streams 2 (out, in), chmaps 0,
    // and with CTLS controls 2 (the Master volume and switch).
    case 'snd':
      return d.mixer
        ? { entry: [25n, 1n, 4n, 64n, 16n], config: new Uint8Array([0, 0, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 2, 0, 0, 0]) }
        : { entry: [25n, 0n, 4n, 64n, 12n], config: new Uint8Array([0, 0, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0]) };
  }
}

export { RAM_BASE, bytes, locate, ramLayout, type Ram, type RamLayout, type Segment } from './ram.ts';

/** How long a machine's end waits for what the backends hold back (a shared folder's write sessions), ms. */
export const CLOSE_MS = 2500;

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
      for (const s of r.read) out(decoder.decode(bytes(ram, s).slice(), { stream: true })); // a copy: TextDecoder refuses shared memory
      return 0;
    },
    reset() {
      rx.length = 0;
    },
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
          for (let k = 0; k < s.len; k += 65536)
            bytes(ram, s).set(crypto.getRandomValues(new Uint8Array(Math.min(65536, s.len - k))), k); // not on shared memory directly
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
        const b = bytes(ram, s);
        for (let k = 0; k < s.len; k++) b[k] = byte();
        n += s.len;
      }
      return n;
    },
    reset() {},
    save: () => ({ s: s.toString(16), word: word.toString(16), left }),
    restore(state) {
      const t = state as { s: string; word: string; left: number };
      if (typeof t?.s !== 'string' || typeof t.word !== 'string' || !(t.left >= 0 && t.left <= 8))
        throw new Error('the snapshot has no state for the random number device');
      [s, word, left] = [BigInt(`0x${t.s}`) & M64, BigInt(`0x${t.word}`) & M64, t.left];
    },
  };
}

/**
 * virtio-rtc (web/clock.ts): each request answered at once from the browser's clock. Deterministic runs read a fixed
 * time (the PL031's there: 2026-09-01), so a step count doesn't depend on the date.
 */
function clock(ctx: Ctx, deterministic: boolean): Backend {
  const now = deterministic ? () => 1_788_220_800_000_000_000n : browserClock();
  return {
    request(r) {
      const ram = ctx.ram();
      const answer = clockAnswer(gather(ram, r.read, 64), now);
      scatter(ram, r.write, answer);
      return Math.min(
        answer.length,
        r.write.reduce((n, s) => n + s.len, 0),
      );
    },
    reset() {},
  };
}

/**
 * What an overlay over `d`'s image belongs to (web/overlay.ts `openOverlay`): the spec's `identity` where the page gave
 * one (a machine's disk record), else the URL's path, or a chosen file's name, size and modification time, or the
 * source (a blank disk); and the virtual size.
 */
export const diskIdentity = (d: { url?: string; file?: Blob; source?: string; identity?: string }, size: number) =>
  d.identity ??
  JSON.stringify(
    d.file
      ? { file: (d.file as File).name, bytes: d.file.size, modified: (d.file as File).lastModified, size }
      : d.url
        ? { path: new URL(d.url, 'http://x').pathname, size }
        : { source: d.source, size },
  );

/** `Promise.all` that, when one rejects, closes the others' values once they settle (what they opened isn't left held). */
async function allOrClose<T>(all: (Promise<T> | T)[], close: (x: T) => void): Promise<T[]> {
  const r = await Promise.allSettled(all);
  const failed = r.find((x) => x.status === 'rejected');
  if (!failed) return r.map((x) => (x as PromiseFulfilledResult<T>).value);
  for (const x of r) if (x.status === 'fulfilled') close(x.value);
  throw failed.reason;
}

export type DevicesInit = {
  memory: WebAssembly.Memory;
  /** The core (the machine's, not its exact-memory copy): this thread's codec for qcow2's clusters runs on it (web/deflate.ts). */
  core?: WebAssembly.Module;
  /**
   * The host-visible window (`BootOptions.window`): its address in memory 1 (`spill[0]`), its bytes, and its
   * write-watch's address in `memory` (web/window.ts).
   */
  window?: { at: number; bytes: number; watch: number };
  /** Addresses in `memory` of each device's `virtio::DevShared`, of guest RAM and of the signal word. */
  shared: number[];
  ram: number;
  ramSize: number;
  /** Where each memory's RAM is (web/ram.ts `ramLayout`; default: the spill memories' RAM from their first byte, no window). */
  layout?: RamLayout;
  /** Memories 1 and up (docs/spill-memories.md), memory 1 first. */
  spill?: WebAssembly.Memory[];
  signal: number;
  specs: DeviceSpec[];
  deterministic: boolean;
  /** Parallel SMP: each vCPU's wake word (`vm_cpu_signal`), bumped and notified after the signal word (docs/abi.md). */
  wakes?: number[];
  /** Parallel SMP: each vCPU's stop word (`vm_cpu_stop`, ABI 71), set to 0 after the signal word, before the wake words. */
  stops?: number[];
  /** A VM restored from a snapshot: each backend's saved state (`Devices.save`), null where it had none. */
  state?: unknown[];
  /** The xHCI (docs/usb.md): `vm_xhci`'s address, the page's port for the contract's messages, devices to plug in at start. */
  xhci?: { shared: number; port?: MessagePort; attach?: UsbAttach[] };
  /**
   * Two I/O byte counters per device, by index (over a SharedArrayBuffer where the backends run in the device worker,
   * so the VM's thread reads them: `Vm.deviceIo`): a blk's bytes read and written, a net's frames' bytes received and
   * sent (`Ctx.io`); then, after the last device's, the xHCI's: its transfers' bytes IN and OUT (`UsbInit.io`). Only this thread writes them (plain stores; a reader may see a value a request old).
   */
  io?: Float64Array;
};

/** The buffers of the Uint8Arrays in a saved state (`Devices.save`), to transfer it to another thread. */
export function stateBuffers(state: unknown): ArrayBuffer[] {
  const out = new Set<ArrayBuffer>();
  const walk = (v: unknown) => {
    if (v instanceof Uint8Array) {
      if (v.buffer instanceof ArrayBuffer) out.add(v.buffer);
    } else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  walk(state);
  return [...out];
}

export class Devices {
  private memory: WebAssembly.Memory;
  private shared: number[];
  private signal: number;
  private wakes: number[];
  private stops: number[];
  private backends: Backend[];
  /** The balloon's backend, if the machine has one (`hint`). */
  private balloon?: Balloon;
  private epochs: number[];
  /** The xHCI's devices (web/usb.ts). */
  readonly usb?: Usb;
  /** Set by `close`: `serve` returns. */
  private closed = false;
  /** The timers of the blk devices with `stats` (web/iostats.ts), by device. */
  private ioStats: Record<number, IoStats> = {};
  private deterministic: boolean;
  /** Requests of `concurrent` backends still running (realtime), and the first one's error if one failed. */
  private detached = new Set<Promise<void>>();
  private failed: unknown;
  /** The disks' sources, by device (an HTTP one's block cache has its counters). */
  private sources: (Source | WritableDisk | undefined)[];
  private served?: Int32Array;
  /** Views of `memory` for its buffer of now (a grown memory has a new one): `views`. */
  private viewsOf?: { buffer: ArrayBufferLike; u32: Uint32Array; i32: Int32Array; ram: Uint8Array[] };
  private ramAt: number;
  private spillViews: Uint8Array[];
  /** A `kick` is queued for this microtask's end (completions in one go wake the vCPUs once). */
  private kickOwed = false;
  /** `out` receives what a console device's guest side wrote. */
  private constructor(
    {
      memory,
      shared,
      ram,
      ramSize,
      layout: given,
      window,
      spill = [],
      signal,
      specs,
      deterministic,
      wakes,
      stops,
      xhci,
      io,
    }: DevicesInit,
    overlays: (OverlayFiles | undefined)[],
    sources: (Source | WritableDisk | undefined)[],
    out: (device: number, text: string) => void,
    onFull?: () => void,
  ) {
    [this.memory, this.shared, this.signal, this.wakes, this.stops, this.sources, this.deterministic] = [
      memory,
      shared,
      signal,
      wakes ?? [],
      stops ?? [],
      sources,
      deterministic,
    ];
    // Spill memories are made at their final size: their views never go stale.
    this.spillViews = spill.map((m) => new Uint8Array(m.buffer));
    this.ramAt = ram;
    const layout =
      given ??
      ramLayout(
        ramSize,
        spill.map((m) => m.buffer.byteLength),
      );
    this.backends = specs.map((d, i) => {
      const ctx: Ctx = {
        ram: () => this.views().ram, // read-only: the same array until the memory grows
        layout,
        complete: (w0, len) => this.complete(i, w0, len),
        untaken: () => this.untaken(i),
        config: () => new Uint8Array(this.memory.buffer, shared[i] + CONFIG, 256),
        changeConfig: (write) => this.changeConfig(i, write),
        features: () => {
          const f = new Uint32Array(this.memory.buffer, shared[i] + FEATURES, 2);
          return BigInt(Atomics.load(f, 0)) | (BigInt(Atomics.load(f, 1)) << 32n);
        },
        io: io?.subarray(2 * i, 2 * i + 2),
      };
      switch (d.type) {
        case 'console':
          return console_((t) => out(i, t), ctx);
        case 'rng':
          return rng(ctx, deterministic);
        case 'clock':
          return clock(ctx, deterministic);
        case 'balloon':
          return (this.balloon = balloon(ctx));
        case 'vsock':
          return vsockDevice(ctx, d);
        case 'blk': {
          const st = d.stats ? (this.ioStats[i] = new IoStats()) : undefined;
          return blk(
            ctx,
            sources[i]!,
            overlays[i],
            d.discard || d.source === 'ram',
            st,
            d.serial,
            !deterministic,
            overlays[i] && onFull,
            d.size,
            d.diskSize,
          );
        }
        case 'net':
          return net(ctx, d);
        case '9p':
          return d.folders ? folders9p(ctx, d.folders, d.port) : p9(ctx, d.files ?? {}, deterministic);
        case 'input':
          return input(ctx, d);
        case 'gpu': {
          const b = gpuBackend(
            ctx,
            d,
            d.renderer
              ? pagePresenter(d.port, d.stats)
              : d.canvas
                ? canvasPresenter(d.canvas, d.port, d.stats, d.probe, d.screen2d)
                : {},
          );
          if (d.renderer && d.virgl) {
            // The GPU worker reads and writes guest RAM in place: it gets the shared memory first.
            const host = portHost(d.renderer);
            host.call({
              t: 'ram',
              ram: ctx.ram().map((r, k) => ({
                buffer: r.buffer,
                offset: r.byteOffset,
                length: k ? r.byteLength : ctx.layout[0].size,
              })),
            });
            // Venus's renderer runs on memory 1 itself (web/venus-host.ts), the window there; the watch's words are memory 0's.
            if (d.venus && window)
              host.call({
                t: 'venus-init',
                memory: spill[0],
                core: memory,
                window: d.noWatch ? { ...window, watch: 0 } : { ...window, stops: this.stops },
              });
            b.gpu.host = host;
          }
          if (!d.renderer && d.canvas)
            console.info(`waarm64: the 2D screen on ${b.gpu.hooks.raw ? 'WebGL2' : 'a 2D canvas'}`);
          if (d.port) {
            const port = d.port;
            port.onmessage = (e: MessageEvent<DisplayFromPage>) => {
              if (e.data?.type === 'size') b.gpu.setSize(e.data.width, e.data.height);
              // "Copy the screen": a 2D machine's scanout as a PNG (a 3D machine's is the GPU worker's to read back).
              if (e.data?.type === 'png') {
                const id = e.data.id;
                void Promise.resolve(b.gpu.hooks.png?.())
                  .catch(() => undefined)
                  .then((png) => port.postMessage({ type: 'png', id, png } satisfies ScreenPng));
              }
            };
          }
          if (d.capture && d.port)
            b.gpu.onCapture = (record) => d.port!.postMessage({ type: 'capture', record }, [record.buffer]);
          return b;
        }
        case 'snd': {
          const mixer = d.mixer && { ...d.mixer, port: d.port };
          return deterministic
            ? sndBackend(ctx, checksumSink(), patternSource(), mixer)
            : sndBackend(
                ctx,
                ringSink({ ring: d.ring, port: d.port, wake: d.wake, stats: d.stats, untaken: () => ctx.untaken() }),
                micSource({ ring: d.mic, port: d.port, untaken: () => ctx.untaken() }),
                mixer,
              );
        }
      }
    });
    this.epochs = specs.map(() => 0);
    if (xhci)
      this.usb = new Usb({
        memory,
        shared: xhci.shared,
        ram,
        ramSize,
        spill,
        deterministic,
        kick: () => this.kick(),
        port: xhci.port,
        attach: xhci.attach,
        io: io?.subarray(2 * specs.length, 2 * specs.length + 2),
      });
  }

  /** The devices as the snapshot left them (their epoch is not a reset), with the backends' `state`. */
  private restore(state: unknown[]) {
    if (state.length !== this.backends.length) throw new Error('the snapshot is of a machine with other devices');
    const u32 = new Uint32Array(this.memory.buffer);
    this.epochs = this.shared.map((at) => Atomics.load(u32, (at + EPOCH) / 4) & 0xff);
    this.backends.forEach((b, i) => {
      if (state[i] !== null && state[i] !== undefined) b.restore?.(state[i]);
    });
    for (const b of this.backends) b.restored?.();
  }

  /**
   * The balloon's free page hint (web/balloon.ts), right before a snapshot or a suspend: resolves once the guest said
   * STOP (it holds every free block it could take, zeroed) or after `ms`; undefined without a balloon whose driver hints.
   */
  hint(ms: number) {
    return this.balloon?.hint(ms) ?? Promise.resolve(undefined);
  }

  /** The hinted blocks given back to the guest (DONE), after the save. */
  release() {
    this.balloon?.release();
  }

  /** Device `i`'s changed blocks (4 KiB each, ascending) if it is a disk with an overlay, for a snapshot. */
  written(i: number): { blocks: Uint32Array; generation?: number } | undefined {
    return this.backends[i]?.written?.();
  }

  /** The bytes of `blocks` (some of `written(i)`), one after the other. */
  blocks(i: number, blocks: Uint32Array): Uint8Array {
    return this.backends[i].blocks!(blocks);
  }

  /**
   * Each backend's state for a snapshot (null: none), with the devices quiet (`poll` resolved): JSON, but for
   * Uint8Arrays (the display's 3D contents), which web/snapshot.ts writes as frames of their own.
   */
  async save(): Promise<unknown[]> {
    await this.drain(); // nothing may complete into the memory being saved
    return Promise.all(this.backends.map((b) => b.save?.() ?? null));
  }

  /** The first backend's reason a snapshot would be refused now (`Backend.refusal`), or undefined. */
  async refusal(): Promise<WireError | undefined> {
    return (await Promise.all(this.backends.map((b) => b.refusal?.()))).find((x) => x);
  }

  /** The disks' overlays compacted (after a trim the page asked for; `measure`: only their sizes): the bytes their files took before and after, summed. */
  async compact(measure = false): Promise<{ before: number; after: number }> {
    const sum = { before: 0, after: 0 };
    for (const b of this.backends) {
      const r = await b.compact?.(measure);
      if (r) [sum.before, sum.after] = [sum.before + r.before, sum.after + r.after];
    }
    return sum;
  }

  /** Device `i`'s answer to `query` (a disk's surface or one of its ranges: web/surface.ts); `none` for a device that has none. */
  async inspect(i: number, query: InspectQuery): Promise<InspectAnswer> {
    return (await this.backends[i]?.inspect?.(query)) ?? { kind: 'none' };
  }

  /** Resolves once no request of a `concurrent` backend runs (a snapshot's quiesce: their completions land first) and what the backends hold back landed. */
  async drain() {
    while (this.detached.size) await Promise.all(this.detached);
    await Promise.all(this.backends.map((b) => b.flush?.()));
  }

  /**
   * Builds the backends, opening any overlays first (OPFS handles are created asynchronously). `notice`: what the page
   * should tell the user while the machine runs on (a ramdisk out of memory, the storage full). If anything fails
   * (an image that doesn't load, a backend's `restore` that throws), what was opened is closed again: another start
   * can open the overlays (their locks released), not wait for them.
   */
  static async open(
    init: DevicesInit,
    out: (device: number, text: string) => void,
    notice: (m: Msg) => void = () => {},
  ) {
    if (init.core) void coreModule(init.core);
    // A stored disk written in place is opened as its store is for any writer: an interrupted merge is finished first.
    const overlays = await allOrClose(
      init.specs.map((d) =>
        d.type !== 'blk' || !d.overlay
          ? undefined
          : d.overlay.startsWith('disks/')
            ? openStoredForWriting(d.overlay, diskIdentity(d, d.size ?? 0), d.size ?? 0)
            : openOverlay(d.overlay, diskIdentity(d, d.size ?? 0)),
      ),
      (o) => o?.close(),
    );
    const closeOverlays = () => {
      for (const o of overlays) o?.close();
    };
    const closeSource = (s: Source | WritableDisk | undefined) => {
      if (s && !('write' in s)) s.close?.();
    };
    const sources = await allOrClose(
      init.specs.map(async (d) => {
        if (d.type !== 'blk') return undefined;
        if (d.source) {
          if (!d.size) throw new Error(`a ${d.source === 'ram' ? 'ramdisk' : 'blank disk'} needs a size`);
          if (d.source !== 'ram') return zeroSource(d.size);
          const ram = ramDisk(d.size, d.ramInit, { onFull: () => notice(msg('disks:devices.ramdiskFull')) });
          // A swap ramdisk starts as a swap area (a restored one has its own first page in its chunks).
          if (d.swap && !d.ramInit && !(await ram.write(0, swapHeader(d.size, d.swap))))
            throw new Error("the swap ramdisk's first page couldn't be written");
          return ram;
        }
        if (d.stored) return openStored(d.stored, d.size ?? 0);
        if (d.file) return blobSource(d.file);
        if (!d.url) throw new Error('a disk with no image (url, file or source)');
        if (d.url.startsWith('file:')) return fileSource(d.url);
        return remoteSource(d.url, d.keep ?? true, !init.deterministic, d.chunked);
      }),
      closeSource,
    ).catch((e: unknown) => {
      closeOverlays();
      throw e;
    });
    // At most once a minute for all disks: while it's full, overwrites of blocks an overlay holds still land (they
    // don't grow its file), and each disk tells again after one.
    let toldAt = -Infinity;
    const full = () => {
      if (performance.now() - toldAt < FULL_REPEAT_MS) return;
      toldAt = performance.now();
      void storageFull().then(notice);
    };
    let d: Devices;
    try {
      d = new Devices(init, overlays, sources, out, full);
    } catch (e) {
      closeOverlays();
      sources.forEach(closeSource);
      throw e;
    }
    try {
      if (init.state) d.restore(init.state);
    } catch (e) {
      d.close(); // the backends' files and workers with it
      throw e;
    }
    return d;
  }

  /** The I/O timers of the blk devices that have them (spec `stats`), by device index. */
  stats() {
    return Object.fromEntries(
      Object.entries(this.ioStats).map(([i, st]) => [
        i,
        { ...st.json(), cache: (this.sources[+i] as { stats?: BlockCacheStats } | undefined)?.stats },
      ]),
    );
  }

  /** Releases the backends' files (an overlay's handles lock them). */
  close() {
    for (const b of this.backends) b.close?.();
    this.usb?.close();
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
    if (this.failed) throw this.failed;
    for (const [i, b] of this.backends.entries()) {
      const u32 = this.views().u32;
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
      let skipped = false;
      while (tail !== head) {
        const w0 = word();
        const n = word();
        const segs = (k: number) => Array.from({ length: k }, () => ({ off: word(), len: word(), mem: word() }));
        const r = { w0, queue: (w0 >>> 16) & 0xff, read: segs(n & 0xffff), write: segs(n >>> 16) };
        tail >>>= 0;
        Atomics.store(u32, ring + 1, tail);
        if (w0 >>> 24 !== epoch) {
          // posted before a reset
          skipped = true;
          continue;
        }
        const len = b.request(r);
        if (len === undefined) continue;
        if (typeof len === 'number') this.complete(i, w0, len);
        else if (b.concurrent && !this.deterministic) {
          // Completed when it resolves, whatever came before: the device worker serves the rest meanwhile.
          const p: Promise<void> = len
            .then(
              (n) => this.complete(i, w0, n),
              (e) => {
                this.failed ??= e;
              },
            )
            .finally(() => this.detached.delete(p));
          this.detached.add(p);
        } else this.complete(i, w0, await len);
      }
      // The room they took may be what a chain of the new driver waits for, and nothing completes them (docs/devices.md).
      if (skipped) this.kick();
      b.polled?.();
    }
    this.usb?.poll();
  }

  private untaken(i: number) {
    const u32 = this.views().u32;
    const ring = (this.shared[i] + CPL) / 4;
    return ((Atomics.load(u32, ring) - Atomics.load(u32, ring + 1)) >>> 0) / 2;
  }

  private complete(i: number, w0: number, len: number) {
    const u32 = this.views().u32;
    const ring = (this.shared[i] + CPL) / 4;
    const head = u32[ring];
    if (RING_WORDS - ((head - Atomics.load(u32, ring + 1)) >>> 0) < 2) throw new Error('completion ring full'); // the core sizes it for every buffer in flight
    u32[ring + 2 + (head % RING_WORDS)] = w0;
    u32[ring + 2 + ((head + 1) % RING_WORDS)] = len;
    Atomics.store(u32, ring, (head + 2) >>> 0);
    // One kick for every completion of this microtask (a poll's, a frame's merged buffers): at its end, so before
    // `serve` answers the doorbell (that continuation is queued after it) and before any wait in a poll.
    if (!this.kickOwed) {
      this.kickOwed = true;
      queueMicrotask(() => {
        this.kickOwed = false;
        this.kick();
      });
    }
  }

  /** `memory`'s views, made again when it grew (its buffer is a new one). */
  private views() {
    const buffer = this.memory.buffer;
    if (this.viewsOf?.buffer !== buffer)
      this.viewsOf = {
        buffer,
        u32: new Uint32Array(buffer),
        i32: new Int32Array(buffer),
        ram: [new Uint8Array(buffer, this.ramAt), ...this.spillViews],
      };
    return this.viewsOf;
  }

  /** Sets the signal word's device bit and wakes the vCPUs, so the core takes what the backends left. */
  private kick() {
    const i32 = this.views().i32;
    Atomics.or(i32, this.signal / 4, SIGNAL_DEVICE);
    Atomics.notify(i32, this.signal / 4);
    // Compiled code stops at its next poll (docs/abi.md "PERF: the stop word").
    for (const p of this.stops) Atomics.store(i32, p / 4, 0);
    for (const w of this.wakes) {
      Atomics.add(i32, w / 4, 1);
      Atomics.notify(i32, w / 4);
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
    const macrotask = () =>
      new Promise<void>((resolve) => {
        turn.port1.onmessage = () => resolve();
        turn.port2.postMessage(0);
      });
    // The listening port keeps Node's process alive: closed on every way out.
    let since = performance.now();
    try {
      for (let seen = 0; !this.closed;) {
        if (performance.now() - since > 2) {
          await macrotask();
          since = performance.now();
          continue; // a `close` meanwhile notified no one: the wait below would be for good
        }
        const rung = Atomics.load(bell, 0);
        if (rung === seen) {
          const w = Atomics.waitAsync(bell, 0, seen);
          if (w.async) {
            await w.value;
            since = performance.now(); // its wake-up came as a task: the event loop had its turn
          }
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
    } finally {
      turn.port1.close();
    }
  }
}
