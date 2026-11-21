// The JIT's plumbing on the wasm core in Node: the core emits a module, the
// host installs it into the core's table, the core calls it (core/src/jit).
// Needs the wasm build (scripts/ci.sh).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { coreImports } from '../web/core.ts';

const WASM = new URL('../target/wasm32-unknown-unknown/release/waarm64_core.wasm', import.meta.url);

type Exports = {
  vcpu_new(): number;
  jit_add_install(reg: number, imm: bigint, slot: number): number;
  jit_call(cpu: number, idx: number, k: number, n: number): number;
};

function core(bind: boolean) {
  const memory = new WebAssembly.Memory({ initial: 32, maximum: 65536, shared: true });
  const imports = coreImports(memory);
  const instance = new WebAssembly.Instance(new WebAssembly.Module(readFileSync(WASM)), imports);
  if (bind) imports.jit.bind(instance);
  return { ex: instance.exports as unknown as Exports, memory };
}

test('the core installs a generated block in its table and calls it', () => {
  const { ex, memory } = core(true);
  const cpu = ex.vcpu_new();
  const x = new BigUint64Array(memory.buffer, cpu, 32);
  x[5] = 100n;
  const a = ex.jit_add_install(5, 7n, 0);
  const b = ex.jit_add_install(5, -1n, 3); // a later slot, past the table's end
  assert.ok(a > 0 && b === a + 3, `${a} ${b}`);
  assert.equal(ex.jit_call(cpu, a, 1, 10), 10);
  assert.equal(x[5], 170n);
  assert.equal(ex.jit_call(cpu, b, 1, 200), 200);
  assert.equal(x[5], 0xffff_ffff_ffff_ffffn - 29n); // 170 - 200, wrapped
  // A slot can be reused.
  assert.equal(ex.jit_add_install(0, 2n, 0), a);
  ex.jit_call(cpu, a, 1, 1);
  assert.equal(x[0], 2n);
});

test('without a bound JIT host, installing fails', () => {
  assert.equal(core(false).ex.jit_add_install(0, 1n, 0), -1);
});

// Self-modifying code (M5 step 3's first JIT bug: blocks outlived the code
// they were compiled from). At 0x1000 `movz x0, #1; b 0x1010`; at 0x1010 the
// first pass rewrites 0x1000 to `movz x0, #2`, runs `ic ivau` on it and
// branches back; the second pass ends on `brk`. Compiled on first sight.
const SMC = [0xd2800020, 0x14000003, 0, 0, 0xb5000101, 0xd2800021, 0xb9000062, 0xd50b7523, 0x17fffff8, 0, 0, 0, 0xd4200000];

function smc(ic: boolean, check: number) {
  const { ex, memory } = core(true);
  const e = ex as unknown as Exports & Record<string, (...a: (number | bigint)[]) => number | bigint>;
  const base = memory.grow(1) * 65536;
  const words = [...SMC];
  if (!ic) words[7] = 0xd503201f; // nop instead of the ic
  new Uint32Array(memory.buffer, base + 0x1000, words.length).set(words);
  const v = e.jit_new(0, 1, 16, check, 0) as number;
  const x = new BigUint64Array(memory.buffer, v, 33);
  [x[2], x[3], x[32]] = [0xd2800040n, 0x1000n, 0x1000n]; // new word, its address, PC
  const exit = e.vcpu_new() as number;
  e.jit_run_exit(v, e.mem_new(base, 65536n), 100n, exit);
  return { x0: x[0], kind: new BigUint64Array(memory.buffer, exit, 1)[0] };
}

test('IC IVAU drops the JIT blocks of rewritten code', () => {
  assert.deepEqual(smc(true, 0), { x0: 2n, kind: 6n }); // brk
  // Without the ic the compiled block runs the old code (as a real core may).
  assert.deepEqual(smc(false, 0), { x0: 1n, kind: 6n });
});

test('the stale-code checker fails the run when code changes without an IC', () => {
  assert.throws(() => smc(false, 1), WebAssembly.RuntimeError);
});

