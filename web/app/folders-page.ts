// What the Machines page's Shared folders pane asks of the record and the live side.
import { browserAccess, type PageFolders } from './folders-live.ts';
import { deleteFolder, editFolder, machinesWith, type Folder } from './folders.ts';
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

/** Deletes `f` (the caller asked): a machine here that has it lets it go first. */
export async function deleteFolderOf(live: PageFolders, store: Store, f: Folder) {
  if (live.mine(f.id)) await live.forget(f.id);
  await deleteFolder(store, f.id);
  await live.refresh();
}
