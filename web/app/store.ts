// The browser's machines, disks, overlays and snapshots (docs/plans/machines.md §2): records in
// IndexedDB (database `webpc`, a store per kind, keyed by `id`), bytes in OPFS (`overlays/<id>/`,
// `disks/<id>/`, `machines/<id>/` with its `flash`, `suspend` and `snapshots/<id>`). **A record is
// written after its bytes and deleted before them**, so a crash leaves files without a record,
// never a record without its files; `sweep` removes those at the start. Writers that make bytes
// before their record do it inside `writing`, which the sweep waits out (a Web Lock, shared by
// every tab). Other tabs hear of every change through a BroadcastChannel (`onChange`): their
// views reread. DOM-free: Node's tests run it over memory (`memoryRecords`, `memoryFiles`).
import { isId, type DiskIdentity, type DiskRecord, type MachineRecord, type Shape } from './shape.ts';

/**
 * A variant of a base disk's changes (machines.md §2, §3.3): its blocks are in OPFS
 * `overlays/<id>/` (`data`, `map`, `meta`). `generation` is the meta file's, as the page last
 * read it (the device worker bumps the file's before a session's first write). `fork`: the
 * snapshot whose blocks it was made from, and its generation then, so a second restore of that
 * snapshot reuses it while it hasn't moved (§5.2).
 */
export type OverlayRecord = {
  id: string;
  name: string;
  /** The base disk's id, and its identity when the overlay was made (an overlay only makes sense over those bytes). */
  disk: string;
  identity: DiskIdentity;
  generation: number;
  bytes: number;
  created: number;
  modified: number;
  fork?: { snapshot: string; generation: number };
};

/**
 * What a snapshot needs of a writable disk (machines.md §5.1; web/snapshot.ts `SnapshotDisk`): by slot, the overlay's
 * path (`overlays/<id>`, or `disks/<id>` for a disk written in place) at a generation, the blocks the file carries for
 * it, and whether it is a ramdisk (whose blocks are always in the file).
 */
export type Pin = { slot: number; overlay?: string; generation?: number; blocks: number; ram?: boolean };

/** A snapshot kept in the browser (`machines/<machine>/snapshots/<id>`, the WEBPCSNP file). */
export type SnapshotRecord = {
  id: string;
  machine: string;
  name: string;
  created: number;
  bytes: number;
  /** The machine's shape when it was made, and its hash: a machine whose hash is now another orphans it. */
  shape: Shape;
  shapeHash: string;
  pins: Pin[];
  /** Its URL disks' URLs by slot (from the file's header): a machine like it can be made again. */
  urls?: Record<number, string>;
};

export type Kinds = { machines: MachineRecord; disks: DiskRecord; overlays: OverlayRecord; snapshots: SnapshotRecord };
export type Kind = keyof Kinds;
const KINDS: Kind[] = ['machines', 'disks', 'overlays', 'snapshots'];

/** Where records live: IndexedDB in a browser, a Map in Node. Values are copied in and out (structured clone). */
export type Records = {
  get<K extends Kind>(kind: K, id: string): Promise<Kinds[K] | undefined>;
  all<K extends Kind>(kind: K): Promise<Kinds[K][]>;
  put<K extends Kind>(kind: K, value: Kinds[K]): Promise<void>;
  delete(kind: Kind, id: string): Promise<void>;
};

/** Where bytes live: OPFS in a browser, a Map in Node. Paths are `/`-separated, relative to the store's root. */
export type Files = {
  /** The names in directory `dir` ([] when it doesn't exist). */
  list(dir: string): Promise<string[]>;
  /** Removes a file or a directory with everything in it; a missing one is fine. */
  remove(path: string): Promise<void>;
  /** The bytes a file, or everything in a directory, takes (0 when missing). */
  size(path: string): Promise<number>;
};

/** A change, as other tabs hear it. */
export type Change = { kind: Kind; id: string; deleted?: boolean };
/**
 * Anything else tabs tell each other on the store's channel (`tell`, `onNote`): a `topic` and its data. The USB
 * devices' locks ask there who holds a device, and ask the holder to let it go (web/app/usb-live.ts).
 */
export type Note = { topic: string; [k: string]: unknown };

export const overlayDir = (id: string) => `overlays/${id}`;
export const diskDir = (id: string) => `disks/${id}`;
export const machineDir = (id: string) => `machines/${id}`;
export const snapshotPath = (machine: string, id: string) => `machines/${machine}/snapshots/${id}`;
export const flashPath = (machine: string) => `machines/${machine}/flash`;
export const suspendPath = (machine: string) => `machines/${machine}/suspend`;

/** The lock writers share and the sweep takes alone (machines.md §2). */
const WRITE_LOCK = 'webpc-store';
const CHANNEL = 'webpc-store';

export class Store {
  private channel?: BroadcastChannel;
  private listeners = new Set<(c: Change) => void>();
  private notes = new Set<(n: Note) => void>();
  readonly records: Records;
  readonly files: Files;

