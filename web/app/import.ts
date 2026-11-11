// The page's side of the changes-in worker (web/app/import-worker.ts).
import { text } from '../i18n.ts';
import { fromWire, type Msg, type WireError } from '../msg.ts';
import type { DiskRef } from './protocol.ts';

/** Page → worker: the changes file, and the disk (`url` or `file`, with its overlay) it goes onto; `label` names the disk in messages. */
export type ImportRequest = { changes: File; disk: DiskRef & { overlay: string }; label: string };

/** Worker → page. */
export type ImportResult =
  | { type: 'progress'; phase: Msg; done: number; total: number }
  | { type: 'done'; blocks: number }
  | { type: 'error'; error: WireError };

/** Loads the changes; rejects with the error to show the user. `progress` gets the phase's words and the fraction. */
export function runImport(request: ImportRequest, progress: (phase: string, fraction: number) => void) {
  return new Promise<{ blocks: number }>((resolve, reject) => {
    const worker = new Worker(new URL('./import-worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e: MessageEvent<ImportResult>) => {
      const m = e.data;
      if (m.type === 'progress') return progress(text(m.phase), m.total ? m.done / m.total : 0);
      worker.terminate();
      if (m.type === 'error') reject(fromWire(m.error));
      else resolve({ blocks: m.blocks });
    };
    worker.onerror = (e) => {
      worker.terminate();
      reject(new Error(e.message));
    };
    worker.postMessage(request);
  });
}
