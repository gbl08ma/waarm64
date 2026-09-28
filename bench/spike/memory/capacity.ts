// M0.5 capacity experiments (bench/spike/memory/REPORT.md), driven from Node: limits per
// memory, total across memories and workers, lazy commit, failure modes and
// feature support. Renderer RSS/VSZ come from `ps` on the renderer pid.
//   node bench/spike/memory/capacity.ts [--only limits,lazy,total,reserve,oom,features] [--out <file>]
// Safety: allocations are lazily committed and capped at CAP_GIB of `initial`
// size in total; touched (resident) memory stays under ~2 GiB. The OOM
// experiment runs Chromium in a systemd scope limited to 2 GiB (Linux only).
import { execFileSync, execSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { chromium, type Browser, type Page } from 'playwright-core';
import { ROOT, startServer } from '../../../tools/serve.ts';
import type { Desc } from './capacity-page.ts';

const CAP_GIB = 24;
const GiB = 2 ** 30, MiB = 2 ** 20;
const W32_MAX = 65536, M64_MAX = 262144; // pages; probed engine limits (see REPORT.md)

const { values: args } = parseArgs({ options: { only: { type: 'string' }, out: { type: 'string' } } });
const only = new Set((args.only ?? 'limits,lazy,total,reserve,oom,features').split(','));
const log = (m: string) => console.error(m);
const CHROMIUM = process.env.CHROMIUM ?? '/usr/bin/chromium';

const server = await startServer();
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

type Cap = Record<string, (...a: unknown[]) => unknown>;
type Ctx = { browser: Browser; page: Page; call: (fn: string, ...a: unknown[]) => Promise<any>; ps: () => Promise<Ps>; crashed: () => boolean };
type Ps = { pid: number; rssMiB: number; vszGiB: number; renderers: number };

/** RSS/VSZ of the renderer with the largest RSS (the page; spare renderers are small). VSZ includes V8's ~1 TiB sandbox reservation. */
async function rendererStats(browser: Browser): Promise<Ps> {
  const cdp = await browser.newBrowserCDPSession();
  const { processInfo } = (await cdp.send('SystemInfo.getProcessInfo' as never)) as { processInfo: { type: string; id: number }[] };
  await cdp.detach();
  const pids = processInfo.filter((p) => p.type === 'renderer').map((p) => p.id);
  const rows = pids.flatMap((pid) => {
    try {
      const [rss, vsz] = execFileSync('ps', ['-o', 'rss=,vsz=', '-p', String(pid)]).toString().trim().split(/\s+/).map(Number);
      return [{ pid, rssMiB: Math.round(rss / 1024), vszGiB: +(vsz / 1024 / 1024).toFixed(1) }];
    } catch { return []; }
  });
  rows.sort((a, b) => b.rssMiB - a.rssMiB);
  return { ...(rows[0] ?? { pid: -1, rssMiB: -1, vszGiB: -1 }), renderers: pids.length };
}

async function withPage<T>(fn: (c: Ctx) => Promise<T>, executablePath = CHROMIUM): Promise<T> {
  const browser = await chromium.launch({ executablePath, args: ['--js-flags=--expose-gc'] });
  try {
    const page = await browser.newPage();
    let crashed = false;
    page.on('crash', () => { crashed = true; });
    page.on('console', (m) => log(`[page] ${m.text()}`));
    await page.goto(`${base}/bench/spike/memory/capacity.html`);
    await page.waitForFunction(() => 'cap' in window);
    const ok = await page.evaluate(() => self.crossOriginIsolated);
    if (!ok) throw new Error('capacity page is not cross-origin isolated');
    const call = (fn: string, ...a: unknown[]) =>
      page.evaluate(([fn, a]) => ((window as unknown as { cap: Cap }).cap[fn as string] as (...x: unknown[]) => unknown)(...(a as unknown[])), [fn, a] as const);
    return await fn({ browser, page, call, ps: () => rendererStats(browser), crashed: () => crashed });
  } finally {
    await browser.close().catch(() => {});
  }
}

const w32 = (pages: number, shared = true): Desc => ({ initial: pages, maximum: shared ? pages : undefined, shared });
const m64 = (pages: number, shared = true): Desc => ({ i64: true, initial: pages, maximum: shared ? pages : undefined, shared });
const results: Record<string, unknown> = {};

if (only.has('limits')) {
  log('limits');
  results.limits = await withPage(async (c) => ({ ...(await c.call('limits')), psAfter: await c.ps() }));
}

if (only.has('lazy')) {
  log('lazy commit');
  results.lazy = await withPage(async (c) => {
    const steps: unknown[] = [];
    const step = async (what: string, r?: unknown) => { steps.push({ what, result: r, ...(await c.ps()) }); };
    await step('baseline');
    const a = await c.call('alloc', w32(W32_MAX));
    await step('alloc shared wasm32 4 GiB (untouched)', a);
    await c.call('touch', a.id, 0, 256 * MiB);
    await step('touched 256 MiB of it');
    await c.call('touch', a.id, 256 * MiB, 768 * MiB);
    await step('touched 1 GiB of it');
    const b = await c.call('alloc', m64(M64_MAX));
    await step('alloc shared memory64 16 GiB (untouched)', b);
    if (b.id !== undefined) await c.call('touch', b.id, 8 * GiB, 256 * MiB);
    await step('touched 256 MiB at 8 GiB offset of the memory64');
    await c.call('freeAll');
    await step('dropped all + gc()');
    await c.call('startWorkers', 1);
    const r = await c.call('worker', 0, { cmd: 'allocMany', desc: w32(16384, false), k: 1, touchBytes: 512 * MiB });
    await step('worker: alloc unshared wasm32 1 GiB, touch 512 MiB', r);
    return steps;
  });
}

if (only.has('total')) {
  log('total across memories');
  const per = 4; // GiB per memory (wasm32 maximum)
  const n = CAP_GIB / per;
  results.total = {
    mainThread: await withPage(async (c) => {
      const steps: unknown[] = [];
      for (let i = 0; i < n; i++) {
        const r = await c.call('alloc', w32(W32_MAX), 64 * MiB);
        steps.push({ memories: i + 1, allocatedGiB: (i + 1) * per, result: r, ...(await c.ps()) });
        if (r.error) break;
      }
      return steps;
    }),
    withWorkers: await withPage(async (c) => {
      const nWorkers = n - 2;
      await c.call('startWorkers', nWorkers);
      const main = await c.call('allocMany', w32(W32_MAX), 2);
      const workers = await Promise.all(Array.from({ length: nWorkers }, (_, i) =>
        c.call('worker', i, { cmd: 'allocMany', desc: w32(W32_MAX), k: 1, touchBytes: 64 * MiB })));
      return { note: `2 x ${per} GiB in the page + 1 x ${per} GiB in each of ${nWorkers} workers`, main, workers, ...(await c.ps()) };
    }),
  };
}

if (only.has('reserve')) {
  // Memories with a large maximum but 1 page of initial size: address-space reservations, ~no RAM.
  log('reservations');
  const LIMIT = 1024;
  const series = (desc: Desc) => withPage(async (c) => {
    const pts: unknown[] = [];
    let count = 0, error;
    while (count < LIMIT) {
      const r = await c.call('allocMany', desc, 8);
      count += r.allocated;
      pts.push({ count, ...(await c.ps()) });
      if (r.error) { error = r.error; break; }
    }
    return { desc, count, error, reachedLimit: count >= LIMIT, points: pts };
  });
  results.reserve = {
    wasm32_shared_max4GiB: await series({ initial: 1, maximum: W32_MAX, shared: true }),
    wasm32_unshared: await series({ initial: 1 }),
    memory64_shared_max16GiB: await series({ i64: true, initial: 1, maximum: M64_MAX, shared: true }),
    memory64_unshared: await series({ i64: true, initial: 1 }),
    wasm32_shared_page_plus_4_workers: await withPage(async (c) => {
      await c.call('startWorkers', 4);
      const desc = { initial: 1, maximum: W32_MAX, shared: true };
      const all = await Promise.all([c.call('allocMany', desc, LIMIT), ...[0, 1, 2, 3].map((i) => c.call('worker', i, { cmd: 'allocMany', desc, k: LIMIT, touchBytes: 0 }))]);
      return { desc, perThread: all, total: all.reduce((s, r) => s + r.allocated, 0), ...(await c.ps()) };
    }),
  };
}

if (only.has('oom')) {
  let scope = false;
  try { execSync('systemd-run --user --scope -q -p MemoryMax=64M true', { stdio: 'ignore' }); scope = true; } catch {}
  if (os.platform() !== 'linux' || !scope) {
    results.oom = { skipped: 'needs Linux with systemd-run --user (cgroup memory limit)' };
  } else {
    log('oom under a 2 GiB cgroup limit');
    const dir = mkdtempSync(join(os.tmpdir(), 'webpc-oom-'));
    const wrapper = join(dir, 'chromium-limited.sh');
    writeFileSync(wrapper, `#!/bin/sh\nexec systemd-run --user --scope -q -p MemoryMax=2G -p MemorySwapMax=0 -p OOMPolicy=continue ${CHROMIUM} "$@"\n`);
    chmodSync(wrapper, 0o755);
    results.oom = await withPage(async (c) => {
      const steps: unknown[] = [];
      const big64 = await c.call('alloc', m64(8 * GiB / 65536));
      steps.push({ what: 'alloc shared memory64 8 GiB under a 2 GiB limit', result: big64, ...(await c.ps()) });
      const a = await c.call('alloc', w32(W32_MAX));
      steps.push({ what: 'alloc shared wasm32 4 GiB', result: a, ...(await c.ps()) });
      let touched = 0, failure: unknown = null;
      while (touched < 4 * GiB) {
        try {
          await c.call('touch', a.id, touched, 128 * MiB);
          touched += 128 * MiB;
          steps.push({ what: `touched ${touched / MiB} MiB`, ...(await c.ps()) });
        } catch (e) {
          failure = { evaluateError: String((e as Error).message).split('\n')[0], pageCrashEvent: c.crashed() };
          break;
        }
      }
      let browserSurvived = false;
      try {
        const p = await c.browser.newPage();
        await p.goto(`${base}/bench/spike/memory/capacity.html`);
        browserSurvived = (await p.evaluate(() => 1 + 1)) === 2;
      } catch {}
      return { limit: 'MemoryMax=2G, MemorySwapMax=0, OOMPolicy=continue (whole browser in one cgroup)', touchedMiBBeforeFailure: touched / MiB, failure, browserSurvived, steps };
    }, wrapper);
    rmSync(dir, { recursive: true, force: true });
  }
}

if (only.has('features')) {
  log('features');
  results.features = await withPage((c) => c.call('features'));
}

server.close();
const git = (cmd: string) => { try { return execSync(`git ${cmd}`, { cwd: ROOT, stdio: 'pipe' }).toString().trim(); } catch { return null; } };
const version = execFileSync(CHROMIUM, ['--version']).toString().trim();
const report = {
  schema: 1, kind: 'capacity', date: new Date().toISOString(), commit: git('rev-parse --short=12 HEAD'), dirty: Boolean(git('status --porcelain')),
  host: { platform: os.platform(), arch: os.arch(), cpu: os.cpus()[0]?.model, cores: os.cpus().length, memGiB: Math.round(os.totalmem() / GiB) },
  browser: { version }, capGiB: CAP_GIB, results,
};
const out = args.out ?? `bench/results/local/${report.date.replace(/[:.]/g, '-')}-capacity.json`;
mkdirSync(join(ROOT, out, '..'), { recursive: true });
writeFileSync(join(ROOT, out), JSON.stringify(report, null, 1) + '\n');
log(`wrote ${out}`);