// Chaining (M5 step 7): a block that tail-calls another must go when that one
// is invalidated. A at 0x1000 (`movz x0, #1; b 0x2000`); at 0x2000 a counter:
// the first pass goes back to A through L (`b 0x1000` at 0x2014, compiled
// after A, so it chains to A); the second rewrites A to `movz x0, #2`, runs
// `ic ivau` on it and goes back through L; the third ends on `brk`. L is in
// another page than A: only the link says it must go too.
function chained(ic: boolean) {
  const { ex, memory } = core(true);
  const e = ex as unknown as Exports & Record<string, (...a: (number | bigint)[]) => number | bigint>;
  const base = memory.grow(1) * 65536;
  new Uint32Array(memory.buffer, base + 0x1000, 2).set([0xd2800020, 0x140003ff]);
  new Uint32Array(memory.buffer, base + 0x2000, 13).set([
    0x910004a5, 0xf10008bf, 0x540000c0, // add x5, x5, #1; cmp x5, #2; b.eq 0x2020
    0xf1000cbf, 0x54000100, // cmp x5, #3; b.eq 0x2030
    0x17fffbfb, 0, 0, // L: b 0x1000
    0xb9000062, ic ? 0xd50b7523 : 0xd503201f, // str w2, [x3]; ic ivau, x3 (or nop)
    0x17fffffb, 0, // b 0x2014 (L)
    0xd4200000, // brk
  ]);
  const v = e.jit_new(0, 1, 64, 0, 0) as number;
  const x = new BigUint64Array(memory.buffer, v, 33);
  [x[2], x[3], x[32]] = [0xd2800040n, 0x1000n, 0x1000n];
  const exit = e.vcpu_new() as number;
  e.jit_run_exit(v, e.mem_new(base, 65536n), 100n, exit);
  const st = new BigUint64Array(memory.buffer, e.jit_stats(v) as number, 11);
  return { x0: x[0], kind: new BigUint64Array(memory.buffer, exit, 1)[0], steps: st[4], dispatches: st[5] };
}

test('IC IVAU drops the blocks chained to the rewritten code, in other pages too', () => {
  const r = chained(true);
  assert.deepEqual([r.x0, r.kind], [2n, 6n]);
  assert.ok(r.dispatches < r.steps, `${r.dispatches} dispatches for ${r.steps} steps: nothing chained`);
  assert.deepEqual([chained(false).x0], [1n]); // without the ic, the old code (as a real core may)
});

// Chaining keeps a call-and-return loop out of the dispatcher: `bl f` and the
// loop's conditional branch chain directly, `ret` through the jump cache (a
// lookup that once read the wrong entries and always missed: M5 step 7).
test('a call-and-return loop runs chained, without the dispatcher', () => {
  const { ex, memory } = core(true);
  const e = ex as unknown as Exports & Record<string, (...a: (number | bigint)[]) => number | bigint>;
  const base = memory.grow(1) * 65536;
  new Uint32Array(memory.buffer, base + 0x1000, 5).set([
    0x94000004, // loop: bl f (0x1010)
    0xf10004a5, // subs x5, x5, #1
    0x54ffffc1, // b.ne loop
    0xd4200000, // brk
    0xd65f03c0, // f: ret
  ]);
  const v = e.jit_new(0, 1, 64, 0, 0) as number;
  const x = new BigUint64Array(memory.buffer, v, 33);
  [x[5], x[32]] = [10_000n, 0x1000n];
  const exit = e.vcpu_new() as number;
  const done = e.jit_run_exit(v, e.mem_new(base, 65536n), 1_000_000n, exit) as bigint;
  const st = new BigUint64Array(memory.buffer, e.jit_stats(v) as number, 11);
  assert.equal(new BigUint64Array(memory.buffer, exit, 1)[0], 6n); // brk
  assert.equal(done, 40_000n); // bl, ret, subs, b.ne
  assert.ok(st[5] < 20n, `${st[5]} dispatches for ${done} steps`);
});

