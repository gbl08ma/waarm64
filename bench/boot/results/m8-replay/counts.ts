// The JIT's flushes counted, not timed (a cloud session's measure: its CPU is shared, so no times are read from it).
// Debian on the page (?machine=debian, unattended, 4 vCPUs), logged in on the serial console, through its boot and a
// userspace load; the page's counters once a second. Per flush: its kind (carried, plain, made plain as futile), the
// regions marked, kept, replayed and their bytes, the modules and wasm alive before it and once its carried slots
// were let go of, the replay's modules (emitted by a vCPU or the compile worker, discarded by rule), the share of
// guest steps run in compiled code per window of guest steps after it, and the guest steps until the next flush.
// The budget is the core's: build it cut (e.g. `MAX_BYTES` 24 MiB, a local edit) for flushes to happen.
//   node bench/boot/results/m8-replay/counts.ts run <out.json> [query] [repo dir: whose page]   (one session)
//   node bench/boot/results/m8-replay/counts.ts report [--json] <out.json[.gz]>...             (the analysis)
import { readFileSync, writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { resolve } from 'node:path';

type Jit = Record<string, number>;
type Sample = { t: number; steps: number; jit: Jit };
type Session = { query: string; core: string; samples: Sample[]; phases: Record<string, number> };

/** The steps windows after a flush: WINDOW guest steps each, over SPAN (the samples are a second apart: interpolated). */
const WINDOW = 200e6, SPAN = 2e9;
/** The userspace load, once logged in: many binaries, so much code (perl-base, gzip and apt are in every Debian). */
const LOAD = [
  'for i in 1 2; do find /usr -type f -size -200k -print0 | xargs -0 cat | gzip -1 | wc -c; done',
  'for i in 1 2 3; do apt-cache dumpavail > /dev/null 2>&1; apt-cache search . 2>/dev/null | sort | md5sum; done',
  'perl -e \'my %h; for my $i (1..300000) { $h{$i % 997} .= $i } print scalar(keys %h), "\\n"\'',
  'for i in 1 2; do ls -lR /usr /etc /var 2>/dev/null | sort -k5 -n | tail -1; done',
];

async function run(out: string, query: string, repo: string) {
  const { chromium } = await import(resolve(repo, 'node_modules/playwright-core/index.mjs'));
  const { startServer } = await import(resolve(repo, 'tools/serve.ts'));
  const { unattendedQuery } = await import(resolve(repo, 'tests/debian-unattended.ts'));
  const server = await startServer(0);
  const port = (server.address() as { port: number }).port;
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM });
  const page = await browser.newPage();
  page.on('pageerror', (e: Error) => console.log('pageerror:', String(e).slice(0, 300)));
  page.on('console', (m: { text(): string }) => { const t = m.text(); if (/panic|RuntimeError|jit emitter/i.test(t)) console.log('console:', t.slice(0, 300)); });
  await page.goto(`http://127.0.0.1:${port}/web/app/?${unattendedQuery()}&ncpus=4&view=terminal&displaystats${query ? `&${query}` : ''}`);
  const s: Session = { query, core: repo, samples: [], phases: {} };
  const t0 = Date.now();
  const save = () => writeFileSync(out, JSON.stringify(s));
  const sampler = setInterval(async () => {
    try {
      const st = await page.evaluate(() => (window as unknown as { __status?: { stats: { steps: number; jit: Jit } } }).__status?.stats);
      if (st) s.samples.push({ t: Date.now() - t0, steps: st.steps, jit: st.jit });
    } catch {}
  }, 1000);
  const rows = () => page.evaluate(() => document.querySelector('.xterm-rows')?.textContent ?? '');
  const until = async (re: RegExp, ms: number) => { const end = Date.now() + ms; while (!re.test(await rows())) { if (Date.now() > end) throw new Error(`timed out on ${re}: ${(await rows()).slice(-300)}`); await page.waitForTimeout(500); } };
  const type = async (text: string) => { await page.locator('.xterm').click(); await page.keyboard.type(text, { delay: 5 }); };
  try {
    await until(/login: /, 360_000);
    s.phases.login = Date.now() - t0;
    await type('root\n');
    await until(/root@\S+:~# /, 60_000);
    for (const [k, cmd] of LOAD.entries()) {
      await type(`${cmd}; echo done-$((${k}+40))\n`);
      await until(new RegExp(`done-${k + 40}`), 400_000);
      s.phases[`load${k}`] = Date.now() - t0;
      save();
    }
    await page.waitForTimeout(10_000);
  } finally {
    clearInterval(sampler);
    save();
    await browser.close();
    server.close();
  }
}

