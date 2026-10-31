// The live side of the page's machine's shared folders (docs/shares.md): which of its attached folders the running
// device has, the folders' locks and grants. At a start every attachment is looked at: granted and free, it is served;
// otherwise the page says why and what can be done (Allow access…, Use it here), and doing it adds the folder while the
// machine runs, over the device's port (`FoldersToDevice`). The toolbar's Folders menu, the wizard and the Machines
// page's tab drive it; web/app/main.ts hands it each start's record. DOM-free but for what `FolderAccess` wraps:
// tests/folders.test.ts runs it over a memory store.
import type { FolderSpec, FoldersFromDevice, FoldersToDevice } from '../9p-folders.ts';
import { attachFolder, detachFolder, folderLock, folderSpecs, moveFolder, readsOnly, rootNames, setAttachmentReadOnly, type Folder } from './folders.ts';
import { heldLocks, Locks } from './locks.ts';
import type { FolderAttachment, MachineRecord } from './shape.ts';
import type { Store } from './store.ts';

/**
 * Why an attached folder isn't served. `permission`: the browser needs a click; `held`: another machine has it;
 * `missing`: the record is gone (another tab deleted it).
 */
export type FolderProblem = 'permission' | 'held' | 'missing';
export type FolderView = {
  id: string;
  /** Its name at the device's root. */
  name: string;
  folder?: Folder;
  readOnly: boolean;
  problem?: FolderProblem;
  /** The machine that has it (`held`), when its tab answered. */
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

type Writable = FileSystemDirectoryHandle & { queryPermission(o: object): Promise<string>; requestPermission(o: object): Promise<string> };
/** The page's: OPFS's `folders/<id>/`, and File System Access's permissions. */
export const browserAccess: FolderAccess = {
  async directory(f) {
    const top = await (await navigator.storage.getDirectory()).getDirectoryHandle('folders', { create: true });
    return top.getDirectoryHandle(f.id, { create: true });
  },
  async query(f, write) { return (await (f.handle as Writable).queryPermission({ mode: write ? 'readwrite' : 'read' })) === 'granted'; },
  async request(f, write) { return (await (f.handle as Writable).requestPermission({ mode: write ? 'readwrite' : 'read' })) === 'granted'; },
};

export class PageFolders {
  readonly locks: Locks;
  private store: Store;
  private access: FolderAccess;
  private onChange: () => void;
  /** All of the browser's folders, as last read. */
  folders: Folder[] = [];
  /** The folders other machines hold now, by id. */
  held = new Set<string>();
  /** The page's machine, while it runs with shared folders. */
  private machine?: string;
  private port?: MessagePort;
  private attached: FolderAttachment[] = [];
  /** What the device has, by folder id. */
  private served = new Map<string, FileSystemDirectoryHandle>();
  private problems = new Map<string, { problem: FolderProblem; holder?: string }>();

  constructor(o: { store: Store; me: () => string; onChange: () => void; access?: FolderAccess }) {
    [this.store, this.onChange, this.access] = [o.store, o.onChange, o.access ?? browserAccess];
    this.locks = new Locks(o.store, 'folder', o.me, (lock) => void this.release(lock));
  }

  /** Reads the browser's folders again, and who holds them. */
  async refresh() {
    this.folders = (await this.store.all('folders')).sort((a, b) => a.created - b.created);
    const held = await heldLocks();
    this.held = new Set(this.folders.filter((f) => held.has(folderLock(f.id)) && !this.locks.mine(folderLock(f.id))).map((f) => f.id));
    this.onChange();
  }

  /** Whether the page's machine runs with this device. */
  get running() { return !!this.port; }

  /** A start: what the device serves, of `m`'s attachments (the rest wait on the page). */
  async begin(m: MachineRecord, port: MessagePort): Promise<FolderSpec[]> {
    await this.refresh();
    this.machine = m.id;
    this.port = port;
    this.attached = m.folders ?? [];
    this.served.clear();
    this.problems.clear();
    port.onmessage = (e: MessageEvent<FoldersFromDevice>) => {
      if (e.data.type === 'denied') void this.denied(e.data.id);
    };
    for (const a of this.attached) await this.take(a);
    this.onChange();
    return folderSpecs(this.attached, this.folders, this.served);
  }

  /** The machine stopped: the folders go back. */
  end() {
    this.port?.close();
    this.port = this.machine = undefined;
    this.attached = [];
    this.served.clear();
    this.problems.clear();
    this.locks.dropAll();
    this.onChange();
  }

  /** Gets folder `a` ready to serve, or says why not: its grant, then its lock. */
  private async take(a: FolderAttachment) {
    const f = this.folders.find((x) => x.id === a.id);
    if (!f) return void this.problems.set(a.id, { problem: 'missing' });
    const write = !readsOnly(a, f);
    if (f.kind === 'host' && !(await this.access.query(f, write))) return void this.problems.set(a.id, { problem: 'permission' });
    const lock = folderLock(a.id);
    if (!(await this.locks.take(lock, { shared: !write }))) return void this.problems.set(a.id, { problem: 'held', holder: await this.locks.holder(lock) });
    this.problems.delete(a.id);
    this.served.set(a.id, f.kind === 'host' ? f.handle! : await this.access.directory(f));
  }

  private tell(m: FoldersToDevice) { this.port?.postMessage(m); }

  /** Hands the device folder `id`, if it got ready. */
  private serve(id: string) {
    const spec = folderSpecs(this.attached, this.folders, this.served).find((s) => s.id === id);
    if (spec) this.tell({ type: 'attach', folder: spec });
    this.onChange();
  }

  /** Attaches folder `f` to machine `machine` (the page's: at once, while it runs). */
  async attach(machine: string, f: Folder, readOnly: boolean) {
    await attachFolder(this.store, machine, f.id, readOnly);
    await this.refresh();
    if (machine !== this.machine || this.attached.some((a) => a.id === f.id)) return;
    const a = { id: f.id, readOnly };
    this.attached = [...this.attached, a];
    await this.take(a);
    this.serve(f.id);
  }

  async detach(machine: string, id: string) {
    await detachFolder(this.store, machine, id);
    if (machine === this.machine) {
      this.attached = this.attached.filter((a) => a.id !== id);
      this.letGo(id);
      this.problems.delete(id);
    }
    await this.refresh();
  }

  private letGo(id: string) {
    if (this.served.delete(id)) this.tell({ type: 'detach', id });
    this.locks.drop(folderLock(id));
  }

  async move(machine: string, id: string, by: number) {
    await moveFolder(this.store, machine, id, by);
    await this.refresh();
  }

  async setReadOnly(machine: string, id: string, readOnly: boolean) {
    if (machine === this.machine && this.served.has(id)) throw new Error('Detach it first: the machine has it now.');
    await setAttachmentReadOnly(this.store, machine, id, readOnly);
    await this.refresh();
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
      return this.onChange();
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
    this.letGo(id);
  }

  /** The device says a grant was lost. */
  private async denied(id: string) {
    this.problems.set(id, { problem: 'permission' });
    this.onChange();
  }

  /** Another tab asks for what this machine holds. */
  private async release(lock: string) {
    const id = lock.slice(folderLock('').length);
    this.letGo(id);
    this.problems.set(id, { problem: 'held', holder: await this.locks.holder(lock, 1000) });
    this.onChange();
  }

  /** The page's machine's folders as the menu and the tab show them. */
  views(): FolderView[] {
    const names = rootNames(this.attached, this.folders);
    return this.attached.map((a) => {
      const folder = this.folders.find((f) => f.id === a.id);
      return { id: a.id, name: names.get(a.id) ?? a.id, folder, readOnly: folder ? readsOnly(a, folder) : a.readOnly, ...this.problems.get(a.id) };
    });
  }

  /** Whether `id` is what the page's machine has. */
  mine(id: string) { return this.served.has(id); }

  close() { this.locks.close(); }
}
