// What the Machines page's Shared folders pane asks of the record and the live side.
import { browserAccess, type PageFolders } from './folders-live.ts';
import { deleteFolder, editFolder, folderLock, machinesWith, type Folder } from './folders.ts';
import type { Store } from './store.ts';

/** The directory of folder `f` in the browser. */
export const folderDirectory = (f: Folder) => browserAccess.directory(f);

/** The names of the machines each folder is attached to. */
export async function usersOf(store: Store, all: Folder[]) {
  return Object.fromEntries(await Promise.all(all.map(async (f) => [f.id, (await machinesWith(store, f.id)).map((m) => m.name)] as const)));
}

export async function editFolderOf(live: PageFolders, store: Store, f: Folder, change: Partial<Pick<Folder, 'name' | 'readOnly'>>) {
  await editFolder(store, f.id, change);
  await live.refresh();
}

/** Runs `f` on the folder's files under its lock (`write`: exclusively): refused while a machine has it. */
export async function withFolder<T>(id: string, write: boolean, f: () => Promise<T>) {
  return navigator.locks.request(folderLock(id), { ifAvailable: true, mode: write ? 'exclusive' : 'shared' }, async (l) => {
    if (!l) throw new Error('A machine has this folder: power it off or detach it first.');
    return f();
  }) as Promise<T>;
}

/** Deletes `f` (the caller asked), refused while a machine in another tab has it; the page's machine lets it go first. */
export async function deleteFolderOf(live: PageFolders, store: Store, f: Folder) {
  await live.refresh();
  if (live.held.has(f.id)) throw new Error(`${f.name} is in use by a machine in another tab: power it off there first.`);
  if (live.mine(f.id)) await live.forget(f.id);
  await deleteFolder(store, f.id);
  await live.refresh();
}
