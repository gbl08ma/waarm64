// Dev/test server: serves the repo root on 127.0.0.1 with cross-origin
// isolation headers (needed for SharedArrayBuffer and fine-grained timers).
// .ts files are served as JavaScript with types stripped.
import { createServer, type Server } from 'node:http';
import { readFile } from 'node:fs/promises';
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
    try {
      let body: string | Buffer = await readFile(path);
      const ext = extname(path);
      if (ext === '.ts') body = stripTypeScriptTypes(body.toString(), { mode: 'strip' });
      res.writeHead(200, { 'Content-Type': TYPES[ext] ?? 'application/octet-stream' }).end(body);
    } catch {
      res.writeHead(404).end();
    }
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

if (import.meta.main) {
  const server = await startServer(Number(process.env.PORT ?? 8080));
  const addr = server.address();
  if (addr && typeof addr === 'object') console.log(`serving ${ROOT} at http://127.0.0.1:${addr.port}/`);
}
