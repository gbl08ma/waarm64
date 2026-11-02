// What the page does with disks and their overlays (docs/machines.md §3, §4): a disk's bytes for a machine or a
// job (`diskRef`), the overlays as named variants of a base (new, rename, switch, delete, refreshed from their meta
// after a machine stops), changes loaded into a new overlay, a file imported into the browser as a stored disk, an
// overlay merged into its stored disk. Records go through web/app/store.ts (a record after its bytes, deleted before
// them); bytes are touched in workers (sync access handles). Nothing here asks the user: the Machines page confirms first.
import { fromWire, MsgError } from '../msg.ts';
import { overlayBytes, overlayMeta, removeOverlay } from '../overlay.ts';
import type { DiskJob, DiskJobResult } from './disk-worker.ts';
import { runImport } from './import.ts';
import type { DiskRef } from './protocol.ts';
import { canonical, newId, type DiskRecord, type MachineRecord } from './shape.ts';
import { diskDir, overlayDir, type OverlayRecord, type Store } from './store.ts';

/** The overlay identity check's string for a disk (what its overlays' `base` files record). */
export const identityOf = (d: DiskRecord) => canonical(d.identity);

/** A disk's bytes for a job or a machine (a file disk's handle must have its permission: §3.2). */
export async function diskSource(d: DiskRecord): Promise<DiskRef['source']> {
  switch (d.kind) {
    case 'url': return { url: new URL(d.url!, globalThis.location?.href).href }; // the page's (a worker's bundle is under assets/)
    case 'file': {
      if (!d.handle) throw new MsgError('disks:disks.pickAgain', { name: d.name });
      return { file: await d.handle.getFile() };
    }
    case 'blank': return { blank: d.size };
    case 'ramdisk': return { ramdisk: d.size };
    case 'stored': return { stored: diskDir(d.id), size: d.size };
  }
}

/** Disk `d` with overlay `overlay`'s changes (none: the disk as it is). */
export async function diskRef(d: DiskRecord, overlay?: string): Promise<DiskRef> {
  return { source: await diskSource(d), overlay: overlay ? overlayDir(overlay) : undefined, identity: identityOf(d) };
}

/** Whether overlay or stored disk directory `path` is open now (a machine runs on it, in this tab or another). */
export async function inUse(path: string) {
  const held = await navigator.locks.query();
  return [...(held.held ?? []), ...(held.pending ?? [])].some((l) => l.name === `webpc-overlay:${path}`);
}

/** A new, empty overlay of disk `d` (its files are made when a machine first opens it). */
export async function createOverlay(store: Store, d: DiskRecord, name: string, fork?: OverlayRecord['fork']): Promise<OverlayRecord> {
  const now = Date.now();
  const o: OverlayRecord = { id: newId(), name, disk: d.id, identity: d.identity, generation: 0, bytes: 0, created: now, modified: now, fork };
  await store.put('overlays', o);
  return o;
}

export async function renameOverlay(store: Store, id: string, name: string) {
  const o = await store.get('overlays', id);
  if (!o) throw new MsgError('disks:disks.overlayGone');
  await store.put('overlays', { ...o, name, modified: Date.now() });
}

/** Attaches overlay `overlay` (one of the disk's) to machine `m`'s attachment `attachment`; the machine is off. */
export async function switchOverlay(store: Store, m: MachineRecord, attachment: string, overlay: string) {
  const a = m.attachments.find((x) => x.id === attachment);
  const o = await store.get('overlays', overlay);
  if (!a || !o || o.disk !== a.disk) throw new MsgError('disks:disks.notThisDisk');
  a.overlay = overlay;
  m.modified = Date.now();
  await store.put('machines', m);
}

/**
 * Deletes an overlay: refused while a machine has it open; machines that had it chosen are left without one (their
 * next start makes an empty one). The record first, then the files.
 */
export async function deleteOverlay(store: Store, id: string) {
  if (await inUse(overlayDir(id))) throw new MsgError('disks:disks.overlayRunning');
  for (const m of await store.all('machines')) {
    if (!m.attachments.some((a) => a.overlay === id)) continue;
    for (const a of m.attachments) if (a.overlay === id) a.overlay = undefined;
    await store.put('machines', { ...m, modified: Date.now() });
  }
  await store.deleteOverlay(id);
  await removeOverlay(overlayDir(id));
}

/** Reads an overlay's generation and size from its files into its record (after a machine stopped). */
export async function refreshOverlay(store: Store, id: string) {
  const o = await store.get('overlays', id);
  if (!o) return undefined;
  const [meta, bytes] = await Promise.all([overlayMeta(overlayDir(id)), overlayBytes(overlayDir(id))]);
  if (meta.generation === o.generation && bytes === o.bytes) return o;
  const next = { ...o, generation: meta.generation, bytes, modified: meta.generation !== o.generation ? Date.now() : o.modified };
  await store.put('overlays', next);
  return next;
}

/** A stored disk's generation from its files into its record (after a machine wrote it in place). */
export async function refreshStored(store: Store, id: string) {
  const d = await store.get('disks', id);
  if (!d || d.kind !== 'stored') return;
  const meta = await overlayMeta(diskDir(id));
  if (meta.generation !== d.generation) await store.put('disks', { ...d, generation: meta.generation });
}

