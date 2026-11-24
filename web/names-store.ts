// The names agent's stores (web/names.ts; docs/networking/names.md "The names agent"): the owners' secret and the
// titles, in memory (the tests') or in IndexedDB `waarm64-room` (the page's), and what a room's worker reads of them
// (web/room-worker.ts: the titles a running room serves, and the word that they changed).
import { hex } from './bytes.ts';
import { openIdb } from './room.ts';
import type { NamesOp, NamesTitle } from './ts-client.ts';

/** Where a name points: the name itself (`label` null) or a label under it, at a node key (64 hex digits). */
export type ZonePoint = { label: string | null; key: string };

/** A title as kept (IndexedDB `waarm64-room`, store `titles`, under [identityKey, room hash, name]). */
export type TitleRecord = {
  identityKey: string;
  /** The room's ID (a private room's is a secret, as its link in the connection is) and link (the publisher's). */
  room: string;
  link: string;
  name: string;
  /** Every entry of the title with its anchor or pending one, and the zone (net/ts room/names/wire.rs `Item`, hex);
   * empty before the first entry is made. */
  item: string;
  /** Each unanchored entry's pending anchors (hex, signed), one per calendar that gave a receipt. */
  stamps: Record<string, string[]>;
  /** When an entry's proof is asked for again, how many asks found it pending, and when it was stamped (ms; none in a
   * record from before it was kept). */
  collect: Record<string, { next: number; tries: number; since?: number }>;
  /** When an entry may be made again (one that no calendar stamped). */
  remake?: { next: number; tries: number };
  /** The next renewal made ahead (names.md "Decisions"): its proof of work and signature done, after entry `prev`
   * (the owning chain's last, or the renewal waiting on it), not stamped. A visit that finds a renewal due stamps this
   * one, which takes seconds, and hands it to the servers, who finish it at its calendar: so a short visit keeps a name. */
  ahead?: { prev: string; entry: string };
  points: ZonePoint[];
  /** A zone's `seq` (64 bits) is `n << 32 | branch`: `n` counts up past every `seq` the title has seen, `branch` is
   * this copy's, 32 random bits drawn when the title was registered or taken in from an export (each paste draws its
   * own), so two copies of a title, however made, share one with a chance of 2^-32 a pair. */
  zone: { n: number; branch: number };
  /** The owners' secret of this title, when it isn't its connection's: one taken in from an export pasted into a
   * connection that had a secret of its own already (review 2: renewals signed with the connection's would break the
   * chain). */
  secret?: string;
  /** A better chain of another key's owns the name (its owner key): renewal stops. */
  lost?: { at: number; by: string };
  /** Let go (Let it go, or New name's Let them go): kept before the release is made (its proof of work takes a while),
   * which the passes make when it isn't yet. */
  released?: boolean;
  /** New name's Point at the new name: the points at this node key move to the connection's key once it is another
   * one (the passes); kept before the key changes. None in a record from before it was kept. */
  repoint?: string;
  /** A server didn't take the zone put (within its 10 minutes of the last, or behind the room's): put again then (ms). */
  putAgain?: number;
  /** The item last published and taken (or shown as the title's own), and when. */
  published?: string;
  publishedAt?: number;
  /** When the first entry was stamped (ms). */
  stampedAt?: number;
  made: number;
};

/** `points` with what pointed at node key `from` pointed at `to` (another member's points stay); undefined when none
 * pointed at `from`. */
export function repointed(points: ZonePoint[], from: string, to: string): ZonePoint[] | undefined {
  if (!points.some((p) => p.key === from)) return undefined;
  return points.map((p) => (p.key === from ? { ...p, key: to } : p));
}

// ---- Storage ----

/** Where the agent keeps the owners' secret and the titles. */
export type NamesStore = {
  /** The owners' secret of connection `identityKey` (64 hex digits), if made. */
  secret(identityKey: string): Promise<string | undefined>;
  /** Keeps `secret` unless one is there; the one kept. */
  addSecret(identityKey: string, secret: string): Promise<string>;
  titles(identityKey?: string): Promise<TitleRecord[]>;
  get(identityKey: string, room: string, name: string): Promise<TitleRecord | undefined>;
  put(t: TitleRecord): Promise<void>;
  delete(identityKey: string, room: string, name: string): Promise<void>;
  /** Connection `identityKey`'s secret and every title of it gone (its connection deleted, after saying so). */
  forget(identityKey: string): Promise<void>;
};

/** A room's ID as a key: a hash (the ID itself is a private room's secret, and Web Locks' names are listed). */
export async function roomHash(room: string): Promise<string> {
  const h = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`waarm64 room titles\n${room}`));
  return hex(new Uint8Array(h).subarray(0, 16));
}