// A loop of two blocks tiers up (M5 step 8.3): its head is compiled alone
// first, counting its entries; the 50th compiles the loop region and points
// the head at it, so the rest of the loop runs as a wasm loop in one call.
test('a hot loop head compiled alone tiers up to its loop region', () => {
  const { ex, memory } = core(true);
  const e = ex as unknown as Exports & Record<string, (...a: (number | bigint)[]) => number | bigint>;
  const base = memory.grow(1) * 65536;
  new Uint32Array(memory.buffer, base + 0x1000, 7).set([
    0x91000421, // loop: add x1, x1, #1
    0x14000003, // b 0x1010
    0xd4200000, 0xd4200000, // brk
    0xf10004a5, // subs x5, x5, #1
    0x54ffff61, // b.ne loop
    0xd4200000, // brk
  ]);
  const v = e.jit_new(2, 1, 64, 0, 50) as number;
  const x = new BigUint64Array(memory.buffer, v, 33);
  [x[5], x[32]] = [10_000n, 0x1000n];
  const exit = e.vcpu_new() as number;
  const done = e.jit_run_exit(v, e.mem_new(base, 65536n), 1_000_000n, exit) as bigint;
  const st = new BigUint64Array(memory.buffer, e.jit_stats(v) as number, 19);
  assert.equal(new BigUint64Array(memory.buffer, exit, 1)[0], 6n); // brk
  assert.deepEqual([done, x[1], x[5]], [40_000n, 10_000n, 0n]);
  assert.equal(st[18], 1n, 'tier-ups');
  assert.equal(st[16] - st[0], 1n, 'one region of two blocks besides the heads compiled alone (the other head stops counting)');
  assert.ok(st[5] < 20n, `${st[5]} dispatches for ${done} steps`);
});

// Direct branches to another page with the MMU on (M8, bench/boot/REPORT.md "where the userspace
// benchmark's time goes"): a successor is where its VA maps, which is the block's PA plus the
// branch offset only if the two pages are physically contiguous. A loop at EL1 over two virtual
// pages, entering the second by falling through the page end and leaving it by a conditional
// branch back:
//   0x400ff8: add x3, x3, #1; add x4, x4, #1
//   0x401000: add x1, x1, #1; subs x5, x5, #1; b.ne 0x400ff8; brk
// The first page is at PA 0x1000 and the second at PA 0x5000. At PA 0x2000, where the second
// would be if it followed the first, is a decoy that counts in x2 instead of x1 (run once
// through its own mapping at 0x403000 first, so it's compiled when the loop's blocks link). Then
// the second page is remapped to the decoy (now the loop's pages are contiguous, and the direct
// link is the right one) and back, with a `tlbi vmalle1` in between. Last, the second page is
// rewritten to add 2 to x1, with an `ic ivau` on it: the blocks found by their VA (the transfer
// cache) go with it.
const PTE = 0xf03n; // a page: valid, AF, nG, inner shareable, EL1 read/write/execute
const BODY = (reg: number) => [0x91000400 | reg << 5 | reg, 0xf10004a5, 0x54ffff81, 0xd4200000]; // add reg; subs x5; b.ne .-16; brk
/** The two-page guest above on a JIT vCPU (`jit_new`'s arguments); each `run` is `turns` turns of the loop. */
function twoPages(jit: [number, number, number, number, number], turns: bigint) {
  const { ex, memory } = core(true);
  const e = ex as unknown as Exports & Record<string, (...a: (number | bigint)[]) => number | bigint>;
  const base = memory.grow(2) * 65536;
  const code = (pa: number, words: number[]) => new Uint32Array(memory.buffer, base + pa, words.length).set(words);
  code(0x1ff8, [0x91000463, 0x91000484]);
  code(0x5000, BODY(1));
  code(0x2000, BODY(2));
  code(0x6000, [0xd508871f, 0xd5033fdf, 0xd4200000]); // tlbi vmalle1; isb; brk
  code(0x6010, [0xd50b7520, 0xd5033fdf, 0xd4200000]); // ic ivau, x0; isb; brk
  // TTBR0's tables at PA 0x10000: 0x400000–0x403fff through one level 3 table.
  const table = (pa: number) => new BigUint64Array(memory.buffer, base + pa, 512);
  table(0x10000)[0] = 0x11003n;
  table(0x11000)[0] = 0x12003n;
  table(0x12000)[2] = 0x13003n;
  const l3 = table(0x13000);
  [l3[0], l3[1], l3[2], l3[3]] = [0x1000n | PTE, 0x5000n | PTE, 0x6000n | PTE, 0x2000n | PTE];

  const v = e.jit_new(...jit) as number;
  const x = new BigUint64Array(memory.buffer, v, 134);
  x[832 / 8] = 0x3c5n; // PSTATE: EL1h, DAIF masked
  x[888 / 8] |= 1n; // SCTLR_EL1.M
  x[904 / 8] = 16n | 1n << 23n | 2n << 32n; // TCR_EL1: T0SZ 16, EPD1, a 40-bit IPS
  x[912 / 8] = 0x10000n; // TTBR0_EL1
  const mem = e.mem_new(base, 2n * 65536n), exit = e.vcpu_new() as number;
  const stats = () => new BigUint64Array(memory.buffer, e.jit_stats(v) as number, 19);
  const at = (pc: bigint, x5: bigint) => {
    [x[32], x[5]] = [pc, x5];
    const before = stats()[5];
    const done = e.jit_run_exit(v, mem, 100_000_000n, exit) as bigint;
    assert.equal(new BigUint64Array(memory.buffer, exit, 1)[0], 6n); // brk
    return { done, x1: x[1], x2: x[2], x3: x[3], x4: x[4], dispatches: stats()[5] - before };
  };
  return {
    code, stats, x,
    /** Runs up to `n` steps from `pc`, or from where the vCPU stopped; returns how many retired. */
    go: (n: bigint, pc?: bigint) => {
      if (pc !== undefined) x[32] = pc;
      return e.jit_run_exit(v, mem, n, exit) as bigint;
    },
    /** The decoy once, through its own mapping. */
    decoy: () => at(0x403000n, 1n),
    run: () => at(0x400ff8n, turns),
    /** Maps the loop's second page to `pa` and flushes the TLB. */
    remap: (pa: bigint) => {
      l3[1] = pa | PTE;
      assert.equal(at(0x402000n, 0n).done, 2n);
    },
    /** `ic ivau` on the loop's second page. */
    ic: () => {
      x[0] = 0x401000n;
      assert.equal(at(0x402010n, 0n).done, 2n);
    },
  };
}

