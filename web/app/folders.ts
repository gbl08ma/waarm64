// The browser's shared folders (docs/shares.md): a folder on the user's computer (a directory handle) or in the browser
// (a directory in OPFS, `folders/<id>/`), kept as records in IndexedDB `webpc` `folders` (web/app/store.ts). A machine has
// folders attached (`MachineRecord.folders`) and reaches them through one virtio-9p device (web/9p-folders.ts). One
// writer at a time: a running machine holds the folder's Web Lock (`folderLock`, web/app/locks.ts), shared to read,
// exclusive to write. DOM-free: Node's tests run it over a memory store.
import type { FolderSpec } from '../9p-folders.ts';
import { folderDir, type Store } from './store.ts';
import { newId, uniqueName, type FolderAttachment, type MachineRecord } from './shape.ts';

/** The most folders a machine has attached: the root is a listing, so this bounds the page's list, not a slot. */
export const MAX_FOLDERS = 16;

export type Folder = {
  id: string;
  /** The user's; a picked folder's starts as its directory's name. */
  name: string;
  kind: 'host' | 'opfs';
  /** No machine writes it, whatever its attachment says. */
  readOnly: boolean;
  /** `host`: the directory, kept so that its grant can be asked for again. */
  handle?: FileSystemDirectoryHandle;
  /** When a machine last attached it (what the wizard preselects); 0: never. */
  lastUsed: number;
  created: number;
};

export type NewFolder = Pick<Folder, 'kind' | 'name'> & { readOnly?: boolean; handle?: FileSystemDirectoryHandle };

/** The folder's Web Lock: held while a running machine has it, in any tab. */
export const folderLock = (id: string) => `webpc-folder:${id}`;

/** A machine reads an attached folder only if its attachment or the folder itself says so. */
export const readsOnly = (a: FolderAttachment, f: Folder) => a.readOnly || f.readOnly;

/** The names at the device's root, by folder id: the folders' own, made unique in the attachments' order. */
export function rootNames(attached: FolderAttachment[], folders: Folder[]): Map<string, string> {
  const names = new Map<string, string>();
  for (const a of attached) {
    const f = folders.find((x) => x.id === a.id);
    if (f) names.set(a.id, uniqueName(f.name, names.values()));
  }
  return names;
}

/** What the wizard preselects: the most recently used folder that isn't attached already. */
export function preselect(all: Folder[], attached: FolderAttachment[]): string | undefined {
  return all.filter((f) => f.lastUsed > 0 && !attached.some((a) => a.id === f.id)).sort((a, b) => b.lastUsed - a.lastUsed)[0]?.id;
}

/**
 * A new folder's record, or for a directory that has one already that one: its lock is what keeps two writers apart. One
 * in the browser gets its directory at its first use.
 */
export async function createFolder(store: Store, n: NewFolder): Promise<Folder> {
  const all = await store.all('folders');
  for (const f of all) if (f.handle && n.handle && (await f.handle.isSameEntry(n.handle))) return f;
  const taken = all.map((f) => f.name);
  const f: Folder = { id: newId(), name: uniqueName(n.name.trim() || 'Shared folder', taken), kind: n.kind, readOnly: !!n.readOnly, ...(n.handle ? { handle: n.handle } : {}), lastUsed: 0, created: Date.now() };
  await store.put('folders', f);
  return f;
}

/** Changes a folder's name or Read-only (an attached machine takes them at its next start). */
export async function editFolder(store: Store, id: string, change: Partial<Pick<Folder, 'name' | 'readOnly'>>) {
  const f = await store.get('folders', id);
  if (!f) throw new Error('that folder is gone');
  const name = change.name === undefined ? f.name : uniqueName(change.name.trim() || f.name, (await store.all('folders')).filter((x) => x.id !== id).map((x) => x.name));
  const next = { ...f, ...change, name };
  await store.put('folders', next);
  return next;
}

/** The machines a folder is attached to. */
export async function machinesWith(store: Store, id: string) {
  return (await store.all('machines')).filter((m) => m.folders?.some((a) => a.id === id));
}

const editAttachments = async (store: Store, machine: string, edit: (m: MachineRecord, list: FolderAttachment[]) => FolderAttachment[]) => {
  const m = await store.get('machines', machine);
  if (!m) throw new Error('that machine is gone');
  const list = edit(m, m.folders ?? []);
  const { folders: _, ...rest } = m;
  await store.put('machines', { ...rest, ...(list.length ? { folders: list } : {}) });
};

/** Attaches folder `id` to `machine`, at the end of its list (saved at once: it needs no restart). */
export async function attachFolder(store: Store, machine: string, id: string, readOnly: boolean) {
  await editAttachments(store, machine, (m, list) => {
    if (list.some((a) => a.id === id)) return list;
    if (list.length >= MAX_FOLDERS) throw new Error(`${m.name} has ${MAX_FOLDERS} folders, the most a machine has.`);
    return [...list, { id, readOnly }];
  });
  const f = await store.get('folders', id);
  if (f) await store.put('folders', { ...f, lastUsed: Date.now() });
}

export const detachFolder = (store: Store, machine: string, id: string) =>
  editAttachments(store, machine, (_, list) => list.filter((a) => a.id !== id));

/** An attachment's Read-only (the machine isn't running with it). */
export const setAttachmentReadOnly = (store: Store, machine: string, id: string, readOnly: boolean) =>
  editAttachments(store, machine, (_, list) => list.map((a) => (a.id === id ? { ...a, readOnly } : a)));

/** Moves an attachment `by` places in the machine's list, the root's order. */
export const moveFolder = (store: Store, machine: string, id: string, by: number) =>
  editAttachments(store, machine, (_, list) => {
    const at = list.findIndex((a) => a.id === id);
    const to = at + by;
    if (at < 0 || to < 0 || to >= list.length) return list;
    const next = [...list];
    [next[at], next[to]] = [next[to], next[at]];
    return next;
  });

/** Deletes a folder: it is detached from every machine and, in the browser, its files go. Asking first is the page's. */
export async function deleteFolder(store: Store, id: string) {
  for (const m of await machinesWith(store, id)) await detachFolder(store, m.id, id);
  await store.files.remove(folderDir(id));
  await store.forget('folders', id); // after its files: the sweep takes what a crash leaves
}

/** A machine's folders as a device gets them, for those in `present` (ids): each under its root name, read-only as its lock was taken. */
export function folderSpecs(attached: FolderAttachment[], folders: Folder[], present: Map<string, FileSystemDirectoryHandle>): FolderSpec[] {
  const names = rootNames(attached, folders);
  return attached.flatMap((a) => {
    const f = folders.find((x) => x.id === a.id);
    const handle = present.get(a.id);
    return f && handle ? [{ id: f.id, name: names.get(f.id)!, kind: f.kind, readOnly: readsOnly(a, f), handle }] : [];
  });
}
