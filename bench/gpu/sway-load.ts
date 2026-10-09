// A compositor's load on the page (graphics.md §19; dev-only, not in tests): sway in a UEFI disk image with sway and
// foot (the user's Arch image, `images/archarm/build.sh` plus `pacman -S sway foot`; login alarm/alarm on the
// screen, root/root on the serial console), headless Chromium, 4 vCPUs, the screen fixed at 1376×762. Renderer modes:
// `virgl` (?gpu=virgl-null, or `?gpu=` + VIRGL_GPU for G3's renderer; WLR_RENDERER=gles2 on Mesa's virgl),
// `llvmpipe` (no virgl, gles2 on llvmpipe), `pixman`. Phases: sway idle, foot idle, foot scrolling a `date` loop.
// Each phase reads /proc/stat and sway's and foot's /proc/<pid>/stat over 10 s on the serial terminal (busy percent
// per CPU, ms of CPU a second per process) and the display's stats (`?displaystats`: flushes are frames, submits and
// stream bytes a second). Screenshots and results.json go to <outdir>.
//   node bench/gpu/sway-load.ts <mode> <image.qcow2> [outdir]
import { mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright-core';
import { startServer } from '../../tools/serve.ts';

const SETTINGS_KEY = 'webpc.settings';
const mode = process.argv[2] ?? 'virgl';
const image = process.argv[3];
if (!image) throw new Error('usage: node bench/gpu/sway-load.ts <virgl|pixman|llvmpipe> <image.qcow2> [outdir]');
const out = process.argv[4] ?? new URL(`../results/local/sway-load/${mode}/`, import.meta.url).pathname;
const VIRGL_GPU = process.env.VIRGL_GPU ?? 'virgl-null';
mkdirSync(out, { recursive: true });
const server = await startServer();
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium' });
const page = await (await browser.newContext({ viewport: { width: 1400, height: 1300 } })).newPage();
await page.addInitScript(() => { (window as unknown as { showSaveFilePicker: unknown }).showSaveFilePicker = undefined; });
// The screen is a fixed 1376×762 (§16's size) whatever the layout: the page's setting, as its Size menu stores it.
await page.addInitScript((key) => localStorage.setItem(key, JSON.stringify({ screen: '1376x762' })), SETTINGS_KEY);
page.on('dialog', (d) => void d.accept());
page.on('pageerror', (e) => console.log('pageerror', String(e)));
const t0 = performance.now();
const at = () => ((performance.now() - t0) / 1000).toFixed(1);
const log = (...a: unknown[]) => console.log(`[${at()}]`, ...a);
const results: Record<string, unknown> = { mode };

await page.goto(`${base}/web/app/?ncpus=4&view=both&displaystats${mode === 'virgl' ? `&gpu=${VIRGL_GPU}` : ''}`);
await page.setInputFiles('#open-disk-input', image);
await page.waitForFunction(() => document.body.dataset.state === 'running', null, { timeout: 300_000, polling: 250 });
log('running');

const terminal = () => page.evaluate(() => document.querySelector('.xterm-rows')?.textContent ?? '');
const shows = (re: RegExp, ms = 60_000) => page.waitForFunction((src) => new RegExp(src).test(document.querySelector('.xterm-rows')?.textContent ?? ''), re.source, { timeout: ms, polling: 200 })
  .catch(async (e) => { await page.screenshot({ path: `${out}/fail.png` }); throw new Error(`${e}; the terminal shows: ${await terminal()}`); });
const onSerial = async (text: string) => { await page.locator('.xterm').click(); await page.keyboard.type(text, { delay: 5 }); };
const SHIFTED: Record<string, string> = { '|': 'Backslash', '>': 'Period', '<': 'Comma', _: 'Minus', '"': 'Quote', '&': 'Digit7', '*': 'Digit8', '(': 'Digit9', ')': 'Digit0', $: 'Digit4', ':': 'Semicolon', '?': 'Slash', '~': 'Backquote', '+': 'Equal', '{': 'BracketLeft', '}': 'BracketRight', '!': 'Digit1', '%': 'Digit5', '^': 'Digit6', '#': 'Digit3', '@': 'Digit2' };
const PLAIN: Record<string, string> = { ' ': 'Space', '\n': 'Enter', '-': 'Minus', '=': 'Equal', '/': 'Slash', '.': 'Period', ',': 'Comma', ';': 'Semicolon', "'": 'Quote', '\\': 'Backslash', '[': 'BracketLeft', ']': 'BracketRight', '`': 'Backquote' };
const onScreen = async (text: string, gap = 40) => {
  await page.locator('#screen').click();
  for (const c of text) {
    await page.keyboard.press(SHIFTED[c] ? `Shift+${SHIFTED[c]}` : PLAIN[c] ?? (/[A-Z]/.test(c) ? `Shift+Key${c}` : /[a-z]/.test(c) ? `Key${c.toUpperCase()}` : /[0-9]/.test(c) ? `Digit${c}` : c));
    await page.waitForTimeout(gap);
  }
};
type Stat = { n: number; lag: number; busy: Record<string, number> };
/** The display's stats since the last call, per second (flushes are the compositor's frames). */
const display = async () => {
  const s = await page.evaluate(() => ((window as unknown as { __drawStats?: unknown[] }).__drawStats ?? []).splice(0)) as Stat[];
  const per = (k: string) => s.reduce((n, x) => n + (x.busy[k] ?? 0), 0) / Math.max(1, s.length);
  return { seconds: s.length, flushes: per('flushes'), submits: per('submits'), submitKB: per('submitBytes') / 1024, transfers: per('transfers'), Mpx: per('pixels') / 1e6, requestMs: per('request'), draws: s.reduce((n, x) => n + x.n, 0) / Math.max(1, s.length) };
};
let mark = 0;
/** /proc/stat over `secs` on the serial side: each CPU's busy, user and system percent. */
const load = async (label: string, secs = 10) => {
  await display();
  const m = `L${++mark}`;
  await onSerial(`clear; sh /root/load.sh ${secs} ${m}\n`);
  await shows(new RegExp(`${m}-done`), (secs + 60) * 1000);
  const d = await display();
  const t = await terminal();
  const cpus = [...t.matchAll(new RegExp(`${m} (cpu\\d?) busy (\\d+) user (\\d+) sys (\\d+)`, 'g'))].map((x) => ({ cpu: x[1], busy: +x[2], user: +x[3], sys: +x[4] }));
  // Per process: ms of CPU a second (clock ticks are 10 ms), user and system.
  const procs = [...t.matchAll(new RegExp(`${m} proc \\((\\w+)\\) user (\\d+) sys (\\d+)`, 'g'))].map((x) => ({ proc: x[1], userMs: +x[2], sysMs: +x[3] }));
  results[label] = { cpus, procs, display: d };
  log(label, JSON.stringify(cpus.filter((c) => c.cpu === 'cpu')), JSON.stringify(procs), JSON.stringify(d));
  await page.locator('#screen').screenshot({ path: `${out}/${label}.png` });
};

// Root on the serial terminal; the load script.
await shows(/login:\s*$/, 120_000);
await onSerial('root\n');
await shows(/Password:\s*$|\]#\s*$/);
if (/Password:\s*$/.test(await terminal())) await onSerial('root\n');
await shows(/\]#\s*$/);
await onSerial(`cat > /root/load.sh <<'EOF'
ps() { for p in $(pidof sway) $(pidof foot); do echo "$p $(cut -d' ' -f2,14,15 /proc/$p/stat)"; done; }
ps > /tmp/pa; cat /proc/stat > /tmp/a; sleep $1; cat /proc/stat > /tmp/b; ps > /tmp/pb
awk -v m=$2 -v s=$1 'NR==FNR{u[$1]=$3;k[$1]=$4;next} ($1 in u){printf "%s proc %s user %d sys %d\\n",m,$2,($3-u[$1])*10/s,($4-k[$1])*10/s}' /tmp/pa /tmp/pb
awk -v m=$2 'NR==FNR&&/^cpu/{for(i=2;i<=9;i++)a[$1,i]=$i;next} /^cpu/{t=0;for(i=2;i<=9;i++){d[i]=$i-a[$1,i];t+=d[i]}; printf "%s %s busy %d user %d sys %d\\n",m,$1,100*(t-d[5]-d[6])/t,100*(d[2]+d[3])/t,100*(d[4]+d[7]+d[8])/t}' /tmp/a /tmp/b
echo $2-done
EOF
`);
await onSerial('clear; uname -r; pacman -Q sway wlroots0.19 mesa foot 2>&1 | tr "\\n" " "; echo; ls /dev/dri\n');
await page.waitForTimeout(3000);
results.info = await terminal();
log('info', results.info);

// The user's session on the screen.
await onScreen('alarm\n');
await page.waitForTimeout(3000);
await onScreen('alarm\n');
await page.waitForTimeout(6000);
await load('console', 5);
const env = mode === 'pixman' ? 'WLR_RENDERER=pixman' : mode === 'llvmpipe' ? 'WLR_RENDERER=gles2' : 'WLR_RENDERER=gles2';
await onScreen(`${env} sway 2>/tmp/sway.log\n`);
await page.waitForTimeout(45_000);
await onSerial('clear; P=$(pidof sway); echo sway=$P; grep -o -E "libgallium[^ ]*|libpixman[^ ]*" /proc/$P/maps | sort -u; ls -l /proc/$P/fd | grep -o "/dev/dri/[a-zA-Z0-9]*" | sort | uniq -c; grep -i -E "renderer|egl|gles|driver" /tmp/sway.log | head -8\n');
await page.waitForTimeout(4000);
results.sway = await terminal();
log('sway', results.sway);
await load('sway-idle');
// foot (Alt+Enter), then a terminal that scrolls as fast as it can.
await page.locator('#screen').click();
await page.keyboard.down('Alt');
await page.waitForTimeout(150);
await page.keyboard.press('Enter', { delay: 80 });
await page.waitForTimeout(150);
await page.keyboard.up('Alt');
await page.waitForTimeout(20_000);
await load('foot-idle');
await onScreen('while true; do date; done\n');
await page.waitForTimeout(3000);
await load('date-loop');
await page.keyboard.press('Control+KeyC');
await page.waitForTimeout(2000);
await onSerial('clear; grep -c . /tmp/sway.log; tail -5 /tmp/sway.log\n');
await page.waitForTimeout(2000);
results.tail = await terminal();
writeFileSync(`${out}/results.json`, JSON.stringify(results, null, 1));
log('done');
await browser.close();
server.close();
