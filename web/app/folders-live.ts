// The live side of the page's machine's shared folders (docs/shares.md): which of its attached folders the running
// device has, the folders' locks and grants. At a start every attachment is looked at: granted and free, it is served;
// otherwise the page says why and what can be done (Allow access…, Use it here), and doing it adds the folder while the
// machine runs, over the device's port (`FoldersToDevice`). The toolbar's Folders menu, the wizard and the Machines
// page's tab drive it; web/app/run/runner.ts hands it each start's record. DOM-free but for what `FolderAccess` wraps:
// tests/folders.test.ts runs it over a memory store.
import type { FolderSpec, FoldersFromDevice, FoldersToDevice } from '../9p-folders.ts';
import { Changes } from './changes.ts';
import { MsgError } from '../msg.ts';
import {
  attachFolder,
  detachFolder,
  folderLock,
  folderSpecs,
  moveFolder,
  readsOnly,
  setAttachmentReadOnly,
  type Folder,
} from './folders.ts';
import { heldLocks, Locks } from './locks.ts';
import type { FolderAttachment, MachineRecord } from './shape.ts';
import type { Store } from './store.ts';
import { errorText } from '../i18n.ts';

/**
 * Why an attached folder isn't served. `permission`: the browser needs a click; `held`: another machine has it;
 * `missing`: the record is gone (another tab deleted it); `failed`: it can't be opened (`holder` says why).
 */
export type FolderProblem = 'permission' | 'held' | 'missing' | 'failed';
export type FolderView = {
  id: string;
  /** Its name at the device's root. */
  name: string;
  folder?: Folder;
  readOnly: boolean;
  problem?: FolderProblem;
  /** The machine that has it (`held`), when its tab answered; why it can't be opened (`failed`). */
  holder?: string;
};

/** What the browser's API is asked; a test's fake in Node. */
export type FolderAccess = {
  /** The directory of a folder in the browser. */
  directory(f: Folder): Promise<FileSystemDirectoryHandle>;
  /** Whether the browser grants a host folder now. */
  query(f: Folder, write: boolean): Promise<boolean>;
  /** Asks the user (from a click). */
  request(f: Folder, write: boolean): Promise<boolean>;
};

type Writable = FileSystemDirectoryHandle & {
  queryPermission(o: object): Promise<string>;
  requestPermission(o: object): Promise<string>;
};
/** The page's: OPFS's `folders/<id>/`, and File System Access's permissions. */
export const browserAccess: FolderAccess = {
  async directory(f) {
    const top = await (await navigator.storage.getDirectory()).getDirectoryHandle('folders', { create: true });
    return top.getDirectoryHandle(f.id, { create: true });
  },
  async query(f, write) {
    return (await (f.handle as Writable).queryPermission({ mode: write ? 'readwrite' : 'read' })) === 'granted';
  },
  async request(f, write) {
    return (await (f.handle as Writable).requestPermission({ mode: write ? 'readwrite' : 'read' })) === 'granted';
  },
};

/** How long a device gets to say it let go of a folder (a dead one never will), ms. */
const LET_GO_MS = 5000;

export class PageFolders {
  readonly locks: Locks;
  private store: Store;
  private access: FolderAccess;
  private onChange?: () => void;
  /** What the page shows of it changed (web/app/changes.ts): its reads below track it. */
  readonly #changes = new Changes();
  #folders: Folder[] = [];
  #held = new Set<string>();
  /** The page's machine, while it runs with shared folders. */
  private machine?: string;
  private port?: MessagePort;
  private attached: FolderAttachment[] = [];
  /** What the device has, by folder id. */
  private served = new Map<string, FileSystemDirectoryHandle>();
  private problems = new Map<string, { problem: FolderProblem; holder?: string }>();
  /** The names the device has them under. */
  private names = new Map<string, string>();
  /** Who waits for the device to let go of a folder, by id. */
  private letting = new Map<string, () => void>();
  /** The last refresh: they run one at a time. */
  private refreshing: Promise<void> = Promise.resolve();

