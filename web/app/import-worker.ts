// The changes-in worker (docs/frontend.md "Your own disk"): checks a changes file against the disk's
// base image and makes it the disk's overlay (web/changes.ts). A worker for the same reasons as the
// export's (web/app/export-worker.ts): the overlay's sync access handles and the base's synchronous
// reads; the machine must have stopped (the overlay's Web Lock).
import { loadChanges } from '../changes.ts';
import { diskIdentity } from '../devices.ts';
import { blobSource, type Source } from '../disk-sources.ts';
import { makeRoom } from '../diskcache.ts';
import { toWire } from '../msg.ts';
import { openDisk } from '../qcow2.ts';
import type { ImportRequest, ImportResult } from './import.ts';
import { openSource } from './sources.ts';

const post = (m: ImportResult) => self.postMessage(m);

// Every failure is posted, the base's opening's too (a URL disk offline, a stored disk in use or gone): the page waits
// on a message (web/app/import.ts), and a rejection here would reach no one.
self.onmessage = async (e: MessageEvent<ImportRequest>) => {
  const { disk: d, changes, label } = e.data;
  let base: (Source & { close?(): void }) | undefined;
  let result: ImportResult;
  try {
    base = await openSource(d.source);
    const opened = base;
    const r = await loadChanges({
      changes: blobSource(changes),
      base: opened,
      made: 'stored' in d.source ? d.source.made : undefined,
      label,
      overlay: d.overlay,
      identity:
        d.identity ??
        diskIdentity(
          { ...('url' in d.source ? { url: d.source.url } : 'file' in d.source ? { file: d.source.file } : {}) },
          openSize(opened),
        ),
      progress: (phase, done, total) => post({ type: 'progress', phase, done, total }),
      makeRoom,
    });
    result = { type: 'done', blocks: r.blocks };
  } catch (err) {
    result = { type: 'error', error: toWire(err) };
  }
  base?.close?.(); // before the page hears: it goes on with the disk once it has the answer
  post(result);
};

/** The virtual size the overlay's identity records (a qcow2's header, else the file's size). */
function openSize(base: Source) {
  return openDisk((off, len) => (len === 0 ? new Uint8Array(0) : base.read(off, len)), base.size).size;
}
