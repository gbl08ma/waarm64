// What the Home page does to machines (docs/machines.md §1, §4, §7): make, copy, delete, edit, and attach,
// detach, reorder or flip disks, through web/app/store.ts. A running machine holds the Web Lock `waarm64-machine:<id>`
// (the page that runs it, in any tab), and edits that need it off are refused while it's held. Nothing here asks the
// user; the Home page confirms first.
import { t } from '../i18n.ts';
import { MsgError } from '../msg.ts';
import { FOLLOW_BROWSER } from './keyboard.ts';
import { defaultCpus } from './machine.ts';
import {
  adaptersOf,
  canonical,
  generateName,
  MAX_ADAPTERS,
  newId,
  newMac,
  uniqueName,
  type Attachment,
  type DiskIdentity,
  type DiskRecord,
  type MachineRecord,
} from './shape.ts';
import type { Store } from './store.ts';

/** The lock a page holds while it runs machine `id`. */
export const machineLock = (id: string) => `waarm64-machine:${id}`;

/** Whether machine `id` runs now (in this tab or another). */
export async function isRunning(id: string) {
  const held = await navigator.locks.query();
  return (held.held ?? []).some((l) => l.name === machineLock(id));
}

/** The edits that need a machine off, each with its words (`needsOff`): the error's headline and its cause. */
const NEEDS_OFF = {
  delete: ['machines:machines.needsOff.delete', 'machines:machines.needsOff.delete.cause'],
  shape: ['machines:machines.needsOff.shape', 'machines:machines.needsOff.shape.cause'],
  attach: ['machines:machines.needsOff.attach', 'machines:machines.needsOff.running'],
  disks: ['machines:machines.needsOff.disks', 'machines:machines.needsOff.running'],
} as const;

/** Throws a message for the user when machine `id` runs: what needs it off (§4.1: no hotplug; the DT is fixed at boot). */
export async function needsOff(id: string, what: keyof typeof NEEDS_OFF) {
  if (await isRunning(id)) {
    const [headline, cause] = NEEDS_OFF[what];
    throw new MsgError(headline, undefined, { cause: new MsgError(cause) });
  }
}

/** The error of an edit to a machine that another tab deleted meanwhile. */
export const gone = () =>
  new MsgError('machines:machines.machineGone', undefined, {
    cause: new MsgError('machines:machines.machineGone.cause'),
  });

/** This computer's cores (4 where the browser doesn't say). */
// eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- a probe: no navigator in Node's tests
const hostCpus = () => globalThis.navigator?.hardwareConcurrency || 4;

/** A new machine (no disks yet), named by default. */
export async function createMachine(
  store: Store,
  o: Partial<
    Pick<
      MachineRecord,
      'name' | 'ncpus' | 'ramMiB' | 'display' | 'network' | 'usb' | 'mouse' | 'touch' | 'clock' | 'shares' | 'keyboard'
    >
  > = {},
) {
  const taken = (await store.all('machines')).map((m) => m.name);
  const now = Date.now();
  const m: MachineRecord = {
    id: newId(),
    name: o.name ? uniqueName(o.name, taken) : generateName(taken),
    ncpus: o.ncpus ?? defaultCpus(hostCpus()),
    ramMiB: o.ramMiB ?? 2048,
    display: o.display ?? '3d',
    adapters: (o.network ?? true) ? [{ id: newId(), mac: newMac() }] : [], // a MAC of its own: machines share LANs (a local helper's)
    usb: o.usb ?? true,
    mouse: o.mouse ?? true,
    touch: o.touch ?? true,
    clock: o.clock ?? true,
    shares: o.shares ?? true,
    keyboard: o.keyboard ?? FOLLOW_BROWSER,
    attachments: [],
    created: now,
    modified: now,
  };
  await store.put('machines', m);
  return m;
}

/**
 * A copy of machine `id`: the same settings and disks, new attachments (so new serials) with the same overlays chosen.
 * Of a machine whose restore hasn't loaded, the overlays its undo puts it back on (docs/machines.md §5.2 "Other
 * machines"): a restore's fork, made or attached again, is its machine's to undo, and a copy on it would run on what
 * that undo leaves; none where that overlay was deleted since (as the undo: its next start makes an empty one).
 */
