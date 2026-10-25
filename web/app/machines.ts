// What the Machines page does to machines (docs/plans/machines.md §1, §4, §7): make, copy, delete, edit, and attach,
// detach, reorder or flip disks, through web/app/store.ts. A running machine holds the Web Lock `webpc-machine:<id>`
// (the page that runs it, in any tab), and edits that need it off are refused while it's held. Nothing here asks the
// user; the Machines page confirms first.
import { cacheBytes } from '../diskcache.ts';
import { FOLLOW_BROWSER } from './keyboard.ts';
import { defaultCpus } from './machine.ts';
import { adaptersOf, canonical, DEFAULT_MAC, generateName, MAX_ADAPTERS, MAX_DISKS, newId, newMac, uniqueName, type Attachment, type DiskIdentity, type DiskRecord, type MachineRecord } from './shape.ts';
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
export async function createMachine(store: Store, o: Partial<Pick<MachineRecord, 'name' | 'ncpus' | 'ramMiB' | 'display' | 'network' | 'usb' | 'mouse' | 'touch' | 'clock' | 'keyboard'>> = {}) {
  const taken = (await store.all('machines')).map((m) => m.name);
  const now = Date.now();
  const m: MachineRecord = {
    id: newId(),
    name: o.name ? uniqueName(o.name, taken) : generateName(taken),
    ncpus: o.ncpus ?? defaultCpus(globalThis.navigator?.hardwareConcurrency || 4),
    ramMiB: o.ramMiB ?? 2048,
    display: o.display ?? '3d',
    adapters: (o.network ?? true) ? [{ id: newId(), mac: DEFAULT_MAC }] : [],
    usb: o.usb ?? true,
    mouse: o.mouse ?? true,
    touch: o.touch ?? true,
    clock: o.clock ?? true,
    keyboard: o.keyboard ?? FOLLOW_BROWSER,
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
  const copy: MachineRecord = { ...m, id: newId(), name: uniqueName(`${m.name} (copy)`, taken), attachments: m.attachments.map((a) => ({ ...a, id: newId() })), adapters: adaptersOf(m).map((a) => ({ id: newId(), mac: a.mac })), network: undefined, ...(m.usbDevices ? { usbDevices: m.usbDevices.map((u) => ({ ...u, id: newId() })) } : {}), created: now, modified: now };
  await store.put('machines', copy);
  return copy;
}

/** `m` with one more network adapter (a new MAC, no connection), or as it is at `MAX_ADAPTERS`. The machine must be off to save it. */
export function withAdapter(m: MachineRecord): MachineRecord {
  const have = adaptersOf(m);
  if (have.length >= MAX_ADAPTERS) return m;
  return { ...m, network: undefined, adapters: [...have, { id: newId(), mac: have.length ? newMac(have.map((a) => a.mac)) : DEFAULT_MAC }] };
}

/** `m` without adapter `id`. */
export function withoutAdapter(m: MachineRecord, id: string): MachineRecord {
  return { ...m, network: undefined, adapters: adaptersOf(m).filter((a) => a.id !== id) };
}

/**
 * Machine `id` with connection `connection` (undefined: none) attached to its adapter `index` (docs/network-adapters.md
 * §3.1): saved now, also while it runs (a connection isn't in the shape). A machine made before adapters gets its card as
 * an adapter (the same MAC: the shape stays).
 */
export async function setAdapterConnection(store: Store, id: string, index: number, connection: string | undefined) {
  const m = await store.get('machines', id);
  if (!m) throw new Error('that machine is gone');
  const adapters = adaptersOf(m).map((a) => ({ ...a }));
  if (!adapters[index]) throw new Error(`${m.name} has no adapter ${index + 1}`);
  if (connection) adapters[index].connection = connection;
  else delete adapters[index].connection;
  await store.put('machines', { ...m, network: undefined, adapters });
}

/** Takes connection `connection` off every machine that has it attached (it was deleted). */
export async function detachEverywhere(store: Store, connection: string) {
  for (const m of await store.all('machines')) {
    if (!m.adapters?.some((a) => a.connection === connection)) continue;
    await store.put('machines', { ...m, adapters: m.adapters.map(({ connection: c, ...a }) => (c && c !== connection ? { ...a, connection: c } : a)) });
  }
}

/** Deletes machine `id` (its variable store, suspended copy and snapshots); its disks and their overlays stay. */
export async function deleteMachine(store: Store, id: string) {
  await needsOff(id, 'Deleting a machine');
  await store.deleteMachine(id);
}

/** Saves the machine's settings (name, vCPUs, RAM, the JIT's budget, display, network, the USB controller, the mouse, the touchscreen, the clock device): they're set at its start, so it must be off. */
export async function updateMachine(store: Store, m: MachineRecord) {
  const was = await store.get('machines', m.id);
  if (!was) throw new Error('that machine is gone');
  // What takes a restart: the shape, and the JIT's budget (set when the machine starts; not the guest's).
  const shape = (x: MachineRecord) => JSON.stringify([x.ncpus, x.ramMiB, x.ramSplit ?? null, x.display, adaptersOf(x).map((a) => a.mac), !!x.usb, !!x.mouse, !!x.touch, !!x.clock, x.jitMiB ?? 0]);
  if (shape(was) !== shape(m)) await needsOff(m.id, 'Changing its processors, memory or devices');
  // The remembered USB devices are the USB tab's (web/app/usb-ports.ts), edited while the machine runs: a settings draft doesn't carry them.
  m.usbDevices = was.usbDevices;
  // So are the adapters' connections (the Network tab attaches them while the machine runs, web/app/net-live.ts).
  const attached = new Map(adaptersOf(was).map((a) => [a.id, a.connection]));
  if (m.adapters || was.adapters) {
    m.adapters = adaptersOf(m).map(({ connection: _, ...a }) => (attached.get(a.id) ? { ...a, connection: attached.get(a.id) } : a));
    m.network = undefined;
  }
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

/** A file's or URL's identity (machines.md §3.1): what makes it the same disk when it's added again. */
function identityFor(d: NewDisk & { kind: 'url' | 'file' }): DiskIdentity {
  if (d.kind === 'file') return { kind: 'file', name: d.file.name, bytes: d.file.size, modified: d.file.lastModified };
  const u = new URL(d.url, globalThis.location?.href);
  return { kind: 'url', path: u.pathname, bytes: d.bytes, ...(d.etag ? { etag: d.etag } : d.lastModified ? { lastModified: d.lastModified } : {}) };
}

/**
 * The disk record the browser already has for a file or URL (the same identity), so that one added again (or opened,
 * or dropped) is the same disk, with its overlays; undefined for one it doesn't have, and for blank disks and ramdisks
 * (each is a disk of its own).
 */
export async function knownDisk(store: Store, d: NewDisk): Promise<DiskRecord | undefined> {
  if (d.kind !== 'url' && d.kind !== 'file') return undefined;
  const want = canonical(identityFor(d));
  return (await store.all('disks')).find((x) => x.kind === d.kind && canonical(x.identity) === want);
}

/** A disk record for `d` (a stored disk is made by `importStored` instead: its bytes first). */
export async function createDisk(store: Store, d: NewDisk): Promise<DiskRecord> {
  const id = newId();
  const now = Date.now();
  let r: DiskRecord;
  if (d.kind === 'url') {
    const u = new URL(d.url, globalThis.location?.href);
    r = { id, kind: 'url', name: d.name ?? (u.pathname.split('/').pop() || u.hostname), size: d.size, format: u.pathname.endsWith('.iso') ? 'iso' : undefined, url: u.href, identity: identityFor(d), created: now };
  } else if (d.kind === 'file') {
    r = { id, kind: 'file', name: d.file.name, size: d.size, handle: d.handle, identity: identityFor(d), created: now };
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

/** What the browser's storage holds for the Machines page (§2 "Storage"): the estimate, persistence, and each big item's bytes. */
export async function storageReport(store: Store) {
  const est = await navigator.storage.estimate();
  const persisted = await navigator.storage.persisted();
  const items: { what: string; bytes: number }[] = [];
  for (const d of await store.all('disks')) if (d.kind === 'stored') items.push({ what: `Stored disk ${d.name}`, bytes: await store.files.size(`disks/${d.id}`) });
  const disks = new Map((await store.all('disks')).map((d) => [d.id, d.name]));
  for (const o of await store.all('overlays')) items.push({ what: `${disks.get(o.disk) ?? 'a disk'}: ${o.name}`, bytes: await store.files.size(`overlays/${o.id}`) });
  for (const m of await store.all('machines')) items.push({ what: `${m.name}: variable store, snapshots`, bytes: await store.files.size(machineDir(m.id)) });
  const remote = await cacheBytes();
  items.push({ what: "Remote disks' blocks, kept to read them again without the network", bytes: remote });
  items.sort((a, b) => b.bytes - a.bytes);
  return { usage: est.usage ?? 0, quota: est.quota ?? 0, persisted, items, remote };
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
export { bytesText } from './bytes.ts';
