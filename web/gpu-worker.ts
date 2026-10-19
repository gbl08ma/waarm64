// The page's GPU worker (docs/frontend.md "The screen", docs/devices.md "virgl"): a top-level worker that owns the
// screen's canvas as WebGL2 on a 3D machine (the G3 kickoff's decision 2). The page starts it with the canvas and a
// port for the device worker; it answers with the caps this browser backs (web/virgl-caps.ts), or why it can't. Then
// it runs the device's calls (web/virgl-host.ts) in order: the renderer's (web/virgl-renderer.ts) and the screen's
// (web/virgl-screen.ts), and answers fences once everything before them has run. With video, what follows a
// picture waits until the picture is decoded (web/virgl-host.ts `CallQueue`).
import { capsFromGl, withVideo } from './virgl-caps.ts';
import { CallQueue, clock, FenceGate, runCall, saveRenderer, snapshotBuffers, type WorkerCall } from './virgl-host.ts';
import { VirglRenderer } from './virgl-renderer.ts';
import { flashProbe, Screen } from './virgl-screen.ts';
import { probeVideo, webCodecsDecoder, type VideoStats } from './virgl-video.ts';

/** Page → GPU worker. */
export type ToGpuWorker = { type: 'snapshotBytes'; id: number } | { type: 'init'; canvas: OffscreenCanvas; port: MessagePort; stats?: boolean; debug?: boolean; /** `?avprobe`: `flash` when a present turns the screen's centre bright (bench/audio/avsync.ts). */ probe?: boolean; /** Advertise the browser's video decoders and decode with them (docs/plans/video.md; the page's default, `?gpu=novideo` turns it off). */ video?: boolean; /** `?gpu=swvideo`: every codec decoded in software, H.264 offered (experiments on a host with hardware decoders). */ softwareVideo?: boolean };
/** GPU worker → page. */
export type FromGpuWorker =
  | { type: 'ready'; caps: Uint8Array; renderer: string }
  /** The bytes a snapshot would hold for the 3D resources, before compression (`VirglRenderer.snapshotBytes`): Save snapshot warns past a size. */
  | { type: 'snapshotBytes'; id: number; bytes: number }
  | { type: 'failed'; reason: string }
  | { type: 'lost' }
  /** With `probe`: a present turned the screen's centre bright, at `t` (ms since the epoch). */
  | { type: 'flash'; t: number }
  /** With `stats`, once a second: what the renderer did and the time it took (bench/gpu, `?displaystats`). */
  | { type: 'render-stats'; submits: number; draws: number; commands: number; busyMs: number; submitMs: number; presents: number; drawMs: number; programs: number; errors: number; uploadBytes: number; readbacks: number; readbackBytes: number; fences: number; fenceMs: number; fenceMaxMs: number; compileMs: number; /** The renderer's video totals since it started (web/virgl-video.ts `VideoStats`), how many calls ran ahead of ones waiting for pictures, and the longest wait (ms) in the second (`latencyMaxMs` too is the second's). */ video: VideoStats & { ahead: number; maxWaitMs: number } };

let ram: Uint8Array[] = [];
let snapshotBytes = () => 0;

self.onmessage = async (e: MessageEvent<ToGpuWorker>) => {
  if (e.data?.type === 'snapshotBytes') {
    (self as unknown as Worker).postMessage({ type: 'snapshotBytes', id: e.data.id, bytes: snapshotBytes() } satisfies FromGpuWorker);
    return;
  }
  if (e.data?.type !== 'init') return;
  const { canvas, port, stats, debug, probe, video, softwareVideo } = e.data;
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
  const poll = () => {
    pollTimer = undefined;
    queries = renderer.pollQueries();
    fenced.release();
    if (queries) pollTimer = setTimeout(poll, 4);
  };
  const run = (c: WorkerCall) => {
    if (c.t === 'fence') {
      fenced.fence(c, renderer.queriesSettled());
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
  const queue = new CallQueue<WorkerCall>({ run, pending: renderer.videoPending, nudge: () => renderer.videoNudge(), drain: () => renderer.videoDrain(), giveUp: () => renderer.videoGiveUp() });
  renderer.onVideoSettled = () => {
    // Settled from inside a call (a picture given up or its buffer destroyed): the queue goes on after it.
    queueMicrotask(() => { queue.progress(); watch(); });
  };
  port.onmessage = (m: MessageEvent<WorkerCall>) => {
    queue.push(m.data);
    watch();
  };
  if (stats) {
    let last = { ...renderer.stats };
    setInterval(() => {
      const s = renderer.stats;
      post({ type: 'render-stats', submits: s.submits - last.submits, draws: s.draws - last.draws, commands: s.commands - last.commands, busyMs, submitMs, presents: screen.presents, drawMs: screen.drawMs, programs: s.programs, errors: s.errors, uploadBytes: s.uploadBytes - last.uploadBytes, readbacks: s.readbacks - last.readbacks, readbackBytes: s.readbackBytes - last.readbackBytes, fences, fenceMs, fenceMaxMs, compileMs: s.compileMs - last.compileMs, video: { ...renderer.videoStats, ahead: queue.ahead, maxWaitMs: queue.maxWaitMs } });
      fences = fenceMs = fenceMaxMs = 0;
      queue.maxWaitMs = 0;
      renderer.videoStats.latencyMaxMs = 0;
      last = { ...s };
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
  const dbg = gl.getExtension('WEBGL_debug_renderer_info');
  post({ type: 'ready', caps, renderer: String(gl.getParameter(dbg ? dbg.UNMASKED_RENDERER_WEBGL : gl.RENDERER)) });
};
