import { readFileSync, openSync, readSync } from 'node:fs';
const ex = (await WebAssembly.instantiate(readFileSync('target/safe/wasm32-unknown-unknown/release/codecs.wasm'), {})).instance.exports;
const fd = openSync(process.argv[2], 'r');
const cap = 3 << 20, src = ex.buf(cap), dst = ex.buf(cap), back = ex.buf(cap);
let pos = 0, n = 0, bad = 0;
const head = Buffer.alloc(5);
while (n < 800 && readSync(fd, head, 0, 5, pos) === 5) {
  const len = head.readUInt32LE(1);
  const raw = Buffer.alloc(len); readSync(fd, raw, 0, len, pos + 5); pos += 5 + len;
  new Uint8Array(ex.memory.buffer).set(raw, src);
  for (const [c, d] of [[0, 1], [1, 0]]) {
    const k = ex.comp(c, src, len, dst, cap);
    const m = ex.decomp(d, dst, k, back, len);
    const mem = new Uint8Array(ex.memory.buffer);
    if (m !== len || Buffer.compare(Buffer.from(mem.subarray(back, back + len)), raw) !== 0) bad++;
  }
  n++;
}
console.log({ frames: n, mismatches: bad });
