// PERF loop 16 (bench/gpu/REPORT.md "PERF loop 16: virgl's query poll"): how long a GL program waits on an occlusion
// query's result, by how the GPU worker polls pending queries (`?querypoll=`, web/virgl-host.ts `QueryPoll`). glquery
// (images/alpine/gl/glquery.c) on alpine-virgl through tests/browser/virgl-boot.html (the page's GPU worker, the guest
// under the JIT in a worker), each arm in turn, ROUNDS rounds alternated. Needs images/build.sh alpine-gl alpine-virgl.
//   node bench/gpu/query-wait.ts <arm,arm,...> [ignored] [outdir]   (timeout,message,wait)
// GLQ=frames,queries,width,height (default 300,4,640,480), ROUNDS (default 3). Writes <outdir>/query-wait.json: per
// arm and round glquery's lines parsed (each wait's and glFinish's quartiles, ms; frames/s) and the GPU worker's
// render stats over the frames (the polls a second and the ms a second some query was pending).
import { mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright-core';
import { startServer } from '../../tools/serve.ts';
import { chromiumEnv } from '../../tools/nosme.ts';

const arms = (process.argv[2] ?? 'timeout,message,wait').split(',');
const out = process.argv[4] ?? new URL('../results/local/query-wait/', import.meta.url).pathname;
mkdirSync(out, { recursive: true });
const ROUNDS = Number(process.env.ROUNDS ?? 3);
const GLQ = process.env.GLQ ?? '300,4,640,480';
const server = await startServer();
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium', args: process.env.CHROMIUM_ARGS?.split(' ').filter(Boolean) ?? [], env: chromiumEnv() });
const version = browser.version();

type Quart = { n: number; p25: number; median: number; p75: number; max: number };
type Stat = { queryPolls: number; queryPendingMs: number; busyMs: number; fences: number; fenceMs: number };
const rows: { arm: string; round: number; renderer?: string; fps?: number; msPerFrame?: number; wait?: Quart; finish?: Quart; passed?: string; seconds: number; stats: Stat[]; error?: string }[] = [];
const quart = (con: string, name: string): Quart | undefined => {
  const m = con.match(new RegExp(`glquery: ${name} n=(\\d+) p25 ([\\d.]+) median ([\\d.]+) p75 ([\\d.]+) max ([\\d.]+) ms`));
  return m ? { n: +m[1], p25: +m[2], median: +m[3], p75: +m[4], max: +m[5] } : undefined;
};

for (let round = 0; round < ROUNDS; round++) {
  for (const arm of round % 2 ? [...arms].reverse() : arms) {
    const t0 = Date.now();
    const page = await browser.newPage();
    page.on('console', (m) => { if (m.type() === 'warning' || m.type() === 'error') console.log(`  [${arm}] ${m.text()}`); });
    await page.goto(`${base}/tests/browser/virgl-boot.html?glq=${GLQ}&querypoll=${arm}`);
    const r = await (await page.waitForFunction(() => (window as unknown as { result?: unknown }).result, null, { timeout: 400_000, polling: 250 })).jsonValue() as { error?: string; console?: string };
    // The worker's seconds while glquery's timed frames ran: those between its "frames start" and the run's end.
    const stats = await page.evaluate(() => (window as unknown as { renderStats: Stat[] }).renderStats);
    await page.close();
    const con = r.console ?? '';
    const head = con.match(/glquery: (.+?), (OpenGL ES [^,]+),/);
    const f = con.match(/glquery: frames: (\d+) frames, ([\d.]+) ms a frame, ([\d.]+) frames\/s/);
    const busy = stats.filter((s) => s.queryPolls > 0);
    const row = { arm, round, renderer: head?.[1], fps: f ? +f[3] : undefined, msPerFrame: f ? +f[2] : undefined, wait: quart(con, 'wait'), finish: quart(con, 'finish'), passed: con.match(/glquery: passed (\d+ of \d+)/)?.[1], seconds: (Date.now() - t0) / 1000,
      stats: busy.map((s) => ({ queryPolls: s.queryPolls, queryPendingMs: Math.round(s.queryPendingMs * 10) / 10, busyMs: Math.round(s.busyMs), fences: s.fences, fenceMs: Math.round(s.fenceMs) })), error: r.error ?? (f ? undefined : con.slice(-2000)) };
    rows.push(row);
    const med = (k: keyof Stat) => { const v = busy.map((s) => s[k]).sort((a, b) => a - b); return v.length ? v[v.length >> 1] : NaN; };
    console.log(`round ${round} ${arm}: ${row.fps} frames/s, wait median ${row.wait?.median} (p25 ${row.wait?.p25}, p75 ${row.wait?.p75}) ms, finish median ${row.finish?.median} ms; polls/s ${med('queryPolls')}, pending ms/s ${med('queryPendingMs').toFixed(0)} (${row.seconds.toFixed(0)} s)${row.error ? ` ERROR ${row.error.slice(-300)}` : ''}`);
    writeFileSync(`${out}/query-wait.json`, JSON.stringify({ date: new Date().toISOString(), chromium: version, host: `${process.platform} ${process.arch}`, os: process.platform === 'darwin' ? execFileSync('sw_vers', ['-productVersion']).toString().trim() : execFileSync('uname', ['-r']).toString().trim(), glq: GLQ, rows }, null, 1));
  }
}
await browser.close();
await server.close();
