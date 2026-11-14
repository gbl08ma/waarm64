// The guest's cursor kept in the page's view (docs/frontend.md "The screen", the guest's cursor): Chromium shows a CSS
// image cursor only while its box, the pointer's place less the hotspot and the image's size, lies inside the visual
// viewport, and falls to the list's next entry where it doesn't (blink's EventHandler::SelectCursor, from Chromium 156
// for every image; before 156 only for one over 32×32 CSS pixels). So near an edge the page offers the cursor cut there
// as well: the cuts for where the pointer is and is going, least cut first, for Chromium to take the first that fits.
// Device pixels throughout, as Chromium checks it (layout in device pixels: a device scale factor, not the browser's
// zoom); DOM-free, the tests run it in Node.

/** The cursor as drawn: its used size (its transparent right and bottom margins trimmed) and hotspot, device pixels. */
export type CursorBox = { width: number; height: number; hotX: number; hotY: number };
/** Device pixels cut from each side of the drawn cursor. */
export type Cut = { left: number; top: number; right: number; bottom: number };
/** One image in the cursor list: `cut` of the drawn cursor drawn at `pad` (transparent pixels at its left and top), its size in device pixels, and the hotspot CSS gives it (whole CSS pixels). */
export type CutImage = {
  cut: Cut;
  padX: number;
  padY: number;
  width: number;
  height: number;
  cssHotX: number;
  cssHotY: number;
};
/** The visual viewport, CSS pixels. */
export type View = { x: number; y: number; width: number; height: number };

/** Device pixels a cut moves by: fewer images as the pointer moves along an edge, the cursor cut up to this much early. */
export const CUT_STEP = 2;
// Where the pointer may be by the next move, device pixels from where it is: Chromium picks the cursor for a move before
// the page hears of it, so the list made at one move is the one the next move's pick reads.
const AHEAD = [-16, -4, 0, 4, 8, 16, 32];

/**
 * The drawn cursor's box: a 64×64 RGBA image drawn at `size` device pixels, its hotspot at (hotX, hotY) cursor pixels
 * (rounded, kept inside), its width and height as far as its drawing goes (one pixel more for smoothing's bleed when
 * the scale isn't whole), the hotspot inside.
 */
export function cursorBox(rgba: Uint8ClampedArray, hotX: number, hotY: number, size: number): CursorBox {
  let [maxX, maxY] = [-1, -1];
  for (let y = 0; y < 64; y++)
    for (let x = 0; x < 64; x++) if (rgba[(y * 64 + x) * 4 + 3]) [maxX, maxY] = [Math.max(maxX, x), Math.max(maxY, y)];
  const k = size / 64;
  const bleed = Number.isInteger(k) ? 0 : 1;
  const hot = (n: number) => Math.max(0, Math.min(size - 1, Math.round(n * k)));
  const [hx, hy] = [hot(hotX), hot(hotY)];
  const used = (max: number, h: number) => Math.min(size, Math.max(h + 1, Math.ceil((max + 1) * k) + bleed));
  return { width: used(maxX, hx), height: used(maxY, hy), hotX: hx, hotY: hy };
}

// One axis of a cut: the hotspot after the low side's cut, put on a whole CSS pixel (Chromium takes CSS's hotspot in whole
// CSS pixels and scales it by the image's density) by transparent pixels before the image, so it is exact.
function axis(size: number, hot: number, low: number, high: number, dpr: number) {
  const h = hot - low;
  const css = Math.ceil(h / dpr - 1e-9);
  const pad = Math.round(css * dpr) - h;
  return { pad, length: pad + size - low - high, css, hot: h + pad };
}

/** The image for `cut` of `box` at density `dpr`. */
export function cutImage(box: CursorBox, cut: Cut, dpr: number): CutImage {
  const x = axis(box.width, box.hotX, cut.left, cut.right, dpr);
  const y = axis(box.height, box.hotY, cut.top, cut.bottom, dpr);
  return { cut, padX: x.pad, padY: y.pad, width: x.length, height: y.length, cssHotX: x.css, cssHotY: y.css };
}

// One axis's least cut that fits with the pointer at device pixel `at` of a view from `start` to `end`, in steps of
// CUT_STEP: the low side first (the hotspot past the view's start), then the high side, one pixel to spare there
// (a fractional pointer). The hotspot's own pixel is never cut.
function axisCut(size: number, hot: number, at: number, start: number, end: number, dpr: number) {
  const step = (n: number, max: number) => Math.min(max, Math.ceil(n / CUT_STEP) * CUT_STEP);
  let low = step(Math.max(0, hot - (at - start)), hot);
  while (low < hot && axis(size, hot, low, 0, dpr).hot > at - start) low = step(low + 1, hot);
  const a = axis(size, hot, low, 0, dpr);
  const high = step(Math.max(0, at + 1 - a.hot + a.length - end), size - hot - 1);
  return { low, high };
}

/**
 * The cuts to offer with the pointer at `at` (CSS pixels; none known: the cursor whole), least cut first: the whole
 * cursor, then its cuts for where the pointer is and may be by the next move.
 */
export function cursorCuts(box: CursorBox, at: { x: number; y: number } | undefined, view: View, dpr: number): Cut[] {
  const whole: Cut = { left: 0, top: 0, right: 0, bottom: 0 };
  if (!at) return [whole];
  const near = (p: number, s: number, h: number, start: number, end: number) => {
    const all = AHEAD.map((d) =>
      axisCut(s, h, Math.min(end - 1, Math.max(start, p + d * Math.max(1, dpr))), start, end, dpr),
    );
    return all.filter((c, i) => all.findIndex((o) => o.low === c.low && o.high === c.high) === i);
  };
  const dev = (n: number) => Math.floor(n * dpr + 1e-3);
  const [x0, y0] = [dev(view.x), dev(view.y)];
  const xs = near(dev(at.x), box.width, box.hotX, x0, dev(view.x + view.width));
  const ys = near(dev(at.y), box.height, box.hotY, y0, dev(view.y + view.height));
  const cuts = [whole];
  for (const x of xs)
    for (const y of ys) {
      const c = { left: x.low, top: y.low, right: x.high, bottom: y.high };
      if (!cuts.some((o) => cutKey(o) === cutKey(c))) cuts.push(c);
    }
  const total = (c: Cut) => c.left + c.top + c.right + c.bottom;
  return cuts.sort((a, b) => total(a) - total(b));
}

export const cutKey = (c: Cut) => `${c.left},${c.top},${c.right},${c.bottom}`;
