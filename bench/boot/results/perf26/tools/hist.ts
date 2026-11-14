// hist.ts <dir>: functions by declared locals (all integer, else marked), and by types.
import { readFileSync, readdirSync } from 'node:fs';
const h = new Map<string, number>();
for (const f of readdirSync(process.argv[2])) {
  const b = readFileSync(`${process.argv[2]}/${f}`); let p = 8;
  const leb = () => { let r = 0, sh = 0, x; do { x = b[p++]; r |= (x & 0x7f) << sh; sh += 7; } while (x & 0x80); return r >>> 0; };
  while (p < b.length) {
    const id = b[p++], size = leb(), end = p + size;
    if (id === 10) { const n = leb(); for (let i = 0; i < n; i++) { const bs = leb(), bend = p + bs; const g = leb(); let c = 0, other = false; for (let k = 0; k < g; k++) { c += leb(); const t = b[p++]; if (t !== 0x7e && t !== 0x7f) other = true; } const key = `${String(c).padStart(3)}${other ? '+' : ' '}`; h.set(key, (h.get(key) ?? 0) + 1); p = bend; } }
    p = end;
  }
}
let tot = 0; for (const v of h.values()) tot += v; let cum = 0;
for (const k of [...h.keys()].sort()) { cum += h.get(k)!; console.log(`${k} ${h.get(k)} cum ${(100 * cum / tot).toFixed(1)}%`); }
