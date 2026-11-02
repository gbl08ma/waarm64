// Image decoding in the guest's Chromium and Firefox (README.md). For each browser and format, the browser loops
// over loop.html?fmt=<f> (on the second disk, /dev/vdb), then the guest PC sampler runs for WINDOW s, with the
// vCPUs' helper histograms (helper-log.patch, applied locally) logged around it, and the images decoded in the
// window counted; the rate is images a second between the first and last rounds that end in the window (the page
// timestamps each round), since a count moves only by a round of 24. usage: timeout 3000 node bench/imgdecode/profile.ts [browser:fmt ...]
import { writeFileSync, mkdirSync } from 'node:fs';
import { chromium } from 'playwright-core';
import { startServer } from '../../tools/serve.ts';
import { answerAsks } from '../../tests/page-ask.ts';

const OUT = 'target/imgdecode/out';
mkdirSync(OUT, { recursive: true });
const WARM = Number(process.env.WARM ?? 45), WINDOW = Number(process.env.WINDOW ?? 30);
const cases = process.argv.slice(2).length ? process.argv.slice(2) : ['chromium:jpg', 'chromium:pjpg', 'chromium:png', 'chromium:webp', 'chromium:avif', 'firefox:jpg', 'firefox:pjpg', 'firefox:png', 'firefox:webp', 'firefox:avif'];
const server = await startServer();
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium' });
const page = await browser.newPage();
const helpers: { t: number; cpu: number; ops: Record<string, number> }[] = [];
page.on('console', (m) => {
  const t = m.text();
  const h = /^HELPERS cpu=(\d+) t=(\d+) (.*)$/.exec(t);
  if (h) { helpers.push({ cpu: +h[1], t: +h[2], ops: Object.fromEntries(h[3].split(',').filter(Boolean).map((x) => { const [o, n] = x.split(' '); return [o, +n]; })) }); return; }
  if (/panic|error/i.test(t)) console.log('# console:', t.slice(0, 300));
});
await answerAsks(page, (q) => { console.log('# ask:', q.text.slice(0, 200)); });
await page.goto(`${base}/web/app/?disk=/target/images/debian-browsers/disk.qcow2&disk2=/target/imgdecode/disk2.img&ncpus=4&ram=3072&view=terminal&displaystats${process.env.QUERY ?? ''}`);
const log = () => page.evaluate(() => (window as unknown as { __serialLog: () => string }).__serialLog());
const until = async (re: RegExp, ms: number, from = 0) => {
  for (const end = Date.now() + ms; Date.now() < end;) {
    const l = (await log()).slice(from);
    const m = re.exec(l);
    if (m) return m;
    await page.waitForTimeout(500);
  }
  await page.screenshot({ path: `${OUT}/timeout.png` });
  console.log(await page.evaluate(() => [document.body.dataset.state, document.getElementById('message-text')?.textContent]));
  throw new Error(`timeout waiting for ${re}: ${(await log()).slice(-500)}`);
};
const type = async (t: string) => { await page.locator('.xterm').click(); await page.keyboard.type(t, { delay: 2 }); };
const paste = async (t: string) => { await page.locator('.xterm').click(); await page.keyboard.insertText(t); await page.keyboard.press('Enter'); };
let mark = 0;
const run = async (cmd: string, ms = 120_000) => {
  const m = `M${++mark}`;
  await type(`echo ${m}-be""gin; ${cmd}; echo ${m}-e""nd\n`);
  const r = await until(new RegExp(`${m}-begin\\r?\\n([\\s\\S]*?)${m}-end`), ms);
  return r[1];
};
await page.waitForFunction(() => typeof (window as unknown as { __serialLog?: unknown }).__serialLog === 'function', null, { timeout: 60_000 });
const t0 = Date.now();
await until(/login: /, 240_000);
await type('root\n');
await until(/root@\S+:~# /, 60_000);
console.log(`# logged in at ${((Date.now() - t0) / 1000).toFixed(0)} s`);
console.log(await run('mkdir -p /mnt/i && mount -o ro /dev/vdb /mnt/i && ls /mnt/i | wc -l; nproc; free -m | head -2'));
await type('stty cols 200\n');
// No ASLR: the sampler's PCs carry no process, and every process's libraries then sit at the same addresses.
console.log(await run('echo 0 > /proc/sys/kernel/randomize_va_space; sysctl -qw kernel.kptr_restrict=0; awk \'$2 ~ /^[tT]$/ {print $1, $3}\' /proc/kallsyms | LC_ALL=C sort > /tmp/ks; wc -l < /tmp/ks'));
type Hooks = { __webpcProfile: (on: boolean) => void; __profile?: [string, number][] };
for (const c of cases) {
  const [b, fmt] = c.split(':');
  const url = `file:///mnt/i/loop.html?fmt=${fmt}`;
  const cmd = b === 'chromium'
    ? `chromium --headless --no-sandbox --disable-gpu --no-first-run --user-data-dir=/tmp/prof-c --remote-debugging-port=9222 --enable-logging=stderr --v=0 --window-size=1024,768 '${url}'`
    : `MOZ_HEADLESS=1 firefox-esr --headless --no-remote --profile /tmp/prof-f --window-size 1024,768 '${url}'`;
  await run(`rm -rf /tmp/prof-c /tmp/prof-f; mkdir -p /tmp/prof-f; echo 'user_pref("devtools.console.stdout.content", true);' > /tmp/prof-f/user.js; (${cmd} >/tmp/b.log 2>&1 &)`);
  // Warm: until the page has finished three rounds (DECODED lines on the browser's console), then WARM s more.
  let rounds = 0;
  for (const end = Date.now() + 300_000; Date.now() < end && rounds < 3;) {
    await page.waitForTimeout(10_000);
    rounds = Number((await run(`grep -c DECODED /tmp/b.log`)).trim()) || 0;
  }
  console.log(`# ${c}: ${rounds} rounds done, warming ${WARM} s more`);
  await page.waitForTimeout(WARM * 1000);
  const decodedBefore = await run(`grep -o 'DECODED [0-9]*' /tmp/b.log | tail -1`);
  const linesBefore = Number((await run(`grep -c DECODED /tmp/b.log`)).trim()) || 0;
  const cpuBefore = await run(`for p in $(ps -eo pid,args --no-headers | grep -Ei 'chrom|firefox' | grep -v grep | awk '{print $1}'); do echo $p $(awk '{print $14+$15}' /proc/$p/stat 2>/dev/null); done | tr '\\n' ';'`);
  const stepsBefore = await page.evaluate(() => (window as unknown as { __status?: { stats: { steps: number } } }).__status?.stats.steps ?? 0);
  const hBefore = helpers.length;
  await page.evaluate(() => { const w = window as unknown as Hooks; delete w.__profile; w.__webpcProfile(true); });
  await page.waitForTimeout(WINDOW * 1000);
  await page.evaluate(() => (window as unknown as Hooks).__webpcProfile(false));
  const steps = await page.evaluate(() => (window as unknown as { __status?: { stats: { steps: number } } }).__status?.stats.steps ?? 0) - stepsBefore;
  console.log(`# ${c}: guest steps in the window ${(steps / 1e9).toFixed(2)}G`);
  await page.waitForFunction(() => (window as unknown as Hooks).__profile, null, { timeout: 30_000 });
  const samples = await page.evaluate(() => (window as unknown as Hooks).__profile!);
  const cpuAfter = await run(`for p in $(ps -eo pid,args --no-headers | grep -Ei 'chrom|firefox' | grep -v grep | awk '{print $1}'); do echo $p $(awk '{print $14+$15}' /proc/$p/stat 2>/dev/null); done | tr '\\n' ';'`);
  const decodedAfter = await run(`grep -o 'DECODED [0-9]*' /tmp/b.log | tail -1; grep -v DECODED /tmp/b.log | tail -5 | cut -c1-150`);
  // Rounds that ended in the window, [images, page ms], and the rate between the first and the last.
  const ends = (await run(`grep -o 'DECODED [0-9]* [0-9]*' /tmp/b.log | tail -n +${linesBefore + 1}`)).trim().split(/\r?\n/)
    .map((l) => l.trim().split(' ').slice(1).map(Number)).filter((f) => f.length === 2);
  const rate = ends.length >= 2 ? (ends.at(-1)![0] - ends[0][0]) / ((ends.at(-1)![1] - ends[0][1]) / 1000) : NaN;
  await page.waitForTimeout(6000); // one more helper report per vCPU after the window
  // Helper calls during the window: per vCPU, the last report before it and the first after it.
  const delta: Record<string, number> = {};
  for (let cpu = 0; cpu < 4; cpu++) {
    const before = helpers.slice(0, hBefore).filter((h) => h.cpu === cpu).at(-1)?.ops ?? {};
    const after = helpers.slice(hBefore).filter((h) => h.cpu === cpu).at(-1)?.ops ?? {};
    for (const [o, n] of Object.entries(after)) { const d = n - (before[o] ?? 0); if (d > 0) delta[o] = (delta[o] ?? 0) + d; }
  }
  // User PCs into the guest, attributed to the processes' executable mappings there.
  let total = 0, kernel = 0;
  const user: [string, number][] = [];
  for (const [pc, n] of samples) { total += n; if (BigInt(`0x${pc}`) >= 0xffff000000000000n) kernel += n; else user.push([pc, n]); }
  const procs = await run(`ps -eo pid,args --no-headers | grep -Ei 'chrom|firefox' | grep -v grep | cut -c1-120`);
  // Executable mappings of every browser process (deduplicated), attributed on the host.
  // The process that ran most in the window; the PCs are attributed to its executable mappings.
  const ticks = (t: string): Record<string, number> => Object.fromEntries(t.trim().split(';').filter(Boolean).map((x) => x.trim().split(' ').map(Number)));
  const [tb, ta] = [ticks(cpuBefore), ticks(cpuAfter)];
  const busy = Object.entries(ta).map(([p, t]) => [Number(p), t - (tb[p] ?? 0)] as [number, number]).sort((a, b) => b[1] - a[1]);
  const pid = busy[0][0];
  const maps = await run(`awk '$2 ~ /x/ {print $1, $3, ($6==""?"[anon]":$6)}' /proc/${pid}/maps`, 300_000);
  const ranges = maps.split(/\r?\n/).map((l) => l.trim().split(' ')).filter((f) => f.length === 3 && f[0].includes('-')).map(([r, off, path]) => { const [a, b] = r.split('-'); return { a: BigInt(`0x${a}`), b: BigInt(`0x${b}`), off: BigInt(`0x${off}`), path }; });
  const lib: Record<string, number> = {}, hot: Record<string, number> = {};
  for (const [pc, n] of user) {
    const v = BigInt(`0x${pc}`);
    const r = ranges.find((r) => v >= r.a && v < r.b);
    const key = r ? r.path : '?';
    lib[key] = (lib[key] ?? 0) + n;
    if (r) { const k = `${r.path} ${(v - r.a + r.off).toString(16)}`; hot[k] = (hot[k] ?? 0) + n; }
  }
  const kpcs = samples.filter(([pc]) => BigInt(`0x${pc}`) >= 0xffff000000000000n).sort((a, b) => b[1] - a[1]).slice(0, 180);
  const ksyms = await run(`echo '${kpcs.map(([pc, n]) => `${pc.padStart(16, '0')} ${n}`).join(' ')}' | tr ' ' '\\n' | paste -d' ' - - | LC_ALL=C sort > /tmp/kp; LC_ALL=C sort -m /tmp/ks <(sed 's/ / =/' /tmp/kp) | awk '$2 !~ /^=/ {s=$2; next} {sub(/^=/, "", $2); c[s] += $2} END {for (k in c) print c[k], k}' | sort -rn | head -40 | tr '\\n' ';'`, 120_000);
  const attrib = [...Object.entries(lib).sort((a, b) => b[1] - a[1]).map(([k, n]) => `LIB ${n} ${k}`), ...Object.entries(hot).sort((a, b) => b[1] - a[1]).map(([k, n]) => `PC ${n} ${k}`)].join('\n');
  await run(`pkill -9 -x chromium; pkill -9 -f firefox-esr; sleep 2; pkill -9 -f firefox; sleep 1; ps -e | grep -ci -E 'chrom|firefox|content'`);
  const res = { case: c, total, kernel, user: total - kernel, helpers: Object.entries(delta).sort((a, b) => b[1] - a[1]), procs, busy, pid, steps, attrib, ksyms, samples, maps, decodedBefore, decodedAfter, ends, rate };
  writeFileSync(`${OUT}/${c.replace(':', '-')}.json`, JSON.stringify(res, null, 1));
  console.log(`# ${c}: decoded ${decodedBefore.trim()} -> ${decodedAfter.trim().split('\n')[0]}`);
  console.log(`# ${c}: rate ${rate.toFixed(2)} images/s over ${ends.length - 1} rounds`);
  console.log(`# ${c}: process CPU ticks in the window: ${busy.slice(0, 5).map(([p, t]) => `${p}:${t}`).join(' ')}`);
  console.log(`# ${c}: ${total} samples, kernel ${(100 * kernel / total).toFixed(1)}%; top helpers: ${res.helpers.slice(0, 12).map(([o, n]) => `${o} ${n}`).join(', ')}`);
  console.log(attrib.split('\n').filter((l) => l.startsWith('LIB')).slice(0, 10).join('\n'));
}
await browser.close();
server.close();
