// A save's pool (docs/platform.md "The snapshot file", SNAPZ's decision 2): workers that make RAM's frames from guest
// RAM where it lies (web/snapshot-pool-worker.ts), for web/snapshot-file.ts's writer (`RamPool`). Chunk c goes to worker
// c mod n; the writer writes the frames in order, so the file's bytes are the same for any n and for none. Started per
// save before the pause (web/app/worker-snapshot.ts), closed after it: no worker stays between saves.
import type { RamFrame, RamPool } from './snapshot-file.ts';
import type { PoolInit, PoolJob, PoolReply } from './snapshot-pool-worker.ts';

/** At most this many workers: past ~6 the pool gave little more (bench/boot/REPORT.md "SNAPZ: compression…"). */
export const POOL_MAX = 6;
/** The worker's file for Node's worker_threads (a lookup, so the page's bundler doesn't copy it as an asset). */
const NODE_WORKER = { pool: './snapshot-pool-worker.ts' };

/** The pool's size on a host of `cores` threads: one fewer (the machine worker's), at most {@link POOL_MAX}. */
export function poolSize(cores = globalThis.navigator?.hardwareConcurrency ?? 1): number {
  return Math.max(0, Math.min(cores - 1, POOL_MAX));
}

/** A pool that is ready: `readyMs` from its start to its last worker's instance. `close` ends its workers. */
export type SavePool = RamPool & { readyMs: number; close(): void };

type Handle = { post(m: PoolInit | PoolJob): void; terminate(): void };

/** A worker, its replies to `heard` and its failure to `failed`. */
async function spawn(heard: (m: PoolReply) => void, failed: (e: Error) => void): Promise<Handle> {
  if (typeof Worker !== 'undefined') {
    const w = new Worker(new URL('./snapshot-pool-worker.ts', import.meta.url), { type: 'module' });
    w.onmessage = (e: MessageEvent<PoolReply>) => heard(e.data);
    w.onerror = (e) => failed(new Error(`a snapshot pool worker failed: ${e.message}`));
    return { post: (m) => w.postMessage(m), terminate: () => w.terminate() };
  }
  const { Worker: NodeWorker } = await import('node:worker_threads');
  const w = new NodeWorker(new URL(NODE_WORKER.pool, import.meta.url));
  w.on('message', heard);
  w.on('error', (e: Error) => failed(new Error(`a snapshot pool worker failed: ${e.message}`)));
  return { post: (m) => w.postMessage(m), terminate: () => void w.terminate() };
}

/**
 * Starts `n` workers on the core `module` and resolves once each has its instance; undefined when the pool can't
 * start (`n` < 1, no worker, a failed instance, not ready in `timeoutMs`): the save then runs on one thread. A worker
 * that fails later fails its chunks and every later one, which the writer makes on its own thread.
 */
export async function startPool(module: WebAssembly.Module, n = poolSize(), timeoutMs = 10_000): Promise<SavePool | undefined> {
  if (n < 1) return undefined;
  const t0 = performance.now();
  const waiting = new Map<number, { resolve(r: RamFrame): void; reject(e: Error): void }>();
  let broken: Error | undefined;
  const fail = (e: Error) => {
    broken ??= e;
    for (const w of waiting.values()) w.reject(e);
    waiting.clear();
  };
  let ready = 0;
  let settle: (ok: boolean) => void = () => {};
  const started = new Promise<boolean>((resolve) => { settle = resolve; });
  const heard = (m: PoolReply) => {
    if (m.type === 'ready') {
      if (++ready === n) settle(true);
    } else if (m.type === 'failed') settle(false);
    else {
      const w = waiting.get(m.id);
      waiting.delete(m.id);
      if (m.type === 'done') w?.resolve(m);
      else w?.reject(new Error(m.message));
    }
  };
  const failed = (e: Error) => {
    settle(false);
    fail(e);
  };
  let handles: Handle[] = [];
  const end = () => { for (const h of handles) h.terminate(); };
  try {
    handles = await Promise.all(Array.from({ length: n }, () => spawn(heard, failed)));
  } catch {
    end();
    return undefined;
  }
  for (const h of handles) h.post({ type: 'init', module });
  const timer = setTimeout(() => settle(false), timeoutMs);
  const ok = await started;
  clearTimeout(timer);
  if (!ok || broken) {
    end();
    return undefined;
  }
  let next = 0;
  return {
    size: n,
    readyMs: performance.now() - t0,
    ram(buffer, off, len, index) {
      if (broken) return Promise.reject(broken);
      const id = next++;
      return new Promise<RamFrame>((resolve, reject) => {
        waiting.set(id, { resolve, reject });
        handles[index % n].post({ type: 'ram', id, buffer, off, len, index });
      });
    },
    close() {
      end();
      fail(new Error('the snapshot pool was closed'));
    },
  };
}
