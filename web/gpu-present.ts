// The virtio-gpu scanout on a canvas (docs/devices.md "virtio-gpu"): `GpuHooks` for a worker's
// OffscreenCanvas. The backend's transfers and flushes give damaged rectangles; they accumulate into one rectangle
// and are drawn at most once per frame, straight from the host's copy of the guest's resource (no scan of guest
// memory). Where the browser has WebGL2 on a GPU that copy is the guest's bytes as they are (`GpuHooks.raw`),
// uploaded to a texture and drawn through the format's swizzle (the 3D machine's `Screen`, web/virgl-screen.ts);
// elsewhere it is RGBA, put on a 2D context without alpha (an ImageData over the bytes: no copy). Software WebGL
// (SwiftShader) gets the 2D context: it rasterizes every present on the CPU, 7 to 18 ms against ~1 for canvas 2D
// (bench/gpu/REPORT.md, "A 2D machine on WebGL2"). The canvas has the scanout's size; when it changes the page is
// told (`mode`) to refit its box.
import { busy } from './gpu.ts';
import { fenceLag } from './virgl-host.ts';
import { flashProbe, Screen } from './virgl-screen.ts';
import type { GpuHooks, Rect, ScanoutSource } from './gpu.ts';

/** Page ⇄ backend over the display port. */
export type DisplayToPage =
  | { type: 'mode'; width: number; height: number }
  /** The guest's cursor: its 64×64 RGBA and hotspot, `null` when the guest hid it, `undefined` when it never set one (the page's own pointer). The position isn't sent: the tablet is absolute, the host's pointer is the guest's. */
  | { type: 'cursor'; image: ArrayBuffer | null | undefined; hotX: number; hotY: number }
  /** With `stats`: once a second, the draws since the last (n) and the ms from the flush that made them to the draw (median, max): bench/gpu. */
  /** A virgl trace's record (the spec's `capture`, web/virgl-trace.ts). */
  | { type: 'capture'; record: Uint8Array }
  /** With `probe` (`?avprobe`): a draw turned the screen's centre bright, at `t` (ms since the epoch: `performance.timeOrigin + now`). */
  | { type: 'flash'; t: number }
  | { type: 'draw-stats'; n: number; median: number; max: number; lag: number; busy: { request: number; transfer: number; draw: number; requests: number; transfers: number; pixels: number; flushes: number; submits: number; submitBytes: number; commands: Record<string, number>; fences: number; fenceMs: number; fenceMaxMs: number; heldMs: number; behindMs: number; fullMs: number; heldMax: number; fenceBack: { n: number; ms: number; maxMs: number } } };
export type DisplayFromPage = { type: 'size'; width: number; height: number };

/** Which screen a 2D machine gets: WebGL2 unless it is software (`auto`), or the one named (the page's `?gpu=canvas2d` or `gl2d`: tests and measurements). */
export type Screen2d = 'auto' | 'canvas2d' | 'webgl2';

/** This browser's WebGL2 renders on the CPU (or there is none): asked of a context of its own, since a canvas keeps the first context type it gives. */
export function softwareGl() {
  const gl = typeof OffscreenCanvas === 'undefined' ? null : new OffscreenCanvas(1, 1).getContext('webgl2');
  if (!gl) return true;
  const dbg = gl.getExtension('WEBGL_debug_renderer_info');
  const renderer = String(gl.getParameter(dbg ? dbg.UNMASKED_RENDERER_WEBGL : gl.RENDERER));
  gl.getExtension('WEBGL_lose_context')?.loseContext();
  return /SwiftShader|llvmpipe|softpipe|Basic Render Driver/i.test(renderer);
}

