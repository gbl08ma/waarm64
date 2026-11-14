// The browser's machines, disks, overlays, snapshots and network connections (docs/machines.md §2,
// docs/networking/adapters.md §2): records in IndexedDB (database `waarm64`, a store per kind, keyed by `id`), bytes
// in OPFS (`overlays/<id>/`,
// `disks/<id>/`, `machines/<id>/` with its `flash`, `suspend` and `snapshots/<id>`). **A record is
// written after its bytes and deleted before them**, so a crash leaves files without a record,
// never a record without its files; `sweep` removes those at the start. Writers that make bytes
// before their record do it inside `writing`, which the sweep waits out (a Web Lock, shared by
// every tab). Other tabs hear of every change through a BroadcastChannel (`onChange`): their
// views reread. DOM-free: Node's tests run it over memory (`memoryRecords`, `memoryFiles`).
import { hasOpfs } from '../overlay.ts';
import { MsgError } from '../msg.ts';
import type { Connection } from './connections.ts';
import type { Folder } from './folders.ts';
import { idbRecords, memoryFiles, memoryRecords, opfsFiles } from './store-backends.ts';
import type { GrowMark } from './disk-size.ts';
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
  /**
   * Its own size, bytes (machines.md §4.5: a grown overlay; its meta file's, which the device worker reads): the guest
   * sees the larger of it and its disk's. Absent: none of its own.
   */
  size?: number;
  /** A grow pending in the guest (its partition and filesystem, at its next start: §4.5). */
  grow?: GrowMark;
};

/**
 * What a snapshot needs of a writable disk (machines.md §5.1; web/snapshot.ts `SnapshotDisk`): by slot, the overlay's
 * path (`overlays/<id>`, or `disks/<id>` for a disk written in place) at a generation, the blocks the file carries for
 * it, and whether it is a ramdisk (whose blocks are always in the file).
 */
export type Pin = { slot: number; overlay?: string; generation?: number; blocks: number; ram?: boolean };

/** A snapshot kept in the browser (`machines/<machine>/snapshots/<id>`, the WAARMSNP file). */
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

export type Kinds = {
  machines: MachineRecord;
  disks: DiskRecord;
  overlays: OverlayRecord;
  snapshots: SnapshotRecord;
  connections: Connection;
  folders: Folder;
};
export type Kind = keyof Kinds;

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
 * devices' and the network connections' locks ask there who holds one, and ask the holder to let it go (web/app/locks.ts).
 */
export type Note = { topic: string; [k: string]: unknown };

export const overlayDir = (id: string) => `overlays/${id}`;
export const diskDir = (id: string) => `disks/${id}`;
export const machineDir = (id: string) => `machines/${id}`;
export const folderDir = (id: string) => `folders/${id}`;
export const snapshotPath = (machine: string, id: string) => `machines/${machine}/snapshots/${id}`;
export const flashPath = (machine: string) => `machines/${machine}/flash`;
export const suspendPath = (machine: string) => `machines/${machine}/suspend`;

/** The lock writers share and the sweep takes alone (machines.md §2). */
const WRITE_LOCK = 'waarm64-store';
const CHANNEL = 'waarm64-store';

/** Node's store (no IndexedDB or OPFS): one per process, as a browser's is one per origin. */
let sharedMemory: { records: Records; files: Files } | undefined;

export class Store {
  private channel?: BroadcastChannel;
  private listeners = new Set<(c: Change) => void>();
  private notes = new Set<(n: Note) => void>();
  private writes = new Set<(c: Change) => void>();
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

  /**
   * The browser's store (IndexedDB and OPFS), or, without them (Node; Firefox's private windows, which refuse OPFS:
   * `hasOpfs`), one in memory for the process's life.
   */
  static async open(): Promise<Store> {
    if (typeof indexedDB === 'undefined' || !(await hasOpfs())) {
      sharedMemory ??= { records: memoryRecords(), files: memoryFiles() };
      return new Store(sharedMemory.records, sharedMemory.files);
    }
    return new Store(await idbRecords(), opfsFiles(await navigator.storage.getDirectory()));
  }

  /** Calls `f` with every change another tab (or another Store on the same channel) makes; returns the unsubscribe. */
  onChange(f: (c: Change) => void) {
    this.listeners.add(f);
    return () => {
      this.listeners.delete(f);
    };
  }

