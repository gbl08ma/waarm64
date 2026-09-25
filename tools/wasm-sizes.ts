// Lists the largest function bodies in a wasm module, named from its name section:
//   node tools/wasm-sizes.ts target/wasm32-unknown-unknown/release/webpc_core.wasm [count]
import { readFileSync } from 'node:fs';
const b = readFileSync(process.argv[2]);
let p = 8;
const leb = () => { let r = 0, s = 0, x; do { x = b[p++]; r += (x & 0x7f) * 2 ** s; s += 7; } while (x & 0x80); return r; };
let imports = 0; const sizes: number[] = []; const names = new Map<number, string>();
while (p < b.length) {
  const id = b[p++]; const len = leb(); const end = p + len;
  if (id === 2) { const n = leb(); for (let i = 0; i < n; i++) { p += leb(); p += leb(); const k = b[p++]; if (k === 0) { imports++; leb(); } else if (k === 1) { p++; const f = leb(); leb(); if (f & 1) leb(); } else if (k === 2) { const f = b[p++]; leb(); if (f & 1) leb(); } else { p += 2; } } }
  if (id === 10) { const n = leb(); for (let i = 0; i < n; i++) { const l = leb(); sizes.push(l); p += l; } }
  if (id === 0) { const nl = leb(); const nm = b.subarray(p, p + nl).toString(); p += nl; if (nm === 'name') { while (p < end) { const sid = b[p++]; const sl = leb(); const se = p + sl; if (sid === 1) { const n = leb(); for (let i = 0; i < n; i++) { const idx = leb(); const l = leb(); names.set(idx, b.subarray(p, p + l).toString()); p += l; } } p = se; } } }
  p = end;
}
const rows = sizes.map((s, i) => [s, names.get(i + imports) ?? `f${i + imports}`] as const).sort((a, b) => b[0] - a[0]);
for (const [s, n] of rows.slice(0, Number(process.argv[3] ?? 15))) console.log(String(s).padStart(8), n.slice(0, 110));
