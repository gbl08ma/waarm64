// `npm run dist`: the page as a static site (docs/frontend.md "A static copy"): files to copy to any
// web server, no Node behind them. It prepares what `npm start` prepares (the npm packages, the wasm
// core, the tailnet client, the UEFI firmware), then builds the page with Vite (vite.config.ts) into `target/dist/`:
//   index.html                        the page, the commit it was built from in a meta tag (tools/stamp.ts)
//   assets/                           its code bundled (the page, each worker, the sound worklet; minified, with source
//                                     maps), its CSS, and the binaries it fetches: the core (webpc_core.wasm), the
//                                     tailnet client (ts.wasm), EDK2 (QEMU_EFI.fd); every name hashed
//   web/app/index.html                a redirect to the root (the page was there until 2026-10-23)
//   _headers, .htaccess, .nojekyll    cross-origin isolation for hosts that read them (below; web/app/public/)
//   THIRD-PARTY-LICENSES.md, EDK2-LICENSES.txt, LICENSE   the bundled packages' licenses, the firmware's, ours
// No guest images: the page's machine waits for the user's disk (`?disk=<url>` takes one from any server
// that allows the page's origin and answers range requests, or a chunked image's manifest from any static host; the
// deployed copy's images are on their own host, deploy/disks/).
// The server must send `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy:
// require-corp` with every file (SharedArrayBuffer). The page fetches its own files whole; disks need range requests.
//   npm run dist [-- --out <dir>] [-- --no-prepare] [-- --serve [--port <n>]]
// --serve previews the copy with Vite's preview server (tools/serve.ts: the same headers and ranges a host must give).
import { cpSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { build } from 'vite';
import { APP, ROOT, startServer } from './serve.ts';
import { FIRMWARE, main as prepare, Stop, WASM } from './start.ts';

export const OUT = join(ROOT, 'target/dist');

/** Marks a directory as a build of the page (web/app/public/ carries it): the only kind this script deletes before writing. */
const MARK = '.webpc-dist';

/** The binaries the page fetches, as paths in the repository. */
export const BINARIES = [relative(ROOT, WASM), 'target/net/ts.wasm', FIRMWARE, 'target/images/edk2/LICENSES.txt'];

/** Writes the static copy of the page to `out` (its binaries must be built); returns the files written, relative to `out`. */
export async function writeDist(out = OUT) {
  if (existsSync(out) && readdirSync(out).length && !existsSync(join(out, MARK))) {
    throw new Stop(`${out} exists and isn't a copy this script wrote: pick another --out, or empty it.`);
  }
  const missing = BINARIES.filter((f) => !existsSync(join(ROOT, f)));
  if (missing.length) throw new Stop(`Not built: ${missing.join(', ')} (\`npm run dist\` without --no-prepare builds them).`);
  await build({ configFile: join(ROOT, 'vite.config.ts'), build: { outDir: out }, logLevel: 'warn' });
  cpSync(join(ROOT, 'target/images/edk2/LICENSES.txt'), join(out, 'EDK2-LICENSES.txt'));
  cpSync(join(ROOT, 'LICENSE'), join(out, 'LICENSE'));
  return readdirSync(out, { recursive: true, encoding: 'utf8' }).filter((f) => statSync(join(out, f)).isFile());
}

if (import.meta.main) {
  const { values } = parseArgs({ options: { out: { type: 'string' }, 'no-prepare': { type: 'boolean', default: false }, serve: { type: 'boolean', default: false }, port: { type: 'string', default: process.env.PORT ?? '8080' } } });
  const out = values.out ? resolve(values.out) : OUT;
  try {
    if (!values['no-prepare']) await prepare(['--prepare-only']);
    const files = await writeDist(out);
    const bytes = files.reduce((n, f) => n + statSync(join(out, f)).size, 0);
    console.log(`\nWrote ${files.length} files (${(bytes / 2 ** 20).toFixed(1)} MiB) to ${out}.\n` +
      'Copy its contents to a web server. It must send these headers with every file (SharedArrayBuffer needs them):\n' +
      '  Cross-Origin-Opener-Policy: same-origin\n  Cross-Origin-Embedder-Policy: require-corp\n' +
      '(_headers sets them on Cloudflare (a Worker\'s static assets, or Pages) and Netlify, .htaccess on Apache; GitHub Pages can\'t set them.)\n' +
      'and serve it over HTTPS (or on localhost). The page is index.html, at the root.');
    if (values.serve) {
      const server = await startServer(Number(values.port), '127.0.0.1', out);
      console.log(`Previewing at http://127.0.0.1:${(server.address() as { port: number }).port}${APP} (Ctrl+C stops it).`);
    }
  } catch (e) {
    if (!(e instanceof Stop)) throw e;
    console.error(`\n${e.message}`);
    process.exit(1);
  }
}
