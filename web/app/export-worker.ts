// The disk-out worker (docs/frontend.md "Your own disk"): writes a disk's changes, or the whole
// disk, to a file. It runs in a worker because the overlay's OPFS handles and the base image's
// synchronous reads (a `File`'s slices, HTTP ranges) are worker-only, and it takes the overlay's
// Web Lock, so the machine must have stopped (the page stops it first). The output goes to a file
// handle the page got from `showSaveFilePicker`, or, without one, back to the page in chunks.
import { hashSource } from '../changes.ts';
import { diskIdentity, type Source } from '../devices.ts';
import { msg, MsgError, toWire, type Msg } from '../msg.ts';
import { countOf, openOverlay, overlay, type WritableDisk } from '../overlay.ts';
import { openDisk, type Disk } from '../qcow2.ts';
import {
  changedClusters,
  nonZeroClusters,
  rawChunks,
  writeQcow2,
  type DataCluster,
  type Sink,
} from '../qcow2-write.ts';
import { inflatePool } from '../inflate-pool.ts';
import { deflatePool } from './deflate-pool.ts';
import type { ExportRequest, ExportResult } from './export.ts';
import { openSource } from './sources.ts';

const post = (m: ExportResult, transfer: Transferable[] = []) => self.postMessage(m, { transfer });

self.onmessage = (e: MessageEvent<ExportRequest>) => {
  exportDisk(e.data).then(
    (r) => post({ type: 'done', ...r }),
    (err: unknown) => post({ type: 'error', error: toWire(err) }),
  );
};

async function exportDisk(r: ExportRequest) {
  const d = r.disk;
  const src = await openSource(d.source);
  const inflater = inflatePool(); // a qcow2 base's compressed clusters
  const base = openDisk((off, len) => (len === 0 ? new Uint8Array(0) : src.read(off, len)), src.size, inflater);
  // Waits for the machine's worker to let go of the overlay. A disk without one is exported as it is (a stored disk).
  const files = d.overlay
    ? await openOverlay(d.overlay, d.identity ?? identityOf(d.source, base.size)).catch((e: unknown) => {
        src.close?.();
        inflater.close();
        throw e;
      })
    : undefined;
  let out: FileSystemWritableFileStream | undefined;
  try {
    // With its meta: a grown overlay is exported at its own size (docs/machines.md §4.5; a changes file larger than its backing file).
    const disk = files ? overlay(base, files.data, files.map, files.meta) : undefined;
    out = r.handle ? await r.handle.createWritable() : undefined;
    const sink = sinkTo(out);
    if (r.mode === 'changes' && !disk) throw new MsgError('disks:export-worker.noChanges');
    const blocks =
      r.mode === 'raw' ? await writeRaw(disk ?? base, sink) : await writeImage(r, { src, base, disk }, sink);
    await out?.close();
    out = undefined;
    return { bytes: sink.written(), blocks };
  } finally {
    // Left open only by a failure (the one reported); an abort that fails has nothing to add to it.
    await out?.abort().catch(() => undefined);
    files?.close();
    src.close?.();
    inflater.close();
  }
}

/** The identity an overlay was made for, when the page didn't send it: the source's URL or file and the size. */
function identityOf(source: ExportRequest['disk']['source'], size: number) {
  return diskIdentity(
    { ...('url' in source ? { url: source.url } : 'file' in source ? { file: source.file } : {}) },
    size,
  );
}

const progress = (phase: Msg, done: number, total: number) => post({ type: 'progress', phase, done, total });

/** Writes to the file, or back to the page in chunks; counts what it appends. */
function sinkTo(out: FileSystemWritableFileStream | undefined): Sink & { written(): number } {
  let written = 0;
  const sink: Sink = async (chunk, at) => {
    if (out) {
      if (at === undefined) await out.write(chunk as Uint8Array<ArrayBuffer>);
      else {
        await out.write({ type: 'write', position: at, data: chunk as Uint8Array<ArrayBuffer> });
        await out.seek(written);
      }
    } else {
      const copy = chunk.slice(); // the writer may reuse nothing, but a transferred buffer must be ours alone
      post({ type: 'chunk', data: copy, at }, [copy.buffer]);
    }
    if (at === undefined) written += chunk.length;
  };
  return Object.assign(sink, { written: () => written });
}

/** The disk as a raw image; no blocks counted. */
async function writeRaw(whole: Disk, sink: Sink & { written(): number }) {
  for await (const chunk of rawChunks(whole)) {
    await sink(chunk);
    progress(msg('disks:export-worker.writingDisk'), sink.written(), whole.size);
  }
  return 0;
}

/** A qcow2: the disk's changes over its base (a changes file), or the whole disk; the blocks written. */
async function writeImage(
  r: ExportRequest,
  { src, base, disk }: { src: Source; base: Disk; disk: WritableDisk | undefined },
  sink: Sink,
) {
  const whole = disk ?? base;
  let clusters;
  let backing;
  if (r.mode === 'changes') {
    if (!disk) throw new Error('changes asked of a disk without an overlay');
    const hash = await hashSource(src, (done) => progress(msg('disks:export-worker.readingBase'), done, src.size));
    backing = { name: r.baseName, format: base.format, hash };
    clusters = progressOf(changedClusters(disk), countOf(disk.written()), (done, total) =>
      progress(msg('disks:export-worker.writingChanges'), done, total),
    );
  } else {
    // A source that knows its held blocks (a stored disk, a blank one) under a raw base: only those (and the
    // overlay's) are read, not the whole size.
    const held =
      base.format === 'raw' && src.held ? (disk ? union(disk.written(), src.held()) : src.held()) : undefined;
    clusters = nonZeroClusters(
      whole,
      1 << 20,
      (done) => progress(msg('disks:export-worker.writingDisk'), done, whole.size),
      held,
    );
  }
  const pool = r.compress ? deflatePool() : undefined;
  try {
    return (await writeQcow2({ size: whole.size, clusters, backing, compress: pool, sink })).clusters;
  } finally {
    pool?.close();
  }
}

/** Two ascending walks of blocks as one, each block once. */
function* union(a: Iterable<number>, b: Iterable<number>) {
  const [x, y] = [a[Symbol.iterator](), b[Symbol.iterator]()];
  let [p, q] = [x.next(), y.next()];
  while (!p.done || !q.done) {
    if (q.done || (!p.done && p.value < q.value)) {
      yield p.value;
      p = x.next();
    } else if (p.done || q.value < p.value) {
      yield q.value;
      q = y.next();
    } else {
      yield p.value;
      [p, q] = [x.next(), y.next()];
    }
  }
}

/** `clusters`, with `progress` told every 256 of them. */
async function* progressOf(
  clusters: AsyncIterable<DataCluster>,
  total: number,
  progress: (done: number, total: number) => void,
) {
  let done = 0;
  for await (const c of clusters) {
    yield c;
    if (++done % 256 === 0) progress(done, total);
  }
}