export function canvasPresenter(canvas: OffscreenCanvas, port?: MessagePort, stats = false, probe = false, which: Screen2d = 'auto'): GpuHooks {
  const sample = probe && port ? flashProbe((t) => port.postMessage({ type: 'flash', t } satisfies DisplayToPage)) : undefined;
  const gl = which === 'canvas2d' || (which === 'auto' && softwareGl()) ? null : canvas.getContext('webgl2', { alpha: false, antialias: false, depth: false, stencil: false, premultipliedAlpha: false, preserveDrawingBuffer: false }) as WebGL2RenderingContext | null;
  let screen = gl ? new Screen(gl) : undefined;
  const ctx = gl ? undefined : canvas.getContext('2d', { alpha: false }) as OffscreenCanvasRenderingContext2D;
  let src: ScanoutSource | null = null;
  let img: ImageData | undefined;
  let dirty: Rect | null = null;
  let scheduled = false;
  let since = 0; // performance.now() of the oldest damage not drawn yet
  const lat: number[] = [];
  let drawMs = 0;
  if (stats && port) {
    // The device worker's own event loop: the longest a 4 ms timer was late in the second (what a key's release, a doorbell or a flush waits behind).
    let lag = 0, tick = performance.now();
    setInterval(() => { const n = performance.now(); lag = Math.max(lag, n - tick - 4); tick = n; }, 4);
    setInterval(() => {
      const s = lat.splice(0).sort((a, b) => a - b);
      port.postMessage({ type: 'draw-stats', n: s.length, median: s[s.length >> 1] ?? 0, max: s[s.length - 1] ?? 0, lag, busy: { ...busy, commands: { ...busy.commands }, fenceBack: { ...fenceLag }, draw: drawMs } } satisfies DisplayToPage);
      lag = 0;
      Object.assign(busy, { request: 0, transfer: 0, requests: 0, transfers: 0, pixels: 0, flushes: 0, submits: 0, submitBytes: 0, commands: {}, fences: 0, fenceMs: 0, fenceMaxMs: 0, heldMs: 0, behindMs: 0, fullMs: 0, heldMax: 0 });
      Object.assign(fenceLag, { n: 0, ms: 0, maxMs: 0 });
      drawMs = 0;
    }, 1000);
  }
  const FRAME_MS = 15; // under a 60 Hz frame: a flush a frame after the last is drawn at once, not a timer later
  let lastDraw = -Infinity;
  const frame = () => {
    scheduled = false;
    if (!src || (!img && !screen) || !dirty) return;
    const d = dirty;
    dirty = null;
    const t0 = performance.now();
    if (screen) {
      if (lost) return;
      screen.upload(d);
      screen.draw();
    } else ctx!.putImageData(img!, -src.x, -src.y, src.x + d.x, src.y + d.y, d.w, d.h);
    lastDraw = performance.now();
    drawMs += lastDraw - t0;
    if (stats) lat.push(performance.now() - since);
    if (sample) {
      const p = 4 * ((src.y + (canvas.height >> 1)) * src.width + src.x + (canvas.width >> 1));
      const [ri, gi, bi] = src.swizzle ?? [0, 1, 2];
      sample(src.pixels[p + ri], src.pixels[p + gi], src.pixels[p + bi]);
    }
  };
  // A lost context (the GPU process restarted, a driver reset) comes back when the browser can: a new screen
  // with the whole scanout on it. Until then nothing is drawn.
  let lost = false;
  if (gl) {
    canvas.addEventListener('webglcontextlost', (ev) => {
      ev.preventDefault();
      lost = true;
    });
    canvas.addEventListener('webglcontextrestored', () => {
      lost = false;
      screen = new Screen(gl);
      if (!src) return screen.clear();
      screen.set({ pixels: src.pixels, swizzle: src.swizzle, width: src.width, height: src.height, rect: { x: src.x, y: src.y, w: canvas.width, h: canvas.height } });
      dirty = { x: 0, y: 0, w: canvas.width, h: canvas.height };
      since = performance.now();
      schedule();
    });
  }
  // The device worker has no animation frames (Chromium: "requestAnimationFrame not supported in this Worker"
  // for a canvas that was handed on from the machine worker): a timer for a frame after the last draw then.
  let frames = true;
  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    if (frames) {
      try {
        requestAnimationFrame(frame);
        return;
      } catch {
        frames = false;
      }
    }
    setTimeout(frame, Math.max(0, lastDraw + FRAME_MS - performance.now()));
  };
  let cursorImage: Uint8Array | null | undefined;
  let cursorHot = '';
  const sendCursor = (image: Uint8Array | null | undefined, hotX: number, hotY: number) => {
    const hot = `${hotX},${hotY}`;
    if (image === cursorImage && hot === cursorHot) return; // a move: the page's pointer already is the guest's
    [cursorImage, cursorHot] = [image, hot];
    port?.postMessage({ type: 'cursor', image: image ? image.slice().buffer : image, hotX, hotY } satisfies DisplayToPage);
  };
  return {
    raw: !!gl,
    cursor: (image, hotX, hotY) => sendCursor(image, hotX, hotY),
    cursorReset: () => sendCursor(undefined, 0, 0),
    scanout(width, height, source) {
      src = source;
      img = source && !gl ? new ImageData(new Uint8ClampedArray(source.pixels.buffer as ArrayBuffer, source.pixels.byteOffset, source.pixels.length), source.width, source.height) : undefined;
      if (canvas.width !== width || canvas.height !== height) {
        // A canvas resized is cleared; the mode goes to the page so it refits its box.
        if (width && height) [canvas.width, canvas.height] = [width, height];
        port?.postMessage({ type: 'mode', width, height } satisfies DisplayToPage);
      }
      dirty = src ? { x: 0, y: 0, w: width, h: height } : null;
      if (screen && source) screen.set({ pixels: source.pixels, swizzle: source.swizzle, width: source.width, height: source.height, rect: { x: source.x, y: source.y, w: width, h: height } });
      if (!src) {
        if (screen) {
          if (!lost) screen.clear();
        } else ctx!.fillRect(0, 0, canvas.width, canvas.height);
      } else schedule();
    },
    damage(r) {
      if (!dirty) {
        dirty = { ...r };
        since = performance.now();
      } else {
        const x1 = Math.min(dirty.x, r.x), y1 = Math.min(dirty.y, r.y);
        const x2 = Math.max(dirty.x + dirty.w, r.x + r.w), y2 = Math.max(dirty.y + dirty.h, r.y + r.h);
        dirty = { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
      }
      // At most one draw per frame: at once if the last was a frame ago (a key's echo shows without waiting for a timer), else on the timer.
      if (performance.now() - lastDraw >= FRAME_MS) frame();
      else schedule();
    },
  };
}

