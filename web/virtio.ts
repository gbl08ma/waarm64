// The host side of a virtio device (docs/devices.md): the layout the core shares with it (`virtio::DevShared`), a
// request as the core posts it, what a backend is, the segments' bytes, and the doorbell.
import type { WireError } from './msg.ts';
import type { InspectAnswer, InspectQuery } from './surface.ts';
import { bytes, type Ram, type RamLayout, type Segment } from './ram.ts';

// virtio::DevShared layout (core/src/virtio.rs).
export const EVENTS = 0;
export const FEATURES = 8;
export const EPOCH = 16;
export const CONFIG_GEN = 20;
export const CONFIG = 24;
export const REQ = 280;
export const RING_WORDS = 4096;
export const CPL = REQ + 8 + 4 * RING_WORDS;
export const SIGNAL_DEVICE = 4;
export const EV_CONFIG = 2;

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

/** Writes `data` across the segments, in order, from byte `skip` of them (what an earlier write put there stays). */
export function scatter(ram: Ram, segs: Segment[], data: Uint8Array, skip = 0) {
  let k = 0;
  for (const s of segs) {
    if (k === data.length) break;
    if (skip >= s.len) {
      skip -= s.len;
      continue;
    }
    const n = Math.min(s.len - skip, data.length - k);
    bytes(ram, s).set(data.subarray(k, k + n), skip);
    skip = 0;
    k += n;
  }
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
