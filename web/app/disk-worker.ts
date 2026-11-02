// The stored disks' jobs (docs/machines.md §4.4): an image's estimate and its import into the browser, and an
// overlay merged into its stored disk. A worker for the sync access handles and the synchronous reads of a `File`
// (web/stored.ts); the page (web/app/disks.ts) runs one per job.
import { blobSource } from '../devices.ts';
import { inflatePool } from '../inflate-pool.ts';
import { toWire, type WireError } from '../msg.ts';
import { importImage, mergeOverlay, openStoredForWriting, storedEstimate } from '../stored.ts';

export type DiskJob =
  | { type: 'estimate'; file: File }
  | { type: 'import'; file: File; path: string; identity: string }
  | { type: 'merge'; disk: string; overlay: string; identity: string; size: number };

export type DiskJobResult =
  | { type: 'progress'; done: number; total: number }
  | { type: 'done'; size?: number; format?: string; estimate?: number; blocks?: number }
  | { type: 'error'; error: WireError };

const post = (m: DiskJobResult) => self.postMessage(m);

self.onmessage = async (e: MessageEvent<DiskJob>) => {
  const j = e.data;
  try {
    if (j.type === 'estimate') {
      post({ type: 'done', ...storedEstimate(blobSource(j.file)) });
    } else if (j.type === 'import') {
      const files = await openStoredForWriting(j.path, j.identity, 0);
      const pool = inflatePool();
      try {
        const r = await importImage(blobSource(j.file), files, (done, total) => post({ type: 'progress', done, total }), pool);
        post({ type: 'done', size: r.size, format: r.format, blocks: r.blocks });
      } finally {
        files.close();
        pool.close();
      }
    } else {
      post({ type: 'done', blocks: await mergeOverlay(j.disk, j.overlay, j.identity, j.size) });
    }
  } catch (err) {
    post({ type: 'error', error: toWire(err) });
  }
};
