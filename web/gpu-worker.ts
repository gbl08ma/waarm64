// The page's GPU worker (docs/frontend.md "The screen", docs/devices.md "virgl"): a top-level worker that owns the
// screen's canvas as WebGL2 on a 3D machine (the G3 kickoff's decision 2). The page starts it with the canvas and a
// port for the device worker; it answers with the caps this browser backs (web/virgl-caps.ts), or why it can't. Then
// it runs the device's calls (web/virgl-host.ts) in order: the renderer's (web/virgl-renderer.ts) and the screen's
// (web/virgl-screen.ts), and answers fences once everything before them has run.
import { capsFromGl } from './virgl-caps.ts';
import { runCall, type HostCall } from './virgl-host.ts';
import { VirglRenderer } from './virgl-renderer.ts';
import { Screen } from './virgl-screen.ts';

/** Page → GPU worker. */
export type ToGpuWorker = { type: 'init'; canvas: OffscreenCanvas; port: MessagePort; stats?: boolean };
/** GPU worker → page. */
export type FromGpuWorker =
  | { type: 'ready'; caps: Uint8Array; renderer: string }
  | { type: 'failed'; reason: string }
  | { type: 'lost' }
  /** With `stats`, once a second: what the renderer did and the time it took (bench/gpu, `?displaystats`). */
  | { type: 'render-stats'; submits: number; draws: number; commands: number; busyMs: number; submitMs: number; presents: number; drawMs: number; programs: number; errors: number; uploadBytes: number };

let ram: Uint8Array = new Uint8Array(0);

self.onmessage = (e: MessageEvent<ToGpuWorker>) => {
  if (e.data?.type !== 'init') return;
  const { canvas, port, stats } = e.data;
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
  const renderer = new VirglRenderer(gl, { ram: () => ram });
  const screen = new Screen(gl, renderer);
  let busyMs = 0, submitMs = 0, queries = 0;
  let pollTimer: ReturnType<typeof setTimeout> | undefined;
  // WebGL's query results come after the task that ended the query: polled while some are pending.
  const poll = () => {
    pollTimer = undefined;
    queries = renderer.pollQueries();
    if (queries) pollTimer = setTimeout(poll, 4);
  };
  port.onmessage = (m: MessageEvent<HostCall | { t: 'fence'; id: number }>) => {
    const c = m.data;
    if (c.t === 'fence') {
      port.postMessage({ t: 'fenced', id: c.id });
      return;
    }
    if (c.t === 'ram') {
      ram = new Uint8Array(c.buffer, c.offset, c.length);
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
  if (stats) {
    let last = { ...renderer.stats };
    setInterval(() => {
      const s = renderer.stats;
      post({ type: 'render-stats', submits: s.submits - last.submits, draws: s.draws - last.draws, commands: s.commands - last.commands, busyMs, submitMs, presents: screen.presents, drawMs: screen.drawMs, programs: s.programs, errors: s.errors, uploadBytes: s.uploadBytes - last.uploadBytes });
      last = { ...s };
      busyMs = submitMs = 0;
      screen.presents = 0;
      screen.drawMs = 0;
    }, 1000);
  }
  let caps: Uint8Array;
  try {
    caps = capsFromGl(gl);
  } catch (err) {
    post({ type: 'failed', reason: `the caps couldn't be read: ${err}` });
    return;
  }
  const dbg = gl.getExtension('WEBGL_debug_renderer_info');
  post({ type: 'ready', caps, renderer: String(gl.getParameter(dbg ? dbg.UNMASKED_RENDERER_WEBGL : gl.RENDERER)) });
};