export async function duplicateMachine(store: Store, id: string) {
  const m = await store.get('machines', id);
  if (!m) throw gone();
  const taken = (await store.all('machines')).map((x) => x.name);
  const now = Date.now();
  const deleted = new Set<string>();
  for (const s of m.restoring ?? [])
    if (s.how !== 'into' && s.before.overlay && !(await store.get('overlays', s.before.overlay)))
      deleted.add(s.before.overlay);
  const back = (a: Attachment) => {
    const s = m.restoring?.find((x) => x.attachment === a.id);
    if (!s || s.how === 'into' || (a.overlay !== s.overlay && a.overlay !== undefined)) return a;
    const overlay = s.before.overlay && !deleted.has(s.before.overlay) ? s.before.overlay : undefined;
    return { ...a, overlay, inPlace: s.before.inPlace };
  };
  const copy: MachineRecord = {
    ...m,
    id: newId(),
    name: uniqueName(t('machines:machines.copyName', { name: m.name }), taken),
    attachments: m.attachments.map((a) => ({ ...back(a), id: newId() })),
    adapters: adaptersOf(m).map((a) => ({ id: newId(), mac: a.mac })),
    network: undefined,
    ...(m.usbDevices ? { usbDevices: m.usbDevices.map((u) => ({ ...u, id: newId() })) } : {}),
    restoreFirst: undefined, // the template kept is the machine's own snapshot, which a copy hasn't
    restoring: undefined, // a restore that hasn't loaded is the original's to undo
    // Not the demo's own: its card's "started before" would open a copy that starts cold, off the demo network (copies drop
    // connections). A copy is the user's machine, made from theirs.
    fromDemo: undefined,
    created: now,
    modified: now,
  };
  await store.put('machines', copy);
  return copy;
}

/** `m` with one more network adapter (a new MAC, no connection), or as it is at `MAX_ADAPTERS`. The machine must be off to save it. */
export function withAdapter(m: MachineRecord): MachineRecord {
  const have = adaptersOf(m);
  if (have.length >= MAX_ADAPTERS) return m;
  return { ...m, network: undefined, adapters: [...have, { id: newId(), mac: newMac(have.map((a) => a.mac)) }] };
}

/** `m` without adapter `id`. */
export function withoutAdapter(m: MachineRecord, id: string): MachineRecord {
  return { ...m, network: undefined, adapters: adaptersOf(m).filter((a) => a.id !== id) };
}

/** `m` with adapter `id` moved `by` places, its MAC and connection with it (the guest's `eth<n>` and the default way out follow the order); at an end it stays. */
export function movedAdapter(m: MachineRecord, id: string, by: number): MachineRecord {
  const adapters = [...adaptersOf(m)];
  const from = adapters.findIndex((a) => a.id === id);
  const to = from + by;
  if (from < 0 || to < 0 || to >= adapters.length) return m;
  adapters.splice(to, 0, ...adapters.splice(from, 1));
  return { ...m, network: undefined, adapters };
}

/**
 * Machine `id` with connection `connection` (undefined: none) attached to its adapter `index` (docs/networking/adapters.md
 * §3.1): saved now, also while it runs (a connection isn't in the shape). A machine made before adapters gets its card as
 * an adapter (the same MAC: the shape stays).
 */
export async function setAdapterConnection(store: Store, id: string, index: number, connection: string | undefined) {
  await store.update('machines', id, (m) => {
    if (!m) throw gone();
    const adapters = adaptersOf(m).map((a) => ({ ...a }));
    if (!adapters[index]) throw new Error(`${m.name} has no adapter ${index + 1}`);
    if (connection) adapters[index].connection = connection;
    else delete adapters[index].connection;
    return { ...m, network: undefined, adapters };
  });
}

/** Takes connection `connection` off every machine that has it attached (it was deleted). */
export async function detachEverywhere(store: Store, connection: string) {
  for (const { id } of await store.all('machines'))
    await store.update('machines', id, (m) =>
      m?.adapters?.some((a) => a.connection === connection)
        ? {
            ...m,
            adapters: m.adapters.map(({ connection: c, ...a }) =>
              c && c !== connection ? { ...a, connection: c } : a,
            ),
          }
        : undefined,
    );
}

/** Deletes machine `id` (its variable store, suspended copy and snapshots); its disks and their overlays stay. */
export async function deleteMachine(store: Store, id: string) {
  await needsOff(id, 'delete');
  await store.deleteMachine(id);
}

/** Saves the machine's settings (name, vCPUs, RAM, the JIT's budget, display and Vulkan, network, the USB controller, the mouse, the touchscreen, the clock device, shared folders): they're set at its start, so it must be off. */
export async function updateMachine(store: Store, m: MachineRecord) {
  const was = await store.get('machines', m.id);
  if (!was) throw gone();
  // What takes a restart: the shape, and the JIT's budget (set when the machine starts; not the guest's).
  const shape = (x: MachineRecord) =>
    JSON.stringify([
      x.ncpus,
      x.ramMiB,
      x.ramSplit ?? null,
      x.display,
      !!x.vulkan,
      adaptersOf(x).map((a) => a.mac),
      !!x.usb,
      !!x.mouse,
      !!x.touch,
      !!x.clock,
      !!x.shares,
      x.jitMiB ?? 0,
    ]);
  if (shape(was) !== shape(m)) await needsOff(m.id, 'shape');
  const names = (await store.all('machines')).filter((x) => x.id !== m.id).map((x) => x.name);
  // The draft's fields onto the record as the store has it at the write (one read and write: `Store.update`), the rest
  // kept as they are there.
  const saved = await store.update('machines', m.id, (cur) => {
    if (!cur) throw gone();
    const next: MachineRecord = { ...m };
    // The remembered USB devices are the USB tab's (web/app/usb-ports.ts), edited while the machine runs: a settings draft doesn't carry them.
    next.usbDevices = cur.usbDevices;
    // Nor its disks: the attachments, a restore's to undo and a template's first start are the Disks tab's, the
    // restore's and the undo's (docs/machines.md §5.2 "A restore's records"), written while a draft was open.
    next.attachments = cur.attachments;
    next.restoring = cur.restoring;
    next.restoreFirst = cur.restoreFirst;
    // The attached folders are the Shared folders tab's: the same (web/app/folders.ts).
    if (cur.folders) next.folders = cur.folders;
    else delete next.folders;
    // So are the adapters' connections (the Network tab attaches them while the machine runs, web/app/net-live.ts).
    const attached = new Map(adaptersOf(cur).map((a) => [a.id, a.connection]));
    if (next.adapters || cur.adapters) {
      next.adapters = adaptersOf(next).map(({ connection: _, ...a }) =>
        attached.get(a.id) ? { ...a, connection: attached.get(a.id) } : a,
      );
      next.network = undefined;
    }
    if (next.name !== cur.name) next.name = uniqueName(next.name.trim() || cur.name, names);
    next.modified = Date.now();
    return next;
  });
  return Object.assign(m, saved);
}

