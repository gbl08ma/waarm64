// Memory attribution of the real page (web/app, Debian, 4 vCPUs, JIT) under a code-churning guest load.
// usage: timeout 580 node bench/mem/memsample.ts [seconds] [out.json] [extra query, e.g. "&ip=..."]
// Samples every 10 s: renderer RSS by mapping class (/proc/<pid>/smaps), each target's Performance.getMetrics (JS heap),
// the workers' JITSTAT console lines (web/vm.ts temp instrumentation), the page's status, and
// performance.measureUserAgentSpecificMemory().
import { chromium } from 'playwright-core';
import { readFileSync, writeFileSync } from 'node:fs';
import { startServer } from '../../tools/serve.ts';
import { unattendedQuery } from '../../tests/debian-unattended.ts';

const secs = Number(process.argv[2] ?? 300);
const out = process.argv[3] ?? 'bench/mem/memsample.json';
const extra = process.argv[4] ?? '';
const server = await startServer();
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const PORT = 9300 + Math.floor(Math.random() * 500);
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium', args: [`--remote-debugging-port=${PORT}`] });
console.log('# chromium', browser.version());
const page = await browser.newPage();
page.on('console', (m) => { if (!/JITSTAT/.test(m.text())) console.log('# console:', m.text().slice(0, 300)); });
page.on('pageerror', (e) => console.log('# pageerror:', String(e).slice(0, 300)));

// --- raw CDP over the browser websocket (flattened sessions, recursive auto-attach to workers)
const ver = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json() as { webSocketDebuggerUrl: string };
const ws = new WebSocket(ver.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let id = 0;
const pend = new Map<number, (m: any) => void>();
type Tgt = { sid: string; type: string; url: string; metrics?: Record<string, number>; jit?: any; jit2?: any };
const targets = new Map<string, Tgt>();
const send = (method: string, params: object = {}, sessionId?: string, ms = 4000) => new Promise<any>((res) => {
  const i = ++id;
  const t = setTimeout(() => { pend.delete(i); res(undefined); }, ms);
  pend.set(i, (m) => { clearTimeout(t); res(m.result); });
  ws.send(JSON.stringify({ id: i, method, params, sessionId }));
});
ws.addEventListener('message', (e) => {
  const m = JSON.parse(String(e.data));
  if (m.id && pend.has(m.id)) { pend.get(m.id)!(m); pend.delete(m.id); return; }
  if (m.method === 'Target.attachedToTarget') {
    const sid = m.params.sessionId as string;
    const ti = m.params.targetInfo;
    targets.set(sid, { sid, type: ti.type, url: ti.url });
    void send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, sid);
    if (ti.type !== 'browser') { void send('Runtime.enable', {}, sid); void send('Performance.enable', {}, sid); }
    void send('Runtime.runIfWaitingForDebugger', {}, sid);
  } else if (m.method === 'Runtime.consoleAPICalled' && m.sessionId) {
    const t = targets.get(m.sessionId);
    const txt = m.params.args?.[0]?.value as string | undefined;
    if (t && txt?.startsWith('JITSTAT ')) t.jit = JSON.parse(txt.slice(8));
    if (t && txt?.startsWith('JITSTAT2 ')) t.jit2 = JSON.parse(txt.slice(9));
  }
});
await send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });

