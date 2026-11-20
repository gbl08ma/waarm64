// virtio device backends (docs/devices.md). The core runs
// the virtio-mmio transports and split queues and posts each descriptor chain
// to the device's request ring as RAM segments; backends here only speak the
// device protocol. `Devices` works on the shared memory from any thread: in the
// device worker (web/device-worker.ts) or inline on the vCPU thread.
import { msg, msgOf, type Msg, type WireError } from './msg.ts';
import { browserClock, clockAnswer, CLOCK_ID } from './clock.ts';
import { balloon, balloonEntry, type Balloon } from './balloon.ts';
import { vsockDevice, vsockEntry, type VsockSpec } from './vsock-device.ts';
import { p9, type P9Files } from './9p.ts';
import { folders9p, type FolderSpec } from './9p-folders.ts';
import { echoBackend, echoLease, gateway, gatewayOf, portBackend } from './gateway.ts';
import { busy, gpuBackend, type GpuOptions } from './gpu.ts';
import { canvasPresenter, pagePresenter, type DisplayFromPage, type Screen2d, type ScreenPng } from './gpu-present.ts';
import { portHost } from './virgl-host.ts';
import { loopback, portAdapter, type NetAdapter } from './net.ts';
import {
  F_GUEST_CSUM,
  F_GUEST_TSO4,
  F_GUEST_TSO6,
  F_MRG_RXBUF,
  MAX_FRAME,
  MAX_GSO_FRAME,
  MAX_PORT_FRAME,
  NET_HDR,
  OFFLOADS,
  receive,
  transmit,
  type RxFrame,
} from './offload.ts';

