// The "complex app" benchmark: Chromium inside the page's Debian renders one of its built-in pages
// (no network). The disk is images/debian-chromium/build.sh's (`?disk=`, a fresh overlay: Playwright's
// profile is temporary). Root logs in on the serial terminal; each run is
//   chromium --headless --screenshot <page>
// timed by the guest's clock, with the guest's /proc/stat around it (CPU busy share) and the page's
// status (steps, steps in JIT code, compile time) sampled at its START and RUN markers.
//
// usage: timeout 900 node bench/apps/chromium.ts [--ncpus 4] [--json out.json] [page...]
//   --wasm <file>: serve that core instead of target/.../waarm64_core.wasm (A/B of a core change)
//   pages default to chrome://newtab three times. Headless Chromium 153 in the guest serves the new tab page for
//   every chrome:// URL (version, settings, credits: all "New Tab"); data: and file: URLs load as asked.
import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { chromium } from 'playwright-core';
import { startServer } from '../../tools/serve.ts';
import type { Status as PageStatus } from '../../web/app/protocol.ts';

const { values: opt, positionals } = parseArgs({
  allowPositionals: true,
  options: { wasm: { type: 'string' }, probe: { type: 'string' }, perf: { type: 'string' }, 'perf-out': { type: 'string', default: 'bench/results/local/apps/perf.data' }, ncpus: { type: 'string', default: '4' }, json: { type: 'string' }, disk: { type: 'string', default: '/target/images/debian-chromium/disk.qcow2' } },
});
const pages = positionals.length ? positionals : ['chrome://newtab', 'chrome://newtab', 'chrome://newtab'];
const server = await startServer();
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
// --perf N: `perf record` on the page's renderer during run N, with V8's perf map (the guest's blocks named
// `<va>_pa<pa>`; --no-sandbox so the renderer can write /tmp/perf-<pid>.map). Read it with bench/apps/perf.ts.
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium', args: opt.perf ? ['--js-flags=--perf-basic-prof', '--no-sandbox'] : [] });
// The page's renderer: the renderer with the most CPU time (the others are idle extension and spare ones).
const renderers = () => execFileSync('ps', ['-eo', 'pid=,cputimes=,args=', '--sort=-cputimes'], { encoding: 'utf8' }).split('\n').filter((l) => l.includes('--type=renderer')).map((l) => Number(l.trim().split(/\s+/)[0]));
let perf: ChildProcess | undefined;
const page = await browser.newPage();
// --wasm <file>: a variant core in place of the built one (A/B of core changes without a rebuild in between).
if (opt.wasm) await page.route('**/waarm64_core.wasm', (r) => r.fulfill({ path: opt.wasm, contentType: 'application/wasm' }));
page.on('console', (m) => { if (/panic|error/i.test(m.text())) console.log('# console:', m.text().slice(0, 400)); });
page.on('pageerror', (e) => console.log('# pageerror:', String(e).slice(0, 400)));
await page.goto(`${base}/web/app/?disk=${encodeURIComponent(opt.disk)}&ncpus=${opt.ncpus}&view=terminal`);
const t0 = Date.now();
const secs = () => ((Date.now() - t0) / 1000).toFixed(1);
const state = () => page.evaluate(() => [document.body.dataset.state, document.getElementById('message-text')?.textContent] as const);
const status = async () => {
  const s = await page.evaluate(() => document.getElementById('status')?.dataset.status);
  return s ? (JSON.parse(s) as PageStatus) : undefined;
};
const term = () => page.evaluate(() => document.querySelector('.xterm-rows')?.textContent ?? '');
const until = async (re: RegExp, ms: number) => {
  for (const end = Date.now() + ms; Date.now() < end;) {
    const t = await term();
    const m = re.exec(t);
    if (m) return m;
    const [s, msg] = await state();
    if (s === 'crashed' || s === 'failed') { console.log('# page', s, msg); return null; }
    await page.waitForTimeout(200);
  }
  return null;
};
const type = async (t: string) => { await page.locator('.xterm').click(); await page.keyboard.type(t, { delay: 2 }); };
const fail = async (why: string) => { console.log(`# ${why} at ${secs()} s`, await state(), (await term()).slice(-600)); await browser.close(); server.close(); process.exit(1); };

