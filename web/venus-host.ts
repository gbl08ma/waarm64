// Venus's renderer on the host (docs/devices.md "Venus"; vk/README.md): the module vk/build.sh makes (virglrenderer's
// vkr over our Vulkan driver), instantiated on the VM's memory 0, so the guest's rings, command streams and mapped
// memory in the host-visible window are its own pointers. It runs the device's Venus calls (web/virgl-host.ts
// `VenusCall`), polls the rings while they are active (an idle ring waits for the guest's notify), and at each submit
// takes the window's written pages (web/window.ts: their count is VK1's statistic; VK2 uploads them).
import type { VenusCall } from './virgl-host.ts';
import { WindowWatch } from './window.ts';

/** Where the module finds the window: its address in memory 0, its bytes, and the write-watch's words. */
export type VenusWindow = { at: number; bytes: number; watch: number };

export type VenusStats = { submits: number; fences: number; polls: number; dirtyPages: number; dirtyLooks: number; contexts: number };

type Exports = {
  _initialize(): void;
  venus_init(): number;
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
  venus_alloc(size: number): number;
  venus_free(p: number): void;
};

/** The WASI calls the module imports, stubbed: no files, no environment, the clock from `performance.now()`. */
function wasi(memory: WebAssembly.Memory) {
  const dv = () => new DataView(memory.buffer);
  const EBADF = 8, ENOSYS = 52;
  let line = '';
  return {
    clock_time_get: (_id: number, _precision: bigint, out: number) => { dv().setBigUint64(out, BigInt(Math.round(performance.now() * 1e6)), true); return 0; },
    fd_write: (fd: number, iovs: number, n: number, written: number) => {
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
    environ_sizes_get: (count: number, size: number) => { dv().setUint32(count, 0, true); dv().setUint32(size, 0, true); return 0; },
    fd_close: () => 0, fd_fdstat_get: () => EBADF, fd_fdstat_set_flags: () => ENOSYS, fd_prestat_get: () => EBADF,
    fd_prestat_dir_name: () => EBADF, fd_read: () => EBADF, fd_seek: () => EBADF, path_open: () => ENOSYS,
    sched_yield: () => 0,
    proc_exit: (code: number) => { throw new Error(`venus: proc_exit(${code})`); },
  };
}

export class VenusRenderer {
  readonly stats: VenusStats = { submits: 0, fences: 0, polls: 0, dirtyPages: 0, dirtyLooks: 0, contexts: 0 };
  /** The VENUS capset vkr writes (the device's `venusCaps`). */
  readonly capset: Uint8Array;
  private readonly ex: Exports;
  private readonly memory: WebAssembly.Memory;
  private readonly window: VenusWindow;
  /** The window's write-watch; none with `watch` 0 (`?gpu=vulkan,nowatch`). */
  private readonly watch: WindowWatch | undefined;
  /** A resource's context (the device names blobs by resource alone). */
  private readonly owner = new Map<number, number>();
  /** Fences vkr retired, by context, ring and id ("ctx:ring:id"). */
  private readonly retired = new Set<string>();
  private pollTimer: ReturnType<typeof setTimeout> | undefined;

  private constructor(instance: WebAssembly.Instance, memory: WebAssembly.Memory, window: VenusWindow) {
    const ex = instance.exports as unknown as Exports;
    // Its heap is in the arena at memory 0's top: past 2 GiB, which a wasm i32 gives JS as negative.
    this.ex = { ...ex, venus_alloc: (size: number) => ex.venus_alloc(size) >>> 0 };
    [this.memory, this.window] = [memory, window];
    this.watch = window.watch ? new WindowWatch(memory, window.watch) : undefined;
    this.ex._initialize();
    if (!this.ex.venus_init()) throw new Error('venus: vkr_renderer_init failed');
    const p = this.ex.venus_alloc(4096);
    const n = this.ex.venus_capset(p);
    this.capset = new Uint8Array(memory.buffer, p, n).slice();
    this.ex.venus_free(p);
  }

  /** The module (vk/build.sh's target/vk/venus.wasm) on `memory`, the VM's memory 0, which must be 4 GiB with its arena unused. */
  static async create(module: WebAssembly.Module, memory: WebAssembly.Memory, window: VenusWindow) {
    let self: VenusRenderer | undefined;
    const imports = {
      env: {
        memory,
        venus_retire: (ctx: number, ring: number, fence: bigint) => { self?.retired.add(`${ctx}:${ring}:${fence}`); if (self) self.stats.fences++; },
        venus_submitted: () => { self?.submitted(); },
      },
      wasi_snapshot_preview1: wasi(memory),
      wasi: { 'thread-spawn': () => -1 },
    };
    const instance = await WebAssembly.instantiate(module, imports);
    self = new VenusRenderer(instance, memory, window);
    return self;
  }

  private submitted() {
    if (!this.watch) return;
    const pages = this.watch.take();
    this.stats.dirtyPages += pages.length;
    this.stats.dirtyLooks++;
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

  /** Runs one of the device's Venus calls; a fenced submit's fence is retired before this returns. */
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
          this.ex.venus_submit_fence(c.ctx, fence.flags, fence.ring, fence.id);
          const key = `${c.ctx}:${fence.ring}:${fence.id}`;
          // The null driver's work is done at its submit: a poll or two retires it. Bounded: a fence that doesn't come
          // is answered all the same (the guest waits on its own feedback anyway).
          for (let k = 0; k < 1000 && !this.retired.has(key); k++) this.ex.venus_poll();
          this.retired.delete(key);
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