/** The largest frame for the guest: a merged packet, IPv6's largest, behind Ethernet and a VLAN tag. */
const MAX_RX = NET_HDR + 18 + 40 + 65_535;
import { IoStats } from './iostats.ts';
import { BLOCK_CACHE, cachedSource, type BlockCacheStats } from './blockcache.ts';
import { cacheKey, openBlockStore, releaseStores } from './diskcache.ts';
import { chunkedSource, isManifestUrl } from './chunked.ts';
import {
  blockList,
  openOverlay,
  overlay,
  storageNumbers,
  type MapLeaves,
  type OverlayFiles,
  type WritableDisk,
} from './overlay.ts';
import {
  diskInspector,
  RANGE,
  type InspectAnswer,
  type InspectQuery,
  type LiveDisk,
  type LiveImage,
} from './surface.ts';
import { ramDisk, swapHeader } from './ramdisk.ts';
import { openStored, openStoredForWriting } from './stored.ts';
import { coreModule } from './deflate.ts';
import { inflatePool } from './inflate-pool.ts';
import { openDisk, type Disk } from './qcow2.ts';
import { Usb, type UsbAttach } from './usb.ts';
import { checksumSink, micSource, patternSource, ringSink, sndBackend, type SndMixer, type SndWake } from './snd.ts';
import { bytes, ramLayout, type Ram, type RamLayout, type Segment } from './ram.ts';

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
 * How long a link flap keeps the link down: past what systemd-networkd waits out. It acts on a carrier loss at once,
 * except when the DHCP lease's MTU isn't the link's original one (a tailnet's 1280 against virtio's 1500): then it
 * ignores a loss shorter than 5 s (`link_carrier_lost`, systemd 257, against drivers that reset the link on an MTU
 * change, systemd#18738). A 1 s flap and a 5 s one were both ignored at boot's first lease; 7 s is past it.
 */
export const FLAP_MS = 7000;
/**
 * How long a restored machine's card holds the flaps its switches owe (`Backend.restored`) when the page never says it
 * settled its leases, from when the page says its network is connected (`{type: 'connected'}`): past what
 * web/app/areas/lease-actions.ts waits at most from then (its grace, the agent's HELLO and LEASED: 110 s). Not from the
 * restore: a connection can take minutes to come (the demo server full or crowded), and the flap its switch owes then is
 * the one the hold is for. Until it's connected the hold has no bound: the card has nothing to renew a lease from.
 */
export const HOLD_MS = 120_000;
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

// virtio::DevShared layout (core/src/virtio.rs).
const EVENTS = 0;
const FEATURES = 8;
const EPOCH = 16;
const CONFIG_GEN = 20;
const CONFIG = 24;
const REQ = 280;
const RING_WORDS = 4096;
const CPL = REQ + 8 + 4 * RING_WORDS;
const SIGNAL_DEVICE = 4;
export const EV_CONFIG = 2;

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
export type Request = { w0: number; queue: number; read: Segment[]; write: Segment[] };
export type Ctx = {
  ram: () => Ram;
  layout: RamLayout;
  complete: (w0: number, len: number) => void;
  config: () => Uint8Array;
  /** Completions given (`complete`) that the core hasn't taken yet: it takes them when a vCPU runs. */
  untaken: () => number;
  /** Changes the config space under a running driver (docs/abi.md, ABI 31): `write` gets it, and the guest gets a config-change interrupt. */
  changeConfig: (write: (config: Uint8Array) => void) => void;
  /** The features the driver negotiated (0 before FEATURES_OK). */
  features: () => bigint;
  /** This device's two I/O byte counters (`DevicesInit.io`), where the owner keeps them: blk read, written; net received, sent. */
  io?: Float64Array;
};

/**
 * A backend handles a request now (returns bytes written, or a promise of
 * them: requests complete in order either way), or keeps it and completes it
 * later. `config` runs when the guest wrote the config space.
 */
/** How long a machine's end waits for what the backends hold back (a shared folder's write sessions), ms. */
export const CLOSE_MS = 2500;

export type Backend = {
  request(r: Request): number | Promise<number> | undefined;
  reset(): void;
  close?(): void;
  config?(): void;
  /** Its requests may complete in any order (a remote disk's, R4): in realtime mode `Devices.poll` doesn't wait for them. */
  concurrent?: boolean;
  /** Lands what it holds back (a shared folder's write sessions): before a snapshot and at the end of the machine. */
  flush?(): Promise<void>;
  /** Runs after the device's requests of a DEVICE exit were taken (every exit, even without any): virtio-snd's deterministic sink completes there. */
  polled?(): void;
  /**
   * A snapshot (docs/platform.md "Snapshots"): what the backend must keep besides the requests it holds,
   * as JSON, and the same given to a new backend. The core posts held requests to a restored VM's
   * backends again, so one that only holds buffers has neither.
   */
  save?(): unknown | Promise<unknown>;
  restore?(state: unknown): void;
  /** The VM was restored from a snapshot (or a suspended copy): called on every backend, after `restore`. */
  restored?(): void;
  /** Why `save` would refuse now (`unsaveable` in its state), or undefined: asked before a snapshot touches the machine. */
  refusal?(): Promise<WireError | undefined>;
  /** A writable disk's changes, for a snapshot: the blocks (4 KiB) its overlay holds, and their bytes. */
  written?(): { blocks: Uint32Array; generation?: number };
  blocks?(blocks: Uint32Array): Uint8Array;
  /** A disk's overlay compacted once no request of its runs (web/overlay.ts `compact`; `measure`: only its size): the bytes its files took before and after. */
  compact?(measure?: boolean): Promise<{ before: number; after: number }>;
  /** A disk's surface or a range of it (web/surface.ts), from what it has in memory: answered while it runs. */
  inspect?(query: InspectQuery): Promise<InspectAnswer>;
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

/** Bytes of the concatenated segments, `len` of them at most. */
export function gather(ram: Ram, segs: Segment[], len: number) {
  const out = new Uint8Array(len);
  let k = 0;
  for (const s of segs) {
    if (k === len) break;
    const n = Math.min(s.len, len - k);
    out.set(bytes(ram, s).subarray(0, n), k);
    k += n;
  }
  return out.subarray(0, k);
}

/** Writes `data` across the segments, in order. */
export function scatter(ram: Ram, segs: Segment[], data: Uint8Array) {
  let k = 0;
  for (const s of segs) {
    if (k === data.length) break;
    const n = Math.min(s.len, data.length - k);
    bytes(ram, s).set(data.subarray(k, k + n));
    k += n;
  }
}

const RX_QUEUE = 256; // frames held while the guest has posted no receive buffer

/**
 * virtio-net: each transmitted chain is a frame for the adapter (header
 * stripped, its checksum finished) or, a large TCP or UDP packet, its segments
 * (web/offload.ts); frames from the adapter wait for receive buffers, the
 * oldest dropped past RX_QUEUE, as a NIC drops. Those from a port arrive in
 * batches (the frames of one task, delivered at its end: a microtask, no
 * timer), and `receive` merges a batch's TCP segments and marks valid
 * checksums; the test adapters' frames go at once, so deterministic mode
 * stays exact. With MRG_RXBUF a frame fills as many buffers as it needs.
 * Guest bugs (short, oversized or malformed chains) drop the frame.
 */
export function net(ctx: Ctx, d: NetSpec): Backend {
  const io = ctx.io ?? new Float64Array(2); // bytes received (frames to the guest), sent
  const rx: Request[] = [];
  const frames: Uint8Array[] = []; // not yet through `receive`
  const ready: RxFrame[] = []; // waiting for buffers
  let scheduled = false;
  const room = (r: Request) => r.write.reduce((n, s) => n + s.len, 0);
  const deliver = () => {
    scheduled = false;
    const f = ctx.features();
    const mrg = (f & F_MRG_RXBUF) !== 0n;
    if (frames.length) {
      ready.push(
        ...receive(frames.splice(0), {
          csum: (f & F_GUEST_CSUM) !== 0n,
          merge4: mrg && (f & F_GUEST_TSO4) !== 0n,
          merge6: mrg && (f & F_GUEST_TSO6) !== 0n,
        }),
      );
      if (ready.length > RX_QUEUE) ready.splice(0, ready.length - RX_QUEUE);
    }
    while (rx.length && ready.length) {
      const { hdr, frame } = ready[0];
      const total = NET_HDR + frame.length;
      let n = 1;
      for (let have = room(rx[0]); have < total; n++) {
        if (!mrg || n === rx.length) break;
        have += room(rx[n]);
      }
      const fits = rx.slice(0, n).reduce((k, r) => k + room(r), 0) >= total;
      if (!fits && mrg && n === rx.length && total <= MAX_RX) break; // more buffers to come
      ready.shift();
      if (!fits) continue; // larger than the guest's buffers can hold: dropped
      hdr[10] = n & 255; // num_buffers
      hdr[11] = n >> 8;
      const b = new Uint8Array(total);
      b.set(hdr);
      b.set(frame, NET_HDR);
      io[0] += frame.length;
      for (let k = 0, at = 0; k < n; k++) {
        const r = rx.shift()!;
        const len = Math.min(room(r), total - at);
        scatter(ctx.ram(), r.write, b.subarray(at, at + len));
        ctx.complete(r.w0, len);
        at += len;
      }
    }
  };
  const sync = d.adapter === 'loopback' || d.adapter === 'echo';
  const receiveFrame = (f: Uint8Array) => {
    frames.push(f);
    if (sync) deliver();
    else if (!scheduled) {
      scheduled = true;
      queueMicrotask(deliver);
    }
  };
  // The link flap (docs/devices.md "net"): the link goes down and, `FLAP_MS` later, up, so the guest's DHCP client asks
  // again at once (networkd does on a carrier). Only under a driver, and only when what the guest holds is stale.
  let flapping: ReturnType<typeof setTimeout> | undefined;
  // A restored machine's card holds the flaps its own switches owe (`restored`) until the page settled the restore's
  // leases (web/app/areas/lease-actions.ts: `{type: 'settled', renewed}` on the link): a flap then would take the link
  // down under the agent's LEASE, and the renewal it starts would go out on a dead link (udhcpc then waits for its next
  // try). Renewed, what was owed is dropped; not, it flaps then. `HOLD_MS` at most once the page's network is connected.
  let holding = false;
  let hold: ReturnType<typeof setTimeout> | undefined;
  let owed = false;
  const settled = (renewed: boolean) => {
    clearTimeout(hold);
    [holding, hold] = [false, undefined];
    if (owed && !renewed) flap();
    owed = false;
  };
  const flap = () => {
    if (holding) {
      owed = true;
      return;
    }
    if (!ctx.features() || flapping) return;
    ctx.changeConfig((c) => {
      c[6] = 0;
    });
    flapping = setTimeout(() => {
      flapping = undefined;
      ctx.changeConfig((c) => {
        c[6] = 1;
      });
    }, FLAP_MS);
  };
  const a = d.adapter;
  /** Frames to a port of their own (the local helper's client), the page's gateway bypassed: larger frames pass. */
  let framesTo: NetAdapter | undefined;
  /** Frames mode with no port yet (the client went): the guest's frames are dropped, as a cable to nothing. */
  let framesMode = a instanceof MessagePort;
  const toFrames = (port: MessagePort | null) => {
    framesTo?.close?.();
    framesTo = port ? portAdapter(port, receiveFrame) : undefined;
    if (!framesMode) flap(); // the guest's lease was the gateway's
    framesMode = true;
  };
  const toGateway = () => {
    framesTo?.close?.();
    framesTo = undefined;
    if (framesMode) flap(); // the guest's lease was the helper's
    framesMode = false;
  };
  /** The page's gateway's frames: none while the card is on the helper's frames (it is bypassed; what it says is stale). */
  const fromGateway = (f: Uint8Array) => {
    if (!framesMode) receiveFrame(f);
  };
  const adapter: NetAdapter =
    a === 'loopback'
      ? loopback(receiveFrame)
      : a === 'echo'
        ? gateway(receiveFrame, echoBackend(echoLease(d.gateway ?? 0)), {
            ...gatewayOf(d.gateway ?? 0),
            leaseSeconds: d.leaseSeconds,
            renewSeconds: d.renewSeconds,
          })
        : a instanceof MessagePort
          ? portAdapter(a, receiveFrame)
          : gateway(fromGateway, portBackend(a.ip, { frames: toFrames, gateway: toGateway }), {
              advertiseMs: 60_000,
              ...gatewayOf(d.gateway ?? 0),
              leaseSeconds: d.leaseSeconds,
              renewSeconds: d.renewSeconds,
              stale: flap,
            });
  if (a instanceof MessagePort) framesTo = adapter; // a frame port from the start: its own, the card's frames go to it
  // The page's: a flap asked for (a restored guest whose agent couldn't renew its lease: web/app/areas/lease-actions.ts).
  const link = typeof a === 'object' && !(a instanceof MessagePort) ? a.link : undefined;
  if (link)
    link.onmessage = (e: MessageEvent<{ type?: string; renewed?: boolean } | undefined>) => {
      if (e.data?.type === 'flap') {
        settled(true); // asked for: the page's renewal, past anything held
        flap();
      } else if (e.data?.type === 'settled') settled(e.data.renewed === true);
      else if (e.data?.type === 'connected' && holding && !hold) hold = setTimeout(() => settled(false), HOLD_MS);
    };
  const out = (f: Uint8Array) => (framesMode ? framesTo?.send(f) : adapter.send(f));
  return {
    request(r) {
      if (r.queue === 0) {
        rx.push(r);
        deliver();
        return undefined;
      }
      const len = r.read.reduce((n, s) => n + s.len, 0);
      if (len > NET_HDR && len <= NET_HDR + MAX_GSO_FRAME) {
        io[1] += len - NET_HDR; // the guest's frame (a large one before its segmentation)
        for (const f of transmit(gather(ctx.ram(), r.read, len), framesMode ? MAX_PORT_FRAME : MAX_FRAME)) out(f);
      }
      return 0;
    },
    reset() {
      rx.length = 0;
      frames.length = 0;
      ready.length = 0;
      if (flapping) {
        clearTimeout(flapping);
        flapping = undefined;
        ctx.config()[6] = 1;
      }
    },
    // Only a card the page settles (its link): the gateway's, whose switches to the local helper's frames flap.
    restored() {
      if (link) holding = true; // bounded from the connection (`connected`): HOLD_MS
    },
    close: () => {
      clearTimeout(flapping);
      clearTimeout(hold);
      link?.close();
      if (framesTo !== adapter) framesTo?.close?.();
      adapter.close?.();
    },
  };
}

// virtio-input config selectors (virtio 1.2 §5.8.2) and the event types we use.
const CFG_ID_NAME = 1;
const CFG_ID_DEVIDS = 3;
const CFG_PROP_BITS = 0x10;
const CFG_EV_BITS = 0x11;
const CFG_ABS_INFO = 0x12;
const EV_KEY = 1;
const EV_REL = 2;
const EV_ABS = 3;
const EV_LED = 0x11;
const EV_REP = 0x14;
const INPUT_PROP_DIRECT = 1;
const ABS_MT_SLOT = 0x2f,
  ABS_MT_POSITION_X = 0x35,
  ABS_MT_POSITION_Y = 0x36,
  ABS_MT_TRACKING_ID = 0x39;
/** The touchscreen's slots (fingers at once). */
export const TOUCH_SLOTS = 10;
/** BTN_LEFT, RIGHT, MIDDLE, SIDE, EXTRA (a mouse's back and forward). */
const POINTER_BUTTONS = [0x110, 0x111, 0x112, 0x113, 0x114];

/** A bitmap with `bits` set, as the config space carries it. */
function bitmap(bits: number[]) {
  const b = new Uint8Array((Math.max(...bits) >> 3) + 1);
  for (const k of bits) b[k >> 3] |= 1 << (k & 7);
  return b;
}

/** An axis's range as ABS_INFO carries it: min, max, fuzz, flat, res. */
const absInfo = (min: number, max: number) => new Uint8Array(new Int32Array([min, max, 0, 0, 0]).buffer);

/** What each kind is called and its product id (BUS_VIRTUAL, vendor 0). */
const INPUT_IDS = {
  keyboard: ['waarm64 keyboard', 1],
  tablet: ['waarm64 tablet', 2],
  mouse: ['waarm64 mouse', 3],
  touch: ['waarm64 touchscreen', 4],
} as const;

/** The answer to a config query (select, subsel) about an input device of `kind`. */
export function inputConfig(kind: InputSpec['kind'], select: number, subsel: number): Uint8Array {
  const none = new Uint8Array(0);
  switch (select) {
    case CFG_ID_NAME:
      return new TextEncoder().encode(INPUT_IDS[kind][0]);
    case CFG_ID_DEVIDS:
      return new Uint8Array(new Uint16Array([6, 0, INPUT_IDS[kind][1], 1]).buffer); // BUS_VIRTUAL, vendor, product, version
    case CFG_PROP_BITS:
      return kind === 'touch' && subsel === 0 ? bitmap([INPUT_PROP_DIRECT]) : none;
    case CFG_EV_BITS:
      switch (kind) {
        case 'keyboard':
          if (subsel === EV_KEY) return bitmap(Array.from({ length: 248 }, (_, k) => k + 1)); // KEY_ESC to KEY_MICMUTE
          if (subsel === EV_LED) return bitmap([0, 1, 2]); // Num, Caps, Scroll Lock
          if (subsel === EV_REP) return new Uint8Array(1); // autorepeat (the kernel's)
          return none;
        case 'tablet':
          if (subsel === EV_KEY) return bitmap(POINTER_BUTTONS);
          if (subsel === EV_REL) return bitmap([6, 8, 11, 12]); // REL_HWHEEL, REL_WHEEL, REL_WHEEL_HI_RES, REL_HWHEEL_HI_RES
          if (subsel === EV_ABS) return bitmap([0, 1]); // ABS_X, ABS_Y
          return none;
        case 'mouse':
          if (subsel === EV_KEY) return bitmap(POINTER_BUTTONS);
          if (subsel === EV_REL) return bitmap([0, 1, 6, 8, 11, 12]); // REL_X, REL_Y and the tablet's wheels
          return none;
        case 'touch':
          if (subsel === EV_KEY) return bitmap([0x14a]); // BTN_TOUCH
          if (subsel === EV_ABS)
            return bitmap([0, 1, ABS_MT_SLOT, ABS_MT_POSITION_X, ABS_MT_POSITION_Y, ABS_MT_TRACKING_ID]);
          return none;
      }
      return none;
    case CFG_ABS_INFO:
      if ((kind === 'tablet' || kind === 'touch') && subsel <= 1) return absInfo(0, 32767);
      if (kind !== 'touch') return none;
      if (subsel === ABS_MT_POSITION_X || subsel === ABS_MT_POSITION_Y) return absInfo(0, 32767);
      if (subsel === ABS_MT_SLOT) return absInfo(0, TOUCH_SLOTS - 1);
      if (subsel === ABS_MT_TRACKING_ID) return absInfo(0, 65535);
      return none;
    default:
      return none;
  }
}

const INPUT_QUEUE = 1024; // events held while the guest has posted no event buffer

/**
 * Trims queued virtio-input events to at most `max` by dropping the oldest whole frames (through a SYN_REPORT), so the
 * guest never gets a frame without its head; a frame cut with no SYN_REPORT after the cut goes whole.
 */
export function trimInput(events: number[][], max = INPUT_QUEUE): void {
  const excess = events.length - max;
  if (excess <= 0) return;
  let end = events.findIndex((e, i) => i >= excess - 1 && e[0] === 0 && e[1] === 0);
  if (end < 0) end = events.length - 1;
  events.splice(0, end + 1);
}

/**
 * virtio-input: events from `port` fill the guest's event buffers, 8 bytes
 * each (type u16, code u16, value s32), the oldest frames dropped past INPUT_QUEUE (`trimInput`);
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
    if (e.some((x) => x[0] === 1)) busy.events?.push(performance.timeOrigin + performance.now(), 1);
    events.push(...e);
    trimInput(events);
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
export type Source = {
  size: number;
  read(off: number, len: number): Uint8Array | undefined;
  close?(): void;
  /** What a read of [off, off + len) fetches anyway, if more (a chunked image's whole piece where the host has no ranges): a cache asks for all of it and keeps it. */
  span?(off: number, len: number): [number, number];
  /** The same as `read`, without blocking (`fetch`: a remote disk's, which several requests then read at once, R4). */
  readAsync?(off: number, len: number): Promise<Uint8Array | undefined>;
  /** The 4 KiB blocks that may read as other than zeros, ascending (every other block reads as zeros), where the source knows them: a stored disk's held blocks, a blank disk's none. */
  held?(): Iterable<number>;
  /** Its block map, where it is one (a stored disk's: web/stored.ts `blockSource`; a blank disk's, empty), read-only (web/surface.ts). */
  leaves?(): Pick<MapLeaves, 'top' | 'recs' | 'n'>;
  /** Which of its file's bytes are here without a fetch, in blocks of `block` bytes (a remote image's: in the block cache's memory or kept in OPFS; web/blockcache.ts), read-only (web/surface.ts). */
  kept?: { block: number; has(k: number): boolean };
};

/**
 * An image over HTTP range requests: synchronous XHRs (workers only), which block the thread, or `fetch` (`readAsync`),
 * which doesn't: the device worker in realtime mode reads by `fetch`, several requests at once, and the rest (the
 * deterministic mode, the image's header and tables at its opening, the disk jobs' workers) synchronously. The device
 * worker reads it through a block cache (web/blockcache.ts).
 */
export function httpSource(url: string): Source & { validator?: string } {
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
    // What says the file changed (for the cache kept in OPFS): its ETag, or its modification time.
    validator: head.getResponseHeader('etag') ?? head.getResponseHeader('last-modified') ?? undefined,
    read(off, len) {
      const x = xhr('GET', `bytes=${off}-${off + len - 1}`);
      const b = x.response as ArrayBuffer | null;
      return x.status === 206 && b?.byteLength === len ? new Uint8Array(b) : undefined;
    },
    async readAsync(off, len) {
      try {
        const r = await fetch(url, { headers: { Range: `bytes=${off}-${off + len - 1}` } });
        const b = r.status === 206 ? new Uint8Array(await r.arrayBuffer()) : (void r.body?.cancel(), undefined);
        return b?.length === len ? b : undefined;
      } catch {
        return undefined; // the network
      }
    },
  };
}

