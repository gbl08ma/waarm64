// `npm run dist`: the page as a static site (docs/frontend.md "A static copy"): files to copy to any
// web server, no Node behind them. It prepares what `npm start` prepares (the npm packages, the wasm
// core, the tailnet client, the UEFI firmware), then writes `target/dist/`:
//   web/app/index.html, web/**/*.js   the page's modules, from web/'s TypeScript: types stripped, `.ts` specifiers `.js`
//                                     (only the modules the page reaches: its imports, workers and worklet)
//   web/**/*.svelte.js                the page's Svelte components, compiled (tools/svelte.ts)
//   vendor/xterm/                     xterm.js and its CSS (node_modules/@xterm/xterm), the page's import map points there
//   vendor/svelte/, vendor/esm-env/, vendor/clsx/   Svelte's runtime (the same files serve.ts serves), with their licenses
//   target/…                          the core (webpc_core.wasm), the tailnet client (net/ts.wasm), EDK2 (images/edk2)
//   index.html                        the page (web/app/index.html's, its URLs made the root's); web/app/ redirects to it
//   _headers, .htaccess, .nojekyll    cross-origin isolation for hosts that read them (below)
// No guest images: the page's machine waits for the user's disk (`?disk=<url>` takes one from any server
// that allows the page's origin and answers range requests, or a chunked image's manifest from any static host; the
// deployed copy's images are on their own host, deploy/disks/). The layout under the root is the repository's, so
// the modules' relative URLs (`../../target/…`) hold as they are.
// The server must send `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy:
// require-corp` with every file (SharedArrayBuffer), and answer range requests (the firmware, disks).
//   npm run dist [-- --out <dir>] [-- --no-prepare] [-- --serve [--port <n>]]
// --serve previews the copy with tools/serve.ts (the same headers and ranges a host must give).
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { parseArgs } from 'node:util';
import { APP, atRoot, ROOT, startServer } from './serve.ts';
import { FIRMWARE, main as prepare, Stop, WASM } from './start.ts';
import { compileRunes, compileSvelte, RUNTIME_LICENSES, runtimeFiles } from './svelte.ts';

export const OUT = join(ROOT, 'target/dist');

/** Marks a directory as this script's output: the only kind it deletes before writing. */
const MARK = '.webpc-dist';

/** The binaries the page fetches, as paths in the repository (and in the copy). */
export const BINARIES = [relative(ROOT, WASM), 'target/net/ts.wasm', FIRMWARE, 'target/images/edk2/LICENSES.txt'];

