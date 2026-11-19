// Times a demo the way a visitor meets it (bench/demo/REPORT.md): headless Chromium, a fresh profile and an empty
// cache each run, the target's page opened (bench/demo/targets.ts), and from that moment:
//   prompt    ms to the target's prompt (what that means per target: `promptIs`)
//   command   ms to the answer of a command typed at it (`echo ok-$((6*7))`; after a login where the prompt is one)
//   apk       ms `apk add python3` took, from typing it to its marker (`--apk`, where the guest can)
// with the bytes received by each mark and in all (Chromium's net log: every socket's bytes, TLS and all, by host;
// Chromium's own traffic apart), and the memory (the browser's processes from /proc: PSS and RSS at the prompt, peak
// over the run; `performance.measureUserAgentSpecificMemory()` after the command). One JSON for all runs, with each
// metric's median and IQR.
//   node bench/demo/run.ts <target> [--runs 3] [--apk] [--out <file>] [--keep]
// Targets: unkernel, v86-buildroot, v86-arch, waarm64-desktop, waarm64-alpine. `--keep` keeps each run's profile and
// net log under bench/results/local/demo/. Each run is bounded by the target's timeout; run the whole under `timeout`.
import { execSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { dirname } from 'node:path';
import { parseArgs } from 'node:util';
import { chromium, type Page } from 'playwright-core';
import { chromiumEnv } from '../../tools/nosme.ts';
import { summarize } from '../stats.ts';
import { bytesBy, readNetLog } from './netlog.ts';
import { browserPid, memSampler, type Mem } from './procmem.ts';
import { TARGETS, type Served, type Target } from './targets.ts';

const { values: args, positionals } = parseArgs({
  allowPositionals: true,
  options: { runs: { type: 'string', default: '3' }, apk: { type: 'boolean', default: false }, out: { type: 'string' }, keep: { type: 'boolean', default: false } },
});
const target = TARGETS[positionals[0]];
if (!target) throw new Error(`usage: node bench/demo/run.ts <${Object.keys(TARGETS).join('|')}> [--runs N] [--apk] [--out file] [--keep]`);
const WORK = new URL('../results/local/demo/', import.meta.url).pathname;
mkdirSync(WORK, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const out = args.out ?? `${WORK}${target.name}-${stamp}.json`;

let version = '';
const log = (...a: unknown[]) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a);
const git = (cmd: string) => execSync(`git ${cmd}`, { encoding: 'utf8' }).trim();

export type Run = {
  run: number;
  /**
   * ms from the navigation's start: the page `ready` for the visitor, the `click` (made: the click's work done), the
   * prompt, the command's answer, the second command's (`again`). `apkMs` is the install's own duration.
   */
  marks: { ready?: number; click?: number; made?: number; prompt?: number; command?: number; again?: number; apkMs?: number };
  /** ms from the navigation's start to each of the target's `phases` first showing on its console. */
  phases?: Record<string, number>;
  apkOk?: boolean;
  /** Bytes received: the page's hosts (`page`) and Chromium's own (`background`), by each mark and in all; by host in all. */
  bytes: {
    prompt?: number;
    command?: number;
    total: number;
    background: number;
    byHost: Record<string, number>;
    /** What a counting server sent (the target's `serve`), by kind, by each mark and in all; the page brotli'd. */
    kinds?: { prompt?: Record<string, number>; command?: Record<string, number>; total: Record<string, number> };
    pageBrotli?: { prompt?: number; total: number };
  };
  mem: { prompt?: Mem; peak: Mem; uasmMiB?: number };
  error?: string;
};

async function once(t: Target, n: number, server: Served | undefined): Promise<Run> {
  const base = server?.base ?? '';
  const profile = `${WORK}profile-${t.name}-${n}`;
  const netlog = `${WORK}netlog-${t.name}-${n}.json`;
  rmSync(profile, { recursive: true, force: true });
  const ctx = await chromium.launchPersistentContext(profile, {
    executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium',
    headless: true,
    viewport: { width: 1400, height: 1000 },
    env: chromiumEnv(),
    // ForceEagerMeasureMemory: measureUserAgentSpecificMemory answers at once rather than at the next GC.
    args: [
      `--log-net-log=${netlog}`,
      '--enable-blink-features=ForceEagerMeasureMemory',
      // Offline: no name resolves but this computer's (Chromium's own traffic included).
      ...(t.offline ? ['--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1'] : []),
    ],
  });
  const pid = browserPid(profile);
  if (!pid) throw new Error('the browser process was not found');
  const mem = memSampler(pid);
  const page: Page = ctx.pages()[0] ?? (await ctx.newPage());
  version ||= ctx.browser()?.version() ?? '';
  page.on('pageerror', (e) => log('[page error]', e.message.slice(0, 200)));
  const wall: { prompt?: number; command?: number } = {};
  const log0 = server?.kinds?.() ?? {};
  const r: Run = { run: n, marks: {}, bytes: { total: 0, background: 0, byHost: {} }, mem: { peak: mem.now() } };
  const t0 = Date.now();
  const since = () => Date.now() - t0;
  const phases: Record<string, number> = {};
  const phaseTimer = t.phases && setInterval(async () => {
    const text = await t.text(page).catch(() => '');
    for (const [k, re] of t.phases!) if (!(k in phases) && re.test(text)) phases[k] = since();
  }, 250);
  try {
    await page.goto(t.url(base), { timeout: 60_000 });
    if (t.ready) {
      await t.ready(page, 60_000);
      r.marks.ready = since();
    }
    if (t.click) {
      r.marks.click = since();
      await t.click(page, base);
      r.marks.made = since();
      log(`run ${n}: click ${r.marks.click} ms, made ${r.marks.made} ms`);
    }
    await t.prompt(page, t.timeoutMs);
    r.marks.prompt = since();
    wall.prompt = Date.now();
    r.mem.prompt = mem.now();
    log(`run ${n}: prompt`, r.marks.prompt, 'ms');
    if (t.echo) {
      await t.login?.(page);
      const answered = async () => /ok-42/.test(await t.text(page));
      let typed = 0;
      const end = Date.now() + 120_000;
      while (!(await answered())) {
        if (Date.now() > end) throw new Error('the command was not answered');
        if (!typed || (t.retryMs && Date.now() - typed > t.retryMs)) {
          await t.type(page, `${t.echo}\n`);
          typed = Date.now();
        }
        await page.waitForTimeout(50);
      }
      r.marks.command = since();
      wall.command = Date.now();
      log(`run ${n}: command`, r.marks.command, 'ms');
      if (t.again) {
        await t.type(page, `${t.again}\n`);
        for (const end = Date.now() + 60_000; !/ok-48/.test(await t.text(page)); await page.waitForTimeout(20))
          if (Date.now() > end) throw new Error('the second command was not answered');
        r.marks.again = since();
        log(`run ${n}: again`, r.marks.again - r.marks.command, 'ms after the first');
      }
    }
    r.mem.uasmMiB = await Promise.race([
      page.evaluate(async () => {
        const m = (performance as unknown as { measureUserAgentSpecificMemory?: () => Promise<{ bytes: number }> }).measureUserAgentSpecificMemory;
        return m ? Math.round((await m.call(performance)).bytes / 2 ** 20) : undefined;
      }),
      new Promise<undefined>((res) => setTimeout(res, 30_000)),
    ]).catch(() => undefined);
    if (args.apk && t.apk) {
      const a0 = Date.now();
      await t.type(page, `${t.apk}\n`);
      const end = a0 + 600_000;
      let m: RegExpExecArray | null = null;
      while (!(m = /apk-(\d+)-42/.exec(await t.text(page)))) {
        if (Date.now() > end) throw new Error('apk did not finish');
        await page.waitForTimeout(200);
      }
      r.marks.apkMs = Date.now() - a0;
      r.apkOk = m[1] === '0' && /^420$/m.test(await t.text(page));
      log(`run ${n}: apk`, r.marks.apkMs, 'ms', r.apkOk ? 'ok' : 'FAILED');
    }
  } catch (e) {
    r.error = String(e).slice(0, 500);
    log(`run ${n}: error`, r.error);
  } finally {
    if (phaseTimer) {
      clearInterval(phaseTimer);
      r.phases = phases;
    }
    await page.screenshot({ path: `${WORK}${t.name}-${n}.png` }).catch(() => {});
    writeFileSync(`${WORK}${t.name}-${n}.txt`, await t.text(page).catch(() => ''));
    r.mem.peak = mem.stop();
    await ctx.close();
  }
  const hosts = await readNetLog(netlog);
  const all = bytesBy(hosts);
  r.bytes = { total: all.page, background: all.background, byHost: all.byHost };
  if (wall.prompt) r.bytes.prompt = bytesBy(hosts, wall.prompt).page;
  if (wall.command) r.bytes.command = bytesBy(hosts, wall.command).page;
  if (server?.kinds) {
    // What this run's servers sent: the counts since the run began (a server lives across the runs).
    const less = (now: Record<string, number>) => Object.fromEntries(Object.entries(now).map(([k, v]) => [k, v - (log0[k] ?? 0)]));
    r.bytes.kinds = {
      prompt: wall.prompt ? less(server.kinds(wall.prompt)) : undefined,
      command: wall.command ? less(server.kinds(wall.command)) : undefined,
      total: less(server.kinds()),
    };
  }
  // The page's files sent compressed: each distinct file once per run (a fresh profile), so only the first run's count.
  if (server?.pageBrotli && n === 1) r.bytes.pageBrotli = { prompt: wall.prompt ? server.pageBrotli(wall.prompt) : undefined, total: server.pageBrotli() };
  log(`run ${n}: bytes`, JSON.stringify(r.bytes), 'mem', JSON.stringify(r.mem));
  if (!args.keep) {
    rmSync(profile, { recursive: true, force: true });
    rmSync(netlog, { force: true });
  }
  return r;
}

const server = await target.serve?.();
const runs: Run[] = [];
try {
  for (let n = 1; n <= Number(args.runs); n++) runs.push(await once(target, n, server));
} finally {
  await server?.close();
}

const ok = runs.filter((r) => !r.error);
const metric = (f: (r: Run) => number | undefined) => {
  const xs = ok.map(f).filter((x): x is number => typeof x === 'number');
  return xs.length ? { ...summarize(xs), samples: xs } : undefined;
};
const MiB = 2 ** 20;
const summary = Object.fromEntries(
  Object.entries({
    ready_ms: metric((r) => r.marks.ready),
    click_made_ms: metric((r) => r.marks.made !== undefined && r.marks.click !== undefined ? r.marks.made - r.marks.click : undefined),
    click_prompt_ms: metric((r) => r.marks.prompt !== undefined && r.marks.click !== undefined ? r.marks.prompt - r.marks.click : undefined),
    click_command_ms: metric((r) => r.marks.command !== undefined && r.marks.click !== undefined ? r.marks.command - r.marks.click : undefined),
    again_ms: metric((r) => r.marks.again !== undefined && r.marks.command !== undefined ? r.marks.again - r.marks.command : undefined),
    prompt_ms: metric((r) => r.marks.prompt),
    command_ms: metric((r) => r.marks.command),
    apk_ms: metric((r) => r.marks.apkMs),
    bytes_prompt_MiB: metric((r) => r.bytes.prompt && r.bytes.prompt / MiB),
    bytes_command_MiB: metric((r) => r.bytes.command && r.bytes.command / MiB),
    bytes_total_MiB: metric((r) => r.bytes.total / MiB),
    ...Object.fromEntries(
      [...new Set(ok.flatMap((r) => Object.keys(r.bytes.kinds?.command ?? {})))].map((k) => [`sent_${k}_command_MiB`, metric((r) => (r.bytes.kinds?.command?.[k] ?? 0) / MiB)]),
    ),
    pss_prompt_MiB: metric((r) => r.mem.prompt?.pssMiB),
    pss_peak_MiB: metric((r) => r.mem.peak.pssMiB),
    rss_peak_MiB: metric((r) => r.mem.peak.rssMiB),
    uasm_MiB: metric((r) => r.mem.uasmMiB),
  }).filter(([, v]) => v),
);
const result = {
  schema: 1,
  kind: 'demo',
  target: target.name,
  system: target.system,
  what: target.what,
  promptIs: target.promptIs,
  url: target.url(server ? '<local>' : ''),
  apk: args.apk && target.apk ? target.apk : undefined,
  date: new Date().toISOString(),
  commit: git('rev-parse --short=12 HEAD'),
  host: { platform: os.platform(), arch: os.arch(), cpu: os.cpus()[0]?.model, cores: os.cpus().length, memGiB: Math.round(os.totalmem() / 2 ** 30) },
  browser: { version, headless: true },
  runs,
  failed: runs.length - ok.length,
  summary,
};
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `${JSON.stringify(result, null, 1)}\n`);
log('wrote', out);
for (const [k, v] of Object.entries(summary)) log(k, 'median', +v!.median.toFixed(1), 'iqr', +v!.iqr.toFixed(1), 'n', v!.n);
