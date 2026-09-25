// PC-sampling profile of a warm Buildroot boot in Chromium (PLAN.md §5): a
// sampler worker reads the vCPU's PC from shared memory every 20 µs; samples
// are symbolized with target/images/linux/System.map (user-space PCs are
// grouped as "[user]").
//   node bench/boot/profile.ts [--top N] [--out file.json]
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { parseArgs } from 'node:util';
import { chromium } from 'playwright-core';
import { ROOT, startServer } from '../../tools/serve.ts';

const { values: args } = parseArgs({ options: { top: { type: 'string', default: '30' }, out: { type: 'string' } } });

// Text symbols, sorted by address.
const syms = readFileSync(`${ROOT}/target/images/linux/System.map`, 'utf8')
  .split('\n')
  .map((l) => l.split(' '))
  .filter((f) => f.length === 3 && 'tTwW'.includes(f[1]))
  .map(([a, , name]) => ({ addr: BigInt(`0x${a}`), name }))
  .sort((a, b) => (a.addr < b.addr ? -1 : 1));
const symbolize = (pc: bigint) => {
  if (pc < syms[0].addr) return '[user]';
  let lo = 0;
  let hi = syms.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (syms[mid].addr <= pc) lo = mid;
    else hi = mid - 1;
  }
  return syms[lo].name;
};

const server = await startServer();
const port = (server.address() as { port: number }).port;
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium' });
try {
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${port}/bench/boot/profile.html`);
  const h = await page.waitForFunction(() => (window as unknown as { profile?: unknown }).profile, null, { timeout: 10 * 60_000, polling: 250 });
  const p = (await h.jsonValue()) as { error?: string; totalMs: number; stats: object; samples: [string, number][]; userAgent: string };
  if (p.error) throw new Error(p.error);
  const bySym = new Map<string, number>();
  let total = 0;
  for (const [pc, n] of p.samples) {
    const s = symbolize(BigInt(`0x${pc}`));
    bySym.set(s, (bySym.get(s) ?? 0) + n);
    total += n;
  }
  const top = [...bySym].sort((a, b) => b[1] - a[1]);
  const report = {
    date: new Date().toISOString(),
    host: { platform: os.platform(), arch: os.arch(), cpu: os.cpus()[0]?.model },
    browser: { version: browser.version(), userAgent: p.userAgent },
    bootMs: p.totalMs,
    counters: p.stats,
    samples: total,
    top: top.map(([sym, n]) => ({ sym, samples: n, pct: +((100 * n) / total).toFixed(2) })),
  };
  const out = args.out ?? `bench/results/local/profile-${report.date.replace(/[:.]/g, '-')}.json`;
  mkdirSync(`${ROOT}/${out.split('/').slice(0, -1).join('/')}`, { recursive: true });
  writeFileSync(`${ROOT}/${out}`, JSON.stringify(report, null, 1) + '\n');
  console.log(`${total} samples over a ${p.totalMs.toFixed(0)} ms boot`);
  for (const t of report.top.slice(0, Number(args.top))) console.log(`${t.pct.toFixed(2).padStart(6)}%  ${t.sym}`);
  console.error(`wrote ${out}`);
} finally {
  await browser.close();
  server.close();
}
