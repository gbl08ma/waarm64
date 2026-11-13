// The machine's screen (docs/frontend.md "The screen"): the canvas the run draws on, fitted to its box, the guest's
// cursor on it, and the size the guest is asked for (virtio-gpu machines). web/app/App.svelte renders the elements and
// gives them here (`attach`); the canvas's size on the page is `screen.fitted`, the cursor is set on the elements here.
import type { DisplayFromPage } from '../../gpu-present.ts';
import { flushSync } from 'svelte';
import { mouse } from './mouse.svelte.ts';
import { screen } from './screen.svelte.ts';
import { settings } from '../settings.ts';
import type { PageMachine } from '../run/page-machine.svelte.ts';

/** The guest's cursor (virtio-gpu's cursor queue): its image (null: hidden by the guest), hotspot and place. */
export type GuestCursor = { image: ArrayBuffer | null | undefined; hotX: number; hotY: number; x: number; y: number };
type Size = { width: number; height: number };

// The size the guest is asked for: the screen's box in CSS pixels (device pixels with HiDPI on) or a fixed size, width
// down to a multiple of 8 (the guest's CVT modes are, and a sliver would show), at least 640×480, at most what the EDID can say.
const SIZE_MIN = { width: 640, height: 480 };
const SIZE_MAX = 4088; // 4095 down to a multiple of 8
const SIZE_DEBOUNCE_MS = 300;

/** A cursor image drawn at `size` device pixels (kept to `keep`), and its hotspot. */
function render(draw: OffscreenCanvas, c: GuestCursor, size: number, keep = size) {
  const k = size / 64;
  const out = new OffscreenCanvas(keep, keep);
  const ctx = out.getContext('2d');
  if (!ctx) return Promise.reject(new Error('no 2D context'));
  ctx.imageSmoothingEnabled = !Number.isInteger(k);
  ctx.drawImage(draw, 0, 0, size, size);
  return out.convertToBlob().then((blob) => {
    const hot = (n: number) => Math.min(keep - 1, Math.round(n * k));
    return { url: URL.createObjectURL(blob), at: `${hot(c.hotX)} ${hot(c.hotY)}` };
  });
}
const imageOf = (c: GuestCursor & { image: ArrayBuffer }) =>
  new ImageData(new Uint8ClampedArray(c.image.slice(0)), 64, 64);

/** The screen's elements, as web/app/App.svelte gives them. */
export type ScreenElements = { canvas: HTMLCanvasElement; box: HTMLElement; lockCursor: HTMLCanvasElement };

/**
 * Calls `changed` at each change of the screen's density (a move to another screen, the browser's zoom): the query
 * names the density now, so it is made again for the next one (one query only hears its own density left or entered).
 */
export function watchDensity(changed: () => void) {
  const q = matchMedia(`(resolution: ${devicePixelRatio}dppx)`);
  q.addEventListener(
    'change',
    () => {
      watchDensity(changed);
      changed();
    },
    { once: true },
  );
}

