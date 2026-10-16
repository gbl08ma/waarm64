// T6 (docs/plans/tailnet-client.md §6): the two Tailscale clients side by side in Chromium, no
// guest, against the test tailnet (tests/net/tailnet.sh) and its local DERP. Alternating Go and
// Rust, a fresh browser context each run, the page of tests/tailscale-browser.test.ts
// (tests/browser/tailscale.html): the module's load time, time to `Running`, UDP echo RTT (one at a
// time) and throughput (1,228-byte echoes, 32 in flight, each way), the worker's memory
// (`performance.measureUserAgentSpecificMemory`, eager) and the worker thread's CPU over the
// throughput run (from /proc: the renderer's `DedicatedWorker` threads, so this must be the only
// Chromium running). The modules' sizes raw, gzip and Brotli.
// Usage: node bench/net/clients.ts [runs per client] [echoes] (WEBPC_TS_JSON=<file> writes the numbers)
import { execFileSync, spawnSync } from 'node:child_process';
import { createSocket } from 'node:dgram';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { brotliCompressSync, constants, gzipSync } from 'node:zlib';
import { chromium, type Page } from 'playwright-core';
import { startServer } from '../../tools/serve.ts';

const ROOT = new URL('../..', import.meta.url).pathname;
const runs = Number(process.argv[2] ?? 5);
const n = Number(process.argv[3] ?? 20000);
const script = process.env.WEBPC_TAILNET_SCRIPT ?? `${ROOT}tests/net/tailnet.sh`;
const modules: Record<string, string> = { go: `${ROOT}target/net/tailscale.wasm`, rust: `${ROOT}target/net/ts.wasm` };

const size = Object.fromEntries(Object.entries(modules).map(([k, f]) => {
  const b = readFileSync(f);
  return [k, { raw: b.length, gzip: gzipSync(b, { level: 9 }).length, brotli: brotliCompressSync(b, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }).length }];
}));
console.log('size', JSON.stringify(size));

/** CPU seconds of every Chromium renderer's DedicatedWorker threads (utime + stime), and how many there are. */
function workerCpu() {
  const tck = 100;
  let ticks = 0;
  let workers = 0;
  for (const pid of readdirSync('/proc').filter((p) => /^\d+$/.test(p))) {
    let cmd: string;
    try { cmd = readFileSync(`/proc/${pid}/cmdline`, 'utf8'); } catch { continue; }
    if (!cmd.includes('--type=renderer')) continue;
    for (const tid of readdirSync(`/proc/${pid}/task`)) {
      try {
        if (!readFileSync(`/proc/${pid}/task/${tid}/comm`, 'utf8').startsWith('DedicatedWorker')) continue;
        workers++;
        const f = readFileSync(`/proc/${pid}/task/${tid}/stat`, 'utf8').split(') ')[1].split(' ');
        ticks += Number(f[11]) + Number(f[12]);
      } catch { /* the thread ended */ }
    }
  }
  return { s: ticks / tck, workers };
}

const env = Object.fromEntries(execFileSync(script, ['up'], { encoding: 'utf8', timeout: 240_000 }).trim().split('\n').map((l) => l.split(/=(.*)/s).slice(0, 2) as [string, string]));
const echo = createSocket('udp4');
echo.on('message', (m, r) => echo.send(m, r.port, r.address));
await new Promise<void>((resolve) => echo.bind(0, '127.0.0.1', resolve));
const server = await startServer();
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium', args: ['--enable-blink-features=ForceEagerMeasureMemory'] });
const version = browser.version();

type Mem = { bytes: number; breakdown: { bytes: number; types: string[]; attribution: { url: string; scope: string }[] }[] };
const workerBytes = async (page: Page) => {
  const m = await page.evaluate('performance.measureUserAgentSpecificMemory()') as Mem;
  return m.breakdown.filter((b) => b.attribution.some((a) => a.scope === 'DedicatedWorkerGlobalScope')).reduce((s, b) => s + b.bytes, 0);
};

const results: Record<string, unknown>[] = [];
try {
  for (let r = 0; r < runs; r++) {
    for (const backend of r % 2 ? ['rust', 'go'] : ['go', 'rust']) {
      const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
      const page = await ctx.newPage();
      page.on('pageerror', (e) => console.log(`# page error: ${e}`));
      try {
        const key = execFileSync(script, ['key'], { encoding: 'utf8' }).trim();
        await page.goto(`${base}/tests/browser/tailscale.html?${new URLSearchParams({ tsbackend: backend, control: env.WEBPC_TS_CONTROL, peer: env.WEBPC_TS_PEER_IP, port: String(echo.address().port), authkey: key, hostname: `${backend}-bench-${r}` })}`);
        await page.waitForFunction('window.harness?.tailscale().state === "Running" && window.harness.tailscale().lease', null, { timeout: 60_000, polling: 50 });
        const s = await page.evaluate('window.harness.tailscale()') as { timings: { loadMs: number; runningMs: number } };
        const memRunning = await workerBytes(page);
        await page.evaluate('window.harness.echoes(20, 32, 1)'); // the WireGuard handshake
        const small = await page.evaluate('window.harness.echoes(500, 32, 1)') as { back: number; ms: number };
        const c0 = workerCpu();
        const big = await page.evaluate(`window.harness.echoes(${n}, 1200, 32)`) as { back: number; ms: number };
        const c1 = workerCpu();
        if (c0.workers !== 1 || c1.workers !== 1) throw new Error(`${c1.workers} worker threads: the CPU numbers need this page's to be the only one`);
        const memAfter = await workerBytes(page);
        const mbps = big.back * 1228 * 8 / big.ms / 1000;
        const cpu = (c1.s - c0.s) / (big.ms / 1000); // the worker's cores during the run
        const row = { backend, run: r, loadMs: s.timings.loadMs, runningMs: s.timings.runningMs, rttMs: small.ms / small.back, echoesBack: big.back, echoes: n, mbpsEachWay: mbps, workerCores: cpu, workerCoreMsPerMbit: cpu * 1000 / (2 * mbps), workerMemRunning: memRunning, workerMemAfter: memAfter };
        results.push(row);
        console.log(JSON.stringify(row));
      } finally {
        await ctx.close();
      }
    }
  }
} finally {
  await browser.close();
  server.close();
  echo.close();
  spawnSync(script, ['down']);
}
const out = { date: new Date().toISOString(), chromium: version, runs, echoes: n, size, results };
if (process.env.WEBPC_TS_JSON) writeFileSync(process.env.WEBPC_TS_JSON, JSON.stringify(out, null, 2) + '\n');
