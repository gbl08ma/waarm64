// The page's GPU worker (docs/frontend.md "The screen", docs/graphics.md "The GPU worker"): a top-level worker that owns the
// screen's canvas as WebGL2 on a 3D machine (the G3 kickoff's decision 2). The page starts it with the canvas and a
// port for the device worker; it answers with the caps this browser backs (web/virgl-caps.ts), or why it can't. Then
// it runs the device's calls (web/virgl-host.ts) in order: the renderer's (web/virgl-renderer.ts) and the screen's
// (web/virgl-screen.ts), and answers fences once everything before them has run. With video, what follows a
// picture waits until the picture is decoded (web/virgl-host.ts `CallQueue`).
import { capsFromGl, withVideo } from './virgl-caps.ts';
import { CallQueue, clock, FenceGate, runCall, saveRenderer, snapshotBuffers, STUCK_MS, type VenusCall, type WorkerCall } from './virgl-host.ts';
import { deviceRequest, l9Suspects, subgroupsRight, type VenusGpuStats } from './venus-gpu.ts';
import { VenusRenderer, type VenusPoll, type VenusTimes } from './venus-host.ts';
import { idbBackend, ShaderCache } from './venus-cache.ts';
import { VenusImport } from './venus-import.ts';
import { shareMode, VenusShare, type ShareCheck, type ShareMode } from './venus-share.ts';
import { VirglRenderer } from './virgl-renderer.ts';
import { flashProbe, glInfo, Screen } from './virgl-screen.ts';
import { probeVideo, profileName, webCodecsDecoder, type VideoStats, type VideoStream } from './virgl-video.ts';

