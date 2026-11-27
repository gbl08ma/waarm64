// Runs a benchmark page in a pinned Chromium via Playwright and writes a
// results JSON (see bench/README.md for the schema).
//   node bench/run.ts [--quick] [--only <bench>] [--config default|liftoff-only|turbofan-only|bounds-checks] [--flags='<more V8 flags>'] [--chromium-args='<Chromium switches>'] [--query='<more of the page query>'] [--profile=<dir>]
import { execSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { chromium } from 'playwright-core';
import { ROOT, startServer } from '../tools/serve.ts';
import { procServer } from './procstat.ts';
import { summarize } from './stats.ts';

const CONFIGS: Record<string, string> = {
  default: '',
  'liftoff-only': '--liftoff-only',
  'turbofan-only': '--no-liftoff',
  'bounds-checks': '--wasm-enforce-bounds-checks', // explicit checks even where guard regions exist
};

const { values: args } = parseArgs({
  options: {
    quick: { type: 'boolean', default: false },
    only: { type: 'string' },
    config: { type: 'string', default: 'default' },
    page: { type: 'string', default: 'bench/spike/index.html' },
    out: { type: 'string' },
    input: { type: 'string' }, // a file for the page's #bench-file input (bench/io)
    flags: { type: 'string', default: '' },
    'chromium-args': { type: 'string', default: '' }, // e.g. the WebGPU switches of bench/gpu (docs/benchmarking.md)
    query: { type: 'string' }, // more of the page's query (e.g. `nocw`: bench/boot without the JIT's compile worker)
    // A persistent profile, made fresh under this directory and removed at the end: OPFS on disk, as a user's (the
    // default context is off the record: OPFS in memory, ~0.3 ms a call, a flush free). On a real disk, not tmpfs.
    profile: { type: 'string' },
  },
});
if (CONFIGS[args.config!] === undefined) throw new Error(`unknown --config ${args.config}; one of ${Object.keys(CONFIGS)}`);
// --expose-gc: benchmarks may collect before a measurement (bench/boot/suite.ts).
const jsFlags = ['--expose-gc', CONFIGS[args.config!], args.flags].filter(Boolean).join(' ');

const git = (cmd: string) => { try { return execSync(`git ${cmd}`, { cwd: ROOT, stdio: 'pipe' }).toString().trim(); } catch { return null; } };

const server = await startServer();
const port = (server.address() as { port: number }).port;
// The browser's CPU counters for the page's samples (bench/procstat.ts; `?proc=<port>`: bench/boot/suite.ts).
const proc = await procServer(process.pid);
const launch = {
  executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium',
  args: [...(jsFlags ? [`--js-flags=${jsFlags}`] : []), ...args['chromium-args']!.split(' ').filter(Boolean)],
};
let profileDir: string | undefined;
if (args.profile) {
  mkdirSync(resolve(ROOT, args.profile), { recursive: true });
  profileDir = mkdtempSync(join(resolve(ROOT, args.profile), 'profile-'));
}
const browser = profileDir ? undefined : await chromium.launch(launch);
const context = profileDir ? await chromium.launchPersistentContext(profileDir, { ...launch, headless: true }) : await browser!.newContext();
try {
  const page = context.pages()[0] ?? (await context.newPage());
  page.on('console', (m) => console.error(`[page] ${m.text()}`));
  const qs = new URLSearchParams();
  if (args.quick) qs.set('quick', '');
  if (args.only) qs.set('only', args.only);
  qs.set('proc', String((proc.address() as { port: number }).port));
  for (const [k, v] of new URLSearchParams(args.query ?? '')) qs.set(k, v);
  await page.goto(`http://127.0.0.1:${port}/${args.page}?${qs}`);
  if (args.input) await page.setInputFiles('#bench-file', args.input);
  let seen = 0;
  const printLog = async () => {
    const text = await page.locator('#log').textContent().catch(() => '');
    const lines = (text ?? '').split('\n').filter(Boolean);
    for (; seen < lines.length; seen++) console.error(lines[seen]);
  };
  const poll = setInterval(printLog, 1000);
  const handle = await page.waitForFunction(() => (window as unknown as { benchResult?: unknown }).benchResult, null, { timeout: 60 * 60_000, polling: 250 });
  clearInterval(poll);
  await printLog(); // the lines of the last second
  const data = (await handle.jsonValue()) as { error?: string; results: { name: string; unit: string; params?: object; samples: number[] }[]; crossOriginIsolated: boolean; userAgent: string };
  if (data.error) throw new Error(`benchmark failed in page: ${data.error}`);
  if (!data.crossOriginIsolated) throw new Error('page is not cross-origin isolated; timers and SharedArrayBuffer would be degraded');

  const report = {
    schema: 1,
    page: args.page,
    date: new Date().toISOString(),
    commit: git('rev-parse --short=12 HEAD'),
    dirty: Boolean(git('status --porcelain')),
    config: args.config,
    jsFlags,
    chromiumArgs: args['chromium-args'],
    query: args.query,
    quick: args.quick,
    profile: profileDir ? 'persistent' : 'off the record',
    host: { platform: os.platform(), arch: os.arch(), cpu: os.cpus()[0]?.model, cores: os.cpus().length, memGiB: Math.round(os.totalmem() / 2 ** 30) },
    browser: { version: browser?.version() ?? (await (await context.newCDPSession(page)).send('Browser.getVersion')).product.split('/')[1], userAgent: data.userAgent },
    results: data.results.map((r) => ({ ...r, ...summarize(r.samples) })),
  };
  const out = args.out ?? `bench/results/local/${report.date.replace(/[:.]/g, '-')}-${args.config}.json`;
  mkdirSync(`${ROOT}/${out.split('/').slice(0, -1).join('/')}`, { recursive: true });
  writeFileSync(`${ROOT}/${out}`, JSON.stringify(report, null, 1) + '\n');
  for (const r of report.results) {
    console.log(`${r.name.padEnd(28)} ${JSON.stringify(r.params ?? {}).padEnd(66)} ${r.median.toFixed(3).padStart(10)} ±${r.iqr.toFixed(3)} ${r.unit}`);
  }
  console.error(`wrote ${out}`);
} finally {
  await context.close();
  await browser?.close();
  if (profileDir) rmSync(profileDir, { recursive: true, force: true });
  server.close();
  proc.close();
}