  /** Calls `f` with every change this Store makes (the other tabs hear of it through `onChange`); returns the unsubscribe. */
  onWrite(f: (c: Change) => void) {
    this.writes.add(f);
    return () => {
      this.writes.delete(f);
    };
  }

  /** Calls `f` with every note another tab sends (`tell`); returns the unsubscribe. */
  onNote(f: (n: Note) => void) {
    this.notes.add(f);
    return () => {
      this.notes.delete(f);
    };
  }
  /** Sends a note to the other tabs (not to this Store's own listeners). */
  tell(n: Note) {
    this.channel?.postMessage(n);
  }

  close() {
    this.channel?.close();
    this.listeners.clear();
    this.notes.clear();
    this.writes.clear();
  }

  private said(c: Change) {
    this.channel?.postMessage(c);
    for (const f of this.writes) f(c);
  }

  get<K extends Kind>(kind: K, id: string) {
    return this.records.get(kind, id);
  }
  all<K extends Kind>(kind: K) {
    return this.records.all(kind);
  }

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
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- a probe: no Web Locks in Node's tests
    if (typeof navigator === 'undefined' || !navigator.locks) return f();
    return navigator.locks.request(WRITE_LOCK, { mode: 'shared' }, f);
  }

  overlaysOf(disk: string) {
    return this.all('overlays').then((all) => all.filter((o) => o.disk === disk));
  }
  snapshotsOf(machine: string) {
    return this.all('snapshots').then((all) => all.filter((s) => s.machine === machine));
  }
  /** The machines that attach disk `id`. */
  machinesWith(disk: string) {
    return this.all('machines').then((all) => all.filter((m) => m.attachments.some((a) => a.disk === disk)));
  }

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
    if (users.length)
      throw new MsgError('machines:store.diskAttached', undefined, {
        cause: new MsgError('machines:store.diskAttached.cause', { machines: users.map((m) => m.name) }),
      });
    for (const o of await this.overlaysOf(id)) await this.deleteOverlay(o.id);
    await this.records.delete('disks', id);
    this.said({ kind: 'disks', id, deleted: true });
    await this.files.remove(diskDir(id));
  }

  /** Machine `n`'s bytes no record owns: all of them without the machine's record, else its snapshots without theirs. */
  private async sweepMachine(
    n: string,
    machines: Set<string>,
    snapshots: Set<string>,
    gone: (path: string) => Promise<void>,
  ) {
    if (!machines.has(n)) return gone(machineDir(n));
    for (const s of await this.files.list(`${machineDir(n)}/snapshots`))
      if (isId(s) && !snapshots.has(s)) await gone(snapshotPath(n, s));
  }

  /**
   * Removes the bytes no record owns (machines.md §2): `overlays/<id>`, `disks/<id>`, `folders/<id>`,
   * `machines/<id>` and `machines/<id>/snapshots/<id>` left by a crash between bytes and record
   * (or between a record's deletion and its files'). Only names that are ids (`isId`): a
   * transient machine's files are named otherwise, and kept. Waits for writers in every tab;
   * returns the paths it removed.
   */
  async sweep(): Promise<string[]> {
    const run = async () => {
      const removed: string[] = [];
      const gone = async (path: string) => {
        await this.files.remove(path);
        removed.push(path);
      };
      const ids = async (kind: Kind) => new Set((await this.all(kind)).map((r) => r.id));
      const [overlays, disks, machines, snapshots, folders] = await Promise.all([
        ids('overlays'),
        ids('disks'),
        ids('machines'),
        ids('snapshots'),
        ids('folders'),
      ]);
      for (const n of await this.files.list('folders')) if (isId(n) && !folders.has(n)) await gone(folderDir(n));
      for (const n of await this.files.list('overlays')) if (isId(n) && !overlays.has(n)) await gone(overlayDir(n));
      for (const n of await this.files.list('disks')) if (isId(n) && !disks.has(n)) await gone(diskDir(n));
      for (const n of await this.files.list('machines'))
        if (isId(n)) await this.sweepMachine(n, machines, snapshots, gone);
      return removed;
    };
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- a probe: no Web Locks in Node's tests
    if (typeof navigator === 'undefined' || !navigator.locks) return run();
    return navigator.locks.request(WRITE_LOCK, { mode: 'exclusive' }, run);
  }
}
