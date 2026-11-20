// A change of the page's whole layout shown as one movement (docs/frontend.md "The introduction": the introduction
// left, a demo's machine opened), with the View Transitions API where the browser has it. The elements that move are
// named in their components' styles under `html[data-vt='<kind>']`, which is set only while the transition runs: a
// name makes its element a stacking context, which would keep the toolbar's menus under the screen the rest of the
// time. Without the API, or for a visitor who asked for less motion, the change is immediate.
import { flushSync } from 'svelte';

/** What moves: the introduction giving way to the page (`intro`), a demo's pane becoming its machine (`launch`). */
export type TransitionKind = 'intro' | 'launch';

/** Whether the visitor asked for less motion. */
export const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * Runs `change` (the state's writes, synchronous) as a transition of `kind`; resolves once the page shows the change
 * (the movement may still be running).
 */
export function transition(kind: TransitionKind, change: () => void): Promise<void> {
  const root = document.documentElement;
  // `in`: Firefox before 144 and Safari before 18 have no such method.
  if (!('startViewTransition' in document) || reducedMotion()) {
    change();
    return Promise.resolve();
  }
  root.dataset.vt = kind;
  const vt = document.startViewTransition(() => {
    change();
    flushSync();
  });
  const done = () => {
    if (root.dataset.vt === kind) delete root.dataset.vt;
  };
  // Skipped (another transition started, the tab hidden): the change is made all the same.
  vt.finished.then(done, done);
  return vt.updateCallbackDone.catch(() => undefined);
}
