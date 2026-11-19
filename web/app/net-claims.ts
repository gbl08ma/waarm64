// The locks of the page's machine's connections (docs/networking/adapters.md §3, web/app/locks.ts): a connection's (one
// running machine has it at a time, in any tab), a room connection's key's (`roomKeyLock`: one connection runs a key
// at a time), and the connections whose nodes are being logged out (nobody connects them meanwhile). For
// web/app/net-live.ts; DOM-free.
import { MsgError } from '../i18n.ts';
import { connectionLock, type Connection, type RoomConnection } from './connections.ts';
import { Locks } from './locks.ts';
import type { Store } from './store.ts';

/** A connection another machine has (in another tab): `holder` is its name, when that tab answered. */
export class HeldError extends MsgError {
  readonly connection: Connection;
  readonly holder?: string;
  constructor(c: Connection, holder?: string) {
    if (holder) super('network:net-claims.held', { name: c.name, holder });
    else super('network:net-claims.heldElsewhere', { name: c.name });
    this.name = 'HeldError';
    [this.connection, this.holder] = [c, holder];
  }
}

/** What `claim` asks of the adapter that connects. */
export type ClaimHere = {
  /** Why it can't connect any more (the machine stopped, its adapters changed), after the wait for the lock. */
  stopped: () => MsgError | undefined;
  /** Whether an adapter here runs the connection already (its lock then stays). */
  runs: () => boolean;
};

/** Who has a room key that a connection couldn't take: `here`, another adapter's connection on this page, or another tab. */
type KeyBusy = { here?: Connection; key: string };

export class NetClaims {
  readonly locks: Locks;
  /** The connections whose nodes are being logged out: nothing connects them meanwhile, and no other tab is let in. */
  readonly leaving = new Set<string>();
  /**
   * The room key locks this page's room connections hold or are taking (`roomKeyLock`), by connection: set before the
   * lock is asked for, so two connections on one key claimed at once here don't both pass.
   */
  private keyLocks = new Map<string, { lock: string; c: Connection }>();
  private keyLock: (r: RoomConnection) => Promise<string>;

  /** `release`: another tab asks for a lock held here; `keyLock`: a room connection's key lock (`Connections.keyLock`). */
  constructor(
    store: Store,
    me: () => string,
    release: (lock: string) => void,
    keyLock: (r: RoomConnection) => Promise<string>,
  ) {
    this.locks = new Locks(store, 'net', me, release);
    this.keyLock = keyLock;
  }

  /** Takes connection `c`'s lock: `HeldError` if another tab's machine has it. */
  async take(c: Connection) {
    const lock = connectionLock(c.id);
    if (!(await this.locks.take(lock))) throw new HeldError(c, await this.locks.holder(lock));
  }

  /**
   * Takes `c`'s locks for an adapter: the connection's (`HeldError` if another machine has it), then a room's key's.
   * Why the adapter can't connect, with its lock let go unless it runs `c` already; nothing when they are taken.
   */
  async claim(c: Connection, here: ClaimHere): Promise<MsgError | undefined> {
    await this.take(c);
    const lock = connectionLock(c.id);
    const stopped = here.stopped();
    if (stopped) {
      if (!here.runs()) this.locks.drop(lock);
      return stopped;
    }
    if (!c.room) return undefined;
    const busy = await this.takeKey(c, c.room);
    if (!busy) return undefined;
    if (!here.runs()) this.locks.drop(lock);
    return this.keyRefusal(busy);
  }

  /** Asks the tab whose machine has `c` to let it go: `HeldError` if it doesn't. */
  async takeFrom(c: Connection) {
    const lock = connectionLock(c.id);
    if (!(await this.locks.takeFrom(lock))) throw new HeldError(c, await this.locks.holder(lock));
  }

  /**
   * Takes the lock of room connection `c`'s key: refused when another connection here holds or is taking it (`take`
   * says yes to a lock this page holds), then when another tab has it. Who has it when it can't, else nothing.
   */
  private async takeKey(c: Connection, room: RoomConnection): Promise<KeyBusy | undefined> {
    const key = await this.keyLock(room);
    const here = [...this.keyLocks].find(([id, k]) => id !== c.id && k.lock === key)?.[1].c;
    if (here) return { here, key };
    const mine = { lock: key, c };
    this.keyLocks.set(c.id, mine); // before the wait: a claim of another connection on it meanwhile is refused
    if (await this.locks.take(key)) return undefined;
    if (this.keyLocks.get(c.id) === mine) this.keyLocks.delete(c.id);
    return { key };
  }

  /** Why a room key couldn't be taken, in words: the other adapter's connection, or the tab that has it. */
  private async keyRefusal(busy: KeyBusy): Promise<MsgError> {
    const holder = busy.here ? undefined : await this.locks.holder(busy.key);
    return busy.here
      ? new MsgError('network:net-claims.keyInUse', { other: busy.here.name })
      : holder
        ? new MsgError('network:net-claims.keyHeld', { holder })
        : new MsgError('network:net-claims.keyHeldElsewhere');
  }

  /**
   * Runs `run` with `c` leaving (nothing connects it meanwhile, no other tab is let in) and, once `stop` has stopped
   * its clients here, its lock held: `HeldError` if another tab's machine has it.
   */
  async whileLeaving<T>(c: Connection, stop: () => Promise<void>, run: () => Promise<T>): Promise<T> {
    this.leaving.add(c.id);
    try {
      await stop();
      await this.take(c);
      return await run();
    } finally {
      this.locks.drop(connectionLock(c.id));
      this.leaving.delete(c.id);
    }
  }

  /** Lets connection `id` go: its lock, and its room key's. */
  let(id: string) {
    this.locks.drop(connectionLock(id));
    const k = this.keyLocks.get(id);
    this.keyLocks.delete(id);
    if (k) this.locks.drop(k.lock);
  }

  /** Whether `lock` is a connection's whose node is being logged out. */
  isLeaving(lock: string) {
    return [...this.leaving].some((id) => connectionLock(id) === lock);
  }

  /** The ids of `connections` another tab's machine holds now. */
  async heldElsewhere(connections: Connection[]): Promise<Set<string>> {
    const held = await this.locks.heldElsewhere();
    return new Set(connections.filter((c) => held.has(connectionLock(c.id))).map((c) => c.id));
  }
}