/** Page → GPU worker. */
export type ToGpuWorker = { type: 'snapshotBytes'; id: number } | /** Bench hook (`window.__webpcGrab`): the screen drawn now and read back, top row first, RGBA. */ { type: 'grab'; id: number } | { type: 'init'; canvas: OffscreenCanvas; port: MessagePort; stats?: boolean; debug?: boolean; /** `?avprobe`: `flash` when a present turns the screen's centre bright (bench/audio/avsync.ts). */ probe?: boolean; /** Advertise the browser's video decoders and decode with them (docs/plans/video.md; the page's default, `?gpu=novideo` turns it off). */ video?: boolean; /** `?gpu=swvideo`: every codec decoded in software, H.264 offered (experiments on a host with hardware decoders). */ softwareVideo?: boolean; /** `?gpu=vkbitmap`, `vkcanvas` or `vkreadback`: how Vulkan's frames reach virgl (web/venus-share.ts), that way only, instead of the probe's choice and the check's fallbacks. */ vkShare?: ShareMode; /** `?gpu=vkbreak=<way>` (tests): that way's copies come out black, and the GPU ways are tried even where the page renders in software. */ vkBreak?: ShareMode[]; /** `?gpu=vkvendor=<maker>` (e.g. `nvidia`): the adapter's maker as the Vulkan device takes it (web/venus-gpu.ts `VENDORS`; tests). */ vkVendor?: string; /** `?gpu=vkpoll=timeout`: Venus polls its rings the old way (web/venus-host.ts `VenusPoll`; A/B). */ vkPoll?: VenusPoll; /** `?gpu=vkpipelines=sync`: Venus's pipelines made at once, not asynchronously (web/venus-gpu.ts; A/B). */ vkSyncPipelines?: boolean; /** `?gpu=vkpipedelay=<ms>`: each Venus pipeline made asynchronously is ready that much later (web/venus-gpu.ts; VK3 L4e: a cold host compile anywhere). */ vkPipeDelayMs?: number; /** `?gpu=vkcache=off`: no shaders kept across runs (web/venus-cache.ts; A/B, cold runs). */ vkNoCache?: boolean; /** `?gpu=vknudge=<ms>`: the pump's nudges at most this often, 0 none (web/venus-host.ts; VK3 L2b's A/B). */ vkNudgeMs?: number; /** `?gpu=vkgputime`: each Venus submit's passes timed on the GPU (timestamp queries; VK3 L2b). */ vkGpuTime?: boolean; /** `?gpu=vkhold=<feature>` (repeatable): an adapter feature the Vulkan device doesn't take (web/venus-gpu.ts `gpuFeatures`; A/B). */ vkHold?: string[]; /** `?gpu=vkformats=held`: the device doesn't take `HELD_FEATURES` (libplacebo's advanced path off, the default until VK3 L4e; A/B). */ vkHeldFormats?: boolean; /** `?gpu=vkycbcr=off` (false): the Vulkan device without YCbCr conversions and the multi-planar formats (on by default since VK3 L7.3; web/venus-host.ts `VenusOptions.ycbcr`). */ vkYcbcr?: boolean; /** `?gpu=vkl9=<suspect>` (repeatable, `all`): VK3 L9a's suspects back at 4fdc69fb's behaviour (web/venus-gpu.ts `L9_SUSPECTS`; the NVIDIA run's A/B). */ vkL9?: string[] };
/** GPU worker → page. */
export type FromGpuWorker =
  | { type: 'ready'; caps: Uint8Array; renderer: string }
  /** The bytes a snapshot would hold for the 3D resources, before compression (`VirglRenderer.snapshotBytes`): Save snapshot warns past a size. */
  | { type: 'snapshotBytes'; id: number; bytes: number }
  | { type: 'grab'; id: number; width: number; height: number; pixels: Uint8Array }
  | { type: 'failed'; reason: string }
  | { type: 'lost' }
  /** With `probe`: a present turned the screen's centre bright, at `t` (ms since the epoch). */
  | { type: 'flash'; t: number }
  /**
   * Always, once a second from `ready` on (the first with it): totals since the worker started (rates are the page's)
   * and what is in use now (the page's status bar). The worker exists only on a 3D machine, so this is WebGL2 with
   * virgl. `renderer` and `vendor` are WebGL's (unmasked where the browser gives them), `software` whether the renderer
   * is a CPU rasterizer (SwiftShader, llvmpipe). `presents` are the screen's draws (at most one a display frame: a
   * guest's flip, whatever it took); `submits` the guest's command buffers, `commands` the virgl commands in them,
   * `draws` the GL draws they made, `errors` the renderer's (video's among them). `video` is off (`enabled: false`) with
   * `?gpu=novideo` or where WebCodecs decodes none of the codecs; `offered` the codecs the guest was told of and which
   * are decoded in hardware; `streams` the guest's decoding contexts now (web/virgl-video.ts `VideoStream`); `frames`
   * the pictures the guest sent, `decoded` those written back, `dropped` those given up, `errors` the video errors and
   * `decoderErrors` the decoders' own (of `errors`).
   */
  | { type: 'stats'; renderer: string; vendor: string; software: boolean; presents: number; submits: number; commands: number; draws: number; errors: number; video: GpuVideoStats }
  /** With `stats`, once a second: what the renderer did and the time it took (bench/gpu, `?displaystats`). */
  | { type: 'render-stats'; submits: number; draws: number; commands: number; busyMs: number; submitMs: number; presents: number; presentAt: number[]; drawMs: number; programs: number; errors: number; uploadBytes: number; readbacks: number; readbackBytes: number; fences: number; fenceMs: number; fenceMaxMs: number; compileMs: number; /** Vulkan's frames copied into virgl's textures (web/venus-share.ts) and the thread's ms for them, in the second. */ shareRefreshes: number; shareMs: number; /** Virgl's resources written into Vulkan's textures imported from them (web/venus-import.ts): binds, pictures, bytes and the thread's ms, in the second. */ importBinds: number; importPictures: number; importBytes: number; importMs: number; /** How Vulkan's frames reach virgl now, and where the check of a GPU way stands (web/venus-share.ts). */ share?: ShareCheck & { checks: number; checksWrong: number; unshared: number }; /** Venus's fences' way back in the second (web/venus-host.ts `VenusTimes`). */ venus?: VenusTimes; /** Venus's pipeline totals since it started (`venusPipelines`, VK3 L3). */ venusPipelines?: ReturnType<typeof venusPipelines> & { cacheBytes: number; cacheEntries: number }; /** The renderer's video totals since it started (web/virgl-video.ts `VideoStats`), how many calls ran ahead of ones waiting for pictures, and the longest wait (ms) in the second (`latencyMaxMs` too is the second's). */ video: VideoStats & { ahead: number; maxWaitMs: number } };

