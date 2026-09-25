// Dev/test server: serves the repo root on 127.0.0.1 with cross-origin
// isolation headers (needed for SharedArrayBuffer and fine-grained timers).
// .ts files are served as JavaScript with types stripped. Other files honor a
// single `Range: bytes=` request (206 / 416), which the virtio-blk HTTP backend uses.
import { createServer, type Server } from 'node:http';
import { open, readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = fileURLToPath(new URL('..', import.meta.url));

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.ts': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.css': 'text/css; charset=utf-8',
};

export function startServer(port = 0): Promise<Server> {
  const server = createServer(async (req, res) => {
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
    res.setHeader('Cache-Control', 'no-store');
    const path = normalize(join(ROOT, decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname)));
    if (!path.startsWith(ROOT) || path.split(sep).includes('node_modules')) {
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
      res.writeHead(404).end();
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
  if (addr && typeof addr === 'object') console.log(`serving ${ROOT} at http://127.0.0.1:${addr.port}/`);
}
