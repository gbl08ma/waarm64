// The overlay's map: its file and the memory an opening keeps, for Debian's disk imported as a stored disk and for a
// disk grown and given GPT's two headers (the first and last 33 sectors), with whichever web/overlay.ts is in place
// (the two-level map's A/B: bench/io/REPORT.md). The data file only counts its size (its bytes don't matter here).
//   node --expose-gc bench/io/map-sizes.ts <label> > out.json
import { openSync, readSync, fstatSync } from 'node:fs';
import { memFile, overlay, type SyncFile } from '../../web/overlay.ts';
import { importImage, zeroDisk } from '../../web/stored.ts';

const label = process.argv[2] ?? '';
const gc = (globalThis as { gc?: () => void }).gc!;

/** A data file that keeps its size and nothing else. */
const sizeOnly = (): SyncFile => {
  let size = 0;
  return { read: (buf, { at }) => { const n = Math.max(0, Math.min(buf.length, size - at)); buf.fill(0, 0, n); return n; }, write: (buf, { at }) => { size = Math.max(size, at + buf.length); return buf.length; }, getSize: () => size, truncate: (n) => { size = n; }, flush() {} };
};

/** The ArrayBuffers an opening of the overlay keeps (after a gc), in bytes. */
function opening(data: SyncFile, map: SyncFile, size: number) {
  gc();
  const before = process.memoryUsage().arrayBuffers;
  const d = overlay(zeroDisk(size), data, map, undefined, size);
  gc();
  const kept = process.memoryUsage().arrayBuffers - before;
  return { kept, d };
}

const out: Record<string, unknown> = { label, node: process.version };
// Debian's published qcow2 (3 GiB virtual) imported as a stored disk.
{
  const path = new URL('../../target/images/debian/disk.qcow2', import.meta.url).pathname;
  const fd = openSync(path, 'r');
  const src = { size: fstatSync(fd).size, read: (off: number, len: number) => { const b = new Uint8Array(len); readSync(fd, b, 0, len, off); return b; } };
  const [data, map, meta] = [sizeOnly(), memFile(), memFile()];
  const t0 = performance.now();
  const r = await importImage(src, { data, map, meta, close() {} });
  const importMs = performance.now() - t0;
  const { kept } = opening(data, map, r.size);
  out.debian = { size: r.size, blocks: r.blocks, data: data.getSize(), map: map.getSize(), openingKeeps: kept, importMs };
}
// Grown disks with GPT's headers written (the backup's at the end: what made a flat map as long as the disk's).
for (const gib of [256, 1024, 8192]) {
  const size = gib * 2 ** 30;
  if (label === 'A' && gib > 256) { out[`grown${gib}`] = 'past the flat map\'s cap (MAX_RESIZE 256 GiB)'; continue; }
  const [data, map] = [sizeOnly(), memFile()];
  const d = overlay(zeroDisk(size), data, map, undefined, size);
  await d.write(0, new Uint8Array(34 * 512).fill(1));
  await d.write(size - 33 * 512, new Uint8Array(33 * 512).fill(2));
  const { kept } = opening(data, map, size);
  out[`grown${gib}`] = { size, map: map.getSize(), openingKeeps: kept };
}
console.log(JSON.stringify(out));