function crossPage(threshold: number, check: number) {
  const g = twoPages([threshold, 1, 64, check, 0], 1000n);
  const out = [g.decoy(), g.run()];
  g.remap(0x2000n);
  out.push(g.run());
  g.remap(0x5000n);
  out.push(g.run());
  g.code(0x5000, [0x91000821]); // add x1, x1, #2
  g.ic();
  out.push(g.run());
  return out;
}

test('with the MMU on, a direct branch to another page goes where its VA maps and stays chained', () => {
  const want = [
    { done: 3n, x1: 0n, x2: 1n, x3: 0n, x4: 0n },
    { done: 5000n, x1: 1000n, x2: 1n, x3: 1000n, x4: 1000n }, // the second page isn't the decoy
    { done: 5000n, x1: 1000n, x2: 1001n, x3: 2000n, x4: 2000n }, // remapped: it is
    { done: 5000n, x1: 2000n, x2: 1001n, x3: 3000n, x4: 3000n }, // and back
    { done: 5000n, x1: 4000n, x2: 1001n, x3: 4000n, x4: 4000n }, // the second page rewritten, with an `ic ivau`
  ];
  const strip = (r: ReturnType<typeof crossPage>) => r.map(({ dispatches: _, ...rest }) => rest);
  assert.deepEqual(strip(crossPage(0xffff_ffff, 0)), want, 'interpreted (nothing reaches the threshold)');
  for (const check of [0, 1]) {
    const r = crossPage(0, check);
    assert.deepEqual(strip(r), want, `JIT${check ? ', with the stale-code checker' : ''}`);
    for (const [i, p] of r.slice(1).entries()) assert.ok(p.dispatches < 20n, `run ${i + 1}: ${p.dispatches} dispatches for ${p.done} steps`);
  }
});

