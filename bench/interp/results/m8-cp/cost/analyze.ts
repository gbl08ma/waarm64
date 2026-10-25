// DIAG: per module of a dump (run.ts), its diag section (emit ns, regions, instructions, blocks), bytes, and the
// time V8 takes to make a Module of it under this process's flags; JSON lines to stdout.
import { readFileSync } from 'node:fs';
const buf = readFileSync(process.argv[2]);
const out: string[] = [];
let o = 0;
while (o < buf.length) {
  const len = buf.readUInt32LE(o);
  const bytes = buf.subarray(o + 4, o + 4 + len);
  o += 4 + len;
  // The diag section is the module's last 27 bytes.
  const d = bytes.subarray(len - 27);
  if (d[0] !== 0 || d[1] !== 25 || d.toString('latin1', 3, 7) !== 'diag') continue; // (not an emitted batch: the miss functions)
  const emit = Number(d.readBigUInt64LE(7)), regions = d.readUInt32LE(15), words = d.readUInt32LE(19), blocks = d.readUInt32LE(23);
  const copy = new Uint8Array(bytes); // unshared, distinct
  const t0 = performance.now();
  const m = new WebAssembly.Module(copy);
  const ms = performance.now() - t0;
  const fns = WebAssembly.Module.exports(m).length;
  out.push(JSON.stringify({ len: len - 27, emit, regions, words, blocks, fns, us: +(ms * 1000).toFixed(1) }));
}
console.log(out.join('\n'));
