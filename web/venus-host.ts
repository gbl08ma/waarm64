// Venus's renderer on the host (docs/devices.md "Venus"; vk/README.md): the module vk/build.sh makes (virglrenderer's
// vkr over our Vulkan driver), instantiated on the VM's memory 1 (its own, the window after its arena), so the guest's rings, command streams and mapped
// memory in the host-visible window are its own pointers. It runs the device's Venus calls (web/virgl-host.ts
// `VenusCall`) and polls the rings while they are active or a submit is in flight (`VenusPoll`; an idle ring waits for
// the guest's notify). The driver's WebGPU calls are web/venus-gpu.ts's, on the GPU worker's device; at each submit the
// driver takes the window's written pages (web/window.ts) and uploads them. Its submits complete later, and a fenced submit's fence retires only then:
// `retired` says when a fence has.
import type { ShaderCache } from './venus-cache.ts';
import { gpuFeatures, gpuLimits, HELD_FEATURES, VenusGpu, type GpuCaps, type L9Suspect } from './venus-gpu.ts';
import type { VenusCall } from './virgl-host.ts';
import { VENUS_ARENA } from './ram.ts';
import { WindowWatch } from './window.ts';

/**
 * Where the module finds the window: its address in the module's memory (memory 1, past the arena), its bytes, and
 * the write-watch's words' address in `core` (memory 0; default: the module's memory).
 */
export type VenusWindow = { at: number; bytes: number; watch: number; core?: WebAssembly.Memory };

export type VenusStats = {
  submits: number; completed: number; fences: number; polls: number; dirtyPages: number; dirtyLooks: number; contexts: number;
  /** The poller's (VK3 L2): ms between its polls while it ran (sum, longest) and how many; fences' ms from sent to
   * retired (sum, longest). */
  gaps: number; gapMs: number; gapMaxMs: number; fenceMs: number; fenceMaxMs: number;
  /** The pump's turns' own ms (polling and nudging: what its pace costs the GPU worker; VK4 T13). */
  turnMs: number;
};

/**
 * How the rings are polled while active (`?gpu=vkpoll=timeout` the old way, for A/B). `timeout` reschedules with a
 * nested `setTimeout(f, 0)`, which Chromium clamps to ~4.5 ms a turn from the fifth (6 ms on the Mac): the guest's
 * fences, which retire at a poll, came back ~4 ms late, a floor of ~3 ms a frame on the M4 (bench/vulkan/REPORT.md
 * "VK3 L2"). `pump` waits `PERIOD_MS` between turns on `Atomics.waitAsync`'s timeout (~0.5 ms a turn in
 * Chromium on Linux, ~1.55 ms on the Mac; a timer set from a message's task, ~1.6 ms, where there is no shared
 * memory), so no timer is nested and the worker's own timers keep their turns (a loop of messages alone starved them
 * in VK2). A submit, a notify and a completion poll at once besides. While a submit is in flight each turn also nudges WebGPU (web/venus-gpu.ts `nudge`).
 * Turning without any delay after work (VK3 L2's first try) polled ~100,000 times a second for nothing: the scene's
 * frame was the same. `ticker` (the default where there are workers, `Atomics.waitAsync` and shared memory, VK4 T13;
 * `?gpu=vkpoll=pump` the pump alone, as in Node) is the pump with its turns timed by a worker of its own
 * (web/venus-ticker.ts): the Mac stretches `waitAsync`'s 0.25 ms timeout to ~1.5 ms, and each synchronous Venus call
 * (GSK's ~80 `vkAllocateDescriptorSets` a frame) waited a turn. A ticker that can't be made or fails to load leaves the
 * pump alone, with a warning.
 */
export type VenusPoll = 'timeout' | 'pump' | 'ticker';
/**
 * A fence's way back, over a span (the render stats' `venus`, a second): sums and counts, so spans add up. Polls and the
 * ms between them while the pump ran (`gap*`); the GPU's submits, the ms until WebGPU said done (`done*`) and then until
 * they completed in order (`orderMs`), the nudges; the fences the guest sent and their ms until retired.
 */
