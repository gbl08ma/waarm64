// Prepares the tests' Debian (`?machine=debian`; M8 loop 5, docs/images.md): downloads the pinned
// nocloud qcow2 (images/debian.json) into the download cache if it isn't there,
// checks its SHA512, and links it as target/images/debian/disk.qcow2 (the disk
// as published: a hard link to the download when it can be, else a copy). The
// page boots it unmodified through EDK2 (M8 phase B), so that is all there is: no
// kernel or initrd is taken out of it (the direct boot of Debian was dropped).
//   node tools/debian.ts [--force]
// WEBPC_DL overrides the download cache (default target/images/dl), e.g. to
// share one download between checkouts.
import { createHash } from 'node:crypto';
import { constants, createReadStream, existsSync } from 'node:fs';
import { copyFile, link, mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = fileURLToPath(new URL('..', import.meta.url));
export type Pin = { version?: string; file: string; url: string; sha512: string; label?: string; pinFile?: string };
export const PIN = JSON.parse(await readFile(join(ROOT, 'images/debian.json'), 'utf8')) as Pin;
export const OUT = join(ROOT, 'target/images/debian');
/** What the page needs: the disk alone. */
export const OUTPUTS = ['disk.qcow2'];
export const downloads = () => process.env.WEBPC_DL || join(ROOT, 'target/images/dl');
const STAMP = '.prepared';

const mb = (n: number) => `${(n / 1e6).toFixed(0)} MB`;

/** Progress on one line (rewritten on a terminal; every 10% otherwise). */
export function progressLine(what: string, out = process.stdout) {
  let shown = -1; // the percentage last written
  const t0 = performance.now();
  return (done: number, total: number, end = false) => {
    const pct = total ? Math.floor((done / total) * 100) : 0;
    const rate = done / 1e6 / Math.max(0.001, (performance.now() - t0) / 1000);
    const line = `${what}: ${total ? `${pct}%, ${mb(done)} of ${mb(total)}` : mb(done)} (${rate.toFixed(1)} MB/s)`;
    if (out.isTTY) {
      if (end || pct !== shown) out.write(`\r${line}\x1b[K${end ? '\n' : ''}`);
      shown = pct;
    } else if (end ? shown !== pct : Math.floor(pct / 10) !== Math.floor(shown / 10)) {
      out.write(line + '\n');
      shown = pct;
    }
  };
}

async function sha512File(path: string, log: (s: string) => void) {
  log(`Checking ${path} (SHA512)…`);
  const h = createHash('sha512');
  for await (const chunk of createReadStream(path, { highWaterMark: 1 << 20 })) h.update(chunk as Buffer);
  return h.digest('hex');
}

/** The image in the download cache, downloaded if it isn't there, checked against the pinned SHA512. */
export async function download(pin: Pin = PIN, log = (s: string) => console.log(s)) {
  const dir = downloads();
  const path = join(dir, pin.file);
  if (existsSync(path)) {
    if ((await sha512File(path, log)) !== pin.sha512) {
      throw new Error(`${path} doesn't match the pinned SHA512 (${pin.pinFile ?? 'images/debian.json'}): delete it and run this again to download it afresh.`);
    }
    return path;
  }
  await mkdir(dir, { recursive: true });
  const part = path + '.part';
  let res: Response;
  try {
    res = await fetch(pin.url);
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
  } catch (e) {
    throw new Error(`Couldn't download ${pin.label ?? 'Debian'} from ${pin.url}: ${(e as Error).message}${(e as Error).cause ? ` (${(e as Error & { cause: Error }).cause.message})` : ''}.\nCheck the network, or put ${pin.file} in ${dir} (WEBPC_DL sets that directory).`);
  }
  const total = Number(res.headers.get('content-length') ?? 0);
  const show = progressLine(`Downloading ${pin.label ?? 'Debian 13'} (${pin.file})`);
  const h = createHash('sha512');
  const f = await open(part, 'w');
  let done = 0;
  try {
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      h.update(chunk);
      await f.write(chunk);
      done += chunk.length;
      show(done, total);
    }
  } catch (e) {
    throw new Error(`The download of ${pin.url} broke off after ${mb(done)}: ${(e as Error).message}. Run this again to retry.`);
  } finally {
    await f.close();
  }
  show(done, total, true);
  if (h.digest('hex') !== pin.sha512) {
    await rm(part, { force: true });
    throw new Error(`The download of ${pin.url} doesn't match the pinned SHA512 (${pin.pinFile ?? 'images/debian.json'}); it was deleted. Run this again to retry.`);
  }
  await rename(part, path);
  return path;
}

/**
 * target/images/debian, prepared unless it already is (`force`: anyway). Returns what it did.
 * The stamp (.prepared) names the pinned image the outputs came from.
 */
export async function prepareDebian({ force = false, log = (s: string) => console.log(s) } = {}) {
  const stamp = `${PIN.version} ${PIN.sha512}\n`;
  const current = !force && OUTPUTS.every((f) => existsSync(join(OUT, f))) &&
    await readFile(join(OUT, STAMP), 'utf8').then((s) => s === stamp, () => false);
  if (current) return 'current' as const;
  const qcow2 = await download(PIN, log);
  const t0 = performance.now();
  await mkdir(OUT, { recursive: true });
  await rm(join(OUT, STAMP), { force: true });
  // What a kernel and initrd from an older image would leave must not outlive the stamp that now names the new one.
  await rm(join(OUT, 'Image'), { force: true });
  await rm(join(OUT, 'initrd.img'), { force: true });
  const disk = join(OUT, 'disk.qcow2');
  await rm(disk, { force: true });
  await link(qcow2, disk).catch(() => copyFile(qcow2, disk, constants.COPYFILE_FICLONE)); // FICLONE: a reflink where the filesystem has them
  await writeFile(join(OUT, STAMP), stamp);
  log(`Debian 13 ready, in ${((performance.now() - t0) / 1000).toFixed(1)} s.`);
  return 'prepared' as const;
}

if (import.meta.main) {
  try {
    const r = await prepareDebian({ force: process.argv.includes('--force') });
    if (r === 'current') console.log(`${OUT} is current (${PIN.version}).`);
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }
}