export class ScreenView {
  #els: ScreenElements | undefined;
  readonly #machine: PageMachine;
  /** The screen's size: the machine's to begin with, then what a virtio-gpu scanout says (`mode` on the display port). */
  readonly fb: Size;
  /** Device pixels per guest pixel, as `fit` drew it. */
  #scale = 1;
  cursor: GuestCursor | undefined;
  #cursorUrls: string[] = [];
  #cursorToken = 0;
  /** The size last sent to the guest. */
  sent: Size | undefined;
  /** Called with each size sent (the guest's agent hears it too: web/app/areas/agent-actions.ts). */
  onSent?: (size: Size) => void;
  #sizeTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(machine: PageMachine) {
    this.#machine = machine;
    this.fb = { ...machine.spec.framebuffer };
  }

  /** The elements App.svelte rendered (again, for a fresh canvas: the box stays). */
  attach(els: ScreenElements) {
    const first = !this.#els;
    this.#els = els;
    if (!first) return;
    new ResizeObserver(() => {
      this.fit();
      this.scheduleSize();
      this.placeCursor();
    }).observe(els.box);
    watchDensity(() => {
      this.fit();
      this.scheduleSize();
    }); // moved to a screen with another density
  }
  #elements() {
    if (!this.#els) throw new Error('the screen is not rendered yet');
    return this.#els;
  }
  get canvas() {
    return this.#elements().canvas;
  }
  get #box() {
    return this.#elements().box;
  }
  get #lockCursor() {
    return this.#elements().lockCursor;
  }

  /** The canvas at an integer multiple of the guest's screen in device pixels when that fits (crisp), scaled down to fit (smooth) otherwise. */
  fit() {
    if (!this.#box.clientWidth) return; // hidden
    const { fb } = this;
    const dpr = devicePixelRatio;
    const box = this.#box.getBoundingClientRect();
    const fits = Math.min((box.width * dpr) / fb.width, (box.height * dpr) / fb.height);
    let scale = fits >= 1 ? Math.floor(fits) : fits;
    // A guest in CSS pixels on a screen of fractional density: one guest pixel is one CSS pixel (a little soft), not a device pixel (a smaller screen).
    if (!settings().hidpi && !Number.isInteger(dpr) && fits >= dpr && scale < dpr) scale = dpr;
    screen.fitted = {
      width: (fb.width * scale) / dpr,
      height: (fb.height * scale) / dpr,
      pixelated: Number.isInteger(scale),
    };
    flushSync(); // drawn at its size now: the cursor below is placed by the canvas's measured width
    screen.scale = Math.round(scale * 1000) / 1000; // `data-scale`, the tests' hook
    this.#scale = screen.scale || 1;
    this.showCursor();
  }

  /**
   * A fresh canvas for a start, at `size` (a canvas hands its drawing over only once: App.svelte makes it again), with
   * the focus if the old one had it; the guest's cursor goes with the old one.
   */
  freshCanvas(size: Size) {
    const focused = document.activeElement === this.canvas;
    [this.fb.width, this.fb.height] = [size.width, size.height];
    this.cursor = undefined;
    screen.size = { width: size.width, height: size.height };
    screen.generation++;
    flushSync(); // the new canvas is rendered and given back (`attach`) now
    const fresh = this.canvas;
    if (focused) fresh.focus();
    this.fit();
    return fresh;
  }

  /** The guest's screen changed size (a scanout's `mode`). */
  mode(size: Size) {
    [this.fb.width, this.fb.height] = [size.width, size.height];
    this.fit();
  }

  /** The guest's cursor, or none (the host's pointer is back over the screen). */
  setCursor(c: GuestCursor | undefined) {
    this.cursor = c;
    this.showCursor();
  }
  /** The guest's pointer moved. */
  cursorAt(x: number, y: number) {
    if (this.cursor) [this.cursor.x, this.cursor.y] = [x, y];
    this.placeCursor();
  }

  // The guest's cursor is the canvas's CSS cursor (set here, not through state: it follows the guest's cursor messages
  // as they come, and a cursor image is a list of blob URLs made here): the tablet is absolute, so the host's pointer is the guest's and
  // moves at the host's rate. Drawn at the canvas's scale (a guest pixel is `scale` device pixels), crisp when the
  // scale is whole; Chromium takes cursor images up to 128×128 device pixels, so a bigger one is capped. `none` is the
  // guest hiding it.
  showCursor() {
    const token = ++this.#cursorToken;
    const c = this.cursor;
    this.#drawLockCursor();
    if (c?.image === undefined || !c.image) {
      this.canvas.style.cursor = c?.image === null ? 'none' : '';
      return;
    }
    const draw = new OffscreenCanvas(64, 64);
    draw.getContext('2d')?.putImageData(imageOf({ ...c, image: c.image }), 0, 0);
    // Chromium drops a cursor over 32×32 CSS pixels for the next one in the list when its image would reach past the
    // page's edge (so a page can't draw over the browser's UI): the guest's cursor then vanished in the last 64
    // pixels, so the same cursor cut to its top-left 32 pixels follows it (a cursor's drawing is in the corner by its hotspot).
    const size = Math.min(128, Math.max(1, Math.round(64 * this.#scale)));
    const small = Math.floor(32 * devicePixelRatio);
    Promise.all([render(draw, c, size), size > small ? render(draw, c, size, small) : undefined]).then(
      ([big, little]) => {
        const urls = [big.url, little?.url];
        if (token !== this.#cursorToken) {
          for (const u of urls) if (u) URL.revokeObjectURL(u);
          return;
        }
        for (const u of this.#cursorUrls) URL.revokeObjectURL(u);
        this.#cursorUrls = urls.filter((u) => u !== undefined);
        const one = (r: { url: string; at: string }) => `-webkit-image-set(url(${r.url}) ${devicePixelRatio}x) ${r.at}`;
        this.canvas.style.cursor = [one(big), little && one(little), 'none'].filter(Boolean).join(', ');
      },
      () => undefined, // not drawn: the cursor stays as it was
    );
  }

  // While the screen holds the mouse (docs/frontend.md "Mouse lock") the browser hides the pointer, the CSS cursor
  // with it: the guest's cursor is drawn over the screen where the guest says it is (virtio-gpu's cursor position, the
  // image's top-left corner, in guest pixels), as the CSS cursor is (`showCursor`): at the canvas's scale up to 128
  // device pixels, the hotspot where the guest's pointer is, smoothed unless the scale is whole, clipped to the screen.
  #drawLockCursor() {
    const c = this.cursor;
    if (c?.image) this.#lockCursor.getContext('2d')?.putImageData(imageOf({ ...c, image: c.image }), 0, 0);
    this.placeCursor();
  }
  // Its box is set here, not through state: it follows the guest's pointer, once per cursor message while the mouse
  // is held, measured against the canvas as it is drawn now.
  placeCursor() {
    const c = this.cursor;
    const el = this.#lockCursor;
    el.hidden = !mouse.locked || !c?.image;
    if (el.hidden || !c) return;
    const k = this.canvas.clientWidth / this.fb.width; // CSS pixels per guest pixel
    const size = Math.min(128, Math.max(1, Math.round(64 * this.#scale))) / devicePixelRatio; // CSS pixels, as showCursor's
    const hot = size / 64; // CSS pixels per cursor pixel
    el.style.width = el.style.height = `${size}px`;
    el.style.imageRendering = Number.isInteger((size * devicePixelRatio) / 64) ? 'pixelated' : 'auto';
    // The guest's pointer (its hotspot) at the guest's place, the image around it at the cursor's own scale.
    el.style.transform = `translate(${((c.x | 0) + c.hotX) * k - c.hotX * hot}px, ${((c.y | 0) + c.hotY) * k - c.hotY * hot}px)`;
  }

  /** The size to ask the guest for now. */
  wantedSize(): Size {
    const fixed = /^(\d+)x(\d+)$/.exec(settings().screen ?? '');
    if (fixed) return { width: Number(fixed[1]), height: Number(fixed[2]) };
    if (!this.#box.clientWidth) return this.sent ?? this.#machine.spec.framebuffer; // hidden: no box to measure
    const k = settings().hidpi ? devicePixelRatio : 1;
    const box = this.#box.getBoundingClientRect();
    const clamp = (n: number, lo: number) => Math.min(SIZE_MAX, Math.max(lo, n));
    return {
      width: clamp(Math.floor((box.width * k) / 8) * 8, SIZE_MIN.width),
      height: clamp(Math.floor(box.height * k), SIZE_MIN.height),
    };
  }

  /** Tell the guest the screen's size once it has settled (a window drag sends a stream of sizes); `now` also when it is the one already sent (a restored machine has its own). */
  scheduleSize(now = false) {
    if (!this.#machine.hasGpu) return;
    clearTimeout(this.#sizeTimer);
    this.#sizeTimer = setTimeout(
      () => {
        const w = this.wantedSize();
        const run = this.#machine.run;
        if (!run || (!now && this.sent?.width === w.width && this.sent.height === w.height)) return;
        this.sent = w;
        run.display.postMessage({ type: 'size', ...w } satisfies DisplayFromPage);
        this.onSent?.(w);
      },
      now ? 0 : SIZE_DEBOUNCE_MS,
    );
  }
}
