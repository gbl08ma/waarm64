// The core's heap under a heavy 4-vCPU load (docs/spill-memories.md "The heap floor"; dev-only, not in tests): the
// page's Debian on 4 vCPUs with the Go compiler on a second disk (images/stress: its initrd and goroot.ext4, as
// bench/mem/memsample.ts GO=1), `go build` in a loop on every vCPU, plus a find/sha256sum churn; every 20 s the page's
// `__webpcHeap()` (web/vm.ts `heapUse`: the heap's touched pages and high-water mark) and the guest's builds so far.
//   node bench/boot/results/m8-spill/tools/heap-go.ts [seconds] [outdir]
// RAM (MiB, default 2560), NCPUS (default 4).
import { mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright-core';
import { startServer } from '../../../../../tools/serve.ts';
import { unattendedQuery } from '../../../../../tests/debian-unattended.ts';
import { answerAsks } from '../../../../../tests/page-ask.ts';

const secs = Number(process.argv[2] ?? 420);
const out = process.argv[3] ?? new URL('../../../../results/local/spill/heap-go/', import.meta.url).pathname;
mkdirSync(out, { recursive: true });
const RAM = Number(process.env.RAM ?? 2560), NCPUS = Number(process.env.NCPUS ?? 4);
const t0 = performance.now();
const log = (...a: unknown[]) => console.log(`[${((performance.now() - t0) / 1000).toFixed(0)} s]`, ...a);
const server = await startServer();
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium' });
const results: Record<string, unknown> = { ram: RAM, ncpus: NCPUS, seconds: secs, chromium: browser.version(), date: new Date().toISOString() };
const samples: Record<string, unknown>[] = [];
const save = () => writeFileSync(`${out}/results.json`, JSON.stringify({ ...results, samples }, null, 1));
type Heap = { belowBytes: number; reserveBytes: number; touchedBytes: number; highBytes: number; buckets: number[] };
try {
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
  page.on('pageerror', (e) => log('pageerror', String(e)));
  await answerAsks(page);
  await page.route('**/target/images/debian/initrd.img', (r) => r.fulfill({ path: 'target/images/stress/initrd.img' }));
  await page.goto(`${base}/web/app/?ncpus=${NCPUS}&ram=${RAM}&view=terminal&displaystats&disk2=${encodeURIComponent('/target/images/stress/goroot.ext4')}&${unattendedQuery()}`);
  await page.waitForFunction(() => ['running', 'failed', 'crashed'].includes(document.body.dataset.state!), undefined, { timeout: 300_000, polling: 250 });
  const heap = async () => {
    await page.evaluate(() => { (window as unknown as { __heap?: unknown }).__heap = undefined; (window as unknown as { __webpcHeap(): void }).__webpcHeap(); });
    await page.waitForFunction(() => (window as unknown as { __heap?: unknown }).__heap, undefined, { timeout: 30_000 });
    return page.evaluate(() => (window as unknown as { __heap: Heap }).__heap);
  };
  const mib = ({ buckets, ...h }: Heap) => ({ ...Object.fromEntries(Object.entries(h).map(([k, v]) => [k.replace('Bytes', 'MiB'), +(v / 2 ** 20).toFixed(1)])), buckets });
  results.running = mib(await heap());
  log('running', results.running);
  const term = () => page.evaluate(() => document.querySelector('.xterm-rows')?.textContent ?? '');
  await page.waitForFunction(() => /login:/.test(document.querySelector('.xterm-rows')?.textContent ?? ''), undefined, { timeout: 240_000, polling: 500 });
  await page.locator('.xterm').click();
  await page.keyboard.type('root\n', { delay: 5 });
  await page.waitForFunction(() => /root@\S+:~#/.test(document.querySelector('.xterm-rows')?.textContent ?? ''), undefined, { timeout: 120_000 });
  results.login = mib(await heap());
  log('login', results.login);
  const build = (n: number) => `(while :; do rm -rf /tmp/gc${n} /tmp/work${n}; cp -r /mnt/work /tmp/work${n}; cd /tmp/work${n}/web && GOROOT=/mnt/go GOCACHE=/tmp/gc${n} GOFLAGS=-mod=mod /mnt/go/bin/go build -o /tmp/web${n} . ; echo done >> /tmp/builds; cd /; done) > /dev/null 2>&1 &`;
  await page.keyboard.type(`mount -o ro /dev/vdb /mnt; ${build(1)} ${build(2)} (while :; do find /usr -type f 2>/dev/null | head -3000 | xargs sha256sum > /dev/null 2>&1; done) & clear\n`, { delay: 3 });
  log('load started');
  for (const end = performance.now() + secs * 1000; performance.now() < end;) {
    await page.waitForTimeout(20_000);
    const [state, h] = await Promise.all([page.evaluate(() => document.body.dataset.state), heap()]);
    if (state !== 'running') throw new Error(`the page is ${state}: ${await term()}`);
    const status = await page.evaluate(() => (window as unknown as { __status?: { stats?: { jit?: Record<string, number> } } }).__status?.stats?.jit);
    const s = { t: +((performance.now() - t0) / 1000).toFixed(0), ...mib(h), jit: status && { flushes: status.flushes, compileNs: status.compileNs } };
    samples.push(s);
    log(JSON.stringify(s));
    save();
  }
  await page.keyboard.type('clear; echo B$(wc -l < /tmp/builds)B\n', { delay: 3 });
  await page.waitForTimeout(3000);
  results.builds = Number((await term()).match(/B(\d+)B/)?.[1]);
  log('builds', results.builds);
} finally {
  save();
  await browser.close();
  server.close();
}
