// What the Machines modal does to machines (docs/plans/machines.md §1, §4, §7): make, copy, delete, edit, and attach,
// detach, reorder or flip disks, through web/app/store.ts. A running machine holds the Web Lock `webpc-machine:<id>`
// (the page that runs it, in any tab), and edits that need it off are refused while it's held. Nothing here asks the
// user; the modal confirms first.
import { defaultCpus } from './machine.ts';
import { generateName, MAX_DISKS, newId, uniqueName, type Attachment, type DiskIdentity, type DiskRecord, type MachineRecord } from './shape.ts';
import { machineDir, type Store } from './store.ts';

/** The lock a page holds while it runs machine `id`. */
export const machineLock = (id: string) => `webpc-machine:${id}`;

/** Whether machine `id` runs now (in this tab or another). */
export async function isRunning(id: string) {
  const held = await navigator.locks.query();
  return (held.held ?? []).some((l) => l.name === machineLock(id));
}

/** Throws a message for the user when machine `id` runs: what needs it off (§4.1: no hotplug; the DT is fixed at boot). */
export async function needsOff(id: string, what: string) {
  if (await isRunning(id)) throw new Error(`${what} needs the machine off: power it off first (it runs in this tab or another).`);
}

/** A new machine (no disks yet), named by default. */
export async function createMachine(store: Store, o: Partial<Pick<MachineRecord, 'name' | 'ncpus' | 'ramMiB' | 'display' | 'network'>> = {}) {
  const taken = (await store.all('machines')).map((m) => m.name);
  const now = Date.now();
  const m: MachineRecord = {
    id: newId(),
    name: o.name ? uniqueName(o.name, taken) : generateName(taken),
    ncpus: o.ncpus ?? defaultCpus(globalThis.navigator?.hardwareConcurrency || 4),
    ramMiB: o.ramMiB ?? 2048,
    display: o.display ?? '3d',
    network: o.network ?? true,
    attachments: [],
    created: now,
    modified: now,
  };
  await store.put('machines', m);
  return m;
}

/** A copy of machine `id`: the same settings and disks, new attachments (so new serials) with the same overlays chosen. */
export async function duplicateMachine(store: Store, id: string) {
  const m = await store.get('machines', id);
  if (!m) throw new Error('that machine is gone');
  const taken = (await store.all('machines')).map((x) => x.name);
  const now = Date.now();
  const copy: MachineRecord = { ...m, id: newId(), name: uniqueName(`${m.name} (copy)`, taken), attachments: m.attachments.map((a) => ({ ...a, id: newId() })), created: now, modified: now };
  await store.put('machines', copy);
  return copy;
}

/** Deletes machine `id` (its variable store, suspended copy and snapshots); its disks and their overlays stay. */
export async function deleteMachine(store: Store, id: string) {
  await needsOff(id, 'Deleting a machine');
  await store.deleteMachine(id);
}

/** Saves the machine's settings (name, vCPUs, RAM, display, network): the guest sees them, so it must be off. */
export async function updateMachine(store: Store, m: MachineRecord) {
  const was = await store.get('machines', m.id);
  if (!was) throw new Error('that machine is gone');
  const shape = (x: MachineRecord) => JSON.stringify([x.ncpus, x.ramMiB, x.display, x.network]);
  if (shape(was) !== shape(m)) await needsOff(m.id, 'Changing its processors, memory or devices');
  if (m.name !== was.name) m.name = uniqueName(m.name.trim() || was.name, (await store.all('machines')).filter((x) => x.id !== m.id).map((x) => x.name));
  m.modified = Date.now();
  await store.put('machines', m);
  return m;
}

/** What a new disk is: its kind and what the kind needs (a URL checked, a file's handle, a size). */
export type NewDisk =
  | { kind: 'url'; url: string; name?: string; size: number; bytes: number; etag?: string; lastModified?: string }
  | { kind: 'file'; file: File; handle?: FileSystemFileHandle; size: number }
  | { kind: 'blank' | 'ramdisk'; size: number; name?: string };

