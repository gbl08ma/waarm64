// A restored machine's leases (docs/devices.md "The network after a restore"): its guest holds the leases it had when
// the snapshot was taken, while the page may connect its cards elsewhere now, so it is told to ask again. Not at once:
// the page's gateway makes no offer while its connection has no lease and refuses a renewal (web/gateway.ts `dhcp`), and
// a client refused backs off for long. So, once the page's network has settled with a card connected
// (web/app/net-settled.ts `NetSettled.when`: every attached adapter connected, or waiting on the user; `GRACE_MS` at most
// after the first): the guest agent renews them through the guest's network manager (LEASE, web/app/agent-link.ts
// `lease`), at once and keeping an address that is still right; where it can't (no agent within `AGENT_WAIT_MS`, an
// agent without `CAP.LEASE`, LEASED not RENEWED), each connected card's link flaps instead (web/devices.ts `flap`:
// 7 s down, past what networkd waits out). The user's choice, 2026-11-13. Until it's done, a card's own flaps (its switch
// onto the local helper's or the demo network's frames) are held (web/devices.ts `restored`), so the link doesn't go down
// under the agent's renewal; then the page says which cards it renewed (`settled`), and the others flap if they owed one.
import { LEASED } from '../../agent-frame.ts';
import type { AgentLink } from '../agent-link.ts';

/** How long the other adapters may take to settle once one is connected. */
export const GRACE_MS = 30_000;
/** How long the restored guest's agent may take to connect again (it does within a second or two). */
export const AGENT_WAIT_MS = 20_000;
/** How long the agent's network manager may take to answer. */
export const LEASED_WAIT_MS = 60_000;

/** An adapter connected: its number and its MAC (the guest's card's, which LEASE names). */
export type Connected = { index: number; mac: string };

export type LeaseDeps = {
  /** The adapters connected once the page's network settled (web/app/net-settled.ts `NetSettled.when`), with their MACs. */
  whenConnected(graceMs: number, cancelled: () => boolean): Promise<Connected[]>;
  /** The run's agent link, if it has one. */
  link(): AgentLink | undefined;
  /** Flaps card `i`'s link. */
  flap(i: number): void;
  /** Done with the restore's leases: `renewed` the cards the agent renewed (each card's held flap is dropped or done). */
  settled(renewed: number[]): void;
  /** Ms to wait (the tests' are shorter). */
  waits?: { grace: number; agent: number; leased: number };
};

export class LeaseActions {
  readonly #d: LeaseDeps;
  /** The run's count: a run that ended (`end`), or a newer restore, stops what an older one waits for. */
  #run = 0;

  constructor(d: LeaseDeps) {
    this.#d = d;
  }

  /** The machine was restored: its guest renews its leases once the page's connections are up. What was done, for the tests. */
  async restored(): Promise<'agent' | 'flap' | 'gone' | 'none'> {
    const run = ++this.#run;
    const gone = () => run !== this.#run;
    const w = this.#d.waits ?? { grace: GRACE_MS, agent: AGENT_WAIT_MS, leased: LEASED_WAIT_MS };
    const connected = await this.#d.whenConnected(w.grace, gone);
    if (gone()) return 'gone';
    // The grace ended with none connected (the one that was went back to connecting): nothing to renew yet.
    if (!connected.length) {
      this.#d.settled([]);
      return 'none';
    }
    const link = this.#d.link();
    const hello = link && (await link.hello(w.agent));
    if (gone()) return 'gone';
    // The connected cards only: one still connecting would be refused (and back off) by the page's gateway.
    const status = hello
      ? await link.lease(
          w.leased,
          connected.map((c) => c.mac),
        )
      : undefined;
    if (gone()) return 'gone';
    if (status === LEASED.RENEWED) {
      this.#d.settled(connected.map((c) => c.index));
      return 'agent';
    }
    for (const c of connected) this.#d.flap(c.index);
    this.#d.settled([]);
    return 'flap';
  }

  /** The run ended: nothing more for it. */
  end() {
    this.#run++;
  }
}
