import { readFileSync } from 'node:fs';
const marks = JSON.parse(readFileSync(process.argv[2], 'utf8')).marks as { name: string; ms: number; steps: number; report: { op: string; calls: number }[] }[];
const ph = marks.slice(1).map((m, i) => ({ from: marks[i], to: m })).filter((p) => p.to.ms - p.from.ms > 50);
const N = ['vaFlush', 'vaCleared', 'vaAny', 'retDepthLt8', 'ngFlush', 'ngBump', 'retUpMispredicted', 'retUpAll', 'hit', 'miss', 'missFilled', 'mStaleGen', 'mZero', 'mOtherTag', 'mTagGenOk', 'scanNs', 'clockNs', 'retDepthGe56', 'fromChainCheck', 'fromRetElsewhere'];
const g = (m: (typeof marks)[0], i: number) => m.report.find((r) => r.op === `XD${i}`)?.calls ?? 0;
for (const p of ph) {
  const t = p.from.name === 'begin' ? 'boot' : p.from.name.slice(0, 20);
  const v = N.map((_, i) => g(p.to, i) - g(p.from, i));
  const o = Object.fromEntries(N.map((n, i) => [n, v[i]]));
  const scan = (o.scanNs - o.clockNs) / 1e6;
  console.log(`${t.padEnd(20)} ${(p.to.ms - p.from.ms).toFixed(0)} ms`, JSON.stringify(o), `scan≈${scan.toFixed(1)} ms (${(100 * scan / (p.to.ms - p.from.ms)).toFixed(2)}%), ${(1e3*(o.scanNs-o.clockNs)/Math.max(1,o.vaFlush)/1e3).toFixed(0)} ns/scan, missrate ${(100*o.miss/(o.hit+o.miss)).toFixed(1)}%`);
}