export type VenusTimes = { polls: number; gaps: number; gapMs: number; gapMaxMs: number; submits: number; done: number; doneMs: number; doneMaxMs: number; orderMs: number; nudges: number; fences: number; fenceMs: number; fenceMaxMs: number;
  /** A submit's parts (VK3 L2b, web/venus-gpu.ts `VenusGpuStats`): summed over the second's submits. */
  encodeMs: number; submitCallMs: number; uploads: number; uploadBytes: number; readbacks: number; passes: number; draws: number; gpuTimed: number; gpuMs: number; workDone: number; workDoneMs: number;
  /** Bind groups made (VK3 L6b: kept by their layouts' content since). */
  bindGroups: number;
  /** vkr's (vk/README.md "Calls and rings"): the commands it ran from the rings, the virtqueue and nested streams; those
   * that asked for a reply (the guest waits for each); rings gone idle and woken by a notify. */
  ringCmds: number; queueCmds: number; nestedCmds: number; replies: number; idles: number; notifies: number;
  /** The pump's turns' own ms (`VenusStats.turnMs`), and the ticker's ticks (web/venus-ticker.ts). */
  turnMs: number; ticks: number };

/**
 * How the renderer's pipelines are made (`?gpu=vkpipelines=sync`: at once, as before VK3 L3, for A/B) and where its
 * shaders persist across runs (`cache`: the store for a renderer build, web/venus-cache.ts; none with `?gpu=vkcache=off`).
 */
export type VenusOptions = { syncPipelines?: boolean;
  /** `?gpu=vkpipedelay=<ms>`: each pipeline made asynchronously ready that much later (web/venus-gpu.ts; tests, VK3 L4e). */
  pipelineDelayMs?: number; cache?: (buildId: string) => Promise<ShaderCache | undefined>;
  /** `?gpu=vknudge=<ms>`: the pump's nudges at most this often (0: none; default `NUDGE_MS`); `?gpu=vkgputime`: each
   * submit's passes timed on the GPU (VK3 L2b, A/B and diagnosis). */
  nudgeMs?: number; gpuTime?: boolean;
  /** `?gpu=vkidle=<ms>`: a ring stays active (polled, so the guest's next command needs no notify) at least this long
   * after its last command, whatever the guest's idle timeout (Mesa's 1 ms; vk/README.md "Calls and rings"). */
  ringIdleMs?: number;
  /** `?gpu=vktick=<ms>`: the ticker's sleep between turns (default `TICK_MS`; A/B). Knobs outside their range (`TICK_RANGE`,
   * `IDLE_RANGE`, or not a number) are refused with a warning: the default stays. */
  tickMs?: number;
  /** The ticker's module instead of web/venus-ticker.ts (tests: one that fails to load). */
  tickerUrl?: URL;
  /** `?gpu=vkhold=<feature>`: adapter features the device doesn't take (web/venus-gpu.ts `gpuFeatures`); `heldFormats`
   * (`?gpu=vkformats=held`): nor `HELD_FEATURES` (libplacebo's advanced path off, as before VK3 L4e). */
  hold?: readonly string[]; heldFormats?: boolean;
  /** YCbCr conversions and the 8-bit multi-planar formats (VK3 L7.2; vk/README.md "The driver"): on unless `false`
   * (`?gpu=vkycbcr=off`). On by default since VK3 L7.3: GTK 4.24 asserts them on a device with dma-buf modifiers, so
   * without them every GTK4 program died on a machine with Vulkan; with them GTK still takes GL (LINEAR alone isn't a
   * dma-buf format to GTK's Vulkan renderer). Chromium's own Vulkan device wants them too (L7.1b). */
  ycbcr?: boolean;
  /** `?gpu=vkl9=<suspect>`: VK3 L9a's suspects back at 4fdc69fb's behaviour (web/venus-gpu.ts `L9_SUSPECTS`); the
   * driver's take flags (`L9_FLAGS`), the device request the rest. */
  l9?: readonly L9Suspect[] };

/** venus_init's flag for `VenusOptions.ycbcr` (vk/driver/wg_private.h `WG_FEATURE_YCBCR`). */
const YCBCR = 1 << 30;
/** venus_init's flags for `VenusOptions.l9`'s driver suspects (vk/driver/wg_private.h `WG_FEATURE_L9_*`). */
export const L9_FLAGS: Partial<Record<L9Suspect, number>> = { bindgroups: 1 << 29, pad: 1 << 28 };

/** The pump's wait between turns, and how often it nudges at most (ms). */
const PERIOD_MS = 0.25, NUDGE_MS = 1;
/**
 * The ticker's sleep between turns (ms): ~0.08 ms a turn on the Mac, ~0.17 on Linux (bench/vulkan/wake.ts). GSK's
 * iconscroll on the M4 ran at 16.8 frames/s at 0.25, 25.8 at 0.1 and 31.4 at 0.05 (GL's 27); VK0's scene no worse
 * (bench/vulkan/REPORT.md "VK4 T13–T14").
 */
