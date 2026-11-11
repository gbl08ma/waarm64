// The components' actions (docs/frontend-code.md §5.6): one runner for what a click starts that can fail. While it runs,
// `busy` says what it does; when it fails, `error` is the error as the page shows it (usb-ports.ts `errorView`: its
// words a line each, or a USB attach's headline and its problems' words, which ErrorWords.svelte renders). A component
// makes its own (`new Actions()`), or takes the one of the page it is in (the Machines page's, passed down as `act`).
// A control with no place of its own for an error (the toolbar, its menus, the file pickers, a pane its action closes)
// runs `page`'s action through web/app/page.ts `inBar`: the action says how it went in the message bar, and so does
// its error.
import { errorView, type ErrorView } from './usb-ports.ts';

/** Runs `f`, saying `what` it does while it runs; resolves false if it failed (the error is the runner's to show). */
export type Act = (what: string, f: () => Promise<unknown>) => Promise<boolean>;

/** A picker's Cancel (the browser's `AbortError`): not an error to show. */
const cancelled = (e: unknown) => e instanceof Error && e.name === 'AbortError';

export class Actions {
  /** What runs now, in words (`''` for an action that names nothing); undefined when nothing runs. */
  busy = $state<string | undefined>();
  /** The last action's error, until the next one starts or the user dismisses it. */
  error = $state.raw<ErrorView | undefined>();
  readonly #after: (() => unknown) | undefined;
  readonly #show: ((e: unknown) => void) | undefined;

  /**
   * `after` runs once each action ends, failed or not (the Machines page reads its records again); `show`, where
   * given, shows an action's error instead of `error` (the message bar's runner).
   */
  constructor(o: { after?: () => unknown; show?: (e: unknown) => void } = {}) {
    this.#after = o.after;
    this.#show = o.show;
  }

  run: Act = async (what, f) => {
    this.error = undefined;
    this.busy = what;
    try {
      await f();
      return true;
    } catch (e) {
      if (cancelled(e)) return false;
      if (this.#show) this.#show(e);
      else this.error = errorView(e);
      return false;
    } finally {
      this.busy = undefined;
      await this.#after?.();
    }
  };

  /** Shows `e` as the last action's error (a check that fails before anything runs). */
  fail(e: unknown) {
    this.error = errorView(e);
  }

  clear() {
    this.error = undefined;
  }
}
