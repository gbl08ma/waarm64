// A local stand-in for vmdisks.tny.im (bench/demo/REPORT.md "DEMO loop 1"): a static server for a site laid out as
// deploy/disks/ publishes one (one shared `pieces/`, a directory per image with its manifest, a template's definition
// and its snapshot's manifest beside it: docs/remote-disks.md "Publishing an image"), with CORS and `_headers`' caching,
// and a byte count of every response by kind (the page, the snapshot, the disk), so a run's bytes split the way the
// demo's budget does. `count` adds the same count to another server (the page's Vite preview).
import { createReadStream, readFileSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { extname, join, normalize, sep } from 'node:path';
import { brotliCompressSync, constants } from 'node:zlib';

/** One response: when it ended (epoch ms), its path, its kind and its body's bytes. */
export type Served = { t: number; path: string; kind: string; bytes: number };

/** Counts every response of `server` into `log`, its kind by `kindOf(path)` (before the server's own handler runs). */
export function count(server: Server, log: Served[], kindOf: (path: string) => string) {
  server.prependListener('request', (req: IncomingMessage, res: ServerResponse) => {
    const path = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname);
    let bytes = 0;
    const write = res.write.bind(res) as (...a: unknown[]) => boolean;
    const end = res.end.bind(res) as (...a: unknown[]) => ServerResponse;
    const len = (c: unknown) => (typeof c === 'string' ? Buffer.byteLength(c) : c instanceof Uint8Array ? c.length : 0);
    res.write = ((c: unknown, ...a: unknown[]) => ((bytes += len(c)), write(c, ...a))) as typeof res.write;
    res.end = ((c?: unknown, ...a: unknown[]) => {
      if (c && typeof c !== 'function') bytes += len(c);
      return end(c, ...a);
    }) as typeof res.end;
    res.on('finish', () => log.push({ t: Date.now(), path, kind: kindOf(path), bytes }));
  });
}

const TYPES: Record<string, string> = { '.json': 'application/json', '.bin': 'application/octet-stream', '.webp': 'image/webp' };

/** Serves `root` on 127.0.0.1 (CORS for any page, `_headers`' caching: pieces immutable, JSON 5 minutes), counted. */
export async function siteServer(root: string, log: Served[], kindOf: (path: string) => string): Promise<{ base: string; close: () => Promise<void> }> {
  const server = createServer((req, res) => {
    const path = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname);
    const file = normalize(join(root, path));
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Length, ETag');
    if (!file.startsWith(root.endsWith(sep) ? root : root + sep)) return void res.writeHead(403).end();
    let size: number;
    try {
      const st = statSync(file);
      if (!st.isFile()) throw new Error('not a file');
      size = st.size;
    } catch {
      return void res.writeHead(404).end();
    }
    res.setHeader('Content-Type', TYPES[extname(file)] ?? 'application/octet-stream');
    res.setHeader('Content-Length', size);
    res.setHeader('Cache-Control', path.startsWith('/pieces/') ? 'public, max-age=31536000, immutable' : 'public, max-age=300');
    if (req.method === 'HEAD') return void res.end();
    createReadStream(file).pipe(res);
  });
  count(server, log, kindOf);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  // `localhost`: another origin than the page's 127.0.0.1, as vmdisks.tny.im is vm.tny.im's.
  return { base: `http://localhost:${port}`, close: () => new Promise((r) => server.close(() => r())) };
}

/** Bytes by kind in `log`, up to `until` (epoch ms) if given. */
export function bytesByKind(log: Served[], until?: number): Record<string, number> {
  const out: Record<string, number> = {};
  for (const s of log) if (until === undefined || s.t <= until) out[s.kind] = (out[s.kind] ?? 0) + s.bytes;
  return out;
}

const brotli = new Map<string, number>();
/**
 * What the page's files in `log` (kind `page`) would cost brotli-compressed, as a host that compresses text sends them
 * (Cloudflare's static assets: brotli; quality 5 here, close to what it serves), each distinct file once (a fresh
 * profile asks for each once), from `dir`.
 */
export function brotliBytes(log: Served[], dir: string, until?: number): number {
  let n = 0;
  const seen = new Set<string>();
  for (const s of log) {
    if (s.kind !== 'page' || seen.has(s.path) || (until !== undefined && s.t > until)) continue;
    seen.add(s.path);
    const file = join(dir, s.path.endsWith('/') ? `${s.path}index.html` : s.path);
    let b = brotli.get(file);
    if (b === undefined) {
      try {
        b = brotliCompressSync(readFileSync(file), { params: { [constants.BROTLI_PARAM_QUALITY]: 5 } }).length;
      } catch {
        b = s.bytes; // not a file of the build (an answer of the server's own): as sent
      }
      brotli.set(file, b);
    }
    n += Math.min(b, s.bytes || b);
  }
  return n;
}

/** A file of `dir` brotli'd (as `brotliBytes`) over its size: what a byte of it costs on a compressing host's wire. */
export function brotliRatio(dir: string, path: string): number {
  const file = join(dir, path.endsWith('/') ? `${path}index.html` : path);
  let b = brotli.get(file);
  try {
    const size = statSync(file).size;
    if (b === undefined) brotli.set(file, (b = brotliCompressSync(readFileSync(file), { params: { [constants.BROTLI_PARAM_QUALITY]: 5 } }).length));
    return size ? Math.min(1, b / size) : 1;
  } catch {
    return 1;
  }
}

/** A link the throttled servers share (`throttle`): its rate (bits/s) and round trip (ms), the next free moment. */
export type Link = { bps: number; rttMs: number; free: number };
/** A link from `DEMO_LINK=<Mbit/s>/<RTT ms>` (e.g. `100/20`), or none. */
export function linkFromEnv(): Link | undefined {
  const m = /^(\d+(?:\.\d+)?)\/(\d+)$/.exec(process.env.DEMO_LINK ?? '');
  return m ? { bps: Number(m[1]) * 1e6, rttMs: Number(m[2]), free: 0 } : undefined;
}

/**
 * A proxy in front of `port` on 127.0.0.1 whose responses go through `link`: each request waits a round trip before
 * it's forwarded, and the bodies of every proxy on the link share its rate (one connection's worth of a visitor's line;
 * TCP's slow start isn't modelled). `scale`: a path's bytes on the wire per byte sent (the page's files as a host
 * that compresses sends them: `brotliRatio`). Listens on 127.0.0.1; returns its port and how to close it.
 */
export async function throttle(port: number, link: Link, scale: (path: string) => number = () => 1): Promise<{ port: number; close: () => Promise<void> }> {
  const { request } = await import('node:http');
  const server = createServer((req, res) => {
    setTimeout(() => {
      const k = scale(decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname));
      const up = request({ host: '127.0.0.1', port, path: req.url, method: req.method, headers: req.headers }, (r) => {
        res.writeHead(r.statusCode ?? 502, r.headers);
        void (async () => {
          for await (const got of r as AsyncIterable<Buffer>)
            for (let at = 0; at < got.length; at += 64 * 1024) {
              const chunk = got.subarray(at, at + 64 * 1024);
              // The link's next free moment moves by this chunk's time on it.
              const now = performance.now();
              link.free = Math.max(link.free, now) + (chunk.length * k * 8 * 1000) / link.bps;
              await new Promise((w) => setTimeout(w, Math.max(0, link.free - now)));
              res.write(chunk);
            }
          res.end();
        })().catch(() => res.destroy());
      });
      up.on('error', () => res.writeHead(502).end());
      req.pipe(up);
    }, link.rttMs);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { port: (server.address() as { port: number }).port, close: () => new Promise((r) => server.close(() => r())) };
}