const TICK_MS = 0.05;
/** The knobs' ranges (ms): a tick of 0 would spin, NaN sleep for ever; an idle floor past ~1 s only keeps the pump busy. */
const TICK_RANGE = [0.01, 10], IDLE_RANGE = [0, 1000];
/** A knob's value if it's a number in its range; else a warning and undefined (the default). */
function knob(name: string, v: number | undefined, [lo, hi]: number[]) {
  if (v === undefined) return undefined;
  if (Number.isFinite(v) && v >= lo && v <= hi) return v;
  console.warn(`venus: ${name}=${v} ignored (not a number from ${lo} to ${hi} ms)`);
  return undefined;
}

type Exports = {
  _initialize(): void;
  venus_init(features: number, limits: number, nlimits: number, window: number, windowBytes: number): number;
  venus_complete(serial: number): void;
  venus_capset(out: number): number;
  venus_context_create(ctx: number, name: number, nlen: number): number;
  venus_context_destroy(ctx: number): void;
  venus_submit(ctx: number, cmd: number, size: number): number;
  venus_submit_fence(ctx: number, flags: number, ring: number, fence: bigint): number;
  venus_resource_create(ctx: number, res: number, blobId: bigint, size: bigint, flags: number): number;
  venus_resource_destroy(ctx: number, res: number): void;
  venus_resource_import(ctx: number, res: number, size: bigint): number;
  venus_resource_map(ctx: number, res: number, where: number): number;
  venus_resource_unmap(ctx: number, res: number): number;
  venus_poll(): number;
  venus_cmd_counts(): number;
  venus_cmd_types(): number;
  venus_ring_events(): number;
  venus_cmd_name(type: number): number;
  venus_ring_idle(us: number): void;
  venus_resource_data(ctx: number, res: number): number;
  venus_resource_texture(ctx: number, res: number): number;
  venus_build_id(): number;
  venus_arena_end(): number;
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
    // Pointers past 2 GiB (the window, past a large arena) come as negative i32s.
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
    fd_prestat_dir_name: () => EBADF, fd_read: () => EBADF, fd_pread: () => EBADF, fd_seek: () => EBADF, path_open: () => ENOSYS,
    sched_yield: () => 0,
    proc_exit: (code: number) => { throw new Error(`venus: proc_exit(${code})`); },
  };
}

export class VenusRenderer {
  readonly stats: VenusStats = { submits: 0, completed: 0, fences: 0, polls: 0, dirtyPages: 0, dirtyLooks: 0, contexts: 0, gaps: 0, gapMs: 0, gapMaxMs: 0, fenceMs: 0, fenceMaxMs: 0, turnMs: 0 };
  /** The VENUS capset vkr writes (the device's `venusCaps`). */
  readonly capset: Uint8Array;
  private readonly ex: Exports;
  private readonly memory: WebAssembly.Memory;
  private readonly window: VenusWindow;
  /** The window's write-watch; none with `watch` 0 (`?gpu=vulkan,nowatch`). */
  private readonly watch: WindowWatch | undefined;
  /** A resource's context (the device names blobs by resource alone). */
  private readonly owner = new Map<number, number>();
  /** Virgl resources imported into Venus contexts ("ctx:res"). */
  private readonly imported = new Set<string>();
  /** The contexts made and not destroyed (a virtio reset destroys them: `reset`). */
  private readonly contexts = new Set<number>();
  /** Fences sent to vkr and not yet retired ("ctx:ring:id"). */
  private readonly pending = new Set<string>();
  /** When each pending fence was sent (performance.now()), for the stuck-fence warning (`watchFences`). */
  private readonly sentAt = new Map<string, number>();
  private fenceWatch: ReturnType<typeof setInterval> | undefined;
  private readonly warnedStuck = new Set<string>();
  private pollTimer: ReturnType<typeof setTimeout> | undefined;
  private poll: VenusPoll;
  /** The pump's: it runs (the rings active or a submit in flight), a turn is scheduled; when it last polled and nudged. */
  private running = false;
  private queued = false;
  private lastPoll = 0;
  private lastNudge = 0;
  private wait: (() => void) | undefined;
  /** Called when fences retire (the GPU worker answers the fences it held for them). */
  onRetire: (() => void) | undefined;
  readonly gpu: VenusGpu;
  /** The module's exports as they are (tests/venus-driver.test.ts calls its test exports). */
  readonly raw: WebAssembly.Exports;

