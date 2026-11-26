// What the page does with disks and their overlays (docs/machines.md §3, §4): a disk's bytes for a machine or a
// job (`diskRef`), the overlays as named variants of a base (new, rename, switch, delete, refreshed from their meta
// after a machine stops), changes loaded into a new overlay, a file imported into the browser as a stored disk, the
// disk worker's jobs (`diskJob`; an overlay merged into its disk is web/app/merge.ts). Records go through
// web/app/store.ts (a record after its bytes, deleted before them); bytes are touched in workers (sync access handles).
// Nothing here asks the user: the Home page confirms first.
import { fromWire, MsgError } from '../msg.ts';
import { locksInUse, overlayBytes, overlayLock, overlayMeta, removeOverlay, writeOwnSize } from '../overlay.ts';
import { sizeSeen, type GrowMark } from './disk-size.ts';
import { holdMachines } from './machine-hold.ts';
import type { DiskJob, DiskJobResult } from './disk-worker.ts';
import { runImport } from './import.ts';
import type { DiskRef } from './protocol.ts';
import { restoreNames } from './restore-step.ts';
import { canonical, newId, type DiskRecord, type MachineRecord } from './shape.ts';
import { diskDir, overlayDir, type OverlayRecord, type Store } from './store.ts';

/** The overlay identity check's string for a disk (what its overlays' `base` files record). */
export const identityOf = (d: DiskRecord) => canonical(d.identity);

/** A disk's bytes for a job or a machine (a file disk's handle must have its permission: §3.2). */
export async function diskSource(d: DiskRecord): Promise<DiskRef['source']> {
  switch (d.kind) {
    case 'url':
      if (!d.url) throw new Error(`URL disk ${d.id} has no URL`);
      // The page's URL (a worker's bundle is under assets/); a chunked image's content id, which its manifest must name.
      return {
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- no location in Node's tests
        url: new URL(d.url, globalThis.location?.href).href,
        ...('chunked' in d.identity ? { chunked: d.identity.chunked } : {}),
      };
    case 'file': {
      if (!d.handle) throw new MsgError('disks:disks.pickAgain', { name: d.name });
      return { file: await d.handle.getFile() };
    }
    case 'blank':
      return { blank: d.size };
    case 'ramdisk':
      return { ramdisk: d.size };
    case 'stored':
      return { stored: diskDir(d.id), size: d.size, ...(d.made ? { made: d.made } : {}) };
  }
}

/**
 * File disk `id`'s file chosen again (docs/machines.md §3.2): its record keeps its id, name, identity, overlays and
 * attachments, and takes `handle`. The record as written, or undefined if the disk is gone (deleted in another tab).
 */
export function replaceFileHandle(store: Store, id: string, handle: FileSystemFileHandle) {
  return store.update('disks', id, (d) => (d?.kind === 'file' ? { ...d, handle } : undefined));
}

/** Disk `d` with overlay `overlay`'s changes (none: the disk as it is). */
export async function diskRef(d: DiskRecord, overlay?: string): Promise<DiskRef> {
  return { source: await diskSource(d), overlay: overlay ? overlayDir(overlay) : undefined, identity: identityOf(d) };
}

/**
 * Whether overlay or stored disk directory `path` is open now (a machine runs on it, in this tab or another, or a disk
 * job has it), or about to be; a disk surface job reading its map doesn't count (web/overlay.ts `locksInUse`).
 */
export async function inUse(path: string) {
  return (await locksInUse()).has(overlayLock(path));
}

/**
 * A new, empty overlay of disk `d` (its files are made when a machine first opens it). `size`: its own size where it is
 * larger than the disk's (a grown overlay's fork, §4.5), written into its meta first (the record after its bytes: an
 * export or a device opening it before the restore's worker fills it sees it too); `grow`: its grow mark; `id`: the id
 * a restore's commit gave it in the machine's record before making it (web/app/snapshots.ts).
 */
export async function createOverlay(
  store: Store,
  d: DiskRecord,
  name: string,
  fork?: OverlayRecord['fork'],
  size?: number,
  grow?: GrowMark,
  id = newId(),
): Promise<OverlayRecord> {
  const now = Date.now();
  const own = size !== undefined && size > d.size;
  const o: OverlayRecord = {
    id,
    name,
    disk: d.id,
    identity: d.identity,
    generation: 0,
    bytes: 0,
    created: now,
    modified: now,
    fork,
    ...(own ? { size } : {}),
    ...(own && grow ? { grow } : {}),
  };
  if (own) await writeOwnSize(overlayDir(o.id), size);
  await store.put('overlays', o);
  return o;
}

/**
 * New empty: a new overlay of machine `m`'s attachment `attachment`'s disk, attached; at the size its guest saw (§4.5:
 * an attachment's disk doesn't shrink by taking a new variant, nor its snapshots orphan), marked to grow where that's
 * past the disk's (its base's partition doesn't fill it). The machine is off.
 */