  constructor(records: Records, files: Files, opts: { channel?: string | false } = {}) {
    [this.records, this.files] = [records, files];
    if (opts.channel !== false && typeof BroadcastChannel !== 'undefined') {
      this.channel = new BroadcastChannel(opts.channel ?? CHANNEL);
      this.channel.onmessage = (e: MessageEvent<Change | Note>) => {
        if ('topic' in e.data) for (const f of this.notes) f(e.data);
        else for (const f of this.listeners) f(e.data);
      };
    }
  }

  /** The browser's store (IndexedDB and OPFS), or, without them (Node), one in memory for the process's life. */
  static async open(): Promise<Store> {
    if (typeof indexedDB === 'undefined' || typeof navigator.storage?.getDirectory !== 'function') return new Store(sharedMemory.records, sharedMemory.files);
    return new Store(await idbRecords(), opfsFiles(await navigator.storage.getDirectory()));
  }

  /** Calls `f` with every change another tab (or another Store on the same channel) makes; returns the unsubscribe. */
  onChange(f: (c: Change) => void) {
    this.listeners.add(f);
    return () => { this.listeners.delete(f); };
  }

  /** Calls `f` with every note another tab sends (`tell`); returns the unsubscribe. */
  onNote(f: (n: Note) => void) {
    this.notes.add(f);
    return () => { this.notes.delete(f); };
  }
  /** Sends a note to the other tabs (not to this Store's own listeners). */
  tell(n: Note) {
    this.channel?.postMessage(n);
  }

  close() {
    this.channel?.close();
    this.listeners.clear();
    this.notes.clear();
  }

  private said(c: Change) {
    this.channel?.postMessage(c);
  }

  get<K extends Kind>(kind: K, id: string) { return this.records.get(kind, id); }
  all<K extends Kind>(kind: K) { return this.records.all(kind); }

  /** Writes a record (its bytes, if any, are written already: inside `writing`). */
  async put<K extends Kind>(kind: K, value: Kinds[K]) {
    await this.records.put(kind, value);
    this.said({ kind, id: value.id });
  }

  /**
   * Runs `f`, which writes bytes and then their record, so the sweep (in any tab) doesn't take the
   * bytes for leftovers before the record is there.
   */
  writing<T>(f: () => Promise<T>): Promise<T> {
    if (typeof navigator === 'undefined' || !navigator.locks) return f();
    return navigator.locks.request(WRITE_LOCK, { mode: 'shared' }, f) as Promise<T>;
  }

  overlaysOf(disk: string) { return this.all('overlays').then((all) => all.filter((o) => o.disk === disk)); }
  snapshotsOf(machine: string) { return this.all('snapshots').then((all) => all.filter((s) => s.machine === machine)); }
  /** The machines that attach disk `id`. */
  machinesWith(disk: string) { return this.all('machines').then((all) => all.filter((m) => m.attachments.some((a) => a.disk === disk))); }

  /** Deletes a record only: its bytes are deleted after, by whoever owns them (a merge's worker, after its copy). */
  async forget(kind: Kind, id: string) {
    await this.records.delete(kind, id);
    this.said({ kind, id, deleted: true });
  }

  /** Deletes a snapshot: its record, then its file. */
  async deleteSnapshot(id: string) {
    const s = await this.get('snapshots', id);
    if (!s) return;
    await this.records.delete('snapshots', id);
    this.said({ kind: 'snapshots', id, deleted: true });
    await this.files.remove(snapshotPath(s.machine, id));
  }

  /** Deletes an overlay: its record, then its files. The caller has its lock (no machine has it open). */
  async deleteOverlay(id: string) {
    await this.records.delete('overlays', id);
    this.said({ kind: 'overlays', id, deleted: true });
    await this.files.remove(overlayDir(id));
  }

  /** Deletes a machine: its snapshots' records and its own, then its files (variable store, suspended copy, snapshots). Its disks and their overlays stay: they belong to the disks. */
  async deleteMachine(id: string) {
    for (const s of await this.snapshotsOf(id)) {
      await this.records.delete('snapshots', s.id);
      this.said({ kind: 'snapshots', id: s.id, deleted: true });
    }
    await this.records.delete('machines', id);
    this.said({ kind: 'machines', id, deleted: true });
    await this.files.remove(machineDir(id));
  }

  /** Deletes a base disk and its overlays (records, then files). Refused while a machine attaches it. */
  async deleteDisk(id: string) {
    const users = await this.machinesWith(id);
    if (users.length) throw new Error(`the disk is attached to ${users.map((m) => m.name).join(', ')}: detach it first`);
    for (const o of await this.overlaysOf(id)) await this.deleteOverlay(o.id);
    await this.records.delete('disks', id);
    this.said({ kind: 'disks', id, deleted: true });
    await this.files.remove(diskDir(id));
  }

