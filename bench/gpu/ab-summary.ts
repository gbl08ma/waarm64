// The sessions of bench/gpu/ab.sh by arm (docs/benchmarking.md "Starting from a snapshot"; dev-only): per session and
// per arm (median and IQR over its sessions) the counts first (flushes, modules, wasm MB compiled, the share of guest
// steps run in compiled code, Gsteps interpreted: results.json's `jit` and counts.ts's totals), then the times (busy
// MIPS and stalls from bench/gpu/stalls.ts, the heavy pages' loads, frames), and the session's turnaround (wall
// seconds; setup: from the start to the phases, the boot or the restore included). The flushes' times from the JIT's
// counters once a second (jit.jsonl.gz): the first flush's seconds after the workload's start (the churn page's or the
// sites' `ready`, else the phases'), flushes a minute over the workload, and each flush's slow phase (Gsteps and seconds
// until the share of guest steps run compiled, per 200 M-step window, is back within 2 points of the 800 M steps before).
//   node bench/gpu/ab-summary.ts [--json] <outdir>...
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';

const json = process.argv.includes('--json');
type Row = Record<string, number | string>;
const rows: Row[] = [];
/** The renderer's RSS and V8's wasm code (rss.sh's MiB samples, every 5 s) over the workload: median and maximum. */
function rssOf(f: string, from?: number, to?: number): Row {
  const xs = (existsSync(f) ? readFileSync(f, 'utf8') : '').trim().split('\n').filter(Boolean).map((l) => l.split(' ').map(Number)).filter((x) => x.length === 4 && (!from || !to || (x[0] * 1000 >= from && x[0] * 1000 <= to)));
  if (!xs.length) return {};
  const med = (v: number[]) => { const s = [...v].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
  return { rssMed: med(xs.map((x) => x[2])), rssMax: Math.max(...xs.map((x) => x[2])), codeMed: med(xs.map((x) => x[3])), codeMax: Math.max(...xs.map((x) => x[3])) };
}
const read = (f: string) => (existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : undefined);
for (const dir of process.argv.slice(2).filter((a) => a !== '--json')) {
  for (const s of readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort()) {
    const d = `${dir}/${s}`;
    const res = read(`${d}/results.json`);
    if (!res) continue;
    const st = Object.values(read(`${d}/stalls.json`) ?? {})[0] as Record<string, any> | undefined;
    const counts = (Object.values(read(`${d}/counts.json`) ?? {})[0] as { totals: Record<string, number> } | undefined)?.totals;
    const wall = /wall ([\d.]+) exit (\d+)/.exec(existsSync(`${d}/wall.txt`) ? readFileSync(`${d}/wall.txt`, 'utf8') : '');
    const pages = Object.keys(res).filter((k) => k.startsWith('page-'));
    const fps = (k: string) => res[k]?.medianFps;
    const t = res.times ?? {};
    // The workload's start and end (epoch ms), and the JIT's counters over it.
    const w = res.churn ?? res.sites;
    const from = w?.readyAt ?? t.setUp, to = w ? w.readyAt + w.seconds * 1000 : t.saved;
    type S = { t: number; steps: number; jit: Record<string, number> };
    const raw = existsSync(`${d}/jit.jsonl.gz`) ? gunzipSync(readFileSync(`${d}/jit.jsonl.gz`)).toString() : existsSync(`${d}/jit.jsonl`) ? readFileSync(`${d}/jit.jsonl`, 'utf8') : '';
    const xs = raw.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as S);
    const first = xs.find((x) => x.jit.flushes > 0 && x.t >= (from ?? 0));
    const inside = xs.filter((x) => x.t >= from && x.t <= to);
    const flushesIn = inside.length ? inside.at(-1)!.jit.flushes - inside[0].jit.flushes : NaN;
    const timeAt = (steps: number) => xs.find((x) => x.steps >= steps)?.t;
    const slow = ((Object.values(read(`${d}/counts.json`) ?? {})[0] as { flushes?: { atS: number; atGsteps: number; shareBefore: number; shareAfter: number[] }[] } | undefined)?.flushes ?? []).map((f) => {
      const k = f.shareAfter.findIndex((x) => x >= f.shareBefore - 0.02);
      const g = (k < 0 ? f.shareAfter.length : k) * 0.2;
      const at = timeAt((f.atGsteps + g) * 1e9);
      return { g, s: at ? (at - xs[0].t) / 1000 - f.atS : NaN }; // atS: seconds from the first sample
    });
    const row: Row = {
      session: s, arm: s.replace(/-\d+$/, ''), exit: wall ? +wall[2] : NaN,
      flushes: res.jit?.flushes ?? NaN, modules: res.jit?.modules ?? NaN, wasmMB: res.jit ? Math.round(res.jit.bytes / 1e6) : NaN,
      share: counts?.share ?? NaN, interpG: counts?.interpGsteps ?? NaN, gsteps: counts?.gsteps ?? NaN,
      busyMips: st?.busyMips ?? NaN, stalls20: st?.stallsAtLeastMs?.[20] ?? NaN, stalls50: st?.stallsAtLeastMs?.[50] ?? NaN,
      wikiLoadS: res['page-wiki'] ? +(res['page-wiki'].loadMs / 1000).toFixed(1) : NaN, bbcLoadS: res['page-bbc'] ? +(res['page-bbc'].loadMs / 1000).toFixed(1) : NaN,
      pagesFps: pages.length ? pages.map(fps).join('/') : '', webglFps: fps('webgl') ?? NaN,
      wallS: wall ? Math.round(+wall[1]) : NaN, setupS: t.setUp && t.start ? Math.round((t.setUp - t.start) / 1000) : NaN, measuredS: t.setUp && t.saved ? Math.round((t.saved - t.setUp) / 1000) : NaN,
      restoreS: res.from ? +(res.from.loadMs / 1000).toFixed(1) : NaN,
      firstFlushS: first && from ? Math.round((first.t - from) / 1000) : NaN,
      flushesPerMin: inside.length > 1 ? +((flushesIn * 60000) / (inside.at(-1)!.t - inside[0].t)).toFixed(2) : NaN,
      slowG: slow.length ? +(slow.reduce((a, b) => a + b.g, 0) / slow.length).toFixed(2) : NaN,
      slowS: slow.length ? +(slow.reduce((a, b) => a + b.s, 0) / slow.length).toFixed(1) : NaN,
      made: res.churn?.made ?? NaN, doneS: res.churn?.doneS ?? NaN,
      // The JIT cache's lock over the session (ABI 46): acquisitions, the share that found it held, ms waited, ms
      // emitting (all, and under the lock) and forming batches, regions compiled per acquisition; and modules compiled
      // on a vCPU after waiting a second for the compile worker.
      ...(res.jit?.locks !== undefined ? {
        locks: res.jit.locks, contended: +(res.jit.lockContended / res.jit.locks).toFixed(4), waitMs: Math.round(res.jit.lockWaitNs / 1e6),
        emitMs: Math.round(res.jit.emitNs / 1e6), lockedMs: Math.round(res.jit.emitLockedNs / 1e6), planMs: Math.round(res.jit.planNs / 1e6),
        perLock: +(res.jit.blocks / res.jit.locks).toFixed(4),
        // (ABI 47) misses that found it held and ran their block interpreted instead of waiting.
        ...(res.jit.lockSkipped !== undefined ? { skipped: res.jit.lockSkipped } : {}),
      } : {}),
      // Parallel SMP's other waits: DSB waits for TLBI IS, and the platform lock's (ms).
      ...(res.par?.dsbWaitNs !== undefined ? { dsbMs: Math.round(res.par.dsbWaitNs / 1e6), platMs: Math.round(res.par.lockWaitNs / 1e6) } : {}),
      overdue: res.jit?.overdue ?? NaN,
      ...rssOf(`${d}/rss.txt`, from, to),
    };
    rows.push(row);
  }
}
const KEYS = ['flushes', 'modules', 'wasmMB', 'share', 'interpG', 'firstFlushS', 'flushesPerMin', 'slowG', 'slowS', 'made', 'doneS', 'locks', 'contended', 'waitMs', 'emitMs', 'lockedMs', 'planMs', 'perLock', 'skipped', 'dsbMs', 'platMs', 'overdue', 'rssMed', 'rssMax', 'codeMed', 'codeMax', 'busyMips', 'stalls20', 'stalls50', 'wikiLoadS', 'bbcLoadS', 'webglFps', 'wallS', 'setupS', 'measuredS', 'restoreS'];
const q = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); const i = (s.length - 1) * p, lo = Math.floor(i); return s[lo] + (s[Math.ceil(i)] - s[lo]) * (i - lo); };
const arms: Record<string, Record<string, { median: number; iqr: number; n: number; all: number[] }>> = {};
for (const arm of [...new Set(rows.map((r) => r.arm as string))]) {
  arms[arm] = {};
  for (const k of KEYS) {
    const xs = rows.filter((r) => r.arm === arm).map((r) => r[k] as number).filter((x) => Number.isFinite(x));
    if (xs.length) arms[arm][k] = { median: +q(xs, 0.5).toFixed(3), iqr: +(q(xs, 0.75) - q(xs, 0.25)).toFixed(3), n: xs.length, all: xs };
  }
}
if (json) console.log(JSON.stringify({ sessions: rows, arms }, null, 1));
else {
  const cols = ['session', 'exit', ...KEYS.slice(0, 28), 'pagesFps', ...KEYS.slice(28)];
  console.log(cols.join('\t'));
  for (const r of rows) console.log(cols.map((c) => r[c] ?? '').join('\t'));
  console.log();
  for (const [arm, ks] of Object.entries(arms)) console.log(`${arm}: ${Object.entries(ks).map(([k, v]) => `${k} ${v.median} (IQR ${v.iqr}, n=${v.n})`).join(', ')}`);
}
