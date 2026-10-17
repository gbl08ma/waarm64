// Two firmware builds on the page's Debian, alternating (docs/plans/uefi.md "Graphics in the firmware"): seconds
// from the page's load to BdsDxe loading the boot option, the EFI stub, and the first boot's question (or a login
// prompt), read from the serial terminal every 100 ms. Each round copies the build over
// target/images/edk2/QEMU_EFI.fd; the second is left in place.
//   node bench/boot/firmware-ab.ts <a.fd> <b.fd> [--rounds N] [--query gpu=nopace] [--out file.json]
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { dirname } from 'node:path';
import { parseArgs } from 'node:util';
import { chromium } from 'playwright-core';
import { ROOT, startServer } from '../../tools/serve.ts';

const { values: args, positionals: [A, B] } = parseArgs({
  allowPositionals: true,
  options: { rounds: { type: 'string', default: '4' }, query: { type: 'string', default: '' }, out: { type: 'string' } },
});
if (!A || !B) throw new Error('usage: firmware-ab.ts <a.fd> <b.fd> [--rounds N] [--query q] [--out file.json]');
const FIRMWARE = `${ROOT}/target/images/edk2/QEMU_EFI.fd`;
const MARKS: [string, RegExp][] = [['bds', /BdsDxe: loading/], ['stub', /EFI stub: Booting/], ['ready', /Press any key to proceed|login: ?$/m]];
const LIMIT_MS = 150_000;

const server = await startServer();
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium' });
const version = browser.version();

async function run(): Promise<Record<string, number>> {
  const context = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
  const page = await context.newPage();
  await page.goto(`${base}/web/app/?machine=debian&ncpus=2&view=both&${args.query}`);
  const t0 = Date.now(), marks: Record<string, number> = {};
  let text = '';
  while (Date.now() - t0 < LIMIT_MS && !('ready' in marks)) {
    await page.waitForTimeout(100);
    text = (await page.evaluate(() => document.querySelector('.xterm-rows')?.textContent ?? '')) || text;
    for (const [k, re] of MARKS) if (!(k in marks) && re.test(text)) marks[k] = (Date.now() - t0) / 1000;
  }
  await context.close();
  return marks;
}

const runs: Record<'a' | 'b', Record<string, number>[]> = { a: [], b: [] };
try {
  for (let i = 0; i < Number(args.rounds); i++) {
    for (const [k, f] of [['a', A], ['b', B]] as const) {
      copyFileSync(f, FIRMWARE);
      const r = await run();
      runs[k].push(r);
      console.log(k, JSON.stringify(r));
    }
  }
} finally {
  copyFileSync(B, FIRMWARE);
  await browser.close();
  server.close();
}
const median = (xs: number[]) => { const s = [...xs].sort((x, y) => x - y); return s.length % 2 ? s[s.length >> 1] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2; };
const medians = Object.fromEntries((['a', 'b'] as const).map((k) => [k, Object.fromEntries(MARKS.map(([m]) => [m, median(runs[k].map((r) => r[m]).filter((x) => x !== undefined))]))]));
console.log('medians', JSON.stringify(medians));
if (args.out) {
  mkdirSync(dirname(args.out), { recursive: true });
  const host = `${os.platform()}-${os.arch()}, ${os.cpus().length} CPUs`;
  writeFileSync(args.out, `${JSON.stringify({ date: new Date().toISOString(), host, chromium: version, a: A, b: B, query: args.query, runs, medians }, null, 1)}\n`);
}
