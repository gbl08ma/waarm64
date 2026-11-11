// The disk-out worker (docs/frontend.md "Your own disk"): writes a disk's changes, or the whole
// disk, to a file. It runs in a worker because the overlay's OPFS handles and the base image's
// synchronous reads (a `File`'s slices, HTTP ranges) are worker-only, and it takes the overlay's
// Web Lock, so the machine must have stopped (the page stops it first). The output goes to a file
// handle the page got from `showSaveFilePicker`, or, without one, back to the page in chunks.
import { hashSource } from '../changes.ts';
import { diskIdentity } from '../devices.ts';
import { msg, MsgError, toWire, type Msg } from '../msg.ts';
import { openOverlay, overlay } from '../overlay.ts';
import { openDisk } from '../qcow2.ts';
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
    (err) => post({ type: 'error', error: toWire(err) }),
  );
};

async function exportDisk(r: ExportRequest) {
  const d = r.disk;
  const src = await openSource(d.source);
  const inflater = inflatePool(); // a qcow2 base's compressed clusters
  const base = openDisk((off, len) => (len === 0 ? new Uint8Array(0) : src.read(off, len)), src.size, inflater);
  // Waits for the machine's worker to let go of the overlay. A disk without one is exported as it is (a stored disk).
  const files = d.overlay
    ? await openOverlay(
        d.overlay,
        d.identity ??
          diskIdentity(
            { ...('url' in d.source ? { url: d.source.url } : 'file' in d.source ? { file: d.source.file } : {}) },
            base.size,
          ),
      ).catch((e) => {
        src.close?.();
        inflater.close();
        throw e;
      })
    : undefined;
  let out: FileSystemWritableFileStream | undefined;
  try {
    const disk = files ? overlay(base, files.data, files.map) : undefined;
    out = r.handle ? await r.handle.createWritable() : undefined;
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
    const progress = (phase: Msg, done: number, total: number) => post({ type: 'progress', phase, done, total });
    let blocks = 0;
    if (r.mode === 'changes' && !disk) throw new MsgError('disks:export-worker.noChanges');
    const whole = disk ?? base;
    if (r.mode === 'raw') {
      for await (const chunk of rawChunks(whole)) {
        await sink(chunk);
        progress(msg('disks:export-worker.writingDisk'), written, whole.size);
      }
    } else {
      let clusters;
      let backing;
      if (r.mode === 'changes') {
        const hash = await hashSource(src, (done) => progress(msg('disks:export-worker.readingBase'), done, src.size));
        backing = { name: r.baseName, format: base.format, hash };
        clusters = progressOf(changedClusters(disk!), disk!.written().length, (done, total) =>
          progress(msg('disks:export-worker.writingChanges'), done, total),
        );
      } else {
        clusters = nonZeroClusters(whole, 1 << 20, (done) =>
          progress(msg('disks:export-worker.writingDisk'), done, whole.size),
        );
      }
      const pool = r.compress ? deflatePool() : undefined;
      try {
        const res = await writeQcow2({ size: whole.size, clusters, backing, compress: pool, sink });
        blocks = res.clusters;
      } finally {
        pool?.close();
      }
    }
    await out?.close();
    out = undefined;
    return { bytes: written, blocks };
  } finally {
    await out?.abort().catch(() => {});
    files?.close();
    src.close?.();
    inflater.close();
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
