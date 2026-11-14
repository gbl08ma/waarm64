// The run's guest agent (docs/devices.md "The guest's agent"): its link over the vsock (web/app/agent-link.ts), and the
// guest's clock set to the browser's (docs/frontend.md "The guest's clock") whenever it may have fallen behind: at
// each agent's HELLO (a boot, the agent started again, a restore: the restored guest's agent connects again), after a
// save's pause (`syncClock`, web/app/areas/snapshot-actions.ts), and when the host's own sleep shows (the wall clock
// moving away from `performance.now()`, which the guest's counter follows and which may not count a host's sleep); and
// the screen's size, which the agent's session follows (DISPLAY: the guest's compositor or X server set to it); and the
// guest's graphical session as the agent says it (DESKTOP), as `body[data-desktop]` for the tests' waits (nothing the
// user sees: docs/devices.md "The desktop's state"); and the guest's OS as the agent names it (OS), for the status bar; whether it powers the guest off when asked (`canPower`).
import { CAP, DESKTOP, type GuestOs } from '../../agent-frame.ts';
import { AgentLink, pageCaps } from '../agent-link.ts';
import type { KeyboardLayout } from '../keyboard.ts';
import { clockSync } from '../settings.ts';
import type { ClipboardShare } from '../clipboard.ts';
import type { AgentChannels } from '../run/start-message.ts';

type Size = { width: number; height: number };
/** Where the page shows what the agent says (web/app/areas/agent-shown.ts: the status bar's OS, the toolbar's power). */
export type AgentShown = { os(os: GuestOs | undefined): void; canPower(can: boolean): void };
const NOT_SHOWN: AgentShown = { os: () => undefined, canPower: () => undefined };

/** What a run asks of its agent (web/app/run/runner.ts): its link begun and ended; a restore's renewals (`template`: its identity too). */
export type RunAgent = {
  begin(ch: AgentChannels, up: () => void): ClipboardShare | undefined;
  end(): void;
  restored(template: boolean): void;
  /** A disk's write found the browser's storage full (web/app/areas/trim-actions.ts `full`). */
  storageFull(): void;
};

/** `body[data-desktop]`'s words for DESKTOP's states (absent: no agent). */
const DESKTOP_WORDS: Record<number, string> = {
  [DESKTOP.NONE]: 'none',
  [DESKTOP.WAYLAND]: 'wayland',
  [DESKTOP.X11]: 'x11',
};

/** How often the page compares the wall clock with `performance.now()`. */
export const SLEEP_CHECK_MS = 10_000;
/** How far they may move apart between two checks before the guest's clock is set again. */
export const SLEEP_GAP_MS = 2_000;

export class AgentActions {
  #link: AgentLink | undefined;
  #timer: ReturnType<typeof setInterval> | undefined;
  /** The screen's size the guest was last asked for (web/app/areas/screen-view.ts `sent`; none: no virtio-gpu). */
  readonly #size: () => Size | undefined;
  /** The keyboard layout the run gives its guest (web/app/areas/keys.svelte.ts `layout`; none: its own). */
  readonly #layout: () => KeyboardLayout | undefined;

  readonly #shown: AgentShown;

  constructor(size: () => Size | undefined, layout: () => KeyboardLayout | undefined, shown = NOT_SHOWN) {
    this.#size = size;
    this.#layout = layout;
    this.#shown = shown;
  }

  /**
   * A run's agent over its channel (none: the machine has no agent); `clipboard`, and the screen's size if there is
   * one (`display`): what the page's HELLO says (web/app/agent-link.ts `pageCaps`); `up` at each agent's HELLO (a sign that the guest is up). Under `?agentstub`
   * (web/app/run/dev-knobs.ts) the channel's device end is the tests' to play.
   */
  begin(ch: AgentChannels, up: () => void): AgentLink | undefined {
    this.end();
    const port = ch.agent?.port1;
    const size = this.#size();
    const link = (this.#link = port && new AgentLink(port, pageCaps(ch.clipboard, !!size)));
    window.__agent = link; // the tests' hooks
    window.__agentStub = ch.agentStub ? ch.agent?.port2 : undefined;
    if (!link) return undefined;
    const desktop = (d: number) => {
      document.body.dataset.desktop = DESKTOP_WORDS[d] ?? 'none';
    };
    desktop(link.desktop);
    link.onDesktop = desktop;
    link.onOs = (os) => this.#shown.os(os);
    if (size) link.display(size);
    link.onHello.push(
      up,
      () => this.syncClock(),
      () => this.keymap(this.#layout()),
      (h) => this.#shown.canPower((h.caps & CAP.POWER) !== 0),
    );
    let offset = Date.now() - performance.now();
    this.#timer = setInterval(() => {
      const now = Date.now() - performance.now();
      if (Math.abs(now - offset) > SLEEP_GAP_MS) this.syncClock();
      offset = now;
    }, SLEEP_CHECK_MS);
    return link;
  }

  /** The run ended (web/app/run/runner.ts `ended`): its link closed, the sleep check stopped. */
  end() {
    this.#link?.close();
    this.#link = undefined;
    clearInterval(this.#timer);
    this.#timer = undefined;
    window.__agent = undefined;
    delete document.body.dataset.desktop;
    this.#shown.os(undefined);
    this.#shown.canPower(false);
  }

  /** The screen's size the guest is asked for now (a new window size, settled): the agent's session takes it too. */
  display(size: Size) {
    this.#link?.display(size);
  }

  /**
   * The keyboard layout for the guest's running session (KEYMAP: the agent applies it where the session hasn't it), at
   * each agent's HELLO and when the setting is saved while the machine runs; false: not sent (no layout, no agent).
   */
  keymap(l: KeyboardLayout | undefined): boolean {
    return !!l && !!this.#link?.keymap(l);
  }

  /** The run's link, if it has one. */
  get link(): AgentLink | undefined {
    return this.#link;
  }

  /** The guest was restored from a template: its agent renews its identity (web/app/agent-link.ts `renew`). */
  renew() {
    this.#link?.renew();
  }

  /** Sets the guest's clock to the browser's, under Preferences' switch; false: not sent (off, or no agent yet). */
  syncClock(): boolean {
    return clockSync() && !!this.#link?.time();
  }
}