/**
 * A disk on a web server, as the device worker reads it: a chunked image (by its manifest) or a file, through the block
 * cache, over the blocks kept in OPFS where the image has an identity that changes with it (a chunked image's id, a
 * server's validator) and this browser has room (web/diskcache.ts). `chunked`: a chunked image's content id, which its
 * manifest must name.
 */
async function remoteSource(url: string, keep: boolean, realtime: boolean, chunked?: string) {
  const src = isManifestUrl(url) ? chunkedSource(url, undefined, chunked) : httpSource(url);
  const identity =
    'manifest' in src
      ? `chunked:${src.manifest.id}`
      : src.validator
        ? JSON.stringify({ url, size: src.size, validator: src.validator })
        : undefined;
  const store =
    identity && keep
      ? await openBlockStore(await cacheKey(identity), src.size, BLOCK_CACHE.block).catch(() => undefined)
      : undefined;
  const cached = cachedSource(src, BLOCK_CACHE, store);
  // A chunked image's boot trace, fetched ahead of the guest (realtime: the deterministic mode reads one at a time).
  const trace = 'manifest' in src ? src.manifest.prefetch : undefined;
  if (trace && realtime) void cached.prefetch(reblock(trace.blocks, trace.block, BLOCK_CACHE.block));
  return cached;
}