/** In memory: the tests'. */
export function memoryNamesStore(): NamesStore {
  const secrets = new Map<string, string>();
  const titles = new Map<string, TitleRecord>();
  const k = (i: string, r: string, n: string) => JSON.stringify([i, r, n]);
  return {
    secret: (i) => Promise.resolve(secrets.get(i)),
    addSecret: (i, s) => {
      if (!secrets.has(i)) secrets.set(i, s);
      return Promise.resolve(secrets.get(i)!);
    },
    titles: (i) =>
      Promise.resolve(
        [...titles.values()].filter((t) => i === undefined || t.identityKey === i).map((t) => structuredClone(t)),
      ),
    get: (i, r, n) => Promise.resolve(structuredClone(titles.get(k(i, r, n)))),
    put: (t) => {
      titles.set(k(t.identityKey, t.room, t.name), structuredClone(t));
      return Promise.resolve();
    },
    delete: (i, r, n) => {
      titles.delete(k(i, r, n));
      return Promise.resolve();
    },
    forget: (i) => {
      secrets.delete(i);
      for (const [key, t] of titles) if (t.identityKey === i) titles.delete(key);
      return Promise.resolve();
    },
  };
}

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = (e) => {
      e.preventDefault();
      reject(r.error); // eslint-disable-line @typescript-eslint/prefer-promise-reject-errors -- IndexedDB's DOMException
    };
  });
}

async function tx<T>(stores: string[], mode: IDBTransactionMode, f: (t: IDBTransaction) => Promise<T>): Promise<T> {
  const db = await openIdb();
  try {
    const t = db.transaction(stores, mode);
    const done = new Promise<void>((resolve, reject) => {
      t.oncomplete = () => resolve();
      t.onerror = t.onabort = () => reject(t.error); // eslint-disable-line @typescript-eslint/prefer-promise-reject-errors -- as `req`
    });
    const out = await f(t);
    await done;
    return out;
  } finally {
    db.close();
  }
}

/** The page's: IndexedDB `waarm64-room`, stores `owner` (the secret under the connection's `identityKey`, as `identity`
 * keeps its node key) and `titles` (under [identityKey, room hash, name]). */
export function idbNamesStore(): NamesStore {
  const key = async (t: { identityKey: string; room: string; name: string }) => [
    t.identityKey,
    await roomHash(t.room),
    t.name,
  ];
  return {
    secret: (i) =>
      tx(['owner'], 'readonly', (t) =>
        req(t.objectStore('owner').get(i) as IDBRequest<{ secret: string } | undefined>),
      ).then((v) => v?.secret),
    addSecret: (i, s) =>
      tx(['owner'], 'readwrite', async (t) => {
        const o = t.objectStore('owner');
        const have = await req(o.get(i) as IDBRequest<{ secret: string } | undefined>);
        if (have) return have.secret;
        await req(o.add({ secret: s }, i));
        return s;
      }),
    titles: (i) =>
      tx(['titles'], 'readonly', (t) =>
        req(
          t.objectStore('titles').getAll(i === undefined ? undefined : IDBKeyRange.bound([i], [i, []])) as IDBRequest<
            TitleRecord[]
          >,
        ),
      ),
    get: async (i, r, n) => {
      const k = await key({ identityKey: i, room: r, name: n });
      return tx(['titles'], 'readonly', (t) =>
        req(t.objectStore('titles').get(k) as IDBRequest<TitleRecord | undefined>),
      );
    },
    put: async (v) => {
      const k = await key(v);
      await tx(['titles'], 'readwrite', (t) => req(t.objectStore('titles').put(v, k)));
    },
    delete: async (i, r, n) => {
      const k = await key({ identityKey: i, room: r, name: n });
      await tx(['titles'], 'readwrite', (t) => req(t.objectStore('titles').delete(k)));
    },
    forget: (i) =>
      tx(['owner', 'titles'], 'readwrite', async (t) => {
        await req(t.objectStore('owner').delete(i));
        await req(t.objectStore('titles').delete(IDBKeyRange.bound([i], [i, []])));
      }),
  };
}

/** Changes to a connection's titles, for its room's worker (web/room-worker.ts) in any tab. */
export const NAMES_CHANNEL = 'waarm64-names';

// ---- The room's worker: the titles a running room serves ----

/**
 * The titles connection `identityKey` holds in room `room`, as the module's config takes them (`room.names.titles`): the
 * owner key from the secret (by the room's own module `m`) and the item. Lost and empty titles aren't served.
 */
export async function roomTitles(
  store: NamesStore,
  ops: (op: NamesOp, input: object) => Record<string, unknown>,
  identityKey: string,
  room: string,
): Promise<NamesTitle[]> {
  const kept = await store.secret(identityKey);
  const out: NamesTitle[] = [];
  for (const t of await store.titles(identityKey)) {
    const secret = t.secret ?? kept;
    if (t.room !== room || t.lost || !t.item || !secret) continue;
    try {
      out.push({ key: ops('key', { room, secret, name: t.name }).key as string, item: t.item });
    } catch {
      /* a name the rules refuse: not served */
    }
  }
  return out;
}
