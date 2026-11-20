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
import { flashProbe, glInfo, Screen } from './virgl-screen.ts';
import type { GpuHooks, Rect, ScanoutSource } from './gpu.ts';

/** Page ⇄ backend over the display port. */
export type DisplayToPage =
  | { type: 'mode'; width: number; height: number }
  /**
   * The guest's cursor: its 64×64 RGBA and hotspot, `null` when the guest hid it, `undefined` when it never set one (the
   * page's own pointer), and where it is (guest pixels). The tablet is absolute, so the host's pointer is the guest's;
   * the position is for the page's own drawing of it while the screen holds the mouse (docs/frontend.md "Mouse lock").
   */
  | { type: 'cursor'; image: ArrayBuffer | null | undefined; hotX: number; hotY: number; x: number; y: number }
  /** The guest moved its cursor (the image as it was). */
  | { type: 'cursor-at'; x: number; y: number }
  /** With `stats`: once a second, the draws since the last (n) and the ms from the flush that made them to the draw (median, max): bench/gpu. */
  /** A virgl trace's record (the spec's `capture`, web/virgl-trace.ts). */
  | { type: 'capture'; record: Uint8Array }
  /** With `probe` (`?avprobe`): a draw turned the screen's centre bright, at `t` (ms since the epoch: `performance.timeOrigin + now`). */
  | { type: 'flash'; t: number }
  /**
   * A 2D machine's screen (`canvasPresenter`; a 3D machine's GPU worker sends its own `stats`, web/gpu-worker.ts): once a
   * second from the first scanout on, always (not only with `stats`). `presents` is the canvas's draws since the
   * presenter was made (a total: rates are the page's; at most one a display frame, however many flushes the guest
   * made); `screen` what draws it: WebGL2 on the GPU (with its renderer, read once) or a 2D context (on a browser
   * whose WebGL2 renders on the CPU, or without one: no renderer to name). A machine without virtio-gpu sends it from
   * its machine worker, `framebuffer`: the simple framebuffer's draws (web/display.ts), from the start on.
   */
  | {
      type: 'screen-stats';
      screen: 'webgl2' | 'canvas2d' | 'framebuffer';
      presents: number;
      renderer?: string;
      vendor?: string;
      software?: boolean;
    }
  | ScreenPng
  | {
      type: 'draw-stats';
      n: number;
      median: number;
      max: number;
      lag: number;
      busy: {
        events?: number[];
        request: number;
        transfer: number;
        draw: number;
        requests: number;
        transfers: number;
        pixels: number;
        flushes: number;
        submits: number;
        submitBytes: number;
        commands: Record<string, number>;
        fences: number;
        fenceMs: number;
        fenceMaxMs: number;
        heldMs: number;
        behindMs: number;
        fullMs: number;
        heldMax: number;
        fenceBack: { n: number; ms: number; maxMs: number };
      };
    };
export type DisplayFromPage =
  | { type: 'size'; width: number; height: number }
  | /** "Copy the screen" (docs/plans/clipboard.md §4.4): the screen as a PNG, answered by `ScreenPng`. */ {
      type: 'png';
      id: number;
    };
/** The answer to `png`: the screen as it shows now, as a PNG; none before the guest showed anything. */
export type ScreenPng = { type: 'png'; id: number; png?: Blob };

/**
 * The scanout's visible rectangle as a PNG, from the host's copy of the guest's resource (`swizzle`d where it is the
 * guest's bytes, `GpuHooks.raw`), opaque: what a WebGL2 canvas no longer holds once drawn. Undefined without a scanout.
 */
export function scanoutPng(src: ScanoutSource | null, width: number, height: number): Promise<Blob> | undefined {
  if (!src || !width || !height || typeof OffscreenCanvas === 'undefined') return undefined;
  const img = new ImageData(width, height);
  const [ri, gi, bi] = src.swizzle ?? [0, 1, 2];
  for (let y = 0; y < height; y++) {
    for (let x = 0, p = 4 * ((src.y + y) * src.width + src.x), q = 4 * y * width; x < width; x++, p += 4, q += 4) {
      img.data[q] = src.pixels[p + ri];
      img.data[q + 1] = src.pixels[p + gi];
      img.data[q + 2] = src.pixels[p + bi];
      img.data[q + 3] = 255;
    }
  }
  const c = new OffscreenCanvas(width, height);
  c.getContext('2d')!.putImageData(img, 0, 0);
  return c.convertToBlob({ type: 'image/png' });
}

