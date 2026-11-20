// A picture of the introduction stepping by itself (IntroPath.svelte, IntroTranslate.svelte): only while it's on
// screen, and never for a visitor who asked for less motion (then it starts paused, and the stepper or a click moves
// it). The picture's owner advances its own step.
import { reducedMotion } from '../view-transition.ts';

export class Autoplay {
  /** The steps run by themselves (the visitor's Pause, or their pick of a step, turns it off). */
  playing = $state(!reducedMotion());
  /** The picture is on screen. */
  inView = $state(false);

  /** An action for the picture's element: follows whether it's on screen. */
  readonly watch = (el: HTMLElement) => {
    const seen = new IntersectionObserver((entries) => (this.inView = entries.some((e) => e.isIntersecting)), {
      threshold: 0.25,
    });
    seen.observe(el);
    return { destroy: () => seen.disconnect() };
  };

  /** For an `$effect`: calls `next` every `ms` while the `steps` run by themselves; returns the effect's cleanup. */
  run(steps: number, ms: number, next: () => void) {
    if (!this.playing || !this.inView || steps < 2) return;
    const timer = setInterval(next, ms);
    return () => clearInterval(timer);
  }
}
