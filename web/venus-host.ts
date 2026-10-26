// Venus's renderer on the host (docs/devices.md "Venus"; vk/README.md): the module vk/build.sh makes (virglrenderer's
// vkr over our Vulkan driver), instantiated on the VM's memory 0, so the guest's rings, command streams and mapped
// memory in the host-visible window are its own pointers. It runs the device's Venus calls (web/virgl-host.ts
// `VenusCall`) and polls the rings while they are active (an idle ring waits for the guest's notify). The driver's
// WebGPU calls are web/venus-gpu.ts's, on the GPU worker's device; at each submit the driver takes the window's written
// pages (web/window.ts) and uploads them. Its submits complete later, and a fenced submit's fence retires only then:
// `settled` says when the fences sent so far have.
import { gpuFeatures, maxImmediates, VenusGpu } from './venus-gpu.ts';
import type { VenusCall } from './virgl-host.ts';
import { WindowWatch } from './window.ts';

/** Where the module finds the window: its address in memory 0, its bytes, and the write-watch's words. */
export type VenusWindow = { at: number; bytes: number; watch: number };

export type VenusStats = { submits: number; completed: number; fences: number; polls: number; dirtyPages: number; dirtyLooks: number; contexts: number };

type Exports = {
  _initialize(): void;
  venus_init(features: number, maxImmediates: number, window: number, windowBytes: number): number;
  venus_complete(serial: number): void;
  venus_capset(out: number): number;
  venus_context_create(ctx: number, name: number, nlen: number): number;
  venus_context_destroy(ctx: number): void;
  venus_submit(ctx: number, cmd: number, size: number): number;
  venus_submit_fence(ctx: number, flags: number, ring: number, fence: bigint): number;
  venus_resource_create(ctx: number, res: number, blobId: bigint, size: bigint, flags: number): number;
  venus_resource_destroy(ctx: number, res: number): void;
  venus_resource_map(ctx: number, res: number, where: number): number;
  venus_resource_unmap(ctx: number, res: number): number;
  venus_poll(): number;
  venus_resource_data(ctx: number, res: number): number;
  venus_resource_texture(ctx: number, res: number): number;
  venus_alloc(size: number): number;
  venus_free(p: number): void;
};

/** The WASI calls the module imports, stubbed: no files, no environment, the clock from `performance.now()`. */
function wasi(memory: WebAssembly.Memory) {
  const dv = () => new DataView(memory.buffer);
  const EBADF = 8, ENOSYS = 52;
  let line = '';
  return {
    clock_time_get: (_id: number, _precision: bigint, out: number) => { dv().setBigUint64(out >>> 0, BigInt(Math.round(performance.now() * 1e6)), true); return 0; },
    // Pointers past 2 GiB (the module's stack and heap are in the arena at memory 0's top) come as negative i32s.
    fd_write: (fd: number, iovs: number, n: number, written: number) => {
      iovs >>>= 0;
      written >>>= 0;
      let len = 0;
      for (let i = 0; i < n; i++) {
        const p = dv().getUint32(iovs + i * 8, true), l = dv().getUint32(iovs + i * 8 + 4, true);
        if (fd === 2) line += new TextDecoder().decode(new Uint8Array(memory.buffer, p, l).slice());
        len += l;
      }
      for (let k; (k = line.indexOf('\n')) >= 0; line = line.slice(k + 1)) console.warn(`venus: ${line.slice(0, k)}`);
      dv().setUint32(written, len, true);
      return 0;
    },
    environ_get: () => 0,
    environ_sizes_get: (count: number, size: number) => { dv().setUint32(count >>> 0, 0, true); dv().setUint32(size >>> 0, 0, true); return 0; },
    fd_close: () => 0, fd_fdstat_get: () => EBADF, fd_fdstat_set_flags: () => ENOSYS, fd_prestat_get: () => EBADF,
    fd_prestat_dir_name: () => EBADF, fd_read: () => EBADF, fd_seek: () => EBADF, path_open: () => ENOSYS,
    sched_yield: () => 0,
    proc_exit: (code: number) => { throw new Error(`venus: proc_exit(${code})`); },
  };
}

