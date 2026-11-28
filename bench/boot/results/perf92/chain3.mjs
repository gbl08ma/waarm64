// What a function entry costs as code grows: N wasm functions, each a short body (a few i64 ops and loads,
// like a guest block) and a cold tail of padding, chained in a random order by tail calls:
//   direct:   one module, `return_call` (a direct branch through the module's jump table)
//   indirect: one module, `return_call_indirect` through a table (our jump-cache and transfer-cache links)
//   import:   modules of F functions (contiguous path segments), the segment's last function tail-calls the
//             next module's first through an import (our chains to already-compiled successors)
//   jc:       one module, PERF loop 92: the jump cache's tail of a static successor compiled after its block
//             (jit::emit::via_jc with a key): the vCPU's JC pointer loaded, the entry's tag compared with the key,
//             its table index loaded, `return_call_indirect`; against `indirect`'s constant index (a reserved slot)
//   jcleft:   jc with counted code's `left >= len + its length` check (the entry's length at +12)
//   jcconst:  jc with the entry at a constant address (no JC pointer's load: a cache inside the vCPU's block)
// ns per entry, best of R runs over the whole chain.  node chain.mjs <kind> <N> [pad ops] [F] [R]
const [kind, N, PAD = 200, F = 1, R = 5] = [process.argv[2], +process.argv[3], +(process.argv[4] ?? 200), +(process.argv[5] ?? 1), +(process.argv[6] ?? 5)];
const leb = (n) => { const o = []; do { let b = n & 0x7f; n >>>= 7; if (n) b |= 0x80; o.push(b); } while (n); return o; };
const sleb = (n) => { n = BigInt(n); const o = []; for (;;) { let b = Number(n & 0x7fn); n >>= 7n; if ((n === 0n && !(b & 0x40)) || (n === -1n && b & 0x40)) { o.push(b); return o; } o.push(b | 0x80); } };
const str = (s) => [...leb(s.length), ...Buffer.from(s)];
const sec = (id, b) => [id, ...leb(b.length)].concat(b);
const vec = (xs) => leb(xs.length).concat(xs.flat());
// type 0: (i32 n, i64 x) -> i64
const TYPE = [0x60, 2, 0x7f, 0x7e, 1, 0x7e];
let IF_AT = 0;
const HINT = !!process.env.HINT;
// HINT=1: a metadata.code.branch_hint section marking each function's padding `if` unlikely (as the JIT's cold paths).
const hints = (first, n) => !HINT || !PAD ? [] : sec(0, [...str('metadata.code.branch_hint'), ...leb(n), ...Array.from({ length: n }, (_, k) => [...leb(first + k), 1, ...leb(IF_AT), 1, 0]).flat()]);
function body(i, call, raw = false) {
  const c = [];
  // if n == 0: return x
  c.push(0x20, 0, 0x45, 0x04, 0x40, 0x20, 1, 0x0f, 0x0b);
  // x = (x * K + i) ^ load64((x >> 3) & 0xfff8); x += load64(((x >> 17) & 0xfff8))
  c.push(0x20, 1, 0x42, ...sleb(0x9e3779b97f4a7c15n - (1n << 64n)), 0x7e, 0x42, ...sleb(i), 0x7c);
  c.push(0x20, 1, 0x42, 3, 0x88, 0x42, ...sleb(0xfff8), 0x83, 0xa7, 0x29, 3, 0, 0x85, 0x21, 1);
  c.push(0x20, 1, 0x20, 1, 0x42, 17, 0x88, 0x42, ...sleb(0xfff8), 0x83, 0xa7, 0x29, 3, 0, 0x7c, 0x21, 1);
  // cold padding: if x == magic (never), PAD ops of arithmetic and a store
  if (PAD) {
    c.push(0x20, 1, 0x42, ...sleb(0x123456789abcdn + BigInt(i)), 0x51);
    IF_AT = 3 + c.length; // the `if`'s offset in the body (its locals' 3 bytes first)
    c.push(0x04, 0x40);
    for (let k = 0; k < PAD; k++) c.push(0x20, 1, 0x42, ...sleb(k * 7 + 1), [0x7c, 0x7e, 0x85][k % 3], 0x21, 1);
    c.push(0x41, 0, 0x20, 1, 0x37, 3, 0, 0x0b);
  }
  if (raw) c.push(...call);
  else c.push(0x20, 0, 0x41, 1, 0x6b, 0x20, 1, ...call);
  const b = raw ? [2, 1, 0x7e, 1, 0x7f, ...c, 0x0b] : [1, 1, 0x7e, ...c, 0x0b]; // i64 local (unused), [i32 JCE], code
  return [...leb(b.length), ...b];
}
// module: types, imports, functions, table?, memory import, exports, code
async function module({ nfuncs, imports, calls, table, exportAll, raw = false }) {
  let m = [0, 0x61, 0x73, 0x6d, 1, 0, 0, 0];
  m = m.concat(sec(1, vec([TYPE])));
  const imp = [[...str('e'), ...str('m'), 2, 0, ...leb(1)]];
  for (let k = 0; k < imports; k++) imp.push([...str('e'), ...str('f' + k), 0, 0]);
  if (table) imp.push([...str('e'), ...str('t'), 1, 0x70, 0, ...leb(table)]);
  m = m.concat(sec(2, vec(imp)));
  m = m.concat(sec(3, vec(Array.from({ length: nfuncs }, () => [0]))));
  const ex = exportAll ? Array.from({ length: nfuncs }, (_, k) => [...str('g' + k), 0, ...leb(imports + k)]) : [[...str('g0'), 0, ...leb(imports)]];
  m = m.concat(sec(7, vec(ex)));
  const code = sec(10, vec(Array.from({ length: nfuncs }, (_, k) => body(k, calls(k), raw))));
  m = m.concat(hints(imports, nfuncs), code);
  return new WebAssembly.Module(new Uint8Array(m));
}
const JCP = 0x10000, JCB = 0x20000, JC = 131072; // the vCPU's JC pointer's word, the jump cache, its entries
const memory = new WebAssembly.Memory({ initial: 1 + 1 + (JC * 16) / 65536 + 1 });
// The same memory for every kind (one write to an untouched wasm memory moved `indirect` 5 -> 22 ns on the dev VM: the
// body's loads read pages never written, a placement effect): the JC pointer's word always, and random bytes
// in the 64 KiB the bodies read (as guest RAM is), unless ZERO=1.
new DataView(memory.buffer).setUint32(JCP, JCB, true);
if (!process.env.ZERO) crypto.getRandomValues(new Uint8Array(memory.buffer, 0, 65536));
const perm = Array.from({ length: N }, (_, i) => i);
for (let i = N - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [perm[i], perm[j]] = [perm[j], perm[i]]; }
let entry;
if (kind === 'ref') {
  // return_call_ref on a (ref $t) from table.get of a typed table defined in the module.
  const next = new Map(perm.map((f, k) => [f, perm[(k + 1) % N]]));
  let m = [0, 0x61, 0x73, 0x6d, 1, 0, 0, 0];
  m = m.concat(sec(1, vec([TYPE])));
  m = m.concat(sec(2, vec([[...str('e'), ...str('m'), 2, 0, ...leb(1)]])));
  m = m.concat(sec(3, vec(Array.from({ length: N }, () => [0]))));
  m = m.concat(sec(4, vec([[0x63, 0, 0, ...leb(N)]])));
  const ex = Array.from({ length: N }, (_, k) => [...str('g' + k), 0, ...leb(k)]); ex.push([...str('t'), 1, 0]);
  m = m.concat(sec(7, vec(ex)));
  // table.get 0 (idx); ref.as_non_null; return_call_ref 0
  m = m.concat(sec(10, vec(Array.from({ length: N }, (_, k) => body(k, [0x41, ...sleb(next.get(k)), 0x25, 0, 0xd4, 0x15, 0])))));
  const inst = new WebAssembly.Instance(new WebAssembly.Module(new Uint8Array(m)), { e: { m: memory } });
  for (let k = 0; k < N; k++) inst.exports.t.set(k, inst.exports['g' + k]);
  entry = inst.exports['g' + perm[0]];
} else if (kind === 'typed') {
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
} else if (kind === 'jc' || kind === 'jcleft' || kind === 'jcconst') {
  // function k's successor next(k) found in a jump-cache entry at a slot of its own (distinct random slots).
  const next = new Map(perm.map((f, k) => [f, perm[(k + 1) % N]]));
  const slots = Array.from({ length: JC }, (_, i) => i);
  for (let i = JC - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [slots[i], slots[j]] = [slots[j], slots[i]]; }
  const key = (f) => 0x40000000n + BigInt(f) * 4n;
  const dv = new DataView(memory.buffer);
  for (let f = 0; f < N; f++) {
    const e = JCB + slots[f] * 16;
    dv.setBigUint64(e, key(f), true);
    dv.setUint32(e + 8, f, true);
    dv.setUint32(e + 12, 64, true);
  }
  const table = new WebAssembly.Table({ initial: N, element: 'anyfunc' });
  const tail = (k) => {
    const t = next.get(k), e = slots[t] * 16;
    // i32.const JCP; i32.load JC_PTR; i32.const e; i32.add; local.tee 3; i64.load 0; i64.const key; i64.eq
    const c = kind === 'jcconst'
      ? [0x41, ...sleb(JCB + e), 0x22, 3, 0x29, 3, 0, 0x42, ...sleb(key(t)), 0x51]
      : [0x41, ...sleb(JCP), 0x28, 2, 0, 0x41, ...sleb(e), 0x6a, 0x22, 3, 0x29, 3, 0, 0x42, ...sleb(key(t)), 0x51];
    // jcleft: & (n + 64 >= len + 4 at +12: the step budget as `n`, never failing)
    if (kind === 'jcleft') c.push(0x20, 0, 0x41, 64, 0x6a, 0x20, 3, 0x28, 2, 12, 0x41, 4, 0x6a, 0x4f, 0x71);
    // if; n - 1, x, local 3 → i32.load 8 → return_call_indirect; end; x
    c.push(0x04, 0x40, 0x20, 0, 0x41, 1, 0x6b, 0x20, 1, 0x20, 3, 0x28, 2, 8, 0x13, 0, 0, 0x0b, 0x20, 1);
    return c;
  };
  const mod = await module({ nfuncs: N, imports: 0, table: N, exportAll: true, calls: tail, raw: true });
  const inst = new WebAssembly.Instance(mod, { e: { m: memory, t: table } });
  for (let k = 0; k < N; k++) table.set(k, inst.exports['g' + k]);
  entry = inst.exports['g' + perm[0]];
} else if (kind === 'direct' || kind === 'indirect') {
  // function perm[k] calls perm[k+1]; the last returns through n == 0 (n starts at N).
  const next = new Map(perm.map((f, k) => [f, perm[(k + 1) % N]]));
  const table = kind === 'indirect' ? new WebAssembly.Table({ initial: N, element: 'anyfunc' }) : undefined;
  const mod = await module({ nfuncs: N, imports: 0, table: table ? N : 0, exportAll: true,
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
    mods[mi] = await module({ nfuncs: n, imports: imp, table: 0, exportAll: false, calls: (k) => (k < n - 1 ? [0x12, ...leb(imp + k + 1)] : [0x12, ...leb(0)]) });
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
