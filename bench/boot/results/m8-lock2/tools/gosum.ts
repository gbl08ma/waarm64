// The go build loop's sessions (stress.ts jsonl, .gz too): MIPS per sample interval (median, IQR), and the
// lock/par counters at the end (the guest's GOBUILD lines aren't in the log). gosum.ts <file.jsonl[.gz]>...
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';

type S = { type: string; t: number; status?: { steps: number; stats?: { jit?: Record<string, number>; par?: Record<string, number> } } };
const q = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); const i = (s.length - 1) * p, lo = Math.floor(i); return s[lo] + (s[Math.ceil(i)] - s[lo]) * (i - lo); };
for (const f of process.argv.slice(2)) {
  const raw = readFileSync(f);
  const lines = (f.endsWith('.gz') ? gunzipSync(raw) : raw).toString().split('\n').filter(Boolean).map((l) => JSON.parse(l) as S);
  const samples = lines.filter((l) => l.type === 'sample' && l.status?.steps);
  const mips: number[] = [];
  for (let i = 1; i < samples.length; i++) mips.push((samples[i].status!.steps - samples[i - 1].status!.steps) / (samples[i].t - samples[i - 1].t) / 1e6);
  const last = samples.at(-1)?.status?.stats;
  const j = last?.jit ?? {}, p = last?.par ?? {};
  const all = (samples.at(-1)!.status!.steps - samples[0].status!.steps) / (samples.at(-1)!.t - samples[0].t) / 1e6;
  console.log(JSON.stringify({
    file: f, samples: samples.length, mipsMedian: Math.round(q(mips, 0.5)), mipsIqr: Math.round(q(mips, 0.75) - q(mips, 0.25)), mipsOverall: Math.round(all),
    locks: j.locks, contended: j.locks ? +(j.lockContended / j.locks).toFixed(4) : undefined, waitMs: Math.round((j.lockWaitNs ?? 0) / 1e6), skipped: j.lockSkipped,
    interpG: +((samples.at(-1)!.status!.steps - (j.steps ?? 0)) / 1e9).toFixed(2), ics: p.ic, dsbMs: Math.round((p.dsbWaitNs ?? 0) / 1e6), platMs: Math.round((p.lockWaitNs ?? 0) / 1e6),
  }));
}
