// The page's GPU worker (docs/frontend.md "The screen", docs/graphics.md "The GPU worker"): a top-level worker that owns the
// screen's canvas as WebGL2 on a 3D machine (the G3 kickoff's decision 2). The page starts it with the canvas and a
// port for the device worker; it answers with the caps this browser backs (web/virgl-caps.ts), or why it can't. Then
// it runs the device's calls (web/virgl-host.ts) in order: the renderer's (web/virgl-renderer.ts) and the screen's
// (web/virgl-screen.ts), and answers fences once everything before them has run. With video, what follows a
// picture waits until the picture is decoded (web/virgl-host.ts `CallQueue`).
import { capsFromGl, withVideo } from './virgl-caps.ts';
import { CallQueue, clock, FenceGate, runCall, saveRenderer, snapshotBuffers, STUCK_MS, type VenusCall, type WorkerCall } from './virgl-host.ts';
import { deviceRequest } from './venus-gpu.ts';
import { VenusRenderer } from './venus-host.ts';
import { shareMode, VenusShare, type ShareMode } from './venus-share.ts';
import { VirglRenderer } from './virgl-renderer.ts';
import { flashProbe, glInfo, Screen } from './virgl-screen.ts';
import { probeVideo, profileName, webCodecsDecoder, type VideoStats, type VideoStream } from './virgl-video.ts';

/** Page → GPU worker. */
export type ToGpuWorker = { type: 'snapshotBytes'; id: number } | { type: 'init'; canvas: OffscreenCanvas; port: MessagePort; stats?: boolean; debug?: boolean; /** `?avprobe`: `flash` when a present turns the screen's centre bright (bench/audio/avsync.ts). */ probe?: boolean; /** Advertise the browser's video decoders and decode with them (docs/plans/video.md; the page's default, `?gpu=novideo` turns it off). */ video?: boolean; /** `?gpu=swvideo`: every codec decoded in software, H.264 offered (experiments on a host with hardware decoders). */ softwareVideo?: boolean; /** `?gpu=vkbitmap` or `vkreadback`: how Vulkan's frames reach virgl (web/venus-share.ts), instead of the probe's choice. */ vkShare?: ShareMode };
/** GPU worker → page. */
export type FromGpuWorker =
  | { type: 'ready'; caps: Uint8Array; renderer: string }
  /** The bytes a snapshot would hold for the 3D resources, before compression (`VirglRenderer.snapshotBytes`): Save snapshot warns past a size. */
  | { type: 'snapshotBytes'; id: number; bytes: number }
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
  | { type: 'render-stats'; submits: number; draws: number; commands: number; busyMs: number; submitMs: number; presents: number; presentAt: number[]; drawMs: number; programs: number; errors: number; uploadBytes: number; readbacks: number; readbackBytes: number; fences: number; fenceMs: number; fenceMaxMs: number; compileMs: number; /** Vulkan's frames copied into virgl's textures (web/venus-share.ts) and the thread's ms for them, in the second. */ shareRefreshes: number; shareMs: number; /** The renderer's video totals since it started (web/virgl-video.ts `VideoStats`), how many calls ran ahead of ones waiting for pictures, and the longest wait (ms) in the second (`latencyMaxMs` too is the second's). */ video: VideoStats & { ahead: number; maxWaitMs: number } };

/** The video part of `stats`. */
export type GpuVideoStats = { enabled: boolean; offered: { profile: string; hardware: boolean }[]; streams: VideoStream[]; frames: number; decoded: number; dropped: number; errors: number; decoderErrors: number };

let ram: Uint8Array[] = [];
let snapshotBytes = () => 0;

self.onmessage = async (e: MessageEvent<ToGpuWorker>) => {
  if (e.data?.type === 'snapshotBytes') {
    (self as unknown as Worker).postMessage({ type: 'snapshotBytes', id: e.data.id, bytes: snapshotBytes() } satisfies FromGpuWorker);
    return;
  }
  if (e.data?.type !== 'init') return;
  const { canvas, port, stats, debug, probe, video, softwareVideo, vkShare } = e.data;
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
        const module = await WebAssembly.compileStreaming(fetch(new URL(/* @vite-ignore */ '../target/vk/venus.wasm', import.meta.url).href));
        // The driver's WebGPU device (none: it keeps Venus's objects and draws nothing).
        const adapter = await navigator.gpu?.requestAdapter({ powerPreference: 'high-performance' }).catch(() => null);
        const device = adapter ? await adapter.requestDevice(deviceRequest(adapter)).catch((err) => { console.warn('venus: no WebGPU device', err); return undefined; }) : undefined;
        if (!device) console.warn('venus: this browser has no WebGPU adapter here: Vulkan draws nothing');
        device?.lost.then((info) => console.warn(`venus: the WebGPU device was lost: ${info.message}`));
        venus = await VenusRenderer.create(module, init.memory, init.window, device);
        venus.onRetire = () => fenced.release();
        const v = venus;
        if (device && adapter) {
          const mode = vkShare ?? shareMode(adapter, glInfo(gl).renderer);
          share = new VenusShare(device, mode, renderer, (id) => v.shared(id));
          console.log(`venus: Vulkan's frames reach virgl by ${mode}`);
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
    screen.presentAt = [];
    setInterval(() => {
      const s = renderer.stats;
      post({ type: 'render-stats', submits: s.submits - last.submits, draws: s.draws - last.draws, commands: s.commands - last.commands, busyMs, submitMs, presents: screen.presents, presentAt: screen.presentAt!.splice(0), drawMs: screen.drawMs, programs: s.programs, errors: s.errors, uploadBytes: s.uploadBytes - last.uploadBytes, readbacks: s.readbacks - last.readbacks, readbackBytes: s.readbackBytes - last.readbackBytes, fences, fenceMs, fenceMaxMs, compileMs: s.compileMs - last.compileMs, shareRefreshes: (share?.stats.refreshes ?? 0) - lastShare.refreshes, shareMs: (share?.stats.ms ?? 0) - lastShare.ms, video: { ...renderer.videoStats, ahead: queue.ahead, maxWaitMs: queue.maxWaitMs } });
      fences = fenceMs = fenceMaxMs = 0;
      queue.maxWaitMs = 0;
      renderer.videoStats.latencyMaxMs = 0;
      last = { ...s };
      lastShare = { refreshes: share?.stats.refreshes ?? 0, ms: share?.stats.ms ?? 0 };
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