// The transfer cache (M8, docs/jit.md "Linking"): `blr x7` to f in the next page and f's `ret`
// find their targets by VA. After a `tlbi vmalle1` its entries are gone and the jump cache still
// has the blocks, so the miss function refills them; each run of 2 steps must then retire exactly
// 2 (`blr` and then f's 2 don't fit: the entry's length must say so), and end where the
// interpreter does.
//   0x400000: blr x7; subs x5, x5, #1; b.ne 0x400000; brk     0x401000 (f): add x1, x1, #1; ret
function shortRuns(threshold: number) {
  const g = twoPages([threshold, 1, 64, 0, 0], 0n);
  g.code(0x1000, [0xd63f00e0, 0xf10004a5, 0x54ffffc1, 0xd4200000]);
  g.code(0x5000, [0x91000421, 0xd65f03c0]);
  [g.x[5], g.x[7]] = [1000n, 0x401000n];
  const runs = [g.go(50n, 0x400000n)];
  const pc = g.x[32];
  runs.push(g.go(100n, 0x402000n)); // tlbi vmalle1; isb; brk
  runs.push(g.go(10n, pc));
  for (let i = 0; i < 20; i++) runs.push(g.go(2n));
  return { runs, x1: g.x[1], x5: g.x[5], pc: g.x[32] };
}

test('a transfer cache hit runs its target only if the steps left cover it', () => {
  const want = shortRuns(0xffff_ffff);
  assert.deepEqual(want.runs, [50n, 2n, 10n, ...Array(20).fill(2n)], 'interpreted');
  assert.deepEqual(shortRuns(0), want);
});

// A tagged PC (docs/jit.md "Linking"): with TBI0 a branch drops its target's top byte
// (`AArch64.BranchAddr`), which compiled BR/BLR/RET leave to the dispatcher: a tagged VA never fills
// the instruction TLB or the transfer cache, so it always misses them. `blr x7` to f through a
// tagged pointer, and f returns through a tagged X30; ADR shows the PC.
//   0x400000: blr x7; adr x3, .; subs x5, x5, #1; b.ne 0x400000; brk
//   0x401000 (f): adr x2, .; add x1, x1, #1; orr x30, x30, x6; ret
function taggedBranches(threshold: number) {
  const g = twoPages([threshold, 1, 64, 0, 0], 0n);
  g.code(0x1000, [0xd63f00e0, 0x10000003, 0xf10004a5, 0x54ffffa1, 0xd4200000]);
  g.code(0x5000, [0x10000002, 0x91000421, 0xaa0603de, 0xd65f03c0]);
  const tag = 0x5an << 56n;
  g.x[904 / 8] |= 1n << 37n; // TCR_EL1.TBI0
  [g.x[5], g.x[6], g.x[7]] = [1000n, tag, tag | 0x401000n];
  const done = g.go(100_000n, 0x400000n);
  return { done, x1: g.x[1], x2: g.x[2], x3: g.x[3], x30: g.x[30], pc: g.x[32] };
}

test('a branch through a tagged pointer drops the tag from the PC, compiled too', () => {
  const want = { done: 8000n, x1: 1000n, x2: 0x401000n, x3: 0x400004n, x30: 0x5an << 56n | 0x400004n, pc: 0x400010n };
  assert.deepEqual(taggedBranches(0xffff_ffff), want, 'interpreted');
  assert.deepEqual(taggedBranches(0), want, 'JIT');
});

// A forward region across pages (M8): with a threshold of 2 and a batch of 16, the loop's two
// blocks are pending together and compiled as one function, a loop, whose edge into the second
// page checks that the page is still mapped there. Remapped to the decoy, the edge isn't taken
// (the decoy runs, found by its VA); mapped back, it is again. And the region goes with either of
// its pages: the second page's `add x1, x1, #1` is rewritten to add 2, with an `ic ivau` on it.
function crossPageRegion(threshold: number) {
  const g = twoPages([threshold, 16, 64, 0, 1000], 400_000n);
  const out = [g.decoy(), g.run()];
  const [regions, blocks] = [g.stats()[0], g.stats()[16]];
  g.remap(0x2000n);
  out.push(g.run());
  g.remap(0x5000n);
  out.push(g.run());
  g.code(0x5000, [0x91000821]); // add x1, x1, #2
  g.ic();
  out.push(g.run());
  return { out, regions, blocks };
}

