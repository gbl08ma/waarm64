// PERF loop 34: rewrites a dumped set's polls in place (same length), so arms compare on the same functions.
//   node rewrite.mjs <in> <out> <form>   form: plain (i32.load), zero (0 <u word), plainzero, none (i32.const 1),
//   atomic (the mixed core's `nop; i32.load` polls back to i32.atomic.load)
// The poll as emitted (emit::poll): local.get 1 (acc); local.get 0; i32.atomic.load align=2 offset=STOP; i32.lt_u.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';

const [inDir, outDir, form] = process.argv.slice(2);
mkdirSync(outDir, { recursive: true });
let polls = 0, files = 0;
for (const f of readdirSync(inDir).filter((f) => /^m\d+\.wasm$/.test(f))) {
  const b = new Uint8Array(readFileSync(`${inDir}/${f}`));
  // The code section (id 10).
  let p = 8, cs = -1, ce = -1;
  const leb = (q) => { let v = 0, s = 0, n = 0; for (;;) { const x = b[q + n++]; v |= (x & 0x7f) << s; s += 7; if (!(x & 0x80)) return [v >>> 0, n]; } };
  while (p < b.length) {
    const id = b[p];
    const [sz, n] = leb(p + 1);
    if (id === 10) { cs = p + 1 + n; ce = cs + sz; }
    p += 1 + n + sz;
  }
  if (cs < 0) throw new Error(f);
  for (let i = cs; i < ce - 10; i++) {
    if (b[i] !== 0x20 || b[i + 1] !== 0x01 || b[i + 2] !== 0x20 || b[i + 3] !== 0x00 || !((b[i + 4] === 0xfe && b[i + 5] === 0x10) || (b[i + 4] === 0x01 && b[i + 5] === 0x28)) || b[i + 6] !== 0x02) continue;
    let j = i + 7;
    while (b[j] & 0x80) j++;
    j++; // past the offset's LEB
    if (b[j] !== 0x49) continue;
    polls++;
    if (form === 'plain' || form === 'plainzero') { b[i + 4] = 0x01; b[i + 5] = 0x28; }
    if (form === 'atomic') { b[i + 4] = 0xfe; b[i + 5] = 0x10; }
    if (form === 'zero' || form === 'plainzero') { b[i] = 0x41; b[i + 1] = 0x00; }
    if (form === 'none') { b[i] = 0x41; b[i + 1] = 0x01; for (let k = i + 2; k <= j; k++) b[k] = 0x01; }
    i = j;
  }
  if (!WebAssembly.validate(b)) throw new Error(`${f}: invalid after rewrite`);
  writeFileSync(`${outDir}/${f}`, b);
  files++;
}
console.log(`${files} modules, ${polls} polls rewritten (${form})`);
