// A CPU workload on three in-browser Linux systems, timed the same way (bench/compare/REPORT.md; docs/comparison.md
// §3): bench/compare/work.pl, six kernels in plain Perl, typed into each guest's shell and run there with the guest's
// own perl. Headless Chromium on this host, a fresh profile and boot per round, the systems one after another in each
// round (alternated), `--runs` runs of the workload per boot:
//   waarm64    this checkout's page (the dev server), Debian 13 arm64 through UEFI (`?machine=debian`, the tests' guest)
//   unkernel   https://unkernel.dev/ as shipped (its distribution's perl)
//   v86        https://copy.sh/v86/?profile=archlinux as shipped (Arch Linux 32, i686)
// A run's time is the host's, from the workload's first line (B0) to its last (B9) on the guest's console (polled every
// 20 ms); the guest's own CPU seconds per kernel (`times`) and each kernel's checksum are kept beside it.
//   node bench/compare/run.ts [--rounds 3] [--runs 3] [--size 4] [--only waarm64,unkernel,v86] [--out <file>]
import { execSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import os from 'node:os';
import { dirname } from 'node:path';
import { parseArgs } from 'node:util';
import { chromium, type Page } from 'playwright-core';
import { chromiumEnv } from '../../tools/nosme.ts';
import { startServer } from '../../tools/serve.ts';
import { unattendedQuery } from '../../tests/debian-unattended.ts';
import { TARGETS } from '../demo/targets.ts';
import { summarize } from '../stats.ts';

const { values: args } = parseArgs({
  options: { rounds: { type: 'string', default: '3' }, runs: { type: 'string', default: '3' }, size: { type: 'string', default: '4' }, only: { type: 'string' }, out: { type: 'string' } },
});
const log = (...a: unknown[]) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a);
/** The workload without its comments and blank lines: what is typed. */
const WORK = readFileSync(new URL('work.pl', import.meta.url), 'utf8').split('\n').filter((l) => l.trim() && !l.startsWith('#')).join('\n');

type System = {
  name: string;
  what: string;
  url: (base: string) => string;
  /** To a root shell. */
  shell: (page: Page) => Promise<void>;
  type: (page: Page, s: string) => Promise<void>;
  /** The console's text. */
  text: (page: Page) => Promise<string>;
  /** Appended to a command so that its output reaches the console `text` reads. */
  to: string;
};

const until = async (page: Page, sys: System, re: RegExp, ms: number, what: string) => {
  for (const end = Date.now() + ms; ; await page.waitForTimeout(20)) {
    const text = await sys.text(page);
    if (re.test(text)) return { at: Date.now(), text };
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}; the console's end: ${JSON.stringify(text.slice(-400))}`);
  }
};