export async function newEmptyOverlay(store: Store, m: MachineRecord, attachment: string, name: string) {
  const a = m.attachments.find((x) => x.id === attachment);
  const d = a && (await store.get('disks', a.disk));
  if (!a || !d) throw new MsgError('disks:disks.notThisDisk');
  const size = sizeSeen(d, a, a.overlay ? await store.get('overlays', a.overlay) : undefined);
  const o = await createOverlay(store, d, name, undefined, size, { from: d.size, to: size });
  await switchOverlay(store, m, attachment, o.id);
  return o;
}

export async function renameOverlay(store: Store, id: string, name: string) {
  await store.update('overlays', id, (o) => {
    if (!o) throw new MsgError('disks:disks.overlayGone');
    return { ...o, name, modified: Date.now() };
  });
}

/**
 * Attaches overlay `overlay` (one of the disk's) to machine `m`'s attachment `attachment`; the machine is off. Written
 * onto the record as the store has it (`m` is the caller's copy, maybe older than a restore's commit or its load).
 */
export async function switchOverlay(store: Store, m: MachineRecord, attachment: string, overlay: string) {
  const o = await store.get('overlays', overlay);
  const saved = await store.update('machines', m.id, (cur) => {
    const a = cur?.attachments.find((x) => x.id === attachment);
    if (!cur || !a || o?.disk !== a.disk) throw new MsgError('disks:disks.notThisDisk');
    const attachments = cur.attachments.map((x) => (x.id === attachment ? { ...x, overlay } : x));
    return { ...cur, attachments, modified: Date.now() };
  });
  Object.assign(m, saved);
}

/**
 * Deletes an overlay: refused while a machine has it open; machines that had it chosen are left without one (their
 * next start makes an empty one). The record first, then the files.
 */
export async function deleteOverlay(store: Store, id: string) {
  if (await inUse(overlayDir(id))) throw new MsgError('disks:disks.overlayRunning');
  // A merge of it that failed partway (its disk marked): some of its blocks are in the disk already, the rest only here.
  const o = await store.get('overlays', id);
  if (o && (await overlayMeta(diskDir(o.disk))).merging === overlayDir(id))
    throw new MsgError('disks:disks.overlayMerging');
  await unchoose(store, id);
  await store.deleteOverlay(id);
  await removeOverlay(overlayDir(id));
}

/** Leaves the machines that had overlay `id` chosen without one (their next start makes an empty one), each in one read and write. */
export async function unchoose(store: Store, id: string) {
  for (const { id: machine } of await store.all('machines'))
    await store.update('machines', machine, (m) =>
      m?.attachments.some((a) => a.overlay === id)
        ? {
            ...m,
            attachments: m.attachments.map((a) => (a.overlay === id ? { ...a, overlay: undefined } : a)),
            modified: Date.now(),
          }
        : undefined,
    );
}

/**
 * Delete overlay, the Overlays dialog's (`deleteOverlay`), with the machines that could open it held off meanwhile
 * (`holdMachines`): those that have it chosen or whose restore that never loaded would go back onto it (its undo, at
 * that machine's load, would name it), and, for a restore's fork, every machine that attaches its disk (a restore
 * attaches an earlier fork again). A start owns its machine's lock from before it reads the record, and opens the
 * overlay only in its worker's disk phase: deleted in between, it would be made anew with no record naming it. Refused
 * while one of them holds its lock (it runs, or starts).
 */
export async function deleteOverlayAsked(store: Store, id: string) {
  const o = await store.get('overlays', id);
  if (!o) return;
  const users = o.fork
    ? await store.machinesWith(o.disk)
    : (await store.all('machines')).filter((m) => m.attachments.some((a) => a.overlay === id) || restoreNames(m, id));
  const held = await holdMachines(users);
  if (held.busy)
    throw new MsgError('disks:disks.overlayUsersRunning', {
      machines: held.busy.map((m) => m.name),
      count: held.busy.length,
    });
  try {
    await deleteOverlay(store, id);
  } finally {
    held.release();
  }
}

/**
 * Reads an overlay's generation, bytes and own size from its files into its record (after a machine stopped): onto the
 * record as the store has it, in one read and write (a restore's `loaded` may be naming and marking it meanwhile).
 */
export async function refreshOverlay(store: Store, id: string) {
  if (!(await store.get('overlays', id))) return undefined;
  const meta = await overlayMeta(overlayDir(id));
  // One a fill was cut off in (still marked) reads as empty, whatever its files hold (web/overlay.ts `openOverlay`).
  const bytes = meta.filling ? 0 : await overlayBytes(overlayDir(id));
  let now: OverlayRecord | undefined;
  const next = await store.update('overlays', id, (o) => {
    now = o;
    if (!o) return undefined;
    // A meta past its record (a resize cut off between the two, §4.5): the device opened it at that size, so it's the size.
    const size = meta.size > (o.size ?? 0) ? meta.size : o.size;
    if (meta.generation === o.generation && bytes === o.bytes && size === o.size) return undefined;
    return {
      ...o,
      generation: meta.generation,
      bytes,
      modified: meta.generation !== o.generation ? Date.now() : o.modified,
      ...(size === undefined ? {} : { size }),
    };
  });
  return next ?? now;
}

