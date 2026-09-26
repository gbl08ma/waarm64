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