const ours: System = {
  name: 'waarm64',
  what: "this checkout's page on the dev server: Debian 13 (arm64, the published nocloud image) booted through UEFI, the tests' machine (`?machine=debian`)",
  url: (base) => `${base}/web/app/?clocksync=0&${unattendedQuery()}&view=terminal`,
  shell: async (page) => {
    await until(page, ours, /localhost login:\s*$/, 240_000, 'the login prompt');
    await ours.type(page, 'root\n');
    await until(page, ours, /root@localhost:~#\s*$/, 60_000, 'the shell');
  },
  type: async (page, s) => {
    await page.locator('.xterm').click();
    await page.keyboard.type(s, { delay: 2 });
  },
  text: (page) => page.evaluate(() => [...document.querySelectorAll('.xterm-rows > div')].map((r) => r.textContent).join('\n').trimEnd()),
  to: '',
};
const peer = (target: string, name: string, what: string, to: string, settle: (page: Page) => Promise<unknown> = async () => {}): System => {
  const t = TARGETS[target];
  return { name, what, url: () => t.url(''), shell: async (page) => { await t.prompt(page, t.timeoutMs); await settle(page); }, type: t.type, text: t.text, to };
};
const SYSTEMS: System[] = [
  ours,
  peer('unkernel', 'unkernel', 'https://unkernel.dev/ as shipped', ''),
  peer('v86-arch', 'v86', 'https://copy.sh/v86/?profile=archlinux as shipped: Arch Linux 32 (i686) resumed from its saved state', ' > /dev/ttyS0 2>&1', (page) => page.waitForTimeout(3000)),
].filter((s) => !args.only || args.only.split(',').includes(s.name));

type Run = { ms: number; kernels: { cpu: number; sum: string }[] };
type Boot = { system: string; round: number; guest?: string; runs: Run[]; error?: string };

async function boot(sys: System, round: number, base: string): Promise<Boot> {
  const out: Boot = { system: sys.name, round, runs: [] };
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium', headless: true, env: chromiumEnv() });
  const page = await (await browser.newContext({ viewport: { width: 1400, height: 1000 } })).newPage();
  try {
    await page.goto(sys.url(base), { timeout: 60_000 });
    await sys.shell(page);
    // What the guest is, for the record; then the workload, typed as a here-document.
    // (A marker is printed in two parts, so that the command as typed, which the console echoes, isn't taken for it.)
    await sys.type(page, `( printf 'G%s:%s;\\n' 0 "$(uname -m) perl $(perl -e 'print $]') $(nproc) CPUs, $(. /etc/os-release; echo $PRETTY_NAME)" )${sys.to}\n`);
    out.guest = /G0:([^;]*);/.exec((await until(page, sys, /G0:[^$;]*;/, 60_000, "the guest's description")).text)?.[1];
    await sys.type(page, `cat > /tmp/w.pl <<'EOF'\n${WORK}\nEOF\n`);
    await sys.type(page, `( printf 'W%s:%s;\\n' 0 $(wc -c < /tmp/w.pl) )${sys.to}\n`);
    const typed = /W0:\s*(\d+);/.exec((await until(page, sys, /W0:\s*\d+;/, 120_000, 'the workload typed')).text)?.[1];
    if (Number(typed) !== Buffer.byteLength(WORK) + 1) throw new Error(`the guest has ${typed} bytes of the workload, not ${Buffer.byteLength(WORK) + 1}`);
    for (let n = 0; n < Number(args.runs); n++) {
      const id = `${round}${n}`;
      await sys.type(page, `perl /tmp/w.pl ${args.size} ${id}${sys.to}\n`);
      const start = await until(page, sys, new RegExp(`B0:${id};`), 120_000, 'the start');
      const end = await until(page, sys, new RegExp(`B9:${id};`), 900_000, 'the end');
      const kernels = [...end.text.matchAll(new RegExp(`K${id}\\.(\\d) (\\d+\\.\\d\\d) ([^;]*);`, 'g'))].map((m) => ({ cpu: Number(m[2]), sum: m[3] }));
      out.runs.push({ ms: end.at - start.at, kernels });
      log(`${sys.name} round ${round} run ${n}: ${((end.at - start.at) / 1000).toFixed(2)} s; guest CPU ${kernels.map((k) => k.cpu.toFixed(2)).join(' ')}`);
    }
  } catch (e) {
    out.error = String(e).slice(0, 700);
    log(`${sys.name} round ${round}: ${out.error}`);
  } finally {
    await page.screenshot({ path: new URL(`../results/local/compare-${sys.name}-${round}.png`, import.meta.url).pathname }).catch(() => {});
    await browser.close();
  }
  return out;
}

mkdirSync(new URL('../results/local/', import.meta.url), { recursive: true });
const server: Server = await startServer(0, '127.0.0.1');
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const boots: Boot[] = [];
try {
  for (let round = 1; round <= Number(args.rounds); round++) for (const sys of SYSTEMS) boots.push(await boot(sys, round, base));
} finally {
  await new Promise((r) => server.close(r));
}
const summary = Object.fromEntries(SYSTEMS.map((sys) => {
  const mine = boots.filter((b) => b.system === sys.name && !b.error);
  const all = mine.flatMap((b) => b.runs.map((r) => r.ms / 1000));
  const later = mine.flatMap((b) => b.runs.slice(1).map((r) => r.ms / 1000));
  const sums = [...new Set(mine.flatMap((b) => b.runs.map((r) => r.kernels.map((k) => k.sum).join(' '))))];
  return [sys.name, { guest: mine[0]?.guest, first_s: mine.length ? summarize(mine.map((b) => b.runs[0]!.ms / 1000)) : undefined, later_s: later.length ? summarize(later) : undefined, all_s: all.length ? summarize(all) : undefined, rounds_s: mine.map((b) => b.runs.map((r) => +(r.ms / 1000).toFixed(2))), checksums: sums }];
}));
const result = {
  schema: 1,
  kind: 'compare',
  workload: 'bench/compare/work.pl',
  size: Number(args.size),
  date: new Date().toISOString(),
  commit: execSync('git rev-parse --short=12 HEAD', { encoding: 'utf8' }).trim(),
  host: { platform: os.platform(), arch: os.arch(), cpu: os.cpus()[0]?.model, cores: os.cpus().length, memGiB: Math.round(os.totalmem() / 2 ** 30) },
  systems: Object.fromEntries(SYSTEMS.map((s) => [s.name, s.what])),
  boots,
  summary,
};
const out = args.out ?? new URL(`../results/local/compare-${result.date.replace(/[:.]/g, '-').slice(0, 19)}.json`, import.meta.url).pathname;
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `${JSON.stringify(result, null, 1)}\n`);
log('wrote', out);
for (const [name, s] of Object.entries(summary)) log(name, s.guest, 'first', s.first_s?.median.toFixed(2), 'later', s.later_s?.median.toFixed(2), JSON.stringify(s.rounds_s), s.checksums.length === 1 ? '' : `CHECKSUMS DIFFER: ${JSON.stringify(s.checksums)}`);
