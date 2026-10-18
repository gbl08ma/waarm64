// The kept Tailscale node's state (docs/plans/networking.md §4, docs/tailnet.md "Tailscale"): the
// Go client's `ipn.StateStore` in this origin's IndexedDB, database `webpc-tailscale`, object store
// `state`, keys `<profile>/<StateKey>`, values the hex of the bytes the client wrote. The Rust client
// (web/tailnet-worker.ts) uses it as it is, so a node the Go client made (the page's client until
// T6) is still the same node; tests/ts-tailnet.test.ts checks both ways. A client reads it whole at start and writes it through.

const DB = 'webpc-tailscale';
const STORE = 'state';

const idb = <T>(req: IDBRequest<T>) => new Promise<T>((resolve, reject) => { req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });

/** The node's state store: `profile`'s entries from IndexedDB, in memory, and written back as they change. */
export async function openState(profile: string) {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  const key = (k: string) => `${profile}/${k}`;
  const mem = new Map<string, string>();
  const range = IDBKeyRange.bound(key(''), key('￿'));
  const store = (mode: IDBTransactionMode) => db.transaction(STORE, mode).objectStore(STORE);
  const keys = await idb(store('readonly').getAllKeys(range));
  const values = await idb(store('readonly').getAll(range));
  keys.forEach((k, i) => mem.set(String(k).slice(profile.length + 1), values[i] as string));
  return {
    getState: (k: string) => mem.get(k) ?? '',
    /** Every entry (`<StateKey>` → hex), for the Rust client's start. */
    entries: () => Object.fromEntries(mem),
    setState: (k: string, v: string) => {
      mem.set(k, v);
      store('readwrite').put(v, key(k));
    },
    /** Forget the node (after a logout). */
    clear: async () => { await idb(store('readwrite').delete(range)); mem.clear(); },
  };
}

/**
 * The profiles (`<profile>` prefixes) among a store's keys that hold a node: those with a `_current-profile`. State keys
 * have no `/`, so a key's profile is everything before its last one (a control server's URL, or a connection's id).
 */
export function profilesOf(keys: string[]): string[] {
  return [...new Set(keys.filter((k) => k.endsWith('/_current-profile')).map((k) => k.slice(0, k.lastIndexOf('/'))))];
}

/** The profiles kept in this origin's IndexedDB that hold a node (docs/plans/network-adapters.md §2.2). */
export async function keptProfiles(): Promise<string[]> {
  if (typeof indexedDB === 'undefined') return [];
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  try {
    return profilesOf((await idb(db.transaction(STORE, 'readonly').objectStore(STORE).getAllKeys())).map(String));
  } finally {
    db.close();
  }
}

/** Forgets every entry of `profile` (a deleted connection's node). */
export async function forgetProfile(profile: string) {
  if (typeof indexedDB === 'undefined') return;
  await (await openState(profile)).clear();
}
