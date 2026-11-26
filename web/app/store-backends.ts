// The store's backends (web/app/store.ts `Store`): its records and files in memory (Node, tests), in IndexedDB and in
// OPFS.
import type { Files, Kind, Records } from './store.ts';

const KINDS: Kind[] = ['machines', 'disks', 'overlays', 'snapshots', 'connections', 'folders'];

/** Records in memory (Node, tests): structured clones in and out, as IndexedDB. */
export function memoryRecords(): Records {
  const maps = Object.fromEntries(KINDS.map((k) => [k, new Map<string, unknown>()])) as Record<
    Kind,
    Map<string, unknown>
  >;
  /* eslint-disable @typescript-eslint/require-await -- IndexedDB's contract (a throw is a rejection), nothing to await */
  return {
    get: async (kind, id) => structuredClone(maps[kind].get(id)) as never,
    all: async (kind) => [...maps[kind].values()].map((v) => structuredClone(v)) as never,
    put: async (kind, value) => {
      maps[kind].set(value.id, structuredClone(value));
    },
    update: async (kind, id, f) => {
      const next = f(structuredClone(maps[kind].get(id)) as never);
      if (next) maps[kind].set(id, structuredClone(next));
      return structuredClone(next);
    },
    delete: async (kind, id) => {
      maps[kind].delete(id);
    },
  };
  /* eslint-enable @typescript-eslint/require-await */
}

/** Files in memory (Node, tests): a path → size map; `write` makes one (and its directories). */
export function memoryFiles(): Files & { write(path: string, bytes: number): void; paths(): string[] } {
  const files = new Map<string, number>();
  const under = (dir: string) => [...files.keys()].filter((p) => p.startsWith(`${dir}/`));
  /* eslint-disable @typescript-eslint/require-await -- OPFS's contract (a throw is a rejection), nothing to await */
  return {
    write: (path, bytes) => {
      files.set(path, bytes);
    },
    paths: () => [...files.keys()].sort(),
    list: async (dir) => [...new Set(under(dir).map((p) => p.slice(dir.length + 1).split('/')[0]))],
    remove: async (path) => {
      files.delete(path);
      for (const p of under(path)) files.delete(p);
    },
    size: async (path) => (files.get(path) ?? 0) + under(path).reduce((n, p) => n + (files.get(p) ?? 0), 0),
  };
  /* eslint-enable @typescript-eslint/require-await */
}

const DB = 'waarm64';
/** A request's or a transaction's error; none (a transaction aborted without one) is still an Error. */
const failure = (e: DOMException | null) =>
  e ?? new DOMException('the IndexedDB transaction was aborted', 'UnknownError');
const idb = <T>(req: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(failure(req.error));
  });

/** Records in IndexedDB `waarm64`: an object store per kind, keyed by `id` (version 2 added `connections`, 3 `folders`). */
export async function idbRecords(name = DB): Promise<Records> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const r = indexedDB.open(name, 3);
    r.onupgradeneeded = () => {
      for (const k of KINDS)
        if (!r.result.objectStoreNames.contains(k)) r.result.createObjectStore(k, { keyPath: 'id' });
    };
    // A tab of a newer page upgrading the database: this one lets go (its page is out of date; a reload has the new one).
    r.onsuccess = () => {
      r.result.onversionchange = () => r.result.close();
      resolve(r.result);
    };
    r.onerror = () => reject(failure(r.error));
  });
  const store = (kind: Kind, mode: IDBTransactionMode) =>
    db.transaction(kind, mode, { durability: 'strict' }).objectStore(kind);
  // A write resolves once its transaction is committed (durably: a record follows its bytes).
  const commit = (kind: Kind, f: (s: IDBObjectStore) => void) =>
    new Promise<void>((resolve, reject) => {
      const s = store(kind, 'readwrite');
      f(s);
      s.transaction.oncomplete = () => resolve();
      s.transaction.onerror = s.transaction.onabort = () => reject(failure(s.transaction.error));
    });
  return {
    get: (kind, id) => idb(store(kind, 'readonly').get(id)) as never,
    all: (kind) => idb(store(kind, 'readonly').getAll()) as never,
    put: (kind, value) => commit(kind, (s) => s.put(value)),
    // The get and the put in one transaction: IndexedDB runs no other readwrite transaction on the store between.
    update: (kind, id, f) => {
      let next: unknown;
      let thrown: { e: unknown } | undefined;
      return commit(kind, (s) => {
        const req = s.get(id);
        req.onsuccess = () => {
          try {
            next = f(req.result as never);
            if (next) s.put(next);
          } catch (e) {
            thrown = { e };
            s.transaction.abort();
          }
        };
      }).then(
        () => next as never,
        (e: unknown) => {
          throw thrown ? thrown.e : e;
        },
      );
    },
    delete: (kind, id) => commit(kind, (s) => s.delete(id)),
  };
}

/** Files in OPFS under `root`. */
export function opfsFiles(root: FileSystemDirectoryHandle): Files {
  /** The directory at `parts`, or undefined when it doesn't exist. */
  const dir = async (parts: string[]) => {
    let d = root;
    for (const p of parts) {
      try {
        d = await d.getDirectoryHandle(p);
      } catch (e) {
        if ((e as DOMException).name === 'NotFoundError' || (e as DOMException).name === 'TypeMismatchError')
          return undefined;
        throw e;
      }
    }
    return d;
  };
  const split = (path: string) => path.split('/').filter(Boolean);
  const sizeOf = async (h: FileSystemHandle): Promise<number> => {
    if (h.kind === 'file') return (await (h as FileSystemFileHandle).getFile()).size;
    let n = 0;
    for await (const c of (h as FileSystemDirectoryHandle).values()) n += await sizeOf(c);
    return n;
  };
  return {
    async list(path) {
      const d = await dir(split(path));
      const out: string[] = [];
      if (d) for await (const k of d.keys()) out.push(k);
      return out;
    },
    async remove(path) {
      const parts = split(path);
      const name = parts.at(-1);
      if (!name) return; // the root itself: never removed
      const d = await dir(parts.slice(0, -1));
      try {
        await d?.removeEntry(name, { recursive: true });
      } catch (e) {
        if ((e as DOMException).name !== 'NotFoundError') throw e;
      }
    },
    async size(path) {
      const parts = split(path);
      const d = await dir(parts.slice(0, -1));
      const name = parts.at(-1);
      if (!d || !name) return 0;
      const h = await d
        .getFileHandle(name)
        .catch(() => d.getDirectoryHandle(name))
        .catch(() => undefined);
      return h ? sizeOf(h) : 0;
    },
  };
}
