// Clipboard sharing as the toolbar's clipboard menu shows it (docs/plans/clipboard.md §5): the running machine's
// sharing (web/app/clipboard.ts `ClipboardShare`, followed through its `onChange`), the browser's read permission, and
// which of the menu's actions last failed. web/app/run/runner.ts gives it each run's sharing.
import { Changes } from '../changes.ts';
import type { ClipboardShare, ReadPermission, ShareState } from '../clipboard.ts';

class Clipboard {
  /** The running machine's sharing (none: the machine doesn't have the setting, or doesn't run). */
  share = $state.raw<ClipboardShare>();
  /** The browser's read permission, followed. */
  permission = $state<ReadPermission>('none');
  /** Which of the menu's actions last failed: Send got no text or image, Type no text, Copy the screen no picture or no write. */
  failed = $state<'send' | 'type' | 'screen'>();
  readonly #changes = new Changes();

  /** The run's sharing (none: no sharing in this run): it gets the permission, and the menu follows it. */
  follow(share: ClipboardShare | undefined) {
    this.share = share;
    this.failed = undefined;
    if (!share) return;
    share.setPermission(this.permission);
    share.onChange = () => this.#changes.notify();
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
  /** What became of the last Type (the agent's TYPED status: web/agent-frame.ts `TYPED`). */
  get typed() {
    this.#changes.track();
    return this.share?.typed;
  }
}
export const clipboard = new Clipboard();
