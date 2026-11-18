// The golden corpus on the wasm core in Node (V8), the counterpart of the
// native comparator in core/tests/corpus.rs. Host float behavior is where the
// native and wasm builds could diverge. Needs the wasm build (scripts/ci.sh).
// It also runs through the JIT (M5): forced (every block compiled on first
// sight, one per module) and in stress (the same with a 4-block code cache,
// so it flushes constantly, and the stale-code checker); and through the
// dispatcher never compiling, so in the block interpreter (interp::block).
// `WAARM64_CORPUS=dp_imm,dp_reg` runs only those groups (tests/corpus/<group>.txt).
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fusedFma } from '../web/fma.ts';
import { coreImports } from '../web/vm.ts';
import { jitVariantSkip } from './jit-variants.ts';
import { CODE, DATA, DATA_SIZE, REGS, initialState, parseFile } from '../tools/corpus/corpus.ts';

// `WAARM64_CORE` (a path from the repo's root): another core, such as the polled test core (tests/jit-diff-suite.ts).
const WASM = new URL(`../${process.env.WAARM64_CORE ?? 'target/wasm32-unknown-unknown/release/waarm64_core.wasm'}`, import.meta.url);
const DIR = new URL('corpus/', import.meta.url);
const RAM = Number(DATA) + DATA_SIZE;
const BRK_END = 0xd4200000;
const GROUPS = process.env.WAARM64_CORPUS?.split(',');

type Exports = {
  vcpu_new(): number;
  mem_new(base: number, size: bigint): number;
  interp_run_exit(cpu: number, mem: number, n: bigint, exit: number): bigint;
  jit_new(threshold: number, batch: number, capacity: number, check: number, regionAfter: number): number;
  jit_fma(v: number, on: number): void;
  jit_run_exit(v: number, mem: number, n: bigint, exit: number): bigint;
  jit_flush(v: number): void;
  jit_stats(v: number): number;
};

/** jit_new's threshold, batch, code cache capacity, stale-code check and region_after; none: the interpreter. */
const MODES: Record<string, [number, number, number, number, number] | undefined> = {
  interpreter: undefined,
  'JIT (forced)': [0, 1, 16384, 0, 0],
  'JIT stress': [0, 1, 4, 1, 1],
  // Never compiles: the dispatcher runs every test in the block interpreter (interp::block).
  'block interpreter': [0xffff_ffff, 32, 16384, 0, 1000],
};

/** Byte offset of each REGS slot in cpu::Cpu (x0..x30, sp, then nzcv, fpcr, fpsr, v0..v31). */
function offset(name: string): number {
  if (name === 'sp') return 248;
  if (name === 'nzcv') return 264;
  if (name === 'fpcr') return 816;
  if (name === 'fpsr') return 824;
  if (name[0] === 'v') return 304 + 16 * Number(name.slice(1));
  return 8 * Number(name.slice(1));
}