export class VenusRenderer {
  readonly stats: VenusStats = { submits: 0, completed: 0, fences: 0, polls: 0, dirtyPages: 0, dirtyLooks: 0, contexts: 0 };
  /** The VENUS capset vkr writes (the device's `venusCaps`). */
  readonly capset: Uint8Array;
  private readonly ex: Exports;
  private readonly memory: WebAssembly.Memory;
  private readonly window: VenusWindow;
  /** The window's write-watch; none with `watch` 0 (`?gpu=vulkan,nowatch`). */
  private readonly watch: WindowWatch | undefined;
  /** A resource's context (the device names blobs by resource alone). */
  private readonly owner = new Map<number, number>();
  /** Fences sent to vkr and not yet retired ("ctx:ring:id"). */
  private readonly pending = new Set<string>();
  private pollTimer: ReturnType<typeof setTimeout> | undefined;
  /** Called when fences retire (the GPU worker answers the fences it held for them). */
  onRetire: (() => void) | undefined;
  readonly gpu: VenusGpu;
  /** The module's exports as they are (tests/venus-driver.test.ts calls its test exports). */
  readonly raw: WebAssembly.Exports;

  private constructor(instance: WebAssembly.Instance, memory: WebAssembly.Memory, window: VenusWindow, gpu: VenusGpu, device: GPUDevice | undefined) {
    const ex = instance.exports as unknown as Exports;
    this.raw = instance.exports;
    // Its heap is in the arena at memory 0's top: past 2 GiB, which a wasm i32 gives JS as negative.
    this.ex = { ...ex, venus_alloc: (size: number) => ex.venus_alloc(size) >>> 0 };
    [this.memory, this.window] = [memory, window];
    this.watch = window.watch ? new WindowWatch(memory, window.watch) : undefined;
    this.gpu = gpu;
    this.ex._initialize();
    if (!this.ex.venus_init(gpuFeatures(device), maxImmediates(device), window.at, window.bytes)) throw new Error('venus: vkr_renderer_init failed');
    const p = this.ex.venus_alloc(4096);
    const n = this.ex.venus_capset(p);
    this.capset = new Uint8Array(memory.buffer, p, n).slice();
    this.ex.venus_free(p);
  }

  /**
   * The module (vk/build.sh's target/vk/venus.wasm) on `memory`, the VM's memory 0, which must be 4 GiB with its arena
   * unused; its driver draws on `device` (none: it keeps objects and draws nothing, as in Node's tests).
   */
  static async create(module: WebAssembly.Module, memory: WebAssembly.Memory, window: VenusWindow, device?: GPUDevice) {
    let self: VenusRenderer | undefined;
    const gpu = new VenusGpu(device, memory, (serial) => self?.completed(serial), () => self?.dirty());
    const imports = {
      env: {
        memory,
        venus_retire: (ctx: number, ring: number, fence: bigint) => { self?.retire(`${ctx}:${ring}:${fence}`); },
        venus_submitted: () => {},
      },
      wg: gpu.imports(),
      wasi_snapshot_preview1: wasi(memory),
      wasi: { 'thread-spawn': () => -1 },
    };
    const instance = await WebAssembly.instantiate(module, imports);
    self = new VenusRenderer(instance, memory, window, gpu, device);
    return self;
  }

  /** The window's pages written since the last look (undefined without a watch: all of them count). */
  private dirty() {
    if (!this.watch) return undefined;
    const pages = this.watch.take();
    this.stats.dirtyPages += pages.length;
    this.stats.dirtyLooks++;
    return pages;
  }

  private completed(serial: number) {
    this.ex.venus_complete(serial);
    this.stats.completed++;
    // The rings' fences retire at their next poll.
    this.ex.venus_poll();
    this.wake();
  }

  private retire(key: string) {
    this.stats.fences++;
    this.pending.delete(key);
    this.onRetire?.();
  }

  /** Whether the fences sent so far have retired (a closure over them, to check later). */
  settled(): () => boolean {
    if (!this.pending.size) return () => true;
    const keys = [...this.pending];
    return () => keys.every((k) => !this.pending.has(k));
  }

