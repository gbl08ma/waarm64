// What the page shows of the machine (docs/frontend.md "Views"): its screen, its serial terminal, or both; and the
// screen's canvas (web/app/areas/screen-view.ts makes a new one for each start, at the guest's size, and says how
// it is scaled: `data-scale`, the tests' hook).
export type View = 'screen' | 'terminal' | 'both';

export const screen = $state<{
  view: View;
  generation: number;
  size: { width: number; height: number };
  scale: number | undefined;
}>({
  view: 'screen',
  /** Bumped for each start: App.svelte makes the canvas again. */
  generation: 0,
  /** The canvas's size (fixed once its drawing is handed over). */
  size: { width: 300, height: 150 },
  /** Device pixels per guest pixel, as the screen was last fitted. */
  scale: undefined,
});
