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
  const v = e.jit_new(0, 1, 16, check) as number;
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
