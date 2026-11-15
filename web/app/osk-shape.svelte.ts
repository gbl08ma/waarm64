// The on-screen keyboard's shape in its window (Osk.svelte, a `tool` ui/FloatingWindow.svelte): its layout (the one
// the browser window's width gets, or the one the bar's button forced, kept until the window's width crosses to where
// the automatic one is the same; remembered as `oskLayout`), and its height for a width (its keys' rows at the width's
// key unit, its bar, the window's padding and border), which its frame follows; a width is remembered per layout.
import { autoLayout, COMPACT_HEIGHT, COMPACT_WIDTH, HEIGHT, layoutOf, WIDTH, type Layout } from './osk-layout.ts';
import { remember, settings, type Place } from './settings.ts';
import { BORDER, TOOL_PAD as PAD } from './ui/floating-frame.svelte.ts';

/** Its place's key in settings.ts `windows`. */
export const PLACE = 'osk';
/**
 * Per layout: the keys' columns and rows (key units), the bar's height, the narrowest it gets, its first width, and the
 * width under which its title gives way (to the compact layout's tabs in a bar 420 px wide, else to the buttons at 160).
 */
const DIMS = {
  full: { cols: WIDTH, rows: HEIGHT, bar: 22, min: 320, first: 960, titleMin: 160 + 2 * (PAD + BORDER) },
  compact: {
    cols: COMPACT_WIDTH,
    rows: COMPACT_HEIGHT,
    bar: 28,
    min: 240,
    first: 480,
    titleMin: 420 + 2 * (PAD + BORDER),
  },
};
export const unitIn = (l: Layout, w: number) => (w - 2 * PAD - 2 * BORDER) / DIMS[l].cols;
const heightIn = (l: Layout, w: number) => unitIn(l, w) * DIMS[l].rows + DIMS[l].bar + PAD + 2 * BORDER;

export class OskShape {
  forced = $state<Layout>();
  winWidth = $state(innerWidth);
  readonly layout = $derived(layoutOf(this.winWidth, this.forced));
  readonly dims = $derived(DIMS[this.layout]);
  /** Its height for a width, in the layout it has. */
  readonly height = $derived((w: number) => heightIn(this.layout, w));
  /** Its smallest and first sizes (the height follows the width). */
  readonly min = $derived({ w: this.dims.min, h: 0 });
  readonly size = $derived({ w: Math.min(this.dims.first, innerWidth - 16), h: 0 });

  /** The layout forced when it was left (an older page's place moved into `windows` first: `migrate`). */
  constructor() {
    migrate();
    this.forced = settings().oskLayout;
  }
  /** Where it opens the first time: centred, 40 px over the window's bottom. */
  at = (s: { w: number; h: number }) => ({ x: (innerWidth - s.w) / 2, y: innerHeight - s.h - 40 });

  /** The window's size changed: a forced layout the width now gets anyway is no longer forced. */
  fit = () => {
    this.winWidth = innerWidth;
    if (this.forced && this.forced === autoLayout(innerWidth)) this.#force(undefined);
  };
  /** The bar's button: the other layout, forced while the window's width keeps the automatic one the same. */
  switchLayout() {
    const next: Layout = this.layout === 'compact' ? 'full' : 'compact';
    this.#force(next === autoLayout(innerWidth) ? undefined : next);
  }
  #force(l: Layout | undefined) {
    this.forced = l;
    remember({ oskLayout: l });
  }
}

/**
 * The keyboard's place as a page before its window was a FloatingWindow left it (`settings().osk`: where, the full
 * layout's width `w`, the compact one's `wc`, the forced layout), moved to `windows.osk` and `oskLayout` once, so it
 * comes back where it was.
 */
function migrate() {
  const old = settings().osk;
  if (!old) return;
  const size = (l: Layout, w: number) => ({ w, h: Math.round(heightIn(l, w)) });
  const sizes = { full: size('full', old.w), ...(old.wc === undefined ? {} : { compact: size('compact', old.wc) }) };
  const last = sizes[layoutOf(innerWidth, old.layout)] ?? sizes.full;
  const place: Place = { x: old.x, y: old.y, ...last, sizes };
  remember({ osk: undefined, oskLayout: old.layout, windows: { ...settings().windows, [PLACE]: place } });
}
