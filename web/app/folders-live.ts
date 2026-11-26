// The live side of the page's machine's shared folders (docs/shares.md): which of its attached folders the running
// device has, the folders' locks and grants. At a start every attachment is looked at: granted and free, it is served;
// otherwise the page says why and what can be done (Allow access…, Use it here), and doing it adds the folder while the
// machine runs, over the device's port (`FoldersToDevice`). The toolbar's Folders menu, the wizard and the Home
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
  replaceHandle,
  setAttachmentReadOnly,
  type Folder,
} from './folders.ts';
import { Locks } from './locks.ts';
import type { FolderAttachment, MachineRecord } from './shape.ts';
import type { Store } from './store.ts';
import { errorText } from '../i18n.ts';
import { GRANT_WAIT_MS, within } from './grants.ts';
import { browserAccess, type FolderAccess } from './folder-access.ts';

export { browserAccess, type FolderAccess };

/**
 * Why an attached folder isn't served. `permission`: the browser needs a click; `unanswered`: the browser didn't say
 * whether it's granted (web/app/grants.ts: Choose again… picks its directory anew, and a late grant brings it in); `held`: another machine has
 * it; `missing`: the record is gone (another tab deleted it); `failed`: it can't be opened (`holder` says why).
 */
export type FolderProblem = 'permission' | 'unanswered' | 'held' | 'missing' | 'failed';
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
  /** How long a host folder's grant is waited for (`GRANT_WAIT_MS`; a test's shorter). */
  private grantWaitMs: number;

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

  constructor(o: {
    store: Store;
    me: () => string;
    onChange?: () => void;
    access?: FolderAccess;
    grantWaitMs?: number;
  }) {
    [this.store, this.onChange, this.access] = [o.store, o.onChange, o.access ?? browserAccess];
    this.grantWaitMs = o.grantWaitMs ?? GRANT_WAIT_MS;
    this.locks = new Locks(o.store, 'folder', o.me, (lock) => void this.release(lock));
  }

  private async read() {
    this.#folders = (await this.store.all('folders')).sort((a, b) => a.created - b.created);
    const held = await this.locks.heldElsewhere();
    this.#held = new Set(this.#folders.filter((f) => held.has(folderLock(f.id))).map((f) => f.id));
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

  /**
   * Gets folder `a` ready to serve, or says why not: its grant (`granted`: given by the user's click already), then its
   * lock. A grant the browser doesn't answer within `grantWaitMs` leaves the folder out (`unanswered`), and its answer,
   * if it comes while the machine still runs here, brings it in.
   */
  private async take(a: FolderAttachment, granted = false) {
    const f = this.folders.find((x) => x.id === a.id);
    if (!f) return void this.problems.set(a.id, { problem: 'missing' });
    const write = !readsOnly(a, f);
    if (f.kind === 'host' && !granted) {
      const asked = this.access.query(f, write);
      const now = await within(asked, this.grantWaitMs);
      if (now === undefined) {
        this.problems.set(a.id, { problem: 'unanswered' });
        void asked.then((yes) => this.lateGrant(a.id, yes)).catch(() => undefined);
        return;
      }
      if (!now) return void this.problems.set(a.id, { problem: 'permission' });
    }
    const lock = folderLock(a.id);
    if (!(await this.locks.take(lock, { shared: !write })))
      return void this.problems.set(a.id, { problem: 'held', holder: await this.locks.holder(lock) });
    try {
      const dir = f.kind === 'host' ? f.handle : await this.access.directory(f);
      if (!dir) throw new Error(`folder ${a.id} has no handle`);
      this.served.set(a.id, dir);
      this.problems.delete(a.id);
    } catch (e) {
      this.locks.drop(lock);
      this.problems.set(a.id, { problem: 'failed', holder: errorText(e) });
    }
  }

  /** The browser's late answer on folder `id`'s grant: while it still waits for it here, it comes in (or needs a click). */
  private async lateGrant(id: string, yes: boolean) {
    const a = this.attached.find((x) => x.id === id);
    if (!a || !this.port || this.problems.get(id)?.problem !== 'unanswered') return;
    if (!yes) {
      this.problems.set(id, { problem: 'permission' });
      return this.changed();
    }
    await this.take(a, true);
    this.serve(id);
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
    await this.take(a, true);
    this.serve(id);
  }

  /**
   * The user's click on Choose again… (a folder whose grant the browser didn't answer for, where Allow access may not be
   * answered either): its directory picked again, the record given the new handle, and the folder served.
   */
  async repick(id: string) {
    const a = this.attached.find((x) => x.id === id);
    const f = this.folders.find((x) => x.id === id);
    if (!a || f?.kind !== 'host') return;
    const handle = await this.access.pick(!readsOnly(a, f));
    if (!handle || !(await replaceHandle(this.store, id, handle))) return;
    await this.refresh();
    if (this.served.has(id) || !this.port) return;
    await this.take(a, true);
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
