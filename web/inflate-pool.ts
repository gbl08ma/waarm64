// qcow2's compressed clusters inflated on other threads too (web/qcow2.ts `Inflater`): a pool of
// web/inflate-worker.ts for the threads that read disks (the device worker, the disk workers).
import { coreModule } from './deflate.ts';
import { inflateEach, type Inflater } from './qcow2.ts';
import type { InflateInit, InflateRequest, InflateResult } from './inflate-worker.ts';

/** How long a request may go unanswered before its worker counts as failed (a share takes milliseconds). */
export const INFLATE_STALL_MS = 10_000;

/**
 * A request's clusters split between this thread and `n` workers, each a share in one message
 * (a 1 MiB read of a 64 KiB-cluster image is 16 clusters, ~0.4 ms each in Chromium). A single
 * cluster stays here: a guest's small read shouldn't wait on a message's round trip. The workers
 * start with the first request that has several, so an image without compressed clusters costs none (each gets
 * this thread's core first: web/deflate.ts `coreModule`);
 * a worker that fails (an error, a request it says it couldn't do, or no answer in `stallMs`) leaves its share, and
 * every later one, to this thread. `worker` makes a worker (tests give their own).
 */
export function inflatePool(
  n = Math.max(1, Math.min(4, (navigator.hardwareConcurrency ?? 2) - 1)),
  o: { worker?: () => Worker; stallMs?: number } = {},
): Inflater & { close(): void; sent: number } {
  const {
    worker = () => new Worker(new URL('./inflate-worker.ts', import.meta.url), { type: 'module' }),
    stallMs = INFLATE_STALL_MS,
  } = o;
  let workers: Promise<Worker[]> | undefined;
  let started: Worker[] = [];
  let broken = false;
  let next = 0;
  const waiting = new Map<number, { resolve(r: (Uint8Array | undefined)[]): void; reject(e: Error): void }>();
  const fail = (e: Error) => {
    broken = true;
    for (const w of waiting.values()) w.reject(e);
    waiting.clear();
  };
  const start = (module: WebAssembly.Module) =>
    Array.from({ length: n }, () => {
      const w = worker();
      w.postMessage({ type: 'init', module } satisfies InflateInit);
      w.onmessage = (e: MessageEvent<InflateResult>) => {
        if ('error' in e.data) return fail(new Error(`an inflate worker failed: ${e.data.error}`));
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
    for (const i of inputs) {
      packed.set(i, at);
      at += i.length;
    }
    pool.sent += inputs.length;
    return new Promise<(Uint8Array | undefined)[]>((resolve, reject) => {
      // A worker that never answers (lost, stuck) would hold the guest's read for good.
      const stall = setTimeout(() => fail(new Error('an inflate worker stopped answering')), stallMs);
      const settled =
        <T>(f: (v: T) => void) =>
        (v: T) => {
          clearTimeout(stall);
          f(v);
        };
      waiting.set(id, { resolve: settled(resolve), reject: settled(reject) });
      w.postMessage({ id, size, lengths, packed } satisfies InflateRequest, [lengths.buffer, packed.buffer]);
    });
  };
  const pool = Object.assign(
    async (inputs: Uint8Array[], size: number) => {
      if (inputs.length < 2 || broken) return local(inputs, size);
      const ws = await (workers ??= coreModule().then((m) => (started = start(m))));
      // Contiguous shares, as even as the count allows: this thread's first.
      const shares = Math.min(n + 1, inputs.length);
      const parts = await Promise.all(
        Array.from({ length: shares }, (_, s) => {
          const part = inputs.slice(
            Math.floor((s * inputs.length) / shares),
            Math.floor(((s + 1) * inputs.length) / shares),
          );
          return s === 0 ? local(part, size) : remote(ws[s - 1], part, size).catch(() => local(part, size));
        }),
      );
      return parts.flat();
    },
    {
      sent: 0,
      close() {
        for (const w of started) w.terminate();
        fail(new Error('the inflate pool was closed'));
      },
    },
  );
  return pool;
}
