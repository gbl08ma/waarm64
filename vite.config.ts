// The page's build (docs/frontend.md "The build"): Vite with Svelte's plugin. `vite build` writes the static copy
// (web/app/index.html and everything it reaches, bundled: the page, its workers and worklet, the wasm core, the tailnet
// client and the firmware as hashed assets) to target/dist/; the dev server (tools/serve.ts, `npm run serve`, the tests)
// serves the whole repository from source, so the test pages under tests/browser/ and bench/ load web/'s modules as they are.
import { svelte } from '@sveltejs/vite-plugin-svelte';
import type { IncomingMessage, OutgoingHttpHeaders, ServerResponse } from 'node:http';
import { statSync } from 'node:fs';
import { copyFile, stat } from 'node:fs/promises';
import { extname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import sirv from 'sirv';
import { defineConfig, type Plugin } from 'vite';
import { buildStamp, withStamp } from './tools/stamp.ts';
import { aboutData, FILE as THIRD_PARTY } from './tools/third-party.ts';

const ROOT = fileURLToPath(new URL('.', import.meta.url));

/** Cross-origin isolation (SharedArrayBuffer): every file the page loads needs these. */
export const ISOLATION = { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' };

/** The commit the page was built from, in a meta tag (tools/stamp.ts), on every load of the page. */
const stamp = (): Plugin => ({
  name: 'waarm64-stamp',
  transformIndexHtml: (html, ctx) => (ctx.filename.endsWith('web/app/index.html') ? withStamp(html, buildStamp(ROOT)) : html),
});

/**
 * `virtual:waarm64-about`: what the Home page's About pane shows (tools/third-party.ts `aboutData`): the build's
 * commit, and the third-party projects THIRD_PARTY.json marks for it, nothing else of that file.
 */
const about = (): Plugin => {
  const ID = 'virtual:waarm64-about';
  let build = false;
  return {
    name: 'waarm64-about',
    configResolved: (config) => { build = config.command === 'build'; },
    resolveId: (id) => (id === ID ? `\0${ID}` : null),
    load(id) {
      if (id !== `\0${ID}`) return null;
      this.addWatchFile(THIRD_PARTY);
      return `export default ${JSON.stringify(aboutData({ build }, ROOT))};`;
    },
  };
};

/**
 * `virtual:waarm64-core-size`: the core's wasm's size in bytes (0 when it isn't built), for the boot's download total
 * where the server compresses the core and so sends no length (web/app/download-size.ts). Read when first loaded, not
 * watched: the dev server sends the core's length itself, and a size off by a rebuild only moves the progress.
 */
const coreSize = (): Plugin => {
  const ID = 'virtual:waarm64-core-size';
  const CORE = join(ROOT, 'target/wasm32-unknown-unknown/release/waarm64_core.wasm');
  return {
    name: 'waarm64-core-size',
    resolveId: (id) => (id === ID ? `\0${ID}` : null),
    load(id) {
      if (id !== `\0${ID}`) return null;
      let size = 0;
      try {
        size = statSync(CORE).size;
      } catch {
        // Not built: no size (the worker reports the missing core when it fetches it).
      }
      return `export default ${size};`;
    },
  };
};

/** Node's modules, which web/ imports (dynamically) only on its Node paths (the tests' boots in Node): left as they are. */
const nodeModules = (): Plugin => ({
  name: 'waarm64-node-modules',
  enforce: 'pre',
  resolveId: (id) => (id.startsWith('node:') ? { id, external: true } : null),
});

/**
 * A `.gz` file as the bytes it is (the guest agent's gzip, which the page hands to the guest compressed: web/app/guest-agent.ts):
 * sirv, the dev server's and the preview's static server, sends one with `Content-Encoding: gzip`, so the browser would
 * decode it. Its headers lose that, and say `application/gzip`.
 */
const plainGzip = (): Plugin => {
  // Returning nothing: a function returned would be taken for a hook to run after Vite's own middleware.
  const use = (server: { middlewares: { use: (f: (req: IncomingMessage, res: ServerResponse, next: () => void) => void) => unknown } }) => {
    server.middlewares.use((req, res, next) => {
      if ((req.url ?? '').split('?')[0].endsWith('.gz')) {
        const writeHead = res.writeHead.bind(res) as (code: number, headers?: OutgoingHttpHeaders) => ServerResponse;
        res.writeHead = ((code: number, headers?: OutgoingHttpHeaders) => {
          // Both ways a server may have them: set on the response (Vite's own copy of sirv, the preview's), or given here.
          res.removeHeader('Content-Encoding');
          res.setHeader('Content-Type', 'application/gzip');
          if (headers) {
            delete headers['Content-Encoding'];
            headers['Content-Type'] = 'application/gzip';
          }
          return writeHead(code, headers);
        }) as typeof res.writeHead;
      }
      next();
    });
  };
  return { name: 'waarm64-plain-gzip', configureServer: use, configurePreviewServer: use };
};

/**
 * A HEAD request for a file under target/, answered from its `stat`: sirv answers one as it does a GET, reading the
 * whole file into a body Node then drops (a 2.2 GB disk image took ~1.9 s, twice in every load of a machine with it:
 * the page checks its disks are there, the device worker reads their size; bench/boot/REPORT.md "SNAPZ loop 7"). The
 * headers are sirv's for the file in dev mode (no ETag); anything else (a directory, a dotfile, outside target/) goes on
 * to sirv.
 */
const headOnly = (dir: string, headers: () => OutgoingHttpHeaders) => (req: IncomingMessage, res: ServerResponse, next: () => void) => {
  if (req.method !== 'HEAD') return next();
  let path: string;
  try {
    path = decodeURI(new URL(req.url ?? '/', 'http://x').pathname);
  } catch {
    return next();
  }
  const file = join(dir, path);
  if (!file.startsWith(dir + sep) || /(^|[\\/])\./.test(path)) return next();
  stat(file).then(
    (st) => {
      if (!st.isFile()) return next();
      res.writeHead(200, { ...headers(), 'Content-Length': st.size, 'Content-Type': CONTENT_TYPES[extname(file)] ?? '', 'Last-Modified': st.mtime.toUTCString() });
      res.end();
    },
    () => next(),
  );
};
/** The types sirv gives the files under target/ that the page asks HEAD about (the core, the tailnet clients); others have none here. */
const CONTENT_TYPES: Record<string, string> = { '.wasm': 'application/wasm', '.json': 'application/json', '.js': 'text/javascript' };

/**
 * The dev server's `/`: the page, which is web/app/ in the repository. And target/ (the guest images, the binaries) as
 * plain files, with range requests, ahead of Vite's own handling, which takes a file without an extension (a kernel's
 * `Image`) for a module.
 */
const rootPage = (): Plugin => ({
  name: 'waarm64-root-page',
  configureServer(server) {
    const headers = () => server.config.server.headers ?? {};
    server.middlewares.use('/target', headOnly(`${ROOT}target`, headers));
    server.middlewares.use('/target', sirv(`${ROOT}target`, { dev: true, dotfiles: false, setHeaders: (res) => { for (const [k, v] of Object.entries(headers())) res.setHeader(k, v as string); } }));
    server.middlewares.use((req, res, next) => {
      const url = new URL(req.url ?? '/', 'http://x');
      // The demo store's page (`/demos`, as the copy's demos.html is served): the page at web/app/demos, one segment
      // under the page's directory as /demos is under the copy's, so its relative URLs resolve alike.
      if (url.pathname === '/demos' || url.pathname === '/demos.html')
        return void res.writeHead(302, { Location: `/web/app/demos${url.search}` }).end();
      // The introduction's path alike (`/intro`, the copy's intro.html: web/app/intro-route.ts).
      if (url.pathname === '/intro' || url.pathname === '/intro.html')
        return void res.writeHead(302, { Location: `/web/app/intro${url.search}` }).end();
      if (/^\/web\/app\/(demos|intro)(\.html)?$/.test(url.pathname)) {
        req.url = `/web/app/index.html${url.search}`;
        return next();
      }
      if (url.pathname !== '/') return next();
      res.writeHead(302, { Location: `/web/app/${url.search}` }).end();
    });
  },
});

/**
 * The demo store's page in the copy: `demos.html`, the built `index.html` as it is, beside it (docs/frontend.md "A
 * static copy"). A host serves it at `/demos` (Cloudflare's `auto-trailing-slash`, Vite's preview server), one segment
 * deep, so its `./assets/…` are the page's; the page tells the store's page by its path (web/app/demos-route.ts).
 */
const demosPage = (): Plugin => ({
  name: 'waarm64-demos-page',
  apply: 'build',
  writeBundle: async (o) => {
    if (!o.dir) return;
    await copyFile(join(o.dir, 'index.html'), join(o.dir, 'demos.html'));
    // The introduction's way in, `/intro`, alike (web/app/intro-route.ts).
    await copyFile(join(o.dir, 'index.html'), join(o.dir, 'intro.html'));
  },
});

/** Assets' names in the copy: Vite's, but a file without an extension keeps none (no trailing dot after its hash). */
const assetFileNames = (a: { names?: string[] }) => (/\.[^./]+$/.test(a.names?.[0] ?? '') ? 'assets/[name]-[hash][extname]' : 'assets/[name]-[hash]');

// Mode `test` (tools/serve.ts `startServer`, the tests' and benchmarks' dev server): no watching or hot reloading, and
// Svelte and the packages as the build has them (not their development builds), so a test runs the code a user gets.
export default defineConfig(({ command, mode }) => ({
  // The build's root is the page's directory, so its index.html is the copy's; the dev server's is the repository.
  root: command === 'build' ? `${ROOT}web/app` : ROOT,
  base: './',
  appType: 'mpa',
  // Copied as they are into the static copy: the hosts' headers files and web/app/'s old address's redirect.
  publicDir: command === 'build' ? `${ROOT}web/app/public` : false,
  plugins: [plainGzip(), svelte({ compilerOptions: { runes: true, discloseVersion: false, ...(mode === 'test' ? { dev: false, hmr: false } : {}) } }), stamp(), about(), coreSize(), rootPage(), demosPage(), nodeModules()],
  resolve: mode === 'test' ? { conditions: ['module', 'browser', 'production'] } : {},
  worker: { format: 'es', plugins: () => [coreSize(), nodeModules()], rollupOptions: { output: { assetFileNames } } },
  // No pre-bundling: the few packages the page uses are ES modules, and every test process runs its own dev server (a
  // shared cache directory would race). Svelte's plugin adds Svelte unless it is excluded.
  optimizeDeps: { noDiscovery: true, include: [], exclude: ['svelte'] },
  server: {
    headers: { ...ISOLATION, 'Cache-Control': 'no-store' },
    // Mode `test` keeps Vite's client its connection (a page's CSS loads through the client, which would say on the
    // console that it has none) but watches nothing, so nothing reloads.
    // The guest images and build outputs are many gigabytes: never watched.
    watch: mode === 'test' ? null : { ignored: ['**/target/**', '**/node_modules/**', '**/.git/**', '**/bench/results/**'] },
    fs: { strict: true, allow: [ROOT] },
  },
  preview: { headers: ISOLATION },
  build: {
    outDir: `${ROOT}target/dist`,
    emptyOutDir: true,
    target: 'es2024',
    sourcemap: true,
    // Every asset a file of its own: the wasm binaries and the firmware are fetched (and range-read) by URL.
    assetsInlineLimit: 0,
    // The core is ~5 MiB of wasm, the page's code under 1 MiB: nothing to warn about.
    chunkSizeWarningLimit: 2048,
    license: { fileName: 'THIRD-PARTY-LICENSES.md' },
    rollupOptions: { output: { assetFileNames } },
  },
}));
