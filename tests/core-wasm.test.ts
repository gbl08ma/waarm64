// Needs the wasm core built first (scripts/ci.sh does this).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const WASM = new URL('../target/wasm32-unknown-unknown/release/webpc_core.wasm', import.meta.url);

test('core instantiates on shared imported memory and uses atomics', () => {
  const mod = new WebAssembly.Module(readFileSync(WASM));
  const mem = new WebAssembly.Memory({ initial: 32, maximum: 65536, shared: true });
  assert.ok(mem.buffer instanceof SharedArrayBuffer);
  const ex = new WebAssembly.Instance(mod, { env: { memory: mem } }).exports as Record<string, (...a: number[]) => number | bigint>;
  assert.equal(ex.abi_version(), 2);
  // Scratch space past the core's own data and stack.
  const scratch = mem.grow(1) * 65536;
  const words = new BigUint64Array(mem.buffer, scratch, 3);
  words.set([1n, 2n, 3n]);
  assert.equal(ex.sum_u64(scratch, 3), 6n);
  const counter = scratch + 64;
  assert.equal(ex.atomic_inc(counter), 0);
  assert.equal(Atomics.load(new Uint32Array(mem.buffer), counter / 4), 1);
});

test('interpreter runs the integer benchmark guest through the vCPU exports', async () => {
  const { setup } = await import('../bench/interp/suite.ts');
  const g = await setup();
  assert.equal(g.run(3_000_000), 3_000_000, `stopped at pc 0x${g.pc().toString(16)}`);
  assert.ok(g.rounds() > 0n);
});
