// The kept Tailscale node's state (docs/plans/networking.md §4, docs/plans/tailnet-client.md §5): the
// Go client's `ipn.StateStore` in this origin's IndexedDB, database `webpc-tailscale`, object store
// `state`, keys `<profile>/<StateKey>`, values the hex of the bytes the client wrote. Both clients
// (web/tailscale-worker.ts, Go; web/tailnet-worker.ts, Rust) use it as it is, so a node made by
// one is the same node in the other. A client reads it whole at start and writes it through.

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

