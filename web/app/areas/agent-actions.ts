// The run's guest agent (docs/devices.md "The guest's agent"): its link over the vsock (web/app/agent-link.ts), and the
// guest's clock set to the browser's (docs/frontend.md "The guest's clock") whenever it may have fallen behind: at
// each agent's HELLO (a boot, the agent started again, a restore: the restored guest's agent connects again), after a
// save's pause (`syncClock`, web/app/areas/snapshot-actions.ts), and when the host's own sleep shows (the wall clock
// moving away from `performance.now()`, which the guest's counter follows and which may not count a host's sleep).
import { AgentLink, pageCaps } from '../agent-link.ts';
import { clockSync } from '../settings.ts';
import type { AgentChannels } from '../run/start-message.ts';

/** How often the page compares the wall clock with `performance.now()`. */
export const SLEEP_CHECK_MS = 10_000;
/** How far they may move apart between two checks before the guest's clock is set again. */
export const SLEEP_GAP_MS = 2_000;

export class AgentActions {
  #link: AgentLink | undefined;
  #timer: ReturnType<typeof setInterval> | undefined;

  /**
   * A run's agent over its channel (none: the machine has no agent); `clipboard`: what the page's HELLO says
   * (web/app/agent-link.ts `pageCaps`); `up` at each agent's HELLO (a sign that the guest is up). Under `?agentstub`
   * (web/app/run/dev-knobs.ts) the channel's device end is the tests' to play.
   */
  begin(ch: AgentChannels, up: () => void): AgentLink | undefined {
    this.end();
    const port = ch.agent?.port1;
    const link = (this.#link = port && new AgentLink(port, pageCaps(ch.clipboard)));
    window.__agent = link; // the tests' hooks
    window.__agentStub = ch.agentStub ? ch.agent?.port2 : undefined;
    if (!link) return undefined;
    link.onHello.push(up, () => this.syncClock());
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
  }

  /** Sets the guest's clock to the browser's, under Preferences' switch; false: not sent (off, or no agent yet). */
  syncClock(): boolean {
    return clockSync() && !!this.#link?.time();
  }
}
