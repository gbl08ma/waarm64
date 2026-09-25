// virtio device backends (PLAN.md §2 "Device backends (ABI 6)"). The core runs
// the virtio-mmio transports and split queues and posts each descriptor chain
// to the device's request ring as RAM segments; backends here only speak the
// device protocol. `Devices` works on the shared memory from any thread: in the
// device worker (web/device-worker.ts) or inline on the vCPU thread.
import { splitmix64 } from '../tools/corpus/corpus.ts';
import { openDisk } from './qcow2.ts';

/**
 * Host-side device configuration, one per virtio-mmio slot (in order). `blk`
 * is a read-only disk image (raw or qcow2, web/qcow2.ts) read with HTTP range
 * requests; `size` (its virtual size in bytes, a multiple of 512) is filled in
 * by `bootVm` from the file's first bytes if missing.
 */
export type DeviceSpec = { type: 'console' } | { type: 'rng' } | { type: 'blk'; url: string; size?: number };

// virtio::DevShared layout (core/src/virtio.rs).
const EVENTS = 0;
const EPOCH = 16;
const CONFIG = 24;
const REQ = 280;
const RING_WORDS = 4096;
const CPL = REQ + 8 + 4 * RING_WORDS;
const SIGNAL_DEVICE = 4;

/** virtio::DeviceEntry (u64s) and the initial config space. */
export function deviceEntry(d: DeviceSpec): { entry: bigint[]; config: Uint8Array } {
  switch (d.type) {
    // id, features, queues, queue size, config length. Console: no optional
    // features, so one port (receiveq 0, transmitq 1); config is cols, rows,
    // max_nr_ports, emerg_wr, unused without them.
    case 'console': return { entry: [3n, 0n, 2n, 64n, 12n], config: new Uint8Array(12) };
    case 'rng': return { entry: [4n, 0n, 1n, 64n, 0n], config: new Uint8Array(0) };
    case 'blk': {
      // Features SEG_MAX (2) and RO (5); config: capacity in sectors (u64 at 0),
      // seg_max (u32 at 12) = queue size - 2, as QEMU.
      const config = new Uint8Array(16);
      const v = new DataView(config.buffer);
      v.setBigUint64(0, BigInt(Math.floor((d.size ?? 0) / 512)), true);
      v.setUint32(12, 126, true);
      return { entry: [2n, 1n << 2n | 1n << 5n, 1n, 128n, 16n], config };
    }
  }
}

type Segment = { off: number; len: number };
type Request = { w0: number; queue: number; read: Segment[]; write: Segment[] };
type Ctx = { ram: () => Uint8Array; complete: (w0: number, len: number) => void };

/**
 * A backend handles a request now (returns bytes written, or a promise of
 * them: requests complete in order either way), or keeps it and completes it later.
 */
type Backend = { request(r: Request): number | Promise<number> | undefined; reset(): void };

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

/** Bytes `n` onward of the concatenated segments, `len` of them. */
function gather(ram: Uint8Array, segs: Segment[], len: number) {
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
function scatter(ram: Uint8Array, segs: Segment[], data: Uint8Array) {
  let k = 0;
  for (const s of segs) {
    if (k === data.length) break;
    const n = Math.min(s.len, data.length - k);
    ram.set(data.subarray(k, k + n), s.off);
    k += n;
  }
}

// virtio-blk request types and status (virtio 1.2 §5.2.6).
const T_IN = 0;
const T_GET_ID = 8;
const S_OK = 0;
const S_IOERR = 1;
const S_UNSUPP = 2;

/**
 * Read-only virtio-blk over HTTP range requests: synchronous XHRs (workers
 * only), so the device worker simply blocks on the network. Only qcow2's
 * compressed clusters are asynchronous (DecompressionStream).
 */
// ponytail: one request at a time, no cache (the guest's page cache is the cache); batch or cache if an I/O benchmark says so.
function blk(ctx: Ctx, url: string): Backend {
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
  const disk = openDisk((off, len) => {
    if (len === 0) return new Uint8Array(0);
    const x = xhr('GET', `bytes=${off}-${off + len - 1}`);
    const b = x.response as ArrayBuffer | null;
    return x.status === 206 && b?.byteLength === len ? new Uint8Array(b) : undefined;
  }, Number(head.getResponseHeader('content-length')));
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
      } else if (h.byteLength === 16 && h.getUint32(0, true) === 1) {
        status = S_IOERR; // OUT on a read-only disk
      }
      ram[last.off + last.len - 1] = status;
      return n + 1;
    },
    reset() {},
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
  constructor({ memory, shared, ram, signal, specs, deterministic }: DevicesInit, out: (device: number, text: string) => void) {
    [this.memory, this.shared, this.signal] = [memory, shared, signal];
    this.backends = specs.map((d, i) => {
      const ctx: Ctx = { ram: () => new Uint8Array(this.memory.buffer, ram), complete: (w0, len) => this.complete(i, w0, len) };
      switch (d.type) {
        case 'console': return console_((t) => out(i, t), ctx);
        case 'rng': return rng(ctx, deterministic);
        case 'blk': return blk(ctx, d.url);
      }
    });
    this.epochs = specs.map(() => 0);
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
      Atomics.exchange(u32, base + EVENTS / 4, 0);
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
