// What the page's shared folders ask of the browser (docs/shares.md §1, §2): a folder in the browser's directory in
// OPFS, and a host folder's grant (asked, requested from a click) and its directory picked again. web/app/folders-live.ts
// takes it as `FolderAccess`; Node's tests give a fake.
import type { Folder } from './folders.ts';

/** What the browser's API is asked; a test's fake in Node. */
export type FolderAccess = {
  /** The directory of a folder in the browser. */
  directory(f: Folder): Promise<FileSystemDirectoryHandle>;
  /** Whether the browser grants a host folder now (it may never say: `PageFolders` bounds the wait). */
  query(f: Folder, write: boolean): Promise<boolean>;
  /** Asks the user (from a click). */
  request(f: Folder, write: boolean): Promise<boolean>;
  /** The browser's directory picker (from a click): the directory chosen, granted for `write`; undefined if cancelled. */
  pick(write: boolean): Promise<FileSystemDirectoryHandle | undefined>;
};

type Writable = FileSystemDirectoryHandle & {
  queryPermission(o: object): Promise<PermissionState>;
  requestPermission(o: object): Promise<PermissionState>;
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
  async pick(write) {
    if (!window.showDirectoryPicker) throw new Error('no directory picker');
    try {
      return await window.showDirectoryPicker({ mode: write ? 'readwrite' : 'read' });
    } catch (e) {
      if ((e as DOMException).name === 'AbortError') return undefined; // cancelled
      throw e;
    }
  },
};
