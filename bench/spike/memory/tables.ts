// Markdown tables for REPORT.md from cost result JSONs:
//   node bench/spike/memory/tables.ts bench/spike/memory/results/chromium-linux-x86_64-cost-default.json
import { readFileSync } from 'node:fs';

type R = { name: string; params: Record<string, unknown>; median: number; iqr: number };
const file = process.argv[2];
const { results, browser, config } = JSON.parse(readFileSync(file, 'utf8')) as { results: R[]; browser: { version: string }; config: string };
console.log(`<!-- ${file}: Chromium ${browser.version}, config ${config} -->\n`);

const kernels = results.filter((r) => r.name === 'mem.kernel');
const group = (r: R) => `${r.params.pattern} ${Number(r.params.ws) / 2 ** 20} MiB ${r.params.mixed ? 'mixed' : 'bare'}`;
const variant = (r: R) => String(r.params.kernel).replace(/_(rand|chase|seq)_(mixed|bare)$/, '');
const groups = [...new Set(kernels.map(group))];
const variants = [...new Set(kernels.map(variant))];
const cell = (v: string, g: string) => kernels.find((r) => variant(r) === v && group(r) === g);
const pct = (x: number, base: number) => `${x >= base ? '+' : ''}${(((x - base) / base) * 100).toFixed(1)}%`;

console.log(`| layout | ${groups.join(' | ')} |\n|---|${groups.map(() => '---').join('|')}|`);
for (const v of variants) {
  const cells = groups.map((g) => {
    const r = cell(v, g), a = cell('A', g);
    return r && a ? (v === 'A' ? `${r.median.toFixed(2)} ns` : `${pct(r.median, a.median)}`) : '—';
  });
  console.log(`| ${v} | ${cells.join(' | ')} |`);
}

const rust = (name: string, len?: number) => results.filter((r) => r.name === name && (len === undefined || r.params.len === len));
for (const [name, len, unit] of [['rust.interp', undefined, 'ns/insn'], ['rust.dma', 4096, 'GB/s'], ['rust.dma', 65536, 'GB/s']] as const) {
  const rows = rust(name, len);
  if (!rows.length) continue;
  const a = rows.find((r) => r.params.layout === 'A')!;
  console.log(`\n${name}${len ? ` (${len} B chunks)` : ''}: ` + rows.map((r) => `${r.params.layout} (${r.params.build}) ${r.median.toFixed(2)} ${unit} ±${r.iqr.toFixed(2)}${r === a ? '' : ` [${pct(r.median, a.median)}]`}`).join(' · '));
}