  private constructor(instance: WebAssembly.Instance, memory: WebAssembly.Memory, window: VenusWindow, gpu: VenusGpu, device: GPUDevice | undefined, caps: GpuCaps | undefined, poll: VenusPoll, hold: readonly string[] = [], ycbcr = false, l9: readonly L9Suspect[] = []) {
    this.poll = poll;
    const ex = instance.exports as unknown as Exports;
    this.raw = instance.exports;
    // A pointer past 2 GiB (the window, with a large arena) comes from a wasm i32 as a negative number.
    this.ex = { ...ex, venus_alloc: (size: number) => ex.venus_alloc(size) >>> 0 };
    [this.memory, this.window] = [memory, window];
    this.watch = window.watch ? new WindowWatch(window.core ?? memory, window.watch) : undefined;
    this.gpu = gpu;
    this.ex._initialize();
    // What the device advertises follows the WebGPU device's features and limits (vk/driver/wg_caps.c).
    const limits = gpuLimits(caps);
    const at = this.ex.venus_alloc(limits.byteLength);
    new Uint32Array(memory.buffer, at, limits.length).set(limits);
    const ok = this.ex.venus_init(gpuFeatures(caps, !!device, hold) | (ycbcr ? YCBCR : 0) | l9.reduce((f, x) => f | (L9_FLAGS[x] ?? 0), 0), at, limits.length, window.at, window.bytes);
    this.ex.venus_free(at);
    if (!ok) throw new Error('venus: vkr_renderer_init failed');
    const p = this.ex.venus_alloc(4096);
    const n = this.ex.venus_capset(p);
    this.capset = new Uint8Array(memory.buffer, p, n).slice();
    this.ex.venus_free(p);
  }

  /**
   * The module (vk/build.sh's target/vk/venus.wasm) on `memory`, the VM's memory 1, whose arena (its first
   * `VENUS_ARENA` bytes) is unused and the window after it; its driver draws on `device` (none: it keeps objects and draws nothing, as in Node's tests) and advertises
   * what `caps` has (the device's features and limits; a test's stand-in, or WebGPU's defaults).
   */
  static async create(module: WebAssembly.Module, memory: WebAssembly.Memory, window: VenusWindow, device?: GPUDevice, caps: GpuCaps | undefined = device, poll: VenusPoll = typeof Worker !== 'undefined' && typeof SharedArrayBuffer !== 'undefined' ? 'ticker' : 'pump', options: VenusOptions = {}) {
    let self: VenusRenderer | undefined;
    const gpu = new VenusGpu(device, memory, (serial) => self?.completed(serial), () => self?.dirty(), { syncPipelines: options.syncPipelines, pipelineDelayMs: options.pipelineDelayMs, gpuTime: options.gpuTime });
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
    // A module with another arena would grow its heap into the window (or, built for memory 0, write its data over the
    // core's heap there): one built before memory 1 has no `venus_arena_end`; a later one says where its arena ends.
    const stale = `Vulkan's renderer (target/vk/venus.wasm) isn't built for its arena (${VENUS_ARENA >> 20} MiB of memory 1): rebuild it (vk/build.sh)`;
    if (!WebAssembly.Module.exports(module).some((e) => e.name === 'venus_arena_end')) throw new Error(stale);
    // One built before vkr's counts (VK4 T13) lacks their exports, which the stats call every second.
    const names = new Set(WebAssembly.Module.exports(module).map((e) => e.name));
    const missing = ['venus_cmd_counts', 'venus_cmd_types', 'venus_ring_events', 'venus_cmd_name', 'venus_ring_idle'].filter((n) => !names.has(n));
    if (missing.length) throw new Error(`Vulkan's renderer (target/vk/venus.wasm) is older than this page (no ${missing.join(', ')}): rebuild it (vk/build.sh)`);
    const instance = await WebAssembly.instantiate(module, imports);
    if ((instance.exports as unknown as Exports).venus_arena_end() >>> 0 !== VENUS_ARENA) throw new Error(stale);
    self = new VenusRenderer(instance, memory, window, gpu, device, caps, poll, [...(options.heldFormats ? HELD_FEATURES : []), ...(options.hold ?? [])], options.ycbcr ?? true, options.l9);
    self.nudgeMs = options.nudgeMs ?? NUDGE_MS;
    self.cmdTypes = self.ex.venus_cmd_types();
    const idle = knob('vkidle', options.ringIdleMs, IDLE_RANGE);
    if (idle !== undefined) self.ex.venus_ring_idle(Math.round(idle * 1000));
    // The ticker, made here (never inside a module's call, where a throw would unwind vkr mid-command).
    const tick = knob('vktick', options.tickMs, TICK_RANGE) ?? TICK_MS;
    if (self.poll === 'ticker') self.startTicker(tick, options.tickerUrl);
    gpu.onSubmit = () => self?.worked();
    // The shaders of earlier runs, for this build of the renderer (web/venus-cache.ts): loaded before any context.
    if (options.cache) gpu.cache = await options.cache(self.buildId);
    return self;
  }