for (const [mode, jit] of Object.entries(MODES)) test(`golden corpus on the wasm core: ${mode}`, { skip: mode === 'JIT stress' && jitVariantSkip }, () => {
  const memory = new WebAssembly.Memory({ initial: 32, maximum: 65536, shared: true });
  const mod = new WebAssembly.Module(readFileSync(WASM));
  const imports = coreImports(memory);
  const instance = new WebAssembly.Instance(mod, imports);
  imports.jit.bind(instance);
  const ex = instance.exports as unknown as Exports;
  const cpu = jit ? ex.jit_new(...jit) : ex.vcpu_new();
  if (jit) ex.jit_fma(cpu, fusedFma() ? 1 : 0);
  const exit = ex.vcpu_new(); // any 16 aligned bytes the core won't touch otherwise
  const base = memory.grow(Math.ceil(RAM / 65536)) * 65536;
  const mem = ex.mem_new(base, BigInt(RAM));
  const bytes = new Uint8Array(memory.buffer);
  const dv = new DataView(memory.buffer);
  const M64 = (1n << 64n) - 1n;
  const get = (name: string) =>
    name[0] === 'v'
      ? dv.getBigUint64(cpu + offset(name), true) | (dv.getBigUint64(cpu + offset(name) + 8, true) << 64n)
      : dv.getBigUint64(cpu + offset(name), true);
  const set = (name: string, v: bigint) => {
    dv.setBigUint64(cpu + offset(name), v & M64, true);
    if (name[0] === 'v') dv.setBigUint64(cpu + offset(name) + 8, v >> 64n, true);
  };

  let total = 0;
  let compilable = 0; // tests whose first instruction isn't UNDEFINED
  const failures: string[] = [];
  for (const file of readdirSync(DIR).filter((f) => f.endsWith('.txt') && (!GROUPS || GROUPS.includes(f.slice(0, -4)))).sort()) {
    for (const t of parseFile(readFileSync(new URL(file, DIR), 'utf8')).tests) {
      total++;
      if (!t.exit?.startsWith('sigill pc=+0 ')) compilable++;
      const init = initialState(t);
      const code = base + Number(CODE);
      bytes.fill(0, code, code + 4096);
      [...t.code, BRK_END].forEach((w, k) => dv.setUint32(code + 4 * k, w, true));
      bytes.set(init.mem, base + Number(DATA));
      REGS.forEach((r, i) => set(r, init.regs[i]));
      dv.setBigUint64(cpu + 256, CODE, true); // PC
      if (jit) {
        ex.jit_flush(cpu); // the code changed
        ex.jit_run_exit(cpu, mem, 1000n, exit);
      } else ex.interp_run_exit(cpu, mem, 1000n, exit);

      const [kind, val] = [dv.getBigUint64(exit, true), dv.getBigUint64(exit + 8, true)];
      const pc = dv.getBigUint64(cpu + 256, true);
      const off = pc - CODE;
      const end = off === BigInt(4 * t.code.length);
      const got =
        kind === 6n && end ? 'end'
        : kind === 6n ? `sigtrap pc=+${off} code=1`
        : kind === 1n ? `sigill pc=+${off} code=1`
        : kind === 4n ? `sigbus pc=+${off} code=1 addr=0x${val.toString(16)}`
        : kind === 3n ? `sigsegv pc=+${off} code=1 addr=0x${val.toString(16)}`
        : `exit kind ${kind} (${val}) pc=+${off}`;
      const errs: string[] = [];
      if (got !== t.exit) errs.push(`exit: got ${got}, want ${t.exit}`);
      REGS.forEach((r, i) => {
        const want = t.out?.get(r) ?? init.regs[i];
        const v = get(r);
        if (v !== want) errs.push(`${r}: got 0x${v.toString(16)}, want 0x${want.toString(16)}`);
      });
      const wantMem = init.mem.slice();
      for (const [a, b] of t.mem ?? []) wantMem.set(b, Number(a - DATA));
      const data = bytes.subarray(base + Number(DATA), base + Number(DATA) + DATA_SIZE);
      const k = data.findIndex((b, i) => b !== wantMem[i]);
      if (k >= 0) errs.push(`mem 0x${(DATA + BigInt(k)).toString(16)}: got ${data[k]}, want ${wantMem[k]}`);
      if (errs.length) failures.push(`${t.name}: ${errs.join('; ')}`);
    }
  }
  assert.ok(GROUPS ? total > 0 : total > 30_000, `only ${total} corpus tests`);
  if (jit && jit[0] === 0xffff_ffff) {
    // jit::Stats (20: steps in the block interpreter): every test ran there.
    const decSteps = Number(new BigUint64Array(memory.buffer, ex.jit_stats(cpu), 23)[20]);
    console.log(`${mode}: ${decSteps} steps in the block interpreter`);
    assert.ok(decSteps >= compilable, `only ${decSteps} steps in the block interpreter for ${compilable} tests`);
  } else if (jit) {
    // jit::Stats: blocks, modules, bytes, compile ns, steps in JIT code, dispatches, invalidations, flushes,
    // instructions compiled inline and as helper calls, inline instructions run, (16) blocks in the regions.
    const st = [...new BigUint64Array(memory.buffer, ex.jit_stats(cpu), 17)].map(Number);
    const [regions, modules, bytes, ns, steps, dispatches, , , inl, helpers, inlSteps] = st;
    const blocks = st[16];
    console.log(`${mode}: ${blocks} blocks in ${regions} regions in ${modules} modules, ${(bytes / 1e6).toFixed(1)} MB, ${(ns / 1e6).toFixed(0)} ms compiling; ${steps} steps in ${dispatches} block calls; ${inl} inline / ${helpers} helper instructions compiled, ${inlSteps} inline steps`);
    assert.ok(blocks >= compilable, `only ${blocks} blocks compiled for ${compilable} tests`);
  }
  assert.deepEqual(failures.slice(0, 20), [], `${failures.length} of ${total} failed`);
});
