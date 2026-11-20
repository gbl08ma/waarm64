// What the page shows of the machine (docs/frontend.md "Views"): its screen, its serial terminal, or both; and the
// screen's canvas (web/app/areas/screen-view.ts makes a new one for each start, at the guest's size, and says how
// it is scaled: `data-scale`, the tests' hook).
export type View = 'screen' | 'terminal' | 'both';
/**
 * Both's divider, where the user put it: the terminal's share of the room beside the screen (`across`) or under it
 * (`stacked`, a narrow window), 0.15 to 0.85; none: the default layout (the terminal's own width, 80 columns).
 */
export type Split = { across?: number; stacked?: number };
export const SPLIT_MIN = 0.15;
export const SPLIT_MAX = 0.85;
export const splitShare = (v: unknown) => (typeof v === 'number' && v >= SPLIT_MIN && v <= SPLIT_MAX ? v : undefined);

export const screen = $state<{
  view: View;
  generation: number;
  size: { width: number; height: number };
  scale: number | undefined;
  fitted: { width: number; height: number; pixelated: boolean; shift: { x: number; y: number } } | undefined;
  split: Split;
}>({
  view: 'screen',
  /** Bumped for each start: App.svelte makes the canvas again. */
  generation: 0,
  /** The canvas's size (fixed once its drawing is handed over). */
  size: { width: 300, height: 150 },
  /** Device pixels per guest pixel, as the screen was last fitted. */
  scale: undefined,
  /**
   * The canvas's size on the page (CSS pixels), whether it is drawn crisp (a whole scale), and how far its frame is
   * moved from the center (CSS pixels, under one device pixel) so it starts on a device pixel; none until fitted.
   */
  fitted: undefined,
  /** Both's divider (`Split`): set only by the user's drag or keys, remembered per browser. */
  split: {},
});