/** The guest's cursor to the page: its image when it changes (`cursor`), else its position when that changes and there is an image (`cursor-at`). */
function cursorSender(port?: MessagePort) {
  let cursorImage: Uint8Array | null | undefined;
  let cursorHot = '';
  let cursorAt = '';
  return (image: Uint8Array | null | undefined, hotX: number, hotY: number, x: number, y: number) => {
    const [hot, where] = [`${hotX},${hotY}`, `${x},${y}`];
    if (image === cursorImage && hot === cursorHot) {
      if (where !== cursorAt && image) port?.postMessage({ type: 'cursor-at', x, y } satisfies DisplayToPage); // a hidden cursor's moves aren't drawn
      cursorAt = where;
      return;
    }
    [cursorImage, cursorHot, cursorAt] = [image, hot, where];
    port?.postMessage({
      type: 'cursor',
      image: image ? image.slice().buffer : image,
      hotX,
      hotY,
      x,
      y,
    } satisfies DisplayToPage);
  };
}

/** Which screen a 2D machine gets: WebGL2 unless it is software (`auto`), or the one named (the page's `?gpu=canvas2d` or `gl2d`: tests and measurements). */
export type Screen2d = 'auto' | 'canvas2d' | 'webgl2';

/** This browser's WebGL2 renders on the CPU (or there is none): asked of a context of its own, since a canvas keeps the first context type it gives. */
export function softwareGl() {
  const gl = typeof OffscreenCanvas === 'undefined' ? null : new OffscreenCanvas(1, 1).getContext('webgl2');
  if (!gl) return true;
  const { software } = glInfo(gl);
  gl.getExtension('WEBGL_lose_context')?.loseContext();
  return software;
}