/** A stored disk's generation and bytes from its files into its record (after a machine wrote it in place, a merge). */
export async function refreshStored(store: Store, id: string) {
  const d = await store.get('disks', id);
  if (d?.kind !== 'stored') return;
  const [meta, bytes] = await Promise.all([overlayMeta(diskDir(id)), overlayBytes(diskDir(id))]);
  if (meta.generation !== d.generation || bytes !== d.bytes)
    await store.put('disks', { ...d, generation: meta.generation, bytes });
}

/**
 * The stored disks whose records don't say what they hold yet (made before `DiskRecord.bytes` was kept) read from their
 * files once, when the page opens; those a machine has open now are left for their next refresh.
 */
export async function fillStoredBytes(store: Store) {
  for (const d of await store.all('disks'))
    if (d.kind === 'stored' && d.bytes === undefined && !(await inUse(diskDir(d.id)))) await refreshStored(store, d.id);
}

/** Loads a changes file (Export's "changes only") into a new overlay of `d`, named after the file. */
export async function loadChangesInto(
  store: Store,
  d: DiskRecord,
  file: File,
  progress: (phase: string, fraction: number) => void,
  source?: DiskRef['source'],
) {
  const id = newId();
  return store.writing(async () => {
    try {
      await runImport(
        {
          changes: file,
          disk: { ...(await diskRef(d)), ...(source ? { source } : {}), overlay: overlayDir(id) },
          label: d.name,
        },
        progress,
      );
    } catch (e) {
      await removeOverlay(overlayDir(id)).catch(() => undefined); // tidying up: the failure thrown is the one to report
      throw e;
    }
    const meta = await overlayMeta(overlayDir(id));
    const now = Date.now();
    const o: OverlayRecord = {
      id,
      name: file.name.replace(/\.qcow2$/i, ''),
      disk: d.id,
      identity: d.identity,
      generation: meta.generation,
      bytes: await overlayBytes(overlayDir(id)),
      created: now,
      modified: now,
      ...(meta.size > d.size ? { size: meta.size } : {}), // changes exported from a grown overlay (§4.5)
    };
    await store.put('overlays', o);
    return o;
  });
}

/** Field `what` of a job's reply, which that job always sends. */
function sent<T>(v: T | undefined, what: string): T {
  if (v === undefined) throw new Error(`the disk worker's reply has no ${what}`);
  return v;
}

/** Runs a disk job in its worker; resolves to its result. */
export async function diskJob(
  j: DiskJob,
  progress?: (fraction: number) => void,
): Promise<Extract<DiskJobResult, { type: 'done' }>> {
  // Node has no Worker (the tests): a merge runs here, on the same in-memory files.
  if (typeof Worker === 'undefined' && j.type === 'merge') {
    const { mergeOverlay } = await import('../stored.ts');
    return { type: 'done', blocks: await mergeOverlay(j.disk, j.overlay, j.identity, j.size, undefined, j.keep) };
  }
  return new Promise<Extract<DiskJobResult, { type: 'done' }>>((resolve, reject) => {
    const w = new Worker(new URL('./disk-worker.ts', import.meta.url), { type: 'module' });
    w.onmessage = (e: MessageEvent<DiskJobResult>) => {
      const m = e.data;
      if (m.type === 'progress') return progress?.(m.total ? m.done / m.total : 0);
      w.terminate();
      if (m.type === 'error') reject(fromWire(m.error));
      else resolve(m);
    };
    w.onerror = (e) => {
      w.terminate();
      reject(new Error(e.message));
    };
    w.postMessage(j);
  });
}

/** What a file will take stored in the browser (machines.md §4.4: a qcow2's allocated clusters), with its virtual size. */
export async function estimateStored(file: File) {
  const r = await diskJob({ type: 'estimate', file });
  return { size: sent(r.size, 'size'), format: r.format as 'raw' | 'qcow2', estimate: sent(r.estimate, 'estimate') };
}

/** Imports a file as a stored disk (converted into the block store); its record once its bytes are there. */
export async function importStored(
  store: Store,
  file: File,
  progress?: (fraction: number) => void,
): Promise<DiskRecord> {
  const id = newId();
  const identity = { kind: 'stored' as const, id, bytes: 0 };
  return store.writing(async () => {
    let r;
    try {
      r = await diskJob({ type: 'import', file, path: diskDir(id), identity: canonical(identity) }, progress);
    } catch (e) {
      await store.files.remove(diskDir(id)).catch(() => undefined); // tidying up: the failure thrown is the one to report
      throw e;
    }
    // A stored disk is known by its id: its identity's `bytes` stays 0 (its store's `base` file has it as made).
    const d: DiskRecord = {
      id,
      kind: 'stored',
      name: file.name,
      size: sent(r.size, 'size'),
      format: r.format === 'qcow2' ? 'qcow2' : 'raw',
      identity,
      generation: (await overlayMeta(diskDir(id))).generation,
      bytes: await overlayBytes(diskDir(id)),
      created: Date.now(),
    };
    await store.put('disks', d);
    return d;
  });
}