test('a forward region spans pages behind a check of the mapping, and goes with either page', () => {
  const n = 400_000n;
  const want = [
    { done: 3n, x1: 0n, x2: 1n, x3: 0n, x4: 0n },
    { done: 5n * n, x1: n, x2: 1n, x3: n, x4: n },
    { done: 5n * n, x1: n, x2: 1n + n, x3: 2n * n, x4: 2n * n }, // remapped to the decoy
    { done: 5n * n, x1: 2n * n, x2: 1n + n, x3: 3n * n, x4: 3n * n }, // and back
    { done: 5n * n, x1: 4n * n, x2: 1n + n, x3: 4n * n, x4: 4n * n }, // the rewritten page
  ];
  const strip = (r: ReturnType<typeof crossPageRegion>) => r.out.map(({ dispatches: _, ...rest }) => rest);
  assert.deepEqual(strip(crossPageRegion(0xffff_ffff)), want, 'interpreted');
  const r = crossPageRegion(2);
  assert.deepEqual(strip(r), want, 'JIT');
  assert.deepEqual([r.regions, r.blocks], [1n, 2n], 'one function for the loop\'s two blocks');
  for (const i of [1, 3]) assert.ok(r.out[i].dispatches < 20n, `run ${i}: ${r.out[i].dispatches} dispatches for ${r.out[i].done} steps`);
});

// Forward regions (M8, docs/jit.md "Compile policy"): the blocks of a batch that static edges
// join are compiled as one function, each block once; calls are followed, and a return is
// predicted to the block after the call that led to it. Two calls of one function, one a turn
// (bit 0 of the counter picks which):
//   0x1000 H:  tbz x5, #0, S2
//   0x1004 S1: bl f
//   0x1008     add x6, x6, #1; b T
//   0x1010 S2: bl f
//   0x1014     add x7, x7, #1 (and on into T's words)
//   0x1018 T:  subs x5, x5, #1; b.ne H; brk
//   0x1040 f:  add x3, x3, #1; ret
// With a threshold of 2 and a batch of 16 every block is pending when the batch is emitted (a
// million steps after its first). H's region takes f through the call at S2 (the side reached
// first), and f's `ret` is predicted to return after it; the call at S1 is a host call (a
// second call to a callee taken: PERF loop 37), to f compiled as a head of its own, returning
// to 0x1008. A predicted return taken without comparing X30 would count in x7 for both.
function forwardRegion(threshold: number) {
  const { ex, memory } = core(true);
  const e = ex as unknown as Exports & Record<string, (...a: (number | bigint)[]) => number | bigint>;
  const base = memory.grow(1) * 65536;
  new Uint32Array(memory.buffer, base + 0x1000, 9).set([0x36000085, 0x9400000f, 0x910004c6, 0x14000003, 0x9400000c, 0x910004e7, 0xf10004a5, 0x54ffff21, 0xd4200000]);
  new Uint32Array(memory.buffer, base + 0x1040, 2).set([0x91000463, 0xd65f03c0]);
  const v = e.jit_new(threshold, 16, 64, 0, 1000) as number;
  const x = new BigUint64Array(memory.buffer, v, 33);
  [x[5], x[32]] = [400_000n, 0x1000n];
  const exit = e.vcpu_new() as number;
  const done = e.jit_run_exit(v, e.mem_new(base, 65536n), 100_000_000n, exit) as bigint;
  assert.equal(new BigUint64Array(memory.buffer, exit, 1)[0], 6n); // brk
  const st = new BigUint64Array(memory.buffer, e.jit_stats(v) as number, 19);
  return { done, x3: x[3], x6: x[6], x7: x[7], regions: st[0], blocks: st[16], dispatches: st[5], jitSteps: st[4] };
}

test('the blocks of a batch that static edges join are one forward region, calls and predicted returns included', () => {
  const want = { done: 3_000_000n, x3: 400_000n, x6: 200_000n, x7: 200_000n }; // 8 or 7 steps a turn
  const { regions: _r, blocks: _b, dispatches: _d, jitSteps: _j, ...interpreted } = forwardRegion(0xffff_ffff);
  assert.deepEqual(interpreted, want);
  const { regions, blocks, dispatches, jitSteps, ...jit } = forwardRegion(2);
  assert.deepEqual(jit, want);
  assert.deepEqual([regions, blocks], [3n, 10n], 'three functions: H with both calls, f and what follows the second; f; what follows the first');
  // Until f's own batch is emitted (a million steps after f first ran alone) the call at S1
  // reaches it through the dispatcher: ~8,300 dispatches, then none.
  assert.ok(jitSteps > 1_500_000n && dispatches < 10_000n, `${dispatches} dispatches for ${jitSteps} steps in JIT code`);
});

