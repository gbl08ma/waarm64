import { readFileSync } from 'node:fs';
const d = JSON.parse(readFileSync(process.argv[2]));
const S = d.samples;
const sum = (o) => Object.values(o).reduce((x, y) => x + y, 0);
for (const s of S.filter((x, i) => i % 2 == 0 || i == S.length - 1)) {
  const big = s.procs.reduce((a, b) => (sum(a.cls.names) > sum(b.cls.names) ? a : b));
  const n = big.cls.names;
  const g = (k) => Object.entries(n).filter(([a]) => a.includes(k)).reduce((x, [, v]) => x + v, 0) / 1024;
  const tot = sum(n) / 1024;
  const w = s.targets.filter((t) => t.jit);
  const mods = w.reduce((a, t) => a + t.jit.modules, 0), by = w.reduce((a, t) => a + t.jit.bytes, 0);
  const m = s.targets.find((t) => t.jit2)?.jit2;
  console.log(s.label, s.t.toFixed(0), 'RSS', tot.toFixed(0), 'PA', g('partition_alloc').toFixed(0), 'code', g('rwxp [anon:v8]').toFixed(0), 'sandbox', g('v8-sandbox').toFixed(0), 'v8heap', g('rw-p [anon:v8]').toFixed(0), '| mods', mods, 'wireMB', (by / 1e6).toFixed(0), 'blocks', m?.blocks, 'flush', m?.flushes, 'steps(G)', (m?.steps / 1e9).toFixed(1), 'compile_s', (m?.compileNs / 1e9).toFixed(1));
}
