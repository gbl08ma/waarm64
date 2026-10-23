// A disk host for bench/remote-disk: files under a root served with range requests and CORS, as a remote host must
// (docs/plans/remote-disks.md §3), with latency and bandwidth added and every request logged. The path's leading
// segments set them: `/d<ms>/` waits that long before answering (a round trip), `/r<MB/s>/` paces the body,
// `/pages/` answers a `Range` with 200 and the whole file (Cloudflare Pages); e.g. `/d47/r20/desktop.qcow2`.
//   const s = await diskServer(root); s.url; s.log (each request: t, path, range, bytes, ms); s.close()
import { createReadStream, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { join, normalize } from 'node:path';

export type Logged = { t: number; path: string; method: string; start: number; end: number; status: number; ms: number };

export async function diskServer(root: string, port = 0) {
  const log: Logged[] = [];
  const server = createServer(async (req, res) => {
    const t = performance.timeOrigin + performance.now();
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Range, Content-Length, Accept-Ranges, ETag');
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'Access-Control-Allow-Methods': 'GET, HEAD', 'Access-Control-Allow-Headers': 'Range', 'Access-Control-Max-Age': '86400' });
      return void res.end();
    }
    let path = decodeURIComponent(new URL(req.url!, 'http://x').pathname);
    let delay = 0, rate = 0, pages = false;
    for (;;) {
      const m = /^\/(d(\d+)|r(\d+(?:\.\d+)?)|pages)(\/.*)$/.exec(path);
      if (!m) break;
      if (m[2]) delay = +m[2];
      else if (m[3]) rate = +m[3] * 1e6;
      else pages = true;
      path = m[4];
    }
    const file = join(root, normalize(path));
    let size: number, mtime: Date;
    try {
      ({ size, mtime } = statSync(file));
    } catch {
      res.writeHead(404);
      return void res.end();
    }
    const range = !pages && /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? '');
    const start = range ? +range[1] : 0;
    const end = range ? Math.min(size - 1, range[2] ? +range[2] : size - 1) : size - 1;
    const status = range ? 206 : 200;
    if (delay) await new Promise((r) => setTimeout(r, delay));
    res.writeHead(status, {
      'Accept-Ranges': pages ? 'none' : 'bytes', 'Content-Length': String(end - start + 1), 'ETag': `"${size}-${mtime.getTime()}"`,
      'Last-Modified': mtime.toUTCString(), 'Content-Type': 'application/octet-stream',
      ...(range ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {}),
    });
    const done = () => log.push({ t, path, method: req.method!, start, end, status, ms: performance.timeOrigin + performance.now() - t });
    if (req.method === 'HEAD') return void (res.end(), done());
    const stream = createReadStream(file, { start, end, highWaterMark: 64 << 10 });
    if (!rate) return void stream.pipe(res).on('finish', done);
    // Paced: each chunk no sooner than the rate allows since the body began.
    const t0 = performance.now();
    let sent = 0;
    for await (const chunk of stream) {
      sent += (chunk as Buffer).length;
      const due = t0 + (sent / rate) * 1000 - performance.now();
      if (due > 1) await new Promise((r) => setTimeout(r, due));
      if (!res.write(chunk)) await new Promise((r) => res.once('drain', r));
    }
    res.end();
    done();
  });
  await new Promise<void>((r) => server.listen(port, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return { url, log, close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }) };
}
