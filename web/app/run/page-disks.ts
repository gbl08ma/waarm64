// The page's machine's disks (docs/frontend.md "Your own disk", docs/machines.md §3): which it boots, what they're
// called, and the disks a start hands the worker. Read off web/app/run/page-machine.svelte.ts's `PageMachine`.
import { t, text } from '../../i18n.ts';
import { params } from './knobs.ts';
import { diskOf, type PageMachine, type Stored } from './page-machine.svelte.ts';
import type { StartDisk } from '../protocol.ts';
import type { CurrentSource } from '../areas/current.svelte.ts';
import { swapLabel } from '../guest-swap.ts';
import { sizeSeen } from '../disk-size.ts';
import { newId, serialOf, type DiskRecord } from '../shape.ts';
import { diskDir, machineDir, overlayDir } from '../store.ts';
import { diskSource, identityOf, refreshOverlay, refreshStored } from '../disks.ts';
import { granted } from '../grants.ts';

/** A stored machine's boot disk has no overlay before its first start (the start makes one): nothing written yet. */
export const NO_OVERLAY_YET = 'overlays/none';

/**
 * A stored machine's boot disk: its first writable attachment that takes an overlay (a changes file dropped on the page
 * goes by it; the Home page has every disk's).
 */
export function bootAttachment(m: PageMachine) {
  const s = m.stored;
  return s?.record.attachments.find((a) => !a.readOnly && !a.inPlace && s.disks.get(a.disk)?.kind !== 'ramdisk');
}
export function bootDisk(m: PageMachine) {
  const a = bootAttachment(m);
  return a && m.stored?.disks.get(a.disk);
}
/** The OPFS overlay of the disk the machine boots. */
export function overlayName(m: PageMachine) {
  const a = bootAttachment(m);
  if (m.stored) return a && (a.overlay ? overlayDir(a.overlay) : NO_OVERLAY_YET);
  return m.chosen?.overlay ?? m.spec.overlay;
}
/** A transient machine's own disk: the chosen one, or its image with the overlay it names. */
const ownDisk = (m: PageMachine): { url?: string; file?: File; overlay?: string } | undefined =>
  m.chosen ?? (m.spec.disk ? { url: m.spec.disk, overlay: m.spec.overlay } : undefined);
/**
 * The OPFS directory of the machine's own files (the variable store, a suspended copy; `startDisks`' `home`): every
 * stored machine's, whatever its disks (an in-place disk is pinned by its own generation, a ramdisk's blocks go in the
 * copy), and a transient machine's overlay. Without one there is no Suspend.
 */
export const homeOf = (m: PageMachine) => (m.stored ? machineDir(m.stored.record.id) : ownDisk(m)?.overlay);
/** The facts of `current` (web/app/areas/current.svelte.ts) read off the machine and its disks: all but its size. */
export const diskFacts = (m: PageMachine): Omit<CurrentSource, 'size'> => ({
  id: () => m.stored?.record.id,
  title: () => machineTitle(m),
  transient: () => (!m.stored && !needsDisk(m) ? { label: text(m.spec.title), disk: baseName(m) } : undefined),
  hasOverlay: () => !!overlayName(m),
  canSuspend: () => !!homeOf(m),
});
/** What the disk is called on the page. */
export function diskName(m: PageMachine) {
  if (m.stored) return bootDisk(m)?.name;
  const c = m.chosen;
  if (!c) return undefined;
  return c.file?.name ?? c.name ?? (c.url && new URL(c.url, location.href).pathname.split('/').pop()) ?? 'disk';
}
/** The disk's file name: the chosen file's or URL's, or the machine's own image's. */
export const baseName = (m: PageMachine) =>
  diskName(m) ?? (m.spec.disk ? new URL(m.spec.disk, location.href).pathname.split('/').pop() : undefined) ?? 'disk';
/** A machine that boots the user's disk and has none yet (the page's own, until a disk is opened): it waits. */
export const needsDisk = (m: PageMachine) =>
  !!m.spec.firmware && !m.spec.disk && !m.chosen && !m.stored?.record.attachments.length;
/** What the toolbar calls the machine: its name, a chunked image's own (`?disk=` its manifest), or a transient one's and its disk's. */
export function machineTitle(m: PageMachine) {
  if (m.stored) return m.stored.record.name;
  if (m.chosen?.name) return m.chosen.name;
  const disk = diskName(m);
  if (disk) return t('machine:page-disks.title.disk', { machine: m.spec.title, disk });
  return needsDisk(m) ? t('machine:page-disks.title.noDisk', { machine: m.spec.title }) : text(m.spec.title);
}

/** A disk's source: the file picked for it in this session, else its own. */
export async function sourceOf(m: PageMachine, d: DiskRecord) {
  const picked = m.pickedFiles.get(d.id);
  return { source: picked ? { file: picked } : await diskSource(d), identity: identityOf(d), file: picked };
}
/** The page's disk as a job reads it (its Export, Import changes): its source, overlay and identity. */
export async function pageDisk(m: PageMachine) {
  const d = bootDisk(m);
  if (d) return sourceOf(m, d);
  const file = m.chosen?.file;
  const url = m.chosen?.url ?? m.spec.disk ?? '';
  return { source: file ? { file } : { url }, identity: undefined, file };
}