// Guest calls as host calls (docs/jit.md "Calls"): a BL is a wasm `call` of its callee, and the
// callee's `ret` a wasm `return` to the block after the call. A loop calls f (a leaf), g (which
// recurses 100 deep, past the host calls' depth limit, keeping X30 on the stack) and h (which
// returns elsewhere, to M, as a longjmp would: the caller finds the PC isn't its continuation):
//   0x1000 H: bl f; add x6, x6, #1; mov x0, #100; bl g; bl h; add x7, x7, #1 (skipped)
//   0x1018 M: subs x5, x5, #1; b.ne H; brk
//   0x1024 f: add x3, x3, #1; ret
//   0x102c g: stp x29, x30, [sp, #-16]!; subs x0, x0, #1; b.eq 1f; bl g
//          1: add x4, x4, #1; ldp x29, x30, [sp], #16; ret
//   0x1048 h: adr x9, M; ret x9
// Each block compiled alone (a batch of 1) makes every call a host call; batches of 16 put the
// blocks after the calls in their callers' regions.
const CALLS = [0x94000009, 0x910004c6, 0xd2800c80, 0x94000008, 0x9400000e, 0x910004e7, 0xf10004a5, 0x54ffff21, 0xd4200000, 0x91000463, 0xd65f03c0, 0xa9bf7bfd, 0xf1000400, 0x54000040, 0x97fffffd, 0x91000484, 0xa8c17bfd, 0xd65f03c0, 0x10fffe89, 0xd65f0120];

function calls(threshold: number, batch: number, check: number) {
  const { ex, memory } = core(true);
  const e = ex as unknown as Exports & Record<string, (...a: (number | bigint)[]) => number | bigint>;
  const base = memory.grow(1) * 65536;
  new Uint32Array(memory.buffer, base + 0x1000, CALLS.length).set(CALLS);
  const v = e.jit_new(threshold, batch, 4096, check, 1000) as number;
  const x = new BigUint64Array(memory.buffer, v, 33);
  [x[5], x[31], x[32]] = [300n, 0xf000n, 0x1000n];
  const exit = e.vcpu_new() as number;
  const done = e.jit_run_exit(v, e.mem_new(base, 65536n), 100_000_000n, exit) as bigint;
  assert.equal(new BigUint64Array(memory.buffer, exit, 1)[0], 6n); // brk
  const st = new BigUint64Array(memory.buffer, e.jit_stats(v) as number, 19);
  return { done, x3: x[3], x4: x[4], x6: x[6], x7: x[7], sp: x[31], dispatches: st[5], jitSteps: st[4] };
}

// The stale-code checker with host calls (docs/jit.md "Calls"), the MMU on so that a callee in another page is
// called, not taken: H at 0x402100 calls f in the next page down; the block after the call (m) and its successor (k)
// are H's members, m an entry.
//   0x402100 H: bl f    0x402104 m: add x1, x1, #1; b k    (0x40210c: brk)    0x402110 k: add x2, x2, #1; brk
//   0x401100 f: str w9, [x10]; ret
// An entry at m runs k too, so its check covers k: k rewritten without an IC (from outside), a run that starts
// at m must fail. A callee that rewrites m without an IC and returns: the caller's continuation is checked too.
const STALE_H = [0x97fffc00, 0x91000421, 0x14000002, 0xd4200000, 0x91000442, 0xd4200000];
function staleCalls() {
  const g = twoPages([0, 1, 64, 1, 0], 0n);
  g.code(0x6100, STALE_H);
  g.code(0x5100, [0xb9000149, 0xd65f03c0]); // str w9, [x10]; ret
  [g.x[9], g.x[10]] = [0x91000421n, 0x402104n]; // m's own word: no change
  assert.equal(g.go(100n, 0x402100n), 6n); // bl, str, ret, add, b, add
  assert.deepEqual([g.x[1], g.x[2]], [1n, 1n]);
  return g;
}

