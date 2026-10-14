// Two page queries on the page's Debian, alternating (bench/boot/REPORT.md "M9: FEAT_RNG and FEAT_E0PD"): seconds from
// the page's load to BdsDxe loading the boot option, the EFI stub and the login prompt (unattended: the tests'
// credentials, so no first-boot questions), read from the serial terminal every 100 ms; then, logged in as root,
// ms for a syscall-heavy workload timed in the guest (300 fork+exec of /bin/true, `dd` of 300,000 64-byte blocks)
// and the kernel's KPTI line.
//   node bench/boot/page-ab.ts <query a> <query b> [--rounds N] [--out file.json]     e.g. e0pd=0 e0pd=1
import { mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { dirname } from 'node:path';
import { parseArgs } from 'node:util';
import { chromium, type Page } from 'playwright-core';
import { unattendedQuery } from '../../tests/debian-unattended.ts';
import { startServer } from '../../tools/serve.ts';

const { values: args, positionals: [A, B] } = parseArgs({
  allowPositionals: true,
  options: { rounds: { type: 'string', default: '4' }, out: { type: 'string' } },
});
if (A === undefined || B === undefined) throw new Error('usage: page-ab.ts <query a> <query b> [--rounds N] [--out file.json]');
const MARKS: [string, RegExp][] = [['bds', /BdsDxe: loading/], ['stub', /EFI stub: Booting/], ['login', /login: *$/]];
const LIMIT_MS = 150_000;
const WORKLOAD = 'clear; dmesg | grep -c "isolation forced ON"; s=$(date +%s%N); for i in $(seq 300); do /bin/true; done; m=$(date +%s%N); '
  + 'dd if=/dev/zero of=/dev/null bs=64 count=300000 2>/dev/null; e=$(date +%s%N); echo "==kpti-$(dmesg | grep -c "isolation forced ON") fork-$(( (m-s)/1000000 )) dd-$(( (e-m)/1000000 ))=="\n';

const server = await startServer();
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium' });
const version = browser.version();
const terminal = (page: Page) => page.evaluate(() => document.querySelector('.xterm-rows')?.textContent ?? '');

async function type(page: Page, text: string) {
  await page.locator('.xterm').click();
  await page.keyboard.type(text, { delay: 10 });
}

async function run(q: string): Promise<Record<string, number>> {
  const context = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
  try {
    const page = await context.newPage();
    await page.goto(`${base}/web/app/?ncpus=2&view=both&${unattendedQuery()}&${q}`);
    const t0 = Date.now(), r: Record<string, number> = {};
    while (Date.now() - t0 < LIMIT_MS && !('login' in r)) {
      await page.waitForTimeout(100);
      const text = await terminal(page);
      for (const [k, re] of MARKS) if (!(k in r) && re.test(text)) r[k] = (Date.now() - t0) / 1000;
    }
    if (!('login' in r)) throw new Error(`no login prompt in ${LIMIT_MS} ms: ${await terminal(page)}`);
    await type(page, 'root\n');
    await page.waitForFunction(() => /root@\S+:~# /.test(document.querySelector('.xterm-rows')?.textContent ?? ''), null, { timeout: 60_000 });
    await type(page, WORKLOAD);
    await page.waitForFunction(() => /==kpti-\d+ fork-\d+ dd-\d+==/.test(document.querySelector('.xterm-rows')?.textContent ?? ''), null, { timeout: 120_000 });
    const [, kpti, fork, dd] = (await terminal(page)).match(/==kpti-(\d+) fork-(\d+) dd-(\d+)==/)!;
    return { ...r, kpti: Number(kpti), fork: Number(fork), dd: Number(dd) };
  } finally {
    await context.close();
  }
}

const runs: Record<'a' | 'b', Record<string, number>[]> = { a: [], b: [] };
try {
  for (let i = 0; i < Number(args.rounds); i++) {
    for (const [k, q] of [['a', A], ['b', B]] as const) {
      const r = await run(q);
      runs[k].push(r);
      console.log(k, JSON.stringify(r));
    }
  }
} finally {
  await browser.close();
  server.close();
}
const quantile = (xs: number[], p: number) => { const s = [...xs].sort((x, y) => x - y), i = (s.length - 1) * p, lo = Math.floor(i); return s[lo] + (s[Math.ceil(i)] - s[lo]) * (i - lo); };
const keys = Object.keys(runs.a[0]);
const summary = Object.fromEntries((['a', 'b'] as const).map((k) => [k, Object.fromEntries(keys.map((m) => {
  const xs = runs[k].map((r) => r[m]);
  return [m, { median: quantile(xs, 0.5), iqr: quantile(xs, 0.75) - quantile(xs, 0.25) }];
}))]));
console.log('summary', JSON.stringify(summary));
if (args.out) {
  mkdirSync(dirname(args.out), { recursive: true });
  const host = `${os.platform()}-${os.arch()}, ${os.cpus().length} CPUs`;
  writeFileSync(args.out, `${JSON.stringify({ date: new Date().toISOString(), host, chromium: version, a: A, b: B, runs, summary }, null, 1)}\n`);
}
