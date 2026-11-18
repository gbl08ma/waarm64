// The message bars' transitions (docs/frontend.md "Dialogs and the message bar"), all 250 ms. One shared crossfade, so
// bars that mount and unmount in different parents (the floating message bar and the Home page's banner) move into
// each other: `sendKeyed`/`receiveKeyed` take the key from the node's `data-crossfade`. A bar with no counterpart (it
// appears or goes, rather than moving), or with no key (the Home page's own error), comes and goes its own way
// (`arrive`): a floating one slides down from above the page, over the toolbar, and back up when it goes (a message
// from waarm64, not from the guest under it); one in the page's column unfolds and folds (`slide`). With
// `prefers-reduced-motion`, a plain fade, a move between two places too. The key is an attribute, kept current by the template, rather than the
// transition's parameter: a parameter from a prop is a derived that nothing reads until the outro, and by then its
// effect is being destroyed and Svelte doesn't compute it (`derived_inert`: the first time, the floating bar left
// with no key, and nothing moved).
import { cubicIn, cubicOut } from 'svelte/easing';
import { prefersReducedMotion } from 'svelte/motion';
import { crossfade, fade, slide } from 'svelte/transition';
import type { TransitionConfig } from 'svelte/transition';

const DURATION = 250;

/**
 * A floating bar's way in (`intro`) and out: from above the viewport's top edge (its shadow too) to where it is,
 * slowing as it lands; back up, gathering speed (an outro's `t` is 1 minus its easing of the time).
 */
function fromAbove(node: Element, intro: boolean): TransitionConfig {
  const style = getComputedStyle(node);
  const base = style.transform === 'none' ? '' : style.transform;
  const rise = node.getBoundingClientRect().bottom + 16;
  return {
    duration: DURATION,
    easing: intro ? cubicOut : cubicIn,
    css: (_t, u) => `transform: ${base} translateY(${-u * rise}px)`,
  };
}

/** A bar's own way in (`intro`) and out, where it doesn't move from or to another. */
function arrive(node: Element, intro: boolean): TransitionConfig {
  if (prefersReducedMotion.current) return fade(node, { duration: DURATION });
  if (node.classList.contains('floating')) return fromAbove(node, intro);
  return slide(node, { duration: DURATION, easing: cubicOut });
}

const [send, receive] = crossfade({ duration: DURATION, fallback: (node, _params, intro) => arrive(node, intro) });

/**
 * The ids in `node` (its own too): a bar that leaves gives them up, so the one that comes in its place is the only one
 * with them (`#message-text`, the tests' handle); one that comes back (its outro reversed) takes them again.
 */
function ids(node: HTMLElement, leaving: boolean) {
  for (const el of [node, ...node.querySelectorAll<HTMLElement>(leaving ? '[id]' : '[data-left-id]')]) {
    if (leaving && el.id) {
      el.dataset.leftId = el.id;
      el.removeAttribute('id');
    } else if (!leaving && el.dataset.leftId !== undefined) {
      el.id = el.dataset.leftId;
      delete el.dataset.leftId;
    }
  }
}

const keyed =
  (fn: typeof send, intro: boolean) =>
  (node: HTMLElement): TransitionConfig | (() => TransitionConfig) => {
    ids(node, !intro);
    // With reduced motion, a bar moving to another place fades out of one and into the other.
    if (prefersReducedMotion.current) return fade(node, { duration: DURATION });
    const key = node.dataset.crossfade;
    return key === undefined ? arrive(node, intro) : fn(node, { key });
  };
export const sendKeyed = keyed(send, false);
export const receiveKeyed = keyed(receive, true);

/** A page's outro while a bar in it transitions away (`banner`; otherwise none): an outro keeps the page in the DOM beside what replaces it, so
 *  it leaves the flow (fixed where it was, under the floating bar) and fades, rather than pushing the new page aside
 *  (and the bar with it) for the transition's time. Svelte measures it before the page's other effects run (the
 *  `body[data-page]` swap that shows the machine). */
export function leaveInPlace(node: HTMLElement, banner: boolean): TransitionConfig {
  if (!banner) return {};
  const r = node.getBoundingClientRect();
  const was = node.getAttribute('style');
  /** The page's own style again: it comes back while it leaves (its `{#if}` true again: Svelte resumes it). */
  const back = () => (was === null ? node.removeAttribute('style') : node.setAttribute('style', was));
  Object.assign(node.style, {
    position: 'fixed',
    top: `${r.top}px`,
    left: `${r.left}px`,
    width: `${r.width}px`,
    height: `${r.height}px`,
    zIndex: '0',
  });
  return {
    duration: DURATION,
    css: (t) => `opacity: ${t}`,
    // Svelte calls `tick(1, 0)` as it reverses the outro (its animation cancelled), and on each frame while it runs.
    tick: (t) => {
      if (t === 1 && !node.getAnimations().some((a) => a.playState === 'running')) back();
    },
  };
}
