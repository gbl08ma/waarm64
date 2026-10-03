// The JIT's plumbing on the wasm core in Node: the core emits a module, the
// host installs it into the core's table, the core calls it (core/src/jit).
// Needs the wasm build (scripts/ci.sh).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { coreImports } from '../web/vm.ts';

const WASM = new URL('../target/wasm32-unknown-unknown/release/webpc_core.wasm', import.meta.url);

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
// million steps after its first). H's region takes both calls and f, whose `ret` is predicted
// to return after the call at S2 (the side reached first); from S1's call it returns to
// 0x1008, which only X30 says: a predicted return taken without comparing X30 would count in
// x7 for both.
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
  assert.deepEqual([regions, blocks], [2n, 7n], 'two functions: H with both calls, f and what follows the second; what follows the first');
  assert.ok(jitSteps > 1_500_000n && dispatches < 20n, `${dispatches} dispatches for ${jitSteps} steps in JIT code`);
});
