// A command the page gives a component that owns what it opens (docs/frontend-code.md §3.3): the Network menu, the
// Network wizard, the Folders menu… The component `handle`s it while it is mounted (`$effect(() => cmd.handle(f))`);
// anyone `call`s it. A call before the component is there (the page opened on a pairing link) waits for it.
import { untrack } from 'svelte';

export class Command<A extends unknown[] = []> {
  #handler: ((...args: A) => void) | undefined;
  #pending: A | undefined;

  call(...args: A) {
    if (this.#handler) this.#handler(...args);
    else this.#pending = args;
  }

  /** Answers the command with `f` (a call waiting is answered now); returns the cleanup that stops answering. */
  handle(f: (...args: A) => void): () => void {
    this.#handler = f;
    const pending = this.#pending;
    this.#pending = undefined;
    // Not a dependency of the effect that handles it: what `f` reads is the component's own.
    if (pending) untrack(() => f(...pending));
    return () => {
      if (this.#handler === f) this.#handler = undefined;
    };
  }
}
