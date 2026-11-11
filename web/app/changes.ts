// A change signal for state kept in a plain object outside Svelte (docs/frontend-code.md §3.1): the live network,
// folders, USB ports, the on-screen keyboard's keys, a clipboard share. Its readers call `track()`, its writers
// `notify()` after a change: a component's template or `$derived` that read through `track()` runs again. Outside a
// reactive read (web/app/main.ts, Node's tests, where Svelte's server build makes it a no-op) it costs nothing.
import { createSubscriber } from 'svelte/reactivity';

export class Changes {
  #update: (() => void) | undefined;
  /** Makes the reactive read this is called in depend on the state. */
  readonly track = createSubscriber((update) => {
    this.#update = update;
    return () => {
      this.#update = undefined;
    };
  });
  /** The state changed: what read it runs again. */
  notify() {
    this.#update?.();
  }
}
