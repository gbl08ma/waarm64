// Locks on things one running machine has at a time (a USB device, docs/usb.md "The page"; a network connection,
// docs/network-adapters.md §2.3; a shared folder, docs/shares.md, which several can read): a Web Lock per thing, held
// while this page's machine has it. Other tabs ask
// who holds one (`<topic>-who`, answered `<topic>-held` with the machine's name) and ask the holder to let it go
// (`<topic>-release`), over the store's channel. Without Web Locks (Node's tests may lack them) every take succeeds.
import type { Note, Store } from './store.ts';

export class Locks {
  private held = new Map<string, () => void>();
  private store: Store;
  private topic: string;
  private me: () => string;
  private release: (lock: string) => void;
  private answers = new Map<string, (name: string) => void>();
  private off: () => void;

  /** `topic`: the notes' prefix; `me`: the name of this page's machine; `release`: lets go of what another tab asks for. */
  constructor(store: Store, topic: string, me: () => string, release: (lock: string) => void) {
    [this.store, this.topic, this.me, this.release] = [store, topic, me, release];
    this.off = store.onNote((n: Note) => {
      const lock = typeof n.lock === 'string' ? n.lock : '';
      if (n.topic === `${topic}-who` && this.held.has(lock))
        store.tell({ topic: `${topic}-held`, lock, name: this.me() });
      else if (n.topic === `${topic}-held`) this.answers.get(lock)?.(String(n.name));
      else if (n.topic === `${topic}-release` && this.held.has(lock)) this.release(lock);
    });
  }

  mine(lock: string) {
    return this.held.has(lock);
  }

  /** Takes `lock` if no one holds it (`shared`: or others only read): false if another machine does. */
  async take(lock: string, o: { shared?: boolean } = {}): Promise<boolean> {
    if (this.held.has(lock)) return true;
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- a probe: no Web Locks in Node's tests
    if (!globalThis.navigator?.locks) return true;
    let release!: () => void;
    const kept = new Promise<void>((resolve) => {
      release = resolve;
    });
    const got = await new Promise<boolean>((resolve) => {
      void navigator.locks.request(lock, { ifAvailable: true, mode: o.shared ? 'shared' : 'exclusive' }, (l) => {
        resolve(!!l);
        return l ? kept : undefined;
      });
    });
    if (got) this.held.set(lock, release);
    return got;
  }

  drop(lock: string) {
    this.held.get(lock)?.();
    this.held.delete(lock);
  }
  dropAll() {
    for (const l of [...this.held.keys()]) this.drop(l);
  }

  /** The name of the machine that holds `lock` in another tab (undefined if none answers in time). */
  holder(lock: string, ms = 400): Promise<string | undefined> {
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        this.answers.delete(lock);
        resolve(undefined);
      }, ms);
      this.answers.set(lock, (name) => {
        clearTimeout(t);
        this.answers.delete(lock);
        resolve(name);
      });
      this.store.tell({ topic: `${this.topic}-who`, lock });
    });
  }

  /** Asks the tab that holds `lock` to let it go, then takes the lock (false if it isn't let go within `ms`). */
  async takeFrom(lock: string, o: { shared?: boolean; ms?: number } = {}): Promise<boolean> {
    const ms = o.ms ?? 8000;
    this.store.tell({ topic: `${this.topic}-release`, lock });
    const until = Date.now() + ms;
    while (Date.now() < until) {
      if (await this.take(lock, o)) return true;
      await new Promise((r) => setTimeout(r, 200));
    }
    return false;
  }

  close() {
    this.dropAll();
    this.off();
  }
}

/** The locks held now by anyone (every tab of this origin). */
export async function heldLocks(): Promise<Set<string>> {
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- a probe: no Web Locks in Node's tests
  if (!globalThis.navigator?.locks) return new Set();
  const q = await navigator.locks.query();
  return new Set((q.held ?? []).flatMap((l) => (l.name ? [l.name] : [])));
}
