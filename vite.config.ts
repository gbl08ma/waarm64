// The page's build (docs/frontend.md "The build"): Vite with Svelte's plugin. `vite build` writes the static copy
// (web/app/index.html and everything it reaches, bundled: the page, its workers and worklet, the wasm core, the tailnet
// client and the firmware as hashed assets) to target/dist/; the dev server (tools/serve.ts, `npm run serve`, the tests)
// serves the whole repository from source, so the test pages under tests/browser/ and bench/ load web/'s modules as they are.
import { svelte } from '@sveltejs/vite-plugin-svelte';
import type { IncomingMessage, OutgoingHttpHeaders, ServerResponse } from 'node:http';
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
 * `virtual:waarm64-about`: what the Machines page's About pane shows (tools/third-party.ts `aboutData`): the build's
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
 * The dev server's `/`: the page, which is web/app/ in the repository. And target/ (the guest images, the binaries) as
 * plain files, with range requests, ahead of Vite's own handling, which takes a file without an extension (a kernel's
 * `Image`) for a module.
 */
const rootPage = (): Plugin => ({
  name: 'waarm64-root-page',
  configureServer(server) {
    server.middlewares.use('/target', sirv(`${ROOT}target`, { dev: true, dotfiles: false, setHeaders: (res) => { for (const [k, v] of Object.entries(server.config.server.headers ?? {})) res.setHeader(k, v as string); } }));
    server.middlewares.use((req, res, next) => {
      const url = new URL(req.url ?? '/', 'http://x');
      if (url.pathname !== '/') return next();
      res.writeHead(302, { Location: `/web/app/${url.search}` }).end();
    });
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
  plugins: [plainGzip(), svelte({ compilerOptions: { runes: true, discloseVersion: false, ...(mode === 'test' ? { dev: false, hmr: false } : {}) } }), stamp(), about(), rootPage(), nodeModules()],
  resolve: mode === 'test' ? { conditions: ['module', 'browser', 'production'] } : {},
  worker: { format: 'es', plugins: () => [nodeModules()], rollupOptions: { output: { assetFileNames } } },
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
