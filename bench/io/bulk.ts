// The stored disks' bulk writes (PERF loop 76): an image's import (web/stored.ts `importImage`), a changes file's
// load into a new overlay (web/changes.ts `loadChanges`, the page's Import changes) and that overlay's merge into an
// empty stored disk (`mergeOverlay`), each timed over OPFS on the chosen file's bytes (bench/io's 256 MiB of random
// data). The changes are the imported disk's blocks, a 1 MiB run of them zeroed every 16 MiB, over a blank base of
// its size. A round each; the first round checks the merged disk against the file.
//   node bench/run.ts --page bench/io/index.html --input target/bench/io-raw.img --only io_bulk [--profile=<dir>]
import type { Options, Sample } from '../spike/benchmarks.ts';
import { hashSource, loadChanges } from '../../web/changes.ts';
import { blobSource, zeroSource } from '../../web/disk-sources.ts';
import { openOverlay, overlay, removeOverlay } from '../../web/overlay.ts';
import { changedClusters, writeQcow2, type Sink } from '../../web/qcow2-write.ts';
import { importImage, mergeOverlay, openStored, openStoredForWriting, zeroDisk } from '../../web/stored.ts';

const DIR = 'bench-bulk';
const [STORE, CHANGES, MERGED] = [`${DIR}/store`, `${DIR}/changes`, `${DIR}/merged`];
const ID = 'bench-bulk';

const clean = async () => {
  for (const p of [STORE, CHANGES, MERGED]) await removeOverlay(p).catch(() => {});
};

export async function ioBulk(o: Options & { file: File }): Promise<Sample[]> {
  const size = o.file.size;
  const rounds = o.quick ? 1 : 3;
  const ms: Record<'import' | 'hash' | 'changes' | 'merge', number[]> = { import: [], hash: [], changes: [], merge: [] };
  let blocks = 0;
  let zeroed = 0;
  for (let i = 0; i < rounds; i++) {
    await clean();
    // The import: the file into an empty stored disk.
    let t = performance.now();
    const files = await openStoredForWriting(STORE, ID, 0);
    try {
      blocks = (await importImage(blobSource(o.file), files)).blocks;
    } finally {
      files.close();
    }
    ms.import.push(performance.now() - t);
    // The changes file (not timed): the stored disk's blocks, some zeroed, over a blank base of its size.
    const sf = await openStoredForWriting(STORE, ID, size);
    const parts: Uint8Array[] = [];
    try {
      const store = overlay(zeroDisk(size), sf.data, sf.map, sf.meta);
      zeroed = 0;
      for (let off = 15 << 20; off + (1 << 20) <= size; off += 16 << 20, zeroed += 256)
        if (!(await store.zero(off, 1 << 20))) throw new Error('a zeroing failed');
      const sink: Sink = (chunk, at) => {
        if (at === undefined) parts.push(chunk);
        else parts[0] = chunk;
      };
      const hash = await hashSource(zeroSource(size), () => {});
      await writeQcow2({ size, clusters: changedClusters(store), backing: { name: 'blank.img', format: 'raw', hash }, sink });
    } finally {
      sf.close();
    }
    const changes = new Blob(parts as BlobPart[]);
    // The base's hash alone (loadChanges checks it first), then the whole load.
    t = performance.now();
    await hashSource(zeroSource(size), () => {});
    ms.hash.push(performance.now() - t);
    t = performance.now();
    await loadChanges({ changes: blobSource(changes), base: zeroSource(size), label: 'blank', overlay: CHANGES, identity: ID });
    ms.changes.push(performance.now() - t - ms.hash[i]);
    // The merge: the loaded overlay into an empty stored disk.
    (await openStoredForWriting(MERGED, ID, size)).close();
    t = performance.now();
    await mergeOverlay(MERGED, CHANGES, ID, size);
    ms.merge.push(performance.now() - t);
    if (i === 0) {
      // The merged disk is the file with the zeroed runs.
      const got = await openStored(MERGED, size);
      const want = blobSource(o.file);
      try {
        for (let off = 0; off < size; off += 1 << 20) {
          const len = Math.min(1 << 20, size - off);
          const a = got.read(off, len);
          const b = (off >> 20) % 16 === 15 ? new Uint8Array(len) : want.read(off, len);
          if (!a || !b || indexedDB.cmp(a, b) !== 0) throw new Error(`the merged disk differs in its MiB ${off >> 20}`);
        }
      } finally {
        got.close();
      }
    }
    o.log?.(`bulk round ${i + 1}/${rounds}: import ${ms.import[i].toFixed(0)} ms, changes ${ms.changes[i].toFixed(0)} (+ hash ${ms.hash[i].toFixed(0)}), merge ${ms.merge[i].toFixed(0)}`);
  }
  await clean();
  const params = { bytes: size, blocks, zeroed, data: 'random', opfs: 'stored disks and an overlay' };
  return [
    { name: 'bulk_import', unit: 'ms', params, samples: ms.import },
    { name: 'bulk_changes_load', unit: 'ms', params: { ...params, note: 'without the base hash' }, samples: ms.changes },
    { name: 'bulk_changes_hash', unit: 'ms', params, samples: ms.hash },
    { name: 'bulk_merge', unit: 'ms', params, samples: ms.merge },
  ];
}
