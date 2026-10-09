// The page's Debian on virtio-gpu against the simple framebuffer (M8 graphics G1's exit numbers): the time from
// the page's load to the first lit pixel on the screen and to `running`, and key to glyph on the screen (bash on
// tty1, fbcon) and on the serial terminal (bash on ttyAMA0). Boots Debian on the page (needs `npm start`'s
// images) once per configuration and round, alternating.
//   node bench/gpu/page.ts [out.json] [rounds=2]
// Key to glyph is from the keydown event's timestamp to the first animation frame that sees the screen's canvas
// changed (a frame's resolution), or to the mutation of xterm.js's rows.
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { chromium, type Page } from 'playwright-core';
import { startServer } from '../../tools/serve.ts';
import { unattendedQuery } from '../../tests/debian-unattended.ts';

const server = await startServer();
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium' });
const KEYS = 40;

type W = { __lit?: number; __keys: number[]; __k: { t0: number; base: number } | null; __what: 'screen' | 'terminal' | null };

async function run(extra: string) {
  const page: Page = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage();
  // The first lit pixel: the screen's canvas sampled every 100 ms from the page's load.
  await page.addInitScript(() => {
    const w = window as never as W;
    w.__keys = []; w.__k = null; w.__what = null;
    const probe = document.createElement('canvas');
    [probe.width, probe.height] = [160, 100];
    const g = probe.getContext('2d', { willReadFrequently: true })!;
    const timer = setInterval(() => {
      const c = document.querySelector<HTMLCanvasElement>('#screen');
      if (!c || !c.width) return;
      g.drawImage(c, 0, 0, c.width, c.height, 0, 0, 160, 100);
      const d = g.getImageData(0, 0, 160, 100).data;
      for (let i = 0; i < d.length; i += 4) if (d[i] | d[i + 1] | d[i + 2]) { w.__lit = performance.now(); clearInterval(timer); return; }
    }, 100);
  });
  await page.goto(`${base}/web/app/?ncpus=4&view=both&gpu=2d&${extra}&${unattendedQuery()}`); // virtio-gpu 2D (G1's measurement)
  await page.waitForFunction(() => document.body.dataset.state === 'running', null, { timeout: 240_000, polling: 100 });
  const runningMs = await page.evaluate(() => performance.now());
  const shows = (re: RegExp) => page.waitForFunction((s) => new RegExp(s).test(document.querySelector('.xterm-rows')?.textContent ?? ''), re.source, { timeout: 60_000, polling: 100 });
  await page.locator('.xterm').click();
  await page.keyboard.type('root\n', { delay: 10 });
  await shows(/root@\S+:~# /);
  // tty1's own shell, so a key typed on the screen is echoed by bash as on the terminal.
  await page.keyboard.type("until grep -q 'login: ' /dev/vcs1; do sleep 0.2; done; echo tt\"\"y1-ready\n", { delay: 5 });
  await shows(/tty1-ready/);
  await page.locator('#screen').click();
  await page.keyboard.type('root\n', { delay: 30 });
  await page.waitForTimeout(4000);
  const firstLit = await page.evaluate(() => (window as never as W).__lit ?? null);
  await page.evaluate(() => {
    const w = window as never as W;
    const c = document.querySelector<HTMLCanvasElement>('#screen')!;
    const probe = document.createElement('canvas');
    [probe.width, probe.height] = [175, 100];
    const g = probe.getContext('2d', { willReadFrequently: true })!;
    const hash = () => { g.drawImage(c, 0, 0, c.width, c.height, 0, 0, 175, 100); const d = g.getImageData(0, 0, 175, 100).data; let h = 0; for (let i = 0; i < d.length; i += 4) h = (h * 31 + d[i] + d[i + 1] * 3 + d[i + 2] * 7) | 0; return h; };
    addEventListener('keydown', (e) => { w.__k = { t0: e.timeStamp, base: w.__what === 'screen' ? hash() : 0 }; }, true);
    // Animation frames only while a key on the screen is awaited: a frame loop on the page delays the terminal (frontend.md "The screen").
    const tick = () => {
      const k = w.__k;
      if (!k || w.__what !== 'screen') return;
      if (hash() !== k.base) { w.__keys.push(performance.now() - k.t0); w.__k = null; return; }
      requestAnimationFrame(tick);
    };
    addEventListener('keydown', () => { if (w.__what === 'screen') requestAnimationFrame(tick); }, true);
    new MutationObserver(() => {
      const k = w.__k;
      if (k && w.__what === 'terminal') { w.__keys.push(performance.now() - k.t0); w.__k = null; }
    }).observe(document.querySelector('.xterm-rows')!, { subtree: true, childList: true, characterData: true });
  });
  const keys = async (what: 'screen' | 'terminal') => {
    await page.locator(what === 'screen' ? '#screen' : '.xterm').click();
    await page.evaluate((x) => { const w = window as never as W; w.__keys = []; w.__k = null; w.__what = x; }, what);
    for (let k = 0; k < KEYS; k++) { await page.keyboard.press('abcdefghijklmnopqrst'[k % 20]); await page.waitForTimeout(250); }
    return page.evaluate(() => { const w = window as never as W; w.__what = null; return w.__keys; });
  };
  const screen = await keys('screen');
  const terminal = await keys('terminal');
  await page.close();
  return { firstLit, running: runningMs, screen, terminal };
}

const stat = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const q = (p: number) => s[Math.min(s.length - 1, Math.floor(s.length * p))];
  return { n: s.length, median: +q(0.5).toFixed(1), q1: +q(0.25).toFixed(1), q3: +q(0.75).toFixed(1) };
};
const rounds = Number(process.argv[3] ?? 2);
// WEBPC_PAGE_CONFIGS='name=query name=query': other configurations than the two (an experiment's).
const CONFIGS: string[][] = process.env.WEBPC_PAGE_CONFIGS ? process.env.WEBPC_PAGE_CONFIGS.split(' ').map((c) => [c.slice(0, c.indexOf('=')), c.slice(c.indexOf('=') + 1)]) : [['gpu', ''], ['simple', 'display=simple']];
const runs: { config: string; firstLit: number | null; running: number; screen: number[]; terminal: number[] }[] = [];
for (let r = 0; r < rounds; r++) {
  for (const [config, extra] of CONFIGS) {
    const x = await run(extra);
    runs.push({ config, ...x });
    console.log(config, JSON.stringify({ firstLit: x.firstLit && +(x.firstLit / 1000).toFixed(1), running: +(x.running / 1000).toFixed(1), screen: stat(x.screen), terminal: stat(x.terminal) }));
  }
}
const out = {
  date: new Date().toISOString(), chromium: browser.version(), host: `${execFileSync('uname', ['-srm']).toString().trim()}`,
  commit: execFileSync('git', ['rev-parse', '--short', 'HEAD']).toString().trim(),
  summary: Object.fromEntries(CONFIGS.map(([c]) => {
    const mine = runs.filter((x) => x.config === c);
    return [c, { firstLitS: mine.map((x) => x.firstLit && +(x.firstLit / 1000).toFixed(1)), runningS: mine.map((x) => +(x.running / 1000).toFixed(1)), screenMs: stat(mine.flatMap((x) => x.screen)), terminalMs: stat(mine.flatMap((x) => x.terminal)) }];
  })),
  runs,
};
console.log(JSON.stringify(out.summary));
if (process.argv[2]) writeFileSync(process.argv[2], JSON.stringify(out, null, 1) + '\n');
await browser.close();
server.close();
