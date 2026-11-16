// The disk-out worker's compressors: a pool of web/app/deflate-worker.ts, as a `Packer` for `writeQcow2`.
import { coreModule } from '../deflate.ts';
import { fromWire } from '../msg.ts';
import type { Packer } from '../qcow2-write.ts';
import type { DeflateInit, DeflateRequest, DeflateResult } from './deflate-worker.ts';

/**
 * Compression on other threads: deflate is what a compressed export spends its time in, and the machine has
 * stopped, so its cores are free (bench/boot/REPORT.md "SNAPZ loop 6"). Workers of the disk-out worker
 * (web/app/export-worker.ts), each with a batch or two, each given this thread's core first (web/deflate.ts).
 */
export function deflatePool(
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- a probe: not every engine says
  n = Math.max(1, Math.min(4, (navigator.hardwareConcurrency ?? 2) - 1)),
): Packer & { close(): void } {
  const waiting = new Map<number, { resolve(r: (Uint8Array | undefined)[]): void; reject(e: Error): void }>();
  const fail = (e: Error) => {
    for (const w of waiting.values()) w.reject(e);
    waiting.clear();
  };
  const workers = Array.from({ length: n }, () => {
    const w = new Worker(new URL('./deflate-worker.ts', import.meta.url), { type: 'module' });
    w.onmessage = (e: MessageEvent<DeflateResult>) => {
      const m = e.data;
      const asked = waiting.get(m.id);
      waiting.delete(m.id);
      if ('error' in m) {
        asked?.reject(fromWire(m.error));
        return;
      }
      let at = 0;
      asked?.resolve(Array.from(m.lengths, (len) => (len ? m.packed.subarray(at, (at += len)) : undefined)));
    };
    w.onerror = (e) => fail(new Error(`a compressor failed: ${e.message}`));
    return w;
  });
  const ready = coreModule().then((module) => {
    for (const w of workers) w.postMessage({ type: 'init', module } satisfies DeflateInit);
  });
  let next = 0;
  return {
    atOnce: 2 * n,
    pack(clusters) {
      const id = next++;
      const copy = clusters.slice(); // the writer keeps its buffer (a cluster that doesn't shrink is stored from it)
      return ready.then(
        () =>
          new Promise((resolve, reject) => {
            waiting.set(id, { resolve, reject });
            workers[id % n].postMessage({ id, clusters: copy } satisfies DeflateRequest, [copy.buffer]);
          }),
      );
    },
    close() {
      for (const w of workers) w.terminate();
    },
  };
}