/** A disk record for `d` (a stored disk is made by `importStored` instead: its bytes first). */
export async function createDisk(store: Store, d: NewDisk): Promise<DiskRecord> {
  const id = newId();
  const now = Date.now();
  let r: DiskRecord;
  if (d.kind === 'url') {
    const u = new URL(d.url, globalThis.location?.href);
    const identity: DiskIdentity = { kind: 'url', path: u.pathname, bytes: d.bytes, ...(d.etag ? { etag: d.etag } : d.lastModified ? { lastModified: d.lastModified } : {}) };
    r = { id, kind: 'url', name: d.name ?? (u.pathname.split('/').pop() || u.hostname), size: d.size, format: u.pathname.endsWith('.iso') ? 'iso' : undefined, url: u.href, identity, created: now };
  } else if (d.kind === 'file') {
    r = { id, kind: 'file', name: d.file.name, size: d.size, handle: d.handle, identity: { kind: 'file', name: d.file.name, bytes: d.file.size, modified: d.file.lastModified }, created: now };
  } else {
    if (!Number.isSafeInteger(d.size) || d.size <= 0 || d.size % 4096) throw new Error('a size in whole 4 KiB blocks');
    r = { id, kind: d.kind, name: d.name ?? (d.kind === 'blank' ? 'Blank disk' : 'Ramdisk'), size: d.size, identity: { kind: d.kind, id, bytes: d.size }, created: now };
  }
  await store.put('disks', r);
  return r;
}

/** Attaches disk `disk` to machine `m`, last (16 at most). A blank disk is always writable; an ISO read-only unless asked. */
export async function attach(store: Store, m: MachineRecord, disk: DiskRecord, o: { readOnly?: boolean } = {}) {
  await needsOff(m.id, 'Attaching a disk');
  if (m.attachments.length >= MAX_DISKS) throw new Error(`a machine has at most ${MAX_DISKS} disks`);
  const readOnly = disk.kind === 'blank' || disk.kind === 'ramdisk' ? false : o.readOnly ?? disk.format === 'iso';
  const a: Attachment = { id: newId(), disk: disk.id, readOnly };
  m.attachments.push(a);
  m.modified = Date.now();
  await store.put('machines', m);
  return a;
}

/** Changes attachment `id` of machine `m` (read-only, in place, its place in the order) or detaches it (`detach`). */
export async function editAttachment(store: Store, m: MachineRecord, id: string, change: { readOnly?: boolean; inPlace?: boolean; move?: -1 | 1; detach?: boolean }) {
  await needsOff(m.id, 'Changing its disks');
  const i = m.attachments.findIndex((a) => a.id === id);
  if (i < 0) throw new Error('that disk is no longer attached');
  const a = m.attachments[i];
  const disk = await store.get('disks', a.disk);
  if (change.detach) m.attachments.splice(i, 1);
  if (change.readOnly !== undefined) {
    if (!change.readOnly || (disk?.kind !== 'blank' && disk?.kind !== 'ramdisk')) a.readOnly = change.readOnly;
  }
  if (change.inPlace !== undefined) {
    if (disk?.kind !== 'stored') throw new Error('only a disk stored in the browser can be written in place');
    a.inPlace = change.inPlace || undefined;
  }
  if (change.move) {
    const j = i + change.move;
    if (j >= 0 && j < m.attachments.length) [m.attachments[i], m.attachments[j]] = [m.attachments[j], m.attachments[i]];
  }
  m.modified = Date.now();
  await store.put('machines', m);
}

/** What the browser's storage holds for the modal (§2 "Storage"): the estimate, persistence, and each big item's bytes. */
export async function storageReport(store: Store) {
  const est = await navigator.storage.estimate();
  const persisted = await navigator.storage.persisted();
  const items: { what: string; bytes: number }[] = [];
  for (const d of await store.all('disks')) if (d.kind === 'stored') items.push({ what: `Stored disk ${d.name}`, bytes: await store.files.size(`disks/${d.id}`) });
  const disks = new Map((await store.all('disks')).map((d) => [d.id, d.name]));
  for (const o of await store.all('overlays')) items.push({ what: `${disks.get(o.disk) ?? 'a disk'}: ${o.name}`, bytes: await store.files.size(`overlays/${o.id}`) });
  for (const m of await store.all('machines')) items.push({ what: `${m.name}: variable store, snapshots`, bytes: await store.files.size(machineDir(m.id)) });
  items.sort((a, b) => b.bytes - a.bytes);
  return { usage: est.usage ?? 0, quota: est.quota ?? 0, persisted, items };
}

/** Asks the browser to keep this origin's storage under pressure (§2): once, the first time something is stored. */
export async function askPersist() {
  try {
    if (!(await navigator.storage.persisted())) return await navigator.storage.persist();
    return true;
  } catch {
    return false;
  }
}

/** Bytes in words. */
export const bytesText = (n: number) => (n < 1e6 ? `${Math.ceil(n / 1e3)} KB` : n < 1e9 ? `${(n / 1e6).toFixed(n < 1e7 ? 1 : 0)} MB` : `${(n / 1e9).toFixed(n < 1e10 ? 2 : 1)} GB`);
