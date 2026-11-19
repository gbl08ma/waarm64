// Cuts a disk image into a chunked image (docs/remote-disks.md "Publishing an image", web/chunked.ts): equal pieces of the file
// at byte offsets, each named by its SHA-256 (`pieces/<sha256>.bin`: a new version of the image shares the pieces it
// didn't change, and repeated pieces, zeros, are one file), and `manifest.json` beside them. The page opens the
// manifest's URL as the disk (`?disk=…/manifest.json`); any static host serves it, with or without byte ranges. 2 MiB
// pieces by default: where the host has no ranges a read fetches its piece whole, and 2 MiB lost nothing against
// ranges (bench/remote-disk/REPORT.md "R2"). `--pieces <dir>`: the pieces go there instead of `<out>/pieces`, the
// manifest naming them relative to itself: a site's one `pieces/` directory shared by every image and version
// (docs/remote-disks.md "Publishing an image": `--pieces target/disks/pieces`). `<out>` ending in `.json` is the
// manifest's own file (a template snapshot's beside its image's), else a directory with `manifest.json` in it.
//   node tools/chunk-image.ts <image> <out> [piece MiB, default 2] [--name <what the page calls it>, default the image's file name] [--pieces <dir>]
import { createHash } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, sep } from 'node:path';
import { CHUNKED_FORMAT, type Manifest } from '../web/chunked.ts';

const args = process.argv.slice(2);
const flag = (f: string) => (args.includes(f) ? args.splice(args.indexOf(f), 2)[1] : undefined);
const name = flag('--name');
const shared = flag('--pieces');
const [image, out, mib] = args;
if (!image || !out) throw new Error('usage: node tools/chunk-image.ts <image> <out> [piece MiB, default 2] [--name <name>] [--pieces <dir>]');
const piece = Number(mib ?? 2) * 2 ** 20;
if (!(piece >= 2 ** 20 && Number.isInteger(piece / 2 ** 20))) throw new Error('the piece size is a whole number of MiB');
const manifestFile = out.endsWith('.json') ? out : join(out, 'manifest.json');
const piecesDir = shared ?? join(dirname(manifestFile), 'pieces');
// The pieces' URL relative to the manifest (a URL's separators, whatever the OS's).
const piecesUrl = `${relative(dirname(manifestFile), piecesDir).split(sep).join('/') || '.'}/{hash}.bin`;

mkdirSync(piecesDir, { recursive: true });
mkdirSync(dirname(manifestFile), { recursive: true });
const fd = openSync(image, 'r');
const buf = Buffer.alloc(piece);
const pieces: string[] = [];
let size = 0, written = 0;
for (;;) {
  let n = 0;
  while (n < piece) {
    const k = readSync(fd, buf, n, piece - n, size + n);
    if (k === 0) break;
    n += k;
  }
  if (n === 0) break;
  const bytes = buf.subarray(0, n);
  const hash = createHash('sha256').update(bytes).digest('hex');
  const file = join(piecesDir, `${hash}.bin`);
  if (!existsSync(file)) {
    writeFileSync(file, bytes);
    written++;
  }
  pieces.push(hash);
  size += n;
  if (n < piece) break;
}
closeSync(fd);
const manifest: Manifest = {
  format: CHUNKED_FORMAT,
  name: name ?? basename(image),
  size,
  piece,
  pieces: piecesUrl,
  hashes: pieces,
  id: createHash('sha256').update(pieces.join('\n')).digest('hex'),
};
writeFileSync(manifestFile, JSON.stringify(manifest));
console.log(`${pieces.length} pieces of ${piece / 2 ** 20} MiB (${written} files written), ${size} bytes, id ${manifest.id.slice(0, 16)}…`);