/** Blocks of `from` bytes as the blocks of `to` bytes that cover them, in the same order (each once). */
function reblock(blocks: number[], from: number, to: number) {
  if (from === to) return blocks;
  const out = new Set<number>();
  for (const b of blocks)
    for (let k = Math.floor((b * from) / to); k <= Math.floor(((b + 1) * from - 1) / to); k++) out.add(k);
  return [...out];
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
  d.identity ??
  JSON.stringify(
    d.file
      ? { file: (d.file as File).name, bytes: d.file.size, modified: (d.file as File).lastModified, size }
      : d.url
        ? { path: new URL(d.url, 'http://x').pathname, size }
        : { source: d.source, size },
  );

/** A blank disk's bytes: zeros. */
export const zeroSource = (size: number): Source => ({
  size,
  read: (off, len) => (off >= 0 && off + len <= size ? new Uint8Array(len) : undefined),
  held: () => [],
  leaves: () => NO_LEAVES,
});
/** A map with nothing in it (a blank disk's). */
const NO_LEAVES = { top: new Uint32Array(0), recs: new Uint32Array(0), n: 0 };

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
 * virtio-blk over a `Source` (HTTP ranges, or a file in Node). qcow2's compressed
 * clusters are inflated a request's together (web/deflate.ts; on web/inflate-pool.ts's
 * workers too where there are workers). Read-only, or
 * writable through an overlay on OPFS; with `discard`, DISCARD and WRITE_ZEROES
 * reach the overlay (`deviceEntry` offers them).
 */