/** The share of guest steps run in compiled code over steps `a..b`, from samples interpolated by steps. */
function share(x: Sample[], a: number, b: number) {
  const at = (steps: number, k: (s: Sample) => number) => {
    let i = x.findIndex((s) => s.steps >= steps);
    if (i < 0) return NaN;
    if (i === 0) i = 1;
    const [p, q] = [x[i - 1], x[i]];
    const f = q.steps === p.steps ? 1 : (steps - p.steps) / (q.steps - p.steps);
    return k(p) + f * (k(q) - k(p));
  };
  const j = at(b, (s) => s.jit.steps) - at(a, (s) => s.jit.steps);
  return +(j / (b - a)).toFixed(3);
}

function report(s: Session) {
  const x = s.samples, last = x[x.length - 1].jit;
  // (A core before ABI 42 doesn't count what it lets go of.)
  const alive = (j: Jit) => j.releasedModules === undefined ? undefined : { modules: j.modules - j.releasedModules, mib: +((j.bytes - j.releasedBytes) / 2 ** 20).toFixed(1) };
  const flushes: Record<string, unknown>[] = [];
  for (let i = 1; i < x.length; i++) {
    const [p, q] = [x[i - 1].jit, x[i].jit];
    if (q.flushes === p.flushes) continue;
    // Up to the next flush, or the end.
    let e = i + 1;
    while (e < x.length && x[e].jit.flushes === q.flushes) e++;
    const end = x[Math.min(e, x.length) - 1], next = e < x.length ? x[e] : undefined;
    const d = (k: string) => (end.jit[k] ?? 0) - (p[k] ?? 0);
    // Alive once the carried slots went (the first sample after their release; a plain flush lets go at once).
    const carry = q.replays > p.replays;
    const freed = carry ? x.slice(i + 1, e).find((y) => y.jit.releasedModules > q.releasedModules) ?? end : x[i];
    const windows = [];
    for (let a = x[i].steps; a + WINDOW <= Math.min(x[i].steps + SPAN, end.steps); a += WINDOW) windows.push(share(x, a, a + WINDOW));
    flushes.push({
      atS: Math.round(x[i].t / 1000), atGsteps: +(x[i].steps / 1e9).toFixed(2),
      kind: carry ? 'carry' : (q.futile ?? 0) > (p.futile ?? 0) ? 'futile' : 'plain',
      marked: q.marked - p.marked || undefined, kept: q.kept - p.kept || undefined,
      replayed: d('replayed'), replayedMiB: +(d('replayedBytes') / 2 ** 20).toFixed(1),
      emits: { inline: d('emitsInline'), worker: d('emitsWorker') },
      discards: { epoch: d('discardEpoch'), page: d('discardPage'), import: d('discardImport'), wasted: d('wasted') },
      replayLocks: d('replayLocks'),
      before: alive(p), after: alive(freed.jit),
      modulesEmitted: d('modules'), mibEmitted: +(d('bytes') / 2 ** 20).toFixed(1),
      shareBefore: share(x, Math.max(0, x[i - 1].steps - 4 * WINDOW), x[i - 1].steps),
      shareAfter: windows,
      stepsToNextG: next ? +((next.steps - x[i].steps) / 1e9).toFixed(2) : undefined,
    });
  }
  const totals = {
    gsteps: +(x[x.length - 1].steps / 1e9).toFixed(2), flushes: last.flushes, replays: last.replays, futile: last.futile,
    modules: last.modules, mib: +(last.bytes / 2 ** 20).toFixed(1), alive: alive(last), replayed: last.replayed,
    overdue: last.overdue, parks: last.parks, locks: last.locks, replayLocks: last.replayLocks,
    emitsInline: last.emitsInline, emitsWorker: last.emitsWorker, interpGsteps: +(last.decSteps / 1e9).toFixed(2),
    share: +(last.steps / x[x.length - 1].steps).toFixed(3), phases: s.phases,
  };
  return { query: s.query, totals, flushes };
}

const [mode, ...rest] = process.argv.slice(2);
if (mode === 'run') {
  await run(rest[0], rest[1] ?? '', resolve(rest[2] ?? '.'));
} else if (mode === 'report') {
  const json = rest.includes('--json');
  const out: Record<string, unknown> = {};
  for (const f of rest.filter((a) => a !== '--json')) {
    const raw = readFileSync(f);
    const r = report(JSON.parse((f.endsWith('.gz') ? gunzipSync(raw) : raw).toString('utf8')) as Session);
    out[f] = r;
    if (!json) {
      console.log(`${f} (${r.query || 'default'}): ${JSON.stringify(r.totals)}`);
      for (const x of r.flushes) console.log(`  ${JSON.stringify(x)}`);
    }
  }
  if (json) console.log(JSON.stringify(out, null, 1));
} else {
  console.error('usage: counts.ts run <out.json> [query] [repo] | report [--json] <out.json>...');
  process.exit(2);
}
