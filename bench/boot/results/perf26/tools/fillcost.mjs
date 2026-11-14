// fillcost.mjs: ns a call of a Liftoff function (i32)->i32 with n locals of a type, called 10^7 times from a wasm
// loop (the caller in Liftoff too): the zero-fill's cost a call against n = 12. Run with --liftoff-only.
const sec = (id, body) => [id, ...leb(body.length), ...body];
function leb(n) { const o = []; do { let b = n & 0x7f; n >>>= 7; if (n) b |= 0x80; o.push(b); } while (n); return o; }
const mod = (n, ty) => {
  const types = sec(1, [1, 0x60, 1, 0x7f, 1, 0x7f]);
  const funcs = sec(3, [2, 0, 0]);
  const exp = sec(7, [1, 1, 0x67, 0, 1]);
  // f: n locals, returns its param plus local 1 (read once, so each is live; Liftoff fills them all anyway)
  const f = [1, n, ty, 0x20, 0, 0x0b];
  // g(k): loop k times calling f
  const g = [1, 1, 0x7f, 0x03, 0x40, 0x20, 1, 0x10, 0, 0x21, 1, 0x20, 0, 0x41, 1, 0x6b, 0x22, 0, 0x0d, 0, 0x0b, 0x20, 1, 0x0b];
  const code = sec(10, [2, ...leb(f.length), ...f, ...leb(g.length), ...g]);
  return new Uint8Array([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0, ...types, ...funcs, ...exp, ...code]);
};
const base = {};
for (const [ty, name] of [[0x7e, 'i64'], [0x7c, 'f64'], [0x7b, 'v128']]) for (const n of [1, 12, 13, 16, 20, 24, 32]) {
  const { g } = new WebAssembly.Instance(new WebAssembly.Module(mod(n, ty))).exports;
  g(1e5);
  const r = [];
  for (let i = 0; i < 7; i++) { const t = performance.now(); g(1e7); r.push((performance.now() - t) * 1e6 / 1e7); }
  r.sort((a, b) => a - b);
  console.log(`${name} n=${n}: ${r[3].toFixed(2)} ns a call (min ${r[0].toFixed(2)})`);
}
