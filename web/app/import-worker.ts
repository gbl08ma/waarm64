// The changes-in worker (docs/frontend.md "Your own disk"): checks a changes file against the disk's
// base image and makes it the disk's overlay (web/changes.ts). A worker for the same reasons as the
// export's (web/app/export-worker.ts): the overlay's sync access handles and the base's synchronous
// reads; the machine must have stopped (the overlay's Web Lock).
import { loadChanges } from '../changes.ts';
import { blobSource, diskIdentity, httpSource } from '../devices.ts';
import { openDisk } from '../qcow2.ts';
import type { ImportRequest, ImportResult } from './import.ts';

const post = (m: ImportResult) => self.postMessage(m);

self.onmessage = (e: MessageEvent<ImportRequest>) => {
  const { disk: d, changes, label } = e.data;
  const base = d.file ? blobSource(d.file) : httpSource(d.url!);
  loadChanges({
    changes: blobSource(changes),
    base,
    label,
    overlay: d.overlay,
    identity: diskIdentity({ url: d.url ?? '', file: d.file }, openSize(base)),
    progress: (phase, done, total) => post({ type: 'progress', phase, done, total }),
  }).then(
    (r) => post({ type: 'done', blocks: r.blocks }),
    (err) => post({ type: 'error', message: String((err as Error).message ?? err) }),
  );
};

/** The virtual size the overlay's identity records (a qcow2's header, else the file's size). */
function openSize(base: ReturnType<typeof blobSource>) {
  return openDisk((off, len) => (len === 0 ? new Uint8Array(0) : base.read(off, len)), base.size).size;
}