/**
 * The display's hooks on a 3D machine (docs/frontend.md "The screen"): the GPU worker draws the screen (its
 * scanouts come from the device through the host, web/virgl-host.ts), so these only tell the page the scanout's
 * size (`mode`) and the cursor, and with `stats` the device's busy counters once a second (`n` is the flushes).
 */
export function pagePresenter(port?: MessagePort, stats = false): GpuHooks {
  let width = 0, height = 0;
  if (stats && port) {
    setInterval(() => {
      port.postMessage({ type: 'draw-stats', n: busy.flushes, median: 0, max: 0, lag: 0, busy: { ...busy, commands: { ...busy.commands }, fenceBack: { ...fenceLag }, draw: 0 } } satisfies DisplayToPage);
      Object.assign(busy, { request: 0, transfer: 0, requests: 0, transfers: 0, pixels: 0, flushes: 0, submits: 0, submitBytes: 0, commands: {}, fences: 0, fenceMs: 0, fenceMaxMs: 0, heldMs: 0, behindMs: 0, fullMs: 0, heldMax: 0 });
      Object.assign(fenceLag, { n: 0, ms: 0, maxMs: 0 });
    }, 1000);
  }
  let cursorImage: Uint8Array | null | undefined;
  let cursorHot = '';
  const sendCursor = (image: Uint8Array | null | undefined, hotX: number, hotY: number) => {
    const hot = `${hotX},${hotY}`;
    if (image === cursorImage && hot === cursorHot) return;
    [cursorImage, cursorHot] = [image, hot];
    port?.postMessage({ type: 'cursor', image: image ? image.slice().buffer : image, hotX, hotY } satisfies DisplayToPage);
  };
  return {
    cursor: (image, hotX, hotY) => sendCursor(image, hotX, hotY),
    cursorReset: () => sendCursor(undefined, 0, 0),
    scanout(w, h) {
      if (w === width && h === height) return;
      [width, height] = [w, h];
      port?.postMessage({ type: 'mode', width: w, height: h } satisfies DisplayToPage);
    },
  };
}
