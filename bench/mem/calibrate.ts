// The page's memory estimate (web/app/memory.ts `Signal`) against the renderer's smaps (dev-only): reads the
// mem.jsonl files bench/gpu/guest-session.ts writes under MEMLOG and prints, per session, the estimate's error against
// the renderer's total (median, min, max, MiB and %), and the fitted factors: V8's code per live wasm byte (smaps'
// executable anonymous mappings), the rest of the anonymous memory per live wasm byte past the first sample's, and
// the wasm memories' resident share of RAM + the heap's high-water mark.
//   node bench/mem/calibrate.ts [--json] <session dir | mem.jsonl>...
import { existsSync, readFileSync, statSync } from 'node:fs';
import { estimate, Signal } from '../../web/app/memory.ts';

const json = process.argv.includes('--json');
const out: Record<string, unknown> = {};
const med = (v: number[]) => { const s = [...v].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
for (const a of process.argv.slice(2).filter((x) => x !== '--json')) {
  const f = existsSync(a) && statSync(a).isDirectory() ? `${a}/mem.jsonl` : a;
  if (!existsSync(f)) continue;
  type Sample = { t: number; smaps?: Record<string, number>; memory?: Parameters<typeof estimate>[0] };
  const xs = readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as Sample).filter((x) => x.smaps && x.memory);
  if (!xs.length) continue;
  const MiB = 2 ** 20;
  // The page's estimate: `Signal`, which counts a flushed epoch for a while after the flush.
  const signal = new Signal();
  const est = xs.map((x) => signal.update(x.memory!, 4, x.t) / MiB);
  const err = xs.map((x, i) => est[i] - x.smaps!.total);
  const pct = xs.map((x, i) => (100 * err[i]) / x.smaps!.total);
  // Fits over samples with live code (before any flush's garbage: the first epoch).
  const first = xs.filter((x) => x.memory!.jitEpochs === xs[0].memory!.jitEpochs && x.memory!.jitLiveBytes > 16 * MiB);
  const code = first.map((x) => x.smaps!.code / (x.memory!.jitLiveBytes / MiB));
  const a0 = xs[0].smaps!.anon, l0 = xs[0].memory!.jitLiveBytes / MiB;
  const anon = first.slice(1).map((x) => (x.smaps!.anon - a0) / (x.memory!.jitLiveBytes / MiB - l0)).filter(Number.isFinite);
  const resident = xs.map((x) => x.smaps!['wasm-mem'] / ((x.memory!.ramBytes + x.memory!.heapPeak) / MiB));
  out[a] = { samples: xs.length, errMiB: { median: Math.round(med(err)), min: Math.round(Math.min(...err)), max: Math.round(Math.max(...err)) }, errPct: { median: +med(pct).toFixed(1), min: +Math.min(...pct).toFixed(1), max: +Math.max(...pct).toFixed(1) }, codePerByte: +med(code).toFixed(2), anonPerByte: anon.length ? +med(anon).toFixed(2) : NaN, wasmMemResident: +med(resident).toFixed(2), rssMaxMiB: Math.max(...xs.map((x) => x.smaps!.total)), estMaxMiB: Math.round(Math.max(...est)) };
}
console.log(json ? JSON.stringify(out, null, 1) : Object.entries(out).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join('\n'));
