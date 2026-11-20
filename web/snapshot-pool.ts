// A snapshot's pool (docs/platform.md "The snapshot file", SNAPZ's decision 2): workers (web/snapshot-pool-worker.ts)
// that make RAM's frames from guest RAM where it lies, for web/snapshot-file.ts's writer (`RamPool`), and that check a
// reader's frames and put RAM's pages straight into guest RAM (`LoadPool`). For a save, chunk c goes to worker c mod n;
// the writer writes the frames in order, so the file's bytes are the same for any n and for none. Started per save
// before the pause (web/app/worker-snapshot.ts) and per load with the restore (web/app/worker-start.ts `openRestore`),
// closed after it: no worker stays between them.
import type { FrameTimes, LoadPool, RamFrame, RamPool } from './snapshot-file.ts';
import type { PoolInit, PoolJob, PoolReply } from './snapshot-pool-worker.ts';

/** What a load's piece came to: the jobs its worker failed, and the times. */
type Loaded = { failed: number[] } & FrameTimes;

/** At most this many workers: past ~6 the pool gave little more (bench/boot/REPORT.md "SNAPZ: compression…"). */
export const POOL_MAX = 6;
/** The worker's file for Node's worker_threads (a lookup, so the page's bundler doesn't copy it as an asset). */
const NODE_WORKER = { pool: './snapshot-pool-worker.ts' };

/** The pool's size on a host of `cores` threads: one fewer (the machine worker's), at most {@link POOL_MAX}. */
export function poolSize(cores = globalThis.navigator?.hardwareConcurrency ?? 1): number {
  return Math.max(0, Math.min(cores - 1, POOL_MAX));
}

/**
 * A pool that is ready: `readyMs` from its start to its last worker's instance; `buffers()`, the frame buffers its
 * workers have made so far for a save (each about 1 MiB; written frames' go back to their worker: `recycle`). `close`
 * ends its workers.
 */
export type SavePool = RamPool & LoadPool & { readyMs: number; buffers(): number; close(): void };

type Handle = { post(m: PoolInit | PoolJob, transfer?: ArrayBuffer[]): void; terminate(): void };
/** Makes a worker, its replies to `heard` and its failure to `failed` (tests give their own). */
export type Spawn = (heard: (m: PoolReply) => void, failed: (e: Error) => void) => Promise<Handle>;

/** A worker, its replies to `heard` and its failure (an error it didn't catch, a message it couldn't read) to `failed`. */
export const poolWorker: Spawn = async (heard, failed) => {
  if (typeof Worker !== 'undefined') {
    const w = new Worker(new URL('./snapshot-pool-worker.ts', import.meta.url), { type: 'module' });
    w.onmessage = (e: MessageEvent<PoolReply>) => heard(e.data);
    w.onerror = (e) => {
      // Handled here: not cancelled, a worker's error goes on to its parent's scope, and from the machine worker to the
      // page, which takes it for the machine's crash (the HTML spec's "report an exception" for nested workers).
      e.preventDefault();
      failed(new Error(`a snapshot pool worker failed: ${e.message}`));
    };
    w.onmessageerror = () => failed(new Error("a snapshot pool worker's reply could not be read"));
    return { post: (m, t) => w.postMessage(m, t ?? []), terminate: () => w.terminate() };
  }
  const { Worker: NodeWorker } = await import('node:worker_threads');
  const w = new NodeWorker(new URL(NODE_WORKER.pool, import.meta.url));
  w.on('message', heard);
  w.on('error', (e: Error) => failed(new Error(`a snapshot pool worker failed: ${e.message}`)));
  w.on('messageerror', () => failed(new Error("a snapshot pool worker's reply could not be read")));
  return { post: (m, t) => w.postMessage(m, t ?? []), terminate: () => void w.terminate() };
};

/** How long a pool may go without a reply while it has work out before it counts as failed (a job lost or stuck). */
export const STALL_MS = 10_000;

/**
 * Starts `n` workers on the core `module` and resolves once each has its instance; undefined when the pool can't
 * start (`n` < 1, no worker, a failed instance, not ready in `timeoutMs`): the save then runs on one thread. A worker
 * that fails later (an error, a reply it couldn't send), or a pool with work out and no reply for `stallMs`, fails
 * the whole pool: every job in flight, on any worker, and every later one, which the writer (or the reader) does on
 * its own thread; its workers are ended at once, so none goes on with a job given up.
 */