/**
 * Gives each writable attachment of the stored machine an overlay, if it has none yet (an empty one, "Changes"), and
 * keeps the machine's record. A ramdisk has none (its writes stay in memory).
 */
async function ensureOverlays(m: PageMachine, s: Stored) {
  let changed = false;
  for (const a of s.record.attachments) {
    const d = diskOf(s, a.disk);
    if (a.readOnly || d.kind === 'ramdisk' || a.inPlace || a.overlay) continue;
    const now = Date.now();
    a.overlay = newId();
    await m.store.put('overlays', {
      id: a.overlay,
      name: t('disks:page-disks.overlayName'),
      disk: d.id,
      identity: d.identity,
      generation: 0,
      bytes: 0,
      created: now,
      modified: now,
    });
    changed = true;
  }
  if (changed) await m.store.put('machines', s.record);
}

/** A stored machine's disks, in slot order, and the OPFS directory of its own files. */
async function storedDisks(m: PageMachine, s: Stored): Promise<{ disks: StartDisk[]; home?: string }> {
  await ensureOverlays(m, s);
  // Swap ramdisks are labelled in slot order (web/app/guest-swap.ts).
  const swaps = s.record.attachments.filter((a) => a.swap && diskOf(s, a.disk).kind === 'ramdisk').map((a) => a.id);
  const disks = await Promise.all(
    s.record.attachments.map(async (a): Promise<StartDisk> => {
      const d = diskOf(s, a.disk);
      const base = { name: d.name, serial: serialOf(a.id), identity: identityOf(d) };
      if (d.kind === 'ramdisk' && swaps.includes(a.id))
        return { ...base, source: { ramdisk: d.size, swap: swapLabel(swaps.indexOf(a.id)) } };
      // A stored disk written in place is its own overlay, over zeros (web/stored.ts).
      if (d.kind === 'stored' && a.inPlace && !a.readOnly)
        return { ...base, source: { blank: d.size }, overlay: diskDir(d.id) };
      const overlay = a.readOnly || d.kind === 'ramdisk' || !a.overlay ? undefined : a.overlay;
      // Through a grown overlay the guest sees its own size (docs/machines.md §4.5), as the shape says.
      const size = overlay ? sizeSeen(d, a, await m.store.get('overlays', overlay)) : d.size;
      return {
        ...base,
        source: (await sourceOf(m, d)).source,
        overlay: overlay && overlayDir(overlay),
        ...(size > d.size ? { size } : {}),
      };
    }),
  );
  return { disks, home: homeOf(m) };
}

/**
 * The disks of the machine to start, in slot order, and the OPFS directory of its own files (the variable store, a
 * suspended copy). A transient machine's: its image or the chosen disk, its overlay as home, and `?disk2=` read-only.
 */
export async function startDisks(m: PageMachine): Promise<{ disks: StartDisk[]; home?: string }> {
  if (m.stored) return storedDisks(m, m.stored);
  const disks: StartDisk[] = [];
  const own = ownDisk(m);
  if (own)
    disks.push({
      name: baseName(m),
      source: own.file ? { file: own.file } : { url: own.url ?? '' },
      overlay: own.overlay,
      own: m.chosen ? undefined : true,
    });
  const disk2 = params.get('disk2');
  if (disk2)
    disks.push({
      name: new URL(disk2, location.href).pathname.split('/').pop() ?? 'disk2',
      source: { url: new URL(disk2, location.href).href },
    }); // the page's, not the worker's (its bundle is under assets/)
  return { disks, home: homeOf(m) };
}

/** After a stored machine ran: its overlays' and in-place disks' generations and sizes from their files into their records (§3.3). */
export async function refreshRecords(m: PageMachine) {
  if (!m.stored) return;
  for (const a of m.stored.record.attachments) {
    // A record not refreshed keeps its last numbers: the next run's end tries again.
    if (a.inPlace && !a.readOnly) await refreshStored(m.store, a.disk).catch(() => undefined);
    else if (a.overlay) await refreshOverlay(m.store, a.overlay).catch(() => undefined);
  }
}

/**
 * The stored machine's file disks that need the user before it can start (machines.md §3.2): no handle, or one the
 * browser doesn't say is granted (within `GRANT_WAIT_MS`: it can leave the question unanswered, web/app/grants.ts).
 */
export async function filesNeedingUser(m: PageMachine, s: Stored) {
  const out: DiskRecord[] = [];
  for (const a of s.record.attachments) {
    const d = diskOf(s, a.disk);
    if (d.kind !== 'file' || m.pickedFiles.has(d.id)) continue;
    const h = d.handle;
    if (!h || !(await granted(h, 'read'))) out.push(d);
  }
  return out;
}
