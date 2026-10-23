// A boot's reads into a chunked image's manifest (docs/remote-disks.md "Publishing an image", web/chunked.ts `prefetch`): the image
// file's 1 MiB blocks in the order a boot first read them, from a bench/remote-disk/boot.ts run's trace (the page's
// `?iostats`: every base read, any image of the same bytes: the whole file or a chunked copy) up to one of its marks.
// The page then fetches them ahead of the guest. The manifest's id doesn't change (the bytes are the same).
//   node tools/disk-trace.ts <run.json> <manifest.json> [out.json, default: the manifest] [--until <mark>, default: the last]
import { readFileSync, writeFileSync } from 'node:fs';
import { checkManifest } from '../web/chunked.ts';

const args = process.argv.slice(2);
const until = args.includes('--until') ? args.splice(args.indexOf('--until'), 2)[1] : undefined;
const [runFile, manifestFile, outFile = manifestFile] = args;
if (!runFile || !manifestFile) throw new Error('usage: node tools/disk-trace.ts <run.json> <manifest.json> [out.json] [--until <mark>]');
const BLOCK = 1 << 20;

const run = JSON.parse(readFileSync(runFile, 'utf8')) as { marks: Record<string, number>; io?: { trace: number[] } };
const end = until ? run.marks[until] : Math.max(...Object.values(run.marks));
if (end === undefined || !run.io?.trace.length) throw new Error(`${runFile}: no trace, or no mark ${until}`);
const m = checkManifest(JSON.parse(readFileSync(manifestFile, 'utf8')));
const blocks = new Set<number>();
const t = run.io.trace;
for (let i = 0; i < t.length; i += 4) {
  if (t[i] > end) continue;
  const [off, len] = [t[i + 1], t[i + 2]];
  if (off + len > m.size) throw new Error(`${runFile} read past the image's end: another image's trace?`);
  for (let b = Math.floor(off / BLOCK); b <= Math.floor((off + len - 1) / BLOCK); b++) blocks.add(b);
}
writeFileSync(outFile, JSON.stringify({ ...m, prefetch: { block: BLOCK, blocks: [...blocks] } }));
console.log(`${blocks.size} blocks (${blocks.size} MiB) read up to ${until ?? 'the last mark'} → ${outFile}`);
