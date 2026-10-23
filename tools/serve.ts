// Dev/test server: serves the repo root on 127.0.0.1 with cross-origin
// isolation headers (needed for SharedArrayBuffer and fine-grained timers).
// .ts files are served as JavaScript with types stripped, .svelte files and .svelte.ts modules compiled (tools/svelte.ts). Other files honor a
// single `Range: bytes=` request (206 / 416), which the virtio-blk HTTP backend uses.
// `/` is the page (web/app/index.html, its relative URLs made the root's: `atRoot`; web/app/ serves it too, as the
// tests use), a directory serves its index.html, and
// nothing under node_modules is served except the files the page imports (`ALLOWED`, and Svelte's runtime).
import { execFileSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { open, readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareTailnetClient } from './tailscale.ts';
import { compileRunes, compileSvelte, runtimeFiles } from './svelte.ts';

export const ROOT = fileURLToPath(new URL('..', import.meta.url));

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.ts': 'text/javascript; charset=utf-8',
  '.svelte': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.css': 'text/css; charset=utf-8',
};

/** The page (docs/frontend.md): served at the root. */
export const APP = '/';

/**
 * web/app/index.html's document-relative URLs (its entry module, stylesheet and import map) made the site root's, so
 * the page is served at `/` as well as at web/app/. Everything else it loads is relative to its modules.
 */
export const atRoot = (html: string) => {
  if (!html.includes('"./main.') || !html.includes('"../../')) throw new Error('web/app/index.html no longer loads ./main and ../../: update atRoot');
  return html.replaceAll('"./', '"./web/app/').replaceAll('"../../', '"./'); // an import map's values must start with ./
};

/**
 * What the page was built from, for its console (main.ts logs it at load): the commit, its date, and whether the work
 * tree had changes then (tracked files only). Undefined outside a git checkout.
 */
export function buildStamp(root = ROOT) {
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  try {
    const [commit, date] = git('log', '-1', '--format=%h %cI', '--abbrev=12').split(' ');
    const dirty = git('status', '--porcelain', '--untracked-files=no') !== '';
    return `${commit} (${date})${dirty ? ' with local changes' : ''}`;
  } catch {
    return undefined;
  }
}

/** The page with its build stamp (`buildStamp`) in a `<meta name="webpc-build">` after its charset. */
export const withStamp = (html: string, stamp: string | undefined) => {
  if (!stamp) return html;
  if (!html.includes('<meta charset="utf-8">')) throw new Error('web/app/index.html has no <meta charset="utf-8">: update withStamp');
  return html.replace('<meta charset="utf-8">', `<meta charset="utf-8">\n<meta name="webpc-build" content="${stamp.replace(/[&"<>]/g, '')}">`);
};

/** The only files served from node_modules: what the page imports (xterm.js). */
const ALLOWED = ['node_modules/@xterm/xterm/lib/xterm.mjs', 'node_modules/@xterm/xterm/css/xterm.css'];

/**
 * Listens on `host` (loopback by default: the page is for this machine; docs/frontend.md "npm start"). Rejects on a listen error (e.g. EADDRINUSE).
 * `root` is the directory served: the repository, or a static copy (tools/dist.ts), which has no .ts files to strip.
 */
export function startServer(port = 0, host = '127.0.0.1', root = ROOT): Promise<Server> {
  if (!root.endsWith(sep)) root += sep;
  const allowed = new Set([...ALLOWED, ...(root === ROOT ? runtimeFiles() : [])].map((p) => join(root, p)));
  const server = createServer(async (req, res) => {
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
    res.setHeader('Cache-Control', 'no-store');
    const url = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname);
    if (url === '/' && root === ROOT) {
      res.writeHead(200, { 'Content-Type': TYPES['.html'] }).end(withStamp(atRoot(await readFile(join(ROOT, 'web/app/index.html'), 'utf8')), buildStamp()));
      return;
    }
    const path = normalize(join(root, url.endsWith('/') ? url + 'index.html' : url));
    if (!path.startsWith(root) || (path.split(sep).includes('node_modules') && !allowed.has(path))) {
      res.writeHead(403).end();
      return;
    }
    const ext = extname(path);
    const type = { 'Content-Type': TYPES[ext] ?? 'application/octet-stream' };
    try {
      if (ext === '.ts') {
        const source = (await readFile(path)).toString();
        res.writeHead(200, type).end(path.endsWith('.svelte.ts') ? compileRunes(source, path) : stripTypeScriptTypes(source, { mode: 'strip' }));
        return;
      }
      if (ext === '.svelte') {
        const source = (await readFile(path)).toString();
        try {
          res.writeHead(200, type).end(compileSvelte(source, path));
        } catch (e) {
          // A component that doesn't compile: the page's module fails to load, with the reason in the console.
          res.writeHead(200, type).end(`throw new Error(${JSON.stringify(`${url}: ${String((e as Error).message ?? e)}`)});`);
        }
        return;
      }
      const f = await open(path);
      try {
        const size = (await f.stat()).size;
        const range = parseRange(req.headers.range, size);
        if (range === 'bad') {
          res.writeHead(416, { 'Content-Range': `bytes */${size}` }).end();
        } else if (range) {
          const [start, end] = range;
          const body = Buffer.alloc(end - start + 1);
          await f.read(body, 0, body.length, start);
          res.writeHead(206, { ...type, 'Accept-Ranges': 'bytes', 'Content-Range': `bytes ${start}-${end}/${size}` }).end(req.method === 'HEAD' ? undefined : body);
        } else {
          res.writeHead(200, { ...type, 'Accept-Ranges': 'bytes', 'Content-Length': size });
          res.end(req.method === 'HEAD' ? undefined : await f.readFile());
        }
      } finally {
        await f.close();
      }
    } catch {
      if (res.headersSent) res.destroy(); // the client went away mid-answer
      else res.writeHead(404).end();
    }
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => { server.off('error', reject); resolve(server); });
  });
}

/** One `bytes=a-b`, `a-` or `-n` range, clamped to the file; 'bad' if unsatisfiable; undefined for none or a multi-range (served whole). */
export function parseRange(h: string | undefined, size: number): [number, number] | 'bad' | undefined {
  const m = h?.match(/^bytes=(\d*)-(\d*)$/);
  if (!m || (m[1] === '' && m[2] === '')) return undefined;
  const [start, end] = m[1] === '' ? [Math.max(0, size - Number(m[2])), size - 1] : [Number(m[1]), m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1)];
  return start < 0 || start > end || start >= size ? 'bad' : [start, end];
}

if (import.meta.main) {
  prepareTailnetClient(); // the Network menu's client (tools/tailscale.ts): built if missing or stale, never fatal
  const server = await startServer(Number(process.env.PORT ?? 8080));
  const addr = server.address();
  if (addr && typeof addr === 'object') console.log(`serving ${ROOT} at http://127.0.0.1:${addr.port}/ (the page)`);
}
