// The virtio-gpu scanout on a canvas (docs/devices.md "virtio-gpu"): `GpuHooks` for a worker's
// OffscreenCanvas (a 2D context without alpha). The backend's transfers and flushes give damaged rectangles;
// they accumulate into one rectangle and are drawn at most once per frame, straight from the host's copy of
// the guest's resource (an ImageData over its RGBA bytes: no copy, no scan of guest memory). The canvas has
// the scanout's size; when it changes the page is told (`mode`) to refit its box.
import { busy } from './gpu.ts';
import type { GpuHooks, Rect, ScanoutSource } from './gpu.ts';

/** Page ⇄ backend over the display port. */
export type DisplayToPage =
  | { type: 'mode'; width: number; height: number }
  /** The guest's cursor: its 64×64 RGBA and hotspot, `null` when the guest hid it, `undefined` when it never set one (the page's own pointer). The position isn't sent: the tablet is absolute, the host's pointer is the guest's. */
  | { type: 'cursor'; image: ArrayBuffer | null | undefined; hotX: number; hotY: number }
  /** With `stats`: once a second, the draws since the last (n) and the ms from the flush that made them to the draw (median, max): bench/gpu. */
  | { type: 'draw-stats'; n: number; median: number; max: number; lag: number; busy: { request: number; transfer: number; draw: number; requests: number; transfers: number; pixels: number } };
export type DisplayFromPage = { type: 'size'; width: number; height: number };

export function canvasPresenter(canvas: OffscreenCanvas, port?: MessagePort, stats = false): GpuHooks {
  const ctx = canvas.getContext('2d', { alpha: false }) as OffscreenCanvasRenderingContext2D;
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
      port.postMessage({ type: 'draw-stats', n: s.length, median: s[s.length >> 1] ?? 0, max: s[s.length - 1] ?? 0, lag, busy: { ...busy, draw: drawMs } } satisfies DisplayToPage);
      lag = 0;
      Object.assign(busy, { request: 0, transfer: 0, requests: 0, transfers: 0, pixels: 0 });
      drawMs = 0;
    }, 1000);
  }
  const FRAME_MS = 15; // under a 60 Hz frame: a flush a frame after the last is drawn at once, not a timer later
  let lastDraw = -Infinity;
  const frame = () => {
    scheduled = false;
    if (!src || !img || !dirty) return;
    const d = dirty;
    dirty = null;
    const t0 = performance.now();
    ctx.putImageData(img, -src.x, -src.y, src.x + d.x, src.y + d.y, d.w, d.h);
    lastDraw = performance.now();
    drawMs += lastDraw - t0;
    if (stats) lat.push(performance.now() - since);
  };
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
    cursor: (image, hotX, hotY) => sendCursor(image, hotX, hotY),
    cursorReset: () => sendCursor(undefined, 0, 0),
    scanout(width, height, source) {
      src = source;
      img = source ? new ImageData(new Uint8ClampedArray(source.pixels.buffer as ArrayBuffer, source.pixels.byteOffset, source.pixels.length), source.width, source.height) : undefined;
      if (canvas.width !== width || canvas.height !== height) {
        // A canvas resized is cleared; the mode goes to the page so it refits its box.
        if (width && height) [canvas.width, canvas.height] = [width, height];
        port?.postMessage({ type: 'mode', width, height } satisfies DisplayToPage);
      }
      dirty = src ? { x: 0, y: 0, w: width, h: height } : null;
      if (!src) ctx.fillRect(0, 0, canvas.width, canvas.height);
      else schedule();
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