export function canvasPresenter(
  canvas: OffscreenCanvas,
  port?: MessagePort,
  stats = false,
  probe = false,
  which: Screen2d = 'auto',
): GpuHooks {
  const sample =
    probe && port ? flashProbe((t) => port.postMessage({ type: 'flash', t } satisfies DisplayToPage)) : undefined;
  const gl =
    which === 'canvas2d' || (which === 'auto' && softwareGl())
      ? null
      : (canvas.getContext('webgl2', {
          alpha: false,
          antialias: false,
          depth: false,
          stencil: false,
          premultipliedAlpha: false,
          preserveDrawingBuffer: false,
        }) as WebGL2RenderingContext | null);
  let screen = gl ? new Screen(gl) : undefined;
  const info = gl ? glInfo(gl) : undefined;
  let presents = 0,
    reporting = false;
  const report = () => {
    if (reporting || !port) return;
    reporting = true;
    setInterval(
      () =>
        port.postMessage({
          type: 'screen-stats',
          screen: info ? 'webgl2' : 'canvas2d',
          presents,
          ...info,
        } satisfies DisplayToPage),
      1000,
    );
  };
  const ctx = gl ? undefined : (canvas.getContext('2d', { alpha: false }) as OffscreenCanvasRenderingContext2D);
  let src: ScanoutSource | null = null;
  let img: ImageData | undefined;
  let dirty: Rect | null = null;
  let scheduled = false;
  let since = 0; // performance.now() of the oldest damage not drawn yet
  const lat: number[] = [];
  let drawMs = 0;
  if (stats && port) {
    // The device worker's own event loop: the longest a 4 ms timer was late in the second (what a key's release, a doorbell or a flush waits behind).
    let lag = 0,
      tick = performance.now();
    setInterval(() => {
      const n = performance.now();
      lag = Math.max(lag, n - tick - 4);
      tick = n;
    }, 4);
    setInterval(() => {
      const s = lat.splice(0).sort((a, b) => a - b);
      port.postMessage({
        type: 'draw-stats',
        n: s.length,
        median: s[s.length >> 1] ?? 0,
        max: s[s.length - 1] ?? 0,
        lag,
        busy: { ...busy, commands: { ...busy.commands }, fenceBack: { ...fenceLag }, draw: drawMs },
      } satisfies DisplayToPage);
      lag = 0;
      Object.assign(busy, {
        request: 0,
        transfer: 0,
        requests: 0,
        transfers: 0,
        pixels: 0,
        flushes: 0,
        submits: 0,
        submitBytes: 0,
        commands: {},
        fences: 0,
        fenceMs: 0,
        fenceMaxMs: 0,
        heldMs: 0,
        behindMs: 0,
        fullMs: 0,
        heldMax: 0,
      });
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
    presents++;
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
      screen.set({
        pixels: src.pixels,
        swizzle: src.swizzle,
        width: src.width,
        height: src.height,
        rect: { x: src.x, y: src.y, w: canvas.width, h: canvas.height },
      });
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
  const sendCursor = cursorSender(port);
  return {
    raw: !!gl,
    cursor: sendCursor,
    cursorReset: () => sendCursor(undefined, 0, 0, 0, 0),
    png: () => scanoutPng(src, canvas.width, canvas.height),
    scanout(width, height, source) {
      src = source;
      img =
        source && !gl
          ? new ImageData(
              new Uint8ClampedArray(
                source.pixels.buffer as ArrayBuffer,
                source.pixels.byteOffset,
                source.pixels.length,
              ),
              source.width,
              source.height,
            )
          : undefined;
      if (canvas.width !== width || canvas.height !== height) {
        // A canvas resized is cleared; the mode goes to the page so it refits its box.
        if (width && height) [canvas.width, canvas.height] = [width, height];
        port?.postMessage({ type: 'mode', width, height } satisfies DisplayToPage);
      }
      dirty = src ? { x: 0, y: 0, w: width, h: height } : null;
      if (src) report();
      if (screen && source)
        screen.set({
          pixels: source.pixels,
          swizzle: source.swizzle,
          width: source.width,
          height: source.height,
          rect: { x: source.x, y: source.y, w: width, h: height },
        });
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
        const x1 = Math.min(dirty.x, r.x),
          y1 = Math.min(dirty.y, r.y);
        const x2 = Math.max(dirty.x + dirty.w, r.x + r.w),
          y2 = Math.max(dirty.y + dirty.h, r.y + r.h);
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
  let width = 0,
    height = 0;
  if (stats && port) {
    busy.events = [];
    // The device worker's event loop, as canvasPresenter's: the longest a 4 ms timer was late in the second.
    let lag = 0,
      tick = performance.now();
    setInterval(() => {
      const n = performance.now();
      lag = Math.max(lag, n - tick - 4);
      tick = n;
    }, 4);
    setInterval(() => {
      port.postMessage({
        type: 'draw-stats',
        n: busy.flushes,
        median: 0,
        max: 0,
        lag,
        busy: {
          ...busy,
          events: busy.events!.splice(0),
          commands: { ...busy.commands },
          fenceBack: { ...fenceLag },
          draw: 0,
        },
      } satisfies DisplayToPage);
      Object.assign(busy, {
        request: 0,
        transfer: 0,
        requests: 0,
        transfers: 0,
        pixels: 0,
        flushes: 0,
        submits: 0,
        submitBytes: 0,
        commands: {},
        fences: 0,
        fenceMs: 0,
        fenceMaxMs: 0,
        heldMs: 0,
        behindMs: 0,
        fullMs: 0,
        heldMax: 0,
      });
      Object.assign(fenceLag, { n: 0, ms: 0, maxMs: 0 });
      lag = 0;
    }, 1000);
  }
  const sendCursor = cursorSender(port);
  return {
    cursor: sendCursor,
    cursorReset: () => sendCursor(undefined, 0, 0, 0, 0),
    scanout(w, h) {
      if (w === width && h === height) return;
      [width, height] = [w, h];
      port?.postMessage({ type: 'mode', width: w, height: h } satisfies DisplayToPage);
    },
  };
}
