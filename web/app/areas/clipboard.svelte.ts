// Clipboard sharing as the toolbar's clipboard menu shows it (docs/plans/clipboard.md §5): the running machine's
// sharing (web/app/clipboard.ts `ClipboardShare`, followed through its `onChange`), the browser's read permission, and
// which of the menu's actions last failed. web/app/run/runner.ts gives it each run's sharing.
import { Changes } from '../changes.ts';
import type { ClipboardShare, ShareState } from '../clipboard.ts';
import type { ReadPermission } from '../clipboard-host.ts';

class Clipboard {
  /** The running machine's sharing (none: the machine doesn't have the setting, or doesn't run). */
  share = $state.raw<ClipboardShare>();
  /** The browser's read permission, followed. */
  permission = $state<ReadPermission>('none');
  /**
   * Which of the menu's actions last failed: Send got no text or image, Type no text, Copy the screen no picture or no
   * write, Copy the console's text no text (`console`) or a console that shows graphics (`graphics`).
   */
  failed = $state<'send' | 'type' | 'screen' | 'console' | 'graphics'>();
  /**
   * The run began paused and is still in that pause: a machine made from a demo, whose every run does
   * (web/app/demo-store.ts `startsPaused`); cleared once sharing resumes (a later pause is the user's own).
   */
  startedPaused = $state(false);
  readonly #changes = new Changes();

  /** The run's sharing (none: no sharing in this run), `paused` from its start: it gets the permission, and the menu follows it. */
  follow(share: ClipboardShare | undefined, paused = false) {
    this.share = share;
    this.failed = undefined;
    this.startedPaused = paused;
    if (!share) return;
    share.setPermission(this.permission);
    share.onChange = () => {
      if (share.state !== 'paused') this.startedPaused = false;
      this.#changes.notify();
    };
  }
  /** The page's machine has the setting: its button shows while it runs. */
  get on() {
    return !!this.share;
  }
  get state(): ShareState {
    this.#changes.track();
    return this.share?.state ?? 'waiting';
  }
  /** Focus reads stopped for the run: they came back hidden. */
  get stopped() {
    this.#changes.track();
    return !!this.share?.stopped;
  }
  /** The agent types. */
  get canType() {
    this.#changes.track();
    return !!this.share?.canType;
  }
  /** The agent reads the text console's screen. */
  get canCopy() {
    this.#changes.track();
    return !!this.share?.canCopy;
  }
  /** What became of the last Type (the agent's TYPED status: web/agent-frame.ts `TYPED`). */
  get typed() {
    this.#changes.track();
    return this.share?.typed;
  }
}
export const clipboard = new Clipboard();