/**
 * A virtio-blk device over `src`, writable through `files` (an overlay) or by `src` itself (a ramdisk). `onFull`: a write
 * the browser's storage refused (a short write, `QuotaExceededError`) failed the guest's request, told once until a
 * write lands again (a ramdisk says so through its own `onFull`). `size`: the disk's size as the guest sees it (the
 * spec's), which an overlay over a smaller image grows to (docs/machines.md §4.5; its meta's own size counts too);
 * `diskSize`: then a stored or blank source's own size (its source is opened at the guest's), for the surface alone.
 */
export function blk(
  ctx: Ctx,
  src: Source | WritableDisk,
  files?: OverlayFiles,
  discard = false,
  st?: IoStats,
  serial = 'waarm64-blk',
  concurrent = false,
  onFull?: () => void,
  size?: number,
  diskSize?: number,
): Backend {
  let rw: WritableDisk | undefined;
  let base: Disk;
  let pool: ReturnType<typeof inflatePool> | undefined;
  const plain = src; // before the stats' wrapping: the surface's reads aren't the guest's
  if ('write' in src) {
    base = rw = src; // a disk that takes writes in itself (a ramdisk)
  } else {
    if (st) {
      const { read, readAsync } = src;
      src = {
        ...src,
        read: (off, len) => st.read(off, len, () => read(off, len)),
        readAsync: readAsync && ((off, len) => st.readAsync(off, len, () => readAsync(off, len))),
      };
      if (files) files = { ...files, data: st.file('data', files.data), map: st.file('map', files.map) };
    }
    const s = src;
    pool = typeof Worker === 'function' ? inflatePool() : undefined; // Node has none
    concurrent &&= !!s.readAsync;
    base = openDisk(
      (off, len) => (len === 0 ? new Uint8Array(0) : s.read(off, len)),
      s.size,
      pool,
      concurrent ? (off, len) => (len === 0 ? Promise.resolve(new Uint8Array(0)) : s.readAsync!(off, len)) : undefined,
    );
    rw = files && overlay(base, files.data, files.map, files.meta, size);
  }
  const disk: Disk = rw ?? base;
  const io = ctx.io ?? new Float64Array(2); // bytes read, written (completed requests)
  /** Whether the user was told the storage is full (since the last write that landed). */
  let told = false;
  /**
   * A write: true when it landed; false when it failed, with `onFull` told when the storage refused it (a write that
   * returns false is a short write or a refused one; `QuotaExceededError` is thrown by some sync handles).
   */
  const attempt = async (w: () => Promise<boolean>): Promise<boolean | 'full'> => {
    let full: boolean;
    try {
      if (await w()) return true;
      full = true;
    } catch (e) {
      full = (e as DOMException)?.name === 'QuotaExceededError' || msgOf(e)?.key === 'disks:overlay.storageFull';
    }
    return full ? 'full' : false;
  };
  /**
   * A change to the overlay (a write, a zeroing, a discard): true when it landed. One the storage refused (most likely
   * OPFS over the quota) gets the remote disks' kept blocks out of the way and is tried once more; still refused, the
   * user is told (`outcome`).
   */
  const change = async (w: () => Promise<boolean>) => {
    let tried = await attempt(w);
    if (tried !== true && releaseStores()) tried = await attempt(w);
    return outcome(tried);
  };
  const outcome = (r: boolean | 'full') => {
    if (r === true) told = false;
    else if (r === 'full' && onFull && !told) {
      told = true;
      onFull();
    }
    return r === true;
  };
  const backend: Backend = {
    async request(r) {
      const ram = ctx.ram();
      const last = r.write.at(-1);
      if (!last || last.len === 0) return 0; // no status byte: nothing to answer with
      // Data: every writable byte but the status byte at the end.
      const data = [...r.write.slice(0, -1), { ...last, len: last.len - 1 }];
      const room = data.reduce((n, s) => n + s.len, 0);
      const h = new DataView(gather(ram, r.read, 16).slice().buffer);
      const op = h.byteLength === 16 ? h.getUint32(0, true) : -1;
      if (st)
        st.size(
          ({ 0: 'read', 1: 'write', 4: 'flush' } as Record<number, string>)[op] ?? `op${op}`,
          op === T_OUT ? r.read.reduce((k, x) => k + x.len, 0) - 16 : room,
        );
      let [status, n] = [S_UNSUPP, 0];
      if (h.byteLength === 16 && h.getUint32(0, true) === T_IN) {
        const bytes = await disk.read(Number(h.getBigUint64(8, true)) * 512, room).catch(() => undefined); // IOERR, not a failed device
        if (bytes) st ? st.time('scatter', bytes.length, () => scatter(ram, data, bytes)) : scatter(ram, data, bytes);
        [status, n] = bytes ? [S_OK, room] : [S_IOERR, 0];
        if (bytes) io[0] += room;
      } else if (h.byteLength === 16 && h.getUint32(0, true) === T_GET_ID) {
        const id = new Uint8Array(20);
        id.set(new TextEncoder().encode(serial).subarray(0, 20));
        scatter(ram, data, id.subarray(0, room));
        [status, n] = [S_OK, Math.min(room, 20)];
      } else if (h.byteLength === 16 && h.getUint32(0, true) === T_OUT) {
        // The data follows the header in the readable buffers. Read-only: IOERR.
        const len = r.read.reduce((k, s) => k + s.len, 0);
        const payload = st ? st.time('gather', len, () => gather(ram, r.read, len)) : gather(ram, r.read, len);
        const ok = rw
          ? await change(() => rw!.write(Number(h.getBigUint64(8, true)) * 512, payload.subarray(16)))
          : false;
        status = ok ? S_OK : S_IOERR;
        if (ok) io[1] += len - 16;
      } else if (h.byteLength === 16 && h.getUint32(0, true) === T_FLUSH && rw) {
        st ? st.time('flush', 0, () => rw.flush()) : rw.flush();
        status = S_OK;
      } else if (
        h.byteLength === 16 &&
        (h.getUint32(0, true) === T_DISCARD || h.getUint32(0, true) === T_WRITE_ZEROES) &&
        rw &&
        discard
      ) {
        // One segment after the header (max_*_seg is 1): sector (u64), sectors (u32), flags (u32; bit 0: unmap,
        // which a WRITE_ZEROES may set and we always do, and a DISCARD must not: UNSUPP, as for unknown flags).
        const zeroes = h.getUint32(0, true) === T_WRITE_ZEROES;
        const len = r.read.reduce((k, s) => k + s.len, 0);
        const seg = new DataView(gather(ram, r.read, len).slice(16).buffer);
        if (seg.byteLength !== 16) status = S_IOERR;
        else if (seg.getUint32(12, true) & (zeroes ? ~1 : ~0)) status = S_UNSUPP;
        else {
          const [off, bytes] = [Number(seg.getBigUint64(0, true)) * 512, seg.getUint32(8, true) * 512];
          const ok =
            bytes <= BLK_MAX_UNMAP_SECTORS * 512 &&
            off + bytes <= disk.size &&
            (await change(zeroes ? () => rw.zero(off, bytes) : async () => rw.discard(off, bytes)));
          status = ok ? S_OK : S_IOERR;
        }
      }
      bytes(ram, last)[last.len - 1] = status;
      return n + 1;
    },
    reset() {},
    // For a snapshot, the VM paused: the blocks, and the generation it pins, with the next change set to move it on.
    written:
      rw &&
      (() => {
        const generation = rw.generation?.();
        rw.epoch?.();
        return { blocks: blockList(rw), generation };
      }),
    blocks:
      rw &&
      ((blocks) => {
        if (rw.blocks) {
          // An overlay's: runs of slots in one read each.
          const out = rw.blocks(blocks);
          if (!out)
            throw new Error(
              `the disk's changes can't be read from the browser's storage (blocks ${blocks[0]} to ${blocks[blocks.length - 1]})`,
            );
          return out;
        }
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
      pool?.close();
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
  if (concurrent) {
    // Several requests at once (`Devices.poll` completes them as they resolve, realtime only): a read starts once the
    // last write, flush or discard before it ended; any other request waits for every request before it (the overlay
    // changes one request at a time, and a FLUSH covers the writes completed before it).
    const request = backend.request;
    let barrier: Promise<unknown> = Promise.resolve();
    const inflight = new Set<Promise<number>>();
    backend.concurrent = true;
    backend.request = (r) => {
      const h = gather(ctx.ram(), r.read, 16);
      const read = h.byteLength === 16 && new DataView(h.slice().buffer).getUint32(0, true) === T_IN;
      const p = (read ? barrier : Promise.all(inflight)).then(() => request.call(backend, r)) as Promise<number>;
      inflight.add(p);
      const settled = p.then(
        () => {},
        () => {},
      );
      void settled.then(() => inflight.delete(p));
      if (!read) barrier = settled;
      return p;
    };
  }
  if (rw?.compact && rw.bytes) {
    // The compaction moves blocks between slots: it runs with none of the disk's requests in flight (one may wait on
    // the base's bytes with slots taken), and whole, synchronously, so none starts meanwhile.
    const [request, compact, size] = [backend.request, rw.compact, rw.bytes];
    const running = new Set<Promise<unknown>>();
    backend.request = (r) => {
      const p = request.call(backend, r);
      if (p instanceof Promise) {
        running.add(p);
        void p.then(
          () => running.delete(p),
          () => running.delete(p),
        );
      }
      return p;
    };
    backend.compact = async (measure) => {
      const before = size();
      if (measure) return { before, after: before };
      while (running.size) await Promise.allSettled(running);
      compact(); // a failed move leaves the block where it was (copied before its map entry moves)
      return { before, after: size() };
    };
  }
  const inspector = blkInspector(ctx, backend, plain, base, files ? rw : undefined, diskSize);
  backend.inspect = inspector.inspect;
  const close = backend.close!;
  backend.close = () => {
    inspector.close(); // the activity wrapper off, its timer gone
    close();
  };
  return backend;
}

/**
 * What a blk request reads or changes, as ranges (4 MiB): the first, the last, and whether it changes them (a write, a
 * zeroing, a discard); undefined for any other request. Its 16-byte header as `blk` reads it (a DISCARD's or a
 * WRITE_ZEROES' segment after it).
 */
function rangesOfRequest(ram: Ram, r: Request): [number, number, boolean] | undefined {
  const h = gather(ram, r.read, 32).slice();
  if (h.byteLength < 16) return undefined;
  const v = new DataView(h.buffer);
  const op = v.getUint32(0, true);
  let [off, len] = [Number(v.getBigUint64(8, true)) * 512, 0];
  if (op === T_IN) len = r.write.reduce((k, x) => k + x.len, 0) - 1;
  else if (op === T_OUT) len = r.read.reduce((k, x) => k + x.len, 0) - 16;
  else if ((op === T_DISCARD || op === T_WRITE_ZEROES) && h.byteLength === 32)
    [off, len] = [Number(v.getBigUint64(16, true)) * 512, v.getUint32(24, true) * 512];
  else return undefined;
  if (len <= 0) return undefined;
  return [Math.floor(off / RANGE), Math.floor((off + len - 1) / RANGE), op !== T_IN];
}

/**
 * A blk device's answers about its surface (web/surface.ts `diskInspector`): its disk (`src`: a ramdisk's chunks, a
 * stored or blank disk's map, an image's size alone) and its overlay (`ov`). The activity wrapper goes around the
 * outermost `backend.request` (the stats', concurrent and compaction wrappers are made before it, at the build, and
 * `Devices` calls `request` from the backend at each request), and the request it wrapped is put back as it was.
 */
function blkInspector(
  ctx: Ctx,
  backend: Backend,
  src: Source | WritableDisk,
  base: Disk,
  ov: WritableDisk | undefined,
  diskSize?: number,
) {
  let disk: LiveDisk['disk'];
  if ('write' in src) {
    const ram = src;
    disk = {
      kind: 'ram',
      id: 'disk',
      size: ram.size,
      get chunks() {
        return ram.chunkKeys?.() ?? [];
      },
      read: (b) => ram.block(b),
    };
  } else if (src.leaves) {
    // A stored or blank disk under a grown overlay is opened at the guest's size: its own is the spec's `diskSize`.
    const [s, own] = [src, Math.min(src.size, diskSize ?? src.size)];
    disk = {
      kind: 'map',
      id: 'disk',
      size: own,
      leaves: s.leaves!(),
      read: (b) => (b * 4096 < own ? s.read(b * 4096, Math.min(4096, own - b * 4096)) : undefined),
    };
  } else disk = liveImage(src, base);
  const o = ov?.leaves && ov;
  let inner: Backend['request'] | undefined;
  return diskInspector(
    {
      disk,
      overlay: o ? { id: 'overlay', size: o.size, leaves: () => o.leaves!(), read: (b) => o.block(b) } : undefined,
    },
    {
      install(mark) {
        const request = (inner = backend.request);
        backend.request = (r) => {
          const span = rangesOfRequest(ctx.ram(), r);
          if (span) mark(...span);
          const p = request.call(backend, r);
          // A change counted again once it ended (an answer between its start and its end saw it half made).
          if (span?.[2] && p instanceof Promise)
            void p.then(
              () => mark(...span),
              () => {},
            );
          return p;
        };
      },
      uninstall() {
        if (inner) backend.request = inner;
        inner = undefined;
      },
    },
  );
}

/**
 * A running image's disk layer (web/surface.ts `LiveImage`), examined at an inspect, never on a request's path: a
 * qcow2's clusters from its L2 tables, those not read yet read once from a local file (a bounded read: qcow2.ts
 * `ALLOCATION_MAX`; past it, the tables the guest has read) but from a remote image only where the block cache or OPFS
 * holds them (nothing is fetched for the map): what's under the others isn't examined yet; a raw image not examined. A
 * remote image's with the blocks this browser keeps. The content check reads a local qcow2's blocks of data (through
 * the image), no raw image's and no remote one's.
 */
function liveImage(src: Source, base: Disk): LiveDisk['disk'] {
  const kept = src.kept;
  const here = (off: number, len: number) => {
    if (!kept) return true;
    for (let k = Math.floor(off / kept.block); k <= Math.floor((off + len - 1) / kept.block); k++)
      if (!kept.has(k)) return false;
    return true;
  };
  const size = base.size;
  const examine = (): ReturnType<LiveImage['examine']> => {
    if (base.format === 'raw' || !base.allocation)
      return { kind: 'opaque', id: 'disk', size, why: 'raw', ...(kept ? { kept } : {}) };
    const allocation = base.allocation((off, n) => (here(off, n) ? src.read(off, n) : undefined));
    return {
      kind: 'clusters',
      id: 'disk',
      size,
      allocation,
      why: kept ? 'tables' : 'large',
      ...(kept ? { kept } : {}),
    };
  };
  // A raw image's blocks aren't examined (nor read); a remote qcow2's would be fetched.
  const read = (b: number) =>
    base.format === 'raw' || kept ? undefined : base.read(b * 4096, Math.min(4096, size - b * 4096));
  return { kind: 'image', id: 'disk', size, examine, read };
}

/** Rings the doorbell; with `wait`, returns once the backends took everything up to this ring. */
export function ring(bell: Int32Array, wait: boolean) {
  const n = Atomics.add(bell, 0, 1) + 1;
  Atomics.notify(bell, 0);
  if (!wait) return;
  // Other threads ring too: the backends may have handled past `n` (wrapping compare).
  for (let a; (((a = Atomics.load(bell, 1)) - n) | 0) < 0;) {
    if (a === -1) throw new Error('device backends failed (see their error)');
    Atomics.wait(bell, 1, a, 1000);
  }
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
      state,
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
    const spillViews = spill.map((m) => new Uint8Array(m.buffer));
    const layout =
      given ??
      ramLayout(
        ramSize,
        spill.map((m) => m.buffer.byteLength),
      );
    this.backends = specs.map((d, i) => {
      const ctx: Ctx = {
        ram: () => [new Uint8Array(this.memory.buffer, ram), ...spillViews],
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
                window: d.noWatch ? { ...window, watch: 0 } : window,
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
    if (state) {
      if (state.length !== specs.length) throw new Error('the snapshot is of a machine with other devices');
      // The devices are as the snapshot left them (their epoch is not a reset), with the backends' state.
      const u32 = new Uint32Array(memory.buffer);
      this.epochs = shared.map((at) => Atomics.load(u32, (at + EPOCH) / 4) & 0xff);
      this.backends.forEach((b, i) => {
        if (state[i] !== null && state[i] !== undefined) b.restore?.(state[i]);
      });
      for (const b of this.backends) b.restored?.();
    }
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

  /** Builds the backends, opening any overlays first (OPFS handles are created asynchronously). */
  /** `notice`: what the page should tell the user while the machine runs on (a ramdisk out of memory, the storage full). */
  static async open(
    init: DevicesInit,
    out: (device: number, text: string) => void,
    notice: (m: Msg) => void = () => {},
  ) {
    if (init.core) void coreModule(init.core);
    // A stored disk written in place is opened as its store is for any writer: an interrupted merge is finished first.
    const overlays = await Promise.all(
      init.specs.map((d) =>
        d.type !== 'blk' || !d.overlay
          ? undefined
          : d.overlay.startsWith('disks/')
            ? openStoredForWriting(d.overlay, diskIdentity(d, d.size ?? 0), d.size ?? 0)
            : openOverlay(d.overlay, diskIdentity(d, d.size ?? 0)),
      ),
    );
    const sources = await Promise.all(
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
    );
    // At most once a minute for all disks: while it's full, overwrites of blocks an overlay holds still land (they
    // don't grow its file), and each disk tells again after one.
    let toldAt = -Infinity;
    const full = () => {
      if (performance.now() - toldAt < FULL_REPEAT_MS) return;
      toldAt = performance.now();
      void storageFull().then(notice);
    };
    return new Devices(init, overlays, sources, out, full);
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
    // Compiled code stops at its next poll (docs/abi.md "PERF: the stop word").
    for (const p of this.stops ?? []) Atomics.store(new Int32Array(this.memory.buffer, p, 1), 0, 0);
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
    } finally {
      turn.port1.close();
    }
  }
}
