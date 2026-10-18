// qcow2's compressed clusters inflated on other threads too (web/qcow2.ts `Inflater`): a pool of
// web/inflate-worker.ts for the threads that read disks (the device worker, the disk workers).
import { inflateEach, type Inflater } from './qcow2.ts';
import type { InflateRequest, InflateResult } from './inflate-worker.ts';

/**
 * A request's clusters split between this thread and `n` workers, each a share in one message
 * (a 1 MiB read of a 64 KiB-cluster image is 16 clusters, ~0.4 ms each in Chromium). A single
 * cluster stays here: a guest's small read shouldn't wait on a message's round trip. The workers
 * start with the first request that has several, so an image without compressed clusters costs none;
 * a worker that fails leaves its share, and every later one, to this thread.
 */
export function inflatePool(n = Math.max(1, Math.min(4, (navigator.hardwareConcurrency ?? 2) - 1))): Inflater & { close(): void; sent: number } {
  let workers: Worker[] | undefined;
  let broken = false;
  let next = 0;
  const waiting = new Map<number, { resolve(r: (Uint8Array | undefined)[]): void; reject(e: Error): void }>();
  const fail = (e: Error) => {
    broken = true;
    for (const w of waiting.values()) w.reject(e);
    waiting.clear();
  };
  const start = () => Array.from({ length: n }, () => {
    const w = new Worker(new URL('./inflate-worker.ts', import.meta.url), { type: 'module' });
    w.onmessage = (e: MessageEvent<InflateResult>) => {
      const { id, ok, out } = e.data;
      const asked = waiting.get(id);
      waiting.delete(id);
      const size = out.length / ok.length;
      asked?.resolve(Array.from(ok, (good, k) => (good ? out.subarray(k * size, (k + 1) * size) : undefined)));
    };
    w.onerror = (e) => fail(new Error(`an inflate worker failed: ${e.message}`));
    return w;
  });
  const local = inflateEach;
  const remote = (w: Worker, inputs: Uint8Array[], size: number) => {
    const id = next++;
    const lengths = Uint32Array.from(inputs, (i) => i.length);
    const packed = new Uint8Array(lengths.reduce((a, b) => a + b, 0));
    let at = 0;
    for (const i of inputs) { packed.set(i, at); at += i.length; }
    pool.sent += inputs.length;
    return new Promise<(Uint8Array | undefined)[]>((resolve, reject) => {
      waiting.set(id, { resolve, reject });
      w.postMessage({ id, size, lengths, packed } satisfies InflateRequest, [lengths.buffer, packed.buffer]);
    });
  };
  const pool = Object.assign(async (inputs: Uint8Array[], size: number) => {
    if (inputs.length < 2 || broken) return local(inputs, size);
    workers ??= start();
    // Contiguous shares, as even as the count allows: this thread's first.
    const shares = Math.min(n + 1, inputs.length);
    const parts = await Promise.all(Array.from({ length: shares }, (_, s) => {
      const part = inputs.slice(Math.floor(s * inputs.length / shares), Math.floor((s + 1) * inputs.length / shares));
      return s === 0 ? local(part, size) : remote(workers![s - 1], part, size).catch(() => local(part, size));
    }));
    return parts.flat();
  }, {
    sent: 0,
    close() {
      for (const w of workers ?? []) w.terminate();
      fail(new Error('the inflate pool was closed'));
    },
  });
  return pool;
}
