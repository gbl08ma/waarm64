// Which of `waarm64-room`'s stored entries this page's ephemeral room connections use, told to every tab
// (docs/networking/adapters.md §2.1): an ephemeral connection lives only in its tab's memory, so while it uses a stored
// connection's entry (`keyOf`) it holds a shared Web Lock named by the entry (a connection's id, no secret), and another
// tab's Delete and New name see the entry in use and keep it. Without Web Locks (Node's tests may lack them) nothing is
// held, and only this page's connections count.

const lockOf = (identityKey: string) => `waarm64-room-entry:${identityKey}`;

// eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- a probe: no Web Locks in Node's tests
const locks = () => globalThis.navigator?.locks as LockManager | undefined;

export class RoomEntries {
  /** By connection: the lock it holds, and its release. */
  private held = new Map<string, { lock: string; release: () => void }>();

  /** A new connection: an ephemeral one using a stored entry (no key of its own) holds the entry's lock until
   * `release` (or its tab goes). */
  async hold(c: { id: string; ephemeral: boolean; room?: { identityKey: string; identity?: unknown } }) {
    const l = locks();
    if (!l || !c.ephemeral || !c.room || c.room.identity) return;
    const [id, lock] = [c.id, lockOf(c.room.identityKey)];
    let release!: () => void;
    const kept = new Promise<void>((resolve) => (release = resolve));
    // Shared, and nothing takes it exclusively: granted at once.
    await new Promise<void>((granted) => {
      void l.request(lock, { mode: 'shared' }, () => {
        granted();
        return kept;
      });
    });
    this.held.set(id, { lock, release });
  }

  release(id: string) {
    this.held.get(id)?.release();
    this.held.delete(id);
  }

  /** Whether another tab's connection holds entry `identityKey`'s lock (more holders than this page's own). */
  async elsewhere(identityKey: string): Promise<boolean> {
    const l = locks();
    if (!l) return false;
    const lock = lockOf(identityKey);
    const all = ((await l.query()).held ?? []).filter((x) => x.name === lock).length;
    return all > [...this.held.values()].filter((e) => e.lock === lock).length;
  }
}
