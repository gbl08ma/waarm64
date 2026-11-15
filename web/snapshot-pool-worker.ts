// A save's pool worker (web/snapshot-pool.ts; docs/platform.md "The snapshot file"): RAM chunks made into frames where
// guest RAM lies (shared memory), each scanned for its zero pages, its pages gathered into a core instance of its own
// (web/lz.ts `codecCore`), compressed by the core's lz4_flex and its frame's CRC-32 taken by the core's crc32fast where
// the codec left the bytes; the frame goes back whole, as web/snapshot-file.ts's writer encodes one.
import { codecCore, MAX } from './lz.ts';
import { frameHeader, gatherPages, scanChunk, type RamFrame } from './snapshot-file.ts';

/** Coordinator → worker: the core first, then RAM chunks (`id` is the coordinator's). */
export type PoolInit = { type: 'init'; module: WebAssembly.Module };
export type PoolJob = { type: 'ram'; id: number; buffer: SharedArrayBuffer; off: number; len: number; index: number };
/** Worker → coordinator: ready (or why not), and each job's frame (or why not). */
export type PoolReply =
  | { type: 'ready' }
  | { type: 'failed'; message: string }
  | ({ type: 'done'; id: number } & RamFrame)
  | { type: 'error'; id: number; message: string };

const BITMAP = 32;
const PAGE = 4096;

type Core = Awaited<ReturnType<typeof codecCore>> & { src: number; dst: number; cap: number };

async function init(module: WebAssembly.Module): Promise<Core> {
  const core = await codecCore(module);
  const cap = core.ex.lz_bound(MAX) >>> 0;
  // `dst` has the frame's header before the stored bytes, so the CRC runs over the frame as it lies.
  const [src, dst] = [core.ex.thread_alloc(MAX, 16) >>> 0, core.ex.thread_alloc(cap + 32, 16) >>> 0];
  if (!cap || !src || !dst) throw new Error('no memory for the snapshot codec');
  return { ...core, src, dst, cap };
}

/** Chunk `index`'s frame (null: zero pages only) from the `len` bytes at `off` of `buffer`. */
function ram(c: Core, buffer: SharedArrayBuffer, off: number, len: number, index: number): RamFrame {
  let t = performance.now();
  const bitmap = new Uint8Array(BITMAP);
  const pages = scanChunk(new Uint32Array(buffer, off, len >>> 2), 0, len, bitmap);
  if (!pages) return { frame: null, pages, scan: performance.now() - t, compress: 0, crc: 0 };
  const mem = new Uint8Array(c.memory.buffer);
  mem.set(bitmap, c.src);
  gatherPages(new Uint8Array(buffer, off, len), 0, len, bitmap, mem, c.src + BITMAP);
  const rawLen = BITMAP + pages * PAGE;
  const scan = performance.now() - t;
  t = performance.now();
  const n = c.ex.lz_compress(c.src, rawLen, c.dst + 32, c.cap) >>> 0;
  if (!n) throw new Error('lz_compress failed');
  const compress = performance.now() - t;
  t = performance.now();
  // Stored as it is when compressing doesn't shrink it (the writer's rule).
  const packed = n < rawLen;
  const stored = packed ? n : rawLen;
  if (!packed) mem.copyWithin(c.dst + 32, c.src, c.src + rawLen);
  const head = frameHeader('RAM ', packed ? 2 : 0, index, rawLen, stored);
  mem.set(head.subarray(0, 24), c.dst);
  const crc = c.ex.crc32(c.ex.crc32(0, c.dst, 24), c.dst + 32, stored) >>> 0;
  const frame = mem.slice(c.dst, c.dst + 32 + stored);
  frame.set(head.subarray(24), 24);
  new DataView(frame.buffer).setUint32(24, crc, true);
  return { frame, pages, scan, compress, crc: performance.now() - t };
}

function serve(post: (m: PoolReply, transfer?: ArrayBuffer[]) => void, listen: (on: (m: PoolInit | PoolJob) => void) => void) {
  let core: Promise<Core> | undefined;
  listen((m) => {
    if (m.type === 'init') {
      core = init(m.module);
      core.then(() => post({ type: 'ready' }), (e: unknown) => post({ type: 'failed', message: String((e as Error)?.message ?? e) }));
      return;
    }
    const { id } = m;
    if (!core) return post({ type: 'error', id, message: 'a job before the core' }); // i18n-ignore: never shown (the writer makes a failed chunk itself)
    core.then((c) => {
      const r = ram(c, m.buffer, m.off, m.len, m.index);
      post({ type: 'done', id, ...r }, r.frame ? [r.frame.buffer as ArrayBuffer] : []);
    }).catch((e: unknown) => post({ type: 'error', id, message: String((e as Error)?.message ?? e) }));
  });
}

if ('WorkerGlobalScope' in globalThis) {
  const self = globalThis as unknown as { onmessage: (e: MessageEvent<PoolInit | PoolJob>) => void; postMessage(m: unknown, t?: Transferable[]): void };
  serve((m, t) => self.postMessage(m, t ?? []), (on) => { self.onmessage = (e) => on(e.data); });
} else {
  const { parentPort } = await import('node:worker_threads');
  serve((m, t) => parentPort!.postMessage(m, t ?? []), (on) => parentPort!.on('message', on));
}
