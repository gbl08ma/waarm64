// When a restored machine's guest may renew its leases (web/app/areas/lease-actions.ts): the page's network settled with
// a card connected. Its gateway offers nothing while a connection has no lease (web/gateway.ts `dhcp`), so renewing
// before the connection is up would leave the guest without a lease for long.
import type { Phase } from './network-view.ts';
import type { Connected } from './areas/lease-actions.ts';

/** The phases an adapter's client stays in without the user: done connecting, one way or another. */
const SETTLED: readonly Phase[] = ['off', 'connected', 'login', 'error'];

export class NetSettled {
  /** The adapters' phases and MACs now (web/app/net-live.ts `views`). */
  readonly #views: () => { phase: Phase; mac: string }[];
  /** `when`'s checks, run at each change (`changed`); each returns true once it is done. */
  #checks: (() => boolean)[] = [];

  constructor(views: () => { phase: Phase; mac: string }[]) {
    this.#views = views;
  }

  /** An adapter's state changed (the page's network's `onChange`). */
  changed() {
    this.#checks = this.#checks.filter((c) => !c());
  }

  /**
   * The adapters connected (their clients hold a lease the page's gateway hands out), once at least one is and every
   * adapter has settled (connected, or waiting on the user: a login, an error), or `graceMs` after the first connected;
   * pending while none connects. `cancelled` (the run's end) leaves it pending for good.
   */
  when(graceMs: number, cancelled: () => boolean = () => false): Promise<Connected[]> {
    return new Promise((resolve) => {
      let first: ReturnType<typeof setTimeout> | undefined;
      const connected = () =>
        this.#views().flatMap((v, index) => (v.phase === 'connected' ? [{ index, mac: v.mac }] : []));
      const check = () => {
        if (cancelled()) {
          clearTimeout(first);
          return true;
        }
        const now = connected();
        if (!now.length) return false;
        if (this.#views().every((v) => SETTLED.includes(v.phase))) {
          clearTimeout(first);
          resolve(now);
          return true;
        }
        first ??= setTimeout(() => {
          this.#checks = this.#checks.filter((c) => c !== check);
          if (!cancelled()) resolve(connected());
        }, graceMs);
        return false;
      };
      if (!check()) this.#checks.push(check);
    });
  }
}
