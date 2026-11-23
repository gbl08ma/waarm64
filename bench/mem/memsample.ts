// Memory attribution of the real page (web/app, Debian, 4 vCPUs, JIT) under a code-churning guest load (dev-only, /proc).
// usage: timeout 580 node bench/mem/memsample.ts [seconds] [out.json] [extra query, e.g. "&jitmb=160"]
//   GO=1        the load is `go build` of /work/web in a loop from a second disk (images/stress/build-goroot.sh)
//   EVERY=<ms>  the sampling period (20000)
//   V8TRACE=1   V8's wasm code GC as it reports it: the renderer runs with --trace-wasm-code-gc, its stdout goes to
//               <out>.v8.log (Chromium through a wrapper that redirects it), and each sample records the log's length
//               (bench/mem/summarize.mjs reads the two). (--trace-wasm-native-heap, V8's code-space commits, prints nothing
//               in a release build.)
// Each sample: the renderer's smaps by mapping class (Rss, Size and AnonHugePages: probe.ts), the kernel's THP
// counters (/proc/vmstat), every target's Runtime.getHeapUsage (JS heap, external and backing stores) and the page's
// status (`__status`: the JIT's counters, the page's own memory estimate). `measureUserAgentSpecificMemory` is left
// out: it charges the shared wasm memories once per realm and counts only JS heaps (docs/jit.md "The page's memory signal").
import { chromium } from 'playwright-core';
import { chmodSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { startServer } from '../../tools/serve.ts';
import { unattendedQuery } from '../../tests/debian-unattended.ts';
import { answerAsks } from '../../tests/page-ask.ts';
import { smapsDetail, thpCounters } from './probe.ts';

const secs = Number(process.argv[2] ?? 300);
const out = process.argv[3] ?? 'bench/results/local/memsample.json';
const extra = process.argv[4] ?? '';
const v8log = process.env.V8TRACE ? `${out}.v8.log` : undefined;
let exe = process.env.CHROMIUM ?? '/usr/bin/chromium';
if (v8log) {
  const wrap = `${out}.chromium.sh`;
  writeFileSync(wrap, `#!/bin/sh\nexec ${exe} "$@" >${JSON.stringify(v8log)}\n`);
  chmodSync(wrap, 0o755);
  exe = wrap;
}
const server = await startServer();
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const PORT = 9300 + Math.floor(Math.random() * 500);
const args = [`--remote-debugging-port=${PORT}`];
if (v8log) args.push('--js-flags=--trace-wasm-code-gc');
const browser = await chromium.launch({ executablePath: exe, args });
console.log('# chromium', browser.version());
const page = await browser.newPage();
await answerAsks(page);
page.on('console', (m) => { if (/panic|error|unreachable|vCPU retired/i.test(m.text())) console.log('# console:', m.text().slice(0, 600)); });
page.on('pageerror', (e) => console.log('# pageerror:', String(e).slice(0, 300)));
page.on('crash', () => console.log('# the renderer crashed'));

// Raw CDP over the browser's websocket (flattened sessions, recursive auto-attach to workers).
const ver = (await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json()) as { webSocketDebuggerUrl: string };
const ws = new WebSocket(ver.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let id = 0;
const pend = new Map<number, (m: { result?: unknown }) => void>();
type Tgt = { sid: string; type: string; url: string };
const targets = new Map<string, Tgt>();
const send = (method: string, params: object = {}, sessionId?: string, ms = 4000) =>
  new Promise<any>((res) => {
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
    void send('Runtime.runIfWaitingForDebugger', {}, sid);
  } else if (m.method === 'Target.detachedFromTarget') targets.delete(m.params.sessionId);
});
await send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });

const rendererPids = async () => {
  const r = await send('SystemInfo.getProcessInfo');
  return ((r?.processInfo ?? []) as { id: number; type: string }[]).filter((p) => p.type === 'renderer').map((p) => p.id);
};

const q = `${unattendedQuery()}&ncpus=4&view=terminal&hooks${process.env.GO ? `&disk2=${encodeURIComponent('/target/images/stress/goroot.ext4')}` : ''}${extra}`;
await page.goto(`${base}/web/app/?${q}`);
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

const samples: unknown[] = [];
const save = () => writeFileSync(out, JSON.stringify({ chromium: browser.version(), query: q, every: Number(process.env.EVERY ?? 20000), v8log, samples }));
const sample = async (label: string) => {
  // Stop before the VM runs out of memory (the run's scope cap kills the whole run).
  if (Number(/MemAvailable:\s+(\d+)/.exec(readFileSync('/proc/meminfo', 'utf8'))![1]) < 2.5e6) { console.log('# MemAvailable < 2.5 GB: stopping'); save(); await browser.close(); process.exit(3); }
  const t = (Date.now() - t0) / 1000;
  const v8at = v8log ? statSync(v8log).size : undefined;
  const procs = (await rendererPids()).flatMap((pid) => { const d = smapsDetail(pid); return d ? [{ pid, ...d }] : []; });
  const thp = thpCounters();
  const heaps: unknown[] = [];
  for (const g of targets.values()) {
    if (g.type === 'browser') continue;
    const r = await send('Runtime.getHeapUsage', {}, g.sid, 1500);
    if (r) heaps.push({ type: g.type, url: g.url.replace(/^.*\//, '').replace(/\?.*/, '').slice(0, 40), ...r });
  }
  const status = await page.evaluate(() => { const s = window.__status as unknown as Record<string, unknown> | undefined; if (!s) return undefined; const { vcpus: _, ...rest } = s; return rest; }).catch(() => undefined);
  const s = { label, t, v8at, procs, thp, heaps, status };
  samples.push(s);
  const big = procs.reduce((a, b) => (b.total.rss > a.total.rss ? b : a), procs[0]);
  const mb = (b: number) => (b / 2 ** 20).toFixed(0);
  if (big) console.log(`# ${label} t=${t.toFixed(0)}s renderer RSS ${mb(big.total.rss)} MB (VmRSS ${mb(big.before?.VmRSS ?? 0)}/${mb(big.after?.VmRSS ?? 0)}, read ${big.readMs} ms), code rss ${mb(big.cls.code.rss)} thp ${mb(big.cls.code.thp)} size ${mb(big.cls.code.size)} (${big.cls.code.n} maps), anon ${mb(big.cls.anon.rss)} thp ${mb(big.cls.anon.thp)}; flushes ${(status as { jitFlushes?: number } | undefined)?.jitFlushes}`);
};

let boot = false;
const bootTimer = setInterval(() => { if (!boot) void sample('boot').catch(() => {}); }, 30000);
if (!(await until(/login: /, 240_000))) { console.log('no login', await state(), await page.evaluate(() => document.body.innerText.slice(0, 600))); process.exit(1); }
boot = true;
clearInterval(bootTimer);
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
  save();
}
save();
console.log('# end', await state());
await browser.close();
server.close();
process.exit(0);
