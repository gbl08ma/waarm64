// The simple-framebuffer on a canvas (docs/devices.md): the guest draws into its
// framebuffer in guest RAM (x8r8g8b8, packed rows); every animation frame
// compares it with the frame drawn last and puts the rows that changed on the
// canvas, converted to opaque RGBA. An unchanged frame costs a scan (~0.4 ms
// at 1024×768 in Chromium on the dev VM) and no drawing. The canvas is a page's
// or, transferred (`transferControlToOffscreen`), a worker's: the page
// (web/app/) draws in its machine worker, so its main thread has no per-frame
// work (docs/frontend.md "The screen").

export type Framebuffer = { addr: number; width: number; height: number };

/**
 * The rows `[first, end)` from the first to the last of `h` rows that `changed`
 * says differ (empty: none). The guest writes the framebuffer from other threads
 * meanwhile, so a row found changed may read unchanged a moment later: the scan
 * from the bottom stops at `first` whatever it reads (without that bound it once
 * ran past row 0 for good, and the machine worker froze with it).
 */
export function changedRows(h: number, changed: (y: number) => boolean): [number, number] {
  let first = 0;
  while (first < h && !changed(first)) first++;
  if (first === h) return [0, 0];
  let end = h;
  while (end > first + 1 && !changed(end - 1)) end--;
  return [first, end];
}

/**
 * Draws `fb` (in `memory`) to `canvas` on each animation frame until `stop`
 * (skipping frames while an element canvas isn't rendered). `draw` draws what
 * changed now and returns those rows, `[first, end)` (empty: none);
 * `presents()` is how many frames drew something so far (the status bar's
 * frame rate: at most one a display frame, however often the guest writes).
 * `onContent` is called once, at the first draw that shows a pixel that isn't
 * black (the guest's console took the screen: web/app/ hides its boot card).
 */
export function showFramebuffer(
  canvas: HTMLCanvasElement | OffscreenCanvas,
  memory: WebAssembly.Memory,
  fb: Framebuffer,
  onContent?: () => void,
) {
  const { width: w, height: h } = fb;
  [canvas.width, canvas.height] = [w, h];
  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
  const img = new ImageData(w, h);
  const dst = new Uint32Array(img.data.buffer);
  const last = new Uint32Array(w * h); // the guest's pixels as drawn last
  let fresh = true; // nothing drawn yet: every row counts as changed
  const rowChanged = (src: Uint32Array, y: number) => {
    for (let k = y * w, end = k + w; k < end; k++) if (src[k] !== last[k]) return true;
    return false;
  };
  const draw = (): [number, number] => {
    const src = new Uint32Array(memory.buffer, fb.addr, w * h); // anew: the buffer changes when memory grows
    const [first, end] = fresh ? [0, h] : changedRows(h, (y) => rowChanged(src, y));
    if (first === end) return [0, 0];
    fresh = false;
    let any = 0;
    for (let k = first * w, stop = end * w; k < stop; k++) {
      const p = src[k]; // 0xXXRRGGBB → ImageData's bytes R, G, B, A (0xAABBGGRR little-endian)
      last[k] = p;
      any |= p & 0xffffff;
      dst[k] = 0xff000000 | ((p & 0xff) << 16) | (p & 0xff00) | ((p >>> 16) & 0xff);
    }
    ctx.putImageData(img, 0, 0, 0, first, w, end - first);
    if (any && onContent) {
      onContent();
      onContent = undefined;
    }
    return [first, end];
  };
  const shown = () => !('checkVisibility' in canvas) || canvas.checkVisibility(); // a hidden view: display: none
  let presents = 0;
  let id = requestAnimationFrame(function frame() {
    if (shown()) {
      const [first, end] = draw();
      if (first !== end) presents++;
    }
    id = requestAnimationFrame(frame);
  });
  return { draw, presents: () => presents, stop: () => cancelAnimationFrame(id) };
}
