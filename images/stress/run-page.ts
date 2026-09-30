// Runs the stress workload on the page's Debian in headless Chromium (docs/images.md "stress"):
// the page boots with `target/images/stress/initrd.img` in place of Debian's (a Playwright route,
// no page change), root logs in on the serial terminal, `/run/stress/<prog> <seconds>` runs, and
// the heartbeat lines are read off the terminal. Reports the longest gap between heartbeats
// (wall time; a stalled vCPU shows up as a gap), the last heartbeat, and dmesg's warnings.
//
// usage: timeout 400 node images/stress/run-page.ts [seconds=60] [gostress|cstress] [ncpus=4]
import { chromium } from 'playwright-core';
import { startServer } from '../../tools/serve.ts';

const secs = Number(process.argv[2] ?? 60);
const prog = process.argv[3] ?? 'gostress';
const ncpus = Number(process.argv[4] ?? 4);
const server = await startServer();
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium' });
const page = await browser.newPage();
await page.route('**/target/images/debian/initrd.img', (r) => r.fulfill({ path: new URL('../../target/images/stress/initrd.img', import.meta.url).pathname }));
page.on('console', (m) => { if (/panic|error|DSB/i.test(m.text())) console.log('# console:', m.text().slice(0, 600)); });
page.on('pageerror', (e) => console.log('# pageerror:', String(e).slice(0, 600)));
await page.goto(`${base}/web/app/?machine=debian&ncpus=${ncpus}&view=terminal`);
const state = () => page.evaluate(() => [document.body.dataset.state, document.getElementById('message-text')?.textContent] as const);
const term = () => page.evaluate(() => document.querySelector('.xterm-rows')?.textContent ?? '');
const t0 = Date.now();
page.on('response', (r) => { if (r.status() >= 400) console.log('# http', r.status(), r.url()); });
page.on('requestfailed', (r) => console.log('# reqfail', r.url()));
const until = async (re: RegExp, ms: number) => {
  for (const end = Date.now() + ms; Date.now() < end;) {
    const t = await term();
    if (re.test(t)) return t;
    const [s, m] = await state();
    if (s === 'crashed' || s === 'failed') { console.log('STATE', s, m); return null; }
    if (process.env.VERBOSE && Date.now() % 10000 < 300) console.log('# state', s, m, (await term()).slice(-80));
    await page.waitForTimeout(250);
  }
  return null;
};
const type = async (t: string) => { await page.locator('.xterm').click(); await page.keyboard.type(t, { delay: 5 }); };
if (!(await until(/login: /, 240_000))) { console.log('no login', await state(), (await term()).slice(-500)); process.exit(1); }
await type('root\n');
await until(/root@\S+:~# /, 60_000);
console.log(`# logged in at ${((Date.now() - t0) / 1000).toFixed(0)} s`);
await type(`ls -l /run/stress; nproc; clear; /run/stress/${prog} ${secs}\n`);
const seen = new Map<number, number>(); // heartbeat t -> wall ms
let done = false;
let stateMsg = '';
const re = new RegExp(`${prog}: t=(\\d+) `, 'g');
for (const end = Date.now() + (secs + 120) * 1000; Date.now() < end && !done;) {
  const t = await term();
  for (const m of t.matchAll(re)) if (!seen.has(+m[1])) seen.set(+m[1], Date.now());
  done = t.includes(`${prog}: done`);
  const [s, m] = await state();
  if (s !== 'running') { stateMsg = `${s}: ${m}`; break; }
  await page.waitForTimeout(200);
}
const ts = [...seen.entries()].sort((a, b) => a[0] - b[0]);
let worst = 0;
for (let i = 1; i < ts.length; i++) worst = Math.max(worst, ts[i][1] - ts[i - 1][1]);
console.log(`# ${prog} ${secs} s on ${ncpus} vCPUs: ${done ? 'done' : 'NOT done'}${stateMsg ? `, page ${stateMsg}` : ''}; ${ts.length} heartbeats seen, longest gap ${worst} ms, wall ${((Date.now() - t0) / 1000).toFixed(0)} s`);
console.log((await term()).slice(-700));
if (done) {
  await type('clear; dmesg | grep -E "lockup|stall|WARNING|BUG:|Oops|hung task|Call trace" | tail -5; echo "dmesg lines: $(dmesg | wc -l)"; echo DMESG-$((6*7))-END\n');
  await until(/DMESG-42-END/, 20_000);
  console.log('# dmesg:', (await term()).slice(-500));
}
await browser.close();
server.close();
process.exit(0);