test('with host calls, an entry at a member checks the members it runs', () => {
  const g = staleCalls();
  g.code(0x6110, [0x91000842]); // k: add x2, x2, #2, without an IC
  assert.throws(() => g.go(100n, 0x402104n), WebAssembly.RuntimeError);
});

test("with host calls, a callee's return into its caller is checked", () => {
  const g = staleCalls();
  g.x[9] = 0x91000821n; // f rewrites m to add x1, x1, #2, without an IC
  assert.throws(() => g.go(100n, 0x402100n), WebAssembly.RuntimeError);
});

test('guest calls are host calls: leaf, deep recursion and a return elsewhere', () => {
  const { dispatches: _d, jitSteps: _j, ...want } = calls(0xffff_ffff, 1, 0);
  assert.deepEqual([want.x3, want.x4, want.x6, want.x7, want.sp], [300n, 30_000n, 300n, 0n, 0xf000n]);
  for (const [threshold, batch, check] of [[2, 1, 0], [2, 16, 0], [0, 1, 1]]) {
    const { dispatches, jitSteps, ...jit } = calls(threshold, batch, check);
    assert.deepEqual(jit, want, `threshold ${threshold}, batch ${batch}, check ${check}`);
    assert.ok(jitSteps > want.done / 2n, `${dispatches} dispatches for ${jitSteps} steps in JIT code`);
  }
});

// A `ret` predicted to its call's continuation in another page (the edge checks the page's mapping on the way, in
// ADDR) and not taken there: at depth 0 its transfer probes the target the `ret` left in ADDR, which must be X30's, not
// the continuation's VA that the mapping check put there. H's BL is its page's last word, so C starts the next page:
//   0x401e00 P: add x7, x7, #1; b Q    0x401e40 Q: add x7, x7, #1; b R    0x401e80 R: br x8
//   0x401f00 f: mov x30, x9; ret
//   0x401ff8 H: add x1, x1, #1; bl f   0x402000 C: add x2, x2, #1; subs x5, x5, #1; b.ne H; brk
//   0x402100 T: add x4, x4, #1; brk
// With X9 = C, H's loop region takes f and C, f's `ret` predicted to C. P, Q and R then branch to C, compiled as a head of its own (a batch of 4 with them),
// which puts C in the transfer cache. f then sends its `ret` to T: probing C's VA ran C's code at T. (Linux on 4 vCPUs
// in parallel: a new task's first `ret` out of `cpu_switch_to`, predicted back into `__switch_to`, ran
// `__switch_to`'s epilogue at `ret_from_fork` once its continuation was an entry with a function.)
test("a predicted return that misses transfers to X30's target, not the continuation its page check read", () => {
  const g = twoPages([2, 4, 64, 0, 1000], 0n);
  g.code(0x5e00, [0x910004e7, 0x1400000f]); // add x7; b Q
  g.code(0x5e40, [0x910004e7, 0x1400000f]); // add x7; b R
  g.code(0x5e80, [0xd61f0100]); // br x8
  g.code(0x5f00, [0xaa0903fe, 0xd65f03c0]);
  g.code(0x5ff8, [0x91000421, 0x97ffffc1]);
  g.code(0x6000, [0x91000442, 0xf10004a5, 0x54ffff81, 0xd4200000]);
  g.code(0x6100, [0x91000484, 0xd4200000]);
  const x = g.x;
  [x[5], x[9]] = [100_000n, 0x402000n];
  g.go(10_000_000n, 0x401ff8n); // H's region compiled and run
  assert.deepEqual([x[1], x[2], x[5]], [100_000n, 100_000n, 0n]);
  const before = g.stats()[0];
  for (let k = 0; k < 20; k++) {
    [x[5], x[8]] = [1n, 0x402000n];
    g.go(100n, 0x401e00n);
  }
  assert.ok(g.stats()[0] > before, 'P, Q, R and C compiled');
  // In one run (each starts the transfer cache over): R's branch puts C there, C loops to H, f returns to T.
  [x[1], x[2], x[4], x[5], x[8], x[9]] = [0n, 0n, 0n, 2n, 0x402000n, 0x402100n];
  g.go(100n, 0x401e00n);
  assert.deepEqual({ x1: x[1], x2: x[2], x4: x[4], pc: x[32] }, { x1: 1n, x2: 1n, x4: 1n, pc: 0x402104n });
});
