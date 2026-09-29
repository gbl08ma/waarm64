// Dev/test server: serves the repo root on 127.0.0.1 with cross-origin
// isolation headers (needed for SharedArrayBuffer and fine-grained timers).
// .ts files are served as JavaScript with types stripped. Other files honor a
// single `Range: bytes=` request (206 / 416), which the virtio-blk HTTP backend uses.
// `/` redirects to the page (web/app/), a directory serves its index.html, and
// nothing under node_modules is served except the files the page imports (`ALLOWED`).
import { createServer, type Server } from 'node:http';
import { open, readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = fileURLToPath(new URL('..', import.meta.url));

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.ts': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.css': 'text/css; charset=utf-8',
};

/** The page (docs/frontend.md). */
export const APP = '/web/app/';

/** The only files served from node_modules: what the page imports (xterm.js). */
const ALLOWED = new Set(['node_modules/@xterm/xterm/lib/xterm.mjs', 'node_modules/@xterm/xterm/css/xterm.css'].map((p) => join(ROOT, p)));

export function startServer(port = 0): Promise<Server> {
  const server = createServer(async (req, res) => {
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
    res.setHeader('Cache-Control', 'no-store');
    const url = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname);
    if (url === '/') {
      res.writeHead(302, { Location: APP }).end();
      return;
    }
    const path = normalize(join(ROOT, url.endsWith('/') ? url + 'index.html' : url));
    if (!path.startsWith(ROOT) || (path.split(sep).includes('node_modules') && !ALLOWED.has(path))) {
      res.writeHead(403).end();
      return;
    }
    const ext = extname(path);
    const type = { 'Content-Type': TYPES[ext] ?? 'application/octet-stream' };
    try {
      if (ext === '.ts') {
        res.writeHead(200, type).end(stripTypeScriptTypes((await readFile(path)).toString(), { mode: 'strip' }));
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
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

/** One `bytes=a-b`, `a-` or `-n` range, clamped to the file; 'bad' if unsatisfiable; undefined for none or a multi-range (served whole). */
export function parseRange(h: string | undefined, size: number): [number, number] | 'bad' | undefined {
  const m = h?.match(/^bytes=(\d*)-(\d*)$/);
  if (!m || (m[1] === '' && m[2] === '')) return undefined;
  const [start, end] = m[1] === '' ? [Math.max(0, size - Number(m[2])), size - 1] : [Number(m[1]), m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1)];
  return start < 0 || start > end || start >= size ? 'bad' : [start, end];
}

if (import.meta.main) {
  const server = await startServer(Number(process.env.PORT ?? 8080));
  const addr = server.address();
  if (addr && typeof addr === 'object') console.log(`serving ${ROOT} at http://127.0.0.1:${addr.port}/ (the page: http://127.0.0.1:${addr.port}${APP})`);
}
