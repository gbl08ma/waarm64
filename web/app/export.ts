// The page's side of the disk-out worker (web/app/export-worker.ts): what to write, where the
// bytes go (a file the user picked, or a Blob for a download), and the progress.
import type { DiskChoice } from './machine.ts';

/** `changes`: a qcow2 with the base image as its backing file; `qcow2`/`raw`: the whole disk. */
export type ExportMode = 'changes' | 'qcow2' | 'raw';

/** Page → worker. */
export type ExportRequest = {
  mode: ExportMode;
  /** The disk (`url` or `file`) and its overlay. */
  disk: DiskChoice;
  /** The base image's file name, which a changes file records as its backing file. */
  baseName: string;
  /** Where to write (from `showSaveFilePicker`); without one the worker sends the bytes back in chunks. */
  handle?: FileSystemFileHandle;
};

/** Worker → page. A chunk with `at` replaces the file's bytes there (the qcow2 header, written last). */
export type ExportResult =
  | { type: 'progress'; phase: string; done: number; total: number }
  | { type: 'chunk'; data: Uint8Array; at?: number }
  | { type: 'done'; bytes: number; blocks: number }
  | { type: 'error'; message: string };

/**
 * Runs an export; resolves to the bytes as a Blob when the request had no `handle`, and rejects
 * with the worker's message. `progress` gets the phase and the fraction.
 */
export function runExport(request: ExportRequest, progress: (phase: string, fraction: number) => void) {
  return new Promise<{ blob?: Blob; bytes: number; blocks: number }>((resolve, reject) => {
    const worker = new Worker(new URL('./export-worker.ts', import.meta.url), { type: 'module' });
    const parts: Blob[] = [];
    worker.onmessage = (e: MessageEvent<ExportResult>) => {
      const m = e.data;
      if (m.type === 'progress') progress(m.phase, m.total ? m.done / m.total : 0);
      else if (m.type === 'chunk') {
        if (m.at === undefined) parts.push(new Blob([m.data as Uint8Array<ArrayBuffer>]));
        else parts[0] = new Blob([m.data as Uint8Array<ArrayBuffer>, parts[0].slice(m.data.length)]); // the header cluster, written last
      } else {
        worker.terminate();
        if (m.type === 'error') reject(new Error(m.message));
        else resolve({ blob: request.handle ? undefined : new Blob(parts), bytes: m.bytes, blocks: m.blocks });
      }
    };
    worker.onerror = (e) => { worker.terminate(); reject(new Error(e.message)); };
    worker.postMessage(request);
  });
}
