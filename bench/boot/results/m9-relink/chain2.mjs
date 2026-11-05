// What a function entry costs as code grows: N wasm functions, each a short body (a few i64 ops and loads,
// like a guest block) and a cold tail of padding, chained in a random order by tail calls:
//   direct:   one module, `return_call` (a direct branch through the module's jump table)
//   indirect: one module, `return_call_indirect` through a table (our jump-cache and transfer-cache links)
//   import:   modules of F functions (contiguous path segments), the segment's last function tail-calls the
//             next module's first through an import (our chains to already-compiled successors)
// ns per entry, best of R runs over the whole chain.  node chain.mjs <kind> <N> [pad ops] [F] [R]
const [kind, N, PAD = 200, F = 1, R = 5] = [process.argv[2], +process.argv[3], +(process.argv[4] ?? 200), +(process.argv[5] ?? 1), +(process.argv[6] ?? 5)];
const leb = (n) => { const o = []; do { let b = n & 0x7f; n >>>= 7; if (n) b |= 0x80; o.push(b); } while (n); return o; };
const sleb = (n) => { n = BigInt(n); const o = []; for (;;) { let b = Number(n & 0x7fn); n >>= 7n; if ((n === 0n && !(b & 0x40)) || (n === -1n && b & 0x40)) { o.push(b); return o; } o.push(b | 0x80); } };
const str = (s) => [...leb(s.length), ...Buffer.from(s)];
const sec = (id, b) => [id, ...leb(b.length)].concat(b);
const vec = (xs) => leb(xs.length).concat(xs.flat());
// type 0: (i32 n, i64 x) -> i64
const TYPE = [0x60, 2, 0x7f, 0x7e, 1, 0x7e];
function body(i, call) {
  const c = [];
  // if n == 0: return x
  c.push(0x20, 0, 0x45, 0x04, 0x40, 0x20, 1, 0x0f, 0x0b);
  // x = (x * K + i) ^ load64((x >> 3) & 0xfff8); x += load64(((x >> 17) & 0xfff8))
  c.push(0x20, 1, 0x42, ...sleb(0x9e3779b97f4a7c15n - (1n << 64n)), 0x7e, 0x42, ...sleb(i), 0x7c);
  c.push(0x20, 1, 0x42, 3, 0x88, 0x42, ...sleb(0xfff8), 0x83, 0xa7, 0x29, 3, 0, 0x85, 0x21, 1);
  c.push(0x20, 1, 0x20, 1, 0x42, 17, 0x88, 0x42, ...sleb(0xfff8), 0x83, 0xa7, 0x29, 3, 0, 0x7c, 0x21, 1);
  // cold padding: if x == magic (never), PAD ops of arithmetic and a store
  if (PAD) {
    c.push(0x20, 1, 0x42, ...sleb(0x123456789abcdn + BigInt(i)), 0x51, 0x04, 0x40);
    for (let k = 0; k < PAD; k++) c.push(0x20, 1, 0x42, ...sleb(k * 7 + 1), [0x7c, 0x7e, 0x85][k % 3], 0x21, 1);
    c.push(0x41, 0, 0x20, 1, 0x37, 3, 0, 0x0b);
  }
  c.push(0x20, 0, 0x41, 1, 0x6b, 0x20, 1, ...call);
  const b = [1, 1, 0x7e, ...c, 0x0b]; // one i64 local (unused), then the code
  return [...leb(b.length), ...b];
}
// module: types, imports, functions, table?, memory import, exports, code
function module({ nfuncs, imports, calls, table, exportAll }) {
  let m = [0, 0x61, 0x73, 0x6d, 1, 0, 0, 0];
  m = m.concat(sec(1, vec([TYPE])));
  const imp = [[...str('e'), ...str('m'), 2, 0, ...leb(1)]];
  for (let k = 0; k < imports; k++) imp.push([...str('e'), ...str('f' + k), 0, 0]);
  if (table) imp.push([...str('e'), ...str('t'), 1, 0x70, 0, ...leb(table)]);
  m = m.concat(sec(2, vec(imp)));
  m = m.concat(sec(3, vec(Array.from({ length: nfuncs }, () => [0]))));
  const ex = exportAll ? Array.from({ length: nfuncs }, (_, k) => [...str('g' + k), 0, ...leb(imports + k)]) : [[...str('g0'), 0, ...leb(imports)]];
  m = m.concat(sec(7, vec(ex)));
  m = m.concat(sec(10, vec(Array.from({ length: nfuncs }, (_, k) => body(k, calls(k))))));
  return new WebAssembly.Module(new Uint8Array(m));
}
const memory = new WebAssembly.Memory({ initial: 1 });
const perm = Array.from({ length: N }, (_, i) => i);
for (let i = N - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [perm[i], perm[j]] = [perm[j], perm[i]]; }
let entry;
if (kind === 'typed') {
  // A table of (ref null $t) defined in the module (exported), return_call_indirect through it.
  const next = new Map(perm.map((f, k) => [f, perm[(k + 1) % N]]));
  let m = [0, 0x61, 0x73, 0x6d, 1, 0, 0, 0];
  m = m.concat(sec(1, vec([TYPE])));
  m = m.concat(sec(2, vec([[...str('e'), ...str('m'), 2, 0, ...leb(1)]])));
  m = m.concat(sec(3, vec(Array.from({ length: N }, () => [0]))));
  m = m.concat(sec(4, vec([[0x63, 0, 0, ...leb(N)]])));
  const ex = Array.from({ length: N }, (_, k) => [...str('g' + k), 0, ...leb(k)]); ex.push([...str('t'), 1, 0]);
  m = m.concat(sec(7, vec(ex)));
  m = m.concat(sec(10, vec(Array.from({ length: N }, (_, k) => body(k, [0x41, ...sleb(next.get(k)), 0x13, 0, 0])))));
  const inst = new WebAssembly.Instance(new WebAssembly.Module(new Uint8Array(m)), { e: { m: memory } });
  for (let k = 0; k < N; k++) inst.exports.t.set(k, inst.exports['g' + k]);
  entry = inst.exports['g' + perm[0]];
} else if (kind === 'direct' || kind === 'indirect') {
  // function perm[k] calls perm[k+1]; the last returns through n == 0 (n starts at N).
  const next = new Map(perm.map((f, k) => [f, perm[(k + 1) % N]]));
  const table = kind === 'indirect' ? new WebAssembly.Table({ initial: N, element: 'anyfunc' }) : undefined;
  const mod = module({ nfuncs: N, imports: 0, table: table ? N : 0, exportAll: true,
    calls: (k) => (table ? [0x41, ...sleb(next.get(k)), 0x13, 0, 0] : [0x12, ...leb(next.get(k))]) });
  const inst = new WebAssembly.Instance(mod, { e: { m: memory, ...(table ? { t: table } : {}) } });
  if (table) for (let k = 0; k < N; k++) table.set(k, inst.exports['g' + k]);
  entry = inst.exports['g' + perm[0]];
} else {
  // modules of F consecutive path positions; the last of each tail-calls the next module's first (import 0).
  let nextFn = null;
  const M = Math.ceil(N / F);
  // Compile in a random order (code-space placement follows compilation), instantiate from the path's end.
  const mods = new Array(M);
  const order = Array.from({ length: M }, (_, i) => i).sort(() => Math.random() - 0.5);
  for (const mi of order) {
    const n = Math.min(F, N - mi * F), imp = mi < M - 1 ? 1 : 0;
    mods[mi] = module({ nfuncs: n, imports: imp, table: 0, exportAll: false, calls: (k) => (k < n - 1 ? [0x12, ...leb(imp + k + 1)] : [0x12, ...leb(0)]) });
  }
  const keep = [];
  const SCATTER = +(process.env.SCATTER ?? 0);
  for (let mi = M - 1; mi >= 0; mi--) {
    if (SCATTER) keep.push(new Array(1 + Math.floor(Math.random() * SCATTER)).fill(mi));
    nextFn = new WebAssembly.Instance(mods[mi], { e: { m: memory, ...(nextFn ? { f0: nextFn } : {}) } }).exports.g0;
  }
  globalThis.keep = keep;
  entry = nextFn;
}
// Warm up (tier-up), then time whole chains.
const reps = Math.max(1, Math.round(4e6 / N));
for (let r = 0; r < 3; r++) for (let k = 0; k < reps; k++) entry(N, 1n);
let best = Infinity;
for (let r = 0; r < R; r++) {
  const t0 = performance.now();
  for (let k = 0; k < reps; k++) entry(N, BigInt(k));
  best = Math.min(best, ((performance.now() - t0) * 1e6) / (reps * N));
}
console.log(`${kind} N=${N} pad=${PAD} F=${F}: ${best.toFixed(2)} ns/entry`);