  /** The renderer's build ID (vk/gen.ts: a hash of vk/'s sources), which the shader cache keeps entries of. */
  get buildId() {
    const p = this.ex.venus_build_id() >>> 0;
    const bytes = new Uint8Array(this.memory.buffer, p, 64);
    return new TextDecoder().decode(bytes.slice(0, bytes.indexOf(0) < 0 ? 64 : bytes.indexOf(0)));
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
    this.wake();
  }

  /** A submit to the GPU: the pump runs until it completes. */
  private worked() {
    if (this.poll === 'timeout' || this.queued) return;
    // Called from inside the module (its submit): the turn comes later.
    this.running = this.queued = true;
    this.schedule();
  }

  private retire(key: string) {
    this.stats.fences++;
    this.pending.delete(key);
    const at = this.sentAt.get(key);
    if (at !== undefined) {
      const ms = performance.now() - at;
      this.stats.fenceMs += ms;
      this.stats.fenceMaxMs = Math.max(this.stats.fenceMaxMs, ms);
    }
    this.sentAt.delete(key);
    this.onRetire?.();
  }

  /** Warns of a fence still pending 5 s after it was sent (the guest is waiting on it), with what the driver's queue did. */
  private watchFences() {
    if (this.fenceWatch) return;
    this.fenceWatch = setInterval(() => {
      if (!this.pending.size) {
        clearInterval(this.fenceWatch);
        this.fenceWatch = undefined;
        return;
      }
      const now = performance.now();
      for (const [k, t] of this.sentAt) {
        if (now - t < 5000 || this.warnedStuck.has(k)) continue;
        this.warnedStuck.add(k);
        console.warn(`venus: fence ${k} unretired for ${((now - t) / 1000).toFixed(0)} s (submits ${this.stats.submits}, GPU submits ${this.gpu.stats.submits}, completed ${this.stats.completed}, pending fences ${this.pending.size})`);
      }
    }, 2000);
  }

  /** Whether a fence sent has retired (or its context ended). */
  retired(ctx: number, ring: number, id: bigint) { return !this.pending.has(`${ctx}:${ring}:${id}`); }

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

