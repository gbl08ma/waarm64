// A small static server for VK0's pages (bench/vulkan/webgpu/): cross-origin isolated (COOP/COEP), serving `.ts` as
// JavaScript with its types stripped by Node itself (the pages use erasable syntax only), so the pages need neither
// Vite nor the repository's packages: the NVIDIA desktop's script (bench/vulkan/nvidia.sh) runs them from a copy.
// Paths map onto the root; `/target/...` onto the target directory, which may live elsewhere.
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { stripTypeScriptTypes } from 'node:module';
import { extname, join, normalize } from 'node:path';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.ts': 'text/javascript', '.json': 'application/json',
  '.wasm': 'application/wasm', '.pack': 'application/octet-stream',
};

export function serve(root: string, target: string, port = 0): Promise<Server> {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const path = normalize(decodeURIComponent(url.pathname));
    if (path.includes('..')) { res.writeHead(400).end(); return; }
    const file = path.startsWith('/target/') ? join(target, path.slice('/target/'.length)) : join(root, path);
    if (!existsSync(file) || !statSync(file).isFile()) { res.writeHead(404).end(); return; }
    const headers = { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream', 'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp', 'Cache-Control': 'no-store' };
    if (extname(file) === '.ts') {
      res.writeHead(200, headers).end(stripTypeScriptTypes(readFileSync(file, 'utf8'), { mode: 'strip' }));
      return;
    }
    res.writeHead(200, { ...headers, 'Content-Length': statSync(file).size });
    createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}