  /** All of the browser's folders, as last read. */
  get folders(): Folder[] {
    this.#changes.track();
    return this.#folders;
  }
  /** The folders other machines hold now, by id. */
  get held(): Set<string> {
    this.#changes.track();
    return this.#held;
  }

  constructor(o: { store: Store; me: () => string; onChange?: () => void; access?: FolderAccess }) {
    [this.store, this.onChange, this.access] = [o.store, o.onChange, o.access ?? browserAccess];
    this.locks = new Locks(o.store, 'folder', o.me, (lock) => void this.release(lock));
  }

  private async read() {
    this.#folders = (await this.store.all('folders')).sort((a, b) => a.created - b.created);
    const held = await heldLocks();
    this.#held = new Set(
      this.#folders.filter((f) => held.has(folderLock(f.id)) && !this.locks.mine(folderLock(f.id))).map((f) => f.id),
    );
  }

  /**
   * Reads the browser's folders again and who holds them; a running machine follows what its record says now, whichever
   * tab changed it.
   */
  refresh(): Promise<void> {
    const done = this.refreshing.then(async () => {
      await this.read();
      await this.follow();
      this.changed();
    });
    this.refreshing = done.catch(() => undefined); // what waits for the refresh; its failure goes to its caller
    return done;
  }

  private async follow() {
    if (!this.machine) return;
    const now = (await this.store.get('machines', this.machine))?.folders ?? [];
    const gone = this.attached.filter((a) => !now.some((x) => x.id === a.id));
    const added = now.filter((a) => !this.attached.some((x) => x.id === a.id));
    this.attached = now;
    for (const a of gone) {
      this.problems.delete(a.id);
      await this.letGo(a.id);
    }
    for (const a of added) {
      await this.take(a);
      this.serve(a.id);
    }
  }

  /** Something the page shows changed. */
  private changed() {
    this.#changes.notify();
    this.onChange?.();
  }

  /** Whether the page's machine runs with this device. */
  get running() {
    this.#changes.track();
    return !!this.port;
  }

  /** A start: what the device serves, of `m`'s attachments (the rest wait on the page). */
  async begin(m: MachineRecord, port: MessagePort): Promise<FolderSpec[]> {
    await this.refreshing;
    await this.read();
    this.machine = m.id;
    this.port = port;
    this.attached = m.folders ?? [];
    this.served.clear();
    this.problems.clear();
    port.onmessage = (e: MessageEvent<FoldersFromDevice>) => {
      if (e.data.type === 'denied') this.denied(e.data.id);
      else this.letting.get(e.data.id)?.();
    };
    for (const a of this.attached) await this.take(a);
    this.changed();
    const specs = folderSpecs(this.attached, this.folders, this.served);
    this.names = new Map(specs.map((f) => [f.id, f.name]));
    return specs;
  }

  /** The machine stopped: the folders go back. */
  end() {
    this.port?.close();
    this.port = this.machine = undefined;
    this.attached = [];
    this.served.clear();
    this.problems.clear();
    this.names.clear();
    for (const done of this.letting.values()) done();
    this.locks.dropAll();
    this.changed();
  }

  /** Gets folder `a` ready to serve, or says why not: its grant, then its lock. */
  private async take(a: FolderAttachment) {
    const f = this.folders.find((x) => x.id === a.id);
    if (!f) return void this.problems.set(a.id, { problem: 'missing' });
    const write = !readsOnly(a, f);
    if (f.kind === 'host' && !(await this.access.query(f, write)))
      return void this.problems.set(a.id, { problem: 'permission' });
    const lock = folderLock(a.id);
    if (!(await this.locks.take(lock, { shared: !write })))
      return void this.problems.set(a.id, { problem: 'held', holder: await this.locks.holder(lock) });
    try {
      this.served.set(a.id, f.kind === 'host' ? f.handle! : await this.access.directory(f));
      this.problems.delete(a.id);
    } catch (e) {
      this.locks.drop(lock);
      this.problems.set(a.id, { problem: 'failed', holder: errorText(e) });
    }
  }

  private tell(m: FoldersToDevice) {
    this.port?.postMessage(m);
  }

  /** Hands the device folder `id`, if it got ready. */
  private serve(id: string) {
    const spec = folderSpecs(this.attached, this.folders, this.served).find((s) => s.id === id);
    if (spec) {
      this.names.set(id, spec.name);
      this.tell({ type: 'attach', folder: spec });
    }
    this.changed();
  }

  /** Attaches folder `f` to machine `machine` (the page's: at once, while it runs). */
  async attach(machine: string, f: Folder, readOnly: boolean) {
    await attachFolder(this.store, machine, f.id, readOnly);
    await this.refresh();
  }

  async detach(machine: string, id: string) {
    await detachFolder(this.store, machine, id);
    await this.refresh();
  }

  /** The device gives folder `id` up: its lock goes once what it wrote landed, and no writer can come between. */
  private async letGo(id: string) {
    if (this.served.delete(id)) {
      this.names.delete(id);
      this.tell({ type: 'detach', id });
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, LET_GO_MS);
        this.letting.set(id, () => {
          clearTimeout(t);
          resolve();
        });
      });
      this.letting.delete(id);
    }
    this.locks.drop(folderLock(id));
  }

  async move(machine: string, id: string, by: number) {
    await moveFolder(this.store, machine, id, by);
    await this.refresh();
  }

  async setReadOnly(machine: string, id: string, readOnly: boolean) {
    if (machine === this.machine && this.served.has(id)) throw new MsgError('folders:folders-live.detachFirst');
    await setAttachmentReadOnly(this.store, machine, id, readOnly);
    await this.refresh();
    if (machine === this.machine) this.attached = this.attached.map((a) => (a.id === id ? { ...a, readOnly } : a));
  }

  /** The user's click on Allow access: the grant, then the folder is served (or it was only lost: the device goes on). */
  async allow(id: string) {
    const a = this.attached.find((x) => x.id === id);
    const f = this.folders.find((x) => x.id === id);
    if (!a || !f) return;
    if (!(await this.access.request(f, !readsOnly(a, f)))) return;
    if (this.served.has(id)) {
      this.problems.delete(id);
      this.tell({ type: 'granted', id });
      return this.changed();
    }
    await this.take(a);
    this.serve(id);
  }

  /** Takes a folder another machine has, after the page asked the user. False if it isn't let go. */
  async useHere(id: string) {
    const a = this.attached.find((x) => x.id === id);
    const f = this.folders.find((x) => x.id === id);
    if (!a || !f || !(await this.locks.takeFrom(folderLock(id), { shared: readsOnly(a, f) }))) return false;
    await this.take(a);
    this.serve(id);
    return true;
  }

  /** The folder is being deleted: the machine lets go of it. */
  async forget(id: string) {
    this.attached = this.attached.filter((a) => a.id !== id);
    this.problems.delete(id);
    await this.letGo(id);
  }

  /** The device says a grant was lost. */
  private denied(id: string) {
    this.problems.set(id, { problem: 'permission' });
    this.changed();
  }

  /** Another tab asks for what this machine holds. */
  private async release(lock: string) {
    const id = lock.slice(folderLock('').length);
    await this.letGo(id);
    this.problems.set(id, { problem: 'held', holder: await this.locks.holder(lock, 1000) });
    this.changed();
  }

  /** The page's machine's folders as the menu and the tab show them. */
  views(): FolderView[] {
    this.#changes.track();
    return this.attached.map((a) => {
      const folder = this.folders.find((f) => f.id === a.id);
      return {
        id: a.id,
        name: this.names.get(a.id) ?? folder?.name ?? a.id,
        folder,
        readOnly: folder ? readsOnly(a, folder) : a.readOnly,
        ...this.problems.get(a.id),
      };
    });
  }

  /** Whether `id` is what the page's machine has. */
  mine(id: string) {
    this.#changes.track();
    return this.served.has(id);
  }

  close() {
    this.locks.close();
  }
}