  /**
   * Removes the bytes no record owns (machines.md §2): `overlays/<id>`, `disks/<id>`,
   * `machines/<id>` and `machines/<id>/snapshots/<id>` left by a crash between bytes and record
   * (or between a record's deletion and its files'). Only names that are ids (`isId`): a
   * transient machine's files are named otherwise, and kept. Waits for writers in every tab;
   * returns the paths it removed.
   */
  async sweep(): Promise<string[]> {
    const run = async () => {
      const removed: string[] = [];
      const gone = async (path: string) => { await this.files.remove(path); removed.push(path); };
      const ids = async (kind: Kind) => new Set((await this.all(kind)).map((r) => r.id));
      const [overlays, disks, machines, snapshots] = await Promise.all([ids('overlays'), ids('disks'), ids('machines'), ids('snapshots')]);
      for (const n of await this.files.list('overlays')) if (isId(n) && !overlays.has(n)) await gone(overlayDir(n));
      for (const n of await this.files.list('disks')) if (isId(n) && !disks.has(n)) await gone(diskDir(n));
      for (const n of await this.files.list('machines')) {
        if (!isId(n)) continue;
        if (!machines.has(n)) { await gone(machineDir(n)); continue; }
        for (const s of await this.files.list(`${machineDir(n)}/snapshots`)) if (isId(s) && !snapshots.has(s)) await gone(snapshotPath(n, s));
      }
      return removed;
    };
    if (typeof navigator === 'undefined' || !navigator.locks) return run();
    return navigator.locks.request(WRITE_LOCK, { mode: 'exclusive' }, run) as Promise<string[]>;
  }
}

/** Records in memory (Node, tests): structured clones in and out, as IndexedDB. */
export function memoryRecords(): Records {
  const maps = Object.fromEntries(KINDS.map((k) => [k, new Map<string, unknown>()])) as Record<Kind, Map<string, unknown>>;
  return {
    get: async (kind, id) => structuredClone(maps[kind].get(id)) as never,
    all: async (kind) => [...maps[kind].values()].map((v) => structuredClone(v)) as never,
    put: async (kind, value) => { maps[kind].set(value.id, structuredClone(value)); },
    delete: async (kind, id) => { maps[kind].delete(id); },
  };
}

/** Files in memory (Node, tests): a path → size map; `write` makes one (and its directories). */
export function memoryFiles(): Files & { write(path: string, bytes: number): void; paths(): string[] } {
  const files = new Map<string, number>();
  const under = (dir: string) => [...files.keys()].filter((p) => p.startsWith(`${dir}/`));
  return {
    write: (path, bytes) => { files.set(path, bytes); },
    paths: () => [...files.keys()].sort(),
    list: async (dir) => [...new Set(under(dir).map((p) => p.slice(dir.length + 1).split('/')[0]))],
    remove: async (path) => { files.delete(path); for (const p of under(path)) files.delete(p); },
    size: async (path) => (files.get(path) ?? 0) + under(path).reduce((n, p) => n + files.get(p)!, 0),
  };
}

/** Node's store (no IndexedDB or OPFS): one per process, as a browser's is one per origin. */
const sharedMemory = { records: memoryRecords(), files: memoryFiles() };

const DB = 'webpc';
const idb = <T>(req: IDBRequest<T>) => new Promise<T>((resolve, reject) => { req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });

/** Records in IndexedDB `webpc`: an object store per kind, keyed by `id`. */
export async function idbRecords(name = DB): Promise<Records> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const r = indexedDB.open(name, 1);
    r.onupgradeneeded = () => { for (const k of KINDS) if (!r.result.objectStoreNames.contains(k)) r.result.createObjectStore(k, { keyPath: 'id' }); };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  const store = (kind: Kind, mode: IDBTransactionMode) => db.transaction(kind, mode, { durability: 'strict' }).objectStore(kind);
  // A write resolves once its transaction is committed (durably: a record follows its bytes).
  const commit = (kind: Kind, f: (s: IDBObjectStore) => void) => new Promise<void>((resolve, reject) => {
    const s = store(kind, 'readwrite');
    f(s);
    s.transaction.oncomplete = () => resolve();
    s.transaction.onerror = s.transaction.onabort = () => reject(s.transaction.error);
  });
  return {
    get: (kind, id) => idb(store(kind, 'readonly').get(id)) as never,
    all: (kind) => idb(store(kind, 'readonly').getAll()) as never,
    put: (kind, value) => commit(kind, (s) => s.put(value)),
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
        if ((e as DOMException).name === 'NotFoundError' || (e as DOMException).name === 'TypeMismatchError') return undefined;
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
      const d = await dir(parts.slice(0, -1));
      try {
        await d?.removeEntry(parts.at(-1)!, { recursive: true });
      } catch (e) {
        if ((e as DOMException).name !== 'NotFoundError') throw e;
      }
    },
    async size(path) {
      const parts = split(path);
      const d = await dir(parts.slice(0, -1));
      if (!d) return 0;
      const name = parts.at(-1)!;
      const h = await d.getFileHandle(name).catch(() => d.getDirectoryHandle(name)).catch(() => undefined);
      return h ? sizeOf(h) : 0;
    },
  };
}