const rendererPids = async () => {
  const r = await send('SystemInfo.getProcessInfo');
  return (r?.processInfo ?? []).map((p: any) => ({ id: p.id, type: p.type, cpu: p.cpuTime })).filter((p: any) => p.type === 'renderer');
};
const tops: string[] = [];
let byName: Record<string, number> = {};
const smaps = (pid: number) => {
  const cls: Record<string, number> = {};
  const all: [number, string][] = [];
  byName = {};
  let cur: { perm: string; kb: number; name: string; rss: number; size: number } | undefined;
  const add = () => {
    if (!cur) return;
    const nm = cur.name.replace(/^\/usr\/lib64\/chromium\//, '').replace(/\(deleted\)/, '').trim() || '(unnamed)';
    const key = `${cur.perm} ${nm}`;
    byName[key] = (byName[key] ?? 0) + cur.rss;
    const k = cur.size > 3e6 && /s/.test(cur.perm) ? 'shared-big(guest mem)' : /x/.test(cur.perm) ? 'exec-' + (cur.name.includes('chrome') ? 'chrome' : 'anon(wasm code)') : /^rw-s/.test(cur.perm) ? 'shared-other' : cur.name.includes('chrome') || cur.name.includes('.so') ? 'lib-data' : 'anon-rw(heap etc)';
    cls[k] = (cls[k] ?? 0) + cur.rss;
    all.push([cur.rss, `${cur.perm} size ${(cur.size / 1048576).toFixed(0)}M rss ${(cur.rss / 1024).toFixed(0)}M ${cur.name}`]);
  };
  let txt: string;
  try { txt = readFileSync(`/proc/${pid}/smaps`, 'utf8'); } catch { return cls; }
  for (const line of txt.split('\n')) {
    const h = /^([0-9a-f]+)-([0-9a-f]+) (\S{4}) \S+ \S+ \S+\s*(.*)$/.exec(line);
    if (h) { add(); cur = { perm: h[3], kb: 0, name: h[4], rss: 0, size: parseInt(h[2], 16) - parseInt(h[1], 16) }; }
    else if (cur && line.startsWith('Rss:')) cur.rss = Number(line.split(/\s+/)[1]);
  }
  add();
  all.sort((a, b) => b[0] - a[0]);
  tops.length = 0; tops.push(...all.slice(0, 12).map((x) => x[1]));
  if (process.env.TOPS && (cls['exec-anon(wasm code)'] ?? 0) > 3e6) console.log('# TOP', pid, JSON.stringify(tops), 'free:', readFileSync('/proc/meminfo', 'utf8').split('\n').slice(0, 3).join(' | '));
  cls['names'] = byName as any;
  return cls;
};

// GO=1: the Go compiler on a second disk as the load (images/stress/build-goroot.sh, docs/images.md).
// The tests' credentials: no first-boot questions, root without a password (tests/debian-unattended.ts).
await page.goto(`${base}/web/app/?machine=debian&ncpus=4&view=terminal&${unattendedQuery()}${process.env.GO ? `&disk2=${encodeURIComponent('/target/images/stress/goroot.ext4')}` : ''}${extra}`);
const state = () => page.evaluate(() => [document.body.dataset.state, document.getElementById('message-text')?.textContent] as const);
const term = () => page.evaluate(() => document.querySelector('.xterm-rows')?.textContent ?? '');
const t0 = Date.now();
const until = async (re: RegExp, ms: number) => {
  for (const end = Date.now() + ms; Date.now() < end;) {
    if (re.test(await term())) return true;
    const [s, m] = await state();
    if (s === 'crashed' || s === 'failed') { console.log('STATE', s, m); return false; }
    await page.waitForTimeout(500);
  }
  return false;
};
const type = async (t: string) => { await page.locator('.xterm').click(); await page.keyboard.type(t, { delay: 3 }); };

const samples: any[] = [];
const sample = async (label: string) => {
  // MemoryMax on a user scope isn't enforced here: stop before the VM runs out of memory.
  if (Number(/MemAvailable:\s+(\d+)/.exec(readFileSync('/proc/meminfo', 'utf8'))![1]) < 2.5e6) { console.log('# MemAvailable < 2.5 GB: stopping'); writeFileSync(out, JSON.stringify({ chromium: browser.version(), samples }, null, 1)); await browser.close(); process.exit(3); }
  const rp = await rendererPids();
  const procs = rp.map((p: any) => ({ pid: p.id, cls: smaps(p.id) }));
  const tg: any[] = [];
  for (const t of targets.values()) {
    if (t.type === 'browser') continue;
    const r = await send('Runtime.getHeapUsage', {}, t.sid, 1500);
    const m = { JSHeapUsedSize: r?.usedSize, JSHeapTotalSize: r?.totalSize };
    tg.push({ type: t.type, url: t.url.replace(/^.*\//, '').slice(0, 30), heapUsedMB: m.JSHeapUsedSize / 1048576, heapTotalMB: m.JSHeapTotalSize / 1048576, jit: t.jit, jit2: t.jit2 });
  }
  let uam: any;
  if (0) try { uam = await page.evaluate(async () => { const r = await (performance as any).measureUserAgentSpecificMemory(); return { total: r.bytes / 1048576, breakdown: r.breakdown.map((b: any) => [b.types.join(','), b.bytes / 1048576]) }; }); } catch (e) { uam = String(e).slice(0, 100); }
  const s = { label, t: (Date.now() - t0) / 1000, procs, targets: tg, uam };
  samples.push(s);
  const tot = procs.reduce((a: number, p: any) => a + Object.values(p.cls as Record<string, number>).filter((x) => typeof x === 'number').reduce((x, y) => x + y, 0), 0) / 1024;
  console.log(`# ${label} t=${s.t.toFixed(0)}s renderer RSS ${tot.toFixed(0)} MB:`, procs.map((p: any) => Object.entries(p.cls as Record<string, number>).filter(([k]) => k !== 'names').map(([k, v]) => `${k}=${(v / 1024).toFixed(0)}`).join(' ')).join(' | '));
  
  for (const t of tg) if (t.type === 'worker' || t.jit) console.log(`#    ${t.type} ${t.url} heap ${t.heapUsedMB?.toFixed(0)}/${t.heapTotalMB?.toFixed(0)} MB jit ${t.jit ? `mods ${t.jit.modules} fns ${t.jit.fns} bytes ${(t.jit.bytes / 1e6).toFixed(1)}M table ${t.jit.table} pages ${t.jit.pages} jsheap ${t.jit.heapUsed?.toFixed(0)}/${t.jit.heapTotal?.toFixed(0)}` : '-'}` + (t.jit2 ? ` stats ${JSON.stringify(t.jit2)}` : ''));
  if (typeof uam === 'object') console.log(`#    uam total ${uam.total?.toFixed(0)} MB`, JSON.stringify(uam.breakdown));
};

let boot = false;
const bootTimer = setInterval(() => { if (!boot) void sample('boot').catch(() => {}); }, 30000);
if (!(await until(/login: /, 240_000))) { console.log('no login', await state(), await page.evaluate(() => document.body.innerText.slice(0, 600))); process.exit(1); }
boot = true; clearInterval(bootTimer);
await sample('login');
await type('root\n');
await until(/root@\S+:~# /, 60_000);
const goLoop = 'mount -o ro /dev/vdb /mnt; (while :; do rm -rf /tmp/gc /tmp/work; cp -r /mnt/work /tmp/work; cd /tmp/work/web && GOROOT=/mnt/go GOCACHE=/tmp/gc GOFLAGS=-mod=mod /mnt/go/bin/go build -o /tmp/web . ; echo GOBUILD rc=$?; cd /; done) &';
const load = process.env.GO ? [goLoop, 'echo LOAD-STARTED'] : [
  // many distinct binaries, repeatedly
  '(while :; do for b in /usr/bin/* /usr/sbin/*; do timeout 3 $b --version </dev/null >/dev/null 2>&1; done; done) &',
  '(while :; do find /usr -type f 2>/dev/null | xargs md5sum >/dev/null 2>&1; done) &',
  '(while :; do seq 1 200000 | sort -R | tail -1 >/dev/null; dd if=/dev/urandom bs=64k count=32 2>/dev/null | sha256sum >/dev/null; done) &',
  'echo LOAD-STARTED',
];
for (const l of load) await type(l + '\n');
await sample('load-start');
for (const end = Date.now() + secs * 1000; Date.now() < end;) {
  const [s, m] = await state();
  if (s !== 'running') { console.log(`STATE ${s}: ${m}`); break; }
  await page.waitForTimeout(Number(process.env.EVERY ?? 20000));
  await sample('load').catch((e) => console.log('# sample failed', String(e).slice(0, 100)));
  writeFileSync(out, JSON.stringify({ chromium: browser.version(), samples }, null, 1));
}
if (process.env.CRASH) {
  await type('echo 1 > /proc/sys/kernel/sysrq; echo c > /proc/sysrq-trigger\n');
  for (let i = 0; i < 3; i++) { await page.waitForTimeout(10000); await sample('crashed'); console.log('# state', await state()); }
  await page.reload();
  for (let i = 0; i < 6; i++) { await page.waitForTimeout(10000); await sample('reloaded'); console.log('# state', await state()); }
  await until(/login: /, 200_000);
  await sample('relogin');
  await page.waitForTimeout(30000);
  await sample('relogin+30');
}
writeFileSync(out, JSON.stringify({ chromium: browser.version(), samples }, null, 1));
console.log('# end', await state());
await browser.close();
server.close();
process.exit(0);