/** What a new disk is: its kind and what the kind needs (a URL checked, a file's handle, a size). */
export type NewDisk =
  | {
      kind: 'url';
      url: string;
      name?: string;
      size: number;
      bytes: number;
      /** A chunked image's manifest `id`: the disk's identity (its URL left out of it). */
      chunked?: string;
      etag?: string;
      lastModified?: string;
    }
  | { kind: 'file'; file: File; handle?: FileSystemFileHandle; size: number }
  | { kind: 'blank' | 'ramdisk'; size: number; name?: string };

/** A file's or URL's identity (machines.md §3.1): what makes it the same disk when it's added again. */
function identityFor(d: NewDisk & { kind: 'url' | 'file' }): DiskIdentity {
  if (d.kind === 'file') return { kind: 'file', name: d.file.name, bytes: d.file.size, modified: d.file.lastModified };
  // A chunked image is its content, wherever it's hosted (a template's pins match on any host: docs/machines.md §3.1).
  if (d.chunked) return { kind: 'url', chunked: d.chunked, bytes: d.bytes };
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- no location in Node's tests
  const u = new URL(d.url, globalThis.location?.href);
  return {
    kind: 'url',
    path: u.pathname,
    bytes: d.bytes,
    ...(d.etag ? { etag: d.etag } : d.lastModified ? { lastModified: d.lastModified } : {}),
  };
}

/**
 * The disk record the browser already has for a file or URL (the same identity), so that one added again (or opened,
 * or dropped) is the same disk, with its overlays; undefined for one it doesn't have, and for blank disks and ramdisks
 * (each is a disk of its own).
 */
export async function knownDisk(store: Store, d: NewDisk): Promise<DiskRecord | undefined> {
  if (d.kind !== 'url' && d.kind !== 'file') return undefined;
  const want = canonical(identityFor(d));
  // A chunked image's disk added before content ids: its identity the URL's, with the manifest's id as its `etag`.
  const before =
    d.kind === 'url' && d.chunked
      ? canonical(identityFor({ ...d, chunked: undefined, etag: d.chunked, lastModified: undefined }))
      : undefined;
  const all = await store.all('disks');
  return (
    all.find((x) => x.kind === d.kind && canonical(x.identity) === want) ??
    all.find((x) => x.kind === d.kind && canonical(x.identity) === before)
  );
}

/** A disk record for `d` (a stored disk is made by `importStored` instead: its bytes first). */
export async function createDisk(store: Store, d: NewDisk): Promise<DiskRecord> {
  const id = newId();
  const now = Date.now();
  let r: DiskRecord;
  if (d.kind === 'url') {
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- no location in Node's tests
    const u = new URL(d.url, globalThis.location?.href);
    r = {
      id,
      kind: 'url',
      // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- a URL ending in '/' names no file
      name: d.name ?? (u.pathname.split('/').pop() || u.hostname),
      size: d.size,
      format: u.pathname.endsWith('.iso') ? 'iso' : undefined,
      url: u.href,
      identity: identityFor(d),
      created: now,
    };
  } else if (d.kind === 'file') {
    r = { id, kind: 'file', name: d.file.name, size: d.size, handle: d.handle, identity: identityFor(d), created: now };
  } else {
    if (!Number.isSafeInteger(d.size) || d.size <= 0 || d.size % 4096) throw new Error('a size in whole 4 KiB blocks');
    r = {
      id,
      kind: d.kind,
      name: d.name ?? (d.kind === 'blank' ? t('machines:machines.blankDiskName') : t('machines:machines.ramdiskName')),
      size: d.size,
      identity: { kind: d.kind, id, bytes: d.size },
      created: now,
    };
  }
  await store.put('disks', r);
  return r;
}

/** Bytes in words. */
export { bytesText } from './bytes.ts';
// A machine's disks, attached and edited (web/app/machine-attachments.ts), where the Home page and the tests look for them.
export { attach, editAttachment } from './machine-attachments.ts';
