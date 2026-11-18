// What Add a disk makes (AddDisk.svelte, docs/machines.md §4.2): the disk a source and its details give, a known one
// again where the browser has it (a file's or a URL's identity: its overlays come back with it).
import { ask } from './ask.svelte.ts';
import { estimateStored, importStored } from './disks.ts';
import { msg, MsgError, t, type Msg } from '../i18n.ts';
import { bytesText, createDisk, knownDisk, type NewDisk } from './machines.ts';
import { askPersist } from './storage-report.ts';
import { causes } from '../msg.ts';
import type { DiskRecord, MachineRecord } from './shape.ts';
import type { Store } from './store.ts';
import { checkUrl, type UrlCheck } from './urlcheck.ts';

/** The sources a disk comes from: one the browser has, a URL, a file read where it is or copied in, blank, a ramdisk. */
export type Source = 'known' | 'url' | 'file' | 'stored' | 'blank' | 'ramdisk';

/** A file picked (with its handle, when the browser's picker gave one: a reload's resume asks only to allow it). */
export type Picked = { file: File; handle?: FileSystemFileHandle };

/** What the wizard's step gives for a source. */
export type Details = { source: Exclude<Source, 'known'>; url: string; picked?: Picked; sizeMiB: number };

/** A disk image's virtual size from its first bytes (a qcow2's header), else its length. */
const virtualSize = (head: Uint8Array | undefined, bytes: number) =>
  head && head.length >= 32 && new DataView(head.buffer, head.byteOffset).getUint32(0) === 0x514649fb
    ? Number(new DataView(head.buffer, head.byteOffset).getBigUint64(24))
    : bytes;

/**
 * The disk `d` describes for `machine`: undefined if the user declined (a copy into the browser asks first). `onCheck`
 * gets a URL's check (the step shows it); `onProgress` a copy's progress, in words (undefined once it's done).
 */
export async function makeDisk(
  store: Store,
  machine: MachineRecord,
  d: Details,
  onCheck: (c: UrlCheck) => void,
  onProgress: (words: Msg | undefined) => void,
): Promise<DiskRecord | undefined> {
  // A file or URL the browser knows is the same disk again, with its overlays (its handle renewed, if picked with one).
  const reuse = async (n: NewDisk) => {
    const k = await knownDisk(store, n);
    if (k && machine.attachments.some((a) => a.disk === k.id))
      throw new MsgError('disks:add-disk.attachedAlready', { name: k.name });
    if (k && n.kind === 'file' && n.handle) await store.put('disks', { ...k, handle: n.handle });
    return k ?? createDisk(store, n);
  };
  switch (d.source) {
    case 'url': {
      const c = await checkUrl(d.url);
      onCheck(c);
      if (!c.ok) throw new MsgError('disks:add-disk.urlProblems', undefined, { cause: causes(c.problems) });
      const bytes = c.bytes ?? 0;
      return reuse({
        kind: 'url',
        url: d.url,
        name: c.name,
        size: virtualSize(c.head, bytes),
        bytes,
        etag: c.etag,
        lastModified: c.lastModified,
      });
    }
    case 'file': {
      if (!d.picked) throw new MsgError('disks:add-disk.pickFirst');
      const { file, handle } = d.picked;
      const head = new Uint8Array(await file.slice(0, 32).arrayBuffer());
      return reuse({ kind: 'file', file, handle, size: virtualSize(head, file.size) });
    }
    case 'stored':
      if (!d.picked) throw new MsgError('disks:add-disk.pickFirst');
      return storeCopy(store, d.picked.file, onProgress);
    case 'blank':
    case 'ramdisk':
      return createDisk(store, { kind: d.source, size: d.sizeMiB * 2 ** 20 });
  }
}

/** A file copied into the browser: asked first (its size, the room left), the storage made persistent. */
async function storeCopy(store: Store, file: File, onProgress: (words: Msg | undefined) => void) {
  const est = await estimateStored(file);
  const free = await navigator.storage.estimate();
  const sure = await ask.confirm(
    msg('disks:add-disk.store.confirm', {
      name: file.name,
      size: bytesText(est.estimate),
      free: bytesText((free.quota ?? 0) - (free.usage ?? 0)),
    }),
    { title: t('disks:add-disk.store.title'), ok: t('disks:add-disk.store.ok') },
  );
  if (!sure) return undefined;
  await askPersist();
  const d = await importStored(store, file, (f) => {
    onProgress(msg('disks:add-disk.storing', { name: file.name, percent: Math.floor(100 * f) }));
  });
  onProgress(undefined);
  return d;
}
