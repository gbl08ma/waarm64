// The toolbar's Power off and Restart, asked of the guest first (docs/devices.md "Power off and restart from the
// guest"): where the run's agent can (`CAP.POWER`), it asks the guest to power off or reboot itself (POWER: logind's,
// inhibitors honoured), and the page waits for the guest to do it (its PSCI power-off or reset ends the run), with a
// sign beside the toolbar's stop button meanwhile (`soft`). Without an agent, when the guest refuses or says nothing in
// `SOFT_WAIT_MS`, the caller does today's hard power-off (which asks first); a second request while one is pending is
// the hard one too. The page never forces on its own. The user's design, 2026-11-14.
import { POWERED } from '../../agent-frame.ts';
import { msg, type Msg } from '../../msg.ts';
import type { AgentLink } from '../agent-link.ts';

/** How long the guest has to say it took the request (logind's answer through busctl, under the JIT). */
export const SOFT_WAIT_MS = 15_000;

export type SoftKind = 'off' | 'reboot';
type Agent = { readonly link: AgentLink | undefined };
/** Where the page shows a request pending (web/app/areas/power.svelte.ts `soft`; the run's end clears it). */
type Shown = { soft: SoftKind | undefined };
type Notify = { notify(m: Msg): void };

export class SoftPower {
  readonly #agent: Agent;
  readonly #shown: Shown;
  readonly #messages: Notify;

  constructor(agent: Agent, shown: Shown, messages: Notify) {
    [this.#agent, this.#shown, this.#messages] = [agent, shown, messages];
  }

  /**
   * Asks the guest to power off or reboot itself. True: nothing more to do (the guest took it, its agent's connection
   * ended under the shutdown, or the run ended meanwhile); false: the hard one is the caller's (no agent that can, one
   * pending already, refused, no answer).
   */
  async request(kind: SoftKind): Promise<boolean> {
    const link = this.#agent.link;
    if (this.#shown.soft || !link?.canPower) return false;
    this.#shown.soft = kind;
    const r = await link.power(kind === 'reboot', SOFT_WAIT_MS);
    if (this.#agent.link !== link) return true;
    if (r === POWERED.TAKEN || r === 'gone') return true;
    if (this.#shown.soft === kind) this.#shown.soft = undefined;
    if (r === POWERED.REFUSED)
      this.#messages.notify(
        msg(kind === 'off' ? 'machine:soft-power.refused.off' : 'machine:soft-power.refused.reboot'),
      );
    return false;
  }
}