/** The video part of `stats`. */
export type GpuVideoStats = { enabled: boolean; offered: { profile: string; hardware: boolean }[]; streams: VideoStream[]; frames: number; decoded: number; dropped: number; errors: number; decoderErrors: number };

let ram: Uint8Array[] = [];
let snapshotBytes = () => 0;
let grab = (id: number) => void (self as unknown as Worker).postMessage({ type: 'grab', id, width: 0, height: 0, pixels: new Uint8Array(0) } satisfies FromGpuWorker);

self.onmessage = async (e: MessageEvent<ToGpuWorker>) => {
  if (e.data?.type === 'snapshotBytes') {
    (self as unknown as Worker).postMessage({ type: 'snapshotBytes', id: e.data.id, bytes: snapshotBytes() } satisfies FromGpuWorker);
    return;
  }
  if (e.data?.type === 'grab') return grab(e.data.id);
  if (e.data?.type !== 'init') return;
  const { canvas, port, stats, debug, probe, video, softwareVideo, vkShare, vkBreak, vkVendor, vkPoll, vkSyncPipelines, vkPipeDelayMs, vkNoCache, vkNudgeMs, vkGpuTime, vkHold, vkHeldFormats, vkYcbcr, vkL9 } = e.data;
  const post = (m: FromGpuWorker) => (self as unknown as Worker).postMessage(m);
  const gl = canvas.getContext('webgl2', { alpha: false, antialias: false, depth: false, stencil: false, premultipliedAlpha: false, preserveDrawingBuffer: false, powerPreference: 'high-performance' }) as WebGL2RenderingContext | null;
  if (!gl) {
    post({ type: 'failed', reason: 'this browser has no WebGL2 here' });
    return;
  }
  canvas.addEventListener('webglcontextlost', (ev) => {
    ev.preventDefault();
    post({ type: 'lost' });
  });
  // The decoders first: the caps advertise what they found, and the renderer decodes with them.
  const decoders = video ? await probeVideo({ software: softwareVideo }) : undefined;
  // `?gpu=virgl,debug`: the renderer's trace on the console, each line once.
  const seen = new Set<string>();
  const renderer = new VirglRenderer(gl, {
    ram: () => ram,
    debug: debug ? (m) => { if (!seen.has(m)) { seen.add(m); console.log(`virgl-debug ${m}`); } } : undefined,
    video: decoders && { decoders: webCodecsDecoder, hardware: decoders.hardware },
  });
  const screen = new Screen(gl, renderer);
  snapshotBytes = () => renderer.snapshotBytes();
  grab = (id) => {
    const g = screen.grab();
    (self as unknown as Worker).postMessage({ type: 'grab', id, ...g } satisfies FromGpuWorker, [g.pixels.buffer]);
  };
  if (probe) screen.probe = flashProbe((t) => post({ type: 'flash', t }));
  let busyMs = 0, submitMs = 0, queries = 0;
  // How long fences took to reach this worker (its event loop's backlog): count, total and longest ms a second.
  let fences = 0, fenceMs = 0, fenceMaxMs = 0;
  let pollTimer: ReturnType<typeof setTimeout> | undefined;
  // A fence waits for the query results before it (FenceGate).
  const fenced = new FenceGate<{ id: number; at: number }>((c) => {
    const now = clock();
    fences++;
    fenceMs += now - c.at;
    fenceMaxMs = Math.max(fenceMaxMs, now - c.at);
    port.postMessage({ t: 'fenced', id: c.id, at: now });
  });
  // WebGL's query results come after the task that ended the query: polled while some are pending.
  // Venus (docs/devices.md "Venus"): its renderer is fetched and made on the device's `venus-init` (only a machine with
  // Vulkan has one); its calls wait in order until then, and so do the fences behind them.
  let venus: VenusRenderer | undefined;
  let venusBacklog: VenusCall[] | undefined;
  // Vulkan's frames into virgl's textures (web/venus-share.ts), once the renderer and its device are made.
  let share: VenusShare | undefined;
  // Virgl's resources into Vulkan's textures (web/venus-import.ts: VA-API's surfaces into mpv on Vulkan).
  let imports: VenusImport | undefined;
  const VENUS_CALLS = new Set(['vctx', 'blob', 'blob-map', 'blob-unmap', 'blob-unref', 'blob-ctx', 'vsubmit']);
  const venusCall = (c: VenusCall) => {
    try {
      venus!.call(c);
    } catch (err) {
      console.warn('venus: a call failed', c.t, err);
    }
  };
  const settled = () => {
    const queries = renderer.queriesSettled();
    const vk = venus?.settled();
    return () => queries() && !venusBacklog?.length && (!vk || vk());
  };
  let held = 0;
  const poll = () => {
    pollTimer = undefined;
    queries = renderer.pollQueries();
    fenced.release();
    const f = fenced.oldest;
    if (f && f.id !== held && clock() - f.at > STUCK_MS) {
      held = f.id;
      console.warn(`virgl: fence ${f.id} held ${((clock() - f.at) / 1000).toFixed(0)} s for ${queries} occlusion queries' results`);
    }
    if (queries) pollTimer = setTimeout(poll, 4);
  };
  const run = (c: WorkerCall) => {
    if (c.t === 'venus-init') {
      venusBacklog = [];
      const init = c;
      (async () => {
        // Not bundled (`@vite-ignore`): the static copy doesn't carry the renderer yet (vk/README.md "Not yet").
        const module = await WebAssembly.compileStreaming(fetch(new URL('../target/vk/venus.wasm', import.meta.url).href));
        // The driver's WebGPU device (none: it keeps Venus's objects and draws nothing).
        const adapter = await navigator.gpu?.requestAdapter({ powerPreference: 'high-performance' }).catch(() => null);
        const device = adapter ? await adapter.requestDevice(deviceRequest(adapter, { gpuTime: vkGpuTime, l9: l9Suspects(vkL9 ?? []) })).catch((err) => { console.warn('venus: no WebGPU device', err); return undefined; }) : undefined;
        if (!device) console.warn('venus: this browser has no WebGPU adapter here: Vulkan draws nothing');
        device?.lost.then((info) => console.warn(`venus: the WebGPU device was lost: ${info.message}`));
        // What the device advertises follows the device's features and limits and the adapter's maker.
        // Its shaders of earlier runs (web/venus-cache.ts): IndexedDB, the origin's, for this build of the renderer.
        const cache = vkNoCache || typeof indexedDB === 'undefined' ? undefined : (id: string) => ShaderCache.open(id, { backend: idbBackend() });
        // Subgroups only where they're right in divergent control flow (web/venus-gpu.ts `subgroupsRight`).
        const subgroups = device ? await subgroupsRight(device) : true;
        if (!subgroups) console.warn('venus: the WebGPU device\'s subgroups are wrong in divergent control flow: subgroups of one invocation');
        const hold = subgroups ? vkHold : [...(vkHold ?? []), 'subgroups'];
        venus = await VenusRenderer.create(module, init.memory, { ...init.window, core: init.core }, device, device && adapter ? { features: device.features, limits: device.limits, adapterInfo: vkVendor ? { vendor: vkVendor } : adapter.info } : undefined, vkPoll, { syncPipelines: vkSyncPipelines, pipelineDelayMs: vkPipeDelayMs, cache, nudgeMs: vkNudgeMs, gpuTime: vkGpuTime, hold, heldFormats: vkHeldFormats, ycbcr: vkYcbcr, l9: l9Suspects(vkL9 ?? []) });
        venus.onRetire = () => fenced.release();
        const v = venus;
        if (device && adapter) {
          const mode = vkShare ?? (vkBreak?.length ? 'bitmap' : shareMode(adapter, glInfo(gl).renderer));
          share = new VenusShare(device, mode, renderer, (id) => v.shared(id), { forced: !!vkShare, broken: new Set(vkBreak), idle: () => v.gpu.idle() });
          console.log(`venus: Vulkan on ${adapter.info.vendor || 'an unnamed'} ${adapter.info.architecture} adapter; its frames reach virgl by ${mode}${vkShare ? ' (forced)' : mode === 'readback' ? '' : ', checked at the first copies'}`);
          // Its textures' writes in the queue's order: after the submits held for their pipelines (web/venus-gpu.ts `later`).
          const im = imports = new VenusImport(device, renderer, (f) => v.gpu.later(f));
          v.gpu.onImport = (t, res) => im.bind(t, res);
          renderer.onPlane = (res, data, w, h, bpp) => im.plane(res, data, w, h, bpp);
        }
        renderer.external = { has: (id) => v.has(id), refresh: (r) => share?.refresh(r) };
        for (const v of venusBacklog!) venusCall(v);
        venusBacklog = undefined;
        fenced.release();
      })().catch((err) => {
        console.warn('venus: the renderer could not start', err);
        venusBacklog = undefined;
        fenced.release();
      });
      return;
    }
    if (VENUS_CALLS.has(c.t)) {
      if (c.t === 'blob-unref') {
        // An imported blob's texture in virgl goes with it.
        renderer.unrefResource(c.res);
        share?.forget(c.res);
      }
      if (venusBacklog) venusBacklog.push(c as VenusCall);
      else if (venus) venusCall(c as VenusCall);
      return;
    }
    if (c.t === 'fence') {
      fenced.fence(c, settled());
      if (fenced.waiting && !pollTimer) poll();
      return;
    }
    if (c.t === 'read') {
      const bytes = renderer.readResource(c.res);
      port.postMessage({ t: 'read', id: c.id, bytes }, bytes ? [bytes.buffer] : []);
      return;
    }
    if (c.t === 'save') {
      // A snapshot: once the queries ended so far have their results (they are written to the guest's memory).
      const settled = renderer.queriesSettled();
      const answer = () => {
        renderer.pollQueries();
        if (!settled()) return void setTimeout(answer, 4);
        let a;
        try {
          a = saveRenderer(renderer);
        } catch (err) {
          a = { refused: `the 3D state couldn't be read: ${err instanceof Error ? err.message : err}` };
        }
        port.postMessage({ t: 'saved', id: c.id, ...a }, 'state' in a ? snapshotBuffers(a.state) : []);
      };
      answer();
      return;
    }
    if (c.t === 'ram') {
      ram = c.ram.map((m) => new Uint8Array(m.buffer, m.offset, m.length));
      return;
    }
    if (c.t === 'unref') imports?.unref(c.id);
    else if (c.t === 'reset' || c.t === 'load') imports?.reset();
    if (c.t === 'reset') {
      // Venus's contexts end with the guest that made them (calls still waiting for the renderer were the old guest's).
      if (venusBacklog) venusBacklog.length = 0;
      for (const res of venus?.reset() ?? []) share?.forget(res);
    }
    const t0 = performance.now();
    try {
      runCall(c, renderer, screen);
    } catch (err) {
      console.warn('virgl: a call failed', c.t, err);
    }
    const dt = performance.now() - t0;
    busyMs += dt;
    if (c.t === 'submit') submitMs += dt;
    if (!pollTimer && c.t === 'submit') poll();
  };
  // While calls wait for pictures, a timer drains and then gives up decoders that hold them (CallQueue.tick).
  let stallTimer: ReturnType<typeof setInterval> | undefined;
  const watch = () => {
    if (queue.stalled && !stallTimer) stallTimer = setInterval(() => { queue.tick(); watch(); }, 20);
    else if (!queue.stalled && stallTimer) {
      clearInterval(stallTimer);
      stallTimer = undefined;
    }
  };
  const queue = new CallQueue<WorkerCall>({ run, pending: renderer.videoPending, nudge: () => renderer.videoNudge(), drain: () => renderer.videoDrain(), giveUp: () => renderer.videoGiveUp(), giveUpOld: (before) => renderer.videoGiveUp(before) });
  renderer.onVideoSettled = () => {
    // Settled from inside a call (a picture given up or its buffer destroyed): the queue goes on after it.
    queueMicrotask(() => { queue.progress(); watch(); });
  };
  port.onmessage = (m: MessageEvent<WorkerCall>) => {
    // A submit that may sample a Vulkan program's image waits for its bytes (the readback way).
    if (share && m.data.t === 'submit') share.prepare(m.data.ctx);
    queue.push(m.data);
    watch();
  };
  if (stats) {
    let last = { ...renderer.stats };
    let lastShare = { refreshes: 0, ms: 0 };
    let lastImport = { binds: 0, pictures: 0, bytes: 0, ms: 0 };
    screen.presentAt = [];
    setInterval(() => {
      const s = renderer.stats;
      post({ type: 'render-stats', submits: s.submits - last.submits, draws: s.draws - last.draws, commands: s.commands - last.commands, busyMs, submitMs, presents: screen.presents, presentAt: screen.presentAt!.splice(0), drawMs: screen.drawMs, programs: s.programs, errors: s.errors, uploadBytes: s.uploadBytes - last.uploadBytes, readbacks: s.readbacks - last.readbacks, readbackBytes: s.readbackBytes - last.readbackBytes, fences, fenceMs, fenceMaxMs, compileMs: s.compileMs - last.compileMs, shareRefreshes: (share?.stats.refreshes ?? 0) - lastShare.refreshes, shareMs: (share?.stats.ms ?? 0) - lastShare.ms, importBinds: (imports?.stats.binds ?? 0) - lastImport.binds, importPictures: (imports?.stats.pictures ?? 0) - lastImport.pictures, importBytes: (imports?.stats.bytes ?? 0) - lastImport.bytes, importMs: (imports?.stats.ms ?? 0) - lastImport.ms, share: share && { ...share.check, dropped: [...share.check.dropped], checks: share.stats.checks, checksWrong: share.stats.checksWrong, unshared: share.stats.unshared }, venus: venus?.times(), venusPipelines: venus && { ...venusPipelines(venus.gpu.stats), cacheBytes: venus.gpu.cache?.stats.bytes ?? 0, cacheEntries: venus.gpu.cache?.stats.entries ?? 0 }, video: { ...renderer.videoStats, ahead: queue.ahead, maxWaitMs: queue.maxWaitMs } });
      fences = fenceMs = fenceMaxMs = 0;
      queue.maxWaitMs = 0;
      renderer.videoStats.latencyMaxMs = 0;
      last = { ...s };
      lastShare = { refreshes: share?.stats.refreshes ?? 0, ms: share?.stats.ms ?? 0 };
      lastImport = { ...(imports?.stats ?? lastImport) };
      busyMs = submitMs = 0;
      screen.presents = 0;
      screen.drawMs = 0;
    }, 1000);
  }
  let caps: Uint8Array;
  try {
    caps = capsFromGl(gl);
    if (decoders) caps = withVideo(caps, decoders.caps);
  } catch (err) {
    post({ type: 'failed', reason: `the caps couldn't be read: ${err}` });
    return;
  }
  const info = glInfo(gl);
  post({ type: 'ready', caps, renderer: info.renderer });
  // The status bar's numbers: what the renderer, the screen and the decoders count anyway, read once a second.
  const offered = (decoders?.caps ?? []).map((c) => ({ profile: profileName(c.profile), hardware: decoders!.hardware.includes(c.profile) }));
  const report = () => {
    const s = renderer.stats, v = renderer.videoStats;
    post({ type: 'stats', ...info, presents: screen.presented, submits: s.submits, commands: s.commands, draws: s.draws, errors: s.errors, video: { enabled: offered.length > 0, offered, streams: renderer.videoStreams(), frames: v.frames, decoded: v.decoded, dropped: v.dropped, errors: v.errors, decoderErrors: v.decoderErrors } });
  };
  report();
  setInterval(report, 1000);
};

/** Venus's pipelines so far (totals; VK3 L3): made, made asynchronously and ready (and their ms), submits held for them
 * (and their ms), made at once by a submit, vkCreate*Pipelines calls in the module and their ms, the shader store's
 * lookups found and missed and its stores. bench/vulkan/venus-run.ts takes a replay's difference. */
function venusPipelines(g: VenusGpuStats) {
  return { pipelines: g.pipelines, ready: g.pipelinesReady, readyMs: g.pipelineReadyMs, deferred: g.deferred, deferredMs: g.deferredMs, syncPipelines: g.syncPipelines, translations: g.translations, translateMs: g.translateMs, cacheHits: g.cacheHits, cacheMisses: g.cacheMisses, cacheStores: g.cacheStores };
}