if (!(await until(/login: /, 300_000))) await fail('no login');
await type('root\n');
if (!(await until(/root@\S+:~# /, 60_000))) await fail('no shell');
const login = Number(secs());
console.log(`# logged in at ${login} s`);
// One run: START n, the render, the guest's cpu line before and after, RUN n with its exit code and ms.
await type(`r() { echo START $2; a=$(head -1 /proc/stat); fa=$(awk '/^pgmajfault/{print $2}' /proc/vmstat); s=$(date +%s%N); chromium --headless --no-sandbox --disable-gpu --no-first-run --user-data-dir=/tmp/prof --window-size=1024,768 --screenshot=/tmp/s$2.png "$1" >/tmp/log$2 2>&1; c=$?; e=$(date +%s%N); b=$(head -1 /proc/stat); fb=$(awk '/^pgmajfault/{print $2}' /proc/vmstat); echo "RUN $2 rc=$c ms=$(( (e-s)/1000000 )) png=$(stat -c %s /tmp/s$2.png 2>/dev/null) majflt=$((fb-fa)) A[$a] B[$b]"; md5sum /tmp/s$2.png; tail -n 3 /tmp/log$2 | cut -c1-150; free -m | head -2; echo END $2; }; clear\n`);

// --probe '<sh>': run one guest command after logging in, print the terminal at its end, and exit.
if (opt.probe) {
  await type(`clear; ${opt.probe}; echo PROBE-$((6*7))-DONE\n`);
  await until(/PROBE-42-DONE/, 600_000);
  console.log((await term()).replace(/\s{3,}/g, '\n'));
  await browser.close();
  server.close();
  process.exit(0);
}
type Run = { page: string; rc: number; guestMs: number; png: number; majflt: number; busy: number; user: number; sys: number; iowait: number; counters: Record<string, number>; steps: number; interp: number; mips: number; compileMs: number; jitMiB: number; blocks: number; hostMs: number };
const runs: Run[] = [];
const cpu = (l: string) => { const v = l.trim().split(/\s+/).slice(1).map(Number); return { user: v[0] + v[1], sys: v[2] + v[5] + v[6], idle: v[3], iowait: v[4], total: v.reduce((x, y) => x + y, 0) }; };
// Every numeric counter in the status's `stats`, flattened (`jit.flushes`, `par.dsbWaitNs`, `exceptions.0x15`, ...).
const flat = (o: object, pre = '', out: Record<string, number> = {}) => { for (const [k, v] of Object.entries(o)) typeof v === 'number' ? (out[pre + k] = v) : v && typeof v === 'object' && flat(v, `${pre}${k}.`, out); return out; };
for (const [i, p] of pages.entries()) {
  await type(`r ${p} ${i}\n`);
  if (!(await until(new RegExp(`START ${i}\\b`), 30_000))) await fail(`no START ${i}`);
  if (opt.perf === String(i)) {
    const [pid, ...more] = renderers();
    if (more.length) console.log('# more than one renderer:', [pid, ...more]);
    perf = spawn('perf', ['record', '-q', '-e', 'cpu-clock', '-F', '1000', '-p', String(pid), '-o', opt['perf-out']!], { stdio: 'inherit' });
    console.log(`# perf on renderer ${pid}`);
  }
  const a = await status();
  const h0 = Date.now();
  const m = await until(new RegExp(`RUN ${i} rc=(\\d+) ms=(\\d+) png=(\\d*) majflt=(-?\\d+) A\\[([^\\]]*)\\] B\\[([^\\]]*)\\]`), 600_000);
  if (!m) await fail(`no RUN ${i}`);
  const b = await status();
  if (perf) { perf.kill('SIGINT'); await new Promise((r) => perf!.on('close', r)); perf = undefined; }
  const [ca, cb] = [cpu(m![5]), cpu(m![6])];
  const tot = cb.total - ca.total;
  const busy = 1 - (cb.idle - ca.idle + cb.iowait - ca.iowait) / tot;
  const [fa, fb] = [flat(a!.stats), flat(b!.stats)];
  const counters: Record<string, number> = Object.fromEntries(Object.keys(fb).map((k) => [k, fb[k] - (fa[k] ?? 0)]).filter(([, v]) => v !== 0));
  const steps = b!.steps - a!.steps, interp = steps - (b!.jitSteps - a!.jitSteps);
  const r: Run = {
    page: p, rc: +m![1], guestMs: +m![2], png: +(m![3] || 0), majflt: +m![4], busy, user: (cb.user - ca.user) / tot, sys: (cb.sys - ca.sys) / tot, iowait: (cb.iowait - ca.iowait) / tot, counters, steps, interp: interp / steps,
    mips: steps / (b!.uptime - a!.uptime) / 1e3, compileMs: b!.jitCompileMs - a!.jitCompileMs,
    jitMiB: (b!.jitBytes - a!.jitBytes) / 1048576, blocks: b!.jitBlocks - a!.jitBlocks, hostMs: Date.now() - h0,
  };
  runs.push(r);
  const end = await until(new RegExp(`(RUN ${i} [^\\n]*?)?([0-9a-f]{32}[\\s\\S]*)END ${i}`), 30_000);
  if (end) console.log('#', end[2].replace(/\s+/g, ' ').slice(0, 600));
  console.log(`${i} ${p}: rc ${r.rc}, ${r.guestMs} ms (guest), png ${r.png} B, guest CPU busy ${(busy * 100).toFixed(0)}% of ${opt.ncpus} (user ${(r.user * 100).toFixed(0)}, sys ${(r.sys * 100).toFixed(0)}, iowait ${(r.iowait * 100).toFixed(0)}), major faults ${r.majflt}, ` +
    `${(steps / 1e9).toFixed(2)} G steps at ${r.mips.toFixed(0)} MIPS, interpreted ${(r.interp * 100).toFixed(2)}% (${(interp / 1e6).toFixed(0)} M), ` +
    `compiling ${r.compileMs.toFixed(0)} ms, ${r.jitMiB.toFixed(1)} MiB wasm, ${r.blocks} blocks, flushes ${counters['jit.flushes'] ?? 0}, invalidations ${counters['jit.invalidations'] ?? 0}, dispatches ${((counters['jit.dispatches'] ?? 0) / 1e6).toFixed(1)} M, TLB misses ${((counters.tlbMisses ?? 0) / 1e6).toFixed(1)} M, exceptions ${(Object.entries(counters).filter(([k]) => k.startsWith('exceptions.')).reduce((x, [, v]) => x + v, 0) / 1e6).toFixed(2)} M, DSB wait ${((counters['par.dsbWaitNs'] ?? 0) / 1e9).toFixed(1)} s, out of core ${((counters['par.outNs'] ?? 0) / 1e9).toFixed(1)} s`);
  await type('clear\n');
}
if (opt.json) writeFileSync(opt.json, JSON.stringify({ date: new Date().toISOString(), ncpus: +opt.ncpus, login, chromium: browser.version(), runs }, null, 1));
await browser.close();
server.close();
process.exit(0);
