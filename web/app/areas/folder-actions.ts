// Shared folders (docs/shares.md; web/app/page.ts's `folder*`): attaching, detaching and the list's order are saved
// at once, running or not; the page's machine takes them while it runs (web/app/folders-live.ts). A directory dropped
// on the page is a folder of this browser's, offered to the running machine.
import { msg, MsgError, t, type Msg } from '../../i18n.ts';
import { ask } from '../ask.svelte.ts';
import { createFolder, type NewFolder } from '../folders.ts';
import type { PageFolders } from '../folders-live.ts';
import type { Page } from '../page.ts';
import type { PageMachine } from '../run/page-machine.svelte.ts';
import { machinesNav } from './machines-nav.svelte.ts';
import { records } from './records.svelte.ts';
import { shares } from './shares.svelte.ts';

type FolderPage = Pick<
  Page,
  | 'folderPick'
  | 'folderCreate'
  | 'folderAttach'
  | 'folderDetach'
  | 'folderMove'
  | 'folderReadOnly'
  | 'folderAllow'
  | 'folderUseHere'
>;

export class FolderActions {
  readonly #m: PageMachine;
  readonly #folders: PageFolders;

  constructor(m: PageMachine, folders: PageFolders) {
    this.#m = m;
    this.#folders = folders;
  }

  async #create(n: NewFolder) {
    const f = await createFolder(this.#m.store, n);
    await this.#folders.refresh();
    return f;
  }
  /** A change to `machine`'s folders, then its record read again (the Home page's tabs show it once this resolves). */
  async #changed(machine: string, change: Promise<unknown>) {
    await change;
    await this.#m.rereadRecord(machine);
    await records.reread();
  }

  /** Asks the user, then takes a folder another machine has. */
  async #useHere(id: string) {
    const v = this.#folders.views().find((x) => x.id === id);
    /** A name, marked, or `or`'s words where it isn't known. */
    const named = (name: string | undefined, or: Msg) => (name ? msg('folders:folder-actions.named', { name }) : or);
    const question = msg('folders:folder-actions.inUse.confirm', {
      name: named(v?.name, msg('folders:folder-actions.inUse.folder')),
      who: named(v?.holder, msg('folders:folder-actions.inUse.otherTab')),
    });
    if (
      !(await ask.confirm(question, {
        title: t('folders:folder-actions.inUse.title'),
        ok: t('folders:folder-actions.useHere'),
      }))
    )
      return;
    if (!(await this.#folders.useHere(id)))
      throw new MsgError('folders:folder-actions.kept', {
        who: named(v?.holder, msg('folders:folder-actions.kept.thatMachine')),
      });
  }

  /** A directory dropped on the page: a folder of this browser's, offered to the running machine if the page's has shared folders. */
  async dropped(handle: FileSystemDirectoryHandle) {
    const folders = this.#folders;
    const here = !machinesNav.open && folders.running ? this.#m.stored?.record : undefined;
    if (
      here &&
      !(await ask.confirm(msg('folders:folder-actions.drop.confirm', { folder: handle.name, machine: here.name }), {
        title: t('folders:folder-actions.drop.title'),
        ok: t('folders:folder-actions.drop.ok'),
      }))
    )
      return;
    const f = await createFolder(this.#m.store, { kind: 'host', name: handle.name, handle });
    if (here) {
      await this.#changed(here.id, folders.attach(here.id, f, false));
      shares.openMenu();
    } else await folders.refresh();
  }

  /** The page's `folder*` actions. */
  page(): FolderPage {
    const folders = this.#folders;
    return {
      folderPick: async (readOnly) => {
        if (!window.showDirectoryPicker) throw new Error('no directory picker');
        const handle = await window.showDirectoryPicker({ mode: readOnly ? 'read' : 'readwrite' });
        return this.#create({ kind: 'host', name: handle.name, readOnly, handle });
      },
      folderCreate: (n) => this.#create(n),
      folderAttach: (machine, f, readOnly) => this.#changed(machine, folders.attach(machine, f, readOnly)),
      folderDetach: (machine, id) => this.#changed(machine, folders.detach(machine, id)),
      folderMove: (machine, id, by) => this.#changed(machine, folders.move(machine, id, by)),
      folderReadOnly: (machine, id, readOnly) => this.#changed(machine, folders.setReadOnly(machine, id, readOnly)),
      folderAllow: (id) => folders.allow(id),
      folderUseHere: (id) => this.#useHere(id),
    };
  }
}
