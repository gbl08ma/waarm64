// A snapshot file imported into a stored machine's kept snapshots (docs/machines.md §5.2 "Import a file"): its header
// checked, the file copied into the machine's `snapshots/` (room made when the storage is full), its record after.
import { opfsDir, storageFullError } from '../overlay.ts';
import { makeRoom } from '../diskcache.ts';
import { readHeader } from '../snapshot-file.ts';
import type { SnapshotDisk } from '../snapshot.ts';
import { MsgError } from '../i18n.ts';
import { newId, type Shape } from './shape.ts';
import { basesIn } from './snapshot-lost.ts';
import type { Store } from './store.ts';

/** Imports a snapshot file into machine `machine`'s kept snapshots (its header read first; one of another shape is kept, orphaned). */
export async function importSnapshot(store: Store, machine: string, file: File) {
  const header = await readHeader(file);
  if (typeof header.shapeHash !== 'string' || !header.shape)
    throw new MsgError(
      'snapshots:snapshot-import.notKept',
      { file: file.name },
      { cause: new MsgError('snapshots:snapshot-import.notKept.cause') },
    );
  const id = newId();
  return store.writing(async () => {
    const dir = await opfsDir(`machines/${machine}/snapshots`, true);
    const copy = async () =>
      file.stream().pipeTo(await (await dir.getFileHandle(id, { create: true })).createWritable());
    const full = (e: unknown) => (e as { name?: unknown } | null | undefined)?.name === 'QuotaExceededError';
    try {
      // The storage full: the remote disks' kept blocks go (`makeRoom`), and it's copied once more.
      await copy().catch(async (e: unknown) => {
        if (full(e) && (await makeRoom())) return copy();
        throw e;
      });
    } catch (e) {
      await dir.removeEntry(id).catch(() => undefined); // tidying up: the failure thrown is the one to report
      if (full(e))
        throw new MsgError(
          'snapshots:snapshot-import.notKept',
          { file: file.name },
          { cause: await storageFullError() },
        );
      throw e;
    }
    const pins = ((header.disks ?? []) as SnapshotDisk[]).map((p) => ({
      slot: p.slot,
      overlay: p.overlay,
      generation: p.generation,
      blocks: p.blocks,
      ram: p.ram,
    }));
    const rec = {
      id,
      machine,
      name: file.name.replace(/\.waarm64snap$/, ''),
      created: Date.parse(header.created) || Date.now(),
      bytes: file.size,
      shape: header.shape as Shape,
      shapeHash: header.shapeHash as string,
      pins,
      urls: header.urls as Record<number, string> | undefined,
      bases: basesIn(header),
      coreVersion: header.coreVersion,
    };
    await store.put('snapshots', rec);
    return rec;
  });
}
