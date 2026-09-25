// virtio device backends (PLAN.md §2 "Device backends (ABI 6)"). The core runs
// the virtio-mmio transports and split queues and posts each descriptor chain
// to the device's request ring as RAM segments; backends here only speak the
// device protocol. `Devices` works on the shared memory from any thread: in the
// device worker (web/device-worker.ts) or inline on the vCPU thread.
import { splitmix64 } from '../tools/corpus/corpus.ts';

/** Host-side device configuration, one per virtio-mmio slot (in order). */
export type DeviceSpec = { type: 'console' } | { type: 'rng' };

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
  }
}

type Segment = { off: number; len: number };
type Request = { w0: number; queue: number; read: Segment[]; write: Segment[] };
type Ctx = { ram: () => Uint8Array; complete: (w0: number, len: number) => void };

/** A backend handles a request now (returns bytes written), or keeps it and completes it later. */
type Backend = { request(r: Request): number | undefined; reset(): void };

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

function rng(ctx: Ctx): Backend {
  // Deterministic mode: the same bytes natively (core/tests/common) and here,
  // so boots keep one step count.
  // ponytail: crypto.getRandomValues once realtime mode exists.
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

export type DevicesInit = {
  memory: WebAssembly.Memory;
  /** Addresses in `memory` of each device's `virtio::DevShared`, of guest RAM and of the signal word. */
  shared: number[];
  ram: number;
  signal: number;
  specs: DeviceSpec[];
};

export class Devices {
  private memory: WebAssembly.Memory;
  private shared: number[];
  private signal: number;
  private backends: Backend[];
  private epochs: number[];
  /** `out` receives what a console device's guest side wrote. */
  constructor({ memory, shared, ram, signal, specs }: DevicesInit, out: (device: number, text: string) => void) {
    [this.memory, this.shared, this.signal] = [memory, shared, signal];
    this.backends = specs.map((d, i) => {
      const ctx: Ctx = { ram: () => new Uint8Array(this.memory.buffer, ram), complete: (w0, len) => this.complete(i, w0, len) };
      switch (d.type) {
        case 'console': return console_((t) => out(i, t), ctx);
        case 'rng': return rng(ctx);
      }
    });
    this.epochs = specs.map(() => 0);
  }

  /** Writes each device's initial config space (after vm_new, before the guest runs). */
  static writeConfig(memory: WebAssembly.Memory, shared: number[], specs: DeviceSpec[]) {
    specs.forEach((d, i) => new Uint8Array(memory.buffer).set(deviceEntry(d).config, shared[i] + CONFIG));
  }

  /** Takes every device's events and requests, completing what can be completed now. */
  poll() {
    const u32 = new Uint32Array(this.memory.buffer);
    this.backends.forEach((b, i) => {
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
        if (len !== undefined) this.complete(i, w0, len);
      }
    });
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