  /** Copies `bytes` into the module's heap for a call, then frees them. */
  private withBytes<T>(bytes: Uint8Array, f: (p: number) => T): T {
    const p = this.ex.venus_alloc(Math.max(bytes.length, 1));
    new Uint8Array(this.memory.buffer, p, bytes.length).set(bytes);
    try {
      return f(p);
    } finally {
      this.ex.venus_free(p);
    }
  }

  /** Runs one of the device's Venus calls (a fenced submit's fence retires later: `settled`). */
  call(c: VenusCall) {
    switch (c.t) {
      case 'vctx':
        if (c.create) {
          const name = new TextEncoder().encode(c.name ?? '');
          if (this.withBytes(name, (p) => this.ex.venus_context_create(c.id, p, name.length))) this.stats.contexts++;
          else console.warn(`venus: context ${c.id} couldn't be made`);
        } else {
          this.ex.venus_context_destroy(c.id);
          this.stats.contexts--;
          for (const [res, ctx] of this.owner) if (ctx === c.id) this.owner.delete(res);
        }
        return;
      case 'blob':
        if (this.ex.venus_resource_create(c.ctx, c.res, c.blobId, BigInt(c.size), c.flags)) this.owner.set(c.res, c.ctx);
        else console.warn(`venus: blob ${c.res} (object ${c.blobId}) couldn't be made`);
        return;
      case 'blob-map': {
        const ctx = this.owner.get(c.res);
        if (ctx === undefined || !this.ex.venus_resource_map(ctx, c.res, this.window.at + c.offset)) console.warn(`venus: blob ${c.res} couldn't be mapped`);
        return;
      }
      case 'blob-unmap': {
        const ctx = this.owner.get(c.res);
        if (ctx !== undefined) this.ex.venus_resource_unmap(ctx, c.res);
        return;
      }
      case 'blob-unref': {
        const ctx = this.owner.get(c.res);
        if (ctx !== undefined) this.ex.venus_resource_destroy(ctx, c.res);
        this.owner.delete(c.res);
        return;
      }
      case 'blob-ctx':
        return; // a blob lives in the context that made it; importing it into another isn't needed by Venus alone
      case 'vsubmit': {
        this.stats.submits++;
        if (!this.withBytes(c.bytes, (p) => this.ex.venus_submit(c.ctx, p, c.bytes.length))) console.warn(`venus: context ${c.ctx}'s submit failed`);
        const fence = c.fence;
        if (fence) {
          // Retired once the queue's work before it is done (`settled`); a ring fence of no queue's work retires at
          // the next poll.
          const key = `${c.ctx}:${fence.ring}:${fence.id}`;
          this.pending.add(key);
          this.ex.venus_submit_fence(c.ctx, fence.flags, fence.ring, fence.id);
        }
        this.wake();
        return;
      }
    }
  }

  /** A blob's bytes' address in memory 0 now (its storage, or the window while mapped), 0 for none. */
  address(res: number) {
    const ctx = this.owner.get(res);
    return ctx === undefined ? 0 : this.ex.venus_resource_data(ctx, res) >>> 0;
  }

  /** Whether `res` is one of Venus's blobs. */
  has(res: number) { return this.owner.has(res); }

  /**
   * The WebGPU texture of the image a blob was exported from (a WSI image, which the guest's compositor imports into
   * virgl: web/venus-share.ts), with the submit that last wrote it; the rings run first, so what the guest asked of
   * the queue before now has been submitted. Undefined: not an image's memory, or no device.
   */
  shared(res: number) {
    const ctx = this.owner.get(res);
    if (ctx === undefined) return undefined;
    this.stats.polls++;
    if (this.ex.venus_poll()) this.wake();
    const id = this.ex.venus_resource_texture(ctx, res);
    return id ? this.gpu.texture(id) : undefined;
  }

  /** Polls the rings until they are all idle again (a notify, a submit, wakes them). */
  wake() {
    if (this.pollTimer) return;
    const tick = () => {
      this.pollTimer = undefined;
      this.stats.polls++;
      if (this.ex.venus_poll()) this.pollTimer = setTimeout(tick, 0);
    };
    tick();
  }
}
