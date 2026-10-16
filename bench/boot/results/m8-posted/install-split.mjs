// node inst.mjs <results.json>: every install's split (web/vm.ts diagnostic build), by functions.
import fs from 'node:fs';
const s = JSON.parse(fs.readFileSync(process.argv[2])).slow;
const r = s.map(l => Object.fromEntries([...l.matchAll(/(\w+) ([\d.]+)/g)].map(m => [m[1], +m[2]]))).filter(x => x.inst !== undefined);
const sum = k => r.reduce((a, x) => a + x[k], 0);
console.log(`installs ${r.length}; total ms ${sum('install').toFixed(0)}: c (Module) ${sum('c').toFixed(0)}, imports ${sum('imports').toFixed(0)}, inst ${sum('inst').toFixed(0)}, set ${sum('set').toFixed(0)}; functions ${sum('functions')}, bytes ${(sum('bytes')/1e6).toFixed(0)} MB, t imports ${sum('timports')}`);
const med = (a) => { a = [...a].sort((x, y) => x - y); return a[a.length >> 1] ?? 0; };
for (const [lo, hi] of [[1, 1], [2, 3], [4, 7], [8, 15], [16, 31], [32, 63], [64, 127], [128, 255], [256, 1e9]]) {
  const b = r.filter(x => x.functions >= lo && x.functions <= hi);
  if (!b.length) continue;
  const f = k => (b.reduce((a, x) => a + x[k], 0) / b.length).toFixed(3);
  console.log(`${String(lo).padStart(3)}-${hi > 1e8 ? 'up ' : String(hi).padEnd(3)} n ${String(b.length).padStart(6)}  mean install ${f('install')} ms (median ${med(b.map(x => x.install)).toFixed(3)}): Module ${f('c')} imports ${f('imports')} inst ${f('inst')} set ${f('set')}; KB ${(b.reduce((a, x) => a + x.bytes, 0) / b.length / 1e3).toFixed(1)}, t-imports ${f('timports')}`);
}
