// The calls a wasm module's functions make, for the functions whose name (from the name section) matches:
//   node tools/wasm-calls.ts target/wasm32-unknown-unknown/release/waarm64_core.wasm [regex]
// The default regex is the block interpreter's `hot` (interp::block::hot), which must make none: V8 spills every
// value live across a call at its definition, and that loop's state is live everywhere (docs/v8.md "Spills").
// Walks each body's instructions (the MVP, sign extension, bulk memory, atomics, SIMD and tail calls: what
// rustc emits), so an immediate is never mistaken for an opcode.
import { readFileSync } from 'node:fs';

export const HOT = /6interp5block3hot/;

/** The callees (by name) of each function whose name matches `re`, in order, one per call instruction. */
export function callsIn(b: Uint8Array, re: RegExp): Map<string, string[]> {
  let p = 8;
  const u = () => { let r = 0, s = 0, x; do { x = b[p++]; r += (x & 0x7f) * 2 ** s; s += 7; } while (x & 0x80); return r; };
  const skip = () => { while (b[p++] & 0x80); }; // any LEB
  const bodies: [number, number][] = [];
  const names = new Map<number, string>();
  let imports = 0;
  while (p < b.length) {
    const id = b[p++], len = u(), end = p + len;
    if (id === 2) {
      for (let n = u(), i = 0; i < n; i++) {
        { const l = u(); p += l; } { const l = u(); p += l; }
        const k = b[p++];
        if (k === 0) { imports++; u(); } else if (k === 1) { p++; const f = u(); u(); if (f & 1) u(); } else if (k === 2) { const f = b[p++]; u(); if (f & 1) u(); } else if (k === 3) p += 2; else u();
      }
    } else if (id === 10) {
      for (let n = u(), i = 0; i < n; i++) { const l = u(); bodies.push([p, p + l]); p += l; }
    } else if (id === 0) {
      const nl = u(), nm = new TextDecoder().decode(b.subarray(p, p + nl));
      p += nl;
      if (nm === 'name') {
        while (p < end) {
          const sid = b[p++], sl = u(), se = p + sl;
          if (sid === 1) for (let n = u(), i = 0; i < n; i++) { const idx = u(), l = u(); names.set(idx, new TextDecoder().decode(b.subarray(p, p + l))); p += l; }
          p = se;
        }
      }
    }
    p = end;
  }
  const out = new Map<string, string[]>();
  bodies.forEach(([start, end], i) => {
    const name = names.get(i + imports) ?? `f${i + imports}`;
    if (!re.test(name)) return;
    const calls: string[] = [];
    p = start;
    for (let n = u(), k = 0; k < n; k++) { u(); valtype(); }
    while (p < end) {
      const op = b[p++];
      if (op === 0x10 || op === 0x12) { const f = u(); calls.push(names.get(f) ?? `f${f}`); }
      else if (op === 0x11 || op === 0x13) { u(); u(); calls.push('(indirect)'); }
      else if (op >= 0x02 && op <= 0x04) { if (b[p] === 0x40 || b[p] >= 0x6f) p++; else skip(); }
      else if (op === 0x0c || op === 0x0d || (op >= 0x20 && op <= 0x26) || op === 0x3f || op === 0x40 || op === 0xd2 || op === 0x41 || op === 0x42) skip();
      else if (op === 0x0e) { for (let n = u(), k = 0; k <= n; k++) u(); }
      else if (op === 0x1c) { for (let n = u(), k = 0; k < n; k++) valtype(); }
      else if (op >= 0x28 && op <= 0x3e) memarg();
      else if (op === 0x43) p += 4;
      else if (op === 0x44) p += 8;
      else if (op === 0xd0) valtype();
      else if (op === 0xfc) {
        const s = u();
        if (s === 8 || s === 10 || s === 12 || s === 14) { u(); u(); } else if (s >= 9 && s <= 17) u();
      } else if (op === 0xfe) { if (u() === 3) p++; else memarg(); }
      else if (op === 0xfd) {
        const s = u();
        if (s <= 11 || s === 92 || s === 93) memarg();
        else if (s === 12 || s === 13) p += 16;
        else if (s >= 21 && s <= 34) p++;
        else if (s >= 84 && s <= 91) { memarg(); p++; }
      }
    }
    out.set(out.has(name) ? `${name} (${i + imports})` : name, calls);
  });
  return out;

  function memarg() { const a = u(); if (a & 0x40) u(); u(); }
  function valtype() { const t = b[p++]; if (t === 0x63 || t === 0x64) skip(); }
}

if (import.meta.main) {
  const [file, re] = process.argv.slice(2);
  for (const [name, calls] of callsIn(readFileSync(file), re ? new RegExp(re) : HOT)) {
    console.log(`${name}: ${calls.length} calls`);
    for (const c of calls) console.log(`  ${c}`);
  }
}
