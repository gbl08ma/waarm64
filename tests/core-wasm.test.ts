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
  assert.equal(ex.abi_version(), 0);
  const words = new BigUint64Array(mem.buffer, 1 << 20, 3);
  words.set([1n, 2n, 3n]);
  assert.equal(ex.sum_u64(1 << 20, 3), 6n);
  const counter = (1 << 20) + 64;
  assert.equal(ex.atomic_inc(counter), 0);
  assert.equal(Atomics.load(new Uint32Array(mem.buffer), counter / 4), 1);
});
