// The page's servers (docs/frontend.md "The build"), Vite's: `startServer` with the repository as its root is Vite's
// dev server, which serves the whole repository from source (the page at web/app/, `/` redirecting there; the test
// pages under tests/browser/ and bench/; web/'s modules, TypeScript and Svelte compiled per request; the guest images
// and binaries under target/ as files, with range requests), and with another root, Vite's preview server over a build
// (`npm start`, `npm run dist -- --serve`, tests/dist.test.ts). Both send the cross-origin isolation headers.
//   npm run serve     the dev server with hot reloading, for working on the page (PORT sets the port, default 8080)
import type { Server } from 'node:http';
import { sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer, preview } from 'vite';
import { prepareTailnetClient } from './tailscale.ts';

export const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CONFIG = `${ROOT}vite.config.ts`;

/** The page (docs/frontend.md): served at the root. */
export const APP = '/';

/**
 * Listens on `host` (loopback by default: the page is for this machine; docs/frontend.md "npm start"). Rejects on a
 * listen error (e.g. EADDRINUSE). `root` is the directory served: the repository (the dev server; `dev` turns on hot
 * reloading and Svelte's development builds, otherwise it is mode `test`, vite.config.ts), or a build (the preview
 * server). Closing the server closes Vite's too.
 */
export async function startServer(port = 0, host = '127.0.0.1', root = ROOT, { dev = false } = {}): Promise<Server> {
  if (!root.endsWith(sep)) root += sep;
  const quiet = { logLevel: dev ? 'info' : 'warn', clearScreen: false } as const;
  if (root === ROOT) {
    const vite = await createServer({ configFile: CONFIG, mode: dev ? 'development' : 'test', server: { port, host, strictPort: true }, ...quiet });
    await vite.listen();
    return closing(vite.httpServer as Server, () => vite.close());
  }
  const vite = await preview({ configFile: CONFIG, build: { outDir: root }, preview: { port, host, strictPort: true, open: false }, ...quiet });
  return closing(vite.httpServer as Server, () => vite.close());
}

/** The HTTP server, its `close` closing Vite's server around it (which closes the HTTP server with its own `close`). */
function closing(server: Server, close: () => Promise<void>) {
  const own = server.close;
  server.close = ((cb?: (err?: Error) => void) => {
    server.close = own;
    close().then(() => cb?.(), (e: Error) => cb?.(e));
    return server;
  }) as Server['close'];
  return server;
}

if (import.meta.main) {
  prepareTailnetClient(); // the Network menu's client (tools/tailscale.ts): built if missing or stale, never fatal
  const server = await startServer(Number(process.env.PORT ?? 8080), '127.0.0.1', ROOT, { dev: true });
  const addr = server.address();
  if (addr && typeof addr === 'object') console.log(`serving ${ROOT} at http://127.0.0.1:${addr.port}/ (the page, hot reloading)`);
}