export async function startPool(
  module: WebAssembly.Module,
  n = poolSize(),
  o: { timeoutMs?: number; stallMs?: number; spawn?: Spawn } = {},
): Promise<SavePool | undefined> {
  if (n < 1) return undefined;
  const { timeoutMs = 10_000, stallMs = STALL_MS, spawn: make = poolWorker } = o;
  const t0 = performance.now();
  // A job's reply: a save's frame, or a load's times.
  const waiting = new Map<number, { resolve(r: RamFrame | Loaded): void; reject(e: Error): void; worker: number }>();
  /** Each worker's frame buffers made so far (its last reply's). */
  const made: number[] = Array.from({ length: n }, () => 0);
  let broken: Error | undefined;
  let handles: Handle[] = [];
  const end = () => {
    for (const h of handles) h.terminate();
  };
  /** No reply for `stallMs` while jobs are out: the pool has failed. */
  let stall: ReturnType<typeof setTimeout> | undefined;
  const watch = () => {
    clearTimeout(stall);
    stall = waiting.size
      ? setTimeout(() => fail(new Error('a snapshot pool worker stopped answering')), stallMs)
      : undefined;
  };
  const fail = (e: Error) => {
    broken ??= e;
    end();
    for (const w of waiting.values()) w.reject(e);
    waiting.clear();
    watch();
  };
  let ready = 0;
  /** The size of the workers' frame buffers (their `ready`'s): a frame in one is given back to its worker. */
  let frameSize = 0;
  let settle: (ok: boolean) => void = () => {};
  const started = new Promise<boolean>((resolve) => {
    settle = resolve;
  });
  const heard = (m: PoolReply) => {
    if (m.type === 'ready') {
      frameSize = m.frame;
      if (++ready === n) settle(true);
    } else if (m.type === 'failed') settle(false);
    else {
      const w = waiting.get(m.id);
      waiting.delete(m.id);
      if (m.type === 'done' && w) made[w.worker] = m.buffers;
      if (m.type === 'done') w?.resolve(m);
      else if (m.type === 'loaded') w?.resolve({ failed: m.failed, crc: m.crc, unpack: m.unpack, apply: m.apply });
      else w?.reject(new Error(m.message));
      watch();
    }
  };
  const failed = (e: Error) => {
    settle(false);
    fail(e);
  };
  // Every worker made is ended if one can't be.
  const spawned = await Promise.allSettled(Array.from({ length: n }, () => make(heard, failed)));
  handles = spawned.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []));
  if (handles.length < n) {
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
  /** Each worker's load pieces not yet done: the next goes to the one with fewest. */
  const busy: number[] = handles.map(() => 0);
  const idlest = () => busy.indexOf(Math.min(...busy));
  /** Each worker's written frames' buffers, to go back with its next job. */
  const back: ArrayBuffer[][] = handles.map(() => []);
  /** Job `m` (its `id` given here) on worker `k`, its reply as `T`; a broken pool's at once. */
  function ask<T extends RamFrame | Loaded>(k: number, m: PoolJob, transfer?: ArrayBuffer[]): Promise<T> {
    if (broken) return Promise.reject(broken);
    return new Promise<T>((resolve, reject) => {
      waiting.set(m.id, { resolve: resolve as (r: RamFrame | Loaded) => void, reject, worker: k });
      if (waiting.size === 1) watch();
      try {
        handles[k].post(m, transfer);
      } catch (e) {
        waiting.delete(m.id);
        watch();
        reject(e as Error);
      }
    });
  }
  return {
    size: n,
    readyMs: performance.now() - t0,
    ram(buffer, off, len, index) {
      if (broken) return Promise.reject(broken);
      const give = back[index % n].splice(0);
      return ask<RamFrame>(index % n, { type: 'ram', id: next++, buffer, off, len, index, give }, give);
    },
    frames(piece, jobs) {
      const k = idlest();
      busy[k]++;
      return ask<Loaded>(k, { type: 'frames', id: next++, piece, jobs }, [piece]).finally(() => busy[k]--);
    },
    buffers: () => made.reduce((a, b) => a + b, 0),
    recycle(frame, index) {
      // Only a worker's own buffers (a frame the writer made itself, after a failure, is of its own size).
      const b = frame.buffer;
      if (!broken && b instanceof ArrayBuffer && b.byteLength === frameSize && !b.detached) back[index % n].push(b);
    },
    close() {
      end();
      fail(new Error('the snapshot pool was closed'));
    },
  };
}