/** Loads a changes file (Export's "changes only") into a new overlay of `d`, named after the file. */
export async function loadChangesInto(store: Store, d: DiskRecord, file: File, progress: (phase: string, fraction: number) => void, source?: DiskRef['source']) {
  const id = newId();
  return store.writing(async () => {
    try {
      await runImport({ changes: file, disk: { ...(await diskRef(d)), ...(source ? { source } : {}), overlay: overlayDir(id) }, label: d.name }, progress);
    } catch (e) {
      await removeOverlay(overlayDir(id)).catch(() => {});
      throw e;
    }
    const meta = await overlayMeta(overlayDir(id));
    const now = Date.now();
    const o: OverlayRecord = { id, name: file.name.replace(/\.qcow2$/i, ''), disk: d.id, identity: d.identity, generation: meta.generation, bytes: await overlayBytes(overlayDir(id)), created: now, modified: now };
    await store.put('overlays', o);
    return o;
  });
}

/** Runs a disk job in its worker; resolves to its result. */
function job(j: DiskJob, progress?: (fraction: number) => void) {
  return new Promise<Extract<DiskJobResult, { type: 'done' }>>((resolve, reject) => {
    const w = new Worker(new URL('./disk-worker.ts', import.meta.url), { type: 'module' });
    w.onmessage = (e: MessageEvent<DiskJobResult>) => {
      const m = e.data;
      if (m.type === 'progress') return progress?.(m.total ? m.done / m.total : 0);
      w.terminate();
      if (m.type === 'error') reject(fromWire(m.error));
      else resolve(m);
    };
    w.onerror = (e) => { w.terminate(); reject(new Error(e.message)); };
    w.postMessage(j);
  });
}

/** What a file will take stored in the browser (machines.md §4.4: a qcow2's allocated clusters), with its virtual size. */
export async function estimateStored(file: File) {
  const r = await job({ type: 'estimate', file });
  return { size: r.size!, format: r.format as 'raw' | 'qcow2', estimate: r.estimate! };
}

/** Imports a file as a stored disk (converted into the block store); its record once its bytes are there. */
export async function importStored(store: Store, file: File, progress?: (fraction: number) => void): Promise<DiskRecord> {
  const id = newId();
  const identity = { kind: 'stored' as const, id, bytes: 0 };
  return store.writing(async () => {
    let r;
    try {
      r = await job({ type: 'import', file, path: diskDir(id), identity: canonical(identity) }, progress);
    } catch (e) {
      await store.files.remove(diskDir(id)).catch(() => {});
      throw e;
    }
    // A stored disk is known by its id: its identity's `bytes` stays 0 (its store's `base` file has it as made).
    const d: DiskRecord = { id, kind: 'stored', name: file.name, size: r.size!, format: r.format === 'qcow2' ? 'qcow2' : 'raw', identity, generation: (await overlayMeta(diskDir(id))).generation, created: Date.now() };
    await store.put('disks', d);
    return d;
  });
}

/**
 * Merges overlay `overlay` into its stored disk (§4.4): every other overlay of the disk is deleted (they were over the
 * old bytes), then the overlay's record, then its blocks go into the disk and its files away (in the worker, resumed
 * at the disk's next opening if interrupted). Machines that had the deleted overlays chosen are left without one.
 * The caller confirmed (it lists `mergeCosts`).
 */
export async function mergeIntoDisk(store: Store, overlay: string) {
  const o = await store.get('overlays', overlay);
  if (!o) throw new MsgError('disks:disks.overlayGone');
  const d = await store.get('disks', o.disk);
  if (d?.kind !== 'stored') throw new MsgError('disks:disks.onlyStored');
  const others = (await store.overlaysOf(d.id)).filter((x) => x.id !== o.id);
  for (const x of [o, ...others]) if (await inUse(overlayDir(x.id))) throw new MsgError('disks:disks.overlayNamedRunning', { name: x.name });
  if (await inUse(diskDir(d.id))) throw new MsgError('disks:disks.diskRunning');
  for (const x of others) await deleteOverlay(store, x.id);
  for (const m of await store.all('machines')) {
    if (!m.attachments.some((a) => a.overlay === o.id)) continue;
    for (const a of m.attachments) if (a.overlay === o.id) a.overlay = undefined;
    await store.put('machines', { ...m, modified: Date.now() });
  }
  await store.forget('overlays', o.id); // the record only: the worker deletes the files once their blocks are in the disk
  const r = await job({ type: 'merge', disk: diskDir(d.id), overlay: overlayDir(o.id), identity: identityOf(d), size: d.size });
  await refreshStored(store, d.id);
  return r.blocks ?? 0;
}

/** What a merge of `overlay` deletes: the disk's other overlays (with their sizes). */
export async function mergeCosts(store: Store, overlay: string) {
  const o = await store.get('overlays', overlay);
  return o ? (await store.overlaysOf(o.disk)).filter((x) => x.id !== o.id) : [];
}
