// The Home page's moves between levels (docs/frontend.md "The Home page"): its column's entries and its pane, each
// keyed by the level, leave and come in side by side (their parents stack them in one grid cell). Going down into a
// context, what leaves goes to the left and what comes in arrives from the right; going up, the reverse. 150 ms,
// slowing as it lands; with `prefers-reduced-motion`, a plain fade (as ui/crossfade.ts's bars do). The direction is read
// from the state when the transition starts (not a parameter: a parameter from a prop isn't computed for an outro, see
// crossfade.ts), and moves between the panes of one level don't key anew, so they stay instant.
import { cubicOut } from 'svelte/easing';
import { prefersReducedMotion } from 'svelte/motion';
import { fade, type TransitionConfig } from 'svelte/transition';
import { machinesNav } from './areas/machines-nav.svelte.ts';

const DURATION = 150;
/** How far a block moves, as a share of its own width. */
const SHIFT = 24;

/** One block's move in (`in`) or out (`out`) of its level. */
export function level(node: Element, _params: unknown, o: { direction: 'in' | 'out' | 'both' }): TransitionConfig {
  // What leaves is gone already for the keyboard (its focused Back pressed again, Tab into it).
  if (o.direction === 'out' && node instanceof HTMLElement) node.inert = true;
  if (prefersReducedMotion.current) return fade(node, { duration: DURATION });
  const incoming = o.direction !== 'out';
  // Down: in from the right (+), out to the left (-); up: the reverse.
  const side = (machinesNav.direction === 'down') === incoming ? 1 : -1;
  return {
    duration: DURATION,
    easing: cubicOut,
    css: (t, u) => `transform: translateX(${side * u * SHIFT}%); opacity: ${t}`,
  };
}
