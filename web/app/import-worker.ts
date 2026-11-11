// The changes-in worker (docs/frontend.md "Your own disk"): checks a changes file against the disk's
// base image and makes it the disk's overlay (web/changes.ts). A worker for the same reasons as the
// export's (web/app/export-worker.ts): the overlay's sync access handles and the base's synchronous
// reads; the machine must have stopped (the overlay's Web Lock).
import { loadChanges } from '../changes.ts';
import { blobSource, diskIdentity, type Source } from '../devices.ts';
import { makeRoom } from '../diskcache.ts';
import { toWire } from '../msg.ts';
import { openDisk } from '../qcow2.ts';
import type { ImportRequest, ImportResult } from './import.ts';
import { openSource } from './sources.ts';

const post = (m: ImportResult) => self.postMessage(m);

self.onmessage = async (e: MessageEvent<ImportRequest>) => {
  const { disk: d, changes, label } = e.data;
  const base = await openSource(d.source);
  loadChanges({
    changes: blobSource(changes),
    base,
    label,
    overlay: d.overlay,
    identity:
      d.identity ??
      diskIdentity(
        { ...('url' in d.source ? { url: d.source.url } : 'file' in d.source ? { file: d.source.file } : {}) },
        openSize(base),
      ),
    progress: (phase, done, total) => post({ type: 'progress', phase, done, total }),
    makeRoom,
  })
    .finally(() => base.close?.())
    .then(
      (r) => post({ type: 'done', blocks: r.blocks }),
      (err: unknown) => post({ type: 'error', error: toWire(err) }),
    );
};

/** The virtual size the overlay's identity records (a qcow2's header, else the file's size). */
function openSize(base: Source) {
  return openDisk((off, len) => (len === 0 ? new Uint8Array(0) : base.read(off, len)), base.size).size;
}