/** Relative module specifiers and URLs ending in `.ts` in a module's source: `'./x.ts'`, `"../y.ts"`, `` `./w.ts${…}` ``. */
const SPECIFIER = /(['"`])(\.{1,2}\/[\w./-]*?)\.ts(?=['"`]|\$\{)/g;
/** Relative specifiers of Svelte components: `'./Machines.svelte'`. */
const COMPONENT = /(['"])(\.{1,2}\/[\w./-]*?)\.svelte(?=['"])/g;

/**
 * A module of web/ as the browser gets it: types stripped (a component compiled), `.ts` specifiers renamed `.js`,
 * components' `.svelte.js`; and the modules it names.
 */
export function compileModule(source: string, path = 'module.ts') {
  const js = path.endsWith('.svelte') ? compileSvelte(source, path) : path.endsWith('.svelte.ts') ? compileRunes(source, path) : stripTypeScriptTypes(source, { mode: 'strip' });
  const deps = [...[...js.matchAll(SPECIFIER)].map((m) => `${m[2]}.ts`), ...[...js.matchAll(COMPONENT)].map((m) => `${m[2]}.svelte`)];
  return { js: js.replace(SPECIFIER, '$1$2.js').replace(COMPONENT, '$1$2.svelte.js'), deps };
}
/** Where a module of web/ goes in the copy. */
const outPath = (path: string) => (path.endsWith('.svelte') ? `${path}.js` : path.replace(/\.ts$/, '.js'));

const HEADERS = `/*
  Cross-Origin-Opener-Policy: same-origin
  Cross-Origin-Embedder-Policy: require-corp
`;

const HTACCESS = `# Apache (mod_headers): the page needs cross-origin isolation.
Header always set Cross-Origin-Opener-Policy "same-origin"
Header always set Cross-Origin-Embedder-Policy "require-corp"
AddType application/wasm .wasm
AddType text/javascript .js .mjs
`;

// web/app/, where the page was until 2026-10-23: to the root, with the query and fragment (`?disk=<url>` is the
// page's); the meta refresh is for a browser without scripts.
const REDIRECT = `<!doctype html>
<meta charset="utf-8">
<script>location.replace('../../' + location.search + location.hash);</script>
<meta http-equiv="refresh" content="0; url=../../">
<title>webpc</title>
<a href="../../">webpc</a>
`;

/** Writes the static copy of the page to `out` (its binaries must be built); returns the files written, relative to `out`. */
export function writeDist(out = OUT) {
  if (existsSync(out) && readdirSync(out).length && !existsSync(join(out, MARK))) {
    throw new Stop(`${out} exists and isn't a copy this script wrote: pick another --out, or empty it.`);
  }
  const missing = BINARIES.filter((f) => !existsSync(join(ROOT, f)));
  if (missing.length) throw new Stop(`Not built: ${missing.join(', ')} (\`npm run dist\` without --no-prepare builds them).`);
  rmSync(out, { recursive: true, force: true });
  const written: string[] = [];
  const write = (path: string, data: string | Buffer) => {
    mkdirSync(dirname(join(out, path)), { recursive: true });
    writeFileSync(join(out, path), data);
    written.push(path);
  };
  const copy = (from: string, to = from) => {
    mkdirSync(dirname(join(out, to)), { recursive: true });
    cpSync(join(ROOT, from), join(out, to));
    written.push(to);
  };

  // The page and every module it reaches, from its entry (index.html's main.ts).
  const html = readFileSync(join(ROOT, 'web/app/index.html'), 'utf8');
  if (!html.includes('src="./main.ts"') || !html.includes('../../node_modules/@xterm/xterm/')) throw new Error('web/app/index.html no longer loads ./main.ts and xterm from node_modules: update tools/dist.ts');
  // The import map's node_modules paths (xterm's, and Svelte's runtime: tools/svelte.ts) become vendor/'s.
  write('index.html', atRoot(html.replace('src="./main.ts"', 'src="./main.js"').replaceAll('../../node_modules/@xterm/xterm/lib/', '../../vendor/xterm/').replaceAll('../../node_modules/@xterm/xterm/css/', '../../vendor/xterm/').replaceAll('../../node_modules/', '../../vendor/')));
  write('web/app/index.html', REDIRECT);
  const queue = ['web/app/main.ts'];
  const seen = new Set(queue);
  while (queue.length) {
    const path = queue.pop()!;
    if (!existsSync(join(ROOT, path))) throw new Error(`a module names ${path}, which doesn't exist`);
    const { js, deps } = compileModule(readFileSync(join(ROOT, path), 'utf8'), path);
    write(outPath(path), js);
    for (const d of deps) {
      const p = relative(ROOT, resolve(ROOT, dirname(path), d)).split(sep).join('/');
      if (!seen.has(p)) { seen.add(p); queue.push(p); }
    }
  }

  const xterm = 'node_modules/@xterm/xterm';
  copy(`${xterm}/lib/xterm.mjs`, 'vendor/xterm/xterm.mjs');
  copy(`${xterm}/css/xterm.css`, 'vendor/xterm/xterm.css');
  copy(`${xterm}/LICENSE`, 'vendor/xterm/LICENSE');
  for (const f of [...runtimeFiles(), ...RUNTIME_LICENSES]) copy(f, f.replace(/^node_modules\//, 'vendor/'));
  for (const f of BINARIES) copy(f);
  copy('LICENSE');

  write('_headers', HEADERS);
  write('.htaccess', HTACCESS);
  write('.nojekyll', '');
  write(MARK, '');
  return written;
}

if (import.meta.main) {
  const { values } = parseArgs({ options: { out: { type: 'string' }, 'no-prepare': { type: 'boolean', default: false }, serve: { type: 'boolean', default: false }, port: { type: 'string', default: process.env.PORT ?? '8080' } } });
  const out = values.out ? resolve(values.out) : OUT;
  try {
    if (!values['no-prepare']) await prepare(['--prepare-only']);
    const files = writeDist(out);
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