  /** Runs one of the device's Venus calls (a fenced submit's fence retires later: `retired`). */
  call(c: VenusCall) {
    switch (c.t) {
      case 'vctx':
        if (c.create) {
          const name = new TextEncoder().encode(c.name ?? '');
          if (this.withBytes(name, (p) => this.ex.venus_context_create(c.id, p, name.length))) {
            this.stats.contexts++;
            this.contexts.add(c.id);
          } else console.warn(`venus: context ${c.id} couldn't be made`);
        } else this.destroy(c.id);
        return;
      case 'blob':
        if (this.ex.venus_resource_create(c.ctx, c.res, c.blobId, BigInt(c.size), c.flags)) this.owner.set(c.res, c.ctx);
        else console.warn(`venus: blob ${c.res} (object ${c.blobId}) couldn't be made`);
        return;
      case 'blob-map': {
        const ctx = this.owner.get(c.res);
        if (ctx === undefined || !this.ex.venus_resource_map(ctx, c.res, this.window.at + c.offset)) {
          // The guest has its reply already, and what it reads there mustn't be the last mapping's, another process's.
          console.warn(`venus: blob ${c.res} couldn't be mapped`);
          new Uint8Array(this.memory.buffer, this.window.at + c.offset, c.size).fill(0);
        }
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
        // A virgl resource (`size`) attached to a Venus context: the guest imports it as a dma-buf (web/venus-import.ts).
        // A blob lives in the context that made it; importing it into another isn't needed by Venus alone.
        if (c.size === undefined) return;
        if (c.attach && !this.imported.has(`${c.ctx}:${c.res}`)) {
          if (this.ex.venus_resource_import(c.ctx, c.res, BigInt(c.size))) this.imported.add(`${c.ctx}:${c.res}`);
          else console.warn(`venus: resource ${c.res} couldn't be imported into context ${c.ctx}`);
        } else if (!c.attach && this.imported.delete(`${c.ctx}:${c.res}`)) this.ex.venus_resource_destroy(c.ctx, c.res);
        return;
      case 'vsubmit': {
        this.stats.submits++;
        if (!this.withBytes(c.bytes, (p) => this.ex.venus_submit(c.ctx, p, c.bytes.length))) console.warn(`venus: context ${c.ctx}'s submit failed`);
        const fence = c.fence;
        if (fence) {
          // Retired once the queue's work before it is done (`retired`); a ring fence of no queue's work retires at
          // the next poll.
          const key = `${c.ctx}:${fence.ring}:${fence.id}`;
          this.pending.add(key);
          this.sentAt.set(key, performance.now());
          this.watchFences();
          // Refused (no such ring): it never retires, and it mustn't hold its ring's lane or a guest waiting for it.
          if (!this.ex.venus_submit_fence(c.ctx, fence.flags, fence.ring, fence.id)) {
            console.warn(`venus: fence ${key} refused`);
            this.pending.delete(key);
            this.sentAt.delete(key);
          }
        }
        this.wake();
        return;
      }
    }
  }

  /** Destroys a context with its blobs, imports and fences (vkr frees what it holds). */
  private destroy(id: number) {
    if (this.contexts.delete(id)) {
      this.ex.venus_context_destroy(id);
      this.stats.contexts--;
    }
    for (const [res, ctx] of this.owner) if (ctx === id) this.owner.delete(res);
    for (const k of this.imported) if (k.startsWith(`${id}:`)) this.imported.delete(k);
    for (const k of this.pending) {
      if (!k.startsWith(`${id}:`)) continue;
      this.pending.delete(k);
      this.sentAt.delete(k);
    }
  }

  /**
   * A virtio reset (a guest reboot): every context ends, so the new guest's contexts can take the same ids and no old
   * ring is polled over memory the new guest reuses. Returns the blobs that went with them.
   */
  reset() {
    const blobs = [...this.owner.keys()];
    for (const id of [...this.contexts]) this.destroy(id);
    return blobs;
  }

  /** A blob's bytes' address in the module's memory now (its storage, or the window while mapped), 0 for none. */
  address(res: number) {
    const ctx = this.owner.get(res);
    return ctx === undefined ? 0 : this.ex.venus_resource_data(ctx, res) >>> 0;
  }

  private lastTimes: VenusTimes | undefined;
  /** The pump's nudges at most this often (ms; 0: none). */
  nudgeMs = NUDGE_MS;
  /** The fence's way back since the last call (`VenusTimes`); the longest times start again. */
  times(): VenusTimes {
    const r = this.stats, g = this.gpu.stats;
    const now: VenusTimes = { polls: r.polls, gaps: r.gaps, gapMs: r.gapMs, gapMaxMs: r.gapMaxMs, submits: g.submits, done: g.done, doneMs: g.doneMs, doneMaxMs: g.doneMaxMs, orderMs: g.orderMs, nudges: g.nudges, fences: r.fences, fenceMs: r.fenceMs, fenceMaxMs: r.fenceMaxMs,
      encodeMs: g.encodeMs, submitCallMs: g.submitCallMs, uploads: g.uploads, uploadBytes: g.uploadBytes, readbacks: g.readbacks, passes: g.passes, draws: g.draws, gpuTimed: g.gpuTimed, gpuMs: g.gpuMs, workDone: g.workDone, workDoneMs: g.workDoneMs, bindGroups: g.bindGroups,
      ...this.cmdTotals(), turnMs: r.turnMs, ticks: this.counted?.ticks ?? 0 };
    const last = this.lastTimes;
    this.lastTimes = now;
    r.gapMaxMs = g.doneMaxMs = r.fenceMaxMs = 0;
    if (!last) return now;
    const d = { ...now };
    for (const k of Object.keys(d) as (keyof VenusTimes)[]) if (!k.endsWith('MaxMs')) d[k] -= last[k];
    return d;
  }

  /** vkr's command types counted (`venus_cmd_types`: the patch's `VKR_WASI_CMD_TYPES`). */
  private cmdTypes = 0;
  /** vkr's counters and the ticker's ticks as last read (u32s that wrap), and their totals since the start (exact). */
  private lastRaw: { cmds: Uint32Array; events: Uint32Array; ticks: number } | undefined;
  private counted: { cmds: Float64Array; events: Float64Array; ticks: number } | undefined;

  /** vkr's counts (`venus_cmd_counts`: [where][reply][type]) and the ticks, totalled across their wraps (each a sum of differences modulo 2^32). */
  private counts() {
    const n = this.cmdTypes * 6;
    const cmds = new Uint32Array(this.memory.buffer, this.ex.venus_cmd_counts() >>> 0, n).slice(), events = new Uint32Array(this.memory.buffer, this.ex.venus_ring_events() >>> 0, 2).slice();
    const ticks = this.ticks ? Atomics.load(this.ticks, 0) >>> 0 : 0;
    const last = this.lastRaw, c = (this.counted ??= { cmds: new Float64Array(n), events: new Float64Array(2), ticks: 0 });
    for (let i = 0; i < n; i++) c.cmds[i] += (cmds[i] - (last?.cmds[i] ?? 0)) >>> 0;
    for (let i = 0; i < 2; i++) c.events[i] += (events[i] - (last?.events[i] ?? 0)) >>> 0;
    c.ticks += (ticks - (last?.ticks ?? 0)) >>> 0;
    this.lastRaw = { cmds, events, ticks };
    return c;
  }

  private cmdTotals() {
    const { cmds, events } = this.counts(), CMD_TYPES = this.cmdTypes;
    const sum = (from: number, to: number) => cmds.subarray(from * CMD_TYPES, to * CMD_TYPES).reduce((n, x) => n + x, 0);
    // [where][reply][type]: where 0 the rings, 1 the virtqueue, 2 nested streams; reply 1 at odd rows.
    return { ringCmds: sum(0, 2), queueCmds: sum(2, 4), nestedCmds: sum(4, 6), replies: sum(1, 2) + sum(3, 4) + sum(5, 6), idles: events[0], notifies: events[1] };
  }

  private lastCalls: Float64Array | undefined;
  private readonly names = new Map<number, string>();
  /**
   * The commands that asked for a reply since the last call, by name (the guest waits for each: a synchronous Venus
   * call; vk/README.md "Calls and rings"), and every command that came through the virtqueue rather than a ring, as
   * `<name>@queue` (each submit an execbuffer of the guest's: notifies, fenced submits' waits; `+reply` if it asked).
   */
  calls(): Record<string, number> {
    const cmds = this.counts().cmds.slice(), CMD_TYPES = this.cmdTypes;
    const last = this.lastCalls;
    this.lastCalls = cmds;
    const out: Record<string, number> = {};
    for (let where = 0; where < 3; where++) {
      for (let reply = where === 1 ? 0 : 1; reply < 2; reply++) {
        for (let t = 0; t < CMD_TYPES; t++) {
          const i = (where * 2 + reply) * CMD_TYPES + t, d = cmds[i] - (last?.[i] ?? 0);
          if (!d) continue;
          const k = `${this.cmdName(t)}${where === 1 ? `@queue${reply ? '+reply' : ''}` : ''}`;
          out[k] = (out[k] ?? 0) + d;
        }
      }
    }
    return out;
  }

  private cmdName(t: number) {
    let s = this.names.get(t);
    if (s === undefined) {
      const p = this.ex.venus_cmd_name(t) >>> 0, bytes = new Uint8Array(this.memory.buffer, p, 96);
      s = new TextDecoder().decode(bytes.slice(0, Math.max(0, bytes.indexOf(0)))) || `#${t}`;
      this.names.set(t, s);
    }
    return s;
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

  /** Polls the rings now, and then until they are all idle again and no submit is in flight (a notify, a submit wakes them). */
  wake() {
    if (this.poll === 'timeout') {
      if (this.pollTimer) return;
      const tick = () => {
        this.pollTimer = undefined;
        this.stats.polls++;
        if (this.ex.venus_poll()) this.pollTimer = setTimeout(tick, 0);
      };
      tick();
      return;
    }
    this.turn();
  }

  /** One of the pump's turns: polls, nudges WebGPU while a submit is in flight, and schedules the next turn. */
  private turn() {
    const now = performance.now();
    if (this.running) {
      const gap = now - this.lastPoll;
      this.stats.gaps++;
      this.stats.gapMs += gap;
      this.stats.gapMaxMs = Math.max(this.stats.gapMaxMs, gap);
    }
    this.lastPoll = now;
    this.stats.polls++;
    const active = this.ex.venus_poll();
    if (this.nudgeMs > 0 && this.gpu.inFlight && now - this.lastNudge >= this.nudgeMs && this.gpu.nudge()) this.lastNudge = now;
    this.running = !!active || this.gpu.inFlight > 0;
    this.stats.turnMs += performance.now() - now;
    // The ticker stops while nothing runs (a notify or a submit starts it again: `schedule`), but never under a turn
    // that waits on it: it may have ticked for the last time just before that turn began waiting, and stopped it would
    // never tick again. Before the wait had its fallback timeout, that turn never came and the pump never scheduled
    // another (VK4 T13: iconscroll at 0.9 frames/s, a new gtk4-demo dead of Venus's watchdog); now it would come only
    // at the pump's old pace.
    if (!this.running && !this.queued && this.ticks) Atomics.store(this.ticks, 1, 0);
    if (this.running && !this.queued) {
      this.queued = true;
      this.schedule();
    }
  }

  /** The ticker's words (web/venus-ticker.ts): [0] its ticks, [1] set while it runs. */
  private ticks: Int32Array | undefined;

  /**
   * Starts the ticker (web/venus-ticker.ts) that times the pump's turns. Without `Atomics.waitAsync`, shared memory or
   * workers, or if the worker can't be made, the pump goes alone; one that fails to load later hands back to the pump
   * too (a turn waiting on it then comes at its fallback timeout).
   */
  private startTicker(period: number, url?: URL) {
    const fallBack = (why: unknown) => {
      console.warn(`venus: no ticker for the rings' polls (${String(why)}): they're polled at the pump's own pace`);
      this.poll = 'pump';
      this.ticks = undefined;
      this.wait = undefined;
    };
    if (typeof (Atomics as { waitAsync?: unknown }).waitAsync !== 'function' || typeof SharedArrayBuffer === 'undefined' || typeof Worker === 'undefined') return fallBack('no Atomics.waitAsync, shared memory or workers');
    try {
      const sab = new SharedArrayBuffer(8);
      const worker = url ? new Worker(url, { type: 'module' }) : new Worker(new URL('./venus-ticker.ts', import.meta.url), { type: 'module' });
      worker.onerror = (e) => {
        e.preventDefault();
        worker.terminate();
        if (this.ticks && this.ticks.buffer === sab) fallBack(e.message || 'its worker failed');
      };
      worker.postMessage({ sab, period });
      this.ticks = new Int32Array(sab);
    } catch (e) {
      fallBack(e);
    }
  }

  private schedule() {
    if (!this.wait) {
      const next = () => {
        this.queued = false;
        this.turn();
      };
      const ticks = this.ticks;
      if (this.poll === 'ticker' && ticks) {
        const waitAsync = (Atomics as unknown as { waitAsync(a: Int32Array, i: number, v: number, t: number): { async: boolean; value: Promise<string> | string } }).waitAsync;
        this.wait = () => {
          if (!Atomics.load(ticks, 1)) {
            Atomics.store(ticks, 1, 1);
            Atomics.notify(ticks, 1);
          }
          // With the pump's own timeout besides: a ticker the OS starves is no slower than the pump alone.
          const r = waitAsync(ticks, 0, Atomics.load(ticks, 0), PERIOD_MS);
          // A tick between the load and the wait: the turn comes at once, but never inside the caller (the module).
          void (r.async ? (r.value as Promise<string>) : Promise.resolve()).then(next);
        };
        this.wait();
        return;
      }
      // (The pump alone.)
      const waitAsync = (Atomics as unknown as { waitAsync?(a: Int32Array, i: number, v: number, t: number): { async: boolean; value: Promise<string> | string } }).waitAsync;
      if (waitAsync && typeof SharedArrayBuffer !== 'undefined') {
        // A word nobody notifies: the wait ends at its timeout.
        const word = new Int32Array(new SharedArrayBuffer(4));
        this.wait = () => {
          const r = waitAsync(word, 0, 0, PERIOD_MS);
          if (r.async) void (r.value as Promise<string>).then(next);
          else setTimeout(next, 1);
        };
      } else {
        const c = new MessageChannel();
        // Set from a message's task, the timer isn't nested in another timer: Chromium doesn't clamp it.
        c.port1.onmessage = () => setTimeout(next, 1);
        this.wait = () => c.port2.postMessage(0);
      }
    }
    this.wait();
  }
}
