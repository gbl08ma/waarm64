// The machine's power state and the message bar as the run writes them (docs/frontend.md "The page's code"): the
// state and its words, the message and what can be done about it, the notices that clear themselves.
import { msg, said, t, text, type Described, type Msg, type Said } from '../../i18n.ts';
import { bootCard } from '../areas/boot-card.svelte.ts';
import { messageBar, type Action, type MessageKind } from '../areas/message-bar.svelte.ts';
import { isStopped, power, type PageState } from '../areas/power.svelte.ts';
import { errorLines } from '../usb-problems.ts';
import type { PageMachine } from './page-machine.svelte.ts';

/** The state's words (the status bar's state), by state. */
const STATE_WORDS: Record<PageState, string> = {
  idle: 'machine:messages.state.idle',
  loading: 'machine:messages.state.loading',
  booting: 'machine:messages.state.booting',
  running: 'machine:messages.state.running',
  off: 'machine:messages.state.off',
  suspended: 'machine:messages.state.suspended',
  rebooting: 'machine:messages.state.rebooting',
  crashed: 'machine:messages.state.crashed',
  failed: 'machine:messages.state.failed',
};
/** Something done, said while the machine stays as it is (a snapshot saved): the message bar closes it after 15 s. */
export const NOTICE_MS = 15_000;

/** A job's phase (words already rendered, or a message) and how far it is, for the state's words. */
export const progressText = (phase: string | Msg, f: number) =>
  msg('machine:messages.progress', { phase, percent: Math.floor(100 * f) });
export { withNote } from '../../i18n.ts';
/** Words a USB device's error adds under a headline (web/app/usb-problems.ts `errorLines`: its own, then its problems'). */
export const usbDetails = (headline: Msg, err: unknown): Described => ({
  headline: text(headline),
  details: errorLines(err).split('\n'),
  from: [headline],
});
/** Whether error `e` (or a cause of it) is a disk's overlay another tab has open (web/overlay.ts `problem`, the browser's lock). */
export function inUse(e: unknown) {
  for (let c = e, i = 0; c instanceof Error && i < 8; c = c.cause, i++) {
    if ((c as { problem?: string }).problem === 'overlay-in-use' || c.name === 'NoModificationAllowedError')
      return true;
  }
  return false;
}

/** The standing note: other browsers may work in part (their pass is in docs/backlog.md); Firefox's private windows refuse OPFS (`hasOpfs`: the store and the overlays are in memory). */
export function standingNote(opfs: boolean): Said {
  if (!opfs) return msg('machine:messages.noStorage');
  const brands = navigator.userAgentData?.brands ?? [];
  return brands.some((b) => b.brand === 'Chromium') ? '' : msg('machine:messages.notChromium');
}

export class Messages {
  /** A standing note (another browser), shown while there's no message. */
  note: Said = '';
  /** The last notice's id (`Countdown.id`). */
  #notices = 0;
  /** Whether the bar shows a notice (`notify`'s) rather than the state's message or the standing note. */
  #notice = false;
  /** What the last state said with it (a stopped machine's error and its actions): a notice's end shows it again. */
  #standing: { message: Said; actions: Action[]; kind: MessageKind } = { message: '', actions: [], kind: 'warn' };
  readonly #machine: PageMachine;
  readonly #stopped: () => void;

  /** `stopped`: what goes with a machine stopped with no start to follow (the network's clients, the guest's cursor). */
  constructor(machine: PageMachine, stopped: () => void) {
    this.#machine = machine;
    this.#stopped = stopped;
  }

  /** Shows `message` in the message bar: its headline, and its details under it (an error's causes). */
  show(message: Said | undefined, actions: Action[], kind: MessageKind) {
    this.#notice = false;
    messageBar.countdown = undefined;
    const d = said(message);
    messageBar.text = d.headline;
    messageBar.details = d.details;
    messageBar.from = d.from ?? [];
    messageBar.kind = kind;
    messageBar.actions = actions;
  }

  /** The machine's state, and the message that goes with it (none: the standing note). */
  setState(s: PageState, message?: Said, actions: Action[] = [], kind: MessageKind = 'error') {
    power.state = s;
    power.stateText = t(STATE_WORDS[s]);
    // A stopped machine's message stays what the bar comes back to; a running one's is a note for now.
    this.#standing = message && isStopped(s) ? { message, actions, kind } : { message: '', actions: [], kind: 'warn' };
    this.show(message ?? this.note, actions, message ? kind : 'warn');
    bootCard.shown = (s === 'loading' || s === 'booting') && !bootCard.done;
    bootCard.serial = !!this.#machine.spec.firmware && s === 'booting';
    if (isStopped(s)) this.#stopped(); // a restart doesn't pass here: its clients stay, on the new machine's ports
  }

  /**
   * A notice, the machine staying as it is (with `actions`, its buttons: names in their last week, Domains): by default an error's is a warning and anything else's is `info`. An `info`
   * notice closes itself after `NOTICE_MS`; a warning or an error stays until closed. Either way its end shows what the
   * state said again (a stopped machine's error and its actions), else the standing note.
   */
  notify(message: Said, kind: MessageKind = message instanceof Error ? 'warn' : 'info', actions: Action[] = []) {
    this.show(message, actions, kind);
    this.#notice = true;
    if (kind !== 'info') return;
    const id = ++this.#notices;
    messageBar.countdown = {
      ms: NOTICE_MS,
      id,
      end: () => {
        if (this.#notice && messageBar.countdown?.id === id) this.#back();
      },
    };
  }

  /** The bar back to what the state said, else the standing note. */
  #back() {
    const s = this.#standing;
    if (s.message) this.show(s.message, s.actions, s.kind);
    else this.show(this.note, [], 'warn');
  }

  /** The state's words for a while (a phase, a progress), until the next state. */
  stateText(m: Msg) {
    power.stateText = text(m);
  }

  /** Closes the message bar: a notice, back to what the state said; else the state's message and the standing note too. */
  dismiss() {
    if (this.#notice && this.#standing.message) return this.#back();
    this.note = '';
    this.#standing = { message: '', actions: [], kind: 'warn' };
    this.show('', [], 'warn');
  }
}
