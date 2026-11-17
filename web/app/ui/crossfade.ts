// One shared crossfade, so bars that mount and unmount in different parents (the floating message bar and the Machines
// page's banner) move into each other. `sendKeyed`/`receiveKeyed` take the key from the node's `data-crossfade`, or none
// for no transition (a bar with nothing to show, e.g. the floating bar while hidden, would otherwise be measured at 0×0
// and pull the other into its corner). The key is an attribute, kept current by the template, rather than the
// transition's parameter: a parameter from a prop is a derived that nothing reads until the outro, and by then its
// effect is being destroyed and Svelte doesn't compute it (`derived_inert`: the first time, the floating bar left with
// no key, and nothing moved).
import { crossfade } from 'svelte/transition';
import type { TransitionConfig } from 'svelte/transition';

const DURATION = 250;
const [send, receive] = crossfade({ duration: DURATION });

const keyed =
  (fn: typeof send) =>
  (node: HTMLElement): TransitionConfig | (() => TransitionConfig) => {
    const key = node.dataset.crossfade;
    return key === undefined ? {} : fn(node, { key });
  };
export const sendKeyed = keyed(send);
export const receiveKeyed = keyed(receive);

/** A page's outro while a bar in it crossfades away (`crossfading`; otherwise none): an outro keeps the page in the DOM beside what replaces it, so
 *  it leaves the flow (fixed where it was, under the floating bar) and fades, rather than pushing the new page aside
 *  (and the bar with it) for the crossfade's time. Svelte measures it before the page's other effects run (the
 *  `body[data-page]` swap that shows the machine). */
export function leaveInPlace(node: HTMLElement, crossfading: boolean): TransitionConfig {
  if (!crossfading) return {};
  const r = node.getBoundingClientRect();
  Object.assign(node.style, {
    position: 'fixed',
    top: `${r.top}px`,
    left: `${r.left}px`,
    width: `${r.width}px`,
    height: `${r.height}px`,
    zIndex: '0',
  });
  return { duration: DURATION, css: (t) => `opacity: ${t}` };
}
