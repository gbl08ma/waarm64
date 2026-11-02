// The page's side of the disk-out worker (web/app/export-worker.ts): what to write, where the
// bytes go (a file the user picked, or a Blob for a download), and the progress.
import { text } from '../i18n.ts';
import { fromWire, type Msg, type WireError } from '../msg.ts';
import type { DiskRef } from './protocol.ts';

/** `changes`: a qcow2 with the base image as its backing file; `qcow2`/`raw`: the whole disk. */
export type ExportMode = 'changes' | 'qcow2' | 'raw';

/** Page → worker. */
export type ExportRequest = {
  mode: ExportMode;
  /** A qcow2's clusters compressed (deflate) where that makes them smaller. */
  compress?: boolean;
  /** The disk, and the overlay of its changes (none: the disk as it is, a stored disk's whole). */
  disk: DiskRef;
  /** The base image's file name, which a changes file records as its backing file. */
  baseName: string;
  /** Where to write (from `showSaveFilePicker`); without one the worker sends the bytes back in chunks. */
  handle?: FileSystemFileHandle;
};

/** Worker → page. A chunk with `at` replaces the file's bytes there (the qcow2 header, written last). */
export type ExportResult =
  | { type: 'progress'; phase: Msg; done: number; total: number }
  | { type: 'chunk'; data: Uint8Array; at?: number }
  | { type: 'done'; bytes: number; blocks: number }
  | { type: 'error'; error: WireError };

/**
 * Runs an export; resolves to the bytes as a Blob when the request had no `handle`, and rejects
 * with the worker's error. `progress` gets the phase's words and the fraction.
 */
export function runExport(request: ExportRequest, progress: (phase: string, fraction: number) => void) {
  return new Promise<{ blob?: Blob; bytes: number; blocks: number }>((resolve, reject) => {
    const worker = new Worker(new URL('./export-worker.ts', import.meta.url), { type: 'module' });
    const parts: Blob[] = [];
    worker.onmessage = (e: MessageEvent<ExportResult>) => {
      const m = e.data;
      if (m.type === 'progress') progress(text(m.phase), m.total ? m.done / m.total : 0);
      else if (m.type === 'chunk') {
        if (m.at === undefined) parts.push(new Blob([m.data as Uint8Array<ArrayBuffer>]));
        else parts[0] = new Blob([m.data as Uint8Array<ArrayBuffer>, parts[0].slice(m.data.length)]); // the header cluster, written last
      } else {
        worker.terminate();
        if (m.type === 'error') reject(fromWire(m.error));
        else resolve({ blob: request.handle ? undefined : new Blob(parts), bytes: m.bytes, blocks: m.blocks });
      }
    };
    worker.onerror = (e) => { worker.terminate(); reject(new Error(e.message)); };
    worker.postMessage(request);
  });
}
